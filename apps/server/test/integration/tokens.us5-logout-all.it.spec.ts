import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';

const DAY_MS = 24 * 60 * 60 * 1000;

// US5 Independent Test: logout-all 撤账号全部 active (含当前 device), 幂等 204 +
// 隔离 (已撤记录时间戳不变 / 其他账号不受影响) + 鉴权缺失/无效 → 401 (覆盖 JwtAccessGuard)。
describe('US5 全端登出 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us5-logout-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'us5-logout-hmac-secret-min-32-bytes-pad-z';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
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

  async function seedRow(accountId: bigint, revokedAt: Date | null) {
    seq += 1;
    return prisma.refreshToken.create({
      data: {
        tokenHash: `logout${seq}`.padEnd(64, '0'),
        accountId,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        revokedAt,
        deviceId: `dev-logout-${seq}`,
        loginMethod: 'PHONE_SMS',
      },
    });
  }

  function logoutAll(token?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/accounts/logout-all',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  it('撤 A 全部 active (204) + 幂等 (再次 204) + 隔离 (已撤时间戳不变 / B 不受影响)', async () => {
    const A = await prisma.account.create({ data: { phone: '+8613800143001', status: 'ACTIVE' } });
    const B = await prisma.account.create({ data: { phone: '+8613800143002', status: 'ACTIVE' } });
    const preRevokedAt = new Date('2026-01-01T00:00:00Z');
    const preRevoked = await seedRow(A.id, preRevokedAt);
    await seedRow(A.id, null);
    await seedRow(A.id, null);
    await seedRow(A.id, null);
    await seedRow(B.id, null);
    await seedRow(B.id, null);

    const tokenA = jwt.signAccessToken({ accountId: A.id });

    const res = await logoutAll(tokenA);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    expect(await prisma.refreshToken.count({ where: { accountId: A.id, revokedAt: null } })).toBe(
      0,
    );
    const preRow = await prisma.refreshToken.findUnique({ where: { id: preRevoked.id } });
    expect(preRow!.revokedAt!.getTime()).toBe(preRevokedAt.getTime()); // 已撤时间戳不变
    expect(await prisma.refreshToken.count({ where: { accountId: B.id, revokedAt: null } })).toBe(
      2,
    ); // B 隔离

    // 幂等: 0 active 再次 logout-all → 仍 204
    const again = await logoutAll(tokenA);
    expect(again.statusCode).toBe(204);
  });

  it('0 active 账号 logout-all → 204 (幂等)', async () => {
    const C = await prisma.account.create({ data: { phone: '+8613800143003', status: 'ACTIVE' } });
    const tokenC = jwt.signAccessToken({ accountId: C.id });
    expect((await logoutAll(tokenC)).statusCode).toBe(204);
  });

  it('鉴权缺失 → 401 (JwtAccessGuard)', async () => {
    expect((await logoutAll()).statusCode).toBe(401);
  });

  it('无效 token → 401 (JwtAccessGuard verifyAccess 抛)', async () => {
    expect((await logoutAll('garbage.invalid.token')).statusCode).toBe(401);
  });
});
