import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';

/** 单次同步执行的派发统计 + 失败目标 (SyncRun 收尾写入)。 */
export interface SyncRunStats {
  scanned: number;
  ok: number;
  skipped: number;
  failed: number;
  /**
   * 本次执行**实际发生了写操作的行数** (063 Phase 3.3); `null` = 本次**没有任何写路径上报**。
   * 三态语义 + 口径 + 「为什么不是 `@default(0)`」的判据见 `schema.prisma` 的 `SyncRun.written` 注释。
   *
   * 🚨 累加必须走 {@link addWritten}, **别直接 `+=`** —— `null + 1` 在 TS 里过不了、在 JS 里
   * 是 1 看着还对, 而 `stats.written! += n` 会把 null 起点变成 NaN 且一路不报错。
   */
  written: number | null;
  /** 失败目标明细 (续跑/重试源 + 可 grep), 每项形如 {symbol, step, error}。 */
  failedTargets: unknown[];
}

/**
 * SyncRun 终态值域。`interrupted` (#137) 是**基建打断**, 与 `failed` (业务/vendor 失败)
 * 刻意分开 —— 被换容器打断的那一轮由 BullMQ stalled 接管重跑, 把它记成失败会污染失败率。
 * 业内同一取舍: Nomad 的 `lost` 与 `failed` 并列, Oracle Scheduler 把被打断的作业记
 * `STOPPED` 而非 `FAILED`; K8s 的 `podFailurePolicy` 更进一步, 让基建打断**不计入**重试预算。
 *
 * 🚨 `interrupted` **只由收敛路径产出** ({@link SyncRunRecorder.convergeInterrupted}),
 * {@link deriveStatus} 永远不会返它 —— 它不是由计数派生的结论, 是「上一次没能自己收尾」的事后判定。
 */
export type SyncRunStatus = 'success' | 'partial' | 'failed' | 'skipped' | 'interrupted';

/**
 * `interrupted` 行落进 `failed_targets` 的判据文本 —— **两个触发点各有各的一句**, 因为它们
 * 回答的是不同的问题:「这一轮还会不会被重跑」。查表的人只看这一列就能分辨, 不必回溯队列。
 * (审计明细通道复用 `failed_targets`, 非失败语义 —— 同 {@link SyncRunRecorder.recordSkippedWithReason}。)
 */
export const INTERRUPT_REASON = {
  /** 同 job 的下一个 attempt 开工前扫地 ⇒ **已有接管者**, 本轮的活不会丢。 */
  SUPERSEDED_BY_RETRY:
    'interrupted: 上一 attempt 未收尾 (进程被替换 / 崩溃), 同 job 已由新 attempt 接管重跑',
  /** job 重试耗尽 (含 stalled 次数超限) ⇒ **不会再有接管者**, 这一轮的活是真的没做。 */
  RETRIES_EXHAUSTED: 'interrupted: attempt 未收尾且 job 重试已耗尽 — 不会再重跑',
} as const;

/**
 * 累加**实际发生了写操作的行数** (063 Phase 3.3)。第一次上报把 `null` 抬成数, 之后累加 ——
 * 「上报了 0 行」与「一次都没上报」因此在终值上可分辨, 而这正是本列存在的理由。
 *
 * ## 口径只有一条, 全维度统一 (#138 定): **「这一行发生了写吗」**
 *
 *   · `createMany(skipDuplicates)` 段传它报的 `count` —— 撞唯一键被跳过的行**没发生写**, 不计;
 *   · 逐行 `upsert` 段**按行传** —— insert 与 update 都是真的写了库。
 *
 * 🚨 盲区写在明处: upsert 段分辨不出「覆盖了但内容没变」⇒ 逐行 upsert 的维度 (hot_snapshot /
 * fundamental delta 等) 稳态恒等于当轮拿到的行数。它抓得到的是「vendor 整轮返空」= 0。要连
 * 「写了但没变」都分辨, 得走 PG `ON CONFLICT … RETURNING (xmax = 0)`, 代价是这些写路径全改
 * `$queryRaw` —— 2026-08-22 权衡后**明确不做**, 别当遗漏。
 *
 * 🚨 有写路径的维度**必须起手 `addWritten(stats, 0)` 声明一次** —— 否则「工作集为空 / vendor
 * 零行」的一轮会停在 `null`, 与「这个维度压根没接线」不可分辨, 而那正是 #138 的病根。
 */
export function addWritten(stats: SyncRunStats, rows: number): void {
  stats.written = (stats.written ?? 0) + rows;
}

/** 空统计起点 (调用方累加)。 */
export function emptyStats(): SyncRunStats {
  return { scanned: 0, ok: 0, skipped: 0, failed: 0, written: null, failedTargets: [] };
}

/**
 * SyncRunRecorder (016 T004, FR-S17): SyncRun 行生命周期 — 开 (running) / 收
 * (success|partial|failed|skipped + 计数 + failedTargets + finishedAt)。贫血 prisma row
 * 写 marketdata.sync_run (R1 自有表)。每次同步执行落一行, 是审计 + DLQ-lite + 水位载体。
 *
 * `finalStatus` 由计数派生 (FR-S17 log-based alerting 入口): failed>0 但 ok>0 → partial;
 * 全 failed → failed; 否则 success。skipped (非交易日) 由调用方显式传, 不经派生。
 */
