import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { Prisma } from '../../src/generated/prisma/client';
import { marketdataConfig, type MarketdataConfig } from '../../src/config/marketdata.config';
import { MARKETDATA_WORKER_DISABLED } from '../../src/marketdata/marketdata-sync.queue';
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
 * 084 T010 —— 推送断档的**当日缺口补偿**的真 PG IT
 * (FR-009 / FR-010 / FR-018 / FR-022; plan D5; state_branches 5, 6, 10, 17, 18, 19, 20)。
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
  futuShimUrl: 'https://futu-shim.invalid',
  futuShimToken: 'it-084-fake-shim-token',
};

const EMPTY_BATCH: BrokerEventBatch = { epoch: 'e1', rows: [], nextSeq: 0, dropped: false };

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
});
