import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorDrivenSyncGate } from './anchor-driven-sync-gate.js';
import {
  COLD_START_CAPABILITY,
  COLD_START_OUTCOME,
  resolveSnapshotSpec,
} from './anchor-cold-start.rules.js';
import { AnchorColdStartUseCase } from './anchor-cold-start.usecase.js';
import type { PrismaService } from '../security/prisma.service.js';
import type { SyncOptionContractUseCase } from './sync-option-contract.usecase.js';
import type { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';
import type { SessionKindStatus, TradingDayStatus } from './trading-day.rules.js';

/** 北京周六 10:00 = ET 周五 22:00 (盘后, 非盘中)。与 rules spec 共用同一周固定日历。 */
const SATURDAY_1000_BEIJING = new Date('2026-08-15T10:00+08:00');
/** 北京周一 22:30 = ET 周一 10:30 —— **连续竞价进行中**。 */
const MONDAY_2230_BEIJING = new Date('2026-08-17T22:30+08:00');
/** 北京/香港 周一 12:30 —— 港交所的**午休正中**; hk 单段登记下它仍判「场内」。 */
const MONDAY_1230_HKT = new Date('2026-08-17T12:30+08:00');
/** 北京周二 02:30 = ET 周一 14:30 —— 常规日在场内, **半日市 (13:15 收) 则已收盘**。 */
const MONDAY_1430_ET = new Date('2026-08-17T14:30-04:00');

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
  /** 快照 `collect` 返 true = vendor 配额耗尽 (顺延信号)。 */
  budgetExhausted?: boolean;
  /** 链本体 `collect` 返 true = vendor 配额耗尽 (issue #159 起冷启动直调它)。 */
  chainBudgetExhausted?: boolean;
  /** 链本体抛错 —— 硬边语义: MUST 上抛给 BullMQ, MUST NOT 被吞成 `backfilled`。 */
  chainThrows?: boolean;
  /**
   * `TRADING_CALENDAR_PORT.classify` 对**今天**的答案 (周末 / 节假日 = `non-trading`)。
   * 062 T009 起三态**各走各的**: `trading` / `non-trading` 进 §D4 决策表, `unknown` 直接
   * 放弃并落 `calendar_missing` (写敏感档不猜口径, `state_branch` 7)。
   */
  todayCalendarStatus?: TradingDayStatus;
  /**
   * 交易所当地**今天**那一场的时长形态 (063 Phase 2)。缺省 `unknown` = 库里没这一行 / 源答
   * 不上来 ⇒ 消费侧回落常规收盘 = 本片上线前的逐点行为, 故既有用例逐条不变。
   */
  todaySessionKind?: SessionKindStatus;
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
  const tradingDayFindUnique = vi.fn(async (_args: unknown) => {
    calls.push('tradingDay.findUnique');
    // 库里没有该日的行 → null (与「今天不是交易日」同形) ⇒ use case 读成 `unknown`。
    return overrides.todaySessionKind === undefined
      ? null
      : { sessionKind: overrides.todaySessionKind };
  });
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
    tradingDay: { findFirst: tradingDayFindFirst, findUnique: tradingDayFindUnique },
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

  // issue #159: 冷启动直调链本体 (原先是组 flow 入维度 job)。返 true = vendor 配额耗尽。
  const chainCollect = vi.fn(async (_instruments: unknown, _spec: unknown, _stats: unknown) => {
    calls.push('chain.collect');
    if (overrides.chainThrows === true) throw new Error('chain boom');
    return overrides.chainBudgetExhausted === true;
  });
  const chain = { collect: chainCollect } as unknown as SyncOptionContractUseCase;

  const collect = vi.fn(async (_instruments: unknown, _spec: unknown, _stats: unknown) => {
    calls.push('snapshot.collect');
    collected = true;
    return overrides.budgetExhausted === true;
  });
  const snapshot = { collect } as unknown as SyncOptionSnapshotUseCase;

  const classify = vi.fn(async () => overrides.todayCalendarStatus ?? 'trading');
  const calendar = { classify } as unknown as TradingCalendarPort;

  return {
    usecase: new AnchorColdStartUseCase(prisma, gate, chain, snapshot, calendar),
    calls,
    tradingDayFindFirst,
    instrumentFindUnique,
    instrumentUpsert,
    runUpsert,
    recalcSafely,
    dailyBarCount,
    snapshotCount,
    syncDimensionFindMany,
    chainCollect,
    collect,
    classify,
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
    expect(ctx.chainCollect).not.toHaveBeenCalled();
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
    expect(local.chainCollect).not.toHaveBeenCalled();
    const row = recordedRow(local.runUpsert);
    expect(row.outcome).toBe(COLD_START_OUTCOME.CALENDAR_MISSING);
    expect(row.targetSession).toBeNull();
  });
});

