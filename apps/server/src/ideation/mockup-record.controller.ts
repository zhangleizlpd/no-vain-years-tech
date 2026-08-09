import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WorkerAuthGuard } from '../security/worker-auth.guard.js';
import { ProblemDetailResponse } from '../security/problem-detail.response.js';
import { RecordMockupUseCase } from './mockup-record.usecase.js';
import { MockupRecordRequest } from './mockup-record.request.js';

/**
 * POST /api/v1/ideation/mockups (037 T006, US1 / FR-001 / FR-010) —— channel 直传 mockup HTML
 * 成功后回报落 mockup 交付记录 (append-only 关联 session)。
 *
 * **worker-token 端点** (WorkerAuthGuard: Bearer AGENT_WORKER_TOKEN, 零用户 principal)。归属
 * scope (accountId, sessionId) **永远**由 server 据所认领的 claimed event (eventId) 派生,
 * channel **不得自报** (FR-002)。`objectKey` 必须落在派生 scope 前缀内, 否则 403 (防谎报他
 * session)。事件派生失败 → 404 字节级一致不泄漏 (反枚举)。普通 JSON 端点。
 */
@ApiTags('ideation')
@ApiBearerAuth('worker-token')
@UseGuards(WorkerAuthGuard)
@Controller('v1/ideation')
export class MockupRecordController {
  constructor(private readonly recordMockup: RecordMockupUseCase) {}

  @Post('mockups')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Record a delivered mockup for the claimed session (append-only)',
    description:
      'Inserts a mockup delivery record associated with the claimed session (append-only — multi ' +
      'version = multi row, never overwrites). The (accountId, sessionId) scope is derived server-side ' +
      'from the claimed event (eventId) — the channel must NOT self-report it (FR-002). The objectKey ' +
      'MUST fall under the derived ideation-mockup/{accountId}/{sessionId}/ prefix, else 403 ' +
      '(prevents claiming another session). Unknown / non-claimed / wrong-bizType event → 404 ' +
      '(anti-enumeration, no leak). screens = per-screen labels (normalized server-side, FR-010).',
  })
  @ApiResponse({ status: 201, description: 'Mockup delivery record created (append-only)' })
  @ApiResponse({
    status: 401,
    description: 'Missing / invalid worker token (WorkerAuthGuard, byte-identical)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'OBJECT_KEY_OUT_OF_SCOPE — objectKey outside the derived session prefix',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown / non-claimed / wrong-bizType event (anti-enumeration — FR-002)',
    type: ProblemDetailResponse,
  })
  async record(@Body() body: MockupRecordRequest): Promise<void> {
    await this.recordMockup.execute({
      eventId: body.eventId,
      objectKey: body.objectKey,
      screens: body.screens,
      note: body.note,
    });
  }
}
