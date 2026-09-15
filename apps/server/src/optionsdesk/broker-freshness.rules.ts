import type { TradingDayStatus } from '../marketdata/trading-calendar.port';
import type { BrokerMarket } from './broker-code.rules';
import { RECONCILE_SLOT_MINUTES, type ExchangeClockReading } from './broker-sync-slot.rules';

/**
 * 083 券商持仓**数据陈旧判定**纯函数 (plan D7; FR-009)。无 I/O、无 DI (ADR-0043 §4)。
 *
 * 判定时点 = **最近一个已过宽限的对账时点**: 今天 (非 `non-trading`) 已过「时点 + 宽限」⇒ 今天的
 * 时点; 否则 ⇒ 上一交易日的时点。陈旧 ⇔ 最近成功同步早于判定时点。
 *
 * 🚨 🚫 「只看今天时点 + 宽限」: 那样写, 前天同步、今天仍在宽限内时数据已旧两天却不提示
 * (analyze H5)。
 *
 * 两段拆开是因为上一交易日要经 `TradingCalendarPort.previousTradingDay` 异步取, 且只在需要时才调:
 * 调用方先 {@link resolveJudgementSlot}, 为 `'previous-trading-day'` 时取日期, 再 {@link isStale}。
 *
 * 🚨 **本文件不做时区换算、不另写对账时点**: 当地读数由调用方用 `exchangeClock` 算好;
 * 时点只 import {@link RECONCILE_SLOT_MINUTES} (全仓唯一定义)。
 */

/** 宽限分钟数: 覆盖 082 同日 3 次 × 15 分钟重试 (spec Assumptions)。 */
export const STALE_GRACE_MINUTES = 60;

export type JudgementSlot = 'today' | 'previous-trading-day';

export interface JudgementSlotInput {
  market: BrokerMarket;
  /** 请求时刻的交易所当地读数 (`exchangeClock(market, now)`)。 */
  nowLocal: ExchangeClockReading;
  /** `TradingCalendarPort.classify(market, nowLocal.date)`。 */
  todayStatus: TradingDayStatus;
}

/**
 * 判定时点落在今天还是上一交易日。`unknown` 按交易日处理 (同 082 对账调度)。复杂度 O(1)。
 */
export function resolveJudgementSlot({
  market,
  nowLocal,
  todayStatus,
}: JudgementSlotInput): JudgementSlot {
  if (
    todayStatus !== 'non-trading' &&
    nowLocal.minutesOfDay >= RECONCILE_SLOT_MINUTES[market] + STALE_GRACE_MINUTES
  ) {
    return 'today';
  }
  return 'previous-trading-day';
}

export interface StaleInput {
  market: BrokerMarket;
  /**
   * 判定时点所在的交易所当地日期: `'today'` ⇒ `nowLocal.date`; `'previous-trading-day'` ⇒
   * `previousTradingDay(market, nowLocal.date)` 的结果。**`null` = 调用方拿不到上一交易日。**
   */
  judgementDate: string | null;
  /** 最近一次成功同步时刻的交易所当地读数; 从未成功 ⇒ `null`。 */
  lastSyncLocal: ExchangeClockReading | null;
}

export interface StaleResult {
  stale: boolean;
  /** 判定时点不可得 ⇒ 不标陈旧, 由调用方记 warn。 */
  undeterminable: boolean;
}

/**
 * 最近成功同步是否早于判定时点 (`judgementDate`, 对账时点分钟)。复杂度 O(1)。
 *
 * 🚨 `judgementDate === null` ⇒ 不可判定: 🚫 回落日历日 —— 端口契约「null = 不可判定, 调用方
 * MUST NOT 猜」(`trading-calendar.port.ts` `previousTradingDay`)。
 *
 * 分钟粒度比较与时点对齐: 读数截断到分钟, 时点本身是整分钟 ⇒ 落在时点那一分钟内即「不早于」。
 */
export function isStale({ market, judgementDate, lastSyncLocal }: StaleInput): StaleResult {
  if (judgementDate === null) return { stale: false, undeterminable: true };
  if (lastSyncLocal === null) return { stale: false, undeterminable: false };
  // `YYYY-MM-DD` 字典序 = 时间序。
  const stale =
    lastSyncLocal.date < judgementDate ||
    (lastSyncLocal.date === judgementDate &&
      lastSyncLocal.minutesOfDay < RECONCILE_SLOT_MINUTES[market]);
  return { stale, undeterminable: false };
}
