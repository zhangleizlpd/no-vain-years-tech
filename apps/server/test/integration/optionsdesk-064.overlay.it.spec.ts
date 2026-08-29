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
  REALTIME_CHAIN_DEGRADE_KINDS,
  type LegRetrievalPort,
  type RealtimeChainDegradeKind,
  type RealtimeDegradeKind,
} from '../../src/optionsdesk/leg-retrieval.port';
import {
  OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
  OPTION_SNAPSHOT_READ_PORT,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
  type OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';
import { REALTIME_DEGRADE_LOG_TAG } from '../../src/optionsdesk/leg-retrieval.adapter';
import { INTRADAY_FRESHNESS_SECONDS } from '../../src/optionsdesk/intraday-spot.rules';
import {
  MARKET_STATE_PORT,
  type MarketSession,
  type MarketSessionState,
  type MarketStatePort,
} from '../../src/marketdata/market-state.port';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../../src/marketdata/trading-calendar.port';
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

/** vendor 侧金额串的规范形 —— 尾零归一, 用于与 `Decimal.toString()` 对比。 */
function decimalText(value: string | null): string | undefined {
  return value === null ? undefined : new Prisma.Decimal(value).toString();
}

/**
 * `bigint` 是 `JSON.stringify` 的硬错; 其余 (Date / Decimal) 各自的 `toJSON` 已经稳定。
 *
 * 🚨 **`priceKind` (064 T007) 与 `realtimeDegrade` (064 T007a) 逐个剔除**: `FR-009` / `FR-010`
 * 蓄意给两个读端点的出参**新增**了这两个键, 它们是本 feature 的产出而不是回归。⇒ 基线夹具
 * **保持冻结**在 064 之前那一份, 断言退成「除了这两个蓄意新增的键, 其余逐字符相同」。
 * 🚫 **MUST NOT 改成重新生成一份基线** —— 重生成会把「既有字段的值有没有被改动」这个问题一起
 * 抹掉 (新旧两份都是本次跑出来的, 逐字符自然相同), 而 `SC-005` 要的正是那个问题的答案。
 * 📌 档位字段本身的取值由本文件 T003 / T004a / T005 的用例逐条钉住, 不靠这条基线。
 */
function stable(value: unknown): string {
  return JSON.stringify(
    value,
    (key, v: unknown) => {
      if (key === 'priceKind' || key === 'realtimeDegrade') return undefined;
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
   * **真正的盘中时刻** (ET 12:00) —— 实时独载基线那组专用。
   *
   * 🚨 与 {@link NOW} (ET 16:00) 的差别是判别性的, 不是风格: 16:00 已到常规收盘分钟数 ⇒
   * `sessionWatermark` 当场翻到**当天**, 于是「最近一个已收盘交易日」= 今天 = `sessionDate`,
   * 那条「两个时点不同天」的断言就恒绿。挪到 12:00 之后水位仍停在昨天, `oiAsOf` 与
   * `sessionDate` 才真的分得开 —— 而这正是实时独载基线最容易写错的那一格。
   * 📌 仍落在同一个 ET 日历日内 ⇒ `exchangeCalendarDate` 与逐腿 DTE 与 {@link NOW} 一致。
   */
  const INTRADAY_NOW = new Date('2026-08-11T16:00:00.000Z');
  const INTRADAY_BASIS: SeedBasis = { price: SPOT, at: new Date(INTRADAY_NOW.getTime() - 10_000) };

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

  it('🚨 `FR-001` / `FR-002` / `state_branch` 1: 七列取到实时值, 逐行 `priceKind=realtime`, 区块时刻取信封 `asOf`', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');

    // 一次请求 = 一次外呼, 且 `contractCodes` 取自**已组装的 legs** (库内链行的 code)。
    expect(readPort.calls).toHaveLength(1);
    expect(readPort.calls[0].underlyingSymbol).toBe(SYMBOL);
    expect([...readPort.calls[0].contractCodes].sort()).toEqual(LEGS.map((l) => l.code).sort());

    expect(snapshot.chain.priceKind).toBe('realtime');
    // 🚨 区块时刻是**我方采集时刻** (`FR-010`), 🚫 不是库内 `quote_as_of`, 也不是行内
    // `vendorUpdateTime` (那是最后成交时刻)。
    expect(snapshot.chain.quoteAsOf).toEqual(REALTIME_AS_OF);

    for (const leg of snapshot.legs) {
      const expected = REALTIME_BY_CODE[leg.code];
      expect(leg.priceKind).toBe('realtime');
      // 经 `Decimal` 归一后再比 —— 直接比字符串会被尾零绊住 ('1.90' vs '1.9'), 那不是口径差异。
      expect(leg.bid?.toString()).toBe(decimalText(expected.bid));
      expect(leg.ask?.toString()).toBe(decimalText(expected.ask));
      expect(leg.bidSize).toBe(Number(expected.bidSize));
      expect(leg.askSize).toBe(Number(expected.askSize));
      expect(leg.delta).toBe(Number(expected.delta));
      expect(leg.iv).toBe(Number(expected.iv));
      expect(leg.volume).toBe(Number(expected.volume));
    }
  });

  it('🚨 `FR-004` / `SC-006` 反例: OI 三列在两档下**逐字节相同** —— 实时批喂的是不同的数', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const closed = await chainOf(false);
    const live = await chainOf(true);
    if (closed === null || live === null) throw new Error('种子链应当命中 —— 断言前置失效');

    // 反例装置自检: 实时批给的 OI **确实**与库内不同, 否则下面那条断言恒绿 = 等于没写。
    for (const leg of LEGS) {
      expect(REALTIME_BY_CODE[leg.code].openInterest).not.toBe(leg.oi);
    }

    const oiOf = (snap: NonNullable<Awaited<ReturnType<typeof chainOf>>>) =>
      snap.legs.map((leg) => `${leg.code}:${String(leg.openInterest)}`).sort();
    expect(oiOf(live)).toEqual(oiOf(closed));
    expect(live.chain.oiAsOf).toEqual(closed.chain.oiAsOf);
    // 🚨 归属日 MUST NOT 被标成当天 (`SC-006`) —— 种子里 OI 归属 T−1。
    expect(live.chain.oiAsOf).toEqual(dateOf(PREV_SESSION));

    // 🚨 **Guardrail 6 的结构判据**: `netOpenInterest` 根本不在腿的写入面上 —— 它不是「覆盖时
    // 跳过了」, 而是压根没有这个字段可覆盖。把它加进返回类型再在 overlay 里跳过, 等于把一条
    // 编译期保证降级成一条注释。
    for (const leg of live.legs) expect(Object.keys(leg)).not.toContain('netOpenInterest');
  });

  /**
   * `greeksComplete` 的两条反例样本 —— 报价六维照抄 `L-OK` (三视角全进), **只在库内那个标上
   * 分头取值**, 于是「标翻没翻」不会被成员变化掩盖。行权价错开一档只为不与 `L-OK` 同格。
   */
  const GREEKS_WAKE: SeedLeg = {
    code: 'L-GREEKS-WAKE',
    dte: 35,
    strike: '91',
    bid: '2.00',
    ask: '2.10',
    oi: '900',
    vol: '40',
    iv: '20',
    // 昨收深实值腿 bid 跌破内在价值 ⇒ IV 无解, 是数学固有现象不是采集故障
    // (`option-snapshot.port.ts`: 实测 2150 行里 227 行是这个形态)。
    greeksComplete: false,
  };

  const GREEKS_FADE: SeedLeg = {
    ...GREEKS_WAKE,
    code: 'L-GREEKS-FADE',
    strike: '92',
    greeksComplete: true,
  };

  it('🚨 `FR-002` 反例 (假阴): 昨收 greeks 缺失、此刻实时给全了 ⇒ 标跟着两格一起翻, Δ 不被掐掉', async () => {
    await seedChain({ extraLegs: [GREEKS_WAKE] });
    readPort.respond = realtimeBatch();

    const closed = await chainOf(false);
    const live = await chainOf(true);
    if (closed === null || live === null) throw new Error('种子链应当命中 —— 断言前置失效');

    // 反例装置自检: 库内那个标**确实**是 false, 否则下面两条恒绿 = 等于没写。
    expect(closed.legs.find((leg) => leg.code === GREEKS_WAKE.code)?.greeksComplete).toBe(false);

    const leg = live.legs.find((row) => row.code === GREEKS_WAKE.code);
    expect(leg?.delta).toBe(-0.37);
    expect(leg?.greeksComplete).toBe(true);

    // 🚨 用户可见的那一半: 标不跟着翻的话, `get-legs.usecase.ts` 的
    // `deriveDeltaColumns(greeksComplete ? delta : null)` 会把已经在手里的 Δ 掐成 `null`
    // ⇒ Δ 与 σ 距空着、不判档不着色 (FR-007 的「数据不全」形态被误触发)。
    const table = await moduleRef
      .get(GetLegsUseCase)
      .execute(SYMBOL, 'all', NOW, null, undefined, true);
    const row = table.legs.find((view) => view.code === GREEKS_WAKE.code);
    expect(row?.greeksComplete).toBe(true);
    expect(row?.absDelta).toBeCloseTo(0.37, 10);
  });

  it('🚨 `FR-002` 反例 (假阳): 昨收 greeks 齐全、此刻实时两格皆空 ⇒ 标翻成 `false`, 不下发「齐全」的假话', async () => {
    await seedChain({ extraLegs: [GREEKS_FADE] });
    readPort.respond = realtimeBatch();

    const closed = await chainOf(false);
    const live = await chainOf(true);
    if (closed === null || live === null) throw new Error('种子链应当命中 —— 断言前置失效');

    expect(closed.legs.find((leg) => leg.code === GREEKS_FADE.code)?.greeksComplete).toBe(true);

    const leg = live.legs.find((row) => row.code === GREEKS_FADE.code);
    // 前置: 这一行**确实被覆盖过** (买卖价来自实时) ⇒ 排除 `state_branch` 11 那条
    // 「买卖价皆空 ⇒ 整行按未取到处理」的路径, 否则本条测的就不是标而是那条分支。
    expect(leg?.priceKind).toBe('realtime');
    expect(leg?.bid?.toString()).toBe(decimalText('2.55'));
    expect(leg?.delta).toBeNull();
    expect(leg?.greeksComplete).toBe(false);
  });

  it('🚨 `state_branch` 9 改写后仍成立的那一半: 库内零快照行 + **关态** ⇒ 未就绪且零外呼', async () => {
    await seedChain({ snapshots: false });
    readPort.respond = realtimeBatch();

    // 关态下没有第二个数据源 ⇒ 结局与本条分支改写前**逐字节相同**。
    expect(await chainOf(false)).toBeNull();
    expect(readPort.calls).toHaveLength(0);
  });

  // ── 实时独载基线 (库内零快照行 + 开态) ───────────────────────────────────────

  const chainAt = (now: Date, realtime: boolean) =>
    moduleRef
      .get<LegRetrievalPort>(LEG_RETRIEVAL_PORT)
      .retrieveChain({ symbol: SYMBOL, now, realtime });

  /**
   * 库内零快照 + 盘中基准新鲜 —— 实时独载基线的完整前置。
   *
   * 📌 **日历不必种**: 本文件删掉了 `MARKETDATA_PROVIDER` ⇒ `TRADING_CALENDAR_PORT` 绑的是
   * mock 那一份 (`marketdata.module.ts` 的 `cfg.kind === 'mock' ? mock : Db...`), 它**不查库**
   * —— `classify` 与 `lastClosedSession` 都按「周一~周五」现算, 恒不返 `null`。往 `trading_day`
   * 里种行对本文件零作用, 种了反而会让人以为日历是从库里来的。
   * ⇒ ET 12:00 的水位停在 {@link PREV_SESSION}（工作日），于是「最近已收盘交易日」与「交易所的
   * 今天」天然是两天 —— 那条「两个时点不同天」的断言因此是判别性的。
   */
  async function seedRealtimeBaseline(extraLegs: readonly SeedLeg[] = []): Promise<void> {
    await seedChain({ snapshots: false, basis: INTRADAY_BASIS, extraLegs });
    readPort.respond = realtimeBatch();
  }

  it('🚨 盘中新锚 (库内零快照行 + 开态): 这一批实时**自己当基线**成链, 整表 `realtime`', async () => {
    await seedRealtimeBaseline();

    const snapshot = await chainAt(INTRADAY_NOW, true);
    if (snapshot === null) throw new Error('实时独载基线应当成链 —— 断言前置失效');

    expect(readPort.calls).toHaveLength(1);
    expect(snapshot.legs).toHaveLength(LEGS.length);
    expect(snapshot.chain.priceKind).toBe('realtime');
    expect(snapshot.legs.map((leg) => leg.priceKind)).toEqual(snapshot.legs.map(() => 'realtime'));
    // 🚨 占位值 MUST 被整体改写掉 —— 荒谬值一眼可辨: spot=0 / 时刻 1970。
    expect(snapshot.chain.quoteAsOf).toEqual(REALTIME_AS_OF);
    expect(snapshot.chain.spot.toString()).toBe(decimalText(REALTIME_SPOT));

    // 🚨 **两个时点不是同一天**: 报价归属正在进行的这一场, OI 归属最近一个已收盘交易日。
    expect(snapshot.chain.sessionDate).toEqual(dateOf(TODAY));
    expect(snapshot.chain.oiAsOf).toEqual(dateOf(PREV_SESSION));
    // 「这批数从哪来」如实标出 —— 呈现侧靠 `source !== 'eod'` 渲「来源 realtime」。
    expect(snapshot.chain.source).toBe('realtime');
  });

  it('🚨 `FR-004` 的另一半: 实时基线下 OI **来自同一批实时** (库内基线那条断言方向相反, 两条并存)', async () => {
    await seedRealtimeBaseline();

    const snapshot = await chainAt(INTRADAY_NOW, true);
    if (snapshot === null) throw new Error('实时独载基线应当成链 —— 断言前置失效');

    // 装置自检: 库内**根本没有** OI 可留 —— 这正是本基线与 `db_snapshot` 的分野。
    for (const leg of snapshot.legs) {
      expect(leg.openInterest).toBe(Number(REALTIME_BY_CODE[leg.code].openInterest));
    }
    // 🚨 反向钉死: 库内基线下同一批实时 OI **一个都不能进来** (既有 `SC-006` 那条覆盖此点),
    // 于是「OI 归谁写」由 baseline 单值决定, 而不是由「这一格空不空」决定。
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
    await seedChain({ basis: INTRADAY_BASIS });
    const withDb = await chainAt(INTRADAY_NOW, true);
    if (withDb === null) throw new Error('库内基线应当命中 —— 断言前置失效');
    for (const leg of withDb.legs) {
      const seeded = LEGS.find((l) => l.code === leg.code);
      expect(leg.openInterest).toBe(Number(seeded?.oi));
    }
  });

  it('🚨 没拿到实时值的腿**整条丢弃**, 🚫 不让它去撑大「被权利金门槛移出」那个数', async () => {
    // `L-NOQUOTE` 不在 `REALTIME_BY_CODE` 里 ⇒ 替身不会为它回一行 (= 停牌 / 刚摘牌的形态)。
    const NO_QUOTE: SeedLeg = {
      code: 'L-NOQUOTE',
      dte: 35,
      strike: '93',
      bid: '2.00',
      ask: '2.10',
      oi: '900',
      vol: '40',
      iv: '20',
    };
    await seedRealtimeBaseline([NO_QUOTE]);

    const snapshot = await chainAt(INTRADAY_NOW, true);
    if (snapshot === null) throw new Error('实时独载基线应当成链 —— 断言前置失效');
    expect(snapshot.legs.map((leg) => leg.code)).not.toContain(NO_QUOTE.code);

    // 🚨 用户可见的那一半: 留着它的话, 这条从未被问过价的腿会被权利金门槛(bid 为空)挡下,
    // 屏上于是多出「被权利金门槛移出」的一条 —— 一个真实、可读、且完全错的数。
    const table = await moduleRef
      .get(GetLegsUseCase)
      .execute(SYMBOL, 'all', INTRADAY_NOW, null, undefined, true);
    expect(table.legs.map((leg) => leg.code)).not.toContain(NO_QUOTE.code);
    expect(table.gateCounts.removedByPremiumFloor).toBe(
      // 只剩 `L-PENNY` 那条**真的**被门槛挡下的 (实时 bid 0.09 < 门槛)。
      1,
    );
  });

  it('🚨 日历答不出「最近已收盘交易日」⇒ 放弃 (不猜归属日) 且**零外呼**', async () => {
    await seedRealtimeBaseline();
    // 🚨 只 stub 这一个方法、只在这一条用例内 —— 🚫 MUST NOT 改 `.overrideProvider()`:
    // 文件头写明日历不可 override (`GetLegsUseCase` 也在用它, 换掉会改动基线夹具的输出)。
    // 打在**端口实例**上而不是 mock 类上: 那个实例就是 adapter 手里的那一个。
    const calendar = moduleRef.get<TradingCalendarPort>(TRADING_CALENDAR_PORT);
    const stub = vi.spyOn(calendar, 'lastClosedSession').mockResolvedValue(null);
    try {
      expect(await chainAt(INTRADAY_NOW, true)).toBeNull();
      // 归属日都定不下来就不该去问价 —— 外呼在这里发出去是白烧配额。
      expect(readPort.calls).toHaveLength(0);
    } finally {
      stub.mockRestore();
    }
  });

  it('🚨 四条整体回落路径在实时基线下**一律未就绪**, 占位值一个都逃不出去', async () => {
    /**
     * 每条路径配一个**期望外呼次数** —— 🚨 少了它这条用例就不判别: 若 `seedRealtimeBaseline`
     * 哪天坏了 (比如骨架压根组不出来), 四条会**在同一个更靠前的地方**一起返 `null`, 而断言
     * 全绿。次数把「走到了哪一格」钉住: 前三条零外呼, 源不可达那条必须已经问过一次。
     */
    const arrange: Readonly<Record<string, { calls: number; prepare: () => Promise<void> }>> = {
      // ① 两闸: 非常规交易状态 ⇒ 正常收盘档, 但本基线没有收盘档可落。
      'gate closed': {
        calls: 0,
        prepare: async () => {
          marketState.session = 'other';
        },
      },
      // ② 两闸自身故障 ⇒ fail-closed。
      'gate unknown': {
        calls: 0,
        prepare: async () => {
          marketState.fail = new Error('futu shim 5xx');
        },
      },
      // ③ 定窗基准陈旧 (超出 061 的新鲜度闸)。
      'window basis stale': {
        calls: 0,
        prepare: async () => {
          await prisma.anchor.update({
            where: { ticker: SYMBOL },
            data: { intradayAt: new Date(INTRADAY_NOW.getTime() - 3 * 3600_000) },
          });
        },
      },
      // ④ 源不可达 —— **闸已判开、窗也定出来了**, 故这一条必然已经外呼过一次。
      'source unavailable': {
        calls: 1,
        prepare: async () => {
          readPort.fail = new Error('shim unreachable (ECONNREFUSED)');
        },
      },
    };

    for (const [name, { calls, prepare }] of Object.entries(arrange)) {
      await prisma.optionContract.deleteMany();
      await prisma.instrument.deleteMany();
      await prisma.anchorChange.deleteMany();
      await prisma.anchor.deleteMany();
      marketState.session = 'regular';
      marketState.fail = null;
      readPort.fail = null;
      readPort.calls.length = 0;
      await seedRealtimeBaseline();
      await prepare();

      expect(await chainAt(INTRADAY_NOW, true), `回落路径「${name}」应判未就绪`).toBeNull();
      expect(readPort.calls, `回落路径「${name}」的外呼次数`).toHaveLength(calls);
    }
  });

  it('🚨 `state_branch` 10: 返回集里库内不存在的合约被忽略 (盘中新挂, 当日不呈现)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch(['US.PEP260918P130000-GHOST']);

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(snapshot.legs).toHaveLength(LEGS.length);
    expect(snapshot.legs.map((leg) => leg.code)).not.toContain('US.PEP260918P130000-GHOST');
  });

  // ── T004b 开态: 两个标的现价 + 召回口径 ────────────────────────────────────

  /**
   * 口径切换样本 —— 收盘权利金**低于**门槛 (`0.10 < 0.20`)、此刻**高于** (`0.45`)。
   * 两档的相对价差都远在流动性门槛之内 ⇒ 成员变化只可能由权利金那一维解释 (`SC-008`)。
   */
  const WAKE: SeedLeg = {
    code: 'L-WAKE',
    dte: 35,
    strike: '88',
    bid: '0.10',
    ask: '0.13',
    oi: '900',
    vol: '40',
    iv: '24',
  };

  /** 反向样本 —— 收盘 `0.30` 过门槛、此刻 `0.05` 过不了。 */
  const FADE: SeedLeg = {
    code: 'L-FADE',
    dte: 35,
    strike: '86',
    bid: '0.30',
    ask: '0.34',
    oi: '900',
    vol: '40',
    iv: '23',
  };

  const candidatesOf = (realtime: boolean) =>
    moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT).retrieveCandidates({
      symbol: SYMBOL,
      now: NOW,
      perspectives: LEG_TABS,
      candidateCap: RECALL_CANDIDATE_CAP,
      override: null,
      realtime,
    });

  function codesOf(result: Awaited<ReturnType<typeof candidatesOf>>): string[] {
    if (result === null) throw new Error('种子链应当命中 —— 断言前置失效');
    return result.candidates.map(({ leg }) => leg.code);
  }

  it('🚨 US2-AS1 / `SC-008`: 收盘权利金低于门槛、此刻高于门槛的腿 —— 实时档下**进**候选集', async () => {
    await seedChain({ extraLegs: [WAKE] });
    readPort.respond = realtimeBatch();

    // 关态臂先立: 它证明这条腿在收盘口径下确实进不来 —— 否则下面那条断言恒绿。
    expect(codesOf(await candidatesOf(false))).not.toContain(WAKE.code);
    expect(codesOf(await candidatesOf(true))).toContain(WAKE.code);
  });

  it('🚨 US2-AS2 / `SC-008`: 收盘能过判据、此刻过不了的腿 —— 实时档下**不在**候选集', async () => {
    await seedChain({ extraLegs: [FADE] });
    readPort.respond = realtimeBatch();

    expect(codesOf(await candidatesOf(false))).toContain(FADE.code);
    expect(codesOf(await candidatesOf(true))).not.toContain(FADE.code);
  });

  it('🚨 US2-AS4: 跳空日 —— 窗的行权价区间跟着**盘中基准**动, 不跟库内收盘价', async () => {
    // 盘中基准比库内收盘价 (100) 低 20% ⇒ 窗 [56, 84]: 四条种子腿里只有行权价 80 那条落在窗内。
    await seedChain({ basis: { price: '80', at: FRESH_BASIS.at } });
    readPort.respond = realtimeBatch();

    await chainOf(true);
    expect(readPort.calls).toHaveLength(1);
    expect([...readPort.calls[0].contractCodes].sort()).toEqual(['L-PENNY']);

    // 🚨 反例臂: 同一批腿在基准 100 下窗是 [70, 105], 四条全进。窗若照着收盘价定, 两条断言必红一条。
    readPort.calls.length = 0;
    await prisma.anchor.updateMany({ where: { ticker: SYMBOL }, data: { intradayPrice: SPOT } });
    await chainOf(true);
    expect([...readPort.calls[0].contractCodes].sort()).toEqual(LEGS.map((l) => l.code).sort());
  });

  it('🚨 US2-AS3 / `FR-017`: 候选集与整条链拿到**同一个**报价时刻', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const candidates = await candidatesOf(true);
    const chain = await chainOf(true);
    if (candidates === null || chain === null) throw new Error('种子链应当命中 —— 断言前置失效');

    expect(candidates.chain.quoteAsOf).toEqual(chain.chain.quoteAsOf);
    expect(candidates.chain.quoteAsOf).toEqual(REALTIME_AS_OF);
    expect(candidates.chain.priceKind).toBe('realtime');
    expect(candidates.chain.spot.toString()).toBe(chain.chain.spot.toString());
  });

  it('🚨 `SC-003`: 一次候选集检索 ⇒ 对读取口的调用次数 = 1 (标的自身随同一批回来)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    await candidatesOf(true);
    expect(readPort.calls).toHaveLength(1);
    // 入参只给 canonical 标的 + 合约码: 「把标的并进同一批」由 adapter 内部承担, 不是调用方自律。
    expect(readPort.calls[0].underlyingSymbol).toBe(SYMBOL);
  });

  it('🚨 `FR-006a` 反例: 表头 spot 取返回集里 `isOption:false` 那行 —— 既不是定窗基准也不是库内收盘价', async () => {
    // 三个数互不相同 (基准 96 / 库内 100 / 同刻 104.25) ⇒ 断言分得出取的到底是哪一个。
    await seedChain({ basis: { price: '96', at: FRESH_BASIS.at } });
    readPort.respond = realtimeBatch();

    const live = await chainOf(true);
    if (live === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(live.chain.spot.toString()).toBe(new Prisma.Decimal(REALTIME_SPOT).toString());
    expect(live.chain.spot.toString()).not.toBe(new Prisma.Decimal('96').toString());
    expect(live.chain.spot.toString()).not.toBe(new Prisma.Decimal(SPOT).toString());

    // 关态下它仍是库内那一份 —— 实时值一个字节都不该渗到收盘档上。
    const closed = await chainOf(false);
    if (closed === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(closed.chain.spot.toString()).toBe(new Prisma.Decimal(SPOT).toString());
  });

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

  /** 收盘档那一份的逐行七列指纹 —— 降级后必须与它**逐字节相同** (`FR-011`: 禁清空既有值)。 */
  function quoteFingerprint(snapshot: LegChainSnapshot): string[] {
    return snapshot.legs.map((leg) =>
      [
        leg.code,
        leg.priceKind,
        String(leg.bid?.toString()),
        String(leg.ask?.toString()),
        String(leg.bidSize),
        String(leg.askSize),
        String(leg.delta),
        String(leg.iv),
        String(leg.volume),
      ].join('|'),
    );
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

  it('🚨 `state_branch` 4a: 源不可达 (读取口抛) ⇒ 整体回落收盘档, 值一个不动', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    const closed = await chainOf(false);
    readPort.fail = new Error('shim unreachable (ECONNREFUSED)');

    const snapshot = await chainOf(true);
    if (snapshot === null || closed === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(readPort.calls).toHaveLength(1);
    expect(snapshot.chain.priceKind).toBe('eod_close');
    expect(quoteFingerprint(snapshot)).toEqual(quoteFingerprint(closed));
    expect(zeroOrBlankCount(snapshot)).toBe(0);
  });

  it('🚨 `state_branch` 4b: 源超时 (永不 settle) ⇒ 请求级超时切断并回落收盘档', async () => {
    await seedChain();
    const closed = await chainOf(false);
    readPort.hang = true;

    const snapshot = await chainOf(true);
    if (snapshot === null || closed === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(readPort.calls).toHaveLength(1);
    expect(snapshot.chain.priceKind).toBe('eod_close');
    expect(quoteFingerprint(snapshot)).toEqual(quoteFingerprint(closed));
    expect(zeroOrBlankCount(snapshot)).toBe(0);
  }, 30_000);

  it('🚨 `state_branch` 5: 部分合约未在返回集 ⇒ **逐行**保留收盘值; 两种档位必须**都出现**', async () => {
    await seedChain();
    const missing = 'L-BUILD';
    readPort.respond = (query) => {
      const full = realtimeBatch()(query);
      return { asOf: full.asOf, rows: full.rows.filter((row) => row.code !== missing) };
    };
    const closed = await chainOf(false);

    const snapshot = await chainOf(true);
    if (snapshot === null || closed === null) throw new Error('种子链应当命中 —— 断言前置失效');
    // 🚨 分布断言: 全 `eod_close` = 页级一刀切, 全 `realtime` = 缺失被吞 —— 两种错都渲染得出
    // 一张完整的表, 只有「两种都在」才说明逐行成立。
    expect(new Set(snapshot.legs.map((leg) => leg.priceKind))).toEqual(
      new Set(['realtime', 'eod_close']),
    );
    const missed = snapshot.legs.find((leg) => leg.code === missing);
    const closedMissed = closed.legs.find((leg) => leg.code === missing);
    if (missed === undefined || closedMissed === undefined) throw new Error('断言前置失效');
    expect(missed.priceKind).toBe('eod_close');
    expect(missed.bid?.toString()).toBe(closedMissed.bid?.toString());
    expect(missed.ask?.toString()).toBe(closedMissed.ask?.toString());
    // 链级仍是实时档 (本批确实取到了) —— 区块条与行级角标读的是两个数。
    expect(snapshot.chain.priceKind).toBe('realtime');
    expect(zeroOrBlankCount(snapshot)).toBe(0);
  });

  it('🚨 `state_branch` 11: 单腿买价 / 卖价皆空 ⇒ **整行**按未取到处理, 🚫 不拼半实时半昨收', async () => {
    await seedChain();
    const blanked = 'L-WIDE';
    readPort.respond = (query) => {
      const full = realtimeBatch()(query);
      return {
        asOf: full.asOf,
        rows: full.rows.map((row) => (row.code === blanked ? { ...row, bid: null, ask: '' } : row)),
      };
    };
    const closed = await chainOf(false);

    const snapshot = await chainOf(true);
    if (snapshot === null || closed === null) throw new Error('种子链应当命中 —— 断言前置失效');
    const row = snapshot.legs.find((leg) => leg.code === blanked);
    const closedRow = closed.legs.find((leg) => leg.code === blanked);
    if (row === undefined || closedRow === undefined) throw new Error('断言前置失效');
    expect(row.priceKind).toBe('eod_close');
    // 🚨 整行 —— 不是只把 bid/ask 留下: 其余五列也 MUST 是收盘那一份 (半实时的行没有任何一个
    // 时刻能解释它)。
    expect(quoteFingerprint({ chain: snapshot.chain, legs: [row] })).toEqual(
      quoteFingerprint({ chain: closed.chain, legs: [closedRow] }),
    );
    expect(zeroOrBlankCount(snapshot)).toBe(0);
  });

  it('🚨 `state_branch` 14: 定窗基准陈旧 (超出 061 的新鲜度闸) ⇒ 零外呼 + 整体回落', async () => {
    // 91 秒前的一拍 —— 闸是 3 × 30 s 且**闭区间**, 故这一拍必判陈旧。
    await seedChain({ basis: { price: SPOT, at: new Date(NOW.getTime() - 91_000) } });
    readPort.respond = realtimeBatch();

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(readPort.calls).toHaveLength(0);
    expect(snapshot.chain.priceKind).toBe('eod_close');
    expect(zeroOrBlankCount(snapshot)).toBe(0);
  });

  it('🚨 `state_branch` 14 反例: 基准整列缺失 (当日首拍之前) ⇒ 同样零外呼 + 回落', async () => {
    await seedChain({ basis: { price: null, at: null } });
    readPort.respond = realtimeBatch();

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(readPort.calls).toHaveLength(0);
    expect(snapshot.chain.priceKind).toBe('eod_close');
  });

  it('🚨 `state_branch` 6 / `FR-012`: 返回集里标的行缺 spot ⇒ 显式「未就绪」, 🚫 不拿收盘价顶替', async () => {
    await seedChain();
    // 标的行在, 但它的价是空 —— 「链坏了」MUST NOT 看起来像正常。
    readPort.respond = (query) => {
      const full = realtimeBatch()(query);
      return {
        asOf: full.asOf,
        rows: full.rows.map((row) => (row.isOption ? row : { ...row, last: null })),
      };
    };

    expect(await chainOf(true)).toBeNull();
    // 关态不受影响 —— 未就绪只属于这一次实时取数。
    expect(await chainOf(false)).not.toBeNull();
  });

  it('🚨 `FR-011` fail-closed: 市场状态取不到 (源故障) ⇒ 不猜「开着市」, 零外呼', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    marketState.fail = new Error('futu shim 5xx');

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(readPort.calls).toHaveLength(0);
    expect(snapshot.chain.priceKind).toBe('eod_close');
  });

  it('🚨 `SC-004` 扫描断言: 四类降级路径**逐条**跑一遍, 被置 0 / 空串的项数合计 = 0', async () => {
    await seedChain();
    const closed = await chainOf(false);
    if (closed === null) throw new Error('种子链应当命中 —— 断言前置失效');

    const degradations: { readonly name: string; readonly arm: () => void }[] = [
      {
        name: '非常规交易状态',
        arm: () => {
          marketState.session = 'other';
        },
      },
      {
        name: '源不可达',
        arm: () => {
          readPort.fail = new Error('boom');
        },
      },
      {
        name: '部分合约未返回',
        arm: () => {
          readPort.respond = (query) => {
            const full = realtimeBatch()(query);
            return { asOf: full.asOf, rows: full.rows.filter((row) => row.code !== 'L-OK') };
          };
        },
      },
      {
        name: '单腿关键报价为空',
        arm: () => {
          readPort.respond = (query) => {
            const full = realtimeBatch()(query);
            return {
              asOf: full.asOf,
              rows: full.rows.map((row) => (row.isOption ? { ...row, bid: null, ask: null } : row)),
            };
          };
        },
      },
    ];

    let zeros = 0;
    for (const { name, arm } of degradations) {
      marketState.session = 'regular';
      marketState.fail = null;
      readPort.fail = null;
      readPort.respond = realtimeBatch();
      arm();
      const snapshot = await chainOf(true);
      if (snapshot === null) throw new Error(`降级路径「${name}」不该把链判成未就绪`);
      zeros += zeroOrBlankCount(snapshot);
      // 每一条路径都 MUST 留下可辨的档位 (`SC-004` 的另一半: 用户判得出这不是实时的)。
      expect(snapshot.legs.some((leg) => leg.priceKind === 'eod_close')).toBe(true);
    }
    expect(zeros).toBe(0);
  });

  // ── T005 收尾: 把 `realtime` 真正打开 (plan D6) ────────────────────────────

  it('🚨 plan D6: authed 读端显式传 `true` ⇒ 外呼发生; 不传 (默认 / 非 authed 读路径) ⇒ 恒 0', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    const legs = moduleRef.get(GetLegsUseCase);

    // 默认态 = fail-closed: 省略开关的调用方**结构上**不外呼 (`FR-015` / `FR-016`)。
    await legs.execute(SYMBOL, 'all', NOW);
    expect(readPort.calls).toHaveLength(0);

    // authed controller 传的就是这一路 (`optionsdesk.controller.ts` 的 `legs` / `chainReport`)。
    const view = await legs.execute(SYMBOL, 'all', NOW, null, undefined, true);
    expect(readPort.calls).toHaveLength(1);
    // 实时那一批确实一路走到了视图上 (区块时刻 = 信封 `asOf`, 不是库内 `quote_as_of`)。
    // 📌 档位字段本身的出参归 T007 的 DTO 层, 这里只证「开关真的通到底了」。
    expect(view.quoteAsOf).toEqual(REALTIME_AS_OF);

    const report = moduleRef.get(GetChainReportUseCase);
    await report.execute(SYMBOL, NOW, true);
    expect(readPort.calls).toHaveLength(2);
  });

  // ── T006 超上限 fail-closed + 三类特有失败留痕 ─────────────────────────────

  /** 一条本片特有失败的结构化留痕 (`FR-023`) —— 类别字段在 `kind` 上, 可直接聚合。 */
  interface DegradeLog {
    readonly kind: RealtimeDegradeKind;
    readonly symbol: string;
    readonly [field: string]: unknown;
  }

  /**
   * 从**全量** warn 里捞出本片的结构化留痕并解开 payload。
   *
   * 🚨 断言的是**类别字段的值**, 不是「日志非空」(`SC-010`): 「有 warn」在任何一条降级路径上
   * 都成立 —— 拿它当判据等于把三类失败与其余降级混成一堆, 而聚合出来的图照样画得出来。
   */
  function degradeLogs(): DegradeLog[] {
    return warnings
      .filter((line) => line.startsWith(REALTIME_DEGRADE_LOG_TAG))
      .map((line) => JSON.parse(line.slice(REALTIME_DEGRADE_LOG_TAG.length)) as DegradeLog);
  }

  /**
   * 🚨 **真造**出一批窗内腿把单批上限撑破 (`FR-018` / `state_branch` 7)。
   *
   * 🚫 蓄意**不把 `OPTION_SNAPSHOT_MAX_CONTRACT_CODES` stub 成小值**: 那样绿只证明「我塞进去的
   * 小数被读到了」, 而真正要守的是「窗真的圈出四百条时会不会去外呼」—— 上限是从
   * `option-snapshot.port.ts` import 的同一个常量, 拿它当条数造种子, 反例 (截断实现) 才落在
   * 管道能看见的地方。造数走 `createMany` (两条 INSERT), 不是四百次往返。
   *
   * 行权价全部落在窗 `[0.7 × 100, 1.05 × 100]` 之内、DTE 35 落在窗的 DTE 段内 ⇒ 连同
   * {@link LEGS} 四条一起, 窗内条数 = 上限 + 4 > 上限。
   */
  async function seedOverCapLegs(): Promise<void> {
    const instrument = await prisma.instrument.findFirstOrThrow({
      where: { market: 'us', code: 'PEP' },
      select: { id: true },
    });
    const expiry = new Date(dateOf(TODAY).getTime() + 35 * 86_400_000);
    const bulk = Array.from({ length: OPTION_SNAPSHOT_MAX_CONTRACT_CODES }, (_unused, i) => ({
      code: `L-BULK-${String(i).padStart(3, '0')}`,
      // 70.10 → 101.94, 步长 0.08: 四百个互不相同的行权价, 全部在窗内。
      strike: (70.1 + i * 0.08).toFixed(2),
    }));
    await prisma.optionContract.createMany({
      data: bulk.map((leg) => ({
        market: 'us',
        code: leg.code,
        root: 'PEP',
        underlyingInstrumentId: instrument.id,
        expiryDate: expiry,
        strikePrice: leg.strike,
        optionType: 'PUT',
        isStandard: true,
        expirationCycle: 'WEEK',
      })),
    });
    const created = await prisma.optionContract.findMany({
      where: { underlyingInstrumentId: instrument.id, code: { startsWith: 'L-BULK-' } },
      select: { id: true },
    });
    await prisma.optionDailySnapshot.createMany({
      data: created.map((contract) => ({
        contractId: contract.id,
        sessionDate: dateOf(TODAY),
        source: 'eod',
        quoteAsOf: new Date(`${TODAY}T20:31:07Z`),
        oiAsOf: dateOf(PREV_SESSION),
        // 收盘档下**过得了**两道门槛 ⇒ 它们是候选; 实时档若真取到 (见 `pennyBatch`) 就全掉出去。
        bid: '2.00',
        ask: '2.10',
        bidSize: '25',
        askSize: '26',
        delta: '-0.30',
        iv: '20',
        openInterest: '900',
        netOpenInterest: '111',
        volume: '40',
        underlyingSpot: SPOT,
        greeksComplete: true,
      })),
    });
  }

  /**
   * 🚨 截断实现的**反例装置**: 对**每一个**被问到的 code 都回一个过不了权利金门槛的报价。
   *
   * 于是「悄悄截断到前 N 条」这种实现会真的发一次外呼、真的把那 N 条腿的权利金改成一分钱,
   * 候选集条数当场塌下来 —— 若只喂与库内同值的报价, 「fail-closed 还是截断」两种实现的输出
   * 完全一样, 那条条数断言就恒绿 = 等于没写。
   */
  const pennyBatch = (query: OptionSnapshotQuery): OptionSnapshotBatch => ({
    asOf: REALTIME_AS_OF,
    rows: [
      underlyingRow(REALTIME_SPOT),
      ...query.contractCodes.map(
        (code): OptionSnapshotRow => ({
          code,
          isOption: true,
          ...realtimeRow({ bid: '0.01', ask: '0.02' }),
        }),
      ),
    ],
  });

  it('🚨 `FR-018` / `state_branch` 7: 窗内条数超单批上限 ⇒ 整表收盘档 + 零外呼, 候选集条数与关态**相同**', async () => {
    await seedChain();
    await seedOverCapLegs();
    readPort.respond = pennyBatch;

    const closed = await candidatesOf(false);
    const live = await candidatesOf(true);
    if (closed === null || live === null) throw new Error('种子链应当命中 —— 断言前置失效');

    // ① 零外呼 —— 截断实现在这里就会红 (它得先问过才知道该截多少)。
    expect(readPort.calls).toHaveLength(0);
    // ② 整表回落收盘档 (本仓的「降级标记」就是档位本身, 没有第二个 flag)。
    expect(live.chain.priceKind).toBe('eod_close');
    const chain = await chainOf(true);
    if (chain === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(chain.legs.map((leg) => leg.priceKind)).toEqual(chain.legs.map(() => 'eod_close'));
    // ③ 🚨 候选集条数与关态**相同** —— 这条才咬得住 fail-closed 与截断的差别: 截掉一截的话,
    //    被截掉的那批拿的是 `pennyBatch` 的报价, 权利金门槛会把它们全踢出候选。
    expect(live.candidates.length).toBe(closed.candidates.length);
    expect(live.candidates.length).toBeGreaterThan(OPTION_SNAPSHOT_MAX_CONTRACT_CODES);
  }, 60_000);

  it('🚨 `FR-023` `window_over_cap`: 留痕带窗内条数与上限, 且上限取自 marketdata 那个常量', async () => {
    await seedChain();
    await seedOverCapLegs();
    readPort.respond = pennyBatch;

    await chainOf(true);
    const logs = degradeLogs();
    expect(logs.map((log) => log.kind)).toEqual(['window_over_cap']);
    expect(logs[0].cap).toBe(OPTION_SNAPSHOT_MAX_CONTRACT_CODES);
    // 判别性自检: 窗内条数**确实**超了上限 (否则这条用例测的根本不是超限路径)。
    expect(logs[0].windowCodes).toBeGreaterThan(OPTION_SNAPSHOT_MAX_CONTRACT_CODES);
    expect(logs[0].symbol).toBe(SYMBOL);
  }, 60_000);

  it('🚨 `FR-023` `window_basis_stale`: 留痕带基准时刻与判据阈值', async () => {
    const staleAt = new Date(NOW.getTime() - 91_000);
    await seedChain({ basis: { price: SPOT, at: staleAt } });
    readPort.respond = realtimeBatch();

    await chainOf(true);
    const logs = degradeLogs();
    expect(logs.map((log) => log.kind)).toEqual(['window_basis_stale']);
    expect(logs[0].basisAt).toBe(staleAt.toISOString());
    // 阈值取自 061 的单点 —— 🚫 留痕里 MUST NOT 手写第二个 90。
    expect(logs[0].freshnessSeconds).toBe(INTRADAY_FRESHNESS_SECONDS);
  });

  it('🚨 `FR-023` `partial_miss`: 留痕带缺失条数 (与实际缺的条数一致)', async () => {
    await seedChain();
    const missing = ['L-BUILD', 'L-WIDE'];
    readPort.respond = (query) => {
      const full = realtimeBatch()(query);
      return { asOf: full.asOf, rows: full.rows.filter((row) => !missing.includes(row.code)) };
    };

    await chainOf(true);
    const logs = degradeLogs();
    expect(logs.map((log) => log.kind)).toEqual(['partial_miss']);
    expect(logs[0].missing).toBe(missing.length);
    expect(logs[0].requested).toBe(LEGS.length);
  });

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

  it('🚨 T007a ②: 源不可达 / 超时 ⇒ `source_unavailable` (盘中源挂了 MUST 与正常盘后分得开)', async () => {
    await seedChain();
    readPort.fail = new Error('shim unreachable (ECONNREFUSED)');

    const unreachable = await chainOf(true);
    if (unreachable === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(tierOf(unreachable)).toEqual({ priceKind: 'eod_close', degrade: 'source_unavailable' });

    // 超时那一半走同一个类别 —— 对用户是同一件事 (此刻的盘口没拿到), 区分留在日志里。
    readPort.fail = null;
    readPort.hang = true;
    const timedOut = await chainOf(true);
    if (timedOut === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(tierOf(timedOut)).toEqual({ priceKind: 'eod_close', degrade: 'source_unavailable' });
  }, 30_000);

  it('🚨 T007a ②: 两闸自身故障 ⇒ `gate_unknown` (不知道该不该给实时 ≠ 今天休市)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    marketState.fail = new Error('futu shim 5xx');

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    // 🚨 与上面那条「非常规时段」的输出**逐字段对照**: 档位相同、降级标相反。两者若合成一个
    // 布尔闸 (今天的 `isRealtimeSessionOpen`), 这一条与 ①a 必有一条红。
    expect(tierOf(snapshot)).toEqual({ priceKind: 'eod_close', degrade: 'gate_unknown' });
    expect(readPort.calls).toHaveLength(0);
  });

  it('🚨 T007a ③: 定窗基准陈旧 ⇒ `window_basis_stale`', async () => {
    await seedChain({ basis: { price: SPOT, at: new Date(NOW.getTime() - 91_000) } });
    readPort.respond = realtimeBatch();

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(tierOf(snapshot)).toEqual({ priceKind: 'eod_close', degrade: 'window_basis_stale' });
  });

  it('🚨 T007a ④: 窗内条数超单批上限 ⇒ `window_over_cap`', async () => {
    await seedChain();
    await seedOverCapLegs();
    readPort.respond = pennyBatch;

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(tierOf(snapshot)).toEqual({ priceKind: 'eod_close', degrade: 'window_over_cap' });
  }, 60_000);

  it('🚨 T007a ⑤: 部分合约未返回 ⇒ **链级 null** 且行级两种 `priceKind` 都出现', async () => {
    await seedChain();
    const missing = 'L-BUILD';
    readPort.respond = (query) => {
      const full = realtimeBatch()(query);
      return { asOf: full.asOf, rows: full.rows.filter((row) => row.code !== missing) };
    };

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    // 🚨 部分缺失是**逐行**降级 —— 把整块拉成告警态会让 `state_branch` 5 当场作废, 而那张表
    // 照样渲染得出来。值域上 `partial_miss` 结构性够不着链级字段 (`Exclude<>`), 这里是它的运行时证。
    expect(tierOf(snapshot)).toEqual({ priceKind: 'realtime', degrade: null });
    expect(new Set(snapshot.legs.map((leg) => leg.priceKind))).toEqual(
      new Set(['realtime', 'eod_close']),
    );
    // 留痕面照旧记这一类 (`FR-023`) —— 契约面不报 ≠ 运维面看不见。
    expect(degradeLogs().map((log) => log.kind)).toEqual(['partial_miss']);
  });

  it('🚨 T007a ⑤ 反例: 全部合约都返回 ⇒ 降级标 null 且**没有**行级 `eod_close`', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(tierOf(snapshot)).toEqual({ priceKind: 'realtime', degrade: null });
    expect(new Set(snapshot.legs.map((leg) => leg.priceKind))).toEqual(new Set(['realtime']));
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

  it('🚨 T007a: 降级标一路上浮到**两个读端点的视图**, 且值域可聚合 (客户端据它分叉告警态)', async () => {
    await seedChain();
    readPort.fail = new Error('shim unreachable (ECONNREFUSED)');

    const view = await moduleRef
      .get(GetLegsUseCase)
      .execute(SYMBOL, 'rent', NOW, null, undefined, true);
    const report = await moduleRef.get(GetChainReportUseCase).execute(SYMBOL, NOW, true);
    // 🚨 两个读端点出**同一个**值域与同一份判定 —— 各出各的会让同一事实在两屏上有两种读法。
    expect(view.realtimeDegrade).toBe('source_unavailable');
    expect(report.realtimeDegrade).toBe('source_unavailable');
    expect(view.priceKind).toBe('eod_close');
    // 值域是**契约面**声明的那一份 (swagger `enum:` 取的同一个数组) ⇒ 客户端按类别分叉不会漏。
    expect(REALTIME_CHAIN_DEGRADE_KINDS).toContain(view.realtimeDegrade);
    // 🚨 逐行的 `partial_miss` 结构性不在链级值域里 (`Exclude<>` 的运行时证)。
    const chainLevel: readonly RealtimeDegradeKind[] = REALTIME_CHAIN_DEGRADE_KINDS;
    expect(chainLevel).not.toContain('partial_miss');
  });

  it('🚨 `SC-010` 反例: 降级了但不属于三类 (闸判定失败 / 源不可达) ⇒ **不被**错误归类', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    // ① 两闸自身故障 ⇒ fail-closed 收盘档。它是 `FR-011` 的路径, 不是本片特有的三类之一。
    marketState.fail = new Error('futu shim 5xx');
    const gated = await chainOf(true);
    if (gated === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(gated.chain.priceKind).toBe('eod_close');
    // 判别性前提: 这条路径**确实**留下了 warn —— 否则「没有被归类」只是因为管道里什么都没有。
    expect(warnings.length).toBeGreaterThan(0);
    expect(degradeLogs()).toHaveLength(0);

    // ② 源不可达 ⇒ 整体回落。同样留 warn, 同样不属三类。
    warnings.length = 0;
    marketState.fail = null;
    readPort.fail = new Error('shim unreachable (ECONNREFUSED)');
    const unreachable = await chainOf(true);
    if (unreachable === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(unreachable.chain.priceKind).toBe('eod_close');
    expect(warnings.length).toBeGreaterThan(0);
    expect(degradeLogs()).toHaveLength(0);
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

    it('🚨 US3-AS2 / state_branch 8 / FR-006: 实时开态 axis = min(实时 spot, W) —— 同一判据单点自动同轴', async () => {
      // V=127 ⇒ W=101.6 落在库内 spot (100) 与实时 spot (104.25) **之间** ⇒ 两档的 axis 分叉:
      // 收盘档 axis = 100 (上界 103), 实时档 axis = W = 101.6 (上界 101.6 × 1.03 = 104.648)。
      // 🚨 三个候选值互不相同 (103 / 104.648 / 实时 spot 轴的 107.3775) —— 谁被取用一眼可辨,
      // 这正是「用实时 spot 与库内 spot 拉开」的判别性设计。
      await seedChain({ v: '127' });
      readPort.respond = realtimeBatch();

      const eod = await retrieve(null, false);
      const live = await retrieve(null, true);
      if (eod === null || live === null) throw new Error('种子链应当命中 —— 断言前置失效');

      expect(eod.criteriaByTab.rent.defaults.strikeMax?.toString()).toBe('103');
      expect(live.criteriaByTab.rent.defaults.strikeMax?.toString()).toBe('104.648');
      expect(live.chain.spot.toString()).toBe(new Prisma.Decimal(REALTIME_SPOT).toString());
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

    it('🚨 hk 开态 + 新鲜基准 ⇒ 不抛、整表收盘档、链级标 source_unavailable、零外呼', async () => {
      await seedHkChain();
      marketState.extra = [{ market: 'hk', session: 'regular' }];
      const port = moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT);

      // guard 之前本行 reject ([leg-window] 市场 'hk' 尚未支持) —— 本用例先红后绿 (P0a verify)。
      const result = await port.retrieveCandidates({
        symbol: HK_SYMBOL,
        now: NOW,
        perspectives: LEG_TABS,
        candidateCap: RECALL_CANDIDATE_CAP,
        override: null,
        realtime: true,
      });
      if (result === null) throw new Error('种子链应当命中 —— 断言前置失效');
      // 闸已判开 + 调用方已开实时 + 无窗派生能力 ⇒ 「本该实时却没给成」是**真降级** (T007a),
      // 语义与 mock 档「本环境无实时源」同类 ⇒ 复用 source_unavailable, 不新造第四态 (值域动
      // 契约, 归 P2)。
      expect(result.chain.realtimeDegrade).toBe('source_unavailable');
      expect(result.chain.priceKind).toBe('eod_close');
      expect(readPort.calls).toHaveLength(0);
    });

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
