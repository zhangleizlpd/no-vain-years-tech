/**
 * account.deletion-cancelled 事件 (FR-S09 / FR-S20) — 撤销注销解冻成功后 publish。
 *
 * 零 class (per ADR-0043 §2b): event-type 常量 + payload type + builder 纯函数。
 * 经 OutboxPublisher 与解冻写 (FROZEN→ACTIVE) 同 1 tx 落 `outbox_event` 表
 * (R3 CROSS-CONTEXT-ASYNC); 真消费方由后续 use case 加。
 *
 * type 命名遵循 mono `<producer-ctx>.<aggregate>.<action>` 范式 (analyze I1, 同
 * `auth.account.created` / `auth.account.deletion-requested`): 撤销由 **auth 编排**产 →
 * `auth.` 前缀 (producerContext='auth'), aggregate = account, action = deletion-cancelled。
 */
export const ACCOUNT_DELETION_CANCELLED_EVENT_TYPE = 'auth.account.deletion-cancelled';

export interface AccountDeletionCancelledEventPayload {
  accountId: string; // bigint stringified
  cancelledAt: string; // ISO 8601 — 解冻 (撤销注销) 时刻
  occurredAt: string; // ISO 8601 — 事件发生时刻
}

/**
 * bigint id + Date → 序列化 payload。`cancelledAt` 与 `occurredAt` 取同一 `occurredAt`:
 * 解冻 UPDATE 与事件落 outbox 共享 caller tx 内同一 `now`, 二者恒为同一瞬间。
 */
export function buildAccountDeletionCancelledEvent(
  accountId: bigint,
  occurredAt: Date,
): AccountDeletionCancelledEventPayload {
  return {
    accountId: accountId.toString(),
    cancelledAt: occurredAt.toISOString(),
    occurredAt: occurredAt.toISOString(),
  };
}
