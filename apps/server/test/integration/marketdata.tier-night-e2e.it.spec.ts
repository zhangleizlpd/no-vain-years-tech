import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import type {
  CorporateActionDto,
  EodBarPoint,
  EodBarQuery,
  FinancialMetricDto,
  FundamentalSnapshotDto,
  UniverseEntry,
} from '../../src/marketdata/marketdata.types';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 20:00 Asia/Shanghai (交易日)
const AS_OF = '2026-06-03';
const PAST = new Date(NOW.getTime() - 60_000);

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  optionCoverageThreshold: 1,
};

const calendarOpen: TradingCalendarPort = {
  classify: async () => 'trading',
  lastClosedSession: async () => null,
};

const CODES = ['000001', '000002', '000003', '000004', '000005'];
const T0_CODES = ['000004', '000005']; // 自选并集 (高 id → 与 id 序可分辨)

/**
 * 一夜模拟全维度 adapter: universe 5 标的、各 fact 口对任意 symbol 返数据并记录
 * per-instrument 消费序 (D6 探针)。corporate actions 返空 — 避免触发复权重取的额外
 * getBars 调用污染 eod 调用序记录 (空结果照常计 ok, 不影响「全维度落库」断言面)。
 */
class TierNightAdapter extends MockMarketDataAdapter {
  readonly eodCalls: string[] = [];
  readonly fundamentalCalls: string[] = [];
  readonly financialCalls: string[] = [];
  readonly corporateCalls: string[] = [];

  override async enumerate(): Promise<UniverseEntry[]> {
    return CODES.map((code) => ({ market: 'cn', code, name: `股${code}` }));
  }

  override async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
    this.eodCalls.push(query.symbol);
    return [
      {
        tradeDate: AS_OF,
        adjust: query.adjust,
        open: '1',
        high: '1',
        low: '1',
        close: '1',
        changePct: null,
        prevClose: null,
        volume: null,
        amount: null,
        turnoverRate: null,
      },
    ];
  }

  override async getFundamentals(symbols: string[]): Promise<FundamentalSnapshotDto[]> {
    this.fundamentalCalls.push(...symbols);
    return symbols.map((symbol) => ({
      symbol,
      date: AS_OF,
      peTtm: '10.0000',
      peStatic: null,
      peDynamic: null,
      pb: '1.5000',
      ps: null,
      dividendYield: null,
      marketCap: null,
      circMarketCap: null,
      pePctlY3: null,
      pePctlY5: null,
      pbPctlY3: null,
      pbPctlY5: null,
    }));
  }

  override async getFinancials(symbols: string[]): Promise<FinancialMetricDto[]> {
    this.financialCalls.push(...symbols);
    return symbols.map((symbol) => ({
      symbol,
      reportPeriod: '2026Q1',
      roe: '0.1000',
      grossMargin: null,
      eps: null,
      bps: null,
    }));
  }

  override async getCorporateActions(symbol: string): Promise<CorporateActionDto[]> {
    this.corporateCalls.push(symbol);
    return [];
  }
}

/** 调用序去重保留首现序 (Set 插入序) — 折叠 per-adjust 多次调用。 */
const firstSeen = (calls: string[]): string[] => [...new Set(calls)];

const T0_FIRST_ORDER = ['cn:000004', 'cn:000005', 'cn:000001', 'cn:000002', 'cn:000003'];

