import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  CONTINUOUS_FEATURE_KEYS,
  DISPLAY_LIMIT_BY_PERSPECTIVE,
  FEATURE_VALUE_WHEN_MISSING,
  FEATURE_VALUE_WHEN_UNIFORM,
  LIQUIDITY_TIER_BOUNDS,
  ORDINAL_FEATURE_KEYS,
  RANKING_FEATURE_KEYS,
  RANK_TIERING_MIN_CANDIDATES,
  RATE_TIE_BAND,
  allLegsRanker,
  computeRankingFeatures,
  layeredRanker,
  rankLegs,
  rateDescendingRanker,
  truncateToDisplayLimit,
  type LegIdentity,
  type LegRanker,
  type RankingContext,
  type RankingFeatureKey,
  type RankingFeatures,
  type RankingLegInput,
} from './leg-rank.rules';
import { RECALL_CANDIDATE_CAP } from './leg-recall.rules';
import { LEG_TABS } from './leg-tab.rules';

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
    strikeDiscount: D('0.05'),
    isMonthlyChain: false,
    isRoundStrike: false,
    isDeltaInIntentBand: false,
    crossesEarnings: false,
    isTopRanked: false,
    ...overrides,
  };
}

describe('leg-rank.rules — 特征集 16 项 (FR-019 / 052 FR-017 / FR-020)', () => {
  it('16 项齐全且逐字点名 —— 连续 9 + 固定取值 7, 少一项就红', () => {
    expect(CONTINUOUS_FEATURE_KEYS).toEqual([
      'rate',
      'effectiveCostDiscount',
      'relativeSpread',
      'openInterest',
      'volume',
      'turnover',
      'absDelta',
      'dteDays',
      'strikeDiscount',
    ]);
    expect(ORDINAL_FEATURE_KEYS).toEqual([
      'isMonthlyChain',
      'isRoundStrike',
      'isDeltaInIntentBand',
      'crossesEarnings',
      'isTopRanked',
      'liquidityTier',
      'isInTheMoney',
    ]);
    expect(RANKING_FEATURE_KEYS).toHaveLength(16);

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

  it('成色 (052 FR-020): 越虚值取值越高, 深度实值腿 (折价为负) 落 0', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ strikeDiscount: D('-0.15') }), // K = 115, 深度实值
      legOf({ strikeDiscount: D('0') }), // K = spot, 平值
      legOf({ strikeDiscount: D('0.30') }), // K = 70, 深度虚值
    ]);
    expect(features[0].strikeDiscount).toBe(0);
    expect(features[1].strikeDiscount).toBeCloseTo(1 / 3, 10);
    expect(features[2].strikeDiscount).toBe(1);
  });

  it('🚨 成色与有效成本折价是两项, 不可互相代替 (052 Guardrail 2 的连续版)', () => {
    // 同一条深度实值腿: 权利金厚 ⇒ 有效成本折价好看, 但成色仍是最差的那条。
    const [thickPremium, plainOtm] = computeRankingFeatures(CONTEXT, [
      legOf({ strikeDiscount: D('-0.15'), effectiveCost: D('90') }), // K=115 bid=25 ⇒ 折价 10%
      legOf({ strikeDiscount: D('0.20'), effectiveCost: D('98') }), // K=80 bid=-18? 仅作对照
    ]);
    expect(thickPremium.effectiveCostDiscount).toBe(1); // 有效成本这一项它最好
    expect(thickPremium.strikeDiscount).toBe(0); // 成色这一项它最差
    expect(plainOtm.strikeDiscount).toBe(1);
  });

  it('成色缺失 (spot 脏数据) 取「缺失」值, 与「真实为 0」在特征层不可区分', () => {
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ strikeDiscount: null }),
      legOf({ strikeDiscount: D('0.10') }),
    ]);
    expect(features[0].strikeDiscount).toBe(FEATURE_VALUE_WHEN_MISSING);
    expect(Number.isNaN(features[0].strikeDiscount)).toBe(false);
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

  it('🚨 候选集**只有 1 条**腿 → 9 项连续量全取 0.5, 无一 NaN', () => {
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

describe('leg-rank.rules — 流动性分档 (052 FR-017)', () => {
  /** 档界降序 [500, 100, 10] ⇒ 四档, 特征值 1 / 2/3 / 1/3 / 0。 */
  const tierOf = (openInterest: number | null, volume: number | null) =>
    computeRankingFeatures(CONTEXT, [legOf({ openInterest, volume })])[0].liquidityTier;

  it('活动量 = OI + 当日成交, 逐档取值 1 → 0 (越大越好)', () => {
    const [top, mid] = LIQUIDITY_TIER_BOUNDS;
    expect(tierOf(top, 0)).toBe(1); // 恰等于最高档界 ⇒ 进最高档 (闭区间)
    expect(tierOf(top - 1, 0)).toBeCloseTo(2 / 3, 10);
    expect(tierOf(mid - 1, 0)).toBeCloseTo(1 / 3, 10);
    expect(tierOf(0, 0)).toBe(0);
  });

  it('🚨 成交量与 OI 同量纲相加 —— OI 差一张但当日成交补上, 两条同档', () => {
    const [, mid] = LIQUIDITY_TIER_BOUNDS;
    expect(tierOf(mid, 0)).toBe(tierOf(mid - 5, 5));
  });

  it('🚨 分档量 MUST NOT 参与 min-max —— 候选集恰好全在同一档时取值不被拉伸', () => {
    // 三条腿活动量不同但同属最高档: 若误走连续类, min-max 会把它们拉成 0 / 0.5 / 1。
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ openInterest: 600, volume: 0 }),
      legOf({ openInterest: 5000, volume: 0 }),
      legOf({ openInterest: 70000, volume: 0 }),
    ]);
    expect(features.map((f) => f.liquidityTier)).toEqual([1, 1, 1]);
  });

  it('两侧缺失 ⇒ 落最差档 (fail-closed; 与召回层「null ≠ 0」不冲突, 见实现注释)', () => {
    expect(tierOf(null, null)).toBe(0);
  });
});

