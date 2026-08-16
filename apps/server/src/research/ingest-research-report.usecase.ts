import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { researchOssConfig, type ResearchOssConfig } from '../config/index.js';
import {
  OBJECT_STORAGE_PORT,
  ObjectStorageIndeterminateError,
  buildPostObjectCredential,
  type ObjectStoragePort,
} from '../integrations/oss/oss.module.js';
import { PrismaService } from '../security/prisma.service.js';
import { ResearchIngestRejectedException } from './research-ingest-rejected.exception.js';
import {
  InvalidSymbolError,
  RESEARCH_KEY_LEAF,
  RESEARCH_KEY_PREFIX,
  RESEARCH_OSS_MAX_BYTES,
  RESEARCH_QUOTA_BYTES,
  contentHashOf,
  looksLikePdf,
  normalizeSymbol,
  parseReportDate,
  splitSymbol,
  titleFromFilename,
} from './research-report.rules.js';

/** 投递方身份。两类之一 —— 本片只实装 guest；account 由 PRD §3.8 后续 feature 接入。 */
export type Uploader =
  | { kind: 'guest'; guestName: string }
  | { kind: 'account'; accountId: string };

export interface IngestResearchReportInput {
  uploader: Uploader;
  /** 投递方给的标的写法，未归一。 */
  symbol: string;
  /** `YYYY-MM-DD`。取投递方声明值，系统不从 PDF 内容反推。 */
  reportDate: string;
  /** 缺省时由文件名兜底。 */
  title?: string;
  /** 缺省「自研」（FR-002）。 */
  source?: string;
  file: { bytes: Buffer; filename: string };
}

export interface IngestResearchReportResult {
  /** 归档标识，可反查那一行。BigInt → string（JSON 里没有 BigInt）。 */
  reportId: string;
  /** 归一后的 `market:code`。 */
  symbol: string;
  /** 归档对象位置，由内容指纹导出。 */
  objectKey: string;
  /** true = 这份之前就已经归档过，本次未新增任何东西。 */
  deduplicated: boolean;
  /**
   * **落库**的标题（FR-008）。不是把请求参数原样回吐 —— 投递方声明的元数据没有任何一层会
   * 校验，回显落库值是他唯一的自查手段（2026-08-16 实测：标题被编坏一个字节，无人发现）。
   */
  title: string;
  /** **落库**的研报日期，`YYYY-MM-DD`（FR-008）。与请求参数同形，不出 ISO datetime。 */
  reportDate: string;
  /** 该（投递方, 标的）版本线上的第几次投递（FR-009）。 */
  version: number;
  /**
   * 该标的**现在**在行情标的目录里叫什么（FR-012）。查不到、或查询本身失败 → `null`
   * （两者对外不可区分，FR-013 / FR-014）。**不落库**，每次实时读（FR-017）。
   *
   * ⚠️ 名称对上只证明「不是投成了另一家公司」，**不证明市场选对了** —— 两地上市的 A/H 在
   * 目录里同名。服务端不据此给任何「投对了」的判断（FR-029）。
   */
  instrumentName: string | null;
}

const STATUS_PENDING = 'PENDING';
const STATUS_COMMITTED = 'COMMITTED';

/**
 * 取号撞车后的重试上限（plan A2）。**耗尽直接抛**，落既有 `ProblemDetailFilter` 的 500 兜底
 * —— 刻意不新增对外错误码：端点被 2 次/分限频卡死、投递方是单个 CLI agent，同线三次连撞在
 * 物理上近乎不可能；而 057 的 503 已被 `RESEARCH_STORAGE_NOT_CONFIGURED` 占用，那条的正确
 * 动作是「停手」、新码的正确动作是「重投」，两条相反语义共用一个状态码本身就是坑。
 */
const VERSION_CLAIM_MAX_ATTEMPTS = 3;

/** P2002 结构化判定（`optionsdesk/create-anchor.usecase.ts:96` 同式；Prisma 7 兼容）。 */
const isP2002 = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';

