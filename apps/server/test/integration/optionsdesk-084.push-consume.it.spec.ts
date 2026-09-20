import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
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
  type BrokerOrderRow,
  type BrokerPositionRow,
  type BrokerTradeWindow,
} from '../../src/optionsdesk/broker-account.port';
import {
  BROKER_EVENT_HEARTBEAT,
  BrokerAccountScheduler,
} from '../../src/optionsdesk/broker-account.scheduler';
import type { BrokerMarket } from '../../src/optionsdesk/broker-code.rules';
import {
  ConsumeBrokerEventsUseCase,
  ORDER_LEGS_RECHECK_DEBOUNCE_MS,
  ORDER_LEGS_RECHECK_MAX_PER_TICK,
} from '../../src/optionsdesk/consume-broker-events.usecase';

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
 *
 * ## T007 定向变异留档 (2026-09-16)
 *
 * - 基线: 本文件 12/12 绿, `optionsdesk-083.broker-positions-read.it.spec.ts` 20/20 绿。
 * - c. 去抖窗口改 0 (= 去掉去抖、逐条刷): **T007 ① 与 ② 两条红** —— ①「只刷一次」实得 3 次;
 *   ② 刷新时刻变成首拍而非窗口到期时刻。⚠️ 比 tasks.md 预期的「① 红」**宽一条**, 同因:
 *   两条臂都依赖「只刷一次、且在窗口到期那一刻刷」。
 * - d. 读端 `lastSucceededSyncAt` 去掉第三支 `OR`: **083 的 ⑨ ⑩ 两条红, 而既有 18 条全绿** ——
 *   正是 plan §「本片额外的反例臂」所说「给 `lastSucceededSyncAt` 加一支 OR 不会让既有夹具红」,
 *   故 FR-012 非新增这两条臂不可。
 * - 两处变异均已还原 (还原后 grep 残留计数 0)。
 *
 * ## T008 定向变异留档 (2026-09-16)
 *
 * - 基线: 本文件 16/16 绿 (T006 8 条 + T007 4 条 + T008 4 条)。
 * - e. 新 `@Cron` 去掉 `waitForCompletion: true` (**只动推送那拍**, 082 那拍不动):
 *   **T008 ① 一条红** —— `AssertionError: expected false to be true`, 其余 15 条绿。
 *   范围与 tasks.md 预期一致 (不像 a / c 那样宽出一条)。
 * - 已还原; 还原后本文件 16/16 复绿。
 *
 * ## T013 定向变异留档 (2026-09-16)
 *
 * - 基线: 本文件 20/20 绿 (T006 8 + T007 4 + T013 4 + T008 4)。
 * - f. 在 `write()` 里多打一行带 `account=${accountId}` 的日志: **T013-④ 一条红**, 其余 19 条
 *   绿。范围与 tasks.md 预期一致。已还原 (与备份 `diff -q` 一致), 还原后 20/20 复绿。
 * - ⚠️ **T013 的 ① ② ③ 在 stub 阶段就是绿的**: 券商 port 的 test double 直接供 `lastEventAt`,
 *   服务端只是透传, 这三条臂**单独不构成证据**。真正的把关力在 **shim 侧** ——
 *   `services/futu-shim/tests/test_trade_events.py` 变异 c (`last_event_at` 改取读取时刻)
 *   让「不随读取移动」那条红。记在这里, 免得后来者以为这三条臂自带保护力 (同本文件 ③ / ⑦ 的处境)。
 *
 * ## 🚨 `__is_acc_sub_push` 零命中守卫 (FR-014)
 *
 * `grep -rn '__is_acc_sub_push' apps/server/src services/futu-shim/src` **必须零命中**
 * (2026-09-16 实跑 exit=1)。该符号是券商 SDK 的私有「账户已订阅推送」标记, 维护者 2026-09-13
 * POC-3 实测**恒为假**, 与「同一次会话确实收到了订单与成交推送」的事实矛盾 (原始记录见
 * `docs/private/evidence/broker-account-poc/`) ⇒ FR-014 明令健康判据不依赖它。
 *
 * ⚠️ **正因为守卫扫的是 `src`**, `broker-account.port.ts` / `futu-broker-account.adapter.ts` /
 * `futu_shim/app.py` 那三处注释**刻意不写出这个符号**(写出来守卫扫到的就是自己那行注释,
 * 守卫随即失去意义)。符号名只留在本文件与 commit message 里 —— 将来谁真的去**用**它, 守卫照样红。
 *
 * ## T018 定向变异留档 (2026-09-16)
 *
 * - 基线: 本文件 24/24 绿 (T006 8 + T007 4 + T018 4 + T013 4 + T008 4)。
 * - a. **回查补写改走 `vendorUpdatedAt` 守卫** (`recheckLegs` 的 `updateMany` 加回
 *   `vendorUpdatedAt: { lt: order.vendorUpdatedAt }`): **① ③ ④ 三条红, 21 条绿**。回查行与推送
 *   行的时间戳**相等**, 守卫一挂上就永远补不动 —— 正是 FR-020 要钉的形态。
 * - b. ⚠️ **起片时 tasks.md 写的那个变异够不到本文件**: 「去掉『合成码不可解析』判据」改的是
 *   **adapter** (`futu-broker-account.adapter.ts` 的 `legsPending`), 而本 IT 用 port test double
 *   喂**已规范化**的行、`legsPending` 由夹具直接给 ⇒ adapter 压根不在本 IT 的路径上。实跑确认:
 *   该变异下本文件 **24/24 全绿, 一条都不红**。它对应的是 **T005 的 adapter spec 臂 ④b** ——
 *   在那里跑同一个变异: **1 failed | 28 passed**, 恰好只有 ④b 红。
 * - b2. **本 IT 层的等价变异** = 登记改按「腿为空」而非按 `legsPending`
 *   (`orderRows.filter((o) => o.row.comboLegCodes.length === 0)`): **② 一条红, 23 条绿** ——
 *   普通单腿单的腿列表本来就空, 于是**每一张**都被送去回查, 回查量与订单量同阶。
 * - 变异均已还原 (与备份 `diff -q` 一致), 还原后 24/24 复绿。
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
 * 事件源报出的「最近一次事件到达时刻」(084 FR-014)。
 *
 * 🚨 夹具里是个**定值**, 且与本批有没有行无关 —— 这正是被测的性质: 事件源每拍都报同一个值,
 * 直到真的又收到一条推送。实现若拿响应时刻 / `now` 顶替, T013-② 会红。
 */
