import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  BrokerInfrastructureError,
  type BrokerAccountPort,
  type BrokerDealRow,
  type BrokerEvent,
  type BrokerEventBatch,
  type BrokerEventQuery,
  type BrokerOrderEventRow,
  type BrokerPositionRow,
} from '../../src/optionsdesk/broker-account.port';
import type { BrokerMarket } from '../../src/optionsdesk/broker-code.rules';
import { ConsumeBrokerEventsUseCase } from '../../src/optionsdesk/consume-broker-events.usecase';

process.env.AUTH_JWT_SECRET ??= 'optionsdesk-084-it-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-084-it-hmac-secret-min-32-bytes';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 084 T006 —— 推送事件消费 use case (拉取 → 锚过滤 → 幂等写) 的**真 PG IT**
 * (FR-004 / FR-005 / FR-006 / FR-007 / FR-016 / FR-017; plan D3; state_branches 1, 2, 3, 4, 9, 11, 12)。
 *
 * ## 为什么必须要真 PG
 *
 * ① 幂等 = `createMany({ skipDuplicates })` 的 ON CONFLICT DO NOTHING 与唯一键
 *    `(connection_id, deal_id)` / `(connection_id, order_id)` 的组合, 只在真库成立。
 * ② 订单守卫 `vendor_updated_at < incoming` 的**毫秒**比较由 `timestamptz(6)` 列承载 ——
 *    同秒不同毫秒在 fake 里只是两个 JS Date。
 * ③ 「两拍并发消费同一批事件不抛 `P2002`」依赖 READ COMMITTED 下的推测插入等待 + 行锁;
 *    mock Prisma 里两条都会「成功」, 验不到任何东西。
 * ④ 拉取失败后「既有持仓 / 成交 / 订单逐条不变」的反例, 只有库里真有行时才看得见。
 *
 * ⇒ PG 从 `test/_support/isolated-db.ts` 的 `setupIsolatedDb()` 取 (共享 PG 模板克隆, 禁自起容器)。
 * 装配 = `OptionsdeskModule` 真 DI (plan Testing Invariants), **只替换** `BROKER_ACCOUNT_PORT`
 * 与 `marketdataConfig.KEY` (后者是 mock 门控臂的被测开关)。fixture 全为合成值。
 *
 * ## 定向变异留档 (2026-09-16, 均经 `pnpm nx test server test/integration/optionsdesk-084.push-consume.it.spec.ts`)
 *
 * - 基线: 8/8 绿。
 * - a. 订单写去掉原子幂等 (`brokerOrder.createMany` 去掉 `skipDuplicates`, 即「先查后写」那类
 *   非原子写): **③ 与 ⑧ 两条红**, 均抛 `Unique constraint failed on (connection_id, order_id)`。
 *   ⚠️ 比 tasks.md 预期的「并发臂红」**宽一条**, 且是对的 —— ③ 重放臂防的是同一条性质 (同一批
 *   事件二次投递时对已在库的订单再插一次), 不是夹具噪声, 故不为「只红一条」往夹具塞诱饵列。
 * - b. 锚过滤改为本文件自写 (锚集自行改判为「只取未 excluded 的锚」= 另起一份范围判定):
 *   **② 一条红**, 标 excluded 的锚样本被静默滤掉 —— 正是 FR-005 要钉的那类漂移。
 * - 两处变异均已还原 (还原后 grep 残留计数 0)。
 *
 * ⚠️ **③ / ⑦ 在 stub 阶段就是绿的** (stub 不写任何行 ⇒「没变化」恒真): 它们单独不构成证据,
 * 真正的把关力来自上面变异 a —— 记在这里, 免得后来者以为这两条臂自带保护力。
 */

/** 明显假值 (Guardrail 9): 连接所属账号 ID 与账户号一律合成。 */
const ACCOUNT_ID = 9_000_000_000_001n;
const NOW = new Date('2026-09-16T14:31:00Z');

/** 合成标的: `ZQP` 有锚、`ZQK` 有锚但标 excluded、`ZQZ` 无锚。 */
const ANCHORED = 'US.ZQP';
const EXCLUDED_ANCHORED = 'US.ZQK';
const UNANCHORED = 'US.ZQZ';

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
 * 券商 port 的 test double: 逐次回放预置事件批 (耗尽后重复最后一批), 并**逐方法计数** ——
 * mock 门控臂断言的是「零 port 调用」, 只数 `fetchEvents` 会漏掉正股判定兜底那条口。
 */
