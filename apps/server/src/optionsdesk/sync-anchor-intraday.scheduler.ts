import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { marketdataConfig, type MarketdataConfig } from '../config/marketdata.config';
import type { MarketSession } from '../marketdata/market-state.port';
import { REDIS_CLIENT } from '../security/redis.token';
import { INTRADAY_CIRCUIT_THRESHOLD, INTRADAY_TICK_INTERVAL_SECONDS } from './intraday-spot.rules';
import {
  classifyTickSource,
  SyncAnchorIntradayUseCase,
  type SyncAnchorIntradayReport,
  type TickSourceVerdict,
} from './sync-anchor-intraday';

/**
 * 061 — `SyncAnchorIntradayUseCase` 的**触发器** (FR-005 / FR-012, plan D6/D8/D9)。
 * 四件事: 定时、mock 闸、熔断计数、收盘补一拍的跨拍留痕。
 *
 * 🚨 **进程内 `@Cron`, 不引 BullMQ** (plan D6): `optionsdesk` 一套 queue/worker/connection
 * 都没有 (那些全在 `alert`), 为一个 30 秒 tick 从零搭 BullMQ 拓扑是过度设计。熔断计数用
 * Redis 即可。形态照当时本 ctx 既有的 `sync-anchor-quote.scheduler.ts` (已随 ADR-0070 删除;
 * 今天的同侪是 `sync-anchor-last-close.scheduler.ts` —— 它**不接熔断**, 理由见其文件头)。
 *
 * ⚠️ **已知代价 (与既有 scheduler 同一前提, 非本片新引入)**: 进程内 `@Cron` 在多实例部署下
 * 会重复触发。现状单实例, 且本 tick 幂等 (覆盖写同一批列, 最后写赢), 重复的代价只是多一次
 * vendor 调用。**刻意不加分布式锁** —— 这条归 ADR amendment 记录, 不在这里发明机制。
 *
 * 🚨 **mock 档两层防线** (Guardrail 6): 本文件起手判 provider kind, mock 直接 return
 * `skipped-mock`、**0 次 port 调用**; `marketdata.module.ts` 的 `refusingCollectionPort`
 * 拒绝壳退为兜底 (防有人绕过本闸直调 port)。只靠拒绝壳的话, dev 机上 tick 每 30 秒抛一次、
 * 每 90 秒熔断一次 —— 054 想要的那份「你的本地进程正在试图采集」的可见性反被噪声淹没。
 *
 * 🚨🚨 **熔断只认行情源** (Guardrail 16): 计数口径单点在 use case 的
 * {@link classifyTickSource} —— 「该市场没接实时源」是**配置事实**, 落 `no-attempt`,
 * failstreak 一次都不加。use case 自己意外抛 (库挂了等) 同样**不计**: 那不是行情源的事,
 * 且数据陈旧已由 90 秒新鲜度闸在读端兜住。
 */

/** 🚨 **独立命名空间** —— MUST NOT 与 `alert:intraday:*` 共用 (两套 failstreak 是收编前的过渡态)。 */
const INTRADAY_KEY_PREFIX = 'optionsdesk:intraday:';

export const INTRADAY_FAILSTREAK_KEY = `${INTRADAY_KEY_PREFIX}failstreak`;
export const INTRADAY_CIRCUIT_KEY = `${INTRADAY_KEY_PREFIX}circuit`;
/** 上一拍观测到的各市场时段 —— 收盘补一拍 (FR-005) 唯一的跨拍状态。 */
export const INTRADAY_LAST_SESSIONS_KEY = `${INTRADAY_KEY_PREFIX}last-sessions`;

/**
 * 🚨 由 {@link INTRADAY_TICK_INTERVAL_SECONDS} **派生**, 不写第二份 30 (Guardrail 10:
 * `T` 是全系统唯一的自由变量, 新鲜度闸与熔断窗口都从它推出来)。6 段秒级 cron。
 */
export const INTRADAY_TICK_CRON = `*/${INTRADAY_TICK_INTERVAL_SECONDS} * * * * *`;

export type CircuitState = 'open' | 'closed';

/** 一拍的处置结果 (IT 断言点 + 排障出口, 形态照 `alert` 的 `IntradayTickOutcome`)。 */
export type AnchorIntradayTickOutcome =
  | { status: 'skipped-mock' }
  | { status: 'failed'; reason: string }
  | {
      status: 'ticked';
      verdict: TickSourceVerdict;
      failstreak: number;
      circuit: CircuitState;
      report: SyncAnchorIntradayReport;
    };