/**
 * 投递一份研报（057 唯一的写入口）。
 *
 * ## 写序：DB 写 PENDING → OSS put → DB 翻 COMMITTED
 *
 * 为什么不是「先传对象再落库」：server 对该桶**无 DeleteObject 权限**（FR-018），孤儿对象
 * 清不掉 ⇒「查得到」是唯一的补救前提。先落 PENDING 行，任何一步失败都留下可扫出的证据。
 * 反过来先传对象的话，落库失败就会留下一个**不可见、不可清、持续吃配额**的孤儿。
 *
 * ## 幂等：唯一键 =（投递方, 标的, 内容指纹）
 *
 * 057 的键里**没有** `symbol`，于是「用正确标的重投同一份文件」这个最自然的补救动作只会拿回
 * 那条错的记录（`deduplicated: true`，一个字段都不更新）——而本通道既无读取面也无修改面，
 * 标的投错在 057 里**不可逆**。058 把 `symbol` 放进键（FR-019），补救路径由此成立（US3）。
 *
 * - 命中 **COMMITTED** → 直接返回既有行，**完全不碰 OSS**（state_branch 3）。
 * - 命中 **PENDING** → **就地续做**：重传对象、成功则原地翻 COMMITTED，不新增行、不报冲突
 *   （state_branch 4 / Clarifications Q2）。隧道上传超时后 agent 重试是常态，「拒绝并等人工」
 *   会把常态变成频繁人工活；而同字节写同位置是幂等重写，即便对象上次其实已传成也无害。
 * - 未命中 → 新建 PENDING 行。
 *
 * 这是一次**放宽**：同一投递方以**不同标的**投同一份文件 ⇒ 各自成为独立记录（state_branch 5）；
 * 同标的同字节重投的行为**逐字节不变**（FR-020，057 语义不得回退）。
 *
 * 归档**位置由指纹单独导出**，与投递方、标的均无关 ⇒ 同一字节无论被归到几个标的、几个投递方
 * 名下，都只占一份存储（FR-021）。
 *
 * ## 配额：该投递方名下全部记录字节之和
 *
 * 含 PENDING（重试不会因为没翻状态就免费）；与他人共享同一对象的记录**照常全额计入**
 * （口径蓄意高估，方向保守）；被拒的投递不计入（闸在建行之前）。续做既有行时**不重复
 * 计入自己**，否则一条正好卡在配额线上的 PENDING 行永远续不动。
 *
 * 058 未改这条口径：同一条版本线上的多个版本、以及同一份字节被归到多个标的下产生的多行，
 * **各自全额计入**，不因同线或共享同一归档对象而合并（FR-022 / state_branch 15）。
 *
 * ## 版本号：建 PENDING 行时取 `MAX + 1`，靠唯一键挡并发
 *
 * 身份是（投递方, 标的）——每条这样的线各自从 1 起、互不影响、互不可见（FR-001~FR-003）。
 * 取号发生在**建行时**（FR-023），不是投递完成时：
 *
 * - 过滤列必须是 `(uploaderKind, uploaderRef, symbol)` **三列齐全**。少 uploader 两列 = 版本线
 *   串到别的投递方头上（FR-011 泄露他人投过几份）；少 `symbol` = 同一投递方的不同标的共用一
 *   条线。
 * - **不过滤 `status`**：未完成行照常占号（FR-024）。过滤掉它们等于把一个被占的号重新发出
 *   去，下一步必然撞取号唯一键。⇒ 只看**成功**记录时序列可以不连续（1、3），这不是缺陷。
 * - 续做既有行时**不重新取号**，保留原号（FR-024 / state_branch 9）。
 *
 * 并发保护 = 取号唯一键 `uk_research_report_version_line` + catch `P2002` 有界重试。
 * **NEVER Serializable、NEVER `FOR UPDATE`**（004 实证偏索引 SSI 72/100 假冲突）——
 * READ COMMITTED + 唯一约束足够；也不涉及 `P2034`（那是 Serializable 场景专属）。
 *
 * 🚨 撞了 `P2002` 之后**必须分辨撞的是哪个键**：表上两个唯一键含义相反 —— 幂等键撞了是重复
 * 投递（该走幂等分支），取号键撞了是并发争用（该重试）。**判别方式 = 重查一次幂等键**：查到
 * 行 = 重复投递，查不到 = 取号争用。**不用 `meta.target`** —— 该字段在 PG 连接器下常返回约束
 * 名而非列名数组，且随 Prisma 版本 / adapter 变形；重查法与它的形态完全无关。
 *
 * ## 元数据回声：一律取自 `row`
 *
 * 应答里的 `title` / `reportDate` / `version` 全部读**落库那一行**，不是请求参数（FR-008）；
 * 幂等命中时读的是**库中那条**，于是「参数写错重投改不掉」这件事对投递方显式可见而非静默
 * （FR-010 / state_branch 11）。
 *
 * ## 标的名称：跨 ctx 只读 + fail-open（058 起 research 的跨 ctx 面 0 → 1）
 *
 * 投递方对自己声明的标的**零反馈**是 2026-08-16 实测两类错误的共同根因，而这条通道没有任何
 * 读取面可供自查 ⇒ 回显名称是唯一可能的自查手段（FR-012）。落法是 catalog **Q7-B 只读直查**
 * `marketdata.instrument`（`// CROSS-CONTEXT-READ:` 注释 + `check-server-moat` 硬拦），
 * **不 DI marketdata 的任何 use case**（Q7-C 禁列）、**绝不写**、也不为一条查询包一层共享读
 * 服务（仓内两处同形态先例都是 usecase 内直查：`alert/evaluate-alerts.usecase.ts`、
 * `marketdata/sync-option-contract.usecase.ts`）。
 *
 * - **新建与幂等命中两条路径都查** —— FR-012 无条件。故名称补在 `respond()` 这一个出口上，
 *   「漏掉某条返回路径」在结构上不可能。
 * - **fail-open**：整段 `try/catch`，任何异常 → 名称按 `null` 走、投递照常成功（FR-015）。
 *   漏了 catch 的表现是**一次已经写进 OSS 的成功投递被判失败**，而投递方没有 `GET` 可自查、
 *   只会重投。查不到与查失败对外**完全一样**（FR-014），区分只落服务端日志。
 * - **不按上市状态过滤**（FR-018）：研报常常正是为已退市 / 停牌标的写的。
 * - **不做任何比对、不给「投对了」的判断**（FR-029）—— 判断权在投递方，服务端只给事实。
 */
