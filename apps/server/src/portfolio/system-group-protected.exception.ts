import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 013 FR-S01/FR-S02 系统组保护: 系统组「自选」「持仓」(type=system) 不可改名 / 删除 →
 * 422 + code `SYSTEM_GROUP_PROTECTED`。
 *
 * update/delete-group UC: 路径 groupId 为 systemKind keyword (虚拟系统组, D9) 或解析到
 * type=system 真实行 (rules.isSystemGroup) → 抛本 exception (镜像 011/012 HttpException
 * 子类 + RFC 9457 extension, ADR-0038)。
 */
export class SystemGroupProtectedException extends HttpException {
  static readonly code = 'SYSTEM_GROUP_PROTECTED';

  constructor() {
    super(
      {
        code: SystemGroupProtectedException.code,
        message: '系统分组不可修改或删除',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
