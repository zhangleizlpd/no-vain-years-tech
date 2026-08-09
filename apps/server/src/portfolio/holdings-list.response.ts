import { ApiProperty } from '@nestjs/swagger';

/**
 * 025 EP2 持仓列表读侧投影 (FR-007)。金融数值跨边界为 **string** (Decimal 禁 Float,
 * 015 quote response 体例); nullable string 字段显式 `type:'string'` — 否则 orval 对
 * `string|null` 联合误生成 `{[k]:unknown}|null` (012 PR1 教训)。
 *
 * **行情值 (现价/浮动盈亏) 不在本契约** —— mobile 走 015 `/quote` client-merge
 * (ADR-0048, 013 先例); quotable=false 行 mobile 降级展示 (`--` + 无行情角标)。
 */
export class HoldingItem {
  @ApiProperty({ description: '持仓行 id (数字串)', example: '101' })
  id!: string;

  @ApiProperty({ description: '市场 (V1 cn)', example: 'cn' })
  market!: string;

  @ApiProperty({ description: '标的代码', example: '603915' })
  code!: string;

  @ApiProperty({ description: '标的名称 (文件参考值, 非权威)', example: '国茂股份' })
  name!: string;

  @ApiProperty({ description: '持有数量 (Decimal string)', example: '2000' })
  qty!: string;

  @ApiProperty({ description: '单位成本 (Decimal string)', example: '15.883' })
  unitCost!: string;

  @ApiProperty({
    description: '仓位占比 (小数, Decimal string); 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: '0.16',
  })
  weightPct!: string | null;

  @ApiProperty({
    description: '持仓天数; 文件缺失为 null',
    nullable: true,
    type: 'number',
    example: 5,
  })
  holdDays!: number | null;

  @ApiProperty({
    description: '累计盈亏 (Decimal string); 文件 `--` 为 null',
    nullable: true,
    type: 'string',
    example: '17000.55',
  })
  cumPnl!: string | null;

  @ApiProperty({
    description: '累计盈亏率 (小数, Decimal string); 文件 `--` 为 null',
    nullable: true,
    type: 'string',
    example: '0.1022',
  })
  cumPnlPct!: string | null;

  @ApiProperty({
    description: '可识别性 (015 instrument 注册即 true; false → 行情列降级展示)',
    example: true,
  })
  quotable!: boolean;
}

export class ClosedPositionItem {
  @ApiProperty({ description: '已清仓行 id (数字串)', example: '11' })
  id!: string;

  @ApiProperty({ description: '市场 (V1 cn)', example: 'cn' })
  market!: string;

  @ApiProperty({ description: '标的代码', example: '603915' })
  code!: string;

  @ApiProperty({ description: '标的名称', example: '国茂股份' })
  name!: string;

  @ApiProperty({ description: '建仓日期 YYYY-MM-DD', example: '2025-08-27' })
  openDate!: string;

  @ApiProperty({ description: '清仓日期 YYYY-MM-DD', example: '2026-05-11' })
  closeDate!: string;

  @ApiProperty({ description: '买入均价 (Decimal string)', example: '15.76' })
  buyAvg!: string;

  @ApiProperty({ description: '卖出均价 (Decimal string)', example: '17.26' })
  sellAvg!: string;

  @ApiProperty({ description: '总盈亏 (Decimal string)', example: '15900.35' })
  totalPnl!: string;

  @ApiProperty({
    description: '盈亏比 (小数, Decimal string); 文件 `--` 为 null',
    nullable: true,
    type: 'string',
    example: '0.096',
  })
  totalPnlPct!: string | null;

  @ApiProperty({
    description: '交易费用 (Decimal string); 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: '133.25',
  })
  fee!: string | null;

  @ApiProperty({
    description: '同期大盘 (小数, Decimal string); 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: '0.0922',
  })
  indexPct!: string | null;

  @ApiProperty({
    description: '跑赢大盘 (小数, Decimal string); 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: '0.0038',
  })
  vsIndexPct!: string | null;
}

/** GET `/portfolio/holdings` 响应 (200) — 双 tab 一次取 (plan D6, V1 量级无分页)。 */
export class HoldingsListResponse {
  @ApiProperty({
    description: '快照日 YYYY-MM-DD (holding 表同批一致); 未导入过为 null',
    nullable: true,
    type: 'string',
    example: '2026-06-06',
  })
  asOf!: string | null;

  @ApiProperty({ description: '当前持仓 (仓位占比降序)', type: [HoldingItem] })
  current!: HoldingItem[];

  @ApiProperty({ description: '已清仓 (清仓日期倒序)', type: [ClosedPositionItem] })
  closed!: ClosedPositionItem[];
}
