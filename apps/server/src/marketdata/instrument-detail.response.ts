import { ApiProperty } from '@nestjs/swagger';

/**
 * 015 标的详情聚合响应 (EP3, US3/FR-S07)。聚合报价 header + 估值/分位 + 财务 + 公司行动 +
 * 身份 + 52 周高低。**缺失维度一律 null** (detail field coverage: 字段缺失不报错) —— 无最近
 * 估值快照 → `valuation:null`, 无财报 → `financials:null`, 无公司行动 → 空数组。金融数值跨
 * 边界为 **string** (禁 Float); nullable string 显式 `type:'string'` (否则 orval 误推 unknown,
 * 见 012 PR1 教训)。
 */

/** 报价 header (最新/涨跌/涨跌幅/昨收/新鲜度) + 52 周高低。无 DailyBar → 全 null + hasData:false。 */
export class InstrumentQuoteHeader {
  @ApiProperty({
    description: '最新价 (EOD 收盘); 无数据 null',
    nullable: true,
    type: 'string',
    example: '1700.0000',
  })
  price!: string | null;

  @ApiProperty({
    description: '涨跌额 (vs 昨收); 无数据/无昨收 null',
    nullable: true,
    type: 'string',
    example: '10.0000',
  })
  change!: string | null;

  @ApiProperty({
    description: '涨跌幅 %; 无数据/昨收 0 null',
    nullable: true,
    type: 'string',
    example: '0.5917',
  })
  changePct!: string | null;

  @ApiProperty({
    description: '昨收; 无数据 null',
    nullable: true,
    type: 'string',
    example: '1690.0000',
  })
  prevClose!: string | null;

  @ApiProperty({
    description: '数据日期 YYYY-MM-DD (新鲜度); 无数据 null',
    nullable: true,
    type: 'string',
    example: '2026-06-01',
  })
  asOf!: string | null;

  @ApiProperty({
    description: '报价新鲜度口径 (V1 恒 eod_close)',
    enum: ['eod_close', 'realtime'],
    example: 'eod_close',
  })
  priceKind!: 'eod_close' | 'realtime';

  @ApiProperty({ description: '是否有 EOD 数据', example: true })
  hasData!: boolean;

  @ApiProperty({
    description: '52 周最高 (近 252 日 max close); 无数据 null',
    nullable: true,
    type: 'string',
    example: '1850.0000',
  })
  fiftyTwoWeekHigh!: string | null;

  @ApiProperty({
    description: '52 周最低 (近 252 日 min close); 无数据 null',
    nullable: true,
    type: 'string',
    example: '1500.0000',
  })
  fiftyTwoWeekLow!: string | null;
}

/** 估值 + 历史分位 (最近 FundamentalSnapshot)。整体缺失 → 详情 valuation 字段为 null。 */
export class InstrumentValuation {
  @ApiProperty({ description: '估值快照日期 YYYY-MM-DD', example: '2026-06-01' })
  date!: string;

  @ApiProperty({ nullable: true, type: 'string', example: '25.5000' })
  peTtm!: string | null;

  @ApiProperty({ nullable: true, type: 'string', example: '26.0000' })
  peStatic!: string | null;

  @ApiProperty({ nullable: true, type: 'string', example: '24.8000' })
  peDynamic!: string | null;

  @ApiProperty({ nullable: true, type: 'string', example: '9.2000' })
  pb!: string | null;

  @ApiProperty({ nullable: true, type: 'string', example: '12.4000' })
  ps!: string | null;

  @ApiProperty({ nullable: true, type: 'string', example: '1.8000' })
  dividendYield!: string | null;

  @ApiProperty({ nullable: true, type: 'string', example: '2135000000000.00' })
  marketCap!: string | null;

  @ApiProperty({ nullable: true, type: 'string', example: '2135000000000.00' })
  circMarketCap!: string | null;

  @ApiProperty({
    description: 'PE 近 3 年分位 [0,1]',
    nullable: true,
    type: 'string',
    example: '0.4200',
  })
  pePctlY3!: string | null;

  @ApiProperty({ description: 'PE 近 5 年分位', nullable: true, type: 'string', example: '0.3800' })
  pePctlY5!: string | null;

  @ApiProperty({ description: 'PB 近 3 年分位', nullable: true, type: 'string', example: '0.5500' })
  pbPctlY3!: string | null;

  @ApiProperty({ description: 'PB 近 5 年分位', nullable: true, type: 'string', example: '0.5100' })
  pbPctlY5!: string | null;
}

/** 财报衍生 (最近 FinancialMetric)。整体缺失 → 详情 financials 字段为 null。 */
export class InstrumentFinancials {
  @ApiProperty({ description: '报告期 YYYYQn', example: '2026Q1' })
  reportPeriod!: string;

  @ApiProperty({ description: 'ROE', nullable: true, type: 'string', example: '0.3100' })
  roe!: string | null;

  @ApiProperty({ description: '毛利率', nullable: true, type: 'string', example: '0.9180' })
  grossMargin!: string | null;

  @ApiProperty({ description: '每股收益', nullable: true, type: 'string', example: '18.5000' })
  eps!: string | null;

  @ApiProperty({ description: '每股净资产', nullable: true, type: 'string', example: '185.2000' })
  bps!: string | null;
}

/** 公司行动 (分红/拆股/配股)。payload = 源结构化明细 (透传)。 */
export class InstrumentCorporateAction {
  @ApiProperty({ description: '除权除息日 YYYY-MM-DD', example: '2026-06-20' })
  exDate!: string;

  @ApiProperty({ description: '类型 (dividend|split|allotment)', example: 'dividend' })
  type!: string;

  @ApiProperty({
    description: '源结构化明细',
    type: 'object',
    additionalProperties: true,
    example: { perShare: '30.00', currency: 'CNY' },
  })
  payload!: unknown;
}

export class InstrumentDetailResponse {
  @ApiProperty({ description: 'canonical market:code', example: 'cn:600519' })
  symbol!: string;

  @ApiProperty({ description: '名称', example: '贵州茅台' })
  name!: string;

  @ApiProperty({ description: '类型 (stock|index|fund|...)', example: 'stock' })
  type!: string;

  @ApiProperty({ description: '市场段', example: 'cn' })
  market!: string;

  @ApiProperty({ description: '代码', example: '600519' })
  code!: string;

  @ApiProperty({ description: '计价币种', example: 'CNY' })
  currency!: string;

  @ApiProperty({ description: '上市状态', example: 'listed' })
  status!: string;

  @ApiProperty({
    description: '上市日 YYYY-MM-DD; 缺失 null',
    nullable: true,
    type: 'string',
    example: '2001-08-27',
  })
  listDate!: string | null;

  @ApiProperty({
    description: '退市日 YYYY-MM-DD; 在市 null',
    nullable: true,
    type: 'string',
    example: null,
  })
  delistDate!: string | null;

  @ApiProperty({ description: '报价 header + 52 周高低', type: InstrumentQuoteHeader })
  quote!: InstrumentQuoteHeader;

  @ApiProperty({
    description: '估值 + 分位 (最近快照); 缺失 null',
    nullable: true,
    type: InstrumentValuation,
  })
  valuation!: InstrumentValuation | null;

  @ApiProperty({
    description: '财报衍生 (最近报告期); 缺失 null',
    nullable: true,
    type: InstrumentFinancials,
  })
  financials!: InstrumentFinancials | null;

  @ApiProperty({
    description: '公司行动 (近期, exDate 降序); 无则空数组',
    type: [InstrumentCorporateAction],
  })
  corporateActions!: InstrumentCorporateAction[];
}
