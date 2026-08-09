import { defineConfig, devices } from '@playwright/test';

// D12 — Playwright drives Expo Web build of apps/mobile. expo-secure-store
// falls back to localStorage on web; tests assume that pathway.
//
// Screenshots from page.screenshot() land under playwright-report/screenshots
// (per plan.md § Architecture Notes — Mobile side, Playwright Expo Web).
const PORT = Number(process.env['EXPO_WEB_PORT'] ?? 4173);

export default defineConfig({
  testDir: './e2e',
  // Two specs are excluded from the markets-ON dev-server suite:
  //   - real-backend.spec.ts — the ONE non-hermetic spec; needs a real server +
  //     SMOKE_* env, runs ONLY via playwright.real-backend.config.ts. Picking it
  //     up here would crash at its import-time env guard.
  //   - markets-feature-gate.spec.ts — asserts markets is OFF; under this
  //     markets-ON bundle every assertion (tab hidden, deep-link redirect) flips
  //     to false. It runs ONLY via playwright.markets-off.config.ts (e2e-public).
  testIgnore: ['real-backend.spec.ts', 'markets-feature-gate.spec.ts'],
  outputDir: './playwright-test-results',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // Each spec stubs its own network boundary (per 05-29-e2e-backend-boundary-
  // hardening P1), so the suite is hermetic and parallel-safe — workers:1 is no
  // longer needed to avoid storageState cross-talk. retries:1 + trace stays only
  // as a flake probe (quarantine + fix root cause, per Fowler nonDeterminism),
  // NOT as the retries:2 mask that previously hid env-dependent failures.
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // hasTouch enables locator.tap() — RN-driven mobile UI uses Pressable
      // which fires onPress via touchend; without this Playwright throws
      // "page does not support tap". Mirrors the on-device user gesture.
      use: { ...devices['Desktop Chrome'], hasTouch: true },
    },
  ],
  webServer: {
    // Expo's web dev server warms Metro + bundles RN→DOM via react-native-web
    // (transitively installed via expo + nativewind). reuseExistingServer keeps
    // local iterations fast; CI always boots a fresh instance.
    // EXPO_PUBLIC_OSS_PUBLIC_BASE_URL: build-time-inlined (use-ideation-session
    // statically reads process.env.EXPO_PUBLIC_OSS_PUBLIC_BASE_URL). The 036
    // ideation-image-annotation reload spec (⑦) hydrates persisted image-turn
    // ossKeys into thumbnail URLs via this prefix; without it hydratedAttachmentUris
    // returns [] and the reload thumbnail won't render. Hermetic test host
    // (oss-e2e.example.com) whose thumbnail GETs are answered by route.fulfill in
    // that spec. Harmless to other specs (only ideation session reload reads it).
    command: `EXPO_PUBLIC_OSS_PUBLIC_BASE_URL=https://oss-e2e.example.com pnpm exec expo start --web --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
