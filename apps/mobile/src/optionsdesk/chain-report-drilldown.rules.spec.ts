// 055 T016 — 下钻预填 + 业务日不一致的单测（Small，logic-only）。
//
// 🚨 本文件盯的两件事都是「照样渲染得出来」的那一类：
//    ① 预填以**空表单**为底 ⇒ 权利金 / 活性 / 价差被一并覆盖成「不限」（空串在契约里就是这个
//       意思），表里多出报表那一格根本没数进去的腿 —— 而表照常渲染、条数看着还更「丰富」。
//    ② 两侧业务日不同却不说 ⇒ 「报表说 5 条、进去只有 3 条」，每个数字都对，只是不属于同一天。
import { describe, expect, it } from 'vitest';
import type { RetrievalCriteriaResponse } from '@nvy/api-client';

import {
  CHAIN_REPORT_DRILLDOWN_TAB,
  chainReportCellHitAt,
  chainReportDrilldownAsOfNotice,
  chainReportDrilldownParams,
  chainReportPrefillForm,
  chainReportPrefillOf,
} from './chain-report-drilldown.rules';
import {
  CHAIN_REPORT_TRACK_LEFT,
  chainReportColumnIndexAt,
  chainReportRowIndexAt,
} from './chain-report-crosshair.rules';
import { CHAIN_REPORT_CELL_HEIGHT, CHAIN_REPORT_COLUMN_WIDTH } from './chain-report-grid.rules';
import { criteriaFormOf } from './leg-criteria.rules';

const ROW = { otmFloor: '0.100000', strikeFloor: '120.0000', strikeCeiling: '135.0000' };
/** 顶档：无上界 ⇒ 行权价**无下界**（开口吸收其上全部腿）。 */
const TOP_ROW = { otmFloor: '0.600000', strikeFloor: null, strikeCeiling: '80.0000' };
const COLUMN = { dteDays: 45 };
const VALUED = { state: 'valued' as const, best: '0.184000', legCount: 3 };
const ABSENT = { state: 'absent' as const, best: null, legCount: 0 };
const GATED = { state: 'gated' as const, best: null, legCount: 4 };

/** 系统默认值：六维都非空 —— 空表单为底的探针要靠它才看得出被覆盖成「不限」。 */
const DEFAULTS: RetrievalCriteriaResponse = {
  strikeMin: '90.0000',
  strikeMax: '150.0000',
  dteBand: { min: 20, max: 70 },
  premiumMin: '0.5000',
  livenessMin: { oi: 50, volume: 5 },
  relativeSpreadMax: '0.3500',
};

function paramsOf(cell: typeof VALUED | typeof ABSENT | typeof GATED, outOfBand = false) {
  return chainReportDrilldownParams({
    metric: 'rentAnnualized',
    row: ROW,
    column: COLUMN,
    cell,
    isOutOfBand: outOfBand,
    reportAsOf: '2026-08-11',
  });
}

describe('🚨 055 T016 —— 触点落在网格体之外 MUST NOT 跳转', () => {
  const COLS = 6;
  const ROWS = 8;
  /** 第 2 列、第 3 行的格心（未横滑）。 */
  const X = CHAIN_REPORT_TRACK_LEFT + CHAIN_REPORT_COLUMN_WIDTH * 2 + 5;
  const Y = CHAIN_REPORT_CELL_HEIGHT * 3 + 5;

  it('网格体之内 ⇒ 命中该格', () => {
    expect(chainReportCellHitAt(X, Y, 0, COLS, ROWS)).toEqual({ rowIndex: 3, columnIndex: 2 });
  });

  it('🚨 点在曲线 / 列头上（y < 0）⇒ `null`，🚫 不钳进第一行', () => {
    expect(chainReportCellHitAt(X, -20, 0, COLS, ROWS)).toBeNull();
  });

  it('🚨 点在冻结行标列上 ⇒ `null`', () => {
    expect(chainReportCellHitAt(CHAIN_REPORT_TRACK_LEFT - 5, Y, 0, COLS, ROWS)).toBeNull();
  });

  it('🚨 横滑之后行标列仍判得出来（判据用屏幕坐标，不是 track 坐标）', () => {
    // `tx = -200` 时，`localX - TRACK_LEFT - tx` 在行标列上照样是正数 ⇒ 拿它判就恒为真。
    expect(chainReportCellHitAt(CHAIN_REPORT_TRACK_LEFT - 5, Y, -200, COLS, ROWS)).toBeNull();
  });

  it('🚨 点在末列右侧的空白处 / 末行下方 ⇒ `null`', () => {
    const beyondX = CHAIN_REPORT_TRACK_LEFT + CHAIN_REPORT_COLUMN_WIDTH * COLS + 5;
    expect(chainReportCellHitAt(beyondX, Y, 0, COLS, ROWS)).toBeNull();
    expect(chainReportCellHitAt(X, CHAIN_REPORT_CELL_HEIGHT * ROWS + 5, 0, COLS, ROWS)).toBeNull();
  });

  it('🚨 与十字线**共用同一套几何**，只是越界策略相反（同一个界内触点算出同一格）', () => {
    const hit = chainReportCellHitAt(X, Y, -80, COLS, ROWS);
    expect(hit?.columnIndex).toBe(chainReportColumnIndexAt(X, -80, COLS));
    expect(hit?.rowIndex).toBe(chainReportRowIndexAt(Y, ROWS));
    // 界外那一半才分家：十字线钳到边界格、跳转返 `null`。
    expect(chainReportCellHitAt(X, -20, 0, COLS, ROWS)).toBeNull();
    expect(chainReportRowIndexAt(-20, ROWS)).toBe(0);
  });
});

