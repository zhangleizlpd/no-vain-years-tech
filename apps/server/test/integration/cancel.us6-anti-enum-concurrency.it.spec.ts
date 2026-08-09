import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { CancelDeletionUseCase } from '../../src/auth/cancel-deletion.usecase';
import { SmsPurpose, hashDeletionCode } from '../../src/auth/deletion-code.rules';
import { ACCOUNT_DELETION_CANCELLED_EVENT_TYPE } from '../../src/account/account-deletion-cancelled.event';
import type { Redis } from 'ioredis';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const SUBMIT_URL = '/api/v1/auth/cancel-deletion';

// US6 Independent Test (FR-S11 反枚举 + FR-S12 并发 exactly-once):
//  ① 5 类失败 (未注册 / ACTIVE / ANONYMIZED / grace 已过 / 码失败) → 字节级一致 401
//     (剥 traceId 后 ProblemDetail 深等, detail='INVALID_CREDENTIALS'); 缺字段 → 400。
//  ② 5 并发持同一撤销码提交 (service 层直测绕限流) → 恰 1×200 + 4×401, DB 账号
//     ACTIVE 单次 / 码 usedAt 单次 / outbox CancelledEvent 恰 1 条 / 新 refresh token
//     恰 1 条 (markUsed + commitCancellation affected-count 行写锁串行化, plan D2)。
describe('US6 撤销码反枚举 + 并发 exactly-once (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cancelDeletion: CancelDeletionUseCase;
  let redis: Redis;
  let hmacSecret: string;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'cancel-us6-jwt-secret-min-32-bytes-pad-ab';
    hmacSecret = 'cancel-us6-hmac-secret-min-32-bytes-pad-zz';
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
    cancelDeletion = moduleRef.get(CancelDeletionUseCase);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  const inGrace = () => new Date(Date.now() + 5 * DAY_MS);

  // 直插 CANCEL_DELETION 码 (codeHash = 明文 HMAC)。
  async function issueCode(accountId: bigint, plain: string): Promise<void> {
    await prisma.accountSmsCode.create({
      data: {
        accountId,
        purpose: SmsPurpose.CANCEL_DELETION,
        codeHash: hashDeletionCode(plain, hmacSecret),
        expiresAt: new Date(Date.now() + TEN_MIN_MS),
      },
    });
  }

  function submit(phone: string, code: unknown) {
    return app.inject({ method: 'POST', url: SUBMIT_URL, payload: { phone, code } });
  }

  function stripTrace(payload: string): Record<string, unknown> {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    delete obj.traceId;
    return obj;
  }

  it('5 类失败折叠字节级一致 401 INVALID_CREDENTIALS; 缺字段 → 400', async () => {
    // 5 类各独立 phone (per-phone-hash 1 次 → 不撞限流)。
    const unregistered = '+8613800600001';

    const activeAcc = await prisma.account.create({
      data: { phone: '+8613800600002', status: 'ACTIVE' },
    });
    const anonAcc = await prisma.account.create({
      data: { phone: '+8613800600003', status: 'ANONYMIZED' },
    });
    const graceGoneAcc = await prisma.account.create({
      data: {
        phone: '+8613800600004',
        status: 'FROZEN',
        freezeUntil: new Date(Date.now() - 60_000),
      },
    });
    // 码失败: FROZEN-in-grace 但无 active 码 → findActive null → code-class 401。
    const codeFailAcc = await prisma.account.create({
      data: { phone: '+8613800600005', status: 'FROZEN', freezeUntil: inGrace() },
    });

    const responses = await Promise.all([
      submit(unregistered, '123456'), // 未注册 (phone-class)
      submit(activeAcc.phone!, '123456'), // ACTIVE (phone-class)
      submit(anonAcc.phone!, '123456'), // ANONYMIZED (phone-class)
      submit(graceGoneAcc.phone!, '123456'), // grace 已过 (phone-class)
      submit(codeFailAcc.phone!, '123456'), // FROZEN-in-grace + 无码 (code-class)
    ]);

    const baseCt = responses[0]!.headers['content-type'];
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      expect(stripTrace(res.payload).detail).toBe('INVALID_CREDENTIALS');
      expect(res.headers['content-type']).toBe(baseCt);
    }
    // 字节级一致: 同 URL → instance 同, 剥 traceId 后 ProblemDetail 深等 (5 类不可区分)。
    const baseline = stripTrace(responses[0]!.payload);
    for (const res of responses) {
      expect(stripTrace(res.payload)).toEqual(baseline);
    }

    // 缺字段 → 400 (FORM_VALIDATION, 与凭据 401 区分)。
    const missingPhone = await app.inject({
      method: 'POST',
      url: SUBMIT_URL,
      payload: { code: '123456' },
    });
    const missingCode = await app.inject({
      method: 'POST',
      url: SUBMIT_URL,
      payload: { phone: unregistered },
    });
    expect(missingPhone.statusCode).toBe(400);
    expect(missingCode.statusCode).toBe(400);
  });

  it('5 并发持同码 (service 层直测) → 恰 1×200 + 4×401; DB ACTIVE 单次 + 码 usedAt + outbox 恰 1 + 新 token 恰 1', async () => {
    const phone = '+8613800600010';
    const acc = await prisma.account.create({
      data: { phone, status: 'FROZEN', freezeUntil: inGrace() },
    });
    const plain = '654321';
    await issueCode(acc.id, plain);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => cancelDeletion.execute(phone, plain)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(UnauthorizedException);
      expect((r.reason as UnauthorizedException).message).toBe('INVALID_CREDENTIALS');
    }

    // 账号 ACTIVE 单次 + freezeUntil 清空 (无重复解冻)。
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('ACTIVE');
    expect(reloaded.freezeUntil).toBeNull();

    // 码 usedAt 单次置。
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: acc.id, purpose: SmsPurpose.CANCEL_DELETION },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.usedAt).not.toBeNull();

    // 新 refresh token 恰 1 条 (无重复签发)。
    const tokens = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.revokedAt).toBeNull();

    // outbox CancelledEvent 恰 1 条 (无重复发事件)。
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_DELETION_CANCELLED_EVENT_TYPE },
    });
    const mine = events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === acc.id.toString(),
    );
    expect(mine).toHaveLength(1);
  });
});
