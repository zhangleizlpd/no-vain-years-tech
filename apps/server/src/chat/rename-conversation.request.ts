import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * PATCH /chat/conversations/{id} request body (028 T002, plan D / FR-006)。
 *
 * 改名: title 必填字符串。空 / 纯空白拒 (400 BadRequest) —— 但**不在 DTO 层**用
 * `@IsNotEmpty` 拦 (那只挡空串, 挡不住纯空白 '   ')。统一在 UC 层 trim 后判空,
 * 保持「空标题 400」单一判定点 (自有资源输入校验, 非反枚举路径)。maxLength 与
 * create 一致 (40)。
 */
export class RenameConversationRequest {
  @ApiProperty({
    description: '新会话标题 (trim 后不可为空; 最长 40)',
    maxLength: 40,
    example: '分析贵州茅台估值',
  })
  @IsString()
  @MaxLength(40)
  title!: string;
}
