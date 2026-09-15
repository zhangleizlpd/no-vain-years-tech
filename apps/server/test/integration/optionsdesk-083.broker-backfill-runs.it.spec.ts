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

// 083 T009 —— 新锚券商历史补齐状态读端 (FR-002 / FR-018; plan D12; state_branches 41, 42)。
//
// ## 为什么**必须**要真 PG + 真 HTTP
//
//   ① **「每个 ticker 取最新一条」是一条带 `target in (...)` + `createdAt` 排序的真 SQL**: mock 下它恒等于
//      mock 返回值, 先失败后成功的反例只有真行才证得了伪。
//   ② **账号隔离是查询条件** (Guardrail 2): 账号 B 看不到 A 的记录只有 A 的行真在库里时才有反例可看。
//   ③ **tickers 校验在全局 ValidationPipe 的真 lifecycle 里**: 400 由 DTO 装饰器 + pipe 产出, 直接调
//      use case 看不到; 账号来自 JWT (`JwtAuthGuard` 填)。
//
// ⇒ PG 从 `setupIsolatedDb()` 取 (共享 PG 模板克隆); 本端点不碰 Redis ⇒ `REDIS_CLIENT` stub;
// 装配 = `narrowTestModule([OptionsdeskModule])` 真 DI, 请求经 `app.inject()` 带真 JWT。
// fixture 全为合成值 (`ZQX` / `ZQY` / `ZQR` / 港股 `088xx`)。

