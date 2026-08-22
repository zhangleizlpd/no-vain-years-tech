import { Controller, Get, HttpCode, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GuestUploadAuthGuard } from '../security/guest-upload-auth.guard.js';
import { FormValidationException } from '../security/form-validation.exception.js';
import { ProblemDetailResponse } from '../security/problem-detail.response.js';
import { GetInstrumentBasicsUseCase } from './get-instrument-basics.usecase.js';
import { ListInstrumentCodesUseCase } from './list-instrument-codes.usecase.js';
import { InstrumentBasicsResponse } from './instrument-basics.response.js';
import { InstrumentCodeListResponse } from './instrument-codes.response.js';
import {
  INSTRUMENT_BASICS_MAX_CODES,
  INSTRUMENT_STATUS_FILTERS,
  QUERYABLE_MARKETS,
  parseInstrumentCodes,
  parseInstrumentStatusFilter,
  parseQueryableMarket,
  type InstrumentStatusFilter,
  type QueryableMarket,
} from './instrument-query.rules.js';

/**
 * 标的注册表的 guest 面 —— 隧道内的两个 GET, **只读不写**。
 *
 * 本控制器是 guest 通道上**第一条打到 mono 的读端点**: 此前访客经这条通道只能写
 * (投研报 / 送估值锚)。开它的动机是那两条写口都要求调方先知道 canonical `market:code`,
 * 而通道上没有任何地方能告诉他 —— `.claude/commands/anchor-import.md` 里那一大段
 * 「禁止从公司名推导 code」的护栏, 就是这个缺口的代偿。
 *
 * ## 两段式, 照 vendor 惯例
 *
 * | 端点 | 干什么 |
 * | --- | --- |
 * | `instrument-codes` | 某市场下**有哪些 code** (裸 code 全量, 不分页) |
 * | `instrument-basics` | 这批 code 的**基础信息** (≤500 一发) |
 *
 * 与富途 `get_stock_basicinfo` → `get_market_snapshot(code_list)`、Zerodha `/instruments` +
 * 逐 code 查、Alpaca `/v2/assets` 的形态同源: master list 拉一次存下来, 再按需批量取详情。
 *
 * ## 为什么另起一个 controller
 *
 * `marketdata.controller.ts` 是**类级** `@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`
 * —— 类级 guard 对每个路由生效且**无法在方法上摘掉**。体例同
 * `optionsdesk/optionsdesk-guest.controller.ts` 与 `research/research.controller.ts`。
 *
 * ## 这里只有 GET, 而且是刻意的
 *
 * **MUST NOT 实装任何 POST / PATCH / DELETE**: 通道层 (`limit_except GET`) **独立地**再拒
 * 一次 —— 两层各拒一次、不依赖对方。这是 059 那条「只放 POST」的镜像: 「服务端恰好没实现
 * 别的动词」是会被未来某个 PR 悄悄打破的状态。
 *
 * ## 路由名为什么是扁平的 `instrument-codes` / `instrument-basics`
 *
 * 同前缀下已有 `instruments/:symbol` —— 叫 `instruments/batch` 会被 `:symbol` 吃掉, 且吃法
 * 依赖两个 controller 的**注册顺序**, 是那种本地全绿、换个装配顺序就变的坏法。段数不同的
 * 扁平名从结构上避开它。
 *
 * ## 参数全部走 query string
 *
 * nginx 的 `$arg_*` **只读得到 query** ⇒ 通道层那两道闸 (`$arg_market` 市场白名单、
 * `$arg_codes` 字符集) 只有在参数位于 query 时才成立。理由与 057 研报 / 059 锚导入完全相同。
 * ⚠️ 通道与服务两处的判据是**两份独立文本, 会漂** —— 服务端那份单点在
 * `instrument-query.rules.ts`, 钉住它俩的是本模块单测 + IT 的三市场断言 +
 * `verify-guards.sh` 闸 9 的反例。
 *
 * ## 无 server 侧 throttler 桶 (同 research / optionsdesk guest 面, 刻意)
 *
 * guest-proxy 与 app 同机、其 `proxy_set_header` 组不带 XFF ⇒ server 侧只能按 `req.ip` 计而
 * 它恒为 `127.0.0.1`, 一个桶会把所有访客焊在一起。限频由通道层 nginx 的 `limit_req_zone`
 * (按 `$guest_name` 分, 天然 per-guest) 承担, 两个口各自独立的 zone。
 */
@ApiTags('marketdata')
@Controller('v1/marketdata')
export class MarketdataGuestController {
  constructor(
    private readonly listCodes: ListInstrumentCodesUseCase,
    private readonly getBasics: GetInstrumentBasicsUseCase,
  ) {}