class FakeEventPort implements BrokerAccountPort {
  batches: BrokerEventBatch[] = [EMPTY_BATCH];
  positions: BrokerPositionRow[] = [];
  failure: Error | null = null;
  calls: string[] = [];
  queries: (BrokerEventQuery | null)[] = [];
  /** 非 null ⇒ `fetchEvents` 等到这么多个调用都到齐后同时放行 (并发臂把两个写方对齐到写入前)。 */
  barrier: { size: number; waiting: (() => void)[] } | null = null;

  reset() {
    this.batches = [EMPTY_BATCH];
    this.positions = [];
    this.failure = null;
    this.calls = [];
    this.queries = [];
    this.barrier = null;
  }

  async getAccountSummary() {
    this.calls.push('getAccountSummary');
    return { trdmarketAuth: ['US', 'HK'], matched: 1 };
  }
  async fetchPositions(_market: BrokerMarket) {
    this.calls.push('fetchPositions');
    return this.positions;
  }
  async fetchDeals() {
    this.calls.push('fetchDeals');
    return [];
  }
  async fetchOrders() {
    this.calls.push('fetchOrders');
    return [];
  }
  async fetchStockOwners(_market: BrokerMarket, codes: readonly string[]) {
    this.calls.push('fetchStockOwners');
    return new Map(codes.map((code) => [code, null]));
  }
  async fetchEvents(query: BrokerEventQuery | null): Promise<BrokerEventBatch> {
    this.calls.push('fetchEvents');
    this.queries.push(query);
    if (this.failure !== null) throw this.failure;
    const batch =
      this.batches.length > 1
        ? (this.batches.shift() as BrokerEventBatch)
        : (this.batches[0] as BrokerEventBatch);
    const barrier = this.barrier;
    if (barrier !== null) {
      await new Promise<void>((release) => {
        barrier.waiting.push(release);
        if (barrier.waiting.length === barrier.size) barrier.waiting.forEach((r) => r());
      });
    }
    return batch;
  }
}

const dealEvent = (
  seq: number,
  dealId: string,
  code: string,
  over: Partial<BrokerDealRow> = {},
): BrokerEvent => ({
  kind: 'deal',
  seq,
  deal: {
    market: 'us',
    dealId,
    orderId: `ord-${dealId}`,
    code,
    side: 'SELL_SHORT',
    qty: new Prisma.Decimal(1),
    price: new Prisma.Decimal('2.5'),
    currency: 'USD',
    tradedAt: new Date('2026-09-16T14:30:00.123Z'),
    raw: { event_type: 'deal', code },
    ...over,
  },
});

const orderEvent = (
  seq: number,
  orderId: string,
  code: string,
  over: Partial<BrokerOrderEventRow> = {},
): BrokerEvent => ({
  kind: 'order',
  seq,
  order: {
    market: 'us',
    orderId,
    code,
    comboLegCodes: [],
    comboLegs: [],
    legsPending: false,
    side: 'SELL_SHORT',
    orderType: 'NORMAL',
    qty: new Prisma.Decimal(1),
    price: new Prisma.Decimal('2.5'),
    status: 'SUBMITTED',
    currency: 'USD',
    vendorCreatedAt: new Date('2026-09-16T14:00:00.000Z'),
    vendorUpdatedAt: new Date('2026-09-16T14:00:08.950Z'),
    raw: { event_type: 'order', code },
    ...over,
  },
});

const batchOf = (rows: BrokerEvent[], over: Partial<BrokerEventBatch> = {}): BrokerEventBatch => ({
  epoch: 'e1',
  rows,
  nextSeq: rows.length === 0 ? 0 : (rows[rows.length - 1] as BrokerEvent).seq,
  dropped: false,
  ...over,
});

