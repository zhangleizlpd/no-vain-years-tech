import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { WorkerAuthGuard } from '../security/worker-auth.guard.js';
import { ClaimNextEventUseCase } from './claim-next-event.usecase.js';
import { ExtendLeaseUseCase } from './extend-lease.usecase.js';
import { CompleteEventUseCase } from './complete-event.usecase.js';
import { AckResponse, AgentEventResponse, toAgentEventResponse } from './agent-event.response.js';
import { PostResultRequest } from './post-result.request.js';

/**
 * 通用事件队列 worker-facing API (P1.4)。远程常驻 agent (OpenClaw worker) 出站轮询拉取 +
 * 回传。**通道层** 鉴权 = WorkerAuthGuard (Bearer AGENT_WORKER_TOKEN), 零用户 principal;
 * **拉取层** 鉴权 (能不能拿某 bizId 数据) 由 poll 返回的委托 token 另管, 与本控制器正交。
 *
 * 端点 (mirror SQS visibility-timeout 队列, 职责不重叠):
 *   POST /poll        原子 claim 最老 claimable + 设租约 + 签委托 token (pending→claimed)
 *   POST /{id}/ack    心跳续租 (长任务防租约到期被误重发; 仍 claimed)
 *   POST /{id}/result 终态回传 (claimed→done/failed + 存产物)
 *
 * poll 有副作用 (claim) → POST (非 GET, per api-contract.md GET=无副作用)。
 */
@ApiTags('agent-queue')
@ApiBearerAuth('worker-token')
@UseGuards(WorkerAuthGuard)
@Controller('v1/agent-queue')
export class AgentQueueController {
  constructor(
    private readonly claimNext: ClaimNextEventUseCase,
    private readonly extendLease: ExtendLeaseUseCase,
    private readonly completeEvent: CompleteEventUseCase,
  ) {}

  @Post('poll')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Worker 出站轮询: 原子 claim 最老 claimable 事件 + 设租约 + 签委托 token',
  })
  @ApiOkResponse({ type: AgentEventResponse })
  @ApiNoContentResponse({ description: '无 claimable 事件' })
  async poll(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AgentEventResponse | undefined> {
    const event = await this.claimNext.execute();
    if (!event) {
      reply.status(204);
      return undefined;
    }
    return toAgentEventResponse(event);
  }

  @Post(':id/ack')
  @HttpCode(200)
  @ApiOperation({ summary: 'Worker 心跳续租 (长任务防租约到期被误重发)' })
  @ApiOkResponse({ type: AckResponse })
  async ack(@Param('id', ParseUUIDPipe) id: string): Promise<AckResponse> {
    const lease = await this.extendLease.execute(id);
    if (!lease) throw new NotFoundException();
    return { leaseExpiresAt: lease.toISOString() };
  }

  @Post(':id/result')
  @HttpCode(204)
  @ApiOperation({ summary: 'Worker 回传终态 (SUCCESS/FAILURE + 产物) → done/failed' })
  @ApiNoContentResponse({ description: '终态已记录' })
  async result(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PostResultRequest,
  ): Promise<void> {
    const ok = await this.completeEvent.execute(id, body.outcome, body.result);
    if (!ok) throw new NotFoundException();
  }
}
