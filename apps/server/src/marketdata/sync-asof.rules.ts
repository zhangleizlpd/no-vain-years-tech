import { DIMENSION_KEYS, type DimensionKey } from './dimension-executor.js';
import { exchangeCalendarDateForScope, sessionWatermarkForScope } from './session-clock.js';

/**
 * 采集**业务日期 (`asOf`) 的求值单点** —— 063 Phase 1, ADR-0066。纯函数、无 I/O、无 DI。
 *
 * ## 它解决的是什么
 *
 * 四个入口各自算 `asOf`, 且算法各不相同 —— tick 与冷启动用市场时区的**日历日**, 两条 CLI 用
 * **宿主日** (对 us 维度错位一天且每周固定丢周五)。四处都不问「这一场收了没有」⇒ 盘中触发即
 * 落半根 K (#103), 而 `daily_bar` 的写路径是 `createMany(skipDuplicates)` ⇒ **永久驻留**。
 *
 * ⇒ 本文件是那四个入口**唯一**的 `asOf` 来源。新增第五个入口时直接调它, 洞不会原样复活
 * (`manual-sync-session-guard.ts` 文件头承认过的那笔债)。
 *
 * ## 🚨 口径为什么落在代码里而不是 `sync_dimension` 的一列
 *
 * `Record<DimensionKey, AsOfBasis>` 让**新增维度不声明口径 = 编译不过**。DB 列做不到这一点
 * (只能靠运行时门禁, 而新维度上线那一刻正是门禁最可能被绕过的时刻)。且「asOf 跟谁走」是
 * **正确性判据不是运维旋钮** —— 它不该能在不改代码的情况下被改掉。
 */

/**
 * asOf 的两种口径。
 *
 * 🚨 声明的是**这个维度的 asOf 该跟谁走**, 与该维度当前是否真的消费 `asOf` 无关 —— 语义先
 * 摆正, 哪天有人开始用它就已经是对的。(现役里 `option_daily_snapshot` 的 `session_date` 取自
 * 执行时刻而非 `asOf`, 见下方注释。)
 */
export const AS_OF_BASIS = ['calendar-day', 'last-completed-session'] as const;

export type AsOfBasis = (typeof AS_OF_BASIS)[number];

/**
 * 逐维度的 asOf 口径。
 *
 * ## Phase 1 的归类规则（保守起点，不是最终归类）
 *
 * 切到 `last-completed-session` 的**只有「盘中触发会落进坏数据」的价格/快照族**；其余一律
 * `calendar-day` —— 那与改动前逐点相同, 零行为变化。判据不是「像不像收盘口径」而是
 * **「一个尚未收盘的 session 混进来会不会产生不可逆的坏行」**：
 *
 * - `eod_bar` / `us_equity_bar` —— `asOf` 是 vendor 区间请求的**右端**。盘中问「今天」时,
 *   富途会返一根**进行中**的日 K (理杏仁返空数组 ⇒ 同一个错只在 us 显形, 2026-08-19 取证),
 *   落库后被 `skipDuplicates` 焊死。右端退到已收盘 session ⇒ 根本不去问那一天。
 * - `underlying_iv_daily` —— 同为 session 粒度; 落库是 upsert 故可自愈, 但没有理由先写错。
 * - `option_daily_snapshot` —— session 粒度且**不可逆** (`createMany(skipDuplicates)` on
 *   `(contract_id, session_date, source)`)。⚠️ **本格当前不改变它的行为**: 它的
 *   `session_date` 取自**执行时刻**的 `marketDateFor`, 不取 `asOf`。它的真闸是
 *   `manual-sync-session-guard` 的 `isSessionComplete` —— 「这一场还没收盘就别采」, 因为
 *   vendor 不提供历史交易日的链快照 ⇒ 正确动作是**拒绝执行**而不是订正日期。列在这里是让
 *   口径**声明为真**, 别让下一个人以为它是 `calendar-day`。
 *
 * 其余 24 个维度保持 `calendar-day` 的两类理由：
 * - **覆盖式快照 / 无 date 概念**（`universe` / `profile` / `hot_snapshot` /
 *   `industry_classification` / `us_index_daily`）——「今天」就是对的口径；
 * - **行日期来自 vendor payload、`asOf` 只是区间右端且披露本就 T+1**（港股事件流 / 报告期 /
 *   量化信号 / `fundamental` / `financial` / `corporate_action` / `announcement`）——
 *   盘中问「今天」拿不到数据, 不存在半根问题; 无实测证据前**不动**。
 *
 * 📌 重新归类需要证据（某维度在盘中真的取回了未完成的当期数据）, 不是凭口径像不像。
 */