@Injectable()
export class IngestResearchReportUseCase {
  private readonly logger = new Logger(IngestResearchReportUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
    @Inject(researchOssConfig.KEY) private readonly oss: ResearchOssConfig,
  ) {}

  async execute(input: IngestResearchReportInput): Promise<IngestResearchReportResult> {
    if (this.oss.kind === 'unconfigured') {
      // 「未接通存储」与「服务坏了」是两回事 —— 明确报未启用，不表现为故障（state_branch 9）。
      throw new ServiceUnavailableException('RESEARCH_STORAGE_NOT_CONFIGURED');
    }

    const symbol = normalizeSymbolOrReject(input.symbol);
    const reportDate = parseReportDate(input.reportDate);
    if (reportDate === null) {
      throw ResearchIngestRejectedException.reportDateInvalid(input.reportDate);
    }

    const bytes = input.file.bytes;
    // 判据基于**内容**而非文件名或调用方声明的类型（FR-003）。
    if (!looksLikePdf(bytes)) throw ResearchIngestRejectedException.notPdf();

    const contentHash = contentHashOf(bytes);
    const sizeBytes = bytes.length;
    const { uploaderKind, uploaderRef } = splitUploader(input.uploader);

    const identity = { uploaderKind, uploaderRef, symbol, contentHash };
    const existing = await this.findByIdempotencyKey(identity);

    if (existing?.status === STATUS_COMMITTED) return this.respond(existing, true);

    // 配额闸放在建行之前：被拒的投递不计入（FR-010）。续做既有 PENDING 行时它已在和里，
    // 不再叠加本次字节，否则卡在配额线上的那条永远续不动。
    if (existing === null) {
      const agg = await this.prisma.researchReport.aggregate({
        _sum: { sizeBytes: true },
        where: { uploaderKind, uploaderRef },
      });
      const used = agg._sum.sizeBytes ?? 0;
      if (used + sizeBytes > RESEARCH_QUOTA_BYTES) {
        throw ResearchIngestRejectedException.quotaExceeded(used, RESEARCH_QUOTA_BYTES);
      }
    }

    // 🚨 顺序是「拿到全部字节 → 签 → POST」，不能反：`content-length-range` 的上界要在签名时
    // 确定。上界用**固定常量**而非 `[len, len]` 精确锁 —— 精确锁把一个 off-by-one 变成生产事故。
    // 签一次用两处（objectKey 落库 + POST），避免两处各签各的而 key 漂移。
    const credential = buildCredential(this.oss, contentHash);

    const row =
      existing ??
      (await this.claimVersionedRow({
        ...identity,
        reportDate,
        title: input.title?.trim() || titleFromFilename(input.file.filename),
        source: input.source?.trim() || undefined,
        sizeBytes,
        originalFilename: input.file.filename,
        objectKey: credential.objectKey,
      }));

    // 取号期间撞上了**并发的重复投递**、而那一条已经走完：与幂等命中同一条出口，不碰 OSS。
    if (row.status === STATUS_COMMITTED) return this.respond(row, true);

    try {
      await this.storage.putObject({
        credential,
        body: bytes,
        contentType: 'application/pdf',
        filename: input.file.filename,
      });
    } catch (err) {
      // 三态里的后两态。**绝不可合并**：把「无法确定」当「被拒」，一个其实传成功的投递方
      // 会被告知失败并去重传，而我们没有读权限去回查（FR-008）。
      if (err instanceof ObjectStorageIndeterminateError) {
        throw ResearchIngestRejectedException.storageIndeterminate();
      }
      throw ResearchIngestRejectedException.storageRejected();
    }

    // 这一步失败 → 行停在 PENDING，对象已在。扫 PENDING 即可发现这条孤儿（Edge Case）。
    await this.prisma.researchReport.update({
      where: { id: row.id },
      data: { status: STATUS_COMMITTED },
    });

    return this.respond(row, false);
  }

