import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * FR-S08: public 撤销流端点的手机号格式校验失败 (非 E.164 +86 CN mobile) → 422
 * Unprocessable Entity (code = `INVALID_PHONE_FORMAT`)。
 *
 * 与 FORM_VALIDATION (400, 缺字段 / 类型错) 区分: 格式错是「字段语义不合法」而非
 * 「请求结构缺失」, 走 422 (per plan EP3/EP4 contract)。明文手机号不外泄 (仅通用
 * message)。镜像 `sms-send-failed.exception.ts` 的 HttpException 子类形态。
 *
 * 注: 全局 ValidationPipe 把 class-validator 失败统一映射 FORM_VALIDATION 400
 * (见 main.ts exceptionFactory), 故 422 **不能**靠 DTO `@Matches` 产出 —— 由控制器
 * 显式校验 E.164 后抛本 exception。
 */
export class InvalidPhoneFormatException extends HttpException {
  static readonly code = 'INVALID_PHONE_FORMAT';

  constructor() {
    super(
      {
        code: InvalidPhoneFormatException.code,
        message: '手机号格式不正确',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
