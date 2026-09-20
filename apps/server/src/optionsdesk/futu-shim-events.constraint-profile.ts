import type { VendorConstraintProfile } from '../marketdata/vendor-constraint-profile';

/**
 * 富途 shim **推送事件面**约束画像 (084 FR-004; 2026-09-20 从 `FUTU_SHIM_TRADE_PROFILE` 拆出)。
 *
 * **为什么必须与交易查询面分桶**: `/trade/events` 读的是 shim 的进程内环形缓冲, **一发都不打
 * 券商**。shim 侧刻意不为该端点登记券商限频 capability, 并在那里写明了拆不干净的后果
 * (`services/futu-shim/src/futu_shim/app.py:1021-1024`: 「登记会让它与真正打券商的调用共用那份
 * 配额, 把额度消耗在不消耗对方资源的调用上 (而限频的表现是持仓静默不刷新)」)。
 * 而 `FUTU_SHIM_TRADE_PROFILE` 的 `{maxCalls:10, windowMs:30_000}` 是券商对**持仓 / 历史成交 /
 * 当日成交 / 历史订单 / 未完成订单**五个接口的官方限制 (EVIDENCE 见该文件头)。084 把事件轮询
 * 挂进了那个桶 ⇒ 等于在 server 侧亲手复现了 shim 警告过的那个后果。
 *
 * EVIDENCE: 2 秒一拍 (`broker-account.scheduler.ts:40`) = 30 秒 15 发 > 10 发/30 秒, 而
 * `VendorRateLimiter` 超限是**排队 await sleep、不抛** (`vendor-rate-limiter.ts:200-218`) ⇒ 自我
 * 节流且无任何错误留痕。2026-09-20 以本仓真实限频器 + 真实参数驱动 600 拍 (虚拟时钟) 实测:
 * 单次等待恒 10 000 ms、慢拍周期恒 30 000 ms、平均放行间隔 2 985 ms、慢拍占比 9.83% —— 与
 * issue #469 的 prod 观测 (10 076–10 288 ms / 30 秒 / 3 020 ms / 10.2%) 四项独立吻合。
 */
export const FUTU_SHIM_EVENTS_PROFILE: VendorConstraintProfile = {
  vendor: 'futu-shim:events',
  // 🚨 本档**不是** vendor 约束, 是失控护栏: 上游对本端点无限制 (`app.py:1021-1024`)。
  //
  // 取值口径 = 「正常运行永不触及, 真失控仍被封顶」, 🚫 不是容量规划:
  // - 设计节奏是**每连接** 15 发/30 秒 —— 心跳按 `for (const connection of connections)` 逐个
  //   连接各打一次 (`broker-account.scheduler.ts:183`), 而限频器是 adapter 级单例 ⇒ 实际发数
  //   随连接数线性增长。300 发/30 秒 = 20 个连接仍不排队。
  // - 真失控 (漏了 sleep 的紧循环) 是千级/秒, 被本档封在 10 发/秒, 打不满 shim 的 4 个
  //   waitress 线程。
  // ⚠️ 余量取得大是刻意的: 本限频器超限时**排队不抛**, 再次撞上就又是一次无留痕的静默降速
  // (#469 的原形态)。宁可护栏松到几乎不可能触发, 也不要它在连接数悄悄长上去时重新咬人。
  rateLimit: { maxCalls: 300, windowMs: 30_000 },
  // headers 空同 `FUTU_SHIM_TRADE_PROFILE`: Bearer token 由 adapter 逐请求注入, 凭证不进常量。
  headers: {},
  // 重试 1 次同交易面。事件消费失败时游标不前移 (`consume-broker-events.usecase.ts:110`), 下一
  // 拍 2 秒后原样重放 ⇒ 不值得在一拍内反复试。
  retry: { maxAttempts: 1 },
  transientWaitMs: 2_000,
  // 🚫 **不要因为「本端点非阻塞、shim 侧实测 <100 ms」就把超时调小**: 慢的不是 shim, 是链路。
  // server ↔ shim 走券商账号 egress, 1 Mbps 封顶、server 侧实测约 150 KB/s
  // (`services/futu-shim/src/futu_shim/app.py:61-66`)。环形缓冲容量默认 2000 行
  // (`services/futu-shim/src/futu_shim/config.py:109-121`), 长断档后第一次拉取要一次吐完全部
  // 积压 ⇒ 响应体可达 MB 级。调小会让那一拍永远超时、积压永远补不回来。
  // 本次拆桶只改限频与熔断归属, **不改超时语义**: 与交易面同取 15 s。
  timeoutMs: 15_000,
};
