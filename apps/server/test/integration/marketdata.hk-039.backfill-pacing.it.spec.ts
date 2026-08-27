import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { coldStartUnused } from '../_support/cold-start-stub';
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
} from '../../src/marketdata/marketdata-sync.queue';
import { MarketdataSyncWorker } from '../../src/marketdata/marketdata-sync.worker';
import { executeBackfill, type BackfillDeps } from '../../src/marketdata/marketdata-backfill.cli';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { ShortSellingPort } from '../../src/marketdata/short-selling.port';
import type { IndexMembershipPort } from '../../src/marketdata/index-membership.port';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import type {
  EodBarPoint,
  EodBarQuery,
  IndexMembershipDto,
  ShortSellingPoint,
  ShortSellingRangeQuery,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';
const backfillInput = {
  mode: 'backfill' as const,
  asOf: AS_OF,
  now: NOW,
  backfillHistoryDays: 365,
};

/** 039 5 新量化维度键 (US4「5 维度 backfill 循环均 pace()」全工作集断言源)。 */
const QUANT_DIMS: readonly DimensionKey[] = [
  'short_selling',
  'connect_holding',
  'fund_holding',
  'fund_company_holding',
  'index_membership',
];

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  futuLaneEnabled: false, // 灰度默认关 ⇒ 全部 job 落 default lane (拆 lane 前的行为)。
  optionCoverageThreshold: 1,
};

/** 可控虚拟时钟: sleep 推进时间, 让回填自限速无需真等待即可断言 (镜像 038 pacing IT)。 */
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

