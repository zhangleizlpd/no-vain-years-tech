import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app/app.module';
import { PrismaService } from '../../src/security/prisma.service';
import { OptionSnapshotRemediation } from '../../src/marketdata/option-snapshot-remediation';
import { TradingCalendarSyncService } from '../../src/marketdata/trading-calendar-sync.service';
import { marketDateFor } from '../../src/marketdata/trading-day-gate';
import { MockCollectionRefusedError } from '../../src/marketdata/refusing-collection.adapter';
import {
  REALTIME_QUOTE_PORT,
  type RealtimeQuotePort,
} from '../../src/marketdata/realtime-quote.port';
import { MARKET_STATE_PORT, type MarketStatePort } from '../../src/marketdata/market-state.port';

/**
 * 054 T003 — **`MARKETDATA_PROVIDER=mock` 下三个写手跑完, 行情表零写库** (FR-004)。
 *
 * 054 之前, 这条路径在 dev 上是**真的会写**的: mock 采集口返回与真行情同形的 fixture,
 * 写手照单全收落进真表, 行数对得上、日志全绿, 事后无从分辨 (2026-08-12 实撞)。本 IT 就是
 * 「前件恒假」的机器判据 —— plan D-7 说留痕类 FR-001/002/003/005/006 是**蓄意的空满足**,
 * 而空满足唯一需要验的就是这一条。
 *
 * 🚨 **零写库本身是弱断言** —— 写手压根没跑也是零写库。故每条用例都同时断言
 * **「它确实试图采集、并被拒了」**: ① 补救侧看 `status === 'still_missing'` +
 * `attempted` 非空 (端口若返 fixture 会变成 `recovered`); ② 日历侧看心跳行的 `lastError`
 * 落的是 `MockCollectionRefusedError`。少了这一半, 用例会在「写手被误删」时照样绿。
 *
 * 🚨 **`now` 取固定时刻不取 `new Date()`**: mock 交易日历判「周一~周五」, 用真实时间会让
 * 本文件在周末退化成 idle 分支 —— 那是按日历 flaky, 且失败方向是**假绿**。
 *
 * 为什么必须全 boot `AppModule` 而不是手搭 DI: 本 feature 改的就是 `useFactory` 的绑定结果,
 * 任何不经真 DI 容器的写法验不到核心 (plan Testing Invariants「MANDATORY INTEGRATION」)。
 */

/** ET 16:00 (2026-08-12 周三) ⇒ `marketDateFor(['us'])` 恒得 `2026-08-12`, 且 mock 判它是交易日。 */
const NOW = new Date('2026-08-12T20:00:00Z');
const TODAY = '2026-08-12';
/** ② 级兜底要补的那个 session (= `TODAY` 的上一交易日, 由 `trading_day` 行定位)。 */
const PREV = '2026-08-11';
/** 覆盖率判定的分母来源日 —— 必须早于被判的那天且**有快照行**。 */
const BASELINE = '2026-08-10';

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const day = (s: string): Date => new Date(`${s}T00:00:00Z`);

