import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  BUILD_RECALL_DTE,
  LIQUIDITY_MAX_RELATIVE_SPREAD,
  PREMIUM_FLOOR,
  OPEN_INTEREST_FLOOR,
  RECALL_CANDIDATE_CAP,
  QUALITY_CEILING_SPOT_RATIO,
  RENT_RECALL_DTE,
  RETRIEVAL_CRITERION_KEYS,
  defaultCriteriaByTab,
  failedCriteria,
  passesEffectiveCostGate,
  passesHardGates,
  passesOpenInterestMin,
  passesPremiumMin,
  passesQualityCeiling,
  passesRelativeSpreadMax,
  recallCandidates,
  relativeSpread,
  resolvePremiumFloor,
  resolveQualityCeiling,
  type LegIntentTab,
  type RecallChainContext,
  type RecallContext,
  type RecallLegInput,
  type RetrievalOverride,
} from './leg-recall.rules';
import { LEG_TABS, type LegTab } from './leg-tab.rules';

const D = (v: string) => new Prisma.Decimal(v);

/** spot = 110 ⇒ 权利金门槛 = max(绝对下限, 110 × 比例)，两侧取值都由常量派生，不手抄。 */
const context: RecallContext = { spot: D('110') };

/**
 * 期限段 / 有效成本 / 流动性三组断言用的链级上下文 —— **成色上界取足够高使其不参与判定**。
 *
 * 🚨 蓄意不用真实上界：那样一条断言变红时分不清是哪道判据挂的，而成色自己的边界在下面
 * 「成色条件」那组里逐条验（含闭区间端点），不靠这里兼职。
 */
const chain: RecallChainContext = { spot: context.spot, qualityCeiling: D('9999') };

/**
 * 成员判定的**唯一**入口（052 T010）：硬门槛 + 六维检索条件，逐视角判。
 *
 * 🚨 它取代了 051 的 `recallTabs`——那个入口的判据（期限段 / 成色 / 价差）在 T010 全部搬进
 * {@link failedCriteria}，留着它就留了第二份成员判据（`FR-003`「全仓只有一个 filter 概念」）。
 * 📌 判定面因此**变宽了**：权利金与持仓量在 051 是外层的「整条移出」，T010 起它们是三视角
 * 共同的检索条件 ⇒ 都不过 ⇒ `tabs` 为空 ⇒ 仍是整条移出，等价而不再是两条路径。
 */
const tabsOf = (c: RecallChainContext, l: RecallLegInput): LegTab[] => {
  const criteria = defaultCriteriaByTab(c);
  return LEG_TABS.filter(
    (tab) => passesHardGates(tab, c, l) && failedCriteria(criteria[tab], l).length === 0,
  );
};

/** 「本来进得去、**只**被价差这一维挡下」的意图视角——051 两个流动性数的判据，与上同源。 */
const excludedByLiquidity = (c: RecallChainContext, l: RecallLegInput): LegIntentTab[] => {
  const criteria = defaultCriteriaByTab(c);
  return (['build', 'rent'] as const).filter(
    (tab) =>
      passesHardGates(tab, c, l) &&
      failedCriteria(criteria[tab], l).join(',') === 'relativeSpreadMax',
  );
};

/** 基线腿: DTE=35 (重叠区)、有效成本 98 < spot、三道门槛均宽松通过。 */
const leg = (over: Partial<RecallLegInput> = {}): RecallLegInput => ({
  dteDays: 35,
  strike: D('100'),
  bid: D('2'),
  ask: D('2.1'),
  openInterest: 100,
  volume: 10,
  ...over,
});

describe('leg-recall.rules — 期限段召回 (FR-001 / FR-002 / FR-003)', () => {
  it('建仓段四个端点闭合: 1 与 49 在带内, 0 与 50 出局', () => {
    expect(tabsOf(chain, leg({ dteDays: BUILD_RECALL_DTE.min }))).toContain('build');
    expect(tabsOf(chain, leg({ dteDays: BUILD_RECALL_DTE.max }))).toContain('build');
    expect(tabsOf(chain, leg({ dteDays: BUILD_RECALL_DTE.min - 1 }))).not.toContain('build');
    expect(tabsOf(chain, leg({ dteDays: BUILD_RECALL_DTE.max + 1 }))).not.toContain('build');
  });

  it('收租段四个端点闭合: 30 与 365 在带内, 29 与 366 出局', () => {
    expect(tabsOf(chain, leg({ dteDays: RENT_RECALL_DTE.min }))).toContain('rent');
    expect(tabsOf(chain, leg({ dteDays: RENT_RECALL_DTE.max }))).toContain('rent');
    expect(tabsOf(chain, leg({ dteDays: RENT_RECALL_DTE.min - 1 }))).not.toContain('rent');
    expect(tabsOf(chain, leg({ dteDays: RENT_RECALL_DTE.max + 1 }))).not.toContain('rent');
  });

  it('重叠区 [30,49] 是设计意图不是重复 —— DTE=35 同时进两个意图 Tab', () => {
    expect(tabsOf(chain, leg({ dteDays: 35 }))).toEqual(['all', 'build', 'rent']);
  });

  it('DTE=400 两个意图都不进, 但恒在全腿 Tab (FR-003: 全腿 Tab 不设期限段)', () => {
    expect(tabsOf(chain, leg({ dteDays: 400 }))).toEqual(['all']);
  });

  it('全腿 Tab 恒在返回里 —— 「进不了意图 Tab」MUST NOT 变成「哪儿都看不见」', () => {
    expect(tabsOf(chain, leg({ dteDays: 0, ask: null }))).toEqual(['all']);
  });
});

