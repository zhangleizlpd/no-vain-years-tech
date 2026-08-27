import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { QueueEvents, Worker } from 'bullmq';
import { setupIsolatedStores } from '../_support/isolated-db';
import { coldStartUnused } from '../_support/cold-start-stub';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import {
  DimensionExecutorRegistry,
  type DimensionKey,
} from '../../src/marketdata/dimension-executor';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
  type DimensionJobPayload,
  type MarketdataSyncJobPayload,
} from '../../src/marketdata/marketdata-sync.queue';
import { MarketdataSyncWorker } from '../../src/marketdata/marketdata-sync.worker';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

/**
 * #137 打断收敛的**全链实证**(真 PG + 真 Redis + 真 BullMQ)。单测把 BullMQ 整个 mock 掉了,
 * 所以「stalled 真的会把同一个 jobId 交回来」这一环在本文件之前一次都没被真跑过。
 *
 * ## 为什么必须要真 Redis
 *
 * 被测的因果链有一半住在 BullMQ 的 lua 里: lock 过期 → stalled 扫描 → `moveJobToWait`(**同
 * jobId**) → 新 attempt。而收敛判据「同 `bull_job_id` 还挂着 running 的只可能是上一次 attempt」
 * 整个建在那个 jobId 复用上。test double 换掉 Redis = 把要验的东西换掉了。
 *
 * ## 「进程猝死」怎么模拟, 以及这个等价性凭什么成立
 *
 * 不 fork 真进程, 而是 `QueueRedisLifecycle.onApplicationShutdown()` 强断连接 + **不**调
 * `worker.close()`。论证: SIGKILL 对本机制的可观测后果**只有两条** —— ① lock 不再续期
 * ② `finish()` 没机会调。强断连接让 ① 成立(续期命令发不出去), 挂死的 executor 让 ② 成立。
 *
 * ⚠️ **它不覆盖的**: 进程真的从进程表消失。那一环与被测机制无因果关系, 但「等价性论证本身
 * 成立吗」只能靠真杀一次进程来证 —— 那是本文件之外的一次性演练, 不进 CI。
 *
 * 该演练已于 2026-08-23 在本地全栈跑过 (dev PG 5433 / Redis 6380, `node dist/main.js`,
 * 灌 400 个 `sync:eod_bar` job 制造连续在跑的时间带 → 对 in-flight 的进程 `kill -9` → 重启):
 *
 *     id  |   status    | started      | finished     | bull_job_id
 *     53  | interrupted | 07:50:11.059 | 07:51:21.507 | 42
 *     275 | failed      | 07:51:21.514 |      -       | 42
 *     新进程日志: sync_run 收敛 interrupted: {"jobId":"42","rows":1,...}
 *
 * 三条与本文件断言逐条对应: ① `rows:1` 真进程里也只命中一行; ② 53 的 finished_at 比 275 的
 * started_at **早 7ms** —— 收敛确实跑在新行 INSERT 之前(这是顺序保证的**直接**观测, 本文件
 * 只能靠 `rows:1` 间接推); ③ 两行同 bull_job_id。⇒ 上面那条等价性论证成立。
 * (275 收 `failed` 是 mock provider 按设计拒绝采集所致, 与本机制无关。)
 *
 * ## 时间参数为什么敢改小
 *
 * 生产用 BullMQ 默认 `lockDuration`/`stalledInterval` = 30s, 本文件用 1s。机制的判据是
 * 「lock 过期了没」, **不是**「过期多久」⇒ 与数值无关。改小只影响这个测试跑多久。
 *
 * ## 本文件**不**覆盖的接线面(诚实写在明处)
 *
 * `MarketdataSyncWorker.onModuleInit()` 里的两件事被本文件**复刻**而非**执行**:
 * ① `new Worker` 的 options 选择 ② `QueueEvents('failed')` → `onJobFailed` 的挂钩。
 * 原因是前者把 30s 硬编码在里面、后者依赖前者。⇒ 这两行接线若被改坏, 本文件照样绿。
 *
 * ## 反例臂(一次性, 复跑命令)
 *
 * 「跑了绿」不构成证据。把 `SyncRunRecorder.convergeInterrupted` 的方法体临时改成
 * `return 0;` 后重跑, **两个用例都必须红**:
 *
 *     pnpm exec nx test server --skip-nx-cache -- test/integration/marketdata.interrupt-convergence.it.spec.ts
 *
 * 2026-08-23 实跑(两臂):
 *   · sabotage 臂 `Tests 2 failed (2)` —— 两例均在 `waitFor` 上超时, 即「旧行始终停在
 *     running、收敛从未发生」被如实观测到, **不是**断言层面的巧合绿转红;
 *   · 恢复后 `Tests 2 passed (2)`。
 * ⇒ 这两个用例对「收敛没跑」有区分度, 不是恒真断言。改动本文件的断言后请重跑这一对臂。
 */

