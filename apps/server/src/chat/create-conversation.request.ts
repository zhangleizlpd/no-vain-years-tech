import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /chat/conversations request body (027 T006, plan D6)。
 *
 * 建空会话无必填字段 — model 由服务端默认逻辑 flash (029 D7; 建后经 PATCH .../model
 * 会话级切换 flash/pro), 客户端建会话时不可指定。title 可选: 客户端若已知首条意图
 * 可预置, 否则留空 → UC 兜底「新对话」(首条消息时由 deriveTitle 覆盖, 那是 T007)。
 */
export class CreateConversationRequest {
  @ApiPropertyOptional({
    description: '会话标题 (可选; 留空 → 「新对话」, 首条消息时派生覆盖)',
    maxLength: 40,
    example: '帮我分析这只股票',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  title?: string;
}
