import { describe, expect, it, vi } from 'vitest';
import {
  COLD_START_CAPABILITY,
  COLD_START_OUTCOME,
  resolveSnapshotSpec,
} from './anchor-cold-start.rules.js';
import type { OptionSnapshotCoverageCheck } from './option-snapshot-coverage.check.js';
import { OptionSnapshotRemediation } from './option-snapshot-remediation.js';
import type { PrismaService } from '../security/prisma.service.js';
import {
  SNAPSHOT_SOURCE_EOD,
  SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
  type SnapshotCollectionSpec,
  type SyncOptionSnapshotUseCase,
} from './sync-option-snapshot.usecase.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';
import { exchangeCalendarDate, sessionWatermark } from './session-clock.js';

/**
 * 固定日历: 2026-08-10 (一) ~ 08-14 (五) + 08-17 (一) + 08-18 (二), 周末无行。
 * 这一周的星期几恰好铺满 plan §D4 对表的四行 (周四=08-13 / 周五=08-14 / 周六=08-15 /
 * 周日=08-16 / 周一=08-17 / 周二=08-18), 且落在 EDT 内 (北京 - 12h)。
 */
const US_TRADING_DAYS = [
  '2026-08-10',
  '2026-08-11',
  '2026-08-12',
  '2026-08-13',
  '2026-08-14',
  '2026-08-17',
  '2026-08-18',
] as const;

/** 北京墙上时钟 → 绝对时刻。 */
const beijing = (localIso: string): Date => new Date(`${localIso}+08:00`);

/** 日历里 ≤ `bound` 的最大交易日; `null` = 缺行。 */
const latestOnOrBefore = (bound: string): string | null =>
  [...US_TRADING_DAYS].reverse().find((d) => d <= bound) ?? null;

/**
 * 调用方本该做完的那几次日历查询 —— **测试里也走真的 `exchangeCalendarDate` /
 * `sessionWatermark`**, 因为生产调用方 (T005) 用的就是它们; 换成手算会让这套断言
 * 与真实入参口径脱钩。
 */
function calendarFacts(market: string, now: Date) {
  const today = exchangeCalendarDate(market, now);
  const target = latestOnOrBefore(sessionWatermark(market, now, 'unknown'));
  return {
    todayIsTradingDay: (US_TRADING_DAYS as readonly string[]).includes(today),
    lastClosedTradingDay: target,
    tradingDayBeforeTarget:
      target === null ? null : ([...US_TRADING_DAYS].reverse().find((d) => d < target) ?? null),
  };
}

/** 断言「决定采集」并把三元组摊平, 让每条 it 的期望值是四个字面量。 */
function tripleAt(market: string, now: Date) {
  const decision = resolveSnapshotSpec({ market, now, ...calendarFacts(market, now) });
  expect(decision.decision).toBe('collect');
  if (decision.decision !== 'collect') throw new Error('unreachable');
  return {
    sessionDate: decision.spec.sessionDate,
    source: decision.spec.mode,
    oiAsOf: decision.oiAsOf,
  };
}

