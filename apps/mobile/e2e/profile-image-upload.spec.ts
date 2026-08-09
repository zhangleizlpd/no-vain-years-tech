import { expect, test, type Page, type Route } from '@playwright/test';

// 009-profile-image-upload — Expo Web e2e：头像 / 主页背景图 换图（US3）+ 显示（US4）。
// 承接 007/008 seed/auth/mock 范式（account-security-refactor.spec.ts）。
//
// US3（换图，web 路径）：账号与安全 头像行 → action sheet「更换」→ <input type=file> 注入
//   测试图（filechooser）→ 裁剪「确认」→ mock EP1 凭证 + mock OSS host POST + mock EP2 confirm
//   200 → 资料卡头像缩略显真实图。web 不显示「拍照」。native picker 路径 = 设备/手动（SC-006）。
// US4（显示）：seed /me 含 avatarUrl/backgroundImageUrl → profile hero 渲染真实图（非 👤）+ 资料卡
//   缩略；null → 回落 002 emoji/占位（不 crash、不回归）。
//
// 必 mock refresh-token（EP1/EP2 是 authed 业务，401 触发 003 拦截器 retry-once；不 mock →
// clearSession 误跳 /login，per memory authed_business_401_triggers_refresh_interceptor）。
// 叠屏同名 label 用 getByRole 收窄（per memory playwright_expo_stacked_screen_locator_collision）。

const ME_URL = '**/api/v1/accounts/me';
const CRED_URL = '**/api/v1/accounts/me/profile-image/upload-credential';
const CONFIRM_URL = '**/api/v1/accounts/me/profile-image';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OSS_HOST = 'https://oss-e2e.example.com';
const OSS_GLOB = '**oss-e2e.example.com**';
const OBJECT_KEY = 'avatar/acc-e2e-009/uuid-e2e/img';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const SEED_PHONE = '+8613900139000';
const SEED_DISPLAY_NAME = '小明';
const SEED_ACCOUNT_ID = 'acc-e2e-009';

// 1x1 透明 PNG（注入文件 + OSS 缩略 GET 响应体）。
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BUFFER = Buffer.from(PNG_1x1, 'base64');

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
        accessToken: 'access-e2e-009',
        refreshToken: 'refresh-e2e-009',
        displayName: '${SEED_DISPLAY_NAME}',
        phone: '${SEED_PHONE}',
      },
      version: 0,
    }),
  );
