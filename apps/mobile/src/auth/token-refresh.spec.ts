import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import type { AuthState } from './store';

// expo-secure-store is pulled in transitively via store.ts; mock it here so
// the store module initialises cleanly in a Node environment.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));

// Mock the Orval refresh function so we drive its resolve/reject per test
// without touching real axios / the network. Captured via vi.hoisted so the
// vi.mock factory (hoisted above imports) can reference it.
const h = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@nvy/api-client', () => ({
  accountTokenControllerRefresh: h.refresh,
}));

import { useAuthStore } from './store';
import {
  makeAuthRefreshResponseInterceptor,
  refreshOnce,
  refreshTokenFlow,
  rehydrateSession,
} from './token-refresh';

const CLEAN: Partial<AuthState> = {
  accountId: null,
  accessToken: null,
  refreshToken: null,
  displayName: null,
  phone: null,
  isAuthenticated: false,
};

const ROTATED = { accountId: 'acc-1', accessToken: 'access-new', refreshToken: 'refresh-new' };

beforeEach(() => {
  useAuthStore.setState(CLEAN);
  h.refresh.mockReset();
});

describe('refreshTokenFlow', () => {
  it('clears session and throws SESSION_EXPIRED when no refreshToken (no API call)', async () => {
    useAuthStore.setState({ accountId: 'acc-1', isAuthenticated: true });
    await expect(refreshTokenFlow()).rejects.toThrow('SESSION_EXPIRED');
    expect(h.refresh).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().accountId).toBeNull();
  });

  it('exchanges the refresh token and lifts the rotated pair into the store', async () => {
    useAuthStore.setState({ refreshToken: 'rt-old' });
    h.refresh.mockResolvedValue({ data: ROTATED });

    await expect(refreshTokenFlow()).resolves.toBeUndefined();

    expect(h.refresh).toHaveBeenCalledWith({ refreshToken: 'rt-old' });
    const s = useAuthStore.getState();
    expect(s.accountId).toBe('acc-1');
    expect(s.accessToken).toBe('access-new');
    expect(s.refreshToken).toBe('refresh-new');
    expect(s.isAuthenticated).toBe(true);
  });

  it('clears the session and rethrows when the refresh call fails', async () => {
    useAuthStore.setState({ refreshToken: 'rt-old', accountId: 'acc-1', isAuthenticated: true });
    h.refresh.mockRejectedValue(new Error('boom'));

    await expect(refreshTokenFlow()).rejects.toThrow('boom');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });
});

