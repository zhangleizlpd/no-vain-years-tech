import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { Prisma } from '../../src/generated/prisma/client';
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
  type BrokerAccountPort,
  type BrokerDealRow,
  type BrokerEvent,
  type BrokerEventBatch,
  type BrokerEventQuery,
} from '../../src/optionsdesk/broker-account.port';
import { BrokerAccountScheduler } from '../../src/optionsdesk/broker-account.scheduler';
import type { BrokerMarket } from '../../src/optionsdesk/broker-code.rules';

process.env.AUTH_JWT_SECRET ??= 'optionsdesk-084-it-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-084-it-hmac-secret-min-32-bytes';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 084 T010 / T011 —— 推送断档的**当日缺口补偿**与**卡死回收**的真 PG IT
 * (FR-009 / FR-010 / FR-011 / FR-018 / FR-022; plan D5 / D6;
 * state_branches 5, 6, 7, 10, 17, 18, 19, 20)。
 *
 * ## 为什么必须要真 PG
 *
 * ① 防重入的被测对象**就是**一条部分唯一索引 (`uk_broker_sync_run_gapfill_active`,
 *    谓词 `kind='gapfill' ∧ status='running'`)。Prisma 客户端把部分唯一索引当全表唯一,
 *    「插得进 / 插不进」只在真库里由谓词决定 —— mock Prisma 里两次 create 都会「成功」,
 *    branch 19 与 branch 20 一条都验不到。
 * ② 「当日已完成过补偿 ⇒ 再次断档照常新起」(branch 20) 的反例, 只有真索引会红:
 *    照抄上游谓词 (把 `succeeded` 也纳入) 的实现在 fake 里与正确实现无法区分。
 * ③ 「补偿真的把当日缺失的成交补回来了」要看 `createMany({ skipDuplicates })` 的
 *    ON CONFLICT DO NOTHING 与唯一键 `(connection_id, deal_id)` 的组合结果。
 * ④ 卡死回收是条件 `updateMany` (`status='running' ∧ startedAt < 阈值` ∧ `kind` 过滤),
 *    「哪些行被改了、哪些原样不动」是 SQL 谓词的结果, 不是应用层判断。
 *
 * ⇒ PG 从 `test/_support/isolated-db.ts` 的 `setupIsolatedDb()` 取 (共享 PG 模板克隆, 禁自起容器)。
 * 装配 = `OptionsdeskModule` 真 DI (plan Testing Invariants), **只替换** `BROKER_ACCOUNT_PORT`
 * (与收窄 boot 必需的 `REDIS_CLIENT` / `marketdataConfig.KEY`) —— `PrismaService`、规则函数、
 * 调度器、交易日历 adapter 一律真实。fixture 全为合成值 (Guardrail 9)。
 *
 * ⚠️ **每个用例的连接行都是新建的** (`beforeEach` 删表重建) ⇒ 调度器的进程内游标 Map
 * (按 `connectionId` 键) 天然逐用例隔离, 不需要伸手清私有字段。
 *
 * ## T010 定向变异留档 (2026-09-16, 均经
 * `pnpm nx test server test/integration/optionsdesk-084.push-gap.it.spec.ts --skip-nx-cache`)
 *
 * - 基线: 8/8 绿。
 * - a. **索引谓词纳入已完成状态**: 把 `uk_broker_sync_run_gapfill_active` 的谓词从
 *   `status='running'` 改成 `status IN ('running','succeeded')` —— 改的是 migration SQL 本体
 *   (IT 的模板库每轮由 `migrate deploy` 重建 ⇒ 动到的就是被测那条索引, 不是它的替身)。
 *   **④ 一条红**, 其余 7 条绿; 范围与 tasks.md 预期一致。这同时是 T009 那条谓词的「能红」
 *   证明 —— 迁移属「最终状态」形态, 自己构造不出反例 (`testing.md` §7.1)。
 * - b. **补偿写成对账类型**: `broker-account.scheduler.ts` 建记录处 `kind: 'gapfill'` → `'reconcile'`。
 *   **8 条全红**。⚠️ 比 tasks.md 预期的「⑦ 红」**宽出 7 条**, 且这是对的 —— 每条臂的观察面都是
 *   「`kind='gapfill'` 的记录」, 补偿一旦记成对账类型, 这个集合整体为空。🚫 为了把红收窄到
 *   一条而往夹具里塞券商根本不发的诱饵列。
 * - 两处变异均已还原, 还原后 8/8 复绿。
 * - 判定纯函数 `decideGapfill` 自己的变异留档在 `src/optionsdesk/broker-sync-slot.rules.spec.ts` 头。
 *
 * ## T011 定向变异留档 (2026-09-16, 同一条命令)
 *
 * - 变异 = **回到「没有新回收分支」的状态**, 即本 task 写完测试、未动实现时的 RED 基线
 *   (`reclaimStuckRuns` 当时只有 `backfill` / `reconcile` 两条)。
 * - 结果 **3 failed | 10 passed (13)**: T011 的 ① ② ⑤ 红, ③ ④ 与 T010 的 8 条绿。
 *   ① 与 ⑤ 的失败信息都是 `expected 'running' to be 'failed'` —— **记录永久停在执行中**,
 *   正是 FR-011 / SC-007 要钉的那个形态。
 * - ② 跟着红是对的、不是夹具噪声: 回收不发生 ⇒ 记录仍是 `running` ⇒ 当日失败次数为 0 ⇒
 *   重试规则没有任何东西可据以重新发起。
 * - 加上两条分支后本文件 13/13 绿。`reclaimStuckRuns` 与 `runEvents` 是与 082 共用的路径 ⇒
 *   连 `optionsdesk-082.{reconcile,backfill}-scheduler.it.spec.ts` 与 084 push-consume 一起跑,
 *   四个文件 52/52 绿。
 *
 * ## T012 定向变异留档 (2026-09-16, 同一条命令; 本 task **零生产代码改动**)
 *
 * - 基线: 本文件 17/17 绿 (T010 8 条 + T011 5 条 + T012 4 条)。
 * - ⚠️ **一个变异盖不住这四条臂, 需要两个** —— tasks.md 起片时只写了「把补偿改写成对账类型」,
 *   但 T012 的 ① ② ④ **不经过补偿的写入路径** (夹具直接 `seedRun('gapfill', …)`), 那个变异
 *   碰不到它们。照实分两个记:
 * - m1. **对账判定把补偿计入**: `broker-account.scheduler.ts` `reconcileMarket` 的
 *   `scope` 去掉 `kind: 'reconcile'` (即当日统计与「上次成功交易日」都不再按类型过滤)。
 *   **① ② ④ 三条红**, 其余 14 条绿 —— 正是 FR-010 要钉的那个形态: 当日已有成功的补偿 ⇒
 *   对账判 `already-succeeded` ⇒ **一条都不起, 且全程不报错**。
 * - m2. **补偿写成对账类型**: `gapfillMarket` 建记录处 `kind: 'gapfill'` → `'reconcile'`。
 *   **11 条红** (T010 全 8 条 + T011 的 ② ⑤ + T012 的 ③), 6 条绿。比 T010 留档的「8 条全红」
 *   多出的 3 条是 T011-② / T011-⑤ / T012-③ —— 同一个原因: 每条臂的观察面都是「`kind='gapfill'`
 *   的记录」, 补偿一旦记成对账类型这个集合整体为空。🚫 为把红收窄而往夹具塞诱饵列。
 * - 两处变异均已还原 (`git status` 对该文件为空), 还原后 17/17 复绿。
 */

