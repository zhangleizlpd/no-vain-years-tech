import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { hashRefreshToken } from '../../src/security/refresh-token-hasher';

const DAY_MS = 24 * 60 * 60 * 1000;

// US3 Independent Test: refresh 全失败臂字节级一致 401 INVALID_CREDENTIALS (反枚举);
// 请求体缺/空 token → 400 (与凭据路径区分)。
// 字节级 = 剥离 per-request traceId 后 ProblemDetail 深等 (instance=同 URL 不变)。
describe('US3 refresh 反枚举 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us3-enum-jwt-secret-min-32-bytes-pad-abcde';
    process.env.SMS_CODE_HMAC_SECRET = 'us3-enum-hmac-secret-min-32-bytes-pad-zzz';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  function refresh(refreshToken: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/accounts/refresh-token',
      payload: { refreshToken },
    });
  }

  async function seed(
    raw: string,
    accountId: bigint,
    opts?: { expiresAt?: Date; revokedAt?: Date },
  ) {
    await prisma.refreshToken.create({
      data: {
        tokenHash: hashRefreshToken(raw),
        accountId,
        expiresAt: opts?.expiresAt ?? new Date(Date.now() + 30 * DAY_MS),
        revokedAt: opts?.revokedAt ?? null,
        deviceId: `dev-enum-${raw}`,
        loginMethod: 'PHONE_SMS',
      },
    });
  }

  // 剥离 per-request traceId 后比较 (traceId 随机非状态相关,不构成枚举泄漏)。
  function stripTrace(payload: string): Record<string, unknown> {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    delete obj.traceId;
    return obj;
  }

  it('7 路失败臂字节级一致 401 INVALID_CREDENTIALS (剥 traceId 深等)', async () => {
    const active = await prisma.account.create({
      data: { phone: '+8613800142001', status: 'ACTIVE' },
    });
    const frozen = await prisma.account.create({
      data: {
        phone: '+8613800142002',
        status: 'FROZEN',
        freezeUntil: new Date(Date.now() + DAY_MS),
      },
    });

    // 1. not-found — 从未签发
    // 2. expired
    await seed('expired-tok', active.id, { expiresAt: new Date(Date.now() - 1000) });
    // 3. revoked
    await seed('revoked-tok', active.id, { revokedAt: new Date(Date.now() - 1000) });
    // 4. forged — 结构合法但从未签发 (与 not-found 同因, spec 单列)
    // 5. account-missing — active 行但 accountId 无对应账号
    await seed('orphan-tok', 9_999_999n);
    // 6. account-not-eligible — active 行 + FROZEN 账号 (refresh 折 401 非 403)
    await seed('frozen-tok', frozen.id);
    // 7. race-lost — 先成功轮换再重放 (已撤)
    await seed('raced-tok', active.id);
    const firstRotate = await refresh('raced-tok');
    expect(firstRotate.statusCode).toBe(200);

    const responses = await Promise.all([
      refresh('never-issued-token-1'), // 1 not-found
      refresh('expired-tok'), // 2 expired
      refresh('revoked-tok'), // 3 revoked
      refresh('!!garbage-forged-token!!'), // 4 forged
      refresh('orphan-tok'), // 5 account-missing
      refresh('frozen-tok'), // 6 account-not-eligible
      refresh('raced-tok'), // 7 race-lost (重放)
    ]);

    // 全 401
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
    }
    // body (剥 traceId) 全字节级一致 + detail=INVALID_CREDENTIALS + status 401 + content-type 一致
    const baseline = stripTrace(responses[0]!.payload);
    expect(baseline.detail).toBe('INVALID_CREDENTIALS');
    expect(baseline.status).toBe(401);
    const baseCt = responses[0]!.headers['content-type'];
    for (const res of responses) {
      expect(stripTrace(res.payload)).toEqual(baseline);
      expect(res.headers['content-type']).toBe(baseCt);
    }
  });

  it('请求体缺 / 空 token → 400 (与凭据 401 区分)', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/refresh-token',
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const empty = await refresh('');
    expect(empty.statusCode).toBe(400);
  });
});
