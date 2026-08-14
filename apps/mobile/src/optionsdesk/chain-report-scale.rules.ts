// 055 T009 — 报表色阶判档 +「口径不适用」纯函数（FR-018/FR-019–FR-019c, SC-012, SC-013,
// state_branch 5, plan D-BAND-1 / D-SCALE-1）。无 I/O、无 DI；着色怎么画归 T011 / T012。
//
// 🚨 **档界住 client 是刻意的**（D-BAND-1）：它是**呈现**不是判定 —— 没有一条腿因为落在哪一档
//    而进出候选集。服务端 DTO 因此不含 `band` 字段，本文件是这套口径的**唯一**落点，
//    🚫 MUST NOT 在屏或子件里另判一份（同一判据两处各算一份必 drift，ADR-0064 不变量 ③）。
// 🚨 **形态按每种格值各自定**（FR-019b）—— 🚫 MUST NOT 四种套同一种切法。实测（dev `2026-08-11`
//    一期 / 12 链）线性等距下最淡档吞掉：建仓成色 7.0% ✅ / 收租年化 52.4% ⚠️ / 全腿年化 96.8% 🚫 /
//    活跃度 99.2% 🚫 —— 后三者的色阶实际只剩一档在用，**而图照样画得出来**。SC-012 那条断言防的就是它。
// 🚧 **四组档界取值全部是占位**（`PLACEHOLDER(T020)`）—— FR-019a 要的是跨标的、跨业务日恒定的
//    一组数，MUST 走 T020 那次**跨多业务日**的标定，🚫 不在本片拍板。本片只锁形态与判档口径。
import type {
  ChainReportCellResponse,
  ChainReportGridsResponse,
  ChainReportRowResponse,
} from '@nvy/api-client';

import { toFinite } from './underlying-detail.rules';

// ═══════════════════ ① 档界（FR-019 / FR-019a / FR-019b） ═══════════════════

/** 色阶档数 —— 与 mockup 的 `brand-50 → brand-700` 五档一一对应（真机可分辨性归 T021 / SC-003）。 */
export const CHAIN_REPORT_BAND_COUNT = 5;

/** `1` = 最淡（值最差）… `5` = 最强（值最好）。单向色阶、无中性点（FR-019）。 */
export type ChainReportBand = 1 | 2 | 3 | 4 | 5;

/** 四种格值 —— 键面直接取契约的网格键，🚫 不另立一套字符串（server 改名 ⇒ 这里 typecheck 红）。 */
export type ChainReportMetric = keyof ChainReportGridsResponse;

/** 档界形态（FR-019b）。它记录取值是**怎么切出来的** —— T020 标定时按各自的形态取数。 */
export type BandCutForm = 'linear' | 'quantile' | 'log';

/** 单向色阶的方向（FR-019）：建仓成色越低越好，其余三种越高越好。 */
export type BandDirection = 'higher_is_better' | 'lower_is_better';

export interface ChainReportBandScale {
  readonly form: BandCutForm;
  readonly direction: BandDirection;
  /** 4 个切点，**值空间升序**，切出 5 档；切点本身**闭在下档**。 */
  readonly cuts: readonly [number, number, number, number];
}

export const CHAIN_REPORT_BAND_SCALES: Readonly<Record<ChainReportMetric, ChainReportBandScale>> = {
  // 建仓成色：有效成本相对愿买价的位置，**百分数**，越低越好（FR-011）。
  // 形态 `linear` —— 实测线性等距下最淡档仅 7.0%，本就近均分，没有换形态的理由。
  // ⚠️ **值域跨零**：建仓视角的硬门槛是「有效成本 `K − bid` < spot」而不是「< W」⇒ 上界 =
  //    `(spot − W) / W`（mockup 的 ACN：spot 179.82 / W 140 ⇒ +28%，格值实测正是 +27 / +21 / +3）。
  //    把档界全压在负半轴会让**整片建仓格塌进最淡档**，而网格照样画得出来。
  buildQuality: {
    form: 'linear',
    direction: 'lower_is_better',
    cuts: [-42, -25, -7, 10], // 🚧 PLACEHOLDER(T020)
  },
  // 收租年化：**小数比例**，越高越好。实测值域 `[0.022, 0.714]` 右偏 ⇒ 线性等距最淡档 52.4% ⚠️ ⇒ 分位。
  rentAnnualized: {
    form: 'quantile',
    direction: 'higher_is_better',
    cuts: [0.035, 0.09, 0.22, 0.42], // 🚧 PLACEHOLDER(T020)
  },
  // 全腿年化：与上一格同一个年化数，差别只在成员集。实测 96.8% 的病因是**价内那一行**
  // （内在价值造成的算术假象，max 948.3%），它已由 FR-019c 移出色阶；余下仍右偏 ⇒ 分位。
  allAnnualized: {
    form: 'quantile',
    direction: 'higher_is_better',
    cuts: [0.03, 0.11, 0.32, 0.74], // 🚧 PLACEHOLDER(T020)
  },
  // 活跃度：OI + 当日成交，**张数**，越高越好（FR-013）。幂律长尾（值域 `[1, 127 000]`）⇒ 线性等距
  // 最淡档 99.2% 🚫 ⇒ 走对数（几何切点）。🚨 标的池再大也是这个形状，换一天不改形态、只改取值。
  activity: {
    form: 'log',
    direction: 'higher_is_better',
    cuts: [2, 5, 20, 100], // 🚧 PLACEHOLDER(T020)
  },
};

