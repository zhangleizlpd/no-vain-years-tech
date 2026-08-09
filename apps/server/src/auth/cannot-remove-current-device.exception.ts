import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * FR-S07: 撤销目标行 deviceId == 当前设备 (请求 x-device-id) → 409
 * (引导用户走「退出登录」LogoutAll,不撤销、不发事件)。
 *
 * code = `CANNOT_REMOVE_CURRENT_DEVICE`。
 */
export class CannotRemoveCurrentDeviceException extends HttpException {
  static readonly code = 'CANNOT_REMOVE_CURRENT_DEVICE';

  constructor() {
    super(
      {
        code: CannotRemoveCurrentDeviceException.code,
        message: '不能移除当前正在使用的设备,请改用「退出登录」',
      },
      HttpStatus.CONFLICT,
    );
  }
}
