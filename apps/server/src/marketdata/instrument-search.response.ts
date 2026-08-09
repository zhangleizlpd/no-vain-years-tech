import { ApiProperty } from '@nestjs/swagger';

/**
 * 015 模糊搜索读侧响应 (EP1, US2/FR-S04)。候选已归一化为 canonical `market:code` + name +
 * type, 消费者 (013 加自选 / 014 详情入口) 不感知背后东财 / 本地 fallback。无命中 → items: []。
 */
export class InstrumentSearchItem {
  @ApiProperty({ description: 'canonical market:code', example: 'cn:600519' })
  symbol!: string;

  @ApiProperty({ description: '标的名称', example: '贵州茅台' })
  name!: string;

  @ApiProperty({ description: '标的类型 (stock | etf | index)', example: 'stock' })
  type!: string;
}

/** EP1 `GET /marketdata/search` 候选列表响应。 */
export class InstrumentSearchResponse {
  @ApiProperty({ description: '归一化候选 (无命中为空)', type: [InstrumentSearchItem] })
  items!: InstrumentSearchItem[];
}
