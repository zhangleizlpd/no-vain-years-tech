import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthenticatedUser } from '../account/jwt-auth.guard';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import { FormValidationException } from '../security/form-validation.exception';
import {
  DEFAULT_BUCKET,
  SMS_CODE_BUCKETS,
  ME_BUCKETS,
  TOKEN_BUCKETS,
  ALL_DELETION_BUCKETS,
  DEVICE_BUCKETS,
  WECHAT_BUCKETS,
  MARKET_PREF_ALL,
  MARKETDATA_ALL,
  WATCHLIST_ALL,
  CHAT_ALL,
  IDEATION_ALL,
  ALERT_ALL,
  PORTFOLIO_HOLDINGS_ALL,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { ListBrokerAccountsUseCase } from './list-broker-accounts.usecase';
import { BindBrokerAccountUseCase } from './bind-broker-account.usecase';
import { DeleteBrokerAccountUseCase } from './delete-broker-account.usecase';
import { BrokerAccountListResponse } from './broker-account-list.response';
import { BrokerAccountItem } from './broker-account-item.response';
import { BindBrokerAccountRequest } from './bind-broker-account.request';

/**
 * 既有桶 (001-011, 含 011 market-preferences) —— broker EP 各 @Throttle 己桶 +
 * @SkipThrottle 其余全部, 防共享存储被其它桶 (更紧 limit + 共享 key) 误限流。
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
  ...MARKETDATA_ALL,
  ...WATCHLIST_ALL,
  ...ALERT_ALL,
  ...CHAT_ALL,
  ...IDEATION_ALL,
  ...OPTIONSDESK_ALL,
  ...PORTFOLIO_HOLDINGS_ALL,
};

/**
 * GET    /api/v1/portfolio/broker-accounts        (EP1, FR-S01 列出 + 默认置顶 + 跨账号隔离)
 * POST   /api/v1/portfolio/broker-accounts        (EP2, FR-S02/S03/S04 绑定 + 字典/禁字符校验 + dup→409)
 * DELETE /api/v1/portfolio/broker-accounts/{id}    (EP3, FR-S05/S06 删除 + 默认不可删 + 反枚举 404)
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举, 与 /me 一致路径)。
 * 限流 per-account (AccountIdThrottlerGuard): get 60/60s · post 30/60s · delete 30/60s (D4)。
 */
@ApiTags('portfolio')
@Controller('v1/portfolio/broker-accounts')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class BrokerAccountsController {
  constructor(
    private readonly listUseCase: ListBrokerAccountsUseCase,
    private readonly bindUseCase: BindBrokerAccountUseCase,
    private readonly deleteUseCase: DeleteBrokerAccountUseCase,
  ) {}

  @Get()
  @HttpCode(200)
  @SkipThrottle({
    ...EXISTING_BUCKETS,
    'broker-acct-post-account': true,
    'broker-acct-delete-account': true,
  })
  @Throttle({ 'broker-acct-get-account': { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'List broker accounts',
    description:
      "Returns the synthetic system default account (always first, isDefault=true, id=accountId) followed by this account's bound broker accounts by createdAt asc. clientNo is returned raw (masking is client-side, FR-S07). Cross-account isolated.",
  })
  @ApiResponse({
    status: 200,
    description: 'Broker accounts retrieved (default first)',
    type: BrokerAccountListResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (60/60s per account)',
    type: ProblemDetailResponse,
  })
  async list(@Req() req: { user: AuthenticatedUser }): Promise<BrokerAccountListResponse> {
    const { accounts } = await this.listUseCase.execute(req.user.accountId);
    return { accounts };
  }

  @Post()
  @HttpCode(201)
  @SkipThrottle({
    ...EXISTING_BUCKETS,
    'broker-acct-get-account': true,
    'broker-acct-delete-account': true,
  })
  @Throttle({ 'broker-acct-post-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Bind a broker account',
    description:
      'Binds a {brokerCode, clientNo} pair. brokerCode must be in the static catalog; clientNo is trimmed and rejected if blank or containing control / zero-width / line-separator chars (→ 400 FORM_VALIDATION). A duplicate {brokerCode, clientNo} for the same account → 409 BROKER_ACCOUNT_DUPLICATE (unique index, no pre-check).',
  })
  @ApiResponse({
    status: 201,
    description: 'Bound; the new broker account item returned',
    type: BrokerAccountItem,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid body / unknown brokerCode / blank or forbidden clientNo — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 409,
    description: 'BROKER_ACCOUNT_DUPLICATE — same {brokerCode, clientNo} already bound',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async bind(
    @Req() req: { user: AuthenticatedUser },
    @Body() body: BindBrokerAccountRequest,
  ): Promise<BrokerAccountItem> {
    return this.bindUseCase.execute(req.user.accountId, body.brokerCode, body.clientNo);
  }

  @Delete(':id')
  @HttpCode(204)
  @SkipThrottle({
    ...EXISTING_BUCKETS,
    'broker-acct-get-account': true,
    'broker-acct-post-account': true,
  })
  @Throttle({ 'broker-acct-delete-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '券商账户条目 id (broker_account.id)', example: '42' })
  @ApiOperation({
    summary: 'Delete a broker account',
    description:
      "Scoped-delete then decide (D3): deletes the row only if it belongs to this account → 204. The synthetic default account (id=accountId) cannot be deleted → 400 DEFAULT_ACCOUNT_NOT_DELETABLE. A non-existent id or another account's id → 404 (byte-identical anti-enumeration). Idempotent: re-deleting → 404.",
  })
  @ApiResponse({ status: 204, description: 'Deleted (or no-op)' })
  @ApiResponse({
    status: 400,
    description: 'DEFAULT_ACCOUNT_NOT_DELETABLE (id=accountId) or malformed id — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'Missing / invalid / expired token, or account not ACTIVE — reason not disclosed (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'Not found / belongs to another account — byte-identical (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (30/60s per account)',
    type: ProblemDetailResponse,
  })
  async delete(@Req() req: { user: AuthenticatedUser }, @Param('id') idRaw: string): Promise<void> {
    // portfolio 禁 import auth/ParseBigIntPipe (ESLint boundaries 叶子约束) → 就地解析。
    // id 是 BigInt (broker_account.id 可超 Number.MAX_SAFE_INTEGER); 非法 → 400 FORM_VALIDATION
    // (与 body 校验统一错误码契约, ADR-0038)。
    if (!/^\d+$/.test(idRaw)) {
      throw new FormValidationException([
        { field: 'id', messages: ['must be a non-negative integer'] },
      ]);
    }
    await this.deleteUseCase.execute(req.user.accountId, BigInt(idRaw));
  }
}
