import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { isHoldingsGroup, SYSTEM_KIND_HOLDINGS, SYSTEM_KIND_WATCHLIST } from './watchlist.rules';
import {
  materializeSystemGroups,
  isSystemKindKeyword,
  parseGroupId,
} from './materialize-system-groups';
import { GroupNotFoundException } from './group-not-found.exception';
import { HoldingsGroupReadonlyException } from './holdings-group-readonly.exception';
import { ListWatchlistItemsUseCase } from './list-watchlist-items.usecase';
import type { ItemListResponse } from './watchlist-item-list.response';

/**
 * 013 US2 EP7 — 加自选标的 (intra 写, 持 tx, ADR-0043 直注 PrismaService 无 repository)。
 *
 * tx 内 (D2 materialize-on-first-write):
 *  1. keyword 'holdings' → 短路 422 (派生只读, FR-S06)。
 *  2. materialize 2 系统组 → keyword 'watchlist' 解析到真实行 / 后续挂真实 groupId。
 *  3. 解析目标组: keyword 'watchlist' → 按 systemKind 查; 数字串 → 按 id+accountId 查, 缺 → 404。
 *  4. 目标为持仓组 → 422 (FR-S06)。
 *  5. **组内 (market, code) 预查重** (对齐 create-group name 预查 / delete 回落预查, D1
 *     last-write-wins 不锁): 已存在 → 幂等 no-op (FR-M07/EP7); 否则 create, order = 组内
 *     非固顶区 max order + 1, pinned=false。
 * 返回该组全量 items (客户端对账乐观更新, D8)。
 */
@Injectable()
export class AddWatchlistItemUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lister: ListWatchlistItemsUseCase,
  ) {}

  async execute(
    accountId: bigint,
    groupId: string,
    market: string,
    code: string,
  ): Promise<ItemListResponse> {
    // keyword 'holdings' → 派生只读, 短路 (不写库)。
    if (isSystemKindKeyword(groupId) && groupId === SYSTEM_KIND_HOLDINGS) {
      throw new HoldingsGroupReadonlyException();
    }

    const realGroupId = await this.prisma.$transaction(async (tx) => {
      await materializeSystemGroups(tx, accountId);

      const group = isSystemKindKeyword(groupId)
        ? await tx.group.findFirst({ where: { accountId, systemKind: SYSTEM_KIND_WATCHLIST } })
        : await tx.group.findFirst({ where: { id: parseGroupId(groupId), accountId } });
      if (!group) {
        throw new GroupNotFoundException();
      }
      if (isHoldingsGroup(group)) {
        throw new HoldingsGroupReadonlyException();
      }

      // 组内同标的预查重 → 幂等 (FR-M07)。已在则不动 (D1 容忍并发竞态, 唯一索引兜底)。
      const existing = await tx.watchlistItem.findFirst({
        where: { groupId: group.id, market, code },
      });
      if (existing) return group.id;

      const maxOrder = await tx.watchlistItem.aggregate({
        where: { groupId: group.id, pinned: false },
        _max: { order: true },
      });
      const order = (maxOrder._max.order ?? -1) + 1;

      await tx.watchlistItem.create({
        data: { groupId: group.id, market, code, pinned: false, order },
      });
      return group.id;
    });

    return this.lister.execute(accountId, realGroupId.toString());
  }
}
