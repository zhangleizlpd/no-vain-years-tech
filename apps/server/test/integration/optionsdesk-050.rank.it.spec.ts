import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { GetLegsUseCase, type LegTableView } from '../../src/optionsdesk/get-legs.usecase';
import { PrismaLegRetrievalAdapter } from '../../src/optionsdesk/leg-retrieval.adapter';
import { BASIS_BY_TAB } from '../../src/optionsdesk/leg-rank.rules';
import { LEG_TABS, type LegTab } from '../../src/optionsdesk/leg-tab.rules';

// 050 T013 精排 + 一致性 IT (US4 全 5 条 AS, SC-006)。
//
// ## 为什么**必须**要真 PG
//
// ① **三份有序列表各按自己的口径排** —— 判据的价值全在「每份都是那次请求真的派生出来的产物」
//    上; mock 掉数据源等于把顺序写成常量, 断言退化成平凡绿。
// ② **确定性 (SC-006) 要跨两次真请求验** —— 同一份库数据连打两次, 顺序逐行相同。单测里两次
//    调用同一个 stub 是同一条内存数组, 验不到「重新查库 → 重新派生」这条路径。
// ③ 档位口径跟 Tab 走 (FR-023) 是**费率 → 档界**整条链的产物, 而费率的分母来自真的合约行。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。样板 `optionsdesk-050.mark.it.spec.ts` / `.recall.it.spec.ts`。
describe('050 T013 精排层 (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let useCase: GetLegsUseCase;

  const NOW = new Date('2026-08-04T20:00:00.000Z');
  const TODAY = '2026-08-04';
  const PREV_SESSION = '2026-08-03';

  const SYMBOL = 'us:PEP';
  const SPOT = '132.4000';
  /** V = 150 ⇒ W = 120; spot 132.40 落 [W, V) = 卖put区。意图与本片排序无关, 钉住免得漂。 */
  const V = '150';

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

  async function seedAnchor(): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        v: V,
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8', // ≥7 ⇒ L2
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        positionBucketManual: 'gte_two_thirds',
        positionBucketSetAt: new Date('2026-08-01T02:00:00Z'),
      },
    });
  }

  /** 覆盖两段窗口: 最近一个已收盘交易日 + 月度候选日附近 (标本身与排序无关, 不 seed 也不炸)。 */
  async function seedTradingDays(): Promise<void> {
    await prisma.tradingDay.createMany({
      data: [
        PREV_SESSION,
        TODAY,
        '2026-08-14',
        '2026-08-20',
        '2026-08-21',
        '2026-09-17',
        '2026-09-18',
        '2027-01-14',
        '2027-01-15',
      ].map((d) => ({ market: 'us', date: dateOf(d) })),
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
    delta: string;
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
        greeksComplete: true,
      },
    });
    return contract.code;
  }

  /**
   * 主数据集 —— 五条腿蓄意让**三个 Tab 的顺序各不相同**, 且周化 / 年化两个口径判出不同档:
   *
   * | 腿          | DTE | 视角归属         | 周化    | 年化   | build 档   | rent/all 档 |
   * | ----------- | --- | ---------------- | ------- | ------ | ---------- | ----------- |
   * | `shortHigh` | 10  | all + build      | 1.373%  | 71.6%  | acceptable | good        |
   * | `longHigh`  | 45  | all + build+rent | 0.399%  | 20.8%  | dead       | good        |
   * | `overlap`   | 38  | all + build+rent | 0.299%  | 15.6%  | dead       | good        |
   * | `shortLow`  | 10  | all + build      | 0.275%  | 14.3%  | dead       | acceptable  |
   * | `rentOnly`  | 164 | all + rent       | —       | 12.3%  | (非成员)   | acceptable  |
   *
   * 🚨 判别性的两个来源:
   * - `longHigh` (DTE 45) 的费率高于 `shortLow` (DTE 10) ⇒ **US4-AS3**「DTE 高而费率高的腿排在
   *   DTE 低而费率低之前」不是碰巧, 而是这份数据构造出来的 —— 任何「离理想 DTE 越近越靠前」的
   *   实现都会把这两条对调 (FR-022)。
   * - `overlap` 在 build 判 `dead`、在 rent / all 判 `good` ⇒ **US4-AS4** 有了同一条腿在两个视角
   *   判出不同档的实例, 也顺带证明「全腿 Tab 用周化档界会让长腿整列死档」那条否决理由 (FR-023)。
   */
  async function seedLadder(instrumentId: bigint): Promise<Record<string, string>> {
    const codes: Record<string, string> = {};
    codes.shortHigh = await seedLeg(instrumentId, {
      expiry: '2026-08-14',
      strike: '130',
      bid: '2.50',
      ask: '2.60',
      delta: '-0.45',
    });
    codes.longHigh = await seedLeg(instrumentId, {
      expiry: '2026-09-18',
      strike: '120',
      bid: '3.00',
      ask: '3.10',
      delta: '-0.30',
    });
    codes.overlap = await seedLeg(instrumentId, {
      expiry: '2026-09-11',
      strike: '125',
      bid: '2.00',
      ask: '2.10',
      delta: '-0.25',
    });
    codes.shortLow = await seedLeg(instrumentId, {
      expiry: '2026-08-14',
      strike: '128',
      bid: '0.50',
      ask: '0.60',
      delta: '-0.20',
    });
    codes.rentOnly = await seedLeg(instrumentId, {
      expiry: '2027-01-15',
      strike: '115',
      bid: '6.00',
      ask: '6.10',
      delta: '-0.15',
    });
    return codes;
  }

  async function seedAll(): Promise<Record<string, string>> {
    await seedAnchor();
    const id = await seedInstrument('PEP');
    const codes = await seedLadder(id);
    await seedTradingDays();
    return codes;
  }

  const legOf = (view: LegTableView, code: string) => view.legs.find((l) => l.code === code);
  /** 该 Tab 口径下的费率 —— 顺序对两个口径**同序** (单调变换), 故这里取哪个都验得出降序。 */
  const rateOf = (view: LegTableView, code: string, tab: LegTab): number => {
    const leg = legOf(view, code);
    const rate = BASIS_BY_TAB[tab] === 'weekly' ? leg?.weeklyRate : leg?.annualizedRate;
    return rate === null || rate === undefined ? Number.NEGATIVE_INFINITY : rate.toNumber();
  };

  /**
   * 053 FR-001 起三个视角是**三次独立请求** —— 本文件的判据 (三份列表各按自己的口径排) 一字
   * 不变, 变的只是取数次数。🚫 MUST NOT 把三份拼回一个 view: 那会把「每次只答一个视角」这条
   * 抹掉, 而拼出来的东西照样断言得动。
   */
  const viewsOf = async () => ({
    all: await useCase.execute(SYMBOL, 'all', NOW),
    build: await useCase.execute(SYMBOL, 'build', NOW),
    rent: await useCase.execute(SYMBOL, 'rent', NOW),
  });

  // ── ① 三份有序列表各自按折算费率降序 (US4-AS1) ──────────────────────────────
  it('① US4-AS1: 三份有序列表各自按该 Tab 口径的折算费率**降序**, client 不必重排', async () => {
    const codes = await seedAll();
    const views = await viewsOf();
    const view = views.all;

    // fixture 自证: DTE 是手算的, 错了下面全部推导都不成立。
    expect(legOf(view, codes.shortHigh)?.dteDays).toBe(10);
    expect(legOf(view, codes.overlap)?.dteDays).toBe(38);
    expect(legOf(view, codes.longHigh)?.dteDays).toBe(45);
    expect(legOf(view, codes.rentOnly)?.dteDays).toBe(164);

    // 逐条相等而不是「非空」—— 精排的失败形态是「返回了腿、数量也对、只是次序错了」。
    // 📌 053 FR-005 起 `legs` **就是**那份有序列表 (`tabOrder` 随之退役)。
    expect(views.build.legs.map((l) => l.code)).toEqual([
      codes.shortHigh,
      codes.longHigh,
      codes.overlap,
      codes.shortLow,
    ]);
    expect(views.rent.legs.map((l) => l.code)).toEqual([
      codes.longHigh,
      codes.overlap,
      codes.rentOnly,
    ]);
    expect(view.legs.map((l) => l.code)).toEqual([
      codes.shortHigh,
      codes.longHigh,
      codes.overlap,
      codes.shortLow,
      codes.rentOnly,
    ]);
    // 三份列表**互不相同** ⇒ 上面三条不是同一个顺序被抄了三遍。
    expect(views.build.legs.map((l) => l.code)).not.toEqual(view.legs.map((l) => l.code));
    expect(views.rent.legs.map((l) => l.code)).not.toEqual(view.legs.map((l) => l.code));

    // 全量核对: 每份列表相邻两行的费率单调不增。
    for (const tab of LEG_TABS) {
      const perTab = views[tab];
      const rates = perTab.legs.map((leg) => rateOf(perTab, leg.code, tab));
      for (let i = 1; i < rates.length; i += 1) {
        expect([tab, i, rates[i - 1] >= rates[i]]).toEqual([tab, i, true]);
      }
    }
  });

  // ── ② 连续两次请求逐行相同 (US4-AS2, SC-006) ────────────────────────────────
  it('② US4-AS2 / SC-006: 同一输入连续两次请求, 三个 Tab 的顺序逐行相同', async () => {
    await seedAll();

    // 053 FR-001 起三份顺序由三次请求各自产出 ⇒ 「两次请求逐行相同」要三个视角各打两遍。
    const first = await viewsOf();
    const second = await viewsOf();

    for (const tab of LEG_TABS) {
      expect([tab, second[tab].legs.map((l) => l.code)]).toEqual([
        tab,
        first[tab].legs.map((l) => l.code),
      ]);
    }
  });

  it('②b 费率**完全相同**的两条腿 → 身份键定序, 且两次请求仍逐行相同', async () => {
    await seedAnchor();
    const id = await seedInstrument('PEP');
    // 同到期日同 bid、只有行权价差一档 ⇒ 费率不同; 故这里蓄意造**费率相同**的两条:
    // K 与 P 成比例 ⇒ P/(K−P) 相同。K=120/P=3 与 K=40/P=1 的期间费率都是 1/39。
    const high = await seedLeg(id, {
      expiry: '2026-09-11',
      strike: '120',
      bid: '3.00',
      ask: '3.10',
      delta: '-0.30',
    });
    const low = await seedLeg(id, {
      expiry: '2026-09-11',
      strike: '40',
      bid: '1.00',
      ask: '1.10',
      delta: '-0.10',
    });
    await seedTradingDays();

    const first = await useCase.execute(SYMBOL, 'rent', NOW);
    const second = await useCase.execute(SYMBOL, 'rent', NOW);

    expect(legOf(first, high)?.annualizedRate?.toString()).toBe(
      legOf(first, low)?.annualizedRate?.toString(),
    );
    // 主键分不出 → 身份键: 同到期日 ⇒ 行权价降序 ⇒ K=120 在前。
    expect(first.legs.map((l) => l.code)).toEqual([high, low]);
    expect(second.legs.map((l) => l.code)).toEqual(first.legs.map((l) => l.code));
  });

  // ── ③ 同腿两 Tab 档位可不同、all 恒年化 (US4-AS4) ───────────────────────────
  it('③ US4-AS4: 同一条腿在两个 Tab 的档位可不同; 全腿 Tab **恒年化**', async () => {
    const codes = await seedAll();
    const views = await viewsOf();

    // 同一条腿三个视角都收得到它 (053 起这是**三次请求各命中一次**, 不再是一个 `tabs` 数组)。
    for (const tab of LEG_TABS) {
      expect([tab, views[tab].legs.some((l) => l.code === codes.overlap)]).toEqual([tab, true]);
    }
    // 同一条腿: 周化 0.299% ⇒ 死档; 年化 15.6% ⇒ 好。档界之差是**口径之差**不是数据之差。
    expect(legOf(views.build, codes.overlap)?.tier).toBe('dead');
    expect(legOf(views.rent, codes.overlap)?.tier).toBe('good');
    // 🚨 全腿视角恒年化 —— 它与 rent 同值, 而与 build 不同。若 all 被改成跟着「腿主要属于哪个
    // 视角」走, 这一条会翻成 dead。
    expect(legOf(views.all, codes.overlap)?.tier).toBe('good');

    // 周化档界不是「一律死档」: 短高腿在 build 判 acceptable ⇒ 上面的 dead 是费率低不是口径坏。
    expect(legOf(views.build, codes.shortHigh)?.tier).toBe('acceptable');
    expect(legOf(views.all, codes.shortHigh)?.tier).toBe('good');
  });

  /**
   * 050 T015 的审计补口: 「`basis` 归属换代」是 T015 预期清单里的四类行为变化之一, 但**047 的
   * IT 一个字都没断言过 `basis`** ⇒ 它换代时不可能红。判别性靠 `overlap` 这条同时进两个意图
   * Tab 的腿: 047 按**腿族**归属 (`isBuildLeg` 要 `DTE≤14 ∧ |Δ|∈[.40,.55]`, 它 DTE 38 / Δ 0.35
   * 都不满足) ⇒ 年化; 050 按**建仓召回集成员**归属 ⇒ 周化。两代给的是不同的值。
   */
  it('③c 标量 `basis` 按**本次视角**归属 (D-RANK-3 / 053 FR-041, T015 补口)', async () => {
    const codes = await seedAll();
    const views = await viewsOf();

    // 同一条腿在建仓视角走周化 —— 尽管它同时也是收租成员 (047 的腿族归属会给年化)。
    const overlap = legOf(views.build, codes.overlap);
    expect(overlap?.basis).toBe('weekly');

    // 反向: 收租视角同一条腿走年化 —— 两条一起才排除「`basis` 被写死成某一个值」这种平凡绿。
    const rentOnly = legOf(views.rent, codes.rentOnly);
    expect(rentOnly?.basis).toBe('annualized');
  });

  // ── ⑤ DTE 高而费率高的腿排在前 (US4-AS3, FR-022) ────────────────────────────
  it('⑤ US4-AS3: DTE 45 而费率高的腿排在 DTE 10 而费率低的腿**之前** (DTE 不是排序主键)', async () => {
    const codes = await seedAll();
    const views = await viewsOf();
    const view = views.all;

    const build = views.build.legs.map((l) => l.code);
    expect(build.indexOf(codes.longHigh)).toBeLessThan(build.indexOf(codes.shortLow));
    // 判别性: 两条腿的 DTE 差 35 天而费率只差 0.12 个百分点 —— 任何把 DTE 拉进主键的实现
    // (「越短越靠前」/「离理想 DTE 越近越靠前」) 都会把它们对调。
    expect(legOf(view, codes.longHigh)?.dteDays).toBe(45);
    expect(legOf(view, codes.shortLow)?.dteDays).toBe(10);
    expect(rateOf(views.build, codes.longHigh, 'build')).toBeGreaterThan(
      rateOf(views.build, codes.shortLow, 'build'),
    );
    // 全腿 Tab 同样 (年化口径下差距更大)。
    const all = view.legs.map((l) => l.code);
    expect(all.indexOf(codes.longHigh)).toBeLessThan(all.indexOf(codes.shortLow));
  });
});
