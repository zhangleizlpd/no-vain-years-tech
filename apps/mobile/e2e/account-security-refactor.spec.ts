import { expect, test, type Page } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 007-account-security-refactor — Expo Web e2e for the 账号与安全 three-card refactor
// + 个人简介 (bio) editing. Mirrors settings-shell.spec.ts seed/auth/mock pattern.
//
// US1: 三段卡片 row 集精确 + 实名认证 / 第三方账号绑定 / 二维码名片 不在 DOM。
// US2: 个人简介 → bio-edit（预填 / 计数 / 保存 200 → 返回 / 超 120 拦截）。
// US3: 手机号脱敏 + 邮箱/微信/google disabled 占位不导航。
// US4: 昵称真实值 + 性别 active；头像/主页背景图 009 起 active（换图入口，不再 disabled）。
// US5: 登录管理(005) / 注销账号(004) 导航不回归（注销账号独立居中卡片）。
//
// Auth seeded via addInitScript → zustand-persist key `nvy-auth`. API mocked at
// the network boundary (mockJson answers CORS preflight). URL assertions use
// web-stripped paths (expo-router web export strips `(group)/` segments, per
// memory expo_router_web_hides_route_groups).

const ME_URL = '**/api/v1/accounts/me';
const BIO_URL = '**/api/v1/accounts/me/bio';
const DEVICES_LIST_URL = '**/api/v1/auth/devices*';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const SEED_PHONE = '+8613900139000';
const SEED_DISPLAY_NAME = '小明';
const SEED_ACCOUNT_ID = 'acc-e2e-007';
const SEED_REFRESH_TOKEN = 'refresh-e2e-007';
const SEED_ACCESS_TOKEN = 'access-e2e-007';

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

// profile ⚙️ → 设置 → 账号与安全. `bio` seeds GET /me so the bio-edit page (US2)
// prefills from the React Query cache (AuthGate issues GET /me on authed boot).
async function bootToAccountSecurity(page: Page, bio: string | null = null) {
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      bio,
      status: 'ACTIVE',
      createdAt: '2026-05-30T00:00:00.000Z',
      wechatBound: false,
    },
    'GET',
  );
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });

  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '账号与安全', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
}

// ─── US1: three-card row set + removed rows absent (SC-001) ──────────────────

