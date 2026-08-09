// Crypto polyfill — must be the very first import so any subsequent module
// that touches globalThis.crypto.getRandomValues() sees the shim. Defensive:
// expo-crypto.randomUUID() in current stack (SDK 54 / RN 0.81) does NOT need
// this on iOS/Android/Web (uses native module + globalThis.crypto.randomUUID),
// but pinning the polyfill guards against future libs (uuid v9+, nanoid 5,
// etc.) that bypass expo-crypto and read getRandomValues directly.
import 'react-native-get-random-values';
import '../global.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, useNavigationContainerRef, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { initAlertPushBinding } from '~/alert/push-binding';
import { initAlertPush } from '~/alert/push-init';
import { shouldInitAlertPush } from '~/alert/push-init.rules';
import { useAuthStore, rehydrateSession } from '~/auth';
import { decideAuthRoute } from '~/core/auth-gate-decision';
import { queryClient } from '~/core/api/query-client';
import { setupAxios } from '~/core/api/setup';
import { useMe } from '~/core/api/use-me';
import { decideConsentGate } from '~/core/consent-gate-decision';
import { useConsentStore } from '~/core/consent-store';
import { ErrorBoundary } from '~/core/error-boundary';
import { PrivacyConsentScreen } from '~/core/privacy-consent-screen';

// One-shot axios install — baseURL + x-trace-id + Authorization Bearer
// interceptors (per ADR-0027 / ADR-0036 / ADR-0038). Idempotent (booted flag).
// Lives at module top so it runs once before any Orval-generated client
// function is invoked.
setupAxios();

// PHASE 1 PLACEHOLDER — splash visuals (logo / animation) deferred to mockup.
// Bare RN per ADR-0017 occupy-UI 4 boundaries.
function SplashPlaceholder() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>加载中…</Text>
    </View>
  );
}

// 022 FR-011 — first-boot privacy-policy gate, wrapped OUTSIDE AuthGate so a
// fresh native install sees the consent screen before login / any authed
// effect (rehydrateSession, /me) can fire. Web passes straight through (plan
// D7: web 零采集 SDK). Decision table is pure + unit-tested in
// ~/core/consent-gate-decision.ts; same persist-hydration splash pattern as
// AuthGate below (don't mistake "not yet rehydrated" for "never consented").
function ConsentGate({ children }: { children: React.ReactNode }) {
  const privacyConsentAt = useConsentStore((s) => s.privacyConsentAt);
  const [hasHydrated, setHasHydrated] = useState(() => useConsentStore.persist.hasHydrated());

  useEffect(() => {
    setHasHydrated(useConsentStore.persist.hasHydrated());
    return useConsentStore.persist.onFinishHydration(() => setHasHydrated(true));
  }, []);

  const decision = decideConsentGate({
    isWeb: Platform.OS === 'web',
    hasHydrated,
    privacyConsentAt,
  });

  // 022 T011 — push init 的唯一调用点（FR-001 同意前零初始化）。双 gate
  // (consented && android) 是纯函数，web / iOS / 未同意全为 no-op；同意动作
  // 触发 privacyConsentAt 翻非空 → effect 重跑 → 首启同意当场 init，无需重启。
  const consented = privacyConsentAt !== null;
  useEffect(() => {
    if (shouldInitAlertPush({ platform: Platform.OS, consented })) {
      void initAlertPush();
      // RegID 上报/登出解绑生命周期（T012）— 同 gate 内一次性挂载
      initAlertPushBinding();
    }
  }, [consented]);

  if (decision.kind === 'splash') return <SplashPlaceholder />;
  if (decision.kind === 'consent') return <PrivacyConsentScreen />;
  return <>{children}</>;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const segments = useSegments();
  const router = useRouter();
  const navRef = useNavigationContainerRef();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [navReady, setNavReady] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(() => useAuthStore.persist.hasHydrated());

  // GET /me — disabled until authenticated; on success it rehydrates
  // displayName / accountId / phone into the store (see use-me.ts). `isFetched`
  // flips true once the query settles (success OR error, never deadlocks), and
  // gates the AuthGate decision: a returning user whose LoginResponse omits
  // displayName (byte-level anti-enumeration, phone-sms-auth.response.ts) is
  // held on a splash until /me lands instead of flashing /(app)/onboarding.
  const profile = useMe();
  const profileLoaded = profile.isFetched;

  // Route on the /me query value — the single runtime source of truth. On cold
  // boot useMe seeds initialData from the persisted store snapshot (see
  // use-me.ts), so profile.data is populated synchronously and a returning user
  // routes straight to profile without a splash. Never read store.displayName
  // here: it's a write-only boot seed, and reading it let a stale cached null
  // clobber a freshly-set name and bounce the user to onboarding.
  const effectiveDisplayName = profile.data?.displayName ?? null;

  // Wait for the navigation container to actually mount before any
  // router.replace — Expo Router asserts navigationRef.isReady() and throws
  // "Attempted to navigate before mounting the Root Layout component" otherwise.
  useEffect(() => {
    if (navRef.isReady()) {
      setNavReady(true);
      return;
    }
    const unsubscribe = navRef.addListener('state', () => {
      if (navRef.isReady()) setNavReady(true);
    });
    return unsubscribe;
  }, [navRef]);

  // Subscribe to persist rehydration. US12 demands AuthGate render a splash
  // (not jump routes) while displayName / refreshToken are still being
  // pulled out of SecureStore — otherwise the user sees a flash of
  // /(auth)/login between cold boot and rehydrate.
  useEffect(() => {
    setHasHydrated(useAuthStore.persist.hasHydrated());
    return useAuthStore.persist.onFinishHydration(() => setHasHydrated(true));
  }, []);

  // Cold-start proactive token refresh. accessToken is in-memory only (store.ts
  // partialize), so on a browser reload / app cold boot the persisted refreshToken
  // rehydrates but accessToken is null. Exchange it here — BEFORE useMe's /me fires
  // (gated on accessToken, see use-me.ts) — so the first authed call carries a
  // Bearer and never 401s. rehydrateSession self-noops when accessToken already
  // present (fresh login) or no refreshToken (logged out); the 401 response
  // interceptor remains the runtime-expiry fallback. Runs once after hydration.
  useEffect(() => {
    if (!hasHydrated) return;
    void rehydrateSession();
  }, [hasHydrated]);

  const decision = decideAuthRoute({
    isAuthenticated,
    displayName: effectiveDisplayName,
    profileLoaded,
    inAuthGroup: segments[0] === '(auth)',
    inOnboarding: segments.includes('onboarding'),
    inAppGroup: segments[0] === '(app)',
  });
  const redirectTarget = decision.kind === 'replace' ? decision.target : null;

  useEffect(() => {
    if (!navReady || !hasHydrated) return;
    if (redirectTarget) {
      router.replace(redirectTarget as Parameters<typeof router.replace>[0]);
    }
  }, [navReady, hasHydrated, redirectTarget, router]);

  // `wait` = authenticated but displayName still null while /me is in flight —
  // hold the splash rather than let `children` paint onboarding for a frame.
  if (!hasHydrated) return <SplashPlaceholder />;
  if (decision.kind === 'wait') return <SplashPlaceholder />;
  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <StatusBar style="auto" />
          {/* 全 app 键盘避让底座（react-native-keyboard-controller）。edge-to-edge
              下传 translucent 让键盘 inset 计算正确；Modal 内的输入框避让靠它兜底。 */}
          <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
            <ConsentGate>
              <AuthGate>
                <Stack screenOptions={{ headerShown: false }} />
              </AuthGate>
            </ConsentGate>
          </KeyboardProvider>
        </SafeAreaProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
