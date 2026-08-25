import {
  SNAPSHOT_SOURCE_EOD,
  SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
  type SnapshotCollectionSpec,
} from './sync-option-snapshot.usecase.js';
import { exchangeCalendarDate } from './session-clock.js';
import { isSessionUnderway, marketNow } from './market-session.rules.js';
import type { SessionKindStatus } from './trading-day.rules.js';

/**
 * 期权快照的**归属判据层**（#181）。纯函数、**零 I/O**、无 DI（ADR-0043 §4）——
 * 日历查询由调用方做完再喂进来。
 *
 * ## 🚨 这条语义不是我们的选择，是 vendor 端点形态强加的
 *
 * 富途 `get_option_snapshot` **不吃日期参数** —— 它永远只回答「**现在**」。
 * ⇒ 一批快照归哪个 session，**完全由「采集时刻相对该市场 session 的位置」决定**：
 *
 * | 采集时刻 | 端点此刻返的是 | 能不能落 | `session_date` |
 * | --- | --- | --- | --- |
 * | 该场**进行中** | **盘中态**，不是任何 session 的收盘价 | 🚫 拒绝 | — |
 * | 该场已收盘（当日盘后） | 该场的收盘态 | ✅ | 该场 |
 * | 已跨进下一个交易日的盘前 | **上一个已收盘 session** 的收盘态 | ✅ | 上一个已收盘 session |
 *
 * 🚫 **MUST NOT 用「执行时刻的日历日」当 `session_date`** —— 日历日 **00:00 就翻页**，
 * 与「这一场收没收盘」毫无关系。队列延迟把 job 挤过午夜就整批标错一天，而
 * `option_daily_snapshot` 的落库是 `createMany(skipDuplicates)` on
 * `(contract_id, session_date, source)` ⇒ **不可逆、不报错、且会静默挡掉次日的真实采集**。
 * 2026-08-25 01:30 prod 实撞（#181）：22:00 那条 21 个维度的长链跑了 3h30m，把港股三个维度
 * 挤到午夜后，2200 行全部标成了一个**还没开盘**的 session。
 *
 * 📌 **也别指望「把 cron 挪到安全时刻」** —— 那是拿「长链跑得完」当假设，而链长随 universe
 * 增长。正确性必须与**执行时刻解耦**：队列再堵只应导致「晚」，MUST NOT 导致「错」。
 *
 * ## 🚨 盘中那一档 MUST 拒绝，不是「标成上一场」
 *
 * 盘中采到的是活报价。若只改归属推导而不拒绝，会把**盘中盘口**贴上「上一场收盘」的标签
 * 写进库 —— 标签看着合理、内容是错的，比标错日期更难查。两件事必须一起做，缺一格就等于没做。
 *
 * ## 为什么判据住在这里，而不在各调用方
 *
 * 本判据此前只存在于**冷启动**路径（`anchor-cold-start.rules.ts` 的 `resolveSnapshotSpec`
 * ＋ use case 里一个独立的 `isSessionUnderway` 闸），而**夜间维度路径从来没有过** ——
 * 它的 `run()` 写死 `sessionDate = 当前日历日` + `source = eod`。#181 正是这个缺口。
 * ⇒ 判据搬到与「冷启动」无关的名字底下，让下一个写采集路径的人**找得到**。
 */

/** {@link resolveSnapshotAttribution} 的入参 —— 贫血投影，日历事实由调用方查好喂进来。 */
export interface SnapshotAttributionInput {
  /** 目标市场（`us` / `hk` / ...）。必须是已登记 session 的市场。 */
  market: string;
  /** 本次采集的**绝对时刻**。 */
  now: Date;
  /**
   * `trading_day` 中 ≤ `sessionWatermark(market, now)` 的**最大交易日**
   * （= 最近一个已收盘交易日）。`null` = 日历缺行。
   */
  lastClosedTradingDay: string | null;
  /** `exchangeCalendarDate(market, now)` 那一天**是不是**该市场的交易日。 */
  todayIsTradingDay: boolean;
  /** {@link lastClosedTradingDay} 的**上一个交易日**；`null` = 日历缺更早的行。 */
  tradingDayBeforeTarget: string | null;
  /** 今天的 session 形态（半日市收盘时刻提前，`unknown` 按整日算）。 */
  todayKind: SessionKindStatus;
}

