import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { optionsdeskConfig, type OptionsdeskConfig } from '../config/optionsdesk.config';
import { exchangeClock } from '../marketdata/session-clock';
import { PrismaService } from '../security/prisma.service';
import {
  BROKER_ACCOUNT_PORT,
  type BrokerAccountPort,
  type BrokerDealRow,
  type BrokerOrderRow,
  type BrokerTradeWindow,
} from './broker-account.port';
import type { BrokerMarket } from './broker-code.rules';
import { inBrokerScope } from './broker-scope.rules';
import { splitTradeWindow } from './broker-sync-slot.rules';
import { createBrokerUnderlyingResolver, underlyingOfOrder } from './resolve-broker-underlying';

/**
 * `'all-history'` 的起点。EVIDENCE: spec Assumptions —— 维护者 2026-09-14 定上线回填起点
 * 2024-09-01, 实测可回溯的最早成交与订单在 2024-10 前后。
 */
export const BROKER_HISTORY_START = '2024-09-01';

/** 订单两步写每个短事务的行数上限: 控制单事务时长, 不让全量历史变成一个长事务。 */
const ORDER_WRITE_CHUNK = 200;

export type BrokerSyncMode = 'backfill' | 'reconcile';

export interface SyncBrokerAccountInput {
  connectionId: bigint;
  markets: readonly BrokerMarket[];
  /** 单只标的 canonical ticker, 或 `'*'` = 同步范围内全部标的。只影响过滤, 不影响拉取 (D1)。 */
  target: string;
  /** 两端含的 `YYYY-MM-DD`; `'all-history'` = {@link BROKER_HISTORY_START} 至交易所当地今天。 */
  window: BrokerTradeWindow | 'all-history';
  mode: BrokerSyncMode;
  now?: Date;
}

export interface SyncBrokerAccountResult {
  /** 成交新插入行数 (`createMany` 返回值; 对账的「补回」口径)。 */
  dealsInserted: number;
  /** 订单新插入行数。 */
  ordersInserted: number;
  /** 既有订单被更新版本覆盖的行数。 */
  ordersUpdated: number;
  /** 过滤后送写的成交 / 订单里正股未解析的条数 (FR-006: 照常写入)。 */
  unresolvedDeals: number;
  unresolvedOrders: number;
}

type FetchedMarket = {
  market: BrokerMarket;
  deals: BrokerDealRow[];
  orders: BrokerOrderRow[];
};

/**
 * 082 券商账户同步 use case —— 「新建锚补齐」与「开盘前对账」共用的唯一入口 (plan D1;
 * FR-001 / FR-005 / FR-007 / FR-009 / FR-012 / FR-013)。
 *
 * 流程: 读连接行 (取 `accountId`) + 锚集 → **事务外**按 90 天分段拉成交与订单 (split-tx, P6)
 * → 按市场判正股 (T013) → `inBrokerScope` + `target` 过滤 → 原子幂等写。
 * 持仓刷新与同步记录归 T015, 接在 {@link execute} 写完成交订单之后。
 *
 * 🚨 **全部市场拉完才开始写**: 任一拉取抛错 ⇒ 零写入, 既有数据不动 (branch 8 的成交 / 订单半)。
 * 🚨 **原子写, 禁先查后写** (Guardrail 8): 补齐与对账可能并发写同一连接, 先查后写撞唯一约束抛
 * `P2002`, 会被当成基础设施失败进入重试。
 */