describe('leg-recall.rules — 有效成本硬判据 (FR-004, Guardrail 5)', () => {
  const effectiveCostOk = (l: RecallLegInput) =>
    passesEffectiveCostGate(context.spot, l.strike, l.bid);

  it('K − bid 恰好等于 spot ⇒ 不进建仓 (严格小于; 成本持平时用 put 代替直接买没有优势)', () => {
    const breakEven = leg({ dteDays: 20, strike: D('115'), bid: D('5'), ask: D('5.2') });
    expect(effectiveCostOk(breakEven)).toBe(false);
    expect(tabsOf(chain, breakEven)).not.toContain('build');
  });

  it('K − bid 低于 spot 一分钱即进建仓', () => {
    const justUnder = leg({ dteDays: 20, strike: D('115'), bid: D('5.01'), ask: D('5.2') });
    expect(effectiveCostOk(justUnder)).toBe(true);
    expect(tabsOf(chain, justUnder)).toContain('build');
  });

  it('🚨 收租 MUST NOT 受有效成本约束 —— 深虚腿有效成本远高于 spot 仍进收租', () => {
    const deepOtm = leg({ dteDays: 35, strike: D('200'), bid: D('1'), ask: D('1.1') });
    expect(effectiveCostOk(deepOtm)).toBe(false);
    expect(tabsOf(chain, deepOtm)).toEqual(['all', 'rent']);
  });

  it('无 bid ⇒ 有效成本无定义 ⇒ 不进建仓 (MUST NOT 拿 K − 0 冒充)', () => {
    expect(effectiveCostOk(leg({ bid: null }))).toBe(false);
  });
});

describe('leg-recall.rules — 权利金绝对门槛 (FR-005)', () => {
  /** 052 T010 起「解出下限」与「拿下限判」是两步：前者是系统默认值，后者吃任意下限。 */
  const passesAt = (bid: Prisma.Decimal | null, spot: Prisma.Decimal) =>
    passesPremiumMin(bid, resolvePremiumFloor(spot));

  it('取绝对下限与 spot 比例的较大者, 两侧各自生效', () => {
    // 低价标的: 绝对下限占优。
    const cheap = D('10');
    expect(resolvePremiumFloor(cheap).equals(PREMIUM_FLOOR.absolute)).toBe(true);
    expect(passesAt(PREMIUM_FLOOR.absolute, cheap)).toBe(true);
    expect(passesAt(PREMIUM_FLOOR.absolute.minus('0.01'), cheap)).toBe(false);

    // 高价标的: spot 比例占优 —— 造一个使比例项严格大于绝对下限的 spot。
    const rich = PREMIUM_FLOOR.absolute.div(PREMIUM_FLOOR.spotRatio).times(2);
    const ratioFloor = rich.times(PREMIUM_FLOOR.spotRatio);
    expect(ratioFloor.greaterThan(PREMIUM_FLOOR.absolute)).toBe(true);
    expect(resolvePremiumFloor(rich).equals(ratioFloor)).toBe(true);
    expect(passesAt(ratioFloor, rich)).toBe(true);
    expect(passesAt(ratioFloor.minus('0.01'), rich)).toBe(false);
  });

  it('🚫 无 bid 判 false, MUST NOT 当 0 —— 「不知道」与「知道且很低」处置同归但实现不同', () => {
    expect(passesAt(null, context.spot)).toBe(false);
    // 判 false 的路径与「bid = 0」不共用: 0 是一个真实报价, null 是缺报价。
    expect(passesAt(D('0'), context.spot)).toBe(false);
  });
});

