import { timingSafeEqual } from 'node:crypto';

/**
 * 通道层鉴权纯函数 (P1.2)。guard (worker-auth.guard.ts) 是 thin DI 包装, 真逻辑在此
 * 便于单测 (对/错/缺 token 三态)。范式同 services/code-index/src/auth.ts。
 */

/** 从 `Authorization: Bearer <token>` 抽 token; 形态不符返回 null。 */
export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const parts = authorization.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) return null;
  return parts[1];
}

/**
 * Constant-time 比对 presented worker token 与配置 expected。**fail-closed**:
 * expected 未配 (null/空) 或 presented 缺失 → 永不授权。长度非机密 (内容才是),
 * 故先比长度安全 (timingSafeEqual 要求等长 Buffer, 不等长直接 false)。
 */
export function isWorkerAuthorized(presented: string | null, expected: string | null): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // length is not secret; content is
  return timingSafeEqual(a, b);
}
