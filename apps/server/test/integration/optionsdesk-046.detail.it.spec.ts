import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import {
  computeW,
  computeWillingSellAnchors,
  computeZoneBoundaries,
  derivePositionCap,
  mapConfidenceToLLevel,
} from '../../src/optionsdesk/anchor.rules';
import { ANCHOR_NOT_FOUND_FOR_SYMBOL } from '../../src/optionsdesk/get-underlying-detail.usecase';

// 046 T016 详情读端 IT (FR-002/FR-003/FR-011/FR-012/FR-013/FR-014/FR-020/FR-032)。
//
// ## 为什么**必须**要真 PG
//
// 本条验的三件事在 mock 上要么不成立、要么退化成平凡绿:
//   ① **跨 ctx 读是一条真 SQL 路径** —— 锚 ticker → `marketdata.instrument` 唯一键 →
//      `underlying_iv_daily` 按 `(instrument_id, date desc)` 取最近一期。把 prisma mock 掉,
//      「最近一期」就变成 mock 返回值本身, 而 T015 单测已经在那一层验过了; 这里要验的恰是
//      **两张真表 + 真索引序**能不能把「当日未采到 → 回上一期 + 它自己的 asOf」跑通。
//   ② **`iv_rank` 只落库不上屏 (FR-013) 只有真库能验** —— 必须库里**真有** IVR 值、而响应里
//      **真没有**。mock 里不 seed 那一列, 断言「响应没有它」就是自证 (探针看不见反例)。
//   ③ **RFC 9457 + traceId 是通道层产物** —— ProblemDetail 由 `APP_FILTER` 在真 lifecycle 末端
//      写出, traceId 由 CLS middleware 生成; 直接 new usecase 调方法两者都不存在。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// **禁自起 Testcontainers**)。不用 `setupEmptyDb()` —— 那个入口是给「自己跑 `migrate deploy`
// 并验证其产物」的文件用的 (本 feature 里 T005 已占)。**不用 `setupIsolatedStores()`**: 本端点
// 全程不碰 Redis (限流由 `narrowTestModule` 的内存桶承担), 白起一个 Redis 容器纯属浪费 ——
// `REDIS_CLIENT` 改用 stub 覆盖, `RedisLifecycle` 的连接是惰性的 ⇒ 覆盖后一条 socket 都不开
// (见 `security.module.ts` 那段 🚨 注释, 2026-08-02 出网探针实测)。
//
// ## 装配 = 收窄 boot + 真 HTTP
//
// `narrowTestModule([OptionsdeskModule])` —— **不 boot 整个 `AppModule`** (2026-08-03 测试重构
// 后的强制形态)。请求经 `app.inject()` 走**完整 Fastify lifecycle**: CLS middleware → Guards
// (JwtAuthGuard / AccountIdThrottlerGuard) → ValidationPipe → Controller → ProblemDetailFilter,
// 一个都没被 `.overrideGuard()` 抹掉。
//
// 🚨 **真 HTTP 这件事对下游有价值, 别退化成直接 new usecase**: T027 要从**同批** `nx test
// server` 的日志里取本片两个端点的 p95/p99 与 `perf_budgets` 对账。为此本文件给 Fastify 的
// pino logger 起了具名 `name`, 每条 `request completed` 行都带 `responseTime` + 该 name ⇒
// 与 T018 的行可无歧义分开 (否则并行 worker 的 stdout 交织后无法归属到端点)。
const LOGGER_NAME = 'it-046-detail';

