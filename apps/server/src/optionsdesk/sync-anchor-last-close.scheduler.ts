import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { marketdataConfig, type MarketdataConfig } from '../config/marketdata.config';
import {
  SyncAnchorLastCloseUseCase,
  type SyncAnchorLastCloseReport,
} from './sync-anchor-last-close';

/**
 * ADR-0070 — {@link SyncAnchorLastCloseUseCase} 的**触发器**。只做两件事: 定时 + mock 闸。
 *
 * ## 🚨 **不接熔断**, 与 `sync-anchor-intraday.scheduler.ts` 刻意不同
 *
 * 那套 failstreak / circuit 是为 **30 秒一拍**的盘中路径建的: 源挂了会在 90 秒内累计三次失败,
 * 而读端有一道 90 秒新鲜度闸等着被通知「该降级了」。本片一天真外呼**数次** —— 熔断计数器
 * 攒不出统计意义, 而降级对象 (收盘价) 也没有第二档可落。
 *
 * 数据面的监控**已经有了且在进程外**: `ops/jobs/app-state-health.sql` 判「active 锚的
 * `last_close_date` 全部落后 > 2 交易日」, 每 4h 一跑。⇒ 这里再造一套进程内熔断只会多一处
 * 会漂的状态, 而它看得见的东西那条 SQL 全都看得见。
 *
 * ## 🚨 **每 10 分钟一拍, 且这不是「轮询浪费」**
 *
 * use case 的闸③ (工作集) 让稳态开销归零: 某场写完之后, 该市场当天余下每一拍都在
 * `up-to-date` 出口返回, **0 次外呼、0 次写库**, 只剩一次日历查询 + 一次锚表 select。
 * 真外呼只发生在「窗刚开」与「上一拍没采全」两种情形。
 *
 * ⇒ 10 分钟这个数**只决定补采的时间分辨率**, 不决定成本: 港股 16:10 开窗, 最坏 16:20 写完,
 * 相对现状的 22:30 仍是数量级改善。取更密没有收益 (vendor 那头的价在窗内不再变), 取更疏
 * 会在「首拍失败」时把恢复推迟一整个间隔。
 *
 * ⚠️ **已知代价 (与既有两个 scheduler 同一前提, 非本片新引入)**: 进程内 `@Cron` 在多实例
 * 部署下会重复触发。现状单实例, 且本拍幂等 (工作集判据 + 覆盖写同一批列) ⇒ 重复的代价只是
 * 多一次 vendor 调用。刻意不加分布式锁。
 *
 * 🚨 **mock 档零 port 调用** (Guardrail 6): dev 机上本 tick 完全静默。dev 的锚表由
 * `scripts/jobs/marketdata-dev-sync` 每日 09:05 从 prod 全量重灌 ⇒ 本 tick 不采**不会**让
 * dev 的 `last_close` 冻结。
 *
 * 降级: 整拍 try/catch, 异常只 `logger.error` **不上抛** —— scheduler 抛异常 = 进程级
 * unhandledRejection。挂一拍的代价是「这一场的收盘价晚 10 分钟」, 下一拍自动追上 (工作集还在)。
 */

/** 🚨 由 {@link LAST_CLOSE_TICK_INTERVAL_MINUTES} 派生, 不写第二份 10。6 段秒级 cron。 */
export const LAST_CLOSE_TICK_INTERVAL_MINUTES = 10;
export const LAST_CLOSE_TICK_CRON = `0 */${LAST_CLOSE_TICK_INTERVAL_MINUTES} * * * *`;

/** 一拍的处置结果 (单测断言点 + 排障出口)。 */
export type AnchorLastCloseTickOutcome =
  | { status: 'skipped-mock' }
  | { status: 'failed'; reason: string }
  | { status: 'ticked'; report: SyncAnchorLastCloseReport };

@Injectable()
export class SyncAnchorLastCloseScheduler {
  private readonly logger = new Logger(SyncAnchorLastCloseScheduler.name);

  constructor(
    private readonly syncAnchorLastClose: SyncAnchorLastCloseUseCase,
    @Inject(marketdataConfig.KEY) private readonly marketdata: MarketdataConfig,
  ) {}

  @Cron(LAST_CLOSE_TICK_CRON, { timeZone: 'Asia/Shanghai' })
  async handleCron(): Promise<void> {
    await this.run();
  }

  /** 一拍。单测直调本方法, 不依赖 ScheduleModule。**任何路径都不上抛**。 */
  async run(now: Date = new Date()): Promise<AnchorLastCloseTickOutcome> {
    if (this.marketdata.kind === 'mock') {
      return { status: 'skipped-mock' };
    }

    try {
      const report = await this.syncAnchorLastClose.execute(now);
      return { status: 'ticked', report };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.error(`anchor last-close tick failed: ${reason}`);
      return { status: 'failed', reason };
    }
  }
}
