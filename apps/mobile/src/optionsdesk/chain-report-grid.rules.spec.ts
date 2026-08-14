// 055 T011 — 网格几何 + 列/行/格呈现映射单测（`FR-004`/`FR-007`/`FR-009`/`FR-009a`/`FR-019c`,
// `state_branch` 3/10）。
import { describe, expect, it } from 'vitest';
import type { ChainReportColumnResponse, ChainReportRowResponse } from '@nvy/api-client';

import {
  BLOCKED_GLYPH,
  CHAIN_REPORT_COLUMN_WIDTH,
  chainReportCellView,
  chainReportColumnView,
  chainReportContentWidth,
  chainReportGridView,
  chainReportHasColumnOverflow,
  chainReportRowLabel,
  chainReportValueText,
  type ChainReportCellCode,
} from './chain-report-grid.rules';
import type { ChainReportMetric } from './chain-report-scale.rules';

const METRICS: ChainReportMetric[] = [
  'buildQuality',
  'rentAnnualized',
  'allAnnualized',
  'activity',
];

function column(overrides: Partial<ChainReportColumnResponse> = {}): ChainReportColumnResponse {
  return {
    expiryDate: '2026-09-18',
    dteDays: 31,
    isMonthlyChain: true,
    atmIv: 24.5,
    inRecallBand: {
      buildQuality: true,
      rentAnnualized: true,
      allAnnualized: true,
      activity: true,
    },
    ...overrides,
  };
}

function row(otmFloor: string, otmCeiling: string | null = null): ChainReportRowResponse {
  return {
    index: 0,
    otmFloor,
    otmCeiling,
    strikeFloor: null,
    strikeCeiling: '179.820000',
  };
}

const OTM_ROW = row('0.100000', '0.200000');

const valuedCell = (best: string, legCount = 3) => ({ state: 'valued', best, legCount }) as const;

