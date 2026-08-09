/**
 * account.created 事件 (FR-S11) — 自动注册路径 publish。
 *
 * 零 class (per ADR-0043 §2b): event-type 常量 + payload type + builder 纯函数,
 * 不包 class。通过 OutboxPublisher 写入 `outbox_event` 表;真消费方由后续 use case 加。
 */
export const ACCOUNT_CREATED_EVENT_TYPE = 'auth.account.created';

export interface AccountCreatedEventPayload {
  accountId: string; // bigint stringified
  phone: string;
  createdAt: string; // ISO 8601
}

/** bigint id + Date → 序列化 payload(accountId stringify / createdAt ISO 8601)。 */
export function buildAccountCreatedEvent(
  accountId: bigint,
  phone: string,
  createdAt: Date,
): AccountCreatedEventPayload {
  return {
    accountId: accountId.toString(),
    phone,
    createdAt: createdAt.toISOString(),
  };
}
