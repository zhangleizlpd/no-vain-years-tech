import type { EodBarPoint, EodBarQuery } from './marketdata.types.js';

/**
 * EOD 日线端口 (FR-S06, US3)。理杏仁主源; 含复权 (adjust)。
 * `EodBackedQuoteAdapter` (QUOTE_PORT) 消费此端口算最新报价。
 */
export const EOD_BAR_PORT = Symbol('EOD_BAR_PORT');

export interface EodBarPort {
  /** 按 symbol + adjust + 可选区间返日线序列, 按 tradeDate 升序。 */
  getBars(query: EodBarQuery): Promise<EodBarPoint[]>;
}
