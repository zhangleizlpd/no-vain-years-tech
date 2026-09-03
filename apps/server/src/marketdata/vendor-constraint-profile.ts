import type { RateLimit } from './vendor-rate-limiter.js';

/**
 * Vendor Constraint Profile (015 T005, US5 / FR-S09)。
 *
 * 一等公民: 每个外部行情源把「双窗限频 + 必需 header + 退避重试 + 瞬时等待」声明为一份
 * 数据, 由共享 `VendorHttpClient` 统一执行 (ADR-0047) —— 换 vendor 只改 profile + adapter,
 * 传输纪律不重写。
 */
export interface VendorConstraintProfile {
  /** 日志/熔断标识。 */
  vendor: string;
  /**
   * 限频声明。**两种形态, 按上游闸的真实形状选**: `{ perSec, perMin }` 双窗令牌桶 (允许冷启动
   * 突发) / `{ maxCalls, windowMs }` 滚动窗 (零突发容忍)。判据与「为什么不可互相换算」见
   * {@link import('./vendor-rate-limiter.js').RateLimit}。
   */
  rateLimit: RateLimit;
  /** 每请求必需注入的 header (鉴权外的传输约束, 如 Accept-Encoding / UA / Referer)。 */
  headers: Record<string, string>;
  /** 退避重试: 最大重试次数 (首次外, 指数退避由 VendorHttpClient 配置)。 */
  retry: { maxAttempts: number };
  /**
   * 命中 429 (限频) 后, 重试前的最小固定等待 (ms)。理杏仁分钟级封禁 → ≥60s;
   *    出处: p0 探针 2026-07-11 —— 硬限速每分钟 1000 次 / 每秒 36 次, 任一超即 429;
   *    master F4 记「服务端每分钟自检」, ≥60s 由此而来。
   * 无 SLA 的逆向源 (东财) 取小值, 失败交 FallbackChain 兜底。
   */
  transientWaitMs: number;
  /**
   * 单请求超时 (ms) —— 超时即 abort, 由 `VendorHttpClient` 包成 `TransientVendorError`
   * 走退避重试 + 熔断。
   *
   * 🚨 **不设此值 = 静默倒向 Node 默认 300s** (undici `headersTimeout`/`bodyTimeout` 均
   * 默认 300_000ms)。配 `ConsecutiveBreaker(5)` 的连续 5 次才开闸 ⇒ 一个"TCP 连得上但
   * 不回数据"的半死 vendor, 熔断前最坏要烧 5×300s = **25 分钟**, 整个吃在夜间同步窗口里。
   *
   * **取值口径 = 上限保护, 不是 SLA 目标**: 宁可放过慢请求, 也不误杀正常的大区间查询
   * (富途 kline 一次可拉 10 年日线)。故按 vendor 的**最慢正常请求**留足余量取值, 与
   *    出处: p3b E38 实测 —— 单票 2,584 行 / 2016-04-21..2026-07-31。
   * `transientWaitMs` 的立意无关 —— 后者管"被限频后等多久", 本值管"多久算它死了"。
   */
  timeoutMs: number;
}
