/**
 * account.deletion-requested 事件 (FR-S03 / FR-S20) — 注销提交冻结成功后 publish。
 *
 * 零 class (per ADR-0043 §2b): event-type 常量 + payload type + builder 纯函数。
 * 经 OutboxPublisher 与冻结写同 1 tx 落 `outbox_event` 表 (R3 CROSS-CONTEXT-ASYNC);
 * 真消费方由后续 use case 加。
 *
 * type 命名遵循 mono `<producer-ctx>.<aggregate>.<action>` 范式 (analyze I1, 同
 * `auth.account.created`): 注销由 **auth 编排**产 → `auth.` 前缀 (producerContext='auth'),
 * aggregate = account, action = deletion-requested。
 */
export const ACCOUNT_DELETION_REQUESTED_EVENT_TYPE = 'auth.account.deletion-requested';

export interface AccountDeletionRequestedEventPayload {
  accountId: string; // bigint stringified
  freezeAt: string; // ISO 8601 — 冻结起始时刻
  freezeUntil: string; // ISO 8601 — 冻结宽限期截止 (freezeAt + 15d)
  occurredAt: string; // ISO 8601 — 事件发生时刻
}

/**
 * bigint id + Date → 序列化 payload。`freezeAt` 与 `occurredAt` 取同一 `occurredAt`:
 * 冻结 UPDATE 与事件落 outbox 共享 caller tx 内同一 `now`,二者恒为同一瞬间
 * (无需分别传入)。`freezeUntil` 由 caller 算 (now + FREEZE_DURATION_DAYS)。
 */
export function buildAccountDeletionRequestedEvent(
  accountId: bigint,
  freezeUntil: Date,
  occurredAt: Date,
): AccountDeletionRequestedEventPayload {
  return {
    accountId: accountId.toString(),
    freezeAt: occurredAt.toISOString(),
    freezeUntil: freezeUntil.toISOString(),
    occurredAt: occurredAt.toISOString(),
  };
}
