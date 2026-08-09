import { ApiProperty } from '@nestjs/swagger';
import { WATCHLIST_MARKETS } from './watchlist.rules';

/** WatchlistItem Prisma row (贫血) → wire view 投影 (BigInt → string, null 穿透)。 */
export function toWatchlistItemView(row: {
  id: bigint;
  groupId: bigint;
  market: string;
  code: string;
  pinned: boolean;
  order: number;
  color: string | null;
  noteRef: string | null;
}): WatchlistItemView {
  return {
    id: row.id.toString(),
    groupId: row.groupId.toString(),
    market: row.market,
    code: row.code,
    pinned: row.pinned,
    order: row.order,
    color: row.color,
    noteRef: row.noteRef,
  };
}

/**
 * 013 自选标的视图 (EP6-EP9 共用，返回某组全量标的最新态)。
 *
 * `id` / `groupId` 为 string (BigInt JSON-safety, 同 GroupItem)。**行情值 (最新/涨幅/涨跌)
 * 不在本契约** —— mobile client 调 015 `/quote?symbols=cn:600519` client-side merge
 * (ADR-0048 / FR-S07)。排序 = 固顶区常驻顶 > 非固顶区 (读侧 `ORDER BY pinned DESC, "order" ASC`)。
 */
export class WatchlistItemView {
  @ApiProperty({ description: '标的 id (数字串)', example: '101' })
  id!: string;

  @ApiProperty({ description: '所属分组 id (数字串)', example: '42' })
  groupId!: string;

  @ApiProperty({ description: '市场', enum: WATCHLIST_MARKETS, example: 'cn' })
  market!: string;

  @ApiProperty({ description: '标的代码 (逻辑指向 015 Instrument)', example: '600519' })
  code!: string;

  @ApiProperty({ description: '是否固顶 (固顶区常驻分组顶部)', example: false })
  pinned!: boolean;

  @ApiProperty({ description: '区内拖拽序 (固顶区 / 非固顶区各 0-based 升序)', example: 0 })
  order!: number;

  @ApiProperty({
    description: '颜色标记 (无则 null)',
    nullable: true,
    type: 'string',
    example: null,
  })
  color!: string | null;

  @ApiProperty({
    description: '笔记关联 ref (无则 null)',
    nullable: true,
    type: 'string',
    example: null,
  })
  noteRef!: string | null;
}

/**
 * GET/POST/PATCH/DELETE `/.../items` 与 `/watchlist-items/{itemId}` 响应体 (EP6-EP9)。
 * `items[]` 按 `pinned DESC, order ASC`；写端点返回受影响组全量最新态，客户端对账乐观更新。
 * 持仓组 V1 派生空 (holdings/import 未建) → `items: []`。
 */
export class ItemListResponse {
  @ApiProperty({ description: '标的列表 (固顶区在前, 各区 order 升序)', type: [WatchlistItemView] })
  items!: WatchlistItemView[];
}
