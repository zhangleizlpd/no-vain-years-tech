import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import {
  aggregateBars,
  decimalToString,
  officialPrevClose,
  parseCanonicalSymbol,
} from './marketdata.rules.js';
import { deriveAdjustedBars, type AdjustableBarRow } from './adjusted-bars.rules.js';
import { InstrumentNotFoundException } from './instrument-not-found.exception.js';
import { freshnessTier } from './freshness-tier.js';
import { lastClosedSessionCutoff } from './trading-day-gate.js';
import type { Adjust, BarPeriod, EodBarPoint } from './marketdata.types.js';
import type { DailyBarListResponse } from './daily-bar-list.response.js';

export interface GetInstrumentBarsQuery {
  symbol: string;
  adjust: Adjust;
  period: BarPeriod;
  from?: string; // YYYY-MM-DD (含)
  to?: string; // YYYY-MM-DD (含)
}

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * K线序列 use case (015 T008, US3 — intra query, ADR-0043 直注 PrismaService)。
 *
 * 读 PG DailyBar **none 行** (可选 tradeDate 区间) 升序; `adjust=none` 直透 (零换算开销,
 * 与历史行为逐字节一致, 020 SC-A04); forward/backward 不再读物化行 — 加载该标的全部因子
 * 跃变版本 (行数 = 除权次数, 极小) 经 adjusted-bars.rules 读时换算 (020 T003, FR-A03)。
 * 换算后按 period 经 marketdata.rules.aggregateBars 聚合 (先日线换算后聚合, day 原样)。
 * 未知 symbol → 404。空区间 → 空 items (200, 非 5xx)。adjust/period 合法性在 controller
 * 校验 (非法 → 400), UC 信任入参枚举。
 */
@Injectable()
export class GetInstrumentBarsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetInstrumentBarsQuery): Promise<DailyBarListResponse> {
    const parsed = parseCanonicalSymbol(query.symbol);
    if (!parsed) throw new InstrumentNotFoundException(query.symbol);

    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: parsed.market, code: parsed.code } },
      select: { id: true },
    });
    if (!instrument) throw new InstrumentNotFoundException(query.symbol);

    const tradeDate =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}),
            ...(query.to ? { lte: new Date(`${query.to}T00:00:00Z`) } : {}),
          }
        : undefined;

    const rows = await this.prisma.dailyBar.findMany({
      where: {
        instrumentId: instrument.id,
        adjust: 'none', // 020: 单口径事实表 — forward/backward 由 none 读时换算 (FR-A01/A03)。
        ...(tradeDate ? { tradeDate } : {}),
      },
      orderBy: { tradeDate: 'asc' },
    });

    let bars: AdjustableBarRow[] = rows.map((r) => ({
      tradeDate: dateOnly(r.tradeDate),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      changePct: r.changePct,
      prevClose: r.prevClose,
      volume: r.volume,
      amount: r.amount,
      turnoverRate: r.turnoverRate,
    }));
    if (query.adjust !== 'none') {
      const versions = await this.prisma.adjustmentFactor.findMany({
        where: { instrumentId: instrument.id },
        select: { exDate: true, factorBackward: true },
      });
      bars = deriveAdjustedBars(
        bars,
        versions.map((v) => ({ exDate: dateOnly(v.exDate), factorJump: v.factorBackward })),
        query.adjust,
      );
    }

    // OHLC / 前收 / 换手率 = 价格量纲 4dp; volume(整数) / amount(2dp) 用自然 toString 保留原标度
    // (与 aggregateBars 的 decAdd toString 求和口径一致, 避免日线 4dp 与聚合 toString 漂移)。
    const points: EodBarPoint[] = bars.map((b) => ({
      tradeDate: b.tradeDate,
      adjust: query.adjust,
      open: decimalToString(b.open),
      high: decimalToString(b.high),
      low: decimalToString(b.low),
      close: decimalToString(b.close),
      // changePct 百分数 (复权不变量, 不走 4dp 价格量纲): null 透传, 非 null 保 4 位。
      changePct: b.changePct === null ? null : b.changePct.toFixed(4),
      // stored 优先, 缺则由官方 changePct 反推 (与详情 quote 同源)。在 aggregateBars 之前
      // 落定: day 原样透传本值, week/month 桶首取本值 (与其内部同一 officialPrevClose 口径)。
      prevClose: decimalToString(officialPrevClose(b.close, b.prevClose, b.changePct)),
      volume: b.volume === null ? null : b.volume.toString(),
      amount: b.amount === null ? null : b.amount.toString(),
      turnoverRate: decimalToString(b.turnoverRate),
    }));

    const items = aggregateBars(points, query.period);
    // 序列自身的 asOf = 末根 bar 的交易日 (聚合周期下是桶内末交易日)。
    const asOf =
      items.length === 0 ? null : (items[items.length - 1] as { tradeDate: string }).tradeDate;
    return {
      symbol: query.symbol,
      adjust: query.adjust,
      period: query.period,
      items,
      freshnessTier: freshnessTier(asOf, await this.lastClosedSession(parsed.market)),
    };
  }

  /**
   * 该市场「最近一个已收盘交易日」(判据基准, 见 {@link freshnessTier})。日历无行 ⇒ `null`
   * ⇒ fail-open 判当期, 与 `db-trading-calendar.adapter.ts` 近窗零行时的 fail-open 同向。
   *
   * ⚠️ optionsdesk 侧有一份形态相同的读 (`last-closed-session.ts`, 挂 `CROSS-CONTEXT-READ`)。
   * **不合并**: 那是跨 ctx 只读逃生口, 合并等于让 optionsdesk 经 marketdata 的函数无痕读表,
   * 护城河探针就再也看不见这条边。共用的是**纯判据**, 不是读路径。
   */
  private async lastClosedSession(market: string): Promise<string | null> {
    const row = await this.prisma.tradingDay.findFirst({
      where: {
        market,
        date: { lte: new Date(`${lastClosedSessionCutoff(market, new Date())}T00:00:00.000Z`) },
      },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return row === null ? null : row.date.toISOString().slice(0, 10);
  }
}
