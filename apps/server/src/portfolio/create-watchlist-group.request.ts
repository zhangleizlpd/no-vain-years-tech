import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * POST /api/v1/portfolio/watchlist-groups request body (EP2 建自定义组)。
 *
 * 浅校验 (类型 + 非空 + ≤40, 对齐 schema VarChar(40)): 违反 → 400 `FORM_VALIDATION`。
 * 深度校验 (name per-account 去重) 在 CreateWatchlistGroupUseCase。
 */
export class CreateWatchlistGroupRequest {
  @ApiProperty({ description: '自定义分组名 (≤40, per-account 去重)', example: '科技股' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name!: string;
}
