import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';
import { keypadBackspace, keypadConfirm, keypadType } from './_support/alert-sheet';

// 026-alert-condition-ux — Expo Web e2e（hermetic mock，§V 第一层 UI 交互验证）。
// 021/023/024 已验词表/分类/建流全貌；本套专验 026 重构出的交互：自绘数字键盘（值/RSI/组合类）、
// 周期/年限多选 chip + 名额把守、组合类多选+单阈值、sheet 行情头 + 参考占位 + X 关闭。
//
// Test 1（US1 值类键盘 / FR-003/004）：开「股价涨到」sheet → 行情头 + 空态参考占位「最新价 1688.00」
//   + 0 系统键盘（无 textbox）→ 非法值（0）「确定」灰 → 合法值（1700）「确定」入草稿。
// Test 2（US2 多选周期 / FR-006/007/008）：「创N日新高」多选 60+120 →「选好了」批量入草稿 2 条；
//   名额受上限把守（先占 2 槽 → max=2 → 满额禁选 250 + helper「最多再选 N 项」）；空选「选好了」禁用。
// Test 3（US2 组合类 / FR-011）：「N日涨幅超」多选 3日+5日 + 键盘阈值 8 →「确定」→ 草稿 2 条共用阈值。
// Test 4（US3 X 关闭 / FR-013）：sheet 内录入后点右上角 X → 关闭且不写草稿（条件数不变）。
// Test 5（US2 编辑回显 / FR-009）：建「创N日新高[60,120]」→ 编辑重开 chip sheet → 60/120 预勾选 →
//   取消勾 120 →「选好了」→ reconcile 删 120 → 仅剩 60。
//
// 入口经真 014 详情屏（自选行→详情→底栏「预警」→屏 1→添加预警→屏 2→添加附加条件→屏 3）。
// alert mock 镜像 023 契约：param number(0 sentinel) / threshold string|null。mock 003 refresh 防
// authed 401 误登出（per memory authed_business_401_triggers_refresh_interceptor）。stacked screen
// 用 getByRole + exact 收窄（per memory playwright_expo_stacked_screen_locator_collision）。
// 纯逻辑（applyKey/reconcile/quota/placeholder）已 vitest 覆盖，本层只验交互/渲染/路由接通。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const PORTFOLIO_GLOB = '**/api/v1/portfolio/**';
const INSTRUMENTS_GLOB = '**/api/v1/marketdata/instruments/**';
const QUOTE_GLOB = '**/api/v1/marketdata/quote**';
const SEARCH_GLOB = '**/api/v1/marketdata/search**';
const ALERT_GLOB = '**/api/v1/alert/**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-12-alert-condition-ux';

const SEED_ACCOUNT_ID = 'acc-e2e-026';
const SEED_REFRESH_TOKEN = 'refresh-e2e-026';
const SEED_ACCESS_TOKEN = 'access-e2e-026';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139026';

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

// 行情字典（自选行主名 + 行情条 + 到价类参考占位）。600519 最新价 1688.00。
const QUOTES: Record<string, { price: string; change: string; changePct: string }> = {
  'cn:600519': { price: '1688.00', change: '12.50', changePct: '0.75' },
  'cn:000001': { price: '11.20', change: '-0.30', changePct: '-2.61' },
};
const DETAIL_NAMES: Record<string, string> = {
  'cn:600519': '贵州茅台',
  'cn:000001': '平安银行',
};

const fulfill = (route: Route, status: number, payload: unknown) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(payload),
  });

function makeDetail(symbol: string) {
  const [market, code] = symbol.split(':');
  const q = QUOTES[symbol];
  return {
    symbol,
    name: DETAIL_NAMES[symbol] ?? code,
    type: 'stock',
    market,
    code,
    currency: 'CNY',
    status: 'listed',
    listDate: '2001-08-27',
    delistDate: null,
    quote: {
      price: q?.price ?? null,
      change: q?.change ?? null,
      changePct: q?.changePct ?? null,
      prevClose: null,
      asOf: '2026-06-05',
      priceKind: 'eod_close',
      hasData: q != null,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
    },
    valuation: null,
    financials: null,
    corporateActions: [],
  };
}

function makeBars(n: number) {
  const items = [];
  let close = 1600;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = open + (i % 2 === 0 ? 8 : -5);
    const day = String(i + 1).padStart(2, '0');
    items.push({
      tradeDate: `2026-05-${day}`,
      open: open.toFixed(2),
      high: (Math.max(open, close) + 4).toFixed(2),
      low: (Math.min(open, close) - 4).toFixed(2),
      close: close.toFixed(2),
      prevClose: open.toFixed(2),
      volume: String(1_000_000 + i * 1000),
      amount: null,
      turnoverRate: null,
    });
  }
  return items;
}

