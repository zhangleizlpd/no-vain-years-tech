import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * FR-S08: 撤销目标行**不存在** OR **属他人账号** → 字节级一致 404
 * (反枚举折叠,不泄露某 recordId 是否存在 / 归谁)。
 *
 * 无构造参数 → 两种归属下抛出的响应 (经 ProblemDetailFilter) 仅 instance(回显
 * 请求 URL) + traceId 不同,语义字段 (status/code/detail) 字节一致。
 * code = `DEVICE_NOT_FOUND`。
 */
export class DeviceNotFoundException extends HttpException {
  static readonly code = 'DEVICE_NOT_FOUND';

  constructor() {
    super(
      {
        code: DeviceNotFoundException.code,
        message: '设备不存在',
      },
      HttpStatus.NOT_FOUND,
    );
  }
}
