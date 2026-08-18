import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app/app.module';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { MockCollectionRefusedError } from '../../src/marketdata/refusing-collection.adapter';
import { LocalInstrumentSearchAdapter } from '../../src/marketdata/local-instrument-search.adapter';
import { INSTRUMENT_SEARCH_PORT } from '../../src/marketdata/instrument-search.port';
import { INSTRUMENT_UNIVERSE_PORT } from '../../src/marketdata/instrument-universe.port';
import { TRADING_CALENDAR_PORT } from '../../src/marketdata/trading-calendar.port';
import { TRADING_CALENDAR_SOURCE } from '../../src/marketdata/trading-calendar-source.port';
import { COMPANY_PROFILE_PORT } from '../../src/marketdata/company-profile.port';
import { EOD_BAR_PORT } from '../../src/marketdata/eod-bar.port';
import { UNDERLYING_IV_PORT } from '../../src/marketdata/underlying-iv.port';
import { US_INDEX_PORT } from '../../src/marketdata/us-index.port';
import { FUNDAMENTAL_PORT } from '../../src/marketdata/fundamental.port';
import { FINANCIALS_PORT } from '../../src/marketdata/financials.port';
import { CORPORATE_ACTION_PORT } from '../../src/marketdata/corporate-action.port';
import { SHORT_SELLING_PORT } from '../../src/marketdata/short-selling.port';
import { CONNECT_HOLDING_PORT } from '../../src/marketdata/connect-holding.port';
import { FUND_HOLDING_PORT } from '../../src/marketdata/fund-holding.port';
import { FUND_COMPANY_HOLDING_PORT } from '../../src/marketdata/fund-company-holding.port';
import { INDEX_MEMBERSHIP_PORT } from '../../src/marketdata/index-membership.port';
import { VOLATILITY_PORT } from '../../src/marketdata/volatility.port';
import { HOT_SNAPSHOT_PORT } from '../../src/marketdata/hot-snapshot.port';
import { BUYBACK_PORT } from '../../src/marketdata/buyback.port';
import { EQUITY_CHANGE_PORT } from '../../src/marketdata/equity-change.port';
import { SHAREHOLDER_CHANGE_PORT } from '../../src/marketdata/shareholder-change.port';
import { ALLOTMENT_PORT } from '../../src/marketdata/allotment.port';
import { REVENUE_SEGMENT_PORT } from '../../src/marketdata/revenue-segment.port';
import { SHAREHOLDER_SNAPSHOT_PORT } from '../../src/marketdata/shareholder-snapshot.port';
import { EMPLOYEE_PORT } from '../../src/marketdata/employee.port';
import { INDUSTRY_CLASSIFICATION_PORT } from '../../src/marketdata/industry-classification.port';
import { ANNOUNCEMENT_PORT } from '../../src/marketdata/announcement.port';
import { OPTION_CHAIN_PORT } from '../../src/marketdata/option-chain.port';
import { OPTION_SNAPSHOT_PORT } from '../../src/marketdata/option-snapshot.port';
import { EARNINGS_CALENDAR_PORT } from '../../src/marketdata/earnings-calendar.port';
import { QUOTE_PORT } from '../../src/marketdata/quote.port';

// 054: mock 下**继续**绑 MockMarketDataAdapter 的端口 — 只有读取口 + 闸口, 它们不写库。
//  · QUOTE_PORT           读取口 (get-quotes.usecase 零 prisma. 引用, 实证只读)
//  · TRADING_CALENDAR_PORT 闸口 (形态是读; 拒了它 dev 下 freshness-sla 这类只读检查全起不来,
//                          违 FR-009 ⇒ 留 mock, 写手在下一步撞采集口, 结果同为零写库)
// SEARCH 不在此列 — kind=mock 下解析 LocalInstrumentSearchAdapter (直查 Instrument 表)。
const READ_PORTS = [TRADING_CALENDAR_PORT, QUOTE_PORT] as const;

// 054 T002: mock 下绑**拒绝壳**的采集口 **全集 28 个** (token, 用来验拒的方法名) —— 它们的
// 产出必然被持久化, 给 fixture 就等于伪造行情落进真表。
//
// 🚨 **为什么必须逐条列全, 而不是抽查几个**: SC-004 的原文是「已知每条走 vendor 且写库的
// 定时路径都被覆盖, 没有『只修了撞到的那一条』的遗留」—— 改了 28 个绑定却只验 5 个, 正是
// SC-004 要禁止的形态在判据层的复现。
//
// 📌 **手列清单会 stale, 这是蓄意接受的**: 有人加第 29 个采集口时它不会自动跟上。防再入靠
// `marketdata.module.ts` 的 `collectionPort` helper —— 新采集口照抄邻居即自动拿到拒绝壳,
// 压根不需要本清单跟上。本表的职责仅限于**证明本次 28 个确实改全了**。
const COLLECTION_PORTS: ReadonlyArray<readonly [symbol, string]> = [
  [INSTRUMENT_UNIVERSE_PORT, 'enumerate'],
  [COMPANY_PROFILE_PORT, 'resolveCompanyTypes'],
  [TRADING_CALENDAR_SOURCE, 'fetchTradingDates'],
  [EOD_BAR_PORT, 'getBars'],
  [UNDERLYING_IV_PORT, 'getIvSnapshots'],
  [US_INDEX_PORT, 'getIndexHistory'],
  [FUNDAMENTAL_PORT, 'getFundamentals'],
  [FINANCIALS_PORT, 'getFinancials'],
  [CORPORATE_ACTION_PORT, 'getCorporateActions'],
  [SHORT_SELLING_PORT, 'getShortSellingRange'],
  [CONNECT_HOLDING_PORT, 'getConnectHoldingRange'],
  [FUND_HOLDING_PORT, 'getFundHoldingRange'],
  [FUND_COMPANY_HOLDING_PORT, 'getFundCompanyHoldingRange'],
  [INDEX_MEMBERSHIP_PORT, 'getIndexMembership'],
  [VOLATILITY_PORT, 'getVolatilityRange'],
  [HOT_SNAPSHOT_PORT, 'getHotSnapshot'],
  [BUYBACK_PORT, 'getBuybackRange'],
  [EQUITY_CHANGE_PORT, 'getEquityChangeRange'],
  [SHAREHOLDER_CHANGE_PORT, 'getShareholderChangeRange'],
  [ALLOTMENT_PORT, 'getAllotmentRange'],
  [REVENUE_SEGMENT_PORT, 'getRevenueSegmentRange'],
  [SHAREHOLDER_SNAPSHOT_PORT, 'getShareholderSnapshotRange'],
  [EMPLOYEE_PORT, 'getEmployeeRange'],
  [INDUSTRY_CLASSIFICATION_PORT, 'getIndustryClassification'],
  [ANNOUNCEMENT_PORT, 'getAnnouncementRange'],
  [OPTION_CHAIN_PORT, 'getExpiryDates'],
  [OPTION_SNAPSHOT_PORT, 'getSnapshots'],
  [EARNINGS_CALENDAR_PORT, 'getWindow'],
];

