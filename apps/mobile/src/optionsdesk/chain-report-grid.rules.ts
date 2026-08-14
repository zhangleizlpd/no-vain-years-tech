// 055 T011 — 网格的**几何 + 列/行/格呈现映射**（`FR-004`, `FR-007`, `FR-009`, `FR-009a`,
// `FR-016`–`FR-018`, `state_branch` 3/10, plan `D-UI-2`）。纯函数 → vitest；绘制在
// `chain-report-grid.tsx`。
//
// 🚨 **两级编码 MUST 不同码**（`FR-009a` / Guardrail 7）—— 列级「段外」（这一整列不归当前
//    视角管）与格级「被门槛挡下」（这一格有腿但挂不出去）说的是两件事：
//    · 段外的**主信号是列头 chip**，灰底只是辅 —— `surface-sunken` 与「无合约」的纯白只差
//      约 4% 亮度，40×32 的格子上读起来一样（本片 mockup 第 2 轮实撞，六项探测全绿也照不到）；
//    · 被挡下走格内标记（见 {@link BLOCKED_GLYPH}），🚫 MUST NOT 用第二种色相（`FR-018`）。
// 🚨 **客户端 MUST NOT 自己做「格值 → 视角」映射** —— 直接读列上的 `inRecallBand[格值]`
//    （server 一个字段同时服务 `FR-009` 的两条范围框与 `FR-009a` 的整列淡出）。自己映一份
//    会出现「格有值但整列淡出」这种自相矛盾，**而两边都渲染得出来**。
// 🚨 **淡出不是裁剪**（`state_branch` 3）—— 段外列仍在列轴上、仍参与列数与曲线点数
//    （`FR-020` / `SC-005` 的恒等关系吃这一条）。
// 🚨 **角标与格值同色**（`FR-007`）—— 只靠字号分主次。起草时角标用最淡档，实测在 `brand-300`
//    上对比度只有 **1.12**（几乎不可见）；同色是「值过得了的地方角标也过得了」的唯一做法。
import type {
  ChainReportCellResponse,
  ChainReportColumnResponse,
  ChainReportRowResponse,
} from '@nvy/api-client';

import {
  chainReportCellShade,
  isScaleInapplicableRow,
  type ChainReportBand,
  type ChainReportMetric,
} from './chain-report-scale.rules';
import { toFinite } from './underlying-detail.rules';

// ═══════════════════ ① 几何（mockup 390×844 下的一屏预算，FR-041） ═══════════════════

/** 冻结列（行标签）宽 —— 横滑时不动的那一列。 */
export const CHAIN_REPORT_LABEL_WIDTH = 56;
/** 单列宽。 */
export const CHAIN_REPORT_COLUMN_WIDTH = 40;
/** 单格高（行高同此）。 */
export const CHAIN_REPORT_CELL_HEIGHT = 32;

/** 右侧列区内容总宽。`O(1)`。 */
export function chainReportContentWidth(columnCount: number): number {
  return columnCount * CHAIN_REPORT_COLUMN_WIDTH;
}

/**
 * 列区是否横向溢出。`O(1)`。
 *
 * 🚨 不溢出 ⇒ **指示条整条不渲染**（`state_branch` 10：单到期日链）—— 画一条永远铺满的
 * 指示条等于告诉用户「这里可以滑」，而它不能滑。首帧 `viewportW = 0` 同样落在这一支。
 */
export function chainReportHasColumnOverflow(columnCount: number, viewportWidth: number): boolean {
  return viewportWidth > 0 && chainReportContentWidth(columnCount) > viewportWidth;
}

// ═══════════════════ ② 列（FR-009 / FR-009a） ═══════════════════

