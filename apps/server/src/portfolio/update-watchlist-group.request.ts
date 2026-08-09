import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * PATCH /api/v1/portfolio/watchlist-groups/{groupId} request body (EP3 自定义组改名)。
 * 系统组改名在 UC 拒 (422 SYSTEM_GROUP_PROTECTED), 不靠 DTO。
 */
export class UpdateWatchlistGroupRequest {
  @ApiProperty({ description: '新分组名 (≤40, per-account 去重)', example: '价值股' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name!: string;
}
