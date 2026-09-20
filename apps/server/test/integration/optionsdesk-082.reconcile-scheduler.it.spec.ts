import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { marketdataConfig, type MarketdataConfig } from '../../src/config/marketdata.config';
import { MARKETDATA_WORKER_DISABLED } from '../../src/marketdata/marketdata-sync.queue';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
  type TradingDayStatus,
} from '../../src/marketdata/trading-calendar.port';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import {
  BROKER_ACCOUNT_PORT,
  BrokerInfrastructureError,
  type BrokerAccountPort,
} from '../../src/optionsdesk/broker-account.port';
import type { BrokerMarket } from '../../src/optionsdesk/broker-code.rules';
import { BrokerAccountScheduler } from '../../src/optionsdesk/broker-account.scheduler';
import { SyncBrokerAccountUseCase } from '../../src/optionsdesk/sync-broker-account.usecase';

process.env.AUTH_JWT_SECRET ??= 'optionsdesk-082-it-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-082-it-hmac-secret-min-32-bytes';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 082 T017 —— `BrokerAccountScheduler` 下半 (开盘前对账编排 + 数据层防重入) 的**真 PG IT**
 * (FR-010 / FR-011 / FR-017; plan D4 / D9; state_branches 20–29, 31)。
 *
 * ## 为什么必须要真 PG
 *
 * 防重入第二层是部分唯一索引 `uk_broker_sync_run_reconcile_active` (谓词 `kind='reconcile' AND
 * status IN ('running','succeeded')`) —— 「两拍同时进入只插出 1 条」只有真索引能回答; 进程内
 * 判定与 mock Prisma 下两条都插得进去。当日成功 / 失败计数也读自真记录行。
 *
 * 装配同 T016 IT: `OptionsdeskModule` 真 DI, 替换 `BROKER_ACCOUNT_PORT` / `marketdataConfig.KEY`
 * (live) / `TRADING_CALENDAR_PORT` (test double: 默认周末非交易日、其余交易日, 可按市场钉死)。
 * 🚨 美股时点那一刻港股当地已过 08:40 ⇒ 只看美股的臂把港股钉成 `non-trading`, 否则港股也执行。
 *
 * ## 定向变异留档 (2026-09-14, 类型合法形态, 均经 `pnpm nx test server <本文件>`: typecheck 过、vitest 红)
 *
 * - 基线: 12/12 绿 (T016 IT 回归 11/11 绿)。
 * - a 冲突处理取反 (`if (isUniqueViolation(e)) throw e`, 撞索引即抛): 「⑤」红 —— 输家记 error 日志 1 次; 其余 11 条绿。
 *   📌 tasks 行写的是「插出两条」: 索引在迁移里, 类型合法的代码变异去不掉它, 插第二条必被 DB 挡下 ⇒ 改观察
 *   「另一方跳过且不抛」这一半 (输家有无 error)。
 * - b 时点改用北京时间 (`exchangeClock('cn', now)`): 「⑨」EDT / EST 两侧均红 —— 当地 09:09 已执行; 其余 10 条绿。
 * - 两处均还原 (`cmp` 与备份一致) 后 12/12 绿。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** 2026-09-14 周一, 美股对账时点 09:10 当地 (交易所当地换算由 `exchangeClock` 承担, T004 已钉)。 */
const US_SLOT = new Date('2026-09-14T13:10:00Z');
/** 明显假值 (Guardrail 1)。 */
const ACCOUNT_ID = 9_000_000_000_000n;
const TICKED = { status: 'ticked', connections: 1, failedConnections: 0 };

const LIVE_CONFIG: MarketdataConfig = {
  kind: 'live',
  lixingerToken: 'it-082-fake-lixinger-token',
  lixingerBaseUrl: 'https://lixinger.invalid/api',
  eastmoneyBaseUrl: 'https://eastmoney.invalid',
  eastmoneyClistBaseUrl: 'https://eastmoney-clist.invalid',
  tencentCalendarBaseUrl: 'https://tencent.invalid',
  tencentFxBaseUrl: 'https://tencent-fx.invalid',
  futuShimUrl: 'https://futu-shim.invalid',
  futuShimToken: 'it-082-fake-shim-token',
};

