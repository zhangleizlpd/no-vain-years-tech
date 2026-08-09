import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { OutboxEventPrismaPublisher } from '../security/outbox/outbox-event.prisma.publisher';
import { CommitPhoneLoginUseCase } from './commit-phone-login.usecase';
import { ACCOUNT_CREATED_EVENT_TYPE } from './account-created.event';

describe('CommitPhoneLoginUseCase (Testcontainers PG) — find-or-create + login + event', () => {
  let prisma: PrismaService;
  let useCase: CommitPhoneLoginUseCase;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    const url = db.databaseUrl;

    prisma = new PrismaService(url);
    // OutboxEventPrismaPublisher 无 ClsService 时合成 out-of-request trace_id fallback。
    useCase = new CommitPhoneLoginUseCase(prisma, new OutboxEventPrismaPublisher());
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('unregistered phone → creates ACTIVE account + AccountCreatedEvent outbox row', async () => {
    const phone = '+8613900139201';
    const { accountId } = await useCase.execute(phone);

    const rows = await prisma.account.findMany({ where: { phone } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(accountId);
    expect(rows[0]!.status).toBe('ACTIVE');
    expect(rows[0]!.lastLoginAt).toBeInstanceOf(Date);

    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_CREATED_EVENT_TYPE },
    });
    const matching = events.filter((e) => {
      const p = e.payload as { data?: { phone?: string } };
      return p?.data?.phone === phone;
    });
    expect(matching).toHaveLength(1);
    expect(matching[0]!.publishedAt).toBeNull();
  });

  it('existing account → updates lastLoginAt, no new account row, no new event', async () => {
    const phone = '+8613900139202';
    const first = await useCase.execute(phone);
    const eventsBefore = await prisma.outboxEvent.count({
      where: { eventType: ACCOUNT_CREATED_EVENT_TYPE },
    });
    const before = await prisma.account.findUniqueOrThrow({ where: { phone } });

    await new Promise((r) => setTimeout(r, 5));
    const second = await useCase.execute(phone);

    expect(second.accountId).toBe(first.accountId);
    const after = await prisma.account.findUniqueOrThrow({ where: { phone } });
    expect(after.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(before.lastLoginAt!.getTime());
    expect(await prisma.account.count({ where: { phone } })).toBe(1);
    // login (existing) 不再 publish AccountCreatedEvent
    const eventsAfter = await prisma.outboxEvent.count({
      where: { eventType: ACCOUNT_CREATED_EVENT_TYPE },
    });
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('two parallel commits for same NEW phone → 1 account row + same accountId (FR-S08 race)', async () => {
    const phone = '+8613900139777';

    const results = await Promise.all([useCase.execute(phone), useCase.execute(phone)]);

    expect(results).toHaveLength(2);
    expect(results[0]!.accountId).toBe(results[1]!.accountId);

    const rows = await prisma.account.findMany({ where: { phone } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(results[0]!.accountId);
  });
});
