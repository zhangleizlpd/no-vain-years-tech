import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
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
import { RECALL_CANDIDATE_CAP } from '../../src/optionsdesk/leg-recall.rules';
import {
  LEG_RETRIEVAL_PORT,
  type LegRetrievalPort,
} from '../../src/optionsdesk/leg-retrieval.port';
import {
  OPTION_SNAPSHOT_READ_PORT,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
  type OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';

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

  getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
    this.calls.push(query);
    return Promise.resolve(this.respond(query));
  }
}

/** `nx test server` 的 cwd 恒为 `apps/server` (同本目录其余 IT 的 `SERVER_DIR` 体例)。 */
const BASELINE_PATH = join(process.cwd(), 'test/integration/optionsdesk-064.baseline.json');
const WRITE_BASELINE = process.env.NVY_064_WRITE_BASELINE === '1';

/** vendor 侧金额串的规范形 —— 尾零归一, 用于与 `Decimal.toString()` 对比。 */
function decimalText(value: string | null): string | undefined {
  return value === null ? undefined : new Prisma.Decimal(value).toString();
}

/** `bigint` 是 `JSON.stringify` 的硬错; 其余 (Date / Decimal) 各自的 `toJSON` 已经稳定。 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

describe('064 实时开关关态 · 逐字节等价 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let readPort: SpySnapshotReadPort;

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
    moduleRef = await Test.createTestingModule({ imports: [AppModule, OptionsdeskModule] })
      .overrideProvider(OPTION_SNAPSHOT_READ_PORT)
      .useValue(readPort)
      .compile();
    prisma = moduleRef.get(PrismaService);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    readPort.calls.length = 0;
    readPort.respond = () => ({ asOf: REALTIME_AS_OF, rows: [] });
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
   * @param opts.snapshots `false` ⇒ 只落合约集不落快照行 (`state_branch` 9 的输入:
   *   新锚在首次收盘采集跑过之前, 库里有合约没有快照)。
   */
  async function seedChain(opts: { snapshots?: boolean } = {}): Promise<void> {
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
    for (const leg of LEGS) {
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

  /** 按请求里的 code 逐条回放; `extra` 用于塞库内不存在的合约 (`state_branch` 10)。 */
  function realtimeBatch(
    extra: readonly string[] = [],
  ): (q: OptionSnapshotQuery) => OptionSnapshotBatch {
    return (query) => ({
      asOf: REALTIME_AS_OF,
      rows: [
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

  it('🚨 `state_branch` 9: 库内零快照行 ⇒ 维持「未就绪」, 不靠实时值单独成链 (且零外呼)', async () => {
    await seedChain({ snapshots: false });
    readPort.respond = realtimeBatch();

    expect(await chainOf(true)).toBeNull();
    // 链都没就绪就不该去问价 —— 外呼在这里发出去就是白烧配额。
    expect(readPort.calls).toHaveLength(0);
  });

  it('🚨 `state_branch` 10: 返回集里库内不存在的合约被忽略 (盘中新挂, 当日不呈现)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch(['US.PEP260918P130000-GHOST']);

    const snapshot = await chainOf(true);
    if (snapshot === null) throw new Error('种子链应当命中 —— 断言前置失效');
    expect(snapshot.legs).toHaveLength(LEGS.length);
    expect(snapshot.legs.map((leg) => leg.code)).not.toContain('US.PEP260918P130000-GHOST');
  });
});