describe('leg-recall.rules — 相对价差与流动性门槛 (FR-006)', () => {
  it('relativeSpread = (ask − bid) / mid, mid = (bid + ask) / 2', () => {
    expect(relativeSpread(D('1'), D('3'))?.toString()).toBe('1');
    expect(relativeSpread(D('2'), D('2.1'))?.equals(D('0.1').div(D('2.05')))).toBe(true);
  });

  it('任一侧缺失 ⇒ null; mid ≤ 0 ⇒ null (禁除零)', () => {
    expect(relativeSpread(null, D('2'))).toBeNull();
    expect(relativeSpread(D('2'), null)).toBeNull();
    expect(relativeSpread(D('0'), D('0'))).toBeNull();
  });

  it('上界含端点 —— 恰好等于阈值仍通过, 超出即出局', () => {
    // 取 `bid = 2 − t` / `ask = 2 + t` ⇒ `mid = 2`、价差 = `2t` ⇒ 相对价差**恰好** = t。
    // 🚫 蓄意不写成 `ask = bid × (2+t)/(2−t)`: 那条除法在 Decimal 下是无穷循环小数, 会被
    // 截到 20 位有效数字, 于是「恰好等于端点」这条判据自己先失真 (实测红)。
    const t = LIQUIDITY_MAX_RELATIVE_SPREAD;
    const bid = D('2').minus(t);
    const askAtBound = D('2').plus(t);
    expect(relativeSpread(bid, askAtBound)?.equals(t)).toBe(true);
    expect(passesRelativeSpreadMax(bid, askAtBound, t)).toBe(true);
    expect(passesRelativeSpreadMax(bid, askAtBound.plus('0.02'), t)).toBe(false);
  });

  it('🚨 无 ask ⇒ fail-closed (不进意图 Tab), 但腿仍在全腿 Tab 可见', () => {
    expect(passesRelativeSpreadMax(D('2'), null, LIQUIDITY_MAX_RELATIVE_SPREAD)).toBe(false);
    expect(tabsOf(chain, leg({ ask: null }))).toEqual(['all']);
  });

  it('无 bid ⇒ 同样算不出价差 ⇒ fail-closed', () => {
    expect(passesRelativeSpreadMax(null, D('2'), LIQUIDITY_MAX_RELATIVE_SPREAD)).toBe(false);
    // 🚨 052 T010 起无 bid 的腿**连全腿都不进**: 权利金条件是三视角一律的检索条件, 它先挡下。
    // 051 下这条腿同样看不见 (权利金门槛在更外层「整条移出」) —— 变的是判定住在哪儿, 不是结果。
    expect(tabsOf(chain, leg({ bid: null }))).toEqual([]);
  });
});

describe('leg-recall.rules — 两个流动性排除数的共同判据 (FR-008 / 051 FR-006a)', () => {
  it('只数「本来进得去、被流动性门槛挡下」的腿, 并**点名是哪几个视角**', () => {
    const wide = leg({ dteDays: 35, ask: D('20') });
    expect(tabsOf(chain, wide)).toEqual(['all']);
    // 🚨 DTE=35 落重叠区 ⇒ 一条腿让**两个**视角各少一条, 而全表标量只记 1 次。
    // 这就是 051 SC-012 取不等式 (`标量 ≤ build + rent`) 而非等号的根: 断言写成
    // `toEqual(['build'])` 或只判布尔, 重叠区的双计就没有任何一处会红。
    expect(excludedByLiquidity(chain, wide)).toEqual(['build', 'rent']);
  });

  it('只够一个视角的腿只让那一个视角减少 —— 两个数各自独立, 不是同一个数的两份拷贝', () => {
    // DTE=164 只在收租段 `[30,365]` 内, 建仓段 `[1,49]` 够不着。
    expect(excludedByLiquidity(chain, leg({ dteDays: 164, ask: D('20') }))).toEqual(['rent']);
    // DTE=10 反过来: 只在建仓段内。
    expect(excludedByLiquidity(chain, leg({ dteDays: 10, ask: D('20') }))).toEqual(['build']);
  });

  it('🚫 期限段本就不合格的腿 MUST NOT 计入 —— 它不是被流动性门槛挡下的', () => {
    expect(excludedByLiquidity(chain, leg({ dteDays: 400, ask: D('20') }))).toEqual([]);
  });

  it('🚫 有效成本不过的腿 MUST NOT 计进建仓数 —— 它本来就进不了建仓, 与流动性无关', () => {
    // 有效成本 120 − 2 = 118 **>** spot 110 ⇒ 建仓段够得着也进不去; DTE=10 又够不着收租段。
    expect(
      excludedByLiquidity(chain, leg({ dteDays: 10, strike: D('120'), ask: D('20') })),
    ).toEqual([]);
  });

  it('通过流动性门槛的腿恒不计入', () => {
    expect(excludedByLiquidity(chain, leg())).toEqual([]);
  });
});