// 015 T004 PR1 boot IT (Testcontainers PG+Redis 全 boot):
//  ① 零 env (MARKETDATA_PROVIDER unset) → 读取口解析 Mock adapter (SEARCH → 本地
//    pg_trgm adapter), 采集口解析拒绝壳 (054), boot 成功
//  ② kind=live 缺 LIXINGER_TOKEN → ConfigModule load 抛 zod 错 (boot fail-fast, 不静默降级)
// 验 MarketdataModule 接线 + ADR-0047 config-driven DI 工厂 (spec state_branch
// 「mock default」「config fail-fast」)。
describe('015 marketdata module boot (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'marketdata-boot-015-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'marketdata-boot-015-hmac-secret-min-32-byte';
    delete process.env.MARKETDATA_PROVIDER; // 零 env → mock default

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  it('零 env: 读取口解析 Mock 单例, SEARCH 解析本地 pg_trgm adapter', () => {
    for (const port of READ_PORTS) {
      expect(moduleRef.get(port)).toBeInstanceOf(MockMarketDataAdapter);
    }
    expect(moduleRef.get(INSTRUMENT_SEARCH_PORT)).toBeInstanceOf(LocalInstrumentSearchAdapter);
  });

  // 054 state_branch 4/5 的采集侧: mock 下采集口**不给数据**, 一调即抛专属错误。
  // 🚨 boot 本身能走到这里就已经是一条断言 —— 拒绝壳若对 Nest 的 lifecycle 探测
  // (isFunction(instance.onModuleInit)) 返回函数, 上面的 app.init() 会当场崩。
  it('零 env: 采集口解析拒绝壳 — 调用即抛, 不返回伪造数据 (054 FR-004)', () => {
    // 计数断言 = 「28 个绑定改全了」的显式快照 (T002 / SC-004)。数字变了要么是新增采集口
    // (照抄邻居即自动拒, 只需补进本表), 要么是有人把某个口挪出了 collectionPort —— 后者
    // 必须在 review 里给出判据, 与 QUOTE / TRADING_CALENDAR 那两条同等对待。
    expect(COLLECTION_PORTS).toHaveLength(28);

    for (const [token, method] of COLLECTION_PORTS) {
      const port = moduleRef.get<Record<string, () => unknown>>(token);
      expect(port).not.toBeInstanceOf(MockMarketDataAdapter);
      expect(() => port[method]()).toThrow(MockCollectionRefusedError);
    }
  });

  it('零 env: 读取口可调返确定性 fixture (dev 只读能力零回归, FR-009)', async () => {
    // SEARCH 直查 Instrument 表 — 未 seed → 空数组 (非 error), 验端口可调。
    const search = moduleRef.get<LocalInstrumentSearchAdapter>(INSTRUMENT_SEARCH_PORT);
    expect(await search.search('600519')).toEqual([]);

    const quote = moduleRef.get<MockMarketDataAdapter>(QUOTE_PORT);
    const quotes = await quote.getQuotes(['cn:600519']);
    expect(quotes[0]).toMatchObject({ symbol: 'cn:600519', hasData: true, priceKind: 'eod_close' });

    // 闸口: 拒了它 freshness-sla 这类只读检查在 dev 下全起不来 (FR-009 的具体所指)。
    const calendar = moduleRef.get<MockMarketDataAdapter>(TRADING_CALENDAR_PORT);
    expect(await calendar.classify('cn', '2026-08-12')).toBe('trading'); // 周三
  });

  it('config fail-fast: kind=live 缺 LIXINGER_TOKEN → boot 抛 (不静默降级)', async () => {
    const saved = process.env.MARKETDATA_PROVIDER;
    const savedToken = process.env.LIXINGER_TOKEN;
    process.env.MARKETDATA_PROVIDER = 'live';
    delete process.env.LIXINGER_TOKEN;
    try {
      await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow();
    } finally {
      if (saved === undefined) delete process.env.MARKETDATA_PROVIDER;
      else process.env.MARKETDATA_PROVIDER = saved;
      if (savedToken !== undefined) process.env.LIXINGER_TOKEN = savedToken;
    }
  });
});
