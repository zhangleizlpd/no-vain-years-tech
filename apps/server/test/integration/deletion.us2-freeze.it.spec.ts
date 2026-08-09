import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { RefreshTokenService } from '../../src/security/refresh-token.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { ACCOUNT_DELETION_REQUESTED_EVENT_TYPE } from '../../src/account/account-deletion-requested.event';

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

// US2 Independent Test (FR-S03/S04 / SC-S02/S03):
//  ① 发码 → 提交正确码 → 204 + 单 tx: 账号 FROZEN / freezeUntil≈+15d / 码 usedAt 置 /
//     该账号 refresh token 全撤 / outbox 1 条 auth.account.deletion-requested (逐字段)。
//  ② 原子性: 注入 revoke 失败 → 整 tx 回滚 (账号仍 ACTIVE / freezeUntil null /
//     码仍 active / 无事件)。
describe('US2 提交注销码冻结 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;
  let refreshTokenService: RefreshTokenService;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'del-us2-jwt-secret-min-32-bytes-pad-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'del-us2-hmac-secret-min-32-bytes-pad-zzzzz';

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
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

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

  // EP1 发码 → 返回下发的 6 位明文码 (mock gateway 记录, purpose=DELETE_ACCOUNT)。
  async function sendDeletionCode(phone: string, token: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/deletion-codes',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
    return mockSms.getLastCode(phone)!;
  }

  function submitDeletion(token: string, code: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/deletion',
      headers: { authorization: `Bearer ${token}` },
      payload: { code },
    });
  }

  it('提交正确码 → 204 + 账号 FROZEN/freezeUntil≈+15d + 码 usedAt 置 + token 全撤 + outbox 1 条 deletion-requested', async () => {
    const phone = '+8613800180001';
    const acc = await prisma.account.create({ data: { phone, status: 'ACTIVE' } });
    const token = await login(phone); // 落 1 条 active refresh token
    const code = await sendDeletionCode(phone, token);

    const before = Date.now();
    const res = await submitDeletion(token, code);
    const after = Date.now();

    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe('');

    // 账号 FROZEN + freezeUntil ≈ now+15d。
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('FROZEN');
    const freezeMs = reloaded.freezeUntil!.getTime();
    expect(freezeMs).toBeGreaterThanOrEqual(before + FIFTEEN_DAYS_MS - 10_000);
    expect(freezeMs).toBeLessThanOrEqual(after + FIFTEEN_DAYS_MS + 10_000);

    // 码 usedAt 置 (active 码归零)。
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: acc.id, purpose: 'DELETE_ACCOUNT' },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.usedAt).not.toBeNull();

    // 该账号全部 refresh token 撤销。
    const tokens = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    // outbox 1 条 auth.account.deletion-requested + payload 逐字段 + producer_context=auth。
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_DELETION_REQUESTED_EVENT_TYPE },
    });
    const mine = events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === acc.id.toString(),
    );
    expect(mine).toHaveLength(1);
    const envelope = mine[0]!.payload as {
      metadata: { producer_context: string; event_version: number };
      data: { accountId: string; freezeAt: string; freezeUntil: string; occurredAt: string };
    };
    expect(envelope.metadata.producer_context).toBe('auth');
    expect(envelope.metadata.event_version).toBe(1);
    expect(envelope.data.accountId).toBe(acc.id.toString());
    expect(envelope.data.freezeUntil).toBe(reloaded.freezeUntil!.toISOString());
    expect(envelope.data.freezeAt).toBe(envelope.data.occurredAt); // 冻结与事件同 tx 同一瞬间
  });

  it('原子性: 注入 revoke 失败 → 整 tx 回滚 (账号仍 ACTIVE / freezeUntil null / 码仍 active / 无事件)', async () => {
    const phone = '+8613800180002';
    const acc = await prisma.account.create({ data: { phone, status: 'ACTIVE' } });
    const token = await login(phone);
    const code = await sendDeletionCode(phone, token);

    // 注入: revokeAllForAccount 抛 → DeleteAccountUseCase tx 内第 3 步失败 → 整 tx 回滚。
    const spy = vi
      .spyOn(refreshTokenService, 'revokeAllForAccount')
      .mockRejectedValueOnce(new Error('revoke fixture boom'));

    const res = await submitDeletion(token, code);
    // 未捕获 infra 错 → ProblemDetailFilter 映射 500 (不静默成功)。
    expect(res.statusCode).toBe(500);

    spy.mockRestore();

    // 账号未变。
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('ACTIVE');
    expect(reloaded.freezeUntil).toBeNull();

    // 码仍 active (markUsed 已随 tx 回滚)。
    const codes = await prisma.accountSmsCode.findMany({
      where: { accountId: acc.id, purpose: 'DELETE_ACCOUNT' },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.usedAt).toBeNull();

    // 无事件。
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_DELETION_REQUESTED_EVENT_TYPE },
    });
    const mine = events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === acc.id.toString(),
    );
    expect(mine).toHaveLength(0);
  });
});