describe('AnchorColdStartUseCase 前置顺序与起手复判', () => {
  it('目标交易日的快照已在 ⇒ already_present, 零外呼 (链与快照都不碰)', async () => {
    const ctx = build({ snapshotRows: 2150 });
    const result = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'us:PEP',
      now: SATURDAY_1000_BEIJING,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.ALREADY_PRESENT });
    expect(ctx.chainCollect).not.toHaveBeenCalled();
    expect(ctx.collect).not.toHaveBeenCalled();
    const row = recordedRow(ctx.runUpsert);
    expect(row.targetSession).toEqual(TARGET_DATE);
  });

  it('🚨 复判查的是 option_daily_snapshot 本身, **不读** anchor_cold_start_run', async () => {
    const ctx = build({ snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    // 🚫 issue #159 起**不再查 daily_bar**: 日线已不是冷启动的职责 (建锚时 seedLastClose
    //    已取过), 拿它当闸只会让「日线恰好没落上」误挡住真正要补的快照。
    expect(ctx.dailyBarCount).not.toHaveBeenCalled();
    expect(ctx.snapshotCount.mock.calls[0][0]).toMatchObject({
      where: { sessionDate: TARGET_DATE, contract: { underlyingInstrumentId: INSTRUMENT_ID } },
    });
    // 运行记录只被**写**一次、一次都没被读 —— 它是审计面不是判据 (plan §D5 那张表左列)。
    expect(ctx.runUpsert).toHaveBeenCalledTimes(1);
  });

  it('🚨 D9 顺序: 定日历 → seed → 开闸 → 复判 (反了会静默拿到空数据)', async () => {
    const ctx = build({ snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    expect(ctx.calls.filter((c) => c !== 'anchorColdStartRun.upsert')).toEqual([
      // 063 Phase 2: 半日市 kind 排在**定日历之前** —— 定目标日要用它算收盘时刻,
      // 顺序反了的话目标日就是按常规收盘算出来的那个 (半日市当天差一场)。
      'tradingDay.findUnique',
      'tradingDay.findFirst',
      'instrument.findUnique',
      'instrument.upsert',
      'gate.recalcSafely',
      'optionDailySnapshot.count',
    ]);
  });

  it('Instrument 行已在 ⇒ 不 seed, 直接用既有 id (空 update 也不发)', async () => {
    const ctx = build({ instrumentExists: true, snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    expect(ctx.instrumentUpsert).not.toHaveBeenCalled();
  });

  it('🚨 seed 落 needSync=false —— needSync 的重算权威只有采集闸, 不给它开第三个写入点', async () => {
    const ctx = build({ snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    const args = ctx.instrumentUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(args.create).toMatchObject({ market: 'us', code: 'PEP', name: 'PEP', needSync: false });
    expect(args.update).toEqual({});
  });
});

describe('不敏感档 —— 直调链本体 (issue #159, FR-012)', () => {
  const RUN = { anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING };

  it('🚨 只把**这一只**锚传进链本体 —— 不再入维度 job (那会拉上全部已开闸标的)', async () => {
    const ctx = build({ snapshotRowsAfterCollect: 2150 });
    await ctx.usecase.run(RUN);

    // 这条断言就是 54× 放大的解药: 传进去的必须**恰好一只**, 且就是本锚那只。
    expect(ctx.chainCollect).toHaveBeenCalledTimes(1);
    const [instruments] = ctx.chainCollect.mock.calls[0] as [unknown[], unknown, unknown];
    expect(instruments).toEqual([{ id: INSTRUMENT_ID, market: 'us', code: 'PEP' }]);
  });

  it('🚨 一次调用跑完两档 —— 链在前快照在后, 不再有 awaiting_chain 中断', async () => {
    const ctx = build({ snapshotRowsAfterCollect: 2150 });

    const result = await ctx.usecase.run(RUN);

    // 两相合一 (原先第一相组完 flow 就 return, 第二相靠 BullMQ parent 语义另跑一遍)。
    // 顺序**必须**是链在前 —— 反了的话快照拿到的是空合约表, 零外呼还照样落 backfilled。
    expect(ctx.calls.filter((c) => c === 'chain.collect' || c === 'snapshot.collect')).toEqual([
      'chain.collect',
      'snapshot.collect',
    ]);
    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });
  });

  /**
   * 🚨 **#103 的验收面在这里换了形态但没丢** (2026-08-19 prod 实证 → 063 Phase 1 修)。
   *
   * 原先两个 child 各自按维度声明求 `asOf`：`us_equity_bar` 是收盘口径 (退到上一场, 防拉半根
   * 未收盘的 K)、`option_contract` 是 `calendar-day` 口径 (取 ET 当日)。日线移出本流程后,
   * 只剩链这一档要盯 —— 而它**恰恰是不能退**的那个: 业务日在链里只用来剔除已过期的到期日
   * (FR-028a 判据 `≥`), 退一天会把**当日到期**的合约整批漏采。
   */
  it('🚨 链的 businessDate 取 ET 当日 —— 退一天会漏采当日到期的合约 (FR-028a)', async () => {
    // 2026-08-19 00:13 北京 = ET 2026-08-18(二) 12:13, 美股连续竞价进行中。
    const ctx = build({ snapshotRowsAfterCollect: 2150 });

    await ctx.usecase.run({ ...RUN, now: new Date('2026-08-19T00:13+08:00') });

    const [, spec] = ctx.chainCollect.mock.calls[0] as [unknown, { businessDate: string }, unknown];
    expect(spec.businessDate).toBe('2026-08-18');
  });

  it('🚨🚨 链抛错 MUST 上抛 —— 吞掉它就会落一个 `backfilled` 的谎', async () => {
    const ctx = build({ chainThrows: true });

    await expect(ctx.usecase.run(RUN)).rejects.toThrow(/chain boom/);

    // 硬边语义 (原先由 flow child 的 `failParentOnFailure` 表达, 现在靠「不 catch」):
    // 没有链就没有合约行 ⇒ 快照跑起来只会零外呼 ⇒ 必须让整个 job 失败, 交 BullMQ 重试,
    // attempts 耗尽后由 job 层落 `retry_exhausted` (FR-019a)。
    expect(ctx.collect).not.toHaveBeenCalled();
    expect(ctx.runUpsert).not.toHaveBeenCalled();
  });

  it('链配额耗尽 ⇒ vendor_budget 顺延, 不碰快照也不落运行记录', async () => {
    const ctx = build({ chainBudgetExhausted: true });

    const result = await ctx.usecase.run(RUN);

    expect(result).toEqual({ settled: false, deferral: 'vendor_budget' });
    // 🚫 链没采全就去抓快照 = 拿着残缺工作集问 vendor; 顺延 ≠ 失败, 故也不落结局行。
    expect(ctx.collect).not.toHaveBeenCalled();
    expect(ctx.runUpsert).not.toHaveBeenCalled();
  });

  it('🚫 日线全程不参与 —— 建锚那一刻 seedLastClose 已取过 (原 child 是重复劳动)', async () => {
    const ctx = build({ snapshotRowsAfterCollect: 2150 });

    await ctx.usecase.run(RUN);

    // 结构性断言: 冷启动对 daily_bar **零读零写**。`optionsdesk.anchor` 全仓只有一个 create
    // 点, 而它的 seedLastClose 同步调过 EnsureLatestEodBarUseCase ⇒ 每只锚出生即有日线。
    expect(ctx.dailyBarCount).not.toHaveBeenCalled();
    expect(ctx.calls.some((c) => c.startsWith('dailyBar'))).toBe(false);
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

  it('🚨🚨 半日市当天收盘后 (ET 14:30) ⇒ **不再**判 intraday_skipped, 照常写快照 (063 Phase 2)', async () => {
    // 这是 Phase 2 唯一**不可自愈**的收益点: `intraday_skipped` 是终态不重试, 一旦落了它,
    // 那一场的快照就永久缺失 (常规轮当晚写的是当晚那一场, 不回补)。半日市 13:15 就收了,
    // 而常规收盘表说 16:00 ⇒ 上线前 13:15–16:00 建的锚全部落进这个永久缺口。
    const ctx = build({ todaySessionKind: 'half', snapshotRowsAfterCollect: 1 });
    await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: MONDAY_1430_ET });

    expect(recordedRow(ctx.runUpsert).outcome).not.toBe(COLD_START_OUTCOME.INTRADAY_SKIPPED);
    expect(ctx.collect).toHaveBeenCalledTimes(1);
  });

  it('🚨 同一时刻若 kind 是 whole / unknown ⇒ 仍判 intraday_skipped (回落常规收盘)', async () => {
    // 对照组: 证明上一条的差别**只**来自 kind。unknown 走的是本片上线前的逐点行为。
    for (const kind of ['whole', 'unknown'] as const) {
      const ctx = build({ todaySessionKind: kind });
      const result = await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: MONDAY_1430_ET });

      expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED });
      expect(ctx.collect).not.toHaveBeenCalled();
    }
  });

  it('🚨 周末白天 (ET 场内钟点 + 当天非交易日) ⇒ **仍写快照**, MUST NOT 判 intraday_skipped', async () => {
    // 北京周日 00:00 = ET 周六 12:00 —— 钟点落在 09:30–16:00 内, 但那天根本没有场。
    // 境内用户周末夜里做研究建锚正是这个时段, 判成盘中会让快照**永久**缺失
    // (intraday_skipped 是终态不重试; 常规轮周一晚写的是周一的数据, 不回补周五)。
    const ctx = build({ todayCalendarStatus: 'non-trading', snapshotRowsAfterCollect: 1 });
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
    const ctx = build({ todayCalendarStatus: 'trading' });
    const result = await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: MONDAY_2230_BEIJING });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED });
    expect(ctx.collect).not.toHaveBeenCalled();
  });

  it('🚨 062 T009: 日历 `unknown` ⇒ 放弃并落 calendar_missing, MUST NOT 猜口径 (state_branch 7)', async () => {
    // 写敏感档这一格**不能**沿用盘中采集闸的「不知道就照跑」: 猜「是交易日」落
    // `premarket_backfill` + OI 归属被补那场, 猜「不是」落 `eod` + OI 再往前一场 ——
    // 差一整天的持仓量归属, 且**不报错**, 事后要人工回删。
    //
    // 时钟蓄意停在**盘中**: 结局仍须是 `calendar_missing` 而不是 `intraday_skipped` ——
    // 后者是「一切正常」的一档, 折进去等于把该被人看见的事藏起来 (FR-027 零折叠)。
    const ctx = build({ todayCalendarStatus: 'unknown' });
    const result = await ctx.usecase.run({ ...SNAPSHOT_PHASE, now: MONDAY_2230_BEIJING });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.CALENDAR_MISSING });
    expect(ctx.collect).not.toHaveBeenCalled();
    // 目标日已定位到 ⇒ 仍落痕, 人工介入时第一手信息不丢。
    expect(recordedRow(ctx.runUpsert).targetSession).toEqual(new Date(`${TARGET}T00:00:00Z`));
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
 * 🚨 **本档钉的是 FR-011 的结果, 不是某个谓词的实现**: 无论 hk 登记成两段还是单段 (2026-08-18
 * 起为单段, 见 `market-session.rules.ts` hk 登记处), 午休都 MUST 判「该场未收」⇒ 不写快照。
 *
 * 它今天端到端不可达 —— 唯一开通期权采集的 us 真的无午休, 而 hk 在 `COLD_START_CAPABILITY`
 * 里是空表项、走到就提前返回。故在此**临时开通 hk**把这一格逼出来: 哪天真给一个有午休的市场
 * 开通期权采集, 这条守卫已经在了, 而那种错行**不报错**。
 */
describe('第二相 —— 午休档 (FR-011, 今天端到端不可达)', () => {
  const original = COLD_START_CAPABILITY.hk;

  beforeEach(() => {
    // deltaDimensions 留空 ⇒ 第一相无 flow 可组, 直接落到敏感档, 正好把这一格暴露出来。
    COLD_START_CAPABILITY.hk = { optionChain: false, optionSnapshot: true };
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
