import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Throttler 限流超限 —— 各 feature 限流规则 (FR-S07 发码锁 / FR-S13 设备 EP ...) 共用。
 *
 * named throttler 桶超限 → RetryAfterThrottlerGuard 抛本 exception →
 * ProblemDetailFilter 映射为 429 + canonical `Retry-After` header (秒) +
 * body.retryAfterSeconds (per ADR-0038 错误响应 contract)。
 *
 * `@nestjs/throttler` v6 默认 ThrottlerException 对 named throttler 只设带桶名
 * 后缀的 `Retry-After-<bucket>` 头, body 无 retryAfterSeconds —— 不符合各 spec
 * 承诺的 canonical `Retry-After`; 本 exception 复用既有 retryAfterSeconds 通道补齐。
 *
 * code = `RATE_LIMIT_EXCEEDED` (PRD § 错误码层, 同 AuthAttemptLockedException 体例)。
 */
export class RateLimitExceededException extends HttpException {
  static readonly code = 'RATE_LIMIT_EXCEEDED';

  constructor(public readonly retryAfterSeconds: number) {
    super(
      {
        code: RateLimitExceededException.code,
        message: '请求过于频繁,请稍后再试',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
