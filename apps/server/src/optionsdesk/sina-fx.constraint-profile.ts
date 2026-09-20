import type { VendorConstraintProfile } from '../marketdata/vendor-constraint-profile';

/**
 * 新浪汇率端点必注入的 Referer。
 *
 * EVIDENCE: 不带即 403, 带即 200 —— `alert/sina-realtime.adapter.ts:7` 记同一事实 (024 PoC
 * 实测), 085 plan §D3 复述。
 */
export const SINA_FX_REFERER = 'https://finance.sina.com.cn';

/**
 * 新浪 FX (`hq.sinajs.cn`) 约束画像 (085 T002, FX **备源**)。同 vendor 自己一个桶。
 *
 * 为什么另起一份而不借腾讯那份: 新浪与腾讯是两个 vendor, 而 `VendorHttpClient` 的既有语义
 * 就是「每个外部源一个实例, 各自持桶与熔断态」(ADR-0047; 先例
 * `futu-shim-trade.constraint-profile.ts` 与 `marketdata/futu-shim.constraint-profile.ts`)。
 * 借用会让备源的失败去推主源的熔断计数。
 *
 * 限频 / 超时取值照 `marketdata/tencent.constraint-profile.ts` 的保守立意: 无公开 SLA 的公开
 * 行情端点, 调用量本就极小 (一次请求取全三对, 其上还有 60s 量级缓存 T003), 且失败交
 * `FxRateFallbackChainAdapter` 降级 —— 不值得为无 SLA 源久等。
 */
export const SINA_FX_PROFILE: VendorConstraintProfile = {
  vendor: 'sina-fx',
  rateLimit: { perSec: 4, perMin: 60 },
  headers: { Referer: SINA_FX_REFERER },
  retry: { maxAttempts: 2 },
  transientWaitMs: 2_000,
  timeoutMs: 10_000,
};
