import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { exchangeLocalDateTime } from '../marketdata/session-clock';
import { PrismaService } from '../security/prisma.service';
import { restoreLots, type BrokerLot, type LotOrder } from './broker-lots.rules';
import type { BrokerTradeSide } from './broker-opened-at.rules';
import { isExpired } from './broker-position-display.rules';
import {
  rawDecimal,
  rawRecord,
  resolveUnderlyingNames,
  toBrokerPositionRow,
  type BrokerConnectionLabel,
  type BrokerPositionListRow,
  type BrokerPositionRecord,
} from './list-broker-positions.usecase';

/**
 * 083 US2 / US3 —— 交易账户页**持仓详情**读端: 汇总 + 订单列表 + 批次
 * (FR-013 / FR-014 / FR-015 / FR-016 / FR-017 / FR-020; plan D9 / D10)。
 *
 * 🚨 **只读** (Guardrail 1): 零写路径、零事务。
 *
 * 🚨 **账号隔离在查询条件里** (Guardrail 2): 按 id 读 = `findFirst({ id, accountId })`, 🚫
 * `findUnique` 后在代码里比账号 —— 「不存在 / 属于他人 / 正股未归类 / 不在锚集」四种情况抛同一个
 * {@link BROKER_POSITION_NOT_FOUND}, 响应逐字节相同 (反枚举: 他人的 id 不可探测)。本文件其余
 * `broker_*` 查询同样带 `accountId`。
 *
 * 汇总与列表行逐字段同口径: 行组装复用 `list-broker-positions.usecase.ts`, 到期判定复用
 * `broker-position-display.rules.ts` 的 `isExpired` (🚫 在这里另写)。
 */

export const BROKER_POSITION_NOT_FOUND = 'BROKER_POSITION_NOT_FOUND';

/** 连接行被人工删除而持仓未清 ⇒ 照常展示、标签为空 (同列表读端)。 */
const ORPHAN_CONNECTION: BrokerConnectionLabel = { brokerCode: '', label: '' };

export interface BrokerPositionOrderView {
  id: bigint;
  side: string;
  qty: Prisma.Decimal;
  price: Prisma.Decimal | null;
  status: string;
  /** 下单时间, 交易所当地 `YYYY-MM-DD HH:mm:ss`; 券商未给 ⇒ null。 */
  createdAtLocal: string | null;
}

export interface BrokerLotView extends BrokerLot {
  /** 批次开仓时间, 交易所当地 `YYYY-MM-DD HH:mm:ss`。 */
  openedAtLocal: string;
}

export interface BrokerPositionDetail {
  row: BrokerPositionListRow;
  /** 开仓时间, 交易所当地 `YYYY-MM-DD HH:mm:ss`。 */
  openedAtLocal: string;
  /** `vendorCreatedAt` 降序 (null 排末) → `orderId`。 */
  orders: BrokerPositionOrderView[];
  /** 期权才有; 正股 ⇒ null。`restorable=false` 时批次照常返回 (由 mobile 隐藏)。 */
  lots: { restorable: boolean; lots: BrokerLotView[] } | null;
}

