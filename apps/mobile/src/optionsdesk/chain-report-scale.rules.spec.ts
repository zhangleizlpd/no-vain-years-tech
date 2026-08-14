// 055 T009 — 色阶判档 + 「口径不适用」纯函数单测（FR-019–FR-019c, SC-012, SC-013,
// state_branch 5, plan D-BAND-1 / D-SCALE-1）。
//
// 🚨 **SC-012 需要一个分布才验得动**，而真分布归 T020 那次跨多业务日的标定。本文件用**合成样本**：
//    形态参数逐条取自 spec `FR-019b` 的实测事实（dev `2026-08-11` 一期 / 12 链），
//    并在下面 `复现实测` 那两条断言里钉死「合成样本确实长成实测那个形状」。
//    🚧 **T020 MUST 用真实标定样本替换本文件的 `SAMPLES`** —— 占位档界一旦换成标定值，
//    拿合成样本验 SC-012 就只是自证。
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

// ═══════════════════ 合成样本（形态取自 FR-019b 实测） ═══════════════════

const SAMPLE_SIZE = 1000;

/** 逆 CDF 等概率取样 —— 全程零随机，样本逐位可复现。 */
const PROBES = Array.from({ length: SAMPLE_SIZE }, (_, i) => (i + 0.5) / SAMPLE_SIZE);

/** 对称三角分布的逆 CDF，`p ∈ (0,1) → t ∈ (0,1)`。 */
function triangular(p: number): number {
  return p <= 0.5 ? Math.sqrt(p / 2) : 1 - Math.sqrt((1 - p) / 2);
}

const SAMPLES: Readonly<Record<ChainReportMetric, readonly number[]>> = {
  // 建仓成色（百分数，越低越好）：对称三角分布 over [-60, +28]。
  // 依据两条 —— ① 形状：线性等距下最淡档（值最差那一端）实测 7.0%，三角分布给 8.4%；
  // ② 值域**跨零**：建仓硬门槛是「有效成本 < spot」而非「< W」⇒ 上界 = `(spot − W) / W`
  //   （mockup 的 ACN = +28%，格值实测 +27 / +21 / +3），下界取深价外腿那一端。
  buildQuality: PROBES.map((p) => -60 + 88 * triangular(p)),
  // 收租年化（小数比例）：实测值域 [0.022, 0.714]，右偏。`u^2.5` 让线性等距最淡档落 52.5%
  // —— 实测 52.4%。
  rentAnnualized: PROBES.map((p) => 0.022 + 0.692 * Math.pow(p, 2.5)),
  // 全腿年化（小数比例）：⚠️ 本样本是**价内行之外**的那批（FR-019c 已把价内行移出色阶），
  // 值域取实测「其余各行 max ≤ 141.8%」。偏度取得比收租更大（全腿视角额外召回短 DTE 腿，
  // 年化 ∝ 1/√T 的尾巴更长）—— 🚨 实测 96.8% 那个数是**含价内行**测的，排除之后没有实测值，
  // 这里的 `u^3` 是**假设**不是实测，T020 标定时会被真样本取代。
  allAnnualized: PROBES.map((p) => 0.02 + 1.398 * Math.pow(p, 3)),
  // 活跃度（张数）：幂律长尾，Pareto α = 0.45、xm = 1、观测上界 127 000 封顶。
  // 线性等距下最淡档 99.0% —— 实测 99.2%。
  activity: PROBES.map((p) => Math.min(127_000, Math.round(Math.pow(1 - p, -1 / 0.45)))),
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

    // 值域跨零：−45% = 有效成本远低于愿买价（最好），+25% = 贴着「< spot」那道硬门槛（最差）。
    it('🚨 建仓成色越低越好：−45% MUST 强于 +25%（方向踩反这条当场红）', () => {
      expect(chainReportBand('buildQuality', -45)).toBe(5);
      expect(chainReportBand('buildQuality', 25)).toBe(1);
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

    it('复现实测：收租年化线性等距下最淡档 ≈ 52.4%', () => {
      const probe: ChainReportBandScale = {
        ...CHAIN_REPORT_BAND_SCALES.rentAnnualized,
        cuts: linearEquidistantCuts(SAMPLES.rentAnnualized),
      };
      expect(lightestPct(probe, SAMPLES.rentAnnualized)).toBeCloseTo(52.4, 0);
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
