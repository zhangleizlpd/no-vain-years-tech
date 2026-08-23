import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import {
  DIMENSION_KEYS,
  DimensionExecutorRegistry,
  mergeStats,
  subtractDays,
  type DimensionKey,
} from './dimension-executor.js';
import { deriveExecutionOrder, type SyncDependencyEdge } from './sync-flow-assembler.js';
import type { UnderlyingIvSnapshot } from './underlying-iv.port.js';
import type { UsIndexDailyPoint } from './us-index.port.js';
import type {
  AllotmentDto,
  AllotmentRangeQuery,
  AnnouncementDto,
  AnnouncementRangeQuery,
  BuybackDto,
  BuybackRangeQuery,
  EquityChangeDto,
  EquityChangeRangeQuery,
  ShareholderChangeDto,
  ShareholderChangeRangeQuery,
  RevenueSegmentDto,
  RevenueSegmentRangeQuery,
  ShareholderSnapshotDto,
  ShareholderSnapshotRangeQuery,
  EmployeeDto,
  EmployeeRangeQuery,
  ConnectHoldingPoint,
  ConnectHoldingRangeQuery,
  FundCompanyHoldingDto,
  FundCompanyHoldingRangeQuery,
  FundHoldingDto,
  FundHoldingRangeQuery,
  HotSnapshotDto,
  HotSnapshotQuery,
  IndexMembershipDto,
  IndustryClassificationDto,
  ShortSellingPoint,
  ShortSellingRangeQuery,
  VolatilityPoint,
  VolatilityRangeQuery,
} from './marketdata.types.js';
import { HOT_TYPES } from './lixinger-hot.adapter.js';

// 019 T004 注册表路由 (US3/FR-S07): runDimension switch 退役 → Map 注册表。6 维度逐一
// 路由断言 (meta 维度走 use case / fact 维度走对应 port) + 未注册 key 结构化报错不崩。
// 行为面 (幂等/水位/统计) 由 marketdata.dimension-worker.it.spec.ts 全量回归承载, 本 spec
// 只验路由形态 — 假依赖直实例化 (plain class, 非 Guard/Filter, 无 DI 容器必要)。

function buildFakes(opts: { marketScope?: string[]; deltaLookbackDays?: number } = {}) {
  const deps = {
    syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
    syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
    eodBar: { getBars: vi.fn(async () => []) },
    fundamental: { getFundamentals: vi.fn(async () => []) },
    financials: { getFinancials: vi.fn(async () => []) },
    corporateAction: { getCorporateActions: vi.fn(async () => []) },
    prisma: {
      syncDimension: {
        findUnique: vi.fn(async () => ({
          dimensionKey: 'any',
          enabled: true,
          cronExpr: '0 0 22 * * *',
          marketScope: opts.marketScope ?? ['cn'],
          adjustTypes: ['none'],
          batchSize: 50,
          historyDepth: null,
          retryMax: 3,
          misfirePolicy: 'fire-now',
          reAdjustLookbackDays: null,
          deltaLookbackDays: opts.deltaLookbackDays ?? null,
          pausedUntil: null,
        })),
        update: vi.fn(async () => ({})),
      },
      instrument: {
        findMany: vi.fn(async () => [{ id: 1n, market: 'cn', code: '600519' }]),
      },
      // groupBy = 补洞道 (fillRecentEodGaps) 的「窗内每标的已有几个交易日」聚合。
      dailyBar: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      // 补洞道的另一半判据: 窗内各市场应有的交易日数。空日历 ⇒ 判不出缺口 ⇒ 本道自然缩手,
      // 故本 double 返空即可让既有用例保持「只走主跑」的语义 (缩手行为本身另有 IT 专测)。
      tradingDay: { findMany: vi.fn(async () => []) },
      adjustmentFactor: { findMany: vi.fn(async () => []) }, // T010 最新因子 Map 载入。
      corporateAction: { findMany: vi.fn(async () => []) }, // T010 D2 命中检查 (水位 NULL 短路)。
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          dailyBar: { createMany: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})) },
          corporateAction: { upsert: vi.fn(async () => ({})) },
        }),
      ),
    },
    recorder: {
      start: vi.fn(async () => 1n),
      finish: vi.fn(async () => undefined),
    },
    tierRecalc: { recalcSafely: vi.fn(async () => null) },
  };
  const registry = new DimensionExecutorRegistry(
    deps.syncUniverse as never,
    deps.syncProfile as never,
    deps.eodBar as never,
    deps.fundamental as never,
    deps.financials as never,
    deps.corporateAction as never,
    deps.prisma as never,
    deps.recorder as never,
    deps.tierRecalc as never,
  );
  return { deps, registry };
}

function emptyStatsLike() {
  return { scanned: 0, ok: 0, skipped: 0, failed: 0, written: null, failedTargets: [] };
}

const input = { mode: 'delta' as const, asOf: '2026-06-05', now: new Date('2026-06-05T14:00:00Z') };

describe('019 T004 executor 注册表路由 (switch 退役 → Map)', () => {
  it('DIMENSION_KEYS 值层全集 = 6 既有 + 039 + 040 + 041 + 042 + 043 + sellput-viz 已装配维度 (注册表 key source, CLI 校验同源)', () => {
    expect([...DIMENSION_KEYS]).toEqual([
      'universe',
      'profile',
      'eod_bar',
      'us_equity_bar', // sellput-viz: us 正股日线 (独立维度 — 调度时点 + 工作集陷阱, 见 DIMENSION_KEYS 注释)
      'fundamental',
      'financial',
      'corporate_action',
      'short_selling', // 039 T006 US1
      'connect_holding', // 039 T007 US1
      'fund_holding', // 039 T011 US2
      'fund_company_holding', // 039 T012 US2
      'index_membership', // 039 T015 US3
      'volatility', // 040 T005 US1
      'hot_snapshot', // 040 T008 US2
      'buyback', // 041 T005 US1
      'equity_change', // 041 T008 US2
      'shareholder_change', // 041 T011 US3
      'allotment', // 041 T014 US4
      'revenue_segment', // 042 T005 US1
      'shareholder_snapshot', // 042 T008 US2
      'employee', // 042 T011 US3
      'industry_classification', // 043 T005 US1
      'announcement', // 043 T008 US2
      'underlying_iv_daily', // 046 T002 US3 标的级 IV 日快照 (工作集挂锚闸, FR-026)
      'us_index_daily', // 046 T002 US3 VIX/VVIX 日线 (**不挂锚闸**, 固定 2 代码, FR-027)
      'option_contract', // 047 T003 M2b 链合约发现 (per-code, 挂锚闸, FR-035)
      'option_daily_snapshot', // 047 T003 M2b 全链逐日快照 (per-code, 挂锚闸 + hard 依赖链发现, FR-031)
      'earnings_event', // 047 T003 M2b 财报日历 (**市场级接口, 不挂锚闸**, FR-035a)
      'hk_option_contract', // 066 T04 港股链合约发现 (独立维度而非给 option_contract 扩 scope, plan §A1)
      'hk_option_daily_snapshot', // 066 T04 港股全链逐日快照 (seed 时 enabled=false, FR-016)
      'hk_underlying_iv_daily', // 066 T04 港股标的级 IV 日快照 (history_depth 1095, FR-018)
    ]);
  });

  it('universe → SyncUniverseUseCase.run (meta 维度包装, 零 fact 前置)', async () => {
    const { deps, registry } = buildFakes();
    await registry.execute('universe', input);
    expect(deps.syncUniverse.run).toHaveBeenCalledTimes(1);
    expect(deps.tierRecalc.recalcSafely).not.toHaveBeenCalled();
  });

  it('profile → SyncProfileUseCase.run', async () => {
    const { deps, registry } = buildFakes();
    await registry.execute('profile', input);
    expect(deps.syncProfile.run).toHaveBeenCalledTimes(1);
  });

  it('eod_bar → EodBarPort.getBars (fact 前置: tier 重算 + dim 行 + 工作集)', async () => {
    const { deps, registry } = buildFakes();
    await registry.execute('eod_bar', input);
    expect(deps.eodBar.getBars).toHaveBeenCalled();
    expect(deps.tierRecalc.recalcSafely).toHaveBeenCalledTimes(1);
    expect(deps.prisma.syncDimension.findUnique).toHaveBeenCalled();
  });

  it('fundamental → FundamentalPort.getFundamentals', async () => {
    const { deps, registry } = buildFakes();
    await registry.execute('fundamental', input);
    expect(deps.fundamental.getFundamentals).toHaveBeenCalled();
  });

  it('financial → FinancialsPort.getFinancials', async () => {
    const { deps, registry } = buildFakes();
    await registry.execute('financial', input);
    expect(deps.financials.getFinancials).toHaveBeenCalled();
  });

  it('corporate_action → CorporateActionPort.getCorporateActions', async () => {
    const { deps, registry } = buildFakes();
    await registry.execute('corporate_action', input);
    expect(deps.corporateAction.getCorporateActions).toHaveBeenCalled();
  });

  it('index_membership → 路由存在 + 走 fact 前置 (039 T015 US3, 第 3 形态; 默认 null-object 空返回→跳过)', async () => {
    const { deps, registry } = buildFakes();
    // 默认 null-object indexMembership 返 [] → 空返回跳过 mutate (不 wipe), 计 ok; 覆盖式落库行为由下方 T015 describe 全量验。
    const { stats } = await registry.execute('index_membership', input);
    expect(deps.tierRecalc.recalcSafely).toHaveBeenCalledTimes(1); // fact 前置
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('industry_classification → 路由存在 + 走 fact 前置 (043 T005 US1, 覆盖式快照; 默认 null-object 空返回→跳过)', async () => {
    const { deps, registry } = buildFakes();
    // 默认 null-object industryClassification 返 [] → 空返回跳过 mutate (不 wipe), 计 ok; 覆盖式落库由下方 043 describe 全量验。
    const { stats } = await registry.execute('industry_classification', input);
    expect(deps.tierRecalc.recalcSafely).toHaveBeenCalledTimes(1); // fact 前置
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('hot_snapshot → 路由存在 + 走 fact 前置 (040 T008 US2, 第 2 形态; 默认 null-object → 每 type 空返回计 ok)', async () => {
    const { deps, registry } = buildFakes();
    // 默认 null-object hotSnapshot 每 type 返 [] → 零 upsert 计 ok; HOT_TYPES 循环 = scanned/ok 各 = type 数。
    const { stats } = await registry.execute('hot_snapshot', input);
    expect(deps.tierRecalc.recalcSafely).toHaveBeenCalledTimes(1); // fact 前置
    expect(stats).toMatchObject({ scanned: HOT_TYPES.length, ok: HOT_TYPES.length, failed: 0 });
  });

  it('未注册 key → 结构化报错 (SyncRun 收 failed 后上抛, 不静默; spec edge case)', async () => {
    const { deps, registry } = buildFakes();
    await expect(registry.execute('not_registered' as DimensionKey, input)).rejects.toThrow(
      /not_registered/,
    );
    // 顶层异常路径: SyncRun 行已收 failed (worker attempts 语义源, 不崩 worker)。
    // 🚨 **只有 3 个参数** —— 第 4 参 (finishedAt) 蓄意不传, 由 recorder 取真实收尾时刻;
    // 这里曾断言传 `input.now`, 那正是「finished_at ≈ started_at、耗时不可读」的来源。
    expect(deps.recorder.finish).toHaveBeenCalledWith(1n, 'failed', expect.anything());
  });

  it('测试维度注册 (SC-S05 机制半): registerExecutor 后 execute 路由到新 executor', async () => {
    const { registry } = buildFakes();
    const ran = vi.fn(async () => ({ stats: emptyStatsLike(), budgetExhausted: false }));
    registry.registerExecutor('test_dimension' as DimensionKey, ran);
    await registry.execute('test_dimension' as DimensionKey, input);
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

// 038 T001 seam#2: loadActiveInstruments 工作集从 `MARKET='cn'` 常量硬编码 → 按当前维度
// SyncDimension 行的 marketScope 列过滤 (marketScope={cn} 无回归 / ={cn,hk} 纳入 hk)。
describe('038 T001 marketScope 过滤取代 MARKET 常量 (seam#2)', () => {
  it('marketScope={cn} → 工作集 where market in [cn] (cn-only 无回归)', async () => {
    const { deps, registry } = buildFakes({ marketScope: ['cn'] });
    await registry.execute('eod_bar', input);
    expect(deps.prisma.instrument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { market: { in: ['cn'] }, status: 'active', needSync: true },
      }),
    );
  });

  it('marketScope={cn,hk} → 工作集含 hk (where market in [cn,hk])', async () => {
    const { deps, registry } = buildFakes({ marketScope: ['cn', 'hk'] });
    await registry.execute('fundamental', input);
    expect(deps.prisma.instrument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { market: { in: ['cn', 'hk'] }, status: 'active', needSync: true },
      }),
    );
  });
});

// 038 T005 seam#3: backfill --markets 经 payload → ExecutorInput.markets → 与维度 marketScope
// 取交集缩窄工作集 (运维可只回填 hk); 无 input.markets (夜间 delta) → 用全 marketScope。
describe('038 T005 backfill --markets 透传 (executor 工作集交集)', () => {
  it('input.markets={hk} ∩ marketScope={cn,hk} → 工作集只 hk', async () => {
    const { deps, registry } = buildFakes({ marketScope: ['cn', 'hk'] });
    await registry.execute('eod_bar', { ...input, markets: ['hk'] });
    expect(deps.prisma.instrument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { market: { in: ['hk'] }, status: 'active', needSync: true },
      }),
    );
  });

  it('无 input.markets (夜间 delta) → 工作集 = 全 marketScope', async () => {
    const { deps, registry } = buildFakes({ marketScope: ['cn', 'hk'] });
    await registry.execute('eod_bar', input);
    expect(deps.prisma.instrument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { market: { in: ['cn', 'hk'] }, status: 'active', needSync: true },
      }),
    );
  });
});

