import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
import { FRESHNESS_TIERS, freshnessTier } from '../marketdata/freshness-tier';
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
import { LEG_TABS } from './leg-tab.rules';
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
    description: '距 W 百分比 (雷达排序键); 行情不可用 ⇒ null',
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
      '空态三分 (FR-015 + FR-034): zero_anchors 零锚 / filtered_empty 筛选无结果 / all_idle 全体不动区; 无空态 = null',
    enum: [...RADAR_EMPTY_STATES],
    nullable: true,
    example: null,
  })
  emptyState!: string | null;

  @ApiProperty({
    description: '该空态的文案 (三态 MUST NOT 复用同一句)',
    type: 'string',
    nullable: true,
    example: null,
  })
  emptyStateMessage!: string | null;
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

export class LegActivityByTabResponse {
  @ApiProperty({
    description: '全腿 Tab 候选集内的排名',
    type: LegActivityResponse,
    nullable: true,
  })
  all!: LegActivityResponse | null;

  @ApiProperty({
    description: '建仓腿 Tab 候选集内的排名; 不属于该 Tab → null',
    type: LegActivityResponse,
    nullable: true,
  })
  build!: LegActivityResponse | null;

  @ApiProperty({
    description: '收租腿 Tab 候选集内的排名; 不属于该 Tab → null',
    type: LegActivityResponse,
    nullable: true,
  })
  rent!: LegActivityResponse | null;
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
      '四档 (bid 口径); **greeks 缺失行恒 null** —— 不判档不着色 (FR-007), 无 bid 亦 null',
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

  @ApiProperty({ description: '当日成交量', type: 'number', nullable: true, example: 87 })
  volume!: number | null;

  @ApiProperty({
    description: '成交额 = Vol × 权利金 × 100。📌 成交额高 ≠ 真流动',
    type: 'string',
    nullable: true,
    example: '10875.00',
  })
  turnover!: string | null;

  @ApiProperty({
    description:
      '三个 Tab **各一套**活跃度标记 —— 排名是候选集内的相对量, 换 Tab 归属就变 (D-SOT-5)',
    type: LegActivityByTabResponse,
  })
  activityByTab!: LegActivityByTabResponse;

  @ApiProperty({
    description:
      '本腿属于哪几个 Tab —— **客户端据此过滤**, MUST NOT 自己重算成员判据 (判据单点在 server)',
    enum: [...LEG_TABS],
    isArray: true,
    example: ['all', 'rent'],
  })
  tabs!: string[];

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
}

export class LegTableResponse {
  @ApiProperty({ description: 'canonical `market:code`', example: 'us:PEP' })
  symbol!: string;

  @ApiProperty({
    description:
      '区块状态。chain_not_ready (采集还没轮到, 是事实) 与 read_failed (跨 ctx 读故障) 蓄意分开',
    enum: [...LEG_TABLE_STATES],
    example: 'available',
  })
  state!: string;

  @ApiProperty({
    description: '区块级 asOf = 快照归属交易日 (YYYY-MM-DD)',
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
    description: '本批报价的实际采集时刻 (ISO-8601)',
    type: 'string',
    nullable: true,
    example: '2026-08-03T20:15:00.000Z',
  })
  quoteAsOf!: string | null;

  @ApiProperty({
    description:
      '🚨 **OI 的归属交易日** (YYYY-MM-DD) —— 与 asOf **不是同一天**: 美股期权 OI 在盘前更新, ' +
      '收盘后采的快照其 OI 归属 T−1 日。OI 列 MUST 用它而非区块级 asOf (FR-013)',
    type: 'string',
    nullable: true,
    example: '2026-07-31',
  })
  oiAsOf!: string | null;

  @ApiProperty({
    description: '快照来源 (eod / premarket_backfill) —— 「一直靠兜底续命」要看得见',
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
      '**全量适格腿, 零分页零 top-N 截断** (FR-005) —— 已滤非标 (FR-008) 与已到期 (FR-028a)。' +
      '死档行照常在内且排在末尾; greeks 缺失行照常在内且不判档',
    type: LegResponse,
    isArray: true,
  })
  legs!: LegResponse[];
}

function toLegActivityResponse(mark: ActivityMark | null): LegActivityResponse | null {
  return mark === null
    ? null
    : { isRoundStrike: mark.isRoundStrike, isTopRanked: mark.isTopRanked, label: mark.label };
}

export function toLegTableResponse(view: LegTableView): LegTableResponse {
  return {
    symbol: view.symbol,
    state: view.state,
    asOf: dateOnly(view.asOf),
    asOfFreshnessTier: freshnessTier(dateOnly(view.asOf), view.lastClosedSession),
    quoteAsOf: view.quoteAsOf === null ? null : view.quoteAsOf.toISOString(),
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
      activityByTab: {
        all: toLegActivityResponse(leg.activityByTab.all),
        build: toLegActivityResponse(leg.activityByTab.build),
        rent: toLegActivityResponse(leg.activityByTab.rent),
      },
      tabs: [...leg.tabs],
      earningsMark:
        leg.earningsMark === null
          ? null
          : {
              mark: leg.earningsMark.mark,
              bufferShortfallDays: leg.earningsMark.bufferShortfallDays,
              lastEarningsDate: leg.earningsMark.lastEarningsDate,
            },
      greeksComplete: leg.greeksComplete,
    })),
  };
}
