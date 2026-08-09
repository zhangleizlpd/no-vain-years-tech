import { expect, test, type Page } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 006-account-settings-shell — Expo Web e2e for the settings navigation shell.
//
// US1: profile ⚙️ → settings, bottom tab bar hidden, back → profile tab restored.
// US2: settings → 账号与安全, 手机号 masked, disabled rows do not navigate.
// US3: 退出登录 confirm flow (success + server-fail fallback + cancel).
//
// Auth seeded via addInitScript → zustand-persist key `nvy-auth` (same pattern
// as profile.spec.ts). API mocked at the network boundary via api-mock.ts.
//
// URL assertions use web-stripped paths (no route-group brackets) because
// expo-router web export strips `(group)/` segments — `/(app)/settings` renders
// as `/settings` in the browser address bar (per memory
// expo_router_web_hides_route_groups).
//
// Bottom-tab bar visibility: expo-router Tabs exposes ARIA role="tab" for each
// tab button; we detect the bar by looking for tab role elements. When settings
// pushes outside `(tabs)/`, the Tabs navigator unmounts its tab bar so those
// role="tab" elements disappear (same ARIA pattern as profile.spec.ts US11).

const LOGOUT_ALL_URL = '**/api/v1/accounts/logout-all';
const ME_URL = '**/api/v1/accounts/me';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const SEED_PHONE = '+8613900139000';
const SEED_DISPLAY_NAME = '小明';
const SEED_ACCOUNT_ID = 'acc-e2e-006';
const SEED_REFRESH_TOKEN = 'refresh-e2e-006';
const SEED_ACCESS_TOKEN = 'access-e2e-006';

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

test.setTimeout(120_000);

async function bootToProfile(page: Page) {
  // Seed GET /me so AuthGate cold-start doesn't stall waiting for profile.
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      bio: null,
      status: 'ACTIVE',
    },
    'GET',
  );
  await page.goto('/');
  // profile tab visible → app booted + AuthGate resolved.
  // No `exact: true`: react-navigation renders bottom-tab icons as a `⏷`
  // text glyph, so the web ARIA accessible name is `⏷ ⏷ 我的`, not `我的`.
  // Substring match (same as profile.spec.ts) is required.
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({
    timeout: 90_000,
  });
}

// ─── US1: enter settings shell, bottom tab bar hides, back restores ──────────

test('US1 — ⚙️ pushes to /settings, bottom tab bar hides, back restores tabs', async ({ page }) => {
  await bootToProfile(page);

  // Tab bar visible on profile
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible();

  // Tap ⚙️ gear button
  await page.getByRole('button', { name: '设置', exact: true }).tap();

  // URL strips route groups: /(app)/settings → /settings
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });

  // Settings cards rendered
  await expect(page.getByRole('button', { name: '账号与安全', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();

  // Bottom tab bar tabs are NOT visible (outside (tabs)/ group)
  await expect(page.getByRole('tab', { name: '我的' })).not.toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us1-settings-shell.png` });

  // Go back — Expo web back button or browser back
  await page.goBack();
  await expect(page).toHaveURL(/\/profile$|profile/, { timeout: 10_000 });

  // Bottom tab bar restored
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us1-back-to-profile.png` });
});

// ─── US2: 账号与安全 nav + 手机号 masked + disabled rows don't navigate ────

