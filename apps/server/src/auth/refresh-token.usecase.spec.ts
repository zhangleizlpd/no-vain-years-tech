import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { RefreshTokenUseCase } from './refresh-token.usecase';
import type { RefreshTokenService } from '../security/refresh-token.service';
import type { InspectAccountStatusByIdUseCase } from '../account/inspect-account-status-by-id.usecase';
import type { RefreshToken } from '../generated/prisma/client';

type Fn = ReturnType<typeof vi.fn>;

const RECORD = { id: 1n, accountId: 42n } as unknown as RefreshToken;
const ROTATED = { accountId: 42n, accessToken: 'new-access', refreshToken: 'new-refresh' };

interface Harness {
  findActiveByHash: Fn;
  rotate: Fn;
  inspect: Fn;
  useCase: RefreshTokenUseCase;
}

function build(): Harness {
  const findActiveByHash = vi.fn();
  const rotate = vi.fn();
  const inspect = vi.fn();
  const refreshTokenService = { findActiveByHash, rotate } as unknown as RefreshTokenService;
  const inspectById = { execute: inspect } as unknown as InspectAccountStatusByIdUseCase;
  return {
    findActiveByHash,
    rotate,
    inspect,
    useCase: new RefreshTokenUseCase(refreshTokenService, inspectById),
  };
}

describe('RefreshTokenUseCase 编排', () => {
  let h: Harness;
  beforeEach(() => {
    h = build();
  });

  it('happy: active record + ACTIVE 账号 → rotate → 返回新 tokens', async () => {
    h.findActiveByHash.mockResolvedValue(RECORD);
    h.inspect.mockResolvedValue({ kind: 'ACTIVE' });
    h.rotate.mockResolvedValue(ROTATED);

    const result = await h.useCase.execute('raw-token', '8.8.8.8');

    expect(result).toEqual(ROTATED);
    expect(h.inspect).toHaveBeenCalledWith(42n);
    expect(h.rotate).toHaveBeenCalledWith(RECORD, '8.8.8.8');
  });

  it('findActiveByHash null (not-found/expired/revoked/forged) → 401, 不 inspect/rotate', async () => {
    h.findActiveByHash.mockResolvedValue(null);
    await expect(h.useCase.execute('raw-token', null)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it.each([['NOT_FOUND'], ['ANONYMIZED']])(
    '账号 %s → 401 (反枚举折叠), 不 rotate',
    async (kind) => {
      h.findActiveByHash.mockResolvedValue(RECORD);
      h.inspect.mockResolvedValue({ kind });
      await expect(h.useCase.execute('raw-token', null)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(h.rotate).not.toHaveBeenCalled();
    },
  );

  it('账号 FROZEN → 401 (NOT 403 — refresh 无 FROZEN 披露语义,与登录不同)', async () => {
    h.findActiveByHash.mockResolvedValue(RECORD);
    h.inspect.mockResolvedValue({ kind: 'FROZEN', freezeUntil: new Date() });
    await expect(h.useCase.execute('raw-token', null)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rotate 抛 401 (race lost / count===0) → 透传 401', async () => {
    h.findActiveByHash.mockResolvedValue(RECORD);
    h.inspect.mockResolvedValue({ kind: 'ACTIVE' });
    h.rotate.mockRejectedValue(new UnauthorizedException('INVALID_CREDENTIALS'));
    await expect(h.useCase.execute('raw-token', null)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
