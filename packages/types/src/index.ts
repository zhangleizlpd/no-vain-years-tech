// @nvy/types — cross-package shared type re-exports for the no-vain-years mono.
//
// Per spec 002-account-profile plan D11, these types mirror the Prisma `account`
// schema so mobile (apps/mobile/src/auth) can import them without reaching into apps/server.
//
// Note: @prisma/client in this Prisma 7 custom-output setup does not publish
// schema-specific types via the package entry — types are defined standalone here.

export const AccountStatus = {
  ACTIVE: 'ACTIVE',
  FROZEN: 'FROZEN',
  ANONYMIZED: 'ANONYMIZED',
} as const;

export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

// Spec-named alias matching Prisma enum naming convention (status is String in schema,
// but domain treats it as a closed enum).
export type account_status_enum = AccountStatus;

// Mirrors the relevant fields of the Prisma `account` model row.
export type Account = {
  id: bigint;
  phone: string | null;
  status: AccountStatus;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
};

// The string value type for the DisplayName VO (apps/server/src/auth/domain/display-name.vo.ts).
export type DisplayName = string;

// 022-alert-push-delivery FR-006: Android 通知渠道 id — mobile 建渠道
// (setNotificationChannelAsync) 的 SoT。server 物理无法消费本 TS-source-only 包
// (swc CJS dist + 裸 node 不识 custom condition) → server 侧本地副本在
// apps/server/src/alert/push-gateway.port.ts, 注释互指 (plan D10 impl 修正)。
// Android channel 属性建后不可改（系统级），改强度需双端同步换 `_v2`。
export const ALERT_PUSH_CHANNEL_ID = 'nvy_alert_v1';