describe('leg-rank.rules — 分层排序 lexicographic (052 FR-017 / FR-018 / FR-019)', () => {
  /** 候选数足够 ⇒ 分档生效。 */
  const layered = layeredRanker(RANK_TIERING_MIN_CANDIDATES);

  it('🚨 厚腿排在薄腿前 —— 跨档时费率再高也压不过 (Guardrail 3 的反面)', () => {
    const thickLowRate = featuresOf({ liquidityTier: 1, rate: 0.1 });
    const thinTopRate = featuresOf({ liquidityTier: 0, rate: 0.99 });
    expect(layered(thickLowRate, thinTopRate)).toBeLessThan(0);
    expect(layered(thinTopRate, thickLowRate)).toBeGreaterThan(0);
  });

  it('档内按折算费率降序', () => {
    const rich = featuresOf({ liquidityTier: 1, rate: 0.9 });
    const poor = featuresOf({ liquidityTier: 1, rate: 0.2 });
    expect(layered(rich, poor)).toBeLessThan(0);
  });

  it('🚨 费率打平带内 ⇒ 长期优先 (FR-018)', () => {
    // 两条费率差 = 带宽的一半 ⇒ 判打平, 由 DTE 决胜。
    const half = RATE_TIE_BAND / 2;
    const shortLeg = featuresOf({ liquidityTier: 1, rate: 0.5 + half, dteDays: 0.1 });
    const longLeg = featuresOf({ liquidityTier: 1, rate: 0.5, dteDays: 0.9 });
    expect(layered(longLeg, shortLeg)).toBeLessThan(0);
  });

  it('费率差**超出**带宽 ⇒ 仍按费率, 期限不介入', () => {
    const shortRich = featuresOf({ liquidityTier: 1, rate: 0.5 + RATE_TIE_BAND * 2, dteDays: 0.1 });
    const longPoor = featuresOf({ liquidityTier: 1, rate: 0.5, dteDays: 0.9 });
    expect(layered(shortRich, longPoor)).toBeLessThan(0);
  });

  it('🚨 降级边界取严格小于 —— 恰好等于阈值仍分档, 少一条才退回纯费率降序', () => {
    const thickLowRate = featuresOf({ liquidityTier: 1, rate: 0.1 });
    const thinTopRate = featuresOf({ liquidityTier: 0, rate: 0.99 });
    // 恰等于阈值: 分档生效 ⇒ 厚腿在前。
    expect(layeredRanker(RANK_TIERING_MIN_CANDIDATES)(thickLowRate, thinTopRate)).toBeLessThan(0);
    // 少一条: 降级 ⇒ 高费率在前 (档失声)。
    expect(
      layeredRanker(RANK_TIERING_MIN_CANDIDATES - 1)(thickLowRate, thinTopRate),
    ).toBeGreaterThan(0);
  });

  it('降级分支**委托**给 `rateDescendingRanker` —— 不是另写一份同义实现', () => {
    // 🚨 **2026-09-01 由「引用相等」翻成「行为等价」, 理由在此**: 首键 `isDeltaInIntentBand`
    //    前置于降级分支**之外**(见 `layeredRanker` 函数头「降级只降档内那一层」) ⇒ 工厂恒返
    //    包装函数, `toBe` 不再成立。翻它的是那条前置本身, **不是实现走样** —— 委托关系改用
    //    「带内相同时与 `rateDescendingRanker` 逐对同号」钉住, 谁把降级分支换成别的实现照样红。
    const degraded = layeredRanker(RANK_TIERING_MIN_CANDIDATES - 1);
    const pairs: ReadonlyArray<readonly [RankingFeatures, RankingFeatures]> = [
      [featuresOf({ rate: 0.9 }), featuresOf({ rate: 0.2 })],
      [featuresOf({ rate: 0.2 }), featuresOf({ rate: 0.9 })],
      // 费率相同而流动性档不同 ⇒ 降级下档位失声, 两者同为 0。
      [featuresOf({ rate: 0.5, liquidityTier: 1 }), featuresOf({ rate: 0.5, liquidityTier: 0 })],
    ];
    for (const [a, b] of pairs) {
      expect(Math.sign(degraded(a, b))).toBe(Math.sign(rateDescendingRanker(a, b)));
    }
  });

  it('🚨 Δ 带内的腿整体在前 —— 跨档时费率与流动性再好也压不过 (2026-09-01 首键)', () => {
    // 实测原型 (us:PDD, spot 84.26): `85 P` 的 |Δ|=0.42 超出收租 near_atm 带 [0.30,0.40] ⇒ 带外,
    // 却因年化 16.6% 全场最高 + 流动性档高而排第一行; 三条带内的 `80 P` (|Δ|∈[0.34,0.35]) 反在
    // 其后。本键就是为拦这个 —— 「允许进候选」(召回成色上界放行轻微实值一档) 与「值得首推」
    // 是两件事。
    const bandOutBest = featuresOf({ isDeltaInIntentBand: 0, liquidityTier: 1, rate: 0.99 });
    const bandInWorst = featuresOf({ isDeltaInIntentBand: 1, liquidityTier: 0, rate: 0.1 });
    expect(layered(bandInWorst, bandOutBest)).toBeLessThan(0);
    expect(layered(bandOutBest, bandInWorst)).toBeGreaterThan(0);
  });

  it('🚨 降级分支同样吃首键 —— 候选 9 条与 10 条之间不出现行为突变', () => {
    const degraded = layeredRanker(RANK_TIERING_MIN_CANDIDATES - 1);
    const bandOutRich = featuresOf({ isDeltaInIntentBand: 0, rate: 0.99 });
    const bandInPoor = featuresOf({ isDeltaInIntentBand: 1, rate: 0.1 });
    expect(degraded(bandInPoor, bandOutRich)).toBeLessThan(0);
  });

  it('Δ 带内相同 ⇒ 首键让位, 其后三级键逐字照旧 (本片对既有键序零改动)', () => {
    const thick = featuresOf({ isDeltaInIntentBand: 1, liquidityTier: 1, rate: 0.1 });
    const thin = featuresOf({ isDeltaInIntentBand: 1, liquidityTier: 0, rate: 0.99 });
    expect(layered(thick, thin)).toBeLessThan(0);
  });

  it('🚨 FR-022 机械判据: ranker 函数体扫不到腿的**原始**字段名', () => {
    // 类型层已保证 ranker 的入参只有特征集 (`LegRanker` 签名); 这条扫描防的是**闭包捕获**
    // 外部腿数据 —— 那绕得过类型。
    // 📌 `strike` 蓄意不入表: `strikeDiscount` 是合法特征 (052 FR-020), 入表会让判据恒红。
    // 🚨 **扫的是工厂 `layeredRanker` 而非 `layered` 实例** (2026-09-01): 首键前置后三级键落进
    //    闭包, `layered.toString()` 只剩外层两行 —— 照样绿, 但**扫不到内层**, 守卫成摆设。
    //    取工厂全文可同时覆盖分档与降级两个分支。
    const body = layeredRanker.toString().toLowerCase();
    for (const raw of ['bid', 'ask', '.code', 'expirydate', 'greeks']) {
      expect([raw, body.includes(raw)]).toEqual([raw, false]);
    }
  });
});

