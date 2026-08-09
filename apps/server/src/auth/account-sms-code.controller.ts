import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { normalizePhone } from '../account/account.rules';
import { RequestSmsCodeUseCase } from './request-sms-code.usecase';
import { RequestSmsCodeRequest } from './request-sms-code.request';
import { RequestSmsCodeResponse } from './request-sms-code.response';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import {
  ALL_DELETION_BUCKETS,
  DEVICE_BUCKETS,
  WECHAT_BUCKETS,
  ME_BUCKETS,
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
import { SmsPhoneThrottlerGuard } from './sms-phone-throttler.guard';

/**
 * POST /api/v1/accounts/sms-codes
 *
 * Trigger code generation + dispatch via configured SmsGateway (W2 = MockSms).
 * Returns ttlSec for client UX (countdown / resend gating).
 *
 * Rate limit (FR-S07 #1-3): module-level ThrottlerModule config 启用全部 3 个
 * throttler (sms:<phone> 60s 1 次 / sms:<phone> 24h 10 次 / sms:<ip> 24h 50 次)；
 * 无 @Throttle decorator 时 throttler 6+ 默认 enforce 所有 module throttler with
 * module config limits。SmsPhoneThrottlerGuard fallback getTracker 走 phone key,
 * sms-ip-24h throttler per-throttler getTracker 走 ip key。
 */
@ApiTags('accounts')
@Controller('v1/accounts')
@UseGuards(SmsPhoneThrottlerGuard)
export class AccountSmsCodeController {
  constructor(private readonly useCase: RequestSmsCodeUseCase) {}

  @Post('sms-codes')
  @HttpCode(200)
  // 跳过 refresh-* / logout-all-* / 注销撤销 共享 throttler (本路由不属之, 否则共享桶被污染)。
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
    ...ME_BUCKETS,
    'refresh-ip': true,
    'refresh-token': true,
    'logout-all-ip': true,
    'logout-all-account': true,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_BUCKETS,
  })
  @ApiOperation({
    summary: 'Request an SMS verification code',
    description:
      'Generates a 6-digit code, stores in Redis with TTL, dispatches via SmsGateway. Rate-limited per phone (60s + 24h 10) and per IP (24h 50).',
  })
  @ApiResponse({
    status: 200,
    description: 'Code dispatched — client should start ttlSec countdown',
    type: RequestSmsCodeResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failure (invalid phone format)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S07 #1-3)',
    type: ProblemDetailResponse,
  })
  async request(@Body() body: RequestSmsCodeRequest): Promise<RequestSmsCodeResponse> {
    return this.useCase.execute(normalizePhone(body.phone));
  }
}
