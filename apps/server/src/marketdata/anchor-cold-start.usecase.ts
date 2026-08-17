import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FlowJob } from 'bullmq';
import { PrismaService } from '../security/prisma.service.js';
import {
  COLD_START_CAPABILITY,
  COLD_START_OUTCOME,
  isColdStartEnabled,
  resolveSnapshotSpec,
  type ColdStartOutcome,
} from './anchor-cold-start.rules.js';
import { AnchorDrivenSyncGate, parseGateTicker } from './anchor-driven-sync-gate.js';
import type { DimensionKey } from './dimension-executor.js';
import { isSessionRegistered, isSessionUnderway, marketNow } from './market-session.rules.js';
import {
  ANCHOR_COLD_START_JOB,
  ANCHOR_COLD_START_RETRY_MAX,
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
  dimensionJobName,
  type AnchorColdStartJobPayload,
  type DimensionJobPayload,
} from './marketdata-sync.queue.js';
import { emptyStats } from './sync-run.recorder.js';
import { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import { currencyForMarket } from './sync-universe.usecase.js';
import { TRADING_CALENDAR_PORT, type TradingCalendarPort } from './trading-calendar.port.js';
import { lastClosedSessionCutoff, marketDateFor } from './trading-day-gate.js';

/**
 * 锚首建冷启动的**编排体** (060 T005, plan §D3 / §D5 / §D9)。
 *
 * 一条建锚事件 = 一个 `sync:anchor-cold-start` job = 一次本 use case 调用, **零合流、零去重**
 * (FR-019c)。收敛靠的是起手复判 —— 排队中的后续请求走到第 5 步会判「已具备」而零外呼。
 *
 * 顺序有**硬依赖** (plan §D9), 不是风格问题:
 * ```
 * 1. 解析 market；不可解析 / 未登记时段 / 未开通采集 ⇒ 记结局后返回 (零外呼)
 * 2. 目标交易日定位 (查日历)；查不到 ⇒ calendar_missing + ERROR, 不猜日期
 * 3. Instrument 行缺失 ⇒ seed
 * 4. AnchorDrivenSyncGate.recalcSafely() 幂等开闸
 * 5. 起手复判：本锚**标的**在目标交易日的数据是否已具备；已具备 ⇒ already_present
 * 6. 不敏感档 (第一相)：组 flow 入队链 + 日线, 本 job 以 phase='snapshot' 当 parent 挂其上
 * 7. 敏感档 (第二相)：盘中 ⇒ intraday_skipped；否则按 §D4 算 spec → collect
 * 8. 落运行记录
 * ```
 * 3 → 4 → 载工作集这个次序反了会**静默拿到空工作集**: 闸只认已存在的 Instrument 行, 而新锚
 * 在 universe 轮到它之前可能一行都没有。
 *
 * ## 🚨 6 与 7 为什么必须分两相 (impl 期定案, 2026-08-17)
 *
 * worker `concurrency=1` 且冷启动 job 自己就跑在这条 worker 上 ⇒ 它入队的 flow 在它返回之前
 * **一个都跑不了** (确定性, 非竞态)。若在同一次调用里 inline 抓快照, 对一只**全新锚**
 * `option_contract` 恰好 0 行 ⇒ `SyncOptionSnapshotUseCase` 判「无未到期合约」WARN + 零外呼
 * 返回 ⇒ **目标交易日的快照永远不写, 而整条路径全绿、结局还会落 `backfilled`**。
 * SC-001 要的正是那份快照。⇒ 第二相由 BullMQ flow 的 parent 语义保证「children 全终态才跑」。
 *
 * 📌 顺带更正确的一点: 盘中闸因此落在**真正要写的那一刻**, 而不是入队那一刻 (FR-010/011)。
 */
/**
 * 一次调用的结果。**未终结时不落运行记录** —— 那张表记的是「最近一次冷启动的**结局**」
 * (FR-026), 而两相加起来才是一次冷启动; 中途写一行会让「最近一次的结局」在窗口期内是错的,
 * 且八种结局 (FR-027) 里本就没有「进行中」这个值, 硬塞第九个会直接破 SC-009 的零折叠。
 */
export type ColdStartResult =
  | { settled: true; outcome: ColdStartOutcome }
  | {
      settled: false;
      /**
       * `awaiting_chain` = 第一相已组 flow, 第二相由 parent 语义接着跑;
       * `vendor_budget` = 配额耗尽, **顺延**重入队 (不耗 attempts, FR-019b)。
       */
      deferral: 'awaiting_chain' | 'vendor_budget';
    };

@Injectable()
export class AnchorColdStartUseCase {
  private readonly logger = new Logger(AnchorColdStartUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: AnchorDrivenSyncGate,
    private readonly syncQueue: MarketdataSyncQueue,
    private readonly snapshot: SyncOptionSnapshotUseCase,
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  /**
   * 复杂度: O(1) 次日历查询 + O(1) 次标的查询 + 开闸的 O(市场数) 次 updateMany +
   * ≤2 次复判 count + 1 次运行记录 upsert; 第二相另加 1 次快照采集 (O(合约数))。
   */
  async run(input: {
    anchorId: bigint;
    ticker: string;
    now: Date;
    phase?: 'snapshot';
  }): Promise<ColdStartResult> {
    const { anchorId, ticker, now, phase } = input;

    // ── 1. 市场归属只从 ticker 解析, 不假定默认市场 (FR-020 / FR-021) ──
    const parsed = parseGateTicker(ticker);
    if (parsed === null) {
      return this.finish(input, COLD_START_OUTCOME.TICKER_UNRESOLVED, {
        reason: `ticker "${ticker}" 解析不出 market:code`,
      });
    }
    const { market, code } = parsed;

    // 未登记盘中时段 ⇒ 判不了「该场进行中」⇒ fail-closed 跳过 (FR-022)。**先于**能力检查,
    // 因为它是更靠前的前提: 时段没登记的话, 就算开通了采集也无从判断此刻能不能写快照。
    if (!isSessionRegistered(market)) {
      return this.finish(input, COLD_START_OUTCOME.SESSION_UNREGISTERED, {
        reason: `市场 "${market}" 未登记盘中时段 (market-session.rules.ts)`,
      });
    }
    // 未开通期权采集 ⇒ **显式 no-op, 非错误** (FR-023): hk 是空表项、cn 压根没登记, 两者
    // 同落一个结局但都留痕, 不静默。
    if (!isColdStartEnabled(market)) {
      return this.finish(input, COLD_START_OUTCOME.MARKET_NOT_ENABLED, {
        reason: `市场 "${market}" 未开通冷启动补数 (COLD_START_CAPABILITY)`,
      });
    }

    // ── 2. 目标交易日 = 最近一个已收盘交易日 (FR-006 / FR-007) ──
    const targetSession = await this.lastClosedTradingDay(market, now);
    if (targetSession === null) {
      // 🚫 不猜日子 (FR-009): 猜错就是一批 session_date 标错的脏行, 比不补更难发现且要人工
      //    回删。照抄 option-snapshot-remediation 的 blocked 纪律。ERROR 级 = 需人工介入。
      this.logger.error(
        `[anchor-cold-start] 交易日历缺 ${market} 的行, 定位不到目标交易日 ⇒ 放弃冷启动 ` +
          `(anchorId=${anchorId} ticker=${ticker}; 请补交易日历)`,
      );
      return this.finish(input, COLD_START_OUTCOME.CALENDAR_MISSING, {
        reason: `交易日历缺 ${market} 在 ${lastClosedSessionCutoff(market, now)} 及之前的行`,
      });
    }

    // ── 3. 有锚必有 Instrument 行 (FR-025); 缺行不让整体失败, 补上继续 ──
    const instrumentId = await this.seedInstrument(market, code);

    // ── 4. 幂等开闸: 把新锚的 needSync 翻 true。失败自降级返 null, 不上抛 ──
    await this.gate.recalcSafely();

    // ── 5. 起手复判 (FR-016 / FR-016a) ──
    if (await this.dataAlreadyPresent(market, instrumentId, targetSession)) {
      return this.finish(input, COLD_START_OUTCOME.ALREADY_PRESENT, { targetSession });
    }

    const capability = COLD_START_CAPABILITY[market];

    // ── 6. 不敏感档 (第一相): 链 + 日线组 flow, 本 job 当 parent 排在它们之后 ──
    // 🚫 链与日线**不受盘中判据约束** (FR-012): 前者是与交易日无关的静态属性, 后者有可指定
    //    日期的历史来源。盘中闸只管敏感档, 且落在第二相 (真正要写的那一刻)。
    if (phase !== 'snapshot' && capability.deltaDimensions.length > 0) {
      await this.enqueueDeltaFlow(input, market, capability.deltaDimensions);
      return { settled: false, deferral: 'awaiting_chain' };
    }

    // ── 7. 敏感档 ──
    if (!capability.optionSnapshot) {
      // 该市场只补链/日线 —— 走到这里说明它们已由第一相入队完成, 本次冷启动到此为止。
      return this.finish(input, COLD_START_OUTCOME.BACKFILLED, { targetSession });
    }

    // 「今天是不是交易日」**一次查、两处用**: 盘中闸与 §D4 的三元组决策问的是同一件事,
    // 查两遍就是两处判据。端口对未 populate 的日历 fail-open, 但走到这里 `targetSession`
    // 已定到 ⇒ 日历必已 populate ⇒ fail-open 够不着 (定位目标日那一步为何不用它, 见
    // {@link lastClosedTradingDay})。
    const todayIsTradingDay = await this.calendar.isTradingDay(
      market,
      marketDateFor([market], now),
    );

    // 🚨 闸 = 「该场进行中」**且**「今天真有这一场」, 两个条件缺一不可:
    //
    // ① `isSessionUnderway`「该场进行中」(**含午休**) MUST NOT 换成 `isWithinTradingSession`
    //    —— 后者午休返 false ⇒ 放行, 而此刻 D4 算出的目标日是**上一个交易日** ⇒ 把午休盘口
    //    贴上「上一场收盘」的标签写进库。今天潜伏 (us 无午休), 接 hk 期权即显形 (FR-011)。
    // ② `todayIsTradingDay` 这一格是 T010 铺时点用例时补上的 (impl 期修正, 2026-08-17):
    //    `isSessionUnderway` 是**纯时钟**谓词, 不看星期也不看日历 ⇒ 周六 ET 12:00 它照样返
    //    true。少了这一格, **北京周六 21:30 – 周日 04:00 建的锚会落 `intraday_skipped`**,
    //    而那是终态不重试、常规轮周一晚写的又是周一的数据 ⇒ 目标日快照**永久**缺失
    //    (SC-001 要的正是它)。境内用户周末夜里建锚恰是高发时段, 美股节假日同理。
    //    📌 §D4 第四行 (`today > target` 且今天非交易日 ⇒ eod) 本就是为周末这一档写的 ——
    //    没有这个 `&&`, 那一行在 ET 场内钟点上**够不到**。
    //
    // 方向也是安全的: 日历 fail-open 返 true ⇒ 闸仍然收紧 ⇒ 写库 fail-closed。
    if (isSessionUnderway(market, marketNow(market, now).minutesOfDay) && todayIsTradingDay) {
      return this.finish(input, COLD_START_OUTCOME.INTRADAY_SKIPPED, { targetSession });
    }

    const decision = resolveSnapshotSpec({
      market,
      now,
      lastClosedTradingDay: targetSession,
      todayIsTradingDay,
      tradingDayBeforeTarget: await this.tradingDayBefore(market, targetSession),
    });
    if (decision.decision === 'abandon') {
      // 兜底: 第 2 步已挡过日历缺行, 这条正常够不到 —— 但判据在规则层, 不在这里复制一份。
      return this.finish(input, decision.outcome, {});
    }

    // 🚨 直调 `collect` 而非维度 job 的 `run()`: 后者写死 `sessionDate = 当前业务日` + `eod`
    //    (plan §D8), 在盘前窗口会把 `sessionDate` 标成**尚未收盘的那天**。`collect` 是唯一
    //    能显式指定归属日的入口, 且 spec **原样**来自 T003 的纯函数, 此处不重算 (FR-014)。
    const budgetExhausted = await this.snapshot.collect(
      [{ id: instrumentId, market, code }],
      decision.spec,
      emptyStats(),
    );
    if (budgetExhausted) {
      // 🚫 顺延 ≠ 失败 (FR-018 / FR-019b): **不**落 `retry_exhausted` (那是「做了但失败」),
      //    也**不**落 `backfilled` (什么都没采到)。交回信号由 job 层延时重入队, 不耗 attempts
      //    —— 语义与既有 `ExecutorResult.budgetExhausted` 那条路径逐字相同。
      this.logger.warn(
        `[anchor-cold-start] 快照配额耗尽, 顺延重跑: ${ticker} (目标 ${targetSession})`,
      );
      return { settled: false, deferral: 'vendor_budget' };
    }
    return this.finish(input, COLD_START_OUTCOME.BACKFILLED, { targetSession });
  }

  /**
   * **retry 耗尽出口** (FR-019a, plan §D10 第二层): job 层在 BullMQ `attempts` 用尽后调本方法
   * 落 `retry_exhausted` —— 「做了但失败」, 与「今天本就不该做」两两互异 (FR-027 零折叠)。
   *
   * 🚨 **判据留在 job 层, 不在这里复判**: 「还能不能再试」是 BullMQ 的账 (`attemptsMade` /
   * `opts.attempts`), use case 看不见也不该看见。本方法只负责把结论落库。
   *
   * ⚠️ 它可能**覆盖**同一次冷启动刚写下的 `backfilled`: 链 child 带 `failParentOnFailure`
   * 硬失败时, BullMQ 仍会**先跑一遍** parent (第二相), 待其收尾时才以「有失败 child」
   * 拒绝 complete (bullmq `scripts.js` 把 lua 的 `-9` 折成 `UnrecoverableError`) ⇒ 那一遍
   * 可能已写过一个 `backfilled` 的谎 (零合约 ⇒ 零外呼 ⇒ 也算"跑完了")。后写的这一行才是真相,
   * 覆盖是**要的行为**, 不是竞态。
   */
  async recordRetryExhausted(input: {
    anchorId: bigint;
    ticker: string;
    now: Date;
    failedReason?: string;
  }): Promise<void> {
    await this.finish(input, COLD_START_OUTCOME.RETRY_EXHAUSTED, {
      reason: `BullMQ attempts 耗尽: ${input.failedReason ?? '(无 failedReason)'}`,
    });
  }

  /**
   * 组 flow 入队: children = 能力登记表里的 delta 维度, parent = **本 job 的第二相**。
   *
   * 边的软硬**不同**, 且都必须显式给 —— 裸 child 会让 parent 永久卡在 `waiting-children`
   * (`sync-flow-assembler.ts` 已实证过一次):
   * - `option_contract` → **hard** (`failParentOnFailure`): 没有链就没有合约行, 第二相跑起来
   *   只会 WARN 零外呼然后落一个 `backfilled` 的谎。让 parent 一起失败, 结局交由 job 层的
   *   retry-exhausted 出口落 `retry_exhausted` (FR-019a) —— 那才是真相。
   * - 其余 (`us_equity_bar`) → **soft** (`ignoreDependencyOnFailure`): 日线与快照互不依赖,
   *   日线挂了不该连累快照。
   *
   * 🚫 delta job **不指定冷启动专属的 `asOf`** (FR-012a): 按各维度自己的 `marketScope` 求业务日,
   * 与常规轮逐字同源; 日线维度自带的回看窗会把近期缺口一并补上。
   */
  private async enqueueDeltaFlow(
    input: { anchorId: bigint; ticker: string; now: Date },
    market: string,
    deltaDimensions: readonly string[],
  ): Promise<void> {
    const rows = await this.prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [...deltaDimensions] } },
      select: { dimensionKey: true, marketScope: true, retryMax: true },
    });
    const children: FlowJob[] = rows.map((row) => ({
      name: dimensionJobName(row.dimensionKey as DimensionKey),
      queueName: MARKETDATA_SYNC_QUEUE,
      data: {
        dimensionKey: row.dimensionKey as DimensionKey,
        mode: 'delta',
        asOf: marketDateFor(row.marketScope, input.now),
        triggeredBy: 'anchor-cold-start',
      } satisfies DimensionJobPayload,
      opts: {
        ...this.syncQueue.jobOpts({ retryMax: row.retryMax }),
        ...(row.dimensionKey === 'option_contract'
          ? { failParentOnFailure: true }
          : { ignoreDependencyOnFailure: true }),
      },
    }));

    const tree: FlowJob = {
      name: ANCHOR_COLD_START_JOB,
      queueName: MARKETDATA_SYNC_QUEUE,
      data: {
        ticker: input.ticker,
        anchorId: String(input.anchorId),
        phase: 'snapshot',
      } satisfies AnchorColdStartJobPayload,
      opts: this.syncQueue.jobOpts({ retryMax: ANCHOR_COLD_START_RETRY_MAX }),
      ...(children.length > 0 ? { children } : {}),
    };
    await this.syncQueue.enqueueFlow(tree);
    this.logger.log(
      `[anchor-cold-start] ${input.ticker} (${market}) 已组 flow: ` +
        `children=[${rows.map((r) => r.dimensionKey).join(', ')}] → parent=第二相快照`,
    );
  }

  /** `trading_day` 中**严格早于** `date` 的最大交易日; `null` = 缺行 (见 {@link lastClosedTradingDay})。 */
  private async tradingDayBefore(market: string, date: string): Promise<string | null> {
    const row = await this.prisma.tradingDay.findFirst({
      where: { market, date: { lt: new Date(`${date}T00:00:00Z`) } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return row === null ? null : row.date.toISOString().slice(0, 10);
  }

  /**
   * `trading_day` 中 ≤ 「已收盘 session 日期上界」的**最大交易日**。缺行返 `null`。
   *
   * ⚠️ **蓄意不走 `TRADING_CALENDAR_PORT`**, 尽管它就是交易日历的读端口 —— 它只有
   * `isTradingDay(market, date)` 一个方法, 拿它找「最近一个已收盘交易日」只能逐日回退着问,
   * 而 `DbTradingCalendarAdapter` 对**未 populate 的日历 fail-open 返 true** (那是它为「空表
   * 别让整条管线停摆」刻意选的方向)。⇒ 日历真缺行时它会**编出**一个交易日, 正是 FR-009
   * 「MUST NOT 猜测日期」禁的那件事。本查询要的是 fail-closed, 故直查自有表 —— 形态与
   * `option-snapshot-remediation.resolvePreviousTradingDay` /
   * `sync-option-snapshot.resolveOiSessionDate` 逐字同构 (marketdata 自有表, 非跨 ctx)。
   *
   * 复杂度: 1 次 (market, date) 主键索引上的倒序 limit-1 查询。
   */
  private async lastClosedTradingDay(market: string, now: Date): Promise<string | null> {
    const cutoff = lastClosedSessionCutoff(market, now);
    const row = await this.prisma.tradingDay.findFirst({
      where: { market, date: { lte: new Date(`${cutoff}T00:00:00Z`) } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return row === null ? null : row.date.toISOString().slice(0, 10);
  }

  /**
   * 兜底 seed 标的行, 返回其 id。判据**逐条照抄** `SyncOptionContractUseCase.
   * seedAnchoredInstruments`: `needSync` 落 **false** (受保护列, 重算的唯一权威是
   * `anchor-driven-sync-gate.ts`; 这里写 true 等于给它开第三个写入点), `name` 落 code 占位
   * (列 NOT NULL, universe 轮到该票时其 update 分支覆盖成真名)。
   *
   * 空 `update` 是纯兜底: 已有行的 name / syncTier / needSync 一个都不许被 seed 冲掉。
   */
  private async seedInstrument(market: string, code: string): Promise<bigint> {
    const existing = await this.prisma.instrument.findUnique({
      where: { market_code: { market, code } },
      select: { id: true },
    });
    if (existing !== null) return existing.id;

    const seeded = await this.prisma.instrument.upsert({
      where: { market_code: { market, code } },
      create: {
        market,
        code,
        name: code,
        type: 'stock',
        currency: currencyForMarket(market, code),
        status: 'active',
        needSync: false,
      },
      update: {},
      select: { id: true },
    });
    this.logger.warn(
      `[anchor-cold-start] 兜底 seed 标的行 (有锚但 Instrument 缺行, universe 未轮到?): ${market}:${code}`,
    );
    return seeded.id;
  }

  /**
   * 起手复判 (FR-016a): 判据是「**该标的在目标交易日**的数据是否已具备」, 查的是
   * `daily_bar` / `option_daily_snapshot` **本身**。
   *
   * 🚫 **MUST NOT 反过来读 `anchor_cold_start_run`**: 那张表是审计面 (plan §D7), 不是数据
   * 存在性的真相源。按「这只**锚**冷启动过没有」判, 今天与本判据等价, 但锚一旦按用户区分,
   * 同一标的的 N 只锚会各判「没做过」⇒ 同一份**标的级共享数据**被拉 N 遍。
   *
   * 逐档按能力登记表问, 不写死 us: 只在该市场真的会补那一档时才要求它在场。
   * 复杂度: ≤2 次 count (短路 —— 日线缺就不必再问快照)。
   */
  private async dataAlreadyPresent(
    market: string,
    instrumentId: bigint,
    targetSession: string,
  ): Promise<boolean> {
    const capability = COLD_START_CAPABILITY[market];
    const sessionDate = new Date(`${targetSession}T00:00:00Z`);

    const barPresent =
      capability.deltaDimensions.length === 0 ||
      (await this.prisma.dailyBar.count({
        where: { instrumentId, tradeDate: sessionDate },
      })) > 0;
    if (!barPresent) return false;

    return (
      !capability.optionSnapshot ||
      (await this.prisma.optionDailySnapshot.count({
        where: { sessionDate, contract: { underlyingInstrumentId: instrumentId } },
      })) > 0
    );
  }

  /**
   * 落运行记录并交回结局 (FR-026 / FR-026a / FR-027)。**每一条出口都过这里** —— 早退分支
   * 不留痕的话, 「未支持」与「故障」事后就再也分不开了。
   *
   * 覆盖式单行 upsert: FR-026 只要求保留**最近一次**。PK = `anchorId` 而非 ticker (plan §D5)。
   */
  private async finish(
    input: { anchorId: bigint; ticker: string; now: Date },
    outcome: ColdStartOutcome,
    extra: { reason?: string; targetSession?: string } = {},
  ): Promise<ColdStartResult> {
    const row = {
      ticker: input.ticker,
      lastRunAt: input.now,
      outcome,
      reason: extra.reason ?? null,
      targetSession:
        extra.targetSession === undefined ? null : new Date(`${extra.targetSession}T00:00:00Z`),
    };
    await this.prisma.anchorColdStartRun.upsert({
      where: { anchorId: input.anchorId },
      create: { anchorId: input.anchorId, ...row },
      update: row,
    });
    return { settled: true, outcome };
  }
}
