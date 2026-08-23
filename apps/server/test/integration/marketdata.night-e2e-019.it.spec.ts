import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { coldStartUnused } from '../_support/cold-start-stub';
import { QueueEvents } from 'bullmq';
import { Prisma } from '../../src/generated/prisma/client';
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
const T0_CODES = ['000004', '000005'];
const HIT_SYMBOL = 'cn:000001'; // 混合态夜的除权命中标的。
const PREV_DAY = '2026-06-02'; // 前一交易日 (T007 跃变锚定相邻日)。

/**
 * 019 整夜模拟 adapter (018 T007 蓝本扩展): per-(symbol, adjust) 记录 eod 调用 (T010
 * none-only 断言面); 可配除权标的 (HIT_SYMBOL 返 exDate=AS_OF 的 dividend, forward/
 * backward = none × 1.05/1.10 段因子 — 因子链正确性断言源)。
 */
class Night019Adapter extends MockMarketDataAdapter {
  readonly eodCalls: Array<{ symbol: string; adjust: string }> = [];
  readonly fundamentalBatches: string[][] = [];
  readonly financialCalls: string[] = [];
  readonly corporateCalls: string[] = [];
  withCorpAction = false;

  override async enumerate(): Promise<UniverseEntry[]> {
    return CODES.map((code) => ({ market: 'cn', code, name: `股${code}` }));
  }

  override async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
    this.eodCalls.push({ symbol: query.symbol, adjust: query.adjust });
    const none = new Prisma.Decimal('100');
    // 两日序列 (窗口过滤): delta fetch (from=AS_OF) 仍只见当日; transient 锚定全窗拉到
    // 前一交易日 (020 T007 跃变锚定相邻日)。段因子 exDate=AS_OF 当日起 1.05/1.10。
    return [PREV_DAY, AS_OF]
      .filter((d) => (!query.from || d >= query.from) && (!query.to || d <= query.to))
      .map((d) => {
        const post = this.withCorpAction && query.symbol === HIT_SYMBOL && d >= AS_OF;
        const close =
          query.adjust === 'none'
            ? none
            : query.adjust === 'forward'
              ? none.mul(post ? '1.05' : '1')
              : none.mul(post ? '1.10' : '1');
        return {
          tradeDate: d,
          adjust: query.adjust,
          open: close.toFixed(4),
          high: close.toFixed(4),
          low: close.toFixed(4),
          close: close.toFixed(4),
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        };
      });
  }

  override async getFundamentals(symbols: string[]): Promise<FundamentalSnapshotDto[]> {
    this.fundamentalBatches.push([...symbols]);
    return [];
  }

  override async getFinancials(symbols: string[]): Promise<FinancialMetricDto[]> {
    this.financialCalls.push(...symbols);
    return [];
  }

  override async getCorporateActions(symbol: string): Promise<CorporateActionDto[]> {
    this.corporateCalls.push(symbol);
    if (this.withCorpAction && symbol === HIT_SYMBOL) {
      // 条款: 前收 100 派息 9.0909 → f = 100/90.9091 = 1.10 (与旧口径同值, 便于对照)。
      return [
        {
          symbol,
          exDate: AS_OF,
          type: 'dividend',
          payload: { status: 'implemented', dividend: 9.0909, currency: 'CNY' },
        },
      ];
    }
    return [];
  }
}

