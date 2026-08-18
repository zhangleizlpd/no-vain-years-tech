import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowJob } from 'bullmq';
import type { AnchorDrivenSyncGate } from './anchor-driven-sync-gate.js';
import {
  COLD_START_CAPABILITY,
  COLD_START_OUTCOME,
  resolveSnapshotSpec,
} from './anchor-cold-start.rules.js';
import { AnchorColdStartUseCase } from './anchor-cold-start.usecase.js';
import type { MarketdataSyncQueue } from './marketdata-sync.queue.js';
import type { PrismaService } from '../security/prisma.service.js';
import type { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';

/** 北京周六 10:00 = ET 周五 22:00 (盘后, 非盘中)。与 rules spec 共用同一周固定日历。 */
const SATURDAY_1000_BEIJING = new Date('2026-08-15T10:00+08:00');
/** 北京周一 22:30 = ET 周一 10:30 —— **连续竞价进行中**。 */
const MONDAY_2230_BEIJING = new Date('2026-08-17T22:30+08:00');
/** 北京/香港 周一 12:30 —— hk 的**午休正中** (两个谓词唯一分道的那一格)。 */
const MONDAY_1230_HKT = new Date('2026-08-17T12:30+08:00');

const TARGET = '2026-08-14';
const TARGET_DATE = new Date(`${TARGET}T00:00:00Z`);
const DAY_BEFORE_TARGET = '2026-08-13';

const ANCHOR_ID = 42n;
const INSTRUMENT_ID = 7n;

interface Overrides {
  tradingDay?: string | null;
  instrumentExists?: boolean;
  barRows?: number;
  snapshotRows?: number;
  /**
   * `collect` **之后**快照表的行数 (FR-027a 落库复判读的就是它)。缺省 = 与 {@link snapshotRows}
   * 同值, 即「采集没让库里多出任何东西」—— 那正是链零结果时的真实形态。
   */
  snapshotRowsAfterCollect?: number;
  /** `collect` 返 true = vendor 配额耗尽 (顺延信号)。 */
  budgetExhausted?: boolean;
  /** `TRADING_CALENDAR_PORT.isTradingDay` 对**今天**的答案 (周末 / 节假日 = false)。 */
  todayIsTradingDay?: boolean;
}

function build(overrides: Overrides = {}) {
  const calls: string[] = [];

  const tradingDayFindFirst = vi.fn(
    async (args: { where: { date: { lte?: Date; lt?: Date } } }) => {
      calls.push('tradingDay.findFirst');
      // `lte` = 定目标交易日; `lt` = 求目标日的上一交易日 (D4 第三列)。
      if (args.where.date.lt !== undefined) {
        return { date: new Date(`${DAY_BEFORE_TARGET}T00:00:00Z`) };
      }
      const date = overrides.tradingDay === undefined ? TARGET : overrides.tradingDay;
      return date === null ? null : { date: new Date(`${date}T00:00:00Z`) };
    },
  );
  const instrumentFindUnique = vi.fn(async (_args: unknown) => {
    calls.push('instrument.findUnique');
    return overrides.instrumentExists === true ? { id: INSTRUMENT_ID } : null;
  });
  const instrumentUpsert = vi.fn(async (_args: unknown) => {
    calls.push('instrument.upsert');
    return { id: INSTRUMENT_ID };
  });
  const runUpsert = vi.fn(async (_args: unknown) => {
    calls.push('anchorColdStartRun.upsert');
    return {};
  });
  const dailyBarCount = vi.fn(async (_args: unknown) => {
    calls.push('dailyBar.count');
    return overrides.barRows ?? 0;
  });
  // collect 跑没跑过, 决定 snapshotCount 该答「起手复判」还是「落库复判」那一问 ——
  // 同一个 prisma 方法被前后各调一次, 两次的正确答案本就可以不同 (采集写了行)。
  let collected = false;
  const snapshotCount = vi.fn(async (_args: unknown) => {
    calls.push('optionDailySnapshot.count');
    if (collected) return overrides.snapshotRowsAfterCollect ?? overrides.snapshotRows ?? 0;
    return overrides.snapshotRows ?? 0;
  });
  const syncDimensionFindMany = vi.fn(async (_args: unknown) => {
    calls.push('syncDimension.findMany');
    return [
      { dimensionKey: 'option_contract', marketScope: ['us'], retryMax: 5 },
      { dimensionKey: 'us_equity_bar', marketScope: ['us'], retryMax: 2 },
    ];
  });

  const prisma = {
    tradingDay: { findFirst: tradingDayFindFirst },
    instrument: { findUnique: instrumentFindUnique, upsert: instrumentUpsert },
    anchorColdStartRun: { upsert: runUpsert },
    dailyBar: { count: dailyBarCount },
    optionDailySnapshot: { count: snapshotCount },
    syncDimension: { findMany: syncDimensionFindMany },
  } as unknown as PrismaService;

  const recalcSafely = vi.fn(async () => {
    calls.push('gate.recalcSafely');
    return { opened: 1, closed: 0 };
  });
  const gate = { recalcSafely } as unknown as AnchorDrivenSyncGate;

  const enqueueFlow = vi.fn(async (_tree: FlowJob) => ({}) as never);
  const jobOpts = vi.fn((o: { retryMax: number }) => ({ attempts: o.retryMax }));
  const syncQueue = { enqueueFlow, jobOpts } as unknown as MarketdataSyncQueue;

  const collect = vi.fn(async (_instruments: unknown, _spec: unknown, _stats: unknown) => {
    calls.push('snapshot.collect');
    collected = true;
    return overrides.budgetExhausted === true;
  });
  const snapshot = { collect } as unknown as SyncOptionSnapshotUseCase;

  const isTradingDay = vi.fn(async () => overrides.todayIsTradingDay ?? true);
  const calendar = { isTradingDay } as unknown as TradingCalendarPort;

  return {
    usecase: new AnchorColdStartUseCase(prisma, gate, syncQueue, snapshot, calendar),
    calls,
    tradingDayFindFirst,
    instrumentFindUnique,
    instrumentUpsert,
    runUpsert,
    recalcSafely,
    dailyBarCount,
    snapshotCount,
    syncDimensionFindMany,
    enqueueFlow,
    jobOpts,
    collect,
    isTradingDay,
  };
}

/** 取写进运行记录的那一行 (create 与 update 两侧同值, 断言 create 侧即可)。 */
function recordedRow(runUpsert: ReturnType<typeof build>['runUpsert']) {
  expect(runUpsert).toHaveBeenCalledTimes(1);
  return (runUpsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
}

describe('AnchorColdStartUseCase 早退分支 —— 各自结局 + 零外呼', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  /** 三条「够不到日历」的早退共有的断言: 一个下游都没碰。 */
  function expectNothingDownstream() {
    expect(ctx.tradingDayFindFirst).not.toHaveBeenCalled();
    expect(ctx.instrumentFindUnique).not.toHaveBeenCalled();
    expect(ctx.instrumentUpsert).not.toHaveBeenCalled();
    expect(ctx.recalcSafely).not.toHaveBeenCalled();
    expect(ctx.dailyBarCount).not.toHaveBeenCalled();
    expect(ctx.snapshotCount).not.toHaveBeenCalled();
    expect(ctx.enqueueFlow).not.toHaveBeenCalled();
    expect(ctx.collect).not.toHaveBeenCalled();
  }

  it('ticker 不可解析 ⇒ ticker_unresolved, 不猜市场 (FR-021)', async () => {
    const result = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'AAPL', // 无冒号 ⇒ 解析不出 market
      now: SATURDAY_1000_BEIJING,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.TICKER_UNRESOLVED });
    expectNothingDownstream();
    expect(recordedRow(ctx.runUpsert)).toMatchObject({
      ticker: 'AAPL',
      outcome: COLD_START_OUTCOME.TICKER_UNRESOLVED,
      targetSession: null,
    });
  });

  it('市场未登记交易时段 ⇒ session_unregistered, 不套用别的市场时窗 (FR-022)', async () => {
    const result = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'sg:D05', // sg 不在 MARKET_SESSION
      now: SATURDAY_1000_BEIJING,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.SESSION_UNREGISTERED });
    expectNothingDownstream();
  });

  it('市场未开通期权采集 (hk 空表项) ⇒ market_not_enabled, 显式 no-op 非错误 (FR-023)', async () => {
    const result = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'hk:00700',
      now: SATURDAY_1000_BEIJING,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.MARKET_NOT_ENABLED });
    expectNothingDownstream();
  });

  it('市场压根不在能力登记表 (cn) ⇒ 同样 market_not_enabled, 不静默', async () => {
    const result = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'cn:600519',
      now: SATURDAY_1000_BEIJING,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.MARKET_NOT_ENABLED });
    expectNothingDownstream();
  });

  it('日历缺行 ⇒ calendar_missing, 且在 seed / 开闸**之前**放弃 (FR-009 不落任何数据行)', async () => {
    const local = build({ tradingDay: null });
    const result = await local.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'us:PEP',
      now: SATURDAY_1000_BEIJING,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.CALENDAR_MISSING });
    expect(local.tradingDayFindFirst).toHaveBeenCalledTimes(1);
    // 🚨 放弃必须早于 seed 与开闸 —— 定不到目标日就动库, 正是 FR-009 禁的「落数据行」。
    expect(local.instrumentFindUnique).not.toHaveBeenCalled();
    expect(local.recalcSafely).not.toHaveBeenCalled();
    expect(local.enqueueFlow).not.toHaveBeenCalled();
    const row = recordedRow(local.runUpsert);
    expect(row.outcome).toBe(COLD_START_OUTCOME.CALENDAR_MISSING);
    expect(row.targetSession).toBeNull();
  });
});

