import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { CHAIN_REPORT_METRICS, OTM_BAND_COUNT } from './chain-report.rules';
import { FakeLegRetrievalAdapter, type FakeLegChain } from './fake-leg-retrieval.adapter';
import { GetChainReportUseCase, type ChainReportView } from './get-chain-report.usecase';
import {
  noIv,
  UNDERLYING_IV_STATES,
  type GetUnderlyingDetailUseCase,
  type UnderlyingDetail,
  type UnderlyingIvReadout,
} from './get-underlying-detail.usecase';
import { computeW } from './anchor.rules';
import { activityVolume, computeEffectiveCostVsWPct, computeLegRates } from './leg-derive.rules';
import { RECALL_CANDIDATE_CAP } from './leg-recall.rules';
import type { LegChainMeta, LegChainRow } from './leg-retrieval.port';

// 现价取 100 ⇒ 落档一眼可验: 价内档 K ∈ (100, 110] · 价外首档 (90, 100] · 第二档 (80, 90]。
const SPOT = new Prisma.Decimal('100');
const SYMBOL = 'us:PEP';
const NOW = new Date('2026-08-11T20:00:00.000Z');
/** 估值锚 —— 建仓成色的分母来源。本 spec 不自算它的派生, 一律对着 `leg-derive` 的导出比。 */
const V = new Prisma.Decimal('150');
const D = (v: string) => new Prisma.Decimal(v);
const day = (v: string) => new Date(`${v}T00:00:00.000Z`);

const CHAIN: LegChainMeta = {
  marketDate: '2026-08-11',
  sessionDate: day('2026-08-11'),
  quoteAsOf: new Date('2026-08-11T20:15:00.000Z'),
  // 🚨 OI 归属 T−1 —— 与 sessionDate 蓄意不同天 (FR-014 / FR-033 ③ 的判别性前提)。
  oiAsOf: day('2026-08-10'),
  source: 'eod',
  spot: SPOT,
  priceKind: 'eod_close',
  realtimeDegrade: null,
};

interface Fixture {
  code: string;
  strike: string;
  dteDays: number;
  expiry: string;
  bid: string;
  ask: string;
  openInterest: number;
  volume: number;
  iv: number;
}

/**
 * 七条腿, 每条各占一条判别路径。三个到期日恰好覆盖召回段的三种组合
 * (只建仓 / 两段都在 / 只收租)。
 *
 * 📌 成色上界由链自身解出: `K ≥ spot` 的最小档是 105, 比例项是 103 ⇒ 上界 103
 *    ⇒ L-D (105) 进不了收租, 而它 DTE / 价差都合格 —— 这正是「四种格值成员集不同」的来源之一。
 */
const LEGS: Fixture[] = [
  // 两段都在 · 骨架内 · 三视角全进。band 2 (K 90 ⇒ 价外 10%)。
  {
    code: 'L-A',
    strike: '90',
    dteDays: 35,
    expiry: '2026-09-15',
    bid: '2.00',
    ask: '2.10',
    openInterest: 900,
    volume: 40,
    iv: 20,
  },
  // 同格第二条 —— 最优 / 次优的对照来源。band 2 (K 85 ⇒ 价外 15%)。
  {
    code: 'L-B',
    strike: '85',
    dteDays: 35,
    expiry: '2026-09-15',
    bid: '3.00',
    ask: '3.10',
    openInterest: 500,
    volume: 20,
    iv: 24,
  },
  // 只建仓 (DTE 10 够不到收租段)。band 1。
  {
    code: 'L-C',
    strike: '95',
    dteDays: 10,
    expiry: '2026-08-21',
    bid: '1.00',
    ask: '1.10',
    openInterest: 300,
    volume: 15,
    iv: 26,
  },
  // 只收租段内, 但成色上界 103 把它挡在收租之外 ⇒ 只剩全腿。band 0 (价内)。
  {
    code: 'L-D',
    strike: '105',
    dteDays: 200,
    expiry: '2027-02-26',
    bid: '8.00',
    ask: '8.20',
    openInterest: 200,
    volume: 10,
    iv: 30,
  },
  // 🚨 **权利金挡下** ⇒ 整条不在骨架。band 1, 且它是 09-15 那列**离现价最近的下侧档** ——
  //    平值 IV 若拿骨架去插值就会跳过它, 两种取法给出不同的数 (见对应用例)。
  {
    code: 'L-E',
    strike: '99',
    dteDays: 35,
    expiry: '2026-09-15',
    bid: '0.05',
    ask: '0.15',
    openInterest: 100,
    volume: 5,
    iv: 22,
  },
  // 🚨 **活性挡下** (无人碰过) ⇒ 在骨架内、不在任何视角。band 1。
  {
    code: 'L-F',
    strike: '97',
    dteDays: 10,
    expiry: '2026-08-21',
    bid: '1.50',
    ask: '1.60',
    openInterest: 0,
    volume: 0,
    iv: 27,
  },
  // 🚨 **行下界外** (深价内) ⇒ 在骨架内但不落任何一行。同时是 09-15 那列的上侧插值档。
  {
    code: 'L-G',
    strike: '130',
    dteDays: 35,
    expiry: '2026-09-15',
    bid: '5.00',
    ask: '5.10',
    openInterest: 400,
    volume: 20,
    iv: 45,
  },
];

