import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  buildFwdLadder,
  cleanFwdChain,
  convexCleanLadder,
  type FwdLadderLeg,
  type NetChainNode,
} from './leg-fwd-chain.rules';
import {
  MARCH_DECAY_ABSOLUTE_CAP_GAMMA,
  MARCH_DECAY_REBOUND_BETA,
  MARCH_MODES,
  MARCH_VERDICTS,
  RENT_MARCH_OI_MIN,
  marchSelect,
  resolveMarchPhi,
  resolveMarchParams,
  type MarchParams,
} from './leg-march.rules';
import { TIER_FLOORS_BY_BASIS } from './leg-tier.rules';

const D = (v: string | number) => new Prisma.Decimal(v);

/** 手搓净链节点 —— 行军只读 dte/fwd/年化/OI/成员, 其余字段给中性默认。 */
const node = (dteDays: number, fwd: string, over: Partial<NetChainNode> = {}): NetChainNode => ({
  dteDays,
  memberDteDays: [dteDays],
  memberOpenInterest: [over.openInterest !== undefined ? over.openInterest : 100],
  bid: D('2'),
  ask: null,
  openInterest: 100,
  cumRateDays: D('0'),
  annualized: D('0.18'),
  fwd: D(fwd),
  ...over,
});

const params = (over: Partial<MarchParams> = {}): MarchParams => ({
  ...resolveMarchParams('good', 'phi'),
  ...over,
});

/** FR-014 的臂内小核对: 每个非推荐档恰一条审计。 */
const auditedOnce = (chain: readonly NetChainNode[], decision: ReturnType<typeof marchSelect>) => {
  for (const n of chain) {
    const entries = decision.audits.filter((a) => a.dteDays === n.dteDays);
    expect(entries).toHaveLength(n.dteDays === decision.recommendedDteDays ? 0 : 1);
  }
};

