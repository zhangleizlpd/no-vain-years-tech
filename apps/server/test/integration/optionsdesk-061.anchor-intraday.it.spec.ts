import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { setupIsolatedStores } from '../_support/isolated-db';
import { marketdataConfig, type MarketdataConfig } from '../../src/config/marketdata.config';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { marketDateFor } from '../../src/marketdata/trading-day-gate';
import {
  REALTIME_QUOTE_PORT,
  RealtimeQuoteMarketUnsupportedError,
  type RealtimeQuote,
  type RealtimeQuotePort,
} from '../../src/marketdata/realtime-quote.port';
import {
  MARKET_STATE_PORT,
  type MarketSessionState,
  type MarketStatePort,
} from '../../src/marketdata/market-state.port';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { CreateAnchorUseCase } from '../../src/optionsdesk/create-anchor.usecase';
import { computeDistanceToWPct } from '../../src/optionsdesk/anchor.rules';
import { GetRadarUseCase, type RadarPage } from '../../src/optionsdesk/get-radar.usecase';
import {
  INTRADAY_CIRCUIT_THRESHOLD,
  INTRADAY_FRESHNESS_SECONDS,
} from '../../src/optionsdesk/intraday-spot.rules';
import {
  SyncAnchorIntradayScheduler,
  INTRADAY_CIRCUIT_KEY,
  INTRADAY_FAILSTREAK_KEY,
  INTRADAY_LAST_SESSIONS_KEY,
  type AnchorIntradayTickOutcome,
} from '../../src/optionsdesk/sync-anchor-intraday.scheduler';
import type {
  MarketIntradayOutcome,
  SyncAnchorIntradayReport,
} from '../../src/optionsdesk/sync-anchor-intraday';

/**
 * 061 T009/T010 — 盘中价投影 tick + 雷达读端裁决的**真容器 IT**
 * (spec `state_branches` 1–15)。
 *
 * ## 为什么必须要真 PG
 *
 * 被测的三件事全部只在真库里成立：① 「不清空既有实时价」是**列的状态**，fake 仓储里
 * 那两列是测试自己写的对象属性，断言等于自证；② 「部分锚成功部分失败 MUST NOT 整批回滚」
 * 只有真的让某一行的 `UPDATE` 被 PG 拒（`numeric(18,4)` 溢出）才构成证据 —— fake 里
 * 「让某个 key 抛」是编排出来的，验不到「同批其余行已提交」；③ 读端的 spot 排序表达式与
 * 空态计数是 **SQL**（`COALESCE(CASE WHEN intraday_at >= $cutoff …)` + `COUNT(*) FILTER`），
 * TS 侧没有等价物可测 —— 本 feature 至此全部是 Small 单测 + fake port，这条 SQL 支路
 * (「实时价新鲜」那一支) 在真库上是零覆盖。
 *
 * ## 为什么必须要真 Redis
 *
 * scheduler 的三个跨拍状态（failstreak / circuit / 上一拍市场时段）全在 Redis，而被测的
 * 判据恰恰是**跨拍**的：「连续 3 轮失败才熔断」「熔断后首次成功自动回升」「上一拍在白名单内
 * ∧ 本拍不在 → 补一拍」。用内存 fake 替掉 Redis，验的就只剩测试自己写的那个 Map。
 *
 * ## 🚨🚨 `MARKETDATA_PROVIDER` 在测试里恒钉 `mock`（`vitest.config.ts` 的 `test.env`）
 *
 * ⇒ 不 override `marketdataConfig.KEY` 的话，`SyncAnchorIntradayScheduler.run()` 起手就
 * `return { status: 'skipped-mock' }`、**一次 port 调用都不发**，下面所有用例会**绿得毫无
 * 意义**。本文件把它 override 成 `kind: 'live'`（vendor 侧另用 fake port 顶掉，零外呼）——
 * 这是本文件最容易静默失败的地方，改动这段前先想清楚。
 *
 * ## 装配方式 = 真 DI 容器（plan「Testing Invariants」第一条）
 *
 * `Test.createTestingModule({ imports: [OptionsdeskModule] })` —— **MUST NOT**
 * `new SyncAnchorIntradayScheduler(...)` 手搓实例。tick 的形态是「scheduler 读跨拍状态 →
 * use case 两闸取交集 → 跨 ctx port → 写自有两列」，手搓等于把 module 接线（本片新增的唯一
 * 一条 module 边 `optionsdesk → marketdata`）整个抽掉。**不建 Nest application**：本文件
 * 零 HTTP 面，且不 `init()` 顺带避开 marketdata 的 BullMQ worker（它挂在 `onModuleInit`）。
 *
 * ⚠️ 每个 `it()` 的名字**引用该分支判据的原文关键短语**，MUST NOT 用「第 N 条」这类序号 ——
 * spec 里重排分支时序号会静默失配，而**没有任何检查会红**。
 */

