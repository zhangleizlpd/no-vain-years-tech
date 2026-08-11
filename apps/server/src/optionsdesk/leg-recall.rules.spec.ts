import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  BUILD_RECALL_DTE,
  LIQUIDITY_MAX_RELATIVE_SPREAD,
  PREMIUM_FLOOR,
  RENT_RECALL_DTE,
  isExcludedFromIntentTabsByLiquidity,
  passesEffectiveCostGate,
  passesLiquidityGate,
  passesPremiumFloor,
  recallTabs,
  relativeSpread,
  type RecallContext,
  type RecallLegInput,
} from './leg-recall.rules';

const D = (v: string) => new Prisma.Decimal(v);

/** spot = 110 ⇒ 权利金门槛 = max(绝对下限, 110 × 比例)，两侧取值都由常量派生，不手抄。 */
const context: RecallContext = { spot: D('110') };

/** 基线腿: DTE=35 (重叠区)、有效成本 98 < spot、两道门槛均宽松通过。 */
const leg = (over: Partial<RecallLegInput> = {}): RecallLegInput => ({
  dteDays: 35,
  strike: D('100'),
  bid: D('2'),
  ask: D('2.1'),
  ...over,
});

describe('leg-recall.rules — 期限段召回 (FR-001 / FR-002 / FR-003)', () => {
  it('建仓段四个端点闭合: 1 与 49 在带内, 0 与 50 出局', () => {
    expect(recallTabs(context, leg({ dteDays: BUILD_RECALL_DTE.min }))).toContain('build');
    expect(recallTabs(context, leg({ dteDays: BUILD_RECALL_DTE.max }))).toContain('build');
    expect(recallTabs(context, leg({ dteDays: BUILD_RECALL_DTE.min - 1 }))).not.toContain('build');
    expect(recallTabs(context, leg({ dteDays: BUILD_RECALL_DTE.max + 1 }))).not.toContain('build');
  });

  it('收租段四个端点闭合: 30 与 365 在带内, 29 与 366 出局', () => {
    expect(recallTabs(context, leg({ dteDays: RENT_RECALL_DTE.min }))).toContain('rent');
    expect(recallTabs(context, leg({ dteDays: RENT_RECALL_DTE.max }))).toContain('rent');
    expect(recallTabs(context, leg({ dteDays: RENT_RECALL_DTE.min - 1 }))).not.toContain('rent');
    expect(recallTabs(context, leg({ dteDays: RENT_RECALL_DTE.max + 1 }))).not.toContain('rent');
  });

  it('重叠区 [30,49] 是设计意图不是重复 —— DTE=35 同时进两个意图 Tab', () => {
    expect(recallTabs(context, leg({ dteDays: 35 }))).toEqual(['all', 'build', 'rent']);
  });

  it('DTE=400 两个意图都不进, 但恒在全腿 Tab (FR-003: 全腿 Tab 不设期限段)', () => {
    expect(recallTabs(context, leg({ dteDays: 400 }))).toEqual(['all']);
  });

  it('全腿 Tab 恒在返回里 —— 「进不了意图 Tab」MUST NOT 变成「哪儿都看不见」', () => {
    expect(recallTabs(context, leg({ dteDays: 0, ask: null }))).toEqual(['all']);
  });
});

describe('leg-recall.rules — 有效成本硬判据 (FR-004, Guardrail 5)', () => {
  const effectiveCostOk = (l: RecallLegInput) =>
    passesEffectiveCostGate(context.spot, l.strike, l.bid);

  it('K − bid 恰好等于 spot ⇒ 不进建仓 (严格小于; 成本持平时用 put 代替直接买没有优势)', () => {
    const breakEven = leg({ dteDays: 20, strike: D('115'), bid: D('5'), ask: D('5.2') });
    expect(effectiveCostOk(breakEven)).toBe(false);
    expect(recallTabs(context, breakEven)).not.toContain('build');
  });

  it('K − bid 低于 spot 一分钱即进建仓', () => {
    const justUnder = leg({ dteDays: 20, strike: D('115'), bid: D('5.01'), ask: D('5.2') });
    expect(effectiveCostOk(justUnder)).toBe(true);
    expect(recallTabs(context, justUnder)).toContain('build');
  });

  it('🚨 收租 MUST NOT 受有效成本约束 —— 深虚腿有效成本远高于 spot 仍进收租', () => {
    const deepOtm = leg({ dteDays: 35, strike: D('200'), bid: D('1'), ask: D('1.1') });
    expect(effectiveCostOk(deepOtm)).toBe(false);
    expect(recallTabs(context, deepOtm)).toEqual(['all', 'rent']);
  });

  it('无 bid ⇒ 有效成本无定义 ⇒ 不进建仓 (MUST NOT 拿 K − 0 冒充)', () => {
    expect(effectiveCostOk(leg({ bid: null }))).toBe(false);
  });
});

