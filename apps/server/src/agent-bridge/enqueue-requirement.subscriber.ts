import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { OutboxSubscriberRegistry } from '../security/outbox/outbox-subscriber.registry';
import type {
  OutboxEventDelivery,
  OutboxSubscriber,
} from '../security/outbox/outbox-subscriber.port';

/**
 * 主题契约 (跨 leaf ctx 不可 import, 两端各持同一字面量):
 * - 事件类型 = ideation generate-brief converged 分支 publish 的 eventType。
 * - bizType = AgentQueueEvent 的业务类型枚举 (master plan 信封)。
 */
const IDEATION_REQUIREMENT_FINALIZED = 'ideation.requirement-finalized';
const BIZ_TYPE_IDEATION_REQUIREMENT = 'ideation.requirement';

/**
 * P1.5 入队消费方 (R3 CROSS-CONTEXT-ASYNC 的消费端)。ideation 定稿 publish
 * `ideation.requirement-finalized` → outbox relay 分发到此 → 插一条 AgentQueueEvent
 * (bizType=ideation.requirement, bizId=sessionId)。worker 后续 poll 到后凭委托 token 调
 * 现成 ideation 端点拉胖数据 (claim-check)。
 *
 * **幂等** (relay at-least-once): sourceEventId=outbox 主键 @unique → createMany
 * skipDuplicates 重投不重复入队。OnModuleInit 自注册进平台层 OutboxSubscriberRegistry
 * (IoC, security 不反向依赖 agent-bridge)。
 */
@Injectable()
export class EnqueueRequirementSubscriber implements OutboxSubscriber, OnModuleInit {
  private readonly logger = new Logger(EnqueueRequirementSubscriber.name);
  readonly eventType = IDEATION_REQUIREMENT_FINALIZED;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: OutboxSubscriberRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(delivery: OutboxEventDelivery): Promise<void> {
    const { accountId, sessionId } = delivery.data;
    if (
      typeof accountId !== 'string' ||
      !/^\d+$/.test(accountId) ||
      typeof sessionId !== 'string' ||
      !sessionId
    ) {
      // 契约漂移 (生产方 payload 形状不符) → 跳过 + 错误日志, **不抛** (否则 cron 卡死重投毒丸事件)。
      this.logger.error(
        `malformed ${IDEATION_REQUIREMENT_FINALIZED} data, skipped: ${JSON.stringify(delivery.data)}`,
      );
      return;
    }

    await this.prisma.agentQueueEvent.createMany({
      data: [
        {
          accountId: BigInt(accountId),
          bizType: BIZ_TYPE_IDEATION_REQUIREMENT,
          bizId: sessionId,
          sourceEventId: delivery.sourceEventId,
        },
      ],
      skipDuplicates: true, // sourceEventId @unique → relay 重投幂等
    });
  }
}
