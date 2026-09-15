import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { exchangeLocalDateTime } from '../marketdata/session-clock';
import { PrismaService } from '../security/prisma.service';
import { parseBrokerCode, type BrokerMarket } from './broker-code.rules';
import { resolveMultiplier } from './broker-lots.rules';
import { rawDecimal, rawRecord, resolveUnderlyingNames } from './list-broker-positions.usecase';

/**
 * 083 US2 / US3 —— 交易账户页**订单详情**读端 (FR-017 / FR-020; plan D11)。
 *
 * 🚨 **只读** (Guardrail 1): 零写路径、零事务; 🚫 任何撤单 / 改单入口 (FR-019)。
 *
 * 🚨 **账号隔离在查询条件里** (Guardrail 2): 按 id 读 = `findFirst({ id, accountId })`, 🚫
 * `findUnique` 后在代码里比账号 —— 「不存在 / 属于他人 / 正股未归类 / 不在锚集」四种情况抛同一个
 * {@link BROKER_ORDER_NOT_FOUND}, 响应逐字节相同 (反枚举, 同持仓详情读端)。
 *
 * 乘数与持仓批次同源 (`broker-lots.rules.ts` 的 `resolveMultiplier`, 🚫 在这里另写): 两处口径一旦分叉,
 * 同一张订单在批次盈亏与成交金额里会按不同乘数计。
 */

export const BROKER_ORDER_NOT_FOUND = 'BROKER_ORDER_NOT_FOUND';

export interface BrokerOrderDetail {
  id: bigint;
  market: BrokerMarket;
  side: string;
  status: string;
  orderType: string | null;
  code: string;
  /** 正股名 (取名口径同持仓列表行)。 */
  name: string;
  /** 期权字段; 正股 / 组合单 ⇒ null。 */
  option: { expiry: string; right: 'C' | 'P'; strike: Prisma.Decimal } | null;
  comboLegCodes: string[];
  qty: Prisma.Decimal;
  price: Prisma.Decimal | null;
  /** `raw.amount`; 缺失 ⇒ null。 */
  amount: Prisma.Decimal | null;
  dealtQty: Prisma.Decimal | null;
  dealtAvgPrice: Prisma.Decimal | null;
  dealtAmount: Prisma.Decimal | null;
  currency: string | null;
  /** 下单时间, 交易所当地 `YYYY-MM-DD HH:mm:ss`; 券商未给 ⇒ null。 */
  createdAtLocal: string | null;
}

type DealtFields = Pick<BrokerOrderDetail, 'dealtQty' | 'dealtAvgPrice' | 'dealtAmount'>;

const NOT_DEALT: DealtFields = { dealtQty: null, dealtAvgPrice: null, dealtAmount: null };

/**
 * 成交三字段 (plan D11)。O(1)。
 *
 * - 成交数量为 0 / 缺失 ⇒ 三个全 null (mobile 显示「—」, 🚫 显示 0)。
 * - 价格为 0 (到期作废类系统单) ⇒ 成交金额 0 —— 🚨 必须先于乘数判断: 乘数在价格为 0 时推不出 (null),
 *   不单列这一支会把它变成 null。
 * - 其余 = 成交数量 × 成交均价 × 乘数; 均价或乘数推不出 ⇒ 金额 null。
 */
function resolveDealt(
  order: { id: bigint; qty: Prisma.Decimal; price: Prisma.Decimal | null },
  amount: Prisma.Decimal | null,
  raw: Record<string, unknown>,
): DealtFields {
  const dealtQty = rawDecimal(raw.dealt_qty);
  if (dealtQty === null || dealtQty.isZero()) return NOT_DEALT;
  const dealtAvgPrice = rawDecimal(raw.dealt_avg_price);
  if (order.price !== null && order.price.isZero()) {
    return { dealtQty, dealtAvgPrice, dealtAmount: new Prisma.Decimal(0) };
  }
  const multiplier = resolveMultiplier({ ...order, amount });
  return {
    dealtQty,
    dealtAvgPrice,
    dealtAmount:
      dealtAvgPrice === null || multiplier === null
        ? null
        : dealtQty.times(dealtAvgPrice).times(multiplier),
  };
}

@Injectable()
export class GetBrokerOrderUseCase {
  constructor(private readonly prisma: PrismaService) {}

  /** 复杂度: 3 次查询 (订单 / 锚 / 名称), 其余 O(1)。 */
  async execute(accountId: bigint, orderId: bigint): Promise<BrokerOrderDetail> {
    const order = await this.prisma.brokerOrder.findFirst({ where: { id: orderId, accountId } });
    const ticker = order?.underlyingTicker ?? null;
    if (order === null || ticker === null) {
      throw new NotFoundException(BROKER_ORDER_NOT_FOUND);
    }
    // 锚集 = 锚表全部行 (含 excluded; 锚全局、无 account_id, 同持仓读端 plan D2)。
    const anchor = await this.prisma.anchor.findUnique({ where: { ticker }, select: { id: true } });
    if (anchor === null) {
      throw new NotFoundException(BROKER_ORDER_NOT_FOUND);
    }

    // 组合单 `code` 是合成码、不解析 (schema 注释 / FR-007); 其 `stock_name` 无从确认是正股名 ⇒ 不参与取名。
    const isCombo = order.comboLegCodes.length > 0;
    const names = await resolveUnderlyingNames(this.prisma, [
      isCombo ? { ...order, raw: {} } : order,
    ]);
    const parsed = isCombo ? null : parseBrokerCode(order.code);
    const raw = rawRecord(order.raw);
    const amount = rawDecimal(raw.amount);
    const market = order.market as BrokerMarket;

    return {
      id: order.id,
      market,
      side: order.side,
      status: order.status,
      orderType: order.orderType,
      code: order.code,
      name: names.get(ticker) ?? order.code,
      option:
        parsed?.kind === 'option'
          ? { expiry: parsed.expiry, right: parsed.right, strike: parsed.strike }
          : null,
      comboLegCodes: order.comboLegCodes,
      qty: order.qty,
      price: order.price,
      amount,
      ...resolveDealt(order, amount, raw),
      currency: order.currency,
      createdAtLocal:
        order.vendorCreatedAt === null
          ? null
          : exchangeLocalDateTime(market, order.vendorCreatedAt),
    };
  }
}
