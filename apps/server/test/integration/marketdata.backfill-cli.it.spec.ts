import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { coldStartUnused } from '../_support/cold-start-stub';
import { Logger } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
} from '../../src/marketdata/marketdata-sync.queue';
import { MarketdataSyncWorker } from '../../src/marketdata/marketdata-sync.worker';
import { executeBackfill, type BackfillDeps } from '../../src/marketdata/marketdata-backfill.cli';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三

/**
 * 夜间轮时刻: 周四 06:30 Asia/Shanghai = 周三 18:30 ET —— **us 已收盘**。
 *
 * 🚨 凡是把 `option_daily_snapshot` 一并入队的用例必须用它, 不能用文件级 `NOW`(ET 08:00 盘前):
 * 手动补采时点闸会拒绝入队 (2026-08-17 prod 实撞, 见 manual-sync-session-guard.ts)。
 * 「盘前跑全维度」在生产里本就是一条不该成立的命令 —— 那正是本闸要拦的东西。
 */
const NOW_AFTER_US_CLOSE = new Date('2026-06-03T22:30:00Z');

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  optionCoverageThreshold: 1,
};

// 016 T017 → 017 T018 backfill CLI 迁入队 IT (Testcontainers PG+Redis): dry-run 估算
// 打印不入队不写库 / 缺省全维度 flow (贴旧全管线) / --dimension functional 单维度 job /
// 等待超时退出码 2 (旧 2=锁未抢到 重映射, 锁退出 CLI 路径)。
describe('017 T018 backfill CLI 迁入队 (executeBackfill)', () => {
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
    await prisma.syncDimension.updateMany({ data: { enabled: true, lastWatermark: null } });
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

  it('① dry-run → 打印估算计划 + 退出码 0, 不入队不写库', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600519',
        name: 't',
        type: 'stock',
        currency: 'CNY',
        status: 'active',
      },
    });
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const code = await executeBackfill(
        buildDeps(queue, events),
        { dryRun: true, markets: ['cn'] },
        NOW,
      );
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('estVendorRequests'));
      expect(await prisma.syncRun.count()).toBe(0); // 不写库
      expect(await queue.queue.count()).toBe(0); // 不入队 (queue 空)
    } finally {
      logSpy.mockRestore();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('①-b --factors --dry-run → 零写库, 且估算数 == 真跑实际处理标的数 (真跑亦零 vendor 外呼)', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    await prisma.adjustmentFactor.deleteMany(); // 共享 beforeEach 不清这张表

    // 三只标的覆盖 rebuildFactorChains 的三条分支, 让「估算」与「真跑」有非平凡数字可比:
    //   A 有除权史 + 有 none 基底 → 真的处理 (唯一计入 estInstruments 的)
    //   B 有除权史但无 none 基底 → skipped
    //   C 无除权史              → skipped
    const mk = (code: string) =>
      prisma.instrument.create({
        data: { market: 'cn', code, name: 't', type: 'stock', currency: 'CNY', status: 'active' },
      });
    const a = await mk('600000');
    const b = await mk('600001');
    await mk('600002');
    for (const inst of [a, b]) {
      await prisma.corporateAction.create({
        data: {
          instrumentId: inst.id,
          exDate: new Date('2026-05-20T00:00:00Z'),
          type: 'dividend',
          payload: {},
        },
      });
    }
    await prisma.dailyBar.createMany({
      data: ['2026-05-19', '2026-05-20'].map((d) => ({
        instrumentId: a.id,
        tradeDate: new Date(`${d}T00:00:00Z`),
        adjust: 'none',
        open: '10',
        high: '10',
        low: '10',
        close: '10',
      })),
    });

    // 零 vendor 外呼如今由**类型层**保证 —— BackfillDeps 已不携带任何 eod 源
    // (T-2 修复时同步删掉了 eodBar spy, 旧断言见 git 史)。
    const deps: BackfillDeps = buildDeps(queue, events);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const code = await executeBackfill(
        deps,
        { dryRun: true, factors: true, markets: ['cn'] },
        NOW,
      );

      expect(code).toBe(0);
      // 🚨 修前会红: factors 分支 return 在通用 dry-run 闸之前 ⇒ --dry-run 真跑。
      expect(await prisma.adjustmentFactor.count()).toBe(0);

      const line = logSpy.mock.calls
        .map(([m]) => String(m))
        .find((m) => m.includes('factors dry-run'));
      expect(line).toBeDefined();
      const est = JSON.parse(line!.slice(line!.indexOf('{'))) as {
        scanned: number;
        estInstruments: number;
        skipped: number;
      };
      // 🚨 字段名随语义改过: 换事件条款法后本命令零 vendor 外呼, 再叫 estVendorRequests 会骗人。
      expect(est).toMatchObject({ scanned: 3, estInstruments: 1, skipped: 2 });
      expect(line).not.toContain('estVendorRequests');

      // 真跑同一份数据 —— 实际处理的标的数必须与上面估的一致。这是估算口径漂移的**唯一硬闸**
      // (#754 的教训: 估算与真跑各写一套过滤 ⇒ 数字骗人却无人发现)。
      await executeBackfill(deps, { dryRun: false, factors: true, markets: ['cn'] }, NOW);
      const done = logSpy.mock.calls
        .map(([m]) => String(m))
        .find((m) => m.includes('factors 回填完成'));
      expect(done).toBeDefined();
      const real = JSON.parse(done!.slice(done!.indexOf('{'))) as {
        instruments: number;
        skipped: number;
      };
      expect(real.instruments - real.skipped).toBe(est.estInstruments);
      // 真跑同样零 vendor 外呼 (锚定已全走本地四表) —— 由 BackfillDeps 类型层保证。
    } finally {
      logSpy.mockRestore();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('② 缺省全维度 → 组 flow 跑全 31 维度 (6 核心 + 039 5 + 040 2 + 041 4 + 042 3 + 043 2 港股维度 + sellput-viz us_equity_bar + 046 underlying_iv_daily/us_index_daily + 047 option_contract/option_daily_snapshot/earnings_event + 066 港股期权三维度, 贴旧全管线) + 退出码 0 + per-dim SyncRun', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry(),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const code = await executeBackfill(
        buildDeps(queue, events),
        { dryRun: false, historyDepth: 30, markets: ['cn'] },
        NOW_AFTER_US_CLOSE,
      );
      expect(code).toBe(0);
      expect(await prisma.instrument.count()).toBe(3); // universe 灌入 (旧语义保持)
      expect(await prisma.dailyBar.count()).toBeGreaterThan(0); // 历史 bar 灌入
      // 迁入队后审计形态 = per-dim SyncRun (016 聚合行已随 PR-7 清退, 仅历史数据存留)。
      const runs = await prisma.syncRun.findMany();
      const types = runs.map((r) => r.syncType).sort();
      expect(types).toEqual(
        [
          'sync:universe',
          'sync:us_equity_bar', // sellput-viz
          'sync:profile',
          'sync:fundamental',
          'sync:hk_option_contract', // 066 T04
          'sync:hk_option_daily_snapshot', // 066 T04
          'sync:hk_underlying_iv_daily', // 066 T04
          'sync:financial',
          'sync:eod_bar',
          'sync:corporate_action',
          // 039 5 + 040 2 + 041 4 + 042 3 + 043 2 港股维度: marketScope=hk, --markets cn 交集空工作集 → 空跑 success 落 SyncRun。
          'sync:short_selling',
          'sync:connect_holding',
          'sync:fund_holding',
          'sync:fund_company_holding',
          'sync:index_membership',
          'sync:volatility', // 040
          'sync:hot_snapshot', // 040
          'sync:buyback', // 041
          'sync:equity_change', // 041
          'sync:shareholder_change', // 041
          'sync:allotment', // 041
          'sync:revenue_segment', // 042
          'sync:shareholder_snapshot', // 042
          'sync:employee', // 042
          'sync:industry_classification', // 043
          'sync:announcement', // 043
          // 046 两维度 marketScope={us}, --markets cn 交集同样空 → 空跑 success 落 SyncRun。
          'sync:underlying_iv_daily', // 046
          'sync:us_index_daily', // 046
          // 047 三维度 marketScope={us}, --markets cn 交集同样空 → 空跑 success 落 SyncRun。
          'sync:option_contract', // 047
          'sync:option_daily_snapshot', // 047
          'sync:earnings_event', // 047
        ].sort(),
      );
      expect(runs.every((r) => r.status === 'success')).toBe(true);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('③ --dimension eod_bar → 仅单维度 job (functional, 配额分批回填场景)', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry(),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      // 预 seed universe (单维度 backfill 的运维前提: 标的已在库)。
      const seed = await executeBackfill(
        buildDeps(queue, events),
        { dryRun: false, dimension: 'universe', markets: ['cn'] },
        NOW,
      );
      expect(seed).toBe(0);
      await prisma.syncRun.deleteMany();

      const code = await executeBackfill(
        buildDeps(queue, events),
        { dryRun: false, dimension: 'eod_bar', historyDepth: 30, markets: ['cn'] },
        NOW,
      );
      expect(code).toBe(0);
      expect(await prisma.dailyBar.count()).toBeGreaterThan(0);
      // 仅 eod_bar 一行 — 其余维度未被拉起 (烧配额隔离)。
      const runs = await prisma.syncRun.findMany();
      expect(runs.map((r) => r.syncType)).toEqual(['sync:eod_bar']);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('④ 无 worker → 等待超时退出码 2 (旧 2=锁未抢到 重映射) + job 仍积压', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    try {
      const code = await executeBackfill(
        buildDeps(queue, events),
        { dryRun: false, dimension: 'eod_bar', markets: ['cn'], timeoutMs: 500 },
        NOW,
      );
      expect(code).toBe(2);
      const hit = errorSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('worker 不在线'),
      );
      expect(hit).toBe(true);
      expect(await queue.queue.getWaitingCount()).toBe(1);
      expect(await prisma.syncRun.count()).toBe(0);
    } finally {
      errorSpy.mockRestore();
      await events.close();
      await queue.onModuleDestroy();
    }
  });
});