export interface ChainReportColumnView {
  /** `MM-DD`。 */
  readonly expiryText: string;
  /** 期限天数。 */
  readonly dteText: string;
  /** 月度到期链标（判据在 server，与选约表同一处）。 */
  readonly isMonthly: boolean;
  /** 🚨 当前格值对应视角的召回段**之外** ⇒ 整列淡出（列仍在，`state_branch` 3）。 */
  readonly isOutOfBand: boolean;
  /** 建仓段范围框 —— 🚨 **恒显**，不随当前格值变（`FR-009`）。 */
  readonly inBuildBand: boolean;
  /** 收租段范围框 —— 同上；两段重叠的列**两框并存**，🚫 不归给其中一段。 */
  readonly inRentBand: boolean;
}

/** 一列 → 列头呈现。`O(1)`。 */
export function chainReportColumnView(
  column: ChainReportColumnResponse,
  metric: ChainReportMetric,
): ChainReportColumnView {
  const [, month, day] = column.expiryDate.split('-');
  return {
    expiryText: month === undefined || day === undefined ? column.expiryDate : `${month}-${day}`,
    dteText: `${column.dteDays}d`,
    isMonthly: column.isMonthlyChain,
    // 🚨 直接读该格值那一项，🚫 不在客户端做「格值 → 视角」的映射。
    isOutOfBand: !column.inRecallBand[metric],
    inBuildBand: column.inRecallBand.buildQuality,
    inRentBand: column.inRecallBand.rentAnnualized,
  };
}

// ═══════════════════ ③ 行（FR-002 / FR-019c） ═══════════════════

/** 「口径不适用」那一行的行标记（`FR-019c`；与不着色**同一个判据**，🚫 不另判一次）。 */
export const INAPPLICABLE_ROW_MARK = ' †';

/** 一行 → 行标签文本。价内那一档按「价内 a-b」读，顶档开口写 `>x%`。`O(1)`。 */
export function chainReportRowLabel(
  row: ChainReportRowResponse,
  metric: ChainReportMetric,
): string {
  const floor = toFinite(row.otmFloor);
  const ceiling = toFinite(row.otmCeiling);
  const mark = isScaleInapplicableRow(metric, row) ? INAPPLICABLE_ROW_MARK : '';
  if (floor === null) return `—${mark}`;
  const pct = (v: number) => Math.round(Math.abs(v) * 100);
  // 顶档无上界 —— 开口吸收其上全部腿（🚫 极深价外腿 MUST NOT 掉出网格）。
  if (ceiling === null) return `>${pct(floor)}%${mark}`;
  if (floor < 0) return `价内${pct(ceiling)}-${pct(floor)}${mark}`;
  return `${pct(floor)}-${pct(ceiling)}%${mark}`;
}

// ═══════════════════ ④ 格（FR-007 / FR-016–FR-019c） ═══════════════════

/**
 * 「有腿但被门槛挡下」的格内标记。mockup 用 CSS `repeating-linear-gradient` 斜纹，**RN 无等价物**
 * ⇒ 改用字形 + `surface-alt` 底：两条都不是色相（守住 `FR-018`），且与「无合约」的纯白空格在
 * 40×32 上一眼可分（`FR-017` 不依赖图例）。真机可分辨性归 T021 目视。
 */
export const BLOCKED_GLYPH = '╱';

export type ChainReportCellCode = 'band' | 'blocked' | 'void' | 'inapplicable' | 'out_of_band';

export interface ChainReportCellView {
  readonly code: ChainReportCellCode;
  readonly band: ChainReportBand | null;
  /** 容器 class —— 🚨 五种码**两两不同**（`FR-009a` 的机器兜底）。 */
  readonly container: string;
  /** 值与角标**同色**（`FR-007`）。 */
  readonly ink: string;
  readonly valueText: string | null;
  readonly countText: string | null;
  readonly glyph: string | null;
}

const CELL_FRAME = 'border-r border-b border-line-soft';

const BAND_BG: Record<ChainReportBand, string> = {
  1: 'bg-brand-50',
  2: 'bg-brand-100',
  3: 'bg-brand-300',
  4: 'bg-brand-500',
  5: 'bg-brand-700',
};

