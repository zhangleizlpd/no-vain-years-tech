import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';
import { keypadBackspace, keypadConfirm, keypadType } from './_support/alert-sheet';

// 024-alert-realtime PR-3 §V 第一层 UI 交互验证（Playwright hermetic mock）。
// 023 alert-indicators.spec.ts 验 32 词表 / 4 分类 / 参数变体族；本套验 024 扩出的盘中 5min
// 2 新类型（PRICE_RISE/FALL_5MIN_OVER）在 add-condition 屏的全流接通——meta 驱动入「价格」分类、
// 走 ValueInputSheet 百分比阈值变体、建预警后卡片摘要回显。021/023 既有 e2e 零改（本文件独立）。
//
// Test 1（US2 建「5 分钟涨超 3%」全流 + 卡片摘要回显 + POST 契约对齐）：屏 3 价格分类选「5分钟涨超」
//   → sheet 填 3（% 单位）→ 选好了 → 完成 → 屏 1 卡片摘要「5分钟涨超 3.00%」；POST payload
//   conditions=[{type:PRICE_RISE_5MIN_OVER, threshold:3}]（无 param，023 契约：percent 阈值 only）。
// Test 2（FR-M02 percent 阈值门控）：5min 类阈值出域（101 / 0）→「选好了」disabled；填 3 → 恢复。
//
// 入口经真 014 详情屏（自选行→详情→底栏「预警」→屏 1→添加预警→屏 2→添加附加条件→屏 3）。
// alert mock 单一 stateful page.route：EP3 POST 镜像 023/024 契约——param number(0 sentinel)/
// threshold string|null。mock 003 refresh 防 authed 401 误登出（per memory
// authed_business_401_triggers_refresh_interceptor）。stacked screen 用 getByRole + exact 收窄
// （per memory playwright_expo_stacked_screen_locator_collision）。纯逻辑（草稿键/校验/盘中价
// 正文格式化）已 vitest 覆盖，本层只验交互/渲染/路由接通。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const PORTFOLIO_GLOB = '**/api/v1/portfolio/**';
const INSTRUMENTS_GLOB = '**/api/v1/marketdata/instruments/**';
const QUOTE_GLOB = '**/api/v1/marketdata/quote**';
const SEARCH_GLOB = '**/api/v1/marketdata/search**';
const ALERT_GLOB = '**/api/v1/alert/**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-09-alert-realtime';

const SEED_ACCOUNT_ID = 'acc-e2e-024';
const SEED_REFRESH_TOKEN = 'refresh-e2e-024';
const SEED_ACCESS_TOKEN = 'access-e2e-024';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139024';

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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};

// 单标的 600519（屏 1 行情条 + 详情屏数据源）。昨收 1675.50，主板 ±10%。
const SYMBOL = 'cn:600519';
const QUOTE = { price: '1688.00', change: '12.50', changePct: '0.75' };
const NAME = '贵州茅台';

const fulfill = (route: Route, status: number, payload: unknown) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(payload),
  });

function makeDetail() {
  const [market, code] = SYMBOL.split(':');
  return {
    symbol: SYMBOL,
    name: NAME,
    type: 'stock',
    market,
    code,
    currency: 'CNY',
    status: 'listed',
    listDate: '2001-08-27',
    delistDate: null,
    quote: {
      price: QUOTE.price,
      change: QUOTE.change,
      changePct: QUOTE.changePct,
      prevClose: null,
      asOf: '2026-06-05',
      priceKind: 'eod_close',
      hasData: true,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
    },
    valuation: null,
    financials: null,
    corporateActions: [],
  };
}

