import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { GetLegsUseCase } from '../../src/optionsdesk/get-legs.usecase';
import { PrismaLegRetrievalAdapter } from '../../src/optionsdesk/leg-retrieval.adapter';
import { Prisma } from '../../src/generated/prisma/client';
import {
  RECALL_CANDIDATE_CAP,
  RENT_RECALL_DTE,
  type RetrievalOverride,
} from '../../src/optionsdesk/leg-recall.rules';
import { LEG_TABS } from '../../src/optionsdesk/leg-tab.rules';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';

// 052 检索层 IT。本文件随各 task 增量补齐, **T015 已收口** —— spec 的 24 条 `state_branches`
// 逐条有 `it()` (逐条交叉核对表在 `specs/052-optionsdesk-retrieval-layering/tasks.md` T015 段)。
//
// 🚨 **24 条不全在本文件里, 这是刻意的**: `state_branches` 里有三条是**客户端行为**
// (复位 / 离开再进 / 改值未点搜), 服务端 IT 结构上够不到它们 —— 它们归 `apps/mobile/e2e/`
// 的 hermetic e2e (T013)。plan Testing Invariants 那句「每条在 IT 里」按此读: **每条有一个
// `it()`, 落在够得到它的那一层**。
//
// ## 为什么**必须**要真 PG
//
// 上限的失败形态是「候选被切了但没人知道」, 而它只在**真查询返回的那批行**上才有意义:
// ① 切法要求确定性, 而输入顺序恰恰来自那条无序的批量读 —— mock 上顺序由测试自己给, 「打乱
//    输入仍留下同一批」就退化成同义反复（Small 档已用假实现验过判据本身, 这里验的是真实现
//    喂进来的顺序也被定序切法吃住）。
// ② `droppedByCandidateCap` 要从 **port 实现**一路上浮到 use case 视图, 中间经过 adapter 的
//    组装与 dedupe —— 断在哪一环, mock 都看不出来。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取（共享 PG 的模板克隆,
// 🚫 禁自起 Testcontainers）。
//
// 🚨 **上限用一个小值驱动**（`candidateCap` 是 port 入参而不是实现里读常量, 正是为此）——
// 真值取三千量级, 造那么多腿只为验一条分支是不划算的; 而「真常量下不截」由最后一条守住。
describe('052 检索层 (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  /** 请求时刻 = 2026-08-04 ET 16:00 ⇒ 交易所的今天恒为 2026-08-04。 */
  const NOW = new Date('2026-08-04T20:00:00.000Z');
  const TODAY = '2026-08-04';
  const PREV_SESSION = '2026-08-03';

  const SYMBOL = 'us:PEP';
  const SPOT = '132.4000';

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
    await prisma.instrument.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
  });

  // ── 造数 ──────────────────────────────────────────────────────────────────

  async function seedInstrument(): Promise<bigint> {
    const row = await prisma.instrument.create({
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
    return row.id;
  }

  /**
   * n 条**全部合格**的收租腿, DTE 与行权价逐条错开。
   *
   * 🚨 全部合格是刻意的: 本文件验的是上限, 不是门槛 —— 混进被门槛挡下的腿会让「切了几条」
   * 与「挡了几条」两个数纠缠, 断言红了分不清是谁的错。
   */
  async function seedChain(count: number): Promise<bigint> {
    const instrumentId = await seedInstrument();
    for (let i = 0; i < count; i += 1) {
      // DTE 从 35 起递增（落收租段 `[30,365]` 且够不着建仓段上界外）；行权价逐条下移，
      // 全部低于 spot ⇒ 成色上界与有效成本都不参与判定。
      const expiry = new Date(dateOf(TODAY).getTime() + (35 + i) * 86_400_000);
      const expiryDay = expiry.toISOString().slice(0, 10);
      const strike = (120 - i).toString();
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: `US.PEP${expiryDay.replaceAll('-', '').slice(2)}P${Number(strike) * 1000}`,
          root: 'PEP',
          underlyingInstrumentId: instrumentId,
          expiryDate: expiry,
          strikePrice: strike,
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
          oiAsOf: dateOf(PREV_SESSION),
          bid: '3.00',
          ask: '3.20',
          delta: '-0.30',
          openInterest: '900',
          volume: '40',
          underlyingSpot: SPOT,
          greeksComplete: true,
        },
      });
    }
    // 067 起检索 adapter 必经 anchor 点查派生 W (无锚 ⇒ 「链未就绪」) ⇒ 种子必须带锚。
    // V = 170 ⇒ W = 136 > spot ⇒ axis 退化为 spot: 本文件对象是候选上限, 锚放恒等域零口径漂移。
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        market: SYMBOL.split(':')[0]!,
        v: '170',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
    return instrumentId;
  }

  const retrieve = async (candidateCap: number, override: RetrievalOverride | null = null) => {
    const port = new PrismaLegRetrievalAdapter(prisma);
    const result = await port.retrieveCandidates({
      symbol: SYMBOL,
      now: NOW,
      perspectives: LEG_TABS,
      candidateCap,
      override,
      realtime: false,
    });
    if (result === null) throw new Error('种子链应当命中 —— 断言前置失效');
    return result;
  };

  // ── 断言 ──────────────────────────────────────────────────────────────────

  it('候选数 ≤ K ⇒ 不截, 切掉数为 0 (真库路径)', async () => {
    await seedChain(6);
    const atCap = await retrieve(6);
    expect(atCap.candidates).toHaveLength(6);
    expect(atCap.droppedByCandidateCap).toBe(0);
  });

  it('候选数 > K ⇒ 截到 K, 切掉多少条从 port 出参可读', async () => {
    await seedChain(6);
    const result = await retrieve(2);
    expect(result.candidates).toHaveLength(2);
    expect(result.droppedByCandidateCap).toBe(4);
  });

  it('🚨 切法在真查询顺序上仍确定 —— 同一份数据两次请求留下同一批成员', async () => {
    await seedChain(6);
    const first = await retrieve(3);
    const second = await retrieve(3);
    const codesOf = (r: Awaited<ReturnType<typeof retrieve>>) =>
      r.candidates.map((c) => c.leg.code);
    expect(codesOf(second)).toEqual(codesOf(first));
    // 键是「日历顺序」: 留下的是 DTE 最小的那三条 ⇒ 行权价 120 / 119 / 118（逐条下移的那批）。
    expect(first.candidates.map((c) => c.leg.strike.toString())).toEqual(['120', '119', '118']);
  });

  /**
   * T008 用的混合数据集 —— 四条腿, **每条各自被一个意图条件排除或不被排除**。
   *
   * 🚨 判据之间蓄意不重叠 (承 050 IT 的造数纪律): 某条断言红了能直接定位到是哪条判据坏了。
   */
  async function seedMixedChain(): Promise<void> {
    const instrumentId = await seedInstrument();
    const legs = [
      // ① 深度实值: K=150 > spot 132.40。收租被**成色上界**挡 (上界 = 132.40×1.03 = 136.372);
      //    建仓过得去 (有效成本 150 − 18 = 132 < spot)。年化虚高 —— 正是本片要压下去的那类。
      { code: 'P-ITM', dte: 35, strike: '150', bid: '18.00', ask: '19.00', oi: '900', vol: '40' },
      // ② 价差宽: rel = 3 / 4.5 = 0.667 > 0.35 ⇒ 被**流动性门槛**挡出两个意图视角。
      // 🚨 `bid` 蓄意压到 1.00（年化 < 收租 good 档界）—— 071 起 bid 年化达档的宽价差腿走
      // **机会支**进收租候选（071 FR-001），那样这条腿就不再「被流动性门槛挡下」，本组断言的
      // 判据面会被换掉；机会支自身的分支在 optionsdesk-071.wide-spread.it.spec.ts 逐条验。
      { code: 'P-WIDE', dte: 35, strike: '120', bid: '1.00', ask: '6.00', oi: '900', vol: '40' },
      // ③ DTE 400: 两个意图**期限段**都够不着。
      { code: 'P-LONG', dte: 400, strike: '118', bid: '3.00', ask: '3.20', oi: '900', vol: '40' },
      // ④ 对照: 各条件全过。
      { code: 'P-OK', dte: 35, strike: '115', bid: '3.00', ask: '3.20', oi: '900', vol: '40' },
    ];
    for (const leg of legs) {
      const expiry = new Date(dateOf(TODAY).getTime() + leg.dte * 86_400_000);
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: leg.code,
          root: 'PEP',
          underlyingInstrumentId: instrumentId,
          expiryDate: expiry,
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
          oiAsOf: dateOf(PREV_SESSION),
          bid: leg.bid,
          ask: leg.ask,
          delta: '-0.30',
          openInterest: leg.oi,
          volume: leg.vol,
          underlyingSpot: SPOT,
          greeksComplete: true,
        },
      });
    }
    // 067: V = 170 ⇒ W = 136 > spot ⇒ axis 退化为 spot, 上界仍 = 132.40 × 1.03 = 136.372 ——
    // 本文件既有断言逐值照旧 (换轴自身的分支归 064 IT「067 换轴双域」组)。
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        market: SYMBOL.split(':')[0]!,
        v: '170',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
  }

  it('🚨 SC-006 全量: 被意图视角任一条件排除的腿, 100% 可在全腿视角找到 (051 入口的回归防线)', async () => {
    await seedMixedChain();
    // 053 FR-001: 三个视角三次请求 —— 「被排除的腿在全腿视角可达」是**跨请求**的性质。
    const usecase = new GetLegsUseCase(
      prisma,
      new PrismaLegRetrievalAdapter(prisma),
      stubTradingCalendar(),
      { marchPhiTier: 'good', marchMode: 'phi' },
    );
    const all = await usecase.execute(SYMBOL, 'all', NOW);
    const build = await usecase.execute(SYMBOL, 'build', NOW);
    const rent = await usecase.execute(SYMBOL, 'rent', NOW);
    // 三条各被一个意图条件排除, 但一条都没从全腿视角消失。
    expect(rent.legs.map((leg) => leg.code)).not.toContain('P-ITM'); // 成色上界
    expect(build.legs.map((leg) => leg.code)).not.toContain('P-WIDE'); // 流动性门槛
    expect(rent.legs.map((leg) => leg.code)).not.toContain('P-WIDE');
    expect(build.legs.map((leg) => leg.code)).not.toContain('P-LONG'); // 期限段
    expect(rent.legs.map((leg) => leg.code)).not.toContain('P-LONG');
    expect(all.legs.map((leg) => leg.code).sort()).toEqual(['P-ITM', 'P-LONG', 'P-OK', 'P-WIDE']);
  });

  it('🚨 T008 全腿: 深度实值腿仍在候选集内, 但排在**末段** (FR-020: 沉底不砍腿)', async () => {
    await seedMixedChain();
    const view = await new GetLegsUseCase(
      prisma,
      new PrismaLegRetrievalAdapter(prisma),
      stubTradingCalendar(),
      { marchPhiTier: 'good', marchMode: 'phi' },
    ).execute(SYMBOL, 'all', NOW);
    // 它在表里 (`legs` 就是全腿视角那份精排序) —— 只是排最后。
    expect(view.legs.at(-1)?.code).toBe('P-ITM');
    // 🚨 它的年化**高于**对照腿却仍排在后面 —— 沉底不是「按费率排恰好排到了末尾」。
    const itm = view.legs.find((leg) => leg.code === 'P-ITM');
    const ok = view.legs.find((leg) => leg.code === 'P-OK');
    expect(Number(itm?.annualizedRate)).toBeGreaterThan(Number(ok?.annualizedRate));
  });

  it('🚨 触及状态一路上浮到 use case 视图 (FR-028: 不依赖读日志)', async () => {
    await seedChain(6); // 锚随 seedChain 落 (067 起检索必经锚派生 W)
    const view = await new GetLegsUseCase(
      prisma,
      new PrismaLegRetrievalAdapter(prisma),
      stubTradingCalendar(),
      { marchPhiTier: 'good', marchMode: 'phi' },
    ).execute(SYMBOL, 'all', NOW);
    // 真常量量级远高于 6 条 ⇒ 不截。字段本身必须在视图上（断的是"接通了"，不是"切了"）。
    expect(RECALL_CANDIDATE_CAP).toBeGreaterThan(6);
    expect(view.candidateCapDropped).toBe(0);
    expect(view.legs).toHaveLength(6);
  });

  it('🚨 T010 真库路径: 系统默认值由服务端解出并下发 —— 依赖 spot 的两项都有值 (FR-011)', async () => {
    await seedMixedChain();
    // 053 FR-005: 条件全景只下发本次视角那一份 ⇒ 收租与全腿各问一次。
    const usecase = new GetLegsUseCase(
      prisma,
      new PrismaLegRetrievalAdapter(prisma),
      stubTradingCalendar(),
      { marchPhiTier: 'good', marchMode: 'phi' },
    );
    const rent = await usecase.execute(SYMBOL, 'rent', NOW);
    const all = await usecase.execute(SYMBOL, 'all', NOW);
    // 成色上界 = min{K ≥ spot} (150) ∧ spot × (1+X) (132.40 × 1.03 = 136.372) 取严。
    expect(rent.criteria.defaults.strikeMax?.toString()).toBe('136.372');
    expect(rent.criteria.defaults.dteBand).toEqual(RENT_RECALL_DTE);
    // 🚫 全腿不设成色与价差 (FR-006 / FR-010) —— 它是参照视角。
    expect(all.criteria.defaults.strikeMax).toBeNull();
    expect(all.criteria.defaults.relativeSpreadMax).toBeNull();
    // 权利金下限依赖 spot ⇒ 客户端算不出, 必须下发。
    expect(all.criteria.defaults.premiumMin).not.toBeNull();
  });

  it('🚨 T010 真库路径: 用户放宽成色上界 ⇒ 深实值腿进收租, 且计数只出在被收窄的维度 (FR-029)', async () => {
    await seedMixedChain();
    const usecase = new GetLegsUseCase(
      prisma,
      new PrismaLegRetrievalAdapter(prisma),
      stubTradingCalendar(),
      { marchPhiTier: 'good', marchMode: 'phi' },
    );
    const plain = await usecase.execute(SYMBOL, 'rent', NOW);
    expect(plain.legs.map((leg) => leg.code)).not.toContain('P-ITM');

    // 放宽: 上界拉到 P-ITM 的 K=150 之上 ⇒ 它进收租; 放宽 MUST NOT 出计数 (Guardrail 7)。
    const widened = await usecase.execute(SYMBOL, 'rent', NOW, {
      perspective: 'rent',
      criteria: { strikeMax: new Prisma.Decimal('160') },
    });
    expect(widened.legs.map((leg) => leg.code)).toContain('P-ITM');
    expect(widened.criteria.outcomes.strikeMax).toEqual({
      state: 'widened',
      excludedCount: 0,
    });

    // 收窄: 上界收到 118 ⇒ 默认下进收租的 P-OK (K=115) 仍在, P-WIDE (K=120) 本就被价差挡下
    // ⇒ 不计它 (同时被两维挡下的腿一维都不计)。
    const narrowed = await usecase.execute(SYMBOL, 'rent', NOW, {
      perspective: 'rent',
      criteria: { strikeMax: new Prisma.Decimal('114') },
    });
    expect(narrowed.legs.map((leg) => leg.code)).not.toContain('P-OK');
    expect(narrowed.criteria.outcomes.strikeMax).toEqual({
      state: 'narrowed',
      excludedCount: 1,
    });
    expect(narrowed.criteria.outcomes.dteBand.state).toBe('default');
  });

  it('🚨 T010: 排名基准 = 当前条件下的召回集 —— 放宽后活跃标随新候选集重算 (FR-026)', async () => {
    await seedMixedChain();
    const usecase = new GetLegsUseCase(
      prisma,
      new PrismaLegRetrievalAdapter(prisma),
      stubTradingCalendar(),
      { marchPhiTier: 'good', marchMode: 'phi' },
    );
    const plain = await usecase.execute(SYMBOL, 'rent', NOW);
    const widened = await usecase.execute(SYMBOL, 'rent', NOW, {
      perspective: 'rent',
      criteria: { strikeMax: new Prisma.Decimal('160') },
    });
    // 放宽前收租只有 P-OK 一条 (DTE 35 同组), 放宽后 P-ITM 也进来 —— 同到期日组的成员变了
    // ⇒ 活跃标的分母跟着变。这是**定义如此** (spec US3-AS6), 界面上不做特殊解释。
    const rentMarkOf = (v: typeof plain, code: string) =>
      v.legs.find((l) => l.code === code)?.activity ?? null;
    expect(rentMarkOf(plain, 'P-ITM')).toBeNull();
    expect(rentMarkOf(widened, 'P-ITM')).not.toBeNull();
    expect(widened.legs.length).toBeGreaterThan(plain.legs.length);
  });

  // ── T015 收口 ───────────────────────────────────────────────────────────────
  //
  // 📌 **这几条为什么也要真库**: 判据本身 Small 档各自有单测 (`leg-recall.rules.spec.ts`),
  // 这里验的是**本片把召回层换成 port 之后, 它们仍作用在真查询返回的那批行上**。三条通用硬
  // 门槛 (仅认沽 / 仅标准 / 到期日 > 当日) 更是**只有**真库能验 —— 它们是 SQL 谓词, mock 上
  // 「滤掉了」只说明测试自己没造那几行。

  const useCaseOf = (): GetLegsUseCase =>
    new GetLegsUseCase(prisma, new PrismaLegRetrievalAdapter(prisma), stubTradingCalendar(), {
      marchPhiTier: 'good',
      marchMode: 'phi',
    });

  /** 一条种子腿的全部可变量。T015 的四组种子共用下面的 {@link seedLegs}。 */
  interface SeedLeg {
    readonly code: string;
    readonly dte: number;
    readonly strike: string;
    readonly bid: string | null;
    readonly ask: string | null;
    readonly oi: string | null;
    readonly vol: string | null;
    readonly optionType?: 'PUT' | 'CALL';
    readonly isStandard?: boolean;
    readonly greeksComplete?: boolean;
    /** 已软下架 (vendor 不再挂牌该码, marketdata 链发现对账置的戳)。 */
    readonly withdrawn?: boolean;
    /**
     * 076 一张合约对应的正股股数 (`option_contract.contract_size`)。缺省 `100` —— 本文件是
     * 美股链 (`us:PEP`), 供应方实测给标准美股合约恒 100 ⇒ 既有臂逐值不动。
     * 显式 `null` = 「这一列还没被任何一轮链发现覆盖到」。
     */
    readonly contractSize?: number | null;
  }

  /**
   * 通用造数。
   *
   * 🚨 **与上面两个专用 seed 蓄意并存, 不回改它们**: 那两个的形状被 T005 / T008 各自的断言吃
   * 住 —— 合并会让「改哪一条数据会红哪一条断言」不再一眼可判, 而那正是 T014 抓到的 047 fixture
   * 债的来路 (一条腿同时承载两个互不相干的性质)。
   */
  async function seedLegs(
    legs: readonly SeedLeg[],
    spot: string = SPOT,
    // 067: 缺省锚放恒等域 (W = 136 > spot ⇒ axis 退化为 spot), 既有断言零口径漂移。
    anchorV = '170',
  ): Promise<void> {
    const instrumentId = await seedInstrument();
    for (const leg of legs) {
      const expiry = new Date(dateOf(TODAY).getTime() + leg.dte * 86_400_000);
      const greeksComplete = leg.greeksComplete ?? true;
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: leg.code,
          root: 'PEP',
          underlyingInstrumentId: instrumentId,
          expiryDate: expiry,
          strikePrice: leg.strike,
          optionType: leg.optionType ?? 'PUT',
          isStandard: leg.isStandard ?? true,
          withdrawnAt: leg.withdrawn === true ? new Date(`${TODAY}T00:00:00Z`) : null,
          // 🚫 `?? 100` 在这里是错的 —— 显式 `null` 正是要播的那个形态 (未回填)。
          contractSize: leg.contractSize === undefined ? 100 : leg.contractSize,
        },
        select: { id: true },
      });
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: dateOf(TODAY),
          source: 'eod',
          quoteAsOf: new Date(`${TODAY}T20:31:07Z`),
          oiAsOf: dateOf(PREV_SESSION),
          bid: leg.bid,
          ask: leg.ask,
          delta: greeksComplete ? '-0.30' : null,
          openInterest: leg.oi,
          volume: leg.vol,
          underlyingSpot: spot,
          greeksComplete,
        },
      });
    }
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        market: SYMBOL.split(':')[0]!,
        v: anchorV,
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
  }

  /**
   * 门槛靶场 —— 三条通用硬门槛 + 建仓有效成本两侧 + 三条召回条件, **判据之间蓄意不重叠**
   * (承 050 造数纪律: 某条断言红了能直接定位到是哪条判据坏了)。
   *
   * 📌 成色上界 = `min{K ≥ 132.40}` (150) ∧ `132.40 × 1.03` (136.372) 取严 ⇒ **136.372**;
   * 三条收租腿 (`115` / `117` / `119`) 全在其下 ⇒ 本组的收租成员由**别的**判据决定, 成色不掺和。
   */
  const GATE_LEGS: readonly SeedLeg[] = [
    // ① 认购 —— 通用硬门槛「仅认沽」, 在读端就滤掉。
    { code: 'H-CALL', dte: 35, strike: '126', bid: '3.00', ask: '3.20', oi: '900', vol: '40', optionType: 'CALL' }, // prettier-ignore
    // ② 非标准合约 (调整过的合约) —— 通用硬门槛「仅标准」。
    { code: 'H-NONSTD', dte: 35, strike: '125', bid: '3.00', ask: '3.20', oi: '900', vol: '40', isStandard: false }, // prettier-ignore
    // ③ 到期日 == 当日 —— 通用硬门槛「到期日 > 当日」(与完整性分母的 `≥` 蓄意不同, 050 FR-010)。
    { code: 'H-EXPIRED', dte: 0, strike: '124', bid: '3.00', ask: '3.20', oi: '900', vol: '40' },
    // ③b 已软下架 —— 通用硬门槛「仍挂牌」: vendor 已不认的码不可交易, 不该出现在选约表。
    // 它有**完整的历史快照**(下架前采的), 所以不设本门槛时它会照常成行, 且看不出异常。
    { code: 'H-WITHDRAWN', dte: 35, strike: '123', bid: '3.00', ask: '3.20', oi: '900', vol: '40', withdrawn: true }, // prettier-ignore
    // ④ 有效成本**恰等于** spot: 150 − 17.60 = 132.40 ⇒ 不进建仓 (严格小于)。DTE 20 ⇒ 够不着收租段。
    { code: 'G-COSTTIE', dte: 20, strike: '150', bid: '17.60', ask: '18.00', oi: '900', vol: '40' }, // prettier-ignore
    // ⑤ K 高于 spot 但有效成本仍低于它: 150.5 − 18.11 = 132.39 < 132.40 ⇒ 进建仓 (FR-007: 建仓不设行权价上界)。
    { code: 'G-COSTOK', dte: 20, strike: '150.5', bid: '18.11', ask: '18.50', oi: '900', vol: '40' }, // prettier-ignore
    // ⑨ 权利金低于下限 (spot 132.40 ⇒ 下限 0.2383) ⇒ **整条移出**, 三视角都看不见。
    { code: 'G-CHEAP', dte: 35, strike: '120', bid: '0.01', ask: '0.05', oi: '900', vol: '40' },
    // ⑩⑪ 相对价差 3 / 4.5 = 0.667 > 0.35 ⇒ 出两个意图视角, **仍在全腿**。
    // 🚨 `bid` 蓄意压到 1.00（年化 < 收租 good 档界）—— 071 起 bid 年化达档的宽价差腿走
    // **机会支**进收租候选（071 FR-001），那样这条腿就不再「被流动性门槛挡下」，本组断言的
    // 判据面会被换掉；机会支自身的分支在 optionsdesk-071.wide-spread.it.spec.ts 逐条验。
    { code: 'G-WIDE', dte: 35, strike: '119', bid: '1.00', ask: '6.00', oi: '900', vol: '40' },
    // Edge Case: greeks 缺失 ⇒ 照常进候选 (Δ 已降级为打标量, 继承 050 FR-009)。
    { code: 'G-NOGREEKS', dte: 35, strike: '117', bid: '3.00', ask: '3.20', oi: '900', vol: '40', greeksComplete: false }, // prettier-ignore
    // 对照: 各条件全过。
    { code: 'G-OK', dte: 35, strike: '115', bid: '3.00', ask: '3.20', oi: '900', vol: '40' },
  ];

  it('🚨 通用硬门槛 (仅认沽 / 仅标准 / 到期日 > 当日 / 仍挂牌) 在读端就滤掉 —— 成员逐条相等, 四条一条没漏', async () => {
    await seedLegs(GATE_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'all', NOW);
    // 🚫 MUST NOT 写 `length` 比较: 「少了三条」对「滤错了哪三条」没有分辨力。
    expect(view.legs.map((leg) => leg.code).sort()).toEqual([
      'G-COSTOK',
      'G-COSTTIE',
      'G-NOGREEKS',
      'G-OK',
      'G-WIDE',
    ]);
  });

  it('🚨 state_branch ④⑤ 建仓有效成本硬门槛两侧: 恰等于 spot 不进, K 高于 spot 但成本仍低则进', async () => {
    await seedLegs(GATE_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'build', NOW);
    expect(view.legs.map((leg) => leg.code)).not.toContain('G-COSTTIE');
    expect(view.legs.map((leg) => leg.code)).toContain('G-COSTOK');
    // 🚫 两条腿的 K **都高于 spot**, 分野只在有效成本 —— 建仓 MUST NOT 有额外行权价上界 (FR-007)。
    // 🚨 两条腿里有一条**不在建仓视角**(正是本测要的结论) ⇒ 行权价从全腿视角那份取。
    const inAll = await useCaseOf().execute(SYMBOL, 'all', NOW);
    const strikeOf = (code: string) =>
      inAll.legs.find((leg) => leg.code === code)?.strike ?? new Prisma.Decimal(0);
    expect(strikeOf('G-COSTOK').greaterThan(view.spot ?? 0)).toBe(true);
    expect(strikeOf('G-COSTTIE').greaterThan(view.spot ?? 0)).toBe(true);
    expect(view.criteria.defaults.strikeMax).toBeNull();
    // 被硬门槛挡下的那条仍在全腿视角 (SC-006 的同一条纪律 —— 硬门槛也不砍腿)。
    expect(inAll.legs.map((leg) => leg.code)).toContain('G-COSTTIE');
  });

  it('🚨 state_branch ⑨ 权利金低于下限 ⇒ 三视角全不见 (整条移出), 且只让 removedByPremiumFloor 动', async () => {
    await seedLegs(GATE_LEGS);
    // 053 FR-001: 「三视角全不见」现在要三次请求各问一遍 —— 每次都不该有它。
    for (const tab of LEG_TABS) {
      const view = await useCaseOf().execute(SYMBOL, tab, NOW);
      expect([tab, view.legs.map((leg) => leg.code)]).toEqual([
        tab,
        expect.not.arrayContaining(['G-CHEAP']),
      ]);
      expect([tab, view.gateCounts.removedByPremiumFloor]).toEqual([tab, 1]);
    }
    // 🚫 它的价差也宽 (0.05 / 0.03), 但**不计**进流动性数 —— 它压根没走到那一道。
    const inBuild = await useCaseOf().execute(SYMBOL, 'build', NOW);
    expect(inBuild.gateCounts.excludedFromIntentTabs).toBe(1); // 只有 G-WIDE
  });

  it('🚨 state_branch ⑩⑪ 价差超上界 ⇒ 出两个意图视角、仍在全腿; 全腿本就不设该维 (FR-010)', async () => {
    await seedLegs(GATE_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'all', NOW);
    const build = await useCaseOf().execute(SYMBOL, 'build', NOW);
    const rent = await useCaseOf().execute(SYMBOL, 'rent', NOW);
    expect(build.legs.map((leg) => leg.code)).not.toContain('G-WIDE');
    expect(rent.legs.map((leg) => leg.code)).not.toContain('G-WIDE');
    expect(view.legs.map((leg) => leg.code)).toContain('G-WIDE');
    // 🚨 「全腿不受价差约束」是**默认值层面**的不设, 不是「设了但恰好没挡下谁」——
    // 后者会在用户放宽别的维度时突然显形。
    expect(view.criteria.defaults.relativeSpreadMax).toBeNull();
    expect(build.criteria.defaults.relativeSpreadMax).not.toBeNull();
    expect(rent.criteria.defaults.relativeSpreadMax).not.toBeNull();
  });

  it('Edge Case: greeks 缺失的腿照常进候选 —— 三个视角逐个都收它, 只是不判档不着色', async () => {
    await seedLegs(GATE_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'all', NOW);
    const leg = view.legs.find((l) => l.code === 'G-NOGREEKS');
    expect(leg?.absDelta).toBeNull();
    expect(leg?.sigmaDistance).toBeNull();
    for (const tab of LEG_TABS) {
      const perTab = await useCaseOf().execute(SYMBOL, tab, NOW);
      expect([tab, perTab.legs.map((leg) => leg.code)]).toEqual([
        tab,
        expect.arrayContaining(['G-NOGREEKS']),
      ]);
    }
  });

  /**
   * `SC-005` 靶场 —— 建仓视角在本片前后的差, MUST 全部且仅由活性条件解释。
   *
   * 🚨 `B-HIGHK` 是**给成色条件留的探针**: 本链的成色上界 = `min{K ≥ 132.40}` = 133, 而它
   * `K = 140` 却是合格建仓腿 (成本 131 < spot)。成色若漏进建仓, 它当场从建仓集消失 ⇒ 差集里
   * 多出一条不是活性原因的腿, 下面两条断言都红。
   */
  const SC005_LEGS: readonly SeedLeg[] = [
    // 老新都在。
    { code: 'B-ALIVE-1', dte: 20, strike: '120', bid: '3.00', ask: '3.20', oi: '900', vol: '40' },
    { code: 'B-ALIVE-2', dte: 20, strike: '118', bid: '2.50', ask: '2.70', oi: '5', vol: null },
    { code: 'B-HIGHK', dte: 20, strike: '140', bid: '9.00', ask: '9.40', oi: '900', vol: '40' },
    // 老在、新不在 —— 差集本身。形态照实测那 87 条: 深度实值、权利金厚、价差反而更窄,
    // 唯一的毛病是 `OI = 0` 且当日零成交 (挂出去无人应答)。
    { code: 'B-DEAD-OI', dte: 20, strike: '129', bid: '3.75', ask: '4.00', oi: '0', vol: '0' },
    { code: 'B-DEAD-NULL', dte: 20, strike: '133', bid: '5.00', ask: '5.30', oi: null, vol: null },
    // 老新都不在 —— 三条各被一道**本片未动**的判据挡下。
    { code: 'B-COSTFAIL', dte: 20, strike: '150', bid: '17.00', ask: '18.00', oi: '900', vol: '40' }, // prettier-ignore
    { code: 'B-WIDE', dte: 20, strike: '117', bid: '3.00', ask: '6.00', oi: '900', vol: '40' },
    { code: 'B-CHEAP', dte: 20, strike: '116', bid: '0.05', ask: '0.10', oi: '900', vol: '40' },
  ];

  it('🚨 SC-005 差集断言: 建仓集的变化**全部且仅**由活性条件解释 (旧集 ∩ 过活性的腿 = 新集)', async () => {
    /** 本片之前 (`050` 判据) 的建仓集 —— 手工推导的字面清单, 🚫 不用当前判据现算 (那是同义反复)。 */
    const OLD_BUILD = ['B-ALIVE-1', 'B-ALIVE-2', 'B-DEAD-OI', 'B-DEAD-NULL', 'B-HIGHK'];
    const KILLED_BY_LIVENESS = ['B-DEAD-OI', 'B-DEAD-NULL'];

    await seedLegs(SC005_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'build', NOW);
    expect(view.legs.map((leg) => leg.code).sort()).toEqual(
      OLD_BUILD.filter((code) => !KILLED_BY_LIVENESS.includes(code)).sort(),
    );

    // 🚨 差集里**零条是别的原因**的可执行形态: 把活性这一维**覆盖为不限**, 建仓集当场回到
    // 本片之前的那一份。成色 / 精排 / 打标里若有任何一处偷偷动了建仓成员, 它不随这个覆盖变
    // ⇒ 这里对不上。同时它也证明差集**非空** —— 否则上一条断言退化成同义反复。
    const unbounded = await useCaseOf().execute(SYMBOL, 'build', NOW, {
      perspective: 'build',
      criteria: { livenessMin: null },
    });
    expect(unbounded.legs.map((leg) => leg.code).sort()).toEqual([...OLD_BUILD].sort());
    expect(unbounded.criteria.outcomes.livenessMin.state).toBe('widened');
    for (const code of KILLED_BY_LIVENESS) {
      expect(view.legs.map((leg) => leg.code)).not.toContain(code);
      expect(unbounded.legs.map((leg) => leg.code)).toContain(code);
    }
  });

  /**
   * `SC-002` 靶场 —— 起草期作为缺陷证据的那条链的形态 (`us:KBR`, spot `37.56`)。
   *
   * `K = 105` 的深实值腿 `bid ≈ K − spot` ⇒ 准备金恒为 `39.60` 而分子随 `K` 长 ⇒ 年化 **367%**。
   * 经济上它就是「花 39.60 买入现价 37.56 的股票」, 不是租金。
   */
  const KBR_SPOT = '37.5600';
  const KBR_LEGS: readonly SeedLeg[] = [
    { code: 'K-DEEP', dte: 164, strike: '105', bid: '65.40', ask: '66.00', oi: '900', vol: '40' },
    { code: 'K-OTM-1', dte: 164, strike: '37', bid: '0.80', ask: '0.90', oi: '900', vol: '40' },
    { code: 'K-OTM-2', dte: 164, strike: '36', bid: '0.60', ask: '0.70', oi: '900', vol: '40' },
    { code: 'K-OTM-3', dte: 164, strike: '35', bid: '0.45', ask: '0.55', oi: '900', vol: '40' },
  ];

  it('🚨 SC-002: 缺陷链上收租集内**零条**三位数年化的深实值腿 —— 而它仍在全腿 (沉底不砍腿)', async () => {
    // 067: V 取 48 ⇒ W = 38.4 > spot 37.56 ⇒ axis 退化为 spot (恒等域) —— 本条钉的是
    // 「深实值进不了收租」, 上界口径与换轴前逐值一致。
    await seedLegs(KBR_LEGS, KBR_SPOT, '48');
    const view = await useCaseOf().execute(SYMBOL, 'rent', NOW);
    const inAll = await useCaseOf().execute(SYMBOL, 'all', NOW);

    // 缺陷现场本身仍在数据里 —— 断言的是它**进不了收租**, 不是它不存在。
    const deep = inAll.legs.find((leg) => leg.code === 'K-DEEP');
    expect(Number(deep?.annualizedRate)).toBeGreaterThan(1);
    expect(view.legs.map((leg) => leg.code)).not.toContain('K-DEEP');

    // 收租集逐条 ≤ 成色上界 (SC-001) 且逐条年化 < 100% (SC-002)。
    const ceiling = view.criteria.defaults.strikeMax;
    expect(ceiling).not.toBeNull();
    expect(view.legs.map((leg) => leg.code).sort()).toEqual(['K-OTM-1', 'K-OTM-2', 'K-OTM-3']);
    for (const leg of view.legs) {
      expect(leg.strike.lessThanOrEqualTo(ceiling ?? 0)).toBe(true);
      expect(Number(leg.annualizedRate)).toBeLessThan(1);
    }

    // 🚫 FR-006: 全腿是参照视角, 它在里面 —— 只是被成色排序特征压到末位。
    expect(inAll.legs.at(-1)?.code).toBe('K-DEEP');
  });

  /**
   * `SC-010` 靶场 —— 四条**同到期日**的腿, 活动量逐条递减且都过绝对线 (`≥ 100`)。
   *
   * `ACTIVITY_TOP_RANK_COUNT = 3` ⇒ 默认集里 `R-D` 排第 4 拿不到标; 收窄踢掉 `R-A` 之后
   * 分母变成 3 条, 它进前 3。
   */
  const ORDER_LEGS: readonly SeedLeg[] = [
    { code: 'R-A', dte: 35, strike: '130', bid: '3.00', ask: '3.20', oi: '5000', vol: '10' },
    { code: 'R-B', dte: 35, strike: '125', bid: '3.00', ask: '3.20', oi: '4000', vol: '10' },
    { code: 'R-C', dte: 35, strike: '120', bid: '3.00', ask: '3.20', oi: '3000', vol: '10' },
    { code: 'R-D', dte: 35, strike: '115', bid: '3.00', ask: '3.20', oi: '200', vol: '10' },
  ];

  it('🚨 SC-010 顺序: 收窄后活跃标按**收窄后**的召回集重算 —— 「先按默认召回排名再筛」在这里当场红', async () => {
    await seedLegs(ORDER_LEGS);
    const usecase = useCaseOf();
    const plain = await usecase.execute(SYMBOL, 'rent', NOW);
    const narrowed = await usecase.execute(SYMBOL, 'rent', NOW, {
      perspective: 'rent',
      criteria: { strikeMax: new Prisma.Decimal('128') },
    });
    // 📌 判的是 `isTopRanked` 而不是整个标对象是否为 `null` —— 后者对**非成员**才为 `null`,
    // 而这四条腿全在收租里; 整数行权价标 (`isRoundStrike`) 与排名无关, 恒有值。
    const topRankedIn = (view: typeof plain, code: string) =>
      view.legs.find((leg) => leg.code === code)?.activity?.isTopRanked ?? null;

    // 默认: 四条同组 ⇒ 标发给活动量前 3, R-D 第 4 拿不到。
    expect(plain.legs.map((leg) => leg.code).sort()).toEqual(['R-A', 'R-B', 'R-C', 'R-D']);
    expect(topRankedIn(plain, 'R-D')).toBe(false);
    expect(topRankedIn(plain, 'R-A')).toBe(true);

    // 收窄踢掉 R-A ⇒ 分母 3 条 ⇒ R-D 进前 3。它的活动量一分没变 (210), 变的是**基准**。
    expect(narrowed.legs.map((leg) => leg.code)).not.toContain('R-A');
    expect(topRankedIn(narrowed, 'R-D')).toBe(true);
    expect(narrowed.criteria.outcomes.strikeMax).toEqual({
      state: 'narrowed',
      excludedCount: 1,
    });
  });

  /**
   * 076 靶场 —— **三条腿只差 `contract_size` 一列**, 报价 / 成交量 / DTE 逐字相同。
   *
   * 🚨 只差一列是刻意的: 两个派生列的差异 MUST 全部且仅由股数解释。任何一条腿在别处也不同的话,
   * 断言红了分不清是股数吃错了还是别的判据动了。
   *
   * 📌 股数取值出处: 港股每张合约的正股股数逐标的不同, 500 是 09988 等 7 只锚的实测值; 美股标准
   * 合约实测恒 100 (EVIDENCE: `specs/076-option-contract-size/spec.md`「取证」§1 / §2 PoC-A)。
   */
  const SIZE_LEGS: readonly SeedLeg[] = [
    // ① 港股形态: 一张 500 股。两个派生列 = 100 股那条的 5 倍。
    { code: 'S-HK500', dte: 35, strike: '116', bid: '3.00', ask: '3.20', oi: '900', vol: '40', contractSize: 500 }, // prettier-ignore
    // ② 首轮回填前的形态: 这一列还没被任何一轮链发现覆盖到 (FR-009 / state_branch 11)。
    { code: 'S-NOSIZE', dte: 35, strike: '115', bid: '3.00', ask: '3.20', oi: '900', vol: '40', contractSize: null }, // prettier-ignore
    // ③ 美股形态: 一张 100 股 —— 076 前的写死常量就是这个数, 用来钉逐值零变化。
    { code: 'S-US100', dte: 35, strike: '114', bid: '3.00', ask: '3.20', oi: '900', vol: '40', contractSize: 100 }, // prettier-ignore
  ];

  it('🚨 076-① 股数 500 的合约: 单笔权利金 = bid × 500、成交额 = Vol × bid × 500 (FR-011)', async () => {
    await seedLegs(SIZE_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'all', NOW);
    const leg = view.legs.find((l) => l.code === 'S-HK500');
    // 🚫 MUST NOT 从被测函数算期望值 —— 手算: bid 3.00 × 500 = 1500; 40 × 3.00 × 500 = 60000。
    expect(leg?.contractPremium?.toString()).toBe('1500');
    expect(leg?.turnover?.toString()).toBe('60000');
    // 判别性: 同一份数据下 100 股那条恰好是它的 1/5 —— 若股数没真进来, 两条会一样。
    const us = view.legs.find((l) => l.code === 'S-US100');
    expect(leg?.contractPremium?.div(5).toString()).toBe(us?.contractPremium?.toString());
  });

  it('🚨 076-② 股数未落库 ⇒ 两个派生列显式 null, 🚫 不回落 100; 其余列照常、这一屏照常可用', async () => {
    await seedLegs(SIZE_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'all', NOW);
    const leg = view.legs.find((l) => l.code === 'S-NOSIZE');
    expect(leg?.contractPremium).toBeNull();
    expect(leg?.turnover).toBeNull();
    // 🚨 「这一行的两个数不知道」MUST NOT 升格成「这条腿不见了」或「这一屏坏了」——
    //    首轮回填窗口内整张表都是这个形态, 它必须是一张能看的表 (FR-009 / EC7)。
    expect(view.state).toBe('available');
    expect(view.legs.map((l) => l.code).sort()).toEqual(['S-HK500', 'S-NOSIZE', 'S-US100']);
    expect(leg?.bid?.toString()).toBe('3');
    expect(leg?.volume).toBe(40);
    expect(leg?.annualizedRate).not.toBeNull();
  });

  it('🚨 076-③ 股数 100 的美股合约: 两个派生列与 076 前的基线**逐值相同** (FR-010)', async () => {
    await seedLegs(SIZE_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'all', NOW);
    const leg = view.legs.find((l) => l.code === 'S-US100');
    // 🚨 基线**写死**在这里, 🚫 MUST NOT 从 `computeContractPremium` / `computeTurnover` 现算 ——
    //    从被测函数取期望值是同义反复: 常量换成入参这件事改错了, 它照样绿。
    //    076 前的口径 = bid × 100 与 Vol × bid × 100 ⇒ 3.00 × 100 = 300; 40 × 3.00 × 100 = 12000。
    expect(leg?.contractPremium?.toString()).toBe('300');
    expect(leg?.turnover?.toString()).toBe('12000');
  });
});
