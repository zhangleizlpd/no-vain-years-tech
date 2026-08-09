import { defineConfig, devices } from '@playwright/test';

// 真后端 smoke config (per 05-29-e2e-backend-boundary-hardening.md P2).
//
// Driven exclusively by e2e/_support/real-backend-runner.ts, which has ALREADY
// stood up a real server on :3000 (testcontainers PG+Redis) and done a
// programmatic login before invoking `playwright test -c` this file. So unlike
// playwright[.runtime-smoke].config.ts:
//   - testMatch is pinned to the single real-backend spec (the rest of the e2e
//     suite is hermetic/stubbed and must NOT run against a real backend here).
//   - NO network stubbing anywhere in the spec — the whole point is to hit the
//     real backend; the only injected state is a REAL refreshToken (env).
//   - retries:0 — a real-backend smoke that flakes is a signal to investigate,
//     not to retry (per Fowler nonDeterminism; the runner is the quarantine).
//   - webServer serves the static `expo export -p web` output (like
//     runtime-smoke); the API server is the runner's child, not webServer's.
const PORT = Number(process.env['EXPO_WEB_PORT'] ?? 4173);

export default defineConfig({
  testDir: './e2e',
  testMatch: 'real-backend.spec.ts',
  outputDir: './playwright-test-results',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
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
    command: `pnpm exec serve dist --single --listen tcp://127.0.0.1:${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
