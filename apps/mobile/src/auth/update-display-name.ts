import { useAccountProfileControllerUpdateDisplayName } from '@nvy/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from './store';
import { meQueryKey } from '~/core/api/me-query-key';

// Wraps the Orval update-display-name (PATCH /me) mutation. On success it does a
// WRITE-THROUGH into the /me cache (the single source of truth): the PATCH
// returns the full updated profile, so seeding the cache makes every reader —
// AuthGate and any screen that mounts useMe — see the new name immediately,
// without a refetch and without a stale cached value bouncing the user back to
// onboarding. The persisted store boot-seed is propagated by useMe's effect off
// this same cache update. This hook does NOT navigate (FR-032 / FR-014); AuthGate
// observes displayName != null and redirects. Caller drives mutateAsync({ data }).
export function useUpdateDisplayName() {
  const queryClient = useQueryClient();
  return useAccountProfileControllerUpdateDisplayName({
    mutation: {
      onSuccess: (response) => {
        queryClient.setQueryData(meQueryKey(useAuthStore.getState().accountId), response);
      },
    },
  });
}
