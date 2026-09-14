import type { exchangeClock } from '../marketdata/session-clock';
import type { TradingDayStatus } from '../marketdata/trading-calendar.port';
import type { BrokerMarket } from './broker-code.rules';

/**
 * 082 调度判定纯函数: 开盘前对账**该不该跑** + 补齐遇基础设施故障后**还重不重试**
 * (plan D9; FR-009 / FR-010 / FR-011)。无 I/O、无 DI (ADR-0043 §4)。
 *
 * 🚨 **本文件不做任何时区换算**: 到点只看调用方用 `exchangeClock` 算好的交易所当地
 * `minutesOfDay` ⇒ 夏令时切换零特殊代码。`TradingDayStatus` 经 port 取 (lint 禁 optionsdesk
 * import `marketdata/*.rules.ts`)。
 *
 * 「上一拍仍在执行 / 同一交易日已有进行中的对账」**不在这里判** —— 防重入靠数据层部分唯一索引
 * (plan D9 ②), 进程内判定挡不住并发直调。
 */

/** 交易所当地读数, 形同 `exchangeClock` 返回值 (`date` 为交易所当地 `YYYY-MM-DD`)。 */
export type ExchangeClockReading = ReturnType<typeof exchangeClock>;

/**
 * 对账时点, 交易所当地分钟数: 美股 09:10 (550)、港股 09:05 (545)。
 * 📌 **POC-6 待复核** (出处 master §4) —— 复核结果出来后**只改这两个值**; 全仓仅此一处定义。
 */
export const RECONCILE_SLOT_MINUTES: Readonly<Record<BrokerMarket, number>> = { us: 550, hk: 545 };

/** 同一交易日对账至多尝试次数 = 首次 + 最多 3 次重试 (spec Clarifications 第 1 条)。 */
export const RECONCILE_MAX_ATTEMPTS = 4;

/** 对账重试 / 补齐重试间隔 (spec Clarifications 第 1 / 5 条)。 */
export const RETRY_SPACING_MS = 15 * 60 * 1000;

/** 补齐基础设施故障重试上限, 自首次尝试起算 (spec Clarifications 第 5 条)。 */
export const BACKFILL_RETRY_CAP_MS = 24 * 60 * 60 * 1000;

/** 对账窗口至少回看的自然日数 (spec Clarifications 第 2 条)。 */
const RECONCILE_MIN_LOOKBACK_DAYS = 7;

export type ReconcileSkipReason =
  | 'before-slot'
  | 'non-trading'
  | 'already-succeeded'
  | 'attempts-exhausted'
  | 'retry-spacing';

export type ReconcileDecision =
  | { action: 'skip'; reason: ReconcileSkipReason }
  | { action: 'run'; windowStart: string };

export interface ReconcileInput {
  market: BrokerMarket;
  clock: ExchangeClockReading;
  /** `TradingCalendarPort.classify(market, clock.date)`。`unknown` 放行, 由调用方 warn。 */
  dayStatus: TradingDayStatus;
  /** 该市场本交易日 (`clock.date`) 已结束的对账记录; 「执行中断」置 failed 的也计入 `failed`。 */
  todaysRuns: { succeeded: number; failed: number; lastFailedAt: Date | null };
  /** 该市场上次成功对账的交易日 `YYYY-MM-DD`; 从未成功 ⇒ `null`。 */
  lastSucceededTradingDate: string | null;
  now: Date;
}

/**
 * 本拍对账判定。判据按序短路: 未到点 → 非交易日 → 已成功 → 尝试用尽 → 距上次失败不足间隔。
 * `lastFailedAt` 为 `null` 时不施加间隔约束。复杂度 O(1)。
 *
 * @throws `clock.date` 不是 `YYYY-MM-DD`。
 */
