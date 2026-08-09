import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { MarketdataModule } from '../../src/marketdata/marketdata.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { QUOTE_PORT } from '../../src/marketdata/quote.port';
import { EodBackedQuoteAdapter } from '../../src/marketdata/eod-backed-quote.adapter';

// 015 T010 报价端点 (EP2) 读侧全 boot IT (Testcontainers PG+Redis, EodBackedQuoteAdapter 直读 PG):
//  ① EOD-backed: 前收算涨跌 + asOf + priceKind=eod_close + Decimal-string
//  ② no-data 隔离: 未知/无数据 symbol 同批返 hasData:false 全 null, 不污染同批有数据项
//  ③ Redis 热快照命中: 首调回填 quote:{symbol} → 改 PG 底层 → 二调仍返缓存旧值 (证读 Redis 非 PG)
//  ④ 入参顺序 + 重复行保留 / 400 缺 symbols / 401 反枚举
// (spec state_branch「quote eod-backed」「quote no-data」; PR2 读侧 quote 段, 详情/K线/限流桶
//  已分别由 read-detail-bars / ratelimit IT 覆盖)。run via `nx test server <file>`。
describe('015 marketdata 报价读端点 EP2 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let token: string;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'marketdata-read-quote-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'marketdata-read-quote-hmac-secret-min-32-byt';
    delete process.env.MARKETDATA_PROVIDER; // mock 模式整体 boot 干净 (live 下 search/universe/calendar 仍 notWiredLive 会崩 boot, 落 PR3)

    // mock 模式下 QUOTE_PORT 默认是 Mock 单例 (固定 fixture, 测不到 EOD-backed 真实读路径) —
    // 外科式覆盖为真实 EodBackedQuoteAdapter (读 PG DailyBar), 精准对准 SUT
    // (EodBackedQuoteAdapter + GetQuotesUseCase Redis 热快照 + EP2 controller),
    // 不引入 live 全 boot 的脆弱性。报价路径纯读 PG, 不打 Lixinger HTTP。
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([MarketdataModule]),
    })
      .overrideProvider(QUOTE_PORT)
      .useFactory({
        factory: (prisma: PrismaService) => new EodBackedQuoteAdapter(prisma),
        inject: [PrismaService],
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    const jwt = moduleRef.get(JwtTokenService);
    const acc = await prisma.account.create({
      data: { phone: '+8613810000002', status: 'ACTIVE' },
    });
    token = jwt.signAccessToken({ accountId: acc.id });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  const auth = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  const seedInstrument = (code: string) =>
    prisma.instrument.create({
      data: {
        market: 'cn',
        code,
        name: `名称-${code}`,
        type: 'stock',
        currency: 'CNY',
        status: 'listed',
      },
    });

  const seedBar = (
    instrumentId: bigint,
    tradeDate: string,
    close: string,
    prevClose: string | null,
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
        ...(prevClose !== null ? { prevClose } : {}),
      },
    });

  it('EOD-backed: 最近收盘价支撑, 前收算涨跌, asOf/priceKind, Decimal-string', async () => {
    const inst = await seedInstrument('600519');
    await seedBar(inst.id, '2026-05-29', '1690.0000', '1680.0000'); // 非最近, 不应被取
    await seedBar(inst.id, '2026-06-01', '1700.0000', '1690.0000'); // 最近

    const res = await auth('/api/v1/marketdata/quote?symbols=cn:600519');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      symbol: 'cn:600519',
      name: '名称-600519',
      price: '1700.0000',
      change: '10.0000',
      changePct: '0.5917',
      asOf: '2026-06-01',
      priceKind: 'eod_close',
      hasData: true,
    });
  });

  it('no-data 隔离: 未知 symbol 同批返 hasData:false 全 null, 不污染有数据项', async () => {
    const inst = await seedInstrument('000001');
    await seedBar(inst.id, '2026-06-01', '12.3400', '12.0000');

    const res = await auth('/api/v1/marketdata/quote?symbols=cn:000001,cn:999999');
    expect(res.statusCode).toBe(200);
    const [withData, noData] = res.json().items;
    expect(withData).toMatchObject({ symbol: 'cn:000001', price: '12.3400', hasData: true });
    expect(noData).toEqual({
      symbol: 'cn:999999',
      name: null,
      price: null,
      change: null,
      changePct: null,
      asOf: null,
      priceKind: 'eod_close',
      hasData: false,
    });
  });

  it('无前收: change/changePct 为 null, 仍 hasData:true (价存在)', async () => {
    const inst = await seedInstrument('000002');
    await seedBar(inst.id, '2026-06-01', '50.0000', null);

    const res = await auth('/api/v1/marketdata/quote?symbols=cn:000002');
    expect(res.json().items[0]).toMatchObject({
      symbol: 'cn:000002',
      price: '50.0000',
      change: null,
      changePct: null,
      asOf: '2026-06-01',
      hasData: true,
    });
  });

  it('Redis 热快照命中: 二调返缓存旧值 (改 PG 底层后仍不变 → 证读 Redis 非回 PG)', async () => {
    const inst = await seedInstrument('000003');
    const bar = await seedBar(inst.id, '2026-06-01', '20.0000', '19.0000');

    const first = (await auth('/api/v1/marketdata/quote?symbols=cn:000003')).json();
    expect(first.items[0].price).toBe('20.0000');

    // 改 PG 底层收盘价 — 若二调回源 PG 会读到新值; 命中 Redis 则仍返旧值。
    await prisma.dailyBar.update({ where: { id: bar.id }, data: { close: '999.0000' } });

    const second = (await auth('/api/v1/marketdata/quote?symbols=cn:000003')).json();
    expect(second.items[0].price).toBe('20.0000'); // 缓存命中, 未被 PG 新值穿透
  });

  it('入参顺序 + 重复行保留', async () => {
    const a = await seedInstrument('000004');
    const b = await seedInstrument('000005');
    await seedBar(a.id, '2026-06-01', '4.0000', '3.0000');
    await seedBar(b.id, '2026-06-01', '5.0000', '4.0000');

    const res = await auth('/api/v1/marketdata/quote?symbols=cn:000005,cn:000004,cn:000005');
    const symbols = res.json().items.map((q: { symbol: string }) => q.symbol);
    expect(symbols).toEqual(['cn:000005', 'cn:000004', 'cn:000005']);
  });

  it('缺 symbols → 400 FORM_VALIDATION', async () => {
    const res = await auth('/api/v1/marketdata/quote');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FORM_VALIDATION');
  });

  it('空 symbols (仅逗号/空白) → 400', async () => {
    const res = await auth('/api/v1/marketdata/quote?symbols=%20,%20');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FORM_VALIDATION');
  });

  it('缺 token → 401 (反枚举)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketdata/quote?symbols=cn:600519',
    });
    expect(res.statusCode).toBe(401);
  });
});
