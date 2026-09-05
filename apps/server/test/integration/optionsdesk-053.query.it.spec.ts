import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { GetLegsUseCase, type LegTableView } from '../../src/optionsdesk/get-legs.usecase';
import { PrismaLegRetrievalAdapter } from '../../src/optionsdesk/leg-retrieval.adapter';
import { toLegTableResponse } from '../../src/optionsdesk/optionsdesk.dto';
import { Prisma } from '../../src/generated/prisma/client';
import { RECALL_CANDIDATE_CAP } from '../../src/optionsdesk/leg-recall.rules';
import { BASIS_BY_TAB, DISPLAY_LIMIT_BY_PERSPECTIVE } from '../../src/optionsdesk/leg-rank.rules';
import { LEG_TABS } from '../../src/optionsdesk/leg-tab.rules';
import type {
  ChainAbsenceReason,
  LegChainQuery,
  LegChainSnapshot,
  LegRetrievalPort,
  LegRetrievalQuery,
  LegRetrievalResult,
} from '../../src/optionsdesk/leg-retrieval.port';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';

// 053 T005 —— 查询下沉的服务端侧 IT (Testcontainers 真 PG)。
//
// ## 落层裁定 (先读这条, 否则会来这里补不可能的 IT)
//
// spec 的 **25 条 `state_branches` 里有 11 条是纯客户端行为** (跨业务日重取与提示 / 水位失效三份 /
// 单视角失败隔离 / 错误态切换 / 迟到响应 / 错峰时序 / 预取失败与命中 / 切视角保留条件) —— 服务端
// IT **结构上够不到它们**, 它们归 `apps/mobile/e2e/` 的 hermetic e2e (T010); 另有 1 条 (列改版横滑
// 几何) 归真机验收 (T013)。⇒ **本文件的值域 = 13 条: 1–12 与 24**。
// 📌 plan Testing Invariants 那句「每条在 IT 里有一个 `it()`」按此读: **每条有一个 `it()`, 落在够
// 得到它的那一层** —— 沿 `052` T015 对同一冲突的裁法。
//
// ## 为什么**必须**要真 PG
//
// ① **截断的可验证形态是「截掉的是精排序的尾部」而不是「条数对」** (Guardrail 8): 排序的输入正是
//    那条无序的批量读, 在 mock 上顺序由测试自己给 ⇒「截掉的是尾部」当场退化成同义反复。截断纯函数
//    本身的边界 (`<` / `=` / `>`) 已由 Small 档 `leg-rank.rules.spec.ts` 验过, 这里验的是**真实链上
//    截对了哪一段**。
// ② `memberCount` (053 FR-009) 与 `candidateCapDropped` 要从 **port 实现**一路上浮到 use case 视图,
//    中间经 adapter 的第二趟纯函数判定与组装 —— 断在哪一环, mock 都看不出来。
// ③ `SC-012` 的回归防线要求「被意图视角排除的腿」是**召回判据在真行上**排除的, 不是测试自己挑出
//    来的那几条。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// 🚫 禁自起 Testcontainers)。装配 = 直接 `new` 贫血 usecase + 真 `PrismaService` (体例同
// `optionsdesk-045.anchor.it.spec.ts`); HTTP 通道层 (真 DI 容器 + 真 `ValidationPipe` 的 400) 已由
// `src/optionsdesk/optionsdesk.controller.spec.ts` 覆盖 (T001), 此处不重复起 Nest 容器。
//
// 🚨 **两个「小值注入」是本文件的方法论, 不是偷懒** (Guardrail 7 / `SC-006`):
// - **截断阈值 `N`** 由 `execute` 第 5 参注入 —— 意图视角的候选规模远小于全腿视角, 截断分支很可能在
//   真实数据上**结构性永不触发**; 注入小阈值后**同一批真实数据**就能走遍截断的每一条分支。
// - **候选上限 `K`** 由一层 `CappedRetrieval` 包装喂给真 adapter —— 真值取三千量级, 造那么多腿只为
//   验一条分支不划算。包装只换那一个入参, 判据与库路径**一条没变**。
// 🚫 **MUST NOT 改用合成 fixture 造几百条腿** —— 那测的是「slice 能不能跑」, 不是「真实链上截断对
// 不对」。
//
// ## 🔬 「已证明它会红」的变异实测 (2026-08-14, `SC-007` / `SC-016` 的证据; 改动均已回滚)
//
// | 变异 | 结果 |
// | --- | --- |
// | `truncateToDisplayLimit` 改留**尾部** (`slice(ranked.length - limit)`) | `state_branch 3` / `6` **红** —— 条数一条不差, 红在「前 `D` 条逐条相同」(Guardrail 8 的正面证据) |
// | `candidateCapDropped` 恒 `0` (不上浮) | `state_branch 8` **红**, `7` 仍绿 —— `K` 的两个方向都真的被守住 (`SC-016`) |
// | 截断判据改 `>=` (`ranked.length < limit`) | **全绿** ⇒ 本层验不到这条分野, 已如实登记在 `state_branch 2` 的注释里, 判据落 Small 档 |
//
// ## 📌 `052` 那 3 条被 T003 删掉的断言: 判断结论 = **仍有可测的残余, 已补 (最后一条 `it()`)**
//
// T003 从 `optionsdesk-052.retrieval.it.spec.ts` 删掉了 3 条「覆盖只作用于请求的那一个视角」的断言
// (`widened.criteriaByTab.build/all.outcomes.…state === 'default'` 与 `narrowed.criteriaByTab.build`)
// —— 它们从**一份响应**里读另外两个视角的条件面, 而 `FR-005` 收窄后那个结构不存在了。逐面核过:
//
// - **跨请求串味 (「带 `rent` 覆盖请求一次 → 再无覆盖请求 `build`」) 在新架构下是结构性恒真**, 故
//   **不补**: `GetLegsUseCase` 与 `PrismaLegRetrievalAdapter` 都是无字段的贫血 class, 两者与召回层
//   之间零共享可变状态、零缓存 (`rg 'cache|static |new Map\(' get-legs.usecase.ts
//   leg-retrieval.adapter.ts` 零命中), 每次 `execute` 从库重取。补一条这样的 IT 只会断言「两次纯
//   函数调用互不影响」, 是同义反复。
// - **同一次请求内「覆盖声明的视角 ≠ 本次作答的视角」的守卫仍在, 且仍会红** ⇒ **补**: 判据是
//   `leg-recall.rules.ts:805` 的 `override.perspective !== tab` 那一句。它被拆掉的话, 收租的覆盖会
//   当场作用到建仓的召回集上, 而**腿数、名次、档位全都正常** —— 正是原来那 3 条断言守的同一件事,
//   在收窄后唯一还够得着的落点。
describe('053 查询下沉 · 服务端侧 state branch (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  /** 请求时刻 = 2026-08-04 ET 16:00 ⇒ 交易所的今天恒为 2026-08-04 (钉住 DTE 基准)。 */
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

  // ── 装配 ──────────────────────────────────────────────────────────────────

  const useCaseOf = (): GetLegsUseCase =>
    new GetLegsUseCase(prisma, new PrismaLegRetrievalAdapter(prisma), stubTradingCalendar(), {
      marchPhiTier: 'good',
      marchMode: 'phi',
    });

  /**
   * 只换 `candidateCap` 一个入参的 port 包装 —— `K` 触及分支的驱动手段 (`SC-016`)。
   *
   * 🚨 **它不是 fake**: 真 `PrismaLegRetrievalAdapter` 照常查真库、召回判据一条没换, 换的只是那个
   * 保险丝的数值。`K` 与 `N` 不同, 它**不在 use case 签名上可注入** (use case 恒传
   * `RECALL_CANDIDATE_CAP`) —— 它是给下游限流的保险丝而不是展示参数, 开个注入口子等于把
   * 「调容量」做成调用方的日常配置 (Guardrail 14 的同一条理由)。
   */
  class CappedRetrieval implements LegRetrievalPort {
    constructor(
      private readonly inner: LegRetrievalPort,
      private readonly cap: number,
    ) {}

    retrieveCandidates(query: LegRetrievalQuery): Promise<LegRetrievalResult | null> {
      return this.inner.retrieveCandidates({ ...query, candidateCap: this.cap });
    }

    // 055 起 port 多一个整链方法。本包装只改候选上限那一个入参 ⇒ 这里原样透传, 🚫 别在这
    // 加任何加工 (它不在本 IT 的验收面内, 加工了会让「换的只是保险丝」这句话不再成立)。
    retrieveChain(query: LegChainQuery): Promise<LegChainSnapshot | null> {
      return this.inner.retrieveChain(query);
    }

    // #361 起 port 多一个「链缺席成因」方法。同上原样透传。
    chainAbsenceReason(query: LegChainQuery): Promise<ChainAbsenceReason> {
      return this.inner.chainAbsenceReason(query);
    }
  }

  const cappedUseCaseOf = (cap: number): GetLegsUseCase =>
    new GetLegsUseCase(
      prisma,
      new CappedRetrieval(new PrismaLegRetrievalAdapter(prisma), cap),
      stubTradingCalendar(),
      { marchPhiTier: 'good', marchMode: 'phi' },
    );

  const codesOf = (view: LegTableView): string[] => view.legs.map((leg) => leg.code);

  // ── 造数 ──────────────────────────────────────────────────────────────────

  interface SeedLeg {
    readonly code: string;
    readonly dte: number;
    readonly strike: string;
    readonly bid: string | null;
    readonly ask: string | null;
    readonly oi: string | null;
    readonly vol: string | null;
  }

  async function seedLegs(legs: readonly SeedLeg[], spot: string = SPOT): Promise<void> {
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
      const expiry = new Date(dateOf(TODAY).getTime() + leg.dte * 86_400_000);
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: leg.code,
          root: 'PEP',
          underlyingInstrumentId: instrument.id,
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
          underlyingSpot: spot,
          greeksComplete: true,
        },
      });
    }
    await seedAnchor();
  }

  /** 锚是本端点的前置 (无锚 → 404), 与链是两件事 ⇒ 单独一支给「链未就绪」用。 */
  async function seedAnchor(): Promise<void> {
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
      },
    });
  }

  /**
   * 梯子链 —— 6 条**三个视角全部合格**的腿, DTE 与行权价逐条错开。
   *
   * 🚨 全部合格是刻意的: 本组验的是**截断**, 混进被门槛挡下的腿会让「截了几条」与「挡了几条」两个
   * 数纠缠, 断言红了分不清是谁的错 (承 `052` 的造数纪律)。
   * 📌 逐条过判据: DTE `35..40` 同时落建仓段 `[1,49]` 与收租段 `[30,365]`; 行权价 `120..115` 全在
   * 成色上界 (`132.40 × 1.03 = 136.372`) 之下且有效成本 `K − 3` 远低于 spot; 相对价差
   * `0.20 / 3.10 = 0.065` < `0.35`; OI/Vol 与权利金全部过线。
   */
  const LADDER_LEGS: readonly SeedLeg[] = Array.from({ length: 6 }, (_, i) => ({
    code: `L-${i}`,
    dte: 35 + i,
    strike: (120 - i).toString(),
    bid: '3.00',
    ask: '3.20',
    oi: '900',
    vol: '40',
  }));

  const LADDER_SIZE = LADDER_LEGS.length;

  /**
   * 混合链 —— 四条腿, **每条各自被一个意图条件排除或不被排除** (照抄 `052` T008 的靶场形态)。
   * `SC-012` 的回归防线用它: 三条被排除的腿在全腿视角逐条可达。
   */
  const MIXED_LEGS: readonly SeedLeg[] = [
    // 深度实值: K=150 > spot ⇒ 收租被**成色上界**挡 (上界 136.372); 建仓过得去 (成本 132 < spot)。
    { code: 'P-ITM', dte: 35, strike: '150', bid: '18.00', ask: '19.00', oi: '900', vol: '40' },
    // 价差宽: rel = 3 / 4.5 = 0.667 > 0.35 ⇒ 被**流动性门槛**挡出两个意图视角。
    // 🚨 `bid` 蓄意压到 1.00（年化 < 收租 good 档界）—— 071 起 bid 年化达档的宽价差腿走
    // **机会支**进收租候选（071 FR-001），那样这条腿就不再「被流动性门槛挡下」，本组断言的
    // 判据面会被换掉；机会支自身的分支在 optionsdesk-071.wide-spread.it.spec.ts 逐条验。
    { code: 'P-WIDE', dte: 35, strike: '120', bid: '1.00', ask: '6.00', oi: '900', vol: '40' },
    // DTE 400: 两个意图**期限段**都够不着。
    { code: 'P-LONG', dte: 400, strike: '118', bid: '3.00', ask: '3.20', oi: '900', vol: '40' },
    // 对照: 各条件全过。
    { code: 'P-OK', dte: 35, strike: '115', bid: '3.00', ask: '3.20', oi: '900', vol: '40' },
  ];

  // ── state_branch 1 / 2 / 3 / 6 · 截断的四条分支 ───────────────────────────

  it('🚨 state_branch 1: 候选数 < 阈值 ⇒ 不截断, 「其余 N−D 条」恒为 0 (截断计数 MUST NOT 出现)', async () => {
    await seedLegs(LADDER_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'rent', NOW, null, LADDER_SIZE + 4);
    expect(view.legs).toHaveLength(LADDER_SIZE);
    expect(view.matchedCount).toBe(LADDER_SIZE);
    // 表达层据此判「有没有截」—— 差为 0 ⇒ 那一条整条不渲染 (FR-018)。
    expect(view.matchedCount - view.legs.length).toBe(0);
    expect(view.displayLimit).toBe(LADDER_SIZE + 4);
  });

  it('🚨 state_branch 2 (边界): 候选数**恰等于**阈值 ⇒ 表上一条不少, 截断计数不出现', async () => {
    await seedLegs(LADDER_LEGS);
    const usecase = useCaseOf();
    const view = await usecase.execute(SYMBOL, 'rent', NOW, null, LADDER_SIZE);
    expect(view.legs).toHaveLength(LADDER_SIZE);
    expect(view.matchedCount).toBe(LADDER_SIZE);
    expect(view.matchedCount - view.legs.length).toBe(0);
    // 恰等于阈值这一趟与「不设阈值」逐条同一份表 —— 边界上一条腿都没少。
    expect(codesOf(view)).toEqual(codesOf(await usecase.execute(SYMBOL, 'rent', NOW, null, null)));

    // ⚠️ **本层验不到 `>` 与 `>=` 的分野, 如实登记不冒充** (变异实测 2026-08-14): 把判据改成
    // `ranked.length < limit` 之后 `slice(0, limit)` 在 `length === limit` 上取回的是**同样的
    // 6 条**, 于是本文件 16 条断言**全绿** —— 内容层面两种写法在边界上不可分辨。
    // ⇒ 严格性的判据落 **Small 档**: `leg-rank.rules.spec.ts` 的
    // `expect(truncateToDisplayLimit(ranked, ranked.length)).toBe(ranked)` (返回**入参本体**而非
    // 拷贝) 是唯一能把两者分开的形态, 那条已由 T002 ship。本条守的是它的**用户可见后果**。
  });

  it('🚨 state_branch 3 + Guardrail 8: 候选数 > 阈值 ⇒ 截到阈值, **且截掉的必是精排序的尾部**', async () => {
    await seedLegs(LADDER_LEGS);
    const usecase = useCaseOf();
    const full = await usecase.execute(SYMBOL, 'rent', NOW, null, null);
    const cut = await usecase.execute(SYMBOL, 'rent', NOW, null, 3);

    // 🚫 只断条数是假绿 (Guardrail 8): 条数对不代表截对了那一段。
    expect(codesOf(cut)).toEqual(codesOf(full).slice(0, 3));
    // 非同义反复的两条守卫: 被截掉的那一段**非空**, 且它逐条不在截断后的表里。
    const dropped = codesOf(full).slice(3);
    expect(dropped.length).toBeGreaterThan(0);
    for (const code of dropped) expect(codesOf(cut)).not.toContain(code);
    // `matchedCount` 取**截断前**的条数 ⇒ 两次请求恒等; 「其余 N−D 条」由它减 `legs.length` 现算
    // (🚫 `D` 与差值都不下发, Guardrail 11)。
    expect([cut.matchedCount, full.matchedCount]).toEqual([LADDER_SIZE, LADDER_SIZE]);
    expect(cut.matchedCount - cut.legs.length).toBe(LADDER_SIZE - 3);
  });

  it('🚨 state_branch 6 / SC-006: 注入小阈值**走遍**截断分支 —— 同一批真实数据, 逐个阈值前 D 条恒相同', async () => {
    await seedLegs(LADDER_LEGS);
    const usecase = useCaseOf();
    const full = await usecase.execute(SYMBOL, 'all', NOW, null, null);
    expect(full.legs).toHaveLength(LADDER_SIZE);

    for (let limit = 1; limit <= LADDER_SIZE + 1; limit += 1) {
      const view = await usecase.execute(SYMBOL, 'all', NOW, null, limit);
      expect([limit, codesOf(view)]).toEqual([
        limit,
        codesOf(full).slice(0, Math.min(limit, LADDER_SIZE)),
      ]);
      expect([limit, view.matchedCount]).toEqual([limit, LADDER_SIZE]);
      expect([limit, view.displayLimit]).toEqual([limit, limit]);
    }

    // 🚨 **注入手段的存在理由就在这一行**: 真实规模下这条链够不着任何一档常量阈值 ⇒ 不注入的话
    // 上面六个分支一条都拿不到覆盖, 而「没覆盖」在测试报告里长得跟「覆盖了且绿」一模一样。
    for (const tab of LEG_TABS) {
      const byDefault = await usecase.execute(SYMBOL, tab, NOW);
      expect([tab, byDefault.matchedCount - byDefault.legs.length]).toEqual([tab, 0]);
    }
  });

  // ── state_branch 5 · 收窄使结果降到阈值以下 ────────────────────────────────

  it('🚨 state_branch 5: 收窄条件使结果降到阈值以下 ⇒ 截断计数**消失**, MUST NOT 停在旧值', async () => {
    await seedLegs(LADDER_LEGS);
    const usecase = useCaseOf();
    const truncated = await usecase.execute(SYMBOL, 'rent', NOW, null, 3);
    expect(truncated.matchedCount - truncated.legs.length).toBe(LADDER_SIZE - 3);

    // 上界收到 117 ⇒ 成员降到 3 条 (117 / 116 / 115), 恰等于阈值 ⇒ 不截。
    const narrowed = await usecase.execute(
      SYMBOL,
      'rent',
      NOW,
      { perspective: 'rent', criteria: { strikeMax: new Prisma.Decimal('117') } },
      3,
    );
    expect(narrowed.matchedCount).toBe(3);
    expect(narrowed.legs).toHaveLength(3);
    // 🚨 这个差就是表达层那句话的唯一数据源 —— 它归零 ⇒ 那一条不渲染。停在旧值 (3) 的实现在
    // 条数上看不出任何异常。
    expect(narrowed.matchedCount - narrowed.legs.length).toBe(0);
    expect(narrowed.criteria.outcomes.strikeMax.state).toBe('narrowed');
  });

  // ── state_branch 4 · SC-012 回归防线 ──────────────────────────────────────

  it('🚨 state_branch 4 / SC-012: 被意图视角任一条件排除的腿, 在全腿视角**逐条可达**且截断吞不掉', async () => {
    await seedLegs(MIXED_LEGS);
    const usecase = useCaseOf();
    const all = await usecase.execute(SYMBOL, 'all', NOW);
    const build = await usecase.execute(SYMBOL, 'build', NOW);
    const rent = await usecase.execute(SYMBOL, 'rent', NOW);

    // 三条各被一个意图条件排除。
    expect(codesOf(rent)).not.toContain('P-ITM'); // 成色上界
    expect(codesOf(build)).not.toContain('P-WIDE'); // 流动性门槛
    expect(codesOf(rent)).not.toContain('P-WIDE');
    expect(codesOf(build)).not.toContain('P-LONG'); // 期限段
    expect(codesOf(rent)).not.toContain('P-LONG');
    // 🚨 `051` ship 的入口 (点流动性排除数 → 切全腿看被排除的腿) 指向的正是这张表 —— **默认阈值
    // 下**一条都不许少。截在它们之前的话, 那个入口指向一张不含目标的表, 而**不会红**。
    expect(codesOf(all).sort()).toEqual(['P-ITM', 'P-LONG', 'P-OK', 'P-WIDE']);
    expect(all.matchedCount - all.legs.length).toBe(0);

    // 🚨 **证明上面那条不是同义反复**: 全腿阈值若低到 1, 三条被排除的腿当场从这张表上消失 ——
    // 这正是 `FR-014` 说「全腿阈值有硬下界」的可执行形态, 也是 T012 标定该视角时的下界输入。
    const starved = await usecase.execute(SYMBOL, 'all', NOW, null, 1);
    expect(starved.legs).toHaveLength(1);
    const swallowed = ['P-ITM', 'P-LONG', 'P-WIDE'].filter(
      (code) => !codesOf(starved).includes(code),
    );
    expect(swallowed.length).toBeGreaterThanOrEqual(2);
    expect(starved.matchedCount).toBe(MIXED_LEGS.length);
  });

  // ── state_branch 7 / 8 · 候选上限 K ───────────────────────────────────────

  it('🚨 state_branch 7: `K` 未触及 ⇒ 触及数为 0, 异常提示 MUST NOT 出现 (真常量路径)', async () => {
    await seedLegs(LADDER_LEGS);
    const view = await useCaseOf().execute(SYMBOL, 'all', NOW);
    // 真常量量级远高于本链 ⇒ 结构上不可能触及。断的是「接通了且为 0」, 不是「切了」。
    expect(RECALL_CANDIDATE_CAP).toBeGreaterThan(LADDER_SIZE);
    expect(view.candidateCapDropped).toBe(0);
    expect(view.matchedCount).toBe(LADDER_SIZE);
  });

  it('🚨 state_branch 8 / SC-016: `K` 被触及 ⇒ 触及数下发, **且 `matchedCount` 的失真可被观测**', async () => {
    await seedLegs(LADDER_LEGS);
    const intact = await useCaseOf().execute(SYMBOL, 'all', NOW);
    const blown = await cappedUseCaseOf(2).execute(SYMBOL, 'all', NOW);

    // 触及呈现**必须出现** (两个方向都验: 上一条是不注入时必须不出现)。
    expect(blown.candidateCapDropped).toBe(LADDER_SIZE - 2);
    expect(intact.candidateCapDropped).toBe(0);

    // 🚨 **这才是 `K` 必须上契约的理由** (FR-019c): `matchedCount` 算在已被 `K` 砍过的集合上 ⇒
    // 「其余 N−D 条未显示」会**少报**, 而条数与数值全都正常、不会红。触及数是唯一的显形处。
    expect(blown.matchedCount).toBe(2);
    expect(blown.matchedCount).toBeLessThan(intact.matchedCount);
    // 🚫 它蓄意**不进** `gateCounts` —— 那三个数是「判据挡下了什么」, 这一个是「保险丝熔断了」,
    // 处置一个调条件、一个调容量 (Guardrail 14)。
    expect(blown.gateCounts).toEqual(intact.gateCounts);
  });

  // ── state_branch 9 / 10 · memberCount 与 matchedCount ─────────────────────

  it('🚨 state_branch 9: 未覆盖任何条件 ⇒ `memberCount === matchedCount` (区块头 MUST NOT 并列两个相等的数)', async () => {
    await seedLegs(LADDER_LEGS);
    for (const tab of LEG_TABS) {
      const view = await useCaseOf().execute(SYMBOL, tab, NOW);
      expect([tab, view.memberCount, view.matchedCount]).toEqual([tab, LADDER_SIZE, LADDER_SIZE]);
    }
  });

  it('🚨 state_branch 10: 收窄检索条件 ⇒ `memberCount > matchedCount` (无覆盖口径的基准仍答得出)', async () => {
    await seedLegs(LADDER_LEGS);
    const narrowed = await useCaseOf().execute(SYMBOL, 'rent', NOW, {
      perspective: 'rent',
      criteria: { strikeMax: new Prisma.Decimal('117') },
    });
    expect(narrowed.matchedCount).toBe(3);
    // 🚫 MUST NOT 拿六维边际计数加总充当它 (Guardrail 12): 那是「把这一维换回默认能多看几条」,
    // 被两维同时挡下的腿两维都不计它 ⇒ 加总少报。这里要的是**无覆盖口径的成员数**本身。
    expect(narrowed.memberCount).toBe(LADDER_SIZE);
    expect(narrowed.memberCount).toBeGreaterThan(narrowed.matchedCount);
  });

  // ── state_branch 11 · 响应收窄后每腿只带当前视角那一份 ──────────────────────

  it('🚨 state_branch 11 / SC-002 (服务端一半): 每腿只带当前视角的档位与活跃标, 契约里 by-tab 零残留', async () => {
    await seedLegs(LADDER_LEGS);
    for (const tab of LEG_TABS) {
      const response = toLegTableResponse(await useCaseOf().execute(SYMBOL, tab, NOW));
      // 顶层: `tabOrder` 删而非收窄 (数组顺序**就是**顺序), 七处 by-tab 结构一处不留。
      expect([tab, Object.keys(response).filter((k) => /ByTab$|^tabOrder$/.test(k))]).toEqual([
        tab,
        [],
      ]);
      expect([tab, JSON.stringify(response).includes('ByTab')]).toEqual([tab, false]);
      // 口径跟视角走 (FR-041): 建仓周化 / 收租与全腿年化, 每腿逐条与区块级同口径。
      expect([tab, response.basis]).toEqual([tab, BASIS_BY_TAB[tab]]);
      expect(response.legs.length).toBeGreaterThan(0);
      for (const leg of response.legs) {
        expect(Object.keys(leg).filter((k) => /ByTab$|^tabs$/.test(k))).toEqual([]);
        expect(leg.basis).toBe(BASIS_BY_TAB[tab]);
        // 标量而不是三格映射 —— 档位是串、活跃标是单个对象。
        expect(leg.tier === null || typeof leg.tier === 'string').toBe(true);
        expect(leg.activity === null || typeof leg.activity.isTopRanked === 'boolean').toBe(true);
      }
      // 回显本次作答的视角 (迟到的那一发靠它认领, FR-008)。
      expect([tab, response.perspective]).toEqual([tab, tab]);
    }
  });

  // ── state_branch 12 · 三视角同业务日 ──────────────────────────────────────

  it('🚨 state_branch 12 / FR-020 的检测判据来源: 三视角落在同一业务日 ⇒ 链级字段三份逐字恒等', async () => {
    await seedLegs(LADDER_LEGS);
    const usecase = useCaseOf();
    const views = await Promise.all(LEG_TABS.map((tab) => usecase.execute(SYMBOL, tab, NOW)));
    // 链级 = 不随视角变的那一层 (FR-005 的左半表)。客户端正是拿 `asOf` 三份比对来判「跨业务日」
    // ⇒ 它在同一业务日里必须逐字相同, 否则那条检测恒为真、重取一次后照样提示。
    const chainLevelOf = (view: LegTableView) => ({
      symbol: view.symbol,
      state: view.state,
      asOf: view.asOf,
      quoteAsOf: view.quoteAsOf,
      oiAsOf: view.oiAsOf,
      lastClosedSession: view.lastClosedSession,
      source: view.source,
      spot: view.spot?.toString() ?? null,
      w: view.w.toString(),
      zone: view.zone,
      lLevel: view.lLevel,
      positionBucket: view.positionBucket,
      intent: view.intent,
      rentDepth: view.rentDepth,
      // 权利金门槛是**整条移出**, 三视角都看不到 ⇒ 它也是链级的那一半。
      removedByPremiumFloor: view.gateCounts.removedByPremiumFloor,
    });
    expect(chainLevelOf(views[1]!)).toEqual(chainLevelOf(views[0]!));
    expect(chainLevelOf(views[2]!)).toEqual(chainLevelOf(views[0]!));
    // 🚨 视角级的那一半**必须**随视角变, 否则上面那条退化成「响应恒等」的同义反复。
    expect(views.map((v) => v.perspective)).toEqual([...LEG_TABS]);
  });

  // ── FR-015 · 未触发截断时两个数仍下发 ──────────────────────────────────────

  it('🚨 FR-015: **未触发截断时** `displayLimit` 与 `matchedCount` 仍下发 (逼近度随时可算)', async () => {
    await seedLegs(LADDER_LEGS);
    for (const tab of LEG_TABS) {
      const view = await useCaseOf().execute(SYMBOL, tab, NOW);
      // 本链远低于任一档阈值 ⇒ 这一趟没截。
      expect([tab, view.matchedCount - view.legs.length]).toEqual([tab, 0]);
      // 🚨 只在截断时下发会让「链规模逼近阈值」恰恰观测不到, 而那正是本条要防的静默。
      expect([tab, view.displayLimit]).toEqual([tab, DISPLAY_LIMIT_BY_PERSPECTIVE[tab]]);
      expect([tab, view.matchedCount]).toEqual([tab, LADDER_SIZE]);
      // 🚫 MUST NOT 为逼近度新增 `isNearLimit` 之类的派生布尔 —— 它由这两个数算得出来。
      expect(view.matchedCount / (view.displayLimit ?? Number.POSITIVE_INFINITY)).toBeLessThan(1);
    }
  });

  // ── state_branch 24 · 链未就绪 / 跨 ctx 读故障 ────────────────────────────

  it('🚨 state_branch 24: 链未就绪 ⇒ 沿用既有的 `chain_not_ready`, 本片零行为改动 (新字段照常回显)', async () => {
    await seedAnchor(); // 有锚、无 instrument ⇒ 检索层返 null。
    const view = await useCaseOf().execute(SYMBOL, 'rent', NOW);
    expect(view.state).toBe('chain_not_ready');
    expect(view.legs).toEqual([]);
    // 三个计数取 0 而非 null —— 它们是计数不是「未知」(既有纪律, 本片不改)。
    expect([view.matchedCount, view.memberCount, view.candidateCapDropped]).toEqual([0, 0, 0]);
    // 🚨 阈值**与链无关**, 空态照样如实回显 (FR-015): 给 null 会让「不设阈值」与「没链」在客户端
    // 读成同一件事。
    expect(view.displayLimit).toBe(DISPLAY_LIMIT_BY_PERSPECTIVE.rent);
    // 锚派生那半边照常返回 (046 起的降级纪律)。
    expect(view.w.greaterThan(0)).toBe(true);
    expect(view.perspective).toBe('rent');
  });

  it('🚨 state_branch 24: 跨 ctx 读故障 ⇒ 沿用既有的 `read_failed` (与 `chain_not_ready` 蓄意分开)', async () => {
    await seedLegs(LADDER_LEGS);
    const exploding: LegRetrievalPort = {
      retrieveCandidates: () => Promise.reject(new Error('marketdata read blew up')),
      // 选约表走不到这个方法 (它是 055 报表的入口), 但 port 契约要求实现 —— 同样炸, 免得
      // 「哪个方法炸了」变成本分支的隐含前提。
      retrieveChain: () => Promise.reject(new Error('marketdata read blew up')),
      // #361: 读故障路径**根本走不到成因判定** —— `read_failed` 由抛出决定, use case 在
      // catch 里就分派完了。这里同样炸, 理由同上一条。
      chainAbsenceReason: () => Promise.reject(new Error('marketdata read blew up')),
    };
    const view = await new GetLegsUseCase(prisma, exploding, stubTradingCalendar(), {
      marchPhiTier: 'good',
      marchMode: 'phi',
    }).execute(SYMBOL, 'build', NOW);
    // 🚨 两个状态**不可合并**: 前者是事实 (采集还没轮到), 后者是故障 —— 混成一个值会让「缺口」
    // 看起来像「正常的空」。本片新增的字段一个都不许改这条分支的行为。
    expect(view.state).toBe('read_failed');
    expect(view.legs).toEqual([]);
    expect([view.matchedCount, view.memberCount, view.candidateCapDropped]).toEqual([0, 0, 0]);
    expect(view.displayLimit).toBe(DISPLAY_LIMIT_BY_PERSPECTIVE.build);
    expect(view.w.greaterThan(0)).toBe(true);
  });

  // ── `052` T003 删掉那 3 条断言的残余 (判断结论见文件头) ────────────────────

  it('🚨 覆盖只作用于**它自己声明的那个视角** —— 收租的覆盖 MUST NOT 落到建仓的召回集上', async () => {
    await seedLegs(LADDER_LEGS);
    const usecase = useCaseOf();
    const baseline = await usecase.execute(SYMBOL, 'build', NOW);
    // 同一次请求里, 覆盖声明的是 `rent` 而本次作答的是 `build`。
    const foreign = await usecase.execute(SYMBOL, 'build', NOW, {
      perspective: 'rent',
      criteria: { strikeMax: new Prisma.Decimal('117') },
    });
    // 逐条相同 —— 不是「条数相同」: 守卫被拆掉的话腿数、名次、档位**全都正常**, 变的只是成员。
    expect(codesOf(foreign)).toEqual(codesOf(baseline));
    expect(foreign.criteria.outcomes.strikeMax.state).toBe('default');
    expect([foreign.matchedCount, foreign.memberCount]).toEqual([
      baseline.matchedCount,
      baseline.memberCount,
    ]);
    // 🚨 **证明它非同义反复**: 同一个覆盖打在**它自己声明的**视角上时确实改变成员集。
    const owned = await usecase.execute(SYMBOL, 'rent', NOW, {
      perspective: 'rent',
      criteria: { strikeMax: new Prisma.Decimal('117') },
    });
    expect(owned.matchedCount).toBeLessThan(baseline.matchedCount);
  });
});
