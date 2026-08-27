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
import {
  EARNINGS_FORWARD_HORIZON_DAYS,
  SyncEarningsEventUseCase,
} from '../../src/marketdata/sync-earnings-event.usecase';
import { EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS } from '../../src/marketdata/earnings-calendar.port';
import type {
  EarningsCalendarEvent,
  EarningsCalendarPort,
  EarningsCalendarWindowQuery,
} from '../../src/marketdata/earnings-calendar.port';

// 047 T020 财报日历 PIT IT (FR-026/027/035a/035b, SC-006a)。
//
// ## 为什么**必须**要真 PG
//
// 本文件验的四件事在 mock 上全部**不成立**, 且不会红、只会静默退化成平凡绿:
//   ① **「不挂锚闸」只有在有真锚表可挂时才是个断言** —— 零锚照常跑并落库 (state_branch 22)
//      要能与另两个 per-code 维度的「零锚 ⇒ 零请求」形成对照, 前提是锚表 / `need_sync` 这条
//      真链路在场; 把 `instrument.findMany` mock 掉等于把工作集当入参喂进去, 什么都没验。
//   ② **FK 是一条真约束** —— 「`Instrument` 表外的标的被跳过且 FK 未破」(state_branch 23)
//      在 mock 里连能不能写进去都不知道: 那正是「为规避 FK 而改幂等键」这条禁令要防的事,
//      只有真库会在写错时把它顶回来。
//   ③ **PIT 三件套是三个真列** —— `first_seen_at` 不被改期重写、`prev_earnings_date` 落的是
//      旧日期、`date_changed_at` 落的是变更时刻, 且**改期是原地改不是插新行** (插新行会让
//      旧日期那条继续留在库里声称那天有财报)。这几条全是「库里最后长什么样」, 断言不到调用。
//   ④ **幂等是唯一键** —— `(instrument_id, earnings_date)` 上的冲突路径只有真 PG 有。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。不用 `setupEmptyDb()` —— 那个入口是给「自己跑 `migrate deploy`
// 并验证其产物」的文件用的 (本 feature 里 T009 已占); 本条要的是一个迁好的库。
//
// 装配 = 直接 new `DimensionExecutorRegistry` 打真 `PrismaService` (样板
// `optionsdesk-047.chain-sync.it.spec.ts` / `optionsdesk-045.anchor.it.spec.ts`)。
//
// 🚨 vendor 侧恒 mock (`RecordingEarningsCalendarPort`) —— 本文件是 hermetic Medium IT。
describe('047 T020 财报日历 PIT (Testcontainers PG, 市场级维度不挂锚闸)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let calendar: RecordingEarningsCalendarPort;

  /**
   * 两个业务日, **取美股业务日 A′ 而非上海日** (FR-036)。
   * `2026-06-12` 是**周五**: 北京时间已是周六 06:00, 而 ET 侧还停在周五 18:00 ——
   * 全局 `shanghaiToday` 会在这一刻判「周六非交易日」并把周五整批丢掉 (每周固定丢一次)。
   */
  const FRI = { now: new Date('2026-06-12T22:00:00Z'), us: '2026-06-12', shanghai: '2026-06-13' };
  const MON = { now: new Date('2026-06-15T22:00:00Z'), us: '2026-06-15', shanghai: '2026-06-16' };

  /** delta 入参; `asOf` 蓄意给**上海日** —— executor 必须自己按 us 时区求 A′, 不吃这个值。 */
  const deltaInput = (d: typeof FRI) => ({ mode: 'delta' as const, asOf: d.shanghai, now: d.now });

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);
  const dayOf = (d: Date | null): string | null =>
    d === null ? null : d.toISOString().slice(0, 10);

  /** 一条财报事件 (adapter 归一化后的形态)。 */
  function eventOf(
    symbol: string,
    earningsDate: string,
    over: Partial<EarningsCalendarEvent> = {},
  ): EarningsCalendarEvent {
    return {
      underlyingSymbol: symbol,
      earningsDate,
      pubType: 'BEFORE',
      periodText: 'Q2 2026',
      epsActual: null,
      epsPredict: '2.31',
      ...over,
    };
  }

  /**
   * test-local fake `EARNINGS_CALENDAR_PORT`: **记每一次窗请求的入参**, 按窗过滤持有的事件集。
   *
   * 🚨「零锚照常跑」必须是**真数请求次数** —— 「库里有那批行」是间接推断: 工作集空了、问了
   * 但返空、落库被挡掉, 三者在库侧长得不一样但都能凑出「有/没有行」, 只有数请求分得开
   * 「维度到底跑没跑」。同 T017 那条 `RecordingChainPort` 的立意, 方向相反。
   */
  class RecordingEarningsCalendarPort implements EarningsCalendarPort {
    readonly windowCalls: EarningsCalendarWindowQuery[] = [];
    /** 当前 vendor 侧的全市场事件集; 逐轮可整体替换 (模拟改期)。 */
    events: EarningsCalendarEvent[] = [];

    async getWindow(query: EarningsCalendarWindowQuery): Promise<EarningsCalendarEvent[]> {
      this.windowCalls.push({ ...query });
      return this.events.filter(
        (e) => e.earningsDate >= query.start && e.earningsDate <= query.end,
      );
    }
  }

  /**
   * 🚨 财报 use case 是构造器的**第 32 个位置参数**, 直接 new 装配时错位不会红、只会把端口
   * 注成别的东西。`anchorGate` 传**真实例**而非 stub —— 本文件要验的正是「锚表在场且为空时,
   * 本维度照样跑」, 把闸换成 stub 等于把被测对象抽掉。
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
      new AnchorDrivenSyncGate(prisma), // anchorGate (045 T015): **真闸**, 在场且为空
      undefined, // underlyingIv → 默认 null-object
      undefined, // usIndex → 默认 null-object
      undefined, // syncOptionContract → 默认真实例 + null-object 端口
      undefined, // syncOptionSnapshot → 默认真实例 + null-object 端口
      new SyncEarningsEventUseCase(calendar, prisma), // 047 T019 (尾部第 32 位)
    );
  }

  /**
   * 真 `Instrument` 行。`needSync` 显式给 —— us 走「无锚不采」成员制, 新注册的 us 标的
   * 默认是**关闸**的 (本维度不读这一列, 给出来是为了让「闸在场」这件事可见)。
   */
  async function seedInstrument(code: string, needSync = false): Promise<bigint> {
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

  /** 该维度最近一次 SyncRun 的落账 (计数 + 审计明细都从这里读, 与运维看到的是同一份)。 */
  async function lastRun() {
    return prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:earnings_event' },
      orderBy: { id: 'desc' },
    });
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
    await prisma.earningsEvent.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchor.deleteMany();
    await prisma.syncRun.deleteMany();
    calendar = new RecordingEarningsCalendarPort();
  });

  // ── ① 零锚 → 该维度照常跑并落库 (state_branch 22, FR-035a) ──
  it('① 零锚 → 照常发满前向视野的窗请求并落库 (挂锚闸会让这里静默变成 0 且不会红)', async () => {
    // 锚表**在场且为空**, `Instrument` 也全是关闸态 —— 另两个 per-code 维度在这个状态下
    // 请求数恒为 0 (T017 ①)。本维度必须相反: 它是市场级接口, 锚闸对它零收窄作用。
    await seedInstrument('PEP');
    calendar.events = [eventOf('us:PEP', '2026-06-25')];
    const registry = buildRegistry();

    const run = await registry.execute('earnings_event', deltaInput(FRI));

    // 窗数 = 前向视野 ÷ 窗宽上限 (**由常量派生**, 窗宽哪天再被真 vendor 校准就跟着走);
    // 这个数只跟视野有关, 与锚数量无关 (SC-006a)。
    expect(calendar.windowCalls).toHaveLength(
      Math.ceil(EARNINGS_FORWARD_HORIZON_DAYS / EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS),
    );
    expect(calendar.windowCalls[0].start).toBe(FRI.us); // A′ 按 us 时区求, 不吃 asOf 的上海日
    expect(run.stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(await prisma.earningsEvent.count()).toBe(1);
    expect((await lastRun()).status).toBe('success');
  });

  // ── ② 全市场落库 (FR-035b) ──
  it('② 非白名单标的的行确实在库 —— 拉回什么存什么, 不按锚收窄', async () => {
    // PEP 是锚, LULU 既非锚也未开闸。只落白名单会让 LULU 建锚**之前**的改期史永久缺失,
    // 且建锚后它的 `first_seen_at` 会变成「建锚那天」—— 语义是错的, 不只是缺数据。
    await seedInstrument('PEP');
    await seedInstrument('LULU');
    await seedAnchor('us:PEP');
    calendar.events = [eventOf('us:PEP', '2026-06-25'), eventOf('us:LULU', '2026-06-30')];
    const registry = buildRegistry();

    await registry.execute('earnings_event', deltaInput(FRI));

    const rows = await prisma.earningsEvent.findMany({
      include: { instrument: { select: { code: true } } },
      orderBy: { earningsDate: 'asc' },
    });
    expect(rows.map((r) => r.instrument.code)).toEqual(['PEP', 'LULU']);
  });

  // ── ③ 连续两日不同日期 → PIT 三件套 (FR-027) ──
  it('③ 次日财报日变了 → **原地改**并记变更前日期与变更时刻, first_seen_at 不动', async () => {
    await seedInstrument('PEP');
    calendar.events = [eventOf('us:PEP', '2026-06-25')];
    const registry = buildRegistry();

    await registry.execute('earnings_event', deltaInput(FRI));
    const day1 = await prisma.earningsEvent.findFirstOrThrow();
    expect(day1.firstSeenAt).toEqual(FRI.now); // 与 dateChangedAt 同一把钟 (注入控时)
    expect(day1.dateChangedAt).toBeNull();
    expect(day1.prevEarningsDate).toBeNull();

    // 次日 vendor 把这次财报挪到 07-02 —— PIT diff 要发现的正是这个 (只拉增量窗永远看不到)。
    calendar.events = [eventOf('us:PEP', '2026-07-02')];
    await registry.execute('earnings_event', deltaInput(MON));

    const rows = await prisma.earningsEvent.findMany();
    // 🚨 **一行**: 插新行会让 06-25 那条留在库里继续声称那天有财报, 下游跨财报判定会照着
    // 一个已经不存在的日期打标 —— 而两条路径都不会红。
    expect(rows).toHaveLength(1);
    expect(dayOf(rows[0].earningsDate)).toBe('2026-07-02');
    expect(dayOf(rows[0].prevEarningsDate)).toBe('2026-06-25');
    expect(rows[0].dateChangedAt).toEqual(MON.now);
    // 「第一次看见这次财报」的时刻不因改期而重写 —— 那正是本表唯一要承载的信息。
    expect(rows[0].firstSeenAt).toEqual(FRI.now);
    expect(rows[0].id).toBe(day1.id);

    // 复核名单进了 SyncRun 审计明细 (WARN 是当下那条通路, 这条是事后可查询的那条)。
    const audit = (await lastRun()).findings as { step: string; changed?: number }[];
    expect(audit).toContainEqual(expect.objectContaining({ step: 'earnings_date_changed' }));
  });

  it('③b 同日重跑 → 零重复行且 PIT 列不被扰动 (FR-037)', async () => {
    await seedInstrument('PEP');
    calendar.events = [eventOf('us:PEP', '2026-06-25')];
    const registry = buildRegistry();

    await registry.execute('earnings_event', deltaInput(FRI));
    const first = await prisma.earningsEvent.findFirstOrThrow();
    await registry.execute('earnings_event', deltaInput(FRI));

    const rows = await prisma.earningsEvent.findMany();
    expect(rows).toHaveLength(1);
    // `date_changed_at` 一被无谓刷新, 复核名单就再也不可信。
    expect(rows[0]).toEqual(first);
  });

  // ── ④ Instrument 表外标的 → 跳过并计数, FK 未破 (state_branch 23, plan D-DATA-8) ──
  it('④ 库外标的被跳过、FK 未破、计数从 SyncRun 可读 (MUST NOT 为绕 FK 改幂等键)', async () => {
    await seedInstrument('PEP');
    // 全市场必然撞上库里没有的票 (新上市 / OTC)。把幂等键改成裸 (市场, 代码) 能让它们落库,
    // 但会同时废掉「标的」这个锚点, 且让 universe 漏枚举彻底静默。
    calendar.events = [
      eventOf('us:PEP', '2026-06-25'),
      eventOf('us:GHOST', '2026-06-26'),
      eventOf('us:GHOST2', '2026-06-29'),
    ];
    const registry = buildRegistry();

    const run = await registry.execute('earnings_event', deltaInput(FRI));

    expect(run.stats).toMatchObject({ scanned: 3, ok: 1, skipped: 2, failed: 0 });
    expect(await prisma.earningsEvent.count()).toBe(1);
    // FK 未破: 每一行都挂在一个真存在的 Instrument 上 (join 得回来)。
    const rows = await prisma.earningsEvent.findMany({
      include: { instrument: { select: { code: true } } },
    });
    expect(rows.map((r) => r.instrument.code)).toEqual(['PEP']);

    // 🚨 计数是**监控信号**: 持续升高 = universe 枚举漏了一类标的 ⇒ 必须落在运维看得到的
    // 那份账上 (SyncRun), 而不是只在一行 log 里。
    const persisted = await lastRun();
    expect(persisted.skipped).toBe(2);
    const audit = persisted.findings as {
      kind: string;
      step: string;
      detail?: { unmatched?: number };
    }[];
    expect(audit).toContainEqual(
      expect.objectContaining({
        kind: 'notice',
        step: 'earnings_instrument_unmatched',
        detail: expect.objectContaining({ unmatched: 2 }),
      }),
    );
    // 跳过不是失败 —— 计 failed 会让夜间日报天天红。
    expect(persisted.status).toBe('success');
  });

  // ── ⑤ 新建锚的票, 财报数据**建锚当刻即在库** (FR-038 的更强保证) ──
  it('⑤ 建锚前就已全市场落库 ⇒ 建锚当刻其财报数据即可用, 不必等下一轮', async () => {
    // ⚠️ 与另两个 per-code 维度**故意不同**: 那两条是「新锚下一轮才纳入工作集」(T017 ②),
    // 因为它们的工作集由锚闸定。本维度不挂锚闸 ⇒ 全市场早已在库, 这正是 FR-035b 的红利。
    await seedInstrument('LULU');
    calendar.events = [eventOf('us:LULU', '2026-06-25')];
    const registry = buildRegistry();

    await registry.execute('earnings_event', deltaInput(FRI)); // 此刻锚表为空
    expect(await prisma.anchor.count()).toBe(0);

    await seedAnchor('us:LULU'); // 建锚当刻 —— 零额外采集

    const rows = await prisma.earningsEvent.findMany({
      where: { instrument: { code: 'LULU' } },
    });
    expect(rows).toHaveLength(1);
    expect(dayOf(rows[0].earningsDate)).toBe('2026-06-25');
    // `first_seen_at` 是「该日期首次被观察到」那天, **不是**「建锚那天」—— 只落白名单时
    // 这一列的语义会直接变错。
    expect(rows[0].firstSeenAt).toEqual(FRI.now);
  });
});
