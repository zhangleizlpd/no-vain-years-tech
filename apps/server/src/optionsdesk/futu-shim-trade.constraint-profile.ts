import type { VendorConstraintProfile } from '../marketdata/vendor-constraint-profile';

/**
 * 富途 shim **交易查询面**约束画像 (082 T012, plan D3)。同一个 shim, 自己一个桶。
 *
 * 为什么不复用 marketdata 的实例: marketdata 不导出其 `VendorHttpClient` 实例, 且各能力的
 * 限频档位不同 —— `VendorHttpClient` 的既有语义就是「每个外部源一个实例, 各自持桶与熔断态」
 * (ADR-0047; 先例 `marketdata/futu-shim.constraint-profile.ts` 按 capability 分桶)。
 *
 * 限额按**滚动窗原样声明**, 不做 `{perSec, perMin}` 等价换算 —— 换算会让空闲后首轮桶满突发
 * 超出上游窗 (理由见 `FUTU_SHIM_OPTION_CHAIN_PROFILE` 的 2026-08-09 事故段)。
 *
 * EVIDENCE: 持仓 / 历史成交 / 当日成交 / 历史订单 / 未完成订单五个接口的官方页「接口限制」小节
 * 原文均为「同一账户ID 每 30 秒内最多请求 10 次」—— 2026-09-14 由 082 impl 编排会话直取
 * openapi.futunn.com 各接口页 (plan D2 限频登记同源)。
 * ASSUMED: 账户列表 (`get_acc_list`) 页没有「接口限制」小节, 故同挂本桶 —— 未验证其官方限频;
 * 错了 (官方更严) ⇒ shim 侧 429, 走客户端退避重试, 最坏是一次同步以基础设施失败进入延迟重试,
 * 不会写入任何数据。本调用每次同步至多一发, 松紧无可观测差别。
 *
 * `fetchStockOwners` 打的 `/option-snapshot` 也走本桶: 上游对它的档位更宽, 挂在更严的桶上只会
 * 更早排队; 它每次同步只对「映射查不到的在挂合约」发 1–2 批, 不值得多维护一个实例。
 */
export const FUTU_SHIM_TRADE_PROFILE: VendorConstraintProfile = {
  vendor: 'futu-shim:trade',
  rateLimit: { maxCalls: 10, windowMs: 30_000 },
  // Bearer token 由 adapter 逐请求注入 (凭证不进常量), 同 FUTU_SHIM_PROFILE。
  headers: {},
  // 重试 1 次: shim 侧 `trade_busy` / `trade_timeout` (503) 与 429 走这一次退避; 再失败交调度器
  // 的 15 分钟级延迟重试 (plan D9), 不在一拍内反复打一个忙着的交易 context。
  retry: { maxAttempts: 1 },
  transientWaitMs: 2_000,
  // 15 s 略大于 shim 侧交易调用时限 (`FUTU_TRADE_CALL_TIMEOUT_S` 默认 10 s, plan D2): 让 shim
  // 先以 503 `trade_timeout` 说清楚是交易 context 卡住, 而不是客户端先断开只剩一个 network 错。
  timeoutMs: 15_000,
};
