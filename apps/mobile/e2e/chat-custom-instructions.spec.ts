import { expect, test, type Page, type Route } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 031-chat-custom-instructions — Expo Web e2e（hermetic mock，PR §V 第一层 UI 交互验证）。
//
// 覆盖 spec state_branches 的 mobile 侧（FR-002/004/005）：
//   设置 → 进「自定义指令」→ 空表单（首次，GET 返空串）→ 输入并保存（PUT）→
//   重进回显（hydrate，GET 返已存值）→ 修改保存 → 清空保存（空串=清空，D9）→
//   输入超 2000 字符 → 行内计数标红 + 保存禁用（FR-005，客户端先行拦截）。
//
// ── auth 边界（per memory authed_business_401_triggers_refresh_interceptor + store.ts）──
// store.ts partialize 不持久化 accessToken；seed localStorage 只含 refreshToken/accountId/
// displayName → boot 走 refresh-token 拿 access。故必 mock refresh-token（否则 AuthGate
// refresh 失败 → clearSession 跳 /login）+ mock /me（seed-auth e2e 硬强制，per
// mobile-e2e-hermetic）。GET/PUT /chat/preferences 走 orval(axios) authed → 同受 refresh
// 拦截器保护。tap 驱动（非手势，per RNGH web memory）；URL 断言用 web-stripped 路径
// （expo-router web export 去 `(group)/` 段）。叠屏同名 label 用 textbox/button role 收窄。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const PREFERENCES_URL = '**/api/v1/chat/preferences';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const SEED_ACCOUNT_ID = 'acc-e2e-031';
const SEED_REFRESH_TOKEN = 'refresh-e2e-031';
const SEED_ACCESS_TOKEN = 'access-e2e-031';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139031';

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
        refreshToken: '${SEED_REFRESH_TOKEN}',
        displayName: '${SEED_DISPLAY_NAME}',
        phone: '${SEED_PHONE}',
      },
      version: 0,
    }),
  );
`;

// /chat/preferences 走 PUT —— 共享 CORS preflight 须显式含 PUT（mockJson 默认 allow-methods
// 不含 PUT）。
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': '*',
};

// 有状态 /chat/preferences mock：闭包 customInstruction 被 PUT 改写，GET 回读最新值（保证
// 保存后重进回显 + 清空生效）。返回 ChatPreferenceResponse / UpsertChatPreferenceRequest 契约。
async function installPreferenceMock(page: Page, initial = '') {
  const pref = { customInstruction: initial };

  await page.route(PREFERENCES_URL, async (route: Route) => {
    const m = route.request().method();
    if (m === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    if (m === 'PUT') {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        customInstruction?: string;
      };
      pref.customInstruction = body.customInstruction ?? '';
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(pref),
      }));
    }

    // GET — 回读最新
    return void (await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(pref),
    }));
  });
}

async function bootToSettings(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
}

async function openCustomInstruction(page: Page) {
  await page.getByRole('button', { name: '自定义指令', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/chat-custom-instructions$/, { timeout: 10_000 });
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
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

test.setTimeout(120_000);

// ─── 主链：空表单 → 输入保存 → 重进回显 → 修改保存 ───────────────────────────────

test('设置 → 自定义指令：空表单 → 输入保存 → 重进 hydrate 回显 → 修改保存', async ({ page }) => {
  await installPreferenceMock(page, '');
  await bootToSettings(page);
  await openCustomInstruction(page);

  // 首次进屏：GET 返空串 → 空表单，计数 0/2000（叠屏：底层设置 Row 同名，用 textbox role 收窄）
  const field = page.getByRole('textbox', { name: '自定义指令' });
  await expect(field).toHaveValue('');
  await expect(page.getByText('0/2000')).toBeVisible();

  // 输入 → 计数实时更新 → 保存 → 返回设置页
  await field.fill('回答尽量简洁，用要点列出');
  await expect(page.getByText('12/2000')).toBeVisible();
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/031-custom-instruction-edit.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: '保存', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });

  // 重进 → GET 回读已存值 → hydrate 回显（验持久化往返 + 字节级回显）
  await openCustomInstruction(page);
  await expect(page.getByRole('textbox', { name: '自定义指令' })).toHaveValue(
    '回答尽量简洁，用要点列出',
  );

  // 修改保存 → 再重进回显新值
  await page.getByRole('textbox', { name: '自定义指令' }).fill('面向投资新手用通俗语言解释');
  await page.getByRole('button', { name: '保存', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await openCustomInstruction(page);
  await expect(page.getByRole('textbox', { name: '自定义指令' })).toHaveValue(
    '面向投资新手用通俗语言解释',
  );
});

// ─── 清空：保存空串 = 清空（D9），重进回显空表单 ──────────────────────────────────

test('清空保存（空串 = 清空，D9）→ 重进回显空表单', async ({ page }) => {
  await installPreferenceMock(page, '已有的旧指令');
  await bootToSettings(page);
  await openCustomInstruction(page);

  // 预填已有值
  const field = page.getByRole('textbox', { name: '自定义指令' });
  await expect(field).toHaveValue('已有的旧指令');

  // 清空 → 保存（空串合法）→ 返回
  await field.fill('');
  await expect(page.getByText('0/2000')).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });

  // 重进 → GET 回读空串 → 空表单（清空生效）
  await openCustomInstruction(page);
  await expect(page.getByRole('textbox', { name: '自定义指令' })).toHaveValue('');
});

// ─── 超 2000 字符 → 行内计数标红 + 保存禁用（FR-005，客户端先行拦截，不打 PUT）──────

test('超 2000 字符 → 计数标红 + 保存禁用（FR-005 客户端先行拦截）', async ({ page }) => {
  let putCalls = 0;
  await installPreferenceMock(page, '');
  // 监听 PUT 次数：超长场景保存禁用 → 不应发出 PUT
  await page.route(PREFERENCES_URL, async (route: Route) => {
    if (route.request().method() === 'PUT') putCalls += 1;
    await route.fallback();
  });

  await bootToSettings(page);
  await openCustomInstruction(page);

  const field = page.getByRole('textbox', { name: '自定义指令' });
  // TextInput maxLength=2000 截断键入，故先填 2000 验保存可用，再用 setValue 越过原生上限验校验
  await field.fill('a'.repeat(2000));
  await expect(page.getByText('2000/2000')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();

  // 注入 2001 字符（绕过 TextInput maxLength 硬闸，模拟极端输入）→ schema invalid →
  // 保存禁用，计数标红。RN-Web TextInput 是受控 <textarea>，直接 set value + 派发 input。
  await field.evaluate((el) => {
    const ta = el as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(ta, 'a'.repeat(2001));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.getByText('2001/2000')).toBeVisible();

  // 保存禁用即客户端先行拦截（FR-005）—— 禁用按钮无法点击触发 PUT，disabled 态本身是契约保证。
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  // 给一小窗确认越长输入未触发任何 PUT（onChange 不会自动提交）。
  await page.waitForTimeout(300);
  expect(putCalls).toBe(0);
});
