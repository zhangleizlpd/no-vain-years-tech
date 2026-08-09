import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../security/prisma.service';
import { isActive } from './account.rules';

export interface AuthenticatedUser {
  accountId: bigint;
}

/**
 * FR-002 / FR-009: Bearer token validation + Account.status == ACTIVE check.
 * Any failure (missing header / invalid / expired / non-ACTIVE) → unified 401,
 * reason not disclosed (anti-enumeration, per US4).
 *
 * On success sets request.user = { accountId } for downstream controllers.
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

    request.user = { accountId };
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
