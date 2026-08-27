import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueueEvents, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { AppModule } from '../app/app.module.js';
import { marketdataSyncConfig, type MarketdataSyncConfig } from '../config/marketdata.config.js';
import { PrismaService } from '../security/prisma.service.js';
import { DIMENSION_KEYS, type DimensionKey } from './dimension-executor.js';
import { MARKETDATA_QUEUE_REDIS } from './marketdata-queue-connection.js';
import {
  DEFAULT_QUEUE_LANE,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
  queueNameForLane,
  type QueueLane,
} from './marketdata-sync.queue.js';
import {
  assembleSyncFlow,
  assertHardEdgesWithinLane,
  deriveExecutionOrder,
  type FlowDimensionInput,
  type SyncDependencyEdge,
} from './sync-flow-assembler.js';
import { assertClosedSessionForManualSync } from './manual-sync-session-guard.js';
import { userToday } from './session-clock.js';
import { resolveAsOfForDimension } from './sync-asof.rules.js';
import type { SyncRunStats } from './sync-run.recorder.js';

/**
 * Trigger CLI (017 T017, FR-S15/S15a): 手动触发单维度 / `--cascade` 级联下游同步。
 *
 * 与 backfill CLI 职责分开 (trigger = delta 补当期 / backfill = 历史深回填)。镜像其三段式:
 * `parseTriggerArgs` 纯解析 + `executeTrigger` 纯逻辑 (注入 deps, testcontainers IT 直测)
 * + `runTrigger` NestFactory 接线 + argv[1] entry-guard。
 *
 * **CLI 永不起 worker** (clarify Q2, plan D6): entry 在 `createApplicationContext` 前置
 * `MARKETDATA_WORKER_DISABLED` sentinel → 本进程只入队不消费, 全局唯一 worker 在 server
 * 进程 (互斥不变量靠拓扑保证)。server 不在线 → 等待超时退出码 2 + 可操作错误信息。
 *
 * 退出码: 0 = job 成功且零 failed / 1 = job 失败或 partial (failed>0) / 2 = 等待超时。
 */

export interface TriggerArgs {
  dimension: DimensionKey;
  cascade: boolean;
  /**
   * 以此 `YYYY-MM-DD` 为目标日, **压倒逐维度求值** (D9: gate 归 tick 层, CLI 视为运维显式意图)。
   * 缺省 ⇒ 每个维度按自己声明的口径求 (`sync-asof.rules.ts`), 而**不是**一个全局的宿主日。
   */
  asOf?: string;
  /** 等待 job 终态上限 ms (默认 config `cliWaitTimeoutMs`)。 */
  timeoutMs?: number;
}

/** 解析 argv: `--dimension eod_bar --cascade --as-of 2026-06-04 --timeout 5000`。 */
export function parseTriggerArgs(argv: string[]): TriggerArgs {
  let dimension: string | undefined;
  let cascade = false;
  let asOf: string | undefined;
  let timeoutMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cascade') cascade = true;
    else if (a === '--dimension') dimension = argv[++i];
    else if (a === '--as-of') asOf = argv[++i];
    else if (a === '--timeout') timeoutMs = Number(argv[++i]);
  }
  if (!dimension) throw new Error('--dimension <key> 必填 (值域 = 注册维度键)');
  // 维度键校验源 = 注册表 keys (019 T004; 执行序与值域解耦, 全序常量 T005 退役)。
  if (!DIMENSION_KEYS.includes(dimension as DimensionKey)) {
    throw new Error(`未知维度键 "${dimension}" (值域: ${DIMENSION_KEYS.join(',')})`);
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('--timeout 须为正整数 ms');
  }
  return {
    dimension: dimension as DimensionKey,
    cascade,
    ...(asOf !== undefined ? { asOf } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/**
 * cascade 传递性下游闭包 (不含根, FR-S15「不含已成功上游」天然满足 — 只沿 downstream 走)。
 * 内存 BFS (6 行表, plan §7); 复杂度 O(V+E)。
 */
export function cascadeClosure(root: string, edges: SyncDependencyEdge[]): string[] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.upstream) ?? [];
    list.push(e.downstream);
    adjacency.set(e.upstream, list);
  }
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const next of adjacency.get(cur) ?? []) {
      if (next === root || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen];
}

