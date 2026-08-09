import { Controller, Get, HttpCode, Param, Req, UseGuards } from '@nestjs/common';
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
import { GetWatchlistStatusUseCase } from './get-watchlist-status.usecase';
import { WatchlistStatusResponse } from './watchlist-status.response';

/**
 * 既有桶 (001-013/015) —— watchlist-status 是 read EP, @Throttle 自己 read 桶 (复用 013
 * `watchlist-read-account`) + @SkipThrottle 其余全部 (含 013 write 桶), 防共享存储被更紧
 * limit 的桶误限流。与 watchlist-groups.controller 的 read EP 一致。
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
 * GET /api/v1/portfolio/instruments/{market}/{code}/watchlist-status (014 EP1, 唯一新 server 端点)
 *  → { inWatchlist (窄义「自选」组), memberships[{groupId,itemId}] (所有非持仓组) }。
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE → 失败统一 401 反枚举, 与 /me 一致)。
 * 限流 per-account (AccountIdThrottlerGuard) 复用 013 read 桶 120/60s。
 * 未知 symbol / 非法 market → { inWatchlist:false, memberships:[] } (非 404, 反枚举, FR-S06)。
 * 详情/K线/报价不在本端点 —— mobile client 直调 015 EP3/EP4 client-side merge (ADR-0048)。
 */
@ApiTags('portfolio')
@Controller('v1/portfolio/instruments')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class WatchlistStatusController {
  constructor(private readonly getStatusUseCase: GetWatchlistStatusUseCase) {}

  @Get(':market/:code/watchlist-status')
  @HttpCode(200)
  @SkipThrottle({ ...EXISTING_BUCKETS, 'watchlist-write-account': true })
  @Throttle({ 'watchlist-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'market', description: '市场 (cn/hk/us)', example: 'cn' })
  @ApiParam({ name: 'code', description: '标的代码', example: '600519' })
  @ApiOperation({
    summary: 'Watchlist status of an instrument',
    description:
      'Returns whether (market,code) is in the system 「自选」 group (inWatchlist, narrow) and its memberships across all non-holdings groups ({groupId,itemId} feeding the edit-groups panel). Unknown symbol / invalid market → { inWatchlist:false, memberships:[] } (not 404, anti-enumeration). Quote/detail are NOT here — the mobile client merges 015 EP3/EP4 client-side (ADR-0048).',
  })
  @ApiResponse({
    status: 200,
    description: 'Watchlist status retrieved',
    type: WatchlistStatusResponse,
  })
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
  async status(
    @Req() req: { user: AuthenticatedUser },
    @Param('market') market: string,
    @Param('code') code: string,
  ): Promise<WatchlistStatusResponse> {
    return this.getStatusUseCase.execute(req.user.accountId, market, code);
  }
}
