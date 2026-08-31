import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../account/jwt-auth.guard';
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
  OPTIONSDESK_ALL,
  OPTIONSDESK_READ_BUCKET,
  OPTIONSDESK_WRITE_BUCKET,
} from '../security/throttler-skip-buckets';
import { CreateAnchorUseCase } from './create-anchor.usecase';
import { UpdateAnchorUseCase, type UpdateAnchorPatch } from './update-anchor.usecase';
import { DeleteAnchorUseCase } from './delete-anchor.usecase';
import { ReviewAnchorUseCase } from './review-anchor.usecase';
import { SetPositionBucketUseCase } from './set-position-bucket.usecase';
import { ListAnchorsUseCase } from './list-anchors.usecase';
import { GetAnchorUseCase } from './get-anchor.usecase';
import { GetAnchorAtUseCase } from './get-anchor-at.usecase';
import { GetRadarUseCase } from './get-radar.usecase';
import { GetUnderlyingDetailUseCase } from './get-underlying-detail.usecase';
import { GetThermometerUseCase } from './get-thermometer.usecase';
import { GetLegsUseCase } from './get-legs.usecase';
import { GetChainReportUseCase } from './get-chain-report.usecase';
import {
  AnchorListResponse,
  AnchorPointInTimeResponse,
  AnchorResponse,
  ChainReportResponse,
  CreateAnchorRequest,
  GetAnchorAtQuery,
  LegRetrievalQuery,
  LegTableResponse,
  ListAnchorsQuery,
  PositionBucketResponse,
  RadarQueryDto,
  RadarResponse,
  ReviewAnchorRequest,
  SetPositionBucketRequest,
  ThermometerResponse,
  UnderlyingDetailResponse,
  UpdateAnchorRequest,
  toAnchorListResponse,
  toChainReportResponse,
  toLegTableResponse,
  toRequestedPerspective,
  toRetrievalOverride,
  toAnchorPointInTimeResponse,
  toAnchorResponse,
  toAnchorWriteResponse,
  toPositionBucketResponse,
  toRadarResponse,
  toThermometerResponse,
  toUnderlyingDetailResponse,
} from './optionsdesk.dto';

/** 既有桶 (001-032) —— optionsdesk EP 各 @Throttle 己桶 + @SkipThrottle 其余全部。 */
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
  ...ALERT_ALL,
  ...PORTFOLIO_HOLDINGS_ALL,
  ...CHAT_ALL,
  ...IDEATION_ALL,
};

/**
 * 某 optionsdesk EP 的 @SkipThrottle 集 = 既有全部桶 + optionsdesk 同组「除己」其余桶
 * (own 由 @Throttle 单独启用; @Throttle 不会反 un-skip, 故 own 必须不在 skip 集内)。
 */
export function skipExcept(own: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...EXISTING_BUCKETS, ...OPTIONSDESK_ALL };
  for (const key of Object.keys(own)) delete skip[key];
  return skip;
}

/** 锚 id 路径段数字串 → BigInt; 非法折叠 404 (与不存在不可区分)。 */
function parseAnchorId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundException('ANCHOR_NOT_FOUND');
  }
  return BigInt(raw);
}

/** `YYYY-MM-DD` / ISO 串 → Date; 值域由 ValidationPipe 的 @IsDateString 保证。 */
function toDate(value: string): Date {
  return new Date(value);
}

/** `string | null | undefined` 日期 → `Date | null | undefined` (undefined = 本次不碰该列)。 */
function toOptionalDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(value);
}

