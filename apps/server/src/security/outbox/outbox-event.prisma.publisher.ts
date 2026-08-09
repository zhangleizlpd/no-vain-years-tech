import { randomUUID } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { OutboxPublisher } from './outbox-publisher.port';
import {
  OutboxEventEnvelopeSchema,
  type OutboxEventEnvelope,
} from './outbox-event-envelope.schema';

/**
 * OutboxEventPrismaPublisher — writes domain events to `outbox_event` (FR-S11,
 * per ADR-0033 envelope enforcement).
 *
 * Internal contract:
 *   - Caller transparent: 仍传 `(client, eventType, data: Record<string, unknown>)`
 *     3 个参数。
 *   - Publisher 内部把 flat data 封进 ADR-0033 `OutboxEventEnvelope`:
 *       { metadata: { trace_id, occurred_at, event_version, producer_context }, data }
 *   - trace_id 来源: `ClsService.getId()` (HTTP req `x-trace-id` via nestjs-cls
 *     middleware) → fallback `out-of-request-<uuid>` 当 ClsService 未注入或
 *     getId() 空 (cron / worker / out-of-request 触发)。
 *   - Envelope 经 `OutboxEventEnvelopeSchema.parse()` 校验后写入
 *     `outbox_event.payload` jsonb 列, 不写 outbox_event 表新列 (per ADR-0033
 *     决策点 1)。
 *
 * Transaction model: caller MUST pass Prisma client / TransactionClient as
 * `client` 首参, 让 publish 与业务写共享 tx, 业务 rollback 时 outbox 行也撤。
 * Port 用 `unknown` 不泄露 Prisma 到 domain; 内部 narrow 到 outbox_event.create。
 *
 * ClsService 注入用 `@Optional()` — 让 race spec 等无 DI 上下文的测试可
 * `new OutboxEventPrismaPublisher()` 直接构造, fallback trace_id 路径覆盖。
 */
type PrismaOutboxClient = {
  outboxEvent: {
    create: (args: {
      data: {
        eventType: string;
        payload: unknown;
        publishedAt: Date | null;
      };
    }) => Promise<unknown>;
  };
};

const DEFAULT_EVENT_VERSION = 1;
const DEFAULT_PRODUCER_CONTEXT = 'auth';

@Injectable()
export class OutboxEventPrismaPublisher implements OutboxPublisher {
  constructor(@Optional() private readonly cls?: ClsService) {}

  async publish(
    client: unknown,
    eventType: string,
    data: Record<string, unknown>,
    producerContext: string = DEFAULT_PRODUCER_CONTEXT,
  ): Promise<void> {
    const envelope: OutboxEventEnvelope = OutboxEventEnvelopeSchema.parse({
      metadata: {
        trace_id: this.resolveTraceId(),
        occurred_at: new Date().toISOString(),
        event_version: DEFAULT_EVENT_VERSION,
        producer_context: producerContext,
      },
      data,
    });

    const c = client as PrismaOutboxClient;
    await c.outboxEvent.create({
      data: {
        eventType: eventType,
        payload: envelope,
        publishedAt: null,
      },
    });
  }

  private resolveTraceId(): string {
    const fromCls = this.cls?.getId();
    if (typeof fromCls === 'string' && fromCls.length > 0) {
      return fromCls;
    }
    return `out-of-request-${randomUUID()}`;
  }
}
