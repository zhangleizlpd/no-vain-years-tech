import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { AnchorDrivenSyncGate } from '../../src/marketdata/anchor-driven-sync-gate';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type {
  UnderlyingIvHistoryPoint,
  UnderlyingIvHistoryQuery,
  UnderlyingIvPort,
  UnderlyingIvSnapshot,
} from '../../src/marketdata/underlying-iv.port';

// 046 T011 标的级 IV 采集 IT (FR-023/FR-026/FR-029/FR-030/FR-031/FR-034)。
//
// ## 为什么**必须**要真 PG
//
// 本条验的四件事在 mock 上全部**不成立**，而且不会红、只会静默变成平凡绿：
//   ① **工作集闸是一条 SQL 谓词** —— `needSync` 由 `AnchorDrivenSyncGate` 的双 `updateMany`
//      单事务刷出来，再由 `loadActiveInstruments` 的 `where` 读回。把 `instrument.findMany`
//      mock 掉，等于**直接把工作集当入参喂进去** —— 闸本身（锚表 → needSync → 工作集这条链）
//      就没被测；那条链恰好是 SC-006 与 FR-031 的全部内容。
//   ② **幂等是唯一键** —— `(instrument_id, date)` 上的 upsert 冲突路径只有真 PG 有；mock 的
//      `upsert` 只是一次函数调用，「重跑不翻倍」在那里是断言不到的。
//   ③ **「vendor 不可达时已落历史不动」需要有历史可动** —— 这是本条 IT 的**核心价值**，也是
//      它**故意**不放在 `dimension-executor.spec.ts`（`unit` project，零容器是硬不变量）的
//      原因：那里没有库，「不动」无从观测，只能退化成「upsert 没被调用」的近似。
//   ④ **双算对表读的是真表** —— `crossCheckIvPercentile` 从 `underlying_iv_history` 取 252
//      个交易日窗口自算分位，窗口够不够、取到哪些行，都是真 SQL（`lte` + `take` + desc）的事。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取（共享 PG 的模板克隆，
// 禁自起 Testcontainers）。**不用 `setupEmptyDb()`** —— 那个入口是给「自己跑 `migrate deploy`
// 并验证其产物」的文件用的（本 feature 里 T005 已占）；本条要的是一个迁好的库，不是被测的迁移。
//
// 装配 = 直接 new `DimensionExecutorRegistry` 打真 `PrismaService`（样板
// `optionsdesk-045.anchor.it.spec.ts`）：executor 是贫血装配、无 lifecycle 语义，验证面是
// **落库口径 + 请求面**；HTTP 通道层不涉及，不起 Nest 容器。
//
// 🚨 vendor 侧恒 mock（`RecordingIvPort`）—— 本文件是 hermetic Medium IT。**这里计时毫无
// 意义**：SC-005「12 只锚单轮 ≤5 分钟」的唯一有效载体是 T007 扩进
// `marketdata.futu-shim.vendor.spec.ts` 的那两个 env-gated 块。
describe('046 T011 标的级 IV 采集 (Testcontainers PG, 真锚闸 + 记账 IV 端口)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let port: RecordingIvPort;

  /**
   * 三个业务日。**日期取美股业务日 A′ 而不是上海日**（FR-028）——
   * 北京 06:00 的 cron 时刻，ET 侧还停在前一交易日 18:00。fixture 若按上海日造，断言会整体
   * 错位一天，且错得很不显眼。
   */
  const D1 = { now: new Date('2026-06-12T22:00:00Z'), us: '2026-06-12', shanghai: '2026-06-13' };
  const D2 = { now: new Date('2026-06-15T22:00:00Z'), us: '2026-06-15', shanghai: '2026-06-16' };
  const D3 = { now: new Date('2026-06-16T22:00:00Z'), us: '2026-06-16', shanghai: '2026-06-17' };

  /** delta 入参；`asOf` 蓄意给**上海日** —— executor 必须自己按 us 时区求 A′，不吃这个值。 */
  const deltaInput = (d: typeof D1) => ({ mode: 'delta' as const, asOf: d.shanghai, now: d.now });

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);
  const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

  /**
   * vendor 快照 fixture（字段形态同 T008 单测）。`ivPercentile` 是**直读值** —— 显示口径单源
   * 就是它（FR-035），自算值只用于对表。
   */
  function makeSnapshot(
    symbol: string,
    over: Partial<UnderlyingIvSnapshot> = {},
  ): UnderlyingIvSnapshot {
    return {
      symbol,
      iv: '24.8',
      ivRank: '61.2',
      ivPercentile: '58.4',
      preIv: '24.1',
      hv30: '19.5',
      hv30Percentile: '44.0',
      hv60: '20.1',
      hv60Percentile: '46.0',
      hv90: '21.0',
      hv90Percentile: '48.0',
      hv120: '21.4',
      hv120Percentile: '49.0',
      hv365: '23.0',
      hv365Percentile: '52.0',
      callVolume: '1200',
      putVolume: '900',
      callOi: '34000',
      putOi: '28000',
      ...over,
    };
  }

  /**
   * test-local fake `UNDERLYING_IV_PORT`：**记每一次请求的入参**。
   *
   * 🚨 断言 ①「非锚定标的请求数 = 0」是 SC-006 的可验证判据，必须是**真数请求次数** ——
   * 「库里没落那只标的的行」是间接推断，工作集漏了它、vendor 问了但返空、落库被过滤掉，
   * 三者在库侧看起来一模一样，而只有第一种才是闸生效。
   */
  class RecordingIvPort implements UnderlyingIvPort {
    /** 每次 `getIvSnapshots` 的入参（一元素 = 一批）。 */
    readonly snapshotCalls: string[][] = [];
    readonly historyCalls: UnderlyingIvHistoryQuery[] = [];
    /** vendor 不可达开关（FR-030 路径）。 */
    unreachable = false;
    /** 逐 symbol 的快照字段覆盖 —— 对表三档靠它造差值。 */
    readonly overrides = new Map<string, Partial<UnderlyingIvSnapshot>>();
    /** `his_volatility` 全量序列；按窗口裁剪后返回（切分本身归 T009 单测）。 */
    historySeries: UnderlyingIvHistoryPoint[] = [];

    async getIvSnapshots(symbols: readonly string[]): Promise<UnderlyingIvSnapshot[]> {
      this.snapshotCalls.push([...symbols]);
      if (this.unreachable) throw new Error('futu-shim 502 (vendor 不可达)');
      return symbols.map((s) => makeSnapshot(s, this.overrides.get(s)));
    }

    async getIvHistoryRange(query: UnderlyingIvHistoryQuery): Promise<UnderlyingIvHistoryPoint[]> {
      this.historyCalls.push({ ...query });
      if (this.unreachable) throw new Error('futu-shim 502 (vendor 不可达)');
      return this.historySeries.filter(
        (p) =>
          (query.from === undefined || p.date >= query.from) &&
          (query.to === undefined || p.date <= query.to),
      );
    }

    /** 展平后的被请求 symbol 序列（SC-006 的计数面）。 */
    requested(): string[] {
      return this.snapshotCalls.flat();
    }

    countRequests(symbol: string): number {
      return this.requested().filter((s) => s === symbol).length;
    }
  }

  /**
   * 🚨 `underlyingIv` 是构造器的**第 28 个位置参数**（紧跟 `anchorGate` 之后），直接 new 装配
   * 时错位不会红、只会把端口注成别的东西。`anchorGate` 这里传**真实例**而非 stub ——
   * 断言 ① / ③ 的被测机制（锚表 → `needSync` → 工作集）就住在它里面。
   */
  function buildRegistry(iv: UnderlyingIvPort): DimensionExecutorRegistry {
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
      new AnchorDrivenSyncGate(prisma), // anchorGate (045 T015): **真闸**, 断言 ①③ 的被测面
      iv, // underlyingIv (046 T008, 尾部第 28 位)
    );
  }

  /**
   * 真 `Instrument` 行。`needSync` 显式给 —— us 走「无锚不采」成员制（`sync-universe` 的
   * create 分支 `needSync: entry.market !== 'us'`），故新注册的 us 标的默认是**关闸**的。
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

  /** 真 `Anchor` 行（optionsdesk schema）。闸只读 `ticker` 一列，其余字段取合法最小集。 */
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

  /** `underlying_iv_history` 行：自 `endExclusive` 往前逐日回溯 n 天，`iv` = 1..n。 */
  function historyRows(instrumentId: bigint, n: number, endExclusive: string) {
    return Array.from({ length: n }, (_, i) => ({
      instrumentId,
      date: new Date(Date.parse(`${endExclusive}T00:00:00Z`) - (i + 1) * 86_400_000),
      iv: String(i + 1),
    }));
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
    await prisma.underlyingIvDaily.deleteMany();
    await prisma.underlyingIvHistory.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchor.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.tradingDay.deleteMany();
    // 🚨 #187: 归属日不再是「执行时刻的日历日」, 而是 `trading_day` 里**最近一个已收盘
    //    session** —— 日历缺行时本维度**放弃本轮**(不猜日子)。三个业务日各造一行, 让下面的
    //    断言仍在验采集/幂等本身。⚠️ 顺带也钉住了正确性: 三行都是 A′ (us 业务日) 而非上海日,
    //    若判据哪天退回日历日, `dayOf(row.date)` 的断言会当场红。
    await prisma.tradingDay.createMany({
      data: [D1, D2, D3].map((d) => ({ market: 'us', date: dateOf(d.us) })),
    });
    port = new RecordingIvPort();
  });

  // ── ① 工作集闸: 请求只覆盖有锚标的, 非锚定标的请求数 = 0 (SC-006 / FR-026) ──
  it('① 请求只覆盖有锚标的 —— 非锚定标的请求数 = 0 (SC-006 判据), 且闸**双向**真动', async () => {
    const pep = await seedInstrument('PEP', false);
    const vici = await seedInstrument('VICI', false);
    // LULU 蓄意造成「陈旧开闸」态: 闸必须主动把它**关掉**才能让请求面干净。若只造 false,
    // 这条断言会被初始值兜住 —— 闸整个不生效也照样绿。
    const lulu = await seedInstrument('LULU', true);
    await seedAnchor('us:PEP');
    await seedAnchor('us:VICI');

    const { stats } = await buildRegistry(port).execute('underlying_iv_daily', deltaInput(D1));

    // SC-006 的可验证判据 = **真数请求次数**, 不是「库里没它的行」那种间接推断。
    expect(port.countRequests('us:LULU')).toBe(0);
    expect([...port.requested()].sort()).toEqual(['us:PEP', 'us:VICI']);
    // 批量形态: 整批一次, 不是逐票 N 次 (batchSize=500, 2 只标的 ⇒ 恰 1 批)。
    expect(port.snapshotCalls).toHaveLength(1);
    expect(stats).toMatchObject({ scanned: 2, ok: 2, skipped: 0, failed: 0 });

    // 闸双向落库: 有锚开、无锚关。needSync 就是工作集的 where 谓词本身。
    expect(
      await prisma.instrument.findMany({
        select: { code: true, needSync: true },
        orderBy: { code: 'asc' },
      }),
    ).toEqual([
      { code: 'LULU', needSync: false },
      { code: 'PEP', needSync: true },
      { code: 'VICI', needSync: true },
    ]);

    expect(await prisma.underlyingIvDaily.count({ where: { instrumentId: lulu } })).toBe(0);
    expect(
      await prisma.underlyingIvDaily.count({ where: { instrumentId: { in: [pep, vici] } } }),
    ).toBe(2);
  });

  // ── ② 同日重跑幂等 (FR-029) + 行落在美股业务日 A′ (FR-028) ──
  it('② 同日重跑幂等: 无重复行 + upsert 覆盖同一行; 行落**美股业务日** A′ 而非上海日', async () => {
    const pep = await seedInstrument('PEP', false);
    await seedAnchor('us:PEP');
    const registry = buildRegistry(port);

    await registry.execute('underlying_iv_daily', deltaInput(D1));
    // 第二轮 vendor 值变了 —— 用它区分「真 update」与「撞唯一键后跳过」。
    port.overrides.set('us:PEP', { iv: '31.5', ivPercentile: '77.25' });
    const { stats } = await registry.execute('underlying_iv_daily', deltaInput(D1));

    const rows = await prisma.underlyingIvDaily.findMany({ where: { instrumentId: pep } });
    expect(rows).toHaveLength(1); // 唯一键 (instrument_id, date) 即幂等语义载体
    expect(rows[0]!.iv?.toString()).toBe('31.5');
    expect(rows[0]!.ivPercentile?.toString()).toBe('77.25');
    // A′ = marketDateFor({us}): 北京 06-13 06:00 那一刻美股业务日还是 06-12。若退回 asOf
    // (上海日), 整表错位一天且每周固定丢掉周五 —— 不会红, 只会让读端悄悄查不到「今天」。
    expect(dayOf(rows[0]!.date)).toBe(D1.us);
    expect(dayOf(rows[0]!.date)).not.toBe(D1.shanghai);
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });

    const runs = await prisma.syncRun.findMany({
      where: { syncType: 'sync:underlying_iv_daily' },
      orderBy: { id: 'asc' },
    });
    expect(runs.map((r) => r.status)).toEqual(['success', 'success']);
  });

  // ── ③ 新增一条锚 → 下一轮自动纳入 (FR-031 / SC-004) ──
  it('③ 新增一条锚 → 下一轮自动纳入 (FR-031): 零代码改动、零人工 SQL', async () => {
    await seedInstrument('PEP', false);
    const lulu = await seedInstrument('LULU', false);
    await seedAnchor('us:PEP');
    const registry = buildRegistry(port);

    await registry.execute('underlying_iv_daily', deltaInput(D1));
    expect(port.countRequests('us:LULU')).toBe(0);
    expect(port.snapshotCalls[0]).toEqual(['us:PEP']);

    await seedAnchor('us:LULU'); // 第 13 只锚: 只建锚, 不碰 marketdata 任何一列
    await registry.execute('underlying_iv_daily', deltaInput(D2));

    // 下一轮的 fact 前置重算把它刷成 needSync ⇒ 进工作集 ⇒ 被请求 ⇒ 落行。
    expect([...port.snapshotCalls[1]!].sort()).toEqual(['us:LULU', 'us:PEP']);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id: lulu } })).needSync).toBe(
      true,
    );
    const row = await prisma.underlyingIvDaily.findFirstOrThrow({
      where: { instrumentId: lulu },
    });
    expect(dayOf(row.date)).toBe(D2.us);
  });

  // ── ④ vendor 不可达: 记失败 + 已落历史不动 + 次日重跑补齐 (FR-030) ──
  it('④ vendor 不可达: 记失败(可重拉档) + **已落历史一行不动** + 次日重跑恢复 + 缺口经 his_volatility 补齐', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const pep = await seedInstrument('PEP', false);
      await seedAnchor('us:PEP');
      // 「已落历史」两面都要护住: 日快照 (前一轮采的) + 原始序列 (回填出来的)。
      await prisma.underlyingIvHistory.createMany({
        data: [
          { instrumentId: pep, date: dateOf('2026-06-10'), iv: '20.5', hv: '18.1' },
          { instrumentId: pep, date: dateOf('2026-06-11'), iv: '21.0', hv: '18.4' },
        ],
      });
      const registry = buildRegistry(port);

      await registry.execute('underlying_iv_daily', deltaInput(D1)); // D1 正常落
      const dailyBefore = await prisma.underlyingIvDaily.findMany({ orderBy: { date: 'asc' } });
      const histBefore = await prisma.underlyingIvHistory.findMany({ orderBy: { date: 'asc' } });
      expect(dailyBefore).toHaveLength(1);

      // D2: vendor 不可达。
      port.unreachable = true;
      const { stats } = await registry.execute('underlying_iv_daily', deltaInput(D2));

      // 记失败: 计入 stats + SyncRun 收 failed, 且**不上抛** —— 上抛会把「可重拉」这一档
      // 伪装成崩溃, 触发 worker 重试并污染整条采集链的运行状态。
      expect(stats).toMatchObject({ scanned: 1, ok: 0, skipped: 0, failed: 1 });
      expect(stats.findings[0]).toMatchObject({ step: 'underlying_iv_daily' });
      const failedRun = await prisma.syncRun.findFirstOrThrow({
        where: { syncType: 'sync:underlying_iv_daily' },
        orderBy: { id: 'desc' },
      });
      expect(failedRun.status).toBe('failed');
      // 告警等级 = **可重拉**（写明补救路径），刻意不照抄期权链的「当日必须叫醒人」。
      const warnMsgs = warn.mock.calls.map((c) => String(c[0]));
      expect(warnMsgs.some((m) => m.includes('underlying_iv_daily') && m.includes('可重拉'))).toBe(
        true,
      );

      // 🚨 本条 IT 的核心价值: 已落历史**一行未动**。失败发生在 tx 外的 HTTP 段, 写路径
      // 根本没被触及 —— 但那是实现的说法, 这里在真库上把它验出来。
      expect(await prisma.underlyingIvDaily.findMany({ orderBy: { date: 'asc' } })).toEqual(
        dailyBefore,
      );
      expect(await prisma.underlyingIvHistory.findMany({ orderBy: { date: 'asc' } })).toEqual(
        histBefore,
      );
      // 失败日**零行**: 不留半截行、不拿 0 冒充「今天 IV 是 0」。
      expect(await prisma.underlyingIvDaily.count({ where: { date: dateOf(D2.us) } })).toBe(0);

      // 次日重跑: vendor 恢复 → 照常落当日行, 既有行仍逐列不动。
      port.unreachable = false;
      await registry.execute('underlying_iv_daily', deltaInput(D3));
      const dailyAfter = await prisma.underlyingIvDaily.findMany({ orderBy: { date: 'asc' } });
      expect(dailyAfter.map((r) => dayOf(r.date))).toEqual([D1.us, D3.us]);
      expect(dailyAfter[0]).toEqual(dailyBefore[0]);

      // D2 这个缺口由 `his_volatility` 回填补齐 —— 正是 WARN 文案写明的另一条补救路径。
      // 这里用 30 天窗 (恰 1 页) 只验「补齐真的落到真库上」; 分页切分本身归 T009 单测。
      port.historySeries = [
        { date: D2.us, iv: '22.5', hv: '19.0', underlyingPrice: '150.0000' },
        { date: D3.us, iv: '22.8', hv: '19.2', underlyingPrice: '150.5000' },
      ];
      await registry.execute('underlying_iv_daily', {
        mode: 'backfill',
        asOf: D3.us,
        now: D3.now,
        backfillHistoryDays: 30,
      });
      const histAfter = await prisma.underlyingIvHistory.findMany({ orderBy: { date: 'asc' } });
      expect(histAfter.map((r) => dayOf(r.date))).toEqual([
        '2026-06-10',
        '2026-06-11',
        D2.us,
        D3.us,
      ]);
      // 补齐是 `skipDuplicates` 追加, 不是覆盖: 原有两行逐列不变。
      expect(histAfter.slice(0, 2)).toEqual(histBefore);
    } finally {
      warn.mockRestore();
    }
  });

  // ── ⑤ IVP 双算对表 (FR-034/FR-035): 差超阈进 WARN 名单 + 自算值不进任何列 ──
  it('⑤ 双算对表: 逐票零告警 (判据已退场) + 窗口不足跳过 + **自算值不存在于任何列**', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      // 三只满窗标的的历史序列 iv = 1..252；当日直读 iv = 126.5 ⇒ 严格低于它的样本 126 个
      // ⇒ **自算分位恰为 50.0000**。三档差值由各自的直读 iv_percentile 拉开。
      const wrn = await seedInstrument('PEP', false); // 直读 53.5 ⇒ 差 3.5pp → warn
      const okk = await seedInstrument('VICI', false); // 直读 51.0 ⇒ 差 1.0pp → ok (静默)
      const hrd = await seedInstrument('LULU', false); // 直读 58.5 ⇒ 差 8.5pp → notable
      const sht = await seedInstrument('CPB', false); // 窗口仅 10 天 ⇒ skipped (不告警)
      for (const t of ['us:PEP', 'us:VICI', 'us:LULU', 'us:CPB']) await seedAnchor(t);

      for (const id of [wrn, okk, hrd]) {
        await prisma.underlyingIvHistory.createMany({ data: historyRows(id, 252, D1.us) });
      }
      // 窗口不足: 直读值给一个**离谱**的 99 —— 证明跳过的判据是「窗口不够」而非「差得不多」。
      await prisma.underlyingIvHistory.createMany({ data: historyRows(sht, 10, D1.us) });

      port.overrides.set('us:PEP', { iv: '126.5', ivPercentile: '53.5' });
      port.overrides.set('us:VICI', { iv: '126.5', ivPercentile: '51' });
      port.overrides.set('us:LULU', { iv: '126.5', ivPercentile: '58.5' });
      port.overrides.set('us:CPB', { iv: '126.5', ivPercentile: '99' });

      const { stats } = await buildRegistry(port).execute('underlying_iv_daily', deltaInput(D1));
      expect(stats).toMatchObject({ scanned: 4, ok: 4, failed: 0 });

      const xcheck = (calls: unknown[][]) =>
        calls.map((c) => String(c[0])).filter((m) => m.includes('IVP 双算对表'));
      const warnMsgs = xcheck(warn.mock.calls);
      const errMsgs = xcheck(error.mock.calls);

      // 🚨 **逐票判据已退场** (2026-08-27, py-futu-api#257): 逐票偏移 = 该票窗口内的空值日数,
      // 客户端消不掉 ⇒ 逐票报 = 每晚已知噪声。本用例现在的承重断言有两条:
      //   ① 逐票 WARN / ERROR **恒零** —— 差 1pp 与差 8.5pp 表现完全相同;
      //   ② 可算样本不足 IVP_SYSTEMIC_BREAK_MIN_SAMPLE(10) ⇒ 连塌陷判据也不触发 (本用例 3 只)。
      // 判据本体的正反两臂在 `underlying-iv.rules.spec.ts`, 此处不假装覆盖。
      expect(warnMsgs.filter((m) => m.includes('"symbol"'))).toHaveLength(0);
      expect(warnMsgs.filter((m) => m.includes('恰合数为 0'))).toHaveLength(0);
      expect(errMsgs).toHaveLength(0);
      // ok (噪声带内) 与 skipped (窗口不足) **蓄意零输出** —— 否则告警面会被上线头一年的
      // 新标的刷屏, WARN 名单就失去分辨力了。
      const allMsgs = [...warnMsgs, ...errMsgs];
      expect(allMsgs.some((m) => m.includes('us:VICI'))).toBe(false);
      expect(allMsgs.some((m) => m.includes('us:CPB'))).toBe(false);

      // 🚨 显示口径单源 (FR-035): 落库的 iv_percentile 恒为 **vendor 直读值**, 各档判定
      // 一律不改写它; 自算值 (50) **不存在于任何一列** —— T010 只读、返 void、出口只有
      // logger。这条断言就是防它顺着某个新列漏进 DTO 再漏上 UI。
      const rows = await prisma.underlyingIvDaily.findMany();
      const pctBy = new Map(rows.map((r) => [r.instrumentId, r.ivPercentile?.toString() ?? null]));
      expect(pctBy.get(wrn)).toBe('53.5');
      expect(pctBy.get(okk)).toBe('51');
      expect(pctBy.get(hrd)).toBe('58.5');
      expect(pctBy.get(sht)).toBe('99');
      const selfComputed = '50';
      for (const row of rows) {
        const cells = Object.entries(row)
          .filter(([k]) => k !== 'id' && k !== 'instrumentId' && k !== 'date')
          .map(([, v]) => (v === null ? null : String(v)));
        expect(cells).not.toContain(selfComputed);
      }
      // 对表是**只读**侧信道: 一行历史序列都没被它改写。
      expect(await prisma.underlyingIvHistory.count()).toBe(252 * 3 + 10);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
