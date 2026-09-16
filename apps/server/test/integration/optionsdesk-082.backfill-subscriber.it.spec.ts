import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedStores } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { marketdataConfig, type MarketdataConfig } from '../../src/config/marketdata.config';
import { AnchorColdStartSubscriber } from '../../src/marketdata/anchor-cold-start.subscriber';
import { MARKETDATA_WORKER_DISABLED } from '../../src/marketdata/marketdata-sync.queue';
import {
  BROKER_ACCOUNT_PORT,
  type BrokerAccountPort,
} from '../../src/optionsdesk/broker-account.port';
import { BrokerAccountScheduler } from '../../src/optionsdesk/broker-account.scheduler';
import type { BrokerMarket } from '../../src/optionsdesk/broker-code.rules';
import { BrokerHistoryBackfillSubscriber } from '../../src/optionsdesk/broker-history-backfill.subscriber';
import { CreateAnchorUseCase } from '../../src/optionsdesk/create-anchor.usecase';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { OutboxEventCronPublisher } from '../../src/security/outbox/outbox-event-cron.publisher';
import { OutboxSubscriberRegistry } from '../../src/security/outbox/outbox-subscriber.registry';
import { PrismaService } from '../../src/security/prisma.service';

process.env.AUTH_JWT_SECRET ??= 'optionsdesk-082-it-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-082-it-hmac-secret-min-32-bytes';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 082 T018 —— 新建锚 → 待执行补齐记录的 outbox 订阅方 **真 PG + Redis IT**
 * (FR-009 / FR-018; plan D10; state_branches 15, 32)。
 *
 * ## 为什么必须要真 PG + Redis
 *
 * ① 幂等与「多连接各一条」由唯一键 `(connection_id, source_event_id)` + `ON CONFLICT DO NOTHING`
 *    承载 —— mock Prisma 下重投与第二个连接都「插入成功」, 键写错看不出来。
 * ② ⑦ 要的是真生命周期 (`moduleRef.init()` 触发 `onModuleInit` 自注册); ⑧ 让真事件穿过 outbox 表与
 *    relay, 同一事件先投给 marketdata 冷启动订阅方 (它真入 bullmq 队列 ⇒ 要 Redis, 否则它抛错,
 *    relay 不会走到本订阅方)。worker 不启动 (`MARKETDATA_WORKER_DISABLED`), 收窄 boot 不注册
 *    ScheduleModule ⇒ `@Cron` 惰性, 全部显式触发。
 *
 * 装配 = `OptionsdeskModule` 真 DI, 只替换 `BROKER_ACCOUNT_PORT`, 并把 `marketdataConfig.KEY` 换成可变对象:
 * compile / init 期为 mock (各 vendor 工厂按 mock 装配, 不碰外网), init 后切 live (本订阅方的 mock 闸
 * 在运行时读; 臂 ⑥ 临时切回 mock)。
 *
 * ## 定向变异留档 (2026-09-14, 均经 `pnpm nx test server <本文件>`: typecheck 过、vitest 红)
 *
 * - 基线: 9/9 绿。
 * - a 唯一键只含 `source_event_id` (tasks 行指定的变异): 该键在 T010 迁移里, 类型合法的代码变异去不掉
 *   ⇒ 改为**隔离测试库内**临时 sabotage —— `beforeAll` 里 `DROP INDEX uk_broker_sync_run_connection_source_event`
 *   再按 `(source_event_id)` 重建同名唯一索引: 「③」红 —— 收到 1 行 (第二个连接被 `skipDuplicates` 静默挡掉); 其余 8 条绿。
 * - b mock 闸失效 (`kind === 'mock' && delivery.sourceEventId === ''`): 「⑥」红; 其余 8 条绿。
 * - c `nextAttemptAt` 写成 null (`now.getTime() < 0 ? now : null`): 「①」「⑧」红 (⑧ 为调度器认领不到); 其余 7 条绿。
 * - 三处均还原 (`cmp` 与备份一致) 后 9/9 绿。
 */

