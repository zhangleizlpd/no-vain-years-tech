import { ApiProperty } from '@nestjs/swagger';
import { QUERYABLE_MARKETS } from './instrument-query.rules.js';

/**
 * guest 通道批量口响应: 按 code 批量取标的基础信息。
 *
 * 🚨 **字段覆盖度按市场差异极大, 且缺失一律是 `null` 而不是报错** (体例同 015 详情的
 * "detail field coverage")。2026-08-22 实测: `listingStatus` / `listDate` 在 cn / hk 侧近乎
 * 全覆盖, 在 **us 侧恒 null** (0/19546 —— 只有理杏仁供这两个字段, 东财 universe 不供);
 * us 另有 555 条 `name === code` 的占位行。⇒ 目录必须写明 **null ≠ 已退市**, 否则调方的
 * 模型会把「这个字段我们没有」读成「这只票退了」。
 *
 * **刻意不暴露** `syncTier` / `needSync` / `pinyinAbbr` / `pinyinFull` /
 * `lixingerCompanyType` —— 内部采集闸与检索辅助, 对访客没有任何语义, 泄出去只会被当成
 * 「这只票的数据质量分」误读。
 */
export class InstrumentBasicItem {
  @ApiProperty({
    description: 'canonical market:code (便调方直接用于送锚 / 投研报)',
    example: 'us:AOS',
  })
  symbol!: string;

  @ApiProperty({ description: '市场段', enum: QUERYABLE_MARKETS, example: 'us' })
  market!: string;

  @ApiProperty({ description: '裸 code (与请求中的那一段逐字节相同)', example: 'AOS' })
  code!: string;

  @ApiProperty({
    description: '标的名称。us 侧有占位行 (name === code), 表示 universe 收录了但尚未富化到名',
    example: 'A. O. Smith',
  })
  name!: string;

  @ApiProperty({ description: '标的类型 (stock | etf | index | bond)', example: 'stock' })
  type!: string;

  @ApiProperty({ description: '计价币种', example: 'USD' })
  currency!: string;

  @ApiProperty({ description: '在市状态 (active | inactive)', example: 'active' })
  status!: string;

  @ApiProperty({
    description:
      'vendor 原始上市状态 (如 normally_listed / special_treatment)。**us 侧恒 null —— 不代表退市**',
    nullable: true,
    type: 'string',
    example: 'normally_listed',
  })
  listingStatus!: string | null;

  @ApiProperty({
    description: '上市日 YYYY-MM-DD。**us 侧恒 null —— 不代表退市**',
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
}

export class InstrumentBasicsResponse {
  @ApiProperty({ description: '本次请求的市场段 (回显)', enum: QUERYABLE_MARKETS, example: 'us' })
  market!: string;

  @ApiProperty({ description: '命中的标的, code 升序', type: [InstrumentBasicItem] })
  items!: InstrumentBasicItem[];

  @ApiProperty({
    description:
      '注册表里查无此 code (按请求顺序)。**这是「没找到」与「找到了但字段为空」的唯一区分手段** —— code 大小写敏感, 应原样使用枚举口返回的串',
    type: [String],
    example: ['NOSUCH'],
  })
  missing!: string[];
}
