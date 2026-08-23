import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { exchangeCalendarDate } from '../marketdata/session-clock';
import {
  REALTIME_QUOTE_MAX_SYMBOLS,
  REALTIME_QUOTE_PORT,
  RealtimeQuoteMarketUnsupportedError,
  type RealtimeQuote,
  type RealtimeQuotePort,
} from '../marketdata/realtime-quote.port';
import {
  MARKET_STATE_PORT,
  type MarketSession,
  type MarketStatePort,
} from '../marketdata/market-state.port';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';
import { parseAnchorTicker } from './anchor.rules';

/**
 * 061 — 锚的**盘中价投影 tick** (FR-004 / FR-005 / FR-011 / FR-017, plan D1/D6)。
 * 一拍 = 一次求值: 两闸取交集 → 按 market 分批外呼 → 逐锚写自有两列。
 *
 * 🚨 **按锚的 market 分组求值, 两个闸逐 market 判** (FR-004)。本片的分组里只有 `us` 一个键,
 * 但结构从第一天就是多市场的 —— **蓄意不照抄** `alert/intraday-eval.processor.ts` 的
 * `INTRADAY_MARKET = 'cn'` 硬编码单市场形态 (那个文件自己的注释就写着「接第二个市场时改这里」)。
 * 写成分组形态是**零额外成本**的: 后续接港股只多一个键, 不改结构。
 *
 * 🚨 **两闸取交集, 交易日闸 MUST NOT 被市场状态顶替** (FR-011 / 062 FR-014): vendor 状态答
 * 「现在开不开」, 交易日历答「今天是不是交易日」。源侧状态机会滞后 —— 「状态说开市但当天其实
 * 是节假日」是 spec 明列的 Edge Case, 靠交易日闸兜。两条判据量纲不同, 谁也替不了谁。
 *
 * 🚨 **交易日闸是三态, 不是布尔** (062 T008): 走 `TRADING_CALENDAR_PORT` 拿
 * `trading` / `non-trading` / `unknown`, 只有 `non-trading` 才跳过。**`unknown` 继续采** ——
 * 它说的是「日历还没填到今天」而不是「今天不是交易日」, 把两者折成一个布尔正是 062 要消灭的
 * 病根 (盘中价在 `trading_day` 当日行落库之前一拍都不采)。多采一轮的代价由上面那条 vendor
 * 状态闸兜着; 反过来「不知道就不采」的代价是**每天开盘前整段静默停摆**。
 * 留痕落在 {@link MarketIntradayOutcome} 的 `calendar` 上 (FR-013), 不只在日志里。
 *
 * 🚨🚨 **「该市场没接实时源」是配置事实, 不是故障** (Guardrail 16, spec `state_branch` 14):
 * 逐组独立 try/catch, 捕到 {@link RealtimeQuoteMarketUnsupportedError} 落显式降级 + 一条日志,
 * 并在报告里与源故障**分列两个计数** ({@link SyncAnchorIntradayReport.unsupportedMarkets} vs
 * {@link SyncAnchorIntradayReport.sourceFailures})。混成一个计数是**今天就会发生**的故障:
 * `anchor-import.rules.ts` 的 `IMPORTABLE_MARKETS = ['us', 'hk']` ⇒ hk 锚合法且随时可建, 只要
 * 库里有一只, failstreak 每 30 秒 +1、90 秒后 circuit open, 把 us 一起降级 —— 而 us 的源正常。
 * 熔断侧的裁决口径单点在 {@link classifyTickSource}。
 *
 * ⚠️ 066 T10 起 hk **已接上**实时源 (live 档路由 = us + hk), 这条分支现役的对象是 cn
 * (实时源仍挂在 `alert/`) 与不成形的 ticker —— 上面那段是它当初存在的理由, 不是现状清单。
 *
 * 🚨 **切批是调用方的事** (Guardrail 17): 按 {@link REALTIME_QUOTE_MAX_SYMBOLS} 切、**逐批独立
 * 成败** (一批失败不拖垮其余, 与 FR-017 部分失败语义同一条)。adapter 侧只做超限前置拒绝,
 * 同一段边界逻辑写两遍必漂移。
 *
 * 🚨 **split-tx**: 一次外呼取整批、**全程在 tx 外**, NEVER 在 tx 内等 HTTP。落库逐锚独立
 * (`updateMany where {id}` 幂等覆盖 —— 无状态转换前置条件, 不需要 affected-count 裁决),
 * 单锚失败不回滚同批其余 (spec `state_branch` 8)。
 *
 * 🚨 **只写自有两列**, 且**两列不入 `anchor_change` 痕迹表** —— 同 `last_close` 的既有规矩
 * (`sync-anchor-quote.ts` 文件头)。每 30 秒一条行情噪声灌进痕迹会把 PIT 回放淹没。
 *
 * 🚨 **部分标的缺失 → 保留旧值**: 响应里没有的 ticker 一律跳过, 既不写 `null` 也不写 `0`
 * (spec `state_branch` 7)。0 在距 W% 里是个有意义的强信号, 拿它表达「没数据」会被读反。
 *
 * 调度 / 熔断 / mock 闸 / 收盘补一拍的**触发侧**在 `sync-anchor-intraday.scheduler.ts`；
 * 本文件只负责「这一拍该采什么、采到了写哪儿」, 不持有任何跨拍状态。
 */

