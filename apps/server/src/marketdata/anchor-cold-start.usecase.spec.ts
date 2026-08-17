import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorDrivenSyncGate } from './anchor-driven-sync-gate.js';
import { COLD_START_OUTCOME } from './anchor-cold-start.rules.js';
import { AnchorColdStartUseCase } from './anchor-cold-start.usecase.js';
import type { PrismaService } from '../security/prisma.service.js';

/** 北京周六 10:00 = ET 周五 22:00 盘后 (与 rules spec 同一周固定日历)。 */
const SATURDAY_1000_BEIJING = new Date('2026-08-15T10:00+08:00');
const TARGET = '2026-08-14';
const TARGET_DATE = new Date(`${TARGET}T00:00:00Z`);

const ANCHOR_ID = 42n;
const INSTRUMENT_ID = 7n;

interface Overrides {
  /** `trading_day` 里 ≤ cutoff 的最大交易日; `null` = 日历缺行。 */
  tradingDay?: string | null;
  /** `Instrument` 行是否已存在 (false ⇒ 走兜底 seed)。 */
  instrumentExists?: boolean;
  barRows?: number;
  snapshotRows?: number;
}

/**
 * 全 stub 的编排装配。**没有一个 stub 会外呼** —— 早退分支要断言的「零外呼」在这一层表现为
 * 「够不到那几个会外呼的下游」: 定日历 / seed / 开闸 / 复判 四个调用面全部零调用。
 */
function build(overrides: Overrides = {}) {
  const calls: string[] = [];

  const tradingDayFindFirst = vi.fn(async (_args: unknown) => {
    calls.push('tradingDay.findFirst');
    const date = overrides.tradingDay === undefined ? TARGET : overrides.tradingDay;
    return date === null ? null : { date: new Date(`${date}T00:00:00Z`) };
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
  const snapshotCount = vi.fn(async (_args: unknown) => {
    calls.push('optionDailySnapshot.count');
    return overrides.snapshotRows ?? 0;
  });

  const prisma = {
    tradingDay: { findFirst: tradingDayFindFirst },
    instrument: { findUnique: instrumentFindUnique, upsert: instrumentUpsert },
    anchorColdStartRun: { upsert: runUpsert },
    dailyBar: { count: dailyBarCount },
    optionDailySnapshot: { count: snapshotCount },
  } as unknown as PrismaService;

  const recalcSafely = vi.fn(async () => {
    calls.push('gate.recalcSafely');
    return { opened: 1, closed: 0 };
  });
  const gate = { recalcSafely } as unknown as AnchorDrivenSyncGate;

  return {
    usecase: new AnchorColdStartUseCase(prisma, gate),
    calls,
    tradingDayFindFirst,
    instrumentFindUnique,
    instrumentUpsert,
    runUpsert,
    recalcSafely,
    dailyBarCount,
    snapshotCount,
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
  }

  it('ticker 不可解析 ⇒ ticker_unresolved, 不猜市场 (FR-021)', async () => {
    const outcome = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'AAPL', // 无冒号 ⇒ 解析不出 market
      now: SATURDAY_1000_BEIJING,
    });

    expect(outcome).toBe(COLD_START_OUTCOME.TICKER_UNRESOLVED);
    expectNothingDownstream();
    expect(recordedRow(ctx.runUpsert)).toMatchObject({
      ticker: 'AAPL',
      outcome: COLD_START_OUTCOME.TICKER_UNRESOLVED,
      targetSession: null,
    });
  });

  it('市场未登记交易时段 ⇒ session_unregistered, 不套用别的市场时窗 (FR-022)', async () => {
    const outcome = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'sg:D05', // sg 不在 MARKET_SESSION
      now: SATURDAY_1000_BEIJING,
    });

    expect(outcome).toBe(COLD_START_OUTCOME.SESSION_UNREGISTERED);
    expectNothingDownstream();
    expect(recordedRow(ctx.runUpsert).outcome).toBe(COLD_START_OUTCOME.SESSION_UNREGISTERED);
  });

  it('市场未开通期权采集 (hk 空表项) ⇒ market_not_enabled, 显式 no-op 非错误 (FR-023)', async () => {
    const outcome = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'hk:00700',
      now: SATURDAY_1000_BEIJING,
    });

    expect(outcome).toBe(COLD_START_OUTCOME.MARKET_NOT_ENABLED);
    expectNothingDownstream();
    expect(recordedRow(ctx.runUpsert).outcome).toBe(COLD_START_OUTCOME.MARKET_NOT_ENABLED);
  });

  it('市场压根不在能力登记表 (cn) ⇒ 同样 market_not_enabled, 不静默', async () => {
    const outcome = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'cn:600519',
      now: SATURDAY_1000_BEIJING,
    });

    expect(outcome).toBe(COLD_START_OUTCOME.MARKET_NOT_ENABLED);
    expectNothingDownstream();
  });

  it('日历缺行 ⇒ calendar_missing, 且在 seed / 开闸**之前**放弃 (FR-009 不落任何数据行)', async () => {
    const local = build({ tradingDay: null });
    const outcome = await local.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'us:PEP',
      now: SATURDAY_1000_BEIJING,
    });

    expect(outcome).toBe(COLD_START_OUTCOME.CALENDAR_MISSING);
    expect(local.tradingDayFindFirst).toHaveBeenCalledTimes(1);
    // 🚨 放弃必须早于 seed 与开闸 —— 定不到目标日就动库, 正是 FR-009 禁的「落数据行」。
    expect(local.instrumentFindUnique).not.toHaveBeenCalled();
    expect(local.instrumentUpsert).not.toHaveBeenCalled();
    expect(local.recalcSafely).not.toHaveBeenCalled();
    const row = recordedRow(local.runUpsert);
    expect(row.outcome).toBe(COLD_START_OUTCOME.CALENDAR_MISSING);
    expect(row.targetSession).toBeNull();
  });
});

