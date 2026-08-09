import { describe, it, expect } from 'vitest';
import { BROKER_CATALOG, isKnownBroker, brokerNameOf } from './broker-catalog';

// 012 T003: 券商静态字典 server 校验副本 (code+name only; pinyin/logo 是 client-only D5)。
describe('broker-catalog', () => {
  it('BROKER_CATALOG = 12 券商, 每条 brokerCode + brokerName 非空, code 无重复', () => {
    expect(BROKER_CATALOG).toHaveLength(12);
    const codes = BROKER_CATALOG.map((b) => b.brokerCode);
    expect(new Set(codes).size).toBe(12); // 无重复
    for (const b of BROKER_CATALOG) {
      expect(b.brokerCode.length).toBeGreaterThan(0);
      expect(b.brokerName.length).toBeGreaterThan(0);
    }
  });

  it('code 集合对齐 mockup baseline (12 家)', () => {
    expect(BROKER_CATALOG.map((b) => b.brokerCode).sort()).toEqual(
      [
        'dfcf',
        'gfzq',
        'gtja',
        'gxzq',
        'htai',
        'htzq',
        'pazq',
        'swhy',
        'yhzq',
        'zjgs',
        'zszq',
        'zxzq',
      ].sort(),
    );
  });

  describe('isKnownBroker', () => {
    it('字典内 code → true', () => {
      expect(isKnownBroker('htai')).toBe(true);
      expect(isKnownBroker('zxzq')).toBe(true);
    });
    it('字典外 / 空 code → false', () => {
      expect(isKnownBroker('nope')).toBe(false);
      expect(isKnownBroker('')).toBe(false);
    });
  });

  describe('brokerNameOf', () => {
    it('已知 code → 中文名', () => {
      expect(brokerNameOf('htai')).toBe('华泰证券');
      expect(brokerNameOf('dfcf')).toBe('东方财富');
    });
    it('未知 code → null', () => {
      expect(brokerNameOf('nope')).toBeNull();
    });
  });
});
