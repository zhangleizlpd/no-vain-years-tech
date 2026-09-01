import { expect, test, type Page, type Route } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 011-stock-market-access — Expo Web e2e（hermetic mock，进 runtime-smoke 门）。
//
// US3: 首屏默认态 + settings 投资入口 Card（证券市场 live + 券商账户 disabled）。
// US4: 切港股 ON → 持久化（stateful mock：PUT 翻态 → 重进 GET 返新态，对账）。
// US5: min-1 关最后一个激活核心市场 → 客户端预判拦截弹回 + 轻提示 + 不发 PUT
//      （断言无 0 激活中间态 = PUT 计数为 0，SC-M03）。
// US6: 海外行 disabled 置灰 + 「即将支持」+ 点击零副作用（无 PUT / 无 navigation，SC-M04）。
//
// Auth seeded via addInitScript（nvy-auth zustand-persist，同 settings-shell.spec）。
// portfolio GET/PUT 走 stateful page.route（mockJson 静态不够：US4 需 PUT 后 GET 返新态）。
// URL 断言用 web-stripped 路径（expo-router web 剥 (group)/ 段）。
// getByRole('switch') 收窄 toggle（RN Switch accessibilityRole='switch' → aria-checked/disabled）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const MARKET_URL_GLOB = '**/api/v1/portfolio/market-preferences**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-01-stock-market-access';

const SEED_ACCOUNT_ID = 'acc-e2e-011';
const SEED_REFRESH_TOKEN = 'refresh-e2e-011';
const SEED_ACCESS_TOKEN = 'access-e2e-011';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139011';

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

// 9 市场静态字典（镜像 server market-catalog；e2e 不依赖真后端，只对账 mock）。
const CATALOG = [
  { marketCode: 'cn', displayName: 'A 股', isoCurrency: 'CNY', group: 'core' },
  { marketCode: 'hk', displayName: '港股', isoCurrency: 'HKD', group: 'core' },
  { marketCode: 'us', displayName: '美股', isoCurrency: 'USD', group: 'core' },
  { marketCode: 'jp', displayName: '日股', isoCurrency: 'JPY', group: 'overseas' },
  { marketCode: 'sg', displayName: '新加坡', isoCurrency: 'SGD', group: 'overseas' },
  { marketCode: 'my', displayName: '马来西亚', isoCurrency: 'MYR', group: 'overseas' },
  { marketCode: 'ca', displayName: '加拿大', isoCurrency: 'CAD', group: 'overseas' },
  { marketCode: 'au', displayName: '澳大利亚', isoCurrency: 'AUD', group: 'overseas' },
  { marketCode: 'kr', displayName: '韩股', isoCurrency: 'KRW', group: 'overseas' },
] as const;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': '*',
};

type CoreState = { cn: boolean; hk: boolean; us: boolean };

// stateful portfolio mock：core 态可被 PUT 翻；GET 返全量 9 市场（海外恒 inactive）。
// 返回 putCount 计数器供 min-1 / 海外零副作用断言。
async function installMarketMock(page: Page, initial: CoreState): Promise<{ putCount: number }> {
  const state: CoreState = { ...initial };
  const counter = { putCount: 0 };

  const buildBody = () => ({
    markets: CATALOG.map((m) => ({
      marketCode: m.marketCode,
      displayName: m.displayName,
      isoCurrency: m.isoCurrency,
      group: m.group,
      v1Available: m.group === 'core',
      active: m.group === 'core' ? state[m.marketCode as keyof CoreState] : false,
    })),
  });

  const fulfillJson = (route: Route, status: number, payload: unknown) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(payload),
    });

  await page.route(MARKET_URL_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    if (method === 'GET') {
      await fulfillJson(route, 200, buildBody());
      return;
    }
    if (method === 'PUT') {
      counter.putCount += 1;
      const market = decodeURIComponent(new URL(req.url()).pathname.split('/').pop() ?? '');
      const { active } = (req.postDataJSON() ?? {}) as { active?: boolean };
      // server min-1 race fallback（客户端正常已拦截，故此路径在 e2e 不应被触达）。
      const activeCore = (['cn', 'hk', 'us'] as const).filter((c) => state[c]).length;
      if (active === false && state[market as keyof CoreState] && activeCore <= 1) {
        await fulfillJson(route, 422, {
          status: 422,
          title: 'min one',
          code: 'MIN_ONE_MARKET_REQUIRED',
        });
        return;
      }
      if (market in state && typeof active === 'boolean') state[market as keyof CoreState] = active;
      await fulfillJson(route, 200, buildBody());
      return;
    }
    await route.fallback();
  });

  return counter;
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
  // 防 authed 401 触发 refresh 拦截器误登出（per memory authed_business_401_triggers_refresh_interceptor）。
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

