import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  CONTINUOUS_FEATURE_KEYS,
  FEATURE_VALUE_WHEN_MISSING,
  FEATURE_VALUE_WHEN_UNIFORM,
  ORDINAL_FEATURE_KEYS,
  RANKING_FEATURE_KEYS,
  computeRankingFeatures,
  rankLegs,
  rateDescendingRanker,
  type LegIdentity,
  type LegRanker,
  type RankingContext,
  type RankingFeatureKey,
  type RankingFeatures,
  type RankingLegInput,
} from './leg-rank.rules';

/**
 * 050 T010 —— 特征集与归一化 (FR-019 / FR-019a, SC-003a, plan D-RANK-1)。
 *
 * 🚨 **本文件的头号判别性用例是「`min === max` 产 `0.5` 且不是 NaN」** (Guardrail 2):
 * 光断言取值落 `[0,1]` **抓不到** NaN —— NaN 与任何数比较恒 `false`, 于是
 * `v >= 0 && v <= 1` 为 `false`... 但如果反过来写成 `expect(v).not.toBeGreaterThan(1)` 之类
 * 的否定式区间断言, NaN 会「通过」。⇒ 每条区间断言都配一条显式的 `Number.isNaN(v) === false`。
 */

const D = (v: string) => new Prisma.Decimal(v);
const CONTEXT: RankingContext = { spot: D('100') };

/** 一条各项齐全的基准腿 —— 各用例只覆写自己关心的那几项。 */
function legOf(overrides: Partial<RankingLegInput> = {}): RankingLegInput {
  return {
    rate: D('0.02'),
    effectiveCost: D('95'),
    relativeSpread: D('0.05'),
    openInterest: 100,
    volume: 10,
    turnover: D('1000'),
    absDelta: 0.45,
    dteDays: 30,
    isMonthlyChain: false,
    isRoundStrike: false,
    isDeltaInIntentBand: false,
    crossesEarnings: false,
    isTopRanked: false,
    ...overrides,
  };
}

describe('leg-rank.rules — 特征集 13 项 (FR-019)', () => {
  it('13 项齐全且逐字点名 —— 连续 8 + 布尔/序数 5, 少一项就红', () => {
    expect(CONTINUOUS_FEATURE_KEYS).toEqual([
      'rate',
      'effectiveCostDiscount',
      'relativeSpread',
      'openInterest',
      'volume',
      'turnover',
      'absDelta',
      'dteDays',
    ]);
    expect(ORDINAL_FEATURE_KEYS).toEqual([
      'isMonthlyChain',
      'isRoundStrike',
      'isDeltaInIntentBand',
      'crossesEarnings',
      'isTopRanked',
    ]);
    expect(RANKING_FEATURE_KEYS).toHaveLength(13);

    const [features] = computeRankingFeatures(CONTEXT, [legOf()]);
    // 产出面与键表同源 —— 多一个 / 少一个字段都在这里红。
    expect(Object.keys(features).sort()).toEqual([...RANKING_FEATURE_KEYS].sort());
  });

  it('归一化后是 number 不是 Prisma.Decimal (沿 leg-derive 的量纲纪律: 统计量用 number)', () => {
    const [features] = computeRankingFeatures(CONTEXT, [legOf()]);
    for (const key of RANKING_FEATURE_KEYS) {
      expect(typeof features[key]).toBe('number');
    }
  });

  it('空候选集 → 空数组 (不炸、不造行)', () => {
    expect(computeRankingFeatures(CONTEXT, [])).toEqual([]);
  });
});

describe('leg-rank.rules — min-max 归一化基准 = 该候选集内 (FR-019a)', () => {
  it('常规三条: 最小 → 0, 中间 → 按位置, 最大 → 1', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ openInterest: 100 }),
      legOf({ openInterest: 200 }),
      legOf({ openInterest: 300 }),
    ]);
    expect(features.map((f) => f.openInterest)).toEqual([0, 0.5, 1]);
  });

  it('基准是**候选集内**的相对量 —— 同一条腿换一个候选集取值就变 (⇒ 不可跨请求比较)', () => {
    const alone = computeRankingFeatures(CONTEXT, [legOf({ volume: 10 })]);
    const withPeers = computeRankingFeatures(CONTEXT, [
      legOf({ volume: 10 }),
      legOf({ volume: 20 }),
    ]);
    expect(alone[0].volume).toBe(FEATURE_VALUE_WHEN_UNIFORM);
    expect(withPeers[0].volume).toBe(0);
  });

  it('有效成本折价用 context.spot 作分母, 折价越大取值越高', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ effectiveCost: D('100') }), // 折价 0
      legOf({ effectiveCost: D('95') }), // 折价 5%
      legOf({ effectiveCost: D('90') }), // 折价 10%
    ]);
    expect(features[0].effectiveCostDiscount).toBe(0);
    expect(features[1].effectiveCostDiscount).toBeCloseTo(0.5, 10);
    expect(features[2].effectiveCostDiscount).toBe(1);
  });

  it('🚫 归一化**不翻转方向** —— 相对价差越宽取值越高, 方向语义归将来的加权器', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ relativeSpread: D('0.02') }),
      legOf({ relativeSpread: D('0.50') }),
    ]);
    // 若这里被「顺手」改成「越窄越高」, 本片唯一的 ranker 读不到它 ⇒ 不会红。写死方向在此。
    expect(features[0].relativeSpread).toBe(0);
    expect(features[1].relativeSpread).toBe(1);
  });
});