/** 深两档用浅字 —— 档色是底，字要压得住（`FR-007` 的同色约束只约束值与角标之间）。 */
const BAND_INK: Record<ChainReportBand, string> = {
  1: 'text-ink',
  2: 'text-ink',
  3: 'text-ink',
  4: 'text-white',
  5: 'text-white',
};

/**
 * 格值 → 显示文本。🚨 **量纲随格值变**：建仓成色本就是百分数（🚫 不再 ×100），两种年化是
 * 小数比例（×100 才是百分数），活跃度是张数（上千折 `k`）。`O(1)`。
 */
export function chainReportValueText(metric: ChainReportMetric, value: number): string {
  if (metric === 'buildQuality') return `${value >= 0 ? '+' : ''}${Math.round(value)}`;
  if (metric === 'activity') {
    if (value < 1000) return String(Math.round(value));
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1) : String(Math.round(k))}k`;
  }
  const pct = value * 100;
  return `${Math.abs(pct) < 10 ? pct.toFixed(1) : String(Math.round(pct))}%`;
}

/**
 * 格 → 呈现。判定顺序即语义：**列级淡出 → 口径不适用 → 有值 → 无合约 / 被挡下**。`O(1)`。
 *
 * 🚨 列级先判：段外列里的格一律是 `gated`（该视角根本不召回这一列），把它们渲成格级纹理
 * 等于用格级手段说一件列级的事 —— 实测建仓格值下第四成因的 87%（280/322 格）落在段外。
 */
export function chainReportCellView(
  metric: ChainReportMetric,
  row: Pick<ChainReportRowResponse, 'otmFloor'>,
  cell: Pick<ChainReportCellResponse, 'state' | 'best' | 'legCount'>,
  isOutOfBand: boolean,
): ChainReportCellView {
  if (isOutOfBand) {
    // 网格线溶进底色，让整块「脱离网格」；主信号仍是列头 chip。
    return {
      code: 'out_of_band',
      band: null,
      container: 'bg-surface-sunken border-r border-b border-surface-sunken',
      ink: 'text-ink-muted',
      valueText: null,
      countText: null,
      glyph: null,
    };
  }

  const shade = chainReportCellShade(metric, row, cell);
  const value = toFinite(cell.best);

  if (shade.kind === 'inapplicable') {
    // 底同「无合约」的纯白，区分靠**格内有没有数字**（`SC-013`：读数 / 腿数照常）。
    return {
      code: 'inapplicable',
      band: null,
      container: `bg-surface ${CELL_FRAME}`,
      ink: 'text-ink-muted',
      valueText: value === null ? null : chainReportValueText(metric, value),
      countText: cell.legCount > 0 ? String(cell.legCount) : null,
      glyph: null,
    };
  }

  if (shade.kind === 'band') {
    const ink = BAND_INK[shade.band];
    return {
      code: 'band',
      band: shade.band,
      container: `${BAND_BG[shade.band]} ${CELL_FRAME}`,
      ink,
      valueText: value === null ? null : chainReportValueText(metric, value),
      countText: cell.legCount > 0 ? String(cell.legCount) : null,
      glyph: null,
    };
  }

  if (cell.state === 'absent') {
    return {
      code: 'void',
      band: null,
      container: `bg-surface ${CELL_FRAME}`,
      ink: 'text-ink-muted',
      valueText: null,
      countText: null,
      glyph: null,
    };
  }

  // `gated`，以及「有值但值缺失」这种契约异常 —— 都按「有腿但挂不出去」呈现，
  // 🚫 MUST NOT 掉进「无合约」（那是给出错误信息而不是缺失信息）。
  return {
    code: 'blocked',
    band: null,
    container: `bg-surface-alt ${CELL_FRAME}`,
    ink: 'text-ink-muted',
    valueText: null,
    countText: null,
    glyph: BLOCKED_GLYPH,
  };
}
