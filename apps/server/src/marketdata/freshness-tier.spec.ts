import { describe, expect, it } from 'vitest';
import { FRESHNESS_TIERS, freshnessTier } from './freshness-tier.js';

/**
 * FR-020 新鲜度判据纯单测。**判别性用例是「asOf 等于最近已收盘交易日 ⇒ CURRENT」** ——
 * 046 初版拿设备本地日期当基准, 对美股恒不相等 ⇒ 恒 STALE, 这几条就是防它回归的。
 */
describe('freshnessTier', () => {
  it('asOf 缺失 ⇒ UNAVAILABLE (不编造日期)', () => {
    expect(freshnessTier(null, '2026-08-03')).toBe('UNAVAILABLE');
    expect(freshnessTier(null, null)).toBe('UNAVAILABLE');
  });

  it('🚨 asOf 等于最近已收盘交易日 ⇒ CURRENT (境内看美股的正常态)', () => {
    expect(freshnessTier('2026-08-03', '2026-08-03')).toBe('CURRENT');
  });

  it('asOf 落后于最近已收盘交易日 ⇒ STALE (「停在上一交易日」)', () => {
    expect(freshnessTier('2026-07-31', '2026-08-03')).toBe('STALE');
    expect(freshnessTier('2025-12-31', '2026-01-02')).toBe('STALE');
  });

  it('asOf 比上界更新 ⇒ 仍 CURRENT (夜间管线刚落库完最新一场, 不是异常)', () => {
    expect(freshnessTier('2026-08-04', '2026-08-03')).toBe('CURRENT');
  });

  it('🚨 交易日历查不到 ⇒ fail-open CURRENT (宁可漏报, 不重演「全体恒显已过时」)', () => {
    expect(freshnessTier('2026-07-31', null)).toBe('CURRENT');
  });

  it('三档封闭 (加档要同步呈现侧的穷举映射)', () => {
    expect([...FRESHNESS_TIERS]).toEqual(['CURRENT', 'STALE', 'UNAVAILABLE']);
  });
});
