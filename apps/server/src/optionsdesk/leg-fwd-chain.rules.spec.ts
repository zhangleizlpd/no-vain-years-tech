import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { computeLegRates } from './leg-derive.rules';
import {
  MARCH_EXCLUSION_CATEGORIES,
  MARCH_EXCLUSION_FAMILIES,
  MARCH_EXCLUSION_FAMILY_OF,
  buildFwdLadder,
  convexCleanLadder,
  inferLadderTick,
  mergeCollinearNodes,
  type FwdLadderLeg,
} from './leg-fwd-chain.rules';

const D = (v: string | number) => new Prisma.Decimal(v);

/** 基线档: 报价齐全、费率可算。 */
const rung = (dteDays: number, bid: string, over: Partial<FwdLadderLeg> = {}): FwdLadderLeg => ({
  dteDays,
  bid: D(bid),
  ask: D(bid).plus('0.10'),
  openInterest: 100,
  ...over,
});

describe('leg-fwd-chain.rules — fwd 链构造 (T002, FR-005)', () => {
  it('① 恒等式性质: 年化₂ = [T₁·年化₁ + (T₂−T₁)·fwd]/T₂ —— 三组构造梯逐邻档验证', () => {
    const ladders: { strike: string; legs: [number, string][] }[] = [
      {
        strike: '100',
        legs: [
          [35, '1.87'],
          [63, '2.94'],
          [98, '4.10'],
          [182, '6.55'],
        ],
      },
      {
        strike: '52.5',
        legs: [
          [30, '0.93'],
          [91, '1.92'],
          [152, '2.71'],
        ],
      },
      {
        strike: '210',
        legs: [
          [44, '7.35'],
          [72, '9.80'],
          [135, '14.25'],
          [260, '21.60'],
          [365, '27.90'],
        ],
      },
    ];
    for (const ladder of ladders) {
      const { nodes, rungs } = buildFwdLadder(
        D(ladder.strike),
        ladder.legs.map(([d, b]) => rung(d, b)),
      );
      expect(nodes).toHaveLength(ladder.legs.length);
      expect(rungs).toHaveLength(ladder.legs.length - 1);
      for (const r of rungs) {
        const shorter = nodes.find((n) => n.dteDays === r.fromDteDays)!;
        const longer = nodes.find((n) => n.dteDays === r.toDteDays)!;
        const reconstructed = shorter.annualized
          .times(shorter.dteDays)
          .plus(r.fwd.times(longer.dteDays - shorter.dteDays))
          .div(longer.dteDays);
        expect(reconstructed.minus(longer.annualized).abs().toNumber()).toBeLessThan(1e-12);
        // 年化本身与 computeLegRates 单点逐值一致 (费率零第二份)
        const canonical = computeLegRates({
          strike: D(ladder.strike),
          premium: longer.bid,
          dteDays: longer.dteDays,
        })!;
        expect(longer.annualized.equals(canonical.annualizedRate)).toBe(true);
      }
    }
  });

  it('② 单档梯退化: 无相邻档 ⇒ rungs 空链非异常, 该档自身仍成节点 (年化经单点)', () => {
    const { nodes, rungs, audits } = buildFwdLadder(D('100'), [rung(45, '2.30')]);
    expect(rungs).toEqual([]);
    expect(audits).toEqual([]);
    expect(nodes).toHaveLength(1);
    const canonical = computeLegRates({ strike: D('100'), premium: D('2.30'), dteDays: 45 })!;
    expect(nodes[0].annualized.equals(canonical.annualizedRate)).toBe(true);
    expect(nodes[0].dteDays).toBe(45);
  });

  it('③ 权利金缺失 / K−P ≤ 0 ⇒ #13 条目 + 不进链, 非伪造 0', () => {
    const missing = rung(35, '1', { bid: null });
    const swallowed = rung(182, '120'); // bid 120 > K 100 ⇒ 准备金 K−P ≤ 0, 费率无定义
    const ok = rung(63, '2.94');
    const { nodes, rungs, audits } = buildFwdLadder(D('100'), [missing, swallowed, ok]);
    expect(nodes.map((n) => n.dteDays)).toEqual([63]);
    expect(rungs).toEqual([]);
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.category)).toEqual(['quote_missing', 'quote_missing']);
    expect(audits.map((a) => a.dteDays)).toEqual([35, 182]);
    // 证据: 缺失侧 null 本身即证据, 有值侧原样留痕; 全链无任何 0 费率伪造
    expect(audits[0].evidence.bid).toBeNull();
    expect(audits[1].evidence.bid?.equals(D('120'))).toBe(true);
    expect(nodes.some((n) => n.annualized.isZero())).toBe(false);
  });

  it('④ 枚举恰 13 成员四家族 (运行时半; 编译期半 = FAMILY_OF Record 穷举)', () => {
    expect(MARCH_EXCLUSION_CATEGORIES).toHaveLength(13);
    expect(MARCH_EXCLUSION_FAMILIES).toHaveLength(4);
    const byFamily = new Map<string, number>();
    for (const category of MARCH_EXCLUSION_CATEGORIES) {
      const family = MARCH_EXCLUSION_FAMILY_OF[category];
      byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
    }
    // clarify 定稿: A 清链 4 / B 行军 5 / C 可成交 2 / D 呈现-召回边界 2
    expect(byFamily.get('chain_clean')).toBe(4);
    expect(byFamily.get('march')).toBe(5);
    expect(byFamily.get('tradability')).toBe(2);
    expect(byFamily.get('boundary')).toBe(2);
  });
});

