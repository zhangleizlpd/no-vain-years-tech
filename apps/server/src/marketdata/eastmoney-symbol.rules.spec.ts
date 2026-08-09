import { describe, it, expect } from 'vitest';
import {
  fromMktNum,
  toSecid,
  toCanonical,
  UnsupportedEastmoneyMarketError,
} from './eastmoney-symbol.rules.js';

/** 东财符号归一化纯函数测 (015 T012, FR-S10)。round-trip 守恒 + 未知市场明确拒绝。 */
describe('eastmoney-symbol.rules', () => {
  describe('fromMktNum (searchapi 响应解析)', () => {
    it.each([
      ['1', '600519', 'cn:600519'], // 上交所
      ['0', '000001', 'cn:000001'], // 深交所
      ['0', '430047', 'cn:430047'], // 北交所走深市号
      ['116', '00700', 'hk:00700'], // 港股
      ['105', 'AAPL', 'us:AAPL'], // 美股 NASDAQ
      [106, 'BABA', 'us:BABA'], // 数值 MktNum 容错
    ] as const)('MktNum %s + %s → %s', (mkt, code, expected) => {
      expect(fromMktNum(mkt, code)).toBe(expected);
    });

    it('未知 MktNum → UnsupportedEastmoneyMarketError', () => {
      expect(() => fromMktNum('90', '999999')).toThrow(UnsupportedEastmoneyMarketError);
    });
  });

  describe('toSecid', () => {
    it.each([
      ['cn:600519', '1.600519'], // 6 开头 → 上交所
      ['cn:000001', '0.000001'], // 深交所
      ['cn:300750', '0.300750'], // 创业板 → 深市号
      ['cn:430047', '0.430047'], // 北交所 → 深市号
      ['hk:00700', '116.00700'],
      ['us:AAPL', '105.AAPL'],
    ] as const)('%s → %s', (canonical, secid) => {
      expect(toSecid(canonical)).toBe(secid);
    });

    it('未知市场前缀 → 抛错', () => {
      expect(() => toSecid('jp:7203')).toThrow(UnsupportedEastmoneyMarketError);
    });

    it('无效 canonical (无冒号/空段) → 抛错', () => {
      expect(() => toSecid('600519')).toThrow(UnsupportedEastmoneyMarketError);
      expect(() => toSecid('cn:')).toThrow(UnsupportedEastmoneyMarketError);
      expect(() => toSecid(':600519')).toThrow(UnsupportedEastmoneyMarketError);
    });
  });

  describe('round-trip 守恒 (canonical 粒度)', () => {
    it.each(['cn:600519', 'cn:000001', 'cn:430047', 'hk:00700', 'us:AAPL'])(
      'toCanonical(toSecid(%s)) === %s',
      (canonical) => {
        expect(toCanonical(toSecid(canonical))).toBe(canonical);
      },
    );
  });

  describe('toCanonical', () => {
    it('1.600519 → cn:600519', () => {
      expect(toCanonical('1.600519')).toBe('cn:600519');
    });
    it('未知市场号 → 抛错', () => {
      expect(() => toCanonical('90.999999')).toThrow(UnsupportedEastmoneyMarketError);
    });
  });
});
