import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { materializeSystemGroups, isSystemKindKeyword } from './materialize-system-groups';
import { ListWatchlistGroupsUseCase, type GroupListResult } from './list-watchlist-groups.usecase';
import type { ReorderGroupEntry } from './reorder-watchlist-groups.request';

/**
 * 013 US1 EP5 — 批量重排分组 (order + visible, intra 写, 持 tx)。
 *
 * tx 内: materialize 系统组 (D2, 新账号首次拖拽即落真实行) → 读本账号 groups 建解析表
 * (keyword systemKind → 真实 id; 数字串 → id) → 逐条 update order+visible。**last-write-wins**
 * 不锁 (D1); 不属本账号 / 解析不到的条目静默跳过 (跨账号隔离 + 容错)。server 允许全隐藏
 * (含系统组) 持久化, 至少一组可见由 mobile 兜底 (D4)。
 */
@Injectable()
export class ReorderWatchlistGroupsUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lister: ListWatchlistGroupsUseCase,
  ) {}

  async execute(accountId: bigint, ordered: ReorderGroupEntry[]): Promise<GroupListResult> {
    await this.prisma.$transaction(async (tx) => {
      await materializeSystemGroups(tx, accountId);

      const rows = await tx.group.findMany({ where: { accountId } });
      const byId = new Map(rows.map((r) => [r.id.toString(), r.id]));
      const bySystemKind = new Map(
        rows.filter((r) => r.systemKind).map((r) => [r.systemKind as string, r.id]),
      );

      for (const entry of ordered) {
        const realId = isSystemKindKeyword(entry.groupId)
          ? bySystemKind.get(entry.groupId)
          : byId.get(entry.groupId);
        if (realId === undefined) continue; // 跨账号 / 不存在 → 跳过 (容错)
        await tx.group.update({
          where: { id: realId },
          data: { order: entry.order, visible: entry.visible },
        });
      }
    });

    return this.lister.execute(accountId);
  }
}
