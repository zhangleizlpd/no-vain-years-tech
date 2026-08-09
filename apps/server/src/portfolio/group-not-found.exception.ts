import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 013 分组不存在: update/delete-group 路径 numeric groupId 在本账号无对应行 → 404 + code
 * `GROUP_NOT_FOUND` (反枚举折叠: 不存在 / 属他人字节级一致, 同 012 broker 404)。
 */
export class GroupNotFoundException extends HttpException {
  static readonly code = 'GROUP_NOT_FOUND';

  constructor() {
    super(
      {
        code: GroupNotFoundException.code,
        message: '分组不存在',
      },
      HttpStatus.NOT_FOUND,
    );
  }
}
