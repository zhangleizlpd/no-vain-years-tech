import { describe, it, expect, beforeAll } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { JwtTokenService } from './jwt-token.service';

describe('JwtTokenService', () => {
  let service: JwtTokenService;
  let realJwt: JwtService;

  beforeAll(() => {
    realJwt = new JwtService({ secret: 'test-secret-for-unit', signOptions: { expiresIn: '15m' } });
    service = new JwtTokenService(realJwt);
  });

  it('signAccessToken returns valid JWT signed with HS256', async () => {
    const token = service.signAccessToken({ accountId: 12345n });
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
    const decoded = await realJwt.verifyAsync<{ sub: string; iat: number; exp: number }>(token);
    expect(decoded.sub).toBe('12345');
    // 15min = 900s
    expect(decoded.exp - decoded.iat).toBe(15 * 60);
  });

  it('signAccessToken converts BigInt accountId to string sub (JWT spec)', () => {
    const token = service.signAccessToken({ accountId: 9007199254740993n }); // > Number.MAX_SAFE_INTEGER
    // verify decoded.sub is preserved as exact string
    const decoded = realJwt.verify(token) as { sub: string };
    expect(decoded.sub).toBe('9007199254740993');
  });

  it('generateRefreshToken returns 256-bit base64url string', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const refresh = service.generateRefreshToken();
      expect(refresh).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits = 32 bytes -> 43 chars base64url no padding
      tokens.add(refresh);
    }
    // 50 个全唯一 (entropy 检查)
    expect(tokens.size).toBe(50);
  });

  describe('verifyAccess', () => {
    it('roundtrips signAccessToken → { accountId }', () => {
      const token = service.signAccessToken({ accountId: 12345n });
      expect(service.verifyAccess(token)).toEqual({ accountId: 12345n });
    });

    it('preserves BigInt accountId beyond Number.MAX_SAFE_INTEGER', () => {
      const token = service.signAccessToken({ accountId: 9007199254740993n });
      expect(service.verifyAccess(token)).toEqual({ accountId: 9007199254740993n });
    });

    it('throws on a token signed with a different secret', () => {
      const foreign = new JwtService({ secret: 'a-different-secret' });
      const token = foreign.sign({ sub: '12345' });
      expect(() => service.verifyAccess(token)).toThrow();
    });

    it('throws on a malformed (non-JWT) token', () => {
      expect(() => service.verifyAccess('not.a.jwt')).toThrow();
    });

    it('throws when sub is not a valid integer string', () => {
      const token = realJwt.sign({ sub: 'not-a-number' });
      expect(() => service.verifyAccess(token)).toThrow();
    });
  });
});
