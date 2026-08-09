import { describe, it, expect } from 'vitest';
import {
  MARKET_CATALOG,
  CORE_MARKETS,
  OVERSEAS_MARKETS,
  DEFAULT_CORE_ACTIVE,
  isCoreMarket,
  isKnownMarket,
} from './market-catalog';

// 011 T003: 市场静态字典 (FR-S06 真相源) — 纯常量完整性 + 谓词。
describe('market-catalog (FR-S06 静态字典)', () => {
  it('恰 9 个市场, 核心 3 + 海外 6', () => {
    expect(MARKET_CATALOG).toHaveLength(9);
    expect(CORE_MARKETS).toHaveLength(3);
    expect(OVERSEAS_MARKETS).toHaveLength(6);
  });

  it('核心 3 市场码 = cn/hk/us, 海外含 jp/sg/my/ca/au/kr', () => {
    expect(CORE_MARKETS.map((m) => m.marketCode)).toEqual(['cn', 'hk', 'us']);
    expect(OVERSEAS_MARKETS.map((m) => m.marketCode)).toEqual(['jp', 'sg', 'my', 'ca', 'au', 'kr']);
  });

  it('order 固定 1-9 连续, 核心在前', () => {
    expect(MARKET_CATALOG.map((m) => m.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('marketCode 与 isoCurrency 解耦 (市场码 cn↔币种 CNY, 与 015 Instrument.market 同词表)', () => {
    const byCode = Object.fromEntries(MARKET_CATALOG.map((m) => [m.marketCode, m.isoCurrency]));
    expect(byCode['cn']).toBe('CNY');
    expect(byCode['hk']).toBe('HKD');
    expect(byCode['us']).toBe('USD');
    // 市场码恒小写, 币种码恒大写 ISO 4217 → 全表二者不相等
    for (const m of MARKET_CATALOG) {
      expect(m.marketCode).not.toBe(m.isoCurrency);
    }
  });

  it('核心恒 v1Available=true, 海外恒 v1Available=false', () => {
    expect(CORE_MARKETS.every((m) => m.v1Available === true)).toBe(true);
    expect(OVERSEAS_MARKETS.every((m) => m.v1Available === false)).toBe(true);
  });

  it('displayName 对齐 mockup 定稿名称', () => {
    const byCode = Object.fromEntries(MARKET_CATALOG.map((m) => [m.marketCode, m.displayName]));
    expect(byCode['cn']).toBe('A 股');
    expect(byCode['hk']).toBe('港股');
    expect(byCode['us']).toBe('美股');
    expect(byCode['jp']).toBe('日股');
    expect(byCode['kr']).toBe('韩股');
  });

  it('DEFAULT_CORE_ACTIVE = A 股 ON, 港股/美股 OFF (FR-S01 新用户默认)', () => {
    expect(DEFAULT_CORE_ACTIVE).toEqual({ cn: true, hk: false, us: false });
  });

  describe('isCoreMarket', () => {
    it('核心码 → true', () => {
      expect(['cn', 'hk', 'us'].every(isCoreMarket)).toBe(true);
    });
    it('海外码 / 未知码 → false', () => {
      expect(isCoreMarket('jp')).toBe(false);
      expect(isCoreMarket('XXX')).toBe(false);
    });
  });

  describe('isKnownMarket', () => {
    it('核心 + 海外 9 码 → true', () => {
      expect(MARKET_CATALOG.every((m) => isKnownMarket(m.marketCode))).toBe(true);
    });
    it('未知码 → false', () => {
      expect(isKnownMarket('XXX')).toBe(false);
      expect(isKnownMarket('')).toBe(false);
    });
  });
});