// 013/014/015 只读面：自选组 600519+000001（屏 1 行情条 + 详情屏数据源）。
async function installMarketMocks(page: Page) {
  const groups = [
    {
      id: 'g-watch',
      name: '自选',
      type: 'system',
      systemKind: 'watchlist',
      visible: true,
      order: 0,
      itemCount: 2,
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
    {
      id: 'i-2',
      groupId: 'g-watch',
      market: 'cn',
      code: '000001',
      pinned: false,
      order: 1,
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
    const url = new URL(req.url());
    const tail = decodeURIComponent(url.pathname.replace('/api/v1/marketdata/instruments/', ''));
    if (tail.endsWith('/bars')) {
      const symbol = tail.replace(/\/bars$/, '');
      return void (await fulfill(route, 200, {
        symbol,
        adjust: url.searchParams.get('adjust') ?? 'none',
        period: url.searchParams.get('period') ?? 'day',
        items: makeBars(6),
      }));
    }
    await fulfill(route, 200, makeDetail(tail));
  });

  await page.route(QUOTE_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const symbols = (new URL(route.request().url()).searchParams.get('symbols') ?? '')
      .split(',')
      .filter(Boolean);
    const list = symbols.map((symbol) => {
      const q = QUOTES[symbol];
      const name = DETAIL_NAMES[symbol] ?? null;
      return q
        ? { symbol, name, ...q, asOf: '2026-06-05', priceKind: 'eod_close', hasData: true }
        : {
            symbol,
            name,
            price: null,
            change: null,
            changePct: null,
            asOf: null,
            priceKind: 'eod_close',
            hasData: false,
          };
    });
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
  patches: () => { id: string; body: Record<string, unknown> }[];
}

// alert stateful mock：EP1/EP2 读、EP3 建、EP4 改（conditions 全量替换，镜像 023 契约：
// param number(0 sentinel) + threshold Decimal string|null）。
async function installAlertMock(page: Page): Promise<AlertMock> {
  const alerts: MockAlert[] = [];
  let seq = 0;
  const createPayloads: Record<string, unknown>[] = [];
  const patches: { id: string; body: Record<string, unknown> }[] = [];

  const toConditions = (body: Record<string, unknown>): MockCondition[] =>
    (body['conditions'] as { type: string; param?: number; threshold?: number }[]).map((c) => ({
      type: c.type,
      param: c.param ?? 0,
      threshold: c.threshold != null ? String(c.threshold) : null,
    }));

  await page.route(ALERT_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname.replace('/api/v1/alert/', '');
    const seg = path.split('/');
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;

    if (seg[0] === 'instruments' && seg[3] === 'alerts' && method === 'GET') {
      return void (await fulfill(route, 200, {
        alerts: alerts.filter((a) => a.market === seg[1] && a.code === seg[2]),
      }));
    }
    if (path === 'alerts' && method === 'GET') return void (await fulfill(route, 200, { alerts }));
    if (path === 'alerts' && method === 'POST') {
      createPayloads.push(body);
      const conditions = toConditions(body);
      const created = (body['instruments'] as { market: string; code: string }[]).map((i) => ({
        id: `a-new-${++seq}`,
        market: i.market,
        code: i.code,
        conditions,
        frequency: String(body['frequency'] ?? 'DAILY'),
        note: (body['note'] as string | null) ?? null,
        enabled: true,
        createdAt: '2026-06-12T10:00:00.000Z',
      }));
      alerts.push(...created);
      return void (await fulfill(route, 200, { alerts: created }));
    }
    if (seg[0] === 'alerts' && seg[1] && method === 'PATCH') {
      const target = alerts.find((a) => a.id === seg[1]);
      if (!target) return void (await fulfill(route, 404, { code: 'ALERT_NOT_FOUND' }));
      patches.push({ id: target.id, body });
      if (Array.isArray(body['conditions'])) target.conditions = toConditions(body);
      if (typeof body['frequency'] === 'string') target.frequency = body['frequency'];
      if ('note' in body) target.note = (body['note'] as string | null) ?? null;
      if (typeof body['enabled'] === 'boolean') target.enabled = body['enabled'];
      return void (await fulfill(route, 200, target));
    }
    if (path === 'messages' && method === 'GET')
      return void (await fulfill(route, 200, { messages: [], nextCursor: null }));
    if (path === 'messages/unread-count' && method === 'GET')
      return void (await fulfill(route, 200, { unread: 0 }));

    await route.fallback();
  });

  return { createPayloads: () => createPayloads, patches: () => patches };
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

// 自选行 600519 → 014 详情 → 底栏「预警」→ 屏 1 → 添加预警 → 屏 2 编辑（0 条件）。
async function openNewAlertEditor(page: Page) {
  await page.getByRole('button', { name: '600519' }).tap();
  await expect(page.getByRole('button', { name: '预警' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '预警' }).tap();
  await expect(page.getByText('暂无预警，点击下方「添加预警」')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '添加预警' }).tap();
  await expect(page.getByText('预警条件')).toBeVisible({ timeout: 10_000 });
}

// 屏 2 →「添加附加条件」→ 屏 3 → 点条件名打开 sheet（默认价格分类，需切分类先传 category）。
async function openSheet(page: Page, name: string, category?: string) {
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  if (category) await page.getByRole('button', { name: category, exact: true }).tap();
  await page.getByRole('button', { name: `添加${name}`, exact: true }).tap();
}

test('026 alert-condition-ux — 值类自绘键盘：行情头 + 参考占位 + 非法门控 + 0 系统键盘（US1）', async ({
  page,
}) => {
  await installMarketMocks(page);
  const alert = await installAlertMock(page);
  await bootToPortfolio(page);
  await openNewAlertEditor(page);

  // 开「股价涨到」sheet：行情头（FR-012）+ 空态参考占位「最新价 1688.00」（FR-014）。
  await openSheet(page, '股价涨到');
  await expect(page.getByText('最新价 1688.00', { exact: true })).toBeVisible({ timeout: 10_000 });
  // 0 系统键盘：无 textbox（FR-003 自绘键盘只读显示）。
  await expect(page.getByRole('textbox', { name: '股价涨到', exact: true })).toHaveCount(0);
  // 空值「确定」禁用 → 非法值 0（price>0）仍禁用 → 合法值 1700 启用（FR-004）。
  await expect(page.getByRole('button', { name: '确定' })).toBeDisabled();
  await keypadType(page, '0');
  await expect(page.getByRole('button', { name: '确定' })).toBeDisabled();
  await keypadBackspace(page, 1);
  await keypadType(page, '1700');
  await expect(page.getByRole('button', { name: '确定' })).toBeEnabled();
  await keypadConfirm(page);

  // 回屏 2：条件值 chip「1700元」（conditionValueLabel）→ 完成 → 屏 1 卡片「股价涨到 1700.00 元」。
  await expect(page.getByText('1700元', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '完成' }).tap();
  await expect(page.getByText('股价涨到 1700.00 元')).toBeVisible({ timeout: 10_000 });
  expect(alert.createPayloads()).toHaveLength(1);
  const conds = alert.createPayloads()[0]!['conditions'] as { type: string; threshold: number }[];
  expect(conds).toEqual([{ type: 'PRICE_RISE_TO', threshold: 1700 }]);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/value-keypad.png`, fullPage: true });
});

test('026 alert-condition-ux — 周期多选 + 名额把守 + 空选禁用（US2 纯周期）', async ({ page }) => {
  await installMarketMocks(page);
  const alert = await installAlertMock(page);
  await bootToPortfolio(page);
  await openNewAlertEditor(page);

  // ── 空选「选好了」禁用（FR-007a）──
  await openSheet(page, '创N日新高');
  await expect(page.getByText('可多选', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '选好了' })).toBeDisabled();
  // 多选 60 + 120 →「选好了」批量入草稿 2 条（FR-006/007）。
  await page.getByRole('button', { name: '60日', exact: true }).tap();
  await page.getByRole('button', { name: '120日', exact: true }).tap();
  await expect(page.getByRole('button', { name: '选好了' })).toBeEnabled();
  await page.getByRole('button', { name: '选好了' }).tap();
  await expect(page.getByText('60日', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('120日', { exact: true })).toBeVisible();

  // 完成 → 卡片两条窗口摘要并存。
  await page.getByRole('button', { name: '完成' }).tap();
  await expect(page.getByText('创60日新高')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('创120日新高')).toBeVisible();
  const conds = alert.createPayloads()[0]!['conditions'] as { type: string; param: number }[];
  expect(conds.map((c) => c.param).sort((a, b) => a - b)).toEqual([60, 120]);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/multi-period.png`, fullPage: true });
});

