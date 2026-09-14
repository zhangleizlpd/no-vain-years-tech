import type { VendorConstraintProfile } from './vendor-constraint-profile.js';

/**
 * 港交所披露易 (hkexnews) 约束画像 (079 T012, plan §D7)。唯一调用方 =
 * `hkex-board-meeting-list.source.ts`：每轮 1 次 GET 公开静态页，无凭据、无 header 要求。
 *
 * ASSUMED: 限频 / 重试 / 超时均为礼貌值 —— 港交所未公布该页的访问限额，本仓无出处，未验证；
 * 错了的后果是被限流 (403 / 429 / 连接被拒) ⇒ 本轮清单来源失败 (T013 计入运行失败、飞书日报标红)，
 * 次日运行重试，不会静默缺数。
 *
 * - 限频 1 次/秒、4 次/分：覆盖「首次 + 客户端内重试 3 次」，超出即是调用方循环的 bug。
 * - `retry.maxAttempts = 3`：只作用于瞬时错 (5xx / 网络 / 超时 / 429)；3xx 与 404 是永久错不重试
 *   (调用方传 `redirect: 'manual'`，见 `VendorRequest.redirect`)。
 * - 超时 30 s：2026-09-14 本机 curl 实测整页 HTTP 200、用时 4.2 s ⇒ 约 7× 余量。
 */
export const HKEXNEWS_PROFILE: VendorConstraintProfile = {
  vendor: 'hkexnews',
  rateLimit: { perSec: 1, perMin: 4 },
  headers: {},
  retry: { maxAttempts: 3 },
  transientWaitMs: 5_000,
  timeoutMs: 30_000,
};