describe('resolveSnapshotSpec —— plan §D4 四行决策表', () => {
  it('周六 10:00 北京 (= 周五 22:00 ET): today === target ⇒ eod, oiAsOf 退到周四', () => {
    expect(tripleAt('us', beijing('2026-08-15T10:00'))).toEqual({
      sessionDate: '2026-08-14',
      source: SNAPSHOT_SOURCE_EOD,
      oiAsOf: '2026-08-13',
    });
  });

  it('周一 10:00 北京 (= 周日 22:00 ET): today > target 且 today 非交易日 ⇒ eod, OI 未翻新', () => {
    expect(tripleAt('us', beijing('2026-08-17T10:00'))).toEqual({
      sessionDate: '2026-08-14',
      source: SNAPSHOT_SOURCE_EOD,
      oiAsOf: '2026-08-13',
    });
  });

  it('周一 18:00 北京 (= 周一 06:00 ET 盘前): today > target 且 today 是交易日 ⇒ premarket_backfill, OI 已翻新', () => {
    expect(tripleAt('us', beijing('2026-08-17T18:00'))).toEqual({
      sessionDate: '2026-08-14',
      source: SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
      oiAsOf: '2026-08-14',
    });
  });

  it('周二 10:00 北京 (= 周一 22:00 ET): today === target ⇒ eod, oiAsOf 退到周五', () => {
    expect(tripleAt('us', beijing('2026-08-18T10:00'))).toEqual({
      sessionDate: '2026-08-17',
      source: SNAPSHOT_SOURCE_EOD,
      oiAsOf: '2026-08-14',
    });
  });

  it('日历缺行 (target 查不到) ⇒ 不猜, 放弃并落 calendar_missing', () => {
    const decision = resolveSnapshotSpec({
      market: 'us',
      now: beijing('2026-08-15T10:00'),
      todayIsTradingDay: false,
      lastClosedTradingDay: null,
      tradingDayBeforeTarget: null,
    });
    expect(decision).toEqual({
      decision: 'abandon',
      outcome: COLD_START_OUTCOME.CALENDAR_MISSING,
    });
  });

  it('target 之前日历缺行 ⇒ 仍采集, 但 oiAsOf 交回 null (兜底归 collect, 本规则不复制)', () => {
    const decision = resolveSnapshotSpec({
      market: 'us',
      now: beijing('2026-08-15T10:00'),
      todayIsTradingDay: false,
      lastClosedTradingDay: '2026-08-14',
      tradingDayBeforeTarget: null,
    });
    expect(decision.decision).toBe('collect');
    if (decision.decision !== 'collect') throw new Error('unreachable');
    expect(decision.spec.sessionDate).toBe('2026-08-14');
    expect(decision.oiAsOf).toBeNull();
  });

  it('market 逐字透传进 marketScope —— 禁把 us 写死在规则里', () => {
    const now = beijing('2026-08-15T10:00');
    const decision = resolveSnapshotSpec({
      market: 'hk',
      now,
      todayIsTradingDay: false,
      lastClosedTradingDay: '2026-08-14',
      tradingDayBeforeTarget: '2026-08-13',
    });
    if (decision.decision !== 'collect') throw new Error('unreachable');
    expect(decision.spec.marketScope).toEqual(['hk']);
    // `now` 原样带进 spec: DTE 基准要的是绝对时刻, 不是归属业务日 (Guardrail 18)。
    expect(decision.spec.now).toBe(now);
  });
});

/**
 * 🚨 **本片规则把既有两条固定路径推广成一个连续函数** —— 在 remediation 自己的两个时点上,
 * 三元组必须逐字相同。这里跑的是**真的** `OptionSnapshotRemediation`, 不是它的算法副本:
 * 谁改动了任一侧的时点归属, 这两条立刻红。
 */
describe('与 option-snapshot-remediation 的等值回归', () => {
  /** 逐字构造一份「全域降级」报告, 让两级都真的走到 `collect`。 */
  const degradedReport = (sessionDate: string) => ({
    sessionDate,
    baselineDate: null,
    threshold: 1,
    status: 'degraded' as const,
    expected: 1,
    covered: 0,
    underlyings: [],
    degraded: [
      {
        instrumentId: 1n,
        symbol: 'us:PEP',
        expected: 1,
        covered: 0,
        missingContractCodes: [],
        degraded: true,
      },
    ],
  });

  const okReport = (sessionDate: string) => ({
    ...degradedReport(sessionDate),
    status: 'ok' as const,
    covered: 1,
    degraded: [],
  });

  function buildRemediation() {
    const collect = vi.fn().mockResolvedValue(false);
    let evaluated = 0;
    const coverage = {
      // 第一次判定 degraded (触发重采), 第二次判定 ok (走 recovered 分支)。
      evaluate: vi.fn(async (sessionDate: string) =>
        evaluated++ === 0 ? degradedReport(sessionDate) : okReport(sessionDate),
      ),
      alertIfDegraded: vi.fn(),
    } as unknown as OptionSnapshotCoverageCheck;
    const prisma = {
      tradingDay: {
        findFirst: vi.fn(async ({ where }: { where: { date: { lt: Date } } }) => {
          const bound = where.date.lt.toISOString().slice(0, 10);
          const prev = [...US_TRADING_DAYS].reverse().find((d) => d < bound);
          return prev === undefined ? null : { date: new Date(`${prev}T00:00:00Z`) };
        }),
      },
    } as unknown as PrismaService;
    const calendar = {
      classify: vi.fn(async (_market: string, date: string) =>
        (US_TRADING_DAYS as readonly string[]).includes(date) ? 'trading' : 'non-trading',
      ),
    } as unknown as TradingCalendarPort;
    const remediation = new OptionSnapshotRemediation(
      coverage,
      { collect } as unknown as SyncOptionSnapshotUseCase,
      prisma,
      calendar,
    );
    return { remediation, collect };
  }

  /** 取 remediation 实际喂给 `collect` 的那个 spec。 */
  const capturedSpec = (collect: ReturnType<typeof vi.fn>): SnapshotCollectionSpec => {
    expect(collect).toHaveBeenCalledTimes(1);
    return collect.mock.calls[0][1] as SnapshotCollectionSpec;
  };

  it('北京 08:00 ⇒ 与 ① 级当日重试逐字相同 (eod / 当前 us 业务日)', async () => {
    const now = beijing('2026-08-15T08:00');
    const { remediation, collect } = buildRemediation();
    await remediation.retrySameDay(now);

    const decision = resolveSnapshotSpec({ market: 'us', now, ...calendarFacts('us', now) });
    if (decision.decision !== 'collect') throw new Error('unreachable');
    expect(decision.spec).toEqual(capturedSpec(collect));
    // ① 级的 oi_as_of 由 collect 自己取 session_date 的上一交易日 (Guardrail 6)。
    expect(decision.oiAsOf).toBe('2026-08-13');
  });

  it('北京 18:00 ⇒ 与 ② 级盘前兜底逐字相同 (premarket_backfill / 上一交易日)', async () => {
    const now = beijing('2026-08-17T18:00');
    const { remediation, collect } = buildRemediation();
    await remediation.backfillPremarket(now);

    const decision = resolveSnapshotSpec({ market: 'us', now, ...calendarFacts('us', now) });
    if (decision.decision !== 'collect') throw new Error('unreachable');
    expect(decision.spec).toEqual(capturedSpec(collect));
    // ② 级的 oi_as_of **= session_date** (盘前 OI 已翻新), 与 ① 级差一天且 MUST NOT 抹平。
    expect(decision.oiAsOf).toBe('2026-08-14');
  });
});

