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
  UsIndexCode,
  UsIndexDailyPoint,
  UsIndexHistory,
  UsIndexPort,
} from '../../src/marketdata/us-index.port';

// 046 T014 指数采集 IT (FR-025/FR-027/FR-029)。
//
// ## 为什么**必须**要真 PG
//
// 本条验的四件事在 mock 上全部**不成立**，而且不会红、只会静默变成平凡绿：
//   ① **「零锚零 Instrument 仍落数」的分母是一个真空库** —— 断言 ① 是 FR-027 的核心，它要的
//      不是「executor 里没写 needSync 这个词」，而是「在一个连一行 `Instrument` 都没有的真库
//      上跑完一轮，`us_index_daily` 里确实有行」。把 prisma mock 掉，「库是空的」就成了摆设：
//      工作集本来就是入参喂进去的，空不空都一样跑。
//   ② **幂等是唯一键** —— `(index_code, date)` 上 `createMany(skipDuplicates)` 的冲突路径与
//      upsert 的覆盖路径只有真 PG 有。mock 里 `skipDuplicates: true` 只是一个被断言过的字面量，
//      「重跑不翻倍」在那里根本无从观测（T013 单测只能验到「参数传对了」）。
//   ③ **头尾两条写通路要在同一张表上合流** —— 头部 `createMany` + 尾部 `upsert` 是两个不同的
//      SQL 语句族，切分错位（重叠 ⇒ P2002 / 有缝 ⇒ 丢行）只有落到真表上才看得见。
//   ④ **「源不可达时已落历史不动」需要有历史可动** —— 这是 T013 单测**故意**留给本条的半边：
//      那边只能断言「upsert 没被调用」，「一行都没被改」得有库才谈得上。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取（共享 PG 的模板克隆，
// 禁自起 Testcontainers）。**不用 `setupEmptyDb()`** —— 那个入口是给「自己跑 `migrate deploy`
// 并验证其产物」的文件用的（本 feature 里 T005 已占）；本条要的是一个迁好的库。
//
// 装配 = 直接 new `DimensionExecutorRegistry` 打真 `PrismaService`（样板
// `optionsdesk-045.anchor.it.spec.ts` / 同 feature 近邻 `optionsdesk-046.underlying-iv.it.spec.ts`）。
//
// 🚨 vendor 侧恒 mock（`RecordingUsIndexPort`）—— 本文件是 hermetic Medium IT，**不打真 CBOE**。
// 真源连通性不在这里验（也不该在这里验：CBOE 是公开文件源，没有 gated vendor 门覆盖它）。
describe('046 T014 指数采集 (Testcontainers PG, 真空库 + 记账指数端口)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let port: RecordingUsIndexPort;

  /**
   * 北京 2026-06-13(周六) 06:00 = us 维度 cron 时刻；ET 侧还停在 2026-06-12(周五) 18:00
   * ⇒ A′ = `2026-06-12`。`asOf` 蓄意给**上海日** —— executor 必须自己按 us 时区求 A′，不吃这个
   * 值（FR-028）。本文件的 fixture 日期全部落在 A′ 之前，故 A′ 上界闸在这里恒不触发；
   * **边界归属（恰好等于 A′ 保留 / 晚于 A′ 拦下）由 T013 单测覆盖**，不在这里重复。
   */
  const NOW = new Date('2026-06-12T22:00:00Z');
  const SHANGHAI_DATE = '2026-06-13';
  const deltaInput = { mode: 'delta' as const, asOf: SHANGHAI_DATE, now: NOW };

  const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

  /** 自 `2026-05-01` 起逐日（含周末，本片不查交易日历）造 n 行 VIX 形态数据。 */
  function vixSeries(n: number): UsIndexDailyPoint[] {
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(2026, 4, 1) + i * 86_400_000);
      const base = (15 + i * 0.01).toFixed(4);
      return { date: dayOf(d), open: base, high: base, low: base, close: base };
    });
  }

  /** 🚨 VVIX 源文件只有 `DATE,VVIX` ⇒ 其余 OHLC 恒 null，**禁填 0**（Guardrail 7 / FR-025）。 */
  function vvixSeries(n: number): UsIndexDailyPoint[] {
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(2026, 4, 1) + i * 86_400_000);
      return {
        date: dayOf(d),
        open: null,
        high: null,
        low: null,
        close: (92 + i * 0.01).toFixed(4),
      };
    });
  }

  /**
   * test-local fake `US_INDEX_PORT`：逐 code 记账 + 可编程失败 / 非法行计数。
   *
   * 非法行在真实链路里由 `parseCboeIndexCsv`（T003）产生并由 adapter（T012）原样上抛 ——
   * 本条 IT 的验证面是**它有没有一路走进 `SyncRun` 的 `skipped` 列**，所以从端口边界注入
   * 计数即可；CSV 怎么判非法归 `cboe-index-csv.rules.spec.ts`。
   */
  class RecordingUsIndexPort implements UsIndexPort {
    readonly calls: UsIndexCode[] = [];
    readonly rowsByCode = new Map<UsIndexCode, UsIndexDailyPoint[]>();
    readonly skippedByCode = new Map<UsIndexCode, number>();
    /** 这些 code 取数抛错（源不可达 / 表头变更）。 */
    readonly unreachable = new Set<UsIndexCode>();

    async getIndexHistory(indexCode: UsIndexCode): Promise<UsIndexHistory> {
      this.calls.push(indexCode);
      if (this.unreachable.has(indexCode)) {
        throw new Error(`cboe 502 (${indexCode} 官方历史文件不可达)`);
      }
      const skipped = this.skippedByCode.get(indexCode) ?? 0;
      return {
        indexCode,
        rows: this.rowsByCode.get(indexCode) ?? [],
        skipped,
        skippedSamples: Array.from({ length: Math.min(skipped, 5) }, (_, i) => `bad-line-${i}`),
      };
    }
  }

  /**
   * 🚨 `usIndex` 是构造器的**第 29 个位置参数**（紧跟 `underlyingIv` 之后），直接 new 装配时
   * 错位不会红、只会把端口注成别的东西。`anchorGate` 这里传**真实例** —— 断言 ① 要的正是
   * 「锚闸在场且库里零锚，指数维度依然照跑」，传 undefined 会把被测的对照面抽掉。
   */
  function buildRegistry(usIndex: UsIndexPort): DimensionExecutorRegistry {
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
      new AnchorDrivenSyncGate(prisma), // anchorGate (045 T015): **真闸**, 断言 ① 的对照面
      undefined, // underlyingIv (046 T008) → 默认 null-object
      usIndex, // usIndex (046 T013, 尾部第 29 位)
    );
  }

  const latestRun = () =>
    prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:us_index_daily' },
      orderBy: { id: 'desc' },
    });

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
    await prisma.usIndexDaily.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchor.deleteMany();
    await prisma.syncRun.deleteMany();
    port = new RecordingUsIndexPort();
  });

  // ── ① 零锚零 Instrument 仍落数 (FR-027 核心断言) ──
  it('① **库里零锚零 Instrument** 时跑一轮仍落数 —— 指数表盘不依赖锚 (FR-027)', async () => {
    port.rowsByCode.set('VIX', vixSeries(3));
    port.rowsByCode.set('VVIX', vvixSeries(3));

    // 前置显式化: 这条断言的全部价值就在这个「真空库」的分母上。
    expect(await prisma.instrument.count()).toBe(0);
    expect(await prisma.anchor.count()).toBe(0);

    const { stats } = await buildRegistry(port).execute('us_index_daily', deltaInput);

    // 两个固定代码都被问了 —— 工作集不来自 Instrument 表, 空库对它没有任何抑制作用。
    expect(port.calls).toEqual(['VIX', 'VVIX']);
    expect(stats).toMatchObject({ scanned: 6, ok: 6, skipped: 0, failed: 0 });
    expect(await prisma.usIndexDaily.count()).toBe(6);
    // 与 FR-018 空态分支的守门: 零锚时温度计的**指数半边照样有数据可读**。
    expect(await prisma.usIndexDaily.count({ where: { indexCode: 'VIX' } })).toBe(3);
    expect((await latestRun()).status).toBe('success');
    // 采集闸在场但一行都没得刷 —— 它不该反过来影响指数维度。
    expect(await prisma.instrument.count()).toBe(0);
  });

  // ── ② VVIX close 有值、其余 OHLC 为 null (FR-025 / Guardrail 7) ──
  it('② VVIX 行 close 有值、其余 OHLC 落库为 **null 而非 0**; VIX 四列齐全', async () => {
    port.rowsByCode.set('VIX', vixSeries(1));
    port.rowsByCode.set('VVIX', vvixSeries(1));
    await buildRegistry(port).execute('us_index_daily', deltaInput);

    const vvix = await prisma.usIndexDaily.findFirstOrThrow({ where: { indexCode: 'VVIX' } });
    expect(vvix.close.toString()).toBe('92');
    // 🚨 真列上确认是 NULL: 填 0 会让「VVIX 开盘 0」这种假事实进库, 且下游再也分不出
    // 「无此列」与「真是 0」—— 这正是 schema 把三列做成 nullable 的理由。
    expect(vvix.open).toBeNull();
    expect(vvix.high).toBeNull();
    expect(vvix.low).toBeNull();

    const vix = await prisma.usIndexDaily.findFirstOrThrow({ where: { indexCode: 'VIX' } });
    expect(vix.open?.toString()).toBe('15');
    expect(vix.high?.toString()).toBe('15');
    expect(vix.low?.toString()).toBe('15');
    expect(vix.close.toString()).toBe('15');
  });

  // ── ③ 同日重跑幂等 (FR-029) + 头尾两条写通路都落到同一张表 ──
  it('③ 同日重跑幂等: 无重复行; 尾部窗口内的修订被 upsert 覆盖、头部老行 createMany 撞唯一键跳过', async () => {
    // 25 行 > 尾部窗口(10) ⇒ 头部 createMany + 尾部 upsert 两条通路都真的走一遍。
    const series = vixSeries(25);
    port.rowsByCode.set('VIX', series);
    port.rowsByCode.set('VVIX', []);
    const registry = buildRegistry(port);

    await registry.execute('us_index_daily', deltaInput);
    expect(await prisma.usIndexDaily.count()).toBe(25);

    // 第二轮: 尾部最后一行被 vendor 订正、头部第一行也「变了」——
    // 前者应被覆盖 (尾部窗口 = 可修订区), 后者应保持原值 (insert-only 撞唯一键跳过)。
    const revised = series.map((row, i) =>
      i === series.length - 1 || i === 0 ? { ...row, close: '99.9999' } : row,
    );
    port.rowsByCode.set('VIX', revised);
    const { stats } = await registry.execute('us_index_daily', deltaInput);

    // 唯一键 (index_code, date) 即幂等语义载体: 重跑不翻倍, 也不撞 P2002 崩掉。
    expect(await prisma.usIndexDaily.count()).toBe(25);
    expect(stats).toMatchObject({ scanned: 25, ok: 25, skipped: 0, failed: 0 });
    expect((await latestRun()).status).toBe('success');

    const rows = await prisma.usIndexDaily.findMany({
      where: { indexCode: 'VIX' },
      orderBy: { date: 'asc' },
    });
    expect(rows).toHaveLength(25);
    // 头尾切分**无缝无叠**: 25 行逐日连续, 一天不多一天不少。
    expect(rows.map((r) => dayOf(r.date))).toEqual(series.map((r) => r.date));
    expect(rows[24]!.close.toString()).toBe('99.9999'); // 尾部: 订正生效
    expect(rows[0]!.close.toString()).toBe('15'); // 头部: 老结算值不被改写
  });

  // ── ④ 源不可达: 记失败且历史不动 (per-code 隔离) ──
  it('④ 源不可达: 记失败 + **已落历史一行不动** + 另一个代码照常落 + 次轮恢复补齐', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      port.rowsByCode.set('VIX', vixSeries(3));
      port.rowsByCode.set('VVIX', vvixSeries(3));
      const registry = buildRegistry(port);

      await registry.execute('us_index_daily', deltaInput); // 第一轮正常落
      const before = await prisma.usIndexDaily.findMany({
        orderBy: [{ indexCode: 'asc' }, { date: 'asc' }],
      });
      expect(before).toHaveLength(6);

      // 第二轮: VIX 那份文件拉不到, 且这一轮 VVIX 多了一行新数据。
      port.unreachable.add('VIX');
      port.rowsByCode.set('VVIX', vvixSeries(4));
      const { stats } = await registry.execute('us_index_daily', deltaInput);

      // 记失败: 计入 stats + SyncRun 收 partial, 且**不上抛** —— 上抛会让 worker 按「崩溃」
      // 重试整轮, 而全量文件天然自愈 (明天那份文件里今天这行还在)。
      expect(stats).toMatchObject({ ok: 4, failed: 1 });
      expect(stats.findings[0]).toMatchObject({ symbol: 'VIX', step: 'us_index_daily' });
      const failedRun = await latestRun();
      expect(failedRun.status).toBe('partial');
      expect(failedRun.failed).toBe(1);
      const warnMsgs = warn.mock.calls.map((c) => String(c[0]));
      expect(warnMsgs.some((m) => m.includes('us_index_daily') && m.includes('VIX'))).toBe(true);

      // 🚨 本条的核心: VIX 已落的 3 行**逐列一行未动**（per-code 隔离真的隔住了写路径）。
      const vixAfter = await prisma.usIndexDaily.findMany({
        where: { indexCode: 'VIX' },
        orderBy: { date: 'asc' },
      });
      expect(vixAfter).toEqual(before.filter((r) => r.indexCode === 'VIX'));
      // 另一个代码照常推进到 4 行 —— 一个源抖动不该把另一个指数一起拖没。
      expect(await prisma.usIndexDaily.count({ where: { indexCode: 'VVIX' } })).toBe(4);

      // 次轮源恢复 → VIX 照常补齐, 且既有行仍不变。
      port.unreachable.delete('VIX');
      await registry.execute('us_index_daily', deltaInput);
      expect((await latestRun()).status).toBe('success');
      expect(
        await prisma.usIndexDaily.findMany({
          where: { indexCode: 'VIX' },
          orderBy: { date: 'asc' },
        }),
      ).toEqual(vixAfter);
    } finally {
      warn.mockRestore();
    }
  });

  // ── ⑤ 非法行被跳过且计数进 SyncRun 统计 (plan D6 禁静默丢) ──
  it('⑤ 非法行跳过并计数, 一路进 **SyncRun 的 skipped 列**; 合法行照落不受牵连', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      port.rowsByCode.set('VIX', vixSeries(3));
      port.rowsByCode.set('VVIX', vvixSeries(2));
      port.skippedByCode.set('VIX', 4);
      port.skippedByCode.set('VVIX', 1);

      const { stats } = await buildRegistry(port).execute('us_index_daily', deltaInput);

      // scanned = 合法行 + 非法行（文件里的数据行总数）; skipped 承载非法行。
      expect(stats).toMatchObject({ scanned: 10, ok: 5, skipped: 5, failed: 0 });
      // 🚨 落库那一列才是本条要守的东西: 统计只停在内存里等于没上抛 —— 运维看的是 SyncRun。
      const run = await latestRun();
      expect(run.status).toBe('success'); // 非法行不是失败, 是有记录的跳过
      expect({
        scanned: run.scanned,
        ok: run.ok,
        skipped: run.skipped,
        failed: run.failed,
      }).toEqual({ scanned: 10, ok: 5, skipped: 5, failed: 0 });
      // 合法行一行不少地落了下来（跳过是逐行的，不牵连整份文件）。
      expect(await prisma.usIndexDaily.count()).toBe(5);
      const warnMsgs = warn.mock.calls.map((c) => String(c[0]));
      expect(warnMsgs.some((m) => m.includes('非法行'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
