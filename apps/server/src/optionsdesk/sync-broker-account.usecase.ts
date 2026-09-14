import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { optionsdeskConfig, type OptionsdeskConfig } from '../config/optionsdesk.config';
import { exchangeClock } from '../marketdata/session-clock';
import { PrismaService } from '../security/prisma.service';
import {
  BROKER_ACCOUNT_PORT,
  BrokerInfrastructureError,
  type BrokerAccountPort,
  type BrokerDealRow,
  type BrokerOrderRow,
  type BrokerPositionRow,
  type BrokerTradeWindow,
} from './broker-account.port';
import type { BrokerMarket } from './broker-code.rules';
import { resolveOpenedAt, type BrokerTradeSide } from './broker-opened-at.rules';
import { planPositionSync, type PositionSyncPlan } from './broker-position-sync.rules';
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

/** = `broker_sync_run.error` 列 VarChar(512) (PG 按字符计)。 */
const RUN_ERROR_MAX_CHARS = 512;

export type BrokerSyncMode = 'backfill' | 'reconcile';

export interface SyncBrokerAccountInput {
  connectionId: bigint;
  /** 拉取并刷新持仓的市场。单只标的补齐传该标的所属市场; `'*'` 传全部市场 (clarify Q3)。 */
  markets: readonly BrokerMarket[];
  /** 单只标的 canonical ticker, 或 `'*'` = 同步范围内全部标的。只影响成交 / 订单过滤, 不影响拉取 (D1)。 */
  target: string;
  /** 两端含的 `YYYY-MM-DD`; `'all-history'` = {@link BROKER_HISTORY_START} 至交易所当地今天。 */
  window: BrokerTradeWindow | 'all-history';
  mode: BrokerSyncMode;
  /** 调用方已建好 / 已认领、处于 `running` 的同步记录。 */
  runId: bigint;
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

/** `infrastructure` = `instanceof BrokerInfrastructureError` (可重试); 其余一切 = `data` (port 判别口径)。 */
export type BrokerSyncFailureKind = 'infrastructure' | 'data';

export type SyncBrokerAccountOutcome =
  | ({ ok: true } & SyncBrokerAccountResult)
  | { ok: false; failureKind: BrokerSyncFailureKind; error: string };

type FetchedMarket = {
  market: BrokerMarket;
  deals: BrokerDealRow[];
  orders: BrokerOrderRow[];
  positions: BrokerPositionRow[];
};

type ExistingPosition = { market: BrokerMarket; code: string; firstSeenAt: Date };
type ReportedPosition = {
  market: BrokerMarket;
  code: string;
  row: BrokerPositionRow;
  underlyingTicker: string | null;
};

type PreparedMarket = {
  market: BrokerMarket;
  dealRows: { row: BrokerDealRow; underlyingTicker: string | null }[];
  orderRows: { row: BrokerOrderRow; underlyingTicker: string | null }[];
  positionPlan: PositionSyncPlan<ExistingPosition, ReportedPosition>;
};

type PositionCounts = { inserted: number; updated: number; deleted: number };

/**
 * 082 券商账户同步 use case —— 「新建锚补齐」与「开盘前对账」共用的唯一入口 (plan D1 / D8 / D12;
 * FR-001 / FR-005 / FR-007 / FR-009 / FR-011 / FR-012 / FR-013 / FR-014 / FR-015 / FR-016 / FR-017)。
 *
 * 流程 (四段, 前两段零业务写):
 * 1. 读连接行 (取 `accountId`) + 锚集 → **事务外**拉全部市场的成交 / 订单 (按 90 天分段) / 持仓 (split-tx, P6)。
 * 2. 按市场判正股 (T013, 一个市场一个 resolver, 成交 / 订单 / 持仓共用) → 范围过滤 → `planPositionSync`。
 * 3. 成交 / 订单原子幂等写。
 * 4. 按市场: 用**库内**成交 (含第 3 段刚写入的) 算开仓时间 → **一个**事务内插 / 改 / 删持仓并写 `syncedAt`。
 *
 * 🚨 **全部拉完、全部计划完才开始写**: 任一拉取抛错 (或持仓报告重复键) ⇒ 零写入, 既有数据不动
 * (branch 8)。持仓拉取若放到成交写入之后, 它的失败会留下半次同步的成交。
 * 🚨 **原子写, 禁先查后写** (Guardrail 8): 补齐与对账可能并发写同一连接, 先查后写撞唯一约束抛
 * `P2002`, 会被当成失败。持仓插入同样 `skipDuplicates`、更新按键 `updateMany`。
 *
 * ## 同步记录契约 (T015 定, T016 / T017 照此调用)
 *
 * - **记录由调用方创建或认领**, 进入 {@link execute} 时已是 `running` (建议认领 / 插入时一并写 `startedAt`)。
 * - 本用例: `startedAt` 为空才写 (= `now`); 结局 `updateMany where {id, status:'running'}` 回写
 *   `succeeded` + `written` (补齐) / `filled` (对账), 或 `failed` + `error` (截断 512); `finishedAt`
 *   = `now` + 实耗时。记录已不在 `running` (被卡死回收改写) ⇒ 不回写, 只 warn。`attempt` /
 *   `firstAttemptedAt` / `nextAttemptAt` 不碰 —— 重试策略归调用方 (基础设施失败时由调用方把 `failed` 改回 `pending`)。
 * - 失败**不抛**, 返回 `{ ok: false, failureKind }`; 仅记录行自身的读写失败 (DB 不可用) 会抛, 调用方须兜底。
 */
@Injectable()
export class SyncBrokerAccountUseCase {
  private readonly logger = new Logger(SyncBrokerAccountUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BROKER_ACCOUNT_PORT) private readonly port: BrokerAccountPort,
    @Inject(optionsdeskConfig.KEY) private readonly config: OptionsdeskConfig,
  ) {}

