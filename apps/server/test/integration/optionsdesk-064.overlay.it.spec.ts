import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupIsolatedStores } from '../_support/isolated-db';
import { AppModule } from '../../src/app/app.module';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { Prisma } from '../../src/generated/prisma/client';
import { GetLegsUseCase } from '../../src/optionsdesk/get-legs.usecase';
import { GetChainReportUseCase } from '../../src/optionsdesk/get-chain-report.usecase';
import { LEG_TABS } from '../../src/optionsdesk/leg-tab.rules';
import {
  RECALL_CANDIDATE_CAP,
  type RetrievalOverride,
} from '../../src/optionsdesk/leg-recall.rules';
import {
  LEG_RETRIEVAL_PORT,
  type LegRetrievalPort,
  type RealtimeChainDegradeKind,
} from '../../src/optionsdesk/leg-retrieval.port';
import {
  OPTION_SNAPSHOT_READ_PORT,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
  type OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';
import {
  MARKET_STATE_PORT,
  type MarketSession,
  type MarketSessionState,
  type MarketStatePort,
} from '../../src/marketdata/market-state.port';
import type { LegChainSnapshot } from '../../src/optionsdesk/leg-retrieval.port';

/**
 * 064 T003 + T004a —— **实时开关的两档**: 关态逐字节等价 (`FR-009` / `FR-015` / `FR-016` /
 * `SC-005`, `state_branch` 2) + 开态尾部覆盖七列 / OI 结构性不覆盖 (`FR-001` / `FR-002` /
 * `FR-003` / `FR-004` / `FR-019` / `SC-006` / `SC-007`, `state_branches` 1 / 8 / 9 / 10),
 * plan D1 / D6 / D7 / D8。
 *
 * 📌 降级四路径 (超时 / 部分缺失 / 非交易时段 / 基准陈旧) 与两个标的现价归 T005 / T004b,
 * **本文件的开态只走 happy path** —— 别在这里为它们补 `it()`, 会与那两个 task 撞车。
 *
 * ## 为什么必须要真 PG + 真 DI 容器
 *
 * ① **真 PG**: 本文件要证的是「两个读端点的输出与上线前逐字节相同」。那份输出是**真查询取回的
 *    那批行**一路经召回 / 派生 / 打标组装出来的 —— 假 port 上「逐字节相同」退化成「我塞进去的
 *    夹具原样出来」, 而真正会漂的两处 (adapter 的 dedupe 与组装顺序、spot 取自哪一行) 结构上
 *    照不到。PG 从 `test/_support/isolated-db.ts` 的 `setupIsolatedStores()` 取 (共享 PG 的模板
 *    克隆 + 一个 Redis), 🚫 禁自起 Testcontainers。
 * ② **真 DI 容器**: 「对读取口的调用次数 = 0」这条判据要能在 T004a 接上 overlay 之后**继续**
 *    成立才有意义, 而那时读取口是经 `@Optional() @Inject()` 注入的 —— 可选注入解析不到时会
 *    静默拿到 `undefined`, 于是 overlay 永不发生、所有 `new` 出来的测试照样全绿, 而 prod 上
 *    实时档从此不生效。只有真容器答得了「注进去的到底是不是那个 token」。
 *    📌 `imports` 里 `AppModule` 与 `OptionsdeskModule` **两个都要**: 前者带进全局
 *    `ThrottlerModule` 等根级注册物 (只导 `OptionsdeskModule` 会在 `AccountIdThrottlerGuard`
 *    处解析失败, 与本 feature 无关); 后者是被测的那张接线图。
 *
 * ## 🚨 关态的唯一机器判据是**调用计数**, 不是「看起来没变」
 *
 * `overrideProvider(OPTION_SNAPSHOT_READ_PORT)` 换上一个**计数器**实现: 它一旦被调到, 计数就
 * 不是 0。这是 `FR-016` / `state_branch` 2 的唯一机器化 —— 靠肉眼比对响应永远发现不了「多打了
 * 一次外呼但结果恰好一样」(实时源在收盘后返回的就是同一批收盘值)。
 *
 * ## 基线夹具怎么来的 (golden file)
 *
 * `optionsdesk-064.baseline.json` 是**在 T003 动 src 之前**跑本文件、由
 * `NVY_064_WRITE_BASELINE=1` 写出的一份快照。之后它只读不写: 任何一处输出变了都会在这里逐字符
 * 红。要重新生成 (仅当**蓄意**改变输出契约时) 就带那个 env 再跑一次, 并在 PR 里说明为什么。
 *
 * ⚠️ **2026-08-31 (071) 唯一一次重生成**, 理由与逐行核对留档:
 * 本夹具的 `L-WIDE` (K=85 / bid 3 / ask 6 / DTE 35) 相对价差 0.667 > 上界、而 bid 年化 38.2%
 * **达收租 good 档** ⇒ 071 的宽价差机会支正是为它这类腿开的, 它自此进收租候选。这不是回归,
 * 是本片蓄意改变的成员语义 (ADR-0068 §决策 7)。
 * 🚨 **重生成前逐行核对过 diff**: 全部改动 = `legs:rent` 增 `L-WIDE` 一行 + 由它直接派生的四个
 * 数 (`excludedFromIntentTabs 1→0` / `matchedCount`、`memberCount 1→2` / 该 tier 桶的
 * `legCount`、`best`、`runnerUp`)。**既有字段的值零改动** —— `SC-005` 要的那个问题在本次仍有
 * 答案。🚫 下次再撞上别照抄这条: 先看 diff 是不是同样只含「本片蓄意语义」的直接派生。
 *
 * 📌 **2026-09-06 (#378) 手工补 3 行, 非重生成**: `legs:all` / `legs:build` / `legs:rent` 各在
 * `source` 后插 `"windowShape": null` —— 契约新增的候选面标识, 收盘档恒 `null`。既有字段的值
 * 零改动; `chain-report` 不带该字段, 未动。
 */

/** 本批实时报价的**我方采集时刻** (信封 `as_of`) —— 与库内 `quote_as_of` 蓄意不同刻。 */
const REALTIME_AS_OF = new Date('2026-08-11T17:45:03.000Z');

/**
 * 计数 + 可编程的读取口替身。
 *
 * 🚨 **计数是关态的唯一机器判据** (`FR-016`), `respond` 是开态的输入面。默认返回**空批**:
 * 忘了给 `respond` 的用例会拿到「一条都没覆盖」而不是「悄悄覆盖成了某个默认值」。
 */
class SpySnapshotReadPort implements OptionSnapshotPort {
  readonly calls: OptionSnapshotQuery[] = [];
  respond: (query: OptionSnapshotQuery) => OptionSnapshotBatch = () => ({
    asOf: REALTIME_AS_OF,
    rows: [],
  });
  /** T005 `state_branch` 4 的两种输入之一: 源不可达 (抛)。`null` = 正常回放 {@link respond}。 */
  fail: Error | null = null;
  /** 另一种: 超时 —— 永不 settle 的调用, 由被测那侧的请求级超时把它切断。 */
  hang = false;

  getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
    this.calls.push(query);
    if (this.fail !== null) return Promise.reject(this.fail);
    if (this.hang) return new Promise<OptionSnapshotBatch>(() => {});
    return Promise.resolve(this.respond(query));
  }
}

