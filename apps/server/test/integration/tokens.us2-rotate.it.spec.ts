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

// US2 Independent Test: 持 refresh token 轮换 → 旧撤/新 active/血缘继承/IP 更新/+30d;
// 重放已轮换 token → 401 (单次使用)。
describe('US2 refresh 轮换 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us2-rot-jwt-secret-min-32-bytes-pad-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'us2-rot-hmac-secret-min-32-bytes-pad-zzzz';

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

  function refresh(refreshToken: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/accounts/refresh-token',
      payload: { refreshToken },
    });
  }

  it('200 新 tokens; DB 旧 revokedAt 置 + 新 active + device 血缘继承 + IP 本次 + +30d', async () => {
    const phone = '+8613800141001';
    const acc = await prisma.account.create({ data: { phone, status: 'ACTIVE' } });
    const loginBody = await login(phone, { 'x-device-id': 'dev-rot-it' });

    const before = Date.now();
    const res = await refresh(loginBody.refreshToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountId).toBe(acc.id.toString());
    expect(body.accessToken).toContain('.');
    expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.refreshToken).not.toBe(loginBody.refreshToken);

    const rows = await prisma.refreshToken.findMany({
      where: { accountId: acc.id },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    const [oldRow, newRow] = rows;
    expect(oldRow!.revokedAt).not.toBeNull(); // 旧撤
    expect(newRow!.revokedAt).toBeNull(); // 新 active
    expect(newRow!.tokenHash).toBe(hashRefreshToken(body.refreshToken));
    expect(newRow!.deviceId).toBe('dev-rot-it'); // 血缘继承自 login row
    expect(newRow!.deviceType).toBe(oldRow!.deviceType);
    expect(newRow!.loginMethod).toBe('PHONE_SMS');
    expect(newRow!.ipAddress).toBeNull(); // 轮换请求 loopback → scrubPrivateIp null
    const exp = newRow!.expiresAt.getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000 - 10_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000 + 10_000);
  });

  it('单次使用: 重放已轮换的 token → 401', async () => {
    const phone = '+8613800141002';
    await prisma.account.create({ data: { phone, status: 'ACTIVE' } });
    const loginBody = await login(phone);

    const first = await refresh(loginBody.refreshToken);
    expect(first.statusCode).toBe(200);

    const replay = await refresh(loginBody.refreshToken);
    expect(replay.statusCode).toBe(401);
  });
});
