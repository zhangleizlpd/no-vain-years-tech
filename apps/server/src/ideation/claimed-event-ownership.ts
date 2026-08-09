import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * mockup 凭证 / 写记录端点是 **worker-token** 端点 (WorkerAuthGuard 只证「是合法 worker」,
 * 零用户 principal)。归属 scope (accountId, sessionId) **永远**由 server 据 channel 所认领的
 * claimed event 派生 —— channel **不得自报** account / session (防越权 + 混淆代理, 037 Q2 终判)。
 *
 * 那条 claimed event = `agentQueueEvent` (agent-bridge 表), 数据在 agent-bridge ctx。ideation
 * **跨 ctx 只读**它派生归属 (Q7-B 临时路径), **永不跨 ctx 写**。bizType 字面量在 ideation 本地
 * 定义常量, 不 import agent-bridge 私有 const (避免破 ESLint boundaries 单向边界)。
 */

/** worker 认领的 ideation requirement 事件 bizType (与 agent-bridge enqueue 端各持同一字面量)。 */
const CLAIMABLE_BIZ_TYPE = 'ideation.requirement';

/** claimed event 已认领状态 (claim-next 把 pending → claimed)。 */
const CLAIMED_STATUS = 'claimed';

/** 据 claimed event 派生出的归属 scope (worker-token 端点的真实 account / session)。 */
export interface ClaimedEventOwnership {
  accountId: bigint;
  sessionId: bigint;
}

@Injectable()
export class ClaimedEventOwnershipProvider {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 据 eventId 派生 worker 所认领任务的 (accountId, sessionId)。
   *
   * 命中条件 (三谓词必须全真, 否则视同越权 / 漂移 → 返 null, 由调用方反枚举不泄漏):
   *  - `id = eventId`            —— 该事件存在
   *  - `status = 'claimed'`      —— 已被某 worker 认领 (pending / done / 过期重投不算)
   *  - `bizType = 'ideation.requirement'` —— 是 ideation requirement 事件 (非他业务)
   *
   * `bizId` 是 String 列、语义 = sessionId → `BigInt(bizId)`; `accountId` 本就是 BigInt。
   * 只读单行 (复合索引 `agent_queue_event_claimable_idx` 不直接命中 id, 但 id 是主键 → PK 查),
   * 永不写他 ctx 表。
   */
  async derive(eventId: string): Promise<ClaimedEventOwnership | null> {
    // CROSS-CONTEXT-READ: 读 agent-bridge claimed AgentQueueEvent 派生 (accountId,sessionId)；只读、永不写
    const event = await this.prisma.agentQueueEvent.findFirst({
      where: { id: eventId, status: CLAIMED_STATUS, bizType: CLAIMABLE_BIZ_TYPE },
      select: { accountId: true, bizId: true },
    });
    if (!event) return null;

    // bizId 是 String 列 (信封), ideation requirement 事件的 bizId = sessionId 数字串。
    if (!/^\d+$/.test(event.bizId)) return null;

    return { accountId: event.accountId, sessionId: BigInt(event.bizId) };
  }
}
