import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ALERT_FREQUENCIES } from './alert-validation.rules';
import { AlertConditionEntry } from './create-alerts.request';

/**
 * PATCH /api/v1/alert/alerts/{id} request body (EP4 编辑)。
 *
 * 全字段可省 (省略 = 保持原值)；conditions 提供即**全量替换** (编辑页本地草稿一次
 * 提交, FR-M02)；note 显式 null = 清空。merge 后整体复验在 UpdateAlertUseCase。
 */
export class UpdateAlertRequest {
  @ApiProperty({
    description: '条件集 (提供即全量替换)',
    type: [AlertConditionEntry],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AlertConditionEntry)
  conditions?: AlertConditionEntry[];

  @ApiProperty({ description: '提醒频率', enum: ALERT_FREQUENCIES, required: false })
  @IsOptional()
  @IsIn(ALERT_FREQUENCIES)
  frequency?: string;

  @ApiProperty({
    description: '备注 (null = 清空)',
    type: 'string',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  note?: string | null;

  @ApiProperty({ description: '启用/停用 (卡片 toggle)', required: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