  /**
   * 应答的**唯一出口**：落库那一行 + 实时读到的标的名称。
   *
   * 名称补在这里而不是各返回点，是「新建与幂等命中两条路径都有名称」（FR-012 无条件）在结构
   * 上的保证 —— 接在 create 分支上的写法，现有五层判据一条都照不到。
   */
  private async respond(
    row: Parameters<typeof toResult>[0],
    deduplicated: boolean,
  ): Promise<IngestResearchReportResult> {
    return toResult(row, deduplicated, await this.lookupInstrumentName(row.symbol));
  }

  /**
   * 标的名称：跨 ctx 只读 + fail-open（FR-012 ~ FR-018）。
   *
   * 入参必须是 **`row.symbol`**（归一后并最终落库的那个），不是 `input.symbol` 那个原始写法
   * —— 幂等命中时二者归一后必然相同，但**写法**可能不同（`00700.HK` vs `hk:00700`）。
   *
   * 🚨 整段 `try/catch`（含 `splitSymbol` 的抛出）：名称回显**不是投递的失败点**（FR-015）。
   */
  private async lookupInstrumentName(symbol: string): Promise<string | null> {
    try {
      const { market, code } = splitSymbol(symbol);
      // 🚨 复合唯一键的访问器是 `market_code`（`@@unique([market, code], map:
      // "uk_instrument_market_code")`）。写成 `findFirst({ where: { market, code } })` 不红，
      // 但走不上唯一索引。**不按上市状态过滤**（FR-018）。
      // CROSS-CONTEXT-READ: 投递应答回显标的名称需 marketdata.instrument 的 name (只读, Q7-B per ADR-0065 复审)
      const instrument = await this.prisma.instrument.findUnique({
        where: { market_code: { market, code } },
        select: { name: true },
      });
      return instrument?.name ?? null;
    } catch (err) {
      // 「查不到」与「查失败」对外不可区分（FR-014）⇒ 排障所需的区分只落这里。
      const summary = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.logger.warn(`标的名称回显失败，按「无名称」继续: symbol=${symbol} err=${summary}`);
      return null;
    }
  }

  private findByIdempotencyKey(identity: IdempotencyIdentity) {
    return this.prisma.researchReport.findUnique({
      where: { uploaderKind_uploaderRef_symbol_contentHash: identity },
    });
  }

  /**
   * 取号 + 建 PENDING 行，撞车有界重试。
   *
   * 返回值有两种可能，调用方靠 `status` 区分：
   * - **新建的 PENDING 行** —— 正常路径。
   * - **别人刚建的同幂等键行** —— 并发的重复投递。它可能已完成（调用方走幂等出口）也可能仍
   *   未完成（调用方就地续做）；两种都不该再建第二行。
   */
  private async claimVersionedRow(
    fields: IdempotencyIdentity & {
      reportDate: Date;
      title: string;
      source: string | undefined;
      sizeBytes: number;
      originalFilename: string;
      objectKey: string;
    },
  ) {
    const { uploaderKind, uploaderRef, symbol, contentHash } = fields;
    for (let attempt = 1; ; attempt++) {
      // 🚨 三列齐全、且**不过滤 status**（FR-024）—— 判据见类注释「版本号」段。
      const agg = await this.prisma.researchReport.aggregate({
        _max: { version: true },
        where: { uploaderKind, uploaderRef, symbol },
      });

      try {
        return await this.prisma.researchReport.create({
          data: { ...fields, version: (agg._max.version ?? 0) + 1, status: STATUS_PENDING },
        });
      } catch (err) {
        if (!isP2002(err)) throw err;

        // 表上两个唯一键含义相反 ⇒ 重查幂等键判别撞的是哪个（Guardrail 2，不用 meta.target）。
        const duplicate = await this.findByIdempotencyKey({
          uploaderKind,
          uploaderRef,
          symbol,
          contentHash,
        });
        if (duplicate !== null) return duplicate; // 查到 = 重复投递

        // 查不到 = 取号争用：号被同线的另一次投递抢走了，重算 MAX+1 再试。
        if (attempt >= VERSION_CLAIM_MAX_ATTEMPTS) throw err;
      }
    }
  }
}

