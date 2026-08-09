// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit = the wrapper's wiring (onSuccess → WRITE-THROUGH setQueryData into the
// per-account /me cache, the single source of truth). Deps mocked: the Orval hook
// (capture + drive its onSuccess), react-query's useQueryClient (capture the
// setQueryData call), ./store (getState().accountId), and the api-client query-key
// factory. Real react-query / network is the e2e layer (T046).
const h = vi.hoisted(() => ({
  onSuccess: undefined as ((res: unknown) => void) | undefined,
  setQueryData: vi.fn(),
}));

vi.mock('@nvy/api-client', () => ({
  useAccountProfileControllerUpdateDisplayName: vi.fn(
    (opts?: { mutation?: { onSuccess?: (res: unknown) => void } }) => {
      h.onSuccess = opts?.mutation?.onSuccess;
      return { mutateAsync: vi.fn(), isPending: false, error: null };
    },
  ),
  getAccountProfileControllerGetProfileQueryKey: vi.fn(() => ['/api/v1/accounts/me']),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: h.setQueryData }),
}));

vi.mock('./store', () => ({
  useAuthStore: Object.assign(vi.fn(), { getState: () => ({ accountId: '42' }) }),
}));

import { useUpdateDisplayName } from './update-display-name';

describe('useUpdateDisplayName', () => {
  beforeEach(() => {
    h.onSuccess = undefined;
    h.setQueryData.mockClear();
  });

  it('write-through: onSuccess seeds the per-account /me cache with the PATCH response', () => {
    renderHook(() => useUpdateDisplayName());
    expect(h.onSuccess).toBeTypeOf('function');

    const response = {
      data: { accountId: '42', phone: '+8613800138000', displayName: '小明', status: 'ACTIVE' },
    };
    h.onSuccess?.(response);

    // key is scoped by accountId; the whole response (pre-select) is cached so
    // useMe's `select` extracts `.data` for every reader without a refetch.
    expect(h.setQueryData).toHaveBeenCalledWith(['/api/v1/accounts/me', '42'], response);
  });

  it('does not navigate (AuthGate owns the redirect)', () => {
    // The wrapper exposes only the mutation object; it pulls no router. This is a
    // structural guarantee — onSuccess touches the cache, nothing else.
    const { result } = renderHook(() => useUpdateDisplayName());
    expect(result.current).toHaveProperty('mutateAsync');
    expect(result.current).not.toHaveProperty('replace');
  });
});
