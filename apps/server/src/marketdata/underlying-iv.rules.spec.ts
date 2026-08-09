import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  HIS_VOLATILITY_MAX_SPAN_DAYS,
  IVP_DIVERGENCE_HARD_PP,
  IVP_DIVERGENCE_WARN_PP,
  IVP_MIN_WINDOW_TRADING_DAYS,
  InvalidBackfillRangeError,
  classifyIvpDivergence,
  computeIvPercentile,
  splitBackfillWindows,
  type BackfillWindow,
} from './underlying-iv.rules.js';

const D = (v: string | number) => new Prisma.Decimal(v);

/** 恰好 252 个交易日的 IV 序列：1, 2, …, 252（分位断言可手算）。 */
const FULL_WINDOW = Array.from({ length: IVP_MIN_WINDOW_TRADING_DAYS }, (_v, i) => D(i + 1));

describe('computeIvPercentile — 窗口不足返「不可算」而非 0 (FR-014 全片纪律)', () => {
  it('🚨 样本 251 < 252 → computable=false, percentilePct 是 null 而**不是 0**', () => {
    const result = computeIvPercentile(
      FULL_WINDOW.slice(0, IVP_MIN_WINDOW_TRADING_DAYS - 1),
      D(10),
    );
    expect(result.computable).toBe(false);
    expect(result.percentilePct).toBeNull();
    expect(result.percentilePct).not.toEqual(D(0));
    if (!result.computable) {
      expect(result.reason).toBe('insufficient_window');
      expect(result.sampleSize).toBe(IVP_MIN_WINDOW_TRADING_DAYS - 1);
    }
  });

  it('空序列 → 不可算（不是 0 分位）', () => {
    const result = computeIvPercentile([], D(10));
    expect(result.computable).toBe(false);
    expect(result.percentilePct).toBeNull();
  });

  it('null / 非有限值不计入样本 —— 补 null 凑不满 252 仍是不可算', () => {
    const padded = [...FULL_WINDOW.slice(0, IVP_MIN_WINDOW_TRADING_DAYS - 1), null, null, null];
    const result = computeIvPercentile(padded, D(10));
    expect(result.computable).toBe(false);
    if (!result.computable) expect(result.sampleSize).toBe(IVP_MIN_WINDOW_TRADING_DAYS - 1);
  });

  it('当前值缺失（vendor 当日无 IV）→ 不可算, reason 与窗口不足可区分', () => {
    const result = computeIvPercentile(FULL_WINDOW, null);
    expect(result.computable).toBe(false);
    if (!result.computable) expect(result.reason).toBe('missing_current');
  });
});

describe('computeIvPercentile — 分位边界 (最小 / 最大 / 中位)', () => {
  it('低于全部历史 → 0 分位', () => {
    const result = computeIvPercentile(FULL_WINDOW, D('0.5'));
    expect(result.computable).toBe(true);
    expect(result.percentilePct?.toNumber()).toBe(0);
  });

  it('高于全部历史 → 100 分位', () => {
    const result = computeIvPercentile(FULL_WINDOW, D(999));
    expect(result.percentilePct?.toNumber()).toBe(100);
  });

  it('正中位 → 50 分位（252 个样本里 126 个严格小于 126.5）', () => {
    const result = computeIvPercentile(FULL_WINDOW, D('126.5'));
    expect(result.percentilePct?.toNumber()).toBe(50);
    expect(result.sampleSize).toBe(IVP_MIN_WINDOW_TRADING_DAYS);
  });

  it('口径 = 严格小于当前值的天数占比：等值样本不计入（与最小值并列 → 仍是 0）', () => {
    const result = computeIvPercentile(FULL_WINDOW, D(1));
    expect(result.percentilePct?.toNumber()).toBe(0);
  });

  it('Decimal 精度不过 Number —— 1/252 量级的分位不被浮点抹平', () => {
    const result = computeIvPercentile(FULL_WINDOW, D('1.5'));
    expect(result.percentilePct?.equals(D(1).div(252).mul(100))).toBe(true);
  });
});

