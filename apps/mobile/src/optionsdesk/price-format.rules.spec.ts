import { describe, expect, it } from 'vitest';

import { PRICE_DISPLAY_DECIMALS, formatPriceText } from './price-format.rules';

describe('formatPriceText', () => {
  it('Decimal(18,4) 序列化串收到 2 位（这是本次改动的靶心）', () => {
    expect(formatPriceText('42.4000')).toBe('42.40');
    expect(formatPriceText('38.0400')).toBe('38.04');
    expect(formatPriceText('175.7200')).toBe('175.72');
    expect(formatPriceText('53.0000')).toBe('53.00');
  });

  it('位数不足的补零（口径是「恒 2 位」不是「最多 2 位」）', () => {
    expect(formatPriceText('9.1')).toBe('9.10');
    expect(formatPriceText('26')).toBe('26.00');
  });

  it('舍入到分；🚨 **正好半分**那一档的方向不保证（float64 表示决定，非稳定四舍五入）', () => {
    expect(formatPriceText('23.0549')).toBe('23.05');
    expect(formatPriceText('23.0551')).toBe('23.06');
    // 半分实测：'23.0550' → 23.05（往下）、'0.1250' → 0.13（往上）—— 方向不一致。
    // **刻意不修**：① 偏差恒 ≤ 0.01 且只在显示层，落库与派生一律走原值；
    // ② 修它要引 decimal 库或自写半进位，而仓内既有 `portfolio/use-quote-merge.formatPrice`
    //    也是裸 `toFixed(2)` —— 另立一套舍入反而制造口径分叉，正是本次改动要消除的东西。
    expect(formatPriceText('23.0550')).toBe('23.05');
    expect(formatPriceText('0.1250')).toBe('0.13');
  });

  it('number 入参同样成立（区间图的 ZoneBounds 是 number 不是串）', () => {
    expect(formatPriceText(140)).toBe('140.00');
    expect(formatPriceText(63.98)).toBe('63.98');
  });

  it('🚨 非数值原样回退 —— MUST NOT 兜成 0.00（兜 0 = 编造一个价格）', () => {
    expect(formatPriceText('--')).toBe('--');
    expect(formatPriceText('')).toBe('');
    expect(formatPriceText('N/A')).toBe('N/A');
    // 调用方各自已在上游拦缺数（formatSpot 的「行情不可用」/ parseZoneBounds 的 null），
    // 故这里只保证「不编造」，不承担缺数语义。
    expect(formatPriceText('--')).not.toBe('0.00');
  });

  it('小数位是具名常量，改口径只改一处', () => {
    expect(PRICE_DISPLAY_DECIMALS).toBe(2);
    expect(formatPriceText('1.23456').split('.')[1]).toHaveLength(PRICE_DISPLAY_DECIMALS);
  });
});
