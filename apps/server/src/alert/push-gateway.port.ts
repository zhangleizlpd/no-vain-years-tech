/**
 * PushGateway port (022 T002) — alert ctx 推送出口 vendor I/O 抽象。
 *
 * external vendor I/O 是 ADR-0043 允许的 port/adapter 场景 (sms gateway 同款,
 * 非自有表 repository)。双实现: MockPushGateway (dev/test 默认, IT 可注入结果) /
 * JpushPushGateway (JPUSH_GATEWAY=jpush, 极光 REST)。
 */

/**
 * Android 通知渠道 id (FR-006 不可变契约)。
 *
 * SoT = packages/types `ALERT_PUSH_CHANNEL_ID` (mobile setNotificationChannelAsync
 * 建渠道用同值)。server 物理无法消费 TS-source-only workspace 包 (swc CJS dist +
 * 裸 node 运行不识 `no-vain-years-mono` custom condition) → 本地副本 + 注释互指
 * (2026-06-07 user 拍板, plan D10 impl 修正)。改值必须双端同步换 `_v2`。
 */
export const ALERT_PUSH_CHANNEL_ID = 'nvy_alert_v1';

export const PUSH_GATEWAY = Symbol('PUSH_GATEWAY');

/** 推送域输入 — gateway adapter 负责拼 vendor payload (plan §payload 形态)。 */
export interface PushSendInput {
  registrationId: string;
  title: string;
  body: string;
  triggerId: bigint;
}

/**
 * 三分类结果 (dispatch worker 标态依据, plan D4):
 * - ok            → SENT
 * - retryable     → attempts+1 + backoff; 耗尽 → FAILED (5xx / 网络 / 429 限流 /
 *                   其他 4xx 兜底 — 绝不因含糊错误误删 binding)
 * - invalid_target→ FAILED_INVALID + 删对应 push_binding (FR-010, 仅极光明确
 *                   返回 RegID 无效错误码 1011 时)
 */
export interface PushSendResult {
  kind: 'ok' | 'retryable' | 'invalid_target';
  detail?: string;
}

export interface PushGateway {
  send(input: PushSendInput): Promise<PushSendResult>;
}