/** 券商 port 的 test double: 空数据; `gate` 非空时 `fetchDeals` 先等它; `failures` 逐次抛出。 */
class FakeBrokerPort implements BrokerAccountPort {
  failures: Error[] = [];
  gate: Promise<void> | null = null;

  reset() {
    this.failures = [];
    this.gate = null;
  }

  async getAccountSummary() {
    return { trdmarketAuth: ['US', 'HK'], matched: 1 };
  }
  async fetchPositions() {
    return [];
  }
  async fetchDeals() {
    if (this.gate !== null) await this.gate;
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return [];
  }
  async fetchOrders() {
    return [];
  }
  /** 084: 本 IT 只走 082 的查询路径; 推送事件读取不该被调用到。 */
  fetchEvents(): never {
    throw new Error('FakeBrokerPort.fetchEvents: 本 IT 不走推送路径');
  }

  async fetchStockOwners(_market: BrokerMarket, codes: readonly string[]) {
    return new Map(codes.map((code) => [code, null]));
  }
}

/** 交易日历 test double: `byMarket` 钉死的市场按钉值; 其余按日期串的星期 (周六日非交易日)。 */
class FakeCalendar implements TradingCalendarPort {
  byMarket: Partial<Record<BrokerMarket, TradingDayStatus>> = {};
  calls: [string, string][] = [];

  reset() {
    this.byMarket = {};
    this.calls = [];
  }

  async classify(market: string, date: string): Promise<TradingDayStatus> {
    this.calls.push([market, date]);
    const fixed = this.byMarket[market as BrokerMarket];
    if (fixed !== undefined) return fixed;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return weekday === 0 || weekday === 6 ? 'non-trading' : 'trading';
  }
  async lastClosedSession() {
    return null;
  }
  async previousTradingDay() {
    return null;
  }
  async countTradingDays() {
    return null;
  }
}

/** `@db.Date` 列的承载值: UTC 零点。 */
const day = (date: string) => new Date(`${date}T00:00:00Z`);

