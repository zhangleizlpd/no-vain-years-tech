import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsIn, MaxLength } from 'class-validator';
import { WATCHLIST_MARKETS } from './watchlist.rules';

/**
 * POST /api/v1/portfolio/watchlist-groups/{groupId}/items request body (EP7 加自选标的)。
 *
 * 浅校验 (类型 + 非空 + market 词表 + code ≤16, 对齐 schema): 违反 → 400 `FORM_VALIDATION`。
 * 业务校验 (持仓组拒 / 组内幂等) 在 AddWatchlistItemUseCase。
 */
export class AddWatchlistItemRequest {
  @ApiProperty({ description: '市场', enum: WATCHLIST_MARKETS, example: 'cn' })
  @IsIn(WATCHLIST_MARKETS)
  market!: string;

  @ApiProperty({ description: '标的代码 (≤16, 逻辑指向 015 Instrument)', example: '600519' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  code!: string;
}
