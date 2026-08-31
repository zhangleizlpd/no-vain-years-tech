import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminOnlyGuard } from '../account/admin-only.guard';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { JwtAuthGuard } from '../account/jwt-auth.guard';
import {
  OPTIONSDESK_ALL,
  OPTIONSDESK_APPROVE_BUCKET,
  OPTIONSDESK_READ_BUCKET,
  OPTIONSDESK_WRITE_BUCKET,
} from '../security/throttler-skip-buckets';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import { ApproveAnchorSubmissionUseCase } from './approve-anchor-submission.usecase';
import {
  ListAnchorSubmissionsUseCase,
  type AnchorSubmissionView,
} from './list-anchor-submissions.usecase';
import { RejectAnchorSubmissionsUseCase } from './reject-anchor-submissions.usecase';
import {
  AnchorSubmissionDetailResponse,
  AnchorSubmissionListQuery,
  AnchorSubmissionReviewListResponse,
  ApproveAnchorSubmissionRequest,
  ApproveAnchorSubmissionResponse,
  RejectAnchorSubmissionsRequest,
  RejectAnchorSubmissionsResponse,
  toAnchorSubmissionReviewResponse,
} from './optionsdesk.dto';

/** 跳过同组其余桶, 只让本 EP 自己的桶生效 (体例同 optionsdesk.controller.ts)。 */
function skipExcept(bucket: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...OPTIONSDESK_ALL };
  for (const key of Object.keys(bucket)) skip[key] = false;
  return skip;
}

function parseSubmissionId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) throw new NotFoundException('SUBMISSION_NOT_FOUND');
  return BigInt(raw);
}

/**
 * 072 锚待审箱审阅面 —— **admin-only**。
 *
 * 🚨 **为什么另起一个 controller, 而不是在 `OptionsdeskController` 上逐方法挂
 * `@UseGuards(AdminOnlyGuard)`**（后者机制上完全可行 —— Nest 的类级与方法级 guard 是**叠加**
 * 不是替换）：**类级是保证, 方法级是纪律**。
 * 独立 controller 上, 将来第 N 个 admin 路由是「构造上」被门住的; 挂在共享 controller 上,
 * 一个忘了写 `@UseGuards` 的新路由就对**每个登录账号**静默敞开, 而**没有任何东西会红**。
 * 这与 `optionsdesk-guest.controller.ts` 为自己写下的理由一字不差:
 * 「『服务端恰好没实现』是会被未来某个 PR 悄悄打破的状态」。
 *
 * 📌 同 `@ApiTags('optionsdesk')` + 同 `v1/optionsdesk` 前缀 ⇒ orval 按 **tag** 分文件,
 * 生成的 hook 仍落在 `packages/api-client/src/generated/optionsdesk/`, barrel 无需改。
 * 先例: alert ctx 在同一前缀同一 tag 下跑三个 controller。
 *
 * 📌 **无 accountId scope** —— 待审箱是**系统维护面**, 不是某个账号的数据 (表无 `account_id`
 * 列)。`AdminOnlyGuard` 只决定「能不能进这个面」, 不参与任何过滤。
 */
@ApiTags('optionsdesk')
@Controller('v1/optionsdesk')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard, AdminOnlyGuard)
@ApiBearerAuth()
export class AnchorSubmissionController {
  constructor(
    private readonly listSubmissions: ListAnchorSubmissionsUseCase,
    private readonly approveSubmission: ApproveAnchorSubmissionUseCase,
    private readonly rejectSubmissions: RejectAnchorSubmissionsUseCase,
  ) {}