describe('leg-recall.rules — 成色条件 (052 FR-005 / FR-006 / FR-007)', () => {
  /** spot = 110 的比例项上界，由常量派生不手抄。 */
  const ratioCeiling = context.spot.times(QUALITY_CEILING_SPOT_RATIO.plus(1));
  const strikes = (values: string[]) => values.map((v) => leg({ strike: D(v) }));

  it('结构项占优: 密网格下上界 = spot 之上最近一档 (110), 比例项 (114.4) 更松故不接管', () => {
    const ceiling = resolveQualityCeiling(context.spot, strikes(['100', '105', '110', '120']));
    expect(ceiling.equals(D('110'))).toBe(true);
    expect(ceiling.lessThan(ratioCeiling)).toBe(true);
  });

  it('稀疏网格下由比例项接管 —— 最近一档 130 太远, 上界收到 spot × (1+X)', () => {
    const ceiling = resolveQualityCeiling(context.spot, strikes(['90', '100', '130']));
    expect(ceiling.equals(ratioCeiling)).toBe(true);
  });

  it('链上无 ≥ spot 的档 ⇒ 结构项无定义 ⇒ 退化为仅比例项 (🚫 不是"没上界故全放行")', () => {
    const ceiling = resolveQualityCeiling(context.spot, strikes(['90', '100', '105']));
    expect(ceiling.equals(ratioCeiling)).toBe(true);
  });

  it('恰等于 spot 的档就是「spot 之上最近一档」—— 闭区间在上界这一侧也含端点', () => {
    const ceiling = resolveQualityCeiling(context.spot, strikes(['105', '110']));
    expect(ceiling.equals(context.spot)).toBe(true);
    expect(passesQualityCeiling(ceiling, ceiling)).toBe(true);
    expect(passesQualityCeiling(ceiling.plus('0.01'), ceiling)).toBe(false);
  });

  it('高于上界不进收租, 恰等于上界进收租', () => {
    const gridded: RecallChainContext = {
      spot: context.spot,
      qualityCeiling: resolveQualityCeiling(context.spot, strikes(['100', '105', '110', '120'])),
    };
    expect(tabsOf(gridded, leg({ dteDays: 35, strike: D('110') }))).toContain('rent');
    expect(tabsOf(gridded, leg({ dteDays: 35, strike: D('112') }))).not.toContain('rent');
  });

  it('🚨 同一条腿高于成色上界仍进建仓、仍在全腿 (052 FR-006 / FR-007: 只收租设成色)', () => {
    const gridded: RecallChainContext = {
      spot: context.spot,
      qualityCeiling: resolveQualityCeiling(context.spot, strikes(['100', '105', '110', '120'])),
    };
    // K=115 高于上界 110；有效成本 115 − 6 = 109 **<** spot ⇒ 建仓判据照过。
    const overCeiling = leg({ dteDays: 35, strike: D('115'), bid: D('6'), ask: D('6.2') });
    expect(tabsOf(gridded, overCeiling)).toEqual(['all', 'build']);
  });

  it('🚫 被成色挡下的腿 MUST NOT 计进流动性排除数 —— 它本来就进不了收租', () => {
    const gridded: RecallChainContext = {
      spot: context.spot,
      qualityCeiling: resolveQualityCeiling(context.spot, strikes(['100', '105', '110', '120'])),
    };
    // DTE=164 只够收租段；价差宽到出局；但 K=120 已被成色挡在收租之外。
    const wideAndRich = leg({ dteDays: 164, strike: D('120'), bid: D('2'), ask: D('20') });
    expect(excludedByLiquidity(gridded, wideAndRich)).toEqual([]);
  });

  it('🚨 网格取自链上全部腿, MUST NOT 取过完权利金门槛的那批 —— 否则上界反而变松', () => {
    // A 恰是 spot 之上最近一档, 但 bid 低于权利金门槛被整条移出。
    const a = { ...leg({ dteDays: 35, strike: D('110') }), code: 'A', bid: D('0.01') };
    // B 高于 A 一档。若上界在"过滤后"的集合上求, min{K ≥ spot} 会跳到 112 ⇒ B 恰等于上界而进收租。
    const b = { ...leg({ dteDays: 35, strike: D('112') }), code: 'B' };
    const outcome = recallCandidates(
      context,
      ['all', 'build', 'rent'],
      [a, b],
      RECALL_CANDIDATE_CAP,
    );

    expect(outcome.removedByPremiumFloor).toBe(1);
    expect(outcome.candidates.map((c) => c.leg.code)).toEqual(['B']);
    expect(outcome.candidates[0]?.tabs).not.toContain('rent');
  });
});