@Injectable()
export class SyncRunRecorder {
  constructor(private readonly prisma: PrismaService) {}

  /** 开一行 running SyncRun, 返 id (后续 finish 引用)。`bullJobId` = per-dim worker 路径回链 (017)。 */
  async start(syncType: string, bullJobId?: string): Promise<bigint> {
    const run = await this.prisma.syncRun.create({
      data: { syncType, status: 'running', ...(bullJobId ? { bullJobId } : {}) },
      select: { id: true },
    });
    return run.id;
  }

  /**
   * 把同一 BullMQ job 上**没能自己收尾的 attempt** 收成 `interrupted` 终态 (#137), 返收敛行数。
   *
   * ## 判据是确定性的, 不靠任何时间阈值
   *
   * BullMQ 的 job lock 保证同一 `jobId` 任一时刻只被一个 worker 处理 ⇒「同 `bull_job_id` 还
   * 挂着 `running`」只可能是**被打断的上一次 attempt**, 不可能是活着的并发者。业内那些通用
   * 调度器 (Airflow 心跳超时 / Temporal Heartbeat Timeout) 只能用「多久没心跳就算死」这类概率
   * 判据, 是因为它们的执行体可能并发多实例; 本仓有 lock 互斥 + `bull_job_id` 恒非空 (见
   * `DimensionExecutorRegistry.execute` 注释), 故可以做到零阈值、零心跳。
   *
   * 🚨 **调用点必须在新行 INSERT 之前** —— 那是「绝不误伤自己」的全部依据, 顺序反了就会把刚
   * 开的那一行当僵尸收掉。两个调用点都在 `marketdata-sync.worker.ts`（BullMQ attempt 是它的
   * 领域知识, 不是 executor 的), 判据见那里。
   *
   * 🚨 `finishedAt` 记的是**收敛时刻, 不是被打断的时刻** —— 真正断在哪一秒没有任何人记得下来
   * (进程当时已经没了)。⇒ `interrupted` 行的 `finished_at - started_at` **不是耗时**: app 停机
   * 几天再起, 它就是几天。任何耗时统计必须把本终态排除掉 —— 而「能被排除」正是它独立成一个
   * 终态、而不是复用 `failed` 的收益所在。
   */
  async convergeInterrupted(
    bullJobId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<number> {
    const { count } = await this.prisma.syncRun.updateMany({
      where: { bullJobId, status: 'running' },
      data: {
        status: 'interrupted',
        finishedAt: now,
        // 未收尾的行 failedTargets 恒为 NULL ⇒ 这里是首写, 不会盖掉任何既有明细。
        failedTargets: [{ reason }] as Prisma.InputJsonValue,
      },
    });
    return count;
  }

  /**
   * 收尾: 写终态 + 计数 + failedTargets(Json) + finishedAt。
   *
   * 🚨 **`finishedAt` 默认取真实收尾时刻, 不吃调用方的「逻辑 now」** —— 那正是这个参数
   * 曾经的塌法: `DimensionExecutorRegistry` 一直传 `ExecutorInput.now` (job **起点**),
   * 于是 `finished_at ≈ started_at`、甚至更早 (`started_at` 走 PG `now()`, 落在 JS
   * `new Date()` 之后) ⇒ **任何一轮的耗时都读不出来**。2026-08-09 在 prod 验证限频修复时
   * 撞到: 一轮实耗 241 秒的链发现, 表里两个时间戳只差 44 毫秒, 只能改从 CLI 日志掐时间。
   *
   * 仍保留可传形态是给**零工作量收尾**用的 —— {@link recordSkipped} 那条路上, 调用方的
   * `now` 就是收尾时刻 (中间没有任何工作), 传进来比再取一次时钟更诚实。
   */
  async finish(
    id: bigint,
    status: SyncRunStatus,
    stats: SyncRunStats,
    finishedAt: Date = new Date(),
  ): Promise<void> {
    await this.prisma.syncRun.update({
      where: { id },
      data: {
        status,
        scanned: stats.scanned,
        ok: stats.ok,
        skipped: stats.skipped,
        failed: stats.failed,
        written: stats.written,
        failedTargets:
          stats.failedTargets.length > 0
            ? (stats.failedTargets as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        finishedAt,
      },
    });
  }

  /** 非交易日短路: 开一行 running 立即收为 skipped (零 vendor 调用, FR-S02)。 */
  async recordSkipped(syncType: string, now: Date): Promise<bigint> {
    const id = await this.start(syncType);
    await this.finish(id, 'skipped', emptyStats(), now);
    return id;
  }

  /**
   * freshness gate 跳过 (019 T014, FR-S03 审计痕): skipped 行 + 跳过原因 (failedTargets
   * Json 列承载 `[{reason}]` — 审计明细通道复用, 非失败语义)。
   */
  async recordSkippedWithReason(syncType: string, reason: string, now: Date): Promise<bigint> {
    const id = await this.start(syncType);
    await this.finish(id, 'skipped', { ...emptyStats(), failedTargets: [{ reason }] }, now);
    return id;
  }
}

/** 计数 → 终态派生 (skipped 由调用方显式, 不入此)。 */
export function deriveStatus(stats: SyncRunStats): SyncRunStatus {
  if (stats.failed === 0) return 'success';
  if (stats.ok > 0 || stats.skipped > 0) return 'partial';
  return 'failed';
}
