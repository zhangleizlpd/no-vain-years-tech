import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import { PrismaService } from '../../src/security/prisma.service';
import { OptionSnapshotCoverageCheck } from '../../src/marketdata/option-snapshot-coverage.check';
import { GetLegsUseCase, type LegTableView } from '../../src/optionsdesk/get-legs.usecase';
import { PrismaLegRetrievalAdapter } from '../../src/optionsdesk/leg-retrieval.adapter';
import { toLegTableResponse } from '../../src/optionsdesk/optionsdesk.dto';
import { LEG_TABS, type LegTab } from '../../src/optionsdesk/leg-tab.rules';
import { DbTradingCalendarAdapter } from '../../src/marketdata/db-trading-calendar.adapter';

// 047 T029 选约表读端 IT (FR-005/006/007/008/013/014/016/020/021/041, SC-004)。
//
// ## 为什么**必须**要真 PG
//
// 本文件验的四件事在 mock 上全部**不成立**, 且不会红、只会静默退化成平凡绿:
//   ① **两条过滤都是 SQL 谓词** —— 非标 (`is_standard`) 与已到期 (`expiry_date > 今日`) 写在
//      `option_contract` 的 WHERE 里。把 `findMany` mock 掉等于把结果集当入参喂进去,
//      「非标一行不出现」就退化成同义反复。
//   ② **Guardrail 7 的两侧口径住在两个 module 里** —— 读端滤 `>` (已到期不可交易)、完整性
//      分母用 `>=` (当日到期照样该采到)。这个**蓄意的差一天**只有在同一份真数据上同时跑两条
//      查询才验得出来; 各自 mock 各自的返回值, 差异就永远看不见 (见测 ⑩)。
//   ③ **「最近一期」是 `ORDER BY session_date DESC LIMIT 1`** —— 「当日没采到 ≠ 没有数据」这条
//      降级 (测 ②) 的全部实现就是那条排序; mock 里由测试自己指定哪期最新, 等于没验。
//   ④ **「链数据未就绪」与「读故障」蓄意分成两个 state** —— 前者要求真的查得到「表里没有行」,
//      而不是抛异常 (测 ③)。mock 上「返回空数组」是手写的, 证明不了真库的行为。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。装配 = `new GetLegsUseCase(prisma, new PrismaLegRetrievalAdapter(prisma), new DbTradingCalendarAdapter(prisma))` 打真 `PrismaService`
// (样板 `optionsdesk-047.chain-sync.it.spec.ts` / `optionsdesk-047.integrity.it.spec.ts`)。
//
// 🚨 **造数两个坑** (T023 实撞过): 标的行的 `last` 别抄成期权价、行权价别取到「内在价值 > ask」
// —— 两者都会被采集侧落库前硬门整批拒掉。本文件虽然绕过采集直接落库, 仍照同一形态造
// (spot 132.40 高于全部 PUT 行权价 ⇒ 虚值侧), 免得这批数据将来被喂回采集路径时突然不合法。
// ## 050 T015 逐条过的结论 (2026-08-11)
//
// 召回层换代后本文件**一条没红**。逐条核对下来这不是「判据没生效」, 而是**这份数据集对
// 047 → 050 的四类行为变化全不判别** —— 每条腿在两套判据下的 Tab 归属逐条相同:
//
// | 腿                        | 047 判据                  | 050 判据                        | 归属 |
// | ------------------------- | ------------------------- | ------------------------------- | ---- |
// | 收租 3 条 + bulk 60 条    | `DTE∈[150,365]` ∧ `K≤W`   | `DTE∈[30,365]` ∧ 两道门槛       | 同   |
// | 建仓 1 条 (DTE 10, K=130) | `DTE≤14` ∧ `|Δ|∈[.40,.55]` | `DTE∈[1,49]` ∧ 有效成本 < spot  | 同   |
// | greeks 缺失 (DTE 164)     | 锚轴不看 Δ ⇒ 进收租        | 召回签名里没有 Δ ⇒ 进收租       | 同   |
//
// 另两类变化在本文件里**压根没有判据**: 全部 bid ≥ 0.20 且相对价差 < 35% ⇒ 两道门槛一次都没
// 触发; `basis` 一个字都没断言过。⇒ 它们「该红却绿」的原因是**没有断言**, 不是断言失效。
//
// 🚨 **判别性归 050 的三个 IT** (`optionsdesk-050.recall/mark/rank.it.spec.ts`): 召回集合逐条
// 相等、两个门槛计数、`K > W` 的腿进收租 (锚轴退役的绊线)、`basis` 按建仓召回集归属。本文件
// 保持 047 的原始判据面**不扩写** —— 它守的是「读端过滤 / 状态分支 / Guardrail 6·7」那一层,
// 那一层 050 一行没动。
describe('047 T029 选约表读端 (Testcontainers PG, 真过滤谓词)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let useCase: GetLegsUseCase;

  /** 请求时刻 = 2026-08-04 ET 16:00 ⇒ 交易所的今天恒为 2026-08-04 (基准由 `marketDateFor`)。 */
  const NOW = new Date('2026-08-04T20:00:00.000Z');
  const TODAY = '2026-08-04';
  /** 上一交易日 —— 完整性核对的基线日 (测 ⑩) 与 OI 归属日 (Guardrail 6) 共用。 */
  const PREV_SESSION = '2026-08-03';
  /** 「快照非当日」用的陈旧期 (上周五)。 */
  const STALE_SESSION = '2026-07-31';

  const SYMBOL = 'us:PEP';
  /** V = 150 ⇒ W = 120, 内段 [90, 180); spot 132.40 落 [W, V) = 卖put区 (thin)。 */
  const V = '150';
  const SPOT = '132.4000';
  /** 2026-08-04 → 2027-01-15 = 164 天: 047 的 `[150,365]` 与 050 的 `[30,365]` **都收**。 */
  const RENT_EXPIRY = '2027-01-15';
  /** → 2026-08-14 = 10 天: 047 的 `≤14` 与 050 的 `[1,49]` **都收**。 */
  const BUILD_EXPIRY = '2026-08-14';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    useCase = new GetLegsUseCase(
      prisma,
      new PrismaLegRetrievalAdapter(prisma),
      new DbTradingCalendarAdapter(prisma),
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
    await prisma.calendarCoverage.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
  });

  // ── 造数 ──────────────────────────────────────────────────────────────────

  async function seedAnchor(
    ticker: string,
    opts: { confidence?: string; positionBucket?: string | null } = {},
  ): Promise<void> {
    const confidence = opts.confidence ?? '8'; // ≥7 ⇒ L2
    await prisma.anchor.create({
      data: {
        ticker,
        market: ticker.split(':')[0]!,
        v: V,
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence,
        confidenceSource: 'manual',
        // 生效 L 层由写侧求值并落列; 本文件只读, 故按 confidence 直接给出对应档。
        lLevelEffective: Number(confidence) >= 9 ? 'L1' : Number(confidence) >= 7 ? 'L2' : 'L4',
        positionBucketManual:
          opts.positionBucket === undefined ? 'gte_two_thirds' : opts.positionBucket,
        positionBucketSetAt: opts.positionBucket === null ? null : new Date('2026-08-01T02:00:00Z'),
      },
    });
  }

  /**
   * 新鲜度档的基准表 (T027a)。🚨 **不 seed 就没有基准** —— `freshnessTier` 会 fail-open 判
   * `CURRENT`, 「陈旧」那一档在 IT 里永远走不到, 断言退化成平凡绿。`beforeEach` 每轮清表,
   * 所以要用这一档的用例各自显式调 (体例同 046 那两个 IT)。
   */
  async function seedTradingDays(): Promise<void> {
    await prisma.tradingDay.createMany({
      data: [STALE_SESSION, PREV_SESSION, TODAY].map((d) => ({ market: 'us', date: dateOf(d) })),
    });
    // 🚨 062 T010: 只 seed `trading_day` 仍不够 —— 收盘上界落在覆盖声明之外时端口返 `null`
    // ⇒ 又落回 fail-open 恒判 CURRENT, 「陈旧」那一档照样走不到。
    await seedCalendarCoverage();
  }

  /** 覆盖声明: 062 起「基准日可不可信」的唯一判据。 */
  async function seedCalendarCoverage(): Promise<void> {
    await prisma.calendarCoverage.create({
      data: {
        market: 'us',
        coveredFrom: dateOf('2026-01-01'),
        coveredTo: dateOf('2099-12-31'),
        servedBy: 'it-seed',
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
    strike: number;
    bid: string | null;
    ask: string | null;
    delta: string | null;
    greeksComplete?: boolean;
    isStandard?: boolean;
  }

  /** 一条合约 + 该期一行快照。返回 vendor code, 供逐条对账时按 code 找回。 */
  async function seedLeg(
    instrumentId: bigint,
    fixture: LegFixture,
    session: string,
  ): Promise<string> {
    const suffix = fixture.isStandard === false ? '1' : '';
    const code = `US.${fixture.root}${suffix}${fixture.expiry.replaceAll('-', '').slice(2)}P${fixture.strike}000`;
    const contract = await prisma.optionContract.create({
      data: {
        market: 'us',
        code,
        root: `${fixture.root}${suffix}`,
        underlyingInstrumentId: instrumentId,
        expiryDate: dateOf(fixture.expiry),
        strikePrice: String(fixture.strike),
        optionType: 'PUT',
        isStandard: fixture.isStandard ?? true,
      },
      select: { id: true, code: true },
    });
    await seedSnapshot(contract.id, session, fixture);
    return contract.code;
  }

  async function seedSnapshot(
    contractId: bigint,
    session: string,
    fixture: Pick<LegFixture, 'bid' | 'ask' | 'delta' | 'greeksComplete'>,
  ): Promise<void> {
    await prisma.optionDailySnapshot.create({
      data: {
        contractId,
        sessionDate: dateOf(session),
        source: 'eod',
        quoteAsOf: new Date(`${session}T20:31:07Z`),
        // 🚨 Guardrail 6: OI 盘前更新 ⇒ 收盘后采的快照, 其 OI 归属**上一交易日**, 与 asOf 差一天。
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
  }

  /**
   * 主数据集 —— 一票覆盖 verify 清单的全部形态。返回各腿 code 以便逐条对账。
   *
   * 🚨 `bulk` 60 条是**反截断**的量: 任何 top-N / 分页只要存在, 这个数就对不上 (FR-005)。
   */
  async function seedMainDataset(session: string): Promise<{
    instrumentId: bigint;
    codes: Record<string, string>;
    bulkCount: number;
  }> {
    const instrumentId = await seedInstrument('PEP');
    const codes: Record<string, string> = {};
    // 收租长腿 (DTE 164 落两套判据的收租段): 年化 ≈ 15.9% / 11.2% ⇒ 好 / 可接受。
    codes.rentGood = await seedLeg(
      instrumentId,
      { root: 'PEP', expiry: RENT_EXPIRY, strike: 120, bid: '8.00', ask: '8.20', delta: '-0.30' },
      session,
    );
    codes.rentAcceptable = await seedLeg(
      instrumentId,
      { root: 'PEP', expiry: RENT_EXPIRY, strike: 115, bid: '5.50', ask: '5.70', delta: '-0.25' },
      session,
    );
    // 年化 ≈ 1.1% ⇒ **死档** (FR-006: 在表内, 排最后)。
    codes.dead = await seedLeg(
      instrumentId,
      { root: 'PEP', expiry: RENT_EXPIRY, strike: 100, bid: '0.50', ask: '0.60', delta: '-0.05' },
      session,
    );
    // 建仓腿 ⇒ 周化口径。047 靠 `DTE 10 ≤ 14 ∧ |Δ| 0.45 ∈ [0.40,0.55]`, 050 靠
    // `DTE 10 ∈ [1,49] ∧ 有效成本 130 − 1.60 = 128.40 < spot 132.40` —— 两套都收它。
    codes.build = await seedLeg(
      instrumentId,
      { root: 'PEP', expiry: BUILD_EXPIRY, strike: 130, bid: '1.60', ask: '1.70', delta: '-0.45' },
      session,
    );
    // greeks 缺失 (FR-007: 在表内、不判档)。🚫 **不是**「不进意图 Tab」—— 见测 ⑥。
    codes.greeksMissing = await seedLeg(
      instrumentId,
      {
        root: 'PEP',
        expiry: RENT_EXPIRY,
        strike: 118,
        bid: '4.00',
        ask: '4.10',
        delta: null,
        greeksComplete: false,
      },
      session,
    );
    // 非标 (调整过的 root) —— 采集侧照常落库 (FR-033), 选约表**一行不出现** (FR-008)。
    codes.nonStandard = await seedLeg(
      instrumentId,
      {
        root: 'PEP',
        expiry: RENT_EXPIRY,
        strike: 121,
        bid: '4.00',
        ask: '4.10',
        delta: '-0.28',
        isStandard: false,
      },
      session,
    );
    // 已到期 (FR-028a) 与**当日到期** (Guardrail 7 的 `>` 边界) —— 两条都不该出现在选约表。
    codes.expired = await seedLeg(
      instrumentId,
      { root: 'PEP', expiry: '2026-07-31', strike: 120, bid: '3.00', ask: '3.10', delta: '-0.30' },
      session,
    );
    codes.expiresToday = await seedLeg(
      instrumentId,
      { root: 'PEP', expiry: TODAY, strike: 120, bid: '1.00', ask: '1.10', delta: '-0.30' },
      session,
    );

    // 行权价 20–79: 与上面具名腿的 100/115/118/120/121 蓄意不重叠 (合约 code 唯一键含行权价),
    // 且 bid 2.50 让整段年化落在 7%–32% ⇒ 一条都不是死档, 「死档恰好一条且排最后」才验得准。
    const bulkCount = 60;
    for (let i = 0; i < bulkCount; i++) {
      await seedLeg(
        instrumentId,
        {
          root: 'PEP',
          expiry: RENT_EXPIRY,
          strike: 20 + i,
          bid: '2.50',
          ask: '2.60',
          delta: '-0.20',
        },
        session,
      );
    }
    return { instrumentId, codes, bulkCount };
  }

  const legOf = (view: LegTableView, code: string) => view.legs.find((l) => l.code === code);
  // 🚨 053 起一次请求只作答一个视角 ⇒「取该视角的成员」就是取全部腿 (每腿的 `tabs` 随之退役)。
  // 保留 `tab` 参数是为了让「拿错视角的 view 去断言」**当场炸** —— 原来那句 `filter` 会把它
  // 静默滤成空集, 而空集在下面几条断言里照样能绿。
  const inTab = (view: LegTableView, tab: LegTab) => {
    if (view.perspective !== tab) {
      throw new Error(`view 是 ${view.perspective} 视角, 断言问的却是 ${tab}`);
    }
    return view.legs;
  };

  // ── ① 当日快照 → 全量腿在结果内、无截断 (SC-004 逐条对账) ────────────────────
  it('① 当日快照 → 全量适格腿在表内, 零截断; 落库行数 vs 可见行数逐条对得上 (SC-004)', async () => {
    await seedAnchor(SYMBOL);
    const { instrumentId, codes, bulkCount } = await seedMainDataset(TODAY);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.state).toBe('available');
    // 逐条对账: 落库总数 − 非标 − 已到期 − 当日到期 = 可见数。三个扣减项都点名, 不留「差几行」。
    const stored = await prisma.optionContract.count({
      where: { underlyingInstrumentId: instrumentId },
    });
    const nonStandard = await prisma.optionContract.count({
      where: { underlyingInstrumentId: instrumentId, isStandard: false },
    });
    const notTradable = await prisma.optionContract.count({
      where: { underlyingInstrumentId: instrumentId, expiryDate: { lte: dateOf(TODAY) } },
    });
    expect(stored).toBe(bulkCount + 8);
    expect(nonStandard).toBe(1);
    expect(notTradable).toBe(2);
    expect(view.legs.length).toBe(stored - nonStandard - notTradable);
    // 死档与 greeks 缺失行**计入**可见数 —— 它们是「在表内」的, 不是被扣掉的那两类。
    expect(legOf(view, codes.dead)).toBeDefined();
    expect(legOf(view, codes.greeksMissing)).toBeDefined();
    // 无重复行 (同期多来源去重后每合约恰好一行)。
    expect(new Set(view.legs.map((l) => l.code)).size).toBe(view.legs.length);
  });

  it('① 区块 asOf = 当日, 且 OI 归属日与它**不是同一天** (Guardrail 6 / FR-013)', async () => {
    await seedAnchor(SYMBOL);
    await seedMainDataset(TODAY);
    await seedTradingDays();

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.asOf?.toISOString().slice(0, 10)).toBe(TODAY);
    expect(view.oiAsOf?.toISOString().slice(0, 10)).toBe(PREV_SESSION);
    expect(view.oiAsOf?.getTime()).not.toBe(view.asOf?.getTime());
    expect(view.source).toBe('eod');
    // T027a: 基准来自真 `trading_day` 的跨 ctx 读 —— 当日快照 ⇒ 当期。
    expect(view.lastClosedSession).toBe(TODAY);
    expect(toLegTableResponse(view).asOfFreshnessTier).toBe('CURRENT');
  });

  // ── ② 快照非当日 → 全表照常 + 陈旧 asOf ──────────────────────────────────────
  it('② 快照非当日 → 全表照常返回, asOf 是陈旧那期 (当日没采到 ≠ 没有数据, FR-014)', async () => {
    await seedAnchor(SYMBOL);
    const { codes, bulkCount } = await seedMainDataset(STALE_SESSION);
    await seedTradingDays();

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.state).toBe('available');
    expect(view.asOf?.toISOString().slice(0, 10)).toBe(STALE_SESSION);
    // 🚨 陈旧不等于减配: 可见行数与当日快照那一测**同一个数**, 一行都不少。
    expect(view.legs.length).toBe(bulkCount + 8 - 1 - 2);
    expect(legOf(view, codes.rentGood)).toBeDefined();
    // 🚨 T027a: 这一档正是本用例的名字所指, 但**必须 seed 了 `trading_day` 才走得到** ——
    // 不 seed 就落进 `freshnessTier` 的 fail-open 分支恒判 CURRENT, 断言退化成平凡绿
    // (那正是 046 那个「境内恒显已过时」缺陷当初混过 review 的形态)。
    expect(toLegTableResponse(view).asOfFreshnessTier).toBe('STALE');
  });

  // ── ③ 从无快照 → 「链数据未就绪」, 非空页非错误页 ────────────────────────────
  it('③ 从无快照 → chain_not_ready (锚派生照常给, 不是错误页, FR-014)', async () => {
    await seedAnchor(SYMBOL);
    const instrumentId = await seedInstrument('PEP');
    // 合约在、快照一行都没有 —— 「采集还没轮到」是事实, 不是故障。
    await prisma.optionContract.create({
      data: {
        market: 'us',
        code: 'US.PEP270115P120000',
        root: 'PEP',
        underlyingInstrumentId: instrumentId,
        expiryDate: dateOf(RENT_EXPIRY),
        strikePrice: '120',
        optionType: 'PUT',
        isStandard: true,
      },
    });

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.state).toBe('chain_not_ready');
    // 🚨 与 read_failed 蓄意分开 —— 两者混成一个 state 就分不清「还没到」与「坏了」。
    expect(view.state).not.toBe('read_failed');
    expect(view.legs).toEqual([]);
    // 非空页: 锚侧派生照常在 (W / L 层 / 水位), 客户端渲得出骨架而不是一片空白。
    expect(view.w.toFixed(4)).toBe('120.0000');
    expect(view.lLevel).toBe('L2');
    expect(view.positionBucket).toBe('gte_two_thirds');
    expect(view.asOf).toBeNull();
  });

  // ── ④ 非标一行不出现 ────────────────────────────────────────────────────────
  it('④ 非标合约: 库里在、选约表一行不出现 (FR-008 排除发生在读端不在采集端)', async () => {
    await seedAnchor(SYMBOL);
    const { instrumentId, codes } = await seedMainDataset(TODAY);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    // 先证明它**确实落库了** —— 否则这条断言可能只是「压根没造出来」。
    const stored = await prisma.optionContract.findUnique({
      where: { market_code: { market: 'us', code: codes.nonStandard } },
      select: { isStandard: true, underlyingInstrumentId: true },
    });
    expect(stored).toMatchObject({ isStandard: false, underlyingInstrumentId: instrumentId });
    expect(legOf(view, codes.nonStandard)).toBeUndefined();
    expect(view.legs.every((l) => !l.code.startsWith('US.PEP1'))).toBe(true);
  });

  // ── ⑤ 死档在表内、排最后 ────────────────────────────────────────────────────
  it('⑤ 死档: 在表内且排在最后 (FR-006 沉底但不剔除)', async () => {
    await seedAnchor(SYMBOL);
    const { codes } = await seedMainDataset(TODAY);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    const dead = legOf(view, codes.dead);
    expect(dead?.tier).toBe('dead');
    expect(view.legs.at(-1)?.code).toBe(codes.dead);
    // 未判档 (greeks 缺失) 排在死档**之前** —— 「不知道」不等于「已判死」。
    const deadIndex = view.legs.findIndex((l) => l.code === codes.dead);
    const unclassifiedIndex = view.legs.findIndex((l) => l.code === codes.greeksMissing);
    expect(unclassifiedIndex).toBeLessThan(deadIndex);
  });

  // ── ⑥ greeks 缺失在表内、不判档 ─────────────────────────────────────────────
  it('⑥ greeks 缺失: 在表内、不判档; 只挡住**要 Δ 的**判据, 锚轴照常收它 (FR-007)', async () => {
    await seedAnchor(SYMBOL);
    const { codes } = await seedMainDataset(TODAY);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    const leg = legOf(view, codes.greeksMissing);
    expect(leg).toBeDefined();
    expect(leg!.greeksComplete).toBe(false);
    expect(leg!.tier).toBeNull();
    // Guardrail 10: |Δ| 与 σ 距同源, 要么同时有值要么同时为空。
    expect(leg!.absDelta).toBeNull();
    expect(leg!.sigmaDistance).toBeNull();
    // 它进不了建仓 —— 📌 **050 起原因换了**: 047 是「缺 Δ 落不进建仓的 |Δ| 带」, 050 的召回
    // 签名里根本没有 Δ, 挡住它的是 `DTE 164 ∉ [1,49]`。两套判据同一个答案, 故本条一直是绿的。
    const inBuild = await useCase.execute(SYMBOL, 'build', NOW);
    expect(inBuild.legs.map((l) => l.code)).not.toContain(leg!.code);
    // 🚨 缺 Δ **不影响收租归属**: 047 走锚轴 `K ≤ W` (那条判据不看 Δ), 050 走 DTE 段 + 两道门槛
    // (`leg-recall.rules.ts` 的入参里没有 `absDelta`, 是结构保证不是约定)。两代实现的共同语义是
    // FR-021/FR-025 的 Tab 归属**零拦截** —— 缺数据只影响判档与着色, MUST NOT 拿它筛掉腿。
    // 哪天有人把 Δ 塞回召回判据, 本条会红 —— 那正是要提醒的时刻。
    const inRent = await useCase.execute(SYMBOL, 'rent', NOW);
    expect(inRent.legs.map((l) => l.code)).toContain(leg!.code);
    expect(view.legs.some((l) => l.greeksComplete === false && l.tier !== null)).toBe(false);
  });

  // ── ⑦ overvalued / L4 → 不开新仓, 腿数据照常全量 ───────────────────────────
  it('⑦ 不动区 (spot ≥ 1.2V) → 不开新仓, 腿数据照常全量 (FR-021 警示不拦数据)', async () => {
    await seedAnchor(SYMBOL);
    const { bulkCount } = await seedMainDataset(TODAY);
    // spot 抬到 1.2V = 180 上方 ⇒ 不动区。只改标的价, 合约集不动。
    await prisma.optionDailySnapshot.updateMany({ data: { underlyingSpot: '200.0000' } });

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.zone).toBe('overvalued');
    expect(view.intent).toBe('no_new_position');
    expect(view.rentDepth).toBeNull();
    expect(view.legs.length).toBe(bulkCount + 8 - 1 - 2);
  });

  it('⑦ L4 (confidence < 3) → 不开新仓, 且与水位档无关 (判据是「⟺ 不动区或 L4」)', async () => {
    await seedAnchor(SYMBOL, { confidence: '2' });
    const { bulkCount } = await seedMainDataset(TODAY);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.lLevel).toBe('L4');
    // spot 132.40 仍在卖put区 —— 不开新仓不是因为区间, 而是因为 L4。
    expect(view.zone).toBe('thin');
    expect(view.intent).toBe('no_new_position');
    expect(view.legs.length).toBe(bulkCount + 8 - 1 - 2);
  });

  // ── ⑧ 某 Tab 零适格腿 → 空集合而非 404 ──────────────────────────────────────
  it('⑧ 建仓 Tab 零适格腿 → 返空集合而非 404, 面板照常有数据 (FR-020)', async () => {
    await seedAnchor('us:VICI');
    const vici = await seedInstrument('VICI');
    // 只有长腿 (DTE 164) ⇒ 047 的 `DTE ≤ 14` 与 050 的 `DTE ∈ [1,49]` 都收不到它。
    await seedLeg(
      vici,
      { root: 'VICI', expiry: RENT_EXPIRY, strike: 115, bid: '5.50', ask: '5.70', delta: '-0.25' },
      TODAY,
    );
    await seedLeg(
      vici,
      { root: 'VICI', expiry: RENT_EXPIRY, strike: 110, bid: '5.00', ask: '5.20', delta: '-0.22' },
      TODAY,
    );

    // 053 FR-001: 每个视角各问一次 —— 「建仓视角空」现在是那一次请求自己的回答。
    const inAll = await useCase.execute('us:VICI', 'all', NOW);
    const inBuild = await useCase.execute('us:VICI', 'build', NOW);
    const inRent = await useCase.execute('us:VICI', 'rent', NOW);

    expect(inBuild.state).toBe('available');
    expect(inTab(inBuild, 'build')).toEqual([]);
    // 🚨 空视角不是错误也不是隐藏: 全腿与收租视角照常有数据, 区块状态仍是 available。
    expect(inTab(inAll, 'all').length).toBe(2);
    expect(inTab(inRent, 'rent').length).toBe(2);
  });

  it('⑧ 未建锚的 symbol 才是 404 —— 「Tab 空」与「没有锚」是两回事', async () => {
    await expect(useCase.execute('us:NOPE', 'all', NOW)).rejects.toMatchObject({
      status: 404,
    });
  });

  // ── ⑨ 未选水位 → 意图待定, 三 Tab 均可取数 ──────────────────────────────────
  it('⑨ 未选水位 → 意图「待定」且三个 Tab 全部可取数 (FR-016/017 未选是常驻分支)', async () => {
    await seedAnchor(SYMBOL, { positionBucket: null });
    const { bulkCount } = await seedMainDataset(TODAY);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.positionBucket).toBeNull();
    expect(view.positionBucketSource).toBeNull();
    expect(view.intent).toBe('pending');
    // 🚫 MUST NOT 静默落一个档位: rentDepth 为空而不是某一档。
    expect(view.rentDepth).toBeNull();
    // 🚨 三个 Tab 都取得出数 —— 未选水位不拦任何一屏 (面板不隐藏不置灰)。
    expect(view.legs.length).toBe(bulkCount + 8 - 1 - 2);
    // 🚨 三个视角逐个都取得出数 —— 未选水位不拦任何一屏 (面板不隐藏不置灰)。
    for (const tab of LEG_TABS) {
      const perTab = await useCase.execute(SYMBOL, tab, NOW);
      expect([tab, inTab(perTab, tab).length]).toEqual([tab, perTab.legs.length]);
      expect([tab, perTab.legs.length > 0]).toEqual([tab, true]);
    }
    expect(inTab(view, 'all').length).toBe(view.legs.length);
  });

  it('⑨ 已选水位 → 意图落矩阵输出, 且带「人工输入」来源标 (T028 写端同口径)', async () => {
    await seedAnchor(SYMBOL);
    await seedMainDataset(TODAY);

    const view = await useCase.execute(SYMBOL, 'all', NOW);

    expect(view.positionBucket).toBe('gte_two_thirds');
    expect(view.positionBucketSource).toBe('manual');
    expect(view.positionBucketSetAt).toEqual(new Date('2026-08-01T02:00:00Z'));
    // 卖put区 (d=0) + L2 (l=2) + 水位 ≥2/3 ⇒ 收租 · 深度。
    expect(view.intent).toBe('rent');
    expect(view.rentDepth).toBe('deep');
  });

  // ── ⑩ Guardrail 7 反向绊线: 读端 `>` vs 完整性分母 `>=` ─────────────────────
  it('⑩ 🚨 当日到期的腿: **不在**选约表里 (`>`), 却**在**完整性分母里 (`>=`) —— 差一天是蓄意的', async () => {
    await seedAnchor('us:VICI');
    const vici = await seedInstrument('VICI');
    const todayExpiry = await seedLeg(
      vici,
      { root: 'VICI', expiry: TODAY, strike: 30, bid: '0.40', ask: '0.50', delta: '-0.30' },
      TODAY,
    );
    const laterExpiry = await seedLeg(
      vici,
      { root: 'VICI', expiry: RENT_EXPIRY, strike: 28, bid: '2.20', ask: '2.30', delta: '-0.25' },
      TODAY,
    );
    // 完整性核对的分母取**基线日** (上一交易日) 的行 ⇒ 两条合约在基线日也要有快照。
    const contracts = await prisma.optionContract.findMany({
      where: { underlyingInstrumentId: vici },
      select: { id: true },
    });
    for (const c of contracts) {
      await seedSnapshot(c.id, PREV_SESSION, { bid: '1.00', ask: '1.10', delta: '-0.30' });
    }
    await prisma.tradingDay.createMany({
      data: [PREV_SESSION, TODAY].map((d) => ({ market: 'us', date: dateOf(d) })),
    });
    await seedCalendarCoverage();

    const view = await useCase.execute('us:VICI', 'all', NOW);
    // `evaluate` 而非 `check`: 纯判定不告警 —— 本测量的是分母口径, 不是告警行为。
    const report = await new OptionSnapshotCoverageCheck(prisma, {
      optionCoverageThreshold: 1,
    } as unknown as MarketdataSyncConfig).evaluate('us', TODAY);

    // 读端: 当日到期已不可交易 ⇒ 只剩后到期那一条。
    expect(view.legs.map((l) => l.code)).toEqual([laterExpiry]);
    expect(legOf(view, todayExpiry)).toBeUndefined();
    // 采集端: 当日到期照样该采到 ⇒ 分母是 2, 且一条不缺。
    const vic = report.underlyings.find((u) => u.symbol === 'us:VICI');
    expect(vic?.expected).toBe(2);
    expect(vic?.covered).toBe(2);
    expect(report.status).toBe('ok');
    // 🚨 差异本身就是断言对象: 分母比可见腿数**恰好多一条**, 那一条就是当日到期的。
    expect(vic!.expected - view.legs.length).toBe(1);
  });
});
