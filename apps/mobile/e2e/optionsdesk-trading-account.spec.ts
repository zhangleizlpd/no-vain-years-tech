import { expect, test, type Locator, type Page } from './_support/fixtures';
import type { RadarResponse } from '@nvy/api-client';

import { mockJson } from './_support/api-mock';

// 081 — 期权台交易账户页骨架 hermetic UI e2e（Playwright Expo Web）。
//
// 覆盖（逐条对应 specs/081-optionsdesk-trading-account-shell/tasks.md）：
//   T003 ① 深链进入 ⇒ 标题 + 美股页签选中（sb 3；同时是 `testIdPrefix` 的 RED）
//        ② 深链进入后 header 返回 ⇒ 回期权台 tab（sb 10）
//        ③ 切港股 ⇒ 港股选中、无错误文案（sb 11 前半）
//   T004 ① 默认「持仓」段选中 + 占位标题（sb 3）
//        ② 选「订单」后切港股 ⇒ 分段不被弹回（sb 6 / Edge）
//        ③ 选港股后切「报表」⇒ 市场不被弹回（sb 7 / Edge）
//        ④ 2 市场 × 3 分段遍历 ⇒ 标题正确、无空数据字眼与错误文案（sb 8 / sb 11 后半）
//   T005 ① 雷达点钱包入口 ⇒ 进交易账户页，且从雷达起恰 3 次点击到达「港股 · 报表」（sb 1 / SC-001）
//        ② 360×800 视口：题头标题与 4 个入口按钮 boundingBox 两两不相交、每个按钮宽 ≥40（FR-001 / SC-006）
//   T006 ① 选「港股 · 订单」→ header 返回雷达 → 再点入口 ⇒ 仍「港股 · 订单」（sb 4 / SC-005）
//        ② `page.reload()` 后深链进入 ⇒ 回默认「美股 · 持仓」（sb 5）
//        ③ 雷达停美股 → 进页切港股 → 返回 ⇒ 雷达美股页签仍为选中样式（sb 9 / SC-004）
//
// ── hermetic 边界 ────────────────────────────────────────────────────────────
//   🚨 **只 mock `/me` + refresh**（App 级登录态前置，不属本页依赖）；其余 `/api/**` 一律走
//      `_support/fixtures` 的默认 abort ⇒ 「服务端不可达」是本文件每条 test 的**常态**，
//      FR-008「本页零请求、零错误态」由此天然被每条断言覆盖。
//   📌 从雷达进入的臂另装 `installRadarMock`（只 `GET /optionsdesk/radar`，雷达首屏渲染前置，
//      同样不属本页依赖）；本页自身仍零请求。
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

// ════════════════════════════════════════════════════════════════════════════
// T004 —— 胶囊分段 + 三类占位
// ════════════════════════════════════════════════════════════════════════════

const SEGMENTS = ['positions', 'orders', 'reports'] as const;
type Segment = (typeof SEGMENTS)[number];

/** 占位标题逐字（copy SoT = `optionsdesk-copy.ts` `tradingAccount.placeholder`）。 */
const PLACEHOLDER_TITLE: Record<Segment, string> = {
  positions: '持仓 · 建设中',
  orders: '订单 · 建设中',
  reports: '报表 · 建设中',
};

/** 「有数据面」的空态字眼（FR-007：占位只说建设中，不许冒充空数据）。 */
const EMPTY_DATA_TEXT_RE = /暂无|空仓|无数据/;

function segmentId(segment: Segment): string {
  return `optionsdesk-trading-account-segment-${segment}`;
}

function segmentIds(): string[] {
  return SEGMENTS.map(segmentId);
}

function marketTabId(market: (typeof MARKETS)[number]): string {
  return `optionsdesk-trading-account-market-tab-${market}`;
}

/** 本屏内恰呈该分段的占位标题，另两段的标题不出现（收窄到屏根，防雷达 tab 屏 DOM 双命中）。 */
async function expectPlaceholderOf(page: Page, segment: Segment): Promise<void> {
  const screen = page.getByTestId(SCREEN);
  await expect(screen.getByText(PLACEHOLDER_TITLE[segment], { exact: true })).toBeVisible();
  for (const other of SEGMENTS) {
    if (other !== segment) {
      await expect(screen.getByText(PLACEHOLDER_TITLE[other], { exact: true })).toHaveCount(0);
    }
  }
}

/** 市场页签与分段**各恰一个**为选中样式（Edge「不出现两个同时选中」）。 */
async function expectSelection(
  page: Page,
  market: (typeof MARKETS)[number],
  segment: Segment,
): Promise<void> {
  await expectExactlyOneSelected(page, marketTabIds(), marketTabId(market));
  await expectExactlyOneSelected(page, segmentIds(), segmentId(segment));
}

test('081 T004① 默认「持仓」段为选中样式 + 标题「持仓 · 建设中」（sb 3 / FR-003）', async ({
  page,
}) => {
  await gotoTradingAccount(page);

  await expect(page.getByTestId(segmentId('positions'))).toBeVisible();
  await expectSelection(page, 'us', 'positions');
  await expectPlaceholderOf(page, 'positions');
});

