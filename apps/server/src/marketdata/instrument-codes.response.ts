import { ApiProperty } from '@nestjs/swagger';
import { QUERYABLE_MARKETS } from './instrument-query.rules.js';

/**
 * guest 通道枚举口响应: 某市场下的全部 code。
 *
 * **裸 code, 不带 `market:` 前缀** —— 与批量口的 `market` + `codes` 配对使用。这不只是省
 * 3 字节 × 2 万条: 市场作为独立参数意味着**跨市场混批在结构上不可能**, 通道层因此不需要抄
 * `/option-snapshot` 那道「每一段都必须是 US.」的第二步闸。
 *
 * 🚨 **不分页, 一次返全量** (2026-08-22 隔 guest 通道实测 us 19622 条 = 139,856 字节明文,
 * 线上带 gzip 传 58,553 字节)。业内
 * master-list 一类接口的一致做法 (Zerodha Kite `/instruments` 直接返 gzip CSV 全量转储、
 * Alpaca `/v2/assets` 全量数组只有过滤没有分页、富途 `get_stock_basicinfo` 按 market 全量),
 * 消费方式是「拉一次存下来」而不是「翻页读」。压缩由通道层 nginx 做, 调方须带
 * `curl --compressed` 才生效。
 */
export class InstrumentCodeListResponse {
  @ApiProperty({ description: '市场段', enum: QUERYABLE_MARKETS, example: 'us' })
  market!: string;

  @ApiProperty({ description: 'codes 长度 (调方自检用)', example: 19622 })
  count!: number;

  @ApiProperty({
    description: '裸 code, 升序。批量口须原样回传 (大小写敏感, 服务端不归一)',
    type: [String],
    example: ['A', 'AA', 'AACB'],
  })
  codes!: string[];
}
