import { expect, test, type Page } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 010-wechat-account-binding — Expo Web e2e (Phase 1 stub). bind (T023) + unbind
// (T026) 段。Auth seeded via addInitScript → zustand-persist `nvy-auth`. API mocked
// at network boundary (mockJson 答 CORS preflight)。**必 mock REFRESH 200** —— authed
// 业务 401 会触发 003 refresh 拦截器 retry-once, 不 mock 则 clearSession 误跳 /login
// (per memory authed_business_401_triggers_refresh_interceptor)。URL 断言用 web-
// stripped path (expo-router web 隐 `(group)/` 段)。本地跑前杀 :3000 nx serve 父进程。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const BIND_URL = '**/api/v1/accounts/me/wechat-binding';
const UNBIND_CODES_URL = '**/api/v1/accounts/me/wechat-binding/unbind-codes';
const UNBIND_URL = '**/api/v1/accounts/me/wechat-binding/unbind';

const SEED_PHONE = '+8613900139000';
const SEED_DISPLAY_NAME = '小明';
const SEED_ACCOUNT_ID = 'acc-e2e-010';

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
        accessToken: 'access-e2e-010',
        refreshToken: 'refresh-e2e-010',
        displayName: '${SEED_DISPLAY_NAME}',
        phone: '${SEED_PHONE}',
      },
      version: 0,
    }),
  );
`;

function meBody(wechatBound: boolean) {
  return {
    accountId: SEED_ACCOUNT_ID,
    phone: SEED_PHONE,
    displayName: SEED_DISPLAY_NAME,
    bio: null,
    gender: null,
    status: 'ACTIVE',
    createdAt: '2026-05-30T00:00:00.000Z',
    wechatBound,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
  // refresh 拦截器兜底: authed 流任何 401 → mock refresh 200 避免误登出。
  await mockJson(page, REFRESH_URL, 200, {
    accountId: SEED_ACCOUNT_ID,
    accessToken: 'access-e2e-010',
    refreshToken: 'refresh-e2e-010',
  });
});

test.setTimeout(120_000);

// seed /me {wechatBound} → boot → 账号与安全页。
async function bootToAccountSecurity(page: Page, wechatBound: boolean) {
  await mockJson(page, ME_URL, 200, meBody(wechatBound), 'GET');
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '账号与安全', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
}

const wechatRow = (page: Page) => page.getByRole('button', { name: '微信', exact: true });

// ─── T023 bind 段 ───────────────────────────────────────────────────────────

test('US3 bind — seed 未绑「绑定」→ stub authorize → bind 201 → 行翻「解绑」', async ({ page }) => {
  await bootToAccountSecurity(page, false);
  await expect(wechatRow(page)).toContainText('绑定');

  await mockJson(page, BIND_URL, 201, {}, 'POST');
  // bind 成功后 invalidate /me → refetch 须见 wechatBound:true (re-mock 先于 tap)。
  await mockJson(page, ME_URL, 200, meBody(true), 'GET');

  await wechatRow(page).tap();
  await expect(wechatRow(page)).toContainText('解绑', { timeout: 10_000 });
});

test('US3 bind 409 — 该微信已绑他号 → toast + 行保持「绑定」', async ({ page }) => {
  await bootToAccountSecurity(page, false);
  await mockJson(
    page,
    BIND_URL,
    409,
    { type: 'about:blank', title: 'Conflict', status: 409, code: 'WECHAT_ALREADY_BOUND_OTHER' },
    'POST',
  );

  await wechatRow(page).tap();
  await expect(page.getByText('该微信已绑定其他账号')).toBeVisible({ timeout: 10_000 });
  await expect(wechatRow(page)).toContainText('绑定'); // 失败不翻行 (FR-C06)
});

// ─── T026 unbind 段 ─────────────────────────────────────────────────────────

test('US4 unbind — seed 已绑「解绑」→ 确认 → 发码 → 输码 → 确认解绑 204 → 返回行翻「绑定」', async ({
  page,
}) => {
  await bootToAccountSecurity(page, true);
  await expect(wechatRow(page)).toContainText('解绑');

  page.on('dialog', (d) => d.accept()); // window.confirm「确定要解除微信绑定?」→ 确定
  await wechatRow(page).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/wechat-unbind$/, { timeout: 10_000 });

  // 用 200 而非真实 204: mockJson 总带 JSON body, 而 HTTP 204 禁带 body → 浏览器视
  // 协议错误使请求 hang。客户端 mutation 只判 2xx, 200/204 等价 (端点真实 204 由 IT 验)。
  await mockJson(page, UNBIND_CODES_URL, 200, {}, 'POST');
  await mockJson(page, UNBIND_URL, 200, {}, 'POST');
  // 解绑成功后 invalidate /me → 须见 wechatBound:false。
  await mockJson(page, ME_URL, 200, meBody(false), 'GET');

  await page.getByRole('button', { name: '获取验证码' }).tap();
  // 确定性等待: 发码成功 → 倒计时起 → send 按钮 label 变「N秒后可重新发送」(获取验证码
  // 消失)。确认 hasSentCode 状态已传播再填码/提交, 消除生产 bundle 并行负载下的时序 flaky。
  await expect(page.getByRole('button', { name: '获取验证码' })).toHaveCount(0, {
    timeout: 10_000,
  });
  await page.getByLabel('验证码', { exact: true }).fill('123456');
  // 等「确认解绑」enabled (hasSentCode && isValid) 再点。
  await expect(page.getByRole('button', { name: '确认解绑' })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole('button', { name: '确认解绑' }).tap();

  // router.back() → 账号与安全页, 行翻「绑定」。
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
  await expect(wechatRow(page)).toContainText('绑定', { timeout: 10_000 });
});

test('US4 unbind 取消 — 确认对话点取消 → 留原页, 仍「解绑」', async ({ page }) => {
  await bootToAccountSecurity(page, true);
  page.on('dialog', (d) => d.dismiss()); // 取消
  await wechatRow(page).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/);
  await expect(wechatRow(page)).toContainText('解绑');
});
