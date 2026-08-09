import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { UnbindWechatUseCase } from '../../src/auth/unbind-wechat.usecase';
import { SmsPurpose, hashDeletionCode } from '../../src/auth/deletion-code.rules';

const TEN_MIN_MS = 10 * 60 * 1000;
const BIND_URL = '/api/v1/accounts/me/wechat-binding';
const UNBIND_CODES_URL = '/api/v1/accounts/me/wechat-binding/unbind-codes';
const UNBIND_URL = '/api/v1/accounts/me/wechat-binding/unbind';
const ME_URL = '/api/v1/accounts/me';

// US2 解绑 Independent Test (FR-S04 反枚举 + 并发 exactly-once):
//  ① 发码 → 持正确码提交 → 204 + DB 绑定删除 (0 行) + 码 usedAt 置 + GET /me
//     wechatBound:false + 账号 displayName 不变。
//  ② 4 类码失败 (未找/哈希不符/过期/已用) 字节级一致 401 INVALID_UNBIND_CODE +
//     缺/非 \d{6} → 400。
//  ③ 5 并发持同码 (service 层直测绕限流) → 恰 1×204 + 4 失败, DB 绑定删除单次、不双删。
describe('US2 微信解绑反枚举 + 并发 exactly-once (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;
  let unbindWechat: UnbindWechatUseCase;
  let hmacSecret: string;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'wx-us2u-jwt-secret-min-32-bytes-pad-abcd';
    hmacSecret = 'wx-us2u-hmac-secret-min-32-bytes-pad-zzz';
    process.env.SMS_CODE_HMAC_SECRET = hmacSecret;

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
    unbindWechat = moduleRef.get(UnbindWechatUseCase);
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

  // 直插 UNBIND_WECHAT 码 (codeHash = 明文 HMAC; 控制 expiresAt / usedAt 造 4 类失败)。
  async function issueCode(
    accountId: bigint,
    plain: string,
    opts: { expiresAt?: Date; usedAt?: Date } = {},
  ): Promise<void> {
    await prisma.accountSmsCode.create({
      data: {
        accountId,
        purpose: SmsPurpose.UNBIND_WECHAT,
        codeHash: hashDeletionCode(plain, hmacSecret),
        expiresAt: opts.expiresAt ?? new Date(Date.now() + TEN_MIN_MS),
        usedAt: opts.usedAt ?? null,
      },
    });
  }

  const seedBinding = (accountId: bigint, openid: string) =>
    prisma.wechatBinding.create({ data: { accountId, provider: 'WECHAT', openid } });

  function submitUnbind(token: string, code: unknown) {
    return app.inject({
      method: 'POST',
      url: UNBIND_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { code },
    });
  }

  function stripTrace(payload: string): Record<string, unknown> {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    delete obj.traceId;
    return obj;
  }

  it('发码 → 持正确码提交 → 204 + 绑定删除 + 码 usedAt + GET /me wechatBound:false + profile 不变', async () => {
    const phone = '+8613800180001';
    const { accountId, accessToken } = await login(phone);
    // 经 bind 端点真实绑定 + 设个 displayName 验解绑不动 profile。
    await app.inject({
      method: 'POST',
      url: BIND_URL,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { authCode: 'wx-auth-us2u-1' },
    });
    await prisma.account.update({ where: { phone }, data: { displayName: 'KeepMe' } });

    // 发码 → 取明文 → 提交。
    expect(
      (
        await app.inject({
          method: 'POST',
          url: UNBIND_CODES_URL,
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).statusCode,
    ).toBe(204);
    const plain = mockSms.getLastCode(phone)!;

    const res = await submitUnbind(accessToken, plain);
    expect(res.statusCode).toBe(204);

    // 绑定删除 + 码 usedAt 置。
    const bindings = await prisma.wechatBinding.findMany({
      where: { accountId: BigInt(accountId) },
    });
    expect(bindings).toHaveLength(0);
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: BigInt(accountId), purpose: SmsPurpose.UNBIND_WECHAT },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.usedAt).not.toBeNull();

    // GET /me wechatBound:false + profile 不变。
    const me = await app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect((me.json() as { wechatBound: boolean; displayName: string }).wechatBound).toBe(false);
    expect((me.json() as { displayName: string }).displayName).toBe('KeepMe');
  });

  it('4 类码失败折叠字节级一致 401 INVALID_UNBIND_CODE; 缺/非 \\d{6} → 400', async () => {
    const past = new Date(Date.now() - 60_000);

    // 4 个独立 ACTIVE 账号 (码失败先于绑定检查, 绑定存在与否不影响 401)。
    const notFound = await login('+8613800180010');
    const mismatch = await login('+8613800180011');
    await issueCode(BigInt(mismatch.accountId), '111111');
    const expired = await login('+8613800180012');
    await issueCode(BigInt(expired.accountId), '333333', { expiresAt: past });
    const used = await login('+8613800180013');
    await issueCode(BigInt(used.accountId), '444444', { usedAt: past });

    const responses = await Promise.all([
      submitUnbind(notFound.accessToken, '123456'),
      submitUnbind(mismatch.accessToken, '222222'),
      submitUnbind(expired.accessToken, '333333'),
      submitUnbind(used.accessToken, '444444'),
    ]);

    const baseline = stripTrace(responses[0]!.payload);
    const baselineCt = responses[0]!.headers['content-type'];
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      const body = stripTrace(res.payload);
      expect(body.detail).toBe('INVALID_UNBIND_CODE');
      expect(res.headers['content-type']).toBe(baselineCt);
      expect(body).toEqual(baseline); // 4 类字节级一致, 不可区分
    }

    // 缺 / 非 \d{6} → 400 (FORM_VALIDATION, 与凭据 401 区分)。
    const malformed = await Promise.all([
      submitUnbind(notFound.accessToken, undefined),
      submitUnbind(notFound.accessToken, 'abcdef'),
      submitUnbind(notFound.accessToken, '12345'),
      submitUnbind(notFound.accessToken, '1234567'),
    ]);
    for (const res of malformed) {
      expect(res.statusCode).toBe(400);
    }
  });

  it('5 并发持同码 (service 层直测) → 恰 1×204 + 4×401; DB 绑定删除单次、不双删', async () => {
    const phone = '+8613800180020';
    const { accountId } = await login(phone);
    const acc = BigInt(accountId);
    await seedBinding(acc, 'oCONCURRENTus2u0000000000abc'); // 28 位
    const plain = '654321';
    await issueCode(acc, plain);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => unbindWechat.execute(acc, plain)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(UnauthorizedException);
      expect((r.reason as UnauthorizedException).message).toBe('INVALID_UNBIND_CODE');
    }

    // 绑定删除单次 (0 行, 不双删) + 码 usedAt 单次。
    const bindings = await prisma.wechatBinding.findMany({ where: { accountId: acc } });
    expect(bindings).toHaveLength(0);
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: acc, purpose: SmsPurpose.UNBIND_WECHAT },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.usedAt).not.toBeNull();
  });
});
