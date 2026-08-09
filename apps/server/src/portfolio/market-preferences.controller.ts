import { Body, Controller, Get, HttpCode, Param, Put, Req, UseGuards } from '@nestjs/common';
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
  BROKER_ACCT_ALL,
  MARKETDATA_ALL,
  WATCHLIST_ALL,
  CHAT_ALL,
  IDEATION_ALL,
  ALERT_ALL,
  PORTFOLIO_HOLDINGS_ALL,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { GetMarketPreferencesUseCase } from './get-market-preferences.usecase';
import { UpdateMarketPreferenceUseCase } from './update-market-preference.usecase';
import { MarketPreferencesResponse } from './market-preferences.response';
import { UpdateMarketPreferenceRequest } from './update-market-preference.request';

/** 011 既有 (001-010) 全部桶 + 012 券商账户桶 —— portfolio 两端点各 @Throttle 己桶 + skip 其余防共享桶污染。 */
const EXISTING_BUCKETS = {
  ...DEFAULT_BUCKET,
  ...SMS_CODE_BUCKETS,
  ...ME_BUCKETS,
  ...TOKEN_BUCKETS,
  ...ALL_DELETION_BUCKETS,
  ...DEVICE_BUCKETS,
  ...WECHAT_BUCKETS,
  ...BROKER_ACCT_ALL,
  ...MARKETDATA_ALL,
  ...WATCHLIST_ALL,
  ...ALERT_ALL,
  ...CHAT_ALL,
  ...IDEATION_ALL,
  ...OPTIONSDESK_ALL,
  ...PORTFOLIO_HOLDINGS_ALL,
};

/**
 * GET  /api/v1/portfolio/market-preferences          (EP1, FR-S01/S02/S06/S08)
 * PUT  /api/v1/portfolio/market-preferences/{market}  (EP2, FR-S03/S04/S05/S08)
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举, 与 /me 一致路径)。
 * 限流 per-account (AccountIdThrottlerGuard): get 60/60s · put 30/60s。
 */
@ApiTags('portfolio')
@Controller('v1/portfolio/market-preferences')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class MarketPreferencesController {
  constructor(
    private readonly getUseCase: GetMarketPreferencesUseCase,
    private readonly updateUseCase: UpdateMarketPreferenceUseCase,
  ) {}

  @Get()
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'mkt-pref-put-account': true })
  @Throttle({ 'mkt-pref-get-account': { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Get market access preferences',
    description:
      'Returns the full 9-market state (3 core toggleable + 6 overseas always inactive). New users get the projected default {cn:active, hk/us:inactive}; GET never writes (FR-S01).',
  })
  @ApiResponse({
    status: 200,
    description: 'Market preferences retrieved',
    type: MarketPreferencesResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE (FR-S02) — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S08: 60/60s per account)',
    type: ProblemDetailResponse,
  })
  async getPreferences(
    @Req() req: { user: AuthenticatedUser },
  ): Promise<MarketPreferencesResponse> {
    return this.getUseCase.execute(req.user.accountId);
  }

  @Put(':market')
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'mkt-pref-get-account': true })
  @Throttle({ 'mkt-pref-put-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Toggle a core market activation',
    description:
      'Immediately persists the active state for a core market (cn/hk/us). Enforces min-1 (cannot deactivate the last active core market → 422) and rejects overseas markets (→ 422). Returns the full 9-market state for reconciliation.',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated; full market state returned',
    type: MarketPreferencesResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid body (missing / non-boolean active) — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE (FR-S02) — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 422,
    description:
      'MIN_ONE_MARKET_REQUIRED (last active core market) or MARKET_NOT_AVAILABLE (overseas market) — FR-S04/S05',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'MARKET_NOT_FOUND (unknown market code)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S08: 30/60s per account)',
    type: ProblemDetailResponse,
  })
  async updatePreference(
    @Req() req: { user: AuthenticatedUser },
    @Param('market') market: string,
    @Body() body: UpdateMarketPreferenceRequest,
  ): Promise<MarketPreferencesResponse> {
    return this.updateUseCase.execute(req.user.accountId, market, body.active);
  }
}
