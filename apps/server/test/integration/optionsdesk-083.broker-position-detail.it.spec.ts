import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { LightMyRequestResponse } from 'fastify';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import type { Prisma } from '../../src/generated/prisma/client';
import { MARKETDATA_WORKER_DISABLED } from '../../src/marketdata/marketdata-sync.queue';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 083 T007 —— 券商持仓详情读端: 汇总 + 订单列表 + 批次
// (FR-001 / FR-002 / FR-013 / FR-014 / FR-015 / FR-016 / FR-017 / FR-020; plan D1 / D9 / D10;
// state_branches 25, 29, 30, 34, 35, 36, 39, 40)。
//
// ## 为什么**必须**要真 PG + 真 HTTP
//
//   ① **账号隔离是查询条件** (Guardrail 2): 「账号 B 请求 A 的 id 与请求不存在的 id 逐字节相同」
//      只有 A 的行真在库里、SQL 真按 `account_id` 过滤时才有反例可看; 404 响应体是 `APP_FILTER`
//      在真 Fastify lifecycle 末端写出的 ProblemDetail, 直接调 use case 看不到。
//   ② **订单过滤是一条带 `OR` + `has` 的真 SQL** (`code =` ∨ `combo_leg_codes` 含): mock 下它恒等于
//      mock 返回值; `vendorUpdatedAt ≥ openedAt` 的口径 (plan V2) 只有真行才证得了伪。
//   ③ **账号来自 JWT**: `req.user.accountId` 由 `JwtAuthGuard` 在真 lifecycle 里填。
//
// ⇒ PG 从 `setupIsolatedDb()` 取 (共享 PG 模板克隆); 本端点不碰 Redis ⇒ `REDIS_CLIENT` stub;
// 装配 = `narrowTestModule([OptionsdeskModule])` 真 DI, 请求经 `app.inject()` 带真 JWT。
// fixture 全为合成值 (`ZQX` / `ZQY` / `ZQR` / 港股 `088xx`)。

/** 2027-12-17 到期 ⇒ 相对任意跑测时刻都未到期。 */
const US_PUT = 'US.ZQY271217P30000';
const US_PUT_OTHER = 'US.ZQY271217P25000';
const US_STOCK = 'US.ZQX';
const HK_STOCK = 'HK.08801';

