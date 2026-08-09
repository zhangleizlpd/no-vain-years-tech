import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * EP5 批量重排单项: groupId (虚拟系统组 keyword 或真实数字串, D9) + 目标 order + visible。
 */
export class ReorderGroupEntry {
  @ApiProperty({ description: '分组 id (keyword 系统组 或 数字串)', example: 'watchlist' })
  @IsString()
  @IsNotEmpty()
  groupId!: string;

  @ApiProperty({ description: '目标拖拽序 (0-based)', example: 0 })
  @IsInt()
  @Min(0)
  order!: number;

  @ApiProperty({ description: '是否可见 (隐藏切换)', example: true })
  @IsBoolean()
  visible!: boolean;
}

/**
 * PATCH /api/v1/portfolio/watchlist-groups request body (EP5 批量拖拽序 + 隐藏切换)。
 * 系统组首次重排触发 materialize (D2); last-write-wins, server 不强制至少一组可见 (D4)。
 */
export class ReorderWatchlistGroupsRequest {
  @ApiProperty({ description: '重排条目 (全量或子集)', type: [ReorderGroupEntry] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderGroupEntry)
  ordered!: ReorderGroupEntry[];
}
