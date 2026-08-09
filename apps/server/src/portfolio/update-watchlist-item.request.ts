import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsString, IsNotEmpty, IsIn, MaxLength } from 'class-validator';

/**
 * PATCH /api/v1/portfolio/watchlist-items/{itemId} request body (EP8 标的改操作)。
 *
 * 全字段可选 (菜单常态单操作, FR-S04/S05): `pinned` 固顶切换 / `move` 区内移到最前·最后 /
 * `targetGroupId` 改归属组 / `color` 颜色 / `noteRef` 笔记关联。浅校验违反 → 400 FORM_VALIDATION;
 * 业务校验 (持仓组拒 / 组不存在) 在 UpdateWatchlistItemUseCase。`pinned` 与 `move` 同传时
 * `pinned` 优先 (UC deriveOp)。
 */
export class UpdateWatchlistItemRequest {
  @ApiPropertyOptional({ description: '固顶切换 (true=固顶到组顶部)', example: true })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ description: '区内移动 (固顶区/非固顶区内调位)', enum: ['front', 'back'] })
  @IsOptional()
  @IsIn(['front', 'back'])
  move?: 'front' | 'back';

  @ApiPropertyOptional({ description: '目标归属组 id (keyword 或数字串; 持仓组拒)', example: '42' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  targetGroupId?: string;

  @ApiPropertyOptional({ description: '颜色标记 (≤16)', example: '#E5484D' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string;

  @ApiPropertyOptional({ description: '笔记关联 ref (≤64)', example: 'note_abc123' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  noteRef?: string;
}
