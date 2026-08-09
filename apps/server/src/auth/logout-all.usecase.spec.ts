import { describe, it, expect, vi } from 'vitest';
import { LogoutAllUseCase } from './logout-all.usecase';
import type { RefreshTokenService } from '../security/refresh-token.service';

describe('LogoutAllUseCase', () => {
  it('委托 security.revokeAllForAccount(accountId, now)', async () => {
    const revokeAllForAccount = vi.fn().mockResolvedValue(undefined);
    const svc = { revokeAllForAccount } as unknown as RefreshTokenService;
    const useCase = new LogoutAllUseCase(svc);

    await expect(useCase.execute(42n)).resolves.toBeUndefined();

    expect(revokeAllForAccount).toHaveBeenCalledTimes(1);
    const [accountId, now] = revokeAllForAccount.mock.calls[0]!;
    expect(accountId).toBe(42n);
    expect(now).toBeInstanceOf(Date);
  });
});
