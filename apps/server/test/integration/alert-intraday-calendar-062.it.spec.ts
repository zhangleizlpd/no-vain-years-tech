import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { setupIsolatedStores } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { AlertModule } from '../../src/alert/alert.module';
import { PrismaService } from '../../src/security/prisma.service';
import { ALERT_WORKER_DISABLED } from '../../src/alert/alert-eval.processor';
import { ALERT_QUEUE_REDIS } from '../../src/alert/alert-queue-connection';
import { IntradayEvalProcessor, INTRADAY_MARKET } from '../../src/alert/intraday-eval.processor';
import { REALTIME_QUOTE_PORT, type RealtimeQuotePort } from '../../src/alert/realtime-quote.port';
import { toVendorSymbol, type RealtimeQuote } from '../../src/alert/realtime-quote.rules';

/**
 * 062 T007 —— alert 盘中闸接三态（US1 · FR-012 / FR-013 / FR-015 / FR-019 · SC-001 ·
 * spec `state_branch` 5）。
 *
 * ## 这条 IT 复刻的是一个**生产上已经发生、且界面毫无异常**的静默失效
 *
 * 2026-08-18 实测：交易时段内 43 拍**全部**返回 `{"status":"skipped-holiday"}` —— 盘中预警
 * 从未被求值过。病根不在 alert：`trading_day` 每日 21:00 才填到「今天」，而盘中闸在 09:30
 * 就问「今天有没有行」，读到的「没有」被当成「今天不是交易日」（closed-world assumption）。
 *
 * ## 为什么必须真 PG + 真 Redis + 真 DI 容器
 *
 * - **真 PG**：被测面是「两张 `@db.Date` 表的实际内容 → 三态 → 闸的开合」。判据按**日期边界**
 *   分档，mock prisma 只能证明「代码调了某个方法」，证不了「昨天」与「今天」在库里落成什么、
 *   比较出来是 `non-trading` 还是 `unknown` —— 而这正是本 feature 要消灭的那类差一天的静默失真。
 * - **真 Redis**：`IntradayEvalProcessor` 的熔断计数与求值 UC 的判重水位线都在 Redis 上，
 *   假 client 会把「求值真的跑起来了」这件事变成不可证。
 * - **真 DI 容器**（`Test.createTestingModule({ imports: [AlertModule] })`，plan Architecture
 *   Notes 的 Testing Invariants 第二条）：processor 挂在 NestJS lifecycle 上，
 *   `new IntradayEvalProcessor(...)` 的隔离单测抹掉的正是「接线接错」这一类信号。
 *
 * 实时源经 `overrideProvider(REALTIME_QUOTE_PORT)` 换成可控替身 —— 本文件断言的是**闸的开合**
 * （`calls` 是「求值真的发生了」的硬证据），不打真外网。
 */
