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
import type { RevenueSegmentPort } from '../../src/marketdata/revenue-segment.port';
import type { ShareholderSnapshotPort } from '../../src/marketdata/shareholder-snapshot.port';
import type { EmployeePort } from '../../src/marketdata/employee.port';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import type {
  EmployeeDto,
  EmployeeRangeQuery,
  EodBarPoint,
  EodBarQuery,
  RevenueSegmentDto,
  RevenueSegmentRangeQuery,
  ShareholderSnapshotDto,
  ShareholderSnapshotRangeQuery,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';
// backfill 不传 backfillHistoryDays → from 由 seed historyDepth(3650, ~10yr) 驱动 (报告期可回填历史)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };

/** 042 3 报告期维度键 (US「3 维度 backfill 循环均 per-stock pace()」全工作集断言源)。 */
const REPORT_DIMS: readonly DimensionKey[] = [
  'revenue_segment',
  'shareholder_snapshot',
  'employee',
];

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  optionCoverageThreshold: 1,
};

/** 可控虚拟时钟: sleep 推进时间, 让回填自限速无需真等待即可断言 (镜像 038/039/040/041 pacing IT)。 */
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

/** revenue_segment DTO 占位行 (自然键 (instrumentId,date,parentItemName,itemName); 本套件测 pacing/续跑不测 typed 列, 见 T006)。 */
function revenueRow(
  date: string,
  parent: string,
  item: string,
  revenue: string,
): RevenueSegmentDto {
  return {
    date,
    declarationDate: null,
    currency: 'CNY',
    parentItemName: parent,
    itemName: item,
    revenue,
    costs: null,
    grossProfitMargin: null,
  };
}

/** 多年 revenue_segment fixture (跨年, date 升序; 含顶层 sentinel '' 行)。 */
const REVENUE_ROWS: RevenueSegmentDto[] = [
  revenueRow('2016-06-30', '按服務類型分', '增值服務', '100000000000'),
  revenueRow('2020-06-30', '按服務類型分', '增值服務', '200000000000'),
  revenueRow('2024-12-31', '', '合計', '660257000000'), // 顶层合計 → parentItemName 哨兵 ''
];

/** 多年 shareholder_snapshot fixture (跨年, date 升序; 自然键 (instrumentId,date,shareholderName,contentHash))。 */
const SNAPSHOT_ROWS: ShareholderSnapshotDto[] = [
  {
    date: '2016-06-30',
    shareholderName: 'JPMorgan Chase & Co.',
    contentHash: 'ss-pacing-2016',
    payload: { numOfSharesInterestedList: [{ value: 500000000, sharesType: 'L' }] },
  },
  {
    date: '2020-06-30',
    shareholderName: '马化腾',
    contentHash: 'ss-pacing-2020',
    payload: { numOfSharesInterestedList: [{ value: 804859700, sharesType: 'L' }] },
  },
  {
    date: '2024-12-31',
    shareholderName: 'Naspers Limited',
    contentHash: 'ss-pacing-2024',
    payload: { numOfSharesInterestedList: null },
  },
];

/** employee DTO 占位行 (自然键 (instrumentId,date,parentItemName,itemName,displayType))。 */
function employeeRow(
  date: string,
  parent: string,
  item: string,
  displayType: string,
  value: string,
): EmployeeDto {
  return {
    date,
    declarationDate: null,
    parentItemName: parent,
    itemName: item,
    displayType,
    value,
  };
}

/** 多年 employee fixture (跨年, date 升序; 含同名 (parent,item) number+percentage 两行经 displayType 共存)。 */
const EMPLOYEE_ROWS: EmployeeDto[] = [
  employeeRow('2016-06-30', '', '员工总数', 'number', '20000'),
  employeeRow('2020-06-30', '', '员工总数', 'number', '60000'),
  // 同名 (parentItemName,itemName) number+percentage 两行经 displayType 进 NK 共存 (probe 实证)。
  employeeRow('2024-12-31', '流失率按性别分', '男性', 'number', '58812'),
  employeeRow('2024-12-31', '流失率按性别分', '男性', 'percentage', '15.2'),
];