/**
 * 本组**为什么**过了交易日闸 (062 T008, FR-013)。
 *
 * 🚨 `confirmed` 与 `unknown` **必须可分辨**: 「采是因为确认了是交易日」与「采是因为还不知道」
 * 若在报告里长得一样, 下次同类故障照样查不出 —— 等于没修。
 */
export type AnchorIntradayCalendarBasis = 'confirmed' | 'unknown';

/** 一个 market 在本拍的处置。**五态互斥**, 供 IT 断言与排障。 */
export type MarketIntradayOutcome =
  | {
      market: string;
      /** 两闸之一没过: 非常规时段 (含未知状态)。0 次源调用。 */
      status: 'skipped-session';
      session: MarketSession;
    }
  | {
      market: string;
      /** 状态说开市但当天非交易日 (两闸取交集的下半条)。0 次源调用。 */
      status: 'skipped-holiday';
      /** 该市场当地的业务日期 (`YYYY-MM-DD`)。 */
      date: string;
    }
  | {
      market: string;
      /** 🚨 **配置事实**: 该市场未登记实时源。MUST NOT 计入熔断。 */
      status: 'unsupported-market';
      registeredMarkets: readonly string[];
    }
  | {
      market: string;
      status: 'collected';
      /**
       * 本组过交易日闸的**判据来源** (FR-013)。`unknown` = 日历视野还没填到该业务日,
       * 本拍是「不知道所以照采」—— 与 `confirmed` 事后必须分得出。
       */
      calendar: AnchorIntradayCalendarBasis;
      /** 本组锚数 / 采到报价的锚数 / 真正落库的锚数。 */
      anchors: number;
      quoted: number;
      updated: number;
      /** 切了几批 / 其中几批是**源故障** (超限前置拒绝、隧道断等)。 */
      batches: number;
      failedBatches: number;
      /** 写库时逐锚失败的只数 (不进熔断: 那是我们自己的库, 不是行情源)。 */
      failedWrites: number;
      /** 本拍是否为收盘补一拍 (FR-005) —— 时段闸没过但仍然采了。 */
      forced: boolean;
    };

export interface SyncAnchorIntradayReport {
  /**
   * 本拍观测到的各市场时段。**状态不可得 ⇒ `null`** —— 调用方据此**不更新**上一拍状态,
   * 否则一次源抖动会把「离开白名单」这个只发生一次的沿吞掉 (收盘补一拍随之丢失)。
   */
  sessions: Readonly<Record<string, MarketSession>> | null;
  /** 逐 market 处置 (分组顺序 = 锚表返回顺序里各市场的首现序)。 */
  markets: readonly MarketIntradayOutcome[];
  /** **真·源故障**批次数 (含「状态不可得」那一整拍) —— 熔断的唯一计数口径。 */
  sourceFailures: number;
  /** 成功批次数。 */
  sourceSuccesses: number;
  /** 🚨 无实时源路由的 market —— **配置事实**, MUST NOT 计入熔断 (Guardrail 16)。 */
  unsupportedMarkets: readonly string[];
  /** 本拍扫过的锚数。 */
  scanned: number;
  /** 真正落了 UPDATE 的锚数。 */
  updated: number;
}

