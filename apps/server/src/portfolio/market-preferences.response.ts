import { ApiProperty } from '@nestjs/swagger';
import type { MarketGroup } from './market-catalog';

/**
 * 单个市场的全量态 (静态字典元信息 + 用户激活态)。9 行: 核心 3 + 海外 6。
 * 客户端凭此渲染设置页, 无需硬编码字典 (FR-S01/FR-M06)。
 */
export class MarketItem {
  @ApiProperty({
    description: '市场码 (cn/hk/us, 与 015 Instrument.market 同词表); 核心持久化于偏好表',
    example: 'cn',
  })
  marketCode!: string;

  @ApiProperty({ description: '中文显示名 (mockup 定稿)', example: 'A 股' })
  displayName!: string;

  @ApiProperty({ description: 'ISO 4217 货币码 (UI 显示用, 与 marketCode 解耦)', example: 'CNY' })
  isoCurrency!: string;

  @ApiProperty({
    description: '分组: core (可开关) | overseas (V1 恒置灰)',
    enum: ['core', 'overseas'],
    example: 'core',
  })
  group!: MarketGroup;

  @ApiProperty({ description: 'V1 是否可激活: 核心 true / 海外恒 false', example: true })
  v1Available!: boolean;

  @ApiProperty({ description: '当前激活态; 海外恒 false', example: true })
  active!: boolean;
}

/**
 * GET / PUT /api/v1/portfolio/market-preferences[/{market}] 响应体 (EP1/EP2)。
 * markets 固定顺序 (字典 order, 核心在前)。EP2 也返回全量态供客户端对账 (D7)。
 */
export class MarketPreferencesResponse {
  @ApiProperty({ description: '全量 9 市场态 (核心 3 + 海外 6), 固定顺序', type: [MarketItem] })
  markets!: MarketItem[];
}
