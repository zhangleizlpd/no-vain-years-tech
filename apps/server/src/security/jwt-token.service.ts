import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * JwtTokenService — 封装 @nestjs/jwt 提供 (FR-S09):
 * - signAccessToken(payload): JWT, TTL 15min (configured at JwtModule level)
 * - generateRefreshToken(): 256-bit base64url random (持久化在 RefreshTokenService)
 * - verifyAccess(token): 验签 + 还原 { accountId }, 供边界 ctx guard 复用
 */
export interface AccessTokenPayload {
  accountId: bigint;
}

@Injectable()
export class JwtTokenService {
  constructor(private readonly jwtService: JwtService) {}

  /**
   * 签发 access token. JWT `sub` claim 用 string 形式承载 accountId (BigInt 安全).
   */
  signAccessToken(payload: AccessTokenPayload): string {
    return this.jwtService.sign({ sub: payload.accountId.toString() });
  }

  /**
   * 生成 refresh token: 256-bit CSPRNG, base64url 编码 (43 字符无 padding).
   */
  generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * 验证 access token, 还原 { accountId }. 验签失败 / 过期 / `sub` 非法整数串
   * 一律抛 (JsonWebTokenError / SyntaxError). 平台层只管 token 验证, HTTP 401
   * 语义 (反枚举折叠) 由调用方 guard 负责 — 让本方法对边界 ctx (auth) 可复用.
   */
  verifyAccess(token: string): AccessTokenPayload {
    const { sub } = this.jwtService.verify<{ sub: string }>(token);
    return { accountId: BigInt(sub) };
  }
}