/** 归属决策：要么给出可直接喂给 `collect` 的声明，要么说明为什么不采。 */
export type SnapshotAttribution =
  | {
      decision: 'collect';
      /**
       * 🚨 **原样喂给 `SyncOptionSnapshotUseCase.collect`，别在调用点重算** ——
       * 重算就是第二处判据，而这套判据错了不报错、只让数字差一天。
       */
      spec: SnapshotCollectionSpec;
      /**
       * 本次采集的 OI 归属日（`YYYY-MM-DD`）。
       *
       * ⚠️ **不喂给 `collect`** —— 它自己按 `spec.mode` 派生。之所以仍在这里给出：单测才能
       * 拿它跟 `collect` 的派生规则对表，谁改坏任一边立刻红。
       *
       * `null` = {@link SnapshotAttributionInput.tradingDayBeforeTarget} 缺行。此时**不复制**
       * `collect` 的兜底（那条兜底连同它的 ERROR 只该有一处），采集照常。
       */
      oiAsOf: string | null;
    }
  /** 该场进行中 ⇒ 此刻的报价不属于任何已收盘 session。调用方按自己的语义记录（终态 / 顺延）。 */
  | { decision: 'skip'; reason: 'session_underway' }
  /** 日历查不到上一个已收盘交易日 ⇒ 不猜日子。 */
  | { decision: 'abandon'; reason: 'calendar_missing' };

/**
 * 定「这批快照该归哪个 session，还是根本不该采」。复杂度 O(1)。
 *
 * 🚨 盘中闸的两个条件**缺一不可**：
 *   ① `isSessionUnderway`「该场进行中」（**含午休**）MUST NOT 换成 `isWithinTradingSession`
 *      —— 后者午休返 `false` ⇒ 放行，而此刻算出的目标日是**上一个交易日** ⇒ 把午休盘口贴上
 *      「上一场收盘」的标签写进库。
 *   ② `todayIsTradingDay` —— `isSessionUnderway` 是**纯时钟**谓词，不看星期也不看日历 ⇒
 *      周六 11:00 它照样返 `true`。少了这一格，**整个周末都采不到上一场的收盘**，而周末
 *      恰是境内用户建锚的高发时段。
 *
 * 🚨 `oiAsOf` 两条路径 MUST NOT 抹平：抹平后永远不会红，但两条路径产出的 OI 差一天，
 * 而活跃度排名与 UI 的 `asOf` 都读它。
 *
 * 🚫 MUST NOT 扩成「补最近 N 天」：只有紧邻的上一个 session 能从当下快照原样补回，
 * 再往前一天拿到的是**错的收盘价**。
 */
export function resolveSnapshotAttribution(input: SnapshotAttributionInput): SnapshotAttribution {
  const { market, now, lastClosedTradingDay: target, todayIsTradingDay, todayKind } = input;

  // 盘中：端点返的是活报价，落成任何 session 的收盘都是错的 ⇒ 拒绝，而不是标成上一场。
  if (
    isSessionUnderway(market, marketNow(market, now).minutesOfDay, todayKind) &&
    todayIsTradingDay
  ) {
    return { decision: 'skip', reason: 'session_underway' };
  }

  if (target === null) {
    // 🚫 不猜：猜错就是一批 `session_date` 标错的脏行，比不补更难发现且要人工回删。
    return { decision: 'abandon', reason: 'calendar_missing' };
  }

  const today = exchangeCalendarDate(market, now);
  // 已进下一个**交易日**的盘前 ⇒ 目标 session 的 OI 已随之翻新，此刻抓到的就是它的真值。
  // 非交易日（周末 / 节假日）不翻新 ⇒ 与「仍在收盘当日」同走 eod。
  const oiRefreshed = today > target && todayIsTradingDay;

  return {
    decision: 'collect',
    spec: {
      sessionDate: target,
      mode: oiRefreshed ? SNAPSHOT_SOURCE_PREMARKET_BACKFILL : SNAPSHOT_SOURCE_EOD,
      marketScope: [market],
      // 绝对时刻原样带过去：DTE 基准要的是「今天离到期还有几天」，拿 `sessionDate` 当基准
      // 会让豁免线在补采路径上系统性偏一天且永远不会红。
      now,
    },
    oiAsOf: oiRefreshed ? target : input.tradingDayBeforeTarget,
  };
}