/** 幂等键的四列（放宽后：投递方两列 + 标的 + 内容指纹）。 */
interface IdempotencyIdentity {
  uploaderKind: string;
  uploaderRef: string;
  symbol: string;
  contentHash: string;
}

/**
 * 应答一律由**落库的那一行**导出（FR-008 / FR-010）—— 幂等命中与新建共用这一个出口，
 * 是「回显的不可能是请求参数」在结构上的保证。
 *
 * 唯一的例外是 `instrumentName`：它**不落库**（FR-017 实时读），由 `respond()` 查好后传进来。
 */
function toResult(
  row: {
    id: bigint;
    symbol: string;
    objectKey: string;
    title: string;
    reportDate: Date;
    version: number;
  },
  deduplicated: boolean,
  instrumentName: string | null,
): IngestResearchReportResult {
  return {
    reportId: row.id.toString(),
    symbol: row.symbol,
    objectKey: row.objectKey,
    deduplicated,
    title: row.title,
    reportDate: toReportDateString(row.reportDate),
    version: row.version,
    instrumentName,
  };
}

/**
 * `report_date` 是 `@db.Date`，Prisma 取回的是 **UTC 零点**的 `Date` ⇒ 必须走
 * `toISOString().slice(0, 10)`。`toLocaleDateString()` 出的是 `2026/8/16`（形态就不对）；
 * 本地 getter 拼串在 UTC+8 下侥幸不差天、换个负偏移时区就差一天
 * （判据同 `docs/conventions/cross-timezone-date-semantics.md`）。
 */
function toReportDateString(reportDate: Date): string {
  return reportDate.toISOString().slice(0, 10);
}

/** `InvalidSymbolError` 的三种 reason 各映射一个独立 code（SC-004 可区分）。 */
function normalizeSymbolOrReject(raw: string): string {
  try {
    return normalizeSymbol(raw);
  } catch (err) {
    if (!(err instanceof InvalidSymbolError)) throw err;
    if (err.reason === 'percent-encoded') {
      throw ResearchIngestRejectedException.symbolPercentEncoded(err.message);
    }
    if (err.reason === 'market') {
      throw ResearchIngestRejectedException.symbolMarketUnsupported(err.message);
    }
    throw ResearchIngestRejectedException.symbolInvalid(err.message);
  }
}

function splitUploader(uploader: Uploader): { uploaderKind: string; uploaderRef: string } {
  return uploader.kind === 'guest'
    ? { uploaderKind: 'guest', uploaderRef: uploader.guestName }
    : { uploaderKind: 'account', uploaderRef: uploader.accountId };
}

/**
 * 现签一张一次性表单凭证。`uuid` 位传**内容指纹**，使 objectKey 与投递方无关
 * —— `buildObjectKey(contentHash)` 与本函数的产物逐字节相同（rules spec 有断言钉住）。
 * TTL 60s：server 自签自用，不需要客户端直传那个 15min。
 */
function buildCredential(oss: Extract<ResearchOssConfig, { kind: 'aliyun' }>, contentHash: string) {
  return buildPostObjectCredential({
    region: oss.region,
    bucket: oss.bucket,
    accessKeyId: oss.accessKeyId,
    accessKeySecret: oss.accessKeySecret,
    keyPrefix: RESEARCH_KEY_PREFIX,
    keyLeaf: RESEARCH_KEY_LEAF,
    contentTypeWhitelist: ['application/pdf'],
    maxSizeBytes: RESEARCH_OSS_MAX_BYTES,
    ttlMs: 60_000,
    now: new Date(),
    uuid: contentHash,
  });
}