describe('leg-rank.rules — 三条边界处置 (FR-019a, Guardrail 2)', () => {
  it('🚨 该项在候选集内**全等** → 恒 0.5, 且**显式断言不是 NaN** (除零必须先判)', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ openInterest: 500 }),
      legOf({ openInterest: 500 }),
      legOf({ openInterest: 500 }),
    ]);
    for (const f of features) {
      expect(f.openInterest).toBe(FEATURE_VALUE_WHEN_UNIFORM);
      // 🚨 这一行是本文件的核心: `(v−min)/(max−min)` = `0/0` = NaN, 而 NaN 与任何数比较恒
      // `false` ⇒ 否定式区间断言会「通过」。NaN 进 sort 顺序变 V8 实现相关**且不抛任何错**。
      expect(Number.isNaN(f.openInterest)).toBe(false);
    }
  });

  it('🚨 候选集**只有 1 条**腿 → 8 项连续量全取 0.5, 无一 NaN', () => {
    const [features] = computeRankingFeatures(CONTEXT, [legOf()]);
    for (const key of CONTINUOUS_FEATURE_KEYS) {
      expect([key, features[key]]).toEqual([key, FEATURE_VALUE_WHEN_UNIFORM]);
      expect(Number.isNaN(features[key])).toBe(false);
    }
  });

  it('原始量缺失 → 取 0 (与 047 活跃度「缺失排末位」同口径), 且不污染同项其余腿的基准', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ openInterest: null, volume: null, turnover: null, absDelta: null, rate: null }),
      legOf({ openInterest: 200 }),
      legOf({ openInterest: 300 }),
    ]);
    expect(features[0].openInterest).toBe(FEATURE_VALUE_WHEN_MISSING);
    expect(features[0].rate).toBe(FEATURE_VALUE_WHEN_MISSING);
    expect(features[0].absDelta).toBe(FEATURE_VALUE_WHEN_MISSING);
    // 基准由**有值的那两条**定 (200 / 300), 缺失那条没被当成 0 拉低下界。
    expect(features[1].openInterest).toBe(0);
    expect(features[2].openInterest).toBe(1);
  });

  it('无 bid ⇒ 有效成本缺失 → 折价取 0 (🚫 MUST NOT 拿 `K − 0` 冒充折价为负)', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ effectiveCost: null }),
      legOf({ effectiveCost: D('90') }),
      legOf({ effectiveCost: D('95') }),
    ]);
    expect(features[0].effectiveCostDiscount).toBe(FEATURE_VALUE_WHEN_MISSING);
    expect(features[1].effectiveCostDiscount).toBe(1);
  });

  it('某项**全部**缺失 → 全取 0 而不是 NaN (没有基准也要给得出数)', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ turnover: null }),
      legOf({ turnover: null }),
    ]);
    for (const f of features) {
      expect(f.turnover).toBe(FEATURE_VALUE_WHEN_MISSING);
      expect(Number.isNaN(f.turnover)).toBe(false);
    }
  });

  it('🚨 布尔量取 0 / 1 且**不参与 min-max** —— 全 true 时仍是 1, 不是 0.5', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ isMonthlyChain: true, isRoundStrike: true, isTopRanked: true }),
      legOf({ isMonthlyChain: true, isRoundStrike: true, isTopRanked: true }),
    ]);
    // 若布尔量被顺手塞进同一条归一化管道, 这三项会全变 0.5 —— 那会让「是月度链」在下游
    // 与「不是」不可区分, 而取值仍落 [0,1] ⇒ SC-003a 那条断言照样绿。
    for (const f of features) {
      expect([f.isMonthlyChain, f.isRoundStrike, f.isTopRanked]).toEqual([1, 1, 1]);
    }
    const mixed = computeRankingFeatures(CONTEXT, [
      legOf({ isDeltaInIntentBand: true, crossesEarnings: false }),
      legOf({ isDeltaInIntentBand: false, crossesEarnings: true }),
    ]);
    expect(mixed.map((f) => f.isDeltaInIntentBand)).toEqual([1, 0]);
    expect(mixed.map((f) => f.crossesEarnings)).toEqual([0, 1]);
  });
});

