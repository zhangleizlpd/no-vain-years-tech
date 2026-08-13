import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { classifyLegTier } from './leg-tier.rules';
import {
  ACTIVITY_TOP_RANK_COUNT,
  DAYS_PER_WEEK,
  DAYS_PER_YEAR,
  US_OPTION_CONTRACT_MULTIPLIER,
  computeEffectiveCost,
  computeEffectiveCostVsWPct,
  computeLegRates,
  computeContractPremium,
  computeTurnover,
  deriveDeltaColumns,
  markActivity,
  type ActivityInput,
} from './leg-derive.rules';

// ─────────────────────────────────────────────────────────────────────────────
// 独立预言机: Φ (标准正态 CDF), 用 Abramowitz & Stegun 7.1.26 的 erf 逼近。
//
// 🚨 **蓄意与被测对象取不同逼近族** —— 被测的是 Acklam 有理逼近 (Φ⁻¹, 绝对误差 < 1.15e-9),
// 本预言机是 A&S 多项式 (erf 绝对误差 < 1.5e-7 ⇒ Φ 误差 < 7.5e-8)。两者独立 ⇒ 往返闭合
// 才是证据。误差预算 7.5e-8 + 1.15e-9 ≪ 断言口径 1e-6 (plan D-UI-3), 余量约 13×。
// 拿被测文件自己的 Φ 做往返只能证明它自洽, 证不了它对。
// ─────────────────────────────────────────────────────────────────────────────
function erfOracle(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-z * z));
}

function standardNormalCdfOracle(x: number): number {
  return 0.5 * (1 + erfOracle(x / Math.SQRT2));
}

