import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { LEG_TIERS, TIER_FLOORS_BY_BASIS, classifyLegTier, tierBands } from './leg-tier.rules';

// 全部费率入参一律**小数比例**量纲 (0.15 = 15%), 与 anchor.rules.ts 的 POSITION_CAP_BY_L_LEVEL 同口径。
// 六个边界真值 (plan D-SOT-1): 年化 15 / 10 / 5%, 周化 2 / 1 / 0.6%。

describe('leg-tier.rules — 六个边界真值只住一处 (FR-022, plan D-SOT-1)', () => {
  // 📌 用式(‰ / 小数)而非百分式写周化死线是**蓄意的**: `check-optionsdesk-rule-constants.ts`
  // 只剥注释不剥字符串字面量, 用例名里写百分式会撞上区间系数扫描 (Guardrail 13)。
  it('年化三道界 = 15 / 10 / 5%, 周化三道界 = 2% / 1% / 6‰ (即 0.006)', () => {
    expect(TIER_FLOORS_BY_BASIS.annualized.map((b) => b.floor.toString())).toEqual([
      '0.15',
      '0.1',
      '0.05',
    ]);
    expect(TIER_FLOORS_BY_BASIS.weekly.map((b) => b.floor.toString())).toEqual([
      '0.02',
      '0.01',
      '0.006',
    ]);
  });

  it('两个口径各三道界降序声明 —— 首个命中即归属, 故边界值有且只有一档', () => {
    for (const basis of ['annualized', 'weekly'] as const) {
      const floors = TIER_FLOORS_BY_BASIS[basis];
      expect(floors.map((b) => b.tier)).toEqual(['good', 'acceptable', 'thin']);
      for (let i = 1; i < floors.length; i += 1) {
        expect(floors[i].floor.lessThan(floors[i - 1].floor)).toBe(true);
      }
    }
  });

  it('图例文案从同一常量派生 —— 四档带首尾相接, 最高档无上界 / 最低档无下界', () => {
    const bands = tierBands('annualized');
    expect(bands.map((b) => b.tier)).toEqual(['good', 'acceptable', 'thin', 'dead']);
    expect(bands[0].ceiling).toBeNull();
    expect(bands[3].floor).toBeNull();
    expect(bands[0].floor?.toString()).toBe('0.15');
    expect(bands[1].ceiling?.toString()).toBe('0.15');
    expect(bands[1].floor?.toString()).toBe('0.1');
    expect(bands[2].ceiling?.toString()).toBe('0.1');
    expect(bands[2].floor?.toString()).toBe('0.05');
    expect(bands[3].ceiling?.toString()).toBe('0.05');
    expect(tierBands('weekly')[3].ceiling?.toString()).toBe('0.006');
  });
});

describe('leg-tier.rules — 年化口径四档 (FR-018, 收租腿)', () => {
  const tierOf = (rate: string) => classifyLegTier(rate, 'annualized', null).tier;

  it('四档各有一个代表点', () => {
    expect(tierOf('0.176')).toBe('good');
    expect(tierOf('0.12')).toBe('acceptable');
    expect(tierOf('0.072')).toBe('thin');
    expect(tierOf('0.031')).toBe('dead');
  });

  it('三道界一律「下界闭上界开」—— 界值归上侧档, 无重叠无空洞', () => {
    expect(tierOf('0.15')).toBe('good');
    expect(tierOf('0.149999')).toBe('acceptable');
    expect(tierOf('0.1')).toBe('acceptable');
    expect(tierOf('0.099999')).toBe('thin');
    expect(tierOf('0.05')).toBe('thin');
    expect(tierOf('0.049999')).toBe('dead');
  });
});

