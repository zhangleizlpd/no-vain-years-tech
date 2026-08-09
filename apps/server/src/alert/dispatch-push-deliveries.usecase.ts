import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { PUSH_GATEWAY, type PushGateway } from './push-gateway.port';
import { renderAlertPushCopy, type PushConditionSnapshot } from './alert-push-copy.rules';

/** 单 delivery 最大 send 尝试数 (plan D4: attempts+1 后 ≥3 → FAILED)。 */
export const PUSH_MAX_ATTEMPTS = 3;

/** backoff 表 (plan D4 1m/5m/15m); MAX_ATTEMPTS=3 实际用前两档, 15m 为上限上调预留。 */
const BACKOFF_MINUTES = [1, 5, 15] as const;

/** retryable 失败后的转移决策 (纯函数, 测试锚): 耗尽 → failed / 否则排期下次尝试。 */
export function nextRetryDecision(
  prevAttempts: number,
  now: Date,
): { kind: 'failed'; attempts: number } | { kind: 'retry'; attempts: number; nextAttemptAt: Date } {
  const attempts = prevAttempts + 1;
  if (attempts >= PUSH_MAX_ATTEMPTS) return { kind: 'failed', attempts };
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1]!;
  return { kind: 'retry', attempts, nextAttemptAt: new Date(now.getTime() + minutes * 60_000) };
}

/** 一轮 dispatch 汇总 (CLI/processor 日志用, FR-009 round 级可观测)。 */
export interface DispatchPushSummary {
  /** 本轮扫到的到期 PENDING 行数。 */
  scanned: number;
  sent: number;
  /** retryable → 已排期下次尝试 (仍 PENDING)。 */
  retryScheduled: number;
  /** 耗尽 / trigger 快照缺失 → FAILED 终态。 */
  failed: number;
  /** RegID 无效 → FAILED_INVALID (+binding 删除, FR-010)。 */
  failedInvalid: number;
  /** dispatch 时绑定已不存在/已转绑 → SKIPPED_UNBOUND (FR-003 服务端兜底)。 */
  skippedUnbound: number;
  /** 单行未预期异常 (行保持 PENDING, 下轮 sweep 重扫)。 */
  errors: number;
}

/**
 * 022 US1 — push_delivery 消费端 (dispatch worker 核心 UC; processor/CLI 共用入口)。
 *
 * 流程 (plan §dispatch, split-tx per playbook §外部 I/O): 扫 `status=PENDING AND
 * (nextAttemptAt IS NULL OR <= now)` → 逐行: 复核 binding (registrationId+accountId
 * 仍匹配? 否 → SKIPPED_UNBOUND, 登出/转绑后零送达的服务端兜底) → join trigger 读
 * 快照 → T003 纯函数渲染 → **tx 外**调 gateway → 按结果标态。
 *
 * 标态全走 conditional updateMany affected-count (where {id, status:'PENDING'}):
 * 并发轮次/人工干预下 lost update 自然 no-op, 结构性免 P2025 (playbook §并发)。
 * - ok            → SENT + sentAt
 * - retryable     → attempts+1 + nextAttemptAt=backoff(1m/5m); attempts≥3 → FAILED
 *                   + lastError (D4 有限重试)。gateway 调用抛异常同折叠 retryable
 *                   (发送结果不确定 → 有限重试而非无限滞留 PENDING)
 * - invalid_target→ FAILED_INVALID + 删对应 push_binding (FR-010 防重试风暴)
 *
 * 失败隔离: 逐行独立 try/catch, 未预期异常 (标态 DB 写炸等) 记日志继续本轮其余行,
 * 行留 PENDING 由 5min repeatable sweep 兜底 (playbook §scheduler)。推送任何失败不触碰
 * trigger 流水 — 消息中心兜底面 100% 不受影响 (FR-004)。
 */
