// 047 T032 — 腿行的纯函数单测（logic-only）。
// 横滑与首列钉住是**渲染行为**，走 T035 Playwright e2e —— 本仓测试分层 vitest=logic / Playwright=UI。
//
// 三条机械防线（写错了不会红、但错得很贵）：
//   · 费率列**随行口径切换主数字**，MUST NOT 对周化族的行主显折年（FR-003）
//   · Δ 与 σ 距**同有同无**（Guardrail 10 / plan D-UI-3 —— 同一个 `absDelta` 的两种呈现）
//   · 12 列宽度合计 = 696，首列 88 渲在横向滚动**之外**（天然钉住，不依赖 sticky）
import { describe, expect, it } from 'vitest';
import type { LegResponse } from '@nvy/api-client';

import {
  LEG_SCROLL_REGION_WIDTH,
  LEG_STICKY_COL_WIDTH,
  LEG_TABLE_COLUMNS,
  LEG_TABLE_WIDTH,
  costCell,
  deltaCell,
  expiryLabel,
  formatCount,
  formatRatePct,
  formatTurnover,
  rateCell,
  sigmaCell,
  strikeLabel,
} from './leg-row.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const NO_VALUE = OPTIONSDESK_COPY.legPicker.noValue;

const TODAY = '2026-08-04';

function leg(overrides: Partial<LegResponse> = {}): LegResponse {
  return {
    code: 'PEP260815P133000',
    strike: '133.00',
    expiryDate: '2026-08-08',
    dteDays: 4,
    bid: '1.60',
    ask: '1.70',
    basis: 'weekly',
    periodRate: '0.012169',
    weeklyRate: '0.021296',
    annualizedRate: '1.110000',
    tier: 'good',
    askRate: null,
    effectiveCost: '131.40',
    effectiveCostVsWPct: '9.50',
    absDelta: 0.48,
    sigmaDistance: 0.06,
    openInterest: 455,
    volume: 690,
    turnover: '110000.00',
    activityByTab: { all: null, build: null, rent: null },
    tabs: ['all', 'build'],
    earningsMark: null,
    greeksComplete: true,
    ...overrides,
  };
}

describe('12 列几何 —— 首列渲在横向滚动之外（不依赖 position: sticky）', () => {
  it('恰好 12 列，宽度合计 696', () => {
    expect(LEG_TABLE_COLUMNS).toHaveLength(12);
    expect(LEG_TABLE_COLUMNS.reduce((sum, c) => sum + c.width, 0)).toBe(LEG_TABLE_WIDTH);
    expect(LEG_TABLE_WIDTH).toBe(696);
  });

  it('首列 = 行权价/到期 88px，且它 MUST NOT 出现在横滑列表里', () => {
    expect(LEG_TABLE_COLUMNS[0]?.key).toBe('strike');
    expect(LEG_TABLE_COLUMNS[0]?.width).toBe(LEG_STICKY_COL_WIDTH);
    expect(LEG_STICKY_COL_WIDTH).toBe(88);
    expect(LEG_TABLE_COLUMNS.slice(1).map((c) => c.key)).not.toContain('strike');
  });

  it('右侧横滑区宽 = 总宽 − 首列宽（表头与数据行共用同一个常量）', () => {
    expect(LEG_SCROLL_REGION_WIDTH).toBe(LEG_TABLE_WIDTH - LEG_STICKY_COL_WIDTH);
    expect(LEG_TABLE_COLUMNS.slice(1).reduce((sum, c) => sum + c.width, 0)).toBe(
      LEG_SCROLL_REGION_WIDTH,
    );
  });

  it('列键无重复（12 列各一次）', () => {
    expect(new Set(LEG_TABLE_COLUMNS.map((c) => c.key)).size).toBe(12);
  });
});

describe('🚨 费率列随行口径切换主数字（FR-003）', () => {
  it('收租行（年化族）主显年化，且无折年副标', () => {
    const cell = rateCell(leg({ basis: 'annualized', annualizedRate: '0.176000' }));
    expect(cell.primary).toBe('17.6%');
    expect(cell.secondary).toBeNull();
  });

  it('🚨 建仓行（周化族）主显周化、折年只做小字副标 —— MUST NOT 主显折年', () => {
    const cell = rateCell(leg({ basis: 'weekly', weeklyRate: '0.021296', annualizedRate: '1.11' }));
    expect(cell.primary).toBe('2.13%');
    // 折年 111% 是**参照**，绝不能爬到主数字位（否则屏上的数不是判档用的那个数）。
    expect(cell.primary).not.toContain('111');
    expect(cell.secondary).toBe('年 111%');
  });

  it('greeks 缺失行 → 费率留占位、不显任何数（FR-007）', () => {
    const cell = rateCell(leg({ greeksComplete: false }));
    expect(cell.primary).toBe(NO_VALUE);
    expect(cell.secondary).toBeNull();
  });

  it('该口径的费率缺值 → 占位，不拿另一个口径的数顶上', () => {
    expect(rateCell(leg({ basis: 'weekly', weeklyRate: null })).primary).toBe(NO_VALUE);
    expect(rateCell(leg({ basis: 'annualized', annualizedRate: null })).primary).toBe(NO_VALUE);
  });

  it('周化族折年缺值 → 只掉副标，主数字照常', () => {
    const cell = rateCell(leg({ basis: 'weekly', annualizedRate: null }));
    expect(cell.primary).toBe('2.13%');
    expect(cell.secondary).toBeNull();
  });
});

