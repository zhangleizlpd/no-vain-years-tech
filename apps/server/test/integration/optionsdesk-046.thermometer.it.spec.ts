import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { mapConfidenceToLLevel } from '../../src/optionsdesk/anchor.rules';
import { US_INDEX_CODES } from '../../src/optionsdesk/get-thermometer.usecase';
import { DbTradingCalendarAdapter } from '../../src/marketdata/db-trading-calendar.adapter';
import { TRADING_CALENDAR_PORT } from '../../src/marketdata/trading-calendar.port';

// 046 T018 波动温度计读端 IT (FR-015/FR-016/FR-017/FR-018/FR-027/FR-032/FR-035)。
//
// ## 为什么**必须**要真 PG
//
// 本条验的四件事在 mock 上要么不成立、要么退化成平凡绿:
//   ① **「每只标的取最新一期」是真 SQL 聚合** —— 实现走 `groupBy(instrumentId, _max(date))`
//      再按 (标的, 日) 取行。把 prisma mock 掉, 这条链就变成 mock 返回值本身 (T017 单测已在
//      那一层用微型 fake 验过); 这里要验的恰是**真表 + 真唯一索引**能不能把「多期历史 → 只回
//      最近一期」跑通, 且不同标的的最新期**可以不是同一天**。
//   ② **VVIX 的 open/high/low 恒 NULL 只有真库能验** —— 必须库里**真的**是 NULL (`Decimal?`
//      列写不进 0), 而响应里**真的**连这三个键都没有。mock 里不 seed 那几列, 断言「响应没有
//      它们」就是自证 (探针看不见反例, testing.md §7)。
//   ③ **两个指数的 `asOf` 不同交易日是可达分支** (FR-016) —— VIX / VVIX 在库里是两组独立行
//      (`us_index_daily` 无 instrument 关联、无共同外键), 只有真表能造出「两侧最新一期落在
//      不同日」这个生产上真会发生的形态。
//   ④ **零锚时表盘照常** (FR-027 的效果面) 要的是「锚表真空 + 指数表真有数」这个组合状态,
//      它跨两个 schema (optionsdesk / marketdata), 是库级事实不是对象级事实。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。不用 `setupEmptyDb()` —— 那个入口是给「自己跑 `migrate deploy`
// 并验证其产物」的文件用的 (本 feature 里 T005 已占)。**不用 `setupIsolatedStores()`**: 本端点
// 全程不碰 Redis (限流由 `narrowTestModule` 的内存桶承担), `REDIS_CLIENT` 改用 stub 覆盖 ——
// `RedisLifecycle` 的连接是惰性的 ⇒ 覆盖后一条 socket 都不开。
//
// ## 装配 = 收窄 boot + 真 HTTP
//
// `narrowTestModule([OptionsdeskModule])` —— **不 boot 整个 `AppModule`**。请求经 `app.inject()`
// 走**完整 Fastify lifecycle**: CLS middleware → Guards (JwtAuthGuard / AccountIdThrottlerGuard)
// → ValidationPipe → Controller → ProblemDetailFilter, 一个都没被 `.overrideGuard()` 抹掉。
//
// 🚨 **真 HTTP 这件事对下游有价值, 别退化成直接 new usecase**: T027 要从**同批** `nx test
// server` 的日志里取本片两个端点的 p95/p99 与 `perf_budgets` (温度计 50/100) 对账。为此本文件
// 给 Fastify 的 pino logger 起了**与 T016 不同**的具名 `name` —— 并行 worker 的 stdout 交织后,
// 只有这个 name 能把 `request completed` 行归属到本端点。
const LOGGER_NAME = 'it-046-thermometer';

