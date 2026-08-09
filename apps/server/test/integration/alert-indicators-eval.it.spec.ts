import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AlertModule } from '../../src/alert/alert.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { EvaluateAlertsUseCase } from '../../src/alert/evaluate-alerts.usecase';
import { ALERT_WORKER_DISABLED } from '../../src/alert/alert-eval.processor';

// 023 T012 全 boot 求值 IT (PR-2) — 经 HTTP 建带参条件 → 真 marketdata 种子 (bar 序列 / 因子 /
// 估值快照 / 交易日历) → moduleRef 直调 EvaluateAlertsUseCase → 流水 + 消息端点回显, 覆盖 spec
// state_branches 求值条:
//  ① 估值直比 (PE_BELOW) 触发含 dataDate + 字段 null (PB 缺失) 不命中, 消息端点渲染 dataDate /
//  ② 估值 staleness 边界 (落后 3 求值 / 落后 4 不命中) /
//  ③ MA 上穿事件日触发 + 次日持续在均线上方不再触发 (事件语义 D6), 消息端点渲染 param /
//  ④ 创 N 日新高 (NEW_HIGH 60, 前复权口径) /
//  ⑤ 除权假信号回归 (分红除权日 forward 口径不假新低/不假下穿, SC-003) /
//  ⑥ warm-up 不足该条件不命中 + 混合预警同轮其余照算 (FR-S06 防御非整轮废) /
//  ⑦ KDJ 超买状态型连两日各触发 (DAILY 不去抖, FR-S10) /
//  ⑧ BOLL 突破上轨事件 /
//  ⑨ 混合新旧条件 AND (021 价格 + 023 估值 全命中才触发; 一项不命中整体否)。
// 021 既有 alert-eval.it.spec.ts 零改动跑绿 = FR-S09 + SC-005 (同跑双文件, 不在本文件内)。
// ALERT_WORKER_DISABLED 置位 → 本进程零后台消费, 评估轮次完全受测试控制。
describe('023 alert 指标求值引擎 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let evaluate: EvaluateAlertsUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'alert-t012-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'alert-t012-hmac-secret-min-32-bytes-zyxwv';
    process.env[ALERT_WORKER_DISABLED] = '1';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([AlertModule]),
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    redis = moduleRef.get(REDIS_CLIENT);
    evaluate = moduleRef.get(EvaluateAlertsUseCase);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    // 评估全局扫描 → 清 alert ctx 表 + push 表隔离 case (marketdata 各 case 用独立 code, 不清);
    // trading_day 是市场级全局表 (staleness count where market='cn', 不靠 instrumentId 隔离) → 每
    // case 前清, 防估值 staleness 用例互相污染。redis flush 隔离建预警限流桶。
    await prisma.pushDelivery.deleteMany();
    await prisma.pushBinding.deleteMany();
    await prisma.alertTrigger.deleteMany();
    await prisma.alert.deleteMany();
    await prisma.alertReadCursor.deleteMany();
    await prisma.tradingDay.deleteMany();
    await redis.flushall();
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613931${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });
  const createBatch = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/alert/alerts', headers: authJson(token), payload });
  const listMessages = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/messages', headers: auth(token) });
  const unreadCount = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/messages/unread-count', headers: auth(token) });

  interface HitView {
    type: string;
    threshold: string | null;
    actual: string;
    param?: number;
    dataDate?: string;
  }
  interface MessageView {
    code: string;
    instrumentName: string;
    tradeDate: string;
    conditions: HitView[];
    unread: boolean;
  }
  const messagesOf = (res: { json: () => unknown }) =>
    (res.json() as { messages: MessageView[] }).messages;

  /** HTTP 建单标的预警 (conditions: {type, param?, threshold?})。 */
  async function createAlert(
    token: string,
    code: string,
    conditions: Record<string, unknown>[],
    frequency = 'DAILY',
  ): Promise<void> {
    const res = await createBatch(token, {
      instruments: [{ market: 'cn', code }],
      conditions,
      frequency,
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
  }

  // ── marketdata 种子 (评估读侧 Q7-B 形状) ────────────────────────────────────
  let codeSeq = 0;
  const nextCode = () => String(700_000 + ++codeSeq);

  interface SeedBar {
    tradeDate: string;
    close: number;
    high?: number;
    low?: number;
    prevClose?: number | null;
    volume?: number | null;
    turnoverRate?: number | null;
  }

  /** instrument + N 根 none bar (升序; high/low 缺省 = close)。 */
  async function seedInstrument(
    bars: SeedBar[],
    name?: string,
  ): Promise<{ code: string; instrumentId: bigint }> {
    const code = nextCode();
    const inst = await prisma.instrument.create({
      data: {
        market: 'cn',
        code,
        name: name ?? `标的-${code}`,
        type: 'stock',
        currency: 'CNY',
        status: 'listed',
      },
    });
    for (const b of bars) {
      await prisma.dailyBar.create({
        data: {
          instrumentId: inst.id,
          tradeDate: new Date(b.tradeDate),
          adjust: 'none',
          open: b.close,
          high: b.high ?? b.close,
          low: b.low ?? b.close,
          close: b.close,
          prevClose: b.prevClose === undefined ? null : b.prevClose,
          volume: b.volume === undefined ? null : b.volume,
          turnoverRate: b.turnoverRate === undefined ? null : b.turnoverRate,
        },
      });
    }
    return { code, instrumentId: inst.id };
  }

  const addBar = (instrumentId: bigint, b: SeedBar) =>
    prisma.dailyBar.create({
      data: {
        instrumentId,
        tradeDate: new Date(b.tradeDate),
        adjust: 'none',
        open: b.close,
        high: b.high ?? b.close,
        low: b.low ?? b.close,
        close: b.close,
        prevClose: b.prevClose === undefined ? null : b.prevClose,
        volume: b.volume === undefined ? null : b.volume,
        turnoverRate: b.turnoverRate === undefined ? null : b.turnoverRate,
      },
    });

  const seedFactor = (instrumentId: bigint, exDate: string, factorBackward: string) =>
    prisma.adjustmentFactor.create({
      data: { instrumentId, exDate: new Date(exDate), factorBackward },
    });

  const seedFundamental = (
    instrumentId: bigint,
    date: string,
    fields: { peTtm?: string; pb?: string; dividendYield?: string; pePctlY3?: string },
  ) =>
    prisma.fundamentalSnapshot.create({ data: { instrumentId, date: new Date(date), ...fields } });

  const seedTradingDays = (dates: string[]) =>
    prisma.tradingDay.createMany({ data: dates.map((d) => ({ market: 'cn', date: new Date(d) })) });

  /** 连续日历日 (周末含, 仅需唯一升序; staleness 用 trading_day 单独控制)。 */
  const dateSeq = (n: number, base = '2026-01-05'): string[] => {
    const out: string[] = [];
    const d = new Date(`${base}T00:00:00Z`);
    for (let i = 0; i < n; i++) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  };

  // ── ① 估值直比触发 (含 dataDate) + 字段 null 不命中; 消息端点渲染 dataDate ───
  it('① PE_BELOW staleness 0 → 触发含 dataDate; PB_BELOW pb null → 不触发; 消息渲染 dataDate', async () => {
    const { token } = await activeToken();
    const { code, instrumentId } = await seedInstrument([{ tradeDate: '2026-04-10', close: 10 }]);
    await seedFundamental(instrumentId, '2026-04-10', { peTtm: '9.8' }); // pb 未设 → null
    await seedTradingDays(['2026-04-10']); // snap.date == tradeDate → staleness 0
    await createAlert(token, code, [{ type: 'PE_BELOW', threshold: 10 }]);
    await createAlert(token, code, [{ type: 'PB_BELOW', threshold: 2 }]); // pb null → 防御不命中

    const summary = await evaluate.execute();
    expect(summary.enabledAlerts).toBe(2);
    expect(summary.triggered).toBe(1);

    const messages = messagesOf(await listMessages(token));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.conditions).toEqual([
      { type: 'PE_BELOW', threshold: '10.0000', actual: '9.8000', dataDate: '2026-04-10' },
    ]);
    expect((await unreadCount(token)).json()).toEqual({ unread: 1 });
  });

  // ── ② 估值 staleness 边界 (落后 3 求值 / 落后 4 不命中) ─────────────────────
  it('② staleness=3 → 触发; staleness=4 → 不触发 (plan D4 ≤3 gate)', async () => {
    const { token } = await activeToken();
    // 共享市场级 trading_day 集
    await seedTradingDays(['2026-04-10', '2026-04-11', '2026-04-14', '2026-04-15']);
    // A: snap 04-10, bar 04-15 → count(gt 04-10, lte 04-15) = {11,14,15} = 3
    const a = await seedInstrument([{ tradeDate: '2026-04-15', close: 10 }], 'staleness3');
    await seedFundamental(a.instrumentId, '2026-04-10', { peTtm: '9' });
    await createAlert(token, a.code, [{ type: 'PE_BELOW', threshold: 10 }]);
    // B: snap 04-09, bar 04-15 → count(gt 04-09, lte 04-15) = {10,11,14,15} = 4
    const b = await seedInstrument([{ tradeDate: '2026-04-15', close: 10 }], 'staleness4');
    await seedFundamental(b.instrumentId, '2026-04-09', { peTtm: '9' });
    await createAlert(token, b.code, [{ type: 'PE_BELOW', threshold: 10 }]);

    const summary = await evaluate.execute();
    expect(summary.triggered).toBe(1);
    const messages = messagesOf(await listMessages(token));
    expect(messages.map((m) => m.instrumentName)).toEqual(['staleness3']);
    expect(messages[0]!.conditions[0]!.dataDate).toBe('2026-04-10');
  });

  // ── ③ MA 上穿事件日触发 + 次日持续在均线上方不再触发; 消息渲染 param ─────────
  it('③ MA_CROSS_UP(5) 事件日触发含 param; 次日仍在均线上方 → 不再触发 (事件语义 D6)', async () => {
    const { token } = await activeToken();
    const d = dateSeq(7);
    // MA5 昨=49/5=9.8 今=51/5=10.2; 昨收 9<9.8 ∧ 今收 12≥10.2 → 上穿 (事件日 = d[5])
    const { code, instrumentId } = await seedInstrument(
      [10, 10, 10, 10, 9, 12].map((c, i) => ({ tradeDate: d[i], close: c })),
    );
    await createAlert(token, code, [{ type: 'MA_CROSS_UP', param: 5 }]);

    const first = await evaluate.execute();
    expect(first.triggered).toBe(1);
    const messages = messagesOf(await listMessages(token));
    expect(messages[0]!.tradeDate).toBe(d[5]);
    expect(messages[0]!.conditions).toEqual([
      { type: 'MA_CROSS_UP', threshold: null, actual: '12.0000', param: 5 },
    ]);

    // 次日 d[6] 收 13 仍在 MA5(=10.8) 上方但非穿越 (昨收 12 > 昨 MA 10.2) → 不再触发
    await addBar(instrumentId, { tradeDate: d[6], close: 13 });
    const second = await evaluate.execute();
    expect(second.triggered).toBe(0);
    expect(await prisma.alertTrigger.count()).toBe(1); // 仅事件日那一条
  });

  // ── ④ 创 N 日新高 (NEW_HIGH 60, 前复权口径) ───────────────────────────────
  it('④ NEW_HIGH(60): 今高 11 > 前 60 日最高 10 → 触发', async () => {
    const { token } = await activeToken();
    const d = dateSeq(61);
    const bars: SeedBar[] = d.map((td, i) => ({ tradeDate: td, close: 10, high: 10, low: 10 }));
    bars[60] = { tradeDate: d[60], close: 11, high: 11, low: 11 }; // 事件日创新高
    const { code } = await seedInstrument(bars);
    await createAlert(token, code, [{ type: 'NEW_HIGH', param: 60 }]);

    const summary = await evaluate.execute();
    expect(summary.triggered).toBe(1);
    const messages = messagesOf(await listMessages(token));
    expect(messages[0]!.conditions).toEqual([
      { type: 'NEW_HIGH', threshold: null, actual: '11.0000', param: 60 },
    ]);
  });

  // ── ⑤ 除权假信号回归 (分红除权日 forward 口径不假新低/不假下穿, SC-003) ───────
  it('⑤ 除权日 none 价跳水但前复权连续 → NEW_LOW(60) / MA_CROSS_DOWN(60) 均不假触发', async () => {
    const { token } = await activeToken();
    const d = dateSeq(61);
    // none: 前 60 日价 10, 除权日(d[60]) 价 8 prevClose 10 (raw 看创新低/下穿);
    // 因子 f=1.25 (exDate=d[60]) → forward 前 60 日 /1.25=8, 今日 8 → 全 8, 连续不产生假信号。
    const bars: SeedBar[] = d
      .slice(0, 60)
      .map((td) => ({ tradeDate: td, close: 10, high: 10, low: 10 }));
    bars.push({ tradeDate: d[60], close: 8, high: 8, low: 8, prevClose: 10 });
    const { code, instrumentId } = await seedInstrument(bars);
    await seedFactor(instrumentId, d[60], '1.25');
    await createAlert(token, code, [{ type: 'NEW_LOW', param: 60 }]);
    await createAlert(token, code, [{ type: 'MA_CROSS_DOWN', param: 60 }]);

    const summary = await evaluate.execute();
    expect(summary.enabledAlerts).toBe(2);
    expect(summary.triggered).toBe(0); // 前复权连续 → 除权日零假触发
  });

  // ── ⑥ warm-up 不足该条件不命中 + 混合预警同轮其余照算 ──────────────────────
  it('⑥ MA_CROSS_UP(250) warm-up 不足不命中 (AND 整体否); 同轮 021 价格预警照常触发', async () => {
    const { token } = await activeToken();
    const d = dateSeq(6);
    // 预警 A: 仅 6 根 → MA250 warm-up 不命中; 即便 AND 内价格条命中, 整体也不触发
    const a = await seedInstrument(
      [10, 10, 10, 10, 9, 12].map((c, i) => ({ tradeDate: d[i], close: c, low: c })),
    );
    await createAlert(token, a.code, [
      { type: 'MA_CROSS_UP', param: 250 },
      { type: 'PRICE_FALL_TO', threshold: 13 }, // low 12 ≤ 13 命中, 但 AND 因 MA250 null 否
    ]);
    // 预警 B: 021 价格基线, 同轮照算
    const b = await seedInstrument([
      { tradeDate: '2026-04-10', close: 14.2, high: 14.5, low: 12.8 },
    ]);
    await createAlert(token, b.code, [{ type: 'PRICE_FALL_TO', threshold: 13 }]);

    const summary = await evaluate.execute();
    expect(summary.enabledAlerts).toBe(2);
    expect(summary.triggered).toBe(1); // 仅 B; warm-up 不命中非整轮废 (FR-S06)
    expect(summary.skippedNoBar).toBe(0); // A 有 bar, 只是 warm-up 不命中 (非跳过)
    const messages = messagesOf(await listMessages(token));
    expect(messages.map((m) => m.code)).toEqual([b.code]);
  });

  // ── ⑦ KDJ 超买状态型连两日各触发 (DAILY 不去抖) ───────────────────────────
  it('⑦ KDJ_OVERBOUGHT (J>100) 状态型 → 连两日各触发 unread=2 (FR-S10)', async () => {
    const { token } = await activeToken();
    const d = dateSeq(13);
    // 单边强势上涨 → RSV 持续 100 → J 稳定 >100 (手算锚定 12 根 J≈104.6 / 13 根 J≈103.4)
    const bars: SeedBar[] = d
      .slice(0, 12)
      .map((td, i) => ({ tradeDate: td, close: 10 + i, high: 10 + i, low: 10 + i }));
    const { code, instrumentId } = await seedInstrument(bars);
    await createAlert(token, code, [{ type: 'KDJ_OVERBOUGHT' }]);

    const first = await evaluate.execute();
    expect(first.triggered).toBe(1);
    const m1 = messagesOf(await listMessages(token));
    expect(m1[0]!.conditions[0]!.type).toBe('KDJ_OVERBOUGHT');
    expect(Number.parseFloat(m1[0]!.conditions[0]!.actual)).toBeGreaterThan(100);

    // 次交易日仍超买 → DAILY 新 tradeDate 再触发 (状态语义每日各判)
    await addBar(instrumentId, { tradeDate: d[12], close: 22, high: 22, low: 22 });
    const second = await evaluate.execute();
    expect(second.triggered).toBe(1);
    expect(await prisma.alertTrigger.count()).toBe(2);
    expect((await unreadCount(token)).json()).toEqual({ unread: 2 });
  });

  // ── ⑧ BOLL 突破上轨事件 ───────────────────────────────────────────────────
  it('⑧ BOLL_BREAK_UPPER: 昨收在轨内 ∧ 今收突破上轨 → 触发 (穿越事件)', async () => {
    const { token } = await activeToken();
    const d = dateSeq(21);
    // 前 20 根 11/9 交替 (band ~[7.9,12.1]), 第 21 根收 20 突破上轨 (手算锚定 t.upper≈15.37)
    const closes: number[] = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 11 : 9));
    closes.push(20);
    const { code } = await seedInstrument(closes.map((c, i) => ({ tradeDate: d[i], close: c })));
    await createAlert(token, code, [{ type: 'BOLL_BREAK_UPPER' }]);

    const summary = await evaluate.execute();
    expect(summary.triggered).toBe(1);
    const messages = messagesOf(await listMessages(token));
    expect(messages[0]!.conditions).toEqual([
      { type: 'BOLL_BREAK_UPPER', threshold: null, actual: '20.0000' },
    ]);
  });

  // ── ⑨ 混合新旧条件 AND (021 价格 + 023 估值) ──────────────────────────────
  it('⑨ 混类 AND (PRICE_FALL_TO + PE_BELOW): 全命中才触发; 估值一项不命中整体否', async () => {
    const { token } = await activeToken();
    await seedTradingDays(['2026-04-10']);
    // 命中: low 12.8 ≤ 13 ∧ PE 9.8 ≤ 10 (staleness 0)
    const hit = await seedInstrument(
      [{ tradeDate: '2026-04-10', close: 14.2, high: 14.5, low: 12.8 }],
      '混类命中',
    );
    await seedFundamental(hit.instrumentId, '2026-04-10', { peTtm: '9.8' });
    await createAlert(token, hit.code, [
      { type: 'PRICE_FALL_TO', threshold: 13 },
      { type: 'PE_BELOW', threshold: 10 },
    ]);
    // 不命中: 价格命中但 PE 12 > 10 → AND 否
    const miss = await seedInstrument(
      [{ tradeDate: '2026-04-10', close: 14.2, high: 14.5, low: 12.8 }],
      '混类不命中',
    );
    await seedFundamental(miss.instrumentId, '2026-04-10', { peTtm: '12' });
    await createAlert(token, miss.code, [
      { type: 'PRICE_FALL_TO', threshold: 13 },
      { type: 'PE_BELOW', threshold: 10 },
    ]);

    const summary = await evaluate.execute();
    expect(summary.enabledAlerts).toBe(2);
    expect(summary.triggered).toBe(1);
    const messages = messagesOf(await listMessages(token));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.instrumentName).toBe('混类命中');
    // 021 价格条 (param 0 / 无 dataDate) 与 023 估值条 (含 dataDate) 同快照共存, 输入序保持
    expect(messages[0]!.conditions).toEqual([
      { type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' },
      { type: 'PE_BELOW', threshold: '10.0000', actual: '9.8000', dataDate: '2026-04-10' },
    ]);
  });
});
