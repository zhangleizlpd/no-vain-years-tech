import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// profile-state-coherence — Expo Web e2e for the two displayName/profile bugs the
// single-source-of-truth refactor fixes (fix/profile-state-coherence):
//
//   1. 回跳: a freshly-onboarded user, after setting a name and reaching profile,
//      navigates into 设置 → 账号与安全 and must STAY — pre-fix a mounting useMe
//      consumer re-synced a stale cached `displayName:null` into the store and
//      bounced them back to /onboarding.
//   2. 跨账号泄漏: after logout A → login B, account B must NOT see A's cached
//      profile — pre-fix the static /me key + never-cleared cache handed B the
//      previous account's name/avatar.
//
// Both are asserted against the *client* stack with the backend mocked at the
// network boundary (page.route answers CORS preflight too — axios baseURL is the
// cross-origin localhost:3000). URL assertions use web-stripped paths (expo-router
// strips `(group)/` segments, per memory expo_router_web_hides_route_groups).

const ME_URL = '**/api/v1/accounts/me';
const SMS_CODES_URL = '**/api/v1/accounts/sms-codes';
const PHONE_SMS_AUTH_URL = '**/api/v1/accounts/phone-sms-auth';
const LOGOUT_ALL_URL = '**/api/v1/accounts/logout-all';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const CORS_PREFLIGHT = {
  status: 204,
  headers: {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  },
};

function profileBody(accountId: string, displayName: string | null) {
  return {
    accountId,
    phone: '+8613800138000',
    displayName,
    bio: null,
    gender: null,
    status: 'ACTIVE',
    createdAt: '2026-05-30T00:00:00.000Z',
  };
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

test.beforeEach(async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

// Metro web first compile can take 30-90s; subsequent navigations are fast.
test.setTimeout(120_000);

// ─── Bug 1: post-onboarding → settings → account-security must NOT bounce ─────

test('onboarding → 设置 → 账号与安全 stays put (no bounce to onboarding)', async ({ page }) => {
  const ACCOUNT_ID = 'acc-e2e-coherence-1';
  const NAME = '齐天大圣';

  // Seed a just-logged-in NEW user (displayName null) — AuthGate lands on onboarding.
  await page.addInitScript(`
    window.localStorage.setItem('nvy-auth', JSON.stringify({
      state: {
        accountId: '${ACCOUNT_ID}',
        accessToken: 'access-coherence-1',
        refreshToken: 'refresh-coherence-1',
        displayName: null,
        phone: null,
      },
      version: 0,
    }));
  `);

  // Stateful /me: GET returns the current name (null until the onboarding PATCH
  // sets it); PATCH commits the name and echoes the full profile. This is the
  // single source of truth the whole client now reads from.
  let currentName: string | null = null;
  await page.route(ME_URL, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return route.fulfill(CORS_PREFLIGHT);
    if (method === 'PATCH') {
      currentName = (route.request().postDataJSON() as { displayName: string }).displayName;
    }
    await fulfillJson(route, profileBody(ACCOUNT_ID, currentName));
  });

  await page.goto('/');
  // New user → onboarding.
  await expect(page.getByLabel('昵称', { exact: true })).toBeVisible({ timeout: 90_000 });

  await page.getByLabel('昵称', { exact: true }).fill(NAME);
  await page.getByRole('button', { name: '提交' }).tap();

  // Write-through seeds the /me cache → AuthGate routes to profile.
  await page.waitForURL(/\/profile$|\(tabs\)\/profile/, { timeout: 15_000 });
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible();

  // The bug repro: into 设置 → 账号与安全. Pre-fix, mounting account-security's
  // useMe re-synced a stale null and bounced here back to /onboarding.
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '账号与安全', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });

  // Stays on account-security (NOT bounced) and the 昵称 row shows the real name.
  await expect(page).not.toHaveURL(/onboarding/);
  await expect(page.getByRole('button', { name: '昵称', exact: true })).toContainText(NAME);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/coherence-no-bounce.png`, fullPage: true });
});

// ─── Bug 2: logout A → login B → B sees its own profile, never A's ───────────

test('logout A → login B: account B never sees account A cached profile', async ({ page }) => {
  const NAME_A = '账号甲';
  const NAME_B = '账号乙';

  // Seed account A authed (token-A). /me is keyed on the bearer token so A and B
  // get distinct bodies from the same URL — proving B doesn't read A's cache.
  await page.addInitScript(`
    window.localStorage.setItem('nvy-auth', JSON.stringify({
      state: {
        accountId: 'acc-A',
        accessToken: 'token-A',
        refreshToken: 'refresh-A',
        displayName: '${NAME_A}',
        phone: '+8613800138000',
      },
      version: 0,
    }));
  `);

  await page.route(ME_URL, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill(CORS_PREFLIGHT);
    const auth = route.request().headers()['authorization'] ?? '';
    const isB = auth.includes('token-B');
    await fulfillJson(route, profileBody(isB ? 'acc-B' : 'acc-A', isB ? NAME_B : NAME_A));
  });
  await mockJson(page, LOGOUT_ALL_URL, 204, null, 'POST');
  await mockJson(page, SMS_CODES_URL, 201, { ttlSec: 300 });
  await mockJson(page, PHONE_SMS_AUTH_URL, 200, {
    accountId: 'acc-B',
    accessToken: 'token-B',
    refreshToken: 'refresh-B',
  });

  // Boot as A → profile shows 甲.
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(NAME_A).first()).toBeVisible();

  // Logout A (window.confirm → true on web) → AuthGate routes to login. logoutAll
  // clears the store AND queryClient.clear() wipes A's /me cache.
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.evaluate(() => {
    (window as Window & { confirm: (msg?: string) => boolean }).confirm = () => true;
  });
  await page.getByRole('button', { name: '退出登录', exact: true }).tap();
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });

  // Login as B (different account) — no page reload, same in-memory session.
  await page.getByLabel('手机号').fill('13800138001');
  await page.getByRole('button', { name: '获取验证码' }).tap();
  await expect(page.getByText(/后重发/)).toBeVisible();
  await page.getByLabel('验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '登录' }).tap();

  // B lands on profile showing 乙 — and 甲 must NEVER appear (no cross-account
  // bleed). Pre-fix, the static /me key + uncleared cache flashed 甲 here.
  await page.waitForURL(/\/profile$|\(tabs\)\/profile/, { timeout: 15_000 });
  await expect(page.getByText(NAME_B).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(NAME_A)).toHaveCount(0);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/coherence-no-bleed.png`, fullPage: true });
});
