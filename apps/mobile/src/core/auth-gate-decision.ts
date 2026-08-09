// Pure routing decision for AuthGate (apps/mobile/app/_layout.tsx). Extracted
// so the truth table (per spec FR-014 / CL-009 决议) can be unit-tested without
// mocking expo-router / react-native.
//
// States:
//   1. !isAuthenticated                            → /(auth)/login
//   2. auth + displayName == null + !profileLoaded → wait (hold splash)
//   3. auth + displayName == null + profileLoaded  → /(app)/onboarding
//   4. auth + displayName != null                  → /(app)/(tabs)/profile
//
// `displayName` here is the /me query value (apps/mobile/src/core/api/use-me.ts
// is the single runtime source of truth — NOT the auth store). State 2 (`wait`)
// closes the fresh-login backfill gap: a returning user with a set displayName
// logs in carrying only tokens — LoginResponse omits displayName for byte-level
// anti-enumeration (see apps/server/src/auth/phone-sms-auth.response.ts), so
// profile.data is undefined until GET /me lands. Without the gate AuthGate would
// flash /(app)/onboarding before the profile arrives. We hold a splash until the
// query settles, then route on the real displayName. Cold-start returning users
// skip the wait — useMe seeds initialData from the persisted store snapshot
// (store.ts partialize), so profile.data is populated synchronously and state 4
// hits directly.

export interface AuthGateInput {
  isAuthenticated: boolean;
  displayName: string | null;
  // GET /me has settled (success OR error); false while the profile query is in
  // flight or disabled. Gates the displayName==null branch so a returning user
  // is not misrouted to onboarding before /me rehydrates displayName.
  profileLoaded: boolean;
  inAuthGroup: boolean;
  inOnboarding: boolean;
  // True when anywhere inside the /(app)/* group (tabs, settings, onboarding,
  // and any future authed screen). The authed+named branch treats every (app)
  // route as a valid location (except onboarding), so new routes need no gate
  // change — replaces the old per-route `inTabs`/`inSettings` whitelist.
  inAppGroup: boolean;
}

export type AuthGateDecision =
  | { kind: 'noop' }
  | { kind: 'wait' }
  | { kind: 'replace'; target: string };

export function decideAuthRoute(input: AuthGateInput): AuthGateDecision {
  const { isAuthenticated, displayName, profileLoaded, inAuthGroup, inOnboarding, inAppGroup } =
    input;

  if (!isAuthenticated) {
    if (inAuthGroup) return { kind: 'noop' };
    return { kind: 'replace', target: '/(auth)/login' };
  }

  if (displayName === null) {
    // Already on onboarding (a genuine new user filling the form) — stay put;
    // don't flash a splash over their input regardless of profile-load state.
    if (inOnboarding) return { kind: 'noop' };
    // Profile not settled yet → hold a splash rather than assume "new user".
    if (!profileLoaded) return { kind: 'wait' };
    return { kind: 'replace', target: '/(app)/onboarding' };
  }

  // isAuthenticated + displayName != null. Every /(app)/* screen is a valid
  // location for a named user EXCEPT onboarding (they already have a name).
  // Redirect to profile only from genuinely wrong/transient positions: the
  // (auth) group, the bare root `/` (app/index.tsx renders null → the #79
  // cold-boot blank screen), or a stale onboarding screen. Leaving every other
  // (app) route alone (tabs, settings, future authed screens) means new routes
  // need no change here — this is a blocklist, not a per-route whitelist.
  if (inAppGroup && !inOnboarding) return { kind: 'noop' };
  return { kind: 'replace', target: '/(app)/(tabs)/profile' };
}