describe('chain-report-grid.rules', () => {
  describe('几何与横滑（state_branch 10）', () => {
    it('内容宽 = 列数 × 列宽（段外列照样算进来）', () => {
      expect(chainReportContentWidth(8)).toBe(8 * CHAIN_REPORT_COLUMN_WIDTH);
    });

    // 🚨 单到期日链 ⇒ 指示条**整条不渲染**：画一条永远铺满的条等于说「这里能滑」，而它不能。
    it('🚨 单列链不溢出 ⇒ 指示条整条不渲染', () => {
      expect(chainReportHasColumnOverflow(1, 300)).toBe(false);
    });

    it('列数超出可视宽 ⇒ 溢出（可横滑）', () => {
      expect(chainReportHasColumnOverflow(12, 300)).toBe(true);
    });

    it('首帧可视宽为 0 时不当成溢出', () => {
      expect(chainReportHasColumnOverflow(12, 0)).toBe(false);
    });
  });

  describe('列（FR-009 / FR-009a）', () => {
    it('🚨 段外判据直接读该格值那一项，🚫 客户端不做「格值 → 视角」映射', () => {
      const outForRent = column({
        inRecallBand: {
          buildQuality: true,
          rentAnnualized: false,
          allAnnualized: true,
          activity: true,
        },
      });
      expect(chainReportColumnView(outForRent, 'rentAnnualized').isOutOfBand).toBe(true);
      expect(chainReportColumnView(outForRent, 'buildQuality').isOutOfBand).toBe(false);
      expect(chainReportColumnView(outForRent, 'activity').isOutOfBand).toBe(false);
    });

    // 🚨 范围框答「哪几列归哪个视角」，淡出答「当前视角管不管这一列」——
    // 前者恒显两段、与当前格值无关；把它做成随格值变，重叠列的两框并存就再也看不见了。
    it('🚨 两条召回段范围框恒显、重叠列两框并存，且不随当前格值变', () => {
      const overlap = column();
      for (const metric of METRICS) {
        const view = chainReportColumnView(overlap, metric);
        expect(view.inBuildBand).toBe(true);
        expect(view.inRentBand).toBe(true);
      }
    });

    // 🚫 淡出不是裁剪：段外列仍在列轴上、仍参与列数（曲线点数与列数恒等吃这一条）。
    it('🚫 段外列仍参与列数与内容宽', () => {
      const columns = [
        column(),
        column({
          expiryDate: '2026-08-22',
          dteDays: 8,
          inRecallBand: {
            buildQuality: true,
            rentAnnualized: false,
            allAnnualized: true,
            activity: true,
          },
        }),
      ];
      const views = columns.map((c) => chainReportColumnView(c, 'rentAnnualized'));
      expect(views).toHaveLength(columns.length);
      expect(views.filter((v) => v.isOutOfBand)).toHaveLength(1);
      expect(chainReportContentWidth(views.length)).toBe(2 * CHAIN_REPORT_COLUMN_WIDTH);
    });

    it('到期日取 MM-DD，DTE 原样带单位', () => {
      const view = chainReportColumnView(column(), 'activity');
      expect(view.expiryText).toBe('09-18');
      expect(view.dteText).toBe('31d');
      expect(view.isMonthly).toBe(true);
    });
  });

  describe('行标签（FR-002 / FR-019c）', () => {
    it('价内 / 价外 / 顶档三种形态', () => {
      expect(chainReportRowLabel(row('-0.100000', '0.000000'), 'activity')).toBe('价内0-10');
      expect(chainReportRowLabel(row('0.000000', '0.100000'), 'activity')).toBe('0-10%');
      expect(chainReportRowLabel(row('0.600000', null), 'activity')).toBe('>60%');
    });

    // 🚨 † 与「不着色」共用同一个判据（`isScaleInapplicableRow`）—— 两处各判一次必错开，
    // 那时行标打了记号而格照样着色（或反过来），两种都渲染得出一张表。
    it('🚨 全腿年化 × 价内行带 †，其余格值同一行不带', () => {
      const icm = row('-0.100000', '0.000000');
      expect(chainReportRowLabel(icm, 'allAnnualized')).toContain('†');
      expect(chainReportRowLabel(icm, 'rentAnnualized')).not.toContain('†');
      expect(chainReportRowLabel(row('0.100000', '0.200000'), 'allAnnualized')).not.toContain('†');
    });
  });

  describe('格值文本（量纲随格值变）', () => {
    it('🚨 两种年化 ×100，建仓成色不 ×100，活跃度上千折 k', () => {
      expect(chainReportValueText('rentAnnualized', 0.54)).toBe('54%');
      expect(chainReportValueText('allAnnualized', 0.053)).toBe('5.3%');
      expect(chainReportValueText('buildQuality', 27)).toBe('+27');
      expect(chainReportValueText('buildQuality', -12.4)).toBe('-12');
      expect(chainReportValueText('activity', 271)).toBe('271');
      expect(chainReportValueText('activity', 1520)).toBe('1.5k');
    });
  });

  describe('格（FR-007 / FR-009a / FR-016–FR-019c）', () => {
    // 🚨 FR-009a 的机器兜底 —— 列级淡出与格级「被门槛挡下」MUST NOT 同码。
    it('🚨 淡出与被门槛挡下是两种码、两种容器', () => {
      const faded = chainReportCellView(
        'rentAnnualized',
        OTM_ROW,
        { state: 'gated', best: null, legCount: 0 },
        true,
      );
      const blocked = chainReportCellView(
        'rentAnnualized',
        OTM_ROW,
        { state: 'gated', best: null, legCount: 0 },
        false,
      );
      expect(faded.code).toBe('out_of_band');
      expect(blocked.code).toBe('blocked');
      expect(faded.container).not.toBe(blocked.container);
      // 被挡下有格内标记，段外没有（段外的主信号在列头）。
      expect(blocked.glyph).toBe(BLOCKED_GLYPH);
      expect(faded.glyph).toBeNull();
    });

    it('🚨 五种码的容器两两不同（不同码 ≠ 同一块灰）', () => {
      const icm = row('-0.100000', '0.000000');
      const views = [
        chainReportCellView('rentAnnualized', OTM_ROW, valuedCell('0.540000'), false),
        chainReportCellView(
          'rentAnnualized',
          OTM_ROW,
          { state: 'gated', best: null, legCount: 0 },
          false,
        ),
        chainReportCellView(
          'rentAnnualized',
          OTM_ROW,
          { state: 'absent', best: null, legCount: 0 },
          false,
        ),
        chainReportCellView('allAnnualized', icm, valuedCell('9.483000', 7), false),
        chainReportCellView(
          'rentAnnualized',
          OTM_ROW,
          { state: 'gated', best: null, legCount: 0 },
          true,
        ),
      ];
      const codes = views.map((v) => v.code);
      expect(new Set(codes).size).toBe(codes.length);
      // 底色可分的是四种；「口径不适用」蓄意与「无合约」同底（mockup 原样）——
      // 它靠**格内有没有数字** + 行标 † 两道冗余信号区分，见下一条。
      const backgrounds = views.filter((v) => v.code !== 'inapplicable').map((v) => v.container);
      expect(new Set(backgrounds).size).toBe(backgrounds.length);
    });

    it('🚨 口径不适用与无合约同底 ⇒ 区分**只能**靠格内有没有数字', () => {
      const icm = row('-0.100000', '0.000000');
      const inapplicable = chainReportCellView(
        'allAnnualized',
        icm,
        valuedCell('9.483000', 7),
        false,
      );
      const empty = chainReportCellView(
        'allAnnualized',
        icm,
        { state: 'absent', best: null, legCount: 0 },
        false,
      );
      expect(inapplicable.container).toBe(empty.container);
      expect(inapplicable.valueText).not.toBeNull();
      expect(empty.valueText).toBeNull();
    });

    // 🚨 FR-007：角标与值**同色**，只靠字号分主次（角标用最淡档在 brand-300 上实测 1.12）。
    it('🚨 腿数角标与格值同色且恒可见', () => {
      // 值与角标读**同一个** `ink`（类型层就没有第二个色源）—— 组件侧照它上色即可。
      const cell = chainReportCellView('rentAnnualized', OTM_ROW, valuedCell('0.050000', 3), false);
      expect(cell.band).toBe(2);
      expect(cell.valueText).toBe('5.0%');
      expect(cell.countText).toBe('3');
      expect(cell.ink).toBe('text-ink');
    });

    it('深两档用浅字（档色是底）', () => {
      const deep = chainReportCellView('rentAnnualized', OTM_ROW, valuedCell('0.700000'), false);
      expect(deep.band).toBe(5);
      expect(deep.ink).toBe('text-white');
    });

    // `SC-013`：不参与色阶 ≠ 不可用 —— 读数与腿数照常，靠「格内有没有数字」与「无合约」分开。
    it('🚨 口径不适用的格照常给读数与腿数', () => {
      const icm = row('-0.100000', '0.000000');
      const view = chainReportCellView('allAnnualized', icm, valuedCell('9.483000', 7), false);
      expect(view.code).toBe('inapplicable');
      expect(view.band).toBeNull();
      expect(view.valueText).toBe('948%');
      expect(view.countText).toBe('7');
    });

    it('无合约的格既无值也无标记（与被挡下可分）', () => {
      const view = chainReportCellView(
        'rentAnnualized',
        OTM_ROW,
        { state: 'absent', best: null, legCount: 0 },
        false,
      );
      expect(view.code satisfies ChainReportCellCode).toBe('void');
      expect(view.valueText).toBeNull();
      expect(view.glyph).toBeNull();
    });

    // 契约异常（valued 却没有值）MUST NOT 掉进「无合约」—— 那是给出错误信息而不是缺失信息。
    it('valued 但值缺失 ⇒ 按「被挡下」呈现，🚫 不呈「无合约」', () => {
      const view = chainReportCellView(
        'rentAnnualized',
        OTM_ROW,
        { state: 'valued', best: null, legCount: 2 },
        false,
      );
      expect(view.code).toBe('blocked');
    });
  });
});

