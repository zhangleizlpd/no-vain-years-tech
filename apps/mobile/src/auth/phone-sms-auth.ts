import { useAccountPhoneSmsAuthControllerAuth } from '@nvy/api-client';
import { useAuthStore } from './store';

// Wraps the Orval phone-sms-auth mutation hook. On success, lifts the issued
// tokens into the auth store (setSession); AuthGate observes isAuthenticated and
// redirects — this hook does NOT navigate (FR-C05). Caller (useLoginForm) drives
// `mutateAsync({ data })` and reads `isPending` / `error` for UI state.
export function usePhoneSmsAuth() {
  const setSession = useAuthStore((s) => s.setSession);
  return useAccountPhoneSmsAuthControllerAuth({
    mutation: {
      onSuccess: ({ data }) => {
        setSession({
          accountId: data.accountId,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        });
        // Reset the persisted profile seed on LOGIN (not in setSession, which is
        // also called by token-refresh for the SAME account and must preserve the
        // seed). A login may be a different account than the last one persisted;
        // clearing displayName/phone stops a stale seed from feeding useMe's
        // initialData and skipping onboarding / showing the prior account's name.
        // useMe rehydrates the real values once GET /me lands.
        useAuthStore.setState({ displayName: null, phone: null });
      },
    },
  });
}