describe('055 T016 —— 格值 → 落点视角（FR-039）', () => {
  it('建仓 / 收租各落自己的视角', () => {
    expect(CHAIN_REPORT_DRILLDOWN_TAB.buildQuality).toBe('build');
    expect(CHAIN_REPORT_DRILLDOWN_TAB.rentAnnualized).toBe('rent');
  });

  it('🚨 全腿与活跃度**都**落全腿视角（口径同源 + 不静默落空）', () => {
    expect(CHAIN_REPORT_DRILLDOWN_TAB.allAnnualized).toBe('all');
    expect(CHAIN_REPORT_DRILLDOWN_TAB.activity).toBe('all');
  });
});

describe('055 T016 —— 有值格 → 下钻参数（FR-038）', () => {
  it('期限区间收成该到期日一天', () => {
    const params = paramsOf(VALUED);
    expect(params?.dteMin).toBe('45');
    expect(params?.dteMax).toBe('45');
  });

  it('行权价区间取该价外档对应的区间', () => {
    const params = paramsOf(VALUED);
    expect(params?.strikeMin).toBe('120.0000');
    expect(params?.strikeMax).toBe('135.0000');
  });

  it('报表业务日随参数同行（FR-039a 的比对输入，🚫 不新增契约字段）', () => {
    expect(paramsOf(VALUED)?.reportAsOf).toBe('2026-08-11');
  });

  it('🚨 无合约的格 MUST NOT 跳转', () => {
    expect(paramsOf(ABSENT)).toBeNull();
  });

  it('🚨 被门槛挡下的格 MUST NOT 跳转（那里没有可预填的「该格的腿」）', () => {
    expect(paramsOf(GATED)).toBeNull();
  });

  it('🚨 段外列的格 MUST NOT 跳转（整列不归当前视角管）', () => {
    expect(paramsOf(VALUED, true)).toBeNull();
  });

  it('🚨 顶档（行权价无下界）⇒ 下界给空串，🚫 不编一个下界出来', () => {
    const params = chainReportDrilldownParams({
      metric: 'rentAnnualized',
      row: TOP_ROW,
      column: COLUMN,
      cell: VALUED,
      isOutOfBand: false,
      reportAsOf: '2026-08-11',
    });
    expect(params?.strikeMin).toBe('');
    expect(params?.strikeMax).toBe('80.0000');
  });
});