test('US1 — 三段卡片 row 集精确，实名认证/第三方账号绑定/二维码名片 不在 DOM', async ({ page }) => {
  await bootToAccountSecurity(page);

  // 资料卡 5 行（且仅这 5 行）—— 008 行序：头像 / 昵称 / 性别 / 个人简介 / 主页背景图
  for (const label of ['头像', '昵称', '性别', '个人简介', '主页背景图']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  // 身份/绑定卡 4 行
  for (const label of ['手机号', '邮箱', '微信', 'google']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  // 安全区：登录管理（独立卡）+ 注销账号（独立居中卡）
  for (const label of ['登录管理', '注销账号']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }

  // 删除项 / 设计稿未引入项 / 已去除的安全小知识 0 出现（SC-001）
  for (const removed of ['实名认证', '第三方账号绑定', '二维码名片', '安全小知识']) {
    await expect(page.getByText(removed)).toHaveCount(0);
  }

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us1-three-cards.png`, fullPage: true });
});

// ─── US3: 手机号脱敏 + 邮箱/google disabled 占位；微信已 active (010, SC-003/SC-005) ─

test('US3 — 手机号脱敏，邮箱/google disabled 占位；微信 active「绑定」(010)', async ({ page }) => {
  await bootToAccountSecurity(page);

  // 手机号脱敏：含 139****9000，完整号不出现
  await expect(page.getByText('139****9000')).toBeVisible();
  await expect(page.getByText('13900139000')).toHaveCount(0);

  // 邮箱/google 仍 disabled 占位
  for (const label of ['邮箱', 'google']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
  }

  // 微信行 010 起为 state-driven 活行：seed wechatBound:false → 显「绑定」且 enabled
  // （bind/unbind 全链 e2e 见 wechat-binding.spec.ts；此处仅验活行 + 不再 disabled）。
  const wechatRow = page.getByRole('button', { name: '微信', exact: true });
  await expect(wechatRow).toBeEnabled();
  await expect(wechatRow).toContainText('绑定');
});

// ─── US2: 个人简介编辑（预填 / 计数 / 保存 200 → 返回） ──────────────────────

test('US2 — 个人简介编辑：预填 + 计数 + 保存 200 → 返回账号与安全', async ({ page }) => {
  await bootToAccountSecurity(page, '美股研究员');
  // PATCH /me/bio 成功 → 返回更新后 profile
  await mockJson(
    page,
    BIO_URL,
    200,
    {
      accountId: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      bio: '量化交易员组合',
      status: 'ACTIVE',
      createdAt: '2026-05-30T00:00:00.000Z',
    },
    'PATCH',
  );

  // 个人简介 active → 进编辑页
  await page.getByRole('button', { name: '个人简介', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/bio-edit$/, { timeout: 10_000 });

  // 预填当前 bio + 计数 5/120。用 textbox role 精确命中 textarea —— 底层账号与安全页
  // 仍挂在 stack 下，其「个人简介」Row button 同名 aria-label 会与本页 textarea 撞 label。
  await expect(page.getByRole('textbox', { name: '个人简介' })).toHaveValue('美股研究员');
  await expect(page.getByText('5/120')).toBeVisible();

  // 编辑 → 计数实时更新（7 码点）
  await page.getByRole('textbox', { name: '个人简介' }).fill('量化交易员组合');
  await expect(page.getByText('7/120')).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us2-bio-edit.png`, fullPage: true });

  // 保存（mock PATCH 200）→ 返回账号与安全页
  await page.getByRole('button', { name: '保存', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
});

test('US2 — 超 120 字符 → 保存禁用（客户端先行拦截）', async ({ page }) => {
  await bootToAccountSecurity(page, '');

  await page.getByRole('button', { name: '个人简介', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/bio-edit$/, { timeout: 10_000 });

  // 输入 121 字符 → 计数标红 + 保存禁用
  await page.getByRole('textbox', { name: '个人简介' }).fill('a'.repeat(121));
  await expect(page.getByText('121/120')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
});

// ─── US4: 昵称展示真实值（008 起昵称/性别已翻 active，详尽流程见 profile-name-gender-edit.spec.ts）

test('US4 — 昵称展示真实 displayName + 头像/主页背景图 已 active（009 换图入口）', async ({
  page,
}) => {
  await bootToAccountSecurity(page);

  // 昵称行右侧真实值「小明」，008 起 active（可点进 name-edit）。scope 到昵称 button ——
  // 底层 profile 屏仍挂 stack 下也展示 displayName，page 级 getByText('小明') 会撞双命中。
  const nicknameRow = page.getByRole('button', { name: '昵称', exact: true });
  await expect(nicknameRow).toBeEnabled();
  await expect(nicknameRow).toContainText(SEED_DISPLAY_NAME);

  // 性别行 008 起 active（个人简介↔性别对换 + 翻 active）
  await expect(page.getByRole('button', { name: '性别', exact: true })).toBeEnabled();

  // 头像 / 主页背景图 009 起 active（不再 disabled 占位）
  for (const label of ['头像', '主页背景图']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
  }

  // 点主页背景图 → 开 action sheet「更换主页背景图」→ 取消（不导航、不回归）
  await page.getByRole('button', { name: '主页背景图', exact: true }).tap();
  await expect(page.getByText('更换主页背景图')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '取消', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/);
});

// ─── US5: 安全区导航不回归 (SC-004) ──────────────────────────────────────────

test('US5 — 登录管理(005) / 注销账号(004) 导航不回归（注销账号独立居中卡片）', async ({ page }) => {
  await bootToAccountSecurity(page);
  // 登录管理屏挂载拉设备列表 → mock 空列表，避免未 mock 的 API 噪声
  await mockJson(page, DEVICES_LIST_URL, 200, { devices: [] }, 'GET');

  // 登录管理 → push 设备列表（005 不回归）
  await page.getByRole('button', { name: '登录管理', exact: true }).tap();
  await expect(page).toHaveURL(/\/login-management$/, { timeout: 10_000 });

  // 返回 → 注销账号 → push 短信验证码注销发起（004 不回归）
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '注销账号', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security\/delete-account$/, {
    timeout: 10_000,
  });
});
