import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { marketdataConfig, type MarketdataConfig } from '../config/marketdata.config';
import { exchangeCalendarDate, exchangeClock } from '../marketdata/session-clock';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';
import { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';
import type { BrokerTradeWindow } from './broker-account.port';
import type { BrokerMarket } from './broker-code.rules';
import type { BrokerEventCursor } from './broker-event-cursor.rules';
import {
  decideBackfillAfterInfraFailure,
  decideGapfill,
  decideReconcile,
  type GapfillInput,
  type ReconcileInput,
} from './broker-sync-slot.rules';
import { ConsumeBrokerEventsUseCase } from './consume-broker-events.usecase';
import { SyncBrokerAccountUseCase } from './sync-broker-account.usecase';

/** 心跳 cron job 名 (`SchedulerRegistry.getCronJob` 的键)。 */
export const BROKER_ACCOUNT_HEARTBEAT = 'broker-account-heartbeat';

/** 推送事件心跳 cron job 名 (084 T008; 同上, `SchedulerRegistry` 的键)。 */
export const BROKER_EVENT_HEARTBEAT = 'broker-event-heartbeat';

/**
 * 推送事件的拉取间隔 (秒)。
 *
 * 📌 **出处**: SC-001 要求订单状态变化 ≤ 5 秒进库, 而「进库」的上界就是本间隔 —— 事件在
 * 下一拍被拉走并写入, 2 秒把余下约 3 秒留给 shim 缓冲与写库。持仓刷新的上界在此之上再加
 * 去抖窗口 (`PUSH_REFRESH_DEBOUNCE_MS` 5 秒, FR-008 ⇒ 2 + 5 = 7 秒)。
 *
 * 🚫 **做成配置项**: 它与 SC-001 / FR-004 的验收口径强耦合, 配置化会让「改一个数就破坏验收
 * 口径」成为可能 (照 `broker-sync-slot.rules.ts` `RECONCILE_SLOT_MINUTES` 的先例, 常量旁注出处)。
 */
export const PUSH_EVENT_POLL_SECONDS = 2;

/** `running` 超过这么久仍未结束 = 执行中进程重启 / 崩溃留下的卡死记录 (plan D9 步骤 1)。 */
const STUCK_RUNNING_MS = 15 * 60 * 1000;

/** 卡死回收的对账记录 `error`: 计入当日失败次数, 由对账判定按重试规则重新发起。 */
export const RUN_INTERRUPTED_ERROR = '执行中断';

/** 补齐基础设施故障距首次尝试满 24 小时后的 `error` (停止重试, 由维护者重新触发)。 */
export const BACKFILL_RETRY_EXHAUSTED_ERROR = '基础设施重试耗尽';

/** `target = '*'` 覆盖的全部市场 (clarify Q3), 也是对账编排逐个判定的市场。 */
const ALL_MARKETS: readonly BrokerMarket[] = ['us', 'hk'];

/** 一拍的处置结果 (IT 断言点 + 排障出口)。 */
export type BrokerAccountHeartbeatOutcome =
  | { status: 'skipped-mock' }
  | { status: 'failed'; reason: string }
  | { status: 'ticked'; connections: number; failedConnections: number };

type Connection = { id: bigint; accountId: bigint };

type DueBackfill = {
  id: bigint;
  target: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  firstAttemptedAt: Date | null;
};

/**
 * 082 —— `SyncBrokerAccountUseCase` 的**触发器** (plan D9; FR-009 / FR-010 / FR-011 / FR-017 / FR-018)。
 * 每分钟一拍, 对每个连接依次: ① 回收卡死记录 → ② 认领并执行到期的补齐记录 → ③ 开盘前对账编排。
 *
 * 🚨 **防重入两层**: 第一层 `waitForCompletion: true` —— cron 4.4.0 默认不等上一拍的 Promise
 * (`cron/dist/job.js:121-133`), 一次全量补齐约 74 s > 心跳 60 s, 漏了就两拍并发 (plan D9);
 * 仓内其它 `@Cron` 都没带这个选项, 别照抄它们。第二层在数据库: 补齐认领是条件 UPDATE +
 * affected-count, 对账插入撞部分唯一索引即跳过 —— 进程内选项挡不住并发直调与未来多实例。
 * 单实例部署, 不加分布式锁 (同 `sync-anchor-intraday.scheduler.ts` 先例)。
 *
 * mock 档起手即 `skipped-mock`, 零 port 调用 (FR-018; 模块层拒绝壳是兜底)。
 *
 * 084 T008 —— 本类还带**第二拍**: 每 `PUSH_EVENT_POLL_SECONDS` 秒的推送事件心跳
 * (`runEvents`), 与上面那拍互不相干 (各自 `@Cron`、各自 `waitForCompletion`、各自的
 * 连接循环), 合在一个类里只是因为两者的触发对象都是「每个券商连接」。
 */
@Injectable()
export class BrokerAccountScheduler {
  private readonly logger = new Logger(BrokerAccountScheduler.name);

  /**
   * 推送事件游标: `connectionId` → 上一拍算出的游标 (plan D4 —— **只存进程内存**, 🚫 建表
   * 持久化)。重启后按 `null` 起手, 由 `decideCursor` 的代次 (`epoch`) 比对天然覆盖重启场景:
   * 事件源也重启过 ⇒ 代次变了 ⇒ 判断档并从新代次重建; 没变 ⇒ 照旧序号续拉。
   */
  private readonly eventCursors = new Map<string, BrokerEventCursor | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncBrokerAccount: SyncBrokerAccountUseCase,
    private readonly consumeBrokerEvents: ConsumeBrokerEventsUseCase,
    @Inject(marketdataConfig.KEY) private readonly marketdata: MarketdataConfig,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口 —— 开盘前对账「本交易日」的
    // 三态判定 (non-trading 跳过 / unknown 照跑)。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  @Cron('0 * * * * *', {
    name: BROKER_ACCOUNT_HEARTBEAT,
    timeZone: 'Asia/Shanghai',
    waitForCompletion: true,
  })
  async handleCron(): Promise<void> {
    await this.run();
  }

  /**
   * 一拍。IT 直调本方法 (固定 `now`)。**任何路径都不上抛** (scheduler 抛 = 进程级 unhandledRejection)。
   * 连接间互不连坐: 一个连接抛错只记 error 并计入 `failedConnections`, 其余连接照常执行。
   */
  async run(now: Date = new Date()): Promise<BrokerAccountHeartbeatOutcome> {
    if (this.marketdata.kind === 'mock') return { status: 'skipped-mock' };

    try {
      const connections: Connection[] = await this.prisma.brokerConnection.findMany({
        select: { id: true, accountId: true },
        orderBy: { id: 'asc' },
      });
      let failedConnections = 0;
      for (const connection of connections) {
        try {
          await this.reclaimStuckRuns(connection.id, now);
          await this.runDueBackfills(connection.id, now);
          await this.reconcile(connection, now);
        } catch (e) {
          failedConnections++;
          this.logger.error(`券商心跳: 连接 ${connection.id} 本拍失败: ${errorMessage(e)}`);
        }
      }
      return { status: 'ticked', connections: connections.length, failedConnections };
    } catch (e) {
      const reason = errorMessage(e);
      this.logger.error(`券商心跳失败: ${reason}`);
      return { status: 'failed', reason };
    }
  }

  /**
   * 084 T008 推送事件心跳 (FR-004 / FR-016; plan D3)。
   *
   * 🚨 **`waitForCompletion: true` 与上面那拍同理, 但后果不同**: cron 4.4.0 默认不等上一拍的
   * Promise, 漏了 ⇒ 上一拍还在写库时下一拍已带**同一个游标**再拉一次, 两拍消费同一批事件
   * (幂等写让它不脏数据, 但会白打两倍的 port 调用与库写)。2 秒一拍比 60 秒一拍更容易撞上。
   */
  @Cron(`*/${PUSH_EVENT_POLL_SECONDS} * * * * *`, {
    name: BROKER_EVENT_HEARTBEAT,
    timeZone: 'Asia/Shanghai',
    waitForCompletion: true,
  })
  async handleEventCron(): Promise<void> {
    await this.runEvents();
  }

  /**
   * 推送事件一拍。IT 直调本方法 (固定 `now`)。结果三态复用 `BrokerAccountHeartbeatOutcome`
   * (同样的 skipped-mock / failed / ticked 三分)。
   *
   * **任何路径都不上抛**, 连接间互不连坐 —— 同 `run()` 的理由 (scheduler 抛 = 进程级
   * unhandledRejection)。`failedConnections` 把「抛出来的」与「use case 回传 `ok:false` 的」
   * 一并计入: 后者同样是这一拍没消费成功, 不计入会让排障看到一拍全绿而库里没数。
   *
   * mock 档起手即返回, 零 port 调用 (FR-016; use case 里那道是第二层, 这里省掉连接查询)。
   */
  async runEvents(now: Date = new Date()): Promise<BrokerAccountHeartbeatOutcome> {
    if (this.marketdata.kind === 'mock') return { status: 'skipped-mock' };

    try {
      const connections: Connection[] = await this.prisma.brokerConnection.findMany({
        select: { id: true, accountId: true },
        orderBy: { id: 'asc' },
      });
      let failedConnections = 0;
      for (const connection of connections) {
        const key = connection.id.toString();
        try {
          const outcome = await this.consumeBrokerEvents.execute({
            connectionId: connection.id,
            cursor: this.eventCursors.get(key) ?? null,
            now,
          });
          // 🚨 失败分支回传的是**未前移**的游标 (FR-017): 照样存回, 下一拍原样重放这批。
          this.eventCursors.set(key, outcome.cursor);
          if (!outcome.ok) failedConnections++;
          // 084 T010: 断档即发起当日缺口补偿。失败分支不带 `gapDetected` (这一拍压根没判出
          // 结果) ⇒ 按「本拍没有新断档」处理; 已留痕的失败补偿仍由下面的重试规则重新发起。
          await this.runGapfills(connection, outcome.ok && outcome.gapDetected, now);
        } catch (e) {
          failedConnections++;
          this.logger.error(`推送事件心跳: 连接 ${connection.id} 本拍失败: ${errorMessage(e)}`);
        }
      }
      return { status: 'ticked', connections: connections.length, failedConnections };
    } catch (e) {
      const reason = errorMessage(e);
      this.logger.error(`推送事件心跳失败: ${reason}`);
      return { status: 'failed', reason };
    }
  }

  /**
   * 084 T010 缺口补偿 (FR-009 / FR-010 / FR-018 / FR-022; plan D5)。
   *
   * 🚨 **断档是批级布尔、不含市场** —— 事件源那头是一个进程级环形缓冲 + 一个全局 `seq`
   * 计数器 (`services/futu-shim/src/futu_shim/trade_events.py`), 丢掉的那段序号里可能是任何
   * 市场的事件 ⇒ 无从判断「断的是哪个市场」, 只能对该连接 scope 内**每个市场各补一次**。
   * 🚫 只补某一个市场: 猜错的那次, 缺失的成交永远不会出现, 且不报错。
   *
   * 市场间各自 try/catch, 一个市场出错不影响另一个 (同 {@link reconcile})。
   */
  private async runGapfills(
    connection: Connection,
    gapDetected: boolean,
    now: Date,
  ): Promise<void> {
    for (const market of ALL_MARKETS) {
      try {
        await this.gapfillMarket(connection, market, gapDetected, now);
      } catch (e) {
        this.logger.error(
          `缺口补偿: 连接 ${connection.id} 市场 ${market} 本拍失败: ${errorMessage(e)}`,
        );
      }
    }
  }

  /**
   * 一个连接 × 一个市场的当日缺口补偿: 对该市场**当日**做一次窗口受限的对账, 走
   * `SyncBrokerAccountUseCase` 的第四个 mode —— 🚫 另写一份, 否则「过滤口径 / 幂等写 /
   * 持仓刷新」三处各自漂移 (plan D5, 同 082 D1 的理由)。结局由 use case 回写。
   *
   * 🚨 插 `running` 记录用 `create` 并捕获 `P2002` (部分唯一索引在 Prisma 客户端里被当成全表
   * 唯一), 🚫 `upsert` —— 同日可以有多条已完成的补偿, upsert 会把它们改写掉。
   *
   * ⚠️ **每拍都查一次当日补偿记录, 哪怕本拍没断档**: 失败后的重试不能指望「又断了一次」——
   * 卡死回收把补偿置 `failed` 之后根本不会再有断档 (FR-011)。查询按
   * `(connection_id, market, trading_date)` 收窄到当日几行, 2 秒一拍的代价可以忽略。
   */
  private async gapfillMarket(
    connection: Connection,
    market: BrokerMarket,
    gapDetected: boolean,
    now: Date,
  ): Promise<void> {
    const today = exchangeClock(market, now).date;
    const tradingDate = dateColumn(today);
    const todays = await this.prisma.brokerSyncRun.findMany({
      where: {
        connectionId: connection.id,
        kind: 'gapfill',
        market,
        tradingDate,
        status: { in: ['succeeded', 'failed'] },
      },
      select: { status: true, finishedAt: true },
    });
    const decision = decideGapfill({
      gapDetected,
      todaysRuns: tallyGapfillRuns(todays),
      now,
    });
    if (decision.action === 'skip') return;

    let runId: bigint;
    try {
      ({ id: runId } = await this.prisma.brokerSyncRun.create({
        data: {
          accountId: connection.accountId,
          connectionId: connection.id,
          kind: 'gapfill',
          status: 'running',
          market,
          target: '*',
          tradingDate,
          windowStart: tradingDate,
          windowEnd: tradingDate,
          startedAt: now,
        },
        select: { id: true },
      }));
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      this.logger.log(
        `缺口补偿 ${market} ${today} 连接 ${connection.id} 已有执行中的补偿, 本拍跳过`,
      );
      return;
    }

    await this.syncBrokerAccount.execute({
      connectionId: connection.id,
      markets: [market],
      target: '*',
      window: { start: today, end: today },
      mode: 'gapfill',
      runId,
      now,
    });
  }

  /** 步骤 ①: 卡死的补齐记录置回 `pending` (本拍步骤 ② 即可再认领); 卡死的对账记录置 `failed`。 */
  private async reclaimStuckRuns(connectionId: bigint, now: Date): Promise<void> {
    const stuck = {
      connectionId,
      status: 'running',
      startedAt: { lt: new Date(now.getTime() - STUCK_RUNNING_MS) },
    };
    const backfills = await this.prisma.brokerSyncRun.updateMany({
      where: { ...stuck, kind: 'backfill' },
      data: { status: 'pending' },
    });
    const reconciles = await this.prisma.brokerSyncRun.updateMany({
      where: { ...stuck, kind: 'reconcile' },
      data: { status: 'failed', error: RUN_INTERRUPTED_ERROR, finishedAt: now },
    });
    if (backfills.count + reconciles.count > 0) {
      this.logger.warn(
        `连接 ${connectionId} 回收卡死记录: 补齐 ${backfills.count} 条置回 pending, 对账 ${reconciles.count} 条置 failed`,
      );
    }
  }

  /**
   * 步骤 ②: 逐条认领 `pending ∧ nextAttemptAt ≤ now` 的补齐记录并执行。认领 = 条件 UPDATE
   * (`where {id, status:'pending'}`), `count === 1` 才执行 —— 并发的另一拍读到同一条也认领不到
   * (READ COMMITTED 下 UPDATE 在行锁释放后重判 WHERE)。🚫 `FOR UPDATE` / Serializable (Guardrail 7)。
   */
  private async runDueBackfills(connectionId: bigint, now: Date): Promise<void> {
    const due: DueBackfill[] = await this.prisma.brokerSyncRun.findMany({
      where: { connectionId, kind: 'backfill', status: 'pending', nextAttemptAt: { lte: now } },
      select: {
        id: true,
        target: true,
        windowStart: true,
        windowEnd: true,
        firstAttemptedAt: true,
      },
      orderBy: { id: 'asc' },
    });
    for (const run of due) {
      const { count } = await this.prisma.brokerSyncRun.updateMany({
        where: { id: run.id, status: 'pending' },
        // 清掉上一次失败的 error / finishedAt: 否则成功结局的记录上还挂着旧失败原因。
        data: { status: 'running', startedAt: now, finishedAt: null, error: null },
      });
      if (count !== 1) continue;
      await this.executeBackfill(connectionId, run, now);
    }
  }

  /** 执行一条已认领的补齐, 并按结局处置重试 (成功与数据失败的终态由 use case 回写)。 */
  private async executeBackfill(connectionId: bigint, run: DueBackfill, now: Date): Promise<void> {
    const markets = marketsOfTarget(run.target);
    if (markets === null) {
      await this.prisma.brokerSyncRun.updateMany({
        where: { id: run.id, status: 'running' },
        data: { status: 'failed', error: `补齐目标无法识别市场: ${run.target}`, finishedAt: now },
      });
      this.logger.error(`补齐记录 ${run.id} 目标无法识别市场, 置 failed: ${run.target}`);
      return;
    }

    const outcome = await this.syncBrokerAccount.execute({
      connectionId,
      markets,
      target: run.target,
      window: windowOf(run),
      mode: 'backfill',
      runId: run.id,
      now,
    });
    // 数据失败 (含 BrokerAccountSelectionError) 保持 use case 写下的 failed: 不重试, 不再被认领。
    if (outcome.ok || outcome.failureKind === 'data') return;

    const firstAttemptedAt = run.firstAttemptedAt ?? now;
    const decision = decideBackfillAfterInfraFailure({ firstAttemptedAt, now });
    if (decision.status === 'pending') {
      await this.prisma.brokerSyncRun.updateMany({
        where: { id: run.id, status: 'failed' },
        data: {
          status: 'pending',
          nextAttemptAt: decision.nextAttemptAt,
          attempt: { increment: 1 },
          firstAttemptedAt,
        },
      });
      this.logger.warn(
        `补齐记录 ${run.id} 基础设施失败, ${decision.nextAttemptAt.toISOString()} 重试: ${outcome.error}`,
      );
      return;
    }
    await this.prisma.brokerSyncRun.updateMany({
      where: { id: run.id, status: 'failed' },
      data: { error: BACKFILL_RETRY_EXHAUSTED_ERROR },
    });
    this.logger.error(
      `补齐记录 ${run.id} ${BACKFILL_RETRY_EXHAUSTED_ERROR} (首次尝试 ${firstAttemptedAt.toISOString()}), ` +
        `需维护者重新触发; 最后一次失败: ${outcome.error}`,
    );
  }

  /** 步骤 ③: 开盘前对账编排。连接 × 市场各自 try/catch, 一个市场出错不影响另一个 (P5)。 */
  private async reconcile(connection: Connection, now: Date): Promise<void> {
    for (const market of ALL_MARKETS) {
      try {
        await this.reconcileMarket(connection, market, now);
      } catch (e) {
        this.logger.error(
          `对账编排: 连接 ${connection.id} 市场 ${market} 本拍失败: ${errorMessage(e)}`,
        );
      }
    }
  }

  /**
   * 一个连接 × 一个市场的对账判定与发起 (plan D9 步骤 3 / 4)。到点**只**看交易所当地
   * `minutesOfDay` ⇒ 夏令时零特殊代码; 「本交易日」= 交易所当地日期 + 日历三态。
   *
   * 结局由 use case 回写; 失败重试由之后各拍的判定 (当日失败数 + 最近失败时刻) 负责, 这里不改状态。
   * 🚨 插 `running` 记录用 `create` 并捕获 `P2002` —— 部分唯一索引在 Prisma 客户端里被当成全表唯一,
   * 🚫 `upsert` (失败记录同日可多条, upsert 会把它们改写掉)。
   */
  private async reconcileMarket(
    connection: Connection,
    market: BrokerMarket,
    now: Date,
  ): Promise<void> {
    const clock = exchangeClock(market, now);
    const dayStatus = await this.calendar.classify(market, exchangeCalendarDate(market, now));
    const tradingDate = dateColumn(clock.date);
    const scope = { connectionId: connection.id, kind: 'reconcile', market };
    const todays = await this.prisma.brokerSyncRun.findMany({
      where: { ...scope, tradingDate, status: { in: ['succeeded', 'failed'] } },
      select: { status: true, finishedAt: true },
    });
    const lastSucceeded = await this.prisma.brokerSyncRun.findFirst({
      where: { ...scope, status: 'succeeded', tradingDate: { not: null } },
      select: { tradingDate: true },
      orderBy: { tradingDate: 'desc' },
    });

    const decision = decideReconcile({
      market,
      clock,
      dayStatus,
      todaysRuns: tallyTodaysRuns(todays),
      lastSucceededTradingDate: lastSucceeded?.tradingDate
        ? calendarDateOf(lastSucceeded.tradingDate)
        : null,
      now,
    });
    if (decision.action === 'skip') return;
    if (dayStatus === 'unknown') {
      this.logger.warn(
        `市场 ${market} 的交易日历未覆盖 ${clock.date} — 按「未知」照常对账 (连接 ${connection.id})`,
      );
    }

    let runId: bigint;
    try {
      ({ id: runId } = await this.prisma.brokerSyncRun.create({
        data: {
          accountId: connection.accountId,
          connectionId: connection.id,
          kind: 'reconcile',
          status: 'running',
          market,
          target: '*',
          tradingDate,
          windowStart: dateColumn(decision.windowStart),
          windowEnd: tradingDate,
          startedAt: now,
        },
        select: { id: true },
      }));
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      this.logger.log(
        `对账 ${market} ${clock.date} 连接 ${connection.id} 已有进行中或已成功的记录, 本拍跳过`,
      );
      return;
    }

    await this.syncBrokerAccount.execute({
      connectionId: connection.id,
      markets: [market],
      target: '*',
      window: { start: decision.windowStart, end: clock.date },
      mode: 'reconcile',
      runId,
      now,
    });
  }
}