describe('leg-recall.rules — 持仓量条件 (052 FR-008 / FR-009)', () => {
  const allTabs = ['all', 'build', 'rent'] as const;
  /** 只跑持仓量这一道：其余判据全宽松通过，被移出就只可能是它挡的。 */
  const survives = (over: Partial<RecallLegInput>) =>
    recallCandidates(context, allTabs, [leg(over)], RECALL_CANDIDATE_CAP).candidates.length === 1;

  it('OI=0 且当日无成交 ⇒ 死腿, 整条移出 (三视角都看不到)', () => {
    expect(passesOpenInterestMin(0, 0, OPEN_INTEREST_FLOOR)).toBe(false);
    expect(survives({ openInterest: 0, volume: 0 })).toBe(false);
  });

  it('🚨 OI=0 但当日有成交 ⇒ 免死条款救回 (新挂档, OI 次日盘前才更新)', () => {
    expect(passesOpenInterestMin(0, 1, OPEN_INTEREST_FLOOR)).toBe(true);
    expect(survives({ openInterest: 0, volume: 1 })).toBe(true);
  });

  it('下限取闭区间: 恰等于下限进, 差一张出局', () => {
    expect(passesOpenInterestMin(OPEN_INTEREST_FLOOR, 0, OPEN_INTEREST_FLOOR)).toBe(true);
    expect(passesOpenInterestMin(OPEN_INTEREST_FLOOR - 1, 0, OPEN_INTEREST_FLOOR)).toBe(false);
  });

  it('🚫 成交量 null 与 0 走两条路径 —— null 是「没采到」, MUST NOT 折成 0', () => {
    // 处置同归（都不给免死），但左边是"不知道"、右边是"知道且为零"。
    expect(passesOpenInterestMin(0, null, OPEN_INTEREST_FLOOR)).toBe(false);
    expect(passesOpenInterestMin(0, 0, OPEN_INTEREST_FLOOR)).toBe(false);
    // OI 侧同理：缺 OI 时不拿 0 顶上再比大小，但成交量仍可救它。
    expect(passesOpenInterestMin(null, 0, OPEN_INTEREST_FLOOR)).toBe(false);
    expect(passesOpenInterestMin(null, 5, OPEN_INTEREST_FLOOR)).toBe(true);
  });

  it('三视角行为一致 —— 逐个视角单独请求, 死腿一个都进不去', () => {
    const dead = leg({ openInterest: 0, volume: 0 });
    for (const tab of allTabs) {
      expect(recallCandidates(context, [tab], [dead], RECALL_CANDIDATE_CAP).candidates).toEqual([]);
    }
    // 活腿反过来：三个视角各自都拿得到它（DTE=35 落重叠区）。
    for (const tab of allTabs) {
      expect(
        recallCandidates(context, [tab], [leg()], RECALL_CANDIDATE_CAP).candidates,
      ).toHaveLength(1);
    }
  });

  it('🚨 持仓量条件 MUST 排在权利金门槛之后 —— 否则 051 已 ship 的排除数会静默变小', () => {
    // 这条腿两道都不过（bid 0.01 低于门槛、OI=0 且无成交）。它 MUST 计进权利金那个数。
    const both = leg({ bid: D('0.01'), openInterest: 0, volume: 0 });
    const outcome = recallCandidates(context, allTabs, [both], RECALL_CANDIDATE_CAP);
    expect(outcome.removedByPremiumFloor).toBe(1);
    expect(outcome.candidates).toEqual([]);
  });

  it('🚫 被持仓量条件挡下的腿 MUST NOT 计进权利金排除数 —— 两道各数各的', () => {
    const outcome = recallCandidates(
      context,
      allTabs,
      [leg({ openInterest: 0, volume: 0 })],
      RECALL_CANDIDATE_CAP,
    );
    expect(outcome.removedByPremiumFloor).toBe(0);
    expect(outcome.candidates).toEqual([]);
  });

  it('🚫 权利金门槛的两个常量本片逐字未变 (052 FR-009: 只是把它归类为可调检索条件)', () => {
    expect(PREMIUM_FLOOR.absolute.toString()).toBe('0.2');
    expect(PREMIUM_FLOOR.spotRatio.toString()).toBe('0.0018');
  });
});

describe('leg-recall.rules — 召回层候选上限 K (052 FR-027 / FR-028)', () => {
  const allTabs = ['all', 'build', 'rent'] as const;
  /** n 条互不相同的合格腿（DTE 与行权价都错开，使切法的定序有可判定的答案）。 */
  const chainOf = (n: number) =>
    Array.from({ length: n }, (_, i) => leg({ dteDays: 30 + i, strike: D(String(90 - i)) }));

  it('候选数 < K ⇒ 不截, 切掉数为 0', () => {
    const outcome = recallCandidates(context, allTabs, chainOf(3), 5);
    expect(outcome.candidates).toHaveLength(3);
    expect(outcome.droppedByCandidateCap).toBe(0);
  });

  it('候选数**恰等于** K ⇒ 不截 (边界取「超过才切」)', () => {
    const outcome = recallCandidates(context, allTabs, chainOf(5), 5);
    expect(outcome.candidates).toHaveLength(5);
    expect(outcome.droppedByCandidateCap).toBe(0);
  });

  it('候选数 > K ⇒ 截到 K, 且切掉多少条**可读** (🚫 不是只落日志)', () => {
    const outcome = recallCandidates(context, allTabs, chainOf(8), 5);
    expect(outcome.candidates).toHaveLength(5);
    expect(outcome.droppedByCandidateCap).toBe(3);
  });

  it('🚨 切法确定: 输入顺序打乱后, 留下的成员逐条相同', () => {
    const legs = chainOf(8);
    const shuffled = [...legs].reverse();
    const keptOf = (input: readonly RecallLegInput[]) =>
      recallCandidates(context, allTabs, input, 5).candidates.map((c) => c.leg.dteDays);
    expect(keptOf(shuffled)).toEqual(keptOf(legs));
    // 键是「日历顺序」而非好坏：留下的是 DTE 最小的那 5 条。
    expect(keptOf(legs)).toEqual([30, 31, 32, 33, 34]);
  });

  it('🚫 被切掉的腿 MUST NOT 改动三个门槛计数 —— 它们早已过门槛, 切它不是「被挡下」', () => {
    // 一条权利金不过 + 一条流动性挡在意图外 + 8 条合格腿，K=2。
    const rejected = leg({ bid: D('0.01') });
    const wide = leg({ dteDays: 35, ask: D('20') });
    const outcome = recallCandidates(context, allTabs, [rejected, wide, ...chainOf(8)], 2);
    expect(outcome.candidates).toHaveLength(2);
    expect(outcome.droppedByCandidateCap).toBe(7); // 8 条合格 + wide 也进候选（全腿）= 9 → 留 2
    expect(outcome.removedByPremiumFloor).toBe(1);
    expect(outcome.excludedFromIntentTabs).toBe(1);
  });

  it('🚨 K 与表达层的 N 是两个独立参数 —— 本片零处把 K 当"给用户看几条"用', () => {
    // 053 会引入表达层的 N。这条断言守的是"别共用一个常量"：K 是保险丝，量级远高于任何
    // 可能的 N（当前最大链 758 行）。共用会让"调给用户看几条"顺手改掉召回容量。
    expect(RECALL_CANDIDATE_CAP).toBeGreaterThan(758);
  });
});

