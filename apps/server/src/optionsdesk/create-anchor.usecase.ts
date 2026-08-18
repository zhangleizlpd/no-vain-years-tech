import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { OUTBOX_PUBLISHER, type OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import { computeW, mapConfidenceToLLevel, type LLevel } from './anchor.rules';
import { buildCreationChange, type AnchorChangeSource } from './anchor-history';
import { resolveLastClosedSessionForTicker } from './last-closed-session';
import { EnsureLatestEodBarUseCase } from '../marketdata/ensure-latest-eod-bar.usecase';

/**
 * 045 US1 — 建锚 (FR-001 / FR-003a / FR-033, plan D3)。
 *
 * 范式 = ADR-0043 扁平 + 贫血: 直注 `PrismaService`, 无 repository / Domain Class / Entity
 * Mapper; 业务不变式 (档位映射 / V 合法域) 全在 `anchor.rules.ts` 纯函数, 本文件只做
 * 「读现状 → 求值 → 写库 → 投影」。
 *
 * **生效 L 层写入时求值** (plan D3): 生效 L 层是参与 SQL 筛选的普通列, 所有影响它的路径
 * (建锚 / 改 confidence / 改 L 层人工位 / 撤销 / 模型 import) MUST 在写入时算完再写。
 * 一致性铁律 (FR-006 末句): 任一时刻每个数只有**一个**生效值 —— 人工位列存「人工值」、
 * 生效列存「最终值」, MUST NOT 存第二份生效 L 层。单票上限**无**生效列 (请求时派生,
 * FR-003a ①)。
 *
 * 本文件同时是写侧共享投影 (`AnchorRow` / `AnchorWriteResult` / {@link toAnchorWriteResult})
 * 的落点, update / delete 侧 import 复用 (同 ctx 内 usecase 间引用, 体例同
 * `alert/update-alert.usecase.ts` 引 `create-alerts-batch.usecase.ts`)。
 */

/** 写侧可接受的 Decimal 形态: DTO 传 string, row 传 `Prisma.Decimal`。 */
export type AnchorDecimalInput = string | Prisma.Decimal;

/** `confidence` 的来源门控值域 (FR-001): model = 界面只读, manual = 可改。 */
export const ANCHOR_CONFIDENCE_SOURCES = ['model', 'manual'] as const;

export type AnchorConfidenceSource = (typeof ANCHOR_CONFIDENCE_SOURCES)[number];

/** 锚主表贫血 row (与 schema `optionsdesk.anchor` 逐列对应, 无 Domain Class)。 */
export interface AnchorRow {
  id: bigint;
  ticker: string;
  v: Prisma.Decimal;
  asof: Date;
  method: string;
  confidence: Prisma.Decimal;
  confidenceSource: string;
  excluded: boolean;
  excludeReason: string | null;
  nextReview: Date | null;
  lastReviewedOn: Date | null;
  vManual: Prisma.Decimal | null;
  lLevelManual: string | null;
  positionCapManual: Prisma.Decimal | null;
  lLevelEffective: string;
  lastClose: Prisma.Decimal | null;
  lastCloseDate: Date | null;
  /**
   * 061 盘中实时价 + 其**采集墙钟** —— 与上面收盘两列是**并列的第二个价源**, 不是替代
   * (FR-015)。读侧的生效 spot 由 `intraday-spot.rules.ts` 单点裁决, MUST NOT 在别处再判一次。
   */
  intradayPrice: Prisma.Decimal | null;
  intradayAt: Date | null;
  breachStartedOn: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnchorWriteResult extends Omit<
  AnchorRow,
  'confidenceSource' | 'lLevelEffective' | 'lLevelManual'
> {
  confidenceSource: AnchorConfidenceSource;
  lLevelEffective: LLevel;
  lLevelManual: LLevel | null;
  /**
   * EC-10「建锚即逾期」: `next_review` 早于 `asof` MUST 允许保存 (补录旧估值是真实场景),
   * 但 MUST 可被识别、MUST NOT 静默当有效。
   */
  overdueAgainstAsof: boolean;
  /**
   * 该锚所属市场的「最近一个已收盘交易日」(`YYYY-MM-DD`; 日历查不到 ⇒ `null`) ——
   * FR-020 新鲜度档的**判据基准**, 由 `resolveLastClosedSessionForTicker` 取。
   *
   * 🚨 写侧也带它, 是为了让 `quoteFreshnessTier` 在**每一个**回锚的端点上都成立。少一个端点
   * 供不上, 这个字段就变成「有时候可信」—— 那比没有更危险 (消费方无从分辨)。
   */
  lastClosedSession: string | null;
}

export interface CreateAnchorInput {
  /** canonical `market:code` (来自 `GET /marketdata/search`, FR-002 禁自由文本)。 */
  ticker: string;
  v: AnchorDecimalInput;
  asof: Date;
  method: string;
  confidence: AnchorDecimalInput;
  /** 缺省 manual —— App 手工建锚即人工填 confidence (FR-001 / EC-8)。 */
  confidenceSource?: AnchorConfidenceSource;
  excluded?: boolean;
  excludeReason?: string | null;
  nextReview?: Date | null;
  /** 变更痕迹的来源 (FR-035): App 建锚 = manual, import 建锚 = model。 */
  source?: AnchorChangeSource;
}

/** P2002 结构化判定 (`alert/evaluate-alerts.usecase.ts` 同式; Prisma 7 兼容)。 */
const isP2002 = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';

/**
 * EC-3 V ≤ 0 拒绝保存。合法域**不在写侧复判** —— 调 {@link computeW}, 由 `anchor.rules.ts`
 * 单点定义 (SC-005「代码内零自造参数」), `INVALID_ANCHOR_V:` 前缀映射 400。
 */
export function assertUsableV(v: AnchorDecimalInput): void {
  try {
    computeW(v);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('INVALID_ANCHOR_V')) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

/**
 * EC-7 同 ticker 重复建锚 → 409 + 既有锚 id, 引导去编辑既有锚。
 *
 * spec 给的是「拒绝或改为更新」二选一, 取**拒绝**: 静默 upsert 会覆盖已录的估值结论,
 * 而估值是本系统最贵的人工输入。
 * ⚠️ `ProblemDetailFilter` 只透传 `code` / `detail` 等白名单字段, `existingAnchorId`
 * 到不了 HTTP body ⇒ id 同时写进 message 供人读; 客户端凭自己刚提交的 ticker 回查既有锚。
 * (白名单是 security ctx 的既有形态, 本 feature 不动它。)
 */
function duplicateTickerConflict(
  ticker: string,
  existingAnchorId: bigint | null,
): ConflictException {
  const idText = existingAnchorId === null ? 'unknown' : existingAnchorId.toString();
  return new ConflictException({
    code: 'ANCHOR_TICKER_EXISTS',
    message: `ANCHOR_TICKER_EXISTS: ${ticker} 已有锚 (id=${idText}), 请编辑既有锚`,
    existingAnchorId: idText,
  });
}

/**
 * **归一化已有的 `@db.Date` 值**到 UTC 日界 —— 该类列读出来本就是 UTC 午夜, 过它是幂等的。
 * 日期列之间比较一律先过它。
 *
 * 🚨 **MUST NOT 传 `new Date()`** —— 那是绝对时刻, 取它的 UTC 日期得到的是**UTC 今天**,
 * 既不是上海也不是纽约, 是凭空的第三个口径 (境内 08:00 前比本地日期慢一天)。求「今天」
 * 用 {@link shanghaiDateOnly}。两种用途蓄意拆成两个名字, 因为同名同签名时通读式 review
 * 抓不住 (判据见 `docs/conventions/cross-timezone-date-semantics.md` §3)。
 */
export function toUtcDateOnly(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * **用户所在地 (上海) 的「今天」**, 表示为 UTC 午夜 —— 与 `@db.Date` 列同基准可直接比较。
 *
 * 🚨 锚的日期语义跟**用户所在地**走, 不是交易所、更不是 UTC: `next_review` / `last_reviewed_on`
 * 记的是「你什么时候坐下来复盘」, 与市场时区无关 (`cross-timezone-date-semantics.md` §3
 * 「今天」归属表: 人工节奏 → 用户所在地)。
 *
 * `en-CA` locale 直出 ISO `YYYY-MM-DD` (免手拼零填充); DST 由 Intl 处理。复杂度 O(1)。
 */
export function shanghaiDateOnly(now: Date): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** 贫血 row → 写侧响应投影 (含 EC-10 派生标记 + FR-020 新鲜度基准)。 */
export function toAnchorWriteResult(
  row: AnchorRow,
  lastClosedSession: string | null,
): AnchorWriteResult {
  return {
    ...row,
    confidenceSource: row.confidenceSource as AnchorConfidenceSource,
    lLevelEffective: row.lLevelEffective as LLevel,
    lLevelManual: row.lLevelManual as LLevel | null,
    overdueAgainstAsof: isOverdueAgainstAsof(row.nextReview, row.asof),
    lastClosedSession,
  };
}

/** EC-10 判据: `next_review` 早于 `asof` ⇒ 建锚即逾期。 */
export function isOverdueAgainstAsof(nextReview: Date | null, asof: Date): boolean {
  return nextReview !== null && nextReview.getTime() < asof.getTime();
}

/** 060 FR-004: 建锚事件类型。marketdata 侧持**同一份字面量副本**, 两 ctx 互不 import。 */
const ANCHOR_CREATED_EVENT = 'optionsdesk.anchor-created';

@Injectable()
export class CreateAnchorUseCase {
  private readonly logger = new Logger(CreateAnchorUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOX_PUBLISHER) private readonly outboxPublisher: OutboxPublisher,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 建锚即取一次最近收盘。注入的是**为这件事
    // 造的窄 use case**, 不是裸 `EOD_BAR_PORT` —— 按市场路由 vendor 与落库口径都留在 marketdata,
    // 本 ctx 只问「这只票最近一根收盘是多少」。同步是刻意的 (产出要进本次创建响应), 但**失败
    // 不回滚建锚**, 故不与主 tx 共事务, 见 {@link CreateAnchorUseCase.seedLastClose}。
    private readonly ensureLatestEodBar: EnsureLatestEodBarUseCase,
  ) {}

  async execute(input: CreateAnchorInput): Promise<AnchorWriteResult> {
    assertUsableV(input.v);

    // 建锚不带人工位 (FR-032 ① 人工调整是显式动作, 系统不代设) ⇒ 生效 L 层 = confidence 映射值。
    const lLevelEffective = mapConfidenceToLLevel(input.confidence);

    const existing = await this.prisma.anchor.findUnique({
      where: { ticker: input.ticker },
      select: { id: true },
    });
    if (existing !== null) {
      throw duplicateTickerConflict(input.ticker, existing.id);
    }

    try {
      // 主行与建锚痕迹同一个 tx (FR-031): 痕迹缺失即 PIT 还原从此断链, 不可事后补。
      const row = await this.prisma.$transaction(async (tx) => {
        const created = (await tx.anchor.create({
          data: {
            ticker: input.ticker,
            v: input.v,
            asof: input.asof,
            method: input.method,
            confidence: input.confidence,
            confidenceSource: input.confidenceSource ?? 'manual',
            excluded: input.excluded ?? false,
            excludeReason: input.excludeReason ?? null,
            nextReview: input.nextReview ?? null,
            // 建锚 = 一次确认: 不回填则新锚只要 spot 在 W 下方就会立刻误亮复核锚红标 (FR-013)。
            lastReviewedOn: shanghaiDateOnly(new Date()),
            lLevelEffective,
            // breach_started_on 建锚期不写: 判据要 spot, 而 last_close 由行情投影 (T012) 落列后
            // 才由雷达状态机 (T013) 置起点。
          },
        })) as AnchorRow;
        const change = buildCreationChange(created, input.source ?? 'manual');
        await tx.anchorChange.create({
          data: {
            anchorId: created.id,
            changedFields: [...change.changedFields],
            beforeValues: change.beforeValues,
            source: change.source,
          },
        });
        // CROSS-CONTEXT-ASYNC: optionsdesk.anchor-created → marketdata 起冷启动补数 (060 §D1)。
        //
        // **同 tx** (FR-004): 建锚回滚 ⇒ outbox 行一起没, 否则会给一只根本不存在的锚跑采集。
        // payload 只带这两格 —— market 由消费侧从 ticker 前缀解析 (FR-020), 生产侧预解析等于
        // 把市场知识复制到第二处; `anchorId` 转串是因为 BigInt 过不了 JSON 信封, 且消费侧按
        // 十进制串校验 (给 bigint 会被判毒丸静默丢掉)。
        //
        // 🚫 **只在这里发一次。** `import-anchor-from-model.usecase.ts` 的 create 分支是**委托**
        // 本 use case, App 手工建锚走 controller 也是它 ⇒ 两条入口自动覆盖 (FR-002);
        // 在 import 那侧再发一遍就是双发。update 分支一行不发 (FR-003)。
        await this.outboxPublisher.publish(
          tx,
          ANCHOR_CREATED_EVENT,
          { anchorId: String(created.id), ticker: created.ticker },
          'optionsdesk',
        );
        return created;
      });
      // 新鲜度基准在 tx 外取 (只读、与本次写无因果) —— 别把跨 ctx 读拖进写事务。
      const lastClosedSession = await resolveLastClosedSessionForTicker(this.prisma, row.ticker);
      return toAnchorWriteResult(
        await this.seedLastClose(row, lastClosedSession),
        lastClosedSession,
      );
    } catch (err) {
      if (isP2002(err)) {
        // 预检与 create 之间的并发窗: `uk_anchor_ticker` 唯一索引兜底 (T005 已实证), 与预检同折叠。
        const winner = await this.prisma.anchor.findUnique({
          where: { ticker: input.ticker },
          select: { id: true },
        });
        throw duplicateTickerConflict(input.ticker, winner?.id ?? null);
      }
      throw err;
    }
  }
  /**
   * 建锚即取一次最近收盘 —— 让新锚**不经过**「行情不可用」那段窗口 (2026-08-18)。
   *
   * ## 为什么不能只「投影 `daily_bar`」
   *
   * EOD 采集的工作集由**已有的锚**派生 ⇒ 全新标的在成为锚之前根本没被采过, 建锚那一刻库里一根
   * 日线都没有, 投影只会投出 `null`。锚要有价得先有 EOD, EOD 要被采得先有锚 —— 是个死循环。
   * 只有真去打一次数据源才剪得断, 见 {@link EnsureLatestEodBarUseCase}。
   *
   * ## 🚨 best-effort —— 失败**绝不**影响建锚这件事
   *
   * 锚已经在上面的 tx 里提交了。这一步失败 (vendor 挂 / 超时 / 该标的没数据) 只是退回旧行为:
   * 等 `SyncAnchorQuoteUseCase` 每小时 `:30` 那轮补上。往外抛会让调用方以为建锚失败而重试,
   * 而重试撞 `uk_anchor_ticker` 只会收到 409 —— 一次真实成功被包装成两次失败。
   */
  private async seedLastClose(
    row: AnchorRow,
    lastClosedSession: string | null,
  ): Promise<AnchorRow> {
    if (lastClosedSession === null) return row; // 无目标交易日可问 (市场未登记 / ticker 不可解析)。
    try {
      const bar = await this.ensureLatestEodBar.execute(row.ticker, lastClosedSession);
      if (bar === null) return row; // vendor 无数据 (停牌 / 新股) —— 非错误, 保持 null 投影。
      return (await this.prisma.anchor.update({
        where: { id: row.id },
        data: {
          lastClose: bar.close,
          // 与 `sync-anchor-quote.ts` 同口径: 交易日按 UTC 零点存, 免时区漂。
          lastCloseDate: new Date(`${bar.tradeDate}T00:00:00.000Z`),
        },
      })) as AnchorRow;
    } catch (err) {
      this.logger.warn(
        `[create-anchor] ${row.ticker} 建锚同步取价失败, 退回每小时 :30 投影补: ${String(err)}`,
      );
      return row;
    }
  }
}
