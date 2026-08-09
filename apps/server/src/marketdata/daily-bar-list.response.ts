import { ApiProperty } from '@nestjs/swagger';
import { FRESHNESS_TIERS } from './freshness-tier.js';
import { ADJUSTS, BAR_PERIODS, type Adjust, type BarPeriod } from './marketdata.types.js';

/**
 * 015 K线序列响应 (EP4, US3/FR-S06)。日线按 period 聚合 (day 原样); OHLC + 量额 跨边界为
 * **string** (禁 Float)。聚合周期的 prevClose=桶首前收、turnoverRate=null (聚合无意义)。空区间
 * → 空 items (200, 非 5xx)。nullable string 显式 `type:'string'` (orval 标量推断)。
 */
export class DailyBarItem {
  @ApiProperty({ description: '交易日 (聚合周期为桶内末交易日) YYYY-MM-DD', example: '2026-06-01' })
  tradeDate!: string;

  @ApiProperty({ description: '开盘 (聚合=桶首开)', type: 'string', example: '1680.0000' })
  open!: string;

  @ApiProperty({ description: '最高 (聚合=区间最高)', type: 'string', example: '1705.0000' })
  high!: string;

  @ApiProperty({ description: '最低 (聚合=区间最低)', type: 'string', example: '1675.0000' })
  low!: string;

  @ApiProperty({ description: '收盘 (聚合=桶末收)', type: 'string', example: '1700.0000' })
  close!: string;

  @ApiProperty({
    description: '官方涨跌幅 百分数 (已含除权除息调整; 聚合=期间收益); 缺失 null',
    nullable: true,
    type: 'string',
    example: '0.5917',
  })
  changePct!: string | null;

  @ApiProperty({
    description: '昨收 官方 (聚合=桶首官方昨收); 缺失 null',
    nullable: true,
    type: 'string',
    example: '1690.0000',
  })
  prevClose!: string | null;

  @ApiProperty({
    description: '成交量 (聚合=区间和); 缺失 null',
    nullable: true,
    type: 'string',
    example: '3200000',
  })
  volume!: string | null;

  @ApiProperty({
    description: '成交额 (聚合=区间和); 缺失 null',
    nullable: true,
    type: 'string',
    example: '5440000000.00',
  })
  amount!: string | null;

  @ApiProperty({
    description: '换手率; 聚合周期/缺失 null',
    nullable: true,
    type: 'string',
    example: '0.2500',
  })
  turnoverRate!: string | null;
}

export class DailyBarListResponse {
  @ApiProperty({ description: 'canonical market:code', example: 'cn:600519' })
  symbol!: string;

  @ApiProperty({ description: '复权口径', enum: ADJUSTS, example: 'none' })
  adjust!: Adjust;

  @ApiProperty({ description: '聚合周期', enum: BAR_PERIODS, example: 'day' })
  period!: BarPeriod;

  @ApiProperty({ description: 'K线序列 (tradeDate 升序); 空区间为空数组', type: [DailyBarItem] })
  items!: DailyBarItem[];

  @ApiProperty({
    description:
      '序列 asOf (= 末根 bar 的 tradeDate) 的新鲜度档: CURRENT 不落后于该市场最近一个已收盘' +
      '交易日 / STALE 停在更早的交易日 / UNAVAILABLE 空序列。🚨 **判据在 server** —— 它要查' +
      '交易日历, 客户端拿设备本地日期比会对美股恒判陈旧',
    enum: [...FRESHNESS_TIERS],
    example: 'CURRENT',
  })
  freshnessTier!: string;
}
