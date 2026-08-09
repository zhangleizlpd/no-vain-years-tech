/**
 * OutboxPublisher port (FR-S11 outbox pattern, per ADR-0033).
 *
 * publish() 把 domain event 写入 outbox 表 (published_at = null); 后台 cron job
 * 异步分发 (T041 placeholder; 真消费方由后续 use case 加).
 *
 * Implementation: OutboxEventPrismaPublisher (T029) — 写 `outbox_event` 表
 * (legacy `event_publication` 表已 drop per Plan 2 Phase 0 § 2.2.1)。
 * Impl 内部把 caller 传的 flat `payload` 封进 ADR-0033 envelope shape
 * `{ metadata: { trace_id, occurred_at, event_version, producer_context }, data }`
 * 写入 `outbox_event.payload` jsonb 列;trace_id 自动从 `ClsService` 取
 * (HTTP req `x-trace-id`), out-of-request 时 publisher synth fallback。
 *
 * Transaction model: caller MUST pass the Prisma client (or TransactionClient
 * from $transaction) as `client` so publish 与业务写共享同一 tx, 避免
 * 业务 rollback 后 outbox row 残留. Port 用 `unknown` 不泄露 Prisma 到 domain;
 * infra impl 内 narrow 到具体 Prisma 类型.
 *
 * `producerContext` (可选, 默认 `'auth'`) — 标 envelope `metadata.producer_context`
 * = 发事件的 bounded context。auth 编排产的事件用默认 'auth'; account 自持 tx 产的
 * 事件 (如 AnonymizedEvent) 显式传 'account' (T004, 跨 ctx publisher 出现起)。
 */
export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');

export interface OutboxPublisher {
  publish(
    client: unknown,
    eventType: string,
    payload: Record<string, unknown>,
    producerContext?: string,
  ): Promise<void>;
}