/** 明显假值 (Guardrail 1)。 */
const ACCOUNT_ID = 9_000_000_000_000n;
const TICKER = 'us:PEP';

const LIVE_CONFIG: MarketdataConfig = {
  kind: 'live',
  lixingerToken: 'it-082-fake-lixinger-token',
  lixingerBaseUrl: 'https://lixinger.invalid/api',
  eastmoneyBaseUrl: 'https://eastmoney.invalid',
  eastmoneyClistBaseUrl: 'https://eastmoney-clist.invalid',
  tencentCalendarBaseUrl: 'https://tencent.invalid',
  futuShimUrl: 'https://futu-shim.invalid',
  futuShimToken: 'it-082-fake-shim-token',
};

/** 券商 port 的 test double: 一切为空 (⑧ 加分段让调度器真执行一次补齐)。 */
class FakeBrokerPort implements BrokerAccountPort {
  calls = 0;
  async getAccountSummary() {
    this.calls++;
    return { trdmarketAuth: ['US', 'HK'], matched: 1 };
  }
  async fetchPositions() {
    this.calls++;
    return [];
  }
  async fetchDeals() {
    this.calls++;
    return [];
  }
  async fetchOrders() {
    this.calls++;
    return [];
  }
  /** 084: 本 IT 只走 082 的查询路径; 推送事件读取不该被调用到。 */
  fetchEvents(): never {
    throw new Error('FakeBrokerPort.fetchEvents: 本 IT 不走推送路径');
  }

  async fetchStockOwners(_market: BrokerMarket, codes: readonly string[]) {
    this.calls++;
    return new Map(codes.map((code) => [code, null]));
  }
}