/** 明显假值 (Guardrail 9): 连接所属账号 ID 一律合成。 */
const ACCOUNT_ID = 9_000_000_000_002n;

/** 交易所当地日期在两个市场上都是 2026-09-16 (HK 22:31 / US-ET 10:31)。 */
const NOW = new Date('2026-09-16T14:31:00Z');
const TRADING_DATE = '2026-09-16';
const MINUTE = 60_000;

/** 合成标的: 有锚, 故落在默认同步范围内。 */
const ANCHORED = 'US.ZQP';

const LIVE_CONFIG: MarketdataConfig = {
  kind: 'live',
  lixingerToken: 'it-084-fake-lixinger-token',
  lixingerBaseUrl: 'https://lixinger.invalid/api',
  eastmoneyBaseUrl: 'https://eastmoney.invalid',
  eastmoneyClistBaseUrl: 'https://eastmoney-clist.invalid',
  tencentCalendarBaseUrl: 'https://tencent.invalid',
  tencentFxBaseUrl: 'https://tencent-fx.invalid',
  futuShimUrl: 'https://futu-shim.invalid',
  futuShimToken: 'it-084-fake-shim-token',
};

const EMPTY_BATCH: BrokerEventBatch = {
  epoch: 'e1',
  rows: [],
  nextSeq: 0,
  dropped: false,
  lastEventAt: null,
};

