import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  HIS_VOLATILITY_MAX_SPAN_DAYS,
  IVP_DIVERGENCE_NOTABLE_PP,
  IVP_EXACT_MATCH_PP,
  IVP_SYSTEMIC_BREAK_MIN_SAMPLE,
  summarizeIvpDivergences,
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
    expect(IVP_DIVERGENCE_NOTABLE_PP.toNumber()).toBe(5);
  });

  // 🚨 py-futu-api#257 (2026-08-27 官方答复) 之后, **没有任何一档再断言「vendor 口径漂移」**:
  // 差值有三个已确认的结构性来源 (历史序列对空值日**前向填充**且客户端不可分辨 · vendor 分母
  // 取实际有效天数 · vendor 盘中分钟级更新 vs 我们的日线收盘)。本对表现在只能当**我们自己**
  // 那侧的回归闸 (#211 那种), 对 vendor 侧不构成判据。
  it('🚨 最高档只到 notable —— 不存在会喊「需人工核口径」的硬门了', () => {
    const levels = ['0', '20', '55.1', '100'].map(
      (v) => classifyIvpDivergence(D(v), selfAt(50)).level,
    );
    expect(levels).not.toContain('hard');
    expect(levels).toContain('notable');
  });

  it.each([
    ['差 0pp', '50', 'ok'],
    ['差 1.9pp', '51.9', 'ok'],
    ['差 2.1pp', '52.1', 'warn'],
    ['差 4.9pp', '54.9', 'warn'],
    ['差 5.1pp', '55.1', 'notable'],
    ['差 30pp（反向）', '20', 'notable'],
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

describe('summarizeIvpDivergences — 逐票判据退场后, 批级汇总 + 唯一一条系统性判据', () => {
  const v = (level: string, diffPp: number | null) =>
    ({ level, diffPp: diffPp === null ? null : D(String(diffPp)), reason: '' }) as never;

  it('恰合的口径是「差 ≤ IVP_EXACT_MATCH_PP」, 不是「差恰为 0」(Decimal 除法留尾数)', () => {
    expect(IVP_EXACT_MATCH_PP.toNumber()).toBe(0.001);
    const s = summarizeIvpDivergences([v('ok', 0), v('ok', 0.0005), v('ok', 0.002)]);
    expect(s.computable).toBe(3);
    expect(s.exact).toBe(2);
  });

  it('skipped 不进分母 (不成立对表 ≠ 对不上)', () => {
    const s = summarizeIvpDivergences([v('skipped', null), v('ok', 0), v('warn', 3)]);
    expect(s.computable).toBe(2);
    expect(s.exact).toBe(1);
  });

  /**
   * 🚨 **这是逐票 WARN 退场后剩下的唯一自动判据**（py-futu-api#257 / #218 / #209）。
   * 填充机制下, **窗口内没有空值日的那批票必然恰合** —— 连它们都不合了, 就不是 vendor 侧的
   * 填充, 是**我们这侧**塌了。#211（历史序列停更 23 天）正是这个形状: 全域偏移变大、恰合归零。
   */
  it('🚨 样本足够且恰合数为 0 → systemicBreak (我们这侧塌了, 不是 vendor 的填充)', () => {
    const s = summarizeIvpDivergences(
      Array.from({ length: IVP_SYSTEMIC_BREAK_MIN_SAMPLE }, () => v('warn', 3)),
    );
    expect(s.exact).toBe(0);
    expect(s.systemicBreak).toBe(true);
  });

  it('🚨 反臂: 只要还有一只恰合, 就不是系统性塌陷 (24 只已知偏移不得触发)', () => {
    const many = Array.from({ length: 24 }, () => v('warn', 3));
    const s = summarizeIvpDivergences([v('ok', 0), ...many]);
    expect(s.exact).toBe(1);
    expect(s.systemicBreak).toBe(false);
  });

  /**
   * 🚨 **这条守的是判据的前提, 不是保守裕度**: 「无空值日的票必然恰合」要求样本里**存在**
   * 那种票。样本太小时抽到的几只本来就可能全带空值日 —— 此时恰合数为 0 是正常态。
   */
  it('🚨 可算样本不足闸值 → 即便一只都不恰合也不判塌陷', () => {
    const s = summarizeIvpDivergences(
      Array.from({ length: IVP_SYSTEMIC_BREAK_MIN_SAMPLE - 1 }, () => v('warn', 3)),
    );
    expect(s.exact).toBe(0);
    expect(s.systemicBreak).toBe(false);
  });

  it('🚨 零可算标的 → 不是塌陷 (上线首日 / 全 skipped, 判红等于每天假红)', () => {
    const s = summarizeIvpDivergences([v('skipped', null), v('skipped', null)]);
    expect(s.computable).toBe(0);
    expect(s.systemicBreak).toBe(false);
  });

  it('最大偏移按样本数给 (1 样本 = 1/252 = 0.3968pp) —— 它才是「空值日数」的直读量', () => {
    const s = summarizeIvpDivergences([v('ok', 0), v('warn', 3.9683)]);
    expect(s.maxOffsetPp?.toFixed(4)).toBe('3.9683');
    expect(s.maxOffsetSamples).toBe(10);
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

// ---------------------------------------------------------------------------
// 066 T08 — 港股: 回填必须跨 ≥2 窗, 且分位样本只数**真实有值**的观测
// (FR-002 / FR-018 / FR-019 / FR-019a, SC-007 / SC-012, state_branches 14/15, plan §A9)
// ---------------------------------------------------------------------------

/**
 * 真实样本回放: 2026-08-22 PoC 直连港股侧行情网关 `/his-vol` 实采的 HK.00700 四个窗口。
 *
 * ## 这一段在证什么 (读代码看不出来的那半)
 *
 * `hk_underlying_iv_daily.history_depth` 取 **1095** (约 3 年) 不是保守, 是硬要求: 单个 vendor
 * 窗 (≤{@link HIS_VOLATILITY_MAX_SPAN_DAYS} 天) 港股只返 **244** 个交易日、美股 250 —— 两者
 * 都不足 {@link IVP_MIN_WINDOW_TRADING_DAYS}=252。只回填一年, 分位会**恒为** `insufficient_window`
 * **且不报错**: 采集全绿、库里也确实有行, 只是那一列永远是 null。这一档只能靠断言钉住。
 *
 * ## 磁盘读取的例外说明 (分类学 Small = 禁磁盘 I/O)
 *
 * 读的是**同仓 colocate 的只读静态 fixture**, 单进程内、零容器零网络, 与
 * `option-snapshot-guard.rules.spec.ts` 读 `__fixtures__/option-snapshot-us-2026-07-29.csv` 同形态。
 */
interface HisVolFixture {
  windows: {
    requested: { code: string; start: string; end: string };
    response: { count: number; rows: { time: string; iv: unknown }[] };
  }[];
}

const HK_HIS_VOL = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'hk-underlying-iv-his-vol-2026-08-22.json'), 'utf8'),
) as HisVolFixture;

/** 单个 vendor 窗港股实返的交易日数。fixture 被裁小会在这里当场红 (回放就失去意义了)。 */
const HK_TRADING_DAYS_PER_WINDOW = 244;

/** `hk_underlying_iv_daily.history_depth` (自然日)。维度行由 T04 seed, 这里对齐同一个值。 */
const HK_HISTORY_DEPTH_DAYS = 1095;

/** 2026-08-22 实测 HK.00700 的 `overview` 直读聚合 IV —— 当日值, 分位的被比较对象。 */
const HK_CURRENT_IV = D('32.365');

/** fixture 某窗的 iv 序列 → 采集侧落库形态 (数值 → Decimal; 非有限 / `'N/A'` → null)。 */
function ivSeriesOf(windowIndex: number): (Prisma.Decimal | null)[] {
  return HK_HIS_VOL.windows[windowIndex].response.rows.map((r) =>
    typeof r.iv === 'number' && Number.isFinite(r.iv) ? D(r.iv) : null,
  );
}

describe('066 T08 港股 IV 回填跨窗 (FR-018, SC-007, plan §A9)', () => {
  it('fixture 完整性: 首窗恰 244 行且 iv 全部有值 (掺空 / 裁小会让下面两条失去意义)', () => {
    const w = HK_HIS_VOL.windows[0];
    expect(w.requested).toEqual({ code: 'HK.00700', start: '2024-08-25', end: '2025-08-23' });
    expect(w.response.count).toBe(HK_TRADING_DAYS_PER_WINDOW);
    expect(w.response.rows).toHaveLength(HK_TRADING_DAYS_PER_WINDOW);
    expect(ivSeriesOf(0).filter((v) => v === null)).toEqual([]);
  });

  it('🚨 只回填一年 (单窗 244 个真实观测) → 分位「不可算」而不是 0 (SC-007 后半 / state_branches 14)', () => {
    const result = computeIvPercentile(ivSeriesOf(0), HK_CURRENT_IV);

    expect(result.computable).toBe(false);
    // 落 0 会让「历史太短」长得像「IV 处于一年最低」—— 恰好方向相反的误读。
    expect(result.percentilePct).toBeNull();
    expect(result.sampleSize).toBe(HK_TRADING_DAYS_PER_WINDOW);
    if (!result.computable) expect(result.reason).toBe('insufficient_window');
    // 单窗给不出 252 —— 这就是 history_depth 必须 > 一年的全部理由。
    expect(HK_TRADING_DAYS_PER_WINDOW).toBeLessThan(IVP_MIN_WINDOW_TRADING_DAYS);
  });

  it('history_depth=1095 → 既有 splitBackfillWindows 切 4 窗, 首尾相接不重不漏 (不另写分窗)', () => {
    // 执行侧口径: `splitBackfillWindows(asOf − history_depth, asOf)` (dimension-executor 回填路径)。
    const asOf = '2026-08-22';
    const start = '2023-08-23'; // = asOf − 1095 天 (含 2024 闰日)
    const windows = splitBackfillWindows(start, asOf);

    expect(windows).toHaveLength(4);
    expect(windows[0].start).toBe(start);
    expect(windows.at(-1)?.end).toBe(asOf);
    for (let i = 1; i < windows.length; i++) {
      // 闭区间语义下唯一不重不漏的接法: 下一窗起点 = 上一窗终点 +1 天。
      const prevEnd = Date.parse(`${windows[i - 1].end}T00:00:00Z`);
      expect(windows[i].start).toBe(new Date(prevEnd + 86_400_000).toISOString().slice(0, 10));
    }
    // 4 窗 × 244 个交易日足以跨过 252; 1 窗不能 —— 「必须跨 ≥2 窗」是算出来的, 不是拍的。
    expect(windows.length * HK_TRADING_DAYS_PER_WINDOW).toBeGreaterThanOrEqual(
      IVP_MIN_WINDOW_TRADING_DAYS,
    );
    expect(HK_HISTORY_DEPTH_DAYS).toBeGreaterThan(HIS_VOLATILITY_MAX_SPAN_DAYS);
  });

  it('🚨 跨 2 窗 (488 个真实观测) → 分位可算 (SC-007 前半 / state_branches 15)', () => {
    const result = computeIvPercentile([...ivSeriesOf(0), ...ivSeriesOf(1)], HK_CURRENT_IV);

    expect(result.computable).toBe(true);
    expect(result.sampleSize).toBe(HK_TRADING_DAYS_PER_WINDOW * 2);
    if (result.computable) {
      expect(result.percentilePct.greaterThanOrEqualTo(0)).toBe(true);
      expect(result.percentilePct.lessThanOrEqualTo(100)).toBe(true);
    }
  });

  it('第三窗只有 41 行且最早一行是 2023-06-27 → 港股侧历史起点; 更早的窗返 0 行', () => {
    expect(HK_HIS_VOL.windows[2].response.rows.at(-1)?.time).toBe('2023-06-27');
    expect(HK_HIS_VOL.windows[3].response.count).toBe(0);
  });
});

describe('066 T08 分位样本只数真实观测 (FR-019a, SC-012, plan §A9)', () => {
  /** 无挂牌期权的标的: `his-vol` 行照常在, 但 iv 是字面量 `'N/A'` ⇒ 采集侧落 null。 */
  const emptyObservations = (n: number): (Prisma.Decimal | null)[] =>
    Array.from({ length: n }, () => null);

  it('🚨 无挂牌期权标的: 252 个空值观测 + 当日直读值也缺 → 恒不可算, 样本数 0 (SC-012)', () => {
    const result = computeIvPercentile(emptyObservations(IVP_MIN_WINDOW_TRADING_DAYS), null);

    expect(result.computable).toBe(false);
    expect(result.percentilePct).toBeNull();
    expect(result.sampleSize).toBe(0);
    if (!result.computable) expect(result.reason).toBe('missing_current');
  });

  it('🚨 空值观测累积到 252 行也**不**构成「样本充足」—— 数行数会误判 (FR-019a 核心钉)', () => {
    // 即便当日直读值在 (走不到 missing_current 那道早退), 空行本身仍凑不出任何样本。
    const result = computeIvPercentile(emptyObservations(IVP_MIN_WINDOW_TRADING_DAYS), D(30));

    expect(result.computable).toBe(false);
    expect(result.percentilePct).toBeNull();
    expect(result.sampleSize).toBe(0);
    if (!result.computable) expect(result.reason).toBe('insufficient_window');
  });

  it('🚨 244 真实 + 8 空值 = 252 **行**但只有 244 个观测 → 仍不可算 (行数 ≠ 样本量)', () => {
    const history = [...ivSeriesOf(0), ...emptyObservations(8)];
    expect(history).toHaveLength(IVP_MIN_WINDOW_TRADING_DAYS);

    const result = computeIvPercentile(history, HK_CURRENT_IV);

    expect(result.computable).toBe(false);
    expect(result.sampleSize).toBe(HK_TRADING_DAYS_PER_WINDOW);
    if (!result.computable) expect(result.reason).toBe('insufficient_window');
  });

  it('补满第 8 个**真实**观测后立刻可算 —— 分界卡在观测数, 与行数无关', () => {
    const history = [
      ...ivSeriesOf(0),
      ...ivSeriesOf(1).slice(0, IVP_MIN_WINDOW_TRADING_DAYS - HK_TRADING_DAYS_PER_WINDOW),
    ];
    const result = computeIvPercentile(history, HK_CURRENT_IV);

    expect(result.computable).toBe(true);
    expect(result.sampleSize).toBe(IVP_MIN_WINDOW_TRADING_DAYS);
  });
});
