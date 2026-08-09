import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { SmsPurpose } from '../../src/auth/deletion-code.rules';

// US9 Independent Test (FR-S18, 验证 T009/T014/T018/T023 已加的 8 条 throttler config):
//  del-code   account 1/60s (第 2 → 429) · IP 5/60s (第 6)
//  del-submit account 5/60s (第 6)        · IP 10/60s (第 11)
//  cancel-code   phone 1/60s (第 2)        · IP 5/60s (第 6)
//  cancel-submit phone 5/60s (第 6)        · IP 10/60s (第 11)
// + 限流命中时未触账号加载 / 未写码行 (429 在 guard 层短路, 不达 usecase)。
// beforeEach flushall 隔离各规则桶 (Redis storage, 同 loopback IP 否则跨测污染)。
//
// canonical Retry-After: RetryAfterThrottlerGuard (security/) 覆写 throwThrottlingException
// 抛 RateLimitExceededException(retryAfterSeconds) → ProblemDetailFilter 透出 canonical
// `Retry-After` 头 (取代 @nestjs/throttler v6 默认带桶名后缀的 Retry-After-<bucket>),各桶均断言。
describe('US9 注销/撤销限流 429 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us9-rate-jwt-secret-min-32-bytes-pad-abcde';
    process.env.SMS_CODE_HMAC_SECRET = 'us9-rate-hmac-secret-min-32-bytes-pad-zzz';

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
    redis = moduleRef.get(REDIS_CLIENT);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  const nextPhone = () => `+8613800${String(++seq).padStart(6, '0')}`;

  // 建 ACTIVE 账号 + 直签 JWT (绕 login; JwtAuthGuard 校验 token + 账号 ACTIVE)。
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  const delCode = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/deletion-codes',
      headers: { authorization: `Bearer ${token}` },
    });
  const delSubmit = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/deletion',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '123456' },
    });
  const cancelCode = (phone: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/cancel-deletion/sms-codes',
      payload: { phone },
    });
  const cancelSubmit = (phone: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/cancel-deletion',
      payload: { phone, code: '123456' },
    });

  it('del-code per-account 1/60s: 同账号第 2 次 → 429 + 未写第 2 条码', async () => {
    const { id, token } = await activeToken();
    const first = await delCode(token);
    const second = await delCode(token);
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    // 429 在 guard 层短路 → 未达 usecase → 仅第 1 次写了码 (账号未被二次加载/发码)。
    const codes = await prisma.accountSmsCode.count({
      where: { accountId: id, purpose: SmsPurpose.DELETE_ACCOUNT },
    });
    expect(codes).toBe(1);
  });

  it('del-code per-IP 5/60s: 同 IP 不同账号第 6 次 → 429', async () => {
    let last;
    for (let i = 0; i < 6; i++) {
      const { token } = await activeToken(); // 各账号 per-account 仅 1 次 (不触 1/60s)
      last = await delCode(token);
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('del-submit per-account 5/60s: 同账号第 6 次 → 429', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 6; i++) last = await delSubmit(token); // 1-5 → 401 (无码), 6 → 429
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('del-submit per-IP 10/60s: 同 IP 不同账号第 11 次 → 429', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      const { token } = await activeToken();
      last = await delSubmit(token);
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('cancel-code per-phone-hash 1/60s: 同手机号第 2 次 → 429', async () => {
    const phone = nextPhone();
    const first = await cancelCode(phone);
    const second = await cancelCode(phone);
    expect(first.statusCode).toBe(200); // 未注册 → ineligible 200 (反枚举)
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('cancel-code per-IP 5/60s: 同 IP 不同手机号第 6 次 → 429', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await cancelCode(nextPhone());
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('cancel-submit per-phone-hash 5/60s: 同手机号第 6 次 → 429', async () => {
    const phone = nextPhone();
    let last;
    for (let i = 0; i < 6; i++) last = await cancelSubmit(phone); // 1-5 → 401 (未注册), 6 → 429
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('cancel-submit per-IP 10/60s: 同 IP 不同手机号第 11 次 → 429', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await cancelSubmit(nextPhone());
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
