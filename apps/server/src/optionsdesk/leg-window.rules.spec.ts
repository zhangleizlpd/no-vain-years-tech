import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  BUILD_RECALL_DTE,
  RECALL_CANDIDATE_CAP,
  RENT_RECALL_DTE,
  recallCandidates,
  type RecallCandidate,
  type RecallLegInput,
} from './leg-recall.rules';
import {
  WINDOW_SUPPORTED_MARKETS,
  legWindowFor,
  windowTripwire,
  type LegWindow,
} from './leg-window.rules';

const SPOT = new Prisma.Decimal('100');

/** 一条裸腿 —— 默认全过 `all` 视角的系统默认判据 (bid 高于权利金门槛、有成交)。 */
function leg(over: Partial<RecallLegInput> = {}): RecallLegInput {
  return {
    dteDays: 30,
    strike: new Prisma.Decimal('100'),
    bid: new Prisma.Decimal('1.5'),
    ask: new Prisma.Decimal('1.7'),
    openInterest: 10,
    volume: 5,
    ...over,
  };
}

/**
 * 召回判决 —— 🚨 **蓄意走真的召回层入口**: 成员判定单点在 `leg-recall.rules.ts`, 绊线读的必须
 * 是那一处的判决。测试里手搓一份「能过判据」的集合就等于把这条纪律在验收面上放掉。
 */
function recalled(legs: readonly RecallLegInput[]): readonly RecallCandidate<RecallLegInput>[] {
  return recallCandidates({ spot: SPOT }, ['all'], legs, RECALL_CANDIDATE_CAP).candidates;
}

/** 手搓判决 —— 只用于窗边界闭区间那条 (与判据无关, 不需要跑召回)。 */
function asCandidate(leg: RecallLegInput): RecallCandidate<RecallLegInput> {
  return { leg, tabs: ['all'] };
}

describe('legWindowFor —— 窗由召回常量派生 (FR-005 / FR-006 / FR-008)', () => {
  it('DTE 段 = 两个召回段的并 (禁手写第二份边界数)', () => {
    const window = legWindowFor('us', SPOT);
    expect(window.dteMin).toBe(Math.min(BUILD_RECALL_DTE.min, RENT_RECALL_DTE.min));
    expect(window.dteMax).toBe(Math.max(BUILD_RECALL_DTE.max, RENT_RECALL_DTE.max));
    // 并集 ⇒ 两段各自整段都被覆盖 (取交 / 取其一都会在这里红)。
    expect(window.dteMin).toBeLessThanOrEqual(BUILD_RECALL_DTE.min);
    expect(window.dteMin).toBeLessThanOrEqual(RENT_RECALL_DTE.min);
    expect(window.dteMax).toBeGreaterThanOrEqual(BUILD_RECALL_DTE.max);
    expect(window.dteMax).toBeGreaterThanOrEqual(RENT_RECALL_DTE.max);
  });

  it('🚨 改动 RENT_RECALL_DTE.max 后窗随之变 —— 硬编码上界会在这里红', async () => {
    vi.resetModules();
    vi.doMock('./leg-recall.rules', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./leg-recall.rules')>();
      return { ...actual, RENT_RECALL_DTE: { min: actual.RENT_RECALL_DTE.min, max: 999 } };
    });
    try {
      const remocked = await import('./leg-window.rules.js');
      expect(remocked.legWindowFor('us', SPOT).dteMax).toBe(999);
    } finally {
      vi.doUnmock('./leg-recall.rules');
      vi.resetModules();
    }
  });

  it('类型 PUT + 只要标准合约 (047 FR-008)', () => {
    const window = legWindowFor('us', SPOT);
    expect(window.optionType).toBe('PUT');
    expect(window.isStandard).toBe(true);
  });

  it('strike 上下界随 spot 缩放 (盘中基准喂进来就跟着动)', () => {
    const low = legWindowFor('us', new Prisma.Decimal('100'));
    const high = legWindowFor('us', new Prisma.Decimal('200'));
    expect(high.strikeMin.equals(low.strikeMin.times(2))).toBe(true);
    expect(high.strikeMax.equals(low.strikeMax.times(2))).toBe(true);
    expect(low.strikeMin.lessThan(SPOT)).toBe(true);
    expect(low.strikeMax.greaterThan(SPOT)).toBe(true);
  });

  it('🚨 非已支持市场 → throw 且消息列出已支持市场 (静默返空会让 hk 悄悄拿到 us 的窗)', () => {
    expect(() => legWindowFor('hk', SPOT)).toThrow(/hk/);
    expect(() => legWindowFor('hk', SPOT)).toThrow(new RegExp(WINDOW_SUPPORTED_MARKETS.join('|')));
    expect(() => legWindowFor('', SPOT)).toThrow();
  });
});

describe('windowTripwire —— 包络漂移的绊线 (FR-007)', () => {
  const window: LegWindow = legWindowFor('us', SPOT);

  it('🚨 被窗排除、却能过召回判据的腿 MUST 被报出 (strike 落在下界之下、权利金高于门槛)', () => {
    const offender = leg({ strike: new Prisma.Decimal('60'), bid: new Prisma.Decimal('1.5') });
    const candidates = recalled([offender]);
    expect(candidates).toHaveLength(1); // 探针: 它确实过了召回判据, 否则本用例是平凡绿
    expect(windowTripwire(candidates, window).map((c) => c.leg)).toEqual([offender]);
  });

  it('🚨 DTE 越过窗上界、却能过召回判据的腿同样被报出', () => {
    const offender = leg({ dteDays: window.dteMax + 1 });
    const candidates = recalled([offender]);
    expect(candidates).toHaveLength(1);
    expect(windowTripwire(candidates, window).map((c) => c.leg)).toEqual([offender]);
  });

  it('🚨 反例: 窗内且能过判据的腿不报 (否则绊线恒响 = 等于没有)', () => {
    const legs = [leg(), leg({ strike: new Prisma.Decimal('80') }), leg({ dteDays: 1 })];
    const candidates = recalled(legs);
    expect(candidates).toHaveLength(legs.length);
    expect(windowTripwire(candidates, window)).toEqual([]);
  });

  it('反例: 被窗排除但判据也不过的腿进不了候选 ⇒ 结构上报不出来 (窗与判据同向 = 无漂移)', () => {
    const dead = leg({
      strike: new Prisma.Decimal('60'),
      bid: new Prisma.Decimal('0.01'),
      openInterest: 0,
      volume: 0,
    });
    const candidates = recalled([dead]);
    expect(candidates).toEqual([]);
    expect(windowTripwire(candidates, window)).toEqual([]);
  });

  it('混合: 只报「过判据 ∧ 窗外」那一批', () => {
    const inside = leg();
    const outside = leg({ strike: new Prisma.Decimal('60') });
    const dead = leg({ strike: new Prisma.Decimal('60'), bid: null, openInterest: 0, volume: 0 });
    const tripped = windowTripwire(recalled([inside, outside, dead]), window);
    expect(tripped.map((c) => c.leg)).toEqual([outside]);
  });

  it('窗边界闭区间: 恰在上下界上的腿算窗内', () => {
    const candidates = [
      asCandidate(leg({ strike: window.strikeMin })),
      asCandidate(leg({ strike: window.strikeMax })),
      asCandidate(leg({ dteDays: window.dteMin })),
      asCandidate(leg({ dteDays: window.dteMax })),
    ];
    expect(windowTripwire(candidates, window)).toEqual([]);
  });
});
