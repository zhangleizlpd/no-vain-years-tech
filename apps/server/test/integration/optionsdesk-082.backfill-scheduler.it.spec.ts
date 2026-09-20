import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { Prisma } from '../../src/generated/prisma/client';
import { marketdataConfig, type MarketdataConfig } from '../../src/config/marketdata.config';
import { MARKETDATA_WORKER_DISABLED } from '../../src/marketdata/marketdata-sync.queue';
import { TRADING_CALENDAR_PORT } from '../../src/marketdata/trading-calendar.port';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import {
  BROKER_ACCOUNT_PORT,
  BrokerAccountSelectionError,
  BrokerInfrastructureError,
  type BrokerAccountPort,
  type BrokerPositionRow,
} from '../../src/optionsdesk/broker-account.port';
import type { BrokerMarket } from '../../src/optionsdesk/broker-code.rules';
import {
  BROKER_ACCOUNT_HEARTBEAT,
  BrokerAccountScheduler,
} from '../../src/optionsdesk/broker-account.scheduler';
import { SyncBrokerAccountUseCase } from '../../src/optionsdesk/sync-broker-account.usecase';

process.env.AUTH_JWT_SECRET ??= 'optionsdesk-082-it-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-082-it-hmac-secret-min-32-bytes';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 082 T016 —— `BrokerAccountScheduler` 上半 (心跳骨架 + 卡死回收 + 补齐认领与结局) 的**真 PG IT**
 * (FR-009 / FR-010 / FR-017 / FR-018; plan D9; state_branches 7, 15, 17, 18, 19, 24, 32)。
 *
 * ## 为什么必须要真 PG
 *
 * ① 「两拍并发认领同一条 pending 只执行一次」靠 PG 行锁 + READ COMMITTED 下 `UPDATE … WHERE status`
 *    的重判 —— mock Prisma 下两个 `updateMany` 都返回 1。
 * ② 补齐结局是 use case 与调度器**先后两次**条件写同一行 (`running→failed` 再 `failed→pending`),
 *    中间任一条件写错只在真行状态上看得见。
 *
 * 装配 = `OptionsdeskModule` 真 DI, 只替换 `BROKER_ACCOUNT_PORT`, 并把 `marketdataConfig.KEY`
 * 换成**可变**的 live 配置 (测试环境恒钉 mock ⇒ 不换的话 `run()` 起手 `skipped-mock`, 下面全部臂
 * 绿得毫无意义; 臂 ① 临时改回 mock)。臂 ⑨ 另起只含 `ScheduleModule.forRoot()` + 本调度器的最小
 * 模块: 主模块 `init()` 会挂载并启动全 ctx 的 `@Cron`, 在测试期真触发。
 *
 * ## 定向变异留档 (2026-09-14, 类型合法形态, 均经 `pnpm nx test server <本文件>`: typecheck 过、vitest 红)
 *
 * - 基线: 11/11 绿。
 * - a 认领去掉 `status:'pending'` 条件 (`where: { id: run.id }`): 「②」红 —— `execute` 被调 2 次; 其余 10 条绿。
 * - b `@Cron` 去掉 `waitForCompletion: true`: 「⑨」红 —— `expected false to be true`; 其余 10 条绿。
 * - 两处均还原 (`cmp` 与备份一致) 后 11/11 绿。
 */

