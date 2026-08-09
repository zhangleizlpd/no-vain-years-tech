import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import {
  isHoldingsGroup,
  resortWithPinPriority,
  type ResortOp,
  SYSTEM_KIND_HOLDINGS,
  SYSTEM_KIND_WATCHLIST,
} from './watchlist.rules';
import {
  materializeSystemGroups,
  isSystemKindKeyword,
  parseGroupId,
} from './materialize-system-groups';
import { GroupNotFoundException } from './group-not-found.exception';
import { HoldingsGroupReadonlyException } from './holdings-group-readonly.exception';
import { WatchlistItemNotFoundException } from './watchlist-item-not-found.exception';
import { toWatchlistItemView, type ItemListResponse } from './watchlist-item-list.response';

interface UpdateItemInput {
  pinned?: boolean;
  move?: 'front' | 'back';
  targetGroupId?: string;
  color?: string;
  noteRef?: string;
}

/** body → 单次排序操作 (pinned 优先于 move); 无排序意图 → null。 */
function deriveOp(itemId: bigint, body: UpdateItemInput): ResortOp | null {
  if (body.pinned === true) return { kind: 'pin', itemId };
  if (body.pinned === false) return { kind: 'unpin', itemId };
  if (body.move === 'front') return { kind: 'moveFront', itemId };
  if (body.move === 'back') return { kind: 'moveBack', itemId };
  return null;
}

/**
 * 013 US2 EP8 — 标的改操作 (intra 写, 持 tx)。固顶/移到最前·最后/改归属组/颜色/笔记。
 *
 * 排序 (FR-S05): 持 tx 读目标组 items → `resortWithPinPriority` 纯函数算新 (pinned, order) →
 * 批量回写。固顶区常驻顶 > 非固顶区; 移到最前在固顶项下方。**改组涉源+目标两组** (源移出后
 * renormalize, 目标接入后 resort)。持仓组 (源或目标) → 422 (FR-S06)。并发 last-write-wins
 * (D1, 不锁)。返回**受影响组**全量 items (D8, 客户端对账)。
 */
@Injectable()
export class UpdateWatchlistItemUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    accountId: bigint,
    itemId: string,
    body: UpdateItemInput,
  ): Promise<ItemListResponse> {
    let id: bigint;
    try {
      id = BigInt(itemId);
    } catch {
      throw new WatchlistItemNotFoundException();
    }

    const affected = await this.prisma.$transaction(async (tx) => {
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

      const sourceGroupId = item.groupId;
      const targetGroupId =
        body.targetGroupId !== undefined
          ? await this.resolveTargetGroupId(tx, accountId, body.targetGroupId)
          : sourceGroupId;

      const moving = targetGroupId !== sourceGroupId;
      const op = deriveOp(id, body);

      // 1. 字段 (color/note) + 移组 (落目标非固顶尾, pinned=false; 后续 resort 可覆盖)。
      const data: Prisma.WatchlistItemUpdateInput = {};
      if (body.color !== undefined) data.color = body.color;
      if (body.noteRef !== undefined) data.noteRef = body.noteRef;
      if (moving) {
        const maxOrder = await tx.watchlistItem.aggregate({
          where: { groupId: targetGroupId, pinned: false },
          _max: { order: true },
        });
        data.group = { connect: { id: targetGroupId } };
        data.pinned = false;
        data.order = (maxOrder._max.order ?? -1) + 1;
      }
      if (Object.keys(data).length > 0) {
        await tx.watchlistItem.update({ where: { id }, data });
      }

      // 2. 源组移出后 renormalize (item 已不在源组 → no-op move 路径稠密化)。
      if (moving) {
        await this.persistResort(tx, sourceGroupId, { kind: 'moveBack', itemId: id });
      }
      // 3. 目标组 (item 现所属): 有排序意图按 op; 否则若移组用 no-op 稠密化, 纯字段改免动。
      if (op) {
        await this.persistResort(tx, targetGroupId, op);
      } else if (moving) {
        await this.persistResort(tx, targetGroupId, { kind: 'moveBack', itemId: id });
      }

      return moving ? [sourceGroupId, targetGroupId] : [sourceGroupId];
    });

    return this.readItems(affected);
  }

  /** 解析改归属目标组 id: keyword 'holdings' / 持仓真实行 → 422; keyword 'watchlist' 需
   *  materialize; 数字不存在 → 404。 */
  private async resolveTargetGroupId(
    tx: Prisma.TransactionClient,
    accountId: bigint,
    targetGroupId: string,
  ): Promise<bigint> {
    if (isSystemKindKeyword(targetGroupId) && targetGroupId === SYSTEM_KIND_HOLDINGS) {
      throw new HoldingsGroupReadonlyException();
    }
    await materializeSystemGroups(tx, accountId);
    const target = isSystemKindKeyword(targetGroupId)
      ? await tx.group.findFirst({ where: { accountId, systemKind: SYSTEM_KIND_WATCHLIST } })
      : await tx.group.findFirst({ where: { id: parseGroupId(targetGroupId), accountId } });
    if (!target) {
      throw new GroupNotFoundException();
    }
    if (isHoldingsGroup(target)) {
      throw new HoldingsGroupReadonlyException();
    }
    return target.id;
  }

  /** 读组 items → resortWithPinPriority 算新序 → 逐行回写 pinned+order (N 小, D1 不锁)。 */
  private async persistResort(
    tx: Prisma.TransactionClient,
    groupId: bigint,
    op: ResortOp,
  ): Promise<void> {
    const rows = await tx.watchlistItem.findMany({ where: { groupId } });
    const next = resortWithPinPriority(
      rows.map((r) => ({ id: r.id, pinned: r.pinned, order: r.order })),
      op,
    );
    for (const s of next) {
      await tx.watchlistItem.update({
        where: { id: s.id },
        data: { pinned: s.pinned, order: s.order },
      });
    }
  }

  /** 受影响组全量 items (固顶区在前), 按组顺序拼接 (客户端按 groupId 分区对账, D8)。 */
  private async readItems(groupIds: bigint[]): Promise<ItemListResponse> {
    const rows = await this.prisma.watchlistItem.findMany({
      where: { groupId: { in: groupIds } },
      orderBy: [{ groupId: 'asc' }, { pinned: 'desc' }, { order: 'asc' }],
    });
    return { items: rows.map(toWatchlistItemView) };
  }
}
