import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { QueueEvents } from 'bullmq';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import {
  DimensionExecutorRegistry,
  type DimensionKey,
} from '../../src/marketdata/dimension-executor';
import { BackfillPacer } from '../../src/marketdata/backfill-pacer';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
  MarketdataSyncWorker,
} from '../../src/marketdata/marketdata-sync.worker';
import { executeBackfill, type BackfillDeps } from '../../src/marketdata/marketdata-backfill.cli';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { IndustryClassificationPort } from '../../src/marketdata/industry-classification.port';
import type { AnnouncementPort } from '../../src/marketdata/announcement.port';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import type {
  AnnouncementDto,
  AnnouncementRangeQuery,
  EodBarPoint,
  EodBarQuery,
  IndustryClassificationDto,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';
// backfill 不传 backfillHistoryDays → announcement from 由 seed historyDepth(3650, ~10yr) 驱动 (公告可回填历史);
// industry_classification 覆盖式无 from (恒拉当前快照)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };

/** 043 2 分类文本维度 + sellput-viz us_equity_bar键 (US「2 维度 backfill 循环均 per-stock pace()」全工作集断言源)。 */
const CLASSIFICATION_DIMS: readonly DimensionKey[] = ['industry_classification', 'announcement'];

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  optionCoverageThreshold: 1,
};

/** 可控虚拟时钟: sleep 推进时间, 让回填自限速无需真等待即可断言 (镜像 038-042 pacing IT)。 */
function makeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    get t() {
      return t;
    },
  };
}

/** industry_classification fixture (hsi 3 级层级 L1/L2/L3, 覆盖式快照; NK (instrumentId,source,industryCode))。 */
const INDUSTRY_ROWS: IndustryClassificationDto[] = [
  { source: 'hsi', industryCode: 'H70', name: '金融业', areaCode: 'hk' },
  { source: 'hsi', industryCode: 'H7020', name: '银行', areaCode: 'hk' },
  { source: 'hsi', industryCode: 'H702015', name: '内银股', areaCode: 'hk' },
];

/** 多年 announcement fixture (跨年, date 升序; 含同 date 多 linkUrl + 缺 linkType/空 types; NK (instrumentId,date,linkUrl))。 */
const ANNOUNCEMENT_ROWS: AnnouncementDto[] = [
  {
    date: '2016-06-30',
    linkUrl: 'https://hkexnews.example/2016/mr.pdf',
    linkText: '2016 中期报告',
    linkType: 'PDF',
    types: ['fs'],
  },
  {
    date: '2020-06-30',
    linkUrl: 'https://hkexnews.example/2020/mr.pdf',
    linkText: '2020 中期报告',
    linkType: 'PDF',
    types: ['fs', 'mr'],
  },
  // 同 date 不同 linkUrl → NK (instrumentId,date,linkUrl) 两行各成行不折叠 (不丢真行)。
  {
    date: '2024-12-31',
    linkUrl: 'https://hkexnews.example/2024/ar.pdf',
    linkText: '2024 年度报告',
    linkType: 'PDF',
    types: ['fs'],
  },
  {
    date: '2024-12-31',
    linkUrl: 'https://hkexnews.example/2024/div.htm',
    linkText: null, // 缺 linkText → null
    linkType: null, // 缺 linkType → null
    types: [], // 空 types → []
  },
];

