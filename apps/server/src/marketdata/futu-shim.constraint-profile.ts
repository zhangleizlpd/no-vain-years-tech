import type { VendorConstraintProfile } from './vendor-constraint-profile.js';

/**
 * 富途 shim 约束画像 (sellput-viz Phase 1, US 交易日历 L1)。
 *
 * shim = 港机 (账号 C) 上 OpenD 的 HTTP 薄壳 (`services/futu-shim/`), 经 B↔C WireGuard
 * 隧道访问 —— **对 server 而言它就是又一个 vendor** (p3b §4.2), 故照常走
 * `VendorHttpClient` 的限频 / 退避 / 熔断, 不为「自家服务」开后门。
 *
 * 🚨 **限频是第二道闸, 不是唯一一道**: shim 侧已按官方值 (p3b E9: `trading_days` 30 次/30s)
 * 装了硬闸并对超限返 429。此处取**更保守**的 20/min —— 日历填充日常只 1 次调用/日, 富余巨大;
 * 宁可这侧先排队, 也不让 429 有机会消耗富途账号的配额窗。
 *
 * **`headers` 空是刻意的**: Bearer token 来自 config (`FUTU_SHIM_TOKEN`), 而 profile 是静态
 * 常量 —— 凭证不进常量, 由 adapter 逐请求注入 (`VendorRequest.headers`)。
 *
 * `transientWaitMs` 取小值同 `TENCENT_PROFILE` 立意: 失败交
 * `CalendarSourceFallbackChain` 降级腾讯, 不值得为一个源长等。
 */
export const FUTU_SHIM_PROFILE: VendorConstraintProfile = {
  vendor: 'futu-shim',
  rateLimit: { perSec: 1, perMin: 20 },
  headers: {},
  retry: { maxAttempts: 2 },
  transientWaitMs: 2_000,
  // 60s (全 vendor 最宽): shim 背后是 OpenD, `kline` 单次可拉**10 年**日线 (us_equity_bar
  // 的 historyDepth=3650), 且链路多一跳 B↔C WireGuard 隧道 —— 误杀正常大区间查询的代价
  // (整轮回填失败) 远高于多等 30s。#750 的死 context 已由 shim 侧 /healthz 回收兜住,
  // 本值只管客户端侧不无限挂着。
  timeoutMs: 60_000,
};

/**
 * 期权链能力专用画像 (047 T014, plan D-SHIM)。**同一个 shim, 但自己一个桶。**
 *
 * shim 的限频闸是 **per-capability** 的 (`ratelimit.py` 的 `LIMITS`), 各 capability 的官方
 * 档位差一个数量级 —— `option_chain` **10 次/30 s** vs `expiration_date` / `snapshot`
 * 60 次/30 s。共用 {@link FUTU_SHIM_PROFILE} 那个桶 ⇒ 链发现与日线 / IV 互相吃对方的令牌,
 * 一轮链发现 (12 票 × 10–14 窗) 会把整条 shim 通路挤到 429。故本能力**单起一个实例**
 * (`VendorHttpClient` 的既有语义就是「每个外部源一个实例, 各自持桶与熔断态」, ADR-0047) ——
 * 这不是新抽象, 是同一份数据多一条常量。
 *
 * 🚨 **10 次/30 s 是官方真值, 别「顺手修正」** (Guardrail 5): 2026-08-04 直取
 * `openapi.futunn.com` 官方 get-option-chain 页复核, 原文「每 30 秒内最多请求 10 次获取期权链
 * 接口」。它比别的端点严 6 倍是**真的**, 与 `history_kline` 那次 (有官方 60/30 s 却被挂在最严
 * 兜底、酿成 08-01 回填事故) 是**相反方向**的事。
 *
 * **10/30 s → `{perSec, perMin}` 的换算**: `DualWindowRateLimiter` 只有秒 / 分两个窗, 表达不了
 * 30 s 滑窗 ⇒ 取**均值等价**的 20/min, 再用 `perSec: 1` 压毛刺 (同 {@link FUTU_SHIM_PROFILE}
 * 的取值立意)。⚠️ 诚实记账: 令牌桶满桶时理论上仍可在 30 s 内放出 20 发 —— 客户端侧是**第一道
 * 软闸**, 硬闸在 shim (超限返 429 + `Retry-After`), 而 429 在本片有明确出口
 * (`OptionChainBudgetExhaustedError` → 顺延重入队且不耗 attempts, plan D-SHIM 末条), 不是事故。
 * 拿更严的数字去猜反而会让一轮链发现拖过收盘后的采集窗。
 *
 * 到期日阶梯 (`expiration_date`, 官方 60/30 s) 与链走**同一个实例**: 它每票每日只 1 发
 * (12 票 = 12 发), 挂在更严的桶上零成本, 而多起一个实例只是多一份要维护的状态。
 */
