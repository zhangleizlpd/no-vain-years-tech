import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../account/jwt-auth.guard';
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
import { TranscribeAsrUseCase } from './asr-transcribe.usecase';
import { AsrTranscribeRequest } from './asr-transcribe.request';
import { AsrTranscribeResponse } from './asr-transcribe.response';

/** 既有桶 (001-031) —— @SkipThrottle 集 (与 session/brief.controller 同款, 防共享桶污染)。 */
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

/**
 * POST /api/v1/ideation/asr/transcribe (035, FR-001 / FR-007 / FR-008 / US1 / US3) —— 一次性
 * 语音转写: 整段录音 base64 → transcript 文本。普通 JSON 端点 (非 SSE / 非 raw WS),
 * `JwtAuthGuard` 标准 Guard 链。
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举)。转写不归属任何会话表 (音频
 * 瞬态、不落库 FR-012; transcript 由 client 经既有 turns 端点落库), 故无 accountId scope / 无
 * sessionId 路径段。限流 per-account 复用 ideation-write 桶 (30/60s, ASR 是 vendor I/O 重操作)。
 *
 * 该路由 body 走 base64 音频 (~14MB), Fastify per-route bodyLimit 在 main.ts onRoute 抬高 (其余
 * 端点 1MB 默认); DTO `@MaxLength` 是真正的 413/400 闸。降级分流见 TranscribeAsrUseCase。
 */
@ApiTags('ideation')
@Controller('v1/ideation/asr')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class AsrTranscribeController {
  constructor(private readonly transcribe: TranscribeAsrUseCase) {}

  @Post('transcribe')
  @HttpCode(200)
  @SkipThrottle(skipExcept(IDEATION_WRITE_BUCKET))
  @Throttle({ 'ideation-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Transcribe a one-shot voice recording (FR-001)',
    description:
      'Accepts an entire recording as base64 (≤~14MB) + its container mimeType, forwards the ' +
      'transient bytes to the ASR vendor (never persisted — FR-012), and returns the transcript. ' +
      'Empty text = silence / nothing recognized (200, not an error — FR-008). Transcribe failure ' +
      '(timeout / non-2xx / vendor) → 503 ASR_TRANSCRIBE_FAILED (session unaffected — FR-007/009).',
  })
  @ApiResponse({
    status: 200,
    description: 'Transcript (text may be empty)',
    type: AsrTranscribeResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'FORM_VALIDATION — bad mimeType / empty / oversize audioBase64',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 413,
    description: 'Payload too large (> route bodyLimit)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  @ApiResponse({
    status: 503,
    description: 'ASR_TRANSCRIBE_FAILED — transcription failed (retryable; session unaffected)',
    type: ProblemDetailResponse,
  })
  async transcribeAudio(@Body() body: AsrTranscribeRequest): Promise<AsrTranscribeResponse> {
    return { text: await this.transcribe.execute(body.audioBase64, body.mimeType) };
  }
}
