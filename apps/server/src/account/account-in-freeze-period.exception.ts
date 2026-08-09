import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * AccountInFreezePeriodException (per spec FR-S05 + CL-006 disclosure path).
 *
 * 注销冻结期账号尝试登录 → HTTP 403 + RFC 9457 ProblemDetail body:
 *   { code: 'ACCOUNT_IN_FREEZE_PERIOD', freezeUntil: ISO-8601, message }
 *
 * 与 ANONYMIZED 反枚举吞 401 不同 — FROZEN 是用户主动注销知情态, 信息泄露面小,
 * 选 disclosure 让 client 能在 freeze 期内引导申诉 (spec D `expose-frozen-account-status`).
 *
 * Per PR-5a refactor: extends HttpException (was plain Error) so
 * ProblemDetailFilter can do generic dispatch via HttpException.getResponse()
 * + body field pass-through — no security→account reverse import needed
 * (per ADR-0032 single direction + ADR-0038 contract).
 *
 * `freezeUntil` 保留 instance property 以兼容现有 spec tests / typed access.
 */
export const ACCOUNT_IN_FREEZE_PERIOD_CODE = 'ACCOUNT_IN_FREEZE_PERIOD';

export class AccountInFreezePeriodException extends HttpException {
  static readonly code = ACCOUNT_IN_FREEZE_PERIOD_CODE;

  constructor(public readonly freezeUntil: Date) {
    super(
      {
        code: ACCOUNT_IN_FREEZE_PERIOD_CODE,
        message: '账号处于注销冻结期内,暂不可登录',
        freezeUntil: freezeUntil.toISOString(),
      },
      HttpStatus.FORBIDDEN,
    );
    this.name = 'AccountInFreezePeriodException';
  }
}
