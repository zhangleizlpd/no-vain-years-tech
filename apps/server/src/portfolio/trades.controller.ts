import { Controller, Get, HttpCode, Query, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthenticatedUser } from '../account/jwt-auth.guard';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import { FormValidationException } from '../security/form-validation.exception';
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
import { ListTradesUseCase } from './list-trades.usecase';
import { TradeListResponse } from './trade-list.response';

/**
 * 既有桶 (001-021) + 025 同组「除己」(import 桶) —— 读 EP @Throttle 己桶
 * (portfolio-holdings-read-account, EP2 共用) + @SkipThrottle 其余全部 (own 不在
 * skip 集内, 沿 015/021 范式)。
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
 * GET /api/v1/portfolio/trades?market=&code= (025 EP3, FR-008)
 *
 * 按标的等值查交易流水, 成交时间倒序; 未交易标的 → 空 items (200 非 404);
 * 资金行 (code null) 天然不命中。market/code 必填 → 缺失 400 (FORM_VALIDATION)。
 * authed (JwtAuthGuard: Bearer + ACTIVE → 失败统一 401 反枚举); 限流 per-account
 * 120/60s (读桶, EP2 共用)。
 */
@ApiTags('portfolio')
@Controller('v1/portfolio/trades')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class TradesController {
  constructor(private readonly listTrades: ListTradesUseCase) {}

  @Get()
  @HttpCode(200)
  @SkipThrottle(EXISTING_BUCKETS)
  @Throttle({ 'portfolio-holdings-read-account': { limit: 120, ttl: 60_000 } })
  @ApiQuery({ name: 'market', description: '市场 (V1 仅 cn)', example: 'cn' })
  @ApiQuery({ name: 'code', description: '标的代码', example: '603915' })
  @ApiOperation({
    summary: 'List trades of one instrument (EP3)',
    description:
      'Equality lookup on (market, code), newest first (tradeDate desc, tradeTime desc nulls last). Unknown / never-traded instrument → empty items (200, not 404). Cash rows (null code) never match.',
  })
  @ApiResponse({ status: 200, description: 'Trade list', type: TradeListResponse })
  @ApiResponse({
    status: 400,
    description: 'FORM_VALIDATION — market/code missing',
    type: ProblemDetailResponse,
  })
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
  async list(
    @Req() req: { user: AuthenticatedUser },
    @Query('market') market?: string,
    @Query('code') code?: string,
  ): Promise<TradeListResponse> {
    const m = market?.trim() ?? '';
    const c = code?.trim() ?? '';
    const missing: { field: string; messages: string[] }[] = [];
    if (m === '') missing.push({ field: 'market', messages: ['market 必填'] });
    if (c === '') missing.push({ field: 'code', messages: ['code 必填'] });
    if (missing.length > 0) {
      throw new FormValidationException(missing);
    }
    return this.listTrades.execute(req.user.accountId, m, c);
  }
}
