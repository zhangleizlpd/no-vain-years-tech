import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * FR-S04 min-1 不变性: 拒绝任何使核心市场激活数归 0 的更新 (关最后一个激活市场)。
 *
 * 写事务内基于当前激活集判定 (FOR UPDATE 串行化同账号并发 toggle, D1) → 抛本 exception
 * → ProblemDetailFilter 映射为 422 + code `MIN_ONE_MARKET_REQUIRED`; 状态不变。
 * 用 422 (Unprocessable Entity, 业务不变性违反) 区别于 400 (FORM_VALIDATION 格式错), D2。
 */
export class MinOneMarketRequiredException extends HttpException {
  static readonly code = 'MIN_ONE_MARKET_REQUIRED';

  constructor() {
    super(
      {
        code: MinOneMarketRequiredException.code,
        message: '至少保留一个激活市场',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
