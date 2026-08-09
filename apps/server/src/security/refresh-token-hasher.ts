import { createHash } from 'node:crypto';

/**
 * refresh-token-hasher —— refresh token 的存储哈希 (per ADR-0043 §2 纯函数 helper)。
 *
 * Refresh token = 256-bit CSPRNG 高熵随机串 (见 JwtTokenService.generateRefreshToken),
 * 无彩虹表 / 暴力枚举风险 → 纯 SHA-256 即可,无需 salt / HMAC / bcrypt
 * (per ADR-0023 区分: HMAC + 常量时间比较仅用于*低熵* SMS code 的反枚举/timing 防御;
 * 高熵 token 走 token_hash 唯一索引命中查找,非 secret 逐字节比较)。
 * 输出 64 字符小写 hex,与 DB 列 refresh_token.token_hash (CHAR(64)) 对齐。
 * 预留: M2+ 若需密钥轮换可平替为 keyed HMAC,函数签名不变。
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}
