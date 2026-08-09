import { Body, Controller, Delete, HttpCode, Param, Put, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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
  ALERT_WRITE_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { UpsertPushBindingUseCase } from './upsert-push-binding.usecase';
import { DeletePushBindingUseCase } from './delete-push-binding.usecase';
import { UpsertPushBindingRequest } from './upsert-push-binding.request';
import {
  DeletePushBindingResponse,
  PushBindingResponse,
  toPushBindingResponse,
} from './push-binding.response';

/** 既有桶 (001-015) —— 同 alerts.controller, alert EP 各 @Throttle 己桶 + skip 其余防共享桶污染。 */
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
  ...CHAT_ALL,
  ...IDEATION_ALL,
  ...OPTIONSDESK_ALL,
};

/** @SkipThrottle 集 = 既有全部桶 + alert 同组「除己」其余桶 (own 由 @Throttle 单独启用)。 */
function skipExcept(own: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...EXISTING_BUCKETS, ...ALERT_ALL };
  for (const key of Object.keys(own)) delete skip[key];
  return skip;
}

/**
 * PUT    /api/v1/alert/push-binding                   (EP9 设备绑定上报, FR-001/FR-002)
 * DELETE /api/v1/alert/push-binding/{registrationId}  (EP10 登出解绑, FR-003)
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举)。EP9 转绑语义
 * (clarify Q1): RegID 全局唯一, 他账号已绑 → 整体改绑当前账号, 幂等无 409。EP10
 * UC 层 scope accountId 天然反枚举 (他人 → deleted:0 无杂音)。限流 per-account
 * (AccountIdThrottlerGuard): 复用 021 write 桶 30/60s (plan §API Contracts)。
 */
@ApiTags('alert')
@Controller('v1/alert')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class PushBindingController {
  constructor(
    private readonly upsertPushBinding: UpsertPushBindingUseCase,
    private readonly deletePushBinding: DeletePushBindingUseCase,
  ) {}

  @Put('push-binding')
  @HttpCode(200)
  @SkipThrottle(skipExcept(ALERT_WRITE_BUCKET))
  @Throttle({ 'alert-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Upsert push binding (EP9)',
    description:
      'Binds the device RegistrationID to the authed account. RegID is globally unique — bound to another account → rebound to the current account (old binding evicted); same-account re-report → refreshes boundAt. Idempotent, no 409.',
  })
  @ApiResponse({ status: 200, description: 'Binding upserted', type: PushBindingResponse })
  @ApiResponse({
    status: 400,
    description: 'FORM_VALIDATION — registrationId empty/>64 or platform not android',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async upsert(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: UpsertPushBindingRequest,
  ): Promise<PushBindingResponse> {
    const row = await this.upsertPushBinding.execute(req.user.accountId, {
      registrationId: body.registrationId,
      platform: body.platform,
    });
    return toPushBindingResponse(row);
  }

  @Delete('push-binding/:registrationId')
  @HttpCode(200)
  @SkipThrottle(skipExcept(ALERT_WRITE_BUCKET))
  @Throttle({ 'alert-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({
    name: 'registrationId',
    description: '极光 RegistrationID',
    example: '1507bfd3f7c466c355c',
  })
  @ApiOperation({
    summary: 'Delete push binding (EP10)',
    description:
      'Unbinds only when the RegistrationID belongs to the authed account, returns the actual deleted count (foreign/unknown → 0, anti-enumeration). Idempotent.',
  })
  @ApiResponse({ status: 200, description: 'Deleted count', type: DeletePushBindingResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async delete(
    @Req() req: { user: AuthenticatedUser },
    @Param('registrationId') registrationId: string,
  ): Promise<DeletePushBindingResponse> {
    const deleted = await this.deletePushBinding.execute(req.user.accountId, registrationId);
    return { deleted };
  }
}
