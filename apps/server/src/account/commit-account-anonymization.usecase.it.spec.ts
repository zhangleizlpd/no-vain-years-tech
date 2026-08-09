import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupIsolatedStores } from '../../test/_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { AccountModule } from './account.module';
import { narrowTestModule } from '../../test/_support/narrow-boot';
import { PrismaService } from '../security/prisma.service';
import { RefreshTokenService } from '../security/refresh-token.service';
import { hashPhone } from '../security/phone-hasher';
import { CommitAccountAnonymizationUseCase } from './commit-account-anonymization.usecase';
import { ACCOUNT_ANONYMIZED_EVENT_TYPE } from './account-anonymized.event';

const DAY_MS = 24 * 60 * 60 * 1000;
const HMAC_SECRET = 'anon-it-hmac-secret-min-32-bytes-pad-zzzzzz';

// T026: FROZEN(grace 期满) → ANONYMIZED 终态 (account 持 tx, scheduler 逐行触发)。
// 全 boot 取真 RefreshTokenService + OutboxPublisher (依赖较多, 不手构)。
//  - FROZEN-expired → 匿名化逐字段 + token 撤 + 事件
//  - FROZEN-in-grace → count0 skip (won=false)
//  - phone-null → 领域拒绝 skip
//  - revoke 抛 → 整行 tx 回滚 (无匿名化 / 无事件)
describe('CommitAccountAnonymizationUseCase (Testcontainers full boot)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let refreshTokenService: RefreshTokenService;
  let usecase: CommitAccountAnonymizationUseCase;
  let seq = 0;

  beforeAll(async () => {
    stores = await setupIsolatedStores();

    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'anon-it-jwt-secret-min-32-bytes-pad-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = HMAC_SECRET;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([AccountModule]),
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    refreshTokenService = moduleRef.get(RefreshTokenService);
    usecase = moduleRef.get(CommitAccountAnonymizationUseCase, { strict: false });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  const nextPhone = () => `+861380070${String(++seq).padStart(4, '0')}`;
  const expired = () => new Date(Date.now() - 60_000);

  async function frozenExpired(phone: string) {
    return prisma.account.create({
      data: { phone, status: 'FROZEN', freezeUntil: expired() },
    });
  }

  it('FROZEN-expired → won: 逐字段匿名化 (phone null / displayName / previousPhoneHash) + token 撤 + outbox 1 条', async () => {
    const phone = nextPhone();
    const acc = await frozenExpired(phone);
    await refreshTokenService.persist(acc.id, 'raw-refresh-token-1', { loginMethod: 'PHONE_SMS' });

    const now = new Date();
    const { won } = await usecase.execute(acc.id, now);
    expect(won).toBe(true);

    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('ANONYMIZED');
    expect(reloaded.phone).toBeNull();
    expect(reloaded.displayName).toBe('已注销用户');
    expect(reloaded.freezeUntil).toBeNull();
    // previousPhoneHash = HMAC(原 phone) — 清 phone 前捕获。
    expect(reloaded.previousPhoneHash).toBe(hashPhone(phone, HMAC_SECRET));

    // 该账号全部 refresh token 撤销。
    const tokens = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    // outbox 1 条 account.account.anonymized + producer_context=account。
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_ANONYMIZED_EVENT_TYPE },
    });
    const mine = events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === acc.id.toString(),
    );
    expect(mine).toHaveLength(1);
    expect(
      (mine[0]!.payload as { metadata: { producer_context: string } }).metadata.producer_context,
    ).toBe('account');
  });

  it('FROZEN-in-grace (freezeUntil 未来) → count0 skip (won=false): 状态不变', async () => {
    const acc = await prisma.account.create({
      data: {
        phone: nextPhone(),
        status: 'FROZEN',
        freezeUntil: new Date(Date.now() + 5 * DAY_MS),
      },
    });
    const { won } = await usecase.execute(acc.id, new Date());
    expect(won).toBe(false);
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('FROZEN');
    expect(reloaded.phone).not.toBeNull();
  });

  it('phone 已 null (重扫已匿名化行) → 领域拒绝 skip (won=false), 不重复发事件', async () => {
    const acc = await prisma.account.create({
      data: { status: 'ANONYMIZED', phone: null, freezeUntil: null, displayName: '已注销用户' },
    });
    const before = await prisma.outboxEvent.count({
      where: { eventType: ACCOUNT_ANONYMIZED_EVENT_TYPE },
    });
    const { won } = await usecase.execute(acc.id, new Date());
    expect(won).toBe(false);
    const after = await prisma.outboxEvent.count({
      where: { eventType: ACCOUNT_ANONYMIZED_EVENT_TYPE },
    });
    expect(after).toBe(before); // 无新事件
  });

  it('revoke 抛 → 整行 tx 回滚 (账号仍 FROZEN / 无事件)', async () => {
    const acc = await frozenExpired(nextPhone());
    const beforeEvents = await prisma.outboxEvent.count({
      where: { eventType: ACCOUNT_ANONYMIZED_EVENT_TYPE },
    });

    const spy = vi
      .spyOn(refreshTokenService, 'revokeAllForAccount')
      .mockRejectedValueOnce(new Error('revoke fixture boom'));

    await expect(usecase.execute(acc.id, new Date())).rejects.toThrow('revoke fixture boom');
    spy.mockRestore();

    // 账号未匿名化 (整行回滚)。
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('FROZEN');
    expect(reloaded.phone).not.toBeNull();
    expect(reloaded.previousPhoneHash).toBeNull();

    const afterEvents = await prisma.outboxEvent.count({
      where: { eventType: ACCOUNT_ANONYMIZED_EVENT_TYPE },
    });
    expect(afterEvents).toBe(beforeEvents); // 无事件
  });
});
