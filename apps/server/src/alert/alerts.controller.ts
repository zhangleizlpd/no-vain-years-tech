import {
  Body,
  Controller,
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
  CHAT_ALL,
  IDEATION_ALL,
  ALERT_ALL,
  PORTFOLIO_HOLDINGS_ALL,
  ALERT_READ_BUCKET,
  ALERT_WRITE_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { DEFAULT_ALERT_FREQUENCY } from './alert-validation.rules';
import { ListInstrumentAlertsUseCase } from './list-instrument-alerts.usecase';
import { ListAlertsUseCase } from './list-alerts.usecase';
import { CreateAlertsBatchUseCase } from './create-alerts-batch.usecase';
import { UpdateAlertUseCase } from './update-alert.usecase';
import { DeleteAlertsBatchUseCase } from './delete-alerts-batch.usecase';
import { CreateAlertsRequest } from './create-alerts.request';
import { UpdateAlertRequest } from './update-alert.request';
import { DeleteAlertsBatchRequest } from './delete-alerts-batch.request';
import {
  AlertListResponse,
  AlertResponse,
  DeleteAlertsBatchResponse,
  toAlertListResponse,
  toAlertResponse,
} from './alert.response';

/** 既有桶 (001-015) —— alert EP 各 @Throttle 己桶 + @SkipThrottle 其余全部, 防共享存储被其它桶误限流。 */
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
  ...PORTFOLIO_HOLDINGS_ALL,
  ...CHAT_ALL,
  ...IDEATION_ALL,
  ...OPTIONSDESK_ALL,
};

/**
 * 某 alert EP 的 @SkipThrottle 集 = 既有全部桶 + alert 同组「除己」其余桶 (own 由
 * @Throttle 单独启用)。@Throttle 不会反 un-skip, 故 own 必须不在 skip 集内 (沿 015 范式)。
 */
function skipExcept(own: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...EXISTING_BUCKETS, ...ALERT_ALL };
  for (const key of Object.keys(own)) delete skip[key];
  return skip;
}

/** alert id 路径段数字串 → BigInt; 非法折叠 404 (与不存在不可区分, 反枚举)。 */
function parseAlertId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundException('ALERT_NOT_FOUND');
  }
  return BigInt(raw);
}

/**
 * GET   /api/v1/alert/instruments/{market}/{code}/alerts (EP1 个股预警列表, FR-S07/FR-M01)
 * GET   /api/v1/alert/alerts                              (EP2 全部预警, 分组归 client, FR-S07/FR-M04)
 * POST  /api/v1/alert/alerts                              (EP3 批量创建, 每标的各一条, 原子, FR-S01/S02)
 * PATCH /api/v1/alert/alerts/{id}                         (EP4 编辑: conditions 全量替换/频率/备注/启停)
 * POST  /api/v1/alert/alerts/delete-batch                 (EP5 批量删, 仅删本账号命中项)
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举)。他人资源 → 404
 * (EP4/EP5 UC 层 scope accountId)。限流 per-account (AccountIdThrottlerGuard):
 * read 120/60s · write 30/60s (plan §API Contracts)。
 */
