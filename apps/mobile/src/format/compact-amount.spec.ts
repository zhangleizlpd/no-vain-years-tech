// 083 T012 — 金额「万」缩写（FR-022）与详情页全精度金额的纯逻辑单测。
//
// 📌 阈值按**原值**判档，不按四舍五入后的值 —— `99999999` 仍在「万」档，显示 `10000.00万`
//    而不是进位到 `1.00亿`（tasks 臂 ④ 定死的期望值）。
import { describe, expect, it } from 'vitest';

import { formatCompactAmount, formatFullAmount } from './compact-amount';

describe('formatCompactAmount — 三档（FR-022）', () => {
  it('① |n| < 1万 ⇒ 千分位 2 位小数', () => {
    expect(formatCompactAmount('9999.99')).toBe('9,999.99');
  });

  it('② 恰为 1万 ⇒ 进入「万」档', () => {
    expect(formatCompactAmount('10000')).toBe('1.00万');
  });

  it('③ 负数保号', () => {
    expect(formatCompactAmount('-10000')).toBe('-1.00万');
  });

  it('④ 99999999 按原值判档 ⇒ 仍在「万」档（不因四舍五入升档）', () => {
    expect(formatCompactAmount('99999999')).toBe('10000.00万');
  });

  it('⑤ 恰为 1亿 ⇒ 进入「亿」档', () => {
    expect(formatCompactAmount('100000000')).toBe('1.00亿');
  });

  it('⑥ signed ⇒ 正数带 +，负数照常', () => {
    expect(formatCompactAmount('600', { signed: true })).toBe('+600.00');
    expect(formatCompactAmount('37560', { signed: true })).toBe('+3.76万');
    expect(formatCompactAmount('-600', { signed: true })).toBe('-600.00');
  });

  it('⑦ null / 非法 / 空串 ⇒ --', () => {
    expect(formatCompactAmount(null)).toBe('--');
    expect(formatCompactAmount('abc')).toBe('--');
    expect(formatCompactAmount('')).toBe('--');
  });

  it('舍入后为零 ⇒ 不带 + / -（不显示 -0.00）', () => {
    expect(formatCompactAmount('-0.001')).toBe('0.00');
    expect(formatCompactAmount('0', { signed: true })).toBe('0.00');
  });
});

describe('formatFullAmount — 全精度千分位（详情页）', () => {
  it('⑧ 37560 ⇒ 37,560.00', () => {
    expect(formatFullAmount('37560')).toBe('37,560.00');
  });

  it('不缩写、负数保号、signed 带 +', () => {
    expect(formatFullAmount('-123456789.5')).toBe('-123,456,789.50');
    expect(formatFullAmount('1234.5', { signed: true })).toBe('+1,234.50');
  });

  it('null / 非法 ⇒ --', () => {
    expect(formatFullAmount(null)).toBe('--');
    expect(formatFullAmount('N/A')).toBe('--');
  });
});
