import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/**
 * POST /api/v1/ideation/mockups/credential request body (037 T005, FR-002 / FR-003)。
 *
 * **worker-token 端点** —— channel 据所认领的 ideation requirement 事件请凭证。body 只带
 * `eventId` (那条 claimed `agentQueueEvent` 的 id); 归属 scope (accountId, sessionId) **永远**
 * 由 server 据该 event 派生, channel **不得自报** account / session (防越权 + 混淆代理, Q2 终判)。
 */
export class MockupCredentialRequest {
  @ApiProperty({
    description: 'claimed ideation requirement 事件 id (worker 所认领任务; scope 据此派生)',
    example: '7b3e1c2a-0000-4000-8000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  eventId!: string;
}
