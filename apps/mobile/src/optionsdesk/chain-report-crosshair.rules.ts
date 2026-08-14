// 055 T014 — 十字线的**命中几何 + 读数面板内容**（`FR-025`–`FR-030`, `SC-004`,
// `state_branch` 14/15, plan `D-UI-2`）。纯函数 → vitest；手势与绘制在屏 / 组件侧。
//
// 🚨 **长按与横滑靠「是否先长按」区分**（`FR-030` / Guardrail 8）—— 🚫 MUST NOT 依据触点坐标
//    分流。落法是 RNGH 的 `Gesture.Pan().activateAfterLongPress(...)` + `Gesture.Exclusive`：
//    判据是**时间**（有没有按住），不是位置。本文件因此**不含任何「这块区域归谁」的判断**，
//    只把已经归给十字线的触点换算成行列。
// 🚨 **命中用的 x 是 track 局部坐标**（与曲线、网格列区同一原点，Guardrail 9）——
//    换算时先减掉冻结列与外边距、再减掉横滑位移 `tx`，🚫 别拿屏幕坐标直接除列宽。
// 🚨 **落到空格 MUST 给出「为什么空」**（`FR-029` / `state_branch` 15），🚫 MUST NOT 停留在
//    上一格的读数 —— 停留是「给出错误信息」，比什么都不给更坏，而面板照样填得满满的。
// 🚨 **次优为空 MUST 显式呈「无」**（`FR-028` / `state_branch` 14），🚫 MUST NOT 复述最优值充数：
//    次优存在的意义正是回答「这一格是一条腿撑起来的、还是一片腿都不错」。
import type {
  ChainReportCellResponse,
  ChainReportColumnResponse,
  ChainReportRowResponse,
} from '@nvy/api-client';

import { spacing } from '~/theme';
import {
  CHAIN_REPORT_CELL_HEIGHT,
  CHAIN_REPORT_COLUMN_WIDTH,
  CHAIN_REPORT_LABEL_WIDTH,
  chainReportCellView,
  chainReportRowLabel,
  chainReportValueText,
  type ChainReportCellCode,
} from './chain-report-grid.rules';
import type { ChainReportMetric } from './chain-report-scale.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { formatPriceText } from './price-format.rules';
import { toFinite } from './underlying-detail.rules';

const COPY = OPTIONSDESK_COPY.chainReport;

/** 长按判定时长 —— 与横滑的唯一分界（`FR-030`）。 */
export const CHAIN_REPORT_CROSSHAIR_LONG_PRESS_MS = 300;

/**
 * 网格左侧外边距。**与屏上的 `px-md` 同源**（`spacing.md`），🚫 不写死一个 16 ——
 * 两处各写一份时，改了 padding 十字线会整体偏一列，**而线照样画得出来**。
 */
export const CHAIN_REPORT_GUTTER = Number.parseFloat(spacing.md);

/** track 左缘相对屏内容左缘的距离（外边距 + 冻结行标列）。 */
export const CHAIN_REPORT_TRACK_LEFT = CHAIN_REPORT_GUTTER + CHAIN_REPORT_LABEL_WIDTH;

function clampIndex(raw: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, raw));
}

/**
 * 触点 x（相对手势容器左缘）→ 列序。`tx` 为当前横滑位移（负值域）。`O(1)`。
 *
 * 越界钳到首 / 末列 —— 手指滑到行标列上或右边空白处时读数**停在边界列**，
 * 🚫 不返回 `null` 让面板闪空（那比停在边界列更难读）。
 */
export function chainReportColumnIndexAt(localX: number, tx: number, columnCount: number): number {
  const inTrack = localX - CHAIN_REPORT_TRACK_LEFT - tx;
  return clampIndex(Math.floor(inTrack / CHAIN_REPORT_COLUMN_WIDTH), columnCount);
}

/** 触点 y（相对**网格体首行顶缘**）→ 行序。越界钳到首 / 末行。`O(1)`。 */
export function chainReportRowIndexAt(localY: number, rowCount: number): number {
  return clampIndex(Math.floor(localY / CHAIN_REPORT_CELL_HEIGHT), rowCount);
}

// ═══════════════════ 读数面板（FR-027 / FR-028 / FR-029 / SC-004） ═══════════════════

