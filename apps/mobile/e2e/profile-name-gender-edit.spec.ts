import { expect, test, type Page, type Route } from '@playwright/test';

// 008-profile-name-gender-edit — Expo Web e2e：昵称编辑 + 性别设置 + 资料卡行重排。
// 承接 007 的 seed/auth/mock 范式（account-security-refactor.spec.ts）。
//
// US2: 昵称 → name-edit（预填 / 计数 / 保存 200 → 返回 + 资料卡显新值 / 超 32 拦截）。
// US1: 性别 → gender-edit（4 选项 + 当前值打勾 / 点选即存自动返回 + 资料卡显新值 / 再进预选）。
// US3: 资料卡行序 = 头像/昵称/性别/个人简介/主页背景图（个人简介↔性别对换）；009 起全行 active。
//
// /me 走「有状态」mock：GET 返回当前 profile，PATCH /me（displayName）/ PATCH /me/gender
// 各自 mutate 闭包 profile —— 故保存后资料卡刷新 + 再进编辑屏预选都反映最新值。URL 断言用
// web-stripped 路径（expo-router web export 去 `(group)/` 段）。叠屏同名 label 用 getByRole
// 收窄（per memory playwright_expo_stacked_screen_locator_collision）。
const ME_URL = '**/api/v1/accounts/me';
const ME_GENDER_URL = '**/api/v1/accounts/me/gender';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const SEED_PHONE = '+8613900139000';
const SEED_DISPLAY_NAME = '小明';
const SEED_ACCOUNT_ID = 'acc-e2e-008';

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
        accessToken: 'access-e2e-008',
        refreshToken: 'refresh-e2e-008',
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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};

// 有状态 /me mock：闭包 profile 被 PATCH 改写，GET 回读最新值。
async function bootToAccountSecurity(
  page: Page,
  init: { displayName?: string; gender?: string | null } = {},
) {
  const profile: Record<string, unknown> = {
    accountId: SEED_ACCOUNT_ID,
    phone: SEED_PHONE,
    displayName: init.displayName ?? SEED_DISPLAY_NAME,
    bio: null,
    gender: init.gender ?? null,
    status: 'ACTIVE',
    createdAt: '2026-05-30T00:00:00.000Z',
  };
  const json = (route: Route, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(profile),
    });

  // PATCH /me/gender — mutate gender, return updated profile.
  await page.route(ME_GENDER_URL, async (route: Route) => {
    const m = route.request().method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (m !== 'PATCH') return route.fallback();
    const body = JSON.parse(route.request().postData() ?? '{}') as { gender?: string | null };
    profile.gender = body.gender ?? null;
    return json(route);
  });

  // GET /me (回读最新) + PATCH /me (displayName) on the same glob, branched by method.
  await page.route(ME_URL, async (route: Route) => {
    const m = route.request().method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (m === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { displayName?: string };
      if (typeof body.displayName === 'string') profile.displayName = body.displayName;
      return json(route);
    }
    return json(route); // GET
  });

  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '账号与安全', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
}

// ─── US3: 资料卡行序对换 + 全行 active（009 起头像/主页背景图换图入口）(SC-003/SC-004) ──

test('US3 — 资料卡行序 头像/昵称/性别/个人简介/主页背景图 + active/disabled', async ({ page }) => {
  await bootToAccountSecurity(page);

  // 5 行可见
  for (const label of ['头像', '昵称', '性别', '个人简介', '主页背景图']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }

  // 个人简介↔性别对换：性别行在个人简介行之上（y 坐标更小）
  const genderBox = await page.getByRole('button', { name: '性别', exact: true }).boundingBox();
  const bioBox = await page.getByRole('button', { name: '个人简介', exact: true }).boundingBox();
  expect(genderBox!.y).toBeLessThan(bioBox!.y);

  // 昵称/性别/个人简介（008）+ 头像/主页背景图（009 换图入口）全部 active
  for (const label of ['昵称', '性别', '个人简介', '头像', '主页背景图']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
  }

  // 点头像 → 开 action sheet「更换头像」（009 起 active，不再 disabled 占位）→ 取消
  await page.getByRole('button', { name: '头像', exact: true }).tap();
  await expect(page.getByText('更换头像')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '取消', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us3-card-order.png`, fullPage: true });
});

// ─── US2: 昵称编辑（预填 / 计数 / 保存 200 → 返回 + 资料卡显新值） ───────────────

test('US2 — 昵称编辑：预填 + 计数 + 保存 200 → 返回 + 资料卡显新值', async ({ page }) => {
  await bootToAccountSecurity(page, { displayName: '小明' });

  await page.getByRole('button', { name: '昵称', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/name-edit$/, { timeout: 10_000 });

  // 预填当前 displayName + 计数 2/32（叠屏：底层 昵称 Row 同名，用 textbox role 收窄）
  await expect(page.getByRole('textbox', { name: '昵称' })).toHaveValue('小明');
  await expect(page.getByText('2/32')).toBeVisible();

  // 改输入 → 计数实时更新（3 码点）
  await page.getByRole('textbox', { name: '昵称' }).fill('拾光者');
  await expect(page.getByText('3/32')).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us2-name-edit.png`, fullPage: true });

  // 保存 → 返回账号与安全 + 资料卡昵称显新值
  await page.getByRole('button', { name: '保存', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: '昵称', exact: true })).toContainText('拾光者');
});

test('US2 — 超 32 码点 → 保存禁用（客户端先行拦截）', async ({ page }) => {
  await bootToAccountSecurity(page, { displayName: '小明' });

  await page.getByRole('button', { name: '昵称', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/name-edit$/, { timeout: 10_000 });

  await page.getByRole('textbox', { name: '昵称' }).fill('a'.repeat(33));
  await expect(page.getByText('33/32')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
});

test('US2 — 清空 → 保存禁用（昵称不可空）', async ({ page }) => {
  await bootToAccountSecurity(page, { displayName: '小明' });

  await page.getByRole('button', { name: '昵称', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/name-edit$/, { timeout: 10_000 });

  await page.getByRole('textbox', { name: '昵称' }).fill('');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
});

// ─── US1: 性别设置（4 选项 + 当前打勾 / 点选即存自动返回 + 资料卡显新值 / 再进预选）──────

test('US1 — 性别设置：4 选项 + 当前打勾 + 点选即存自动返回 + 资料卡显新值', async ({ page }) => {
  await bootToAccountSecurity(page, { gender: 'PRIVATE' });

  await page.getByRole('button', { name: '性别', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/gender-edit$/, { timeout: 10_000 });

  // 4 选项可见，当前值「保密」行打勾
  for (const label of ['男', '女', '非二元', '保密']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: '保密', exact: true })).toContainText('✓');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us1-gender-edit.png`, fullPage: true });

  // 点「女」→ 点选即存（无保存按钮）→ 自动返回账号与安全
  await page.getByRole('button', { name: '女', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });

  // 资料卡「性别」行显「女」
  await expect(page.getByRole('button', { name: '性别', exact: true })).toContainText('女');

  // 再次进设置性别屏 → 「女」行预先打勾
  await page.getByRole('button', { name: '性别', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/gender-edit$/, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: '女', exact: true })).toContainText('✓');
});
