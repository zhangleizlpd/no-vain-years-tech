import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';
import {
  classifyTradingDay,
  isWithinCoverage,
  type CalendarCoverageRange,
  type TradingDayStatus,
} from './trading-day.rules.js';
import { sessionWatermark } from './session-clock.js';

/**
 * 表驱动交易日历 adapter (sync-1 S1-T3, TRADING_CALENDAR_PORT live 实现)。**去理杏仁化**:
 * 不再每次 gate 现打理杏仁付费指数 candlestick (403 打挂), 改读 `trading_day` 表 (由
 * TradingCalendarSyncService 每日 populate + seed CLI 历史填充)。
 *
 * **三态判定** (062 T006, FR-010): 本 adapter 只负责取**两个事实** —— 「该 (market,date) 有没有
 * 行」与「该市场的覆盖声明是什么」—— 再喂给 `trading-day.rules.ts` 的纯函数
 * {@link classifyTradingDay}。判据本体**不在这里**: 它同时被 `alert` ctx 直查后复用
 * (ADR-0053 `marketdata-rules` 放行边), 两处各写一份必漂移。
 *
 * 🚨 **旧的「近 30 日整窗零行 ⇒ fail-open `true`」判据已整体删除** (062 T006)。它想表达的是
 * 「表还没填过, 别静默停摆整管线」—— 那个意图**没有变**, 只是表达方式换了: 「没填到这儿」现在
 * 由**覆盖声明缺行**精确表达 (`unknown`), 而不再靠「近窗有没有别的行」这种近似反推。近似的代价
 * 是它答不了「填过但只填到上周」这类真实形态 (窗内有行 ⇒ 判 `false` ⇒ 今天被读成休市)。
 *
 * 🚨 **调用点必须把 `unknown` 映射到放行侧** (`!== 'non-trading'`, Impl Guardrail 1): 写成
 * `=== 'trading'` 会让上线首刻 (声明表刚建、尚未灌值 ⇒ 全 `unknown`) 全体消费方判「今天不是
 * 交易日」而整体停摆 —— 且生产里从不出现的分支意味着**没有任何测试会红**。
 */
@Injectable()
export class DbTradingCalendarAdapter implements TradingCalendarPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 复杂度: 2 次主键/唯一索引点查 (并发发出)。
   *
   * ⚠️ **有行也照样取声明** —— 不为「有行就短路」省这一次点查: 判据的优先级 (实证压承诺) 是
   * `classifyTradingDay` 的语义, 在这里提前短路等于把判据抄第二份。
   */
  async classify(market: string, date: string): Promise<TradingDayStatus> {
    const target = new Date(`${date}T00:00:00Z`);
    const [exact, row] = await Promise.all([
      this.prisma.tradingDay.count({ where: { market, date: target } }),
      this.prisma.calendarCoverage.findUnique({ where: { market } }),
    ]);
    const coverage: CalendarCoverageRange | null =
      row === null
        ? null
        : {
            from: row.coveredFrom.toISOString().slice(0, 10),
            to: row.coveredTo.toISOString().slice(0, 10),
          };
    return classifyTradingDay({ hasExactRow: exact > 0, coverage, date });
  }

  /**
   * 最近一场已收盘交易日（062 T010, `state_branch` 9）。收盘上界由纯函数
   * {@link sessionWatermark} 按**交易所时区**求，本方法只负责取数与可信度闸。
   *
   * 🚨 **上界落在覆盖声明之外 ⇒ 返 `null`，MUST NOT 交回那个「最大交易日」**：那一段根本
   * 没填全，库里的最大值只是「填到哪儿」而不是「最近一场是哪天」。交回它 = 拿一个不可信的
   * 基准日去判陈旧 —— 表现是档位悄悄错一档（数据其实是新的却被判陈旧，或反之），**不报错**。
   * 这正是 062 之前 cn/hk 在北京 15:00–21:00 窗口内陈旧度偏乐观的同构成因。
   *
   * 复杂度: 2 次索引查询（并发发出；一次唯一索引点查 + 一次 `(market,date)` 上的倒序 limit-1）。
   */
  async lastClosedSession(market: string, now: Date): Promise<string | null> {
    // 🚨 **蓄意传 `'unknown'`** (063 Phase 2): 本方法是**陈旧度判定基准**的来源。接了半日市
    // 之后, 半日市当天 12:00 一过基准就跳到今天, 而夜间管线要到北京 21:00/04:00 才落库 ⇒ 界面
    // 会连着 9 小时显示「陈旧」。那是**事实**没错, 但它把一个一年 5 天的边角变成了肉眼可见的
    // 退化, 而收益 (早几小时判出陈旧) 近乎为零。要改先想清楚这笔交换, 别顺手接上。
    const cutoff = sessionWatermark(market, now, 'unknown');
    const [coverageRow, dayRow] = await Promise.all([
      this.prisma.calendarCoverage.findUnique({ where: { market } }),
      this.prisma.tradingDay.findFirst({
        where: { market, date: { lte: new Date(`${cutoff}T00:00:00Z`) } },
        orderBy: { date: 'desc' },
        select: { date: true },
      }),
    ]);
    const coverage: CalendarCoverageRange | null =
      coverageRow === null
        ? null
        : {
            from: coverageRow.coveredFrom.toISOString().slice(0, 10),
            to: coverageRow.coveredTo.toISOString().slice(0, 10),
          };
    if (!isWithinCoverage(coverage, cutoff)) return null;
    return dayRow === null ? null : dayRow.date.toISOString().slice(0, 10);
  }

  /**
   * 严格早于 `date` 的最近一个交易日 (072)。语义与不可判定口径见端口注释。
   *
   * 🚨 覆盖闸判的是 **`date` 本身**在不在声明区间内, 而不是查出来那一行:
   * `date` 若落在声明之外 (含「声明表还没建」), 「比它早的最大交易日」只反映**填到哪儿**,
   * 不是真的前一场 ⇒ 必须返 `null`。这与 {@link lastClosedSession} 拿 cutoff 判是同一条判据。
   *
   * 复杂度: 2 次索引查询 (并发; 一次唯一索引点查 + 一次 `(market,date)` 倒序 limit-1)。
   */
  async previousTradingDay(market: string, date: string): Promise<string | null> {
    const [coverageRow, dayRow] = await Promise.all([
      this.prisma.calendarCoverage.findUnique({ where: { market } }),
      this.prisma.tradingDay.findFirst({
        // lt 而非 lte —— 端口契约是「严格早于」。
        where: { market, date: { lt: new Date(`${date}T00:00:00Z`) } },
        orderBy: { date: 'desc' },
        select: { date: true },
      }),
    ]);
    const coverage: CalendarCoverageRange | null =
      coverageRow === null
        ? null
        : {
            from: coverageRow.coveredFrom.toISOString().slice(0, 10),
            to: coverageRow.coveredTo.toISOString().slice(0, 10),
          };
    if (!isWithinCoverage(coverage, date)) return null;
    return dayRow === null ? null : dayRow.date.toISOString().slice(0, 10);
  }
}
