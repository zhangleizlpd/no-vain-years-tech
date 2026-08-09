import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { CancelDeletionUseCase } from '../../src/auth/cancel-deletion.usecase';
import { CommitAccountAnonymizationUseCase } from '../../src/account/commit-account-anonymization.usecase';
import { SmsPurpose, hashDeletionCode } from '../../src/auth/deletion-code.rules';
import { ACCOUNT_ANONYMIZED_EVENT_TYPE } from '../../src/account/account-anonymized.event';
import { ACCOUNT_DELETION_CANCELLED_EVENT_TYPE } from '../../src/account/account-deletion-cancelled.event';

const TEN_MIN_MS = 10 * 60 * 1000;
const HMAC_SECRET = 'mutex-us8-hmac-secret-min-32-bytes-pad-zz';
const ITERATIONS = 5;

// US8 Independent Test (FR-S16 撤销 ⟷ 匿名化互斥): grace 期满 (freezeUntil<=now) 账号
// 持 active CANCEL_DELETION 码, 并发触发 CancelDeletion + commitAnonymization →
// 终态恒 ANONYMIZED + 撤销恒折叠 401 INVALID_CREDENTIALS + outbox 有 account.anonymized
// 无 account.deletion-cancelled。谓词互斥 (cancel `freezeUntil>now` vs anonymize
// `<=now`, 匿名化含边界恒赢) + 行写锁 serialise 同行; 重复 N 次稳定无 race 异常。
describe('US8 撤销 ⟷ 匿名化互斥 (Testcontainers full boot)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cancelDeletion: CancelDeletionUseCase;
  let commitAnonymization: CommitAccountAnonymizationUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'mutex-us8-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = HMAC_SECRET;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    cancelDeletion = moduleRef.get(CancelDeletionUseCase, { strict: false });
    commitAnonymization = moduleRef.get(CommitAccountAnonymizationUseCase, { strict: false });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  const nextPhone = () => `+861380080${String(++seq).padStart(4, '0')}`;

  async function eventsFor(accountId: bigint, eventType: string): Promise<number> {
    const events = await prisma.outboxEvent.findMany({ where: { eventType } });
    return events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === accountId.toString(),
    ).length;
  }

  it(`grace 期满并发 cancel + anonymize → 终态恒 ANONYMIZED + 撤销 401 (×${ITERATIONS} 稳定)`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const phone = nextPhone();
      const plain = '654321';
      // freezeUntil 已过 (grace expired): anonymize `<=now` 命中, cancel `>now` 不命中。
      const acc = await prisma.account.create({
        data: { phone, status: 'FROZEN', freezeUntil: new Date(Date.now() - 1000) },
      });
      await prisma.accountSmsCode.create({
        data: {
          accountId: acc.id,
          purpose: SmsPurpose.CANCEL_DELETION,
          codeHash: hashDeletionCode(plain, HMAC_SECRET),
          expiresAt: new Date(Date.now() + TEN_MIN_MS),
        },
      });

      // 并发触发: cancel (持正确码) vs anonymize (同账号, now 当前)。
      const [cancelRes, anonRes] = await Promise.allSettled([
        cancelDeletion.execute(phone, plain),
        commitAnonymization.execute(acc.id, new Date()),
      ]);

      // 匿名化恒赢。
      expect(anonRes.status).toBe('fulfilled');
      expect((anonRes as PromiseFulfilledResult<{ won: boolean }>).value.won).toBe(true);

      // 撤销恒折叠 401 INVALID_CREDENTIALS (grace 已过 → ineligible)。
      expect(cancelRes.status).toBe('rejected');
      const reason = (cancelRes as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(UnauthorizedException);
      expect((reason as UnauthorizedException).message).toBe('INVALID_CREDENTIALS');

      // 终态 ANONYMIZED (不被撤销解冻)。
      const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
      expect(reloaded.status).toBe('ANONYMIZED');
      expect(reloaded.phone).toBeNull();

      // outbox: 有 anonymized, 无 cancelled (撤销未发事件)。
      expect(await eventsFor(acc.id, ACCOUNT_ANONYMIZED_EVENT_TYPE)).toBe(1);
      expect(await eventsFor(acc.id, ACCOUNT_DELETION_CANCELLED_EVENT_TYPE)).toBe(0);

      // 撤销未签发新 token (折叠 401, 无 tx)。
      const tokens = await prisma.refreshToken.findMany({ where: { accountId: acc.id } });
      expect(tokens).toHaveLength(0);
    }
  });
});
