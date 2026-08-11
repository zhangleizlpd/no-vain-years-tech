import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { GetLegsUseCase, type LegTableView } from '../../src/optionsdesk/get-legs.usecase';
import {
  BUILD_RECOMMEND_ABS_DELTA_BAND,
  RENT_RECOMMEND_ABS_DELTA_BANDS,
} from '../../src/optionsdesk/leg-mark.rules';

// 050 T009 打标层 IT (US3 全 6 条 AS, SC-005)。
//
// ## 为什么**必须**要真 PG
//
// ① **月度链标的判据是一次真的日历范围查询** —— 「该月第三个周五; 该日非交易日则取其前一交易日」
//    读的是 `marketdata.trading_day`。测 ④⑤ 的判别性全在**表里有没有那一行**上: 假日回退那条
//    分支只有真的往表里**少插一行**才走得到 (测 ⑤), mock 上「返回哪几天」由测试自己给, 等于把
//    答案当入参喂进去。
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
describe('050 T009 打标层 (Testcontainers PG, 真交易日历)', () => {
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
  /** 2026-08 的第三个周五 (DTE 17) —— 测 ⑤ 把它**从日历里抽掉**造假日。 */
  const AUG_MONTHLY_EXPIRY = '2026-08-21';
  /** 抽掉之后应当接住标的那一天 (前一交易日)。 */
  const AUG_MONTHLY_FALLBACK = '2026-08-20';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    useCase = new GetLegsUseCase(prisma);
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

  /**
   * 交易日历。🚨 **不 seed 就没有月度链标** —— `resolveMonthlyExpiries` 拿不到任何交易日会
   * 返回空集合 (那是「日历没覆盖到」的事实, 不是故障), 测 ④ 会退化成平凡绿。
   *
   * @param skip 从日历里**抽掉**的日子 —— 测 ⑤ 用它造「第三个周五是市场假日」。
   */
  async function seedTradingDays(skip: readonly string[] = []): Promise<void> {
    // 覆盖 [最早候选日 − 7, 最晚候选日] 那个窗口: 08 月与 09 月两个候选日各自的前后。
    const days = [
      '2026-08-13',
      '2026-08-14',
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      AUG_MONTHLY_FALLBACK,
      AUG_MONTHLY_EXPIRY,
      '2026-09-10',
      OVERLAP_EXPIRY,
      '2026-09-17',
      MONTHLY_EXPIRY,
    ].filter((d) => !skip.includes(d));
    await prisma.tradingDay.createMany({
      data: days.map((d) => ({ market: 'us', date: dateOf(d) })),
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
    await seedTradingDays();

    const view = await useCase.execute(SYMBOL, NOW);

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
    await seedTradingDays();

    const view = await useCase.execute(SYMBOL, NOW);

    expect(view.intent).toBe('rent');
    expect(view.rentDepth).toBe('deep');
    const band = RENT_RECOMMEND_ABS_DELTA_BANDS.deep;

    // 建仓 Tab 里确实有腿 (五条全在重叠区), 否则下面的断言是平凡的。
    const inBuildTab = view.legs.filter((l) => l.tabs.includes('build'));
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
    // |Δ| 0.45 那条在建仓 Tab 里, 却**不带标** —— 建仓带在收租意图下整个不生效。
    expect(legOf(view, codes.atm)?.tabs).toContain('build');
    expect(legOf(view, codes.atm)?.isRecommended).toBe(false);
  });

  it('②b 🚨 FR-011: 同一条腿同时在建仓与收租 Tab, 两处的标**是同一个值** (标不随 Tab 变)', async () => {
    await seedAnchor(SYMBOL, { positionBucket: 'gte_two_thirds' });
    const id = await seedInstrument('PEP');
    const codes = await seedDeltaLadder(id);
    await seedTradingDays();

    const view = await useCase.execute(SYMBOL, NOW);

    // 标是**每腿一个标量**, 不是 per-Tab 的 map —— 这条断言在结构上就成立, 写出来是为了让
    // 「按 Tab 拆成 map」那种改法 (option B/C) 一旦发生就有一处红。
    const deep = legOf(view, codes.deep)!;
    expect(deep.tabs).toEqual(['all', 'build', 'rent']);
    expect(deep.isRecommended).toBe(true);
    expect(Object.keys(deep)).not.toContain('isRecommendedByTab');
  });

  // ── ③ 水位未选 → 全表零推荐标 (US3-AS3) ─────────────────────────────────────
  it('③ US3-AS3: 收租但水位未选 → 全表**零**推荐标 (🚫 不取三档并集替人做方向性假设)', async () => {
    await seedAnchor(SYMBOL, { positionBucket: null });
    const id = await seedInstrument('PEP');
    await seedDeltaLadder(id);
    await seedTradingDays();

    const view = await useCase.execute(SYMBOL, NOW);

    expect(view.intent).toBe('pending');
    expect(view.rentDepth).toBeNull();
    // 🚨 三档并集是 [0.05,0.40] —— 阶梯里有三条腿落在里面。取并集的实现会打出 3 个标,
    // 那正是 Guardrail 1 的坑; 正确行为是一个都不打。
    expect(marked(view)).toEqual([]);
    // 腿数据照常全量呈现 (FR-021: 没有方向不等于没有数据)。
    expect(view.legs).toHaveLength(5);
  });

  // ── ④ 月度链标: 真日历表 (US3-AS4) ──────────────────────────────────────────
  it('④ US3-AS4: 到期日 = 该月第三个周五 → 该到期日下**全部**腿带月度链标', async () => {
    await seedAnchor(SYMBOL);
    const id = await seedInstrument('PEP');
    await seedDeltaLadder(id); // 五条都在 09-11 (非月度日)
    // 同一到期日两条腿 —— 「该到期日下全部腿都带标」要 ≥2 条才验得出。
    const monthlyA = await seedLeg(id, {
      expiry: MONTHLY_EXPIRY,
      strike: '126',
      bid: '2.00',
      ask: '2.10',
      delta: '-0.30',
    });
    const monthlyB = await seedLeg(id, {
      expiry: MONTHLY_EXPIRY,
      strike: '124',
      bid: '1.70',
      ask: '1.80',
      delta: '-0.26',
    });
    await seedTradingDays();

    const view = await useCase.execute(SYMBOL, NOW);

    const monthly = view.legs.filter((l) => l.isMonthlyChain).map((l) => l.code);
    // 逐条相等: 恰好那两条, 一条不多一条不少。
    expect(new Set(monthly)).toEqual(new Set([monthlyA, monthlyB]));
    // 09-11 那批是周链 ⇒ 不带标。它证明这个标不是恒 true。
    expect(view.legs.filter((l) => !l.isMonthlyChain)).toHaveLength(5);
  });

  // ── ⑤ 第三个周五是假日 → 标落前一交易日 (US3-AS5) ───────────────────────────
  it('⑤ US3-AS5: 🚨 第三个周五**从日历里抽掉** → 月度标落到前一交易日, 而不是没有标', async () => {
    await seedAnchor(SYMBOL);
    const id = await seedInstrument('PEP');
    // 08 月: 第三个周五 (08-21) 与它的前一交易日 (08-20) 各造一条腿。
    const onHoliday = await seedLeg(id, {
      expiry: AUG_MONTHLY_EXPIRY,
      strike: '128',
      bid: '1.20',
      ask: '1.30',
      delta: '-0.28',
    });
    const onFallback = await seedLeg(id, {
      expiry: AUG_MONTHLY_FALLBACK,
      strike: '128',
      bid: '1.10',
      ask: '1.20',
      delta: '-0.27',
    });
    // 🚨 判别性全在这一行: 把 08-21 从 `trading_day` 里抽掉 = 那天是市场假日。
    await seedTradingDays([AUG_MONTHLY_EXPIRY]);

    const view = await useCase.execute(SYMBOL, NOW);

    // 判据是「该月的月度到期日」而不是「是不是周五」⇒ 标落在提前后的那天。
    expect(legOf(view, onFallback)?.isMonthlyChain).toBe(true);
    expect(legOf(view, onHoliday)?.isMonthlyChain).toBe(false);
    // 反向对照: 日历完整时标就落回周五那天 —— 证明上面的翻转来自那一行, 不是别的原因。
    await prisma.tradingDay.create({ data: { market: 'us', date: dateOf(AUG_MONTHLY_EXPIRY) } });
    const restored = await useCase.execute(SYMBOL, NOW);
    expect(legOf(restored, onHoliday)?.isMonthlyChain).toBe(true);
    expect(legOf(restored, onFallback)?.isMonthlyChain).toBe(false);
  });

  // ── ⑥ 打标零拦截 (US3-AS6) ──────────────────────────────────────────────────
  it('⑥ US3-AS6: 切换意图与水位 ⇒ 标全变, 而三个 Tab 的成员集合与两个计数**一行不动**', async () => {
    const id = await seedInstrument('PEP');
    await seedDeltaLadder(id);
    await seedTradingDays();

    const membership = (view: LegTableView) =>
      view.legs.map((l) => `${l.code}:${[...l.tabs].join('+')}`).sort();

    await seedAnchor(SYMBOL, { positionBucket: 'gte_two_thirds' }); // 收租 · 深度
    const rentDeep = await useCase.execute(SYMBOL, NOW);
    await prisma.anchor.update({
      where: { ticker: SYMBOL },
      data: { positionBucketManual: 'lt_one_third' },
    });
    const rentShallow = await useCase.execute(SYMBOL, NOW); // 收租 · 贴ATM侧
    await prisma.anchor.update({
      where: { ticker: SYMBOL },
      data: { positionBucketManual: null, positionBucketSetAt: null },
    });
    const pending = await useCase.execute(SYMBOL, NOW); // 待定

    // 三种意图下标各不相同 —— 否则下面的「集合不变」是平凡的。
    expect(marked(rentDeep)).not.toEqual(marked(rentShallow));
    expect(marked(pending)).toEqual([]);
    expect(marked(rentDeep).length).toBeGreaterThan(0);
    expect(marked(rentShallow).length).toBeGreaterThan(0);

    // 🚨 打标零拦截: 成员关系、门槛计数、月度链标全都一行不动。
    expect(membership(rentShallow)).toEqual(membership(rentDeep));
    expect(membership(pending)).toEqual(membership(rentDeep));
    expect(rentShallow.gateCounts).toEqual(rentDeep.gateCounts);
    expect(pending.gateCounts).toEqual(rentDeep.gateCounts);
    // 月度链标与意图正交 —— 它只看到期日。
    const monthlyOf = (v: LegTableView) =>
      v.legs.filter((l) => l.isMonthlyChain).map((l) => l.code);
    expect(monthlyOf(pending)).toEqual(monthlyOf(rentDeep));
  });
});
