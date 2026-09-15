import { Prisma } from '../generated/prisma/client';
import { SIDE_SIGN, compareDeals, type OpenedAtDeal } from './broker-opened-at.rules';

/**
 * 083 持仓详情**持仓批次**还原纯函数 (plan D10; FR-013 / FR-014 / FR-015)。无 I/O、无 DI (ADR-0043 §4)。
 *
 * 🚨 与 `broker-opened-at.rules.ts` 共用排序键 `(tradedAt, dealId)` 与方向符号 (直接 import, 不另写):
 * 两者对「当前持仓周期」的切分必须一致, 否则开仓时间与批次会指向不同的周期。
 *
 * 🚨 减仓 MUST 按批次开仓时间**从早到晚** (FIFO) 扣减 —— 扣错批次不报错, 只让批次成本与剩余数量
 * 静默错位 (FR-014)。
 *
 * 数量一律 `Prisma.Decimal` 精确运算; 批次数量**带符号** (空头为负, 与券商持仓数量同号) ——
 * `(现价 − 成本) × 剩余 × 乘数` 只有在剩余带符号时对空头才给出正确的盈亏方向。
 */

export interface LotDeal extends OpenedAtDeal {
  /** 券商订单号; null ⇒ 该笔开仓成交单独成批次, 不可进入订单详情。 */
  orderId: string | null;
  price: Prisma.Decimal;
}

/** 开仓订单行中批次需要的字段 (调用方从 `broker_order` 行 + `raw.amount` 取)。 */
export interface LotOrder {
  /** `broker_order.id` —— 批次进入订单详情用。 */
  id: bigint;
  qty: Prisma.Decimal;
  price: Prisma.Decimal | null;
  /** `raw.amount`; 缺失 ⇒ null。 */
  amount: Prisma.Decimal | null;
}

export interface RestoreLotsInput {
  /** 该连接该合约的全部库内成交, 顺序不限。 */
  deals: readonly LotDeal[];
  /** 券商报告的持仓数量, **带符号** (空头为负)。 */
  positionQty: Prisma.Decimal;
  currentPrice: Prisma.Decimal | null;
  positionMarketValue: Prisma.Decimal | null;
  /** 券商订单号 → 订单行; 查不到 ⇒ 批次 `orderDbId` 与乘数均为 null。 */
  orders: ReadonlyMap<string, LotOrder>;
}

export interface BrokerLot {
  /** 批次首笔开仓成交时间。 */
  openedAt: Date;
  orderDbId: bigint | null;
  /** 批次开仓成交数量合计, 带符号。 */
  originalQty: Prisma.Decimal;
  /** 扣减后剩余, 带符号, 恒 ≠ 0。 */
  remainingQty: Prisma.Decimal;
  /** 批次开仓成交的数量加权均价。 */
  cost: Prisma.Decimal;
  /** `持仓市值 × 剩余 ÷ 持仓数量`; 市值为 null 或持仓为 0 ⇒ null。 */
  marketValue: Prisma.Decimal | null;
  /** `(现价 − 成本) × 剩余 × 乘数`; 现价或乘数为 null ⇒ null。 */
  unrealizedPl: Prisma.Decimal | null;
}

export interface RestoreLotsResult {
  /** Σ剩余 (带符号) = 券商持仓数量 (FR-015); false ⇒ mobile 显示「批次无法还原」。 */
  restorable: boolean;
  /** 剩余 ≠ 0 的批次, 按开仓时间升序。 */
  lots: BrokerLot[];
}

interface WorkingLot {
  openedAt: Date;
  orderId: string | null;
  /** 以下三项为绝对值; 方向 = 当前周期方向, 输出时再带符号。 */
  openedQty: Prisma.Decimal;
  openedNotional: Prisma.Decimal;
  remaining: Prisma.Decimal;
}

/**
 * 还原当前持仓周期的批次。入参不被原地修改。
 *
 * 1. 带符号累计; 由 0 变非 0 或正负翻转 ⇒ 清空批次开新周期 (翻转那笔先抵平旧仓、余量开新批次);
 *    累计回到 0 ⇒ 清空批次。
 * 2. 与持仓同向的成交按订单号归批次 (null ⇒ 单独成批次), 成本 = 数量加权均价。
 * 3. 反向成交从最早开仓的批次起扣减 (FIFO)。
 *
 * 复杂度 O(n log n): 排序 O(n log n) 主导; 扫描 O(n), 其中每笔减仓从最早批次起跳过已扣空的批次,
 * 单笔最坏 O(k) (k = 当前周期批次数, 单合约为个位数) —— 不用头指针, 因为已扣空的批次可被同一订单
 * 后续成交补回, 头指针会越过它而破坏 FIFO。
 */
