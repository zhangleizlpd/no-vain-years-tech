import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 注销 / 撤销验证码纯函数 + 常量 (per ADR-0043 §2 零-class)。码生成复用
 * `generateSmsCode()` (sms-code.rules, 6 位 CSPRNG); 哈希与 `sms-code.store`
 * 同 hasher —— HMAC-SHA256 + base64url + crypto.timingSafeEqual (per ADR-0023,
 * verify <1ms 让反枚举 401 路径时延自然均一)。
 *
 * 与 001 login 码的区别: login 码存 Redis (求速、phone-keyed、无 purpose);
 * 注销/撤销码存 DB `account_sms_code` (求原子: markUsed 与状态写同 PG tx,
 * + accountId/purpose 隔离, plan D1)。哈希算法两处一致, 存储介质按原子性需求分。
 */

/** 注销/撤销码有效期 (分钟)。issue 时 expiresAt = now + 此常量。 */
export const DELETION_CODE_TTL_MIN = 10;

/**
 * 短信码用途 —— 落 `account_sms_code.purpose` 列 (VarChar(32)) 的字面值,
 * 同一 accountId 下按 purpose 隔离 (一个发注销码、一个发撤销码互不串)。
 */
export enum SmsPurpose {
  DELETE_ACCOUNT = 'DELETE_ACCOUNT',
  CANCEL_DELETION = 'CANCEL_DELETION',
  // 010 微信解绑码 (FR-S03/S08)。复用本文件全部 hash/compare/TTL 范式,
  // 仅多一个 purpose 字面值 —— account_sms_code.purpose VarChar(32) 容纳, 无 migration。
  UNBIND_WECHAT = 'UNBIND_WECHAT',
}

/** HMAC-SHA256(code) → base64url (43 字符, 入 account_sms_code.code_hash VarChar(64))。 */
export function hashDeletionCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code).digest('base64url');
}

/**
 * 定长时间安全比较: 重算候选码哈希与 stored 比。长度不符 (畸形 stored) → false
 * 不抛。绝不用 `===` (短路泄露前缀匹配长度 = timing oracle)。
 */
export function verifyDeletionCode(code: string, storedHash: string, secret: string): boolean {
  const candidate = hashDeletionCode(code, secret);
  const storedBuf = Buffer.from(storedHash, 'base64url');
  const candidateBuf = Buffer.from(candidate, 'base64url');
  if (storedBuf.length !== candidateBuf.length) return false;
  return timingSafeEqual(storedBuf, candidateBuf);
}
