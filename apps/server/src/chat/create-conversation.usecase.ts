import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { EMPTY_TITLE_FALLBACK } from './chat-title.rules';
import { DEFAULT_CHAT_MODEL } from './list-models.usecase';

/**
 * 建空会话 (027 T006, plan D6) — chat 叶子 ctx, 扁平 + 贫血 + 直注 PrismaService
 * (无 repository, per ADR-0043)。会话按 accountId 归属。
 *
 * model 默认 029 D7 逻辑默认 flash (DEFAULT_CHAT_MODEL 单源于 list-models; 029 起
 * 会话级可切, send-message 按 conversation.model 路由); title 客户端可预置, 留空 →
 * 兜底「新对话」(首条消息时 deriveTitle 覆盖, T007)。metadata 二期预留位 027 不写
 * (留 DB 默认 NULL)。返回贫血 row (controller 投影)。
 */

export interface CreateConversationResult {
  id: bigint;
  title: string;
  model: string;
}

@Injectable()
export class CreateConversationUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, rawTitle?: string): Promise<CreateConversationResult> {
    const title = rawTitle?.trim() ? rawTitle.trim() : EMPTY_TITLE_FALLBACK;
    const created = await this.prisma.conversation.create({
      data: { accountId, title, model: DEFAULT_CHAT_MODEL },
      select: { id: true, title: true, model: true },
    });
    return created;
  }
}
