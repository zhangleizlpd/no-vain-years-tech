import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { Prisma } from '../../src/generated/prisma/client';
import { MARKETDATA_WORKER_DISABLED } from '../../src/marketdata/marketdata-sync.queue';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import {
  BROKER_ACCOUNT_PORT,
  BrokerInfrastructureError,
  type BrokerAccountPort,
  type BrokerDealRow,
  type BrokerOrderRow,
  type BrokerPositionRow,
  type BrokerTradeWindow,
} from '../../src/optionsdesk/broker-account.port';
import type { BrokerMarket } from '../../src/optionsdesk/broker-code.rules';
import type { BrokerTradeSide } from '../../src/optionsdesk/broker-opened-at.rules';
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
 * 082 T015 —— 券商同步 use case 下半 (持仓刷新 + 开仓时间 + 失败语义 + 同步记录) 的**真 PG IT**
 * (FR-009 / FR-011 / FR-014 / FR-015 / FR-016 / FR-017; plan D1 / D8 / D12;
 * state_branches 8, 9, 10, 13, 14, 15, 16, 30)。
 *
 * ## 为什么必须要真 PG
 *
 * ① 「失败不动既有数据」要在**先铺好**的持仓与成交上逐条比对 —— 失败发生在哪一步、前面有没有
 *    已提交的写, 只有真事务边界能回答; mock Prisma 下每条写都「成功」。
 * ② 开仓时间读的是**库内**成交 (本次同步刚写入的也算), 读写顺序错了只在真库上表现为 `fallback`。
 * ③ 同步记录的状态回写与 `error` VarChar(512) 截断由真列约束承载。
 *
 * 装配 = `OptionsdeskModule` 真 DI (plan Testing Invariants), **只替换** `BROKER_ACCOUNT_PORT`。
 *
 * ## 定向变异留档 (2026-09-14, 类型合法形态, 均经 `pnpm nx test server <本文件>`: typecheck 过、vitest 红)
 *
 * - 基线: 13/13 绿。
 * - a 拉取失败仍进持仓替换 (`fetchPositions(market).catch(() => [])`): 「① 美股持仓拉取失败」红 —— 返回
 *   `ok: true` (失败被当成确实空仓, 持仓替换照跑); 连带 ⑪ 红 (无 error 日志行, 管道自证断言抓到)。
 * - b `target='*'` 只刷新第一个市场 (持仓循环 `prepared.slice(0, 1)`): 「⑩」红 (港股持仓未刷新), 其余 12 条绿。
 * - 两处均还原 (`cmp` 与备份一致) 后 13/13 绿。
 */

const NOW = new Date('2026-09-14T15:00:00Z');
const LATER = new Date('2026-09-15T15:00:00Z');
/** 既有持仓的首次发现时间: 与 NOW 不同, 回落取值才分得清「取库内值」还是「取本次时刻」。 */
const SEEN = new Date('2026-08-01T15:00:00Z');
const WINDOW: BrokerTradeWindow = { start: '2026-09-01', end: '2026-09-14' };
/** 明显假值 (Guardrail 1): 连接所属账号 ID, 日志断言以它的完整数字串为探针。 */
const ACCOUNT_ID = 9_000_000_000_000n;
const PUT = 'US.PEP261016P100000';

/** 券商 port 的 test double: 按市场回放预置行; `failures` 命中即抛。 */
class FakeBrokerPort implements BrokerAccountPort {
  deals: BrokerDealRow[] = [];
  orders: BrokerOrderRow[] = [];
  positions: Partial<Record<BrokerMarket, BrokerPositionRow[]>> = {};
  failures: { method: 'fetchPositions' | 'fetchDeals'; market: BrokerMarket; error: Error }[] = [];

  reset() {
    this.deals = [];
    this.orders = [];
    this.positions = {};
    this.failures = [];
  }

  private failIf(method: 'fetchPositions' | 'fetchDeals', market: BrokerMarket) {
    const hit = this.failures.find((f) => f.method === method && f.market === market);
    if (hit !== undefined) throw hit.error;
  }

  async getAccountSummary() {
    return { trdmarketAuth: ['US', 'HK'], matched: 1 };
  }
  async fetchPositions(market: BrokerMarket) {
    this.failIf('fetchPositions', market);
    return this.positions[market] ?? [];
  }
  async fetchDeals(market: BrokerMarket) {
    this.failIf('fetchDeals', market);
    return this.deals.filter((d) => d.market === market);
  }
  async fetchOrders(market: BrokerMarket) {
    return this.orders.filter((o) => o.market === market);
  }
  async fetchStockOwners(_market: BrokerMarket, codes: readonly string[]) {
    return new Map(codes.map((code) => [code, null]));
  }
}