describe('083 T007 券商持仓详情读端 (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let jwt: JwtTokenService;
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-083-t007-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-083-t007-hmac-secret-min-32-bytes';
    // 本地 shell 常泄漏 MARKETDATA_PROVIDER=live 与 OSS_* 部署凭据 (同 083 列表读端 IT)。
    process.env.MARKETDATA_PROVIDER = 'mock';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OSS_')) delete process.env[key];
    }
    // 不起 marketdata 队列 worker (bullmq 5.x 关停竞态假红)。
    process.env[MARKETDATA_WORKER_DISABLED] = '1';

    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([OptionsdeskModule]) })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
  }, 180_000);

  afterAll(async () => {
    if (prevWorkerDisabled === undefined) delete process.env[MARKETDATA_WORKER_DISABLED];
    else process.env[MARKETDATA_WORKER_DISABLED] = prevWorkerDisabled;
    await app?.close();
    await db?.drop();
  });

  let accountA: bigint;
  let accountB: bigint;

  beforeEach(async () => {
    await prisma.brokerDeal.deleteMany({});
    await prisma.brokerOrder.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.instrument.deleteMany({});
    await prisma.account.deleteMany({});

    accountA = (
      await prisma.account.create({ data: { phone: '+8613800083011', status: 'ACTIVE' } })
    ).id;
    accountB = (
      await prisma.account.create({ data: { phone: '+8613800083012', status: 'ACTIVE' } })
    ).id;

    const anchor = (ticker: string) =>
      prisma.anchor.create({
        data: {
          ticker,
          market: ticker.split(':')[0]!,
          v: '50',
          asof: new Date('2026-06-30T00:00:00Z'),
          method: 'dcf',
          confidence: '8',
          confidenceSource: 'manual',
          lLevelEffective: 'L2',
        },
      });
    await anchor('us:ZQX');
    await anchor('us:ZQY');
    await anchor('hk:08801');
    // `us:ZQR` 蓄意不建锚 (⑨ 不在锚集)。
  });

  const tokenOf = (accountId: bigint) => jwt.signAccessToken({ accountId });

  const connect = (accountId: bigint, label: string, brokerCode = 'futu') =>
    prisma.brokerConnection
      .create({ data: { accountId, brokerCode, label, phoneLast4: '0000' } })
      .then((c) => c.id);

  const seedPosition = (
    accountId: bigint,
    connectionId: bigint,
    code: string,
    over: Partial<Prisma.BrokerPositionUncheckedCreateInput> = {},
  ) =>
    prisma.brokerPosition
      .create({
        data: {
          accountId,
          connectionId,
          market: code.startsWith('HK.') ? 'hk' : 'us',
          code,
          underlyingTicker: null,
          qty: '1',
          marketValue: '100',
          currentPrice: '10',
          averageCost: '9',
          currency: code.startsWith('HK.') ? 'HKD' : 'USD',
          firstSeenAt: new Date('2026-08-01T15:00:00Z'),
          openedAt: new Date('2026-08-01T15:00:00Z'),
          openedAtSource: 'derived',
          syncedAt: new Date('2026-09-10T15:00:00Z'),
          raw: { code },
          ...over,
        },
      })
      .then((p) => p.id);

  const seedOrder = (
    accountId: bigint,
    connectionId: bigint,
    orderId: string,
    code: string,
    over: Partial<Prisma.BrokerOrderUncheckedCreateInput> &
      Pick<Prisma.BrokerOrderUncheckedCreateInput, 'vendorUpdatedAt'>,
  ) =>
    prisma.brokerOrder
      .create({
        data: {
          accountId,
          connectionId,
          market: code.startsWith('HK.') ? 'hk' : 'us',
          orderId,
          code,
          comboLegCodes: [],
          underlyingTicker: null,
          side: 'BUY',
          orderType: 'NORMAL',
          qty: '1',
          price: '1',
          status: 'FILLED_ALL',
          currency: code.startsWith('HK.') ? 'HKD' : 'USD',
          vendorCreatedAt: null,
          raw: { order_id: orderId },
          ...over,
        },
      })
      .then((o) => o.id.toString());

  const seedDeal = (
    accountId: bigint,
    connectionId: bigint,
    deal: { dealId: string; orderId: string | null; side: string; qty: string; price: string },
    tradedAt: string,
    code = US_PUT,
  ) =>
    prisma.brokerDeal.create({
      data: {
        accountId,
        connectionId,
        market: 'us',
        dealId: deal.dealId,
        orderId: deal.orderId,
        code,
        underlyingTicker: 'us:ZQY',
        side: deal.side,
        qty: deal.qty,
        price: deal.price,
        currency: 'USD',
        tradedAt: new Date(tradedAt),
        raw: { deal_id: deal.dealId },
      },
    });

  const detail = (accountId: bigint, id: bigint | string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/optionsdesk/broker-positions/${id}`,
      headers: { authorization: `Bearer ${tokenOf(accountId)}` },
    });

  const ok = async (accountId: bigint, id: bigint | string) => {
    const res = await detail(accountId, id);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  /** 状态码 + content-type + 响应体原文 (只把本次请求的 traceId 值替换成占位, 其余逐字节)。 */
  const wire = (res: LightMyRequestResponse) => {
    const traceId = (res.json() as { traceId?: unknown }).traceId;
    return {
      status: res.statusCode,
      contentType: res.headers['content-type'],
      payload:
        typeof traceId === 'string' ? res.payload.split(traceId).join('<trace>') : res.payload,
    };
  };

  /**
   * 空头认沽合成场景 (账号 A, 连接「主账户」):
   *
   * - 上一周期 (08-01 卖空 1 → 08-05 买回 1) 已清零 ⇒ 不进批次; 其订单更新时间早于开仓时间 ⇒ 不进列表。
   * - 本周期: 订单 9001 分两笔卖空 1@3 + 1@3.4 (批次 -2, 成本 3.2) → 9002 卖空 1@2 (批次 -1) →
   *   9003 买回 1@1 按 FIFO 扣 9001 ⇒ 9001 剩 -1、9002 剩 -1, 合计 -2 = 持仓。
   * - 🚨 9001 **下单**时间 (13:30Z) 早于开仓时间 (14:00Z)、**更新**时间晚于它 (plan V2 的真实形态)。
   * - 9004 已撤单、9005 失败、9006 组合单 (腿含本合约)、9007 另一合约、账号 B 同代码订单。
   */
  const seedShortPut = async (opts: { skipDealIds?: readonly string[] } = {}) => {
    const conn = await connect(accountA, '主账户');
    const positionId = await seedPosition(accountA, conn, US_PUT, {
      underlyingTicker: 'us:ZQY',
      qty: '-2',
      marketValue: '-300',
      currentPrice: '1.5',
      averageCost: '2.5',
      openedAt: new Date('2026-09-01T14:00:00Z'),
      firstSeenAt: new Date('2026-09-01T15:00:00Z'),
    });

    const deals = [
      {
        dealId: '990',
        orderId: '8990',
        side: 'SELL_SHORT',
        qty: '1',
        price: '2',
        at: '2026-08-01T14:00:00Z',
      },
      {
        dealId: '991',
        orderId: '8991',
        side: 'BUY_BACK',
        qty: '1',
        price: '1',
        at: '2026-08-05T14:00:00Z',
      },
      {
        dealId: '1001',
        orderId: '9001',
        side: 'SELL_SHORT',
        qty: '1',
        price: '3',
        at: '2026-09-01T14:00:00Z',
      },
      {
        dealId: '1002',
        orderId: '9001',
        side: 'SELL_SHORT',
        qty: '1',
        price: '3.4',
        at: '2026-09-01T14:05:00Z',
      },
      {
        dealId: '1003',
        orderId: '9002',
        side: 'SELL_SHORT',
        qty: '1',
        price: '2',
        at: '2026-09-02T14:00:00Z',
      },
      {
        dealId: '1004',
        orderId: '9003',
        side: 'BUY_BACK',
        qty: '1',
        price: '1',
        at: '2026-09-03T14:00:00Z',
      },
    ];
    for (const d of deals) {
      if (opts.skipDealIds?.includes(d.dealId)) continue;
      await seedDeal(accountA, conn, d, d.at);
    }

    const order = (
      orderId: string,
      code: string,
      over: Partial<Prisma.BrokerOrderUncheckedCreateInput>,
      createdAt: string | null,
      updatedAt: string,
    ) =>
      seedOrder(accountA, conn, orderId, code, {
        ...over,
        vendorCreatedAt: createdAt === null ? null : new Date(createdAt),
        vendorUpdatedAt: new Date(updatedAt),
      });
    const ids: Record<string, string> = {};
    ids['8990'] = await order(
      '8990',
      US_PUT,
      { side: 'SELL_SHORT', qty: '1', price: '2', raw: { amount: 200 } },
      '2026-08-01T13:50:00Z',
      '2026-08-01T14:00:00Z',
    );
    ids['8991'] = await order(
      '8991',
      US_PUT,
      { side: 'BUY_BACK', qty: '1', price: '1', raw: { amount: 100 } },
      '2026-08-05T13:50:00Z',
      '2026-08-05T14:00:00Z',
    );
    ids['9001'] = await order(
      '9001',
      US_PUT,
      { side: 'SELL_SHORT', qty: '2', price: '3.2', raw: { amount: 640 } },
      '2026-09-01T13:30:00Z',
      '2026-09-01T14:05:00.500Z',
    );
    ids['9002'] = await order(
      '9002',
      US_PUT,
      { side: 'SELL_SHORT', qty: '1', price: '2', raw: { amount: '200' } },
      '2026-09-02T13:50:00Z',
      '2026-09-02T14:00:00Z',
    );
    ids['9003'] = await order(
      '9003',
      US_PUT,
      { side: 'BUY_BACK', qty: '1', price: '1', raw: { amount: 100 } },
      '2026-09-03T13:55:00Z',
      '2026-09-03T14:00:00Z',
    );
    ids['9004'] = await order(
      '9004',
      US_PUT,
      { side: 'BUY_BACK', qty: '1', price: '0.5', status: 'CANCELLED_ALL' },
      '2026-09-04T13:00:00Z',
      '2026-09-04T13:30:00Z',
    );
    ids['9005'] = await order(
      '9005',
      US_PUT,
      { side: 'SELL_SHORT', qty: '1', price: '9', status: 'FAILED' },
      '2026-09-04T14:00:00Z',
      '2026-09-04T14:00:00Z',
    );
    ids['9006'] = await order(
      '9006',
      'US.ZQYCOMBO9006',
      { side: 'SELL_SHORT', comboLegCodes: [US_PUT_OTHER, US_PUT], status: 'SUBMITTED' },
      '2026-09-05T13:00:00Z',
      '2026-09-05T13:00:00Z',
    );
    ids['9007'] = await order(
      '9007',
      US_PUT_OTHER,
      { side: 'SELL_SHORT' },
      '2026-09-05T14:00:00Z',
      '2026-09-05T14:00:00Z',
    );

    const connB = await connect(accountB, '另一人的账户');
    ids.otherAccount = await seedOrder(accountB, connB, '9001', US_PUT, {
      side: 'SELL_SHORT',
      vendorCreatedAt: new Date('2026-09-06T13:00:00Z'),
      vendorUpdatedAt: new Date('2026-09-06T13:00:00Z'),
    });
    return { conn, positionId, ids };
  };

  it('① 期权持仓 ⇒ 汇总 (列表行字段 + openedAtLocal) + 批次 + 本合约订单 (branch 25)', async () => {
    const { positionId, ids } = await seedShortPut();

    const body = await ok(accountA, positionId);
    expect(body).toMatchObject({
      id: positionId.toString(),
      market: 'us',
      brokerCode: 'futu',
      connectionLabel: '主账户',
      kind: 'option',
      code: US_PUT,
      name: 'ZQY',
      option: { expiry: '2027-12-17', right: 'P', strike: '30' },
      qty: '-2',
      marketValue: '-300',
      currentPrice: '1.5',
      averageCost: '2.5',
      currency: 'USD',
      openedAt: '2026-09-01T14:00:00.000Z',
      openedAtLocal: '2026-09-01 10:00:00',
      openedAtSource: 'derived',
      expired: false,
    });
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(
      ['9006', '9005', '9004', '9003', '9002', '9001'].map((k) => ids[k]),
    );
    const o9001 = body.orders.find((o: { id: string }) => o.id === ids['9001']);
    expect(o9001).toEqual({
      id: ids['9001'],
      side: 'SELL_SHORT',
      qty: '2',
      price: '3.2',
      status: 'FILLED_ALL',
      createdAtLocal: '2026-09-01 09:30:00',
    });
    expect(body.lots).toEqual({
      restorable: true,
      lots: [
        {
          openedAtLocal: '2026-09-01 10:00:00',
          orderDbId: ids['9001'],
          originalQty: '-2',
          remainingQty: '-1',
          cost: '3.2',
          marketValue: '-150',
          unrealizedPl: '170',
        },
        {
          openedAtLocal: '2026-09-02 10:00:00',
          orderDbId: ids['9002'],
          originalQty: '-1',
          remainingQty: '-1',
          cost: '2',
          marketValue: '-150',
          unrealizedPl: '50',
        },
      ],
    });
  });

  it('② 批次合计 = 持仓 ⇒ restorable=true; 缺一笔开仓成交 ⇒ false 且批次照常返回 (branch 29, 30)', async () => {
    const full = await seedShortPut();
    expect((await ok(accountA, full.positionId)).lots.restorable).toBe(true);

    await prisma.brokerDeal.deleteMany({});
    await prisma.brokerOrder.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    const missing = await seedShortPut({ skipDealIds: ['1003'] });
    const lots = (await ok(accountA, missing.positionId)).lots;
    expect(lots.restorable).toBe(false);
    expect(lots.lots).toEqual([
      expect.objectContaining({ orderDbId: missing.ids['9001'], remainingQty: '-1' }),
    ]);
  });

  it('③ 🚨 开仓订单下单时间早于 openedAt、更新时间晚于它 ⇒ 在列表里; 上一周期更新早于 openedAt ⇒ 不在 (branch 34; V2)', async () => {
    const { positionId, ids } = await seedShortPut();

    const orderIds = (await ok(accountA, positionId)).orders.map((o: { id: string }) => o.id);
    expect(orderIds).toContain(ids['9001']);
    expect(orderIds).not.toContain(ids['8990']);
    expect(orderIds).not.toContain(ids['8991']);
  });

  it("④ openedAtSource='fallback' ⇒ 早于首次发现的订单也在列表里; 同一行改为 derived ⇒ 被滤掉 (branch 35)", async () => {
    const conn = await connect(accountA, '主账户');
    const positionId = await seedPosition(accountA, conn, US_STOCK, {
      underlyingTicker: 'us:ZQX',
      qty: '100',
      openedAt: new Date('2026-09-05T15:00:00Z'),
      firstSeenAt: new Date('2026-09-05T15:00:00Z'),
      openedAtSource: 'fallback',
    });
    const early = await seedOrder(accountA, conn, '7001', US_STOCK, {
      qty: '100',
      price: '30',
      vendorCreatedAt: new Date('2026-08-20T14:00:00Z'),
      vendorUpdatedAt: new Date('2026-08-20T14:01:00Z'),
    });

    expect((await ok(accountA, positionId)).orders.map((o: { id: string }) => o.id)).toEqual([
      early,
    ]);
    // 管道自证: 上面的「在」确实来自 fallback 分支, 不是过滤没生效。
    await prisma.brokerPosition.update({
      where: { id: positionId },
      data: { openedAtSource: 'derived' },
    });
    expect((await ok(accountA, positionId)).orders).toEqual([]);
  });

  it('⑤ 已撤单与失败订单照常返回并带状态 (branch 36)', async () => {
    const { positionId, ids } = await seedShortPut();

    const byId = new Map(
      (await ok(accountA, positionId)).orders.map((o: { id: string; status: string }) => [
        o.id,
        o.status,
      ]),
    );
    expect(byId.get(ids['9004'])).toBe('CANCELLED_ALL');
    expect(byId.get(ids['9005'])).toBe('FAILED');
  });

  it('⑥ 正股持仓 ⇒ lots=null; 被指派产生的正股订单 (价格 = 行权价) 在列表里 (Edge「被指派得到的正股持仓」)', async () => {
    const conn = await connect(accountA, '主账户');
    const positionId = await seedPosition(accountA, conn, US_STOCK, {
      underlyingTicker: 'us:ZQX',
      qty: '100',
      currentPrice: '28',
      openedAt: new Date('2026-09-10T20:00:00Z'),
    });
    const assigned = await seedOrder(accountA, conn, '7201', US_STOCK, {
      side: 'BUY',
      qty: '100',
      price: '30',
      vendorCreatedAt: new Date('2026-09-10T20:00:00Z'),
      vendorUpdatedAt: new Date('2026-09-10T20:00:00Z'),
    });

    const body = await ok(accountA, positionId);
    expect(body).toMatchObject({ kind: 'stock', option: null, lots: null, expired: false });
    expect(body.orders).toEqual([
      {
        id: assigned,
        side: 'BUY',
        qty: '100',
        price: '30',
        status: 'FILLED_ALL',
        createdAtLocal: '2026-09-10 16:00:00',
      },
    ]);
  });

  it('⑦ 🚨 账号 B 请求账号 A 的持仓 id ⇒ 与请求不存在 id 的状态码与响应体完全相同 (branch 39)', async () => {
    const { positionId } = await seedShortPut();
    // 管道自证: A 自己看得到 ⇒ 下面的 404 不是「种数没落库」。
    await ok(accountA, positionId);

    const others = wire(await detail(accountB, positionId));
    await prisma.brokerPosition.deleteMany({ where: { id: positionId } });
    const missing = wire(await detail(accountB, positionId));

    expect(others.status).toBe(404);
    expect(JSON.parse(others.payload)).toMatchObject({
      status: 404,
      detail: 'BROKER_POSITION_NOT_FOUND',
    });
    expect(others).toEqual(missing);
  });

  it('⑧ 持仓行被删除后请求原 id ⇒ 404 (branch 40); 非数字 id ⇒ 同码 404; 无 token ⇒ 401', async () => {
    const { positionId } = await seedShortPut();
    await ok(accountA, positionId);

    await prisma.brokerPosition.deleteMany({ where: { id: positionId } });
    const gone = await detail(accountA, positionId);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ status: 404, detail: 'BROKER_POSITION_NOT_FOUND' });

    const junk = await detail(accountA, 'abc');
    expect(junk.statusCode).toBe(404);
    expect(junk.json()).toMatchObject({ status: 404, detail: 'BROKER_POSITION_NOT_FOUND' });

    const anon = await app.inject({
      method: 'GET',
      url: `/api/v1/optionsdesk/broker-positions/${positionId}`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it('⑨ 未归类 / 不在锚集的持仓 id ⇒ 与不存在相同的 404 (branch 39)', async () => {
    const conn = await connect(accountA, '主账户');
    for (const over of [
      { code: 'US.ZQRW', underlyingTicker: null },
      { code: 'US.ZQR', underlyingTicker: 'us:ZQR' },
    ]) {
      const id = await seedPosition(accountA, conn, over.code, {
        underlyingTicker: over.underlyingTicker,
      });
      const hidden = wire(await detail(accountA, id));
      await prisma.brokerPosition.deleteMany({ where: { id } });
      const missing = wire(await detail(accountA, id));

      expect(hidden.status).toBe(404);
      expect(hidden).toEqual(missing);
    }
    // 管道自证: 同连接下锚内持仓照常 200。
    const visible = await seedPosition(accountA, conn, US_STOCK, { underlyingTicker: 'us:ZQX' });
    await ok(accountA, visible);
  });

  it('⑩ comboLegCodes 含本合约的组合单在列表里; 只含另一合约的不在', async () => {
    const { positionId, ids } = await seedShortPut();

    const orderIds = (await ok(accountA, positionId)).orders.map((o: { id: string }) => o.id);
    expect(orderIds).toContain(ids['9006']);
    expect(orderIds).not.toContain(ids['9007']);
    expect(orderIds).not.toContain(ids.otherAccount);
  });

  it('⑪ 订单按 vendorCreatedAt 降序、null 排末, 并列按 orderId', async () => {
    const conn = await connect(accountA, '主账户');
    const positionId = await seedPosition(accountA, conn, US_STOCK, {
      underlyingTicker: 'us:ZQX',
      openedAtSource: 'fallback',
    });
    const updatedAt = new Date('2026-09-05T14:00:00Z');
    const earlier = await seedOrder(accountA, conn, '7302', US_STOCK, {
      vendorCreatedAt: new Date('2026-09-01T14:00:00Z'),
      vendorUpdatedAt: updatedAt,
    });
    const nullLate = await seedOrder(accountA, conn, '7100', US_STOCK, {
      vendorUpdatedAt: updatedAt,
    });
    const later = await seedOrder(accountA, conn, '7301', US_STOCK, {
      vendorCreatedAt: new Date('2026-09-03T14:00:00Z'),
      vendorUpdatedAt: updatedAt,
    });
    const nullEarly = await seedOrder(accountA, conn, '7099', US_STOCK, {
      vendorUpdatedAt: updatedAt,
    });

    const orders = (await ok(accountA, positionId)).orders;
    expect(orders.map((o: { id: string }) => o.id)).toEqual([later, earlier, nullEarly, nullLate]);
    expect(orders[2].createdAtLocal).toBeNull();
  });

  it('⑫ 响应带 market, 开仓 / 下单时间按该市场交易所当地; 批次项带 originalQty / remainingQty', async () => {
    const conn = await connect(accountA, '主账户');
    const hkId = await seedPosition(accountA, conn, HK_STOCK, {
      underlyingTicker: 'hk:08801',
      openedAt: new Date('2026-09-01T02:00:00Z'),
    });
    await seedOrder(accountA, conn, '7401', HK_STOCK, {
      vendorCreatedAt: new Date('2026-09-01T01:30:00Z'),
      vendorUpdatedAt: new Date('2026-09-01T02:00:00Z'),
    });

    const hk = await ok(accountA, hkId);
    expect(hk).toMatchObject({ market: 'hk', openedAtLocal: '2026-09-01 10:00:00', lots: null });
    expect(hk.orders[0].createdAtLocal).toBe('2026-09-01 09:30:00');

    await prisma.brokerOrder.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    const { positionId } = await seedShortPut();
    const us = await ok(accountA, positionId);
    expect(us.market).toBe('us');
    for (const lot of us.lots.lots) {
      expect(Object.keys(lot).sort()).toEqual([
        'cost',
        'marketValue',
        'openedAtLocal',
        'orderDbId',
        'originalQty',
        'remainingQty',
        'unrealizedPl',
      ]);
    }
  });
});
