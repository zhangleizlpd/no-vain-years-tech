import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * FR-S05 海外不可激活: 拒绝激活任何海外市场 (JPY/SGD/MYR/CAD/AUD/KRW) → 不持久化。
 *
 * 字典校验 (tx 外, isCoreMarket=false) → 抛本 exception → ProblemDetailFilter 映射为
 * 422 + code `MARKET_NOT_AVAILABLE`。422 = 请求格式合法但市场 V1 不可激活 (业务不变性, D2)。
 */
export class MarketNotAvailableException extends HttpException {
  static readonly code = 'MARKET_NOT_AVAILABLE';

  constructor(market: string) {
    super(
      {
        code: MarketNotAvailableException.code,
        message: `市场 ${market} 暂不可激活`,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