@Injectable()
export class SyncAnchorIntradayScheduler {
  private readonly logger = new Logger(SyncAnchorIntradayScheduler.name);

  constructor(
    private readonly syncAnchorIntraday: SyncAnchorIntradayUseCase,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(marketdataConfig.KEY) private readonly marketdata: MarketdataConfig,
  ) {}

  @Cron(INTRADAY_TICK_CRON, { timeZone: 'Asia/Shanghai' })
  async handleCron(): Promise<void> {
    await this.run();
  }

  /** 一拍。单测直调本方法, 不依赖 ScheduleModule。**任何路径都不上抛** (scheduler 抛 = 进程级 unhandledRejection)。 */
  async run(now: Date = new Date()): Promise<AnchorIntradayTickOutcome> {
    if (this.marketdata.kind === 'mock') {
      // Guardrail 6 第一层: 零 port 调用、零 Redis 触碰 —— dev 机上本 tick 完全静默。
      return { status: 'skipped-mock' };
    }

    try {
      const previousSessions = await this.readPreviousSessions();
      const report = await this.syncAnchorIntraday.execute(now, { previousSessions });

      // 🚨 状态不可得的一拍 (`sessions === null`) **不覆盖**上一拍状态: 覆盖会让「离开白名单」
      // 这个只出现一次的沿被一次源抖动吞掉, 收盘补一拍随之永久丢失。
      if (report.sessions !== null) {
        await this.redis.set(INTRADAY_LAST_SESSIONS_KEY, JSON.stringify(report.sessions));
      }

      const verdict = classifyTickSource(report);
      const { failstreak, circuit } = await this.applyVerdict(verdict);
      return { status: 'ticked', verdict, failstreak, circuit, report };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.error(`anchor intraday tick failed: ${reason}`);
      return { status: 'failed', reason };
    }
  }

  /**
   * 熔断状态机 (照 `alert/intraday-eval.processor.ts` 的三段处置):
   * 成功 → 清 failstreak, circuit 若 open 则 close 并 warn 回升;
   * 失败 → failstreak++, 累计 ≥ {@link INTRADAY_CIRCUIT_THRESHOLD} → open + warn 降级;
   * **一次源调用都没发生 → 两个键都不动** (既不计失败也不清计数)。
   *
   * open 态**不另设跳闸** —— 每拍仍探一次源 (源调用即半开探针), 成功即自动回升。
   */
  private async applyVerdict(
    verdict: TickSourceVerdict,
  ): Promise<{ failstreak: number; circuit: CircuitState }> {
    const circuitWas: CircuitState =
      (await this.redis.get(INTRADAY_CIRCUIT_KEY)) === 'open' ? 'open' : 'closed';

    if (verdict === 'success') {
      await this.redis.set(INTRADAY_FAILSTREAK_KEY, '0');
      if (circuitWas === 'open') {
        await this.redis.set(INTRADAY_CIRCUIT_KEY, 'closed');
        this.logger.warn('实时源恢复 — 盘中价 circuit 回升 closed (收盘档降级解除)');
      }
      return { failstreak: 0, circuit: 'closed' };
    }

    if (verdict === 'failure') {
      const failstreak = await this.redis.incr(INTRADAY_FAILSTREAK_KEY);
      this.logger.warn(`盘中价采集失败 (failstreak=${failstreak})`);
      if (failstreak >= INTRADAY_CIRCUIT_THRESHOLD && circuitWas !== 'open') {
        await this.redis.set(INTRADAY_CIRCUIT_KEY, 'open');
        this.logger.warn(
          `实时源连续 ${failstreak} 次失败 — 盘中价 circuit open, 降级收盘档 ` +
            '(每拍半开探测, 成功自动回升)',
        );
        return { failstreak, circuit: 'open' };
      }
      return { failstreak, circuit: circuitWas };
    }

    // no-attempt: 闸挡下 / 全是无路由市场 —— 两个键都不动 (Guardrail 16 的机器面)。
    const failstreak = Number((await this.redis.get(INTRADAY_FAILSTREAK_KEY)) ?? '0');
    return { failstreak: Number.isFinite(failstreak) ? failstreak : 0, circuit: circuitWas };
  }

  /** 上一拍的各市场时段; 缺失 / 不可解析 ⇒ `null` (不猜, 也不因此让整拍失败)。 */
  private async readPreviousSessions(): Promise<Record<string, MarketSession> | null> {
    const raw = await this.redis.get(INTRADAY_LAST_SESSIONS_KEY);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, MarketSession>;
    } catch {
      this.logger.warn(`上一拍市场时段不可解析, 本拍按「无上一拍」处理: ${raw}`);
      return null;
    }
  }
}