const currencyOf = (market: BrokerMarket) => (market === 'us' ? 'USD' : 'HKD');

const deal = (
  dealId: string,
  code: string,
  side: BrokerTradeSide,
  qty: number,
  tradedAt: string,
  market: BrokerMarket = 'us',
): BrokerDealRow => ({
  market,
  dealId,
  orderId: null,
  code,
  side,
  qty: new Prisma.Decimal(qty),
  price: new Prisma.Decimal('2.5'),
  currency: currencyOf(market),
  tradedAt: new Date(tradedAt),
  raw: { deal_id: dealId, code },
});

const order = (orderId: string, code: string): BrokerOrderRow => ({
  market: 'us',
  orderId,
  code,
  comboLegCodes: [],
  side: 'SELL_SHORT',
  orderType: 'NORMAL',
  qty: new Prisma.Decimal(1),
  price: new Prisma.Decimal('2.5'),
  status: 'FILLED_ALL',
  currency: 'USD',
  vendorCreatedAt: new Date('2026-09-10T14:00:00.000Z'),
  vendorUpdatedAt: new Date('2026-09-10T14:00:08.000Z'),
  raw: { order_id: orderId, code },
});

const position = (code: string, qty: number, market: BrokerMarket = 'us'): BrokerPositionRow => ({
  market,
  code,
  qty: new Prisma.Decimal(qty),
  marketValue: new Prisma.Decimal(qty * 10),
  costPrice: new Prisma.Decimal('9.5'),
  averageCost: new Prisma.Decimal('9.6'),
  currentPrice: new Prisma.Decimal('10'),
  currency: currencyOf(market),
  raw: { code, qty },
});

