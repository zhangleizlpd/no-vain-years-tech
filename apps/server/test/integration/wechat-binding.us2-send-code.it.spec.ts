import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { SmsPurpose } from '../../src/auth/deletion-code.rules';

const TEN_MIN_MS = 10 * 60 * 1000;
const BIND_URL = '/api/v1/accounts/me/wechat-binding';
const UNBIND_CODES_URL = '/api/v1/accounts/me/wechat-binding/unbind-codes';

// US2 发码 Independent Test (FR-S03/S08):
//  ① bound+ACTIVE 发码 → 204 + DB 1 条 active UNBIND_WECHAT 码 (codeHash 非空 /
//     expiresAt≈+10min / usedAt null) + 绑定不变 + 无 outbox + getLastPurpose=UNBIND_WECHAT。
//  ② 未绑 ACTIVE 发码 → 401 字节级一致 (与无 token 比, 反枚举)。
//  ③ 非 ACTIVE → 401。
//  ④ per-account 第 2 次 60s 内 → 429。
describe('US2 微信解绑发码 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'wx-us2sc-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'wx-us2sc-hmac-secret-min-32-bytes-pad-z';

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

  async function login(phone: string): Promise<{ accountId: string; accessToken: string }> {
    await app.inject({ method: 'POST', url: '/api/v1/accounts/sms-codes', payload: { phone } });
    const code = mockSms.getLastCode(phone);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone, code },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accountId: string; accessToken: string };
  }

  // login + 绑定微信 (走 bind 端点)。返回 token + accountId。
  async function loginAndBind(phone: string, authCode: string) {
    const session = await login(phone);
    const bound = await app.inject({
      method: 'POST',
      url: BIND_URL,
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { authCode },
    });
    expect(bound.statusCode).toBe(201);
    return session;
  }

  const sendCode = (token?: string) =>
    app.inject({
      method: 'POST',
      url: UNBIND_CODES_URL,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  function stripTrace(payload: string): Record<string, unknown> {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    delete obj.traceId;
    return obj;
  }

  it('bound+ACTIVE 发码 → 204 + DB 1 条 active UNBIND_WECHAT 码 + 绑定不变 + 无 outbox + getLastPurpose', async () => {
    const phone = '+8613800170001';
    const { accountId, accessToken } = await loginAndBind(phone, 'wx-auth-us2sc-1');

    const outboxBefore = await prisma.outboxEvent.count();
    const before = Date.now();
    const res = await sendCode(accessToken);
    const after = Date.now();

    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe('');

    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: BigInt(accountId), purpose: SmsPurpose.UNBIND_WECHAT },
    });
    expect(codes).toHaveLength(1);
    const codeRow = codes[0]!;
    expect(codeRow.usedAt).toBeNull();
    expect(codeRow.codeHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expiresMs = codeRow.expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + TEN_MIN_MS - 10_000);
    expect(expiresMs).toBeLessThanOrEqual(after + TEN_MIN_MS + 10_000);

    // 绑定不变 + dispatched purpose。
    const bindings = await prisma.wechatBinding.findMany({
      where: { accountId: BigInt(accountId) },
    });
    expect(bindings).toHaveLength(1);
    expect(mockSms.getLastPurpose(phone)).toBe(SmsPurpose.UNBIND_WECHAT);
    expect(mockSms.getLastCode(phone)).toMatch(/^\d{6}$/);

    // 无 outbox。
    expect(await prisma.outboxEvent.count()).toBe(outboxBefore);
  });

  it('未绑微信 ACTIVE 发码 → 401, 与无 token 字节级一致 (剥 traceId 深等), 不写码行', async () => {
    const phone = '+8613800170002';
    const { accountId, accessToken } = await login(phone); // 不绑定

    const resUnbound = await sendCode(accessToken);
    const resNoToken = await sendCode();

    expect(resUnbound.statusCode).toBe(401);
    expect(resNoToken.statusCode).toBe(401);
    expect(stripTrace(resUnbound.payload)).toEqual(stripTrace(resNoToken.payload));

    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: BigInt(accountId), purpose: SmsPurpose.UNBIND_WECHAT },
    });
    expect(codes).toHaveLength(0);
  });

  it('非 ACTIVE (FROZEN) 持旧 token 发码 → 401', async () => {
    const phone = '+8613800170003';
    const { accessToken } = await loginAndBind(phone, 'wx-auth-us2sc-3');
    await prisma.account.update({
      where: { phone },
      data: { status: 'FROZEN', freezeUntil: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000) },
    });
    expect((await sendCode(accessToken)).statusCode).toBe(401);
  });

  it('per-account 第 2 次 60s 内 → 429 (wx-unbind-code 1/60s)', async () => {
    const phone = '+8613800170004';
    const { accessToken } = await loginAndBind(phone, 'wx-auth-us2sc-4');
    expect((await sendCode(accessToken)).statusCode).toBe(204);
    expect((await sendCode(accessToken)).statusCode).toBe(429);
  });
});