/**
 * POST   /api/v1/optionsdesk/anchors            建锚 (EC-7 重复 ticker → 409)
 * GET    /api/v1/optionsdesk/anchors            锚列表 (待复审 / 已排除筛选)
 * GET    /api/v1/optionsdesk/anchors/{id}       单锚详情
 * PATCH  /api/v1/optionsdesk/anchors/{id}       改锚 (含人工位置值 / 撤销回落)
 * DELETE /api/v1/optionsdesk/anchors/{id}       删锚 (痕迹保留, 不级联)
 * POST   /api/v1/optionsdesk/anchors/{id}/review 复审 (FR-007, 唯一红标解除动作)
 * POST   /api/v1/optionsdesk/anchors/{id}/position-bucket 手选仓位水位档 (047 FR-017)
 * GET    /api/v1/optionsdesk/anchors/{id}/at    PIT 还原 (SC-011)
 * GET    /api/v1/optionsdesk/radar             击球区雷达 (游标分页 + SQL 端筛选, FR-010)
 * GET    /api/v1/optionsdesk/underlyings/{symbol} 标的详情上半 (046: 锚卡 + 四区间 + IV 读数)
 * GET    /api/v1/optionsdesk/underlyings/{symbol}/legs 选约表 (047: 全量适格腿, 零截断)
 * GET    /api/v1/optionsdesk/thermometer        波动温度计 (046: VIX/VVIX + 比值 + 逐票 IVP)
 *
 * 🚨 **FR-009 本片零消费方**: 读端 MUST 只服务 App 自身 —— **沿用现有鉴权**
 * (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401), **MUST NOT** 定义跨进程对外服务化面
 * (AnchorProvider v1 Http) 及其认证模型。限流 per-account (AccountIdThrottlerGuard):
 * read 120/60s · write 30/60s (对齐 alert / watchlist read-write 体例)。
 *
 * 🚨 **Guardrail 12**: 本 controller 的 `GET /anchors` 默认**显示** `excluded = true` 的锚
 * (带 `excludeReason`, FR-005); 雷达端点 (T013) 的基础 WHERE 则**排除**它们 —— 两者态度相反,
 * 别为「统一」把它们合并成一个查询。
 *
 * 无 accountId scope: 锚身份即 ticker 全局唯一 (单人自用, 表无 `account_id` 列) —— 鉴权只
 * 决定「能不能进」, 不参与数据过滤。
 */
