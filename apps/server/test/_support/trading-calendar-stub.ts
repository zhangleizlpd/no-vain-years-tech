import type { TradingCalendarPort } from '../../src/marketdata/trading-calendar.port';
import type { TradingDayStatus } from '../../src/marketdata/trading-day.rules';

/**
 * `TRADING_CALENDAR_PORT` 的**测试替身**（062 T010）。
 *
 * 该端口自 T010 起多了 `lastClosedSession`（陈旧度基准），于是每一处手工装配被测对象的地方
 * 都要给一个日历。散着写 inline 对象字面量的代价不是「多写几行」，而是**端口再加方法时要改
 * 几十处**，且每处的默认答案各自发挥 —— 那正是 062 在消灭的形状。
 *
 * 默认值刻意取「**基准不可判定**」（`lastClosedSession → null`）：它让 `freshnessTier` 走既有
 * fail-open 判当期档，等价于改造前「日历表没有该市场的行」那条路径 ⇒ 与本替身无关的用例
 * 行为零变化。要断言具体档位的用例显式 `setLastClosed(...)`。
 */
export interface TradingCalendarStub extends TradingCalendarPort {
  /** 把基准日改成确定值（体例同旧 `tradingDayFindFirst.mockResolvedValue({ date })`）。 */
  setLastClosed(date: string | null): void;
  setStatus(status: TradingDayStatus): void;
  /** 072: 把「某日之前的上一个交易日」改成确定值（默认 null = 不可判定）。 */
  setPreviousTradingDay(date: string | null): void;
}

export function stubTradingCalendar(
  init: {
    status?: TradingDayStatus;
    lastClosed?: string | null;
    previousTradingDay?: string | null;
  } = {},
): TradingCalendarStub {
  let status: TradingDayStatus = init.status ?? 'trading';
  let lastClosed: string | null = init.lastClosed ?? null;
  // 072: 默认 null = 「不可判定」—— 与 lastClosed 同一条默认理由: 让不关心它的用例保持零变化,
  // 且**不可判定是安全侧**(调用方契约是「不许猜」)。要断言改期建议的用例显式 set。
  let previousTradingDay: string | null = init.previousTradingDay ?? null;
  return {
    async classify(): Promise<TradingDayStatus> {
      return status;
    },
    async lastClosedSession(): Promise<string | null> {
      return lastClosed;
    },
    async previousTradingDay(): Promise<string | null> {
      return previousTradingDay;
    },
    setLastClosed(date: string | null): void {
      lastClosed = date;
    },
    setStatus(next: TradingDayStatus): void {
      status = next;
    },
    setPreviousTradingDay(date: string | null): void {
      previousTradingDay = date;
    },
  };
}
