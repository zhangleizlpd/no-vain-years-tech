// 055 T013 — 曲线几何单测（`FR-020`–`FR-023`, `SC-005`, `state_branch` 12）。
import { describe, expect, it } from 'vitest';

import {
  CHAIN_REPORT_CURVE_HEIGHT,
  chainReportColumnCenterX,
  chainReportCurveView,
} from './chain-report-curve.rules';
import { CHAIN_REPORT_COLUMN_WIDTH } from './chain-report-grid.rules';

const columns = (ivs: (number | null)[]) => ivs.map((atmIv) => ({ atmIv }));

describe('chain-report-curve.rules', () => {
  describe('点数与列对齐（FR-020 / FR-021 / SC-005）', () => {
    // 🚨 `SC-005` —— 断点也占一个点位。删掉它，后面的点会整体左移去顶替它的位置，
    // 曲线照样画得出来、只是每个点都错了列。
    it('🚨 点数与列数恒等（含断点）', () => {
      const view = chainReportCurveView(columns([24.5, null, 26.1, null, null, 22.8]));
      expect(view.points).toHaveLength(6);
      expect(view.points.map((p) => p.columnIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    // 🚨 Guardrail 9 —— x 是 **track 局部坐标**（0 = 首列左缘）。这里蓄意不调
    // `chainReportColumnCenterX` 来算期望值（那样加个偏移也照样绿），直接用列宽写死。
    it('🚨 第 n 点的 x ≡ 第 n 列中心，🚫 不带任何帧边距偏移', () => {
      const view = chainReportCurveView(columns([24.5, 25.1, 26.3]));
      expect(view.points[0]?.x).toBe(CHAIN_REPORT_COLUMN_WIDTH / 2);
      expect(view.points[1]?.x).toBe(CHAIN_REPORT_COLUMN_WIDTH * 1.5);
      expect(view.points[2]?.x).toBe(CHAIN_REPORT_COLUMN_WIDTH * 2.5);
      expect(view.width).toBe(3 * CHAIN_REPORT_COLUMN_WIDTH);
    });

    // `FR-021`：列序等距 —— 相邻点间距恒为列宽，与到期日实际相差多少天无关
    //（实测同一条链相邻到期日间隔 7 天到 329 天不等）。
    it('🚨 横轴按列序等距，🚫 不按天数等距', () => {
      const view = chainReportCurveView(columns([24.5, 25.1, 26.3, 21.0]));
      const gaps = view.points.slice(1).map((p, i) => p.x - (view.points[i]?.x ?? 0));
      expect(new Set(gaps)).toEqual(new Set([CHAIN_REPORT_COLUMN_WIDTH]));
    });

    it('列中心助手与点的 x 同源', () => {
      expect(chainReportColumnCenterX(3)).toBe(
        chainReportCurveView(columns([1, 1, 1, 1])).points[3]?.x,
      );
    });
  });

  describe('断点（FR-023 / state_branch 12）', () => {
    it('🚨 插值不可得的点 y 为 null，🚫 不补零、不取邻值', () => {
      const view = chainReportCurveView(columns([24.5, null, 26.1]));
      expect(view.points[1]?.y).toBeNull();
      expect(view.points[1]?.value).toBeNull();
    });

    // 🚨 断开 = **连线切段**。只把 y 置空但仍连成一条，屏幕上看不出区别 —— 那正是
    // 「用户读到一条连续的期限结构，而它有一段是编的」。
    it('🚨 断点把连线切成两段，🚫 不跨断点连线', () => {
      const view = chainReportCurveView(columns([24.5, 25.0, null, 26.1, 27.2]));
      expect(view.segments).toHaveLength(2);
      expect(view.segments[0]?.map((p) => p.columnIndex)).toEqual([0, 1]);
      expect(view.segments[1]?.map((p) => p.columnIndex)).toEqual([3, 4]);
      // 段内点数之和 = 可得点数（断点一个都没混进任何段）。
      const inSegments = view.segments.reduce((n, s) => n + s.length, 0);
      expect(inSegments).toBe(view.points.filter((p) => p.y !== null).length);
    });

    it('两侧都断的孤点自成一段（画点不画线）', () => {
      const view = chainReportCurveView(columns([null, 25.0, null]));
      expect(view.segments).toHaveLength(1);
      expect(view.segments[0]).toHaveLength(1);
    });

    it('一个点都定不出来 ⇒ 整条不画，但槽位仍在（点数照样等于列数）', () => {
      const view = chainReportCurveView(columns([null, null, null]));
      expect(view.isEmpty).toBe(true);
      expect(view.segments).toEqual([]);
      expect(view.points).toHaveLength(3);
      expect(view.height).toBe(CHAIN_REPORT_CURVE_HEIGHT);
    });

    it('非有限值按不可得处置（🚫 不画 NaN 坐标）', () => {
      const view = chainReportCurveView([{ atmIv: Number.NaN }, { atmIv: 25 }]);
      expect(view.points[0]?.y).toBeNull();
    });
  });

  describe('纵轴', () => {
    it('值越大点越高（SVG y 轴向下），极值落在留白之内', () => {
      const view = chainReportCurveView(columns([20, 40, 30]));
      const [low, high, mid] = view.points;
      expect(high?.y).toBeLessThan(mid?.y ?? 0);
      expect(mid?.y).toBeLessThan(low?.y ?? 0);
      expect(high?.y).toBeGreaterThan(0);
      expect(low?.y).toBeLessThan(CHAIN_REPORT_CURVE_HEIGHT);
    });

    it('取值全相同 ⇒ 落中线，🚫 不除零', () => {
      const view = chainReportCurveView(columns([25, 25, 25]));
      expect(view.points.every((p) => p.y === CHAIN_REPORT_CURVE_HEIGHT / 2)).toBe(true);
    });
  });
});
