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
  Req,
  UseGuards,
} from '@nestjs/common';
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
  ALERT_ALL,
  PORTFOLIO_HOLDINGS_ALL,
  CHAT_ALL,
  IDEATION_READ_BUCKET,
  IDEATION_WRITE_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { CreateSessionUseCase } from './create-session.usecase';
import { ListSessionsUseCase } from './list-sessions.usecase';
import { GetSessionUseCase } from './get-session.usecase';
import { DeleteSessionUseCase } from './delete-session.usecase';
import { ReopenSessionUseCase } from './reopen-session.usecase';
import { SetSessionRepoUseCase } from './set-session-repo.usecase';
import { RepoCatalogUseCase } from './repo-catalog.usecase';
import { CreateSessionRequest } from './create-session.request';
import { SetSessionRepoRequest } from './set-session-repo.request';
import { RepoCatalogResponse, toRepoCatalogResponse } from './repo-catalog.response';
import {
  SessionDetailResponse,
  SessionListResponse,
  SessionResponse,
  toSessionDetailResponse,
  toSessionListResponse,
  toSessionResponse,
} from './session.response';

/** 既有桶 (001-031) —— ideation EP 各 @Throttle 己桶 + @SkipThrottle 其余防共享存储桶污染。 */
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
  ...CHAT_ALL,
  ...OPTIONSDESK_ALL,
};

const IDEATION_ALL_BUCKETS: Record<string, boolean> = {
  ...IDEATION_READ_BUCKET,
  ...IDEATION_WRITE_BUCKET,
};

/**
 * 某 ideation EP 的 @SkipThrottle 集 = 既有全部桶 + ideation 同组「除己」其余桶 (own 由
 * @Throttle 单独启用; @Throttle 不会反 un-skip, 故 own 不在 skip 集内, 沿 chat/021 范式)。
 */
function skipExcept(own: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...EXISTING_BUCKETS, ...IDEATION_ALL_BUCKETS };
  for (const key of Object.keys(own)) delete skip[key];
  return skip;
}

/** session id 路径段数字串 → BigInt; 非法折叠 404 (与不存在不可区分, 反枚举)。 */
function parseSessionId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundException('SESSION_NOT_FOUND');
  }
  return BigInt(raw);
}

/**
 * POST   /api/v1/ideation/sessions              (建 open 会话 + title; repo=null)
 * GET    /api/v1/ideation/sessions              (列本账号会话, updatedAt desc)
 * GET    /api/v1/ideation/sessions/{id}         (查会话详情, 含 turns + brief, scope)
 * DELETE /api/v1/ideation/sessions/{id}         (删会话连带 turn + brief, scope)
 * PATCH  /api/v1/ideation/sessions/{id}/reopen  (converged/handed-off → open 回流)
 * PATCH  /api/v1/ideation/sessions/{id}/repo    (选/切接地目标仓, 写 idea_session.repo)
 * GET    /api/v1/ideation/repos                 (可接地仓目录, 经 CODE_INDEX 端口透传)
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举)。会话按 accountId
 * 归属 (req.user.accountId, JwtAuthGuard 复用 account/ 平台 auth 基座, 非业务跨 ctx 依赖)。
 * 他人 / 不存在 sessionId → 404 字节级一致 (UC 层 scope, 反枚举, 与 chat/alert 同款, 非 403)。
 * 限流 per-account (AccountIdThrottlerGuard): read 120/60s · write 30/60s。澄清 SSE 流式
 * (T008) + 生成 brief (T009) 归后续 task。
 */
