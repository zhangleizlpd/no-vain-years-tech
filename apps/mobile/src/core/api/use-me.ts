/**
 * useMe — React Query hook for the authenticated account profile.
 *
 * The `/me` query cache is the SINGLE runtime source of truth for server-owned
 * profile fields (displayName / phone / gender / bio). Components read them from
 * here, never from a duplicated copy in the auth store (per TkDodo "Deriving
 * Client State from Server State" — don't sync server state into a client store).
 *
 * The zustand store keeps a PERSISTED snapshot (accountId / displayName / phone)
 * used for ONE thing only: seeding this query's `initialData` on cold start so a
 * returning user routes straight to profile without a splash (US12 anti-flicker).
 * That snapshot is never read for display at runtime.
 *
 * Behavior:
 *   - Per-account query key (meQueryKey) — the generated key is static (just the
 *     URL); without an accountId discriminator every account shares one cache
 *     slot → cross-account profile bleed. Identity belongs in the key.
 *   - Disabled until isAuthenticated && accessToken (avoids 401-storm pre-login)
 *   - initialData seeded from the persisted store snapshot, marked immediately
 *     stale so a background refetch fills the full/fresh profile
 *   - Errors surface to React Query consumer (handled via the
 *     formatErrorMessage / extractProblemDetail chain in ./errors.ts)
 *
 * Usage in component:
 *   const { data: profile, isLoading, error } = useMe();
 *   if (error) return <Text>{formatErrorMessage(error)}</Text>;
 *   ...
 */
import { useEffect } from 'react';
import type { AxiosResponse } from 'axios';
import {
  useAccountProfileControllerGetProfile,
  type AccountProfileResponse,
} from '@nvy/api-client';
import { useAuthStore } from '~/auth';
import { meQueryKey } from './me-query-key';

export function useMe() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const accountId = useAuthStore((s) => s.accountId);
  const seedDisplayName = useAuthStore((s) => s.displayName);
  const seedPhone = useAuthStore((s) => s.phone);

  // Cold-start anti-flicker seed (US12): build a profile snapshot from the
  // persisted store so initialData populates `data` synchronously on boot —
  // AuthGate routes a returning named user straight to profile BEFORE /me lands.
  // Only persisted fields are known; bio/gender are filled by the immediate
  // background refetch. Null when there's no returning-user snapshot (new login).
  const seed: AccountProfileResponse | null =
    accountId !== null && seedDisplayName !== null
      ? {
          accountId,
          phone: seedPhone ?? '',
          displayName: seedDisplayName,
          bio: null,
          gender: null,
          avatarUrl: null,
          backgroundImageUrl: null,
          status: 'ACTIVE',
          createdAt: '',
          // 冷启动种子未持久化绑定态; 由即时后台 refetch 回填真值 (同 bio/gender)。
          wechatBound: false,
        }
      : null;

  const query = useAccountProfileControllerGetProfile<AccountProfileResponse>({
    query: {
      queryKey: meQueryKey(accountId),
      // Gate on accessToken, not just isAuthenticated: on a cold start / browser
      // reload the persisted refreshToken flips isAuthenticated true (store.ts
      // onRehydrateStorage) while accessToken is still null (in-memory only).
      // Firing /me here would 401 until the response interceptor补刷 — instead we
      // wait for AuthGate's rehydrateSession() to exchange the refresh token, then
      // /me fires with a Bearer and never 401s. Fresh login sets both atomically,
      // so it's unaffected. The 401 interceptor stays as the runtime-expiry net.
      enabled: isAuthenticated && !!accessToken,
      // axios mutator (PR-5c setupAxios) attaches Authorization Bearer
      // from useAuthStore.accessToken — no per-call header inject needed.
      select: (response) => response.data,
      // initialData is pre-select (the AxiosResponse); select extracts `.data`.
      // We only ever read `.data` downstream, so a minimal wrapper suffices.
      initialData: seed
        ? ({ data: seed } as unknown as AxiosResponse<AccountProfileResponse>)
        : undefined,
      // Mark the seed immediately stale so the query refetches the full/fresh
      // profile as soon as it's enabled, rather than trusting the partial seed.
      initialDataUpdatedAt: 0,
    },
  });

  // Maintain the cold-start seed: persist the freshest /me snapshot back into the
  // store so the NEXT cold boot can seed initialData. This is the ONLY writer of
  // profile fields into the store, and nothing reads them for display at runtime,
  // so it can never clobber a shown value — unlike the prior design where a stale
  // cached `displayName: null` overwrote a freshly-set name and bounced the user
  // to onboarding. Equivalent to a hand-rolled persister scoped to the boot seed.
  useEffect(() => {
    if (query.data) {
      useAuthStore.setState({
        accountId: query.data.accountId,
        displayName: query.data.displayName,
        phone: query.data.phone,
      });
    }
  }, [query.data]);

  return query;
}
