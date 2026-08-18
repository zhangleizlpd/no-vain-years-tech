import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppModule } from '../../src/app/app.module';
import { PrismaService } from '../../src/security/prisma.service';
import { ALERT_WORKER_DISABLED } from '../../src/alert/alert-eval.processor';
import { ALERT_QUEUE_REDIS } from '../../src/alert/alert-queue-connection';
import { EvaluateAlertsUseCase } from '../../src/alert/evaluate-alerts.usecase';
import {
  IntradayEvalProcessor,
  INTRADAY_CIRCUIT_KEY,
  INTRADAY_FAILSTREAK_KEY,
  CIRCUIT_THRESHOLD,
} from '../../src/alert/intraday-eval.processor';
import { REALTIME_QUOTE_PORT, type RealtimeQuotePort } from '../../src/alert/realtime-quote.port';
import { toVendorSymbol, type RealtimeQuote } from '../../src/alert/realtime-quote.rules';

// 024 T011 全 boot 引擎 IT — 覆盖 spec `state_branches` 全 8 条 + SC-005 perf 断言。
// 实时源经 overrideProvider 注入可控 mock (calls/shouldFail/quotes), 无真实外网请求
// (真实源 IT 归 T012 RUN_PERF_IT)。求值经 IntradayEvalProcessor.process(注入时钟) 直驱
// — 这是交易时段 gate / trading_day 节假日 gate / 熔断三段的真实集成点; 命中/未命中/判重/
// 首 tick/缺数据走时段内 tick。盘中→EOD 判重经 EvaluateAlertsUseCase (021 EOD 入口) 验跨轮幂等。
// ALERT_WORKER_DISABLED → 零后台消费, 求值轮次完全受测试控制。
// beforeEach: 清 alert ctx + marketdata 种子表 + flushdb (failstreak/circuit/lasttick 跨 case
// 残留会污染熔断/差分断言) + 重置 mock。
describe('024 alert 盘中实时求值引擎 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let processor: IntradayEvalProcessor;
  let evaluateEod: EvaluateAlertsUseCase;
  let seq = 0;

  // ── 可控实时源 mock (override REALTIME_QUOTE_PORT) ──────────────────────────
  const realtimePort = {
    calls: 0,
    // `as boolean` 抵消 satisfies 对字面量的窄化 (satisfies 不做 widening, 否则后文赋 true 报 TS2322)。
    shouldFail: false as boolean,
    quotes: new Map<string, RealtimeQuote>(),
    async fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>> {
      this.calls += 1;
      if (this.shouldFail) throw new Error('mock realtime source down');
      const out = new Map<string, RealtimeQuote>();
      for (const s of symbols) {
        const q = this.quotes.get(s);
        if (q !== undefined) out.set(s, q);
      }
      return out;
    },
  } satisfies RealtimeQuotePort & {
    calls: number;
    shouldFail: boolean;
    quotes: Map<string, RealtimeQuote>;
  };

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'alert-t011-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'alert-t011-hmac-secret-min-32-bytes-zyxwv';
    process.env[ALERT_WORKER_DISABLED] = '1';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(REALTIME_QUOTE_PORT)
      .useValue(realtimePort)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get<Redis>(ALERT_QUEUE_REDIS);
    processor = moduleRef.get(IntradayEvalProcessor);
    evaluateEod = moduleRef.get(EvaluateAlertsUseCase);
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
    await prisma.dailyBar.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.tradingDay.deleteMany();
    await prisma.calendarCoverage.deleteMany();
    await redis.flushdb(); // 清 failstreak / circuit / lasttick 跨 case 残留
    realtimePort.calls = 0;
    realtimePort.shouldFail = false;
    realtimePort.quotes.clear();
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const TRADE_DATE = '2026-06-09';
  /** 上海当日 10:00 (= UTC 02:00), 落在上午连续竞价 [09:30,11:30] → 时段内 tick。 */
  const tradingNow = new Date('2026-06-09T02:00:00Z');
  /** 上海当日 12:00 (= UTC 04:00), 午休 (11:30,13:00) → 非交易时段。 */
  const lunchNow = new Date('2026-06-09T04:00:00Z');
  const lasttickKey = (date: string) => `alert:intraday:lasttick:${date}`;

  const nextPhone = () => `+8613915${String(++seq).padStart(6, '0')}`;
  const seedAccount = () =>
    prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
  const seedTradingDay = (date = TRADE_DATE) =>
    prisma.tradingDay.create({ data: { market: 'cn', date: new Date(date) } });
  /**
   * 062 T007 起「无 `trading_day` 行」只有配上覆盖声明才等于「非交易日」—— 声明缺席给的是
   * 「未知」(闸放行)。故断言 `skipped-holiday` 的用例必须显式说出「这一段已经填过了」。
   */
  const seedCoverage = (from = '2026-05-01', to = '2026-06-30') =>
    prisma.calendarCoverage.create({
      data: {
        market: 'cn',
        coveredFrom: new Date(from),
        coveredTo: new Date(to),
        servedBy: 'it-seed',
      },
    });

  /** 喂一条实时报价到 mock (按 vendor 符号索引, changePct 当日口径无关本轮断言置 0)。 */
  function setQuote(code: string, price: number, prevClose = price, name = `名_${code}`): void {
    const symbol = toVendorSymbol('cn', code);
    realtimePort.quotes.set(symbol, { symbol, name, price, prevClose, changePct: 0 });
  }

  interface CondSeed {
    type: string;
    threshold?: number | null;
    param?: number;
  }
  async function seedAlert(
    accountId: bigint,
    code: string,
    conditions: CondSeed[],
    opts: { frequency?: string; enabled?: boolean } = {},
  ) {
    return prisma.alert.create({
      data: {
        accountId,
        market: 'cn',
        code,
        frequency: opts.frequency ?? 'DAILY',
        enabled: opts.enabled ?? true,
        conditions: {
          create: conditions.map((c) => ({
            type: c.type,
            param: c.param ?? 0,
            threshold: c.threshold ?? null,
          })),
        },
      },
      include: { conditions: true },
    });
  }

  /** marketdata none-口径 bar (EOD 求值上下文; 盘中→EOD 判重 case 用)。 */
  async function seedNoneBar(
    code: string,
    name: string,
    bar: { high: number; low: number; close: number; prevClose: number },
    tradeDate = TRADE_DATE,
  ) {
    const inst = await prisma.instrument.create({
      data: { market: 'cn', code, name, type: 'stock', currency: 'CNY', status: 'active' },
    });
    await prisma.dailyBar.create({
      data: {
        instrumentId: inst.id,
        tradeDate: new Date(tradeDate),
        adjust: 'none',
        open: bar.prevClose,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        prevClose: bar.prevClose,
      },
    });
  }

  // ── ① 交易时段内 tick + 命中阈值 → 盘中触发 + 推送(022) ────────────────────
  it('① 时段内实时价 ≥ 涨到阈 → 触发 (priceContext intraday) + push fan-out PENDING', async () => {
    const acc = await seedAccount();
    await seedTradingDay();
    await seedAlert(acc.id, '600001', [{ type: 'PRICE_RISE_TO', threshold: 10 }]);
    await prisma.pushBinding.create({
      data: { accountId: acc.id, registrationId: `reg-${acc.id}`, platform: 'android' },
    });
    setQuote('600001', 10.5, 10.0, '触发标的');

    const outcome = await processor.process(tradingNow);
    expect(outcome).toMatchObject({ status: 'evaluated' });
    if (outcome.status !== 'evaluated') throw new Error('unreachable');
    expect(outcome.summary).toMatchObject({ fetched: 1, triggered: 1, skippedDuplicate: 0 });

    const triggers = await prisma.alertTrigger.findMany({ where: { accountId: acc.id } });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.instrumentName).toBe('触发标的');
    const snapshot = triggers[0]!.conditionsSnapshot as Array<Record<string, unknown>>;
    expect(snapshot[0]).toMatchObject({ type: 'PRICE_RISE_TO', priceContext: 'intraday' });

    // 022 push fan-out: 每绑定一行 PENDING (同 tx 落库)
    const deliveries = await prisma.pushDelivery.findMany({ where: { accountId: acc.id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'PENDING', registrationId: `reg-${acc.id}` });
  });

  // ── ② 时段内 tick + 未命中 → 不触发, 记录本 tick 快照 ──────────────────────
  it('② 实时价 < 涨到阈 → 零触发; 本 tick 报价写入上一 tick 快照 (供下一 tick 差分)', async () => {
    const acc = await seedAccount();
    await seedTradingDay();
    await seedAlert(acc.id, '600002', [{ type: 'PRICE_RISE_TO', threshold: 100 }]);
    setQuote('600002', 12.34, 12.0);

    const outcome = await processor.process(tradingNow);
    expect(outcome).toMatchObject({ status: 'evaluated' });
    if (outcome.status !== 'evaluated') throw new Error('unreachable');
    expect(outcome.summary.triggered).toBe(0);
    expect(await prisma.alertTrigger.count({ where: { accountId: acc.id } })).toBe(0);

    // 快照已记 (plan D4): hash field=vendor 符号, value=现价串
    const snap = await redis.hget(lasttickKey(TRADE_DATE), toVendorSymbol('cn', '600002'));
    expect(snap).toBe('12.34');
  });

  // ── ③a 非交易时段 (午休) tick → 空转 return, 0 源调用 ──────────────────────
  it('③a 午休 tick → skipped-session, 不拉源 (mock calls=0) 不求值', async () => {
    const acc = await seedAccount();
    await seedTradingDay();
    await seedAlert(acc.id, '600003', [{ type: 'PRICE_RISE_TO', threshold: 1 }]);
    setQuote('600003', 999); // 即便会命中, 非时段也不应触达

    const outcome = await processor.process(lunchNow);
    expect(outcome).toEqual({ status: 'skipped-session' });
    expect(realtimePort.calls).toBe(0);
    expect(await prisma.alertTrigger.count({ where: { accountId: acc.id } })).toBe(0);
  });

  // ── ③b 节假日 (非交易日) tick → 空转 return, 0 源调用 ──────────────────────
  it('③b 时段内但当日非 cn 交易日 (无 trading_day 行) → skipped-holiday, 0 源调用', async () => {
    const acc = await seedAccount();
    // 不 seed trading_day, 但 seed 覆盖声明 → 「填过了, 当日确实不是交易日」(而非「还没填到」)
    await seedCoverage();
    await seedAlert(acc.id, '600004', [{ type: 'PRICE_RISE_TO', threshold: 1 }]);
    setQuote('600004', 999);

    const outcome = await processor.process(tradingNow);
    expect(outcome).toEqual({ status: 'skipped-holiday' });
    expect(realtimePort.calls).toBe(0);
    expect(await prisma.alertTrigger.count({ where: { accountId: acc.id } })).toBe(0);
  });

  // ── ④ 盘中已触发 → 当日 EOD 评估幂等 skip (共用 (alertId, tradeDate) 判重) ────
  it('④ 盘中触发后, 当日 EOD 轮命中同条件 → P2002 skippedDuplicate, 不重复触发/推送', async () => {
    const acc = await seedAccount();
    await seedTradingDay();
    const alert = await seedAlert(acc.id, '600005', [{ type: 'PRICE_RISE_TO', threshold: 10 }]);
    // EOD 上下文: 同标的同 tradeDate none-bar, high 也越阈 → EOD 同样会判命中
    await seedNoneBar('600005', 'EOD 标的', { high: 11, low: 9.5, close: 10.8, prevClose: 9.8 });
    setQuote('600005', 10.5, 9.8);

    // 盘中先触发
    const intraday = await processor.process(tradingNow);
    if (intraday.status !== 'evaluated') throw new Error('unreachable');
    expect(intraday.summary.triggered).toBe(1);
    expect(await prisma.alertTrigger.count({ where: { alertId: alert.id } })).toBe(1);

    // 当日 EOD 轮: 命中但撞唯一键 → 幂等 skip, 零新增
    const eod = await evaluateEod.execute();
    expect(eod).toMatchObject({ enabledAlerts: 1, triggered: 0, skippedDuplicate: 1 });
    expect(await prisma.alertTrigger.count({ where: { alertId: alert.id } })).toBe(1);
  });

  // ── ⑤ 实时源连续 3 tick 失败 → 熔断 open, 降级 EOD-only, 预警不丢 ───────────
  it('⑤ 源连续 3 tick 全断 → circuit open + failstreak=3; 预警仍在 (EOD 兜底不丢)', async () => {
    const acc = await seedAccount();
    await seedTradingDay();
    const alert = await seedAlert(acc.id, '600006', [{ type: 'PRICE_RISE_TO', threshold: 10 }]);
    realtimePort.shouldFail = true;

    for (let i = 0; i < CIRCUIT_THRESHOLD; i += 1) {
      const outcome = await processor.process(tradingNow);
      expect(outcome).toEqual({ status: 'source-failed', calendar: 'confirmed' });
    }

    expect(await redis.get(INTRADAY_FAILSTREAK_KEY)).toBe(String(CIRCUIT_THRESHOLD));
    expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBe('open');
    // 预警不丢: alert 仍启用在库, 当日 EOD 轮可兜底
    const survived = await prisma.alert.findUnique({ where: { id: alert.id } });
    expect(survived?.enabled).toBe(true);
  });

  // ── ⑥ 熔断后源恢复 → 自动回升盘中口径 (circuit close + failstreak reset) ─────
  it('⑥ open 后单 tick 源成功 → circuit closed + failstreak 归 0 (半开探测自动回升)', async () => {
    const acc = await seedAccount();
    await seedTradingDay();
    await seedAlert(acc.id, '600007', [{ type: 'PRICE_RISE_TO', threshold: 100 }]);

    // 先打到 open
    realtimePort.shouldFail = true;
    for (let i = 0; i < CIRCUIT_THRESHOLD; i += 1) await processor.process(tradingNow);
    expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBe('open');

    // 源恢复: 下一 tick 取价成功 (未命中无妨, 关键是不抛)
    realtimePort.shouldFail = false;
    setQuote('600007', 12.0);
    const outcome = await processor.process(tradingNow);
    expect(outcome).toMatchObject({ status: 'evaluated' });
    expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBe('closed');
    expect(await redis.get(INTRADAY_FAILSTREAK_KEY)).toBe('0');
  });

  // ── ⑦ 首 tick 无快照 → 差分类跳过; 次 tick 起正常 ─────────────────────────
  it('⑦ 5min 涨超: 首 tick (无上一快照) 不误触发 → 次 tick 达阈触发', async () => {
    const acc = await seedAccount();
    await seedTradingDay();
    const alert = await seedAlert(acc.id, '600008', [
      { type: 'PRICE_RISE_5MIN_OVER', threshold: 2 },
    ]);

    // 首 tick: 仅建立快照, 无上一 tick 基准 → 差分类跳过
    setQuote('600008', 10.0, 10.0);
    const first = await processor.process(tradingNow);
    if (first.status !== 'evaluated') throw new Error('unreachable');
    expect(first.summary.triggered).toBe(0);
    expect(await prisma.alertTrigger.count({ where: { alertId: alert.id } })).toBe(0);

    // 次 tick: 10.0 → 10.5 = +5% ≥ 2% → 触发
    setQuote('600008', 10.5, 10.0);
    const second = await processor.process(tradingNow);
    if (second.status !== 'evaluated') throw new Error('unreachable');
    expect(second.summary.triggered).toBe(1);
    expect(await prisma.alertTrigger.count({ where: { alertId: alert.id } })).toBe(1);
  });

  // ── ⑧ 实时价缺失 (停牌/源未返该标的) → 该标的本 tick 不命中 ────────────────
  it('⑧ 源未返该标的报价 → skippedNoData, 零触发 (与 021 数据缺失不命中一致)', async () => {
    const acc = await seedAccount();
    await seedTradingDay();
    await seedAlert(acc.id, '600009', [{ type: 'PRICE_RISE_TO', threshold: 1 }]);
    // mock 不喂 600009 报价 → fetchQuotes 返回空 Map

    const outcome = await processor.process(tradingNow);
    if (outcome.status !== 'evaluated') throw new Error('unreachable');
    expect(outcome.summary).toMatchObject({ fetched: 1, triggered: 0, skippedNoData: 1 });
    expect(await prisma.alertTrigger.count({ where: { accountId: acc.id } })).toBe(0);
  });

  // ── SC-005 perf: 百级标的单 tick 端到端 (拉取 mock + 派生 + 求值 + 触发派发) < 30s ──
  // env-gated 默认 skip (RUN_PERF_IT); 本地/nightly 显式启用 (memory perf-IT 范式)。
  const PERF = process.env.RUN_PERF_IT === '1' || process.env.RUN_PERF_IT === 'true';
  describe.skipIf(!PERF)('SC-005 perf (RUN_PERF_IT)', () => {
    it('~200 启用预警标的单 tick 端到端 < 30s', async () => {
      // 🚨 rep 数**不继承 `PERF_IT_REPS`**。那个 knob 是 auth P95 的「单端点采样数」，
      // nightly 设 300；而本测试一个 rep = 完整 tick（200 标的求值 + 触发派发 + DB 收尾），
      // 300 个完整 tick 在 4vCPU runner 上必超 120s timeout —— 本 spec 2026-06-09 合入后
      // nightly-perf **一次都没绿过**（06-08 最后绿 → 55 天连红）就是这一行错用 knob。
      // 独立 knob `PERF_TICK_REPS` 默认 1：预算断言（单 tick < 30s）一个 rep 就成立。
      const reps = Number(process.env.PERF_TICK_REPS ?? 1);
      const acc = await seedAccount();
      const N = 200;
      for (let i = 0; i < N; i += 1) {
        const code = `6001${String(i).padStart(2, '0')}`; // 600100..600299, 全 sh
        await seedAlert(acc.id, code, [{ type: 'PRICE_RISE_TO', threshold: 10 }]);
        setQuote(code, 10.5, 10.0); // 全部命中 → 触发派发满载
      }

      let maxMs = 0;
      for (let r = 0; r < reps; r += 1) {
        // 每 rep 用不同 tradeDate (避免唯一键 dup, 度量完整触发派发路径)
        const repNow = new Date(tradingNow.getTime() + r * 24 * 60 * 60 * 1000);
        const { dateOnly } = {
          dateOnly: new Date(repNow.getTime() + 8 * 3600_000).toISOString().slice(0, 10),
        };
        await seedTradingDay(dateOnly);
        await prisma.alertTrigger.deleteMany();
        const start = performance.now();
        const outcome = await processor.process(repNow);
        const elapsed = performance.now() - start;
        if (outcome.status !== 'evaluated') throw new Error('unreachable');
        expect(outcome.summary.triggered).toBe(N);
        maxMs = Math.max(maxMs, elapsed);
      }
      // eslint-disable-next-line no-console
      console.log(`[SC-005] ~${N} 标的单 tick 最慢 ${maxMs.toFixed(0)}ms (reps=${reps})`);
      expect(maxMs).toBeLessThan(30_000);
    }, 120_000);
  });
});