@ApiTags('ideation')
@Controller('v1/ideation')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class SessionController {
  constructor(
    private readonly createSession: CreateSessionUseCase,
    private readonly listSessions: ListSessionsUseCase,
    private readonly getSession: GetSessionUseCase,
    private readonly deleteSession: DeleteSessionUseCase,
    private readonly reopenSession: ReopenSessionUseCase,
    private readonly setSessionRepo: SetSessionRepoUseCase,
    private readonly repoCatalog: RepoCatalogUseCase,
  ) {}

  @Post('sessions')
  @HttpCode(201)
  @SkipThrottle(skipExcept(IDEATION_WRITE_BUCKET))
  @Throttle({ 'ideation-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create an ideation session (FR-001)',
    description:
      'Creates an open ideation session owned by the authed account with the given title. ' +
      'repo (grounding seam) is not exposed this phase → always null. Empty/whitespace title → 400.',
  })
  @ApiResponse({ status: 201, description: 'Created session', type: SessionResponse })
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
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  async create(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: CreateSessionRequest,
  ): Promise<SessionResponse> {
    return toSessionResponse(await this.createSession.execute(req.user.accountId, body.title));
  }

  @Get('sessions')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_READ_BUCKET))
  @Throttle({ 'ideation-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'List ideation sessions (FR-002 / US2)',
    description:
      'Returns the authed account sessions ordered by (updatedAt desc, id desc). ' +
      'Only own-account sessions (UC-level accountId scope). Empty → [].',
  })
  @ApiResponse({ status: 200, description: 'Session list', type: SessionListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async list(@Req() req: { user: AuthenticatedUser }): Promise<SessionListResponse> {
    return toSessionListResponse(await this.listSessions.execute(req.user.accountId));
  }

  @Get('sessions/:id')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_READ_BUCKET))
  @Throttle({ 'ideation-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Get an ideation session with turns + brief (FR-008)',
    description:
      'Returns the session with its turns (insertion order) and brief (1:1, may be null). ' +
      'Other-account or unknown id → 404 (anti-enumeration, UC-level accountId scope).',
  })
  @ApiResponse({ status: 200, description: 'Session detail', type: SessionDetailResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'SESSION_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async get(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
  ): Promise<SessionDetailResponse> {
    return toSessionDetailResponse(
      await this.getSession.execute(req.user.accountId, parseSessionId(id)),
    );
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @SkipThrottle(skipExcept(IDEATION_WRITE_BUCKET))
  @Throttle({ 'ideation-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Delete an ideation session and its turns + brief (FR-009)',
    description:
      'Deletes the session and all its turns + brief in a single transaction (no FK cascade — ' +
      'manual cascade). Other-account or unknown id → 404 (anti-enumeration, UC-level accountId scope). 204 on success.',
  })
  @ApiResponse({ status: 204, description: 'Deleted (no content)' })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'SESSION_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  async remove(@Req() req: { user: AuthenticatedUser }, @Param('id') id: string): Promise<void> {
    await this.deleteSession.execute(req.user.accountId, parseSessionId(id));
  }

  @Patch('sessions/:id/reopen')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_WRITE_BUCKET))
  @Throttle({ 'ideation-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Reopen a converged / handed-off session (FR-012)',
    description:
      'Transitions a converged / handed-off session back to open (conditional UPDATE affected-count). ' +
      'Already-open session is an idempotent no-op (returns open). Other-account or unknown id → 404 ' +
      '(anti-enumeration, byte-identical with get/delete, UC-level accountId scope).',
  })
  @ApiResponse({ status: 200, description: 'Reopened (or idempotent open)', type: SessionResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'SESSION_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  async reopen(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
  ): Promise<SessionResponse> {
    return toSessionResponse(
      await this.reopenSession.execute(req.user.accountId, parseSessionId(id)),
    );
  }

  @Patch('sessions/:id/repo')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_WRITE_BUCKET))
  @Throttle({ 'ideation-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Select / switch the grounding target repo for a session (FR-005 / FR-006)',
    description:
      'Writes idea_session.repo (conditional UPDATE where {id, accountId, status:open} affected-count) ' +
      'to lock the retrieval namespace for subsequent turns. Switching only affects later turns — existing ' +
      'turn references are not rewritten. Non-open / other-account / unknown id → 404 (anti-enumeration, ' +
      'byte-identical with get/delete/reopen, UC-level accountId scope). Empty/whitespace repo → 400.',
  })
  @ApiResponse({ status: 200, description: 'Repo selected (session head)', type: SessionResponse })
  @ApiResponse({
    status: 400,
    description: 'REPO_REQUIRED — repo empty / whitespace-only after trim',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'SESSION_NOT_FOUND — unknown / other account / not open',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  async setRepo(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
    @Body() body: SetSessionRepoRequest,
  ): Promise<SessionResponse> {
    return toSessionResponse(
      await this.setSessionRepo.execute(req.user.accountId, parseSessionId(id), body.repo),
    );
  }

  @Get('repos')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_READ_BUCKET))
  @Throttle({ 'ideation-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'List groundable repos from the code-index catalog (FR-004 / FR-010)',
    description:
      'Returns the catalog of indexable repos (repo / lastSha / indexedAt / chunkCount / status) ' +
      'via the CODE_INDEX port. Empty catalog → items: []. Code-index unreachable (down / timeout / ' +
      'network / auth) → 503 CODE_INDEX_UNAVAILABLE (retryable; internal error details not leaked).',
  })
  @ApiResponse({ status: 200, description: 'Repo catalog', type: RepoCatalogResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'CODE_INDEX_UNAVAILABLE — code-index unreachable (retryable)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async repos(): Promise<RepoCatalogResponse> {
    return toRepoCatalogResponse(await this.repoCatalog.execute());
  }
}