// ═══════════════════ T012 —— 切换格值（FR-010 / SC-002 / Guardrail 6） ═══════════════════

describe('切换格值（FR-010 / SC-002）', () => {
  const ROWS = [row('-0.100000', '0.000000'), row('0.000000', '0.100000')].map((r, index) => ({
    ...r,
    index,
  }));
  const COLUMNS = [
    column({ expiryDate: '2026-08-22', dteDays: 8 }),
    column({ expiryDate: '2026-09-18', dteDays: 31 }),
  ];
  /** 同一份骨架、两种格值 —— 成员集不同（这正是 FR-010 说的「格态随之重算」）。 */
  const CELLS = {
    rentAnnualized: [
      [
        { state: 'gated', best: null, legCount: 0 },
        { state: 'valued', best: '0.430000', legCount: 3 },
      ],
      [
        { state: 'absent', best: null, legCount: 0 },
        { state: 'valued', best: '0.054000', legCount: 1 },
      ],
    ],
    buildQuality: [
      [
        { state: 'valued', best: '-27.000000', legCount: 2 },
        { state: 'gated', best: null, legCount: 0 },
      ],
      [
        { state: 'absent', best: null, legCount: 0 },
        { state: 'gated', best: null, legCount: 0 },
      ],
    ],
  } as const;

  function gridOf(metric: ChainReportMetric) {
    const columnViews = COLUMNS.map((c) => chainReportColumnView(c, metric));
    return chainReportGridView(
      metric,
      ROWS,
      columnViews,
      CELLS[metric === 'buildQuality' ? 'buildQuality' : 'rentAnnualized'],
    );
  }

  // 🚨 SC-002 的客户端一半 —— 「位置不变」与「格态不变」**不是一回事**：
  // 把格态缓存成格的静态属性，网格照样画得出来，只是切换时数字变了颜色没变。
  it('🚨 切换前后行列位置逐格不变，而格态集合**不等**', () => {
    const rent = gridOf('rentAnnualized');
    const build = gridOf('buildQuality');

    expect(build).toHaveLength(rent.length);
    rent.forEach((line, index) => expect(build[index]).toHaveLength(line.length));

    const codesOf = (grid: ReturnType<typeof gridOf>) =>
      grid.map((line) => line.map((c) => c.code));
    expect(codesOf(build)).not.toEqual(codesOf(rent));
  });

  it('维度与行列轴恒等（cells 缺格按「无合约」兜，🚫 不崩也不错位）', () => {
    const columnViews = COLUMNS.map((c) => chainReportColumnView(c, 'activity'));
    const grid = chainReportGridView('activity', ROWS, columnViews, [[]]);
    expect(grid).toHaveLength(ROWS.length);
    expect(grid[0]).toHaveLength(COLUMNS.length);
    expect(grid[0]?.[0]?.code).toBe('void');
  });
});