describe('leg-rank.rules — 全腿视角: 实值沉底但不砍腿 (052 FR-020 / FR-006)', () => {
  it('🚨 实值腿沉底 —— 费率再高也排在虚值腿之后', () => {
    const itmRich = featuresOf({ isInTheMoney: 1, rate: 0.99 });
    const otmPoor = featuresOf({ isInTheMoney: 0, rate: 0.01 });
    expect(allLegsRanker(otmPoor, itmRich)).toBeLessThan(0);
    expect(allLegsRanker(itmRich, otmPoor)).toBeGreaterThan(0);
  });

  it('非实值的那批之间**保持费率降序** (FR-020 的「保持」不是空话)', () => {
    const rich = featuresOf({ isInTheMoney: 0, rate: 0.7 });
    const poor = featuresOf({ isInTheMoney: 0, rate: 0.2 });
    expect(allLegsRanker(rich, poor)).toBeLessThan(0);
  });

  it('实值腿之间也按费率降序 —— 沉底是整体后移, 不是打乱', () => {
    const richItm = featuresOf({ isInTheMoney: 1, rate: 0.7 });
    const poorItm = featuresOf({ isInTheMoney: 1, rate: 0.2 });
    expect(allLegsRanker(richItm, poorItm)).toBeLessThan(0);
  });

  it('🚨 沉底 MUST NOT 靠移出实现 —— ranker 只定序, `rankLegs` 返回的条数逐条不变', () => {
    const legs = [idOf('P-ITM', '2026-09-18', '150'), idOf('P-OTM', '2026-09-18', '90')];
    const features = [featuresOf({ isInTheMoney: 1, rate: 0.99 }), featuresOf({ rate: 0.01 })];
    const ordered = rankLegs(legs, features, allLegsRanker);
    expect(ordered).toHaveLength(2); // 一条都没少 (SC-006 的结构前提)
    expect(ordered).toEqual(['P-OTM', 'P-ITM']); // 实值那条在末位
  });

  it('🚫 全腿 ranker MUST NOT 提 DTE (050 FR-022 对本 ranker 一字有效)', () => {
    expect(allLegsRanker.toString().toLowerCase()).not.toContain('dte');
  });

  it('成色缺失 (spot 脏数据) ⇒ 不判实值 ⇒ 不沉底 —— 拿不准时 MUST NOT 施加惩罚', () => {
    const [unknown] = computeRankingFeatures(CONTEXT, [legOf({ strikeDiscount: null })]);
    expect(unknown.isInTheMoney).toBe(0);
  });

  it('实值判据取折价的**符号**, 在归一化之前 —— 候选集全是实值时仍逐条判 1', () => {
    // 三条都是 K > spot。若误拿归一化后的 strikeDiscount 判, 最虚的那条会被判成"不实值"。
    const features = computeRankingFeatures(CONTEXT, [
      legOf({ strikeDiscount: D('-0.30') }),
      legOf({ strikeDiscount: D('-0.10') }),
      legOf({ strikeDiscount: D('-0.01') }),
    ]);
    expect(features.map((f) => f.isInTheMoney)).toEqual([1, 1, 1]);
    // 而连续项照常在候选集内拉开: 最实值 → 0, 最不实值 → 1。
    expect(features.map((f) => f.strikeDiscount)).toEqual([0, expect.any(Number), 1]);
  });
});

