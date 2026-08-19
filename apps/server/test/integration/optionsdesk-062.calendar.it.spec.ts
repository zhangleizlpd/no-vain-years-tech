import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { setupIsolatedStores } from '../_support/isolated-db';
import { marketdataConfig, type MarketdataConfig } from '../../src/config/marketdata.config';
import { PrismaService } from '../../src/security/prisma.service';
import { marketDateFor } from '../../src/marketdata/trading-day-gate';
import {
  REALTIME_QUOTE_PORT,
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
import { ListAnchorsUseCase } from '../../src/optionsdesk/list-anchors.usecase';
import { freshnessTier } from '../../src/marketdata/freshness-tier';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../../src/marketdata/trading-calendar.port';
import {
  SyncAnchorIntradayUseCase,
  type MarketIntradayOutcome,
  type SyncAnchorIntradayReport,
} from '../../src/optionsdesk/sync-anchor-intraday';

/**
 * 062 T008 —— optionsdesk 盘中闸接三态（FR-012 / FR-013 / FR-014 / FR-015 / FR-019 ·
 * spec `state_branch` 5）。
 *
 * ## 这条 IT 验的是「换了取数路径之后，两个闸仍然各就各位」
 *
 * 改造前这里是裸 `prisma.tradingDay.count`：无行 ⇒ 判非交易日 ⇒ 每天 09:30 之前（以及
 * `trading_day` 当日行落库之前的任何时刻）盘中价一拍都不采。改造后走
 * `TRADING_CALENDAR_PORT`（optionsdesk 的**唯一** module 边，061 T008 立），三态各自分派：
 * `non-trading` 才跳过，`unknown` 继续采并留痕（另有 vendor 市场状态闸取交集兜着）。
 *
 * ## 为什么必须真 PG（+ 真 Redis）
 *
 * 被测面是「两张 `@db.Date` 表的实际内容 → 端口 → 闸的开合」。三态按**日期边界**分档，
 * 落库口径差一天就会让 `non-trading` 与 `unknown` 在边界日互换 —— 而那正是本 feature 要
 * 消灭的静默失真，fake 端口证不了它。真 Redis 则是 `SecurityModule` 的 `REDIS_CLIENT`
 * 在 boot 时就要连（本文件不用它，但容器得真的起得来）。
 *
 * ## 🚨🚨 `MARKETDATA_PROVIDER` 在测试里恒钉 `mock`（`vitest.config.ts` 的 `test.env`）
 *
 * `TRADING_CALENDAR_PORT` 的 provider 是 `cfg.kind === 'mock' ? MockMarketDataAdapter : new
 * DbTradingCalendarAdapter(prisma)` —— 不 override `marketdataConfig.KEY` 成 `live`，端口就
 * 恒是 mock 日历（周一~周五即交易日），本文件埋进真库的两张表**一行都不会被读到**，五条用例
 * 会**绿得毫无意义**（061 T009 实测过同一个坑）。这是本文件最容易静默失败的地方。
 *
 * ## 装配方式 = 真 DI 容器（plan「Testing Invariants」第二条）
 *
 * `Test.createTestingModule({ imports: [OptionsdeskModule] })` —— **MUST NOT**
 * `new SyncAnchorIntradayUseCase(...)` 手搓。本 task 改的就是**接线**（裸 Prisma 直查 →
 * 跨 ctx 端口注入），手搓等于把被测对象整个抽掉。**不建 Nest application**：零 HTTP 面，
 * 且不 `init()` 顺带避开 marketdata 的 BullMQ worker（挂在 `onModuleInit`）。
 */

/** ET 12:00（2026-08-12 周三）⇒ us 业务日恒为 08-12，与宿主时区无关（FR-015）。 */
const NOW = new Date('2026-08-12T16:00:00Z');
const US_DATE = marketDateFor(['us'], NOW);

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点。 */
const day = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/** V=50 ⇒ 派生列全部由 rules 求（本文件零档位字面量）。 */
const V = '50';

/**
 * 🚨 live 形状的假 config —— 只为让 `TRADING_CALENDAR_PORT` 绑到真的
 * `DbTradingCalendarAdapter`。两个会被调用的 vendor port 都被 fake 顶掉，零外呼。
 */
const LIVE_CONFIG: MarketdataConfig = {
  kind: 'live',
  lixingerToken: 'it-062-fake-lixinger-token',
  lixingerBaseUrl: 'https://lixinger.invalid/api',
  eastmoneyBaseUrl: 'https://eastmoney.invalid',
  eastmoneyClistBaseUrl: 'https://eastmoney-clist.invalid',
  tencentCalendarBaseUrl: 'https://tencent.invalid',
  futuShimUrl: 'https://futu-shim.invalid',
  futuShimToken: 'it-062-fake-shim-token',
};

interface MarketStateFake extends MarketStatePort {
  sessions: MarketSessionState[];
}

interface RealtimeQuoteFake extends RealtimeQuotePort {
  calls: number;
  quotes: Map<string, RealtimeQuote>;
}

describe('062 T008 optionsdesk 盘中交易日闸三态 (Testcontainers PG + Redis, 真 OptionsdeskModule DI 容器)', () => {
  let moduleRef: TestingModule;
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let prisma: PrismaService;
  let syncIntraday: SyncAnchorIntradayUseCase;
  let createAnchor: CreateAnchorUseCase;
  let listAnchors: ListAnchorsUseCase;

  const marketStatePort: MarketStateFake = {
    sessions: [],
    async getMarketSessions(): Promise<MarketSessionState[]> {
      return marketStatePort.sessions;
    },
  };

  /** `calls` = 「交易日闸真的放行了」的硬证据（被任一闸挡下则恒 0）。 */
  const realtimeQuotePort: RealtimeQuoteFake = {
    calls: 0,
    quotes: new Map<string, RealtimeQuote>(),
    async fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>> {
      realtimeQuotePort.calls += 1;
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
    process.env.AUTH_JWT_SECRET = 'optionsdesk-062-calendar-jwt-secret-min-32b';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-062-calendar-hmac-secret-min32';

    moduleRef = await Test.createTestingModule({
      imports: [
        OptionsdeskModule,
        // 真 app 的全局 ThrottlerModule 注册在 AuthModule；本文件不引 AuthModule，故给同形态
        // 的最小注册让两个 Guard 能真实解析（体例照 `optionsdesk-061.anchor-intraday.it.spec.ts`）。
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
    syncIntraday = moduleRef.get(SyncAnchorIntradayUseCase);
    createAnchor = moduleRef.get(CreateAnchorUseCase);
    listAnchors = moduleRef.get(ListAnchorsUseCase);
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
    await prisma.$executeRawUnsafe('TRUNCATE marketdata.calendar_coverage');
    marketStatePort.sessions = [];
    realtimeQuotePort.calls = 0;
    realtimeQuotePort.quotes.clear();
  });

  // ── fixture helpers ────────────────────────────────────────────────────────

  async function seedAnchor(ticker: string): Promise<void> {
    await createAnchor.execute({
      ticker,
      v: V,
      asof: day('2026-06-30'),
      method: 'dcf',
      confidence: '8', // → L2
      nextReview: day('2099-01-01'),
    });
    realtimeQuotePort.quotes.set(ticker, { price: '36', capturedAt: NOW, vendorUpdateTime: null });
  }

  const seedTradingDay = (market: string, date: string) =>
    prisma.tradingDay.create({ data: { market, date: day(date) } });

  const seedCoverage = (market: string, from: string, to: string) =>
    prisma.calendarCoverage.create({
      data: {
        market,
        coveredFrom: day(from),
        coveredTo: day(to),
        servedBy: 'it-seed',
      },
    });

  function marketOf(report: SyncAnchorIntradayReport, market: string): MarketIntradayOutcome {
    const found = report.markets.find((m) => m.market === market);
    if (found === undefined) {
      throw new Error(`报告里没有 ${market} 组: ${JSON.stringify(report.markets)}`);
    }
    return found;
  }

  // ── ① trading + 常规时段 → 采集（既有 happy path 零回归） ────────────────────

  it('① 当日在日历内 + 状态 regular → 采集, 且留痕标为「已确认」(state_branch 1)', async () => {
    await seedAnchor('us:AOS');
    await seedTradingDay('us', US_DATE);
    await seedCoverage('us', '2026-01-01', US_DATE);
    marketStatePort.sessions = [{ market: 'us', session: 'regular' }];

    const report = await syncIntraday.execute(NOW);

    expect(marketOf(report, 'us')).toMatchObject({ status: 'collected', calendar: 'confirmed' });
    expect(realtimeQuotePort.calls).toBe(1);
    expect(report.updated).toBe(1);
  });

  // ── ② non-trading + 常规时段 → skipped-holiday（既有语义不回归；FR-014） ─────

  it('② 当日不在日历内但覆盖声明含当日 + 状态 regular → skipped-holiday, 0 次外呼 (两闸取交集, state_branch 2)', async () => {
    await seedAnchor('us:AOS');
    // 蓄意**不**塞 trading_day 行, 但把「这一段已经填过了」显式声明出来 ⇒ 确实是节假日。
    // 源侧状态机滞后（节假日仍报 regular）就是这个现场 —— 交易日闸 MUST NOT 被它顶替。
    await seedCoverage('us', '2026-01-01', '2026-12-31');
    marketStatePort.sessions = [{ market: 'us', session: 'regular' }];

    const report = await syncIntraday.execute(NOW);

    expect(marketOf(report, 'us')).toEqual({
      market: 'us',
      status: 'skipped-holiday',
      date: US_DATE,
    });
    expect(realtimeQuotePort.calls).toBe(0);
  });

  // ── ③ unknown + 常规时段 → 采集 + 留痕（FR-012 / FR-013, state_branch 5） ────

  /**
   * 🚨 埋法必须是「覆盖声明只到**昨天**」—— 当日无行且落在声明**之外** ⇒ `unknown`
   * =「还没填到这儿」而不是「填过了确实不是交易日」。埋成「含当日」这条会绿但什么都没验到
   * （Impl Guardrail 14）。
   */
  it('③ 🚨 当日无行 + 覆盖声明只到昨天 + 状态 regular → 照常采集, 且留痕标为「未知」(state_branch 5)', async () => {
    await seedAnchor('us:AOS');
    await seedCoverage('us', '2026-01-01', '2026-08-11'); // 只到昨天 ⇒ 今天是 unknown
    marketStatePort.sessions = [{ market: 'us', session: 'regular' }];

    const report = await syncIntraday.execute(NOW);

    expect(marketOf(report, 'us')).toMatchObject({ status: 'collected', calendar: 'unknown' });
    expect(realtimeQuotePort.calls).toBe(1);
    expect(report.updated).toBe(1);
  });

  /**
   * FR-013 本体：「采是因为确认了交易日」与「采是因为还不知道」两个 outcome **必须可分辨**。
   * 长一样 = 下次同类故障照样查不出，等于没修。
   */
  it('③b 🚨 FR-013: 「因为不知道而采」与「确认交易日才采」两个 outcome MUST NOT 相同', async () => {
    await seedAnchor('us:AOS');
    await seedCoverage('us', '2026-01-01', '2026-08-11');
    marketStatePort.sessions = [{ market: 'us', session: 'regular' }];
    const unknownRun = marketOf(await syncIntraday.execute(NOW), 'us');

    await prisma.$executeRawUnsafe('TRUNCATE marketdata.calendar_coverage');
    await seedTradingDay('us', US_DATE);
    await seedCoverage('us', '2026-01-01', US_DATE);
    const confirmedRun = marketOf(await syncIntraday.execute(NOW), 'us');

    expect(unknownRun.status).toBe('collected');
    expect(confirmedRun.status).toBe('collected');
    const basisOf = (o: MarketIntradayOutcome) => (o as { calendar?: unknown }).calendar;
    expect(basisOf(unknownRun)).not.toBe(basisOf(confirmedRun));
  });

  // ── ④ unknown + 非常规时段 → 仍不采（FR-014 交集语义未被削弱） ───────────────

  it('④ 🚨 unknown + 状态非 regular → 仍不采集 (交集语义: 放宽日历闸 MUST NOT 顺带放宽时段闸)', async () => {
    await seedAnchor('us:AOS');
    await seedCoverage('us', '2026-01-01', '2026-08-11'); // unknown
    marketStatePort.sessions = [{ market: 'us', session: 'other' }];

    const report = await syncIntraday.execute(NOW);

    expect(marketOf(report, 'us')).toEqual({
      market: 'us',
      status: 'skipped-session',
      session: 'other',
    });
    expect(realtimeQuotePort.calls).toBe(0);
  });

  // ── ⑤ 无任何覆盖声明（上线首刻）→ unknown，MUST NOT 整体停摆 ────────────────

  it('⑤ 覆盖声明整表为空 (上线首刻) → 判 unknown 照常采集, MUST NOT 判成节假日 (state_branch 4)', async () => {
    await seedAnchor('us:AOS');
    marketStatePort.sessions = [{ market: 'us', session: 'regular' }];

    const report = await syncIntraday.execute(NOW);

    expect(marketOf(report, 'us')).toMatchObject({ status: 'collected', calendar: 'unknown' });
    expect(realtimeQuotePort.calls).toBe(1);
  });

  // ── T010 陈旧度基准收编端口（state_branch 9 · FR-012 · FR-019） ──────────────

  /**
   * 062 T010 —— `optionsdesk` 的「最近一场已收盘交易日」由 `PrismaService` 直查改注入
   * `TRADING_CALENDAR_PORT`（构造器参数上方挂 `CROSS-CONTEXT-SYNC`）。
   *
   * 🚨 判据多了**一维**：收盘上界落在覆盖声明之外时，库里那个「≤ 上界的最大交易日」不是真的
   * 最近一场（那一段根本没填全）⇒ 端口返 `null` ⇒ 既有 `freshnessTier` fail-open 判当期档。
   * 改造前这里会原样交回那个过期的最大值，把「数据其实是新的」判成陈旧（或反之），**不报错**。
   */
  describe('T010 陈旧度基准（lastClosedSession）', () => {
    /** ET 2026-08-12 12:00 尚未收盘 ⇒ 上界 = 前一日历日 08-11。 */
    const CUTOFF_DAY = '2026-08-11';

    it('④ 基准日在覆盖声明内 → 返该交易日, 档位判定与改前逐一相同 (零回归)', async () => {
      await seedTradingDay('us', CUTOFF_DAY);
      await seedCoverage('us', '2026-01-01', '2026-12-31');

      const calendar = moduleRef.get<TradingCalendarPort>(TRADING_CALENDAR_PORT);
      expect(await calendar.lastClosedSession('us', NOW)).toBe(CUTOFF_DAY);

      // 端到端: 锚视图上的基准与端口同值（消费 use case 真的走了注入的端口）。
      await seedAnchor('us:AOS');
      const anchor = (await listAnchors.execute())[0];
      expect(anchor.lastClosedSession).toBe(CUTOFF_DAY);
      // 基准可信 ⇒ 档位真的分得出来（锚 asof 停在 06-30, 远早于基准日）。
      expect(freshnessTier('2026-06-30', anchor.lastClosedSession)).toBe('STALE');
    });

    it('⑤ 基准日落在覆盖声明之外 → 返 null ⇒ fail-open 判当期档 (state_branch 9)', async () => {
      await seedTradingDay('us', CUTOFF_DAY);
      // 声明只到 08-05 ⇒ 上界 08-11 那一段根本没填全, 库里的 08-11 不可信。
      await seedCoverage('us', '2026-01-01', '2026-08-05');

      const calendar = moduleRef.get<TradingCalendarPort>(TRADING_CALENDAR_PORT);
      // 🚨 MUST NOT 交回 CUTOFF_DAY —— 拿一个不可信的基准日去判陈旧, 档位会悄悄错一档。
      expect(await calendar.lastClosedSession('us', NOW)).toBeNull();

      await seedAnchor('us:AOS');
      const anchor = (await listAnchors.execute())[0];
      expect(anchor.lastClosedSession).toBeNull();
      // 同一份 asof, 基准不可信 ⇒ fail-open 当期档（与上一条对照, 证明这不是平凡绿）。
      expect(freshnessTier('2026-06-30', anchor.lastClosedSession)).toBe('CURRENT');
    });

    it('⑤ 反例: 覆盖声明整体缺失 → 同样返 null (首次上线的形态)', async () => {
      await seedTradingDay('us', CUTOFF_DAY);

      const calendar = moduleRef.get<TradingCalendarPort>(TRADING_CALENDAR_PORT);
      expect(await calendar.lastClosedSession('us', NOW)).toBeNull();
    });
  });
});