@Injectable()
export class GetBrokerPositionUseCase {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 复杂度: 期权至多 7 次查询 (持仓 / 锚 / 连接 / 名称 / 订单列表 / 成交 / 批次订单), 正股 5 次;
   * 批次还原 O(d log d), d = 该合约成交数; 订单排序在 DB。
   */
  async execute(
    accountId: bigint,
    positionId: bigint,
    now: Date = new Date(),
  ): Promise<BrokerPositionDetail> {
    const position = await this.prisma.brokerPosition.findFirst({
      where: { id: positionId, accountId },
    });
    const ticker = position?.underlyingTicker ?? null;
    if (position === null || ticker === null) {
      throw new NotFoundException(BROKER_POSITION_NOT_FOUND);
    }
    // 锚集 = 锚表全部行 (含 excluded; 锚全局、无 account_id, 同列表读端 plan D2)。
    const anchor = await this.prisma.anchor.findUnique({ where: { ticker }, select: { id: true } });
    if (anchor === null) {
      throw new NotFoundException(BROKER_POSITION_NOT_FOUND);
    }

    const connection = await this.prisma.brokerConnection.findFirst({
      where: { id: position.connectionId, accountId },
      select: { brokerCode: true, label: true },
    });
    const names = await resolveUnderlyingNames(this.prisma, [position]);
    const base = toBrokerPositionRow(
      position,
      connection ?? ORPHAN_CONNECTION,
      names.get(ticker) ?? position.code,
    );
    const row: BrokerPositionListRow = { ...base, expired: isExpired(base, now) };
    const localOf = (instant: Date) => exchangeLocalDateTime(row.market, instant);

    const orders = await this.prisma.brokerOrder.findMany({
      where: {
        accountId,
        connectionId: position.connectionId,
        OR: [{ code: position.code }, { comboLegCodes: { has: position.code } }],
        // 🚨 推算来源 ⇒ 按**最后更新时间** ≥ 开仓时间, 🚫 `vendorCreatedAt`: 开仓订单通常在开仓
        // 时间之前下单、之后成交, 按下单时间过滤会静默滤掉全部开仓单 (plan D9 / V2, FR-016)。
        // 回落来源 (开仓时间 = 首次发现时刻) ⇒ 全部。
        ...(position.openedAtSource === 'derived'
          ? { vendorUpdatedAt: { gte: position.openedAt } }
          : {}),
      },
      orderBy: [{ vendorCreatedAt: { sort: 'desc', nulls: 'last' } }, { orderId: 'asc' }],
      select: { id: true, side: true, qty: true, price: true, status: true, vendorCreatedAt: true },
    });

    const restored = row.kind === 'option' ? await this.restoreLotsOf(accountId, position) : null;

    return {
      row,
      openedAtLocal: localOf(position.openedAt),
      orders: orders.map((o) => ({
        id: o.id,
        side: o.side,
        qty: o.qty,
        price: o.price,
        status: o.status,
        createdAtLocal: o.vendorCreatedAt === null ? null : localOf(o.vendorCreatedAt),
      })),
      lots:
        restored === null
          ? null
          : {
              restorable: restored.restorable,
              lots: restored.lots.map((lot) => ({ ...lot, openedAtLocal: localOf(lot.openedAt) })),
            },
    };
  }

  /**
   * 该连接该合约的全部成交 + 其订单行 → FIFO 批次 (plan D10)。乘数只从订单 `raw.amount` 推,
   * 🚫 读 `option_contract` (Guardrail 7)。订单行查不到 ⇒ 该批次 `orderDbId` / 盈亏为 null。
   */
  private async restoreLotsOf(accountId: bigint, position: BrokerPositionRecord) {
    const deals = await this.prisma.brokerDeal.findMany({
      where: {
        accountId,
        connectionId: position.connectionId,
        market: position.market,
        code: position.code,
      },
      select: { dealId: true, orderId: true, side: true, qty: true, price: true, tradedAt: true },
    });
    const orderIds = [...new Set(deals.flatMap((d) => (d.orderId === null ? [] : [d.orderId])))];
    const orderRows =
      orderIds.length === 0
        ? []
        : await this.prisma.brokerOrder.findMany({
            where: { accountId, connectionId: position.connectionId, orderId: { in: orderIds } },
            select: { id: true, orderId: true, qty: true, price: true, raw: true },
          });
    const orders = new Map<string, LotOrder>(
      orderRows.map((o) => [
        o.orderId,
        { id: o.id, qty: o.qty, price: o.price, amount: rawDecimal(rawRecord(o.raw).amount) },
      ]),
    );
    return restoreLots({
      // 成交方向在写入时已校验值域 (`futu-broker-account.adapter.ts` 的成交解析, 未知方向即抛)。
      deals: deals.map((d) => ({ ...d, side: d.side as BrokerTradeSide })),
      positionQty: position.qty,
      currentPrice: position.currentPrice,
      positionMarketValue: position.marketValue,
      orders,
    });
  }
}
