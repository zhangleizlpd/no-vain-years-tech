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
import { EOD_BAR_PORT } from '../../src/marketdata/eod-bar.port';
import { FUNDAMENTAL_PORT } from '../../src/marketdata/fundamental.port';
import { FINANCIALS_PORT } from '../../src/marketdata/financials.port';
import { CORPORATE_ACTION_PORT } from '../../src/marketdata/corporate-action.port';
import { QUOTE_PORT } from '../../src/marketdata/quote.port';

// 054: mock 下**继续**绑 MockMarketDataAdapter 的端口 — 只有读取口 + 闸口, 它们不写库。
//  · QUOTE_PORT           读取口 (get-quotes.usecase 零 prisma. 引用, 实证只读)
//  · TRADING_CALENDAR_PORT 闸口 (形态是读; 拒了它 dev 下 freshness-sla 这类只读检查全起不来,
//                          违 FR-009 ⇒ 留 mock, 写手在下一步撞采集口, 结果同为零写库)
// SEARCH 不在此列 — kind=mock 下解析 LocalInstrumentSearchAdapter (直查 Instrument 表)。
const READ_PORTS = [TRADING_CALENDAR_PORT, QUOTE_PORT] as const;

// 054: mock 下绑**拒绝壳**的采集口 (token, 用来验拒的方法名) — 它们的产出必然被持久化,
// 给 fixture 就等于伪造行情落进真表。本表只列 015 当年就在的 5 个; **28 个全集**的逐条
// 断言在 T002 (SC-004 要的是「没有只修了撞到的那一条」)。
const COLLECTION_PORTS: ReadonlyArray<readonly [symbol, string]> = [
  [INSTRUMENT_UNIVERSE_PORT, 'enumerate'],
  [EOD_BAR_PORT, 'getBars'],
  [FUNDAMENTAL_PORT, 'getFundamentals'],
  [FINANCIALS_PORT, 'getFinancials'],
  [CORPORATE_ACTION_PORT, 'getCorporateActions'],
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
    expect(await calendar.isTradingDay('cn', '2026-08-12')).toBe(true); // 周三
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
