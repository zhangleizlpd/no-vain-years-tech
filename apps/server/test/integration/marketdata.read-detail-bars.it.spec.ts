import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { MarketdataModule } from '../../src/marketdata/marketdata.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';

// 015 T008 EP3/EP4 读端点 IT (Testcontainers PG+Redis 全 boot, mock 模式 — 详情/K线 UC 直读 PG):
//  详情聚合字段集 + 缺失维度 null + 404 + 401 + Decimal-string / bars adjust 三态 + period 聚合 +
//  非法 adjust 400 + 空区间空 bars (spec state_branch detail aggregate / not-found / bars adjust /
//  bars period aggregation / detail field coverage)。
// 020 T003 读时换算: forward/backward 不再读物化行 — none 行 × 因子跃变 B(t)=∏f_i 派生
//  (跨段/exDate prevClose 边界/零因子三口径相等/物化行死数据/聚合先换算后聚合);
//  adjust=none 直读物化行与现状逐字节一致 (SC-A04)。原「三态各返各自物化序列」用例随
//  行为契约变更改写 (spec FR-A03, 改写非误删)。
describe('015 marketdata 详情 + K线读端点 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let token: string;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'marketdata-detail-bars-jwt-secret-min-32-byte';
    process.env.SMS_CODE_HMAC_SECRET = 'marketdata-detail-bars-hmac-secret-min-32-by';
    delete process.env.MARKETDATA_PROVIDER; // mock 模式 (读端点直读 PG, 与 mock/live 无关)

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([MarketdataModule]),
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    const jwt = moduleRef.get(JwtTokenService);
    const acc = await prisma.account.create({
      data: { phone: '+8613810000001', status: 'ACTIVE' },
    });
    token = jwt.signAccessToken({ accountId: acc.id });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  const auth = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  const seedInstrument = (code: string, extra: Record<string, unknown> = {}) =>
    prisma.instrument.create({
      data: {
        market: 'cn',
        code,
        name: `名称-${code}`,
        type: 'stock',
        currency: 'CNY',
        status: 'listed',
        ...extra,
      },
    });

  const noneBar = (
    instrumentId: bigint,
    tradeDate: string,
    close: string,
    extra: Record<string, unknown> = {},
  ) =>
    prisma.dailyBar.create({
      data: {
        instrumentId,
        tradeDate: new Date(`${tradeDate}T00:00:00Z`),
        adjust: 'none',
        open: close,
        high: close,
        low: close,
        close,
        ...extra,
      },
    });

  it('详情聚合: 报价 header + 52 周高低 + 估值/分位 + 财务 + 公司行动 + 身份, Decimal 为 string', async () => {
    const inst = await seedInstrument('600519', { listDate: new Date('2001-08-27T00:00:00Z') });
    await noneBar(inst.id, '2026-05-20', '1850.0000'); // 52w 高
    await noneBar(inst.id, '2026-05-25', '1500.0000'); // 52w 低
    await noneBar(inst.id, '2026-06-01', '1700.0000', {
      open: '1680.0000',
      high: '1705.0000',
      low: '1675.0000',
      prevClose: '1690.0000',
      volume: '3200000',
      amount: '5440000000.00',
      turnoverRate: '0.2500',
    });
    await prisma.fundamentalSnapshot.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-06-01T00:00:00Z'),
        peTtm: '25.5000',
        pb: '9.2000',
        pePctlY3: '0.4200',
      },
    });
    await prisma.financialMetric.create({
      data: { instrumentId: inst.id, reportPeriod: '2026Q1', roe: '0.3100', eps: '18.5000' },
    });
    await prisma.corporateAction.create({
      data: {
        instrumentId: inst.id,
        exDate: new Date('2026-06-20T00:00:00Z'),
        type: 'dividend',
        payload: { perShare: '30.00' },
      },
    });

    const res = await auth('/api/v1/marketdata/instruments/cn:600519');
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toMatchObject({
      symbol: 'cn:600519',
      name: '名称-600519',
      market: 'cn',
      code: '600519',
      currency: 'CNY',
      status: 'listed',
      listDate: '2001-08-27',
      delistDate: null,
    });
    expect(body.quote).toMatchObject({
      price: '1700.0000',
      change: '10.0000',
      changePct: '0.5917',
      prevClose: '1690.0000',
      asOf: '2026-06-01',
      priceKind: 'eod_close',
      hasData: true,
      fiftyTwoWeekHigh: '1850.0000',
      fiftyTwoWeekLow: '1500.0000',
    });
    expect(body.valuation).toMatchObject({
      date: '2026-06-01',
      peTtm: '25.5000',
      pb: '9.2000',
      pePctlY3: '0.4200',
      ps: null,
    });
    expect(body.financials).toMatchObject({
      reportPeriod: '2026Q1',
      roe: '0.3100',
      eps: '18.5000',
      bps: null,
    });
    expect(body.corporateActions).toHaveLength(1);
    expect(body.corporateActions[0]).toMatchObject({ exDate: '2026-06-20', type: 'dividend' });
    expect(body.corporateActions[0].payload).toEqual({ perShare: '30.00' });
  });

  it('缺失维度 null: 仅身份 (无任何 DailyBar/估值/财报/公司行动)', async () => {
    await seedInstrument('000001');
    const res = await auth('/api/v1/marketdata/instruments/cn:000001');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quote).toMatchObject({
      price: null,
      change: null,
      hasData: false,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
    });
    expect(body.valuation).toBeNull();
    expect(body.financials).toBeNull();
    expect(body.corporateActions).toEqual([]);
  });

  it('未知 symbol → 404 INSTRUMENT_NOT_FOUND', async () => {
    const res = await auth('/api/v1/marketdata/instruments/cn:999999');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('INSTRUMENT_NOT_FOUND');
  });

  it('缺 token → 401 (反枚举)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketdata/instruments/cn:600519',
    });
    expect(res.statusCode).toBe(401);
  });

  it('K线 adjust 三态 (020 读时换算): 物化 fwd/bwd 行成死数据, 零因子标的三口径 = none', async () => {
    const inst = await seedInstrument('000002');
    const day = new Date('2026-06-01T00:00:00Z');
    // 物化 forward/backward 行 = 020 后死数据 decoy — 读路径不得再消费。
    for (const [adjust, close] of [
      ['none', '100.0000'],
      ['forward', '90.0000'],
      ['backward', '110.0000'],
    ] as const) {
      await prisma.dailyBar.create({
        data: {
          instrumentId: inst.id,
          tradeDate: day,
          adjust,
          open: close,
          high: close,
          low: close,
          close,
        },
      });
    }
    // 零因子版本 → forward = backward = none (FR-A03; 物化 90/110 不可见)。
    const fwd = (await auth('/api/v1/marketdata/instruments/cn:000002/bars?adjust=forward')).json();
    expect(fwd.adjust).toBe('forward');
    expect(fwd.items).toHaveLength(1);
    expect(fwd.items[0].close).toBe('100.0000');

    const bwd = (
      await auth('/api/v1/marketdata/instruments/cn:000002/bars?adjust=backward')
    ).json();
    expect(bwd.items[0].close).toBe('100.0000');

    // none 直读物化行与现状逐字节一致 (SC-A04)。
    const none = (await auth('/api/v1/marketdata/instruments/cn:000002/bars?adjust=none')).json();
    expect(none.items[0]).toMatchObject({
      tradeDate: '2026-06-01',
      adjust: 'none',
      open: '100.0000',
      high: '100.0000',
      low: '100.0000',
      close: '100.0000',
      prevClose: null,
      volume: null,
      amount: null,
      turnoverRate: null,
    });
  });

  it('K线读时换算: 跨段 B(t)=∏f_i + exDate 当日 prevClose 前段因子 + forward=backward÷B_latest', async () => {
    const inst = await seedInstrument('600100');
    // 两个跃变版本: 06-03 f=1.1 / 06-05 f=1.2 → 段 B: 1 / 1.1 / 1.32 (B_latest=1.32)。
    for (const [exDate, jump] of [
      ['2026-06-03', '1.1'],
      ['2026-06-05', '1.2'],
    ] as const) {
      await prisma.adjustmentFactor.create({
        data: {
          instrumentId: inst.id,
          exDate: new Date(`${exDate}T00:00:00Z`),
          factorBackward: jump,
        },
      });
    }
    await noneBar(inst.id, '2026-06-01', '100.0000', { prevClose: '99.0000', volume: '100' });
    await noneBar(inst.id, '2026-06-03', '91.0000', { prevClose: '100.0000', volume: '200' }); // exDate 根
    await noneBar(inst.id, '2026-06-04', '92.0000', { prevClose: '91.0000', volume: '50' });
    await noneBar(inst.id, '2026-06-05', '80.0000', { prevClose: '92.0000', volume: '70' }); // exDate 根

    const bwd = (
      await auth('/api/v1/marketdata/instruments/cn:600100/bars?adjust=backward')
    ).json();
    expect(bwd.items.map((i: { close: string }) => i.close)).toEqual([
      '100.0000', // ×1
      '100.1000', // 91×1.1
      '101.2000', // 92×1.1
      '105.6000', // 80×1.32
    ]);
    // exDate 当日 prevClose 用前段因子 = 前一根换算 close; 非 exDate 同段。
    expect(bwd.items.map((i: { prevClose: string }) => i.prevClose)).toEqual([
      '99.0000', // ×1
      '100.0000', // exDate 根: 100×1 (前段)
      '100.1000', // 91×1.1 (同段)
      '101.2000', // exDate 根: 92×1.1 (前段)
    ]);
    // volume 直拷不随复权变化。
    expect(bwd.items.map((i: { volume: string }) => i.volume)).toEqual(['100', '200', '50', '70']);

    const fwd = (await auth('/api/v1/marketdata/instruments/cn:600100/bars?adjust=forward')).json();
    expect(fwd.items.map((i: { close: string }) => i.close)).toEqual([
      '75.7576', // 100÷1.32
      '75.8333', // 100.1÷1.32
      '76.6667', // 101.2÷1.32
      '80.0000', // 最新段 forward = none
    ]);
  });

  it('K线读时换算 + period=week 聚合: 先日线换算后聚合', async () => {
    const inst = await seedInstrument('600101');
    await prisma.adjustmentFactor.create({
      data: {
        instrumentId: inst.id,
        exDate: new Date('2026-06-03T00:00:00Z'),
        factorBackward: '2',
      },
    });
    await noneBar(inst.id, '2026-06-01', '10.0000', { volume: '100' });
    await noneBar(inst.id, '2026-06-03', '11.0000', { high: '12.0000', volume: '200' });

    const wk = (
      await auth('/api/v1/marketdata/instruments/cn:600101/bars?adjust=backward&period=week')
    ).json();
    expect(wk.items).toHaveLength(1);
    expect(wk.items[0]).toMatchObject({
      tradeDate: '2026-06-03',
      open: '10.0000', // 首根 ×1
      high: '24.0000', // 12×2
      close: '22.0000', // 11×2
      volume: '300', // 量和直拷
    });
  });

  it('K线 period=week 聚合: 首开/最高/最低/末收 + 量和', async () => {
    const inst = await seedInstrument('000003');
    await noneBar(inst.id, '2026-06-01', '11.0000', {
      open: '10.0000',
      high: '12.0000',
      low: '9.0000',
      volume: '100',
    });
    await noneBar(inst.id, '2026-06-03', '14.0000', {
      open: '11.0000',
      high: '15.0000',
      low: '8.0000',
      volume: '200',
    });
    await noneBar(inst.id, '2026-06-05', '13.0000', {
      open: '14.0000',
      high: '14.0000',
      low: '13.0000',
      volume: '50',
    });

    const wk = (await auth('/api/v1/marketdata/instruments/cn:000003/bars?period=week')).json();
    expect(wk.period).toBe('week');
    expect(wk.items).toHaveLength(1);
    expect(wk.items[0]).toMatchObject({
      tradeDate: '2026-06-05',
      open: '10.0000',
      high: '15.0000',
      low: '8.0000',
      close: '13.0000',
      volume: '350',
    });
  });

  it('非法 adjust → 400 FORM_VALIDATION', async () => {
    await seedInstrument('000004');
    const res = await auth('/api/v1/marketdata/instruments/cn:000004/bars?adjust=garbage');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FORM_VALIDATION');
  });

  it('空区间 → 空 items (200, 非 5xx)', async () => {
    const inst = await seedInstrument('000005');
    await noneBar(inst.id, '2026-06-01', '50.0000');
    const res = await auth('/api/v1/marketdata/instruments/cn:000005/bars?from=2099-01-01');
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('K线未知 symbol → 404', async () => {
    const res = await auth('/api/v1/marketdata/instruments/cn:888888/bars');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('INSTRUMENT_NOT_FOUND');
  });
});
