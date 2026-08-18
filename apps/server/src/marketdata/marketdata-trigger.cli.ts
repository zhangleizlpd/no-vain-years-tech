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
  MARKETDATA_SYNC_QUEUE,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
} from './marketdata-sync.queue.js';
import {
  assembleSyncFlow,
  deriveExecutionOrder,
  type SyncDependencyEdge,
} from './sync-flow-assembler.js';
import { assertClosedSessionForManualSync } from './manual-sync-session-guard.js';
import { shanghaiToday } from './trading-day-gate.js';
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
  /** 以此 `YYYY-MM-DD` 为目标日 (默认上海时区当天; D9: gate 归 tick 层, CLI 视为运维显式意图)。 */
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

export interface TriggerDeps {
  prisma: PrismaService;
  syncQueue: MarketdataSyncQueue;
  queueEvents: QueueEvents;
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
  const asOf = args.asOf ?? shanghaiToday(now);

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
    select: { dimensionKey: true, retryMax: true, marketScope: true },
  });
  const retryByKey = new Map(rows.map((r) => [r.dimensionKey, r.retryMax]));
  const missing = keys.filter((k) => !retryByKey.has(k));
  if (missing.length > 0) {
    throw new Error(`sync_dimension 缺行: ${missing.join(',')} (seed 残缺或维度未登记)`);
  }

  // 🚨 时点闸 (2026-08-17 prod 实撞): 收盘口径的维度必须在该市场收盘后跑。**排在入队之前** ——
  // 入队之后再拦, 错行已经有一半机会落库了; 而这条命令的错误形态恰恰是「跑完了、还成功了」。
  // 判据与采集本体同源 (同一个 marketDateFor), 理由见 manual-sync-session-guard.ts 的文件头。
  assertClosedSessionForManualSync(rows, now);

  const triggeredBy = args.cascade ? ('cascade' as const) : ('cli' as const);
  let job: Job;
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
    const tree = assembleSyncFlow(
      keys.map((k) => ({
        payload: { dimensionKey: k as DimensionKey, mode: 'delta' as const, asOf, triggeredBy },
        opts: deps.syncQueue.jobOpts({ retryMax: retryByKey.get(k) as number }),
      })),
      edges,
      executionOrder,
    );
    job = (await deps.syncQueue.enqueueFlow(tree)).job;
  } else {
    job = await deps.syncQueue.enqueueDimensionJob(
      { dimensionKey: args.dimension, mode: 'delta', asOf, triggeredBy },
      { retryMax: retryByKey.get(args.dimension) as number },
    );
  }
  logger.log(
    `trigger 入队: ${JSON.stringify({ dimensions: keys, cascade: args.cascade, asOf, timeoutMs })}`,
  );
  return waitJobExitCode(job, deps.queueEvents, timeoutMs, logger);
}

/** NestFactory 接线 entry: sentinel 前置 → 起 DI → executeTrigger → close。 */
export async function runTrigger(argv: string[]): Promise<number> {
  // D6 (clarify Q2): createApplicationContext 前置 sentinel → worker OnModuleInit no-op。
  process.env[MARKETDATA_WORKER_DISABLED] = '1';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const connection = app.get<Redis>(MARKETDATA_QUEUE_REDIS);
  const queueEvents = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection });
  try {
    const cfg = app.get<MarketdataSyncConfig>(marketdataSyncConfig.KEY);
    return await executeTrigger(
      {
        prisma: app.get(PrismaService),
        syncQueue: app.get(MarketdataSyncQueue),
        queueEvents,
        cliWaitTimeoutMs: cfg.cliWaitTimeoutMs,
      },
      parseTriggerArgs(argv),
      new Date(),
    );
  } finally {
    await queueEvents.close();
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