describe('leg-fwd-chain.rules — 凸包剔劣 + 劣档三类标 (T003, FR-002 / FR-004)', () => {
  /** 构造入口: 经 buildFwdLadder 组梯再清 (与生产同管道, 不手搓节点)。 */
  const clean = (strike: string, legs: [number, string][]) =>
    convexCleanLadder(
      buildFwdLadder(
        D(strike),
        legs.map(([d, b]) => rung(d, b)),
      ).nodes,
    );

  /** 深级联构造 (cum 目标 30/45/55/63/200 rate-days): 弹 120 后 90/60/30 逐层仍劣, 级联 4 层。 */
  const DEEP_CASCADE: [number, string][] = [
    [30, '7.59'],
    [60, '10.98'],
    [90, '13.10'],
    [120, '14.72'],
    [150, '35.40'],
  ];

  const fwdsOf = (chain: readonly { fwd: Prisma.Decimal }[]) => chain.map((n) => n.fwd);

  const strictlyDecreasing = (values: readonly Prisma.Decimal[]) =>
    values.every((v, i) => i === 0 || values[i - 1].greaterThan(v));

  it('① 深级联弹出至终态 fwd 单调递减 —— 弹 X 后前档仍劣的输入逐层级联', () => {
    const { chain, audits } = clean('100', DEEP_CASCADE);
    // 4 层级联全弹, 仅链尾幸存 (原点入锚 ⇒ 链头 30d 同样可弹)
    expect(chain.map((n) => n.dteDays)).toEqual([150]);
    expect(audits.map((a) => a.dteDays)).toEqual([30, 60, 90, 120]);
    expect(audits.every((a) => a.category === 'concave_dominated')).toBe(true);
    // 弹出证据 = 两个 fwd 对比值, 且方向正确 (进 < 出)
    for (const a of audits) {
      expect(a.evidence.fwd).not.toBeNull();
      expect(a.evidence.fwdOut).not.toBeNull();
      expect(a.evidence.fwd!.lessThan(a.evidence.fwdOut!)).toBe(true);
    }
    // 混合梯 (部分弹出) 终态仍严格单调递减
    const mixed = clean('100', [
      [30, '2.00'],
      [60, '2.20'],
      [90, '3.80'],
      [180, '4.90'],
    ]);
    expect(mixed.chain.length).toBeGreaterThanOrEqual(2);
    expect(strictlyDecreasing(fwdsOf(mixed.chain))).toBe(true);
  });

  it('② while 级联的必要性 —— 同一深级联输入, 单步弹出 (if) 会留下非单调链 (变异必红臂)', () => {
    const { chain } = clean('100', DEEP_CASCADE);
    expect(strictlyDecreasing(fwdsOf(chain))).toBe(true);
    // 终态链头 fwd = 自原点斜率 = 该档年化 (原点锚不变量)
    expect(chain[0].fwd.equals(chain[0].annualized)).toBe(true);
  });

  it('③ 绝对支配标 #3 附权利金对比值, 且不从输出消失 (弹出与在链两形态)', () => {
    // 形态 A: 中段支配档被凸包弹出 ⇒ 类目取 #3 (优先于 #2), 证据 = 权利金对比
    const popped = clean('100', [
      [30, '1.35'],
      [90, '1.19'],
      [150, '2.80'],
    ]);
    expect(popped.chain.map((n) => n.dteDays)).toEqual([30, 150]);
    expect(popped.audits).toHaveLength(1);
    expect(popped.audits[0].category).toBe('absolute_dominated');
    expect(popped.audits[0].dteDays).toBe(90);
    expect(popped.audits[0].evidence.premium?.equals(D('1.19'))).toBe(true);
    expect(popped.audits[0].evidence.premiumShorter?.equals(D('1.35'))).toBe(true);
    // 形态 B: 链尾支配档无「出」不可弹 ⇒ 留在净链 (只标不删), 同样恰一条 #3
    const tail = clean('100', [
      [30, '1.35'],
      [90, '1.19'],
    ]);
    expect(tail.chain.map((n) => n.dteDays)).toEqual([30, 90]);
    expect(tail.chain[1].fwd.isNegative()).toBe(true);
    expect(tail.audits).toHaveLength(1);
    expect(tail.audits[0].category).toBe('absolute_dominated');
    expect(tail.audits[0].dteDays).toBe(90);
  });

  it('④ 全档合格输入零弹出零标 (护航臂) —— 凹形 cum 曲线原样保留, fwd 与组梯 rungs 逐值同源', () => {
    const legs: [number, string][] = [
      [30, '2.00'],
      [90, '3.554'],
      [180, '4.687'],
    ];
    const built = buildFwdLadder(
      D('100'),
      legs.map(([d, b]) => rung(d, b)),
    );
    const { chain, audits } = convexCleanLadder(built.nodes);
    expect(audits).toEqual([]);
    expect(chain.map((n) => n.dteDays)).toEqual([30, 90, 180]);
    expect(strictlyDecreasing(fwdsOf(chain))).toBe(true);
    // 零弹出 ⇒ 非链头档的 fwd 与 T002 邻档 rungs 逐值相同 (同一斜率定义, 无重算)
    expect(chain[1].fwd.equals(built.rungs[0].fwd)).toBe(true);
    expect(chain[2].fwd.equals(built.rungs[1].fwd)).toBe(true);
    expect(chain[0].fwd.equals(chain[0].annualized)).toBe(true);
    // 单元素 memberDteDays (T004 合并前不变量)
    expect(
      chain.every((n) => n.memberDteDays.length === 1 && n.memberDteDays[0] === n.dteDays),
    ).toBe(true);
  });
});

