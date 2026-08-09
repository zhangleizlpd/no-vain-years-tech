import { Body, Controller, Get, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AccountIdThrottlerGuard } from './account-id-throttler.guard';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GetAccountProfileUseCase } from './get-account-profile.usecase';
import { UpdateDisplayNameUseCase } from './update-display-name.usecase';
import { UpdateBioUseCase } from './update-bio.usecase';
import { UpdateGenderUseCase } from './update-gender.usecase';
import { JwtAuthGuard, type AuthenticatedUser } from './jwt-auth.guard';
import { AccountProfileResponse } from './account-profile.response';
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
import { UpdateDisplayNameRequest } from './update-display-name.request';
import { UpdateBioRequest } from './update-bio.request';
import { UpdateGenderRequest } from './update-gender.request';
import { IssueUploadCredentialUseCase } from './issue-upload-credential.usecase';
import { IssueUploadCredentialRequest } from './issue-upload-credential.request';
import { UploadCredentialResponse } from './upload-credential.response';
import { ConfirmProfileImageUseCase } from './confirm-profile-image.usecase';
import { ConfirmProfileImageRequest } from './confirm-profile-image.request';
import { InspectWechatBindingUseCase } from './inspect-wechat-binding.usecase';

/**
 * GET /api/v1/accounts/me
 *
 * Returns profile for the authenticated account (FR-001).
 * JwtAuthGuard enforces Bearer token validation + ACTIVE status check (FR-002, FR-009).
 * All auth failures → unified 401 for anti-enumeration (US4).
 */
