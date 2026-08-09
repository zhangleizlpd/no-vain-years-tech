import { describe, expect, it } from 'vitest';
import { ANCHOR_ZONES, L_LEVELS, type AnchorZone, type LLevel } from './anchor.rules';
import {
  POSITION_BUCKETS,
  RENT_DEPTHS,
  classifyIntent,
  isPositionBucket,
  type IntentVerdict,
  type PositionBucket,
} from './intent-matrix.rules';

// ─────────────────────────────────────────────────────────────────────────────
// 策略 SoT 第四章那张 3×3 表 (plan D-SOT-3) —— **逐格作为期望值**。
// 行 = L 层 · 列 = 区间 · 每格三元组 = 三个水位档 (<1/3 · 1/3–2/3 · ≥2/3)。
// impl 是公式 (m = d − (l − 1)), 本表是它必须复现的真值; 公式对不上表即红。
// ─────────────────────────────────────────────────────────────────────────────

type Cell = Readonly<IntentVerdict>;

const BUILD: Cell = { intent: 'build_position', rentDepth: null };
const NEAR: Cell = { intent: 'rent', rentDepth: 'near_atm' };
const MID: Cell = { intent: 'rent', rentDepth: 'moderate' };
const DEEP: Cell = { intent: 'rent', rentDepth: 'deep' };

type ZoneColumn = 'sellPut' | 'buy' | 'deepBuy';
type Row = Readonly<Record<ZoneColumn, readonly [Cell, Cell, Cell]>>;

const SOT_MATRIX: Readonly<Record<'L1' | 'L2' | 'L3', Row>> = {
  L1: {
    sellPut: [NEAR, MID, DEEP],
    buy: [BUILD, NEAR, MID],
    deepBuy: [BUILD, BUILD, NEAR],
  },
  L2: {
    sellPut: [MID, DEEP, DEEP],
    buy: [NEAR, MID, DEEP],
    deepBuy: [BUILD, NEAR, MID],
  },
  L3: {
    sellPut: [DEEP, DEEP, DEEP],
    buy: [MID, DEEP, DEEP],
    deepBuy: [NEAR, MID, DEEP],
  },
};

/** 卖put区在 045 五段里由两段构成 —— 两者 MUST 输出相同 (plan D-SOT-3 区间映射表)。 */
const ZONES_BY_COLUMN: Readonly<Record<ZoneColumn, readonly AnchorZone[]>> = {
  sellPut: ['thin', 'expensive'],
  buy: ['buy'],
  deepBuy: ['deep_buy'],
};

const MATRIX_L_LEVELS = ['L1', 'L2', 'L3'] as const;
const COLUMNS = ['sellPut', 'buy', 'deepBuy'] as const;

describe('intent-matrix.rules — SoT 第四章 3×3 表逐格复现 (FR-016, plan D-SOT-3)', () => {
  for (const lLevel of MATRIX_L_LEVELS) {
    for (const column of COLUMNS) {
      it(`${lLevel} × ${column} × 三个水位档`, () => {
        for (const zone of ZONES_BY_COLUMN[column]) {
          const actual = POSITION_BUCKETS.map((bucket) => classifyIntent(zone, lLevel, bucket));
          expect(actual).toEqual([...SOT_MATRIX[lLevel][column]]);
        }
      });
    }
  }

  it('两个 SoT 锚点格与 plan 逐字对齐', () => {
    // 「L1 深买区 → 建仓 <2/3」: 前两个水位档建仓, ≥2/3 转收租。
    expect(classifyIntent('deep_buy', 'L1', 'lt_one_third').intent).toBe('build_position');
    expect(classifyIntent('deep_buy', 'L1', 'one_to_two_thirds').intent).toBe('build_position');
    expect(classifyIntent('deep_buy', 'L1', 'gte_two_thirds')).toEqual(NEAR);
    // 「L3 买区 → ≥2/3 深度地板」。
    expect(classifyIntent('buy', 'L3', 'gte_two_thirds')).toEqual(DEEP);
  });

  it('卖put区两段 (薄带 / 偏贵) 输出完全相同 —— 同属一个 SoT 区间', () => {
    for (const lLevel of MATRIX_L_LEVELS) {
      for (const bucket of POSITION_BUCKETS) {
        expect(classifyIntent('thin', lLevel, bucket)).toEqual(
          classifyIntent('expensive', lLevel, bucket),
        );
      }
    }
  });
});