describe('082 券商账户调度器 (下): 开盘前对账编排 / 数据层防重入 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let scheduler: BrokerAccountScheduler;
  let useCase: SyncBrokerAccountUseCase;
  let conn: bigint;
  const port = new FakeBrokerPort();
  const calendar = new FakeCalendar();
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  const reconcileRuns = (market?: BrokerMarket) =>
    prisma.brokerSyncRun.findMany({
      where: { kind: 'reconcile', ...(market === undefined ? {} : { market }) },
      orderBy: { id: 'asc' },
    });
  const seedReconcile = (market: BrokerMarket, tradingDate: string, status: string) =>
    prisma.brokerSyncRun.create({
      data: {
        accountId: ACCOUNT_ID,
        connectionId: conn,
        kind: 'reconcile',
        status,
        market,
        target: '*',
        tradingDate: day(tradingDate),
        finishedAt: day(tradingDate),
      },
    });
  const inputs = (execute: { mock: { calls: [unknown][] } }) =>
    execute.mock.calls.map(([input]) => input);

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
      .useValue(LIVE_CONFIG)
      .overrideProvider(TRADING_CALENDAR_PORT)
      .useValue(calendar)
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
  });

  beforeEach(async () => {
    port.reset();
    calendar.reset();
    await prisma.brokerSyncRun.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerDeal.deleteMany({});
    await prisma.brokerOrder.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    conn = (
      await prisma.brokerConnection.create({
        data: { accountId: ACCOUNT_ID, brokerCode: 'futu', label: 'it', phoneLast4: '0000' },
      })
    ).id;
  });

  it('① 美股 09:10 ET 交易日、本交易日未成功 ⇒ 执行对账, 记录字段齐全 (branch 20)', async () => {
    calendar.byMarket.hk = 'non-trading';
    const execute = vi.spyOn(useCase, 'execute');

    expect(await scheduler.run(US_SLOT)).toEqual(TICKED);

    const runs = await reconcileRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      market: 'us',
      target: '*',
      status: 'succeeded',
      filled: 0,
      tradingDate: day('2026-09-14'),
      windowStart: day('2026-09-07'),
      windowEnd: day('2026-09-14'),
      startedAt: US_SLOT,
    });
    expect(inputs(execute)).toEqual([
      {
        connectionId: conn,
        markets: ['us'],
        target: '*',
        window: { start: '2026-09-07', end: '2026-09-14' },
        mode: 'reconcile',
        runId: runs[0].id,
        now: US_SLOT,
      },
    ]);
    expect(calendar.calls).toContainEqual(['us', '2026-09-14']);
  });

  it('② 非交易日 ⇒ 不执行、不插记录 (branch 21)', async () => {
    calendar.byMarket = { us: 'non-trading', hk: 'non-trading' };
    const execute = vi.spyOn(useCase, 'execute');

    await scheduler.run(US_SLOT);

    expect(execute).not.toHaveBeenCalled();
    expect(await reconcileRuns()).toEqual([]);
  });

  it('③ 日历 unknown ⇒ 照常执行并 warn (branch 22)', async () => {
    calendar.byMarket = { us: 'unknown', hk: 'non-trading' };
    const execute = vi.spyOn(useCase, 'execute');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await scheduler.run(US_SLOT);

    expect(execute).toHaveBeenCalledTimes(1);
    expect((await reconcileRuns('us')).map((r) => r.status)).toEqual(['succeeded']);
    expect(
      warn.mock.calls.some(
        ([line]) => String(line).includes('us') && String(line).includes('2026-09-14'),
      ),
    ).toBe(true);
  });

  it('④ 本交易日已成功 ⇒ 不重复 (branch 23)', async () => {
    calendar.byMarket.hk = 'non-trading';
    await seedReconcile('us', '2026-09-14', 'succeeded');
    const execute = vi.spyOn(useCase, 'execute');

    await scheduler.run(US_SLOT);
    await scheduler.run(new Date(US_SLOT.getTime() + HOUR));

    expect(execute).not.toHaveBeenCalled();
    expect(await reconcileRuns()).toHaveLength(1);
  });

  it('⑤ 两个 run() 同时进入 09:10 ET ⇒ 对账记录恰 1 条, 另一方跳过且不抛 (branch 24 第二层)', async () => {
    calendar.byMarket.hk = 'non-trading';
    const execute = vi.spyOn(useCase, 'execute');
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // 赢家停在券商调用里 (记录保持 running) 直到输家返回 ⇒ 输家必然撞上「进行中」而非「已成功」。
    let open!: () => void;
    port.gate = new Promise<void>((resolve) => (open = resolve));

    const runs = [scheduler.run(US_SLOT), scheduler.run(US_SLOT)];
    const loser = await Promise.race(runs);
    open();
    const outcomes = await Promise.all(runs);

    expect(loser).toEqual(TICKED);
    expect(outcomes).toEqual([TICKED, TICKED]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await reconcileRuns()).map((r) => [r.market, r.status])).toEqual([['us', 'succeeded']]);
    expect(error).not.toHaveBeenCalled();
  });

  it('⑥ 09:40 ET 首次运行 (停机后同日重启) ⇒ 执行 (branch 25)', async () => {
    calendar.byMarket.hk = 'non-trading';
    const execute = vi.spyOn(useCase, 'execute');
    const restartedAt = new Date('2026-09-14T13:40:00Z');

    await scheduler.run(restartedAt);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await reconcileRuns('us')).toMatchObject([
      { status: 'succeeded', startedAt: restartedAt },
    ]);
  });

  it('⑦ 对账失败后 14 分钟不执行、15 分钟执行; 第 4 次失败后当日不再执行 (branch 26, 27)', async () => {
    calendar.byMarket.hk = 'non-trading';
    port.failures = Array.from(
      { length: 4 },
      () => new BrokerInfrastructureError('deals us', 'timeout'),
    );
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const execute = vi.spyOn(useCase, 'execute');
    const lastFailedAt = async () => {
      const { finishedAt } = await prisma.brokerSyncRun.findFirstOrThrow({
        where: { kind: 'reconcile', status: 'failed' },
        orderBy: { finishedAt: 'desc' },
      });
      if (finishedAt === null) throw new Error('failed 对账记录缺 finishedAt');
      return finishedAt.getTime();
    };

    await scheduler.run(US_SLOT);
    for (let failures = 1; failures <= 3; failures++) {
      const failedAt = await lastFailedAt();
      await scheduler.run(new Date(failedAt + 14 * MINUTE));
      expect(execute).toHaveBeenCalledTimes(failures);
      await scheduler.run(new Date(failedAt + 15 * MINUTE));
      expect(execute).toHaveBeenCalledTimes(failures + 1);
    }
    const fourthFailedAt = await lastFailedAt();
    await scheduler.run(new Date(fourthFailedAt + 15 * MINUTE));
    await scheduler.run(new Date(fourthFailedAt + 2 * HOUR));

    expect(execute).toHaveBeenCalledTimes(4);
    expect((await reconcileRuns('us')).map((r) => r.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
    ]);
  });

  describe('⑧ 对账窗口起点随上次成功对账日延长', () => {
    const cases = [
      {
        name: '上次成功 12 天前 ⇒ 起点 = 那天 (branch 29)',
        last: '2026-09-02',
        start: '2026-09-02',
      },
      {
        name: '上次成功 3 天前 ⇒ 起点 = 7 天前 (branch 28)',
        last: '2026-09-11',
        start: '2026-09-07',
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        calendar.byMarket.hk = 'non-trading';
        await seedReconcile('us', c.last, 'succeeded');
        const execute = vi.spyOn(useCase, 'execute');

        await scheduler.run(US_SLOT);

        expect(inputs(execute)).toMatchObject([
          { markets: ['us'], window: { start: c.start, end: '2026-09-14' } },
        ]);
      });
    }
  });

  describe('⑨ 美国夏令时前后, 美股时点均为当地 09:10 (前一分钟不触发) (branch 31)', () => {
    const cases = [
      {
        name: 'EDT 侧 2026-10-30',
        before: '2026-10-30T13:09:00Z',
        at: '2026-10-30T13:10:00Z',
        date: '2026-10-30',
      },
      {
        name: 'EST 侧 2026-11-02',
        before: '2026-11-02T14:09:00Z',
        at: '2026-11-02T14:10:00Z',
        date: '2026-11-02',
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        calendar.byMarket.hk = 'non-trading';
        const execute = vi.spyOn(useCase, 'execute');

        await scheduler.run(new Date(c.before));
        expect(execute).not.toHaveBeenCalled();

        await scheduler.run(new Date(c.at));
        expect(inputs(execute)).toMatchObject([
          { markets: ['us'], window: { end: c.date }, now: new Date(c.at) },
        ]);
        expect(await reconcileRuns()).toMatchObject([{ market: 'us', tradingDate: day(c.date) }]);
      });
    }
  });

  it('⑩ 港股 08:40 HKT 触发港股对账、不触发美股 (前一分钟均不触发)', async () => {
    // 此刻美东是周日晚 ⇒ 日历 double 按星期判非交易日 (不钉死, 走默认规则)。
    const execute = vi.spyOn(useCase, 'execute');

    await scheduler.run(new Date('2026-09-14T00:39:00Z'));
    expect(execute).not.toHaveBeenCalled();

    await scheduler.run(new Date('2026-09-14T00:40:00Z'));

    expect(inputs(execute)).toMatchObject([
      { markets: ['hk'], window: { start: '2026-09-07', end: '2026-09-14' } },
    ]);
    expect((await reconcileRuns()).map((r) => [r.market, r.tradingDate])).toEqual([
      ['hk', day('2026-09-14')],
    ]);
  });
});
