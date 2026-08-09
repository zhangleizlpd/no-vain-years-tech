import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AlertModule } from '../../src/alert/alert.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { EvaluateAlertsUseCase } from '../../src/alert/evaluate-alerts.usecase';
import { ALERT_WORKER_DISABLED } from '../../src/alert/alert-eval.processor';

// 021 T013 全 boot 引擎 IT — 覆盖 spec state_branches 评估侧全条 (配置侧归 T007):
//  ①「股价跌到13 当日低12.8 收14.2」触发 (盘中极值口径, D7 low≤t) → 流水快照含 actual
//    → EP6 消息可见 + EP7 unread+1 — 种子带同标的更新 hfq 毒丸 bar, 反证引擎锁 none 口径 (D8) /
//  ② 双条件 AND 一项不命中 → 整体不触发零流水 / ③ ONCE_DELETE → 预警消失·流水自立消息仍达 /
//  ④ DAILY 同 tradeDate 重跑幂等零新增 (skippedDuplicate), 新 tradeDate bar 落库再触发 /
//  ⑤ 停用 (enabled=false) 不评估。
// 评估经 moduleRef 直调 EvaluateAlertsUseCase (queue/cron 注册面归 T012 单测; CLI dogfood 归
// T014); ALERT_WORKER_DISABLED 置位 → 本进程零后台消费, 评估轮次完全受测试控制。
// beforeEach 清 alert 三表 — 评估是全局扫描 (无 account 入参), 跨 case 残留会污染 summary。
describe('021 alert EOD 评估引擎 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let evaluate: EvaluateAlertsUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'alert-t013-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'alert-t013-hmac-secret-min-32-bytes-zyxwv';
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
    evaluate = moduleRef.get(EvaluateAlertsUseCase);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    // 评估全局扫描 → 清 alert ctx 三表隔离 case (marketdata 种子按 case 各用独立 code, 不清)
    await prisma.alertTrigger.deleteMany();
    await prisma.alert.deleteMany();
    await prisma.alertReadCursor.deleteMany();
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613914${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  /** marketdata 种子: instrument + none 口径 bar (Q7-B 读侧形状)。 */
  const seedInstrument = (code: string, name: string) =>
    prisma.instrument.create({
      data: { market: 'cn', code, name, type: 'stock', currency: 'CNY', status: 'active' },
    });
  const seedBar = (
    instrumentId: bigint,
    tradeDate: string,
    bar: { high: number; low: number; close: number; prevClose: number | null },
    adjust = 'none',
  ) =>
    prisma.dailyBar.create({
      data: {
        instrumentId,
        tradeDate: new Date(tradeDate),
        adjust,
        open: bar.prevClose ?? bar.close,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        prevClose: bar.prevClose,
      },
    });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });
  const createBatch = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/alert/alerts', headers: authJson(token), payload });
  const patchAlert = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/alert/alerts/${id}`,
      headers: authJson(token),
      payload,
    });
  const listAll = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/alerts', headers: auth(token) });
  const listMessages = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/messages', headers: auth(token) });
  const unreadCount = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/messages/unread-count', headers: auth(token) });

  interface AlertView {
    id: string;
    code: string;
    enabled: boolean;
  }
  interface MessageView {
    code: string;
    instrumentName: string;
    tradeDate: string;
    conditions: Array<{ type: string; threshold: string; actual: string }>;
    unread: boolean;
  }
  const alertsOf = (res: { json: () => unknown }) => (res.json() as { alerts: AlertView[] }).alerts;
  const messagesOf = (res: { json: () => unknown }) =>
    (res.json() as { messages: MessageView[] }).messages;

  /** 建单标的预警 (默认 PRICE_FALL_TO 13)。 */
  async function createAlert(
    token: string,
    code: string,
    opts: {
      conditions?: Array<{ type: string; threshold: number }>;
      frequency?: string;
    } = {},
  ): Promise<AlertView> {
    const res = await createBatch(token, {
      instruments: [{ market: 'cn', code }],
      conditions: opts.conditions ?? [{ type: 'PRICE_FALL_TO', threshold: 13 }],
      frequency: opts.frequency ?? 'DAILY',
    });
    expect(res.statusCode).toBe(201);
    return alertsOf(res)[0]!;
  }

  // ── ①「股价跌到13」当日低 12.8 收 14.2 → 触发 (盘中极值) + 消息可见 ──────
  it('① 盘中低 12.8 ≤ 阈 13 (收盘 14.2 已回升) → 触发; 流水快照含 actual; EP6/EP7 可见; 引擎锁 none 口径', async () => {
    const { id, token } = await activeToken();
    const inst = await seedInstrument('603305', '旭升集团');
    await seedBar(inst.id, '2026-06-05', { high: 14.5, low: 12.8, close: 14.2, prevClose: 14.0 });
    // 毒丸: 同标的更新 tradeDate 的 hfq 行 (low 远高于阈值) — 引擎若漏 adjust 过滤
    // 会按 tradeDate desc 取到它 → 不触发 → 本 case 红
    await seedBar(
      inst.id,
      '2026-06-06',
      { high: 99_999, low: 88_888, close: 99_999, prevClose: 88_888 },
      'hfq',
    );
    await createAlert(token, '603305');

    const summary = await evaluate.execute();
    expect(summary).toEqual({
      enabledAlerts: 1,
      triggered: 1,
      skippedNoBar: 0,
      skippedDuplicate: 0,
    });

    // 流水: 快照含 threshold + actual (= 当日 low, 盘中极值口径)
    const triggers = await prisma.alertTrigger.findMany({ where: { accountId: id } });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      market: 'cn',
      code: '603305',
      instrumentName: '旭升集团',
      frequencySnapshot: 'DAILY',
    });
    expect(triggers[0]!.conditionsSnapshot).toEqual([
      { type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' },
    ]);

    // EP6 消息可见 + EP7 unread+1 (SC-002 链路: 评估 → 消息中心)
    expect((await unreadCount(token)).json()).toEqual({ unread: 1 });
    const messages = messagesOf(await listMessages(token));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      code: '603305',
      instrumentName: '旭升集团',
      tradeDate: '2026-06-05',
      unread: true,
    });
    expect(messages[0]!.conditions).toEqual([
      { type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' },
    ]);
  });

  // ── ② 双条件 AND 一项不命中 → 整体不触发 ────────────────────────────────
  it('② PRICE_FALL_TO 命中 + DAILY_LOSS_OVER 不命中 (当日上涨) → 零流水零消息', async () => {
    const { id, token } = await activeToken();
    const inst = await seedInstrument('600001', 'AND 标的');
    // low 12.8 ≤ 13 命中; 收盘 +1.43% → LOSS_OVER 5% 不命中 → AND 整体否
    await seedBar(inst.id, '2026-06-05', { high: 14.5, low: 12.8, close: 14.2, prevClose: 14.0 });
    await createAlert(token, '600001', {
      conditions: [
        { type: 'PRICE_FALL_TO', threshold: 13 },
        { type: 'DAILY_LOSS_OVER', threshold: 5 },
      ],
    });

    const summary = await evaluate.execute();
    expect(summary.triggered).toBe(0);
    expect(await prisma.alertTrigger.count({ where: { accountId: id } })).toBe(0);
    expect((await unreadCount(token)).json()).toEqual({ unread: 0 });
  });

  // ── ③ ONCE_DELETE 后置: 预警消失, 流水自立消息仍达 ──────────────────────
  it('③ ONCE_DELETE 触发 → alert 删除 (EP2 空), 流水在 + 消息可读 (快照自洽)', async () => {
    const { id, token } = await activeToken();
    const inst = await seedInstrument('600002', '一次性标的');
    await seedBar(inst.id, '2026-06-05', { high: 14.5, low: 12.8, close: 14.2, prevClose: 14.0 });
    await createAlert(token, '600002', { frequency: 'ONCE_DELETE' });

    const summary = await evaluate.execute();
    expect(summary.triggered).toBe(1);

    // 预警消失 (后置 delete 同 tx); 流水独立于 Alert 生命周期 (FR-S05)
    expect(alertsOf(await listAll(token))).toHaveLength(0);
    expect(await prisma.alert.count({ where: { accountId: id } })).toBe(0);
    const messages = messagesOf(await listMessages(token));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.conditions[0]!.actual).toBe('12.8000'); // 删除后消息完整可读
  });

  // ── ④ DAILY 幂等: 同 tradeDate 重跑零新增, 新 tradeDate 再触发 ───────────
  it('④ DAILY 重跑同 bar → skippedDuplicate 零新增; 新 tradeDate bar → 再触发 unread=2', async () => {
    const { id, token } = await activeToken();
    const inst = await seedInstrument('600003', '每日标的');
    await seedBar(inst.id, '2026-06-04', { high: 13.5, low: 12.9, close: 13.1, prevClose: 13.3 });
    await createAlert(token, '600003'); // DAILY 默认

    const first = await evaluate.execute();
    expect(first.triggered).toBe(1);

    // 同 tradeDate 重跑 (catch-up tick / 停牌旧 bar 同路径): P2002 幂等 no-op
    const rerun = await evaluate.execute();
    expect(rerun).toEqual({
      enabledAlerts: 1,
      triggered: 0,
      skippedNoBar: 0,
      skippedDuplicate: 1,
    });
    expect(await prisma.alertTrigger.count({ where: { accountId: id } })).toBe(1);

    // 新交易日 bar 落库 → DAILY 不动后置 → 新 tradeDate 再触发
    await seedBar(inst.id, '2026-06-05', { high: 13.2, low: 12.7, close: 12.9, prevClose: 13.1 });
    const next = await evaluate.execute();
    expect(next.triggered).toBe(1);
    expect(await prisma.alertTrigger.count({ where: { accountId: id } })).toBe(2);
    expect((await unreadCount(token)).json()).toEqual({ unread: 2 });
    // 倒序: 新 tradeDate 在前
    expect(messagesOf(await listMessages(token)).map((m) => m.tradeDate)).toEqual([
      '2026-06-05',
      '2026-06-04',
    ]);
  });

  // ── ⑤ 停用不评估 ─────────────────────────────────────────────────────────
  it('⑤ enabled=false → 评估扫描不含, 零流水', async () => {
    const { id, token } = await activeToken();
    const inst = await seedInstrument('600004', '停用标的');
    await seedBar(inst.id, '2026-06-05', { high: 14.5, low: 12.8, close: 14.2, prevClose: 14.0 });
    const alert = await createAlert(token, '600004');
    expect((await patchAlert(token, alert.id, { enabled: false })).statusCode).toBe(200);

    const summary = await evaluate.execute();
    expect(summary).toEqual({
      enabledAlerts: 0,
      triggered: 0,
      skippedNoBar: 0,
      skippedDuplicate: 0,
    });
    expect(await prisma.alertTrigger.count({ where: { accountId: id } })).toBe(0);
  });
});