describe('intent-matrix.rules — 落的是生成公式, 不是九宫格查表 (plan D-SOT-3)', () => {
  it('折扣富余 m 相同的格必然同输出 —— 查表实现挡不住这条', () => {
    // m = d − (l − 1): 下面每组的两 / 三格 m 相同, 故三个水位档的输出必须逐格相等。
    const sameM: readonly (readonly [AnchorZone, LLevel])[][] = [
      // m = 1
      [
        ['buy', 'L1'],
        ['deep_buy', 'L2'],
      ],
      // m = 0
      [
        ['thin', 'L1'],
        ['buy', 'L2'],
        ['deep_buy', 'L3'],
      ],
      // m = −1
      [
        ['thin', 'L2'],
        ['buy', 'L3'],
      ],
    ];
    for (const group of sameM) {
      const rendered = group.map((pair) =>
        POSITION_BUCKETS.map((bucket) => classifyIntent(pair[0], pair[1], bucket)),
      );
      for (const row of rendered) expect(row).toEqual(rendered[0]);
    }
  });

  it('收租段内每跨一个水位档深度加一档, 深度为地板 (不存在第四档)', () => {
    for (const lLevel of MATRIX_L_LEVELS) {
      for (const zone of ANCHOR_ZONES) {
        if (zone === 'overvalued') continue;
        const depths = POSITION_BUCKETS.map((bucket) => classifyIntent(zone, lLevel, bucket))
          .filter((v) => v.intent === 'rent')
          .map((v) => RENT_DEPTHS.indexOf(v.rentDepth as (typeof RENT_DEPTHS)[number]));
        for (let i = 1; i < depths.length; i += 1) {
          expect(depths[i] - depths[i - 1]).toBeGreaterThanOrEqual(0);
          expect(depths[i] - depths[i - 1]).toBeLessThanOrEqual(1);
        }
        for (const d of depths) expect(d).toBeLessThanOrEqual(RENT_DEPTHS.length - 1);
      }
    }
  });

  it('L3 一格都不走建仓网格 (腰斩触发本片不实现, 建仓格恒判收租)', () => {
    for (const zone of ANCHOR_ZONES) {
      for (const bucket of POSITION_BUCKETS) {
        expect(classifyIntent(zone, 'L3', bucket).intent).not.toBe('build_position');
      }
    }
  });
});

describe('intent-matrix.rules — 不开新仓 ⟺ 不动区 或 L4 (FR-021, plan D-SOT-3)', () => {
  it('不动区 → 恒不开新仓, 与 L 层 / 水位档无关 (含未选水位)', () => {
    for (const lLevel of L_LEVELS) {
      for (const bucket of [...POSITION_BUCKETS, null]) {
        expect(classifyIntent('overvalued', lLevel, bucket)).toEqual({
          intent: 'no_new_position',
          rentDepth: null,
        });
      }
    }
  });

  it('L4 → 恒不开新仓, 与区间 / 水位档无关 (只观察、零动作)', () => {
    for (const zone of ANCHOR_ZONES) {
      for (const bucket of [...POSITION_BUCKETS, null]) {
        expect(classifyIntent(zone, 'L4', bucket)).toEqual({
          intent: 'no_new_position',
          rentDepth: null,
        });
      }
    }
  });

  it('反向: 非不动区且非 L4 → 永不判「不开新仓」', () => {
    for (const zone of ANCHOR_ZONES) {
      if (zone === 'overvalued') continue;
      for (const lLevel of MATRIX_L_LEVELS) {
        for (const bucket of [...POSITION_BUCKETS, null]) {
          expect(classifyIntent(zone, lLevel, bucket).intent).not.toBe('no_new_position');
        }
      }
    }
  });
});

describe('intent-matrix.rules — 水位未选是常驻分支 (FR-017)', () => {
  it('水位 null → 「待定」, MUST NOT 落任何档位', () => {
    for (const zone of ANCHOR_ZONES) {
      if (zone === 'overvalued') continue;
      for (const lLevel of MATRIX_L_LEVELS) {
        expect(classifyIntent(zone, lLevel, null)).toEqual({
          intent: 'pending',
          rentDepth: null,
        });
      }
    }
  });

  it('「待定」不是某一档的别名 —— 它与三个水位档的输出都不同', () => {
    const pending = classifyIntent('buy', 'L1', null);
    for (const bucket of POSITION_BUCKETS) {
      expect(classifyIntent('buy', 'L1', bucket)).not.toEqual(pending);
    }
  });
});

describe('intent-matrix.rules — 水位值域 (T002 落库口径)', () => {
  it('三个字面量与锚表列的值域逐字一致, 顺序 = 水位由低到高', () => {
    expect([...POSITION_BUCKETS]).toEqual(['lt_one_third', 'one_to_two_thirds', 'gte_two_thirds']);
  });

  it('类型守卫认三个字面量, 拒其余 (含空串 / null / 越界值)', () => {
    for (const bucket of POSITION_BUCKETS) expect(isPositionBucket(bucket)).toBe(true);
    for (const raw of ['', 'half', 'LT_ONE_THIRD', null]) {
      expect(isPositionBucket(raw)).toBe(false);
    }
  });

  it('枚举无重复, 判定结果恒落在枚举内', () => {
    expect(new Set(POSITION_BUCKETS).size).toBe(POSITION_BUCKETS.length);
    expect(new Set(RENT_DEPTHS).size).toBe(RENT_DEPTHS.length);
    const buckets: readonly (PositionBucket | null)[] = [...POSITION_BUCKETS, null];
    for (const zone of ANCHOR_ZONES) {
      for (const lLevel of L_LEVELS) {
        for (const bucket of buckets) {
          const verdict = classifyIntent(zone, lLevel, bucket);
          if (verdict.rentDepth !== null) expect(RENT_DEPTHS).toContain(verdict.rentDepth);
        }
      }
    }
  });
});
