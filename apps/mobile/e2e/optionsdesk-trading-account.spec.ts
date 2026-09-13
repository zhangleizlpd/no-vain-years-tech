import { expect, test, type Locator, type Page } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 081 — 期权台交易账户页骨架 hermetic UI e2e（Playwright Expo Web）。
//
// 覆盖（逐条对应 specs/081-optionsdesk-trading-account-shell/tasks.md）：
//   T003 ① 深链进入 ⇒ 标题 + 美股页签选中（sb 3；同时是 `testIdPrefix` 的 RED）
//        ② 深链进入后 header 返回 ⇒ 回期权台 tab（sb 10）
//        ③ 切港股 ⇒ 港股选中、无错误文案（sb 11 前半）
//
// ── hermetic 边界 ────────────────────────────────────────────────────────────
//   🚨 **只 mock `/me` + refresh**（App 级登录态前置，不属本页依赖）；其余 `/api/**` 一律走
//      `_support/fixtures` 的默认 abort ⇒ 「服务端不可达」是本文件每条 test 的**常态**，
//      FR-008「本页零请求、零错误态」由此天然被每条断言覆盖。
//
// ── 选中态断言：样式自比较 ─────────────────────────────────────────────────────
//   `react-native-web` 丢弃 `accessibilityState` ⇒ 无 `aria-selected` 可断（正向必红、反向恒真）。
//   改比 computed style：选中项底色与其余**不同**、字重**严格更重**，其余项彼此相同 ⇒ 恰一个选中。
//   🚫 不硬编码色值（token 改了不该假红）。
//
// ── Expo web e2e 坑 ──────────────────────────────────────────────────────────
//   · `(app)/_layout` 锚了 `initialRouteName: '(tabs)'` ⇒ 深链进入时雷达 tab 屏**也在 DOM 里**
//     （且它的请求被 abort 会渲出错误文案）⇒ 文案断言一律收窄到本屏根 `optionsdesk-trading-account-screen`。
//   · 🚫 **禁 `page.goBack`**（嵌套 Stack 的 popstate 被重映射到栈首屏）⇒ 用 header 返回箭头。
//   · `(group)` 段在 URL 隐藏：`/(app)/(tabs)/optionsdesk` → `/optionsdesk`。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';

const SEED_ACCOUNT_ID = 'acc-e2e-081';
const SEED_ACCESS_TOKEN = 'access-e2e-081';
const SEED_REFRESH_TOKEN = 'refresh-e2e-081';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139081';

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

const DEEP_LINK = '/optionsdesk/trading-account';
const SCREEN = 'optionsdesk-trading-account-screen';
const MARKETS = ['us', 'hk'] as const;

/** 错误态的通用字眼（本页 FR-008 不该出现任何一个）。 */
const ERROR_TEXT_RE = /失败|错误|出错|异常|重试|不可达|网络/;

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
  // 防 authed 401 触发 003 refresh 拦截器误登出。
  await mockJson(page, REFRESH_URL, 200, {
    accountId: SEED_ACCOUNT_ID,
    accessToken: SEED_ACCESS_TOKEN,
    refreshToken: SEED_REFRESH_TOKEN,
  });
});

test.setTimeout(120_000);

/** 深链进交易账户页（首发吃 Metro 冷打包 ⇒ 长超时锚在本屏根节点）。 */
async function gotoTradingAccount(page: Page): Promise<void> {
  await page.goto(DEEP_LINK);
  await expect(page.getByTestId(SCREEN)).toBeVisible({ timeout: 90_000 });
}

/**
 * navigator header 的返回箭头（照 `optionsdesk-anchors-radar.spec.ts` 同名局部函数）。
 * a11y 名恒为 `<上屏标题>, back`，角色随 header 实现在 `link` / `button` 间变 ⇒ 两者取并。
 */
function headerBackLocator(page: Page) {
  return page
    .getByRole('button', { name: /back/i })
    .or(page.getByRole('link', { name: /back/i }))
    .first();
}

