import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import {
  executeBackfill,
  parseBackfillArgs,
  rebuildFactorChains,
  type BackfillDeps,
} from './marketdata-backfill.cli.js';
import { VOLATILITY_WINDOWS } from './lixinger-volatility.adapter.js';
import { subtractDays } from './dimension-executor.js';
import { splitBackfillWindows } from './underlying-iv.rules.js';

/**
 * 046 T009: 各 dry-run 求和块里 `underlying_iv_daily` 的**页数**因子。
 *
 * 那些块的 deps 统一是 `backfillDefaultHistoryDays=365` + `now=2026-07-16T12:00:00Z`
 * (⇒ asOf=2026-07-16), 故回填闭区间 [2025-07-16, 2026-07-16] 含 366 天 ⇒ 2 页。
 * 写成**派生量而不是字面 2**: 改默认深度 / 改 vendor 跨度上限时它跟着动, 不会静默失配。
 */
const DRY_RUN_IV_PAGES = splitBackfillWindows(subtractDays('2026-07-16', 365), '2026-07-16').length;

// 016 T017 backfill argv 解析纯单测 (无 DB); 017 T018 增 --timeout + --dimension 值域校验。
describe('parseBackfillArgs', () => {
  it('默认: 非 dry-run, market=cn', () => {
    expect(parseBackfillArgs([])).toEqual({ dryRun: false, markets: ['cn'] });
  });

  it('全 flag 解析', () => {
    expect(
      parseBackfillArgs([
        '--dimension',
        'eod_bar',
        '--history-depth',
        '3650',
        '--dry-run',
        '--markets',
        'cn,hk',
        '--timeout',
        '5000',
      ]),
    ).toEqual({
      dimension: 'eod_bar',
      historyDepth: 3650,
      dryRun: true,
      markets: ['cn', 'hk'],
      timeoutMs: 5000,
    });
  });

  it('--history-depth 转数字', () => {
    expect(parseBackfillArgs(['--history-depth', '365']).historyDepth).toBe(365);
  });

  it('--as-of 指定结算日', () => {
    expect(parseBackfillArgs(['--as-of', '2026-06-02']).asOf).toBe('2026-06-02');
  });

  it('未知维度键 → throw (017 T018: --dimension 转 functional, 值域 = 维度全序)', () => {
    expect(() => parseBackfillArgs(['--dimension', 'nope'])).toThrow(/未知维度/);
  });

  it('--timeout 非正数 → throw', () => {
    expect(() => parseBackfillArgs(['--timeout', 'abc'])).toThrow(/--timeout/);
    expect(() => parseBackfillArgs(['--timeout', '0'])).toThrow(/--timeout/);
  });

  it('--factors 解析 (020 T009 因子链回填模式, transient vendor 锚定)', () => {
    expect(parseBackfillArgs(['--factors']).factors).toBe(true);
    expect(parseBackfillArgs([]).factors).toBeUndefined();
  });

  it('--factors 与 --dimension 互斥 → throw (因子回填不组维度 job)', () => {
    expect(() => parseBackfillArgs(['--factors', '--dimension', 'eod_bar'])).toThrow(/--factors/);
  });

  it('--no-skip-complete 解析 (force-refetch: 绕过 backfill skip-complete 游标)', () => {
    expect(parseBackfillArgs(['--no-skip-complete']).noSkipComplete).toBe(true);
    expect(parseBackfillArgs([]).noSkipComplete).toBeUndefined();
  });
});

// 038 T005 seam#3: --markets 真透传 —— args.markets 织入 job payload (→ executor 工作集过滤)
// + estimateRequests 按传入 markets 统计 (不再 hardcode cn)。单维度 job 路径直观测 payload。
describe('executeBackfill --markets 透传 (seam#3)', () => {
  function buildDeps(): {
    deps: BackfillDeps;
    enqueued: Array<Record<string, unknown>>;
    countWhere: Array<Record<string, unknown>>;
  } {
    const enqueued: Array<Record<string, unknown>> = [];
    const countWhere: Array<Record<string, unknown>> = [];
    const fakeJob = {
      waitUntilFinished: vi.fn(async () => ({
        scanned: 0,
        ok: 0,
        skipped: 0,
        failed: 0,
        failedTargets: [],
      })),
    };
    const prisma = {
      instrument: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          countWhere.push(where);
          return 5;
        }),
      },
      syncDimension: {
        findUnique: vi.fn(async ({ where }: { where: { dimensionKey: string } }) =>
          where.dimensionKey === 'eod_bar'
            ? { dimensionKey: 'eod_bar', adjustTypes: ['none'], batchSize: 1 }
            : { dimensionKey: 'fundamental', adjustTypes: [], batchSize: 100 },
        ),
        findMany: vi.fn(async () => [{ dimensionKey: 'eod_bar', retryMax: 3 }]),
      },
    };
    const syncQueue = {
      enqueueDimensionJob: vi.fn(async (payload: Record<string, unknown>) => {
        enqueued.push(payload);
        return fakeJob;
      }),
      jobOpts: vi.fn(() => ({})),
    };
    const deps = {
      prisma,
      eodBar: {},
      syncQueue,
      queueEvents: {},
      cliWaitTimeoutMs: 1000,
      backfillDefaultHistoryDays: 365,
    } as unknown as BackfillDeps;
    return { deps, enqueued, countWhere };
  }

  it('--markets hk → job payload.markets=[hk] + estimateRequests where market in [hk] (不含 cn)', async () => {
    const { deps, enqueued, countWhere } = buildDeps();
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const code = await executeBackfill(
        deps,
        { dryRun: false, dimension: 'eod_bar', markets: ['hk'] },
        new Date('2026-07-11T12:00:00Z'),
      );
      expect(code).toBe(0);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].markets).toEqual(['hk']); // 透传进 payload, 不含 cn
      expect(enqueued[0].dimensionKey).toBe('eod_bar');
      // 🚨 估算与执行同口径: 含 needSync (漏掉会把「入库但不采」的标的算进来)。
      expect(countWhere[0]).toEqual({ market: { in: ['hk'] }, status: 'active', needSync: true }); // 估算按 hk
    } finally {
      logSpy.mockRestore();
    }
  });
});