describe('AnchorColdStartUseCase 前置顺序与起手复判', () => {
  it('目标交易日的日线 + 快照都在 ⇒ already_present, 零外呼且不组 flow', async () => {
    const ctx = build({ barRows: 1, snapshotRows: 2150 });
    const result = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'us:PEP',
      now: SATURDAY_1000_BEIJING,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.ALREADY_PRESENT });
    expect(ctx.enqueueFlow).not.toHaveBeenCalled();
    expect(ctx.collect).not.toHaveBeenCalled();
    const row = recordedRow(ctx.runUpsert);
    expect(row.targetSession).toEqual(TARGET_DATE);
  });

  it('🚨 复判查的是 daily_bar / option_daily_snapshot 本身, **不读** anchor_cold_start_run', async () => {
    const ctx = build({ barRows: 1, snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    expect(ctx.dailyBarCount.mock.calls[0][0]).toMatchObject({
      where: { instrumentId: INSTRUMENT_ID, tradeDate: TARGET_DATE },
    });
    expect(ctx.snapshotCount.mock.calls[0][0]).toMatchObject({
      where: { sessionDate: TARGET_DATE, contract: { underlyingInstrumentId: INSTRUMENT_ID } },
    });
    // 运行记录只被**写**一次、一次都没被读 —— 它是审计面不是判据 (plan §D5 那张表左列)。
    expect(ctx.runUpsert).toHaveBeenCalledTimes(1);
  });

  it('🚨 D9 顺序: 定日历 → seed → 开闸 → 复判 (反了会静默拿到空工作集)', async () => {
    const ctx = build({ barRows: 1, snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    expect(ctx.calls.filter((c) => c !== 'anchorColdStartRun.upsert')).toEqual([
      'tradingDay.findFirst',
      'instrument.findUnique',
      'instrument.upsert',
      'gate.recalcSafely',
      'dailyBar.count',
      'optionDailySnapshot.count',
    ]);
  });

  it('Instrument 行已在 ⇒ 不 seed, 直接用既有 id (空 update 也不发)', async () => {
    const ctx = build({ instrumentExists: true, barRows: 1, snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    expect(ctx.instrumentUpsert).not.toHaveBeenCalled();
  });

  it('🚨 seed 落 needSync=false —— needSync 的重算权威只有采集闸, 不给它开第三个写入点', async () => {
    const ctx = build({ barRows: 1, snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    const args = ctx.instrumentUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(args.create).toMatchObject({ market: 'us', code: 'PEP', name: 'PEP', needSync: false });
    expect(args.update).toEqual({});
  });

  it('日线缺 ⇒ 短路, 连快照都不必问 (少一次 count)', async () => {
    const ctx = build({ barRows: 0, snapshotRows: 2150 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });
    expect(ctx.snapshotCount).not.toHaveBeenCalled();
  });
});

describe('第一相 —— 不敏感档组 flow (plan §D8, FR-012 / FR-012a)', () => {
  /** 取第一相实际入队的那棵树。 */
  function enqueuedTree(ctx: ReturnType<typeof build>): FlowJob {
    expect(ctx.enqueueFlow).toHaveBeenCalledTimes(1);
    return ctx.enqueueFlow.mock.calls[0][0];
  }

  it('数据缺 ⇒ 组 flow 并交回 awaiting_chain, **此时不落运行记录**', async () => {
    const ctx = build();
    const result = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'us:PEP',
      now: SATURDAY_1000_BEIJING,
    });

    expect(result).toEqual({ settled: false, deferral: 'awaiting_chain' });
    // 两相加起来才是一次冷启动 —— 中途写一行会让「最近一次的结局」在窗口期内是错的。
    expect(ctx.runUpsert).not.toHaveBeenCalled();
    // 第一相**不碰快照**: 它的合约表还是空的, 此刻抓只会 WARN 零外呼。
    expect(ctx.collect).not.toHaveBeenCalled();
  });

  it('🚨 parent 是本 job 的第二相 —— 快照排在链/日线之后, 这是 SC-001 的承重点', async () => {
    const ctx = build();
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    const tree = enqueuedTree(ctx);
    expect(tree.name).toBe('sync:anchor-cold-start');
    expect(tree.data).toEqual({ ticker: 'us:PEP', anchorId: '42', phase: 'snapshot' });
    expect(tree.children?.map((c) => c.name)).toEqual([
      'sync:option_contract',
      'sync:us_equity_bar',
    ]);
  });

  it('🚨 每个 child 都显式给了传播 opts —— 裸 child 会让 parent 永久卡 waiting-children', async () => {
    const ctx = build();
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    const [chain, bar] = enqueuedTree(ctx).children ?? [];
    // 链是 **hard**: 没有合约行, 第二相跑起来只会零外呼然后落一个 backfilled 的谎。
    expect(chain.opts).toMatchObject({ attempts: 5, failParentOnFailure: true });
    // 日线是 **soft**: 与快照互不依赖, 挂了不该连累它。
    expect(bar.opts).toMatchObject({ attempts: 2, ignoreDependencyOnFailure: true });
    expect(chain.opts).not.toHaveProperty('ignoreDependencyOnFailure');
    expect(bar.opts).not.toHaveProperty('failParentOnFailure');
  });

  it('🚨 delta job 的 asOf 按各维度自己的 marketScope 求 (FR-012a: 不设冷启动专属目标日)', async () => {
    const ctx = build();
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    for (const child of enqueuedTree(ctx).children ?? []) {
      // 北京周六 10:00 = ET 周五 ⇒ us 维度的业务日是 08-14, **不是**宿主的 08-15。
      expect(child.data).toMatchObject({
        mode: 'delta',
        asOf: TARGET,
        triggeredBy: 'anchor-cold-start',
      });
      expect(child.data).not.toHaveProperty('codes');
    }
  });
});

describe('第二相 —— 敏感档快照 (plan §D8, FR-010 / FR-011 / FR-014 / FR-018)', () => {
  const SNAPSHOT_PHASE = { anchorId: ANCHOR_ID, ticker: 'us:PEP', phase: 'snapshot' } as const;

  it('非盘中 ⇒ collect 收到的 spec **原样**来自 T003 纯函数 (不在这里重算, FR-014)', async () => {
    // `snapshotRowsAfterCollect: 1` = 采集真落了行 ⇒ 落库复判过 (FR-027a); 缺省的「零行」
    // 会落 backfill_incomplete, 那是另一条用例。
    const ctx = build({ snapshotRowsAfterCollect: 1 });
    const now = SATURDAY_1000_BEIJING;
    const result = await ctx.usecase.run({ ...SNAPSHOT_PHASE, now });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });
    const [instruments, spec] = ctx.collect.mock.calls[0];
    expect(instruments).toEqual([{ id: INSTRUMENT_ID, market: 'us', code: 'PEP' }]);

    const expected = resolveSnapshotSpec({
      market: 'us',
      now,
      lastClosedTradingDay: TARGET,
      todayIsTradingDay: true,
      tradingDayBeforeTarget: DAY_BEFORE_TARGET,
    });
    if (expected.decision !== 'collect') throw new Error('unreachable');
    expect(spec).toEqual(expected.spec);
    // `now` 是**同一个 Date 实例**穿过去的 —— 谁在这里重新 new 一个, 这条立刻红。
    expect((spec as { now: Date }).now).toBe(now);
  });

  it('🚨 盘中 ⇒ intraday_skipped 且 collect 零调用 (SC-002: 未收盘交易日的快照行恒为 0)', async () => {
    const ctx = build();
    const result = await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: MONDAY_2230_BEIJING });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED });
    expect(ctx.collect).not.toHaveBeenCalled();
    expect(recordedRow(ctx.runUpsert).outcome).toBe(COLD_START_OUTCOME.INTRADAY_SKIPPED);
  });

  it('🚨 周末白天 (ET 场内钟点 + 当天非交易日) ⇒ **仍写快照**, MUST NOT 判 intraday_skipped', async () => {
    // 北京周日 00:00 = ET 周六 12:00 —— 钟点落在 09:30–16:00 内, 但那天根本没有场。
    // 境内用户周末夜里做研究建锚正是这个时段, 判成盘中会让快照**永久**缺失
    // (intraday_skipped 是终态不重试; 常规轮周一晚写的是周一的数据, 不回补周五)。
    const ctx = build({ todayIsTradingDay: false, snapshotRowsAfterCollect: 1 });
    const result = await ctx.usecase.run({
      ...SNAPSHOT_PHASE,
      now: new Date('2026-08-15T16:00:00Z'),
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });
    expect(ctx.collect).toHaveBeenCalledTimes(1);
    // 归属口径按 §D4 第四行: 周末 ⇒ 仍是 eod, MUST NOT 误判成盘前兜底。
    expect((ctx.collect.mock.calls[0][1] as { mode: string }).mode).toBe('eod');
  });

  it('交易日的场内钟点仍判进行中 (回归: 修周末档 MUST NOT 顺手把真盘中放行)', async () => {
    const ctx = build({ todayIsTradingDay: true });
    const result = await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: MONDAY_2230_BEIJING });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED });
    expect(ctx.collect).not.toHaveBeenCalled();
  });

  it('🚨 采集跑完但快照仍不在库 ⇒ backfill_incomplete, MUST NOT 记成 backfilled (FR-027a)', async () => {
    // 链 child **成功完成但零结果** 时的真实形态: collect 照常返回 (非配额耗尽), 而库里
    // 一行都没多出来。2026-08-17 本地真跑实撞 —— 13 只票链全失败、job 却 completed。
    const ctx = build({ snapshotRowsAfterCollect: 0 });

    const result = await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: SATURDAY_1000_BEIJING });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILL_INCOMPLETE });
    expect(ctx.collect).toHaveBeenCalledTimes(1);
    const row = recordedRow(ctx.runUpsert);
    expect(row.outcome).toBe(COLD_START_OUTCOME.BACKFILL_INCOMPLETE);
    // 目标日仍要落 —— 「补哪一天没补上」是人工介入的第一手信息。
    expect(row.targetSession).toEqual(new Date(`${TARGET}T00:00:00Z`));
    expect(row.reason).toContain(TARGET);
  });

  it('🚨 落库复判与起手复判问的是**同一个问题** (同一处判据, 两个调用点)', async () => {
    // ⚠️ `barRows: 1` 是必需的: 起手复判先问日线, 缺日线就**短路**在那一格、根本问不到快照
    //    (于是只剩落库复判一次调用)。要看到「同一个问题被问两遍」, 得让它走完整条。
    const ctx = build({ barRows: 1, snapshotRows: 0, snapshotRowsAfterCollect: 3 });

    await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: SATURDAY_1000_BEIJING });

    // 第二相里 optionDailySnapshot.count 被调两次: 采集前 (起手复判) + 采集后 (落库复判),
    // 且两次的 where 逐字相同 —— 口径漂了这条立刻红。
    const snapshotWheres = ctx.snapshotCount.mock.calls.map((c) => c[0]);
    expect(snapshotWheres.length).toBe(2);
    expect(snapshotWheres[0]).toEqual(snapshotWheres[1]);
    expect(snapshotWheres[0]).toMatchObject({
      where: {
        sessionDate: new Date(`${TARGET}T00:00:00Z`),
        contract: { underlyingInstrumentId: INSTRUMENT_ID },
      },
    });
  });

  it('配额耗尽走顺延, MUST NOT 被落库复判改判成 backfill_incomplete (顺延 ≠ 没补上)', async () => {
    // 配额耗尽时库里同样没有新行, 但那是「还没做完」不是「做了没成」—— 两者处置相反
    // (前者重入队, 后者要人工看)。谁把落库复判放到配额分支之前, 这条立刻红。
    const ctx = build({ budgetExhausted: true, snapshotRowsAfterCollect: 0 });

    const result = await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: SATURDAY_1000_BEIJING });

    expect(result).toEqual({ settled: false, deferral: 'vendor_budget' });
    expect(ctx.runUpsert).not.toHaveBeenCalled();
  });

  it('配额耗尽 ⇒ 交回 vendor_budget 顺延, **不**落 retry_exhausted、也不落 backfilled', async () => {
    const ctx = build({ budgetExhausted: true });
    const result = await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: SATURDAY_1000_BEIJING });

    expect(result).toEqual({ settled: false, deferral: 'vendor_budget' });
    // 顺延 ≠ 失败 (FR-018 / FR-019b): 一行运行记录都不该写。
    expect(ctx.runUpsert).not.toHaveBeenCalled();
  });
});