  async execute(input: SyncBrokerAccountInput): Promise<SyncBrokerAccountOutcome> {
    const now = input.now ?? new Date();
    const startedMs = Date.now();
    // 🚫 日志任何一行不带 accountId / 券商账户号 (D12, SC-010): 只用连接行 ID 定位。
    const scope = `mode=${input.mode} connection=${input.connectionId} markets=${input.markets.join(',')} target=${input.target}`;
    await this.prisma.brokerSyncRun.updateMany({
      where: { id: input.runId, startedAt: null },
      data: { startedAt: now },
    });

    let result: SyncBrokerAccountResult;
    let positions: PositionCounts;
    try {
      ({ result, positions } = await this.sync(input, now));
    } catch (err) {
      const failureKind: BrokerSyncFailureKind =
        err instanceof BrokerInfrastructureError ? 'infrastructure' : 'data';
      const error = truncateChars(
        err instanceof Error ? err.message : String(err),
        RUN_ERROR_MAX_CHARS,
      );
      await this.finish(input.runId, now, startedMs, { status: 'failed', error });
      this.logger.error(
        `券商同步失败 ${scope} failure=${failureKind} elapsedMs=${Date.now() - startedMs}: ${error}`,
      );
      return { ok: false, failureKind, error };
    }

    const filled = result.dealsInserted + result.ordersInserted;
    await this.finish(
      input.runId,
      now,
      startedMs,
      input.mode === 'reconcile'
        ? { status: 'succeeded', filled }
        : { status: 'succeeded', written: filled + result.ordersUpdated },
    );
    if (input.mode === 'reconcile' && filled > 0) {
      // FR-011 / branch 30: 补回 > 0 = 上一次同步漏了数据, 告警级留痕 (clarify Q4: 不主动通知)。
      this.logger.warn(
        `对账补回 ${filled} 条 (成交 ${result.dealsInserted} / 订单 ${result.ordersInserted}) ${scope}`,
      );
    }
    this.logger.log(
      `券商同步成功 ${scope} deals+${result.dealsInserted} orders+${result.ordersInserted}` +
        ` orders~${result.ordersUpdated} unresolved=${result.unresolvedDeals}/${result.unresolvedOrders}` +
        ` positions+${positions.inserted}~${positions.updated}-${positions.deleted}` +
        ` elapsedMs=${Date.now() - startedMs}`,
    );
    return { ok: true, ...result };
  }

