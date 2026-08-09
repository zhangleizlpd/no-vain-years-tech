import type { VendorConstraintProfile } from './vendor-constraint-profile.js';

/**
 * 理杏仁 (Lixinger) 约束画像 (015 T005, plan §R3.115)。
 *
 * perSec:36 = 官方秒限; perMin 取官方 1000/min 的 ~90% = 900, 留 10% 安全余量 (吸收时钟
 * 漂移/重试/vendor 侧窗口误差, Track A (a))。双窗令牌桶长期被慢桶(分桶)钳到 perMin/60 ≈
 * 15/s 稳态。命中 429 = 分钟级封禁, transientWait ≥60s 避免连环触发。JSON body + gzip 是其 API 硬要求。
 */
export const LIXINGER_PROFILE: VendorConstraintProfile = {
  vendor: 'lixinger',
  rateLimit: { perSec: 36, perMin: 900 },
  headers: {
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  },
  retry: { maxAttempts: 3 },
  transientWaitMs: 60_000,
  // 30s: 官方 API 且为**批量** JSON 查询 (一次可带多标的/多指标), 正常耗时高于单点端点 →
  // 留足余量;仍远低于 Node 默认 300s, 熔断最坏 3×30s = 1.5min 而非 15min。
  timeoutMs: 30_000,
};
