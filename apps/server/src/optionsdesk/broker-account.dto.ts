import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, Matches } from 'class-validator';
import type { Prisma } from '../generated/prisma/client';
import type { BrokerMarket } from './broker-code.rules';
import type { BrokerBackfillRunView } from './list-broker-backfill-runs.usecase';
import type { BrokerOrderDetail } from './get-broker-order.usecase';
import type { BrokerPositionDetail } from './get-broker-position.usecase';
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
    description:
      '组内行: 正股段在前、期权段在后; 期权段已到期沉底, 段内沽(P) 先于购(C)、到期日近的在前、行权价升序',
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

export class BrokerPositionOrderItemResponse {
  @ApiProperty({ description: '订单行 id (数字串, 进订单详情用)', example: '88' })
  id!: string;

  @ApiProperty({ description: '交易方向 (券商枚举原样)', example: 'SELL_SHORT' })
  side!: string;

  @ApiProperty({ description: '订单数量', example: '2' })
  qty!: string;

  @ApiProperty({ description: '订单价格', type: 'string', nullable: true, example: '3.2' })
  price!: string | null;

  @ApiProperty({ description: '订单状态 (券商枚举原样)', example: 'FILLED_ALL' })
  status!: string;

  @ApiProperty({
    description: '下单时间, 交易所当地 YYYY-MM-DD HH:mm:ss; 券商未给 ⇒ null',
    type: 'string',
    nullable: true,
    example: '2026-09-01 09:30:00',
  })
  createdAtLocal!: string | null;
}

export class BrokerLotResponse {
  @ApiProperty({
    description: '批次开仓时间, 交易所当地 YYYY-MM-DD HH:mm:ss',
    example: '2026-09-01 10:00:00',
  })
  openedAtLocal!: string;

  @ApiProperty({
    description: '开仓订单行 id (数字串); 成交缺订单号或订单行查不到 ⇒ null (不可进入订单详情)',
    type: 'string',
    nullable: true,
    example: '88',
  })
  orderDbId!: string | null;

  @ApiProperty({ description: '批次开仓成交数量合计 (带符号, 空头为负)', example: '-2' })
  originalQty!: string;

  @ApiProperty({ description: '先开先平扣减后的剩余数量 (带符号, 恒 ≠ 0)', example: '-1' })
  remainingQty!: string;

  @ApiProperty({ description: '批次成本 (开仓成交数量加权均价)', example: '3.2' })
  cost!: string;

  @ApiProperty({
    description: '批次市值 = 持仓市值 × 剩余 ÷ 持仓数量; 持仓市值缺失 ⇒ null',
    type: 'string',
    nullable: true,
    example: '-150',
  })
  marketValue!: string | null;

  @ApiProperty({
    description: '批次持仓盈亏 = (现价 − 成本) × 剩余 × 乘数; 现价或开仓订单缺失 ⇒ null',
    type: 'string',
    nullable: true,
    example: '170',
  })
  unrealizedPl!: string | null;
}

export class BrokerLotsResponse {
  @ApiProperty({
    description: '批次剩余合计 = 券商持仓数量; false ⇒ 客户端显示「批次无法还原」且不渲染批次',
    example: true,
  })
  restorable!: boolean;

  @ApiProperty({
    description: '剩余 ≠ 0 的批次, 按开仓时间升序 (restorable=false 时照常返回)',
    type: [BrokerLotResponse],
  })
  lots!: BrokerLotResponse[];
}

export class BrokerPositionDetailResponse extends BrokerPositionRowResponse {
  @ApiProperty({
    description: '开仓时间, 交易所当地 YYYY-MM-DD HH:mm:ss (时区按 market)',
    example: '2026-09-01 10:00:00',
  })
  openedAtLocal!: string;

  @ApiProperty({
    description:
      '本持仓代码在该连接的订单 (含组合单腿); 开仓时间来源 derived ⇒ 只含最后更新时间不早于开仓时间的订单, ' +
      'fallback ⇒ 全部; 下单时间降序, 缺失排末',
    type: [BrokerPositionOrderItemResponse],
  })
  orders!: BrokerPositionOrderItemResponse[];

  @ApiProperty({
    description: '持仓批次 (期权才有; 正股为 null)',
    type: BrokerLotsResponse,
    nullable: true,
  })
  lots!: BrokerLotsResponse | null;
}

export function toBrokerPositionDetailResponse(
  detail: BrokerPositionDetail,
): BrokerPositionDetailResponse {
  return {
    ...toBrokerPositionRowResponse(detail.row),
    openedAtLocal: detail.openedAtLocal,
    orders: detail.orders.map((o) => ({
      id: o.id.toString(),
      side: o.side,
      qty: o.qty.toFixed(),
      price: decimalString(o.price),
      status: o.status,
      createdAtLocal: o.createdAtLocal,
    })),
    lots:
      detail.lots === null
        ? null
        : {
            restorable: detail.lots.restorable,
            lots: detail.lots.lots.map((lot) => ({
              openedAtLocal: lot.openedAtLocal,
              orderDbId: lot.orderDbId === null ? null : lot.orderDbId.toString(),
              originalQty: lot.originalQty.toFixed(),
              remainingQty: lot.remainingQty.toFixed(),
              cost: lot.cost.toFixed(),
              marketValue: decimalString(lot.marketValue),
              unrealizedPl: decimalString(lot.unrealizedPl),
            })),
          },
  };
}

export class BrokerOrderDetailResponse {
  @ApiProperty({ description: '订单行 id (数字串)', example: '88' })
  id!: string;

  @ApiProperty({ description: '市场 (标时区用)', enum: BROKER_MARKETS, example: 'us' })
  market!: BrokerMarket;