`;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

test.setTimeout(120_000);

function credentialBody() {
  return {
    host: OSS_HOST,
    objectKey: OBJECT_KEY,
    expiresAt: '2026-06-01T00:15:00.000Z',
    fields: {
      key: OBJECT_KEY,
      policy: 'BASE64POLICY',
      'x-oss-signature-version': 'OSS4-HMAC-SHA256',
      'x-oss-credential': 'AK/20260601/cn-shanghai/oss/aliyun_v4_request',
      'x-oss-date': '20260601T000000Z',
      'x-oss-signature': 'deadbeef',
      success_action_status: '200',
    },
  };
}

// 有状态 /me：confirm（EP2）把 target 对应 url 写进闭包 profile，GET /me 回读最新值。
async function boot(page: Page, initProfile: Record<string, unknown> = {}) {
  const profile: Record<string, unknown> = {
    accountId: SEED_ACCOUNT_ID,
    phone: SEED_PHONE,
    displayName: SEED_DISPLAY_NAME,
    bio: null,
    gender: null,
    avatarUrl: null,
    backgroundImageUrl: null,
    status: 'ACTIVE',
    createdAt: '2026-05-31T00:00:00.000Z',
    ...initProfile,
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });

  // refresh-token（authed 业务 401 兜底，不真触发但必须 mock）。
  await page.route(REFRESH_URL, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: CORS });
    return json(route, {
      accountId: SEED_ACCOUNT_ID,
      accessToken: 'access-e2e-009',
      refreshToken: 'refresh-e2e-009',
    });
  });

  // EP1 凭证签发。
  await page.route(CRED_URL, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: CORS });
    return json(route, credentialBody());
  });

  // EP2 confirm → 落 target 对应 url，返回更新后 profile。
  await page.route(CONFIRM_URL, async (route: Route) => {
    const m = route.request().method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (m !== 'PATCH') return route.fallback();
    const body = JSON.parse(route.request().postData() ?? '{}') as { target?: string };
    const url = `${OSS_HOST}/${OBJECT_KEY}`;
    if (body.target === 'background') profile.backgroundImageUrl = url;
    else profile.avatarUrl = url;
    return json(route, profile);
  });

  // OSS host：POST 直传 → 200；GET 缩略 → png。
  await page.route(OSS_GLOB, async (route: Route) => {
    const m = route.request().method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (m === 'POST') {
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        body: '',
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: PNG_BUFFER,
    });
  });

  // GET /me（回读最新）。
  await page.route(ME_URL, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: CORS });
    return json(route, profile);
  });

  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
}

async function gotoAccountSecurity(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '账号与安全', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/account-security$/, { timeout: 10_000 });
}

// ─── US3: web 换头像全链（action sheet → file → crop → 上传 → 缩略显图） ───────────

test('US3 — 换头像 web 全链：更换 → 注入图 → 裁剪确认 → 上传 → 资料卡缩略显真实图', async ({
  page,
}) => {
  await boot(page);
  await gotoAccountSecurity(page);

  // 头像行 active → 开 action sheet
  await page.getByRole('button', { name: '头像', exact: true }).tap();
  await expect(page.getByText('更换头像')).toBeVisible({ timeout: 10_000 });

  // web 不显示「拍照」（native-only）；「更换」可见
  await expect(page.getByText('拍照')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更换', exact: true })).toBeVisible();

  // 「更换」→ <input type=file> 注入测试图（filechooser）
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '更换', exact: true }).tap(),
  ]);
  await chooser.setFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: PNG_BUFFER });

  // 裁剪 modal → 「确认」（react-easy-crop onCropComplete 后启用）
  await expect(page.getByText('裁剪')).toBeVisible({ timeout: 10_000 });
  const confirmBtn = page.getByRole('button', { name: '确认', exact: true });
  await expect(confirmBtn).toBeEnabled({ timeout: 10_000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us3-crop.png`, fullPage: true });
  await confirmBtn.tap();

  // 上传成功 → /me 回读 avatarUrl → 资料卡头像缩略显真实图（expo-image role=img），无错误弹窗
  await expect(page.getByRole('img', { name: '缩略图' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: '知道了', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us3-uploaded.png`, fullPage: true });
});

// ─── US4: 显示真实头像 / 背景图 + null 回落 ──────────────────────────────────────

test('US4 — seed /me 含 url → hero 渲染真实头像/背景图（非 👤），资料卡缩略', async ({ page }) => {
  await boot(page, {
    avatarUrl: `${OSS_HOST}/${OBJECT_KEY}`,
    backgroundImageUrl: `${OSS_HOST}/background/${SEED_ACCOUNT_ID}/u/img`,
  });

  // profile hero：真实头像图片 + 背景图片（expo-image role=img），👤 emoji 不出现
  await expect(page.getByRole('img', { name: '头像图片', exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByRole('img', { name: '背景图片', exact: true })).toBeVisible();
  await expect(page.getByText('👤')).toHaveCount(0);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us4-hero.png`, fullPage: true });

  // 资料卡两行缩略（头像 + 背景图）
  await gotoAccountSecurity(page);
  await expect(page.getByRole('img', { name: '缩略图' })).toHaveCount(2);
});

test('US4 — null → 回落 002 占位（具名用户首字母，不 crash、不回归）', async ({ page }) => {
  await boot(page); // avatarUrl / backgroundImageUrl 均 null（具名用户 → 002 首字母占位，非 👤）

  // hero 头像回落 002 占位：具名用户显首字母「小」，无真实头像/背景图图片
  await expect(page.getByText('小', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('img', { name: '头像图片', exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: '背景图片', exact: true })).toHaveCount(0);
});

// ─── US5: 查看大图（P2，pinch-zoom 手势=设备/手动；web e2e 验开/关 + 原图展示） ────────

test('US5 — 查看大图：seed 已设图 → action sheet 查看大图 → 全屏原图 → 关闭回原页', async ({
  page,
}) => {
  await boot(page, { avatarUrl: `${OSS_HOST}/${OBJECT_KEY}` });
  await gotoAccountSecurity(page);

  // 已设图 → action sheet 含「查看大图」
  await page.getByRole('button', { name: '头像', exact: true }).tap();
  await expect(page.getByText('更换头像')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '查看大图', exact: true }).tap();

  // 全屏 viewer 展示原图
  await expect(page.getByRole('img', { name: '查看大图' })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-viewer.png`, fullPage: true });

  // 关闭 → 回账号与安全（viewer 关、不导航）
  await page.getByRole('button', { name: '关闭大图', exact: true }).tap();
  await expect(page.getByRole('img', { name: '查看大图' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\/account-security$/);
});
