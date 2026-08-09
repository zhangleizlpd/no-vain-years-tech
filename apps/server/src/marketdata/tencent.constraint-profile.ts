import type { VendorConstraintProfile } from './vendor-constraint-profile.js';

/**
 * 腾讯 ifzq (`web.ifzq.gtimg.cn`) 约束画像 (044 T004, L1 交易日历源)。
 *
 * 无公开 SLA (公开行情端点, 实测无 robots 策略 —— 返 `{"code":11,...}` 而非 robots 文件)
 * → 限频取**保守**值缓释封禁风险。日历填充调用量本就极小 (日常 3 市场 × 1 片/日; seed CLI
 * 3 市场 × 3 片) → 无需宽配额。失败交 `CalendarSourceFallbackChain` 降级静态日历, 故
 * transientWait 取小值: 不值得为无 SLA 源长等, 快速 fail 让 fallback 接管 (同
 * `EASTMONEY_PROFILE` 立意)。
 */
export const TENCENT_PROFILE: VendorConstraintProfile = {
  vendor: 'tencent',
  rateLimit: { perSec: 4, perMin: 60 },
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Referer: 'https://gu.qq.com/',
  },
  retry: { maxAttempts: 2 },
  transientWaitMs: 2_000,
  // 10s: 单点公开行情端点 (日历一次 1 片), 正常应在秒级返回。同 transientWait 立意 ——
  // 无 SLA 的源不值得久等, 快速 fail 让 `CalendarSourceFallbackChain` 接管静态日历。
  timeoutMs: 10_000,
};