describe('084 T006 推送事件消费 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let live: TestingModule;
  let mock: TestingModule;
  let prisma: PrismaService;
  let consume: ConsumeBrokerEventsUseCase;
  let consumeMock: ConsumeBrokerEventsUseCase;
  let conn: bigint;
  const port = new FakeEventPort();
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  const compile = (config: MarketdataConfig) =>
    Test.createTestingModule({ imports: narrowTestModule([OptionsdeskModule]) })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .overrideProvider(BROKER_ACCOUNT_PORT)
      .useValue(port)
      .overrideProvider(marketdataConfig.KEY)
      .useValue(config)
      .compile();

  /** 全部券商数据面的逐行快照 —— 「一行不动」的反例只有整表对比才看得见。 */
  const snapshot = async () => ({
    deals: await prisma.brokerDeal.findMany({ orderBy: { dealId: 'asc' } }),
    orders: await prisma.brokerOrder.findMany({ orderBy: { orderId: 'asc' } }),
    positions: await prisma.brokerPosition.findMany({ orderBy: { code: 'asc' } }),
  });

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    delete process.env.BROKER_SYNC_SCOPE;
    // 同 082 券商 IT: 不起 marketdata 队列 worker, 规避 bullmq 5.x 关停竞态假红。
    process.env[MARKETDATA_WORKER_DISABLED] = '1';
    live = await compile(LIVE_CONFIG);
    mock = await compile({ kind: 'mock' });
    prisma = live.get(PrismaService);
    consume = live.get(ConsumeBrokerEventsUseCase);
    consumeMock = mock.get(ConsumeBrokerEventsUseCase);
  }, 180_000);

  afterAll(async () => {
    await live?.close();
    await mock?.close();
    await db?.drop();
    if (prevWorkerDisabled === undefined) delete process.env[MARKETDATA_WORKER_DISABLED];
    else process.env[MARKETDATA_WORKER_DISABLED] = prevWorkerDisabled;
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

    const anchor = (ticker: string, excluded: boolean) =>
      prisma.anchor.create({
        data: {
          ticker,
          market: 'us',
          v: '50',
          asof: new Date('2026-06-30T00:00:00Z'),
          method: 'dcf',
          confidence: '8',
          confidenceSource: 'manual',
          lLevelEffective: 'L2',
          excluded,
        },
      });
    await anchor('us:ZQP', false);
    // 🚨 excluded 的锚**仍在锚集内** (082 plan D6 / U8: 不参与交易 ≠ 不看它的成交) ——
    // 本文件另起一份过滤的实现会在这只标的上红。
    await anchor('us:ZQK', true);

    conn = (
      await prisma.brokerConnection.create({
        data: { accountId: ACCOUNT_ID, brokerCode: 'futu', label: 'it', phoneLast4: '0000' },
      })
    ).id;
  });

  const run = (cursor: Parameters<ConsumeBrokerEventsUseCase['execute']>[0]['cursor'] = null) =>
    consume.execute({ connectionId: conn, cursor, now: NOW });

  it('① 事件属锚标的 ⇒ 成交与订单写入, 每行 account_id = 连接所属账号 (branch 1)', async () => {
    port.batches = [batchOf([dealEvent(1, 'dl-1', ANCHORED), orderEvent(2, 'or-1', ANCHORED)])];

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: true, dealsInserted: 1, ordersInserted: 1 });
    const deal = await prisma.brokerDeal.findFirstOrThrow({});
    expect(deal).toMatchObject({
      accountId: ACCOUNT_ID,
      connectionId: conn,
      market: 'us',
      dealId: 'dl-1',
      code: ANCHORED,
      underlyingTicker: 'us:ZQP',
    });
    const order = await prisma.brokerOrder.findFirstOrThrow({});
    expect(order).toMatchObject({
      accountId: ACCOUNT_ID,
      connectionId: conn,
      orderId: 'or-1',
      code: ANCHORED,
      underlyingTicker: 'us:ZQP',
      status: 'SUBMITTED',
    });
  });

  it('② 🚨 不属锚标的 ⇒ 不写入; 标 excluded 的锚照常写入 (branch 2; 锚过滤单点 FR-005)', async () => {
    port.batches = [
      batchOf([
        dealEvent(1, 'dl-out', UNANCHORED),
        dealEvent(2, 'dl-excl', EXCLUDED_ANCHORED),
        orderEvent(3, 'or-out', UNANCHORED),
        orderEvent(4, 'or-excl', EXCLUDED_ANCHORED),
      ]),
    ];

    await run();

    expect((await prisma.brokerDeal.findMany({})).map((d) => d.dealId)).toEqual(['dl-excl']);
    expect((await prisma.brokerOrder.findMany({})).map((o) => o.orderId)).toEqual(['or-excl']);
  });

  it('③ 同一批事件重复投递两次 ⇒ 库内逐条相同 (branch 3)', async () => {
    port.batches = [batchOf([dealEvent(1, 'dl-1', ANCHORED), orderEvent(2, 'or-1', ANCHORED)])];

    const first = await run();
    const before = await snapshot();
    const second = await run();

    expect(second).toMatchObject({
      ok: true,
      dealsInserted: 0,
      ordersInserted: 0,
      ordersUpdated: 0,
    });
    expect(first).toMatchObject({ ok: true });
    expect(await snapshot()).toEqual(before);
  });

  it('④ 同一订单先喂较新 updated_time 再喂较旧 (同秒不同毫秒) ⇒ 库内为较新 (branch 4)', async () => {
    const newer = orderEvent(1, 'or-1', ANCHORED, {
      status: 'FILLED_ALL',
      vendorUpdatedAt: new Date('2026-09-16T14:00:08.950Z'),
    });
    const older = orderEvent(2, 'or-1', ANCHORED, {
      status: 'SUBMITTED',
      vendorUpdatedAt: new Date('2026-09-16T14:00:08.898Z'),
    });
    port.batches = [batchOf([newer]), batchOf([older], { nextSeq: 2 })];

    await run();
    await run({ epoch: 'e1', lastSeq: 1 });

    const order = await prisma.brokerOrder.findFirstOrThrow({});
    expect(order.status).toBe('FILLED_ALL');
    expect(order.vendorUpdatedAt.toISOString()).toBe('2026-09-16T14:00:08.950Z');
  });

  it('⑤ 🚨 先铺好数据再让 port 抛错 ⇒ 持仓 / 成交 / 订单逐条不变, 返回失败 (branch 11)', async () => {
    port.batches = [batchOf([dealEvent(1, 'dl-1', ANCHORED), orderEvent(2, 'or-1', ANCHORED)])];
    await run();
    await prisma.brokerPosition.create({
      data: {
        accountId: ACCOUNT_ID,
        connectionId: conn,
        market: 'us',
        code: ANCHORED,
        underlyingTicker: 'us:ZQP',
        qty: new Prisma.Decimal(-1),
        currency: 'USD',
        openedAt: new Date('2026-09-15T14:00:00Z'),
        openedAtSource: 'fallback',
        firstSeenAt: new Date('2026-09-15T14:00:00Z'),
        syncedAt: new Date('2026-09-15T14:00:00Z'),
        raw: {},
      },
    });
    const before = await snapshot();

    port.failure = new BrokerInfrastructureError('trade/events', 'ECONNRESET');
    const outcome = await run({ epoch: 'e1', lastSeq: 2 });

    expect(outcome).toMatchObject({ ok: false, failureKind: 'infrastructure' });
    expect(await snapshot()).toEqual(before);
  });

  it('⑥ 🚨 mock 档 ⇒ 整拍跳过, port 调用数 0 (branch 12; FR-016)', async () => {
    port.batches = [batchOf([dealEvent(1, 'dl-1', ANCHORED)])];

    const outcome = await consumeMock.execute({ connectionId: conn, cursor: null, now: NOW });

    expect(outcome).toMatchObject({ ok: true, skipped: true });
    expect(port.calls).toEqual([]);
    expect(await prisma.brokerDeal.count()).toBe(0);
  });

  it('⑦ 空事件批 ⇒ 不产生任何记录、游标不变 (branch 9)', async () => {
    port.batches = [batchOf([dealEvent(1, 'dl-1', ANCHORED)]), batchOf([], { nextSeq: 1 })];

    const first = await run();
    expect(first.ok).toBe(true);
    const cursor = first.ok ? first.cursor : null;
    expect(cursor).toEqual({ epoch: 'e1', lastSeq: 1 });
    const before = await snapshot();

    const second = await run(cursor);

    expect(second).toMatchObject({
      ok: true,
      accepted: 0,
      dealsInserted: 0,
      ordersInserted: 0,
      ordersUpdated: 0,
      cursor: { epoch: 'e1', lastSeq: 1 },
    });
    expect(await snapshot()).toEqual(before);
    // 游标真的被回传给了事件源 (否则「不变」只是本地读数, 事件源那边仍从头拉)。
    expect(port.queries).toEqual([null, { epoch: 'e1', afterSeq: 1 }]);
  });

  it('⑧ 🚨 两拍并发消费同一订单的两个版本 ⇒ 不抛 P2002, 收敛到较新 (幂等写 = 原子写)', async () => {
    const newer = orderEvent(1, 'or-1', ANCHORED, {
      status: 'FILLED_ALL',
      vendorUpdatedAt: new Date('2026-09-16T14:00:08.950Z'),
    });
    const older = orderEvent(1, 'or-1', ANCHORED, {
      status: 'SUBMITTED',
      vendorUpdatedAt: new Date('2026-09-16T14:00:08.898Z'),
    });
    port.batches = [batchOf([newer]), batchOf([older])];
    port.barrier = { size: 2, waiting: [] };

    const outcomes = await Promise.all([run(), run()]);

    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    const orders = await prisma.brokerOrder.findMany({});
    expect(orders).toHaveLength(1);
    expect((orders[0] as (typeof orders)[number]).status).toBe('FILLED_ALL');
  });
});
