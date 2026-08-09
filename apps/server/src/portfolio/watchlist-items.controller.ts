import { Body, Controller, Delete, HttpCode, Param, Patch, Req, UseGuards } from '@nestjs/common';
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
  CHAT_ALL,
  IDEATION_ALL,
  ALERT_ALL,
  PORTFOLIO_HOLDINGS_ALL,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { UpdateWatchlistItemUseCase } from './update-watchlist-item.usecase';
import { DeleteWatchlistItemUseCase } from './delete-watchlist-item.usecase';
import { ItemListResponse } from './watchlist-item-list.response';
import { UpdateWatchlistItemRequest } from './update-watchlist-item.request';

/**
 * 既有桶 (001-015) —— 本 controller 仅写 EP (EP8/EP9), 各 @Throttle write 桶 + @SkipThrottle
 * 其余全部 (含 watchlist read 桶), 防共享存储被其它桶误限流 (同 watchlist-groups controller)。
 */
const EXISTING_BUCKETS = {
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
  ...ALERT_ALL,
  ...CHAT_ALL,
  ...IDEATION_ALL,
  ...OPTIONSDESK_ALL,
  ...PORTFOLIO_HOLDINGS_ALL,
};

/**
 * PATCH  /api/v1/portfolio/watchlist-items/{itemId}  (EP8 标的改: 固顶/移动/改组/颜色/笔记; 持仓拒 422)
 * DELETE /api/v1/portfolio/watchlist-items/{itemId}  (EP9 标的删: 持仓派生项拒 422)
 *
 * authed (JwtAuthGuard) + per-account 限流 (AccountIdThrottlerGuard, write 60/60s, D5)。
 * itemId 路径段为数字串 → UC 内 BigInt 解析 (非法 → 404 反枚举)。EP6/EP7 (items list/add)
 * 挂 watchlist-groups controller (nested groups path), 本 controller 仅 item-level 改/删。
 */
@ApiTags('portfolio')
@Controller('v1/portfolio/watchlist-items')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class WatchlistItemsController {
  constructor(
    private readonly updateUseCase: UpdateWatchlistItemUseCase,
    private readonly deleteUseCase: DeleteWatchlistItemUseCase,
  ) {}

  @Patch(':itemId')
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-read-account': true })
  @Throttle({ 'watchlist-write-account': { limit: 60, ttl: 60_000 } })
  @ApiParam({ name: 'itemId', description: '自选标的 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Update a watchlist item',
    description:
      'Pin / move (front|back within its area) / change group (targetGroupId) / color / note. Ordering follows resortWithPinPriority (pinned area atop; move-front lands below pinned). A group change touches both source + target groups → returns their full items (D8). holdings group (source or target) → 422 HOLDINGS_GROUP_READONLY. Unknown item → 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated; affected items returned',
    type: ItemListResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid body — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'WATCHLIST_ITEM_NOT_FOUND / GROUP_NOT_FOUND',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 422,
    description: 'HOLDINGS_GROUP_READONLY — derived group not writable',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (60/60s per account)',
    type: ProblemDetailResponse,
  })
  async update(
    @Req() req: { user: AuthenticatedUser },
    @Param('itemId') itemId: string,
    @Body() body: UpdateWatchlistItemRequest,
  ): Promise<ItemListResponse> {
    return this.updateUseCase.execute(req.user.accountId, itemId, body);
  }

  @Delete(':itemId')
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-read-account': true })
  @Throttle({ 'watchlist-write-account': { limit: 60, ttl: 60_000 } })
  @ApiParam({ name: 'itemId', description: '自选标的 id (数字串)', example: '101' })
  @ApiOperation({
    summary: 'Delete a watchlist item',
    description:
      'Deletes a watchlist item; the group remaining items renormalize (dense 0-based per area). holdings derived item → 422 HOLDINGS_GROUP_READONLY (V1 unreachable, defensive). Unknown item → 404. Returns the full item list of the group.',
  })
  @ApiResponse({
    status: 200,
    description: 'Deleted; group items returned',
    type: ItemListResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'WATCHLIST_ITEM_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 422,
    description: 'HOLDINGS_GROUP_READONLY — derived item not deletable',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (60/60s per account)',
    type: ProblemDetailResponse,
  })
  async delete(
    @Req() req: { user: AuthenticatedUser },
    @Param('itemId') itemId: string,
  ): Promise<ItemListResponse> {
    return this.deleteUseCase.execute(req.user.accountId, itemId);
  }
}
