import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  CHAT_ALL,
  IDEATION_ALL,
  ALERT_ALL,
  PORTFOLIO_HOLDINGS_ALL,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { ListWatchlistGroupsUseCase } from './list-watchlist-groups.usecase';
import { CreateWatchlistGroupUseCase } from './create-watchlist-group.usecase';
import { UpdateWatchlistGroupUseCase } from './update-watchlist-group.usecase';
import { DeleteWatchlistGroupUseCase } from './delete-watchlist-group.usecase';
import { ReorderWatchlistGroupsUseCase } from './reorder-watchlist-groups.usecase';
import { ListWatchlistItemsUseCase } from './list-watchlist-items.usecase';
import { AddWatchlistItemUseCase } from './add-watchlist-item.usecase';
import { GroupListResponse } from './group-list.response';
import { ItemListResponse } from './watchlist-item-list.response';
import { CreateWatchlistGroupRequest } from './create-watchlist-group.request';
import { UpdateWatchlistGroupRequest } from './update-watchlist-group.request';
import { ReorderWatchlistGroupsRequest } from './reorder-watchlist-groups.request';
import { AddWatchlistItemRequest } from './add-watchlist-item.request';

/**
 * 既有桶 (001-012/015) —— watchlist EP 各 @Throttle 己桶 (read 或 write) + @SkipThrottle
 * 其余全部, 防共享存储被其它桶 (更紧 limit + 共享 key) 误限流。读 EP skip write 桶, 写 EP
 * skip read 桶 (本组仅 read/write 2 桶)。
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
 * GET    /api/v1/portfolio/watchlist-groups                  (EP1 列分组: 零写库投影虚拟系统组 / 读回)
 * POST   /api/v1/portfolio/watchlist-groups                  (EP2 建自定义组: 首写 materialize 系统组)
 * PATCH  /api/v1/portfolio/watchlist-groups                  (EP5 批量 reorder: order+visible)
 * PATCH  /api/v1/portfolio/watchlist-groups/{groupId}        (EP3 自定义组改名; 系统组拒 422)
 * DELETE /api/v1/portfolio/watchlist-groups/{groupId}        (EP4 删自定义组: item 回落自选; 系统组拒 422)
 * GET    /api/v1/portfolio/watchlist-groups/{groupId}/items  (EP6 列某组标的: 持仓组派生只读 V1 空)
 * POST   /api/v1/portfolio/watchlist-groups/{groupId}/items  (EP7 加标的: 默认落自选; 持仓组拒 422; 幂等)
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举, 与 /me 一致路径)。
 * 限流 per-account (AccountIdThrottlerGuard): read 120/60s · write 60/60s (D5)。
 * groupId 路径段为 string (keyword 系统组 或 数字串, plan D9) → UC 内解析, 无 ParseBigIntPipe。
 */
