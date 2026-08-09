import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  ALERT_CONDITION_TYPES,
  ALERT_FREQUENCIES,
  ALERT_MARKETS,
  DEFAULT_ALERT_FREQUENCY,
} from './alert-validation.rules';

/** 预警标的 (业务主键 market+code, 逻辑指向 015 Instrument)。 */
export class AlertInstrumentEntry {
  @ApiProperty({ description: '市场 (V1 仅 cn)', enum: ALERT_MARKETS, example: 'cn' })
  @IsIn(ALERT_MARKETS)
  market!: string;

  @ApiProperty({ description: '标的代码 (≤16)', example: '603305' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  code!: string;
}

/**
 * 预警条件 (类型 + 参数 + 阈值；白名单/值域/重复等业务校验在 UC 层 T002 rules,
 * SoT = alert-condition-meta.ts)。023: param/threshold 按 kind 形态可省。
 */
export class AlertConditionEntry {
  @ApiProperty({
    description: '条件类型 (024: 34 词表)',
    enum: ALERT_CONDITION_TYPES,
    example: 'PRICE_FALL_TO',
  })
  @IsIn(ALERT_CONDITION_TYPES)
  type!: string;

  @ApiProperty({
    description: '条件参数 (MA 周期/新高低窗口/累计天数/分位年限; 无参类型省略或 0)',
    required: false,
    example: 20,
  })
  @IsOptional()
  @IsInt()
  param?: number;

  @ApiProperty({
    description: '阈值 (值域 per 条件族 FR-S07; 无阈值类型省略)',
    required: false,
    example: 13,
  })
  @IsOptional()
  @IsNumber()
  threshold?: number;
}

/**
 * POST /api/v1/alert/alerts request body (EP3 批量创建)。
 *
 * 浅校验 (类型 + 词表 + 非空数组): 违反 → 400 `FORM_VALIDATION` (ValidationPipe)。
 * 业务校验 (conditions 1..4 / 同类型限 1 / 阈值域 / note ≤22 字) 在
 * CreateAlertsBatchUseCase (T002 rules)。批量语义 = 每标的各建一条独立预警 (D5 原子)。
 */
export class CreateAlertsRequest {
  @ApiProperty({ description: '标的列表 (每只各建一条)', type: [AlertInstrumentEntry] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AlertInstrumentEntry)
  instruments!: AlertInstrumentEntry[];

  @ApiProperty({ description: '条件集 (AND, 1..4, 同类型限 1)', type: [AlertConditionEntry] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AlertConditionEntry)
  conditions!: AlertConditionEntry[];

  @ApiProperty({
    description: '提醒频率 (缺省 DAILY)',
    enum: ALERT_FREQUENCIES,
    required: false,
    default: DEFAULT_ALERT_FREQUENCY,
  })
  @IsOptional()
  @IsIn(ALERT_FREQUENCIES)
  frequency?: string;

  @ApiProperty({
    description: '备注 (≤22 字 Unicode code point, 可空)',
    type: 'string',
    nullable: true,
    required: false,
    example: '低吸观察',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  note?: string | null;
}
