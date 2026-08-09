import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 会话删除 (028 T003, plan D3 / FR-007 / SC-007) — chat 叶子 ctx, 扁平 + 贫血 +
 * 直注 PrismaService (无 repository, per ADR-0043)。
 *
 * 安全 (plan §Impl Guardrails): 会话按 accountId 归属, UC 层 scope —— 先校验归属
 * (findFirst where {id, accountId}), 他人 / 不存在的 conversationId 一律 404 字节级
 * 一致 (反枚举, 复用 get-messages 同款 `NotFoundException('CONVERSATION_NOT_FOUND')`,
 * **非 403**)。
 *
 * 🚨 连带删 (plan D3): 027 conversation/message 两表**无 FK relation**
 * (无 ON DELETE CASCADE) —— 必须**应用层单事务**手动连带: 先 `message.deleteMany`
 * 再 `conversation.delete`, 同 `$transaction` 原子提交 (任一失败回滚), 否则删完
 * conversation 留下孤儿 message 行。顺序: 先 message 后 conversation (反过来无 FK
 * 约束故顺序不影响约束, 但语义上先清子行更直观)。
 */

@Injectable()
export class DeleteConversationUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, conversationId: bigint): Promise<void> {
    // 归属校验先行 (反枚举): 他人 / 不存在 → 404, 不暴露存在性。
    const owned = await this.prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    // 单事务连带删: 无 FK cascade, 手动先删 message 再删 conversation (原子)。
    await this.prisma.$transaction([
      this.prisma.message.deleteMany({ where: { conversationId } }),
      this.prisma.conversation.delete({ where: { id: conversationId } }),
    ]);
  }
}