const LAST_EVENT_AT = new Date('2026-09-16T14:30:55.400Z');

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
  /** T018 空腿回查的查询路径结果 (文本腿形态), 按市场预置。 */
  ordersByMarket: Partial<Record<BrokerMarket, BrokerOrderRow[]>> = {};
  fetchOrdersFailure: Error | null = null;
  /** 期权码 → 正股 canonical ticker; 未登记 ⇒ `null` (券商不认)。 */
  stockOwners = new Map<string, string | null>();
  /** 非 null ⇒ `fetchEvents` 等到这么多个调用都到齐后同时放行 (并发臂把两个写方对齐到写入前)。 */
  barrier: { size: number; waiting: (() => void)[] } | null = null;

  reset() {
    this.batches = [EMPTY_BATCH];
    this.positions = [];
    this.failure = null;
    this.calls = [];
    this.queries = [];
    this.barrier = null;
    this.ordersByMarket = {};
    this.fetchOrdersFailure = null;
    this.stockOwners = new Map();
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
  async fetchOrders(market: BrokerMarket, window: BrokerTradeWindow) {
    // 🚨 带上市场与窗口: T018 要断言「一拍只回查一次」, 只记方法名分不出打了几次、打的哪天。
    this.calls.push(`fetchOrders:${market}:${window.start}..${window.end}`);
    if (this.fetchOrdersFailure !== null) throw this.fetchOrdersFailure;
    return this.ordersByMarket[market] ?? [];
  }
  async fetchStockOwners(_market: BrokerMarket, codes: readonly string[]) {
    this.calls.push('fetchStockOwners');
    return new Map(codes.map((code) => [code, this.stockOwners.get(code) ?? null]));
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
  lastEventAt: LAST_EVENT_AT,
  ...over,
});

