import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../../test/_support/isolated-db';
import { PrismaService } from '../prisma.service';
import { OutboxEventCronPublisher } from './outbox-event-cron.publisher';
import { OutboxSubscriberRegistry } from './outbox-subscriber.registry';

describe('OutboxEventCronPublisher (Testcontainers PG) — relay 无消费方仍标 published', () => {
  let prisma: PrismaService;
  let cron: OutboxEventCronPublisher;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    const url = db.databaseUrl;

    prisma = new PrismaService(url);
    cron = new OutboxEventCronPublisher(prisma, new OutboxSubscriberRegistry());
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('scan() returns 0 published when outbox empty', async () => {
    const result = await cron.scan();
    expect(result.scanned).toBe(0);
    expect(result.published).toBe(0);
  });

  it('scan() marks unpublished rows as published (placeholder behavior)', async () => {
    await prisma.outboxEvent.create({
      data: {
        eventType: 'auth.test.event',
        payload: { foo: 'bar' },
        publishedAt: null,
      },
    });

    const result = await cron.scan();
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.published).toBeGreaterThanOrEqual(1);

    const unpublished = await prisma.outboxEvent.findMany({
      where: { eventType: 'auth.test.event', publishedAt: null },
    });
    expect(unpublished).toHaveLength(0);
  });
});