describe('062 T007 alert 盘中交易日闸三态 (Testcontainers PG + Redis, 真 AlertModule DI 容器)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let redis: Redis;
  let processor: IntradayEvalProcessor;
  let seq = 0;

  /** 可控实时源：`calls` = 「求值真的发生了」的硬证据（闸挡下则恒 0）。 */
  const realtimePort = {
    calls: 0,
    quotes: new Map<string, RealtimeQuote>(),
    async fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>> {
      this.calls += 1;
      const out = new Map<string, RealtimeQuote>();
      for (const s of symbols) {
        const q = this.quotes.get(s);
        if (q !== undefined) out.set(s, q);
      }
      return out;
    },
  } satisfies RealtimeQuotePort & { calls: number; quotes: Map<string, RealtimeQuote> };

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'alert-062-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'alert-062-hmac-secret-min-32-bytes-zyxwv';
    process.env[ALERT_WORKER_DISABLED] = '1';

    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([AlertModule]) })
      .overrideProvider(REALTIME_QUOTE_PORT)
      .useValue(realtimePort)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get<Redis>(ALERT_QUEUE_REDIS);
    processor = moduleRef.get(IntradayEvalProcessor);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await prisma.alertTrigger.deleteMany();
    await prisma.pushDelivery.deleteMany();
    await prisma.pushBinding.deleteMany();
    await prisma.alert.deleteMany(); // cascade conditions
    await prisma.alertReadCursor.deleteMany();
    await prisma.tradingDay.deleteMany();
    await prisma.calendarCoverage.deleteMany();
    await redis.flushdb();
    realtimePort.calls = 0;
    realtimePort.quotes.clear();
  });

  // ── 时钟与日期（上海时区口径；FR-015：「今天」按交易所时区求） ────────────────
  /** 上海 2026-06-09（周二）10:00 = UTC 02:00 → 上午连续竞价内。 */
  const IN_SESSION = new Date('2026-06-09T02:00:00Z');
  /** 上海同日 12:00 = UTC 04:00 → 午休（时段闸的地盘，与日历闸无关）。 */
  const LUNCH_BREAK = new Date('2026-06-09T04:00:00Z');
  const TODAY = '2026-06-09';
  const YESTERDAY = '2026-06-08';

  const nextPhone = () => `+8613916${String(++seq).padStart(6, '0')}`;
  const seedAccount = () =>
    prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });

  const seedTradingDay = (date: string) =>
    prisma.tradingDay.create({
      data: { market: INTRADAY_MARKET, date: new Date(`${date}T00:00:00.000Z`) },
    });

  const seedCoverage = (from: string, to: string) =>
    prisma.calendarCoverage.create({
      data: {
        market: INTRADAY_MARKET,
        coveredFrom: new Date(`${from}T00:00:00.000Z`),
        coveredTo: new Date(`${to}T00:00:00.000Z`),
        servedBy: 'it-seed',
      },
    });

  /** 一条会命中的盘中预警 + 一条能让它命中的报价 → 求值一旦发生就必然外呼一次。 */
  async function seedAlertWithQuote(code: string): Promise<void> {
    const acc = await seedAccount();
    await prisma.alert.create({
      data: {
        accountId: acc.id,
        market: INTRADAY_MARKET,
        code,
        frequency: 'DAILY',
        enabled: true,
        conditions: { create: [{ type: 'PRICE_RISE_TO', param: 0, threshold: 10 }] },
      },
    });
    const symbol = toVendorSymbol(INTRADAY_MARKET, code);
    realtimePort.quotes.set(symbol, {
      symbol,
      name: `名_${code}`,
      price: 10.5,
      prevClose: 10,
      changePct: 0,
    });
  }

  // ── ① 病根回归：视野只到昨天 ⇒ 今天必须照跑（state_branch 5, SC-001） ────────

  /**
   * 🚨🚨 **本文件最要紧的一条**，也是生产上那 43/43 `skipped-holiday` 的精确复刻。
   *
   * 埋法必须是「`trading_day` 只到**昨天** + `calendar_coverage` 只覆盖到**昨天**」：今天
   * 无行、且今天落在覆盖区间**之外** ⇒ 三态判 `unknown` ⇒ 「还没填到这儿」而不是「填过了确实
   * 不是交易日」⇒ 盘中闸必须放行。
   *
   * ⚠️ 若把日历埋成「含今天」，这条会绿，但什么都没验到（Impl Guardrail 14）。
   */
  it('① 🚨 trading_day 只到昨天 + coverage 只覆盖到昨天 + 连续竞价 → 求值真的发生 (unknown 放行)', async () => {
    await seedTradingDay(YESTERDAY);
    await seedCoverage('2026-05-10', YESTERDAY);
    await seedAlertWithQuote('600601');

    const outcome = await processor.process(IN_SESSION);

    expect(outcome).toMatchObject({ status: 'evaluated', calendar: 'unknown' });
    expect(realtimePort.calls).toBe(1); // 闸真放行了 —— 不是「日志没报错」那种软证据
    if (outcome.status !== 'evaluated') throw new Error('unreachable');
    expect(outcome.summary.fetched).toBe(1);
  });

  // ── ② 确认是交易日才跑 —— 与 ① 的留痕必须可分辨（FR-013） ────────────────────

  it('② 今天在库 + coverage 含今天 → 求值发生, 且留痕标为「已确认」(FR-013 与 ① 可分辨)', async () => {
    await seedTradingDay(TODAY);
    await seedCoverage('2026-05-10', TODAY);
    await seedAlertWithQuote('600602');

    const outcome = await processor.process(IN_SESSION);

    expect(outcome).toMatchObject({ status: 'evaluated', calendar: 'confirmed' });
    expect(realtimePort.calls).toBe(1);
  });

  /**
   * 🚨 **FR-013 的本体断言**：①②「都跑了」不足以验收 —— 要的是事后**分得出**为什么跑。
   * 两个 outcome 若长得一样，下次同类故障照样查不出，等于没修。
   */
  it('②b 🚨 FR-013: 「因为不知道而跑」与「确认交易日才跑」两个 outcome MUST NOT 相同', async () => {
    await seedTradingDay(YESTERDAY);
    await seedCoverage('2026-05-10', YESTERDAY);
    await seedAlertWithQuote('600603');
    const unknownRun = await processor.process(IN_SESSION);

    await prisma.tradingDay.deleteMany();
    await prisma.calendarCoverage.deleteMany();
    realtimePort.calls = 0;
    await seedTradingDay(TODAY);
    await seedCoverage('2026-05-10', TODAY);
    const confirmedRun = await processor.process(IN_SESSION);

    expect(unknownRun.status).toBe('evaluated');
    expect(confirmedRun.status).toBe('evaluated');
    const basisOf = (o: unknown) => (o as { calendar?: unknown }).calendar;
    expect(basisOf(unknownRun)).not.toBe(basisOf(confirmedRun));
  });

  // ── ③ 真节假日一侧没被削弱（state_branch 2） ────────────────────────────────

  it('③ 今天不在库但 coverage 含今天 → skipped-holiday, 0 次外呼 (non-trading 语义不回归)', async () => {
    await seedTradingDay(YESTERDAY);
    await seedCoverage('2026-05-10', '2026-06-30'); // 已填过这一整段, 今天确实不是交易日
    await seedAlertWithQuote('600604');

    const outcome = await processor.process(IN_SESSION);

    expect(outcome).toEqual({ status: 'skipped-holiday' });
    expect(realtimePort.calls).toBe(0);
  });

  // ── ④ 时段闸与日历闸是两个独立的闸 ──────────────────────────────────────────

  it('④ 时钟停在午休 → skipped-session (与日历判定无关, 日历再充分也不跑)', async () => {
    await seedTradingDay(TODAY);
    await seedCoverage('2026-05-10', TODAY);
    await seedAlertWithQuote('600605');

    const outcome = await processor.process(LUNCH_BREAK);

    expect(outcome).toEqual({ status: 'skipped-session' });
    expect(realtimePort.calls).toBe(0);
  });
});