@ApiTags('optionsdesk')
@Controller('v1/optionsdesk')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class OptionsdeskController {
  constructor(
    private readonly createAnchor: CreateAnchorUseCase,
    private readonly updateAnchor: UpdateAnchorUseCase,
    private readonly deleteAnchor: DeleteAnchorUseCase,
    private readonly reviewAnchor: ReviewAnchorUseCase,
    private readonly setPositionBucket: SetPositionBucketUseCase,
    private readonly listAnchors: ListAnchorsUseCase,
    private readonly getAnchor: GetAnchorUseCase,
    private readonly getAnchorAt: GetAnchorAtUseCase,
    private readonly getRadar: GetRadarUseCase,
    private readonly getUnderlyingDetail: GetUnderlyingDetailUseCase,
    private readonly getThermometer: GetThermometerUseCase,
    private readonly getLegs: GetLegsUseCase,
    private readonly getChainReport: GetChainReportUseCase,
  ) {}

  @Get('underlyings/:symbol')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'symbol', description: 'canonical `market:code`', example: 'us:PEP' })
  @ApiOperation({
    summary: 'Underlying detail (anchor card + zone boundaries + IV readout)',
    description:
      'Returns the anchor card fields, the four zone boundaries derived from the anchor, and the ' +
      'latest per-underlying IV readout — each side carrying its OWN asOf so the client renders ' +
      'two independent freshness labels. The IV readout is an explicit four-state enum: a missing ' +
      'snapshot or a vendor window too short for a percentile is reported as such, never as 0. ' +
      'A cross-context read failure degrades that block only — the anchor card still returns 200. ' +
      'The price SERIES is deliberately NOT here: the client fetches it straight from the ' +
      'marketdata bars endpoint (forward adjustment + time-bucket aggregation live there). ' +
      'No anchor for the symbol → 404 with code ANCHOR_NOT_FOUND_FOR_SYMBOL, so the client can ' +
      'render a "create an anchor" prompt instead of an error page.',
  })
  @ApiResponse({ status: 200, description: 'Underlying detail', type: UnderlyingDetailResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'No anchor for this symbol (FR-011)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async underlyingDetail(@Param('symbol') symbol: string): Promise<UnderlyingDetailResponse> {
    return toUnderlyingDetailResponse(await this.getUnderlyingDetail.execute(symbol));
  }

  @Get('underlyings/:symbol/legs')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'symbol', description: 'canonical `market:code`', example: 'us:PEP' })
  @ApiOperation({
    summary: 'Leg picker table for ONE perspective (no pagination)',
    description:
      'Returns the eligible put legs for ONE perspective — `perspective` is REQUIRED and decides ' +
      'which perspective is answered; a missing or out-of-enum value is a 400, never a silently ' +
      'defaulted perspective (leg count, ranks and tiers would all look normal while answering a ' +
      'question nobody asked). Each perspective is fetched independently, so the three of them are ' +
      'three separate requests: this SUPERSEDES the earlier "one shot, all tabs, switching tabs ' +
      'issues no request" contract. Pagination and "load more" remain absent — narrowing is done ' +
      'through the retrieval criteria, not by paging. Two filters are already applied ' +
      'server-side: non-standard (adjusted-root) ' +
      'contracts never reach this table (they ARE collected and stored — the exclusion happens ' +
      'here, not at ingestion), and expired legs are dropped on "expiry > today". That "today" is ' +
      "the EXCHANGE's today, not the host's, and the DTE it feeds is an integer calendar-day " +
      'count with the expiry day itself as 0. Note the boundary is deliberately strict here while ' +
      'the ingestion-completeness denominator uses >= : a contract expiring today can still be ' +
      'snapshotted today, but it can no longer be traded. Every leg carries its own basis ' +
      '(weekly / annualized), tier, intent-domain earnings mark, completeness flag and the full ' +
      'set of request-time derivations — nothing is materialised in the database. ' +
      'Two timestamps are NOT the same day and both ship: the block asOf / quoteAsOf describe the ' +
      'quotes, while oiAsOf describes open interest, which US option exchanges refresh pre-market ' +
      'and therefore belongs to the PREVIOUS session in an end-of-day snapshot. The OI column MUST ' +
      "render oiAsOf. Activity is a RELATIVE rank inside THIS perspective's candidate set, so " +
      'each leg carries ONE mark, computed for the perspective being answered — the other two ' +
      'have nothing to rank against in this response and are not shipped. The legs array arrives ' +
      'already ranked AND already truncated server-side at displayLimit: its order IS the display ' +
      'order (clients MUST NOT re-sort) and matchedCount is the pre-truncation total, so ' +
      '"showing the first D of N" stays computable without shipping D. Dead-tier legs stay in the ' +
      'list (sorted last) and legs with missing greeks stay in too, unclassified and uncoloured. ' +
      'No anchor for the symbol → 404 with code ANCHOR_NOT_FOUND_FOR_SYMBOL.',
  })
  @ApiResponse({ status: 200, description: 'Leg picker table', type: LegTableResponse })
  @ApiResponse({
    status: 400,
    description: 'Missing / unknown perspective, or a half-given paired criterion (053 FR-001)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'No anchor for this symbol',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async legs(
    @Param('symbol') symbol: string,
    @Query() query: LegRetrievalQuery,
  ): Promise<LegTableResponse> {
    // 053 FR-001: `perspective` 决定**返回哪个视角**, 必填 (缺参 / 非三值由 ValidationPipe 判
    // 400)。除它以外无参数 = 该视角的首屏 / 「复位」⇒ 走系统默认值。
    return toLegTableResponse(
      await this.getLegs.execute(
        symbol,
        toRequestedPerspective(query),
        undefined,
        toRetrievalOverride(query),
        undefined,
        // 064 `FR-015` / plan D6: **本 controller 是今天唯一传 `true` 的读路径**。开关显式落在
        // 调用点上, 🚫 MUST NOT 让 use case 按鉴权状态或请求来源自己推断 —— 那会让「将来加一种
        // 访问方式」静默改变外呼行为 (guest controller 那边一个字都不改, 默认恒关)。
        true,
      ),
    );
  }

  @Get('underlyings/:symbol/chain-report')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'symbol', description: 'canonical `market:code`', example: 'us:PEP' })
  @ApiOperation({
    summary: 'Chain report grid (moneyness band × expiry) + IV term structure',
    description:
      'Aggregates the WHOLE chain into a moneyness-band × expiry grid so one screen answers ' +
      '"which tenor, how far out of the money, where is anyone bidding, and is this chain ' +
      'expensive overall". This is a SEPARATE endpoint from the leg picker on purpose: the ' +
      'picker answers ONE perspective, ranked and truncated, while this one answers the whole ' +
      'chain, unranked and untruncated — putting both behind one endpoint would mean two ' +
      'contracts behind one shape. ' +
      'The grid skeleton is the chain AFTER the premium-floor gate only. Legs held back by the ' +
      'liveness gate deliberately STAY on the grid in the "gated" state: they have a contract, ' +
      'nobody has traded it — dropping them would render as "no contract here", which is wrong ' +
      'information rather than missing information. ' +
      'All FOUR cell metrics ship in ONE response, over ONE skeleton. Switching metric therefore ' +
      'issues no request and cannot move a single cell. Note that cell STATE does change with the ' +
      'metric: the four metrics run over different recall sets, so a cell holding a value under ' +
      'one metric and empty under another is correct behaviour, not a defect. ' +
      'The footer ships THREE mutually exclusive exclusion counts, each with its own denominator; ' +
      'together with the valued count they sum exactly to the chain total. ' +
      'Columns carry the at-the-money implied volatility interpolated between the strikes ' +
      'straddling spot; an expiry with no strike on one side ships null and the curve MUST break ' +
      'there rather than fall back to the nearest strike. ' +
      'The IV percentile block degrades on its own four-state enum and is NOT affected by a grid ' +
      'failure. No anchor for the symbol → 404 with code ANCHOR_NOT_FOUND_FOR_SYMBOL: the report ' +
      'is unreachable until the underlying has been anchored, because one of the four metrics is ' +
      'derived from that anchor and a report missing one corner reads as "this chain has no ' +
      'entry opportunities" rather than "you have not valued it yet".',
  })
  @ApiResponse({ status: 200, description: 'Chain report', type: ChainReportResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'No anchor for this symbol (FR-037a)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async chainReport(@Param('symbol') symbol: string): Promise<ChainReportResponse> {
    // 🚫 **零查询参数**: 报表不排序、不截断、无可调条件, 四种格值一次全返 (plan D-API-2)。
    // 加一个「只要某种格值」的参数就等于把 SC-002 的「切换不发请求」交回给调用方自觉。
    // 064: 实时档开关同上 —— 与选约表同一条读路径上的两个端点, 口径必须一致。
    return toChainReportResponse(await this.getChainReport.execute(symbol, undefined, true));
  }

  @Get('thermometer')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Volatility thermometer (index gauges + per-underlying IVP list)',
    description:
      'Returns the two CBOE volatility indices (VIX / VVIX, each with its OWN asOf taken from the ' +
      'official history file, not the collection day), the VVIX/VIX ratio, and one IVP row per ' +
      'anchored underlying. The ratio is computed SERVER-side together with its basis check: the ' +
      'two indices come from two independent files, so when their latest available dates differ ' +
      'the ratio is NOT computed and the state says basis_mismatch — leaving that to each client ' +
      'would mean re-implementing the basis discipline once per consumer. An index with no data ' +
      'is an explicit state with a null value, never 0 (a needle parked at 0 reads as "dead calm", ' +
      'which is wrong information rather than missing information). The index side does NOT ' +
      'depend on anchors: with zero anchors the list is empty but the gauges still return data. ' +
      'Excluded anchors stay in the list carrying their flag (an anchor is a collection intent; ' +
      'excluded is a trading intent), and rows whose percentile is not computable stay in too.',
  })
  @ApiResponse({ status: 200, description: 'Thermometer', type: ThermometerResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async thermometer(): Promise<ThermometerResponse> {
    return toThermometerResponse(await this.getThermometer.execute());
  }

  @Get('radar')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Radar page (keyset cursor)',
    description:
      'Anchors that are NOT excluded, ordered by distance-to-W ascending with anchor id as the unique tiebreaker; rows without quotes sort last but stay visible ("行情不可用", never 0 / never hidden). Pagination is keyset-only — there is deliberately no page/offset parameter (the sort key moves daily, so OFFSET would skip or repeat rows). Filters (effective L levels / overdue review / below W) are evaluated in SQL and combine with the cursor. Opening the first page also advances the review-anchor state machine (breach round start).',
  })
  @ApiResponse({ status: 200, description: 'Radar page', type: RadarResponse })
  @ApiResponse({
    status: 400,
    description: 'Malformed cursor or query',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async radar(@Query() query: RadarQueryDto): Promise<RadarResponse> {
    return toRadarResponse(
      await this.getRadar.execute({
        limit: query.limit,
        cursor: query.cursor ?? null,
        // 作用域与 limit / cursor 同级 —— **不进 filter** (plan D1: 它定义基础集合, 不是再筛)。
        market: query.market,
        filter: {
          lLevels: query.lLevels,
          pendingReview: query.pendingReview,
          belowW: query.belowW,
        },
      }),
    );
  }

  @Post('anchors')
  @HttpCode(201)
  @SkipThrottle(skipExcept(OPTIONSDESK_WRITE_BUCKET))
  @Throttle({ 'optionsdesk-write-account': { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create anchor',
    description:
      'Creates one anchor for a canonical ticker and returns all derived values (W / zone boundaries / L level / position cap / willing-sell). Duplicate ticker → 409 (existing anchor id in message; edit it instead).',
  })
  @ApiResponse({ status: 201, description: 'Anchor created', type: AnchorResponse })
  @ApiResponse({
    status: 400,
    description: 'V ≤ 0 or invalid payload',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 409,
    description: 'Ticker already anchored (EC-7)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  async create(@Body() body: CreateAnchorRequest): Promise<AnchorResponse> {
    const result = await this.createAnchor.execute({
      ticker: body.ticker,
      v: body.v,
      asof: toDate(body.asof),
      method: body.method,
      confidence: body.confidence,
      confidenceSource: body.confidenceSource as 'model' | 'manual' | undefined,
      excluded: body.excluded,
      excludeReason: body.excludeReason ?? null,
      nextReview: toOptionalDate(body.nextReview) ?? null,
    });
    return toAnchorWriteResponse(result);
  }

  @Get('anchors')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'List anchors',
    description:
      'Lists all anchors (ticker asc) with derived values. Excluded anchors ARE included by default and carry excludeReason (FR-005) — unlike the radar view which filters them out. Optional filters: pendingReview (next_review overdue) / excluded.',
  })
  @ApiResponse({ status: 200, description: 'Anchor list', type: AnchorListResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async list(@Query() query: ListAnchorsQuery): Promise<AnchorListResponse> {
    const views = await this.listAnchors.execute({
      pendingReview: query.pendingReview,
      excluded: query.excluded,
    });
    return toAnchorListResponse(views);
  }

  @Get('anchors/:id')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '锚 id (数字串)', example: '7' })
  @ApiOperation({
    summary: 'Get one anchor',
    description: 'Returns one anchor with the same derived-value projection as the list endpoint.',
  })
  @ApiResponse({ status: 200, description: 'Anchor', type: AnchorResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 404, description: 'Anchor not found', type: ProblemDetailResponse })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async getOne(@Param('id') id: string): Promise<AnchorResponse> {
    return toAnchorResponse(await this.getAnchor.execute(parseAnchorId(id)));
  }

  @Patch('anchors/:id')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_WRITE_BUCKET))
  @Throttle({ 'optionsdesk-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '锚 id (数字串)', example: '7' })
  @ApiOperation({
    summary: 'Update anchor (manual slots included)',
    description:
      'Partial update. Manual slots (vManual / lLevelManual / positionCapManual) accept null to undo — the slot falls back to the derived value immediately and downstream slots fall back with it (FR-032 ③). Changing confidence on a model-sourced anchor → 400.',
  })
  @ApiResponse({ status: 200, description: 'Anchor updated', type: AnchorResponse })
  @ApiResponse({
    status: 400,
    description: 'V ≤ 0 / confidence readonly (confidence_source = model)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 404, description: 'Anchor not found', type: ProblemDetailResponse })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateAnchorRequest,
  ): Promise<AnchorResponse> {
    // 显式 null (撤销 / 清空) 与 undefined (本次不碰) 必须区分 —— 用 `in` 判定, 不用 ??。
    const patch: UpdateAnchorPatch = {};
    if (body.v !== undefined) patch.v = body.v;
    if (body.asof !== undefined) patch.asof = toDate(body.asof);
    if (body.method !== undefined) patch.method = body.method;
    if (body.confidence !== undefined) patch.confidence = body.confidence;
    if (body.excluded !== undefined) patch.excluded = body.excluded;
    if ('excludeReason' in body) patch.excludeReason = body.excludeReason ?? null;
    if ('nextReview' in body) patch.nextReview = toOptionalDate(body.nextReview) ?? null;
    if ('vManual' in body) patch.vManual = body.vManual ?? null;
    if ('lLevelManual' in body) patch.lLevelManual = body.lLevelManual ?? null;
    if ('positionCapManual' in body) patch.positionCapManual = body.positionCapManual ?? null;
    return toAnchorWriteResponse(await this.updateAnchor.execute(parseAnchorId(id), patch));
  }

  @Delete('anchors/:id')
  @HttpCode(204)
  @SkipThrottle(skipExcept(OPTIONSDESK_WRITE_BUCKET))
  @Throttle({ 'optionsdesk-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '锚 id (数字串)', example: '7' })
  @ApiOperation({
    summary: 'Delete anchor',
    description:
      'Deletes the anchor row. Its change history is NOT cascaded away (the deletion itself is recorded as one more change row), so past points in time stay replayable (FR-031).',
  })
  @ApiResponse({ status: 204, description: 'Anchor deleted' })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 404, description: 'Anchor not found', type: ProblemDetailResponse })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  async remove(@Param('id') id: string): Promise<void> {
    await this.deleteAnchor.execute(parseAnchorId(id));
  }

  @Post('anchors/:id/review')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_WRITE_BUCKET))
  @Throttle({ 'optionsdesk-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '锚 id (数字串)', example: '7' })
  @ApiOperation({
    summary: 'Complete one periodic review',
    description:
      'Advances next_review and stamps last_reviewed_on = today. This is the ONLY action that clears the review-anchor red flag (FR-013) — there is deliberately no second confirmation endpoint/state. Zone badges are unaffected (EC-12).',
  })
  @ApiResponse({ status: 200, description: 'Anchor reviewed', type: AnchorResponse })
  @ApiResponse({ status: 400, description: 'Invalid payload', type: ProblemDetailResponse })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 404, description: 'Anchor not found', type: ProblemDetailResponse })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  async review(
    @Param('id') id: string,
    @Body() body: ReviewAnchorRequest,
  ): Promise<AnchorResponse> {
    const nextReview = body.nextReview === null ? null : toDate(body.nextReview);
    return toAnchorWriteResponse(await this.reviewAnchor.execute(parseAnchorId(id), nextReview));
  }

  @Post('anchors/:id/position-bucket')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_WRITE_BUCKET))
  @Throttle({ 'optionsdesk-write-account': { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '锚 id (数字串)', example: '7' })
  @ApiOperation({
    summary: 'Set the position bucket by hand (declared manual input)',
    description:
      'Persists the three-way position-bucket choice for this underlying — the third input of the ' +
      'intent matrix, which has no data source in this slice (real holdings land in a later ' +
      'milestone). The response carries the value together with an explicit SOURCE mark and the ' +
      'instant it was set: "this was typed by a human" is part of the contract, not something the ' +
      'client is expected to remember, so that when real holdings data starts flowing into the ' +
      'same field nobody has to guess which values were hand-entered. ' +
      'There is deliberately no default and no clear action: the unselected state is the INITIAL ' +
      'state (a fresh anchor has it, and the leg table reads perfectly well in it — intent simply ' +
      'reports "pending" and all three tabs stay reachable), and picking a bucket on the user\'s ' +
      'behalf in either direction would be exactly the directional assumption FR-017 forbids. ' +
      'Re-picking the same bucket still advances the set-at instant — it records the last time a ' +
      'human confirmed the level, not the last time the value changed.',
  })
  @ApiResponse({ status: 200, description: 'Position bucket set', type: PositionBucketResponse })
  @ApiResponse({
    status: 400,
    description: 'Missing / non-enum bucket (no server-side default)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 404, description: 'Anchor not found', type: ProblemDetailResponse })
  @ApiResponse({ status: 429, description: 'Rate limit (30/60s)', type: ProblemDetailResponse })
  async positionBucket(
    @Param('id') id: string,
    @Body() body: SetPositionBucketRequest,
  ): Promise<PositionBucketResponse> {
    return toPositionBucketResponse(
      await this.setPositionBucket.execute(parseAnchorId(id), body.positionBucket),
    );
  }

  @Get('anchors/:id/at')
  @HttpCode(200)
  @SkipThrottle(skipExcept(OPTIONSDESK_READ_BUCKET))
  @Throttle({ 'optionsdesk-read-account': { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '锚 id (数字串)', example: '7' })
  @ApiOperation({
    summary: 'Replay anchor values at a past point in time',
    description:
      'Replays the change history backwards to the given instant and returns V / W / L level / position cap / willing-sell as they were displayed then (SC-011). Works for deleted anchors too. Instant earlier than creation → 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'Point-in-time values',
    type: AnchorPointInTimeResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'Anchor did not exist at that instant',
    type: ProblemDetailResponse,
  })
  @ApiResponse({ status: 429, description: 'Rate limit (120/60s)', type: ProblemDetailResponse })
  async at(
    @Param('id') id: string,
    @Query() query: GetAnchorAtQuery,
  ): Promise<AnchorPointInTimeResponse> {
    const values = await this.getAnchorAt.execute(parseAnchorId(id), toDate(query.at));
    if (values === null) {
      throw new NotFoundException('ANCHOR_NOT_FOUND_AT_INSTANT');
    }
    return toAnchorPointInTimeResponse(values);
  }
}