@Injectable()
export class SyncBrokerAccountUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BROKER_ACCOUNT_PORT) private readonly port: BrokerAccountPort,
    @Inject(optionsdeskConfig.KEY) private readonly config: OptionsdeskConfig,
  ) {}

  async execute(input: SyncBrokerAccountInput): Promise<SyncBrokerAccountResult> {
    const now = input.now ?? new Date();
    const { accountId } = await this.prisma.brokerConnection.findUniqueOrThrow({
      where: { id: input.connectionId },
      select: { accountId: true },
    });
    // 锚表**全部**行, 含 excluded (U8): 不参与交易 ≠ 不看它的成交。每次同步读一次。
    const anchors = await this.prisma.anchor.findMany({ select: { ticker: true } });
    const anchoredTickers = new Set(anchors.map((a) => a.ticker));

    const fetched: FetchedMarket[] = [];
    for (const market of input.markets) {
      fetched.push(await this.fetchMarket(market, resolveWindow(input.window, market, now)));
    }

    const result: SyncBrokerAccountResult = {
      dealsInserted: 0,
      ordersInserted: 0,
      ordersUpdated: 0,
      unresolvedDeals: 0,
      unresolvedOrders: 0,
    };
    for (const { market, deals, orders } of fetched) {
      const resolver = createBrokerUnderlyingResolver(
        { prisma: this.prisma, port: this.port },
        { market, now },
      );
      const resolved = await resolver.resolve([
        ...deals.map((d) => d.code),
        ...orders.flatMap((o) => [o.code, ...o.comboLegCodes]),
      ]);
      const keep = (underlyingTicker: string | null) =>
        inBrokerScope({
          scope: this.config.brokerSyncScope,
          anchoredTickers,
          underlyingTicker,
          accountId,
        }) &&
        // 未解析恒保留 (FR-006), 单只标的补齐也不例外 —— 判不出 ≠ 与该标的无关。
        (input.target === '*' || underlyingTicker === null || underlyingTicker === input.target);

      const dealRows = deals
        .map((d) => ({ row: d, underlyingTicker: resolved.get(d.code) ?? null }))
        .filter((d) => keep(d.underlyingTicker));
      const orderRows = orders
        .map((o) => ({ row: o, underlyingTicker: underlyingOfOrder(o, resolved) }))
        .filter((o) => keep(o.underlyingTicker));

      result.dealsInserted += await this.writeDeals(input.connectionId, accountId, dealRows);
      const orderCounts = await this.writeOrders(input.connectionId, accountId, orderRows);
      result.ordersInserted += orderCounts.inserted;
      result.ordersUpdated += orderCounts.updated;
      result.unresolvedDeals += dealRows.filter((d) => d.underlyingTicker === null).length;
      result.unresolvedOrders += orderRows.filter((o) => o.underlyingTicker === null).length;
    }
    return result;
  }

  /**
   * 分段拉取一个市场的成交与订单 (事务外)。相邻段重叠 1 天 ⇒ 同一行可能出现两次, 写入前按唯一号
   * 去重。复杂度 O(段数) 次串行调用 —— 串行是刻意的: shim 对历史成交 / 历史订单各限 10 次 / 30 s
   * (EVIDENCE: `services/futu-shim/src/futu_shim/ratelimit.py:73-75`, 出处指富途文档
   * get-history-order-fill-list / get-history-order-list), 全量历史约 9 段, 并发会直接顶到上限。
   */
  private async fetchMarket(
    market: BrokerMarket,
    window: BrokerTradeWindow,
  ): Promise<FetchedMarket> {
    const deals: BrokerDealRow[] = [];
    const orders: BrokerOrderRow[] = [];
    for (const segment of splitTradeWindow(window)) {
      deals.push(...(await this.port.fetchDeals(market, segment)));
      orders.push(...(await this.port.fetchOrders(market, segment)));
    }
    return { market, deals, orders };
  }

  /** 成交不可变 ⇒ 一条 `createMany({ skipDuplicates })`, 返回插入数。复杂度 O(n log n) (排序)。 */
  private async writeDeals(
    connectionId: bigint,
    accountId: bigint,
    rows: { row: BrokerDealRow; underlyingTicker: string | null }[],
  ): Promise<number> {
    const unique = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!unique.has(r.row.dealId)) unique.set(r.row.dealId, r);
    if (unique.size === 0) return 0;
    const { count } = await this.prisma.brokerDeal.createMany({
      data: [...unique.values()]
        .sort((a, b) => compare(a.row.dealId, b.row.dealId))
        .map(({ row, underlyingTicker }) => ({
          accountId,
          connectionId,
          market: row.market,
          dealId: row.dealId,
          orderId: row.orderId,
          code: row.code,
          underlyingTicker,
          side: row.side,
          qty: row.qty,
          price: row.price,
          currency: row.currency,
          tradedAt: row.tradedAt,
          raw: row.raw as Prisma.InputJsonValue,
        })),
      skipDuplicates: true,
    });
    return count;
  }

  /**
   * 订单两步原子写 (FR-013): `createMany({ skipDuplicates })` 插新单, 再对**全部**入参
   * `updateMany where vendorUpdatedAt < incoming` —— 较旧版本永远改不动较新版本, 且两个并发
   * 写方谁先谁后结果都收敛到最新版本。
   *
   * 按 `orderId` 升序写: 并发事务取行锁顺序一致, 不成环 (无死锁)。批内同单多版本只留最新。
   * 复杂度 O(n log n) 排序 + O(n) 条 UPDATE, 每 {@link ORDER_WRITE_CHUNK} 行一个短事务。
   */
  private async writeOrders(
    connectionId: bigint,
    accountId: bigint,
    rows: { row: BrokerOrderRow; underlyingTicker: string | null }[],
  ): Promise<{ inserted: number; updated: number }> {
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const seen = latest.get(r.row.orderId);
      if (
        seen === undefined ||
        seen.row.vendorUpdatedAt.getTime() < r.row.vendorUpdatedAt.getTime()
      ) {
        latest.set(r.row.orderId, r);
      }
    }
    const data = [...latest.values()]
      .sort((a, b) => compare(a.row.orderId, b.row.orderId))
      .map(({ row, underlyingTicker }) => ({
        accountId,
        connectionId,
        market: row.market,
        orderId: row.orderId,
        code: row.code,
        comboLegCodes: row.comboLegCodes,
        underlyingTicker,
        side: row.side,
        orderType: row.orderType,
        qty: row.qty,
        price: row.price,
        status: row.status,
        currency: row.currency,
        vendorCreatedAt: row.vendorCreatedAt,
        vendorUpdatedAt: row.vendorUpdatedAt,
        raw: row.raw as Prisma.InputJsonValue,
      }));

    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < data.length; i += ORDER_WRITE_CHUNK) {
      const chunk = data.slice(i, i + ORDER_WRITE_CHUNK);
      await this.prisma.$transaction(async (tx) => {
        inserted += (await tx.brokerOrder.createMany({ data: chunk, skipDuplicates: true })).count;
        for (const order of chunk) {
          const { count } = await tx.brokerOrder.updateMany({
            where: {
              connectionId,
              orderId: order.orderId,
              vendorUpdatedAt: { lt: order.vendorUpdatedAt },
            },
            data: order,
          });
          updated += count;
        }
      });
    }
    return { inserted, updated };
  }
}

function resolveWindow(
  window: SyncBrokerAccountInput['window'],
  market: BrokerMarket,
  now: Date,
): BrokerTradeWindow {
  if (window !== 'all-history') return window;
  return { start: BROKER_HISTORY_START, end: exchangeClock(market, now).date };
}

/** 码点序比较 (与 `localeCompare` 不同, 结果不随运行时 locale 变)。 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
