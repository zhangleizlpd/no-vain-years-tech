import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedStores } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import {
  marketdataSyncConfig,
  type MarketdataSyncConfig,
} from '../../src/config/marketdata.config';
import { MarketdataModule } from '../../src/marketdata/marketdata.module';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { CreateAnchorUseCase } from '../../src/optionsdesk/create-anchor.usecase';
import { UpdateAnchorUseCase } from '../../src/optionsdesk/update-anchor.usecase';
import { ImportAnchorFromModelUseCase } from '../../src/optionsdesk/import-anchor-from-model.usecase';
import { AnchorColdStartUseCase } from '../../src/marketdata/anchor-cold-start.usecase';
import { COLD_START_OUTCOME } from '../../src/marketdata/anchor-cold-start.rules';
import { MarketdataSyncWorker } from '../../src/marketdata/marketdata-sync.worker';
import {
  ANCHOR_COLD_START_JOB,
  ANCHOR_COLD_START_RETRY_MAX,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
  dimensionJobName,
  type DimensionJobPayload,
} from '../../src/marketdata/marketdata-sync.queue';
import { SNAPSHOT_SOURCE_EOD } from '../../src/marketdata/sync-option-snapshot.usecase';
import {
  OPTION_SNAPSHOT_PORT,
  OptionSnapshotBudgetExhaustedError,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
  type OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';

// 060 T011 冷启动 IT 下半: 市场参数化 / 失败重试 / 结局可区分 (SC-005, SC-007, SC-009, SC-010;
// spec state_branches ④⑤⑪⑫⑬⑭⑮⑯⑰⑱⑳㉑㉒㉔)。上半 (触发链 / 时点归属 / 幂等) 在
// `marketdata.cold-start-060.trigger-timing.it.spec.ts`, 两份共用同一套脚手架。
//
// ## 为什么必须要真 PG + 真 Redis + 真 DI 容器
//
// 这四件事在 mock 上要么不成立, 要么只会静默退化成平凡绿:
//   ① **建锚事件的事务边界** —— ⑤ 要的是「建锚回滚 ⇒ outbox 行一起没」。publish 是否真的与
//      锚行同生共死, 只有让一次**真回滚**发生在真事务里才验得到; mock 的 publisher 无论挂在
//      tx 里还是 tx 外, 被调次数都一样。
//   ② **结局的零折叠 (㉒)** —— 判据是「同一张表里九种取值同时在场且两两互异」。单测里各分支
//      各自断言自己那个常量, 断不出「两个分支落了同一个值」。
//   ③ **顺延重入队 (㉑) 是真 Redis 的账** —— `attempts` 有没有被顺延吃掉、`phase` 有没有被
//      丢掉、delay 是不是配额窗, 都记在 BullMQ 的 job 上, 不在被测代码的返回值里。
//   ④ **seed 标的与开闸的次序 (⑫)** —— 次序反了的表现是「闸拿到空工作集」, 而那**不报错**;
//      唯一可观测的差别是真表上那一行的 `need_sync` 值。
//
// ⇒ 存储从 `test/_support/isolated-db.ts` 的 `setupIsolatedStores()` 取 (共享 PG 的模板克隆 +
// 独立 Redis db, **禁自起 Testcontainers**)。
//
// ## worker 不启动, 但 worker 的两条出口由本文件**手工驱动**
//
// `MARKETDATA_WORKER_DISABLED` 置位 ⇒ BullMQ Worker 不起 (否则它会去真跑链发现/日线维度,
// 那是另一片的地盘, 且会与本文件的手工驱动抢 job)。`MarketdataSyncWorker` 实例仍在容器里,
// 故 `process()` (顺延重入队) 与 `onJobFailed()` (retry 耗尽) 两条出口是**真方法真 job**,
// 不是桩 —— 它们正是 FR-019a / FR-019b 的落点。
describe('060 T011 冷启动市场参数化 / 失败重试 / 结局可区分 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let coldStart: AnchorColdStartUseCase;
  let createAnchor: CreateAnchorUseCase;
  let updateAnchor: UpdateAnchorUseCase;
  let importAnchor: ImportAnchorFromModelUseCase;
  let syncQueue: MarketdataSyncQueue;
  let worker: MarketdataSyncWorker;
  let syncCfg: MarketdataSyncConfig;
  let port: RecordingSnapshotPort;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  /** 2026-08 的 us 交易日 (周末不在表内)。08-15 周六 / 08-16 周日 = 缺行。 */
  const TRADING_DAYS = [
    '2026-08-10',
    '2026-08-11',
    '2026-08-12',
    '2026-08-13',
    '2026-08-14',
    '2026-08-17',
    '2026-08-18',
  ];
  /** 目标交易日 (周五)。 */
  const TARGET = '2026-08-14';
  const DAY_BEFORE_TARGET = '2026-08-13';

  /** ET 周六 20:00 (北京周日 08:00): 典型休市 —— 敏感档可写。 */
  const SAT_NIGHT = new Date('2026-08-16T00:00:00Z');
  /** ET 周一 10:30 (北京周一 22:30): 连续竞价进行中。 */
  const MON_MIDSESSION = new Date('2026-08-17T14:30:00Z');

  const TICKER = 'us:PEP';
  const TICKER_B = 'us:KO';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  /**
   * test-local fake `OPTION_SNAPSHOT_PORT` (与 T010 同一份, 多一个 {@link failNextWith}):
   * 请求的每个合约一行 + 标的自身一行 (spot 的来源)。`calls` = 「外呼次数」的观测面。
   *
   * 🚨 spot 128.40 < K 130 ⇒ PUT 虚值侧过得了落库前硬门 (`ask ≥ 内在价值 − 容差`)。
   */
  class RecordingSnapshotPort implements OptionSnapshotPort {
    readonly calls: OptionSnapshotQuery[] = [];
    /** 置位后**下一次**调用抛它 (置回 null) —— 造 vendor 429 顺延用。 */
    failNextWith: Error | null = null;

    async getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
      this.calls.push({ ...query, contractCodes: [...query.contractCodes] });
      if (this.failNextWith !== null) {
        const err = this.failNextWith;
        this.failNextWith = null;
        throw err;
      }
      const owner = `US.${query.underlyingSymbol.split(':')[1]}`;
      const rows: OptionSnapshotRow[] = query.contractCodes.map((code) => quoteRow(code, owner));
      rows.push({
        ...quoteRow(owner, owner),
        isOption: false,
        underlyingCode: null,
        last: '128.40',
      });
      return { asOf: new Date('2026-08-14T20:02:11Z'), rows };
    }
  }

  function quoteRow(code: string, owner: string): OptionSnapshotRow {
    return {
      code,
      isOption: true,
      underlyingCode: owner,
      bid: '2.30',
      ask: '2.40',
      bidSize: '45',
      askSize: '60',
      last: '2.35',
      prevClose: '2.28',
      iv: '21.4',
      delta: '-0.31',
      gamma: '0.041',
      vega: '0.092',
      theta: '-0.058',
      rho: '0.011',
      openInterest: '3120',
      netOpenInterest: '-410',
      volume: '1204',
      turnover: '283940',
      vendorUpdateTime: new Date('2026-08-14T20:00:00Z'),
      greeksComplete: true,
    };
  }

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'cold-start-060-jwt-secret-min-32-byte-long';
    process.env.SMS_CODE_HMAC_SECRET = 'cold-start-060-hmac-secret-min-32-byte-lo';
    delete process.env.MARKETDATA_PROVIDER;
    // 🚨 worker 不启动 (见文件头)。
    process.env[MARKETDATA_WORKER_DISABLED] = '1';

    port = new RecordingSnapshotPort();
    moduleRef = await Test.createTestingModule({
      imports: narrowTestModule([MarketdataModule, OptionsdeskModule]),
    })
      .overrideProvider(OPTION_SNAPSHOT_PORT)
      .useValue(port)
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    coldStart = moduleRef.get(AnchorColdStartUseCase);
    createAnchor = moduleRef.get(CreateAnchorUseCase);
    updateAnchor = moduleRef.get(UpdateAnchorUseCase);
    importAnchor = moduleRef.get(ImportAnchorFromModelUseCase);
    syncQueue = moduleRef.get(MarketdataSyncQueue);
    worker = moduleRef.get(MarketdataSyncWorker);
    syncCfg = moduleRef.get(marketdataSyncConfig.KEY);
  }, 180_000);

  afterAll(async () => {
    delete process.env[MARKETDATA_WORKER_DISABLED];
    await moduleRef?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    port.calls.length = 0;
    port.failNextWith = null;
    await prisma.optionDailySnapshot.deleteMany({});
    await prisma.optionContract.deleteMany({});
    await prisma.dailyBar.deleteMany({});
    await prisma.anchorColdStartRun.deleteMany({});
    await prisma.anchorChange.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.instrument.deleteMany({});
    await prisma.outboxEvent.deleteMany({});
    await syncQueue.queue.obliterate({ force: true });
    // 日历**每例重建**: ⑪ 要把它删空, 别让那一例污染后面的用例。
    await prisma.tradingDay.deleteMany({ where: { market: 'us' } });
    await prisma.tradingDay.createMany({
      data: TRADING_DAYS.map((d) => ({ market: 'us', date: dateOf(d) })),
      skipDuplicates: true,
    });
  });

  /**
   * 标的 + 一条未到期合约。到期日**远**在所有用例之后 —— 本文件有一例走真实钟点
   * (㉑ 的 worker 出口), 到期日贴着今天会让它某天突然采不到合约。
   */
  async function seedUnderlying(
    ticker: string,
    opts: { withContract?: boolean } = {},
  ): Promise<{ instrumentId: bigint; code: string }> {
    const code = ticker.split(':')[1]!;
    const inst = await prisma.instrument.create({
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
    // `withContract: false` = 链发现**跑完了但这只票零合约** —— 第二相于是拿着空工作集跑。
    if (opts.withContract === false) return { instrumentId: inst.id, code };
    await prisma.optionContract.create({
      data: {
        market: 'us',
        code: `US.${code}301220P130000`,
        root: code,
        underlyingInstrumentId: inst.id,
        expiryDate: dateOf('2030-12-20'),
        strikePrice: '130',
        optionType: 'PUT',
        isStandard: true,
      },
    });
    return { instrumentId: inst.id, code };
  }

  /**
   * 种一只**写侧闸不肯造**的锚 (不受支持市场 / 非 canonical 写法), 返回 anchorId。
   *
   * 🚨 刻意绕开 `CreateAnchorUseCase`: 065 T02 起建锚拒非白名单市场与非法形状 (FR-014)。
   *    但本文件测的是 **marketdata 冷启动对这类行的 fail-closed 行为** —— 那是另一个 ctx,
   *    它的输入是事件载荷里的 ticker 串, 必须对任何取值都留痕早退, 不能靠「上游不会给」。
   *    直接种行是让这个契约仍然可测的唯一办法, 不是偷懒。
   */
  async function seedRawAnchor(ticker: string): Promise<bigint> {
    const row = await prisma.anchor.create({
      data: {
        ticker,
        v: '50',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
    return row.id;
  }

  /** 建一只锚 (走真 use case ⇒ 顺带落 outbox 行), 返回 anchorId。 */
  async function createAnchorFor(ticker: string): Promise<bigint> {
    const row = await createAnchor.execute({
      ticker,
      v: '50',
      asof: dateOf('2026-06-30'),
      method: 'dcf',
      confidence: '8',
    });
    return row.id;
  }

  /** 造「第一相的链/日线 child 已跑完」的数据形态 (worker 不启动, 它们不会自己跑)。 */
  async function seedTargetDayData(
    instrumentId: bigint,
    opts: { snapshot?: boolean } = {},
  ): Promise<void> {
    await prisma.dailyBar.create({
      data: {
        instrumentId,
        tradeDate: dateOf(TARGET),
        adjust: 'none',
        open: '128.00',
        high: '129.00',
        low: '127.50',
        close: '128.40',
      },
    });
    if (opts.snapshot !== true) return;
    const contract = await prisma.optionContract.findFirstOrThrow({
      where: { underlyingInstrumentId: instrumentId },
      select: { id: true },
    });
    await prisma.optionDailySnapshot.create({
      data: {
        contractId: contract.id,
        sessionDate: dateOf(TARGET),
        source: SNAPSHOT_SOURCE_EOD,
        quoteAsOf: new Date(`${TARGET}T20:31:07Z`),
        oiAsOf: dateOf(DAY_BEFORE_TARGET),
        bid: '2.30',
        ask: '2.40',
        greeksComplete: true,
      },
    });
  }

  /** 一条维度 job payload (⑱ / ⑳ 的反例用; 走真入队面拿真 job)。 */
  const dimensionPayload: DimensionJobPayload = {
    dimensionKey: 'option_contract',
    mode: 'delta',
    asOf: TARGET,
    triggeredBy: 'tick',
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 触发面: 谁发事件、谁不发 (FR-002 / FR-003 / FR-004)
  // ───────────────────────────────────────────────────────────────────────────

  it('④ 既有锚更新 (App 路径) ⇒ 一行事件都不发', async () => {
    const anchorId = await createAnchorFor(TICKER);
    expect(await prisma.outboxEvent.count()).toBe(1);
    await prisma.outboxEvent.deleteMany({});

    await updateAnchor.execute(anchorId, { confidence: '9' });

    // 先确认这次 update 真的改了东西 —— 否则「零事件」只是因为什么都没发生 (恒真)。
    const row = await prisma.anchor.findUniqueOrThrow({ where: { id: anchorId } });
    expect(row.confidence.toString()).toBe('9');
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it('④ 模型导入: create 分支**恰好**一行事件 (委托 create, 不双发不漏发); update 分支零新增', async () => {
    const created = await importAnchor.execute({
      ticker: TICKER,
      v: '50',
      asof: dateOf('2026-06-30'),
      method: 'dcf',
      confidence: '8',
    });

    // 🚨 第二条建锚入口。它**委托** `CreateAnchorUseCase` ⇒ 事件自动覆盖; 谁在 import 侧
    //    再发一遍就是 2 行 (双发), 谁把 create 分支改成直写 prisma 就是 0 行 (漏发)。
    expect(created.action).toBe('create');
    expect(await prisma.outboxEvent.count()).toBe(1);
    await prisma.outboxEvent.deleteMany({});

    const updated = await importAnchor.execute({
      ticker: TICKER,
      v: '55',
      asof: dateOf('2026-07-31'),
      method: 'dcf',
      confidence: '8',
    });

    expect(updated.action).toBe('update');
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it('🚨 ⑤ 建锚事务回滚 ⇒ 锚行与 outbox 行**同生共死**, 一行都不留', async () => {
    // `anchor.method` 是 VarChar(32) ⇒ 40 字符在 tx 内 `create` 那一步炸 (P2000), 回滚整个
    // 事务。这是本层能造出的、最贴近真实的「写到一半失败」。
    await expect(
      createAnchor.execute({
        ticker: TICKER,
        v: '50',
        asof: dateOf('2026-06-30'),
        method: 'x'.repeat(40),
        confidence: '8',
      }),
    ).rejects.toThrow();

    // 🚨 谁把 publish 挪出 `$transaction` (或另开一个 tx 发), 这里就会留下一条**指向不存在的
    //    锚**的事件 ⇒ 冷启动给一只根本没建成的锚跑采集。FR-004 要的正是这条边界。
    expect(await prisma.anchor.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 市场参数化: 四种早退各自留痕、零外呼 (FR-020 ~ FR-025)
  // ───────────────────────────────────────────────────────────────────────────

  it('⑮ ticker 解析不出 `market:code` ⇒ ticker_unresolved, 零外呼且不建任何 Instrument 行', async () => {
    const anchorId = await seedRawAnchor('PEP');

    const result = await coldStart.run({ anchorId, ticker: 'PEP', now: SAT_NIGHT });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.TICKER_UNRESOLVED });
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.reason).toContain('PEP');
    // 定位不到目标交易日的早退分支 ⇒ target_session 必须是 NULL, 不是「今天」。
    expect(run.targetSession).toBeNull();
    expect(port.calls).toHaveLength(0);
    // 市场都解析不出来, seed 标的行等于凭空造一只市场未知的票。
    expect(await prisma.instrument.count()).toBe(0);
  });

  it('⑬ 市场未登记盘中时段 ⇒ session_unregistered (fail-closed, 先于能力检查)', async () => {
    const anchorId = await seedRawAnchor('jp:7203');

    const result = await coldStart.run({ anchorId, ticker: 'jp:7203', now: SAT_NIGHT });

    // 时段没登记 ⇒ 判不了「此刻是不是盘中」⇒ 宁可不写。**不是**静默跳过: 留痕才分得清
    // 「今天本就不该做」与「该做没做成」。
    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.SESSION_UNREGISTERED });
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.reason).toContain('jp');
    expect(port.calls).toHaveLength(0);
    expect(await prisma.instrument.count()).toBe(0);
  });

  it('⑭ hk (登记了时段但能力空表项) 与 cn (压根没登记能力) ⇒ 同落 market_not_enabled, 各留一行', async () => {
    const hk = await createAnchorFor('hk:0700');
    const cn = await seedRawAnchor('cn:600519');

    const hkResult = await coldStart.run({ anchorId: hk, ticker: 'hk:0700', now: SAT_NIGHT });
    const cnResult = await coldStart.run({ anchorId: cn, ticker: 'cn:600519', now: SAT_NIGHT });

    // 「已知但未开通」与「压根没考虑过」结局同值 —— 但**都留痕**, 不静默 no-op。
    expect(hkResult).toEqual({ settled: true, outcome: COLD_START_OUTCOME.MARKET_NOT_ENABLED });
    expect(cnResult).toEqual({ settled: true, outcome: COLD_START_OUTCOME.MARKET_NOT_ENABLED });
    const runs = await prisma.anchorColdStartRun.findMany({ orderBy: { anchorId: 'asc' } });
    expect(runs.map((r) => r.ticker)).toEqual(['hk:0700', 'cn:600519']);
    expect(runs.every((r) => r.targetSession === null)).toBe(true);
    expect(port.calls).toHaveLength(0);
  });

  it('🚨 ⑪ 交易日历缺行 ⇒ calendar_missing + target_session 为 NULL, **不猜日期**、零外呼零落库', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId);
    await prisma.tradingDay.deleteMany({ where: { market: 'us' } });
    expect(await prisma.tradingDay.count({ where: { market: 'us' } })).toBe(0);

    const result = await coldStart.run({
      anchorId,
      ticker: TICKER,
      now: SAT_NIGHT,
      phase: 'snapshot',
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.CALENDAR_MISSING });
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    // 🚨 猜一个日子 ⇒ 一批 session_date 标错的脏行, 比不补更难发现且要人工回删。
    //    「猜了没有」的可判读证据就是这一格: 定位不到就必须是 NULL。
    expect(run.targetSession).toBeNull();
    expect(run.reason).toContain('us');
    expect(port.calls).toHaveLength(0);
    expect(await prisma.optionDailySnapshot.count()).toBe(0);
  });

  it('🚨 ⑫ 有锚但 Instrument 缺行 ⇒ 兜底 seed 出来, 且**闸随后开到它** (证明 seed 先于开闸)', async () => {
    const anchorId = await createAnchorFor(TICKER);
    expect(await prisma.instrument.count()).toBe(0);

    const result = await coldStart.run({ anchorId, ticker: TICKER, now: SAT_NIGHT });

    expect(result).toEqual({ settled: false, deferral: 'awaiting_chain' });
    const inst = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'us', code: 'PEP' } },
    });
    // seed 的形态逐条照抄 `SyncOptionContractUseCase.seedAnchoredInstruments`: name 落 code
    // 占位 (列 NOT NULL, universe 轮到它时覆盖成真名)。
    expect(inst.name).toBe('PEP');
    expect(inst.currency).toBe('USD');
    expect(inst.type).toBe('stock');
    expect(inst.status).toBe('active');
    // 🚨 `need_sync` 是「seed → 开闸」这个**次序**唯一的可观测证据: 闸只认已存在的
    //    Instrument 行, 次序反了它就拿到空工作集 ⇒ 这一格恒为 false, 而**整条路径全绿**
    //    (那只新锚从此再也进不了任何采集轮)。
    expect(inst.needSync).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 顺延 / 重试 / 失败 (FR-018 / FR-019a / FR-019b)
  // ───────────────────────────────────────────────────────────────────────────

  it('🚨 ⑯ vendor 配额耗尽 ⇒ 交回 vendor_budget 顺延信号, 且**一行运行记录都不落**', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId);
    port.failNextWith = new OptionSnapshotBudgetExhaustedError('IT 造的 429');

    const result = await coldStart.run({
      anchorId,
      ticker: TICKER,
      now: SAT_NIGHT,
      phase: 'snapshot',
    });

    expect(result).toEqual({ settled: false, deferral: 'vendor_budget' });
    // 🚨 顺延**不是结局**: 落 `backfilled` 是谎 (什么都没采到), 落 `retry_exhausted` 是冤
    //    (还没开始重试)。这张表此刻必须是空的 —— 结局由顺延后真正跑完的那一次写。
    expect(await prisma.anchorColdStartRun.count()).toBe(0);
    expect(await prisma.optionDailySnapshot.count()).toBe(0);
    expect(port.calls).toHaveLength(1);
  });

  it('🚨 ㉑ worker 顺延重入队: payload 原样 (含 phase) + attempts **不被顺延吃掉** + delay = 配额窗', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId);
    port.failNextWith = new OptionSnapshotBudgetExhaustedError('IT 造的 429');
    const job = await syncQueue.enqueueColdStart({
      anchorId: String(anchorId),
      ticker: TICKER,
      phase: 'snapshot',
    });
    // 手工驱动 processor 的前提: 真 worker 没在跑, 否则它会抢走这个 job。
    expect(worker.running).toBe(false);

    // worker 用的是**真时钟** (`new Date()`), 而本片的判据全落在具体时刻上 ⇒ 只 fake Date
    // (不 fake 定时器, 那会把 ioredis / PG 的 I/O 一起冻住)。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SAT_NIGHT);
    let result: unknown;
    try {
      result = await worker.process(job);
    } finally {
      vi.useRealTimers();
    }

    expect(result).toEqual({ settled: false, deferral: 'vendor_budget' });
    const delayed = await syncQueue.queue.getJobs(['delayed']);
    expect(delayed).toHaveLength(1);
    expect(delayed[0]!.name).toBe(ANCHOR_COLD_START_JOB);
    // 🚨 `phase` 丢了 ⇒ 顺延回来的那一次从**第一相**重跑 ⇒ 再组一次 flow ⇒ 每次配额耗尽都
    //    多挂一棵树, 而队列表面上一切正常。
    expect(delayed[0]!.data).toEqual({
      anchorId: String(anchorId),
      ticker: TICKER,
      phase: 'snapshot',
    });
    // 🚨 顺延 ≠ 失败 (FR-019b): 重试次数一次都不该耗 —— 否则一次限频窗就能把 3 次机会烧光,
    //    最后落一个 `retry_exhausted` 的冤枉结局。
    expect(delayed[0]!.opts.attempts).toBe(ANCHOR_COLD_START_RETRY_MAX);
    expect(delayed[0]!.opts.delay).toBe(syncCfg.requeueDelayMs);
    expect(job.attemptsMade).toBe(0);
    expect(await prisma.anchorColdStartRun.count()).toBe(0);
  });

  it('⑳ retry 耗尽 ⇒ 落 retry_exhausted (带 failedReason); 同一出口对**维度 job** 零副作用', async () => {
    await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    const job = await syncQueue.enqueueColdStart({ anchorId: String(anchorId), ticker: TICKER });
    // 「有限次 + 退避」这两个词就落在这三格上 (密集重试只会再撞同一个限频窗)。
    expect(job.opts.attempts).toBe(ANCHOR_COLD_START_RETRY_MAX);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 60_000 });

    await worker.onJobFailed(job.id!, 'boom: vendor 503');

    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    // 「做了但失败」—— 与「今天本就不该做」两两互异 (FR-027 零折叠), 处置完全相反。
    expect(run.outcome).toBe(COLD_START_OUTCOME.RETRY_EXHAUSTED);
    expect(run.reason).toContain('boom: vendor 503');

    // 反例: 同一个 `QueueEvents('failed')` 出口也会收到维度 job 的失败 —— 那张表不归它们碰。
    const dimJob = await syncQueue.enqueueDimensionJob(dimensionPayload, { retryMax: 3 });
    await worker.onJobFailed(dimJob.id!, 'boom: 维度 job 也失败了');

    expect(await prisma.anchorColdStartRun.count()).toBe(1);
  });

  it('⑰ 冷启动整体失败 ⇒ 锚保持成功, 且不阻塞另一只锚 (结局各记各的, 互不覆盖)', async () => {
    const a = await seedUnderlying(TICKER);
    const b = await seedUnderlying(TICKER_B);
    const anchorA = await createAnchorFor(TICKER);
    const anchorB = await createAnchorFor(TICKER_B);
    await seedTargetDayData(a.instrumentId);
    await seedTargetDayData(b.instrumentId);

    const jobA = await syncQueue.enqueueColdStart({ anchorId: String(anchorA), ticker: TICKER });
    await worker.onJobFailed(jobA.id!, 'A 的链发现炸了');

    // 锚是 optionsdesk 侧**已提交**的事务, 冷启动是它的下游异步副作用 ⇒ 补数失败 MUST NOT
    // 反向回滚锚 (谁给这条路径加补偿删除, 这里立刻红)。
    expect(await prisma.anchor.count()).toBe(2);
    expect(await prisma.anchor.findUnique({ where: { id: anchorA } })).not.toBeNull();

    const resultB = await coldStart.run({
      anchorId: anchorB,
      ticker: TICKER_B,
      now: SAT_NIGHT,
      phase: 'snapshot',
    });

    expect(resultB).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });
    const runs = await prisma.anchorColdStartRun.findMany({ orderBy: { anchorId: 'asc' } });
    expect(runs.map((r) => [r.ticker, r.outcome])).toEqual([
      [TICKER, COLD_START_OUTCOME.RETRY_EXHAUSTED],
      [TICKER_B, COLD_START_OUTCOME.BACKFILLED],
    ]);
  });

  it('⑱ 冷启动 job 与维度 job 落在**同一条队列**上 (concurrency=1 串行限频的前提)', async () => {
    await syncQueue.enqueueDimensionJob(dimensionPayload, { retryMax: 3 });
    await syncQueue.enqueueColdStart({ anchorId: '1', ticker: TICKER });

    const jobs = await syncQueue.queue.getJobs(['waiting', 'delayed', 'prioritized']);

    // 🚨 「不并发」这件事本身由 worker 的 `concurrency=1` 保证, 而那个保证的**前提**是两类
    //    job 在同一条队列上 —— 给冷启动另起一条队列的那一刻并发就回来了 (冷启动与夜间批同时
    //    打 vendor, 直接撞限频), 且不会有任何单测红。本层验的正是这个前提。
    expect(jobs.map((j) => j.name).sort()).toEqual(
      [ANCHOR_COLD_START_JOB, dimensionJobName('option_contract')].sort(),
    );
    expect(new Set(jobs.map((j) => j.queueQualifiedName)).size).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 结局面 (FR-026 / FR-027, SC-009)
  // ───────────────────────────────────────────────────────────────────────────

  it('🚨 FR-027a 链跑完但该票零合约 ⇒ backfill_incomplete, MUST NOT 记成 backfilled', async () => {
    // 2026-08-17 本地真跑实撞的形态: 链 job **completed** (per-target 失败不让 job 失败,
    // 故 `failParentOnFailure` 够不着), 但该标的一个合约都没落 ⇒ 第二相拿着空工作集跑,
    // `SyncOptionSnapshotUseCase` 判「无未到期合约」WARN + 零外呼返回, 一切"正常"。
    const { instrumentId } = await seedUnderlying(TICKER, { withContract: false });
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId); // 日线在, 只缺合约

    const result = await coldStart.run({
      anchorId,
      ticker: TICKER,
      now: SAT_NIGHT,
      phase: 'snapshot',
    });

    // 🚨 期权 EOD 无跨日补救 ⇒ 这是**永久缺口**。记成 backfilled 会让唯一能发现它的那条
    //    按结局分组的查询失明 —— 而运维最想抓的恰恰是「新锚没补上」。
    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILL_INCOMPLETE });
    expect(await prisma.optionDailySnapshot.count()).toBe(0);
    // 零合约 ⇒ 连一次外呼都不该有 (WARN 早退在打 vendor 之前)。
    expect(port.calls).toHaveLength(0);
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.outcome).toBe(COLD_START_OUTCOME.BACKFILL_INCOMPLETE);
    // 「补哪一天没补上」是人工介入的第一手信息, 故 target_session 仍要落。
    expect(run.targetSession).not.toBeNull();
    expect(run.reason).toContain(TARGET);
  });

  it('🚨 ㉒ 九种结局在同一张表里同时在场、两两互异, 且**恰好**是值域全集 (零折叠)', async () => {
    const outcomeOf = async (anchorId: bigint): Promise<string> =>
      (await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } })).outcome;

    // ① already_present: 目标日数据已由常规轮落齐。
    const present = await seedUnderlying(TICKER);
    const anchorPresent = await createAnchorFor(TICKER);
    await seedTargetDayData(present.instrumentId, { snapshot: true });
    await coldStart.run({ anchorId: anchorPresent, ticker: TICKER, now: SAT_NIGHT });

    // ② backfilled: 休市档真采一次。
    const filled = await seedUnderlying(TICKER_B);
    const anchorFilled = await createAnchorFor(TICKER_B);
    await seedTargetDayData(filled.instrumentId);
    await coldStart.run({
      anchorId: anchorFilled,
      ticker: TICKER_B,
      now: SAT_NIGHT,
      phase: 'snapshot',
    });

    // ③ intraday_skipped: 同样的输入, 只把时刻换到连续竞价内。
    const anchorIntraday = await createAnchorFor('us:MO');
    await coldStart.run({
      anchorId: anchorIntraday,
      ticker: 'us:MO',
      now: MON_MIDSESSION,
      phase: 'snapshot',
    });

    // ④⑤⑥ 三种早退。
    const anchorHk = await createAnchorFor('hk:0700');
    await coldStart.run({ anchorId: anchorHk, ticker: 'hk:0700', now: SAT_NIGHT });
    const anchorJp = await seedRawAnchor('jp:7203');
    await coldStart.run({ anchorId: anchorJp, ticker: 'jp:7203', now: SAT_NIGHT });
    const anchorBare = await seedRawAnchor('PEP');
    await coldStart.run({ anchorId: anchorBare, ticker: 'PEP', now: SAT_NIGHT });

    // ⑦ retry_exhausted: 走 worker 的真出口。
    const anchorFailed = await createAnchorFor('us:XOM');
    const failedJob = await syncQueue.enqueueColdStart({
      anchorId: String(anchorFailed),
      ticker: 'us:XOM',
    });
    await worker.onJobFailed(failedJob.id!, 'boom');

    // ⑧ backfill_incomplete: 链跑完但该票零合约。
    const empty = await seedUnderlying('us:PM', { withContract: false });
    const anchorEmpty = await createAnchorFor('us:PM');
    await seedTargetDayData(empty.instrumentId);
    await coldStart.run({
      anchorId: anchorEmpty,
      ticker: 'us:PM',
      now: SAT_NIGHT,
      phase: 'snapshot',
    });

    // ⑨ calendar_missing: 放最后 —— 它要把日历删空。
    const anchorNoCal = await createAnchorFor('us:CVX');
    await prisma.tradingDay.deleteMany({ where: { market: 'us' } });
    await coldStart.run({ anchorId: anchorNoCal, ticker: 'us:CVX', now: SAT_NIGHT });

    const observed = [
      await outcomeOf(anchorPresent),
      await outcomeOf(anchorFilled),
      await outcomeOf(anchorIntraday),
      await outcomeOf(anchorHk),
      await outcomeOf(anchorJp),
      await outcomeOf(anchorBare),
      await outcomeOf(anchorFailed),
      await outcomeOf(anchorEmpty),
      await outcomeOf(anchorNoCal),
    ];

    // 🚨 判据是「同一张表里同时存在的 8 行, 值两两不同」—— 各分支各自断言自己那个常量是断不出
    //    折叠的 (两个分支落同一个值时, 两条单测各自照样绿)。折叠之后, 一条按结局分组的查询
    //    再也分不出「今天本就不该做」与「今天该做没做成」, 而这两件事的处置完全相反。
    expect(new Set(observed).size).toBe(observed.length);
    expect(new Set(observed)).toEqual(new Set(Object.values(COLD_START_OUTCOME)));
    expect(await prisma.anchorColdStartRun.count()).toBe(9);
  });

  it('🚨 ㉔ 删锚后以同一 ticker 重建 ⇒ 运行记录**两行** (PK 是 anchorId, 不是 ticker)', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const firstAnchor = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId, { snapshot: true });
    await coldStart.run({ anchorId: firstAnchor, ticker: TICKER, now: SAT_NIGHT });
    expect(await prisma.anchorColdStartRun.count()).toBe(1);

    await prisma.anchorChange.deleteMany({ where: { anchorId: firstAnchor } });
    await prisma.anchor.delete({ where: { id: firstAnchor } });
    const secondAnchor = await createAnchorFor(TICKER);
    expect(secondAnchor).not.toBe(firstAnchor);

    await coldStart.run({ anchorId: secondAnchor, ticker: TICKER, now: SAT_NIGHT });

    // 🚨 谁把这张表的 PK 写成 ticker, 第二次就会**覆盖**第一次 ⇒ 只有一行, 上一只锚的冷启动
    //    历史凭空消失。锚是可删可重建的, 运行记录跟着锚走。
    const runs = await prisma.anchorColdStartRun.findMany({ orderBy: { anchorId: 'asc' } });
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.anchorId)).toEqual([firstAnchor, secondAnchor]);
    expect(runs.every((r) => r.ticker === TICKER)).toBe(true);
  });
});