describe('leg-rank.rules — SC-003a 全量核对: 13 项恒落 [0,1]', () => {
  const CASES: Record<string, RankingLegInput[]> = {
    单条候选集: [legOf()],
    某项全等: [legOf({ dteDays: 30 }), legOf({ dteDays: 30 })],
    大面积缺失: [
      legOf({
        rate: null,
        effectiveCost: null,
        relativeSpread: null,
        openInterest: null,
        volume: null,
        turnover: null,
        absDelta: null,
      }),
      legOf({ openInterest: 900, isMonthlyChain: true }),
    ],
    正常混合: [
      legOf({ rate: D('0.01'), openInterest: 10, dteDays: 7 }),
      legOf({ rate: D('0.05'), openInterest: 900, dteDays: 45, isTopRanked: true }),
      legOf({ rate: D('0.03'), openInterest: 200, dteDays: 21 }),
    ],
  };

  for (const [name, members] of Object.entries(CASES)) {
    it(`${name} ⇒ 13 项逐条落 [0,1] 且无一 NaN`, () => {
      for (const features of computeRankingFeatures(CONTEXT, members)) {
        for (const key of RANKING_FEATURE_KEYS) {
          const value = features[key];
          // 两条一起断言: 区间 + 非 NaN。少了后者, NaN 会从否定式区间断言里溜过去。
          expect([key, Number.isNaN(value)]).toEqual([key, false]);
          expect([key, value >= 0 && value <= 1]).toEqual([key, true]);
        }
      }
    });
  }
});

/**
 * 050 T011 —— 排序器 + 身份键 tie-break (FR-020 / FR-021 / FR-022 / FR-025 / FR-026, SC-006,
 * plan D-RANK-2)。
 *
 * 🚨 分层: `ranker` 只吃特征集、只管**主键**; 确定性次键 (到期日 / 行权价 / 合约代码) 是**身份**
 * 不是特征, 归 {@link rankLegs} 的外层。两者混在一起会让「合约代码怎么归一化到 0–1」这种问题
 * 冒出来, 而那只有靠把身份塞进特征集才能回答 —— 正是被否的做法。
 */

/** 各项恒取中性值的基准特征集 —— 每条用例只覆写自己关心的那几项。 */
function featuresOf(overrides: Partial<Record<RankingFeatureKey, number>> = {}): RankingFeatures {
  const base = {} as Record<RankingFeatureKey, number>;
  for (const key of RANKING_FEATURE_KEYS) base[key] = FEATURE_VALUE_WHEN_UNIFORM;
  return { ...base, ...overrides };
}

const idOf = (code: string, expiry: string, strike: string): LegIdentity => ({
  code,
  expiryDate: new Date(`${expiry}T00:00:00.000Z`),
  strike: D(strike),
});

describe('leg-rank.rules — 排序器只读特征集 (FR-020/FR-022)', () => {
  it('🚨 FR-022 机械判据: `rateDescendingRanker` 函数体 `grep -i dte` 零命中', () => {
    // DTE 是 13 项之一 (为将来加权备着), 但本片唯一的 ranker 一个字都不许提它 —— 既不许当
    // 主键, 也不许实现「离理想 DTE 越近越靠前」。判据落在函数体上而不是行为上, 是因为后者
    // 只在特定 fixture 下才露馅。
    expect(rateDescendingRanker.toString().toLowerCase()).not.toContain('dte');
  });

  it('DTE 差一大截而 `rate` 相同 → ranker 返回 0 (行为侧的同一条禁令)', () => {
    const short = featuresOf({ rate: 0.9, dteDays: 0 });
    const long = featuresOf({ rate: 0.9, dteDays: 1 });
    expect(rateDescendingRanker(short, long)).toBe(0);
    expect(rateDescendingRanker(long, short)).toBe(0);
  });

  it('`rate` 高的排前 —— 主键是折算费率降序 (FR-021)', () => {
    expect(rateDescendingRanker(featuresOf({ rate: 0.9 }), featuresOf({ rate: 0.1 }))).toBeLessThan(
      0,
    );
    expect(
      rateDescendingRanker(featuresOf({ rate: 0.1 }), featuresOf({ rate: 0.9 })),
    ).toBeGreaterThan(0);
  });

  it('🚨 类型层证明: 排序器拿不到原始腿数据, 想读必须先改签名 (FR-020)', () => {
    // @ts-expect-error 特征集里没有 `bid` 这类原始量 —— 这一行**必须**编译失败。若哪天
    // `RankingFeatures` 被放宽成 index signature 或原始量被塞了进来, 抑制变成「未使用」而
    // typecheck 立刻红 (同 `leg-recall.rules.spec.ts` 对 `absDelta` 的写法)。
    const illegal: LegRanker = (a, b) => b.bid - a.bid;
    expect(typeof illegal).toBe('function');
  });
});

