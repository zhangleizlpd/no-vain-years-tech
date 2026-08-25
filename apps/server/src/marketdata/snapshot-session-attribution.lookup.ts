import type { PrismaService } from '../security/prisma.service.js';
import { exchangeCalendarDate, sessionWatermark } from './session-clock.js';
import {
  resolveSnapshotAttribution,
  type SnapshotAttribution,
} from './snapshot-session-attribution.rules.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';
import type { SessionKindStatus, TradingDayStatus } from './trading-day.rules.js';

/**
 * {@link resolveSnapshotAttribution} 的 **I/O 伴生层** (#187) —— 判据要的那几个日历事实,
 * 全仓只在这里查一次。
 *
 * ## 它为什么存在: 同一个查询曾有四份
 *
 * `todaySessionKind` / `lastClosedTradingDay` / `tradingDayBefore` 这三个查询在
 * `anchor-cold-start.usecase` / `sync-option-snapshot.usecase` / `option-snapshot-remediation`
 * 里各写过一遍 (最后那份是 PR #183 为了不夹带无关改动**明知故犯**加的第四份, 并在注释里记了债)。
 *
 * 🚨 四份的漂移**不会报错** —— 表现只是「某条路径算出的 `session_date` 悄悄差一天」, 而
 * `option_daily_snapshot` 落库是 `createMany(skipDuplicates)` on `(contract_id, session_date,
 * source)` ⇒ 差一天 = 不可逆的脏行 + 静默挡掉次日的真实采集 (2026-08-25 prod 实撞 2200 行, #181)。
 *
 * ## 分工: 本类只查, 不判
 *
 * 「查到的事实 ⇒ 该归哪一场 / 该不该采」那一步**恒在** `snapshot-session-attribution.rules.ts`
 * 的纯函数里。本类是它的**唯一**取数入口, 自己不做任何日期推导 ——
 * 🚫 **MUST NOT 在这里长出第二个 `if`**: 那就是把刚合并的判据又劈成两半。
 *
 * ## 🚨 为什么不是 Nest provider, 而是各消费方 `new` 出来
 *
 * 它的两个依赖 (`PrismaService` + `TRADING_CALENDAR_PORT`) 是每个消费方**本来就持有**的;
 * 做成 provider 只是把同一对依赖再绕一圈, 却要动全部手工装配点 (15 处 use case 直实例化 +
 * `DimensionExecutorRegistry` 的 74 处按位置传参)。零 class 状态、零生命周期 ⇒ 直接构造。
 */
export class SnapshotSessionAttributionLookup {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: TradingCalendarPort,
  ) {}

  /**
   * 查齐日历事实 → 交给纯函数定夺。**单市场**入口 (盘中闸问的是「**这个市场**的这一场收了没」,
   * 混 scope 没有单一答案)。
   *
   * 复杂度: 3 次索引点查 (每轮一次, 与工作集大小无关)。
   */
  async resolve(market: string, now: Date): Promise<SnapshotAttribution> {
    const todayKind = await this.todaySessionKind(market, now);
    const target = await this.lastClosedTradingDay(market, now, todayKind);
    return resolveSnapshotAttribution({
      market,
      now,
      lastClosedTradingDay: target,
      todayIsTradingDay: (await this.classifyToday(market, now)) === 'trading',
      tradingDayBeforeTarget:
        target === null ? null : await this.tradingDayBefore([market], target),
      todayKind,
    });
  }

  /**
   * 交易所当地**今天**的交易日三态 (062 T006)。
   *
   * ⚠️ 走 `TRADING_CALENDAR_PORT` 而非直查 `trading_day`: 三态里的 `unknown`(「日历还没填到
   * 这儿」) 要靠**覆盖声明**才判得出来, 而裸表查询只能给「有行 / 无行」的二态 —— 那正是 062
   * 在消灭的 closed-world assumption。消费方对 `unknown` 的处置按调用点语义分派, 本方法不折叠。
   *
   * 复杂度: 端口内部 O(1)。
   */
  async classifyToday(market: string, now: Date): Promise<TradingDayStatus> {
    return this.calendar.classify(market, exchangeCalendarDate(market, now));
  }

  /** 今天在 `trading_day` 里登记的 session 形态 (半日市收盘提前); 无行 ⇒ `unknown`。O(1) 点查。 */
  async todaySessionKind(market: string, now: Date): Promise<SessionKindStatus> {
    const row = await this.prisma.tradingDay.findUnique({
      where: {
        market_date: { market, date: new Date(`${exchangeCalendarDate(market, now)}T00:00:00Z`) },
      },
      select: { sessionKind: true },
    });
    return (row?.sessionKind ?? 'unknown') as SessionKindStatus;
  }

  /**
   * `trading_day` 中 ≤「已收盘 session 日期上界」的**最大交易日**; 缺行返 `null`。
   *
   * ⚠️ **蓄意不走 `TradingCalendarPort.lastClosedSession`**: 本查询要 fail-closed (缺行就是
   * `null`, 交由调用方放弃不猜), 而端口那侧各消费点统一把「基准不可判定」映射到**放行**侧。
   * 两条极性服务两类问题, 合并会让「日历真缺行」这件事在写路径上被静默放行。
   *
   * 复杂度: 1 次 `(market, date)` 索引上的倒序 limit-1 查询。
   */
  async lastClosedTradingDay(
    market: string,
    now: Date,
    todayKind: SessionKindStatus,
  ): Promise<string | null> {
    const row = await this.prisma.tradingDay.findFirst({
      where: {
        market,
        date: { lte: new Date(`${sessionWatermark(market, now, todayKind)}T00:00:00Z`) },
      },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return row === null ? null : row.date.toISOString().slice(0, 10);
  }

  /**
   * 某日的**上一个**交易日 (严格早于); 缺更早的行返 `null`。
   *
   * 收 `marketScope` 而非单个 market: `SyncOptionSnapshotUseCase.collect` 的 `spec.marketScope`
   * 本就是数组, 收窄成单值会在调用点悄悄丢掉一个市场。复杂度 1 次索引倒序 limit-1 查询。
   */
  async tradingDayBefore(marketScope: readonly string[], date: string): Promise<string | null> {
    const row = await this.prisma.tradingDay.findFirst({
      where: { market: { in: [...marketScope] }, date: { lt: new Date(`${date}T00:00:00Z`) } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return row === null ? null : row.date.toISOString().slice(0, 10);
  }
}