@ApiTags('accounts')
@Controller('v1/accounts')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class AccountProfileController {
  constructor(
    private readonly useCase: GetAccountProfileUseCase,
    private readonly updateDisplayNameUseCase: UpdateDisplayNameUseCase,
    private readonly updateBioUseCase: UpdateBioUseCase,
    private readonly updateGenderUseCase: UpdateGenderUseCase,
    private readonly issueUploadCredentialUseCase: IssueUploadCredentialUseCase,
    private readonly confirmProfileImageUseCase: ConfirmProfileImageUseCase,
    // 010 FR-S07: /me + PATCH 响应统一带 wechatBound (account 内 ctx 读, 无 cross-ctx 注释)。
    private readonly inspectWechatBinding: InspectWechatBindingUseCase,
  ) {}

  @Get('me')
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
    default: true,
    'sms-phone-24h': true,
    'sms-ip-24h': true,
    'me-patch': true,
    'refresh-ip': true,
    'refresh-token': true,
    'logout-all-ip': true,
    'logout-all-account': true,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_BUCKETS,
  })
  @Throttle({ 'me-get': { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Get authenticated account profile',
    description:
      'Returns account profile for the bearer-authenticated user. Phone is E.164 raw string; displayName is null for new users (FR-007).',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile retrieved successfully',
    type: AccountProfileResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE (FR-002, FR-009) — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-008: 60 requests per 60s per account)',
    type: ProblemDetailResponse,
  })
  async getProfile(@Req() req: { user: AuthenticatedUser }): Promise<AccountProfileResponse> {
    const result = await this.useCase.execute(req.user.accountId);
    return {
      accountId: result.accountId.toString(),
      phone: result.phone,
      displayName: result.displayName,
      bio: result.bio,
      gender: result.gender,
      avatarUrl: result.avatarUrl,
      backgroundImageUrl: result.backgroundImageUrl,
      status: result.status,
      createdAt: result.createdAt,
      wechatBound: (await this.inspectWechatBinding.execute(req.user.accountId)).bound,
    };
  }

  @Patch('me')
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
    default: true,
    'sms-phone-24h': true,
    'sms-ip-24h': true,
    'me-get': true,
    'refresh-ip': true,
    'refresh-token': true,
    'logout-all-ip': true,
    'logout-all-account': true,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_BUCKETS,
  })
  @Throttle({ 'me-patch': { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Update authenticated account display name',
    description:
      'Sets a new display name for the bearer-authenticated user. Validates FR-005 rules (1-32 Unicode code points, no forbidden chars). Returns updated profile.',
  })
  @ApiResponse({
    status: 200,
    description: 'Display name updated successfully',
    type: AccountProfileResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid display name (violates FR-005 rules)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE (FR-004, FR-009) — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-008: 10 requests per 60s per account)',
    type: ProblemDetailResponse,
  })
  async updateDisplayName(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: UpdateDisplayNameRequest,
  ): Promise<AccountProfileResponse> {
    const result = await this.updateDisplayNameUseCase.execute(
      req.user.accountId,
      body.displayName,
    );
    return {
      accountId: result.accountId.toString(),
      phone: result.phone,
      displayName: result.displayName,
      bio: result.bio,
      gender: result.gender,
      avatarUrl: result.avatarUrl,
      backgroundImageUrl: result.backgroundImageUrl,
      status: result.status,
      createdAt: result.createdAt,
      wechatBound: (await this.inspectWechatBinding.execute(req.user.accountId)).bound,
    };
  }

  @Patch('me/bio')
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
    default: true,
    'sms-phone-24h': true,
    'sms-ip-24h': true,
    'me-get': true,
    'refresh-ip': true,
    'refresh-token': true,
    'logout-all-ip': true,
    'logout-all-account': true,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_BUCKETS,
  })
  @Throttle({ 'me-patch': { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Update authenticated account bio (个人简介)',
    description:
      'Sets the personal bio for the bearer-authenticated user. Validates 007 FR-S03 rules (≤120 Unicode code points after trim, no forbidden chars, empty clears). Returns updated profile.',
  })
  @ApiResponse({
    status: 200,
    description: 'Bio updated successfully (including clear via empty string)',
    type: AccountProfileResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid bio (violates 007 FR-S03 rules)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE (FR-S04) — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S05: 10 requests per 60s per account)',
    type: ProblemDetailResponse,
  })
  async updateBio(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: UpdateBioRequest,
  ): Promise<AccountProfileResponse> {
    const result = await this.updateBioUseCase.execute(req.user.accountId, body.bio);
    return {
      accountId: result.accountId.toString(),
      phone: result.phone,
      displayName: result.displayName,
      bio: result.bio,
      gender: result.gender,
      avatarUrl: result.avatarUrl,
      backgroundImageUrl: result.backgroundImageUrl,
      status: result.status,
      createdAt: result.createdAt,
      wechatBound: (await this.inspectWechatBinding.execute(req.user.accountId)).bound,
    };
  }

  @Patch('me/gender')
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
    default: true,
    'sms-phone-24h': true,
    'sms-ip-24h': true,
    'me-get': true,
    'refresh-ip': true,
    'refresh-token': true,
    'logout-all-ip': true,
    'logout-all-account': true,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_BUCKETS,
  })
  @Throttle({ 'me-patch': { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Update authenticated account gender (性别)',
    description:
      'Sets the gender for the bearer-authenticated user. Validates 008 FR-S03 rules (one of MALE / FEMALE / NON_BINARY / PRIVATE, or null to clear). Returns updated profile.',
  })
  @ApiResponse({
    status: 200,
    description: 'Gender updated successfully (including clear via null)',
    type: AccountProfileResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid gender (not one of the 4 enums; 008 FR-S03)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE (FR-S04) — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S05: 10 requests per 60s per account)',
    type: ProblemDetailResponse,
  })
  async updateGender(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: UpdateGenderRequest,
  ): Promise<AccountProfileResponse> {
    const result = await this.updateGenderUseCase.execute(req.user.accountId, body.gender);
    return {
      accountId: result.accountId.toString(),
      phone: result.phone,
      displayName: result.displayName,
      bio: result.bio,
      gender: result.gender,
      avatarUrl: result.avatarUrl,
      backgroundImageUrl: result.backgroundImageUrl,
      status: result.status,
      createdAt: result.createdAt,
      wechatBound: (await this.inspectWechatBinding.execute(req.user.accountId)).bound,
    };
  }

  @Post('me/profile-image/upload-credential')
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
    default: true,
    'sms-phone-24h': true,
    'sms-ip-24h': true,
    'me-get': true,
    'refresh-ip': true,
    'refresh-token': true,
    'logout-all-ip': true,
    'logout-all-account': true,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_BUCKETS,
  })
  @Throttle({ 'me-patch': { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Issue an OSS upload credential for a profile image (009 EP1)',
    description:
      'Returns a scope-restricted, short-lived OSS PostObject V4 credential. The client POSTs the image bytes straight to OSS (backend never proxies bytes). Credential is locked to the <target>/<accountId>/ key prefix + image content-type whitelist + size + 15min expiry.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload credential issued',
    type: UploadCredentialResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid target / content-type (009 FR-S02)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE (FR-S05) — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S06: 10 requests per 60s per account)',
    type: ProblemDetailResponse,
  })
  async issueUploadCredential(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: IssueUploadCredentialRequest,
  ): Promise<UploadCredentialResponse> {
    return this.issueUploadCredentialUseCase.execute(
      req.user.accountId,
      body.target,
      body.contentType,
    );
  }

  @Patch('me/profile-image')
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
    default: true,
    'sms-phone-24h': true,
    'sms-ip-24h': true,
    'me-get': true,
    'refresh-ip': true,
    'refresh-token': true,
    'logout-all-ip': true,
    'logout-all-account': true,
    ...ALL_DELETION_BUCKETS,
    ...DEVICE_BUCKETS,
  })
  @Throttle({ 'me-patch': { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Confirm a direct-uploaded profile image (009 EP2)',
    description:
      'Persists the OSS public-read URL for an uploaded object onto the account. Validates the objectKey belongs to the account prefix (anti cross-account write) + HEAD-probes the object exists and is an allowed image type before persisting. Returns the updated profile.',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile image confirmed and persisted',
    type: AccountProfileResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid target / objectKey prefix / object missing or wrong type (009 FR-S03)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE (FR-S05) — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (FR-S06: 10 requests per 60s per account)',
    type: ProblemDetailResponse,
  })
  async confirmProfileImage(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: ConfirmProfileImageRequest,
  ): Promise<AccountProfileResponse> {
    const result = await this.confirmProfileImageUseCase.execute(
      req.user.accountId,
      body.target,
      body.objectKey,
    );
    return {
      accountId: result.accountId.toString(),
      phone: result.phone,
      displayName: result.displayName,
      bio: result.bio,
      gender: result.gender,
      avatarUrl: result.avatarUrl,
      backgroundImageUrl: result.backgroundImageUrl,
      status: result.status,
      createdAt: result.createdAt,
      wechatBound: (await this.inspectWechatBinding.execute(req.user.accountId)).bound,
    };
  }
}