/**
 * vendor 到期周期 (`marketdata.option_contract.expiration_cycle`) —— 月度链标的唯一判据输入。
 *
 * 📌 **按到期日给而不是逐条腿给**: 现实里它就是到期日级属性 (同一到期日的合约同值), 这样写让
 * fixture 结构上说不出「同一到期日两条腿标不一样」这种链上不存在的形态。
 * 📌 2026-08-21 是当月月度到期日, 另两个到期日不是 —— 三列各一种取值, 「只有一列带标」于是是
 * 判据的结果而不是巧合。
 */
const CYCLE_BY_EXPIRY: Readonly<Record<string, string>> = {
  '2026-08-21': 'MONTH',
  '2026-09-15': 'WEEK',
  '2027-02-26': 'WEEK',
};

function rowOf(fixture: Fixture): LegChainRow {
  return {
    code: fixture.code,
    bandStatus: null,
    expiryDate: day(fixture.expiry),
    expirationCycle: CYCLE_BY_EXPIRY[fixture.expiry] ?? null,
    dteDays: fixture.dteDays,
    strike: D(fixture.strike),
    bid: D(fixture.bid),
    ask: D(fixture.ask),
    bidSize: 25,
    askSize: 26,
    delta: -0.3,
    iv: fixture.iv,
    openInterest: fixture.openInterest,
    volume: fixture.volume,
    greeksComplete: true,
    priceKind: 'eod_close',
  };
}

/** 046 详情读端的替身 —— 本片只消费它的四个字段, 不复刻它的判定。 */
function detailStub(
  over: { iv?: UnderlyingIvReadout; excluded?: boolean; throws?: boolean } = {},
): GetUnderlyingDetailUseCase {
  const detail: UnderlyingDetail = {
    symbol: SYMBOL,
    anchor: {
      row: { excluded: over.excluded ?? false },
      effective: { v: V },
    } as unknown as UnderlyingDetail['anchor'],
    iv: over.iv ?? {
      state: 'available',
      iv: D('28'),
      ivPercentile: D('62'),
      asOf: day('2026-08-11'),
    },
    lastClosedSession: '2026-08-11',
  };
  return {
    execute: () =>
      over.throws === true
        ? Promise.reject(new NotFoundException({ code: 'ANCHOR_NOT_FOUND_FOR_SYMBOL' }))
        : Promise.resolve(detail),
  } as unknown as GetUnderlyingDetailUseCase;
}

function useCaseOf(
  legs: readonly LegChainRow[],
  detailOver: Parameters<typeof detailStub>[0] = {},
  registered = true,
): GetChainReportUseCase {
  const chains = new Map<string, FakeLegChain>();
  // 067: W = computeW(V=150) = 120 > spot = 100 ⇒ spot < W 域, 本文件既有断言取值全数不变。
  if (registered) chains.set(SYMBOL, { chain: CHAIN, w: computeW(V), legs });
  return new GetChainReportUseCase(detailStub(detailOver), new FakeLegRetrievalAdapter(chains));
}

