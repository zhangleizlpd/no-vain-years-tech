import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { SmsPurpose, hashDeletionCode } from '../../src/auth/deletion-code.rules';

const TEN_MIN_MS = 10 * 60 * 1000;
const DELETION_CODES_URL = '/api/v1/accounts/me/deletion-codes';

// US1 Independent Test (FR-S01/S02 / SC-S01):
//  ① ACTIVE 账号持有效 token 发码 → 204 + DB 落 1 条 active DELETE_ACCOUNT 码
//     (codeHash = 下发码 HMAC / expiresAt≈+10min / usedAt null), 账号仍 ACTIVE, 无事件。
//  ② FROZEN 账号持旧 token → 401, 与无 token 字节级一致 (剥 traceId 深等), 不写码行。
//     注: JwtAuthGuard 在 usecase 之前短路非 ACTIVE, 故 401 detail = guard 的
//     "Unauthorized" (非 usecase 的 INVALID_CREDENTIALS fold —— 该 fold 仅 TOCTOU
//     竞态可达)。反枚举属性 (FROZEN-token 与 no-token 不可区分) 由 guard 统一兜底,
//     与 accounts.us4-002 既有 guard 反枚举范式一致。
describe('US1 发送注销验证码 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;
  let hmacSecret: string;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'del-us1-jwt-secret-min-32-bytes-pad-abcdef';
    hmacSecret = 'del-us1-hmac-secret-min-32-bytes-pad-zzzzz';
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
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  // 走真 SMS 登录流取 access token (login 码走 Redis, 不污染 account_sms_code)。
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

  // 剥离 per-request traceId 后比较 (traceId 随机非状态相关, 不构成枚举泄漏)。
  function stripTrace(payload: string): Record<string, unknown> {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    delete obj.traceId;
    return obj;
  }

  it('ACTIVE 账号发码 → 204 + DB 1 条 active DELETE_ACCOUNT 码 (codeHash=下发码哈希 / expiresAt≈+10min / usedAt null) + 账号仍 ACTIVE + 无事件', async () => {
    const phone = '+8613800150001';
    const acc = await prisma.account.create({ data: { phone, status: 'ACTIVE' } });
    const { accessToken } = await login(phone);

    const outboxBefore = await prisma.outboxEvent.count();
    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: DELETION_CODES_URL,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const after = Date.now();

    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe(''); // 204 无 body

    // DB: 恰 1 条 DELETE_ACCOUNT 码 (login 码走 Redis, 不落 account_sms_code)。
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: acc.id, purpose: SmsPurpose.DELETE_ACCOUNT },
    });
    expect(codes).toHaveLength(1);
    const codeRow = codes[0]!;
    expect(codeRow.usedAt).toBeNull();

    // codeHash = 下发明文码的 HMAC (明文只进短信, 永不入库)。
    const dispatched = mockSms.getLastCode(phone);
    expect(dispatched).toMatch(/^\d{6}$/);
    expect(mockSms.getLastPurpose(phone)).toBe(SmsPurpose.DELETE_ACCOUNT);
    expect(codeRow.codeHash).toBe(hashDeletionCode(dispatched!, hmacSecret));

    // expiresAt ≈ now + 10min (10s 容差)。
    const expiresMs = codeRow.expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + TEN_MIN_MS - 10_000);
    expect(expiresMs).toBeLessThanOrEqual(after + TEN_MIN_MS + 10_000);

    // 账号状态不变, 无 freezeUntil。
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('ACTIVE');
    expect(reloaded.freezeUntil).toBeNull();

    // 无事件: 发码路径不写 outbox。
    const outboxAfter = await prisma.outboxEvent.count();
    expect(outboxAfter).toBe(outboxBefore);
  });

  it('FROZEN 账号持旧 token → 401, 与无 token 字节级一致 (剥 traceId 深等, detail="Unauthorized"), 不写码行', async () => {
    const phone = '+8613800150002';
    const { accountId, accessToken } = await login(phone);

    // ACTIVE 时取到有效 token, 再冻结 (freezeUntil 未来) —— 模拟持旧 token 的 FROZEN 账号。
    await prisma.account.update({
      where: { phone },
      data: { status: 'FROZEN', freezeUntil: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000) },
    });

    const resFrozen = await app.inject({
      method: 'POST',
      url: DELETION_CODES_URL,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const resNoToken = await app.inject({ method: 'POST', url: DELETION_CODES_URL });

    expect(resFrozen.statusCode).toBe(401);
    expect(resNoToken.statusCode).toBe(401);

    // 字节级一致: 同 URL → instance 相同, 剥 traceId 后 ProblemDetail 深等。
    const frozenBody = stripTrace(resFrozen.payload);
    const noTokenBody = stripTrace(resNoToken.payload);
    expect(frozenBody).toEqual(noTokenBody);
    expect(frozenBody.detail).toBe('Unauthorized'); // guard 短路非 ACTIVE, 未达 usecase fold
    expect(resFrozen.headers['content-type']).toBe(resNoToken.headers['content-type']);

    // 反枚举: 不写码行 (guard 在 usecase 之前拒, 不发码)。
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: BigInt(accountId), purpose: SmsPurpose.DELETE_ACCOUNT },
    });
    expect(codes).toHaveLength(0);
  });
});
