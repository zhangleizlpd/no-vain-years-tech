import { ApiProperty } from '@nestjs/swagger';
import { ALERT_CONDITION_TYPES, ALERT_FREQUENCIES } from './alert-validation.rules';
import type { AlertWithConditions } from './create-alerts-batch.usecase';

/**
 * 021 预警读侧投影 (EP1-EP4 共用)。金融数值跨边界为 **string** (禁 Float, 015 体例,
 * threshold Decimal(18,4) → `.toFixed(4)`); nullable string 字段 (note) 显式
 * `type:'string'` — 否则 orval 对 `string|null` 联合误生成 `{[k]:unknown}|null`
 * (per 012 PR1 教训)。id BigInt → 数字串 (013 watchlist 体例)。
 */
export class AlertConditionItem {
  @ApiProperty({
    description: '条件类型 (023: 32 词表)',
    enum: [...ALERT_CONDITION_TYPES],
    example: 'PRICE_FALL_TO',
  })
  type!: string;

  @ApiProperty({ description: '条件参数 (0 = 无参 sentinel)', example: 20 })
  param!: number;

  @ApiProperty({
    description: '阈值 (Decimal string; 无阈值类型 null)',
    type: 'string',
    nullable: true,
    example: '13.0000',
  })
  threshold!: string | null;
}

export class AlertResponse {
  @ApiProperty({ description: '预警 id (数字串)', example: '101' })
  id!: string;

  @ApiProperty({ description: '市场 (V1 仅 cn)', example: 'cn' })
  market!: string;

  @ApiProperty({ description: '标的代码', example: '603305' })
  code!: string;

  @ApiProperty({ description: 'AND 条件 1..4 (同类型限 1)', type: [AlertConditionItem] })
  conditions!: AlertConditionItem[];

  @ApiProperty({
    description: '提醒频率 (默认 DAILY)',
    enum: [...ALERT_FREQUENCIES],
    example: 'DAILY',
  })
  frequency!: string;

  @ApiProperty({
    description: '备注 (≤22 字, Unicode code point 计)',
    nullable: true,
    type: 'string',
    example: '低吸观察',
  })
  note!: string | null;

  @ApiProperty({ description: '是否启用', example: true })
  enabled!: boolean;

  @ApiProperty({ description: '创建时间 ISO-8601', example: '2026-06-06T08:00:00.000Z' })
  createdAt!: string;
}

/** EP1 个股预警 / EP2 全部预警 / EP3 批量创建 共用列表响应 (分组归 client)。 */
export class AlertListResponse {
  @ApiProperty({ description: '预警列表', type: [AlertResponse] })
  alerts!: AlertResponse[];
}

/** EP5 批量删除响应 (仅删本账号命中项, 返实删数 — 不报错杂音, 反枚举)。 */
export class DeleteAlertsBatchResponse {
  @ApiProperty({ description: '实删条数', example: 2 })
  deleted!: number;
}

/** 贫血 Prisma row → 响应投影 (纯映射, controller/UC 共用)。 */
export function toAlertResponse(row: AlertWithConditions): AlertResponse {
  return {
    id: row.id.toString(),
    market: row.market,
    code: row.code,
    conditions: row.conditions.map((c) => ({
      type: c.type,
      param: c.param,
      threshold: c.threshold === null ? null : c.threshold.toFixed(4),
    })),
    frequency: row.frequency,
    note: row.note,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAlertListResponse(rows: readonly AlertWithConditions[]): AlertListResponse {
  return { alerts: rows.map(toAlertResponse) };
}
