import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
  IDEATION_ALL,
  CHAT_READ_BUCKET,
  CHAT_WRITE_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { CreateConversationUseCase } from './create-conversation.usecase';
import { ListModelsUseCase } from './list-models.usecase';
import { GetMessagesUseCase } from './get-messages.usecase';
import { ListConversationsUseCase } from './list-conversations.usecase';
import { RenameConversationUseCase } from './rename-conversation.usecase';
import { SetConversationModelUseCase } from './set-conversation-model.usecase';
import { DeleteConversationUseCase } from './delete-conversation.usecase';
import { CreateConversationRequest } from './create-conversation.request';
import { ListConversationsRequest } from './list-conversations.request';
import { RenameConversationRequest } from './rename-conversation.request';
import { SetConversationModelRequest } from './set-conversation-model.request';
import {
  ChatMessageListResponse,
  ConversationListResponse,
  ConversationModelResponse,
  ConversationResponse,
  ModelListResponse,
  RenamedConversationResponse,
  toConversationListResponse,
  toConversationModelResponse,
  toConversationResponse,
  toMessageListResponse,
  toRenamedConversationResponse,
} from './chat.response';

/** 既有桶 (001-025) —— chat EP 各 @Throttle 己桶 + @SkipThrottle 其余防共享存储桶污染。 */
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
  ...ALERT_ALL,
  ...PORTFOLIO_HOLDINGS_ALL,
  ...IDEATION_ALL,
  ...OPTIONSDESK_ALL,
};

const CHAT_ALL_BUCKETS: Record<string, boolean> = { ...CHAT_READ_BUCKET, ...CHAT_WRITE_BUCKET };

/**
 * 某 chat EP 的 @SkipThrottle 集 = 既有全部桶 + chat 同组「除己」其余桶 (own 由
 * @Throttle 单独启用; @Throttle 不会反 un-skip, 故 own 不在 skip 集内, 沿 021 范式)。
 */
function skipExcept(own: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...EXISTING_BUCKETS, ...CHAT_ALL_BUCKETS };
  for (const key of Object.keys(own)) delete skip[key];
  return skip;
}

/** conversation id 路径段数字串 → BigInt; 非法折叠 404 (与不存在不可区分, 反枚举)。 */
function parseConversationId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundException('CONVERSATION_NOT_FOUND');
  }
  return BigInt(raw);
}

/**
 * POST /api/v1/chat/conversations              (建空会话, model 默认 flash, 029 D7)
 * GET  /api/v1/chat/conversations/{id}/messages (取会话消息, 按插入序, scope accountId)
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举)。会话/消息按
 * accountId 归属 (req.user.accountId, JwtAuthGuard 复用 account/ 平台 auth 基座, 非
 * 业务跨 ctx 依赖)。他人 / 不存在 conversationId → 404 字节级一致 (UC 层 scope, 反枚举,
 * 与 alert/portfolio 同款, 非 403)。限流 per-account (AccountIdThrottlerGuard):
 * read 120/60s · write 30/60s。SSE 流式发消息端点 (POST .../messages) 归 T007。
 */
