import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import {
  derivePointInTimeValues,
  replayAnchorAt,
  toAnchorSnapshot,
  type AnchorChangeRecord,
  type AnchorSnapshot,
  type PointInTimeAnchorValues,
} from './anchor-history';

/**
 * 045 US1 — PIT (point-in-time) 还原查询 (FR-031 / **SC-011**, plan D2/D15)。
 *
 * 「任一历史时点的 V / W / L 层 / 单票上限 / 愿卖锚可被还原」的读侧入口。算法归
 * `anchor-history.ts` 纯函数 (倒放 `before_values`), 本文件只负责取数:
 *
 * - 当前行 (可能已被删 ⇒ `null`, 此时回放起点来自删锚痕迹里的整行快照);
 * - **只取时点之后**的痕迹 (`changed_at > at`), 按 `changed_at` 倒序 —— 早于时点的痕迹与
 *   回放无关, 拉回来是净噪声。同刻并列时以 `id` 降序做稳定 tiebreaker。
 *
 * 时点早于建锚 → `null` (锚当时不存在), MUST NOT 返回半截快照。
 */
@Injectable()
export class GetAnchorAtUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(anchorId: bigint, at: Date): Promise<PointInTimeAnchorValues | null> {
    const current = (await this.prisma.anchor.findUnique({
      where: { id: anchorId },
    })) as Record<string, unknown> | null;
    const changes = (await this.prisma.anchorChange.findMany({
      where: { anchorId, changedAt: { gt: at } },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    })) as unknown as AnchorChangeRecord[];

    const snapshot: AnchorSnapshot | null = replayAnchorAt(
      current === null ? null : toAnchorSnapshot(current),
      changes,
      at,
    );
    return snapshot === null ? null : derivePointInTimeValues(snapshot);
  }
}
