import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { isWithinPostCloseWindow } from '../marketdata/session-clock';
import {
  REALTIME_QUOTE_MAX_SYMBOLS,
  REALTIME_QUOTE_PORT,
  RealtimeQuoteMarketUnsupportedError,
  type RealtimeQuote,
  type RealtimeQuotePort,
} from '../marketdata/realtime-quote.port';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';
import { parseAnchorTicker } from './anchor.rules';
import { dateOnlyOf, utcMidnight } from './date-only';

/**
 * ADR-0070 — 锚 `last_close` / `last_close_date` 的**收盘后同源写手**。
 * 一拍 = 按 market 分组 → 三闸取交集 → 求工作集 → 切批外呼 → 逐锚写两列。
 *
 * ## 🚨 它**取代**了 `sync-anchor-quote.ts` 的 `daily_bar` 每小时单向投影
 *
 * 病根不是准确性 (投影 27/28 准确) 而是**到货时刻与源**: 港股链路是
 * `HK 16:00 收盘 → eod_bar 22:00(理杏仁) → daily_bar → 每小时 :30 投影 → 22:30 锚表`
 * ⇒ 收盘后 6.5 小时雷达上的锚价还是 T−1 的; 且期权数据走富途、锚价走理杏仁, 腿表的
 * moneyness 与雷达的距 W% 分别以两个源的数为操作数, **对不齐也没有任何地方会报**。
 *
 * ## 🚨 三闸**取交集**, 缺任一条都会静默写错数
 *
 * ① **目标 session 可判定** (`lastClosedSession`, `null` ⇒ 不猜、跳过);
 * ② **收盘后补采窗** ({@link isWithinPostCloseWindow} —— 已过定稿缓冲 ∧ 未跨交易所当地午夜);
 * ③ **工作集非空** (`last_close_date < 目标 session`)。
 *
 * 其中 ② 的后半条 (同日窗) 是本片最容易被当成洁癖删掉的一条, 它挡的是: D 那场采失败的锚,
 * 到 D+1 **盘中**重试时 `lastClosedSession` 仍返 D (D+1 未收盘) ⇒ 拿到 D+1 的盘中实时价写进
 * 「D 的收盘价」, 日期列还是对的 ⇒ **没有断言会红**。判据与理由单点在 session-clock。
 *
 * ## 🚨 重试就是 ③ 本身, 不另建机制
 *
 * 工作集判据天然幂等: 写成即退出工作集 ⇒ 同一场后续每一拍 **0 次外呼**; 没写成就还在里面 ⇒
 * 下一拍自动重试, 直到跨午夜出窗。⇒ 无需 failstreak / 退避 / 重试计数表。**熔断也不接** ——
 * 061 那套是为 30 秒一拍的高频路径建的; 本片一天真外呼数次, 数据面已由
 * `ops/jobs/app-state-health.sql` 的锚陈旧度判据在进程外看着。
 *
 * ## 🚨 0 值哨兵是**白拿的**, 别在本文件里再判一次
 *
 * 富途用带内 `0` 表达「停牌 / 无成交」(官方书面确认), 归一已在 `futu-realtime-quote.adapter.ts`
 * 的 `tradedPriceOrNull` 按 ADR-0067 做掉 ⇒ 到本文件时那种行**已经不在 Map 里**, 走的是下面
 * 「缺报价保留旧值」那条路。在这里补一个 `price === 0` 判断 = 第二份判据, 且它永远不会被执行到。
 *
 * ## 与 `sync-anchor-intraday.ts` 的分工
 *
 * 那个写 `intraday_price` / `intraday_at` (30 秒一拍, 盘中实时档); 本文件写 `last_close` /
 * `last_close_date` (收盘后, 收盘档)。读端档位裁决单点在 `intraday-spot.rules.resolveAnchorSpot`。
 * 两者**同用** `REALTIME_QUOTE_PORT` —— 这正是「同源」那三个字的兑现处。
 *
 * ⚠️ 两列**不入 `anchor_change` 痕迹表**, 同 `last_close` 的既有规矩: 痕迹记的是「锚事实被谁
 * 改成什么」, 行情不是人或模型对锚的判断。
 *
 * 🚨 **split-tx**: 外呼取整批、**全程在 tx 外**, NEVER 在 tx 内等 HTTP。落库逐锚独立幂等覆盖,
 * 单锚失败不回滚同批其余。
 */

