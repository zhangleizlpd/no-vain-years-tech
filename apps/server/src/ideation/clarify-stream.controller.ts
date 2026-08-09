import {
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiProduces,
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
  CHAT_ALL,
  IDEATION_READ_BUCKET,
  IDEATION_WRITE_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { ClarifyTurnUseCase } from './clarify-turn.usecase';
import { ClarifyTurnRequest } from './clarify-turn.request';
import {
  IDEATION_SSE_DONE,
  toSseErrorFrame,
  toSseNoticeFrame,
  toSseSourcesFrame,
  toSseSuggestionFrame,
  toSseTokenFrame,
  toSseToolStartFrame,
  GROUNDING_DEGRADED_NOTICE,
} from './ideation-sse.rules';

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

/**
 * 从 Fastify reply 已有 header 里挑出 `@fastify/cors` 写的跨域 header (`access-control-*` + `vary`)。
 * SSE 走 reply.hijack() 裸写, 必须手动带 (否则 web build 流式响应缺 `Access-Control-Allow-Origin`
 * 被浏览器拦)。allowlist 判定仍由 plugin 负责, 不在此重复策略 (server-sse-hijack-cors rule)。
 */
function pickCorsHeaders(
  headers: Record<string, number | string | string[] | undefined>,
): Record<string, number | string | string[]> {
  const picked: Record<string, number | string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith('access-control-') || lower === 'vary') picked[key] = value;
  }
  return picked;
}

/** session id 路径段数字串 → BigInt; 非法折叠 404 (反枚举, 与 session.controller 同款)。 */
function parseSessionId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundException('SESSION_NOT_FOUND');
  }
  return BigInt(raw);
}

/**
 * POST /api/v1/ideation/sessions/{id}/turns — SSE 流式澄清轮 (032 T008, 契约 doc §3/§4)。
 *
 * 仓内**第二个 SSE 流式端点** (chat-stream.controller 是首个; ADR-0055 范式复用, 不 import
 * chat 代码)。Fastify 5 `reply.hijack()` + `reply.raw` 裸写 `text/event-stream`。鉴权/归属/
 * 限流同 session.controller (JwtAuthGuard + AccountIdThrottlerGuard, ideation-write 桶 30/60s)。
 *
 * 帧协议 (ideation-sse.rules, 契约 doc §4.7 流式分离): question 文本帧
 * `data:{"token":"..."}\n\n` 逐帧 drip → 过两闸 chips 一帧 `data:{"suggestion":{...}}\n\n`
 * (收口整出) → 结束 `data:[DONE]\n\n`。provider 失败 → `data:{"error":"..."}\n\n` (assistant
 * turn 不落, FR-010)。停止: `reply.raw.on('close')` → AbortController.abort() 透传 UC →
 * provider 止付 → 保留半成品 assistant turn (FR-008 语义)。
 *
 * **lazy hijack**: 仅在首帧 (或写 error 帧) 时 hijack + writeHead, 故 UC 前置校验异常
 * (scope 404 / 空输入 400) 在 hijack 之前抛出 → 走 Nest ProblemDetailFilter 正常 JSON 响应
 * (与 GET 端点字节级一致, 反枚举); 流一旦开始则永远 SSE。
 */
