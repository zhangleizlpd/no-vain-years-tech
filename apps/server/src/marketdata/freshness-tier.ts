/**
 * 046 FR-020 新鲜度分档判据 —— **纯函数, 服务端单源**。
 *
 * 🚨 **为什么判据在 server 而不是客户端**: 「陈旧」= 数据的业务日落后于**最近一个已收盘
 * 交易日**, 而「哪天是最近一个已收盘交易日」要查交易日历 —— 那是 marketdata 的能力, 客户端
 * 没有。046 初版把它写成 `asOf === 设备本地日期`, 对美股**永不可达** (美股 08-04 的 EOD 要到
 * 北京 08-05 清晨才落库, 那时设备已是 08-05) ⇒ 境内用户看到的每一个美股读数都恒显「已过时」,
 * FR-020 想区分的「正常 vs 停在上一交易日」信号完全失效。
 *
 * 判据只有一条: `asOf >= 最近已收盘交易日` 即当期。**用 `>=` 不用 `===`** —— 夜间管线刚落库
 * 完最新一场时, asOf 可能比上界还新 (上界按市场当地收盘时刻推, 见 `lastClosedSessionCutoff`),
 * 那是最新数据, 不是异常。
 */

/** 呈现侧的三档。大写 SNAKE_CASE per `docs/conventions/api-contract.md` § 字段体例。 */
export const FRESHNESS_TIERS = ['CURRENT', 'STALE', 'UNAVAILABLE'] as const;

export type FreshnessTier = (typeof FRESHNESS_TIERS)[number];

/**
 * 某个 `asOf` 的新鲜度档。两个入参都是 `YYYY-MM-DD` (字典序 = 时间序)。复杂度 O(1)。
 *
 * @param asOf 数据**自身**的业务日; 无数据 ⇒ `null` ⇒ `UNAVAILABLE` (不编造日期)。
 * @param lastClosedSession 最近一个已收盘交易日; 交易日历查不到 ⇒ `null`。
 *
 * 🚨 **日历查不到 ⇒ fail-open 判 `CURRENT`**, 与 `marketdata/db-trading-calendar.adapter.ts`
 *    近窗零行时 fail-open 同向。宁可漏报一次陈旧, 也不能重演「全体恒显已过时」—— 后者会让
 *    这个信号被用户整体忽略, 那时真陈旧也没人看。日历自身是否停更由 `calendar_sync_health`
 *    心跳盯着, 不靠这里兜。
 */
export function freshnessTier(
  asOf: string | null,
  lastClosedSession: string | null,
): FreshnessTier {
  if (asOf === null) return 'UNAVAILABLE';
  if (lastClosedSession === null) return 'CURRENT';
  return asOf >= lastClosedSession ? 'CURRENT' : 'STALE';
}
