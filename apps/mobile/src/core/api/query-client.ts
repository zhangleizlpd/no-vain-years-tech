import { QueryClient } from '@tanstack/react-query';

/**
 * Singleton React Query client (per ADR-0027).
 *
 * Defaults:
 *   - staleTime 30s — most account/profile-style data refetches on focus
 *     or window-regain are wasteful within a 30s window
 *   - retry 1 — react-query default 3 amplifies transient failures into
 *     long perceived wait; the axios interceptor already routes 5xx
 *     errors to Error Boundary so one retry is enough to mask flaky-
 *     network blips without hiding genuine outages
 *   - refetchOnWindowFocus false — mobile pattern (web-only concept)
 *
 * Exported as a module-level singleton so QueryClientProvider in
 * _layout.tsx + any direct queryClient.invalidateQueries() call from
 * mutation onSuccess share the same cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
