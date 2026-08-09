import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { MessageRow } from './chat.response';

/**
 * 取会话消息 (027 T006, plan D6 / SC-002 重进仍在) — chat 叶子 ctx, 直注 PrismaService。
 *
 * 安全 (plan §Impl Guardrails): 会话按 accountId 归属, UC 层 scope —— 先校验
 * conversation 归属本账号, 他人 / 不存在的 conversationId 一律 404 字节级一致
 * (反枚举, 与 alert/portfolio 同款; **不是 403**)。归属本人 → 按 (conversation_id, id)
 * 插入序取消息 (id 自增即时序), 空会话 → []。
 */
@Injectable()
export class GetMessagesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, conversationId: bigint): Promise<MessageRow[]> {
    // scope 校验归属: 查不到本人的 conversation 即 404 (他人 / 不存在不可区分)。
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true },
    });
    if (!conversation) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        role: true,
        content: true,
        status: true,
        createdAt: true,
        metadata: true,
      },
    });
  }
}