// fix/marketdata-backfill-createmany: fundamental/financial 区间回填 (backfill) 从逐行
// tx.upsert 改批量 `createMany({skipDuplicates:true})` 避 Prisma 默认 5s 事务超时 (prod 实证:
// 60 只长历史 hk 标的把 ~2400 行/10yr 逐行 upsert 塞单 $transaction, 6-11s 超时回滚 → 缺口)。
// 历史估值/财报不可变 → insert-only(skipDuplicates 跳已存补缺) 语义正确, 天然幂等。
// 本 spec 只验「批量 createMany 而非逐行 upsert」路由形态; 真落库/多行/幂等由 038 T014 IT 承载。
describe('fix backfill: fundamental/financial 区间回填走批量 createMany(skipDuplicates) 非逐行 upsert', () => {
  const backfillInput = {
    mode: 'backfill' as const,
    asOf: '2026-06-05',
    now: new Date('2026-06-05T14:00:00Z'),
    backfillHistoryDays: 3650,
  };

  function buildBackfillFakes(opts: { fundRows?: number; coveredFundIds?: bigint[] } = {}) {
    const fundCreateMany = vi.fn(async (_arg: unknown) => ({ count: 2 }));
    const fundUpsert = vi.fn(async () => ({}));
    const finCreateMany = vi.fn(async (_arg: unknown) => ({ count: 2 }));
    const finUpsert = vi.fn(async () => ({}));
    // skip-complete 游标查询 (coveredFundamentalIds): 默认空 = 无已覆盖股 → 不跳过;
    // 传 coveredFundIds 模拟老端已回填 → 该股本窗被跳过 (连 HTTP 都不 fetch)。
    const fundFindMany = vi.fn(async () =>
      (opts.coveredFundIds ?? []).map((id) => ({ instrumentId: id })),
    );
    // 镜像 syncEodBarNone: 单 createMany 包在 $transaction 里 → tx 上挂 createMany/upsert 双 spy
    // (断言走 createMany、不走 upsert); findMany = skip-complete 游标。
    const tx = {
      fundamentalSnapshot: {
        createMany: fundCreateMany,
        upsert: fundUpsert,
        findMany: fundFindMany,
      },
      financialMetric: { createMany: finCreateMany, upsert: finUpsert },
    };
    // fundRows 给定 → 生成 N 行 (chunk 分批断言); 否则默认 2 行 (内容用固定值断言)。
    const fundRangeRows =
      opts.fundRows != null
        ? Array.from({ length: opts.fundRows }, (_, i) => ({
            symbol: 'cn:600519',
            date: new Date(Date.UTC(2010, 0, 1 + i)).toISOString().slice(0, 10),
            peTtm: String(i),
            peStatic: null,
            peDynamic: null,
            pb: null,
            ps: null,
            dividendYield: null,
            marketCap: null,
            circMarketCap: null,
            pePctlY3: null,
            pePctlY5: null,
            pbPctlY3: null,
            pbPctlY5: null,
          }))
        : [
            {
              symbol: 'cn:600519',
              date: '2016-05-13',
              peTtm: '20.5',
              peStatic: null,
              peDynamic: null,
              pb: '1.2',
              ps: '3.4',
              dividendYield: '0.02',
              marketCap: '1000',
              circMarketCap: '900',
              pePctlY3: null,
              pePctlY5: null,
              pbPctlY3: null,
              pbPctlY5: null,
            },
            {
              symbol: 'cn:600519',
              date: '2020-06-15',
              peTtm: '21.5',
              peStatic: null,
              peDynamic: null,
              pb: '1.3',
              ps: '3.5',
              dividendYield: '0.03',
              marketCap: '2000',
              circMarketCap: '1800',
              pePctlY3: null,
              pePctlY5: null,
              pbPctlY3: null,
              pbPctlY5: null,
            },
          ];
    const fundRange = vi.fn(async () => fundRangeRows);
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: {
        getFundamentals: vi.fn(async () => []),
        getFundamentalsRange: fundRange,
      },
      financials: {
        getFinancials: vi.fn(async () => []),
        getFinancialsRange: vi.fn(async () => [
          {
            symbol: 'cn:600519',
            reportPeriod: '2024Q4',
            roe: '0.20',
            grossMargin: null,
            eps: '1.5',
            bps: '10',
          },
          {
            symbol: 'cn:600519',
            reportPeriod: '2025Q2',
            roe: '0.21',
            grossMargin: null,
            eps: '1.6',
            bps: '11',
          },
        ]),
      },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'any',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['cn'],
            adjustTypes: ['none'],
            batchSize: 50,
            historyDepth: null,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'cn', code: '600519' }]),
        },
        fundamentalSnapshot: tx.fundamentalSnapshot,
        financialMetric: tx.financialMetric,
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      },
      recorder: {
        start: vi.fn(async () => 1n),
        finish: vi.fn(async () => undefined),
      },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
    );
    return {
      registry,
      spies: { fundCreateMany, fundUpsert, finCreateMany, finUpsert, fundRange, fundFindMany },
    };
  }

  it('fundamental backfill → fundamentalSnapshot.createMany({skipDuplicates:true}) 一次批量, 不逐行 upsert', async () => {
    const { registry, spies } = buildBackfillFakes();
    const { stats } = await registry.execute('fundamental', backfillInput);

    expect(spies.fundUpsert).not.toHaveBeenCalled();
    expect(spies.fundCreateMany).toHaveBeenCalledTimes(1);
    const arg = spies.fundCreateMany.mock.calls[0][0] as unknown as {
      skipDuplicates: boolean;
      data: { instrumentId: bigint; peTtm: string | null }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({ instrumentId: 1n, peTtm: '20.5' });
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('financial backfill → financialMetric.createMany({skipDuplicates:true}) 一次批量, 不逐行 upsert', async () => {
    const { registry, spies } = buildBackfillFakes();
    const { stats } = await registry.execute('financial', backfillInput);

    expect(spies.finUpsert).not.toHaveBeenCalled();
    expect(spies.finCreateMany).toHaveBeenCalledTimes(1);
    const arg = spies.finCreateMany.mock.calls[0][0] as unknown as {
      skipDuplicates: boolean;
      data: { instrumentId: bigint; reportPeriod: string; roe: string | null }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({ instrumentId: 1n, reportPeriod: '2024Q4', roe: '0.20' });
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  // incident 2026-07-12 P1: 单条 createMany 塞全股历史 → 全量重跑在 1.6GB host 累积 OOM。
  // 加固① 行分批 (BACKFILL_ROW_CHUNK=500): 单股 >500 行按 500 chunk, 每片一 createMany/一 $transaction
  // (封顶事务时长避 5s 超时 + 单批内存避 OOM)。
  it('fundamental backfill: 单股 >BACKFILL_ROW_CHUNK(500) 行 → 按 500 分批, 每批一 createMany', async () => {
    const { registry, spies } = buildBackfillFakes({ fundRows: 1200 });
    const { stats } = await registry.execute('fundamental', backfillInput);

    // 1200 行 → ceil(1200/500)=3 批 (500+500+200), 每批各一次 createMany。
    expect(spies.fundCreateMany).toHaveBeenCalledTimes(3);
    const lens = spies.fundCreateMany.mock.calls.map(
      (c) => (c[0] as unknown as { data: unknown[] }).data.length,
    );
    expect(lens).toEqual([500, 500, 200]);
    for (const c of spies.fundCreateMany.mock.calls) {
      expect((c[0] as unknown as { skipDuplicates: boolean }).skipDuplicates).toBe(true);
    }
    expect(stats).toMatchObject({ scanned: 1, ok: 1, skipped: 0, failed: 0 });
  });

  // 加固② skip-complete 游标: 老端 (date<=from) 已回填的股本窗跳过 — 连 HTTP 都省, 计 skipped。
  // 补 60 缺口时只 fetch+写缺口股, 不再全 2781 股扫 → 避 OOM (incident #5 正解)。
  it('fundamental backfill skip-complete: 老端已覆盖股跳过 — 不 fetch、不 createMany、计 skipped', async () => {
    const { registry, spies } = buildBackfillFakes({ coveredFundIds: [1n] });
    const { stats } = await registry.execute('fundamental', backfillInput);

    expect(spies.fundRange).not.toHaveBeenCalled();
    expect(spies.fundCreateMany).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0, skipped: 1, failed: 0 });
  });

  // --no-skip-complete (force-refetch): 绕过 skip-complete 游标 — 老端已覆盖股也重拉重写。补
  // 中段缺口场景 (044 日历停摆致某日全维缺行, 如 fundamental 07-15): 缺口股「老端有行」→ 默认
  // 被 skip-complete 误跳, 永补不上; force 模式全股重扫, skipDuplicates 兜已存只写缺日。
  it('fundamental backfill noSkipComplete=true: 老端已覆盖股也 fetch+createMany, 不跳过', async () => {
    const { registry, spies } = buildBackfillFakes({ coveredFundIds: [1n] });
    const { stats } = await registry.execute('fundamental', {
      ...backfillInput,
      noSkipComplete: true,
    });

    expect(spies.fundRange).toHaveBeenCalledTimes(1); // 覆盖股仍 fetch (强制重扫)
    expect(spies.fundCreateMany).toHaveBeenCalled(); // 仍写 (skipDuplicates 兜已存补缺)
    expect(stats).toMatchObject({ scanned: 1, ok: 1, skipped: 0, failed: 0 });
  });
});

// 039 T006 US1: short_selling 装配 (照抄 eod_bar 区间形态)。验路由 + delta/backfill 的 from 分支 +
// createMany(skipDuplicates) 幂等形态 + delta pending-skip。真落库/多行/幂等由 T008 Testcontainers IT。
describe('039 T006 short_selling 装配 (mode 分 from + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  function buildShortSellingFakes(
    opts: { rangeRows?: ShortSellingPoint[]; doneIds?: bigint[]; historyDepth?: number } = {},
  ) {
    const ssCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingShortSellingInstruments 游标: doneIds 已落当日 → 该股 delta 跳过。
    const ssFindMany = vi.fn(async () => (opts.doneIds ?? []).map((id) => ({ instrumentId: id })));
    const getShortSellingRange = vi.fn(
      async (_q: ShortSellingRangeQuery) =>
        opts.rangeRows ?? [{ date: '2020-06-15', shares: '100', amount: '200' }],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      shortSelling: { getShortSellingRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'short_selling',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        shortSellingDaily: { findMany: ssFindMany, createMany: ssCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ shortSellingDaily: { createMany: ssCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      deps.shortSelling as never,
    );
    return { registry, spies: { ssCreateMany, ssFindMany, getShortSellingRange } };
  }

  it('short_selling delta → getShortSellingRange(from=asOf 单日) + pending 游标查', async () => {
    const { registry, spies } = buildShortSellingFakes();
    const { stats } = await registry.execute('short_selling', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.ssFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    expect(spies.getShortSellingRange).toHaveBeenCalledTimes(1);
    const q = spies.getShortSellingRange.mock.calls[0][0];
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单日)
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('short_selling delta pending-skip: 本日已落行标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildShortSellingFakes({ doneIds: [1n] });
    const { stats } = await registry.execute('short_selling', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getShortSellingRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('short_selling backfill → from=asOf−historyDepth + shortSellingDaily.createMany({skipDuplicates}) 批量', async () => {
    const { registry, spies } = buildShortSellingFakes({
      rangeRows: [
        { date: '2016-06-15', shares: '100', amount: '200' },
        { date: '2020-06-15', shares: '300', amount: '400' },
      ],
    });
    const { stats } = await registry.execute('short_selling', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.ssFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    const q = spies.getShortSellingRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth
    const arg = spies.ssCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: { instrumentId: bigint; shares: string | null }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({ instrumentId: 1n, shares: '100' });
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 039 T007 US1: connect_holding 装配 (同 short_selling 形态)。验路由 + backfill createMany +
// **非港股通标的空返回 → 零 createMany、stats.ok 非 failed** (spec state_branch「南向非成分标的空数据」)。
describe('039 T007 connect_holding 装配 (空返回容错 + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  function buildConnectHoldingFakes(
    opts: {
      rangeRows?: ConnectHoldingPoint[];
      /** 默认 7 = 20260801_2248 migration 给本维度 seed 的值 (fixture 镜像真 seed)。 */
      deltaLookbackDays?: number | null;
      /** 游标已落行的标的 (验有回看窗时不走游标)。 */
      cursorDone?: { instrumentId: bigint }[];
    } = {},
  ) {
    const chCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    const chFindMany = vi.fn(async () => opts.cursorDone ?? ([] as { instrumentId: bigint }[]));
    const getConnectHoldingRange = vi.fn(
      async (_q: ConnectHoldingRangeQuery) =>
        opts.rangeRows ?? [{ date: '2020-06-15', shareholdings: '1000' }],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      connectHolding: { getConnectHoldingRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'connect_holding',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: opts.deltaLookbackDays === undefined ? 7 : opts.deltaLookbackDays,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '08001' }]),
        },
        connectHoldingDaily: { findMany: chFindMany, createMany: chCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ connectHoldingDaily: { createMany: chCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      deps.connectHolding as never,
    );
    return { registry, spies: { chCreateMany, getConnectHoldingRange } };
  }

  it('connect_holding backfill → connectHoldingDaily.createMany({skipDuplicates}) 批量', async () => {
    const { registry, spies } = buildConnectHoldingFakes({
      rangeRows: [
        { date: '2020-06-15', shareholdings: '1000' },
        { date: '2020-06-16', shareholdings: '1100' },
      ],
    });
    const { stats } = await registry.execute('connect_holding', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    const arg = spies.chCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: { instrumentId: bigint; shareholdings: string | null }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({ instrumentId: 1n, shareholdings: '1000' });
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('非港股通标的 vendor 返 [] → 零 createMany、stats.ok 非 failed', async () => {
    const { registry, spies } = buildConnectHoldingFakes({ rangeRows: [] });
    const { stats } = await registry.execute('connect_holding', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.getConnectHoldingRange).toHaveBeenCalledTimes(1); // 仍 fetch
    expect(spies.chCreateMany).not.toHaveBeenCalled(); // 空 → 零 createMany
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 }); // ok 非 failed
  });

  // T+1 bug fix: 南向持股 vendor T+1 披露 (夜间 22:00 tick 拉当日 D → 数据未发布 → 每晚 0 行 →
  // connect_holding_daily 永空, prod 实证)。delta from 回看 `dim.deltaLookbackDays` 天补昨日已发布行,
  // 覆盖周末夹缝; uk(instrumentId,date)+skipDuplicates 幂等去重。窗宽 2026-08-01 由硬编码常量 3
  // 改为声明式列 (seed 7) —— 同病维度另有 announcement/buyback/shareholder_change/allotment。
  it('delta → from 回看 dim.deltaLookbackDays 天 ([asOf−7, asOf], 镜像 seed 值)', async () => {
    const { registry, spies } = buildConnectHoldingFakes({
      rangeRows: [{ date: '2026-06-04', shareholdings: '1000' }], // 昨日已发布行
    });
    const { stats } = await registry.execute('connect_holding', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    const q = spies.getConnectHoldingRange.mock.calls[0][0] as ConnectHoldingRangeQuery;
    expect(q.from).toBe('2026-05-29'); // asOf − 7
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  // 负向: 列为 NULL ⇒ 精确当日 (from=to=asOf) —— 即本次改动前的全仓行为。这条守住「未列入 seed
  // 的维度逐行零变化」这个 migration 的核心承诺, 也是 deltaFrom 的分支覆盖。
  it('delta + deltaLookbackDays=NULL → from=to=asOf (精确当日, 改动前行为不变)', async () => {
    const { registry, spies } = buildConnectHoldingFakes({
      deltaLookbackDays: null,
      rangeRows: [{ date: '2026-06-05', shareholdings: '1000' }],
    });
    await registry.execute('connect_holding', { mode: 'delta', asOf: '2026-06-05', now: NOW });
    const q = spies.getConnectHoldingRange.mock.calls[0][0] as ConnectHoldingRangeQuery;
    expect(q.from).toBe('2026-06-05');
    expect(q.to).toBe('2026-06-05');
  });

  // 「本目标日已落行则跳过」游标的前提只在精确当日窗下成立: 有回看窗时窗内还有 asOf−N…asOf−1
  // 要补, 拿 asOf 单日判「已完成」会把整只标的跳掉 → 窗口内留洞。故有窗时不走游标。
  it('有回看窗 → 不走 pending 游标 (即便 asOf 当日已落行仍重取整窗)', async () => {
    const { registry, spies } = buildConnectHoldingFakes({
      cursorDone: [{ instrumentId: 1n }], // 游标视角: 该标的 asOf 当日已落行
      rangeRows: [{ date: '2026-06-01', shareholdings: '1000' }],
    });
    await registry.execute('connect_holding', { mode: 'delta', asOf: '2026-06-05', now: NOW });
    expect(spies.getConnectHoldingRange).toHaveBeenCalledTimes(1); // 未被游标跳过
  });

  it('无回看窗 → 游标恢复生效 (asOf 当日已落行的标的跳过, 零 vendor 调用)', async () => {
    const { registry, spies } = buildConnectHoldingFakes({
      deltaLookbackDays: null,
      cursorDone: [{ instrumentId: 1n }],
    });
    await registry.execute('connect_holding', { mode: 'delta', asOf: '2026-06-05', now: NOW });
    expect(spies.getConnectHoldingRange).not.toHaveBeenCalled();
  });
});

// 039 T011 US2: fund_holding 装配 (行处理照 backfillFinancials + chunked; from 按 mode 算)。验路由 +
// backfill from=asOf−historyDepth(1825) + createMany(skipDuplicates) 报告期×基金 + 缺字段 null 透传 +
// 大表按 BACKFILL_ROW_CHUNK 分片。真落库/多期多基金/幂等由 T013 Testcontainers IT。
describe('039 T011 fund_holding 装配 (backfill from + chunked createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');
  const backfillInput = {
    mode: 'backfill' as const,
    asOf: '2026-06-05',
    now: NOW,
    backfillHistoryDays: 1825,
  };

  const fhRow = (over: Partial<FundHoldingDto> = {}): FundHoldingDto => ({
    reportDate: '2025-03-31',
    fundCode: '513050',
    name: '基金A',
    holdings: '100',
    marketCap: '200',
    netValueRatio: '0.3',
    marketCapRank: 1,
    declarationDate: '2025-04-22',
    proportionOutstandingSharesA: null,
    ...over,
  });

  function buildFundHoldingFakes(
    opts: { rangeRows?: FundHoldingDto[]; historyDepth?: number } = {},
  ) {
    const fhCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    const getFundHoldingRange = vi.fn(
      async (_q: FundHoldingRangeQuery) => opts.rangeRows ?? [fhRow()],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      fundHolding: { getFundHoldingRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'fund_holding',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 1825,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        fundHolding: { createMany: fhCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ fundHolding: { createMany: fhCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      deps.fundHolding as never,
    );
    return { registry, spies: { fhCreateMany, getFundHoldingRange } };
  }

  it('fund_holding backfill → from=asOf−1825 + fundHolding.createMany({skipDuplicates}) 报告期×基金落库', async () => {
    const { registry, spies } = buildFundHoldingFakes({
      rangeRows: [
        fhRow({ fundCode: '513050', marketCapRank: 1 }),
        fhRow({
          fundCode: '110011',
          name: '基金B',
          holdings: '300',
          marketCapRank: 2,
          declarationDate: null,
        }),
      ],
    });
    const { stats } = await registry.execute('fund_holding', backfillInput);

    const q = spies.getFundHoldingRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(1825); // from = asOf − historyDepth (近 5 年)
    const arg = spies.fhCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: {
        instrumentId: bigint;
        reportDate: Date;
        fundCode: string;
        marketCapRank: number | null;
      }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2); // 同报告期 2 基金
    expect(arg.data[0]).toMatchObject({ instrumentId: 1n, fundCode: '513050', marketCapRank: 1 });
    expect(arg.data[0].reportDate).toBeInstanceOf(Date); // reportDate→Date, declarationDate 可空
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('缺字段 (holdings/marketCapRank/declarationDate 缺) → null 透传落库, 不崩', async () => {
    const { registry, spies } = buildFundHoldingFakes({
      rangeRows: [
        fhRow({
          name: null,
          holdings: null,
          marketCap: null,
          netValueRatio: null,
          marketCapRank: null,
          declarationDate: null,
        }),
      ],
    });
    const { stats } = await registry.execute('fund_holding', backfillInput);
    const arg = spies.fhCreateMany.mock.calls[0][0] as {
      data: {
        holdings: string | null;
        marketCapRank: number | null;
        declarationDate: Date | null;
      }[];
    };
    expect(arg.data[0]).toMatchObject({
      holdings: null,
      marketCapRank: null,
      declarationDate: null,
    });
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('大表分片: 单股 >BACKFILL_ROW_CHUNK(500) 行 → 按 500 分批, 每批一 createMany', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => fhRow({ fundCode: String(100000 + i) }));
    const { registry, spies } = buildFundHoldingFakes({ rangeRows: rows });
    await registry.execute('fund_holding', backfillInput);
    expect(spies.fhCreateMany).toHaveBeenCalledTimes(3); // ceil(1200/500)=3 批
    const lens = spies.fhCreateMany.mock.calls.map(
      (c) => (c[0] as { data: unknown[] }).data.length,
    );
    expect(lens).toEqual([500, 500, 200]);
  });
});

// 039 T012 US2: fund_company_holding 装配 (同 fund_holding 形态, uk 换 fundCollectionCode)。验路由 +
// backfill from=asOf−historyDepth(1825) + createMany(skipDuplicates) 报告期×基金公司 + 分片。
// 真落库/幂等由 T013 Testcontainers IT。
describe('039 T012 fund_company_holding 装配 (backfill from + chunked createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');
  const backfillInput = {
    mode: 'backfill' as const,
    asOf: '2026-06-05',
    now: NOW,
    backfillHistoryDays: 1825,
  };

  const fchRow = (over: Partial<FundCompanyHoldingDto> = {}): FundCompanyHoldingDto => ({
    reportDate: '2025-03-31',
    fundCollectionCode: '14240000',
    name: '中信证券资产管理有限公司',
    holdings: '690600',
    marketCap: '320952688',
    ...over,
  });

  function buildFundCompanyHoldingFakes(opts: { rangeRows?: FundCompanyHoldingDto[] } = {}) {
    const fchCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    const getFundCompanyHoldingRange = vi.fn(
      async (_q: FundCompanyHoldingRangeQuery) => opts.rangeRows ?? [fchRow()],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      fundCompanyHolding: { getFundCompanyHoldingRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'fund_company_holding',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: 1825,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        fundCompanyHolding: { createMany: fchCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ fundCompanyHolding: { createMany: fchCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      deps.fundCompanyHolding as never,
    );
    return { registry, spies: { fchCreateMany, getFundCompanyHoldingRange } };
  }

  it('fund_company_holding backfill → from=asOf−1825 + createMany({skipDuplicates}) 报告期×基金公司', async () => {
    const { registry, spies } = buildFundCompanyHoldingFakes({
      rangeRows: [
        fchRow({ fundCollectionCode: '14240000' }),
        fchRow({ fundCollectionCode: '80020000', name: '博时基金', holdings: '500' }),
      ],
    });
    const { stats } = await registry.execute('fund_company_holding', backfillInput);

    const q = spies.getFundCompanyHoldingRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(1825);
    const arg = spies.fchCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: { instrumentId: bigint; reportDate: Date; fundCollectionCode: string }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({ instrumentId: 1n, fundCollectionCode: '14240000' });
    expect(arg.data[0].reportDate).toBeInstanceOf(Date);
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('缺字段 (marketCap/holdings/name 缺) → null 透传落库, 不崩', async () => {
    const { registry, spies } = buildFundCompanyHoldingFakes({
      rangeRows: [fchRow({ name: null, holdings: null, marketCap: null })],
    });
    const { stats } = await registry.execute('fund_company_holding', backfillInput);
    const arg = spies.fchCreateMany.mock.calls[0][0] as {
      data: { name: string | null; holdings: string | null; marketCap: string | null }[];
    };
    expect(arg.data[0]).toMatchObject({ name: null, holdings: null, marketCap: null });
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 039 T015 US3: index_membership 装配 (第 3 形态, 无 mode 分支)。验路由 + 覆盖式 (单 tx 内
// deleteMany({instrumentId})+createMany(newSet)) + 空返回不 wipe (interim, T019 定) + vendor 抛错不 mutate。
// 真落库覆盖式/幂等由 T016 Testcontainers IT。
describe('039 T015 index_membership 装配 (覆盖式 deleteMany+createMany + 空返回不 wipe + 抛错不 mutate)', () => {
  // 复用模块级 input (delta, 2026-06-05); index_membership 无 mode 分支, mode 值不影响行为。
  const imRow = (over: Partial<IndexMembershipDto> = {}): IndexMembershipDto => ({
    indexCode: '1000001',
    name: '恒生指数',
    source: 'lxri',
    areaCode: 'hk',
    ...over,
  });

  function buildIndexMembershipFakes(opts: { rows?: IndexMembershipDto[]; throws?: boolean } = {}) {
    const imDeleteMany = vi.fn(async (_arg: unknown) => ({ count: 0 }));
    const imCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    const getIndexMembership = vi.fn(async (_symbol: string) => {
      if (opts.throws) throw new Error('vendor 500');
      return opts.rows ?? [imRow()];
    });
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      indexMembership: { getIndexMembership },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'index_membership',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: null, // 快照, 无 history_depth
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        indexMembership: { deleteMany: imDeleteMany, createMany: imCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ indexMembership: { deleteMany: imDeleteMany, createMany: imCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      deps.indexMembership as never,
    );
    return { registry, spies: { imDeleteMany, imCreateMany, getIndexMembership } };
  }

  it('覆盖式: 非空快照 → 单 tx 内 deleteMany({instrumentId}) + createMany(newSet, skipDuplicates)', async () => {
    const { registry, spies } = buildIndexMembershipFakes({
      rows: [
        imRow({ indexCode: '1000001', name: '恒生指数' }),
        imRow({ indexCode: '1000015', name: '港股全指' }),
      ],
    });
    const { stats } = await registry.execute('index_membership', input);

    // 第 3 形态: 无 range/from/to, port 只收 symbol (单数)。
    expect(spies.getIndexMembership).toHaveBeenCalledTimes(1);
    expect(spies.getIndexMembership.mock.calls[0][0]).toBe('hk:00700');
    // 覆盖式: deleteMany 先清本股旧归属 + createMany 灌当前快照。
    expect(spies.imDeleteMany).toHaveBeenCalledTimes(1);
    expect(spies.imDeleteMany.mock.calls[0][0]).toMatchObject({ where: { instrumentId: 1n } });
    const arg = spies.imCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: { instrumentId: bigint; indexCode: string; name: string | null }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({ instrumentId: 1n, indexCode: '1000001' });
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('空返回 → 不 deleteMany (不 wipe 既有归属)、不 createMany, 计 ok (interim, plan Deferred-probe #2)', async () => {
    const { registry, spies } = buildIndexMembershipFakes({ rows: [] });
    const { stats } = await registry.execute('index_membership', input);
    expect(spies.getIndexMembership).toHaveBeenCalledTimes(1); // 仍 fetch
    expect(spies.imDeleteMany).not.toHaveBeenCalled(); // 关键: 空返回不清库
    expect(spies.imCreateMany).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 }); // ok 非 failed
  });

  it('vendor 抛错 → 捕获计 failed、不 mutate (deleteMany/createMany 均不调; 旧归属保留)', async () => {
    const { registry, spies } = buildIndexMembershipFakes({ throws: true });
    const { stats } = await registry.execute('index_membership', input);
    expect(spies.imDeleteMany).not.toHaveBeenCalled(); // 抛错不 mutate
    expect(spies.imCreateMany).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 1, ok: 0, failed: 1 });
  });
});

// 043 T005 US1: industry_classification 装配 (覆盖式快照, 照抄 index_membership; 无 mode/无 date)。验路由 +
// 覆盖式 (单 tx 内 deleteMany({instrumentId})+createMany(newSet)) + 多层级行落库 (3 级层级 3 行) + 空返回不 wipe
// (interim, plan Decision 3) + vendor 抛错不 mutate + NK 组件 source/industryCode 缺失落 sentinel ''。
// 真落库覆盖式/幂等由 T006 Testcontainers IT。
describe('043 T005 industry_classification 装配 (覆盖式 deleteMany+createMany + 3 级层级 + 空返回不 wipe + 抛错不 mutate)', () => {
  // 复用模块级 input (delta); industry_classification 无 mode 分支, mode 值不影响行为。
  const icRow = (over: Partial<IndustryClassificationDto> = {}): IndustryClassificationDto => ({
    source: 'hsi',
    industryCode: 'H70',
    name: '资讯科技业',
    areaCode: 'hk',
    ...over,
  });

  function buildIndustryClassificationFakes(
    opts: { rows?: IndustryClassificationDto[]; throws?: boolean } = {},
  ) {
    const icDeleteMany = vi.fn(async (_arg: unknown) => ({ count: 0 }));
    const icCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    const getIndustryClassification = vi.fn(async (_symbol: string) => {
      if (opts.throws) throw new Error('vendor 500');
      return opts.rows ?? [icRow()];
    });
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      industryClassification: { getIndustryClassification },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'industry_classification',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: null, // 覆盖式快照, 无 history_depth
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        industryClassification: { deleteMany: icDeleteMany, createMany: icCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ industryClassification: { deleteMany: icDeleteMany, createMany: icCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      undefined, // revenueSegment → 默认 null-object
      undefined, // shareholderSnapshot → 默认 null-object
      undefined, // employee → 默认 null-object
      deps.industryClassification as never, // industryClassification (尾部)
    );
    return { registry, spies: { icDeleteMany, icCreateMany, getIndustryClassification } };
  }

  it('覆盖式: 非空 3 级层级快照 → 单 tx 内 deleteMany({instrumentId}) + createMany(newSet, skipDuplicates), 3 行全落', async () => {
    const { registry, spies } = buildIndustryClassificationFakes({
      rows: [
        icRow({ industryCode: 'H70', name: '资讯科技业' }),
        icRow({ industryCode: 'H7020', name: '软件与服务' }),
        icRow({ industryCode: 'H702015', name: '互联网软件与服务' }),
      ],
    });
    const { stats } = await registry.execute('industry_classification', input);

    // 覆盖式快照: 无 range/from/to, port 只收 symbol (单数)。
    expect(spies.getIndustryClassification).toHaveBeenCalledTimes(1);
    expect(spies.getIndustryClassification.mock.calls[0][0]).toBe('hk:00700');
    // 覆盖式: deleteMany 先清本股旧归属 + createMany 灌当前快照。
    expect(spies.icDeleteMany).toHaveBeenCalledTimes(1);
    expect(spies.icDeleteMany.mock.calls[0][0]).toMatchObject({ where: { instrumentId: 1n } });
    const arg = spies.icCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: { instrumentId: bigint; source: string; industryCode: string; name: string | null }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(3); // 3 级层级 3 行全落
    expect(arg.data[0]).toMatchObject({ instrumentId: 1n, source: 'hsi', industryCode: 'H70' });
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it("NK 组件缺失 (source/industryCode 为 null) → 落 sentinel '' (DB 列 NOT NULL, plan Decision 3)", async () => {
    const { registry, spies } = buildIndustryClassificationFakes({
      rows: [icRow({ source: null, industryCode: null, name: null, areaCode: null })],
    });
    await registry.execute('industry_classification', input);
    const arg = spies.icCreateMany.mock.calls[0][0] as {
      data: {
        source: string;
        industryCode: string;
        name: string | null;
        areaCode: string | null;
      }[];
    };
    expect(arg.data[0]).toMatchObject({
      source: '', // NK 组件缺失 → sentinel ''
      industryCode: '', // NK 组件缺失 → sentinel ''
      name: null, // 非 NK → 落 null
      areaCode: null,
    });
  });

  it('空返回 → 不 deleteMany (不 wipe 既有归属)、不 createMany, 计 ok (interim, plan Decision 3)', async () => {
    const { registry, spies } = buildIndustryClassificationFakes({ rows: [] });
    const { stats } = await registry.execute('industry_classification', input);
    expect(spies.getIndustryClassification).toHaveBeenCalledTimes(1); // 仍 fetch
    expect(spies.icDeleteMany).not.toHaveBeenCalled(); // 关键: 空返回不清库
    expect(spies.icCreateMany).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 }); // ok 非 failed
  });

  it('vendor 抛错 → 捕获计 failed、不 mutate (deleteMany/createMany 均不调; 旧归属保留)', async () => {
    const { registry, spies } = buildIndustryClassificationFakes({ throws: true });
    const { stats } = await registry.execute('industry_classification', input);
    expect(spies.icDeleteMany).not.toHaveBeenCalled(); // 抛错不 mutate
    expect(spies.icCreateMany).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 1, ok: 0, failed: 1 });
  });
});

// 043 T008 US2: announcement 装配 (照抄 041 buyback 区间形态)。验路由 + delta/backfill 的 from 分支 +
// createMany(skipDuplicates) 幂等形态 + delta pending-skip + 元数据列 (linkUrl/linkText/linkType/types text[]) +
// 同 date 多 linkUrl 不折叠 + 缺字段 null / 空 types [] + 空返回容错。真落库/多 date/幂等由 T009 Testcontainers IT。
describe('043 T008 announcement 装配 (mode 分 from + 元数据列 + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  const FIXTURE_ROW: AnnouncementDto = {
    date: '2024-12-30',
    linkUrl: 'https://mock.hkexnews/2024/1230/a.pdf',
    linkText: '翌日披露报表',
    linkType: 'PDF',
    types: ['ndd_r'],
  };

  function buildAnnouncementFakes(
    opts: { rangeRows?: AnnouncementDto[]; doneIds?: bigint[]; historyDepth?: number } = {},
  ) {
    const anCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingAnnouncementInstruments 游标: doneIds 已落当日 → 该股 delta 跳过。
    const anFindMany = vi.fn(async () => (opts.doneIds ?? []).map((id) => ({ instrumentId: id })));
    const getAnnouncementRange = vi.fn(
      async (_q: AnnouncementRangeQuery) => opts.rangeRows ?? [FIXTURE_ROW],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      announcement: { getAnnouncementRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'announcement',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        announcement: { findMany: anFindMany, createMany: anCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ announcement: { createMany: anCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      undefined, // revenueSegment → 默认 null-object
      undefined, // shareholderSnapshot → 默认 null-object
      undefined, // employee → 默认 null-object
      undefined, // industryClassification → 默认 null-object
      deps.announcement as never, // announcement (尾部)
    );
    return { registry, spies: { anCreateMany, anFindMany, getAnnouncementRange } };
  }

  it('announcement delta → getAnnouncementRange(from=asOf 单日) + pending 游标查 + per-stock 单 symbol', async () => {
    const { registry, spies } = buildAnnouncementFakes();
    const { stats } = await registry.execute('announcement', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.anFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    expect(spies.getAnnouncementRange).toHaveBeenCalledTimes(1);
    const q = spies.getAnnouncementRange.mock.calls[0][0];
    expect(q.symbol).toBe('hk:00700'); // per-stock 单 symbol (单数 stockCode 契约)
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单日)
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('announcement delta pending-skip: 本日已落行标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildAnnouncementFakes({ doneIds: [1n] });
    const { stats } = await registry.execute('announcement', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getAnnouncementRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('announcement backfill → from=asOf−historyDepth(3650, ≤10yr) + announcement.createMany({skipDuplicates}) + 元数据列 (linkUrl/types text[])', async () => {
    const { registry, spies } = buildAnnouncementFakes({
      rangeRows: [
        FIXTURE_ROW,
        { ...FIXTURE_ROW, date: '2020-06-15', linkUrl: 'https://mock.hkexnews/2020/0615/x.pdf' },
      ],
    });
    const { stats } = await registry.execute('announcement', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.anFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    const q = spies.getAnnouncementRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth (≤10yr 硬上限内)
    const arg = spies.anCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: {
        instrumentId: bigint;
        date: Date;
        linkUrl: string;
        linkText: string | null;
        linkType: string | null;
        types: string[];
      }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0].instrumentId).toBe(1n);
    expect(arg.data[0].linkUrl).toBe('https://mock.hkexnews/2024/1230/a.pdf'); // NK 判别字段
    expect(arg.data[0].linkText).toBe('翌日披露报表');
    expect(arg.data[0].linkType).toBe('PDF');
    expect(arg.data[0].types).toEqual(['ndd_r']); // text[] 列直落
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('同 date 多 linkUrl → 各成行不折叠 (NK instrumentId,date,linkUrl; linkUrl 天然唯一)', async () => {
    const { registry, spies } = buildAnnouncementFakes({
      rangeRows: [
        FIXTURE_ROW,
        { ...FIXTURE_ROW, linkUrl: 'https://mock.hkexnews/2024/1230/b.pdf', types: ['mr'] },
      ],
    });
    await registry.execute('announcement', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    const arg = spies.anCreateMany.mock.calls[0][0] as {
      data: { date: Date; linkUrl: string }[];
    };
    // 同 date (2024-12-30) 不同 linkUrl → 两行都进 createMany (skipDuplicates 只折叠同 linkUrl)。
    expect(arg.data).toHaveLength(2);
    expect(arg.data.map((r) => r.linkUrl).sort()).toEqual([
      'https://mock.hkexnews/2024/1230/a.pdf',
      'https://mock.hkexnews/2024/1230/b.pdf',
    ]);
  });

  it('缺 linkText/linkType → null 落库; 缺/空 types → 空数组 [] (不崩)', async () => {
    const { registry, spies } = buildAnnouncementFakes({
      rangeRows: [{ ...FIXTURE_ROW, linkText: null, linkType: null, types: [] }],
    });
    await registry.execute('announcement', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    const arg = spies.anCreateMany.mock.calls[0][0] as {
      data: { linkText: string | null; linkType: string | null; types: string[] }[];
    };
    expect(arg.data[0].linkText).toBeNull();
    expect(arg.data[0].linkType).toBeNull();
    expect(arg.data[0].types).toEqual([]);
  });

  it('空返回零行 → 零 createMany、计 ok 非 failed (无公告标的不崩)', async () => {
    const { registry, spies } = buildAnnouncementFakes({ rangeRows: [] });
    const { stats } = await registry.execute('announcement', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.getAnnouncementRange).toHaveBeenCalledTimes(1); // 仍 fetch
    expect(spies.anCreateMany).not.toHaveBeenCalled(); // chunked([]) 空 → 零 createMany
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 040 T005 US1: volatility 装配 (照抄 eod_bar 区间形态 × VOLATILITY_WINDOWS 多窗口循环)。验路由 +
// delta/backfill 的 from 分支 + 每窗口一次 getVolatilityRange (3 次) + createMany 行含 volatilityDays +
// delta 多窗口 pending-skip (全窗覆盖才跳)。真落库/多窗口成行/幂等由 T006 Testcontainers IT。
describe('040 T005 volatility 装配 (mode 分 from + 多窗口循环 + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  function buildVolatilityFakes(
    opts: {
      rangeRows?: VolatilityPoint[];
      /** delta pending 游标: instrumentId → 已落窗口集 (全窗覆盖 = 已同步跳过)。 */
      doneWindowsById?: Map<bigint, number[]>;
      historyDepth?: number;
    } = {},
  ) {
    const vlCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingVolatilityInstruments: 展平 doneWindowsById → [{instrumentId, volatilityDays}]。
    const doneRows: { instrumentId: bigint; volatilityDays: number }[] = [];
    for (const [instrumentId, windows] of opts.doneWindowsById ?? new Map()) {
      for (const w of windows) doneRows.push({ instrumentId, volatilityDays: w });
    }
    const vlFindMany = vi.fn(async () => doneRows);
    const getVolatilityRange = vi.fn(
      async (_q: VolatilityRangeQuery) => opts.rangeRows ?? [{ date: '2020-06-15', value: '0.25' }],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      volatility: { getVolatilityRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'volatility',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        volatilityDaily: { findMany: vlFindMany, createMany: vlCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ volatilityDaily: { createMany: vlCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      deps.volatility as never, // volatility (尾部)
    );
    return { registry, spies: { vlCreateMany, vlFindMany, getVolatilityRange } };
  }

  it('volatility delta → 每窗口一次 getVolatilityRange (3 窗口=3 次, from=asOf 单日) + pending 游标查', async () => {
    const { registry, spies } = buildVolatilityFakes();
    const { stats } = await registry.execute('volatility', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.vlFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    // 多窗口: VOLATILITY_WINDOWS=[30,60,250] → 每窗口一次独立请求 = 3 次。
    expect(spies.getVolatilityRange).toHaveBeenCalledTimes(3);
    const windows = spies.getVolatilityRange.mock.calls
      .map((c) => c[0].volatilityDays)
      .sort((a, b) => a - b);
    expect(windows).toEqual([30, 60, 250]);
    const q = spies.getVolatilityRange.mock.calls[0][0];
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单日)
    expect(q.to).toBe('2026-06-05');
    expect(typeof q.volatilityDays).toBe('number'); // 单数 number
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('volatility delta pending-skip: 本日已落全部 3 窗口标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildVolatilityFakes({
      doneWindowsById: new Map([[1n, [30, 60, 250]]]), // 全窗覆盖
    });
    const { stats } = await registry.execute('volatility', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getVolatilityRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('volatility delta 部分窗口已落 (缺 250) → 仍 pending, 重拉全 3 窗口 (窗口缺口不被永久跳过)', async () => {
    const { registry, spies } = buildVolatilityFakes({
      doneWindowsById: new Map([[1n, [30, 60]]]), // 缺 250
    });
    const { stats } = await registry.execute('volatility', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getVolatilityRange).toHaveBeenCalledTimes(3); // 全 3 窗口重拉 (skipDuplicates 兜已落)
    expect(stats).toMatchObject({ scanned: 1, ok: 1 });
  });

  it('volatility backfill → from=asOf−historyDepth + 每窗口 createMany({skipDuplicates}) 行含 volatilityDays', async () => {
    const { registry, spies } = buildVolatilityFakes({
      rangeRows: [
        { date: '2016-06-15', value: '0.30' },
        { date: '2020-06-15', value: '0.40' },
      ],
    });
    const { stats } = await registry.execute('volatility', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.vlFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    // 每窗口一请求 (3 次); from = asOf − historyDepth。
    expect(spies.getVolatilityRange).toHaveBeenCalledTimes(3);
    const q = spies.getVolatilityRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth
    // 3 窗口 × createMany 各 1 次 = 3 次; 每次 data 行含对应 volatilityDays (自然键第 3 维)。
    expect(spies.vlCreateMany).toHaveBeenCalledTimes(3);
    const arg = spies.vlCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: { instrumentId: bigint; volatilityDays: number; value: string | null }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({ instrumentId: 1n, value: '0.30' });
    expect(typeof arg.data[0].volatilityDays).toBe('number');
    // 3 次 createMany 覆盖 3 个不同窗口 (每窗口一批, 同 date 每窗口一行)。
    const windowsWritten = spies.vlCreateMany.mock.calls
      .map((c) => (c[0] as { data: { volatilityDays: number }[] }).data[0].volatilityDays)
      .sort((a, b) => a - b);
    expect(windowsWritten).toEqual([30, 60, 250]);
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 040 T008 US2: hot_snapshot 装配 (第 2 形态: 无 mode 分支 × HOT_TYPES type 循环 × payload 异构)。验路由 +
// 每 type 一次 getHotSnapshot (stockCodes[] 数组) + 按自然键 (instrumentId,hotType,dataDate) upsert +
// payload 异构存 + per-type 隔离 (某 type 抛错计 failed 不阻塞其余)。真落库/按 dataDate 累积/幂等由 T009 Testcontainers IT。
describe('040 T008 hot_snapshot 装配 (无 mode + HOT_TYPES 循环 + 按 dataDate upsert + per-type 隔离)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');
  // hot 无 mode 分支, mode 值不影响行为 (复用 delta input)。
  const hotInput = { mode: 'delta' as const, asOf: '2026-06-05', now: NOW };

  function buildHotFakes(
    opts: {
      /** hotType → DTO rows (缺省 = 每 type 返 1 行, dataDate 2026-06-01, payload 编入 type)。 */
      rowsByType?: (hotType: string) => HotSnapshotDto[];
      /** 指定 type vendor 抛错 (per-type 隔离验证)。 */
      throwOnType?: string;
    } = {},
  ) {
    const hotUpsert = vi.fn(async (_arg: unknown) => ({}));
    const getHotSnapshot = vi.fn(async (q: HotSnapshotQuery) => {
      if (opts.throwOnType && q.hotType === opts.throwOnType) throw new Error('vendor 500');
      return opts.rowsByType
        ? opts.rowsByType(q.hotType)
        : [{ hotType: q.hotType, dataDate: '2026-06-01', payload: { metric: q.hotType, v: 1 } }];
    });
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      hotSnapshot: { getHotSnapshot },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'hot_snapshot',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: null, // 快照, 无 history_depth (不回填历史)
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        hotSnapshot: { upsert: hotUpsert },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ hotSnapshot: { upsert: hotUpsert } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      deps.hotSnapshot as never, // hotSnapshot (尾部)
    );
    return { registry, spies: { getHotSnapshot, hotUpsert } };
  }

  it('HOT_TYPES 循环: 4 type 各一次 getHotSnapshot (stockCodes[] 数组 + hotType) + 每 type upsert', async () => {
    const { registry, spies } = buildHotFakes();
    const { stats } = await registry.execute('hot_snapshot', hotInput);

    // 每 type 一次请求 = HOT_TYPES.length 次, 覆盖全 type 集。
    expect(spies.getHotSnapshot).toHaveBeenCalledTimes(HOT_TYPES.length);
    const types = spies.getHotSnapshot.mock.calls.map((c) => c[0].hotType).sort();
    expect(types).toEqual([...HOT_TYPES].sort());
    // param 契约: stockCodes[] 数组 (非单数), 快照无 from/to。
    for (const c of spies.getHotSnapshot.mock.calls) {
      expect(Array.isArray(c[0].stockCodes)).toBe(true);
      expect(c[0].stockCodes).toEqual(['hk:00700']);
      expect(c[0]).not.toHaveProperty('from');
      expect(c[0]).not.toHaveProperty('to');
    }
    // 每 type upsert 一次 (自然键 instrumentId_hotType_dataDate)。
    expect(spies.hotUpsert).toHaveBeenCalledTimes(HOT_TYPES.length);
    const upArg = spies.hotUpsert.mock.calls[0][0] as {
      where: {
        instrumentId_hotType_dataDate: { instrumentId: bigint; hotType: string; dataDate: Date };
      };
      create: { instrumentId: bigint; hotType: string; payload: unknown };
      update: { payload: unknown };
    };
    expect(upArg.where.instrumentId_hotType_dataDate.instrumentId).toBe(1n);
    expect(stats).toMatchObject({ scanned: HOT_TYPES.length, ok: HOT_TYPES.length, failed: 0 });
  });

  it('按 dataDate upsert: where 键含 dataDate(=last_data_date) + create/update 落 payload (同 dataDate 覆盖、变则新行由自然键保证)', async () => {
    const { registry, spies } = buildHotFakes({
      rowsByType: (t) => [{ hotType: t, dataDate: '2026-05-20', payload: { m: t } }],
    });
    await registry.execute('hot_snapshot', hotInput);

    const arg = spies.hotUpsert.mock.calls[0][0] as {
      where: {
        instrumentId_hotType_dataDate: { instrumentId: bigint; hotType: string; dataDate: Date };
      };
      create: { instrumentId: bigint; hotType: string; dataDate: Date; payload: unknown };
      update: { payload: unknown };
    };
    // dataDate = vendor last_data_date (自然键第 3 维), toDateOnly 转 Date。
    expect(arg.where.instrumentId_hotType_dataDate.dataDate).toEqual(
      new Date('2026-05-20T00:00:00Z'),
    );
    expect(arg.create).toMatchObject({
      instrumentId: 1n,
      dataDate: new Date('2026-05-20T00:00:00Z'),
    });
    expect(arg.update).toHaveProperty('payload'); // 覆盖同行只更新 payload (最新值)
  });

  it('payload 异构: 每 type payload 结构不同 → 整存 create.payload (新增 type 零 schema 变更)', async () => {
    const { registry, spies } = buildHotFakes({
      rowsByType: (t) => [
        {
          hotType: t,
          dataDate: '2026-06-01',
          payload: t === 'ss' ? { ass_m: 0.1, ass_s: 900 } : { other: t },
        },
      ],
    });
    await registry.execute('hot_snapshot', hotInput);

    const calls = spies.hotUpsert.mock.calls.map(
      (c) => c[0] as { create: { hotType: string; payload: Record<string, unknown> } },
    );
    const ss = calls.find((c) => c.create.hotType === 'ss');
    expect(ss?.create.payload).toMatchObject({ ass_m: 0.1, ass_s: 900 }); // ss 结构
    const tr = calls.find((c) => c.create.hotType === 'tr');
    expect(tr?.create.payload).toMatchObject({ other: 'tr' }); // tr 结构不同
  });

  it('幂等: 连跑两次 → 每次 upsert 同自然键 (upsert 覆盖不新增)', async () => {
    const { registry, spies } = buildHotFakes();
    await registry.execute('hot_snapshot', hotInput);
    await registry.execute('hot_snapshot', hotInput);

    // 两次运行, 每次 HOT_TYPES.length 次 upsert。
    expect(spies.hotUpsert).toHaveBeenCalledTimes(HOT_TYPES.length * 2);
    // 同标的同 type 同 dataDate → 同 where 键 (幂等覆盖不新增; 首跑首 type == 二跑首 type)。
    const first = (spies.hotUpsert.mock.calls[0][0] as { where: unknown }).where;
    const secondRunFirst = (spies.hotUpsert.mock.calls[HOT_TYPES.length][0] as { where: unknown })
      .where;
    expect(secondRunFirst).toEqual(first);
  });

  it('vendor 抛错 (某 type) → 计 failed 不 mutate 该 type, 不阻塞其余 type (FR-007)', async () => {
    const { registry, spies } = buildHotFakes({ throwOnType: 'rep' });
    const { stats } = await registry.execute('hot_snapshot', hotInput);

    // rep 抛错 → 计 failed; 其余 3 type 正常 upsert (不阻塞)。
    expect(stats).toMatchObject({
      scanned: HOT_TYPES.length,
      ok: HOT_TYPES.length - 1,
      failed: 1,
    });
    expect(spies.hotUpsert).toHaveBeenCalledTimes(HOT_TYPES.length - 1); // rep 未 upsert (抛错不 mutate)
    const upsertedTypes = spies.hotUpsert.mock.calls.map(
      (c) => (c[0] as { create: { hotType: string } }).create.hotType,
    );
    expect(upsertedTypes).not.toContain('rep');
    expect(upsertedTypes.sort()).toEqual(['capita', 'ss', 'tr']);
  });
});

// 041 T005 US1: buyback 装配 (照抄 eod_bar/short_selling 区间形态)。验路由 + delta/backfill 的 from 分支 +
// createMany(skipDuplicates) 幂等形态 + delta pending-skip + 丰富 typed 列 (num→BigInt / Decimal string 直落 /
// 文本列) + 空返回容错。真落库/多年事件/幂等由 T006 Testcontainers IT。
describe('041 T005 buyback 装配 (mode 分 from + typed 列 + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  const FIXTURE_ROW: BuybackDto = {
    date: '2024-12-30',
    vendorEventId: '68f6e365d5961364e4428dce',
    num: '1370000',
    highestPrice: '421.4',
    lowestPrice: '416',
    avgPrice: '419.004',
    totalPaid: '574035480',
    totalSharesForCancellation: '1370000',
    totalSharesForTreasury: '0',
    ratioPurchasedSinceResolution: '0.02445',
    methodOfPurchase: 'exchange',
    currency: 'HKD',
    boardType: 'main',
  };

  function buildBuybackFakes(
    opts: { rangeRows?: BuybackDto[]; doneIds?: bigint[]; historyDepth?: number } = {},
  ) {
    const bbCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingBuybackInstruments 游标: doneIds 已落当日 → 该股 delta 跳过。
    const bbFindMany = vi.fn(async () => (opts.doneIds ?? []).map((id) => ({ instrumentId: id })));
    const getBuybackRange = vi.fn(async (_q: BuybackRangeQuery) => opts.rangeRows ?? [FIXTURE_ROW]);
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      buyback: { getBuybackRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'buyback',
            enabled: true,
            cronExpr: '0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        buybackEvent: { findMany: bbFindMany, createMany: bbCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ buybackEvent: { createMany: bbCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      deps.buyback as never, // buyback (尾部)
    );
    return { registry, spies: { bbCreateMany, bbFindMany, getBuybackRange } };
  }

  it('buyback delta → getBuybackRange(from=asOf 单日) + pending 游标查 + per-stock 单 symbol', async () => {
    const { registry, spies } = buildBuybackFakes();
    const { stats } = await registry.execute('buyback', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.bbFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    expect(spies.getBuybackRange).toHaveBeenCalledTimes(1);
    const q = spies.getBuybackRange.mock.calls[0][0];
    expect(q.symbol).toBe('hk:00700'); // per-stock 单 symbol (单数 stockCode 契约)
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单日)
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('buyback delta pending-skip: 本日已落行标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildBuybackFakes({ doneIds: [1n] });
    const { stats } = await registry.execute('buyback', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getBuybackRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('buyback backfill → from=asOf−historyDepth + buybackEvent.createMany({skipDuplicates}) + typed 列 (num→BigInt / Decimal string 直落 / 文本列)', async () => {
    const { registry, spies } = buildBuybackFakes({
      rangeRows: [
        FIXTURE_ROW,
        { ...FIXTURE_ROW, date: '2020-06-15', num: '500000', avgPrice: '300.5' },
      ],
    });
    const { stats } = await registry.execute('buyback', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.bbFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    const q = spies.getBuybackRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth (~10yr)
    const arg = spies.bbCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: {
        instrumentId: bigint;
        date: Date;
        vendorEventId: string;
        num: bigint | null;
        avgPrice: string | null;
        totalSharesForTreasury: bigint | null;
        methodOfPurchase: string | null;
      }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    // C1: vendorEventId (vendor `_id`) 进 createMany row (自然键判别字段)。
    expect(arg.data[0].vendorEventId).toBe('68f6e365d5961364e4428dce');
    // num / totalSharesForTreasury → bigint (BigInt? 列, toBigIntOrNull 转换)。
    expect(arg.data[0].num).toBe(1370000n);
    expect(typeof arg.data[0].num).toBe('bigint');
    expect(arg.data[0].totalSharesForTreasury).toBe(0n);
    // avgPrice → string 直落 (Decimal? 列); methodOfPurchase → 文本列。
    expect(arg.data[0].avgPrice).toBe('419.004');
    expect(arg.data[0].methodOfPurchase).toBe('exchange');
    expect(arg.data[0].instrumentId).toBe(1n);
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('buyback num=null → BigInt? 列存 null 不崩 (toBigIntOrNull 空值透传)', async () => {
    const { registry, spies } = buildBuybackFakes({
      rangeRows: [{ ...FIXTURE_ROW, num: null, totalSharesForCancellation: null }],
    });
    await registry.execute('buyback', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    const arg = spies.bbCreateMany.mock.calls[0][0] as {
      data: { num: bigint | null; totalSharesForCancellation: bigint | null }[];
    };
    expect(arg.data[0].num).toBeNull();
    expect(arg.data[0].totalSharesForCancellation).toBeNull();
  });

  it('无回购历史标的空返回 [] → 零 createMany、ok 非 failed (不崩不阻塞)', async () => {
    const { registry, spies } = buildBuybackFakes({ rangeRows: [] });
    const { stats } = await registry.execute('buyback', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.getBuybackRange).toHaveBeenCalledTimes(1);
    expect(spies.bbCreateMany).not.toHaveBeenCalled(); // 空返回 → chunked([]) 空 → 零 createMany
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 041 T008 US2: equity_change 装配 (照抄 buyback 区间形态)。验路由 + delta/backfill 的 from 分支 +
// createMany(skipDuplicates) 幂等形态 + delta pending-skip + 扁平列 (capitalization/capitalizationH
// Decimal string 直落 / changeReason 文本 / declarationDate 可空 Date 转换) + 空返回容错。真落库/多年
// 事件/幂等由 T009 Testcontainers IT。
describe('041 T008 equity_change 装配 (mode 分 from + 扁平列 + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  const FIXTURE_ROW: EquityChangeDto = {
    date: '2024-12-31',
    capitalization: '9224914953',
    capitalizationH: '9224914953',
    changeReason: '定期報告',
    declarationDate: '2025-01-07',
  };

  function buildEquityChangeFakes(
    opts: { rangeRows?: EquityChangeDto[]; doneIds?: bigint[]; historyDepth?: number } = {},
  ) {
    const ecCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingEquityChangeInstruments 游标: doneIds 已落当日 → 该股 delta 跳过。
    const ecFindMany = vi.fn(async () => (opts.doneIds ?? []).map((id) => ({ instrumentId: id })));
    const getEquityChangeRange = vi.fn(
      async (_q: EquityChangeRangeQuery) => opts.rangeRows ?? [FIXTURE_ROW],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      equityChange: { getEquityChangeRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'equity_change',
            enabled: true,
            cronExpr: '0 22 * * *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        equityChange: { findMany: ecFindMany, createMany: ecCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ equityChange: { createMany: ecCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      deps.equityChange as never, // equityChange (尾部)
    );
    return { registry, spies: { ecCreateMany, ecFindMany, getEquityChangeRange } };
  }

  it('equity_change delta → getEquityChangeRange(from=asOf 单日) + pending 游标查 + per-stock 单 symbol', async () => {
    const { registry, spies } = buildEquityChangeFakes();
    const { stats } = await registry.execute('equity_change', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.ecFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    expect(spies.getEquityChangeRange).toHaveBeenCalledTimes(1);
    const q = spies.getEquityChangeRange.mock.calls[0][0];
    expect(q.symbol).toBe('hk:00700'); // per-stock 单 symbol (单数 stockCode 契约)
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单日)
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('equity_change delta pending-skip: 本日已落行标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildEquityChangeFakes({ doneIds: [1n] });
    const { stats } = await registry.execute('equity_change', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getEquityChangeRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('equity_change backfill → from=asOf−historyDepth + equityChange.createMany({skipDuplicates}) + 扁平列 (Decimal string 直落 / 文本 / declarationDate→Date)', async () => {
    const { registry, spies } = buildEquityChangeFakes({
      rangeRows: [
        FIXTURE_ROW,
        { ...FIXTURE_ROW, date: '2020-06-15', capitalization: '9600000000' },
      ],
    });
    const { stats } = await registry.execute('equity_change', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.ecFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    const q = spies.getEquityChangeRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth (~10yr)
    const arg = spies.ecCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: {
        instrumentId: bigint;
        date: Date;
        capitalization: string | null;
        capitalizationH: string | null;
        changeReason: string | null;
        declarationDate: Date | null;
      }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    // capitalization/capitalizationH → string 直落 (Decimal? 列); changeReason → 文本列。
    expect(arg.data[0].capitalization).toBe('9224914953');
    expect(arg.data[0].capitalizationH).toBe('9224914953');
    expect(arg.data[0].changeReason).toBe('定期報告');
    // declarationDate → Date (可空 Date 列 toDateOnly 转换)。
    expect(arg.data[0].declarationDate).toBeInstanceOf(Date);
    expect((arg.data[0].declarationDate as Date).toISOString().slice(0, 10)).toBe('2025-01-07');
    expect(arg.data[0].instrumentId).toBe(1n);
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('equity_change declarationDate=null → 可空 Date 列存 null 不崩', async () => {
    const { registry, spies } = buildEquityChangeFakes({
      rangeRows: [{ ...FIXTURE_ROW, declarationDate: null, capitalizationH: null }],
    });
    await registry.execute('equity_change', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    const arg = spies.ecCreateMany.mock.calls[0][0] as {
      data: { declarationDate: Date | null; capitalizationH: string | null }[];
    };
    expect(arg.data[0].declarationDate).toBeNull();
    expect(arg.data[0].capitalizationH).toBeNull();
  });

  it('无股本变动历史标的空返回 [] → 零 createMany、ok 非 failed (不崩不阻塞)', async () => {
    const { registry, spies } = buildEquityChangeFakes({ rangeRows: [] });
    const { stats } = await registry.execute('equity_change', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.getEquityChangeRange).toHaveBeenCalledTimes(1);
    expect(spies.ecCreateMany).not.toHaveBeenCalled(); // 空返回 → chunked([]) 空 → 零 createMany
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 041 T011 US3: shareholder_change 装配 (照抄 buyback 区间形态)。验路由 + delta/backfill 的 from 分支 +
// createMany(skipDuplicates) 幂等形态 + delta pending-skip + **嵌套 L/S payload 落库保真** (整存
// numOfSharesInterestedList/percentageOfIssuedVotingShares 无损) + 缺项 null 容错 + shareholderName 进
// createMany row + 空返回容错。真落库/嵌套保真/幂等由 T012 Testcontainers IT。
describe('041 T011 shareholder_change 装配 (mode 分 from + 嵌套 L/S payload + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  // 含 L 和 S 两项 (嵌套保真核心 — L/S 二维数值须无损整存 payload)。
  const FIXTURE_ROW: ShareholderChangeDto = {
    date: '2024-12-30',
    shareholderName: 'Naspers Limited',
    contentHash: 'hash-naspers-2024',
    payload: {
      numOfSharesInterestedList: [
        { value: 2215242300, sharesType: 'L' },
        { value: 100000, sharesType: 'S' },
      ],
      percentageOfIssuedVotingShares: [
        { value: 0.2401, sharesType: 'L' },
        { value: 0.0001, sharesType: 'S' },
      ],
    },
  };

  function buildShareholderChangeFakes(
    opts: { rangeRows?: ShareholderChangeDto[]; doneIds?: bigint[]; historyDepth?: number } = {},
  ) {
    const scCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingShareholderChangeInstruments 游标: doneIds 已落当日 → 该股 delta 跳过。
    const scFindMany = vi.fn(async () => (opts.doneIds ?? []).map((id) => ({ instrumentId: id })));
    const getShareholderChangeRange = vi.fn(
      async (_q: ShareholderChangeRangeQuery) => opts.rangeRows ?? [FIXTURE_ROW],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      shareholderChange: { getShareholderChangeRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'shareholder_change',
            enabled: true,
            cronExpr: '0 22 * * 1',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        shareholderChange: { findMany: scFindMany, createMany: scCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ shareholderChange: { createMany: scCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      deps.shareholderChange as never, // shareholderChange (尾部)
    );
    return { registry, spies: { scCreateMany, scFindMany, getShareholderChangeRange } };
  }

  it('shareholder_change delta → getShareholderChangeRange(from=asOf 单日) + pending 游标查 + per-stock 单 symbol', async () => {
    const { registry, spies } = buildShareholderChangeFakes();
    const { stats } = await registry.execute('shareholder_change', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.scFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    expect(spies.getShareholderChangeRange).toHaveBeenCalledTimes(1);
    const q = spies.getShareholderChangeRange.mock.calls[0][0];
    expect(q.symbol).toBe('hk:00700'); // per-stock 单 symbol (单数 stockCode 契约)
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单日)
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('shareholder_change delta pending-skip: 本日已落行标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildShareholderChangeFakes({ doneIds: [1n] });
    const { stats } = await registry.execute('shareholder_change', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getShareholderChangeRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('shareholder_change backfill → from=asOf−historyDepth + shareholderChange.createMany({skipDuplicates}) + shareholderName 进 row + 嵌套 L/S payload 整存保真', async () => {
    const { registry, spies } = buildShareholderChangeFakes({
      rangeRows: [
        FIXTURE_ROW,
        {
          date: '2020-06-12',
          shareholderName: '马化腾',
          contentHash: 'hash-pony-2020',
          // 缺 S (只有 L) → 数组只含 L 项 (缺项容错)。
          payload: {
            numOfSharesInterestedList: [{ value: 804859700, sharesType: 'L' }],
            percentageOfIssuedVotingShares: [{ value: 0.0842, sharesType: 'L' }],
          },
        },
      ],
    });
    const { stats } = await registry.execute('shareholder_change', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.scFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    const q = spies.getShareholderChangeRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth (~10yr)
    const arg = spies.scCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: {
        instrumentId: bigint;
        date: Date;
        shareholderName: string;
        contentHash: string;
        payload: Record<string, unknown>;
      }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    // shareholderName + contentHash 进 row (自然键, 同日多大股东各一行; C1 contentHash 判别同名同日多笔)。
    expect(arg.data[0].shareholderName).toBe('Naspers Limited');
    expect(arg.data[0].contentHash).toBe('hash-naspers-2024');
    expect(arg.data[1].contentHash).toBe('hash-pony-2020');
    expect(arg.data[0].instrumentId).toBe(1n);
    // 嵌套 L/S payload 整存保真: L 和 S 两维数值无损 (numOfSharesInterestedList/percentageOfIssuedVotingShares)。
    expect(arg.data[0].payload.numOfSharesInterestedList).toEqual([
      { value: 2215242300, sharesType: 'L' },
      { value: 100000, sharesType: 'S' },
    ]);
    expect(arg.data[0].payload.percentageOfIssuedVotingShares).toEqual([
      { value: 0.2401, sharesType: 'L' },
      { value: 0.0001, sharesType: 'S' },
    ]);
    // 缺 S 行: 数组只含 L 项 (不伪造 S, 缺项容错)。
    expect(arg.data[1].shareholderName).toBe('马化腾');
    expect(arg.data[1].payload.numOfSharesInterestedList).toEqual([
      { value: 804859700, sharesType: 'L' },
    ]);
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('无股东权益变动历史标的空返回 [] → 零 createMany、ok 非 failed (不崩不阻塞)', async () => {
    const { registry, spies } = buildShareholderChangeFakes({ rangeRows: [] });
    const { stats } = await registry.execute('shareholder_change', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.getShareholderChangeRange).toHaveBeenCalledTimes(1);
    expect(spies.scCreateMany).not.toHaveBeenCalled(); // 空返回 → chunked([]) 空 → 零 createMany
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 041 T014 US4: allotment 装配 (照抄 buyback 区间形态)。验路由 + delta/backfill 的 from 分支 +
// createMany(skipDuplicates) 幂等形态 + delta pending-skip + **payload 整存落库** (vendor 原始行无损) +
// **港股极罕见零样本: 多数标的空返回零行 → 优雅收敛不崩不阻塞** (US4/SC-004 核心)。真落库/幂等/零样本
// 收敛由 T015 Testcontainers IT。
describe('041 T014 allotment 装配 (mode 分 from + payload 整存 + 零样本空返回容错)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  // 🚨 date(公告日) 与 exDate(除权日) 刻意不等 —— prod 545 行实测 510 行两者不同, 复权因子按
  // 除权日定版本边界; 若 fixture 让两者相等, 混用 date/exDate 的错误就测不出来。
  const FIXTURE_ROW: AllotmentDto = {
    date: '2020-05-20',
    exDate: '2020-06-11',
    allotmentRatio: '0.2',
    allotmentPrice: '10.5000',
    currency: 'CNY',
    payload: {
      date: '2020-05-20',
      exDate: '2020-06-11',
      allotmentRatio: 0.2,
      allotmentPrice: 10.5,
    },
  };

  function buildAllotmentFakes(
    opts: { rangeRows?: AllotmentDto[]; doneIds?: bigint[]; historyDepth?: number } = {},
  ) {
    const aeCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingAllotmentInstruments 游标: doneIds 已落当日 → 该股 delta 跳过。
    const aeFindMany = vi.fn(async () => (opts.doneIds ?? []).map((id) => ({ instrumentId: id })));
    const getAllotmentRange = vi.fn(
      async (_q: AllotmentRangeQuery) => opts.rangeRows ?? [FIXTURE_ROW],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      allotment: { getAllotmentRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'allotment',
            enabled: true,
            cronExpr: '0 22 * * 1',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        allotmentEvent: { findMany: aeFindMany, createMany: aeCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ allotmentEvent: { createMany: aeCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      deps.allotment as never, // allotment (尾部)
    );
    return { registry, spies: { aeCreateMany, aeFindMany, getAllotmentRange } };
  }

  it('allotment delta → getAllotmentRange(from=asOf 单日) + pending 游标查 + per-stock 单 symbol', async () => {
    const { registry, spies } = buildAllotmentFakes();
    const { stats } = await registry.execute('allotment', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.aeFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    expect(spies.getAllotmentRange).toHaveBeenCalledTimes(1);
    const q = spies.getAllotmentRange.mock.calls[0][0];
    expect(q.symbol).toBe('hk:00700'); // per-stock 单 symbol (单数 stockCode 契约)
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单日)
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('allotment delta pending-skip: 本日已落行标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildAllotmentFakes({ doneIds: [1n] });
    const { stats } = await registry.execute('allotment', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getAllotmentRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('allotment backfill → from=asOf−historyDepth + allotmentEvent.createMany({skipDuplicates}) + payload 整存', async () => {
    const { registry, spies } = buildAllotmentFakes({
      rangeRows: [
        FIXTURE_ROW,
        // vendor 无 exDate 的行 (35/545 实测) → 落 null, 不崩。
        {
          date: '2016-03-10',
          exDate: null,
          allotmentRatio: '0.5',
          allotmentPrice: null,
          currency: null,
          payload: { date: '2016-03-10', allotmentRatio: 0.5 },
        },
      ],
    });
    const { stats } = await registry.execute('allotment', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.aeFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    const q = spies.getAllotmentRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth (~10yr)
    const arg = spies.aeCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: {
        instrumentId: bigint;
        date: Date;
        exDate: Date | null;
        allotmentRatio: string | null;
        allotmentPrice: string | null;
        currency: string | null;
        payload: Record<string, unknown>;
      }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0].instrumentId).toBe(1n);
    // 🚨 typed 列按语义各就各位: date=公告日 / exDate=除权日 (二者不等), 条款走 Decimal 列不走 JSON。
    expect(arg.data[0].date.toISOString().slice(0, 10)).toBe('2020-05-20');
    expect(arg.data[0].exDate?.toISOString().slice(0, 10)).toBe('2020-06-11');
    expect(arg.data[0].allotmentRatio).toBe('0.2');
    expect(arg.data[0].allotmentPrice).toBe('10.5000');
    expect(arg.data[0].currency).toBe('CNY');
    // vendor 缺 exDate 的行落 null (35/545 实测), 不崩不填假值。
    expect(arg.data[1].exDate).toBeNull();
    expect(arg.data[1].allotmentPrice).toBeNull();
    // payload 仍整存 vendor 原始行无损 (提列列之外字段的兜底)。
    expect(arg.data[0].payload).toEqual({
      date: '2020-05-20',
      exDate: '2020-06-11',
      allotmentRatio: 0.2,
      allotmentPrice: 10.5,
    });
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('港股极罕见零样本: vendor 返 [] → 零 createMany、ok 非 failed (优雅收敛不崩不阻塞, US4/SC-004)', async () => {
    const { registry, spies } = buildAllotmentFakes({ rangeRows: [] });
    const { stats } = await registry.execute('allotment', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.getAllotmentRange).toHaveBeenCalledTimes(1);
    expect(spies.aeCreateMany).not.toHaveBeenCalled(); // 空返回 → chunked([]) 空 → 零 createMany
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 042 T005 US1: revenue_segment 装配 (照抄 buyback 区间形态)。验路由 + delta/backfill 的 from 分支 +
// createMany(skipDuplicates) 幂等形态 + delta pending-skip + 展开 typed 子行透传 (缺值行 null / 顶层 sentinel
// '' / signed 负 revenue / declarationDate toDateOnly 或 null) + 空返回容错。真落库/多期/幂等由 T006 Testcontainers IT。
// 注: 「纯头行不落」是 adapter (T004) 的解析职责 — port 返回的 DTO 流本就不含头行; 此层验 executor 忠实透传
// port 返回的每一行 (不丢/不合成), 含缺值行 (revenue null) 与顶层哨兵行 (parentItemName '')。
describe('042 T005 revenue_segment 装配 (mode 分 from + typed 子行透传 + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  const FIXTURE_ROWS: RevenueSegmentDto[] = [
    {
      date: '2024-12-31',
      declarationDate: '2025-03-20',
      currency: 'CNY',
      parentItemName: '按服務類型分',
      itemName: '增值服務',
      revenue: '319168000000',
      costs: '137511000000',
      grossProfitMargin: '0.5692',
    },
    {
      // 缺值数据行: 有 parentItemName 缺 revenue → null 透传落库。
      date: '2024-12-31',
      declarationDate: '2025-03-20',
      currency: 'CNY',
      parentItemName: '按地區分',
      itemName: '英國',
      revenue: null,
      costs: null,
      grossProfitMargin: null,
    },
    {
      // signed 负 revenue (HSBC 企業中心 −1e10) — executor string 直落, 不改号。
      date: '2024-12-31',
      declarationDate: '2025-03-20',
      currency: 'CNY',
      parentItemName: '按地區分',
      itemName: '企業中心',
      revenue: '-10300000000',
      costs: '2000000000',
      grossProfitMargin: '-0.1',
    },
    {
      // 顶层合計行: parentItemName 哨兵 ''; declarationDate null → 落 null (可空 Date 列)。
      date: '2024-12-31',
      declarationDate: null,
      currency: 'CNY',
      parentItemName: '',
      itemName: '合計',
      revenue: '660257000000',
      costs: '340000000000',
      grossProfitMargin: '0.485',
    },
  ];

  function buildRevenueSegmentFakes(
    opts: { rangeRows?: RevenueSegmentDto[]; doneIds?: bigint[]; historyDepth?: number } = {},
  ) {
    const rsCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingRevenueSegmentInstruments 游标: doneIds 已落当日 → 该股 delta 跳过。
    const rsFindMany = vi.fn(async () => (opts.doneIds ?? []).map((id) => ({ instrumentId: id })));
    const getRevenueSegmentRange = vi.fn(
      async (_q: RevenueSegmentRangeQuery) => opts.rangeRows ?? FIXTURE_ROWS,
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      revenueSegment: { getRevenueSegmentRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'revenue_segment',
            enabled: true,
            cronExpr: '0 0 22 1 */3 *',
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        revenueSegment: { findMany: rsFindMany, createMany: rsCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ revenueSegment: { createMany: rsCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      deps.revenueSegment as never, // revenueSegment (尾部)
    );
    return { registry, spies: { rsCreateMany, rsFindMany, getRevenueSegmentRange } };
  }

  it('revenue_segment delta → getRevenueSegmentRange(from=asOf 单期) + pending 游标查 + per-stock 单 symbol', async () => {
    const { registry, spies } = buildRevenueSegmentFakes();
    const { stats } = await registry.execute('revenue_segment', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.rsFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    expect(spies.getRevenueSegmentRange).toHaveBeenCalledTimes(1);
    const q = spies.getRevenueSegmentRange.mock.calls[0][0];
    expect(q.symbol).toBe('hk:00700'); // per-stock 单 symbol (单数 stockCode 契约)
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单期)
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('revenue_segment delta pending-skip: 本日已落行标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildRevenueSegmentFakes({ doneIds: [1n] });
    const { stats } = await registry.execute('revenue_segment', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getRevenueSegmentRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('revenue_segment backfill → from=asOf−historyDepth + createMany({skipDuplicates}) + 缺值行 null / 顶层 sentinel / signed 负 / declarationDate toDateOnly|null', async () => {
    const { registry, spies } = buildRevenueSegmentFakes();
    const { stats } = await registry.execute('revenue_segment', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.rsFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    const q = spies.getRevenueSegmentRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth (~10yr)
    const arg = spies.rsCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: {
        instrumentId: bigint;
        date: Date;
        declarationDate: Date | null;
        currency: string | null;
        parentItemName: string;
        itemName: string;
        revenue: string | null;
        costs: string | null;
        grossProfitMargin: string | null;
      }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(4); // 忠实透传 port 返回的每一行 (不丢/不合成)
    expect(arg.data[0].instrumentId).toBe(1n);
    // 数据行 typed 透传。
    expect(arg.data[0]).toMatchObject({
      parentItemName: '按服務類型分',
      itemName: '增值服務',
      revenue: '319168000000',
      currency: 'CNY',
    });
    expect(arg.data[0].declarationDate).toBeInstanceOf(Date); // 有公告日 → toDateOnly
    // 缺值数据行: revenue/costs/grossProfitMargin null 透传 (不合成)。
    expect(arg.data[1]).toMatchObject({
      itemName: '英國',
      revenue: null,
      costs: null,
      grossProfitMargin: null,
    });
    // signed 负 revenue: string 直落不改号。
    expect(arg.data[2]).toMatchObject({
      itemName: '企業中心',
      revenue: '-10300000000',
      grossProfitMargin: '-0.1',
    });
    // 顶层合計行: parentItemName 哨兵 ''; declarationDate null → 落 null。
    expect(arg.data[3].parentItemName).toBe('');
    expect(arg.data[3].itemName).toBe('合計');
    expect(arg.data[3].declarationDate).toBeNull();
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('无营收披露标的空返回 [] → 零 createMany、ok 非 failed (不崩不阻塞)', async () => {
    const { registry, spies } = buildRevenueSegmentFakes({ rangeRows: [] });
    const { stats } = await registry.execute('revenue_segment', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.getRevenueSegmentRange).toHaveBeenCalledTimes(1);
    expect(spies.rsCreateMany).not.toHaveBeenCalled(); // 空返回 → chunked([]) 空 → 零 createMany
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 042 T008 US2: shareholder_snapshot 装配 (照抄 shareholder_change 区间形态, 复用 041 payload+contentHash)。
// 验路由 + delta/backfill 的 from 分支 + createMany(skipDuplicates) 幂等形态 + delta pending-skip +
// **嵌套 L/S/P payload 落库保真** (整存无损) + 缺项 null 容错 + shareholderName+contentHash 进 createMany row +
// **SERIES 多 date 行都落** + 空返回容错。真落库/嵌套保真/幂等/SERIES 由 T009 Testcontainers IT。
describe('042 T008 shareholder_snapshot 装配 (mode 分 from + 嵌套 L/S/P payload + SERIES 多 date + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  // 含 L 和 S 两项 (嵌套保真核心 — L/S 二维数值须无损整存 payload)。
  const FIXTURE_ROW: ShareholderSnapshotDto = {
    date: '2024-12-31',
    shareholderName: 'Naspers Limited',
    contentHash: 'hash-naspers-2024',
    payload: {
      numOfSharesInterestedList: [
        { value: 2215242300, sharesType: 'L' },
        { value: 100000, sharesType: 'S' },
      ],
      percentageOfIssuedVotingShares: [
        { value: 0.2401, sharesType: 'L' },
        { value: 0.0001, sharesType: 'S' },
      ],
    },
  };

  function buildShareholderSnapshotFakes(
    opts: { rangeRows?: ShareholderSnapshotDto[]; doneIds?: bigint[]; historyDepth?: number } = {},
  ) {
    const ssCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingShareholderSnapshotInstruments 游标: doneIds 已落当日 → 该股 delta 跳过。
    const ssFindMany = vi.fn(async () => (opts.doneIds ?? []).map((id) => ({ instrumentId: id })));
    const getShareholderSnapshotRange = vi.fn(
      async (_q: ShareholderSnapshotRangeQuery) => opts.rangeRows ?? [FIXTURE_ROW],
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      shareholderSnapshot: { getShareholderSnapshotRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'shareholder_snapshot',
            enabled: true,
            cronExpr: '0 0 22 1 */3 *', // 042 统一季频 (FR-011)
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        shareholderSnapshot: { findMany: ssFindMany, createMany: ssCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ shareholderSnapshot: { createMany: ssCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      undefined, // revenueSegment → 默认 null-object
      deps.shareholderSnapshot as never, // shareholderSnapshot (尾部)
    );
    return { registry, spies: { ssCreateMany, ssFindMany, getShareholderSnapshotRange } };
  }

  it('shareholder_snapshot delta → getShareholderSnapshotRange(from=asOf 单期) + pending 游标查 + per-stock 单 symbol', async () => {
    const { registry, spies } = buildShareholderSnapshotFakes();
    const { stats } = await registry.execute('shareholder_snapshot', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.ssFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    expect(spies.getShareholderSnapshotRange).toHaveBeenCalledTimes(1);
    const q = spies.getShareholderSnapshotRange.mock.calls[0][0];
    expect(q.symbol).toBe('hk:00700'); // per-stock 单 symbol (单数 stockCode 契约)
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单期)
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('shareholder_snapshot delta pending-skip: 本日已落行标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildShareholderSnapshotFakes({ doneIds: [1n] });
    const { stats } = await registry.execute('shareholder_snapshot', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getShareholderSnapshotRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('shareholder_snapshot backfill → from=asOf−historyDepth + createMany({skipDuplicates}) + shareholderName+contentHash 进 row + 嵌套 L/S/P payload 整存保真 + SERIES 多 date', async () => {
    const { registry, spies } = buildShareholderSnapshotFakes({
      rangeRows: [
        FIXTURE_ROW,
        {
          // SERIES: 不同 date (报告期 B) → 多 date 行都落; 含第三类 sharesType P (嵌套无损)。
          date: '2023-12-31',
          shareholderName: 'JPMorgan Chase & Co.',
          contentHash: 'hash-jpm-2023',
          payload: {
            numOfSharesInterestedList: [{ value: 900000000, sharesType: 'P' }],
            percentageOfIssuedVotingShares: [{ value: 0.0942, sharesType: 'P' }],
          },
        },
      ],
    });
    const { stats } = await registry.execute('shareholder_snapshot', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.ssFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    const q = spies.getShareholderSnapshotRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth (~10yr)
    const arg = spies.ssCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: {
        instrumentId: bigint;
        date: Date;
        shareholderName: string;
        contentHash: string;
        payload: Record<string, unknown>;
      }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2); // SERIES: 2 个不同 date 行都落 (非覆盖式快照)
    // shareholderName + contentHash 进 row (自然键, C1 contentHash 判别同名同日多笔)。
    expect(arg.data[0].shareholderName).toBe('Naspers Limited');
    expect(arg.data[0].contentHash).toBe('hash-naspers-2024');
    expect(arg.data[1].contentHash).toBe('hash-jpm-2023');
    expect(arg.data[0].instrumentId).toBe(1n);
    // 嵌套 L/S payload 整存保真: L 和 S 两维数值无损。
    expect(arg.data[0].payload.numOfSharesInterestedList).toEqual([
      { value: 2215242300, sharesType: 'L' },
      { value: 100000, sharesType: 'S' },
    ]);
    // 第三类 P 保真 (JPMorgan): sharesType P 无损保留 (不假定 L/S 二元)。
    expect(arg.data[1].payload.numOfSharesInterestedList).toEqual([
      { value: 900000000, sharesType: 'P' },
    ]);
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('无最新股东历史标的空返回 [] → 零 createMany、ok 非 failed (不崩不阻塞)', async () => {
    const { registry, spies } = buildShareholderSnapshotFakes({ rangeRows: [] });
    const { stats } = await registry.execute('shareholder_snapshot', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.getShareholderSnapshotRange).toHaveBeenCalledTimes(1);
    expect(spies.ssCreateMany).not.toHaveBeenCalled(); // 空返回 → chunked([]) 空 → 零 createMany
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 042 T011 US3: employee 装配 (照抄 revenue_segment/buyback 区间形态)。验路由 + delta/backfill 的 from 分支 +
// createMany(skipDuplicates) 幂等形态 + delta pending-skip + 展开 typed 子行透传 (顶层 sentinel '' / 缺值行
// null / declarationDate toDateOnly 或 null) + **同名 (parentItemName,itemName) number+percentage 两行共存不去重**
// (Decision 6, displayType 进 NK) + 空返回容错。真落库/多期/幂等/两行共存由 T012 Testcontainers IT。
// 注: 「纯头行不落」是 adapter (T010) 的解析职责 — port 返回的 DTO 流本就不含头行; 此层验 executor 忠实透传
// port 返回的每一行 (不丢/不合成), 含缺值行 (value null) 与顶层哨兵行 (parentItemName '') 与同名两行 (仅 displayType 别)。
describe('042 T011 employee 装配 (mode 分 from + typed 子行透传 + 同名 number+percentage 两行共存 + createMany 幂等)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');

  const FIXTURE_ROWS: EmployeeDto[] = [
    {
      // 顶层 value 行: parentItemName 哨兵 ''; headcount。
      date: '2024-12-31',
      declarationDate: '2025-03-20',
      parentItemName: '',
      itemName: '员工总数',
      displayType: 'number',
      value: '58350',
    },
    {
      // 🔑 同名 (流失率按性别分, 男性) number 行 — 与下面 percentage 行同 (parent,item)、仅 displayType 区分。
      date: '2024-12-31',
      declarationDate: '2025-03-20',
      parentItemName: '流失率按性别分',
      itemName: '男性',
      displayType: 'number',
      value: '58812',
    },
    {
      // 🔑 同名 percentage 行 → 与上面 number 行都透传落库 (NK 含 displayType, 不折叠)。
      date: '2024-12-31',
      declarationDate: '2025-03-20',
      parentItemName: '流失率按性别分',
      itemName: '男性',
      displayType: 'percentage',
      value: '15.2',
    },
    {
      // 缺值数据行: 有 parentItemName 缺 value → null 透传落库; declarationDate null → 落 null (可空 Date 列)。
      date: '2024-12-31',
      declarationDate: null,
      parentItemName: '按地区分',
      itemName: '未披露',
      displayType: 'number',
      value: null,
    },
  ];

  function buildEmployeeFakes(
    opts: { rangeRows?: EmployeeDto[]; doneIds?: bigint[]; historyDepth?: number } = {},
  ) {
    const empCreateMany = vi.fn(async (_arg: unknown) => ({ count: 1 }));
    // pendingEmployeeInstruments 游标: doneIds 已落当日 → 该股 delta 跳过。
    const empFindMany = vi.fn(async () => (opts.doneIds ?? []).map((id) => ({ instrumentId: id })));
    const getEmployeeRange = vi.fn(
      async (_q: EmployeeRangeQuery) => opts.rangeRows ?? FIXTURE_ROWS,
    );
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      employee: { getEmployeeRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'employee',
            enabled: true,
            cronExpr: '0 0 22 1 */3 *', // 042 统一季频 (FR-011)
            marketScope: ['hk'],
            adjustTypes: [],
            batchSize: 1,
            historyDepth: opts.historyDepth ?? 3650,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: {
          findMany: vi.fn(async () => [{ id: 1n, market: 'hk', code: '00700' }]),
        },
        employeeSnapshot: { findMany: empFindMany, createMany: empCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ employeeSnapshot: { createMany: empCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      undefined, // revenueSegment → 默认 null-object
      undefined, // shareholderSnapshot → 默认 null-object
      deps.employee as never, // employee (尾部)
    );
    return { registry, spies: { empCreateMany, empFindMany, getEmployeeRange } };
  }

  it('employee delta → getEmployeeRange(from=asOf 单期) + pending 游标查 + per-stock 单 symbol', async () => {
    const { registry, spies } = buildEmployeeFakes();
    const { stats } = await registry.execute('employee', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.empFindMany).toHaveBeenCalled(); // delta 走 pending 游标
    expect(spies.getEmployeeRange).toHaveBeenCalledTimes(1);
    const q = spies.getEmployeeRange.mock.calls[0][0];
    expect(q.symbol).toBe('hk:00700'); // per-stock 单 symbol (单数 stockCode 契约)
    expect(q.from).toBe('2026-06-05'); // delta: from=asOf (单期)
    expect(q.to).toBe('2026-06-05');
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('employee delta pending-skip: 本日已落行标的跳过 — 不 fetch、scanned=0', async () => {
    const { registry, spies } = buildEmployeeFakes({ doneIds: [1n] });
    const { stats } = await registry.execute('employee', {
      mode: 'delta',
      asOf: '2026-06-05',
      now: NOW,
    });
    expect(spies.getEmployeeRange).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 0, ok: 0 });
  });

  it('employee backfill → from=asOf−historyDepth + createMany({skipDuplicates}) + 顶层 sentinel / 同名 number+percentage 两行共存 / 缺值 null / declarationDate toDateOnly|null', async () => {
    const { registry, spies } = buildEmployeeFakes();
    const { stats } = await registry.execute('employee', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.empFindMany).not.toHaveBeenCalled(); // backfill 全标的, 不走 pending 游标
    const q = spies.getEmployeeRange.mock.calls[0][0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − historyDepth (~10yr)
    const arg = spies.empCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: {
        instrumentId: bigint;
        date: Date;
        declarationDate: Date | null;
        parentItemName: string;
        itemName: string;
        displayType: string;
        value: string | null;
      }[];
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(4); // 忠实透传 port 返回的每一行 (不丢/不合成/不去重)
    expect(arg.data[0].instrumentId).toBe(1n);
    // 顶层 value 行: parentItemName 哨兵 ''; declarationDate 有值 → toDateOnly。
    expect(arg.data[0]).toMatchObject({
      parentItemName: '',
      itemName: '员工总数',
      displayType: 'number',
      value: '58350',
    });
    expect(arg.data[0].declarationDate).toBeInstanceOf(Date);
    // 🔑 同名 (流失率按性别分, 男性) number + percentage 两行都透传 (仅 displayType 区分, 不去重)。
    const genderRows = arg.data.filter(
      (r) => r.parentItemName === '流失率按性别分' && r.itemName === '男性',
    );
    expect(genderRows).toHaveLength(2);
    expect(genderRows.map((r) => r.displayType).sort()).toEqual(['number', 'percentage']);
    expect(genderRows.find((r) => r.displayType === 'number')!.value).toBe('58812');
    expect(genderRows.find((r) => r.displayType === 'percentage')!.value).toBe('15.2');
    // 缺值数据行: value null 透传 (不合成); declarationDate null → 落 null。
    expect(arg.data[3]).toMatchObject({ itemName: '未披露', value: null });
    expect(arg.data[3].declarationDate).toBeNull();
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('无员工披露标的空返回 [] → 零 createMany、ok 非 failed (不崩不阻塞)', async () => {
    const { registry, spies } = buildEmployeeFakes({ rangeRows: [] });
    const { stats } = await registry.execute('employee', {
      mode: 'backfill',
      asOf: '2026-06-05',
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(spies.getEmployeeRange).toHaveBeenCalledTimes(1);
    expect(spies.empCreateMany).not.toHaveBeenCalled(); // 空返回 → chunked([]) 空 → 零 createMany
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });
});

// 046 T008 US3: underlying_iv_daily 装配 (FR-023/FR-026/FR-028/FR-029/FR-030/FR-031)。
// 第 4 形态: **批量快照** —— 一次 getIvSnapshots(symbols) 覆盖整批, 无 mode 分支、无区间。
// 本 spec 住 src/ 且非 .it. ⇒ unit project, 零容器是机器强制的硬不变量 ⇒ **只放纯逻辑**:
// 工作集挂锚闸 / A′ 用 us 时区 / 批量形态 / upsert 幂等形态 / 缺席计 skipped / 失败可重拉告警。
// 「失败不破坏已落历史」「同日重跑真幂等」需真 DB ⇒ 归 T011 的 IT, 禁往这里塞容器。
describe('046 T008 underlying_iv_daily 装配 (批量快照 + 锚闸工作集 + A′ us 时区 + upsert 幂等)', () => {
  /** 北京 2026-06-13(周六) 06:00 = us 维度 cron 时刻; ET 侧还是 2026-06-12(周五) 18:00。 */
  const NOW_BEIJING_SAT_6AM = new Date('2026-06-12T22:00:00Z');
  /** 上述时刻的 us 业务日 (A′) 与全局上海日 —— 两者**不同**正是 FR-028 要守的东西。 */
  const US_BUSINESS_DATE = '2026-06-12';
  const SHANGHAI_DATE = '2026-06-13';

  function snapshot(
    symbol: string,
    over: Partial<UnderlyingIvSnapshot> = {},
  ): UnderlyingIvSnapshot {
    return {
      symbol,
      iv: '24.8',
      ivRank: '61.2',
      ivPercentile: '58.4',
      preIv: '24.1',
      hv30: '19.5',
      hv30Percentile: '44.0',
      hv60: '20.1',
      hv60Percentile: '46.0',
      hv90: '21.0',
      hv90Percentile: '48.0',
      hv120: '21.4',
      hv120Percentile: '49.0',
      hv365: '23.0',
      hv365Percentile: '52.0',
      callVolume: '1200',
      putVolume: '900',
      callOi: '34000',
      putOi: '28000',
      ...over,
    };
  }

  function buildUnderlyingIvFakes(
    opts: {
      /** 工作集 (缺省 = 2 只开闸 us 锚)。 */
      instruments?: { id: bigint; market: string; code: string }[];
      /** vendor 返回的快照 (缺省 = 工作集逐只各一条)。 */
      snapshots?: UnderlyingIvSnapshot[];
      /** vendor 不可达 (FR-030 路径)。 */
      throwOnFetch?: boolean;
      batchSize?: number;
      /** 锚表 ticker 列 (066 T02: 本维度是**锚作用域**的, 工作集判据读的是它)。 */
      anchorTickers?: string[];
    } = {},
  ) {
    const instruments = opts.instruments ?? [
      { id: 1n, market: 'us', code: 'PEP' },
      { id: 2n, market: 'us', code: 'VICI' },
    ];
    // 066 T02: 缺省让工作集里每只标的都有锚 —— 本 describe 验的是装配 / 批量 / 幂等形态,
    // 锚闸本身的双向行为归 `test/integration/marketdata-066.anchor-scoped-workset.it.spec.ts`。
    const anchorTickers = opts.anchorTickers ?? instruments.map((i) => `${i.market}:${i.code}`);
    const ivUpsert = vi.fn(async (_arg: unknown) => ({}));
    const getIvSnapshots = vi.fn(async (symbols: readonly string[]) => {
      if (opts.throwOnFetch) throw new Error('shim 502');
      return opts.snapshots ?? symbols.map((s) => snapshot(s));
    });
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      underlyingIv: { getIvSnapshots, getIvHistoryRange: vi.fn(async () => []) },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'underlying_iv_daily',
            enabled: true,
            cronExpr: '0 0 6 * * *',
            marketScope: ['us'],
            adjustTypes: ['none'],
            batchSize: opts.batchSize ?? 500,
            historyDepth: 1095,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: { findMany: vi.fn(async () => instruments) },
        anchor: { findMany: vi.fn(async () => anchorTickers.map((ticker) => ({ ticker }))) },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ underlyingIvDaily: { upsert: ivUpsert } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
      anchorGate: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      undefined, // revenueSegment → 默认 null-object
      undefined, // shareholderSnapshot → 默认 null-object
      undefined, // employee → 默认 null-object
      undefined, // industryClassification → 默认 null-object
      undefined, // announcement → 默认 null-object
      deps.anchorGate as never, // anchorGate (045 T015 采集闸重算)
      deps.underlyingIv as never, // underlyingIv (046 T008, 尾部)
    );
    return { registry, deps, spies: { getIvSnapshots, ivUpsert } };
  }

  /** delta 入参; `asOf` 蓄意给成**上海日** —— executor 必须自己按 us 时区求 A′, 不吃这个值。 */
  const ivInput = {
    mode: 'delta' as const,
    asOf: SHANGHAI_DATE,
    now: NOW_BEIJING_SAT_6AM,
  };

  it('工作集挂锚闸 (FR-026/FR-031): loadActiveInstruments 走**锚集**谓词 (066 T02 起 needSync 已退出), 且走 fact 前置 (tier + 锚闸重算)', async () => {
    const { registry, deps } = buildUnderlyingIvFakes();
    await registry.execute('underlying_iv_daily', ivInput);
    // 无锚不采 = 工作集 ∩ 锚集; 加第 13 只锚只需建锚, 零代码改动 (FR-031)。
    expect(deps.prisma.anchor.findMany).toHaveBeenCalledWith({ select: { ticker: true } });
    expect(deps.prisma.instrument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'active', OR: [{ market: 'us', code: { in: ['PEP', 'VICI'] } }] },
      }),
    );
    expect(deps.tierRecalc.recalcSafely).toHaveBeenCalledTimes(1);
    // 锚闸仍在前置里跑 —— 它重算的 `needSync` 是 `eod_bar` / `sync-profile` / backfill CLI
    // 那三个消费方的输入 (066 plan §A4: A3 与 A4 互补), 只是不再是本维度的工作集判据。
    expect(deps.anchorGate.recalcSafely).toHaveBeenCalledTimes(1);
  });

  it('批量形态 (FR-023): 整批一次 getIvSnapshots(symbols), 不是逐票 N 次', async () => {
    const { registry, spies } = buildUnderlyingIvFakes();
    const { stats } = await registry.execute('underlying_iv_daily', ivInput);
    expect(spies.getIvSnapshots).toHaveBeenCalledTimes(1);
    expect(spies.getIvSnapshots.mock.calls[0][0]).toEqual(['us:PEP', 'us:VICI']);
    expect(stats).toMatchObject({ scanned: 2, ok: 2, skipped: 0, failed: 0 });
  });

  it('batchSize 分批: 3 只 × batchSize=2 → 2 次调用 (vendor 单批上限的载体是维度行不是字面量)', async () => {
    const { registry, spies } = buildUnderlyingIvFakes({
      batchSize: 2,
      instruments: [
        { id: 1n, market: 'us', code: 'PEP' },
        { id: 2n, market: 'us', code: 'VICI' },
        { id: 3n, market: 'us', code: 'KO' },
      ],
    });
    await registry.execute('underlying_iv_daily', ivInput);
    expect(spies.getIvSnapshots).toHaveBeenCalledTimes(2);
    expect(spies.getIvSnapshots.mock.calls[0][0]).toEqual(['us:PEP', 'us:VICI']);
    expect(spies.getIvSnapshots.mock.calls[1][0]).toEqual(['us:KO']);
  });

  it('🚨 A′ 业务日期按 us 时区 (FR-028): 北京周六 06:00 落库日期 = 周五(ET), **不是**宿主日, 也不吃 input.asOf', async () => {
    const { registry, spies } = buildUnderlyingIvFakes();
    await registry.execute('underlying_iv_daily', ivInput);
    const dates = spies.ivUpsert.mock.calls.map((c) =>
      (c[0] as { where: { instrumentId_date: { date: Date } } }).where.instrumentId_date.date
        .toISOString()
        .slice(0, 10),
    );
    expect(dates).toEqual([US_BUSINESS_DATE, US_BUSINESS_DATE]);
    // 退回全局宿主日 = 日期错位一天 + 每周固定丢掉周五 (session-clock.ts 注释的失败形态表)。
    expect(dates).not.toContain(SHANGHAI_DATE);
  });

  it('幂等 upsert (FR-029): where = 唯一键 (instrumentId,date), create/update 同一份 data (禁 create-only)', async () => {
    const { registry, spies } = buildUnderlyingIvFakes();
    await registry.execute('underlying_iv_daily', ivInput);
    expect(spies.ivUpsert).toHaveBeenCalledTimes(2);
    const arg = spies.ivUpsert.mock.calls[0][0] as {
      where: { instrumentId_date: { instrumentId: bigint; date: Date } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.where.instrumentId_date.instrumentId).toBe(1n);
    // vendor 直读字段 1:1 落列; 金融数值全程 string 直传 Decimal 列 (禁过 JS number)。
    expect(arg.create).toMatchObject({ iv: '24.8', ivRank: '61.2', ivPercentile: '58.4' });
    expect(arg.update).toMatchObject({ iv: '24.8', ivRank: '61.2', ivPercentile: '58.4' });
    // symbol 是请求侧回填的路由字段, 不是列 —— 漏掉这条会让 Prisma 未知字段直接抛。
    expect(arg.create).not.toHaveProperty('symbol');
  });

  it('无期权标的整行缺席 (port 契约: 返回长度 < 请求长度) → 计 skipped 不计 failed, 且不给它写行', async () => {
    const { registry, spies } = buildUnderlyingIvFakes({ snapshots: [snapshot('us:PEP')] });
    const { stats } = await registry.execute('underlying_iv_daily', ivInput);
    expect(spies.ivUpsert).toHaveBeenCalledTimes(1);
    // 「今天没有 IV」既不是成功也不是失败 —— 计 skipped 才能与真失败区分开 (禁静默丢)。
    expect(stats).toMatchObject({ scanned: 2, ok: 1, skipped: 1, failed: 0 });
  });

  it('🚨 vendor 不可达 (FR-030): 计 failed 且不上抛, 告警按「可重拉」定档 (WARN 写明补救路径, 非当日必醒)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { registry, spies } = buildUnderlyingIvFakes({ throwOnFetch: true });
      const { stats } = await registry.execute('underlying_iv_daily', ivInput);
      expect(stats).toMatchObject({ scanned: 2, ok: 0, failed: 2 });
      expect(stats.failedTargets[0]).toMatchObject({ step: 'underlying_iv_daily' });
      // 失败发生在 tx 外的 HTTP 段 ⇒ 零写路径被触及 (「不破坏已落历史」的单测半边;
      // 真 DB 半边归 T011 IT)。
      expect(spies.ivUpsert).not.toHaveBeenCalled();
      // 告警等级 = 可重拉 (his_volatility 3 年滑动窗里还留着这一档读数), 不照抄期权链的
      // 「当日必须叫醒人」—— 那条是漏采即永久缺口才配的等级。
      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('underlying_iv_daily') && m.includes('可重拉'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// 046 T009 US3: underlying_iv_daily 的 **backfill 分支** = `his_volatility` 历史序列回填。
// 与 delta 分支同住一个维度但取数形态完全不同 (区间分页 vs 批量快照), 故单独一个 describe。
// 🚨 首次上线**拉满 vendor 上限约 3 年** (history_depth=1095): 那 3 年是**滑动窗**, 今天不拉、
// 明年再要中间那段就永久没了 —— 所以本组断言盯的是「窗口不重不漏」而不只是「跑通了」。
describe('046 T009 underlying_iv_daily backfill (his_volatility ≤364 天分页, 拉满 3 年)', () => {
  const NOW = new Date('2026-06-05T14:00:00Z');
  const AS_OF = '2026-06-05';
  /** 维度行 history_depth (seed 值): 约 3 年 = vendor 可回看上限。 */
  const THREE_YEARS_DAYS = 1095;

  function buildIvBackfillFakes(
    opts: {
      instruments?: { id: bigint; market: string; code: string }[];
      /** 指定 symbol 的取数抛错 (per-instrument 隔离验证)。 */
      throwOnSymbol?: string;
    } = {},
  ) {
    const instruments = opts.instruments ?? [{ id: 1n, market: 'us', code: 'PEP' }];
    const histCreateMany = vi.fn(async (_arg: unknown) => ({ count: 0 }));
    // 每窗各返 2 点 (窗首 / 窗尾) —— 让「合并后逐日无重无漏」可被真正观测到。
    const getIvHistoryRange = vi.fn(async (q: { symbol: string; from?: string; to?: string }) => {
      if (opts.throwOnSymbol && q.symbol === opts.throwOnSymbol) throw new Error('shim 502');
      return [
        { date: q.from as string, iv: '20.0', hv: '18.0', underlyingPrice: '150.0' },
        { date: q.to as string, iv: '21.0', hv: '19.0', underlyingPrice: '151.0' },
      ];
    });
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      underlyingIv: { getIvSnapshots: vi.fn(async () => []), getIvHistoryRange },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'underlying_iv_daily',
            enabled: true,
            cronExpr: '0 0 6 * * *',
            marketScope: ['us'],
            adjustTypes: ['none'],
            batchSize: 500,
            historyDepth: THREE_YEARS_DAYS,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: { findMany: vi.fn(async () => instruments) },
        // 066 T02: 本维度是**锚作用域**的 ⇒ 工作集判据先读锚表。让工作集里每只标的都有锚,
        // 本 describe 验的是分窗形态而非闸行为。
        anchor: {
          findMany: vi.fn(async () =>
            instruments.map((i) => ({ ticker: `${i.market}:${i.code}` })),
          ),
        },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ underlyingIvHistory: { createMany: histCreateMany } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
      anchorGate: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      undefined, // revenueSegment → 默认 null-object
      undefined, // shareholderSnapshot → 默认 null-object
      undefined, // employee → 默认 null-object
      undefined, // industryClassification → 默认 null-object
      undefined, // announcement → 默认 null-object
      deps.anchorGate as never, // anchorGate (045 T015 采集闸重算)
      deps.underlyingIv as never, // underlyingIv (046 T008, 尾部)
    );
    return { registry, deps, spies: { getIvHistoryRange, histCreateMany } };
  }

  const backfillInput = {
    mode: 'backfill' as const,
    asOf: AS_OF,
    now: NOW,
    backfillHistoryDays: THREE_YEARS_DAYS,
  };

  it('🚨 3 年区间 → 4 个 ≤364 天窗口: 首尾相接**不重不漏**, 首窗起 = asOf−1095, 末窗止 = asOf', async () => {
    const { registry, spies } = buildIvBackfillFakes();
    await registry.execute('underlying_iv_daily', backfillInput);
    const calls = spies.getIvHistoryRange.mock.calls.map((c) => c[0]);
    // ⌈(1095+1) / 364⌉ = 4 页 (含首尾计数)。
    expect(calls).toHaveLength(4);
    expect(calls[0].from).toBe(subtractDays(AS_OF, THREE_YEARS_DAYS));
    expect(calls[3].to).toBe(AS_OF); // 末窗被 asOf 截断, 绝不越界
    const DAY = 86_400_000;
    for (const [i, c] of calls.entries()) {
      const span = (Date.parse(`${c.to}T00:00:00Z`) - Date.parse(`${c.from}T00:00:00Z`)) / DAY + 1;
      expect(span).toBeLessThanOrEqual(364); // vendor 单次跨度上限 (超限 shim 400, 不静默截断)
      if (i > 0) {
        // 下一窗起点 = 上一窗终点 **+1 天** —— +0 会让边界那天被拉两次, +2 会漏一天,
        // 两者都不报错, 只在库里变成重复行或永久空洞。
        const prevEnd = Date.parse(`${calls[i - 1].to}T00:00:00Z`);
        expect(Date.parse(`${c.from}T00:00:00Z`) - prevEnd).toBe(DAY);
      }
    }
  });

  it('分页结果合并后**逐日无重无漏**: 8 点全部落库, 日期严格升序且零重复', async () => {
    const { registry, spies } = buildIvBackfillFakes();
    const { stats } = await registry.execute('underlying_iv_daily', backfillInput);
    const rows = spies.histCreateMany.mock.calls.flatMap(
      (c) => (c[0] as { data: { instrumentId: bigint; date: Date }[] }).data,
    );
    expect(rows).toHaveLength(8); // 4 窗 × 每窗 2 点
    const dates = rows.map((r) => r.date.toISOString().slice(0, 10));
    expect(new Set(dates).size).toBe(dates.length); // 零重复 (窗口不重叠的可观测后果)
    expect([...dates].sort()).toEqual(dates); // 升序 (port 契约: adapter 已翻正)
    expect(rows.every((r) => r.instrumentId === 1n)).toBe(true);
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('createMany({skipDuplicates}) 落 underlying_iv_history: iv/hv/underlyingPrice 三列 string 直传', async () => {
    const { registry, spies } = buildIvBackfillFakes();
    await registry.execute('underlying_iv_daily', backfillInput);
    const arg = spies.histCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: Record<string, unknown>[];
    };
    expect(arg.skipDuplicates).toBe(true); // 重跑幂等兜底 (唯一键 instrument_id+date)
    expect(arg.data[0]).toMatchObject({ iv: '20.0', hv: '18.0', underlyingPrice: '150.0' });
  });

  it('per-instrument 隔离: 单只取数失败计 failed, 其余标的照常回填 (重跑幂等补齐)', async () => {
    const { registry, spies } = buildIvBackfillFakes({
      instruments: [
        { id: 1n, market: 'us', code: 'PEP' },
        { id: 2n, market: 'us', code: 'VICI' },
      ],
      throwOnSymbol: 'us:PEP',
    });
    const { stats } = await registry.execute('underlying_iv_daily', backfillInput);
    expect(stats).toMatchObject({ scanned: 2, ok: 1, failed: 1 });
    expect(stats.failedTargets[0]).toMatchObject({ symbol: 'us:PEP', step: 'underlying_iv_daily' });
    // 失败的那只零落库, 成功的那只 4 窗照落。
    const rows = spies.histCreateMany.mock.calls.flatMap(
      (c) => (c[0] as { data: { instrumentId: bigint }[] }).data,
    );
    expect(rows.every((r) => r.instrumentId === 2n)).toBe(true);
  });

  it('回归护栏: delta 分支不碰历史序列 (零 getIvHistoryRange), backfill 分支不碰快照端点', async () => {
    const { registry, deps, spies } = buildIvBackfillFakes();
    await registry.execute('underlying_iv_daily', { mode: 'delta', asOf: AS_OF, now: NOW });
    expect(spies.getIvHistoryRange).not.toHaveBeenCalled();
    expect(deps.underlyingIv.getIvSnapshots).toHaveBeenCalledTimes(1);
    deps.underlyingIv.getIvSnapshots.mockClear();
    await registry.execute('underlying_iv_daily', backfillInput);
    expect(deps.underlyingIv.getIvSnapshots).not.toHaveBeenCalled();
  });
});

// 046 T010 US3: IVP **双算对表** —— 采集 underlying_iv_daily 时顺带由 underlying_iv_history
// 自算一次分位, 与 overview 直读值比对, 三档进告警面 (FR-034)。
//
// 🚨 **只进告警, 不进写路径 / 不进 API / 不进 UI** (FR-035 显示口径单源): 界面显示的 IVP 恒为
// 直读值。本组末两条就是钉这件事的机械防线 —— 自算值一旦顺着落库行漏出去, 同一个读数就有了
// 两个来源, 而这恰恰是本对表要监控的东西本身。(API DTO 那半边的断言归 T015。)
describe('046 T010 IVP 双算对表 → 采集侧告警 (三档 + 窗口不足跳过 + 自算值不外泄)', () => {
  const NOW = new Date('2026-06-12T22:00:00Z'); // 北京周六 06:00 ⇒ us 业务日 2026-06-12
  const AS_OF = '2026-06-13';

  /** 252 个样本: 126 个 10 + 126 个 90 ⇒ 当前值 50 的自算分位恰为 50.0000pp。 */
  function historyRows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      iv: new Prisma.Decimal(i % 2 === 0 ? 10 : 90),
    }));
  }

  function buildDivergenceFakes(opts: {
    vendorIvPercentile: string | null;
    historyCount?: number;
  }) {
    const ivUpsert = vi.fn(async (_arg: unknown) => ({}));
    const histFindMany = vi.fn(async (_arg: unknown) => historyRows(opts.historyCount ?? 252));
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      underlyingIv: {
        getIvSnapshots: vi.fn(async () => [
          {
            symbol: 'us:PEP',
            iv: '50', // 自算分位 = 50.0000pp (126/252 严格低于)
            ivRank: '61.2',
            ivPercentile: opts.vendorIvPercentile, // 直读值 = 显示口径单源
            preIv: null,
            hv30: null,
            hv30Percentile: null,
            hv60: null,
            hv60Percentile: null,
            hv90: null,
            hv90Percentile: null,
            hv120: null,
            hv120Percentile: null,
            hv365: null,
            hv365Percentile: null,
            callVolume: null,
            putVolume: null,
            callOi: null,
            putOi: null,
          },
        ]),
        getIvHistoryRange: vi.fn(async () => []),
      },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'underlying_iv_daily',
            enabled: true,
            cronExpr: '0 0 6 * * *',
            marketScope: ['us'],
            adjustTypes: ['none'],
            batchSize: 500,
            historyDepth: 1095,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: { findMany: vi.fn(async () => [{ id: 1n, market: 'us', code: 'PEP' }]) },
        // 066 T02: 本维度是**锚作用域**的 ⇒ 工作集判据先读锚表 (这里给 PEP 一只锚)。
        anchor: { findMany: vi.fn(async () => [{ ticker: 'us:PEP' }]) },
        underlyingIvHistory: { findMany: histFindMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ underlyingIvDaily: { upsert: ivUpsert } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
      anchorGate: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer
      undefined, // shortSelling
      undefined, // connectHolding
      undefined, // fundHolding
      undefined, // fundCompanyHolding
      undefined, // indexMembership
      undefined, // volatility
      undefined, // hotSnapshot
      undefined, // buyback
      undefined, // equityChange
      undefined, // shareholderChange
      undefined, // allotment
      undefined, // revenueSegment
      undefined, // shareholderSnapshot
      undefined, // employee
      undefined, // industryClassification
      undefined, // announcement
      deps.anchorGate as never, // anchorGate
      deps.underlyingIv as never, // underlyingIv (046 T008)
    );
    return { registry, deps, spies: { ivUpsert, histFindMany } };
  }

  /** 跑一轮 delta 并收集本维度打出的 WARN / ERROR 文本。 */
  async function runAndCollectAlerts(opts: {
    vendorIvPercentile: string | null;
    historyCount?: number;
  }) {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { registry, spies, deps } = buildDivergenceFakes(opts);
      const { stats } = await registry.execute('underlying_iv_daily', {
        mode: 'delta',
        asOf: AS_OF,
        now: NOW,
      });
      return {
        stats,
        spies,
        deps,
        warns: warn.mock.calls.map((c) => String(c[0])),
        errors: error.mock.calls.map((c) => String(c[0])),
      };
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }

  const ivpAlerts = (msgs: string[]) => msgs.filter((m) => m.includes('IVP 双算对表'));

  it('档① 差 ≤2pp (直读 51 vs 自算 50) → 静默: 零 IVP 告警, 采集照常计 ok', async () => {
    const r = await runAndCollectAlerts({ vendorIvPercentile: '51' });
    expect(ivpAlerts(r.warns)).toHaveLength(0);
    expect(ivpAlerts(r.errors)).toHaveLength(0);
    expect(r.stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
  });

  it('档② 2pp < 差 ≤5pp (直读 53 vs 自算 50) → WARN 进复核名单, 不升 ERROR', async () => {
    const r = await runAndCollectAlerts({ vendorIvPercentile: '53' });
    expect(ivpAlerts(r.warns)).toHaveLength(1);
    expect(ivpAlerts(r.warns)[0]).toContain('us:PEP');
    expect(ivpAlerts(r.errors)).toHaveLength(0);
  });

  it('档③ 差 >5pp (直读 57 vs 自算 50) → 硬门 ERROR (疑似 vendor 聚合口径漂移)', async () => {
    const r = await runAndCollectAlerts({ vendorIvPercentile: '57' });
    expect(ivpAlerts(r.errors)).toHaveLength(1);
    expect(ivpAlerts(r.errors)[0]).toContain('us:PEP');
  });

  it('🚨 窗口不足 (251 < 252 交易日) → 跳过对表且**不告警** (缺窗口不是口径漂移)', async () => {
    const r = await runAndCollectAlerts({ vendorIvPercentile: '99', historyCount: 251 });
    // 差 49pp 远超硬门, 但样本不够就不成立对表 —— 否则告警面会被上线头一年的新标的刷屏。
    expect(ivpAlerts(r.warns)).toHaveLength(0);
    expect(ivpAlerts(r.errors)).toHaveLength(0);
    expect(r.stats).toMatchObject({ ok: 1, failed: 0 });
  });

  it('🚨 vendor 直读分位缺失 → 无可比对象, 跳过且不告警 (禁拿 0 当直读值)', async () => {
    const r = await runAndCollectAlerts({ vendorIvPercentile: null });
    expect(ivpAlerts(r.warns)).toHaveLength(0);
    expect(ivpAlerts(r.errors)).toHaveLength(0);
  });

  it('🚨 自算值 MUST NOT 进写路径 (FR-035): 硬门档下落库 ivPercentile 仍 = 直读值, 行内零自算字段', async () => {
    const r = await runAndCollectAlerts({ vendorIvPercentile: '57' });
    const arg = r.spies.ivUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    // 显示口径单源: 落的是直读 57, **不是**自算 50 —— UI 读的就是这一列。
    expect(arg.create.ivPercentile).toBe('57');
    expect(arg.update.ivPercentile).toBe('57');
    // 行内不得出现任何自算/差异字段 (它一旦成列, 下一步就会顺着 DTO 漏上屏)。
    const leaked = Object.keys(arg.create).filter((k) => /self|diverg|computed/i.test(k));
    expect(leaked).toEqual([]);
  });

  it('对表自身出错不拖垮采集: 历史序列查询抛错 → 仍计 ok 且已落库不回滚', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { registry, deps, spies } = buildDivergenceFakes({ vendorIvPercentile: '53' });
      deps.prisma.underlyingIvHistory.findMany = vi.fn(async () => {
        throw new Error('pg down');
      });
      const { stats } = await registry.execute('underlying_iv_daily', {
        mode: 'delta',
        asOf: AS_OF,
        now: NOW,
      });
      // 对表是**监控侧信道**, 不是采集的前置条件 —— 它挂了不该让当天的 IV 采集一起丢。
      expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
      expect(spies.ivUpsert).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// 046 T013 US3: us_index_daily 装配 (FR-025/FR-027/FR-028/FR-029)。
// 第 5 形态: **固定代码集 + 全量文件** —— 工作集不是「查出来的标的」而是两个常量, 取数不是
// 「按区间问 vendor」而是整份覆盖式历史文件。
//
// 🚨 本 describe 的头两条是 Guardrail 1 的**机械断言**: 指数维度 MUST NOT 挂锚闸。挂了不会
// 红、只会在零锚时静默不跑 —— 所以「不跑锚闸」这件事必须被**主动**断言, 而不是靠「测试没报错」。
//
// 本 spec 住 src/ 且非 .it. ⇒ unit project, 零容器是机器强制的硬不变量 ⇒ **只放纯逻辑**:
// 工作集构造 / A′ us 时区 / 写形态 / 计数上抛 / per-code 隔离。
// 「同日重跑真幂等」需真 DB ⇒ 归 T014 的 IT (同 T008 的切分纪律), 禁往这里塞容器。
describe('046 T013 us_index_daily 装配 (固定 2 代码 + 不挂锚闸 + 全量文件写 + A′ us 时区)', () => {
  /** 北京 2026-06-13(周六) 06:00 = us 维度 cron 时刻; ET 侧还是 2026-06-12(周五) 18:00。 */
  const NOW_BEIJING_SAT_6AM = new Date('2026-06-12T22:00:00Z');
  const US_BUSINESS_DATE = '2026-06-12';
  const SHANGHAI_DATE = '2026-06-13';

  const vixRow = (date: string): UsIndexDailyPoint => ({
    date,
    open: '15.2100',
    high: '15.9800',
    low: '14.8700',
    close: '15.4300',
  });
  /** 🚨 VVIX 源文件只有 `DATE,VVIX` ⇒ 其余 OHLC 恒 null, **禁填 0** (Guardrail 7)。 */
  const vvixRow = (date: string): UsIndexDailyPoint => ({
    date,
    open: null,
    high: null,
    low: null,
    close: '92.3100',
  });

  function buildUsIndexFakes(
    opts: {
      /** 逐 code 的行序列 (缺省 = 各 2 行)。 */
      rowsByCode?: Partial<Record<'VIX' | 'VVIX', UsIndexDailyPoint[]>>;
      /** 逐 code 的非法行计数 (adapter 上抛的那个)。 */
      skippedByCode?: Partial<Record<'VIX' | 'VVIX', number>>;
      /** 这些 code 取数抛错 (源不可达 / 表头变更)。 */
      throwFor?: ('VIX' | 'VVIX')[];
    } = {},
  ) {
    const rowsByCode = opts.rowsByCode ?? {
      VIX: [vixRow('2026-06-11'), vixRow(US_BUSINESS_DATE)],
      VVIX: [vvixRow('2026-06-11'), vvixRow(US_BUSINESS_DATE)],
    };
    const indexUpsert = vi.fn(async (_arg: unknown) => ({}));
    const indexCreateMany = vi.fn(async (_arg: unknown) => ({ count: 0 }));
    const getIndexHistory = vi.fn(async (indexCode: 'VIX' | 'VVIX') => {
      if (opts.throwFor?.includes(indexCode)) throw new Error(`cboe 502 (${indexCode} 不可达)`);
      return {
        indexCode,
        rows: rowsByCode[indexCode] ?? [],
        skipped: opts.skippedByCode?.[indexCode] ?? 0,
        skippedSamples: [],
      };
    });
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => []) },
      financials: { getFinancials: vi.fn(async () => []) },
      corporateAction: { getCorporateActions: vi.fn(async () => []) },
      usIndex: { getIndexHistory },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'us_index_daily',
            enabled: true,
            cronExpr: '0 0 10 * * *',
            marketScope: ['us'],
            adjustTypes: ['none'],
            batchSize: 1,
            historyDepth: null,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: null,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        // 🚨 存在但**必须一次都不被调用** —— 见「不挂锚闸」两条断言。
        instrument: { findMany: vi.fn(async () => []) },
        usIndexDaily: { createMany: indexCreateMany },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ usIndexDaily: { upsert: indexUpsert } }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
      anchorGate: { recalcSafely: vi.fn(async () => null) },
    };
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      undefined, // revenueSegment → 默认 null-object
      undefined, // shareholderSnapshot → 默认 null-object
      undefined, // employee → 默认 null-object
      undefined, // industryClassification → 默认 null-object
      undefined, // announcement → 默认 null-object
      deps.anchorGate as never, // anchorGate (045 T015 采集闸重算)
      undefined, // underlyingIv (046 T008) → 默认 null-object
      deps.usIndex as never, // usIndex (046 T013, 尾部第 29 位)
    );
    return { registry, deps, spies: { getIndexHistory, indexUpsert, indexCreateMany } };
  }

  /** delta 入参; `asOf` 蓄意给成**上海日** —— executor 必须自己按 us 时区求 A′, 不吃这个值。 */
  const indexInput = { mode: 'delta' as const, asOf: SHANGHAI_DATE, now: NOW_BEIJING_SAT_6AM };

  const upsertedKeys = (upsert: ReturnType<typeof vi.fn>) =>
    upsert.mock.calls.map((c) => {
      const arg = c[0] as { where: { indexCode_date: { indexCode: string; date: Date } } };
      return `${arg.where.indexCode_date.indexCode}@${arg.where.indexCode_date.date
        .toISOString()
        .slice(0, 10)}`;
    });

  it('🚨 不挂锚闸 (FR-027 / Guardrail 1): 零 Instrument / 零锚照常跑满两个代码', async () => {
    // 库里**一行 Instrument 都没有**, 更没有锚 —— 标的级维度在这种库上会空转, 指数维度不许。
    const { registry, spies } = buildUsIndexFakes();
    const { stats } = await registry.execute('us_index_daily', indexInput);

    expect(spies.getIndexHistory.mock.calls.map((c) => c[0])).toEqual(['VIX', 'VVIX']);
    // 照常落数 = 4 行 (两个代码各 2 行)。零锚时它**必须**有产出, 否则 FR-018 的空态分支
    // 「指数表盘不依赖锚, 零锚照常渲染」在数据侧根本不成立。
    expect(stats).toMatchObject({ scanned: 4, ok: 4, skipped: 0, failed: 0 });
    expect(upsertedKeys(spies.indexUpsert)).toEqual([
      `VIX@2026-06-11`,
      `VIX@${US_BUSINESS_DATE}`,
      `VVIX@2026-06-11`,
      `VVIX@${US_BUSINESS_DATE}`,
    ]);
  });

  it('🚨 不走 loadActiveInstruments (Guardrail 1 的直接判据): instrument.findMany 调用次数 = 0, 且不跑 fact 前置', async () => {
    const { registry, deps } = buildUsIndexFakes();
    await registry.execute('us_index_daily', indexInput);

    // 工作集 = 两个固定代码常量。查一次 Instrument 就说明它走上了 factExecutor 那条路,
    // 而那条路上 `needSync=true` 谓词会在零锚时把工作集清空 ⇒ 静默不跑。
    expect(deps.prisma.instrument.findMany).toHaveBeenCalledTimes(0);
    // 锚闸重算 / tier 重算都是 fact 前置的一部分, 指数维度与它们无关 (跑了不会错但语义是错的:
    // 会让「指数依赖锚表状态」这条假依赖在调用图上成立)。
    expect(deps.anchorGate.recalcSafely).toHaveBeenCalledTimes(0);
    expect(deps.tierRecalc.recalcSafely).toHaveBeenCalledTimes(0);
  });

  it('🚨 A′ 业务日期按 us 时区 (FR-028): 晚于 A′ 的行被拦下计 skipped, **不吃 input.asOf**', async () => {
    // 上海日 06-13 那一行: 若 executor 退回 `input.asOf` (上海日) 当上界, 它就会被放行。
    const { registry, spies } = buildUsIndexFakes({
      rowsByCode: {
        VIX: [vixRow(US_BUSINESS_DATE), vixRow(SHANGHAI_DATE)],
        VVIX: [vvixRow(US_BUSINESS_DATE)],
      },
    });
    const { stats } = await registry.execute('us_index_daily', indexInput);

    const keys = upsertedKeys(spies.indexUpsert);
    expect(keys).toEqual([`VIX@${US_BUSINESS_DATE}`, `VVIX@${US_BUSINESS_DATE}`]);
    expect(keys.some((k) => k.includes(SHANGHAI_DATE))).toBe(false);
    expect(stats).toMatchObject({ scanned: 3, ok: 2, skipped: 1, failed: 0 });
  });

  it('VVIX 的 OHLC 透传 null **不填 0** (Guardrail 7 / FR-025)', async () => {
    const { registry, spies } = buildUsIndexFakes({
      rowsByCode: { VIX: [], VVIX: [vvixRow(US_BUSINESS_DATE)] },
    });
    await registry.execute('us_index_daily', indexInput);

    const arg = spies.indexUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.create).toMatchObject({ open: null, high: null, low: null, close: '92.3100' });
    // 幂等 upsert: create/update 同一份 data (禁 create-only —— 那样修订值永远进不来)。
    expect(arg.update).toMatchObject({ open: null, high: null, low: null, close: '92.3100' });
  });

  it('非法行计数**上抛**进 stats.skipped (禁静默丢 → 随 SyncRun 落库)', async () => {
    const { registry } = buildUsIndexFakes({ skippedByCode: { VIX: 3, VVIX: 1 } });
    const { stats } = await registry.execute('us_index_daily', indexInput);

    // scanned = 合法行 + 非法行 (文件里的数据行总数); skipped 承载非法行。
    expect(stats).toMatchObject({ scanned: 8, ok: 4, skipped: 4, failed: 0 });
  });

  it('全量文件写形态: 尾部窗口 upsert + 其余 createMany(skipDuplicates), 分片不撑爆事务', async () => {
    // 30 行 > 尾部窗口 ⇒ 头部走 createMany、尾部走 upsert。整份历史每天逐行 upsert 是
    // 14k 次往返/天, 而历史结算值不变 —— 只有尾部那几天可能被修订。
    const many = Array.from({ length: 30 }, (_, i) =>
      vixRow(`2026-05-${String(i + 1).padStart(2, '0')}`),
    );
    const { registry, spies } = buildUsIndexFakes({ rowsByCode: { VIX: many, VVIX: [] } });
    const { stats } = await registry.execute('us_index_daily', indexInput);

    expect(stats).toMatchObject({ scanned: 30, ok: 30, skipped: 0, failed: 0 });
    const createArg = spies.indexCreateMany.mock.calls[0][0] as {
      data: { indexCode: string; date: Date }[];
      skipDuplicates: boolean;
    };
    // 幂等语义载体 = 唯一键 (index_code, date) + skipDuplicates; 同日重跑零新增 (真库半边归 T014)。
    expect(createArg.skipDuplicates).toBe(true);
    expect(createArg.data).toHaveLength(20);
    expect(upsertedKeys(spies.indexUpsert)).toHaveLength(10);
    // 头尾切分**无缝无叠**: 两条通路合起来恰好覆盖全部 30 行。
    const head = createArg.data.map((r) => `VIX@${r.date.toISOString().slice(0, 10)}`);
    expect([...head, ...upsertedKeys(spies.indexUpsert)]).toEqual(many.map((r) => `VIX@${r.date}`));
  });

  it('per-code 隔离 (FR-030 档): 一个代码取数失败计 failed, 另一个照常落 + SyncRun 收 partial', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { registry, deps, spies } = buildUsIndexFakes({ throwFor: ['VIX'] });
      const { stats } = await registry.execute('us_index_daily', indexInput);

      // VIX 整份文件没拿到 ⇒ 计 1 个失败**目标**(单位是文件不是行, 失败时无行可计);
      // VVIX 的 2 行照常落 —— 一个源抖动不该把另一个指数一起拖没。
      expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 1 });
      expect(stats.failedTargets[0]).toMatchObject({ symbol: 'VIX', step: 'us_index_daily' });
      expect(upsertedKeys(spies.indexUpsert)).toEqual([
        `VVIX@2026-06-11`,
        `VVIX@${US_BUSINESS_DATE}`,
      ]);
      // 不上抛: 抛出去会让 worker 按「崩溃」重试整轮, 而这是「下次重跑即可补齐」的一档
      // (全量文件天然自愈: 明天那份文件里今天这行还在)。
      expect(deps.recorder.finish).toHaveBeenCalledWith(1n, 'partial', expect.anything());
      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('us_index_daily') && m.includes('VIX'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('两个代码全失败 → SyncRun 收 failed, 零写路径被触及', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { registry, deps, spies } = buildUsIndexFakes({ throwFor: ['VIX', 'VVIX'] });
      const { stats } = await registry.execute('us_index_daily', indexInput);

      expect(stats).toMatchObject({ scanned: 0, ok: 0, skipped: 0, failed: 2 });
      // 失败发生在写之前 ⇒ 零写路径被触及 (「不破坏已落历史」的单测半边; 真 DB 半边归 T014)。
      expect(spies.indexUpsert).not.toHaveBeenCalled();
      expect(spies.indexCreateMany).not.toHaveBeenCalled();
      expect(deps.recorder.finish).toHaveBeenCalledWith(1n, 'failed', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('backfill 与 delta 同形: 全量文件无「回填区间」概念 (delta_lookback_days / historyDepth 不适用)', async () => {
    const { registry, spies } = buildUsIndexFakes();
    const delta = await registry.execute('us_index_daily', indexInput);
    const backfill = await registry.execute('us_index_daily', {
      mode: 'backfill',
      asOf: SHANGHAI_DATE,
      now: NOW_BEIJING_SAT_6AM,
      backfillHistoryDays: 3650,
    });

    // 两种 mode 拿的是同一份覆盖式文件、写同一批行 —— 没有 mode 分支可走。
    expect(delta.stats).toMatchObject({ scanned: 4, ok: 4 });
    expect(backfill.stats).toMatchObject({ scanned: 4, ok: 4 });
    expect(spies.getIndexHistory).toHaveBeenCalledTimes(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 047 T003 三个新维度的注册 + 依赖拓扑守卫。
//
// 为什么拓扑要在 Small 层验而不是只靠 seed migration: `sync_dependency` 的真相在 PG,
// 但**派生全序**是纯函数 `deriveExecutionOrder(edges, priority)` 算出来的, 而装配器
// (`assembleSyncFlow` → `assertEdgesExpressible`) 对 **hard 边有「在 won 链必须相邻」的
// 硬约束** —— 一条新维度只要 priority 取值让它插进某条 hard 边中间, 夜间 flow 装配就会
// **运行期 throw**, 而 seed migration 本身跑得绿绿的。⇒ 下面的 fixture 是 seed 现状的
// 快照, 断言的是「本片新增三行不破坏任何 hard 边的相邻性」。
// ⚠️ 实测过的反例: `earnings_event` 若取 priority 5, 同 priority 下 key 字典序
//    'earnings_event' < 'eod_bar' 会让它插进既有 hard 边 corporate_action→eod_bar 中间。
//    这就是它取 4 而非跟其余 us 维度一样取 5 的原因 —— 不是随手填的。
// ─────────────────────────────────────────────────────────────────────────────

/** seed 现状快照 (marketdata.sync_dimension.priority; 末三行 = 047 本片新增)。 */
const LIVE_SEED_PRIORITIES = new Map<string, number>([
  ['universe', 10],
  ['profile', 9],
  ['fundamental', 8],
  ['financial', 7],
  ['corporate_action', 6],
  ['eod_bar', 5],
  ['underlying_iv_daily', 5],
  ['us_equity_bar', 5],
  ['us_index_daily', 5],
  ['buyback', 4],
  ['revenue_segment', 4],
  ['short_selling', 4],
  ['volatility', 4],
  ['connect_holding', 3],
  ['equity_change', 3],
  ['hot_snapshot', 3],
  ['shareholder_snapshot', 3],
  ['employee', 2],
  ['fund_holding', 2],
  ['industry_classification', 2],
  ['shareholder_change', 2],
  ['allotment', 1],
  ['announcement', 1],
  ['fund_company_holding', 1],
  ['index_membership', 0],
  ['option_contract', 5],
  ['option_daily_snapshot', 5],
  ['earnings_event', 4],
  // 066 T04 港股三行 (migration 20260823_1015_seed_hk_option_dimensions)。全取 priority 5:
  // 同 priority 下 key 字典序 asc, 而 'eod_bar' < 'hk_*' < 'option_*' ⇒ 既有两条 hard 边
  // (corporate_action→eod_bar / option_contract→option_daily_snapshot) 的相邻性不受影响,
  // 且 'hk_option_contract' < 'hk_option_daily_snapshot' 让本片新增的 hard 边自然相邻。
  ['hk_option_contract', 5],
  ['hk_option_daily_snapshot', 5],
  ['hk_underlying_iv_daily', 5],
]);

/** seed 现状快照 (marketdata.sync_dependency; 末三条 = 047 本片新增)。 */
const LIVE_SEED_EDGES: SyncDependencyEdge[] = [
  { upstream: 'corporate_action', downstream: 'eod_bar', mode: 'hard' },
  { upstream: 'profile', downstream: 'fundamental', mode: 'hard' },
  ...(
    [
      'allotment',
      'announcement',
      'buyback',
      'connect_holding',
      'corporate_action',
      'employee',
      'eod_bar',
      'equity_change',
      'financial',
      'fund_company_holding',
      'fund_holding',
      'fundamental',
      'hot_snapshot',
      'index_membership',
      'industry_classification',
      'profile',
      'revenue_segment',
      'shareholder_change',
      'shareholder_snapshot',
      'short_selling',
      'underlying_iv_daily',
      'us_equity_bar',
      'volatility',
    ] as const
  ).map((d): SyncDependencyEdge => ({ upstream: 'universe', downstream: d, mode: 'soft' })),
  // 047 新增: 两条 universe soft (合约 / 财报都 FK→instrument, 标的须先注册; soft = 只定
  // 执行序、不构成工作集闸 —— 别把它读成锚闸)。
  { upstream: 'universe', downstream: 'option_contract', mode: 'soft' },
  { upstream: 'universe', downstream: 'earnings_event', mode: 'soft' },
  // 047 新增: 快照 **hard** 依赖链发现 (FR-031 —— 无合约表即无从取快照)。
  { upstream: 'option_contract', downstream: 'option_daily_snapshot', mode: 'hard' },
  // 066 T04 新增: 港股两条 universe soft (链发现 / 标的 IV 都 FK→instrument) + 一条 hard
  // (港股快照依赖港股链发现, 同 047 的美股形态)。🚨 `hk_option_daily_snapshot` 同样**刻意
  // 没有 universe 边** —— 多一个前驱会让它在 Kahn 拓扑里与那条 hard 边争相邻位 (047 先例)。
  { upstream: 'universe', downstream: 'hk_option_contract', mode: 'soft' },
  { upstream: 'universe', downstream: 'hk_underlying_iv_daily', mode: 'soft' },
  { upstream: 'hk_option_contract', downstream: 'hk_option_daily_snapshot', mode: 'hard' },
];

describe('047 T003 三个新维度注册 + 依赖拓扑守卫', () => {
  const order = deriveExecutionOrder(LIVE_SEED_EDGES, LIVE_SEED_PRIORITIES);
  const pos = (key: string): number => order.indexOf(key);

  it('seed 快照里的每个维度键都在 DIMENSION_KEYS 在册 (注册表 ↔ seed 双向不漏)', () => {
    for (const key of LIVE_SEED_PRIORITIES.keys()) {
      expect(DIMENSION_KEYS).toContain(key);
    }
  });

  it('快照排在链发现之后 (FR-031 hard 依赖: 无合约表即无从取快照)', () => {
    expect(pos('option_contract')).toBeGreaterThanOrEqual(0);
    expect(pos('option_daily_snapshot')).toBeGreaterThan(pos('option_contract'));
  });

  it('hard 边两端在全序里相邻 —— 含既有两条 (新维度不得插进 hard 边中间, 否则夜间装配 throw)', () => {
    for (const e of LIVE_SEED_EDGES.filter((x) => x.mode === 'hard')) {
      expect(pos(e.downstream)).toBe(pos(e.upstream) + 1);
    }
  });

  it('earnings_event 取 priority 4 是必需的: 取 5 会插进 corporate_action→eod_bar 这条 hard 边中间', () => {
    const broken = new Map(LIVE_SEED_PRIORITIES).set('earnings_event', 5);
    const brokenOrder = deriveExecutionOrder(LIVE_SEED_EDGES, broken);
    // 反例守卫: 若哪天 tie-break 规则变了、这条不再成立, 上面那条 priority 注释就该重写。
    expect(brokenOrder.indexOf('eod_bar')).toBeGreaterThan(
      brokenOrder.indexOf('corporate_action') + 1,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 066 T04 港股三维度 seed 的依赖拓扑守卫 (FR-015, plan §A1)。
//
// 与上面 047 那块**同一条**失败形态: seed migration 自己跑得绿绿的, 错的是 priority 取值让
// 某条 hard 边的两端在派生全序里不再相邻 ⇒ **夜间 flow 装配运行期 throw**
// (`assembleSyncFlow` → `assertEdgesExpressible`)。港股这一片新增的 hard 边
// `hk_option_contract → hk_option_daily_snapshot` 与既有两条一样, 只能靠这一层钉住。
//
// 🚨 本片新增的第三行 `hk_underlying_iv_daily` **不在任何 hard 边上**, 但它同样会破事 ——
//    它只要 priority 取得比 5 高, 就会在 `corporate_action` 与 `eod_bar` 之间被选走, 把一条
//    与港股期权毫无关系的既有 hard 边掰断。下面的反例把这条钉住。
// ─────────────────────────────────────────────────────────────────────────────
describe('066 T04 港股三维度 seed 的依赖拓扑守卫', () => {
  const order = deriveExecutionOrder(LIVE_SEED_EDGES, LIVE_SEED_PRIORITIES);
  const pos = (key: string): number => order.indexOf(key);

  it('三个港股维度键都在 DIMENSION_KEYS 在册 (seed 行有、executor 无 ⇒ 每晚 runDimension throw)', () => {
    for (const key of [
      'hk_option_contract',
      'hk_option_daily_snapshot',
      'hk_underlying_iv_daily',
    ]) {
      expect(DIMENSION_KEYS).toContain(key);
    }
  });

  it('港股快照排在港股链发现之后且**相邻** (hard 边, 非相邻 = 失败传播绕不过中间节点)', () => {
    expect(pos('hk_option_contract')).toBeGreaterThanOrEqual(0);
    expect(pos('hk_option_daily_snapshot')).toBe(pos('hk_option_contract') + 1);
  });

  it('🚨 港股三行不得掰断既有两条 hard 边 —— 反例: hk_underlying_iv_daily 取 priority 6', () => {
    // 正例: 现行 seed 值下 corporate_action→eod_bar 仍相邻 (上面 047 那块的全量循环也覆盖,
    // 这里单列是为了让反例有对照 —— 只有反例的守卫看不出「正例本来是什么样」)。
    expect(pos('eod_bar')).toBe(pos('corporate_action') + 1);

    const broken = new Map(LIVE_SEED_PRIORITIES).set('hk_underlying_iv_daily', 6);
    const brokenOrder = deriveExecutionOrder(LIVE_SEED_EDGES, broken);
    // 'corporate_action' < 'hk_underlying_iv_daily' 字典序 ⇒ 同 priority 6 时 corp 先被选,
    // 随后 hk_underlying_iv_daily 仍以 6 压过 priority 5 的 eod_bar 插进中间。
    expect(brokenOrder.indexOf('eod_bar')).toBeGreaterThan(
      brokenOrder.indexOf('corporate_action') + 1,
    );
  });

  it('港股三行不打乱美股期权那对 hard 边的相邻性 (纯增量: 047 的结论逐点不变)', () => {
    expect(pos('option_daily_snapshot')).toBe(pos('option_contract') + 1);
  });
});

// #103 (063 Phase 3.3): `written` 是**落库侧**唯一的那个数, 三态 null/0/>0 各有语义。
// 🚨 它曾在 `execute()` ↔ `factExecutor` 的 stats 交接处**整列丢失** —— `mergeStats` 搬了
//    scanned/ok/skipped/failed/failedTargets, 唯独漏了 written ⇒ 外层恒停在 null ⇒ 生产上
//    **每一个** sync_type 的 written 都是 NULL, 而运行记录照旧全绿。2026-08-21 prod 实证:
//    sync:us_equity_bar 连跑两轮 scanned=15 / ok=15 / status=success, written 仍 NULL。
//    既有覆盖为何看不见它 (两处都是**反例不在管道里**):
//      · recorder IT 手工构造 stats 直喂 finish() —— 测的是交接**下游**;
//      · 本 spec 的 emptyStatsLike() 恒 written:null —— 合并前后都 null, 差异无从显形。
//    故两条都要: 直测合并语义 + 端到端断言「executor 报的数进得了 recorder」。
describe('#103 written 跨 stats 交接不得丢失 (063 Phase 3.3 落库侧计数)', () => {
  const statsWith = (written: number | null) => ({
    scanned: 0,
    ok: 0,
    skipped: 0,
    failed: 0,
    written,
    failedTargets: [] as unknown[],
  });

  it('两边都没上报 ⇒ 仍是 null (「一次都没上报」这个态要留住)', () => {
    const into = statsWith(null);
    mergeStats(into, statsWith(null));
    expect(into.written).toBeNull();
  });

  it('子执行上报了 ⇒ 抬成数 (曾经的塌法: 外层永远停在 null)', () => {
    const into = statsWith(null);
    mergeStats(into, statsWith(42));
    expect(into.written).toBe(42);
  });

  it('🚨 子执行上报 0 行 ⇒ 落 0 而非 null —— 「写了 0 行」与「没上报」可分辨, 这是本列存在的全部理由', () => {
    const into = statsWith(null);
    mergeStats(into, statsWith(0));
    expect(into.written).toBe(0);
  });

  it('两边都有数 ⇒ 累加', () => {
    const into = statsWith(3);
    mergeStats(into, statsWith(5));
    expect(into.written).toBe(8);
  });

  it('子执行没上报 ⇒ 不抹掉外层已有的数', () => {
    const into = statsWith(3);
    mergeStats(into, statsWith(null));
    expect(into.written).toBe(3);
  });

  it('🚨 端到端: executor 上报的 written 必须到达 recorder.finish (不关心中间用什么机制搬)', async () => {
    const { deps, registry } = buildFakes();
    registry.registerExecutor(
      'test_dimension' as DimensionKey,
      vi.fn(async () => ({
        stats: { ...emptyStatsLike(), scanned: 15, ok: 15, written: 42 },
        budgetExhausted: false,
      })),
    );
    await registry.execute('test_dimension' as DimensionKey, input);
    expect(deps.recorder.finish).toHaveBeenCalledWith(
      1n,
      'success',
      expect.objectContaining({ written: 42 }),
    );
  });
});

// #138 (承 #103): `written` 的**埋点覆盖面**。#103 修好了交接管道, 但管道两端多数维度压根
// 没往里放东西 —— 2026-08-22 双通道实测 (prod 全维度取证 + 真 registry 探针): 28 个维度里
// **只有** eod_bar / us_equity_bar / us_index_daily 在空转一轮时报得出 0, 其余 25 个恒 NULL。
// 本块钉住其中**族一**那 5 个 —— 生产路径 (delta) 全走逐行 `upsert`, 一次 `addWritten` 都没有。
// (fundamental / financial 的 backfill 路径埋了, delta 路径没埋 —— 夜里跑的恰恰是 delta。)
//
// 🚨 判据是**两条, 缺一不可**:
//   ① 空转一轮 (工作集空 / vendor 零行) ⇒ written = 0 而非 null —— 「跑了、写了 0 行」;
//   ② 有行一轮 ⇒ written = 实际发生写操作的行数。
//   只做 ① 会让 hot_snapshot 每晚报 0 而实际写了 11132 行 —— 那比 NULL **更坏**: 把无害的
//   「没上报」换成一句主动的谎话, 而这一列存在的全部理由就是不说这种谎。
describe('#138 族一: 逐行 upsert 的维度必须上报 written (空转报 0, 有行报行数)', () => {
  const CORP_ACTION = { exDate: '2026-06-01', type: 'dividend', payload: {} };

  function buildFamilyOneFakes(
    opts: {
      marketScope?: string[];
      instruments?: { id: bigint; market: string; code: string }[];
      fundamentals?: unknown[];
      financials?: unknown[];
      corporateActions?: unknown[];
      hotDtos?: HotSnapshotDto[];
      ivSnapshots?: UnderlyingIvSnapshot[];
    } = {},
  ) {
    const instruments = opts.instruments ?? [{ id: 1n, market: 'cn', code: '600519' }];
    const upsert = {
      fundamentalSnapshot: vi.fn(async () => ({})),
      financialMetric: vi.fn(async () => ({})),
      corporateAction: vi.fn(async () => ({})),
      hotSnapshot: vi.fn(async () => ({})),
      underlyingIvDaily: vi.fn(async () => ({})),
    };
    const deps = {
      syncUniverse: { run: vi.fn(async () => emptyStatsLike()) },
      syncProfile: { run: vi.fn(async () => emptyStatsLike()) },
      eodBar: { getBars: vi.fn(async () => []) },
      fundamental: { getFundamentals: vi.fn(async () => opts.fundamentals ?? []) },
      financials: { getFinancials: vi.fn(async () => opts.financials ?? []) },
      corporateAction: {
        getCorporateActions: vi.fn(async () => opts.corporateActions ?? []),
      },
      hotSnapshot: { getHotSnapshot: vi.fn(async () => opts.hotDtos ?? []) },
      underlyingIv: {
        getIvSnapshots: vi.fn(async () => opts.ivSnapshots ?? []),
        getIvHistoryRange: vi.fn(async () => []),
      },
      prisma: {
        syncDimension: {
          findUnique: vi.fn(async () => ({
            dimensionKey: 'any',
            enabled: true,
            cronExpr: '0 0 22 * * *',
            marketScope: opts.marketScope ?? ['cn'],
            adjustTypes: ['none'],
            batchSize: 50,
            historyDepth: 365,
            retryMax: 3,
            misfirePolicy: 'fire-now',
            reAdjustLookbackDays: 30,
            deltaLookbackDays: null,
            pausedUntil: null,
          })),
          update: vi.fn(async () => ({})),
        },
        instrument: { findMany: vi.fn(async () => instruments) },
        // 既有键与本轮 action 同键 ⇒ minNewExDate = null ⇒ 不触发跃变锚定 (本块只验计数)。
        corporateAction: {
          findMany: vi.fn(async () => [{ exDate: new Date('2026-06-01'), type: 'dividend' }]),
        },
        // IVP 双算对表的窗口查询 (空窗 ⇒ verdict skipped ⇒ 静默, 不干扰计数)。
        underlyingIvHistory: { findMany: vi.fn(async () => []) },
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            fundamentalSnapshot: { upsert: upsert.fundamentalSnapshot },
            financialMetric: { upsert: upsert.financialMetric },
            corporateAction: { upsert: upsert.corporateAction },
            hotSnapshot: { upsert: upsert.hotSnapshot },
            underlyingIvDaily: { upsert: upsert.underlyingIvDaily },
          }),
        ),
      },
      recorder: { start: vi.fn(async () => 1n), finish: vi.fn(async () => undefined) },
      tierRecalc: { recalcSafely: vi.fn(async () => null) },
    };
    const u = undefined as never;
    const registry = new DimensionExecutorRegistry(
      deps.syncUniverse as never,
      deps.syncProfile as never,
      deps.eodBar as never,
      deps.fundamental as never,
      deps.financials as never,
      deps.corporateAction as never,
      deps.prisma as never,
      deps.recorder as never,
      deps.tierRecalc as never,
      u,
      u,
      u,
      u,
      u,
      u,
      u, // backfillPacer … volatility
      deps.hotSnapshot as never, // hot_snapshot (第 17 位)
      u,
      u,
      u,
      u,
      u,
      u,
      u,
      u,
      u,
      u, // buyback … anchorGate
      deps.underlyingIv as never, // underlying_iv_daily (第 28 位)
    );
    return { deps, registry, upsert };
  }

  const IV_OPTS = {
    marketScope: ['us'],
    instruments: [{ id: 1n, market: 'us', code: 'PEP' }],
  };

  it('fundamental (delta 逐行 upsert): vendor 零行 ⇒ written = 0', async () => {
    const { registry } = buildFamilyOneFakes();
    const { stats } = await registry.execute('fundamental', input);
    expect(stats.written).toBe(0);
  });

  it('fundamental (delta 逐行 upsert): 落了 2 行 ⇒ written = 2', async () => {
    const { registry, upsert } = buildFamilyOneFakes({
      instruments: [
        { id: 1n, market: 'cn', code: '600519' },
        { id: 2n, market: 'cn', code: '000001' },
      ],
      fundamentals: [
        { symbol: 'cn:600519', date: '2026-06-05' },
        { symbol: 'cn:000001', date: '2026-06-05' },
      ],
    });
    const { stats } = await registry.execute('fundamental', input);
    expect(upsert.fundamentalSnapshot).toHaveBeenCalledTimes(2);
    expect(stats.written).toBe(2);
  });

  it('financial (delta 逐行 upsert): vendor 零行 ⇒ written = 0', async () => {
    const { registry } = buildFamilyOneFakes();
    const { stats } = await registry.execute('financial', input);
    expect(stats.written).toBe(0);
  });

  it('financial (delta 逐行 upsert): 落了 1 行 ⇒ written = 1', async () => {
    const { registry, upsert } = buildFamilyOneFakes({
      financials: [{ symbol: 'cn:600519', reportPeriod: '2026-03-31' }],
    });
    const { stats } = await registry.execute('financial', input);
    expect(upsert.financialMetric).toHaveBeenCalledTimes(1);
    expect(stats.written).toBe(1);
  });

  it('corporate_action (逐行 upsert): vendor 零行 ⇒ written = 0', async () => {
    const { registry } = buildFamilyOneFakes();
    const { stats } = await registry.execute('corporate_action', input);
    expect(stats.written).toBe(0);
  });

  it('corporate_action (逐行 upsert): 落了 1 行 ⇒ written = 1', async () => {
    const { registry, upsert } = buildFamilyOneFakes({ corporateActions: [CORP_ACTION] });
    const { stats } = await registry.execute('corporate_action', input);
    expect(upsert.corporateAction).toHaveBeenCalledTimes(1);
    expect(stats.written).toBe(1);
  });

  it('hot_snapshot (逐行 upsert × HOT_TYPES): vendor 零行 ⇒ written = 0', async () => {
    const { registry } = buildFamilyOneFakes();
    const { stats } = await registry.execute('hot_snapshot', input);
    expect(stats.written).toBe(0);
  });

  it('🚨 hot_snapshot: 每 type 各落 1 行 ⇒ written = HOT_TYPES 长度 (只做「空转报 0」会让它恒报 0 = 谎话)', async () => {
    const { registry, upsert } = buildFamilyOneFakes({
      hotDtos: [{ hotType: 'x', dataDate: '2026-06-04', payload: { a: 1 } }],
    });
    const { stats } = await registry.execute('hot_snapshot', input);
    expect(upsert.hotSnapshot).toHaveBeenCalledTimes(HOT_TYPES.length);
    expect(stats.written).toBe(HOT_TYPES.length);
  });

  it('underlying_iv_daily (delta 逐行 upsert): vendor 零快照 ⇒ written = 0', async () => {
    const { registry } = buildFamilyOneFakes(IV_OPTS);
    const { stats } = await registry.execute('underlying_iv_daily', input);
    expect(stats.written).toBe(0);
  });

  it('underlying_iv_daily (delta 逐行 upsert): 落了 1 行 ⇒ written = 1 (= matched, 非请求批大小)', async () => {
    const { registry, upsert } = buildFamilyOneFakes({
      ...IV_OPTS,
      ivSnapshots: [{ symbol: 'us:PEP', iv: '24.8' } as UnderlyingIvSnapshot],
    });
    const { stats } = await registry.execute('underlying_iv_daily', input);
    expect(upsert.underlyingIvDaily).toHaveBeenCalledTimes(1);
    expect(stats.written).toBe(1);
  });

  it('🚨 工作集为空 (无锚不采) 也要报 0 —— 「跑了、一行没写」正是本列要抓的那个形态', async () => {
    const { registry } = buildFamilyOneFakes({ ...IV_OPTS, instruments: [] });
    const { stats } = await registry.execute('underlying_iv_daily', input);
    expect(stats.written).toBe(0);
  });
});