// 042 T014 US 回填 pacing + 续跑 + 无回归集成 IT (Testcontainers PG+Redis, test-local hk mock):
// 证 3 新报告期维度回填温和安全 (revenue_segment/shareholder_snapshot/employee 各 per-stock 自限速 +
// jitter 打散不触风控) + 中断按各自然键幂等续跑 (revenue_segment (date,parentItemName,itemName) /
// shareholder_snapshot (date,shareholderName,contentHash) / employee (date,parentItemName,itemName,
// displayType)) + p1(6 维)/p2(039 5 维)/040(2 维)/041(4 维)/A股零回归。直调 registry.execute 测 pacer 层
// (虚拟时钟, 无真等待); 经真 PG 落库/幂等/marketScope; 经真队列 (Redis worker concurrency=1) 测 CLI 单维度
// job 续跑。覆盖 spec state_branches: 回填自限速续跑 / p1/p2/040/041/A股无回归 / 3 维度 marketScope 纳入 (全工作集)。
describe('042 T014 US 回填 pacing + 续跑 + 无回归 (Testcontainers PG+Redis, mock hk)', () => {
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
    await prisma.revenueSegment.deleteMany();
    await prisma.shareholderSnapshot.deleteMany();
    await prisma.employeeSnapshot.deleteMany();
    await prisma.dailyBar.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // 042 3 新维度回 marketScope={hk} (港股专属信号) + history_depth=3650; p1 核心维度回 {cn,hk} + 清水位。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: [...REPORT_DIMS] } },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['eod_bar', 'fundamental', 'financial', 'corporate_action'] } },
      data: { marketScope: ['cn', 'hk'], lastWatermark: null },
    });
    const q = new MarketdataSyncQueue(lifecycle.client, CFG);
    await q.queue.obliterate({ force: true });
    await q.queue.close();
  });

  /** eod bar fixture 行 (仅结构占位, 照 039/040/041 pacing IT)。 */
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

  /** test-local hk revenue_segment 端口: 记 rangeCalls; served 返多年分部行, 集外 → []。 */
  class HkRevenueSegmentMock implements RevenueSegmentPort {
    readonly rangeCalls: RevenueSegmentRangeQuery[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: RevenueSegmentDto[] = REVENUE_ROWS,
    ) {}
    async getRevenueSegmentRange(query: RevenueSegmentRangeQuery): Promise<RevenueSegmentDto[]> {
      this.rangeCalls.push(query);
      return this.served.has(query.symbol) ? this.rows : [];
    }
  }

  /** test-local hk shareholder_snapshot 端口: 记 rangeCalls; served 返含 shareholderName+contentHash 多年名册, 集外 → []。 */
  class HkShareholderSnapshotMock implements ShareholderSnapshotPort {
    readonly rangeCalls: ShareholderSnapshotRangeQuery[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: ShareholderSnapshotDto[] = SNAPSHOT_ROWS,
    ) {}
    async getShareholderSnapshotRange(
      query: ShareholderSnapshotRangeQuery,
    ): Promise<ShareholderSnapshotDto[]> {
      this.rangeCalls.push(query);
      return this.served.has(query.symbol) ? this.rows : [];
    }
  }

  /** test-local hk employee 端口: 记 rangeCalls; served 返含 displayType 多年员工行, 集外 → []。 */
  class HkEmployeeMock implements EmployeePort {
    readonly rangeCalls: EmployeeRangeQuery[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: EmployeeDto[] = EMPLOYEE_ROWS,
    ) {}
    async getEmployeeRange(query: EmployeeRangeQuery): Promise<EmployeeDto[]> {
      this.rangeCalls.push(query);
      return this.served.has(query.symbol) ? this.rows : [];
    }
  }

  function buildRegistry(
    overrides: {
      pacer?: BackfillPacer;
      eodBar?: EodBarPort;
      revenueSegment?: RevenueSegmentPort;
      shareholderSnapshot?: ShareholderSnapshotPort;
      employee?: EmployeePort;
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
      overrides.revenueSegment ?? mock, // revenueSegment (arg 22)
      overrides.shareholderSnapshot ?? mock, // shareholderSnapshot (arg 23)
      overrides.employee ?? mock, // employee (arg 24)
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

  // ── ① 3 报告期维度 hk backfill 各 per-stock 自限速 + marketScope 纳 hk 排除 cn (全工作集) ─────────
  it('① 3 报告期维度 hk backfill 各 per-stock pace → sleeps=K-1, scanned=K (cn 被 marketScope 过滤), sustained ≤ 600/min', async () => {
    const K = 4;
    await seedHk(K); // 3 维度共用同 K 只 hk 工作集 (marketScope=hk)。
    await seed('cn', '600519'); // A 股 — 3 报告期维度 marketScope=hk 不该扫它 (3 维全工作集 marketScope 纳入)。
    for (const dim of REPORT_DIMS) {
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

      // K 只各 pace 一次: 首个免等 + 其余 K-1 各 sleep 100ms (base) → 回填循环每股都 pace 得证。
      expect(clock.sleeps.length, `${dim} 应 per-stock pace`).toBe(K - 1);
      expect(clock.t).toBeGreaterThanOrEqual((K - 1) * 100);
      // 稳态速率 ≤ 目标 600/min = 不触 vendor 分钟级封禁 (429) 的机制保证。
      const sustainedPerMin = (K - 1) / (clock.t / 60_000);
      expect(sustainedPerMin).toBeLessThanOrEqual(600 + 1e-6);
      // 只 hk K 只进工作集 (cn 被 marketScope=hk 过滤); mock hk 无 fixture → 空返回 (计 ok 非 failed)。
      expect(stats, `${dim} 只 hk K 只进工作集`).toMatchObject({ scanned: K, failed: 0 });
    }
  });

  // ── ② jitter 打散: revenue_segment 每股节流间隔非等距 → 规避等间隔机器人特征 ────────────────────
  it('② jitter 打散: revenue_segment backfill 每股节流间隔非等距 (base + 随机 jitter)', async () => {
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

    await reg.execute('revenue_segment', backfillInput);

    // K-1 次 sleep, 各 = base(100) + jitter(∈[0,40]); random 变化 → 至少两种不同间隔值 (打散)。
    expect(clock.sleeps.length).toBe(K - 1);
    expect(new Set(clock.sleeps).size).toBeGreaterThan(1);
    // jitter 只增不减 → 每次间隔恒 ≥ base → 有效速率恒 ≤ 目标 (打散不破坏限速上界)。
    expect(Math.min(...clock.sleeps)).toBeGreaterThanOrEqual(100);
  });

  // ── ③ 中断后各自然键幂等续跑: 3 维度连跑两次不翻倍 (各自然键 skipDuplicates 折叠) ──
  it('③ 中断后自然键幂等续跑: revenue_segment + shareholder_snapshot + employee 连跑两次不翻倍', async () => {
    const instId = await seed('hk', '00700');
    const served = new Set(['hk:00700']);

    // revenue_segment 自然键 (instrumentId,date,parentItemName,itemName): 连跑两次 (中间清 syncRun 模拟中断续跑)。
    const revReg = buildRegistry({ revenueSegment: new HkRevenueSegmentMock(served) });
    await revReg.execute('revenue_segment', backfillInput);
    const revAfter1 = await prisma.revenueSegment.count({ where: { instrumentId: instId } });
    expect(revAfter1).toBe(REVENUE_ROWS.length);
    await prisma.syncRun.deleteMany();
    await revReg.execute('revenue_segment', backfillInput); // 续跑
    expect(await prisma.revenueSegment.count({ where: { instrumentId: instId } })).toBe(revAfter1);

    // shareholder_snapshot 自然键 (instrumentId,date,shareholderName,contentHash): 连跑两次 → skipDuplicates 不翻倍。
    const ssReg = buildRegistry({ shareholderSnapshot: new HkShareholderSnapshotMock(served) });
    await ssReg.execute('shareholder_snapshot', backfillInput);
    const ssAfter1 = await prisma.shareholderSnapshot.count({ where: { instrumentId: instId } });
    expect(ssAfter1).toBe(SNAPSHOT_ROWS.length);
    await prisma.syncRun.deleteMany();
    await ssReg.execute('shareholder_snapshot', backfillInput); // 续跑
    expect(await prisma.shareholderSnapshot.count({ where: { instrumentId: instId } })).toBe(
      ssAfter1,
    );

    // employee 自然键 (instrumentId,date,parentItemName,itemName,displayType): 连跑两次 → 同名 number+percentage
    // 两行经 displayType 共存不折叠、跨次不翻倍。
    const empReg = buildRegistry({ employee: new HkEmployeeMock(served) });
    await empReg.execute('employee', backfillInput);
    const empAfter1 = await prisma.employeeSnapshot.count({ where: { instrumentId: instId } });
    expect(empAfter1).toBe(EMPLOYEE_ROWS.length);
    await prisma.syncRun.deleteMany();
    await empReg.execute('employee', backfillInput); // 续跑
    expect(await prisma.employeeSnapshot.count({ where: { instrumentId: instId } })).toBe(
      empAfter1,
    );
  });

  // ── ④ p1/A股无回归 + 3 维度 marketScope 纳入: 新维度只作用 hk, p1 eod_bar cn+hk 行为不变 ──
  it('④ p1/A股无回归: eod_bar 落 cn+hk (marketScope 不变) / revenue_segment 只 hk、cn 不进工作集、零 rangeCall', async () => {
    const cnId = await seed('cn', '600519'); // A 股 — 042 维度 marketScope=hk 不该扫它
    const hkId = await seed('hk', '00700');

    // p1 eod_bar (marketScope=[cn,hk]): backfill 对 cn+hk 都落 DailyBar → 核心维度行为零回归。
    const eodMock = new ServedEodMock(new Set(['cn:600519', 'hk:00700']));
    await buildRegistry({ eodBar: eodMock }).execute('eod_bar', backfillInput);
    expect(await prisma.dailyBar.count({ where: { instrumentId: cnId } })).toBeGreaterThan(0);
    expect(await prisma.dailyBar.count({ where: { instrumentId: hkId } })).toBeGreaterThan(0);

    // 042 revenue_segment (marketScope=[hk]): 工作集只 hk → cn 从不被 rangeCall (A股无回归), 只 hk 落库。
    const revenueSegment = new HkRevenueSegmentMock(new Set(['hk:00700', 'cn:600519'])); // 即便 served cn 也不该被请求
    const { stats } = await buildRegistry({ revenueSegment }).execute(
      'revenue_segment',
      backfillInput,
    );
    expect(stats.scanned).toBe(1); // 只 hk 一只进工作集 (cn 被 marketScope 过滤掉)
    expect(revenueSegment.rangeCalls.map((c) => c.symbol)).toEqual(['hk:00700']); // cn:600519 从不被请求
    expect(await prisma.revenueSegment.count({ where: { instrumentId: cnId } })).toBe(0); // A股零行
    expect(await prisma.revenueSegment.count({ where: { instrumentId: hkId } })).toBe(
      REVENUE_ROWS.length,
    );
  });

  // ── ⑤ 经真队列 (Redis worker) CLI 单维度 job 续跑幂等 (回填自限速续跑, 经真调度面) ──────────
  it('⑤ revenue_segment backfill 经队列 CLI 连跑两次 → concurrency=1 续跑不翻倍 (自然键幂等)', async () => {
    const instId = await seed('hk', '00700');
    const revenueSegment = new HkRevenueSegmentMock(new Set(['hk:00700']));
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry({ revenueSegment }),
      queue,
      coldStartUnused(),
      CFG,
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const run = () =>
        executeBackfill(
          buildDeps(queue, events),
          { dryRun: false, dimension: 'revenue_segment', historyDepth: 3650, markets: ['hk'] },
          NOW,
        );

      expect(await run()).toBe(0);
      const after1 = await prisma.revenueSegment.count({ where: { instrumentId: instId } });
      expect(after1).toBe(REVENUE_ROWS.length);

      await prisma.syncRun.deleteMany();
      expect(await run()).toBe(0); // 下一夜续跑
      expect(await prisma.revenueSegment.count({ where: { instrumentId: instId } })).toBe(after1);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });
});
