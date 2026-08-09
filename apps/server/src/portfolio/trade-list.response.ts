import { ApiProperty } from '@nestjs/swagger';
import { TRADE_CATEGORIES, type TradeCategory } from './holdings-import.rules';

/**
 * 025 EP3 标的交易流水读侧投影 (FR-008)。金融数值跨边界为 **string** (Decimal 禁
 * Float); nullable string 字段显式 `type:'string'` (orval 陷阱)。等值 (market, code)
 * 查询 → 资金行 (code null) 天然不命中, market/code 在本契约恒非 null。
 */
export class TradeItem {
  @ApiProperty({ description: '流水行 id (数字串)', example: '201' })
  id!: string;

  @ApiProperty({ description: '市场 (V1 cn)', example: 'cn' })
  market!: string;

  @ApiProperty({ description: '标的代码', example: '603915' })
  code!: string;

  @ApiProperty({
    description: '标的名称 (XD 前缀保留不清洗); 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: 'XD国茂股份',
  })
  name!: string | null;

  @ApiProperty({
    description: '交易类别 (normalized enum, 原始中文在导入摘要/raw)',
    enum: TRADE_CATEGORIES,
    example: 'buy',
  })
  category!: TradeCategory;

  @ApiProperty({ description: '成交日期 YYYY-MM-DD', example: '2025-08-27' })
  tradeDate!: string;

  @ApiProperty({
    description: "成交时间 'HH:mm:ss'; 文件缺失为 null",
    nullable: true,
    type: 'string',
    example: '14:53:27',
  })
  tradeTime!: string | null;

  @ApiProperty({
    description: '成交数量 (Decimal string); 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: '6200',
  })
  qty!: string | null;

  @ApiProperty({
    description: '成交价格 (Decimal string); 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: '16.12',
  })
  price!: string | null;

  @ApiProperty({ description: '发生金额 (signed, Decimal string)', example: '-99900.99' })
  amount!: string;

  @ApiProperty({
    description: '成交金额 (Decimal string); 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: '99900',
  })
  turnover!: string | null;

  @ApiProperty({
    description: '费用 (Decimal string); 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: '10.99',
  })
  fee!: string | null;

  @ApiProperty({
    description: '备注; 文件缺失为 null',
    nullable: true,
    type: 'string',
    example: null,
  })
  note!: string | null;
}

/** GET `/portfolio/trades?market=&code=` 响应 (200) — 成交时间倒序; 未交易标的空 items。 */
export class TradeListResponse {
  @ApiProperty({
    description: '流水列表 (tradeDate desc, tradeTime desc nulls last)',
    type: [TradeItem],
  })
  items!: TradeItem[];
}
