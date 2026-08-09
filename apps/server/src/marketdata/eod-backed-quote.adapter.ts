import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import type { QuotePort } from './quote.port.js';
import type { QuoteSnapshot } from './marketdata.types.js';
import {
  changeFromPct,
  computeChange,
  decimalToString,
  parseCanonicalSymbol,
} from './marketdata.rules.js';

/**
 * EOD-backed 报价 adapter (015 T007, QUOTE_PORT live 实现, FR-S07 / US4)。
 *
 * V1 无实时源 → 报价由 **PG DailyBar 最近收盘价** 支撑 (priceKind=eod_close), 前收算涨跌,
 * asOf=该日线 tradeDate 显式标注新鲜度。读 PG **不在请求路径打理杏仁** (摄取由 016 同步管线
 * 灌库)。adjust 取 `none` (D7 原始价口径)。
 *
 * 无任何 DailyBar 的标的 (含未注册 / 未知 symbol) → 显式 no-data (`hasData:false`, 全字段
 * null), **不崩、不返 0、不伪造**, 且单项 no-data 不污染同批其余项 (逐 symbol 独立投影)。
 * 实时源接入只翻 priceKind, 消费者零改 (ADR-0047 seam)。
 */
@Injectable()
export class EodBackedQuoteAdapter implements QuotePort {
  constructor(private readonly prisma: PrismaService) {}

  async getQuotes(symbols: string[]): Promise<QuoteSnapshot[]> {
    return Promise.all(symbols.map((symbol) => this.quoteOne(symbol)));
  }

  private async quoteOne(symbol: string): Promise<QuoteSnapshot> {
    const parsed = parseCanonicalSymbol(symbol);
    if (!parsed) return noData(symbol);

    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: parsed.market, code: parsed.code } },
      select: { id: true, name: true },
    });
    if (!instrument) return noData(symbol);

    const latest = await this.prisma.dailyBar.findFirst({
      where: { instrumentId: instrument.id, adjust: 'none' },
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true, close: true, changePct: true, prevClose: true },
    });
    // 名称与 hasData 正交: instrument 已注册即返 name (无 DailyBar 也返, 列表主名不留空)。
    if (!latest) return { ...noData(symbol), name: instrument.name };

    // 涨跌取官方涨跌幅反推 (除权日正确); changePct 缺 (旧行未回填 / 未来实时源) → 回退相邻前收差。
    const { change, changePct } =
      latest.changePct !== null
        ? changeFromPct(latest.close, latest.changePct)
        : computeChange(latest.close, latest.prevClose);
    return {
      symbol,
      name: instrument.name,
      price: decimalToString(latest.close),
      change,
      changePct,
      asOf: latest.tradeDate.toISOString().slice(0, 10),
      priceKind: 'eod_close',
      hasData: true,
    };
  }
}

function noData(symbol: string): QuoteSnapshot {
  return {
    symbol,
    name: null,
    price: null,
    change: null,
    changePct: null,
    asOf: null,
    priceKind: 'eod_close',
    hasData: false,
  };
}