// 013/014/015 只读面：自选组单只 600519（屏 1 行情条 + 详情屏数据源）。
async function installMarketMocks(page: Page) {
  const groups = [
    {
      id: 'g-watch',
      name: '自选',
      type: 'system',
      systemKind: 'watchlist',
      visible: true,
      order: 0,
      itemCount: 1,
    },
    {
      id: 'g-hold',
      name: '持仓',
      type: 'system',
      systemKind: 'holdings',
      visible: true,
      order: 1,
      itemCount: 0,
    },
  ];
  const items = [
    {
      id: 'i-1',
      groupId: 'g-watch',
      market: 'cn',
      code: '600519',
      pinned: false,
      order: 0,
      color: null,
      noteRef: null,
    },
  ];

  await page.route(PORTFOLIO_GLOB, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname.replace('/api/v1/portfolio/', '');
    const seg = path.split('/');
    if (seg[0] === 'instruments' && seg[3] === 'watchlist-status') {
      const rows = items.filter((it) => it.market === seg[1] && it.code === seg[2]);
      return void (await fulfill(route, 200, {
        inWatchlist: rows.length > 0,
        memberships: rows.map((it) => ({ groupId: it.groupId, itemId: it.id })),
      }));
    }
    if (path === 'watchlist-groups' && req.method() === 'GET')
      return void (await fulfill(route, 200, { groups }));
    if (seg[0] === 'watchlist-groups' && seg[1] && seg[2] === 'items' && req.method() === 'GET') {
      return void (await fulfill(route, 200, {
        items: items.filter((it) => it.groupId === seg[1]),
      }));
    }
    await route.fallback();
  });

  await page.route(INSTRUMENTS_GLOB, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    await fulfill(route, 200, makeDetail());
  });

  await page.route(QUOTE_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const symbols = (new URL(route.request().url()).searchParams.get('symbols') ?? '')
      .split(',')
      .filter(Boolean);
    const list = symbols.map((symbol) =>
      symbol === SYMBOL
        ? {
            symbol,
            name: NAME,
            ...QUOTE,
            asOf: '2026-06-05',
            priceKind: 'eod_close',
            hasData: true,
          }
        : {
            symbol,
            name: null,
            price: null,
            change: null,
            changePct: null,
            asOf: null,
            priceKind: 'eod_close',
            hasData: false,
          },
    );
    await fulfill(route, 200, { items: list });
  });

  await page.route(SEARCH_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    await fulfill(route, 200, { items: [] });
  });
}

interface MockCondition {
  type: string;
  param: number;
  threshold: string | null;
}
interface MockAlert {
  id: string;
  market: string;
  code: string;
  conditions: MockCondition[];
  frequency: string;
  note: string | null;
  enabled: boolean;
  createdAt: string;
}
interface AlertMock {
  createPayloads: () => Record<string, unknown>[];
}

// alert stateful mock：EP1/EP2 读、EP3 建。POST 镜像 023/024 契约：条件 param number(0 sentinel)
// + threshold Decimal string|null（无阈值类型 null）——卡片摘要 formatConditionLine 据此回显。
async function installAlertMock(page: Page): Promise<AlertMock> {
  const alerts: MockAlert[] = [];
  let seq = 0;
  const createPayloads: Record<string, unknown>[] = [];

  await page.route(ALERT_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname.replace('/api/v1/alert/', '');
    const seg = path.split('/');
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;

    // EP1 个股预警列表（屏 1 卡片数据源）。
    if (seg[0] === 'instruments' && seg[3] === 'alerts' && method === 'GET') {
      return void (await fulfill(route, 200, {
        alerts: alerts.filter((a) => a.market === seg[1] && a.code === seg[2]),
      }));
    }
    // EP2 全账号列表（编辑屏数据源）。
    if (path === 'alerts' && method === 'GET') return void (await fulfill(route, 200, { alerts }));
    // EP3 建预警（批量；单只 1 元素）。
    if (path === 'alerts' && method === 'POST') {
      createPayloads.push(body);
      const conditions: MockCondition[] = (
        body['conditions'] as { type: string; param?: number; threshold?: number }[]
      ).map((c) => ({
        type: c.type,
        param: c.param ?? 0,
        threshold: c.threshold != null ? String(c.threshold) : null,
      }));
      const created = (body['instruments'] as { market: string; code: string }[]).map((i) => ({
        id: `a-new-${++seq}`,
        market: i.market,
        code: i.code,
        conditions,
        frequency: String(body['frequency'] ?? 'DAILY'),
        note: (body['note'] as string | null) ?? null,
        enabled: true,
        createdAt: '2026-06-09T10:00:00.000Z',
      }));
      alerts.push(...created);
      return void (await fulfill(route, 200, { alerts: created }));
    }
    // 消息面（工具栏角标 EP7 等）：空，防 fallback 真网络噪声。
    if (path === 'messages' && method === 'GET')
      return void (await fulfill(route, 200, { messages: [], nextCursor: null }));
    if (path === 'messages/unread-count' && method === 'GET')
      return void (await fulfill(route, 200, { unread: 0 }));

    await route.fallback();
  });

  return { createPayloads: () => createPayloads };
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

