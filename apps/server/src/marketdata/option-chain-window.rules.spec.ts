import { describe, it, expect } from 'vitest';
import {
  OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS,
  InvalidChainWindowInputError,
  gapCheckExpiryDates,
  planOptionChainWindows,
  type OptionChainWindow,
} from './option-chain-window.rules.js';

/** `YYYY-MM-DD` 加 n 天（UTC 定点；字典序即时序）。 */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 端点日期差（天）。含首尾计数 = 本值 + 1。 */
function endpointOffset(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

/**
 * 🚨「腿静默消失」那类 bug 的唯一机器拦截：每个输入到期日**恰好**落在一个窗里、窗按时序
 * 首尾相接不重不叠、且**每窗跨度不超上限**、**窗的两端都是真实到期日**（E38 纪律：MUST NOT
 * 手算 as-of 链）。少一个到期日 = 一整批腿永久采不到，而调用本身照样成功、不会红。
 */
function assertWindowsCoverExactly(windows: OptionChainWindow[], expiryDates: readonly string[]) {
  const expected = [...new Set(expiryDates)].sort();

  // ① 并集 = 输入全集（去重后），且顺序即时序。
  expect(windows.flatMap((w) => w.expiryDates)).toEqual(expected);

  // ② 无重：同一个到期日不会被两个窗都拉一遍。
  const seen = new Set<string>();
  for (const w of windows) {
    for (const d of w.expiryDates) {
      expect(seen.has(d)).toBe(false);
      seen.add(d);
    }
  }
  expect(seen.size).toBe(expected.length);

  for (const [i, w] of windows.entries()) {
    // ③ 窗两端都是**真实到期日**本身，不是任何手算日期。
    expect(w.expiryDates.length).toBeGreaterThan(0);
    expect(w.start).toBe(w.expiryDates[0]);
    expect(w.end).toBe(w.expiryDates.at(-1));
    expect(expected).toContain(w.start);
    expect(expected).toContain(w.end);

    // ④ 每窗跨度不超 vendor 上限（含首尾计数）。
    expect(endpointOffset(w.start, w.end) + 1).toBeLessThanOrEqual(
      OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS,
    );

    // ⑤ 窗之间严格递增不叠：下一窗起点晚于上一窗终点。
    if (i > 0) expect(endpointOffset(windows[i - 1]!.end, w.start)).toBeGreaterThan(0);
  }
}

describe('planOptionChainWindows — 稀疏远月的 p3b 实测基线', () => {
  /**
   * 2026 年 5–12 月的月度到期日（每月第三个周五）。相邻间隔 35 / 28 / 35 / 28 / 28 / 35 / 28 天
   * —— 28 天的能并窗、35 天的并不了，这正是「调用数不随时间线性增长」的机理。
   */
  const MONTHLY_2026 = [
    '2026-05-15',
    '2026-06-19',
    '2026-07-17',
    '2026-08-21',
    '2026-09-18',
    '2026-10-16',
    '2026-11-20',
    '2026-12-18',
  ];

  it('🚨 8 个到期日 → 恰好 **5 个窗**（p3b 实测基线，改贪心口径这条即红）', () => {
    const windows = planOptionChainWindows(MONTHLY_2026);
    expect(windows).toHaveLength(5);
    expect(windows.map((w) => [w.start, w.end])).toEqual([
      ['2026-05-15', '2026-05-15'], // 下一个 +35 天，并不进来
      ['2026-06-19', '2026-07-17'], // +28 天，并窗
      ['2026-08-21', '2026-09-18'], // +28 天，并窗
      ['2026-10-16', '2026-10-16'], // 下一个 +35 天
      ['2026-11-20', '2026-12-18'], // +28 天，并窗
    ]);
    assertWindowsCoverExactly(windows, MONTHLY_2026);
  });

  it('🚫 贪心 MUST NOT 用「已并入的末个到期日」续期预算 —— 那会让窗跨度突破 30 天', () => {
    // 若每并入一个到期日就把 +30 的预算重置到它身上，8-21 / 9-18 / 10-16 会连成一窗，
    // 跨度 56 天 > 30 ⇒ vendor 直接 4xx，整轮链发现断掉（us_equity_bar 08-01 事故的形状）。
    const windows = planOptionChainWindows(MONTHLY_2026);
    for (const w of windows) {
      expect(endpointOffset(w.start, w.end) + 1).toBeLessThanOrEqual(
        OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS,
      );
    }
    expect(windows.some((w) => w.expiryDates.length > 2)).toBe(false);
  });
});

describe('planOptionChainWindows — 密集周期权段', () => {
  /** 近月每周五到期（间隔 7 天）。 */
  const WEEKLY = [
    '2026-08-07',
    '2026-08-14',
    '2026-08-21',
    '2026-08-28',
    '2026-09-04',
    '2026-09-11',
    '2026-09-18',
  ];

  it('每窗跨度不超 30 天，且到期日无重无漏（并集 = 输入全集）', () => {
    const windows = planOptionChainWindows(WEEKLY);
    assertWindowsCoverExactly(windows, WEEKLY);
  });

  it('尽可能塞满一窗（首窗吃下 5 个周到期日，端点差 28 天）', () => {
    const windows = planOptionChainWindows(WEEKLY);
    expect(windows[0]?.expiryDates).toEqual([
      '2026-08-07',
      '2026-08-14',
      '2026-08-21',
      '2026-08-28',
      '2026-09-04',
    ]);
    expect(windows).toHaveLength(2);
  });

  it('周 + 月混合（近月密、远月稀）仍无重无漏', () => {
    const mixed = [...WEEKLY, '2026-10-16', '2026-11-20', '2026-12-18', '2027-01-15', '2028-01-21'];
    assertWindowsCoverExactly(planOptionChainWindows(mixed), mixed);
  });
});

describe('planOptionChainWindows — 跨度上限与边界', () => {
  it('上限是具名常量 30（vendor 官方「传入的时间跨度上限为 30 天」）', () => {
    expect(OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS).toBe(30);
  });

  it('🚨 恰好 30 天边界：端点差 29（含首尾 30 天）→ 同一窗', () => {
    const start = '2026-08-03';
    const end = addDays(start, OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS - 1);
    const windows = planOptionChainWindows([start, end]);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ start, end });
  });

  it('🚨 再多一天（端点差 30，含首尾 31 天）→ 拆两窗，宁多切一页不赌 vendor 的读法', () => {
    const start = '2026-08-03';
    const end = addDays(start, OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS);
    const windows = planOptionChainWindows([start, end]);
    expect(windows).toHaveLength(2);
    expect(windows.map((w) => w.start)).toEqual([start, end]);
  });
});

