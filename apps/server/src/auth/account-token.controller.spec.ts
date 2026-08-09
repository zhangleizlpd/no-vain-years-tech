import { describe, it, expect, vi } from 'vitest';
import { AccountTokenController } from './account-token.controller';
import type { RefreshTokenUseCase } from './refresh-token.usecase';
import type { LogoutAllUseCase } from './logout-all.usecase';

function build() {
  const refreshExecute = vi.fn();
  const logoutExecute = vi.fn().mockResolvedValue(undefined);
  const controller = new AccountTokenController(
    { execute: refreshExecute } as unknown as RefreshTokenUseCase,
    { execute: logoutExecute } as unknown as LogoutAllUseCase,
  );
  return { refreshExecute, logoutExecute, controller };
}

describe('AccountTokenController', () => {
  it('refresh: 调 usecase(refreshToken, clientIp) + 映射 accountId→string (复用 LoginResponse shape)', async () => {
    const { controller, refreshExecute } = build();
    refreshExecute.mockResolvedValue({
      accountId: 42n,
      accessToken: 'access-xyz',
      refreshToken: 'refresh-xyz',
    });

    const res = await controller.refresh({ refreshToken: 'raw-tok' }, '8.8.8.8');

    expect(refreshExecute).toHaveBeenCalledWith('raw-tok', '8.8.8.8');
    expect(res).toEqual({
      accountId: '42',
      accessToken: 'access-xyz',
      refreshToken: 'refresh-xyz',
    });
  });

  it('logoutAll: 调 usecase(req.user.accountId) + 返回 void (204)', async () => {
    const { controller, logoutExecute } = build();
    const res = await controller.logoutAll({ user: { accountId: 77n } });
    expect(logoutExecute).toHaveBeenCalledWith(77n);
    expect(res).toBeUndefined();
  });
});