export const AS_OF_BASIS_BY_DIMENSION: Record<DimensionKey, AsOfBasis> = {
  universe: 'calendar-day',
  profile: 'calendar-day',
  eod_bar: 'last-completed-session',
  us_equity_bar: 'last-completed-session',
  fundamental: 'calendar-day',
  financial: 'calendar-day',
  corporate_action: 'calendar-day',
  short_selling: 'calendar-day',
  connect_holding: 'calendar-day',
  fund_holding: 'calendar-day',
  fund_company_holding: 'calendar-day',
  index_membership: 'calendar-day',
  volatility: 'calendar-day',
  hot_snapshot: 'calendar-day',
  buyback: 'calendar-day',
  equity_change: 'calendar-day',
  shareholder_change: 'calendar-day',
  allotment: 'calendar-day',
  revenue_segment: 'calendar-day',
  shareholder_snapshot: 'calendar-day',
  employee: 'calendar-day',
  industry_classification: 'calendar-day',
  announcement: 'calendar-day',
  underlying_iv_daily: 'last-completed-session',
  us_index_daily: 'calendar-day',
  option_contract: 'calendar-day',
  option_daily_snapshot: 'last-completed-session',
  earnings_event: 'calendar-day',
};

/** {@link resolveAsOfForDimension} 的入参 —— 贫血投影, 两列都取自 `sync_dimension` 行。 */
export interface AsOfDimensionInput {
  dimensionKey: string;
  /**
   * `sync_dimension.market_scope`。空 = meta 维度 ⇒ 落宿主口径。
   *
   * ⚠️ 允许 `null` / 缺失: 与 `manual-sync-session-guard` 的 `?? []` 同一条纪律 ——
   * 裸 `.map` 一个 `undefined` 会当场 TypeError, 那会把「配置缺一列」升级成「整轮 tick 哑掉 /
   * CLI 崩了」。缺 scope 是另一类配置问题, 两条 CLI 与 tick 各自已有 `sync_dimension 缺行`
   * 的 fail-fast。
   */
  marketScope?: readonly string[] | null;
}

/**
 * 一个维度在 `now` 这一刻的**采集业务日期**。
 *
 * - `calendar-day` ⇒ 交易所当地日历日；scope 跨时区**抛**（没有单一「今天」可言）。
 * - `last-completed-session` ⇒ scope 内**最早**的已收盘 session 上界（最严）；跨时区**不抛**
 *   （「哪一场收了」对多市场恒有意义，取 min 即可）。两者极性刻意相反，见 `session-clock.ts`。
 *
 * 🚨 **未登记的维度键回落 `calendar-day`（= 改动前行为）而不是抛**：`Record` 已在编译期拦住
 * 代码侧的遗漏，能走到这里的只有「DB 里有一行陈旧的 `sync_dimension`」——那属于配置问题，
 * 两条 CLI 与 tick 各自已有 `sync_dimension 缺行` / `DIMENSION_KEYS` 的 fail-fast，
 * 在这里再抛一次只会把「一行配置陈旧」升级成「整轮 tick 哑掉」。
 *
 * 复杂度 O(scope 长度)。
 */
export function resolveAsOfForDimension(dim: AsOfDimensionInput, now: Date): string {
  const basis = isDimensionKey(dim.dimensionKey)
    ? AS_OF_BASIS_BY_DIMENSION[dim.dimensionKey]
    : 'calendar-day';
  const scope = dim.marketScope ?? [];
  return basis === 'last-completed-session'
    ? sessionWatermarkForScope(scope, now)
    : exchangeCalendarDateForScope(scope, now);
}

function isDimensionKey(key: string): key is DimensionKey {
  return (DIMENSION_KEYS as readonly string[]).includes(key);
}
