import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { SESSION_STATUS_OPEN } from './session-status.rules';
import type { SessionListRow } from './list-sessions.usecase';

/**
 * 选/切接地目标仓 (034 T004, FR-005 / FR-006 / US2) —— 写 `idea_session.repo` 锁定本会话
 * 检索命名空间。ideation 叶子 ctx, 扁平 + 贫血 + 直注 PrismaService (无 repository, per
 * ADR-0043; Q1 → 自表写, 不跨 ctx)。
 *
 * 🚨 状态写 = conditional UPDATE + affected-count (plan §Impl Guardrails / ②③, READ
 * COMMITTED): `updateMany where {id, accountId, status:open}` → `count===1` won (选仓成功) /
 * `count===0` lost。**NEVER** 单行 `FOR UPDATE` / Serializable (偏索引 SSI 假冲突, 004 实证)。
 *
 * 反枚举 (plan §Impl Guardrails): lost (count===0) 三因 —— 他人 / 不存在 / 非 open —— 一律
 * 折叠 **404 字节级一致** (`SESSION_NOT_FOUND`, 与 get/delete/reopen 同款)。**不** 区分非 open
 * (比 reopen 更严: 不暴露 "会话存在但已收敛" 的差异), 不二次 findFirst 探活。
 *
 * 切仓只影响后续轮 (FR-006): UC 仅改 session.repo 单字段, **不动** 既有 idea_turn 行 ——
 * 历史轮的代码引用 (若已落) 不回改, 新 repo 仅对后续澄清轮的检索命名空间生效。
 */
@Injectable()
export class SetSessionRepoUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, sessionId: bigint, repo: string): Promise<SessionListRow> {
    // conditional UPDATE: 仅本人 + open 会话可选/切仓 → 写 repo。
    const { count } = await this.prisma.ideaSession.updateMany({
      where: { id: sessionId, accountId, status: SESSION_STATUS_OPEN },
      data: { repo },
    });

    if (count === 0) {
      // lost: 他人 / 不存在 / 非 open → 404 字节级一致 (反枚举, 不区分原因)。
      throw new NotFoundException('SESSION_NOT_FOUND');
    }

    // won: 读回最新 row 投影返回 (含新 repo)。
    return this.prisma.ideaSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { id: true, title: true, status: true, repo: true, createdAt: true, updatedAt: true },
    });
  }
}
