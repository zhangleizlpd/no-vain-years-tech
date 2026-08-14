// 055 T009 — 色阶判档 + 「口径不适用」纯函数单测（FR-019–FR-019c, SC-012, SC-013,
// state_branch 5, plan D-BAND-1 / D-SCALE-1）。
//
// 🚨 **SC-012 需要一个分布才验得动**。T020 标定之后本文件的 `SAMPLES` 已从合成样本换成
//    **真实测样本的百分位梯**（dev `2026-08-10 / 11 / 12 / 13` 四个业务日 × 12 链，取数走
//    服务端那份真代码：`chain-report.rules` / `leg-recall.rules` / `leg-derive.rules`）。
//    每种格值 100 个百分位点 ⇒ 逐档占比与真分布差 ≤1%，而档界离 50% 那条线还有 ≥6 个点。
//    🚨 **改档界 MUST 重跑 T020 那次标定**（脚本见 spec § 标定实测），🚫 别就地调这里的数
//    去迁就一个新档界 —— 那是拿样本迁就结论。
import { describe, expect, it } from 'vitest';

import {
  CHAIN_REPORT_BAND_COUNT,
  CHAIN_REPORT_BAND_SCALES,
  bandOfScale,
  chainReportBand,
  chainReportCellShade,
  isScaleInapplicableRow,
  type ChainReportBandScale,
  type ChainReportMetric,
} from './chain-report-scale.rules';

// ═══════════════════ 真实测样本（T020 跨 4 个业务日标定，百分位梯） ═══════════════════