@ApiTags('chat')
@Controller('v1/chat')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class ConversationController {
  constructor(
    private readonly createConversation: CreateConversationUseCase,
    private readonly listModels: ListModelsUseCase,
    private readonly getMessages: GetMessagesUseCase,
    private readonly listConversations: ListConversationsUseCase,
    private readonly renameConversation: RenameConversationUseCase,
    private readonly setConversationModel: SetConversationModelUseCase,
    private readonly deleteConversation: DeleteConversationUseCase,
  ) {}

  @Get('models')
  @HttpCode(200)
  @SkipThrottle(skipExcept(CHAT_READ_BUCKET))
  @Throttle({ 'chat-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'List available chat models (029 model switcher metadata, D2)',
    description:
      'Returns the constant-derived model catalog (NOT user-private; no accountId scope) driving the top-bar model switcher: DeepSeek flash/pro available + MiniMax placeholder (available:false). Authenticated (JwtAuthGuard). Client falls back to a built-in default list if this endpoint is unavailable (FR-012).',
  })
  @ApiResponse({ status: 200, description: 'Model catalog', type: ModelListResponse })
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
  listAvailableModels(): ModelListResponse {
    return this.listModels.execute();
  }

  @Get('conversations')
  @HttpCode(200)
  @SkipThrottle(skipExcept(CHAT_READ_BUCKET))
  @Throttle({ 'chat-read-account': { limit: 120, ttl: 60_000 } })
  @ApiQuery({ name: 'limit', required: false, description: '页大小 (默认 20, 1..50)', example: 20 })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: '上一页末游标 (base64 {updatedAt,id}); 留空取首页',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: '标题关键词 (ILIKE 大小写不敏感子串; 留空返完整列表)',
  })
  @ApiOperation({
    summary: 'List conversations (history drawer, paginated + title search)',
    description:
      'Returns the authed account conversations ordered by (updatedAt desc, id desc), cursor-paginated. Optional `q` does a case-insensitive title substring match (ILIKE; does NOT search message bodies). Empty / no-match → []. Only own-account conversations (UC-level accountId scope).',
  })
  @ApiResponse({ status: 200, description: 'Conversation list', type: ConversationListResponse })
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
    @Query() query: ListConversationsRequest,
  ): Promise<ConversationListResponse> {
    return toConversationListResponse(
      await this.listConversations.execute(req.user.accountId, {
        limit: query.limit,
        cursor: query.cursor,
        q: query.q,
      }),
    );
  }

  @Post('conversations')
  @HttpCode(201)
  @SkipThrottle(skipExcept(CHAT_WRITE_BUCKET))
  @Throttle({ 'chat-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create an empty conversation (D6)',
    description:
      'Creates an empty conversation owned by the authed account. Model defaults to the logical default flash (029 D7; switchable per-conversation via PATCH .../model). Optional title; empty → 「新对话」(derived from first message later).',
  })
  @ApiResponse({ status: 201, description: 'Created conversation', type: ConversationResponse })
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
  async create(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: CreateConversationRequest,
  ): Promise<ConversationResponse> {
    return toConversationResponse(
      await this.createConversation.execute(req.user.accountId, body.title),
    );
  }

  @Get('conversations/:id/messages')
  @HttpCode(200)
  @SkipThrottle(skipExcept(CHAT_READ_BUCKET))
  @Throttle({ 'chat-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'List messages of a conversation (D6 / SC-002 reload)',
    description:
      'Returns the conversation messages in insertion order (id asc). Empty conversation → []. Other-account or unknown id → 404 (anti-enumeration, UC-level accountId scope).',
  })
  @ApiResponse({ status: 200, description: 'Message list', type: ChatMessageListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'CONVERSATION_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (120/60s per account)',
    type: ProblemDetailResponse,
  })
  async messages(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
  ): Promise<ChatMessageListResponse> {
    return toMessageListResponse(
      await this.getMessages.execute(req.user.accountId, parseConversationId(id)),
    );
  }

  @Patch('conversations/:id')
  @HttpCode(200)
  @SkipThrottle(skipExcept(CHAT_WRITE_BUCKET))
  @Throttle({ 'chat-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Rename a conversation (FR-006)',
    description:
      'Renames the conversation title. Other-account or unknown id → 404 (anti-enumeration, UC-level accountId scope, byte-identical with messages). Empty / whitespace-only title (after trim) → 400 (own-resource input validation, only reachable for owned conversations).',
  })
  @ApiResponse({ status: 200, description: 'Renamed', type: RenamedConversationResponse })
  @ApiResponse({
    status: 400,
    description: 'TITLE_REQUIRED — title empty / whitespace-only after trim',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'CONVERSATION_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async rename(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
    @Body() body: RenameConversationRequest,
  ): Promise<RenamedConversationResponse> {
    return toRenamedConversationResponse(
      await this.renameConversation.execute(
        req.user.accountId,
        parseConversationId(id),
        body.title,
      ),
    );
  }

  @Patch('conversations/:id/model')
  @HttpCode(200)
  @SkipThrottle(skipExcept(CHAT_WRITE_BUCKET))
  @Throttle({ 'chat-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Set the model of a conversation (029 session-level model memory, D3)',
    description:
      'Sets the conversation logical model (flash | pro | minimax), persisting session-level model memory (SC-003). Other-account or unknown id → 404 (anti-enumeration, UC-level accountId scope, byte-identical with rename/messages). Invalid / unavailable model → 400 (own-resource input validation, only reachable for owned conversations; ownership 404 precedes model 400). Refreshes updatedAt (conversation floats up, same as rename).',
  })
  @ApiResponse({ status: 200, description: 'Model set', type: ConversationModelResponse })
  @ApiResponse({
    status: 400,
    description: 'MODEL_NOT_AVAILABLE — model not in {flash, pro, minimax}',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'CONVERSATION_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async setModel(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
    @Body() body: SetConversationModelRequest,
  ): Promise<ConversationModelResponse> {
    return toConversationModelResponse(
      await this.setConversationModel.execute(
        req.user.accountId,
        parseConversationId(id),
        body.model,
      ),
    );
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  @SkipThrottle(skipExcept(CHAT_WRITE_BUCKET))
  @Throttle({ 'chat-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Delete a conversation and its messages (FR-007)',
    description:
      'Deletes the conversation and all its messages in a single transaction (no FK cascade — manual cascade, plan D3). Other-account or unknown id → 404 (anti-enumeration, UC-level accountId scope). Returns 204 No Content on success.',
  })
  @ApiResponse({ status: 204, description: 'Deleted (no content)' })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'CONVERSATION_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async remove(@Req() req: { user: AuthenticatedUser }, @Param('id') id: string): Promise<void> {
    await this.deleteConversation.execute(req.user.accountId, parseConversationId(id));
  }
}
