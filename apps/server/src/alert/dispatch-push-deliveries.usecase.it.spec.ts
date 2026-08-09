import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import {
  DispatchPushDeliveriesUseCase,
  nextRetryDecision,
  PUSH_MAX_ATTEMPTS,
} from './dispatch-push-deliveries.usecase';
import { MockPushGateway } from './mock-push.gateway';
import type { PushGateway } from './push-gateway.port';

// 022 T006 US1: dispatch worker 核心 UC (Testcontainers PG + mock gateway 注入三态)。
// 覆盖: 成功 SENT / retryable backoff 梯子(1m→5m)后成功 / 耗尽 FAILED 终态留痕 /
// invalid → FAILED_INVALID + binding 删 (FR-010) / 解绑·转绑 → SKIPPED_UNBOUND
// (FR-003 兜底) / 未到期不扫 / 单行炸不传染 (失败隔离)。
// run via `nx test server <file>` (cwd=apps/server)。
describe('DispatchPushDeliveriesUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let gateway: MockPushGateway;
  let dispatch: DispatchPushDeliveriesUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    gateway = new MockPushGateway();
    dispatch = new DispatchPushDeliveriesUseCase(prisma, gateway);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.pushDelivery.deleteMany();
    await prisma.pushBinding.deleteMany();
    await prisma.alertTrigger.deleteMany();
    gateway.clearAll();
  });

  const nextAccountId = (): bigint => BigInt(940_000 + ++seq);
  const nextRegId = (): string => `reg-dispatch-${++seq}`;

  /** 触发流水种子 (alertId null 避开 @@unique, 快照字段即文案输入)。 */
  async function seedTrigger(accountId: bigint): Promise<bigint> {
    const trigger = await prisma.alertTrigger.create({
      data: {
        alertId: null,
        accountId,
        market: 'cn',
        code: `60${String(2000 + ++seq)}`,
        instrumentName: '招商银行',
        tradeDate: new Date('2026-06-05'),
        conditionsSnapshot: [
          { type: 'PRICE_FALL_TO', threshold: '30.0000', actual: '29.8000' },
        ] as unknown as Prisma.InputJsonValue,
        frequencySnapshot: 'DAILY',
      },
    });
    return trigger.id;
  }

  /** binding + trigger + PENDING delivery 全套种子 (默认绑定与 delivery 匹配)。 */
  async function seedDelivery(
    opts: { bind?: boolean; bindAccountId?: bigint; attempts?: number } = {},
  ): Promise<{ deliveryId: bigint; accountId: bigint; registrationId: string }> {
    const accountId = nextAccountId();
    const registrationId = nextRegId();
    if (opts.bind !== false) {
      await prisma.pushBinding.create({
        data: { accountId: opts.bindAccountId ?? accountId, registrationId, platform: 'android' },
      });
    }
    const triggerId = await seedTrigger(accountId);
    const delivery = await prisma.pushDelivery.create({
      data: { triggerId, accountId, registrationId, attempts: opts.attempts ?? 0 },
    });
    return { deliveryId: delivery.id, accountId, registrationId };
  }

  it('成功路径: PENDING → SENT + sentAt, payload 为快照渲染文案', async () => {
    const { deliveryId, registrationId } = await seedDelivery();

    const summary = await dispatch.execute();

    expect(summary).toMatchObject({ scanned: 1, sent: 1, failed: 0, errors: 0 });
    const row = await prisma.pushDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe('SENT');
    expect(row.sentAt).not.toBeNull();
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]).toMatchObject({
      registrationId,
      title: '预警触发',
      body: '招商银行 跌至 30.00 预警价（今日最低 29.80）',
    });
  });

  it('retryable backoff 梯子: 1m → 5m 排期, 未到期不扫, 到期重试成功 → SENT', async () => {
    const { deliveryId } = await seedDelivery();
    gateway.enqueueResult({ kind: 'retryable', detail: 'jpush 503' });

    // round 1: 失败 → attempts=1 + nextAttemptAt ≈ +1m, 仍 PENDING。
    const r1 = await dispatch.execute();
    expect(r1).toMatchObject({ scanned: 1, retryScheduled: 1, sent: 0 });
    let row = await prisma.pushDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('jpush 503');
    const delay1 = row.nextAttemptAt!.getTime() - Date.now();
    expect(delay1).toBeGreaterThan(50_000);
    expect(delay1).toBeLessThan(70_000);

    // 未到期 → 不在扫描面。
    const rIdle = await dispatch.execute();
    expect(rIdle.scanned).toBe(0);

    // 回拨到期, round 2 再失败 → attempts=2 + ≈ +5m。
    await prisma.pushDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    gateway.enqueueResult({ kind: 'retryable', detail: 'jpush timeout' });
    const r2 = await dispatch.execute();
    expect(r2).toMatchObject({ scanned: 1, retryScheduled: 1 });
    row = await prisma.pushDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row.attempts).toBe(2);
    const delay2 = row.nextAttemptAt!.getTime() - Date.now();
    expect(delay2).toBeGreaterThan(290_000);
    expect(delay2).toBeLessThan(310_000);

    // 回拨到期, round 3 成功 (mock default ok) → SENT。
    await prisma.pushDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const r3 = await dispatch.execute();
    expect(r3).toMatchObject({ scanned: 1, sent: 1 });
    row = await prisma.pushDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe('SENT');
  });

  it('耗尽 → FAILED 终态留痕 (attempts=3 + lastError, 不再入扫描面)', async () => {
    const { deliveryId } = await seedDelivery({ attempts: PUSH_MAX_ATTEMPTS - 1 });
    gateway.enqueueResult({ kind: 'retryable', detail: 'jpush 持续 5xx' });

    const summary = await dispatch.execute();

    expect(summary).toMatchObject({ scanned: 1, failed: 1, retryScheduled: 0 });
    const row = await prisma.pushDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(PUSH_MAX_ATTEMPTS);
    expect(row.lastError).toBe('jpush 持续 5xx');
    // 终态不复扫。
    const rIdle = await dispatch.execute();
    expect(rIdle.scanned).toBe(0);
  });

  it('invalid_target → FAILED_INVALID + 对应 binding 删除 (FR-010 防重试风暴)', async () => {
    const { deliveryId, registrationId } = await seedDelivery();
    gateway.enqueueResult({ kind: 'invalid_target', detail: 'jpush 1011' });

    const summary = await dispatch.execute();

    expect(summary).toMatchObject({ scanned: 1, failedInvalid: 1 });
    const row = await prisma.pushDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe('FAILED_INVALID');
    expect(row.lastError).toBe('jpush 1011');
    const binding = await prisma.pushBinding.findUnique({ where: { registrationId } });
    expect(binding).toBeNull(); // 注册面剔除, 后续触发不再 fan-out 该设备
  });

  it('绑定复核: 已解绑 / 已转绑他账号 → SKIPPED_UNBOUND, gateway 不调 (FR-003 兜底)', async () => {
    const unbound = await seedDelivery({ bind: false }); // 登出已解绑
    const rebound = await seedDelivery({ bindAccountId: nextAccountId() }); // 同设备他账号转绑

    const summary = await dispatch.execute();

    expect(summary).toMatchObject({ scanned: 2, skippedUnbound: 2, sent: 0 });
    for (const { deliveryId } of [unbound, rebound]) {
      const row = await prisma.pushDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(row.status).toBe('SKIPPED_UNBOUND');
    }
    expect(gateway.sent).toHaveLength(0);
  });

  it('单行炸不传染: gateway 抛异常折叠 retryable (有限重试), 同轮其余行照常 SENT', async () => {
    const boom = await seedDelivery();
    const fine = await seedDelivery();
    const throwing: PushGateway = {
      send: async (input) => {
        if (input.registrationId === boom.registrationId) throw new Error('ECONNRESET');
        return { kind: 'ok' };
      },
    };
    const isolated = new DispatchPushDeliveriesUseCase(prisma, throwing);

    const summary = await isolated.execute();

    expect(summary).toMatchObject({ scanned: 2, sent: 1, retryScheduled: 1, errors: 0 });
    const boomRow = await prisma.pushDelivery.findUniqueOrThrow({ where: { id: boom.deliveryId } });
    expect(boomRow.status).toBe('PENDING'); // 折叠 retryable → backoff 排期, 非无限滞留
    expect(boomRow.attempts).toBe(1);
    expect(boomRow.lastError).toBe('ECONNRESET');
    const fineRow = await prisma.pushDelivery.findUniqueOrThrow({ where: { id: fine.deliveryId } });
    expect(fineRow.status).toBe('SENT');
  });

  it('nextRetryDecision 纯函数: D4 梯子 1m/5m → 耗尽 failed', () => {
    const now = new Date('2026-06-07T10:00:00Z');
    const first = nextRetryDecision(0, now);
    expect(first).toMatchObject({ kind: 'retry', attempts: 1 });
    if (first.kind === 'retry') {
      expect(first.nextAttemptAt.getTime() - now.getTime()).toBe(60_000);
    }
    const second = nextRetryDecision(1, now);
    expect(second).toMatchObject({ kind: 'retry', attempts: 2 });
    if (second.kind === 'retry') {
      expect(second.nextAttemptAt.getTime() - now.getTime()).toBe(300_000);
    }
    expect(nextRetryDecision(2, now)).toEqual({ kind: 'failed', attempts: 3 });
    expect(nextRetryDecision(7, now)).toEqual({ kind: 'failed', attempts: 8 }); // 越界防御
  });
});
