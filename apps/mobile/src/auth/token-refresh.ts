// Token-refresh infrastructure for the auth module (003-tokens US7 client).
//
// Single-flights concurrent refresh calls to prevent thundering-herd when
// multiple API calls return 401 simultaneously (FR-C02). On failure the
// session is cleared so AuthGate surfaces the login screen (FR-C01).
//
// Where the interceptor lives: spec/plan put the response interceptor in
// packages/api-client/src/, but that package is a pure Orval-generated module
// bound to the global axios instance — it can't import this auth store / the
// router without an illegal dependency inversion. So the 401 handler factory
// lives here (auth concern) and is wired onto the shared axios instance by
// core/api/setup.ts (where the request interceptor already lives).

import { isAxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import { accountTokenControllerRefresh } from '@nvy/api-client';

import { useAuthStore } from './store';
import { queryClient } from '~/core/api/query-client';

// Forced logout (expired/absent refresh token): drop the store session AND wipe
// the React Query cache, so a re-login on the same client can't read the prior
// account's server-state caches (cross-account bleed). Cache lifecycle ⇒ auth.
function clearSessionAndCache(): void {
  useAuthStore.getState().clearSession();
  queryClient.clear();
}

// Exempt path (FR-C03): a 401 from the refresh endpoint itself must never
// trigger another refresh. Matched as a substring of the (baseURL-relative)
// request url. One-shot retry marker keeps a still-401 retry from looping.
const REFRESH_PATH = '/accounts/refresh-token';
const RETRY_HEADER = 'x-nvy-retry';

let inflightRefresh: Promise<void> | null = null;

// Attempts to exchange the persisted refresh token for a new access token.
// On success, updates the store with the new session. On any failure (or when
// no refresh token exists), clears the session and rethrows.
export async function refreshTokenFlow(): Promise<void> {
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) {
    clearSessionAndCache();
    throw new Error('SESSION_EXPIRED');
  }
  try {
    // Server rotates: old refresh token revoked, fresh access + refresh issued
    // (003-tokens US2). Persist the new pair so the next cold start can refresh.
    const { data } = await accountTokenControllerRefresh({ refreshToken });
    useAuthStore.getState().setSession({
      accountId: data.accountId,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    });
  } catch (err) {
    clearSessionAndCache();
    throw err instanceof Error ? err : new Error('SESSION_EXPIRED');
  }
}

// Returns a shared in-flight refresh promise so concurrent 401 handlers
// share one refresh round rather than triggering multiple (FR-C02).
export function refreshOnce(): Promise<void> {
  if (inflightRefresh !== null) {
    return inflightRefresh;
  }
  inflightRefresh = refreshTokenFlow().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

// Silently rehydrates the session on cold start. Call from AuthGate after
// persist hydration completes. If the persisted refresh token is valid the
// access token is refreshed silently; if it's expired or missing the session
// is cleared. Resolves without throwing.
export async function rehydrateSession(): Promise<void> {
  const { refreshToken, accessToken } = useAuthStore.getState();
  if (!refreshToken || accessToken) {
    return;
  }
  await refreshOnce().catch(() => {
    // clearSession already called inside refreshTokenFlow; eat the error.
  });
}

/**
 * Transparent-renewal axios response-error handler (FR-C01..C03).
 *
 * On a 401 it single-flights one refresh and retries the original request
 * exactly once with the new access token. Bails (propagating the original
 * error) when: the request isn't a 401, it's the refresh endpoint itself
 * (exempt), it was already retried once, or there's no refresh token to spend.
 * Refresh failure propagates the original 401 (session is cleared inside the
 * flow → AuthGate routes to login).
 *
 * Factory takes the axios instance so the retry re-issues through the same
 * interceptor chain and so it's unit-testable with a fake instance.
 */
export function makeAuthRefreshResponseInterceptor(client: AxiosInstance) {
  return async (error: unknown): Promise<AxiosResponse> => {
    if (!isAxiosError(error) || error.response?.status !== 401) {
      throw error;
    }
    const original = error.config;
    if (!original) throw error;

    // Exempt the refresh endpoint (prevent refresh→refresh loop) + one-shot.
    if (typeof original.url === 'string' && original.url.includes(REFRESH_PATH)) {
      throw error;
    }
    if (original.headers?.[RETRY_HEADER]) throw error;

    // Nothing to refresh (unauthenticated call / login attempt) → let the
    // caller handle the 401; don't churn the (empty) session.
    if (!useAuthStore.getState().refreshToken) throw error;

    try {
      await refreshOnce();
    } catch {
      throw error; // propagate original 401; session already cleared.
    }

    original.headers = original.headers ?? {};
    original.headers[RETRY_HEADER] = '1';
    const accessToken = useAuthStore.getState().accessToken;
    if (accessToken) {
      original.headers['Authorization'] = `Bearer ${accessToken}`;
    }
    return client(original);
  };
}