/**
 * 市场时段替身 (T005 `state_branch` 3 的一半)。
 *
 * 🚨 **必须 override 掉它**: `MARKET_STATE_PORT` 经 `collectionPort()` 注册, mock 档下绑的是
 * **拒绝壳**(调用即抛) ⇒ 不换掉的话每条实时用例都会走 fail-closed, 全文件的开态断言集体假绿成
 * 「反正没外呼」。
 */
class FakeMarketStatePort implements MarketStatePort {
  session: MarketSession = 'regular';
  fail: Error | null = null;
  /** P0a hk guard 用例的追加市场 (默认空 —— 既有用例只看 us, 行为零变化)。 */
  extra: MarketSessionState[] = [];

  getMarketSessions(): Promise<MarketSessionState[]> {
    if (this.fail !== null) return Promise.reject(this.fail);
    return Promise.resolve([{ market: 'us', session: this.session }, ...this.extra]);
  }
}

/** `nx test server` 的 cwd 恒为 `apps/server` (同本目录其余 IT 的 `SERVER_DIR` 体例)。 */
const BASELINE_PATH = join(process.cwd(), 'test/integration/optionsdesk-064.baseline.json');
const WRITE_BASELINE = process.env.NVY_064_WRITE_BASELINE === '1';

/**
 * `bigint` 是 `JSON.stringify` 的硬错; 其余 (Date / Decimal) 各自的 `toJSON` 已经稳定。
 *
 * 🚨 **`priceKind` (064 T007) / `realtimeDegrade` (064 T007a) / `bandStatus` (068 T007) /
 * `march` (069 T006) / `marchMode` (070 T002) / `wideSpreadOpportunity` (071 T006) 逐个
 * 剔除**: 蓄意给两个读端点的出参**新增**的键, 它们是各自 feature 的产出而不是回归。⇒ 基线夹具
 * **保持冻结**在 064 之前那一份, 断言退成「除了这两个蓄意新增的键, 其余逐字符相同」。
 * 🚫 **MUST NOT 改成重新生成一份基线** —— 重生成会把「既有字段的值有没有被改动」这个问题一起
 * 抹掉 (新旧两份都是本次跑出来的, 逐字符自然相同), 而 `SC-005` 要的正是那个问题的答案。
 * 📌 档位字段本身的取值由本文件 T003 / T004a / T005 的用例逐条钉住, 不靠这条基线。
 */
function stable(value: unknown): string {
  return JSON.stringify(
    value,
    (key, v: unknown) => {
      if (
        key === 'priceKind' ||
        key === 'realtimeDegrade' ||
        key === 'bandStatus' ||
        key === 'march' ||
        key === 'marchMode' ||
        key === 'wideSpreadOpportunity'
      )
        return undefined;
      return typeof v === 'bigint' ? v.toString() : v;
    },
    2,
  );
}