describe('leg-recall.rules — 权利金绝对门槛 (FR-005)', () => {
  it('取绝对下限与 spot 比例的较大者, 两侧各自生效', () => {
    // 低价标的: 绝对下限占优。
    const cheap = D('10');
    expect(passesPremiumFloor(PREMIUM_FLOOR.absolute, cheap)).toBe(true);
    expect(passesPremiumFloor(PREMIUM_FLOOR.absolute.minus('0.01'), cheap)).toBe(false);

    // 高价标的: spot 比例占优 —— 造一个使比例项严格大于绝对下限的 spot。
    const rich = PREMIUM_FLOOR.absolute.div(PREMIUM_FLOOR.spotRatio).times(2);
    const ratioFloor = rich.times(PREMIUM_FLOOR.spotRatio);
    expect(ratioFloor.greaterThan(PREMIUM_FLOOR.absolute)).toBe(true);
    expect(passesPremiumFloor(ratioFloor, rich)).toBe(true);
    expect(passesPremiumFloor(ratioFloor.minus('0.01'), rich)).toBe(false);
  });

  it('🚫 无 bid 判 false, MUST NOT 当 0 —— 「不知道」与「知道且很低」处置同归但实现不同', () => {
    expect(passesPremiumFloor(null, context.spot)).toBe(false);
    // 判 false 的路径与「bid = 0」不共用: 0 是一个真实报价, null 是缺报价。
    expect(passesPremiumFloor(D('0'), context.spot)).toBe(false);
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
    expect(passesLiquidityGate(bid, askAtBound)).toBe(true);
    expect(passesLiquidityGate(bid, askAtBound.plus('0.02'))).toBe(false);
  });

  it('🚨 无 ask ⇒ fail-closed (不进意图 Tab), 但腿仍在全腿 Tab 可见', () => {
    expect(passesLiquidityGate(D('2'), null)).toBe(false);
    expect(recallTabs(context, leg({ ask: null }))).toEqual(['all']);
  });

  it('无 bid ⇒ 同样算不出价差 ⇒ fail-closed', () => {
    expect(passesLiquidityGate(null, D('2'))).toBe(false);
    expect(recallTabs(context, leg({ bid: null }))).toEqual(['all']);
  });
});

describe('leg-recall.rules — excludedFromIntentTabs 的判据 (FR-008)', () => {
  it('只数「本来进得去、被流动性门槛挡下」的腿', () => {
    const wide = leg({ dteDays: 35, ask: D('20') });
    expect(recallTabs(context, wide)).toEqual(['all']);
    expect(isExcludedFromIntentTabsByLiquidity(context, wide)).toBe(true);
  });

  it('🚫 期限段本就不合格的腿 MUST NOT 计入 —— 它不是被流动性门槛挡下的', () => {
    expect(isExcludedFromIntentTabsByLiquidity(context, leg({ dteDays: 400, ask: D('20') }))).toBe(
      false,
    );
  });

  it('通过流动性门槛的腿恒不计入', () => {
    expect(isExcludedFromIntentTabsByLiquidity(context, leg())).toBe(false);
  });
});

describe('leg-recall.rules — Δ 已降级为标 (FR-009)', () => {
  it('🚨 召回入参里没有 |Δ| —— 这是结构保证不是事后约定 (类型层证明)', () => {
    // @ts-expect-error `absDelta` MUST NOT 出现在召回入参里: 拿不到这个量就不可能拿它做召回
    // 判据。想把 Δ 塞回召回就必须先改签名 —— 那一步 review 看得见。若本行不再报错, 说明
    // 签名已被加回 Δ, 此时 `@ts-expect-error` 变成「未使用的抑制」而 typecheck 立刻红。
    const withDelta: RecallLegInput = { ...leg(), absDelta: 0.45 };
    expect(recallTabs(context, withDelta)).toEqual(['all', 'build', 'rent']);
  });

  it('greeks 缺失的腿照常进意图召回集 —— 与 047 相反', () => {
    // greeks 缺失在本层完全不可表达 (没有承载它的入参), 故「照常进」是构造上的必然。
    expect(recallTabs(context, leg({ dteDays: 20 }))).toContain('build');
  });
});
