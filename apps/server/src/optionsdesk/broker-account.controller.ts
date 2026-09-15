import { Controller, Get, HttpCode, Query, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthenticatedUser } from '../account/jwt-auth.guard';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import { OPTIONSDESK_READ_BUCKET } from '../security/throttler-skip-buckets';
import { skipExcept } from './optionsdesk.controller';
import { ListBrokerPositionsUseCase } from './list-broker-positions.usecase';
import {
  BrokerPositionListResponse,
  BrokerPositionsQuery,
  toBrokerPositionListResponse,
} from './broker-account.dto';

/**
 * 083 交易账户页读接口 (plan D1):
 *
 * GET /api/v1/optionsdesk/broker-positions?market=us|hk   持仓列表
 *
 * 🚨 **只读** (FR-019): 本 controller 无任何写端点 —— 下单 / 改单 / 撤单 / 平仓入口一律不存在。
 *
 * 🚨 **账号隔离** (Guardrail 2): 账号只取 `req.user.accountId` (`JwtAuthGuard` 填), 由 use case
 * 下沉进每条 `broker_*` 查询的 `where`。与锚管理 controller 不同 —— 锚是全局事实、鉴权只决定
 * 「能不能进」; 券商数据是**账号私有**的。
 *
 * 鉴权与限流同 `optionsdesk.controller.ts` (JwtAuthGuard + per-account `optionsdesk-read-account`
 * 120/60s)。另起 controller 只为按 082 表名 `broker` 名词段分组 (plan D0), 不引入新鉴权面。
 */
@ApiTags('optionsdesk')
@Controller('v1/optionsdesk')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class BrokerAccountController {
  constructor(private readonly listBrokerPositions: ListBrokerPositionsUseCase) {}

  @Get('broker-positions')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Broker positions of one market, grouped by underlying (read-only)',
    description:
      'Reads the positions already synced from the broker for the CURRENT account only — no ' +
      'broker call is made. Only underlyings present in the anchor table (excluded anchors ' +
      'included) are shown; positions whose underlying could not be resolved are only counted ' +
      '(unresolvedCount). Groups are ordered by |group market value| desc (null last), then ' +
      'ticker. P&L fields use the average-cost basis; a missing vendor value is null, never 0. ' +
      'The four non-list client states derive from hasConnection / syncedAt / groups.length.',
  })
  @ApiResponse({ status: 200, description: 'Position list', type: BrokerPositionListResponse })
  @ApiResponse({ status: 400, description: 'market not in us|hk', type: ProblemDetailResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async positions(
    @Req() req: { user: AuthenticatedUser },
    @Query() query: BrokerPositionsQuery,
  ): Promise<BrokerPositionListResponse> {
    return toBrokerPositionListResponse(
      await this.listBrokerPositions.execute(req.user.accountId, query.market),
    );
  }
}
