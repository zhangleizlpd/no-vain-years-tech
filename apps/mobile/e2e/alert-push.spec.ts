import { expect, test, type Page } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 022-alert-push-delivery — Expo Web e2e（hermetic mock，PR-2 §V 第一层）。
//
// web 是 push 的「全程 no-op 平台」（plan D7：web 零采集 SDK，ConsentGate 直接放行；
// push-init/push-click/push-permission 三组 .ts/.native.ts 双文件，web 侧全 stub）——
// 本层验的是这组 no-op 的**接线正确性**，native 真行为归 T015 真机走查矩阵：
//   ① 首启不弹隐私弹窗直进 App（FR-011 web 分支 / D7 兑现）；
//   ② push 路径全程不炸（jpush 模块未加载 → 零 pageerror）+ EP9/EP10 零调用
//      （web 不 init → RegID 永不 materialize → 绑定上报无触发点）；
//   ③ 设置页「通知权限」引导行 web 隐藏（push-permission web stub 恒报 enabled）。
// 既有 021 alert e2e 零回归由同 run 跑 alert.spec.ts 承担（无代码改动点，纯验证）。
//
// mock 003 refresh-token 防 authed 401 误登出（per memory
// authed_business_401_triggers_refresh_interceptor）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const PUSH_BINDING_GLOB = '**/api/v1/alert/push-binding**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-07-alert-push';

const SEED_ACCOUNT_ID = 'acc-e2e-022';
const SEED_REFRESH_TOKEN = 'refresh-e2e-022';
const SEED_ACCESS_TOKEN = 'access-e2e-022';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139022';

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

// EP9/EP10 计数 mock：web 路径**不应**有任何 push-binding 流量（无 RegID 触发点）。
// 仍挂 route 兜住 —— 若未来接线错误（如 init gate 失守把 binding 挂到 web），
// 此计数把它变成确定性红测而非静默网络错误。
async function installPushBindingProbe(page: Page): Promise<() => number> {
  let calls = 0;
  await page.route(PUSH_BINDING_GLOB, async (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') {
      return void (await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        },
      }));
    }
    calls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(
        method === 'DELETE'
          ? { deleted: 1 }
          : { registrationId: 'probe', platform: 'android', boundAt: '2026-06-07T00:00:00Z' },
      ),
    });
  });
  return () => calls;
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
      bio: null,
      status: 'ACTIVE',
    },
    'GET',
  );
  await mockJson(page, REFRESH_URL, 200, {
    accountId: SEED_ACCOUNT_ID,
    accessToken: SEED_ACCESS_TOKEN,
    refreshToken: SEED_REFRESH_TOKEN,
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
});

test.setTimeout(120_000);

test('022 push — web 直进无隐私弹窗 / push 全程 no-op 零 EP9 / 设置页通知权限行隐藏（hermetic）', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pushBindingCalls = await installPushBindingProbe(page);

  // ── ① 冷启动：不弹隐私弹窗，直进 authed tabs（FR-011 web 分支）──
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
  // 弹窗独有锚（标题「隐私政策」与 settings 行重名 → 用按钮文案）全程不存在。
  await expect(page.getByRole('button', { name: '同意并继续' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '不同意并退出' })).toHaveCount(0);

  // ── ③ 设置页：「通知」占位行在，「通知权限」引导行 web 隐藏 ──
  await page.getByRole('tab', { name: '我的' }).tap();
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: '通知', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '通知权限', exact: true })).toHaveCount(0);

  // ── ② push 路径全程 no-op：零 jpush 崩溃（pageerror）+ EP9/EP10 零流量 ──
  expect(pageErrors).toEqual([]);
  expect(pushBindingCalls()).toBe(0);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/web-noop-settings.png`, fullPage: true });
});
