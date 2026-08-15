import { timingSafeEqual } from 'node:crypto';

/**
 * guest 投递通道鉴权纯函数（057）。guard（`guest-upload-auth.guard.ts`）是 thin DI 包装，
 * 真逻辑在此便于单测（对 / 错 / 缺 token 三态）。范式同 `worker-auth.rules.ts`。
 *
 * 🚨 **刻意不复用 `isWorkerAuthorized`**，虽然实现逐行相同：两者比对的是**两把不同的
 * token**，各自的 fail-closed 语义独立。合成一个函数后，将来任何一侧要加约束（比如
 * worker 侧加 token 版本前缀）都会在另一侧产生意料之外的行为，而那种耦合在单测里看不出来。
 * 共享的是**范式**，不是函数体。
 */

/** 从 `Authorization: Bearer <token>` 抽 token；形态不符返回 null。 */
export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const parts = authorization.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) return null;
  return parts[1];
}

/**
 * Constant-time 比对投递方 token 与配置值。**fail-closed**：expected 未配（null / 空）或
 * presented 缺失 → 永不授权 —— 「没配 token」不等于「放行」，等于「关门」。
 *
 * 长度不是机密（内容才是），故先比长度是安全的；`timingSafeEqual` 本身也要求等长 Buffer。
 */
export function isGuestUploadAuthorized(
  presented: string | null,
  expected: string | null,
): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // length is not secret; content is
  return timingSafeEqual(a, b);
}
