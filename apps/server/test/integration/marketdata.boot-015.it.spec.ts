import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app/app.module';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { LocalInstrumentSearchAdapter } from '../../src/marketdata/local-instrument-search.adapter';
import { INSTRUMENT_SEARCH_PORT } from '../../src/marketdata/instrument-search.port';
import { INSTRUMENT_UNIVERSE_PORT } from '../../src/marketdata/instrument-universe.port';
import { TRADING_CALENDAR_PORT } from '../../src/marketdata/trading-calendar.port';
import { EOD_BAR_PORT } from '../../src/marketdata/eod-bar.port';
import { FUNDAMENTAL_PORT } from '../../src/marketdata/fundamental.port';
import { FINANCIALS_PORT } from '../../src/marketdata/financials.port';
import { CORPORATE_ACTION_PORT } from '../../src/marketdata/corporate-action.port';
import { QUOTE_PORT } from '../../src/marketdata/quote.port';

// SEARCH 不在此列 — kind=mock 下解析 LocalInstrumentSearchAdapter (直查 Instrument 表)。
const MOCK_PORTS = [
  INSTRUMENT_UNIVERSE_PORT,
  TRADING_CALENDAR_PORT,
  EOD_BAR_PORT,
  FUNDAMENTAL_PORT,
  FINANCIALS_PORT,
  CORPORATE_ACTION_PORT,
  QUOTE_PORT,
] as const;

// 015 T004 PR1 boot IT (Testcontainers PG+Redis 全 boot):
//  ① 零 env (MARKETDATA_PROVIDER unset) → 事实端口全解析 Mock adapter (SEARCH → 本地
//    pg_trgm adapter), boot 成功, 各端口可调返 fixture
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

  it('零 env: 事实端口解析 Mock 单例, SEARCH 解析本地 pg_trgm adapter', () => {
    for (const port of MOCK_PORTS) {
      expect(moduleRef.get(port)).toBeInstanceOf(MockMarketDataAdapter);
    }
    expect(moduleRef.get(INSTRUMENT_SEARCH_PORT)).toBeInstanceOf(LocalInstrumentSearchAdapter);
  });

  it('零 env: 各端口可调返确定性 fixture', async () => {
    // SEARCH 直查 Instrument 表 — 未 seed → 空数组 (非 error), 验端口可调。
    const search = moduleRef.get<LocalInstrumentSearchAdapter>(INSTRUMENT_SEARCH_PORT);
    expect(await search.search('600519')).toEqual([]);

    const quote = moduleRef.get<MockMarketDataAdapter>(QUOTE_PORT);
    const quotes = await quote.getQuotes(['cn:600519']);
    expect(quotes[0]).toMatchObject({ symbol: 'cn:600519', hasData: true, priceKind: 'eod_close' });

    const bars = moduleRef.get<MockMarketDataAdapter>(EOD_BAR_PORT);
    expect(await bars.getBars({ symbol: 'cn:600519', adjust: 'none' })).toHaveLength(1);
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
