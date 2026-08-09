// Pure gating decision for ConsentGate (apps/mobile/app/_layout.tsx). Extracted
// so the 022 FR-011 truth table can be unit-tested without mocking
// react-native / zustand persist — same pattern as auth-gate-decision.ts.
//
// States:
//   1. web                              → allow   (D7: web 零采集 SDK，不弹直接放行)
//   2. native + persist not hydrated    → splash  (防闪: 等 AsyncStorage 落地，
//                                                  不能把「还没读到」误判成「未同意」)
//   3. native + hydrated + no consent   → consent (渲染全屏隐私政策屏，FR-011)
//   4. native + hydrated + consented    → allow   (同意持久化后，后续启动不再弹)
//
// `privacyConsentAt` is the consent-store persisted ISO timestamp (null = never
// consented). Web short-circuits BEFORE the hydration check: the gate is a
// native-only compliance surface, so web must never sit on a splash waiting for
// a store it doesn't consult.

export interface ConsentGateInput {
  isWeb: boolean;
  hasHydrated: boolean;
  privacyConsentAt: string | null;
}

export type ConsentGateDecision = { kind: 'allow' } | { kind: 'splash' } | { kind: 'consent' };

export function decideConsentGate(input: ConsentGateInput): ConsentGateDecision {
  const { isWeb, hasHydrated, privacyConsentAt } = input;

  if (isWeb) return { kind: 'allow' };
  if (!hasHydrated) return { kind: 'splash' };
  return privacyConsentAt !== null ? { kind: 'allow' } : { kind: 'consent' };
}
