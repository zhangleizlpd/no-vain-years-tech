import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuthModule } from '../../src/auth/auth.module';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// US4 Independent Test (FR-S13): 4 桶各超限 → 429 + canonical `Retry-After`。list account
// 第 31 / IP 第 101; revoke account 第 6 / IP 第 21。per-account 桶用同一 token; per-IP 桶
// 用不同 account (同 loopback IP) 使 account 桶不先 trip。beforeEach flushall 隔离各桶。
//
// Retry-After 头由 RetryAfterThrottlerGuard (security/) 透出 —— 覆写 throwThrottlingException
// 抛 RateLimitExceededException(retryAfterSeconds) → ProblemDetailFilter 设 canonical 头,
// 取代 @nestjs/throttler v6 默认带桶名后缀的 Retry-After-<bucket>。
// IP 桶按 socket IP 入桶 (trustProxy 未启用,直连部署恒见真实公网 IP;spec 已澄清"无公网 IP"
// 分支在当前部署不可达,loopback 仅测试环境),故不另测跳过。
describe('US4 设备端点限流 429 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let jwt: JwtTokenService;
  let redis: Redis;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us4-dev-rate-jwt-secret-min-32-bytes-pad-a';
    process.env.SMS_CODE_HMAC_SECRET = 'us4-dev-rate-hmac-secret-min-32-bytes-pad';

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

  const listDevices = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/auth/devices',
      headers: { authorization: `Bearer ${token}`, 'x-device-id': 'dev-x' },
    });
  // 不存在 recordId → 404 (throttler guard 在 handler 前已计数); x-device-id 避 usecase 401。
  const revokeDevice = (token: string) =>
    app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/devices/888888888',
      headers: { authorization: `Bearer ${token}`, 'x-device-id': 'dev-x' },
    });

  it('list per-account 30/60s: 同账号第 31 次 → 429', async () => {
    const token = jwt.signAccessToken({ accountId: 8001n });
    let last;
    for (let i = 0; i < 31; i += 1) last = await listDevices(token);
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('list per-IP 100/60s: 同 IP 不同账号第 101 次 → 429', async () => {
    let last;
    for (let i = 0; i < 101; i += 1) {
      last = await listDevices(jwt.signAccessToken({ accountId: 8100n + BigInt(i) }));
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('revoke per-account 5/60s: 同账号第 6 次 → 429', async () => {
    const token = jwt.signAccessToken({ accountId: 8002n });
    let last;
    for (let i = 0; i < 6; i += 1) last = await revokeDevice(token);
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('revoke per-IP 20/60s: 同 IP 不同账号第 21 次 → 429', async () => {
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await revokeDevice(jwt.signAccessToken({ accountId: 8200n + BigInt(i) }));
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