export function restoreLots({
  deals,
  positionQty,
  currentPrice,
  positionMarketValue,
  orders,
}: RestoreLotsInput): RestoreLotsResult {
  const sorted = [...deals].sort(compareDeals);

  let net = new Prisma.Decimal(0);
  let lots: WorkingLot[] = [];
  let lotByOrderId = new Map<string, WorkingLot>();

  const open = (deal: LotDeal, qty: Prisma.Decimal): void => {
    const existing = deal.orderId === null ? undefined : lotByOrderId.get(deal.orderId);
    if (existing !== undefined) {
      existing.openedQty = existing.openedQty.plus(qty);
      existing.openedNotional = existing.openedNotional.plus(qty.times(deal.price));
      existing.remaining = existing.remaining.plus(qty);
      return;
    }
    const lot: WorkingLot = {
      openedAt: deal.tradedAt,
      orderId: deal.orderId,
      openedQty: qty,
      openedNotional: qty.times(deal.price),
      remaining: qty,
    };
    lots.push(lot);
    if (deal.orderId !== null) lotByOrderId.set(deal.orderId, lot);
  };

  const resetCycle = (): void => {
    lots = [];
    lotByOrderId = new Map();
  };

  for (const deal of sorted) {
    const signed = deal.qty.abs().times(SIDE_SIGN[deal.side]);
    if (signed.isZero()) continue;
    const prev = net;
    net = net.plus(signed);

    if (prev.isZero() || prev.isNegative() === signed.isNegative()) {
      // 开仓 / 加仓。
      open(deal, signed.abs());
    } else if (net.isZero()) {
      // 平到 0 ⇒ 本周期结束 (批次合计恒 = |prev|, 清空等价于全部扣完)。
      resetCycle();
    } else if (net.isNegative() !== prev.isNegative()) {
      // 翻转: 先抵平旧仓, 余量开新周期的首个批次。
      resetCycle();
      open(deal, net.abs());
    } else {
      deductFifo(lots, signed.abs());
    }
  }

  const output = lots
    .filter((lot) => !lot.remaining.isZero())
    .map((lot) =>
      toBrokerLot(lot, net.isNegative() ? -1 : 1, {
        positionQty,
        currentPrice,
        positionMarketValue,
        orders,
      }),
    );
  const remainingSum = output.reduce(
    (sum, lot) => sum.plus(lot.remainingQty),
    new Prisma.Decimal(0),
  );
  return { restorable: remainingSum.equals(positionQty), lots: output };
}

/** 工作批次 → 输出批次: 数量带上周期方向, 算成本 / 市值 / 盈亏。 */
function toBrokerLot(
  lot: WorkingLot,
  direction: 1 | -1,
  { positionQty, currentPrice, positionMarketValue, orders }: Omit<RestoreLotsInput, 'deals'>,
): BrokerLot {
  const order = lot.orderId === null ? undefined : orders.get(lot.orderId);
  const multiplier = order === undefined ? null : resolveMultiplier(order);
  const remainingQty = lot.remaining.times(direction);
  const cost = lot.openedNotional.div(lot.openedQty);
  return {
    openedAt: lot.openedAt,
    orderDbId: order?.id ?? null,
    originalQty: lot.openedQty.times(direction),
    remainingQty,
    cost,
    marketValue:
      positionMarketValue === null || positionQty.isZero()
        ? null
        : positionMarketValue.times(remainingQty).div(positionQty),
    unrealizedPl:
      currentPrice === null || multiplier === null
        ? null
        : currentPrice.minus(cost).times(remainingQty).times(multiplier),
  };
}

/** 从最早开仓的批次起扣减 `qty` (绝对值)。调用方保证 `qty` < 批次剩余合计。 */
function deductFifo(lots: WorkingLot[], qty: Prisma.Decimal): void {
  let left = qty;
  for (const lot of lots) {
    if (left.isZero()) return;
    if (lot.remaining.isZero()) continue;
    const take = Prisma.Decimal.min(lot.remaining, left);
    lot.remaining = lot.remaining.minus(take);
    left = left.minus(take);
  }
}

/**
 * 乘数 = 开仓订单 `amount ÷ (qty × price)` 取整 (plan V0b: 由持仓市值反推存在非整数, 不可用;
 * 🚫 读 `option_contract`)。价格缺失 / 为 0、数量为 0、金额缺失 ⇒ null。
 */
function resolveMultiplier(order: LotOrder): Prisma.Decimal | null {
  if (order.amount === null || order.price === null || order.price.isZero() || order.qty.isZero()) {
    return null;
  }
  const multiplier = order.amount.div(order.qty.times(order.price)).abs().round();
  return multiplier.isZero() ? null : multiplier;
}