@ApiTags('portfolio')
@Controller('v1/portfolio/watchlist-groups')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class WatchlistGroupsController {
  constructor(
    private readonly listUseCase: ListWatchlistGroupsUseCase,
    private readonly createUseCase: CreateWatchlistGroupUseCase,
    private readonly updateUseCase: UpdateWatchlistGroupUseCase,
    private readonly deleteUseCase: DeleteWatchlistGroupUseCase,
    private readonly reorderUseCase: ReorderWatchlistGroupsUseCase,
    private readonly listItemsUseCase: ListWatchlistItemsUseCase,
    private readonly addItemUseCase: AddWatchlistItemUseCase,
  ) {}

  @Get()
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-write-account': true })
  @Throttle({ 'watchlist-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'List watchlist groups',
    description:
      'Returns the account groups by order asc. A brand-new account (zero rows) projects the 2 virtual system groups (「自选」/「持仓」, id=systemKind keyword, zero write). System groups materialize on first write. itemCount per group (holdings group is V1-empty).',
  })
  @ApiResponse({ status: 200, description: 'Groups retrieved', type: GroupListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (120/60s per account)',
    type: ProblemDetailResponse,
  })
  async list(@Req() req: { user: AuthenticatedUser }): Promise<GroupListResponse> {
    return this.listUseCase.execute(req.user.accountId);
  }

  @Post()
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-read-account': true })
  @Throttle({ 'watchlist-write-account': { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create a custom group',
    description:
      'Creates a custom group (type=custom). First write materializes the 2 system groups. name is deduped per account (→ 400 FORM_VALIDATION on collision). Returns the full group list.',
  })
  @ApiResponse({ status: 200, description: 'Created; full list returned', type: GroupListResponse })
  @ApiResponse({
    status: 400,
    description: 'Invalid / duplicate name — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (60/60s per account)',
    type: ProblemDetailResponse,
  })
  async create(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: CreateWatchlistGroupRequest,
  ): Promise<GroupListResponse> {
    return this.createUseCase.execute(req.user.accountId, body.name);
  }

  @Patch()
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-read-account': true })
  @Throttle({ 'watchlist-write-account': { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Reorder groups (drag order + visibility)',
    description:
      'Batch updates order + visible (last-write-wins). System groups materialize if not yet (so a brand-new account dragging keyword-id groups persists). Server allows hiding all groups; mobile guarantees 自选 visibility (D4).',
  })
  @ApiResponse({
    status: 200,
    description: 'Reordered; full list returned',
    type: GroupListResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 422,
    description: 'Invalid body — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (60/60s per account)',
    type: ProblemDetailResponse,
  })
  async reorder(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: ReorderWatchlistGroupsRequest,
  ): Promise<GroupListResponse> {
    return this.reorderUseCase.execute(req.user.accountId, body.ordered);
  }

  @Patch(':groupId')
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-read-account': true })
  @Throttle({ 'watchlist-write-account': { limit: 60, ttl: 60_000 } })
  @ApiParam({
    name: 'groupId',
    description: '分组 id (custom 数字串; 系统组 keyword 拒改名)',
    example: '42',
  })
  @ApiOperation({
    summary: 'Rename a custom group',
    description:
      'Renames a custom group. System groups (keyword id or type=system row) → 422 SYSTEM_GROUP_PROTECTED. Unknown id → 404 (anti-enumeration). name deduped per account. Returns the full group list.',
  })
  @ApiResponse({ status: 200, description: 'Renamed; full list returned', type: GroupListResponse })
  @ApiResponse({
    status: 400,
    description: 'Invalid / duplicate name — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'GROUP_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 422,
    description: 'SYSTEM_GROUP_PROTECTED — system group not renamable',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (60/60s per account)',
    type: ProblemDetailResponse,
  })
  async update(
    @Req() req: { user: AuthenticatedUser },
    @Param('groupId') groupId: string,
    @Body() body: UpdateWatchlistGroupRequest,
  ): Promise<GroupListResponse> {
    return this.updateUseCase.execute(req.user.accountId, groupId, body.name);
  }

  @Delete(':groupId')
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-read-account': true })
  @Throttle({ 'watchlist-write-account': { limit: 60, ttl: 60_000 } })
  @ApiParam({
    name: 'groupId',
    description: '分组 id (custom 数字串; 系统组 keyword 拒删)',
    example: '42',
  })
  @ApiOperation({
    summary: 'Delete a custom group',
    description:
      'Deletes a custom group; its items fall back to 自选 (non-cascade, conflicts dropped idempotently, FR-S02). System groups (keyword id or type=system) → 422 SYSTEM_GROUP_PROTECTED. Unknown id → 404. Returns the full group list.',
  })
  @ApiResponse({ status: 200, description: 'Deleted; full list returned', type: GroupListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'GROUP_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 422,
    description: 'SYSTEM_GROUP_PROTECTED — system group not deletable',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (60/60s per account)',
    type: ProblemDetailResponse,
  })
  async delete(
    @Req() req: { user: AuthenticatedUser },
    @Param('groupId') groupId: string,
  ): Promise<GroupListResponse> {
    return this.deleteUseCase.execute(req.user.accountId, groupId);
  }

  @Get(':groupId/items')
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-write-account': true })
  @Throttle({ 'watchlist-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({
    name: 'groupId',
    description: '分组 id (keyword 系统组 或 数字串)',
    example: 'watchlist',
  })
  @ApiOperation({
    summary: 'List items of a group',
    description:
      'Returns the group items by `pinned DESC, order ASC` (pinned area stays atop). keyword id of an unmaterialized group → empty (zero write). holdings group is a derived read-only view (V1 empty). Quote values are NOT in the contract — the mobile client merges 015 /quote client-side (ADR-0048).',
  })
  @ApiResponse({ status: 200, description: 'Items retrieved', type: ItemListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'GROUP_NOT_FOUND — unknown / other account',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (120/60s per account)',
    type: ProblemDetailResponse,
  })
  async listItems(
    @Req() req: { user: AuthenticatedUser },
    @Param('groupId') groupId: string,
  ): Promise<ItemListResponse> {
    return this.listItemsUseCase.execute(req.user.accountId, groupId);
  }

  @Post(':groupId/items')
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-read-account': true })
  @Throttle({ 'watchlist-write-account': { limit: 60, ttl: 60_000 } })
  @ApiParam({
    name: 'groupId',
    description: '分组 id (keyword 系统组 或 数字串)',
    example: 'watchlist',
  })
  @ApiOperation({
    summary: 'Add an item to a group',
    description:
      'Adds a {market, code} item (default 自选 via keyword id). First write materializes system groups. holdings group → 422 HOLDINGS_GROUP_READONLY. Duplicate (market, code) within the group → idempotent (existing item kept). Returns the full item list of the group.',
  })
  @ApiResponse({
    status: 200,
    description: 'Added; full item list returned',
    type: ItemListResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid market / code — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'GROUP_NOT_FOUND — unknown / other account',
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
  async addItem(
    @Req() req: { user: AuthenticatedUser },
    @Param('groupId') groupId: string,
    @Body() body: AddWatchlistItemRequest,
  ): Promise<ItemListResponse> {
    return this.addItemUseCase.execute(req.user.accountId, groupId, body.market, body.code);
  }
}
