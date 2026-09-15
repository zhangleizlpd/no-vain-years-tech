import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthenticatedUser } from '../account/jwt-auth.guard';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import { OPTIONSDESK_READ_BUCKET } from '../security/throttler-skip-buckets';
import { skipExcept } from './optionsdesk.controller';
import { ListBrokerPositionsUseCase } from './list-broker-positions.usecase';
import { BROKER_POSITION_NOT_FOUND, GetBrokerPositionUseCase } from './get-broker-position.usecase';
import { BROKER_ORDER_NOT_FOUND, GetBrokerOrderUseCase } from './get-broker-order.usecase';
import {
  BrokerOrderDetailResponse,
  BrokerPositionDetailResponse,
  BrokerPositionListResponse,
  BrokerPositionsQuery,
  toBrokerOrderDetailResponse,
  toBrokerPositionDetailResponse,
  toBrokerPositionListResponse,
} from './broker-account.dto';

/** `broker_position.id` / `broker_order.id` 为 int8; 超出即不可能存在。 */
const INT8_MAX = BigInt('9223372036854775807');

/**
 * 行 id 路径段 → BigInt; 非数字 / 超出 int8 折叠为该资源同一个 404 (`notFound`, 与不存在不可区分)。
 */
function parseBrokerRowId(raw: string, notFound: string): bigint {
  const id = /^\d{1,19}$/.test(raw) ? BigInt(raw) : null;
  if (id === null || id > INT8_MAX) {
    throw new NotFoundException(notFound);
  }
  return id;
}

/**
 * 083 交易账户页读接口 (plan D1):
 *
 * GET /api/v1/optionsdesk/broker-positions?market=us|hk   持仓列表
 * GET /api/v1/optionsdesk/broker-positions/:id            持仓详情 (汇总 + 订单 + 批次)
 * GET /api/v1/optionsdesk/broker-orders/:id               订单详情
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
  constructor(
    private readonly listBrokerPositions: ListBrokerPositionsUseCase,
    private readonly getBrokerPosition: GetBrokerPositionUseCase,
    private readonly getBrokerOrder: GetBrokerOrderUseCase,
  ) {}

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

  @Get('broker-positions/:id')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '持仓行 id (数字串)', example: '42' })
  @ApiOperation({
    summary: 'One broker position: summary + orders + lots (read-only)',
    description:
      'Summary carries the same fields as a list row plus openedAtLocal. Orders are this ' +
      "position's code on the same connection (combo orders included via their leg codes); when " +
      'openedAtSource is derived only orders last UPDATED at or after openedAt are included, ' +
      'fallback includes all; ordered by vendor creation time desc (null last), then order id. ' +
      'Options carry FIFO lots of the current holding cycle (restorable=false still returns the ' +
      'lots); stocks have lots=null. A missing position, one owned by another account, one whose ' +
      'underlying is unresolved, and one outside the anchor set all return the identical 404 ' +
      '(detail BROKER_POSITION_NOT_FOUND).',
  })
  @ApiResponse({ status: 200, description: 'Position detail', type: BrokerPositionDetailResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 404, description: 'Position not found', type: ProblemDetailResponse })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async position(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
  ): Promise<BrokerPositionDetailResponse> {
    return toBrokerPositionDetailResponse(
      await this.getBrokerPosition.execute(
        req.user.accountId,
        parseBrokerRowId(id, BROKER_POSITION_NOT_FOUND),
      ),
    );
  }

  @Get('broker-orders/:id')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '订单行 id (数字串)', example: '88' })
  @ApiOperation({
    summary: 'One broker order (read-only)',
    description:
      'Order fields as synced from the broker for the CURRENT account. dealtAmount = dealtQty × ' +
      'dealtAvgPrice × multiplier, where the multiplier is derived from this order ' +
      '(amount ÷ (qty × price), rounded; same basis as position lots). An unfilled order ' +
      '(dealtQty 0 or missing) has all three dealt fields null; a zero-price order has ' +
      'dealtAmount 0. A missing order, one owned by another account, one whose underlying is ' +
      'unresolved, and one outside the anchor set all return the identical 404 ' +
      '(detail BROKER_ORDER_NOT_FOUND).',
  })
  @ApiResponse({ status: 200, description: 'Order detail', type: BrokerOrderDetailResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 404, description: 'Order not found', type: ProblemDetailResponse })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async order(
    @Req() req: { user: AuthenticatedUser },
    @Param('id') id: string,
  ): Promise<BrokerOrderDetailResponse> {
    return toBrokerOrderDetailResponse(
      await this.getBrokerOrder.execute(
        req.user.accountId,
        parseBrokerRowId(id, BROKER_ORDER_NOT_FOUND),
      ),
    );
  }
}