describe('055 T016 —— 路由参数 → 预填（缺一不可）', () => {
  const RAW = {
    perspective: 'rent',
    dteMin: '45',
    dteMax: '45',
    strikeMin: '120.0000',
    strikeMax: '135.0000',
    reportAsOf: '2026-08-11',
  };

  it('完整参数解析得出', () => {
    expect(chainReportPrefillOf(RAW)?.tab).toBe('rent');
  });

  it('没有 perspective ⇒ 不是下钻（普通进详情屏）', () => {
    expect(chainReportPrefillOf({ ...RAW, perspective: undefined })).toBeNull();
  });

  it('🚨 视角值不认得 ⇒ 整个预填作废，🚫 不兜一个默认视角', () => {
    expect(chainReportPrefillOf({ ...RAW, perspective: 'rentt' })).toBeNull();
  });

  it('DTE 只给一端 ⇒ 作废（成对维度，半对不是合法值）', () => {
    expect(chainReportPrefillOf({ ...RAW, dteMax: undefined })).toBeNull();
  });

  it('expo-router 的数组形参取第一个（同名参数重复时不炸）', () => {
    expect(chainReportPrefillOf({ ...RAW, perspective: ['build', 'rent'] })?.tab).toBe('build');
  });

  it('🚨 报表时点为空串 ⇒ 收成 `null`（报表侧 asOf 本就可空，空串会比出一句空日期提示）', () => {
    expect(chainReportPrefillOf({ ...RAW, reportAsOf: '' })?.reportAsOf).toBeNull();
    expect(
      chainReportDrilldownAsOfNotice(
        chainReportPrefillOf({ ...RAW, reportAsOf: '' })?.reportAsOf ?? null,
        '2026-08-12',
      ),
    ).toBeNull();
  });
});

describe('🚨 055 T016 —— 预填表单以**系统默认值**为底（本片最危险的一条）', () => {
  const prefill = chainReportPrefillOf({
    perspective: 'rent',
    dteMin: '45',
    dteMax: '45',
    strikeMin: '120.0000',
    strikeMax: '135.0000',
    reportAsOf: '2026-08-11',
  });

  it('四维按报表那一格覆盖', () => {
    const form = chainReportPrefillForm(DEFAULTS, prefill!);
    expect(form.dteMin).toBe('45');
    expect(form.dteMax).toBe('45');
    expect(form.strikeMin).toBe('120.0000');
    expect(form.strikeMax).toBe('135.0000');
  });

  it('🚨 其余三维**逐字保留默认值** —— 空串在契约里是「覆盖为不限」，会放进报表没数的腿', () => {
    const base = criteriaFormOf(DEFAULTS);
    const form = chainReportPrefillForm(DEFAULTS, prefill!);
    expect(form.premiumMin).toBe(base.premiumMin);
    expect(form.oiMin).toBe(base.oiMin);
    expect(form.volMin).toBe(base.volMin);
    expect(form.relativeSpreadMax).toBe(base.relativeSpreadMax);
    // 那三维**必须**非空，否则这条断言在「默认值本来就空」上恒真、判别力为零。
    expect(base.premiumMin).not.toBe('');
    expect(base.oiMin).not.toBe('');
    expect(base.relativeSpreadMax).not.toBe('');
  });

  it('🚨 顶档的空下界 ⇒ **留默认**而不是覆盖成「不限」（行没有下界 ≠ 视角放弃它的下界）', () => {
    const top = chainReportPrefillOf({
      perspective: 'rent',
      dteMin: '45',
      dteMax: '45',
      strikeMin: '',
      strikeMax: '80.0000',
      reportAsOf: '2026-08-11',
    });
    const form = chainReportPrefillForm(DEFAULTS, top!);
    expect(form.strikeMin).toBe(criteriaFormOf(DEFAULTS).strikeMin);
    expect(form.strikeMax).toBe('80.0000');
  });

  it('默认值还没到手（`null`）⇒ 只填四维，其余留空（那时本就没有默认值可留）', () => {
    const form = chainReportPrefillForm(null, prefill!);
    expect(form.dteMin).toBe('45');
    expect(form.premiumMin).toBe('');
  });
});

describe('055 T016 —— 两侧业务日不一致（FR-039a / SC-010 / state_branch 24）', () => {
  it('🚨 不一致 ⇒ 两个时点**各自可见**', () => {
    const text = chainReportDrilldownAsOfNotice('2026-08-11', '2026-08-12');
    expect(text).not.toBeNull();
    expect(text).toContain('2026-08-11');
    expect(text).toContain('2026-08-12');
  });

  it('同一业务日 ⇒ 不出这句（SC-010 前半：那时条数本就该一致）', () => {
    expect(chainReportDrilldownAsOfNotice('2026-08-11', '2026-08-11')).toBeNull();
  });

  it('任一侧缺时点 ⇒ 不出这句（🚫 不拿「缺」当「不一致」）', () => {
    expect(chainReportDrilldownAsOfNotice(null, '2026-08-12')).toBeNull();
    expect(chainReportDrilldownAsOfNotice('2026-08-11', null)).toBeNull();
  });
});