describe('leg-tier.rules — 周化口径四档 (FR-018, 建仓腿)', () => {
  const tierOf = (rate: string) => classifyLegTier(rate, 'weekly', null).tier;

  it('四档各有一个代表点', () => {
    expect(tierOf('0.0213')).toBe('good');
    expect(tierOf('0.014')).toBe('acceptable');
    expect(tierOf('0.007')).toBe('thin');
    expect(tierOf('0.004')).toBe('dead');
  });

  it('三道界一律「下界闭上界开」—— 界值归上侧档, 无重叠无空洞', () => {
    expect(tierOf('0.02')).toBe('good');
    expect(tierOf('0.019999')).toBe('acceptable');
    expect(tierOf('0.01')).toBe('acceptable');
    expect(tierOf('0.009999')).toBe('thin');
    expect(tierOf('0.006')).toBe('thin');
    expect(tierOf('0.005999')).toBe('dead');
  });

  it('两个口径的同一个数值判出不同档 —— 口径必须显式传, 不存在默认口径', () => {
    expect(classifyLegTier('0.03', 'weekly', null).tier).toBe('good');
    expect(classifyLegTier('0.03', 'annualized', null).tier).toBe('dead');
  });
});

describe('leg-tier.rules — 判定值恒为 bid (plan D-SOT-1 / D-SOT-2)', () => {
  it('薄档带出该行 ask 口径值供呈现 (形如 7.2% (ask 11.4%))', () => {
    const verdict = classifyLegTier('0.072', 'annualized', '0.114');
    expect(verdict.tier).toBe('thin');
    expect(verdict.askRate?.toString()).toBe('0.114');
  });

  it('薄档但该行无 ask (缺报价) → 档位照判, 带出值为 null', () => {
    expect(classifyLegTier('0.072', 'annualized', null)).toEqual({
      tier: 'thin',
      askRate: null,
    });
  });

  it('薄档以外三档恒不带出 ask —— 带出值只服务尴尬区二分', () => {
    for (const rate of ['0.176', '0.12', '0.031']) {
      expect(classifyLegTier(rate, 'annualized', '0.99').askRate).toBeNull();
    }
  });

  it('🚨 ask MUST NOT 参与判档 —— 同一 bid 配任何 ask, 档位不动', () => {
    for (const ask of ['0.001', '0.114', '0.99', null]) {
      expect(classifyLegTier('0.072', 'annualized', ask).tier).toBe('thin');
    }
    // ask 高到能进「好」档也不改判 —— 死档就是死档。
    expect(classifyLegTier('0.031', 'annualized', '0.5').tier).toBe('dead');
  });

  it('string 与 Decimal 两种入参等价', () => {
    expect(classifyLegTier(new Prisma.Decimal('0.072'), 'annualized', null).tier).toBe('thin');
    expect(
      classifyLegTier('0.072', 'annualized', new Prisma.Decimal('0.114')).askRate?.toString(),
    ).toBe('0.114');
  });
});

describe('leg-tier.rules — 死线是操作门槛, 与利率环境无关 (plan D-SOT-1)', () => {
  it('函数只吃三个入参 (bid 费率 / 口径 / ask 费率) —— 没有利率环境这一维', () => {
    // 机械判据: 加一个 T-bill / 无风险利率入参必然改变 arity, 这条即红。
    expect(classifyLegTier.length).toBe(3);
    expect(tierBands.length).toBe(1);
  });

  it('边界常量是死值不是函数 —— 无从随环境浮动', () => {
    expect(typeof TIER_FLOORS_BY_BASIS).toBe('object');
    for (const basis of ['annualized', 'weekly'] as const) {
      for (const { floor } of TIER_FLOORS_BY_BASIS[basis]) {
        expect(Prisma.Decimal.isDecimal(floor)).toBe(true);
      }
    }
  });
});

describe('leg-tier.rules — 边界外与退化输入', () => {
  it('零费率 / 负费率 → 死档, 不抛', () => {
    expect(() => classifyLegTier('0', 'annualized', null)).not.toThrow();
    expect(classifyLegTier('0', 'annualized', null).tier).toBe('dead');
    expect(classifyLegTier('-0.01', 'weekly', null).tier).toBe('dead');
  });

  it('四档枚举无重复, 判定结果恒落在枚举内', () => {
    expect(new Set(LEG_TIERS).size).toBe(LEG_TIERS.length);
    for (const rate of ['0.5', '0.15', '0.1', '0.05', '0']) {
      expect(LEG_TIERS).toContain(classifyLegTier(rate, 'annualized', null).tier);
    }
  });
});