describe('AnchorColdStartUseCase 前置顺序与起手复判', () => {
  it('目标交易日的日线 + 快照都在 ⇒ already_present 且零外呼', async () => {
    const ctx = build({ barRows: 1, snapshotRows: 2150 });
    const outcome = await ctx.usecase.run({
      anchorId: ANCHOR_ID,
      ticker: 'us:PEP',
      now: SATURDAY_1000_BEIJING,
    });

    expect(outcome).toBe(COLD_START_OUTCOME.ALREADY_PRESENT);
    const row = recordedRow(ctx.runUpsert);
    expect(row.outcome).toBe(COLD_START_OUTCOME.ALREADY_PRESENT);
    expect(row.targetSession).toEqual(TARGET_DATE);
  });

  it('🚨 复判查的是 daily_bar / option_daily_snapshot 本身, **不读** anchor_cold_start_run', async () => {
    const ctx = build({ barRows: 1, snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    // 判据来自数据表: 两个 count 都被问过, 且各自钉住目标交易日与**本标的**。
    expect(ctx.dailyBarCount.mock.calls[0][0]).toMatchObject({
      where: { instrumentId: INSTRUMENT_ID, tradeDate: TARGET_DATE },
    });
    expect(ctx.snapshotCount.mock.calls[0][0]).toMatchObject({
      where: {
        sessionDate: TARGET_DATE,
        contract: { underlyingInstrumentId: INSTRUMENT_ID },
      },
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
    expect(ctx.dailyBarCount.mock.calls[0][0]).toMatchObject({
      where: { instrumentId: INSTRUMENT_ID },
    });
  });

  it('🚨 seed 落 needSync=false —— needSync 的重算权威只有采集闸, 不给它开第三个写入点', async () => {
    const ctx = build({ barRows: 1, snapshotRows: 1 });
    await ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING });

    const args = ctx.instrumentUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(args.create).toMatchObject({ market: 'us', code: 'PEP', name: 'PEP', needSync: false });
    // 空 update = 纯兜底: 已有行的 name / syncTier / needSync 一个都不许被 seed 冲掉。
    expect(args.update).toEqual({});
  });

  it('日线在、快照缺 ⇒ **不**判已具备 (缺一档就得补, 否则永久缺口)', async () => {
    const ctx = build({ barRows: 1, snapshotRows: 0 });
    await expect(
      ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING }),
    ).rejects.toThrow(/T006/);
  });

  it('日线缺 ⇒ 短路, 连快照都不必问 (少一次 count)', async () => {
    const ctx = build({ barRows: 0, snapshotRows: 2150 });
    await expect(
      ctx.usecase.run({ anchorId: ANCHOR_ID, ticker: 'us:PEP', now: SATURDAY_1000_BEIJING }),
    ).rejects.toThrow(/T006/);
    expect(ctx.snapshotCount).not.toHaveBeenCalled();
  });
});
