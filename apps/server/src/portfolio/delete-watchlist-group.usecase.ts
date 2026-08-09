import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { isSystemGroup, SYSTEM_KIND_WATCHLIST } from './watchlist.rules';
import { isSystemKindKeyword, parseGroupId } from './materialize-system-groups';
import { SystemGroupProtectedException } from './system-group-protected.exception';
import { GroupNotFoundException } from './group-not-found.exception';
import { ListWatchlistGroupsUseCase, type GroupListResult } from './list-watchlist-groups.usecase';

/**
 * 013 US1 EP4 — 删自定义组 (intra 写, 持 tx)。
 *
 * keyword id → 系统组 → 422 (短路)。数字串 → 本账号查; 不存在 → 404; 系统组 → 422。
 * **非级联删** (FR-S02/D3): 组内 item 回落「自选」组不丢 —— 冲突项 (目标已有同 market+code)
 * 丢弃幂等, 其余迁入「自选」非固顶区末尾 → 再 DELETE 空组。last-write-wins, 不锁 (D1)。
 */
@Injectable()
export class DeleteWatchlistGroupUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lister: ListWatchlistGroupsUseCase,
  ) {}

  async execute(accountId: bigint, groupId: string): Promise<GroupListResult> {
    if (isSystemKindKeyword(groupId)) {
      throw new SystemGroupProtectedException();
    }
    const id = parseGroupId(groupId);

    await this.prisma.$transaction(async (tx) => {
      const row = await tx.group.findFirst({ where: { id, accountId } });
      if (!row) {
        throw new GroupNotFoundException();
      }
      if (isSystemGroup(row)) {
        throw new SystemGroupProtectedException();
      }

      const fallback = await tx.group.findFirst({
        where: { accountId, systemKind: SYSTEM_KIND_WATCHLIST },
      });
      // 自定义组存在 → 系统组已 materialize; 理论恒存在, 防御性兜底 404。
      if (!fallback) {
        throw new GroupNotFoundException();
      }

      const items = await tx.watchlistItem.findMany({ where: { groupId: id } });
      const existing = await tx.watchlistItem.findMany({
        where: { groupId: fallback.id },
        select: { market: true, code: true },
      });
      const existingKeys = new Set(existing.map((e) => `${e.market}:${e.code}`));
      const maxOrder = await tx.watchlistItem.aggregate({
        where: { groupId: fallback.id, pinned: false },
        _max: { order: true },
      });
      let nextOrder = (maxOrder._max.order ?? -1) + 1;

      for (const it of items) {
        if (existingKeys.has(`${it.market}:${it.code}`)) {
          await tx.watchlistItem.delete({ where: { id: it.id } }); // 冲突丢弃幂等
        } else {
          await tx.watchlistItem.update({
            where: { id: it.id },
            data: { groupId: fallback.id, pinned: false, order: nextOrder++ },
          });
        }
      }

      await tx.group.delete({ where: { id } });
    });

    return this.lister.execute(accountId);
  }
}