export interface SyncAnchorIntradayOptions {
  /**
   * **上一拍**观测到的各市场时段 (由调用方跨拍留痕, 见 scheduler 的 Redis 键)。
   * 收盘补一拍 (FR-005) 的判据由它与本拍状态共同决定, 见 {@link marketsNeedingClosingTick}。
   */
  previousSessions?: Readonly<Record<string, MarketSession>> | null;
}

/** 本拍对**行情源**的裁决 (熔断只认这一个口径)。 */
export type TickSourceVerdict = 'success' | 'failure' | 'no-attempt';

/**
 * 🚨 **熔断口径单点** (Guardrail 16 / spec `state_branch` 9 & 14)。
 *
 * - 有任何一批成功 ⇒ `success`。判据是 spec 原文的「连续 3 轮采集**全部失败**」, 故同拍里
 *   混着失败批次也算成功轮 —— 部分失败已由 {@link SyncAnchorIntradayReport} 的计数留痕。
 * - 一次成功都没有但有真源故障 ⇒ `failure`。
 * - **一次源调用都没发生** (全被两闸挡下 / 全是无路由市场) ⇒ `no-attempt`: 既不计失败也不
 *   清计数。**这一条是那颗回归钉** —— 库里只有无路由市场的锚时每拍都落这里, 连跑一天 circuit
 *   也不该开。
 *
 * O(1) 纯函数。
 */
export function classifyTickSource(report: SyncAnchorIntradayReport): TickSourceVerdict {
  if (report.sourceSuccesses > 0) return 'success';
  if (report.sourceFailures > 0) return 'failure';
  return 'no-attempt';
}

/**
 * 收盘补一拍 (FR-005 / spec `state_branch` 6) 的判据: **上一拍在白名单内 ∧ 本拍不在**。
 *
 * 只在**离开**白名单的那一次成立 —— 用「本拍不在白名单」当判据会变成全天采集, 用「上一拍在
 * 白名单」当判据则永远补不到最后那一拍。无上一拍状态 (进程刚起 / 状态曾不可得) ⇒ 不补, 不猜。
 *
 * O(本拍市场数) 纯函数。
 */
export function marketsNeedingClosingTick(
  previous: Readonly<Record<string, MarketSession>> | null | undefined,
  current: Readonly<Record<string, MarketSession>>,
): string[] {
  if (previous === null || previous === undefined) return [];
  return Object.keys(current).filter(
    (market) => previous[market] === 'regular' && current[market] !== 'regular',
  );
}

/** 投影只需要这 2 列 (id 定位 + ticker 寻址; 两列现值不参与判断 —— 幂等覆盖写)。 */
interface AnchorIntradayRef {
  id: bigint;
  ticker: string;
}