describe('083 T009 券商历史补齐状态读端 (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let jwt: JwtTokenService;
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-083-t009-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-083-t009-hmac-secret-min-32-bytes';
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
  let connB: bigint;

  const connect = (accountId: bigint, label: string, brokerCode = 'futu') =>
    prisma.brokerConnection
      .create({ data: { accountId, brokerCode, label, phoneLast4: '0000' } })
      .then((c) => c.id);

  beforeEach(async () => {
    await prisma.brokerSyncRun.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.account.deleteMany({});

    accountA = (
      await prisma.account.create({ data: { phone: '+8613800083031', status: 'ACTIVE' } })
    ).id;
    accountB = (
      await prisma.account.create({ data: { phone: '+8613800083032', status: 'ACTIVE' } })
    ).id;
    connA = await connect(accountA, '主账户');
    connB = await connect(accountB, '另一人的账户');
  });

  const tokenOf = (accountId: bigint) => jwt.signAccessToken({ accountId });

  const seedRun = (
    accountId: bigint,
    connectionId: bigint,
    over: Partial<Prisma.BrokerSyncRunUncheckedCreateInput> &
      Pick<Prisma.BrokerSyncRunUncheckedCreateInput, 'status' | 'target'>,
  ) =>
    prisma.brokerSyncRun.create({
      data: { accountId, connectionId, kind: 'backfill', market: null, ...over },
    });

  const runs = (accountId: bigint, tickers: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/optionsdesk/broker-backfill-runs?tickers=${encodeURIComponent(tickers)}`,
      headers: { authorization: `Bearer ${tokenOf(accountId)}` },
    });

  const ok = async (accountId: bigint, tickers: string) => {
    const res = await runs(accountId, tickers);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it('① 四种状态各一只 ticker ⇒ 状态与对应时刻正确, atLocal 按 ticker 市场; 时刻缺失 ⇒ null (branch 41)', async () => {
    await seedRun(accountA, connA, {
      target: 'us:ZQX',
      status: 'succeeded',
      startedAt: new Date('2026-09-10T13:00:00Z'),
      finishedAt: new Date('2026-09-10T13:15:00Z'),
    });
    await seedRun(accountA, connA, {
      target: 'us:ZQY',
      status: 'failed',
      startedAt: new Date('2026-09-10T13:00:00Z'),
      finishedAt: new Date('2026-09-10T13:05:30Z'),
    });
    await seedRun(accountA, connA, {
      target: 'hk:08801',
      status: 'running',
      startedAt: new Date('2026-09-10T02:00:00Z'),
      nextAttemptAt: new Date('2026-09-10T01:00:00Z'),
    });
    await seedRun(accountA, connA, {
      target: 'hk:08802',
      status: 'pending',
      nextAttemptAt: new Date('2026-09-10T03:30:00Z'),
    });
    await seedRun(accountA, connA, { target: 'us:ZQR', status: 'pending', nextAttemptAt: null });

    expect(await ok(accountA, 'us:ZQX,us:ZQY,hk:08801,hk:08802,us:ZQR')).toEqual([
      {
        ticker: 'us:ZQX',
        status: 'succeeded',
        at: '2026-09-10T13:15:00.000Z',
        atLocal: '2026-09-10 09:15:00',
      },
      {
        ticker: 'us:ZQY',
        status: 'failed',
        at: '2026-09-10T13:05:30.000Z',
        atLocal: '2026-09-10 09:05:30',
      },
      {
        ticker: 'hk:08801',
        status: 'running',
        at: '2026-09-10T02:00:00.000Z',
        atLocal: '2026-09-10 10:00:00',
      },
      {
        ticker: 'hk:08802',
        status: 'pending',
        at: '2026-09-10T03:30:00.000Z',
        atLocal: '2026-09-10 11:30:00',
      },
      { ticker: 'us:ZQR', status: 'pending', at: null, atLocal: null },
    ]);
  });

  it('② 无记录的 ticker 不在响应里; 对账记录与 target 不同的补齐记录不算 (branch 42)', async () => {
    await seedRun(accountA, connA, {
      target: 'us:ZQX',
      status: 'succeeded',
      finishedAt: new Date('2026-09-10T13:15:00Z'),
    });
    await seedRun(accountA, connA, {
      kind: 'reconcile',
      target: 'us:ZQY',
      market: 'us',
      status: 'succeeded',
      tradingDate: new Date('2026-09-10T00:00:00Z'),
      finishedAt: new Date('2026-09-10T13:15:00Z'),
    });
    await seedRun(accountA, connA, {
      target: '*',
      status: 'succeeded',
      finishedAt: new Date('2026-09-10T13:15:00Z'),
    });

    const body = await ok(accountA, 'us:ZQX,us:ZQY,hk:08801');
    expect(body.map((r: { ticker: string }) => r.ticker)).toEqual(['us:ZQX']);
  });

  it('③ 同一 ticker 先失败后成功 ⇒ 返回成功那条 (按 createdAt, 与插入顺序无关)', async () => {
    // 成功那条**先插入** (id 小)、createdAt 更晚 ⇒ 只有按 createdAt 降序才取得到它。
    await seedRun(accountA, connA, {
      target: 'us:ZQX',
      status: 'succeeded',
      finishedAt: new Date('2026-09-11T13:15:00Z'),
      createdAt: new Date('2026-09-11T13:00:00Z'),
    });
    await seedRun(accountA, connA, {
      target: 'us:ZQX',
      status: 'failed',
      finishedAt: new Date('2026-09-10T13:15:00Z'),
      createdAt: new Date('2026-09-10T13:00:00Z'),
    });

    expect(await ok(accountA, 'us:ZQX')).toEqual([
      {
        ticker: 'us:ZQX',
        status: 'succeeded',
        at: '2026-09-11T13:15:00.000Z',
        atLocal: '2026-09-11 09:15:00',
      },
    ]);
  });

  it('④ 账号 B 看不到账号 A 的记录', async () => {
    await seedRun(accountA, connA, {
      target: 'us:ZQX',
      status: 'succeeded',
      finishedAt: new Date('2026-09-10T13:15:00Z'),
    });
    // 管道自证: A 自己看得到 ⇒ 下面的空不是「种数没落库」。
    expect(await ok(accountA, 'us:ZQX')).toHaveLength(1);
    expect(await ok(accountB, 'us:ZQX')).toEqual([]);

    await seedRun(accountB, connB, {
      target: 'us:ZQX',
      status: 'failed',
      finishedAt: new Date('2026-09-12T13:15:00Z'),
      createdAt: new Date('2026-09-12T13:00:00Z'),
    });
    // B 的更新记录不串到 A。
    expect(await ok(accountA, 'us:ZQX')).toMatchObject([{ status: 'succeeded' }]);
  });

  it('⑤ 51 个 ticker / 非法形态 / 缺参 ⇒ 400; 恰 50 个 ⇒ 200; 无 token ⇒ 401', async () => {
    const tickers = (n: number) => Array.from({ length: n }, (_, i) => `us:ZQ${i}`).join(',');

    expect((await runs(accountA, tickers(50))).statusCode).toBe(200);
    expect((await runs(accountA, tickers(51))).statusCode).toBe(400);
    for (const bad of ['ZQX', 'US:ZQX', 'us:ZQX,cn:ZQY', 'jp:ZQX', '']) {
      expect((await runs(accountA, bad)).statusCode, bad).toBe(400);
    }
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/optionsdesk/broker-backfill-runs',
      headers: { authorization: `Bearer ${tokenOf(accountA)}` },
    });
    expect(missing.statusCode).toBe(400);

    const anon = await app.inject({
      method: 'GET',
      url: '/api/v1/optionsdesk/broker-backfill-runs?tickers=us:ZQX',
    });
    expect(anon.statusCode).toBe(401);
  });
});
