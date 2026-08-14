// 055 T014 — 十字线命中几何 + 读数面板单测（`FR-026`–`FR-029`, `SC-004`,
// `state_branch` 14/15）。
//
// ⚠️ **手势归属（长按 vs 横滑）验不到这一层** —— Expo Web 下 `Pan` 需走原始指针事件，
//    真实手感只有真机能判 ⇒ 归 T021（落层裁定表第三档）。本文件验的是「已经归给十字线的
//    触点怎么换算」与「面板里写什么」。
import { describe, expect, it } from 'vitest';
import type {
  ChainReportCellResponse,
  ChainReportColumnResponse,
  ChainReportRowResponse,
} from '@nvy/api-client';

import {
  CHAIN_REPORT_TRACK_LEFT,
  chainReportColumnIndexAt,
  chainReportReadout,
  chainReportRowIndexAt,
} from './chain-report-crosshair.rules';
import { CHAIN_REPORT_CELL_HEIGHT, CHAIN_REPORT_COLUMN_WIDTH } from './chain-report-grid.rules';

function column(overrides: Partial<ChainReportColumnResponse> = {}): ChainReportColumnResponse {
  return {
    expiryDate: '2026-09-18',
    dteDays: 38,
    isMonthlyChain: true,
    atmIv: 46.3,
    inRecallBand: {
      buildQuality: true,
      rentAnnualized: true,
      allAnnualized: true,
      activity: true,
    },
    ...overrides,
  };
}

const ROW: ChainReportRowResponse = {
  index: 2,
  otmFloor: '0.100000',
  otmCeiling: '0.200000',
  strikeFloor: '143.900000',
  strikeCeiling: '161.800000',
};

const TOP_ROW: ChainReportRowResponse = {
  index: 7,
  otmFloor: '0.600000',
  otmCeiling: null,
  strikeFloor: null,
  strikeCeiling: '71.900000',
};

function cell(
  overrides: Partial<
    Pick<ChainReportCellResponse, 'state' | 'best' | 'runnerUp' | 'legCount'>
  > = {},
) {
  return {
    state: 'valued' as const,
    best: '0.053000',
    runnerUp: null,
    legCount: 1,
    ...overrides,
  };
}

