import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { Prisma } from '../../src/generated/prisma/client';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { optionsdeskConfig, type OptionsdeskConfig } from '../../src/config/optionsdesk.config';
import {
  BROKER_ACCOUNT_PORT,
  type BrokerAccountPort,
  type BrokerDealRow,
  type BrokerOrderRow,
  type BrokerTradeWindow,
} from '../../src/optionsdesk/broker-account.port';
import type { BrokerMarket } from '../../src/optionsdesk/broker-code.rules';
import {
  SyncBrokerAccountUseCase,
  type SyncBrokerAccountInput,
} from '../../src/optionsdesk/sync-broker-account.usecase';

process.env.AUTH_JWT_SECRET ??= 'optionsdesk-082-it-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-082-it-hmac-secret-min-32-bytes';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 082 T014 —— 券商同步 use case 上半 (拉成交与订单 → 正股判定 → 范围过滤 → 原子幂等写) 的
 * **真 PG IT** (FR-001 / FR-005 / FR-007 / FR-009 / FR-012 / FR-013; plan D1 / D7;
 * state_branches 1, 2, 3, 4, 5, 11, 12, 16)。
 *
 * ## 为什么必须要真 PG
 *
 * ① 幂等 = `createMany({ skipDuplicates })` 的 ON CONFLICT DO NOTHING 与唯一键
 *    `(connection_id, deal_id)` / `(connection_id, order_id)` 的组合, 只在真库成立。
 * ② 订单守卫 `vendor_updated_at < incoming` 的**毫秒**比较由 `timestamptz(6)` 列承载 ——
 *    同秒不同毫秒 (`…:08.950` vs `…:08.898`) 在 fake 里只是两个 JS Date。
 * ③ 并发两写方收敛到最新版本、且不抛 `P2002`, 依赖 READ COMMITTED 下的推测插入等待 +
 *    行锁; mock Prisma 里两条都会「成功」, 验不到任何东西。
 *
 * 装配 = `OptionsdeskModule` 真 DI (plan Testing Invariants), **只替换** `BROKER_ACCOUNT_PORT`。
 * `full` 范围用第二个真装配模块 + `BROKER_SYNC_SCOPE=full` 环境变量取得 (不 override config)。
 *
 * ## 定向变异留档 (2026-09-14, 类型合法形态, 均经 `pnpm nx test server <本文件>`)
 *
 * - 基线: 11/11 绿。
 * - a 订单守卫 `lt` → `lte` (tasks 原定变异): 「同秒 .898 晚到」**仍绿** —— 两种写法只在版本时刻相等时有别,
 *   该臂两版本不等, 结构上抓不到; 被「同一补齐重复执行」抓红 (重放时同版本被重写, `ordersUpdated` ≠ 0)。
 * - a2 去掉守卫 (`vendorUpdatedAt: { lte: new Date(8.64e15) }`): 「同秒 .898 晚到」红 (库内 .898),
 *   连带「重复执行」「并发写」红 —— 这是 .950/.898 反向喂入臂真正防的那类错。
 * - b 去掉段重叠 (`start = minusCalendarDays(segmentEnd, -1)`): 「窗口 200 天」红 (后段 start 04-02 ≠ 前段 end 04-01)。
 * - c 订单写改回先查后写 (findMany 过滤后 createMany 不带 skipDuplicates): 「并发写」红,
 *   一方抛 Unique constraint failed on (connection_id, order_id) (P2002)。
 * - 四处均还原 (`cmp` 与备份一致) 后 11/11 绿。
 */

const NOW = new Date('2026-09-14T15:00:00Z');
const WINDOW: BrokerTradeWindow = { start: '2026-09-01', end: '2026-09-14' };
/** 明显假值: 账户号 / 手机尾号一律不用真值 (Guardrail 1)。 */
const ACCOUNT_A = 900_001n;
const ACCOUNT_B = 900_002n;

type Dated<T> = T & { day: string };