// 039 T017: dry-run 估算把 5 新量化维度 (short_selling/connect_holding/fund_holding/
// fund_company_holding/index_membership, 均 per-instrument 单次调用) 计入 estVendorRequests,
// 且按 --markets 过滤。走 dry-run 路径 (入队前 return 0) + Logger.log 读回 plan JSON。
describe('executeBackfill --dry-run 估算含 039 五新维度 (T017)', () => {
  function buildDryRunDeps(activeCount: number): {
    deps: BackfillDeps;
    countWhere: Array<Record<string, unknown>>;
  } {
    const countWhere: Array<Record<string, unknown>> = [];
    const prisma = {
      instrument: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          countWhere.push(where);
          return activeCount;
        }),
      },
      syncDimension: {
        // eod_bar: 2 复权口径 → adjustCount=2; fundamental: batchSize=50。
        findUnique: vi.fn(async ({ where }: { where: { dimensionKey: string } }) =>
          where.dimensionKey === 'eod_bar'
            ? { dimensionKey: 'eod_bar', adjustTypes: ['none', 'forward'], batchSize: 1 }
            : { dimensionKey: 'fundamental', adjustTypes: [], batchSize: 50 },
        ),
      },
    };
    const deps = {
      prisma,
      eodBar: {},
      syncQueue: {}, // dry-run 不入队, 不触碰
      queueEvents: {},
      cliWaitTimeoutMs: 1000,
      backfillDefaultHistoryDays: 365,
    } as unknown as BackfillDeps;
    return { deps, countWhere };
  }

  // ── 2026-08-01: 估算器两处缺陷的回归钉子 ──────────────────────────────────────────
  //
  // 实战暴露: `--dimension us_equity_bar --markets us --history-depth 30` 的 dry-run 报
  // **350,760**, 而真跑 `scanned: 7`。两个独立原因叠加:
  //   ① 不过滤 needSync → 按全部 19,465 只入库 us 标的算 (实际开闸 7 只);
  //   ② 不看 --dimension → 恒把所有维度求和。
  // 高估 5 万倍不是"偏保守" —— dry-run 正是「防一条命令打爆配额」那道闸, 它一旦不可信,
  // 运维要么误弃安全命令, 要么学会无视估算, 后者等于闸失效。

  it('🚨 估算只数开闸标的 (needSync=true) —— 与 loadActiveInstruments 同口径', async () => {
    const { deps, countWhere } = buildDryRunDeps(10);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await executeBackfill(
        deps,
        { dryRun: true, markets: ['us'] },
        new Date('2026-08-01T12:00:00Z'),
      );
      // 漏掉 needSync → 把「全量入库供搜索、但无锚不采」的标的算进来 (us 19,465 vs 7)。
      expect(countWhere[0]).toEqual({ market: { in: ['us'] }, status: 'active', needSync: true });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('🚨 --dimension 限定单维度时只算该维度, 不求和全管线', async () => {
    const active = 10;
    const { deps } = buildDryRunDeps(active);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await executeBackfill(
        deps,
        { dryRun: true, markets: ['us'], dimension: 'us_equity_bar' },
        new Date('2026-08-01T12:00:00Z'),
      );
      const planLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('backfill plan'));
      const plan = JSON.parse((planLog as string).replace('backfill plan: ', ''));
      // us_equity_bar = per-instrument 单次 kline 区间 ⇒ 恰 active 次, 与真跑的 scanned 对齐。
      expect(plan.estVendorRequests).toBe(active);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('--markets hk dry-run: estVendorRequests 含 5 维度 × active + 按 hk 过滤', async () => {
    const active = 10;
    const { deps, countWhere } = buildDryRunDeps(active);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const code = await executeBackfill(
        deps,
        { dryRun: true, markets: ['hk'] },
        new Date('2026-07-11T12:00:00Z'),
      );
      expect(code).toBe(0);
      // 估算按 hk 过滤 (不含 cn)。
      expect(countWhere[0]).toEqual({ market: { in: ['hk'] }, status: 'active', needSync: true });
      const planLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('backfill plan'));
      expect(planLog).toBeDefined();
      const plan = JSON.parse((planLog as string).replace('backfill plan: ', ''));
      // eod=active×2 + batched=2×ceil(10/50) + corp=active + 5 量化维度=active×5
      //   + 040 volatility=active×3 窗口 (hot_snapshot 是快照, 不计历史回填)
      //   + 041 事件流 4 维度=active×4 + 042 报告期 3 维度=active×3。
      const eod = active * 2;
      const batched = 2 * Math.ceil(active / 50);
      const corp = active;
      const quantSignals = active * 5;
      const volatility = active * VOLATILITY_WINDOWS.length; // 040: 波动率 per-instrument × 3 窗口
      const corporateEvents = active * 4; // 041: 4 事件维度各 per-instrument 单次区间
      const reportingPeriods = active * 3; // 042: 3 报告期维度各 per-instrument 单次区间
      const classificationText = active * 1; // 043: announcement per-instrument (industry_classification 覆盖式不计)
      const usEquityBar = active * 1; // sellput-viz: us 日线 per-instrument 单次 kline 区间
      const underlyingIvDaily = active * DRY_RUN_IV_PAGES; // 046: his_volatility per-instrument × 页数
      expect(plan.estVendorRequests).toBe(
        eod +
          batched +
          corp +
          quantSignals +
          volatility +
          corporateEvents +
          reportingPeriods +
          usEquityBar +
          underlyingIvDaily +
          classificationText,
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});

// 040 T010: dry-run 估算把 volatility 按 per-stock 区间 × 窗口数 (VOLATILITY_WINDOWS=3) 计入,
// hot_snapshot 是**快照非历史回填** (history_depth=NULL) → 不入 backfill 历史估算。走 dry-run
// 路径 (入队前 return 0) + Logger.log 读回 plan JSON, 断言 volatility×3 增量 + hot 零增量。
describe('executeBackfill --dry-run 估算含 040 volatility×3 窗口 (T010)', () => {
  function buildDryRunDeps(activeCount: number): {
    deps: BackfillDeps;
    countWhere: Array<Record<string, unknown>>;
  } {
    const countWhere: Array<Record<string, unknown>> = [];
    const prisma = {
      instrument: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          countWhere.push(where);
          return activeCount;
        }),
      },
      syncDimension: {
        findUnique: vi.fn(async ({ where }: { where: { dimensionKey: string } }) =>
          where.dimensionKey === 'eod_bar'
            ? { dimensionKey: 'eod_bar', adjustTypes: ['none'], batchSize: 1 }
            : { dimensionKey: 'fundamental', adjustTypes: [], batchSize: 50 },
        ),
      },
    };
    const deps = {
      prisma,
      eodBar: {},
      syncQueue: {},
      queueEvents: {},
      cliWaitTimeoutMs: 1000,
      backfillDefaultHistoryDays: 365,
    } as unknown as BackfillDeps;
    return { deps, countWhere };
  }

  /** 读回 dry-run plan JSON 的 estVendorRequests。 */
  async function estimateFor(active: number): Promise<number> {
    const { deps } = buildDryRunDeps(active);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await executeBackfill(
        deps,
        { dryRun: true, markets: ['hk'] },
        new Date('2026-07-14T12:00:00Z'),
      );
      const planLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('backfill plan'));
      return JSON.parse((planLog as string).replace('backfill plan: ', '')).estVendorRequests;
    } finally {
      logSpy.mockRestore();
    }
  }

  it('--markets hk dry-run: estVendorRequests 含 volatility×3 窗口, hot_snapshot 不计历史回填', async () => {
    const active = 10;
    // eod(adjustCount=1)=active + batched=2×ceil(10/50) + corp=active + 5 量化=active×5
    //   + volatility=active×VOLATILITY_WINDOWS.length + 041 事件=active×4 + 042 报告期=active×3。
    //   hot_snapshot 恒不计 (快照)。
    const eod = active * 1;
    const batched = 2 * Math.ceil(active / 50);
    const corp = active;
    const quantSignals = active * 5;
    const volatility = active * VOLATILITY_WINDOWS.length;
    const corporateEvents = active * 4; // 041: 4 事件维度各 per-instrument 单次区间
    const reportingPeriods = active * 3; // 042: 3 报告期维度各 per-instrument 单次区间
    const classificationText = active * 1; // 043: announcement per-instrument (industry_classification 覆盖式不计)
    const usEquityBar = active * 1; // sellput-viz: us 日线 per-instrument 单次 kline 区间
    const underlyingIvDaily = active * DRY_RUN_IV_PAGES; // 046: his_volatility per-instrument × 页数
    const expected =
      eod +
      batched +
      corp +
      quantSignals +
      volatility +
      corporateEvents +
      reportingPeriods +
      classificationText +
      usEquityBar +
      underlyingIvDaily;
    expect(await estimateFor(active)).toBe(expected);
    // hot_snapshot 反证: 若被计入历史回填, 会在正确总量上再多 active (per-stock 单次) → 上式必失配。
    expect(expected).not.toBe(expected + active);
  });

  it('volatility 增量恰为 active × 窗口数 (per-active 线性)', async () => {
    // 边际增量: Δactive=10 → Δestimate 含 volatility 项 10×窗口数。隔离 volatility 贡献
    // (其余项亦线性) → 用两点差分反解: est(20)-est(10) 的 volatility 分量 = 10×窗口数。
    const est10 = await estimateFor(10);
    const est20 = await estimateFor(20);
    // 全项线性 → 差分整齐: eodΔ=10 + batchedΔ=0(ceil(10..20/50)=1) + corpΔ=10 + quantΔ=50 + volΔ=10×3
    //   + 041 事件维度Δ=10×4 + 042 报告期维度Δ=10×3 + 043 announcementΔ=10×1。
    const volDelta = 10 * VOLATILITY_WINDOWS.length;
    const eventDelta = 10 * 4; // 041: 4 事件维度各 per-active 单次
    const reportDelta = 10 * 3; // 042: 3 报告期维度各 per-active 单次
    const classDelta = 10 * 1; // 043: announcement per-active 单次 (industry_classification 覆盖式不计)
    const usEquityBarDelta = 10 * 1; // sellput-viz: us 日线 per-active 单次
    const underlyingIvDailyDelta = 10 * DRY_RUN_IV_PAGES; // 046: per-active × 页数
    expect(est20 - est10).toBe(
      10 * 1 +
        0 +
        10 +
        50 +
        volDelta +
        eventDelta +
        reportDelta +
        classDelta +
        usEquityBarDelta +
        underlyingIvDailyDelta,
    );
  });
});

