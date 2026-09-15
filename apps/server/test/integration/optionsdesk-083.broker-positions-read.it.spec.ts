import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import type { Prisma } from '../../src/generated/prisma/client';
import { MARKETDATA_WORKER_DISABLED } from '../../src/marketdata/marketdata-sync.queue';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 083 T005 —— 券商持仓列表读端 (上): 端点骨架 + 列表主体
// (FR-001 / FR-002 / FR-003 / FR-005 / FR-007 / FR-011 / FR-012 / FR-021; plan D1 / D2 / D3 / D6 / D8;
// state_branches 1, 8, 9, 16, 20, 21, 23)。
//
// ## 为什么**必须**要真 PG + 真 HTTP
//
//   ① **账号隔离是查询条件** (Guardrail 2): 「账号 B 看不到 A 的持仓」只有在库里**真有** A 的行、
//      且 SQL 真按 `account_id` 过滤时才有反例可看; mock Prisma 下返回值就是 mock 本身, 去掉
//      `accountId` 条件照样绿。
//   ② **锚集 / 名称 / 连接标签是三张真表的读**: 锚表 (含 excluded) → 锚集与锚现价;
//      `marketdata.instrument` → 正股名 (跨 ctx 只读); `broker_connection.label` → 连接标签。
//   ③ **账号来自 JWT**: `req.user.accountId` 由 `JwtAuthGuard` 在真 Fastify lifecycle 里填
//      (plan Testing Invariants「NO LIFECYCLE MOCKING」)。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 `setupIsolatedDb()` 取 (共享 PG 模板克隆, 禁自起容器);
// 本端点不碰 Redis ⇒ `REDIS_CLIENT` stub。装配 = `narrowTestModule([OptionsdeskModule])` 真 DI,
// 请求经 `app.inject()` 带真 JWT。fixture 全为合成值 (`ZQX` / `ZQY` / `ZQR` / 港股 `088xx`)。

const US_STOCK = 'US.ZQX';
/** 2027-12-17 到期 ⇒ 相对任意跑测时刻都未到期。 */
const US_PUT_LIVE = 'US.ZQY271217P30000';
/** 2026-01-16 到期 ⇒ 已到期 (尚未被同步移除)。 */
const US_PUT_EXPIRED = 'US.ZQY260116P30000';