export const FUTU_SHIM_OPTION_CHAIN_PROFILE: VendorConstraintProfile = {
  ...FUTU_SHIM_PROFILE,
  // 熔断 / 日志标识必须与主画像可区分 —— 否则链发现被限频打断时, 日志里看不出是哪条通路。
  vendor: 'futu-shim:option_chain',
  rateLimit: { perSec: 1, perMin: 20 },
};

/**
 * 期权快照能力专用画像 (047 T016, plan D-SHIM)。**同一个 shim, 又是自己一个桶。**
 *
 * 🚫 **MUST NOT 共用 {@link FUTU_SHIM_OPTION_CHAIN_PROFILE}** —— 那个桶按 `option_chain` 的
 * 官方 **10 次/30 s** 配, 比 `snapshot` 的官方 **60 次/30 s** 严 6 倍。挂上去不会红, 只会让
 * 一轮快照 (12 票 × 约 6 批) 白白排队, 严重时拖过收盘后的采集窗; 反过来两者混在一个桶里,
 * 快照的高频还会把链发现挤到 429。shim 侧的限频闸本就是 **per-capability** 的
 * (`ratelimit.py` 的 `LIMITS`), 客户端侧照着分桶才是同构。
 *
 * **60/30 s → `{perSec, perMin}` 的换算**: `DualWindowRateLimiter` 只有秒 / 分两个窗, 表达
 * 不了 30 s 滑窗 ⇒ 取**均值等价**的 120/min, 再用 `perSec: 2` 压毛刺 (同链画像的取值立意)。
 * ⚠️ 诚实记账: 满桶时理论上仍可在 30 s 内放出 60 发 —— 客户端侧是**第一道软闸**, 硬闸在 shim
 * (超限返 429 + `Retry-After`), 而 429 在本片有明确出口 (`OptionSnapshotBudgetExhaustedError`
 * → 顺延重入队且不耗 attempts)。
 */
export const FUTU_SHIM_OPTION_SNAPSHOT_PROFILE: VendorConstraintProfile = {
  ...FUTU_SHIM_PROFILE,
  vendor: 'futu-shim:option_snapshot',
  rateLimit: { perSec: 2, perMin: 120 },
};

/**
 * 财报日历能力专用画像 (047 T018, plan D-SHIM)。**同一个 shim, 第三个自己的桶。**
 *
 * 🚫 **MUST NOT 共用 {@link FUTU_SHIM_OPTION_CHAIN_PROFILE}** —— 那个桶按 `option_chain` 的官方
 * **10 次/30 s** 配, 比 `earnings_calendar` 的官方 **60 次/30 s** 严 6 倍。挂上去不会红, 只会让
 * 一轮财报采集 (约 26 窗, 每窗 1 发) 白白排队; 反过来两者混在一个桶里, 财报的 26 发还会把同夜
 * 的链发现挤到 429。shim 侧的限频闸本就是 **per-capability** 的 (`ratelimit.py` 的 `LIMITS`),
 * 客户端侧照着分桶才是同构。
 *
 * 🚨 **60/30 s 是官方真值** (2026-08-04 直取 `openapi.futunn.com` 复核, 原文「接口限制：30 秒内
 * 最多 60 次请求；分页请求仅首页计入限频统计」)。该 capability 曾**不在** `ratelimit.py` 的
 * `LIMITS` 表内、落最严兜底 10/30 s = 6x 偏严, 已由 T011a 按官方值补登 —— 本常量与它同口径,
 * 别再按兜底值猜。
 *
 * **60/30 s → `{perSec, perMin}` 的换算**: `DualWindowRateLimiter` 只有秒 / 分两个窗, 表达不了
 * 30 s 滑窗 ⇒ 取**均值等价**的 120/min, 再用 `perSec: 2` 压毛刺 (同快照画像的取值立意)。
 * ⚠️ 诚实记账: 满桶时理论上仍可在 30 s 内放出 60 发 —— 客户端侧是**第一道软闸**, 硬闸在 shim
 * (超限返 429 + `Retry-After`), 而 429 在本片有明确出口 (`EarningsCalendarBudgetExhaustedError`
 * → 顺延重入队且不耗 attempts)。
 */
export const FUTU_SHIM_EARNINGS_CALENDAR_PROFILE: VendorConstraintProfile = {
  ...FUTU_SHIM_PROFILE,
  vendor: 'futu-shim:earnings_calendar',
  rateLimit: { perSec: 2, perMin: 120 },
};
