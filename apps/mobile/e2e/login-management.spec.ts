import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 005-device-management US5 (client amend / p4 B2) — Expo Web e2e for the
// 登录管理 (login-management) screen: list + detail + remote revoke.
//
// Auth seeded via addInitScript → zustand-persist key `nvy-auth` (same pattern as
// settings-shell.spec.ts / profile.spec.ts). API mocked at the network boundary.
//
// URL assertions use web-stripped paths (no route-group brackets): expo-router web
// export strips `(group)/` segments, so `/(app)/settings/account-security/login-management`
// renders as `/settings/account-security/login-management` (memory expo_router_web_hides_route_groups).
//
// Device list mock is STATEFUL (mockDevices): a DELETE marks the row revoked so the
// post-revoke refetch (driven by useRevokeDevice → invalidateQueries) omits it —
// that's how SC-C02「成功后该行从列表消失」is asserted faithfully.

const ME_URL = '**/api/v1/accounts/me';
// `*` excludes `/`, so `devices*` catches `/devices` + `/devices?size=100` but NOT
// `/devices/{id}`; `devices/*` catches the revoke path only. No glob overlap.
const DEVICES_LIST_URL = '**/api/v1/auth/devices*';
const DEVICE_REVOKE_URL = '**/api/v1/auth/devices/*';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const SEED_PHONE = '+8613900139000';
const SEED_DISPLAY_NAME = '小明';
const SEED_ACCOUNT_ID = 'acc-e2e-005';

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
        accessToken: 'access-e2e-005',
        refreshToken: 'refresh-e2e-005',
        displayName: '${SEED_DISPLAY_NAME}',
        phone: '${SEED_PHONE}',
      },
      version: 0,
    }),
  );
`;

interface DeviceRow {
  id: string;
  deviceId: string;
  deviceName: string | null;
  deviceType: string;
  location: string | null;
  loginMethod: string;
  lastActiveAt: string;
  isCurrent: boolean;
}

const DEVICES: DeviceRow[] = [
  {
    id: '1001',
    deviceId: 'dev-current',
    deviceName: 'iPhone 15',
    deviceType: 'PHONE',
    location: '上海市',
    loginMethod: 'PHONE_SMS',
    lastActiveAt: '2026-05-29T10:00:00Z',
    isCurrent: true,
  },
  {
    id: '1002',
    deviceId: 'dev-mac',
    deviceName: 'MacBook Pro',
    deviceType: 'DESKTOP',
    location: '北京市',
    loginMethod: 'PHONE_SMS',
    lastActiveAt: '2026-05-28T08:30:00Z',
    isCurrent: false,
  },
  {
    // legacy row: name null / type UNKNOWN / location null → graceful downgrade
    id: '1003',
    deviceId: 'dev-legacy',
    deviceName: null,
    deviceType: 'UNKNOWN',
    location: null,
    loginMethod: 'PHONE_SMS',
    lastActiveAt: '2026-05-20T12:00:00Z',
    isCurrent: false,
  },
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};

// Stateful device mock: GET returns rows minus any revoked; DELETE either revokes
// (200) or returns the configured error status (row kept). Returns nothing; flow
// state lives in the closure.
async function mockDevices(page: Page, opts: { revokeStatus?: number; revokeBody?: unknown } = {}) {
  const revoked = new Set<string>();
  const revokeStatus = opts.revokeStatus ?? 200;

  await page.route(DEVICES_LIST_URL, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const items = DEVICES.filter((r) => !revoked.has(r.id));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        page: 0,
        size: 100,
        totalElements: items.length,
        totalPages: 1,
        items,
      }),
    });
  });

  await page.route(DEVICE_REVOKE_URL, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    if (revokeStatus === 200) {
      const id = route.request().url().split('/').pop()!.split('?')[0];
      revoked.add(id);
      await route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        body: '',
      });
      return;
    }
    await route.fulfill({
      status: revokeStatus,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(opts.revokeBody ?? {}),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
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
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

test.setTimeout(120_000);

// Boot → profile → settings → 账号与安全 → 登录管理 list.
async function gotoLoginManagement(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '账号与安全', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '登录管理', exact: true }).tap();
  await expect(page).toHaveURL(/\/login-management$/, { timeout: 10_000 });
}

// ─── List render + badges + legacy downgrade (SC-C01 / SC-C04) ───────────────

test('US5 list — renders devices, 本机 badge on current, legacy downgrade', async ({ page }) => {
  await mockDevices(page);
  await gotoLoginManagement(page);

  await expect(page.getByText('已登录的设备 3')).toBeVisible({ timeout: 10_000 });
  // current device row + 本机 badge
  await expect(page.getByText('iPhone 15')).toBeVisible();
  await expect(page.getByText('本机', { exact: true })).toBeVisible();
  // another device
  await expect(page.getByText('MacBook Pro')).toBeVisible();
  // legacy row: null name → 未知设备, null location → —
  await expect(page.getByText('未知设备')).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-device-list.png` });
});

