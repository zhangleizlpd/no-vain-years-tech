import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { briefSchema } from './brief.schema';
import { renderBriefMarkdown } from './brief-markdown.rules';
import { SESSION_STATUS_CONVERGED, SESSION_STATUS_HANDED_OFF } from './session-status.rules';

/**
 * 导出 brief markdown 编排 (032 T009, 契约 doc §2.2 / D4 导出态) —— ideation 叶子 ctx,
 * 扁平 + 贫血 + 直注 PrismaService (无 repository, per ADR-0043)。
 *
 * 流程 (plan ⑥):
 *   ① scope 校验 session 归属本 accountId → 他人/不存在 404 字节级一致 (反枚举)。
 *   ② 读 requirements_draft.briefJson (1:1; 无 brief → 404 不可导出); zod 校 (恒已收敛过)。
 *   ③ renderBriefMarkdown(brief) → markdown (T005)。
 *   ④ session converged→handed-off (conditional UPDATE affected-count; 已 handed-off 幂等)。
 *
 * 注: 状态门只对 converged → handed-off 转换 (conditional UPDATE); 已 handed-off 重复导出
 * 幂等 (count===0 但 brief 仍在 → 照常返 markdown, 不报错)。
 */
export interface ExportBriefResult {
  markdown: string;
  status: string;
}

@Injectable()
export class ExportBriefUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, sessionId: bigint): Promise<ExportBriefResult> {
    // ① scope 校验归属 (反枚举字节级一致)。
    const session = await this.prisma.ideaSession.findFirst({
      where: { id: sessionId, accountId },
      select: { id: true },
    });
    if (!session) {
      throw new NotFoundException('SESSION_NOT_FOUND');
    }

    // ② 读 brief (无 → 404 不可导出, 与 scope miss 字节级一致反枚举)。
    const draft = await this.prisma.requirementsDraft.findUnique({
      where: { sessionId },
      select: { briefJson: true },
    });
    if (!draft) {
      throw new NotFoundException('SESSION_NOT_FOUND');
    }
    const parsed = briefSchema.safeParse(draft.briefJson);
    if (!parsed.success) {
      // 落库 brief 恒已过收敛门 (T1 齐); 理论不可达, 防御性折 404。
      throw new NotFoundException('SESSION_NOT_FOUND');
    }

    // ③ 渲 markdown (T005)。
    const markdown = renderBriefMarkdown(parsed.data);

    // ④ session converged→handed-off (conditional UPDATE; 已 handed-off 重复导出幂等 no-op)。
    await this.prisma.ideaSession.updateMany({
      where: { id: sessionId, accountId, status: SESSION_STATUS_CONVERGED },
      data: { status: SESSION_STATUS_HANDED_OFF },
    });

    return { markdown, status: SESSION_STATUS_HANDED_OFF };
  }
}
