import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../security/prisma.service';
import { isActive } from './account.rules';

export interface AuthenticatedUser {
  accountId: bigint;
  /**
   * 072: 系统管理员标。由本 guard 从**已经加载的** account 行填 ⇒ 零额外查询。
   * 消费方是 `AdminOnlyGuard`;业务端点一律只读 `accountId`。
   * ⚠️ `auth/jwt-access.guard.ts` 里有个**同名但不同**的 `AuthenticatedUser` —— 那个刻意
   * 跳过账号行查询 (否则 FROZEN 账号撤不了设备), 填不了本字段, 也**不该**挂 AdminOnlyGuard。
   */
  isAdmin: boolean;
}

/**
 * FR-002 / FR-009: Bearer token validation + Account.status == ACTIVE check.
 * Any failure (missing header / invalid / expired / non-ACTIVE) → unified 401,
 * reason not disclosed (anti-enumeration, per US4).
 *
 * On success sets request.user = { accountId, isAdmin } for downstream controllers
 * (isAdmin 白拿 —— 上面那次 findUnique 本就把整行读回来了, per 072)。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: AuthenticatedUser;
    }>();

    const token = this.extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException();
    }

    let sub: string;
    try {
      const payload = this.jwtService.verify<{ sub: string }>(token);
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException();
    }

    let accountId: bigint;
    try {
      accountId = BigInt(sub);
    } catch {
      throw new UnauthorizedException();
    }

    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!account || account.phone === null || !isActive(account)) {
      throw new UnauthorizedException();
    }

    request.user = { accountId, isAdmin: account.isAdmin };
    return true;
  }

  private extractBearerToken(authorization: string | undefined): string | undefined {
    if (!authorization) return undefined;
    const parts = authorization.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
      return undefined;
    }
    return parts[1];
  }
}
