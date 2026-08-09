import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
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
import { ListSessionMockupsUseCase } from './mockup-list.usecase';
import { SessionMockupListResponse, toSessionMockupListResponse } from './mockup-list.response';

/** 既有桶 (001-031) —— @SkipThrottle 集 (与 session.controller 同款, 防共享桶污染)。 */
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

/** 启 own 桶, skip 其余 (沿 session.controller 范式)。 */
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
 * GET /api/v1/ideation/sessions/{id}/mockups (037 T007, US1 / US2 / FR-006 / FR-007) ——
 * app 用户列某 session 已交付的 mockup (含版本 / 交付时间标识, 默认渲最新版)。
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举)。usecase 先校验 session
 * 归属-存在 (镜像 get-session.usecase): 他人 / 不存在 numeric session → `NotFoundException`
 * 经全局 ProblemDetail filter 转 404 字节级一致 (反枚举, 沿 036 FR-013, 与 ideation 既有读端点
 * 统一)。id 非数字 → 404 (parseSessionId, 与不存在不可区分)。普通 JSON 读端点, 限流复用
 * ideation-read 桶。fetch-on-open 无实时刷新 (FR-011, 客户端语义)。
 */
@ApiTags('ideation')
@Controller('v1/ideation')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class MockupListController {
  constructor(private readonly listMockups: ListSessionMockupsUseCase) {}

  @Get('sessions/:id/mockups')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_READ_BUCKET))
  @Throttle({ 'ideation-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: 'Session id (own-account; else 404)', example: '101' })
  @ApiOperation({
    summary: 'List delivered mockups for a session (FR-006 / FR-007)',
    description:
      'Returns the session mockups ordered by createdAt desc (latest first), each with objectKey, ' +
      'a configured display-domain mockupUrl (null when OSS unconfigured → App degrades rendering), ' +
      'per-screen labels, createdAt, and a derived versionRank (latest = 1, append-only, not stored). ' +
      "Scoped to the authed account's session (ownership-existence checked first, mirroring get-session). " +
      'Other-account / unknown session → 404 (anti-enumeration — byte-identical, FR-007 along 036 FR-013); ' +
      'non-numeric id → 404 (byte-identical with unknown).',
  })
  @ApiResponse({ status: 200, description: 'Session mockup list', type: SessionMockupListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      'SESSION_NOT_FOUND — unknown / other account / non-numeric id (anti-enumeration, byte-identical)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async list(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
  ): Promise<SessionMockupListResponse> {
    return toSessionMockupListResponse(
      await this.listMockups.execute(req.user.accountId, parseSessionId(id)),
    );
  }
}
