import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { computeLegRates } from './leg-derive.rules';
import {
  MARCH_EXCLUSION_CATEGORIES,
  MARCH_EXCLUSION_FAMILIES,
  MARCH_EXCLUSION_FAMILY_OF,
  buildFwdLadder,
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
          [30, '0.83'],
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