/** `'*'` ⇒ 全部市场; 单只标的 ⇒ 其 canonical ticker 前缀 (`us:X` / `hk:00700`) 所属市场; 其余 ⇒ `null`。 */
function marketsOfTarget(target: string): readonly BrokerMarket[] | null {
  if (target === '*') return ALL_MARKETS;
  const prefix = parseAnchorTicker(target)?.market;
  const market = ALL_MARKETS.find((m) => m === prefix);
  return market === undefined ? null : [market];
}

/** 记录两端窗口齐全 ⇒ 按窗口; 否则 `'all-history'`。 */
function windowOf({ windowStart, windowEnd }: DueBackfill): BrokerTradeWindow | 'all-history' {
  if (windowStart === null || windowEnd === null) return 'all-history';
  return { start: calendarDateOf(windowStart), end: calendarDateOf(windowEnd) };
}

/**
 * 当日已结束的对账记录 → 判定输入。`failed` 含卡死回收置为「执行中断」的记录 (其 `finishedAt` =
 * 回收时刻); 最近失败时刻取 `finishedAt` 最大值。复杂度 O(n)。
 */
function tallyTodaysRuns(
  runs: readonly { status: string; finishedAt: Date | null }[],
): ReconcileInput['todaysRuns'] {
  let succeeded = 0;
  let failed = 0;
  let lastFailedAt: Date | null = null;
  for (const { status, finishedAt } of runs) {
    if (status === 'succeeded') {
      succeeded++;
      continue;
    }
    failed++;
    if (finishedAt !== null && (lastFailedAt === null || finishedAt > lastFailedAt)) {
      lastFailedAt = finishedAt;
    }
  }
  return { succeeded, failed, lastFailedAt };
}

