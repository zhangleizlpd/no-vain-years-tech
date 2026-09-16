import { Inject, Injectable, Logger } from '@nestjs/common';
import { marketdataConfig, type MarketdataConfig } from '../config/marketdata.config';
import { optionsdeskConfig, type OptionsdeskConfig } from '../config/optionsdesk.config';
import { exchangeClock } from '../marketdata/session-clock';
import { PrismaService } from '../security/prisma.service';
import {
  BROKER_ACCOUNT_PORT,
  BrokerInfrastructureError,
  type BrokerAccountPort,
  type BrokerDealRow,
  type BrokerEvent,
  type BrokerEventBatch,
  type BrokerOrderEventRow,
  type BrokerOrderRow,
} from './broker-account.port';
import type { BrokerMarket } from './broker-code.rules';
import { decideCursor, type BrokerEventCursor } from './broker-event-cursor.rules';
import { inBrokerScope } from './broker-scope.rules';
import { createBrokerUnderlyingResolver, underlyingOfOrder } from './resolve-broker-underlying';
import { isTransientDbError } from './transient-db-error.rules';
import {
  SyncBrokerAccountUseCase,
  type BrokerSyncFailureKind,
} from './sync-broker-account.usecase';

/**
 * 持仓刷新的去抖窗口 (FR-008)。
 *
 * 📌 **出处**: 受券商持仓查询限频约束 —— 每账户 10 次 / 30 秒, 且该配额与开盘前对账、缺口补偿
 * **共用** (spec `## Clarifications` Session 2026-09-16 第 4 问)。5 秒 ⇒ 30 秒内最多 6 次, 留约
 * 40% 余量; **3 秒恰好打满上限**, 与对账并发即触发限频 —— 而限频的表现是**持仓静默不刷新、
 * 不报错**, 比慢两秒难排查得多。
 *
 * 🚫 **做成配置项**: 它与 SC-001 / FR-008 的验收口径强耦合, 配置化会让「改一个数就破坏验收
 * 口径」成为可能 (照 `broker-sync-slot.rules.ts` `RECONCILE_SLOT_MINUTES` 的先例, 常量旁注出处)。
 */
export const PUSH_REFRESH_DEBOUNCE_MS = 5_000;

/**
 * 空腿组合单「按订单号回查」的去抖窗口: 同一 (连接 × 市场) 两次回查至少隔这么久 (FR-020)。
 *
 * 📌 **出处**: 回查打的是 `fetchOrders`, 与推送刷新、开盘前对账、缺口补偿**共用**券商那份
 * 查询配额 (每账户 10 次 / 30 秒; spec `## Clarifications` Session 2026-09-16 第 4 问)。
 *
 * 🚨 **刻意比 {@link PUSH_REFRESH_DEBOUNCE_MS} 长得多 —— 它该给刷新让配额**: 持仓刷新扛着
 * SC-001 / FR-008 的时延口径 (2 + 5 = 7 秒), 5 秒窗口下 30 秒内最多 6 次; 而回查**没有任何
 * 时延要求** —— 一张组合单的腿晚半分钟补齐无人可见。两者都取 5 秒的话最坏 6 + 6 = 12 次 /
 * 30 秒, **超过券商那 10 次**; 取 30 秒 ⇒ 回查最多 1 次, 合计最坏 7 次, 留约 30% 余量
 * (与 clarify 第 4 问给刷新留 40% 余量是同一套算法)。
 *
 * 🚨 **没有它会把配额耗光**: 待回查的订单一直待着直到补上 (或进程重启) ⇒ 一张**永远补不上**
 * 的组合单 (券商当日窗口里查不到它) 会让每 2 秒一拍都打一次券商。而限频的表现是**持仓静默
 * 不刷新、不报错** —— 比少补一张腿难排查得多。
 */
export const ORDER_LEGS_RECHECK_DEBOUNCE_MS = 30_000;

