import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 013 FR-S06 持仓组派生只读: 持仓组 (systemKind=holdings) 成员派生自持仓事实，用户不可
 * 手动加 / 删 / 移入移出 → 422 + code `HOLDINGS_GROUP_READONLY`。
 *
 * add/update/delete-item UC: 目标组 (路径 keyword 'holdings' 或解析到 isHoldingsGroup 真实行)
 * 为持仓组 → 抛本 exception (镜像 SystemGroupProtectedException, RFC 9457 extension, ADR-0038)。
 */
export class HoldingsGroupReadonlyException extends HttpException {
  static readonly code = 'HOLDINGS_GROUP_READONLY';

  constructor() {
    super(
      {
        code: HoldingsGroupReadonlyException.code,
        message: '持仓分组为派生只读，不可手动增删标的',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
