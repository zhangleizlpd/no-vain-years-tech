import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { coldStartUnused } from '../_support/cold-start-stub';
import { QueueEvents } from 'bullmq';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DIMENSION_KEYS, DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
} from '../../src/marketdata/marketdata-sync.queue';
import { MarketdataSyncWorker } from '../../src/marketdata/marketdata-sync.worker';
import { SyncTickDriver } from '../../src/marketdata/sync-tick-driver';
import { CalendarHitCheck } from '../../src/marketdata/calendar-hit-check';
import type { TradingCalendarPort } from '../../src/marketdata/trading-calendar.port';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 20:00 Asia/Shanghai (交易日)
const PAST = new Date(NOW.getTime() - 60_000);

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  futuLaneEnabled: false, // 灰度默认关 ⇒ 全部 job 落 default lane (拆 lane 前的行为)。
  optionCoverageThreshold: 1,
};

const calendarOpen: TradingCalendarPort = {
  classify: async () => 'trading',
  lastClosedSession: async () => null,
  previousTradingDay: async () => null,
};

// 017 T016 编排端到端 IT (SC-S04/S05/S07, Testcontainers PG+Redis, mock adapters):
// tick → D3 flow → worker 消费全链路。周一全 flow 顺序 / 周二 universe 缺席当根照跑
// (最高风险专项) / hard-soft 边失败传播 / 宕机 catch-up / Redis 自愈。
describe('017 T016 flow orchestration end-to-end (tick → flow → worker)', () => {
  let prisma: PrismaService;
  let lifecycle: QueueRedisLifecycle;
  let queue: MarketdataSyncQueue;
  let driver: SyncTickDriver;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.DATABASE_URL = stores.databaseUrl;
    prisma = new PrismaService(stores.databaseUrl);
    await prisma.$connect();
    lifecycle = new QueueRedisLifecycle(stores.redisUrl);
    queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    driver = new SyncTickDriver(
      prisma,
      queue,
      calendarOpen,
      CFG,
      new CalendarHitCheck(),
      new SyncRunRecorder(prisma),
    );
  }, 180_000);

  afterAll(async () => {
    await queue?.onModuleDestroy();
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
    await prisma.syncDimension.updateMany({
      data: {
        enabled: true,
        nextFireAt: null,
        misfirePolicy: 'fire-now',
        cronExpr: '0 0 22 * * *',
        retryMax: 3,
      },
    });
    await queue.queue.obliterate({ force: true });
  });

  /** mock 全端口 registry; universe/profile use case 可 override (失败注入)。 */
  function buildRegistry(overrides?: {
    universe?: SyncUniverseUseCase;
    profile?: SyncProfileUseCase;
  }): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      overrides?.universe ?? new SyncUniverseUseCase(mock, prisma),
      overrides?.profile ?? new SyncProfileUseCase(mock, prisma),
      mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  /** 起 worker + events, 执行场景回调, finally 全关 (蓝本 dimension-worker IT)。 */
  async function withWorker(
    registry: DimensionExecutorRegistry,
    run: (events: QueueEvents, worker: MarketdataSyncWorker) => Promise<void>,
  ): Promise<void> {
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      registry,
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      await run(events, worker);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
    }
  }

  /** tick 后队列里的 flow 节点 (root waiting-children + 其余 waiting), id→name 索引。 */
  async function snapshotTree(): Promise<{
    byId: Map<string, string>;
    rootByName: Map<string, import('bullmq').Job>;
  }> {
    const jobs = await queue.queue.getJobs(['waiting', 'waiting-children']);
    return {
      byId: new Map(jobs.map((j) => [j.id ?? '', j.name])),
      rootByName: new Map(jobs.map((j) => [j.name, j])),
    };
  }

  it('① 周一全 flow (SC-S04): 全维度共同 due → 链序执行, index_membership 收尾为 root', async () => {
    await prisma.syncDimension.updateMany({ data: { nextFireAt: PAST } });
    const result = await driver.tick(NOW);
    // 全维度 nextFireAt 都拨到过去 ⇒ 全 due。从 DIMENSION_KEYS 派生, 加维度不再假红。
    expect(result.fired).toHaveLength(DIMENSION_KEYS.length);

    const { byId, rootByName } = await snapshotTree();
    const completed: string[] = [];
    await withWorker(buildRegistry(), async (events) => {
      events.on('completed', ({ jobId }) => completed.push(byId.get(jobId) ?? jobId));
      // 039 派生序: 5 港股维度 priority 4-0 均低于核心 6 维 → index_membership (priority 0) 收尾为 root。
      const root = rootByName.get('sync:index_membership');
      expect(root).toBeDefined();
      await root?.waitUntilFinished(events, 60_000);
    });

    // 嵌套链全序 (019 T011 派生序 corp 提至 eod 前 + 039/040/041/042/043 港股维度 priority desc 再 key 字典序尾部追加)。
    // 040: volatility(priority 4, 与 short_selling 撞值 → key 'short_selling' < 'volatility' 后置) /
    //      hot_snapshot(priority 3, 与 connect_holding 撞值 → 'connect_holding' < 'hot_snapshot' 后置)。
    // 041: buyback(priority 4, key 'buyback' < 'short_selling' 前置) / equity_change(priority 3,
    //      'connect_holding' < 'equity_change' < 'hot_snapshot') / shareholder_change(priority 2,
    //      'fund_holding' < 'shareholder_change') / allotment(priority 1, 'allotment' < 'fund_company_holding' 前置)。
    // 042: revenue_segment(priority 4, 'buyback' < 'revenue_segment' < 'short_selling') /
    //      shareholder_snapshot(priority 3, 'hot_snapshot' < 'shareholder_snapshot') /
    //      employee(priority 2, 'employee' < 'fund_holding' 前置)。
    // 043: industry_classification(priority 2, 'fund_holding' < 'industry_classification' < 'shareholder_change') /
    //      announcement(priority 1, 'allotment' < 'announcement' < 'fund_company_holding')。
    expect(completed).toEqual([
      'sync:universe',
      'sync:profile',
      'sync:fundamental',
      'sync:financial',
      'sync:corporate_action',
      'sync:eod_bar',
      'sync:hk_option_contract', // 066 T04
      'sync:hk_option_daily_snapshot', // 066 T04
      'sync:hk_option_oi_settle', // 073 T006
      'sync:hk_underlying_iv_daily', // 066 T04
      'sync:option_contract', // 047 (priority 5, 'eod_bar' < 'option_contract')
      'sync:option_daily_snapshot', // 047 (priority 5; hard 边要求紧邻上游 option_contract, 由 key 字典序天然满足)
      'sync:underlying_iv_daily', // 046 (priority 5, 'option_daily_snapshot' < 'underlying_iv_daily' < 'us_equity_bar')
      'sync:us_equity_bar', // sellput-viz (priority 5, key 平局后置于 eod_bar)
      'sync:us_index_daily', // 046 (priority 5, 'us_equity_bar' < 'us_index_daily'; 无入边故 Kahn 里一直在 ready 集, 由 priority 定位)
      'sync:buyback', // 041 (priority 4, key 'buyback' < 'revenue_segment' < 'short_selling' 前置)
      'sync:earnings_event', // 047 (priority 4 —— 取 5 会插进 corporate_action→eod_bar 那条 hard 边中间)
      'sync:revenue_segment', // 042 (priority 4, 'earnings_event' < 'revenue_segment' < 'short_selling')
      'sync:short_selling',
      'sync:volatility', // 040 (priority 4, 撞 short_selling → key 后置)
      'sync:connect_holding',
      'sync:equity_change', // 041 (priority 3, 'connect_holding' < 'equity_change' < 'hot_snapshot')
      'sync:hot_snapshot', // 040 (priority 3, 撞 connect_holding → key 后置)
      'sync:shareholder_snapshot', // 042 (priority 3, 'hot_snapshot' < 'shareholder_snapshot')
      'sync:employee', // 042 (priority 2, 'employee' < 'fund_holding' 前置)
      'sync:fund_holding',
      'sync:industry_classification', // 043 (priority 2, 'fund_holding' < 'industry_classification' < 'shareholder_change')
      'sync:shareholder_change', // 041 (priority 2, 'fund_holding' < 'shareholder_change')
      'sync:allotment', // 041 (priority 1, 'allotment' < 'fund_company_holding' 前置)
      'sync:announcement', // 043 (priority 1, 'allotment' < 'announcement' < 'fund_company_holding')
      'sync:fund_company_holding',
      'sync:index_membership',
    ]);
    // 全链落库: universe 3 标的 + 600519 none 1 行 (020 T008 单口径) + per-dim SyncRun 全 success。
    // (5+2 港股维度 marketScope=hk 且本 IT 未 seed hk 标的 → 工作集空, executor 空跑 success 落审计行、零业务行。)
    expect(await prisma.instrument.count()).toBe(3);
    expect(await prisma.dailyBar.count()).toBe(1);
    const runs = await prisma.syncRun.findMany();
    expect(runs).toHaveLength(DIMENSION_KEYS.length); // per-dim 各 1 行
    expect(runs.every((r) => r.status === 'success')).toBe(true);
  }, 60_000);

  it('② 周二 universe 缺席 (SC-S05 最高风险): universe 不 due → 下游当根照跑', async () => {
    // universe 留 NULL (不 due, 只懒初始化); 其余 5 维度 due。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { not: 'universe' } },
      data: { nextFireAt: PAST },
    });
    const result = await driver.tick(NOW);
    expect(result.fired.sort()).toEqual([
      'allotment', // 041
      'announcement', // 043 ('allotment' < 'announcement' < 'buyback')
      'buyback', // 041
      'connect_holding', // 039
      'corporate_action',
      'earnings_event', // 047 ('corporate_action' < 'earnings_event' < 'employee')
      'employee', // 042 ('employee' < 'eod_bar': 'm' < 'o')
      'eod_bar',
      'equity_change', // 041
      'financial',
      'fund_company_holding', // 039
      'fund_holding', // 039
      'fundamental',
      'hk_option_contract', // 066 T04
      'hk_option_daily_snapshot', // 066 T04
      'hk_option_oi_settle', // 073 T006
      'hk_underlying_iv_daily', // 066 T04
      'hot_snapshot', // 040
      'index_membership', // 039
      'industry_classification', // 043 ('index_membership' < 'industry_classification' < 'profile')
      'option_contract', // 047 ('industry_classification' < 'option_contract' < 'profile')
      'option_daily_snapshot', // 047
      'profile',
      'revenue_segment', // 042
      'shareholder_change', // 041
      'shareholder_snapshot', // 042
      'short_selling', // 039
      'underlying_iv_daily', // 046 ('short_selling' < 'underlying_iv_daily' < 'us_equity_bar')
      'us_equity_bar', // sellput-viz
      'us_index_daily', // 046 ('us_equity_bar' < 'us_index_daily' < 'volatility')
      'volatility', // 040
    ]);

    const { rootByName } = await snapshotTree();
    await withWorker(buildRegistry(), async (events) => {
      // 039 派生序: won 集不含 universe → index_membership (priority 0) 收尾为 root。
      await rootByName.get('sync:index_membership')?.waitUntilFinished(events, 60_000);
    });

    // universe 边自动失效: 零 universe SyncRun, 链从 profile 起全部照跑 (含 039 5 港股维度)。
    expect(await prisma.syncRun.count({ where: { syncType: 'sync:universe' } })).toBe(0);
    const runs = await prisma.syncRun.findMany();
    expect(runs).toHaveLength(DIMENSION_KEYS.length - 1); // universe 外全维度照跑
    expect(runs.every((r) => r.status === 'success')).toBe(true);
  }, 60_000);

  it('③ hard 边: profile 失败 → fundamental 不跑 (failParent), financial/corp 照跑 (FR-S09)', async () => {
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['profile', 'fundamental', 'financial', 'corporate_action'] } },
      data: { nextFireAt: PAST },
    });
    await prisma.syncDimension.update({
      where: { dimensionKey: 'profile' },
      data: { retryMax: 1 }, // 单 attempt 快速到终态。
    });
    const mock = new MockMarketDataAdapter();
    const failingProfile = new SyncProfileUseCase(mock, prisma);
    vi.spyOn(failingProfile, 'run').mockRejectedValue(new Error('profile vendor down'));

    await driver.tick(NOW);
    const { rootByName } = await snapshotTree();
    await withWorker(buildRegistry({ profile: failingProfile }), async (events) => {
      await rootByName.get('sync:corporate_action')?.waitUntilFinished(events, 60_000);
    });

    // hard: fundamental 连 executor 都未进 (零 SyncRun 行, failParentOnFailure 生效)。
    expect(await prisma.syncRun.count({ where: { syncType: 'sync:fundamental' } })).toBe(0);
    // 无真实边 sibling 不连坐: financial / corporate_action 照跑 success。
    for (const t of ['sync:financial', 'sync:corporate_action']) {
      const run = await prisma.syncRun.findFirst({ where: { syncType: t } });
      expect(run?.status).toBe('success');
    }
  }, 60_000);

  it('④ soft 边: universe 失败 → 全下游照跑 (ignoreDependencyOnFailure, FR-S09)', async () => {
    await prisma.syncDimension.updateMany({ data: { nextFireAt: PAST } });
    await prisma.syncDimension.update({
      where: { dimensionKey: 'universe' },
      data: { retryMax: 1 },
    });
    const mock = new MockMarketDataAdapter();
    const failingUniverse = new SyncUniverseUseCase(mock, prisma);
    vi.spyOn(failingUniverse, 'run').mockRejectedValue(new Error('universe vendor down'));

    await driver.tick(NOW);
    const { rootByName } = await snapshotTree();
    await withWorker(buildRegistry({ universe: failingUniverse }), async (events) => {
      // 039 派生序: index_membership (priority 0) 收尾为 root; 等 root = 整链终态 (否则等 eod_bar
      // 时下游 5 港股维度尚未跑完 → 竞态漏计)。
      await rootByName.get('sync:index_membership')?.waitUntilFinished(events, 60_000);
    });

    const uniRun = await prisma.syncRun.findFirst({ where: { syncType: 'sync:universe' } });
    expect(uniRun?.status).toBe('failed');
    // soft: universe 外的全部下游维度照跑 success (失败不传播)。
    // 046 us_index_daily 无 universe 入边 ⇒ 本就不受 universe 失败影响 (FR-027), 与 soft 边免疫是两条独立理由。
    const rest = await prisma.syncRun.findMany({ where: { syncType: { not: 'sync:universe' } } });
    expect(rest).toHaveLength(DIMENSION_KEYS.length - 1);
    expect(rest.every((r) => r.status === 'success')).toBe(true);
  }, 60_000);

  it('⑤ 宕机重启 catch-up e2e: nextFireAt 过期 + 首 tick → 恰好补跑一次到落库', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: new Date(NOW.getTime() - 3 * 86_400_000) },
    });
    const result = await driver.tick(NOW);
    expect(result.fired).toEqual(['eod_bar']);

    const { rootByName } = await snapshotTree();
    await withWorker(buildRegistry(), async (events) => {
      await rootByName.get('sync:eod_bar')?.waitUntilFinished(events, 60_000);
    });
    // 恰好一次 catch-up 消费完成 (空工作集 success 也落 SyncRun 审计行)。
    expect(await prisma.syncRun.count({ where: { syncType: 'sync:eod_bar' } })).toBe(1);
    // 再 tick: 已推进未来 → 零新 job (不逐天补)。
    const again = await driver.tick(NOW);
    expect(again.fired).toEqual([]);
  }, 60_000);

  it('⑥ Redis 自愈 (SC-S07): 队列整体丢失 → 下一 due 周期 tick 重新入队', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: PAST },
    });
    await driver.tick(NOW);
    expect(await queue.queue.getJobCounts().then((c) => c.waiting)).toBe(1);

    // Redis 灾难: 队列内容整体蒸发 (PG 真相层不受影响)。
    await queue.queue.obliterate({ force: true });
    expect(await queue.queue.getJobCounts().then((c) => c.waiting)).toBe(0);

    // 下一 due 周期 (控时模拟: 直接置过期) → tick 凭 PG 真相重新入队。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: PAST },
    });
    const result = await driver.tick(NOW);
    expect(result.fired).toEqual(['eod_bar']);
    expect(await queue.queue.getJobCounts().then((c) => c.waiting)).toBe(1);
  });

  // (旧 ⑦「灰度并存双拉」用例随 PR-7 清退旧 22:00 聚合管线删除 — 双轨期已结束,
  // 同维度重复消费幂等由本文件 ①/⑤ + dimension-executor IT 覆盖。)
});
