// 047 T032 — 腿行的纯函数单测（logic-only）。
// 横滑与首列钉住是**渲染行为**，走 T035 Playwright e2e —— 本仓测试分层 vitest=logic / Playwright=UI。
//
// 三条机械防线（写错了不会红、但错得很贵）：
//   · 费率列**随行口径切换主数字**，MUST NOT 对周化族的行主显折年（FR-003）
//   · Δ 恒读 `absDelta`（053 FR-034 删了 σ 距列后它是该量的唯一呈现）
//   · 12 列宽度合计 = 716，首列 88 渲在横向滚动**之外**（天然钉住，不依赖 sticky）
import { describe, expect, it } from 'vitest';
import type { LegResponse } from '@nvy/api-client';

import {
  LEG_SCROLL_REGION_WIDTH,
  LEG_STICKY_COL_WIDTH,
  LEG_TABLE_COLUMNS,
  LEG_TABLE_WIDTH,
  type LegColumnKey,
  costCell,
  deltaCell,
  expiryLabel,
  formatContractPremium,
  formatCount,
  formatRatePct,
  formatRelativeSpread,
  rateCell,
  strikeLabel,
} from './leg-row.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const NO_VALUE = OPTIONSDESK_COPY.legPicker.noValue;
const COLUMN_LABEL = OPTIONSDESK_COPY.legPicker.columns;

const TODAY = '2026-08-04';

function leg(overrides: Partial<LegResponse> = {}): LegResponse {
  return {
    code: 'PEP260815P133000',
    strike: '133.00',
    expiryDate: '2026-08-08',
    dteDays: 4,
    bid: '1.60',
    ask: '1.70',
    // 053 契约增量（T004）：两者**服务端算**，客户端零处再乘一次合约乘数。
    contractPremium: '160.00',
    relativeSpread: '0.060606',
    bidSize: 25,
    askSize: 26,
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
    // 053 契约收窄：一次请求只作答一个视角 ⇒ 档位与活跃标都是**本次视角**的标量
    //（`tierByTab` / `activityByTab` / 每腿 `tabs` 三者同批退役）。
    activity: null,
    isRecommended: false,
    isMonthlyChain: false,
    earningsMark: null,
    greeksComplete: true,
    ...overrides,
  };
}

