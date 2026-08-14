// 055 T009 — 报表色阶判档 +「口径不适用」纯函数（FR-018/FR-019–FR-019c, SC-012, SC-013,
// state_branch 5, plan D-BAND-1 / D-SCALE-1）。无 I/O、无 DI；着色怎么画归 T011 / T012。
//
// 🚨 **档界住 client 是刻意的**（D-BAND-1）：它是**呈现**不是判定 —— 没有一条腿因为落在哪一档
//    而进出候选集。服务端 DTO 因此不含 `band` 字段，本文件是这套口径的**唯一**落点，
//    🚫 MUST NOT 在屏或子件里另判一份（同一判据两处各算一份必 drift，ADR-0064 不变量 ③）。
// 🚨 **形态按每种格值各自定**（FR-019b）—— 🚫 MUST NOT 四种套同一种切法。T020 跨 4 个业务日
//    （dev `2026-08-10 / 11 / 12 / 13`，12 链 × 4 天）实测：四种全套线性等距时最淡档吞掉
//    建仓成色 39.2% ✅ / 收租年化 50.9% 🚫 / 全腿年化 95.1% 🚫 / 活跃度 99.2% 🚫 ——
//    后三者的色阶实际只剩一档在用，**而图照样画得出来**。SC-012 那条断言防的就是它。
// ✅ **四组档界取值已由 T020 标定完毕**（跨 4 个业务日汇总取切点、再逐日复验 SC-012）。
//    改这四组数 MUST 重跑那次标定，🚫 不许就地拍一个「看着更整」的数。
// 🚨 **活跃度的形态在 T020 被实测证伪，从 `log` 改成 `quantile`** —— 等比切点在 `[1, 131693]`
//    上仍让中间那档吃到 **50.4%**（08-11 / 08-12 两天破 SC-012）。「幂律 ⇒ 走对数」是个合理的
//    先验，但它只保证切点跨越量级、不保证每档人数均衡；分位切法**按构造**均衡。
//    📌 形态只描述这四个常量是**怎么切出来的** —— 运行期它们是固定值，色阶不随当日样本浮动。
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

/**
 * 档界形态（FR-019b）。它记录取值是**怎么切出来的**（值域等分 / 分位 / 等比）。
 * 📌 `'log'` 本轮标定后**无人使用** —— 活跃度原按「幂律 ⇒ 对数」定它，T020 实测证伪后改
 *    `quantile`。词表里留着它是为了让那次证伪有个落点：下次谁想再用等比切法，先看那条注释。
 */
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
  // 形态 `linear` —— 值域五等分下最大档 39.2%，本就近均分，没有换形态的理由；且它是**有绝对
  // 含义的百分数**（「有效成本比愿买价高/低多少」），线性切点让「−20%」在每一天每只票上是同一件事。
  // ⚠️ **值域跨零**：建仓视角的硬门槛是「有效成本 `K − bid` < spot」而不是「< W」⇒ 正半轴合法。
  //    T020 实测池值域 `[-37.4, +48.5]`、中位 **+14.9** —— 把档界全压在负半轴会让**整片建仓格
  //    塌进最淡档**，而网格照样画得出来。
  // 📐 标定：4 日汇总 240 个非空格，值域五等分 ⇒ `-20.19 | -3.03 | 14.13 | 31.30` → 取整。
  //    逐日最大档 39.4 / 36.8 / 43.5 / 36.4 %（SC-012 上限 50%）。
  buildQuality: {
    form: 'linear',
    direction: 'lower_is_better',
    cuts: [-20, -3, 14, 31],
  },
  // 收租年化：**小数比例**，越高越好。T020 实测值域 `[0.010, 0.776]` 右偏 ⇒ 线性等距最淡档
  // 50.9% 🚫 ⇒ 分位。
  // 📐 标定：4 日汇总 530 个非空格，20/40/60/80 分位 ⇒ `0.0657 | 0.1167 | 0.2008 | 0.3005` → 取整。
  //    逐日最大档 21.3 / 27.4 / 22.4 / 25.0 %。
  rentAnnualized: {
    form: 'quantile',
    direction: 'higher_is_better',
    cuts: [0.065, 0.12, 0.2, 0.3],
  },
  // 全腿年化：与上一格同一个年化数，差别只在成员集。线性等距最淡档 95.1% 的病因是右偏长尾
  // （价内那一行的算术假象已由 FR-019c 移出色阶，本组标定样本**已排除它**）⇒ 分位。
  // 📐 标定：4 日汇总 1119 个非空格（不含价内行），20/40/60/80 分位 ⇒
  //    `0.0339 | 0.0653 | 0.1166 | 0.2126` → 取整。逐日最大档 21.8 / 22.0 / 21.4 / 21.7 %。
  allAnnualized: {
    form: 'quantile',
    direction: 'higher_is_better',
    cuts: [0.035, 0.065, 0.115, 0.21],
  },
  // 活跃度：OI + 当日成交，**张数**，越高越好（FR-013）。幂律长尾（T020 实测值域 `[1, 131693]`、
  // 中位 346）。
  // 🚨 **形态由 `log` 改成 `quantile`，理由是实测而不是口味**：等比切点
  //    `11 | 112 | 1180 | 12464` 让中间那档吃到 **50.4%**（08-11 / 08-12 两天破 SC-012）。
  //    「幂律 ⇒ 对数」只保证切点跨越量级，不保证每档人数均衡。
  // 📐 标定：4 日汇总 1548 个非空格，20/40/60/80 分位 ⇒ `43 | 216 | 535 | 1143` → 取整。
  //    逐日最大档 21.0 / 21.6 / 20.7 / 22.2 %。
  activity: {
    form: 'quantile',
    direction: 'higher_is_better',
    cuts: [45, 215, 535, 1150],
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
