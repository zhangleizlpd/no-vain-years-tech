import type { CalendarCoverageRange } from './trading-day.rules.js';

/**
 * **交易日历覆盖声明的推进判据**（062 T002, FR-001 / FR-002 / FR-003, plan §D1）。纯函数、
 * 无 I/O、无 DI（ADR-0043 §4）。
 *
 * 声明 = 「该市场的日历已完备覆盖到哪一段」的**承诺**，是三态判定里 `unknown` 的唯一依据
 * （{@link classifyTradingDay}）。承诺只在某段**整段填充成功**后才前进一步。
 *
 * 🚫 **MUST NOT 用 `max(trading_day.date)` 派生覆盖终点**（FR-003）：最大值看不出区间中间的
 * 空洞，那是又一次「库里没有的即为假」推断 —— 正是本 feature 要根治的病。**不能在修这个病的
 * 过程中原地重犯一次。** 机器强制在 `scripts/checks/check-trading-day-read.ts` Check B。
 *
 * 🚨 **调用方 MUST NOT 在填充失败的 `catch` 分支里调本函数**：声明一旦在填充失败时照样前进，
 * 三态判定全线失真，而测试通常只断言「成功时推进」⇒ **不会红**。
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 86_400_000;

/**
 * 推进结果 —— **判别联合，而不是「返回 current」**。
 *
 * 🚨 静默返回 `current` 会让调用方分不清「**没推进**」和「**推进到了原地**」（后者在
 * filled 被 current 完全包含时是正常结果）。前者必须留可告警的痕（`state_branch` 11），后者
 * 是无事发生 —— 两种情形合流之后，视野停止前进这件事就再也没有信号了。
 */
export type AdvanceCoverageResult =
  | { advanced: true; coverage: CalendarCoverageRange }
  | { advanced: false; reason: string };

/**
 * ISO 日期格式闸 —— 判据靠**字典序比较**（`YYYY-MM-DD` 下等价于时序）+ 日期加减，格式不合
 * 两者都无意义（`'2026/03/01' >= '2026-01-01'` 静默为真 / `Date.parse` 给 NaN）。体例照
 * `static-calendar.adapter.ts` 与 `trading-day.rules.ts` 的同名守卫。
 */
function assertIsoDate(date: string, field: string): void {
  if (!ISO_DATE_RE.test(date)) {
    throw new Error(`[calendar-coverage] 非法日期 ${field}="${date}" (须 YYYY-MM-DD)`);
  }
}

/**
 * 区间守卫。`from > to` **抛**而不是靠 min/max 兜住：min/max 会把反向区间静默「修正」成一段
 * 语义正确但**从没填过**的承诺 —— 声明失真比调用方拿到异常贵得多。
 */
function assertRange(range: CalendarCoverageRange, label: string): void {
  assertIsoDate(range.from, `${label}.from`);
  assertIsoDate(range.to, `${label}.to`);
  if (range.from > range.to) {
    throw new Error(
      `[calendar-coverage] ${label} 区间非法 (from > to): ${range.from}..${range.to}`,
    );
  }
}

/** `YYYY-MM-DD` 的次日（跨月/跨年/闰年交给 `Date` 算，别手工加 1）。 */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * 把「整段成功填充的区间 `filled`」并入既有声明 `current`。复杂度 O(1)。
 *
 * · `current === null`（首次上线 / 声明被清空）→ 直接采用 `filled`。
 * · `filled` 与 `current` **相邻或重叠** → 扩展为 `{ from: min, to: max }`。
 * · 二者之间**有缺口** → **不推进** + 显式原因（调用方按 ERROR 留痕告警）。
 *
 * 🚨 **相邻判据必须两侧都查。** 直觉上只写右侧那半（`filled.from <= current.to + 1`）就够了
 * —— 那是错的：它对**左侧缺口**恒为真，于是「seed 一段 2020 年的历史」会与今年的声明合并成
 * 一条横跨六年的承诺，中间几年从没填过却被声明为「已覆盖」⇒ 那几年的每一天都从 `unknown`
 * 翻成 `non-trading`。**本 feature 要消灭的病原样重演在声明层**，而生产里右扩是常态、单测若
 * 只造右扩用例，写单边**一条都不会红**（spec 那条「推进规则 MUST NOT 产生空洞」的落点就在
 * 这两个比较上）。
 */
export function advanceCoverage(
  current: CalendarCoverageRange | null,
  filled: CalendarCoverageRange,
): AdvanceCoverageResult {
  assertRange(filled, 'filled');
  if (current === null) {
    return { advanced: true, coverage: { from: filled.from, to: filled.to } };
  }
  assertRange(current, 'current');

  const adjacentOrOverlapping =
    filled.from <= nextDay(current.to) && current.from <= nextDay(filled.to);
  if (!adjacentOrOverlapping) {
    return {
      advanced: false,
      reason:
        `[calendar-coverage] 填充区间 ${filled.from}..${filled.to} 与既有声明 ` +
        `${current.from}..${current.to} 之间有缺口 —— 声明只在相邻/重叠时推进 ` +
        `(合并会造出一段从没填过却被声明为已覆盖的空洞)`,
    };
  }

  return {
    advanced: true,
    coverage: {
      from: filled.from < current.from ? filled.from : current.from,
      to: filled.to > current.to ? filled.to : current.to,
    },
  };
}
