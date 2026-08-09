import { Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthenticatedUser } from '../account/jwt-auth.guard';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import { FormValidationException } from '../security/form-validation.exception';
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
  PORTFOLIO_HOLDINGS_ALL,
  ALERT_READ_BUCKET,
  ALERT_WRITE_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { ListMessagesUseCase, MAX_MESSAGE_PAGE_SIZE } from './list-messages.usecase';
import { GetUnreadCountUseCase } from './get-unread-count.usecase';
import { MarkMessagesReadUseCase } from './mark-messages-read.usecase';
import { MessageListResponse, UnreadCountResponse } from './message.response';

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
  ...PORTFOLIO_HOLDINGS_ALL,
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
 * GET  /api/v1/alert/messages               (EP6 消息列表: triggeredAt 倒序 + keyset 分页, FR-S06/FR-M06)
 * GET  /api/v1/alert/messages/unread-count  (EP7 未读计数: 水位线口径, FR-S06/FR-M07)
 * POST /api/v1/alert/messages/mark-read     (EP8 置已读: 水位线推 now, 屏级语义 plan D6)
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举)。未读状态服务端
 * 持久 (AlertReadCursor) → 多设备一致 (SC-005)。限流 per-account (AccountIdThrottlerGuard):
 * read 120/60s · write 30/60s。
 */
@ApiTags('alert')
@Controller('v1/alert')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class AlertMessagesController {
  constructor(
    private readonly listMessages: ListMessagesUseCase,
    private readonly getUnreadCount: GetUnreadCountUseCase,
    private readonly markMessagesRead: MarkMessagesReadUseCase,
  ) {}

  @Get('messages')
  @HttpCode(200)
  @SkipThrottle(skipExcept(ALERT_READ_BUCKET))
  @Throttle({ 'alert-read-account': { limit: 120, ttl: 60_000 } })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'keyset 游标 (上页 nextCursor 原样回传); 省略 = 首页',
    example: '301',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `页大小 (默认 20, 上限 ${MAX_MESSAGE_PAGE_SIZE})`,
    example: '20',
  })
  @ApiOperation({
    summary: 'List trigger messages (EP6)',
    description:
      'Returns trigger messages newest-first with keyset pagination. Each message renders from trigger snapshots (readable after the alert is deleted). unread = triggeredAt > account read cursor (no cursor row = all unread).',
  })
  @ApiResponse({ status: 200, description: 'Message page', type: MessageListResponse })
  @ApiResponse({
    status: 400,
    description: 'FORM_VALIDATION — non-numeric cursor / limit',
    type: ProblemDetailResponse,
  })
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
  async list(
    @Req() req: { user: AuthenticatedUser },
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<MessageListResponse> {
    if (limit !== undefined && !/^\d+$/.test(limit)) {
      throw new FormValidationException([{ field: 'limit', messages: ['limit 必须为正整数'] }]);
    }
    return this.listMessages.execute(req.user.accountId, {
      cursor,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
  }

  @Get('messages/unread-count')
  @HttpCode(200)
  @SkipThrottle(skipExcept(ALERT_READ_BUCKET))
  @Throttle({ 'alert-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Unread message count (EP7)',
    description:
      'count(trigger WHERE triggeredAt > read cursor); no cursor row = all unread. Single server-side truth → multi-device consistent badge (mobile refetches on focus, no polling).',
  })
  @ApiResponse({ status: 200, description: 'Unread count', type: UnreadCountResponse })
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
  async unreadCount(@Req() req: { user: AuthenticatedUser }): Promise<UnreadCountResponse> {
    return this.getUnreadCount.execute(req.user.accountId);
  }

  @Post('messages/mark-read')
  @HttpCode(200)
  @SkipThrottle(skipExcept(ALERT_WRITE_BUCKET))
  @Throttle({ 'alert-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Mark all messages read (EP8)',
    description:
      'Screen-level semantics (entering the messages tab): upserts the account read cursor to now — idempotent, always returns {unread: 0}.',
  })
  @ApiResponse({ status: 200, description: 'Watermark advanced', type: UnreadCountResponse })
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
  async markRead(@Req() req: { user: AuthenticatedUser }): Promise<UnreadCountResponse> {
    return this.markMessagesRead.execute(req.user.accountId);
  }
}
