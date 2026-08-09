import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { JwtAuthGuard, type AuthenticatedUser } from '../account/jwt-auth.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import {
  ALL_DELETION_BUCKETS,
  DEFAULT_BUCKET,
  DEVICE_BUCKETS,
  ME_BUCKETS,
  SMS_CODE_BUCKETS,
  TOKEN_BUCKETS,
  WECHAT_BIND_BUCKETS,
  WECHAT_UNBIND_BUCKETS,
  WECHAT_UNBIND_CODE_BUCKETS,
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
import { BindWechatUseCase } from './bind-wechat.usecase';
import { BindWechatRequest } from './bind-wechat.request';
import { SendUnbindWechatCodeUseCase } from './send-unbind-wechat-code.usecase';
import { UnbindWechatUseCase } from './unbind-wechat.usecase';
import { UnbindWechatRequest } from './unbind-wechat.request';

/**
 * 微信绑定端点 (auth 编排, authed; `/v1/accounts/me/wechat-binding*`)。
 * EP1 绑定创建 + EP2 解绑发码 + EP3 验码解绑。JwtAuthGuard 取 accountId,
 * AccountIdThrottlerGuard 评估 module throttler (wx-* 自带 getTracker)。每路由
 * @SkipThrottle 跳过非己 throttler (反共享桶污染)。
 */
@ApiTags('wechat-binding')
@Controller('v1/accounts')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class WechatBindingController {
  constructor(
    private readonly bindWechat: BindWechatUseCase,
    private readonly sendUnbindWechatCode: SendUnbindWechatCodeUseCase,
    private readonly unbindWechat: UnbindWechatUseCase,
  ) {}

  @Post('me/wechat-binding')
  @HttpCode(201)
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
    ...DEFAULT_BUCKET,
    ...SMS_CODE_BUCKETS,
    ...ME_BUCKETS,
    ...TOKEN_BUCKETS,
    ...DEVICE_BUCKETS,
    ...ALL_DELETION_BUCKETS,
    ...WECHAT_UNBIND_CODE_BUCKETS,
    ...WECHAT_UNBIND_BUCKETS,
  })
  @Throttle({
    'wx-bind': { limit: 5, ttl: 60_000 },
    'wx-bind-ip': { limit: 10, ttl: 60_000 },
  })
  @ApiOperation({
    summary: 'Bind WeChat to the authenticated account (EP1)',
    description:
      'Resolves the opaque authCode to an openid (Phase 1 stub) then links it to the ' +
      'bearer-authenticated account (FR-S02). Non-ACTIVE accounts fold to 401 (anti-enumeration). ' +
      'Idempotent re-bind of the same openid returns 201 (O7). Does NOT modify profile.',
  })
  @ApiResponse({ status: 201, description: 'WeChat bound (or idempotent re-bind); no body' })
  @ApiResponse({
    status: 401,
    description: 'Invalid token or account not ACTIVE — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 409,
    description:
      'WECHAT_ALREADY_BOUND_OTHER (openid bound to another account) or ' +
      'WECHAT_ACCOUNT_ALREADY_BOUND (this account already has a different WeChat, R2)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S06: per-account 5/60s, per-IP 10/60s)',
    type: ProblemDetailResponse,
  })
  async bindWechatForMe(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: BindWechatRequest,
  ): Promise<void> {
    await this.bindWechat.execute(req.user.accountId, body.authCode);
  }

  @Post('me/wechat-binding/unbind-codes')
  @HttpCode(204)
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
    ...DEFAULT_BUCKET,
    ...SMS_CODE_BUCKETS,
    ...ME_BUCKETS,
    ...TOKEN_BUCKETS,
    ...DEVICE_BUCKETS,
    ...ALL_DELETION_BUCKETS,
    ...WECHAT_BIND_BUCKETS,
    ...WECHAT_UNBIND_BUCKETS,
  })
  @Throttle({
    'wx-unbind-code': { limit: 1, ttl: 60_000 },
    'wx-unbind-code-ip': { limit: 5, ttl: 60_000 },
  })
  @ApiOperation({
    summary: 'Send WeChat-unbind verification code (EP2)',
    description:
      'Issues an UNBIND_WECHAT SMS code for the bearer-authenticated account (FR-S03). ' +
      'Non-ACTIVE or non-bound accounts fold to 401 (anti-enumeration). No binding change. 204 on dispatch.',
  })
  @ApiResponse({ status: 204, description: 'Code dispatched (no body)' })
  @ApiResponse({
    status: 401,
    description:
      'Invalid token, account not ACTIVE, or WeChat not bound — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S06: per-account 1/60s, per-IP 5/60s)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'SMS dispatch failed (FR-S21)',
    type: ProblemDetailResponse,
  })
  async sendUnbindCodeForMe(@Req() req: { user: AuthenticatedUser }): Promise<void> {
    await this.sendUnbindWechatCode.execute(req.user.accountId);
  }

  @Post('me/wechat-binding/unbind')
  @HttpCode(204)
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
    ...DEFAULT_BUCKET,
    ...SMS_CODE_BUCKETS,
    ...ME_BUCKETS,
    ...TOKEN_BUCKETS,
    ...DEVICE_BUCKETS,
    ...ALL_DELETION_BUCKETS,
    ...WECHAT_BIND_BUCKETS,
    ...WECHAT_UNBIND_CODE_BUCKETS,
  })
  @Throttle({
    'wx-unbind': { limit: 5, ttl: 60_000 },
    'wx-unbind-ip': { limit: 10, ttl: 60_000 },
  })
  @ApiOperation({
    summary: 'Submit WeChat-unbind code → delete binding (EP3)',
    description:
      'Validates the UNBIND_WECHAT code then atomically marks it used and deletes the WeChat ' +
      'binding (FR-S04). Any code failure folds to 401 INVALID_UNBIND_CODE. No token revoke, ' +
      'no event. 204 on unbind.',
  })
  @ApiResponse({ status: 204, description: 'WeChat unbound (no body)' })
  @ApiResponse({
    status: 400,
    description: 'Missing / non-6-digit code — FORM_VALIDATION (distinct from credential path)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Code not found / hash mismatch / expired / used — folded to INVALID_UNBIND_CODE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S06: per-account 5/60s, per-IP 10/60s)',
    type: ProblemDetailResponse,
  })
  async unbindWechatForMe(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: UnbindWechatRequest,
  ): Promise<void> {
    await this.unbindWechat.execute(req.user.accountId, body.code);
  }
}