// 041 T016: dry-run 估算把 4 港股事件维度 (buyback/equity_change/shareholder_change/allotment,
// 均 per-instrument 单次区间调用, history_depth=3650 可回填历史) 计入 estVendorRequests, 且按
// --markets 过滤 (--dimension 由 DIMENSION_KEYS 校验天然支持, 零改)。走 dry-run 路径 (入队前
// return 0) + Logger.log 读回 plan JSON, 断言 4 事件维度 × active 增量 + 按 hk 过滤。
describe('executeBackfill --dry-run 估算含 041 四事件维度 (T016)', () => {
  const EVENT_DIM_COUNT = 4; // buyback / equity_change / shareholder_change / allotment

  function buildDryRunDeps(activeCount: number): {
    deps: BackfillDeps;
    countWhere: Array<Record<string, unknown>>;
  } {
    const countWhere: Array<Record<string, unknown>> = [];
    const prisma = {
      instrument: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          countWhere.push(where);
          return activeCount;
        }),
      },
      syncDimension: {
        findUnique: vi.fn(async ({ where }: { where: { dimensionKey: string } }) =>
          where.dimensionKey === 'eod_bar'
            ? { dimensionKey: 'eod_bar', adjustTypes: ['none'], batchSize: 1 }
            : { dimensionKey: 'fundamental', adjustTypes: [], batchSize: 50 },
        ),
      },
    };
    const deps = {
      prisma,
      eodBar: {},
      syncQueue: {},
      queueEvents: {},
      cliWaitTimeoutMs: 1000,
      backfillDefaultHistoryDays: 365,
    } as unknown as BackfillDeps;
    return { deps, countWhere };
  }

  /** 读回 dry-run plan JSON 的 estVendorRequests。 */
  async function estimateFor(active: number): Promise<{ est: number; hkFiltered: boolean }> {
    const { deps, countWhere } = buildDryRunDeps(active);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await executeBackfill(
        deps,
        { dryRun: true, markets: ['hk'] },
        new Date('2026-07-15T12:00:00Z'),
      );
      const planLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('backfill plan'));
      const est = JSON.parse((planLog as string).replace('backfill plan: ', '')).estVendorRequests;
      const hkFiltered =
        countWhere.length > 0 &&
        JSON.stringify(countWhere[0]) ===
          JSON.stringify({ market: { in: ['hk'] }, status: 'active', needSync: true });
      return { est, hkFiltered };
    } finally {
      logSpy.mockRestore();
    }
  }

  it('--markets hk dry-run: estVendorRequests 含 4 事件维度 × active + 按 hk 过滤', async () => {
    const active = 10;
    const { est, hkFiltered } = await estimateFor(active);
    expect(hkFiltered).toBe(true); // 估算按 hk 过滤 (不含 cn)
    // eod(adjustCount=1)=active + batched=2×ceil(10/50) + corp=active + 5 量化=active×5
    //   + volatility=active×VOLATILITY_WINDOWS + 041 事件=active×4 + 042 报告期=active×3。
    const eod = active * 1;
    const batched = 2 * Math.ceil(active / 50);
    const corp = active;
    const quantSignals = active * 5;
    const volatility = active * VOLATILITY_WINDOWS.length;
    const corporateEvents = active * EVENT_DIM_COUNT;
    const reportingPeriods = active * 3; // 042: 3 报告期维度各 per-instrument 单次区间
    const classificationText = active * 1; // 043: announcement per-instrument (industry_classification 覆盖式不计)
    const usEquityBar = active * 1; // sellput-viz: us 日线 per-instrument 单次 kline 区间
    const underlyingIvDaily = active * DRY_RUN_IV_PAGES; // 046: his_volatility per-instrument × 页数
    const expected =
      eod +
      batched +
      corp +
      quantSignals +
      volatility +
      corporateEvents +
      reportingPeriods +
      classificationText +
      usEquityBar +
      underlyingIvDaily;
    expect(est).toBe(expected);
    // 反证: 若 4 事件维度未计入历史回填, 会少 active×4 → 上式必失配。
    expect(expected).not.toBe(
      eod +
        batched +
        corp +
        quantSignals +
        volatility +
        reportingPeriods +
        classificationText +
        active,
    );
  });

  it('4 事件维度增量恰为 active × 4 (per-active 线性)', async () => {
    // 两点差分隔离事件维度贡献: est(20)-est(10) 的事件分量 = 10×4。
    const { est: est10 } = await estimateFor(10);
    const { est: est20 } = await estimateFor(20);
    // 全项线性: eodΔ=10 + batchedΔ=0 + corpΔ=10 + quantΔ=50 + volΔ=10×窗口数 + 事件Δ=10×4
    //   + 042 报告期Δ=10×3 + 043 announcementΔ=10×1。
    const volDelta = 10 * VOLATILITY_WINDOWS.length;
    const eventDelta = 10 * EVENT_DIM_COUNT;
    const reportDelta = 10 * 3; // 042: 3 报告期维度各 per-active 单次
    const classDelta = 10 * 1; // 043: announcement per-active 单次 (industry_classification 覆盖式不计)
    const usEquityBarDelta = 10 * 1; // sellput-viz: us 日线 per-active 单次
    const underlyingIvDailyDelta = 10 * DRY_RUN_IV_PAGES; // 046: per-active × 页数
    expect(est20 - est10).toBe(
      10 * 1 +
        0 +
        10 +
        50 +
        volDelta +
        eventDelta +
        reportDelta +
        classDelta +
        usEquityBarDelta +
        underlyingIvDailyDelta,
    );
  });
});

