import { Controller, Get, HttpCode, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthenticatedUser } from '../account/jwt-auth.guard';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import {
  DEFAULT_BUCKET,
  SMS_CODE_BUCKETS,
  ME_BUCKETS,
  TOKEN_BUCKETS,
  ALL_DELETION_BUCKETS,
  DEVICE_BUCKETS,
  WECHAT_BUCKETS,
  MARKET_PREF_ALL,
  BROKER_ACCT_ALL,
  MARKETDATA_ALL,
  WATCHLIST_ALL,
  CHAT_ALL,
  IDEATION_ALL,
  ALERT_ALL,
  PORTFOLIO_IMPORT_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { ListHoldingsUseCase } from './list-holdings.usecase';
import { HoldingsListResponse } from './holdings-list.response';

/**
 * 既有桶 (001-021) + 025 同组「除己」(import 桶) —— 读 EP @Throttle 己桶
 * (portfolio-holdings-read-account) + @SkipThrottle 其余全部 (own 不在 skip 集内,
 * 沿 015/021 范式)。
 */
const EXISTING_BUCKETS: Record<string, boolean> = {
  ...DEFAULT_BUCKET,
  ...SMS_CODE_BUCKETS,
  ...ME_BUCKETS,
  ...TOKEN_BUCKETS,
  ...ALL_DELETION_BUCKETS,
  ...DEVICE_BUCKETS,
  ...WECHAT_BUCKETS,
  ...MARKET_PREF_ALL,
  ...BROKER_ACCT_ALL,
  ...MARKETDATA_ALL,
  ...WATCHLIST_ALL,
  ...ALERT_ALL,
  ...CHAT_ALL,
  ...IDEATION_ALL,
  ...OPTIONSDESK_ALL,
  ...PORTFOLIO_IMPORT_BUCKET,
};

/**
 * GET /api/v1/portfolio/holdings (025 EP2, FR-007)
 *
 * 当前持仓 (仓位占比降序) + 已清仓 (清仓日期倒序) 双数组一次取 (plan D6);
 * asOf = holding 表快照日, 未导入 → null + 双空。authed (JwtAuthGuard: Bearer +
 * ACTIVE → 失败统一 401 反枚举); 限流 per-account 120/60s (读桶, EP3 共用)。
 */
@ApiTags('portfolio')
@Controller('v1/portfolio/holdings')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class HoldingsController {
  constructor(private readonly listHoldings: ListHoldingsUseCase) {}

  @Get()
  @HttpCode(200)
  @SkipThrottle(EXISTING_BUCKETS)
  @Throttle({ 'portfolio-holdings-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'List holdings + closed positions (EP2)',
    description:
      'Returns the latest imported snapshot: current holdings (weight desc) and closed positions (close date desc). No import yet → asOf null + both arrays empty. Quotes are never inlined — mobile merges via 015 /quote (ADR-0048).',
  })
  @ApiResponse({ status: 200, description: 'Holdings list', type: HoldingsListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (120/60s per account)',
    type: ProblemDetailResponse,
  })
  async list(@Req() req: { user: AuthenticatedUser }): Promise<HoldingsListResponse> {
    return this.listHoldings.execute(req.user.accountId);
  }
}