describe('leg-fwd-chain.rules — tick 推断 + 共线合并 (T004, FR-003)', () => {
  const legsOf = (pairs: [number, string][], over: Partial<FwdLadderLeg> = {}) =>
    pairs.map(([d, b]) => rung(d, b, over));

  /** 由目标 cum (费率·天) 反解 bid: P = K·c/(365+c) ⇒ periodRate×365 恰为 c —— 曲线形状可控。 */
  const bidForCum = (cum: string) => D('100').times(cum).div(D('365').plus(cum));

  const ladderFromCums = (pairs: [number, string][]): FwdLadderLeg[] =>
    pairs.map(([d, c]) => ({ dteDays: d, bid: bidForCum(c), ask: null, openInterest: 100 }));

  const hullChain = (strike: string, pairs: [number, string][]) =>
    convexCleanLadder(buildFwdLadder(D(strike), legsOf(pairs)).nodes).chain;

  it('① 垂距恰低于阈值 ⇒ 除名并段, 合并 fwd = 子段时间加权平均 (手算对照)', () => {
    // B(60d) 落 A(30d)—C(90d) 弦上方 +0.002 rate-days (凹形微凸: 凸包保留, 偏差远低于 1 tick)
    const built = buildFwdLadder(
      D('100'),
      ladderFromCums([
        [30, '7.5'],
        [60, '11.402'],
        [90, '15.3'],
      ]),
    );
    const { chain, audits } = mergeCollinearNodes(
      D('100'),
      convexCleanLadder(built.nodes).chain,
      D('0.05'),
    );
    expect(chain.map((n) => n.dteDays)).toEqual([30, 90]);
    expect(chain[1].memberDteDays).toEqual([60, 90]);
    // 合并值 = 子段时间加权: (fwd_AB×30 + fwd_BC×30) / 60, 与终态段 fwd 逐值一致
    const weighted = built.rungs[0].fwd.times(30).plus(built.rungs[1].fwd.times(30)).div(60);
    expect(chain[1].fwd.minus(weighted).abs().toNumber()).toBeLessThan(1e-12);
    expect(audits).toHaveLength(1);
    expect(audits[0].category).toBe('collinear_merged');
    expect(audits[0].dteDays).toBe(60);
    expect(audits[0].mergedIntoDteDays).toBe(90);
    expect(audits[0].evidence.chordDistanceTicks!.lessThan(D('1'))).toBe(true);
  });

  it('② 垂距不低于阈值 ⇒ 禁合并 (伪装混合否决: 30d@20% + 150d@8% 不得调和出单段 10%)', () => {
    // cum: 30d → 6 (头段 20%), 180d → 18 (后 150 天 @8%); 头档对 原点—180d 弦的偏差是真信号
    const chain = hullChain('100', [
      [30, '1.617'],
      [180, '4.70'],
    ]);
    const { chain: merged, audits } = mergeCollinearNodes(D('100'), chain, D('0.10'));
    expect(audits).toEqual([]);
    expect(merged.map((n) => n.dteDays)).toEqual([30, 180]);
    // 未被调和: 头段仍 ~20%, 后段仍 ~8%, 不存在 ~10% 的单一混合段
    expect(merged[0].fwd.toNumber()).toBeCloseTo(0.2, 2);
    expect(merged[1].fwd.toNumber()).toBeCloseTo(0.08, 2);
  });

  it('③ 连续 ≥ 3 节点共线 ⇒ 跨段吸收传递, 终值与除名次序无关 (= 整段直接差商)', () => {
    // 60/90/120d 沿 30d—150d 直线 (斜率 0.12) 上方 +3/4/3 毫 rate-days 的凹形微凸 ——
    // 凸包全保留 (斜率仍严格递减), 而三点对各自局部弦的偏差全部低于 1 tick
    const built = buildFwdLadder(
      D('100'),
      ladderFromCums([
        [30, '7.5'],
        [60, '11.103'],
        [90, '14.704'],
        [120, '18.303'],
        [150, '21.9'],
      ]),
    );
    const { chain, audits } = mergeCollinearNodes(
      D('100'),
      convexCleanLadder(built.nodes).chain,
      D('0.05'),
    );
    expect(chain.map((n) => n.dteDays)).toEqual([30, 150]);
    expect(chain[1].memberDteDays).toEqual([60, 90, 120, 150]);
    // 次序无关的机器形态: 终值 = 整段一步差商 (加权平均可结合 ⇒ 任何除名次序同值)
    const direct = chain[1].cumRateDays.minus(chain[0].cumRateDays).div(120);
    expect(chain[1].fwd.minus(direct).abs().toNumber()).toBeLessThan(1e-12);
    expect(audits.map((a) => a.dteDays)).toEqual([60, 90, 120]);
    expect(
      audits.every((a) => a.category === 'collinear_merged' && a.mergedIntoDteDays === 150),
    ).toBe(true);
  });

  it('④ tick 推断: 混合 0.05/0.10 报价梯 ⇒ 公约粒度 0.05', () => {
    const tick = inferLadderTick(
      legsOf([
        [30, '1.85'],
        [60, '2.40'],
        [90, '3.10'],
      ]),
    );
    expect(tick.equals(D('0.05'))).toBe(true);
  });

  it('⑤ tick 不可推断 ⇒ 标准档兜底; 疏网格高估 ⇒ 钳回标准档 (高估方向 = 过度合并, 两跑对照钉死)', () => {
    // (a) 不可推断: 单一报价按 $3 分界取标准档; 全无报价取最细档
    expect(inferLadderTick([rung(30, '2.50', { ask: null })]).equals(D('0.05'))).toBe(true);
    expect(inferLadderTick([rung(30, '4.40', { ask: null })]).equals(D('0.10'))).toBe(true);
    expect(inferLadderTick([rung(30, '1', { bid: null, ask: null })]).equals(D('0.05'))).toBe(true);
    // (b) 疏网格推出 1.00 (证据不足的高估) ⇒ 钳回标准档 0.10
    const sparse = inferLadderTick([
      rung(30, '3.20', { ask: null }),
      rung(90, '4.20', { ask: null }),
    ]);
    expect(sparse.equals(D('0.10'))).toBe(true);
    // (c) 敏感方向: 同一构造 (B 偏离弦 ~5e-3 rate) 在 tick=1.00 下会被并段、0.10 下不会 ——
    //     tick 高估 ⇒ 阈值放大 ⇒ 多合并, 这正是钳住的理由 (plan §D1 括注方向勘误的机器留档)
    const midOff = convexCleanLadder(
      buildFwdLadder(
        D('100'),
        ladderFromCums([
          [30, '7.5'],
          [60, '13.2'],
          [90, '15.3'],
        ]),
      ).nodes,
    ).chain;
    const coarse = mergeCollinearNodes(D('100'), midOff, D('1.00'));
    const fine = mergeCollinearNodes(D('100'), midOff, D('0.10'));
    expect(coarse.chain.some((n) => n.dteDays === 60)).toBe(false);
    expect(coarse.audits.some((a) => a.category === 'collinear_merged' && a.dteDays === 60)).toBe(
      true,
    );
    expect(fine.chain.map((n) => n.dteDays)).toEqual([30, 60, 90]);
    expect(fine.audits).toEqual([]);
  });
});
