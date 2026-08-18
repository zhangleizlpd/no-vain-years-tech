import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { setupIsolatedStores } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { SyncTickDriver } from '../../src/marketdata/sync-tick-driver';
import { CalendarHitCheck } from '../../src/marketdata/calendar-hit-check';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import { MarketdataSyncQueue } from '../../src/marketdata/marketdata-sync.queue';
import { DIMENSION_KEYS } from '../../src/marketdata/dimension-executor';
import type { TradingCalendarPort } from '../../src/marketdata/trading-calendar.port';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

// 2026-06-03 = 周三, 20:00 Asia/Shanghai (22:00 cron 触发前) — 控时锚。
const NOW = new Date('2026-06-03T12:00:00Z');
// daily '0 0 22 * * *' 从 NOW 算的下一触发 = 今日 22:00 Shanghai = 14:00Z。
const NEXT_FROM_NOW = new Date('2026-06-03T14:00:00Z');

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false, // 灰度 flag 默认关 (handleCron 短路面; tick() 直调不受 flag 门)。
  optionCoverageThreshold: 1,
};

/** 交易日 gate stub (纯端口, 组 flow 前短路零 vendor 调用)。 */
const calendarStub = (open: boolean): TradingCalendarPort => ({
  classify: async () => (open ? 'trading' : 'non-trading'),
  lastClosedSession: async () => null,
});

/** per-market 交易日 gate stub (S2-T1): 按 market 返开市与否, 未列市场视为休市。 */
const calendarStubByMarket = (open: Record<string, boolean>): TradingCalendarPort => ({
  classify: async (market: string) => (open[market] === true ? 'trading' : 'non-trading'),
  lastClosedSession: async () => null,
});

