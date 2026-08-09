import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RefreshTokenService } from '../security/refresh-token.service';
import { hashRefreshToken } from '../security/refresh-token-hasher';
import { InspectAccountStatusByIdUseCase } from '../account/inspect-account-status-by-id.usecase';

export interface RefreshTokenResult {
  accountId: bigint;
  accessToken: string;
  refreshToken: string;
}

/**
 * refresh-token 轮换编排 (per ADR-0032 auth = 编排层 + ADR-0043 两段式委托)。
 *
 * 流程: hash(rawToken) → security.findActiveByHash (null → 401) →
 * account.inspectAccountStatusById (非 ACTIVE → 401) → security.rotate → 新 tokens。
 *
 * 反枚举: 全失败臂 (not-found / expired / revoked / forged / account-missing /
 * account-not-eligible / race-lost) 一律折叠成字节级一致的 401 INVALID_CREDENTIALS。
 * **FROZEN 也折 401**(NOT 403)—— refresh 无 FROZEN 披露语义,与登录 (phone-sms-auth)
 * 不同 (登录 FROZEN → 403 + freezeUntil)。per-token-hash + per-IP 限流由控制器 guard 承担。
 */
@Injectable()
export class RefreshTokenUseCase {
  constructor(
    // CROSS-CONTEXT-SYNC: auth → security 轮换 refresh-token (撤旧+签新, rotate 失败回滚整请求)
    private readonly refreshTokenService: RefreshTokenService,
    // CROSS-CONTEXT-SYNC: auth → account 读账号状态 (refresh 可登录判定, 只读)
    private readonly inspectAccountStatusById: InspectAccountStatusByIdUseCase,
  ) {}

  async execute(rawToken: string, clientIp: string | null): Promise<RefreshTokenResult> {
    const tokenHash = hashRefreshToken(rawToken);
    const record = await this.refreshTokenService.findActiveByHash(tokenHash, new Date());
    if (!record) {
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    const inspection = await this.inspectAccountStatusById.execute(record.accountId);
    if (inspection.kind !== 'ACTIVE') {
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    return this.refreshTokenService.rotate(record, clientIp);
  }
}