describe('082 T018 新建锚 → 待执行补齐记录 订阅方 IT (Testcontainers PG + Redis)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let subscriber: BrokerHistoryBackfillSubscriber;
  const port = new FakeBrokerPort();
  const config: { kind: string } = { ...LIVE_CONFIG, kind: 'mock' };
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  const createConnection = async (label: string) =>
    (
      await prisma.brokerConnection.create({
        data: { accountId: ACCOUNT_ID, brokerCode: 'futu', label, phoneLast4: '0000' },
      })
    ).id;
  const deliver = (
    sourceEventId: string,
    data: Record<string, unknown> = { anchorId: '1', ticker: TICKER },
  ) => subscriber.handle({ sourceEventId, data });
  const runs = () =>
    prisma.brokerSyncRun.findMany({ orderBy: [{ connectionId: 'asc' }, { id: 'asc' }] });

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    delete process.env.BROKER_SYNC_SCOPE;
    // 同 082 其它 IT (aaa0ba7a): 不起 marketdata 队列 worker, 规避 bullmq 5.x 关停竞态假红。
    process.env[MARKETDATA_WORKER_DISABLED] = '1';
    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([OptionsdeskModule]) })
      .overrideProvider(BROKER_ACCOUNT_PORT)
      .useValue(port)
      .overrideProvider(marketdataConfig.KEY)
      .useValue(config)
      .compile();
    await moduleRef.init();
    config.kind = 'live';
    prisma = moduleRef.get(PrismaService);
    subscriber = moduleRef.get(BrokerHistoryBackfillSubscriber);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await stores?.drop();
    if (prevWorkerDisabled === undefined) delete process.env[MARKETDATA_WORKER_DISABLED];
    else process.env[MARKETDATA_WORKER_DISABLED] = prevWorkerDisabled;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.kind = 'live';
  });

  beforeEach(async () => {
    port.calls = 0;
    await prisma.brokerSyncRun.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerDeal.deleteMany({});
    await prisma.brokerOrder.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.outboxEvent.deleteMany({});
    await prisma.anchorChange.deleteMany({});
    await prisma.anchor.deleteMany({});
  });

  it('① 一个连接 ⇒ 1 条 pending 补齐记录, 字段齐全且 nextAttemptAt 已到期 (branch 15)', async () => {
    const conn = await createConnection('main');
    const eventId = randomUUID();
    const before = Date.now();

    await deliver(eventId);

    const after = Date.now();
    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      connectionId: conn,
      kind: 'backfill',
      status: 'pending',
      target: TICKER,
      sourceEventId: eventId,
      market: null,
      windowStart: null,
      windowEnd: null,
      tradingDate: null,
      attempt: 0,
      startedAt: null,
    });
    // 🚨 为 null 的记录调度器永不认领 (Guardrail): 必须是「此刻」。
    const next = rows[0]!.nextAttemptAt?.getTime();
    expect(next).toBeGreaterThanOrEqual(before);
    expect(next).toBeLessThanOrEqual(after);
  });

  it('② 同一 sourceEventId 投递两次 ⇒ 仍 1 条, 第二次不抛', async () => {
    await createConnection('main');
    const eventId = randomUUID();

    await deliver(eventId);
    await expect(deliver(eventId)).resolves.toBeUndefined();

    expect(await runs()).toHaveLength(1);
  });

  it('③ 两个连接 ⇒ 各 1 条 (唯一键只按事件 ID 时第二条会被静默挡掉)', async () => {
    const a = await createConnection('a');
    const b = await createConnection('b');
    const eventId = randomUUID();

    await deliver(eventId);

    const rows = await runs();
    expect(rows.map((r) => [r.connectionId, r.sourceEventId, r.status])).toEqual([
      [a, eventId, 'pending'],
      [b, eventId, 'pending'],
    ]);
  });

  it.each([
    ['缺 ticker', { anchorId: '1' }],
    ['ticker 非字符串', { anchorId: '1', ticker: 700 }],
  ])('④ 载荷%s ⇒ 不抛、0 条、记 error (毒丸)', async (_label, data) => {
    await createConnection('main');
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(deliver(randomUUID(), data)).resolves.toBeUndefined();

    expect(await runs()).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('⑤ 无连接 ⇒ 不抛、0 条', async () => {
    await expect(deliver(randomUUID())).resolves.toBeUndefined();

    expect(await runs()).toEqual([]);
  });

  it('⑥ mock 档 ⇒ 有连接也 0 条 (branch 32)', async () => {
    await createConnection('main');
    config.kind = 'mock';

    await deliver(randomUUID());

    expect(await runs()).toEqual([]);
  });

  it('⑦ registry 中 optionsdesk.anchor-created 同时挂着冷启动订阅方与本订阅方 (各一次)', () => {
    const registry = moduleRef.get(OutboxSubscriberRegistry);
    const coldStart = moduleRef.get(AnchorColdStartSubscriber);

    expect(subscriber.eventType).toBe(coldStart.eventType);
    const subs = registry['byType'].get(subscriber.eventType) ?? [];
    expect(subs.filter((s) => s === coldStart)).toHaveLength(1);
    expect(subs.filter((s) => s === subscriber)).toHaveLength(1);
  });

  it('⑧ 端到端: 真 CreateAnchorUseCase 建锚 → relay 投递 → 1 条记录; 调度器认领即执行 (branch 15)', async () => {
    const conn = await createConnection('main');

    await moduleRef.get(CreateAnchorUseCase).execute({
      ticker: TICKER,
      v: '50',
      asof: new Date('2026-06-30T00:00:00Z'),
      method: 'dcf',
      confidence: '8',
    });
    const events = await prisma.outboxEvent.findMany();
    expect(events.map((e) => e.eventType)).toEqual([subscriber.eventType]);

    const scan = await moduleRef.get(OutboxEventCronPublisher).scan();

    expect(scan).toEqual({ scanned: 1, published: 1 });
    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: conn,
      kind: 'backfill',
      status: 'pending',
      target: TICKER,
      sourceEventId: events[0]!.id,
    });

    // 加分段: 调度器的补齐认领步骤直调 (避开对账时点与交易日历) ⇒ 刚插的记录当拍即被认领并执行。
    await moduleRef.get(BrokerAccountScheduler)['runDueBackfills'](conn, new Date());

    expect((await runs())[0]).toMatchObject({ status: 'succeeded', attempt: 0 });
    expect(port.calls).toBeGreaterThan(0);
  });
});
