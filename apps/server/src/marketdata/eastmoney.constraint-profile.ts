import type { VendorConstraintProfile } from './vendor-constraint-profile.js';

/**
 * 东方财富 (Eastmoney) 约束画像 (015 T005, plan §R3.116)。
 *
 * 无公开 SLA (逆向 searchapi) → 限频取**保守**值缓释封禁风险, 失败交 FallbackChain
 * 平移本地 pg_trgm。需伪装浏览器 UA + Referer 否则易被风控拒。transientWait 取小值:
 * 不值得为无 SLA 源长等, 快速 fail 让 fallback 接管。
 */
export const EASTMONEY_PROFILE: VendorConstraintProfile = {
  vendor: 'eastmoney',
  rateLimit: { perSec: 8, perMin: 200 },
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Referer: 'https://www.eastmoney.com/',
  },
  retry: { maxAttempts: 2 },
  transientWaitMs: 2_000,
  // 10s: 逆向 searchapi 单次搜索, 正常秒级返回。同 transientWait 立意 —— 快速 fail 让
  // FallbackChain 平移本地 pg_trgm, 不为无 SLA 源久等。
  timeoutMs: 10_000,
};
