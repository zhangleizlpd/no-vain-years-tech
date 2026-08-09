import { Body, Controller, HttpCode, Ip, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { RetryAfterThrottlerGuard } from '../security/retry-after-throttler.guard.js';
import { RefreshTokenUseCase } from './refresh-token.usecase';
import { LogoutAllUseCase } from './logout-all.usecase';
import { RefreshTokenRequest } from './refresh-token.request';
import { PhoneSmsAuthResponse } from './phone-sms-auth.response';
import { JwtAccessGuard, type AuthenticatedUser } from './jwt-access.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import {
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
  PORTFOLIO_HOLDINGS_ALL,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';

/**
 * 凭证端点 (auth 编排层):
 *   - POST refresh-token (EP1): 凭 body refreshToken 轮换 → 复用 PhoneSmsAuthResponse。无 bearer。
 *   - POST logout-all (EP2): bearer (JwtAccessGuard) → 撤账号全部 refresh-token → 204。
 *
 * 限流 (FR-S14, per-throttler getTracker in auth.module) + 反污染 (用户选方案 A):
 * guards 挂**方法级** (logout-all 需 JwtAccessGuard 先填 req.user 再让 throttler 读
 * logout-all-account tracker); 每路由 @SkipThrottle 显式跳过非己 throttler,避免共享桶污染。
 */
@ApiTags('accounts')
@Controller('v1/accounts')
export class AccountTokenController {
  constructor(
    private readonly refreshTokenUseCase: RefreshTokenUseCase,
    private readonly logoutAllUseCase: LogoutAllUseCase,
  ) {}

  @Post('refresh-token')
  @HttpCode(200)
  @UseGuards(RetryAfterThrottlerGuard)
  @SkipThrottle({
    ...MARKET_PREF_ALL,
    ...BROKER_ACCT_ALL,
    ...MARKETDATA_ALL,
    ...WATCHLIST_ALL,
    ...ALERT_ALL,
    ...CHAT_ALL,
    ...IDEATION_ALL,
    ...OPTIONSDESK_ALL,
    ...PORTFOLIO_HOLDINGS_ALL,
    ...WECHAT_BUCKETS,
    default: true,
    'sms-phone-24h': true,
    'sms-ip-24h': true,
    'me-get': true,
    'me-patch': true,
    'logout-all-ip': true,
    'logout-all-account': true,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_BUCKETS,
  })
  @ApiOperation({
    summary: 'Rotate a refresh token',
    description:
      'Atomically revokes the presented refresh token and issues a fresh access + refresh pair (single-use). Anti-enumeration: all failures fold to 401.',
  })
  @ApiResponse({
    status: 200,
    description: 'Rotated — new tokens issued',
    type: PhoneSmsAuthResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failure (empty / missing refreshToken)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Anti-enumeration failure (invalid / expired / revoked / account not eligible)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S14: per-IP 100/60s, per-token 5/60s)',
    type: ProblemDetailResponse,
  })
  async refresh(
    @Body() body: RefreshTokenRequest,
    @Ip() clientIp: string,
  ): Promise<PhoneSmsAuthResponse> {
    const result = await this.refreshTokenUseCase.execute(body.refreshToken, clientIp);
    return {
      accountId: result.accountId.toString(),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  @Post('logout-all')
  @HttpCode(204)
  // JwtAccessGuard 先行 (填 req.user.accountId) → RetryAfterThrottlerGuard 读 logout-all-account tracker。
  @UseGuards(JwtAccessGuard, RetryAfterThrottlerGuard)
  @SkipThrottle({
    ...MARKET_PREF_ALL,
    ...BROKER_ACCT_ALL,
    ...MARKETDATA_ALL,
    ...WATCHLIST_ALL,
    ...ALERT_ALL,
    ...CHAT_ALL,
    ...IDEATION_ALL,
    ...OPTIONSDESK_ALL,
    ...PORTFOLIO_HOLDINGS_ALL,
    ...WECHAT_BUCKETS,
    default: true,
    'sms-phone-24h': true,
    'sms-ip-24h': true,
    'me-get': true,
    'me-patch': true,
    'refresh-ip': true,
    'refresh-token': true,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_BUCKETS,
  })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Log out from all devices',
    description:
      'Revokes every active refresh token for the bearer-authenticated account (current device included). Idempotent → 204.',
  })
  @ApiResponse({ status: 204, description: 'All sessions revoked (idempotent)' })
  @ApiResponse({
    status: 401,
    description: 'Missing / invalid / expired access token',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S14: per-IP 50/60s, per-account 5/60s)',
    type: ProblemDetailResponse,
  })
  async logoutAll(@Req() req: { user: AuthenticatedUser }): Promise<void> {
    await this.logoutAllUseCase.execute(req.user.accountId);
  }
}