/** 一个 market 在本拍的处置。**五态互斥**, 供单测断言与排障。 */
export type MarketLastCloseOutcome =
  | {
      market: string;
      /** 闸① 没过: 日历不可判定 (未填到 / 落在覆盖声明之外)。**不猜**, 0 次源调用。 */
      status: 'skipped-undecidable';
    }
  | {
      market: string;
      /** 闸② 没过: 定稿缓冲未到, 或已跨交易所当地午夜出窗。0 次源调用。 */
      status: 'skipped-window';
      /** 本拍算出的目标 session (`YYYY-MM-DD`), 供排障看「它在等哪一场」。 */
      target: string;
    }
  | {
      market: string;
      /** 闸③ 没过: 全组都已是目标 session 的收盘价。**0 次源调用** —— 稳态就落在这里。 */
      status: 'up-to-date';
      target: string;
      anchors: number;
    }
  | {
      market: string;
      /** 🚨 **配置事实**: 该市场未登记实时源。MUST NOT 计入源故障。 */
      status: 'unsupported-market';
      registeredMarkets: readonly string[];
    }
  | {
      market: string;
      status: 'collected';
      target: string;
      /** 本组锚数 / 工作集大小 / 采到报价数 / 真正落库数。 */
      anchors: number;
      work: number;
      quoted: number;
      updated: number;
      /** 切了几批 / 其中几批是源故障。 */
      batches: number;
      failedBatches: number;
      /** 写库时逐锚失败的只数 (不是行情源的事, 不计源故障)。 */
      failedWrites: number;
    };

export interface SyncAnchorLastCloseReport {
  /** 逐 market 处置 (顺序 = 锚表返回顺序里各市场的首现序)。 */
  markets: readonly MarketLastCloseOutcome[];
  /** 本拍扫过的锚数。 */
  scanned: number;
  /** 真正落了 UPDATE 的锚数。 */
  updated: number;
  /** **真·源故障**批次数。 */
  sourceFailures: number;
  /** 成功批次数。 */
  sourceSuccesses: number;
  /** 🚨 无实时源路由的 market —— **配置事实**, 与源故障分列 (Guardrail 16)。 */
  unsupportedMarkets: readonly string[];
}

/** 本 use case 只需要这 3 列 (id 定位 + ticker 寻址 + 现值做工作集判据)。 */
interface AnchorLastCloseRef {
  id: bigint;
  ticker: string;
  lastCloseDate: Date | null;
}

/** 按上限切批。O(n)。 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 锚按 market 分组。**不成形的 ticker 归空串这一组** —— 它在闸① 上就会被挡下
 * (`lastClosedSession('')` 恒 `null`), 走同一条路径, 不需要第二条分支, 也不猜它属于哪个市场。O(n)。
 */
function groupByMarket(anchors: readonly AnchorLastCloseRef[]): Map<string, AnchorLastCloseRef[]> {
  const groups = new Map<string, AnchorLastCloseRef[]>();
  for (const anchor of anchors) {
    const market = parseAnchorTicker(anchor.ticker)?.market ?? '';
    const group = groups.get(market);
    if (group === undefined) groups.set(market, [anchor]);
    else group.push(anchor);
  }
  return groups;
}

/**
 * 工作集判据: 该锚的收盘价**还不是目标 session 那一场的**。
 *
 * 🚨 用 `<` 而非 `!==`: 锚表里出现比目标 session **更新**的日期时 (人工改数 / 时钟回拨),
 * `!==` 会把它拉回来覆盖成更旧的那一场, 而 `<` 只前进不后退。O(1) 纯函数。
 */