test('081 T004② 选「订单」后切港股 ⇒ 仍「订单」，市场与分段各恰一个选中（sb 6 / Edge）', async ({
  page,
}) => {
  await gotoTradingAccount(page);

  await expect(page.getByTestId(segmentId('orders'))).toBeVisible();
  await page.getByTestId(segmentId('orders')).tap();
  await expectPlaceholderOf(page, 'orders');
  await page.getByTestId(marketTabId('hk')).tap();

  await expectSelection(page, 'hk', 'orders');
  await expectPlaceholderOf(page, 'orders');
});

test('081 T004③ 选港股后切「报表」⇒ 港股仍选中，市场与分段各恰一个选中（sb 7 / Edge）', async ({
  page,
}) => {
  await gotoTradingAccount(page);

  await expect(page.getByTestId(segmentId('reports'))).toBeVisible();
  await page.getByTestId(marketTabId('hk')).tap();
  await expectExactlyOneSelected(page, marketTabIds(), marketTabId('hk'));
  await page.getByTestId(segmentId('reports')).tap();

  await expectSelection(page, 'hk', 'reports');
  await expectPlaceholderOf(page, 'reports');
});

test('081 T004④ 2 市场 × 3 分段遍历 ⇒ 标题正确、无空数据字眼与错误文案（sb 8 / sb 11 / SC-002 / SC-003）', async ({
  page,
}) => {
  await gotoTradingAccount(page);
  await expect(page.getByTestId(segmentId('positions'))).toBeVisible();
  const screen = page.getByTestId(SCREEN);

  for (const market of MARKETS) {
    await page.getByTestId(marketTabId(market)).tap();
    for (const segment of SEGMENTS) {
      await page.getByTestId(segmentId(segment)).tap();

      await expectSelection(page, market, segment);
      await expectPlaceholderOf(page, segment);
      await expect(screen.getByText(EMPTY_DATA_TEXT_RE)).toHaveCount(0);
      await expectNoErrorText(page);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// T005 —— 雷达题头第 4 入口 + 布局修正
// ════════════════════════════════════════════════════════════════════════════

const RADAR_TITLE = '击球区雷达';
const RADAR_TRADING_ACCOUNT_BUTTON = 'optionsdesk-radar-trading-account-button';
/** 题头右排入口，次序 ⚙ 🌡 🔍 钱包（plan §D3）。 */
const RADAR_HEADER_ENTRY_IDS = [
  'optionsdesk-anchors-button',
  'optionsdesk-thermometer-button',
  'optionsdesk-radar-search-button',
  RADAR_TRADING_ACCOUNT_BUTTON,
] as const;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
};

/**
 * 雷达首屏最小 mock（照 `optionsdesk-anchors-radar.spec.ts` `installOptionsdeskMock` 形态最小复刻）。
 * 只认 `GET /optionsdesk/radar`；canonical 锚集合为空 ⇒ 按 server 空态四分口径恒判 `zero_anchors`
 * （纯函数，无调用序分支）。其余 optionsdesk 请求 `fallback` 到 fixtures 默认 abort。
 */
async function installRadarMock(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/optionsdesk\/radar/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void (await route.fulfill({ status: 204, headers: CORS }));
    }
    if (req.method() !== 'GET') return void (await route.fallback());
    const body: RadarResponse = {
      items: [],
      nextCursor: null,
      hasMore: false,
      emptyState: 'zero_anchors',
      emptyStateMessage: '还没有锚 —— 先去锚管理建第一个锚',
      marketCounts: [],
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  });
}

/** 进期权台 tab 雷达（首发吃 Metro 冷打包 ⇒ 长超时锚在 tab bar；照 anchors-radar spec 同名体例）。 */
async function gotoRadar(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '期权台' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '期权台' }).tap();
  await expect(page.getByTestId('optionsdesk-anchors-button')).toBeVisible({ timeout: 30_000 });
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error('boundingBox 不可得');
  return box;
}

/** 亚像素容差：布局取小数宽，相邻元素贴边时两框可能差 1e-3 级「重叠」，不是遮挡。 */
const OVERLAP_EPSILON = 0.5;

function intersects(a: Box, b: Box): boolean {
  return (
    a.x + OVERLAP_EPSILON < b.x + b.width &&
    b.x + OVERLAP_EPSILON < a.x + a.width &&
    a.y + OVERLAP_EPSILON < b.y + b.height &&
    b.y + OVERLAP_EPSILON < a.y + a.height
  );
}

test('081 T005① 雷达点钱包入口 ⇒ 进交易账户页；从雷达起恰 3 次点击到「港股 · 报表」（sb 1 / SC-001）', async ({
  page,
}) => {
  await installRadarMock(page);
  await gotoRadar(page);

  // SC-001 数点击：从雷达起的每一次用户点击都经 `tapCounted`，终点断次数恰为 3。
  let clicks = 0;
  const tapCounted = async (testId: string): Promise<void> => {
    await page.getByTestId(testId).tap();
    clicks += 1;
  };

  await tapCounted(RADAR_TRADING_ACCOUNT_BUTTON);
  await expect(page.getByTestId(SCREEN)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/optionsdesk\/trading-account$/);
  await expect(page.getByRole('heading', { name: '交易账户' })).toBeVisible();

  await tapCounted(marketTabId('hk'));
  await tapCounted(segmentId('reports'));

  await expectSelection(page, 'hk', 'reports');
  await expectPlaceholderOf(page, 'reports');
  expect(clicks, 'SC-001：从雷达起到达「港股 · 报表」的点击次数').toBe(3);
});