describe('leg-march.rules — 行军 + 停点闸 + 三态判决 (T005, FR-006..FR-012)', () => {
  it('φ/β/γ/OI_MIN 引用与单点: φ = 档界引用非新造值; 模式与判决枚举形状', () => {
    expect(resolveMarchPhi('good').equals(TIER_FLOORS_BY_BASIS.annualized[0].floor)).toBe(true);
    expect(resolveMarchPhi('acceptable').equals(TIER_FLOORS_BY_BASIS.annualized[1].floor)).toBe(
      true,
    );
    expect(MARCH_MODES).toEqual(['phi', 'theta']);
    expect(MARCH_VERDICTS).toEqual(['recommended', 'no_qualified', 'untradable']);
    const p = resolveMarchParams('good', 'phi');
    expect(p.beta.equals(MARCH_DECAY_REBOUND_BETA)).toBe(true);
    expect(p.gamma.equals(MARCH_DECAY_ABSOLUTE_CAP_GAMMA)).toBe(true);
    expect(p.oiMin).toBe(RENT_MARCH_OI_MIN);
  });

  it('① 主路: 推荐档 = 前向路径每天 ≥ φ 的最长档; 每个非推荐档恰一条审计', () => {
    const chain = [node(30, '0.25'), node(60, '0.18'), node(90, '0.16'), node(120, '0.08')];
    const decision = marchSelect(chain, params());
    expect(decision.verdict).toBe('recommended');
    expect(decision.recommendedDteDays).toBe(90);
    auditedOnce(chain, decision);
    const byDte = new Map(decision.audits.map((a) => [a.dteDays, a]));
    expect(byDte.get(30)?.category).toBe('qualified_not_stop');
    expect(byDte.get(30)?.evidence.recommendedDteDays).toBe(90);
    expect(byDte.get(120)?.category).toBe('fwd_below_phi');
    expect(byDte.get(120)?.evidence.fwd?.equals(D('0.08'))).toBe(true);
    expect(byDte.get(120)?.evidence.phi?.equals(resolveMarchPhi('good'))).toBe(true);
  });

  it('② 形状违规停 (衰减回升超 β×前段) ⇒ 截链尾, 停点前一档胜出', () => {
    // δ₁ = 0.01/30, δ₂ = 0.07/30 > β × δ₁ ⇒ 在 90d 处停
    const chain = [node(30, '0.30'), node(60, '0.29'), node(90, '0.22')];
    const decision = marchSelect(chain, params());
    expect(decision.verdict).toBe('recommended');
    expect(decision.recommendedDteDays).toBe(60);
    const violator = decision.audits.find((a) => a.dteDays === 90);
    expect(violator?.category).toBe('decay_rebound_above_beta');
    expect(violator?.evidence.decay).not.toBeNull();
    expect(violator?.evidence.decayCap).not.toBeNull();
    expect(violator!.evidence.decay!.greaterThan(violator!.evidence.decayCap!)).toBe(true);
  });

  it('③ γ 退化分支: 前段衰减 ≤ 0 时不因负/零基准中断, 改判绝对帽', () => {
    // 零基准两段 → γ 帽放行 → 第三段 δ 超 γ ⇒ #7 停 (取 acceptable 档界让 γ 先于水平线触发)
    const capped = marchSelect(
      [node(30, '0.20'), node(60, '0.20'), node(90, '0.20'), node(120, '0.13')],
      params({ phi: resolveMarchPhi('acceptable') }),
    );
    expect(capped.verdict).toBe('recommended');
    expect(capped.recommendedDteDays).toBe(90);
    expect(capped.audits.find((a) => a.dteDays === 120)?.category).toBe('decay_above_gamma_cap');
    // 负基准 (fwd 回升) → γ 帽放行到链尾, 不抛不断
    const negative = marchSelect([node(30, '0.18'), node(60, '0.20'), node(90, '0.199')], params());
    expect(negative.verdict).toBe('recommended');
    expect(negative.recommendedDteDays).toBe(90);
  });

  it('④ 停点 OI < OI_MIN ⇒ 沿净链回退最近过闸合格档, 弃档记 #10', () => {
    const chain = [node(30, '0.25'), node(60, '0.18'), node(90, '0.16', { openInterest: 3 })];
    const decision = marchSelect(chain, params());
    expect(decision.verdict).toBe('recommended');
    expect(decision.recommendedDteDays).toBe(60);
    const dropped = decision.audits.find((a) => a.dteDays === 90);
    expect(dropped?.category).toBe('stop_oi_below_min');
    expect(dropped?.evidence.oi).toBe(3);
    expect(dropped?.evidence.oiMin).toBe(RENT_MARCH_OI_MIN);
    expect(decision.audits.find((a) => a.dteDays === 30)?.category).toBe('qualified_not_stop');
  });

  it('⑤ 回退穿已合并段: 合并段作单节点一步落到段尾', () => {
    const chain = [
      node(30, '0.25'),
      node(90, '0.18', { memberDteDays: [60, 90], memberOpenInterest: [100, 100] }),
      node(120, '0.16', { openInterest: 3 }),
    ];
    const decision = marchSelect(chain, params());
    expect(decision.recommendedDteDays).toBe(90);
    expect(decision.audits.find((a) => a.dteDays === 120)?.category).toBe('stop_oi_below_min');
    // 合并段内档 (60) 不产生任何行军条目 —— 段整体过闸, 不拆开逐档判
    expect(decision.audits.some((a) => a.dteDays === 60)).toBe(false);
  });

  it('⑤b 合并段段内回退: 段尾成员不过闸 ⇒ 落段内更短过闸成员 (共线等值; T011 GDDY 实抓回归)', () => {
    const chain = [
      node(175, '0.178', {
        memberDteDays: [140, 175],
        memberOpenInterest: [192, 1],
        annualized: D('0.178'),
      }),
    ];
    const decision = marchSelect(chain, params());
    expect(decision.verdict).toBe('recommended');
    expect(decision.recommendedDteDays).toBe(140);
    const tail = decision.audits.find((a) => a.dteDays === 175);
    expect(tail?.category).toBe('stop_oi_below_min');
    expect(tail?.evidence.oi).toBe(1);
    // 段内全员不过闸 ⇒ 逐成员 #11
    const allFail = marchSelect(
      [node(175, '0.178', { memberDteDays: [140, 175], memberOpenInterest: [2, 1] })],
      params(),
    );
    expect(allFail.verdict).toBe('untradable');
    expect(allFail.audits.map((a) => [a.dteDays, a.category])).toEqual([
      [140, 'ladder_oi_all_below_min'],
      [175, 'ladder_oi_all_below_min'],
    ]);
  });

  it('⑥ 整梯无过闸 ⇒ untradable, 合格档逐条 #11 (含 OI=null 按没采到不过闸)', () => {
    const chain = [
      node(30, '0.25', { openInterest: 3 }),
      node(60, '0.20', { openInterest: 0 }),
      node(90, '0.18', { openInterest: null }),
    ];
    const decision = marchSelect(chain, params());
    expect(decision.verdict).toBe('untradable');
    expect(decision.recommendedDteDays).toBeNull();
    expect(decision.audits.map((a) => a.category)).toEqual([
      'ladder_oi_all_below_min',
      'ladder_oi_all_below_min',
      'ladder_oi_all_below_min',
    ]);
    expect(decision.audits.find((a) => a.dteDays === 90)?.evidence.oi).toBeNull();
  });

  it('⑦ 链头 fwd < φ ⇒ 无合格档; 行军起点不设 OI 闸 (短端 thin 不误杀)', () => {
    // 前半: 链头即违规 → no_qualified, OI 再好也救不了
    const headFail = marchSelect([node(30, '0.10'), node(60, '0.09')], params());
    expect(headFail.verdict).toBe('no_qualified');
    expect(headFail.recommendedDteDays).toBeNull();
    expect(headFail.audits.map((a) => a.category)).toEqual(['fwd_below_phi', 'fwd_below_phi']);
    // 后半: 起点 thin (OI=0) 但中段合格 → 行军穿过起点, 停点在后面, 不误杀整梯
    const thinHead = marchSelect(
      [node(30, '0.30', { openInterest: 0 }), node(60, '0.20')],
      params(),
    );
    expect(thinHead.verdict).toBe('recommended');
    expect(thinHead.recommendedDteDays).toBe(60);
  });

  it('⑧ 全程合格 ⇒ 推荐链尾档 (胜者定义的边界分支)', () => {
    const decision = marchSelect([node(30, '0.30'), node(60, '0.22'), node(90, '0.19')], params());
    expect(decision.verdict).toBe('recommended');
    expect(decision.recommendedDteDays).toBe(90);
    expect(decision.audits.map((a) => a.category)).toEqual([
      'qualified_not_stop',
      'qualified_not_stop',
    ]);
  });

  it('⑨ 净链空 ⇒ 整梯无可成交 (FR-009 末句)', () => {
    const decision = marchSelect([], params());
    expect(decision.verdict).toBe('untradable');
    expect(decision.recommendedDteDays).toBeNull();
    expect(decision.audits).toEqual([]);
  });

  it('⑩ 两模式预言机各三行: φ 模式逐值 / θ 模式 ≡ 年化 argmax', () => {
    // φ 模式三例 (①③⑧ 之外再钉三条独立构造)
    const phiRows: { chain: NetChainNode[]; verdict: string; dte: number | null }[] = [
      {
        chain: [node(30, '0.25'), node(60, '0.18'), node(90, '0.16'), node(150, '0.05')],
        verdict: 'recommended',
        dte: 90,
      },
      { chain: [node(30, '0.14'), node(60, '0.13')], verdict: 'no_qualified', dte: null },
      {
        chain: [node(30, '0.30'), node(60, '0.22'), node(90, '0.19'), node(120, '0.17')],
        verdict: 'recommended',
        dte: 120,
      },
    ];
    for (const row of phiRows) {
      const decision = marchSelect(row.chain, params());
      expect(decision.verdict).toBe(row.verdict);
      expect(decision.recommendedDteDays).toBe(row.dte);
    }
    // θ 模式三例: 判决 ≡ 年化 argmax (恒等式, fwd 值蓄意与年化脱钩)
    const thetaChains: NetChainNode[][] = [
      [
        node(30, '0.05', { annualized: D('0.16') }),
        node(60, '0.05', { annualized: D('0.22') }),
        node(90, '0.05', { annualized: D('0.19') }),
      ],
      [
        node(30, '0.05', { annualized: D('0.18') }),
        node(60, '0.05', { annualized: D('0.17') }),
        node(90, '0.05', { annualized: D('0.21') }),
      ],
      [
        node(30, '0.05', { annualized: D('0.21') }),
        node(60, '0.05', { annualized: D('0.17') }),
        node(90, '0.05', { annualized: D('0.16') }),
      ],
    ];
    for (const chain of thetaChains) {
      const decision = marchSelect(chain, params({ mode: 'theta' }));
      const argmax = chain.reduce((best, n) =>
        n.annualized.greaterThan(best.annualized) ? n : best,
      );
      expect(decision.verdict).toBe('recommended');
      expect(decision.recommendedDteDays).toBe(argmax.dteDays);
      auditedOnce(chain, decision);
    }
  });

  it('⑪ 单档净链 ⇒ 行军退化为对该档直接判 φ + 停点闸 (三分支)', () => {
    const pass = marchSelect([node(45, '0.20', { annualized: D('0.20') })], params());
    expect(pass.verdict).toBe('recommended');
    expect(pass.recommendedDteDays).toBe(45);
    expect(pass.audits).toEqual([]);
    const belowPhi = marchSelect([node(45, '0.10', { annualized: D('0.10') })], params());
    expect(belowPhi.verdict).toBe('no_qualified');
    expect(belowPhi.audits[0]?.category).toBe('fwd_below_phi');
    const gated = marchSelect([node(45, '0.25', { openInterest: 2 })], params());
    expect(gated.verdict).toBe('untradable');
    expect(gated.audits[0]?.category).toBe('ladder_oi_all_below_min');
  });

  it('T004 联测: 共线并段开/关两跑, 行军停点不变 (合并无损性)', () => {
    // T004 臂③ 同款梯: 60/90/120d 沿直线微凸 —— 全档在 thin 档界之上, 行军应走到链尾
    const bidForCum = (cum: string) => D('100').times(cum).div(D('365').plus(cum));
    const legs: FwdLadderLeg[] = (
      [
        [30, '7.5'],
        [60, '11.103'],
        [90, '14.704'],
        [120, '18.303'],
        [150, '21.9'],
      ] as [number, string][]
    ).map(([d, c]) => ({ dteDays: d, bid: bidForCum(c), ask: null, openInterest: 100 }));
    const thin = params({ phi: resolveMarchPhi('thin') });
    const mergedRun = marchSelect(cleanFwdChain(D('100'), legs).chain, thin);
    const unmergedRun = marchSelect(
      convexCleanLadder(buildFwdLadder(D('100'), legs).nodes).chain,
      thin,
    );
    expect(mergedRun.verdict).toBe('recommended');
    expect(unmergedRun.verdict).toBe('recommended');
    expect(mergedRun.recommendedDteDays).toBe(150);
    expect(unmergedRun.recommendedDteDays).toBe(mergedRun.recommendedDteDays);
  });
});
