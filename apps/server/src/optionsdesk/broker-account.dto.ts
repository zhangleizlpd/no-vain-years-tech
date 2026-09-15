import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import type { Prisma } from '../generated/prisma/client';
import type { BrokerMarket } from './broker-code.rules';
import type {
  BrokerPositionGroupView,
  BrokerPositionList,
  BrokerPositionListRow,
} from './list-broker-positions.usecase';

/**
 * 083 交易账户页读接口 DTO (plan D1 / D8; 字段 SoT = 本文件 swagger 装饰器)。
 *
 * 🚨 BigInt / Decimal 出边界一律 string (Guardrail 12); nullable 标量 `@ApiProperty` 显式 `type`
 * (`check-api-property-nullable.ts`)。只读 —— 本文件无任何写请求体 (FR-019)。
 */

const BROKER_MARKETS: readonly BrokerMarket[] = ['us', 'hk'];

/** Decimal → 非科学计数法数值串; `null` 原样。 */
function decimalString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed();
}

/** GET /api/v1/optionsdesk/broker-positions 查询参数。 */
export class BrokerPositionsQuery {
  @ApiProperty({ description: '市场', enum: BROKER_MARKETS, example: 'us' })
  @IsIn(BROKER_MARKETS)
  market!: BrokerMarket;
}

export class BrokerPositionOptionResponse {
  @ApiProperty({ description: '到期日 (交易所当地 YYYY-MM-DD)', example: '2026-10-16' })
  expiry!: string;

  @ApiProperty({ description: 'C = Call / 购; P = Put / 沽', enum: ['C', 'P'], example: 'P' })
  right!: 'C' | 'P';

  @ApiProperty({ description: '行权价 (数值串)', example: '30' })
  strike!: string;
}

export class BrokerPositionRowResponse {
  @ApiProperty({ description: '持仓行 id (数字串)', example: '42' })
  id!: string;

  @ApiProperty({ description: '市场 (标时区用)', enum: BROKER_MARKETS, example: 'us' })
  market!: BrokerMarket;

  @ApiProperty({ description: '券商码', example: 'futu' })
  brokerCode!: string;

  @ApiProperty({ description: '券商连接的人读标签 (多连接时区分行)', example: '主账户' })
  connectionLabel!: string;

  @ApiProperty({ description: '正股 / 期权', enum: ['stock', 'option'], example: 'option' })
  kind!: 'stock' | 'option';

  @ApiProperty({ description: '券商原始代码', example: 'US.ZQY261016P30000' })
  code!: string;

  @ApiProperty({
    description: '正股名 (期权行同为正股名; 取不到回落券商名 / 正股代码)',
    example: '示例',
  })
  name!: string;

  @ApiProperty({
    description: '期权字段 (正股行为 null)',
    type: BrokerPositionOptionResponse,
    nullable: true,
  })
  option!: BrokerPositionOptionResponse | null;

  @ApiProperty({ description: '数量 (带符号, 空头为负; 期权单位为张)', example: '-2' })
  qty!: string;

  @ApiProperty({ description: '市值 (带符号)', type: 'string', nullable: true, example: '-300' })
  marketValue!: string | null;

  @ApiProperty({ description: '现价', type: 'string', nullable: true, example: '1.5' })
  currentPrice!: string | null;

  @ApiProperty({ description: '平均成本', type: 'string', nullable: true, example: '2.5' })
  averageCost!: string | null;

  @ApiProperty({
    description: '持仓盈亏金额 (平均成本口径; 券商缺值 ⇒ null)',
    type: 'string',
    nullable: true,
    example: '200',
  })
  unrealizedPl!: string | null;

  @ApiProperty({
    description: '持仓盈亏比例 (平均成本口径, 券商原值不换算; 缺值 ⇒ null)',
    type: 'string',
    nullable: true,
    example: '40',
  })
  unrealizedPlRatio!: string | null;

  @ApiProperty({ description: '币种', type: 'string', nullable: true, example: 'USD' })
  currency!: string | null;

  @ApiProperty({ description: '开仓时间 (ISO 8601 UTC)', example: '2026-09-08T14:30:00.000Z' })
  openedAt!: string;

  @ApiProperty({
    description: '开仓时间来源: derived = 由成交推算; fallback = 首次发现时刻',
    enum: ['derived', 'fallback'],
    example: 'derived',
  })
  openedAtSource!: string;

  @ApiProperty({
    description: '期权到期日早于该市场交易所今天 (尚未被同步移除); 正股恒 false',
    example: false,
  })
  expired!: boolean;
}