describe('064 实时开关关态 · 逐字节等价 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let readPort: SpySnapshotReadPort;
  let marketState: FakeMarketStatePort;
  /**
   * 064 T006 —— warn 的**全量**捕获面 (`FR-023`)。
   *
   * 🚨 采集端一律不过滤 (记下每一条 warn), 归类只发生在断言侧 —— 采集时就按前缀筛的话,
   * `SC-010` 那条「降级了但不属于三类」的反例**结构上看不见**: 管道里根本没有它的位置。
   */
  const warnings: string[] = [];

  /** 请求时刻 = 2026-08-11 ET 16:00 ⇒ 交易所的今天恒为 2026-08-11 (钉住 DTE 基准)。 */
  const NOW = new Date('2026-08-11T20:00:00.000Z');
  const TODAY = '2026-08-11';
  const PREV_SESSION = '2026-08-10';

  const SYMBOL = 'us:PEP';
  /** 现价取 100 ⇒ 行权价与档位一眼可验。 */
  const SPOT = '100.0000';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-064-overlay-off-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-064-overlay-off-hmac-secret-min-32';
    // 读取口的绑定由 override 决定, 不受本机 env 影响 (且本文件一次外呼都不该发)。
    delete process.env.MARKETDATA_PROVIDER;

    readPort = new SpySnapshotReadPort();
    marketState = new FakeMarketStatePort();
    moduleRef = await Test.createTestingModule({ imports: [AppModule, OptionsdeskModule] })
      .overrideProvider(OPTION_SNAPSHOT_READ_PORT)
      .useValue(readPort)
      .overrideProvider(MARKET_STATE_PORT)
      .useValue(marketState)
      // 🚫 **交易日历 MUST NOT override**: `GetLegsUseCase` 也在用它 (`lastClosedSession`),
      // 换掉会连带改动基线夹具的输出。非交易日那一臂改由**把 `now` 挪到周六**来制造。
      .compile();
    prisma = moduleRef.get(PrismaService);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(typeof message === 'string' ? message : JSON.stringify(message));
    });
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await moduleRef?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    warnings.length = 0;
    readPort.calls.length = 0;
    readPort.respond = () => ({ asOf: REALTIME_AS_OF, rows: [] });
    readPort.fail = null;
    readPort.hang = false;
    marketState.session = 'regular';
    marketState.fail = null;
    marketState.extra = [];
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
  });

  // ── 造数 ──────────────────────────────────────────────────────────────────

  interface SeedLeg {
    readonly code: string;
    readonly dte: number;
    readonly strike: string;
    readonly bid: string;
    readonly ask: string;
    readonly oi: string;
    readonly vol: string;
    readonly iv: string;
    /**
     * 库内那批快照的 greeks 完整性标; 省略 = `true` (基线四条腿的形态, 省略即维持原样)。
     *
     * 🚨 只有 `greeksComplete` 标做成可覆盖, `delta` / `iv` 两列**仍写死** —— 本字段存在的
     * 唯一理由是造「库内的标与实时批的标不一致」那两条反例, 让标与它描述的两格分头取值。
     */
    readonly greeksComplete?: boolean;
  }

  /**
   * 四条腿, 各占一条判别路径 —— 关态基线要覆盖到「进候选」与「被两道门槛各挡一次」两侧,
   * 否则 `gateCounts` 恒 0, 基线里那几个数就是平凡的。
   */
  const LEGS: readonly SeedLeg[] = [
    // 三视角全进 (价外 10%, DTE 落两段重叠区)。
    {
      code: 'L-OK',
      dte: 35,
      strike: '90',
      bid: '2.00',
      ask: '2.10',
      oi: '900',
      vol: '40',
      iv: '20',
    },
    // 只建仓 —— DTE 10 够不到收租段。
    {
      code: 'L-BUILD',
      dte: 10,
      strike: '95',
      bid: '1.50',
      ask: '1.60',
      oi: '300',
      vol: '20',
      iv: '22',
    },
    // 权利金门槛挡下 (removedByPremiumFloor ≥ 1)。
    {
      code: 'L-PENNY',
      dte: 35,
      strike: '80',
      bid: '0.05',
      ask: '0.10',
      oi: '900',
      vol: '40',
      iv: '18',
    },
    // 流动性门槛挡下 (相对价差 3 / 4.5 = 0.667)。
    {
      code: 'L-WIDE',
      dte: 35,
      strike: '85',
      bid: '3.00',
      ask: '6.00',
      oi: '900',
      vol: '40',
      iv: '30',
    },
  ];

  /**
   * 064 T004b —— **定窗基准**的两列 (`anchor.intraday_price` / `intraday_at`, 本 ctx 自有表)。
   * 默认 = 与库内 spot 同值且新鲜, 于是既有用例的窗恒罩住四条种子腿。
   */
  interface SeedBasis {
    readonly price: string | null;
    readonly at: Date | null;
  }

  const FRESH_BASIS: SeedBasis = { price: SPOT, at: new Date(NOW.getTime() - 10_000) };

  /**
   * @param opts.snapshots `false` ⇒ 只落合约集不落快照行 (`state_branch` 9 的输入:
   *   新锚在首次收盘采集跑过之前, 库里有合约没有快照)。
   * @param opts.basis 定窗基准 (T004b) —— 缺省 {@link FRESH_BASIS}。
   * @param opts.extraLegs 额外腿 (T004b 的口径切换样本)。🚨 **MUST NOT 加进 {@link LEGS}** ——
   *   那份种子是基线夹具的输入面, 动它等于让 `SC-005` 那条逐字符断言恒红。
   * @param opts.v 锚的估值 V (067) —— 缺省 `'150'` = 既有基线的 spot < W 域 (W=120 > spot=100,
   *   axis 退化为 spot, 全部既有用例逐字符不变); 067 换轴双域组喂低 V 走 spot > W 域。
   */
  async function seedChain(
    opts: {
      snapshots?: boolean;
      basis?: SeedBasis;
      extraLegs?: readonly SeedLeg[];
      v?: string;
    } = {},
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
    for (const leg of [...LEGS, ...(opts.extraLegs ?? [])]) {
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
          expirationCycle: 'WEEK',
          // 076: 美股标准合约的实测股数 (spec「取证」§2 PoC-A) ⇒ 本文件的 golden 基线逐值不变。
          contractSize: 100,
        },
        select: { id: true },
      });
      if (opts.snapshots === false) continue;
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: dateOf(TODAY),
          source: 'eod',
          quoteAsOf: new Date(`${TODAY}T20:31:07Z`),
          // 🚨 OI 归属 T−1 —— 与 sessionDate 蓄意不同天 (`FR-004` 的判别性前提)。
          oiAsOf: dateOf(PREV_SESSION),
          bid: leg.bid,
          ask: leg.ask,
          bidSize: '25',
          askSize: '26',
          delta: '-0.30',
          iv: leg.iv,
          openInterest: leg.oi,
          netOpenInterest: '111',
          volume: leg.vol,
          underlyingSpot: SPOT,
          greeksComplete: leg.greeksComplete ?? true,
        },
      });
    }
    const basis = opts.basis ?? FRESH_BASIS;
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        market: SYMBOL.split(':')[0]!,
        v: opts.v ?? '150',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        // 🚨 两个读端点**都不读**这两列 (061 只喂雷达) ⇒ 基线夹具不受影响; 它们只喂 T004b 的窗。
        intradayPrice: basis.price,
        intradayAt: basis.at,
      },
    });
  }

  /** 两个读端点的全部输出 —— 选约表三视角各一份 + 链分析报表一份。 */
  async function readBothEndpoints(): Promise<Record<string, unknown>> {
    const legs = moduleRef.get(GetLegsUseCase);
    const report = moduleRef.get(GetChainReportUseCase);
    const out: Record<string, unknown> = {};
    for (const tab of LEG_TABS) out[`legs:${tab}`] = await legs.execute(SYMBOL, tab, NOW);
    out['chain-report'] = await report.execute(SYMBOL, NOW);
    return out;
  }

  // ── 断言 ──────────────────────────────────────────────────────────────────

  it('🚨 `state_branch` 2 / `FR-016`: 两个读端点跑完, 对读取口的调用次数 = 0', async () => {
    await seedChain();
    await readBothEndpoints();
    expect(readPort.calls).toHaveLength(0);
  });

  it('🚨 `FR-009`: 关态下**逐行**与链级的档位均为 `eod_close` (页级一刀切在这里也是绿的, 故还有下一条)', async () => {
    await seedChain();
    const port = moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT);

    const chain = await port.retrieveChain({ symbol: SYMBOL, now: NOW, realtime: false });
    if (chain === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(chain.legs.length).toBe(LEGS.length);
    expect(chain.chain.priceKind).toBe('eod_close');
    expect(chain.legs.map((leg) => leg.priceKind)).toEqual(chain.legs.map(() => 'eod_close'));

    // 候选集走的是同一个根 (`loadChain`) ⇒ 两个 port 方法的档位必须同源 (`FR-017` 的前置)。
    const candidates = await port.retrieveCandidates({
      symbol: SYMBOL,
      now: NOW,
      perspectives: LEG_TABS,
      candidateCap: RECALL_CANDIDATE_CAP,
      override: null,
      realtime: false,
    });
    if (candidates === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(candidates.chain.priceKind).toBe('eod_close');
    expect(candidates.candidates.map(({ leg }) => leg.priceKind)).toEqual(
      candidates.candidates.map(() => 'eod_close'),
    );

    expect(readPort.calls).toHaveLength(0);
  });

  it('🚨 `SC-005`: 两个读端点的响应与基线夹具**逐字符**相同', async () => {
    await seedChain();
    const actual = stable(await readBothEndpoints());

    if (WRITE_BASELINE) {
      writeFileSync(BASELINE_PATH, `${actual}\n`, 'utf8');
      return;
    }
    expect(
      existsSync(BASELINE_PATH),
      `缺基线夹具 ${BASELINE_PATH} —— 见文件头「golden file」段`,
    ).toBe(true);
    expect(actual).toBe(readFileSync(BASELINE_PATH, 'utf8').trimEnd());
  });

  // ── T004a 开态: 尾部覆盖七列 + OI 结构性不覆盖 ─────────────────────────────

  /**
   * 实时批的逐行取值 —— **七列每一列都与库内不同**, 且 OI 两列蓄意喂成与库内不同的数。
   *
   * 🚨 后者是 `FR-004` / `SC-006` 的**反例装置**: 若 overlay 把 OI 也覆盖了, 下面那条断言就红。
   * 喂同一个数的话该断言恒绿 —— 那就等于没写。
   */
  const REALTIME_BY_CODE: Readonly<Record<string, Omit<OptionSnapshotRow, 'code' | 'isOption'>>> = {
    'L-OK': realtimeRow({
      bid: '2.55',
      ask: '2.62',
      bidSize: '77',
      askSize: '88',
      delta: '-0.41',
      iv: '31.5',
      volume: '512',
      openInterest: '4321',
      netOpenInterest: '999',
    }),
    'L-BUILD': realtimeRow({
      bid: '1.81',
      ask: '1.90',
      bidSize: '11',
      askSize: '12',
      delta: '-0.22',
      iv: '26.5',
      volume: '133',
      openInterest: '4322',
      netOpenInterest: '998',
    }),
    'L-PENNY': realtimeRow({
      bid: '0.09',
      ask: '0.14',
      bidSize: '3',
      askSize: '4',
      delta: '-0.02',
      iv: '19.5',
      volume: '7',
      openInterest: '4323',
      netOpenInterest: '997',
    }),
    'L-WIDE': realtimeRow({
      bid: '3.33',
      ask: '6.66',
      bidSize: '5',
      askSize: '6',
      delta: '-0.55',
      iv: '33.5',
      volume: '9',
      openInterest: '4324',
      netOpenInterest: '996',
    }),
    // T004b 口径切换样本 —— 与收盘值**只差权利金这一维** (相对价差两档都远在门槛内),
    // 于是「成员变了」只可能由权利金门槛解释 (`SC-008`: 无法解释的进出 = 0 例)。
    'L-WAKE': realtimeRow({
      bid: '0.45',
      ask: '0.48',
      bidSize: '20',
      askSize: '21',
      delta: '-0.08',
      iv: '24.5',
      volume: '60',
    }),
    'L-FADE': realtimeRow({
      bid: '0.05',
      ask: '0.09',
      bidSize: '20',
      askSize: '21',
      delta: '-0.04',
      iv: '23.5',
      volume: '60',
    }),
    // ── `greeksComplete` 跟不跟着 Δ/IV 翻的两条反例 ─────────────────────────
    /** 昨收 IV 无解 (库内标 `false`)、此刻实时把两格都给全了 ⇒ 标必须翻成 `true`。 */
    'L-GREEKS-WAKE': realtimeRow({
      bid: '2.55',
      ask: '2.62',
      bidSize: '77',
      askSize: '88',
      delta: '-0.37',
      iv: '28.5',
      volume: '512',
      greeksComplete: true,
    }),
    /** 昨收齐全 (库内标 `true`)、此刻实时的两格皆空 ⇒ 标必须翻成 `false`。 */
    'L-GREEKS-FADE': realtimeRow({
      bid: '2.55',
      ask: '2.62',
      bidSize: '77',
      askSize: '88',
      // Δ/IV 蓄意留 `null` (`realtimeRow` 的默认值) —— 买卖价仍在 ⇒ 整行**不会**走
      // `state_branch` 11 的「按未取到处理」那条路, 于是这一行确实被覆盖过。
      volume: '512',
      greeksComplete: false,
    }),
  };

  function realtimeRow(
    over: Partial<Omit<OptionSnapshotRow, 'code' | 'isOption'>>,
  ): Omit<OptionSnapshotRow, 'code' | 'isOption'> {
    return {
      underlyingCode: 'US.PEP',
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      last: '9.99',
      prevClose: '8.88',
      iv: null,
      delta: null,
      // 🚨 本片**不覆盖**其余希腊值 (`FR-002`: 覆盖没有读者的值只是无收益的成本) —— 给它们
      // 喂一个显眼的值, 若哪天被写进 `LegChainRow` 会当场看得出来。
      gamma: '0.111',
      vega: '0.222',
      theta: '-0.333',
      rho: '0.444',
      openInterest: null,
      netOpenInterest: null,
      volume: null,
      turnover: '123456.78',
      vendorUpdateTime: new Date('2026-08-04T13:00:00.000Z'),
      greeksComplete: true,
      ...over,
    };
  }

  /**
   * 标的自身那行 (`isOption: false`) 的 vendor code —— adapter 内部把 `us:PEP` 翻成它并入同一批
   * (`OptionSnapshotPort` 文件头), 本替身只按 `isOption` 认它, 不按 code 认。
   */
  const UNDERLYING_CODE = 'US.PEP';

  /**
   * 🚨 **判据与呈现所用的现价** (`FR-006a`) —— 与库内 eod spot (`100`) 与定窗基准**三者互不相同**,
   * 这是 T004b 那条「表头取的是哪一个」断言的判别性前提: 三者取同值的话该断言恒绿 = 等于没写。
   */
  const REALTIME_SPOT = '104.25';

  /** 标的自身那行 —— 期权列一律 `null` (它不是期权), spot 落在 `last` 上 (同 047 采集侧口径)。 */
  function underlyingRow(last: string | null): OptionSnapshotRow {
    return {
      code: UNDERLYING_CODE,
      isOption: false,
      underlyingCode: null,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      last,
      prevClose: '99.10',
      iv: null,
      delta: null,
      gamma: null,
      vega: null,
      theta: null,
      rho: null,
      openInterest: null,
      netOpenInterest: null,
      volume: null,
      turnover: null,
      vendorUpdateTime: new Date('2026-08-11T17:45:00.000Z'),
      greeksComplete: null,
    };
  }

  /**
   * 按请求里的 code 逐条回放 + **标的自身那行**; `extra` 用于塞库内不存在的合约
   * (`state_branch` 10)。
   */
  function realtimeBatch(
    extra: readonly string[] = [],
  ): (q: OptionSnapshotQuery) => OptionSnapshotBatch {
    return (query) => ({
      asOf: REALTIME_AS_OF,
      rows: [
        underlyingRow(REALTIME_SPOT),
        ...query.contractCodes.flatMap((code): OptionSnapshotRow[] => {
          const seeded = REALTIME_BY_CODE[code];
          return seeded === undefined ? [] : [{ code, isOption: true, ...seeded }];
        }),
        ...extra.map(
          (code): OptionSnapshotRow => ({
            code,
            isOption: true,
            ...realtimeRow({ bid: '7.77', ask: '7.88' }),
          }),
        ),
      ],
    });
  }

  const chainOf = (realtime: boolean) =>
    moduleRef
      .get<LegRetrievalPort>(LEG_RETRIEVAL_PORT)
      .retrieveChain({ symbol: SYMBOL, now: NOW, realtime });

  it('🚨 `state_branch` 9 改写后仍成立的那一半: 库内零快照行 + **关态** ⇒ 未就绪且零外呼', async () => {
    await seedChain({ snapshots: false });
    readPort.respond = realtimeBatch();

    // 关态下没有第二个数据源 ⇒ 结局与本条分支改写前**逐字节相同**。
    expect(await chainOf(false)).toBeNull();
    expect(readPort.calls).toHaveLength(0);
  });

  // ── 实时独载基线 (库内零快照行 + 开态) ───────────────────────────────────────

  // ── T004b 开态: 两个标的现价 + 召回口径 ────────────────────────────────────

  // ── T005 降级六路径 ───────────────────────────────────────────────────────

  /**
   * 🚨 **`SC-004` 的机器化**: 数出「被置为 `0` / 空串」的项数。逐字段肉眼核对必漏 ——
   * 一张四行十一列的表, 人只会看自己想看的那两列。
   *
   * 📌 种子里**没有任何一个 0**, 于是「出现 0」= 有人拿 0 顶替了缺失 (`null` 不算: 它是
   * 「没有这个数」的正确表达)。
   */
  function zeroOrBlankCount(snapshot: LegChainSnapshot): number {
    const values: unknown[] = [
      snapshot.chain.spot,
      ...snapshot.legs.flatMap((leg) => [
        leg.bid,
        leg.ask,
        leg.bidSize,
        leg.askSize,
        leg.delta,
        leg.iv,
        leg.volume,
        leg.openInterest,
        leg.strike,
      ]),
    ];
    return values.filter((v) => v === '' || v === 0 || (v instanceof Prisma.Decimal && v.isZero()))
      .length;
  }

  it('🚨 `state_branch` 3a: 美股非常规交易状态 ⇒ **零外呼** + 整表收盘档', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    marketState.session = 'other';

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(readPort.calls).toHaveLength(0);
    expect(snapshot.chain.priceKind).toBe('eod_close');
    expect(snapshot.legs.map((leg) => leg.priceKind)).toEqual(snapshot.legs.map(() => 'eod_close'));
    expect(zeroOrBlankCount(snapshot)).toBe(0);
  });

  it('🚨 `state_branch` 3b: 当日非交易日 (周六) ⇒ **零外呼** + 整表收盘档 (两闸取交集)', async () => {
    // 时段闸照常放行、定窗基准**也照常新鲜** (相对周六那个 `now`) —— 关掉的只有日历那一闸,
    // 于是「取交集」这件事被单独验到。🚨 基准若沿用工作日那一拍, 这条会因「基准陈旧」而绿,
    // 测的就不是日历闸了。
    const saturday = new Date('2026-08-15T20:00:00.000Z');
    await seedChain({ basis: { price: SPOT, at: new Date(saturday.getTime() - 10_000) } });
    readPort.respond = realtimeBatch();

    const snapshot = await moduleRef
      .get<LegRetrievalPort>(LEG_RETRIEVAL_PORT)
      .retrieveChain({ symbol: SYMBOL, now: saturday, realtime: true });
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(readPort.calls).toHaveLength(0);
    expect(snapshot.chain.priceKind).toBe('eod_close');
    expect(zeroOrBlankCount(snapshot)).toBe(0);
  });

  // ── T005 收尾: 把 `realtime` 真正打开 (plan D6) ────────────────────────────

  it('🚨 plan D6: authed 读端显式传 `true` ⇒ 外呼发生; 不传 (默认 / 非 authed 读路径) ⇒ 恒 0', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    const legs = moduleRef.get(GetLegsUseCase);

    // 默认态 = fail-closed: 省略开关的调用方**结构上**不外呼 (`FR-015` / `FR-016`)。
    await legs.execute(SYMBOL, 'rent', NOW);
    expect(readPort.calls).toHaveLength(0);

    // authed controller 传的就是这一路; 068 起窄召回只服务意图视角 (Q1 裁决) ⇒ 用 rent 证通底。
    const view = await legs.execute(SYMBOL, 'rent', NOW, null, undefined, true);
    expect(readPort.calls).toHaveLength(1);
    // 实时那一批确实一路走到了视图上 (区块时刻 = 信封 `asOf`, 不是库内 `quote_as_of`)。
    expect(view.quoteAsOf).toEqual(REALTIME_AS_OF);

    // 068 Q4: 链报表实时开态回落收盘档 ⇒ 传 true 也**零外呼** (P3 按净链重建实时报表)。
    const report = moduleRef.get(GetChainReportUseCase);
    await report.execute(SYMBOL, NOW, true);
    expect(readPort.calls).toHaveLength(1);
  });

  // ── T006 超上限 fail-closed + 三类特有失败留痕 ─────────────────────────────

  // ── T007a 链级降级信号出契约 ────────────────────────────────────────────────

  /**
   * 链级降级标 —— **`priceKind` 之外的第二个数**, 答的是「此刻**本该**是什么档」。
   *
   * 🚨 用它取值而不是各处手写 `snapshot.chain.realtimeDegrade`, 是为了让下面每条断言都同时
   * 钉住**档位**与**降级标**两项: 只断言其一的话, 「把两者互相推导出来」的实现照样全绿
   * (推导实现在每一条单项断言上都给得出正确答案, 只有把两个数并排看才露馅)。
   */
  function tierOf(snapshot: LegChainSnapshot): {
    priceKind: string;
    degrade: RealtimeChainDegradeKind | null;
  } {
    return { priceKind: snapshot.chain.priceKind, degrade: snapshot.chain.realtimeDegrade };
  }

  it('🚨 T007a ① 核心反例 a: 美股非常规交易状态 ⇒ 收盘档且降级标**恒 null** (正常休市不是降级)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    marketState.session = 'other';

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    // 🚨 这一条把「落了 eod 就算降级」的朴素实现钉死: 国内用户白天每次打开都走这条路, 给它
    // 刷降级 = 造一个**永远为真的告警**, 于是真出事那天它也不再有人看。
    expect(tierOf(snapshot)).toEqual({ priceKind: 'eod_close', degrade: null });
    expect(readPort.calls).toHaveLength(0);
  });

  it('🚨 T007a ① 核心反例 b: 当日非交易日 (周六) ⇒ 收盘档且降级标**恒 null**', async () => {
    // 与 `state_branch` 3b 同一套输入: 时段闸放行、基准照常新鲜, 关掉的只有日历那一闸。
    const saturday = new Date('2026-08-15T20:00:00.000Z');
    await seedChain({ basis: { price: SPOT, at: new Date(saturday.getTime() - 10_000) } });
    readPort.respond = realtimeBatch();

    const snapshot = await moduleRef
      .get<LegRetrievalPort>(LEG_RETRIEVAL_PORT)
      .retrieveChain({ symbol: SYMBOL, now: saturday, realtime: true });
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(tierOf(snapshot)).toEqual({ priceKind: 'eod_close', degrade: null });
    expect(readPort.calls).toHaveLength(0);
  });

  it('🚨 T007a ⑥: 关态 ⇒ 降级标恒 null 且外呼计数仍 = 0', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const snapshot = await chainOf(false);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(tierOf(snapshot)).toEqual({ priceKind: 'eod_close', degrade: null });
    expect(readPort.calls).toHaveLength(0);

    // 两个读端点的视图层同样恒 null (`realtime` 默认关) —— 基线夹具那条断言剔除的正是这个键。
    const views = await readBothEndpoints();
    for (const [name, view] of Object.entries(views)) {
      expect((view as { realtimeDegrade: unknown }).realtimeDegrade, name).toBeNull();
    }
    expect(readPort.calls).toHaveLength(0);
  });

  // ── P0a hk guard: 实时窗未支持的市场整体回落, 不再 throw → read_failed ──────
  //
  // 现状缺陷: `legWindowFor` 对未支持市场 MUST throw (FR-008, 判据本身正确), 但读路径上这个
  // throw 会一路冒到 `get-legs.usecase.ts` 的宽 catch 判成 `read_failed` —— 港股锚在港股盘中
  // (闸判开 + 盘中基准新鲜) 整表呈现「读故障」, 而不是降级到收盘档。
  describe('067 换轴双域: axis = min(spot, W) (FR-002 / FR-005 / FR-006 / FR-008)', () => {
    /**
     * 既有各组用例的锚恒为 V=150 (W=120 > spot=100 ⇒ axis 退化为 spot, state_branch 1) ——
     * 那份 golden 基线逐字符不变就是 US3 零回归的机器证据。本组把 V 压下来, 走的才是换轴
     * 真正的新分支 (state_branches 3/4/8): W 由 adapter 内的 anchor 点查经
     * `resolveEffectiveAnchorValues` + `computeW` 单点派生 (FR-002), 判据仍是
     * `resolveQualityCeiling` 一处 (FR-006)。
     */
    const retrieve = (override: RetrievalOverride | null = null, realtime = false) =>
      moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT).retrieveCandidates({
        symbol: SYMBOL,
        now: NOW,
        perspectives: LEG_TABS,
        candidateCap: RECALL_CANDIDATE_CAP,
        override,
        realtime,
      });

    const tabCodes = (
      result: Awaited<ReturnType<typeof retrieve>>,
      tab: (typeof LEG_TABS)[number],
    ): string[] => {
      if (result === null) throw new Error('种子链应当命中 —— 断言前置失效');
      return result.candidates.filter((c) => c.tabs.includes(tab)).map((c) => c.leg.code);
    };

    /** 收租新轴内的对照腿 (K=75 < W=80) —— 让「收紧后仍有候选」非平凡。 */
    const RENT_IN: SeedLeg = {
      code: 'L-067-IN',
      dte: 35,
      strike: '75',
      bid: '2.00',
      ask: '2.10',
      oi: '900',
      vol: '40',
      iv: '21',
    };

    /** 落在 (W×1.03, spot×1.03] = (82.4, 103] 的判别腿 —— 旧轴放进默认候选, 新轴挡下。 */
    const AXIS_EDGE: SeedLeg = {
      code: 'L-067-EDGE',
      dte: 35,
      strike: '83',
      bid: '2.00',
      ask: '2.10',
      oi: '900',
      vol: '40',
      iv: '22',
    };

    it('🚨 US1-AS1 / state_branch 3: 低 V 锚 (W < spot) ⇒ rent 默认上界按 W 锚定, (W×1.03, spot×1.03] 的腿被挡下', async () => {
      await seedChain({ v: '100', extraLegs: [RENT_IN, AXIS_EDGE] });
      const result = await retrieve();
      if (result === null) throw new Error('种子链应当命中 —— 断言前置失效');

      // FR-008: 下发的 rent 默认值反映新轴 —— 结构项 min{K ≥ 80} = 80 与比例项 80 × 1.03 =
      // 82.4 取严 ⇒ 80; 🚫 不再是 spot 轴的 103。断言侧的 80 是 0.8 × V=100 的展开值,
      // 实装 MUST 走 computeW 单点 (FR-002), 这里只对结果。
      const w = new Prisma.Decimal('80');
      expect(result.criteriaByTab.rent.defaults.strikeMax?.toString()).toBe('80');
      expect(result.criteriaByTab.rent.defaults.strikeMax?.lessThanOrEqualTo(w.times('1.03'))).toBe(
        true,
      );

      // 判别腿 (83 ∈ (82.4, 103]) 不在收租候选; 新轴内的对照腿在 ⇒ 收紧不是清空。
      expect(tabCodes(result, 'rent')).toEqual([RENT_IN.code]);
      // 只收租收紧 (FR-003 / US3): 同一条判别腿在全腿与建仓照常。
      expect(tabCodes(result, 'all')).toContain(AXIS_EDGE.code);
      expect(tabCodes(result, 'build')).toContain(AXIS_EDGE.code);

      // FR-005「保留既有边际计数语义」(052 FR-029): 系统默认值下的排除**不出计数** —— 默认值
      // 本身摆在控件里, 排除归因于 strikeMax 这一维而非新错误态; 也不污染两个既有门槛计数
      // (权利金仍只数 L-PENNY; L-WIDE 对 rent 已是价差+上界双维不过 ⇒ 按既有 sole-failure
      // 语义不计入 rent 的流动性排除数, 只计 build 那一维)。
      expect(result.criteriaByTab.rent.outcomes.strikeMax).toEqual({
        state: 'default',
        excludedCount: 0,
      });
      expect(result.removedByPremiumFloor).toBe(1);
      expect(result.excludedFromIntentTabsByTab).toEqual({ build: 1, rent: 0 });
    });

    it('🚨 US2-AS1 / state_branch 4 / FR-005: spot > 1.143V ⇒ rent 默认候选为空, 呈现为既有「有链无候选」形态非错误', async () => {
      // V=80 ⇒ W=64: W×1.03 = 65.92 低于链上全部行权价 ⇒ 结构项 min{K ≥ 64} = 80 更松,
      // 比例项接管且挡下全部 (state_branch 9 的轴替换版在真栈上的形态)。
      await seedChain({ v: '80' });
      const result = await retrieve();
      if (result === null) throw new Error('种子链应当命中 —— 断言前置失效');

      expect(result.criteriaByTab.rent.defaults.strikeMax?.toString()).toBe('65.92');
      expect(tabCodes(result, 'rent')).toEqual([]);
      // 空的是收租一个视角, 不是链 —— 其余视角照常有货。
      expect(tabCodes(result, 'all').length).toBeGreaterThan(0);

      // FR-005: 读端呈现沿用既有「条件下无候选」—— state 仍 available, 🚫 MUST NOT 是错误态。
      const view = await moduleRef.get(GetLegsUseCase).execute(SYMBOL, 'rent', NOW);
      expect(view.state).toBe('available');
      expect(view.legs).toEqual([]);
    });

    it('🚨 US2-AS2 / state_branch 7: 覆盖 strikeMax 放宽到 spot 附近 ⇒ 候选按覆盖出现, 放宽能力不受换轴影响', async () => {
      await seedChain({ v: '100', extraLegs: [RENT_IN, AXIS_EDGE] });
      const widened = await retrieve({
        perspective: 'rent',
        criteria: { strikeMax: new Prisma.Decimal('103') },
      });
      if (widened === null) throw new Error('种子链应当命中 —— 断言前置失效');

      // 覆盖值原样生效 (不经 axis 处理), 新默认下被挡的判别腿按覆盖出现。
      expect(widened.criteriaByTab.rent.effective.strikeMax?.toString()).toBe('103');
      expect(tabCodes(widened, 'rent')).toEqual(
        expect.arrayContaining([RENT_IN.code, AXIS_EDGE.code, 'L-OK']),
      );
      expect(widened.criteriaByTab.rent.outcomes.strikeMax).toEqual({
        state: 'widened',
        excludedCount: 0,
      });

      // 053 FR-009: memberCount 的二次判定与覆盖臂共用同一 context (同一个 W) ——
      // 无覆盖口径的成员数与默认检索逐值相同。
      const plain = await retrieve();
      if (plain === null) throw new Error('种子链应当命中 —— 断言前置失效');
      expect(widened.memberCount).toBe(plain.candidates.length);
    });

    it('🚨 Edge 2 防退化: 改 v_manual 后重新检索, rent 默认上界随新 W 变化 (无缓存滞留)', async () => {
      await seedChain({ v: '100' });
      const before = await retrieve();
      if (before === null) throw new Error('种子链应当命中 —— 断言前置失效');
      expect(before.criteriaByTab.rent.defaults.strikeMax?.toString()).toBe('80');

      // 生效 V 走 v_manual 优先 (resolveEffectiveAnchorValues 单点, FR-002) ⇒ W = 72,
      // 上界 = 72 × 1.03 = 74.16 (结构项 min{K ≥ 72} = 80 更松)。将来有人给 W 加缓存或把
      // 派生挪出单点, 本臂当场红。
      await prisma.anchor.updateMany({ where: { ticker: SYMBOL }, data: { vManual: '90' } });
      const after = await retrieve();
      if (after === null) throw new Error('种子链应当命中 —— 断言前置失效');
      expect(after.criteriaByTab.rent.defaults.strikeMax?.toString()).toBe('74.16');
    });
  });

  describe('P0a: hk 锚开态下不抛, 整体回落收盘档', () => {
    const HK_SYMBOL = 'hk:00700';

    async function seedHkChain(): Promise<void> {
      const instrument = await prisma.instrument.create({
        data: {
          market: 'hk',
          code: '00700',
          name: '腾讯控股',
          type: 'stock',
          currency: 'HKD',
          status: 'active',
          needSync: true,
        },
        select: { id: true },
      });
      const contract = await prisma.optionContract.create({
        data: {
          market: 'hk',
          code: 'HK.TCH260918P100000',
          root: 'TCH',
          underlyingInstrumentId: instrument.id,
          expiryDate: new Date(dateOf(TODAY).getTime() + 38 * 86_400_000),
          strikePrice: '95',
          optionType: 'PUT',
          isStandard: true,
          expirationCycle: 'MONTH',
        },
        select: { id: true },
      });
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: dateOf(TODAY),
          source: 'eod',
          quoteAsOf: new Date(`${TODAY}T08:31:07Z`),
          oiAsOf: dateOf(TODAY),
          bid: '2.10',
          ask: '2.30',
          bidSize: '10',
          askSize: '12',
          delta: '-0.30',
          iv: '25.5',
          openInterest: '500',
          netOpenInterest: '400',
          volume: '80',
          underlyingSpot: SPOT,
          greeksComplete: true,
        },
      });
      await prisma.anchor.create({
        data: {
          ticker: HK_SYMBOL,
          market: 'hk',
          v: '150',
          asof: dateOf('2026-06-30'),
          method: 'dcf',
          confidence: '8',
          confidenceSource: 'manual',
          lLevelEffective: 'L2',
          // 盘中基准**新鲜** —— 066 T10 起 hk 已接实时源, 这正是触发缺陷的现实前置。
          intradayPrice: SPOT,
          intradayAt: FRESH_BASIS.at,
        },
      });
    }

    it('🚨 hk 收盘时段 ⇒ 正常收盘档 (降级标恒 null) —— guard 必须在闸**之后**, 别把常态染成告警', async () => {
      await seedHkChain();
      marketState.extra = [{ market: 'hk', session: 'other' }];
      const port = moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT);

      const result = await port.retrieveCandidates({
        symbol: HK_SYMBOL,
        now: NOW,
        perspectives: LEG_TABS,
        candidateCap: RECALL_CANDIDATE_CAP,
        override: null,
        realtime: true,
      });
      if (result === null) throw new Error('种子链应当命中 —— 断言前置失效');
      expect(result.chain.realtimeDegrade).toBeNull();
      expect(result.chain.priceKind).toBe('eod_close');
      expect(readPort.calls).toHaveLength(0);
    });
  });
});