describe('083 T005 券商持仓列表读端 (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let jwt: JwtTokenService;
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-083-t005-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-083-t005-hmac-secret-min-32-bytes';
    // 本地 shell 常泄漏 MARKETDATA_PROVIDER=live 与 OSS_* 部署凭据 (同 046 详情读端 IT)。
    process.env.MARKETDATA_PROVIDER = 'mock';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OSS_')) delete process.env[key];
    }
    // 不起 marketdata 队列 worker (同 046 详情读端 IT: bullmq 5.x 关停竞态假红)。
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
    await prisma.brokerSyncRun.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.optionContract.deleteMany({});
    await prisma.instrument.deleteMany({});
    await prisma.account.deleteMany({});

    accountA = (
      await prisma.account.create({ data: { phone: '+8613800083001', status: 'ACTIVE' } })
    ).id;
    accountB = (
      await prisma.account.create({ data: { phone: '+8613800083002', status: 'ACTIVE' } })
    ).id;

    const anchor = (ticker: string, over: Partial<Prisma.AnchorCreateInput> = {}) =>
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
          ...over,
        },
      });
    await anchor('us:ZQX');
    // 只有期权持仓的组: 组头现价取锚现价 (无盘中价 ⇒ 收盘价)。excluded 仍在锚集 (plan D2)。
    await anchor('us:ZQY', {
      lastClose: '31.5',
      lastCloseDate: new Date('2026-09-01T00:00:00Z'),
      excluded: true,
    });
    await anchor('hk:08801');
    await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'ZQX',
        name: '示例甲',
        type: 'stock',
        currency: 'USD',
        status: 'active',
      },
    });
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
    prisma.brokerPosition.create({
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
        syncedAt: new Date('2026-09-01T15:00:00Z'),
        raw: { code },
        ...over,
      },
    });

  const list = async (accountId: bigint, market = 'us') => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/optionsdesk/broker-positions?market=${market}`,
      headers: { authorization: `Bearer ${tokenOf(accountId)}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const allRows = (body: { groups: { rows: Record<string, unknown>[] }[] }) =>
    body.groups.flatMap((g) => g.rows);

  it('① 账号无连接 ⇒ hasConnection=false、brokerCount=0、groups=[] (branch 1)', async () => {
    const body = await list(accountA);
    expect(body).toMatchObject({
      hasConnection: false,
      brokerCount: 0,
      syncedAt: null,
      syncedAtLocal: null,
      stale: false,
      unresolvedCount: 0,
      groups: [],
    });
  });

  it('② 非锚持仓不返回、未解析持仓计入 unresolvedCount、他市场持仓不进本市场 (branch 8, 9)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_STOCK, { underlyingTicker: 'us:ZQX' });
    await seedPosition(accountA, conn, 'US.ZQR', { underlyingTicker: 'us:ZQR' });
    await seedPosition(accountA, conn, 'US.ZQRW', { underlyingTicker: null });
    await seedPosition(accountA, conn, 'US.ZQRV', { underlyingTicker: null });
    await seedPosition(accountA, conn, 'HK.08801', { underlyingTicker: 'hk:08801' });

    const us = await list(accountA);
    expect(us.hasConnection).toBe(true);
    expect(us.unresolvedCount).toBe(2);
    expect(us.groups.map((g: { underlyingTicker: string }) => g.underlyingTicker)).toEqual([
      'us:ZQX',
    ]);
    expect(allRows(us).map((r) => r.code)).toEqual([US_STOCK]);

    const hk = await list(accountA, 'hk');
    expect(hk.unresolvedCount).toBe(0);
    expect(allRows(hk).map((r) => r.code)).toEqual(['HK.08801']);
  });

  it('③ 1 个连接 ⇒ brokerCount=1; 2 个连接 ⇒ brokerCount=2、同合约两行各带自己的 connectionLabel、数量不合并 (branch 20, 21)', async () => {
    const first = await connect(accountA, '主账户');
    await seedPosition(accountA, first, US_PUT_LIVE, { underlyingTicker: 'us:ZQY', qty: '-2' });
    expect((await list(accountA)).brokerCount).toBe(1);

    const second = await connect(accountA, '备用账户');
    await seedPosition(accountA, second, US_PUT_LIVE, { underlyingTicker: 'us:ZQY', qty: '-1' });
    const body = await list(accountA);
    expect(body.brokerCount).toBe(2);
    const rows = allRows(body);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.connectionLabel, r.qty]).sort()).toEqual([
      ['主账户', '-2'],
      ['备用账户', '-1'],
    ]);
  });

  it('④ 已过期期权行 expired=true, 未到期 expired=false, 正股恒 false (branch 23)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_PUT_EXPIRED, { underlyingTicker: 'us:ZQY' });
    await seedPosition(accountA, conn, US_PUT_LIVE, { underlyingTicker: 'us:ZQY' });
    await seedPosition(accountA, conn, US_STOCK, { underlyingTicker: 'us:ZQX' });

    const byCode = new Map(allRows(await list(accountA)).map((r) => [r.code, r]));
    expect(byCode.get(US_PUT_EXPIRED)).toMatchObject({
      kind: 'option',
      expired: true,
      option: { expiry: '2026-01-16', right: 'P', strike: '30' },
    });
    expect(byCode.get(US_PUT_LIVE)).toMatchObject({ kind: 'option', expired: false });
    expect(byCode.get(US_STOCK)).toMatchObject({ kind: 'stock', expired: false, option: null });
  });

  it('⑤ 🚨 账号 B 请求 ⇒ 看不到账号 A 的任何持仓 (SC-006 列表面)', async () => {
    const connA = await connect(accountA, '主账户');
    await seedPosition(accountA, connA, US_STOCK, { underlyingTicker: 'us:ZQX' });
    await seedPosition(accountA, connA, 'US.ZQRW', { underlyingTicker: null });
    await connect(accountB, '另一人的账户');

    const bodyB = await list(accountB);
    expect(bodyB).toMatchObject({ hasConnection: true, brokerCount: 1, unresolvedCount: 0 });
    expect(bodyB.groups).toEqual([]);
    // 管道自证: 同一时刻 A 自己看得到 ⇒ 上面的空不是「种数没落库」。
    const bodyA = await list(accountA);
    expect(allRows(bodyA).map((r) => r.code)).toEqual([US_STOCK]);
    expect(bodyA.unresolvedCount).toBe(1);
  });

  it('⑥ 删掉锚 ⇒ 该正股持仓不再返回 (Edge「删除锚」)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_STOCK, { underlyingTicker: 'us:ZQX' });
    expect(allRows(await list(accountA))).toHaveLength(1);

    await prisma.anchor.deleteMany({ where: { ticker: 'us:ZQX' } });
    const body = await list(accountA);
    expect(body.groups).toEqual([]);
    expect(body.unresolvedCount).toBe(0);
  });

  it('⑦ 持仓盈亏取 raw.unrealized_pl、比例取 raw.pl_ratio_avg_cost; N/A / 缺失 ⇒ null (US1-AS4)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_STOCK, {
      underlyingTicker: 'us:ZQX',
      // 摊薄口径字段给不同的值: 取错字段立刻看得出。
      raw: {
        code: US_STOCK,
        unrealized_pl: 12.5,
        pl_ratio_avg_cost: '4.25',
        pl_val: 99,
        pl_ratio: 77,
      },
    });
    await seedPosition(accountA, conn, US_PUT_LIVE, {
      underlyingTicker: 'us:ZQY',
      raw: { code: US_PUT_LIVE, unrealized_pl: 'N/A' },
    });

    const byCode = new Map(allRows(await list(accountA)).map((r) => [r.code, r]));
    expect(byCode.get(US_STOCK)).toMatchObject({ unrealizedPl: '12.5', unrealizedPlRatio: '4.25' });
    expect(byCode.get(US_PUT_LIVE)).toMatchObject({ unrealizedPl: null, unrealizedPlRatio: null });
  });

  it('⑧ 行带 market; connectionLabel = 连接行 label 而非 brokerCode; 名称取 instrument, 取不到回落 raw.stock_name (Edge「同一券商有两个连接」)', async () => {
    const conn = await connect(accountA, '主账户', 'futu');
    await seedPosition(accountA, conn, US_STOCK, {
      underlyingTicker: 'us:ZQX',
      raw: { code: US_STOCK, stock_name: '券商给的名字' },
    });
    await seedPosition(accountA, conn, US_PUT_LIVE, {
      underlyingTicker: 'us:ZQY',
      raw: { code: US_PUT_LIVE, stock_name: '期权合约名' },
    });
    await seedPosition(accountA, conn, 'HK.08801', {
      underlyingTicker: 'hk:08801',
      raw: { code: 'HK.08801', stock_name: '示例港股' },
    });

    const us = await list(accountA);
    const byCode = new Map(allRows(us).map((r) => [r.code, r]));
    expect(byCode.get(US_STOCK)).toMatchObject({
      id: expect.stringMatching(/^\d+$/),
      market: 'us',
      brokerCode: 'futu',
      connectionLabel: '主账户',
      name: '示例甲',
    });
    // 期权行返回正股名; 正股既无 instrument 也无正股行 ⇒ 回落正股代码 (🚫 期权合约自己的 stock_name)。
    expect(byCode.get(US_PUT_LIVE)).toMatchObject({
      market: 'us',
      connectionLabel: '主账户',
      name: 'ZQY',
    });
    const zqx = us.groups.find(
      (g: { underlyingTicker: string }) => g.underlyingTicker === 'us:ZQX',
    );
    expect(zqx.underlyingName).toBe('示例甲');

    const hk = await list(accountA, 'hk');
    expect(allRows(hk)[0]).toMatchObject({ market: 'hk', name: '示例港股' });
    expect(hk.groups[0].underlyingName).toBe('示例港股');
  });

  it('⑨ 组内只有期权 ⇒ 组头现价 = 锚现价; 有正股 ⇒ 正股行现价 (branch 16)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_PUT_LIVE, {
      underlyingTicker: 'us:ZQY',
      marketValue: '-300',
      currentPrice: '1.5',
    });
    await seedPosition(accountA, conn, US_STOCK, {
      underlyingTicker: 'us:ZQX',
      marketValue: '100',
      currentPrice: '10',
    });

    const body = await list(accountA);
    // 跨组按 |组市值| 降序: ZQY(300) 在前。
    expect(body.groups.map((g: { underlyingTicker: string }) => g.underlyingTicker)).toEqual([
      'us:ZQY',
      'us:ZQX',
    ]);
    expect(body.groups[0]).toMatchObject({
      underlyingPrice: '31.5',
      groupMarketValue: '-300',
      groupUnrealizedPl: null,
    });
    expect(body.groups[1]).toMatchObject({ underlyingPrice: '10', groupMarketValue: '100' });
  });

  it('非法 market ⇒ 400; 无 token ⇒ 401', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/optionsdesk/broker-positions?market=cn',
      headers: { authorization: `Bearer ${tokenOf(accountA)}` },
    });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({
      method: 'GET',
      url: '/api/v1/optionsdesk/broker-positions?market=us',
    });
    expect(anon.statusCode).toBe(401);
  });
});
