// Full-device logout wrapper for the auth module (003-tokens US8 client).
//
// Calls the server logout-all endpoint, then UNCONDITIONALLY clears the local
// session in `finally` — even if the server call fails the user is logged out
// locally (residual server-side records self-expire). Server failure must not
// block the logout (FR-C05). AuthGate observes isAuthenticated and routes to
// login; this wrapper does not navigate.
//
// No user-visible logout button ships here — that lands with the settings
// shell (separate spec). This is the logic the button will call.

import { accountTokenControllerLogoutAll } from '@nvy/api-client';

import { useAuthStore } from './store';
import { queryClient } from '~/core/api/query-client';

// Pre-logout seam (022 T012): alert/push-binding registers a best-effort
// push-unbind here at init. Inverted (hook, not a direct import of ~/alert)
// so auth keeps zero cross-feature deps and no import cycle. MUST run before
// the server call below — logout-all revokes the tokens server-side, after
// which DELETE push-binding would 401.
let preLogoutHook: (() => Promise<void>) | null = null;

export function setPreLogoutHook(hook: (() => Promise<void>) | null): void {
  preLogoutHook = hook;
}

export async function logoutAll(): Promise<void> {
  if (preLogoutHook) {
    try {
      await preLogoutHook();
    } catch {
      // Best-effort: hook failures (offline unbind) must not block logout.
    }
  }
  try {
    await accountTokenControllerLogoutAll();
  } catch {
    // Swallow: a failed server call must not block local logout. The local
    // session is cleared in `finally` regardless; orphaned server records
    // expire on their own.
  } finally {
    useAuthStore.getState().clearSession();
    // Wipe ALL React Query caches — /me, device list, etc. are server-owned and
    // statically keyed; leaving them lets the NEXT account on this client read
    // the previous account's cached data (cross-account bleed). Cache lifecycle
    // is tied to auth: logout ⇒ clear.
    queryClient.clear();
  }
}
