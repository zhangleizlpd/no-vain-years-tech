import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuthModule } from '../../src/auth/auth.module';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// US6 Independent Test (FR-S14, 纯验证 T012/T017 已加的限流 config):
// refresh per-token 5/60s + per-IP 100/60s; logout-all per-account 5/60s + per-IP 50/60s。
// beforeEach flushall 隔离各规则的 throttler 桶 (Redis storage, 同 loopback IP 否则跨测污染)。
describe('US6 限流 429 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let jwt: JwtTokenService;
  let redis: Redis;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us6-rate-jwt-secret-min-32-bytes-pad-abcde';
    process.env.SMS_CODE_HMAC_SECRET = 'us6-rate-hmac-secret-min-32-bytes-pad-zzz';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    jwt = moduleRef.get(JwtTokenService);
    redis = moduleRef.get(REDIS_CLIENT);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall(); // 隔离每条规则的 throttler 桶
  });

  const refresh = (refreshToken: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/accounts/refresh-token',
      payload: { refreshToken },
    });
  const logoutAll = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/accounts/logout-all',
      headers: { authorization: `Bearer ${token}` },
    });

  it('refresh per-token 5/60s: 同 token 第 6 次 → 429', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await refresh('same-token-for-rate-limit');
    expect(last!.statusCode).toBe(429);
    // canonical Retry-After 由 RetryAfterThrottlerGuard → RateLimitExceededException
    // → ProblemDetailFilter 透出 (取代 @nestjs/throttler v6 默认带桶名后缀的 Retry-After-<bucket>)。
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('refresh per-IP 100/60s: 同 IP 不同 token 第 101 次 → 429', async () => {
    let last;
    for (let i = 0; i < 101; i++) last = await refresh(`distinct-token-${i}`);
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('logout-all per-account 5/60s: 同账号第 6 次 → 429', async () => {
    const token = jwt.signAccessToken({ accountId: 6001n });
    let last;
    for (let i = 0; i < 6; i++) last = await logoutAll(token);
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('logout-all per-IP 50/60s: 同 IP 不同账号第 51 次 → 429', async () => {
    let last;
    for (let i = 0; i < 51; i++) {
      last = await logoutAll(jwt.signAccessToken({ accountId: 6100n + BigInt(i) }));
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