describe('12 列几何 —— 首列渲在横向滚动之外（不依赖 position: sticky）', () => {
  it('🚨 宽度合计恒 716、首列恒 88（SC-018 —— 改任一列宽都必须在这里红）', () => {
    // 049 的横滑范式把**内容总宽当作位移钳制的输入** ⇒ 总宽一变，指示条长度比与 maxTx
    // 全跟着变，而真机上表现为「右侧滑不到底」且**不会红**（web 视口看不出来）。
    expect(LEG_TABLE_COLUMNS.reduce((sum, c) => sum + c.width, 0)).toBe(716);
    expect(LEG_TABLE_WIDTH).toBe(716);
    expect(LEG_STICKY_COL_WIDTH).toBe(88);
  });

  it('🚨 列序逐项对上 FR-030（一次横滑凑齐 bid/ask → 费率 → 权利金 的判据集）', () => {
    expect(LEG_TABLE_COLUMNS.map((c) => c.key)).toEqual([
      'strike',
      'bid',
      'rate',
      'premium',
      'oi',
      'spread',
      'cost',
      'delta',
      'vol',
      'activity',
      'mark',
      'action',
    ]);
  });

  it('恰好 12 列，宽度合计 716', () => {
    expect(LEG_TABLE_COLUMNS).toHaveLength(12);
    expect(LEG_TABLE_COLUMNS.reduce((sum, c) => sum + c.width, 0)).toBe(LEG_TABLE_WIDTH);
    expect(LEG_TABLE_WIDTH).toBe(716);
  });

  it('🚨 σ 距与成交额已退场（FR-034 —— 新增两列的预算由删列吸收，不靠缩字号硬塞）', () => {
    const keys = LEG_TABLE_COLUMNS.map((c) => c.key as string);
    expect(keys).not.toContain('sigma');
    expect(keys).not.toContain('turnover');
    // 删的 46 + 52 与新增的 50 + 48 恰好对冲 ⇒ 总宽不动（上一条已断言）。
    expect(LEG_TABLE_COLUMNS.find((c) => c.key === 'premium')?.width).toBe(50);
    expect(LEG_TABLE_COLUMNS.find((c) => c.key === 'spread')?.width).toBe(48);
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

describe('🚨 Δ 列恒读 absDelta（053 FR-034 删 σ 距列后它是该量的唯一呈现）', () => {
  it('有值 → 显 |Δ| 真值（不是符号）', () => {
    expect(deltaCell(leg({ absDelta: 0.48 }))).toBe('0.48');
  });

  it('absDelta 为 null → 留占位', () => {
    expect(deltaCell(leg({ absDelta: null }))).toBe(NO_VALUE);
  });

  it('🚨 契约仍下发 sigmaDistance，但它单独有值也顶不上 Δ —— 判据只有 absDelta 一个', () => {
    expect(deltaCell(leg({ absDelta: null, sigmaDistance: 0.06 }))).toBe(NO_VALUE);
  });

  it('greeks 缺失行留占位', () => {
    expect(deltaCell(leg({ greeksComplete: false }))).toBe(NO_VALUE);
  });
});

describe('🚨 新增两列的呈现（FR-032 —— 两个数都由服务端算，客户端零计算）', () => {
  it('单笔权利金取 contractPremium 原样收整数 + 千分位（🚫 MUST NOT 由 bid 乘一次合约乘数）', () => {
    // 深实值腿 bid 12.90 ⇒ 服务端下发 1290.00 ⇒ 四位数要在 50px 列里装得下。
    expect(formatContractPremium('1290.00')).toBe('1,290');
    expect(formatContractPremium('160.00')).toBe('160');
    expect(formatContractPremium('38.00')).toBe('38');
  });

  it('无 bid ⇒ 权利金为 null ⇒ 占位（禁拿 0 冒充「白挂一张不收钱」）', () => {
    expect(formatContractPremium(null)).toBe(NO_VALUE);
    expect(formatContractPremium('')).toBe(NO_VALUE);
  });

  it('相对价差是小数比例 → 百分数；48px 列内 < 100% 收 1 位、≥ 100% 收整数', () => {
    expect(formatRelativeSpread('0.060606')).toBe('6.1%');
    expect(formatRelativeSpread('0.311000')).toBe('31.1%');
    // 双边报价极窄 / 深度虚值腿会把它顶到三位数 ——「45.2%」已占满 48px，再多一位必须降精度。
    expect(formatRelativeSpread('1.400000')).toBe('140%');
  });

  it('任一侧缺报价 / mid ≤ 0 ⇒ 服务端给 null ⇒ 占位', () => {
    expect(formatRelativeSpread(null)).toBe(NO_VALUE);
    expect(formatRelativeSpread('abc')).toBe(NO_VALUE);
  });
});

// ═══════ SC-019 表头零折行 —— logic-only 近似；真机最宽真实内容复核归 T013 ═══════

/**
 * 单元格左右内边距合计 —— 三个单元格组件（`NumCell` / `TagCell` / `TextCell`）与
 * `HeaderCell` 一律 `px-1.5` ⇒ 6 × 2。
 */
const CELL_PADDING_X = 12;
/** 表头字号（`leg-table-header.tsx` 的 `text-[10px]`，默认 sans）。 */
const HEADER_FONT_SIZE = 10;
/**
 * 非 CJK 字符在**默认 sans** 下的宽度系数。0.68 不是拍的 —— 它是拿 mockup 两次实测反解的：
 * `成本vsW`（2 CJK + 3 拉丁）在 11px 表头的 56px 列里**折行**（⇒ 2 + 3f > 44/11 ⇒ f > 0.667），
 * 10px 时不折。取 0.68 能同时复现这两次观测，且对本断言是**保守上界**。
 */
const SANS_EM = 0.68;
/** 等宽字体（数据格 `font-mono`）的字符宽 —— 源码注释钉的 ≈6.6px @ 11px。 */
const MONO_EM = 0.6;

/** 估算一段文本的渲染宽度：CJK / 全角恒 1em，其余取给定系数。复杂度 O(n)。 */
function estimateWidth(text: string, fontSize: number, nonCjkEm: number): number {
  let em = 0;
  for (const ch of text) {
    em += /[\u2E80-\u9FFF\uFF00-\uFF60]/u.test(ch) ? 1 : nonCjkEm;
  }
  return em * fontSize;
}

/** 列内可用宽（扣掉左右内边距）。 */
function contentWidth(key: LegColumnKey): number {
  const column = LEG_TABLE_COLUMNS.find((c) => c.key === key);
  if (column === undefined) throw new Error(`未知列：${key}`);
  return column.width - CELL_PADDING_X;
}

describe('🚨 SC-019 表头与最宽真实内容在各自列宽内零折行', () => {
  it('12 个列头主标各自装得下（折行在 web 视口看不出来、真机才炸）', () => {
    // 收成一个「装不下的列头」清单再断言 —— 逐条 expect 会在第一个越界处停，看不到还有几列也超。
    const overflowing = LEG_TABLE_COLUMNS.filter(
      (column) =>
        estimateWidth(COLUMN_LABEL[column.key], HEADER_FONT_SIZE, SANS_EM) >
        contentWidth(column.key),
    ).map((column) => `${COLUMN_LABEL[column.key]}(${column.width}px)`);
    expect(overflowing).toEqual([]);
  });

  it('费率列头随口径换字（周化 / 年化 / 降级标题）也都装得下', () => {
    const copy = OPTIONSDESK_COPY.legPicker;
    for (const label of [copy.rateBasisWeekly, copy.rateBasisAnnualized, copy.columns.rate]) {
      expect(estimateWidth(label, HEADER_FONT_SIZE, SANS_EM)).toBeLessThanOrEqual(
        contentWidth('rate'),
      );
    }
  });

  it('三处最宽真实内容：成本vsW 表头 / 深实值两位数价格 / 权利金四位数', () => {
    // ① `成本vsW` 是唯一一个「宽度由字号倒推」的列头 —— 11px 会折，10px 才不折。
    expect(estimateWidth(COLUMN_LABEL.cost, HEADER_FONT_SIZE, SANS_EM)).toBeLessThanOrEqual(
      contentWidth('cost'),
    );
    expect(estimateWidth(COLUMN_LABEL.cost, 11, SANS_EM)).toBeGreaterThan(contentWidth('cost'));

    // ② bid/ask 格内是两个定宽 `w-9`(36) 子列 + `gap-1`(4)，深实值腿价格 `12.90` 走 11px 等宽。
    const QUOTE_SIDE_WIDTH = 36;
    expect(QUOTE_SIDE_WIDTH * 2 + 4).toBeLessThanOrEqual(contentWidth('bid'));
    expect(estimateWidth('12.90', 11, MONO_EM)).toBeLessThanOrEqual(QUOTE_SIDE_WIDTH);

    // ③ 权利金四位数（深实值腿 bid 12.90 × 100）。
    expect(estimateWidth('1,290', 11, MONO_EM)).toBeLessThanOrEqual(contentWidth('premium'));
    // 相对价差的最宽形态（两位数 + 1 位小数）同样在 48px 内。
    expect(estimateWidth('45.2%', 11, MONO_EM)).toBeLessThanOrEqual(contentWidth('spread'));
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
