import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { GetLegsUseCase } from '../../src/optionsdesk/get-legs.usecase';
import { PrismaLegRetrievalAdapter } from '../../src/optionsdesk/leg-retrieval.adapter';
import { RECALL_CANDIDATE_CAP } from '../../src/optionsdesk/leg-recall.rules';
import { LEG_TABS } from '../../src/optionsdesk/leg-tab.rules';

// 052 检索层 IT。本文件随各 task 增量补齐, T015 收口到 24 条 `state_branches` 逐条有 `it()`。
// 当前覆盖: **T005 候选上限 K**（`FR-027` / `FR-028`）。
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
describe('052 T005 召回层候选上限 K (Testcontainers PG)', () => {
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
    return instrumentId;
  }

  const retrieve = async (candidateCap: number) => {
    const port = new PrismaLegRetrievalAdapter(prisma);
    const result = await port.retrieveCandidates({
      symbol: SYMBOL,
      now: NOW,
      perspectives: LEG_TABS,
      candidateCap,
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
      // ① 深度实值: K=150 > spot 132.40。收租被**成色上界**挡 (上界 = 132.40×1.04 = 137.696);
      //    建仓过得去 (有效成本 150 − 18 = 132 < spot)。年化虚高 —— 正是本片要压下去的那类。
      { code: 'P-ITM', dte: 35, strike: '150', bid: '18.00', ask: '19.00', oi: '900', vol: '40' },
      // ② 价差宽: rel = 3 / 4.5 = 0.667 > 0.35 ⇒ 被**流动性门槛**挡出两个意图视角。
      { code: 'P-WIDE', dte: 35, strike: '120', bid: '3.00', ask: '6.00', oi: '900', vol: '40' },
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
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        v: '150',
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
    const view = await new GetLegsUseCase(prisma, new PrismaLegRetrievalAdapter(prisma)).execute(
      SYMBOL,
      NOW,
    );
    // 三条各被一个意图条件排除, 但一条都没从全腿视角消失。
    expect(view.tabOrder.rent).not.toContain('P-ITM'); // 成色上界
    expect(view.tabOrder.build).not.toContain('P-WIDE'); // 流动性门槛
    expect(view.tabOrder.rent).not.toContain('P-WIDE');
    expect(view.tabOrder.build).not.toContain('P-LONG'); // 期限段
    expect(view.tabOrder.rent).not.toContain('P-LONG');
    expect([...view.tabOrder.all].sort()).toEqual(['P-ITM', 'P-LONG', 'P-OK', 'P-WIDE']);
  });

  it('🚨 T008 全腿: 深度实值腿仍在候选集内, 但排在**末段** (FR-020: 沉底不砍腿)', async () => {
    await seedMixedChain();
    const view = await new GetLegsUseCase(prisma, new PrismaLegRetrievalAdapter(prisma)).execute(
      SYMBOL,
      NOW,
    );
    // 它在表里 (`legs` 是全量载体), 也在全腿视角的有序列表里 —— 只是排最后。
    expect(view.legs.map((leg) => leg.code)).toContain('P-ITM');
    expect(view.tabOrder.all.at(-1)).toBe('P-ITM');
    // 🚨 它的年化**高于**对照腿却仍排在后面 —— 沉底不是「按费率排恰好排到了末尾」。
    const itm = view.legs.find((leg) => leg.code === 'P-ITM');
    const ok = view.legs.find((leg) => leg.code === 'P-OK');
    expect(Number(itm?.annualizedRate)).toBeGreaterThan(Number(ok?.annualizedRate));
  });

  it('🚨 触及状态一路上浮到 use case 视图 (FR-028: 不依赖读日志)', async () => {
    await seedChain(6);
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        v: '150',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
    const view = await new GetLegsUseCase(prisma, new PrismaLegRetrievalAdapter(prisma)).execute(
      SYMBOL,
      NOW,
    );
    // 真常量量级远高于 6 条 ⇒ 不截。字段本身必须在视图上（断的是"接通了"，不是"切了"）。
    expect(RECALL_CANDIDATE_CAP).toBeGreaterThan(6);
    expect(view.candidateCapDropped).toBe(0);
    expect(view.legs).toHaveLength(6);
  });
});
