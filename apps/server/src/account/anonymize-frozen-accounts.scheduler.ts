import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../security/prisma.service';
import { AccountStatus } from './account.rules';
import { CommitAccountAnonymizationUseCase } from './commit-account-anonymization.usecase';

/** 一轮扫描派发统计 (供单测断言 + 可观测 ERROR log 上报)。 */
export interface AnonymizeRunStats {
  scanned: number;
  anonymized: number;
  skipped: number;
  failed: number;
}

const BATCH_SIZE = 100;
const FAILURE_ALERT_THRESHOLD = 3;

/**
 * AnonymizeFrozenAccountsScheduler — 冻结期满匿名化定时任务 (FR-S13/S15)。
 *
 * 每日 03:00 (Asia/Shanghai) 扫 `status=FROZEN ∧ freezeUntil<=now` (偏索引
 * idx_account_freeze_until_active, 每批上限 100) → 逐 id 调 commitAccountAnonymization
 * (后者**自开 tx** = 每行独立 REQUIRES_NEW 等价, 单行失败被隔离)。
 *
 * 失败分级 (FR-S15): 领域拒绝 (won=false: phone-null / grace 漂移 / 锁冲突) = skip 不计
 * failure; 抛异常 (策略错 / infra) = failure。本轮 failure 累计达阈值 (3) → ERROR log
 * 告警 (结构化字段供 log-based alerting; Prometheus counter 后续按需接, 避免 account→
 * observability 跨 ctx 注入)。
 *
 * `@Cron` 由 e2e / 手动触发验; 单测直调 `run(now)` 测纯扫描+派发逻辑 (注入 mock usecase)。
 */
@Injectable()
export class AnonymizeFrozenAccountsScheduler {
  private readonly logger = new Logger(AnonymizeFrozenAccountsScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commitAccountAnonymization: CommitAccountAnonymizationUseCase,
  ) {}

  @Cron('0 0 3 * * *', { timeZone: 'Asia/Shanghai' })
  async handleCron(): Promise<void> {
    await this.run(new Date());
  }

  async run(now: Date): Promise<AnonymizeRunStats> {
    const candidates = await this.prisma.account.findMany({
      where: { status: AccountStatus.FROZEN, freezeUntil: { lte: now } },
      take: BATCH_SIZE,
      select: { id: true },
    });

    const stats: AnonymizeRunStats = {
      scanned: candidates.length,
      anonymized: 0,
      skipped: 0,
      failed: 0,
    };

    for (const { id } of candidates) {
      try {
        const { won } = await this.commitAccountAnonymization.execute(id, now);
        if (won) {
          stats.anonymized += 1;
        } else {
          stats.skipped += 1; // 领域拒绝 (幂等 / 状态漂移) — 不计失败
        }
      } catch (err) {
        // 单行异常被隔离, 不阻塞 sibling (commit 自持 tx, 已回滚本行)。
        stats.failed += 1;
        this.logger.warn(
          `anonymize failed account=${id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (stats.failed >= FAILURE_ALERT_THRESHOLD) {
      this.logger.error(
        `anonymize batch failures reached alert threshold: ${JSON.stringify({
          ...stats,
          threshold: FAILURE_ALERT_THRESHOLD,
        })}`,
      );
    }

    return stats;
  }
}