/** in-app header back（非 page.goBack —— 嵌套 Stack 的 popstate 被重映射到栈首屏）。 */
async function headerBack(page: Page): Promise<void> {
  await headerBackLocator(page).tap();
}

interface SelectionStyle {
  bg: string;
  weight: number;
}

/** 可选项的选中样式两通道：自身底色 + 标签字重（标签 = 首个 RNW Text 节点）。 */
async function selectionStyleOf(locator: Locator): Promise<SelectionStyle> {
  return locator.evaluate((el) => {
    const label = el.querySelector('[dir="auto"]') ?? el;
    return {
      bg: getComputedStyle(el).backgroundColor,
      weight: Number(getComputedStyle(label).fontWeight),
    };
  });
}

/**
 * 一组可选项里**恰有一个**是选中样式、且就是 `selectedTestId`。
 * 判据全是相对的：选中项底色 ≠ 每个未选项、字重 > 每个未选项；未选项彼此底色与字重相同。
 */
async function expectExactlyOneSelected(
  page: Page,
  testIds: readonly string[],
  selectedTestId: string,
): Promise<void> {
  expect(testIds, `${selectedTestId} 不在候选集里`).toContain(selectedTestId);
  const on = await selectionStyleOf(page.getByTestId(selectedTestId));
  const offs: SelectionStyle[] = [];
  for (const id of testIds) {
    if (id !== selectedTestId) offs.push(await selectionStyleOf(page.getByTestId(id)));
  }
  expect(offs.length).toBe(testIds.length - 1);
  for (const off of offs) {
    expect(on.bg, `${selectedTestId} 底色应与未选项不同`).not.toBe(off.bg);
    expect(on.weight, `${selectedTestId} 字重应重于未选项`).toBeGreaterThan(off.weight);
    expect(off).toEqual(offs[0]);
  }
}

function marketTabIds(): string[] {
  return MARKETS.map((m) => `optionsdesk-trading-account-market-tab-${m}`);
}

/** 本屏根节点内无任何错误文案（收窄到本屏：深链时雷达 tab 屏也在 DOM 且其请求被 abort）。 */
async function expectNoErrorText(page: Page): Promise<void> {
  await expect(page.getByTestId(SCREEN).getByText(ERROR_TEXT_RE)).toHaveCount(0);
}

// ════════════════════════════════════════════════════════════════════════════
// T003 —— 路由 + 屏骨架 + 市场页签前缀 + 深链返回
// ════════════════════════════════════════════════════════════════════════════

test('081 T003① 深链进入 ⇒ 标题「交易账户」可见、美股页签为选中样式（sb 3）', async ({ page }) => {
  await gotoTradingAccount(page);

  await expect(page.getByRole('heading', { name: '交易账户' })).toBeVisible();
  // 🚨 这条同时是 `testIdPrefix` 的 RED：屏内不传前缀会落回 `optionsdesk-radar-market-*`。
  await expect(page.getByTestId('optionsdesk-trading-account-market-tabs')).toBeVisible();
  await expectExactlyOneSelected(page, marketTabIds(), 'optionsdesk-trading-account-market-tab-us');
});

test('081 T003② 深链进入后 header 返回 ⇒ 回到期权台 tab（sb 10 / FR-010）', async ({ page }) => {
  await gotoTradingAccount(page);

  await expect(headerBackLocator(page)).toBeVisible({ timeout: 30_000 });
  await headerBack(page);
  await expect(page).toHaveURL(/\/optionsdesk\/?$/, { timeout: 30_000 });
  await expect(page.getByTestId(SCREEN)).toHaveCount(0);
});

test('081 T003③ 切到港股 ⇒ 港股为选中样式、页面无错误文案（sb 11 前半）', async ({ page }) => {
  await gotoTradingAccount(page);

  await page.getByTestId('optionsdesk-trading-account-market-tab-hk').tap();
  await expectExactlyOneSelected(page, marketTabIds(), 'optionsdesk-trading-account-market-tab-hk');
  await expectNoErrorText(page);
});