// 017 T013 tick 核心 IT (Testcontainers PG, 控时 = 注入 now + 直接操纵 nextFireAt 列):
// (a) NULL 懒初始化不入队 / (b) 条件 UPDATE 抢占 affected-count won-lost / (c) misfire
// 双策略分流。computeNext from now (misfire≠backfill, FR-S04 专项)。
describe('017 T013 SyncTickDriver.claim (NULL 懒初始化 + 抢占 + misfire 分流)', () => {
  let prisma: PrismaService;
  let driver: SyncTickDriver;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    // claim 不触队列/日历 → stub 注入 (tick 接线面见 T014 describe)。
    driver = new SyncTickDriver(
      prisma,
      {} as MarketdataSyncQueue,
      calendarStub(true),
      CFG,
      new CalendarHitCheck(),
      new SyncRunRecorder(prisma),
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    // 复位 seed 形态: 全 enabled + nextFireAt NULL (未物化) + fire-now + daily 22:00。
    await prisma.syncDimension.updateMany({
      data: {
        enabled: true,
        nextFireAt: null,
        misfirePolicy: 'fire-now',
        cronExpr: '0 0 22 * * *',
      },
    });
  });

  it('① NULL 懒初始化: 全维度物化到未来时刻, 本轮不入队不补跑 (clarify Q1)', async () => {
    const result = await driver.claim(NOW);
    expect(result.initialized.sort()).toEqual([
      'allotment', // 041
      'announcement', // 043 ('allotment' < 'announcement' < 'buyback')
      'buyback', // 041
      'connect_holding', // 039
      'corporate_action',
      'earnings_event', // 047 ('corporate_action' < 'earnings_event' < 'employee')
      'employee', // 042 ('employee' < 'eod_bar': 'm' < 'o')
      'eod_bar',
      'equity_change', // 041
      'financial',
      'fund_company_holding', // 039
      'fund_holding', // 039
      'fundamental',
      'hot_snapshot', // 040
      'index_membership', // 039
      'industry_classification', // 043 ('index_membership' < 'industry_classification' < 'profile')
      'option_contract', // 047 ('industry_classification' < 'option_contract' < 'profile')
      'option_daily_snapshot', // 047
      'profile',
      'revenue_segment', // 042
      'shareholder_change', // 041
      'shareholder_snapshot', // 042
      'short_selling', // 039
      'underlying_iv_daily', // 046 ('short_selling' < 'underlying_iv_daily' < 'universe': 'und' < 'uni')
      'universe',
      'us_equity_bar', // sellput-viz
      'us_index_daily', // 046 ('us_equity_bar' < 'us_index_daily' < 'volatility')
      'volatility', // 040
    ]);
    expect(result.won).toEqual([]); // 懒初始化轮零抢占 — 不补跑。
    const rows = await prisma.syncDimension.findMany({ select: { nextFireAt: true } });
    for (const r of rows) expect(r.nextFireAt).toEqual(NEXT_FROM_NOW); // 未来值 (from now)。
    // 第二轮: 已物化且未 due → 空扫零副作用。
    const second = await driver.claim(NOW);
    expect(second.initialized).toEqual([]);
    expect(second.won).toEqual([]);
  });

  it('② due → 条件 UPDATE won: nextFireAt 推进 + won 集携带 retryMax/misfirePolicy', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: new Date(NOW.getTime() - 60_000) },
    });
    const result = await driver.claim(NOW);
    expect(result.won).toEqual([
      { dimensionKey: 'eod_bar', retryMax: 3, misfirePolicy: 'fire-now' },
    ]);
    expect(result.fireNow).toEqual(result.won);
    const row = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'eod_bar' } });
    expect(row?.nextFireAt).toEqual(NEXT_FROM_NOW); // 推进到未来。
  });

  it('③ 双 tick 并发同一 due 维度 → 恰好一方 won (正确性不依赖 Redis 锁)', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: new Date(NOW.getTime() - 60_000) },
    });
    const [a, b] = await Promise.all([driver.claim(NOW), driver.claim(NOW)]);
    const wonTotal = [...a.won, ...b.won].filter((w) => w.dimensionKey === 'eod_bar');
    expect(wonTotal).toHaveLength(1);
  });

  it('④ 宕机多天 (nextFireAt 过期 3 天) → won 一次且 computeNext from now 非逐天补 (FR-S04)', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: new Date(NOW.getTime() - 3 * 86_400_000) },
    });
    const result = await driver.claim(NOW);
    expect(result.won.map((w) => w.dimensionKey)).toEqual(['eod_bar']);
    const row = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'eod_bar' } });
    // 直接跳到 from-now 的下一触发 (今日 22:00), 不是旧值+1 天 (05-31 22:00) — 多天缺口只补一次。
    expect(row?.nextFireAt).toEqual(NEXT_FROM_NOW);
    // 后续 tick: 不再 due → 不会逐 tick 逐天补跑。
    const after = await driver.claim(NOW);
    expect(after.won).toEqual([]);
  });

  it('⑤ skip-to-next: won 但 fireNow 排除 — 只推进不补跑', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: new Date(NOW.getTime() - 60_000), misfirePolicy: 'skip-to-next' },
    });
    const result = await driver.claim(NOW);
    expect(result.won.map((w) => w.dimensionKey)).toEqual(['eod_bar']);
    expect(result.fireNow).toEqual([]); // 分流: 不进组 flow 流程。
    const row = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'eod_bar' } });
    expect(row?.nextFireAt).toEqual(NEXT_FROM_NOW); // 照常推进。
  });

  it('⑥ disabled: due 也不扫不推进 (state_branch「dimension disabled」)', async () => {
    const due = new Date(NOW.getTime() - 60_000);
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: due, enabled: false },
    });
    const result = await driver.claim(NOW);
    expect(result.won).toEqual([]);
    expect(result.initialized).not.toContain('eod_bar');
    const row = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'eod_bar' } });
    expect(row?.nextFireAt).toEqual(due); // 原值不动。
  });
});

