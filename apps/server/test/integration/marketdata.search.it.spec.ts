import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { MarketdataModule } from '../../src/marketdata/marketdata.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { INSTRUMENT_SEARCH_PORT } from '../../src/marketdata/instrument-search.port';
import type { InstrumentSearchPort } from '../../src/marketdata/instrument-search.port';
import type { InstrumentSearchHit } from '../../src/marketdata/marketdata.types';
import { FallbackChainAdapter } from '../../src/marketdata/fallback-chain.adapter';
import { LocalInstrumentSearchAdapter } from '../../src/marketdata/local-instrument-search.adapter';

// 015 T014 搜索端点 (EP1) FallbackChain 全 boot IT (Testcontainers PG+Redis, SC-S02)。三分支:
//  ① 主源(东财)命中 → 归一化 canonical 候选 (短路, 不打本地)
//  ② 主源 503/超时 → FallbackChain 平移本地 pg_trgm (名/拼音/代码命中, 需 Instrument 已 seed)
//  ③ 主源空 + 本地无命中 → 空 items (200, 非 5xx)
//  + 缺 q → 400 / 缺 token → 401。
// 实装: mock 模式整体 boot 干净, overrideProvider 把 SEARCH 端口换成真 FallbackChain(可控
// 假主源 + 真 LocalInstrumentSearchAdapter 读 PG), 精准对准 SUT (FallbackChain + UC + EP1),
// 不引入 live 全 boot 脆弱性。run via `nx test server <file>`。
describe('015 marketdata 搜索端点 EP1 FallbackChain (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let token: string;

  // 可控假主源 (东财占位): 各 test 通过 setPrimary 设其行为 (命中 / 抛错 / 空)。
  let primaryBehavior: (query: string) => Promise<InstrumentSearchHit[]>;
  const setPrimary = (b: (q: string) => Promise<InstrumentSearchHit[]>) => {
    primaryBehavior = b;
  };

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'marketdata-search-jwt-secret-min-32-bytes-ok';
    process.env.SMS_CODE_HMAC_SECRET = 'marketdata-search-hmac-secret-min-32-bytes-x';
    delete process.env.MARKETDATA_PROVIDER; // mock boot 干净 (live 下 universe/calendar notWiredLive 会崩 boot)

    const fakePrimary: InstrumentSearchPort = { search: (q) => primaryBehavior(q) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([MarketdataModule]),
    })
      .overrideProvider(INSTRUMENT_SEARCH_PORT)
      .useFactory({
        factory: (prisma: PrismaService) =>
          new FallbackChainAdapter([fakePrimary, new LocalInstrumentSearchAdapter(prisma)]),
        inject: [PrismaService],
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    const jwt = moduleRef.get(JwtTokenService);
    const acc = await prisma.account.create({
      data: { phone: '+8613810000003', status: 'ACTIVE' },
    });
    token = jwt.signAccessToken({ accountId: acc.id });

    // seed 本地 universe (FallbackChain 次源命中用)。
    await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        type: 'stock',
        currency: 'CNY',
        pinyinAbbr: 'gzmt',
        pinyinFull: 'guizhoumaotai',
        status: 'listed',
      },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(() => {
    // 默认主源空 (各 test 覆盖)。
    setPrimary(async () => []);
  });

  const auth = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('① 主源命中 → 归一化候选 (短路, 不平移本地)', async () => {
    setPrimary(async () => [{ symbol: 'cn:600519', name: '贵州茅台', type: 'stock' }]);

    const res = await auth(`/api/v1/marketdata/search?q=${encodeURIComponent('茅台')}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([{ symbol: 'cn:600519', name: '贵州茅台', type: 'stock' }]);
  });

  it('② 主源 503 → FallbackChain 平移本地 pg_trgm (拼音命中)', async () => {
    setPrimary(async () => {
      throw new Error('eastmoney 503');
    });

    const res = await auth('/api/v1/marketdata/search?q=gzmt');
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toContainEqual({
      symbol: 'cn:600519',
      name: '贵州茅台',
      type: 'stock',
    });
  });

  it('③ 主源空 + 本地无命中 → 空 items (200, 非 5xx)', async () => {
    const res = await auth('/api/v1/marketdata/search?q=zzzznonexistentxyz');
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('缺 q → 400 FORM_VALIDATION', async () => {
    const res = await auth('/api/v1/marketdata/search');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FORM_VALIDATION');
  });

  it('空白 q → 400', async () => {
    const res = await auth('/api/v1/marketdata/search?q=%20%20');
    expect(res.statusCode).toBe(400);
  });

  it('缺 token → 401 (反枚举)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/marketdata/search?q=茅台' });
    expect(res.statusCode).toBe(401);
  });
});
