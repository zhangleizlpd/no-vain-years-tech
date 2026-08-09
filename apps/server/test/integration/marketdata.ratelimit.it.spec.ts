import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { MarketdataModule } from '../../src/marketdata/marketdata.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';

// 015 T009 限流桶边界 IT (Testcontainers PG+Redis 全 boot): marketdata 4 named throttler
// (quote 120/detail 60/bars 60 per 60s, tracker=account)。桶边界 → 429 + Retry-After; 桶间独立
// (detail 耗尽不影响 bars)。每测用新账号隔离桶 (tracker=accountId, 无需 flush Redis)。
// 404 仍计入桶 (guard 先于 handler), 故无需 seed instrument。
describe('015 marketdata 读端点限流桶 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'marketdata-ratelimit-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'marketdata-ratelimit-hmac-secret-min-32-byte';
    delete process.env.MARKETDATA_PROVIDER;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule, MarketdataModule],
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

  const freshToken = async () => {
    const acc = await prisma.account.create({
      data: { phone: `+8613820${String(++seq).padStart(6, '0')}`, status: 'ACTIVE' },
    });
    return jwt.signAccessToken({ accountId: acc.id });
  };
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('详情桶 detail 第 61 次 (60/60s) → 429 + Retry-After', async () => {
    const token = await freshToken();
    let last = await get('/api/v1/marketdata/instruments/cn:600519', token);
    for (let i = 0; i < 60; i += 1)
      last = await get('/api/v1/marketdata/instruments/cn:600519', token);
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('桶间独立: detail 桶耗尽不影响同账号 bars 桶', async () => {
    const token = await freshToken();
    for (let i = 0; i < 61; i += 1) await get('/api/v1/marketdata/instruments/cn:600519', token);
    // detail 已 429, bars 桶独立 → 仍可访问 (未知 symbol 故 404, 但非 429)。
    const bars = await get('/api/v1/marketdata/instruments/cn:600519/bars', token);
    expect(bars.statusCode).toBe(404);
  });

  it('报价桶 quote 第 121 次 (120/60s) → 429 + Retry-After', async () => {
    const token = await freshToken();
    let last = await get('/api/v1/marketdata/quote?symbols=cn:600519', token);
    for (let i = 0; i < 120; i += 1)
      last = await get('/api/v1/marketdata/quote?symbols=cn:600519', token);
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });
});
