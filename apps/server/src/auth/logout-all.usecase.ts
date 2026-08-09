import { Injectable } from '@nestjs/common';
import { RefreshTokenService } from '../security/refresh-token.service';

/**
 * 全端登出编排 (auth 编排层)。accountId 由 JwtAccessGuard 从 access token `sub` 还原,
 * 委托 security 撤该账号全部 active refresh-token (含当前 device)。幂等 → 控制器返回 204。
 */
@Injectable()
export class LogoutAllUseCase {
  constructor(
    // CROSS-CONTEXT-SYNC: auth → security 撤账号全部 refresh-token (全端登出)
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  async execute(accountId: bigint): Promise<void> {
    await this.refreshTokenService.revokeAllForAccount(accountId, new Date());
  }
}
