import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
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
}

const STATUS_PENDING = 'PENDING';
const STATUS_COMMITTED = 'COMMITTED';

/**
 * 投递一份研报（057 唯一的写入口）。
 *
 * ## 写序：DB 写 PENDING → OSS put → DB 翻 COMMITTED
 *
 * 为什么不是「先传对象再落库」：server 对该桶**无 DeleteObject 权限**（FR-018），孤儿对象
 * 清不掉 ⇒「查得到」是唯一的补救前提。先落 PENDING 行，任何一步失败都留下可扫出的证据。
 * 反过来先传对象的话，落库失败就会留下一个**不可见、不可清、持续吃配额**的孤儿。
 *
 * ## 幂等：唯一键 =（投递方, 内容指纹）
 *
 * - 命中 **COMMITTED** → 直接返回既有行，**完全不碰 OSS**（state_branch 2）。
 * - 命中 **PENDING** → **就地续做**：重传对象、成功则原地翻 COMMITTED，不新增行、不报冲突
 *   （Clarifications Q2）。隧道上传超时后 agent 重试是常态，「拒绝并等人工」会把常态变成
 *   频繁人工活；而同字节写同位置是幂等重写，即便对象上次其实已传成也无害。
 * - 未命中 → 新建 PENDING 行。
 *
 * 归档**位置由指纹单独导出**，与投递方无关 ⇒ 同一字节在多个投递方名下只占一份存储。
 *
 * ## 配额：该投递方名下全部记录字节之和
 *
 * 含 PENDING（重试不会因为没翻状态就免费）；与他人共享同一对象的记录**照常全额计入**
 * （口径蓄意高估，方向保守）；被拒的投递不计入（闸在建行之前）。续做既有行时**不重复
 * 计入自己**，否则一条正好卡在配额线上的 PENDING 行永远续不动。
 */
@Injectable()
export class IngestResearchReportUseCase {
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

    const existing = await this.prisma.researchReport.findUnique({
      where: {
        uploaderKind_uploaderRef_symbol_contentHash: {
          uploaderKind,
          uploaderRef,
          symbol,
          contentHash,
        },
      },
    });

    if (existing?.status === STATUS_COMMITTED) {
      return {
        reportId: existing.id.toString(),
        symbol: existing.symbol,
        objectKey: existing.objectKey,
        deduplicated: true,
      };
    }

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
      (await this.prisma.researchReport.create({
        data: {
          symbol,
          reportDate,
          title: input.title?.trim() || titleFromFilename(input.file.filename),
          source: input.source?.trim() || undefined,
          contentHash,
          sizeBytes,
          originalFilename: input.file.filename,
          objectKey: credential.objectKey,
          status: STATUS_PENDING,
          uploaderKind,
          uploaderRef,
        },
      }));

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

    return {
      reportId: row.id.toString(),
      symbol: row.symbol,
      objectKey: row.objectKey,
      deduplicated: false,
    };
  }
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