@Injectable()
export class DispatchPushDeliveriesUseCase {
  private readonly logger = new Logger(DispatchPushDeliveriesUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_GATEWAY) private readonly gateway: PushGateway,
  ) {}

  async execute(): Promise<DispatchPushSummary> {
    const now = new Date();
    const due = await this.prisma.pushDelivery.findMany({
      where: {
        status: 'PENDING',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { id: 'asc' },
    });
    const summary: DispatchPushSummary = {
      scanned: due.length,
      sent: 0,
      retryScheduled: 0,
      failed: 0,
      failedInvalid: 0,
      skippedUnbound: 0,
      errors: 0,
    };

    for (const row of due) {
      try {
        // 复核 binding: 创建时快照可能已失效 (登出解绑 / 他账号转绑) → 不发不重试。
        const binding = await this.prisma.pushBinding.findUnique({
          where: { registrationId: row.registrationId },
          select: { accountId: true },
        });
        if (binding === null || binding.accountId !== row.accountId) {
          await this.markPending(row.id, { status: 'SKIPPED_UNBOUND' });
          summary.skippedUnbound += 1;
          continue;
        }

        // join trigger 读快照 (流水自立永不删, 缺失 = 防御分支)。
        const trigger = await this.prisma.alertTrigger.findUnique({
          where: { id: row.triggerId },
          select: { instrumentName: true, conditionsSnapshot: true },
        });
        if (trigger === null) {
          await this.markPending(row.id, {
            status: 'FAILED',
            lastError: 'trigger snapshot missing',
          });
          summary.failed += 1;
          continue;
        }

        const copy = renderAlertPushCopy({
          instrumentName: trigger.instrumentName,
          conditionsSnapshot: trigger.conditionsSnapshot as unknown as PushConditionSnapshot[],
        });

        // tx 外调 gateway (split-tx); 抛异常折叠 retryable — 结果不确定走有限重试。
        const result = await this.gateway
          .send({
            registrationId: row.registrationId,
            title: copy.title,
            body: copy.body,
            triggerId: row.triggerId,
          })
          .catch((e: unknown) => ({
            kind: 'retryable' as const,
            detail: e instanceof Error ? e.message : String(e),
          }));

        if (result.kind === 'ok') {
          await this.markPending(row.id, { status: 'SENT', sentAt: new Date() });
          summary.sent += 1;
        } else if (result.kind === 'invalid_target') {
          await this.markPending(row.id, {
            status: 'FAILED_INVALID',
            lastError: truncateError(result.detail),
          });
          // FR-010: 极光明确判无效的 RegID 剔除注册面, 后续触发不再生成 delivery。
          await this.prisma.pushBinding.deleteMany({
            where: { registrationId: row.registrationId },
          });
          summary.failedInvalid += 1;
        } else {
          const decision = nextRetryDecision(row.attempts, new Date());
          if (decision.kind === 'failed') {
            await this.markPending(row.id, {
              status: 'FAILED',
              attempts: decision.attempts,
              lastError: truncateError(result.detail),
            });
            summary.failed += 1;
          } else {
            await this.markPending(row.id, {
              attempts: decision.attempts,
              nextAttemptAt: decision.nextAttemptAt,
              lastError: truncateError(result.detail),
            });
            summary.retryScheduled += 1;
          }
        }
      } catch (e) {
        // 单行失败隔离: 行留 PENDING, */5min sweep 兜底重扫 (playbook §scheduler)。
        summary.errors += 1;
        this.logger.error(
          `dispatch delivery ${row.id.toString()} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    this.logger.log(
      `push dispatch round: scanned=${summary.scanned} sent=${summary.sent} ` +
        `retry=${summary.retryScheduled} failed=${summary.failed} ` +
        `invalid=${summary.failedInvalid} unbound=${summary.skippedUnbound} errors=${summary.errors}`,
    );
    return summary;
  }

  /** conditional 标态: 仍 PENDING 才转移 (affected-count 体例, 并发轮次 lost → no-op)。 */
  private async markPending(
    id: bigint,
    data: {
      status?: string;
      attempts?: number;
      nextAttemptAt?: Date;
      sentAt?: Date;
      lastError?: string;
    },
  ): Promise<void> {
    await this.prisma.pushDelivery.updateMany({ where: { id, status: 'PENDING' }, data });
  }
}

/** lastError 截断到列宽 VarChar(256)。 */
function truncateError(detail: string | undefined): string {
  return (detail ?? 'unknown error').slice(0, 256);
}