/**
 * 券商 port 的 test double: 事件批逐次回放 (耗尽后重复最后一批), 历史成交按市场预置。
 * `fetchDeals` 可钉死抛错 —— 补偿失败的重试臂靠它构造。
 */
class FakeGapPort implements BrokerAccountPort {
  batches: BrokerEventBatch[] = [EMPTY_BATCH];
  dealsByMarket: Partial<Record<BrokerMarket, BrokerDealRow[]>> = {};
  fetchDealsFailure: Error | null = null;
  calls: string[] = [];
  queries: (BrokerEventQuery | null)[] = [];

  reset() {
    this.batches = [EMPTY_BATCH];
    this.dealsByMarket = {};
    this.fetchDealsFailure = null;
    this.calls = [];
    this.queries = [];
  }

  async getAccountSummary() {
    this.calls.push('getAccountSummary');
    return { trdmarketAuth: ['US', 'HK'], matched: 1 };
  }
  async fetchPositions(market: BrokerMarket) {
    this.calls.push(`fetchPositions:${market}`);
    return [];
  }
  async fetchDeals(market: BrokerMarket) {
    this.calls.push(`fetchDeals:${market}`);
    if (this.fetchDealsFailure !== null) throw this.fetchDealsFailure;
    return this.dealsByMarket[market] ?? [];
  }
  async fetchOrders(market: BrokerMarket) {
    this.calls.push(`fetchOrders:${market}`);
    return [];
  }
  async fetchStockOwners(_market: BrokerMarket, codes: readonly string[]) {
    this.calls.push('fetchStockOwners');
    return new Map(codes.map((code) => [code, null]));
  }
  async fetchEvents(query: BrokerEventQuery | null): Promise<BrokerEventBatch> {
    this.calls.push('fetchEvents');
    this.queries.push(query);
    return this.batches.length > 1
      ? (this.batches.shift() as BrokerEventBatch)
      : (this.batches[0] as BrokerEventBatch);
  }
}

/**
 * 交易日历 test double (形制照 `optionsdesk-082.reconcile-scheduler.it.spec.ts`): `byMarket`
 * 钉死的市场按钉值, 其余按日期串的星期判 (周六日非交易日)。
 *
 * T012 之前本文件不替换日历 port —— 真 adapter 对空日历表回 `unknown`, 而 `decideReconcile`
 * 对 `unknown` 是**放行**的, 于是对账照跑、臂也绿, 但绿的理由是「日历没覆盖」而不是「这天是
 * 交易日」。T012 要断言的恰是对账在**正常交易日**照常发起 ⇒ 把这一步钉死。
 */
class FakeCalendar implements TradingCalendarPort {
  byMarket: Partial<Record<BrokerMarket, TradingDayStatus>> = {};