/** 本 IT 专用维度键。自注册 executor 的路径**不读** `sync_dimension` 行, 故无需 seed。 */
const TEST_KEY = 'interrupt_probe' as DimensionKey;

/** lock TTL / stalled 扫描间隔 —— 与机制无关, 只决定本文件跑多久(理由见文件头)。 */
const LOCK_MS = 1_000;
const STALL_MS = 1_000;

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  optionCoverageThreshold: 1,
};

const PAYLOAD: DimensionJobPayload = {
  dimensionKey: TEST_KEY,
  mode: 'delta',
  asOf: '2026-06-03',
  triggeredBy: 'tick',
};

async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor 超时 (${timeoutMs}ms): ${label}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('#137 打断收敛全链 (真 Redis stalled 接管)', () => {
  let prisma: PrismaService;
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  /** 每个用例自己开/关的「进程」资源, 由 afterEach 统一兜底关闭。 */
  const openWorkers: Worker<MarketdataSyncJobPayload>[] = [];
  const openLifecycles: QueueRedisLifecycle[] = [];
  const openEvents: QueueEvents[] = [];

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    prisma = new PrismaService(stores.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await stores.drop();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await prisma.syncRun.deleteMany();
    const life = new QueueRedisLifecycle(stores.redisUrl);
    const q = new MarketdataSyncQueue(life.client, CFG);
    await q.queue.obliterate({ force: true });
    await q.queue.close();
    life.onApplicationShutdown();
  });

  /**
   * 关停被测「进程」。`close(true)` = force(不等 in-flight), 且对已断连的那一个可能永不 resolve
   * ⇒ 统一加时限兜底, 否则一个关不掉的 worker 会把整个文件挂死在 teardown 上。
   */
  async function shutdownAll() {
    await Promise.all(
      openWorkers
        .splice(0)
        .map((w) =>
          Promise.race([
            w.close(true).catch(() => undefined),
            new Promise((r) => setTimeout(r, 3_000)),
          ]),
        ),
    );
    await Promise.all(
      openEvents
        .splice(0)
        .map((e) =>
          Promise.race([
            e.close().catch(() => undefined),
            new Promise((r) => setTimeout(r, 3_000)),
          ]),
        ),
    );
    openLifecycles.splice(0).forEach((l) => l.onApplicationShutdown());
  }

  function buildRegistry(): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  /**
   * 起一个被测「进程」: 真 `MarketdataSyncWorker`(收敛触发点住在它的 `process` /
   * `onJobFailed` 里) + 一个把 BullMQ 参数调小的裸 `Worker` 驱动它(理由见文件头)。
   */
  function spawnProcess(opts: {
    executor: () => Promise<never> | ReturnType<DimensionExecutorRegistry['execute']>;
    maxStalledCount?: number;
    wireFailedEvents?: boolean;
  }) {
    const life = new QueueRedisLifecycle(stores.redisUrl);
    openLifecycles.push(life);
    const registry = buildRegistry();
    registry.registerExecutor(TEST_KEY, opts.executor as never);
    const queue = new MarketdataSyncQueue(life.client, CFG);
    const nest = new MarketdataSyncWorker(
      life.client,
      registry,
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const bull = new Worker<MarketdataSyncJobPayload>(
      MARKETDATA_SYNC_QUEUE,
      (job) => nest.process(job),
      {
        connection: life.client,
        concurrency: 1,
        lockDuration: LOCK_MS,
        stalledInterval: STALL_MS,
        ...(opts.maxStalledCount !== undefined ? { maxStalledCount: opts.maxStalledCount } : {}),
      },
    );
    // 断连后 worker 会持续报连接错 —— 吞掉, 否则 unhandled 'error' 会把进程带崩。
    bull.on('error', () => undefined);
    openWorkers.push(bull);

    if (opts.wireFailedEvents === true) {
      // 复刻 onModuleInit 的挂钩(文件头已声明: 复刻而非执行)。
      const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: life.client });
      openEvents.push(events);
      events.on('failed', ({ jobId, failedReason }) => {
        void nest.onJobFailed(jobId, failedReason);
      });
    }
    return { life, queue, bull };
  }

  it('触发点 A: worker 猝死 → stalled 交回同 jobId → 旧行 interrupted + 新行 success', async () => {
    // 收敛日志是**命中行数**的唯一观察面 —— 顺序断言靠它, 理由见本用例末尾。
    const logs: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    try {
      // ── 进程 1: 开出 running 行后卡住(= 部署那一刻正在跑的那个 job)
      const p1 = spawnProcess({ executor: () => new Promise<never>(() => undefined) });
      await p1.bull.waitUntilReady();
      const job = await p1.queue.enqueueDimensionJob(PAYLOAD, { retryMax: 3 });
      const jobId = job.id as string;

      await waitFor(
        '进程1 开出 running 行',
        async () =>
          (await prisma.syncRun.count({ where: { bullJobId: jobId, status: 'running' } })) === 1,
      );

      // ── 「换容器」: 强断连接、不 close —— 等价性论证见文件头
      p1.life.onApplicationShutdown();

      // ── 进程 2: 接管
      spawnProcess({
        executor: async () => ({
          stats: { scanned: 2, ok: 2, skipped: 0, failed: 0, written: 2, findings: [] },
          budgetExhausted: false,
        }),
      });

      await waitFor(
        '进程2 完成重跑',
        async () =>
          (await prisma.syncRun.count({ where: { bullJobId: jobId } })) === 2 &&
          (await prisma.syncRun.count({ where: { bullJobId: jobId, status: 'running' } })) === 0,
      );

      const rows = await prisma.syncRun.findMany({
        where: { bullJobId: jobId },
        orderBy: { id: 'asc' },
      });
      expect(rows).toHaveLength(2);
      const [interrupted, retried] = rows;

      // ① 被打断那一轮落到可与「真的在跑」区分开的终态, 且带收尾时刻(否则报告脚本永远给它挂「未收尾」)。
      expect(interrupted?.status).toBe('interrupted');
      expect(interrupted?.finishedAt).not.toBeNull();
      expect(JSON.stringify(interrupted?.findings)).toContain('接管重跑');

      // ② 重跑那一轮正常收尾 —— 收敛**没有**误伤它。
      expect(retried?.status).toBe('success');
      expect(retried?.ok).toBe(2);

      // ③ 两行同 bull_job_id = 「同一次逻辑执行」在列上可关联(issue #137 判据②)。
      expect(interrupted?.bullJobId).toBe(jobId);
      expect(retried?.bullJobId).toBe(jobId);

      // ④ 🚨 顺序守卫, 且**只能这么守**。
      //    行状态本身守不住顺序: 收敛若跑在 start() 之后, updateMany 会同时命中旧行与新行
      //    (两行都 running) 把它们**都**收成 interrupted, 随后 finish() 又把新行写回 success
      //    ⇒ 最终状态与正确实现逐字节相同, 断言恒真。
      //    真正有区分度的是**命中了几行**: 正确实现恒为 1, 错序实现是 2。
      const convergeLog = logs.find((l) => l.includes('sync_run 收敛 interrupted'));
      expect(convergeLog, '收敛日志缺失 = 收敛压根没跑').toBeDefined();
      expect(convergeLog).toContain('"rows":1');
    } finally {
      await shutdownAll();
    }
  }, 120_000);

  it('触发点 B: stalled 超限直接 failed(不重跑) → 旧行仍收成 interrupted, 且不留第二行', async () => {
    try {
      // 进程 1 同上: 开出 running 行后卡住。
      const p1 = spawnProcess({ executor: () => new Promise<never>(() => undefined) });
      await p1.bull.waitUntilReady();
      const job = await p1.queue.enqueueDimensionJob(PAYLOAD, { retryMax: 1 });
      const jobId = job.id as string;

      await waitFor(
        '进程1 开出 running 行',
        async () =>
          (await prisma.syncRun.count({ where: { bullJobId: jobId, status: 'running' } })) === 1,
      );
      p1.life.onApplicationShutdown();

      // 进程 2 用 maxStalledCount: 0 ⇒ 这一次 stall 就超限。bullmq 给 job 打上 deferredFailure,
      // 下次取出时走 `getUnrecoverableErrorMessage` **直接失败、不调 processor** ⇒ 触发点 A
      // 永远不会跑, 只剩 `failed` 事件这一条路 —— 正是要验的那一半。
      spawnProcess({
        executor: async () => ({
          stats: { scanned: 0, ok: 0, skipped: 0, failed: 0, written: null, findings: [] },
          budgetExhausted: false,
        }),
        maxStalledCount: 0,
        wireFailedEvents: true,
      });

      await waitFor(
        '触发点 B 收敛完成',
        async () =>
          (await prisma.syncRun.count({ where: { bullJobId: jobId, status: 'interrupted' } })) ===
          1,
      );

      const rows = await prisma.syncRun.findMany({ where: { bullJobId: jobId } });
      // 没有接管者 ⇒ 只有一行, 且它没被留在 running。
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('interrupted');
      expect(rows[0]?.finishedAt).not.toBeNull();
      // reason 必须是「不会再重跑」那一条 —— 与触发点 A 的文案可分辨, 查表的人据此判断要不要补跑。
      expect(JSON.stringify(rows[0]?.findings)).toContain('重试已耗尽');
    } finally {
      await shutdownAll();
    }
  }, 120_000);
});
