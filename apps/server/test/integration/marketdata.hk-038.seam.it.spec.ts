import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { Logger } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import {
  toLixinger,
  groupByMarket,
  UnsupportedLixingerMarketError,
} from '../../src/marketdata/lixinger-symbol.rules';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
  MarketdataSyncWorker,
} from '../../src/marketdata/marketdata-sync.worker';
import { executeBackfill, type BackfillDeps } from '../../src/marketdata/marketdata-backfill.cli';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  optionCoverageThreshold: 1,
};

// 038 T006 Phase 1「平台市场缝隙激活」集成 IT (Testcontainers PG+Redis, mock adapters):
// 验 T001-T005 落地的 4 个 seam 通了 + A 股逐字节无回归。**不测真实 hk 数据端到端摄取**
// (那是 Phase 2 T012); 本组只验平台口径 —— seed cn+hk `Instrument` 行经真 PG 走 executor,
// 按维度 `marketScope` (seam#2) / backfill `--markets` (seam#3) 定工作集口径。
//
// 层次划分 (避免与 T002 vitest 重叠): adapter `/hk/` vs `/cn/` 路径字符串断言已在 T002
// vitest 用真 adapter + stubbed HTTP client 覆盖 (mock provider 会替掉整个 adapter, 够不到
// 路径) → 本 IT 不重断路径串; 未知前缀抛错走纯函数层 (最贴该分支的路由守卫)。
//
// 覆盖 spec state_branches (6 条): 市场路由 cn 无回归 / hk 路由 / 未知市场前缀 /
// marketScope 过滤 cn-only / marketScope 过滤含 hk / 回填 --markets 透传。
describe('038 T006 Phase 1 平台市场缝隙 seam (Testcontainers PG+Redis, mock adapters)', () => {
  let prisma: PrismaService;
  let lifecycle: QueueRedisLifecycle;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.DATABASE_URL = stores.databaseUrl;
    prisma = new PrismaService(stores.databaseUrl);
    await prisma.$connect();
    lifecycle = new QueueRedisLifecycle(stores.redisUrl);
  }, 180_000);

  afterAll(async () => {
    lifecycle?.onApplicationShutdown();
    await prisma?.$disconnect();
    await stores.drop();
  });

  beforeEach(async () => {
    await prisma.dailyBar.deleteMany();
    await prisma.fundamentalSnapshot.deleteMany();
    await prisma.financialMetric.deleteMany();
    await prisma.corporateAction.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T003 migration 已把 6 维扩到 {cn,hk} — 每例回到已知基线, 各例再按需覆盖 marketScope。
    await prisma.syncDimension.updateMany({
      data: { marketScope: ['cn', 'hk'], lastWatermark: null, enabled: true },
    });
    const q = new MarketdataSyncQueue(lifecycle.client, CFG);
    await q.queue.obliterate({ force: true });
    await q.queue.close();
  });

  function buildRegistry(): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  function buildDeps(queue: MarketdataSyncQueue, events: QueueEvents): BackfillDeps {
    return {
      prisma,
      syncQueue: queue,
      queueEvents: events,
      cliWaitTimeoutMs: 60_000,
      backfillDefaultHistoryDays: 365,
    };
  }

  /** seed 一只活跃标的 (currency 按 market: cn→CNY / hk→HKD, T004 口径)。 */
  async function seedInstrument(market: string, code: string, name = 't'): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: {
        market,
        code,
        name,
        type: 'stock',
        currency: market === 'hk' ? 'HKD' : 'CNY',
        status: 'active',
      },
    });
    return inst.id;
  }

  /** 覆写某维度 marketScope (seam#2 工作集市场范围)。 */
  async function setMarketScope(dimensionKey: string, scope: string[]): Promise<void> {
    await prisma.syncDimension.update({
      where: { dimensionKey },
      data: { marketScope: scope, lastWatermark: null },
    });
  }

  // ── ① 市场路由 cn 无回归 ──────────────────────────────────────────────
  it('① 市场路由 cn 无回归: marketScope={cn} → cn 标的照旧同步 (工作集含 cn + DailyBar 落库)', async () => {
    await seedInstrument('cn', '600519', '贵州茅台'); // mock 有 K 线 fixture
    await seedInstrument('cn', '000001', '平安银行'); // mock 无 fixture (no-data, 零落库)
    await setMarketScope('eod_bar', ['cn']);

    const registry = buildRegistry();
    const { stats } = await registry.execute(
      'eod_bar',
      { mode: 'delta', asOf: AS_OF, now: NOW },
      'job-cn-noreg',
    );

    // 工作集含两只 cn (016 语义逐字节无回归); no-data 标的不算失败。
    expect(stats.scanned).toBe(2);
    expect(stats.failed).toBe(0);
    // cn:600519 mock 1 bar → 落库; cn:000001 no-data → 零落库 (append-only 语义不变)。
    expect(await prisma.dailyBar.count()).toBe(1);
    const run = await prisma.syncRun.findFirst({ where: { syncType: 'sync:eod_bar' } });
    expect(run?.status).toBe('success');
    expect(run?.bullJobId).toBe('job-cn-noreg');
  });

  // ── ② hk 路由 (marketScope 含 hk → hk 进工作集, 不错配) ────────────────
  it('② hk 路由: marketScope 含 hk → hk 标的进得了工作集 + 不错配 (与 cn 同框, 零异常)', async () => {
    await seedInstrument('cn', '600519', '贵州茅台');
    await seedInstrument('hk', '00700', '腾讯控股'); // Phase 1 mock 无 hk 数据 = no-data (非错配)
    await setMarketScope('eod_bar', ['cn', 'hk']);

    const registry = buildRegistry();
    const { stats } = await registry.execute('eod_bar', { mode: 'delta', asOf: AS_OF, now: NOW });

    // 仅 1 只 cn + 1 只 hk → scanned=2 证明 hk 确实进了工作集 (未被市场缝隙静默丢弃)。
    expect(stats.scanned).toBe(2);
    // hk 走 mock 返 [] 视作 no-data 而非异常 → 路由未错配到破坏路径。
    expect(stats.failed).toBe(0);
    // 真实 hk 摄取属 Phase 2 (T012) → 本 IT 仅证 hk 进工作集, 不断 hk 落库。
    expect(await prisma.dailyBar.count()).toBe(1); // 仅 cn:600519 有 fixture
  });

  // ── ③ 未知市场前缀 → 明确抛错 (纯函数路由守卫层, seam#1 边界) ──────────
  it('③ 未知市场前缀 → UnsupportedLixingerMarketError (不静默错配 vendor symbol)', () => {
    // 单符号归一化。
    expect(() => toLixinger('us:AAPL')).toThrow(UnsupportedLixingerMarketError);
    // 批量分组 (fundamental/fs 按 market 路由前先分组) 同样拒未知前缀 — 一颗坏符号即抛。
    expect(() => groupByMarket(['cn:600519', 'us:AAPL'])).toThrow(UnsupportedLixingerMarketError);
    // 合法 cn/hk 前缀不抛 (对照, 证明是「未知前缀」而非「全抛」)。
    expect(toLixinger('cn:600519')).toEqual({ market: 'cn', stockCode: '600519' });
    expect(toLixinger('hk:00700')).toEqual({ market: 'hk', stockCode: '00700' });
  });

  // ── ④ marketScope 过滤 cn-only (hk 排除) ──────────────────────────────
  it('④ marketScope 过滤 cn-only: 维度 marketScope={cn} → 工作集只含 cn (hk 被过滤)', async () => {
    await seedInstrument('cn', '600519', '贵州茅台');
    await seedInstrument('cn', '000001', '平安银行');
    await seedInstrument('hk', '00700', '腾讯控股');
    await setMarketScope('eod_bar', ['cn']);

    const registry = buildRegistry();
    const { stats } = await registry.execute('eod_bar', { mode: 'delta', asOf: AS_OF, now: NOW });

    // 3 只在库 (2 cn + 1 hk), marketScope={cn} → 仅 2 只 cn 进工作集; hk 被 where market in 过滤。
    expect(stats.scanned).toBe(2);
  });

  // ── ⑤ marketScope 过滤含 hk (cn+hk 全纳入) ────────────────────────────
  it('⑤ marketScope 过滤含 hk: 维度 marketScope={cn,hk} → 工作集含 cn+hk 全部', async () => {
    await seedInstrument('cn', '600519', '贵州茅台');
    await seedInstrument('cn', '000001', '平安银行');
    await seedInstrument('hk', '00700', '腾讯控股');
    await setMarketScope('eod_bar', ['cn', 'hk']);

    const registry = buildRegistry();
    const { stats } = await registry.execute('eod_bar', { mode: 'delta', asOf: AS_OF, now: NOW });

    // marketScope={cn,hk} → cn×2 + hk×1 全部进工作集。
    expect(stats.scanned).toBe(3);
  });

  // ── ⑥ 回填 --markets hk 透传 (payload → worker → executor 工作集 + 估算) ─
  it('⑥ 回填 --markets hk 透传: 估算按 hk + payload/executor 工作集经真 queue 缩到 hk', async () => {
    // 非对称种子 (2 cn + 1 hk) → hk 过滤后的估算/工作集与 cn 可区分。
    await seedInstrument('cn', '600519', '贵州茅台');
    await seedInstrument('cn', '000001', '平安银行');
    await seedInstrument('hk', '00700', '腾讯控股');
    await setMarketScope('eod_bar', ['cn', 'hk']); // 允许 hk 进; --markets hk 再交集缩到 hk

    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    /** 跑一次 dry-run, 解析打印的 backfill plan JSON (估算 = active where market in markets)。 */
    async function dryRunPlan(
      markets: string[],
    ): Promise<{ markets: string[]; estVendorRequests: number }> {
      logSpy.mockClear();
      const code = await executeBackfill(
        buildDeps(queue, events),
        { dryRun: true, dimension: 'eod_bar', markets },
        NOW,
      );
      expect(code).toBe(0);
      const call = logSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('estVendorRequests'),
      );
      if (!call || typeof call[0] !== 'string')
        throw new Error('backfill plan 未打印 estVendorRequests');
      return JSON.parse(call[0].replace('backfill plan: ', ''));
    }

    try {
      // (a) 估算按 markets 透传: hk (1 只活跃) vs cn (2 只活跃) 估算随 --markets 变化。
      const hkPlan = await dryRunPlan(['hk']);
      expect(hkPlan.markets).toEqual(['hk']);
      // 🚨 本例传了 `dimension: 'eod_bar'` ⇒ 估算**只算该维度**, 不是全管线求和
      //   (2026-08-01 修: 旧实现忽略 --dimension, 这里曾期望全管线的 20)。
      //   hk active=1 × eod_bar 复权口径数({none}=1) = 1。
      expect(hkPlan.estVendorRequests).toBe(1);
      const cnPlan = await dryRunPlan(['cn']);
      expect(cnPlan.markets).toEqual(['cn']);
      // cn active=2 × eod_bar 复权口径数 = 2 (与 hk 的 1 不同 = 证明 --markets 透传生效)。
      expect(cnPlan.estVendorRequests).toBe(2);
    } finally {
      logSpy.mockRestore();
    }

    // (b) 非 dry-run: payload markets → worker → ExecutorInput.markets → 工作集与 marketScope 交集。
    await prisma.syncRun.deleteMany();
    const worker = new MarketdataSyncWorker(lifecycle.client, buildRegistry(), queue, CFG);
    worker.onModuleInit();
    try {
      const code = await executeBackfill(
        buildDeps(queue, events),
        { dryRun: false, dimension: 'eod_bar', historyDepth: 30, markets: ['hk'] },
        NOW,
      );
      expect(code).toBe(0);
      // 工作集经真 queue/executor 缩到 hk: 仅 hk:00700 被扫描 (2 只 cn 被 --markets hk 过滤)。
      const run = await prisma.syncRun.findFirst({ where: { syncType: 'sync:eod_bar' } });
      expect(run?.scanned).toBe(1);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });
});