describe('chain-report-crosshair.rules', () => {
  describe('命中几何（FR-026）', () => {
    // 🚨 x 要先减掉外边距 + 冻结列、再减掉横滑位移 —— 拿屏幕坐标直接除列宽会整体偏几列，
    // 而竖线照样画得出来（只是落错列）。
    it('触点 x → 列序（含横滑位移）', () => {
      const x = CHAIN_REPORT_TRACK_LEFT + CHAIN_REPORT_COLUMN_WIDTH * 2 + 5;
      expect(chainReportColumnIndexAt(x, 0, 8)).toBe(2);
      // 已向左滑过两列（tx 为负）⇒ 同一个屏幕位置落在第 4 列。
      expect(chainReportColumnIndexAt(x, -2 * CHAIN_REPORT_COLUMN_WIDTH, 8)).toBe(4);
    });

    it('落在行标列上或右侧空白处 ⇒ 钳到首 / 末列，🚫 不闪空', () => {
      expect(chainReportColumnIndexAt(0, 0, 8)).toBe(0);
      expect(chainReportColumnIndexAt(10_000, 0, 8)).toBe(7);
    });

    it('触点 y → 行序（相对网格体首行顶缘）', () => {
      expect(chainReportRowIndexAt(CHAIN_REPORT_CELL_HEIGHT * 3 + 4, 8)).toBe(3);
      expect(chainReportRowIndexAt(-40, 8)).toBe(0);
      expect(chainReportRowIndexAt(10_000, 8)).toBe(7);
    });

    it('零列 / 零行时不产生负下标', () => {
      expect(chainReportColumnIndexAt(500, 0, 0)).toBe(0);
      expect(chainReportRowIndexAt(500, 0)).toBe(0);
    });
  });

  describe('读数面板（FR-027 / SC-004）', () => {
    it('🚨 一次落点同时给出格明细与**本列 IV**（SC-004 的操作次数 = 1）', () => {
      const view = chainReportReadout('rentAnnualized', ROW, column(), cell(), false);
      expect(view.expiryText).toBe('09-18');
      expect(view.dteText).toBe('38 天');
      expect(view.monthlyText).toBe('月度');
      expect(view.spanText).toBe('10-20% · K 143.90–161.80');
      expect(view.legCountText).toBe('1');
      expect(view.bestText).toBe('5.3%');
      expect(view.ivText).toBe('46.3');
    });

    it('顶档只给行权价上界，🚫 不编一个下界', () => {
      const view = chainReportReadout('rentAnnualized', TOP_ROW, column(), cell(), false);
      expect(view.spanText).toContain('K ≤ 71.90');
    });

    it('本列 IV 定不出来时呈「—」，🚫 不填一个数（FR-023 的读数面）', () => {
      const view = chainReportReadout(
        'rentAnnualized',
        ROW,
        column({ atmIv: null }),
        cell(),
        false,
      );
      expect(view.ivText).toBe('—');
    });

    it('读数标签随格值变（成色 / 年化 / 活跃度不是一个东西）', () => {
      const build = chainReportReadout(
        'buildQuality',
        ROW,
        column(),
        cell({ best: '-27.000000' }),
        false,
      );
      const activity = chainReportReadout('activity', ROW, column(), cell({ best: '1520' }), false);
      expect(build.bestLabel).toBe('最优成色');
      expect(build.bestText).toBe('-27');
      expect(activity.bestLabel).toBe('最活跃');
      expect(activity.bestText).toBe('1.5k');
    });
  });

  describe('🚨 次优（FR-028 / state_branch 14）', () => {
    it('🚨 格内只有一条腿 ⇒ 显式「无（仅 1 条）」，🚫 MUST NOT 复述最优', () => {
      const view = chainReportReadout('rentAnnualized', ROW, column(), cell(), false);
      expect(view.runnerUpIsNone).toBe(true);
      expect(view.runnerUpText).toBe('无（仅 1 条）');
      expect(view.runnerUpText).not.toBe(view.bestText);
    });

    it('两条腿读数相等时次优 = 那个值（判据是腿数不是取值互异）', () => {
      const view = chainReportReadout(
        'rentAnnualized',
        ROW,
        column(),
        cell({ best: '0.053000', runnerUp: '0.053000', legCount: 2 }),
        false,
      );
      expect(view.runnerUpIsNone).toBe(false);
      expect(view.runnerUpText).toBe('5.3%');
    });
  });

  describe('🚨 空格给原因（FR-029 / state_branch 15）', () => {
    // 三种空各自成句 —— 「这里没得挂」与「这里有但都太便宜」是两条完全不同的处置路径。
    it('🚨 三种空的原因两两不同，且都非空', () => {
      const absent = chainReportReadout(
        'rentAnnualized',
        ROW,
        column(),
        cell({ state: 'absent', best: null, legCount: 0 }),
        false,
      );
      const gated = chainReportReadout(
        'rentAnnualized',
        ROW,
        column(),
        cell({ state: 'gated', best: null, legCount: 0 }),
        false,
      );
      const outOfBand = chainReportReadout(
        'rentAnnualized',
        ROW,
        column(),
        cell({ state: 'gated', best: null, legCount: 0 }),
        true,
      );
      const reasons = [absent.emptyReason, gated.emptyReason, outOfBand.emptyReason];
      expect(reasons.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
      expect(new Set(reasons).size).toBe(3);
    });

    // 🚨 「不停留在上一格」是结构性的：面板恒由当前落点算出，空格算出来的就是空格那一份。
    it('🚨 空格的读数位不复用上一格的值', () => {
      const empty = chainReportReadout(
        'rentAnnualized',
        ROW,
        column(),
        cell({ state: 'absent', best: null, runnerUp: null, legCount: 0 }),
        false,
      );
      expect(empty.bestText).toBe('—');
      expect(empty.legCountText).toBe('0');
      expect(empty.runnerUpIsNone).toBe(true);
    });

    it('有值的格没有「为空的原因」', () => {
      expect(
        chainReportReadout('rentAnnualized', ROW, column(), cell(), false).emptyReason,
      ).toBeNull();
    });
  });
});
