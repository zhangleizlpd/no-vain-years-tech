import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module.js';
import { WorkerAuthGuard } from '../security/worker-auth.guard.js';
import { AgentQueueController } from './agent-queue.controller.js';
import { ClaimNextEventUseCase } from './claim-next-event.usecase.js';
import { ExtendLeaseUseCase } from './extend-lease.usecase.js';
import { CompleteEventUseCase } from './complete-event.usecase.js';
import { EnqueueRequirementSubscriber } from './enqueue-requirement.subscriber.js';

/**
 * agent-bridge bounded context (第 9 ctx; ADR-0032 7 问 Q4 全新业务领域 —
 * master plan 2026-06-26-app-to-mac-openclaw-event-channel)。App → 本地常驻 agent
 * (OpenClaw) 的通用事件通路: app 产瘦事件入队, 远程 worker 出站轮询 claim, 凭委托
 * token 调现成业务 API 拉胖数据 (claim-check)。
 *
 * **叶子 ctx, 比 chat/ideation 更精简**: 只依赖 security 平台基座
 * (PrismaService 直查自有 AgentQueueEvent 表 + JWT 签发委托 token + OutboxPublisher
 * 消费上游事件 + ProblemDetailFilter)。**不 import account** — 队列端点 (poll/ack/result)
 * 用自有 WorkerAuthGuard (通道层 worker token) 鉴权, 非用户 JWT, 故无需 account 的
 * JwtAuthGuard/AccountIdThrottlerGuard。无人依赖 agent-bridge (叶子, 入队走 R3 Outbox
 * 消费, 上游 publish 不 import 本 ctx)。范式 = ADR-0043 扁平 + 贫血 Prisma row。
 *
 * P1.2: WorkerAuthGuard (通道层鉴权) + AGENT_WORKER_TOKEN config。
 * P1.3: 委托 token 直接复用 security JwtTokenService (决策门3 PoC; claim 时内联签发,
 *   无独立 service)。
 * P1.4 (本): AgentQueueController (poll/ack/result) + 三 usecase
 *   (claim-next-event FOR UPDATE SKIP LOCKED 原子 claim + extend-lease 续租 +
 *   complete-event 终态)。
 * P1.5 (本): EnqueueRequirementSubscriber — 消费上游 `ideation.requirement-finalized`
 *   (R3 Outbox, OnModuleInit 自注册进平台层 OutboxSubscriberRegistry) → 插 AgentQueueEvent。
 */
@Module({
  imports: [SecurityModule],
  controllers: [AgentQueueController],
  providers: [
    WorkerAuthGuard,
    ClaimNextEventUseCase,
    ExtendLeaseUseCase,
    CompleteEventUseCase,
    EnqueueRequirementSubscriber,
  ],
})
export class AgentBridgeModule {}
