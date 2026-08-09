import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PortfolioModule } from '../../src/portfolio/portfolio.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';

// 011 T007 US1 Independent Test (FR-S01/S02/S06): authed GET → 核心投影默认 + 海外元信息
// + GET 零写库; 预置态读回; 缺 token / 非 ACTIVE → 401 反枚举 (与 /me 一致路径)。
// 全 boot (PG + Redis + Fastify) 亦验 PortfolioModule 接线 + throttler 注册。
describe('US1 市场偏好读取 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'mkt-us1-get-jwt-secret-min-32-bytes-pad-ab';
    process.env.SMS_CODE_HMAC_SECRET = 'mkt-us1-get-hmac-secret-min-32-bytes-pad-z';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([PortfolioModule]),
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  const nextPhone = () => `+8613802${String(++seq).padStart(6, '0')}`;
  const activeAccount = () =>
    prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
  const getPrefs = (token?: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/portfolio/market-preferences',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  type MarketItem = {
    marketCode: string;
    group: string;
    v1Available: boolean;
    active: boolean;
    isoCurrency: string;
  };
  const byCode = (body: { markets: MarketItem[] }) =>
    Object.fromEntries(body.markets.map((m) => [m.marketCode, m]));

  it('新账号 (无偏好行) → 200 核心默认 {cn:active, hk/us:inactive} + 海外元信息 + GET 零写库', async () => {
    const acc = await activeAccount();
    const res = await getPrefs(jwt.signAccessToken({ accountId: acc.id }));
    expect(res.statusCode).toBe(200);

    const body = res.json() as { markets: MarketItem[] };
    expect(body.markets).toHaveLength(9);
    const m = byCode(body);
    expect(m['cn'].active).toBe(true);
    expect(m['hk'].active).toBe(false);
    expect(m['us'].active).toBe(false);

    const overseas = body.markets.filter((x) => x.group === 'overseas');
    expect(overseas).toHaveLength(6);
    for (const o of overseas) {
      expect(o.v1Available).toBe(false);
      expect(o.active).toBe(false);
      expect(typeof o.isoCurrency).toBe('string');
    }

    // GET 零写库 (FR-S01/D4)
    const count = await prisma.portfolioPreference.count({ where: { accountId: acc.id } });
    expect(count).toBe(0);
  });

  it('预置激活集 {cn,hk} → GET 返回持久化态', async () => {
    const acc = await activeAccount();
    await prisma.portfolioPreference.create({
      data: { accountId: acc.id, activeMarkets: ['cn', 'hk'] },
    });
    const res = await getPrefs(jwt.signAccessToken({ accountId: acc.id }));
    const m = byCode(res.json() as { markets: MarketItem[] });
    expect(m['cn'].active).toBe(true);
    expect(m['hk'].active).toBe(true);
    expect(m['us'].active).toBe(false);
  });

  it('缺 token → 401 ProblemDetail (反枚举)', async () => {
    const res = await getPrefs();
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('非 ACTIVE 账号 (FROZEN) → 401 (与缺 token 一致路径, 反枚举不泄露存在性)', async () => {
    const frozen = await prisma.account.create({
      data: { phone: nextPhone(), status: 'FROZEN' },
    });
    const res = await getPrefs(jwt.signAccessToken({ accountId: frozen.id }));
    expect(res.statusCode).toBe(401);
  });
});
