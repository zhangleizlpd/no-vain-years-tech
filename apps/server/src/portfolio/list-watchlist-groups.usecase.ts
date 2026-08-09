import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import {
  defaultSystemGroups,
  SYSTEM_GROUP_NAMES,
  SYSTEM_KIND_HOLDINGS,
  SYSTEM_KIND_WATCHLIST,
} from './watchlist.rules';
import type { GroupItem } from './group-list.response';

export interface GroupListResult {
  groups: GroupItem[];
}

/**
 * 013 US1 EP1 — 列出账号分组 (intra query, ADR-0043 直注 PrismaService 无 repository)。
 *
 * **零写库** (D2, 对齐 011 GET 纯读): 账号无任何 group 行 → 投影 2 虚拟系统组 (自选/持仓,
 * id = systemKind 字符串 per plan D9, itemCount=0); 系统组真实行由首次写
 * materialize-on-first-write 落地 (T005/T007)。≥1 行 (已 materialize) → 读回 + 各组
 * itemCount (单次 groupBy), 按 order 升序。findMany 仅本账号行 (accountId 谓词 → 跨账号隔离)。
 *
 * 持仓组 itemCount = holding 表同源派生 (025 D1: qty>0 AND quotable, 与 EP6 items
 * 派生口径一致); 未导入过 → 0 (013 既有行为零回归)。行情值不经本 UC (ADR-0048)。
 */
@Injectable()
export class ListWatchlistGroupsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<GroupListResult> {
    const [rows, holdingsCount] = await Promise.all([
      this.prisma.group.findMany({
        where: { accountId },
        orderBy: { order: 'asc' },
      }),
      // 025 D1: 持仓组成员数派生 (与 list-watchlist-items 派生 where 同口径)。
      this.prisma.holding.count({
        where: { accountId, qty: { gt: 0 }, quotable: true },
      }),
    ]);

    // 零写库投影: 虚拟系统组 id = systemKind (D9), 升序 (自选 order 0 < 持仓 order 1)。
    if (rows.length === 0) {
      const groups = defaultSystemGroups(accountId).map((seed) => ({
        id: seed.systemKind,
        name: seed.name,
        type: seed.type as 'system' | 'custom',
        systemKind: seed.systemKind as 'watchlist' | 'holdings',
        visible: seed.visible,
        order: seed.order,
        itemCount: seed.systemKind === SYSTEM_KIND_HOLDINGS ? holdingsCount : 0,
      }));
      return { groups };
    }

    // itemCount: 单次 groupBy (组数 ≤ ~20), 缺省 0 (空组不在 groupBy 结果中)。
    const counts = await this.prisma.watchlistItem.groupBy({
      by: ['groupId'],
      where: { groupId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const countByGroup = new Map(counts.map((c) => [c.groupId, c._count._all]));

    const groups = rows.map((row) => ({
      id: row.id.toString(),
      // 系统组名恒取常量 (app 单一真相, 改名免数据迁移); 自定义组 (systemKind=null) 用 row.name。
      name:
        row.systemKind === SYSTEM_KIND_WATCHLIST || row.systemKind === SYSTEM_KIND_HOLDINGS
          ? SYSTEM_GROUP_NAMES[row.systemKind]
          : row.name,
      type: row.type as 'system' | 'custom',
      systemKind: row.systemKind as 'watchlist' | 'holdings' | null,
      visible: row.visible,
      order: row.order,
      // 持仓组不挂 WatchlistItem 行 (派生只读) → itemCount 走 holding 派生口径。
      itemCount:
        row.systemKind === SYSTEM_KIND_HOLDINGS ? holdingsCount : (countByGroup.get(row.id) ?? 0),
    }));
    return { groups };
  }
}