async function bootToProfile(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
}

async function enterStockMarket(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '证券市场', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/stock-market$/, { timeout: 10_000 });
}

// ─── US3: 默认态 + 投资入口 Card ─────────────────────────────────────────────

test('US3 — 投资设置 Card + 默认态(9 行/2 组/ISO label/A股 ON/港股·美股 OFF/海外 disabled)', async ({
  page,
}) => {
  await installMarketMock(page, { cn: true, hk: false, us: false });
  await bootToProfile(page);

  // 投资设置 Card：证券市场 + 券商账户 均 live（券商账户 012 T018 翻 live，原 D5 disabled 占位已退役）。
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: '证券市场', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '券商账户', exact: true })).toBeEnabled();

  // 进证券市场页。
  await page.getByRole('button', { name: '证券市场', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/stock-market$/, { timeout: 10_000 });

  // 9 行（toggle）/ 2 组标题。
  await expect(page.getByRole('switch')).toHaveCount(9);
  await expect(page.getByRole('heading', { name: '核心', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '海外', exact: true })).toBeVisible();

  // 核心默认态：A 股 ON、港股 / 美股 OFF。
  await expect(page.getByRole('switch', { name: 'A 股（CNY）' })).toBeChecked();
  await expect(page.getByRole('switch', { name: '港股（HKD）' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: '美股（USD）' })).not.toBeChecked();

  // 海外 6 行：disabled + 「即将支持」副文案。
  await expect(page.getByRole('switch', { name: '日股（JPY）' })).toBeDisabled();
  await expect(page.getByText('即将支持')).toHaveCount(6);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us3-default-state.png`, fullPage: true });
});

// ─── US4: 切港股 ON → 持久化 ─────────────────────────────────────────────────

test('US4 — 切港股 ON → 重进确认持久化(stateful mock 对账)', async ({ page }) => {
  await installMarketMock(page, { cn: true, hk: false, us: false });
  await bootToProfile(page);
  await enterStockMarket(page);

  const hkd = page.getByRole('switch', { name: '港股（HKD）' });
  await expect(hkd).not.toBeChecked();
  await hkd.click();
  await expect(hkd).toBeChecked(); // 乐观更新 + 响应对账

  // 重进（goBack → 再 tap）→ GET 返持久化态。
  await page.goBack();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole('button', { name: '证券市场', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/stock-market$/, { timeout: 10_000 });
  await expect(page.getByRole('switch', { name: '港股（HKD）' })).toBeChecked();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us4-hkd-persisted.png`, fullPage: true });
});

// ─── US5: min-1 关最后一个激活核心市场 → 弹回 + 提示 + 不发 PUT ────────────────

test('US5 — 关唯一激活核心市场 → 弹回 ON + 轻提示 + 不发 PUT(无 0 激活中间态)', async ({
  page,
}) => {
  const counter = await installMarketMock(page, { cn: true, hk: false, us: false });
  await bootToProfile(page);
  await enterStockMarket(page);

  const cny = page.getByRole('switch', { name: 'A 股（CNY）' });
  await expect(cny).toBeChecked();
  await cny.click(); // 尝试关唯一激活

  // 客户端预判拦截：toggle 弹回 ON + 轻提示，且不发 PUT（SC-M03 无 0 激活中间态）。
  await expect(page.getByText('至少保留一个激活市场')).toBeVisible();
  await expect(cny).toBeChecked();
  expect(counter.putCount).toBe(0);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-min-one-bounce.png`, fullPage: true });
});

// ─── US6: 海外行零副作用 ─────────────────────────────────────────────────────

test('US6 — 海外行 disabled + 点击零副作用(无 PUT / 无 navigation)', async ({ page }) => {
  const counter = await installMarketMock(page, { cn: true, hk: false, us: false });
  await bootToProfile(page);
  await enterStockMarket(page);

  const jpy = page.getByRole('switch', { name: '日股（JPY）' });
  await expect(jpy).toBeDisabled();
  // 点击 disabled toggle（force：disabled 不接受常规点击）→ 应无任何反应。
  await jpy.click({ force: true }).catch(() => undefined);

  await expect(jpy).not.toBeChecked(); // 态不变
  await expect(page).toHaveURL(/\/settings\/stock-market$/); // 无 navigation
  expect(counter.putCount).toBe(0); // 无 PUT

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us6-overseas-noop.png`, fullPage: true });
});