test('US2 — 账号与安全 nav, 手机号 masked, disabled rows stay put', async ({ page }) => {
  await bootToProfile(page);

  // Navigate into settings
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });

  // Tap 账号与安全
  await page.getByRole('button', { name: '账号与安全', exact: true }).tap();
  // URL: /(app)/settings/account-security → /settings/account-security
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us2-account-security.png` });

  // 手机号 row shows masked value — contains masked portion, NOT full number
  await expect(page.getByRole('button', { name: '手机号', exact: true })).toBeVisible();
  // The masked value should contain stars and last 4 digits
  await expect(page.getByText('139****9000')).toBeVisible();
  // Full phone number must NOT appear anywhere on screen
  await expect(page.getByText('13900139000')).not.toBeVisible();

  // 登录管理 is now ACTIVE (B2 device-management amend 005 shipped — flips the
  // 006 placeholder to a real push; see 005 tasks-client TC09). 注销账号 is now
  // ACTIVE too (B3 account-deletion 发起屏 amend 004 shipped — TD05 flips the
  // disabled placeholder to a real push; the full deletion flow is covered by
  // delete-account.spec.ts). Both assert enabled rather than tapping here; the
  // dedicated specs exercise the destinations.
  await expect(page.getByRole('button', { name: '登录管理', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '注销账号', exact: true })).toBeEnabled();

  // 007 三段卡片重构：资料卡 + 身份/绑定卡新行出现；旧 generic 行删除。详细 row 集 /
  // 脱敏 / 占位 / bio 编辑断言在 account-security-refactor.spec.ts；此处仅守 006
  // 设置壳 → 账号与安全导航链不回归 + 重构后行集变更（避免 D5 漏网）。
  await expect(page.getByRole('button', { name: '个人简介', exact: true })).toBeEnabled();
  for (const removed of ['实名认证', '第三方账号绑定', '二维码名片']) {
    await expect(page.getByText(removed)).toHaveCount(0);
  }

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us2-account-security-rows.png` });
});

// ─── US3: 退出登录 — confirm, server-fail fallback, cancel ───────────────────

test('US3a — 退出登录 confirm → mock 204 → session cleared → login page', async ({ page }) => {
  await bootToProfile(page);
  await mockJson(page, LOGOUT_ALL_URL, 204, null, 'POST');

  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });

  // Trigger logout — on web, confirmLogout uses window.confirm; override it
  await page.evaluate(() => {
    (window as Window & { confirm: (msg?: string) => boolean }).confirm = () => true;
  });
  await page.getByRole('button', { name: '退出登录', exact: true }).tap();

  // After logout: AuthGate observes session cleared → routes to login
  // Web URL: /(auth)/login → /login
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });

  // Local session should be cleared
  const sessionRaw = await page.evaluate(() => window.localStorage.getItem('nvy-auth'));
  const session = JSON.parse(sessionRaw ?? '{}') as {
    state?: { accessToken?: string; refreshToken?: string };
  };
  expect(session.state?.accessToken ?? null).toBeNull();
  expect(session.state?.refreshToken ?? null).toBeNull();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us3a-logged-out.png` });
});

test('US3b — logout-all server 500 → still logs out locally → login page', async ({ page }) => {
  await bootToProfile(page);
  await mockJson(page, LOGOUT_ALL_URL, 500, { error: 'server error' }, 'POST');

  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });

  await page.evaluate(() => {
    (window as Window & { confirm: (msg?: string) => boolean }).confirm = () => true;
  });
  await page.getByRole('button', { name: '退出登录', exact: true }).tap();

  // Even on server error, logoutAll's finally clears local session
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us3b-server-fail-still-logged-out.png` });
});

test('US3c — 退出登录 cancel → stays on settings, still logged in', async ({ page }) => {
  await bootToProfile(page);

  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });

  // Override confirm to return false (cancel)
  await page.evaluate(() => {
    (window as Window & { confirm: (msg?: string) => boolean }).confirm = () => false;
  });
  await page.getByRole('button', { name: '退出登录', exact: true }).tap();

  // Should remain on settings page
  await expect(page).toHaveURL(/\/settings$/, { timeout: 5_000 });

  // Session should still be authenticated. Assert refreshToken, not accessToken:
  // store.ts partialize persists refreshToken to SecureStore but intentionally
  // drops accessToken (in-memory only, re-derived on cold start), so accessToken
  // is never present in the persisted `nvy-auth` payload.
  const sessionRaw = await page.evaluate(() => window.localStorage.getItem('nvy-auth'));
  const session = JSON.parse(sessionRaw ?? '{}') as {
    state?: { refreshToken?: string };
  };
  expect(session.state?.refreshToken).toBe(SEED_REFRESH_TOKEN);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us3c-cancel-stays-settings.png` });
});