describe('planOptionChainWindows — 退化输入与输入归一化', () => {
  it('空输入 → 空数组（没有到期日就没有要发的请求，不是错误）', () => {
    expect(planOptionChainWindows([])).toEqual([]);
  });

  it('单到期日 → 一个 [d, d] 窗', () => {
    expect(planOptionChainWindows(['2026-09-18'])).toEqual([
      { start: '2026-09-18', end: '2026-09-18', expiryDates: ['2026-09-18'] },
    ]);
  });

  it('乱序输入 → 先升序归一化，结果与有序输入一致（vendor 未承诺返回有序）', () => {
    const ordered = ['2026-05-15', '2026-06-19', '2026-07-17', '2026-08-21'];
    const shuffled = ['2026-07-17', '2026-05-15', '2026-08-21', '2026-06-19'];
    expect(planOptionChainWindows(shuffled)).toEqual(planOptionChainWindows(ordered));
    assertWindowsCoverExactly(planOptionChainWindows(shuffled), shuffled);
  });

  it('重复到期日 → 去重，同一个到期日 MUST NOT 被拉两次', () => {
    const windows = planOptionChainWindows(['2026-09-18', '2026-09-18', '2026-10-16']);
    expect(windows.flatMap((w) => w.expiryDates)).toEqual(['2026-09-18', '2026-10-16']);
  });

  it.each([
    ['非日期', 'not-a-date'],
    ['美式日期', '09/18/2026'],
    ['日历不存在', '2026-02-30'],
    ['带时刻', '2026-09-18T00:00:00Z'],
  ])('%s → 抛 InvalidChainWindowInputError（静默丢掉一个到期日 = 一整批腿永久缺口）', (_l, bad) => {
    expect(() => planOptionChainWindows(['2026-09-18', bad])).toThrow(InvalidChainWindowInputError);
  });

  it('maxSpanDays ≤ 0 → 抛错（否则死循环 / 产出空窗）', () => {
    expect(() => planOptionChainWindows(['2026-09-18'], 0)).toThrow(InvalidChainWindowInputError);
  });
});

describe('gapCheckExpiryDates — 已发现合约的到期日 vs vendor 权威到期日列表 (plan D-DATA-2)', () => {
  const VENDOR = ['2026-08-21', '2026-09-18', '2026-10-16'];

  it('两集合相等 → ok，两个差集皆空', () => {
    const result = gapCheckExpiryDates(VENDOR, VENDOR);
    expect(result.ok).toBe(true);
    expect(result.missingFromDiscovered).toEqual([]);
    expect(result.unexpectedInDiscovered).toEqual([]);
  });

  it('🚨 vendor 有、链调用却没发现 → missingFromDiscovered（腿静默消失的正面信号）', () => {
    const result = gapCheckExpiryDates(['2026-08-21', '2026-10-16'], VENDOR);
    expect(result.ok).toBe(false);
    expect(result.missingFromDiscovered).toEqual(['2026-09-18']);
    expect(result.unexpectedInDiscovered).toEqual([]);
  });

  it('发现了 vendor 列表外的到期日 → unexpectedInDiscovered（两个方向都要报）', () => {
    const result = gapCheckExpiryDates([...VENDOR, '2026-11-20'], VENDOR);
    expect(result.ok).toBe(false);
    expect(result.missingFromDiscovered).toEqual([]);
    expect(result.unexpectedInDiscovered).toEqual(['2026-11-20']);
  });

  it('两个方向同时有差 → 各自列全，差集升序', () => {
    const result = gapCheckExpiryDates(['2026-10-16', '2026-12-18', '2026-11-20'], VENDOR);
    expect(result.missingFromDiscovered).toEqual(['2026-08-21', '2026-09-18']);
    expect(result.unexpectedInDiscovered).toEqual(['2026-11-20', '2026-12-18']);
  });

  it('对顺序与重复不敏感（集合语义）', () => {
    const result = gapCheckExpiryDates(
      ['2026-10-16', '2026-08-21', '2026-08-21', '2026-09-18'],
      ['2026-09-18', '2026-10-16', '2026-08-21'],
    );
    expect(result.ok).toBe(true);
  });

  it('vendor 列表为空而已发现若干 → 全进 unexpected（不是平凡 ok）', () => {
    const result = gapCheckExpiryDates(VENDOR, []);
    expect(result.ok).toBe(false);
    expect(result.unexpectedInDiscovered).toEqual(VENDOR);
  });

  it('两侧皆空 → ok（该票无期权链是合法状态）', () => {
    expect(gapCheckExpiryDates([], []).ok).toBe(true);
  });
});
