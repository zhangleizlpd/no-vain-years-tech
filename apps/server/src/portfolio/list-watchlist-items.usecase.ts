import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { isHoldingsGroup, SYSTEM_KIND_HOLDINGS, SYSTEM_KIND_WATCHLIST } from './watchlist.rules';
import { isSystemKindKeyword, parseGroupId } from './materialize-system-groups';
import { GroupNotFoundException } from './group-not-found.exception';
import { toWatchlistItemView, type ItemListResponse } from './watchlist-item-list.response';

/**
 * 013 US2 EP6 — 列某组自选标的 (intra query, ADR-0043 直注 PrismaService 无 repository)。
 *
 * **零写库** (D2, 对齐 EP1): keyword 形 groupId (虚拟系统组, plan D9) 在未 materialize 前
 * 无真实行 → 返空 (新账号自选空, 不写库)。数字串 → 查本账号真实行; 不存在 → 404
 * (反枚举折叠)。**持仓组 = 派生只读视图** (FR-S06): 025 D1 起从 holding 表派生
 * (qty>0 AND quotable, weightPct desc) — 零 WatchlistItem 写入、零同步、永不 drift;
 * 未导入过 → 空 (013 既有行为零回归)。
 *
 * 普通组读侧 `ORDER BY pinned DESC, "order" ASC` (固顶区常驻顶 > 非固顶区, FR-S05)。
 */
@Injectable()
export class ListWatchlistItemsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, groupId: string): Promise<ItemListResponse> {
    // keyword: 持仓走 holding 表派生 (025 D1); 自选 keyword 未 materialize → 真实行不存在 → 空。
    if (isSystemKindKeyword(groupId)) {
      if (groupId === SYSTEM_KIND_HOLDINGS) {
        return this.listHoldingsDerived(accountId, SYSTEM_KIND_HOLDINGS);
      }
      const watchlist = await this.prisma.group.findFirst({
        where: { accountId, systemKind: SYSTEM_KIND_WATCHLIST },
      });
      if (!watchlist) return { items: [] };
      return this.listByGroupRow(watchlist.id);
    }

    const id = parseGroupId(groupId);
    const group = await this.prisma.group.findFirst({ where: { id, accountId } });
    if (!group) {
      throw new GroupNotFoundException();
    }
    // 持仓组派生只读视图 (即便结构上挂了 item, 也不暴露; 写入早被拒)。
    if (isHoldingsGroup(group)) {
      return this.listHoldingsDerived(accountId, id.toString());
    }
    return this.listByGroupRow(id);
  }

  /**
   * 025 D1 持仓组派生视图: holding (qty>0 AND quotable) weightPct desc → item view。
   * id=holding.id / pinned=false / color=null (响应 shape 不变, mobile 零改动点亮);
   * quotable=false 降级行不进组 (quote merge 查不到, 进了也只是噪音)。
   */
  private async listHoldingsDerived(accountId: bigint, groupId: string): Promise<ItemListResponse> {
    const rows = await this.prisma.holding.findMany({
      where: { accountId, qty: { gt: 0 }, quotable: true },
      orderBy: [{ weightPct: { sort: 'desc', nulls: 'last' } }, { code: 'asc' }],
    });
    return {
      items: rows.map((r, i) => ({
        id: r.id.toString(),
        groupId,
        market: r.market,
        code: r.code,
        pinned: false,
        order: i,
        color: null,
        noteRef: null,
      })),
    };
  }

  private async listByGroupRow(groupId: bigint): Promise<ItemListResponse> {
    const rows = await this.prisma.watchlistItem.findMany({
      where: { groupId },
      orderBy: [{ pinned: 'desc' }, { order: 'asc' }],
    });
    return { items: rows.map(toWatchlistItemView) };
  }
}
