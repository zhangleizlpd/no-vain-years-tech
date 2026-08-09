import { describe, expect, it } from 'vitest';

import { decideConsentGate, type ConsentGateInput } from './consent-gate-decision';

// Base = native, hydrated, no consent yet — the "fresh install first boot"
// shape. Individual cases override the axis under test.
const base: ConsentGateInput = {
  isWeb: false,
  hasHydrated: true,
  privacyConsentAt: null,
};

describe('decideConsentGate — 022 FR-011 / D7 首启隐私同意三态', () => {
  // ----- web branch (D7: web 不弹直接放行) ----- //

  it('web + no consent → allow (web never gates, even pre-hydration)', () => {
    expect(decideConsentGate({ ...base, isWeb: true, hasHydrated: false })).toEqual({
      kind: 'allow',
    });
  });

  it('web + consented → allow', () => {
    expect(
      decideConsentGate({ ...base, isWeb: true, privacyConsentAt: '2026-06-07T00:00:00.000Z' }),
    ).toEqual({ kind: 'allow' });
  });

  // ----- native pre-hydration (防闪: 不能在 persist 落地前误判「未同意」) ----- //

  it('native + !hasHydrated → splash (hold until persist rehydrates)', () => {
    expect(decideConsentGate({ ...base, hasHydrated: false })).toEqual({ kind: 'splash' });
  });

  it('native + !hasHydrated + (stale in-memory consent) → still splash', () => {
    expect(
      decideConsentGate({
        ...base,
        hasHydrated: false,
        privacyConsentAt: '2026-06-07T00:00:00.000Z',
      }),
    ).toEqual({ kind: 'splash' });
  });

  // ----- native post-hydration ----- //

  it('native + hydrated + no consent → consent (render privacy screen, FR-011)', () => {
    expect(decideConsentGate({ ...base })).toEqual({ kind: 'consent' });
  });

  it('native + hydrated + consented → allow (后续启动不再弹)', () => {
    expect(decideConsentGate({ ...base, privacyConsentAt: '2026-06-07T00:00:00.000Z' })).toEqual({
      kind: 'allow',
    });
  });
});