async function bootToPortfolio(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '投资' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '投资' }).tap();
  await expect(page.getByText('名称', { exact: true })).toBeVisible({ timeout: 15_000 });
}

// 自选行 600519 → 014 详情 → 底栏「预警」→ 屏 1 个股预警列表（空态）。
async function enterAlertListScreen(page: Page) {
  await page.getByRole('button', { name: '600519' }).tap();
  await expect(page.getByRole('button', { name: '预警' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '预警' }).tap();
  await expect(page.getByText('暂无预警，点击下方「添加预警」')).toBeVisible({ timeout: 15_000 });
}

// 屏 1 →「添加预警」→ 屏 2 编辑（0 条件 → 完成 disabled）。
async function openNewAlertEditor(page: Page) {
  await page.getByRole('button', { name: '添加预警' }).tap();
  await expect(page.getByText('预警条件')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '完成' })).toBeDisabled();
}

test('024 alert-realtime — 建「5 分钟涨超 3%」全流 + 卡片摘要回显 + POST 契约对齐（US2）', async ({
  page,
}) => {
  await installMarketMocks(page);
  const alert = await installAlertMock(page);
  await bootToPortfolio(page);
  await enterAlertListScreen(page);
  await openNewAlertEditor(page);

  // 屏 2 →「添加附加条件」→ 屏 3（默认价格分类）→ 「5分钟涨超」入 sheet → 自绘键盘录 3（%）→ 确定。
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await expect(page.getByRole('button', { name: '添加5分钟涨超', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: '添加5分钟涨超', exact: true }).tap();
  await keypadType(page, '3');
  await keypadConfirm(page);
  await expect(page.getByText('预警条件')).toBeVisible({ timeout: 10_000 });

  // 完成 → 回屏 1：卡片摘要 formatConditionLine 回显「5分钟涨超 3.00%」（恒 2dp / % 紧贴）。
  await page.getByRole('button', { name: '完成' }).tap();
  await expect(page.getByText('5分钟涨超 3.00%')).toBeVisible({ timeout: 10_000 });

  // POST 契约：单预警单条件，type=PRICE_RISE_5MIN_OVER + threshold=3（percent 阈值 only，无 param）。
  const payloads = alert.createPayloads();
  expect(payloads).toHaveLength(1);
  expect(payloads[0]['conditions']).toEqual([{ type: 'PRICE_RISE_5MIN_OVER', threshold: 3 }]);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/create-5min-flow.png`, fullPage: true });
});

test('024 alert-realtime — 5min 类 percent 阈值门控（出域 disable「选好了」，FR-M02）', async ({
  page,
}) => {
  await installMarketMocks(page);
  await installAlertMock(page);
  await bootToPortfolio(page);
  await enterAlertListScreen(page);
  await openNewAlertEditor(page);

  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await page.getByRole('button', { name: '添加5分钟跌超', exact: true }).tap();

  // percent 值域 (0,100]，自绘键盘录入 + 键盘「确定」门控（5min 类为 threshold kind）。
  // 101 出域 → 确定 disabled。
  await keypadType(page, '101');
  await expect(page.getByRole('button', { name: '确定' })).toBeDisabled();
  // 0 出域（下界开区间）→ 仍 disabled。
  await keypadBackspace(page, 3);
  await keypadType(page, '0');
  await expect(page.getByRole('button', { name: '确定' })).toBeDisabled();
  // 5 合法 → 恢复可点。
  await keypadBackspace(page, 1);
  await keypadType(page, '5');
  await expect(page.getByRole('button', { name: '确定' })).toBeEnabled();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/percent-gating.png`, fullPage: true });
});
