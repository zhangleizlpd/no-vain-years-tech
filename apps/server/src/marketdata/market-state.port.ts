/**
 * 市场时段端口 (061 T004, FR-002 / FR-003 / FR-020, plan D7)。**capability-scoped** ——
 * 一个端口 = 一种能力: 「此刻各市场开不开」这件事, 换成别的行情源也是同一份接口, 只换 adapter。
 *
 * ## 🚨 这是**市场级**接口, 不套 `MarketRouted*`
 *
 * 一次调用返回**全部**已登记市场的当前时段, 入参为空 —— 没有 `market`, 更没有 `symbol`。
 * 上游真实的调用形态就是「一拍求一次值, 再按锚的 market 查表」; 套一层按市场路由只会把一发
 * 变成 N 发, 打的还是同一个上游端点、同一个限频桶。照 `EARNINGS_CALENDAR_PORT` 的市场级先例
 * (那条的判据是「接口是不是 per-code」, 本条同理)。
 *
 * ## 🚨🚨 vendor 原始状态串**不出 adapter**
 *
 * 端口对外只有归一后的三态 {@link MarketSession}。白名单判定 (哪些 vendor 状态算「常规交易
 * 时段」) MUST 在 `marketdata` 的 adapter 内做完 —— 让消费端 (`optionsdesk`) 拿原始串自己判,
 * 等于把一份 vendor 值域知识复制到第二个 bounded context 里, 两处必漂移; 而漂移的表现是盘前 /
 * 夜盘被当成常规时段采了盘中价, **没有任何断言会红**。
 *
 * 这条不只是纪律, 还有**机器绊线**: 判白名单的纯函数若落 `marketdata/*.rules.ts`,
 * `optionsdesk` import 它会被 ESLint boundaries 硬拒 (`apps/server/eslint.config.mjs` 里
 * `from: optionsdesk` 的 `disallow` 明列 `marketdata-rules`)。撞红时的正确动作是**把归一化推回
 * adapter**, 不是把它加进 allowlist。
 */

/** DI token。 */
export const MARKET_STATE_PORT = Symbol('MARKET_STATE_PORT');

/**
 * 归一后的时段语义。**白名单**三态, 禁黑名单 (FR-002)。
 *
 * - `regular` —— 常规连续交易时段; **只有它**准采盘中最新成交价 (FR-020)
 * - `other` —— 白名单外的**已知**状态 (盘前 / 盘后 / 夜盘 / 竞价 / 午休 / 闭市 …), 不采
 * - `unknown` —— vendor 给了一个我们没登记过的值 ⇒ 同样不采, 但**留痕**
 *
 * 🚨 `other` 与 `unknown` 分开不是洁癖: 上游对两者的**动作相同** (都不采), 但 `unknown` 额外
 * 意味着「vendor 的值域变了, 得有人去看一眼」。合并成一个值, 值域扩充就永久静默 —— 而下一次
 * 扩充可能恰好是一个**该算常规时段**的新值, 那时表现为「某个时段从此不再采集」且无人知晓。
 */
export type MarketSession = 'regular' | 'other' | 'unknown';

/** 一个市场此刻的时段。 */
export interface MarketSessionState {
  /** canonical market (`us` / `hk`)。 */
  market: string;
  session: MarketSession;
}

export interface MarketStatePort {
  /**
   * 全部已登记市场的当前时段。**单次调用返回全集**, 调用方按 market 查表。
   *
   * 🚨 **源不可得一律 throw, MUST NOT 返回空数组或含糊值** —— 「状态取不到」与「取到了,
   * 现在不是常规时段」对上游是两条不同的分支 (spec `state_branch` 4 vs 2): 前者 fail-closed
   * 不采并**计入失败计数** (累计可触发熔断), 后者只是正常的不采、不计失败。返回空数组会把
   * 前者说成后者 —— 一个真故障从此永远不显形, 现场只看到「盘中价一直没更新」。
   */
  getMarketSessions(): Promise<MarketSessionState[]>;
}