  reset() {
    this.byMarket = {};
  }

  async classify(market: string, date: string): Promise<TradingDayStatus> {
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

const historyDeal = (dealId: string, market: BrokerMarket = 'us'): BrokerDealRow => ({
  market,
  dealId,
  orderId: `ord-${dealId}`,
  code: ANCHORED,
  side: 'SELL_SHORT',
  qty: new Prisma.Decimal(1),
  price: new Prisma.Decimal('2.5'),
  currency: 'USD',
  tradedAt: new Date('2026-09-16T14:00:00.000Z'),
  raw: { deal_id: dealId },
});

const dealEvent = (seq: number, dealId: string): BrokerEvent => ({
  kind: 'deal',
  seq,
  deal: historyDeal(dealId),
});

const batchOf = (rows: BrokerEvent[], over: Partial<BrokerEventBatch> = {}): BrokerEventBatch => ({
  epoch: 'e1',
  rows,
  nextSeq: rows.length === 0 ? 0 : (rows[rows.length - 1] as BrokerEvent).seq,
  dropped: false,
  // 本文件测的是断档处置, 订阅健康 (FR-014) 的臂在 push-consume IT。
  lastEventAt: null,
  ...over,
});

/** `@db.Date` 列的承载值: UTC 零点 (只搬运日历字段, 不经时区)。 */
const day = (date: string) => new Date(`${date}T00:00:00Z`);

describe('084 推送断档处置 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let scheduler: BrokerAccountScheduler;
  let conn: bigint;
  const port = new FakeGapPort();
  const calendar = new FakeCalendar();
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  const runsOf = (kind: string, market?: BrokerMarket) =>
    prisma.brokerSyncRun.findMany({
      where: { kind, ...(market === undefined ? {} : { market }) },
      orderBy: { id: 'asc' },
    });

  const seedRun = (
    kind: string,
    status: string,
    over: Partial<Prisma.BrokerSyncRunUncheckedCreateInput> = {},
  ) =>
    prisma.brokerSyncRun.create({
      data: {
        accountId: ACCOUNT_ID,
        connectionId: conn,
        kind,
        status,
        market: 'us',
        target: '*',
        tradingDate: day(TRADING_DATE),
        ...over,
      },
    });

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    delete process.env.BROKER_SYNC_SCOPE;
    // 同 082 券商 IT: 不起 marketdata 队列 worker, 规避 bullmq 5.x 关停竞态假红。
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
    await prisma.brokerContractRef.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.anchor.deleteMany({});

    await prisma.anchor.create({
      data: {
        ticker: 'us:ZQP',
        market: 'us',
        v: '50',
        asof: new Date('2026-06-30T00:00:00Z'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        excluded: false,
      },
    });
    conn = (
      await prisma.brokerConnection.create({
        data: { accountId: ACCOUNT_ID, brokerCode: 'futu', label: 'it', phoneLast4: '0000' },
      })
    ).id;
  });

  /**
   * 断档两拍: 第一拍建游标 (首次消费不判断档), 第二拍按 `over` 造成断档。
   * 🚨 断档是**批级布尔、不含市场** —— 事件源是一个进程级环形缓冲 + 一个全局 `seq`,
   * 丢掉的那段序号里可能是任何市场的事件 ⇒ 补偿必须对该连接 scope 内每个市场各做一次。
   */
  const tickThenGap = async (rows: BrokerEvent[], over: Partial<BrokerEventBatch> = {}) => {
    port.batches = [batchOf([dealEvent(1, 'dl-seen')]), batchOf(rows, over)];
    await scheduler.runEvents(NOW);
    return scheduler.runEvents(NOW);
  };

  describe('T010 缺口补偿', () => {
    it('① 序号断档 ⇒ 每个市场各一条 gapfill 记录, 当日缺失成交被补回 (branch 5)', async () => {
      port.dealsByMarket = { us: [historyDeal('dl-missed')] };

      await tickThenGap([dealEvent(5, 'dl-after')]);

      const gapfills = await runsOf('gapfill');
      expect(gapfills.map((r) => [r.market, r.status])).toEqual([
        ['us', 'succeeded'],
        ['hk', 'succeeded'],
      ]);
      // 「补回条数」= 本次补偿真正新插入的行数; 推送已写过的那条不重复计入。
      expect(gapfills.map((r) => r.filled)).toEqual([1, 0]);
      expect(
        (await prisma.brokerDeal.findMany({ orderBy: { dealId: 'asc' } })).map((d) => d.dealId),
      ).toEqual(['dl-after', 'dl-missed', 'dl-seen']);
    });

    it('② 代次变化 ⇒ 照样补偿, 且下一拍从新代次续拉 (branch 6)', async () => {
      port.dealsByMarket = { us: [historyDeal('dl-missed')] };
      port.batches = [
        batchOf([dealEvent(7, 'dl-old-epoch')], { nextSeq: 7 }),
        batchOf([dealEvent(1, 'dl-new-epoch')], { epoch: 'e2', nextSeq: 1 }),
        batchOf([], { epoch: 'e2', nextSeq: 1 }),
      ];

      await scheduler.runEvents(NOW);
      await scheduler.runEvents(NOW);
      await scheduler.runEvents(NOW);

      expect(await runsOf('gapfill')).toHaveLength(2);
      // 🚨 断言的是**第三拍带着新代次的游标去拉** —— 只断言「补偿产生了」的话,
      // 「按旧序号续拉」(D4 明令禁止) 的实现同样绿。
      expect(port.queries).toEqual([
        null,
        { epoch: 'e1', afterSeq: 7 },
        { epoch: 'e2', afterSeq: 1 },
      ]);
    });

    it('③ 🚨 已有执行中的补偿 ⇒ 不新起第二条, 本拍跳过 (branch 19)', async () => {
      await seedRun('gapfill', 'running', { startedAt: NOW });

      await tickThenGap([dealEvent(5, 'dl-after')]);

      const us = await runsOf('gapfill', 'us');
      expect(us).toHaveLength(1);
      expect(us[0]).toMatchObject({ status: 'running' });
      // 另一个市场没有执行中的补偿 ⇒ 照常起 (防重入是 per-market 的)。
      expect(await runsOf('gapfill', 'hk')).toHaveLength(1);
    });

    it('④ 🚨 当日已完成过补偿 ⇒ 再次断档照常新起一条 (branch 20)', async () => {
      await seedRun('gapfill', 'succeeded', {
        startedAt: new Date(NOW.getTime() - 60 * MINUTE),
        finishedAt: new Date(NOW.getTime() - 59 * MINUTE),
        filled: 0,
      });

      await tickThenGap([dealEvent(5, 'dl-after')]);

      const us = await runsOf('gapfill', 'us');
      expect(us.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    });

    it('⑤ 补偿失败、当日次数未用尽 ⇒ 不足 15 分钟不重发, 满 15 分钟重新发起 (branch 17)', async () => {
      port.fetchDealsFailure = new Error('历史成交查询失败');

      await tickThenGap([dealEvent(5, 'dl-after')]);
      const failed = await runsOf('gapfill', 'us');
      expect(failed.map((r) => r.status)).toEqual(['failed']);

      // 🚨 后续两拍**不再断档** —— 重试必须由重试规则自己发起, 不能依赖「又断了一次」:
      // 卡死回收置 failed 的记录 (T011) 之后根本不会再有一次断档。
      await scheduler.runEvents(new Date(NOW.getTime() + 14 * MINUTE));
      expect(await runsOf('gapfill', 'us')).toHaveLength(1);

      port.fetchDealsFailure = null;
      await scheduler.runEvents(new Date(NOW.getTime() + 16 * MINUTE));
      expect((await runsOf('gapfill', 'us')).map((r) => r.status)).toEqual(['failed', 'succeeded']);
    });

    it('⑥ 当日失败次数用尽 ⇒ 留痕放弃, 不再新起 (branch 18)', async () => {
      for (let i = 0; i < 4; i++) {
        await seedRun('gapfill', 'failed', {
          startedAt: new Date(NOW.getTime() - (60 - i) * MINUTE),
          finishedAt: new Date(NOW.getTime() - (59 - i) * MINUTE),
          error: '历史成交查询失败',
        });
      }

      await tickThenGap([dealEvent(5, 'dl-after')]);

      expect(await runsOf('gapfill', 'us')).toHaveLength(4);
      // 用尽只对该市场成立, 另一市场照常补偿。
      expect(await runsOf('gapfill', 'hk')).toHaveLength(1);
    });

    it('⑦ 🚨 补偿产生的记录类型是 gapfill, 不是对账 (branch 10 的写入半)', async () => {
      await tickThenGap([dealEvent(5, 'dl-after')]);

      expect(await prisma.brokerSyncRun.count({ where: { kind: 'reconcile' } })).toBe(0);
      expect(await prisma.brokerSyncRun.count({ where: { kind: 'gapfill' } })).toBe(2);
    });

    it('⑧ 补偿记录字段齐全: 类型 / 市场 / 状态 / 起止 / 补回条数 / 失败原因 (FR-018)', async () => {
      port.dealsByMarket = { us: [historyDeal('dl-missed')] };
      await tickThenGap([dealEvent(5, 'dl-after')]);

      const [ok] = await runsOf('gapfill', 'us');
      expect(ok).toMatchObject({
        kind: 'gapfill',
        status: 'succeeded',
        market: 'us',
        target: '*',
        filled: 1,
        error: null,
      });
      expect(ok?.tradingDate?.toISOString().slice(0, 10)).toBe(TRADING_DATE);
      expect(ok?.windowStart?.toISOString().slice(0, 10)).toBe(TRADING_DATE);
      expect(ok?.windowEnd?.toISOString().slice(0, 10)).toBe(TRADING_DATE);
      expect(ok?.startedAt).not.toBeNull();
      expect(ok?.finishedAt).not.toBeNull();

      // 失败侧: `error` 必须留痕 (排障时「为什么没补上」只有这一处答案)。
      await prisma.brokerSyncRun.deleteMany({});
      port.fetchDealsFailure = new Error('历史成交查询失败');
      await tickThenGap([dealEvent(9, 'dl-after-2')], { nextSeq: 9 });
      const [bad] = await runsOf('gapfill', 'us');
      expect(bad).toMatchObject({ kind: 'gapfill', status: 'failed', market: 'us' });
      expect(bad?.error).toContain('历史成交查询失败');
      expect(bad?.finishedAt).not.toBeNull();
    });
  });

  /**
   * T011 卡死回收补两条分支 (FR-011 / SC-007; plan D6; state_branches 7)。
   *
   * 🚨 **覆盖的是 `gapfill` 与 `push` 两个新 kind, 不是一个**: 依据 SC-007 的字面 ——
   * 「停留在执行中状态超过回收阈值的同步记录数为 0」。推送刷新 (T007) 同样会建一条
   * `kind='push'` 的执行中记录, 崩在刷新途中就永远停在 `running`、无任何回收路径。
   * 两者的**语义不同**: `gapfill` 置 `failed` 并计入当日失败次数 (由重试规则重新发起),
   * `push` 置 `failed` 即可 —— 它没有独立重试规则, 下一拍推送刷新自然会再来。
   */
  describe('T011 卡死回收: gapfill + push 两条分支', () => {
    const stuckAt = new Date(NOW.getTime() - 20 * MINUTE);

    it('① 🚨 超时的执行中补偿 ⇒ 被回收为终态 (branch 7; FR-011)', async () => {
      const { id } = await seedRun('gapfill', 'running', { startedAt: stuckAt });

      await scheduler.run(NOW);

      const row = await prisma.brokerSyncRun.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('failed');
      expect(row.error).not.toBeNull();
      expect(row.finishedAt?.toISOString()).toBe(NOW.toISOString());
    });

    it('② 回收后计入当日失败次数, 重试规则据此重新发起', async () => {
      await seedRun('gapfill', 'running', { startedAt: stuckAt });
      await scheduler.run(NOW);

      // 🚨 后续两拍都**不断档** —— 进程重启后游标为 null, 首拍按「首次消费」接受、不判断档,
      // 所以被回收的补偿若不靠重试规则自己重发, 就再也没有任何东西会发起它。
      await scheduler.runEvents(new Date(NOW.getTime() + 14 * MINUTE));
      expect(await runsOf('gapfill', 'us')).toHaveLength(1);

      await scheduler.runEvents(new Date(NOW.getTime() + 16 * MINUTE));
      expect((await runsOf('gapfill', 'us')).map((r) => r.status)).toEqual(['failed', 'succeeded']);
    });

    it('③ 未超时的执行中补偿 ⇒ 不被回收', async () => {
      const { id } = await seedRun('gapfill', 'running', {
        startedAt: new Date(NOW.getTime() - 10 * MINUTE),
      });

      await scheduler.run(NOW);

      expect((await prisma.brokerSyncRun.findUniqueOrThrow({ where: { id } })).status).toBe(
        'running',
      );
    });

    it('④ 既有 backfill / reconcile 回收行为不变 (回归)', async () => {
      const backfill = await seedRun('backfill', 'running', {
        startedAt: stuckAt,
        market: null,
        tradingDate: null,
      });
      const reconcile = await seedRun('reconcile', 'running', { startedAt: stuckAt });

      await scheduler.run(NOW);

      const back = await prisma.brokerSyncRun.findUniqueOrThrow({ where: { id: backfill.id } });
      expect(back.status).toBe('pending');
      const rec = await prisma.brokerSyncRun.findUniqueOrThrow({ where: { id: reconcile.id } });
      expect(rec.status).toBe('failed');
      expect(rec.error).not.toBeNull();
    });

    it('⑤ 🚨 超时的执行中推送刷新 ⇒ 回收为 failed, 且不占补偿的重试预算 (SC-007)', async () => {
      const { id } = await seedRun('push', 'running', { startedAt: stuckAt, tradingDate: null });

      await scheduler.run(NOW);

      const row = await prisma.brokerSyncRun.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('failed');
      expect(row.finishedAt?.toISOString()).toBe(NOW.toISOString());

      // 🚨 被回收的推送刷新若被当成「补偿失败」, 它那 15 分钟的重试间隔会把本次断档整个挡掉,
      // 表现是断档不被补偿且不报错。
      await tickThenGap([dealEvent(5, 'dl-after')]);
      expect((await runsOf('gapfill', 'us')).map((r) => r.status)).toEqual(['succeeded']);
    });
  });

  /**
   * T012 `kind` 隔离回归 (FR-010; plan D5; state_branches 10)。
   *
   * 🚨 **本 describe 不配任何生产代码改动** —— 隔离在起片前就已成立 (开盘前对账的两处 scope
   * `broker-account.scheduler.ts` `reconcileMarket` 与索引谓词 `uk_broker_sync_run_reconcile_active`
   * 都带 `kind='reconcile'` 过滤)。这里补的是**回归断言**: 挡住后续某次改动悄悄把补偿记成
   * 对账类型 —— 那种失效的表现是**开盘前对账被静默跳过**, 不报错、不留痕, 直到 SC-004 的
   * 上线后观察 (累计 5 个交易日) 才看得出来。
   *
   * `NOW` 在两个市场都已过对账时点 (美股 ET 10:31 > 09:10 · 港股当地 22:31 > 08:40) ⇒
   * `scheduler.run(NOW)` 这一拍两个市场都会真的发起对账。
   */
  describe('T012 kind 隔离: 开盘前对账不受缺口补偿影响', () => {
    /** 当日每个市场各一条**成功**的缺口补偿 —— 断档是批级的, 补偿逐市场 fan-out (T010 ①)。 */
    const seedTodaysGapfills = async (status = 'succeeded') => {
      for (const market of ['us', 'hk'] as const) {
        await seedRun('gapfill', status, {
          market,
          startedAt: new Date(NOW.getTime() - 60 * MINUTE),
          finishedAt: new Date(NOW.getTime() - 59 * MINUTE),
          filled: 0,
        });
      }
    };

    it('① 🚨 当日已有成功的缺口补偿 ⇒ 开盘前对账时点到来时照常发起 (branch 10; FR-010)', async () => {
      await seedTodaysGapfills();

      await scheduler.run(NOW);

      // 🚨 补偿被误记成对账类型的实现在这里红: 那两条 succeeded 会让 `decideReconcile` 判
      // `already-succeeded`, 当日对账**一条都不起**, 而全程没有任何错误。
      expect((await runsOf('reconcile')).map((r) => [r.market, r.status])).toEqual([
        ['us', 'succeeded'],
        ['hk', 'succeeded'],
      ]);
    });

    it('② 当日补偿 + 对账各一条 ⇒ 按对账类型统计当日仍恰 1 条 (SC-004 的机制面)', async () => {
      await seedTodaysGapfills();

      await scheduler.run(NOW);
      // 🚨 再跑一拍: 防重入与「当日已成功」都必须按对账类型算, 第二拍不许多出第二条。
      await scheduler.run(new Date(NOW.getTime() + MINUTE));

      for (const market of ['us', 'hk'] as const) {
        const reconciles = await prisma.brokerSyncRun.count({
          where: { kind: 'reconcile', market, status: 'succeeded', tradingDate: day(TRADING_DATE) },
        });
        expect([market, reconciles]).toEqual([market, 1]);
      }
      // 补偿那两条原样留着、互不计入。
      expect(await runsOf('gapfill')).toHaveLength(2);
    });

    it('③ 补偿记录不撞对账的部分唯一索引 (同一 connection × market × 交易日可以并存)', async () => {
      // 先让对账真的跑完 ⇒ 库里有一条 succeeded 的 reconcile 占住 `uk_broker_sync_run_reconcile_active`。
      await scheduler.run(NOW);
      expect((await runsOf('reconcile', 'us')).map((r) => r.status)).toEqual(['succeeded']);

      // 同一 (connection, market, tradingDate) 上再插补偿: 谓词带 kind 过滤 ⇒ 插得进。
      await tickThenGap([dealEvent(5, 'dl-after')]);

      expect((await runsOf('gapfill', 'us')).map((r) => r.status)).toEqual(['succeeded']);
      expect((await runsOf('reconcile', 'us')).map((r) => r.status)).toEqual(['succeeded']);
    });

    it('④ 🚨 对账的「上次成功交易日」判定不把补偿计入 (窗口起点不被补偿拉长)', async () => {
      // 一条**更早交易日**的成功补偿。若它被当成「上次成功的对账」, 对账窗口起点会被拉到那天。
      await seedRun('gapfill', 'succeeded', {
        market: 'us',
        tradingDate: day('2026-08-01'),
        finishedAt: day('2026-08-01'),
        filled: 0,
      });

      await scheduler.run(NOW);

      const [reconcile] = await runsOf('reconcile', 'us');
      // 回看下限 = 交易所当地今天往前 7 个自然日 (`RECONCILE_MIN_LOOKBACK_DAYS`)。
      expect(reconcile?.windowStart?.toISOString().slice(0, 10)).toBe('2026-09-09');
      expect(reconcile?.status).toBe('succeeded');
    });
  });
});
