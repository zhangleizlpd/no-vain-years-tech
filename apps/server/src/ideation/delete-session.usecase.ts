import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 删灵感会话 (032 T007, FR-009 / US1) —— ideation 叶子 ctx, 扁平 + 贫血 + 直注
 * PrismaService (无 repository, per ADR-0043)。
 *
 * 安全 (plan §Impl Guardrails): 会话按 accountId 归属, UC 层 scope —— 先校验归属
 * (findFirst where {id, accountId}), 他人 / 不存在的 sessionId 一律 404 字节级一致
 * (反枚举, 与 get-session 同款 `NotFoundException('SESSION_NOT_FOUND')`, **非 403**)。
 *
 * 🚨 连带删 (plan ②): idea_session / idea_turn / requirements_draft 三表**无声明 FK
 * relation** (无 ON DELETE CASCADE, 对齐 chat 体例) —— 必须**应用层单事务**手动连带:
 * 先删 turn + brief (子行) 再删 session (父行), 同 `$transaction` 原子提交 (任一失败
 * 回滚), 否则删完 session 留下孤儿 turn / brief 行。
 */
@Injectable()
export class DeleteSessionUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, sessionId: bigint): Promise<void> {
    // 归属校验先行 (反枚举): 他人 / 不存在 → 404, 不暴露存在性。
    const owned = await this.prisma.ideaSession.findFirst({
      where: { id: sessionId, accountId },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('SESSION_NOT_FOUND');
    }

    // 单事务连带删: 无 FK cascade, 手动先删子行 (turn + brief) 再删 session (原子)。
    await this.prisma.$transaction([
      this.prisma.ideaTurn.deleteMany({ where: { sessionId } }),
      this.prisma.requirementsDraft.deleteMany({ where: { sessionId } }),
      this.prisma.ideaSession.delete({ where: { id: sessionId } }),
    ]);
  }
}
