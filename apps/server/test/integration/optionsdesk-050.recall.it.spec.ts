import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { GetLegsUseCase, type LegTableView } from '../../src/optionsdesk/get-legs.usecase';
import type { LegTab } from '../../src/optionsdesk/leg-tab.rules';

// 050 T005 召回集合 IT (US1 全 4 条 + US2 全 5 条 AS, SC-001 / SC-003)。
//
// ## 为什么**必须**要真 PG
//
// ① **判据比的是从 PG 读回来的 `Decimal`** —— 有效成本取**严格小于** (`K − bid < spot`), 而
//    `strike_price` / `bid` / `underlying_spot` 是三列 `@db.Decimal`, 各自的 scale 不同。
//    「恰好相等」这个边界 (测 ①b) 只有在真的走过一遍 numeric 往返之后才验得准: mock 里手写
//    `new Prisma.Decimal('132.40')` 等于把答案当入参喂进去。
// ② **召回作用在读端过滤之后的那批行上** —— 仅认沽 / 仅标准 / 到期日 `>` 当日 (FR-010) 是三条
//    SQL 谓词, 同期多来源去重是一段真查询。把 `findMany` mock 掉, 「召回集成员逐条相等」就退化
//    成同义反复 —— 而**召回换代的失败形态恰恰是「返回了腿、数量也合理、只是成员错了」**。
// ③ **两个门槛计数是对整批行的统计** —— 分母 (`chain.rows.length`) 来自真查询, mock 上分母由
//    测试自己给, 计数与实际条数「逐次相等」(SC-003) 就无从谈起。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。装配 = 直接 `new GetLegsUseCase(prisma)` 打真 `PrismaService`
// (样板 `optionsdesk-047.leg-picker.it.spec.ts`)。
//
// 🚨 **断言一律是「成员集合逐条相等」, 🚫 MUST NOT 写 `length > 0`** —— 后者对本片要防的失败
// 形态完全没有分辨力。
//
// 🚨 **造数纪律** (承 047): 行权价别取到「内在价值 > ask」—— 采集侧落库前的硬门会整批拒掉。
// 本文件绕过采集直接落库, 仍照同一形态造。⚠️ 唯一的例外是 `costFail` / `costTie` 两条,
// 它们的 **bid 蓄意低于内在价值** (深实值腿在真实链上就是这样报的) —— 那正是「有效成本 ≥ spot」
// 唯一可能出现的形态; 但它们的 **ask 仍高于内在价值**, 采集端的硬门照样过得去。
describe('050 T005 召回集合 (Testcontainers PG, 成员逐条相等)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let useCase: GetLegsUseCase;

  /** 请求时刻 = 2026-08-04 ET 16:00 ⇒ 交易所的今天恒为 2026-08-04 (基准由 `marketDateFor`)。 */
  const NOW = new Date('2026-08-04T20:00:00.000Z');
  const TODAY = '2026-08-04';
  /** OI 归属日 (Guardrail 6: 与 sessionDate 蓄意差一天)。 */
  const PREV_SESSION = '2026-08-03';

  const SYMBOL = 'us:PEP';
  /** V = 150 ⇒ W = 120; spot 132.40 落 [W, V) = 卖put区。050 下锚轴已不参与成员判定。 */
  const V = '150';
  const SPOT = '132.4000';

  /** DTE 10 —— 只进建仓段 `[1,49]`。 */
  const BUILD_EXPIRY = '2026-08-14';
  /** DTE 38 —— 落两段的**重叠区** `[30,49]` (US1-AS2, 刻意重叠不是重复)。 */
  const OVERLAP_EXPIRY = '2026-09-11';
  /** DTE 164 —— 只进收租段 `[30,365]`。 */
  const RENT_EXPIRY = '2027-01-15';
  /** DTE 400 —— 两个意图段都够不着 (US1-AS4)。 */
  const TOO_LONG_EXPIRY = '2027-09-08';

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

  async function seedAnchor(ticker: string): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker,
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
    /** 支持小数行权价 (`costTie` 要它落在 `K − bid == spot` 那个点上)。 */
    strike: string;
    bid: string | null;
    ask: string | null;
    delta: string | null;
    greeksComplete?: boolean;
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
        greeksComplete: fixture.greeksComplete ?? true,
      },
    });
    return contract.code;
  }

  /**
   * 主数据集 —— 十条腿, **每条各自证明召回判据的一个分支**, 无一条是陪衬。
   *
   * 🚨 判据之间蓄意**不重叠**: 每条腿只违反 (或只命中) 一条判据 ⇒ 某条断言红了能直接定位到
   * 是哪条判据坏了, 而不是「几条判据里总有一条」。
   */
  async function seedMainDataset(): Promise<Record<string, string>> {
    const id = await seedInstrument('PEP');
    const codes: Record<string, string> = {};

    // US1-AS1 有效成本 136 − 3.00 = 133.00 **>** spot 132.40 ⇒ 不进建仓。
    // 🚨 |Δ| 0.55 ∧ DTE 10 —— 047 的旧建仓带 (`[0.40,0.55]` ∧ `≤14`) **照收**它, 这正是本条要防的。
    codes.costFail = await seedLeg(id, {
      root: 'PEP',
      expiry: BUILD_EXPIRY,
      strike: '136',
      bid: '3.00',
      ask: '3.70',
      delta: '-0.55',
    });
    // 边界: 有效成本 135.40 − 3.00 = 132.40 **恰好等于** spot ⇒ 仍不进建仓 (判据是严格小于)。
    // 成本持平时「用 put 代替直接买」没有任何优势, 只多出被指派的不确定性。
    codes.costTie = await seedLeg(id, {
      root: 'PEP',
      expiry: BUILD_EXPIRY,
      strike: '135.40',
      bid: '3.00',
      ask: '3.70',
      delta: '-0.52',
    });
    // US1-AS2 DTE 38 落重叠区 ⇒ 建仓 + 收租**同时**进。
    codes.overlap = await seedLeg(id, {
      root: 'PEP',
      expiry: OVERLAP_EXPIRY,
      strike: '125',
      bid: '2.00',
      ask: '2.10',
      delta: '-0.35',
    });
    // US1-AS3 greeks 缺失但其余全合格 ⇒ 照常进意图召回集 (047 下被 Δ 带挡在两个意图 Tab 之外)。
    codes.greeksMissing = await seedLeg(id, {
      root: 'PEP',
      expiry: OVERLAP_EXPIRY,
      strike: '124',
      bid: '1.80',
      ask: '1.90',
      delta: null,
      greeksComplete: false,
    });
    // 只进收租段 (DTE 164 ∈ (49,365])。
    codes.rentOnly = await seedLeg(id, {
      root: 'PEP',
      expiry: RENT_EXPIRY,
      strike: '120',
      bid: '8.00',
      ask: '8.20',
      delta: '-0.30',
    });
    // US1-AS4 DTE 400 ⇒ 两个意图都不进, 全腿 Tab 可见。
    codes.tooLong = await seedLeg(id, {
      root: 'PEP',
      expiry: TOO_LONG_EXPIRY,
      strike: '110',
      bid: '6.00',
      ask: '6.30',
      delta: '-0.20',
    });
    // US2-AS1 bid 0.03 < 权利金门槛 max(0.20, 132.40 × 0.0018) = 0.2383 ⇒ 三个 Tab 一律不见。
    // 🚨 它的价差 (0.05/0.055 ≈ 91%) 同时超流动性门槛, DTE / 有效成本却都合格 —— **串台绊线**:
    // 若实现对已移出的腿照样算流动性排除, `excludedFromIntentTabs` 会跟着多 1。
    codes.penny = await seedLeg(id, {
      root: 'PEP',
      expiry: BUILD_EXPIRY,
      strike: '100',
      bid: '0.03',
      ask: '0.08',
      delta: '-0.02',
    });
    // US2-AS3 完全无 bid ⇒ 按「不满足权利金门槛」处置 (🚫 禁当 0)。无 ask ⇒ 同为串台绊线。
    codes.noBid = await seedLeg(id, {
      root: 'PEP',
      expiry: BUILD_EXPIRY,
      strike: '128',
      bid: null,
      ask: null,
      delta: '-0.40',
    });
    // US2-AS2 相对价差 6.00/6.00 = 100% > 35% ⇒ 出意图 Tab, **留在响应与全腿 Tab**。
    codes.wideSpread = await seedLeg(id, {
      root: 'PEP',
      expiry: BUILD_EXPIRY,
      strike: '126',
      bid: '3.00',
      ask: '9.00',
      delta: '-0.42',
    });
    // US2-AS4 有 bid 无 ask ⇒ 算不出价差 ⇒ 流动性 fail-closed (宁可少收不可错收)。
    codes.noAsk = await seedLeg(id, {
      root: 'PEP',
      expiry: BUILD_EXPIRY,
      strike: '127',
      bid: '2.50',
      ask: null,
      delta: '-0.44',
    });
    return codes;
  }

  const inTab = (view: LegTableView, tab: LegTab): string[] =>
    view.legs.filter((l) => l.tabs.includes(tab)).map((l) => l.code);
  const legOf = (view: LegTableView, code: string) => view.legs.find((l) => l.code === code);

  // ── ① 三个 Tab 的成员集合逐条相等 + 两个计数 (SC-001 / SC-003) ────────────────
  it('① 三个 Tab 的成员**逐条相等**, 两个门槛计数各自与实际条数相等 (SC-003)', async () => {
    await seedAnchor(SYMBOL);
    const codes = await seedMainDataset();

    const view = await useCase.execute(SYMBOL, NOW);

    expect(view.state).toBe('available');
    // 🚨 集合相等而非 `length > 0`: 召回换代的失败形态是「返回了腿、数量也合理、只是成员错了」。
    expect(new Set(inTab(view, 'all'))).toEqual(
      new Set([
        codes.costFail,
        codes.costTie,
        codes.overlap,
        codes.greeksMissing,
        codes.rentOnly,
        codes.tooLong,
        codes.wideSpread,
        codes.noAsk,
      ]),
    );
    expect(new Set(inTab(view, 'build'))).toEqual(new Set([codes.overlap, codes.greeksMissing]));
    expect(new Set(inTab(view, 'rent'))).toEqual(
      new Set([codes.overlap, codes.greeksMissing, codes.rentOnly]),
    );
    // 落库 10 条 − 权利金移出 2 条 = 响应 8 条; 流动性排除 2 条**仍在这 8 条里**。
    expect(view.legs).toHaveLength(8);
    // 051 FR-006a: 那 2 条 (`wideSpread` / `noAsk`) DTE 均为 10 ⇒ 只够得着建仓段 ⇒ 全落 build。
    expect(view.gateCounts).toEqual({
      removedByPremiumFloor: 2,
      excludedFromIntentTabs: 2,
      excludedFromIntentTabsByTab: { build: 2, rent: 0 },
    });
  });

  it('①b 🚨 SC-001: 建仓集内**零条**腿的有效成本 ≥ spot (含恰好相等那条, 判据是严格小于)', async () => {
    await seedAnchor(SYMBOL);
    const codes = await seedMainDataset();

    const view = await useCase.execute(SYMBOL, NOW);
    const spot = view.spot!;

    const build = view.legs.filter((l) => l.tabs.includes('build'));
    // 全量核对: 一条不漏地过一遍, 而不是抽查那两条构造出来的。
    expect(build.length).toBeGreaterThan(0); // 空集合会让下面那条平凡为真
    for (const leg of build) {
      expect(leg.bid).not.toBeNull();
      expect(leg.strike.minus(leg.bid!).lessThan(spot)).toBe(true);
    }
    // 两条构造腿点名不在建仓集内 —— 133.00 > 132.40 与 132.40 == 132.40。
    expect(inTab(view, 'build')).not.toContain(codes.costFail);
    expect(inTab(view, 'build')).not.toContain(codes.costTie);
    // 🚨 它们**没有消失**: 有效成本判据只作用建仓, 全腿 Tab 照常收 (Edge Case「误加到收租不会红」)。
    expect(legOf(view, codes.costTie)?.tabs).toEqual(['all']);
    expect(legOf(view, codes.costTie)?.effectiveCost?.toFixed(2)).toBe('132.40');
  });

  // ── ② 重叠区: 同一张合约进两个意图 ──────────────────────────────────────────
  it('② US1-AS2: DTE 38 落 `[30,49]` 重叠区 ⇒ 建仓与收租**同时**收它 (刻意重叠不是重复)', async () => {
    await seedAnchor(SYMBOL);
    const codes = await seedMainDataset();

    const view = await useCase.execute(SYMBOL, NOW);

    const leg = legOf(view, codes.overlap);
    expect(leg?.dteDays).toBe(38);
    expect(leg?.tabs).toEqual(['all', 'build', 'rent']);
    // 对照: DTE 164 只进收租, DTE 10 的那批一条都进不了收租 —— 重叠是**段界的产物**不是巧合。
    expect(legOf(view, codes.rentOnly)?.tabs).toEqual(['all', 'rent']);
  });

  // ── ③ greeks 缺失照常进意图召回集 (与 047 相反) ─────────────────────────────
  it('③ US1-AS3: greeks 缺失的腿**在**意图 Tab 里 —— Δ 已降级为打标量 (FR-009)', async () => {
    await seedAnchor(SYMBOL);
    const codes = await seedMainDataset();

    const view = await useCase.execute(SYMBOL, NOW);

    const leg = legOf(view, codes.greeksMissing);
    expect(leg?.greeksComplete).toBe(false);
    expect(leg?.absDelta).toBeNull();
    // 🚨 这条断言在 047 下是反的 (缺 Δ ⇒ 两个意图 Tab 都进不去)。翻转本身就是 US1-AS3。
    expect(leg?.tabs).toEqual(['all', 'build', 'rent']);
    // 不判档仍成立 —— 召回收它与判档不判它是两件正交的事 (047 FR-007 一行不改)。
    expect(leg?.tier).toBeNull();
  });

  // ── ④ 超长腿只在全腿 Tab ────────────────────────────────────────────────────
  it('④ US1-AS4: DTE 400 两个意图都不进, 但**仍在全腿 Tab 可见**', async () => {
    await seedAnchor(SYMBOL);
    const codes = await seedMainDataset();

    const view = await useCase.execute(SYMBOL, NOW);

    const leg = legOf(view, codes.tooLong);
    expect(leg?.dteDays).toBe(400);
    expect(leg?.tabs).toEqual(['all']);
    // 🚨 它的价差合格 ⇒ 出局的原因是期限段, 与流动性无关 ⇒ **不计入** excludedFromIntentTabs。
    // 把它算进去会让「流动性排除 N 条」失去它唯一的用途 (提示该注意的流动性信号)。
    expect(view.gateCounts.excludedFromIntentTabs).toBe(2);
  });

  // ── ⑤ 权利金门槛: 移出响应 (真消失) ─────────────────────────────────────────
  it('⑤ US2-AS1/AS3: 一分钱腿与无 bid 腿**三个 Tab 全不见**, 只让 removedByPremiumFloor 动', async () => {
    await seedAnchor(SYMBOL);
    const codes = await seedMainDataset();

    const view = await useCase.execute(SYMBOL, NOW);

    // 先证明它们**确实落库了** —— 否则「不出现」可能只是压根没造出来。
    const stored = await prisma.optionContract.count({ where: { market: 'us' } });
    expect(stored).toBe(10);
    for (const code of [codes.penny, codes.noBid]) {
      expect(legOf(view, code)).toBeUndefined();
      expect(inTab(view, 'all')).not.toContain(code);
    }
    expect(view.gateCounts.removedByPremiumFloor).toBe(2);
    // 🚨 串台绊线: 这两条同时是宽价差 / 无 ask, 但它们已不在响应里 ⇒ 不属于「流动性排除」。
    // 计成 4 就说明流动性判据被施加在权利金门槛之前 (或对已移出的腿照样统计)。
    expect(view.gateCounts.excludedFromIntentTabs).toBe(2);
  });

  it('⑤b 无 bid **不是** bid = 0: 它走的是权利金门槛那条路, 不是「白拿股票」的有效成本', async () => {
    await seedAnchor('us:VICI');
    const id = await seedInstrument('VICI');
    // 只造一条无报价腿。若实现把无 bid 当 0, 有效成本 = 128 − 0 = 128 < 132.40 ⇒ 它会进建仓,
    // 且 removedByPremiumFloor 恒 0 —— 两条断言各自都能抓到那种写法。
    await seedLeg(id, {
      root: 'VICI',
      expiry: BUILD_EXPIRY,
      strike: '128',
      bid: null,
      ask: null,
      delta: '-0.40',
    });

    const view = await useCase.execute('us:VICI', NOW);

    expect(view.legs).toEqual([]);
    expect(view.gateCounts).toEqual({
      removedByPremiumFloor: 1,
      excludedFromIntentTabs: 0,
      excludedFromIntentTabsByTab: { build: 0, rent: 0 },
    });
  });

  // ── ⑥ 流动性门槛: 出意图 Tab 但**不消失** ───────────────────────────────────
  it('⑥ US2-AS2/AS4: 宽价差与无 ask 两条**留在响应与全腿 Tab**, 只让 excludedFromIntentTabs 动', async () => {
    await seedAnchor(SYMBOL);
    const codes = await seedMainDataset();

    const view = await useCase.execute(SYMBOL, NOW);

    for (const code of [codes.wideSpread, codes.noAsk]) {
      const leg = legOf(view, code);
      expect(leg).toBeDefined();
      // 🚨 「排除出意图 Tab」不等于「消失」—— 报价与派生列照常在, 客户端仍看得到这条腿。
      expect(leg?.tabs).toEqual(['all']);
      expect(leg?.bid).not.toBeNull();
    }
    // 无 ask ⇒ 算不出相对价差 ⇒ fail-closed (不是 fail-open 放行)。
    expect(legOf(view, codes.noAsk)?.ask).toBeNull();
    expect(view.gateCounts.excludedFromIntentTabs).toBe(2);
    expect(view.gateCounts.removedByPremiumFloor).toBe(2); // 与它俩无关, 由 ⑤ 那两条贡献
  });

  // ── ⑦ 某 Tab 被清空 → 空集合而非 404 ────────────────────────────────────────
  it('⑦ US2-AS5: 两个意图 Tab 全空 → 返空集合且**不是 404**, 面板照常有数据', async () => {
    await seedAnchor('us:VICI');
    const id = await seedInstrument('VICI');
    // 只有超长腿 ⇒ 建仓与收租都够不着; 两条都过得了门槛 ⇒ 空 Tab 与门槛无关。
    await seedLeg(id, {
      root: 'VICI',
      expiry: TOO_LONG_EXPIRY,
      strike: '110',
      bid: '6.00',
      ask: '6.30',
      delta: '-0.20',
    });
    await seedLeg(id, {
      root: 'VICI',
      expiry: TOO_LONG_EXPIRY,
      strike: '105',
      bid: '5.00',
      ask: '5.30',
      delta: '-0.18',
    });

    const view = await useCase.execute('us:VICI', NOW);

    expect(view.state).toBe('available');
    expect(inTab(view, 'build')).toEqual([]);
    expect(inTab(view, 'rent')).toEqual([]);
    // 🚨 空 Tab 不是错误也不是隐藏: 全腿 Tab 照常有数据, 锚派生那半边照常在。
    expect(inTab(view, 'all')).toHaveLength(2);
    expect(view.w.toFixed(4)).toBe('120.0000');
    expect(view.gateCounts).toEqual({
      removedByPremiumFloor: 0,
      excludedFromIntentTabs: 0,
      excludedFromIntentTabsByTab: { build: 0, rent: 0 },
    });
  });

  it('⑦b 未建锚的 symbol 才是 404 —— 「Tab 空」与「没有锚」是两回事', async () => {
    await expect(useCase.execute('us:NOPE', NOW)).rejects.toMatchObject({ status: 404 });
  });
});
