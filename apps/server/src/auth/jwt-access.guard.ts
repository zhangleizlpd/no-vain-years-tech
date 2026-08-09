import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtTokenService } from '../security/jwt-token.service';

export interface AuthenticatedUser {
  accountId: bigint;
}

/**
 * 轻量 access-token guard (auth ctx, per T001 决策 B + ADR-0041)。
 *
 * 只验 access token —— 委托 security 平台层 `JwtTokenService.verifyAccess`
 * (验签 + 还原 accountId),填 `req.user`,任何失败 (缺头 / 非 Bearer / 验签失败 /
 * 过期 / sub 非法) → 统一 401 (反枚举,不披露原因)。
 *
 * **不做账号状态门控** (与 account `JwtAuthGuard` 的 isActive 检查区别):
 * logout-all 即便账号 FROZEN 也应允许登出全端 (撤销 session 无害且更安全),
 * 故 auth 自建薄 guard 而非复用 account 的状态门控 guard。
 */
@Injectable()
export class JwtAccessGuard implements CanActivate {
  constructor(private readonly jwt: JwtTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: AuthenticatedUser;
    }>();

    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException();
    }
    try {
      const { accountId } = this.jwt.verifyAccess(token);
      request.user = { accountId };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const parts = authorization.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
    return undefined;
  }
  return parts[1];
}
