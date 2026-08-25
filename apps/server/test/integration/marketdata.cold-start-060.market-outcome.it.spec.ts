import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
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
import { SyncOptionContractUseCase } from '../../src/marketdata/sync-option-contract.usecase';
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
//   ② **结局的零折叠 (㉒)** —— 判据是「同一张表里十种取值同时在场且两两互异」。单测里各分支
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

  // ── 066 T06 港股分支的时刻 (hk 时区 = UTC+8, 无 DST ⇒ 换算是加 8 小时) ──
  //
  // 🚨 港股与美股**共用同一份 TRADING_DAYS / TARGET**: 两个市场在这一周的交易日恰好相同,
  // 而 hk 的日历行由 `beforeEach` 单独 seed (`market: 'hk'`) —— 共用的是**日期集合**, 不是行。
  /** HKT 周日 08:00 (= 北京周日 08:00): 港股休市 —— 敏感档可写, 目标日 = 上周五。 */
  const HK_SUN_MORNING = new Date('2026-08-16T00:00:00Z');
  /** HKT 周一 10:30: 港股连续竞价进行中 (066 T07 verify ①)。 */
  const HK_MON_MIDSESSION = new Date('2026-08-17T02:30:00Z');
  /** HKT 周一 12:30: 港交所**午休正中** —— 单段登记 `[09:30,16:00]` 下仍判「该场进行中」。 */
  const HK_MON_LUNCH_BREAK = new Date('2026-08-17T04:30:00Z');
  const HK_TICKER = 'hk:00700';

  /** market → 富途 code 前缀 (fake 端口造 owner 行用; 真表在各 adapter 的 `MARKET_TO_FUTU_PREFIX`)。 */
  const FUTU_PREFIX: Record<string, string> = { us: 'US', hk: 'HK' };

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
      // vendor 的标的 code 带市场前缀 (`US.PEP` / `HK.00700`) —— 期权行靠 `underlyingCode`
      // 关联它取 spot, 故本 fake 只需与被请求 symbol 的市场自洽 (066 T06 起港股也走这条路)。
      const [market, symbol] = query.underlyingSymbol.split(':');
      const owner = `${FUTU_PREFIX[market!] ?? 'US'}.${symbol}`;
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
    // 日历**每例重建**: ⑪ 与 066 T07 的港股版都要把它删空, 别让那两例污染后面的用例。
    await prisma.tradingDay.deleteMany({ where: { market: { in: ['us', 'hk'] } } });
    await prisma.tradingDay.createMany({
      data: ['us', 'hk'].flatMap((market) =>
        TRADING_DAYS.map((d) => ({ market, date: dateOf(d) })),
      ),
      skipDuplicates: true,
    });
  });

  /**
   * 标的 + 一条未到期合约。到期日**远**在所有用例之后 —— 本文件有一例走真实钟点
   * (㉑ 的 worker 出口), 到期日贴着今天会让它某天突然采不到合约。
   */
  async function seedUnderlying(
    ticker: string,
    opts: { withContract?: boolean; strike?: string } = {},
  ): Promise<{ instrumentId: bigint; code: string }> {
    // 066 T06: market 从 ticker 里取, **不再写死 us** —— 港股分支要的是真 `market='hk'` 的行
    // (冷启动全程按 `market:code` 走, 拿一只挂着 us 的假港股票验等于验了另一件事)。
    const [market, code] = ticker.split(':') as [string, string];
    const inst = await prisma.instrument.create({
      data: {
        market,
        code,
        name: `${code} Inc.`,
        type: 'stock',
        currency: market === 'hk' ? 'HKD' : 'USD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });
    // `withContract: false` = 该标的在库里**一个期权合约都没有** —— 066 FR-014a 起这就是
    // `no_option_chain` 的判据 (港股常态)。
    if (opts.withContract === false) return { instrumentId: inst.id, code };
    // `strike` 可覆盖: 默认 130 (spot 128.40 ⇒ PUT 虚值侧, 过得了落库前硬门); 传一个深实值
    // 的行权价 (如 200 ⇒ 内在价值 71.60 ≫ ask 2.40) 会让整批被硬门拒 ⇒ 有合约但零快照。
    const strike = opts.strike ?? '130';
    await prisma.optionContract.create({
      data: {
        market,
        code: `${FUTU_PREFIX[market]}.${code}301220P${strike}000`,
        root: code,
        underlyingInstrumentId: inst.id,
        expiryDate: dateOf('2030-12-20'),
        strikePrice: strike,
        optionType: 'PUT',
        isStandard: true,
      },
    });
    return { instrumentId: inst.id, code };
  }

  /**
   * 造一个**没有对应锚行**的 anchorId, 供「写侧闸不肯造」的 ticker (不受支持市场 / 非 canonical
   * 写法) 驱动冷启动的 fail-closed 早退。
   *
   * 🚨 为什么不种锚行: `AnchorColdStartUseCase.run({anchorId, ticker, now})` 的 **ticker 是入参**,
   *    全程不读 `optionsdesk.anchor`; 而 `marketdata.anchor_cold_start_run.anchor_id` 是**裸 PK
   *    无 FK** (ADR-0062 护城河: 跨 schema 禁 FK) ⇒ 这几例本就不需要锚行。传个 bigint 反而更贴合
   *    真实契约 —— 冷启动的输入是**事件载荷里的 ticker 串**, 它必须对任何取值都留痕早退, 不能
   *    靠「上游不会给」。
   * 🚨 065 T03 起这也成了唯一可行的写法: `optionsdesk.anchor.market` 收紧为 NOT NULL +
   *    `ck_anchor_market` CHECK ('us','hk') ⇒ jp / cn / 无冒号那几只**在 DB 层根本存不下**。
   * 🚫 MUST NOT 改回种行、拿 `market: 'us'` 去凑 CHECK —— 那种 ticker 是 jp 而 market 是 us 的行
   *    既过编译又过 CHECK、测试照样全绿, 却把 T03 刚立起来的 FR-013 不变式 (market 恒等于 ticker
   *    的 market 段) 在测试代码里第一时间弄脏, 而**没有任何断言会红**。
   * 🚫 也 MUST NOT 图省事写死一个常量: `anchor_cold_start_run` 的 PK 是 anchorId, 同一用例内两只
   *    票撞同一个 id 会让第二行 upsert 覆盖第一行 (㉒ 的「九行同时在场」当场变八行)。
   * ⚠️ 起点取远离自增序列的 900_000 —— 与 `createAnchorFor` 建出的真锚 id 不撞, 且排在它们之后
   *    (多处按 anchorId 升序断言 ticker 序列, 依赖这个先后)。
   */
  let nextOrphanAnchorId = 900_000n;
  const orphanAnchorId = (): bigint => nextOrphanAnchorId++;

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
    const anchorId = orphanAnchorId();

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
    const anchorId = orphanAnchorId();

    const result = await coldStart.run({ anchorId, ticker: 'jp:7203', now: SAT_NIGHT });

    // 时段没登记 ⇒ 判不了「此刻是不是盘中」⇒ 宁可不写。**不是**静默跳过: 留痕才分得清
    // 「今天本就不该做」与「该做没做成」。
    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.SESSION_UNREGISTERED });
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.reason).toContain('jp');
    expect(port.calls).toHaveLength(0);
    expect(await prisma.instrument.count()).toBe(0);
  });

  it('⑭ cn (登记了时段但压根没登记能力) ⇒ market_not_enabled, 留痕、零外呼', async () => {
    // 📌 066 T06 之前这条还带着 hk (「登记了时段但能力空表项」) 作对照 —— hk 开通后这一档
    //    只剩 cn 够得到。「hk 不再落这一档」由下面的 T06 港股段正面钉。
    const cn = orphanAnchorId();

    const cnResult = await coldStart.run({ anchorId: cn, ticker: 'cn:600519', now: SAT_NIGHT });

    // 「压根没考虑过」也**留痕**, 不静默 no-op。
    expect(cnResult).toEqual({ settled: true, outcome: COLD_START_OUTCOME.MARKET_NOT_ENABLED });
    const runs = await prisma.anchorColdStartRun.findMany({ orderBy: { anchorId: 'asc' } });
    expect(runs.map((r) => r.ticker)).toEqual(['cn:600519']);
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

    // 本例只有锚、没有任何合约行 ⇒ 链 (IT 里是 no-op 端口) 采不到东西, 快照于是零外呼。
    // 📌 结局值经历过两次变更, 都**不是**本用例的验收点 (它验的是 seed→开闸 次序):
    //    · issue #159 前 = `awaiting_chain` (第一相组完 flow 就交回, 结局要等第二相);
    //    · #159 两相合一后 = `backfill_incomplete` (一次调用直达终局);
    //    · 066 T05 起 = `no_option_chain` —— 分岔判据是**库里的期权合约计数**, 而本例这只
    //      标的是刚被兜底 seed 出来的、零合约 ⇒ 落「本就没有可做的」这一档 (FR-014a)。
    //      美股这条路径的归属确实变了, 是 T05 判据的必然推论、已知并接受: 真撞上多半意味着
    //      链发现对该 target 失败了, 而那条由链维度自己的 `alertIfDegraded` 告警。
    expect(result).toEqual({
      settled: true,
      outcome: COLD_START_OUTCOME.NO_OPTION_CHAIN,
    });
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

  // ── 066 T05 `no_option_chain` 与 `backfill_incomplete` 的分岔 (FR-013 / FR-014 / FR-014a) ──
  //
  // 两条用例是**一对**, 缺一条另一条就证不了零折叠: 单独断「零合约落 no_option_chain」不排除
  // 「有合约但没补上」也落了同一个值。判据是库里的期权合约计数, 不是采集统计量 —— 后者在
  // 「有合约但整批被落库前硬门拒」时同样为空, 两件事会被混成一个。
  //
  // ⚠️ 这里用 `us:` 标的驱动, 因为**判据本身与市场无关**, 而港股在 T06 之前还走不到第二相
  //    (`isColdStartEnabled('hk')` 在第 1c 步就返回 `market_not_enabled`)。港股端到端那一档
  //    由 T06 起在本文件补港股分支、由 T15 在真锚上收口。

  it('🚨 FR-014 该标的零期权合约 ⇒ no_option_chain, 且**不产生 ERROR 级日志** (SC-011 前半)', async () => {
    // 港股绝大多数标的是这个形态 (实测颐海国际 0 / 网龙 0 个到期日) —— 既不是故障也无从处理。
    const { instrumentId } = await seedUnderlying(TICKER, { withContract: false });
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId); // 日线在, 只是这只票压根没有期权

    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const result = await coldStart.run({
        anchorId,
        ticker: TICKER,
        now: SAT_NIGHT,
      });
      expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.NO_OPTION_CHAIN });
      // 🚨 这条才是本档存在的理由: 折进 backfill_incomplete 会让每一只无期权的锚都产出一条
      //    ERROR 级、需人工介入的记录, 而那件事既不是故障也无从处理。
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }

    expect(await prisma.optionDailySnapshot.count()).toBe(0);
    // 零合约 ⇒ 连一次外呼都不该有 (WARN 早退在打 vendor 之前)。
    expect(port.calls).toHaveLength(0);
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.outcome).toBe(COLD_START_OUTCOME.NO_OPTION_CHAIN);
    // 终态也要能读出「补的是哪一天」—— 运维按结局分组时同一张表两列一起看。
    expect(run.targetSession).not.toBeNull();
    expect(run.reason).toContain('无挂牌期权');
  });

  it('🚨 FR-013 有合约但整批被落库前硬门拒 ⇒ backfill_incomplete + **产生** ERROR (SC-011 后半)', async () => {
    // 行权价 200 的 PUT 对 spot 128.40 是深实值 ⇒ 内在价值 71.60 ≫ ask 2.40 ⇒ 无套利下界
    // 硬门拒整批。这是 `BACKFILL_INCOMPLETE` 两条到达路径里的第二条 (Edge Case 2)。
    const { instrumentId } = await seedUnderlying(TICKER, { strike: '200' });
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId); // 日线在, 合约也在, 只是快照落不下去

    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const result = await coldStart.run({
        anchorId,
        ticker: TICKER,
        now: SAT_NIGHT,
      });
      // 🚨 期权 EOD 无跨日补救 ⇒ 这是**永久缺口**。记成 backfilled 会让唯一能发现它的那条
      //    按结局分组的查询失明 —— 而运维最想抓的恰恰是「新锚没补上」。
      expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILL_INCOMPLETE });
      // ERROR 级 = 需人工介入。与上一条用例的 `not.toHaveBeenCalled()` 成对, 缺任一条都证不了
      // 「两者告警面可分」。
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }

    expect(await prisma.optionDailySnapshot.count()).toBe(0);
    // 有合约 ⇒ 确实打了 vendor 一次 (与零合约那条的零外呼互为对照)。
    expect(port.calls).toHaveLength(1);
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.outcome).toBe(COLD_START_OUTCOME.BACKFILL_INCOMPLETE);
    // 「补哪一天没补上」是人工介入的第一手信息, 故 target_session 仍要落。
    expect(run.targetSession).not.toBeNull();
    expect(run.reason).toContain(TARGET);
  });

  it('🚨 两者可由 `outcome` 列直接分开统计 —— 零折叠 (SC-011 末句)', async () => {
    const none = await seedUnderlying(TICKER, { withContract: false });
    const anchorNone = await createAnchorFor(TICKER);
    await seedTargetDayData(none.instrumentId);
    const rejected = await seedUnderlying(TICKER_B, { strike: '200' });
    const anchorRejected = await createAnchorFor(TICKER_B);
    await seedTargetDayData(rejected.instrumentId);

    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await coldStart.run({
        anchorId: anchorNone,
        ticker: TICKER,
        now: SAT_NIGHT,
      });
      await coldStart.run({
        anchorId: anchorRejected,
        ticker: TICKER_B,
        now: SAT_NIGHT,
      });
    } finally {
      errorSpy.mockRestore();
    }

    // 🚨 判据是「同一张表里两行、值不同」—— 各自断言自己那个常量是断不出折叠的
    //    (两条路径落同一个值时, 两条单测各自照样绿)。
    const byOutcome = await prisma.anchorColdStartRun.groupBy({
      by: ['outcome'],
      _count: { _all: true },
      orderBy: { outcome: 'asc' },
    });
    expect(byOutcome).toEqual([
      { outcome: COLD_START_OUTCOME.BACKFILL_INCOMPLETE, _count: { _all: 1 } },
      { outcome: COLD_START_OUTCOME.NO_OPTION_CHAIN, _count: { _all: 1 } },
    ]);
  });

  it('🚨 ㉒ 十种结局在同一张表里同时在场、两两互异, 且**恰好**是值域全集 (零折叠)', async () => {
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
    });

    // ③ intraday_skipped: 同样的输入, 只把时刻换到连续竞价内。
    const anchorIntraday = await createAnchorFor('us:MO');
    await coldStart.run({
      anchorId: anchorIntraday,
      ticker: 'us:MO',
      now: MON_MIDSESSION,
    });

    // ④⑤⑥ 三种早退。
    // 📌 `market_not_enabled` 的驱动方 066 T06 起从 hk 换成 cn —— hk 已开通, 再拿它当「未开通」
    //    的样本, 这一格会静默变成另一个结局, 而 `Set.size` 断言只会说「少了一种」不会说是谁。
    const anchorNotEnabled = orphanAnchorId();
    await coldStart.run({ anchorId: anchorNotEnabled, ticker: 'cn:600519', now: SAT_NIGHT });
    const anchorJp = orphanAnchorId();
    await coldStart.run({ anchorId: anchorJp, ticker: 'jp:7203', now: SAT_NIGHT });
    const anchorBare = orphanAnchorId();
    await coldStart.run({ anchorId: anchorBare, ticker: 'PEP', now: SAT_NIGHT });

    // ⑦ retry_exhausted: 走 worker 的真出口。
    const anchorFailed = await createAnchorFor('us:XOM');
    const failedJob = await syncQueue.enqueueColdStart({
      anchorId: String(anchorFailed),
      ticker: 'us:XOM',
    });
    await worker.onJobFailed(failedJob.id!, 'boom');

    // ⑧ backfill_incomplete: 有合约但整批被落库前硬门拒 (深实值 PUT, ask < 内在价值 − 容差)。
    const rejected = await seedUnderlying('us:PM', { strike: '200' });
    const anchorRejected = await createAnchorFor('us:PM');
    await seedTargetDayData(rejected.instrumentId);
    await coldStart.run({
      anchorId: anchorRejected,
      ticker: 'us:PM',
      now: SAT_NIGHT,
    });

    // ⑩ no_option_chain (066 FR-014): 该标的零期权合约 —— 与 ⑧ 同为「快照不在库」, 分岔判据
    //    是库里的合约计数。两者必须落**不同**的值, 否则按结局分组的查询分不出「本就没有可做
    //    的」与「该做没做成」。
    const noChain = await seedUnderlying('us:T', { withContract: false });
    const anchorNoChain = await createAnchorFor('us:T');
    await seedTargetDayData(noChain.instrumentId);
    await coldStart.run({
      anchorId: anchorNoChain,
      ticker: 'us:T',
      now: SAT_NIGHT,
    });

    // ⑨ calendar_missing: 放最后 —— 它要把日历删空。
    const anchorNoCal = await createAnchorFor('us:CVX');
    await prisma.tradingDay.deleteMany({ where: { market: 'us' } });
    await coldStart.run({ anchorId: anchorNoCal, ticker: 'us:CVX', now: SAT_NIGHT });

    const observed = [
      await outcomeOf(anchorPresent),
      await outcomeOf(anchorFilled),
      await outcomeOf(anchorIntraday),
      await outcomeOf(anchorNotEnabled),
      await outcomeOf(anchorJp),
      await outcomeOf(anchorBare),
      await outcomeOf(anchorFailed),
      await outcomeOf(anchorRejected),
      await outcomeOf(anchorNoChain),
      await outcomeOf(anchorNoCal),
    ];

    // 🚨 判据是「同一张表里同时存在的 8 行, 值两两不同」—— 各分支各自断言自己那个常量是断不出
    //    折叠的 (两个分支落同一个值时, 两条单测各自照样绿)。折叠之后, 一条按结局分组的查询
    //    再也分不出「今天本就不该做」与「今天该做没做成」, 而这两件事的处置完全相反。
    expect(new Set(observed).size).toBe(observed.length);
    expect(new Set(observed)).toEqual(new Set(Object.values(COLD_START_OUTCOME)));
    expect(await prisma.anchorColdStartRun.count()).toBe(10);
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

  // ───────────────────────────────────────────────────────────────────────────
  // 066 T06 港股冷启动开通 (FR-010 / FR-011 / FR-016 / FR-016a)
  //
  // 🚨 **本段的每一条在 T06 之前都够不到**: `isColdStartEnabled('hk')` 在第 1c 步就返回
  // `market_not_enabled` ⇒ 港股锚从来没走过第 2 步之后的任何一格。上面那批 `us:` 用例验的是
  // **判据本身**(与市场无关), 本段验的是**港股真的走得通那条路**。两者不可互相替代: 判据全对
  // 而能力表没开, 表现就是「一切正常, 只是港股锚永远什么都不补」, 而那**不报错**。
  //
  // 📌 链落库面**不在本层**: IT 里 `OPTION_CHAIN_PORT` 是 054 的拒绝壳 (调用即抛, 由
  //    `SyncOptionContractUseCase.collect` 逐 target catch 成 `stats.failed`) ⇒ 合约行由
  //    `seedUnderlying` 造出「链已跑完」的数据形态, 与上面 `us:` 那批同一套路。真链的端到端
  //    由 T15 在 prod 真锚上收口。
  // ───────────────────────────────────────────────────────────────────────────

  it('🚨 ①② 休市时段建港股锚 ⇒ 归属交易日的快照落库、结局 backfilled (不再 market_not_enabled)', async () => {
    const { instrumentId } = await seedUnderlying(HK_TICKER);
    const anchorId = await createAnchorFor(HK_TICKER);

    const result = await coldStart.run({
      anchorId,
      ticker: HK_TICKER,
      now: HK_SUN_MORNING,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    // 🚨 verify ①: 这一格是「开通了没有」唯一的可判读证据 —— 能力表没翻的话它恒为
    //    `market_not_enabled`, 而那条路径**零外呼、零落库、不报错**, 与「今天没数据」外观相同。
    expect(run.outcome).not.toBe(COLD_START_OUTCOME.MARKET_NOT_ENABLED);
    expect(run.targetSession?.toISOString().slice(0, 10)).toBe(TARGET);

    const snapshots = await prisma.optionDailySnapshot.findMany({
      where: { contract: { underlyingInstrumentId: instrumentId } },
    });
    expect(snapshots).toHaveLength(1);
    // 归属日 = 最近一个已收盘交易日 (HKT 周日 08:00 ⇒ 上周五), **不是**「今天」。
    expect(snapshots[0]!.sessionDate.toISOString().slice(0, 10)).toBe(TARGET);
    // 休市档 ⇒ OI 未翻新 ⇒ 走 eod 而非 premarket_backfill (§D4 第四行)。
    expect(snapshots[0]!.source).toBe(SNAPSHOT_SOURCE_EOD);
    // 🚨 `oi_as_of` = **目标日自己**, 不是它的上一交易日 —— 066 T09 的港股分叉 (`FR-016`)。
    //    U2 实测 (2026-08-25, 360 行样本) 证明港股 OI 在 D 日收盘当晚就已定稿, 「T 日的 OI
    //    要 T+1 才发布」只是美股清算所的行为。事实位登记在 `oiRefreshedAtEod`。
    //    📌 本行原本钉的是分叉**之前**的取值 (`DAY_BEFORE_TARGET`), 由 T06 刻意留着并注明
    //    「分叉是 T09 的事」—— 它按预期在 T09 这一轮转红, 是这条 IT 存在的意义之一。
    //    🚨 这里是**端到端**的那一格 (Testcontainers + 真 DI + 真落库): 三处派生里只有
    //    `collect` 真的写库, 纯函数层的单测全绿也盖不住它。
    expect(snapshots[0]!.oiAsOf?.toISOString().slice(0, 10)).toBe(TARGET);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.underlyingSymbol).toBe(HK_TICKER);
  });

  it('③ 归属交易日的港股快照已在库 ⇒ already_present, **零对外请求**', async () => {
    const { instrumentId } = await seedUnderlying(HK_TICKER);
    const anchorId = await createAnchorFor(HK_TICKER);
    await seedTargetDayData(instrumentId, { snapshot: true });

    const result = await coldStart.run({
      anchorId,
      ticker: HK_TICKER,
      now: HK_SUN_MORNING,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.ALREADY_PRESENT });
    // 起手复判在打 vendor **之前** —— 少了它, 每建一只锚都对已经采齐的日子再打一轮。
    expect(port.calls).toHaveLength(0);
    expect(
      await prisma.optionDailySnapshot.count({
        where: { contract: { underlyingInstrumentId: instrumentId } },
      }),
    ).toBe(1);
  });

  it('④ 港股建锚事务回滚 ⇒ 锚行与 outbox 行同生共死 ⇒ 冷启动**根本不被发起**', async () => {
    // `anchor.method` 是 VarChar(32) ⇒ 40 字符在 tx 内炸 (P2000), 回滚整个事务。
    await expect(
      createAnchor.execute({
        ticker: HK_TICKER,
        v: '50',
        asof: dateOf('2026-06-30'),
        method: 'x'.repeat(40),
        confidence: '8',
      }),
    ).rejects.toThrow();

    // 🚨 冷启动的**唯一**触发源是 outbox 行 —— 它留下来就等于给一只根本没建成的港股锚跑采集
    //    (Edge Case 9)。港股这一档与 us 的 ⑤ 同源, 但要单独钉: 建锚路径按 market 分岔过
    //    (`seedLastClose` 走 `EOD_BAR_PORT` 的市场路由), 一处对不代表另一处对。
    expect(await prisma.anchor.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.anchorColdStartRun.count()).toBe(0);
  });

  it('🚨 ⑤ 同一港股锚重复投递 ⇒ 第二次起零对外请求、零新增行 (Edge Case 10)', async () => {
    const { instrumentId } = await seedUnderlying(HK_TICKER);
    const anchorId = await createAnchorFor(HK_TICKER);

    const first = await coldStart.run({ anchorId, ticker: HK_TICKER, now: HK_SUN_MORNING });
    expect(first).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });
    expect(port.calls).toHaveLength(1);
    const rowsAfterFirst = await prisma.optionDailySnapshot.count({
      where: { contract: { underlyingInstrumentId: instrumentId } },
    });
    expect(rowsAfterFirst).toBe(1);

    const second = await coldStart.run({ anchorId, ticker: HK_TICKER, now: HK_SUN_MORNING });

    // 🚨 收敛靠的是**起手复判**, 不是去重表 (`FR-019c`: 零合流、零去重) —— 排队中的后续请求
    //    走到第 5 步判「已具备」而零外呼。判据错了的表现是每次重投都再打一轮 vendor, 而
    //    落库端 `skipDuplicates` 会让行数看起来一切正常。
    expect(second).toEqual({ settled: true, outcome: COLD_START_OUTCOME.ALREADY_PRESENT });
    expect(port.calls).toHaveLength(1);
    expect(
      await prisma.optionDailySnapshot.count({
        where: { contract: { underlyingInstrumentId: instrumentId } },
      }),
    ).toBe(rowsAfterFirst);
    // 运行记录 PK 是 anchorId ⇒ 第二次 upsert 覆盖同一行, 不多一行。
    expect(await prisma.anchorColdStartRun.count()).toBe(1);
  });

  it('🚨 ⑥ 无挂牌期权的港股标的 ⇒ no_option_chain 且**零 ERROR 级日志** (SC-011 前半的港股端)', async () => {
    // 港股绝大多数标的是这个形态 (实测颐海国际 0 / 网龙 0 个到期日) —— 与美股正好相反。
    // 上面 T05 那三条是用 `us:` 标的驱动的 (判据与市场无关); 本条补的是港股**端到端**面:
    // 能力表没开的话它落 `market_not_enabled`, 与本档同为「零外呼终态」却是完全不同的事。
    const { instrumentId } = await seedUnderlying(HK_TICKER, { withContract: false });
    const anchorId = await createAnchorFor(HK_TICKER);

    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const result = await coldStart.run({
        anchorId,
        ticker: HK_TICKER,
        now: HK_SUN_MORNING,
      });
      expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.NO_OPTION_CHAIN });
      // 折进 backfill_incomplete 会让**每一只**无期权的港股锚都产出一条无从处理的 ERROR ——
      // 而那正是港股的常态, 不是边角。
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }

    expect(port.calls).toHaveLength(0);
    expect(
      await prisma.optionDailySnapshot.count({
        where: { contract: { underlyingInstrumentId: instrumentId } },
      }),
    ).toBe(0);
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.reason).toContain('无挂牌期权');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 066 T07 冷启动的时段闸与放弃路径 (FR-012)
  //
  // 🚨 **本段零新增实现面** —— 四条分支的实现早就在 (`isSessionUnderway` 的盘中闸、日历三态的
  // 放弃路径、配额顺延), 只是**在港股上从未被执行过**: T06 之前 hk 在第 1c 步就 `market_not_
  // enabled` 早退, 这四格一个都够不到。⇒ 本段是把它们逐条钉住, 而**这四条错了都不报错**。
  //
  // 📌 verify ④「日历前瞻视野未覆盖 hk 的今天」**蓄意不在本层**: IT 里 `TRADING_CALENDAR_PORT`
  //    绑的是 Mock (周一~周五恒 `trading`), **恒不返 `unknown`** ⇒ 在这里写它只会得到一个恒真
  //    用例。它落在 `anchor-cold-start.usecase.spec.ts` 的「066 T07 … Edge Case 8」那条。
  // ───────────────────────────────────────────────────────────────────────────

  it('🚨 ① 港股连续竞价时段建锚 ⇒ 补链, 但**不写任何按交易日归属的快照** (state_branches 2)', async () => {
    const { instrumentId } = await seedUnderlying(HK_TICKER);
    const anchorId = await createAnchorFor(HK_TICKER);
    const chainSpy = vi.spyOn(moduleRef.get(SyncOptionContractUseCase), 'collect');

    try {
      const result = await coldStart.run({
        anchorId,
        ticker: HK_TICKER,
        now: HK_MON_MIDSESSION,
      });

      expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED });
      // 🚫 链**不受盘中判据约束** (FR-012): 合约的静态属性与交易日无关 ⇒ 盘中照补。
      //    盘中闸只管敏感档, 且落在第 7 步 —— 真正要写快照的那一刻。
      expect(chainSpy).toHaveBeenCalledTimes(1);
    } finally {
      chainSpy.mockRestore();
    }

    // 🚨 判据**不是**「午休/盘中取不到上一场的数据」, 而是「放行会写出一行标签错的脏数据」:
    //    此刻 §D4 算出的归属日恒为**上一个已收盘交易日**, 而拿到的是**今天的盘中态** ⇒ 那行
    //    按唯一键占位, 当晚正确的行反被挡掉 ⇒ 永久缺口。fail-closed: 宁可缺一场, 不可脏一场。
    expect(port.calls).toHaveLength(0);
    expect(
      await prisma.optionDailySnapshot.count({
        where: { contract: { underlyingInstrumentId: instrumentId } },
      }),
    ).toBe(0);
  });

  it('🚨 ② 港股**午休**时段建锚 ⇒ 判定同盘中, 一行快照都不写 (state_branches 3)', async () => {
    // 🚨 闸用的是 `isSessionUnderway`(**含午休**, 问「这一场收了没有」), MUST NOT 换成
    //    `isWithinTradingSession`(问「此刻能不能成交」, 午休返 false ⇒ 放行)。港股的单段登记
    //    `[09:30, 16:00]` 正是本条要的语义 —— **不需要也不允许**为它拆段。
    const { instrumentId } = await seedUnderlying(HK_TICKER);
    const anchorId = await createAnchorFor(HK_TICKER);

    const result = await coldStart.run({
      anchorId,
      ticker: HK_TICKER,
      now: HK_MON_LUNCH_BREAK,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED });
    expect(port.calls).toHaveLength(0);
    expect(
      await prisma.optionDailySnapshot.count({
        where: { contract: { underlyingInstrumentId: instrumentId } },
      }),
    ).toBe(0);
    // 终态不重试 ⇒ 这一格落错了那一场的快照**永久缺失** (常规轮当晚写的是当晚那一场)。
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.outcome).toBe(COLD_START_OUTCOME.INTRADAY_SKIPPED);
    expect(run.targetSession?.toISOString().slice(0, 10)).toBe(TARGET);
  });

  it('🚨 ③ 交易日历缺 hk 的行 ⇒ calendar_missing + ERROR (需人工介入), **不猜日期**', async () => {
    const { instrumentId } = await seedUnderlying(HK_TICKER);
    const anchorId = await createAnchorFor(HK_TICKER);
    // 只删 hk 的行 —— us 的还在, 证明「缺行」是按市场判的, 不是「表空了」。
    await prisma.tradingDay.deleteMany({ where: { market: 'hk' } });
    expect(await prisma.tradingDay.count({ where: { market: 'us' } })).toBeGreaterThan(0);

    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const result = await coldStart.run({
        anchorId,
        ticker: HK_TICKER,
        now: HK_SUN_MORNING,
      });
      expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.CALENDAR_MISSING });
      // ERROR 级 = 需人工介入 —— 与 `intraday_skipped`(「一切正常」) 分属两档, 不折叠。
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }

    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    // 🚨 猜一个日子 ⇒ 一批 session_date 标错的脏行, 比不补更难发现且要人工回删。
    //    「猜了没有」的可判读证据就是这一格: 定位不到就必须是 NULL。
    expect(run.targetSession).toBeNull();
    expect(run.reason).toContain('hk');
    expect(port.calls).toHaveLength(0);
    expect(
      await prisma.optionDailySnapshot.count({
        where: { contract: { underlyingInstrumentId: instrumentId } },
      }),
    ).toBe(0);
  });

  it('🚨 ⑤ 港股供应方配额耗尽 ⇒ 顺延、**不记失败**, 且已落的数据一行不动 (state_branches 7)', async () => {
    const { instrumentId } = await seedUnderlying(HK_TICKER);
    const anchorId = await createAnchorFor(HK_TICKER);
    // 造一份**别的交易日**已落的快照: 顺延路径 MUST NOT 碰它 (起手复判问的是 TARGET, 不命中)。
    const contract = await prisma.optionContract.findFirstOrThrow({
      where: { underlyingInstrumentId: instrumentId },
      select: { id: true },
    });
    await prisma.optionDailySnapshot.create({
      data: {
        contractId: contract.id,
        sessionDate: dateOf(DAY_BEFORE_TARGET),
        source: SNAPSHOT_SOURCE_EOD,
        quoteAsOf: new Date(`${DAY_BEFORE_TARGET}T08:31:07Z`),
        oiAsOf: dateOf('2026-08-12'),
        bid: '2.30',
        ask: '2.40',
        greeksComplete: true,
      },
    });
    port.failNextWith = new OptionSnapshotBudgetExhaustedError('IT 造的 429 (港股)');

    const result = await coldStart.run({
      anchorId,
      ticker: HK_TICKER,
      now: HK_SUN_MORNING,
    });

    // 🚫 顺延 ≠ 失败 (FR-018 / FR-019b): 落 `backfilled` 是谎 (什么都没采到), 落
    //    `retry_exhausted` 是冤 (还没开始重试) ⇒ 这张表此刻必须是空的。
    expect(result).toEqual({ settled: false, deferral: 'vendor_budget' });
    expect(await prisma.anchorColdStartRun.count()).toBe(0);
    expect(port.calls).toHaveLength(1);

    // 已落的那一行原样在场 —— 顺延不是回滚, 不许把已有数据当「半成品」清掉。
    const rows = await prisma.optionDailySnapshot.findMany({
      where: { contract: { underlyingInstrumentId: instrumentId } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionDate.toISOString().slice(0, 10)).toBe(DAY_BEFORE_TARGET);
  });
});
