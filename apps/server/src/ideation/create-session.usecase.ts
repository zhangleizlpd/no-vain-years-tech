import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 建灵感会话 (032 T007, FR-001 / US1) —— ideation 叶子 ctx, 扁平 + 贫血 + 直注
 * PrismaService (无 repository, per ADR-0043)。会话按 accountId 归属。
 *
 * status 默认 `open` (DB @default); repo 本期不暴露 UI 选择器 (ADR-0059 接地缝预留)
 * → 建会话时 `repo=null`。title 客户端预置 (RHF 标题输入, 非空已由 DTO 校验); 返回
 * 贫血 row (controller 投影)。
 */

export interface CreateSessionResult {
  id: bigint;
  title: string;
  status: string;
  repo: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CreateSessionUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, title: string): Promise<CreateSessionResult> {
    return this.prisma.ideaSession.create({
      data: { accountId, title, repo: null },
      select: { id: true, title: true, status: true, repo: true, createdAt: true, updatedAt: true },
    });
  }
}