/** ET 16:00（2026-08-12 周三）⇒ us 业务日恒为 08-12，与宿主时区无关。 */
const NOW = new Date('2026-08-12T20:00:00Z');
const US_DATE = marketDateFor(['us'], NOW);
const HK_DATE = marketDateFor(['hk'], NOW);

/**
 * 🚨 读端断言用**真实墙钟**（`GetRadarUseCase` 自己取 `new Date()`，无注入口），故盘中价的
 * 新鲜/陈旧一律由 {@link INTRADAY_FRESHNESS_SECONDS} 派生，**MUST NOT 在本文件手写 90**。
 */
const FRESHNESS_MS = INTRADAY_FRESHNESS_SECONDS * 1000;

/** 一个**已越过新鲜度闸**的采集时刻 —— 也正是「连续 3 轮失败」之后的真实处境。 */
const staleInstant = (): Date => new Date(Date.now() - FRESHNESS_MS - 60_000);

/** 某时刻所属的 UTC 日（`@db.Date` 列的存法）。 */
const dayOf = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** V=50 ⇒ W 由 rules 派生（本文件零档位字面量）。 */
const V = '50';

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点。 */
const day = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/**
 * 🚨 live 形状的假 config —— 只为过 `kind === 'mock'` 那道闸。两个真正会被调用的 port
 * 都被 fake 顶掉了，其余 live adapter 只是拿着这些假 URL 被构造出来，零外呼。
 */
const LIVE_CONFIG: MarketdataConfig = {
  kind: 'live',
  lixingerToken: 'it-061-fake-lixinger-token',
  lixingerBaseUrl: 'https://lixinger.invalid/api',
  eastmoneyBaseUrl: 'https://eastmoney.invalid',
  eastmoneyClistBaseUrl: 'https://eastmoney-clist.invalid',
  tencentCalendarBaseUrl: 'https://tencent.invalid',
  futuShimUrl: 'https://futu-shim.invalid',
  futuShimToken: 'it-061-fake-shim-token',
};

interface MarketStateFake extends MarketStatePort {
  calls: number;
  shouldFail: boolean;
  sessions: MarketSessionState[];
}

interface RealtimeQuoteFake extends RealtimeQuotePort {
  calls: number;
  failWith: Error | null;
  registeredMarkets: string[];
  quotes: Map<string, RealtimeQuote>;
}

