import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { hashRefreshToken } from '../../src/security/refresh-token-hasher';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// US1 Independent Test: 登录成功 → DB 落 1 条 active refresh-token 行 (逐字段)。
// 带 X-Device-Id vs 不带 (service 回退 uuid v4) 两路。
describe('US1 签发即持久化 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'tokens-e2e-jwt-secret-min-32-bytes-pad-abcd';
    process.env.SMS_CODE_HMAC_SECRET = 'tokens-e2e-hmac-secret-min-32-bytes-pad-zzz';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    mockSms = moduleRef.get<MockSmsGateway>(SMS_GATEWAY);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  async function login(phone: string, headers?: Record<string, string>) {
    await app.inject({ method: 'POST', url: '/api/v1/accounts/sms-codes', payload: { phone } });
    const code = mockSms.getLastCode(phone);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      headers,
      payload: { phone, code },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accountId: string; accessToken: string; refreshToken: string };
  }

  it('带 X-Device-Id: DB 新增 1 active 行, tokenHash=hash(返回 token) / accountId / loginMethod=PHONE_SMS / revokedAt=null / expiresAt≈+30d / deviceId=头值 / 回环 IP→null', async () => {
    const phone = '+8613800140001';
    const acc = await prisma.account.create({ data: { phone, status: 'ACTIVE' } });

    const before = Date.now();
    const body = await login(phone, { 'x-device-id': 'device-header-1' });
    expect(body.accountId).toBe(acc.id.toString());

    const rows = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tokenHash).toBe(hashRefreshToken(body.refreshToken));
    expect(row.revokedAt).toBeNull();
    expect(row.deviceId).toBe('device-header-1');
    expect(row.loginMethod).toBe('PHONE_SMS');
    expect(row.ipAddress).toBeNull(); // app.inject remoteAddress 127.0.0.1 → scrubPrivateIp null
    const expiresMs = row.expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000 - 10_000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000 + 10_000);
  });

  it('不带 X-Device-Id: service 回退生成 uuid v4 deviceId', async () => {
    const phone = '+8613800140002';
    const acc = await prisma.account.create({ data: { phone, status: 'ACTIVE' } });

    const body = await login(phone);
    expect(body.accountId).toBe(acc.id.toString());

    const rows = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deviceId).toMatch(UUID_V4);
  });
});
