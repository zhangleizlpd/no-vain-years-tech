import { expect, test, type Page } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// T066 — Expo Web e2e for the login slice (001-phone-sms-auth client).
//
// Covers the US1 happy path (phone → SMS code → 登录 → authed area), the US3
// error path (invalid code → ErrorRow alert + clear-on-type), and SC-C04
// (rate-limited SMS request → friendly toast). SC-C05 a11y is asserted inline
// via getByRole/getByLabel; SC-C09 = this whole browser run.
//
// Backend is mocked at the network boundary (page.route) — the server endpoints
// are covered end-to-end by server integration tests (Testcontainers); this spec
// exercises the full *client* stack (RHF → useLoginForm → Orval/axios → UI).
// axios baseURL defaults to http://localhost:3000, so API traffic is cross-origin
// vs the Expo web origin; mockJson therefore answers the CORS preflight too.
//
// Success is asserted via the *post-redirect outcome* (lands on /onboarding),
// not the transient SuccessOverlay frame: the hook does NOT clearSession on
// success, so AuthGate redirects within a frame or two — too fast to catch the
// "登录成功" overlay reliably (per memory
// feedback_visual_smoke_unreachable_when_finally_clears_session).

const SMS_CODES_URL = '**/api/v1/accounts/sms-codes';
const PHONE_SMS_AUTH_URL = '**/api/v1/accounts/phone-sms-auth';
const ME_URL = '**/api/v1/accounts/me';

const VALID_PHONE = '13800138000';
const VALID_CODE = '123456';

const SCREENSHOT_DIR = 'playwright-report/screenshots';

test.beforeEach(async ({ page }) => {
  // No auth seed → cold boot is unauthenticated → AuthGate lands on /(auth)/login.
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

// Metro web first compile can take 30-90s; subsequent navigations are fast.
test.setTimeout(120_000);

// Cold boot at `/`; AuthGate (unauthenticated) replaces into /(auth)/login,
// whose group prefix is stripped from the web URL. Resolve once the login form
// has painted (phone field visible) so the slow first bundle doesn't flake.
async function bootLogin(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('手机号')).toBeVisible({ timeout: 90_000 });
}

async function requestSmsCode(page: Page) {
  await page.getByLabel('手机号').fill(VALID_PHONE);
  await page.getByRole('button', { name: '获取验证码' }).tap();
  // sms_sent → the inline send button flips to the resend countdown.
  await expect(page.getByText(/后重发/)).toBeVisible();
}

test('US1 happy — phone → code → 登录 redirects into the authed area (SC-C05 + SC-C09)', async ({
  page,
}) => {
  await mockJson(page, SMS_CODES_URL, 201, { ttlSec: 300 });
  await mockJson(page, PHONE_SMS_AUTH_URL, 200, {
    accountId: 'acc-e2e-login-1',
    accessToken: 'access-e2e-1',
    refreshToken: 'refresh-e2e-1',
  });
  // AuthGate fires GET /me post-login; a fresh auto-register account has no
  // displayName yet → null → onboarding (the post-redirect assertion below).
  await mockJson(page, ME_URL, 200, {
    accountId: 'acc-e2e-login-1',
    phone: '+8613800138000',
    displayName: null,
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  await bootLogin(page);

  // SC-C05 — every interactive control exposes an accessible name.
  await expect(page.getByLabel('验证码', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '获取验证码' })).toBeVisible();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  // 登录 is gated until a code has actually been requested (disabled pre-send).
  await expect(page.getByRole('button', { name: '登录' })).toBeDisabled();

  await requestSmsCode(page);
  await page.getByLabel('验证码', { exact: true }).fill(VALID_CODE);
  await page.getByRole('button', { name: '登录' }).tap();

  // setSession (mutation onSuccess) flips isAuthenticated; AuthGate redirects.
  // displayName is null for a fresh login → onboarding (group prefix stripped).
  await page.waitForURL(/onboarding/);
  // Onboarding form (002 T045) replaced the old placeholder; assert its heading.
  await expect(page.getByText('完善个人资料')).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/t066-login-success.png`, fullPage: true });
});

test('returning user — displayName from GET /me lands on tabs, NOT onboarding (login-displayname-backfill)', async ({
  page,
}) => {
  await mockJson(page, SMS_CODES_URL, 201, { ttlSec: 300 });
  // LoginResponse omits displayName (byte-level anti-enumeration) — identical
  // token-only shape to a fresh login. The returning user's name lives behind
  // GET /me, which AuthGate awaits (the `wait` splash) before routing.
  await mockJson(page, PHONE_SMS_AUTH_URL, 200, {
    accountId: 'acc-e2e-returning-1',
    accessToken: 'access-e2e-2',
    refreshToken: 'refresh-e2e-2',
  });
  await mockJson(page, ME_URL, 200, {
    accountId: 'acc-e2e-returning-1',
    phone: '+8613800138000',
    displayName: '老用户',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  await bootLogin(page);
  await requestSmsCode(page);
  await page.getByLabel('验证码', { exact: true }).fill(VALID_CODE);
  await page.getByRole('button', { name: '登录' }).tap();

  // displayName backfilled from /me → AuthGate routes straight to tabs, never
  // flashing onboarding. Pre-fix this misrouted to /(app)/onboarding.
  await page.waitForURL(/profile/);
  await expect(page.getByText('关注')).toBeVisible();
  await expect(page.getByText('完善个人资料')).toHaveCount(0);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/login-returning-user-tabs.png`,
    fullPage: true,
  });
});

test('US3 — invalid code (401) → ErrorRow alert, stays on login, typing clears it (SC-C05)', async ({
  page,
}) => {
  await mockJson(page, SMS_CODES_URL, 201, { ttlSec: 300 });
  await mockJson(page, PHONE_SMS_AUTH_URL, 401, {
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
  });

  await bootLogin(page);
  await requestSmsCode(page);
  await page.getByLabel('验证码', { exact: true }).fill(VALID_CODE);
  await page.getByRole('button', { name: '登录' }).tap();

  // FR-C06 invalid mapping + FR-C15 errorScope='submit' → shared ErrorRow (alert).
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('手机号或验证码错误');
  // No redirect — session was never set.
  await expect(page).toHaveURL(/login/);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/t066-login-invalid.png`, fullPage: true });

  // FR-C12 — editing any field clears the error (error → idle).
  await page.getByLabel('验证码', { exact: true }).fill('1');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('SC-C04 — rate-limited SMS request (429) shows a friendly toast, no backend detail', async ({
  page,
}) => {
  await mockJson(page, SMS_CODES_URL, 429, {
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
  });

  await bootLogin(page);
  await page.getByLabel('手机号').fill(VALID_PHONE);
  await page.getByRole('button', { name: '获取验证码' }).tap();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('请求过于频繁，请稍后再试');
  await expect(page).toHaveURL(/login/);
});
