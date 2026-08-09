import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { DeleteAccountUseCase } from '../../src/auth/delete-account.usecase';
import { SmsPurpose, hashDeletionCode } from '../../src/auth/deletion-code.rules';
import { ACCOUNT_DELETION_REQUESTED_EVENT_TYPE } from '../../src/account/account-deletion-requested.event';

const TEN_MIN_MS = 10 * 60 * 1000;
const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const DELETION_URL = '/api/v1/accounts/me/deletion';

// US3 Independent Test (FR-S05 反枚举 + FR-S06 并发 exactly-once):
//  ① 4 类码失败 (未找到 / 哈希不符 / 过期 / 已用) → 字节级一致 401 (剥 traceId 后
//     ProblemDetail 深等, detail='INVALID_DELETION_CODE'); 缺 / 非 \d{6} → 400
//     (FORM_VALIDATION 路径, 与凭据 401 区分)。
//  ② 5 并发持同一删除码提交 (service 层直测绕限流) → 恰 1 成功 + 4×401, DB 账号
//     FROZEN 单次 / 码 usedAt 单次 / token 全撤 / outbox RequestedEvent 恰 1 条
//     (markUsed affected-count 行写锁串行化, plan D2; 无双重冻结 / 无重复事件)。
describe('US3 删除码反枚举 + 并发 exactly-once (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;
  let deleteAccount: DeleteAccountUseCase;
  let hmacSecret: string;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'del-us3-jwt-secret-min-32-bytes-pad-abcdef';
    hmacSecret = 'del-us3-hmac-secret-min-32-bytes-pad-zzzzz';
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
    deleteAccount = moduleRef.get(DeleteAccountUseCase);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  // 真 SMS 登录流取 access token (login 码走 Redis, 不污染 account_sms_code)。
  async function login(phone: string): Promise<string> {
    await app.inject({ method: 'POST', url: '/api/v1/accounts/sms-codes', payload: { phone } });
    const code = mockSms.getLastCode(phone);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone, code },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  }

  // 创建 ACTIVE 账号 + 持有效 token (反枚举 4 分支均需通过 JwtAuthGuard 达 usecase fold)。
  async function activeAccountWithToken(phone: string): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone, status: 'ACTIVE' } });
    const token = await login(phone);
    return { id: acc.id, token };
  }

  // 直插 DELETE_ACCOUNT 码 (codeHash = 明文 HMAC; 控制 expiresAt / usedAt 造 4 类失败)。
  async function issueCode(
    accountId: bigint,
    plain: string,
    opts: { expiresAt?: Date; usedAt?: Date } = {},
  ): Promise<void> {
    await prisma.accountSmsCode.create({
      data: {
        accountId,
        purpose: SmsPurpose.DELETE_ACCOUNT,
        codeHash: hashDeletionCode(plain, hmacSecret),
        expiresAt: opts.expiresAt ?? new Date(Date.now() + TEN_MIN_MS),
        usedAt: opts.usedAt ?? null,
      },
    });
  }

  function submitDeletion(token: string, code: unknown) {
    return app.inject({
      method: 'POST',
      url: DELETION_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { code },
    });
  }

  // 剥 per-request traceId 后比较 (traceId 随机非状态相关, 不构成枚举泄漏)。
  function stripTrace(payload: string): Record<string, unknown> {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    delete obj.traceId;
    return obj;
  }

  it('4 类码失败折叠字节级一致 401 INVALID_DELETION_CODE; 缺/非 \\d{6} → 400', async () => {
    // 4 个独立 ACTIVE 账号, 各造一类失败 (避免活码跨场景串扰)。
    const past = new Date(Date.now() - 60_000);

    // ① 未找到: 无任何码行。
    const notFound = await activeAccountWithToken('+8613800300001');

    // ② 哈希不符: 持 active 码 (哈希 111111), 提交 222222。
    const mismatch = await activeAccountWithToken('+8613800300002');
    await issueCode(mismatch.id, '111111');

    // ③ 已过期: 码 expiresAt 过去 (findActive 滤 expiresAt>now → null)。
    const expired = await activeAccountWithToken('+8613800300003');
    await issueCode(expired.id, '333333', { expiresAt: past });

    // ④ 已用: 码 usedAt 已置 (findActive 滤 usedAt=null → null)。
    const used = await activeAccountWithToken('+8613800300004');
    await issueCode(used.id, '444444', { usedAt: past });

    const responses = await Promise.all([
      submitDeletion(notFound.token, '123456'),
      submitDeletion(mismatch.token, '222222'),
      submitDeletion(expired.token, '333333'),
      submitDeletion(used.token, '444444'),
    ]);

    // 全 401 + detail 折叠 INVALID_DELETION_CODE + content-type 一致。
    const baselineCt = responses[0]!.headers['content-type'];
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      const body = stripTrace(res.payload);
      expect(body.detail).toBe('INVALID_DELETION_CODE');
      expect(res.headers['content-type']).toBe(baselineCt);
    }

    // 字节级一致: 同 URL → instance 同, 剥 traceId 后 ProblemDetail 深等 (4 类不可区分)。
    const baseline = stripTrace(responses[0]!.payload);
    for (const res of responses) {
      expect(stripTrace(res.payload)).toEqual(baseline);
    }

    // 缺字段 / 非 \d{6} → 400 (FORM_VALIDATION 路径, 与 401 凭据路径区分; FR-S05)。
    // 复用 notFound 的 ACTIVE token (4 类 fold 不改账号态, 仍 ACTIVE)。
    const malformed = await Promise.all([
      submitDeletion(notFound.token, undefined), // 缺 code
      submitDeletion(notFound.token, 'abcdef'), // 非数字
      submitDeletion(notFound.token, '12345'), // 5 位
      submitDeletion(notFound.token, '1234567'), // 7 位
    ]);
    for (const res of malformed) {
      expect(res.statusCode).toBe(400);
    }
  });

  it('5 并发持同码 (service 层直测) → 恰 1 成功 + 4×401; DB FROZEN 单次 + 码 usedAt + token 全撤 + outbox RequestedEvent 恰 1 条', async () => {
    const phone = '+8613800300010';
    const acc = await prisma.account.create({ data: { phone, status: 'ACTIVE' } });
    await login(phone); // 落 1 条 active refresh token (验冻结时全撤)
    const plain = '654321';
    await issueCode(acc.id, plain); // 单条 active DELETE_ACCOUNT 码

    // service 层直触发 (绕 HTTP 限流): 5 并发持同码 → markUsed 行写锁串行化恰 1 won。
    const before = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => deleteAccount.execute(acc.id, plain)),
    );
    const after = Date.now();

    // 恰 1 成功 (service 层返 void = HTTP 204), 4 失败折叠 401 INVALID_DELETION_CODE。
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(UnauthorizedException);
      expect((r.reason as UnauthorizedException).message).toBe('INVALID_DELETION_CODE');
    }

    // 账号 FROZEN 单次 + freezeUntil ≈ now+15d (无双重冻结)。
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('FROZEN');
    const freezeMs = reloaded.freezeUntil!.getTime();
    expect(freezeMs).toBeGreaterThanOrEqual(before + FIFTEEN_DAYS_MS - 10_000);
    expect(freezeMs).toBeLessThanOrEqual(after + FIFTEEN_DAYS_MS + 10_000);

    // 码 usedAt 单次置 (恰 1 条, 不重复消费)。
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: acc.id, purpose: SmsPurpose.DELETE_ACCOUNT },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.usedAt).not.toBeNull();

    // 该账号 refresh token 全撤 (不重复撤; 单次冻结路径执行 1 次)。
    const tokens = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    // outbox 恰 1 条 deletion-requested (无重复发事件, FR-S06)。
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_DELETION_REQUESTED_EVENT_TYPE },
    });
    const mine = events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === acc.id.toString(),
    );
    expect(mine).toHaveLength(1);
  });
});