describe('leg-rank.rules — SC-003a 全量核对: 16 项恒落 [0,1]', () => {
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
    it(`${name} ⇒ 16 项逐条落 [0,1] 且无一 NaN`, () => {
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

/**
 * 053 T002 —— 表达层截断 `N` (FR-010 – FR-012, plan D-ORDER-1 / D-LIMIT-1)。
 *
 * 🚨 **本段的判别性用例是「截掉的是排序尾部」而不是「截后条数对」** (Guardrail 8): 条数对
 * 是任何一种截法都满足的性质 —— 从中间截、从头截、按别的键重排后再截, 条数全都对得上。
 */
describe('leg-rank.rules — 表达层截断 N (053 FR-010 – FR-012)', () => {
  const ranked = ['P-1', 'P-2', 'P-3', 'P-4', 'P-5'];

  it('🚨 边界三态: 少于 / 恰等于阈值都不截, **严格大于**才截', () => {
    expect(truncateToDisplayLimit(ranked.slice(0, 4), 5)).toHaveLength(4);
    // 恰等于阈值不截 —— 那时「其余 0 条未显示」这句话不该出现 (spec Edge Case)。
    expect(truncateToDisplayLimit(ranked, 5)).toHaveLength(5);
    expect(truncateToDisplayLimit(ranked, 4)).toHaveLength(4);
  });

  it('未触发截断 → 返回**入参本体**而不是拷贝 (「这次没截」是可判定的事实, 不靠比长度推断)', () => {
    expect(truncateToDisplayLimit(ranked, ranked.length)).toBe(ranked);
    expect(truncateToDisplayLimit(ranked, ranked.length + 1)).toBe(ranked);
  });

  it('🚨 截掉的恒是排序**尾部** —— 前 D 条逐条相同 (只断条数抓不到「截错了哪一段」)', () => {
    const kept = truncateToDisplayLimit(ranked, 3);
    expect(kept).toEqual(['P-1', 'P-2', 'P-3']);
    expect([...kept]).toEqual(ranked.slice(0, kept.length));
  });

  it('阈值 `null` = 不设该视角阈值 ⇒ 零截断且返回本体 (FR-013「无断点则不拍数」的落点)', () => {
    expect(truncateToDisplayLimit(ranked, null)).toBe(ranked);
  });

  it('空序列 / 阈值 0 都是合法边界, 不特判成「不截」', () => {
    expect(truncateToDisplayLimit([], 3)).toEqual([]);
    expect(truncateToDisplayLimit(ranked, 0)).toEqual([]);
  });

  it('🚨 按视角分档 (FR-012): 三视角各有自己的阈值, 全腿与意图档 MUST NOT 取同一个数', () => {
    expect(Object.keys(DISPLAY_LIMIT_BY_PERSPECTIVE).sort()).toEqual([...LEG_TABS].sort());
    // 全腿与两个意图视角的成员规模差一个量级 —— 一律同一个数会让其中一档要么形同虚设、
    // 要么砍掉不该砍的 (FR-012 的存在理由)。
    expect(DISPLAY_LIMIT_BY_PERSPECTIVE.all).not.toBe(DISPLAY_LIMIT_BY_PERSPECTIVE.build);
  });

  it('🚨 K (召回容量) 与 N (展示条数) 是两个独立常量 —— 共用会顺手改掉召回容量', () => {
    for (const tab of LEG_TABS) {
      const limit = DISPLAY_LIMIT_BY_PERSPECTIVE[tab];
      if (limit === null) continue;
      // 052 T005 当时没有 N, 只能写量级断言占位; 本片起这是**真对照**。
      expect(limit).not.toBe(RECALL_CANDIDATE_CAP);
      // ADR-0064 不变量 ①「K ≫ N」的机器读法。T012 若标出大到过不了这条的 N, 该重估的是
      // **K**(召回容量不够) 而不是本断言 —— 🚫 MUST NOT 放宽它。
      expect(limit * 5).toBeLessThanOrEqual(RECALL_CANDIDATE_CAP);
    }
  });
});
