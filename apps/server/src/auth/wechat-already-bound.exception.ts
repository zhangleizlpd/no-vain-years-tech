import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 010 FR-S02: 目标 openid 已绑**他**账号 → 409。
 *
 * ProblemDetailFilter 映射为 409 + RFC 9457 ProblemDetail。
 * **MUST NOT 含他账号任何信息**(反信息泄露) —— body 仅固定 code + 通用文案。
 *
 * code = `WECHAT_ALREADY_BOUND_OTHER`。
 */
export class WechatAlreadyBoundException extends HttpException {
  static readonly code = 'WECHAT_ALREADY_BOUND_OTHER';

  constructor() {
    super(
      {
        code: WechatAlreadyBoundException.code,
        message: '该微信已绑定其他账号',
      },
      HttpStatus.CONFLICT,
    );
  }
}
