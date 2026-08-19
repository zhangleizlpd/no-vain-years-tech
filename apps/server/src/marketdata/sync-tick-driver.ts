import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CronExpressionParser } from 'cron-parser';
import { marketdataSyncConfig, type MarketdataSyncConfig } from '../config/marketdata.config.js';
import { PrismaService } from '../security/prisma.service.js';
import { CalendarHitCheck } from './calendar-hit-check.js';
import type { DimensionKey } from './dimension-executor.js';
import { MarketdataSyncQueue } from './marketdata-sync.queue.js';
import { SyncRunRecorder } from './sync-run.recorder.js';
import {
  assembleSyncFlow,
  deriveExecutionOrder,
  type SyncDependencyEdge,
} from './sync-flow-assembler.js';
import { userToday } from './session-clock.js';
import { resolveAsOfForDimension } from './sync-asof.rules.js';
import { isTradingDayGateOpen } from './trading-day-gate.js';
import { TRADING_CALENDAR_PORT, type TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 下一触发时刻 (cron-parser + Asia/Shanghai)。
 *
 * **必须 from `now`** (非 from 旧 nextFireAt) — misfire≠backfill 的实现承重点 (FR-S04):
 * 宕机多天后首 tick 直接跳到 now 之后的下一触发, 不逐 tick 逐天补跑; 历史缺口归 backfill
 * CLI。严格未来 (now 恰为触发时刻 → 返下一个)。坏 cronExpr → throw (调用方逐行 catch)。
 */
export function computeNext(cronExpr: string, now: Date): Date {
  return CronExpressionParser.parse(cronExpr, { currentDate: now, tz: 'Asia/Shanghai' })
    .next()
    .toDate();
}

/** 抢占成功维度: misfirePolicy 分流 (c) + 入队 attempts 注入 (T014) 的最小投影。 */
export interface TickWonDimension {
  dimensionKey: string;
  retryMax: number;
  misfirePolicy: string;
}

/** claim 结果 (IT 断言面 + T014 接线输入)。 */
export interface TickClaimResult {
  /** (a) NULL → 懒初始化到未来时刻的维度 (本轮不入队不补跑, clarify Q1)。 */
  initialized: string[];
  /** (b) 条件 UPDATE 抢占成功的维度 (nextFireAt 已推进)。 */
  won: TickWonDimension[];
  /** (c) won 中 misfirePolicy=fire-now 子集 — 唯一进入组 flow 入队流程的集合。 */
  fireNow: TickWonDimension[];
}

/** tick 完整结果: claim + 实际入队维度 (非交易日 / 装配 throw → fired 空)。 */
export interface TickResult extends TickClaimResult {
  fired: string[];
}

/**
 * PG 真相层 tick 驱动 (017 T013, ADR-0049): 分钟级无状态扫描 `sync_dimension`,
 * 全部 playbook「conditional UPDATE affected-count」范式 (READ COMMITTED, 无锁无事务嵌套):
 *
 *  (a) **NULL 懒初始化**: enabled 且 nextFireAt IS NULL (migration 后 / 运维置 NULL 重物化)
 *      → 按 cronExpr 写入 from-now 下一触发, **本轮不入队** (无 surprise 补跑)。
 *  (b) **抢占 claim**: nextFireAt <= now → `updateMany where {id, nextFireAt:<观测值>}`
 *      推进 → count=1 won / 0 lost (双 tick 并发恰好一次, 正确性不依赖 Redis 锁)。
 *  (c) **misfire 分流**: skip-to-next 一律只推进不入队; fire-now 进组 flow 流程 (T014:
 *      交易日 gate → D3 装配 → FlowProducer)。按时触发与 misfire catch-up 同路径。
 *
 * 逐行独立 try/catch (坏 cronExpr → ERROR log + 跳过该行, 不放弃整轮 tick)。
 */
@Injectable()
export class SyncTickDriver {
  private readonly logger = new Logger(SyncTickDriver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncQueue: MarketdataSyncQueue,
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
    @Inject(marketdataSyncConfig.KEY) private readonly cfg: MarketdataSyncConfig,
    private readonly calendarCheck: CalendarHitCheck,
    private readonly recorder: SyncRunRecorder,
  ) {}

  /**
   * 分钟级驱动 (`@Cron` 装饰器表达式必须**静态** — 装饰期 eval 读不到注入 config)。
   * 起手灰度 flag 短路 (默认 false, US7): flag 关时 tick 完全不被驱动 (零副作用)。
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    if (!this.cfg.tickEnabled) return;
    await this.tick(new Date());
  }

  /**
   * tick 完整路径: claim → 交易日 gate (组 flow 前短路, 零 vendor 调用 — nextFireAt 已在
   * claim 推进, 非交易日不补) → D3 装配 → FlowProducer 入队 (job opts 经 T009 helper 语义)。
   * 装配/入队异常: ERROR log 不上抛 (won 已推进, 丢失窗口与 clarify Q3 同级, 下周期照常)。
   */
  async tick(now: Date): Promise<TickResult> {
    const claim = await this.claim(now);
    if (claim.fireNow.length === 0) return { ...claim, fired: [] };

    // 🚨 `asOf` 是**业务日期**, 不是墙上时钟 —— 求值单点在 `sync-asof.rules.ts`
    // (063 Phase 1): 按各维度自己声明的口径, 落到「交易所当地日历日」或「最近一场已收盘
    // session」。us 的收盘落在北京次日凌晨, 全局用宿主日会让 us 维度日期错位一天、且每周
    // 固定丢掉周五 (失败形态表见 `session-clock.ts`)。**准点触发时两种口径同值 ⇒ 行为零变化**,
    // 差异只在盘中触发 / misfire 补触发那些非准点时刻显形 (#103)。
    const asOfByKey = await this.resolveAsOf(claim.fireNow, now);
    // S2-T1 per-market 交易日 gate (取代旧 MARKET='cn' 单市场 gate): 逐 won 维度按 marketScope
    // OR 判交易日 (零 vendor: 读表), 全 marketScope 休市的维度剔除; 全剔除则短路不组 flow。
    const tradingFireNow = await this.tradingDayGate(claim.fireNow, asOfByKey);
    if (tradingFireNow.length === 0) return { ...claim, fired: [] };

    try {
      // 019 T014 freshness gate (D6, won 后组 flow 前): paused 优先 + event-calendar
      // 日历命中分流 — 未命中剔除出组 flow 集 + skipped 审计 (FR-S03); claim 零改动 (红线)。
      const toFire = await this.freshnessGate(tradingFireNow, asOfByKey, now);
      if (toFire.length === 0) return { ...claim, fired: [] };

      const edges = await this.prisma.syncDependency.findMany({
        select: { upstream: true, downstream: true, mode: true },
      });
      // 全序派生 (019 T005, 常量退役): 全维度行 priority + 边 → Kahn 拓扑 (含未 won 维度,
      // 全序覆盖面与旧常量等价; 派生失败走下方 catch 结构化 ERROR)。
      const priorities = await this.prisma.syncDimension.findMany({
        select: { dimensionKey: true, priority: true },
      });
      const executionOrder = deriveExecutionOrder(
        edges as SyncDependencyEdge[],
        new Map(priorities.map((p) => [p.dimensionKey, p.priority])),
      );
      const tree = assembleSyncFlow(
        toFire.map((w) => ({
          payload: {
            dimensionKey: w.dimensionKey as DimensionKey,
            mode: 'delta' as const,
            asOf: asOfByKey.get(w.dimensionKey) ?? userToday(now),
            triggeredBy: 'tick' as const,
          },
          opts: this.syncQueue.jobOpts({ retryMax: w.retryMax }),
        })),
        edges as SyncDependencyEdge[],
        executionOrder,
      );
      await this.syncQueue.enqueueFlow(tree);
      return { ...claim, fired: toFire.map((w) => w.dimensionKey) };
    } catch (err) {
      // 不可表达拓扑 (装配 throw) / 入队失败: 禁静默 — 结构化 ERROR (FR-S17 出口)。
      this.logger.error(
        `tick 组 flow 失败: ${JSON.stringify({ fireNow: claim.fireNow.map((w) => w.dimensionKey), error: String(err) })}`,
      );
      return { ...claim, fired: [] };
    }
  }

  /**
   * per-market 交易日 gate (S2-T1, 取代旧 MARKET='cn' 单市场 gate): won 维度逐个按其 marketScope
   * 判定 —— scope 内**任一市场**当日开市即放行 (OR 语义: 某市场开市即该市场标的应同步, 下游
   * `loadActiveInstruments` 按开市市场切工作集); 全 marketScope 休市 → 剔除 + 短路审计 log。
   * distinct market 去重后每市场至多一次 `classify` (零 vendor: DbTradingCalendarAdapter 读表)。
   * claim 零改动 (红线): gate 只影响组 flow 集, nextFireAt 已在 claim 推进 (非交易日不补)。
   */
  /**
   * 逐 won 维度求其**业务日期** (A′) —— 委托 `resolveAsOfForDimension`, 本类不自算。
   * scope 跨时区且口径为 `calendar-day` 时会抛 → 此处**只剔除该维度并结构化 ERROR**,
   * 不连坐其余维度 (一个配错的维度不该让整轮 tick 哑掉)。
   */
  private async resolveAsOf(fireNow: TickWonDimension[], now: Date): Promise<Map<string, string>> {
    const rows = await this.prisma.syncDimension.findMany({
      where: { dimensionKey: { in: fireNow.map((w) => w.dimensionKey) } },
      select: { dimensionKey: true, marketScope: true },
    });
    const out = new Map<string, string>();
    for (const row of rows) {
      try {
        out.set(row.dimensionKey, resolveAsOfForDimension(row, now));
      } catch (err) {
        this.logger.error(
          `tick 业务日期求值失败, 剔除该维度: ${JSON.stringify({
            dimensionKey: row.dimensionKey,
            marketScope: row.marketScope,
            error: String(err),
          })}`,
        );
      }
    }
    return out;
  }

  private async tradingDayGate(
    fireNow: TickWonDimension[],
    asOfByKey: Map<string, string>,
  ): Promise<TickWonDimension[]> {
    const rows = await this.prisma.syncDimension.findMany({
      where: { dimensionKey: { in: fireNow.map((w) => w.dimensionKey) } },
      select: { dimensionKey: true, marketScope: true },
    });
    const scopeByKey = new Map(rows.map((r) => [r.dimensionKey, r.marketScope]));
    // distinct market 去重 → 每市场一次交易日判定 (缓存复用)。
    // 🔑 按 market 缓存仍然成立: 一个维度的 asOf = 其 scope 内各市场的**共同**业务日
    // (求值单点已保证唯一), 而市场→业务日在单次 tick 内是确定的 ⇒ 同一 market 无论
    // 出现在哪个维度, 查的都是同一个日期。
    const openByMarket = new Map<string, boolean>();
    for (const [key, scope] of scopeByKey) {
      const asOf = asOfByKey.get(key);
      if (asOf === undefined) continue; // resolveAsOf 已剔除并记 ERROR
      for (const market of scope) {
        if (!openByMarket.has(market)) {
          openByMarket.set(market, await isTradingDayGateOpen(this.calendar, market, asOf));
        }
      }
    }
    const toFire: TickWonDimension[] = [];
    const skipped: string[] = [];
    for (const w of fireNow) {
      const asOf = asOfByKey.get(w.dimensionKey);
      // asOf 求值失败 (scope 跨时区) → 不组 flow; ERROR 已在 resolveAsOf 记过, 此处不重复。
      if (asOf === undefined) continue;
      const scope = scopeByKey.get(w.dimensionKey) ?? [];
      if (scope.some((market) => openByMarket.get(market))) toFire.push(w);
      else skipped.push(`${w.dimensionKey}@${asOf}`);
    }
    if (skipped.length > 0) {
      this.logger.log(`非交易日 — 维度 [${skipped.join(',')}] 全 marketScope 休市, 短路不组 flow`);
    }
    return toFire;
  }

  /**
   * freshness gate (019 T014, US2/FR-S02/S03, plan D6): fireNow 维度逐个分流 —
   * ① `paused_until` 优先级最高 (FR-S10/analyze M2: 暂停期内无论画像不执行; 016 seam
   *    列至此填充执行语义, 落点与 freshness 同 gate — claim 红线不碰);
   * ② `event-calendar` → CalendarHitCheck 命中才放行, 未命中 skipped 审计 (零 vendor
   *    数据外呼; nextFireAt 已在 claim 推进, 零额外动作);
   * ③ continuous-daily / slow-drift 直通 (行为 = 017 现状, FR-S11 退化态等价)。
   * CLI/cascade 路径不经 tick → 天然不受 gate 约束 (运维显式触发永远跑, D6)。
   */
  private async freshnessGate(
    fireNow: TickWonDimension[],
    asOfByKey: Map<string, string>,
    now: Date,
  ): Promise<TickWonDimension[]> {
    if (fireNow.length === 0) return [];
    const rows = await this.prisma.syncDimension.findMany({
      where: { dimensionKey: { in: fireNow.map((w) => w.dimensionKey) } },
      select: {
        dimensionKey: true,
        freshnessProfile: true,
        calendarSource: true,
        pausedUntil: true,
      },
    });
    const byKey = new Map(rows.map((r) => [r.dimensionKey, r]));
    const toFire: TickWonDimension[] = [];
    for (const w of fireNow) {
      const row = byKey.get(w.dimensionKey);
      if (row?.pausedUntil && row.pausedUntil > now) {
        await this.recorder.recordSkippedWithReason(
          `sync:${w.dimensionKey}`,
          `paused_until ${row.pausedUntil.toISOString()} 未到期 (维度暂停, 画像不参与判定)`,
          now,
        );
        continue;
      }
      if (row?.freshnessProfile === 'event-calendar') {
        // asOf 用该维度自己的业务日 (A′) —— 日历命中判定与交易日闸同一口径。
        const asOf = asOfByKey.get(w.dimensionKey) ?? userToday(now);
        const hit = await this.calendarCheck.isHit(
          { dimensionKey: w.dimensionKey, calendarSource: row.calendarSource },
          asOf,
        );
        if (!hit) {
          await this.recorder.recordSkippedWithReason(
            `sync:${w.dimensionKey}`,
            `event-calendar 日历未命中 (asOf=${asOf}, source=${row.calendarSource ?? 'NULL'})`,
            now,
          );
          continue;
        }
      }
      toFire.push(w);
    }
    return toFire;
  }

  /** tick 纯逻辑半 (可直调控时): (a)+(b)+(c) — 入队接线半见 tick()。 */
  async claim(now: Date): Promise<TickClaimResult> {
    const initialized: string[] = [];

    // (a) NULL 懒初始化 (条件 nextFireAt:null 防与并发 tick 重复写)。
    const unmaterialized = await this.prisma.syncDimension.findMany({
      where: { enabled: true, nextFireAt: null },
      select: { id: true, dimensionKey: true, cronExpr: true },
    });
    for (const row of unmaterialized) {
      try {
        const { count } = await this.prisma.syncDimension.updateMany({
          where: { id: row.id, nextFireAt: null },
          data: { nextFireAt: computeNext(row.cronExpr, now) },
        });
        if (count === 1) initialized.push(row.dimensionKey);
      } catch (err) {
        this.logger.error(
          `tick 懒初始化失败 (坏 cronExpr?): ${JSON.stringify({ dimensionKey: row.dimensionKey, cronExpr: row.cronExpr, error: String(err) })}`,
        );
      }
    }

    // (b) 抢占: 逐行条件 UPDATE (观测值相等防双 tick 同 claim; 单行失败不影响其余)。
    const due = await this.prisma.syncDimension.findMany({
      where: { enabled: true, nextFireAt: { lte: now } },
      select: {
        id: true,
        dimensionKey: true,
        cronExpr: true,
        nextFireAt: true,
        retryMax: true,
        misfirePolicy: true,
      },
    });
    const won: TickWonDimension[] = [];
    for (const row of due) {
      try {
        const { count } = await this.prisma.syncDimension.updateMany({
          where: { id: row.id, nextFireAt: row.nextFireAt },
          data: { nextFireAt: computeNext(row.cronExpr, now) },
        });
        if (count === 1) {
          won.push({
            dimensionKey: row.dimensionKey,
            retryMax: row.retryMax,
            misfirePolicy: row.misfirePolicy,
          });
        }
      } catch (err) {
        this.logger.error(
          `tick 抢占失败 (坏 cronExpr?): ${JSON.stringify({ dimensionKey: row.dimensionKey, cronExpr: row.cronExpr, error: String(err) })}`,
        );
      }
    }

    // (c) misfire 分流: fire-now 才进组 flow 流程 (skip-to-next 已在 (b) 推进, 到此为止)。
    return { initialized, won, fireNow: won.filter((w) => w.misfirePolicy === 'fire-now') };
  }
}
