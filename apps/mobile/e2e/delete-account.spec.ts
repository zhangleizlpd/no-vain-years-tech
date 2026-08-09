import { expect, test, type Page } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// TD06 — Expo Web e2e for the 004 US10 account-deletion initiation screen (B3).
// Entry is the settings shell: profile ⚙️ → 设置 → 账号与安全 → 注销账号. The deletion
// endpoints (EP1 me/deletion-codes, EP2 me/deletion) are mocked at the network
// boundary; the server side is covered end-to-end by Testcontainers ITs (US1-9).
// This spec exercises the full *client* stack (RHF → use-delete-account-form →
// Orval/axios → screen).
//
// Auth seeded via addInitScript → zustand-persist key `nvy-auth` (same pattern
// as settings-shell.spec.ts). axios baseURL is http://localhost:3000
// (cross-origin vs the Expo web origin), so mockJson answers the CORS preflight.
//
// URL assertions use web-stripped paths (no route-group brackets) — expo-router
// web export strips `(group)/` segments (per memory expo_router_web_hides_route_groups).
//
// On EP2 success the wrapper clearSession()s (account frozen → local session
// void) and the screen router.replace's to /(auth)/login. Success is asserted
// via the post-redirect /login URL + cleared session, not a transient frame.

const ME_URL = '**/api/v1/accounts/me';
const DELETION_CODES_URL = '**/api/v1/accounts/me/deletion-codes';
const DELETION_URL = '**/api/v1/accounts/me/deletion';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const SEED_PHONE = '+8613900139000';
const SEED_DISPLAY_NAME = '小明';
const SEED_ACCOUNT_ID = 'acc-e2e-004-del';
const SEED_REFRESH_TOKEN = 'refresh-e2e-004-del';
const SEED_ACCESS_TOKEN = 'access-e2e-004-del';
const VALID_CODE = '123456';

const WARNING_1 = '注销后账号进入 15 天冻结期，期间可登录撤销恢复';
const WARNING_2 = '冻结期满后账号数据将永久匿名化，不可恢复';
const CONFIRM_1 = '我已知晓 15 天冻结期可撤销';
const CONFIRM_2 = '我已知晓期满后数据匿名化不可逆';

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
        accessToken: '${SEED_ACCESS_TOKEN}',
        refreshToken: '${SEED_REFRESH_TOKEN}',
        displayName: '${SEED_DISPLAY_NAME}',
        phone: '${SEED_PHONE}',
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

// Metro web first compile can take 30-90s; subsequent navigations are fast.
test.setTimeout(120_000);

// profile ⚙️ → settings → 账号与安全 → 注销账号 → delete-account screen.
async function bootToDeleteAccount(page: Page) {
  // Seed GET /me so AuthGate cold-start resolves to the authed profile (and
  // doesn't route to onboarding — displayName is seeded). PATCH/POST on nested
  // paths use distinct globs, so the GET pin here is only defensive.
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      status: 'ACTIVE',
    },
    'GET',
  );
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });

  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '账号与安全', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '注销账号', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/delete-account$/, {
    timeout: 10_000,
  });
}

test('US10 注销 — 双勾选 → 发码 → 输码 → 确认注销 → 会话清 + 落 /login (SC-C01)', async ({
  page,
}) => {
  await mockJson(page, DELETION_CODES_URL, 204, null, 'POST');
  await mockJson(page, DELETION_URL, 204, null, 'POST');

  await bootToDeleteAccount(page);

  // ① 屏渲染：≥2 行风险提示可见；发码按钮 disabled（未勾选）。
  await expect(page.getByText(WARNING_1)).toBeVisible();
  await expect(page.getByText(WARNING_2)).toBeVisible();
  await expect(page.getByRole('button', { name: '获取验证码' })).toBeDisabled();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/td06-delete-initial.png`, fullPage: true });

  // ② 双勾选 → 发码按钮 enabled → 点发码（mock 204）→ 输码态（倒计时）。
  await page.getByRole('checkbox', { name: CONFIRM_1 }).tap();
  await page.getByRole('checkbox', { name: CONFIRM_2 }).tap();
  await expect(page.getByRole('button', { name: '获取验证码' })).toBeEnabled();
  await page.getByRole('button', { name: '获取验证码' }).tap();
  await expect(page.getByText(/后重发/)).toBeVisible();

  // ③ 输 6 位码 → 确认注销（mock 204）→ 会话清 + 落 /login。
  await page.getByLabel('验证码', { exact: true }).fill(VALID_CODE);
  await page.getByRole('button', { name: '确认注销' }).tap();

  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
  const sessionRaw = await page.evaluate(() => window.localStorage.getItem('nvy-auth'));
  const session = JSON.parse(sessionRaw ?? '{}') as {
    state?: { accessToken?: string; refreshToken?: string };
  };
  expect(session.state?.accessToken ?? null).toBeNull();
  expect(session.state?.refreshToken ?? null).toBeNull();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/td06-delete-success.png`, fullPage: true });
});

test('US10 错误 — 确认注销 mock 401 INVALID_DELETION_CODE → 「验证码错误」、留屏', async ({
  page,
}) => {
  await mockJson(page, DELETION_CODES_URL, 204, null, 'POST');
  await mockJson(page, DELETION_URL, 401, { status: 401, code: 'INVALID_DELETION_CODE' }, 'POST');
  // The business 401 hits the 003-tokens auth-refresh interceptor: it refreshes
  // once then retries. The refresh token is valid (mocked 200), so refresh
  // succeeds and the retry re-sends /me/deletion with x-nvy-retry — the 2nd 401
  // then propagates to the business handler (toast), and the session is NOT
  // cleared (the user stays logged in, mirroring production). Without this mock
  // refreshOnce would fail and log the user out instead.
  await mockJson(page, REFRESH_URL, 200, {
    accountId: SEED_ACCOUNT_ID,
    accessToken: 'access-e2e-rotated',
    refreshToken: 'refresh-e2e-rotated',
  });

  await bootToDeleteAccount(page);

  await page.getByRole('checkbox', { name: CONFIRM_1 }).tap();
  await page.getByRole('checkbox', { name: CONFIRM_2 }).tap();
  await page.getByRole('button', { name: '获取验证码' }).tap();
  await expect(page.getByText(/后重发/)).toBeVisible();

  await page.getByLabel('验证码', { exact: true }).fill(VALID_CODE);
  await page.getByRole('button', { name: '确认注销' }).tap();

  // 统一错误提示 + 留屏（会话未清，仅 token 因 retry 轮换）。
  await expect(page.getByText('验证码错误')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/account-security\/delete-account$/);
  const sessionRaw = await page.evaluate(() => window.localStorage.getItem('nvy-auth'));
  const session = JSON.parse(sessionRaw ?? '{}') as { state?: { refreshToken?: string } };
  expect(session.state?.refreshToken).toBe('refresh-e2e-rotated');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/td06-delete-error.png`, fullPage: true });
});
