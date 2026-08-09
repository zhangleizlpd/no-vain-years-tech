import { ApiProperty } from '@nestjs/swagger';

/**
 * 014 EP1 watchlist-status — 标的在某个非持仓组的归属 (groupId + itemId 数字串)。
 *
 * `itemId` 供编辑分组面板「取消勾选 → 精确删」直接喂 013 EP9 (DELETE item)，免二次查行。
 */
export class WatchlistMembership {
  @ApiProperty({ description: '所属分组 id (数字串)', example: '42' })
  groupId!: string;

  @ApiProperty({ description: '该归属对应的 WatchlistItem id (数字串)', example: '101' })
  itemId!: string;
}

/**
 * 014 唯一新 server 端点响应体 (GET .../{market}/{code}/watchlist-status)。
 *
 * - **`inWatchlist`** = 标的在系统「自选」组 (窄义, OQ3 2026-06-03 收窄) → 喂底栏加/删按钮文案。
 * - **`memberships`** = 标的在所有**非持仓**组 (系统「自选」+ 任意自定义组 `systemKind=null`,
 *   排除持仓派生 `'holdings'`) 的 `{groupId,itemId}` → 喂编辑分组面板勾选态 + 取消勾时精确删。
 *
 * 未知 symbol / 非法 market → `{ inWatchlist:false, memberships:[] }` (非 404, 反枚举, FR-S06)。
 * 行情/详情不在本契约 (ADR-0048, mobile client 直调 015 EP3/EP4 client-side merge)。
 */
export class WatchlistStatusResponse {
  @ApiProperty({ description: '是否在系统「自选」组 (窄义)', example: false })
  inWatchlist!: boolean;

  @ApiProperty({
    description: '所有非持仓组的归属 (喂编辑分组面板勾选态)',
    type: [WatchlistMembership],
  })
  memberships!: WatchlistMembership[];
}
