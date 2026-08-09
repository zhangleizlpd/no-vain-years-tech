import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * FR-S07 第 4 条: auth:<phone> 5 次失败 → 锁 30min。
 *
 * 锁定期内调用 phone-sms-auth → 抛出本 exception → ProblemDetailFilter
 * 映射为 429 + standard `Retry-After` header (seconds until 锁解除)。
 *
 * code = `AUTH_ATTEMPT_LOCKED` (PRD § 错误码层)。
 */
export class AuthAttemptLockedException extends HttpException {
  static readonly code = 'AUTH_ATTEMPT_LOCKED';

  constructor(public readonly retryAfterSeconds: number) {
    super(
      {
        code: AuthAttemptLockedException.code,
        message: '认证失败次数过多,账户暂时锁定',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
