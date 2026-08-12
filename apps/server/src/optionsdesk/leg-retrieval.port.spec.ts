import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { FakeLegRetrievalAdapter, type FakeLegChain } from './fake-leg-retrieval.adapter';
import { BUILD_RECALL_DTE, RECALL_CANDIDATE_CAP, RENT_RECALL_DTE } from './leg-recall.rules';
import { LEG_TABS, type LegTab } from './leg-tab.rules';
import type { LegChainMeta, LegChainRow, LegRetrievalResult } from './leg-retrieval.port';

/**
 * 052 T001 —— 检索 port 的**假实现**驱动召回判据 (FR-032 / SC-009, plan D-PORT-1)。
 *
 * 🚨 **本文件零容器零真库**, 而它验的是真判据: 假实现与 Prisma 实现共用
 * `leg-recall.rules.ts` 的层入口, 于是这里绿 ⇒ 真实现的召回语义也绿 (差别只在数据从哪来)。
 * 这正是 ADR-0064 决策 4 给 port 写的存在理由 ——「跨 ctx 只读的显式接缝 + 可 mock」。
 *
 * 📌 **FR-031 的机器判据不在本文件**: 「接口零存储侧词汇」要读源码, 而 Small 档禁磁盘 I/O
 * (testing.md), 治理扫描一律归 `scripts/checks/` —— 落点是
 * `check-optionsdesk-rule-constants.ts` 不变量 #5 (同 045 把 `anchor.rules.spec.ts` 尾部两个
 * 源码扫描 `it()` 迁出去的先例)。
 */

const D = (v: string) => new Prisma.Decimal(v);
/** spot = 110 ⇒ 权利金门槛 = max(绝对下限, 110 × 比例); 判据取值一律从常量派生, 不手抄。 */
const SPOT = D('110');
const SYMBOL = 'us:PEP';

const chainMeta: LegChainMeta = {
  marketDate: '2026-08-04',
  sessionDate: new Date('2026-08-03T00:00:00.000Z'),
  quoteAsOf: new Date('2026-08-03T20:15:00.000Z'),
  oiAsOf: new Date('2026-07-31T00:00:00.000Z'),
  source: 'eod',
  spot: SPOT,
};

/** 基线腿: DTE=35 (重叠区)、有效成本 98 < spot、两道门槛均宽松通过。 */
function row(over: Partial<LegChainRow> = {}): LegChainRow {
  return {
    code: 'C-BASE',
    expiryDate: new Date('2026-09-08T00:00:00.000Z'),
    dteDays: 35,
    strike: D('100'),
    bid: D('2'),
    ask: D('2.1'),
    bidSize: 25,
    askSize: 26,
    delta: -0.3,
    openInterest: 900,
    volume: 40,
    greeksComplete: true,
    ...over,
  };
}

async function retrieve(
  legs: readonly LegChainRow[],
  perspectives: readonly LegTab[] = LEG_TABS,
  candidateCap: number = RECALL_CANDIDATE_CAP,
): Promise<LegRetrievalResult> {
  const seed: FakeLegChain = { chain: chainMeta, legs };
  const port = new FakeLegRetrievalAdapter(new Map([[SYMBOL, seed]]));
  const result = await port.retrieveCandidates({
    symbol: SYMBOL,
    now: new Date('2026-08-04T20:00:00.000Z'),
    perspectives,
    candidateCap,
  });
  if (result === null) throw new Error('种子链应当命中 —— 断言前置失效');
  return result;
}

