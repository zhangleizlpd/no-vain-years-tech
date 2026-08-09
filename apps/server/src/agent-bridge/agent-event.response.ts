import { ApiProperty } from '@nestjs/swagger';
import type { ClaimedEvent } from './claim-next-event.usecase.js';

/**
 * POST /agent-queue/poll claim 成功响应 = 瘦事件 + 委托 token (claim-check)。
 * eventId/bizId 是 worker 凭委托 token 调现成业务 API 拉胖数据的定位锚。无 accountId
 * 外泄 (已编码在委托 token sub 内)。时间 → ISO-8601 string。
 */
export class AgentEventResponse {
  @ApiProperty({
    description: '事件 id (uuid; ack/result 幂等锚)',
    example: 'a1b2c3d4-0000-0000-0000-000000000000',
  })
  eventId!: string;

  @ApiProperty({ description: '业务类型', example: 'ideation.requirement' })
  bizType!: string;

  @ApiProperty({
    description: '业务主键 (worker 凭委托 token 调现成业务 API 拉胖数据)',
    example: '5001',
  })
  bizId!: string;

  @ApiProperty({
    description:
      '委托 token (PoC: 短时效 account JWT; worker 放 Authorization: Bearer 调现成业务 API)',
  })
  delegationToken!: string;

  @ApiProperty({
    description: '租约到期 ISO-8601 (此前未 result/ack 则事件重新可见被重 claim)',
    example: '2026-06-26T10:05:00.000Z',
  })
  leaseExpiresAt!: string;
}

/** POST /agent-queue/{id}/ack 续租响应。 */
export class AckResponse {
  @ApiProperty({ description: '续租后的到期 ISO-8601', example: '2026-06-26T10:10:00.000Z' })
  leaseExpiresAt!: string;
}

export function toAgentEventResponse(e: ClaimedEvent): AgentEventResponse {
  return {
    eventId: e.eventId,
    bizType: e.bizType,
    bizId: e.bizId,
    delegationToken: e.delegationToken,
    leaseExpiresAt: e.leaseExpiresAt.toISOString(),
  };
}