/**
 * 当日已结束的**缺口补偿**记录 → 判定输入。与 {@link tallyTodaysRuns} 的差别只在多取一个
 * 「最近成功时刻」—— 补偿判定要区分「失败之后又成功过」与「失败还挂着」, 而对账判定只需要
 * 知道当日成功过没有。复杂度 O(n)。
 */
function tallyGapfillRuns(
  runs: readonly { status: string; finishedAt: Date | null }[],
): GapfillInput['todaysRuns'] {
  let failed = 0;
  let lastFailedAt: Date | null = null;
  let lastSucceededAt: Date | null = null;
  for (const { status, finishedAt } of runs) {
    if (status === 'succeeded') {
      if (finishedAt !== null && (lastSucceededAt === null || finishedAt > lastSucceededAt)) {
        lastSucceededAt = finishedAt;
      }
      continue;
    }
    failed++;
    if (finishedAt !== null && (lastFailedAt === null || finishedAt > lastFailedAt)) {
      lastFailedAt = finishedAt;
    }
  }
  return { failed, lastFailedAt, lastSucceededAt };
}

/**
 * 交易所当地 `YYYY-MM-DD` ⇄ 日期 / 窗口列的承载值 (UTC 零点)。两向都只搬运日历字段, 不经任何时区:
 * `@db.Date` 列按 UTC 字段落库, 读回同一天。
 */
function dateColumn(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function calendarDateOf(column: Date): string {
  return column.toISOString().slice(0, 10);
}

/** Prisma 唯一约束冲突 (duck-typing 判 code, 同仓 `alert/evaluate-alerts.usecase.ts` 口径)。 */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