describe('refreshOnce — single-flight deduplication (SC-C02)', () => {
  it('concurrent calls return the same in-flight Promise', async () => {
    useAuthStore.setState({ refreshToken: 'rt' });
    h.refresh.mockResolvedValue({ data: ROTATED });
    const p1 = refreshOnce();
    const p2 = refreshOnce();
    expect(p1).toBe(p2);
    await Promise.allSettled([p1, p2]);
  });

  it('triggers the refresh call exactly once across N concurrent callers', async () => {
    useAuthStore.setState({ refreshToken: 'rt' });
    h.refresh.mockResolvedValue({ data: ROTATED });
    await Promise.all([refreshOnce(), refreshOnce(), refreshOnce()]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('after settling, a subsequent call produces a new Promise + new refresh', async () => {
    useAuthStore.setState({ refreshToken: 'rt' });
    h.refresh.mockResolvedValue({ data: ROTATED });
    const p1 = refreshOnce();
    await p1;
    const p2 = refreshOnce();
    expect(p2).not.toBe(p1);
    await p2;
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('rejects when the refresh fails (session cleared)', async () => {
    useAuthStore.setState({ refreshToken: 'rt', isAuthenticated: true });
    h.refresh.mockRejectedValue(new Error('boom'));
    await expect(refreshOnce()).rejects.toThrow('boom');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});

describe('rehydrateSession (cold-start silent refresh)', () => {
  it('resolves immediately when no refreshToken is stored (no API call)', async () => {
    await expect(rehydrateSession()).resolves.toBeUndefined();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('resolves immediately when an accessToken is already in-memory (no API call)', async () => {
    useAuthStore.setState({ refreshToken: 'rt', accessToken: 'still-valid-at' });
    await expect(rehydrateSession()).resolves.toBeUndefined();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('refreshes silently when refreshToken present but no accessToken', async () => {
    useAuthStore.setState({ refreshToken: 'rt', accessToken: null });
    h.refresh.mockResolvedValue({ data: ROTATED });
    await expect(rehydrateSession()).resolves.toBeUndefined();
    expect(useAuthStore.getState().accessToken).toBe('access-new');
  });

  it('never propagates a rejection — clears session on failure (AuthGate must not crash)', async () => {
    useAuthStore.setState({ refreshToken: 'stale-rt' });
    h.refresh.mockRejectedValue(new Error('boom'));
    await expect(rehydrateSession()).resolves.toBeUndefined();
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});

describe('makeAuthRefreshResponseInterceptor (transparent renewal, SC-C01/C03)', () => {
  // axios.isAxiosError only checks `payload.isAxiosError === true`, so a plain
  // object shaped like an AxiosError is enough for the unit boundary.
  function axiosError(status: number, config: Record<string, unknown> = {}) {
    return { isAxiosError: true, response: { status }, config };
  }

  function makeClient() {
    return vi.fn().mockResolvedValue({ status: 200, data: 'ok' });
  }
  const asInstance = (client: ReturnType<typeof makeClient>) => client as unknown as AxiosInstance;

  it('refreshes once and retries the original request with the new access token', async () => {
    useAuthStore.setState({ refreshToken: 'rt' });
    h.refresh.mockResolvedValue({ data: ROTATED });
    const client = makeClient();
    const handle = makeAuthRefreshResponseInterceptor(asInstance(client));

    const err = axiosError(401, { url: '/api/v1/accounts/me', headers: {} });
    const res = await handle(err);

    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(client).toHaveBeenCalledTimes(1);
    const retried = client.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(retried.headers['x-nvy-retry']).toBe('1');
    expect(retried.headers['Authorization']).toBe('Bearer access-new');
    expect(res).toEqual({ status: 200, data: 'ok' });
  });

  it('does not refresh non-401 errors', async () => {
    useAuthStore.setState({ refreshToken: 'rt' });
    const client = makeClient();
    const handle = makeAuthRefreshResponseInterceptor(asInstance(client));
    const err = axiosError(500, { url: '/api/v1/accounts/me', headers: {} });
    await expect(handle(err)).rejects.toBe(err);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('exempts the refresh endpoint itself (no refresh→refresh loop)', async () => {
    useAuthStore.setState({ refreshToken: 'rt' });
    const client = makeClient();
    const handle = makeAuthRefreshResponseInterceptor(asInstance(client));
    const err = axiosError(401, { url: '/api/v1/accounts/refresh-token', headers: {} });
    await expect(handle(err)).rejects.toBe(err);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('does not retry a request already carrying the retry marker', async () => {
    useAuthStore.setState({ refreshToken: 'rt' });
    const client = makeClient();
    const handle = makeAuthRefreshResponseInterceptor(asInstance(client));
    const err = axiosError(401, { url: '/api/v1/accounts/me', headers: { 'x-nvy-retry': '1' } });
    await expect(handle(err)).rejects.toBe(err);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('skips refresh when there is no refresh token to spend (login-flow 401)', async () => {
    const client = makeClient();
    const handle = makeAuthRefreshResponseInterceptor(asInstance(client));
    const err = axiosError(401, { url: '/api/v1/accounts/phone-sms-auth', headers: {} });
    await expect(handle(err)).rejects.toBe(err);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('propagates the original 401 (and clears session) when refresh fails', async () => {
    useAuthStore.setState({ refreshToken: 'rt', isAuthenticated: true });
    h.refresh.mockRejectedValue(new Error('refresh-401'));
    const client = makeClient();
    const handle = makeAuthRefreshResponseInterceptor(asInstance(client));
    const err = axiosError(401, { url: '/api/v1/accounts/me', headers: {} });

    await expect(handle(err)).rejects.toBe(err);
    expect(client).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('single-flights one refresh across concurrent 401s, retrying each (FR-C02)', async () => {
    useAuthStore.setState({ refreshToken: 'rt' });
    h.refresh.mockResolvedValue({ data: ROTATED });
    const client = makeClient();
    const handle = makeAuthRefreshResponseInterceptor(asInstance(client));

    await Promise.all([
      handle(axiosError(401, { url: '/api/v1/accounts/me', headers: {} })),
      handle(axiosError(401, { url: '/api/v1/accounts/me', headers: {} })),
    ]);

    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(client).toHaveBeenCalledTimes(2);
  });
});
