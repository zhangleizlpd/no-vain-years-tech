import {
  useAccountDeletionControllerSendDeletionCodeForMe,
  useAccountDeletionControllerSubmitDeletionForMe,
} from '@nvy/api-client';

import { useAuthStore } from './store';
import { queryClient } from '~/core/api/query-client';

// Account-deletion mutation wrappers (004 US10, FR-C01/C02). Both are authed
// (JwtAuthGuard) — axios attaches the bearer token from the store. Neither hook
// navigates; the caller (useDeleteAccountForm) drives mutateAsync + reads
// isPending, and the screen routes on success.

// EP1 — request a DELETE_ACCOUNT SMS code. No request body (server derives the
// account from the bearer token). Returns the raw mutation so the form hook can
// await mutateAsync() and read isPending.
export function useRequestDeletionCode() {
  return useAccountDeletionControllerSendDeletionCodeForMe();
}

// EP2 — submit the 6-digit code → server freezes the account (ACTIVE→FROZEN,
// 15-day grace) and revokes all refresh tokens. The local session is now
// orphaned, so clear it on success (mirror logout-all). AuthGate observes
// isAuthenticated=false and routes to login; the screen also router.replace's
// for an immediate transition.
export function useDeleteAccount() {
  return useAccountDeletionControllerSubmitDeletionForMe({
    mutation: {
      onSuccess: () => {
        useAuthStore.getState().clearSession();
        // Tie cache to auth: drop the (now-orphaned) account's server-state
        // caches so they can't bleed into the next account on this client.
        queryClient.clear();
      },
    },
  });
}