const SAMPLES: Readonly<Record<ChainReportMetric, readonly number[]>> = {
  // 建仓成色（百分数，越低越好）。实测 240 个非空格 · 值域 [-37.35, +48.46] · 中位 +14.89。
  buildQuality: [
    -37.3512, -31.622, -29.9107, -29.6875, -25, -20.797, -18.3962, -17.0973, -15.8389, -13.9849,
    -13.6913, -12.693, -11.3674, -10.8641, -10.5621, -10.1091, -9.5554, -7.4329, -6.4178, -6.0403,
    -5.646, -5.3691, -4.9413, -4.5721, -4.2701, -3.7332, -3.4732, -2.3909, -1.3926, -0.755, -0.6963,
    -0.2936, -0.0419, 0.5034, 0.755, 1.9128, 2.8571, 3, 4.0604, 4.3205, 4.6543, 6.2081, 6.4655,
    8.2447, 9.0357, 10.9914, 11.1399, 11.2069, 11.658, 13.7306, 15.0714, 15.2857, 16.3929, 16.4773,
    17.8756, 18.5357, 19.4286, 20.0714, 20.6783, 20.75, 20.8236, 20.8721, 21, 21.2857, 21.7143,
    22.1899, 23, 23.5714, 23.7857, 24.1477, 24.4318, 25.2035, 25.6395, 25.8523, 26.0756, 26.2857,
    26.7143, 26.9886, 27.1027, 27.2727, 27.3571, 27.626, 28.2143, 29.5058, 30.2519, 30.3779,
    30.5136, 30.7655, 30.9593, 32.1221, 32.3934, 32.8973, 33.0911, 33.2364, 33.7888, 34.4961,
    35.0291, 42.1296, 46.142, 48.4568,
  ],
  // 收租年化（小数比例）。实测 530 个非空格 · 值域 [0.0096, 0.7755] · 中位 0.1604。
  rentAnnualized: [
    0.0096, 0.0169, 0.0219, 0.0247, 0.0268, 0.0304, 0.0329, 0.0365, 0.0394, 0.0416, 0.0432, 0.0445,
    0.0467, 0.0478, 0.0504, 0.0516, 0.054, 0.0596, 0.0624, 0.0637, 0.0665, 0.072, 0.0741, 0.0778,
    0.0811, 0.0852, 0.0882, 0.0905, 0.0944, 0.0963, 0.0976, 0.0996, 0.1019, 0.1046, 0.1065, 0.1102,
    0.1116, 0.1132, 0.1145, 0.1158, 0.1174, 0.1215, 0.1225, 0.1275, 0.1339, 0.1428, 0.1462, 0.1506,
    0.1534, 0.1587, 0.1613, 0.1649, 0.1722, 0.1763, 0.1823, 0.185, 0.1864, 0.192, 0.1957, 0.1982,
    0.2013, 0.2062, 0.2085, 0.2126, 0.2177, 0.2209, 0.2255, 0.2261, 0.2326, 0.2424, 0.2468, 0.2523,
    0.2555, 0.2591, 0.2695, 0.2726, 0.2794, 0.2884, 0.2913, 0.3003, 0.3036, 0.3106, 0.3245, 0.3312,
    0.337, 0.3438, 0.3601, 0.3721, 0.3892, 0.4181, 0.4413, 0.4581, 0.4838, 0.5064, 0.5144, 0.5397,
    0.5617, 0.6033, 0.6952, 0.7755,
  ],
  // 全腿年化（小数比例）。实测 1119 个非空格（**已排除价内行**，FR-019c）· 值域 [0.0053, 2.4662] · 中位 0.0936。
  allAnnualized: [
    0.0053, 0.0078, 0.01, 0.0119, 0.0129, 0.0138, 0.0162, 0.0169, 0.018, 0.0198, 0.0214, 0.0226,
    0.0237, 0.0258, 0.0272, 0.0283, 0.0291, 0.0304, 0.0318, 0.0334, 0.0343, 0.0361, 0.037, 0.0381,
    0.0395, 0.0407, 0.0424, 0.0442, 0.046, 0.0471, 0.0483, 0.0496, 0.051, 0.0527, 0.0555, 0.0567,
    0.0583, 0.0601, 0.0625, 0.0641, 0.0668, 0.0703, 0.0723, 0.0754, 0.0776, 0.0808, 0.0839, 0.0868,
    0.0889, 0.0918, 0.0945, 0.0966, 0.0991, 0.1019, 0.1029, 0.1053, 0.1087, 0.112, 0.1135, 0.1157,
    0.1183, 0.1217, 0.1246, 0.1283, 0.1308, 0.137, 0.1431, 0.1462, 0.1491, 0.153, 0.1587, 0.1615,
    0.1652, 0.1726, 0.1776, 0.1835, 0.1879, 0.1967, 0.2048, 0.2111, 0.2188, 0.2255, 0.2331, 0.2457,
    0.2542, 0.265, 0.2766, 0.2888, 0.3007, 0.3136, 0.3333, 0.3674, 0.4006, 0.4485, 0.4838, 0.5436,
    0.6276, 0.7157, 0.8643, 2.4662,
  ],
  // 活跃度（张数）。实测 1548 个非空格 · 值域 [1, 131693] · 中位 346。
  activity: [
    1, 1, 2, 2, 4, 6, 7, 9, 12, 13, 16, 20, 21, 22, 24, 27, 30, 33, 36, 39, 45, 50, 55, 63, 66, 72,
    75, 81, 94, 97, 105, 107, 118, 134, 146, 159, 162, 165, 178, 198, 220, 232, 250, 260, 274, 289,
    302, 317, 327, 335, 348, 370, 390, 426, 440, 455, 463, 486, 509, 521, 546, 569, 603, 619, 637,
    650, 665, 686, 716, 754, 816, 866, 892, 936, 975, 1006, 1046, 1076, 1103, 1137, 1164, 1247,
    1279, 1340, 1418, 1459, 1528, 1598, 1715, 1824, 2180, 2349, 2648, 3187, 3951, 4392, 6416, 10665,
    19300, 131693,
  ],
};

const METRICS = Object.keys(CHAIN_REPORT_BAND_SCALES) as ChainReportMetric[];

/** 各档吃掉的样本占比（%），下标 = `band − 1`。`O(n)`。 */
function occupancyPct(scale: ChainReportBandScale, values: readonly number[]): number[] {
  const counts = new Array<number>(CHAIN_REPORT_BAND_COUNT).fill(0);
  for (const value of values) {
    const band = bandOfScale(scale, value);
    if (band !== null) counts[band - 1] = (counts[band - 1] ?? 0) + 1;
  }
  return counts.map((c) => (c / values.length) * 100);
}

/** 🔬 反例探针用：值域五等分的切点（= FR-019b 明令不能四种通用的那种切法）。 */
function linearEquidistantCuts(values: readonly number[]): ChainReportBandScale['cuts'] {
  const min = Math.min(...values);
  const step = (Math.max(...values) - min) / CHAIN_REPORT_BAND_COUNT;
  return [min + step, min + step * 2, min + step * 3, min + step * 4];
}

/** 最淡档 = 单向色阶上「值最差」那一档，恒为 band 1。 */
function lightestPct(scale: ChainReportBandScale, values: readonly number[]): number {
  const [lightest = 0] = occupancyPct(scale, values);
  return lightest;
}

