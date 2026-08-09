import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * GET 详情/K线 时 symbol 不在 Instrument 注册表 (或 canonical 形态非法) → 抛本 exception →
 * ProblemDetailFilter 映射 404 + code `INSTRUMENT_NOT_FOUND` (镜像 011 MarketNotFoundException,
 * RFC 9457 + 业务 code 扩展, per ADR-0038)。
 */
export class InstrumentNotFoundException extends HttpException {
  static readonly code = 'INSTRUMENT_NOT_FOUND';

  constructor(symbol: string) {
    super(
      {
        code: InstrumentNotFoundException.code,
        message: `未知标的 ${symbol}`,
      },
      HttpStatus.NOT_FOUND,
    );
  }
}