describe('classifyIvpDivergence — 三档判定, 两个边界值归属唯一 (FR-034 / plan D4)', () => {
  /** 造一个分位恰为 `pct` 的「可算」自算结果，让边界断言不被样本口径带偏。 */
  function selfAt(pct: number) {
    // FULL_WINDOW = 1..252 ⇒ 严格小于 (k + 0.5) 的样本数 = k ⇒ 分位 = k/252*100。
    const k = Math.round((pct / 100) * IVP_MIN_WINDOW_TRADING_DAYS);
    return computeIvPercentile(FULL_WINDOW, D(k + 0.5));
  }

  it('阈值是具名常量, 取 p3b §6.3 实测基线 2pp / 5pp', () => {
    expect(IVP_DIVERGENCE_WARN_PP.toNumber()).toBe(2);
    expect(IVP_DIVERGENCE_HARD_PP.toNumber()).toBe(5);
  });

  it.each([
    ['差 0pp', '50', 'ok'],
    ['差 1.9pp', '51.9', 'ok'],
    ['差 2.1pp', '52.1', 'warn'],
    ['差 4.9pp', '54.9', 'warn'],
    ['差 5.1pp', '55.1', 'hard'],
    ['差 30pp（反向）', '20', 'hard'],
  ])('%s → %s', (_label, vendorPct, expected) => {
    const verdict = classifyIvpDivergence(D(vendorPct), selfAt(50));
    expect(verdict.level).toBe(expected);
  });

  it('🚨 恰好 2pp → 归 ok（静默档），不同时亮 warn', () => {
    const verdict = classifyIvpDivergence(D(52), selfAt(50));
    expect(verdict.level).toBe('ok');
    expect(verdict.diffPp?.toNumber()).toBe(2);
  });

  it('🚨 恰好 5pp → 归 warn，不升 hard', () => {
    const verdict = classifyIvpDivergence(D(55), selfAt(50));
    expect(verdict.level).toBe('warn');
    expect(verdict.diffPp?.toNumber()).toBe(5);
  });

  it('差值取绝对值：自算高于直读同样按档判', () => {
    expect(classifyIvpDivergence(D(45), selfAt(50)).level).toBe('warn');
  });

  it('🚨 窗口不足 → skipped 且不告警（缺窗口不是口径漂移, state_branch 已列）', () => {
    const shortWindow = computeIvPercentile(FULL_WINDOW.slice(0, 10), D(50));
    const verdict = classifyIvpDivergence(D(99), shortWindow);
    expect(verdict.level).toBe('skipped');
    expect(verdict.diffPp).toBeNull();
  });

  it('直读值缺失 → skipped（无可比对象, 不是漂移）', () => {
    const verdict = classifyIvpDivergence(null, selfAt(50));
    expect(verdict.level).toBe('skipped');
    expect(verdict.diffPp).toBeNull();
  });

  it('每档都带人可读依据（进告警面定位用）', () => {
    expect(classifyIvpDivergence(D(80), selfAt(50)).reason).toContain('30');
  });
});

describe('splitBackfillWindows — ≤364 天分页, 边界不重复计入不漏日 (FR-024 / plan D7)', () => {
  /** YYYY-MM-DD 加 n 天（UTC；字典序即时序）。 */
  function addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** 逐日展开，验「无重无漏」—— 每个日期恰好落在一个窗口里。 */
  function assertSeamless(windows: BackfillWindow[], start: string, end: string) {
    expect(windows[0]!.start).toBe(start);
    expect(windows.at(-1)!.end).toBe(end);
    for (let i = 1; i < windows.length; i++) {
      // 首尾相接：下一窗起点 = 上一窗终点 + 1 天（无缝：不跳日；无叠：不重日）。
      expect(windows[i]!.start).toBe(addDays(windows[i - 1]!.end, 1));
    }
    const seen = new Set<string>();
    for (const w of windows) {
      expect(w.start <= w.end).toBe(true);
      for (let d = w.start; d <= w.end; d = addDays(d, 1)) {
        expect(seen.has(d)).toBe(false); // 无重
        seen.add(d);
      }
    }
    let count = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      expect(seen.has(d)).toBe(true); // 无漏
      count++;
    }
    expect(seen.size).toBe(count);
  }

  it('跨度上限是具名常量 364（vendor 单次跨度上限）', () => {
    expect(HIS_VOLATILITY_MAX_SPAN_DAYS).toBe(364);
  });

  it('3 年区间（含闰日 2024-02-29）：逐日无重无漏, 首尾相接, 末窗不越界', () => {
    const start = '2023-08-01';
    const end = '2026-07-31';
    const windows = splitBackfillWindows(start, end);
    assertSeamless(windows, start, end);
    for (const w of windows) {
      const span =
        (Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000 + 1;
      expect(span).toBeLessThanOrEqual(HIS_VOLATILITY_MAX_SPAN_DAYS);
    }
    expect(windows).toHaveLength(4); // 1097 天 / 364 = 3 满窗 + 5 天尾窗
  });

  it('恰好 364 天 → 单窗（不无谓多切一页）', () => {
    const start = '2026-01-01';
    const end = addDays(start, HIS_VOLATILITY_MAX_SPAN_DAYS - 1);
    const windows = splitBackfillWindows(start, end);
    expect(windows).toEqual([{ start, end }]);
  });

  it('365 天 → 两窗, 第二窗只有 1 天且不越过 end', () => {
    const start = '2026-01-01';
    const end = addDays(start, HIS_VOLATILITY_MAX_SPAN_DAYS);
    const windows = splitBackfillWindows(start, end);
    expect(windows).toHaveLength(2);
    expect(windows[1]).toEqual({ start: end, end });
    assertSeamless(windows, start, end);
  });

  it('单日区间 → 一个 [d, d] 窗', () => {
    expect(splitBackfillWindows('2026-03-01', '2026-03-01')).toEqual([
      { start: '2026-03-01', end: '2026-03-01' },
    ]);
  });

  it('start > end（增量算出空区间）→ 空数组, 不抛错也不产出反向窗', () => {
    expect(splitBackfillWindows('2026-03-02', '2026-03-01')).toEqual([]);
  });

  it.each([
    ['非日期', 'not-a-date', '2026-03-01'],
    ['美式日期', '03/01/2026', '2026-03-01'],
    ['日历不存在', '2026-02-30', '2026-03-01'],
    ['end 非法', '2026-03-01', '2026-13-01'],
  ])('%s → 抛 InvalidBackfillRangeError（回填区间算错比少拉几天危险得多）', (_l, start, end) => {
    expect(() => splitBackfillWindows(start, end)).toThrow(InvalidBackfillRangeError);
  });

  it('maxSpanDays ≤ 0 → 抛错（否则死循环）', () => {
    expect(() => splitBackfillWindows('2026-01-01', '2026-12-31', 0)).toThrow(
      InvalidBackfillRangeError,
    );
  });
});
