import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import {
  changeFromPct,
  computeChange,
  decimalToString,
  fiftyTwoWeekHighLow,
  parseCanonicalSymbol,
} from './marketdata.rules.js';
import { InstrumentNotFoundException } from './instrument-not-found.exception.js';
import type {
  InstrumentDetailResponse,
  InstrumentFinancials,
  InstrumentValuation,
} from './instrument-detail.response.js';

const CORP_ACTION_LIMIT = 20; // 近期公司行动条数 (exDate 降序), 防无界返回。
const FIFTY_TWO_WEEK = 252; // 近一年交易日数 (52 周高低窗口)。

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);
const nullableDateOnly = (d: Date | null): string | null => (d === null ? null : dateOnly(d));

/**
 * 标的详情聚合 use case (015 T008, US3 — intra query, ADR-0043 直注 PrismaService 无 repository)。
 *
 * **读 PG 物化事实**, 不在请求路径打 vendor (摄取由 016 同步管线灌库)。聚合 5 张表最近行:
 * Instrument 身份 + 最近 DailyBar (报价 header, 前收算涨跌) + 近 252 日 (52 周高低) + 最近
 * FundamentalSnapshot (估值/分位) + 最近 FinancialMetric (财报) + 近期 CorporateAction。
 * 未知 symbol (或 canonical 非法) → 404 (InstrumentNotFoundException)。**缺失维度一律 null**
 * (detail field coverage), 不报错。adjust 取 none (D7 原始价口径)。
 */
@Injectable()
export class GetInstrumentDetailUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(symbol: string): Promise<InstrumentDetailResponse> {
    const parsed = parseCanonicalSymbol(symbol);
    if (!parsed) throw new InstrumentNotFoundException(symbol);

    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: parsed.market, code: parsed.code } },
    });
    if (!instrument) throw new InstrumentNotFoundException(symbol);

    const [latestBar, recentBars, fundamental, financial, corpActions] = await Promise.all([
      this.prisma.dailyBar.findFirst({
        where: { instrumentId: instrument.id, adjust: 'none' },
        orderBy: { tradeDate: 'desc' },
      }),
      this.prisma.dailyBar.findMany({
        where: { instrumentId: instrument.id, adjust: 'none' },
        orderBy: { tradeDate: 'desc' },
        take: FIFTY_TWO_WEEK,
        select: { tradeDate: true, close: true },
      }),
      this.prisma.fundamentalSnapshot.findFirst({
        where: { instrumentId: instrument.id },
        orderBy: { date: 'desc' },
      }),
      this.prisma.financialMetric.findFirst({
        where: { instrumentId: instrument.id },
        orderBy: { reportPeriod: 'desc' },
      }),
      this.prisma.corporateAction.findMany({
        where: { instrumentId: instrument.id },
        orderBy: { exDate: 'desc' },
        take: CORP_ACTION_LIMIT,
      }),
    ]);

    // 涨跌取官方涨跌幅反推 (除权日正确); changePct 缺 → 回退相邻前收差。
    const { change, changePct } = !latestBar
      ? { change: null, changePct: null }
      : latestBar.changePct !== null
        ? changeFromPct(latestBar.close, latestBar.changePct)
        : computeChange(latestBar.close, latestBar.prevClose);
    const { high, low } = fiftyTwoWeekHighLow(
      recentBars.map((b) => ({ tradeDate: dateOnly(b.tradeDate), close: b.close })),
    );

    return {
      symbol,
      name: instrument.name,
      type: instrument.type,
      market: instrument.market,
      code: instrument.code,
      currency: instrument.currency,
      status: instrument.status,
      listDate: nullableDateOnly(instrument.listDate),
      delistDate: nullableDateOnly(instrument.delistDate),
      quote: {
        price: latestBar ? decimalToString(latestBar.close) : null,
        change,
        changePct,
        prevClose: latestBar ? decimalToString(latestBar.prevClose) : null,
        asOf: latestBar ? dateOnly(latestBar.tradeDate) : null,
        priceKind: 'eod_close',
        hasData: latestBar !== null,
        fiftyTwoWeekHigh: high,
        fiftyTwoWeekLow: low,
      },
      valuation: fundamental
        ? ({
            date: dateOnly(fundamental.date),
            peTtm: decimalToString(fundamental.peTtm),
            peStatic: decimalToString(fundamental.peStatic),
            peDynamic: decimalToString(fundamental.peDynamic),
            pb: decimalToString(fundamental.pb),
            ps: decimalToString(fundamental.ps),
            dividendYield: decimalToString(fundamental.dividendYield),
            marketCap: decimalToString(fundamental.marketCap),
            circMarketCap: decimalToString(fundamental.circMarketCap),
            pePctlY3: decimalToString(fundamental.pePctlY3),
            pePctlY5: decimalToString(fundamental.pePctlY5),
            pbPctlY3: decimalToString(fundamental.pbPctlY3),
            pbPctlY5: decimalToString(fundamental.pbPctlY5),
          } satisfies InstrumentValuation)
        : null,
      financials: financial
        ? ({
            reportPeriod: financial.reportPeriod,
            roe: decimalToString(financial.roe),
            grossMargin: decimalToString(financial.grossMargin),
            eps: decimalToString(financial.eps),
            bps: decimalToString(financial.bps),
          } satisfies InstrumentFinancials)
        : null,
      corporateActions: corpActions.map((ca) => ({
        exDate: dateOnly(ca.exDate),
        type: ca.type,
        payload: ca.payload,
      })),
    };
  }
}
