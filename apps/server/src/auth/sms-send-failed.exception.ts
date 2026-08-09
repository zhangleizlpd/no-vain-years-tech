import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * FR-S21: 验证码发送失败 (Aliyun 网关抛错 / 业务码非 OK) → 503。
 *
 * eligible 的发码路径 (send-deletion-code / send-cancel-deletion-code 的真发码分支)
 * 在 smsGateway.sendCode 抛底层错误时 catch → 转本 exception → ProblemDetailFilter
 * 映射 503 + RFC 9457 ProblemDetail (code = `SMS_SEND_FAILED`)。底层错误细节不外泄
 * (仅通用 message), 避免暴露网关内部状态。
 *
 * 镜像 `auth-attempt-locked.exception.ts` 的 HttpException 子类形态。
 */
export class SmsSendFailedException extends HttpException {
  static readonly code = 'SMS_SEND_FAILED';

  constructor() {
    super(
      {
        code: SmsSendFailedException.code,
        message: '验证码发送失败,请稍后重试',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
