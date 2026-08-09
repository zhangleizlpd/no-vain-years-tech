import { expect, test, type Page } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// T035 — Expo Web e2e for the 004 FROZEN-login interception + cancel-deletion
// recovery loop (US11). Entry point is the shipped 001 login screen; a FROZEN
// account's login attempt returns 403 ACCOUNT_IN_FREEZE_PERIOD (mocked at the
// network boundary), which use-login-form routes into the FreezeModal (T034).
//
// Backend is mocked via page.route — server endpoints are covered end-to-end by
// Testcontainers ITs (US1-US9); this spec exercises the full *client* stack
// (RHF → use-login-form / use-cancel-deletion-form → Orval/axios → FreezeModal +
// cancel screen). axios baseURL is http://localhost:3000 (cross-origin vs the
// Expo web origin), so mockJson answers the CORS preflight too.
//
// Landing assertion = /onboarding (NOT "/"): a cancelled session sets tokens but
// carries NO displayName (LoginResponse has none; useMe is currently unused), so
// AuthGate's displayName-null state routes to onboarding — identical to the login
// happy path (login.spec). The "restore existing profile → home" UX gap is tracked
// as a separate follow-up (T035 clarify, 2026-05-26), out of scope for this e2e.
//
// Success is asserted via the post-redirect outcome, not the transient
// SuccessOverlay frame (per memory feedback_visual_smoke_unreachable_when_finally
// _clears_session — the hook does NOT clearSession on success).

const LOGIN_SMS_URL = '**/api/v1/accounts/sms-codes';
const PHONE_SMS_AUTH_URL = '**/api/v1/accounts/phone-sms-auth';
const CANCEL_SMS_URL = '**/api/v1/auth/cancel-deletion/sms-codes';
const CANCEL_URL = '**/api/v1/auth/cancel-deletion';
const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';

// Post-cancel session id (mirrors the CANCEL_URL LoginResponse below).
const CANCELLED_ACCOUNT_ID = 'acc-e2e-cancel-1';

const VALID_PHONE = '13800138000';
const VALID_CODE = '123456';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

// 15 天后冻结到期 → 拦截 modal「还有 N 天」(remainingFreezeDays ceil).
const freezeUntil = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
const FREEZE_403 = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  code: 'ACCOUNT_IN_FREEZE_PERIOD',
  freezeUntil,
};

test.beforeEach(async ({ page }) => {
  // No auth seed → cold boot unauthenticated → AuthGate lands on /(auth)/login.
  //
  // The 撤销 path authenticates mid-test (cancel-deletion → setSession), after
  // which AuthGate's useMe fires GET /me. Stub it (displayName null → AuthGate
  // routes to /onboarding, the asserted landing) so the suite stays hermetic vs
  // a real :3000 (per 05-29-e2e-backend-boundary-hardening P1). Without it, a
  // live backend rejects the mock token → fake-refresh fails → clearSession →
  // lands /login, breaking the /onboarding assertion. The 保持 path never
  // authenticates, so the stub is inert there.
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: CANCELLED_ACCOUNT_ID,
      phone: '+8613800138000',
      displayName: null,
      status: 'ACTIVE',
      createdAt: '2026-05-25T00:00:00.000Z',
    },
    'GET',
  );
  await mockJson(page, REFRESH_URL, 200, {
    accountId: CANCELLED_ACCOUNT_ID,
    accessToken: 'access-e2e-1',
    refreshToken: 'refresh-e2e-1',
  });
  // Login 登录 is gated until a code has actually been requested (smsSent latch),
  // so triggerFreezeModal must hit /sms-codes first — stub it for both US11 paths.
  await mockJson(page, LOGIN_SMS_URL, 201, { ttlSec: 300 });

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

// Metro web first compile can take 30-90s; subsequent navigations are fast.
test.setTimeout(120_000);

async function bootLogin(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('手机号')).toBeVisible({ timeout: 90_000 });
}

// Fill login phone, request the SMS code (登录 is gated on smsSent), fill code,
// submit → mocked 403 freeze → assert the FreezeModal (剩余天数文案 + 撤销/保持两分支).
async function triggerFreezeModal(page: Page) {
  await page.getByLabel('手机号').fill(VALID_PHONE);
  await page.getByRole('button', { name: '获取验证码' }).tap();
  // sms_sent → the inline send button flips to the resend countdown.
  await expect(page.getByText(/后重发/)).toBeVisible();
  await page.getByLabel('验证码', { exact: true }).fill(VALID_CODE);
  await page.getByRole('button', { name: '登录' }).tap();

  await expect(page.getByText('账号注销冷静期')).toBeVisible();
  await expect(page.getByText(/还有 \d+ 天将永久注销/)).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销注销' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保持注销' })).toBeVisible();
}

test('US11 撤销 — FROZEN login → modal → cancel-deletion 屏预填 → 提交 → 进鉴权区 (SC-C02)', async ({
  page,
}) => {
  await mockJson(page, PHONE_SMS_AUTH_URL, 403, FREEZE_403);
  await mockJson(page, CANCEL_SMS_URL, 200, {});
  await mockJson(page, CANCEL_URL, 200, {
    accountId: CANCELLED_ACCOUNT_ID,
    accessToken: 'access-e2e-1',
    refreshToken: 'refresh-e2e-1',
  });

  await bootLogin(page);
  await triggerFreezeModal(page);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/t035-freeze-modal.png`, fullPage: true });

  // 撤销注销 → 跳撤销屏，手机号经路由参数预填（免重输）.
  await page.getByRole('button', { name: '撤销注销' }).tap();
  await page.waitForURL(/cancel-deletion/);
  await expect(page.getByLabel('手机号')).toHaveValue(VALID_PHONE);

  // 请求撤销码（mock 200）→ 输 6 位码 → 提交（mock 200 LoginResponse）.
  await page.getByRole('button', { name: '获取验证码' }).tap();
  await expect(page.getByText(/后重发/)).toBeVisible();
  await page.getByLabel('验证码', { exact: true }).fill(VALID_CODE);
  await page.getByRole('button', { name: '撤销注销' }).tap();

  // setSession (mutation onSuccess) flips isAuthenticated; displayName null →
  // AuthGate lands on /onboarding (与 login happy path 同构，见文件头说明).
  await page.waitForURL(/onboarding/);
  await expect(page.getByText('完善个人资料')).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/t035-cancel-success.png`, fullPage: true });
});

test('US11 保持 — FROZEN login → modal → 保持注销 → 留登录页 + 清 form', async ({ page }) => {
  await mockJson(page, PHONE_SMS_AUTH_URL, 403, FREEZE_403);

  await bootLogin(page);
  await triggerFreezeModal(page);

  // 保持注销 → dismissFreeze 清 form + 关 modal，留登录页.
  await page.getByRole('button', { name: '保持注销' }).tap();
  await expect(page.getByText('账号注销冷静期')).toHaveCount(0);
  await expect(page).toHaveURL(/login/);
  await expect(page.getByLabel('手机号')).toHaveValue('');
});
