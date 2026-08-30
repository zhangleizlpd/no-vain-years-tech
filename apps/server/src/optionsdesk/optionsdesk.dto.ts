import { BadRequestException } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Prisma } from '../generated/prisma/client';
import { ANCHOR_ZONES, L_LEVELS, type LLevel } from './anchor.rules';
import { ANCHOR_MANUAL_SLOTS } from './anchor-cascade';
import { ANCHOR_SUBMISSION_STATUSES, IMPORTABLE_MARKETS } from './anchor-import.rules';
import type { ImportAnchorFromModelResult } from './import-anchor-from-model.usecase';
import { FRESHNESS_TIERS, freshnessTier } from '../marketdata/freshness-tier';
import { PRICE_KINDS, type PriceKind } from '../marketdata/marketdata.types';
import { REALTIME_CHAIN_DEGRADE_KINDS } from './leg-retrieval.port';
import { ANCHOR_CONFIDENCE_SOURCES } from './create-anchor.usecase';
import type { AnchorWriteResult } from './create-anchor.usecase';
import { toAnchorView, type AnchorView } from './list-anchors.usecase';
import { RADAR_EMPTY_STATES, type RadarPage } from './get-radar.usecase';
import {
  UNDERLYING_IV_STATES,
  type UnderlyingDetail,
  type UnderlyingIvReadout,
} from './get-underlying-detail.usecase';
import {
  US_INDEX_STATES,
  VVIX_VIX_RATIO_STATES,
  type Thermometer,
  type ThermometerUnderlyingRow,
  type UsIndexReadout,
  type VvixVixRatio,
} from './get-thermometer.usecase';
import { RADAR_PAGE_SIZE_DEFAULT, RADAR_PAGE_SIZE_MAX } from './radar-cursor';
import { EARNINGS_MARKS } from './earnings-mark.rules';
import { LEG_TABLE_STATES, type LegTableView } from './get-legs.usecase';
import { CHAIN_REPORT_CELL_STATES } from './chain-report.rules';
import {
  CHAIN_REPORT_STATES,
  type ChainReportGrid,
  type ChainReportView,
} from './get-chain-report.usecase';
import {
  LEG_INTENTS,
  POSITION_BUCKETS,
  POSITION_BUCKET_SOURCES,
  RENT_DEPTHS,
  type PositionBucket,
} from './intent-matrix.rules';
import type { PositionBucketWriteResult } from './set-position-bucket.usecase';
import { type ActivityMark } from './leg-derive.rules';
import { LEG_BASES, LEG_TIERS } from './leg-tier.rules';
import { LEG_TABS, type LegTab } from './leg-tab.rules';
import {
  CRITERION_STATES,
  RETRIEVAL_CRITERION_KEYS,
  type PerspectiveCriteria,
  type RetrievalCriteria,
  type RetrievalOverride,
} from './leg-recall.rules';
import { BASIS_BY_TAB } from './leg-rank.rules';
import type { PointInTimeAnchorValues } from './anchor-history';

/**
 * 045 optionsdesk REST 契约面 (FR-001 / FR-004 / FR-005 / FR-009, plan D6)。
 *
 * 🚨 **`@nestjs/swagger` 装饰器 = API 唯一 SoT** (code-first, 不另写 openapi 文件;
 * `apps/server/openapi.json` 由 `nx run server:export-openapi` 从本文件的装饰器导出)。
 *
 * 两条跨边界纪律:
 * 1. **金融数值一律 string** (015 起体例): `Decimal(18,4)` / `(6,4)` / `(4,2)` 过 JSON 变
 *    Float 会丢精度, 而 W / 四区间 / 距 W% 全是它的下游。id (BigInt) 同理转数字串。
 * 2. **nullable 标量的 `@ApiProperty` MUST 显式 `type:'string'`** —— 否则 orval 对
 *    `string | null` 联合误生成 `{[k]:unknown} | null` (objectmap), mobile 侧类型直接不可用
 *    (012 PR1 实证; lefthook `api-property-nullable-check` 硬扫)。
 *
 * 日期口径: `@db.Date` 列 (asof / next_review / last_reviewed_on / last_close_date /
 * breach_started_on) 出参为 `YYYY-MM-DD`, `@db.Timestamptz` 列为完整 ISO 串 —— 两者语义不同
 * (日历日 vs 时刻), 混成一种会让「数据截至 X · 收盘」的 asOf 呈现出错。
 */

/** `Decimal(18,4)` / `(6,4)` → 定标 string。null 透传 (行情不可用等降级态, 禁伪造 0)。 */
function decimal4(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(4);
}

/** `Decimal(12,8)` (IV / HV 列) → 定标 string。定标取**列自身的 scale**, 不二次舍入。 */
function decimal8(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(8);
}

/** `@db.Date` → `YYYY-MM-DD` (UTC 日界, 与写侧 `toUtcDateOnly` 同口径)。 */
function dateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * **区块级报价时点 → 契约面的串, 粒度即档位** (064 `FR-010` / `FR-014`)。
 *
 * | 档位 | 出什么 | 取自 |
 * | --- | --- | --- |
 * | `realtime` | ISO **时刻** (含秒) | 本批的我方采集时刻 |
 * | `eod_close` | **交易日** `YYYY-MM-DD` | 快照归属的那一场 (`sessionDate`) |
 *
 * 🚨 这是本文件头那条纪律 (「日历日 vs 时刻, 混成一种会让『数据截至 X · 收盘』的 asOf 呈现
 * 出错」) 的**第二个实例**, 与 061 `resolveAnchorSpot().asOf` 同一套口径 —— 🚫 MUST NOT 另立
 * 一套。混成一种不会红任何一处: 收盘档带上时分秒会被读成此刻的盘口 (而它是昨天 20:31 采的),
 * 实时档只给日期则把「几点几分的价」这件唯一要紧的事抹掉。
 *
 * 🚨 **收盘档取 `sessionDate` 而不是把采集时刻按 UTC 截一刀**: 美股收盘采集常落在次日 UTC,
 * 截出来的日期会比真交易日晚一天, 而它**看着完全正常** (per `cross-timezone-date-semantics.md`)。
 */
function quoteAsOfText(
  priceKind: PriceKind,
  sessionDate: Date | null,
  quoteAsOf: Date | null,
): string | null {
  if (priceKind === 'realtime') return quoteAsOf === null ? null : quoteAsOf.toISOString();
  return dateOnly(sessionDate);
}