/** #361: 未注册链 **且**该标的在交易所没有挂牌期权 —— 与 `registered = false` 是两条分支。 */
function useCaseNoListedOptions(): GetChainReportUseCase {
  return new GetChainReportUseCase(
    detailStub({}),
    new FakeLegRetrievalAdapter(new Map(), new Set([SYMBOL])),
  );
}

const view = (over: Parameters<typeof detailStub>[0] = {}): Promise<ChainReportView> =>
  useCaseOf(LEGS.map(rowOf), over).execute(SYMBOL, NOW);

// 列序: 08-21 (DTE 10) · 09-15 (DTE 35) · 2027-02-26 (DTE 200)。
const COL_SHORT = 0;
const COL_MID = 1;
const COL_LONG = 2;
// 行序: 0 = 价内档, 1 = 价外首档 (K 90–100), 2 = 第二档 (K 80–90)。
const ROW_ITM = 0;
const ROW_NEAR = 1;
const ROW_FAR = 2;

describe('get-chain-report.usecase — 骨架与轴 (FR-005, plan D-RECALL-1)', () => {
  it('列轴 = 链上实际存在的到期日，升序，不分箱 (FR-001 / FR-003)', async () => {
    const report = await view();
    expect(report.state).toBe('available');
    expect(report.columns.map((c) => c.dteDays)).toEqual([10, 35, 200]);
    expect(report.spot?.toString()).toBe('100');
  });

  it('🚨 三互斥计数在真实成员集上闭合 —— 权利金 1 · 行下界外 1 · 活性 1 · 有值 4 = 全量 7', async () => {
    const { gateCounts } = await view();
    expect(gateCounts.total).toBe(LEGS.length);
    expect(gateCounts.removedByPremium).toBe(1); // L-E
    expect(gateCounts.skeleton).toBe(6);
    expect(gateCounts.outsideRowFloor).toBe(1); // L-G
    expect(gateCounts.withinRows).toBe(5);
    expect(gateCounts.blockedByLiveness).toBe(1); // L-F
    expect(gateCounts.valued).toBe(4);
  });

  it('🚨 被活性挡下的腿留在图上 —— 它那一格呈「被门槛挡下」而非「无合约」(Guardrail 2/13)', async () => {
    const report = await view();
    // (价外首档 × 08-21) 链上有 L-C 与 L-F 两条; L-F 无人碰过 ⇒ 不进任何视角。
    const cell = report.cells.all_annualized[ROW_NEAR][COL_SHORT];
    expect(cell.state).toBe('valued');
    expect(cell.legCount).toBe(1); // 只有 L-C 是成员
    // 而收租视角够不到 DTE 10 ⇒ 同一格换个格值就是「被门槛挡下」, 🚫 不是「无合约」。
    expect(report.cells.rent_annualized[ROW_NEAR][COL_SHORT].state).toBe('gated');
  });

  it('🚨 被权利金挡下的腿仍让格呈 gated —— 分母数在整条链上 (Guardrail 13)', async () => {
    const report = await view();
    // (价外首档 × 09-15) 链上只有 L-E 一条, 且它太便宜 ⇒ 四种格值全 gated, 🚫 不得是 absent。
    for (const metric of CHAIN_REPORT_METRICS) {
      expect(report.cells[metric][ROW_NEAR][COL_MID].state).toBe('gated');
    }
  });

  it('真正无合约的位置才是 absent', async () => {
    const report = await view();
    expect(report.cells.all_annualized[ROW_ITM][COL_SHORT].state).toBe('absent');
  });

  it('🚨 整条到期日全被权利金挡下时**该列仍在** —— 列轴取整条链而非骨架 (state_branch 8)', async () => {
    // 造一个到期日, 其上只有一条太便宜的腿 ⇒ 它一条都不进骨架。
    const cheapOnly = rowOf({
      ...LEGS[0],
      code: 'L-CHEAP',
      strike: '90',
      dteDays: 20,
      expiry: '2026-08-31',
      bid: '0.05',
      ask: '0.15',
    });
    const report = await useCaseOf([...LEGS.map(rowOf), cheapOnly]).execute(SYMBOL, NOW);
    // 🚨 列轴若取骨架, 这一列直接消失 —— 而「链上有合约、只是全都太便宜」这条信息随之丢掉。
    const column = report.columns.findIndex((c) => c.dteDays === 20);
    expect(column).toBeGreaterThanOrEqual(0);
    for (const metric of CHAIN_REPORT_METRICS) {
      expect(report.cells[metric][ROW_FAR][column].state).toBe('gated');
    }
  });

  it('🚨 整条链全被权利金挡下 ⇒ 网格照常渲染、每格 gated + 页脚计数，🚫 不是空白页', async () => {
    const allCheap = LEGS.map((leg) => rowOf({ ...leg, bid: '0.05', ask: '0.15' }));
    const report = await useCaseOf(allCheap).execute(SYMBOL, NOW);
    expect(report.state).toBe('available');
    expect(report.rows).toHaveLength(OTM_BAND_COUNT);
    expect(report.columns.length).toBeGreaterThan(0);
    expect(report.gateCounts.skeleton).toBe(0);
    expect(report.gateCounts.removedByPremium).toBe(allCheap.length);
    // 有合约的位置呈 gated, 没合约的位置仍是 absent —— 两者 MUST 可分 (FR-016)。
    const states = new Set(report.cells.all_annualized.flat().map((cell) => cell.state));
    expect(states.has('gated')).toBe(true);
    expect(states.has('valued')).toBe(false);
  });
});