describe('082 券商同步 use case (下): 持仓刷新 / 开仓时间 / 失败语义 / 同步记录 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let useCase: SyncBrokerAccountUseCase;
  let conn: bigint;
  let tradingDay = 0;
  const port = new FakeBrokerPort();
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  type SyncOver = Partial<Omit<SyncBrokerAccountInput, 'runId' | 'connectionId'>>;

  /** T015 记录契约: 调用方先建一条 `running` 记录, 再把 `runId` 交给 use case。 */
  const sync = async (over: SyncOver = {}) => {
    const input: Omit<SyncBrokerAccountInput, 'runId'> = {
      connectionId: conn,
      markets: ['us'],
      target: '*',
      window: WINDOW,
      mode: 'backfill',
      now: NOW,
      ...over,
    };
    const { id: runId } = await prisma.brokerSyncRun.create({
      data: {
        accountId: ACCOUNT_ID,
        connectionId: conn,
        kind: input.mode,
        status: 'running',
        market: input.markets.length === 1 ? input.markets[0] : null,
        target: input.target,
        // 对账记录的部分唯一索引按 (连接, 市场, 交易日): 每条给不同交易日, 与本 use case 无关的冲突不进来。
        tradingDate:
          input.mode === 'reconcile' ? new Date(Date.UTC(2026, 7, 1 + tradingDay++)) : null,
      },
    });
    const outcome = await useCase.execute({ ...input, runId });
    const run = await prisma.brokerSyncRun.findUniqueOrThrow({ where: { id: runId } });
    return { outcome, run };
  };

  const positionsOf = (market?: BrokerMarket) =>
    prisma.brokerPosition.findMany({
      where: market === undefined ? {} : { market },
      orderBy: [{ market: 'asc' }, { code: 'asc' }],
    });
  const allDeals = () => prisma.brokerDeal.findMany({ orderBy: { id: 'asc' } });

  const seedPosition = (code: string, qty: number, market: BrokerMarket = 'us') =>
    prisma.brokerPosition.create({
      data: {
        accountId: ACCOUNT_ID,
        connectionId: conn,
        market,
        code,
        underlyingTicker: null,
        qty,
        currency: currencyOf(market),
        firstSeenAt: SEEN,
        openedAt: SEEN,
        openedAtSource: 'fallback',
        syncedAt: SEEN,
        raw: { code },
      },
    });

  const seedDeal = (row: BrokerDealRow) =>
    prisma.brokerDeal.create({
      data: {
        accountId: ACCOUNT_ID,
        connectionId: conn,
        market: row.market,
        dealId: row.dealId,
        orderId: row.orderId,
        code: row.code,
        underlyingTicker: 'us:PEP',
        side: row.side,
        qty: row.qty,
        price: row.price,
        currency: row.currency,
        tradedAt: row.tradedAt,
        raw: row.raw as Prisma.InputJsonValue,
      },
    });

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
      .compile();
    prisma = moduleRef.get(PrismaService);
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
    await prisma.brokerSyncRun.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerDeal.deleteMany({});
    await prisma.brokerOrder.deleteMany({});
    await prisma.brokerContractRef.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.optionContract.deleteMany({});
    await prisma.instrument.deleteMany({});

    const anchor = (ticker: string, market: BrokerMarket, excluded = false) =>
      prisma.anchor.create({
        data: {
          ticker,
          market,
          v: '50',
          asof: new Date('2026-06-30T00:00:00Z'),
          method: 'dcf',
          confidence: '8',
          confidenceSource: 'manual',
          lLevelEffective: 'L2',
          excluded,
        },
      });
    await anchor('us:PEP', 'us');
    await anchor('us:KO', 'us', true);
    await anchor('hk:00700', 'hk');

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
        code: PUT,
        root: 'PEP',
        underlyingInstrumentId: pep.id,
        expiryDate: new Date('2026-10-16T00:00:00Z'),
        strikePrice: '100',
        optionType: 'PUT',
        isStandard: true,
      },
    });

    conn = (
      await prisma.brokerConnection.create({
        data: { accountId: ACCOUNT_ID, brokerCode: 'futu', label: 'it', phoneLast4: '0000' },
      })
    ).id;
  });

  describe('① 先铺好持仓与成交, 再让 port 拉取抛基础设施错误 ⇒ 持仓、成交逐条不变, 记录 failed (branch 8)', () => {
    const cases: {
      name: string;
      markets: BrokerMarket[];
      failure: FakeBrokerPort['failures'][number];
    }[] = [
      {
        name: '美股持仓拉取失败 (成交订单已拉到, 未写)',
        markets: ['us'],
        failure: {
          method: 'fetchPositions',
          market: 'us',
          error: new BrokerInfrastructureError('positions us', 'timeout'),
        },
      },
      {
        name: '第二个市场 (港股) 成交拉取失败 (美股已全部拉完, 未写)',
        markets: ['us', 'hk'],
        failure: {
          method: 'fetchDeals',
          market: 'hk',
          error: new BrokerInfrastructureError('deals hk', 'ECONNRESET'),
        },
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        await seedPosition(PUT, -1);
        await seedPosition('US.PEP', 100);
        await seedPosition('HK.00700', 200, 'hk');
        await seedDeal(deal('1001', PUT, 'SELL_SHORT', 1, '2026-09-02T14:30:00.000Z'));
        const positionsBefore = await positionsOf();
        const dealsBefore = await allDeals();
        // 若失败前有任何写入, 这些新行与新持仓就会落库 —— 断言靠它们看得见。
        port.deals = [deal('1002', 'US.PEP', 'BUY', 5, '2026-09-10T14:30:00.000Z')];
        port.orders = [order('o-new', 'US.PEP')];
        port.positions = { us: [position('US.KO', 7)], hk: [] };
        port.failures = [c.failure];

        const { outcome, run } = await sync({ markets: c.markets });

        expect(outcome).toMatchObject({ ok: false, failureKind: 'infrastructure' });
        expect(await positionsOf()).toEqual(positionsBefore);
        expect(await allDeals()).toEqual(dealsBefore);
        expect(await prisma.brokerOrder.count()).toBe(0);
        expect(run.status).toBe('failed');
        expect(run.error).toContain('基础设施失败');
        expect(run.finishedAt).not.toBeNull();
      });
    }
  });

  it('券商持仓报告含重复键 ⇒ 数据类失败, 既有持仓与成交不动', async () => {
    await seedPosition('US.PEP', 100);
    await seedDeal(deal('1001', 'US.PEP', 'BUY', 100, '2026-09-02T14:30:00.000Z'));
    const positionsBefore = await positionsOf();
    const dealsBefore = await allDeals();
    port.deals = [deal('1002', 'US.PEP', 'BUY', 5, '2026-09-10T14:30:00.000Z')];
    port.positions = { us: [position('US.PEP', 105), position('US.PEP', 105)] };

    const { outcome, run } = await sync();

    expect(outcome).toMatchObject({ ok: false, failureKind: 'data' });
    expect(await positionsOf()).toEqual(positionsBefore);
    expect(await allDeals()).toEqual(dealsBefore);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('重复键');
  });

  it('② 券商成功返回空持仓 ⇒ 该市场持仓清空, 其它市场不动 (branch 9)', async () => {
    await seedPosition(PUT, -1);
    await seedPosition('US.PEP', 100);
    const hk = await seedPosition('HK.00700', 200, 'hk');
    port.positions = { us: [] };

    const { outcome } = await sync({ markets: ['us'] });

    expect(outcome.ok).toBe(true);
    expect(await positionsOf('us')).toEqual([]);
    expect(await positionsOf('hk')).toEqual([hk]);
  });

  it('③ 期权被指派: 期权持仓消失、正股持仓出现 (branch 10)', async () => {
    await seedPosition(PUT, -1);
    port.positions = { us: [position('US.PEP', 100)] };

    await sync();

    const rows = await positionsOf();
    expect(rows.map((r) => [r.code, r.qty.toString(), r.underlyingTicker])).toEqual([
      ['US.PEP', '100', 'us:PEP'],
    ]);
  });

  it('④ 已存在持仓刷新后 firstSeenAt 不变、syncedAt 更新', async () => {
    port.positions = { us: [position(PUT, -1)] };
    await sync({ now: NOW });
    const first = await prisma.brokerPosition.findFirstOrThrow({ where: { code: PUT } });
    expect(first.firstSeenAt).toEqual(NOW);
    expect(first.syncedAt).toEqual(NOW);

    port.positions = { us: [position(PUT, -2)] };
    await sync({ now: LATER });

    const second = await prisma.brokerPosition.findFirstOrThrow({ where: { code: PUT } });
    expect(second.id).toBe(first.id);
    expect(second.qty.toString()).toBe('-2');
    expect(second.firstSeenAt).toEqual(NOW);
    expect(second.syncedAt).toEqual(LATER);
  });

  it('⑤ 成交净量 = 持仓 ⇒ derived, 起点 = 持仓起点而非最近一笔 (branch 13)', async () => {
    // 开 2 → 加 1 → 平 1, 净 -2 = 持仓 -2。起点是开仓那笔 (D1), 不是 FIFO 意义上的任何后续批次。
    port.deals = [
      deal('2001', PUT, 'SELL_SHORT', 2, '2026-09-02T14:30:00.123Z'),
      deal('2002', PUT, 'SELL_SHORT', 1, '2026-09-03T14:30:00.000Z'),
      deal('2003', PUT, 'BUY_BACK', 1, '2026-09-04T14:30:00.000Z'),
    ];
    port.positions = { us: [position(PUT, -2)] };

    await sync();

    const row = await prisma.brokerPosition.findFirstOrThrow({ where: { code: PUT } });
    expect(row.openedAtSource).toBe('derived');
    expect(row.openedAt.toISOString()).toBe('2026-09-02T14:30:00.123Z');
  });

  it('⑥ 拆股形态 (成交净 100、券商报 200) ⇒ fallback 且取库内 firstSeenAt (branch 14)', async () => {
    await seedPosition('US.PEP', 100);
    port.deals = [deal('3001', 'US.PEP', 'BUY', 100, '2026-09-02T14:30:00.000Z')];
    port.positions = { us: [position('US.PEP', 200)] };

    await sync();

    const row = await prisma.brokerPosition.findFirstOrThrow({ where: { code: 'US.PEP' } });
    expect(row.qty.toString()).toBe('200');
    expect(row.openedAtSource).toBe('fallback');
    expect(row.openedAt).toEqual(SEEN);
    expect(row.firstSeenAt).toEqual(SEEN);
  });

  it('⑦ 单只标的补齐成功 ⇒ 该市场持仓立即进库 (按范围过滤, 不按目标标的过滤) (branch 15 持仓半)', async () => {
    port.positions = {
      us: [position('US.KO', 50), position(PUT, -1), position('US.AAPL', 10)],
    };

    const { outcome, run } = await sync({ target: 'us:KO', markets: ['us'] });

    expect(outcome.ok).toBe(true);
    expect(run.status).toBe('succeeded');
    const rows = await positionsOf('us');
    // KO = 目标; PEP 期权 = 范围内其它标的 (单只补齐不得删它); AAPL = 非锚, 被范围滤掉。
    expect(rows.map((r) => r.code)).toEqual(['US.KO', PUT]);
    for (const r of rows) {
      expect(r.syncedAt).toEqual(NOW);
      expect(r.accountId).toBe(ACCOUNT_ID);
    }
  });

  it('⑧ 对账: 删 1 条近期成交后执行 ⇒ filled = 1 且有 warn; 紧接着再执行 ⇒ filled = 0 (branch 30)', async () => {
    port.deals = [
      deal('4001', 'US.PEP', 'BUY', 1, '2026-09-08T14:30:00.000Z'),
      deal('4002', 'US.PEP', 'BUY', 1, '2026-09-09T14:30:00.000Z'),
      deal('4003', 'US.PEP', 'BUY', 1, '2026-09-10T14:30:00.000Z'),
    ];
    port.positions = { us: [position('US.PEP', 3)] };
    expect((await sync({ mode: 'backfill' })).run.status).toBe('succeeded');
    expect(await prisma.brokerDeal.count()).toBe(3);

    await prisma.brokerDeal.deleteMany({ where: { dealId: '4002' } });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const filledOnce = await sync({ mode: 'reconcile' });
    expect(filledOnce.outcome).toMatchObject({ ok: true, dealsInserted: 1, ordersInserted: 0 });
    expect(filledOnce.run).toMatchObject({ status: 'succeeded', filled: 1, written: null });
    expect(warn).toHaveBeenCalledTimes(1);

    const filledNone = await sync({ mode: 'reconcile' });
    expect(filledNone.run).toMatchObject({ status: 'succeeded', filled: 0, written: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await prisma.brokerDeal.count()).toBe(3);
  });

  it('⑨ 同步记录字段齐全: 成功 (类型 / 市场 / 状态 / 起止 / 写入条数) 与失败 (原因截断到 512)', async () => {
    port.deals = [
      deal('5001', 'US.PEP', 'BUY', 1, '2026-09-08T14:30:00.000Z'),
      deal('5002', 'US.PEP', 'BUY', 1, '2026-09-09T14:30:00.000Z'),
    ];
    port.orders = [order('o-5001', 'US.PEP')];
    port.positions = { us: [position('US.PEP', 2)] };

    const ok = await sync({ mode: 'backfill', markets: ['us'] });

    expect(ok.run).toMatchObject({
      kind: 'backfill',
      market: 'us',
      status: 'succeeded',
      written: 3,
      filled: null,
      error: null,
      startedAt: NOW,
    });
    expect(ok.run.finishedAt?.getTime()).toBeGreaterThanOrEqual(NOW.getTime());

    port.failures = [
      { method: 'fetchDeals', market: 'us', error: new Error(`响应解析异常 ${'x'.repeat(600)}`) },
    ];
    const failed = await sync({ mode: 'backfill', markets: ['us'] });

    expect(failed.outcome).toMatchObject({ ok: false, failureKind: 'data' });
    expect(failed.run).toMatchObject({ kind: 'backfill', market: 'us', status: 'failed' });
    expect(failed.run.error?.startsWith('响应解析异常')).toBe(true);
    expect(failed.run.error).toHaveLength(512);
    expect(failed.run.written).toBeNull();
    expect(failed.run.startedAt).toEqual(NOW);
    expect(failed.run.finishedAt?.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
  });

  it("⑩ target='*' 补齐成功 ⇒ 美股、港股两个市场的持仓都被刷新 (branch 16 持仓半)", async () => {
    await seedPosition('US.KO', 1);
    await seedPosition('HK.00700', 1, 'hk');
    port.positions = { us: [position('US.PEP', 100)], hk: [position('HK.00700', 200, 'hk')] };

    const { outcome } = await sync({ target: '*', markets: ['us', 'hk'] });

    expect(outcome.ok).toBe(true);
    const rows = await positionsOf();
    expect(rows.map((r) => [r.market, r.code, r.qty.toString(), r.syncedAt])).toEqual([
      ['hk', 'HK.00700', '200', NOW],
      ['us', 'US.PEP', '100', NOW],
    ]);
  });

  it('⑪ 本用例全部 logger 输出 (成功 / 补回告警 / 失败) 不含连接的完整账号', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(`${level} ${args.map((a) => String(a)).join(' ')}`);
      });
    }
    port.deals = [deal('6001', 'US.PEP', 'BUY', 1, '2026-09-08T14:30:00.000Z')];
    port.positions = { us: [position('US.PEP', 1)] };

    await sync({ mode: 'reconcile' });
    port.failures = [
      {
        method: 'fetchPositions',
        market: 'us',
        error: new BrokerInfrastructureError('positions us', 'timeout'),
      },
    ];
    await sync({ mode: 'reconcile' });

    // 管道自证: 三个级别都采到了 —— 否则「不含账号」恒真。
    expect(lines.some((l) => l.startsWith('log '))).toBe(true);
    expect(lines.some((l) => l.startsWith('warn '))).toBe(true);
    expect(lines.some((l) => l.startsWith('error '))).toBe(true);
    for (const line of lines) expect(line).not.toContain(String(ACCOUNT_ID));
  });
});