/**
 * 一拍最多回查补全多少张组合单 (FR-020); 超出的留到下一拍。
 *
 * 🚨 **与去抖挡的不是同一件事**: 去抖挡「多久打一次券商」, 本上限挡「一拍里回写多少行」——
 * 推送那拍 2 秒一次且带 `waitForCompletion: true`, 一拍必须在下一拍到来前跑完。取 10 与券商
 * 那 10 次 / 30 秒同量级: 人手下单的账户一拍内积压 10 张以上待回查组合单已属异常, 真出现也
 * 只是多花几拍补完, 不丢数据 (待回查集合不因本上限而丢弃任何一张)。
 */
export const ORDER_LEGS_RECHECK_MAX_PER_TICK = 10;

export interface ConsumeBrokerEventsInput {
  connectionId: bigint;
  /** 进程内游标 (plan D4: 🚫 建表持久化); 首拍 / 消费进程重启后传 `null`。 */
  cursor: BrokerEventCursor | null;
  now?: Date;
}

export interface ConsumeBrokerEventsCounts {
  /** 本拍从事件源接受的事件条数 (**锚过滤前**)。 */
  accepted: number;
  dealsInserted: number;
  ordersInserted: number;
  ordersUpdated: number;
}

export type ConsumeBrokerEventsOutcome =
  | ({
      ok: true;
      /** `MARKETDATA_PROVIDER=mock` ⇒ 整拍跳过、零 port 调用 (FR-016)。 */
      skipped: boolean;
      /** 需发起当日缺口补偿 (FR-009); 由调度器消费, 本用例只判不发起。 */
      gapDetected: boolean;
      cursor: BrokerEventCursor | null;
      /** 本拍有写入的市场 (去抖登记面)。 */
      touchedMarkets: readonly BrokerMarket[];
      /** 本拍去抖到期、真的刷了持仓的市场 (FR-008)。 */
      refreshedMarkets: readonly BrokerMarket[];
      /**
       * 本拍按订单号回查、真的补全了腿的组合单张数 (FR-020)。受
       * {@link ORDER_LEGS_RECHECK_MAX_PER_TICK} 与 {@link ORDER_LEGS_RECHECK_DEBOUNCE_MS} 节流。
       */
      legsBackfilled: number;
      /**
       * 事件源报出的最近一次事件到达时刻 (FR-014 订阅健康判据之一, 另一半是缺口补偿留痕)。
       * 事件源从没收到过推送 ⇒ `null`。**与本拍有没有行无关**: 没有新事件的那些拍照样报同一个
       * 值 —— 判「通道是不是哑了」要的正是这个不随响应时刻走的时刻。
       */
      lastEventAt: Date | null;
    } & ConsumeBrokerEventsCounts)
  | {
      ok: false;
      failureKind: BrokerSyncFailureKind;
      error: string;
      /** 🚨 失败时**不前移**: 幂等写让重放无副作用, 前移则这批事件永不回来 (FR-017)。 */
      cursor: BrokerEventCursor | null;
    };

type MarketBucket = { deals: BrokerDealRow[]; orders: BrokerOrderEventRow[] };

const ZERO: ConsumeBrokerEventsCounts = {
  accepted: 0,
  dealsInserted: 0,
  ordersInserted: 0,
  ordersUpdated: 0,
};

