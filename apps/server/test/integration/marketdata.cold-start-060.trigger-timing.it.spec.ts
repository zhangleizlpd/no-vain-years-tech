import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedStores } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { OutboxSubscriberRegistry } from '../../src/security/outbox/outbox-subscriber.registry';
import { MarketdataModule } from '../../src/marketdata/marketdata.module';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { CreateAnchorUseCase } from '../../src/optionsdesk/create-anchor.usecase';
import { AnchorColdStartUseCase } from '../../src/marketdata/anchor-cold-start.usecase';
import { AnchorColdStartSubscriber } from '../../src/marketdata/anchor-cold-start.subscriber';
import { COLD_START_OUTCOME } from '../../src/marketdata/anchor-cold-start.rules';
import {
  ANCHOR_COLD_START_JOB,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
} from '../../src/marketdata/marketdata-sync.queue';
import {
  SNAPSHOT_SOURCE_EOD,
  SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
} from '../../src/marketdata/sync-option-snapshot.usecase';
import {
  OPTION_SNAPSHOT_PORT,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
  type OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';

// 060 T010 冷启动 IT 上半: 触发链 / 时点归属 / 幂等 (FR-013, FR-015, FR-015a, SC-002, SC-003;
// spec state_branches ①②⑥⑦⑧⑨⑩⑲㉓)。
//
// ## 为什么必须要真 PG + 真 DI 容器
//
// 本文件验的四件事在 mock 上全部不成立, 且不会红、只会静默退化成平凡绿:
//   ① **目标交易日与 OI 归属日是两条真日历查询** —— 「≤ 已收盘上界的最大交易日」与「严格早于
//      目标日的最大交易日」都是 `trading_day` 上的倒序 limit-1。把它们 mock 掉等于把答案当入参
//      喂进去, 而 §D4 三种时点归属的**全部**价值就在这两条查询的结果上。
//   ② **起手复判的判据是「标的 + 交易日」的跨表存在性** —— `option_daily_snapshot ⋈
//      option_contract` 上按 `underlying_instrument_id` 的连接。㉓ 那条硬断言(见下)只有真表能验。
//   ③ **两端事件类型字面量相等钉不住于单测** —— 生产侧 (optionsdesk) 与消费侧 (marketdata)
//      各持一份副本、互不 import (plan §D1 的方向铁律)。单测里两边各自断言自己的常量, 二者
//      是否相等无从谈起; 只有让真事件穿过 `outbox_event.event_type` 才验得到。
//   ④ **DI 自注册** —— subscriber 是 `OnModuleInit` 自注册进平台层注册表的, 没装容器就没有它。
//
// ⇒ 存储从 `test/_support/isolated-db.ts` 的 `setupIsolatedStores()` 取 (共享 PG 的模板克隆 +
// 独立 Redis db, **禁自起 Testcontainers**)。
//
// ## 两处刻意的「非端到端」
//
// 1. **worker 不启动** (`MARKETDATA_WORKER_DISABLED` 置位): 本文件验的是编排判据, 不是 BullMQ
//    的调度。⇒ subscriber 投出的 `sync:anchor-cold-start` job 停在队列里供断言, 编排本身由本
//    文件**直调** `coldStart.run(...)` 驱动。
//    📌 issue #159 前这里是两相: 第一相组 flow 入队链/日线、第二相以 `phase: 'snapshot'` 当
//    parent 挂其上。链改直调采集本体后两相合一, `phase` 入参随之从 `run()` 删除。
// 2. **「链/日线已跑完」靠手工 seed**: 同上, child job 不会真跑, 故由 `seedTargetDayData()`
//    造出它们的产物。这一步造的是**数据形态**, 不是在替被测代码干活。
//
// ⚠️ **午休档 (state_branch ③) 不在这一层**: us 无午休, 而 hk 的午休档 066 T06 开通后才端到端
// 可达 —— 它已在**姊妹文件** `marketdata.cold-start-060.market-outcome.it.spec.ts` 的「066 T07」
// 段上提到 IT 层 (港股午休真锚路径), 另有 T001 (谓词层, 逐分钟断言) 与
// `anchor-cold-start.usecase.spec.ts` 的「第二相 —— 午休档」两层各钉一遍。本文件不重复。
describe('060 T010 冷启动触发 / 时点归属 / 幂等 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let coldStart: AnchorColdStartUseCase;
  let createAnchor: CreateAnchorUseCase;
  let registry: OutboxSubscriberRegistry;
  let subscriber: AnchorColdStartSubscriber;
  let syncQueue: MarketdataSyncQueue;
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
  /** 目标交易日 (周五) 与它的上一交易日 (周四) —— 后者是 `oi_as_of` 在 eod 路径上的答案。 */
  const TARGET = '2026-08-14';
  const DAY_BEFORE_TARGET = '2026-08-13';

  // ── 五个判别性时刻 (EDT = UTC-4)。每一个都落在 §D4 表的不同一行上 ──
  /** ET 周五 17:00 (北京周六 05:00): 目标 session 收盘当日的盘后 ⇒ `today === target`。 */
  const FRI_AFTER_CLOSE = new Date('2026-08-14T21:00:00Z');
  /** ET 周六 20:00 (北京周日 08:00): 典型休市 —— 钟点也在场外。 */
  const SAT_NIGHT = new Date('2026-08-16T00:00:00Z');
  /** ET 周六 12:00 (北京周日 00:00): **钟点在场内但那天没有场** —— 境内周末夜建锚的高发时刻。 */
  const SAT_MIDDAY = new Date('2026-08-15T16:00:00Z');
  /** ET 周一 06:00 (北京周一 18:00): 已进下一交易日盘前 ⇒ OI 已翻新。 */
  const MON_PREMARKET = new Date('2026-08-17T10:00:00Z');
  /** ET 周一 10:30 (北京周一 22:30): 连续竞价进行中。 */
  const MON_MIDSESSION = new Date('2026-08-17T14:30:00Z');

  const TICKER = 'us:PEP';
  const TICKER_B = 'us:KO';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);
  const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

  /**
   * test-local fake `OPTION_SNAPSHOT_PORT`: 请求的每个合约一行 + 标的自身一行 (spot 的来源)。
   * `calls` 就是「外呼次数」的观测面 —— 本文件多条断言的核心是它 **恒为 0**。
   *
   * 🚨 spot 128.40 < K 130 ⇒ PUT 虚值侧过得了落库前硬门 (`ask ≥ 内在价值 − 容差`);
   * 抄成期权价会让整批被拒, 于是「快照到底落没落库」根本走不到 (样板同 047 integrity IT)。
   */
  class RecordingSnapshotPort implements OptionSnapshotPort {
    readonly calls: OptionSnapshotQuery[] = [];
    asOf = new Date('2026-08-14T20:02:11Z');

    async getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
      this.calls.push({ ...query, contractCodes: [...query.contractCodes] });
      const owner = `US.${query.underlyingSymbol.split(':')[1]}`;
      const rows: OptionSnapshotRow[] = query.contractCodes.map((code) => quoteRow(code, owner));
      rows.push({
        ...quoteRow(owner, owner),
        isOption: false,
        underlyingCode: null,
        last: '128.40',
      });
      return { asOf: this.asOf, rows };
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
    // 🚨 worker 不启动 (见文件头「两处刻意的非端到端」①)。
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
    registry = moduleRef.get(OutboxSubscriberRegistry);
    subscriber = moduleRef.get(AnchorColdStartSubscriber);
    syncQueue = moduleRef.get(MarketdataSyncQueue);

    await prisma.tradingDay.createMany({
      data: TRADING_DAYS.map((d) => ({ market: 'us', date: dateOf(d) })),
      skipDuplicates: true,
    });
  }, 180_000);

  afterAll(async () => {
    delete process.env[MARKETDATA_WORKER_DISABLED];
    await moduleRef?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    port.calls.length = 0;
    await prisma.optionDailySnapshot.deleteMany({});
    await prisma.optionContract.deleteMany({});
    await prisma.dailyBar.deleteMany({});
    await prisma.anchorColdStartRun.deleteMany({});
    await prisma.anchorChange.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.instrument.deleteMany({});
    await prisma.outboxEvent.deleteMany({});
    await syncQueue.queue.obliterate({ force: true });
  });

  /** 标的 + 一条未到期合约 (到期日远在所有目标日之后 ⇒ 恒在工作集内)。 */
  async function seedUnderlying(ticker: string): Promise<{ instrumentId: bigint; code: string }> {
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
    await prisma.optionContract.create({
      data: {
        market: 'us',
        code: `US.${code}261218P130000`,
        root: code,
        underlyingInstrumentId: inst.id,
        expiryDate: dateOf('2026-12-18'),
        strikePrice: '130',
        optionType: 'PUT',
        isStandard: true,
      },
    });
    return { instrumentId: inst.id, code };
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

  /**
   * 造「第一相的链/日线 child 已跑完」的数据形态 (worker 不启动, 它们不会自己跑)。
   * `snapshot: true` 时连快照也落一行 —— 那是「常规采集轮已落齐」的形态。
   */
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

  /** 第二相 (敏感档) 写下的那一行快照。 */
  async function theSnapshotRow(): Promise<{ sessionDate: Date; source: string; oiAsOf: Date }> {
    const rows = await prisma.optionDailySnapshot.findMany({
      select: { sessionDate: true, source: true, oiAsOf: true },
    });
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 触发链 —— 事件契约两端的字面量相等 (plan §D1 欠 IT 的那一条) + 自注册
  // ───────────────────────────────────────────────────────────────────────────

  it('建锚 ⇒ outbox_event 落一行, 其 event_type 与 subscriber 认的字面量**逐字相等**', async () => {
    await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);

    const rows = await prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    // 🚨 两端各持一份字面量副本、互不 import (方向铁律) ⇒ 二者相等只能这样钉:
    //    让真事件穿过表, 拿消费侧认的 eventType 去对生产侧实际写下的值。
    expect(rows[0]!.eventType).toBe(subscriber.eventType);
    const envelope = rows[0]!.payload as { metadata: Record<string, unknown>; data: unknown };
    expect(envelope.data).toEqual({ anchorId: String(anchorId), ticker: TICKER });
    expect(envelope.metadata.producer_context).toBe('optionsdesk');
    // 事件未分发 ⇒ published_at 仍空 (relay 是另一条线, 本文件手工 dispatch)。
    expect(rows[0]!.publishedAt).toBeNull();
  });

  it('该事件交给 registry.dispatch ⇒ 队列多一个 sync:anchor-cold-start job (subscriber 已自注册)', async () => {
    await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    const event = await prisma.outboxEvent.findFirstOrThrow();
    const envelope = event.payload as unknown as { data: Record<string, unknown> };

    // dispatch 按 eventType 找 subscriber —— 没自注册的话这里是 no-op, 队列恒空。
    await registry.dispatch(event.eventType, {
      sourceEventId: event.id,
      data: envelope.data,
    });

    const jobs = await syncQueue.queue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(jobs.map((j) => j.name)).toEqual([ANCHOR_COLD_START_JOB]);
    expect(jobs[0]!.data).toEqual({ anchorId: String(anchorId), ticker: TICKER });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 分档执行 + 时点归属 (§D4 三行)
  // ───────────────────────────────────────────────────────────────────────────

  it('① 休市建锚 ⇒ **一次调用**直达终局: 链与快照顺序跑完, 归属日 = 最近一个已收盘交易日', async () => {
    await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);

    const result = await coldStart.run({ anchorId, ticker: TICKER, now: SAT_NIGHT });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });

    // 🚨 **本用例最要紧的一格** (issue #159): 队列必须是空的。改直调前这里会留下三个 job
    //    (parent 第二相 + `sync:option_contract` + `sync:us_equity_bar`), 而那两个 child
    //    是**维度级**的 —— 执行侧载全部已开闸标的, 每建一只锚就把所有标的的链重下一遍。
    //    prod 实证 93 只锚跑了 59 小时, 其中 90% 是零写入的重复外呼。
    const queued = await syncQueue.queue.getJobs([
      'waiting',
      'waiting-children',
      'delayed',
      'prioritized',
    ]);
    expect(queued).toHaveLength(0);

    const row = await theSnapshotRow();
    expect(dayOf(row.sessionDate)).toBe(TARGET);
    expect(row.source).toBe(SNAPSHOT_SOURCE_EOD);
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.outcome).toBe(COLD_START_OUTCOME.BACKFILLED);
    expect(dayOf(run.targetSession!)).toBe(TARGET);
  });

  it('⑧ 目标 session 收盘当日的盘后 ⇒ session_date = 当天, source = eod, oi_as_of = 上一交易日', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId);

    await coldStart.run({ anchorId, ticker: TICKER, now: FRI_AFTER_CLOSE });

    const row = await theSnapshotRow();
    expect(dayOf(row.sessionDate)).toBe(TARGET);
    expect(row.source).toBe(SNAPSHOT_SOURCE_EOD);
    // 🚨 `oi_as_of` 与 `session_date` MUST NOT 抹平: 两条路径产出的 OI 差一天, 而活跃度排名
    //    与 UI 的 asOf 都读它。抹平后永远不会红。
    expect(dayOf(row.oiAsOf)).toBe(DAY_BEFORE_TARGET);
  });

  it('⑨ 已进下一交易日盘前 ⇒ session_date 仍是上一交易日, 但 source = premarket_backfill, oi_as_of 翻新', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId);

    await coldStart.run({ anchorId, ticker: TICKER, now: MON_PREMARKET });

    const row = await theSnapshotRow();
    expect(dayOf(row.sessionDate)).toBe(TARGET);
    expect(row.source).toBe(SNAPSHOT_SOURCE_PREMARKET_BACKFILL);
    // 盘前窗内 OI 已翻新 ⇒ 归目标日本身, 而不是它的上一交易日。
    expect(dayOf(row.oiAsOf)).toBe(TARGET);
  });

  it('⑩ 目标日之后是非交易日 (周末白天) ⇒ 仍取 eod 口径, MUST NOT 误判为盘前兜底, 更不是盘中', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId);

    // 🚨 SAT_MIDDAY 的钟点 (ET 12:00) 落在连续竞价区间内, 而那天根本没有场。盘中闸若只看
    //    时钟不看日历, 这里会落 intraday_skipped ⇒ 快照永久缺失 (impl 期实撞, 见 T006 注)。
    const result = await coldStart.run({
      anchorId,
      ticker: TICKER,
      now: SAT_MIDDAY,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });
    const row = await theSnapshotRow();
    expect(dayOf(row.sessionDate)).toBe(TARGET);
    expect(row.source).toBe(SNAPSHOT_SOURCE_EOD);
    expect(dayOf(row.oiAsOf)).toBe(DAY_BEFORE_TARGET);
  });

  it('🚨 ② 盘中 ⇒ intraday_skipped, option_daily_snapshot 计数**零变化**, vendor 零外呼 (SC-002)', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId);
    const before = await prisma.optionDailySnapshot.count();

    const result = await coldStart.run({
      anchorId,
      ticker: TICKER,
      now: MON_MIDSESSION,
    });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED });
    expect(await prisma.optionDailySnapshot.count()).toBe(before);
    expect(port.calls).toHaveLength(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 起手复判 / 幂等
  // ───────────────────────────────────────────────────────────────────────────

  it('⑦ 该交易日的数据已由常规采集轮落齐 ⇒ already_present, 零外呼、零新增行', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId, { snapshot: true });
    const before = await prisma.optionDailySnapshot.count();

    const result = await coldStart.run({ anchorId, ticker: TICKER, now: SAT_NIGHT });

    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.ALREADY_PRESENT });
    expect(port.calls).toHaveLength(0);
    expect(await prisma.optionDailySnapshot.count()).toBe(before);
    // 零外呼也**不**意味着零留痕: 结局仍要落, 否则「未支持」与「已具备」事后分不开。
    const run = await prisma.anchorColdStartRun.findUniqueOrThrow({ where: { anchorId } });
    expect(run.outcome).toBe(COLD_START_OUTCOME.ALREADY_PRESENT);
  });

  it('🚨 ㉓ 数据在库但运行记录被清空 ⇒ 仍 already_present + 零外呼 (复判判据是「标的+交易日」)', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId, { snapshot: true });

    // 先跑一次让它写下运行记录, 再**只**把那一行删掉 —— 数据仍在。
    await coldStart.run({ anchorId, ticker: TICKER, now: SAT_NIGHT });
    await prisma.anchorColdStartRun.deleteMany({});
    expect(await prisma.anchorColdStartRun.count()).toBe(0);
    port.calls.length = 0;

    const result = await coldStart.run({ anchorId, ticker: TICKER, now: SAT_NIGHT });

    // 🚨 谁把复判写成「读运行记录判这只锚做过没有」, 删掉那一行之后就会判「没做过」⇒ 外呼 ⇒ 红。
    //    今天两种写法等价, 但锚一旦按用户区分, 同一标的的 N 只锚会各判「没做过」⇒ 同一份
    //    标的级共享数据被拉 N 遍。
    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.ALREADY_PRESENT });
    expect(port.calls).toHaveLength(0);
  });

  it('⑥ 同一次建锚的请求被重复投递 ⇒ 第二次零外呼、零新增数据行', async () => {
    const { instrumentId } = await seedUnderlying(TICKER);
    const anchorId = await createAnchorFor(TICKER);
    await seedTargetDayData(instrumentId);

    await coldStart.run({ anchorId, ticker: TICKER, now: SAT_NIGHT });
    const afterFirst = await prisma.optionDailySnapshot.count();
    expect(afterFirst).toBe(1);
    expect(port.calls).toHaveLength(1);
    port.calls.length = 0;

    // 重投 = 从第一相重跑 (relay at-least-once; 本片蓄意不做 sourceEventId 去重)。
    const again = await coldStart.run({ anchorId, ticker: TICKER, now: SAT_NIGHT });

    expect(again).toEqual({ settled: true, outcome: COLD_START_OUTCOME.ALREADY_PRESENT });
    expect(port.calls).toHaveLength(0);
    expect(await prisma.optionDailySnapshot.count()).toBe(afterFirst);
  });

  it('⑲ 连续建两只同市场的锚 ⇒ 各自一行运行记录 (无合流); 全集 delta 落齐后第二只零外呼', async () => {
    const a = await seedUnderlying(TICKER);
    const b = await seedUnderlying(TICKER_B);
    const anchorA = await createAnchorFor(TICKER);
    const anchorB = await createAnchorFor(TICKER_B);

    await seedTargetDayData(a.instrumentId);
    await coldStart.run({ anchorId: anchorA, ticker: TICKER, now: SAT_NIGHT });
    expect(port.calls).toHaveLength(1);
    port.calls.length = 0;

    // A 入队的链/日线是**全集** delta (蓄意不给 codes 收窄字段) ⇒ 它跑完时 B 的数据也齐了。
    // worker 不启动, 故这里手工造出那个产物形态。
    await seedTargetDayData(b.instrumentId, { snapshot: true });
    const resultB = await coldStart.run({ anchorId: anchorB, ticker: TICKER_B, now: SAT_NIGHT });

    expect(resultB).toEqual({ settled: true, outcome: COLD_START_OUTCOME.ALREADY_PRESENT });
    expect(port.calls).toHaveLength(0);
    // 各自触发各自执行: 两只锚两行, 结局各不相同 (无合流机制)。
    const runs = await prisma.anchorColdStartRun.findMany({ orderBy: { anchorId: 'asc' } });
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.anchorId))).toEqual(new Set([anchorA, anchorB]));
    expect(runs.map((r) => r.outcome).sort()).toEqual(
      [COLD_START_OUTCOME.ALREADY_PRESENT, COLD_START_OUTCOME.BACKFILLED].sort(),
    );
  });
});
