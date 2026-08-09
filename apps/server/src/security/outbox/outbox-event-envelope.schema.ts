import { z } from 'zod';

/**
 * OutboxEventEnvelope (per ADR-0033) — shape stored in `outbox_event.payload` jsonb.
 *
 * `metadata.trace_id` 强制非空 — 由 publisher 内部从 `ClsService.getId()`(HTTP req
 * `x-trace-id` → nestjs-cls middleware) 取, out-of-request 场景 (cron / worker
 * trigger) publisher 合成 `out-of-request-<uuid>` fallback。
 *
 * `producer_context` 由 publisher.publish() 的 `producerContext` 入参决定 (默认 `'auth'`,
 * per ADR-0033 决策点 4); account 自持 tx 产的事件 (AnonymizedEvent) 显式传 `'account'` (T004)。
 *
 * Envelope 在 publisher.publish() 入口被 `OutboxEventEnvelopeSchema.parse()`
 * 拦截; 任何字段缺失 / 类型错都 fail-fast 拒写表, 不会留 partial row。
 */
export const OutboxEventEnvelopeSchema = z.object({
  metadata: z.object({
    trace_id: z.string().min(1),
    occurred_at: z.string().datetime(),
    event_version: z.number().int().min(1),
    producer_context: z.string().min(1),
  }),
  data: z.record(z.string(), z.unknown()),
});

export type OutboxEventEnvelope = z.infer<typeof OutboxEventEnvelopeSchema>;