describe('leg-retrieval.port — 假实现驱动召回判据, 零容器 (FR-032 / SC-009)', () => {
  it('权利金门槛把腿**整条移出**候选集并计数 —— 三个视角都看不见它', async () => {
    // bid 恰好低到过不了门槛 (spot × 比例 ≈ 0.198 / 绝对下限 0.2 取大者) —— 取值不硬编码判据。
    const result = await retrieve([
      row({ code: 'C-OK' }),
      row({ code: 'C-PENNY', bid: D('0.01') }),
    ]);
    expect(result.candidates.map(({ leg }) => leg.code)).toEqual(['C-OK']);
    expect(result.removedByPremiumFloor).toBe(1);
  });

  it('期限段决定视角归属 —— 超段的腿只剩全腿, 且**仍在候选集里**', async () => {
    const result = await retrieve([row({ dteDays: RENT_RECALL_DTE.max + 1 })]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].tabs).toEqual(['all']);
  });

  it('重叠区的腿同时进两个意图视角 —— 这是设计不是重复', async () => {
    const result = await retrieve([row({ dteDays: BUILD_RECALL_DTE.max })]);
    expect(result.candidates[0].tabs).toEqual(['all', 'build', 'rent']);
  });

  it('流动性门槛只挡意图视角: 腿仍在候选集、仍在全腿, 排除数按视角各记一次', async () => {
    // 宽价差 (bid 2 / ask 8) ⇒ 相对价差远超上界; DTE=35 落重叠区 ⇒ 两个意图视角各被挡一次。
    const result = await retrieve([row({ code: 'C-WIDE', ask: D('8') })]);
    expect(result.candidates[0].tabs).toEqual(['all']);
    expect(result.removedByPremiumFloor).toBe(0);
    // 🚨 标量数「腿」、分视角数「视角」⇒ 恒有 `标量 ≤ build + rent`, 取等号会在重叠区红错方向。
    expect(result.excludedFromIntentTabs).toBe(1);
    expect(result.excludedFromIntentTabsByTab).toEqual({ build: 1, rent: 1 });
    expect(result.excludedFromIntentTabs).toBeLessThan(
      result.excludedFromIntentTabsByTab.build + result.excludedFromIntentTabsByTab.rent,
    );
  });

  it('期限段本就不合格的腿**不计入**流动性排除数 —— 它不是被门槛挡下的', async () => {
    const result = await retrieve([row({ dteDays: RENT_RECALL_DTE.max + 1, ask: D('8') })]);
    expect(result.excludedFromIntentTabs).toBe(0);
    expect(result.excludedFromIntentTabsByTab).toEqual({ build: 0, rent: 0 });
  });

  it('视角入参收窄: 只要收租时, 不属收租的腿不产候选 (今天全集恒为三视角)', async () => {
    const legs = [
      row({ code: 'C-RENT', dteDays: RENT_RECALL_DTE.min }),
      row({ code: 'C-SHORT', dteDays: BUILD_RECALL_DTE.min }),
    ];
    const all = await retrieve(legs);
    expect(all.candidates.map(({ leg }) => leg.code)).toEqual(['C-RENT', 'C-SHORT']);

    const rentOnly = await retrieve(legs, ['rent']);
    expect(rentOnly.candidates.map(({ leg }) => leg.code)).toEqual(['C-RENT']);
    expect(rentOnly.candidates[0].tabs).toEqual(['rent']);
  });

  it('greeks 缺失的腿照常进候选 —— 召回判据拿不到 Δ, 结构上不可能拿它筛腿', async () => {
    const result = await retrieve([row({ delta: null, greeksComplete: false })]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].leg.greeksComplete).toBe(false);
  });

  it('候选集顺序与入参同序 —— 下游名次与决胜依赖它, MUST NOT 在检索层重排', async () => {
    const result = await retrieve([
      row({ code: 'C-1' }),
      row({ code: 'C-2' }),
      row({ code: 'C-3' }),
    ]);
    expect(result.candidates.map(({ leg }) => leg.code)).toEqual(['C-1', 'C-2', 'C-3']);
  });
});

describe('leg-retrieval.port — 「链未就绪」与「链在但候选为空」是两条分支', () => {
  it('未登记的标的返 null (采集还没轮到), 而不是空候选集', async () => {
    const port = new FakeLegRetrievalAdapter(new Map());
    const result = await port.retrieveCandidates({
      symbol: SYMBOL,
      now: new Date('2026-08-04T20:00:00.000Z'),
      perspectives: [...LEG_TABS],
      candidateCap: RECALL_CANDIDATE_CAP,
    });
    expect(result).toBeNull();
  });

  it('链在、但全部腿被门槛挡下 ⇒ 候选集为空且计数非零 (与 null 不可混为一谈)', async () => {
    const result = await retrieve([row({ bid: D('0.01') }), row({ bid: D('0.02') })]);
    expect(result.candidates).toEqual([]);
    expect(result.removedByPremiumFloor).toBe(2);
    expect(result.chain.spot).toBe(SPOT);
  });
});
