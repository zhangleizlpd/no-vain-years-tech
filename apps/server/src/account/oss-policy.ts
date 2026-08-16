/**
 * Account profile-image upload target — the account-domain concept layered on
 * top of the generic OSS PostObject signer (`integrations/oss/oss-policy.ts`,
 * platform层 per ADR-0058 / 036 D3). The signer is business-agnostic (takes a
 * `keyPrefix`); account maps each target to its `<target>/<accountId>/` prefix +
 * byte ceiling at the call site (`issue-upload-credential.usecase.ts`).
 *
 * 009 profile image upload (per ADR-0045 OQ1). The credential signing logic
 * itself moved to the platform layer so account + ideation share one path.
 */

import { ossPublicBaseUrl, type OssConfig } from '../config/oss.config';

export type ProfileImageTarget = 'avatar' | 'background';
export const PROFILE_IMAGE_TARGETS: readonly ProfileImageTarget[] = ['avatar', 'background'];

/**
 * objectKey → 对外展示 URL。DB 只存 key，URL 每次读时现拼 —— 换展示域 / 换云账号
 * 时零数据迁移（见 `20260816_0035_rename_profile_image_url_to_object_key`）。
 *
 * 两种 null 语义**刻意压成同一个 null**：
 *   - `objectKey === null`  → 用户没设过头像
 *   - OSS `unconfigured`    → dev/test 无凭证，派生不出基址
 * 后者返回 null 而不是裸 key，是因为裸 key 塞进 `<img src>` 只会得到一个指向本站的
 * 404 —— 那比「没有头像」更难排查：客户端看到的是碎图，服务端日志里什么都没有。
 */
export function profileImagePublicUrl(cfg: OssConfig, objectKey: string | null): string | null {
  if (objectKey === null || cfg.kind !== 'aliyun') return null;
  return `${ossPublicBaseUrl(cfg.region, cfg.bucket, cfg.publicBaseUrl)}/${objectKey}`;
}
