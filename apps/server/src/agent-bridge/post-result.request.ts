import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional } from 'class-validator';

/**
 * POST /agent-queue/{id}/result request body (P1.4)。worker 回传终态:
 * SUCCESS → done, FAILURE → failed; result 为可选产物 (如 mockup URL / 状态摘要)。
 */
export class PostResultRequest {
  @ApiProperty({ enum: ['SUCCESS', 'FAILURE'], description: '处理结果' })
  @IsIn(['SUCCESS', 'FAILURE'])
  outcome!: 'SUCCESS' | 'FAILURE';

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: '产物 (如 mockup URL / 状态摘要); 可空',
  })
  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;
}
