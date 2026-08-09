import { defineConfig, devices } from '@playwright/test';

// Runtime-smoke variant of playwright.config.ts.
//
// Differences from playwright.config.ts (per ADR-0040 multi-layer test gate
// strategy / sub-plan 2):
//   - webServer.command serves the static `expo export -p web` output via
//     `serve --single` (history-api-fallback ON for Expo Router paths)
//     instead of running the Metro dev server. CI-friendly: 1-5s cold boot
//     vs 15-30s for `expo start --web`; bit-stable bundle = no Metro
//     race conditions.
//   - reuseExistingServer is always false — runtime-smoke must boot a fresh
//     server every run to catch state drift (we do NOT want a stale serve
//     process from a previous failed run masking new errors).
//
// All other config (testDir / projects / hasTouch / outputs) mirrors the
// dev-server config so the same Playwright spec files run unchanged.
const PORT = Number(process.env['EXPO_WEB_PORT'] ?? 4173);

export default defineConfig({
  testDir: './e2e',
  // Two specs are excluded from the markets-ON runtime-smoke suite:
  //   - real-backend.spec.ts — the ONE non-hermetic spec; needs a real server +
  //     SMOKE_* env, runs ONLY via playwright.real-backend.config.ts. Picking it
  //     up here would crash at its import-time env guard.
  //   - markets-feature-gate.spec.ts — asserts markets is OFF; this static export
  //     is built markets-ON, so its assertions would all flip. It runs ONLY via
  //     playwright.markets-off.config.ts (e2e-public).
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
  // `list` prints per-test pass/fail + the failure stack to stdout so CI logs
  // are legible (the html reporter writes a folder only — a failure under it
  // alone shows up in CI as a bare "Failed tasks" with no test name). `github`
  // adds inline ::error:: annotations on the PR diff. html stays for the full
  // trace/screenshot bundle uploaded as a CI artifact on failure.
  reporter: process.env['CI']
    ? [['list'], ['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], hasTouch: true },
    },
  ],
  webServer: {
    // `serve --single` serves the export with history-api-fallback (Expo Router
    // requires this — any /profile etc. must resolve to index.html on hit).
    // `-l tcp://127.0.0.1:${PORT}` pins to IPv4 (avoids dual-stack flake).
    //
    // Serves `dist-runtime-smoke/`, NOT `dist/` — a dedicated output dir so this
    // OSS-env export never clobbers `mobile:build`'s plain `dist/` when nx runs
    // both concurrently (issue #625, orthogonal dist-clobber guard).
    //
    // The PRIMARY #625 fix lives in metro.config.js: Metro's transform-cache key
    // omits EXPO_PUBLIC_* values, so `mobile:build` (no OSS env) and this target
    // (OSS env) running concurrently on a shared Metro cache cross-poisoned the
    // inlined value → the served bundle lost EXPO_PUBLIC_OSS_PUBLIC_BASE_URL →
    // only FR-009/FR-010 image specs failed. metro.config now folds EXPO_PUBLIC_*
    // into `cacheVersion`, so divergent-env exports get distinct cache keys and
    // can never cross-poison — concurrency-safe with no serialization needed.
    command: `pnpm exec serve dist-runtime-smoke --single --listen tcp://127.0.0.1:${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
