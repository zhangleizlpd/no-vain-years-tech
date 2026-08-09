import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PortfolioModule } from '../../src/portfolio/portfolio.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';

// 011 T008 US2 Independent Test (FR-S03/S04/S05): 单市场 PUT 持久化 + materialize +
// min-1 拒绝 (态不变) + 海外拒绝 + 未知码 404 + 幂等 + body 校验 + 401。
describe('US2 市场偏好切换 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'mkt-us2-put-jwt-secret-min-32-bytes-pad-ab';
    process.env.SMS_CODE_HMAC_SECRET = 'mkt-us2-put-hmac-secret-min-32-bytes-pad-z';

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

  const nextPhone = () => `+8613803${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  // 预置激活集 {cn} (ADR-0046 单行)。
  const seedOnlyCnyActive = (accountId: bigint) =>
    prisma.portfolioPreference.create({ data: { accountId, activeMarkets: ['cn'] } });
  const activeSet = (accountId: bigint) =>
    prisma.portfolioPreference
      .findUnique({ where: { accountId } })
      .then((r) => new Set(r?.activeMarkets ?? []));

  type MarketItem = { marketCode: string; active: boolean };
  const put = (token: string, market: string, body: object) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/portfolio/market-preferences/${market}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: body,
    });
  const get = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/portfolio/market-preferences',
      headers: { authorization: `Bearer ${token}` },
    });
  const activeOf = (res: { json: () => unknown }, code: string) =>
    (res.json() as { markets: MarketItem[] }).markets.find((m) => m.marketCode === code)?.active;

  it('PUT {hk,true} (预置仅 cn) → 200 持久化 + 激活集 {cn,hk} + GET {cn+hk active}', async () => {
    const { id, token } = await activeToken();
    await seedOnlyCnyActive(id);

    const res = await put(token, 'hk', { active: true });
    expect(res.statusCode).toBe(200);
    expect(activeOf(res, 'hk')).toBe(true);
    expect(activeOf(res, 'cn')).toBe(true);

    expect(await prisma.portfolioPreference.count({ where: { accountId: id } })).toBe(1); // 单行
    expect(await activeSet(id)).toEqual(new Set(['cn', 'hk']));
    const g = await get(token);
    expect(activeOf(g, 'cn')).toBe(true);
    expect(activeOf(g, 'hk')).toBe(true);
  });

  it('续 PUT {cn,false} (hk 仍激活) → 200 满足 min-1', async () => {
    const { id, token } = await activeToken();
    await seedOnlyCnyActive(id);
    await put(token, 'hk', { active: true }); // {cn:t, hk:t, us:f}

    const res = await put(token, 'cn', { active: false });
    expect(res.statusCode).toBe(200);
    expect(activeOf(res, 'cn')).toBe(false);
    expect(activeOf(res, 'hk')).toBe(true);
  });

  it('关最后一个激活 (仅 cn) PUT {cn,false} → 422 MIN_ONE_MARKET_REQUIRED + GET 仍 {cn:active}', async () => {
    const { id, token } = await activeToken();
    await seedOnlyCnyActive(id);

    const res = await put(token, 'cn', { active: false });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('MIN_ONE_MARKET_REQUIRED');

    const g = await get(token);
    expect(activeOf(g, 'cn')).toBe(true); // 态不变
  });

  it('PUT 海外 {jp,true} → 422 MARKET_NOT_AVAILABLE + DB 无海外行', async () => {
    const { id, token } = await activeToken();
    const res = await put(token, 'jp', { active: true });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('MARKET_NOT_AVAILABLE');
    expect(await prisma.portfolioPreference.count({ where: { accountId: id } })).toBe(0); // 字典前拒, 无写库
  });

  it('PUT 未知码 {XXX,true} → 404 MARKET_NOT_FOUND', async () => {
    const { token } = await activeToken();
    const res = await put(token, 'XXX', { active: true });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('MARKET_NOT_FOUND');
  });

  it('幂等: PUT {hk,true} 当 hk 已 active → 200 无重复行', async () => {
    const { id, token } = await activeToken();
    await seedOnlyCnyActive(id);
    await put(token, 'hk', { active: true });
    const res = await put(token, 'hk', { active: true });
    expect(res.statusCode).toBe(200);
    expect(activeOf(res, 'hk')).toBe(true);
    expect(await activeSet(id)).toEqual(new Set(['cn', 'hk'])); // 去重, 无重复
  });

  // FORM_VALIDATION code 由 main.ts exceptionFactory 映射; 此 IT 用简化 pipe 同其他 IT,
  // 仅断状态 (code 在 runtime-smoke 真 boot 验)。
  it('PUT body 缺 active → 400', async () => {
    const { token } = await activeToken();
    const res = await put(token, 'hk', {});
    expect(res.statusCode).toBe(400);
  });

  it('缺 token → 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/portfolio/market-preferences/hk',
      headers: { 'content-type': 'application/json' },
      payload: { active: true },
    });
    expect(res.statusCode).toBe(401);
  });
});