  @ApiProperty({ description: '交易方向 (券商枚举原样)', example: 'SELL_SHORT' })
  side!: string;

  @ApiProperty({ description: '订单状态 (券商枚举原样)', example: 'FILLED_ALL' })
  status!: string;

  @ApiProperty({
    description: '订单类型 (券商枚举原样)',
    type: 'string',
    nullable: true,
    example: 'NORMAL',
  })
  orderType!: string | null;

  @ApiProperty({ description: '券商原始代码 (组合单为合成码)', example: 'US.ZQY261016P30000' })
  code!: string;

  @ApiProperty({ description: '正股名 (取不到回落券商名 / 正股代码)', example: '示例' })
  name!: string;

  @ApiProperty({
    description: '期权字段 (正股 / 组合单为 null)',
    type: BrokerPositionOptionResponse,
    nullable: true,
  })
  option!: BrokerPositionOptionResponse | null;

  @ApiProperty({
    description: '组合单各腿券商代码 (非组合单为空数组)',
    type: [String],
    example: ['US.ZQY261016P25000', 'US.ZQY261016P30000'],
  })
  comboLegCodes!: string[];

  @ApiProperty({ description: '订单数量', example: '2' })
  qty!: string;

  @ApiProperty({ description: '订单价格', type: 'string', nullable: true, example: '3.2' })
  price!: string | null;

  @ApiProperty({
    description: '订单金额 (券商原值; 缺失 ⇒ null)',
    type: 'string',
    nullable: true,
    example: '3200',
  })
  amount!: string | null;

  @ApiProperty({
    description: '成交数量; 未成交 (0 / 缺失) ⇒ null',
    type: 'string',
    nullable: true,
    example: '2',
  })
  dealtQty!: string | null;

  @ApiProperty({
    description: '成交均价; 未成交 ⇒ null',
    type: 'string',
    nullable: true,
    example: '3.1',
  })
  dealtAvgPrice!: string | null;

  @ApiProperty({
    description:
      '成交金额 = 成交数量 × 成交均价 × 乘数 (乘数 = 订单金额 ÷ (数量 × 价格) 取整); 价格为 0 ⇒ 0; ' +
      '未成交或乘数推不出 ⇒ null',
    type: 'string',
    nullable: true,
    example: '3100',
  })
  dealtAmount!: string | null;

  @ApiProperty({ description: '币种', type: 'string', nullable: true, example: 'USD' })
  currency!: string | null;

  @ApiProperty({
    description: '下单时间, 交易所当地 YYYY-MM-DD HH:mm:ss (时区按 market); 券商未给 ⇒ null',
    type: 'string',
    nullable: true,
    example: '2026-09-01 09:30:00',
  })
  createdAtLocal!: string | null;
}

export function toBrokerOrderDetailResponse(detail: BrokerOrderDetail): BrokerOrderDetailResponse {
  return {
    id: detail.id.toString(),
    market: detail.market,
    side: detail.side,
    status: detail.status,
    orderType: detail.orderType,
    code: detail.code,
    name: detail.name,
    option:
      detail.option === null
        ? null
        : {
            expiry: detail.option.expiry,
            right: detail.option.right,
            strike: detail.option.strike.toFixed(),
          },
    comboLegCodes: detail.comboLegCodes,
    qty: detail.qty.toFixed(),
    price: decimalString(detail.price),
    amount: decimalString(detail.amount),
    dealtQty: decimalString(detail.dealtQty),
    dealtAvgPrice: decimalString(detail.dealtAvgPrice),
    dealtAmount: decimalString(detail.dealtAmount),
    currency: detail.currency,
    createdAtLocal: detail.createdAtLocal,
  };
}

/** 单次请求 ticker 上限 (plan D12)。 */
const BACKFILL_RUN_TICKERS_MAX = 50;

/** 补齐记录状态值域 = 082 写入方所写的全部值 (subscriber 插 pending; 同步 use case 写 running / succeeded / failed)。 */
const BACKFILL_RUN_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;

/** GET /api/v1/optionsdesk/broker-backfill-runs 查询参数。 */
export class BrokerBackfillRunsQuery {
  @ApiProperty({
    description: `正股 canonical ticker, 逗号分隔, 1–${BACKFILL_RUN_TICKERS_MAX} 个, 每个以 us: 或 hk: 开头`,
    type: 'string',
    example: 'us:ZQX,hk:08801',
  })
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BACKFILL_RUN_TICKERS_MAX)
  @Matches(/^(us|hk):/, { each: true })
  tickers!: string[];
}

export class BrokerBackfillRunResponse {
  @ApiProperty({ description: '正股 canonical ticker (与请求同形)', example: 'us:ZQX' })
  ticker!: string;

  @ApiProperty({
    description: '该账号该 ticker 最新一条补齐记录的状态',
    enum: BACKFILL_RUN_STATUSES,
    example: 'succeeded',
  })
  status!: string;

  @ApiProperty({
    description:
      '状态对应时刻 (ISO 8601 UTC): succeeded / failed = 结束时刻; running = 开始时刻; pending = 下次尝试时刻; 缺失 ⇒ null',
    type: 'string',
    nullable: true,
    example: '2026-09-10T13:15:00.000Z',
  })
  at!: string | null;

  @ApiProperty({
    description: '同上, 交易所当地时间串 YYYY-MM-DD HH:mm:ss (市场取 ticker 前缀)',
    type: 'string',
    nullable: true,
    example: '2026-09-10 09:15:00',
  })
  atLocal!: string | null;
}

export function toBrokerBackfillRunResponse(run: BrokerBackfillRunView): BrokerBackfillRunResponse {
  return {
    ticker: run.ticker,
    status: run.status,
    at: run.at === null ? null : run.at.toISOString(),
    atLocal: run.atLocal,
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