describe('leg-rank.rules — rankLegs: 主键 + 身份键 tie-break (FR-025, SC-006)', () => {
  const A = idOf('P-A', '2026-09-18', '130');
  const B = idOf('P-B', '2026-09-18', '125');
  const C = idOf('P-C', '2026-08-21', '120');

  it('按主键降序产出**合约代码**列表 (腿本体不重复下发, FR-021a)', () => {
    const order = rankLegs(
      [A, B, C],
      [featuresOf({ rate: 0.1 }), featuresOf({ rate: 0.9 }), featuresOf({ rate: 0.3 })],
      rateDescendingRanker,
    );
    expect(order).toEqual(['P-B', 'P-C', 'P-A']);
  });

  it('🚨 费率相同 → 身份键定序: 到期日升序 → 行权价降序 → 合约代码', () => {
    const same = featuresOf({ rate: 0.5 });
    // C 到期最早 ⇒ 头位; A / B 同到期日, 行权价 130 > 125 ⇒ A 在前。
    expect(rankLegs([A, B, C], [same, same, same], rateDescendingRanker)).toEqual([
      'P-C',
      'P-A',
      'P-B',
    ]);
  });

  it('行权价也相同 → 合约代码兜底 (三级次键各自有判别性)', () => {
    const same = featuresOf({ rate: 0.5 });
    const twin = idOf('P-AA', '2026-09-18', '130');
    expect(rankLegs([twin, A], [same, same], rateDescendingRanker)).toEqual(['P-A', 'P-AA']);
  });

  it('🚨 SC-006: 同输入两次调用逐行相同, 且**打乱入参顺序结果不变** (确定性不靠入参次序)', () => {
    const features = new Map<string, RankingFeatures>([
      ['P-A', featuresOf({ rate: 0.5 })],
      ['P-B', featuresOf({ rate: 0.5 })],
      ['P-C', featuresOf({ rate: 0.5 })],
    ]);
    const rank = (members: LegIdentity[]) =>
      rankLegs(
        members,
        members.map((m) => features.get(m.code) as RankingFeatures),
        rateDescendingRanker,
      );

    const first = rank([A, B, C]);
    expect(rank([A, B, C])).toEqual(first);
    // 🚨 判别性在这一行: 全部费率相同时, 「原序兜底」的实现两次调用也逐行相同 —— 只有换了
    // 入参次序才看得出它靠的是次序而不是身份键。
    expect(rank([C, B, A])).toEqual(first);
    expect(rank([B, A, C])).toEqual(first);
  });

  it('ranker 返回非有限值 → 退回身份键而不是让 NaN 进 sort (FR-025 的结构保证)', () => {
    const nanRanker: LegRanker = () => Number.NaN;
    // NaN 与任何数比较恒 false ⇒ sort 的顺序变 V8 实现相关**且不抛错**。这里不依赖
    // `computeRankingFeatures` 守约: 确定性是 rankLegs 自己要保住的性质。
    const order = rankLegs([A, B, C], [featuresOf(), featuresOf(), featuresOf()], nanRanker);
    expect(order).toEqual(['P-C', 'P-A', 'P-B']);
    expect(rankLegs([C, A, B], [featuresOf(), featuresOf(), featuresOf()], nanRanker)).toEqual(
      order,
    );
  });

  it('空候选集 → 空列表', () => {
    expect(rankLegs([], [], rateDescendingRanker)).toEqual([]);
  });

  it('成员数与特征数不等 → 抛 (只可能是调用方没用同一份成员算特征, 静默会让整列错位)', () => {
    expect(() => rankLegs([A, B], [featuresOf()], rateDescendingRanker)).toThrow(RangeError);
  });
});