describe('046 T016 标的详情读端 (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let token: string;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  /** V=50 ⇒ W / 四区间 / 愿卖锚全部由 rules 派生 —— 本文件不复写任何档位字面量 (SC-005)。 */
  const V = '50';
  const CONFIDENCE = '8'; // → L2
  const SYMBOL = 'us:PEP';

  /**
   * 两个业务日**蓄意不同**: 行情 asOf 停在 07-30、IV 快照到 07-31 ⇒ FR-020「两侧各带各的
   * asOf」有可观测的反例 —— 若实现把两者混成一个字段, 这里立刻红。
   */
  const QUOTE_AS_OF = '2026-07-30';
  const IV_AS_OF = '2026-07-31';
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.REDIS_URL = 'redis://127.0.0.1:6399'; // 恒不连 (REDIS_CLIENT 被 stub 覆盖)
    process.env.AUTH_JWT_SECRET = 'optionsdesk-046-t016-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-046-t016-hmac-secret-min-32-bytes';
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
      data: { phone: '+8613810000046', status: 'ACTIVE' },
    });
    token = moduleRef.get(JwtTokenService).signAccessToken({ accountId: account.id });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change, marketdata.underlying_iv_daily, marketdata.instrument, marketdata.trading_day RESTART IDENTITY CASCADE',
    );
    // 🚨 FR-020 的判据基准来自**真交易日历**, 必须自己 seed —— 不 seed 就落进 fail-open 分支,
    // 「陈旧」这一档永远走不到, 断言变成平凡绿 (正是 046 那个缺陷混过 review 的形态)。
    // 只 seed 到 IV_AS_OF ⇒ 「最近一个已收盘交易日」= 07-31, 与跑测时的墙上时钟无关。
    await prisma.tradingDay.createMany({
      data: [
        { market: 'us', date: day(QUOTE_AS_OF) },
        { market: 'us', date: day(IV_AS_OF) },
      ],
    });
  });

  const get = (symbol: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/optionsdesk/underlyings/${symbol}`,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });

  const seedAnchor = () =>
    prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        v: V,
        asof: day('2026-06-30'),
        method: 'dcf',
        confidence: CONFIDENCE,
        confidenceSource: 'manual',
        lLevelEffective: mapConfidenceToLLevel(CONFIDENCE),
        nextReview: day('2026-09-30'),
        lastReviewedOn: day('2026-06-30'),
        lastClose: '36',
        lastCloseDate: day(QUOTE_AS_OF),
      },
    });

  const seedInstrument = () =>
    prisma.instrument.create({
      data: {
        market: 'us',
        code: 'PEP',
        name: 'PepsiCo',
        type: 'stock',
        currency: 'USD',
        status: 'listed',
      },
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
        iv: over.iv ?? '24.8',
        ivRank: '71.5', // 库里真有 IVR
        ivPercentile: over.ivPercentile === undefined ? '58.4' : over.ivPercentile,
      },
    });

  it('① 常态 (锚在 + IV 在): 锚派生值同 rules 单点口径 + 两侧 asOf 各自独立 + IVR 不上屏', async () => {
    await seedAnchor();
    const inst = await seedInstrument();
    await seedIv(inst.id, '2026-07-28'); // 更早的一期, 不应被取
    await seedIv(inst.id, IV_AS_OF);

    const res = await get(SYMBOL);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.symbol).toBe(SYMBOL);

    // FR-003: 派生值逐项与 045 的 rules 纯函数一致 (本片零重造)
    expect(body.anchor.w).toBe(computeW(V).toFixed(4));
    expect(body.anchor.zoneFloor).toBe(computeZoneBoundaries(V).floor.toFixed(4));
    expect(body.anchor.zoneCeiling).toBe(computeZoneBoundaries(V).ceiling.toFixed(4));
    expect(body.anchor.willingSellLongHold).toBe(computeWillingSellAnchors(V).longHold.toFixed(4));
    expect(body.anchor.lLevelEffective).toBe(mapConfidenceToLLevel(CONFIDENCE));
    expect(body.anchor.positionCap).toBe(derivePositionCap('L2')!.toFixed(4));

    // FR-020: 行情 asOf 与 IV asOf 是**两个**字段、两个日期
    expect(body.anchor.lastCloseDate).toBe(QUOTE_AS_OF);
    expect(body.iv).toEqual({
      state: 'available',
      aggregateIv: '24.80000000',
      ivPercentile: '58.4000',
      asOf: IV_AS_OF, // 🚨 取最近一期, 不是 07-28 那期
      freshnessTier: 'CURRENT', // = 最近一个已收盘交易日
    });
    // 🚨 判别性断言: 同一请求内两侧档位**不同** —— 行情停在 07-30 (落后一个交易日) ⇒ STALE,
    // IV 到 07-31 ⇒ CURRENT。把两侧合成一个页级新鲜度、或把判据挪回客户端本地日期, 这条即红。
    expect(body.anchor.quoteFreshnessTier).toBe('STALE');

    // 🚨 FR-013 端到端: 库里 iv_rank 真有值, 响应里一个字都没有
    const stored = await prisma.underlyingIvDaily.findFirstOrThrow({
      where: { instrumentId: inst.id, date: day(IV_AS_OF) },
    });
    expect(stored.ivRank).not.toBeNull();
    expect(res.body).not.toMatch(/ivRank|iv_rank/i);
    // 🚨 FR-035: 口径标注一律「富途标的聚合 IV」, 契约面禁任何 IV30d 措辞
    expect(res.body).not.toMatch(/iv30d/i);
  });

  it('② 锚在 + IV 窗口不足 (vendor 未给分位) → percentile_unavailable, 聚合 IV 与 asOf 照常', async () => {
    await seedAnchor();
    const inst = await seedInstrument();
    await seedIv(inst.id, IV_AS_OF, { ivPercentile: null });

    const res = await get(SYMBOL);

    expect(res.statusCode).toBe(200);
    expect(res.json().iv).toEqual({
      state: 'percentile_unavailable',
      aggregateIv: '24.80000000',
      ivPercentile: null, // 🚨 MUST NOT 回落成 '0' 或 '0.0000' (FR-014)
      asOf: IV_AS_OF,
      freshnessTier: 'CURRENT',
    });
  });

  it('③ 锚在 + IV 从未采到 → missing 且三值 null, 锚卡照常 200 (区块仍渲染)', async () => {
    await seedAnchor();
    await seedInstrument(); // 标的注册了, 就是没采过 IV

    const res = await get(SYMBOL);

    expect(res.statusCode).toBe(200);
    expect(res.json().iv).toEqual({
      state: 'missing',
      aggregateIv: null,
      ivPercentile: null,
      asOf: null,
      freshnessTier: 'UNAVAILABLE', // 无 asOf 即无从判新鲜度, 不编造
    });
    expect(res.json().anchor.w).toBe(computeW(V).toFixed(4)); // 锚侧不受牵连
  });

  it('④ 无锚 → 404 RFC 9457 ProblemDetail (含机器可读 code) + traceId 端到端', async () => {
    const inst = await seedInstrument();
    await seedIv(inst.id, IV_AS_OF); // 有 IV 也没用 —— 详情的身份是锚 (FR-011)

    const inbound = randomUUID();
    const res = await get(SYMBOL, { 'x-trace-id': inbound });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      instance: `/api/v1/optionsdesk/underlyings/${SYMBOL}`,
      code: ANCHOR_NOT_FOUND_FOR_SYMBOL,
    });
    expect(typeof body.detail).toBe('string');
    // traceId 端到端: 入站头 → CLS → ProblemDetail body → 出站头, 三处同一个值
    expect(body.traceId).toBe(inbound);
    expect(res.headers['x-trace-id']).toBe(inbound);
  });

  it('⑤ 新路由确实挂在鉴权后: 无 token → 401 ProblemDetail (漏 Guard 不会自己红)', async () => {
    await seedAnchor();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/optionsdesk/underlyings/${SYMBOL}`,
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, type: 'about:blank' });
  });
});