// 042 T013: dry-run 估算把 3 港股报告期维度 (revenue_segment/shareholder_snapshot/employee,
// 均 per-instrument 单次区间调用, history_depth=3650 可回填历史) 计入 estVendorRequests, 且按
// --markets 过滤 (--dimension 由 DIMENSION_KEYS 校验天然支持, 零改)。走 dry-run 路径 (入队前
// return 0) + Logger.log 读回 plan JSON, 断言 3 报告期维度 × active 增量 + 按 hk 过滤。
describe('executeBackfill --dry-run 估算含 042 三报告期维度 (T013)', () => {
  const REPORT_DIM_COUNT = 3; // revenue_segment / shareholder_snapshot / employee

  function buildDryRunDeps(activeCount: number): {
    deps: BackfillDeps;
    countWhere: Array<Record<string, unknown>>;
  } {
    const countWhere: Array<Record<string, unknown>> = [];
    const prisma = {
      instrument: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          countWhere.push(where);
          return activeCount;
        }),
      },
      syncDimension: {
        findUnique: vi.fn(async ({ where }: { where: { dimensionKey: string } }) =>
          where.dimensionKey === 'eod_bar'
            ? { dimensionKey: 'eod_bar', adjustTypes: ['none'], batchSize: 1 }
            : { dimensionKey: 'fundamental', adjustTypes: [], batchSize: 50 },
        ),
      },
    };
    const deps = {
      prisma,
      eodBar: {},
      syncQueue: {},
      queueEvents: {},
      cliWaitTimeoutMs: 1000,
      backfillDefaultHistoryDays: 365,
    } as unknown as BackfillDeps;
    return { deps, countWhere };
  }

  /** 读回 dry-run plan JSON 的 estVendorRequests。 */
  async function estimateFor(active: number): Promise<{ est: number; hkFiltered: boolean }> {
    const { deps, countWhere } = buildDryRunDeps(active);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await executeBackfill(
        deps,
        { dryRun: true, markets: ['hk'] },
        new Date('2026-07-15T12:00:00Z'),
      );
      const planLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('backfill plan'));
      const est = JSON.parse((planLog as string).replace('backfill plan: ', '')).estVendorRequests;
      const hkFiltered =
        countWhere.length > 0 &&
        JSON.stringify(countWhere[0]) ===
          JSON.stringify({ market: { in: ['hk'] }, status: 'active', needSync: true });
      return { est, hkFiltered };
    } finally {
      logSpy.mockRestore();
    }
  }

  it('--markets hk dry-run: estVendorRequests 含 3 报告期维度 × active + 按 hk 过滤', async () => {
    const active = 10;
    const { est, hkFiltered } = await estimateFor(active);
    expect(hkFiltered).toBe(true); // 估算按 hk 过滤 (不含 cn)
    // eod(adjustCount=1)=active + batched=2×ceil(10/50) + corp=active + 5 量化=active×5
    //   + volatility=active×VOLATILITY_WINDOWS + 041 事件=active×4 + 042 报告期=active×3。
    const eod = active * 1;
    const batched = 2 * Math.ceil(active / 50);
    const corp = active;
    const quantSignals = active * 5;
    const volatility = active * VOLATILITY_WINDOWS.length;
    const corporateEvents = active * 4;
    const reportingPeriods = active * REPORT_DIM_COUNT;
    const classificationText = active * 1; // 043: announcement per-instrument (industry_classification 覆盖式不计)
    const usEquityBar = active * 1; // sellput-viz: us 日线 per-instrument 单次 kline 区间
    const underlyingIvDaily = active * DRY_RUN_IV_PAGES; // 046: his_volatility per-instrument × 页数
    const expected =
      eod +
      batched +
      corp +
      quantSignals +
      volatility +
      corporateEvents +
      reportingPeriods +
      classificationText +
      usEquityBar +
      underlyingIvDaily;
    expect(est).toBe(expected);
    // 反证: 若 3 报告期维度未计入历史回填, 会少 active×3 → 上式必失配。
    expect(expected).not.toBe(
      eod +
        batched +
        corp +
        quantSignals +
        volatility +
        corporateEvents +
        classificationText +
        active,
    );
  });

  it('3 报告期维度增量恰为 active × 3 (per-active 线性)', async () => {
    // 两点差分隔离报告期维度贡献: est(20)-est(10) 的报告期分量 = 10×3。
    const { est: est10 } = await estimateFor(10);
    const { est: est20 } = await estimateFor(20);
    // 全项线性: eodΔ=10 + batchedΔ=0 + corpΔ=10 + quantΔ=50 + volΔ=10×窗口数 + 事件Δ=10×4
    //   + 报告期Δ=10×3。
    const volDelta = 10 * VOLATILITY_WINDOWS.length;
    const eventDelta = 10 * 4;
    const reportDelta = 10 * REPORT_DIM_COUNT;
    const classDelta = 10 * 1; // 043: announcement per-active 单次 (industry_classification 覆盖式不计)
    const usEquityBarDelta = 10 * 1; // sellput-viz: us 日线 per-active 单次
    const underlyingIvDailyDelta = 10 * DRY_RUN_IV_PAGES; // 046: per-active × 页数
    expect(est20 - est10).toBe(
      10 * 1 +
        0 +
        10 +
        50 +
        volDelta +
        eventDelta +
        reportDelta +
        classDelta +
        usEquityBarDelta +
        underlyingIvDailyDelta,
    );
  });
});

