import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { AVAILABLE_MODEL_IDS } from './list-models.usecase';

/**
 * 会话级 model 写 (029 T002, plan D3 / FR-003 / FR-009 / SC-003 / SC-005) — chat 叶子 ctx,
 * 扁平 + 贫血 + 直注 PrismaService (无 repository, per ADR-0043)。
 *
 * 安全 (plan §Impl Guardrails): 会话按 accountId 归属, UC 层 scope —— 先校验归属
 * (findFirst where {id, accountId}), 他人 / 不存在的 conversationId 一律 404 字节级
 * 一致 (反枚举, 复用 028 改名 / get-messages 同款 `NotFoundException('CONVERSATION_NOT_FOUND')`,
 * **非 403**)。归属校验 (404) **先于**值域校验 (400): 他人会话即便传非法 model 也返 404
 * (不暴露存在性), 仅本人会话才会走到值域 400。
 *
 * 值域校验: model 必须 ∈ AVAILABLE_MODEL_IDS (flash/pro, 派生自 list-models available
 * 项 — 单源)。非法 / 不可用值 (minimax 等) → `BadRequestException` (自有资源输入校验,
 * 非反枚举路径)。DTO `@IsIn` 已是第一道闸; UC 层再校验是 defense-in-depth (UC 可被
 * IT / contract-smoke 直调, 不经 ValidationPipe)。
 *
 * 写: `update({where:{id}, data:{model}})` —— @updatedAt 自动刷新 updatedAt (切 model
 * 使会话上浮, plan D3 已接受, 与 028 改名一致)。返回贫血 row {id, model, updatedAt}
 * (controller 投影)。
 *
 * 复杂度: O(1) — 单行 scope 查 + 单行 update (无多表事务 / 无状态机竞争, plan §并发)。
 */

export interface SetConversationModelResult {
  id: bigint;
  model: string;
  updatedAt: Date;
}

@Injectable()
export class SetConversationModelUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    accountId: bigint,
    conversationId: bigint,
    model: string,
  ): Promise<SetConversationModelResult> {
    // ① 归属校验先行 (反枚举): 他人 / 不存在 → 404, 早于值域校验, 不暴露存在性。
    const owned = await this.prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    // ② 值域校验: 非 flash/pro (含 minimax 等不可用值) → 400 (自有资源输入校验, 非反枚举)。
    if (!AVAILABLE_MODEL_IDS.includes(model)) {
      throw new BadRequestException('MODEL_NOT_AVAILABLE');
    }

    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { model },
      select: { id: true, model: true, updatedAt: true },
    });
  }
}
