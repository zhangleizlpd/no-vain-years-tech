import { Controller, Get, HttpCode, Param, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  GetAnchorColdStartRunsUseCase,
  COLD_START_RUN_QUERY_CAP,
} from './get-anchor-cold-start-runs.usecase.js';
import { AnchorColdStartRunListResponse } from './anchor-cold-start-run.response.js';
import { JwtAuthGuard } from '../account/jwt-auth.guard.js';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard.js';
import { ProblemDetailResponse } from '../security/problem-detail.response.js';
import { FormValidationException } from '../security/form-validation.exception.js';
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
  MKTDATA_SEARCH_BUCKET,
  MKTDATA_QUOTE_BUCKET,
  MKTDATA_DETAIL_BUCKET,
  MKTDATA_BARS_BUCKET,
  MKTDATA_COLDSTART_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets.js';
import { ADJUSTS, BAR_PERIODS, type Adjust, type BarPeriod } from './marketdata.types.js';
import { GetInstrumentDetailUseCase } from './get-instrument-detail.usecase.js';
import { GetInstrumentBarsUseCase } from './get-instrument-bars.usecase.js';
import { GetQuotesUseCase } from './get-quotes.usecase.js';
import { SearchInstrumentsUseCase } from './search-instruments.usecase.js';
import { InstrumentDetailResponse } from './instrument-detail.response.js';
import { DailyBarListResponse } from './daily-bar-list.response.js';
import { QuoteListResponse } from './quote-list.response.js';
import { InstrumentSearchResponse } from './instrument-search.response.js';

/** 既有桶 (001-012) —— marketdata 读端点 @SkipThrottle 全部, 防被既有更紧桶 (共享 key) 误限流。 */
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
  ...WATCHLIST_ALL,
  ...ALERT_ALL,
  ...CHAT_ALL,
  ...IDEATION_ALL,
  ...OPTIONSDESK_ALL,
  ...PORTFOLIO_HOLDINGS_ALL,
};

/**
 * 某 marketdata EP 的 @SkipThrottle 集 = 既有全部桶 + marketdata 同组「除己」其余桶 (own 由
 * @Throttle 单独启用)。@Throttle 不会反 un-skip, 故 own 必须不在 skip 集内 (沿 broker 逐 EP 范式)。
 */
