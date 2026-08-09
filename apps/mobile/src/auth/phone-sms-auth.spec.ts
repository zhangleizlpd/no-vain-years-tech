// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit = the wrapper's wiring (onSuccess → setSession with mapped tokens). Both
// deps are mocked: the Orval hook so we capture+drive its onSuccess, and ./store
// so the real expo-secure-store chain (which pulls Flow-typed react-native under
// the happy-dom browser condition) never loads. Store behaviour is store.spec.ts;
// real react-query/network is the e2e layer (T066).
const h = vi.hoisted(() => ({
  onSuccess: undefined as ((res: { data: unknown }) => void) | undefined,
  setSession: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('@nvy/api-client', () => ({
  useAccountPhoneSmsAuthControllerAuth: vi.fn(
    (opts?: { mutation?: { onSuccess?: (res: { data: unknown }) => void } }) => {
      h.onSuccess = opts?.mutation?.onSuccess;
      return { mutateAsync: vi.fn(), isPending: false, error: null };
    },
  ),
}));

vi.mock('./store', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { setSession: unknown }) => unknown) => selector({ setSession: h.setSession }),
    { setState: h.setState },
  ),
}));

import { usePhoneSmsAuth } from './phone-sms-auth';

describe('usePhoneSmsAuth', () => {
  beforeEach(() => {
    h.onSuccess = undefined;
    h.setSession.mockClear();
    h.setState.mockClear();
  });

  it('wires mutation onSuccess to setSession with the issued tokens', () => {
    renderHook(() => usePhoneSmsAuth());
    expect(h.onSuccess).toBeTypeOf('function');

    h.onSuccess?.({ data: { accountId: '42', accessToken: 'at', refreshToken: 'rt' } });

    expect(h.setSession).toHaveBeenCalledWith({
      accountId: '42',
      accessToken: 'at',
      refreshToken: 'rt',
    });
  });

  it('resets the persisted profile seed on login (different account ≠ prior name)', () => {
    renderHook(() => usePhoneSmsAuth());
    h.onSuccess?.({ data: { accountId: '42', accessToken: 'at', refreshToken: 'rt' } });

    // displayName/phone are cleared so a stale seed can't feed useMe's initialData
    // and skip onboarding / show the previous account's name. Token-refresh (same
    // account) goes through setSession and must NOT clear them — hence this lives
    // in the login wrapper, not setSession.
    expect(h.setState).toHaveBeenCalledWith({ displayName: null, phone: null });
  });
});
