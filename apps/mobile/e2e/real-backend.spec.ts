import { expect, test } from '@playwright/test';

// 真后端 smoke — the ONE non-hermetic e2e journey (per 05-29-e2e-backend-
// hardening.md P2). Run ONLY via e2e/_support/real-backend-runner.ts, which
// stands up a real server (testcontainers PG+Redis) on :3000, does a
// programmatic login, and passes the REAL refreshToken in via env before
// invoking playwright.real-backend.config.ts.
//
// e2e-seed-auth-mock-check: real-backend-exempt — this spec seeds a REAL
// refreshToken and MUST hit the real backend, so the "seed-authed specs must
// stub GET /me" guard (scripts/checks/check-e2e-seed-auth-mock.ts) does not
// apply here. The marker is intentional; do NOT remove it.
//
// DELIBERATELY no mockJson / page.route: every API call (refresh-token + GET
// /me) hits the real backend. The only seeded state is a real refreshToken in
// the persisted auth store — mirroring a returning user whose Keychain holds a
// refresh token but no (in-memory-only) access token. This exercises the
// cold-boot bootstrap chain end-to-end: AuthGate rehydrate → refreshTokenFlow →
// real POST /accounts/refresh-token → real GET /me → AuthGate routes to tabs.

const ACCOUNT_ID = process.env['SMOKE_ACCOUNT_ID'];
const REFRESH_TOKEN = process.env['SMOKE_REFRESH_TOKEN'];
const DISPLAY_NAME = process.env['SMOKE_DISPLAY_NAME'] ?? '真后端冒烟';

if (!ACCOUNT_ID || !REFRESH_TOKEN) {
  throw new Error(
    'SMOKE_ACCOUNT_ID / SMOKE_REFRESH_TOKEN missing — run via `nx run mobile:e2e-real-backend` ' +
      '(real-backend-runner.ts), not `playwright test` directly.',
  );
}

// Persisted shape matches the zustand-persist `nvy-auth` partialize
// (apps/mobile/src/auth/store.ts): accountId + refreshToken + displayName +
// phone. No accessToken — it is in-memory only and re-derived via refresh on
// cold start, which is exactly the path this smoke validates.
const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: ${JSON.stringify(ACCOUNT_ID)},
        refreshToken: ${JSON.stringify(REFRESH_TOKEN)},
        displayName: ${JSON.stringify(DISPLAY_NAME)},
        phone: null,
      },
      version: 0,
    }),
  );
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

test.setTimeout(60_000);

test('seeded real refreshToken → real /refresh-token + /me → lands on authed tabs/profile', async ({
  page,
}) => {
  await page.goto('/');
  // networkidle waits for the real refresh + GET /me round-trips to settle.
  await page.waitForLoadState('networkidle', { timeout: 45_000 });

  // displayName came from the REAL GET /me (set via PATCH /me in the runner),
  // not from the seed — proves the live round-trip, not just hydration.
  await expect(page.getByText(DISPLAY_NAME)).toBeVisible();
  await expect(page).toHaveURL(/\/profile$|\(tabs\)\/profile/);
  // Hero chrome confirms we are inside the authed tabs shell, not /login.
  await expect(page.getByText('关注')).toBeVisible();
  await expect(page.getByText('粉丝')).toBeVisible();

  await page.screenshot({
    path: 'playwright-report/screenshots/real-backend-smoke-landing.png',
    fullPage: true,
  });
});
