import type { VendorConstraintProfile } from './vendor-constraint-profile.js';

/**
 * CBOE 官方历史文件约束画像 (046 T012, plan D6)。
 *
 * 源 = `cdn.cboe.com` 上的**官方公开历史 CSV**, 无 auth、无凭证、无配额文档 (p3b E2)。
 * 宿主 = **77 直连**, 不走代理、不经港机 shim (plan D6: shim 职责不扩张)。
 * ⚠️ 「不走代理」在 Node 侧是**默认成立**的 —— undici 不读 `HTTP(S)_PROXY` env, 全仓也没有
 * 任何 `setGlobalDispatcher(new ProxyAgent(...))`。**别为这个源引入全局代理 dispatcher**,
 * 那会把整个进程的所有 vendor 出站一起改道。
 *
 * **`headers` 空是刻意的**: 这是公开 CDN 静态文件, 不需要 UA 伪装 (对比 `EASTMONEY_PROFILE`
 * 那套 UA + Referer 是逆向源的风控绕行), 也没有 Bearer 可注 (对比 `FUTU_SHIM_PROFILE`)。
 *
 * **限频取极保守值**: 日常一天恰 2 次调用 (VIX + VVIX 各一个文件), 富余巨大 —— 宁可这侧先
 * 排队, 也不给一个「无 SLA、无 status page、条款上还很在意被自动抓取」的源任何压力信号。
 *
 * **`retry.maxAttempts = 3` 有实证理由**: p3b E13 记过境内直连 CBOE 拉 ~500KB 响应体
 * **偶发 SSL 截断** (`UNEXPECTED_EOF_WHILE_READING`, 首跑落 1406 行应 2136, 重试才补齐)。
 * VIX 历史文件 471 KB 正在这个量级上。截断在 undici 下表现为 body 读取期抛错
 * (Content-Length 不匹配 → premature close) ⇒ 落进 `TransientVendorError` 走退避重试。
 */
export const CBOE_PROFILE: VendorConstraintProfile = {
  vendor: 'cboe',
  rateLimit: { perSec: 1, perMin: 10 },
  headers: {},
  retry: { maxAttempts: 3 },
  transientWaitMs: 5_000,
  // 30s: 471 KB 文件在 77 上实测 3.1s (2026-08-02) ⇒ ~10× 余量, 够吃境内直连的抖动;
  // 同时把「TCP 连得上但不回数据」的半死连接封在 30s, 不至于静默倒向 Node 默认 300s。
  timeoutMs: 30_000,
};
