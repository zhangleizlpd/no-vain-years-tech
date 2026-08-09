import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WorkerAuthGuard } from '../security/worker-auth.guard.js';
import { ProblemDetailResponse } from '../security/problem-detail.response.js';
import { IssueMockupCredentialUseCase } from './mockup-credential.usecase.js';
import { MockupCredentialRequest } from './mockup-credential.request.js';
import { MockupCredentialResponse } from './mockup-credential.response.js';

/**
 * POST /api/v1/ideation/mockups/credential (037 T005, US1 / FR-002 / FR-003) —— 为 channel
 * 所认领的 ideation requirement 任务签发 scope 受限的 OSS PostObject 凭证 (mockup HTML 直传)。
 *
 * **worker-token 端点** (WorkerAuthGuard: Bearer AGENT_WORKER_TOKEN, 零用户 principal; 与
 * agent-queue worker API 同款鉴权)。归属 scope (accountId, sessionId) **永远**由 server 据
 * 所认领的 claimed event 派生, channel **不得自报** (防越权 + 混淆代理, FR-002)。事件派生失败
 * (不存在 / 非 claimed / bizType 不符) → 404 字节级一致, 不泄漏 (反枚举)。OSS 未配置 → 503
 * ProblemDetail, 不泄漏 vendor 细节 (FR-008)。普通 JSON 端点 (非 SSE)。
 */
@ApiTags('ideation')
@ApiBearerAuth('worker-token')
@UseGuards(WorkerAuthGuard)
@Controller('v1/ideation')
export class MockupCredentialController {
  constructor(private readonly issueCredential: IssueMockupCredentialUseCase) {}

  @Post('mockups/credential')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Issue a scope-restricted OSS PostObject credential for a mockup HTML upload',
    description:
      "Signs a V4 credential locked to the claimed session's mockup key prefix " +
      '(ideation-mockup/{accountId}/{sessionId}/) + text/html content-type + size ceiling + short TTL. ' +
      'The channel POSTs the single self-contained mockup HTML straight to OSS (backend never proxies ' +
      'bytes — ADR-0045 / FR-003). The (accountId, sessionId) scope is derived server-side from the ' +
      'claimed event (eventId) — the channel must NOT self-report it (FR-002). Unknown / non-claimed / ' +
      'wrong-bizType event → 404 (anti-enumeration, byte-identical, no leak). Credential issuance failure ' +
      '(OSS unconfigured / vendor) → ProblemDetail without leaking vendor details (FR-008).',
  })
  @ApiResponse({
    status: 200,
    description: 'Scope-restricted PostObject credential (text/html, session-locked prefix)',
    type: MockupCredentialResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing / invalid worker token (WorkerAuthGuard, byte-identical)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown / non-claimed / wrong-bizType event (anti-enumeration — FR-002)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'OSS_NOT_CONFIGURED — object storage not provisioned (no vendor detail — FR-008)',
    type: ProblemDetailResponse,
  })
  async issue(@Body() body: MockupCredentialRequest): Promise<MockupCredentialResponse> {
    return this.issueCredential.execute(body.eventId);
  }
}