describe('get-chain-report.usecase — 四种格值同一骨架 (SC-002 的服务端一半, plan D-API-2)', () => {
  it('🚨 四张网格的行列维度逐格相等 —— 切换格值时位置不可能变', async () => {
    const report = await view();
    for (const metric of CHAIN_REPORT_METRICS) {
      expect(report.cells[metric]).toHaveLength(report.rows.length);
      for (const row of report.cells[metric]) expect(row).toHaveLength(report.columns.length);
    }
  });

  it('🚨 变的是格态 —— 同一格在四种格值下判出的态不全相同 (state_branch 2 数据面)', async () => {
    const report = await view();
    const states = CHAIN_REPORT_METRICS.map((m) => report.cells[m][ROW_ITM][COL_LONG].state);
    // (价内档 × 2027-02-26) 只有 L-D: 全腿与活跃度有值, 建仓 (DTE 超段) 与收租 (成色上界) 无。
    expect(states).toEqual(['gated', 'gated', 'valued', 'valued']);
  });
});

describe('get-chain-report.usecase — 四种格值口径同源 (FR-011 / FR-012 / FR-013)', () => {
  it('🚨 建仓成色走 `computeEffectiveCostVsWPct`，取最小；🚫 不另算一份', async () => {
    const report = await view();
    const cell = report.cells.build_quality[ROW_FAR][COL_MID];
    // 同格两条: L-A (K 90 · bid 2) 与 L-B (K 85 · bid 3)。成色越低越好 ⇒ 最优是 L-B。
    expect(cell.best?.toString()).toBe(
      computeEffectiveCostVsWPct(V, D('85'), D('3.00'))?.toString(),
    );
    expect(cell.runnerUp?.toString()).toBe(
      computeEffectiveCostVsWPct(V, D('90'), D('2.00'))?.toString(),
    );
  });

  it('🚨 两种年化走 `computeLegRates` 的同一个数，取最大 —— 差别只在成员集', async () => {
    const report = await view();
    const best = computeLegRates({ strike: D('85'), premium: D('3.00'), dteDays: 35 });
    expect(report.cells.rent_annualized[ROW_FAR][COL_MID].best?.toString()).toBe(
      best?.annualizedRate.toString(),
    );
    expect(report.cells.all_annualized[ROW_FAR][COL_MID].best?.toString()).toBe(
      best?.annualizedRate.toString(),
    );
  });

  it('🚨 活跃度走 `activityVolume`，取最大', async () => {
    const report = await view();
    const cell = report.cells.activity[ROW_FAR][COL_MID];
    expect(cell.best?.toNumber()).toBe(activityVolume(900, 40));
    expect(cell.runnerUp?.toNumber()).toBe(activityVolume(500, 20));
  });
});