/**
 * 084 T006 / T007 / T018 券商推送事件消费 use case
 * (plan D3 / D2; FR-004 ~ FR-008 / FR-016 / FR-017 / FR-020)。
 *
 * 一拍 = 拉事件 (**事务外**) → 游标与断档判定 → 按市场判正股 → 锚过滤 → 幂等写成交与订单 →
 * 按市场登记「待刷新」→ 去抖到期则刷该市场持仓与开仓时间。
 *
 * 🚨 **split-tx**: 经 port 拉事件的 HTTP 在事务外完成, 拿到事件后才开短事务写 —— 🚫 事务内持锁
 * 等 HTTP (`server-impl-playbook.md` § 并发 / 事务)。
 *
 * 🚨 **锚过滤走 `broker-scope.rules.ts` 单点** (FR-005): 🚫 在本文件另写一份判定 —— 两份会在
 * 「excluded 的锚算不算」「未解析保不保留」两处漂移, 而漂移的表现是成交被**静默**丢掉。
 *
 * 🚨 **幂等写与持仓替换都复用 `SyncBrokerAccountUseCase`**: 成交 `createMany({ skipDuplicates })`;
 * 订单先 `createMany({ skipDuplicates })` 再带 `vendorUpdatedAt < incoming` 条件 `updateMany`;
 * 持仓刷新走它的 `mode: 'push'` (持仓替换与开仓时间推算是同一条路径) —— 🚫 先查后写、🚫 另写一份。
 *
 * 🚨 **游标只存进程内存** (plan D4): 由调用方 (调度器) 持有并逐拍回传, 🚫 建表持久化。
 *
 * 🚨 **空腿组合单按订单号回查补全** (FR-020, T018): 腿为空**且**合成码判不出单一合约的订单
 * 先照常写入并留痕, 再按订单号回查当日订单、补上腿码与标的归属。补写**绕开**
 * `vendorUpdatedAt` 守卫 —— 回查拿到的与推送写进去的是同一个订单状态、时间戳相等, 走守卫
 * 就永远补不上 (🚫 也别指望开盘前对账兜底: 它走同一个 `writeOrders`、被同一个守卫挡着)。
 */
@Injectable()
export class ConsumeBrokerEventsUseCase {
  private readonly logger = new Logger(ConsumeBrokerEventsUseCase.name);

  /**
   * 「待刷新」登记: `${connectionId}:${market}` → 本窗口的到期时刻。同样只存进程内存 ——
   * 进程重启后最坏是少刷一次, 下一条事件即重新登记, 🚫 为它建表。
   */
  private readonly pendingRefresh = new Map<string, Date>();

  /**
   * 「待回查腿」登记: `${connectionId}:${market}` → 待补全的订单号集合 (FR-020)。
   *
   * 同样只存进程内存 (同 {@link pendingRefresh} 与游标)。🚫 为它建表 —— 进程重启后本地游标为
   * `null`, 首拍从缓冲最旧一条重放, 同一张组合单会**再次**以 `legsPending` 到达并重新登记;
   * 建表只是多一张表和一处一致性要维护。
   */
  private readonly pendingLegs = new Map<string, Set<string>>();