  @Get('instrument-codes')
  @HttpCode(200)
  @UseGuards(GuestUploadAuthGuard)
  @ApiBearerAuth('guest-upload-token')
  @ApiOperation({
    summary: 'Enumerate all instrument codes in a market (guest channel)',
    description:
      'Returns every registered bare code for one market, ascending, in a single unpaginated response — the master-list shape (Futu get_stock_basicinfo / Alpaca /v2/assets / Zerodha /instruments): fetch once, cache, then batch-resolve details. Codes carry NO market prefix; pair them with the `market` param on instrument-basics. Defaults to status=active because the payload has no status field to disambiguate delisted rows with. Largest market (us) measured 19622 codes = 139,856 bytes raw / 58,553 bytes on the wire once gzipped (2026-08-22, through the guest channel) — the count drifts with universe sync, and the channel only gzips when the caller sends Accept-Encoding (curl --compressed).',
  })
  @ApiQuery({
    name: 'market',
    required: true,
    enum: QUERYABLE_MARKETS,
    example: 'us',
    description: '市场段 (小写; 大写 / 未知市场一律 400, 不归一)',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    example: 'stock',
    description: '标的类型过滤 (stock / etf / index / bond)。缺省不过滤',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: INSTRUMENT_STATUS_FILTERS,
    description: '在市状态过滤。**缺省 active** —— 响应里没有 status 字段可区分已退市标的',
  })
  @ApiResponse({ status: 200, description: 'Codes (ascending)', type: InstrumentCodeListResponse })
  @ApiResponse({
    status: 400,
    description: 'Missing / invalid market / type / status — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: '通道凭证缺失或不符 (两者对外不可区分)',
    type: ProblemDetailResponse,
  })
  async instrumentCodes(
    @Query('market') marketRaw?: string,
    @Query('type') type?: string,
    @Query('status') statusRaw?: string,
  ): Promise<InstrumentCodeListResponse> {
    return this.listCodes.execute({
      market: this.parseMarket(marketRaw),
      status: this.parseStatus(statusRaw),
      type: type === undefined || type === '' ? undefined : type,
    });
  }

  @Get('instrument-basics')
  @HttpCode(200)
  @UseGuards(GuestUploadAuthGuard)
  @ApiBearerAuth('guest-upload-token')
  @ApiOperation({
    summary: 'Batch instrument basics by code (guest channel)',
    description: `Resolves up to ${INSTRUMENT_BASICS_MAX_CODES} bare codes within one market to name / type / currency / status / listing dates. Codes are matched EXACTLY (case-sensitive, never normalized) — use the strings instrument-codes returned verbatim. Unmatched codes come back in \`missing[]\` rather than as an error, which is the only way to tell "no such code" apart from "found, but the field is empty": listingStatus and listDate are null for EVERY us instrument (only the Lixinger source supplies them) and null there does NOT mean delisted.`,
  })
  @ApiQuery({
    name: 'market',
    required: true,
    enum: QUERYABLE_MARKETS,
    example: 'us',
    description: '市场段 (小写)。一发只查一个市场 —— 跨市场混批在结构上不可能',
  })
  @ApiQuery({
    name: 'codes',
    required: true,
    example: 'AOS,PEP,BRK.B',
    description: `逗号分隔的裸 code, ≤${INSTRUMENT_BASICS_MAX_CODES} 个。冒号前缀 / 百分号编码一律 400`,
  })
  @ApiResponse({ status: 200, description: 'Basics + missing', type: InstrumentBasicsResponse })
  @ApiResponse({
    status: 400,
    description:
      'Invalid market / empty codes / illegal char / over the batch cap — FORM_VALIDATION',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: '通道凭证缺失或不符 (两者对外不可区分)',
    type: ProblemDetailResponse,
  })
  async instrumentBasics(
    @Query('market') marketRaw?: string,
    @Query('codes') codesRaw?: string,
  ): Promise<InstrumentBasicsResponse> {
    const market = this.parseMarket(marketRaw);
    const parsed = parseInstrumentCodes(codesRaw);
    if (!parsed.ok) {
      throw new FormValidationException([{ field: 'codes', messages: [parsed.message] }]);
    }
    return this.getBasics.execute({ market, codes: parsed.codes });
  }

  /** rules 的判定结果 → 400 FORM_VALIDATION (与既有 marketdata 读端点同一错误码契约)。 */
  private parseMarket(raw: string | undefined): QueryableMarket {
    const parsed = parseQueryableMarket(raw);
    if (!parsed.ok) {
      throw new FormValidationException([{ field: 'market', messages: [parsed.message] }]);
    }
    return parsed.market;
  }

  private parseStatus(raw: string | undefined): InstrumentStatusFilter {
    const parsed = parseInstrumentStatusFilter(raw);
    if (!parsed.ok) {
      throw new FormValidationException([{ field: 'status', messages: [parsed.message] }]);
    }
    return parsed.status;
  }
}
