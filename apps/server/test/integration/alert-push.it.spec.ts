import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { AlertModule } from '../../src/alert/alert.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { EvaluateAlertsUseCase } from '../../src/alert/evaluate-alerts.usecase';
import { DispatchPushDeliveriesUseCase } from '../../src/alert/dispatch-push-deliveries.usecase';
import { MockPushGateway } from '../../src/alert/mock-push.gateway';
import { PUSH_GATEWAY } from '../../src/alert/push-gateway.port';
import { ALERT_WORKER_DISABLED } from '../../src/alert/alert-eval.processor';

// 022 T007 全 boot 推送链路 IT — 覆盖 spec state_branches server 条目 (mobile 侧归 PR-2):
//  ① 触发→推送解耦全链: EP9 绑定 → 评估 fan-out PENDING → dispatch → SENT + 极光
//    payload 体例 (FR-005 文案 / FR-006 channel 归 gateway 单测) /
//  ② 绑定生命周期闭环 (SC-005): A 绑 → B 同设备转绑 (clarify Q1) → A 触发零 delivery、
//    B 触发有 → EP10 解绑 (他人 deleted:0 反枚举) → 再触发零行 /
//  ③ fan-out 后解绑 → dispatch 复核 → SKIPPED_UNBOUND 零外呼 (FR-003 服务端兜底) /
//  ④ gateway 故障注入 → trigger 流水 + EP6/EP7 消息中心 100% 不受影响 + backoff 重试
//    留痕可查, 耗尽 FAILED 终态 (FR-004/SC-006) /
//  ⑤ invalid_target → FAILED_INVALID + binding 剔除, 后续触发零 delivery 不再重试
//    (FR-010 防重试风暴) / ⑥ EP9/EP10 401·400·429 分支。
// 评估/dispatch 经 moduleRef 直调 UC (queue/worker 注册面归 T006 processor 单测);
// PUSH_GATEWAY overrideProvider 注入 MockPushGateway — 结果队列驱动三态分支;
// ALERT_WORKER_DISABLED 置位 → 本进程零后台消费, 轮次完全受测试控制。
// beforeEach 清 alert 五表 — 评估/dispatch 都是全局扫描, 跨 case 残留会污染 summary。
describe('022 alert 推送送达全链 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let evaluate: EvaluateAlertsUseCase;
  let dispatch: DispatchPushDeliveriesUseCase;
  const gateway = new MockPushGateway();
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'alert-t007-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'alert-t007-hmac-secret-min-32-bytes-zyxwv';
    process.env[ALERT_WORKER_DISABLED] = '1';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule, AlertModule],
    })
      .overrideProvider(PUSH_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    evaluate = moduleRef.get(EvaluateAlertsUseCase);
    dispatch = moduleRef.get(DispatchPushDeliveriesUseCase);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    // 评估/dispatch 全局扫描 → 清 alert ctx 五表隔离 case (marketdata 种子各 case 独立 code 不清)
    await prisma.pushDelivery.deleteMany();
    await prisma.pushBinding.deleteMany();
    await prisma.alertTrigger.deleteMany();
    await prisma.alert.deleteMany();
    await prisma.alertReadCursor.deleteMany();
    gateway.clearAll();
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613915${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  /** marketdata 种子: instrument + none 口径 bar (021 T013 同款)。 */
  const seedInstrument = (code: string, name: string) =>
    prisma.instrument.create({
      data: { market: 'cn', code, name, type: 'stock', currency: 'CNY', status: 'active' },
    });
  const seedBar = (
    instrumentId: bigint,
    tradeDate: string,
    bar: { high: number; low: number; close: number; prevClose: number | null },
  ) =>
    prisma.dailyBar.create({
      data: {
        instrumentId,
        tradeDate: new Date(tradeDate),
        adjust: 'none',
        open: bar.prevClose ?? bar.close,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        prevClose: bar.prevClose,
      },
    });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });
  const putBinding = (token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/api/v1/alert/push-binding',
      headers: authJson(token),
      payload,
    });
  const delBinding = (token: string, regId: string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/alert/push-binding/${regId}`,
      headers: auth(token),
    });
  const listMessages = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/messages', headers: auth(token) });
  const unreadCount = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/messages/unread-count', headers: auth(token) });

  /** 建单标的 PRICE_FALL_TO 预警 (默认阈 13, DAILY)。 */
  async function createAlert(token: string, code: string, threshold = 13): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/alert/alerts',
      headers: authJson(token),
      payload: {
        instruments: [{ market: 'cn', code }],
        conditions: [{ type: 'PRICE_FALL_TO', threshold }],
        frequency: 'DAILY',
      },
    });
    expect(res.statusCode).toBe(201);
  }

  const deliveries = () => prisma.pushDelivery.findMany({ orderBy: { id: 'asc' } });

  // ── ① 触发→推送解耦全链: 绑定 → fan-out → dispatch → SENT ────────────────
  it('① EP9 绑定 → 评估 fan-out PENDING (regId 快照) → dispatch → SENT + 极光 payload 体例', async () => {
    const { id, token } = await activeToken();
    const bound = await putBinding(token, { registrationId: 'reg-t007-a', platform: 'android' });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({ registrationId: 'reg-t007-a', platform: 'android' });

    const inst = await seedInstrument('700001', '招商银行');
    await seedBar(inst.id, '2026-06-05', { high: 31.0, low: 29.8, close: 30.5, prevClose: 30.9 });
    await createAlert(token, '700001', 30);

    expect((await evaluate.execute()).triggered).toBe(1);
    const trigger = await prisma.alertTrigger.findFirstOrThrow({ where: { accountId: id } });
    let rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      triggerId: trigger.id,
      accountId: id,
      registrationId: 'reg-t007-a',
      status: 'PENDING',
      attempts: 0,
    });

    const summary = await dispatch.execute();
    expect(summary).toMatchObject({ scanned: 1, sent: 1, errors: 0 });

    rows = await deliveries();
    expect(rows[0]!.status).toBe('SENT');
    expect(rows[0]!.sentAt).not.toBeNull();
    // gateway 收到渲染后的推送域 payload (FR-005 快照文案, US1 体例)
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]).toEqual({
      registrationId: 'reg-t007-a',
      title: '预警触发',
      body: '招商银行 跌至 30.00 预警价（今日最低 29.80）',
      triggerId: trigger.id,
    });
  });

  // ── ② 绑定生命周期闭环 (SC-005): 转绑 → 解绑 → 零送达 ───────────────────
  it('② A 绑 → B 同设备转绑 → A 触发零 delivery、B 触发有 → EP10 解绑后再触发零行', async () => {
    const a = await activeToken();
    const b = await activeToken();
    const regId = 'reg-t007-shared';

    // A 绑 → B 同 regId 上报 → 整体转绑 B (clarify Q1: RegID 全局唯一)
    expect(
      (await putBinding(a.token, { registrationId: regId, platform: 'android' })).statusCode,
    ).toBe(200);
    expect(
      (await putBinding(b.token, { registrationId: regId, platform: 'android' })).statusCode,
    ).toBe(200);
    const bindings = await prisma.pushBinding.findMany();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.accountId).toBe(b.id);

    // A、B 各自预警同轮触发 → fan-out 仅 B 有绑定
    const instA = await seedInstrument('700002', 'A 标的');
    const instB = await seedInstrument('700003', 'B 标的');
    await seedBar(instA.id, '2026-06-05', { high: 14, low: 12.8, close: 13.5, prevClose: 13.9 });
    await seedBar(instB.id, '2026-06-05', { high: 14, low: 12.8, close: 13.5, prevClose: 13.9 });
    await createAlert(a.token, '700002');
    await createAlert(b.token, '700003');

    expect((await evaluate.execute()).triggered).toBe(2);
    const rows = await deliveries();
    expect(rows).toHaveLength(1); // A 触发零 delivery (消息中心 only), B 触发 1 行
    expect(rows[0]!.accountId).toBe(b.id);
    expect((await unreadCount(a.token)).json()).toEqual({ unread: 1 }); // A 消息中心兜底不受影响

    expect((await dispatch.execute()).sent).toBe(1);
    expect(gateway.sent.map((s) => s.registrationId)).toEqual([regId]);

    // EP10: A 解绑已转绑 regId → deleted:0 无杂音 (反枚举); B 解绑 → deleted:1
    expect((await delBinding(a.token, regId)).json()).toEqual({ deleted: 0 });
    expect((await delBinding(b.token, regId)).json()).toEqual({ deleted: 1 });

    // 解绑后新 tradeDate 再触发 → fan-out 零新 delivery (该设备不再收推送)
    await seedBar(instB.id, '2026-06-08', { high: 13.2, low: 12.7, close: 12.9, prevClose: 13.5 });
    expect((await evaluate.execute()).triggered).toBe(1);
    expect(await prisma.pushDelivery.count()).toBe(1); // 仍只有先前 SENT 行
  });

  // ── ③ fan-out 后解绑 → dispatch 复核 → SKIPPED_UNBOUND 零外呼 ────────────
  it('③ PENDING 已落但 dispatch 前解绑 → SKIPPED_UNBOUND, gateway 零调用 (FR-003 兜底)', async () => {
    const { token } = await activeToken();
    await putBinding(token, { registrationId: 'reg-t007-gone', platform: 'android' });
    const inst = await seedInstrument('700004', '解绑竞态标的');
    await seedBar(inst.id, '2026-06-05', { high: 14, low: 12.8, close: 13.5, prevClose: 13.9 });
    await createAlert(token, '700004');

    expect((await evaluate.execute()).triggered).toBe(1);
    expect((await delBinding(token, 'reg-t007-gone')).json()).toEqual({ deleted: 1 });

    const summary = await dispatch.execute();
    expect(summary).toMatchObject({ scanned: 1, skippedUnbound: 1, sent: 0 });
    expect((await deliveries())[0]!.status).toBe('SKIPPED_UNBOUND');
    expect(gateway.sent).toHaveLength(0);
  });

  // ── ④ gateway 故障注入: 消息中心 100% 不受影响 + 重试留痕 (FR-004/SC-006) ──
  it('④ retryable 故障 → trigger/EP6/EP7 不受影响 + backoff 留痕, 耗尽 → FAILED 终态可查', async () => {
    const { id, token } = await activeToken();
    await putBinding(token, { registrationId: 'reg-t007-flaky', platform: 'android' });
    const inst = await seedInstrument('700005', '故障标的');
    await seedBar(inst.id, '2026-06-05', { high: 14, low: 12.8, close: 13.5, prevClose: 13.9 });
    await createAlert(token, '700005');
    expect((await evaluate.execute()).triggered).toBe(1);

    // 第 1 轮: 5xx → retryable → 行留 PENDING + attempts/nextAttemptAt/lastError 留痕
    gateway.enqueueResult({ kind: 'retryable', detail: 'jpush 503' });
    expect((await dispatch.execute()).retryScheduled).toBe(1);
    let row = (await deliveries())[0]!;
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'jpush 503' });
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // 推送失败 100% 不触碰兜底面: trigger 流水在 + EP6 消息可见 + EP7 unread 正常
    expect(await prisma.alertTrigger.count({ where: { accountId: id } })).toBe(1);
    expect((await unreadCount(token)).json()).toEqual({ unread: 1 });
    const messages = (await listMessages(token)).json() as { messages: Array<{ code: string }> };
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]!.code).toBe('700005');

    // 未到期不重扫 (backoff 生效)
    expect((await dispatch.execute()).scanned).toBe(0);

    // 回拨到期 ×2 → 第 2 轮 retryable (attempts 2), 第 3 轮 retryable → 耗尽 FAILED
    const rewind = () =>
      prisma.pushDelivery.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await rewind();
    gateway.enqueueResult({ kind: 'retryable', detail: 'jpush timeout' });
    expect((await dispatch.execute()).retryScheduled).toBe(1);
    await rewind();
    gateway.enqueueResult({ kind: 'retryable', detail: 'jpush 503 again' });
    expect((await dispatch.execute()).failed).toBe(1);

    row = (await deliveries())[0]!;
    expect(row).toMatchObject({ status: 'FAILED', attempts: 3, lastError: 'jpush 503 again' });
    // 终态不再扫 (有限重试收口); 消息中心兜底面依旧完好
    expect((await dispatch.execute()).scanned).toBe(0);
    expect((await unreadCount(token)).json()).toEqual({ unread: 1 });
  });

  // ── ⑤ invalid_target 剔除: FAILED_INVALID + binding 删 + 不再生成 (FR-010) ──
  it('⑤ RegID 无效 → FAILED_INVALID + binding 剔除 → 后续触发零 delivery 零重试', async () => {
    const { token } = await activeToken();
    await putBinding(token, { registrationId: 'reg-t007-dead', platform: 'android' });
    const inst = await seedInstrument('700006', '无效目标标的');
    await seedBar(inst.id, '2026-06-05', { high: 14, low: 12.8, close: 13.5, prevClose: 13.9 });
    await createAlert(token, '700006');
    expect((await evaluate.execute()).triggered).toBe(1);

    gateway.enqueueResult({ kind: 'invalid_target', detail: 'jpush 1011' });
    expect((await dispatch.execute()).failedInvalid).toBe(1);
    expect((await deliveries())[0]!.status).toBe('FAILED_INVALID');
    expect(await prisma.pushBinding.count()).toBe(0); // 注册面剔除

    // 新 tradeDate 再触发 → fan-out 零新 delivery; dispatch 零到期 (不再重试风暴)
    await seedBar(inst.id, '2026-06-08', { high: 13.2, low: 12.7, close: 12.9, prevClose: 13.5 });
    expect((await evaluate.execute()).triggered).toBe(1);
    expect(await prisma.pushDelivery.count()).toBe(1);
    expect((await dispatch.execute()).scanned).toBe(0);
    expect(gateway.sent).toHaveLength(1); // 仅首轮一次外呼
  });

  // ── ⑥ EP9/EP10 错误分支: 401 / 400 ───────────────────────────────────────
  it('⑥ 无 token → 401; registrationId 空/超长、platform 出域 → 400 (FORM_VALIDATION)', async () => {
    const noAuth = await app.inject({
      method: 'PUT',
      url: '/api/v1/alert/push-binding',
      headers: { 'content-type': 'application/json' },
      payload: { registrationId: 'reg-x', platform: 'android' },
    });
    expect(noAuth.statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/v1/alert/push-binding/reg-x' })).statusCode,
    ).toBe(401);

    const { token } = await activeToken();
    const bad = async (payload: Record<string, unknown>) =>
      (await putBinding(token, payload)).statusCode;
    expect(await bad({ registrationId: '', platform: 'android' })).toBe(400);
    expect(await bad({ registrationId: 'x'.repeat(65), platform: 'android' })).toBe(400);
    expect(await bad({ registrationId: 'reg-x', platform: 'ios' })).toBe(400);
    expect(await prisma.pushBinding.count()).toBe(0); // 400 全部未落库
  });

  // 31 个串行写请求满载时可超 vitest 默认 5s → 显式放宽防 flake (021 同款)。
  // 「复用 alert-write-account 桶」实际语义 = 同名同参 (30/60s)、throttler 默认
  // per-handler 独立计数 (021 alerts.controller 各 EP 同款) — EP9 满载不连坐 EP10。
  it('⑥ 限流: EP9 第 31 次 → 429 (alert-write-account 30/60s, per-handler 计数)', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 31; i += 1) {
      last = await putBinding(token, { registrationId: 'reg-t007-rl', platform: 'android' });
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);

    // EP9 桶满 ≠ EP10 受限 (per-handler 隔离)
    expect((await delBinding(token, 'reg-t007-rl')).statusCode).toBe(200);
  }, 15_000);
});