function skipExcept(own: Record<string, boolean>): Record<string, boolean> {
  const skip: Record<string, boolean> = { ...EXISTING_BUCKETS, ...MARKETDATA_ALL };
  for (const key of Object.keys(own)) delete skip[key];
  return skip;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/v1/marketdata/search                       (EP1, FR-S04 模糊搜索: 东财主 + 本地 pg_trgm
 *                                                      备, FallbackChain; 归一化 canonical 候选)
 * GET /api/v1/marketdata/quote                         (EP2, FR-S07 批量报价: EOD-backed)
 * GET /api/v1/marketdata/instruments/{symbol}          (EP3, FR-S05 详情聚合: 报价 header + 估值/
 *                                                      分位 + 财务 + 公司行动 + 身份 + 52 周高低)
 * GET /api/v1/marketdata/instruments/{symbol}/bars     (EP4, FR-S06 K线: adjust 复权 + period 聚合)
 *
 * authed (JwtAuthGuard: Bearer + ACTIVE 兜底 → 失败统一 401 反枚举, 与既有读端点一致路径)。
 * symbol = canonical `market:code` (如 `cn:600519`)。读 PG 物化事实 / 端口, 详情/报价/K线不在
 * 请求路径打 vendor (搜索 EP1 主源东财在请求路径外呼, 失败平移本地)。限流 per-account
 * (AccountIdThrottlerGuard): search 60/60s · quote 120/60s · detail 60/60s · bars 60/60s。
 */
@ApiTags('marketdata')
@Controller('v1/marketdata')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class MarketdataController {
  constructor(
    private readonly detailUseCase: GetInstrumentDetailUseCase,
    private readonly barsUseCase: GetInstrumentBarsUseCase,
    private readonly quotesUseCase: GetQuotesUseCase,
    private readonly searchUseCase: SearchInstrumentsUseCase,
    private readonly coldStartRunsUseCase: GetAnchorColdStartRunsUseCase,
  ) {}

  /**
   * 072 冷启动结局 —— 采纳后盯队列用。R1: marketdata 读自己的 `anchor_cold_start_run`。
   *
   * 🚨 **查不到的 id 就是不返回**, 且这有语义:「还没出行」= 排队中或正在跑 (十档结局全是终态)。
   * 呈现层据此算「N/M 已出结局」——**MUST NOT** 期待服务端补占位, 也 MUST NOT 把缺席当失败。
   */
  @Get('anchor-cold-start')
  @HttpCode(200)
  @SkipThrottle(skipExcept(MKTDATA_COLDSTART_BUCKET))
  @Throttle({ 'mktdata-coldstart-account': { limit: 180, ttl: 60_000 } })
  @ApiQuery({
    name: 'anchorIds',
    required: true,
    description: `逗号分隔的锚 id;单次上限 ${COLD_START_RUN_QUERY_CAP}`,
    example: '42,43',
  })
  @ApiOperation({ summary: '批量查锚的冷启动结局' })
  @ApiResponse({ status: 200, type: AnchorColdStartRunListResponse })
  @ApiResponse({ status: 401, type: ProblemDetailResponse })
  async anchorColdStart(
    @Query('anchorIds') anchorIds: string,
  ): Promise<AnchorColdStartRunListResponse> {
    const ids = (anchorIds ?? '')
      .split(',')
      .map((raw) => raw.trim())
      .filter((raw) => raw !== '');
    if (ids.some((raw) => !/^\d+$/.test(raw))) {
      throw new FormValidationException([
        { field: 'anchorIds', messages: ['must be comma-separated numeric anchor ids'] },
      ]);
    }
    const views = await this.coldStartRunsUseCase.execute(ids.map((raw) => BigInt(raw)));
    return {
      items: views.map((view) => ({
        anchorId: view.anchorId.toString(),
        ticker: view.ticker,
        outcome: view.outcome,
        reason: view.reason,
        targetSession: view.targetSession === null ? null : dateOnly(view.targetSession),
        lastRunAt: view.lastRunAt.toISOString(),
        needsAttention: view.needsAttention,
      })),
    };
  }

  @Get('search')
  @HttpCode(200)
  @SkipThrottle(skipExcept(MKTDATA_SEARCH_BUCKET))
  @Throttle({ 'mktdata-search-account': { limit: 60, ttl: 60_000 } })
  @ApiQuery({
    name: 'q',
    required: true,
    description: '查询串 (名 / 拼音 / 代码)',
    example: '茅台',
  })
  @ApiOperation({
    summary: 'Fuzzy instrument search',
    description:
      'Searches instruments by name / pinyin / code. Primary 东财 searchapi (A/HK/US); on 503/timeout/quota the FallbackChain shifts to local pg_trgm over the seeded Instrument registry. Candidates are normalized to canonical market:code + name + type. No match → empty items (200, never 5xx). Missing / empty q → 400.',
  })
  @ApiResponse({
    status: 200,
    description: 'Normalized candidates (empty when no match)',
    type: InstrumentSearchResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Missing / empty q — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing / invalid / expired token, or account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (60/60s per account)',
    type: ProblemDetailResponse,
  })
  async search(@Query('q') q?: string): Promise<InstrumentSearchResponse> {
    const query = (q ?? '').trim();
    if (query.length === 0) {
      throw new FormValidationException([
        { field: 'q', messages: ['must be a non-empty query string'] },
      ]);
    }
    const items = await this.searchUseCase.execute(query);
    return { items };
  }

  @Get('quote')
  @HttpCode(200)
  @SkipThrottle(skipExcept(MKTDATA_QUOTE_BUCKET))
  @Throttle({ 'mktdata-quote-account': { limit: 120, ttl: 60_000 } })
  @ApiQuery({
    name: 'symbols',
    required: true,
    description: '逗号分隔的 canonical market:code 列表',
    example: 'cn:600519,cn:000001',
  })
  @ApiOperation({
    summary: 'Batch latest quotes (EOD-backed)',
    description:
      'Returns latest quotes for a comma-separated symbols list. V1 EOD-backed (priceKind=eod_close), change vs prevClose, asOf marks freshness. Unknown / no-data symbols return hasData:false in place (never poisoning siblings, never 5xx). Read path: Redis hot snapshot → PG. Missing / empty symbols → 400.',
  })
  @ApiResponse({
    status: 200,
    description: 'Quotes (input order, dups preserved)',
    type: QuoteListResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Missing / empty symbols — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing / invalid / expired token, or account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (120/60s per account)',
    type: ProblemDetailResponse,
  })
  async quote(@Query('symbols') symbolsRaw?: string): Promise<QuoteListResponse> {
    const symbols = (symbolsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (symbols.length === 0) {
      throw new FormValidationException([
        { field: 'symbols', messages: ['must be a non-empty comma-separated symbol list'] },
      ]);
    }
    const items = await this.quotesUseCase.execute(symbols);
    return { items };
  }

  @Get('instruments/:symbol')
  @HttpCode(200)
  @SkipThrottle(skipExcept(MKTDATA_DETAIL_BUCKET))
  @Throttle({ 'mktdata-detail-account': { limit: 60, ttl: 60_000 } })
  @ApiParam({ name: 'symbol', description: 'canonical market:code', example: 'cn:600519' })
  @ApiOperation({
    summary: 'Instrument detail (aggregated)',
    description:
      'Aggregates the latest materialized facts for a symbol: quote header (latest / change / changePct / prevClose, EOD-backed) + 52-week high/low + valuation & percentiles + financials + recent corporate actions + identity. Missing dimensions are null (never an error). Decimal values are strings. Unknown symbol → 404.',
  })
  @ApiResponse({ status: 200, description: 'Detail aggregated', type: InstrumentDetailResponse })
  @ApiResponse({
    status: 401,
    description: 'Missing / invalid / expired token, or account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'INSTRUMENT_NOT_FOUND — unknown symbol',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (per account)',
    type: ProblemDetailResponse,
  })
  async detail(@Param('symbol') symbol: string): Promise<InstrumentDetailResponse> {
    return this.detailUseCase.execute(symbol);
  }

  @Get('instruments/:symbol/bars')
  @HttpCode(200)
  @SkipThrottle(skipExcept(MKTDATA_BARS_BUCKET))
  @Throttle({ 'mktdata-bars-account': { limit: 60, ttl: 60_000 } })
  @ApiParam({ name: 'symbol', description: 'canonical market:code', example: 'cn:600519' })
  @ApiQuery({ name: 'adjust', required: false, enum: ADJUSTS, description: '复权口径 (默认 none)' })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: BAR_PERIODS,
    description: '聚合周期 (默认 day)',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: '起始日 YYYY-MM-DD (含)',
    example: '2026-01-01',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: '结束日 YYYY-MM-DD (含)',
    example: '2026-06-30',
  })
  @ApiOperation({
    summary: 'Instrument K-line bars',
    description:
      'Daily bars for a symbol filtered by adjust (none|forward|backward) and aggregated to period (day|week|month|quarter|year) over an optional [from, to] range. OHLC + volume/amount are strings. Empty range → empty items (200). Invalid adjust/period/date → 400. Unknown symbol → 404.',
  })
  @ApiResponse({ status: 200, description: 'Bars (tradeDate asc)', type: DailyBarListResponse })
  @ApiResponse({
    status: 400,
    description: 'Invalid adjust / period / date format — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing / invalid / expired token, or account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'INSTRUMENT_NOT_FOUND — unknown symbol',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (per account)',
    type: ProblemDetailResponse,
  })
  async bars(
    @Param('symbol') symbol: string,
    @Query('adjust') adjustRaw?: string,
    @Query('period') periodRaw?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<DailyBarListResponse> {
    const adjust = parseEnum<Adjust>('adjust', adjustRaw, ADJUSTS, 'none');
    const period = parseEnum<BarPeriod>('period', periodRaw, BAR_PERIODS, 'day');
    assertDate('from', from);
    assertDate('to', to);
    return this.barsUseCase.execute({ symbol, adjust, period, from, to });
  }
}

/** 可选枚举 query 解析: 缺省取 fallback; 非枚举值 → 400 FORM_VALIDATION (与既有错误码契约一致)。 */
function parseEnum<T extends string>(
  field: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined || raw === '') return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new FormValidationException([
    { field, messages: [`must be one of: ${allowed.join(', ')}`] },
  ]);
}

function assertDate(field: string, raw: string | undefined): void {
  if (raw !== undefined && raw !== '' && !DATE_RE.test(raw)) {
    throw new FormValidationException([{ field, messages: ['must be YYYY-MM-DD'] }]);
  }
}

/** `@db.Date` 列 → `YYYY-MM-DD`。🚨 MUST NOT 用 `.toISOString()`(会带 T00:00:00.000Z 并在
 *  非 UTC 渲染时差一天) —— 同 optionsdesk/date-only.ts 的判据。 */
function dateOnly(at: Date): string {
  return at.toISOString().slice(0, 10);
}