test('026 alert-condition-ux — 名额上限把守：满额禁选 + 剩余名额 helper（US2 FR-008）', async ({
  page,
}) => {
  await installMarketMocks(page);
  await installAlertMock(page);
  await bootToPortfolio(page);
  await openNewAlertEditor(page);

  // 先占 2 槽（两个不同值类条件）→ 创N日新高名额 max = 4 − 2 = 2。
  await openSheet(page, '股价涨到');
  await keypadType(page, '1700');
  await keypadConfirm(page);
  await openSheet(page, '日涨幅超');
  await keypadType(page, '5');
  await keypadConfirm(page);

  // 开「创N日新高」：constrained（max 2 < 白名单 3）→ helper「最多再选 2 项」。
  await openSheet(page, '创N日新高');
  await expect(page.getByText('最多再选 2 项')).toBeVisible({ timeout: 10_000 });
  // 选 60 + 120 → 满额 → 250日 禁选 + helper「最多再选 0 项」。
  await page.getByRole('button', { name: '60日', exact: true }).tap();
  await page.getByRole('button', { name: '120日', exact: true }).tap();
  await expect(page.getByText('最多再选 0 项')).toBeVisible();
  await expect(page.getByRole('button', { name: '250日', exact: true })).toBeDisabled();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/quota-guard.png`, fullPage: true });
});

test('026 alert-condition-ux — 组合类多选年限/周期 + 单阈值键盘「确定」批量（US2 FR-011）', async ({
  page,
}) => {
  await installMarketMocks(page);
  const alert = await installAlertMock(page);
  await bootToPortfolio(page);
  await openNewAlertEditor(page);

  // 「N日涨幅超」：多选 3日 + 5日 + 键盘阈值 8 →「确定」→ reconcile([3,5],'8')。
  await openSheet(page, 'N日涨幅超');
  await page.getByRole('button', { name: '3日', exact: true }).tap();
  await page.getByRole('button', { name: '5日', exact: true }).tap();
  // 一个不勾或阈值非法时「确定」禁用；先验阈值空 → 禁用。
  await expect(page.getByRole('button', { name: '确定' })).toBeDisabled();
  await keypadType(page, '8');
  await expect(page.getByRole('button', { name: '确定' })).toBeEnabled();
  await keypadConfirm(page);

  await page.getByRole('button', { name: '完成' }).tap();
  await expect(page.getByText('3日涨幅超 8.00%')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('5日涨幅超 8.00%')).toBeVisible();
  const conds = alert.createPayloads()[0]!['conditions'] as {
    type: string;
    param: number;
    threshold: number;
  }[];
  expect(
    conds
      .map((c) => ({ param: c.param, threshold: c.threshold }))
      .sort((a, b) => a.param - b.param),
  ).toEqual([
    { param: 3, threshold: 8 },
    { param: 5, threshold: 8 },
  ]);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/combo-keypad.png`, fullPage: true });
});