describe('061 锚盘中价投影 + 雷达裁决 IT (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let moduleRef: TestingModule;
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let prisma: PrismaService;
  let redis: Redis;
  let scheduler: SyncAnchorIntradayScheduler;
  let createAnchor: CreateAnchorUseCase;
  let getRadar: GetRadarUseCase;

  /** 市场时段假源 —— 三态由用例直接摆布；`shouldFail` 造「状态不可得」。 */
  const marketStatePort: MarketStateFake = {
    calls: 0,
    shouldFail: false,
    sessions: [],
    async getMarketSessions(): Promise<MarketSessionState[]> {
      marketStatePort.calls += 1;
      if (marketStatePort.shouldFail) throw new Error('mock market-state source unreachable');
      return marketStatePort.sessions;
    },
  };

  /**
   * 实时报价假源。**未登记市场抛专属错误**（照 `MarketRoutedRealtimeQuoteAdapter` 的
   * fail-closed 语义）—— 这是 `state_branch` 14「配置事实 ≠ 源故障」的触发方式。
   */
  const realtimeQuotePort: RealtimeQuoteFake = {
    calls: 0,
    failWith: null,
    registeredMarkets: ['us'],
    quotes: new Map<string, RealtimeQuote>(),
    async fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>> {
      realtimeQuotePort.calls += 1;
      for (const symbol of symbols) {
        const market = symbol.slice(0, symbol.indexOf(':'));
        if (!realtimeQuotePort.registeredMarkets.includes(market)) {
          throw new RealtimeQuoteMarketUnsupportedError(
            market,
            realtimeQuotePort.registeredMarkets,
          );
        }
      }
      if (realtimeQuotePort.failWith !== null) throw realtimeQuotePort.failWith;
      const out = new Map<string, RealtimeQuote>();
      for (const symbol of symbols) {
        const quote = realtimeQuotePort.quotes.get(symbol);
        if (quote !== undefined) out.set(symbol, quote);
      }
      return out;
    },
  };

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-061-intraday-jwt-secret-min-32b';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-061-intraday-hmac-secret-min32';

    moduleRef = await Test.createTestingModule({
      imports: [
        OptionsdeskModule,
        // 真 app 的全局 ThrottlerModule 注册在 AuthModule（storage 跨 controller 共享）;
        // 本文件不引 AuthModule, 故给同形态的最小注册让两个 Guard 能真实解析
        // （体例照 `optionsdesk.controller.spec.ts`）。本文件零 HTTP 面, 限流不在验证面内。
        ThrottlerModule.forRoot({ throttlers: [{ limit: 1_000, ttl: 60_000 }] }),
      ],
    })
      .overrideProvider(REALTIME_QUOTE_PORT)
      .useValue(realtimeQuotePort)
      .overrideProvider(MARKET_STATE_PORT)
      .useValue(marketStatePort)
      .overrideProvider(marketdataConfig.KEY)
      .useValue(LIVE_CONFIG)
      .compile();

    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
    scheduler = moduleRef.get(SyncAnchorIntradayScheduler);
    createAnchor = moduleRef.get(CreateAnchorUseCase);
    getRadar = moduleRef.get(GetRadarUseCase);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change RESTART IDENTITY',
    );
    await prisma.$executeRawUnsafe('TRUNCATE marketdata.trading_day RESTART IDENTITY CASCADE');
    await redis.flushdb();
    marketStatePort.calls = 0;
    marketStatePort.shouldFail = false;
    marketStatePort.sessions = [];
    realtimeQuotePort.calls = 0;
    realtimeQuotePort.failWith = null;
    realtimeQuotePort.registeredMarkets = ['us'];
    realtimeQuotePort.quotes = new Map<string, RealtimeQuote>();
  });

  // ── fixture helpers ────────────────────────────────────────────────────────

  interface AnchorPatch {
    intradayPrice?: string | null;
    intradayAt?: Date | null;
    lastClose?: string | null;
    lastCloseDate?: Date | null;
  }

  /** 走真写侧 use case 建锚（派生列齐备），再按需把行情四列摆到用例需要的状态。 */
  async function seedAnchor(ticker: string, patch: AnchorPatch = {}): Promise<bigint> {
    const created = await createAnchor.execute({
      ticker,
      v: V,
      asof: day('2026-06-30'),
      method: 'dcf',
      confidence: '8', // → L2
      nextReview: day('2099-01-01'),
    });
    if (Object.keys(patch).length > 0) {
      await prisma.anchor.update({ where: { id: created.id }, data: patch });
    }
    return created.id;
  }

  async function seedTradingDay(market: string, date: string): Promise<void> {
    await prisma.tradingDay.create({ data: { market, date: day(date) } });
  }

  const rowOf = (ticker: string) => prisma.anchor.findUniqueOrThrow({ where: { ticker } });

  /** 收窄到 `ticked` 分支（其余两态在本文件里都是失败信号，直接炸而不是静默 undefined）。 */
  function ticked(
    outcome: AnchorIntradayTickOutcome,
  ): Extract<AnchorIntradayTickOutcome, { status: 'ticked' }> {
    if (outcome.status !== 'ticked') {
      throw new Error(`期望 ticked, 实得 ${JSON.stringify(outcome)}`);
    }
    return outcome;
  }

  function marketOf(report: SyncAnchorIntradayReport, market: string): MarketIntradayOutcome {
    const found = report.markets.find((m) => m.market === market);
    if (found === undefined) {
      throw new Error(`报告里没有 ${market} 组: ${JSON.stringify(report.markets)}`);
    }
    return found;
  }

  /** 常规时段 + 交易日的「一切正常」前提，绝大多数用例的起点。 */
  async function givenUsRegularTradingDay(): Promise<void> {
    marketStatePort.sessions = [{ market: 'us', session: 'regular' }];
    await seedTradingDay('us', US_DATE);
  }

  const tickersOf = (page: RadarPage): string[] => page.items.map((i) => i.row.ticker);

  function viewOf(page: RadarPage, ticker: string): RadarPage['items'][number] {
    const found = page.items.find((i) => i.row.ticker === ticker);
    if (found === undefined) {
      throw new Error(`雷达页里没有 ${ticker}: ${JSON.stringify(tickersOf(page))}`);
    }
    return found;
  }

  /** 把源打到「连续 {@link INTRADAY_CIRCUIT_THRESHOLD} 轮全失败」⇒ circuit open。 */
  async function tripCircuit(): Promise<void> {
    realtimeQuotePort.failWith = new Error('mock realtime source down');
    for (let round = 0; round < INTRADAY_CIRCUIT_THRESHOLD; round += 1) {
      expect(ticked(await scheduler.run(NOW)).verdict).toBe('failure');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // T009 · 时段闸与采集路径（`state_branches` 1–8）
  // ═══════════════════════════════════════════════════════════════════════════

  describe('时段闸与采集路径', () => {
    it('市场处于常规交易状态 且 当日为交易日 → 采集并写入实时价与采集时刻', async () => {
      await seedAnchor('us:AOS');
      await givenUsRegularTradingDay();
      const capturedAt = new Date('2026-08-12T19:59:30.000Z');
      realtimeQuotePort.quotes.set('us:AOS', { price: '36.25', capturedAt });

      const outcome = ticked(await scheduler.run(NOW));

      expect(outcome.verdict).toBe('success');
      expect(outcome.circuit).toBe('closed');
      expect(marketOf(outcome.report, 'us')).toMatchObject({
        status: 'collected',
        anchors: 1,
        quoted: 1,
        updated: 1,
        forced: false,
      });
      const row = await rowOf('us:AOS');
      expect(row.intradayPrice?.toString()).toBe('36.25');
      expect(row.intradayAt?.toISOString()).toBe(capturedAt.toISOString());
    });

    it('市场处于白名单外的已知状态（盘前 / 盘后 / 夜盘 / 收盘竞价 / 闭市）→ 不采集, 且不清空既有实时价', async () => {
      const staleAt = new Date('2026-08-11T19:00:00.000Z');
      await seedAnchor('us:AOS', { intradayPrice: '30', intradayAt: staleAt });
      marketStatePort.sessions = [{ market: 'us', session: 'other' }];
      await seedTradingDay('us', US_DATE);

      const outcome = ticked(await scheduler.run(NOW));

      expect(marketOf(outcome.report, 'us')).toEqual({
        market: 'us',
        status: 'skipped-session',
        session: 'other',
      });
      expect(realtimeQuotePort.calls).toBe(0);
      expect(outcome.verdict).toBe('no-attempt');
      // 🚨 降级路径 MUST NOT 清空 —— 清空会把「陈旧但可用」误降成「不可用」(FR-013)。
      const row = await rowOf('us:AOS');
      expect(row.intradayPrice?.toString()).toBe('30');
      expect(row.intradayAt?.toISOString()).toBe(staleAt.toISOString());
    });

    it('市场状态为白名单外的未知值（源新增了状态）→ 按闭市处理并留痕, 不猜测为开市', async () => {
      await seedAnchor('us:AOS');
      marketStatePort.sessions = [{ market: 'us', session: 'unknown' }];
      await seedTradingDay('us', US_DATE);

      const outcome = ticked(await scheduler.run(NOW));

      expect(realtimeQuotePort.calls).toBe(0);
      // 留痕 = `unknown` 与 `other` 在报告里**可分辨**：动作相同, 但前者意味着 vendor 值域变了。
      expect(marketOf(outcome.report, 'us')).toEqual({
        market: 'us',
        status: 'skipped-session',
        session: 'unknown',
      });
      expect(outcome.report.sessions).toEqual({ us: 'unknown' });
    });

    it('市场状态不可得（源不可达 / 超时）→ fail-closed 不采集并计入失败计数, 不默认当作开市', async () => {
      const staleAt = new Date('2026-08-11T19:00:00.000Z');
      await seedAnchor('us:AOS', { intradayPrice: '30', intradayAt: staleAt });
      await seedTradingDay('us', US_DATE);
      marketStatePort.shouldFail = true;

      const outcome = ticked(await scheduler.run(NOW));

      expect(outcome.report.sessions).toBeNull();
      expect(outcome.report.sourceFailures).toBe(1);
      expect(outcome.verdict).toBe('failure');
      expect(outcome.failstreak).toBe(1);
      // 「不知道开没开市就采」等于把白名单判据作废 ⇒ 一次报价调用都不该发。
      expect(realtimeQuotePort.calls).toBe(0);
      const row = await rowOf('us:AOS');
      expect(row.intradayPrice?.toString()).toBe('30');
      expect(row.intradayAt?.toISOString()).toBe(staleAt.toISOString());
    });

    it('市场状态显示开市 但 当日非交易日 → 不采集（两闸取交集, 交易日闸不可被市场状态顶替）', async () => {
      await seedAnchor('us:AOS');
      marketStatePort.sessions = [{ market: 'us', session: 'regular' }];
      // 蓄意**不**塞 trading_day 行 —— 源侧状态机滞后（节假日仍报 regular）就是这个现场。
      realtimeQuotePort.quotes.set('us:AOS', { price: '36', capturedAt: NOW });

      const outcome = ticked(await scheduler.run(NOW));

      expect(marketOf(outcome.report, 'us')).toEqual({
        market: 'us',
        status: 'skipped-holiday',
        date: US_DATE,
      });
      expect(realtimeQuotePort.calls).toBe(0);
      expect(outcome.verdict).toBe('no-attempt');
      const row = await rowOf('us:AOS');
      expect(row.intradayPrice).toBeNull();
      expect(row.intradayAt).toBeNull();
    });

    it('常规交易状态刚刚结束的那一刻 → 再补采一拍把当日收盘价收进来, 不停在收盘前的最后一次', async () => {
      await seedAnchor('us:AOS');
      await givenUsRegularTradingDay();
      realtimeQuotePort.quotes.set('us:AOS', {
        price: '36',
        capturedAt: new Date('2026-08-12T19:59:30.000Z'),
      });

      // ① 盘中一拍：上一拍状态落 Redis（补一拍唯一的跨拍状态）。
      ticked(await scheduler.run(NOW));
      expect(JSON.parse((await redis.get(INTRADAY_LAST_SESSIONS_KEY)) ?? 'null')).toEqual({
        us: 'regular',
      });

      // ② 状态**离开**白名单的那一拍：时段闸没过, 但仍然采 —— 收的就是当日收盘价。
      marketStatePort.sessions = [{ market: 'us', session: 'other' }];
      const closingAt = new Date('2026-08-12T20:00:05.000Z');
      realtimeQuotePort.quotes.set('us:AOS', { price: '35.5', capturedAt: closingAt });
      const closingTick = ticked(await scheduler.run(NOW));

      expect(marketOf(closingTick.report, 'us')).toMatchObject({
        status: 'collected',
        forced: true,
        updated: 1,
      });
      const afterClose = await rowOf('us:AOS');
      expect(afterClose.intradayPrice?.toString()).toBe('35.5');
      expect(afterClose.intradayAt?.toISOString()).toBe(closingAt.toISOString());

      // ③ 再下一拍：上一拍已不在白名单 ⇒ 补一拍只发生一次, 不退化成全天采集。
      const callsBefore = realtimeQuotePort.calls;
      const idleTick = ticked(await scheduler.run(NOW));
      expect(marketOf(idleTick.report, 'us')).toEqual({
        market: 'us',
        status: 'skipped-session',
        session: 'other',
      });
      expect(realtimeQuotePort.calls).toBe(callsBefore);
      expect((await rowOf('us:AOS')).intradayPrice?.toString()).toBe('35.5');
    });

    it('市场状态不可得的那一拍 → 不覆写上一拍的市场时段（否则一次源抖动会吞掉唯一的收盘边沿）', async () => {
      await seedAnchor('us:AOS');
      await givenUsRegularTradingDay();
      realtimeQuotePort.quotes.set('us:AOS', { price: '36', capturedAt: NOW });
      ticked(await scheduler.run(NOW));

      // 源抖动一拍：`sessions === null` ⇒ 上一拍状态**不**被覆写。
      marketStatePort.shouldFail = true;
      const flaky = ticked(await scheduler.run(NOW));
      expect(flaky.report.sessions).toBeNull();
      expect(JSON.parse((await redis.get(INTRADAY_LAST_SESSIONS_KEY)) ?? 'null')).toEqual({
        us: 'regular',
      });

      // 抖动之后收盘边沿仍在：补一拍照常发生（若上面被覆写成 null, 这里会退化成 skipped）。
      marketStatePort.shouldFail = false;
      marketStatePort.sessions = [{ market: 'us', session: 'other' }];
      const closingAt = new Date('2026-08-12T20:00:05.000Z');
      realtimeQuotePort.quotes.set('us:AOS', { price: '35.5', capturedAt: closingAt });
      const closingTick = ticked(await scheduler.run(NOW));

      expect(marketOf(closingTick.report, 'us')).toMatchObject({
        status: 'collected',
        forced: true,
      });
      expect((await rowOf('us:AOS')).intradayPrice?.toString()).toBe('35.5');
    });

    it('采集成功 但 响应中缺某锚的标的 → 该锚保留上一次的价与时刻, 不写空、不写 0', async () => {
      const keptAt = new Date('2026-08-11T19:00:00.000Z');
      await seedAnchor('us:AOS');
      await seedAnchor('us:TAP', { intradayPrice: '28.5', intradayAt: keptAt });
      await givenUsRegularTradingDay();
      // 响应里只有 AOS —— 停牌 / 刚摘牌 / 这一刻没有成交价都归此列。
      realtimeQuotePort.quotes.set('us:AOS', { price: '36', capturedAt: NOW });

      const outcome = ticked(await scheduler.run(NOW));

      expect(marketOf(outcome.report, 'us')).toMatchObject({
        status: 'collected',
        anchors: 2,
        quoted: 1,
        updated: 1,
      });
      const missing = await rowOf('us:TAP');
      expect(missing.intradayPrice?.toString()).toBe('28.5');
      expect(missing.intradayAt?.toISOString()).toBe(keptAt.toISOString());
      expect((await rowOf('us:AOS')).intradayPrice?.toString()).toBe('36');
    });

    it('同一轮内部分锚成功、部分失败 → 成功的落库, 失败的保留旧值, 不整批回滚', async () => {
      const keptAt = new Date('2026-08-11T19:00:00.000Z');
      await seedAnchor('us:AOS');
      await seedAnchor('us:TAP', { intradayPrice: '28.5', intradayAt: keptAt });
      await seedAnchor('us:PEP');
      await givenUsRegularTradingDay();
      realtimeQuotePort.quotes.set('us:AOS', { price: '36', capturedAt: NOW });
      // 🚨 真 PG 才有的失败：`intraday_price` 是 `numeric(18,4)` ⇒ 20 位整数直接被库拒,
      // 而同批其余行已各自独立提交（逐锚 `updateMany`, 无包裹事务）。
      realtimeQuotePort.quotes.set('us:TAP', {
        price: '99999999999999999999',
        capturedAt: NOW,
      });
      realtimeQuotePort.quotes.set('us:PEP', { price: '41', capturedAt: NOW });

      const outcome = ticked(await scheduler.run(NOW));

      expect(marketOf(outcome.report, 'us')).toMatchObject({
        status: 'collected',
        anchors: 3,
        quoted: 3,
        updated: 2,
        failedWrites: 1,
      });
      // 写库失败不是行情源的事 ⇒ 本拍对源仍判成功（熔断口径不受影响）。
      expect(outcome.verdict).toBe('success');
      expect((await rowOf('us:AOS')).intradayPrice?.toString()).toBe('36');
      expect((await rowOf('us:PEP')).intradayPrice?.toString()).toBe('41');
      const failed = await rowOf('us:TAP');
      expect(failed.intradayPrice?.toString()).toBe('28.5');
      expect(failed.intradayAt?.toISOString()).toBe(keptAt.toISOString());
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // T010 · 熔断、降级与读端裁决（`state_branches` 9–15）
  //
  // 11–15 打的是**雷达读端**（`GetRadarUseCase`）—— 排序表达式与空态计数都是 SQL
  // （`COALESCE(CASE WHEN intraday_at >= $cutoff …)` + `COUNT(*) FILTER`），在真库上跑之前
  // 「实时价新鲜」那一支是零覆盖。
  // ═══════════════════════════════════════════════════════════════════════════

  describe('熔断、降级与读端裁决', () => {
    it('连续 3 轮采集全部失败 → 熔断并显式降级为收盘档, 且不清空既有实时价', async () => {
      // 最后一次成功采集的时刻已越过新鲜度闸 —— 这不是巧合而是判据: 熔断窗口 = 3 × T =
      // 新鲜度闸 ⇒「熔断打开」与「数据被判陈旧」同刻发生。
      const capturedAt = staleInstant();
      await seedAnchor('us:AOS', {
        intradayPrice: '30',
        intradayAt: capturedAt,
        lastClose: '45',
        lastCloseDate: dayOf(capturedAt),
      });
      await givenUsRegularTradingDay();
      realtimeQuotePort.failWith = new Error('mock realtime source down');

      const streaks: number[] = [];
      const circuits: string[] = [];
      for (let round = 0; round < INTRADAY_CIRCUIT_THRESHOLD; round += 1) {
        const outcome = ticked(await scheduler.run(NOW));
        expect(outcome.verdict).toBe('failure');
        streaks.push(outcome.failstreak);
        circuits.push(outcome.circuit);
      }

      expect(streaks).toEqual(Array.from({ length: INTRADAY_CIRCUIT_THRESHOLD }, (_, i) => i + 1));
      // 阈值之前**不**跳闸, 到第 3 轮才 open（少一轮就熔断 = 一次网络抖动即降级）。
      expect(circuits.slice(0, -1).every((c) => c === 'closed')).toBe(true);
      expect(circuits.at(-1)).toBe('open');
      expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBe('open');

      // 🚨 熔断是**降级**不是**清除**: 两列原样保留（清空会把「陈旧但可用」误降成「不可用」）。
      const row = await rowOf('us:AOS');
      expect(row.intradayPrice?.toString()).toBe('30');
      expect(row.intradayAt?.toISOString()).toBe(capturedAt.toISOString());

      // 「显式降级为收盘档」在读端兑现: 距 W% 由收盘价算出, 不是 0、不是空。
      const view = viewOf(await getRadar.execute(), 'us:AOS');
      expect(view.spot.priceKind).toBe('eod_close');
      expect(view.spot.price?.toString()).toBe('45');
      expect(view.distanceToWPct?.toFixed(4)).toBe(computeDistanceToWPct(V, '45')?.toFixed(4));
    });

    it('熔断后首次采集成功 → 自动恢复实时档, 不需要人工介入', async () => {
      await seedAnchor('us:AOS', {
        lastClose: '45',
        lastCloseDate: dayOf(new Date()),
      });
      await givenUsRegularTradingDay();
      await tripCircuit();
      expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBe('open');

      // open 态**不另设跳闸** —— 每拍仍探一次源, 成功即回升（无人工干预入口）。
      realtimeQuotePort.failWith = null;
      const recoveredAt = new Date();
      realtimeQuotePort.quotes.set('us:AOS', { price: '33', capturedAt: recoveredAt });
      const recovered = ticked(await scheduler.run(NOW));

      expect(recovered.verdict).toBe('success');
      expect(recovered.failstreak).toBe(0);
      expect(recovered.circuit).toBe('closed');
      expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBe('closed');
      expect(await redis.get(INTRADAY_FAILSTREAK_KEY)).toBe('0');

      const view = viewOf(await getRadar.execute(), 'us:AOS');
      expect(view.spot.priceKind).toBe('realtime');
      expect(view.spot.price?.toString()).toBe('33');
      expect(view.spot.asOf).toBe(recoveredAt.toISOString());
    });

    it('实时价存在 且 采集时刻在新鲜度闸内 → 排序与呈现用实时价并标实时档', async () => {
      const freshAt = new Date();
      const closeDate = dayOf(freshAt);
      // 前提写成断言: 两只锚的**收盘价**都在 W 上方（收盘口径下会判成「全体不动区」），
      // 而 FLIP 的盘中价已跌破 W ⇒ 两个口径给出相反的次序与相反的空态。
      expect(computeDistanceToWPct(V, '45')?.isPositive()).toBe(true);
      expect(computeDistanceToWPct(V, '41')?.isPositive()).toBe(true);
      expect(computeDistanceToWPct(V, '30')?.isNegative()).toBe(true);
      await seedAnchor('us:FLIP', {
        intradayPrice: '30',
        intradayAt: freshAt,
        lastClose: '45',
        lastCloseDate: closeDate,
      });
      await seedAnchor('us:HOLD', {
        intradayPrice: '44',
        intradayAt: freshAt,
        lastClose: '41',
        lastCloseDate: closeDate,
      });

      const page = await getRadar.execute();

      // 按收盘价排会是 HOLD(+2.5) 在前、FLIP(+12.5) 在后 —— 实际次序与它**相反**。
      expect(tickersOf(page)).toEqual(['us:FLIP', 'us:HOLD']);
      for (const item of page.items) {
        expect(item.spot.priceKind).toBe('realtime');
        // 档位不上屏, 由 `asOf` 的**粒度**表达: 实时档是时刻。
        expect(item.spot.asOf).toBe(freshAt.toISOString());
      }
      const flip = viewOf(page, 'us:FLIP');
      expect(flip.spot.price?.toString()).toBe('30');
      expect(flip.distanceToWPct?.toFixed(4)).toBe(computeDistanceToWPct(V, '30')?.toFixed(4));
      // 🚨 空态计数走同一条 spot 口径: 收盘口径下这里会是 `all_idle`（横幅说「一个都没有」,
      // 底下的行却是红色负距 W%）—— 同一份响应里两个口径回答同一个问题。
      expect(page.emptyState).toBeNull();
    });

    it('实时价存在 但 采集时刻超出新鲜度闸 → 回落收盘价并标收盘档, 不用陈旧实时价', async () => {
      const staleAt = staleInstant();
      const closeDate = dayOf(staleAt);
      await seedAnchor('us:STALE', {
        intradayPrice: '30',
        intradayAt: staleAt,
        lastClose: '45',
        lastCloseDate: closeDate,
      });

      const page = await getRadar.execute();
      const view = viewOf(page, 'us:STALE');
      expect(view.spot.priceKind).toBe('eod_close');
      expect(view.spot.price?.toString()).toBe('45');
      // 收盘档的 `asOf` 是**交易日**（不含时刻）—— 界面靠这个粒度差表达档位。
      expect(view.spot.asOf).toBe(isoDay(closeDate));
      expect(view.spot.asOf).not.toContain('T');
      expect(view.distanceToWPct?.toFixed(4)).toBe(computeDistanceToWPct(V, '45')?.toFixed(4));

      // 陈旧的 30 若被采信, 这只锚会被判「跌破 W」—— 筛选 / 排序 / 空态是同一条 SQL 口径。
      const below = await getRadar.execute({ filter: { belowW: true } });
      expect(tickersOf(below)).toEqual([]);
      expect(page.emptyState).toBe('all_idle');
    });

    it('锚既无实时价也无收盘价（刚建成、尚未经历任何采集）→ 距 W% 显式为空, 不为 0, 且不因空值被排到榜首或榜尾造成误读', async () => {
      const freshAt = new Date();
      await seedAnchor('us:BELOW', { intradayPrice: '30', intradayAt: freshAt });
      await seedAnchor('us:ABOVE', { lastClose: '45', lastCloseDate: dayOf(freshAt) });
      await seedAnchor('us:NEW'); // 两价皆无

      const page = await getRadar.execute();

      const fresh = viewOf(page, 'us:NEW');
      // `null` 而非 `0`: 0 在距 W% 里是「正好在带上」这个有意义的强信号。
      expect(fresh.distanceToWPct).toBeNull();
      expect(fresh.spot.price).toBeNull();
      expect(fresh.spot.asOf).toBeNull();
      expect(fresh.zone).toBeNull();
      // `NULLS LAST`: 空值排在两只有价锚之后, 既没被当成 0 顶到榜首, 也没被整行剔除。
      expect(tickersOf(page)).toEqual(['us:BELOW', 'us:ABOVE', 'us:NEW']);
    });

    it('锚所属市场不在实时支持范围内（港股 / A 股）→ 该锚恒为收盘档, 不表现为故障、不静默返回空', async () => {
      const closeDate = dayOf(new Date());
      await seedAnchor('hk:00700', { lastClose: '45', lastCloseDate: closeDate });
      marketStatePort.sessions = [{ market: 'hk', session: 'regular' }];
      await seedTradingDay('hk', HK_DATE);

      const incrSpy = vi.spyOn(redis, 'incr');
      try {
        // 连跑到**超过**熔断阈值：「只要库里存在一只 hk 锚, 90 秒后 circuit open 把 us 一起
        // 降级」是今天就会发生的故障（hk 锚合法且随时可建）。
        for (let round = 0; round <= INTRADAY_CIRCUIT_THRESHOLD; round += 1) {
          const outcome = ticked(await scheduler.run(NOW));
          expect(outcome.verdict).toBe('no-attempt');
          expect(outcome.circuit).toBe('closed');
          expect(outcome.failstreak).toBe(0);
          expect(marketOf(outcome.report, 'hk')).toEqual({
            market: 'hk',
            status: 'unsupported-market',
            registeredMarkets: ['us'],
          });
          expect(outcome.report.unsupportedMarkets).toEqual(['hk']);
        }
        // 🚨 比「circuit 保持 closed」更强的回归钉: 失败计数键**一次都没被碰过** ——
        // 「该市场没接实时源」是配置事实, 与「接了但调不通」是两件事。
        expect(incrSpy).not.toHaveBeenCalled();
      } finally {
        incrSpy.mockRestore();
      }
      expect(await redis.get(INTRADAY_FAILSTREAK_KEY)).toBeNull();
      expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBeNull();

      // 不静默返回空: 它照常在雷达上与其他锚**并列可比**（收盘档 + 可用的距 W%）。
      await seedAnchor('us:AOS', { lastClose: '41', lastCloseDate: closeDate });
      const page = await getRadar.execute();
      expect([...tickersOf(page)].sort()).toEqual(['hk:00700', 'us:AOS']);
      const hk = viewOf(page, 'hk:00700');
      expect(hk.spot.priceKind).toBe('eod_close');
      expect(hk.spot.price?.toString()).toBe('45');
      expect(hk.distanceToWPct).not.toBeNull();
    });

    it('收盘后一段时间内实时价与收盘价同时「都是今天的」→ 由新鲜度闸单点裁决用哪个, 不在两值之间抖动', async () => {
      const staleAt = staleInstant();
      const closeDate = dayOf(staleAt);
      // 本分支的前提写成断言: 两个价确实「都是今天的」—— 日粒度分不出胜负, 只有闸能裁决。
      expect(isoDay(staleAt)).toBe(isoDay(closeDate));
      await seedAnchor('us:AOS', {
        intradayPrice: '44',
        intradayAt: staleAt,
        lastClose: '45',
        lastCloseDate: closeDate,
      });

      const pick = (page: RadarPage) => {
        const view = viewOf(page, 'us:AOS');
        return {
          priceKind: view.spot.priceKind,
          price: view.spot.price?.toString() ?? null,
          asOf: view.spot.asOf,
          distance: view.distanceToWPct?.toFixed(4) ?? null,
          order: tickersOf(page),
        };
      };

      const first = pick(await getRadar.execute());
      const second = pick(await getRadar.execute());

      // 单点裁决 ⇒ 同一批数据连查两次必得同一结果（不在两个来源之间抖）。
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        priceKind: 'eod_close',
        price: '45',
        asOf: isoDay(closeDate),
      });
    });
  });
});
