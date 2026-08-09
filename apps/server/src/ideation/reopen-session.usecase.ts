import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { SESSION_STATUS_OPEN, REOPENABLE_STATUSES } from './session-status.rules';

/**
 * 重开灵感会话 (032 T007, FR-012 / US1) —— converged / handed-off → open 回流。
 * ideation 叶子 ctx, 扁平 + 贫血 + 直注 PrismaService (无 repository, per ADR-0043)。
 *
 * 🚨 状态转换 = conditional UPDATE + affected-count (plan ③ / §Impl Guardrails,
 * READ COMMITTED): `updateMany where {id, accountId, status in REOPENABLE}` →
 * `count===1` won (回流成功) / `count===0` lost。**NEVER** `FOR UPDATE` / Serializable
 * (偏索引 SSI 假冲突)。
 *
 * lost (count===0) 两因区分 (反枚举优先):
 * - 他人 / 不存在 sessionId → 404 字节级一致 (与 get/delete 同款 SESSION_NOT_FOUND)。
 * - 本人但 status 已是 open (唯一剩余状态, REOPENABLE 之外) → 幂等返回 open
 *   (重复重开无副作用, 不报错)。
 *
 * 业务不变量 (哪些 status 可回流) 收口在 `session-status.rules.ts` 纯函数清单。
 */

export interface ReopenSessionResult {
  id: bigint;
  title: string;
  status: string;
  repo: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ReopenSessionUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, sessionId: bigint): Promise<ReopenSessionResult> {
    // conditional UPDATE: 仅本人 + 可回流状态 (converged/handed-off) → open。
    const { count } = await this.prisma.ideaSession.updateMany({
      where: { id: sessionId, accountId, status: { in: [...REOPENABLE_STATUSES] } },
      data: { status: SESSION_STATUS_OPEN },
    });

    if (count === 0) {
      // lost: 他人/不存在 → 404 反枚举; 本人但已 open → 幂等返回。
      const owned = await this.prisma.ideaSession.findFirst({
        where: { id: sessionId, accountId },
        select: {
          id: true,
          title: true,
          status: true,
          repo: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!owned) {
        throw new NotFoundException('SESSION_NOT_FOUND');
      }
      return owned; // 已是 open (幂等)。
    }

    // won: 读回最新 row 投影返回。
    const reopened = await this.prisma.ideaSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { id: true, title: true, status: true, repo: true, createdAt: true, updatedAt: true },
    });
    return reopened;
  }
}