// 017 T014 tick 接线半 + T015 语义穷举 (Testcontainers PG+Redis): won(fire-now) → 交易日
// gate → D3 装配 → FlowProducer 入队 (job opts 经 T009 helper 语义) + handleCron 灰度 flag
// 短路 + 重物化原语 + misfire catch-up (spec state_branches tick 簇; claim 级见上 describe)。
describe('017 T014/T015 SyncTickDriver.tick (gate + flow 装配入队 + flag + misfire 语义)', () => {
  let prisma: PrismaService;
  let lifecycle: QueueRedisLifecycle;
  let queue: MarketdataSyncQueue;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    prisma = new PrismaService(stores.databaseUrl);
    await prisma.$connect();
    lifecycle = new QueueRedisLifecycle(stores.redisUrl);
    queue = new MarketdataSyncQueue(lifecycle.client, CFG);
  }, 180_000);

  afterAll(async () => {
    await queue?.onModuleDestroy();
    lifecycle?.onApplicationShutdown();
    await prisma?.$disconnect();
    await stores.drop();
  });

  beforeEach(async () => {
    await prisma.syncDimension.updateMany({
      data: {
        enabled: true,
        nextFireAt: null,
        misfirePolicy: 'fire-now',
        cronExpr: '0 0 22 * * *',
      },
    });
    await queue.queue.obliterate({ force: true });
  });

  it('① due+交易日 → flow 入队: 队列可见嵌套树 + payload asOf/triggeredBy + opts 注入', async () => {
    // eod_bar + corporate_action 同时 due (其余 NULL → 本轮只懒初始化不入队)。
    const due = new Date(NOW.getTime() - 60_000);
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['eod_bar', 'corporate_action'] } },
      data: { nextFireAt: due },
    });
    const driver = new SyncTickDriver(
      prisma,
      queue,
      calendarStub(true),
      CFG,
      new CalendarHitCheck(),
      new SyncRunRecorder(prisma),
    );
    const result = await driver.tick(NOW);
    expect(result.fired.sort()).toEqual(['corporate_action', 'eod_bar']);

    // 无 worker 消费 → 树形留在队列可见 (019 T011 派生序 corp 先于 eod): child
    // corporate_action waiting / root eod_bar 等 children。
    const waiting = await queue.queue.getJobs(['waiting']);
    const waitingChildren = await queue.queue.getJobs(['waiting-children']);
    expect(waiting.map((j) => j.name)).toEqual(['sync:corporate_action']);
    expect(waitingChildren.map((j) => j.name)).toEqual(['sync:eod_bar']);

    // payload: asOf = shanghaiToday(NOW) 字符串 / triggeredBy=tick / mode=delta。
    const child = waiting[0]!;
    expect(child.data).toMatchObject({
      dimensionKey: 'corporate_action',
      mode: 'delta',
      asOf: '2026-06-03',
      triggeredBy: 'tick',
    });
    // opts 经 T009 jobOpts 语义注入 (attempts=seed retryMax=3 + removeOn* 走 config)。
    expect(child.opts.attempts).toBe(3);
    expect(child.opts.removeOnComplete).toEqual({ count: 200 });
    // 真实 hard 边 corp→eod (019 T011) → child 显式 failParentOnFailure (因子未就位断 eod)。
    expect(child.opts.failParentOnFailure).toBe(true);
  });

  it('② 非交易日 → 组 flow 前短路零入队, nextFireAt 照常推进', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: new Date(NOW.getTime() - 60_000) },
    });
    const driver = new SyncTickDriver(
      prisma,
      queue,
      calendarStub(false),
      CFG,
      new CalendarHitCheck(),
      new SyncRunRecorder(prisma),
    );
    const result = await driver.tick(NOW);
    expect(result.won.map((w) => w.dimensionKey)).toEqual(['eod_bar']); // 抢占照常。
    expect(result.fired).toEqual([]); // gate 短路不组 flow。
    const counts = await queue.queue.getJobCounts();
    expect(counts.waiting + counts['waiting-children'] + counts.delayed + counts.active).toBe(0);
    const row = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'eod_bar' } });
    expect(row?.nextFireAt).toEqual(NEXT_FROM_NOW); // 推进不回滚 (非交易日不补)。
  });

  it('③ 灰度 flag=false (默认): handleCron 短路, tick 不被驱动零副作用', async () => {
    const driver = new SyncTickDriver(
      prisma,
      queue,
      calendarStub(true),
      CFG,
      new CalendarHitCheck(),
      new SyncRunRecorder(prisma),
    ); // CFG.tickEnabled=false
    await driver.handleCron();
    // 零副作用: NULL 行连懒初始化都没发生 (claim 未被驱动)。
    const rows = await prisma.syncDimension.findMany({ select: { nextFireAt: true } });
    for (const r of rows) expect(r.nextFireAt).toBeNull();
    const counts = await queue.queue.getJobCounts();
    expect(counts.waiting + counts['waiting-children'] + counts.delayed).toBe(0);
  });

  it('④ 重物化原语: 运维改 cronExpr + 置 NULL → 下轮按新 cron 重物化不入队 (T015)', async () => {
    const driver = new SyncTickDriver(
      prisma,
      queue,
      calendarStub(true),
      CFG,
      new CalendarHitCheck(),
      new SyncRunRecorder(prisma),
    );
    await driver.tick(NOW); // 全维度懒初始化 (daily → 今晚 22:00)。
    // 运维降频 universe 到 weekly 周一 + 置 NULL (唯一重物化原语, clarify Q1)。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'universe' },
      data: { cronExpr: '0 0 22 * * 1', nextFireAt: null },
    });
    const result = await driver.tick(NOW);
    expect(result.initialized).toEqual(['universe']);
    expect(result.fired).toEqual([]); // misfirePolicy 不对 NULL 生效 — 无 surprise 补跑。
    const row = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'universe' } });
    expect(row?.nextFireAt).toEqual(new Date('2026-06-08T14:00:00Z')); // 下周一 22:00 (新 cron)。
    const counts = await queue.queue.getJobCounts();
    expect(counts.waiting + counts['waiting-children'] + counts.delayed).toBe(0);
  });

  it('⑤ misfire fire-now catch-up: 过期 3 天 → tick 恰好补一次 (asOf=当天), 不逐天补 (T015)', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: new Date(NOW.getTime() - 3 * 86_400_000) },
    });
    const driver = new SyncTickDriver(
      prisma,
      queue,
      calendarStub(true),
      CFG,
      new CalendarHitCheck(),
      new SyncRunRecorder(prisma),
    );
    const result = await driver.tick(NOW);
    expect(result.fired).toEqual(['eod_bar']);
    const waiting = await queue.queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(1); // 多天缺口只补一次 (misfire≠backfill), 非 3 个。
    expect(waiting[0]?.data.asOf).toBe('2026-06-03'); // 「本该跑的那次」= delta 拉当天。
    // 下一轮: nextFireAt 已推进未来 → 零新增 job。
    const again = await driver.tick(NOW);
    expect(again.fired).toEqual([]);
    expect(await queue.queue.getJobs(['waiting'])).toHaveLength(1);
  });

  it('⑥ per-market gate: cn 休市 hk 开市 → marketScope⊇hk 维度组 flow, cn-only 维度短路 (S2-T1)', async () => {
    const due = new Date(NOW.getTime() - 60_000);
    // eod_bar 仅 cn (今日 cn 休市 → 应短路); corporate_action 含 hk (今日 hk 开市 → 应组 flow)。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: due, marketScope: ['cn'] },
    });
    await prisma.syncDimension.update({
      where: { dimensionKey: 'corporate_action' },
      data: { nextFireAt: due, marketScope: ['cn', 'hk'] },
    });
    const driver = new SyncTickDriver(
      prisma,
      queue,
      calendarStubByMarket({ cn: false, hk: true }),
      CFG,
      new CalendarHitCheck(),
      new SyncRunRecorder(prisma),
    );
    const result = await driver.tick(NOW);
    // claim 红线不动: 两维度都 won (per-market gate 只影响组 flow, 不碰抢占)。
    expect(result.won.map((w) => w.dimensionKey).sort()).toEqual(['corporate_action', 'eod_bar']);
    // per-market: 只有含开市市场(hk)的 corporate_action 组 flow; 全 marketScope 休市的 eod_bar 短路。
    expect(result.fired).toEqual(['corporate_action']);
    const waiting = await queue.queue.getJobs(['waiting']);
    expect(waiting.map((j) => j.name)).toEqual(['sync:corporate_action']);
  });
});

