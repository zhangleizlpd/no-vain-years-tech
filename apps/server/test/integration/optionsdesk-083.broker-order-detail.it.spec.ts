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

// 083 T008 —— 券商订单详情读端 (FR-001 / FR-002 / FR-017 / FR-020; plan D1 / D11;
// state_branches 38, 39, 45)。
//
// ## 为什么**必须**要真 PG + 真 HTTP
//
//   ① **账号隔离是查询条件** (Guardrail 2): 「账号 B 请求 A 的订单 id 与请求不存在的 id 逐字节相同」
//      只有 A 的行真在库里、SQL 真按 `account_id` 过滤时才有反例可看; 404 响应体是 `APP_FILTER`
//      在真 Fastify lifecycle 末端写出的 ProblemDetail, 直接调 use case 看不到。
//   ② **成交字段取自 `raw` jsonb**: 数值以 JSON number / string 落库再读回, 精度与形态只有真行才证得了伪。
//   ③ **账号来自 JWT**: `req.user.accountId` 由 `JwtAuthGuard` 在真 lifecycle 里填。
//
// ⇒ PG 从 `setupIsolatedDb()` 取 (共享 PG 模板克隆); 本端点不碰 Redis ⇒ `REDIS_CLIENT` stub;
// 装配 = `narrowTestModule([OptionsdeskModule])` 真 DI, 请求经 `app.inject()` 带真 JWT。
// fixture 全为合成值 (`ZQX` / `ZQY` / `ZQR` / 港股 `088xx`)。

const US_PUT = 'US.ZQY271217P30000';
const US_PUT_OTHER = 'US.ZQY271217P25000';
const HK_STOCK = 'HK.08801';

