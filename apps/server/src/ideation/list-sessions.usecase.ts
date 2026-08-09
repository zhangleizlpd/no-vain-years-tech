import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 灵感会话列表 (032 T007, FR-002 / US2) —— ideation 叶子 ctx, 扁平 + 贫血 + 直注
 * PrismaService (无 repository, per ADR-0043)。
 *
 * 安全 (plan §Impl Guardrails): 会话按 accountId 归属, UC 层 scope —— `where.accountId`
 * 硬过滤, 只返本人会话 (跨账号不可见, 与 chat list-conversations 同款归属语义)。
 *
 * 排序: `(updatedAt desc, id desc)` 复合稳定序, 命中既有索引
 * `ix_idea_session_account_updated`。返回贫血 row 投影 (controller 再投影响应)。
 * B1 不做分页 / 搜索 (会话量级低, 后续按需扩展)。
 *
 * 复杂度: O(n) 索引扫描, n = 本账号会话数。
 */

/** 贫血 session 列表 row 投影 (UC 返回 Raw Prisma row 子集)。 */
export interface SessionListRow {
  id: bigint;
  title: string;
  status: string;
  repo: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ListSessionsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<SessionListRow[]> {
    return this.prisma.ideaSession.findMany({
      where: { accountId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, title: true, status: true, repo: true, createdAt: true, updatedAt: true },
    });
  }
}
