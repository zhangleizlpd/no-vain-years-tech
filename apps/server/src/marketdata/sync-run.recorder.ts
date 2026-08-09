import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';

/** 单次同步执行的派发统计 + 失败目标 (SyncRun 收尾写入)。 */
export interface SyncRunStats {
  scanned: number;
  ok: number;
  skipped: number;
  failed: number;
  /** 失败目标明细 (续跑/重试源 + 可 grep), 每项形如 {symbol, step, error}。 */
  failedTargets: unknown[];
}

export type SyncRunStatus = 'success' | 'partial' | 'failed' | 'skipped';

/** 空统计起点 (调用方累加)。 */
export function emptyStats(): SyncRunStats {
  return { scanned: 0, ok: 0, skipped: 0, failed: 0, failedTargets: [] };
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

  /** 收尾: 写终态 + 计数 + failedTargets(Json) + finishedAt。 */
  async finish(id: bigint, status: SyncRunStatus, stats: SyncRunStats, now: Date): Promise<void> {
    await this.prisma.syncRun.update({
      where: { id },
      data: {
        status,
        scanned: stats.scanned,
        ok: stats.ok,
        skipped: stats.skipped,
        failed: stats.failed,
        failedTargets:
          stats.failedTargets.length > 0
            ? (stats.failedTargets as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        finishedAt: now,
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
