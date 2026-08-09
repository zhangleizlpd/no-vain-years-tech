import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 会话改名 (028 T002, plan D / FR-006 / SC-004) — chat 叶子 ctx, 扁平 + 贫血 +
 * 直注 PrismaService (无 repository, per ADR-0043)。
 *
 * 安全 (plan §Impl Guardrails): 会话按 accountId 归属, UC 层 scope —— 先校验归属
 * (findFirst where {id, accountId}), 他人 / 不存在的 conversationId 一律 404 字节级
 * 一致 (反枚举, 复用 get-messages 同款 `NotFoundException('CONVERSATION_NOT_FOUND')`,
 * **非 403**)。
 *
 * 输入校验: title trim 后空 → `BadRequestException`。这是自有资源输入校验
 * (非反枚举路径), 故 400 而非折叠 404 —— 归属校验 (404) 先于输入校验 (400):
 * 他人会话改名也返 404 (不暴露存在性), 仅本人会话才会走到空标题 400。
 *
 * 写: `update({where:{id}, data:{title}})` —— @updatedAt 自动刷新 updatedAt (改名
 * 使会话上浮, plan 决策 a 已接受)。返回贫血 row {id, title, updatedAt} (controller 投影)。
 */

export interface RenameConversationResult {
  id: bigint;
  title: string;
  updatedAt: Date;
}

@Injectable()
export class RenameConversationUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    accountId: bigint,
    conversationId: bigint,
    rawTitle: string,
  ): Promise<RenameConversationResult> {
    // ① 归属校验先行 (反枚举): 他人 / 不存在 → 404, 早于输入校验, 不暴露存在性。
    const owned = await this.prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    // ② 输入校验: trim 后空 / 纯空白 → 400 (自有资源输入校验, 非反枚举)。
    const title = rawTitle.trim();
    if (title.length === 0) {
      throw new BadRequestException('TITLE_REQUIRED');
    }

    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { title },
      select: { id: true, title: true, updatedAt: true },
    });
  }
}