// 039 T018 US4 回填 pacing + 续跑 + 无回归集成 IT (Testcontainers PG+Redis, test-local hk mock):
// 证 5 新量化维度回填温和安全 (自限速 + jitter 打散不触风控) + 中断续跑幂等 + p1/A股零回归。
// 直调 registry.execute 测 pacer 层 (虚拟时钟, 无真等待); 经真 PG 落库/幂等/marketScope; 经真队列
// (Redis worker concurrency=1) 测 CLI 单维度 job 续跑。覆盖 spec state_branches:
//   回填自限速续跑 / p1/A股无回归 / 5 维度 marketScope 纳入 (全工作集)。
describe('039 T018 US4 回填 pacing + 续跑 + 无回归 (Testcontainers PG+Redis, mock hk)', () => {
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
    await prisma.dailyBar.deleteMany();
    await prisma.shortSellingDaily.deleteMany();
    await prisma.connectHoldingDaily.deleteMany();
    await prisma.fundHolding.deleteMany();
    await prisma.fundCompanyHolding.deleteMany();
    await prisma.indexMembership.deleteMany();
    await prisma.corporateAction.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // 5 新维度回 marketScope={hk} (港股专属信号); p1 6 维回 {cn,hk} (T003 已扩) + 清水位 — 各例独立基线。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: [...QUANT_DIMS] } },
      data: { marketScope: ['hk'] },
    });
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['eod_bar', 'fundamental', 'financial', 'corporate_action'] } },
      data: { marketScope: ['cn', 'hk'], lastWatermark: null },
    });
    const q = new MarketdataSyncQueue(lifecycle.client, CFG);
    await q.queue.obliterate({ force: true });
    await q.queue.close();
  });

  /** eod bar fixture 行 (仅结构占位, 照 038 pacing IT)。 */
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

  /** test-local hk short_selling 端口: 记 rangeCalls; served 返 3 行日频, 集外 → []。 */
  class HkShortSellingMock implements ShortSellingPort {
    readonly rangeCalls: ShortSellingRangeQuery[] = [];
    constructor(private readonly served: ReadonlySet<string>) {}
    async getShortSellingRange(query: ShortSellingRangeQuery): Promise<ShortSellingPoint[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return ['2016-06-15', '2020-06-15', '2026-05-15'].map((date, i) => ({
        date,
        shares: `${1831500 + i}`,
        amount: `${915201080 + i}.00`,
      }));
    }
  }

  /** test-local hk index_membership 端口: served 返固定 snapshot; 集外 → []。 */
  class HkIndexMembershipMock implements IndexMembershipPort {
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly snapshot: IndexMembershipDto[],
    ) {}
    async getIndexMembership(symbol: string): Promise<IndexMembershipDto[]> {
      if (!this.served.has(symbol)) return [];
      return this.snapshot;
    }
  }

  function buildRegistry(
    overrides: {
      pacer?: BackfillPacer;
      eodBar?: EodBarPort;
      shortSelling?: ShortSellingPort;
      indexMembership?: IndexMembershipPort;
    } = {},
  ): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      overrides.eodBar ?? mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
      overrides.pacer ?? BackfillPacer.disabled(),
      overrides.shortSelling ?? mock,
      mock, // connectHolding
      mock, // fundHolding
      mock, // fundCompanyHolding
      overrides.indexMembership ?? mock,
    );
  }

  function buildDeps(queue: MarketdataSyncQueue, events: QueueEvents): BackfillDeps {
    return {
      prisma,
      syncQueue: queue,
      queueEventsFor: () => events,
      cliWaitTimeoutMs: 60_000,
      backfillDefaultHistoryDays: 365,
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

  // ── ① 5 新维度 hk backfill 均 per-stock 自限速 (回填自限速: 循环每股 pace) ──────────
  it('① 5 新维度 hk backfill 各 per-stock 自限速 → sleeps=K-1, 有效 sustained ≤ 600/min', async () => {
    const K = 4;
    await seedHk(K); // 5 维度共用同 K 只 hk 工作集 (marketScope=hk)。
    for (const dim of QUANT_DIMS) {
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

      // K 只各 pace 一次: 首个免等 + 其余 K-1 各 sleep 100ms (base) → 循环每股都 pace 得证。
      expect(clock.sleeps.length, `${dim} 应 per-stock pace`).toBe(K - 1);
      expect(clock.t).toBeGreaterThanOrEqual((K - 1) * 100);
      // 稳态速率 ≤ 目标 600/min = 不触 vendor 分钟级封禁 (429) 的机制保证。
      const sustainedPerMin = (K - 1) / (clock.t / 60_000);
      expect(sustainedPerMin).toBeLessThanOrEqual(600 + 1e-6);
      // mock hk 无 fixture → 空返回 (计 ok 非 failed), 但全 K 只都 scanned+pace (pace 在 vendor 调用前)。
      expect(stats).toMatchObject({ scanned: K, failed: 0 });
    }
  });

  // ── ② jitter 打散: 调用间隔非等距 → 规避等间隔机器人特征 ────────────────────────
  it('② jitter 打散: backfill 每股节流间隔非等距 (base + 随机 jitter)', async () => {
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

    await reg.execute('short_selling', backfillInput);

    // K-1 次 sleep, 各 = base(100) + jitter(∈[0,40]); random 变化 → 至少两种不同间隔值 (打散)。
    expect(clock.sleeps.length).toBe(K - 1);
    expect(new Set(clock.sleeps).size).toBeGreaterThan(1);
    // jitter 只增不减 → 每次间隔恒 ≥ base → 有效速率恒 ≤ 目标 (打散不破坏限速上界)。
    expect(Math.min(...clock.sleeps)).toBeGreaterThanOrEqual(100);
  });

  // ── ③ 中断后自然键幂等续跑: 日频 + 覆盖式两形态连跑不重复 ──────────────────────
  it('③ 中断后自然键幂等续跑: short_selling(日频) + index_membership(覆盖式) 连跑两次不翻倍', async () => {
    const instId = await seed('hk', '00700');
    const shortSelling = new HkShortSellingMock(new Set(['hk:00700']));
    const indexMembership = new HkIndexMembershipMock(new Set(['hk:00700']), [
      { indexCode: '1000001', name: '恒生指数', source: 'lxri', areaCode: 'hk' },
      { indexCode: '1000015', name: '港股全指', source: 'lxri', areaCode: 'hk' },
    ]);
    const reg = buildRegistry({ shortSelling, indexMembership });

    // 日频自然键 (instrumentId,date): 连跑两次 (中间清 syncRun 模拟中断续跑) → createMany skipDuplicates 不翻倍。
    await reg.execute('short_selling', backfillInput);
    const after1 = await prisma.shortSellingDaily.count({ where: { instrumentId: instId } });
    expect(after1).toBe(3);
    await prisma.syncRun.deleteMany();
    await reg.execute('short_selling', backfillInput); // 续跑
    expect(await prisma.shortSellingDaily.count({ where: { instrumentId: instId } })).toBe(after1);

    // 覆盖式 (deleteMany+createMany 同集合): 连跑两次 → 反映同快照零净增。
    await reg.execute('index_membership', backfillInput);
    const idx1 = await prisma.indexMembership.count({ where: { instrumentId: instId } });
    expect(idx1).toBe(2);
    await prisma.syncRun.deleteMany();
    await reg.execute('index_membership', backfillInput); // 续跑
    expect(await prisma.indexMembership.count({ where: { instrumentId: instId } })).toBe(idx1);
  });

  // ── ④ p1/A股无回归 + 5 维度 marketScope 纳入: 新维度只作用 hk, p1 六维 cn+hk 行为不变 ──
  it('④ p1/A股无回归: eod_bar 落 cn+hk (marketScope 不变) / short_selling 只 hk、cn 不进工作集', async () => {
    const cnId = await seed('cn', '600519'); // A 股 (MockMarketDataAdapter 对其有 fixture — 但新维度 marketScope=hk 不该扫它)
    const hkId = await seed('hk', '00700');

    // p1 eod_bar (marketScope=[cn,hk]): backfill 对 cn+hk 都落 DailyBar → 6 维行为零回归。
    const eodMock = new ServedEodMock(new Set(['cn:600519', 'hk:00700']));
    await buildRegistry({ eodBar: eodMock }).execute('eod_bar', backfillInput);
    expect(await prisma.dailyBar.count({ where: { instrumentId: cnId } })).toBeGreaterThan(0);
    expect(await prisma.dailyBar.count({ where: { instrumentId: hkId } })).toBeGreaterThan(0);

    // 新维度 short_selling (marketScope=[hk]): 工作集只 hk → cn 从不被 rangeCall (A股无回归), 只 hk 落库。
    const shortSelling = new HkShortSellingMock(new Set(['hk:00700']));
    const { stats } = await buildRegistry({ shortSelling }).execute('short_selling', backfillInput);
    expect(stats.scanned).toBe(1); // 只 hk 一只进工作集 (cn 被 marketScope 过滤掉)
    expect(shortSelling.rangeCalls.map((c) => c.symbol)).toEqual(['hk:00700']); // cn:600519 从不被请求
    expect(await prisma.shortSellingDaily.count({ where: { instrumentId: cnId } })).toBe(0); // A股零行
    expect(await prisma.shortSellingDaily.count({ where: { instrumentId: hkId } })).toBe(3);
  });

  // ── ⑤ 经真队列 (Redis worker) CLI 单维度 job 续跑幂等 ───────────────────────────
  it('⑤ short_selling backfill 经队列 CLI 连跑两次 → concurrency=1 续跑不翻倍 (自然键幂等)', async () => {
    const instId = await seed('hk', '00700');
    const shortSelling = new HkShortSellingMock(new Set(['hk:00700']));
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry({ shortSelling }),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const run = () =>
        executeBackfill(
          buildDeps(queue, events),
          { dryRun: false, dimension: 'short_selling', historyDepth: 365, markets: ['hk'] },
          NOW,
        );

      expect(await run()).toBe(0);
      const after1 = await prisma.shortSellingDaily.count({ where: { instrumentId: instId } });
      expect(after1).toBe(3);

      await prisma.syncRun.deleteMany();
      expect(await run()).toBe(0); // 下一夜续跑
      expect(await prisma.shortSellingDaily.count({ where: { instrumentId: instId } })).toBe(
        after1,
      );
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });
});
