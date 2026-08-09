import { expect, test, type Page } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// T046 — Expo Web e2e for the onboarding displayName form slice (002 US13).
//
// Pre-seeds nvy-auth with displayName=null so onRehydrateStorage marks the store
// authenticated and AuthGate (decideAuthRoute 第二态) lands on /(app)/onboarding.
// Submitting a valid nickname PATCHes /me (mocked), the wrapper writes
// store.displayName, and AuthGate redirects into /(app)/(tabs)/profile.
//
// Backend is mocked at the network boundary (page.route); the server PATCH /me is
// covered end-to-end by T023 (Testcontainers). This spec exercises the full
// *client* stack (RHF → useOnboardingForm → useUpdateDisplayName → Orval/axios → UI).
// axios baseURL defaults to http://localhost:3000, so traffic is cross-origin vs
// the Expo web origin; mockJson answers the CORS preflight too.
//
// Success is asserted via the *post-redirect outcome* (lands on /profile), not the
// transient SuccessOverlay frame: the hook does NOT clear anything on success, so
// AuthGate redirects within a frame or two — too fast to catch reliably (per memory
// feedback_visual_smoke_unreachable_when_finally_clears_session).

const ME_URL = '**/api/v1/accounts/me';
const NEW_NAME = '小明';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const seedAuthNoDisplayName = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: 'acc-e2e-onboarding-1',
        // accessToken present: a just-logged-in user lands on onboarding with a
        // live token in memory. AuthGate's rehydrateSession self-noops, useMe
        // (gated on accessToken) fires GET /me with the Bearer → no cold-start 401.
        accessToken: 'access-e2e-onboarding-1',
        refreshToken: 'refresh-e2e-1',
        displayName: null,
        phone: null,
      },
      version: 0,
    }),
  );
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthNoDisplayName);
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

// Metro web first compile can take 30-90s; subsequent navigations are fast.
test.setTimeout(120_000);

// Cold boot at `/`; AuthGate (authed + displayName null) replaces into
// /(app)/onboarding, whose group prefix is stripped from the web URL. Resolve
// once the nickname field has painted so the slow first bundle doesn't flake.
async function bootOnboarding(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('昵称', { exact: true })).toBeVisible({ timeout: 90_000 });
}

test('US13 happy — fill nickname → PATCH /me → redirect into (tabs)/profile (SC-019)', async ({
  page,
}) => {
  // AuthGate's cold-boot GET /me: a new user has no name yet → null → stays on
  // onboarding (the wait gate settles, then routes to onboarding).
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: 'acc-e2e-onboarding-1',
      phone: '+8613800138000',
      displayName: null,
      status: 'ACTIVE',
      createdAt: '2026-05-25T00:00:00.000Z',
    },
    'GET',
  );
  // Form submit PATCHes /me → new name → store.displayName set → redirect.
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: 'acc-e2e-onboarding-1',
      phone: '+8613800138000',
      displayName: NEW_NAME,
      status: 'ACTIVE',
      createdAt: '2026-05-25T00:00:00.000Z',
    },
    'PATCH',
  );

  await bootOnboarding(page);

  // FR-036 a11y — interactive controls expose accessible names.
  await expect(page.getByLabel('昵称', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '提交' })).toBeVisible();

  await page.getByLabel('昵称', { exact: true }).fill(NEW_NAME);
  await page.getByRole('button', { name: '提交' }).tap();

  // setDisplayName (mutation onSuccess) flips displayName; AuthGate redirects.
  await page.waitForURL(/\/profile$|\(tabs\)\/profile/);
  await expect(page.getByText(NEW_NAME)).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/t046-onboarding-success.png`, fullPage: true });
});

test('US13 error — invalid nickname (400) → ErrorRow alert, stays on onboarding', async ({
  page,
}) => {
  await mockJson(page, ME_URL, 400, {
    type: 'about:blank',
    title: 'Bad Request',
    status: 400,
    detail: 'INVALID_DISPLAY_NAME',
  });

  await bootOnboarding(page);
  await page.getByLabel('昵称', { exact: true }).fill(NEW_NAME);
  await page.getByRole('button', { name: '提交' }).tap();

  // FR-034 invalid mapping → shared ErrorRow (alert). No redirect — displayName
  // was never set in the store.
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('昵称不合法，请重试');
  await expect(page).toHaveURL(/onboarding/);

  // Editing the field clears the error (error → idle, FR-034).
  await page.getByLabel('昵称', { exact: true }).fill('小红');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