describe('get-chain-report.usecase — 列的召回段覆盖 (FR-009 / FR-009a, plan D-STATE-1)', () => {
  it('三列恰好覆盖三种组合，且全腿口径恒覆盖', async () => {
    const report = await view();
    const bandOf = (i: number) => report.columns[i].inRecallBand;
    // DTE 10: 建仓段内、收租段外。
    expect(bandOf(COL_SHORT).build_quality).toBe(true);
    expect(bandOf(COL_SHORT).rent_annualized).toBe(false);
    // DTE 35: 两段重叠区 —— FR-009 要求两框并存, 而不是归给其中一段。
    expect(bandOf(COL_MID).build_quality).toBe(true);
    expect(bandOf(COL_MID).rent_annualized).toBe(true);
    // DTE 200: 建仓段外、收租段内。
    expect(bandOf(COL_LONG).build_quality).toBe(false);
    expect(bandOf(COL_LONG).rent_annualized).toBe(true);
    for (const column of report.columns) {
      expect(column.inRecallBand.all_annualized).toBe(true);
      expect(column.inRecallBand.activity).toBe(true);
    }
  });

  it('月度链标逐列判 —— vendor 标 `MONTH` 的那列带标，标 `WEEK` 的不带', async () => {
    const report = await view();
    // 列序 08-21 / 09-15 / 2027-02-26, 取值见 `CYCLE_BY_EXPIRY`。
    expect(report.columns.map((c) => c.isMonthlyChain)).toEqual([true, false, false]);
  });

  it('🚨 vendor 缺到期周期 (`null`) ⇒ 一列都不带标，不炸也不推定 (#45 判据换源后的取不到态)', async () => {
    // 换源前这里测的是「交易日历查不到」。那条判据在生产**恒**走这一支 —— 日历结构上不含未来
    // 交易日, 而到期日全在未来 ⇒ 线上一列都标不出, 而这条用例当时是绿的。判据换成 vendor
    // 到期周期后, 「取不到」缩回它本来的样子: vendor 那一列真的是空。
    const legs = LEGS.map(rowOf).map((leg) => ({ ...leg, expirationCycle: null }));
    const report = await new GetChainReportUseCase(
      detailStub(),
      new FakeLegRetrievalAdapter(
        new Map<string, FakeLegChain>([[SYMBOL, { chain: CHAIN, w: computeW(V), legs }]]),
      ),
    ).execute(SYMBOL, NOW);
    expect(report.columns.every((c) => !c.isMonthlyChain)).toBe(true);
    expect(report.state).toBe('available');
  });
});

describe('get-chain-report.usecase — 平值 IV (FR-022 / FR-023)', () => {
  it('🚨 插值取整条链，🚫 不取骨架 —— 被权利金挡下的档同样是定平值的两侧之一', async () => {
    const report = await view();
    // 09-15 那列: 下侧最近档是 L-E (K 99, 太便宜 ⇒ 不在骨架), 上侧是 L-G (K 130)。
    // 拿骨架插值会跳到 K 90 那档, 给出 26.25 —— 与下面这个数不同, 且**两个数都画得出曲线**。
    expect(report.columns[COL_MID].atmIv).toBeCloseTo(22 + (45 - 22) / 31, 6);
    expect(report.columns[COL_MID].atmIv).not.toBeCloseTo(26.25, 6);
  });

  it('该到期日无跨现价两侧的档 ⇒ 断点，🚫 不回落最近档', async () => {
    const report = await view();
    // 08-21 那列只有 K 95 / 97 两档, 全在现价下方。
    expect(report.columns[COL_SHORT].atmIv).toBeNull();
  });
});

