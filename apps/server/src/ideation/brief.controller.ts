import {
  Controller,
  Get,
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
import { GenerateBriefUseCase } from './generate-brief.usecase';
import { ExportBriefUseCase } from './export-brief.usecase';
import { ExportBriefResponse, GenerateBriefResponse } from './brief.response';

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

/** 启 own 桶, skip 其余 (沿 021 / session.controller 范式)。 */
function skipExcept(own: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...EXISTING_BUCKETS, ...IDEATION_ALL_BUCKETS };
  for (const key of Object.keys(own)) delete skip[key];
  return skip;
}

/** session id 路径段数字串 → BigInt; 非法折叠 404 (反枚举, 与 session.controller 同款)。 */
function parseSessionId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundException('SESSION_NOT_FOUND');
  }
  return BigInt(raw);
}

/**
 * POST /api/v1/ideation/sessions/{id}/brief         (生成/重生 brief, 产出相 forced emit)
 * GET  /api/v1/ideation/sessions/{id}/brief/export   (导出 brief markdown + handed-off)
 *
 * authed (JwtAuthGuard) + per-account 归属 (req.user.accountId)。他人/不存在/非 open → 404
 * 字节级一致 (反枚举, UC 层 scope)。生成走 write 桶 30/60s, 导出走 read 桶 120/60s。
 *
 * 生成 (POST): 产出相强制 emit → zod + 收敛门 (只查 T1 五段, SC-007 接地 stub 不阻塞) →
 * 齐 upsert brief (1:1 覆盖) + open→converged; 缺段不落 + 回 missing 信号。
 * 导出 (GET): 渲 markdown (T005) + converged→handed-off (conditional UPDATE)。
 */
@ApiTags('ideation')
@Controller('v1/ideation')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class BriefController {
  constructor(
    private readonly generateBrief: GenerateBriefUseCase,
    private readonly exportBrief: ExportBriefUseCase,
  ) {}

  @Post('sessions/:id/brief')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_WRITE_BUCKET))
  @Throttle({ 'ideation-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Generate / regenerate the requirements brief (FR-005, produce phase forced emit)',
    description:
      'Runs the produce phase (forced emit_requirements_brief) on the converged conversation, ' +
      'validates the T1 five segments (convergence gate; T2 grounding stub does NOT block, ' +
      'SC-007). When converged → upserts requirements_draft (1:1 overwrite, no v1/v2 history) and ' +
      'transitions the session open→converged. When incomplete → does NOT persist a brief and ' +
      'returns the missing T1 segments so the client can keep asking. Other-account/unknown/' +
      'non-open session id → 404 (anti-enumeration).',
  })
  @ApiResponse({
    status: 200,
    description: 'Generated (converged) or incomplete',
    type: GenerateBriefResponse,
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
  async generate(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
  ): Promise<GenerateBriefResponse> {
    const outcome = await this.generateBrief.execute(req.user.accountId, parseSessionId(id));
    if (outcome.kind === 'converged') {
      return { converged: true, briefJson: outcome.briefJson, missing: [] };
    }
    return { converged: false, briefJson: null, missing: [...outcome.missing] };
  }

  @Get('sessions/:id/brief/export')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_READ_BUCKET))
  @Throttle({ 'ideation-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Export the brief as markdown and hand off (FR-006, D4 export view)',
    description:
      'Renders the converged brief JSON to markdown (paste into /speckit-specify) and transitions ' +
      'the session converged→handed-off (conditional UPDATE; already-handed-off is an idempotent ' +
      'no-op). No brief yet / other-account / unknown id → 404 (anti-enumeration).',
  })
  @ApiResponse({
    status: 200,
    description: 'Brief markdown + handed-off status',
    type: ExportBriefResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'SESSION_NOT_FOUND — unknown / other account / no brief',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async export(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
  ): Promise<ExportBriefResponse> {
    return this.exportBrief.execute(req.user.accountId, parseSessionId(id));
  }
}
