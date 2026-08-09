import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
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
import { IssueIdeaAttachmentCredentialUseCase } from './attachment-credential.usecase';
import { AttachmentCredentialRequest } from './attachment-credential.request';
import { AttachmentCredentialResponse } from './attachment-credential.response';

/** 既有桶 (001-031) —— @SkipThrottle 集 (与 session/asr.controller 同款, 防共享桶污染)。 */
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

/** session id 路径段数字串 → BigInt; 非法折叠 404 (与不存在不可区分, 反枚举 FR-013)。 */
function parseSessionId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundException('SESSION_NOT_FOUND');
  }
  return BigInt(raw);
}

/**
 * POST /api/v1/ideation/sessions/{id}/attachments/credential (036 T005, FR-007 /
 * FR-013 / US1 / US3) —— 为本会话内单次图片直传签发 scope 受限 OSS PostObject 凭证。
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举)。会话按 accountId 归属
 * (req.user.accountId); 他人/不存在 session → 404 字节级一致 (FR-013)。凭证签发失败 (OSS 未
 * 配置等) → ProblemDetail 降级, 不泄漏 vendor 细节 / 凭证内容 (FR-011)。普通 JSON 端点 (非 SSE),
 * 限流复用 ideation-write 桶 (vendor I/O 重操作)。
 */
@ApiTags('ideation')
@Controller('v1/ideation')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class AttachmentCredentialController {
  constructor(private readonly issueCredential: IssueIdeaAttachmentCredentialUseCase) {}

  @Post('sessions/:id/attachments/credential')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_WRITE_BUCKET))
  @Throttle({ 'ideation-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Issue a scope-restricted OSS PostObject upload credential for an image attachment',
    description:
      "Signs a V4 credential locked to this account's ideation key prefix (ideation/<accountId>/) " +
      '+ image content-type whitelist (JPEG/PNG/WebP) + size ceiling (≤10MB) + short TTL. The client ' +
      'POSTs the burned-in image bytes straight to OSS (backend never proxies bytes — ADR-0045 / SC-007). ' +
      'Other-account or unknown session id → 404 (anti-enumeration, byte-identical — FR-013). Credential ' +
      'issuance failure (OSS unconfigured / vendor) → ProblemDetail without leaking vendor details (FR-011).',
  })
  @ApiParam({ name: 'id', description: 'Session id (own-account; else 404)', example: '42' })
  @ApiResponse({
    status: 200,
    description: 'Scope-restricted PostObject credential',
    type: AttachmentCredentialResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'INVALID_CONTENT_TYPE — contentType not in JPEG/PNG/WebP whitelist',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'Other-account or unknown session (anti-enumeration, byte-identical — FR-013)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  @ApiResponse({
    status: 503,
    description: 'OSS_NOT_CONFIGURED — object storage not provisioned (no vendor detail — FR-011)',
    type: ProblemDetailResponse,
  })
  async issue(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
    @Body() body: AttachmentCredentialRequest,
  ): Promise<AttachmentCredentialResponse> {
    return this.issueCredential.execute(req.user.accountId, parseSessionId(id), body.contentType);
  }
}