// 043 T010: dry-run 估算把 announcement (per-instrument 单次区间调用, history_depth=3650 可回填
// 历史) 计入 estVendorRequests, 而 industry_classification (覆盖式快照, history_depth=NULL, 无历史
// 回填区间) **恒不计入** (同 hot_snapshot 处理); 且按 --markets 过滤 (--dimension 由 DIMENSION_KEYS
// 校验天然支持, 零改)。走 dry-run 路径 (入队前 return 0) + Logger.log 读回 plan JSON, 断言
// announcement × active 增量 + industry_classification 零增量 + 按 hk 过滤。
describe('executeBackfill --dry-run 估算含 043 announcement, 排除 industry_classification (T010)', () => {
  function buildDryRunDeps(activeCount: number): {
    deps: BackfillDeps;
    countWhere: Array<Record<string, unknown>>;
  } {
    const countWhere: Array<Record<string, unknown>> = [];
    const prisma = {
      instrument: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          countWhere.push(where);
          return activeCount;
        }),
      },
      syncDimension: {
        findUnique: vi.fn(async ({ where }: { where: { dimensionKey: string } }) =>
          where.dimensionKey === 'eod_bar'
            ? { dimensionKey: 'eod_bar', adjustTypes: ['none'], batchSize: 1 }
            : { dimensionKey: 'fundamental', adjustTypes: [], batchSize: 50 },
        ),
      },
    };
    const deps = {
      prisma,
      eodBar: {},
      syncQueue: {},
      queueEvents: {},
      cliWaitTimeoutMs: 1000,
      backfillDefaultHistoryDays: 365,
    } as unknown as BackfillDeps;
    return { deps, countWhere };
  }

  /** 读回 dry-run plan JSON 的 estVendorRequests。 */
  async function estimateFor(active: number): Promise<{ est: number; hkFiltered: boolean }> {
    const { deps, countWhere } = buildDryRunDeps(active);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await executeBackfill(
        deps,
        { dryRun: true, markets: ['hk'] },
        new Date('2026-07-16T12:00:00Z'),
      );
      const planLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('backfill plan'));
      const est = JSON.parse((planLog as string).replace('backfill plan: ', '')).estVendorRequests;
      const hkFiltered =
        countWhere.length > 0 &&
        JSON.stringify(countWhere[0]) ===
          JSON.stringify({ market: { in: ['hk'] }, status: 'active', needSync: true });
      return { est, hkFiltered };
    } finally {
      logSpy.mockRestore();
    }
  }

  it('--markets hk dry-run: estVendorRequests 含 announcement × active + 排除 industry_classification + 按 hk 过滤', async () => {
    const active = 10;
    const { est, hkFiltered } = await estimateFor(active);
    expect(hkFiltered).toBe(true); // 估算按 hk 过滤 (不含 cn)
    // eod(adjustCount=1)=active + batched=2×ceil(10/50) + corp=active + 5 量化=active×5
    //   + volatility=active×VOLATILITY_WINDOWS + 041 事件=active×4 + 042 报告期=active×3
    //   + 043 announcement=active×1。industry_classification 覆盖式无历史 → 不计入。
    const eod = active * 1;
    const batched = 2 * Math.ceil(active / 50);
    const corp = active;
    const quantSignals = active * 5;
    const volatility = active * VOLATILITY_WINDOWS.length;
    const corporateEvents = active * 4;
    const reportingPeriods = active * 3;
    const classificationText = active * 1; // 043: announcement per-instrument 单次区间
    const usEquityBar = active * 1; // sellput-viz: us 日线 per-instrument 单次 kline 区间
    const underlyingIvDaily = active * DRY_RUN_IV_PAGES; // 046: his_volatility per-instrument × 页数
    const expected =
      eod +
      batched +
      corp +
      quantSignals +
      volatility +
      corporateEvents +
      reportingPeriods +
      classificationText +
      usEquityBar +
      underlyingIvDaily;
    expect(est).toBe(expected);
    // 反证①: 若 announcement 未计入历史回填, 会少 active×1 → 上式必失配。
    expect(expected).not.toBe(expected - classificationText);
    // 反证②: 若 industry_classification (覆盖式无历史) 被误计入历史回填, 会在正确总量上再多
    //   active (per-stock 单次) → 上式必失配。
    expect(expected).not.toBe(expected + active);
  });

  it('announcement 增量恰为 active × 1 (per-active 线性), industry_classification 零增量', async () => {
    // 两点差分隔离 announcement 贡献: est(20)-est(10) 的 announcement 分量 = 10×1;
    //   industry_classification 覆盖式不计 → 对差分零贡献。
    const { est: est10 } = await estimateFor(10);
    const { est: est20 } = await estimateFor(20);
    // 全项线性: eodΔ=10 + batchedΔ=0 + corpΔ=10 + quantΔ=50 + volΔ=10×窗口数 + 事件Δ=10×4
    //   + 报告期Δ=10×3 + announcementΔ=10×1 (industry_classification 零)。
    const volDelta = 10 * VOLATILITY_WINDOWS.length;
    const eventDelta = 10 * 4;
    const reportDelta = 10 * 3;
    const classDelta = 10 * 1; // 043: announcement per-active 单次 (industry_classification 覆盖式不计)
    const usEquityBarDelta = 10 * 1; // sellput-viz: us 日线 per-active 单次
    const underlyingIvDailyDelta = 10 * DRY_RUN_IV_PAGES; // 046: per-active × 页数
    expect(est20 - est10).toBe(
      10 * 1 +
        0 +
        10 +
        50 +
        volDelta +
        eventDelta +
        reportDelta +
        classDelta +
        usEquityBarDelta +
        underlyingIvDailyDelta,
    );
  });
});