  @Get('anchor-submissions')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '列出待审估值 (admin)',
    description:
      '默认 status=PENDING。每行带 disposition / asofFlag / asofSuggested / 标的名 —— ' +
      '这四样是 anchor-approve.sh plan 那条 SQL 的判断力搬上线, 少一样人就得回去开 psql。**不分页**。',
  })
  @ApiResponse({ status: 200, type: AnchorSubmissionReviewListResponse })
  @ApiResponse({ status: 401, type: ProblemDetailResponse })
  @ApiResponse({ status: 403, description: '非系统管理员', type: ProblemDetailResponse })
  async list(
    @Query() query: AnchorSubmissionListQuery,
  ): Promise<AnchorSubmissionReviewListResponse> {
    const { items, truncated } = await this.listSubmissions.execute({
      status: query.status,
      market: query.market,
    });
    return {
      items: items.map(toAnchorSubmissionReviewResponse),
      total: items.length,
      truncated,
    };
  }

  @Get('anchor-submissions/:id')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '待审条目 id (数字串)', example: '155' })
  @ApiOperation({
    summary: '待审详情 + 采纳前预览 (admin)',
    description:
      '比列表多两样: fallbackPreview(采纳会冲掉哪些人工位, 与真实写入路径共用同一个纯函数) ' +
      '与 willBeNoop(本次采纳会不会什么都不写)。',
  })
  @ApiResponse({ status: 200, type: AnchorSubmissionDetailResponse })
  @ApiResponse({ status: 401, type: ProblemDetailResponse })
  @ApiResponse({ status: 403, type: ProblemDetailResponse })
  @ApiResponse({ status: 404, type: ProblemDetailResponse })
  async getOne(@Param('id') id: string): Promise<AnchorSubmissionDetailResponse> {
    const submissionId = parseSubmissionId(id);
    const detail = await this.listSubmissions.getDetail(submissionId);
    if (detail === null) throw new NotFoundException('SUBMISSION_NOT_FOUND');
    const { view, preview } = detail;
    return {
      ...toAnchorSubmissionReviewResponse(view satisfies AnchorSubmissionView),
      fallbackPreview: preview.fallbackEntries.map((e) => ({
        ticker: e.ticker,
        slot: e.slot,
        manualValue: e.manualValue,
        fallbackValue: e.fallbackValue,
      })),
      willBeNoop: preview.willBeNoop,
      existingConfidenceSource: preview.existingConfidenceSource,
    };
  }

  @Post('anchor-submissions/:id/approve')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_APPROVE_BUCKET))
  @Throttle({ 'optionsdesk-approve-account': { limit: 6, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '待审条目 id (数字串)', example: '155' })
  @ApiOperation({
    summary: '采纳一条待审估值 (admin)',
    description:
      '经**与本人导入完全相同的路径**落锚 (FR-012: 系统 MUST NOT 存在第二条写锚路径)。' +
      '限流 6/60s 是**节流不是防滥用** —— 每条 action=create 会排一个分钟级、串行的真 vendor 冷启动。',
  })
  @ApiResponse({ status: 200, type: ApproveAnchorSubmissionResponse })
  @ApiResponse({
    status: 400,
    description: 'ticker / V / 置信度值域非法',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 401, type: ProblemDetailResponse })
  @ApiResponse({ status: 403, type: ProblemDetailResponse })
  @ApiResponse({ status: 404, description: '条目不存在', type: ProblemDetailResponse })
  @ApiResponse({
    status: 409,
    description:
      'SUBMISSION_NOT_PENDING(已被处置过) / ASOF_SUSPECT(口径日可疑, 需 asofAck) / ' +
      'ASOF_SHIFT_UNRESOLVABLE(日历解不出前一交易日, **不猜**)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: '采纳过快 (6/60s)', type: ProblemDetailResponse })
  async approve(
    @Param('id') id: string,
    @Body() body: ApproveAnchorSubmissionRequest,
  ): Promise<ApproveAnchorSubmissionResponse> {
    const result = await this.approveSubmission.execute({
      id: parseSubmissionId(id),
      v: body.v,
      asof: body.asof,
      method: body.method,
      confidence: body.confidence,
      reviewNote: body.reviewNote,
      asofAck: body.asofAck,
    });
    return {
      action: result.action,
      anchorId: result.anchorId,
      ticker: result.ticker,
      appliedAsof: result.appliedAsof,
      asofFlag: result.asofFlag,
      fallbackEntries: result.fallbackEntries.map((e) => ({
        ticker: e.ticker,
        slot: e.slot,
        manualValue: e.manualValue,
        fallbackValue: e.fallbackValue,
      })),
      statusFlipped: result.statusFlipped,
      coldStartExpected: result.coldStartExpected,
    };
  }

  @Post('anchor-submissions/reject')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_WRITE_BUCKET))
  @Throttle({ 'optionsdesk-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: '批量驳回待审估值 (admin)',
    description:
      '**驳回可以批量而采纳不行**: 驳回零副作用(不写锚/不发事件/不打 vendor/不排冷启动), ' +
      '采纳每条都有三个副作用且都要人过一遍闸。别为「对称」把两者合并。',
  })
  @ApiResponse({ status: 200, type: RejectAnchorSubmissionsResponse })
  @ApiResponse({ status: 401, type: ProblemDetailResponse })
  @ApiResponse({ status: 403, type: ProblemDetailResponse })
  async reject(
    @Body() body: RejectAnchorSubmissionsRequest,
  ): Promise<RejectAnchorSubmissionsResponse> {
    return this.rejectSubmissions.execute({
      ids: body.ids.map(parseSubmissionId),
      reviewNote: body.reviewNote,
    });
  }
}
