import { describe, it, expect } from 'vitest';
import {
  toLixinger,
  toCanonical,
  UnsupportedLixingerMarketError,
} from './lixinger-symbol.rules.js';

describe('lixinger-symbol.rules (015 T006, FR-S10)', () => {
  describe('toLixinger', () => {
    it('cn 6 位代码 → {market:cn, stockCode}', () => {
      expect(toLixinger('cn:600519')).toEqual({ market: 'cn', stockCode: '600519' });
    });

    it('hk 代码 → {market:hk, stockCode}', () => {
      expect(toLixinger('hk:00700')).toEqual({ market: 'hk', stockCode: '00700' });
    });

    it.each(['us:AAPL', 'sz:000001', 'foo:1', ':600519', 'cn:', 'no-colon'])(
      '未知/畸形前缀 "%s" → 明确抛 UnsupportedLixingerMarketError',
      (input) => {
        expect(() => toLixinger(input)).toThrow(UnsupportedLixingerMarketError);
      },
    );
  });

  describe('round-trip (双向无损)', () => {
    it.each(['cn:600519', 'cn:000001', 'cn:430047', 'hk:00700'])(
      'toCanonical(toLixinger(%s)) === 原值',
      (canonical) => {
        expect(toCanonical(toLixinger(canonical))).toBe(canonical);
      },
    );
  });
});
