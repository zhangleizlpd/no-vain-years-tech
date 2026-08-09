import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { OutboxSubscriberRegistry } from '../security/outbox/outbox-subscriber.registry';
import { OutboxEventCronPublisher } from '../security/outbox/outbox-event-cron.publisher';
import { EnqueueRequirementSubscriber } from './enqueue-requirement.subscriber';

/**
 * P1.5 端到端 IT (Testcontainers PG): outbox 事件 → cron relay → registry dispatch →
 * agent-bridge subscriber → AgentQueueEvent 入队。验 ①入队映射正确 ②relay 重投幂等
 * (sourceEventId @unique) ③坏数据跳过不毒丸 (仍标 published)。
 */
const EVENT_TYPE = 'ideation.requirement-finalized';

function envelope(data: Record<string, string>) {
  return {
    metadata: {
      trace_id: 'test-trace',
      occurred_at: '2026-06-26T10:00:00.000Z',
      event_version: 1,
      producer_context: 'ideation',
    },
    data,
  };
}

describe('agent-bridge outbox enqueue IT (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let cron: OutboxEventCronPublisher;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    const registry = new OutboxSubscriberRegistry();
    registry.register(new EnqueueRequirementSubscriber(prisma, registry)); // 手动注册 (IT 不走 Nest OnModuleInit)
    cron = new OutboxEventCronPublisher(prisma, registry);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.agentQueueEvent.deleteMany({});
    await prisma.outboxEvent.deleteMany({});
  });

  it('ideation.requirement-finalized → 入队 AgentQueueEvent (映射正确) + 标 published', async () => {
    const ev = await prisma.outboxEvent.create({
      data: { eventType: EVENT_TYPE, payload: envelope({ accountId: '777', sessionId: '888' }) },
    });

    const res = await cron.scan();
    expect(res.published).toBe(1);

    const rows = await prisma.agentQueueEvent.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: 777n,
      bizType: 'ideation.requirement',
      bizId: '888',
      sourceEventId: ev.id,
      status: 'pending',
    });

    const outbox = await prisma.outboxEvent.findUnique({ where: { id: ev.id } });
    expect(outbox?.publishedAt).not.toBeNull();
  });

  it('relay 重投同一 sourceEventId → 幂等不重复入队', async () => {
    const ev = await prisma.outboxEvent.create({
      data: { eventType: EVENT_TYPE, payload: envelope({ accountId: '1', sessionId: '2' }) },
    });
    await cron.scan();
    // 模拟重投: 把 outbox 标回 unpublished → 再扫一轮 (dispatch 同 sourceEventId)
    await prisma.outboxEvent.update({ where: { id: ev.id }, data: { publishedAt: null } });
    await cron.scan();

    expect(await prisma.agentQueueEvent.count({ where: { sourceEventId: ev.id } })).toBe(1);
  });

  it('坏 payload (缺 sessionId) → 跳过不入队, 但仍标 published (非毒丸)', async () => {
    const ev = await prisma.outboxEvent.create({
      data: { eventType: EVENT_TYPE, payload: envelope({ accountId: '5' }) },
    });
    const res = await cron.scan();

    expect(res.published).toBe(1); // 标 published (subscriber 跳过不抛)
    expect(await prisma.agentQueueEvent.count({})).toBe(0);
    const outbox = await prisma.outboxEvent.findUnique({ where: { id: ev.id } });
    expect(outbox?.publishedAt).not.toBeNull();
  });
});