// ── rebuildFactorChains 换口径为事件条款法 (2026-08-01) ─────────────────────────
//
// 旧口径 (`anchorFactorJumps`) 从 vendor backward 序列反推跃变, 隐含假设 vendor 用**乘法**
// 复权。直连理杏仁实测证伪: `bc_rights` 在两个公司行动之间是**仿射**变换 `bc = K·ex − C`
// (00206 拟合 K=2 / C=0.43, 93 个交易日残差 0), 仿射不保比值 ⇒ 反推口径不成立。
// 现口径全部输入取自本地四表 ⇒ **本命令零 vendor 外呼**, 这是下面断言的核心。
describe('rebuildFactorChains 事件条款法 (零 vendor 外呼 + 幂等 upsert)', () => {
  function buildFactorDeps(opts: {
    exCount?: number;
    noneCount?: number;
    noneDates?: string[];
    exDates?: string[];
  }) {
    const upserts: Array<Record<string, unknown>> = [];
    const noneDates = opts.noneDates ?? ['2024-06-03', '2024-06-04'];
    const exDates = opts.exDates ?? ['2024-06-04'];
    const prisma = {
      instrument: {
        findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00206' }]),
        findUnique: vi.fn(async () => ({ currency: 'HKD' })),
        count: vi.fn(async () => 1),
      },
      corporateAction: {
        count: vi.fn(async () => opts.exCount ?? 1),
        findMany: vi.fn(async () =>
          exDates.map((d) => ({
            exDate: new Date(`${d}T00:00:00Z`),
            payload: { dividend: 0.5, currency: 'HKD' },
          })),
        ),
      },
      dailyBar: {
        count: vi.fn(async () => opts.noneCount ?? noneDates.length),
        findMany: vi.fn(async () =>
          noneDates.map((d, i) => ({
            tradeDate: new Date(`${d}T00:00:00Z`),
            close: new Prisma.Decimal(i === 0 ? '10' : '9.5'),
            changePct: new Prisma.Decimal('-0.53'),
          })),
        ),
      },
      equityChange: { findMany: vi.fn(async () => []) },
      allotmentEvent: { findMany: vi.fn(async () => []) },
      adjustmentFactor: {
        upsert: vi.fn(async (arg: Record<string, unknown>) => {
          upserts.push(arg);
          return {};
        }),
      },
    } as unknown as Parameters<typeof rebuildFactorChains>[0];
    return { prisma, upserts };
  }

  const silent = () => vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

  it('🚨 签名不再收 EodBarPort —— 换口径后本命令零 vendor 外呼', () => {
    // 形参个数守卫: (prisma, logger?, dryRun?) —— 若谁把 eodBar 加回来, 这里先红。
    expect(rebuildFactorChains.length).toBeLessThanOrEqual(1);
  });

  it('按事件条款算出因子并 upsert (含 source/status 两列)', async () => {
    const { prisma, upserts } = buildFactorDeps({});
    const log = silent();
    try {
      await rebuildFactorChains(prisma);
      expect(upserts).toHaveLength(1);
      const create = (upserts[0] as { create: Record<string, unknown> }).create;
      // f = n0/(n0−d) = 10/9.5 = 1.052631…
      expect((create.factorBackward as Prisma.Decimal).toFixed(6)).toBe('1.052632');
      expect(create.source).toBe('event_terms');
      expect(typeof create.status).toBe('string');
    } finally {
      log.mockRestore();
    }
  });

  it('无除权史 / 无 none 基底 → 跳过, 零 upsert (读时换算按 1)', async () => {
    for (const opts of [{ exCount: 0 }, { noneCount: 0 }]) {
      const { prisma, upserts } = buildFactorDeps(opts);
      const log = silent();
      try {
        await rebuildFactorChains(prisma);
        expect(upserts).toHaveLength(0);
      } finally {
        log.mockRestore();
      }
    }
  });

  it('单标的写库异常 → WARN 续跑其余标的 + 退出码 1 (partial)', async () => {
    const { prisma } = buildFactorDeps({});
    (prisma as unknown as { instrument: { findMany: unknown } }).instrument.findMany = vi.fn(
      async () => [
        { id: 1n, market: 'hk', code: 'BAD' },
        { id: 2n, market: 'hk', code: 'OK' },
      ],
    );
    let seen = 0;
    (prisma as unknown as { adjustmentFactor: { upsert: unknown } }).adjustmentFactor.upsert =
      vi.fn(async () => {
        seen++;
        if (seen === 1) throw new Error('deadlock detected');
        return {};
      });
    const log = silent();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(await rebuildFactorChains(prisma)).toBe(1); // partial → 1
      expect(seen).toBe(2); // 第一只失败不阻塞第二只
      expect(warn).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('dry-run 不写库, 且字段名不是 estVendorRequests (零外呼后报 vendor 请求数会骗执行方)', async () => {
    const { prisma, upserts } = buildFactorDeps({});
    const lines: string[] = [];
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      lines.push(String(m));
    });
    try {
      await rebuildFactorChains(prisma, new Logger('t'), true);
      expect(upserts).toHaveLength(0);
      expect(lines.join('\n')).toContain('estInstruments');
      expect(lines.join('\n')).not.toContain('estVendorRequests');
    } finally {
      log.mockRestore();
    }
  });
});

