import { expect, test, type Page, type Route } from '@playwright/test';

// T024 — Expo Web e2e for 003-tokens US7 透明续期 (SC-C04).
//
// Pre-seeds nvy-auth with a STALE accessToken (present but server-rejected) to
// exercise *runtime* token expiry. (The cold-start no-token case is now handled
// proactively by AuthGate's rehydrateSession() before /me ever fires — see
// app/_layout.tsx — so it no longer produces a 401; the reactive interceptor is
// the net for tokens that expire mid-session.) On boot AuthGate issues GET /me
// carrying the stale Bearer → server 401 → the response interceptor (003-tokens
// T022) single-flights one POST /refresh-token, then retries GET /me with the
// fresh access token → 200 (displayName null) → onboarding. The nickname submit
// then PATCHes /me with the already-refreshed token → 200 → AuthGate redirects
// to /profile. Proves 401 → 透明续期 → 业务请求成功 end-to-end through the real
// client stack (axios response interceptor + Orval + RHF), not just unit mocks.
//
// Backend is mocked at the network boundary (page.route); server endpoints are
// covered by Testcontainers ITs (tokens.us2-rotate / accounts.us2-002). axios
// baseURL defaults to http://localhost:3000 → cross-origin vs the Expo web
// origin, so each route answers its CORS preflight (OPTIONS) too. Success is
// asserted via the post-redirect outcome (lands on /profile), per memory
// feedback_visual_smoke_unreachable_when_finally_clears_session.

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const NEW_NAME = '续期小明';
const REFRESHED_ACCESS = 'access-refreshed';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

// Seed an authed session whose accessToken is stale (present but server-rejected)
// so the first authenticated call 401s and exercises the runtime renewal path.
const seedAuthStaleAccessToken = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: 'acc-e2e-refresh-1',
        accessToken: 'access-e2e-stale',
        refreshToken: 'refresh-e2e-stale',
        displayName: null,
        phone: null,
      },
      version: 0,
    }),
  );
`;

const PREFLIGHT_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};

const CORS = { 'access-control-allow-origin': '*' };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStaleAccessToken);
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

// Metro web first compile can take 30-90s; subsequent navigations are fast.
test.setTimeout(120_000);

async function bootOnboarding(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('昵称', { exact: true })).toBeVisible({ timeout: 90_000 });
}

test('US7 — PATCH /me 401 → transparent refresh + retry once → redirect to profile (SC-C04)', async ({
  page,
}) => {
  let refreshCalls = 0;
  let meUnauthedCalls = 0;
  let meAuthedCalls = 0;

  // POST /refresh-token → rotated pair. This is the single-flight target.
  await page.route(REFRESH_URL, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: PREFLIGHT_HEADERS });
      return;
    }
    refreshCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        accountId: 'acc-e2e-refresh-1',
        accessToken: REFRESHED_ACCESS,
        refreshToken: 'refresh-e2e-rotated',
      }),
    });
  });

  // PATCH /me → 401 until the retry carries the refreshed access token, then 200.
  await page.route(ME_URL, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: PREFLIGHT_HEADERS });
      return;
    }
    if (route.request().headers()['authorization'] === `Bearer ${REFRESHED_ACCESS}`) {
      // AuthGate's GET /me (post-refresh) returns null → user stays on onboarding;
      // the form submit's PATCH /me returns the new name → AuthGate routes to tabs.
      if (route.request().method() !== 'PATCH') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: CORS,
          body: JSON.stringify({
            accountId: 'acc-e2e-refresh-1',
            phone: '+8613800138000',
            displayName: null,
            status: 'ACTIVE',
            createdAt: '2026-05-25T00:00:00.000Z',
          }),
        });
        return;
      }
      meAuthedCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          accountId: 'acc-e2e-refresh-1',
          phone: '+8613800138000',
          displayName: NEW_NAME,
          status: 'ACTIVE',
          createdAt: '2026-05-25T00:00:00.000Z',
        }),
      });
      return;
    }
    meUnauthedCalls += 1;
    await route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      headers: CORS,
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        code: 'INVALID_CREDENTIALS',
      }),
    });
  });

  await bootOnboarding(page);

  await page.getByLabel('昵称', { exact: true }).fill(NEW_NAME);
  await page.getByRole('button', { name: '提交' }).tap();

  // Transparent renewal happens behind the scenes: the failed PATCH never
  // surfaces to the user; AuthGate redirects once the retried PATCH succeeds.
  await page.waitForURL(/\/profile$|\(tabs\)\/profile/);
  await expect(page.getByText(NEW_NAME)).toBeVisible();

  // Single-flight: exactly one refresh; the PATCH was tried unauthed then
  // retried with the fresh token (FR-C01 / FR-C02).
  expect(refreshCalls).toBe(1);
  expect(meUnauthedCalls).toBeGreaterThanOrEqual(1);
  expect(meAuthedCalls).toBeGreaterThanOrEqual(1);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/t024-transparent-refresh.png`, fullPage: true });
});