  /** 同键下次允许回查的时刻 (去抖, {@link ORDER_LEGS_RECHECK_DEBOUNCE_MS})。 */
  private readonly legsRecheckAt = new Map<string, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncBrokerAccountUseCase,
    @Inject(BROKER_ACCOUNT_PORT) private readonly port: BrokerAccountPort,
    @Inject(marketdataConfig.KEY) private readonly marketdata: MarketdataConfig,
    @Inject(optionsdeskConfig.KEY) private readonly config: OptionsdeskConfig,
  ) {}

  async execute(input: ConsumeBrokerEventsInput): Promise<ConsumeBrokerEventsOutcome> {
    const now = input.now ?? new Date();
    const startedMs = Date.now();
    // mock 档整拍跳过, 零 port 调用 (FR-016; 模块层拒绝壳是兜底, 不是第一道)。
    if (this.marketdata.kind === 'mock') {
      return {
        ok: true,
        skipped: true,
        gapDetected: false,
        cursor: input.cursor,
        touchedMarkets: [],
        refreshedMarkets: [],
        // mock 档整拍没打过事件源 ⇒ 无从知道它最近何时收到推送, 🚫 拿 `now` 冒充。
        lastEventAt: null,
        legsBackfilled: 0,
        ...ZERO,
      };
    }

    let batch: BrokerEventBatch;
    try {
      batch = await this.port.fetchEvents(
        input.cursor === null
          ? null
          : { epoch: input.cursor.epoch, afterSeq: input.cursor.lastSeq },
      );
    } catch (err) {
      return this.failed(err, input, '事件拉取');
    }

    const { accepted, gapDetected, nextCursor } = decideCursor({
      local: input.cursor,
      response: batch,
    });

    let written: ConsumeBrokerEventsCounts & { touchedMarkets: BrokerMarket[] };
    try {
      written = await this.write(input.connectionId, accepted, now);
    } catch (err) {
      // 🚨 游标不前移: 本批事件下一拍照常重放, 幂等写保证结果一致 (FR-017)。
      return this.failed(err, input, '事件写入');
    }

    this.registerRefresh(input.connectionId, written.touchedMarkets, now);
    // 🚨 **无论本拍有没有事件都要过一遍**: 待回查的单是之前某一拍登记的, 且回查失败要靠之后的
    // 拍重试 —— 只在「本拍有新的 pending」时才回查, 失败那张就再也没有人来补 (FR-020)。
    const legsBackfilled = await this.flushPendingLegs(input.connectionId, now);
    // 🚨 **无论本拍有没有事件都要过一遍**: 去抖窗口是上一拍开的, 到期那一拍往往正好没有新事件。
    const refreshedMarkets = await this.flushDueRefreshes(input.connectionId, now);

    if (gapDetected) {
      // FR-009 / FR-014: 补偿留痕是判断推送通道是否健在的依据之一 ⇒ 告警级。
      this.logger.warn(
        `推送事件断档 connection=${input.connectionId} epoch=${batch.epoch} dropped=${batch.dropped}, 需当日缺口补偿`,
      );
    }
    // 🚫 日志任何一行不带 accountId / 券商账户号 / 成交号 / 订单号 (FR-019, SC-008): 只用连接行 ID 与条数定位。
    // `lastEventAt` 是 FR-014 的订阅健康判据 —— 它进这一行, 排障时才不必另开一条查询路径。
    this.logger.log(
      `推送事件消费 connection=${input.connectionId} accepted=${accepted.length}` +
        ` deals+${written.dealsInserted} orders+${written.ordersInserted} orders~${written.ordersUpdated}` +
        ` refreshed=${refreshedMarkets.join(',')} gap=${gapDetected}` +
        ` lastEventAt=${batch.lastEventAt?.toISOString() ?? 'none'} elapsedMs=${Date.now() - startedMs}`,
    );
    return {
      ok: true,
      skipped: false,
      gapDetected,
      cursor: nextCursor,
      refreshedMarkets,
      lastEventAt: batch.lastEventAt,
      legsBackfilled,
      ...written,
    };
  }

  /**
   * 判正股 → 锚过滤 → 幂等写。按市场分桶后每个市场一个 resolver (它按市场缓存词根映射)。
   *
   * 复杂度 O(E) 分桶 + 每市场 1 次 resolver 批量判定 + 2 组幂等写; E = 本批事件数。
   */
  private async write(
    connectionId: bigint,
    events: readonly BrokerEvent[],
    now: Date,
  ): Promise<ConsumeBrokerEventsCounts & { touchedMarkets: BrokerMarket[] }> {
    const counts = { ...ZERO, accepted: events.length, touchedMarkets: [] as BrokerMarket[] };
    if (events.length === 0) return counts;

    const accountId = await this.accountIdOf(connectionId);
    // 锚表**全部**行, 含 excluded (082 plan D6 / U8: 不参与交易 ≠ 不看它的成交)。
    const anchors = await this.prisma.anchor.findMany({ select: { ticker: true } });
    const anchoredTickers = new Set(anchors.map((a) => a.ticker));

    for (const [market, bucket] of bucketByMarket(events)) {
      const resolver = createBrokerUnderlyingResolver(
        { prisma: this.prisma, port: this.port },
        { market, now },
      );
      const resolved = await resolver.resolve([
        ...bucket.deals.map((d) => d.code),
        ...bucket.orders.flatMap((o) => [o.code, ...o.comboLegCodes]),
      ]);
      const keep = (underlyingTicker: string | null) =>
        inBrokerScope({
          scope: this.config.brokerSyncScope,
          anchoredTickers,
          underlyingTicker,
          accountId,
        });

      const dealRows = bucket.deals
        .map((row) => ({ row, underlyingTicker: resolved.get(row.code) ?? null }))
        .filter((d) => keep(d.underlyingTicker));
      const orderRows = bucket.orders
        .map((row) => ({ row, underlyingTicker: underlyingOfOrder(row, resolved) }))
        .filter((o) => keep(o.underlyingTicker));

      const pending = orderRows.filter((o) => o.row.legsPending).map((o) => o.row.orderId);
      if (pending.length > 0) {
        // FR-020 留痕半: 腿为空且合成码不可解析 ⇒ 该组合单的标的归属缺失, MUST NOT 静默写入了事。
        // 🚫 日志带订单号 (见上面那条日志的同一理由)。
        this.logger.warn(
          `推送订单 ${pending.length} 张腿列表为空且合成码不可解析 connection=${connectionId} market=${market}, 已登记按订单号回查补全`,
        );
        // 回查补全半 (T018): 登记下来, 由 `flushPendingLegs` 按去抖与单拍上限逐拍消化。
        const key = refreshKey(connectionId, market);
        const set = this.pendingLegs.get(key) ?? new Set<string>();
        for (const orderId of pending) set.add(orderId);
        this.pendingLegs.set(key, set);
      }

      counts.dealsInserted += await this.sync.writeDeals(connectionId, accountId, dealRows);
      const orderCounts = await this.sync.writeOrders(connectionId, accountId, orderRows);
      counts.ordersInserted += orderCounts.inserted;
      counts.ordersUpdated += orderCounts.updated;
      if (dealRows.length > 0 || orderRows.length > 0) counts.touchedMarkets.push(market);
    }
    return counts;
  }

  /**
   * 登记「待刷新」。复杂度 O(市场数)。
   *
   * 🚨 **已在窗口内的不延长到期时刻** —— 合并, 不是「每来一条就往后推」: 重置式去抖在连续成交
   * 流下会让刷新**永远不发生**, 而 FR-008 的上界是拉取 2 秒 + 去抖 5 秒 = 7 秒。
   */
  private registerRefresh(connectionId: bigint, markets: readonly BrokerMarket[], now: Date): void {
    for (const market of markets) {
      const key = refreshKey(connectionId, market);
      if (!this.pendingRefresh.has(key)) {
        this.pendingRefresh.set(key, new Date(now.getTime() + PUSH_REFRESH_DEBOUNCE_MS));
      }
    }
  }

  /**
   * 按订单号回查补全空腿的组合单 (FR-020, T018); 返回本拍真的补上的张数。
   *
   * 一个市场**一次** `fetchOrders`, 🚫 每条 pending 行各发一次 —— 回查与推送刷新、开盘前对账、
   * 缺口补偿共用券商那 10 次 / 30 秒的查询配额, 逐条打会让回查量与**订单量同阶**, 当场打满。
   * 节流两道见 {@link ORDER_LEGS_RECHECK_DEBOUNCE_MS} 与 {@link ORDER_LEGS_RECHECK_MAX_PER_TICK}。
   *
   * 一个市场失败不连坐另一个; 失败的订单号**留在登记里**, 下一个到期的拍重试。
   * 复杂度 O(登记数) 扫描 + 每个到期市场 1 次券商查询 + 至多单拍上限条定向 UPDATE。
   */
  private async flushPendingLegs(connectionId: bigint, now: Date): Promise<number> {
    let backfilled = 0;
    for (const [key, orderIds] of this.pendingLegs) {
      const market = marketOfKey(key, connectionId);
      if (market === null || orderIds.size === 0) continue;
      const dueAt = this.legsRecheckAt.get(key);
      if (dueAt !== undefined && dueAt.getTime() > now.getTime()) continue;
      // 先开下一个去抖窗口: 成功与否都不该让下一拍 (2 秒后) 立刻再打一次券商。
      this.legsRecheckAt.set(key, new Date(now.getTime() + ORDER_LEGS_RECHECK_DEBOUNCE_MS));
      try {
        backfilled += await this.recheckLegs(connectionId, market, orderIds, now);
      } catch (e) {
        // 🚫 日志带订单号 / 账户号 (FR-019)。既有行一行不动, 登记原样留着等下一拍。
        this.logger.error(
          `推送订单腿回查失败 connection=${connectionId} market=${market} 待补 ${orderIds.size} 张: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return backfilled;
  }

  /**
   * 一个市场的一次回查: 拉当日订单 → 按订单号取腿 → 判正股 → 定向补写两列。
   *
   * 🚨 **补写 MUST NOT 带 `vendorUpdatedAt < incoming` 条件**: 回查拿到的与推送写进去的是同一
   * 个订单状态、时间戳**相等**, 带上守卫就永远改不动 (FR-020 / Guardrail)。作为交换, 这里
   * **只写腿与归属两列** —— 其余列的新旧仍归 `writeOrders` 那条守卫管, 不从这条路径绕过去。
   *
   * 复杂度 O(当日订单数 + 单拍上限)。
   */
  private async recheckLegs(
    connectionId: bigint,
    market: BrokerMarket,
    orderIds: Set<string>,
    now: Date,
  ): Promise<number> {
    // 🚨 单拍上限只**推迟**、不放弃: 没轮到的留在登记里下一拍再补, 丢弃会让它的归属永久缺失。
    const wanted = [...orderIds].sort().slice(0, ORDER_LEGS_RECHECK_MAX_PER_TICK);
    const today = exchangeClock(market, now).date;
    const orders = await this.port.fetchOrders(market, { start: today, end: today });

    const byOrderId = new Map<string, BrokerOrderRow>();
    // 腿仍为空的回查结果不算命中: 记下「补过了」会让这张单再也不被重试。
    for (const order of orders) {
      if (order.comboLegCodes.length > 0) byOrderId.set(order.orderId, order);
    }
    const hits = wanted
      .map((orderId) => byOrderId.get(orderId))
      .filter((order): order is BrokerOrderRow => order !== undefined);
    if (hits.length === 0) return 0;

    const resolver = createBrokerUnderlyingResolver(
      { prisma: this.prisma, port: this.port },
      { market, now },
    );
    const resolved = await resolver.resolve(hits.flatMap((order) => order.comboLegCodes));

    let backfilled = 0;
    for (const order of hits) {
      const { count } = await this.prisma.brokerOrder.updateMany({
        // 🚨 条件里**没有** `vendorUpdatedAt` —— 见方法注释。
        where: { connectionId, orderId: order.orderId },
        data: {
          comboLegCodes: order.comboLegCodes,
          underlyingTicker: underlyingOfOrder(order, resolved),
        },
      });
      if (count > 0) backfilled++;
      orderIds.delete(order.orderId);
    }
    return backfilled;
  }

  /**
   * 刷新本连接所有已到期的市场, 返回真的刷成功的市场。一个市场失败不连坐另一个。
   * 复杂度 O(登记数) 扫描 + 每个到期市场一次持仓刷新。
   */
  private async flushDueRefreshes(connectionId: bigint, now: Date): Promise<BrokerMarket[]> {
    const due: BrokerMarket[] = [];
    for (const [key, dueAt] of this.pendingRefresh) {
      const market = marketOfKey(key, connectionId);
      if (market !== null && dueAt.getTime() <= now.getTime()) due.push(market);
    }

    const refreshed: BrokerMarket[] = [];
    for (const market of due) {
      // 先摘登记再刷: 刷新途中到达的事件重新开一个新窗口, 不会被本次「顺带」吞掉。
      this.pendingRefresh.delete(refreshKey(connectionId, market));
      try {
        if (await this.refreshPositions(connectionId, market, now)) refreshed.push(market);
      } catch (e) {
        this.logger.error(
          `推送刷新持仓失败 connection=${connectionId} market=${market}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return refreshed;
  }

  /**
   * 刷一个市场的持仓与开仓时间, 并留下一条 `kind='push'` 的同步记录 (FR-012 / FR-018)。
   *
   * 记录**先建成 `running` 再交给 use case 回写结局** —— 这是 082 T015 定的同步记录契约。
   * `window` 对 `push` 不参与拉取 (成交 / 订单已由推送写入, `fetchMarket` 对该 mode 整段跳过),
   * 这里给交易所当地今天, 只为记录可读。
   */
  private async refreshPositions(
    connectionId: bigint,
    market: BrokerMarket,
    now: Date,
  ): Promise<boolean> {
    const accountId = await this.accountIdOf(connectionId);
    const today = exchangeClock(market, now).date;
    const { id: runId } = await this.prisma.brokerSyncRun.create({
      data: {
        accountId,
        connectionId,
        kind: 'push',
        status: 'running',
        market,
        target: '*',
        startedAt: now,
      },
      select: { id: true },
    });
    const outcome = await this.sync.execute({
      connectionId,
      markets: [market],
      target: '*',
      window: { start: today, end: today },
      mode: 'push',
      runId,
      now,
    });
    return outcome.ok;
  }

  private async accountIdOf(connectionId: bigint): Promise<bigint> {
    const { accountId } = await this.prisma.brokerConnection.findUniqueOrThrow({
      where: { id: connectionId },
      select: { accountId: true },
    });
    return accountId;
  }

  /**
   * 失败结局。判别口径沿用 082: `instanceof BrokerInfrastructureError` 或可重试 DB 异常 =
   * 基础设施 (下一拍重试); 其余 (含 adapter 的坏行 / 契约变更 throw) = 数据类。
   */
  private failed(
    err: unknown,
    input: ConsumeBrokerEventsInput,
    what: string,
  ): ConsumeBrokerEventsOutcome {
    const failureKind: BrokerSyncFailureKind =
      err instanceof BrokerInfrastructureError || isTransientDbError(err)
        ? 'infrastructure'
        : 'data';
    const error = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `推送${what}失败 connection=${input.connectionId} failure=${failureKind}: ${error}`,
    );
    return { ok: false, failureKind, error, cursor: input.cursor };
  }
}

function refreshKey(connectionId: bigint, market: BrokerMarket): string {
  return `${connectionId}:${market}`;
}

/** 登记键 → 本连接的市场; 不属本连接 ⇒ `null`。 */
function marketOfKey(key: string, connectionId: bigint): BrokerMarket | null {
  const prefix = `${connectionId}:`;
  if (!key.startsWith(prefix)) return null;
  return key.slice(prefix.length) as BrokerMarket;
}

/** 事件按市场分桶, 顺序保留 (订单守卫靠 `vendorUpdatedAt` 判新旧, 不靠顺序)。复杂度 O(E)。 */
function bucketByMarket(events: readonly BrokerEvent[]): Map<BrokerMarket, MarketBucket> {
  const byMarket = new Map<BrokerMarket, MarketBucket>();
  for (const event of events) {
    const market = event.kind === 'deal' ? event.deal.market : event.order.market;
    const bucket = byMarket.get(market) ?? { deals: [], orders: [] };
    if (event.kind === 'deal') bucket.deals.push(event.deal);
    else bucket.orders.push(event.order);
    byMarket.set(market, bucket);
  }
  return byMarket;
}
