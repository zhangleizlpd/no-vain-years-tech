import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { AnchorRow } from './create-anchor.usecase';
import { toAnchorView, type AnchorView } from './list-anchors.usecase';
import { resolveLastClosedSessionForTicker } from './last-closed-session';

/**
 * 045 US1 — 单锚详情读端 (FR-001, plan D6)。
 *
 * 与列表共用同一套投影 ({@link toAnchorView}) —— 详情页与列表行显示的派生值必须逐项一致,
 * 各写一套是口径分叉的经典源头 (FR-006)。
 *
 * `excluded = true` 的锚**照常可读** (FR-005: 锚管理侧可见并显示 `exclude_reason`);
 * 排除只作用于雷达默认视图 (Guardrail 12)。
 */
@Injectable()
export class GetAnchorUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(anchorId: bigint): Promise<AnchorView> {
    const row = (await this.prisma.anchor.findUnique({
      where: { id: anchorId },
    })) as AnchorRow | null;
    if (row === null) {
      throw new NotFoundException('ANCHOR_NOT_FOUND');
    }
    return toAnchorView(row, await resolveLastClosedSessionForTicker(this.prisma, row.ticker));
  }
}