@ApiTags('ideation')
@Controller('v1/ideation')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class ClarifyStreamController {
  constructor(private readonly clarifyTurn: ClarifyTurnUseCase) {}

  @Post('sessions/:id/turns')
  @SkipThrottle(skipExcept(IDEATION_WRITE_BUCKET))
  @Throttle({ 'ideation-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Submit a clarification turn and stream the assistant question over SSE (FR-003/004)',
    description:
      'Lands the user turn immediately, then runs the per-turn two-step micro-loop (grounding ' +
      'auto → ask required) and streams the clarifying question token-by-token. Frames: ' +
      '`data:{"token":"..."}\\n\\n` per char of the question, then optionally one ' +
      '`data:{"suggestion":{...}}\\n\\n` (chips, whole — only when both gates pass and not the ' +
      'first question), terminated by `data:[DONE]\\n\\n`. On provider failure → ' +
      '`data:{"error":"..."}\\n\\n` and the assistant turn is NOT persisted (FR-010; user turn ' +
      'already persisted). On client disconnect/stop the upstream is aborted and the partial ' +
      'assistant turn is persisted (FR-008). Other-account/unknown/non-open session id → 404 ' +
      '(anti-enumeration); empty content → 400.',
  })
  @ApiResponse({ status: 200, description: 'SSE clarification stream (text/event-stream)' })
  @ApiResponse({ status: 400, description: 'Empty content', type: ProblemDetailResponse })
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
  @ApiResponse({
    status: 429,
    description: 'Rate limit (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async turn(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
    @Body() body: ClarifyTurnRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const sessionId = parseSessionId(id);

    // 客户端断连 / 主动停止 → abort 上游。reply.raw 'close' 在 end() 后也会触发, 用 finished
    // 哨兵区分: 正常结束 (end 已调) 不视作 stop。
    const controller = new AbortController();
    let finished = false;
    reply.raw.on('close', () => {
      if (!finished) controller.abort();
    });

    // lazy hijack: 首帧 (或写 error 帧) 时才 hijack + 写 SSE headers, 让前置校验异常
    // (404/400) 在 hijack 前抛出 → Nest 过滤器正常 JSON 响应。
    let hijacked = false;
    const ensureHijacked = () => {
      if (hijacked) return;
      hijacked = true;
      const corsHeaders = pickCorsHeaders(reply.getHeaders());
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeaders,
      });
    };

    let outcome;
    try {
      outcome = await this.clarifyTurn.execute(
        {
          accountId: req.user.accountId,
          sessionId,
          content: body.content,
          attachmentKeys: body.attachmentKeys,
          annotationText: body.annotationText,
          signal: controller.signal,
        },
        {
          onToken: (token) => {
            ensureHijacked();
            reply.raw.write(toSseTokenFrame(token));
          },
          onSuggestion: (suggestion) => {
            ensureHijacked();
            reply.raw.write(toSseSuggestionFrame(suggestion));
          },
          // 接地检索发起指示 (034 FR-013): 「正在检索代码…」。
          onToolStart: () => {
            ensureHijacked();
            reply.raw.write(toSseToolStartFrame());
          },
          // 接地命中来源回流 (034 FR-002, ≤5; UC 仅在有命中时调, 0 命中/降级不调)。
          onSources: (sources) => {
            ensureHijacked();
            reply.raw.write(toSseSourcesFrame(sources));
          },
          // 接地降级系统气泡 (034 FR-008): 端口不可达 → grounding_degraded; 不阻断整轮。
          onNotice: () => {
            ensureHijacked();
            reply.raw.write(toSseNoticeFrame(GROUNDING_DEGRADED_NOTICE));
          },
        },
      );
    } catch (err) {
      // 前置校验 (scope 404 / 空输入 400) 在首帧前抛 → 未 hijack → 交回 Nest 过滤器。
      if (!hijacked) throw err;
      // 已 hijack 后的意外异常 → 兜底 error 帧 + 收尾 (避免裸悬挂连接)。
      const message = err instanceof Error ? err.message : 'IDEATION_CLARIFY_STREAM_ERROR';
      reply.raw.write(toSseErrorFrame(message));
      finished = true;
      reply.raw.end();
      return;
    }

    // provider 失败但无帧流出 (errorAfter=0): 仍需 hijack 才能回错误帧给客户端。
    if (outcome.kind === 'error') ensureHijacked();

    finished = true;
    if (outcome.kind === 'error') {
      reply.raw.write(toSseErrorFrame(outcome.message));
    } else {
      reply.raw.write(IDEATION_SSE_DONE);
    }
    reply.raw.end();
  }
}
