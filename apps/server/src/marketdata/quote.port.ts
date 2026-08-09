import type { QuoteSnapshot } from './marketdata.types.js';

/**
 * 最新报价端口 (FR-S07, US4)。V1 = EOD-backed (前收算涨跌, asOf + priceKind 标注)。
 * `EodBackedQuoteAdapter` 消费 EOD_BAR_PORT/PG DailyBar; 实时源接入翻 priceKind 零消费改。
 */
export const QUOTE_PORT = Symbol('QUOTE_PORT');

export interface QuotePort {
  /** 批量按 symbols 返最新报价; 无 EOD 数据项 hasData:false (不污染同批其余项)。 */
  getQuotes(symbols: string[]): Promise<QuoteSnapshot[]>;
}
