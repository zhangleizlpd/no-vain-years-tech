import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * POST /chat/conversations/{id}/messages request body (027 T007, plan D3; 030 A1 去 webSearch)。
 *
 * 流式发消息: content 必填非空 (空输入拒, spec Edge / state_branches)。@IsNotEmpty
 * 是快速 UTF-16 闸 (纯空白由 ValidationPipe `whitelist` 后不拦, 故 UC 内再 trim 校验
 * 兜底——见 send-message.usecase 空输入分支)。MaxLength 防超长请求体。
 *
 * A1 amend (030 Phase 7, T019): 移除 `webSearch` per-message 开关 —— ChatGPT 式统一联网,
 * 所有会话默认挂 web_search 工具 + 模型 `tool_choice:'auto'` 自决检索 (联网不再由入参控制)。
 */
export class SendMessageRequest {
  @ApiProperty({
    description: '用户消息内容 (必填非空)',
    example: '帮我分析一下贵州茅台',
    maxLength: 8000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  content!: string;
}
