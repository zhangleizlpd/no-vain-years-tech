import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { WatchlistStatusResponse } from './watchlist-status.response';

/**
 * 014 US6 EP1 — 读 (market,code) 的自选态 + 非持仓组归属 (intra query, ADR-0043 直注
 * PrismaService 无 repository; 镜像 013 list-watchlist-groups.usecase.ts)。
 *
 * 单查 watchlist_item: 谓词 (market, code, group.accountId + 非持仓组白名单) → 一次拿齐
 * inWatchlist (窄义,「自选」组) + memberships (所有非持仓组)。零写、零事务、零跨 ctx
 * (仅读 portfolio 自有 group/watchlist_item, 详情/行情归 mobile client-side merge, ADR-0048)。
 *
 * **⚠ null 安全 (D2)**: 自定义组 systemKind=null 必须纳入 memberships, 故用
 * `OR:[{systemKind:null},{systemKind:'watchlist'}]` 显式白名单, **不用** `NOT:{systemKind:'holdings'}`
 * —— Prisma `NOT` 生成 SQL `<>`, 三值逻辑下 `NULL <> 'holdings'` 为 UNKNOWN → 漏掉所有自定义组。
 */
@Injectable()
export class GetWatchlistStatusUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, market: string, code: string): Promise<WatchlistStatusResponse> {
    const rows = await this.prisma.watchlistItem.findMany({
      where: {
        market,
        code,
        group: {
          accountId,
          OR: [{ systemKind: null }, { systemKind: 'watchlist' }],
        },
      },
      select: {
        id: true,
        groupId: true,
        group: { select: { systemKind: true } },
      },
    });

    const memberships = rows.map((row) => ({
      groupId: row.groupId.toString(),
      itemId: row.id.toString(),
    }));
    const inWatchlist = rows.some((row) => row.group.systemKind === 'watchlist');

    return { inWatchlist, memberships };
  }
}