describe('get-chain-report.usecase — 候选上限 (🚨 Guardrail 1, plan D-RECALL-1)', () => {
  it('🚨 腿数远超候选保险丝时零条被切 —— 沿用 K 会让一批腿静默掉出成员集', async () => {
    const many = Array.from({ length: RECALL_CANDIDATE_CAP + 1 }, (_unused, i) =>
      rowOf({ ...LEGS[0], code: `L-${i}`, strike: '90' }),
    );
    const report = await useCaseOf(many).execute(SYMBOL, NOW);
    // 若沿用 `RECALL_CANDIDATE_CAP`, 被切掉的腿拿不到视角归属 ⇒ 它们会从「有值」掉进
    // 「被活性挡下」, 而网格照常渲染、数字照常有。
    expect(report.gateCounts.valued).toBe(many.length);
    expect(report.gateCounts.blockedByLiveness).toBe(0);
    expect(report.cells.all_annualized[ROW_FAR][0].legCount).toBe(many.length);
  });
});

describe('get-chain-report.usecase — 链级读数与降级 (FR-031 / FR-033, state_branch 18/21/22)', () => {
  it('三个业务日时点各自下发，🚫 不合并成一个「数据截至」(FR-033)', async () => {
    const report = await view();
    expect(report.marketDate).toBe('2026-08-11');
    expect(report.asOf).toEqual(CHAIN.sessionDate);
    expect(report.quoteAsOf).toEqual(CHAIN.quoteAsOf);
    expect(report.oiAsOf).toEqual(CHAIN.oiAsOf);
    // 🚨 持仓量业务日与报价业务日**不是同一天** —— 合并会让 FR-014 的时点标注失去依据。
    expect(report.oiAsOf?.getTime()).not.toBe(report.asOf?.getTime());
  });

  it('🚨 IV 分位四态各自原样透传 —— 复用 046 那一份，🚫 不新造读数 (state_branch 18)', async () => {
    for (const state of UNDERLYING_IV_STATES) {
      const iv = state === 'available' ? undefined : noIv(state);
      const report = await view(iv === undefined ? {} : { iv });
      expect(report.iv.state).toBe(state);
      // 🚫 禁回落 0: 非 available 三态的读数一律 null。
      if (state !== 'available') expect(report.iv.iv).toBeNull();
    }
  });

  it('锚被排除 ⇒ 报表照常渲染，仅带标记 (state_branch 21)', async () => {
    const report = await view({ excluded: true });
    expect(report.anchorExcluded).toBe(true);
    expect(report.state).toBe('available');
  });

  it('未建锚 ⇒ 404 上抛，🚫 MUST NOT 被降级兜成一张空报表 (FR-037a)', async () => {
    await expect(useCaseOf(LEGS.map(rowOf), { throws: true }).execute(SYMBOL, NOW)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('🚨 #361 该标的没有挂牌期权 ⇒ no_listed_options, **不是** chain_not_ready —— 报表屏与选约表同源', async () => {
    const report = await useCaseNoListedOptions().execute(SYMBOL, NOW);
    expect(report.state).toBe('no_listed_options');
    expect(report.rows).toEqual([]);
    // 与 `chain_not_ready` 同降级形态 —— 换的是成因不是形态, 页头 IV 照常。
    expect(report.iv.state).toBe('available');
  });

  it('🚨 链未就绪 ⇒ 网格空但页头 IV 照常 —— 两条链路各自独立降级', async () => {
    const report = await useCaseOf([], {}, false).execute(SYMBOL, NOW);
    expect(report.state).toBe('chain_not_ready');
    expect(report.rows).toEqual([]);
    expect(report.columns).toEqual([]);
    // 🚨 IV 明明读得到 —— 网格失败 MUST NOT 波及它 (spec Assumptions)。
    expect(report.iv.state).toBe('available');
    expect(report.lastClosedSession).toBe('2026-08-11');
    // 没有链就没有腿 ⇒ 七个数取 0 而非 null (它们是计数不是「未知」)。
    expect(report.gateCounts.total).toBe(0);
  });
});
