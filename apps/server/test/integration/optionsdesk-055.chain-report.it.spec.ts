import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import {
  GetChainReportUseCase,
  type ChainReportView,
} from '../../src/optionsdesk/get-chain-report.usecase';
import { GetUnderlyingDetailUseCase } from '../../src/optionsdesk/get-underlying-detail.usecase';
import { PrismaLegRetrievalAdapter } from '../../src/optionsdesk/leg-retrieval.adapter';
import { toChainReportResponse } from '../../src/optionsdesk/optionsdesk.dto';
import {
  CHAIN_REPORT_METRICS,
  OTM_BAND_COUNT,
  type ChainReportMetric,
} from '../../src/optionsdesk/chain-report.rules';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';

// 055 T007 —— 标的链分析报表的服务端侧 `state_branch` 全覆盖 (真 PG)。
//
// ## 落层裁定 (先读这条, 否则会来这里补不可能的 IT)
//
// spec 的 **24 条 `state_branches` 里只有 13 条够得着服务端** (1 · 2 数据面 · 4 · 7 · 8 · 9 · 10 ·
// 11 · 12 · 13 · 19 · 20 · 21) —— 其余是呈现与路由决定的 (归 mobile hermetic e2e, T018), 另有
// 2 条 (16 / 17) 是横滑几何与手势归属, Expo Web 都验不到, 归真机 (T021)。本文件的值域 = 那 13 条。
//
// ## 为什么**必须**要真 PG
//
// ① **列轴与格态的分野只在真行上才成立**: 「有腿但全部太便宜」与「该位置无合约」差的是**库里有没有
//    那一行合约**, 而不是内存里数组长不长。假 port 上这条退化成「我塞了几条就有几条」。
// ② **平值 IV 的两侧档取自整条链**: 被权利金挡下的腿仍是插值的两侧之一 (它在库里、不在骨架里),
//    这条只有真 adapter 从 `option_daily_snapshot` 取回全量行时才验得到。
// ③ **IV 分位走 046 详情读端**: 它自己跨 ctx 直查 `underlying_iv_daily` 并整段 try/catch 降级 ——
//    四态里的 `missing` / `percentile_unavailable` 是**库里有没有那一行**决定的。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// 🚫 禁自起 Testcontainers)。装配 = 直接 `new` 贫血 usecase + 真 `PrismaService`; HTTP 通道层
// (真 DI 容器 + swagger 契约) 已由 `src/optionsdesk/optionsdesk.controller.spec.ts` 覆盖 (T006),
// 此处不重复起 Nest 容器。
//
// ## 🚨 三计数这条**不能只验求和恒等式** (T003 探针实证)
//
// 实装用逐级 `continue` (每条腿只落一个桶) ⇒ **求和恒等式对该形态结构性恒真**: 把「行下界外」与
// 「活性挡下」的判定**对调**后跑, 恒等式**照样绿**。真判据是**归属** —— 一条「深价内 ∧ 无人碰过」
// 的腿该计入 ② 而不是 ③ (实测全池这类腿有 865 条, 是最容易重复计的那批)。故本文件专门种了这样
// 一条腿 (`L-H`), 并对它的归属下断言。🚫 只复现恒等式 = 拿一个恒绿的假证据。
describe('055 标的链分析报表 · 服务端侧 state branch (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  /** 请求时刻 = 2026-08-11 ET 16:00 ⇒ 交易所的今天恒为 2026-08-11 (钉住 DTE 基准)。 */
  const NOW = new Date('2026-08-11T20:00:00.000Z');
  const TODAY = '2026-08-11';
  const PREV_SESSION = '2026-08-10';

  const SYMBOL = 'us:PEP';
  /** 现价取 100 ⇒ 落档一眼可验: 价内档 K ∈ (100, 110] · 价外首档 (90, 100] · 第二档 (80, 90]。 */
  const SPOT = '100.0000';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.underlyingIvDaily.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
  });

  // ── 装配 ──────────────────────────────────────────────────────────────────

  const useCaseOf = (): GetChainReportUseCase =>
    new GetChainReportUseCase(
      new GetUnderlyingDetailUseCase(prisma, stubTradingCalendar()),
      new PrismaLegRetrievalAdapter(prisma),
    );

  const report = (): Promise<ChainReportView> => useCaseOf().execute(SYMBOL, NOW);

  /** 该格值下所有格的态 —— 断言「零非空格」与「全 gated」这类整面性质用它。 */
  const statesOf = (view: ChainReportView, metric: ChainReportMetric): Set<string> =>
    new Set(view.cells[metric].flat().map((cell) => cell.state));

  // ── 造数 ──────────────────────────────────────────────────────────────────

  interface SeedLeg {
    readonly code: string;
    readonly dte: number;
    readonly strike: string;
    readonly bid: string;
    readonly ask: string;
    readonly oi: string;
    readonly vol: string;
    readonly iv?: string | null;
    readonly greeksComplete?: boolean;
  }

  /**
   * 八条腿, 每条各占一条判别路径。三个到期日恰好覆盖召回段的三种组合。
   *
   * 📌 成色上界由链自身解出: `K ≥ spot` 的最小档是 105, 比例项是 103 ⇒ 上界 103
   *    ⇒ `L-D` 进不了收租, 而它 DTE / 价差都合格 —— 四种格值成员集不同的来源之一。
   */
  const LEGS: readonly SeedLeg[] = [
    // 两段都在, 三视角全进。第二档 (K 90 ⇒ 价外 10%)。
    {
      code: 'L-A',
      dte: 35,
      strike: '90',
      bid: '2.00',
      ask: '2.10',
      oi: '900',
      vol: '40',
      iv: '20',
    },
    // 同格第二条 —— 最优 / 次优的对照来源。
    {
      code: 'L-B',
      dte: 35,
      strike: '85',
      bid: '3.00',
      ask: '3.10',
      oi: '500',
      vol: '20',
      iv: '24',
    },
    // 只建仓 (DTE 10 够不到收租段)。价外首档。
    {
      code: 'L-C',
      dte: 10,
      strike: '95',
      bid: '1.00',
      ask: '1.10',
      oi: '300',
      vol: '15',
      iv: '26',
    },
    // 只收租段内, 但成色上界把它挡在收租之外 ⇒ 只剩全腿。价内档。
    {
      code: 'L-D',
      dte: 200,
      strike: '105',
      bid: '8.00',
      ask: '8.20',
      oi: '200',
      vol: '10',
      iv: '30',
    },
    // 🚨 **权利金挡下** ⇒ 整条不在骨架。它同时是 09-15 那列**离现价最近的下侧档** ——
    //    平值 IV 拿骨架去插值会跳过它, 两种取法给出不同的数, 而两个数都画得出曲线。
    {
      code: 'L-E',
      dte: 35,
      strike: '99',
      bid: '0.05',
      ask: '0.15',
      oi: '100',
      vol: '5',
      iv: '22',
    },
    // 🚨 **活性挡下** (无人碰过) ⇒ 在骨架内、不进任何视角。
    { code: 'L-F', dte: 10, strike: '97', bid: '1.50', ask: '1.60', oi: '0', vol: '0', iv: '27' },
    // 🚨 **行下界外** (深价内), 但活性正常 —— 09-15 那列的上侧插值档。
    {
      code: 'L-G',
      dte: 35,
      strike: '130',
      bid: '5.00',
      ask: '5.10',
      oi: '400',
      vol: '20',
      iv: '45',
    },
    // 🚨🚨 **行下界外 ∧ 无人碰过** —— 归属断言的靶子: 它 MUST 只计入 ②, 🚫 不计入 ③。
    { code: 'L-H', dte: 35, strike: '135', bid: '5.00', ask: '5.10', oi: '0', vol: '0', iv: '50' },
  ];

  async function seedChain(
    legs: readonly SeedLeg[],
    opts: { spot?: string | null; excluded?: boolean; iv?: boolean; ivPercentile?: boolean } = {},
  ): Promise<void> {
    const instrument = await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'PEP',
        name: 'PEP Inc.',
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });
    for (const leg of legs) {
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: leg.code,
          root: 'PEP',
          underlyingInstrumentId: instrument.id,
          expiryDate: new Date(dateOf(TODAY).getTime() + leg.dte * 86_400_000),
          strikePrice: leg.strike,
          optionType: 'PUT',
          isStandard: true,
        },
        select: { id: true },
      });
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: dateOf(TODAY),
          source: 'eod',
          quoteAsOf: new Date(`${TODAY}T20:31:07Z`),
          // 🚨 OI 归属 T−1 —— 与 sessionDate 蓄意不同天 (FR-014 / FR-033 ③ 的判别性前提)。
          oiAsOf: dateOf(PREV_SESSION),
          bid: leg.bid,
          ask: leg.ask,
          delta: '-0.30',
          iv: leg.iv ?? null,
          openInterest: leg.oi,
          volume: leg.vol,
          underlyingSpot: opts.spot === undefined ? SPOT : opts.spot,
          greeksComplete: leg.greeksComplete ?? true,
        },
      });
    }
    if (opts.iv !== false) {
      await prisma.underlyingIvDaily.create({
        data: {
          instrumentId: instrument.id,
          date: dateOf(TODAY),
          iv: '28.5',
          ivPercentile: opts.ivPercentile === false ? null : '62.0',
        },
      });
    }
    await seedAnchor(opts.excluded ?? false);
  }

  /** 锚是本端点的前置 (无锚 → 404), 与链是两件事 ⇒ 单独一支给「链未就绪」用。 */
  async function seedAnchor(excluded = false): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        market: SYMBOL.split(':')[0]!,
        v: '150',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        excluded,
      },
    });
  }

  // ── state_branch 1 / 2 / 9 / 12 / 19 / 21 + SC-002 / SC-006 ───────────────

  describe('主链 —— 八条腿各占一条判别路径', () => {
    beforeEach(async () => {
      await seedChain(LEGS);
    });

    it('state_branch 1: 有快照 ∧ 已建锚 ⇒ 网格按 价外档 × 到期日 渲染, 格值取该格内最优', async () => {
      const view = await report();
      expect(view.state).toBe('available');
      expect(view.rows).toHaveLength(OTM_BAND_COUNT);
      expect(view.columns.map((c) => c.dteDays)).toEqual([10, 35, 200]);

      // (第二档 × 09-15) 同格两条: L-A (K 90 · bid 2) 与 L-B (K 85 · bid 3)。
      // 年化取最高 ⇒ L-B (3/82 的期间费率 > 2/88)。
      const cell = view.cells.all_annualized[2][1];
      expect(cell.state).toBe('valued');
      expect(cell.legCount).toBe(2);
      expect(Number(cell.best)).toBeGreaterThan(Number(cell.runnerUp));
      // 活跃度同格取最大 —— 口径 = OI + 当日成交。
      expect(view.cells.activity[2][1].best?.toNumber()).toBe(940);
    });

    it('🚨 state_branch 9 / SC-006: 三计数**归属**正确 —— 深价内 ∧ 无人碰过的腿计入 ②, 不计入 ③', async () => {
      const { gateCounts } = await report();
      expect(gateCounts.total).toBe(LEGS.length);
      expect(gateCounts.removedByPremium).toBe(1); // L-E
      expect(gateCounts.skeleton).toBe(7);
      // 🚨 L-G 与 **L-H** 两条: 后者同时「无人碰过」, 顺序一换它就会跑去 ③, 而恒等式照样成立。
      expect(gateCounts.outsideRowFloor).toBe(2);
      expect(gateCounts.withinRows).toBe(5);
      expect(gateCounts.blockedByLiveness).toBe(1); // 只有 L-F, 🚫 不含 L-H
      expect(gateCounts.valued).toBe(4);
      // 恒等式仍断言 —— 它防的是「将来改成四个独立 filter 各数一遍」那种重写。
      expect(
        gateCounts.removedByPremium +
          gateCounts.outsideRowFloor +
          gateCounts.blockedByLiveness +
          gateCounts.valued,
      ).toBe(gateCounts.total);
    });

    it('🚨 state_branch 2 / SC-002: 切换格值 ⇒ 行列逐格不变, 而格态按各自召回集重算', async () => {
      const view = await report();
      for (const metric of CHAIN_REPORT_METRICS) {
        expect(view.cells[metric]).toHaveLength(view.rows.length);
        for (const row of view.cells[metric]) expect(row).toHaveLength(view.columns.length);
      }
      // (价内档 × 2027-02-27) 只有 L-D: 全腿 / 活跃度有值; 建仓 DTE 超段、收租撞成色上界 ⇒ 无。
      expect(view.cells.all_annualized[0][2].state).toBe('valued');
      expect(view.cells.build_quality[0][2].state).toBe('gated');
      expect(view.cells.rent_annualized[0][2].state).toBe('gated');
    });

    it('🚨 state_branch 12: 该到期日无跨现价双侧的行权价 ⇒ 平值 IV 断开, 🚫 不回落最近档', async () => {
      const view = await report();
      // 08-21 那列只有 K 95 / 97, 全在现价下方。
      expect(view.columns[0].atmIv).toBeNull();
      // 09-15 那列有 K 99 (**被权利金挡下、仍在库里**) 与 K 130 ⇒ 插得出来。
      // 🚨 若拿骨架插值会跳到 K 90 那档, 给出 26.25 —— 两个数都画得出曲线。
      expect(view.columns[1].atmIv).toBeCloseTo(22 + (45 - 22) / 31, 6);
    });

    it('state_branch 19 / FR-033: 三个业务日时点各自下发, 且 oiAsOf 与 asOf 不同天', async () => {
      const view = await report();
      expect(view.marketDate).toBe(TODAY);
      expect(view.asOf?.toISOString().slice(0, 10)).toBe(TODAY);
      expect(view.oiAsOf?.toISOString().slice(0, 10)).toBe(PREV_SESSION);
      expect(view.quoteAsOf?.toISOString()).toBe(`${TODAY}T20:31:07.000Z`);
    });

    it('state_branch 18: IV 分位复用 046 那一份读数, 四态之一原样上浮', async () => {
      const view = await report();
      expect(view.iv.state).toBe('available');
      expect(view.iv.ivPercentile?.toString()).toBe('62');
    });

    it('响应形状过 wire —— 四段齐全, 且响应内零 `band` 字段 (plan D-BAND-1)', async () => {
      const body = toChainReportResponse(await report());
      expect(body.spot).toBe('100.0000');
      expect(body.rows).toHaveLength(OTM_BAND_COUNT);
      expect(body.columns).toHaveLength(3);
      expect(body.gateCounts.total).toBe(LEGS.length);
      const flat = JSON.stringify(body);
      expect(flat).not.toContain('"band"');
    });
  });

  // ── 其余分支各自一条独立种子 ──────────────────────────────────────────────

  it('state_branch 21: 锚被排除 ⇒ 报表照常渲染, 仅带标记', async () => {
    await seedChain(LEGS, { excluded: true });
    const view = await report();
    expect(view.anchorExcluded).toBe(true);
    expect(view.state).toBe('available');
    expect(view.columns.length).toBeGreaterThan(0);
  });

  it('state_branch 7: 链从无任何快照 ⇒ chain_not_ready, 且与「全被门槛挡下」可分辨', async () => {
    await seedAnchor();
    const view = await report();
    expect(view.state).toBe('chain_not_ready');
    expect(view.columns).toEqual([]);
    expect(view.gateCounts.total).toBe(0);
    // 🚨 页头照常 —— 网格失败 MUST NOT 波及 IV 块 (这里是「没有链」而非「IV 挂了」)。
    expect(view.iv.state).toBe('missing');
  });

  it('🚨 state_branch 8: 链有腿但全被权利金挡下 ⇒ 网格照常渲染、每格 gated + 三计数', async () => {
    await seedChain(LEGS.map((leg) => ({ ...leg, bid: '0.05', ask: '0.15' })));
    const view = await report();
    // 🚨 与上一条**必须可分辨**: 这里 state 是 available 而不是 chain_not_ready。
    expect(view.state).toBe('available');
    expect(view.rows).toHaveLength(OTM_BAND_COUNT);
    expect(view.columns).toHaveLength(3);
    expect(view.gateCounts.skeleton).toBe(0);
    expect(view.gateCounts.removedByPremium).toBe(LEGS.length);
    // 有合约的位置呈 gated, 没合约的位置仍是 absent —— 两者 MUST 可分 (FR-016)。
    const states = statesOf(view, 'all_annualized');
    expect(states.has('gated')).toBe(true);
    expect(states.has('valued')).toBe(false);
  });

  it('state_branch 20: 快照缺标的价 ⇒ 行轴不成立, 显式 chain_not_ready', async () => {
    await seedChain(LEGS, { spot: null });
    const view = await report();
    expect(view.state).toBe('chain_not_ready');
    expect(view.rows).toEqual([]);
    expect(view.spot).toBeNull();
  });

  it('state_branch 10: 该链只有一个到期日 ⇒ 单列网格, 行轴照常 8 档', async () => {
    await seedChain(LEGS.filter((leg) => leg.dte === 35));
    const view = await report();
    expect(view.columns).toHaveLength(1);
    expect(view.rows).toHaveLength(OTM_BAND_COUNT);
    for (const metric of CHAIN_REPORT_METRICS) {
      for (const row of view.cells[metric]) expect(row).toHaveLength(1);
    }
  });

  it('state_branch 11: 下界内只有一个价外档非空 ⇒ 行轴与行标签**照常 8 档**, 🚫 不塌成一行', async () => {
    // 只留第二档 (K 85 / 90) 那两条。
    await seedChain(LEGS.filter((leg) => leg.code === 'L-A' || leg.code === 'L-B'));
    const view = await report();
    expect(view.rows).toHaveLength(OTM_BAND_COUNT);
    // 🚨 行轴是**常量**不随链变 (FR-002 等距切分的理由正是「分位切分会让每条链的行不同」)
    // ⇒「单行网格」= 只有一行有值, 而不是只渲染一行。
    const valued = view.cells.all_annualized
      .map((row, i) => (row.some((cell) => cell.state === 'valued') ? i : -1))
      .filter((i) => i >= 0);
    expect(valued).toEqual([2]);
  });

  it('state_branch 4: 某格值下零非空格 ⇒ 骨架与行列标签照常渲染, 🚫 不呈空白页或错误页', async () => {
    // 只留 DTE 10 那条 —— 收租段 [30,365] 够不到它 ⇒ 收租格值零非空格。
    await seedChain(LEGS.filter((leg) => leg.code === 'L-C'));
    const view = await report();
    expect(view.state).toBe('available');
    expect(view.rows).toHaveLength(OTM_BAND_COUNT);
    expect(view.columns).toHaveLength(1);
    expect(statesOf(view, 'rent_annualized').has('valued')).toBe(false);
    // 而全腿格值下它照常有值 —— 「零非空格」是格值的性质, 不是链的性质。
    expect(statesOf(view, 'all_annualized').has('valued')).toBe(true);
  });

  it('🚨 state_branch 13: greeks 缺失只让曲线断开, 四种格值照常算得出', async () => {
    await seedChain(LEGS.map((leg) => ({ ...leg, iv: null, greeksComplete: false })));
    const view = await report();
    // 曲线整条断开 —— 一列都插不出平值 IV。
    expect(view.columns.every((column) => column.atmIv === null)).toBe(true);
    // 🚨 而四种格值一个都不受影响: 费率 / 成色 / 活跃度都不吃 greeks。
    expect(view.cells.all_annualized[2][1].state).toBe('valued');
    expect(view.cells.activity[2][1].best?.toNumber()).toBe(940);
    expect(view.gateCounts.valued).toBe(4);
  });

  it('未建锚 ⇒ 404 上抛 (FR-037a), 🚫 MUST NOT 降级成一张空报表', async () => {
    await expect(report()).rejects.toThrow(NotFoundException);
  });
});
