import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { RefreshTokenService } from '../../src/security/refresh-token.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { SmsPurpose } from '../../src/auth/deletion-code.rules';
import { ACCOUNT_DELETION_CANCELLED_EVENT_TYPE } from '../../src/account/account-deletion-cancelled.event';
import type { Redis } from 'ioredis';

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;
const SEND_URL = '/api/v1/auth/cancel-deletion/sms-codes';
const SUBMIT_URL = '/api/v1/auth/cancel-deletion';

// US5 Independent Test (FR-S09/S10 / SC-S05):
//  ① FROZEN-in-grace 发撤销码 → 提交正确码 → 200 + 新 access/refresh; 单 tx:
//     账号 ACTIVE / freezeUntil null / 码 usedAt 置 / 新 1 条 active refresh token(30d) /
//     outbox 1 条 auth.account.deletion-cancelled。
//  ② 原子性: 注入 persist 失败 → 整 tx 回滚 (账号仍 FROZEN / freezeUntil 不变 /
//     码仍 active / 无事件 / 无新 token)。
describe('US5 提交撤销码解冻 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;
  let refreshTokenService: RefreshTokenService;
  let redis: Redis;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'cancel-us5-jwt-secret-min-32-bytes-pad-ab';
    process.env.SMS_CODE_HMAC_SECRET = 'cancel-us5-hmac-secret-min-32-bytes-pad-z';

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
    refreshTokenService = moduleRef.get(RefreshTokenService);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  // 清限流状态隔离各 it (cancel-code-ip / cancel-submit-ip 跨用例 IP 预算)。
  beforeEach(async () => {
    await redis.flushall();
  });

  const inGrace = () => new Date(Date.now() + 5 * DAY_MS);

  // EP3 发撤销码 → 返回下发的 6 位明文码 (mock gateway, purpose=CANCEL_DELETION)。
  async function sendCancelCode(phone: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: SEND_URL, payload: { phone } });
    expect(res.statusCode).toBe(200);
    expect(mockSms.getLastPurpose(phone)).toBe(SmsPurpose.CANCEL_DELETION);
    return mockSms.getLastCode(phone)!;
  }

  function submitCancel(phone: string, code: string) {
    return app.inject({ method: 'POST', url: SUBMIT_URL, payload: { phone, code } });
  }

  it('提交正确码 → 200 + 新 token; 账号 ACTIVE/freezeUntil null + 码 usedAt + 1 active refresh(30d) + outbox 1 条 cancelled', async () => {
    const phone = '+8613800500001';
    const acc = await prisma.account.create({
      data: { phone, status: 'FROZEN', freezeUntil: inGrace() },
    });
    const code = await sendCancelCode(phone);

    const before = Date.now();
    const res = await submitCancel(phone, code);
    const after = Date.now();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { accountId: string; accessToken: string; refreshToken: string };
    expect(body.accountId).toBe(acc.id.toString());
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();

    // 账号 ACTIVE + freezeUntil 清空。
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('ACTIVE');
    expect(reloaded.freezeUntil).toBeNull();

    // 码 usedAt 置 (active 码归零)。
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: acc.id, purpose: SmsPurpose.CANCEL_DELETION },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.usedAt).not.toBeNull();

    // 新 1 条 active refresh token, expiresAt ≈ +30d。
    const tokens = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.revokedAt).toBeNull();
    const expMs = tokens[0]!.expiresAt.getTime();
    expect(expMs).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS - 10_000);
    expect(expMs).toBeLessThanOrEqual(after + THIRTY_DAYS_MS + 10_000);

    // outbox 1 条 auth.account.deletion-cancelled + payload。
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_DELETION_CANCELLED_EVENT_TYPE },
    });
    const mine = events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === acc.id.toString(),
    );
    expect(mine).toHaveLength(1);
    const envelope = mine[0]!.payload as {
      metadata: { producer_context: string };
      data: { accountId: string; cancelledAt: string; occurredAt: string };
    };
    expect(envelope.metadata.producer_context).toBe('auth');
    expect(envelope.data.cancelledAt).toBe(envelope.data.occurredAt);
  });

  it('原子性: 注入 persist 失败 → 整 tx 回滚 (账号仍 FROZEN / freezeUntil 不变 / 码仍 active / 无事件 / 无 token)', async () => {
    const phone = '+8613800500002';
    const freezeUntil = inGrace();
    const acc = await prisma.account.create({
      data: { phone, status: 'FROZEN', freezeUntil },
    });
    const code = await sendCancelCode(phone);

    // 注入: persist 抛 → CancelDeletionUseCase tx 内第 3 步失败 → 整 tx 回滚。
    const spy = vi
      .spyOn(refreshTokenService, 'persist')
      .mockRejectedValueOnce(new Error('persist fixture boom'));

    const res = await submitCancel(phone, code);
    expect(res.statusCode).toBe(500); // 未捕获 infra 错 → ProblemDetailFilter 500
    spy.mockRestore();

    // 账号仍 FROZEN + freezeUntil 不变。
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('FROZEN');
    expect(reloaded.freezeUntil?.getTime()).toBe(freezeUntil.getTime());

    // 码仍 active (markUsed 随 tx 回滚)。
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: acc.id, purpose: SmsPurpose.CANCEL_DELETION },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.usedAt).toBeNull();

    // 无 token / 无事件。
    const tokens = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
    expect(tokens).toHaveLength(0);
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_DELETION_CANCELLED_EVENT_TYPE },
    });
    const mine = events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === acc.id.toString(),
    );
    expect(mine).toHaveLength(0);
  });
});
