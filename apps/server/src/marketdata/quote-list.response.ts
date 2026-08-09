import { ApiProperty } from '@nestjs/swagger';

/**
 * 015 报价端口读侧投影单项 (EP2, US4/FR-S07)。金融数值跨边界为 **string** (禁 Float);
 * nullable string 字段显式 `type:'string'` — 否则 orval 对 `string|null` 联合误生成
 * `{[k]:unknown}|null` (per 反射推标量缺失, 见 012 PR1 教训)。无 EOD 数据 → `hasData:false`
 * 且 price/change/changePct/asOf 全 null (显式 no-data, 不污染同批其余项)。
 */
export class QuoteItem {
  @ApiProperty({ description: 'canonical market:code', example: 'cn:600519' })
  symbol!: string;

  @ApiProperty({
    description: '标的名称 (Instrument 注册即有, 与 hasData 正交); 未注册/非法 symbol 为 null',
    nullable: true,
    type: 'string',
    example: '贵州茅台',
  })
  name!: string | null;

  @ApiProperty({
    description: '最新价 (EOD 收盘, Decimal string); 无数据为 null',
    nullable: true,
    type: 'string',
    example: '1700.0000',
  })
  price!: string | null;

  @ApiProperty({
    description: '涨跌额 (vs 前收, Decimal string); 无数据/无前收为 null',
    nullable: true,
    type: 'string',
    example: '10.0000',
  })
  change!: string | null;

  @ApiProperty({
    description: '涨跌幅 % (Decimal string); 无数据/前收为 0 时为 null',
    nullable: true,
    type: 'string',
    example: '0.5917',
  })
  changePct!: string | null;

  @ApiProperty({
    description: '数据日期 YYYY-MM-DD (新鲜度); 无数据为 null',
    nullable: true,
    type: 'string',
    example: '2026-06-01',
  })
  asOf!: string | null;

  @ApiProperty({
    description: '报价新鲜度口径 (V1 恒 eod_close; 实时源接入翻 realtime)',
    enum: ['eod_close', 'realtime'],
    example: 'eod_close',
  })
  priceKind!: 'eod_close' | 'realtime';

  @ApiProperty({ description: '是否有 EOD 数据 (false=显式 no-data)', example: true })
  hasData!: boolean;
}

/** EP2 `GET /marketdata/quote` 批量报价响应。 */
export class QuoteListResponse {
  @ApiProperty({ description: '按入参 symbols 顺序的报价列表 (含重复行)', type: [QuoteItem] })
  items!: QuoteItem[];
}
