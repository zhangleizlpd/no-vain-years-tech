import { describe, expect, it } from 'vitest';
import type { AccountProfileResponse, PhoneSmsAuthResponse } from '@nvy/api-client';

// Contract guard for the Expo Web e2e backend stubs (per
// docs/private/plans/2026-05/05-29-e2e-backend-boundary-hardening.md P2).
//
// The e2e suite stubs the backend at the network boundary (e2e/_support/
// api-mock.ts). Those stub bodies must stay shape-compatible with the REAL API,
// or a server DTO change silently rots the mocks while e2e stays green — a false
// signal. These `satisfies` assertions pin the canonical stub shapes to the
// generated @nvy/api-client types (Orval ← server openapi.json). If a server DTO
// gains / renames / drops a field, `pnpm nx affected --target=generate`
// regenerates the type and BOTH `nx typecheck mobile` and `nx test mobile` fail
// HERE — surfacing the drift instead of letting the stub diverge. Lightweight by
// design (no Pact); the type IS the contract assertion.
//
// Why this lives in src/ and not e2e/: apps/mobile/tsconfig.json excludes e2e/
// (Playwright/Node context, not React Native), so e2e specs are not tsc-checked
// — a guard there would never fire. src/ is covered by nx typecheck + test.
// Coupling the e2e stub builders directly to these shapes is a follow-up (would
// need a dedicated e2e tsconfig so e2e/ gets typecheck coverage too).

// GET /me → AccountProfileResponse. displayName null → AuthGate onboarding;
// a set name → tabs. (account-profile.controller.ts)
const ME_PROFILE_STUB = {
  accountId: 'acc-e2e-1',
  phone: '+8613800138000',
  displayName: '小明',
  bio: null,
  gender: null,
  avatarUrl: null,
  backgroundImageUrl: null,
  status: 'ACTIVE',
  createdAt: '2026-05-25T00:00:00.000Z',
  wechatBound: false,
  isAdmin: false,
} satisfies AccountProfileResponse;

// Login (phone-sms-auth) AND refresh-token both return PhoneSmsAuthResponse
// server-side (account-token.controller.ts reuses it).
const AUTH_TOKENS_STUB = {
  accountId: 'acc-e2e-1',
  accessToken: 'access-e2e-1',
  refreshToken: 'refresh-e2e-1',
} satisfies PhoneSmsAuthResponse;

describe('e2e backend stub ↔ @nvy/api-client contract', () => {
  it('GET /me stub conforms to AccountProfileResponse (server DTO drift → typecheck/test red)', () => {
    expect(ME_PROFILE_STUB.accountId).toBeTypeOf('string');
    expect(ME_PROFILE_STUB.displayName).toBe('小明');
  });

  it('login / refresh stub conforms to PhoneSmsAuthResponse', () => {
    expect(AUTH_TOKENS_STUB.accessToken).toBeTypeOf('string');
    expect(AUTH_TOKENS_STUB.refreshToken).toBeTypeOf('string');
  });
});