export function decideReconcile({
  market,
  clock,
  dayStatus,
  todaysRuns,
  lastSucceededTradingDate,
  now,
}: ReconcileInput): ReconcileDecision {
  if (clock.minutesOfDay < RECONCILE_SLOT_MINUTES[market]) {
    return { action: 'skip', reason: 'before-slot' };
  }
  // 🚨 只有确认非交易日才跳: `unknown` (日历未覆盖) 照跑, 否则日历一停摆对账就静默停摆。
  if (dayStatus === 'non-trading') return { action: 'skip', reason: 'non-trading' };
  if (todaysRuns.succeeded > 0) return { action: 'skip', reason: 'already-succeeded' };
  if (todaysRuns.failed >= RECONCILE_MAX_ATTEMPTS) {
    return { action: 'skip', reason: 'attempts-exhausted' };
  }
  if (
    todaysRuns.lastFailedAt !== null &&
    now.getTime() - todaysRuns.lastFailedAt.getTime() < RETRY_SPACING_MS
  ) {
    return { action: 'skip', reason: 'retry-spacing' };
  }

  const floor = minusCalendarDays(clock.date, RECONCILE_MIN_LOOKBACK_DAYS);
  // `YYYY-MM-DD` 字典序 = 时间序。上次成功更早 ⇒ 窗口延长到那天, 缺口一次补齐。
  const windowStart =
    lastSucceededTradingDate !== null && lastSucceededTradingDate < floor
      ? lastSucceededTradingDate
      : floor;
  return { action: 'run', windowStart };
}

export type BackfillRetryDecision =
  | { status: 'pending'; nextAttemptAt: Date }
  | { status: 'failed' };

/**
 * 补齐遇基础设施故障后的去向: 距首次尝试**已满** 24 h ⇒ `failed` (停止重试, 由维护者重新触发);
 * 否则 `pending`, 15 min 后再试。数据无法处理的失败不走这里 (立即 failed)。复杂度 O(1)。
 */
export function decideBackfillAfterInfraFailure({
  firstAttemptedAt,
  now,
}: {
  firstAttemptedAt: Date;
  now: Date;
}): BackfillRetryDecision {
  if (now.getTime() - firstAttemptedAt.getTime() >= BACKFILL_RETRY_CAP_MS) {
    return { status: 'failed' };
  }
  return { status: 'pending', nextAttemptAt: new Date(now.getTime() + RETRY_SPACING_MS) };
}

/**
 * 单次历史查询的跨度上限 (两端日期之差, 自然日)。EVIDENCE: shim 侧 `TRADE_MAX_SPAN_DAYS = 90`,
 * `(end - start).days > 90` ⇒ 400 (`services/futu-shim/src/futu_shim/app.py:173` / `:329-330`)。
 */
export const TRADE_WINDOW_MAX_SPAN_DAYS = 90;

/**
 * 历史窗口 (两端含的 `YYYY-MM-DD`) 切成每段跨度 ≤ {@link TRADE_WINDOW_MAX_SPAN_DAYS} 的段,
 * **相邻段重叠 1 天** (后段 start = 前段 end), 首段 start / 末段 end 与原窗口对齐。
 *
 * 重叠的理由: 券商对这两个日期按哪个时区解释未验证 —— 不重叠时, 若解释时区与交易所当地不同,
 * 段交界处会漏掉一段时刻; 重叠 1 天 + 唯一号去重使结果与之无关 (T014)。
 *
 * 复杂度 O(跨度 / 90)。
 * @throws 日期格式非法, 或 start 晚于 end。
 */
export function splitTradeWindow(window: {
  start: string;
  end: string;
}): { start: string; end: string }[] {
  const end = minusCalendarDays(window.end, 0);
  let start = minusCalendarDays(window.start, 0);
  if (start > end) throw new Error(`历史窗口起点晚于终点: ${window.start} > ${window.end}`);
  const segments: { start: string; end: string }[] = [];
  for (;;) {
    const cap = minusCalendarDays(start, -TRADE_WINDOW_MAX_SPAN_DAYS);
    const segmentEnd = cap < end ? cap : end;
    segments.push({ start, end: segmentEnd });
    if (segmentEnd === end) return segments;
    start = segmentEnd;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` 减 n 个自然日。纯日历运算 (UTC 字段只作承载, 不涉任何时区)。
 * 未复用 `marketdata/dimension-executor.ts` 的 `subtractDays`: 那是 marketdata 执行器内部件,
 * 且对非法串静默产出 `Invalid Date`。
 */
function minusCalendarDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (m === null) throw new Error(`交易所当地日期格式非法 (期望 YYYY-MM-DD): ${date}`);
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - days);
  return new Date(utc).toISOString().slice(0, 10);
}