// 019 T014 tick freshness gate (US2/FR-S02/S03, plan D6): won 后、交易日 gate 后、组 flow
// 前分流 — paused 优先 + event-calendar 命中检查; continuous/slow-drift 直通; claim 零改动
// (红线)。live event-calendar 行暂无 (T001 探测) → 测试维度行 + 测试 source 验证机制。
describe('019 T014 tick freshness gate (paused + event-calendar 分流)', () => {
  let prisma: PrismaService;
  let lifecycle: QueueRedisLifecycle;
  let queue: MarketdataSyncQueue;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    prisma = new PrismaService(stores.databaseUrl);
    await prisma.$connect();
    lifecycle = new QueueRedisLifecycle(stores.redisUrl);
    queue = new MarketdataSyncQueue(lifecycle.client, CFG);
  }, 180_000);

  afterAll(async () => {
    await queue?.onModuleDestroy();
    lifecycle?.onApplicationShutdown();
    await prisma?.$disconnect();
    await stores.drop();
  });

  beforeEach(async () => {
    await prisma.syncRun.deleteMany();
    await prisma.syncDimension.updateMany({
      data: {
        enabled: true,
        nextFireAt: null,
        misfirePolicy: 'fire-now',
        cronExpr: '0 0 22 * * *',
        freshnessProfile: 'continuous-daily',
        calendarSource: null,
        pausedUntil: null,
      },
    });
    await queue.queue.obliterate({ force: true });
  });

  function buildDriver(check: CalendarHitCheck = new CalendarHitCheck()): SyncTickDriver {
    return new SyncTickDriver(
      prisma,
      queue,
      calendarStub(true),
      CFG,
      check,
      new SyncRunRecorder(prisma),
    );
  }

  const due = () => new Date(NOW.getTime() - 60_000);

  it('① event-calendar 平淡日: 零入队零 vendor 外呼 + skipped 审计行(含原因) + nextFireAt 已推进', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'financial' },
      data: {
        nextFireAt: due(),
        freshnessProfile: 'event-calendar',
        calendarSource: 'test-source',
      },
    });
    const check = new CalendarHitCheck();
    check.registerSource('test-source', async () => false); // 平淡日: 未命中。
    const result = await buildDriver(check).tick(NOW);

    expect(result.won.map((w) => w.dimensionKey)).toEqual(['financial']); // claim 照常 (FR-S02)。
    expect(result.fired).toEqual([]); // gate 剔除 → 不组 flow。
    const counts = await queue.queue.getJobCounts();
    expect(counts.waiting + counts['waiting-children'] + counts.delayed).toBe(0);
    // skipped 审计行 (FR-S03): 原因在 failedTargets Json。
    const runs = await prisma.syncRun.findMany({ where: { syncType: 'sync:financial' } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('skipped');
    expect(JSON.stringify(runs[0].failedTargets)).toContain('日历未命中');
    // nextFireAt 已在 claim 推进 (零额外动作)。
    const row = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'financial' } });
    expect(row?.nextFireAt).toEqual(NEXT_FROM_NOW);
  });

  it('② 命中日: 组 flow 正常执行 (fired 含该维度, 队列可见 job)', async () => {
    await prisma.syncDimension.update({
      where: { dimensionKey: 'financial' },
      data: {
        nextFireAt: due(),
        freshnessProfile: 'event-calendar',
        calendarSource: 'test-source',
      },
    });
    const check = new CalendarHitCheck();
    check.registerSource('test-source', async () => true); // 命中日。
    const result = await buildDriver(check).tick(NOW);
    expect(result.fired).toEqual(['financial']);
    const waiting = await queue.queue.getJobs(['waiting']);
    expect(waiting.map((j) => j.name)).toEqual(['sync:financial']);
    expect(await prisma.syncRun.count({ where: { status: 'skipped' } })).toBe(0);
  });

  it('③ 混合 won 集 (命中 + 未命中 + continuous): 链装配只含应跑维度', async () => {
    // financial = event-calendar 未命中; profile = event-calendar 命中; eod = continuous 直通。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'financial' },
      data: { nextFireAt: due(), freshnessProfile: 'event-calendar', calendarSource: 'miss-src' },
    });
    await prisma.syncDimension.update({
      where: { dimensionKey: 'profile' },
      data: { nextFireAt: due(), freshnessProfile: 'event-calendar', calendarSource: 'hit-src' },
    });
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: due() },
    });
    const check = new CalendarHitCheck();
    check.registerSource('miss-src', async () => false);
    check.registerSource('hit-src', async () => true);
    const result = await buildDriver(check).tick(NOW);

    expect(result.won.map((w) => w.dimensionKey).sort()).toEqual([
      'eod_bar',
      'financial',
      'profile',
    ]);
    expect(result.fired.sort()).toEqual(['eod_bar', 'profile']);
    const jobs = await queue.queue.getJobs(['waiting', 'waiting-children']);
    expect(jobs.map((j) => j.name).sort()).toEqual(['sync:eod_bar', 'sync:profile']);
    expect(
      await prisma.syncRun.count({ where: { syncType: 'sync:financial', status: 'skipped' } }),
    ).toBe(1);
  });

  it('④ paused_until 优先级最高: 暂停期内无论画像不执行 + skipped 审计 (FR-S10/analyze M2)', async () => {
    // continuous-daily 维度 paused → gate 剔除 (画像不参与判定)。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: due(), pausedUntil: new Date(NOW.getTime() + 3_600_000) },
    });
    // event-calendar 命中维度 paused → 同样剔除 (paused > 画像)。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'profile' },
      data: {
        nextFireAt: due(),
        freshnessProfile: 'event-calendar',
        calendarSource: 'hit-src',
        pausedUntil: new Date(NOW.getTime() + 3_600_000),
      },
    });
    const check = new CalendarHitCheck();
    check.registerSource('hit-src', async () => true);
    const result = await buildDriver(check).tick(NOW);

    expect(result.fired).toEqual([]);
    const counts = await queue.queue.getJobCounts();
    expect(counts.waiting + counts['waiting-children'] + counts.delayed).toBe(0);
    const skipped = await prisma.syncRun.findMany({ where: { status: 'skipped' } });
    expect(skipped.map((r) => r.syncType).sort()).toEqual(['sync:eod_bar', 'sync:profile']);
    expect(JSON.stringify(skipped[0].failedTargets)).toContain('paused_until');
    // paused 到期后: 置 nextFireAt due → 照常执行 (可恢复)。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: due(), pausedUntil: new Date(NOW.getTime() - 1_000) },
    });
    const again = await buildDriver(check).tick(NOW);
    expect(again.fired).toEqual(['eod_bar']);
  });

  it('⑤ claim 行为回归 (FR-S02 红线): gate 不触 claim — won/initialized/推进语义与 017 一致', async () => {
    // 全维度 NULL → 懒初始化轮 (gate 零参与)。
    const result = await buildDriver().tick(NOW);
    expect(result.initialized).toHaveLength(DIMENSION_KEYS.length); // 全维度懒初始化, 行数派生自注册表
    expect(result.won).toEqual([]);
    expect(result.fired).toEqual([]);
    // due 轮: continuous-daily 直通 — 行为与 017 现状完全一致 (FR-S11 退化态)。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: due() },
    });
    const second = await buildDriver().tick(NOW);
    expect(second.won.map((w) => w.dimensionKey)).toEqual(['eod_bar']);
    expect(second.fired).toEqual(['eod_bar']);
    expect(await prisma.syncRun.count({ where: { status: 'skipped' } })).toBe(0);
  });
});
