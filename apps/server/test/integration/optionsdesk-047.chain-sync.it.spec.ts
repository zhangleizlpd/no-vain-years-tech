import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { AnchorDrivenSyncGate } from '../../src/marketdata/anchor-driven-sync-gate';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { SyncOptionContractUseCase } from '../../src/marketdata/sync-option-contract.usecase';
import { SyncOptionSnapshotUseCase } from '../../src/marketdata/sync-option-snapshot.usecase';
import type {
  OptionChainPort,
  OptionChainWindowQuery,
  OptionContractStatic,
  OptionExpiry,
} from '../../src/marketdata/option-chain.port';
import type {
  OptionSnapshotBatch,
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';

// 047 T017 链发现 + 逐日快照采集 IT (FR-031/032/033/035/036/037/038/043)。
//
// ## 为什么**必须**要真 PG
//
// 本文件验的五件事在 mock 上全部**不成立**, 且不会红、只会静默退化成平凡绿:
//   ① **工作集闸是一条 SQL 谓词** —— `needSync` 由 `AnchorDrivenSyncGate` 的双 `updateMany`
//      刷出来、再由 `loadActiveInstruments` 的 `where` 读回。把 `instrument.findMany` mock 掉
//      等于**直接把工作集当入参喂进去**, 「零锚 ⇒ 零请求」与「新锚下一轮自动纳入」这条链
//      (SC-005 / FR-035 / FR-038 的全部内容) 就没被测。
//   ② **快照的 hard 依赖是另一条 SQL 谓词** —— 「该票有没有未到期合约」是
//      `option_contract` 上的 `(underlying_instrument_id, expiry_date)` 索引查询 (FR-031);
//      mock 掉它, 「无合约即零外呼」只剩一句同义反复。
//   ③ **幂等是唯一键** —— `(market, code)` 与 `(contract_id, session_date, source)` 上的
//      `skipDuplicates` 冲突路径只有真 PG 有; mock 里 `createMany` 只是一次函数调用,
//      「同日重跑零重复行」在那里断言不到。
//   ④ **「硬门违规行不入库、且已落历史不被破坏」需要有历史可破坏** —— 这正是本文件的核心
//      价值, 也是它**故意**不放在 `sync-option-snapshot.usecase.spec.ts` (`unit` project,
//      零容器是硬不变量) 的原因: 那里没有库, 「历史没动」只能退化成「createMany 没被调用」。
//   ⑤ **`oi_as_of` 取的是交易日历表里的上一交易日** —— 「减一天」在周一与长假后是错的,
//      而那条查询读的是真 `trading_day` 表。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。不用 `setupEmptyDb()` —— 那个入口是给「自己跑 `migrate deploy`
// 并验证其产物」的文件用的 (本 feature 里 T009 已占); 本条要的是一个迁好的库。
//
// 装配 = 直接 new `DimensionExecutorRegistry` 打真 `PrismaService` (样板
// `optionsdesk-046.underlying-iv.it.spec.ts` / `optionsdesk-045.anchor.it.spec.ts`)。
//
// 🚨 vendor 侧恒 mock (`RecordingChainPort` / `RecordingSnapshotPort`) —— 本文件是 hermetic
// Medium IT, **这里计时毫无意义**: SC-009「单轮 ≤15 分钟」的唯一有效载体是 T013 扩进
// `marketdata.futu-shim.vendor.spec.ts` 的 env-gated 块。
//
// ⚠️ `expirationCycle` / `settlementMode` 断言按 **vendor 原样值** (`MONTH` / `PM`) ——
// T009 schema IT 里的 `'monthly'` / `'physical'` 只是建表期的占位, 不是本表的口径。
describe('047 T017 链发现 + 逐日快照采集 (Testcontainers PG, 真锚闸 + 记账端口)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let chain: RecordingChainPort;
  let snapshot: RecordingSnapshotPort;

  /**
   * 三个业务日, **取美股业务日 A′ 而非上海日** (FR-036)。
   * `2026-06-12` 是**周五**: 北京时间已是周六 06:00, 而 ET 侧还停在周五 18:00 ——
   * 全局 `shanghaiToday` 会在这一刻判「周六非交易日」并把周五整批丢掉 (每周固定丢一次)。
   */
  const FRI = { now: new Date('2026-06-12T22:00:00Z'), us: '2026-06-12', shanghai: '2026-06-13' };
  const MON = { now: new Date('2026-06-15T22:00:00Z'), us: '2026-06-15', shanghai: '2026-06-16' };
  const TUE = { now: new Date('2026-06-16T22:00:00Z'), us: '2026-06-16', shanghai: '2026-06-17' };

  /** delta 入参; `asOf` 蓄意给**上海日** —— executor 必须自己按 us 时区求 A′, 不吃这个值。 */
  const deltaInput = (d: typeof FRI) => ({ mode: 'delta' as const, asOf: d.shanghai, now: d.now });

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);
  const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

  /** 到期日 + 类型 + root → vendor 原样合约 code (含市场前缀, 与落库口径同)。 */
  const codeOf = (root: string, expiry: string, type: 'PUT' | 'CALL', strike: string): string =>
    `US.${root}${expiry.replaceAll('-', '').slice(2)}${type === 'PUT' ? 'P' : 'C'}${strike}`;

  /** 一条链合约静态属性 (adapter 归一化后的形态)。 */
  function contractOf(
    underlying: string,
    root: string,
    expiry: string,
    type: 'PUT' | 'CALL',
    over: Partial<OptionContractStatic> = {},
  ): OptionContractStatic {
    return {
      market: 'us',
      code: codeOf(root, expiry, type, '130000'),
      root,
      underlyingSymbol: underlying,
      expiryDate: expiry,
      strikePrice: '130',
      optionType: type,
      // vendor 原样值 —— 换算一次就再也说不清库里那个值是谁的口径。
      expirationCycle: 'MONTH',
      settlementMode: 'PM',
      isStandard: true,
      ...over,
    };
  }

  /**
   * test-local fake `OPTION_CHAIN_PORT`: **记每一次请求的入参**。
   *
   * 🚨「零锚 ⇒ 请求数 0」必须是**真数请求次数** —— 「库里没那批合约」是间接推断:
   * 工作集漏了它、问了但返空、落库被挡掉, 三者在库侧长得一模一样, 只有第一种是闸生效。
   */
  class RecordingChainPort implements OptionChainPort {
    readonly expiryCalls: string[] = [];
    readonly windowCalls: OptionChainWindowQuery[] = [];
    readonly ladders = new Map<string, string[]>();
    readonly contracts = new Map<string, OptionContractStatic[]>();

    async getExpiryDates(symbol: string): Promise<OptionExpiry[]> {
      this.expiryCalls.push(symbol);
      return (this.ladders.get(symbol) ?? []).map((d) => ({
        expiryDate: d,
        expirationCycle: 'MONTH',
        daysToExpiry: null,
      }));
    }

    async getChainWindow(query: OptionChainWindowQuery): Promise<OptionContractStatic[]> {
      this.windowCalls.push({ ...query });
      return (this.contracts.get(query.symbol) ?? []).filter(
        (c) => c.expiryDate >= query.start && c.expiryDate <= query.end,
      );
    }
  }

  /**
   * test-local fake `OPTION_SNAPSHOT_PORT`: 请求的每个合约一行 + **标的自身一行**
   * (spot 的来源, 与期权行同批返回)。
   *
   * 🚨 默认数值蓄意**过得了硬门** (`option-snapshot-guard.rules.ts`): spot 128.40 < K 130 ⇒
   * PUT 实值 / CALL 虚值, `ask ≥ 内在价值 − 容差` 两侧都真正走到。造违规行走 `overrides`。
   */
  class RecordingSnapshotPort implements OptionSnapshotPort {
    readonly calls: OptionSnapshotQuery[] = [];
    readonly overrides = new Map<string, Partial<OptionSnapshotRow>>();
    /** 本批采集时刻 (落 `quote_as_of`); 逐轮可改, 用来区分两轮写的是不是同一行。 */
    asOf = new Date('2026-06-12T20:31:07Z');
    spot: string | null = '128.40';

    async getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
      this.calls.push({ ...query, contractCodes: [...query.contractCodes] });
      const owner = `US.${query.underlyingSymbol.split(':')[1]}`;
      const rows: OptionSnapshotRow[] = query.contractCodes.map((code) => {
        const isPut = /P\d+$/.test(code);
        return {
          code,
          isOption: true,
          underlyingCode: owner,
          bid: isPut ? '2.30' : '1.05',
          ask: isPut ? '2.40' : '1.15',
          bidSize: '45',
          askSize: '60',
          last: isPut ? '2.35' : '1.10',
          prevClose: isPut ? '2.28' : '1.12',
          iv: '21.4',
          // 两侧符号相反 —— 抄成同号会让硬门的方向性判据形同虚设。
          delta: isPut ? '-0.31' : '0.28',
          gamma: '0.041',
          vega: '0.092',
          theta: '-0.058',
          rho: '0.011',
          openInterest: '3120',
          netOpenInterest: '-410',
          volume: '1204',
          turnover: '283940',
          vendorUpdateTime: new Date('2026-06-12T20:00:00Z'),
          greeksComplete: true,
          ...this.overrides.get(code),
        };
      });
      rows.push({
        code: owner,
        isOption: false,
        underlyingCode: null,
        bid: null,
        ask: null,
        bidSize: null,
        askSize: null,
        last: this.spot,
        prevClose: '127.90',
        iv: null,
        delta: null,
        gamma: null,
        vega: null,
        theta: null,
        rho: null,
        openInterest: null,
        netOpenInterest: null,
        volume: '3120000',
        turnover: '400000000',
        vendorUpdateTime: new Date('2026-06-12T20:00:00Z'),
        greeksComplete: null,
      });
      return { asOf: this.asOf, rows };
    }

    requestedCodes(): string[] {
      return this.calls.flatMap((c) => c.contractCodes);
    }
  }

  /**
   * 🚨 两个 use case 分别是构造器的**第 30 / 31 个位置参数**, 直接 new 装配时错位不会红、
   * 只会把端口注成别的东西。`anchorGate` 传**真实例**而非 stub —— 「锚表 → `needSync` →
   * 工作集」这条被测链就住在它里面。
   */
  function buildRegistry(): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      undefined, // revenueSegment → 默认 null-object
      undefined, // shareholderSnapshot → 默认 null-object
      undefined, // employee → 默认 null-object
      undefined, // industryClassification → 默认 null-object
      undefined, // announcement → 默认 null-object
      new AnchorDrivenSyncGate(prisma), // anchorGate (045 T015): **真闸**, 被测面
      undefined, // underlyingIv → 默认 null-object
      undefined, // usIndex → 默认 null-object
      new SyncOptionContractUseCase(chain, prisma), // 047 T015 (尾部第 30 位)
      new SyncOptionSnapshotUseCase(snapshot, prisma, stubTradingCalendar()), // 047 T016 (尾部第 31 位)
    );
  }

  /**
   * 真 `Instrument` 行。`needSync` 显式给 —— us 走「无锚不采」成员制, 新注册的 us 标的
   * 默认是**关闸**的。
   */
  async function seedInstrument(code: string, needSync: boolean): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market: 'us',
        code,
        name: `${code} Inc.`,
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** 真 `Anchor` 行 (optionsdesk schema)。闸只读 `ticker` 一列, 其余取合法最小集。 */
  async function seedAnchor(ticker: string): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker,
        market: ticker.split(':')[0]!,
        v: '50',
        asof: dateOf('2026-06-01'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
  }

  /** PEP 的默认链: 周五到期 (当日到期) + 一个月后到期的 PUT/CALL 双边。 */
  function seedPepChain(): void {
    chain.ladders.set('us:PEP', ['2026-06-12', '2026-07-17']);
    chain.contracts.set('us:PEP', [
      contractOf('us:PEP', 'PEP', '2026-06-12', 'PUT'),
      contractOf('us:PEP', 'PEP', '2026-07-17', 'PUT'),
      contractOf('us:PEP', 'PEP', '2026-07-17', 'CALL'),
    ]);
  }

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
    await prisma.anchor.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.tradingDay.deleteMany();
    // us 交易日历: `oi_as_of` 取「session_date 的上一交易日」, 读的就是这张表
    // (周末不在表内 ⇒ 周一的上一交易日是上周五, 而不是「减一天」得到的周日)。
    await prisma.tradingDay.createMany({
      data: ['2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16'].map((d) => ({
        market: 'us',
        date: dateOf(d),
      })),
    });
    chain = new RecordingChainPort();
    snapshot = new RecordingSnapshotPort();
  });

  // ── ① 零锚: 两个维度跑绿、请求数 0、无假红告警 (state_branch 21, FR-035) ──
  it('① 零锚 → 两个维度都跑绿且**请求数 0**, SyncRun 不是红 (沉默 ≠ 失败)', async () => {
    // LULU 蓄意造成「陈旧开闸」态: 闸必须主动把它关掉才能让请求面干净。只造 false 的话,
    // 这条断言会被初始值兜住 —— 闸整个不生效也照样绿。
    await seedInstrument('LULU', true);
    seedPepChain();
    const registry = buildRegistry();

    const contractRun = await registry.execute('option_contract', deltaInput(FRI));
    const snapshotRun = await registry.execute('option_daily_snapshot', deltaInput(FRI));

    expect(chain.expiryCalls).toHaveLength(0);
    expect(chain.windowCalls).toHaveLength(0);
    expect(snapshot.calls).toHaveLength(0);
    expect(contractRun.stats).toMatchObject({ scanned: 0, ok: 0, failed: 0 });
    expect(snapshotRun.stats).toMatchObject({ scanned: 0, ok: 0, failed: 0 });
    expect(await prisma.optionContract.count()).toBe(0);
    expect(await prisma.optionDailySnapshot.count()).toBe(0);

    // 闸把陈旧的 needSync 关掉了 (它就是工作集的 where 谓词本身)。
    expect(await prisma.instrument.findFirst({ select: { needSync: true } })).toEqual({
      needSync: false,
    });
    // 无假红: 零锚是**正常空态**, 记成 failed 会让夜间日报天天红。
    const runs = await prisma.syncRun.findMany({ select: { syncType: true, status: true } });
    expect(runs.every((r) => r.status === 'success')).toBe(true);
    expect(runs.map((r) => r.syncType).sort()).toEqual([
      'sync:option_contract',
      'sync:option_daily_snapshot',
    ]);
  });

  // ── ② 新增锚 → **下一轮**自动纳入 (SC-005 / FR-028b / FR-038) ──
  it('② 新建锚 (Instrument 尚无行) → 本轮兜底 seed 关闸建行, **下一轮**才进工作集', async () => {
    // ⚠️ 「下一轮」是**设计**而非缺陷: 兜底 seed 落 `needSync=false` (那列的唯一重算权威是
    // 锚闸), 由下一轮 fact 前置的锚闸开闸。断言「新锚当轮即进工作集」会红。
    seedPepChain();
    await seedAnchor('us:PEP');
    const registry = buildRegistry();

    const round1 = await registry.execute('option_contract', deltaInput(FRI));

    expect(chain.expiryCalls).toHaveLength(0); // 本轮工作集为空 ⇒ 零外呼
    expect(round1.stats).toMatchObject({ scanned: 0, failed: 0 });
    expect(await prisma.instrument.findFirst({ select: { code: true, needSync: true } })).toEqual({
      code: 'PEP',
      needSync: false,
    });

    // 下一轮: 零代码改动, 锚闸把它刷成 needSync ⇒ 自动进工作集 (FR-038)。
    const round2 = await registry.execute('option_contract', deltaInput(MON));

    expect(chain.expiryCalls).toEqual(['us:PEP']);
    expect(round2.stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 下一轮的业务日已是周一 06-15 ⇒ 06-12 到期那条掉出工作集 (FR-028a 的 `≥`),
    // 落库的是 07-17 的 PUT + CALL 两条。
    expect(await prisma.optionContract.count()).toBe(2);
  });

  // ── ③ 快照 hard 依赖链发现 (FR-031) ──
  it('③ 合约表无行 → 快照维度**一次外呼都不发**; 链发现跑过之后才有数据', async () => {
    await seedInstrument('PEP', true);
    await seedAnchor('us:PEP');
    seedPepChain();
    const registry = buildRegistry();

    const dry = await registry.execute('option_daily_snapshot', deltaInput(FRI));

    // 「请求了但 vendor 返空」与「压根没请求」在库侧长得一样, 只有计数分得开。
    expect(snapshot.calls).toHaveLength(0);
    expect(dry.stats).toMatchObject({ scanned: 1, ok: 0, skipped: 1, failed: 0 });

    await registry.execute('option_contract', deltaInput(FRI));
    const wet = await registry.execute('option_daily_snapshot', deltaInput(FRI));

    expect(snapshot.calls).toHaveLength(1);
    expect(wet.stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(await prisma.optionDailySnapshot.count()).toBe(3);
  });

  // ── ④ 非标合约落库成功 (FR-033, Guardrail 4; 排除只发生在选约层 = T029) ──
  it('④ 非标合约 (调整后 root `VICI1`) 照常落库, 只是 is_standard=false', async () => {
    await seedInstrument('VICI', true);
    await seedAnchor('us:VICI');
    chain.ladders.set('us:VICI', ['2026-07-17']);
    chain.contracts.set('us:VICI', [
      contractOf('us:VICI', 'VICI', '2026-07-17', 'PUT'),
      // GDEN 被 VICI 并购后 OCC 调整的期权遗骸: 90 股乘数 + 现金找零, 不可交易但**必须采**
      // —— 在采集端滤掉 = 证据没了且不可回补。
      contractOf('us:VICI', 'VICI1', '2026-07-17', 'PUT', {
        isStandard: false,
        settlementMode: null,
      }),
    ]);

    await buildRegistry().execute('option_contract', deltaInput(FRI));

    // 按 root 排 (不是 code): code 序里 `VICI1…` 反而排在 `VICI2…` 前面, 断言会读反。
    const rows = await prisma.optionContract.findMany({ orderBy: { root: 'asc' } });
    expect(rows.map((r) => [r.root, r.isStandard])).toEqual([
      ['VICI', true],
      ['VICI1', false],
    ]);
    // vendor 原样值入库 (不是 T009 建表期占位的 'monthly' / 'physical')。
    expect(rows[0].expirationCycle).toBe('MONTH');
    expect(rows[0].settlementMode).toBe('PM');
    expect(rows[1].settlementMode).toBeNull(); // 缺字段落 null, 禁默认值冒充
  });

  // ── ⑤ 同日重跑零重复行 (FR-037) ──
  it('⑤ 两个维度同日各跑两遍 → **零重复行** (唯一键即幂等语义载体)', async () => {
    await seedInstrument('PEP', true);
    await seedAnchor('us:PEP');
    seedPepChain();
    const registry = buildRegistry();

    await registry.execute('option_contract', deltaInput(FRI));
    await registry.execute('option_daily_snapshot', deltaInput(FRI));
    const firstQuoteAsOf = (await prisma.optionDailySnapshot.findFirstOrThrow()).quoteAsOf;

    // 第二轮换一个采集时刻 —— 用它区分「撞唯一键跳过」与「被覆盖重写」。
    snapshot.asOf = new Date('2026-06-12T20:59:00Z');
    await registry.execute('option_contract', deltaInput(FRI));
    await registry.execute('option_daily_snapshot', deltaInput(FRI));

    expect(await prisma.optionContract.count()).toBe(3);
    expect(await prisma.optionDailySnapshot.count()).toBe(3);
    // skipDuplicates 而非 upsert: 已落行的 quote_as_of 不该被重跑改写 (那列的意义正是
    // 「这一行是什么时候采的」)。
    const rows = await prisma.optionDailySnapshot.findMany({ select: { quoteAsOf: true } });
    expect(rows.every((r) => r.quoteAsOf.getTime() === firstQuoteAsOf.getTime())).toBe(true);
  });

  // ── ⑥ 业务日期按 us 时区, 跨周五验一次 (FR-036 / plan D-DATA-10) ──
  it('⑥ 北京周六 06:00 跑 → 业务日仍是**周五**: 当日到期的腿被采, 快照落周五', async () => {
    // 用全局上海日会算成周六 06-13: ① 周五到期那批腿在它们**最后一天**被整批跳过
    // (漏采即永久缺口) ② 快照行整体错位一天。两个都不会红。
    await seedInstrument('PEP', true);
    await seedAnchor('us:PEP');
    seedPepChain();
    const registry = buildRegistry();

    await registry.execute('option_contract', deltaInput(FRI));
    await registry.execute('option_daily_snapshot', deltaInput(FRI));

    // FR-028a: 判据是 **≥** 当前交易日 —— 当日到期的合约当日仍可取快照。
    expect(chain.windowCalls[0].start).toBe('2026-06-12');
    const expiring = await prisma.optionContract.findFirstOrThrow({
      where: { expiryDate: dateOf('2026-06-12') },
    });
    expect(snapshot.requestedCodes()).toContain(expiring.code);

    const rows = await prisma.optionDailySnapshot.findMany();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(dayOf(row.sessionDate)).toBe(FRI.us); // 不是上海日 06-13
      expect(row.source).toBe('eod');
      // 🚨 Guardrail 6: OI 归**上一交易日** (周四), 不是 session_date。
      expect(dayOf(row.oiAsOf)).toBe('2026-06-11');
      expect(row.quoteAsOf.getTime()).toBe(snapshot.asOf.getTime());
    }
    // 周一跑时上一交易日是**上周五** —— 交易日历说了算, 不是「减一天」得到的周日。
    await registry.execute('option_daily_snapshot', deltaInput(MON));
    const monday = await prisma.optionDailySnapshot.findFirstOrThrow({
      where: { sessionDate: dateOf(MON.us) },
    });
    expect(dayOf(monday.oiAsOf)).toBe('2026-06-12');
  });

  // ── ⑦ 硬门违规行不入库, 且**已落历史不被破坏** (FR-043) ──
  it('⑦ 违规行逐行拒绝: 当日其余行照常入库, 前一日已落行**一字未动**', async () => {
    await seedInstrument('PEP', true);
    await seedAnchor('us:PEP');
    // 只留 7 月到期那两条 —— 6-12 那条在第二天 (06-16) 已过期, 会掉出工作集。
    chain.ladders.set('us:PEP', ['2026-07-17']);
    chain.contracts.set('us:PEP', [
      contractOf('us:PEP', 'PEP', '2026-07-17', 'PUT'),
      contractOf('us:PEP', 'PEP', '2026-07-17', 'CALL'),
    ]);
    const registry = buildRegistry();
    const put = codeOf('PEP', '2026-07-17', 'PUT', '130000');

    await registry.execute('option_contract', deltaInput(MON));
    await registry.execute('option_daily_snapshot', deltaInput(MON));
    const day1 = await prisma.optionDailySnapshot.findMany({ orderBy: { id: 'asc' } });
    expect(day1).toHaveLength(2);

    // 次日: PUT 那条盘口交叉 (bid > ask), 是不可能的真实报价。
    snapshot.overrides.set(put, { bid: '9.90', ask: '2.40' });
    snapshot.asOf = new Date('2026-06-16T20:31:07Z');
    const run = await registry.execute('option_daily_snapshot', deltaInput(TUE));

    const day2 = await prisma.optionDailySnapshot.findMany({
      where: { sessionDate: dateOf(TUE.us) },
      include: { contract: { select: { code: true } } },
    });
    // 违规行不入库, 同批其余行照常入库 —— 一条脏行 MUST NOT 带走当日唯一一次采集机会。
    expect(day2).toHaveLength(1);
    expect(day2[0].contract.code).not.toBe(put);
    // 该票整体仍算 ok (行级拒绝不是标的级失败), 但留痕进 failedTargets 审计通道。
    expect(run.stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(JSON.stringify(run.stats.failedTargets)).toContain(put);

    // 🚨 已落历史逐字段未动 (含被拒那条腿前一日的行)。
    const day1After = await prisma.optionDailySnapshot.findMany({
      where: { sessionDate: dateOf(MON.us) },
      orderBy: { id: 'asc' },
    });
    expect(day1After).toEqual(day1);
  });
});
