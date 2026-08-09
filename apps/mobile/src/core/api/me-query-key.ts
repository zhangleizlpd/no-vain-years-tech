import { getAccountProfileControllerGetProfileQueryKey } from '@nvy/api-client';

// Per-account /me cache key. The Orval-generated key is `['/api/v1/accounts/me']`
// with no identity dimension — a static address every account resolves to, so
// account B mounts and reads account A's cached profile (cross-account bleed).
// Scope it by accountId (Query Key Factory: every input that changes the data
// goes in the key). ALL /me read / invalidate / setQueryData call-sites use this.
//
// Lives in its own module (not use-me.ts) so write-side hooks under ~/auth can
// import it without the cycle ~/auth → update-display-name → use-me → ~/auth.
export function meQueryKey(accountId: string | null) {
  return [...getAccountProfileControllerGetProfileQueryKey(), accountId];
}
