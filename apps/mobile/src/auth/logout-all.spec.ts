import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from './store';

// expo-secure-store is pulled in transitively via store.ts; mock it here so
// the store module initialises cleanly in a Node environment.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));

const h = vi.hoisted(() => ({ logoutAllCall: vi.fn() }));
vi.mock('@nvy/api-client', () => ({
  accountTokenControllerLogoutAll: h.logoutAllCall,
}));

import { useAuthStore } from './store';
import { logoutAll } from './logout-all';

const AUTHED: Partial<AuthState> = {
  accountId: 'acc-1',
  accessToken: 'at',
  refreshToken: 'rt',
  displayName: '小明',
  phone: '13800138000',
  isAuthenticated: true,
};

beforeEach(() => {
  useAuthStore.setState(AUTHED);
  h.logoutAllCall.mockReset();
});

describe('logoutAll (US8 — 全端登出 wrapper)', () => {
  it('calls the server logout-all endpoint and clears the local session', async () => {
    h.logoutAllCall.mockResolvedValue({ status: 204 });

    await expect(logoutAll()).resolves.toBeUndefined();

    expect(h.logoutAllCall).toHaveBeenCalledTimes(1);
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.accountId).toBeNull();
    expect(s.refreshToken).toBeNull();
  });

  it('still clears the local session when the server call fails (finally)', async () => {
    h.logoutAllCall.mockRejectedValue(new Error('network'));

    // Must not throw — server failure does not block local logout.
    await expect(logoutAll()).resolves.toBeUndefined();

    expect(h.logoutAllCall).toHaveBeenCalledTimes(1);
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.refreshToken).toBeNull();
  });
});