describe('084 T006 推送事件消费 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let live: TestingModule;
  let mock: TestingModule;
  let prisma: PrismaService;
  let consume: ConsumeBrokerEventsUseCase;
  let consumeMock: ConsumeBrokerEventsUseCase;
  let scheduler: BrokerAccountScheduler;
  let schedulerMock: BrokerAccountScheduler;
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
    scheduler = live.get(BrokerAccountScheduler);
    schedulerMock = mock.get(BrokerAccountScheduler);
  }, 180_000);

  afterAll(async () => {
    await live?.close();
    await mock?.close();
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

  describe('T007 去抖刷持仓 (5 秒窗口合并为一次)', () => {
    const T0 = new Date('2026-09-16T14:31:00Z');
    const plus = (ms: number) => new Date(T0.getTime() + ms);
    const tick = (
      now: Date,
      cursor: Parameters<ConsumeBrokerEventsUseCase['execute']>[0]['cursor'] = null,
    ) => consume.execute({ connectionId: conn, cursor, now });
    const positionCalls = () => port.calls.filter((c) => c === 'fetchPositions').length;

    const positionRow = (code: string): BrokerPositionRow => ({
      market: 'us',
      code,
      qty: new Prisma.Decimal(-1),
      marketValue: new Prisma.Decimal('-250'),
      costPrice: null,
      averageCost: null,
      currentPrice: new Prisma.Decimal('2.5'),
      currency: 'USD',
      raw: { code },
    });

    it('① 🚨 窗口内多条同市场事件 ⇒ 持仓查询只发生一次 (branch 21)', async () => {
      // 🚨 断言的是**调用次数**, 不是「持仓被刷新了」—— 后者对「逐条刷」的实现同样绿。
      port.positions = [positionRow(ANCHORED)];
      port.batches = [
        batchOf([dealEvent(1, 'dl-1', ANCHORED)]),
        batchOf([dealEvent(2, 'dl-2', ANCHORED)], { nextSeq: 2 }),
        batchOf([dealEvent(3, 'dl-3', ANCHORED)], { nextSeq: 3 }),
        batchOf([], { nextSeq: 3 }),
      ];

      await tick(T0);
      await tick(plus(2_000), { epoch: 'e1', lastSeq: 1 });
      await tick(plus(4_000), { epoch: 'e1', lastSeq: 2 });
      // 窗口未到期 ⇒ 一次都还没刷 (三条事件各刷一次的实现在这里就红了)。
      expect(positionCalls()).toBe(0);

      await tick(plus(6_000), { epoch: 'e1', lastSeq: 3 });
      expect(positionCalls()).toBe(1);
      expect(await prisma.brokerDeal.count()).toBe(3);
    });

    it('② 刷新成功 ⇒ 持仓 syncedAt = 本次刷新时刻, 留下一条 kind=push 的成功记录 (branch 8)', async () => {
      port.positions = [positionRow(ANCHORED)];
      port.batches = [batchOf([dealEvent(1, 'dl-1', ANCHORED)]), batchOf([], { nextSeq: 1 })];

      await tick(T0);
      const refreshAt = plus(6_000);
      const outcome = await tick(refreshAt, { epoch: 'e1', lastSeq: 1 });

      expect(outcome).toMatchObject({ ok: true, refreshedMarkets: ['us'] });
      const position = await prisma.brokerPosition.findFirstOrThrow({});
      expect(position.syncedAt.toISOString()).toBe(refreshAt.toISOString());
      expect(position.code).toBe(ANCHORED);
      const runs = await prisma.brokerSyncRun.findMany({});
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        kind: 'push',
        status: 'succeeded',
        market: 'us',
        target: '*',
      });
    });

    it('⑥ 无事件 ⇒ 不刷持仓、不产生推送记录 (branch 9 的刷新半)', async () => {
      port.positions = [positionRow(ANCHORED)];
      port.batches = [batchOf([], { nextSeq: 0 })];

      await tick(T0);
      await tick(plus(6_000));
      await tick(plus(12_000));

      expect(positionCalls()).toBe(0);
      expect(await prisma.brokerSyncRun.count()).toBe(0);
      expect(await prisma.brokerPosition.count()).toBe(0);
    });

    it('⑦ 不属锚标的的事件 ⇒ 不登记待刷新, 窗口过后也不刷 (branch 2 的刷新半)', async () => {
      port.positions = [positionRow(ANCHORED)];
      port.batches = [batchOf([dealEvent(1, 'dl-out', UNANCHORED)]), batchOf([], { nextSeq: 1 })];

      await tick(T0);
      await tick(plus(6_000), { epoch: 'e1', lastSeq: 1 });

      expect(positionCalls()).toBe(0);
      expect(await prisma.brokerSyncRun.count()).toBe(0);
    });
  });

  /**
   * T013 订阅健康判据 (FR-014 / FR-018; plan D8 / D10; state_branches 9)。
   *
   * 判据 = 「最近一次事件到达时刻」+ 缺口补偿留痕。🚨 **MUST NOT 用 SDK 私有标记
   * `__is_acc_sub_push`** —— 维护者 2026-09-13 POC-3 实测该标记**恒为假**, 与「同一次会话
   * 确实收到了订单与成交推送」的事实矛盾 (原始记录见 `docs/private/evidence/broker-account-poc/`)。
   * 全仓零命中由 `grep -rn '__is_acc_sub_push' apps/server/src services/futu-shim/src` 守着。
   *
   * 阈值 (多久没事件算异常) 本片**不定** —— 见 spec clarify 覆盖率表的 Outstanding 项;
   * 本片不主动通知, 阈值只影响排障展示。
   */
  /**
   * T018 组合单空腿的**按订单号回查补全** (FR-020; plan D2; state_branches 15)。
   *
   * ⚠️ **impl 期 (2026-09-16) 补入的 task**: spec 的 Edge Case 与 FR-020 都写了「腿解析出空
   * 结果时 MUST 按订单号回查补全**并留痕**」, 起片时的 tasks 只落了**留痕**半边 (T005-④ 标
   * `legsPending` + T006 的 warn), 回查补全半边全仓无 task。
   *
   * 🚨 **补写不能走 `vendorUpdatedAt < incoming` 守卫**: 回查拿到的与推送写进去的是**同一个
   * 订单状态**, 时间戳相等 ⇒ 走守卫就永远改不动, 而且 🚫 指望「下次开盘前对账自然补上」——
   * 对账走的是同一个 `writeOrders`、被同一个守卫挡着。
   */
  describe('T018 组合单空腿的按订单号回查补全', () => {
    const T0 = new Date('2026-09-16T14:31:00Z');
    const plus = (ms: number) => new Date(T0.getTime() + ms);
    const tick = (
      now: Date,
      cursor: Parameters<ConsumeBrokerEventsUseCase['execute']>[0]['cursor'] = null,
    ) => consume.execute({ connectionId: conn, cursor, now });
    const orderCalls = () => port.calls.filter((c) => c.startsWith('fetchOrders'));
    const legsOf = async () =>
      (await prisma.brokerOrder.findMany({ orderBy: { orderId: 'asc' } })).map(
        (o) => o.comboLegCodes,
      );

    /** 券商合成码: 带分隔符 ⇒ `parseBrokerCode` 判不出单一合约, 正是 `legsPending` 的另一半判据。 */
    const COMBO_CODE = 'US.ZQP-COMBO';
    /** 两条腿同属正股 ZQP ⇒ 补全后组合单的标的归属判得出来。 */
    const LEG_CALL = 'US.ZQP260918C120000';
    const LEG_PUT = 'US.ZQP260918P100000';

    /** 推送来的组合单: 腿为空且合成码不可解析 ⇒ `legsPending`。 */
    const comboOrderEvent = (seq: number, orderId: string): BrokerEvent =>
      orderEvent(seq, orderId, COMBO_CODE, { comboLegs: [], legsPending: true });

    /** 回查 (查询路径) 拿到的同一张单: 腿是**文本**形态, 经 `parseComboLegs` 已解出腿码。 */
    const queryOrder = (orderId: string): BrokerOrderRow => ({
      market: 'us',
      orderId,
      code: COMBO_CODE,
      comboLegCodes: [LEG_CALL, LEG_PUT],
      side: 'SELL_SHORT',
      orderType: 'NORMAL',
      qty: new Prisma.Decimal(1),
      price: new Prisma.Decimal('2.5'),
      status: 'SUBMITTED',
      currency: 'USD',
      vendorCreatedAt: new Date('2026-09-16T14:00:00.000Z'),
      // 🚨 与推送那条**同一个**时间戳 —— 补写若走守卫就永远补不上 (定向变异 a 把它改回去)。
      vendorUpdatedAt: new Date('2026-09-16T14:00:08.950Z'),
      raw: { order_id: orderId },
    });

    const seedOwners = () => {
      port.stockOwners = new Map([
        [LEG_CALL, 'us:ZQP'],
        [LEG_PUT, 'us:ZQP'],
      ]);
    };

    it('① 腿空的组合单 ⇒ 回查补全腿码与标的归属, 且只打一次 fetchOrders (FR-020)', async () => {
      seedOwners();
      port.ordersByMarket = { us: [queryOrder('orcombo')] };
      port.batches = [batchOf([comboOrderEvent(1, 'orcombo')])];

      const outcome = await tick(T0);

      expect(outcome).toMatchObject({ ok: true, ordersInserted: 1, legsBackfilled: 1 });
      const row = await prisma.brokerOrder.findFirstOrThrow({});
      expect(row.comboLegCodes).toEqual([LEG_CALL, LEG_PUT]);
      // 归属补上才是 FR-020 的目的 —— 只补腿码的话组合单仍挂在一个判不出的标的上。
      expect(row.underlyingTicker).toBe('us:ZQP');
      // 🚨 时间戳没变过: 证明这次补写确实**绕开**了 `vendorUpdatedAt` 守卫。
      expect(row.vendorUpdatedAt.toISOString()).toBe('2026-09-16T14:00:08.950Z');
      // 🚨 断言调用次数, 不是「腿补上了」—— 后者对「每条 pending 行各打一次」的实现同样绿。
      expect(orderCalls()).toHaveLength(1);
    });

    it('② 🚨 普通单腿单 (腿空但合成码可解析) ⇒ 不触发回查', async () => {
      port.ordersByMarket = { us: [queryOrder('or1')] };
      port.batches = [batchOf([orderEvent(1, 'or1', ANCHORED)]), batchOf([], { nextSeq: 1 })];

      await tick(T0);
      await tick(plus(6_000), { epoch: 'e1', lastSeq: 1 });

      // 单腿单的腿列表本来就空 —— 只按「腿为空」判 pending 会把**每一张**普通单都送去回查,
      // 回查量与订单量同阶, 券商配额当场打满 (而限频的表现是持仓静默不刷新)。
      expect(orderCalls()).toEqual([]);
      expect(await legsOf()).toEqual([[]]);
    });

    it('③ 回查失败 ⇒ 留痕、既有行一行不动、去抖窗口内不重打、过窗后补上', async () => {
      seedOwners();
      port.ordersByMarket = { us: [queryOrder('orcombo')] };
      port.fetchOrdersFailure = new BrokerInfrastructureError('trade/orders', 'ECONNRESET');
      port.batches = [batchOf([comboOrderEvent(1, 'orcombo')]), batchOf([], { nextSeq: 1 })];
      const errors: string[] = [];
      vi.spyOn(Logger.prototype, 'error').mockImplementation((m) => void errors.push(String(m)));

      const first = await tick(T0);

      expect(first).toMatchObject({ ok: true, legsBackfilled: 0 });
      expect(await legsOf()).toEqual([[]]);
      expect(orderCalls()).toHaveLength(1);
      expect(errors.some((l) => l.includes('回查'))).toBe(true);
      // 🚫 日志不带订单号 / 账户号 (FR-019)。
      for (const line of errors) expect(line).not.toContain(String(ACCOUNT_ID));

      // 去抖窗口内不重打 —— 一张永远补不上的单会把券商配额耗光。
      await tick(plus(2_000), { epoch: 'e1', lastSeq: 1 });
      expect(orderCalls()).toHaveLength(1);

      port.fetchOrdersFailure = null;
      const retried = await tick(plus(ORDER_LEGS_RECHECK_DEBOUNCE_MS + 1_000), {
        epoch: 'e1',
        lastSeq: 1,
      });

      expect(retried).toMatchObject({ ok: true, legsBackfilled: 1 });
      expect(await legsOf()).toEqual([[LEG_CALL, LEG_PUT]]);
    });

    it('④ 单拍上限生效: pending 超上限时本拍只补上限条, 其余留到下一拍', async () => {
      seedOwners();
      const ids = Array.from(
        { length: ORDER_LEGS_RECHECK_MAX_PER_TICK + 1 },
        (_, i) => `orc${String(i).padStart(2, '0')}`,
      );
      port.ordersByMarket = { us: ids.map((id) => queryOrder(id)) };
      port.batches = [
        batchOf(ids.map((id, i) => comboOrderEvent(i + 1, id))),
        batchOf([], { nextSeq: ids.length }),
      ];
      const filled = async () => (await legsOf()).filter((legs) => legs.length > 0).length;

      const first = await tick(T0);

      expect(first).toMatchObject({ ok: true, legsBackfilled: ORDER_LEGS_RECHECK_MAX_PER_TICK });
      expect(await filled()).toBe(ORDER_LEGS_RECHECK_MAX_PER_TICK);

      // 🚨 剩下那张没有被丢弃: 上限只推迟、不放弃 (放弃的话它的归属永久缺失且无人察觉)。
      const second = await tick(plus(ORDER_LEGS_RECHECK_DEBOUNCE_MS + 1_000), {
        epoch: 'e1',
        lastSeq: ids.length,
      });

      expect(second).toMatchObject({ ok: true, legsBackfilled: 1 });
      expect(await filled()).toBe(ids.length);
    });
  });

  describe('T013 订阅健康判据: 最近事件到达时刻', () => {
    /** 按级别捕获本用例经 NestJS `Logger` 写出的行 (④ 要扫的是**全部**日志, 三个级别都得在)。 */
    const captureLogs = () => {
      const info: string[] = [];
      const warn: string[] = [];
      const error: string[] = [];
      vi.spyOn(Logger.prototype, 'log').mockImplementation((m) => void info.push(String(m)));
      vi.spyOn(Logger.prototype, 'warn').mockImplementation((m) => void warn.push(String(m)));
      vi.spyOn(Logger.prototype, 'error').mockImplementation((m) => void error.push(String(m)));
      return { info, warn, error, all: () => [...info, ...warn, ...error] };
    };

    it('① 消费成功 ⇒ 带出最近事件时刻, 并写一行 info (条数 / 写入 / 是否补偿 / 耗时)', async () => {
      port.batches = [batchOf([dealEvent(1, 'dl-1', ANCHORED)])];
      const logs = captureLogs();

      const outcome = await run();

      expect(outcome).toMatchObject({ ok: true, lastEventAt: LAST_EVENT_AT });
      const line = logs.info.find((l) => l.startsWith('推送事件消费'));
      expect(line).toBeDefined();
      expect(line).toContain('accepted=1');
      expect(line).toContain('deals+1');
      expect(line).toContain('gap=false');
      expect(line).toContain(`lastEventAt=${LAST_EVENT_AT.toISOString()}`);
      expect(line).toMatch(/elapsedMs=\d+/);
    });

    it('② 🚨 长时间无事件 ⇒ 该时刻保持不变、不产生任何记录 (branch 9)', async () => {
      port.batches = [
        batchOf([dealEvent(1, 'dl-1', ANCHORED)]),
        batchOf([], { nextSeq: 1 }),
        batchOf([], { nextSeq: 1 }),
      ];

      const first = await run();
      const idle1 = await run({ epoch: 'e1', lastSeq: 1 });
      const idle2 = await run({ epoch: 'e1', lastSeq: 1 });

      // 🚨 断言三拍报的是**同一个**时刻: 拿响应时刻 / `now` 顶替的实现会让这三个值各不相同,
      // 于是「通道哑了多久」永远算不出来, 且不报错。
      expect(first).toMatchObject({ ok: true, lastEventAt: LAST_EVENT_AT });
      expect(idle1).toMatchObject({ ok: true, lastEventAt: LAST_EVENT_AT });
      expect(idle2).toMatchObject({ ok: true, lastEventAt: LAST_EVENT_AT });
      expect(await prisma.brokerSyncRun.count()).toBe(0);
    });

    it('③ 触发缺口补偿 ⇒ 出现 warn 级留痕 (FR-018: 补偿留痕是健康判据的另一半)', async () => {
      port.batches = [
        batchOf([dealEvent(1, 'dl-1', ANCHORED)]),
        batchOf([dealEvent(5, 'dl-5', ANCHORED)], { nextSeq: 5 }),
      ];
      const logs = captureLogs();

      await run();
      const outcome = await run({ epoch: 'e1', lastSeq: 1 });

      expect(outcome).toMatchObject({ ok: true, gapDetected: true });
      expect(logs.warn.some((l) => l.startsWith('推送事件断档'))).toBe(true);
      expect(logs.info.some((l) => l.includes('gap=true'))).toBe(true);
    });

    it('④ 🚨 本用例写出的每一行日志都不含券商账户号 (FR-019 / SC-008)', async () => {
      port.batches = [
        batchOf([dealEvent(1, 'dl-1', ANCHORED), orderEvent(2, 'or-1', ANCHORED)]),
        batchOf([dealEvent(9, 'dl-9', ANCHORED)], { nextSeq: 9 }),
      ];
      const logs = captureLogs();

      await run();
      await run({ epoch: 'e1', lastSeq: 2 });
      port.failure = new BrokerInfrastructureError('trade/events', 'ECONNRESET');
      await run({ epoch: 'e1', lastSeq: 9 });

      // 🚨 先证明三个级别**都真的写出过东西** —— 否则「不含账户号」是个空断言。
      expect(logs.info.length).toBeGreaterThan(0);
      expect(logs.warn.length).toBeGreaterThan(0);
      expect(logs.error.length).toBeGreaterThan(0);
      for (const line of logs.all()) {
        expect(line).not.toContain(String(ACCOUNT_ID));
      }
    });
  });

  describe('T008 2 秒心跳接入调度器', () => {
    it('② mock 档 ⇒ 整拍跳过, port 调用数 0 (branch 12; FR-016)', async () => {
      port.batches = [batchOf([dealEvent(1, 'dl-1', ANCHORED)])];

      const outcome = await schedulerMock.runEvents(NOW);

      expect(outcome).toEqual({ status: 'skipped-mock' });
      expect(port.calls).toEqual([]);
      expect(await prisma.brokerDeal.count()).toBe(0);
    });

    it('③ 连接 A 抛错 ⇒ 本拍不上抛, 连接 B 照常消费', async () => {
      const connB = (
        await prisma.brokerConnection.create({
          data: { accountId: ACCOUNT_ID, brokerCode: 'futu', label: 'it-b', phoneLast4: '0000' },
        })
      ).id;
      port.batches = [batchOf([dealEvent(1, 'dl-b', ANCHORED)])];
      // 🚨 抛错必须从 use case 抛出来: port 失败会被 use case 收成 `ok:false` 返回值,
      // 那条路径验的是「失败留痕」而不是这条「不连坐」。
      const execute = consume.execute.bind(consume);
      vi.spyOn(consume, 'execute').mockImplementation((input) =>
        input.connectionId === conn ? Promise.reject(new Error('db down')) : execute(input),
      );
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const outcome = await scheduler.runEvents(NOW);

      expect(outcome).toEqual({ status: 'ticked', connections: 2, failedConnections: 1 });
      const deals = await prisma.brokerDeal.findMany({});
      expect(deals.map((d) => [d.connectionId, d.dealId])).toEqual([[connB, 'dl-b']]);
    });

    it('④ 直调两次 runEvents ⇒ 游标前移, 不重复消费同一批事件', async () => {
      port.batches = [batchOf([dealEvent(1, 'dl-1', ANCHORED)]), batchOf([], { nextSeq: 1 })];

      await scheduler.runEvents(NOW);
      await scheduler.runEvents(NOW);

      // 🚨 断言的是**第二拍带着前移后的游标去拉** —— 只断言「库里 1 条」的话, 游标压根没存
      // 住、第二拍从头重拉的实现也会绿 (幂等写把重复消费吸收掉了)。
      expect(port.queries).toEqual([null, { epoch: 'e1', afterSeq: 1 }]);
      expect(await prisma.brokerDeal.count()).toBe(1);
    });
  });
});

/**
 * T008 臂 ①: 心跳注册面。另起只含 `ScheduleModule.forRoot()` + 本调度器的最小模块 ——
 * 主模块的收窄 boot 蓄意不注册 `ScheduleModule` (`narrow-boot.ts`), 拿不到 `SchedulerRegistry`。
 * 形制照 082 同名 describe。
 */
describe('084 T008 推送事件心跳: cron 注册 (无 DB)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [BrokerAccountScheduler],
    })
      .useMocker(() => ({ kind: 'mock' }))
      .compile();
    // init 才挂载 cron (orchestrator 的 onApplicationBootstrap), 挂载即 start ⇒ 立刻 stop。
    // 🚨 本拍 2 秒一次 (082 那拍 60 秒): 不 stop 的话测试期**真会触发**。
    await moduleRef.init();
    for (const job of moduleRef.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('① SchedulerRegistry 中的推送事件 job 存在且 waitForCompletion === true', () => {
    const job = moduleRef.get(SchedulerRegistry).getCronJob(BROKER_EVENT_HEARTBEAT);
    expect(job.waitForCompletion).toBe(true);
  });
});
