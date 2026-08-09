import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 010 R2 (对称冲突): 本账号已绑微信、再绑**不同** openid → 409 (不静默替换身份)。
 *
 * ProblemDetailFilter 映射为 409 + RFC 9457 ProblemDetail。happy-path mobile UI
 * 不可达(bound → 行显示解绑, 不发 bind), 纯服务端纵深防御。
 *
 * code = `WECHAT_ACCOUNT_ALREADY_BOUND`。
 */
export class WechatAccountAlreadyBoundException extends HttpException {
  static readonly code = 'WECHAT_ACCOUNT_ALREADY_BOUND';

  constructor() {
    super(
      {
        code: WechatAccountAlreadyBoundException.code,
        message: '当前账号已绑定微信，请先解绑',
      },
      HttpStatus.CONFLICT,
    );
  }
}