/** 按上限切批。O(n)。 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

@Injectable()
export class SyncAnchorIntradayUseCase {
  private readonly logger = new Logger(SyncAnchorIntradayUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: 注入 marketdata 的实时报价端口 (port token + interface, 非 use case
    // —— catalog Q7-C 放行判据见 plan D1)。强一致同步读: 本拍的价必须在本拍拿到, 落表已来不及
    // (ADR-0062 sunset #1 自己规定的升格方向就是这个)。方向仍单向: marketdata 对锚表零感知。
    @Inject(REALTIME_QUOTE_PORT) private readonly realtimeQuote: RealtimeQuotePort,
    // CROSS-CONTEXT-SYNC: 注入 marketdata 的市场时段端口 (同上, port token + interface)。
    // vendor 原始状态串不出对方 adapter, 本 ctx 只见归一后的三态 —— 值域知识不复制过来。
    @Inject(MARKET_STATE_PORT) private readonly marketState: MarketStatePort,
    // CROSS-CONTEXT-SYNC: 注入 marketdata 的交易日历读端口 (062 T008; 同上, port token +
    // interface)。**取代**此前对 `marketdata.trading_day` 的裸 Prisma 直查 —— 直查读到的是
    // 「有没有行」这个原始事实, 而判「今天是不是交易日」还需要「日历填到哪儿了」, 判据本体归
    // 属方 (marketdata) 拿。同步读: 本拍的闸必须在本拍判完。方向仍单向: marketdata 对锚表零感知。
    @Inject(TRADING_CALENDAR_PORT) private readonly tradingCalendar: TradingCalendarPort,
  ) {}

  /**
   * 一拍投影。复杂度: O(锚数) 次写 + O(市场数) 次交易日判定 + O(ceil(锚数/400)) 次外呼。
   *
   * @param now 注入时钟 (测试可控; 生产取 `new Date()`)。
   */
  async execute(
    now: Date = new Date(),
    options: SyncAnchorIntradayOptions = {},
  ): Promise<SyncAnchorIntradayReport> {
    const report: {
      -readonly [K in keyof SyncAnchorIntradayReport]: SyncAnchorIntradayReport[K];
    } = {
      sessions: null,
      markets: [],
      sourceFailures: 0,
      sourceSuccesses: 0,
      unsupportedMarkets: [],
      scanned: 0,
      updated: 0,
    };

    let sessions: Record<string, MarketSession>;
    try {
      const states = await this.marketState.getMarketSessions();
      sessions = Object.fromEntries(states.map((s) => [s.market, s.session]));
    } catch (e) {
      // fail-closed (spec `state_branch` 4): 状态不可得 ≠ 闭市, 它是**源故障** —— 计入熔断,
      // 但一次报价调用都不发 (不知道开没开市就采, 等于把白名单判据作废)。
      this.logger.warn(`市场状态不可得, 本拍 fail-closed 停采: ${describe(e)}`);
      report.sourceFailures = 1;
      return report;
    }
    report.sessions = sessions;

    const forceMarkets = new Set(marketsNeedingClosingTick(options.previousSessions, sessions));

    const anchors = (await this.prisma.anchor.findMany({
      select: { id: true, ticker: true },
    })) as AnchorIntradayRef[];
    report.scanned = anchors.length;

    const markets: MarketIntradayOutcome[] = [];
    const unsupported: string[] = [];
    for (const [market, group] of groupByMarket(anchors)) {
      const session = sessions[market] ?? 'unknown';
      const forced = forceMarkets.has(market);
      if (session !== 'regular' && !forced) {
        markets.push({ market, status: 'skipped-session', session });
        continue;
      }

      // 交易日闸 —— 与市场状态闸**取交集**, 且补一拍也不放开 (FR-011)。日期按**交易所时区**
      // 求, 不是宿主时区: us 的常规时段横跨北京日界, 用宿主日期会在后半段整体错一天。
      const date = exchangeCalendarDate(market, now);
      const calendarStatus = await this.tradingCalendar.classify(market, date);
      if (calendarStatus === 'non-trading') {
        // 日历已填过这一段、当日确实非交易日 ⇒ 0 次源调用 (既有语义)。
        markets.push({ market, status: 'skipped-holiday', date });
        continue;
      }
      // 🚨 `unknown` 落在**放行侧**: 「还没填到这儿」不是「不是交易日」。这一行写成
      // `!== 'trading'` 就是把 062 修掉的病原样犯回去 —— 且生产里它会静默地每天犯一次。
      const calendar: AnchorIntradayCalendarBasis =
        calendarStatus === 'trading' ? 'confirmed' : 'unknown';
      if (calendar === 'unknown') {
        this.logger.warn(
          `市场 ${market} 的交易日历视野未覆盖 ${date} — 本拍按「未知」照常采集 ` +
            `(FR-012; 时段闸仍独立生效)`,
        );
      }

      const fetched = await this.fetchGroup(market, group);
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

      const written = await this.writeGroup(group, fetched.quotes);
      report.updated += written.updated;
      markets.push({
        market,
        status: 'collected',
        calendar,
        anchors: group.length,
        quoted: fetched.quotes.size,
        updated: written.updated,
        batches: fetched.batches,
        failedBatches: fetched.failedBatches,
        failedWrites: written.failed,
        forced,
      });
    }
    report.markets = markets;
    report.unsupportedMarkets = unsupported;

    this.logger.log(
      `anchor intraday tick: ${JSON.stringify({
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
   * 单个 market 的批量取价。**逐批独立成败** (Guardrail 17), 外呼全程在 tx 外 (split-tx)。
   *
   * 「该市场无路由」是配置事实: 一旦命中即整组降级并**跳出**剩余批次 —— 同组其余批必然同样
   * 无路由, 再打一次只是白烧一次限频配额。
   */
  private async fetchGroup(
    market: string,
    group: readonly AnchorIntradayRef[],
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
      group.map((a) => a.ticker),
      REALTIME_QUOTE_MAX_SYMBOLS,
    )) {
      batches += 1;
      try {
        for (const [symbol, quote] of await this.realtimeQuote.fetchQuotes(batch)) {
          quotes.set(symbol, quote);
        }
      } catch (e) {
        if (e instanceof RealtimeQuoteMarketUnsupportedError) {
          // 🚨 显式降级 + 一条日志, **不进任何失败计数** —— 它说的是「我们没给这个市场接源」,
          // 与「接了但调不通」是两件事 (Guardrail 16)。该市场的锚就此恒为收盘档。
          this.logger.log(
            `市场 ${market} 未登记实时源, 本组显式降级为收盘档 (配置事实, 不计熔断; ` +
              `已登记: ${e.registeredMarkets.join('/') || '无'})`,
          );
          return { quotes, batches, failedBatches, unsupportedBy: e };
        }
        failedBatches += 1;
        this.logger.warn(
          `市场 ${market} 第 ${batches} 批 (${batch.length} 只) 取价失败: ${describe(e)}`,
        );
      }
    }
    return { quotes, batches, failedBatches, unsupportedBy: null };
  }

  /**
   * 逐锚写自有两列。**响应里没有的 ticker 直接跳过** —— 保留旧值, 既不写 `null` 也不写 `0`。
   * 单锚失败只吞该锚 (spec `state_branch` 8: MUST NOT 整批回滚)。
   */
  private async writeGroup(
    group: readonly AnchorIntradayRef[],
    quotes: ReadonlyMap<string, RealtimeQuote>,
  ): Promise<{ updated: number; failed: number }> {
    let updated = 0;
    let failed = 0;
    for (const anchor of group) {
      const quote = quotes.get(anchor.ticker);
      if (quote === undefined) continue;
      try {
        await this.prisma.anchor.updateMany({
          where: { id: anchor.id },
          data: {
            intradayPrice: new Prisma.Decimal(quote.price),
            intradayAt: quote.capturedAt,
            // 证据列: vendor 说这个价是什么时候的; 源没给 → null (不阻断这一拍)。
            intradayVendorUpdateTime: quote.vendorUpdateTime,
          },
        });
        updated += 1;
      } catch (e) {
        failed += 1;
        this.logger.warn(`锚 ${anchor.ticker} 盘中价写入失败 (保留旧值): ${describe(e)}`);
      }
    }
    return { updated, failed };
  }
}

/**
 * 锚按 market 分组。**不成形的 ticker 归空串这一组** —— 它在任何一拍都拿不到 session
 * (⇒ 恒 `unknown` ⇒ 恒被时段闸挡下), 于是走同一条 fail-closed 路径, 不需要第二条分支,
 * 也**不猜**它属于哪个市场 (与 `sync-anchor-quote.ts` 对非法 ticker 的处置同向)。O(n)。
 */
function groupByMarket(anchors: readonly AnchorIntradayRef[]): Map<string, AnchorIntradayRef[]> {
  const groups = new Map<string, AnchorIntradayRef[]>();
  for (const anchor of anchors) {
    const market = parseAnchorTicker(anchor.ticker)?.market ?? '';
    const group = groups.get(market);
    if (group === undefined) groups.set(market, [anchor]);
    else group.push(anchor);
  }
  return groups;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