export interface ChainReportReadoutView {
  /** `MM-DD`。 */
  readonly expiryText: string;
  readonly dteText: string;
  /** 月度到期链标；非月度 ⇒ `null`。 */
  readonly monthlyText: string | null;
  /** 价外档区间 + 对应行权价区间（`FR-027`）。 */
  readonly spanText: string;
  readonly legCountText: string;
  /** 读数标签随格值变（成色 / 年化 / 活跃度不是一个东西）。 */
  readonly bestLabel: string;
  readonly bestText: string;
  readonly runnerUpLabel: string;
  readonly runnerUpText: string;
  /** 次优为空 —— 呈现侧据此改用「无」的字重 / 颜色，🚫 不复述最优。 */
  readonly runnerUpIsNone: boolean;
  /** 🚨 `SC-004`：格明细与**本列 IV** 在同一次操作里一起给出。 */
  readonly ivText: string;
  /** 空格的原因（`FR-029`）；有值 ⇒ `null`。 */
  readonly emptyReason: string | null;
}

/** 空格三种成因各自成句 —— 与格的呈现码**同源**（🚫 不另判一次）。 */
const EMPTY_REASON: Record<Exclude<ChainReportCellCode, 'band' | 'inapplicable'>, string> = {
  void: COPY.readoutReasonVoid,
  blocked: COPY.readoutReasonBlocked,
  out_of_band: COPY.readoutReasonOutOfBand,
};

function strikeSpanText(row: ChainReportRowResponse): string {
  const floor = toFinite(row.strikeFloor);
  const ceiling = toFinite(row.strikeCeiling);
  if (ceiling === null) return COPY.noValue;
  const ceilingText = formatPriceText(ceiling);
  // 顶档无下界（开口吸收其上全部腿）⇒ 只给上界，🚫 不编一个下界出来。
  return floor === null
    ? `${COPY.readoutStrikePrefix}≤ ${ceilingText}`
    : `${COPY.readoutStrikePrefix}${formatPriceText(floor)}–${ceilingText}`;
}

/**
 * 十字线落点 → 读数面板。`O(1)`。
 *
 * 📌 面板**恒由当前落点算出**（无缓存、无「上一格」概念）—— `FR-029`「不停留在上一格」
 * 因此是结构性的：拖到哪算到哪，空格算出来的就是空格那一份。
 */
export function chainReportReadout(
  metric: ChainReportMetric,
  row: ChainReportRowResponse,
  column: ChainReportColumnResponse,
  cell: Pick<ChainReportCellResponse, 'state' | 'best' | 'runnerUp' | 'legCount'>,
  isOutOfBand: boolean,
): ChainReportReadoutView {
  const view = chainReportCellView(metric, row, cell, isOutOfBand);
  const [, month, day] = column.expiryDate.split('-');
  const best = toFinite(cell.best);
  const runnerUp = toFinite(cell.runnerUp);
  const labels = COPY.readoutMetricLabels[metric];

  return {
    expiryText: month === undefined || day === undefined ? column.expiryDate : `${month}-${day}`,
    dteText: `${column.dteDays}${COPY.readoutDteSuffix}`,
    monthlyText: column.isMonthlyChain ? COPY.readoutMonthly : null,
    spanText: `${chainReportRowLabel(row, metric)} · ${strikeSpanText(row)}`,
    legCountText: String(cell.legCount),
    bestLabel: labels.best,
    bestText: best === null ? COPY.noValue : chainReportValueText(metric, best),
    runnerUpLabel: labels.runnerUp,
    // 🚨 `FR-028`：只有一条腿时说清「仅 1 条」，其余情况就是「无」，两者都 🚫 不复述最优。
    runnerUpText:
      runnerUp === null
        ? cell.legCount <= 1
          ? COPY.readoutNoneSingle
          : COPY.readoutNone
        : chainReportValueText(metric, runnerUp),
    runnerUpIsNone: runnerUp === null,
    ivText: column.atmIv === null ? COPY.noValue : column.atmIv.toFixed(1),
    emptyReason:
      view.code === 'band' || view.code === 'inapplicable' ? null : EMPTY_REASON[view.code],
  };
}