describe('🚨 Δ 与 σ 距同有同无（Guardrail 10 / plan D-UI-3）', () => {
  it('两者都有 → 各自成串（Δ 显 |Δ| 真值，不是符号）', () => {
    const l = leg({ absDelta: 0.48, sigmaDistance: 0.06 });
    expect(deltaCell(l)).toBe('0.48');
    expect(sigmaCell(l)).toBe('0.06σ');
  });

  it('absDelta 为 null → **两列同时**留占位', () => {
    const l = leg({ absDelta: null, sigmaDistance: null });
    expect(deltaCell(l)).toBe(NO_VALUE);
    expect(sigmaCell(l)).toBe(NO_VALUE);
  });

  it('🚨 契约不该出现的半缺状态也不许一列有一列无', () => {
    // 真值只有一个来源（`absDelta`）⇒ σ 距单独有值时照样按「不全」处置。
    expect(deltaCell(leg({ absDelta: null, sigmaDistance: 0.06 }))).toBe(NO_VALUE);
    expect(sigmaCell(leg({ absDelta: null, sigmaDistance: 0.06 }))).toBe(NO_VALUE);
  });

  it('greeks 缺失行两列同样留占位', () => {
    const l = leg({ greeksComplete: false });
    expect(deltaCell(l)).toBe(NO_VALUE);
    expect(sigmaCell(l)).toBe(NO_VALUE);
  });

  it('σ 距 ≥ 1 收 1 位小数、< 1 收 2 位（窄列可读）', () => {
    expect(sigmaCell(leg({ sigmaDistance: 1.42 }))).toBe('1.4σ');
    expect(sigmaCell(leg({ sigmaDistance: 0.204 }))).toBe('0.20σ');
  });
});

describe('首列 / 成本列 / 计数列的呈现', () => {
  it('行权价带 P（本片只含认沽）', () => {
    expect(strikeLabel(leg({ strike: '133.00' }))).toBe('133 P');
    expect(strikeLabel(leg({ strike: '117.50' }))).toBe('117.5 P');
  });

  it('到期日同年只显 MM-DD·Nd；跨年补两位年份（529d 那种一眼可辨）', () => {
    expect(expiryLabel(leg({ expiryDate: '2026-08-08', dteDays: 4 }), TODAY)).toBe('08-08·4d');
    expect(expiryLabel(leg({ expiryDate: '2027-01-15', dteDays: 529 }), TODAY)).toBe(
      '27-01-15·529d',
    );
  });

  it('成本列：绝对成本 + 相对 W 的**百分数**（与费率的小数比例故意不同量纲）', () => {
    const cell = costCell(leg({ effectiveCost: '131.40', effectiveCostVsWPct: '9.50' }));
    expect(cell.primary).toBe('131.40');
    // 正号显式带出 —— 「贵过 W」与「便宜过 W」在窄列里必须一眼可分。
    expect(cell.secondary).toBe('+9.5%');
    expect(costCell(leg({ effectiveCostVsWPct: '-2.60' })).secondary).toBe('-2.6%');
  });

  it('无 bid ⇒ 有效成本为 null ⇒ 成本列占位（禁拿 K−0 冒充）', () => {
    const cell = costCell(leg({ bid: null, effectiveCost: null, effectiveCostVsWPct: null }));
    expect(cell.primary).toBe(NO_VALUE);
    expect(cell.secondary).toBeNull();
  });

  it('OI / Vol 带千分位；缺值占位（不拿 0 冒充「没有持仓」）', () => {
    expect(formatCount(1865)).toBe('1,865');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(null)).toBe(NO_VALUE);
  });

  it('成交额收 $K / $M', () => {
    expect(formatTurnover('39800')).toBe('$39.8K');
    expect(formatTurnover('110000')).toBe('$110K');
    expect(formatTurnover('200')).toBe('$0.2K');
    expect(formatTurnover('2400000')).toBe('$2.4M');
    expect(formatTurnover(null)).toBe(NO_VALUE);
  });
});

describe('费率百分数的精度随口径走（窄列可读，且不虚增有效位）', () => {
  it('周化族恒两位小数（含末尾 0）', () => {
    expect(formatRatePct('0.019000', 'weekly')).toBe('1.90%');
    expect(formatRatePct('0.004600', 'weekly')).toBe('0.46%');
  });

  it('年化族 < 20% 收一位、≥ 20% 收整数', () => {
    expect(formatRatePct('0.176000', 'annualized')).toBe('17.6%');
    expect(formatRatePct('0.033000', 'annualized')).toBe('3.3%');
    expect(formatRatePct('0.240000', 'annualized')).toBe('24%');
    expect(formatRatePct('1.110000', 'annualized')).toBe('111%');
  });

  it('非数字 / 缺值 → null（调用方据此渲占位，绝不渲 NaN%）', () => {
    expect(formatRatePct(null, 'weekly')).toBeNull();
    expect(formatRatePct('', 'weekly')).toBeNull();
    expect(formatRatePct('abc', 'annualized')).toBeNull();
  });
});