// ─── Detail 4 fields (FR-C04) ────────────────────────────────────────────────

test('US5 detail — tap non-current device → 4-field detail', async ({ page }) => {
  await mockDevices(page);
  await gotoLoginManagement(page);

  await page.getByRole('button', { name: '设备 MacBook Pro' }).tap();
  await expect(page).toHaveURL(/\/login-management\/1002$/, { timeout: 10_000 });

  await expect(page.getByText('设备名称')).toBeVisible();
  // exact: the list row (still mounted under the Stack) renders "… · 北京市"; the
  // detail field value is exactly 北京市 — pin to it to avoid strict-mode collision.
  await expect(page.getByText('北京市', { exact: true })).toBeVisible();
  await expect(page.getByText('快速登录')).toBeVisible(); // PHONE_SMS → 中文标签
  await expect(page.getByText('最近活跃')).toBeVisible();
  // remove button present for non-current device
  await expect(page.getByRole('button', { name: '移除该设备' })).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-device-detail.png` });
});

// ─── Revoke success → row removed (SC-C02) ───────────────────────────────────

test('US5 revoke — confirm → DELETE 200 → back → row removed', async ({ page }) => {
  await mockDevices(page); // revokeStatus 200
  await gotoLoginManagement(page);

  await page.getByRole('button', { name: '设备 MacBook Pro' }).tap();
  await expect(page).toHaveURL(/\/login-management\/1002$/, { timeout: 10_000 });

  await page.getByRole('button', { name: '移除该设备' }).tap();
  // sheet opens
  await expect(page.getByText('移除设备', { exact: true })).toBeVisible({ timeout: 5_000 });
  // confirm
  await page.getByRole('button', { name: '确认移除该设备' }).tap();

  // back on list, and the revoked row is gone after invalidate-driven refetch
  await expect(page).toHaveURL(/\/login-management$/, { timeout: 10_000 });
  await expect(page.getByText('MacBook Pro')).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('iPhone 15')).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-revoke-success.png` });
});

// ─── Revoke 409 / 404 → unified error copy in sheet (SC-C03) ─────────────────

test('US5 revoke — DELETE 409 → 无法移除当前设备 error', async ({ page }) => {
  await mockDevices(page, {
    revokeStatus: 409,
    revokeBody: { status: 409, code: 'CANNOT_REMOVE_CURRENT_DEVICE', title: 'conflict' },
  });
  await gotoLoginManagement(page);

  await page.getByRole('button', { name: '设备 MacBook Pro' }).tap();
  await page.getByRole('button', { name: '移除该设备' }).tap();
  await expect(page.getByText('移除设备', { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: '确认移除该设备' }).tap();

  await expect(page.getByText('无法移除当前设备，请改用退出登录')).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-revoke-409.png` });
});

test('US5 revoke — DELETE 404 → 设备不存在或已被移除 error', async ({ page }) => {
  await mockDevices(page, {
    revokeStatus: 404,
    revokeBody: { status: 404, code: 'DEVICE_NOT_FOUND', title: 'not found' },
  });
  await gotoLoginManagement(page);

  await page.getByRole('button', { name: '设备 MacBook Pro' }).tap();
  await page.getByRole('button', { name: '移除该设备' }).tap();
  await expect(page.getByText('移除设备', { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: '确认移除该设备' }).tap();

  await expect(page.getByText('设备不存在或已被移除')).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-revoke-404.png` });
});
