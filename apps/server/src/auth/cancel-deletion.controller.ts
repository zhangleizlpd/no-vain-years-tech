import { Body, Controller, Headers, HttpCode, Ip, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
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
import { CancelCodePhoneThrottlerGuard } from './cancel-code-phone-throttler.guard';
import { SendCancelDeletionCodeUseCase } from './send-cancel-deletion-code.usecase';
import { CancelDeletionUseCase } from './cancel-deletion.usecase';
import { SendCancelCodeRequest } from './send-cancel-code.request';
import { CancelDeletionRequest } from './cancel-deletion.request';
import { PhoneSmsAuthResponse } from './phone-sms-auth.response';
import { InvalidPhoneFormatException } from './invalid-phone-format.exception';

// E.164 +86 CN mobile —— 镜像 account.rules CN_MOBILE_REGEX (未导出, 沿用既有 DTO 内联惯例)。
const CN_MOBILE_PHONE = /^\+861[3-9]\d{9}$/;

/**
 * 撤销注销端点 (auth 编排, **public 无 JwtGuard**; `/v1/auth/cancel-deletion/*`)。
 * EP3 发撤销码 (`POST sms-codes`) + EP4 提交撤销码解冻 (`POST` 根)。
 *
 * CancelCodePhoneThrottlerGuard: phone-hash tracker (FR-S08 不明文落限流器), 同时供
 * cancel-code (EP3) 与 cancel-submit (EP4) 两组 named throttler 取键。每路由 @Throttle
 * 启用己组 + @SkipThrottle 其余桶反污染。手机号 E.164 格式校验在控制器显式做 (非法
 * → 422), 因全局 pipe 把 @Matches 失败统一映射 400, 无法产出 FR-S08 要求的 422。
 */
@ApiTags('account-deletion')
@Controller('v1/auth/cancel-deletion')
@UseGuards(CancelCodePhoneThrottlerGuard)
export class CancelDeletionController {
  constructor(
    private readonly sendCancelDeletionCode: SendCancelDeletionCodeUseCase,
    private readonly cancelDeletionUseCase: CancelDeletionUseCase,
  ) {}

  /** E.164 +86 校验 → 非法抛 422 (先于 eligibility, FR-S08); 返回 trim 后规范号。 */
  private assertValidPhone(raw: string): string {
    const phone = raw.trim();
    if (!CN_MOBILE_PHONE.test(phone)) {
      throw new InvalidPhoneFormatException();
    }
    return phone;
  }

  @Post('sms-codes')
  @HttpCode(200)
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
    ...DEL_SUBMIT_BUCKETS,
    ...CANCEL_SUBMIT_BUCKETS,
  })
  @Throttle({
    'cancel-code': { limit: 1, ttl: 60_000 },
    'cancel-code-ip': { limit: 5, ttl: 60_000 },
  })
  @ApiOperation({
    summary: 'Send cancel-deletion verification code (EP3, public)',
    description:
      'Public endpoint: accepts a phone number; only FROZEN-in-grace accounts receive a ' +
      'CANCEL_DELETION SMS code. The 4 ineligible classes (unregistered / ACTIVE / ANONYMIZED / ' +
      'grace-expired) silently return 200 with a dummy timing pad — no code written, no SMS — so ' +
      'eligible/ineligible are byte- and timing-indistinguishable (FR-S07 anti-enumeration).',
  })
  @ApiResponse({
    status: 200,
    description: 'Accepted — code sent iff eligible (response indistinguishable from ineligible)',
  })
  @ApiResponse({
    status: 422,
    description: 'Phone not E.164 +86 CN mobile — INVALID_PHONE_FORMAT',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S18: per-phone-hash 1/60s, per-IP 5/60s)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'SMS dispatch failed on the eligible path (FR-S21)',
    type: ProblemDetailResponse,
  })
  async sendCancelCode(@Body() body: SendCancelCodeRequest): Promise<void> {
    await this.sendCancelDeletionCode.execute(this.assertValidPhone(body.phone));
  }

  @Post()
  @HttpCode(200)
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
    ...DEL_SUBMIT_BUCKETS,
    ...CANCEL_CODE_BUCKETS,
  })
  @Throttle({
    'cancel-submit': { limit: 5, ttl: 60_000 },
    'cancel-submit-ip': { limit: 10, ttl: 60_000 },
  })
  @ApiOperation({
    summary: 'Submit cancel-deletion code → unfreeze + re-login (EP4, public)',
    description:
      'Public endpoint: FROZEN-in-grace account + valid CANCEL_DELETION code atomically ' +
      'unfreezes (FROZEN→ACTIVE), issues a fresh login session, and emits the ' +
      'deletion-cancelled event (FR-S09/S10/S12). All 5 failure classes (unregistered / ACTIVE / ' +
      'ANONYMIZED / grace-expired / invalid code) fold to byte-identical 401 INVALID_CREDENTIALS ' +
      'with a timing pad (FR-S11 anti-enumeration). 200 + LoginResponse on success.',
  })
  @ApiResponse({
    status: 200,
    description: 'Unfrozen — fresh login tokens',
    type: PhoneSmsAuthResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Missing field / non-6-digit code — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Account-state / code failure folded to INVALID_CREDENTIALS (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 422,
    description: 'Phone not E.164 +86 CN mobile — INVALID_PHONE_FORMAT',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S18: per-phone-hash 5/60s, per-IP 10/60s)',
    type: ProblemDetailResponse,
  })
  async cancelDeletion(
    @Body() body: CancelDeletionRequest,
    @Ip() clientIp: string,
    @Headers('x-device-id') deviceId?: string,
    @Headers('x-device-name') deviceName?: string,
    @Headers('x-device-type') deviceType?: string,
  ): Promise<PhoneSmsAuthResponse> {
    const phone = this.assertValidPhone(body.phone);
    const result = await this.cancelDeletionUseCase.execute(phone, body.code, {
      deviceId,
      deviceName,
      deviceType,
      clientIp,
    });
    return {
      accountId: result.accountId.toString(),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }
}