/** 券商 port 的 test double: 按 `day ∈ [start, end]` 回放预置行, 记录每次调用的窗口。 */
class FakeBrokerPort implements BrokerAccountPort {
  deals: Dated<BrokerDealRow>[] = [];
  /** 每次 `fetchOrders` 消费一组 (耗尽后重复最后一组); 用于并发臂给两个写方不同版本。 */
  orderBatches: Dated<BrokerOrderRow>[][] = [[]];
  owners = new Map<string, string | null>();
  calls: { kind: 'deals' | 'orders'; market: BrokerMarket; window: BrokerTradeWindow }[] = [];
  /** 非 null ⇒ `fetchOrders` 等到这么多个调用都到齐后同时放行 (并发臂把两个写方对齐到写入前)。 */
  ordersBarrier: { size: number; waiting: (() => void)[] } | null = null;

  reset() {
    this.deals = [];
    this.orderBatches = [[]];
    this.owners = new Map();
    this.calls = [];
    this.ordersBarrier = null;
  }

  async getAccountSummary() {
    return { trdmarketAuth: ['US', 'HK'], matched: 1 };
  }
  async fetchPositions() {
    return [];
  }
  async fetchDeals(market: BrokerMarket, window: BrokerTradeWindow) {
    this.calls.push({ kind: 'deals', market, window });
    return this.deals
      .filter((d) => d.market === market && d.day >= window.start && d.day <= window.end)
      .map(({ day: _day, ...row }) => row);
  }
  async fetchOrders(market: BrokerMarket, window: BrokerTradeWindow) {
    this.calls.push({ kind: 'orders', market, window });
    const batch =
      this.orderBatches.length > 1
        ? (this.orderBatches.shift() as Dated<BrokerOrderRow>[])
        : (this.orderBatches[0] as Dated<BrokerOrderRow>[]);
    const barrier = this.ordersBarrier;
    if (barrier !== null) {
      await new Promise<void>((release) => {
        barrier.waiting.push(release);
        if (barrier.waiting.length === barrier.size) barrier.waiting.forEach((r) => r());
      });
    }
    return batch
      .filter((o) => o.market === market && o.day >= window.start && o.day <= window.end)
      .map(({ day: _day, ...row }) => row);
  }
  async fetchStockOwners(_market: BrokerMarket, codes: readonly string[]) {
    return new Map(codes.map((code) => [code, this.owners.get(code) ?? null]));
  }
}

const deal = (dealId: string, code: string, day = '2026-09-10'): Dated<BrokerDealRow> => ({
  day,
  market: 'us',
  dealId,
  orderId: `o-${dealId}`,
  code,
  side: 'SELL_SHORT',
  qty: new Prisma.Decimal(1),
  price: new Prisma.Decimal('2.5'),
  currency: 'USD',
  tradedAt: new Date(`${day}T14:30:00.123Z`),
  raw: { deal_id: dealId, code },
});

const order = (
  orderId: string,
  code: string,
  over: Partial<BrokerOrderRow> = {},
  day = '2026-09-10',
): Dated<BrokerOrderRow> => ({
  day,
  market: 'us',
  orderId,
  code,
  comboLegCodes: [],
  side: 'SELL_SHORT',
  orderType: 'NORMAL',
  qty: new Prisma.Decimal(1),
  price: new Prisma.Decimal('2.5'),
  status: 'SUBMITTED',
  currency: 'USD',
  vendorCreatedAt: new Date(`${day}T14:00:00.000Z`),
  vendorUpdatedAt: new Date(`${day}T14:00:08.000Z`),
  raw: { order_id: orderId, code },
  ...over,
});

const daysBetween = (a: string, b: string) =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

