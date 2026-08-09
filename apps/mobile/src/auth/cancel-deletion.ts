import { useCancelDeletionControllerCancelDeletion } from '@nvy/api-client';
import { useAuthStore } from './store';

// Wraps the Orval cancel-deletion mutation hook (EP4). On success the server
// has unfrozen the account (FROZEN→ACTIVE) and re-issued tokens — lift them into
// the auth store (setSession); AuthGate observes isAuthenticated and redirects.
// This hook does NOT navigate (mirrors usePhoneSmsAuth, FR-C04). Caller
// (useCancelDeletionForm) drives `mutateAsync({ data })` and reads `isPending`.
export function useCancelDeletion() {
  const setSession = useAuthStore((s) => s.setSession);
  return useCancelDeletionControllerCancelDeletion({
    mutation: {
      onSuccess: ({ data }) => {
        setSession({
          accountId: data.accountId,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        });
      },
    },
  });
}
