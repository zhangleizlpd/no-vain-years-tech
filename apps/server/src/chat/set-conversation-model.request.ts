import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { AVAILABLE_MODEL_IDS } from './list-models.usecase';

/**
 * PATCH /chat/conversations/{id}/model request body (029 T002, plan D3)。
 *
 * 独立子路由 (不与 028 改名 `PATCH conversations/:id` 共 body 分派 — 避免改 028 既有
 * `{title}` 契约 / 重写其 DTO required 语义; 子资源 RESTful)。model 必填。
 *
 * 值域: flash/pro/minimax (AVAILABLE_MODEL_IDS, 派生自 list-models available 项 — 单源)。
 * 非法/不可用值 (legacy deepseek-chat / 未知值) DTO 层 `@IsIn` 先拦 → 400 (自有资源输入
 * 校验, 非反枚举路径)。UC 层归属校验 (404) 仍先于值域 (UC 内 findFirst scope 先行):
 * 他人会话即便传非法 model 也返 404 (不暴露存在性)。
 */
export class SetConversationModelRequest {
  @ApiProperty({
    description: '逻辑模型 id (flash | pro | minimax; 仅可用模型)',
    enum: AVAILABLE_MODEL_IDS as string[],
    example: 'pro',
  })
  @IsString()
  @IsIn(AVAILABLE_MODEL_IDS as string[])
  model!: string;
}
