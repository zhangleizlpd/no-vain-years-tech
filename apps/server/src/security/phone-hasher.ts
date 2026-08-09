import { createHmac } from 'node:crypto';

/**
 * Phone HMAC hasher (FR-S14 — 匿名化捕获 previousPhoneHash)。
 *
 * 手机号是低熵空间 (~14 亿大陆号), 明文 SHA-256 可被彩虹表反查 → 泄漏「某匿名账号
 * 曾属某手机号」。故用 **HMAC-SHA256 + secret** (沿用 ADR-0023 对低熵值用 HMAC 的
 * 原则, 复用 SMS_CODE_HMAC_SECRET) → 64 hex, 匹配 `account.previous_phone_hash`
 * VarChar(64)。platform 层纯函数 (镜像 refresh-token-hasher, 但 HMAC + 显式 secret)。
 */
export function hashPhone(phone: string, secret: string): string {
  return createHmac('sha256', secret).update(phone, 'utf8').digest('hex');
}
