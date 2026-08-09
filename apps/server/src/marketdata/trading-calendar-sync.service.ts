import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { marketdataSyncConfig, type MarketdataSyncConfig } from '../config/marketdata.config.js';
import { PrismaService } from '../security/prisma.service.js';
import {
  TRADING_CALENDAR_SOURCE,
  type TradingCalendarSource,
} from './trading-calendar-source.port.js';
import { shanghaiToday } from './trading-day-gate.js';

/**
 * 交易日历填充服务 (sync-1 S1-T2): `trading_day` 表的**写入端** (populate/seed)。读端是
 * `TRADING_CALENDAR_PORT` (DbTradingCalendarAdapter, S1-T4)。指数日历免费源 (eastmoney) →
 * 逐市场落 `trading_day(market, date)`, 顶替旧「每次 gate 现打理杏仁付费指数 candlestick」。
 *
 * @Cron 每日 21:00 Asia/Shanghai —— **早于 22:00 sync tick**, 破「今日交易日 gate 需今日已入表」
 * 鸡生蛋; 本服务**不受交易日 gate 约束** (它就是 gate 的数据源)。
 */

/** 交易日历覆盖市场 (市场级, 与 universe 维度解耦; eastmoney 指数源三市场齐备)。 */
export const CALENDAR_MARKETS = ['cn', 'hk', 'us'] as const;

/** @Cron 每日填充回看窗 (天): 覆盖今日 + 近期缺口 (服务短暂停摆自愈); 一次 vendor 调用覆盖整窗。 */
const POPULATE_LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;

/** 心跳 `lastError` 存文截断: vendor 报错可能挟带整页 HTML, 心跳行只需可诊断的开头。 */
const ERROR_TEXT_MAX = 1000;

/** per-market 填充结果 (IT 断言面 + 日志)。 */
export interface CalendarSyncResult {
  market: string;
  /** vendor 返回的交易日数 (区间内)。 */
  fetched: number;
  /** 新落库行数 (幂等: 已存在的 (market,date) 由 skipDuplicates 跳过, 不计入)。 */
  inserted: number;
}

@Injectable()
export class TradingCalendarSyncService {
  private readonly logger = new Logger(TradingCalendarSyncService.name);

  constructor(
    @Inject(TRADING_CALENDAR_SOURCE) private readonly source: TradingCalendarSource,
    private readonly prisma: PrismaService,
    @Inject(marketdataSyncConfig.KEY) private readonly cfg: MarketdataSyncConfig,
  ) {}

  /**
   * 每日 21:00 Asia/Shanghai (@Cron 表达式静态)。灰度 flag 短路 (tickEnabled 默认 false):
   * 与 SyncTickDriver 同门 —— dev/test 不外呼 eastmoney; prod 开启后随夜间调度一并生效。
   */
  @Cron('0 0 21 * * *', { timeZone: 'Asia/Shanghai' })
  async handleCron(): Promise<void> {
    if (!this.cfg.tickEnabled) return;
    await this.populate(new Date());
  }

  /** @Cron 本体 (可直调控时, IT 面): 近 N 日窗口 (含今日) 填充 CALENDAR_MARKETS。 */
  async populate(now: Date): Promise<CalendarSyncResult[]> {
    const to = shanghaiToday(now);
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - POPULATE_LOOKBACK_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    return this.syncRange([...CALENDAR_MARKETS], from, to);
  }

  /**
   * 核心填充 (populate 近窗 + seed CLI 宽区间共用): per market 拉指数日历 → `createMany`
   * `skipDuplicates` 幂等落 `trading_day` → 写 `calendar_sync_health` 心跳。
   * 单市场失败**续跑其余** (一市场坏不拖垮全局, FR-004) 但**必留痕** (FR-008)。
   * 复杂度 O(市场数 × 区间交易日数)。
   */
  async syncRange(markets: string[], from: string, to: string): Promise<CalendarSyncResult[]> {
    const results: CalendarSyncResult[] = [];
    for (const market of markets) {
      try {
        const { dates, servedBy } = await this.source.fetchTradingDates(market, from, to);
        const { count } = await this.prisma.tradingDay.createMany({
          data: dates.map((d) => ({ market, date: new Date(`${d}T00:00:00Z`) })),
          skipDuplicates: true,
        });
        await this.recordHeartbeat(market, servedBy);
        results.push({ market, fetched: dates.length, inserted: count });
      } catch (err) {
        // 🚨 044 病根: 旧实现在此**只 WARN + inserted:0** —— 失败除日志外零留痕, 于是源被下线后
        // 静默停摆 2 天。续跑保留 (韧性), 静默废除 (病): 心跳记 lastError 且**不刷 lastSuccessAt**
        // → 心跳陈旧 → 探针告警 (FR-008/FR-010)。
        this.logger.warn(
          `trading-calendar 填充失败 (续跑其余市场): ${JSON.stringify({ market, from, to, error: String(err) })}`,
        );
        await this.recordHeartbeat(market, undefined, err);
        results.push({ market, fetched: 0, inserted: 0 });
      }
    }
    this.logger.log(`trading-calendar 填充完成: ${JSON.stringify({ from, to, results })}`);
    return results;
  }

  /**
   * per-market 心跳 upsert (`calendar_sync_health`)。**liveness 而非 freshness**: 填充成功即刷
   * `lastSuccessAt` —— 长假「成功但零新增」心跳照样新 (不误报, SC-005); app 挂掉心跳自然陈旧
   * (照样告警, FR-010)。
   *
   * · 成功 → `lastSuccessAt` + `servedBy` (**降级 ≠ 健康**, FR-014: 记胜出层, 非主源 → 探针告警)
   *   + 清 `lastError` (恢复的市场不该挂着陈年错误)。
   * · 失败 → 只动 `lastAttemptAt` + `lastError`; `lastSuccessAt`/`servedBy` **纹丝不动**
   *   ——「本次跑过」绝不等于「本次成功」。
   *
   * 🚨 心跳是**观测面**, 自身写失败只记 ERROR 不外抛: 否则 PG 抖动会把「一市场坏不拖垮全局」
   * (FR-004) 反噬掉 —— 观测设施不该反过来当故障源。
   */
  private async recordHeartbeat(market: string, servedBy?: string, err?: unknown): Promise<void> {
    const at = new Date();
    const data =
      err === undefined
        ? { lastSuccessAt: at, lastAttemptAt: at, lastError: null, servedBy }
        : { lastAttemptAt: at, lastError: String(err).slice(0, ERROR_TEXT_MAX) };
    try {
      await this.prisma.calendarSyncHealth.upsert({
        where: { market },
        create: { market, ...data },
        update: data,
      });
    } catch (hbErr) {
      this.logger.error(
        `trading-calendar 心跳写入失败 (不影响填充结果): ${JSON.stringify({ market, error: String(hbErr) })}`,
      );
    }
  }
}
