import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * PUT 未知市场码 (不在 9 市场字典内, isKnownMarket=false) → 抛本 exception →
 * ProblemDetailFilter 映射为 404 + code `MARKET_NOT_FOUND` (D2; 区别于海外已知码的 422)。
 */
export class MarketNotFoundException extends HttpException {
  static readonly code = 'MARKET_NOT_FOUND';

  constructor(market: string) {
    super(
      {
        code: MarketNotFoundException.code,
        message: `未知市场码 ${market}`,
      },
      HttpStatus.NOT_FOUND,
    );
  }
}
