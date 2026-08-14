import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { GetLegsUseCase, type LegTableView } from '../../src/optionsdesk/get-legs.usecase';
import { PrismaLegRetrievalAdapter } from '../../src/optionsdesk/leg-retrieval.adapter';
import { LEG_TABS } from '../../src/optionsdesk/leg-tab.rules';
import {
  BUILD_RECOMMEND_ABS_DELTA_BAND,
  RENT_RECOMMEND_ABS_DELTA_BANDS,
} from '../../src/optionsdesk/leg-mark.rules';

// 050 T009 打标层 IT (US3 全 6 条 AS, SC-005)。
//
// ## 为什么**必须**要真 PG
//
// ① **月度链标读的是合约行上 vendor 声明的到期周期** —— 测 ④⑤ 的判别性全在
//    `marketdata.option_contract.expiration_cycle` 那一列上, 要真的把它写进库再整条链路读回来。
//    🚨 **判据于 2026-08-15 (#45) 换源**: 原先是「该月第三个周五; 该日非交易日则取前一交易日」,
//    读 `marketdata.trading_day`。那条判据在生产**从未生效** —— 交易日历结构上不含未来交易日,
//    而到期日全在未来。这个 IT 当时是绿的, 因为 `seedTradingDays()` 往表里插了候选日本身;
//    **喂进去的正是要验的那个答案**, 于是它测的是 fixture 而不是生产前置条件。留作教训。
// ② **标与集合的正交性要在同一份真数据上验** (测 ⑥) —— 打标零拦截说的是「同一份输入, 打标的
//    输入变了而成员关系一行不动」。两侧各自 mock 就永远不动, 断言退化成平凡绿。
// ③ 意图 (`zone` × `L` 层 × 水位) 由锚表真行派生, 打标又挂在意图上 ⇒ 这条链要整条走一遍。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。样板 `optionsdesk-050.recall.it.spec.ts` / 047 leg-picker。
//
// 🚨 **SC-005 的判据在 2026-08-11 (T009) 修正过**: 原写「收租意图下建仓 Tab 推荐标数恒为 0」。
// 那个「恒 0」在 **047 的旧判据下才结构成立** —— 旧建仓族的成员判据本身就是 `|Δ| ∈ [0.40,0.55]`,
// 与三条收租带几乎不相交。050 把 Δ 移出召回后, 建仓召回集 = 「DTE ≤ 49 ∧ K − bid < spot」=
// 整条短端虚值链, `|Δ|` 从 0.01 铺到 0.99, 收租档带正好从中间切过 ⇒ 建仓 Tab 里**会有**带标的
// 腿。⇒ 判据改成**机制层**: 带标的腿其 `|Δ|` 无一例外落当前收租档带, 按建仓带打出的标恒 0 条。
// 保 `FR-011`「标随标的级意图、MUST NOT 随 Tab 变」。理由全文见 spec US3-AS2 的修正注。
describe('050 T009 打标层 (Testcontainers PG, 真 vendor 到期周期列)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let useCase: GetLegsUseCase;

  const NOW = new Date('2026-08-04T20:00:00.000Z');
  const TODAY = '2026-08-04';
  const PREV_SESSION = '2026-08-03';

  const SYMBOL = 'us:PEP';
  const SPOT = '132.4000';
  /** V = 150 ⇒ W = 120; spot 132.40 落 [W, V) = 卖put区 (d = 0)。 */
  const V = '150';

  /** DTE 38 —— 同时进建仓与收租 (重叠区), 让「同一条腿在两个 Tab 里标一致」验得到。 */
  const OVERLAP_EXPIRY = '2026-09-11';
  /** 2026-09 的第三个周五 (DTE 45) —— 月度链标的正例, 也落重叠区。 */
  const MONTHLY_EXPIRY = '2026-09-18';
  /**
   * 测 ⑤ 的**前挪对照**: vendor 把月度标给了周四 09-17, 而第三个周五 09-18 那天标 `WEEK`。
   *
   * 📌 这是真实形态的近端镜像 —— 2027-06-19 Juneteenth 落周六 ⇒ NYSE 提前到周五 2027-06-18
   * 休市 ⇒ 该月月度到期日前挪到**周四 2027-06-17** (dev 库该日 298 条合约全标 `MONTH`)。
   * 用近端日期是为了稳落在召回段内, 判别性与真日期完全同构。
   */
  const SHIFTED_MONTHLY_EXPIRY = '2026-09-17';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    useCase = new GetLegsUseCase(prisma, new PrismaLegRetrievalAdapter(prisma));
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.earningsEvent.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.tradingDay.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
  });

  // ── 造数 ──────────────────────────────────────────────────────────────────

  /**
   * @param opts.v 锚 V —— 区间由它与 spot 的关系定: 缺省 150 ⇒ spot 132.40 落卖put区
   *   (d=0) ⇒ 走收租; 抬到 300 ⇒ spot < 0.5V ⇒ 深买区 (d=2), 配 L2 富余 1 ⇒ 低水位那格是
   *   **建仓** —— 测 ① 就是这么取到建仓意图的。
   * @param opts.positionBucket 手选水位; 显式给 `null` = 未选 (⇒ 意图「待定」)。
   */
  async function seedAnchor(
    ticker: string,
    opts: { v?: string; positionBucket?: string | null } = {},
  ): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker,
        v: opts.v ?? V,
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8', // ≥7 ⇒ L2
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        positionBucketManual:
          opts.positionBucket === undefined ? 'gte_two_thirds' : opts.positionBucket,
        positionBucketSetAt: opts.positionBucket === null ? null : new Date('2026-08-01T02:00:00Z'),
      },
    });
  }

  async function seedInstrument(code: string): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market: 'us',
        code,
        name: `${code} Inc.`,
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });
    return row.id;
  }

  interface LegFixture {
    expiry: string;
    strike: string;
    bid: string;
    ask: string;
    delta: string | null;
    greeksComplete?: boolean;
    /**
     * vendor 到期周期 —— 月度链标的唯一判据输入。缺省 `WEEK` = 周链。
     * 🚫 缺省**不给 `MONTH`**: 那会让「这个标不是恒 true」的反例造不出来。
     */
    expirationCycle?: string | null;
  }

  async function seedLeg(instrumentId: bigint, fixture: LegFixture): Promise<string> {
    const strikePart = Math.round(Number(fixture.strike) * 1000);
    const code = `US.PEP${fixture.expiry.replaceAll('-', '').slice(2)}P${strikePart}`;
    const contract = await prisma.optionContract.create({
      data: {
        market: 'us',
        code,
        root: 'PEP',
        underlyingInstrumentId: instrumentId,
        expiryDate: dateOf(fixture.expiry),
        strikePrice: fixture.strike,
        optionType: 'PUT',
        isStandard: true,
        expirationCycle: fixture.expirationCycle ?? 'WEEK',
      },
      select: { id: true, code: true },
    });
    await prisma.optionDailySnapshot.create({
      data: {
        contractId: contract.id,
        sessionDate: dateOf(TODAY),
        source: 'eod',
        quoteAsOf: new Date(`${TODAY}T20:31:07Z`),
        oiAsOf: dateOf(PREV_SESSION),
        bid: fixture.bid,
        ask: fixture.ask,
        delta: fixture.delta,
        openInterest: '900',
        volume: '40',
        underlyingSpot: SPOT,
        greeksComplete: fixture.greeksComplete ?? true,
      },
    });
    return contract.code;
  }

  /**
   * 主数据集 —— 五条腿按 `|Δ|` 铺开, **每条各自落在一个带里**:
   *
   * | 腿          | \|Δ\| | 落哪个带                    |
   * | ----------- | ----- | --------------------------- |
   * | `atm`       | 0.45  | 建仓带 [0.40,0.55]          |
   * | `nearAtm`   | 0.35  | 收租 near_atm [0.30,0.40]   |
   * | `moderate`  | 0.22  | 收租 moderate [0.15,0.30]   |
   * | `deep`      | 0.10  | 收租 deep [0.05,0.15]       |
   * | `noGreeks`  | —     | 哪个都不落 (FR-013 恒不标)  |
   *
   * 🚨 五条腿**全部落 DTE 38 的重叠区** ⇒ 每条都同时在建仓与收租 Tab 里。这让「标随意图不随
   * Tab」有了判别性: 同一条腿在两个 Tab 里的标必须**是同一个值**, 而不是各判各的。
   */
  async function seedDeltaLadder(instrumentId: bigint): Promise<Record<string, string>> {
    const codes: Record<string, string> = {};
    const rung = (strike: string, bid: string, ask: string, delta: string | null) => ({
      expiry: OVERLAP_EXPIRY,
      strike,
      bid,
      ask,
      delta,
    });
    codes.atm = await seedLeg(instrumentId, rung('130', '3.00', '3.10', '-0.45'));
    codes.nearAtm = await seedLeg(instrumentId, rung('127', '2.20', '2.30', '-0.35'));
    codes.moderate = await seedLeg(instrumentId, rung('122', '1.40', '1.50', '-0.22'));
    codes.deep = await seedLeg(instrumentId, rung('115', '0.70', '0.80', '-0.10'));
    codes.noGreeks = await seedLeg(instrumentId, {
      ...rung('118', '0.90', '1.00', null),
      greeksComplete: false,
    });
    return codes;
  }

  const legOf = (view: LegTableView, code: string) => view.legs.find((l) => l.code === code);
  const marked = (view: LegTableView): string[] =>
    view.legs.filter((l) => l.isRecommended).map((l) => l.code);

  // ── ① 建仓意图: 带内打标、带外不打 (US3-AS1) ────────────────────────────────
  it('① US3-AS1: 建仓意图 → |Δ| 落建仓带的腿带标, 落带外的不带', async () => {
    // V = 300 ⇒ spot 132.40 < 0.5V = 150 ⇒ 深买区 (d=2); L2 (l=2) ⇒ 富余 1 ⇒ 低水位那格建仓。
    await seedAnchor(SYMBOL, { v: '300', positionBucket: 'lt_one_third' });
    const id = await seedInstrument('PEP');
    const codes = await seedDeltaLadder(id);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.intent).toBe('build_position');
    expect(view.rentDepth).toBeNull();
    // 0.45 落 [0.40,0.55] ⇒ 唯一带标的那条。其余三条有 Δ 的都在带外。
    expect(marked(view)).toEqual([codes.atm]);
    // 全量核对: 带标 ⟺ |Δ| 落建仓带 (不是「碰巧只有一条」)。
    for (const leg of view.legs) {
      const inBand =
        leg.absDelta !== null &&
        leg.absDelta >= BUILD_RECOMMEND_ABS_DELTA_BAND.min &&
        leg.absDelta <= BUILD_RECOMMEND_ABS_DELTA_BAND.max;
      expect([leg.code, leg.isRecommended]).toEqual([leg.code, inBand]);
    }
    // greeks 缺失恒不带标 (FR-013), 但它**在表内**。
    expect(legOf(view, codes.noGreeks)?.isRecommended).toBe(false);
    expect(legOf(view, codes.noGreeks)).toBeDefined();
  });

  // ── ② 收租意图 + 建仓 Tab (US3-AS2, SC-005 修正后的判据) ────────────────────
  it('② US3-AS2 / SC-005: 收租意图下**建仓 Tab 内**的标按收租档带打, 按建仓带打出的标恒 0 条', async () => {
    await seedAnchor(SYMBOL, { positionBucket: 'gte_two_thirds' }); // ⇒ 收租 · 深度
    const id = await seedInstrument('PEP');
    const codes = await seedDeltaLadder(id);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.intent).toBe('rent');
    expect(view.rentDepth).toBe('deep');
    const band = RENT_RECOMMEND_ABS_DELTA_BANDS.deep;

    // 建仓视角里确实有腿 (五条全在重叠区), 否则下面的断言是平凡的。
    const inBuildTab = (await useCase.execute(SYMBOL, 'build', NOW)).legs;
    expect(inBuildTab).toHaveLength(5);
    // 🚨 建仓 Tab 内带标的那条, |Δ| 落的是**收租 deep 带**而不是建仓带。
    expect(inBuildTab.filter((l) => l.isRecommended).map((l) => l.code)).toEqual([codes.deep]);
    // 🚨 SC-005 的机械判据: 全表带标的腿 |Δ| 无一例外落当前收租档带; 按建仓带打的标 0 条。
    for (const leg of view.legs.filter((l) => l.isRecommended)) {
      expect(leg.absDelta).not.toBeNull();
      expect(leg.absDelta! >= band.min && leg.absDelta! <= band.max).toBe(true);
    }
    expect(
      view.legs.filter(
        (l) =>
          l.isRecommended &&
          l.absDelta !== null &&
          l.absDelta > band.max &&
          l.absDelta >= BUILD_RECOMMEND_ABS_DELTA_BAND.min,
      ),
    ).toEqual([]);
    // |Δ| 0.45 那条在建仓视角里, 却**不带标** —— 建仓带在收租意图下整个不生效。
    expect(inBuildTab.map((l) => l.code)).toContain(codes.atm);
    expect(legOf(view, codes.atm)?.isRecommended).toBe(false);
  });

  it('②b 🚨 FR-011: 同一条腿同时在建仓与收租 Tab, 两处的标**是同一个值** (标不随 Tab 变)', async () => {
    await seedAnchor(SYMBOL, { positionBucket: 'gte_two_thirds' });
    const id = await seedInstrument('PEP');
    const codes = await seedDeltaLadder(id);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    // 标是**每腿一个标量**, 不是 per-Tab 的 map —— 这条断言在结构上就成立, 写出来是为了让
    // 「按 Tab 拆成 map」那种改法 (option B/C) 一旦发生就有一处红。
    const deep = legOf(view, codes.deep)!;
    // 三个视角逐个都收得到它 (053 起这是三次请求各命中一次, 不再是一个 `tabs` 数组)。
    for (const tab of LEG_TABS) {
      const perTab = await useCase.execute(SYMBOL, tab, NOW);
      expect([tab, perTab.legs.some((l) => l.code === codes.deep)]).toEqual([tab, true]);
      expect([tab, perTab.legs.find((l) => l.code === codes.deep)?.isRecommended]).toEqual([
        tab,
        true,
      ]);
    }
    expect(deep.isRecommended).toBe(true);
    expect(Object.keys(deep)).not.toContain('isRecommendedByTab');
  });

  // ── ③ 水位未选 → 全表零推荐标 (US3-AS3) ─────────────────────────────────────
  it('③ US3-AS3: 收租但水位未选 → 全表**零**推荐标 (🚫 不取三档并集替人做方向性假设)', async () => {
    await seedAnchor(SYMBOL, { positionBucket: null });
    const id = await seedInstrument('PEP');
    await seedDeltaLadder(id);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.intent).toBe('pending');
    expect(view.rentDepth).toBeNull();
    // 🚨 三档并集是 [0.05,0.40] —— 阶梯里有三条腿落在里面。取并集的实现会打出 3 个标,
    // 那正是 Guardrail 1 的坑; 正确行为是一个都不打。
    expect(marked(view)).toEqual([]);
    // 腿数据照常全量呈现 (FR-021: 没有方向不等于没有数据)。
    expect(view.legs).toHaveLength(5);
  });

  // ── ④ 月度链标: 真 vendor 到期周期列 (US3-AS4) ──────────────────────────────
  it('④ US3-AS4: vendor 标 `MONTH` 的到期日 → 该到期日下**全部**腿带月度链标', async () => {
    await seedAnchor(SYMBOL);
    const id = await seedInstrument('PEP');
    await seedDeltaLadder(id); // 五条都在 09-11, 缺省 `WEEK`
    // 同一到期日两条腿 —— 「该到期日下全部腿都带标」要 ≥2 条才验得出。
    const monthlyA = await seedLeg(id, {
      expiry: MONTHLY_EXPIRY,
      strike: '126',
      bid: '2.00',
      ask: '2.10',
      delta: '-0.30',
      expirationCycle: 'MONTH',
    });
    const monthlyB = await seedLeg(id, {
      expiry: MONTHLY_EXPIRY,
      strike: '124',
      bid: '1.70',
      ask: '1.80',
      delta: '-0.26',
      expirationCycle: 'MONTH',
    });

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    const monthly = view.legs.filter((l) => l.isMonthlyChain).map((l) => l.code);
    // 逐条相等: 恰好那两条, 一条不多一条不少。
    expect(new Set(monthly)).toEqual(new Set([monthlyA, monthlyB]));
    // 09-11 那批标 `WEEK` ⇒ 不带标。它证明这个标不是恒 true。
    expect(view.legs.filter((l) => !l.isMonthlyChain)).toHaveLength(5);
    // 🚨 **判据不看日历**: 全程一行 `trading_day` 都没 seed, 标照常出得来 —— 这正是 #45 修的
    // 那件事 (生产的日历恒无未来交易日, 旧判据在这一步就返空集了)。
    expect(await prisma.tradingDay.count()).toBe(0);
  });

  // ── ⑤ 月度到期日前挪 → 标跟着 vendor 走, 不跟着「是不是周五」走 (US3-AS5) ─────
  it('⑤ US3-AS5: 🚨 月度日前挪到周四 → 标落周四那天, 第三个周五那天**不带标**', async () => {
    await seedAnchor(SYMBOL);
    const id = await seedInstrument('PEP');
    // 09 月的两天各造一条腿。真实形态见 `SHIFTED_MONTHLY_EXPIRY` 的注释 (2027-06 Juneteenth)。
    const onThirdFriday = await seedLeg(id, {
      expiry: MONTHLY_EXPIRY, // 2026-09-18, **是**当月第三个周五
      strike: '128',
      bid: '1.20',
      ask: '1.30',
      delta: '-0.28',
      expirationCycle: 'WEEK', // …但 vendor 说它是周链
    });
    const onShifted = await seedLeg(id, {
      expiry: SHIFTED_MONTHLY_EXPIRY, // 2026-09-17, 周四
      strike: '128',
      bid: '1.10',
      ask: '1.20',
      delta: '-0.27',
      expirationCycle: 'MONTH', // …vendor 说月度日在这天
    });

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    // 🚨 **两个方向都要断**: 只断周四带标, 「恒 true」也能过; 只断周五不带标, 「恒 false」也能过。
    expect(legOf(view, onShifted)?.isMonthlyChain).toBe(true);
    expect(legOf(view, onThirdFriday)?.isMonthlyChain).toBe(false);
  });

  // ── ⑤b vendor 缺字段 → 不打标, 不推定 ────────────────────────────────────────
  it('⑤b 🚨 `expiration_cycle` 为 NULL ⇒ 该到期日不带标 (缺字段不推定, 同 FR-013)', async () => {
    await seedAnchor(SYMBOL);
    const id = await seedInstrument('PEP');
    const unknown = await seedLeg(id, {
      expiry: MONTHLY_EXPIRY, // 第三个周五 —— 靠日期猜的判据会在这里标上
      strike: '126',
      bid: '2.00',
      ask: '2.10',
      delta: '-0.30',
      expirationCycle: null,
    });

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(legOf(view, unknown)?.isMonthlyChain).toBe(false);
    // 整屏照常可用 —— 缺一列 vendor 字段不是故障。
    expect(view.state).toBe('available');
  });

  // ── ⑥ 打标零拦截 (US3-AS6) ──────────────────────────────────────────────────
  it('⑥ US3-AS6: 切换意图与水位 ⇒ 标全变, 而三个 Tab 的成员集合与两个计数**一行不动**', async () => {
    const id = await seedInstrument('PEP');
    await seedDeltaLadder(id);
    // 🚨 额外一条月度腿 —— 没有它, 下面「月度标与意图正交」两侧恒为空数组, 断言平凡绿。
    // (梯子五条全是 `WEEK`; 这条是本用例唯一带标的腿。)
    await seedLeg(id, {
      expiry: MONTHLY_EXPIRY,
      strike: '126',
      bid: '2.00',
      ask: '2.10',
      delta: '-0.30',
      expirationCycle: 'MONTH',
    });

    // 053: 成员关系是**跨请求**的 —— 三个视角各取一次再拼成指纹 (拼的是断言口径, 不是响应)。
    const membership = async () => {
      const rows: string[] = [];
      for (const tab of LEG_TABS) {
        const view = await useCase.execute(SYMBOL, tab, NOW);
        for (const leg of view.legs) rows.push(`${leg.code}:${tab}`);
      }
      return rows.sort();
    };

    await seedAnchor(SYMBOL, { positionBucket: 'gte_two_thirds' }); // 收租 · 深度
    const rentDeep = await useCase.execute(SYMBOL, 'all', NOW);
    const membershipDeep = await membership();
    await prisma.anchor.update({
      where: { ticker: SYMBOL },
      data: { positionBucketManual: 'lt_one_third' },
    });
    const rentShallow = await useCase.execute(SYMBOL, 'all', NOW); // 收租 · 贴ATM侧
    const membershipShallow = await membership();
    await prisma.anchor.update({
      where: { ticker: SYMBOL },
      data: { positionBucketManual: null, positionBucketSetAt: null },
    });
    const pending = await useCase.execute(SYMBOL, 'all', NOW); // 待定
    const membershipPending = await membership();

    // 三种意图下标各不相同 —— 否则下面的「集合不变」是平凡的。
    expect(marked(rentDeep)).not.toEqual(marked(rentShallow));
    expect(marked(pending)).toEqual([]);
    expect(marked(rentDeep).length).toBeGreaterThan(0);
    expect(marked(rentShallow).length).toBeGreaterThan(0);

    // 🚨 打标零拦截: 成员关系、门槛计数、月度链标全都一行不动。
    expect(membershipShallow).toEqual(membershipDeep);
    expect(membershipPending).toEqual(membershipDeep);
    expect(membershipDeep.length).toBeGreaterThan(0);
    expect(rentShallow.gateCounts).toEqual(rentDeep.gateCounts);
    expect(pending.gateCounts).toEqual(rentDeep.gateCounts);
    // 月度链标与意图正交 —— 它只看 vendor 的到期周期。
    const monthlyOf = (v: LegTableView) =>
      v.legs.filter((l) => l.isMonthlyChain).map((l) => l.code);
    expect(monthlyOf(pending)).toEqual(monthlyOf(rentDeep));
    expect(monthlyOf(rentDeep)).toHaveLength(1); // 非空 ⇒ 上面那条不是平凡绿
  });
});