// ═══════════════════ 测试夹具（行 / 格） ═══════════════════

function row(otmFloor: string) {
  return { otmFloor };
}

function cell(state: 'valued' | 'gated' | 'absent', best: string | null) {
  return { state, best };
}

/** 行轴现状（FR-002：价内 10% 起、等距 10%）—— 只有第 0 行的下界为负。 */
const ICM_ROW = row('-0.100000');
const OTM_ROW = row('0.100000');

describe('chain-report-scale.rules', () => {
  describe('档界形态（FR-019a / FR-019b）', () => {
    it.each(METRICS)('%s 的切点恰 4 个且严格升序', (metric) => {
      const cuts = [...CHAIN_REPORT_BAND_SCALES[metric].cuts];
      expect(cuts).toHaveLength(CHAIN_REPORT_BAND_COUNT - 1);
      expect([...cuts].sort((a, b) => a - b)).toEqual(cuts);
      expect(new Set(cuts).size).toBe(cuts.length);
    });
  });

  describe('判档（FR-019 单向色阶）', () => {
    it('越高越好的格值：值越大档越强', () => {
      expect(chainReportBand('rentAnnualized', 0.02)).toBe(1);
      expect(chainReportBand('rentAnnualized', 0.7)).toBe(5);
    });

    // 值域跨零：−45% = 有效成本远低于愿买价（最好），+40% = 贴着「< spot」那道硬门槛（最差）。
    // ⚠️ 两个取值都在 T020 实测值域 `[-37.4, +48.5]` 的两端外沿 —— 取 `+25` 这种**中段**值
    //    验不出方向（标定后它落第 2 档，不是最差档）。
    it('🚨 建仓成色越低越好：−45% MUST 强于 +40%（方向踩反这条当场红）', () => {
      expect(chainReportBand('buildQuality', -45)).toBe(5);
      expect(chainReportBand('buildQuality', 40)).toBe(1);
    });

    it('切点闭在下档', () => {
      const [firstCut] = CHAIN_REPORT_BAND_SCALES.rentAnnualized.cuts;
      expect(chainReportBand('rentAnnualized', firstCut)).toBe(
        chainReportBand('rentAnnualized', firstCut - 1e-9),
      );
      expect(chainReportBand('rentAnnualized', firstCut + 1e-9)).toBe(2);
    });

    it('越界钳在两端，🚫 不产生 0 / 6', () => {
      for (const metric of METRICS) {
        expect(chainReportBand(metric, -1e12)).toBeGreaterThanOrEqual(1);
        expect(chainReportBand(metric, 1e12)).toBeLessThanOrEqual(CHAIN_REPORT_BAND_COUNT);
      }
    });

    it('非有限值判不了档 → null，🚫 不编一个档出来', () => {
      expect(chainReportBand('activity', Number.NaN)).toBeNull();
      expect(chainReportBand('activity', Number.POSITIVE_INFINITY)).toBeNull();
    });
  });

  describe('SC-012 任一档 MUST NOT 吞掉过半的非空格', () => {
    it.each(METRICS)('%s 在自己的档界下五档均无过半', (metric) => {
      const pct = occupancyPct(CHAIN_REPORT_BAND_SCALES[metric], SAMPLES[metric]);
      expect(pct).toHaveLength(CHAIN_REPORT_BAND_COUNT);
      expect(Math.max(...pct)).toBeLessThanOrEqual(50);
    });

    // 🔬 反例探针（Guardrail 4）—— 判别力的机器证据：四种都换成线性等距时，
    // 收租 / 全腿 / 活跃度的最淡档必过半（色阶实际只剩一档在用，**而图照样画得出来**）。
    // 建仓成色本就是 linear 形态 ⇒ 探针对它无效是**预期**，不是漏网。
    const LINEAR_PROBE: Readonly<Record<ChainReportMetric, 'passes' | 'fails'>> = {
      buildQuality: 'passes',
      rentAnnualized: 'fails',
      allAnnualized: 'fails',
      activity: 'fails',
    };

    it.each(METRICS)('🔬 %s 换成线性等距后的结局与 FR-019b 实测一致', (metric) => {
      const values = SAMPLES[metric];
      const probe: ChainReportBandScale = {
        ...CHAIN_REPORT_BAND_SCALES[metric],
        form: 'linear',
        cuts: linearEquidistantCuts(values),
      };
      const worst = Math.max(...occupancyPct(probe, values));
      if (LINEAR_PROBE[metric] === 'fails') expect(worst).toBeGreaterThan(50);
      else expect(worst).toBeLessThanOrEqual(50);
    });

    // T020 全样本实测 50.9%；百分位梯上复算 51%（梯把 530 个格压成 100 个点，差 0.1 个点）。
    it('复现实测：收租年化线性等距下最淡档 ≈ 50.9%', () => {
      const probe: ChainReportBandScale = {
        ...CHAIN_REPORT_BAND_SCALES.rentAnnualized,
        cuts: linearEquidistantCuts(SAMPLES.rentAnnualized),
      };
      expect(lightestPct(probe, SAMPLES.rentAnnualized)).toBeCloseTo(50.9, 0);
    });

    it('复现实测：活跃度线性等距下最淡档 ≈ 99.2%', () => {
      const probe: ChainReportBandScale = {
        ...CHAIN_REPORT_BAND_SCALES.activity,
        cuts: linearEquidistantCuts(SAMPLES.activity),
      };
      expect(lightestPct(probe, SAMPLES.activity)).toBeCloseTo(99.2, 0);
    });
  });

  describe('FR-019c / SC-013 「口径不适用」', () => {
    it('只作用「全腿年化 × 价内行」这一个交叉点', () => {
      expect(isScaleInapplicableRow('allAnnualized', ICM_ROW)).toBe(true);
      expect(isScaleInapplicableRow('allAnnualized', OTM_ROW)).toBe(false);
      expect(isScaleInapplicableRow('rentAnnualized', ICM_ROW)).toBe(false);
      expect(isScaleInapplicableRow('buildQuality', ICM_ROW)).toBe(false);
      expect(isScaleInapplicableRow('activity', ICM_ROW)).toBe(false);
    });

    // 🚨 Guardrail 5 —— 判据必须是语义的。写 `rowIndex === 0` 的实现过不了这条：
    // 换一套行下界（这里下界改成 0% 与 −20%），豁免的那一行**随之改变**。
    it('🚨 行下界一改，豁免行随之改变（写死下标过不了）', () => {
      const zeroFloored = [row('0.000000'), row('0.100000'), row('0.200000')];
      expect(zeroFloored.map((r) => isScaleInapplicableRow('allAnnualized', r))).toEqual([
        false,
        false,
        false,
      ]);

      const deepFloored = [row('-0.200000'), row('-0.100000'), row('0.000000')];
      expect(deepFloored.map((r) => isScaleInapplicableRow('allAnnualized', r))).toEqual([
        true,
        true,
        false,
      ]);
    });

    it('下界解析不出来时判「不适用」—— 宁可少上颜色，也不给一行内在价值撑起来的假梯度', () => {
      expect(isScaleInapplicableRow('allAnnualized', row(''))).toBe(true);
    });

    it('🚨 价内行那个 948% MUST NOT 落进最强档（它是内在价值不是机会）', () => {
      expect(chainReportCellShade('allAnnualized', ICM_ROW, cell('valued', '9.483000'))).toEqual({
        kind: 'inapplicable',
      });
    });

    it('SC-013 不参与色阶 ≠ 不可用：与「无值不着色」是两个出口', () => {
      const inapplicable = chainReportCellShade('allAnnualized', ICM_ROW, cell('valued', '0.9500'));
      const unscaled = chainReportCellShade('allAnnualized', ICM_ROW, cell('absent', null));
      expect(inapplicable.kind).toBe('inapplicable');
      expect(unscaled.kind).toBe('unscaled');
      expect(inapplicable.kind).not.toBe(unscaled.kind);
    });
  });

  describe('格 → 着色（FR-016 / FR-018）', () => {
    it('valued 的格按当前格值判档', () => {
      expect(chainReportCellShade('rentAnnualized', OTM_ROW, cell('valued', '0.700000'))).toEqual({
        kind: 'band',
        band: 5,
      });
    });

    it.each(['gated', 'absent'] as const)('%s 的格不进色阶（缺失态走格态编码）', (state) => {
      expect(chainReportCellShade('rentAnnualized', OTM_ROW, cell(state, null)).kind).toBe(
        'unscaled',
      );
    });

    it('valued 但值缺失 / 不可解析 → 不着色，🚫 不落 band 1', () => {
      expect(chainReportCellShade('activity', OTM_ROW, cell('valued', null)).kind).toBe('unscaled');
      expect(chainReportCellShade('activity', OTM_ROW, cell('valued', 'n/a')).kind).toBe(
        'unscaled',
      );
    });
  });
});
