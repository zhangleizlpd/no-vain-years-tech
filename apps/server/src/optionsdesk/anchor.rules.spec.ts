import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  ANCHOR_ZONES,
  L_LEVELS,
  POSITION_CAP_BY_L_LEVEL,
  WILLING_SELL_COEFFICIENTS,
  ZONE_CEILING_COEFFICIENT,
  classifyZone,
  computeDistanceToWPct,
  computeW,
  computeWillingSellAnchors,
  computeZoneBoundaries,
  countByLLevel,
  derivePositionCap,
  isBelowW,
  mapConfidenceToLLevel,
} from './anchor.rules';

// 全部用例取 V = 50 —— 四道界恰好落在整数 (30 / 40 / 50 / 60), 断言值不含任何档位系数字面量
// (SC-005 要求 anchor.rules.ts 以外的文件都不出现档位数值, 本文件同受该约束; 机械断言见文末注)。
const V = '50';
const V_FLOOR = '30';
const V_W = '40';
const V_CEILING = '60';

describe('anchor.rules — W 与四区间边界 (FR-003)', () => {
  it('W = V × W 系数; string 与 Decimal 两种入参等价', () => {
    expect(computeW(V).toString()).toBe(V_W);
    expect(computeW(new Prisma.Decimal(V)).toString()).toBe(V_W);
  });

  it('四道界严格递增, 切出五段', () => {
    const b = computeZoneBoundaries(V);
    expect([
      b.floor.toString(),
      b.w.toString(),
      b.fairValue.toString(),
      b.ceiling.toString(),
    ]).toEqual([V_FLOOR, V_W, V, V_CEILING]);
    expect(b.floor.lessThan(b.w)).toBe(true);
    expect(b.w.lessThan(b.fairValue)).toBe(true);
    expect(b.fairValue.lessThan(b.ceiling)).toBe(true);
  });

  it('五段各有一个代表点, 归属互斥且覆盖全轴', () => {
    expect(classifyZone(V, '29.9999')).toBe('deep_buy');
    expect(classifyZone(V, '35')).toBe('buy');
    expect(classifyZone(V, '45')).toBe('thin');
    expect(classifyZone(V, '55')).toBe('expensive');
    expect(classifyZone(V, '999')).toBe('overvalued');
    expect(new Set(ANCHOR_ZONES).size).toBe(ANCHOR_ZONES.length);
  });

  it('四道界一律「下界闭上界开」—— 界值归上侧段, 无重叠无空洞', () => {
    expect(classifyZone(V, V_FLOOR)).toBe('buy');
    expect(classifyZone(V, '29.9999')).toBe('deep_buy');
    expect(classifyZone(V, V_W)).toBe('thin');
    expect(classifyZone(V, '39.9999')).toBe('buy');
    expect(classifyZone(V, V)).toBe('expensive');
    expect(classifyZone(V, '49.9999')).toBe('thin');
    expect(classifyZone(V, V_CEILING)).toBe('overvalued');
    expect(classifyZone(V, '59.9999')).toBe('expensive');
  });

  // EC-11: spot 恰好 = W → 区间归属与复核锚触发边界取同一侧, 结果可单测复现。
  it('EC-11 spot 恰好 = W: 区间归上侧段, 复核锚判据同侧 (不触发)', () => {
    expect(classifyZone(V, V_W)).toBe('thin');
    expect(isBelowW(V, V_W)).toBe(false);

    // 一分钱之下 → 两处同时翻到下侧。
    expect(classifyZone(V, '39.99')).toBe('buy');
    expect(isBelowW(V, '39.99')).toBe(true);
  });
});

describe('anchor.rules — confidence → L 层映射 (FR-003, EC-4)', () => {
  it('EC-4 档界恰好命中时归属唯一 (下界闭): 高档界 → L1 / 中档界 → L2 / 低档界 → L3', () => {
    expect(mapConfidenceToLLevel('9')).toBe('L1');
    expect(mapConfidenceToLLevel('7')).toBe('L2');
    expect(mapConfidenceToLLevel('3')).toBe('L3');
  });

  it('档界之下一档 (Decimal 非整值也吃得下, confidence 是 Decimal(4,2))', () => {
    expect(mapConfidenceToLLevel('8.99')).toBe('L2');
    expect(mapConfidenceToLLevel('8.5')).toBe('L2');
    expect(mapConfidenceToLLevel('6.99')).toBe('L3');
    expect(mapConfidenceToLLevel('2.99')).toBe('L4');
  });

  it('全值域每个点恰好落一档 (不会两档都亮 / 都不亮)', () => {
    for (let tenth = 0; tenth <= 100; tenth += 1) {
      const confidence = new Prisma.Decimal(tenth).div(10);
      const hits = L_LEVELS.filter((l) => mapConfidenceToLLevel(confidence) === l);
      expect(hits).toHaveLength(1);
    }
    // 越界值不抛 (模型脏值防御): 满分之上归最高档, 负值归最低档。
    expect(mapConfidenceToLLevel('99')).toBe('L1');
    expect(mapConfidenceToLLevel('-5')).toBe('L4');
  });
});