/** 定死种子的 LCG —— 随机样本但用例可复现 (红了能原样重跑)。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe('leg-derive.rules — 三个费率的分母恒为准备金 K − P (FR-018, plan D-API-2)', () => {
  it('周化 / 年化 / 折年同出一个 period 费率, 分母 = K − P', () => {
    const rates = computeLegRates({ strike: '100', premium: '5', dteDays: 365 });
    expect(rates).not.toBeNull();
    // 5 / (100 − 5) = 0.0526315789…；DTE = 一年 ⇒ 年化 = period 本身。
    expect(rates?.periodRate.toFixed(8)).toBe('0.05263158');
    expect(rates?.annualizedRate.toFixed(8)).toBe('0.05263158');
    expect(rates?.weeklyRate.toFixed(8)).toBe('0.00100937');
  });

  it('折年 = 周化 × (一年天数 / 一周天数), 与 DTE 无关 —— 同一行的固定比例关系', () => {
    for (const dteDays of [7, 14, 45, 150, 365, 730]) {
      const rates = computeLegRates({ strike: '80', premium: '3', dteDays });
      const ratio = rates?.annualizedRate.div(rates.weeklyRate);
      expect(Number(ratio)).toBeCloseTo(DAYS_PER_YEAR / DAYS_PER_WEEK, 9);
    }
  });

  it('短腿的折年被 DTE 放大 —— 正是 FR-004 禁止拿它跨 DTE 直比的理由', () => {
    const short = computeLegRates({ strike: '100', premium: '2', dteDays: 14 });
    const long = computeLegRates({ strike: '100', premium: '2', dteDays: 365 });
    expect(Number(short?.annualizedRate)).toBeGreaterThan(Number(long?.annualizedRate) * 20);
    // 同一行的周化才是短腿的决策值, 两者数量级差异不掩盖它。
    expect(Number(short?.weeklyRate)).toBeGreaterThan(0);
  });

  it('量纲与 leg-tier 判档口径互洽 (小数比例, 不是百分数)', () => {
    const rates = computeLegRates({ strike: '100', premium: '15', dteDays: 365 });
    // 15 / 85 ≈ 17.6% 年化 ⇒ 好档。若量纲写成百分数, 这里会判成同一档但边界全错。
    expect(classifyLegTier(rates?.annualizedRate ?? '0', 'annualized', null).tier).toBe('good');
  });

  it('退化输入 → null, 不抛不伪造 0', () => {
    expect(computeLegRates({ strike: '100', premium: '5', dteDays: 0 })).toBeNull();
    expect(computeLegRates({ strike: '100', premium: '5', dteDays: -3 })).toBeNull();
    expect(computeLegRates({ strike: '5', premium: '5', dteDays: 30 })).toBeNull();
    expect(computeLegRates({ strike: '5', premium: '9', dteDays: 30 })).toBeNull();
  });
});

describe('leg-derive.rules — 有效成本 K − P 相对 W 的位置 (FR-003)', () => {
  it('有效成本 = K − P', () => {
    expect(computeEffectiveCost('45', '3').toString()).toBe('42');
  });

  it('相对 W 的位置复用 045 的距 W% 口径 (百分数, 负 = 在 W 下方)', () => {
    // V = 50 ⇒ W = 40; 有效成本 42 ⇒ (42 − 40) / 40 × 100 = 5%。
    expect(computeEffectiveCostVsWPct('50', '45', '3')?.toString()).toBe('5');
    // 有效成本 38 ⇒ 低于愿买价 ⇒ 负值。
    expect(Number(computeEffectiveCostVsWPct('50', '45', '7'))).toBeLessThan(0);
  });

  it('W 由 045 的锚系数派生 —— 本文件不持任何区间系数', () => {
    // 同一个 V 下两条腿的相对位置只随有效成本变化, 单调递增。
    const a = Number(computeEffectiveCostVsWPct('50', '45', '3'));
    const b = Number(computeEffectiveCostVsWPct('50', '45', '2'));
    expect(b).toBeGreaterThan(a);
  });
});

describe('leg-derive.rules — Δ 与 σ 距离同源 (Guardrail 10, plan D-UI-3)', () => {
  it('🚨 property: 随机 1000 个 |Δ| 往返 σ → |Δ| 误差 < 1e-6', () => {
    const random = seededRandom(20260804);
    let worst = 0;
    for (let i = 0; i < 1000; i += 1) {
      // 取 (0, 1) 开区间内的样本, 两端各留一点余量 (端点是发散点, 单列测)。
      const absDelta = 0.0005 + random() * 0.999;
      const columns = deriveDeltaColumns(absDelta);
      expect(columns.sigmaDistance).not.toBeNull();
      const roundTrip = standardNormalCdfOracle(-(columns.sigmaDistance as number));
      worst = Math.max(worst, Math.abs(roundTrip - absDelta));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('对齐标准正态分位点 (教科书值)', () => {
    expect(deriveDeltaColumns(0.5).sigmaDistance).toBeCloseTo(0, 9);
    expect(deriveDeltaColumns(0.4).sigmaDistance).toBeCloseTo(0.2533471, 7);
    expect(deriveDeltaColumns(0.15).sigmaDistance).toBeCloseTo(1.0364334, 7);
    expect(deriveDeltaColumns(0.05).sigmaDistance).toBeCloseTo(1.6448536, 7);
  });

  it('|Δ| 越小 σ 距越远 —— 严格单调', () => {
    const sigmas = [0.45, 0.4, 0.3, 0.15, 0.05].map((d) => deriveDeltaColumns(d).sigmaDistance);
    for (let i = 1; i < sigmas.length; i += 1) {
      expect(sigmas[i] as number).toBeGreaterThan(sigmas[i - 1] as number);
    }
  });

  it('🚨 |Δ| ∈ {0, 1} → 两列同时留空, 不允许一列有一列无', () => {
    for (const absDelta of [0, 1]) {
      expect(deriveDeltaColumns(absDelta)).toEqual({ absDelta: null, sigmaDistance: null });
    }
  });

  it('greeks 缺失 / 越界 / 非数 → 同样两列同时留空', () => {
    for (const absDelta of [null, undefined, Number.NaN, -0.1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(deriveDeltaColumns(absDelta)).toEqual({ absDelta: null, sigmaDistance: null });
    }
  });

  it('两列由**同一个**入参派生 —— 结构保证: 一次调用同时产出, 无第二个数据源', () => {
    // 机械判据: 函数只吃一个 |Δ|。若哪天有人拿 spot/K/IV 反算另一列, 必然要加入参, 这条即红。
    expect(deriveDeltaColumns.length).toBe(1);
    const columns = deriveDeltaColumns(0.42);
    expect(columns.absDelta).toBe(0.42);
    expect(standardNormalCdfOracle(-(columns.sigmaDistance as number))).toBeCloseTo(0.42, 6);
  });

  it('入参取 |Δ| —— 认沽的负 Δ 由调用方取绝对值后传入, 本函数不接受负值', () => {
    expect(deriveDeltaColumns(-0.42)).toEqual({ absDelta: null, sigmaDistance: null });
  });
});

describe('leg-derive.rules — 活跃度是同到期日内的相对排名 (plan D-SOT-5 / 052 D-MARK-1)', () => {
  const EXPIRY_A = '2026-09-18';
  const EXPIRY_B = '2026-10-16';
  /** 第 4 项省略即落 {@link EXPIRY_A} —— 单到期日语境的既有断言写法保持不变。 */
  const rows = (specs: readonly [string, number, number, string?][]): ActivityInput[] =>
    specs.map(([strike, openInterest, volume, expiryKey = EXPIRY_A]) => ({
      strike,
      expiryKey,
      openInterest,
      volume,
    }));

  it('🚨 排名口径是组内相对量不是绝对分档 —— 同一档量级里照样只标前 3', () => {
    const marks = markActivity(
      rows([
        ['97.5', 505, 505],
        ['96.5', 504, 504],
        ['95.5', 503, 503],
        ['94.5', 502, 502],
        ['93.5', 501, 501],
      ]),
    );
    expect(marks.map((m) => m.isTopRanked)).toEqual([true, true, true, false, false]);
  });

  it('🚨 同一批绝对值, 换一个候选集就换归属 —— 绝对阈值实现挡不住这条', () => {
    const leg: [string, number, number] = ['97.5', 100, 100];
    const inSmallSet = markActivity(rows([leg, ['96.5', 1, 1], ['95.5', 2, 2]]));
    const inBigSet = markActivity(
      rows([leg, ['96.5', 900, 900], ['95.5', 800, 800], ['94.5', 700, 700], ['93.5', 600, 600]]),
    );
    expect(inSmallSet[0].isTopRanked).toBe(true);
    expect(inBigSet[0].isTopRanked).toBe(false);
  });

  it('OI 与 Volume 各自排名之和 —— 单指标第一但另一项垫底进不了 Top 3', () => {
    const marks = markActivity(
      rows([
        ['99.5', 10000, 1], // OI 全场第一、Vol 全场垫底 ⇒ 排名和 1 + 8 = 9
        ['98.5', 90, 90], // 两项均第 2 ⇒ 4
        ['97.5', 80, 80], // 6
        ['96.5', 70, 70], // 8
        ['95.5', 60, 60],
        ['94.5', 50, 50],
        ['93.5', 40, 40],
        ['92.5', 30, 30],
      ]),
    );
    expect(marks[0].isTopRanked).toBe(false);
    expect(marks.map((m) => m.isTopRanked)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('整数档 = 行权价为整数, 与排名互不覆盖; 呈现标签整数档优先', () => {
    const marks = markActivity(
      rows([
        ['95', 1, 1],
        ['97.5', 500, 500],
        ['96.5', 400, 400],
        ['94.5', 300, 300],
      ]),
    );
    expect(marks.map((m) => m.isRoundStrike)).toEqual([true, false, false, false]);
    expect(marks[0].label).toBe('round_strike');
    expect(marks[1].label).toBe('top_ranked');
    const both = markActivity(
      rows([
        ['95', 900, 900],
        ['94.5', 1, 1],
      ]),
    );
    expect(both[0]).toEqual({ isRoundStrike: true, isTopRanked: true, label: 'round_strike' });
  });

  it('其余留空 (label 为 null), MUST NOT 伪造一个默认档', () => {
    const marks = markActivity(
      rows([
        ['97.5', 900, 900],
        ['96.5', 800, 800],
        ['95.5', 700, 700],
        ['94.5', 600, 600],
      ]),
    );
    expect(marks[3]).toEqual({ isRoundStrike: false, isTopRanked: false, label: null });
  });

  it('候选集只有 1 条 / 空集 → 不炸', () => {
    expect(() => markActivity([])).not.toThrow();
    expect(markActivity([])).toEqual([]);
    const single = markActivity(rows([['97.5', 300, 300]]));
    expect(single).toHaveLength(1);
    expect(single[0].isTopRanked).toBe(true);
  });

  it('OI / Vol 缺失 → 排在末位, 不当 0 也不抛', () => {
    const marks = markActivity([
      { strike: '97.5', expiryKey: EXPIRY_A, openInterest: null, volume: null },
      { strike: '96.5', expiryKey: EXPIRY_A, openInterest: 100, volume: 100 },
      { strike: '95.5', expiryKey: EXPIRY_A, openInterest: 90, volume: 90 },
      { strike: '94.5', expiryKey: EXPIRY_A, openInterest: 80, volume: 80 },
    ]);
    expect(marks[0].isTopRanked).toBe(false);
    expect(marks[1].isTopRanked).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 052 FR-023 / FR-024: 分组维度改到期日 + 绝对量下限
  // ───────────────────────────────────────────────────────────────────────────

  it('🚨 分组维度是到期日不是整个候选集 —— 同一批腿标的条数超过 Top N 本身', () => {
    const marks = markActivity(
      rows([
        ['97.5', 900, 900, EXPIRY_A],
        ['96.5', 800, 800, EXPIRY_A],
        ['95.5', 700, 700, EXPIRY_A],
        ['94.5', 600, 600, EXPIRY_A], // A 组第 4 ⇒ 不标
        ['93.5', 500, 500, EXPIRY_B], // 全集里排第 5, 但 B 组内是第 1
        ['92.5', 400, 400, EXPIRY_B],
        ['91.5', 300, 300, EXPIRY_B],
        ['90.5', 200, 200, EXPIRY_B], // B 组第 4 ⇒ 不标
      ]),
    );
    // 🚨 候选集口径 (047) 下这里只会有 3 个 `true` 且全落在 A 组; 到期日口径下是 3 + 3。
    expect(marks.map((m) => m.isTopRanked)).toEqual([
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(marks.filter((m) => m.isTopRanked)).toHaveLength(2 * ACTIVITY_TOP_RANK_COUNT);
  });

  it('🚨 整体量低的到期日一个标都不发 —— 组内第一也挡在绝对线外 (plan Guardrail 4)', () => {
    // B 组照 plan D-MARK-1 的实测死到期日: OI 合计 23, top-1 只有 OI = 4。
    const marks = markActivity(
      rows([
        ['97.5', 900, 900, EXPIRY_A],
        ['96.5', 4, 3, EXPIRY_B],
        ['95.5', 3, 1, EXPIRY_B],
        ['94.5', 2, 0, EXPIRY_B],
      ]),
    );
    expect(marks.map((m) => m.isTopRanked)).toEqual([true, false, false, false]);
    // 🚫 相对判据在 B 组内照样排得出第一名 —— 只有绝对线能挡住它。
    expect(marks[1].label).toBeNull();
  });

  it('🚨 绝对线只否决不递补 —— 组内第 3 被挡下时第 4 名过线也不顶上 (FR-024「进前 N 且过线」)', () => {
    const marks = markActivity(
      rows([
        ['97.5', 1000, 1000], // 名次和 1+1, 活动量 2000
        ['96.5', 900, 900], // 2+2, 1800
        ['95.5', 90, 5], // 3+4 = 7 (并列时 OI 大者在前) ⇒ 组内第 3; 活动量 95 < 线
        ['94.5', 80, 30], // 4+3 = 7 ⇒ 组内第 4; 活动量 110 **过线**
      ]),
    );
    expect(marks.map((m) => m.isTopRanked)).toEqual([true, true, false, false]);
  });

  it('绝对线的量 = OI + 当日成交 —— 单侧够不到但两侧合计过线即发标', () => {
    const marks = markActivity(
      rows([
        ['97.5', 60, 50], // 110 ≥ 100
        ['96.5', 60, 39], // 99 < 100
      ]),
    );
    expect(marks.map((m) => m.isTopRanked)).toEqual([true, false]);
  });

  it('OI / Vol 全缺失 → 绝对线判不过, 组内唯一也不发标 (缺失不当「有量」)', () => {
    const marks = markActivity([
      { strike: '97.5', expiryKey: EXPIRY_A, openInterest: null, volume: null },
    ]);
    expect(marks[0].isTopRanked).toBe(false);
  });

  it('某到期日无候选 → 不产生空分组、不除零 (D-MARK-1)', () => {
    expect(markActivity([])).toEqual([]);
    const single = markActivity(rows([['97.5', 300, 300, EXPIRY_B]]));
    expect(single.map((m) => m.isTopRanked)).toEqual([true]);
  });

  it('🚨 同分决胜稳定 —— 同一输入两次调用逐字相同 (plan Guardrail 10)', () => {
    const input = rows([
      ['97.5', 500, 500, EXPIRY_A],
      ['96.5', 500, 500, EXPIRY_A],
      ['95.5', 500, 500, EXPIRY_A],
      ['94.5', 500, 500, EXPIRY_A],
      ['93.5', 500, 500, EXPIRY_B],
      ['92.5', 500, 500, EXPIRY_B],
    ]);
    const first = markActivity(input);
    expect(markActivity(input)).toEqual(first);
    // 全同分时决胜落到原序 ⇒ 每组取前 N 条, 结果确定而非随机。
    expect(first.map((m) => m.isTopRanked)).toEqual([true, true, true, false, true, true]);
  });
});

describe('leg-derive.rules — 成交额 (plan D-SOT-5)', () => {
  it('成交额 = Vol × 权利金 × 合约乘数', () => {
    expect(computeTurnover(12, '3.5')?.toString()).toBe('4200');
    expect(US_OPTION_CONTRACT_MULTIPLIER).toBe(100);
  });

  it('零成交 → 0 (真值就是 0, 与「缺数据」不同)', () => {
    expect(computeTurnover(0, '3.5')?.toString()).toBe('0');
  });

  it('Vol 缺失 → null, MUST NOT 当 0', () => {
    expect(computeTurnover(null, '3.5')).toBeNull();
    expect(computeTurnover(12, null)).toBeNull();
  });

  it('返回 Decimal 而非 number —— 金额不进二进制浮点', () => {
    expect(Prisma.Decimal.isDecimal(computeTurnover(12, '3.5') as Prisma.Decimal)).toBe(true);
  });
});

/**
 * 053 T004 —— 单笔权利金 (`FR-032`, plan D-COL-1)。
 *
 * 🚨 本组的存在理由是 **ADR-0064 不变量 ③**: 这个乘法只许在服务端发生一次。客户端那一半由
 * `rg` 扫「mobile 侧零处乘合约乘数」守 (T004 verify), 这里守的是「服务端这一份算得对」。
 */
describe('leg-derive.rules — 单笔权利金 (053 FR-032)', () => {
  it('单笔权利金 = bid × 合约乘数, 且乘的是**同一份常量** (不新造第二份)', () => {
    expect(computeContractPremium('1.45')?.toString()).toBe('145');
    // 🚨 判别性: 与成交额共用同一个常量 —— 若有人在这里另写一个 100, 改乘数时只会改动一处而
    // 两个数各自照样出得来。用「成交额 ÷ Vol == 单笔权利金」把这层共享钉成可验证的。
    const turnover = computeTurnover(12, '1.45')!;
    expect(turnover.div(12).toString()).toBe(computeContractPremium('1.45')!.toString());
    expect(US_OPTION_CONTRACT_MULTIPLIER).toBe(100);
  });

  it('无 bid → null, 🚫 MUST NOT 当 0 (「没有买盘」不是「白送」)', () => {
    expect(computeContractPremium(null)).toBeNull();
    // 对照: bid 真的是 0 时结果是 0 —— 两者在类型上就分得开。
    expect(computeContractPremium('0')?.toString()).toBe('0');
  });

  it('小数不进二进制浮点 —— 0.1 × 100 恒为 10 而不是 10.000000000000002', () => {
    const premium = computeContractPremium('0.1');
    expect(Prisma.Decimal.isDecimal(premium as Prisma.Decimal)).toBe(true);
    expect(premium?.toString()).toBe('10');
  });
});