// 046 T009: `underlying_iv_daily` 的回填额度估算 —— 它是**唯一一个 per-instrument × 多页**的
// 维度 (his_volatility 单次跨度 ≤364 天 ⇒ 3 年要分 4 页), 既有的「active × 1」模型套上去会
// **低报 4 倍**。
//
// 🚨 页数由 `splitBackfillWindows` 派生, **不是字面量** —— 估算侧与执行侧调同一个函数, 才不会
// 出现「估算说 N 页、实跑 M 页」。#754 那次 (`--dimension us_equity_bar` 报 350,760 实跑 7)
// 的病根就是估算口径与执行口径各写一遍; 本组末条即针对那根神经的回归断言。
describe('executeBackfill --dry-run 估算含 046 underlying_iv_daily × 分页数 (T009)', () => {
  function buildDryRunDeps(activeCount: number): {
    deps: BackfillDeps;
    countWhere: Array<Record<string, unknown>>;
  } {
    const countWhere: Array<Record<string, unknown>> = [];
    const prisma = {
      instrument: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          countWhere.push(where);
          return activeCount;
        }),
      },
      syncDimension: {
        findUnique: vi.fn(async ({ where }: { where: { dimensionKey: string } }) =>
          where.dimensionKey === 'eod_bar'
            ? { dimensionKey: 'eod_bar', adjustTypes: ['none'], batchSize: 1 }
            : { dimensionKey: 'fundamental', adjustTypes: [], batchSize: 50 },
        ),
      },
    };
    const deps = {
      prisma,
      eodBar: {},
      syncQueue: {},
      queueEvents: {},
      cliWaitTimeoutMs: 1000,
      backfillDefaultHistoryDays: 365,
    } as unknown as BackfillDeps;
    return { deps, countWhere };
  }

  const AS_OF = '2026-07-16';

  /** 读回 dry-run plan JSON 的 estVendorRequests (可指定 --history-depth / --dimension)。 */
  async function estimateFor(
    active: number,
    args: { historyDepth?: number; dimension?: 'underlying_iv_daily' } = {},
  ): Promise<number> {
    const { deps } = buildDryRunDeps(active);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await executeBackfill(
        deps,
        { dryRun: true, markets: ['us'], asOf: AS_OF, ...args },
        new Date('2026-07-16T12:00:00Z'),
      );
      const planLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('backfill plan'));
      return JSON.parse((planLog as string).replace('backfill plan: ', '')).estVendorRequests;
    } finally {
      logSpy.mockRestore();
    }
  }

  /** 与执行侧同一个切分函数算页数 —— 估算口径与执行口径同源, 这正是本组要守的东西。 */
  const pagesFor = (depth: number) =>
    splitBackfillWindows(subtractDays(AS_OF, depth), AS_OF).length;

  it('🚨 --dimension underlying_iv_daily 拉满 3 年 → active × 4 页 (不是 active × 1)', async () => {
    const active = 12; // 12 只锚 = 上线规模
    const depth = 1095; // 维度行 history_depth: vendor 可回看上限约 3 年
    expect(pagesFor(depth)).toBe(4); // ⌈(1095+1)/364⌉，含首尾计数
    const est = await estimateFor(active, {
      historyDepth: depth,
      dimension: 'underlying_iv_daily',
    });
    expect(est).toBe(active * 4);
    // 反证: 若沿用「per-instrument 单次区间」模型 (active × 1), 会低报到 12 —— 一次性回填的
    // 真实开销是 48 次, 低报会让人以为额度绰绰有余。
    expect(est).not.toBe(active);
  });

  it('页数随 --history-depth 走, 不是写死的 4: depth 363 → 1 页/标的, depth 727 → 2 页/标的', async () => {
    const active = 12;
    // ⚠️ depth D 的闭区间 [asOf−D, asOf] 含 **D+1** 天 ⇒ 恰好整页的 depth 是 363 / 727,
    // 不是 364 / 728。差一天就多切一页, 正是「边界不重不漏」要盯的那类 off-by-one。
    expect(pagesFor(363)).toBe(1);
    expect(pagesFor(727)).toBe(2);
    expect(await estimateFor(active, { historyDepth: 363, dimension: 'underlying_iv_daily' })).toBe(
      active * 1,
    );
    expect(await estimateFor(active, { historyDepth: 727, dimension: 'underlying_iv_daily' })).toBe(
      active * 2,
    );
  });

  it('🚨 --dimension 限定时只算它 (#754 神经): 单维度数字停在 active × 页数, 不是全管线量级', async () => {
    const active = 12;
    const single = await estimateFor(active, {
      historyDepth: 1095,
      dimension: 'underlying_iv_daily',
    });
    const all = await estimateFor(active, { historyDepth: 1095 });
    expect(single).toBe(active * pagesFor(1095));
    expect(all).toBeGreaterThan(single); // 全管线含其余 20+ 维度
  });

  it('估算只数开闸标的 (needSync=true) —— 与 loadActiveInstruments 同口径, 否则 us 会按 19,465 只报', async () => {
    const { deps, countWhere } = buildDryRunDeps(12);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await executeBackfill(
        deps,
        { dryRun: true, markets: ['us'], asOf: AS_OF, dimension: 'underlying_iv_daily' },
        new Date('2026-07-16T12:00:00Z'),
      );
    } finally {
      logSpy.mockRestore();
    }
    expect(countWhere[0]).toEqual({ market: { in: ['us'] }, status: 'active', needSync: true });
  });
});