describe('082 券商同步 use case (上): 成交与订单写入 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let anchored: TestingModule;
  let full: TestingModule;
  let prisma: PrismaService;
  let sync: SyncBrokerAccountUseCase;
  let syncFull: SyncBrokerAccountUseCase;
  let connA: bigint;
  let connB: bigint;
  const port = new FakeBrokerPort();

  const compile = () =>
    Test.createTestingModule({ imports: narrowTestModule([OptionsdeskModule]) })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .overrideProvider(BROKER_ACCOUNT_PORT)
      .useValue(port)
      .compile();

  const run = (over: Partial<SyncBrokerAccountInput> = {}, uc = sync) =>
    uc.execute({
      connectionId: connB,
      markets: ['us'],
      target: '*',
      window: WINDOW,
      mode: 'backfill',
      now: NOW,
      ...over,
    });

  const dealCodes = async () =>
    (await prisma.brokerDeal.findMany({ orderBy: { dealId: 'asc' } })).map((d) => d.code);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    delete process.env.BROKER_SYNC_SCOPE;
    anchored = await compile();
    process.env.BROKER_SYNC_SCOPE = 'full';
    full = await compile();
    delete process.env.BROKER_SYNC_SCOPE;

    prisma = anchored.get(PrismaService);
    sync = anchored.get(SyncBrokerAccountUseCase);
    syncFull = full.get(SyncBrokerAccountUseCase);
  }, 180_000);

  afterAll(async () => {
    await anchored?.close();
    await full?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    port.reset();
    await prisma.brokerDeal.deleteMany({});
    await prisma.brokerOrder.deleteMany({});
    await prisma.brokerContractRef.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.optionContract.deleteMany({});
    await prisma.instrument.deleteMany({});

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
    await anchor('us:PEP', false);
    await anchor('us:KO', true);

    const pep = await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'PEP',
        name: 'PEP',
        type: 'stock',
        currency: 'USD',
        status: 'active',
      },
    });
    await prisma.optionContract.create({
      data: {
        market: 'us',
        code: 'US.PEP261016P100000',
        root: 'PEP',
        underlyingInstrumentId: pep.id,
        expiryDate: new Date('2026-10-16T00:00:00Z'),
        strikePrice: '100',
        optionType: 'PUT',
        isStandard: true,
      },
    });

    const conn = (accountId: bigint) =>
      prisma.brokerConnection.create({
        data: { accountId, brokerCode: 'futu', label: 'it', phoneLast4: '0000' },
      });
    connA = (await conn(ACCOUNT_A)).id;
    connB = (await conn(ACCOUNT_B)).id;
  });

  it('只锚标的 ∧ 行属锚标的 ⇒ 写入; 行不属锚标的 ⇒ 不写入 (成交与订单)', async () => {
    port.deals = [deal('d1', 'US.PEP'), deal('d2', 'US.AAPL'), deal('d3', 'US.PEP240119P90000')];
    port.orderBatches = [[order('o1', 'US.PEP'), order('o2', 'US.AAPL')]];

    const res = await run();

    expect(await dealCodes()).toEqual(['US.PEP', 'US.PEP240119P90000']);
    expect((await prisma.brokerOrder.findMany()).map((o) => o.code)).toEqual(['US.PEP']);
    expect(res).toMatchObject({ dealsInserted: 2, ordersInserted: 1 });
    expect(
      (await prisma.brokerDeal.findMany({ orderBy: { dealId: 'asc' } })).map(
        (d) => d.underlyingTicker,
      ),
    ).toEqual(['us:PEP', 'us:PEP']);
  });

  it('被标为不参与交易 (excluded) 的锚照常写入', async () => {
    port.deals = [deal('d1', 'US.KO')];
    port.orderBatches = [[order('o1', 'US.KO')]];

    await run();

    expect(await dealCodes()).toEqual(['US.KO']);
    expect(await prisma.brokerOrder.count()).toBe(1);
  });

  it('范围=全量 ⇒ 账户内全部成交 / 订单写入', async () => {
    expect(full.get<OptionsdeskConfig>(optionsdeskConfig.KEY).brokerSyncScope).toBe('full');
    port.deals = [deal('d1', 'US.PEP'), deal('d2', 'US.AAPL')];
    port.orderBatches = [[order('o1', 'US.PEP'), order('o2', 'US.AAPL')]];

    await run({}, syncFull);

    expect(await dealCodes()).toEqual(['US.PEP', 'US.AAPL']);
    expect(await prisma.brokerOrder.count()).toBe(2);
  });

  it('期权代码判定不出正股 ⇒ 照常写入并标记未解析, 可按未解析计数', async () => {
    port.deals = [deal('d1', 'US.GHOST240119P10000'), deal('d2', 'US.PEP')];
    port.orderBatches = [[order('o1', 'US.GHOST240119P10000')]];

    const res = await run();

    expect(res).toMatchObject({ dealsInserted: 2, unresolvedDeals: 1, unresolvedOrders: 1 });
    expect(await prisma.brokerDeal.count({ where: { underlyingTicker: null } })).toBe(1);
    expect(await prisma.brokerOrder.count({ where: { underlyingTicker: null } })).toBe(1);
  });

  it('组合单 ⇒ 按各腿合约归属正股, 不按合成代码判定', async () => {
    // 合成码字面是非锚正股 `US.AAPL`: 若按合成码判定, anchored 下这张单会被滤掉。
    const combo = order('o-combo', 'US.AAPL', {
      comboLegCodes: ['US.PEP261016P100000', 'US.PEP240119P90000'],
    });
    const mixed = order('o-mixed', 'US.PEP', {
      comboLegCodes: ['US.PEP261016P100000', 'US.GHOST240119P10000'],
    });
    port.orderBatches = [[combo, mixed]];

    await run();

    const rows = await prisma.brokerOrder.findMany({ orderBy: { orderId: 'asc' } });
    expect(rows.map((r) => [r.orderId, r.underlyingTicker, r.comboLegCodes])).toEqual([
      ['o-combo', 'us:PEP', ['US.PEP261016P100000', 'US.PEP240119P90000']],
      ['o-mixed', null, ['US.PEP261016P100000', 'US.GHOST240119P10000']],
    ]);
  });

  it('同一补齐重复执行 ⇒ 成交 / 订单行数与内容逐条相同', async () => {
    port.deals = [deal('d1', 'US.PEP'), deal('d2', 'US.KO')];
    port.orderBatches = [[order('o1', 'US.PEP'), order('o2', 'US.KO', { status: 'FILLED_ALL' })]];

    await run();
    const deals1 = await prisma.brokerDeal.findMany({ orderBy: { id: 'asc' } });
    const orders1 = await prisma.brokerOrder.findMany({ orderBy: { id: 'asc' } });
    const again = await run();
    const deals2 = await prisma.brokerDeal.findMany({ orderBy: { id: 'asc' } });
    const orders2 = await prisma.brokerOrder.findMany({ orderBy: { id: 'asc' } });

    expect(again).toMatchObject({ dealsInserted: 0, ordersInserted: 0, ordersUpdated: 0 });
    expect(deals2).toHaveLength(2);
    expect(orders2).toHaveLength(2);
    expect(deals2).toEqual(deals1);
    expect(orders2).toEqual(orders1);
  });

  it('同一订单较旧状态 (同秒 .898) 晚于较新状态 (.950) 到达 ⇒ 不覆盖较新状态', async () => {
    const newer = order('o1', 'US.PEP', {
      status: 'FILLED_PART',
      vendorUpdatedAt: new Date('2026-09-10T14:00:08.950Z'),
    });
    const older = order('o1', 'US.PEP', {
      status: 'SUBMITTED',
      vendorUpdatedAt: new Date('2026-09-10T14:00:08.898Z'),
    });
    port.orderBatches = [[newer], [older]];

    await run();
    const second = await run();

    const row = await prisma.brokerOrder.findFirstOrThrow({ where: { orderId: 'o1' } });
    expect(row.vendorUpdatedAt.toISOString()).toBe('2026-09-10T14:00:08.950Z');
    expect(row.status).toBe('FILLED_PART');
    expect(second.ordersUpdated).toBe(0);
  });

  it("补齐范围 target='*' ⇒ 覆盖同步范围内全部标的; 单只标的只写该标的 (与未解析行)", async () => {
    port.deals = [
      deal('d1', 'US.PEP'),
      deal('d2', 'US.KO'),
      deal('d3', 'US.AAPL'),
      deal('d4', 'US.GHOST240119P10000'),
    ];

    await run({ target: 'us:KO' });
    expect(await dealCodes()).toEqual(['US.KO', 'US.GHOST240119P10000']);

    await prisma.brokerDeal.deleteMany({});
    await run({ target: '*' });
    expect(await dealCodes()).toEqual(['US.PEP', 'US.KO', 'US.GHOST240119P10000']);
  });

  it('窗口 200 天 ⇒ 每段 ≤ 90 天、相邻段重叠 1 天、首尾对齐; 重叠日的重复成交只落一行', async () => {
    const window = { start: '2026-01-01', end: '2026-07-20' };
    expect(daysBetween(window.start, window.end)).toBe(200);
    // 两段交界日 (段 1 的 end = 段 2 的 start = 2026-04-01) 上的成交会被两段各返回一次。
    port.deals = [
      deal('d-overlap', 'US.PEP', '2026-04-01'),
      deal('d-late', 'US.PEP', '2026-07-20'),
    ];

    const res = await run({ window });

    const segments = port.calls.filter((c) => c.kind === 'deals').map((c) => c.window);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]?.start).toBe(window.start);
    expect(segments.at(-1)?.end).toBe(window.end);
    for (const [i, seg] of segments.entries()) {
      expect(daysBetween(seg.start, seg.end)).toBeLessThanOrEqual(90);
      if (i > 0) expect(seg.start).toBe(segments[i - 1]?.end);
    }
    expect(port.calls.filter((c) => c.kind === 'orders').map((c) => c.window)).toEqual(segments);
    expect(await prisma.brokerDeal.count({ where: { dealId: 'd-overlap' } })).toBe(1);
    expect(res.dealsInserted).toBe(2);
  });

  it('每张表每行 account_id = 所同步连接的账号 (不取别的连接)', async () => {
    port.deals = [deal('d1', 'US.PEP'), deal('d2', 'US.KO')];
    port.orderBatches = [[order('o1', 'US.PEP')]];

    await run({ connectionId: connB });

    const deals = await prisma.brokerDeal.findMany();
    const orders = await prisma.brokerOrder.findMany();
    expect(deals.length + orders.length).toBe(3);
    for (const row of [...deals, ...orders]) {
      expect(row.accountId).toBe(ACCOUNT_B);
      expect(row.connectionId).toBe(connB);
    }
    expect(connA).not.toBe(connB);
  });

  it('两个 use case 并发写同一批订单 (一方带更新版本) ⇒ 无异常、库内为最新版本', async () => {
    for (let round = 0; round < 3; round++) {
      await prisma.brokerOrder.deleteMany({});
      const ids = Array.from({ length: 40 }, (_, i) => `r${round}-o${String(i).padStart(2, '0')}`);
      const base = (status: string, ms: number) =>
        ids.map((id) =>
          order(id, 'US.PEP', { status, vendorUpdatedAt: new Date(`2026-09-10T14:00:08.${ms}Z`) }),
        );
      port.calls = [];
      port.orderBatches = [base('SUBMITTED', 100), base('FILLED_ALL', 900)];
      port.ordersBarrier = { size: 2, waiting: [] };

      const outcomes = await Promise.allSettled([run(), run()]);

      expect(outcomes.map((o) => (o.status === 'rejected' ? String(o.reason) : 'ok'))).toEqual([
        'ok',
        'ok',
      ]);
      const rows = await prisma.brokerOrder.findMany();
      expect(rows).toHaveLength(ids.length);
      expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['FILLED_ALL']));
    }
  });
});