describe('COLD_START_CAPABILITY —— FR-024 一处显式登记', () => {
  it('us 两档齐开: 链与快照都走**直调本体**, 日线不在表内', () => {
    // 🚫 日线曾以 `us_equity_bar` 出现在本表 (issue #159 前): 建锚那一刻
    //    `CreateAnchorUseCase.seedLastClose` 已同步调过 `EnsureLatestEodBarUseCase`,
    //    而 `optionsdesk.anchor` 全仓只有一个 create 点 ⇒ 冷启动再补一遍是重复劳动。
    expect(COLD_START_CAPABILITY.us).toEqual({ optionChain: true, optionSnapshot: true });
  });

  it('hk 是空表项 —— 显式登记「已知但未开通」, 走到冷启动 = 显式 no-op (FR-023)', () => {
    expect(COLD_START_CAPABILITY.hk).toEqual({ optionChain: false, optionSnapshot: false });
  });

  it('未登记市场取不到表项 —— 与「登记了但全关」同样落 market_not_enabled, 但不静默', () => {
    expect(COLD_START_CAPABILITY.cn).toBeUndefined();
  });
});

describe('COLD_START_OUTCOME —— FR-027 九种结局零折叠 (SC-009)', () => {
  it('恰好九种且取值两两互异', () => {
    const values = Object.values(COLD_START_OUTCOME);
    expect(values).toHaveLength(9);
    expect(new Set(values).size).toBe(9);
  });

  it('「没做」与「做了但失败」不共用取值', () => {
    expect(COLD_START_OUTCOME.INTRADAY_SKIPPED).not.toBe(COLD_START_OUTCOME.RETRY_EXHAUSTED);
    expect(COLD_START_OUTCOME.MARKET_NOT_ENABLED).not.toBe(COLD_START_OUTCOME.RETRY_EXHAUSTED);
    expect(COLD_START_OUTCOME.ALREADY_PRESENT).not.toBe(COLD_START_OUTCOME.BACKFILLED);
  });

  it('🚨 「已补齐」与「做了但没补上」MUST NOT 共用取值 (FR-027a)', () => {
    // 折叠这两个 = 唯一能发现永久缺口的那条按结局分组的查询失明。
    expect(COLD_START_OUTCOME.BACKFILLED).not.toBe(COLD_START_OUTCOME.BACKFILL_INCOMPLETE);
    // 也 MUST NOT 与「重试耗尽」混为一谈: 后者还有重试语义, 前者是终态、只等人工。
    expect(COLD_START_OUTCOME.BACKFILL_INCOMPLETE).not.toBe(COLD_START_OUTCOME.RETRY_EXHAUSTED);
    // VarChar(32) 列宽兜底。
    for (const v of Object.values(COLD_START_OUTCOME)) expect(v.length).toBeLessThanOrEqual(32);
  });
});