@ApiTags('alert')
@Controller('v1/alert')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class AlertsController {
  constructor(
    private readonly listInstrumentAlerts: ListInstrumentAlertsUseCase,
    private readonly listAlerts: ListAlertsUseCase,
    private readonly createAlertsBatch: CreateAlertsBatchUseCase,
    private readonly updateAlert: UpdateAlertUseCase,
    private readonly deleteAlertsBatch: DeleteAlertsBatchUseCase,
  ) {}

  @Get('instruments/:market/:code/alerts')
  @HttpCode(200)
  @SkipThrottle(skipExcept(ALERT_READ_BUCKET))
  @Throttle({ 'alert-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'market', description: '市场 (V1 仅 cn)', example: 'cn' })
  @ApiParam({ name: 'code', description: '标的代码', example: '603305' })
  @ApiOperation({
    summary: 'List alerts of one instrument (EP1)',
    description:
      'Returns the authed account alerts for one instrument (creation order, conditions inline). Unknown instrument → empty list (no marketdata lookup).',
  })
  @ApiResponse({ status: 200, description: 'Alert list', type: AlertListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (120/60s per account)',
    type: ProblemDetailResponse,
  })
  async listForInstrument(
    @Req() req: { user: AuthenticatedUser },
    @Param('market') market: string,
    @Param('code') code: string,
  ): Promise<AlertListResponse> {
    return toAlertListResponse(
      await this.listInstrumentAlerts.execute(req.user.accountId, market, code),
    );
  }

  @Get('alerts')
  @HttpCode(200)
  @SkipThrottle(skipExcept(ALERT_READ_BUCKET))
  @Throttle({ 'alert-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'List all alerts of the account (EP2)',
    description:
      'Returns all alerts flat (market/code adjacent, creation order within an instrument). Client groups by instrument; quotes come from 015 EP2 client-side merge (never inlined here).',
  })
  @ApiResponse({ status: 200, description: 'Alert list', type: AlertListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (120/60s per account)',
    type: ProblemDetailResponse,
  })
  async listAll(@Req() req: { user: AuthenticatedUser }): Promise<AlertListResponse> {
    return toAlertListResponse(await this.listAlerts.execute(req.user.accountId));
  }

  @Post('alerts')
  @HttpCode(201)
  @SkipThrottle(skipExcept(ALERT_WRITE_BUCKET))
  @Throttle({ 'alert-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create alerts in batch (EP3)',
    description:
      'Applies one conditions/frequency/note set to N instruments — one independent alert each, single transaction (all-or-nothing). Validation: conditions 1..4, one per type, price threshold >0, percent ∈(0,100], note ≤22 code points, market cn only.',
  })
  @ApiResponse({ status: 201, description: 'Created alerts', type: AlertListResponse })
  @ApiResponse({
    status: 400,
    description: 'FORM_VALIDATION — any instrument/draft invalid rejects the whole batch',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async createBatch(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: CreateAlertsRequest,
  ): Promise<AlertListResponse> {
    const created = await this.createAlertsBatch.execute(req.user.accountId, {
      instruments: body.instruments,
      conditions: body.conditions,
      frequency: body.frequency ?? DEFAULT_ALERT_FREQUENCY,
      note: body.note ?? null,
    });
    return toAlertListResponse(created);
  }

  @Patch('alerts/:id')
  @HttpCode(200)
  @SkipThrottle(skipExcept(ALERT_WRITE_BUCKET))
  @Throttle({ 'alert-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '预警 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Update an alert (EP4)',
    description:
      'Conditions (full replacement when provided) / frequency / note (null clears) / enabled toggle. Re-validates the merged draft. Other-account or unknown id → 404 (anti-enumeration).',
  })
  @ApiResponse({ status: 200, description: 'Updated alert', type: AlertResponse })
  @ApiResponse({
    status: 400,
    description: 'FORM_VALIDATION — merged draft invalid',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'ALERT_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async update(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
    @Body() body: UpdateAlertRequest,
  ): Promise<AlertResponse> {
    const updated = await this.updateAlert.execute(req.user.accountId, parseAlertId(id), {
      conditions: body.conditions,
      frequency: body.frequency,
      note: body.note,
      enabled: body.enabled,
    });
    return toAlertResponse(updated);
  }

  @Post('alerts/delete-batch')
  @HttpCode(200)
  @SkipThrottle(skipExcept(ALERT_WRITE_BUCKET))
  @Throttle({ 'alert-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Delete alerts in batch (EP5)',
    description:
      'Deletes only the authed account hits among ids (foreign/unknown silently skipped — anti-enumeration), returns the actual deleted count. Conditions cascade.',
  })
  @ApiResponse({ status: 200, description: 'Deleted count', type: DeleteAlertsBatchResponse })
  @ApiResponse({
    status: 400,
    description: 'FORM_VALIDATION — ids empty / non-numeric entries',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async deleteBatch(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: DeleteAlertsBatchRequest,
  ): Promise<DeleteAlertsBatchResponse> {
    const deleted = await this.deleteAlertsBatch.execute(
      req.user.accountId,
      body.ids.map((id) => BigInt(id)),
    );
    return { deleted };
  }
}
