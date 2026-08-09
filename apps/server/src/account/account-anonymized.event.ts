/**
 * account.anonymized 事件 (FR-S14 / FR-S20) — 冻结期满匿名化成功后 publish。
 *
 * 零 class (per ADR-0043 §2b): event-type 常量 + payload type + builder 纯函数。
 * 经 OutboxPublisher 与匿名化写 (FROZEN→ANONYMIZED) 同 1 tx 落 `outbox_event` 表
 * (R3 CROSS-CONTEXT-ASYNC, producerContext='account'); 真消费方由后续 use case 加。
 *
 * type 命名遵循 mono `<producer-ctx>.<aggregate>.<action>` 范式 (analyze I1): 匿名化
 * 由 **account 自身** scheduler 产 → producer=aggregate=account → `account.account.anonymized`
 * (双 account 视觉冗余但与 `auth.account.created` 结构一致; producerContext='account')。
 */
export const ACCOUNT_ANONYMIZED_EVENT_TYPE = 'account.account.anonymized';

export interface AccountAnonymizedEventPayload {
  accountId: string; // bigint stringified
  anonymizedAt: string; // ISO 8601 — 匿名化时刻
  occurredAt: string; // ISO 8601 — 事件发生时刻
}

/**
 * bigint id + Date → 序列化 payload。`anonymizedAt` 与 `occurredAt` 取同一 `occurredAt`:
 * 匿名化 UPDATE 与事件落 outbox 共享 tx 内同一 `now`, 二者恒为同一瞬间。
 */
export function buildAccountAnonymizedEvent(
  accountId: bigint,
  occurredAt: Date,
): AccountAnonymizedEventPayload {
  return {
    accountId: accountId.toString(),
    anonymizedAt: occurredAt.toISOString(),
    occurredAt: occurredAt.toISOString(),
  };
}
