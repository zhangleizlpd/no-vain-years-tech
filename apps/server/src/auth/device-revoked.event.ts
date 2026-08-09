/**
 * auth.device.revoked 事件 (FR-S10) — 单设备远程撤销成功后 publish。
 *
 * 零 class (per ADR-0043 §2b): event-type 常量 + payload type + builder 纯函数。
 * 经 OutboxPublisher 与撤销写 (置 revokedAt) 同 1 tx 落 `outbox_event` 表
 * (R3 CROSS-CONTEXT-ASYNC, FR-S11 原子);本 feature 无 in-process 消费方
 * (审计 / 异地登录提醒归后续 use case)。
 *
 * type 命名遵 mono `<producer-ctx>.<aggregate>.<action>` 范式 (analyze 2026-05-26 确认,
 * 同 `auth.account.deletion-requested`): 撤销由 **auth 编排**发起 → `auth.` 前缀
 * (producerContext='auth', 默认值, OutboxPublisher 无需显式传); aggregate = device
 * (首个非 account aggregate, 沿旧 Java DeviceRevokedEvent 域语言); action = revoked。
 */
export const DEVICE_REVOKED_EVENT_TYPE = 'auth.device.revoked';

export interface DeviceRevokedEventPayload {
  accountId: string; // bigint stringified
  recordId: string; // refresh_token 行 PK (撤销标识), bigint stringified
  deviceId: string; // 被撤设备稳定标识
  revokedAt: string; // ISO 8601 — 撤销时刻
  occurredAt: string; // ISO 8601 — 事件发生时刻 (= revokedAt, 同 tx now)
}

/**
 * bigint id + Date → 序列化 payload。`revokedAt` 与 `occurredAt` 取同一 `occurredAt`:
 * 撤销 UPDATE 与事件落 outbox 共享 caller tx 内同一 `now`, 二者恒为同一瞬间
 * (无需分别传入)。
 */
export function buildDeviceRevokedEvent(
  accountId: bigint,
  recordId: bigint,
  deviceId: string,
  occurredAt: Date,
): DeviceRevokedEventPayload {
  return {
    accountId: accountId.toString(),
    recordId: recordId.toString(),
    deviceId,
    revokedAt: occurredAt.toISOString(),
    occurredAt: occurredAt.toISOString(),
  };
}