describe('083 T008 券商订单详情读端 (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let jwt: JwtTokenService;
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-083-t008-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-083-t008-hmac-secret-min-32-bytes';
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
  let connA: bigint;

  const connect = (accountId: bigint, label: string, brokerCode = 'futu') =>
    prisma.brokerConnection
      .create({ data: { accountId, brokerCode, label, phoneLast4: '0000' } })
      .then((c) => c.id);

  beforeEach(async () => {
    await prisma.brokerOrder.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.instrument.deleteMany({});
    await prisma.account.deleteMany({});

    accountA = (
      await prisma.account.create({ data: { phone: '+8613800083021', status: 'ACTIVE' } })
    ).id;
    accountB = (
      await prisma.account.create({ data: { phone: '+8613800083022', status: 'ACTIVE' } })
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
    await anchor('us:ZQY');
    await anchor('hk:08801');
    // `us:ZQR` 蓄意不建锚 (⑦ 不在锚集)。
    connA = await connect(accountA, '主账户');
  });

  const tokenOf = (accountId: bigint) => jwt.signAccessToken({ accountId });

  const seedOrder = (
    accountId: bigint,
    connectionId: bigint,
    orderId: string,
    code: string,
    over: Partial<Prisma.BrokerOrderUncheckedCreateInput> = {},
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
          underlyingTicker: code.startsWith('HK.') ? 'hk:08801' : 'us:ZQY',
          side: 'SELL_SHORT',
          orderType: 'NORMAL',
          qty: '2',
          price: '3.2',
          status: 'FILLED_ALL',
          currency: code.startsWith('HK.') ? 'HKD' : 'USD',
          vendorCreatedAt: new Date('2026-09-01T13:30:00Z'),
          vendorUpdatedAt: new Date('2026-09-01T14:05:00Z'),
          raw: { order_id: orderId },
          ...over,
        },
      })
      .then((o) => o.id);

  const detail = (accountId: bigint, id: bigint | string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/optionsdesk/broker-orders/${id}`,
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

  it('① 全部成交期权订单 ⇒ dealtAmount = 成交数量 × 均价 × 乘数 (乘数 500 由 amount 推出)', async () => {
    // amount = qty × price × 500 = 2 × 3.2 × 500 = 3200; 成交均价 3.1 ⇒ 2 × 3.1 × 500 = 3100。
    const id = await seedOrder(accountA, connA, '9001', US_PUT, {
      raw: { order_id: '9001', amount: 3200, dealt_qty: 2.0, dealt_avg_price: 3.1 },
    });

    expect(await ok(accountA, id)).toEqual({
      id: id.toString(),
      market: 'us',
      side: 'SELL_SHORT',
      status: 'FILLED_ALL',
      orderType: 'NORMAL',
      code: US_PUT,
      name: 'ZQY',
      option: { expiry: '2027-12-17', right: 'P', strike: '30' },
      comboLegCodes: [],
      qty: '2',
      price: '3.2',
      amount: '3200',
      dealtQty: '2',
      dealtAvgPrice: '3.1',
      dealtAmount: '3100',
      currency: 'USD',
      createdAtLocal: '2026-09-01 09:30:00',
    });
  });

  it('② 未成交即撤销 ⇒ 成交三字段 null; 成交字段缺失同样 null (branch 38)', async () => {
    const cancelled = await seedOrder(accountA, connA, '9004', US_PUT, {
      side: 'BUY_BACK',
      status: 'CANCELLED_ALL',
      raw: { order_id: '9004', amount: 3200, dealt_qty: 0, dealt_avg_price: 0 },
    });
    const absent = await seedOrder(accountA, connA, '9005', US_PUT, {
      status: 'FAILED',
      raw: { order_id: '9005', amount: 'N/A' },
    });

    expect(await ok(accountA, cancelled)).toMatchObject({
      status: 'CANCELLED_ALL',
      amount: '3200',
      dealtQty: null,
      dealtAvgPrice: null,
      dealtAmount: null,
    });
    expect(await ok(accountA, absent)).toMatchObject({
      status: 'FAILED',
      amount: null,
      dealtQty: null,
      dealtAvgPrice: null,
      dealtAmount: null,
    });
  });

  it('③ 价格为 0 的到期作废系统单 ⇒ dealtAmount = 0 (不是 null)', async () => {
    const id = await seedOrder(accountA, connA, '9101', US_PUT, {
      side: 'BUY_BACK',
      qty: '1',
      price: '0',
      raw: { order_id: '9101', amount: 0, dealt_qty: 1, dealt_avg_price: 0 },
    });

    expect(await ok(accountA, id)).toMatchObject({
      price: '0',
      dealtQty: '1',
      dealtAvgPrice: '0',
      dealtAmount: '0',
    });
  });

  it('④ 组合单 ⇒ comboLegCodes 两个腿码, 合成 code 原样、option=null', async () => {
    const id = await seedOrder(accountA, connA, '9006', 'US.ZQY-COMBO9006', {
      comboLegCodes: [US_PUT_OTHER, US_PUT],
      qty: '1',
      price: '1.5',
      raw: { order_id: '9006', amount: 150, dealt_qty: 1, dealt_avg_price: 1.5 },
    });

    expect(await ok(accountA, id)).toMatchObject({
      code: 'US.ZQY-COMBO9006',
      option: null,
      comboLegCodes: [US_PUT_OTHER, US_PUT],
      dealtAmount: '150',
    });
  });

  it('⑤ 🚨 账号 B 请求账号 A 的订单 id ⇒ 与请求不存在 id 的状态码与响应体完全相同 (branch 39)', async () => {
    const id = await seedOrder(accountA, connA, '9001', US_PUT);
    // 管道自证: A 自己看得到 ⇒ 下面的 404 不是「种数没落库」。
    await ok(accountA, id);

    const others = wire(await detail(accountB, id));
    await prisma.brokerOrder.deleteMany({ where: { id } });
    const missing = wire(await detail(accountB, id));

    expect(others.status).toBe(404);
    expect(JSON.parse(others.payload)).toMatchObject({
      status: 404,
      detail: 'BROKER_ORDER_NOT_FOUND',
    });
    expect(others).toEqual(missing);
  });

  it('⑥ 响应带 market, createdAtLocal 按该市场交易所当地; 下单时间缺失 ⇒ null', async () => {
    const hk = await seedOrder(accountA, connA, '7401', HK_STOCK, {
      side: 'BUY',
      qty: '100',
      price: '7.25',
      vendorCreatedAt: new Date('2026-09-01T01:30:00Z'),
      raw: { order_id: '7401', amount: 725, dealt_qty: 100, dealt_avg_price: 7.25 },
    });
    const noTime = await seedOrder(accountA, connA, '9002', US_PUT, { vendorCreatedAt: null });

    expect(await ok(accountA, hk)).toMatchObject({
      market: 'hk',
      option: null,
      currency: 'HKD',
      createdAtLocal: '2026-09-01 09:30:00',
      // 正股: 乘数 = 725 ÷ (100 × 7.25) = 1。
      dealtAmount: '725',
    });
    expect(await ok(accountA, noTime)).toMatchObject({ market: 'us', createdAtLocal: null });
  });

  it('⑦ 订单正股不在锚集 / 未归类 / 非数字 id ⇒ 与不存在 id 相同的 404 (branch 39, 45)', async () => {
    for (const over of [
      { code: 'US.ZQR', underlyingTicker: 'us:ZQR' },
      { code: 'US.ZQRW', underlyingTicker: null },
    ]) {
      const id = await seedOrder(accountA, connA, `x-${over.code}`, over.code, {
        underlyingTicker: over.underlyingTicker,
      });
      const hidden = wire(await detail(accountA, id));
      await prisma.brokerOrder.deleteMany({ where: { id } });
      const missing = wire(await detail(accountA, id));

      expect(hidden.status).toBe(404);
      expect(hidden).toEqual(missing);
    }

    const junk = await detail(accountA, 'abc');
    expect(junk.statusCode).toBe(404);
    expect(junk.json()).toMatchObject({ status: 404, detail: 'BROKER_ORDER_NOT_FOUND' });
    const tooBig = await detail(accountA, '9223372036854775808');
    expect(tooBig.statusCode).toBe(404);

    // 管道自证: 同连接下锚内订单照常 200。
    await ok(accountA, await seedOrder(accountA, connA, '9001', US_PUT));

    const anon = await app.inject({ method: 'GET', url: '/api/v1/optionsdesk/broker-orders/1' });
    expect(anon.statusCode).toBe(401);
  });
});