// ─────────────────────────────────────────────────────────────────────────────
// 请求
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/v1/optionsdesk/anchors —— 建锚 (FR-001 字段集对齐策略输入契约)。 */
export class CreateAnchorRequest {
  @ApiProperty({
    description: 'canonical `market:code` (取自 GET /marketdata/search, FR-002 禁自由文本)',
    example: 'us:AOS',
    maxLength: 32,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  ticker!: string;

  @ApiProperty({ description: '估值 V (数值串; V ≤ 0 拒绝, EC-3)', example: '50.0000' })
  @IsNumberString()
  v!: string;

  @ApiProperty({ description: '估值 as-of 日 (YYYY-MM-DD)', example: '2026-06-30' })
  @IsDateString()
  asof!: string;

  @ApiProperty({ description: '估值方法名 (策略 SoT 词表)', example: 'dcf', maxLength: 32 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  method!: string;

  @ApiProperty({ description: '置信度 (10 分制数值串)', example: '8.00' })
  @IsNumberString()
  confidence!: string;

  @ApiPropertyOptional({
    description: 'confidence 来源门控 (缺省 manual = 手工建锚, 可改; model ⇒ 只读)',
    enum: [...ANCHOR_CONFIDENCE_SOURCES],
    example: 'manual',
  })
  @IsOptional()
  @IsIn([...ANCHOR_CONFIDENCE_SOURCES])
  confidenceSource?: string;

  @ApiPropertyOptional({ description: '交易意愿排除 (不参与采集闸, FR-028)', example: false })
  @IsOptional()
  @IsBoolean()
  excluded?: boolean;

  @ApiPropertyOptional({
    description: '排除原因 (锚列表照常展示, FR-005)',
    type: 'string',
    nullable: true,
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  excludeReason?: string | null;

  @ApiPropertyOptional({
    description: '下次复审日 (YYYY-MM-DD); 早于 asof 允许保存但标「建锚即逾期」(EC-10)',
    type: 'string',
    nullable: true,
    example: '2026-09-30',
  })
  @IsOptional()
  @IsDateString()
  nextReview?: string | null;
}

/** PATCH /api/v1/optionsdesk/anchors/{id} —— 改锚; 人工位传 `null` = 撤销并回落 (FR-032 ③)。 */
export class UpdateAnchorRequest {
  @ApiPropertyOptional({ description: '估值 V (数值串)', example: '52.0000' })
  @IsOptional()
  @IsNumberString()
  v?: string;

  @ApiPropertyOptional({ description: '估值 as-of 日 (YYYY-MM-DD)', example: '2026-07-31' })
  @IsOptional()
  @IsDateString()
  asof?: string;

  @ApiPropertyOptional({ description: '估值方法名', example: 'dcf', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  method?: string;

  @ApiPropertyOptional({
    description: '置信度 (仅 confidence_source = manual 可改; model 来源写侧拒 400)',
    example: '7.50',
  })
  @IsOptional()
  @IsNumberString()
  confidence?: string;

  @ApiPropertyOptional({ description: '交易意愿排除', example: true })
  @IsOptional()
  @IsBoolean()
  excluded?: boolean;

  @ApiPropertyOptional({
    description: '排除原因 (null = 清空)',
    type: 'string',
    nullable: true,
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  excludeReason?: string | null;

  @ApiPropertyOptional({
    description: '下次复审日 (YYYY-MM-DD; null = 清空)',
    type: 'string',
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  nextReview?: string | null;

  @ApiPropertyOptional({
    description: 'V 人工位 (null = 撤销 → 立即回落为模型值)',
    type: 'string',
    nullable: true,
  })
  @IsOptional()
  @IsNumberString()
  vManual?: string | null;

  // 🚨 `nullable: true` 不能省：`null` 就是「撤销人工位」的语义，与另两处人工位同构。
  // 漏了它 ⇒ orval 把 lLevelManual 生成为**非 nullable** enum，客户端撤销路径只能靠收窄
  // cast 绕过类型（045 T022 曾如此，T026 契约冒烟抓出后修）。
  @ApiPropertyOptional({
    description: 'L 层人工位 (null = 撤销; 置值会连带冲掉单票上限人工值, EC-6)',
    enum: [...L_LEVELS],
    nullable: true,
  })
  @IsOptional()
  @IsIn([...L_LEVELS])
  lLevelManual?: LLevel | null;

  @ApiPropertyOptional({
    description: '单票上限人工位 (小数比例, 0.0500 = 5%; null = 撤销)',
    type: 'string',
    nullable: true,
    example: '0.0500',
  })
  @IsOptional()
  @IsNumberString()
  positionCapManual?: string | null;
}

/** POST /api/v1/optionsdesk/anchors/{id}/review —— 完成一次定期复审 (FR-007)。 */
export class ReviewAnchorRequest {
  @ApiProperty({
    description:
      '复审结果推进后的下次复审日 (YYYY-MM-DD); 显式 null = 本次不再排下次复审。' +
      '**必须显式给出** —— 策略 SoT 未定义复审周期档, 服务端不自造默认值 (FR-030)。',
    type: 'string',
    nullable: true,
    example: '2026-11-02',
  })
  @IsDefined()
  @ValidateIf((o: ReviewAnchorRequest) => o.nextReview !== null)
  @IsDateString()
  nextReview!: string | null;
}

/**
 * POST /api/v1/optionsdesk/anchors/{id}/position-bucket —— 手选仓位水位档 (FR-017)。
 *
 * 🚫 **无默认值、不接受 null**: 缺字段 / 非枚举值一律 400 —— 服务端替人挑一档就是 FR-017 明禁的
 * 「替人做方向性假设」。未选态 (`null`) 是**初始态**, 由锚表列的无默认值表达, 不经本端点。
 */
export class SetPositionBucketRequest {
  @ApiProperty({
    description:
      '三选一水位档 (`<1/3` · `1/3–2/3` · `≥2/3`)。**必填** —— 服务端不自造默认档 (FR-017)',
    enum: [...POSITION_BUCKETS],
    example: 'gte_two_thirds',
  })
  @IsIn([...POSITION_BUCKETS])
  positionBucket!: PositionBucket;
}

/** GET /api/v1/optionsdesk/anchors 查询串 (FR-004 待复审 / FR-005 已排除)。 */
export class ListAnchorsQuery {
  @ApiPropertyOptional({
    description: 'true = 只看 next_review 逾期的锚 (待复审清单)',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  pendingReview?: boolean;

  @ApiPropertyOptional({
    description:
      'true = 只看已排除; false = 只看未排除; **省略 = 全都要** ' +
      '(锚列表默认显示 excluded 并带 exclude_reason, FR-005)',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  excluded?: boolean;
}

/**
 * GET /api/v1/optionsdesk/radar 查询串 (FR-010 / FR-033 / FR-034)。
 *
 * 🚨 **无 `page` / `offset` 字段**: 分页一律 keyset 游标 —— 排序键距 W% 每日变动, 页码式分页
 * 在翻页期间会漏行 (FR-033), 而前端也 MUST NOT 出现页码控件 (FR-010, 下拉增量加载)。
 */
export class RadarQueryDto {
  @ApiPropertyOptional({
    description: `一页条数 (缺省 ${RADAR_PAGE_SIZE_DEFAULT}, 上限 ${RADAR_PAGE_SIZE_MAX} 超出即钳)`,
    example: 20,
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description: '上一页返回的 nextCursor (不透明 token, 客户端 MUST NOT 解读); 省略 = 首页',
    type: 'string',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  cursor?: string | null;

  @ApiPropertyOptional({
    description:
      '生效 L 层多选, 逗号分隔 (如 `L1,L3`)。省略 / 空 = 不筛 —— 某档无锚**不是**校验错误 (FR-008)',
    example: 'L1,L2',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : value,
  )
  @IsIn([...L_LEVELS], { each: true })
  lLevels?: LLevel[];

  @ApiPropertyOptional({ description: 'true = 只看 next_review 逾期的锚', example: true })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  pendingReview?: boolean;

  @ApiPropertyOptional({
    description: 'true = 只看已跌破 W 的锚 (行情不可用的行不计入)',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  belowW?: boolean;

  @ApiPropertyOptional({
    description:
      `市场作用域 (${IMPORTABLE_MARKETS.join(' / ')})。省略 = 全部市场。` +
      '🚨 **它是作用域不是筛选项** —— 与 limit / cursor 同级地定义「问的是哪一批行」, ' +
      '同时进分页与空态计数; 而 lLevels / pendingReview / belowW 是在基础集合上再筛。' +
      '🚨 **带 cursor 时必填**: 不声明作用域就不许翻页 (跨市场续页的语义没有定义)。',
    enum: [...IMPORTABLE_MARKETS],
    example: 'us',
  })
  // 🚨 两个条件的**或**, 缺一不可:
  //   · `market !== undefined` ⇒ 给了就必须在白名单内 (挡 `?market=jp`), 不管带不带 cursor;
  //   · `cursor != null`       ⇒ 带游标却没给 market 时, `@IsIn(undefined)` 失败 ⇒ 400。
  // 🚫 MUST NOT 写成 `@IsOptional()` + `@IsIn()`: 那样带 cursor 缺 market 会静默放过,
  //    而这正是 D6 撤销「market 编进游标」后唯一的替代保护。
  // 🚨 本条挡的是**入参**, 与 `ck_anchor_market` 挡**存量**是两件事, 不可互相替代。
  @ValidateIf((o: RadarQueryDto) => o.market !== undefined || o.cursor != null)
  @IsIn([...IMPORTABLE_MARKETS])
  market?: string;
}

/**
 * GET /api/v1/optionsdesk/underlyings/{symbol}/legs 查询串 —— **视角 + 检索条件的用户覆盖**
 * (052 FR-012 / 053 FR-001, plan D-CRIT-1 / D-API-1)。除 `perspective` 外全部省略 = 首屏 /
 * 「复位」, 该视角走系统默认值。
 *
 * 🚨 **053 起 `perspective` 必填, 且语义升级** —— 从「覆盖作用于谁」升为「**决定本次返回哪个
 * 视角**」。052 定的是「给了条件没给视角 → 400」, 本片扩到「任何请求都必须指明视角」。
 *
 * 🚨 **系统默认值不进请求** (FR-011): 它们依赖 spot 与行权价网格, 由服务端解出后随响应下发。
 * 让客户端回传默认值就等于让它先算一份 —— 那正是 ADR-0064 不变量 ③ 禁的「同一判据两处各算」。
 *
 * 🚨 **缺参 = 未覆盖, 空串 = 覆盖为「不限」** —— 两者三态不同 (`default` vs `widened`):
 * 「用户把上界拉到不限」与「用户没动过这个维度」在计数上是两回事。
 *
 * 🚨 **覆盖只落在 `perspective` 那一个视角上** (2026-08-13 定): 一次请求返三视角
 * (047 FR-005) 而 FR-015 要每视角各自持有条件状态 —— 通吃三视角会让用户在收租设的上界同时
 * 收窄建仓, 而建仓控件仍显示自己的默认值, 控件与数据不匹配且在界面上无法解释。
 */
export class LegRetrievalQuery {
  @ApiProperty({
    description:
      '🚨 **必填** (053 FR-001): 本次要**返回哪个视角**的腿 —— 每个视角各自独立取数, 一次请求只 ' +
      '作答一个。缺参或取值不在三值内 → **400**; 服务端 MUST NOT 替你挑一个默认视角 (那时腿数、' +
      '名次、档位全都正常, 只是答的不是问的那个视角)。它同时决定检索条件覆盖作用于谁 (052 FR-015)',
    enum: [...LEG_TABS],
    example: 'rent',
  })
  @IsIn([...LEG_TABS])
  perspective!: string;

  @ApiPropertyOptional({
    description: '行权价上界 (闭区间); 空串 = 覆盖为不限',
    type: 'string',
    example: '138.0000',
  })
  @IsOptional()
  @IsString()
  strikeMax?: string;

  @ApiPropertyOptional({
    description: '行权价下界 (闭区间); 空串 = 覆盖为不限',
    type: 'string',
    example: '100.0000',
  })
  @IsOptional()
  @IsString()
  strikeMin?: string;

  @ApiPropertyOptional({
    description:
      'DTE 段下界 (闭区间)。🚨 **与 dteMax MUST 成对出现** —— DTE 段是**一个**维度、值是闭区间, ' +
      '半个区间不是合法维度值; 静默补另一端要么意外放宽 (补不限), 要么要在这里重算默认值 —— ' +
      '而那需要 spot, 正是 FR-011 禁的第二处计算。只给一端 → 400',
    example: 30,
  })
  @IsOptional()
  @IsString()
  dteMin?: string;

  @ApiPropertyOptional({
    description: 'DTE 段上界 (闭区间)。与 dteMin 成对, 见其说明',
    example: 365,
  })
  @IsOptional()
  @IsString()
  dteMax?: string;

  @ApiPropertyOptional({
    description: '权利金下限; 空串 = 覆盖为不限',
    type: 'string',
    example: '0.2384',
  })
  @IsOptional()
  @IsString()
  premiumMin?: string;

  @ApiPropertyOptional({
    description:
      '未平仓 (OI) 下限 (张)。🚨 **与 volMin MUST 成对出现** —— 活性是**一个**维度、值是一对数 ' +
      '(`OI ≥ oiMin` **或** `当日成交 ≥ volMin`)，半对不是合法维度值。只给一端 → 400',
    example: 1,
  })
  @IsOptional()
  @IsString()
  oiMin?: string;

  @ApiPropertyOptional({
    description: '当日成交 (Vol) 下限 (张)。与 oiMin 成对，见其说明',
    example: 1,
  })
  @IsOptional()
  @IsString()
  volMin?: string;

  @ApiPropertyOptional({
    description: '相对价差上界; 空串 = 覆盖为不限。全腿视角的系统默认值本就是不限 (FR-010)',
    type: 'string',
    example: '0.3000',
  })
  @IsOptional()
  @IsString()
  relativeSpreadMax?: string;
}

/** GET /api/v1/optionsdesk/anchors/{id}/at 查询串 (FR-031 PIT 还原, SC-011)。 */
export class GetAnchorAtQuery {
  @ApiProperty({
    description: '还原时点 (ISO 8601 时刻; 早于建锚 → 204 无内容)',
    example: '2026-07-01T00:00:00.000Z',
  })
  @IsDateString()
  at!: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 响应
// ─────────────────────────────────────────────────────────────────────────────

export class AnchorResponse {
  @ApiProperty({ description: '锚 id (数字串)', example: '7' })
  id!: string;

  @ApiProperty({ description: 'canonical `market:code`', example: 'us:AOS' })
  ticker!: string;

  @ApiProperty({ description: '**生效** V = COALESCE(v_manual, v)', example: '50.0000' })
  v!: string;

  @ApiProperty({ description: '模型/基准 V (人工位撤销后回落到它)', example: '48.0000' })
  vModel!: string;

  @ApiProperty({ description: '估值 as-of 日 (YYYY-MM-DD)', example: '2026-06-30' })
  asof!: string;

  @ApiProperty({ description: '估值方法名', example: 'dcf' })
  method!: string;

  @ApiProperty({ description: '置信度 (10 分制)', example: '8.00' })
  confidence!: string;

  @ApiProperty({
    description: 'confidence 来源门控 (model ⇒ 客户端只读)',
    enum: [...ANCHOR_CONFIDENCE_SOURCES],
    example: 'manual',
  })
  confidenceSource!: string;

  @ApiProperty({ description: '交易意愿排除 (雷达不显示, 锚列表照常显示)', example: false })
  excluded!: boolean;

  @ApiProperty({ description: '排除原因', type: 'string', nullable: true, example: null })
  excludeReason!: string | null;

  @ApiProperty({
    description: '下次复审日 (YYYY-MM-DD)',
    type: 'string',
    nullable: true,
    example: '2026-09-30',
  })
  nextReview!: string | null;

  @ApiProperty({
    description: '最近复审完成日 (YYYY-MM-DD; FR-013 红标判据左操作数)',
    type: 'string',
    nullable: true,
    example: '2026-06-30',
  })
  lastReviewedOn!: string | null;

  @ApiProperty({
    description: 'FR-004 日历逾期 (next_review < 今日) → 红标 + 待复审',
    example: false,
  })
  overdue!: boolean;

  @ApiProperty({ description: 'EC-10 建锚即逾期 (next_review < asof)', example: false })
  overdueAgainstAsof!: boolean;

  @ApiProperty({ description: '生效 L 层 (雷达筛选主维度)', enum: [...L_LEVELS], example: 'L2' })
  lLevelEffective!: string;

  @ApiProperty({
    description: '生效单票上限 (小数比例; L4 无 SoT 口径 ⇒ null, 呈现「—」)',
    type: 'string',
    nullable: true,
    example: '0.0500',
  })
  positionCap!: string | null;

  @ApiProperty({ description: 'W = 愿买价锚 (四区间红色加粗界线)', example: '40.0000' })
  w!: string;

  @ApiProperty({ description: '四区间内段下界 (深买区/买区 分界)', example: '30.0000' })
  zoneFloor!: string;

  @ApiProperty({ description: '四区间内段上界 (偏贵/高估 分界)', example: '60.0000' })
  zoneCeiling!: string;

  @ApiProperty({ description: '长持愿卖锚', example: '60.0000' })
  willingSellLongHold!: string;

  @ApiProperty({ description: '收租愿卖锚 (与 V 相等是取值巧合, 非定义)', example: '50.0000' })
  willingSellRent!: string;

  @ApiProperty({
    description: 'spot 所在区间; 行情不可用 ⇒ null (禁伪造)',
    enum: [...ANCHOR_ZONES],
    nullable: true,
    example: 'buy',
  })
  zone!: string | null;

  @ApiProperty({
    description: 'spot = 最新未复权收盘价 (daily_bar 单向投影); 行情不可用 ⇒ null',
    type: 'string',
    nullable: true,
    example: '36.0000',
  })
  lastClose!: string | null;

  @ApiProperty({
    description: '行情 asOf (YYYY-MM-DD; 呈现「数据截至 X · 收盘」)',
    type: 'string',
    nullable: true,
    example: '2026-08-01',
  })
  lastCloseDate!: string | null;

  @ApiProperty({
    description:
      '行情 asOf 的新鲜度档 (FR-020): CURRENT 不落后于该市场最近一个已收盘交易日 / ' +
      'STALE 停在更早的交易日 / UNAVAILABLE 无行情。🚨 **判据在 server** —— 它要查交易日历, ' +
      '客户端拿设备本地日期比会对美股恒判陈旧 (046 初版实证)',
    enum: [...FRESHNESS_TIERS],
    example: 'CURRENT',
  })
  quoteFreshnessTier!: string;

  @ApiProperty({
    description:
      '061 生效 spot = **新鲜的盘中实时价, 否则收盘价** —— `zone` / `distanceToWPct` 都由它算出。' +
      '两价皆无 ⇒ null (禁伪造 0)。⚠️ 与上面的 `lastClose` **不是同一个数**: 那个恒为当日收盘的' +
      '权威值 (FR-015 语义不变), 这个是「此刻该按哪个价看」的裁决结果',
    type: 'string',
    nullable: true,
    example: '36.0000',
  })
  spot!: string | null;

  @ApiProperty({
    description:
      '061 生效 spot 的档位 (FR-009): realtime = 盘中实时价且在新鲜度闸内 / eod_close = 收盘价。' +
      '🚨 **只进接口, 不上屏** —— 界面 MUST NOT 为它加独立视觉标记, 只以 `spotAsOf` 的**粒度**' +
      '表达 (实时=时刻 / 收盘=交易日)。要上屏须先补走 mockup 步',
    enum: [...PRICE_KINDS],
    example: 'eod_close',
  })
  priceKind!: string;

  @ApiProperty({
    description:
      '061 生效 spot 的时间事实, **粒度即档位**: 实时档为 ISO 时刻 / 收盘档为 `YYYY-MM-DD` 交易日;' +
      '两价皆无 ⇒ null',
    type: 'string',
    nullable: true,
    example: '2026-08-01',
  })
  spotAsOf!: string | null;

  @ApiProperty({
    description: '距 W 百分比 (雷达排序键, 由生效 spot 算出); 两价皆无 ⇒ null',
    type: 'string',
    nullable: true,
    example: '-10.00',
  })
  distanceToWPct!: string | null;

  @ApiProperty({
    description: '本轮跌破首次观测日 (YYYY-MM-DD; FR-013 状态机载体)',
    type: 'string',
    nullable: true,
    example: null,
  })
  breachStartedOn!: string | null;

  @ApiProperty({
    description: 'FR-013 复核锚红标 (提醒语义, 不拦截任何操作); 解除 = 完成一次定期复审',
    example: false,
  })
  reviewFlagOn!: boolean;

  @ApiProperty({ description: 'V 处于人工态 (值等于派生值时仍为 true, EC-5)', example: false })
  vIsManual!: boolean;

  @ApiProperty({ description: 'L 层处于人工态', example: false })
  lLevelIsManual!: boolean;

  @ApiProperty({ description: '单票上限处于人工态', example: false })
  positionCapIsManual!: boolean;

  @ApiProperty({ description: 'V 人工值', type: 'string', nullable: true, example: null })
  vManual!: string | null;

  @ApiProperty({
    description: 'L 层人工值',
    enum: [...L_LEVELS],
    nullable: true,
    example: null,
  })
  lLevelManual!: string | null;

  @ApiProperty({ description: '单票上限人工值', type: 'string', nullable: true, example: null })
  positionCapManual!: string | null;

  @ApiProperty({
    description: 'FR-032 ② 同屏派生值: confidence 映射出的 L 档 (人工态时用于对照)',
    enum: [...L_LEVELS],
    example: 'L2',
  })
  derivedLLevel!: string;

  @ApiProperty({
    description: 'FR-032 ② 同屏派生值: 按映射档派生的单票上限',
    type: 'string',
    nullable: true,
    example: '0.0500',
  })
  derivedPositionCap!: string | null;

  @ApiProperty({ description: '创建时刻 (ISO)', example: '2026-05-01T00:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: '更新时刻 (ISO)', example: '2026-07-20T00:00:00.000Z' })
  updatedAt!: string;
}

export class AnchorListResponse {
  @ApiProperty({
    description: '锚列表 (ticker 升序; excluded 照常在列并带 reason)',
    type: [AnchorResponse],
  })
  items!: AnchorResponse[];

  @ApiProperty({ description: '本次返回条数 (无分页, 锚表规模上限约 1000)', example: 7 })
  total!: number;
}

/**
 * 单市场的基础集合计数 (065 FR-016)。
 *
 * 🚨 `market` 声明成裸 string 而**不是** enum: 响应侧要能如实回出「不在受支持白名单内」的市场
 * (FR-015 的失联场景 —— 库里真有那种锚时, 契约不该反过来说它不存在)。值域校验只属于**入参**
 * (`RadarQueryDto.market` 的 `@IsIn`)。
 */
export class RadarMarketCountResponse {
  @ApiProperty({ description: '市场代号 (canonical ticker 的 market 段)', example: 'us' })
  market!: string;

  @ApiProperty({
    description: '该市场基础集合 (不含 excluded、**未加用户筛选**) 的锚数',
    example: 12,
  })
  baseTotal!: number;

  @ApiProperty({ description: '该市场已跌破 W 的锚数 (= 可动)', example: 3 })
  actionableTotal!: number;
}

export class RadarResponse {
  @ApiProperty({
    description:
      '雷达行 (距 W% 升序, 行情不可用的行排尾但**仍在列表**); excluded 的锚不在此 (FR-005 相反面)',
    type: [AnchorResponse],
  })
  items!: AnchorResponse[];

  @ApiProperty({
    description: '下一页游标 (keyset, 不透明); null = 已到底',
    type: 'string',
    nullable: true,
    example: 'WyItMTAuMDAiLCI3Il0',
  })
  nextCursor!: string | null;

  @ApiProperty({ description: '是否还有下一页 (下拉增量加载判据)', example: true })
  hasMore!: boolean;

  @ApiProperty({
    description:
      '空态四分 (FR-008/FR-009/FR-010 + FR-015 + FR-034): zero_anchors 整库零锚 / ' +
      'zero_anchors_in_market 本市场零锚 (库里有锚, 有效动作是切市场) / ' +
      'filtered_empty 筛选无结果 / all_idle 全体不动区; 无空态 = null',
    enum: [...RADAR_EMPTY_STATES],
    nullable: true,
    example: null,
  })
  emptyState!: string | null;

  @ApiProperty({
    description: '该空态的文案 (四态 MUST NOT 复用同一句)',
    type: 'string',
    nullable: true,
    example: null,
  })
  emptyStateMessage!: string | null;

  @ApiProperty({
    description:
      '全部市场的基础集合计数 (FR-016 跨页签小圆点的数据源) —— **不受本次 market 作用域限制**, ' +
      '一次扫描回全部。⚠️ **续页恒为空数组**: 计数只在首页查, 客户端 MUST NOT 在续页响应里读它。',
    type: [RadarMarketCountResponse],
  })
  marketCounts!: RadarMarketCountResponse[];
}

/**
 * 单标的 IV 读数 (046 详情读端 / FR-012 / FR-014 / FR-020 / FR-035)。
 *
 * 🚨 **命名口径 (FR-035)**: `aggregateIv` = 富途**标的聚合 IV** 直读值。字段名与描述里
 * **MUST NOT** 出现「IV30d」或任何暗示 30 天 / ATM 锁定的措辞 —— 富途未文档化其 tenor /
 * moneyness 聚合规则 (p3 §9-1), 标成 IV30d 等于宣称一个数据源并不保证的口径。
 *
 * 🚨 **没有 `ivRank`** (FR-013): vendor 的 IVR 照常落库、但只落库不上屏 —— 读端 `select`
 * 里根本没查它。🚨 **也没有 T010 的自算分位** (FR-034): 双算对表只进采集侧告警面。
 */
export class UnderlyingIvReadoutResponse {
  @ApiProperty({
    description:
      'IV 读数态: available 齐备 / percentile_unavailable 窗口不足「分位不可算」/ ' +
      'missing 从未采到「暂无数据」(区块仍渲染) / read_failed 跨 ctx 读失败降级。' +
      '**非 available 态一律 null 值, MUST NOT 回落成 0** (FR-014)',
    enum: [...UNDERLYING_IV_STATES],
    example: 'available',
  })
  state!: string;

  @ApiProperty({
    description: '富途标的聚合 IV 直读值 (显示口径单源, FR-035)',
    type: 'string',
    nullable: true,
    example: '24.80000000',
  })
  aggregateIv!: string | null;

  @ApiProperty({
    description: 'IVP 直读值 (百分位; 优先于 IVR 呈现, FR-013)',
    type: 'string',
    nullable: true,
    example: '58.4000',
  })
  ivPercentile!: string | null;

  @ApiProperty({
    description:
      'IV 读数自身的业务日 (YYYY-MM-DD, 美股业务日)。与锚卡的行情 asOf 是**两个独立**的' +
      '新鲜度, 呈现侧分别标「数据截至 X · 收盘」(FR-020)',
    type: 'string',
    nullable: true,
    example: '2026-07-31',
  })
  asOf!: string | null;

  @ApiProperty({
    description: 'IV asOf 的新鲜度档 (FR-020; 与锚卡行情的档**各判各的**)',
    enum: [...FRESHNESS_TIERS],
    example: 'CURRENT',
  })
  freshnessTier!: string;
}

/**
 * GET /api/v1/optionsdesk/underlyings/{symbol} 响应 (046 US1)。
 *
 * ⚠️ **不含价格序列**: 区间时序的价格由客户端**直接**调 marketdata 的 bars 端点取
 * (前复权 + 时间桶聚合归那边, plan D2 / Q1=A) —— optionsdesk MUST NOT 碰复权 (ADR-0053 绊线)。
 * 两端点并行合成、各自 `asOf`、各自独立降级, 任一侧失败 MUST NOT 让整页失败。
 */
export class UnderlyingDetailResponse {
  @ApiProperty({ description: 'canonical `market:code`', example: 'us:PEP' })
  symbol!: string;

  @ApiProperty({
    description:
      '锚卡字段 + 四区间边界 (zoneFloor / w / v / zoneCeiling) —— 与锚列表 / 雷达**同一个**' +
      '投影, 派生值全部走 045 的 anchor.rules 纯函数 (FR-003)',
    type: AnchorResponse,
  })
  anchor!: AnchorResponse;

  @ApiProperty({
    description: '该标的的 IV 读数 (带自己的 asOf)',
    type: UnderlyingIvReadoutResponse,
  })
  iv!: UnderlyingIvReadoutResponse;
}

/**
 * 单指数读数 (046 温度计读端 / FR-015 / FR-017 / FR-020)。
 *
 * 🚨 **只有 close** —— VVIX 的 open/high/low 在库里恒 NULL (CBOE 的 VVIX 文件只有 `DATE,VVIX`
 * 两列), 契约面根本不给这三列就不存在「NULL 被当 0」的下游 (FR-025)。
 */
export class UsIndexReadoutResponse {
  @ApiProperty({
    description:
      '指数读数态: available 齐备 / missing 尚无数据 / read_failed 跨 ctx 读失败降级。' +
      '🚨 非 available 态一律 null 值, **MUST NOT 回落成 0** —— 指针停在 0 会被读成' +
      '「极度平静」, 那是错误信息而不是缺失信息 (FR-017)',
    enum: [...US_INDEX_STATES],
    example: 'available',
  })
  state!: string;

  @ApiProperty({
    description: '指数收盘值',
    type: 'string',
    nullable: true,
    example: '18.4500',
  })
  close!: string | null;

  @ApiProperty({
    description:
      '该指数自身的业务日 (YYYY-MM-DD) —— 取自 CBOE 历史文件的 DATE 列, **不是采集日**。' +
      'VIX 与 VVIX 来自两个独立文件, 两者可能不是同一天',
    type: 'string',
    nullable: true,
    example: '2026-07-31',
  })
  asOf!: string | null;

  @ApiProperty({
    description: '该指数 asOf 的新鲜度档 (FR-020; VIX 与 VVIX 各判各的)',
    enum: [...FRESHNESS_TIERS],
    example: 'CURRENT',
  })
  freshnessTier!: string;
}

/**
 * VVIX/VIX 比 (FR-016)。**在 server 算并带基准判定** —— 放前端等于每个消费方都要重新实现一次
 * 「不同交易日不算」的纪律, 漏一个就悄悄出一个跨日比值 (不会红、只会让人读错市场状态)。
 */
export class VvixVixRatioResponse {
  @ApiProperty({
    description:
      '比值态: available 同基准已算 / basis_mismatch 两侧不是同一交易日 ⇒ **不计算** / ' +
      'missing 任一侧无数据 (🚨 MUST NOT 拿单侧推算) / read_failed 跨 ctx 读失败降级',
    enum: [...VVIX_VIX_RATIO_STATES],
    example: 'available',
  })
  state!: string;

  @ApiProperty({
    description: 'VVIX ÷ VIX (呈现侧的「正常带 4-6」是读法, 不是本字段的约束)',
    type: 'string',
    nullable: true,
    example: '5.2195',
  })
  value!: string | null;

  @ApiProperty({
    description: '该比值成立的**共同**基准日 (YYYY-MM-DD); 非 available 态为 null',
    type: 'string',
    nullable: true,
    example: '2026-07-31',
  })
  basisDate!: string | null;
}

/** 温度计逐票行 (FR-018)。IV 读数**复用**详情读端的 {@link UnderlyingIvReadoutResponse}。 */
export class ThermometerUnderlyingRowResponse {
  @ApiProperty({ description: 'canonical `market:code`', example: 'us:VICI' })
  ticker!: string;

  @ApiProperty({
    description:
      '交易意愿排除 —— **照常在列表内并带标记** (045 语义: 锚 = 采集意愿、excluded = 交易意愿; ' +
      '与雷达相反, 雷达把它们排除在外)',
    example: true,
  })
  excluded!: boolean;

  @ApiProperty({ description: '排除原因', type: 'string', nullable: true, example: '暂不交易' })
  excludeReason!: string | null;

  @ApiProperty({
    description: '该票的 IV 读数 (带自己的 asOf); 「分位不可算」的行 MUST 保留在列表内',
    type: UnderlyingIvReadoutResponse,
  })
  iv!: UnderlyingIvReadoutResponse;
}

/**
 * GET /api/v1/optionsdesk/thermometer 响应 (046 US2)。
 *
 * 🚨 **不含 `regime` 字段** (FR-015 📌, 2026-08-03 拍板): vault §8 未给 N/X 的机械判据, 且三处
 * 一手依据一致把 regime 定性为「温度计的极致读数 + 人判 + 无 gate」—— 做成 server 算出的离散
 * 字段等于给它造一个硬开关。⚠️ mockup 帧⑦ 画过 `regime N`, `design/` 是历史留痕, 别抄回来。
 *
 * ⚠️ **不含免责文案字段** (FR-019): 「不构成开仓理由」常驻是纯 UI 呈现, 回一个文案字段证明不了
 * 它在客户端常驻可见 —— 该条的验证载体是 T024 e2e, 不是本契约。
 *
 * ⚠️ **不含提醒档位标签** (FR-036): 25/70/90 三档由 IVP 纯派生, 呈现侧各自派生即可。
 *
 * 指数三块与列表**各自独立降级**: 表盘不可用不让列表消失, 反之亦然; 零锚时列表为空而表盘照常
 * (指数维度不依赖锚, FR-027)。
 */
export class ThermometerResponse {
  @ApiProperty({ description: 'VIX 最新一期 (半圆表盘的值)', type: UsIndexReadoutResponse })
  vix!: UsIndexReadoutResponse;

  @ApiProperty({ description: 'VVIX 最新一期', type: UsIndexReadoutResponse })
  vvix!: UsIndexReadoutResponse;

  @ApiProperty({ description: 'VVIX/VIX 比 (带基准判定)', type: VvixVixRatioResponse })
  vvixVixRatio!: VvixVixRatioResponse;

  @ApiProperty({
    description: '全部锚定标的的 IVP 行 (ticker 升序)',
    type: [ThermometerUnderlyingRowResponse],
  })
  underlyings!: ThermometerUnderlyingRowResponse[];

  @ApiProperty({ description: '本次返回条数 (无分页, 锚表规模上限约 1000)', example: 12 })
  total!: number;
}

export class AnchorPointInTimeResponse {
  @ApiProperty({ description: '当时的生效 V', example: '50.0000' })
  v!: string;

  @ApiProperty({ description: '当时的 W', example: '40.0000' })
  w!: string;

  @ApiProperty({ description: '当时的生效 L 层', enum: [...L_LEVELS], example: 'L2' })
  lLevel!: string;

  @ApiProperty({ description: '当时的生效单票上限', type: 'string', nullable: true })
  positionCap!: string | null;

  @ApiProperty({ description: '当时的长持愿卖锚', example: '60.0000' })
  willingSellLongHold!: string;

  @ApiProperty({ description: '当时的收租愿卖锚', example: '50.0000' })
  willingSellRent!: string;

  @ApiProperty({ description: '当时 V 处于人工态', example: false })
  vIsManual!: boolean;

  @ApiProperty({ description: '当时 L 层处于人工态', example: false })
  lLevelIsManual!: boolean;

  @ApiProperty({ description: '当时单票上限处于人工态', example: false })
  positionCapIsManual!: boolean;

  @ApiProperty({ description: '当时的映射档 L 层', enum: [...L_LEVELS], example: 'L2' })
  derivedLLevel!: string;

  @ApiProperty({ description: '当时按映射档派生的单票上限', type: 'string', nullable: true })
  derivedPositionCap!: string | null;
}

/**
 * 水位档手选结果 (FR-017)。档位与来源标**严格成对** —— 不存在「有档无来源」的中间态。
 *
 * 🚨 `positionBucketSource` 是**契约层的人工输入标**, 不是可选装饰: M3 持仓数据到位后同一字段
 * 会开始混进真实水位, 没有它就分不清历史值里哪些是人填的 (FR-017 / plan D-UI-5)。
 */
export class PositionBucketResponse {
  @ApiProperty({ description: '锚 id (数字串)', example: '7' })
  anchorId!: string;

  @ApiProperty({ description: 'canonical `market:code`', example: 'us:PEP' })
  ticker!: string;

  @ApiProperty({
    description: '手选水位档; null = 未选 (**常驻分支不是过渡态**)',
    enum: [...POSITION_BUCKETS],
    nullable: true,
    example: 'gte_two_thirds',
  })
  positionBucket!: string | null;

  @ApiProperty({
    description:
      '🚨 数据来源标: manual = 人手选 (本片唯一来源)。M3 真实持仓水位接入后新增来源, ' +
      '消费方靠本字段分辨哪些值是人填的',
    enum: [...POSITION_BUCKET_SOURCES],
    nullable: true,
    example: 'manual',
  })
  positionBucketSource!: string | null;

  @ApiProperty({
    description: '本次手选时刻 (ISO); 重复选同一档也会前进 —— 它记的是「人最后一次确认」',
    type: 'string',
    nullable: true,
    example: '2026-08-04T02:15:00.000Z',
  })
  positionBucketSetAt!: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 投影 (usecase 返回值 → 响应)
// ─────────────────────────────────────────────────────────────────────────────

export function toAnchorResponse(view: AnchorView): AnchorResponse {
  const { row, effective } = view;
  return {
    id: row.id.toString(),
    ticker: row.ticker,
    v: effective.v.toFixed(4),
    vModel: row.v.toFixed(4),
    asof: dateOnly(row.asof)!,
    method: row.method,
    confidence: row.confidence.toFixed(2),
    confidenceSource: row.confidenceSource,
    excluded: row.excluded,
    excludeReason: row.excludeReason,
    nextReview: dateOnly(row.nextReview),
    lastReviewedOn: dateOnly(row.lastReviewedOn),
    overdue: view.overdue,
    overdueAgainstAsof: view.overdueAgainstAsof,
    lLevelEffective: effective.lLevel,
    positionCap: decimal4(effective.positionCap),
    w: view.w.toFixed(4),
    zoneFloor: view.zones.floor.toFixed(4),
    zoneCeiling: view.zones.ceiling.toFixed(4),
    willingSellLongHold: view.willingSell.longHold.toFixed(4),
    willingSellRent: view.willingSell.rent.toFixed(4),
    zone: view.zone,
    lastClose: decimal4(row.lastClose),
    lastCloseDate: dateOnly(row.lastCloseDate),
    quoteFreshnessTier: freshnessTier(dateOnly(row.lastCloseDate), view.lastClosedSession),
    // 061: 三件套一起出, 全部取自 `view.spot` 这一个裁决结果 —— 分头取会让「价 / 档位 / asOf」
    // 落在不同判据上, 而那种不一致在屏幕上看起来完全正常。
    spot: decimal4(view.spot.price),
    priceKind: view.spot.priceKind,
    spotAsOf: view.spot.asOf,
    distanceToWPct: view.distanceToWPct === null ? null : view.distanceToWPct.toFixed(2),
    breachStartedOn: dateOnly(row.breachStartedOn),
    reviewFlagOn: view.reviewFlagOn,
    vIsManual: effective.vIsManual,
    lLevelIsManual: effective.lLevelIsManual,
    positionCapIsManual: effective.positionCapIsManual,
    vManual: decimal4(row.vManual),
    lLevelManual: row.lLevelManual,
    positionCapManual: decimal4(row.positionCapManual),
    derivedLLevel: effective.derived.lLevel,
    derivedPositionCap: decimal4(effective.derived.positionCap),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAnchorListResponse(views: readonly AnchorView[]): AnchorListResponse {
  return { items: views.map(toAnchorResponse), total: views.length };
}

/**
 * 写侧结果 → 响应: 写侧只回主行, 派生值由 {@link toAnchorView} 统一补齐, 保证
 * 「建锚 / 改锚 / 复审同屏返回的派生值」与「列表 / 详情读到的」逐项同源 (FR-003a ①)。
 */
export function toAnchorWriteResponse(result: AnchorWriteResult): AnchorResponse {
  return toAnchorResponse(toAnchorView(result, result.lastClosedSession));
}

/** 雷达页 → 响应。行投影与锚列表**同一个** `toAnchorResponse` (派生口径单点, 无第二套形状)。 */
export function toRadarResponse(page: RadarPage): RadarResponse {
  return {
    items: page.items.map(toAnchorResponse),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    emptyState: page.emptyState,
    emptyStateMessage: page.emptyStateMessage,
    // Record → 数组: OpenAPI 的 map 形态会让 orval 生成 `{ [k: string]: unknown }`
    // (012/023/024/025 那条 objectmap 回归的同族问题), 数组则生成具名 item 类型。
    marketCounts: Object.entries(page.marketCounts).map(([market, counts]) => ({
      market,
      baseTotal: counts.baseTotal,
      actionableTotal: counts.actionableTotal,
    })),
  };
}

/**
 * IV 读数投影 —— 详情读端与温度计逐票行**共用一个**, 保证同一事实在两个端点上逐字段同形。
 * 四字段封闭: 加字段前先回头读 FR-013 / FR-034 / FR-035 三条禁令。
 */
function toUnderlyingIvReadoutResponse(
  iv: UnderlyingIvReadout,
  lastClosedSession: string | null,
): UnderlyingIvReadoutResponse {
  return {
    state: iv.state,
    aggregateIv: decimal8(iv.iv),
    ivPercentile: decimal4(iv.ivPercentile),
    asOf: dateOnly(iv.asOf),
    freshnessTier: freshnessTier(dateOnly(iv.asOf), lastClosedSession),
  };
}

/**
 * 详情读端 → 响应。锚侧走**同一个** {@link toAnchorResponse} (与列表 / 雷达 / 写侧回显逐项
 * 同源); IV 侧走 {@link toUnderlyingIvReadoutResponse} (与温度计列表同源)。
 */
export function toUnderlyingDetailResponse(detail: UnderlyingDetail): UnderlyingDetailResponse {
  return {
    symbol: detail.symbol,
    anchor: toAnchorResponse(detail.anchor),
    iv: toUnderlyingIvReadoutResponse(detail.iv, detail.lastClosedSession),
  };
}

/** 指数读数 → 响应。降级态三值透传 null (**禁 0**, FR-017)。 */
function toUsIndexReadoutResponse(
  readout: UsIndexReadout,
  lastClosedSession: string | null,
): UsIndexReadoutResponse {
  return {
    state: readout.state,
    close: decimal4(readout.close),
    asOf: dateOnly(readout.asOf),
    freshnessTier: freshnessTier(dateOnly(readout.asOf), lastClosedSession),
  };
}

function toVvixVixRatioResponse(ratio: VvixVixRatio): VvixVixRatioResponse {
  return {
    state: ratio.state,
    value: decimal4(ratio.value),
    basisDate: dateOnly(ratio.basisDate),
  };
}

function toThermometerRowResponse(row: ThermometerUnderlyingRow): ThermometerUnderlyingRowResponse {
  return {
    ticker: row.ticker,
    excluded: row.excluded,
    excludeReason: row.excludeReason,
    iv: toUnderlyingIvReadoutResponse(row.iv, row.lastClosedSession),
  };
}

/**
 * 温度计读端 → 响应。🚨 **不投影任何 `regime` 字段** (FR-015 📌) —— use case 也不产出它,
 * 这里是第二道: 加字段前先回头读那条拍板记录。
 */
export function toThermometerResponse(thermometer: Thermometer): ThermometerResponse {
  return {
    vix: toUsIndexReadoutResponse(thermometer.vix, thermometer.indexLastClosedSession),
    vvix: toUsIndexReadoutResponse(thermometer.vvix, thermometer.indexLastClosedSession),
    vvixVixRatio: toVvixVixRatioResponse(thermometer.vvixVixRatio),
    underlyings: thermometer.underlyings.map(toThermometerRowResponse),
    total: thermometer.total,
  };
}

export function toAnchorPointInTimeResponse(
  values: PointInTimeAnchorValues,
): AnchorPointInTimeResponse {
  return {
    v: values.v.toFixed(4),
    w: values.w.toFixed(4),
    lLevel: values.lLevel,
    positionCap: decimal4(values.positionCap),
    willingSellLongHold: values.willingSell.longHold.toFixed(4),
    willingSellRent: values.willingSell.rent.toFixed(4),
    vIsManual: values.vIsManual,
    lLevelIsManual: values.lLevelIsManual,
    positionCapIsManual: values.positionCapIsManual,
    derivedLLevel: values.derived.lLevel,
    derivedPositionCap: decimal4(values.derived.positionCap),
  };
}

export function toPositionBucketResponse(
  result: PositionBucketWriteResult,
): PositionBucketResponse {
  return {
    anchorId: result.anchorId.toString(),
    ticker: result.ticker,
    positionBucket: result.bucket,
    positionBucketSource: result.source,
    positionBucketSetAt: result.setAt === null ? null : result.setAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 047 T027 选约表 (GET /v1/optionsdesk/underlyings/{symbol}/legs)
// ─────────────────────────────────────────────────────────────────────────────

export class LegActivityResponse {
  @ApiProperty({ description: '行权价为整数 (做市商深度天然集中)', example: true })
  isRoundStrike!: boolean;

  @ApiProperty({
    description: '在**当前 Tab 候选集**内 OI 与 Vol 各自排名之和进前 3 (相对排名, 非绝对阈值)',
    example: false,
  })
  isTopRanked!: boolean;

  @ApiProperty({
    description: '呈现标签 (整数档优先); 两者皆否 → null, MUST NOT 伪造默认档',
    type: 'string',
    nullable: true,
    example: 'round_strike',
  })
  label!: string | null;
}

export class LegEarningsMarkResponse {
  @ApiProperty({
    description:
      '五态: covered (覆盖 ✓) / buffer_short (缓冲不足 +Nd) / crosses_earnings (跨财报 ⚠) / ' +
      'no_cross (已确认不跨) / no_date (无日期)。**no_date 与 no_cross 是两个值**, ' +
      'MUST NOT 把「不知道」渲成「已确认不跨」(FR-026 / FR-034)',
    enum: [...EARNINGS_MARKS],
    example: 'covered',
  })
  mark!: string;

  @ApiProperty({
    description: 'buffer_short 的 N —— 还差几天凑够缓冲; 其余四态恒 null',
    type: 'number',
    nullable: true,
    example: null,
  })
  bufferShortfallDays!: number | null;

  @ApiProperty({
    description: '窗口内最后一个财报日 (YYYY-MM-DD); 未跨 / 无日期 → null。不参与判定',
    type: 'string',
    nullable: true,
    example: '2026-08-12',
  })
  lastEarningsDate!: string | null;
}

export class LegResponse {
  @ApiProperty({ description: 'vendor 合约代码', example: 'US.PEP260918P120000' })
  code!: string;

  @ApiProperty({ description: '行权价 K', example: '120.0000' })
  strike!: string;

  @ApiProperty({ description: '到期日 (YYYY-MM-DD)', example: '2026-09-18' })
  expiryDate!: string;

  @ApiProperty({
    description: '请求时 DTE (整数日历日, 基准 = **交易所的今天**; 本端点只返 > 0 的腿)',
    example: 45,
  })
  dteDays!: number;

  // 📌 example 蓄意避开形如 x.y 的那几个区间系数 —— `check-optionsdesk-rule-constants.ts`
  // 不剥字符串字面量, 一个 example 就能把 PR 打红。
  @ApiProperty({ description: 'bid (判档口径)', type: 'string', nullable: true, example: '1.4500' })
  bid!: string | null;

  @ApiProperty({ description: 'ask (不参与判档)', type: 'string', nullable: true, example: '1.35' })
  ask!: string | null;

  @ApiProperty({
    description:
      '**单笔权利金** = `bid × 合约乘数` (053 FR-032) —— 卖出一张 put 实际收到多少钱。' +
      '🚨 **服务端算**, 🚫 客户端 MUST NOT 自己乘一次: 合约乘数是**市场规则不是合约属性** ' +
      '(故也不落库), 服务端已持有那一份 (成交额在用它) ⇒ 客户端再乘就是同一判据两处各算一份, ' +
      '而两边都乘得出数。📌 口径取 bid 而非 mid/ask —— 与档位判据同一个数 (FR-018)。' +
      '无 bid → null, MUST NOT 当 0',
    type: 'string',
    nullable: true,
    example: '145.00',
  })
  contractPremium!: string | null;

  @ApiProperty({
    description:
      '**相对价差** `(ask − bid) / mid`, 小数比例 (053 FR-032) —— 与召回层流动性判据**同一个** ' +
      '派生值 (阈值就是拿它比的)。🚨 复用而非新造: 上屏的数与挡腿的数各算一份的话, ' +
      '「这条腿为什么被挡了」在屏幕上就对不上账, 而两个数都显示得出来。' +
      '任一侧缺报价 / mid ≤ 0 → null (双边报价都是 0 的死合约算不出价差)',
    type: 'string',
    nullable: true,
    example: '0.0678',
  })
  relativeSpread!: string | null;

  @ApiProperty({
    description:
      '买盘挂牌量 (张); **MUST NOT 参与判档** —— 档位恒由 bid 价定 (FR-018), 量只作同屏参照',
    type: 'number',
    nullable: true,
    example: 25,
  })
  bidSize!: number | null;

  @ApiProperty({
    description: '卖盘挂牌量 (张); 同 bidSize, 只作同屏参照',
    type: 'number',
    nullable: true,
    example: 26,
  })
  askSize!: number | null;

  @ApiProperty({
    description: '本行腿族口径 (FR-019 每行显式标注; 跨族 MUST NOT 比数值)',
    enum: [...LEG_BASES],
    example: 'annualized',
  })
  basis!: string;

  @ApiProperty({
    description: '期间费率 P/(K−P), 小数比例',
    type: 'string',
    nullable: true,
    example: '0.0105',
  })
  periodRate!: string | null;

  @ApiProperty({ description: '周化费率, 小数比例', type: 'string', nullable: true, example: null })
  weeklyRate!: string | null;

  @ApiProperty({
    description: '年化费率, 小数比例 (落在周化族的行上它就是「折年」参照, **不作排序键**)',
    type: 'string',
    nullable: true,
    example: '0.0853',
  })
  annualizedRate!: string | null;

  @ApiProperty({
    description:
      '四档 (判定值恒为 bid 口径费率), **档界按本次视角的口径取** (FR-023 / 053 FR-041): 建仓走' +
      '周化、收租与全腿走年化 —— 同一条腿在两个视角判出不同档是**定义如此**, 那三份由三次请求' +
      '各算各的 (053 起把三份收窄成本字段)。**greeks 缺失行恒 null** —— 不判档不着色 ' +
      '(FR-007), 无 bid 亦 null',
    enum: [...LEG_TIERS],
    nullable: true,
    example: 'acceptable',
  })
  tier!: string | null;

  @ApiProperty({
    description: '薄档带出的 ask 口径费率 (仅供呈现, 不参与判定); 其余档恒 null',
    type: 'string',
    nullable: true,
    example: null,
  })
  askRate!: string | null;

  @ApiProperty({
    description: '有效成本 K−P (被指派后的实际持仓成本); 无 bid → null (禁拿 K−0 冒充)',
    type: 'string',
    nullable: true,
    example: '118.7500',
  })
  effectiveCost!: string | null;

  @ApiProperty({
    description: '有效成本相对 W 的位置, **百分数** (费率是小数比例 —— 两者故意不同量纲)',
    type: 'string',
    nullable: true,
    example: '-1.04',
  })
  effectiveCostVsWPct!: string | null;

  @ApiProperty({
    description: '|Δ| 真值 (建仓腿带判据); 与 σ 距同源, 要么同时有值要么同时为空',
    type: 'number',
    nullable: true,
    example: 0.32,
  })
  absDelta!: number | null;

  @ApiProperty({
    description: 'σ 距 = −Φ⁻¹(|Δ|) —— 跨期限可比的坐标 (Δ 不可跨期限横比)',
    type: 'number',
    nullable: true,
    example: 0.4677,
  })
  sigmaDistance!: number | null;

  @ApiProperty({
    description: '未平仓量。🚨 它归属 **oiAsOf** 那一天, 不是区块级 asOf',
    type: 'number',
    nullable: true,
    example: 1234,
  })
  openInterest!: number | null;

  @ApiProperty({
    description:
      '成交量。🚨 **两档口径不同** (064 FR-013): priceKind=realtime ⇒ **截至该时刻的累计**成交量; ' +
      'priceKind=eod_close ⇒ **当日全天**成交量。🚫 呈现侧 MUST NOT 两档共用一句表头文案 —— ' +
      '盘中的累计量天然小于全天量, 混着读会把活跃的腿看成冷门腿, 而两个数都显示得出来',
    type: 'number',
    nullable: true,
    example: 87,
  })
  volume!: number | null;

  @ApiProperty({
    description:
      '成交额 = Vol × 权利金 × 100。🚨 **口径随 volume 分两档** (064 FR-013): priceKind=realtime ' +
      '⇒ 至该时刻的累计成交额; priceKind=eod_close ⇒ 当日全天成交额。📌 成交额高 ≠ 真流动',
    type: 'string',
    nullable: true,
    example: '10875.00',
  })
  turnover!: string | null;

  @ApiProperty({
    description:
      '**本次视角**候选集内的活跃度标记 —— 排名是候选集内的相对量, 换视角归属就变 (D-SOT-5)。' +
      '053 起收窄成单份: 拆请求之后另两个视角结构上没有可判的东西',
    type: LegActivityResponse,
    nullable: true,
  })
  activity!: LegActivityResponse | null;

  @ApiProperty({
    description:
      '推荐标 (FR-011): 本腿 |Δ| 落**标的级意图**对应的带内。🚨 **随意图判, 不随当前 Tab 变** —— ' +
      '收租意图下打开建仓 Tab 会看到全 false, 那是**正确信号**不是 bug; greeks 缺失恒 false ' +
      '(FR-013), 但该腿**照常在召回集里**',
    example: false,
  })
  isRecommended!: boolean;

  @ApiProperty({
    description:
      '到期日是不是该月的**月度到期日** (FR-014, 判据 = 该月第三个周五; 该日非交易日则取其前一' +
      '交易日) —— 月度链流动性通常显著好于周链。🚫 呈现侧 MUST NOT 简化成「是不是周五」',
    example: true,
  })
  isMonthlyChain!: boolean;

  @ApiProperty({
    description: '财报标; **建仓域恒 null** (UI 显「—」) —— 与 no_date (虚线 chip) 是两个值',
    type: LegEarningsMarkResponse,
    nullable: true,
  })
  earningsMark!: LegEarningsMarkResponse | null;

  @ApiProperty({
    description: 'greeks 是否齐全 (FR-007「数据不全」标注); false 的行**照常在表内**',
    example: true,
  })
  greeksComplete!: boolean;

  @ApiProperty({
    description:
      '**本行**数值的时间口径 (064 FR-009): realtime = 上面七列 (bid/ask/挂牌量/Δ/IV/成交量) 取自' +
      '**此刻**的盘口; eod_close = 保留库内收盘档。' +
      '🚨 **逐行成立, 与区块级那个 priceKind 不是同一个数** —— 实时源返回集里少几个合约是常态 ' +
      '(停牌 / 刚摘牌), 那几行标 eod_close 而区块级仍是 realtime。' +
      '🚫 呈现侧 MUST NOT 拿区块级档位给每一行着色: 整页统一标实时与整页统一降级**都渲染得出' +
      '一张完整的表**, 只有逐行标才分得出来',
    enum: [...PRICE_KINDS],
    example: 'realtime',
  })
  priceKind!: string;

  @ApiProperty({
    description:
      '068 带标 (呈现语义): in = 同批实时 Δ 落意图带 (执行目标) / out = 带外横档 (保留供比价)。' +
      '离线档 / 实时 Δ 缺失 ⇒ null。🚨 只描述不筛选 —— 客户端 MUST NOT 拿它当过滤器隐藏行, ' +
      '带外横档的存在就是它的功能 (比价)',
    enum: ['in', 'out'],
    type: 'string',
    nullable: true,
    example: 'in',
  })
  bandStatus!: string | null;
}

/** DTE 段 —— 一个维度、值是闭区间 (052 T010 六维表第 3 项)。 */
export class DteBandResponse {
  @ApiProperty({ description: 'DTE 段下界 (含)', example: 30 })
  min!: number;

  @ApiProperty({ description: 'DTE 段上界 (含)', example: 365 })
  max!: number;
}

/** 活性下限 —— 一个维度的两个值 (052 T012)。两支是**或**的关系。 */
export class LivenessFloorResponse {
  @ApiProperty({ description: '未平仓 (OI) 下限，张', example: 1 })
  oi!: number;

  @ApiProperty({ description: '当日成交 (Vol) 下限，张', example: 1 })
  volume!: number;
}

/**
 * 一套**检索条件**的六个维度 (052 FR-002, T010 六维表)。每维度 `null` = **不限**。
 *
 * 🚨 **与「硬门槛」的分界**: 硬门槛无控件、不可调、表达不成范围区间 —— 本片只有一条,
 * 建仓的有效成本 `K − bid < spot`。它蓄意**不在这六项里**: 一旦有了控件,「被指派后成本高于
 * 现价」这种结构性错误就成了可谈判的, 而它不是。
 */
export class RetrievalCriteriaResponse {
  @ApiProperty({
    description: '行权价上界 (闭区间)。收租的系统默认值 = 成色上界; 全腿与建仓默认不限',
    type: 'string',
    nullable: true,
    example: '137.6960',
  })
  strikeMax!: string | null;

  @ApiProperty({
    description: '行权价下界 (闭区间)。三视角系统默认值均为不限 —— 它只为用户可覆盖而存在',
    type: 'string',
    nullable: true,
    example: null,
  })
  strikeMin!: string | null;

  @ApiProperty({
    description: 'DTE 段 (闭区间)。三视角默认值不同, **全腿不设** (FR-003)',
    type: DteBandResponse,
    nullable: true,
  })
  dteBand!: DteBandResponse | null;

  @ApiProperty({
    description:
      '权利金下限。系统默认值 = `max(绝对下限, spot × 比例)` —— **依赖 spot ⇒ 客户端算不出**, ' +
      '这正是它必须由服务端下发的理由 (FR-011)',
    type: 'string',
    nullable: true,
    example: '0.2384',
  })
  premiumMin!: string | null;

  @ApiProperty({
    description:
      '活性下限 —— **一个维度、两个值**: `OI ≥ oi` **或** `当日成交 ≥ volume`。' +
      '🚨 两支是「或」不是「与」: 它问的是「这张合约上有没有人活动」，存量与流量**任一**成立即算活着。' +
      '📌 蓄意不拆成两个维度 —— 拆开后同一条腿会同时计进两个维度的边际计数（OR 下换回任一支都能救它），' +
      '两行「当前条件之外还有 N 条」说的是同一批腿',
    type: LivenessFloorResponse,
    nullable: true,
  })
  livenessMin!: LivenessFloorResponse | null;

  @ApiProperty({
    description: '相对价差上界。**全腿的系统默认值是不限** (FR-010: 该条件只作用两个意图视角)',
    type: 'string',
    nullable: true,
    example: '0.3000',
  })
  relativeSpreadMax!: string | null;
}

/**
 * 一个维度的三态与计数 (052 FR-029 / FR-030)。
 *
 * 🚨 **三态的判据是「是否产生排除」而非值比较** —— 后者对 DTE 段这种双端维度给不出唯一答案
 * (一端收一端放同时发生), 且计数本来就要逐腿判一遍 ⇒ 两者同源派生, 才不会出现「显示了计数
 * 但态是放宽」。📌 `widened` 因此含「方向是收窄但一条腿都没排除掉」: 处置与放宽相同。
 */
export class CriterionOutcomeResponse {
  @ApiProperty({
    description:
      '`default` = 用户没动过 · `widened` = 覆盖了但没产生排除 · `narrowed` = 覆盖了且排除了腿',
    enum: [...CRITERION_STATES],
    example: 'narrowed',
  })
  state!: string;

  @ApiProperty({
    description:
      '「**当前条件之外还有 N 条**」(FR-030) —— 边际口径: 把该维度换回系统默认值、其余维度保持' +
      '用户值时多出来的候选数。恒有值, 非 narrowed 时为 0。🚫 MUST NOT 读成「被系统滤掉 N 条」: ' +
      '系统默认值下的排除**不出计数** (FR-029 —— 默认值本身就摆在控件里, 第二次告知是噪音)',
    example: 2,
  })
  excludedCount!: number;
}

/** 六个维度各自的三态与计数 —— 与 {@link RetrievalCriteriaResponse} 的字段一一对应。 */
export class RetrievalOutcomesResponse {
  @ApiProperty({ type: CriterionOutcomeResponse })
  strikeMax!: CriterionOutcomeResponse;

  @ApiProperty({ type: CriterionOutcomeResponse })
  strikeMin!: CriterionOutcomeResponse;

  @ApiProperty({ type: CriterionOutcomeResponse })
  dteBand!: CriterionOutcomeResponse;

  @ApiProperty({ type: CriterionOutcomeResponse })
  premiumMin!: CriterionOutcomeResponse;

  @ApiProperty({ type: CriterionOutcomeResponse })
  livenessMin!: CriterionOutcomeResponse;

  @ApiProperty({ type: CriterionOutcomeResponse })
  relativeSpreadMax!: CriterionOutcomeResponse;
}

/** 一个视角的条件全景 —— 控件填 `defaults`, 结果按 `effective`, 计数看 `outcomes`。 */
export class PerspectiveCriteriaResponse {
  @ApiProperty({
    description:
      '**系统默认值** (FR-011) —— 客户端进入该视角时用它填控件。🚫 MUST NOT 自行计算任何一项: ' +
      '行权价上界与权利金下限都依赖 spot (每天变), 客户端自算就是同一判据两处各一份, ' +
      '而两边都算得出数 ⇒ 漂移只在换日那一刻才看得见',
    type: RetrievalCriteriaResponse,
  })
  defaults!: RetrievalCriteriaResponse;

  @ApiProperty({
    description: '**本次生效值** —— 未覆盖的视角逐字等于 defaults',
    type: RetrievalCriteriaResponse,
  })
  effective!: RetrievalCriteriaResponse;

  @ApiProperty({
    description: '六个维度各自的三态与计数; **仅 narrowed 显示计数** (FR-029)',
    type: RetrievalOutcomesResponse,
  })
  outcomes!: RetrievalOutcomesResponse;
}

export class LegGateCountsResponse {
  @ApiProperty({
    description:
      '被**权利金门槛**从响应里整条移出的条数 (FR-005) —— 这些腿三个 Tab 都看不到, 是真正的' +
      '「数据消失」。呈现侧 MUST NOT 省略: 它是「有腿不见了」这笔取舍的**唯一**补偿',
    example: 12,
  })
  removedByPremiumFloor!: number;

  @ApiProperty({
    description:
      '被**流动性门槛**排除出**本次视角**的条数 (FR-006 / 051 FR-006a) —— 这些腿**仍在链上、' +
      '仍在全腿视角可见**, 没有消失。空态文案按它分支。🚨 与上一个数语义不对称, MUST NOT 相加' +
      '成总数。期限段本就不合格的腿 (如 DTE 400) 不计入 —— 它不是被门槛挡下的。' +
      '📌 **全腿视角恒 0** (它不受流动性门槛约束)。📌 053 起它就是「该视角自己的数」: 一次请求' +
      '只判定一个视角 ⇒ 051 的全表标量与分视角数结构上已是同一个数, 契约面只留一份',
    example: 3,
  })
  excludedFromIntentTabs!: number;
}

export class LegTableResponse {
  @ApiProperty({ description: 'canonical `market:code`', example: 'us:PEP' })
  symbol!: string;

  @ApiProperty({
    description:
      '🚨 **本次作答的视角**, 原样回显请求参数 (053 FR-005)。三视角是三次飞行中的请求, 迟到的' +
      '那一发靠它认领 (FR-008) —— 靠调用点记忆的话, 覆盖错了**照样渲染得出来一张表**',
    enum: [...LEG_TABS],
    example: 'rent',
  })
  perspective!: string;

  @ApiProperty({
    description:
      '区块状态。chain_not_ready (采集还没轮到, 是事实) 与 read_failed (跨 ctx 读故障) 蓄意分开',
    enum: [...LEG_TABLE_STATES],
    example: 'available',
  })
  state!: string;

  @ApiProperty({
    description:
      '区块级 asOf = 快照归属交易日 (YYYY-MM-DD)。' +
      '🚨 **实时独载基线下它是「交易所的今天」**: 库内一期快照都没有时 (新锚盘中首访), ' +
      '屏上的报价列全部来自此刻 ⇒ 归属的是**正在进行的这一场**, 而非上一场收盘。' +
      '此时 source=realtime, 且 oiAsOf 仍是最近一个已收盘交易日 (两者依旧不同天)',
    type: 'string',
    nullable: true,
    example: '2026-08-03',
  })
  asOf!: string | null;

  @ApiProperty({
    description:
      '上一字段 (**区块级 asOf**) 的新鲜度档: CURRENT 不落后于该市场最近一个已收盘交易日 / ' +
      'STALE 停在更早的交易日 (全表照常渲染, 陈旧 ≠ 不可用) / UNAVAILABLE 无快照。' +
      '🚨 **判据在 server** —— 它要查交易日历, 客户端拿设备本地日期比对美股恒判陈旧 (046 初版实证)。' +
      '🚨 **名字带 asOf 前缀是刻意的**: 本响应有三个时点, 本档只判区块级 asOf —— oiAsOf 归属 T−1 ' +
      '是**定义如此**, 拿它判档会恒 STALE',
    enum: [...FRESHNESS_TIERS],
    example: 'CURRENT',
  })
  asOfFreshnessTier!: string;

  @ApiProperty({
    description:
      '**区块级**时间口径 (064 FR-009 / FR-010) —— 本批腿整体处于哪个档, 也决定下一字段 ' +
      'quoteAsOf 的**粒度**。realtime = 本次取到了此刻的盘口; eod_close = 走库内收盘档 ' +
      '(未开实时 / 非交易时段 / 源不可达 / 超单批上限 / 定窗基准陈旧, 一律落这一档)。' +
      '🚨 **与每腿的 priceKind 不是同一个数** (见 LegResponse.priceKind): 部分合约未返回时' +
      '本字段仍是 realtime 而那几行是 eod_close。区块条读这个, 行级角标读那个',
    enum: [...PRICE_KINDS],
    example: 'realtime',
  })
  priceKind!: string;

  @ApiProperty({
    description:
      '**本该给实时却没给成** (064 FR-010 / FR-011) —— 正常收盘档恒 null。' +
      '🚨 **它与 priceKind 回答两个不同的问题**: 后者说「这批是什么档」, 本字段说「此刻**本该**' +
      '是什么档」。非 null 的充要条件 = 调用方开了实时 **且** 两闸 (市场时段 ∩ 交易日历) 判定' +
      '此刻本该外呼, 而最终仍落收盘档。' +
      '🚨 **非交易时段 / 非交易日 / 未开实时 ⇒ 恒 null** —— 北京白天美股休市走收盘档是常态, ' +
      '给它刷降级 = 造一个永远为真的告警。' +
      '🚫 客户端 MUST NOT 拿 priceKind 反推本字段 (反推出来的标在「正常盘后」与「盘中源挂了」' +
      '两种情形下都渲染得出来, 而那恰是本 feature 要分开的两件事)。' +
      '📌 值域**不含** partial_miss: 部分合约未返回是**逐行**降级, 由每腿的 priceKind 承载、' +
      '本字段仍为 null。' +
      'window_over_cap = 候选范围内条数超单批上限 (fail-closed 零外呼); ' +
      'window_basis_stale = 定窗基准缺失 / 陈旧; source_unavailable = 源不可达或请求级超时; ' +
      'gate_unknown = 两闸自身故障, 不知道此刻该不该外呼',
    enum: [...REALTIME_CHAIN_DEGRADE_KINDS],
    nullable: true,
    example: 'source_unavailable',
  })
  realtimeDegrade!: string | null;

  @ApiProperty({
    description:
      '本批报价的时点, **粒度即档位** (064 FR-010 / FR-014): priceKind=realtime ⇒ ISO-8601 ' +
      '**时刻** (含秒); priceKind=eod_close ⇒ 该批快照归属的**交易日** `YYYY-MM-DD`。' +
      '🚨 两档混成一种形态不会红任何一处, 但会让「数据截至 X · 收盘」的呈现出错 —— 收盘档带上' +
      '时分秒会被读成此刻的盘口, 实时档只给日期则抹掉唯一要紧的那件事。' +
      '🚫 客户端 MUST NOT 自己截断或补齐粒度 (那就是把档位判据抄了第二份)',
    type: 'string',
    nullable: true,
    example: '2026-08-03T20:15:00.000Z',
  })
  quoteAsOf!: string | null;

  @ApiProperty({
    description:
      '🚨 **OI 的归属交易日** (YYYY-MM-DD) —— 与 asOf **不是同一天**: 美股期权 OI 在盘前更新, ' +
      '收盘后采的快照其 OI 归属 T−1 日。OI 列 MUST 用它而非区块级 asOf (FR-013)。' +
      '🚨 **064 起它更不跟 quoteAsOf 走**: 实时档下 OI 三列恒保留收盘值 (盘中冻结, FR-004), ' +
      '本字段照旧是那个归属日 —— 🚫 MUST NOT 因为区块级翻了 realtime 就把它读成今天。' +
      '🚨 **实时独载基线 (source=realtime) 下 OI 改由同一批实时给出**, 而本字段取最近一个已收盘' +
      '交易日 —— 两者由构造对齐 (OI 盘前更新、盘中冻结 ⇒ 此刻取回的那个数归属上一场收盘)',
    type: 'string',
    nullable: true,
    example: '2026-07-31',
  })
  oiAsOf!: string | null;

  @ApiProperty({
    description:
      '这批数从哪来 (eod / premarket_backfill / realtime) —— 「一直靠兜底续命」要看得见。' +
      'realtime = **实时独载基线**: 库内一期收盘快照都没有, 整条链由这一次实时取回撑起 ' +
      '(新锚盘中首访的形态, 当晚收盘轮跑完即自愈)',
    type: 'string',
    nullable: true,
    example: 'eod',
  })
  source!: string | null;

  @ApiProperty({
    description: 'vendor 随链下发的标的价, **未复权**',
    type: 'string',
    nullable: true,
    example: '132.4000',
  })
  spot!: string | null;

  @ApiProperty({ description: 'W = 愿买价锚 (045 派生, 本端点不重算)', example: '120.0000' })
  w!: string;

  @ApiProperty({
    description: 'spot 落在四区间的哪一段; 无 spot → null',
    enum: [...ANCHOR_ZONES],
    nullable: true,
    example: 'thin',
  })
  zone!: string | null;

  @ApiProperty({ description: '生效 L 层', enum: [...L_LEVELS], example: 'L2' })
  lLevel!: string;

  @ApiProperty({
    description: '手选水位档 (FR-017 人工输入); null = 未选, **是常驻分支不是过渡态**',
    enum: [...POSITION_BUCKETS],
    nullable: true,
    example: 'gte_two_thirds',
  })
  positionBucket!: string | null;

  @ApiProperty({
    description:
      '🚨 上一字段的**数据来源标** (与写端点同口径): manual = 人手选; null = 未选。' +
      '「人工输入」由契约表达而非前端记忆 —— M3 真实水位接入后靠它分辨哪些是人填的 (FR-017)',
    enum: [...POSITION_BUCKET_SOURCES],
    nullable: true,
    example: 'manual',
  })
  positionBucketSource!: string | null;

  @ApiProperty({
    description: '水位档的手选时刻 (ISO); 未选时为 null',
    type: 'string',
    nullable: true,
    example: '2026-08-04T02:15:00.000Z',
  })
  positionBucketSetAt!: string | null;

  @ApiProperty({
    description: '意图矩阵输出; pending = 水位未选 (MUST NOT 静默取一档)',
    enum: [...LEG_INTENTS],
    example: 'rent',
  })
  intent!: string;

  @ApiProperty({
    description: '收租意图的 Δ 深度档; 其余三态恒 null',
    enum: [...RENT_DEPTHS],
    nullable: true,
    example: 'moderate',
  })
  rentDepth!: string | null;

  @ApiProperty({
    description:
      '**该视角、已精排、已截断**的腿 (053 FR-002 / FR-004) —— 已滤非标 (FR-008) 与已到期 ' +
      '(FR-028a)。🚨 **数组顺序就是呈现顺序**: 客户端 MUST 按本数组的下标序渲染、MUST NOT 自行' +
      '重排 (047 那份并行的有序 code 列表据此退役 —— 同一个顺序下发两份表达必 drift, 而两份 ' +
      '各自都渲染得出来)。' +
      '🚫 **实际显示条数不另发**: 它恒等于 legs.length, 「其余 N−D 条」由 matchedCount 减它现算。' +
      '死档行与 greeks 缺失行照常在内 (后者不判档)',
    type: LegResponse,
    isArray: true,
  })
  legs!: LegResponse[];

  @ApiProperty({
    description:
      '两道门槛各自挡下多少条 (FR-008) ——「有腿消失了」必须可见且可行动。🚨 两个数**语义不对称**, ' +
      '见各自字段说明',
    type: LegGateCountsResponse,
  })
  gateCounts!: LegGateCountsResponse;

  @ApiProperty({
    description:
      '**本次视角**的档位判定口径 (FR-023) —— 下发而非让客户端硬编码这份映射 (硬编码必与 server ' +
      '漂移, 且漂移时两边都算得出结果)。每腿的 tier 就是按它判出来的。全腿视角**恒年化** (混着 ' +
      '10 天与 200 天的腿, 周化档界会让整列全是死档)',
    enum: [...LEG_BASES],
    example: 'annualized',
  })
  basis!: string;

  @ApiProperty({
    description:
      '**本次视角**的检索条件全景 (052 FR-011 / FR-029) —— 控件填 defaults, 结果按 effective, ' +
      '仅 narrowed 的维度出计数。📌 053 起只发一份: 052 恒发三份的前提是' +
      '「本地切视角不发请求」, 而那条承诺已由 FR-019b 整条作废。链未就绪时六维全 null —— 那是' +
      '「没有值」不是「不限」',
    type: PerspectiveCriteriaResponse,
  })
  criteria!: PerspectiveCriteriaResponse;

  @ApiProperty({
    description:
      '本次条件下**该视角**的成员数 —— 表达层截断**之前**的条数 (053 FR-005 / FR-015)。' +
      '⚠️ **candidateCapDropped 非零时本数会静默失真** (FR-019c): 它算在已被候选上限 K 砍过的' +
      '集合上 ⇒ 表达层 MUST 说明本数可能不完整',
    type: 'integer',
    example: 137,
  })
  matchedCount!: number;

  @ApiProperty({
    description:
      '**无覆盖口径**下该视角的成员数 (053 FR-009) —— 未覆盖任何条件时恒 === matchedCount, ' +
      '此时区块头 MUST NOT 并列显示两个相等的数。🚫 MUST NOT 用六维边际计数加总充当它 (边际口径' +
      '下被两维同时挡下的腿两维都不计它, 加总少报)',
    type: 'integer',
    example: 212,
  })
  memberCount!: number;

  @ApiProperty({
    description:
      '本次生效的表达层截断阈值 N; **null = 不设该视角阈值** ⇒ 零截断 (053 FR-011 / FR-013)。' +
      '🚨 **未触发截断时也照常下发** (FR-015): 只在截断时下发会让「链规模逼近阈值」恰恰观测不到。' +
      '逼近度 matchedCount / displayLimit 由此随时可算 ⇒ 🚫 MUST NOT 为它新增 isNearLimit ' +
      '之类的派生布尔 (下发第二份必 drift)',
    type: 'integer',
    nullable: true,
    example: 200,
  })
  displayLimit!: number | null;

  @ApiProperty({
    description:
      '触及召回层候选上限 K 时被切掉多少条 (052 FR-028); 未触及恒 0。🚨 **它是保险丝熔断不是判据' +
      '挡下** ⇒ 蓄意不进 gateCounts, 呈现侧 MUST 与截断计数**不同款** (053 FR-019c): 前者该调' +
      '容量、后者该调展示。非零时 matchedCount 可能不完整, 提示 MUST 说明这一点',
    type: 'integer',
    example: 0,
  })
  candidateCapDropped!: number;
}

/**
 * 查询串 → 召回层的用户覆盖 (052 FR-012)。
 *
 * 🚨 **缺键 = 未覆盖, 空串 = 覆盖为不限** —— 逐键判 `!== undefined` 而非真值判断: `''` 与 `'0'`
 * 都是假值, 真值判断会把「覆盖为不限」和「下限设为 0」双双吞成「没动过」, 而**三态照样出得来**。
 *
 * 🚨 **DTE 段两端 MUST 成对** (见 {@link LegRetrievalQuery.dteMin}): 只给一端 → 400。补另一端
 * 需要该视角的默认段, 而那要 spot —— 在这里算就是 FR-011 禁的第二处计算。
 *
 * 📌 **053 起本函数不再校验 `perspective` 缺失** —— 它已升为必填 (见 {@link LegRetrievalQuery}),
 * 缺参在 `ValidationPipe` 那一层就是 400, 到不了这里。留一条够不到的分支只会让「谁在守这条」
 * 变成两处各说各话。
 *
 * @throws BadRequestException DTE 段或活性下限只给了一端。
 */
export function toRetrievalOverride(query: LegRetrievalQuery): RetrievalOverride | null {
  // 逐键赋值 ⇒ 构建期需要可变形态; 返回时收窄回只读的 `Partial<RetrievalCriteria>`。
  const criteria: { -readonly [K in keyof RetrievalCriteria]?: RetrievalCriteria[K] } = {};
  const decimalOf = (raw: string) => (raw === '' ? null : new Prisma.Decimal(raw));
  const intOf = (raw: string) => (raw === '' ? null : Number.parseInt(raw, 10));

  if (query.strikeMax !== undefined) criteria.strikeMax = decimalOf(query.strikeMax);
  if (query.strikeMin !== undefined) criteria.strikeMin = decimalOf(query.strikeMin);
  if (query.premiumMin !== undefined) criteria.premiumMin = decimalOf(query.premiumMin);
  if (query.relativeSpreadMax !== undefined) {
    criteria.relativeSpreadMax = decimalOf(query.relativeSpreadMax);
  }

  // 活性：两个值成对（同 DTE 段——一个维度、一对数）。
  const hasOi = query.oiMin !== undefined;
  const hasVol = query.volMin !== undefined;
  if (hasOi !== hasVol) {
    throw new BadRequestException(
      'oiMin 与 volMin MUST 成对出现 —— 活性是一个维度、值是一对数 (OI 或 当日成交)，半对不是合法维度值',
    );
  }
  if (hasOi && hasVol) {
    const oi = intOf(query.oiMin!);
    const volume = intOf(query.volMin!);
    criteria.livenessMin = oi === null || volume === null ? null : { oi, volume };
  }

  const hasMin = query.dteMin !== undefined;
  const hasMax = query.dteMax !== undefined;
  if (hasMin !== hasMax) {
    throw new BadRequestException(
      'dteMin 与 dteMax MUST 成对出现 —— DTE 段是一个维度、值是闭区间, 半个区间不是合法维度值',
    );
  }
  if (hasMin && hasMax) {
    const min = intOf(query.dteMin!);
    const max = intOf(query.dteMax!);
    criteria.dteBand = min === null || max === null ? null : { min, max };
  }

  const touched = Object.keys(criteria).length > 0;
  if (!touched) return null;
  return { perspective: toRequestedPerspective(query), criteria };
}

/**
 * 查询串 → **本次要作答的视角** (053 FR-001)。`O(1)`。
 *
 * 🚨 **取值域由 `@IsIn([...LEG_TABS])` 在 `ValidationPipe` 那一层守死** ⇒ 这里的断言不是「相信
 * 客户端」而是「相信管道」。🚫 MUST NOT 在这里再写一遍三值校验: 两处各判一次, 哪一处说了算就
 * 变成运行时才知道的事 (同 052 对「成员判据只有一个落点」的纪律)。
 */
export function toRequestedPerspective(query: LegRetrievalQuery): LegTab {
  return query.perspective as LegTab;
}

function toCriteriaResponse(criteria: RetrievalCriteria): RetrievalCriteriaResponse {
  return {
    strikeMax: decimal4(criteria.strikeMax),
    strikeMin: decimal4(criteria.strikeMin),
    dteBand: criteria.dteBand === null ? null : { ...criteria.dteBand },
    premiumMin: decimal4(criteria.premiumMin),
    livenessMin: criteria.livenessMin === null ? null : { ...criteria.livenessMin },
    relativeSpreadMax: decimal4(criteria.relativeSpreadMax),
  };
}

function toPerspectiveCriteriaResponse(criteria: PerspectiveCriteria): PerspectiveCriteriaResponse {
  const outcomes = {} as RetrievalOutcomesResponse;
  // 🚨 按 `RETRIEVAL_CRITERION_KEYS` 展开而不是逐字段抄: 加一个维度而这里漏映射, 响应里那一维
  // 就静默缺席 —— 而客户端照样渲染得出来 (缺的那格没有控件, 没人会发现)。
  for (const key of RETRIEVAL_CRITERION_KEYS) {
    outcomes[key] = { ...criteria.outcomes[key] };
  }
  return {
    defaults: toCriteriaResponse(criteria.defaults),
    effective: toCriteriaResponse(criteria.effective),
    outcomes,
  };
}

function toLegActivityResponse(mark: ActivityMark | null): LegActivityResponse | null {
  return mark === null
    ? null
    : { isRoundStrike: mark.isRoundStrike, isTopRanked: mark.isTopRanked, label: mark.label };
}

export function toLegTableResponse(view: LegTableView): LegTableResponse {
  return {
    symbol: view.symbol,
    perspective: view.perspective,
    state: view.state,
    asOf: dateOnly(view.asOf),
    asOfFreshnessTier: freshnessTier(dateOnly(view.asOf), view.lastClosedSession),
    priceKind: view.priceKind,
    // 🚫 **MUST NOT 由 `priceKind` 推导** (064 T007a): 两个字段答的是两个问题, 任一方由另一方
    // 算出来都会把它们坍缩成一个 —— 而坍缩后的响应在「正常盘后」与「盘中源挂了」上完全一样。
    realtimeDegrade: view.realtimeDegrade,
    quoteAsOf: quoteAsOfText(view.priceKind, view.asOf, view.quoteAsOf),
    oiAsOf: dateOnly(view.oiAsOf),
    source: view.source,
    spot: decimal4(view.spot),
    w: view.w.toFixed(4),
    zone: view.zone,
    lLevel: view.lLevel,
    positionBucket: view.positionBucket,
    positionBucketSource: view.positionBucketSource,
    positionBucketSetAt:
      view.positionBucketSetAt === null ? null : view.positionBucketSetAt.toISOString(),
    intent: view.intent,
    rentDepth: view.rentDepth,
    legs: view.legs.map((leg) => ({
      code: leg.code,
      strike: leg.strike.toFixed(4),
      expiryDate: dateOnly(leg.expiryDate)!,
      dteDays: leg.dteDays,
      bid: decimal4(leg.bid),
      ask: decimal4(leg.ask),
      // 单笔权利金是**金额** ⇒ 定标 2 位 (同 turnover, 两者共用那一个合约乘数);
      // 相对价差是**无量纲比例** ⇒ 定标 4 位 (同 criteria 里的 relativeSpreadMax, 两处要能直接比)。
      contractPremium: leg.contractPremium === null ? null : leg.contractPremium.toFixed(2),
      relativeSpread: decimal4(leg.relativeSpread),
      bidSize: leg.bidSize,
      askSize: leg.askSize,
      basis: leg.basis,
      periodRate: leg.periodRate === null ? null : leg.periodRate.toFixed(6),
      weeklyRate: leg.weeklyRate === null ? null : leg.weeklyRate.toFixed(6),
      annualizedRate: leg.annualizedRate === null ? null : leg.annualizedRate.toFixed(6),
      tier: leg.tier,
      askRate: leg.askRate === null ? null : leg.askRate.toFixed(6),
      effectiveCost: decimal4(leg.effectiveCost),
      effectiveCostVsWPct:
        leg.effectiveCostVsWPct === null ? null : leg.effectiveCostVsWPct.toFixed(2),
      absDelta: leg.absDelta,
      sigmaDistance: leg.sigmaDistance,
      openInterest: leg.openInterest,
      volume: leg.volume,
      turnover: leg.turnover === null ? null : leg.turnover.toFixed(2),
      activity: toLegActivityResponse(leg.activity),
      isRecommended: leg.isRecommended,
      isMonthlyChain: leg.isMonthlyChain,
      earningsMark:
        leg.earningsMark === null
          ? null
          : {
              mark: leg.earningsMark.mark,
              bufferShortfallDays: leg.earningsMark.bufferShortfallDays,
              lastEarningsDate: leg.earningsMark.lastEarningsDate,
            },
      greeksComplete: leg.greeksComplete,
      // 🚫 逐行原样带出, MUST NOT 拿 `view.priceKind` 填 —— 部分缺失时两者本就不同 (FR-009)。
      priceKind: leg.priceKind,
      bandStatus: leg.bandStatus,
    })),
    gateCounts: {
      removedByPremiumFloor: view.gateCounts.removedByPremiumFloor,
      excludedFromIntentTabs: view.gateCounts.excludedFromIntentTabs,
    },
    // 🚨 **取自 `leg-rank.rules.ts` 的那一份常量, 不在这里重写一遍字面量** —— 每腿的 `tier`
    // 正是按它判出来的, 抄一份在此会让「口径改了但下发的还是旧的」不红任何一处。
    // 判据在 rules、档位在 DTO 层合成: 同 `asOfFreshnessTier` 那条分工 (046 起的体例)。
    basis: BASIS_BY_TAB[view.perspective],
    criteria: toPerspectiveCriteriaResponse(view.criteria),
    matchedCount: view.matchedCount,
    memberCount: view.memberCount,
    displayLimit: view.displayLimit,
    candidateCapDropped: view.candidateCapDropped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 055 标的链分析报表 (plan D-API-1 / D-API-2) —— 四段: 每格 / 每列 / 每行 / 链级读数
// ─────────────────────────────────────────────────────────────────────────────

export class ChainReportCellResponse {
  @ApiProperty({
    description:
      '格态。valued 有值 / gated **有腿但被门槛挡下** / absent 该位置无合约。' +
      '🚨 后两者 MUST 视觉可分且**不依赖图例** (FR-017): 「有腿但太便宜」与「压根没这张合约」' +
      '是两条完全不同的处置路径。📌 `gated` 归并了三类成因 (权利金门槛 / 当前格值视角不召回 / ' +
      '该口径算不出值), 段内不再细分 —— 那属于选约表那一层 (FR-016a 显式接受的代价)',
    enum: [...CHAIN_REPORT_CELL_STATES],
    example: 'valued',
  })
  state!: string;

  @ApiProperty({
    description:
      '格内腿数 (FR-007) —— **当前格值下算得出值的成员条数**, 非 valued 恒 0。' +
      '🚨 它与格态同为**当前格值的函数**, 🚫 MUST NOT 缓存成格的静态属性 (实测全网格填充率 ' +
      '建仓 6.3% / 收租 13.6% / 全腿 41.6%)',
    example: 3,
  })
  legCount!: number;

  @ApiProperty({
    description:
      '该格**最优**值 (FR-006: 取最优不取均值); 非 valued 恒 null。' +
      '🚨 **量纲随格值变**, 见所属网格的说明: 建仓成色是百分数 / 两种年化是小数比例 / ' +
      '活跃度是张数。定标一律 6 位, 客户端按格值决定怎么显示',
    type: 'string',
    nullable: true,
    example: '0.237012',
  })
  best!: string | null;

  @ApiProperty({
    description:
      '该格**次优**值 (FR-027 读数面板要)。🚨 **格内只有一条腿时显式 null** (FR-028), ' +
      '🚫 MUST NOT 复述最优值充数 —— 次优存在的意义正是回答「这一格是一条腿撑起来的、还是' +
      '一片腿都不错」。📌 两条腿取值**相等**时它 = 那个值而**不是** null: 判据是腿数不是取值互异',
    type: 'string',
    nullable: true,
    example: '0.185004',
  })
  runnerUp!: string | null;
}

export class ChainReportBandCoverageResponse {
  @ApiProperty({ description: '建仓成色格值下本列是否落在建仓召回段内', example: true })
  buildQuality!: boolean;

  @ApiProperty({ description: '收租年化格值下本列是否落在收租召回段内', example: true })
  rentAnnualized!: boolean;

  @ApiProperty({ description: '全腿年化 —— 全腿视角不设期限段 ⇒ **恒 true**', example: true })
  allAnnualized!: boolean;

  @ApiProperty({ description: '活跃度 —— 同上, **恒 true**', example: true })
  activity!: boolean;
}

export class ChainReportColumnResponse {
  @ApiProperty({ description: '到期日 (YYYY-MM-DD)', example: '2026-09-18' })
  expiryDate!: string;

  @ApiProperty({ description: '期限天数 (整数日历日, 到期日当天 = 0)', example: 38 })
  dteDays!: number;

  @ApiProperty({
    description:
      '是否月度到期链 —— 判据与选约表**同一处** (该月第三个周五, 非交易日则取其前一交易日)。' +
      '📌 **「是否跨财报」蓄意不在本响应内** (2026-08-14 定): mockup 未画、零 FR 要求, 且列头多' +
      '一个 chip 要吃掉 FR-041 已经很紧的一屏高度预算',
    example: true,
  })
  isMonthlyChain!: boolean;

  @ApiProperty({
    description:
      '该到期日的**平值**隐含波动率, vendor 原样**百分数** (25.5 = 25.5%), 由跨现价两侧的相邻' +
      '行权价线性插值得出 (FR-022)。🚨 **插值不可得 ⇒ null ⇒ 曲线该点断开** (FR-023), ' +
      '🚫 MUST NOT 以任何形式填充 —— 补一个值进去, 用户读到的就是一条连续的期限结构, 而它有' +
      '一段是编的。🚫 客户端 MUST NOT 再 ×100',
    type: 'number',
    nullable: true,
    example: 26.31,
  })
  atmIv!: number | null;

  @ApiProperty({
    description:
      '**每种格值**下本列是否落在其对应视角的召回段内。一个字段同时服务两处呈现, 蓄意不拆: ' +
      'FR-009 的两条召回段范围框取前两项 (重叠列两框并存, 🚫 不归给其中一段); FR-009a 的整列' +
      '淡出看**当前格值**那一项。🚨 客户端 MUST NOT 自己做「格值 → 视角」的映射 —— 两处各写' +
      '一份会出现「格有值但整列淡出」这种自相矛盾, 而两边都渲染得出来',
    type: ChainReportBandCoverageResponse,
  })
  inRecallBand!: ChainReportBandCoverageResponse;
}

export class ChainReportRowResponse {
  // 📌 本类的示例取「价外 30–40%」那一档而非更直观的 10–20%: 后者的上界示例串会是 `0.2000`,
  //    与召回层的权利金绝对下限**撞子串**, 被 `check-optionsdesk-rule-constants` 判成阈值外溢
  //    (那道守门认值不认名)。撞的是示例不是语义, 故改示例而不是放宽守门。
  @ApiProperty({ description: '行序, 0 = 价内那一档, 自上而下', example: 4 })
  index!: number;

  @ApiProperty({
    description:
      '价外幅度下界 (**闭**), 小数比例; 负值 = 价内。档宽等距 10%、下界为价内 10% (FR-002)',
    example: '0.3000',
  })
  otmFloor!: string;

  @ApiProperty({
    description:
      '价外幅度上界 (**开**); null = **顶档无上界**。🚨 顶档开口吸收其上全部腿 —— 掉出网格的腿' +
      '既不在图上又不在三个互斥计数的任何一个里, SC-006 的求和恒等式会静默对不上账',
    type: 'string',
    nullable: true,
    example: '0.4000',
  })
  otmCeiling!: string | null;

  @ApiProperty({
    description: '对应行权价下界 (**开**), 随现价变; null = 顶档无下界',
    type: 'string',
    nullable: true,
    example: '107.8800',
  })
  strikeFloor!: string | null;

  @ApiProperty({ description: '对应行权价上界 (**闭**), 随现价变', example: '125.8600' })
  strikeCeiling!: string;
}

export class ChainReportGateCountsResponse {
  @ApiProperty({ description: '该链全量腿数 —— ① 的分母, 也是求和恒等式的右端', example: 825 })
  total!: number;

  @ApiProperty({
    description:
      '① 被**权利金门槛**移出 (分母 = total)。语义「太便宜」, **整条不在图上**。实测 27.0%',
    example: 252,
  })
  removedByPremium!: number;

  @ApiProperty({
    description: '骨架 = 过权利金门槛之后的整条链 (FR-005) —— ② 的分母',
    example: 573,
  })
  skeleton!: number;

  @ApiProperty({
    description: '② 被**行下界**排除 (分母 = skeleton)。语义「太深的价内」, 在行轴之外。实测 57.6%',
    example: 261,
  })
  outsideRowFloor!: number;

  @ApiProperty({ description: '行下界内 —— ③ 的分母', example: 312 })
  withinRows!: number;

  @ApiProperty({
    description:
      '③ 被**活性门槛**挡下 (分母 = withinRows)。语义「没人碰过」, **在图上**呈 gated。实测 11.0%。' +
      '🚨 它的必要性不是量级而是**唯一性**: 全腿格值下活性门槛是「被门槛挡下」格的唯一成因, ' +
      '不给量级用户就只知道有灰格、不知道那是多少条腿',
    example: 38,
  })
  blockedByLiveness!: number;

  @ApiProperty({
    description:
      '④ 有值 —— 过两道一律门槛且落在行轴内的腿数。🚨 **腿级、与当前格值无关**, ' +
      '🚫 MUST NOT 与格态的 valued 混读 (后者是格的态、随格值重算)。' +
      '📌 三个计数与它相加**恒等于 total** (SC-006), 且该恒等式在切换格值时不变',
    example: 274,
  })
  valued!: number;
}

@ApiExtraModels(ChainReportCellResponse)
export class ChainReportGridsResponse {
  @ApiProperty({
    description:
      '建仓成色网格 —— 值 = 有效成本相对愿买价的位置, **百分数**, 越低越好 (FR-011)。' +
      '成员集 = 建仓视角召回集',
    type: 'array',
    items: { type: 'array', items: { $ref: getSchemaPath(ChainReportCellResponse) } },
  })
  buildQuality!: ChainReportCellResponse[][];

  @ApiProperty({
    description: '收租年化网格 —— 值 = 年化费率, **小数比例**, 越高越好。成员集 = 收租视角召回集',
    type: 'array',
    items: { type: 'array', items: { $ref: getSchemaPath(ChainReportCellResponse) } },
  })
  rentAnnualized!: ChainReportCellResponse[][];

  @ApiProperty({
    description:
      '全腿年化网格 —— 与上一格同一个年化数, **差别只在成员集** (全腿视角)。' +
      '🚨 客户端 MUST 让**价内那一行不参与色阶** (FR-019c): 该行的高年化是内在价值造成的算术' +
      '假象 (实测 max 948.3%), 读数 / 腿数 / 下钻照常可用',
    type: 'array',
    items: { type: 'array', items: { $ref: getSchemaPath(ChainReportCellResponse) } },
  })
  allAnnualized!: ChainReportCellResponse[][];

  @ApiProperty({
    description:
      '活跃度网格 —— 值 = 活动量 (OI + 当日成交, **张数**), 越高越好 (FR-013)。' +
      '🚨 本格值的时点标注 MUST 跟 `oiAsOf` 而非 `asOf` (FR-014): 二者常态下不是同一天',
    type: 'array',
    items: { type: 'array', items: { $ref: getSchemaPath(ChainReportCellResponse) } },
  })
  activity!: ChainReportCellResponse[][];
}

export class ChainReportResponse {
  @ApiProperty({ description: 'canonical `market:code`', example: 'us:PEP' })
  symbol!: string;

  @ApiProperty({
    description:
      '屏级状态。chain_not_ready (采集还没轮到, 是事实) 与 read_failed (跨 ctx 读故障) 蓄意分开',
    enum: [...CHAIN_REPORT_STATES],
    example: 'available',
  })
  state!: string;

  @ApiProperty({
    description: 'vendor 随链下发的标的价, **未复权** —— 页头显示, 也是行轴换算行权价区间的分母',
    type: 'string',
    nullable: true,
    example: '179.8000',
  })
  spot!: string | null;

  @ApiProperty({
    description: '本次检索所用的**交易所的今天** (FR-033 ①)',
    type: 'string',
    nullable: true,
    example: '2026-08-11',
  })
  marketDate!: string | null;

  @ApiProperty({
    description:
      '快照归属交易日 (FR-033 ②)。🚨 **实时独载基线 (source=realtime) 下它是「交易所的今天」**' +
      ' —— 库内一期快照都没有时, 屏上的数全部来自此刻, 归属正在进行的这一场',
    type: 'string',
    nullable: true,
    example: '2026-08-11',
  })
  asOf!: string | null;

  @ApiProperty({
    description:
      '**区块级**时间口径 (064 FR-009 / FR-010) —— 本批腿整体处于哪个档, 也决定下一字段 ' +
      'quoteAsOf 的**粒度**。realtime = 本次取到了此刻的盘口; eod_close = 走库内收盘档 ' +
      '(未开实时 / 非交易时段 / 源不可达 / 超单批上限 / 定窗基准陈旧, 一律落这一档)。' +
      '🚨 **与每腿的 priceKind 不是同一个数** (见 LegResponse.priceKind): 部分合约未返回时' +
      '本字段仍是 realtime 而那几行是 eod_close。区块条读这个, 行级角标读那个',
    enum: [...PRICE_KINDS],
    example: 'realtime',
  })
  priceKind!: string;

  @ApiProperty({
    description:
      '**本该给实时却没给成** (064 FR-010 / FR-011) —— 正常收盘档恒 null。' +
      '🚨 **它与 priceKind 回答两个不同的问题**: 后者说「这批是什么档」, 本字段说「此刻**本该**' +
      '是什么档」。非 null 的充要条件 = 调用方开了实时 **且** 两闸 (市场时段 ∩ 交易日历) 判定' +
      '此刻本该外呼, 而最终仍落收盘档。' +
      '🚨 **非交易时段 / 非交易日 / 未开实时 ⇒ 恒 null** —— 北京白天美股休市走收盘档是常态, ' +
      '给它刷降级 = 造一个永远为真的告警。' +
      '🚫 客户端 MUST NOT 拿 priceKind 反推本字段 (反推出来的标在「正常盘后」与「盘中源挂了」' +
      '两种情形下都渲染得出来, 而那恰是本 feature 要分开的两件事)。' +
      '📌 值域**不含** partial_miss: 部分合约未返回是**逐行**降级, 由每腿的 priceKind 承载、' +
      '本字段仍为 null。' +
      'window_over_cap = 候选范围内条数超单批上限 (fail-closed 零外呼); ' +
      'window_basis_stale = 定窗基准缺失 / 陈旧; source_unavailable = 源不可达或请求级超时; ' +
      'gate_unknown = 两闸自身故障, 不知道此刻该不该外呼',
    enum: [...REALTIME_CHAIN_DEGRADE_KINDS],
    nullable: true,
    example: 'source_unavailable',
  })
  realtimeDegrade!: string | null;

  @ApiProperty({
    description:
      '本批报价的时点, **粒度即档位** (064 FR-010 / FR-014): priceKind=realtime ⇒ ISO-8601 ' +
      '**时刻** (含秒); priceKind=eod_close ⇒ 该批快照归属的**交易日** `YYYY-MM-DD`。' +
      '🚨 两档混成一种形态不会红任何一处, 但会让「数据截至 X · 收盘」的呈现出错 —— 收盘档带上' +
      '时分秒会被读成此刻的盘口, 实时档只给日期则抹掉唯一要紧的那件事。' +
      '🚫 客户端 MUST NOT 自己截断或补齐粒度 (那就是把档位判据抄了第二份)',
    type: 'string',
    nullable: true,
    example: '2026-08-11T20:15:00.000Z',
  })
  quoteAsOf!: string | null;

  @ApiProperty({
    description:
      '🚨 **OI 的归属交易日** (FR-033 ③) —— 与 asOf **不是同一天**。三个时点 MUST 各自成句, ' +
      '🚫 MUST NOT 合并成一个「数据截至」。064 起实时档下它仍是那个归属日 (OI 盘中冻结)。' +
      '🚨 实时独载基线下 OI 改由同一批实时给出, 而本字段取最近一个已收盘交易日 —— 两者由构造对齐',
    type: 'string',
    nullable: true,
    example: '2026-08-10',
  })
  oiAsOf!: string | null;

  @ApiProperty({
    description:
      '这批数从哪来 (eod / premarket_backfill / realtime)。realtime = **实时独载基线**: ' +
      '库内一期收盘快照都没有, 整条链由这一次实时取回撑起 (新锚盘中首访, 当晚收盘轮跑完即自愈)',
    type: 'string',
    nullable: true,
    example: 'eod',
  })
  source!: string | null;

  @ApiProperty({
    description:
      '链级 IV 分位读数 —— **复用详情读端那一份**四态与形状 (FR-031), 无第二套词汇。' +
      '🚨 它按**自己的**四态独立降级, **不被网格失败波及**: 网格挂了 IV 明明读得到',
    type: UnderlyingIvReadoutResponse,
  })
  iv!: UnderlyingIvReadoutResponse;

  @ApiProperty({
    description: '锚被排除 (excluded) ⇒ 报表照常渲染, 页头带标记 (spec Assumptions)',
    example: false,
  })
  anchorExcluded!: boolean;

  @ApiProperty({
    description: '页脚三个互斥计数 + 有值条数, 每个带自己的分母 (FR-034)',
    type: ChainReportGateCountsResponse,
  })
  gateCounts!: ChainReportGateCountsResponse;

  @ApiProperty({
    description: '行轴 (价外幅度档) —— 恒 8 行, 与链无关; 行权价区间随现价变',
    type: [ChainReportRowResponse],
  })
  rows!: ChainReportRowResponse[];

  @ApiProperty({
    description:
      '列轴 = 链上**实际存在**的到期日, 升序, 🚫 不分箱 (FR-003)。' +
      '🚨 曲线的点数与本数组长度**恒等**且逐列对齐 (FR-020 / SC-005)',
    type: [ChainReportColumnResponse],
  })
  columns!: ChainReportColumnResponse[];

  @ApiProperty({
    description:
      '四种格值**一次返齐**, 同一个骨架 (plan D-API-2)。四张网格的维度均为 `rows × columns` 且' +
      '逐格对应, 🚫 客户端 MUST NOT 为切换格值再发请求 —— 拆请求会让切换时先空后填、四发的 ' +
      'spot / asOf 可能落在不同批报价上, **骨架会跳**, 而那正是本片唯一不能出错的东西 (SC-002)。' +
      '⚠️ 「位置不变」MUST NOT 被读成「格态不变」: 四种格值跑在**不同的召回集**上, 同一格在一种' +
      '格值下有值、在另一种下呈空是**正确行为**',
    type: ChainReportGridsResponse,
  })
  cells!: ChainReportGridsResponse;
}

/** `[行][列]` 网格 → DTO。定标 6 位, 量纲随格值变 (见 {@link ChainReportGridsResponse})。 */
function toChainReportGrid(grid: ChainReportGrid): ChainReportCellResponse[][] {
  return grid.map((row) =>
    row.map((cell) => ({
      state: cell.state,
      legCount: cell.legCount,
      best: cell.best === null ? null : cell.best.toFixed(6),
      runnerUp: cell.runnerUp === null ? null : cell.runnerUp.toFixed(6),
    })),
  );
}

export function toChainReportResponse(view: ChainReportView): ChainReportResponse {
  return {
    symbol: view.symbol,
    state: view.state,
    spot: decimal4(view.spot),
    marketDate: view.marketDate,
    asOf: dateOnly(view.asOf),
    priceKind: view.priceKind,
    // 🚫 **MUST NOT 由 `priceKind` 推导** (064 T007a): 两个字段答的是两个问题, 任一方由另一方
    // 算出来都会把它们坍缩成一个 —— 而坍缩后的响应在「正常盘后」与「盘中源挂了」上完全一样。
    realtimeDegrade: view.realtimeDegrade,
    quoteAsOf: quoteAsOfText(view.priceKind, view.asOf, view.quoteAsOf),
    oiAsOf: dateOnly(view.oiAsOf),
    source: view.source,
    // 🚨 与详情读端 / 温度计**同一个投影函数** —— 三处的降级读数必须逐字节同形, 各写各的就会
    // 出现「详情说 missing、报表说 unavailable」这种同一事实两种说法。
    iv: toUnderlyingIvReadoutResponse(view.iv, view.lastClosedSession),
    anchorExcluded: view.anchorExcluded,
    gateCounts: { ...view.gateCounts },
    rows: view.rows.map((row) => ({
      index: row.index,
      otmFloor: row.otmFloor.toFixed(4),
      otmCeiling: row.otmCeiling === null ? null : row.otmCeiling.toFixed(4),
      strikeFloor: decimal4(row.strikeFloor),
      strikeCeiling: row.strikeCeiling.toFixed(4),
    })),
    columns: view.columns.map((column) => ({
      expiryDate: dateOnly(column.expiryDate)!,
      dteDays: column.dteDays,
      isMonthlyChain: column.isMonthlyChain,
      atmIv: column.atmIv,
      inRecallBand: {
        buildQuality: column.inRecallBand.build_quality,
        rentAnnualized: column.inRecallBand.rent_annualized,
        allAnnualized: column.inRecallBand.all_annualized,
        activity: column.inRecallBand.activity,
      },
    })),
    cells: {
      buildQuality: toChainReportGrid(view.cells.build_quality),
      rentAnnualized: toChainReportGrid(view.cells.rent_annualized),
      allAnnualized: toChainReportGrid(view.cells.all_annualized),
      activity: toChainReportGrid(view.cells.activity),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 059 guest 面: 模型导入 + 待审提交
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/optionsdesk/anchors/model-import —— 本人的模型估值导入 (059 FR-001)。
 *
 * 🚨 **DTO 只管形状, 不复写语义判据**: canonical 写法 / 市场白名单 / 置信度量表的判定单点在
 * `anchor-import.rules.ts`, 由写侧调用。两处各写一份必漂, 而漂的表现是「通道放行、服务端
 * 400」或反过来 —— 排障时要对两份正则才看得出来。
 *
 * 🚨 **既有 `CreateAnchorRequest` / `UpdateAnchorRequest` 一字不动** (Guardrail 11; spec 契约:
 * 045 与 mobile 零变化)。手滑给既有 DTO 补 `@Min/@Max` 会让 App 侧既有请求开始 400。
 *
 * `confidenceSource` **不在本 DTO 里**: 来源是系统对写入路径的判断, 不是调方的声明
 * (FR-008) —— 可声明即可伪造, 「来自模型」这个信号就失去意义。
 *
 * 🚨 **`ticker` 走 query string 而不是 body**: nginx 的 `$arg_*` **只读得到 query**, 通道层那道
 * 市场闸 (`$arg_ticker !~ "^(us|hk):"`) 才成立。放进 body 的话 nginx 看不见它, 闸退化成摆设
 * —— 与 057 研报三项元数据走 query 是同一个理由。
 */
export class ModelImportAnchorRequest {
  @ApiProperty({ description: '估值 V (数值串; V ≤ 0 拒绝)', example: '50.0000' })
  @IsNumberString()
  v!: string;

  @ApiProperty({
    description: '估值 as-of 日 (YYYY-MM-DD) —— 服务端不回落「今天」',
    example: '2026-06-30',
  })
  @IsDateString()
  asof!: string;

  @ApiProperty({ description: '估值方法名 (策略 SoT 词表)', example: 'dcf', maxLength: 32 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  method!: string;

  @ApiProperty({ description: '置信度 (10 分制数值串, 越界拒)', example: '9.50' })
  @IsNumberString()
  confidence!: string;
}

/**
 * POST /api/v1/optionsdesk/anchors/submissions —— 其他访客的估值提交 (059 FR-011)。
 * 字段与导入口同形 (采纳 = 原样重放) + 一个自由附言。
 */
export class SubmitAnchorRequest extends ModelImportAnchorRequest {
  @ApiPropertyOptional({
    description: '附言 (估值理由 / 数据来源等; 系统不解析)',
    type: 'string',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

/** 差异报告一条 = 一个被本次导入冲掉的人工位 (FR-007「逐条回报」)。 */
export class AnchorFallbackEntryResponse {
  @ApiProperty({ description: 'canonical `market:code`', example: 'us:AOS' })
  ticker!: string;

  @ApiProperty({
    description: '被冲掉的人工位',
    enum: [...ANCHOR_MANUAL_SLOTS],
    example: 'lLevel',
  })
  slot!: string;

  @ApiProperty({ description: '被冲掉的人工值', example: 'L3' })
  manualValue!: string;

  @ApiProperty({
    description: '回落后的模型值 / 派生值; L4 档无上限口径 ⇒ null (禁自造)',
    type: 'string',
    nullable: true,
    example: 'L1',
  })
  fallbackValue!: string | null;
}

/** 导入结果 —— `action` 是 FR-016 的载体, `fallbackEntries` 是 FR-007 的载体。 */
export class AnchorImportResponse {
  @ApiProperty({
    description:
      '本次是新建 / 更新 / 值未变未写入。新建锚会让当日采集多做一整轮历史回填与全链发现, ' +
      '该事实必须对调方可见, 否则「某日采集突然变慢」事后无从归因 (FR-016)。',
    enum: ['create', 'update', 'noop'],
    example: 'update',
  })
  action!: string;

  @ApiProperty({ description: '写入后的锚 (noop 时为现值)', type: AnchorResponse })
  anchor!: AnchorResponse;

  @ApiProperty({
    description: '被本次导入冲掉的人工调整, 逐条列出 (禁静默回落); 无人工调整时为空数组',
    type: [AnchorFallbackEntryResponse],
  })
  fallbackEntries!: AnchorFallbackEntryResponse[];
}

/** 提交回执 —— **只回执, 不回读**: 提交方看不到锚, 也看不到自己此前提交过什么 (FR-013)。 */
export class AnchorSubmissionResponse {
  @ApiProperty({ description: '待审条目 id (数字串)', example: '3' })
  id!: string;

  @ApiProperty({ description: '提交方 (由通道无条件覆写的 X-Guest 头得来)', example: 'guest-a' })
  submitter!: string;

  @ApiProperty({ description: 'canonical `market:code`', example: 'us:AOS' })
  ticker!: string;

  @ApiProperty({
    description: '处置状态 (系统只写 PENDING)',
    enum: [...ANCHOR_SUBMISSION_STATUSES],
    example: 'PENDING',
  })
  status!: string;

  @ApiProperty({ description: '收件时刻 (ISO-8601)', example: '2026-08-16T12:00:00.000Z' })
  createdAt!: string;
}

export function toAnchorImportResponse(result: ImportAnchorFromModelResult): AnchorImportResponse {
  return {
    action: result.action,
    anchor: toAnchorWriteResponse(result.anchor),
    fallbackEntries: result.fallbackEntries.map((entry) => ({
      ticker: entry.ticker,
      slot: entry.slot,
      manualValue: entry.manualValue,
      fallbackValue: entry.fallbackValue,
    })),
  };
}

export function toAnchorSubmissionResponse(row: {
  id: bigint;
  submitter: string;
  ticker: string;
  status: string;
  createdAt: Date;
}): AnchorSubmissionResponse {
  return {
    id: row.id.toString(),
    submitter: row.submitter,
    ticker: row.ticker,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
