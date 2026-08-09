import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { RetryAfterThrottlerGuard } from '../security/retry-after-throttler.guard.js';
import { JwtAccessGuard, type AuthenticatedUser } from './jwt-access.guard';
import { ListDevicesUseCase } from './list-devices.usecase';
import { RevokeDeviceUseCase } from './revoke-device.usecase';
import { DeviceListQuery } from './device-list.query';
import { DeviceListResponse } from './device-list.response';
import { ParseBigIntPipe } from './parse-bigint.pipe';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import {
  ALL_DELETION_BUCKETS,
  DEFAULT_BUCKET,
  DEVICE_LIST_BUCKETS,
  DEVICE_REVOKE_BUCKETS,
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

/**
 * 设备 / 登录管理端点 (auth 编排层, ADR-0032):
 *   - GET /v1/auth/devices (EP1): bearer (JwtAccessGuard) → 分页活跃设备列表 (US1)。
 *   - DELETE :recordId (EP2, T010): 单设备远程撤销 (US2)。
 *
 * 鉴权用 auth 自有 **JwtAccessGuard** (无账号状态门控,与 logout-all 同款) —— 设备管理
 * 是 session 安全操作,FROZEN 账号亦应能撤可疑设备 (不复用 account JwtAuthGuard 的
 * isActive 门控)。限流 (FR-S13): named throttler dev-list-* / dev-revoke-* 在 auth.module
 * 定义 (per-throttler getTracker, logout-all 同款),JwtAccessGuard 先填 req.user 供
 * account tracker;每路由 @SkipThrottle 非己桶反共享桶污染 (per throttler-skip-buckets)。
 */
@ApiTags('devices')
@Controller('v1/auth/devices')
export class DeviceManagementController {
  constructor(
    private readonly listDevices: ListDevicesUseCase,
    private readonly revokeDevice: RevokeDeviceUseCase,
  ) {}

  @Get()
  @HttpCode(200)
  // JwtAccessGuard 先行填 req.user.accountId → RetryAfterThrottlerGuard 读 dev-list-account tracker。
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
    ...DEFAULT_BUCKET,
    ...SMS_CODE_BUCKETS,
    ...ME_BUCKETS,
    ...TOKEN_BUCKETS,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_REVOKE_BUCKETS, // GET 不属撤销桶
  })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List active login devices',
    description:
      'Returns the bearer-authenticated account active refresh tokens (one per device), ' +
      'createdAt DESC, paginated. Location is resolved Chinese province+city (raw IP never ' +
      'exposed, FR-S04); isCurrent compares the request x-device-id header to each row deviceId.',
  })
  @ApiResponse({ status: 200, description: 'Paginated device list', type: DeviceListResponse })
  @ApiResponse({
    status: 401,
    description: 'Missing / invalid / expired access token',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S13: per-account 30/60s, per-IP 100/60s)',
    type: ProblemDetailResponse,
  })
  async list(
    @Req() req: { user: AuthenticatedUser },
    @Query() query: DeviceListQuery,
    @Headers('x-device-id') deviceId?: string,
  ): Promise<DeviceListResponse> {
    return this.listDevices.execute(req.user.accountId, deviceId ?? null, query.page, query.size);
  }

  @Delete(':recordId')
  @HttpCode(200)
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
    ...DEFAULT_BUCKET,
    ...SMS_CODE_BUCKETS,
    ...ME_BUCKETS,
    ...TOKEN_BUCKETS,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_LIST_BUCKETS, // DELETE 不属列表桶
  })
  @ApiBearerAuth()
  @ApiParam({
    name: 'recordId',
    type: 'string',
    description:
      'refresh_token 行 PK (设备列表项 id; string for bigint JSON-safety, matches DeviceListItem.id)',
    example: '1001',
  })
  @ApiOperation({
    summary: 'Revoke a single device (remote logout)',
    description:
      'Revokes the target device refresh token (remote logout). Anti-enumeration: non-existent ' +
      'and other-account recordId both fold to byte-identical 404 DEVICE_NOT_FOUND. The current ' +
      'device (x-device-id match) returns 409 CANNOT_REMOVE_CURRENT_DEVICE (use logout instead). ' +
      'Idempotent: already-revoked → 200, no duplicate event. Missing x-device-id → 401.',
  })
  @ApiResponse({ status: 200, description: 'Device revoked (or idempotent no-op)' })
  @ApiResponse({
    status: 401,
    description: 'Missing / invalid access token, or missing x-device-id header (FR-S12)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'DEVICE_NOT_FOUND — not found or belongs to another account (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 409,
    description: 'CANNOT_REMOVE_CURRENT_DEVICE — target is the current device (use logout-all)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S13: per-account 5/60s, per-IP 20/60s)',
    type: ProblemDetailResponse,
  })
  async revoke(
    @Req() req: { user: AuthenticatedUser },
    @Param('recordId', new ParseBigIntPipe()) recordId: bigint,
    @Headers('x-device-id') deviceId?: string,
  ): Promise<void> {
    await this.revokeDevice.execute(req.user.accountId, recordId, deviceId ?? null);
  }
}