const NOW = new Date('2026-09-14T15:00:00Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** 明显假值 (Guardrail 1)。 */
const ACCOUNT_ID = 9_000_000_000_000n;

const LIVE_CONFIG: MarketdataConfig = {
  kind: 'live',
  lixingerToken: 'it-082-fake-lixinger-token',
  lixingerBaseUrl: 'https://lixinger.invalid/api',
  eastmoneyBaseUrl: 'https://eastmoney.invalid',
  eastmoneyClistBaseUrl: 'https://eastmoney-clist.invalid',
  tencentCalendarBaseUrl: 'https://tencent.invalid',
  tencentFxBaseUrl: 'https://tencent-fx.invalid',
  sinaFxBaseUrl: 'https://sina-fx.invalid',
  futuShimUrl: 'https://futu-shim.invalid',
  futuShimToken: 'it-082-fake-shim-token',
};

/** 券商 port 的 test double: 空成交 / 订单; `failures` 队列非空时每次 `fetchDeals` 取一个抛出。 */
class FakeBrokerPort implements BrokerAccountPort {
  calls = 0;
  positions: Partial<Record<BrokerMarket, BrokerPositionRow[]>> = {};
  failures: Error[] = [];

  reset() {
    this.calls = 0;
    this.positions = {};
    this.failures = [];
  }

  async getAccountSummary() {
    this.calls++;
    return { trdmarketAuth: ['US', 'HK'], matched: 1 };
  }
  async fetchPositions(market: BrokerMarket) {
    this.calls++;
    return this.positions[market] ?? [];
  }
  async fetchDeals() {
    this.calls++;
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return [];
  }
  async fetchOrders() {
    this.calls++;
    return [];
  }
  /** 084: 本 IT 只走 082 的查询路径; 推送事件读取不该被调用到。 */
  fetchEvents(): never {
    throw new Error('FakeBrokerPort.fetchEvents: 本 IT 不走推送路径');
  }

  async fetchStockOwners(_market: BrokerMarket, codes: readonly string[]) {
    this.calls++;
    return new Map(codes.map((code) => [code, null]));
  }
}

const position = (code: string, qty: number): BrokerPositionRow => ({
  market: 'us',
  code,
  qty: new Prisma.Decimal(qty),
  marketValue: new Prisma.Decimal(qty * 10),
  costPrice: new Prisma.Decimal('9.5'),
  averageCost: new Prisma.Decimal('9.6'),
  currentPrice: new Prisma.Decimal('10'),
  currency: 'USD',
  raw: { code, qty },
});

describe('082 券商账户调度器 (上): 心跳骨架 / 卡死回收 / 补齐认领与结局 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let scheduler: BrokerAccountScheduler;
  let useCase: SyncBrokerAccountUseCase;
  let conn: bigint;
  const port = new FakeBrokerPort();
  const config: { kind: string } = { ...LIVE_CONFIG };
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  const createConnection = async (label: string) =>
    (
      await prisma.brokerConnection.create({
        data: { accountId: ACCOUNT_ID, brokerCode: 'futu', label, phoneLast4: '0000' },
      })
    ).id;

  type RunSeed = Partial<Prisma.BrokerSyncRunUncheckedCreateInput>;
  /** 待执行补齐记录 (形同订阅方插入: `nextAttemptAt` 已到期)。 */
  const insertPending = (over: RunSeed = {}) =>
    prisma.brokerSyncRun.create({
      data: {
        accountId: ACCOUNT_ID,
        connectionId: conn,
        kind: 'backfill',
        status: 'pending',
        target: 'us:PEP',
        nextAttemptAt: new Date(NOW.getTime() - MINUTE),
        ...over,
      },
    });
  /** 执行中的记录 (调用方认领 / 插入时一并写 `startedAt`)。 */
  const insertRunning = (over: RunSeed) =>
    prisma.brokerSyncRun.create({
      data: {
        accountId: ACCOUNT_ID,
        connectionId: conn,
        kind: 'backfill',
        status: 'running',
        target: 'us:PEP',
        ...over,
      },
    });
  const runOf = (id: bigint) => prisma.brokerSyncRun.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    delete process.env.BROKER_SYNC_SCOPE;
    // 同 optionsdesk 读端 IT (aaa0ba7a): 不起 marketdata 队列 worker, 规避 bullmq 5.x 关停竞态假红。
    process.env[MARKETDATA_WORKER_DISABLED] = '1';
    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([OptionsdeskModule]) })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .overrideProvider(BROKER_ACCOUNT_PORT)
      .useValue(port)
      .overrideProvider(marketdataConfig.KEY)
      .useValue(config)
      // 对账编排 (T017, 另见 reconcile-scheduler IT) 在本文件恒判非交易日: NOW 时两市场均已过时点,
      // 不钉死的话每拍都会插对账记录并调 use case, 本文件的 execute 计数断言随之失真。
      .overrideProvider(TRADING_CALENDAR_PORT)
      .useValue({ classify: async () => 'non-trading' })
      .compile();
    prisma = moduleRef.get(PrismaService);
    scheduler = moduleRef.get(BrokerAccountScheduler);
    useCase = moduleRef.get(SyncBrokerAccountUseCase);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await db?.drop();
    if (prevWorkerDisabled === undefined) delete process.env[MARKETDATA_WORKER_DISABLED];
    else process.env[MARKETDATA_WORKER_DISABLED] = prevWorkerDisabled;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.kind = 'live';
  });

  beforeEach(async () => {
    port.reset();
    await prisma.brokerSyncRun.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerDeal.deleteMany({});
    await prisma.brokerOrder.deleteMany({});
    await prisma.brokerContractRef.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.anchor.create({
      data: {
        ticker: 'us:PEP',
        market: 'us',
        v: '50',
        asof: new Date('2026-06-30T00:00:00Z'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
    conn = await createConnection('it-a');
  });

  it('① mock 档 ⇒ skipped-mock, port 调用数 0, 待执行记录原样 (branch 32)', async () => {
    config.kind = 'mock';
    const pending = await insertPending();

    const outcome = await scheduler.run(NOW);

    expect(outcome).toEqual({ status: 'skipped-mock' });
    expect(port.calls).toBe(0);
    expect(await runOf(pending.id)).toEqual(pending);
  });

  it('② 两个 run 并发认领同一条 pending ⇒ use case 只执行一次 (branch 24 补齐半)', async () => {
    const pending = await insertPending();
    const execute = vi.spyOn(useCase, 'execute');
    // 屏障: 两拍都读到「这条还是 pending」之后才放行认领 —— 否则第二拍可能晚到、根本读不到它,
    // 认领条件写错也照样绿。
    const delegate = prisma.brokerSyncRun;
    const findMany = delegate.findMany.bind(delegate);
    let hits = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(delegate, 'findMany').mockImplementation(((args: Prisma.BrokerSyncRunFindManyArgs) =>
      findMany(args).then(async (rows) => {
        if (args.where?.status === 'pending') {
          if (++hits === 2) release();
          await gate;
        }
        return rows;
      })) as never);

    const outcomes = await Promise.all([scheduler.run(NOW), scheduler.run(NOW)]);

    expect(hits).toBe(2);
    expect(outcomes).toEqual([
      { status: 'ticked', connections: 1, failedConnections: 0 },
      { status: 'ticked', connections: 1, failedConnections: 0 },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await runOf(pending.id)).toMatchObject({ status: 'succeeded', startedAt: NOW });
  });

  it('③ running 超 15 分钟: 补齐记录回收后本拍即被执行; 对账记录变 failed (执行中断); 未超时的不动', async () => {
    const execute = vi.spyOn(useCase, 'execute');
    const stuckBackfill = await insertRunning({
      startedAt: new Date(NOW.getTime() - 15 * MINUTE - 1),
      nextAttemptAt: new Date(NOW.getTime() - HOUR),
    });
    const stuckReconcile = await insertRunning({
      kind: 'reconcile',
      market: 'us',
      target: '*',
      tradingDate: new Date('2026-09-14T00:00:00Z'),
      startedAt: new Date(NOW.getTime() - 16 * MINUTE),
    });
    const freshBackfill = await insertRunning({
      target: 'us:KO',
      startedAt: new Date(NOW.getTime() - 14 * MINUTE),
    });

    await scheduler.run(NOW);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({ runId: stuckBackfill.id, mode: 'backfill' });
    expect(await runOf(stuckBackfill.id)).toMatchObject({ status: 'succeeded', startedAt: NOW });
    expect(await runOf(stuckReconcile.id)).toMatchObject({ status: 'failed', error: '执行中断' });
    expect(await runOf(freshBackfill.id)).toEqual(freshBackfill);
  });

  describe('④ 基础设施失败、距首次尝试未满 24 小时 ⇒ pending, 下次时刻 +15 分, attempt+1 (branch 17)', () => {
    const cases = [
      { name: '首次失败 (firstAttemptedAt 为空) ⇒ 写入 firstAttemptedAt = now', first: null },
      {
        name: '首次尝试 23h59m 前',
        first: new Date(NOW.getTime() - 24 * HOUR + MINUTE),
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const pending = await insertPending({ attempt: 2, firstAttemptedAt: c.first });
        port.failures = [new BrokerInfrastructureError('deals us', 'timeout')];

        await scheduler.run(NOW);

        expect(await runOf(pending.id)).toMatchObject({
          status: 'pending',
          attempt: 3,
          firstAttemptedAt: c.first ?? NOW,
          nextAttemptAt: new Date(NOW.getTime() + 15 * MINUTE),
        });
      });
    }
  });

  it('⑤ 基础设施失败、首次尝试恰满 24h00m ⇒ failed (基础设施重试耗尽) + error 日志, 下一拍不再认领 (branch 18)', async () => {
    const first = new Date(NOW.getTime() - 24 * HOUR);
    const pending = await insertPending({ attempt: 95, firstAttemptedAt: first });
    port.failures = [new BrokerInfrastructureError('deals us', 'timeout')];
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const execute = vi.spyOn(useCase, 'execute');

    await scheduler.run(NOW);
    await scheduler.run(new Date(NOW.getTime() + HOUR));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await runOf(pending.id)).toMatchObject({
      status: 'failed',
      error: '基础设施重试耗尽',
      attempt: 95,
      firstAttemptedAt: first,
    });
    expect(error.mock.calls.some((args) => String(args[0]).includes('基础设施重试耗尽'))).toBe(
      true,
    );
  });

  it('⑥ BrokerAccountSelectionError ⇒ 立即 failed, 之后各拍不再认领 (branch 7, 19)', async () => {
    const pending = await insertPending();
    port.failures = [new BrokerAccountSelectionError('deals us')];
    const execute = vi.spyOn(useCase, 'execute');

    await scheduler.run(NOW);
    await scheduler.run(new Date(NOW.getTime() + HOUR));
    await scheduler.run(new Date(NOW.getTime() + 25 * HOUR));

    expect(execute).toHaveBeenCalledTimes(1);
    const run = await runOf(pending.id);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('同步对象账户不唯一');
    expect(run.attempt).toBe(0);
    expect(run.nextAttemptAt).toEqual(pending.nextAttemptAt);
  });

  describe('⑦ 连接 A 出错不影响连接 B 执行', () => {
    it('A 的 port 抛基础设施错误 ⇒ A 进重试, B 照常成功', async () => {
      const a = await insertPending();
      const connB = await createConnection('it-b');
      const b = await insertPending({ connectionId: connB });
      port.failures = [new BrokerInfrastructureError('deals us', 'ECONNRESET')];

      await scheduler.run(NOW);

      expect(await runOf(a.id)).toMatchObject({ status: 'pending', attempt: 1 });
      expect(await runOf(b.id)).toMatchObject({ status: 'succeeded' });
    });

    it('A 的执行抛出 (use case 写记录行失败) ⇒ 本拍不上抛, B 照常成功', async () => {
      await insertPending();
      const connB = await createConnection('it-b');
      const b = await insertPending({ connectionId: connB });
      const execute = useCase.execute.bind(useCase);
      vi.spyOn(useCase, 'execute').mockImplementation((input) =>
        input.connectionId === conn ? Promise.reject(new Error('db down')) : execute(input),
      );
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const outcome = await scheduler.run(NOW);

      expect(outcome).toEqual({ status: 'ticked', connections: 2, failedConnections: 1 });
      expect(await runOf(b.id)).toMatchObject({ status: 'succeeded' });
    });
  });

  it('⑧ 订阅方产生的 pending 记录在下一拍被执行并刷新持仓 (branch 15 调度半)', async () => {
    const pending = await insertPending({ sourceEventId: 'evt-0001', nextAttemptAt: NOW });
    port.positions = { us: [position('US.PEP', 100)] };
    const execute = vi.spyOn(useCase, 'execute');

    await scheduler.run(NOW);

    expect(execute.mock.calls.map(([input]) => input)).toEqual([
      {
        connectionId: conn,
        markets: ['us'],
        target: 'us:PEP',
        window: 'all-history',
        mode: 'backfill',
        runId: pending.id,
        now: NOW,
      },
    ]);
    expect(await runOf(pending.id)).toMatchObject({ status: 'succeeded' });
    const rows = await prisma.brokerPosition.findMany();
    expect(rows.map((r) => [r.connectionId, r.code, r.qty.toString(), r.syncedAt])).toEqual([
      [conn, 'US.PEP', '100', NOW],
    ]);
  });
});

describe('082 券商账户调度器: cron 注册 (无 DB)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [BrokerAccountScheduler],
    })
      .useMocker(() => ({ kind: 'mock' }))
      .compile();
    // init 才挂载 cron (orchestrator 的 onApplicationBootstrap), 挂载即 start ⇒ 立刻 stop, 测试期不真触发。
    await moduleRef.init();
    for (const job of moduleRef.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('⑨ SchedulerRegistry 中的心跳 job waitForCompletion === true (branch 24 第一层)', () => {
    const job = moduleRef.get(SchedulerRegistry).getCronJob(BROKER_ACCOUNT_HEARTBEAT);
    expect(job.waitForCompletion).toBe(true);
  });
});
