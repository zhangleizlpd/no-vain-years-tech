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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EarningsCalendarPort,
  EarningsCalendarWindowQuery,
} from '../../src/marketdata/earnings-calendar.port';
import {
  assembleEarningsDateSources,
  EARNINGS_DATE_SOURCE_NAMES,
} from '../../src/marketdata/earnings-date-source.port';
import { FutuCalendarSource } from '../../src/marketdata/futu-calendar.source';
import { HkexAnnouncementSource } from '../../src/marketdata/hkex-announcement.source';
import { HkexBoardMeetingListSource } from '../../src/marketdata/hkex-board-meeting-list.source';
import { HKEXNEWS_PROFILE } from '../../src/marketdata/hkexnews.constraint-profile';
import { DbTradingCalendarAdapter } from '../../src/marketdata/db-trading-calendar.adapter';
import {
  VendorHttpClient,
  type VendorHttpClientDeps,
} from '../../src/marketdata/vendor-http-client';
import { SyncEarningsDatesUseCase } from '../../src/marketdata/sync-earnings-dates.usecase';
import { SyncEarningsFiscalProfileUseCase } from '../../src/marketdata/sync-earnings-fiscal-profile.usecase';

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
  futuLaneEnabled: false, // 灰度默认关 ⇒ 全部 job 落 default lane (拆 lane 前的行为)。
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
      queueEventsFor: () => events,
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

  it('② 缺省全维度 → 组 flow 跑全 33 维度 (6 核心 + 039 5 + 040 2 + 041 4 + 042 3 + 043 2 港股维度 + sellput-viz us_equity_bar + 046 underlying_iv_daily/us_index_daily + 047 option_contract/option_daily_snapshot/earnings_event + 066 港股期权三维度 + 073 hk_option_oi_settle + 079 hk_earnings_date, 贴旧全管线) + 退出码 0 + per-dim SyncRun', async () => {
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
          'sync:hk_option_oi_settle', // 073 T006
          'sync:hk_earnings_date', // 079 T016 (默认实例零来源 ⇒ 空跑 success 落 SyncRun)
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

  // ── ⑤ 079 T023 历史业绩公布日回填 (FR-020 / SC-001, US5 AS1, plan §D9 回填) ──
  //
  // 走生产同一条 `executeBackfill --dimension hk_earnings_date` → 入队 (mode=backfill) → worker →
  // 执行器 → `runHk`, 三来源全真实现: 富途假端口记窗口入参、清单真 VendorHttpClient + 计数假 fetch、
  // 公告来源读真 `announcement` 表。刊发事实 / 通知信号 / 清单只在观测层与事件层落库, 断言都读库。
  it('⑤ 079 --dimension hk_earnings_date 回填 → 两年刊发事实在列并标来源 (hk:00005 / 00857 周日 / 09992 補充); 清单只请求 1 次', async () => {
    const NOW_HK = new Date('2026-09-13T15:30:00Z'); // 香港 23:30 ⇒ 业务日 2026-09-13 (清单 fixture 页首日)
    const BOARD_LIST_PAGE = readFileSync(
      join(
        __dirname,
        '../../src/marketdata/__fixtures__/hkex-board-meeting-list/ebmn_c-2026-09-13.htm',
      ),
      'utf8',
    );
    let boardListRequests = 0;
    // 客户端自带时钟: sleep 推进它 ⇒ 限频 (每秒 1 次) 在假 Date 下仍能放行下一次请求。共用冻结的
    // Date 时, 多请求的变异会让限频器空转永不放行 (整轮挂死而不是红)。
    let clientClockMs = NOW_HK.getTime();
    const http = new VendorHttpClient(HKEXNEWS_PROFILE, {
      now: () => clientClockMs,
      fetch: (async () => {
        boardListRequests += 1;
        return {
          status: 200,
          ok: true,
          json: async () => ({}),
          text: async () => BOARD_LIST_PAGE,
          headers: { get: () => null },
        };
      }) as unknown as VendorHttpClientDeps['fetch'],
      sleep: async (ms) => {
        clientClockMs += ms;
      },
    });
    const futuWindows: EarningsCalendarWindowQuery[] = [];
    const futu: EarningsCalendarPort = {
      getWindow: async (query) => {
        futuWindows.push({ ...query });
        return [];
      },
    };
    const calendar = new DbTradingCalendarAdapter(prisma);
    const dates = new SyncEarningsDatesUseCase(
      prisma,
      assembleEarningsDateSources([...EARNINGS_DATE_SOURCE_NAMES], {
        futu_calendar: new FutuCalendarSource(futu, prisma),
        hkex_announcement: new HkexAnnouncementSource(prisma),
        hkex_board_meeting_list: new HkexBoardMeetingListSource(http, prisma, calendar),
      }),
      new SyncEarningsFiscalProfileUseCase(prisma),
      calendar,
    );

    const seedHk = async (code: string): Promise<bigint> => {
      const { id } = await prisma.instrument.create({
        data: { market: 'hk', code, name: code, type: 'stock', currency: 'HKD', status: 'active' },
        select: { id: true },
      });
      // 🚨 档案先于公告: 刊发事实按档案对齐 `P:` 键 (无档案的年度 / 中期标题会落 `D:`)。
      await prisma.earningsFiscalProfile.create({
        data: { instrumentId: id, fiscalYearEndMonth: 12, source: 'manual', evidence: 'IT seed' },
      });
      return id;
    };
    let linkSeq = 0;
    const announce = (instrumentId: bigint, date: string, title: string) =>
      prisma.announcement.create({
        data: {
          instrumentId,
          date: new Date(`${date}T00:00:00Z`),
          linkUrl: `https://example.test/${instrumentId}/${++linkSeq}.pdf`,
          linkText: title,
          linkType: 'PDF',
          types: ['fs_main'],
        },
      });
    const hsbc = await seedHk('00005');
    const petroChina = await seedHk('00857');
    const popMart = await seedHk('09992');
    await announce(hsbc, '2026-02-25', '截至2025年12月31日止年度之業績公告');
    await announce(hsbc, '2026-05-05', '截至2026年3月31日止三個月之業績公告');
    await announce(petroChina, '2025-03-30', '截至2024年12月31日止年度之業績公告');
    await announce(petroChina, '2026-03-29', '截至2025年12月31日止年度之業績公告');
    await announce(petroChina, '2026-08-30', '截至2026年6月30日止六個月之中期業績公告');
    await announce(
      popMart,
      '2026-08-20',
      '截至2026年6月30日止六個月之中期業績公告及授出獎勵之補充公告',
    );

    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      viaEarningsDates(dates),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    // 🚨 worker 给执行器的 `input.now` 取处理时刻 (`new Date()`), 不是 CLI 的 `now` 入参 ⇒ 只假 Date
    // 钉住业务日, 否则回填窗随真实日期漂移 (清单页首日 / 730 天窗端点每天变)。定时器保持真实, bullmq 不受影响。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_HK);
    worker.onModuleInit();
    try {
      const code = await executeBackfill(
        buildDeps(queue, events),
        { dryRun: false, dimension: 'hk_earnings_date', markets: ['hk'] },
        NOW_HK,
      );

      expect(code).toBe(0);
      const runs = await prisma.syncRun.findMany();
      expect(runs.map((r) => [r.syncType, r.status])).toEqual([
        ['sync:hk_earnings_date', 'success'],
      ]);
      // 🚨 清单无历史: 回填也只取当日页一次 (🚫 按日循环请求 —— 730 天 = 730 次打交易所)。
      expect(boardListRequests).toBe(1);
      // mode=backfill 真的到了来源: 富途窗起点 = 业务日 − 730 天 (日常为 − 7)。
      expect(futuWindows[0]?.start).toBe('2024-09-13');

      const filed = async (instrumentId: bigint) =>
        (
          await prisma.earningsDateObservation.findMany({
            where: { instrumentId, basis: 'filed' },
            orderBy: { filedDate: 'asc' },
          })
        ).map((o) => [o.source, o.periodKey, o.filedDate?.toISOString().slice(0, 10)]);

      // US5 AS1: 来源 A (富途) 缺的两条经交易所刊发事实补齐, 并标来源。
      expect(await filed(hsbc)).toEqual([
        ['hkex_announcement', 'P:2025-12-31', '2026-02-25'],
        ['hkex_announcement', 'P:2026-03-31', '2026-05-05'],
      ]);
      // 三个周日刊发日 (2025-03-30 在日常 7 天 / 120 天窗外, 只有回填窗取得到)。
      const petroChinaFiled = await filed(petroChina);
      expect(petroChinaFiled).toEqual([
        ['hkex_announcement', 'P:2024-12-31', '2025-03-30'],
        ['hkex_announcement', 'P:2025-12-31', '2026-03-29'],
        ['hkex_announcement', 'P:2026-06-30', '2026-08-30'],
      ]);
      expect(
        petroChinaFiled.map(([, , d]) => new Date(`${String(d)}T00:00:00Z`).getUTCDay()),
      ).toEqual([0, 0, 0]);
      // 标题带「補充公告」的真实刊发不被当作補充排除 (FR-004)。
      expect(await filed(popMart)).toEqual([['hkex_announcement', 'P:2026-06-30', '2026-08-20']]);

      // 历史合并进事件层: 刊发事实覆盖 ⇒ published, 公布日 = 刊发日。
      const hsbcEvents = await prisma.earningsDateEvent.findMany({
        where: { instrumentId: hsbc },
        orderBy: { periodKey: 'asc' },
      });
      expect(
        hsbcEvents.map((e) => [e.periodKey, e.status, e.announceDate?.toISOString().slice(0, 10)]),
      ).toEqual([
        ['P:2025-12-31', 'published', '2026-02-25'],
        ['P:2026-03-31', 'published', '2026-05-05'],
      ]);
    } finally {
      vi.useRealTimers();
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  /**
   * 079 T023: 只装 `hk_earnings_date` 用得到的位置 (prisma / recorder / 第 35 位 use case), 其余留
   * undefined —— 同 `marketdata-079.earnings-dates.it.spec.ts` 的 `viaDimension`。
   */
  function viaEarningsDates(useCase: SyncEarningsDatesUseCase): DimensionExecutorRegistry {
    return new DimensionExecutorRegistry(
      undefined as never, // 1 syncUniverse
      undefined as never, // 2 syncProfile
      undefined as never, // 3 eodBar
      undefined as never, // 4 fundamental
      undefined as never, // 5 financials
      undefined as never, // 6 corporateAction
      prisma, // 7
      new SyncRunRecorder(prisma), // 8
      undefined as never, // 9 tierRecalc (本维度不走 fact 前置)
      undefined, // 10 backfillPacer
      undefined, // 11 shortSelling
      undefined, // 12 connectHolding
      undefined, // 13 fundHolding
      undefined, // 14 fundCompanyHolding
      undefined, // 15 indexMembership
      undefined, // 16 volatility
      undefined, // 17 hotSnapshot
      undefined, // 18 buyback
      undefined, // 19 equityChange
      undefined, // 20 shareholderChange
      undefined, // 21 allotment
      undefined, // 22 revenueSegment
      undefined, // 23 shareholderSnapshot
      undefined, // 24 employee
      undefined, // 25 industryClassification
      undefined, // 26 announcement
      undefined, // 27 anchorGate
      undefined, // 28 underlyingIv
      undefined, // 29 usIndex
      undefined, // 30 syncOptionContract
      undefined, // 31 syncOptionSnapshot
      undefined, // 32 syncEarningsEvent
      undefined, // 33 tradingCalendar
      undefined, // 34 syncOptionOiSettle
      useCase, // 35 syncEarningsDates
    );
  }
});
