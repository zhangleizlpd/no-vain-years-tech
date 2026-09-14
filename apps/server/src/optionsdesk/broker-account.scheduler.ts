import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { marketdataConfig, type MarketdataConfig } from '../config/marketdata.config';
import { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';
import type { BrokerTradeWindow } from './broker-account.port';
import type { BrokerMarket } from './broker-code.rules';
import { decideBackfillAfterInfraFailure } from './broker-sync-slot.rules';
import { SyncBrokerAccountUseCase } from './sync-broker-account.usecase';

/** 心跳 cron job 名 (`SchedulerRegistry.getCronJob` 的键)。 */
export const BROKER_ACCOUNT_HEARTBEAT = 'broker-account-heartbeat';

/** `running` 超过这么久仍未结束 = 执行中进程重启 / 崩溃留下的卡死记录 (plan D9 步骤 1)。 */
const STUCK_RUNNING_MS = 15 * 60 * 1000;

/** 卡死回收的对账记录 `error`: 计入当日失败次数, 由对账判定按重试规则重新发起。 */
export const RUN_INTERRUPTED_ERROR = '执行中断';

/** 补齐基础设施故障距首次尝试满 24 小时后的 `error` (停止重试, 由维护者重新触发)。 */
export const BACKFILL_RETRY_EXHAUSTED_ERROR = '基础设施重试耗尽';

/** `target = '*'` 覆盖的全部市场 (clarify Q3)。 */
const ALL_MARKETS: readonly BrokerMarket[] = ['us', 'hk'];

/** 一拍的处置结果 (IT 断言点 + 排障出口)。 */
export type BrokerAccountHeartbeatOutcome =
  | { status: 'skipped-mock' }
  | { status: 'failed'; reason: string }
  | { status: 'ticked'; connections: number; failedConnections: number };

type DueBackfill = {
  id: bigint;
  target: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  firstAttemptedAt: Date | null;
};

/**
 * 082 —— `SyncBrokerAccountUseCase` 的**触发器** (plan D9; FR-009 / FR-010 / FR-017 / FR-018)。
 * 每分钟一拍, 对每个连接依次: ① 回收卡死记录 → ② 认领并执行到期的补齐记录 → ③ 开盘前对账编排。
 *
 * 🚨 **防重入两层**: 第一层 `waitForCompletion: true` —— cron 4.4.0 默认不等上一拍的 Promise
 * (`cron/dist/job.js:121-133`), 一次全量补齐约 74 s > 心跳 60 s, 漏了就两拍并发 (plan D9);
 * 仓内其它 `@Cron` 都没带这个选项, 别照抄它们。第二层在数据库: 补齐认领是条件 UPDATE +
 * affected-count, 对账插入撞部分唯一索引即跳过 —— 进程内选项挡不住并发直调与未来多实例。
 * 单实例部署, 不加分布式锁 (同 `sync-anchor-intraday.scheduler.ts` 先例)。
 *
 * mock 档起手即 `skipped-mock`, 零 port 调用 (FR-018; 模块层拒绝壳是兜底)。
 */
@Injectable()
export class BrokerAccountScheduler {
  private readonly logger = new Logger(BrokerAccountScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncBrokerAccount: SyncBrokerAccountUseCase,
    @Inject(marketdataConfig.KEY) private readonly marketdata: MarketdataConfig,
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
      const connections = await this.prisma.brokerConnection.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      let failedConnections = 0;
      for (const { id } of connections) {
        try {
          await this.reclaimStuckRuns(id, now);
          await this.runDueBackfills(id, now);
          await this.reconcile();
        } catch (e) {
          failedConnections++;
          this.logger.error(`券商心跳: 连接 ${id} 本拍失败: ${errorMessage(e)}`);
        }
      }
      return { status: 'ticked', connections: connections.length, failedConnections };
    } catch (e) {
      const reason = errorMessage(e);
      this.logger.error(`券商心跳失败: ${reason}`);
      return { status: 'failed', reason };
    }
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

  /** 步骤 ③: 开盘前对账编排 (T017)。 */
  private reconcile(): Promise<void> {
    return Promise.resolve();
  }
}

/** `'*'` ⇒ 全部市场; 单只标的 ⇒ 其 canonical ticker 前缀 (`us:X` / `hk:00700`) 所属市场; 其余 ⇒ `null`。 */
function marketsOfTarget(target: string): readonly BrokerMarket[] | null {
  if (target === '*') return ALL_MARKETS;
  const prefix = parseAnchorTicker(target)?.market;
  const market = ALL_MARKETS.find((m) => m === prefix);
  return market === undefined ? null : [market];
}

/**
 * 记录两端窗口齐全 ⇒ 按窗口; 否则 `'all-history'`。窗口列是 UTC 零点承载的 `YYYY-MM-DD`
 * (写入方以 `T00:00:00Z` 构造), 取回时按 UTC 字段切日期 —— 不做任何时区换算。
 */
function windowOf({ windowStart, windowEnd }: DueBackfill): BrokerTradeWindow | 'all-history' {
  if (windowStart === null || windowEnd === null) return 'all-history';
  return {
    start: windowStart.toISOString().slice(0, 10),
    end: windowEnd.toISOString().slice(0, 10),
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