describe('054 kind=mock 下写手零写库 (Testcontainers PG + Redis, 全 boot AppModule)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let prisma: PrismaService;
  let remediation: OptionSnapshotRemediation;
  let calendarSync: TradingCalendarSyncService;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'marketdata-054-no-write-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'marketdata-054-no-write-hmac-secret-min-32-by';
    delete process.env.MARKETDATA_PROVIDER; // 零 env → mock (本 IT 的前提)

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    remediation = moduleRef.get(OptionSnapshotRemediation);
    calendarSync = moduleRef.get(TradingCalendarSyncService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.tradingDay.deleteMany();
    await prisma.calendarSyncHealth.deleteMany();
  });

  /** 造一票 + 一张远月合约 + 一行 `snapshotOn` 当天的快照 (= 覆盖率判定的分母来源)。 */
  async function seedCoverageGap(snapshotOn: string): Promise<void> {
    const instrument = await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'PEP',
        name: 'PepsiCo',
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
    });
    const contract = await prisma.optionContract.create({
      data: {
        market: 'us',
        code: 'US.PEP260918P130000',
        root: 'PEP',
        underlyingInstrumentId: instrument.id,
        expiryDate: day('2026-09-18'), // 远月 ⇒ 恒满足「到期日 ≥ 被判的那天」, 进得了分母
        strikePrice: 130,
        optionType: 'PUT',
        isStandard: true,
      },
    });
    await prisma.optionDailySnapshot.create({
      data: {
        contractId: contract.id,
        sessionDate: day(snapshotOn),
        source: 'eod',
        quoteAsOf: day(snapshotOn),
        oiAsOf: day(snapshotOn),
        greeksComplete: true,
      },
    });
  }

  // 本文件全部用例的前提。它若漂了 (时区口径变更 / 夏令时边界), 下面几条会以「莫名走进
  // idle 分支」的形态假绿 —— 钉成显式断言, 让它以自己的名义红。
  it('时间锚: 固定 NOW 恒映射到 us 业务日 TODAY (周三)', () => {
    expect(marketDateFor(['us'], NOW)).toBe(TODAY);
  });

  it('state_branch 2: 判定无需采集 (空库 → no_subject) → 零写库', async () => {
    const outcome = await remediation.retrySameDay(NOW);

    expect(outcome.status).toBe('not_needed');
    expect(outcome.attempted).toEqual([]);
    expect(await prisma.optionDailySnapshot.count()).toBe(0);
  });

  it('state_branch 1: 判定需采集 (① 当日重试) → 试采被拒, 目标表零增长', async () => {
    await seedCoverageGap(PREV); // 分母来自 PREV, 当日 (TODAY) 无行 ⇒ degraded
    const before = await prisma.optionDailySnapshot.count();

    // 不上抛是被断言的行为本身: 既有写手整轮 try/catch, 专属错误走既有路径落日志 (plan D-4)。
    const outcome = await remediation.retrySameDay(NOW);

    expect(outcome.sessionDate).toBe(TODAY);
    // 🚨 这两条把「零写库」与「压根没跑」区分开: 它确实进了采集分支, 且采集**没成功**。
    // 端口若还返 fixture, status 会是 'recovered' —— 那正是 054 之前的行为。
    expect(outcome.attempted).toEqual(['us:PEP']);
    expect(outcome.status).toBe('still_missing');
    expect(await prisma.optionDailySnapshot.count()).toBe(before);
  });

  it('state_branch 1: 判定需采集 (② 盘前兜底) → 试采被拒, 不留 premarket_backfill 痕', async () => {
    await prisma.tradingDay.create({ data: { market: 'us', date: day(PREV) } });
    await seedCoverageGap(BASELINE); // 分母来自 BASELINE, PREV 当天无行 ⇒ degraded
    const before = await prisma.optionDailySnapshot.count();

    const outcome = await remediation.backfillPremarket(NOW);

    expect(outcome.sessionDate).toBe(PREV);
    expect(outcome.attempted).toEqual(['us:PEP']);
    expect(outcome.status).toBe('still_missing');
    expect(await prisma.optionDailySnapshot.count()).toBe(before);
    // 降级痕的权威形态是落库行的 source —— 采集被拒 ⇒ 一行都不该有。
    expect(
      await prisma.optionDailySnapshot.count({ where: { source: 'premarket_backfill' } }),
    ).toBe(0);
  });

  it('state_branch 3: 非定时写路径 (手工 syncRange, 与 seed CLI 同入口) → 同判据零写库', async () => {
    const results = await calendarSync.syncRange(['us'], BASELINE, TODAY);

    expect(results).toEqual([{ market: 'us', fetched: 0, inserted: 0 }]);
    expect(await prisma.tradingDay.count()).toBe(0);

    // 🚨 心跳行**是**要写的, 且这正是「被拒」的可见留痕 —— 044 的病根就是失败除日志外零留痕。
    // 它同时是本用例的「确实试过」证据: 端口若返 fixture, lastError 会是 null。
    const health = await prisma.calendarSyncHealth.findUnique({ where: { market: 'us' } });
    expect(health?.lastSuccessAt).toBeNull();
    expect(health?.lastError).toContain('MockCollectionRefusedError');
    expect(health?.lastError).toContain('TRADING_CALENDAR_SOURCE');
  });

  // 061 T005: 新增的两个采集口 (实时报价 / 市场时段) 继承同一条约束 —— 它们的产出会落进
  // `anchor` 的盘中两列, 与真行情同形 ⇒ mock 档下必须拒绝而不是给 fixture。这里断言的是
  // **真 DI 容器解析出来的绑定物**, 不是 `collectionPort` 工厂的返回值 (后者已由
  // `market-routed-realtime-quote.adapter.spec.ts` 单测覆盖)。
  it('061 两个新采集口在 mock 档下一调即抛, 零伪造报价', () => {
    const realtime = moduleRef.get<RealtimeQuotePort>(REALTIME_QUOTE_PORT);
    const marketState = moduleRef.get<MarketStatePort>(MARKET_STATE_PORT);

    // 拒绝壳抛在**调用点**而非属性访问点 ⇒ 同步 throw, 不是 rejected promise。
    expect(() => realtime.fetchQuotes(['us:PEP'])).toThrow(MockCollectionRefusedError);
    expect(() => marketState.getMarketSessions()).toThrow(MockCollectionRefusedError);
  });
});