// 018 T007 端到端一夜模拟 (SC-S06, Testcontainers PG+Redis 控时, 蓝本 flow-orchestration):
// seed watchlist → tick due 入队 flow (universe/profile/fundamental/financial/corp; 重算
// executor 前置自动发生) → fact 维度 tier 序消费 → eod 预算窗截断 (tick payload 不带
// maxEodInstruments — 预算注入是 CLI 入队形态, worker ④ 同款) → 顺延 delayed re-enqueue
// → promote 续跑补齐 T2 → 断言 T0 全保鲜 (全维度落库)、per-dim SyncRun 如实、tier 终态正确。
describe('018 T007 tier night e2e (tick flow → tier-ordered consume → budget defer → resume)', () => {
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
    await prisma.watchlistItem.deleteMany();
    await prisma.group.deleteMany();
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

  function buildRegistry(adapter: TierNightAdapter): DimensionExecutorRegistry {
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(adapter, prisma),
      new SyncProfileUseCase(adapter, prisma),
      adapter,
      adapter,
      adapter,
      adapter,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  /** 起 worker + events, 执行场景回调, finally 全关 (蓝本 dimension-worker IT)。 */
  async function withWorker(
    registry: DimensionExecutorRegistry,
    run: (events: QueueEvents) => Promise<void>,
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
      await run(events);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
    }
  }

  it('一夜全链路: 重算前置 → tier 序消费 → 预算截断 T0 保底 → 顺延续跑补齐 T2', async () => {
    // ── 夜前: 用户自选 (000004/000005) — T0 信号源在同步开跑前就位 ──
    const group = await prisma.group.create({
      data: { accountId: 1001n, name: '自选', type: 'custom', order: 0 },
    });
    await prisma.watchlistItem.createMany({
      data: T0_CODES.map((code, i) => ({ groupId: group.id, market: 'cn', code, order: i })),
    });

    // ── 22:00 tick: eod_bar 之外维度 due → flow 入队 (eod 走后续预算窗, tick payload 无预算注入) ──
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { not: 'eod_bar' } },
      data: { nextFireAt: PAST },
    });
    const adapter = new TierNightAdapter();
    const registry = buildRegistry(adapter);
    const tickResult = await driver.tick(NOW);
    expect(tickResult.fired.sort()).toEqual([
      'allotment', // 041
      'announcement', // 043 ('allotment' < 'announcement' < 'buyback')
      'buyback', // 041
      'connect_holding', // 039
      'corporate_action',
      'earnings_event', // 047 ('corporate_action' < 'earnings_event' < 'employee')
      'employee', // 042
      'equity_change', // 041
      'financial',
      'fund_company_holding', // 039
      'fund_holding', // 039
      'fundamental',
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
      'underlying_iv_daily', // 046 ('short_selling' < 'underlying_iv_daily' < 'universe': 'und' < 'uni')
      'universe',
      'us_equity_bar', // sellput-viz
      'us_index_daily', // 046 ('us_equity_bar' < 'us_index_daily' < 'volatility')
      'volatility', // 040
    ]);

    await withWorker(registry, async (events) => {
      const jobs = await queue.queue.getJobs(['waiting', 'waiting-children']);
      // 039 派生序: eod_bar 外 fired 集 root = index_membership (priority 0 收尾)。
      const root = jobs.find((j) => j.name === 'sync:index_membership');
      expect(root).toBeDefined();
      await root?.waitUntilFinished(events, 60_000);

      // 重算 executor 前置自动发生: universe 落 5 标的后, 首个 fact 维度起手即升 T0。
      const t0 = await prisma.instrument.findMany({
        where: { syncTier: 0 },
        select: { code: true },
      });
      expect(new Set(t0.map((i) => i.code))).toEqual(new Set(T0_CODES));

      // fact 维度全部 tier 序消费 (FR-S03): T0 整体先于任何 T2, 同 tier 内 id 稳定序。
      expect(firstSeen(adapter.fundamentalCalls)).toEqual(T0_FIRST_ORDER);
      expect(firstSeen(adapter.financialCalls)).toEqual(T0_FIRST_ORDER);
      expect(firstSeen(adapter.corporateCalls)).toEqual(T0_FIRST_ORDER);

      // ── eod 预算窗 1: 预算 3 (> T0 数 2) → T0 保底 + 截断顺延 delayed re-enqueue ──
      const eodJob = await queue.enqueueDimensionJob(
        {
          dimensionKey: 'eod_bar',
          mode: 'delta',
          asOf: AS_OF,
          maxEodInstruments: 3,
          triggeredBy: 'cli',
        },
        { retryMax: 2 },
      );
      await eodJob.waitUntilFinished(events, 30_000);

      const window1 = firstSeen(adapter.eodCalls);
      expect(window1).toEqual(['cn:000004', 'cn:000005', 'cn:000001']); // T0 先吃预算
      const delayed = await queue.queue.getDelayed();
      expect(delayed).toHaveLength(1); // deferral ≠ failure (017 顺延语义不变)
      expect(delayed[0]?.name).toBe('sync:eod_bar');

      // ── 顺延续跑: promote → 进度锚跳过已同步, 剩余 T2 补齐, 零重复 ──
      await delayed[0]?.promote();
      await delayed[0]?.waitUntilFinished(events, 30_000);
      expect(firstSeen(adapter.eodCalls)).toEqual(T0_FIRST_ORDER); // 窗2 只新增 000002/000003
      expect(await prisma.dailyBar.count()).toBe(5); // 5 标的 × none 1 行 (020 T008), 无重复
    });

    // ── 夜终态: T0 全保鲜 (全维度落库) + per-dim SyncRun 如实 + tier 终态正确 ──
    for (const code of T0_CODES) {
      const inst = await prisma.instrument.findUniqueOrThrow({
        where: { market_code: { market: 'cn', code } },
        select: { id: true, syncTier: true },
      });
      expect(inst.syncTier).toBe(0);
      expect(await prisma.dailyBar.count({ where: { instrumentId: inst.id } })).toBe(1);
      expect(await prisma.fundamentalSnapshot.count({ where: { instrumentId: inst.id } })).toBe(1);
      expect(await prisma.financialMetric.count({ where: { instrumentId: inst.id } })).toBe(1);
    }
    expect(await prisma.instrument.count({ where: { syncTier: 2 } })).toBe(3);

    // flow 24 维度各 1 行 (eod 外 5 核心 + 039 5 港股维度 + 040 volatility/hot_snapshot + 041 4 事件流维度 + 042 3 报告期维度 + 043 2 分类文本维度 + sellput-viz us_equity_bar + 046 underlying_iv_daily/us_index_daily) + eod 两窗各 1 行 = 26 行 per-dim SyncRun 全 success。
    const runs = await prisma.syncRun.findMany();
    expect(runs).toHaveLength(DIMENSION_KEYS.length + 1);
    expect(runs.every((r) => r.status === 'success')).toBe(true);
    expect(await prisma.syncRun.count({ where: { syncType: 'sync:eod_bar' } })).toBe(2);
  }, 90_000);
});
