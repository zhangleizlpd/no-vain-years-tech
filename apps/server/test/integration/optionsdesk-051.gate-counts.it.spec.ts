import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { GetLegsUseCase, type LegTableView } from '../../src/optionsdesk/get-legs.usecase';
import { PrismaLegRetrievalAdapter } from '../../src/optionsdesk/leg-retrieval.adapter';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';

// 051 T001 按视角拆的流动性排除计数 IT (FR-006a, SC-012)。
//
// ## 为什么**必须**要真 PG
//
// 承 `optionsdesk-050.recall.it.spec.ts` 的三条理由, 本片新增的那个数把第 ③ 条又加重一层:
// per-view 计数是**对整批行按判据分组的统计**, 而分组用的期限段判据吃的是从 PG 读回来的
// `Decimal` (有效成本 `K − bid < spot` 严格小于)。把 `findMany` mock 掉, 「建仓数与实际被挡的
// 建仓候选逐条相等」就退化成同义反复 —— 而本片要防的失败形态恰恰是**「两个数都有、都是合理的
// 正整数、只是其中一个统计错了视角」**。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。装配 = `new GetLegsUseCase(prisma, new PrismaLegRetrievalAdapter(prisma), stubTradingCalendar())` 打真 `PrismaService`。
//
// 🚨 **数据集蓄意不对称** (基线 `build 0 / rent 2`): 两个数相等的话把它们接反照样绿。
//
// 🚨 **重叠区不变量取不等式, MUST NOT 取等号** (SC-012): `[30,49]` 是 050 刻意保留的重叠区,
// 一条落其中且被流动性挡下的腿在标量记 1 次、在两个分视角数里**各**记 1 次 ⇒ 恒有
// `标量 ≤ build + rent`。写 `toBe(build + rent)` 会在重叠区红, 而**红的是测试不是代码** ——
// 顺着它「修代码去凑等号」会把 050 花力气保住的重叠语义拆掉。本文件测 ③ 同时钉死这一点:
// 追加那条重叠腿后 `标量 3 < build 1 + rent 3`, 等号断言在此**必红**。
describe('051 T001 流动性排除计数按视角拆分 (Testcontainers PG, 逐条相等 + 重叠区不等式)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let useCase: GetLegsUseCase;

  /** 请求时刻 = 2026-08-04 ET 16:00 ⇒ 交易所的今天恒为 2026-08-04 (沿 050 同族)。 */
  const NOW = new Date('2026-08-04T20:00:00.000Z');
  const TODAY = '2026-08-04';
  /** OI 归属日 (Guardrail 6: 与 sessionDate 蓄意差一天)。 */
  const PREV_SESSION = '2026-08-03';

  const SYMBOL = 'us:PEP';
  /**
   * 067 起 V 取 170 ⇒ W = 136 > spot 132.40 ⇒ 成色轴 axis = min(spot, W) 退化为 spot ——
   * 本文件的对象是流动性排除计数, 与换轴无关, 锚放**恒等域**让全部既有断言逐值照旧
   * (重叠区腿 K=125 在 W=120 下会双维不过而失去 sole-failure 归因, 正是要避开的串台)。
   */
  const V = '170';
  const SPOT = '132.4000';

  /** DTE 10 —— 只进建仓段 `[1,49]`。 */
  const BUILD_EXPIRY = '2026-08-14';
  /** DTE 38 —— 落两段的**重叠区** `[30,49]`, 本文件测 ③ 的主角。 */
  const OVERLAP_EXPIRY = '2026-09-11';
  /** DTE 164 —— 只进收租段 `[30,365]`。 */
  const RENT_EXPIRY = '2027-01-15';
  /** DTE 400 —— 两个意图段都够不着。 */
  const TOO_LONG_EXPIRY = '2027-09-08';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    useCase = new GetLegsUseCase(
      prisma,
      new PrismaLegRetrievalAdapter(prisma),
      stubTradingCalendar(),
    );
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

  // ── 造数 (形态承 050 同族) ────────────────────────────────────────────────────

  async function seedAnchor(ticker: string): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker,
        market: ticker.split(':')[0]!,
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
    root: string;
    expiry: string;
    strike: string;
    bid: string | null;
    ask: string | null;
    delta: string | null;
  }

  /** 一条合约 + 该期一行快照。返回 vendor code, 供逐条对账时按 code 找回。 */
  async function seedLeg(instrumentId: bigint, fixture: LegFixture): Promise<string> {
    // OCC 体例: 行权价 ×1000 取整 ⇒ 小数档也能得到唯一且可读的 code。
    const strikePart = Math.round(Number(fixture.strike) * 1000);
    const code = `US.${fixture.root}${fixture.expiry.replaceAll('-', '').slice(2)}P${strikePart}`;
    const contract = await prisma.optionContract.create({
      data: {
        market: 'us',
        code,
        root: fixture.root,
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
   * 基线数据集 —— 六条腿, 三条是**绊线**。
   *
   * 🚨 **蓄意不对称**: `build 0 / rent 2`。两个数相等的话「把 build 与 rent 接反」这种错法
   * 照样全绿, 而那恰恰是本片最可能出的错。
   *
   * 三条绊线各自防一种「数字合理但统计错了」的实现:
   * · `buildCostFailWide` —— 只按 DTE 段分组 (漏掉有效成本硬判据) ⇒ build 会多 1。
   * · `tooLongWide`       —— 拿「被流动性挡下」当唯一判据 (漏掉期限段前置) ⇒ 两个数都会多 1。
   * · `penny`             —— 对已被权利金门槛移出响应的腿照样计数 ⇒ build 会多 1。
   */
  async function seedBaseline(): Promise<Record<string, string>> {
    const id = await seedInstrument('PEP');
    const codes: Record<string, string> = {};

    // 对照组: 相对价差 0.10/2.05 ≈ 4.9% ⇒ 过流动性门槛, 正常进建仓 Tab, 不进任何计数。
    codes.cleanBuild = await seedLeg(id, {
      root: 'PEP',
      expiry: BUILD_EXPIRY,
      strike: '125',
      bid: '2.00',
      ask: '2.10',
      delta: '-0.35',
    });
    // ① 相对价差 12.00/14.00 ≈ 85.7% > 35% ⇒ 被挡; DTE 164 只在收租段 ⇒ **只**记收租。
    codes.rentOnlyWide = await seedLeg(id, {
      root: 'PEP',
      expiry: RENT_EXPIRY,
      strike: '120',
      bid: '8.00',
      ask: '20.00',
      delta: '-0.30',
    });
    // ① 无 ask ⇒ 算不出价差 ⇒ 流动性 fail-closed; DTE 164 ⇒ 同样**只**记收租。
    codes.rentOnlyNoAsk = await seedLeg(id, {
      root: 'PEP',
      expiry: RENT_EXPIRY,
      strike: '118',
      bid: '7.00',
      ask: null,
      delta: '-0.28',
    });
    // 🪤 有效成本 136 − 3.00 = 133.00 **>** spot 132.40 ⇒ 期限段判据下它进不了建仓。
    // 价差 6.00/6.00 = 100% 被流动性挡下, 但它本就不是建仓候选 ⇒ **两个数都不该动**。
    codes.buildCostFailWide = await seedLeg(id, {
      root: 'PEP',
      expiry: BUILD_EXPIRY,
      strike: '136',
      bid: '3.00',
      ask: '9.00',
      delta: '-0.55',
    });
    // 🪤 DTE 400 两个意图段都够不着 ⇒ 它出局与流动性无关, 计进去会稀释掉这个数唯一的用途。
    codes.tooLongWide = await seedLeg(id, {
      root: 'PEP',
      expiry: TOO_LONG_EXPIRY,
      strike: '110',
      bid: '6.00',
      ask: '18.00',
      delta: '-0.20',
    });
    // 🪤 bid 0.03 < 权利金门槛 max(0.20, 132.40 × 0.0018) = 0.2383 ⇒ 从响应**整条移出**。
    // 它的价差 (0.05/0.055 ≈ 91%) 同时超流动性门槛、DTE 与有效成本却都合格 ⇒ 串台绊线。
    codes.penny = await seedLeg(id, {
      root: 'PEP',
      expiry: BUILD_EXPIRY,
      strike: '100',
      bid: '0.03',
      ask: '0.08',
      delta: '-0.02',
    });
    return codes;
  }

  /**
   * 重叠区那条腿 —— DTE 38 ∈ `[30,49]`, 有效成本 125 − 2.00 = 123.00 < 132.40 (过),
   * 相对价差 4.00/4.00 = 100% (被挡) ⇒ 期限段上它**同时**是建仓候选与收租候选。
   */
  async function seedOverlapExcluded(instrumentCode = 'PEP'): Promise<string> {
    const id = (
      await prisma.instrument.findFirstOrThrow({
        where: { market: 'us', code: instrumentCode },
        select: { id: true },
      })
    ).id;
    return seedLeg(id, {
      root: 'PEP',
      expiry: OVERLAP_EXPIRY,
      strike: '125',
      bid: '2.00',
      ask: '6.00',
      delta: '-0.38',
    });
  }

  // 🚨 053 起一次请求只作答一个视角 ⇒「取该视角的成员」就是取全部腿 (每腿的 `tabs` 随之退役)。
  // 保留 `tab` 参数是为了让「拿错视角的 view 去断言」**当场炸** —— 原来那句 `filter` 会把它
  // 静默滤成空集, 而空集在下面几条断言里照样能绿。
  const inTab = (view: LegTableView, tab: 'all' | 'build' | 'rent'): string[] => {
    if (view.perspective !== tab) {
      throw new Error(`view 是 ${view.perspective} 视角, 断言问的却是 ${tab}`);
    }
    return view.legs.map((l) => l.code);
  };

  // ── ① / ② 两个分视角数与实际被挡的候选**逐条相等** ────────────────────────────
  it('① 建仓数 ② 收租数各自与该视角实际被挡的候选逐条相等 (蓄意不对称: 0 / 2)', async () => {
    await seedAnchor(SYMBOL);
    const codes = await seedBaseline();

    // 🚨 053 FR-001: 每个视角自己问自己那一份 —— 「该视角被挡了几条」现在是那一次请求的回答。
    const view = await useCase.execute(SYMBOL, 'all', NOW);
    const buildCounts = (await useCase.execute(SYMBOL, 'build', NOW)).gateCounts;
    const rentCounts = (await useCase.execute(SYMBOL, 'rent', NOW)).gateCounts;

    expect(view.state).toBe('available');

    // 「逐条」= 先把这两个数各自对应的腿显式列出来, 再断言计数等于它们的条数 ——
    // 🚫 只断言数字的话, 数字对了而对应的是别的腿这种错法照样绿。
    const expectedExcludedFromBuild: string[] = [];
    const expectedExcludedFromRent = [codes.rentOnlyWide, codes.rentOnlyNoAsk];

    // 🚨 053 T003 起契约面只有这一个标量, 它就是「**该视角自己的**排除数」。
    expect(buildCounts.excludedFromIntentTabs).toBe(expectedExcludedFromBuild.length);
    expect(rentCounts.excludedFromIntentTabs).toBe(expectedExcludedFromRent.length);
    // 🚨 两个数**蓄意不等** (0 / 2): 标量若退回 051 那个「两个意图视角合计」的口径, 建仓那条
    // 当场红 —— 而它的数字照样真实、文案照样通顺, 只是指向了别的视角的腿。
    expect(buildCounts.excludedFromIntentTabs).not.toBe(rentCounts.excludedFromIntentTabs);
    // 全腿视角不受流动性门槛约束 (FR-006) ⇒ 它那份恒 0。
    expect(view.gateCounts.excludedFromIntentTabs).toBe(0);

    // 计数对应的腿**仍在全腿视角可达** —— 这是它与权利金门槛那个数的语义分界 (053 起要两次请求)。
    const inAll = await useCase.execute(SYMBOL, 'all', NOW);
    const inRent = await useCase.execute(SYMBOL, 'rent', NOW);
    for (const code of expectedExcludedFromRent) {
      expect(inTab(inAll, 'all')).toContain(code);
      expect(inTab(inRent, 'rent')).not.toContain(code);
    }
    // 三条绊线各自不该出现在任何一个意图 Tab 的排除计数里, 逐条钉死它们的去向:
    // 被权利金门槛移出的腿**不在响应里** (故也不可能被计数)。
    expect(inTab(inAll, 'all')).not.toContain(codes.penny);
    // 期限段本就不合格的两条留在响应, 但两个数都不因它们而动 (已由上面的 toEqual 覆盖)。
    expect(inTab(inAll, 'all')).toEqual(
      expect.arrayContaining([codes.buildCostFailWide, codes.tooLongWide]),
    );
    // 对照组照常进建仓视角 ⇒ 「build 计数为 0」不是因为根本没有建仓候选。
    const inBuild = await useCase.execute(SYMBOL, 'build', NOW);
    expect(inTab(inBuild, 'build')).toEqual([codes.cleanBuild]);
  });

  // ── ③ 重叠区不变量: 标量 ≤ build + rent (🚨 MUST NOT 取等号) ──────────────────
  it('③ 重叠区腿使两个分视角数**各 +1** 而标量只 +1 ⇒ 标量 ≤ build + rent (SC-012)', async () => {
    await seedAnchor(SYMBOL);
    await seedBaseline();

    // 🚨 053 FR-001 起「双计」换了形态: 一次请求只答一个视角 ⇒ 同一条重叠区腿在**两次请求里
    // 各计一次**, 而每一次请求内部标量与该视角那一格恒相等 ⇒ 052 那条「标量 ≤ build + rent」
    // 的不等式随拆请求整条消失 (spec Clarifications 逐字)。本条改守它的实质: 重叠区腿让**两个
    // 意图视角各自**的排除数都 +1。
    const excludedIn = async (perspective: 'all' | 'build' | 'rent') =>
      (await useCase.execute(SYMBOL, perspective, NOW)).gateCounts.excludedFromIntentTabs;
    const beforeBuild = await excludedIn('build');
    const beforeRent = await excludedIn('rent');
    const beforeAll = await excludedIn('all');

    await seedOverlapExcluded();
    const afterBuild = await excludedIn('build');
    const afterRent = await excludedIn('rent');

    // 一条腿, 两次请求各 +1 —— 重叠区 `[30,49]` 是刻意的, 它同时被两个意图视角挡下。
    // 🚨 052 那条「标量 < build + rent」的严格不等式**已随拆请求 + 契约收窄整条失去对象**:
    // 响应里只剩一个数, 且它只说本次视角的事。本条改守那件事的实质 —— 同一条腿在两个意图
    // 视角**各被数一次**, 谁也没替谁作答。
    expect(afterBuild - beforeBuild).toBe(1);
    expect(afterRent - beforeRent).toBe(1);
    // 上面两条不是「两边都是 0」的平凡绿。
    expect(afterBuild).toBeGreaterThan(0);
    expect(afterRent).toBeGreaterThan(0);
    // 🚨 全腿视角**一动不动**且恒 0 (FR-006 不受流动性门槛约束) —— 若哪天有人把别的视角的
    // 计数混回单次响应, 这条当场红。
    expect([beforeAll, await excludedIn('all')]).toEqual([0, 0]);
  });

  // ── 空态: 没有链就没有腿被挡下 ────────────────────────────────────────────────
  it('链未就绪 → 三个数全 0 (新字段与既有两个数同口径: 是计数不是「未知」)', async () => {
    await seedAnchor(SYMBOL);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.state).toBe('chain_not_ready');
    expect(view.gateCounts).toEqual({ removedByPremiumFloor: 0, excludedFromIntentTabs: 0 });
  });
});