/**
 * 🚨 **午休是两个谓词唯一分道的一格**, 而它今天端到端不可达: 唯一开通期权采集的 us 无午休,
 * 带午休的 hk 在 `COLD_START_CAPABILITY` 里是空表项、走到就提前返回。故在此**临时开通 hk**
 * 把这一格逼出来 —— 这不是给未来加设计, 是让「接 hk 期权那天才显形」的坑现在就有守卫。
 */
describe('第二相 —— 午休档 (FR-011, 今天潜伏)', () => {
  const original = COLD_START_CAPABILITY.hk;

  beforeEach(() => {
    // deltaDimensions 留空 ⇒ 第一相无 flow 可组, 直接落到敏感档, 正好把这一格暴露出来。
    COLD_START_CAPABILITY.hk = { deltaDimensions: [], optionSnapshot: true };
  });
  afterEach(() => {
    COLD_START_CAPABILITY.hk = original;
  });

  it('🚨 午休 ⇒ 同样 intraday_skipped、collect 零调用 (该场尚未收盘)', async () => {
    const ctx = build();
    const result = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'hk:00700',
      now: MONDAY_1230_HKT,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED });
    expect(ctx.collect).not.toHaveBeenCalled();
  });

  it('午休结束后 (13:30 HKT 仍在场内) 也判进行中 —— 闸问的是「这一场收了没有」', async () => {
    const ctx = build();
    const result = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'hk:00700',
      now: new Date('2026-08-17T13:30+08:00'),
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED });
    expect(ctx.collect).not.toHaveBeenCalled();
  });
});