test('026 alert-condition-ux — X 关闭不写草稿（US3 FR-013）', async ({ page }) => {
  await installMarketMocks(page);
  await installAlertMock(page);
  await bootToPortfolio(page);
  await openNewAlertEditor(page);

  // 开 sheet 录入但点右上角 X 关闭 → 不写草稿。X 关闭后停在屏 3（add-condition），sheet 关。
  await openSheet(page, '股价涨到');
  await keypadType(page, '1700');
  await page.getByRole('button', { name: '关闭' }).tap();
  // 回屏 3：搜条件框可见（sheet 已关）+ 「股价涨到」行仍「添加」非「已添加」（草稿未写）。
  await expect(page.getByRole('textbox', { name: '搜条件', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText('已添加', { exact: true })).toHaveCount(0);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/close-no-write.png`, fullPage: true });
});

test('026 alert-condition-ux — 编辑重开预勾选 + 取消勾选移除（US2 FR-009）', async ({ page }) => {
  await installMarketMocks(page);
  const alert = await installAlertMock(page);
  await bootToPortfolio(page);
  await openNewAlertEditor(page);

  // 建「创N日新高[60,120]」→ 完成。
  await openSheet(page, '创N日新高');
  await page.getByRole('button', { name: '60日', exact: true }).tap();
  await page.getByRole('button', { name: '120日', exact: true }).tap();
  await page.getByRole('button', { name: '选好了' }).tap();
  await page.getByRole('button', { name: '完成' }).tap();
  await expect(page.getByText('创60日新高')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('创120日新高')).toBeVisible();

  // 编辑：屏 1 卡片 → 编辑预警 → 屏 2 → 点条件值 chip「60日」重开 chip sheet。
  await page.getByRole('button', { name: '编辑预警' }).tap();
  await expect(page.getByText('预警条件')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '创N日新高参数' }).first().tap();
  // 预勾选回显：60/120 选中态（accessibilityState selected → 取消勾 120）。
  await page.getByRole('button', { name: '120日', exact: true }).tap();
  await page.getByRole('button', { name: '选好了' }).tap();

  // reconcile 删 120 → 仅剩 60；完成 → EP4 patch 仅 param 60。
  await expect(page.getByText('120日', { exact: true })).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('button', { name: '完成' }).tap();
  await expect(page.getByText('创60日新高')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('创120日新高')).toHaveCount(0);
  await expect.poll(() => alert.patches().length).toBeGreaterThan(0);
  const lastPatch = alert.patches().at(-1)!.body['conditions'] as { param: number }[];
  expect(lastPatch.map((c) => c.param)).toEqual([60]);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/edit-prefill-remove.png`, fullPage: true });
});
