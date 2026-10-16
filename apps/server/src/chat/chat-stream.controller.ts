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
import { openLazySseStream } from '../security/sse-stream';
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
import { SendMessageUseCase } from './send-message.usecase';
import { SendMessageRequest } from './send-message.request';
import {
  SSE_DONE,
  toSseDegradedFrame,
  toSseErrorFrame,
  toSseFrame,
  toSseSourcesFrame,
  toSseToolResultFrame,
  toSseToolStartFrame,
} from './sse.rules';

/** 既有桶 (001-025) —— @SkipThrottle 集 (与 conversation.controller 同款, 防共享桶污染)。 */
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

/** 启 own 桶, skip 其余 (沿 021 范式; conversation.controller 同款)。 */
function skipExcept(own: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...EXISTING_BUCKETS, ...CHAT_ALL_BUCKETS };
  for (const key of Object.keys(own)) delete skip[key];
  return skip;
}

/** conversation id 路径段数字串 → BigInt; 非法折叠 404 (反枚举, 与 conversation.controller 同款)。 */
function parseConversationId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundException('CONVERSATION_NOT_FOUND');
  }
  return BigInt(raw);
}

/**
 * POST /api/v1/chat/conversations/{id}/messages — SSE 流式发消息 (027 T007, plan D3)。
 *
 * 仓内**首个 SSE 流式端点**。Fastify 5 `reply.hijack()` + `reply.raw` 裸写
 * `text/event-stream` (PoC 定稿, 不用 Nest `@Sse()` RxJS 桥)。鉴权/归属/限流同
 * conversation.controller (JwtAuthGuard + AccountIdThrottlerGuard chat-write 桶 30/60s)。
 *
 * 帧协议 (sse.rules): token 帧 `data:{"token":"..."}\n\n` 逐个 drip → 结束 `data:[DONE]\n\n`;
 * 失败 → `data:{"error":"..."}\n\n` 让客户端展示错误态 + 重试 (AI msg 不落, FR-009)。
 * 停止: `reply.raw.on('close')` (客户端断连/主动停止) → AbortController.abort() 透传
 * UC → provider 止付上游 token → 落已生成半成品 AI msg status=stopped (FR-008)。
 *
 * **lazy hijack**: 仅在首个 token (或需写 error 帧) 时 hijack + writeHead, 故 UC 的
 * 前置校验异常 (scope 404 / 空输入 400) 在 hijack **之前**抛出 → 走 Nest ProblemDetailFilter
 * 正常 JSON 响应 (与 GET 端点 404/400 字节级一致, 反枚举); 流一旦开始则永远 SSE。
 */
@ApiTags('chat')
@Controller('v1/chat')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class ChatStreamController {
  constructor(private readonly sendMessage: SendMessageUseCase) {}

  @Post('conversations/:id/messages')
  @SkipThrottle(skipExcept(CHAT_WRITE_BUCKET))
  @Throttle({ 'chat-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '会话 id (数字串)', example: '101' })
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Send a message and stream the AI reply over SSE (FR-003, plan D3)',
    description:
      'Lands the user message immediately, then streams the assistant reply token-by-token as ' +
      'Server-Sent Events. Frames: `data:{"token":"..."}\\n\\n` per token, terminated by ' +
      '`data:[DONE]\\n\\n`. On provider failure → `data:{"error":"..."}\\n\\n` and the AI message ' +
      'is NOT persisted (FR-009; user message already persisted). On client disconnect/stop the ' +
      'upstream is aborted and the partial AI message is persisted with status=stopped (FR-008). ' +
      'Other-account/unknown conversation id → 404 (anti-enumeration); empty content → 400.',
  })
  @ApiResponse({ status: 200, description: 'SSE token stream (text/event-stream)' })
  @ApiResponse({
    status: 400,
    description: 'Empty content',
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
  async send(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
    @Body() body: SendMessageRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const conversationId = parseConversationId(id);

    // lazy hijack + 断连 abort + SSE/CORS headers 由 openLazySseStream 收口 (security/sse-stream):
    // 首个 token (或写 error 帧) 时才 hijack, 让前置校验异常 (404/400) 走 Nest 过滤器正常 JSON 响应。
    const stream = openLazySseStream(reply);

    let outcome;
    try {
      outcome = await this.sendMessage.execute(
        {
          accountId: req.user.accountId,
          conversationId,
          content: body.content,
          signal: stream.signal,
        },
        (token) => {
          stream.write(toSseFrame(token));
        },
        // 030 联网工具/来源/降级帧 (D5) — 各回调经 stream.write 写 SSE 帧 (首帧时 lazy hijack)。
        {
          onToolStart: (query) => {
            stream.write(toSseToolStartFrame({ query }));
          },
          onToolResult: (count, sources) => {
            stream.write(toSseToolResultFrame({ count, sources }));
          },
          onDegraded: () => {
            stream.write(toSseDegradedFrame());
          },
          onSources: (sources) => {
            stream.write(toSseSourcesFrame(sources));
          },
        },
      );
    } catch (err) {
      // 前置校验 (scope 404 / 空输入 400) 在首 token 前抛 → 未 hijack → 交回 Nest 过滤器。
      if (!stream.started) throw err;
      // 已 hijack 后的意外异常 → 兜底 error 帧 + 收尾 (避免裸悬挂连接)。
      const message = err instanceof Error ? err.message : 'CHAT_STREAM_ERROR';
      stream.end(toSseErrorFrame(message));
      return;
    }

    // provider 失败但无 token 流出 (errorAfter=0): end() 同样先 hijack 才回错误帧给客户端。
    stream.end(outcome.kind === 'error' ? toSseErrorFrame(outcome.message) : SSE_DONE);
  }
}