  private async sync(
    input: SyncBrokerAccountInput,
    now: Date,
  ): Promise<{ result: SyncBrokerAccountResult; positions: PositionCounts }> {
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

    const prepared: PreparedMarket[] = [];
    for (const f of fetched) {
      prepared.push(await this.prepareMarket(input, f, accountId, anchoredTickers, now));
    }

    const result: SyncBrokerAccountResult = {
      dealsInserted: 0,
      ordersInserted: 0,
      ordersUpdated: 0,
      unresolvedDeals: 0,
      unresolvedOrders: 0,
    };
    for (const { dealRows, orderRows } of prepared) {
      result.dealsInserted += await this.writeDeals(input.connectionId, accountId, dealRows);
      const orderCounts = await this.writeOrders(input.connectionId, accountId, orderRows);
      result.ordersInserted += orderCounts.inserted;
      result.ordersUpdated += orderCounts.updated;
      result.unresolvedDeals += dealRows.filter((d) => d.underlyingTicker === null).length;
      result.unresolvedOrders += orderRows.filter((o) => o.underlyingTicker === null).length;
    }

    const positions: PositionCounts = { inserted: 0, updated: 0, deleted: 0 };
    for (const { market, positionPlan } of prepared) {
      const counts = await this.replacePositions(
        input.connectionId,
        accountId,
        market,
        positionPlan,
        now,
      );
      positions.inserted += counts.inserted;
      positions.updated += counts.updated;
      positions.deleted += counts.deleted;
    }
    return { result, positions };
  }

  /**
   * 分段拉取一个市场的成交与订单, 再拉当前持仓 (事务外)。相邻段重叠 1 天 ⇒ 同一行可能出现两次, 写入前
   * 按唯一号去重。复杂度 O(段数) 次串行调用 —— 串行是刻意的: shim 对历史成交 / 历史订单各限 10 次 / 30 s
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
    // 🚨 失败必须抛到 execute —— 吞掉当空数组 = 「确实空仓」, 会清掉该市场全部持仓 (branch 8 vs 9)。
    const positions = await this.port.fetchPositions(market);
    return { market, deals, orders, positions };
  }

  /**
   * 判正股 + 过滤 + 持仓替换计划。除 resolver 的合约归属缓存外不写库。持仓报告重复键在这里抛
   * (`planPositionSync`) ⇒ 数据类失败, 且发生在任何成交 / 订单 / 持仓写入之前。
   */
  private async prepareMarket(
    input: SyncBrokerAccountInput,
    { market, deals, orders, positions }: FetchedMarket,
    accountId: bigint,
    anchoredTickers: ReadonlySet<string>,
    now: Date,
  ): Promise<PreparedMarket> {
    const resolver = createBrokerUnderlyingResolver(
      { prisma: this.prisma, port: this.port },
      { market, now },
    );
    const resolved = await resolver.resolve([
      ...deals.map((d) => d.code),
      ...orders.flatMap((o) => [o.code, ...o.comboLegCodes]),
      ...positions.map((p) => p.code),
    ]);
    const inScope = (underlyingTicker: string | null) =>
      inBrokerScope({
        scope: this.config.brokerSyncScope,
        anchoredTickers,
        underlyingTicker,
        accountId,
      });
    const keep = (underlyingTicker: string | null) =>
      inScope(underlyingTicker) &&
      // 未解析恒保留 (FR-006), 单只标的补齐也不例外 —— 判不出 ≠ 与该标的无关。
      (input.target === '*' || underlyingTicker === null || underlyingTicker === input.target);

    const dealRows = deals
      .map((d) => ({ row: d, underlyingTicker: resolved.get(d.code) ?? null }))
      .filter((d) => keep(d.underlyingTicker));
    const orderRows = orders
      .map((o) => ({ row: o, underlyingTicker: underlyingOfOrder(o, resolved) }))
      .filter((o) => keep(o.underlyingTicker));

    // 持仓**只按范围**过滤, 不按 target (FR-014: 该市场持仓集合 = 报告经范围过滤): 单只标的补齐若按
    // target 滤, 同市场其它标的的持仓会进 toDelete 被清掉。
    const reported: ReportedPosition[] = positions
      .map((row) => ({
        market,
        code: row.code,
        row,
        underlyingTicker: resolved.get(row.code) ?? null,
      }))
      .filter((p) => inScope(p.underlyingTicker));
    const existing: ExistingPosition[] = (
      await this.prisma.brokerPosition.findMany({
        where: { connectionId: input.connectionId, market },
        select: { code: true, firstSeenAt: true },
      })
    ).map((p) => ({ market, code: p.code, firstSeenAt: p.firstSeenAt }));

    return {
      market,
      dealRows,
      orderRows,
      positionPlan: planPositionSync({ existing, reported }),
    };
  }

