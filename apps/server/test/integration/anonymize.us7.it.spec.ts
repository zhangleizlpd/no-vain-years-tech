import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { AccountModule } from '../../src/account/account.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { RefreshTokenService } from '../../src/security/refresh-token.service';
import { hashPhone } from '../../src/security/phone-hasher';
import { AnonymizeFrozenAccountsScheduler } from '../../src/account/anonymize-frozen-accounts.scheduler';
import { ACCOUNT_ANONYMIZED_EVENT_TYPE } from '../../src/account/account-anonymized.event';

const HMAC_SECRET = 'anon-us7-hmac-secret-min-32-bytes-pad-zzz';

// US7 Independent Test (FR-S13/S14/S15): scheduler.run() service-direct 触发。
//  ① FROZEN-expired + N token → ANONYMIZED 逐字段 + token 全撤 + outbox 1 条。
//  ② 隔离 (REQUIRES_NEW): 2 账号其一 revoke 抛 → 抛错行整行回滚留 FROZEN 无事件,
//     另一行成功匿名化。
//  ③ 批次: >100 待匿名化 → 本轮 scanned ≤ 100 (take 上限)。
//  ④ 幂等: FROZEN + phone-null 行被扫 → 领域拒绝 skip, 不报错不发事件。
describe('US7 冻结期满匿名化 scheduler (Testcontainers full boot)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let refreshTokenService: RefreshTokenService;
  let scheduler: AnonymizeFrozenAccountsScheduler;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'anon-us7-jwt-secret-min-32-bytes-pad-abcd';
    process.env.SMS_CODE_HMAC_SECRET = HMAC_SECRET;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([AccountModule]),
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    refreshTokenService = moduleRef.get(RefreshTokenService);
    scheduler = moduleRef.get(AnonymizeFrozenAccountsScheduler, { strict: false });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  // 每用例清表 → scheduler.run() 扫描面隔离 (避免跨用例 FROZEN 残留污染计数)。
  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.accountSmsCode.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.account.deleteMany();
  });

  const nextPhone = () => `+861380071${String(++seq).padStart(4, '0')}`;
  const expired = () => new Date(Date.now() - 60_000);
  const frozenExpired = (phone: string) =>
    prisma.account.create({ data: { phone, status: 'FROZEN', freezeUntil: expired() } });

  async function anonEventsFor(accountId: bigint): Promise<number> {
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_ANONYMIZED_EVENT_TYPE },
    });
    return events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === accountId.toString(),
    ).length;
  }

  it('FROZEN-expired + token → 逐字段匿名化 + token 全撤 + outbox 1 条', async () => {
    const phone = nextPhone();
    const acc = await frozenExpired(phone);
    await refreshTokenService.persist(acc.id, 'raw-tok-a', { loginMethod: 'PHONE_SMS' });
    await refreshTokenService.persist(acc.id, 'raw-tok-b', { loginMethod: 'PHONE_SMS' });

    const stats = await scheduler.run(new Date());
    expect(stats.anonymized).toBe(1);
    expect(stats.failed).toBe(0);

    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('ANONYMIZED');
    expect(reloaded.phone).toBeNull();
    expect(reloaded.displayName).toBe('已注销用户');
    expect(reloaded.freezeUntil).toBeNull();
    expect(reloaded.previousPhoneHash).toBe(hashPhone(phone, HMAC_SECRET));

    const tokens = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    expect(await anonEventsFor(acc.id)).toBe(1);
  });

  it('隔离 (REQUIRES_NEW): 一行 revoke 抛 → 整行回滚留 FROZEN 无事件, 另一行成功', async () => {
    const failAcc = await frozenExpired(nextPhone());
    const okAcc = await frozenExpired(nextPhone());

    // 仅 failAcc 的 revoke 抛 → 其 tx 回滚; okAcc revoke 正常 → 匿名化成功。
    const original = refreshTokenService.revokeAllForAccount.bind(refreshTokenService);
    const spy = vi
      .spyOn(refreshTokenService, 'revokeAllForAccount')
      .mockImplementation((accId, now, tx) =>
        accId === failAcc.id
          ? Promise.reject(new Error('strategy boom'))
          : original(accId, now, tx),
      );
    vi.spyOn(scheduler['logger'], 'warn').mockImplementation(() => undefined);

    const stats = await scheduler.run(new Date());
    spy.mockRestore();

    expect(stats.anonymized).toBe(1);
    expect(stats.failed).toBe(1);

    // failAcc 整行回滚 → 仍 FROZEN, phone 在, 无哈希, 无事件。
    const failReloaded = await prisma.account.findUniqueOrThrow({ where: { id: failAcc.id } });
    expect(failReloaded.status).toBe('FROZEN');
    expect(failReloaded.phone).not.toBeNull();
    expect(failReloaded.previousPhoneHash).toBeNull();
    expect(await anonEventsFor(failAcc.id)).toBe(0);

    // okAcc 成功匿名化 (sibling 不受 failAcc 影响 = REQUIRES_NEW)。
    const okReloaded = await prisma.account.findUniqueOrThrow({ where: { id: okAcc.id } });
    expect(okReloaded.status).toBe('ANONYMIZED');
    expect(await anonEventsFor(okAcc.id)).toBe(1);
  });

  it('批次: >100 待匿名化 → 本轮 scanned 上限 100', async () => {
    await prisma.account.createMany({
      data: Array.from({ length: 101 }, () => ({
        phone: nextPhone(),
        status: 'FROZEN' as const,
        freezeUntil: expired(),
      })),
    });

    const stats = await scheduler.run(new Date());
    expect(stats.scanned).toBe(100); // take 上限, 剩 1 个待下轮
    expect(stats.anonymized).toBe(100);

    const remaining = await prisma.account.count({ where: { status: 'FROZEN' } });
    expect(remaining).toBe(1);
  });

  it('幂等: FROZEN + phone-null 行被扫 → 领域拒绝 skip, 不报错不发事件', async () => {
    const anomalous = await prisma.account.create({
      data: { phone: null, status: 'FROZEN', freezeUntil: expired() },
    });

    const stats = await scheduler.run(new Date());
    expect(stats.skipped).toBe(1);
    expect(stats.failed).toBe(0);

    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: anomalous.id } });
    expect(reloaded.status).toBe('FROZEN'); // 未被匿名化
    expect(await anonEventsFor(anomalous.id)).toBe(0);
  });
});