/**
 * 等 job 终态 → 退出码 (两 CLI 统一, plan §H1): 0 = 成功且零 failed / 1 = job 失败或
 * partial (failed>0) / 2 = 等待超时 (含 server worker 不在线, 可操作错误信息)。
 *
 * 自管 race 超时 (不用 waitUntilFinished(ttl) — 其超时只能靠报错消息嗅探区分 job 业务
 * 失败, 业务报错含 "timed out" 会误判; race 映射退出码是确定性的)。
 */
export async function waitJobExitCode(
  job: Job,
  queueEvents: QueueEvents,
  timeoutMs: number,
  logger: Logger,
): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      job.waitUntilFinished(queueEvents).then(
        (stats) => ({ kind: 'done' as const, stats: stats as SyncRunStats }),
        (err: unknown) => ({ kind: 'failed' as const, error: String(err) }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
    if (outcome.kind === 'timeout') {
      logger.error(
        `等待 job 终态超时 (${timeoutMs}ms) — server worker 不在线? CLI 永不起 worker (D6), ` +
          '消费靠 server 进程唯一 worker; 确认 server 运行中或调大 --timeout',
      );
      return 2;
    }
    if (outcome.kind === 'failed') {
      logger.error(`job 失败: ${outcome.error}`);
      return 1;
    }
    logger.log(`job done: ${JSON.stringify(outcome.stats)}`);
    return outcome.stats.failed > 0 ? 1 : 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 一个待等待的树根 / 单 job, 连同它所在的 lane (决定用哪个 QueueEvents 等)。 */
export interface LaneJob {
  job: Job;
  lane: QueueLane;
}

/**
 * 等待**多条 lane** 的根 job, 取最差退出码 (#210)。
 *
 * 退出码语义沿用 {@link waitJobExitCode}: 0 全绿 / 1 有失败 / 2 等待超时。取 `Math.max` ⇒
 * 任一超时即 2、任一失败即 1 —— **禁止**用「最后一个」或「第一个」的码, 那会让另一条 lane
 * 的失败在退出码上消失, 而运维只看退出码。
 *
 * 并行等待而非顺序: 两条 lane 本就并行执行, 顺序等会把 timeout 预算变成两倍墙钟。
 */
export async function waitLaneJobsExitCode(
  roots: readonly LaneJob[],
  queueEventsFor: (lane: QueueLane) => QueueEvents,
  timeoutMs: number,
  logger: Logger,
): Promise<number> {
  const codes = await Promise.all(
    roots.map((r) => waitJobExitCode(r.job, queueEventsFor(r.lane), timeoutMs, logger)),
  );
  return codes.reduce((worst, c) => Math.max(worst, c), 0);
}

/**
 * 进程级 per-lane QueueEvents 缓存 + 统一关闭 —— 两个 CLI entry 共用。
 * 懒建: 只有真的用到那条 lane 才连 Redis。
 */
export function createLaneQueueEvents(connection: Redis): {
  queueEventsFor: (lane: QueueLane) => QueueEvents;
  closeAll: () => Promise<void>;
} {
  const cache = new Map<QueueLane, QueueEvents>();
  return {
    queueEventsFor: (lane) => {
      const hit = cache.get(lane);
      if (hit !== undefined) return hit;
      const created = new QueueEvents(queueNameForLane(lane), { connection });
      cache.set(lane, created);
      return created;
    },
    closeAll: async () => {
      for (const events of cache.values()) await events.close();
    },
  };
}

export interface TriggerDeps {
  prisma: PrismaService;
  syncQueue: MarketdataSyncQueue;
  /**
   * 按 lane 取 QueueEvents (#210)。**不能再是单个实例** —— `waitUntilFinished` 必须用**该
   * job 所在队列**的 QueueEvents, 拿 default 的去等 futu lane 的 job 会一直等到超时退 2,
   * 那是个看起来像「worker 没在线」的假象。
   */
  queueEventsFor: (lane: QueueLane) => QueueEvents;
  cliWaitTimeoutMs: number;
}

/** trigger 编排: 入队 (单 job / cascade flow) → 等终态 → 退出码 0/1/2。 */
export async function executeTrigger(
  deps: TriggerDeps,
  args: TriggerArgs,
  now: Date,
  logger: Logger = new Logger('marketdata-trigger'),
): Promise<number> {
  const timeoutMs = args.timeoutMs ?? deps.cliWaitTimeoutMs;

  // cascade won 集 = {root + 传递性下游闭包}; 非 cascade 单维度。
  const edges = args.cascade
    ? ((await deps.prisma.syncDependency.findMany({
        select: { upstream: true, downstream: true, mode: true },
      })) as SyncDependencyEdge[])
    : [];
  const keys = args.cascade
    ? [args.dimension, ...cascadeClosure(args.dimension, edges)]
    : [args.dimension];

  // retryMax 从真相层载 (attempts 注入语义与 tick 同源); 缺行 = seed 残缺, fail-fast。
  const rows = await deps.prisma.syncDimension.findMany({
    where: { dimensionKey: { in: keys } },
    select: { dimensionKey: true, retryMax: true, marketScope: true, queueLane: true },
  });
  const retryByKey = new Map(rows.map((r) => [r.dimensionKey, r.retryMax]));
  const laneByKey = new Map(
    rows.map((r) => [r.dimensionKey, deps.syncQueue.resolveLane(r.queueLane)]),
  );
  const laneOf = (key: string): QueueLane => laneByKey.get(key) ?? DEFAULT_QUEUE_LANE;
  const missing = keys.filter((k) => !retryByKey.has(k));
  if (missing.length > 0) {
    throw new Error(`sync_dimension 缺行: ${missing.join(',')} (seed 残缺或维度未登记)`);
  }

  // 🚨 `asOf` 现在是**逐维度**求值 (063 Phase 1), 不再是一个全局值。
  //
  // 旧实现是 `args.asOf ?? shanghaiToday(now)` —— **宿主日**, 两处错:
  //   ① 对 us 维度错位一天且**每周固定丢掉周五** (失败形态表见 `session-clock.ts`);
  //   ② 不判「这一场收了没有」⇒ 盘中敲一条命令就把半根 K 焊进库里 (#103 的止血正是被这条
  //      逼着显式传 `--as-of` 才做成的)。
  // `--cascade` / 全维度模式下各维 `marketScope` 不同 ⇒ 一个全局值在结构上就不可能都对。
  //
  // ⚠️ **`--as-of` 显式传入仍压倒一切** —— 运维指向某个已结算交易日是显式意图 (D9),
  //    本改动只换缺省值。
  const asOfByKey = new Map(
    rows.map((r) => [r.dimensionKey, args.asOf ?? resolveAsOfForDimension(r, now)]),
  );
  const asOfOf = (key: string): string => asOfByKey.get(key) ?? args.asOf ?? userToday(now);

  // 🚨 时点闸 (2026-08-17 prod 实撞): 收盘口径的维度必须在该市场收盘后跑。**排在入队之前** ——
  // 入队之后再拦, 错行已经有一半机会落库了; 而这条命令的错误形态恰恰是「跑完了、还成功了」。
  // 判据与采集本体同源 (同一份 `session-clock.ts`), 理由见 manual-sync-session-guard.ts 的文件头。
  assertClosedSessionForManualSync(rows, now);

  const triggeredBy = args.cascade ? ('cascade' as const) : ('cli' as const);
  const roots: LaneJob[] = [];
  if (keys.length > 1) {
    // cascade 多维度 → 复用 D3 装配器组 flow, 等待树根 (根终态 = 整链终态)。
    // 全序派生与 tick 同源 (019 T005): 全维度行 priority + 边 → Kahn。
    const priorities = await deps.prisma.syncDimension.findMany({
      select: { dimensionKey: true, priority: true },
    });
    const executionOrder = deriveExecutionOrder(
      edges,
      new Map(priorities.map((p) => [p.dimensionKey, p.priority])),
    );
    // #210: cascade 闭包**可能跨 lane** (如 universe→hk_option_contract 那条 soft 边) ⇒
    // 与 tick 同样按 lane 分组、每条 lane 各一棵树, 然后等**全部**树根。
    // 🚫 别退化成「跨 lane 就报错让人分两次跑」—— `trigger --dimension hk_option_contract`
    //    是常规运维动作, 拿不到才是问题。
    assertHardEdgesWithinLane(edges, laneByKey);
    const inputsByLane = new Map<QueueLane, FlowDimensionInput[]>();
    for (const k of keys) {
      const lane = laneOf(k);
      const bucket = inputsByLane.get(lane) ?? [];
      bucket.push({
        payload: {
          dimensionKey: k as DimensionKey,
          mode: 'delta' as const,
          asOf: asOfOf(k),
          triggeredBy,
        },
        opts: deps.syncQueue.jobOpts({ retryMax: retryByKey.get(k) as number }),
        queueName: queueNameForLane(lane),
      });
      inputsByLane.set(lane, bucket);
    }
    for (const [lane, inputs] of inputsByLane) {
      const tree = assembleSyncFlow(inputs, edges, executionOrder);
      roots.push({ job: (await deps.syncQueue.enqueueFlow(tree)).job, lane });
    }
  } else {
    const lane = laneOf(args.dimension);
    roots.push({
      job: await deps.syncQueue.enqueueDimensionJob(
        { dimensionKey: args.dimension, mode: 'delta', asOf: asOfOf(args.dimension), triggeredBy },
        { retryMax: retryByKey.get(args.dimension) as number, lane },
      ),
      lane,
    });
  }
  // 🚨 逐维度打出 `asOf`: 盘中跑现在会**目标上一场** ⇒ 工作集多半已落库 ⇒ 一轮 `scanned=0`
  //    的空跑。不把日期打出来, 那就又是一个「全绿但什么都没做」的现场。
  logger.log(
    `trigger 入队: ${JSON.stringify({
      dimensions: keys,
      cascade: args.cascade,
      asOf: Object.fromEntries(keys.map((k) => [k, asOfOf(k)])),
      asOfExplicit: args.asOf !== undefined,
      timeoutMs,
    })}`,
  );
  return waitLaneJobsExitCode(roots, deps.queueEventsFor, timeoutMs, logger);
}

/** NestFactory 接线 entry: sentinel 前置 → 起 DI → executeTrigger → close。 */
export async function runTrigger(argv: string[]): Promise<number> {
  // D6 (clarify Q2): createApplicationContext 前置 sentinel → worker OnModuleInit no-op。
  process.env[MARKETDATA_WORKER_DISABLED] = '1';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const connection = app.get<Redis>(MARKETDATA_QUEUE_REDIS);
  const { queueEventsFor, closeAll } = createLaneQueueEvents(connection);
  try {
    const cfg = app.get<MarketdataSyncConfig>(marketdataSyncConfig.KEY);
    return await executeTrigger(
      {
        prisma: app.get(PrismaService),
        syncQueue: app.get(MarketdataSyncQueue),
        queueEventsFor,
        cliWaitTimeoutMs: cfg.cliWaitTimeoutMs,
      },
      parseTriggerArgs(argv),
      new Date(),
    );
  } finally {
    await closeAll();
    await app.close();
  }
}

// entry guard: 仅 `node .../marketdata-trigger.cli.js` 直跑时执行 (argv[1] 文件名判定,
// backfill CLI L138-142 先例)。解析错误 (--dimension 缺失等) → stderr + 退出码 1。
if (process.argv[1]?.includes('marketdata-trigger')) {
  void runTrigger(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(String(err));
      process.exit(1);
    },
  );
}
