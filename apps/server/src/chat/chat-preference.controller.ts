import { Body, Controller, Get, HttpCode, Put, Req, UseGuards } from '@nestjs/common';
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
  MARKET_PREF_ALL,
  BROKER_ACCT_ALL,
  MARKETDATA_ALL,
  WATCHLIST_ALL,
  ALERT_ALL,
  PORTFOLIO_HOLDINGS_ALL,
  CHAT_READ_BUCKET,
  CHAT_WRITE_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { GetChatPreferenceUseCase } from './get-chat-preference.usecase';
import { UpsertChatPreferenceUseCase } from './upsert-chat-preference.usecase';
import { UpsertChatPreferenceRequest } from './upsert-chat-preference.request';
import { ChatPreferenceResponse } from './chat.response';

/** 既有 + chat 全部桶集合 (各 EP @Throttle 己桶, @SkipThrottle 其余防共享存储桶污染, 沿 021 范式)。 */
const ALL_BUCKETS: Record<string, boolean> = {
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
  ...PORTFOLIO_HOLDINGS_ALL,
  ...OPTIONSDESK_ALL,
  ...CHAT_READ_BUCKET,
  ...CHAT_WRITE_BUCKET,
};

/** 某 EP 的 @SkipThrottle 集 = 全部桶除己 (own 由 @Throttle 单独启用, 不在 skip 集内)。 */
function skipExcept(own: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...ALL_BUCKETS };
  for (const key of Object.keys(own)) delete skip[key];
  return skip;
}

/**
 * GET /api/v1/chat/preferences  (读账号级自定义指令, 未设置 → 空串)
 * PUT /api/v1/chat/preferences  (upsert 账号级自定义指令, 空串 = 清空)
 *
 * 031 T004 (plan D5)。authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举)。
 * 偏好按 `req.user.accountId` **自绑** (端点无「他人资源」概念 — token 决定读写哪个账号的偏好,
 * 不接受路径/body 里的 accountId), 故无越权 404 路径; 越权 = 换 token, 各读各的 (IT 断言)。
 * 长度上限 2000 在 DTO `@MaxLength` 折叠成 400 (FR-005), DB `@db.Text` 不做第二道拒绝 (U1)。
 * 限流 per-account (AccountIdThrottlerGuard): read 120/60s · write 30/60s (复用 chat 读/写桶)。
 */
@ApiTags('chat')
@Controller('v1/chat')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class ChatPreferenceController {
  constructor(
    private readonly getChatPreference: GetChatPreferenceUseCase,
    private readonly upsertChatPreference: UpsertChatPreferenceUseCase,
  ) {}

  @Get('preferences')
  @HttpCode(200)
  @SkipThrottle(skipExcept(CHAT_READ_BUCKET))
  @Throttle({ 'chat-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Get account-level chat custom instruction (031 D5 / FR-002)',
    description:
      'Returns the authed account custom instruction (system-prompt user layer source). Never set / cleared → empty string (U1: row-absent and empty both collapse to ""). Account-scoped via JWT (req.user.accountId); no other-account access path (token binds the resource).',
  })
  @ApiResponse({ status: 200, description: 'Custom instruction', type: ChatPreferenceResponse })
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
  async get(@Req() req: { user: AuthenticatedUser }): Promise<ChatPreferenceResponse> {
    return this.getChatPreference.execute(req.user.accountId);
  }

  @Put('preferences')
  @HttpCode(200)
  @SkipThrottle(skipExcept(CHAT_WRITE_BUCKET))
  @Throttle({ 'chat-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Upsert account-level chat custom instruction (031 D5 / FR-002/005)',
    description:
      'Upserts the authed account custom instruction (single account-level row, idempotent by accountId unique). Empty string = clear (D9). Over 2000 chars → 400 (FR-005, validator-only length gate; nothing persisted half-way). Account-scoped via JWT (req.user.accountId).',
  })
  @ApiResponse({ status: 200, description: 'Saved', type: ChatPreferenceResponse })
  @ApiResponse({
    status: 400,
    description: 'customInstruction over 2000 chars / not a string',
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
    @Body() body: UpsertChatPreferenceRequest,
  ): Promise<ChatPreferenceResponse> {
    await this.upsertChatPreference.execute(req.user.accountId, body.customInstruction);
    return { customInstruction: body.customInstruction };
  }
}
