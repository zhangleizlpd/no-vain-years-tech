// 055 T013 — IV 期限结构曲线的**几何**（`FR-020`–`FR-023`, `SC-005`, `state_branch` 12,
// plan `D-UI-3`）。纯函数 → vitest；绘制在 `chain-report-curve.tsx`。
//
// 🚨 **曲线与网格 MUST 同一坐标原点**（Guardrail 9）—— 网格 track 从「冻结行标列之后」起。
//    本文件的 x **一律是 track 局部坐标**（`0` = 首列左缘），曲线组件与网格列区因此挂在
//    **同一个** `LegColumnPane` 位移下，原点同源是**结构性**的而不是靠两处对齐。
//    🚫 MUST NOT 在这里加任何「帧边距」偏移：上一轮 mockup 实撞过 —— 曲线从帧边距起画、
//    第 n 点根本不在第 n 列上，而**六项探测完全失明**（不是对比度 / 不溢出 / 不折行 /
//    无报错 / 无 404 / 无孤儿 class），只有对着 `FR-020` 看图才抓得到。
// 🚨 **横轴按列序等距**（`FR-021`），🚫 MUST NOT 按天数等距 —— 实测同一条链上相邻到期日的
//    间隔从 7 天到 329 天不等，按天数会把短期那一段的多列挤成一团；本曲线要回答的是
//    **逐列对照**，序信息即足够。
// 🚨 **插值不可得的点断开**（`FR-023`）—— 🚫 MUST NOT 以任何形式填充（不补零、不取邻值、
//    不跨点连线）。补一个值进去，用户读到的就是一条连续的期限结构，而它有一段是编的。
// 🚨 **点数与列数恒等**（`SC-005`）—— 断点也占一个点位（`y = null`），🚫 不把它从点集里删掉：
//    删掉之后剩下的点会**整体左移**去顶替它的位置，曲线照样画得出来、只是每个点都错了列。
import type { ChainReportColumnResponse } from '@nvy/api-client';

import { CHAIN_REPORT_COLUMN_WIDTH } from './chain-report-grid.rules';

/** 曲线高（`FR-041` 一屏预算里就是这 62px；越线时**先压它**再压页头）。 */
export const CHAIN_REPORT_CURVE_HEIGHT = 62;

/** 上下留白 —— 极值不贴边，且让点的半径有地方放。 */
const CURVE_PAD_Y = 8;

/** 第 n 列的**中心** x（track 局部坐标）。曲线点与十字线竖线共用这一个。`O(1)`。 */
export function chainReportColumnCenterX(columnIndex: number): number {
  return columnIndex * CHAIN_REPORT_COLUMN_WIDTH + CHAIN_REPORT_COLUMN_WIDTH / 2;
}

export interface ChainReportCurvePoint {
  readonly columnIndex: number;
  /** track 局部坐标，恒等于所属列的中心。 */
  readonly x: number;
  /** 插值不可得 ⇒ `null`（断点）。 */
  readonly y: number | null;
  /** vendor 原样百分数（25.5 = 25.5%），🚫 客户端不再 ×100。 */
  readonly value: number | null;
}

export interface ChainReportCurveView {
  /** 🚨 长度 **恒等于列数**（`SC-005`），断点也在里面。 */
  readonly points: readonly ChainReportCurvePoint[];
  /** 连线段 —— 断点处切开；单点段（两侧都断）只画点不画线。 */
  readonly segments: readonly (readonly ChainReportCurvePoint[])[];
  readonly width: number;
  readonly height: number;
  /** 一个点都定不出来 ⇒ 整条不画（槽位仍在，🚫 不塌高度让网格跳）。 */
  readonly isEmpty: boolean;
}

/**
 * 列轴 → 曲线几何。`O(n)`，n = 列数（实测上界 ~20）。
 *
 * y 轴按本链**自身**取值域拉伸（曲线要回答的是「这条链的期限结构长什么样」，不是跨链比大小）；
 * 只有一个不同取值时落在中线，🚫 不除零、也不画一条贴边的直线。
 */
export function chainReportCurveView(
  columns: readonly Pick<ChainReportColumnResponse, 'atmIv'>[],
  height: number = CHAIN_REPORT_CURVE_HEIGHT,
): ChainReportCurveView {
  const values = columns.map((column) =>
    typeof column.atmIv === 'number' && Number.isFinite(column.atmIv) ? column.atmIv : null,
  );
  const present = values.filter((value): value is number => value !== null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min;
  const innerHeight = height - CURVE_PAD_Y * 2;

  const points = values.map((value, columnIndex) => ({
    columnIndex,
    x: chainReportColumnCenterX(columnIndex),
    // 取值域退化成一个点时落中线 —— 那是「这条链期限结构平坦」的正确画法。
    y:
      value === null
        ? null
        : CURVE_PAD_Y + (span === 0 ? innerHeight / 2 : (1 - (value - min) / span) * innerHeight),
    value,
  }));

  const segments: ChainReportCurvePoint[][] = [];
  for (const point of points) {
    if (point.y === null) {
      // 断点 —— 下一个可得的点**另起一段**，🚫 不与断点前的那一段相连。
      if (segments.at(-1)?.length !== 0) segments.push([]);
      continue;
    }
    if (segments.length === 0) segments.push([]);
    segments.at(-1)?.push(point);
  }

  return {
    points,
    segments: segments.filter((segment) => segment.length > 0),
    width: columns.length * CHAIN_REPORT_COLUMN_WIDTH,
    height,
    isEmpty: present.length === 0,
  };
}