test('081 T005② 360×800 视口：题头标题与 4 个入口按钮互不遮挡、每个按钮宽 ≥40（FR-001 / SC-006）', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await installRadarMock(page);
  await gotoRadar(page);

  const boxes: { name: string; box: Box }[] = [
    { name: RADAR_TITLE, box: await boxOf(page.getByText(RADAR_TITLE, { exact: true })) },
  ];
  for (const id of RADAR_HEADER_ENTRY_IDS) {
    const box = await boxOf(page.getByTestId(id));
    expect(box.width, `${id} 热区宽度`).toBeGreaterThanOrEqual(40);
    boxes.push({ name: id, box });
  }

  expect(boxes).toHaveLength(5);
  // 横向溢出屏外同样算「看不到」：入口组若按等分宽起排、向右溢出，框两两不相交却被裁掉。
  for (const { name, box } of boxes) {
    expect(box.x, `${name} 左缘出屏`).toBeGreaterThanOrEqual(-OVERLAP_EPSILON);
    expect(box.x + box.width, `${name} 右缘出屏`).toBeLessThanOrEqual(360 + OVERLAP_EPSILON);
  }
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      expect(intersects(a.box, b.box), `${a.name} 与 ${b.name} 相交`).toBe(false);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// T006 —— 离开再进记忆 / 刷新回默认 / 与雷达互不影响（行为由 T002 store + T003 路由承担）
// ════════════════════════════════════════════════════════════════════════════

function radarMarketTabIds(): string[] {
  return MARKETS.map((m) => `optionsdesk-radar-market-tab-${m}`);
}

/** 从雷达点钱包入口进页（本屏根可见为止）。 */
async function enterFromRadar(page: Page): Promise<void> {
  await page.getByTestId(RADAR_TRADING_ACCOUNT_BUTTON).tap();
  await expect(page.getByTestId(SCREEN)).toBeVisible({ timeout: 30_000 });
}

/** header 返回雷达，且本屏**已卸载**（push 屏返回即卸载 —— 记忆臂要验的正是跨卸载）。 */
async function backToRadar(page: Page): Promise<void> {
  await headerBack(page);
  await expect(page).toHaveURL(/\/optionsdesk\/?$/, { timeout: 30_000 });
  await expect(page.getByTestId(SCREEN)).toHaveCount(0);
}

test('081 T006① 选「港股 · 订单」→ 返回雷达 → 再点入口 ⇒ 仍「港股 · 订单」（sb 4 / SC-005 / FR-004）', async ({
  page,
}) => {
  await installRadarMock(page);
  await gotoRadar(page);
  await enterFromRadar(page);

  await page.getByTestId(marketTabId('hk')).tap();
  await page.getByTestId(segmentId('orders')).tap();
  await expectSelection(page, 'hk', 'orders');

  await backToRadar(page);
  await enterFromRadar(page);

  await expectSelection(page, 'hk', 'orders');
  await expectPlaceholderOf(page, 'orders');
});

test('081 T006② 选「港股 · 订单」后 page.reload() 深链进入 ⇒ 回默认「美股 · 持仓」（sb 5 / FR-004）', async ({
  page,
}) => {
  await gotoTradingAccount(page);
  await expect(page.getByTestId(segmentId('orders'))).toBeVisible();
  await page.getByTestId(marketTabId('hk')).tap();
  await page.getByTestId(segmentId('orders')).tap();
  await expectSelection(page, 'hk', 'orders');

  // 硬刷新 = 进程重启（spec Assumptions）；刷新后的落点就是深链 URL 本身。
  await page.reload();
  await expect(page).toHaveURL(/\/optionsdesk\/trading-account$/);
  await expect(page.getByTestId(SCREEN)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId(segmentId('positions'))).toBeVisible();

  await expectSelection(page, 'us', 'positions');
  await expectPlaceholderOf(page, 'positions');
});

test('081 T006③ 雷达停美股 → 进页切港股 → 返回 ⇒ 雷达美股页签仍为选中样式（sb 9 / SC-004 / FR-006）', async ({
  page,
}) => {
  await installRadarMock(page);
  await gotoRadar(page);
  await expectExactlyOneSelected(page, radarMarketTabIds(), 'optionsdesk-radar-market-tab-us');

  await enterFromRadar(page);
  await page.getByTestId(marketTabId('hk')).tap();
  await expectExactlyOneSelected(page, marketTabIds(), marketTabId('hk'));

  await backToRadar(page);
  await expectExactlyOneSelected(page, radarMarketTabIds(), 'optionsdesk-radar-market-tab-us');
});
