import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { RevokeDeviceUseCase } from '../../src/auth/revoke-device.usecase';
import { DEVICE_REVOKED_EVENT_TYPE } from '../../src/auth/device-revoked.event';

const DAY_MS = 24 * 60 * 60 * 1000;

// US3 Independent Test (SC-S05/S06): ① 不存在 vs 跨账号 404 字节级一致 (剥 traceId +
// instance —— instance 仅回显请求 URL, 非存在性泄露)。② 5 并发撤同行 (usecase 层直测绕限流)
// → 恰 1 真撤 (won) + 发 1 事件, 4 幂等; DB revokedAt 单次落定, outbox 恰 1 条 (重复 3 轮稳定)。
describe('US3 撤销反枚举 + 并发恰一 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let revokeUseCase: RevokeDeviceUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us3-dev-jwt-secret-min-32-bytes-pad-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'us3-dev-hmac-secret-min-32-bytes-pad-zzzz';

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
    revokeUseCase = moduleRef.get(RevokeDeviceUseCase, { strict: false });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  async function seedRow(accountId: bigint, deviceId: string) {
    seq += 1;
    return prisma.refreshToken.create({
      data: {
        tokenHash: `us3dev${String(seq).padStart(4, '0')}`.padEnd(64, '0'),
        accountId,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        deviceId,
        loginMethod: 'PHONE_SMS',
      },
    });
  }

  async function recordIdEventCount(recordId: bigint): Promise<number> {
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: DEVICE_REVOKED_EVENT_TYPE },
    });
    return events.filter(
      (e) => (e.payload as { data: { recordId: string } }).data.recordId === recordId.toString(),
    ).length;
  }

  it('① 不存在 recordId vs 跨账号 recordId → 404 ProblemDetail 字节级一致 (剥 traceId+instance)', async () => {
    const A = await prisma.account.create({ data: { phone: '+8613800147001', status: 'ACTIVE' } });
    const X = await prisma.account.create({ data: { phone: '+8613800147002', status: 'ACTIVE' } });
    await seedRow(A.id, 'A-current');
    const otherRow = await seedRow(X.id, 'X-1');
    const token = jwt.signAccessToken({ accountId: A.id });

    const del = (recordId: string | bigint) =>
      app.inject({
        method: 'DELETE',
        url: `/api/v1/auth/devices/${recordId}`,
        headers: { authorization: `Bearer ${token}`, 'x-device-id': 'A-current' },
      });

    const nonexistent = await del('888888888');
    const crossAccount = await del(otherRow.id);

    expect(nonexistent.statusCode).toBe(404);
    expect(crossAccount.statusCode).toBe(404);

    // 剥 traceId (随机) + instance (回显请求 URL, 含 recordId, 非存在性泄露) 后深等。
    const strip = (raw: string) => {
      const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      void traceId;
      void instance;
      return rest;
    };
    expect(strip(nonexistent.body)).toEqual(strip(crossAccount.body));
    expect((nonexistent.json() as { code: string }).code).toBe('DEVICE_NOT_FOUND');
  });

  it('② 5 并发撤同行 → 恰 1 真撤 + 1 事件, 4 幂等 (3 轮稳定)', async () => {
    const A = await prisma.account.create({ data: { phone: '+8613800147003', status: 'ACTIVE' } });

    for (let round = 0; round < 3; round += 1) {
      const target = await seedRow(A.id, `dev-target-${round}`);

      // usecase 层直测绕限流; currentDeviceId='A-current' ≠ 目标 deviceId (避免 409)。
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => revokeUseCase.execute(A.id, target.id, 'A-current')),
      );

      // 全部 fulfilled (won 真撤 + 竞态败者幂等, 均不抛)。
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      // DB revokedAt 单次落定。
      const row = await prisma.refreshToken.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.revokedAt).not.toBeNull();

      // outbox 恰 1 条 (恰 1 won → 恰 1 事件)。
      expect(await recordIdEventCount(target.id)).toBe(1);
    }
  });
});