export function needsLastCloseRefresh(lastCloseDate: Date | null, target: string): boolean {
  if (lastCloseDate === null) return true;
  return dateOnlyOf(lastCloseDate) < target;
}

@Injectable()
export class SyncAnchorLastCloseUseCase {
  private readonly logger = new Logger(SyncAnchorLastCloseUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: 注入 marketdata 的实时报价端口 (port token + interface, 非 use case
    // —— catalog Q7-C 放行判据同 061)。**同源**正是本片的全部意义: 期权快照与锚价走同一个
    // vendor。方向仍单向: marketdata 对锚表零感知。
    @Inject(REALTIME_QUOTE_PORT) private readonly realtimeQuote: RealtimeQuotePort,
    // CROSS-CONTEXT-SYNC: 注入 marketdata 的交易日历读端口 —— 目标 session 是「最近一场已收盘
    // **交易日**」, 判据本体 (含「日历填到哪儿了」这一维) 归属方拿, 禁在本 ctx 直查 trading_day。
    @Inject(TRADING_CALENDAR_PORT) private readonly tradingCalendar: TradingCalendarPort,
  ) {}

  /**
   * 一拍。复杂度: O(市场数) 次日历查询 + O(ceil(工作集/400)) 次外呼 + O(工作集) 次写。
   * **稳态下工作集为空 ⇒ 零外呼零写**。
   *
   * @param now 注入时钟 (测试可控; 生产取 `new Date()`)。
   */
  async execute(now: Date = new Date()): Promise<SyncAnchorLastCloseReport> {
    const report: {
      -readonly [K in keyof SyncAnchorLastCloseReport]: SyncAnchorLastCloseReport[K];
    } = {
      markets: [],
      scanned: 0,
      updated: 0,
      sourceFailures: 0,
      sourceSuccesses: 0,
      unsupportedMarkets: [],
    };

    const anchors = (await this.prisma.anchor.findMany({
      select: { id: true, ticker: true, lastCloseDate: true },
    })) as AnchorLastCloseRef[];
    report.scanned = anchors.length;

    const markets: MarketLastCloseOutcome[] = [];
    const unsupported: string[] = [];
    for (const [market, group] of groupByMarket(anchors)) {
      // ── 闸①: 目标 session 可判定 ────────────────────────────────────────────
      const target = await this.tradingCalendar.lastClosedSession(market, now);
      if (target === null) {
        markets.push({ market, status: 'skipped-undecidable' });
        continue;
      }

      // ── 闸②: 收盘后补采窗 ──────────────────────────────────────────────────
      // 🚨 `'unknown'` **必须**与 `lastClosedSession` 内部传的那个一致, 否则半日市当天窗会比
      // 目标 session 早开一档 ⇒ 拿今天的价写昨天那一行。理由单点在 session-clock 的注释。
      if (!isWithinPostCloseWindow(market, target, now, 'unknown')) {
        markets.push({ market, status: 'skipped-window', target });
        continue;
      }

      // ── 闸③: 工作集 ────────────────────────────────────────────────────────
      const work = group.filter((a) => needsLastCloseRefresh(a.lastCloseDate, target));
      if (work.length === 0) {
        // 稳态出口: 该场已全部写完 ⇒ 本场后续每一拍都落这里, 0 次外呼。
        markets.push({ market, status: 'up-to-date', target, anchors: group.length });
        continue;
      }

      const fetched = await this.fetchGroup(market, work);
      if (fetched.unsupportedBy !== null) {
        unsupported.push(market);
        markets.push({
          market,
          status: 'unsupported-market',
          registeredMarkets: fetched.unsupportedBy.registeredMarkets,
        });
        continue;
      }
      report.sourceSuccesses += fetched.batches - fetched.failedBatches;
      report.sourceFailures += fetched.failedBatches;

      const written = await this.writeGroup(work, fetched.quotes, target);
      report.updated += written.updated;
      markets.push({
        market,
        status: 'collected',
        target,
        anchors: group.length,
        work: work.length,
        quoted: fetched.quotes.size,
        updated: written.updated,
        batches: fetched.batches,
        failedBatches: fetched.failedBatches,
        failedWrites: written.failed,
      });
    }
    report.markets = markets;
    report.unsupportedMarkets = unsupported;

    this.logger.log(
      `anchor last-close sync: ${JSON.stringify({
        scanned: report.scanned,
        updated: report.updated,
        sourceSuccesses: report.sourceSuccesses,
        sourceFailures: report.sourceFailures,
        unsupported: report.unsupportedMarkets,
      })}`,
    );
    return report;
  }

  /**
   * 单个 market 的批量取价。**逐批独立成败**, 外呼全程在 tx 外 (split-tx)。
   * 「该市场无路由」是配置事实: 一命中即整组降级并跳出剩余批次 (再打只是白烧限频配额)。
   */
  private async fetchGroup(
    market: string,
    work: readonly AnchorLastCloseRef[],
  ): Promise<{
    quotes: Map<string, RealtimeQuote>;
    batches: number;
    failedBatches: number;
    unsupportedBy: RealtimeQuoteMarketUnsupportedError | null;
  }> {
    const quotes = new Map<string, RealtimeQuote>();
    let batches = 0;
    let failedBatches = 0;
    for (const batch of chunk(
      work.map((a) => a.ticker),
      REALTIME_QUOTE_MAX_SYMBOLS,
    )) {
      batches += 1;
      try {
        for (const [symbol, quote] of await this.realtimeQuote.fetchQuotes(batch)) {
          quotes.set(symbol, quote);
        }
      } catch (e) {
        if (e instanceof RealtimeQuoteMarketUnsupportedError) {
          this.logger.log(
            `市场 ${market} 未登记实时源, 本组收盘价不更新 (配置事实, 不计源故障; ` +
              `已登记: ${e.registeredMarkets.join('/') || '无'})`,
          );
          return { quotes, batches, failedBatches, unsupportedBy: e };
        }
        failedBatches += 1;
        this.logger.warn(
          `市场 ${market} 第 ${batches} 批 (${batch.length} 只) 收盘价取价失败: ${describe(e)}`,
        );
      }
    }
    return { quotes, batches, failedBatches, unsupportedBy: null };
  }

  /**
   * 逐锚写两列。**响应里没有的 ticker 直接跳过** —— 保留旧值, 既不写 `null` 也不写 `0`
   * (停牌 / 无成交的 0 哨兵已在 adapter 归一为 null ⇒ 那种行根本不在 Map 里)。
   * 单锚失败只吞该锚, MUST NOT 整批回滚。
   *
   * 🚨 `lastCloseDate` 写的是**目标 session**, 不是 vendor 的 `capturedAt`: 前者是 event time
   * (「这个价属于哪一场」), 后者是 ingestion time (「我们什么时候拿到的」)。拿采集墙钟当
   * session 日, 在跨日界的市场上会整体错一天 —— ADR-0066 四条轴里最常被混的那两条。
   */
  private async writeGroup(
    work: readonly AnchorLastCloseRef[],
    quotes: ReadonlyMap<string, RealtimeQuote>,
    target: string,
  ): Promise<{ updated: number; failed: number }> {
    const lastCloseDate = utcMidnight(target);
    let updated = 0;
    let failed = 0;
    for (const anchor of work) {
      const quote = quotes.get(anchor.ticker);
      if (quote === undefined) continue;
      try {
        await this.prisma.anchor.updateMany({
          where: { id: anchor.id },
          data: { lastClose: new Prisma.Decimal(quote.price), lastCloseDate },
        });
        updated += 1;
      } catch (e) {
        failed += 1;
        this.logger.warn(`锚 ${anchor.ticker} 收盘价写入失败 (保留旧值): ${describe(e)}`);
      }
    }
    return { updated, failed };
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
