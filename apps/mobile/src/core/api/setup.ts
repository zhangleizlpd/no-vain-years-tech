/**
 * Mobile-side axios setup (per ADR-0027 + ADR-0036 + ADR-0038 + plan
 * 05-22-mono-meta-frontend-gap-audit.md A3).
 *
 * Registers global axios interceptors on the default instance used by
 * Orval-generated client functions (packages/api-client):
 *
 *   request:
 *     - baseURL from EXPO_PUBLIC_API_BASE_URL (else dev default)
 *     - x-trace-id auto-generated via expo-crypto.randomUUID() if not set
 *       → ties client log line + server CLS trace + ProblemDetail body
 *         .traceId per ADR-0036 cross-stack trace propagation
 *     - Authorization Bearer from useAuthStore.accessToken when present
 *       → consolidates the per-call manual header injection that
 *         packages/auth/src/store.ts.loadProfile used to do
 *     - x-device-id / x-device-name / x-device-type from useDeviceStore
 *       → server-side device-bound flows (异地登录提醒 / 设备列表 /
 *         refresh jti 白名单 per ADR-0037). id always present (synth
 *         lazily); name/type present once hydrate() resolves.
 *
 *   response:
 *     - transparent renewal (003-tokens US7): a 401 single-flights one
 *       refresh + retries the original request once with the new access
 *       token (refresh endpoint exempt; x-nvy-retry marker prevents a loop).
 *       Other errors flow back to React Query / useMutation via AxiosError;
 *       type guards in ./errors.ts narrow ProblemDetail shape.
 *
 * Call setupAxios() once at mobile boot (apps/mobile/app/_layout.tsx top
 * import). Subsequent imports are no-ops via the booted flag.
 */
import axios from 'axios';
import * as Crypto from 'expo-crypto';
import {
  getDeviceHeaders,
  makeAuthRefreshResponseInterceptor,
  useAuthStore,
  useDeviceStore,
} from '~/auth';

let booted = false;

export function setupAxios(): void {
  if (booted) return;
  booted = true;

  // Dot access (not `process.env['…']`) is REQUIRED: Expo/metro only static-
  // inlines `process.env.EXPO_PUBLIC_*` member access at build; bracket access
  // is left as a runtime lookup → `undefined` on web → silent localhost
  // fallback even when EXPO_PUBLIC_API_BASE_URL is set. (TS allows dot here:
  // noPropertyAccessFromIndexSignature is off.)
  const baseURL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';
  axios.defaults.baseURL = baseURL;

  // Fire-and-forget device hydrate so x-device-name / x-device-type are
  // populated by the time real API traffic flows. The first cold-start
  // request may carry only x-device-id (synth via getOrInitId); name/type
  // land on the next request after expo-device resolves.
  void useDeviceStore.getState().hydrate();

  axios.interceptors.request.use((config) => {
    // x-trace-id: only set if caller didn't supply one (cross-service
    // propagation case — e.g. test runner injecting deterministic id)
    config.headers = config.headers ?? {};
    if (!config.headers['x-trace-id']) {
      config.headers['x-trace-id'] = Crypto.randomUUID();
    }

    // x-device-*: id is always emitted; name/type only after hydrate.
    for (const [k, v] of Object.entries(getDeviceHeaders())) {
      if (!config.headers[k]) config.headers[k] = v;
    }

    // Authorization: read from auth store; only set if not already on call
    // (allows explicit override for refresh-token flow, smoke tests, etc.)
    if (!config.headers['Authorization']) {
      const accessToken = useAuthStore.getState().accessToken;
      if (accessToken) {
        config.headers['Authorization'] = `Bearer ${accessToken}`;
      }
    }

    return config;
  });

  // Transparent renewal (003-tokens US7): single-flight refresh + retry-once
  // on 401. Logic lives in ~/auth/token-refresh so it can own the session
  // store; here we just bind it to the shared axios instance.
  axios.interceptors.response.use(
    (response) => response,
    makeAuthRefreshResponseInterceptor(axios),
  );
}