export class BrokerPositionGroupResponse {
  @ApiProperty({ description: '正股 canonical ticker', example: 'us:ZQY' })
  underlyingTicker!: string;

  @ApiProperty({ description: '正股名', example: '示例' })
  underlyingName!: string;

  @ApiProperty({
    description: '组头正股现价: 组内正股行现价, 无正股行取锚现价, 仍无 ⇒ null',
    type: 'string',
    nullable: true,
    example: '31.5',
  })
  underlyingPrice!: string | null;

  @ApiProperty({
    description: '组市值 (非空者带符号求和; 全空 ⇒ null)',
    type: 'string',
    nullable: true,
    example: '-300',
  })
  groupMarketValue!: string | null;

  @ApiProperty({
    description: '组持仓盈亏 (非空者带符号求和; 全空 ⇒ null)',
    type: 'string',
    nullable: true,
    example: '200',
  })
  groupUnrealizedPl!: string | null;

  @ApiProperty({
    description: '组内行: 正股段在前、期权段在后, 段内开仓时间升序',
    type: [BrokerPositionRowResponse],
  })
  rows!: BrokerPositionRowResponse[];
}

export class BrokerPositionListResponse {
  @ApiProperty({ description: '账号是否有券商连接', example: true })
  hasConnection!: boolean;

  @ApiProperty({ description: '券商连接数 (> 1 时行上显示连接标签)', example: 1 })
  brokerCount!: number;

  @ApiProperty({
    description: '该市场最近一次成功同步时刻 (ISO 8601 UTC); 从未成功 ⇒ null',
    type: 'string',
    nullable: true,
    example: '2026-09-10T13:15:00.000Z',
  })
  syncedAt!: string | null;

  @ApiProperty({
    description: '同上, 交易所当地时间串 YYYY-MM-DD HH:mm:ss',
    type: 'string',
    nullable: true,
    example: '2026-09-10 09:15:00',
  })
  syncedAtLocal!: string | null;

  @ApiProperty({
    description: '数据是否陈旧 (最近成功同步早于最近一个已过宽限的对账时点)',
    example: false,
  })
  stale!: boolean;

  @ApiProperty({ description: '判定不出正股的持仓条数 (不展示明细)', example: 0 })
  unresolvedCount!: number;

  @ApiProperty({
    description: '按正股分组的持仓 (|组市值| 降序, 组市值为空排末, 并列按 ticker)',
    type: [BrokerPositionGroupResponse],
  })
  groups!: BrokerPositionGroupResponse[];
}

export function toBrokerPositionRowResponse(row: BrokerPositionListRow): BrokerPositionRowResponse {
  return {
    id: row.id.toString(),
    market: row.market,
    brokerCode: row.brokerCode,
    connectionLabel: row.connectionLabel,
    kind: row.kind,
    code: row.code,
    name: row.name,
    option:
      row.option === null
        ? null
        : {
            expiry: row.option.expiry,
            right: row.option.right,
            strike: row.option.strike.toFixed(),
          },
    qty: row.qty.toFixed(),
    marketValue: decimalString(row.marketValue),
    currentPrice: decimalString(row.currentPrice),
    averageCost: decimalString(row.averageCost),
    unrealizedPl: decimalString(row.unrealizedPl),
    unrealizedPlRatio: decimalString(row.unrealizedPlRatio),
    currency: row.currency,
    openedAt: row.openedAt.toISOString(),
    openedAtSource: row.openedAtSource,
    expired: row.expired,
  };
}

function toBrokerPositionGroupResponse(
  group: BrokerPositionGroupView,
): BrokerPositionGroupResponse {
  return {
    underlyingTicker: group.underlyingTicker,
    underlyingName: group.underlyingName,
    underlyingPrice: decimalString(group.underlyingPrice),
    groupMarketValue: decimalString(group.groupMarketValue),
    groupUnrealizedPl: decimalString(group.groupUnrealizedPl),
    rows: group.rows.map(toBrokerPositionRowResponse),
  };
}

export function toBrokerPositionListResponse(list: BrokerPositionList): BrokerPositionListResponse {
  return {
    hasConnection: list.hasConnection,
    brokerCount: list.brokerCount,
    syncedAt: list.syncedAt === null ? null : list.syncedAt.toISOString(),
    syncedAtLocal: list.syncedAtLocal,
    stale: list.stale,
    unresolvedCount: list.unresolvedCount,
    groups: list.groups.map(toBrokerPositionGroupResponse),
  };
}
