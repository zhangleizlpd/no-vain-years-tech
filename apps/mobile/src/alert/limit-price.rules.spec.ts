import { describe, expect, it } from 'vitest';
import type { QuoteItem } from '@nvy/api-client';

import { limitPct, limitPrices, prevCloseOf } from './limit-price.rules';

const q = (over: Partial<QuoteItem>): QuoteItem => ({
  symbol: 'cn:603305',
  name: '旭升集团',
  price: '14.91',
  change: '0.24',
  changePct: '1.64',
  asOf: '2026-06-05',
  priceKind: 'eod_close',
  hasData: true,
  ...over,
});

describe('limitPct — 板块判定（clarify #2，边角不准接受）', () => {
  it('主板（其余代码段）→ ±10%', () => {
    expect(limitPct('600519', '贵州茅台')).toBe(10);
    expect(limitPct('000001', '平安银行')).toBe(10);
    expect(limitPct('002230', '科大讯飞')).toBe(10);
  });

  it('科创 688/689 与创业 300/301 → ±20%', () => {
    expect(limitPct('688981', null)).toBe(20);
    expect(limitPct('689009', null)).toBe(20);
    expect(limitPct('300750', null)).toBe(20);
    expect(limitPct('301236', null)).toBe(20);
  });

  it('北交 920/8x/4x → ±30%（920 = 2025 起京市新段）', () => {
    expect(limitPct('920375', null)).toBe(30);
    expect(limitPct('832000', null)).toBe(30);
    expect(limitPct('871981', null)).toBe(30);
    expect(limitPct('430047', '诺思格')).toBe(30);
  });

  it('名称含 ST → ±5%（优先于板块段；*ST 同样命中）', () => {
    expect(limitPct('600000', 'ST摩登')).toBe(5);
    expect(limitPct('000564', '*ST大集')).toBe(5);
    expect(limitPct('300100', 'ST双林')).toBe(5); // 字面规则覆盖创业段（边角不准接受）
  });

  it('name 缺失 / 不含 ST → 按代码段', () => {
    expect(limitPct('600519', null)).toBe(10);
    expect(limitPct('600519', undefined)).toBe(10);
    expect(limitPct('603305', '旭升集团')).toBe(10);
  });
});

describe('limitPrices — round(prevClose×(1±pct), 2)', () => {
  it('主板：旭升集团 prevClose 14.67 → 涨停 16.14 / 跌停 13.20（mockup 锚定值）', () => {
    expect(limitPrices(14.67, '603305', '旭升集团')).toEqual({ up: '16.14', down: '13.20' });
  });

  it('四舍五入半进位：prevClose 30.15 → 33.165 进 33.17（不随 mockup stub 截断）', () => {
    expect(limitPrices(30.15, '603383', '顶点软件')).toEqual({ up: '33.17', down: '27.14' });
  });

  it('ST ±5%：prevClose 10 → 10.50 / 9.50', () => {
    expect(limitPrices(10, '600000', 'ST摩登')).toEqual({ up: '10.50', down: '9.50' });
  });

  it('北交 ±30%：prevClose 25.24 → 32.81 / 17.67', () => {
    expect(limitPrices(25.24, '430047', '诺思格')).toEqual({ up: '32.81', down: '17.67' });
  });

  it('prevClose 缺失 / 非正 → 双 null（渲染层 "--"）', () => {
    expect(limitPrices(null, '600519', null)).toEqual({ up: null, down: null });
    expect(limitPrices(0, '600519', null)).toEqual({ up: null, down: null });
    expect(limitPrices(-1, '600519', null)).toEqual({ up: null, down: null });
  });
});

describe('prevCloseOf — 由 015 报价 price − change 推导昨收', () => {
  it('正常推导：14.91 − 0.24 → 14.67', () => {
    expect(prevCloseOf(q({}))).toBe(14.67);
  });

  it('浮点噪声清理：46.03 − 0.19 → 45.84（非 45.839999…）', () => {
    expect(prevCloseOf(q({ price: '46.03', change: '0.19' }))).toBe(45.84);
  });

  it('quote 缺位 / 无数据 / 字段 null → null', () => {
    expect(prevCloseOf(undefined)).toBeNull();
    expect(prevCloseOf(q({ hasData: false }))).toBeNull();
    expect(prevCloseOf(q({ price: null }))).toBeNull();
    expect(prevCloseOf(q({ change: null }))).toBeNull();
  });

  it('推导出非正昨收（退市残值等退化形态）→ null', () => {
    expect(prevCloseOf(q({ price: '10.00', change: '12.00' }))).toBeNull();
  });
});