describe('leg-recall.rules — Δ 已降级为标 (FR-009)', () => {
  it('🚨 召回入参里没有 |Δ| —— 这是结构保证不是事后约定 (类型层证明)', () => {
    // @ts-expect-error `absDelta` MUST NOT 出现在召回入参里: 拿不到这个量就不可能拿它做召回
    // 判据。想把 Δ 塞回召回就必须先改签名 —— 那一步 review 看得见。若本行不再报错, 说明
    // 签名已被加回 Δ, 此时 `@ts-expect-error` 变成「未使用的抑制」而 typecheck 立刻红。
    const withDelta: RecallLegInput = { ...leg(), absDelta: 0.45 };
    expect(tabsOf(chain, withDelta)).toEqual(['all', 'build', 'rent']);
  });

  it('greeks 缺失的腿照常进意图召回集 —— 与 047 相反', () => {
    // greeks 缺失在本层完全不可表达 (没有承载它的入参), 故「照常进」是构造上的必然。
    expect(tabsOf(chain, leg({ dteDays: 20 }))).toContain('build');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 052 T010 检索条件: 系统默认值 + 用户覆盖 + 三态计数
// ─────────────────────────────────────────────────────────────────────────────

describe('leg-recall.rules — 每视角的系统默认值 (052 FR-011, T010 六维度表)', () => {
  const gridded: RecallChainContext = { spot: context.spot, qualityCeiling: D('114.4') };
  const defaults = defaultCriteriaByTab(gridded);

  it('🚨 行权价上界只收租设 —— 全腿是参照视角 (FR-006), 建仓由有效成本硬门槛等价挡住 (FR-007)', () => {
    expect(defaults.rent.strikeMax?.equals(gridded.qualityCeiling)).toBe(true);
    expect(defaults.all.strikeMax).toBeNull();
    expect(defaults.build.strikeMax).toBeNull();
  });

  it('DTE 段三视角不同, 全腿不设 (FR-003)', () => {
    expect(defaults.build.dteBand).toEqual(BUILD_RECALL_DTE);
    expect(defaults.rent.dteBand).toEqual(RENT_RECALL_DTE);
    expect(defaults.all.dteBand).toBeNull();
  });

  it('🚨 相对价差上界只两个意图视角设, 全腿不设 (FR-010)', () => {
    expect(defaults.build.relativeSpreadMax?.equals(LIQUIDITY_MAX_RELATIVE_SPREAD)).toBe(true);
    expect(defaults.rent.relativeSpreadMax?.equals(LIQUIDITY_MAX_RELATIVE_SPREAD)).toBe(true);
    expect(defaults.all.relativeSpreadMax).toBeNull();
  });

  it('权利金下限与持仓量下限三视角一律; 行权价下界三视角均不限', () => {
    for (const tab of LEG_TABS) {
      expect(defaults[tab].premiumMin?.equals(resolvePremiumFloor(gridded.spot))).toBe(true);
      expect(defaults[tab].openInterestMin).toBe(OPEN_INTEREST_FLOOR);
      expect(defaults[tab].strikeMin).toBeNull();
    }
  });

  it('🚨 权利金下限随 spot 变 —— 这正是「客户端 MUST NOT 自算默认值」的理由 (FR-011)', () => {
    const rich = defaultCriteriaByTab({
      spot: PREMIUM_FLOOR.absolute.div(PREMIUM_FLOOR.spotRatio).times(2),
      qualityCeiling: D('9999'),
    });
    expect(rich.all.premiumMin?.greaterThan(defaults.all.premiumMin!)).toBe(true);
  });
});

describe('leg-recall.rules — 单维度判据 failedCriteria (052 FR-003: 成员判定单点)', () => {
  const blank = {
    strikeMax: null,
    strikeMin: null,
    dteBand: null,
    premiumMin: null,
    openInterestMin: null,
    relativeSpreadMax: null,
  };

  it('六维全不限 ⇒ 一条腿都挡不下 (空数组)', () => {
    expect(failedCriteria(blank, leg())).toEqual([]);
    expect(failedCriteria(blank, leg({ bid: null, ask: null, openInterest: null }))).toEqual([]);
  });

  it('行权价上下界均取闭区间 —— 恰等于端点仍在内', () => {
    expect(failedCriteria({ ...blank, strikeMax: D('100') }, leg({ strike: D('100') }))).toEqual(
      [],
    );
    expect(failedCriteria({ ...blank, strikeMax: D('100') }, leg({ strike: D('100.01') }))).toEqual(
      ['strikeMax'],
    );
    expect(failedCriteria({ ...blank, strikeMin: D('100') }, leg({ strike: D('100') }))).toEqual(
      [],
    );
    expect(failedCriteria({ ...blank, strikeMin: D('100') }, leg({ strike: D('99.99') }))).toEqual([
      'strikeMin',
    ]);
  });

  it('DTE 段取闭区间; 持仓量的免死条款不随下限被覆盖而失效', () => {
    const band = { ...blank, dteBand: { min: 10, max: 20 } };
    expect(failedCriteria(band, leg({ dteDays: 10 }))).toEqual([]);
    expect(failedCriteria(band, leg({ dteDays: 9 }))).toEqual(['dteBand']);
    // 🚨 用户调的是「持仓多少算够」, 不是「要不要看新挂档」—— OI=0 但当日有成交仍进。
    const strictOi = { ...blank, openInterestMin: 9999 };
    expect(failedCriteria(strictOi, leg({ openInterest: 0, volume: 1 }))).toEqual([]);
    expect(failedCriteria(strictOi, leg({ openInterest: 0, volume: 0 }))).toEqual([
      'openInterestMin',
    ]);
  });

  it('🚨 返回的是集合不是布尔 —— 「只差这一条」与「差好几条」在计数上是两件事', () => {
    const strict = { ...blank, strikeMax: D('90'), openInterestMin: 9999, premiumMin: D('50') };
    expect(failedCriteria(strict, leg({ strike: D('100'), openInterest: 1, volume: 0 }))).toEqual([
      'strikeMax',
      'premiumMin',
      'openInterestMin',
    ]);
  });
});

describe('leg-recall.rules — 用户覆盖 + 三态 + 边际计数 (052 FR-012 / FR-029 / FR-030)', () => {
  /** 五条腿全在重叠区 DTE=35, 三道默认条件均宽松通过; K 递增到 120 (成色上界 114.4 之上)。 */
  const chainLegs = [
    { ...leg({ strike: D('90') }), code: 'K90' },
    { ...leg({ strike: D('95') }), code: 'K95' },
    { ...leg({ strike: D('100') }), code: 'K100' },
    { ...leg({ strike: D('105') }), code: 'K105' },
    // K=120: 成色上界 (110 × 1.04 = 114.4) 之上 ⇒ 默认下不进收租; 有效成本 118 > spot ⇒ 不进建仓。
    { ...leg({ strike: D('120') }), code: 'K120' },
  ];
  const run = (override: RetrievalOverride | null = null) =>
    recallCandidates(context, LEG_TABS, chainLegs, RECALL_CANDIDATE_CAP, override);
  const codesIn = (outcome: ReturnType<typeof run>, tab: LegTab) =>
    outcome.candidates.filter((c) => c.tabs.includes(tab)).map((c) => c.leg.code);

  it('未覆盖 ⇒ 六维全 default、计数全 0, 且候选集与不传 override 逐字相同', () => {
    const plain = run();
    const explicitEmpty = run({ perspective: 'rent', criteria: {} });
    expect(codesIn(explicitEmpty, 'rent')).toEqual(codesIn(plain, 'rent'));
    for (const tab of LEG_TABS) {
      for (const key of RETRIEVAL_CRITERION_KEYS) {
        expect(plain.criteriaByTab[tab].outcomes[key]).toEqual({
          state: 'default',
          excludedCount: 0,
        });
      }
      expect(plain.criteriaByTab[tab].effective).toEqual(plain.criteriaByTab[tab].defaults);
    }
  });

  it('🚨 覆盖只作用于请求的那一个视角 —— 另两个视角的成员集合与三态逐条不动', () => {
    const plain = run();
    const narrowed = run({ perspective: 'rent', criteria: { strikeMax: D('97') } });

    expect(codesIn(narrowed, 'rent')).toEqual(['K90', 'K95']);
    // 🚫 通吃三视角的实现会让下面两条翻 —— 而候选集照样出得来, 只是建仓视角凭空少了两条。
    expect(codesIn(narrowed, 'build')).toEqual(codesIn(plain, 'build'));
    expect(codesIn(narrowed, 'all')).toEqual(codesIn(plain, 'all'));
    expect(narrowed.criteriaByTab.build.outcomes.strikeMax.state).toBe('default');
    expect(narrowed.criteriaByTab.all.outcomes.strikeMax.state).toBe('default');
    expect(narrowed.criteriaByTab.build.effective).toEqual(narrowed.criteriaByTab.build.defaults);
  });

  it('收窄 ⇒ narrowed + 计数 = 「把这一维换回默认值能多看到几条」(FR-030 的边际口径)', () => {
    const outcome = run({ perspective: 'rent', criteria: { strikeMax: D('97') } });
    // 默认下进收租的是 K90/K95/K100/K105 四条 (K120 被成色上界挡下) ⇒ 收到 97 多排除 2 条。
    expect(outcome.criteriaByTab.rent.outcomes.strikeMax).toEqual({
      state: 'narrowed',
      excludedCount: 2,
    });
    expect(outcome.criteriaByTab.rent.effective.strikeMax?.equals(D('97'))).toBe(true);
  });

  it('放宽 ⇒ widened + 计数 0, 且候选集变大 (FR-026: 排名基准随之变, 定义如此)', () => {
    const plain = run();
    const widened = run({ perspective: 'rent', criteria: { strikeMax: null } });
    expect(codesIn(plain, 'rent')).not.toContain('K120');
    expect(codesIn(widened, 'rent')).toContain('K120');
    expect(widened.criteriaByTab.rent.outcomes.strikeMax).toEqual({
      state: 'widened',
      excludedCount: 0,
    });
  });

  it('🚨 显式 null 是「覆盖为不限」, 缺键才是「没动过」—— 两者三态不同', () => {
    expect(
      run({ perspective: 'rent', criteria: { strikeMax: null } }).criteriaByTab.rent.outcomes
        .strikeMax.state,
    ).toBe('widened');
    expect(
      run({ perspective: 'rent', criteria: {} }).criteriaByTab.rent.outcomes.strikeMax.state,
    ).toBe('default');
  });

  it('🚨 收窄但零排除 ⇒ 不出计数 (spec Edge Case: 收到仍在数据范围之外的值)', () => {
    // 113 比默认上界 114.4 严, 但唯一高于它的 K120 在**默认值下就已被挡下** ⇒ 边际排除 0。
    const outcome = run({ perspective: 'rent', criteria: { strikeMax: D('113') } });
    expect(outcome.criteriaByTab.rent.outcomes.strikeMax).toEqual({
      state: 'widened',
      excludedCount: 0,
    });
  });

  it('🚨 同时被两维挡下的腿, 两维都不计它 —— 「放宽这一条就能多看到它」对它不成立', () => {
    // 🚨 当日无成交才轮得到持仓量下限说话 —— 基线腿 `volume = 10` 会被免死条款救回,
    // 那时这条断言测的其实是「OI 维度压根没挡下任何腿」(起草时实撞, 计数恒 0)。
    const outcome = recallCandidates(
      context,
      LEG_TABS,
      chainLegs.map((l) => ({ ...l, volume: 0 })),
      RECALL_CANDIDATE_CAP,
      { perspective: 'rent', criteria: { strikeMax: D('97'), openInterestMin: 200 } },
    );
    // K90/K95: 只 OI 不过 ⇒ 计进 openInterestMin; K100/K105: 两维都不过 ⇒ 一维都不计。
    expect(outcome.criteriaByTab.rent.outcomes.openInterestMin.excludedCount).toBe(2);
    expect(outcome.criteriaByTab.rent.outcomes.strikeMax.excludedCount).toBe(0);
    expect(outcome.criteriaByTab.rent.outcomes.strikeMax.state).toBe('widened');
    expect(codesIn(outcome, 'rent')).toEqual([]);
  });

  it('🚨 硬门槛挡下的腿不计进任何维度 —— 换回默认值它照样进不来', () => {
    const outcome = run({ perspective: 'build', criteria: { dteBand: { min: 1, max: 20 } } });
    // 五条腿 DTE 全 35 ⇒ 全部被新段挡下, 但 K120 的有效成本 118 > spot 110 (硬门槛) ⇒ 只计 4 条。
    expect(outcome.criteriaByTab.build.outcomes.dteBand).toEqual({
      state: 'narrowed',
      excludedCount: 4,
    });
  });

  it('DTE 段一端收一端放照样给得出唯一的态 —— 判据是「是否产生排除」不是值比较', () => {
    const withLong = [...chainLegs, { ...leg({ dteDays: 200, strike: D('100') }), code: 'D200' }];
    const outcome = recallCandidates(
      context,
      LEG_TABS,
      withLong,
      RECALL_CANDIDATE_CAP,
      // 下界 30 → 1 是放宽, 上界 365 → 40 是收窄。
      { perspective: 'rent', criteria: { dteBand: { min: 1, max: 40 } } },
    );
    expect(outcome.criteriaByTab.rent.outcomes.dteBand).toEqual({
      state: 'narrowed',
      excludedCount: 1,
    });
  });

  it('🚨 放宽权利金下限后那条腿不再是「整条移出」—— 051 的排除数随之减 1', () => {
    const cheap = { ...leg({ strike: D('100'), bid: D('0.01'), ask: D('0.011') }), code: 'CHEAP' };
    const withCheap = [...chainLegs, cheap];
    const plain = recallCandidates(context, LEG_TABS, withCheap, RECALL_CANDIDATE_CAP);
    expect(plain.removedByPremiumFloor).toBe(1);

    const loosened = recallCandidates(context, LEG_TABS, withCheap, RECALL_CANDIDATE_CAP, {
      perspective: 'rent',
      criteria: { premiumMin: D('0.001') },
    });
    // 它进得了收租 ⇒ 不再是「三视角都看不见」⇒ 那个数不该再记它 (051 展示值的语义未变)。
    expect(loosened.removedByPremiumFloor).toBe(0);
    expect(loosened.candidates.map((c) => c.leg.code)).toContain('CHEAP');
    expect(loosened.criteriaByTab.rent.outcomes.premiumMin).toEqual({
      state: 'widened',
      excludedCount: 0,
    });
  });
});