/**
 * 值 → 档。切点**闭在下档**（`value <= cuts[i]` 落第 i 档），越界钳在两端 —— 🚫 不产生 0 / 6。
 * 非有限值 ⇒ `null`（判不了档就不判，🚫 不编一个档出来）。`O(1)`（至多 4 次比较）。
 */
export function bandOfScale(scale: ChainReportBandScale, value: number): ChainReportBand | null {
  if (!Number.isFinite(value)) return null;
  const hit = scale.cuts.findIndex((cut) => value <= cut);
  const slot = hit === -1 ? CHAIN_REPORT_BAND_COUNT - 1 : hit;
  // 方向只改「哪一端最强」，不改切点本身 —— 越低越好的格值把档序整体翻过来。
  const strength =
    scale.direction === 'higher_is_better' ? slot + 1 : CHAIN_REPORT_BAND_COUNT - slot;
  return strength as ChainReportBand;
}

/** {@link bandOfScale} 的按格值入口。`O(1)`。 */
export function chainReportBand(metric: ChainReportMetric, value: number): ChainReportBand | null {
  return bandOfScale(CHAIN_REPORT_BAND_SCALES[metric], value);
}

// ═══════════════════ ②「口径不适用」（FR-019c / SC-013 / D-SCALE-1） ═══════════════════

/**
 * 「该口径在此行不适用」—— 判据 MUST 是**语义的**：`当前格值 = 全腿年化 ∧ 该行价外档下界 < 0`
 *（= 这是价内那一行）。`O(1)`。
 *
 * 🚨 🚫 MUST NOT 写成 `rowIndex === 0`：行下界（FR-002 现为价内 10%）一改，写死下标的版本会
 *    **静默错位** —— 而它照样渲染得出一张表，只是不着色的换成了别的行。
 * 📌 下界解析不出来时**也算不适用**：宁可少上一格颜色，也不给一行由内在价值撑起来的假梯度
 *（读数 / 腿数 / 下钻照常可用，SC-013）。
 */
export function isScaleInapplicableRow(
  metric: ChainReportMetric,
  row: Pick<ChainReportRowResponse, 'otmFloor'>,
): boolean {
  if (metric !== 'allAnnualized') return false;
  const floor = toFinite(row.otmFloor);
  return floor === null || floor < 0;
}

/**
 * 格 → 着色决定。三个出口互斥：
 * - `band` —— 有值且参与色阶；
 * - `inapplicable` —— 有值但该口径在此行不适用（FR-019c）。🚨 与 `unscaled` **不是一回事**：
 *   读数 / 腿数 / 下钻照常（SC-013），呈现上靠「格内有没有数字」加行标区分；
 * - `unscaled` —— 非 valued（gated / absent）或值缺失，走格态编码（FR-016 / FR-017）。
 *   🚫 缺失态 MUST NOT 用第二种色相（FR-018）：色阶已被格值占满，第二色相会与值抢读。
 */
export type ChainReportCellShade =
  | { readonly kind: 'band'; readonly band: ChainReportBand }
  | { readonly kind: 'inapplicable' }
  | { readonly kind: 'unscaled' };

/** 格态 + 行语义 + 值 → 着色决定。`O(1)`。 */
export function chainReportCellShade(
  metric: ChainReportMetric,
  row: Pick<ChainReportRowResponse, 'otmFloor'>,
  cell: Pick<ChainReportCellResponse, 'state' | 'best'>,
): ChainReportCellShade {
  if (cell.state !== 'valued') return { kind: 'unscaled' };
  if (isScaleInapplicableRow(metric, row)) return { kind: 'inapplicable' };
  const value = toFinite(cell.best);
  if (value === null) return { kind: 'unscaled' };
  const band = chainReportBand(metric, value);
  return band === null ? { kind: 'unscaled' } : { kind: 'band', band };
}
