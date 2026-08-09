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

const BIND_URL = '/api/v1/accounts/me/wechat-binding';
const UNBIND_CODES_URL = '/api/v1/accounts/me/wechat-binding/unbind-codes';
const UNBIND_URL = '/api/v1/accounts/me/wechat-binding/unbind';

// US2 限流 Independent Test (FR-S06, 验 T008/T011/T016 注册的 6 条 wechat throttler):
//  wx-bind        account 5/60s (第 6 → 429) · IP 10/60s (第 11)
//  wx-unbind-code account 1/60s (第 2)        · IP 5/60s (第 6)
//  wx-unbind      account 5/60s (第 6)        · IP 10/60s (第 11)
// + 限流命中时未写第 2 条码 (429 在 guard 层短路, 不达 usecase)。
// beforeEach flushall 隔离各规则桶 (同 loopback IP 否则跨测污染)。
describe('US2 微信绑定/解绑限流 429 (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'wx-us2rl-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'wx-us2rl-hmac-secret-min-32-bytes-pad-z';

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
  const nextOpenid = () => `oRL${String(++seq).padStart(25, '0')}`;

  // 建 ACTIVE 账号 + 直签 JWT (绕 login)。
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  const bind = (token: string, authCode: string) =>
    app.inject({
      method: 'POST',
      url: BIND_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { authCode },
    });
  const sendUnbindCode = (token: string) =>
    app.inject({
      method: 'POST',
      url: UNBIND_CODES_URL,
      headers: { authorization: `Bearer ${token}` },
    });
  const submitUnbind = (token: string) =>
    app.inject({
      method: 'POST',
      url: UNBIND_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '123456' },
    });

  it('wx-bind per-account 5/60s: 同账号第 6 次 → 429 + 绑定未改', async () => {
    const { id, token } = await activeToken();
    let last;
    for (let i = 0; i < 6; i++) last = await bind(token, 'wx-rl-bind-same'); // 1-5 幂等 201, 6 → 429
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    // 429 短路 → 绑定仍恰 1 行 (未二次写)。
    expect(await prisma.wechatBinding.count({ where: { accountId: id } })).toBe(1);
  });

  it('wx-bind per-IP 10/60s: 同 IP 不同账号第 11 次 → 429', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      const { token } = await activeToken(); // 各账号 per-account 仅 1 次
      last = await bind(token, `wx-rl-bind-ip-${i}`); // 各 unique openid
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('wx-unbind-code per-account 1/60s: 同账号第 2 次 → 429 + 未写第 2 条码', async () => {
    const { id, token } = await activeToken();
    await prisma.wechatBinding.create({
      data: { accountId: id, provider: 'WECHAT', openid: nextOpenid() },
    });
    const first = await sendUnbindCode(token); // bound+ACTIVE → 204
    const second = await sendUnbindCode(token);
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    // 429 短路 → 仅第 1 次写码。
    expect(
      await prisma.accountSmsCode.count({
        where: { accountId: id, purpose: SmsPurpose.UNBIND_WECHAT },
      }),
    ).toBe(1);
  });

  it('wx-unbind-code per-IP 5/60s: 同 IP 不同账号第 6 次 → 429', async () => {
    let last;
    for (let i = 0; i < 6; i++) {
      const { token } = await activeToken();
      last = await sendUnbindCode(token); // 未绑 → 401, throttler 仍计数
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('wx-unbind per-account 5/60s: 同账号第 6 次 → 429', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 6; i++) last = await submitUnbind(token); // 1-5 → 401 (无码), 6 → 429
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('wx-unbind per-IP 10/60s: 同 IP 不同账号第 11 次 → 429', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      const { token } = await activeToken();
      last = await submitUnbind(token);
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