  /**
   * 一个市场的持仓整体替换 (plan D8): 事务外读库内成交算开仓时间 (纯函数), 再在**一个**事务内删 → 插 →
   * 改。`firstSeenAt` 只在插入时写 (= `now`); 更新不带该列。复杂度 O(D + P log P) —— D = 这些合约的库内
   * 成交 (一次 `IN` 查询后按代码分组), P = 持仓数 (更新按代码排序: 并发事务取行锁顺序一致, 不成环)。
   */
  private async replacePositions(
    connectionId: bigint,
    accountId: bigint,
    market: BrokerMarket,
    { toInsert, toUpdate, toDelete }: PositionSyncPlan<ExistingPosition, ReportedPosition>,
    now: Date,
  ): Promise<PositionCounts> {
    const kept = [...toInsert.map((reported) => ({ reported, firstSeenAt: now })), ...toUpdate];
    if (kept.length === 0 && toDelete.length === 0) return { inserted: 0, updated: 0, deleted: 0 };

    const dealsByCode = new Map<string, Parameters<typeof resolveOpenedAt>[0]['deals'][number][]>();
    if (kept.length > 0) {
      const deals = await this.prisma.brokerDeal.findMany({
        where: { connectionId, market, code: { in: kept.map((k) => k.reported.code) } },
        select: { code: true, dealId: true, tradedAt: true, side: true, qty: true },
      });
      for (const d of deals) {
        const list = dealsByCode.get(d.code) ?? [];
        // 列值只由 writeDeals 写入, 来源是已收窄为 BrokerTradeSide 的 BrokerDealRow.side。
        list.push({
          dealId: d.dealId,
          tradedAt: d.tradedAt,
          side: d.side as BrokerTradeSide,
          qty: d.qty,
        });
        dealsByCode.set(d.code, list);
      }
    }
    const rowOf = ({
      reported,
      firstSeenAt,
    }: {
      reported: ReportedPosition;
      firstSeenAt: Date;
    }) => {
      const { openedAt, source } = resolveOpenedAt({
        deals: dealsByCode.get(reported.code) ?? [],
        positionQty: reported.row.qty,
        firstSeenAt,
      });
      return {
        accountId,
        connectionId,
        market,
        code: reported.code,
        underlyingTicker: reported.underlyingTicker,
        qty: reported.row.qty,
        marketValue: reported.row.marketValue,
        costPrice: reported.row.costPrice,
        averageCost: reported.row.averageCost,
        currentPrice: reported.row.currentPrice,
        currency: reported.row.currency,
        openedAt,
        openedAtSource: source,
        syncedAt: now,
        raw: reported.row.raw as Prisma.InputJsonValue,
      };
    };
    const inserts = toInsert.map((reported) => ({
      ...rowOf({ reported, firstSeenAt: now }),
      firstSeenAt: now,
    }));
    const updates = toUpdate.map(rowOf).sort((a, b) => compare(a.code, b.code));

    await this.prisma.$transaction(async (tx) => {
      if (toDelete.length > 0) {
        await tx.brokerPosition.deleteMany({
          where: { connectionId, market, code: { in: toDelete.map((p) => p.code) } },
        });
      }
      if (inserts.length > 0) {
        await tx.brokerPosition.createMany({ data: inserts, skipDuplicates: true });
      }
      for (const row of updates) {
        await tx.brokerPosition.updateMany({
          where: { connectionId, market, code: row.code },
          data: row,
        });
      }
    });
    return { inserted: inserts.length, updated: updates.length, deleted: toDelete.length };
  }

  /** 回写结局。只改仍在 `running` 的记录: 被卡死回收改写过的记录不覆盖 (也避开对账部分唯一索引冲突)。 */
  private async finish(
    runId: bigint,
    now: Date,
    startedMs: number,
    data:
      | { status: 'succeeded'; written?: number; filled?: number }
      | { status: 'failed'; error: string },
  ): Promise<void> {
    const { count } = await this.prisma.brokerSyncRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { ...data, finishedAt: new Date(now.getTime() + (Date.now() - startedMs)) },
    });
    if (count === 0) {
      this.logger.warn(
        `同步记录 ${runId} 已不在 running (被回收或改写), 本次结局 ${data.status} 未回写`,
      );
    }
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

/** 按码点截断 (PG VarChar 按字符计; 按 UTF-16 单元切会切断代理对)。复杂度 O(n)。 */
function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}
