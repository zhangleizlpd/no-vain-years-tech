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

export type SyncRunStatus = 'success' | 'partial' | 'failed' | 'skipped';

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