// 019 T019 (US5): ① SC-S08 退化态门 — 全维度翻回 continuous-daily 整夜模拟, gate 全直通
// 零 skipped, 行为与 017 现状等价 (FR-S11 可回退证据); ② 画像混合态整夜端到端 — 三类画像
// + 除权命中 + 预算截断 + 顺延续跑: 脉冲跳过审计在场、eod 只拉 none、因子链正确、tier 序保持。
describe('019 T019 整夜端到端 (退化态等价 + 画像混合态)', () => {
  let prisma: PrismaService;
  let lifecycle: QueueRedisLifecycle;
  let queue: MarketdataSyncQueue;

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
  }, 180_000);

  afterAll(async () => {
    await queue?.onModuleDestroy();
    lifecycle?.onApplicationShutdown();
    await prisma?.$disconnect();
    await stores.drop();
  });

  beforeEach(async () => {
    await prisma.adjustmentFactor.deleteMany();
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
        freshnessProfile: 'continuous-daily',
        calendarSource: null,
        pausedUntil: null,
        lastWatermark: null,
      },
    });
    await queue.queue.obliterate({ force: true });
  });

  function buildRegistry(adapter: Night019Adapter): DimensionExecutorRegistry {
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

  function buildDriver(check: CalendarHitCheck = new CalendarHitCheck()): SyncTickDriver {
    return new SyncTickDriver(prisma, queue, calendarOpen, CFG, check, new SyncRunRecorder(prisma));
  }

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

  it('① SC-S08 退化态门: 全 continuous-daily 整夜模拟 — gate 全直通零 skipped, 行为与 017 现状等价', async () => {
    // beforeEach 已全维度翻回 continuous-daily (退化态) — 灰度回切形态 (FR-S11)。
    await prisma.syncDimension.updateMany({ data: { nextFireAt: PAST } });
    const adapter = new Night019Adapter();
    const registry = buildRegistry(adapter);

    const tickResult = await buildDriver().tick(NOW);
    // 请求序列对拍半: 全维度照常 fired (gate 透明, 无任何剔除; 039/040/041/042/043 港股维度 beforeEach 也翻 continuous-daily)。
    expect(tickResult.fired.sort()).toEqual([
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
      'underlying_iv_daily', // 046 ('short_selling' < 'underlying_iv_daily' < 'universe': 'und' < 'uni')
      'universe',
      'us_equity_bar', // sellput-viz
      'us_index_daily', // 046 ('us_equity_bar' < 'us_index_daily' < 'volatility')
      'volatility', // 040
    ]);

    await withWorker(registry, async (events) => {
      const jobs = await queue.queue.getJobs(['waiting', 'waiting-children']);
      // 039 派生序: index_membership (priority 0) 收尾为 root (等 root = 整链终态)。
      const root = jobs.find((j) => j.name === 'sync:index_membership');
      expect(root).toBeDefined();
      await root?.waitUntilFinished(events, 60_000);
    });

    // 审计行对拍半: 全维度各 1 行全 success, **零 skipped 行** (gate 零干预 = 017 等价)。
    // 行数从 DIMENSION_KEYS 派生 —— 本断言钉的是「每个维度恰一行且全 success」, 不是字面维度数。
    const runs = await prisma.syncRun.findMany();
    expect(runs).toHaveLength(DIMENSION_KEYS.length);
    expect(runs.every((r) => r.status === 'success')).toBe(true);
    expect(await prisma.syncRun.count({ where: { status: 'skipped' } })).toBe(0);
    // 落库面: 5 标的 × none 1 行 (020 T008 单口径, 平淡日水位 NULL 全走 none)。
    expect(await prisma.dailyBar.count()).toBe(5);
    // 退化态下 eod 零 forward/backward 外呼 (T010 与画像正交 — 本地推导不依赖 gate)。
    expect(adapter.eodCalls.every((c) => c.adjust === 'none')).toBe(true);
  }, 90_000);

  it('② 画像混合态整夜: 三类画像 + 除权命中 + 预算截断 + 顺延续跑全链', async () => {
    // ── 夜前: 自选 T0 + 画像矩阵 + eod 水位 (D2 命中窗左界 = 昨日) + 既往除权日历 ──
    const group = await prisma.group.create({
      data: { accountId: 1001n, name: '自选', type: 'custom', order: 0 },
    });
    await prisma.watchlistItem.createMany({
      data: T0_CODES.map((code, i) => ({ groupId: group.id, market: 'cn', code, order: i })),
    });
    await prisma.syncDimension.update({
      where: { dimensionKey: 'financial' },
      data: { freshnessProfile: 'event-calendar', calendarSource: 'test-cal' },
    });
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['universe', 'profile', 'corporate_action'] } },
      data: { freshnessProfile: 'slow-drift' },
    });
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { lastWatermark: new Date('2026-06-02T14:30:00Z') },
    });
    // 命中标的预置: 标的行 (universe upsert 幂等) + 前一交易日 none 行 — T007 跃变锚定
    // 需相邻两日 (corp 相位 ex 日 bar 未在 → 跳过; eod 命中相位落库后补锚, 双点收敛)。
    const hitInst = await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '000001',
        name: '股000001',
        type: 'stock',
        currency: 'CNY',
        status: 'active',
      },
    });
    await prisma.dailyBar.create({
      data: {
        instrumentId: hitInst.id,
        tradeDate: new Date(`${PREV_DAY}T00:00:00Z`),
        adjust: 'none',
        open: '100.0000',
        high: '100.0000',
        low: '100.0000',
        close: '100.0000',
      },
    });

    const adapter = new Night019Adapter();
    adapter.withCorpAction = true; // 000001 今晚有新除权 (exDate = AS_OF)。
    const registry = buildRegistry(adapter);
    const check = new CalendarHitCheck();
    check.registerSource('test-cal', async () => false); // financial 平淡日: 未命中。

    // ── 22:00 tick: eod 之外维度 due (eod 走预算窗, 蓝本同款) ──
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { not: 'eod_bar' } },
      data: { nextFireAt: PAST },
    });
    const tickResult = await buildDriver(check).tick(NOW);
    // 脉冲剔除: financial 不在 fired (event-calendar 未命中); 其余照跑 (039/040/041/042/043 港股维度 continuous-daily 直通)。
    expect(tickResult.fired.sort()).toEqual([
      'allotment', // 041
      'announcement', // 043 ('allotment' < 'announcement' < 'buyback')
      'buyback', // 041
      'connect_holding', // 039
      'corporate_action',
      'earnings_event', // 047 ('corporate_action' < 'earnings_event' < 'employee')
      'employee', // 042
      'equity_change', // 041
      'fund_company_holding', // 039
      'fund_holding', // 039
      'fundamental',
      'hk_option_contract', // 066 T04
      'hk_option_daily_snapshot', // 066 T04
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
      'underlying_iv_daily', // 046 ('short_selling' < 'underlying_iv_daily' < 'universe': 'und' < 'uni')
      'universe',
      'us_equity_bar', // sellput-viz
      'us_index_daily', // 046 ('us_equity_bar' < 'us_index_daily' < 'volatility')
      'volatility', // 040
    ]);
    // 脉冲跳过审计在场 (FR-S03)。
    const skipped = await prisma.syncRun.findMany({ where: { status: 'skipped' } });
    expect(skipped.map((r) => r.syncType)).toEqual(['sync:financial']);
    expect(JSON.stringify(skipped[0].failedTargets)).toContain('日历未命中');

    await withWorker(registry, async (events) => {
      const jobs = await queue.queue.getJobs(['waiting', 'waiting-children']);
      // 039 派生序: fired 集 (eod/financial 外) root = index_membership (priority 0 收尾)。
      const root = jobs.find((j) => j.name === 'sync:index_membership');
      expect(root).toBeDefined();
      await root?.waitUntilFinished(events, 60_000);

      // SC-S03 端到端: financial 零 vendor 数据外呼。
      expect(adapter.financialCalls).toEqual([]);
      // corp 周扫即同步: 除权事件物化 (exDate = AS_OF 行在库)。
      expect(await prisma.corporateAction.count()).toBe(1);
      // fundamental 批量 (T015 batch 100): 单批含 5 标的, T0 先序 (tier 序保持)。
      expect(adapter.fundamentalBatches).toHaveLength(1);
      expect(adapter.fundamentalBatches[0].slice(0, 2)).toEqual(['cn:000004', 'cn:000005']);

      // ── eod 预算窗 1 (预算 3): T0 保底 → 000004/000005/000001(命中) → 截断顺延 ──
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
      const delayed = await queue.queue.getDelayed();
      expect(delayed).toHaveLength(1); // 截断顺延 (deferral ≠ failure)。
      await delayed[0]?.promote();
      await delayed[0]?.waitUntilFinished(events, 30_000);
    });

    // ── 夜终态断言 ──
    // eod 只拉 none (平淡标的): 除命中标的外全部仅 none 口径外呼。
    const eodBySymbol = (s: string) =>
      adapter.eodCalls.filter((c) => c.symbol === s).map((c) => c.adjust);
    for (const code of ['000002', '000003', '000004', '000005']) {
      expect(eodBySymbol(`cn:${code}`)).toEqual(['none']);
    }
    // 🚨 命中标的也只拉 none —— 换事件条款法后锚定零 vendor 外呼 (旧口径此处还有一次
    // backward transient 拉取)。
    expect(eodBySymbol(HIT_SYMBOL)).toEqual(['none']);
    // tier 序保持 (FR-S10): eod none 调用首现序 = T0 整体先于 T2。
    const noneOrder = [
      ...new Set(adapter.eodCalls.filter((c) => c.adjust === 'none').map((c) => c.symbol)),
    ];
    expect(noneOrder.slice(0, 2)).toEqual(['cn:000004', 'cn:000005']);

    // 因子链正确: 命中标的按条款算出 f = 前收/(前收 − 派息) = 100/90.9091 = 1.10。
    const inst = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'cn', code: '000001' } },
      select: { id: true },
    });
    const factors = await prisma.adjustmentFactor.findMany({ where: { instrumentId: inst.id } });
    expect(factors).toHaveLength(1);
    expect(new Prisma.Decimal(factors[0].factorBackward).toFixed(2)).toBe('1.10');

    // none 单口径全员当夜在场 (020 T008): 5 标的 × 1 行。
    expect(
      await prisma.dailyBar.count({ where: { tradeDate: new Date(`${AS_OF}T00:00:00Z`) } }),
    ).toBe(5);

    // SyncRun 审计: fired 4 维度 success + financial skipped + eod 两窗 success。
    expect(await prisma.syncRun.count({ where: { status: 'skipped' } })).toBe(1);
    expect(
      await prisma.syncRun.count({ where: { syncType: 'sync:eod_bar', status: 'success' } }),
    ).toBe(2);
    expect(await prisma.syncRun.count({ where: { status: 'failed' } })).toBe(0);
  }, 120_000);
});
