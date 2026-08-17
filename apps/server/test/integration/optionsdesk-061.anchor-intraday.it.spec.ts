import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import {
  SyncAnchorIntradayScheduler,
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
});
