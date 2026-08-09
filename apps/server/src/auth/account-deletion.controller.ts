import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { JwtAuthGuard, type AuthenticatedUser } from '../account/jwt-auth.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import {
  CANCEL_CODE_BUCKETS,
  CANCEL_SUBMIT_BUCKETS,
  DEFAULT_BUCKET,
  DEL_CODE_BUCKETS,
  DEL_SUBMIT_BUCKETS,
  DEVICE_BUCKETS,
  ME_BUCKETS,
  SMS_CODE_BUCKETS,
  TOKEN_BUCKETS,
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
import { SendDeletionCodeUseCase } from './send-deletion-code.usecase';
import { DeleteAccountUseCase } from './delete-account.usecase';
import { DeleteAccountRequest } from './delete-account.request';

/**
 * 注销删除端点 (auth 编排, authed; `/v1/accounts/me/*`)。EP1 发注销码 +
 * EP2 提交注销码冻结。JwtAuthGuard 取 accountId, AccountIdThrottlerGuard 评估
 * module throttler (del-code-* / del-submit-* 自带 getTracker)。每路由 @SkipThrottle
 * 跳过非己 throttler (反共享桶污染, per throttler-skip-buckets)。
 */
@ApiTags('account-deletion')
@Controller('v1/accounts')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class AccountDeletionController {
  constructor(
    private readonly sendDeletionCode: SendDeletionCodeUseCase,
    private readonly deleteAccount: DeleteAccountUseCase,
  ) {}

  @Post('me/deletion-codes')
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
    ...WECHAT_BUCKETS,
    ...DEFAULT_BUCKET,
    ...DEVICE_BUCKETS,
    ...SMS_CODE_BUCKETS,
    ...ME_BUCKETS,
    ...TOKEN_BUCKETS,
    ...DEL_SUBMIT_BUCKETS,
    ...CANCEL_CODE_BUCKETS,
    ...CANCEL_SUBMIT_BUCKETS,
  })
  @Throttle({
    'del-code-account': { limit: 1, ttl: 60_000 },
    'del-code-ip': { limit: 5, ttl: 60_000 },
  })
  @ApiOperation({
    summary: 'Send account-deletion verification code (EP1)',
    description:
      'Issues a DELETE_ACCOUNT SMS code for the bearer-authenticated account (FR-S01/S02). ' +
      'Non-ACTIVE accounts fold to 401 (anti-enumeration). 204 on dispatch.',
  })
  @ApiResponse({ status: 204, description: 'Code dispatched (no body)' })
  @ApiResponse({
    status: 401,
    description: 'Invalid token or account not ACTIVE — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S18: per-account 1/60s, per-IP 5/60s)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'SMS dispatch failed (FR-S21)',
    type: ProblemDetailResponse,
  })
  async sendDeletionCodeForMe(@Req() req: { user: AuthenticatedUser }): Promise<void> {
    await this.sendDeletionCode.execute(req.user.accountId);
  }

  @Post('me/deletion')
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
    ...WECHAT_BUCKETS,
    ...DEFAULT_BUCKET,
    ...DEVICE_BUCKETS,
    ...SMS_CODE_BUCKETS,
    ...ME_BUCKETS,
    ...TOKEN_BUCKETS,
    ...DEL_CODE_BUCKETS,
    ...CANCEL_CODE_BUCKETS,
    ...CANCEL_SUBMIT_BUCKETS,
  })
  @Throttle({
    'del-submit-account': { limit: 5, ttl: 60_000 },
    'del-submit-ip': { limit: 10, ttl: 60_000 },
  })
  @ApiOperation({
    summary: 'Submit account-deletion code → freeze account (EP2)',
    description:
      'Validates the DELETE_ACCOUNT code then atomically freezes the account ' +
      '(15-day grace), revokes all refresh tokens, and emits the deletion-requested ' +
      'event (FR-S03/S04/S06). Any code failure folds to 401 INVALID_DELETION_CODE. 204 on freeze.',
  })
  @ApiResponse({ status: 204, description: 'Account frozen (no body)' })
  @ApiResponse({
    status: 400,
    description: 'Missing / non-6-digit code — FORM_VALIDATION (distinct from credential path)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Code not found / hash mismatch / expired / used — folded to INVALID_DELETION_CODE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S18: per-account 5/60s, per-IP 10/60s)',
    type: ProblemDetailResponse,
  })
  async submitDeletionForMe(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: DeleteAccountRequest,
  ): Promise<void> {
    await this.deleteAccount.execute(req.user.accountId, body.code);
  }
}