describe('046 T018 波动温度计读端 (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let token: string;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  const V = '50';
  const CONFIDENCE = '8'; // → L2

  /**
   * 🚨 日快照 / 指数日线的 `date` 是**美股业务日** (`marketDateFor(us)` 的产物), 不是采集日 ——
   * 造数据一律用美股日期。07-31 与 07-30 都是周五 / 周四, 均为美股交易日。
   */
  const D31 = '2026-07-31';
  const D30 = '2026-07-30';
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  const VIX_CLOSE = '18.45';
  const VVIX_CLOSE = '96.3';
  /** 比值**算**出来而不写死 —— 写死等于把实现的算法抄进断言。 */
  const RATIO = new Prisma.Decimal(VVIX_CLOSE).div(new Prisma.Decimal(VIX_CLOSE)).toFixed(4);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-046-t018-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-046-t018-hmac-secret-min-32-bytes';
    // 本地 shell 常泄漏 MARKETDATA_PROVIDER=live 与 OSS_* 部署凭据 → 两者的 config 分支要求
    // 整组 env 齐备, 缺一个就在 boot 期 ZodError (CI 干净, 只有本地中招)。
    process.env.MARKETDATA_PROVIDER = 'mock';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OSS_')) delete process.env[key];
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([OptionsdeskModule]),
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .overrideProvider(TRADING_CALENDAR_PORT)
      // 062 T010: 陈旧度基准改走端口。测试里 `MARKETDATA_PROVIDER` 恒为 `mock` ⇒ 端口会绑到
      // `MockMarketDataAdapter`（按墙上时钟推最近工作日）⇒ 下面 seed 的 `trading_day` /
      // `calendar_coverage` 一行都读不到、断言随墙上时钟漂。故显式绑真 adapter。
      .useFactory({
        factory: (p: PrismaService) => new DbTradingCalendarAdapter(p),
        inject: [PrismaService],
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: { name: LOGGER_NAME } }),
    );
    // 与 main.ts 同形态 —— 通道层不做特例。
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    const account = await prisma.account.create({
      data: { phone: '+8613810000047', status: 'ACTIVE' },
    });
    token = moduleRef.get(JwtTokenService).signAccessToken({ accountId: account.id });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change, marketdata.underlying_iv_daily, marketdata.us_index_daily, marketdata.instrument, marketdata.trading_day RESTART IDENTITY CASCADE',
    );
    // 🚨 FR-020 判据基准来自**真交易日历**, 必须自己 seed —— 不 seed 就落进 fail-open 分支,
    // 「陈旧」这一档永远走不到, 断言变成平凡绿。只 seed 到 D31 ⇒ 最近已收盘交易日 = 07-31,
    // 与跑测时的墙上时钟无关。
    await prisma.tradingDay.createMany({
      data: [
        { market: 'us', date: new Date(`${D30}T00:00:00.000Z`) },
        { market: 'us', date: new Date(`${D31}T00:00:00.000Z`) },
      ],
    });
    // 🚨 062 T010: 只 seed `trading_day` 不够 —— 收盘上界落在覆盖声明之外时端口返 `null`
    // ⇒ fail-open 判当期档, 「陈旧」那一档又走不到了。声明必须显式覆盖到上界。
    await prisma.calendarCoverage.upsert({
      where: { market: 'us' },
      create: {
        market: 'us',
        coveredFrom: day('2026-01-01'),
        coveredTo: day('2099-12-31'),
        servedBy: 'it-seed',
      },
      update: {},
    });
  });

  const get = (headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/optionsdesk/thermometer',
      headers: { authorization: `Bearer ${token}`, ...headers },
    });

  const seedAnchor = (ticker: string, over: { excluded?: boolean; excludeReason?: string } = {}) =>
    prisma.anchor.create({
      data: {
        ticker,
        v: V,
        asof: day('2026-06-30'),
        method: 'dcf',
        confidence: CONFIDENCE,
        confidenceSource: 'manual',
        lLevelEffective: mapConfidenceToLLevel(CONFIDENCE),
        nextReview: day('2026-09-30'),
        lastReviewedOn: day('2026-06-30'),
        excluded: over.excluded ?? false,
        excludeReason: over.excludeReason ?? null,
      },
    });

  const seedInstrument = (code: string) =>
    prisma.instrument.create({
      data: { market: 'us', code, name: code, type: 'stock', currency: 'USD', status: 'listed' },
    });

  /** 一行 IV 日快照。**`ivRank` 恒 seed 真值** —— FR-013 的反例得真实存在才验得动。 */
  const seedIv = (
    instrumentId: bigint,
    date: string,
    over: { iv?: string; ivPercentile?: string | null } = {},
  ) =>
    prisma.underlyingIvDaily.create({
      data: {
        instrumentId,
        date: day(date),
        iv: over.iv ?? '24.9',
        ivRank: '71.5', // 库里真有 IVR
        ivPercentile: over.ivPercentile === undefined ? '58.4' : over.ivPercentile,
      },
    });

  /** VIX 有 OHLC; VVIX **只有 close** (CBOE 那个文件只有 `DATE,VVIX`) ⇒ 其余列留 NULL 禁填 0。 */
  const seedVix = (date: string, close = VIX_CLOSE) =>
    prisma.usIndexDaily.create({
      data: {
        indexCode: US_INDEX_CODES.vix,
        date: day(date),
        open: '18.02',
        high: '19.11',
        low: '17.88',
        close,
      },
    });

  const seedVvix = (date: string, close = VVIX_CLOSE) =>
    prisma.usIndexDaily.create({
      data: { indexCode: US_INDEX_CODES.vvix, date: day(date), close },
    });

  it('① 同基准: 两指数各带自己的 asOf + 比值在 server 算出并标基准日 + 逐票列表齐备', async () => {
    await seedAnchor('us:PEP');
    const inst = await seedInstrument('PEP');
    await seedIv(inst.id, '2026-07-28'); // 更早的一期, 不该被取
    await seedIv(inst.id, D31);
    await seedVix('2026-07-29'); // 同上, 指数侧也要验「取最近一期」
    await seedVix(D31);
    await seedVvix(D31);

    const res = await get();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.vix).toEqual({
      state: 'available',
      close: '18.4500',
      asOf: D31,
      freshnessTier: 'CURRENT',
    });
    expect(body.vvix).toEqual({
      state: 'available',
      close: '96.3000',
      asOf: D31,
      freshnessTier: 'CURRENT',
    });
    expect(body.vvixVixRatio).toEqual({ state: 'available', value: RATIO, basisDate: D31 });

    expect(body.total).toBe(1);
    expect(body.underlyings[0]).toEqual({
      ticker: 'us:PEP',
      excluded: false,
      excludeReason: null,
      iv: {
        state: 'available',
        aggregateIv: '24.90000000',
        ivPercentile: '58.4000',
        asOf: D31, // 🚨 最近一期, 不是 07-28 那期
        freshnessTier: 'CURRENT',
      },
    });

    // 🚨 FR-013 端到端: 库里 iv_rank 真有值, 响应里一个字都没有
    const stored = await prisma.underlyingIvDaily.findFirstOrThrow({
      where: { instrumentId: inst.id, date: day(D31) },
    });
    expect(stored.ivRank).not.toBeNull();
    expect(res.body).not.toMatch(/ivRank|iv_rank/i);
    // 🚨 FR-035: 契约面禁任何 IV30d 措辞; FR-015 📌: 禁 regime 读数
    expect(res.body).not.toMatch(/iv30d/i);
    expect(res.body).not.toMatch(/regime/i);
  });

  it('② 两侧最新可得日**不同** → 比值不计算 + basis_mismatch, 两值照常各带自己的 asOf', async () => {
    await seedVix(D31);
    await seedVvix(D30); // VVIX 那个文件停在前一交易日 —— 两个独立文件, 生产可达

    const body = (await get()).json();

    expect(body.vix.asOf).toBe(D31);
    expect(body.vvix.asOf).toBe(D30);
    expect(body.vvixVixRatio).toEqual({
      state: 'basis_mismatch',
      value: null,
      basisDate: null,
    });
  });

  it('③ VVIX 缺 → VVIX 与比值**各自**显式不可用, MUST NOT 拿 VIX 单独推算 (表盘照常)', async () => {
    await seedVix(D31);

    const body = (await get()).json();

    expect(body.vix.state).toBe('available');
    expect(body.vvix).toEqual({
      state: 'missing',
      close: null,
      asOf: null,
      freshnessTier: 'UNAVAILABLE',
    });
    expect(body.vvixVixRatio).toEqual({ state: 'missing', value: null, basisDate: null });
  });

  it('④ VIX 缺 → 显式 missing 且 close 为 null (🚨 禁 0: 指针停 0 会被读成「极度平静」)', async () => {
    await seedVvix(D31);

    const body = (await get()).json();

    expect(body.vix).toEqual({
      state: 'missing',
      close: null,
      asOf: null,
      freshnessTier: 'UNAVAILABLE',
    });
    expect(body.vix.close).not.toBe('0.0000'); // FR-017 的反面写死一遍
    expect(body.vvix.state).toBe('available'); // 另一侧不受牵连
    expect(body.vvixVixRatio.state).toBe('missing');
  });

  it('⑤ 🚨 零锚: IVP 列表空, 但**指数部分仍有真数据** (FR-027 的效果面端到端)', async () => {
    await seedVix(D31);
    await seedVvix(D31);

    const res = await get();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(await prisma.anchor.count()).toBe(0); // 前提: 锚表真空
    expect(body.underlyings).toEqual([]);
    expect(body.total).toBe(0);
    // 表盘不依赖锚 —— 采集侧 (T013) 的「指数维度不挂锚闸」在契约层的对照面
    expect(body.vix.close).toBe('18.4500');
    expect(body.vvix.close).toBe('96.3000');
    expect(body.vvixVixRatio.state).toBe('available');
  });

  it('⑥ 列表含「分位不可算」行与 `excluded` 行 (各自带标记, 都不许被过滤掉)', async () => {
    await seedAnchor('us:PEP');
    await seedAnchor('us:VICI', { excluded: true, excludeReason: '暂不交易' });
    await seedAnchor('us:ZZZZ'); // 有锚但 marketdata 里没这只标的
    const pep = await seedInstrument('PEP');
    const vici = await seedInstrument('VICI');
    await seedIv(pep.id, D31);
    await seedIv(vici.id, D30, { iv: '19.75', ivPercentile: null }); // 窗口不足
    await seedVix(D31);
    await seedVvix(D31);

    const body = (await get()).json();

    expect(body.total).toBe(3);
    expect(body.underlyings.map((r: { ticker: string }) => r.ticker)).toEqual([
      'us:PEP',
      'us:VICI',
      'us:ZZZZ',
    ]);
    // 「分位不可算」的行保留在列表内, 且**各标的的最新期可以不同日** (真表聚合, 非同一天)
    expect(body.underlyings[1]).toEqual({
      ticker: 'us:VICI',
      excluded: true, // 🚨 excluded 照常在列并带标记 (045 语义, 与雷达相反)
      excludeReason: '暂不交易',
      iv: {
        state: 'percentile_unavailable',
        aggregateIv: '19.75000000',
        ivPercentile: null, // 🚨 MUST NOT 回落成 '0' / '0.0000'
        asOf: D30,
        // 🚨 该票停在 07-30, 而最近一个已收盘交易日是 07-31 ⇒ STALE。同屏 PEP 是 CURRENT,
        // 逐行各判各的 —— 合成一个页级新鲜度这条即红。
        freshnessTier: 'STALE',
      },
    });
    // 未注册进 marketdata 的锚仍在列, 读数为显式 missing (缺行是事实不是故障)
    expect(body.underlyings[2].iv).toEqual({
      state: 'missing',
      aggregateIv: null,
      ivPercentile: null,
      asOf: null,
      freshnessTier: 'UNAVAILABLE',
    });
  });

  it('VVIX 的 open/high/low 在库里真是 NULL, 而契约面**连这三个键都没有** (禁当 0 用)', async () => {
    await seedVix(D31);
    await seedVvix(D31);

    const stored = await prisma.usIndexDaily.findFirstOrThrow({
      where: { indexCode: US_INDEX_CODES.vvix },
    });
    expect(stored.open).toBeNull();
    expect(stored.high).toBeNull();
    expect(stored.low).toBeNull();

    const body = (await get()).json();
    // 三键 + FR-020 的新鲜度档 (2026-08-04 加); open/high/low **依然一个都没有**。
    const indexKeys = ['asOf', 'close', 'freshnessTier', 'state'];
    expect(Object.keys(body.vvix).sort()).toEqual(indexKeys);
    expect(Object.keys(body.vix).sort()).toEqual(indexKeys);
  });

  it('新路由确实挂在鉴权后: 无 token → 401 ProblemDetail (漏 Guard 不会自己红)', async () => {
    await seedVix(D31);

    const res = await app.inject({ method: 'GET', url: '/api/v1/optionsdesk/thermometer' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, type: 'about:blank' });
  });
});