// 043 T011 US 回填 pacing + 续跑 + 无回归集成 IT (Testcontainers PG+Redis, test-local hk mock):
// 证 2 新分类文本维度回填温和安全 (industry_classification 覆盖式恒 per-stock pace / announcement backfill 各
// per-stock 自限速 + jitter 打散不触风控) + 中断按各自然键幂等续跑 (industry_classification (source,industryCode)
// 覆盖式原子替换 / announcement (date,linkUrl) skipDuplicates) + p1(6 维)/p2(039 5 维)/040(2 维)/041(4 维)/
// 042(3 维)/A股零回归。直调 registry.execute 测 pacer 层 (虚拟时钟, 无真等待); 经真 PG 落库/幂等/marketScope;
// 经真队列 (Redis worker concurrency=1) 测 CLI 单维度 job 续跑。覆盖 spec state_branches: 回填自限速续跑 /
// p1/p2/040/041/042/A股无回归 / 2 维度 marketScope 纳入 (全工作集)。
describe('043 T011 US 回填 pacing + 续跑 + 无回归 (Testcontainers PG+Redis, mock hk)', () => {
  let prisma: PrismaService;
  let lifecycle: QueueRedisLifecycle;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.DATABASE_URL = stores.databaseUrl;
    prisma = new PrismaService(stores.databaseUrl);
    await prisma.$connect();
    lifecycle = new QueueRedisLifecycle(stores.redisUrl);
  }, 180_000);

  afterAll(async () => {
    lifecycle?.onApplicationShutdown();
    await prisma?.$disconnect();
    await stores.drop();
  });

  beforeEach(async () => {
    await prisma.industryClassification.deleteMany();
    await prisma.announcement.deleteMany();
    await prisma.dailyBar.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // 043 2 新维度回 marketScope={hk} (港股专属信号); announcement history_depth=3650 (可回填),
    // industry_classification 覆盖式无历史 (history_depth 无关, seed NULL 保持)。p1 核心维度回 {cn,hk} + 清水位。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: [...CLASSIFICATION_DIMS] } },
      data: { marketScope: ['hk'] },
    });
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'announcement' },
      data: { historyDepth: 3650 },
    });
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['eod_bar', 'fundamental', 'financial', 'corporate_action'] } },
      data: { marketScope: ['cn', 'hk'], lastWatermark: null },
    });
    const q = new MarketdataSyncQueue(lifecycle.client, CFG);
    await q.queue.obliterate({ force: true });
    await q.queue.close();
  });

  /** eod bar fixture 行 (仅结构占位, 照 039-042 pacing IT)。 */
  function bar(tradeDate: string, adjust: EodBarPoint['adjust']): EodBarPoint {
    return {
      tradeDate,
      adjust,
      open: '1',
      high: '1',
      low: '1',
      close: '1',
      changePct: null,
      prevClose: null,
      volume: null,
      amount: null,
      turnoverRate: null,
    };
  }

  /** test-local eod 端口: served 集内标的返区间多行 (含 to); 集外 → []。 */
  class ServedEodMock implements EodBarPort {
    constructor(private readonly served: ReadonlySet<string>) {}
    async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
      if (!this.served.has(query.symbol)) return [];
      const to = query.to ?? AS_OF;
      const from = query.from ?? to;
      const candidates = from === to ? [to] : ['2026-05-15', '2026-05-29', to];
      return candidates.filter((d) => d >= from && d <= to).map((d) => bar(d, query.adjust));
    }
  }

  /** test-local hk industry_classification 端口: 记 calls; served 返 3 级层级快照, 集外 → []。 */
  class HkIndustryClassificationMock implements IndustryClassificationPort {
    readonly calls: string[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: IndustryClassificationDto[] = INDUSTRY_ROWS,
    ) {}
    async getIndustryClassification(symbol: string): Promise<IndustryClassificationDto[]> {
      this.calls.push(symbol);
      return this.served.has(symbol) ? this.rows : [];
    }
  }

  /** test-local hk announcement 端口: 记 rangeCalls; served 返多年公告流 (含同 date 多 linkUrl), 集外 → []。 */
  class HkAnnouncementMock implements AnnouncementPort {
    readonly rangeCalls: AnnouncementRangeQuery[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: AnnouncementDto[] = ANNOUNCEMENT_ROWS,
    ) {}
    async getAnnouncementRange(query: AnnouncementRangeQuery): Promise<AnnouncementDto[]> {
      this.rangeCalls.push(query);
      return this.served.has(query.symbol) ? this.rows : [];
    }
  }

  function buildRegistry(
    overrides: {
      pacer?: BackfillPacer;
      eodBar?: EodBarPort;
      industryClassification?: IndustryClassificationPort;
      announcement?: AnnouncementPort;
    } = {},
  ): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      overrides.eodBar ?? mock,
      mock, // fundamental
      mock, // financials
      mock, // corporateAction
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
      overrides.pacer ?? BackfillPacer.disabled(),
      mock, // shortSelling
      mock, // connectHolding
      mock, // fundHolding
      mock, // fundCompanyHolding
      mock, // indexMembership
      mock, // volatility
      mock, // hotSnapshot
      mock, // buyback
      mock, // equityChange
      mock, // shareholderChange
      mock, // allotment
      mock, // revenueSegment
      mock, // shareholderSnapshot
      mock, // employee
      overrides.industryClassification ?? mock, // industryClassification (arg 25)
      overrides.announcement ?? mock, // announcement (arg 26)
    );
  }

  function buildDeps(queue: MarketdataSyncQueue, events: QueueEvents): BackfillDeps {
    return {
      prisma,
      syncQueue: queue,
      queueEvents: events,
      cliWaitTimeoutMs: 60_000,
      backfillDefaultHistoryDays: 3650,
    };
  }

  /** seed 一只活跃标的 (currency 按 market)。 */
  async function seed(market: string, code: string): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: {
        market,
        code,
        name: `${market}-${code}`,
        type: 'stock',
        currency: market === 'hk' ? 'HKD' : 'CNY',
        status: 'active',
        lixingerCompanyType: 'non',
      },
    });
    return inst.id;
  }

  /** seed n 只 hk 标的, 返 canonical symbols。 */
  async function seedHk(n: number): Promise<string[]> {
    const symbols: string[] = [];
    for (let i = 1; i <= n; i++) {
      const code = `0000${i}`;
      await seed('hk', code);
      symbols.push(`hk:${code}`);
    }
    return symbols;
  }

  // ── ① 2 分类文本维度 hk backfill 各 per-stock 自限速 + marketScope 纳 hk 排除 cn (全工作集) ─────────
  it('① 2 分类文本维度 hk backfill 各 per-stock pace → sleeps=K-1, scanned=K (cn 被 marketScope 过滤), sustained ≤ 600/min', async () => {
    const K = 4;
    await seedHk(K); // 2 维度共用同 K 只 hk 工作集 (marketScope=hk)。
    await seed('cn', '600519'); // A 股 — 2 分类文本维度 marketScope=hk 不该扫它 (2 维全工作集 marketScope 纳入)。
    for (const dim of CLASSIFICATION_DIMS) {
      const clock = makeClock(0);
      // enabled pacer 600/min (base=100ms), jitter=0 隔离基础节流, 注入虚拟时钟。
      const pacer = new BackfillPacer(
        { targetPerMin: 600, jitterMs: 0 },
        clock.now,
        clock.sleep,
        () => 0,
      );
      const reg = buildRegistry({ pacer });

      const { stats } = await reg.execute(dim, backfillInput);

      // K 只各 pace 一次 (industry_classification 覆盖式恒 pace / announcement backfill 每股 pace): 首个免等 +
      // 其余 K-1 各 sleep 100ms (base) → 回填循环每股都 pace 得证。
      expect(clock.sleeps.length, `${dim} 应 per-stock pace`).toBe(K - 1);
      expect(clock.t).toBeGreaterThanOrEqual((K - 1) * 100);
      // 稳态速率 ≤ 目标 600/min = 不触 vendor 分钟级封禁 (429) 的机制保证。
      const sustainedPerMin = (K - 1) / (clock.t / 60_000);
      expect(sustainedPerMin).toBeLessThanOrEqual(600 + 1e-6);
      // 只 hk K 只进工作集 (cn 被 marketScope=hk 过滤); 默认 mock hk 无 fixture → 空返回 (计 ok 非 failed)。
      expect(stats, `${dim} 只 hk K 只进工作集`).toMatchObject({ scanned: K, failed: 0 });
    }
  });

  // ── ② jitter 打散: announcement 每股节流间隔非等距 → 规避等间隔机器人特征 ────────────────────
  it('② jitter 打散: announcement backfill 每股节流间隔非等距 (base + 随机 jitter)', async () => {
    const K = 4;
    await seedHk(K);
    const clock = makeClock(0);
    // 递增 random 序列 → 每次 jitter 不同 → sleep 值随之打散 (非全等距)。
    const randSeq = [0, 0.5, 1.0];
    let ri = 0;
    const pacer = new BackfillPacer(
      { targetPerMin: 600, jitterMs: 40 },
      clock.now,
      clock.sleep,
      () => randSeq[ri++ % randSeq.length],
    );
    const reg = buildRegistry({ pacer });

    await reg.execute('announcement', backfillInput);

    // K-1 次 sleep, 各 = base(100) + jitter(∈[0,40]); random 变化 → 至少两种不同间隔值 (打散)。
    expect(clock.sleeps.length).toBe(K - 1);
    expect(new Set(clock.sleeps).size).toBeGreaterThan(1);
    // jitter 只增不减 → 每次间隔恒 ≥ base → 有效速率恒 ≤ 目标 (打散不破坏限速上界)。
    expect(Math.min(...clock.sleeps)).toBeGreaterThanOrEqual(100);
  });

  // ── ③ 中断后各自然键幂等续跑: 2 维度连跑两次不翻倍 (覆盖式替换 / skipDuplicates 折叠) ──
  it('③ 中断后自然键幂等续跑: industry_classification 覆盖式替换 + announcement (date,linkUrl) 连跑两次不翻倍', async () => {
    const instId = await seed('hk', '00700');
    const served = new Set(['hk:00700']);

    // industry_classification 覆盖式 (instrumentId,source,industryCode): 连跑两次 (中间清 syncRun 模拟中断续跑) →
    // deleteMany+createMany 原子替换, 旧归属被当前快照整体换掉, 不翻倍。
    const icReg = buildRegistry({
      industryClassification: new HkIndustryClassificationMock(served),
    });
    await icReg.execute('industry_classification', backfillInput);
    const icAfter1 = await prisma.industryClassification.count({ where: { instrumentId: instId } });
    expect(icAfter1).toBe(INDUSTRY_ROWS.length); // 3 级层级 3 行
    await prisma.syncRun.deleteMany();
    await icReg.execute('industry_classification', backfillInput); // 续跑 (覆盖式替换)
    expect(await prisma.industryClassification.count({ where: { instrumentId: instId } })).toBe(
      icAfter1,
    );

    // announcement 自然键 (instrumentId,date,linkUrl): 连跑两次 → skipDuplicates 不翻倍 (同 date 不同 linkUrl
    // 两行各成行保留、跨次不翻倍)。
    const annReg = buildRegistry({ announcement: new HkAnnouncementMock(served) });
    await annReg.execute('announcement', backfillInput);
    const annAfter1 = await prisma.announcement.count({ where: { instrumentId: instId } });
    expect(annAfter1).toBe(ANNOUNCEMENT_ROWS.length); // 4 行 (含 2024-12-31 两 linkUrl 各成行)
    await prisma.syncRun.deleteMany();
    await annReg.execute('announcement', backfillInput); // 续跑
    expect(await prisma.announcement.count({ where: { instrumentId: instId } })).toBe(annAfter1);
  });

  // ── ④ p1/A股无回归 + 2 维度 marketScope 纳入: 新维度只作用 hk, p1 eod_bar cn+hk 行为不变 ──
  it('④ p1/A股无回归: eod_bar 落 cn+hk (marketScope 不变) / announcement 只 hk、cn 不进工作集、零 rangeCall', async () => {
    const cnId = await seed('cn', '600519'); // A 股 — 043 维度 marketScope=hk 不该扫它
    const hkId = await seed('hk', '00700');

    // p1 eod_bar (marketScope=[cn,hk]): backfill 对 cn+hk 都落 DailyBar → 核心维度行为零回归。
    const eodMock = new ServedEodMock(new Set(['cn:600519', 'hk:00700']));
    await buildRegistry({ eodBar: eodMock }).execute('eod_bar', backfillInput);
    expect(await prisma.dailyBar.count({ where: { instrumentId: cnId } })).toBeGreaterThan(0);
    expect(await prisma.dailyBar.count({ where: { instrumentId: hkId } })).toBeGreaterThan(0);

    // 043 announcement (marketScope=[hk]): 工作集只 hk → cn 从不被 rangeCall (A股无回归), 只 hk 落库。
    const announcement = new HkAnnouncementMock(new Set(['hk:00700', 'cn:600519'])); // 即便 served cn 也不该被请求
    const { stats } = await buildRegistry({ announcement }).execute('announcement', backfillInput);
    expect(stats.scanned).toBe(1); // 只 hk 一只进工作集 (cn 被 marketScope 过滤掉)
    expect(announcement.rangeCalls.map((c) => c.symbol)).toEqual(['hk:00700']); // cn:600519 从不被请求
    expect(await prisma.announcement.count({ where: { instrumentId: cnId } })).toBe(0); // A股零行
    expect(await prisma.announcement.count({ where: { instrumentId: hkId } })).toBe(
      ANNOUNCEMENT_ROWS.length,
    );
  });

  // ── ⑤ 经真队列 (Redis worker) CLI 单维度 job 续跑幂等 (回填自限速续跑, 经真调度面) ──────────
  it('⑤ announcement backfill 经队列 CLI 连跑两次 → concurrency=1 续跑不翻倍 (自然键幂等)', async () => {
    const instId = await seed('hk', '00700');
    const announcement = new HkAnnouncementMock(new Set(['hk:00700']));
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry({ announcement }),
      queue,
      CFG,
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const run = () =>
        executeBackfill(
          buildDeps(queue, events),
          { dryRun: false, dimension: 'announcement', historyDepth: 3650, markets: ['hk'] },
          NOW,
        );

      expect(await run()).toBe(0);
      const after1 = await prisma.announcement.count({ where: { instrumentId: instId } });
      expect(after1).toBe(ANNOUNCEMENT_ROWS.length);

      await prisma.syncRun.deleteMany();
      expect(await run()).toBe(0); // 下一夜续跑
      expect(await prisma.announcement.count({ where: { instrumentId: instId } })).toBe(after1);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });
});
