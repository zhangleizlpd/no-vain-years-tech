import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { isHoldingsGroup, resortWithPinPriority } from './watchlist.rules';
import { HoldingsGroupReadonlyException } from './holdings-group-readonly.exception';
import { WatchlistItemNotFoundException } from './watchlist-item-not-found.exception';
import { toWatchlistItemView, type ItemListResponse } from './watchlist-item-list.response';

/**
 * 013 US2 EP9 — 删自选标的 (intra 写, 持 tx)。
 *
 * itemId 非法 / 属他人 → 404 (反枚举)。持仓组派生项 → 422 (FR-S06, V1 持仓组空理论不可达,
 * 防御性兜底)。删后 renormalize 同组剩余 item order 稠密化。返回该组全量 items (D8)。
 */
@Injectable()
export class DeleteWatchlistItemUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, itemId: string): Promise<ItemListResponse> {
    let id: bigint;
    try {
      id = BigInt(itemId);
    } catch {
      throw new WatchlistItemNotFoundException();
    }

    const groupId = await this.prisma.$transaction(async (tx) => {
      const item = await tx.watchlistItem.findFirst({
        where: { id, group: { accountId } },
        include: { group: true },
      });
      if (!item) {
        throw new WatchlistItemNotFoundException();
      }
      if (isHoldingsGroup(item.group)) {
        throw new HoldingsGroupReadonlyException();
      }

      await tx.watchlistItem.delete({ where: { id } });
      await this.renormalize(tx, item.groupId);
      return item.groupId;
    });

    const rows = await this.prisma.watchlistItem.findMany({
      where: { groupId },
      orderBy: [{ pinned: 'desc' }, { order: 'asc' }],
    });
    return { items: rows.map(toWatchlistItemView) };
  }

  /** 删后稠密化: resort no-op (传不存在 id → renormalize 各区 0-based)。 */
  private async renormalize(tx: Prisma.TransactionClient, groupId: bigint): Promise<void> {
    const rows = await tx.watchlistItem.findMany({ where: { groupId } });
    const next = resortWithPinPriority(
      rows.map((r) => ({ id: r.id, pinned: r.pinned, order: r.order })),
      { kind: 'moveBack', itemId: BigInt(-1) },
    );
    for (const s of next) {
      await tx.watchlistItem.update({
        where: { id: s.id },
        data: { pinned: s.pinned, order: s.order },
      });
    }
  }
}
