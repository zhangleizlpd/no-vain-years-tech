import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';

const BIND_URL = '/api/v1/accounts/me/wechat-binding';
const ME_URL = '/api/v1/accounts/me';

// US1 Independent Test (FR-S02 / SC-001):
//  ① ACTIVE 持 token + stub authCode bind → 201 + DB wechat_binding 1 行
//     (openid 非空 28 位 / boundAt≈now / provider=WECHAT) + 账号 displayName 不变 +
//     GET /me wechatBound:true。
//  ② 同 openid (同 authCode) 他账号 bind → 409 WECHAT_ALREADY_BOUND_OTHER, body 不含他账号信息。
//  ③ 自号同 authCode 重 bind → 幂等 201, DB 仍 1 行, 无副作用。
//  ④ 缺 token → 401。
describe('US1 微信绑定创建 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'wx-us1-jwt-secret-min-32-bytes-pad-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'wx-us1-hmac-secret-min-32-bytes-pad-zzzzz';

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

  // 走真 SMS 登录流取 access token (login=register, 创建 ACTIVE 账号)。
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

  const bind = (token: string, authCode: string) =>
    app.inject({
      method: 'POST',
      url: BIND_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { authCode },
    });

  function stripTrace(payload: string): Record<string, unknown> {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    delete obj.traceId;
    return obj;
  }

  it('ACTIVE bind → 201 + DB 1 行 (openid 28 位 / boundAt≈now / provider=WECHAT) + profile 不变 + GET /me wechatBound:true', async () => {
    const phone = '+8613800160001';
    const { accountId, accessToken } = await login(phone);

    const before = Date.now();
    const res = await bind(accessToken, 'wx-auth-us1-a');
    const after = Date.now();

    expect(res.statusCode).toBe(201);

    const rows = await prisma.wechatBinding.findMany({ where: { accountId: BigInt(accountId) } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.provider).toBe('WECHAT');
    expect(row.openid).toMatch(/^o[A-Za-z0-9]{27}$/);
    expect(row.unionid).toBeNull();
    const boundMs = row.boundAt.getTime();
    expect(boundMs).toBeGreaterThanOrEqual(before - 10_000);
    expect(boundMs).toBeLessThanOrEqual(after + 10_000);

    // profile 不被绑定改写。
    const account = await prisma.account.findUniqueOrThrow({ where: { id: BigInt(accountId) } });
    expect(account.displayName).toBeNull();

    // GET /me 反映 wechatBound:true。
    const me = await app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { wechatBound: boolean }).wechatBound).toBe(true);
  });

  it('同 openid 他账号 bind → 409 WECHAT_ALREADY_BOUND_OTHER (body 不含他账号信息)', async () => {
    const ownerPhone = '+8613800160010';
    const otherPhone = '+8613800160011';
    const owner = await login(ownerPhone);
    const other = await login(otherPhone);
    const sharedAuthCode = 'wx-auth-us1-shared'; // 同 authCode → 同 stub openid

    expect((await bind(owner.accessToken, sharedAuthCode)).statusCode).toBe(201);

    const res = await bind(other.accessToken, sharedAuthCode);
    expect(res.statusCode).toBe(409);
    const body = stripTrace(res.payload);
    expect(body.code).toBe('WECHAT_ALREADY_BOUND_OTHER');
    // 不泄露他账号: body 不含 owner accountId / phone / openid。
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(owner.accountId);
    expect(serialized).not.toContain(ownerPhone);
    expect(serialized).not.toContain('openid');

    // other 账号无绑定行。
    const otherRows = await prisma.wechatBinding.findMany({
      where: { accountId: BigInt(other.accountId) },
    });
    expect(otherRows).toHaveLength(0);
  });

  it('自号同 authCode 重 bind → 幂等 201, DB 仍 1 行, 无副作用', async () => {
    const phone = '+8613800160020';
    const { accountId, accessToken } = await login(phone);
    const authCode = 'wx-auth-us1-idem';

    expect((await bind(accessToken, authCode)).statusCode).toBe(201);
    const firstRow = await prisma.wechatBinding.findFirstOrThrow({
      where: { accountId: BigInt(accountId) },
    });

    // 重绑同 openid → 幂等 201。
    expect((await bind(accessToken, authCode)).statusCode).toBe(201);

    const rows = await prisma.wechatBinding.findMany({ where: { accountId: BigInt(accountId) } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(firstRow.id); // 同一行, 未重建 (boundAt 不变)
    expect(rows[0]!.boundAt.getTime()).toBe(firstRow.boundAt.getTime());
  });

  it('缺 token → 401', async () => {
    const res = await app.inject({ method: 'POST', url: BIND_URL, payload: { authCode: 'x' } });
    expect(res.statusCode).toBe(401);
  });
});