describe('anchor.rules — L 层 → 单票上限 (FR-003 两级链第二级)', () => {
  it('L1 / L2 / L3 各有档值, 量纲为小数比例 (< 1) 与 position_cap_manual 一致', () => {
    expect(derivePositionCap('L1')?.toString()).toBe('0.25');
    expect(derivePositionCap('L2')?.toString()).toBe('0.05');
    expect(derivePositionCap('L3')?.toString()).toBe('0.02');
    for (const lLevel of ['L1', 'L2', 'L3'] as const) {
      expect(derivePositionCap(lLevel)?.lessThan(1)).toBe(true);
    }
  });

  it('L4 无策略 SoT 口径 → null (FR-030 禁自造参数, 不得填 0)', () => {
    expect(derivePositionCap('L4')).toBeNull();
    expect(POSITION_CAP_BY_L_LEVEL.L4).toBeNull();
  });

  it('档表覆盖全部四层 (筛选项不因某档无口径而缺 key)', () => {
    expect(Object.keys(POSITION_CAP_BY_L_LEVEL).sort()).toEqual([...L_LEVELS].sort());
  });
});

describe('anchor.rules — 愿卖锚两系数独立 (FR-003)', () => {
  it('默认两档各按自己的系数算; 收租档当前等于 V 是取值巧合', () => {
    const anchors = computeWillingSellAnchors(V);
    expect(anchors.longHold.toString()).toBe(V_CEILING);
    expect(anchors.rent.toString()).toBe(V);
    // 巧合而非定义: 两系数是两个独立配置项, 不是同一个。
    expect(WILLING_SELL_COEFFICIENTS.longHold.equals(WILLING_SELL_COEFFICIENTS.rent)).toBe(false);
  });

  it('改长持系数 MUST NOT 影响收租档', () => {
    const anchors = computeWillingSellAnchors(V, {
      longHold: new Prisma.Decimal('2'),
      rent: WILLING_SELL_COEFFICIENTS.rent,
    });
    expect(anchors.longHold.toString()).toBe('100');
    expect(anchors.rent.toString()).toBe(V);
  });

  it('改收租系数 MUST NOT 影响长持档 (禁把收租写死为「等于 V」)', () => {
    const anchors = computeWillingSellAnchors(V, {
      longHold: WILLING_SELL_COEFFICIENTS.longHold,
      rent: new Prisma.Decimal('2'),
    });
    expect(anchors.rent.toString()).toBe('100');
    expect(anchors.longHold.toString()).toBe(V_CEILING);
  });

  it('长持系数与区间上界系数是两个常量 (现值相等亦不共用)', () => {
    expect(WILLING_SELL_COEFFICIENTS.longHold).not.toBe(ZONE_CEILING_COEFFICIENT);
  });
});

describe('anchor.rules — 距 W% (FR-010 排序键)', () => {
  it('W 上方为正 / 下方为负 / 恰好为零, 量级是百分数不是比值', () => {
    expect(computeDistanceToWPct(V, '44')?.toString()).toBe('10');
    expect(computeDistanceToWPct(V, '36')?.toString()).toBe('-10');
    expect(computeDistanceToWPct(V, V_W)?.toString()).toBe('0');
  });

  it('lastClose 缺失 (行情未覆盖) → null, 不伪造 0', () => {
    expect(computeDistanceToWPct(V, null)).toBeNull();
  });

  it('升序排出的顺序 = 离 W 最近的在前 (负值最深的排最前)', () => {
    const sorted = ['44', '36', V_W]
      .map((c) => computeDistanceToWPct(V, c) as Prisma.Decimal)
      .sort((a, b) => a.comparedTo(b))
      .map((d) => d.toString());
    expect(sorted).toEqual(['-10', '0', '10']);
  });
});

describe('anchor.rules — EC-3 V ≤ 0 拒绝', () => {
  const invalid = ['0', '-1'];

  it('全部 V 依赖派生一律抛 INVALID_ANCHOR_V', () => {
    for (const v of invalid) {
      expect(() => computeW(v)).toThrow(/INVALID_ANCHOR_V/);
      expect(() => computeZoneBoundaries(v)).toThrow(/INVALID_ANCHOR_V/);
      expect(() => classifyZone(v, '1')).toThrow(/INVALID_ANCHOR_V/);
      expect(() => isBelowW(v, '1')).toThrow(/INVALID_ANCHOR_V/);
      expect(() => computeWillingSellAnchors(v)).toThrow(/INVALID_ANCHOR_V/);
      expect(() => computeDistanceToWPct(v, '1')).toThrow(/INVALID_ANCHOR_V/);
    }
  });

  it('极小正 V 仍可派生 (拒的是 ≤ 0, 不是「太小」)', () => {
    expect(() => computeZoneBoundaries('0.01')).not.toThrow();
  });
});

describe('anchor.rules — FR-008 空档位不是校验错误', () => {
  it('空集 → 四档全 0, 不抛', () => {
    expect(() => countByLLevel([])).not.toThrow();
    expect(countByLLevel([])).toEqual({ L1: 0, L2: 0, L3: 0, L4: 0 });
  });

  it('某档 (一期是最高档) 无锚落入 → 该档计 0 且 key 仍在, 不抛不特判', () => {
    // 7 只种子锚的 confidence 均在最高档之下 —— 估值管道现状, 非异常。
    const seeded = ['8', '7.5', '6', '5', '4', '3.5', '3'].map(mapConfidenceToLLevel);
    expect(() => countByLLevel(seeded)).not.toThrow();
    const counts = countByLLevel(seeded);
    expect(counts.L1).toBe(0);
    expect(counts.L2 + counts.L3 + counts.L4).toBe(seeded.length);
  });
});

// SC-005「档位数值只许出现在 anchor.rules.ts」的机械断言**不在本文件** ——
// 它是扫源码的治理检查（要读磁盘），按测试分类学归 `scripts/checks/`：
//   scripts/checks/check-optionsdesk-rule-constants.ts（PR 门 gate-checks job 全扫）
