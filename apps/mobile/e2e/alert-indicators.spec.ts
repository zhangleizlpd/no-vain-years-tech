import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';
import { keypadBackspace, keypadConfirm, keypadType } from './_support/alert-sheet';

// 023-alert-eod-indicators PR-3 §V 第一层 UI 交互验证（Playwright hermetic mock）。
// 021 alert.spec.ts 验既有 4 type 全流；本套验 023 扩出的 32 词表 / 4 分类 / 参数变体族。
//
// Test 1（SC-006「逐条可达」/ FR-M01）：屏 3 添加条件页 4 分类 rail 逐切，断言每分类条件行
//   齐全（硬编码 oracle，不 re-derive 自被测的 alert-copy meta 表——meta 分类错配能被抓）
//   + 无参条件语义副标题文案。
// Test 2（FR-M01/M02 建带参全流 + 卡片摘要含参回显）：每 kind 各配置成功一条——
//   纯阈值 PE 低于(B1) / MA20 上穿(B2) / 创250日新高(B3) / 5日涨幅超(B4) / PE 分位低于·5年(B5)
//   / RSI 超卖(B6) / 无参 MACD 金叉直加。MAX_CONDITIONS=4 → 拆 2 个预警（4+3）。
// Test 3（FR-M04 搜索 / FR-M02 RSI 出域 / FR-S07 同键拦+异 param 共存）：跨分类搜「率」命中
//   估值+成交量 / RSI 出域红字 + 选好了 disabled / 同 (type,param) 覆盖不新增 + MA5+MA20 共存。
//
// 入口经真 014 详情屏（自选行→详情→底栏「预警」→屏 1→添加预警→屏 2→添加附加条件→屏 3），
// 无参 none kind（MACD/KDJ/BOLL）点添加**直接入草稿返回**（不弹 sheet，FR-M01）。
// alert mock 单一 stateful page.route：EP3 POST 镜像 023 契约——param number(0 sentinel)/
// threshold string|null（无阈值类型 null）。mock 003 refresh 防 authed 401 误登出（per memory
// authed_business_401_triggers_refresh_interceptor）。stacked screen 用 getByRole + exact 收窄
// （per memory playwright_expo_stacked_screen_locator_collision）。纯逻辑（草稿键/校验/格式化）
// 已 vitest 覆盖，本层只验交互/渲染/路由接通。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const PORTFOLIO_GLOB = '**/api/v1/portfolio/**';
const INSTRUMENTS_GLOB = '**/api/v1/marketdata/instruments/**';
const QUOTE_GLOB = '**/api/v1/marketdata/quote**';
const SEARCH_GLOB = '**/api/v1/marketdata/search**';
const ALERT_GLOB = '**/api/v1/alert/**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-08-alert-indicators';

const SEED_ACCOUNT_ID = 'acc-e2e-023';
const SEED_REFRESH_TOKEN = 'refresh-e2e-023';
const SEED_ACCESS_TOKEN = 'access-e2e-023';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139023';

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

// 行情字典（自选行主名 + 行情条）。600519 昨收 1675.50（1688−12.50），主板 ±10%。
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
}

// alert stateful mock：EP1/EP2 读、EP3 建。POST 镜像 023 契约：条件 param number(0 sentinel)
// + threshold Decimal string|null（无阈值类型 null）——卡片摘要 formatConditionLine 据此回显参数。
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
        createdAt: '2026-06-08T10:00:00.000Z',
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

interface SheetCondition {
  /** 非 price 分类需先点 rail（price 为默认 tab，省略）。 */
  category?: string;
  /** 条件中文名（= 添加按钮 '添加'+name、sheet 标题、阈值框 a11y label）。 */
  name: string;
  /** chip 文案（ma/window/daysPct/pctile）。 */
  chip?: string;
  /** 阈值输入（threshold/rsi/daysPct/pctile）；省略 = 用 sheet 预填（RSI 默认）。 */
  threshold?: string;
}

// 屏 2 →「添加附加条件」→ 屏 3 → [分类] → 添加name → sheet(chip 多选/键盘阈值) → 提交 → 回屏 2。
// 026 提交分流：纯周期（ma/window，有 chip 无 threshold）→「选好了」；阈值/RSI/组合类 → 键盘「确定」。
async function addViaSheet(page: Page, c: SheetCondition) {
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  if (c.category) await page.getByRole('button', { name: c.category, exact: true }).tap();
  await page.getByRole('button', { name: `添加${c.name}`, exact: true }).tap();
  if (c.chip) await page.getByRole('button', { name: c.chip, exact: true }).tap();
  const usePeriodDone = c.chip !== undefined && c.threshold === undefined;
  if (c.threshold !== undefined) await keypadType(page, c.threshold);
  if (usePeriodDone) await page.getByRole('button', { name: '选好了' }).tap();
  else await keypadConfirm(page);
}

// 无参条件（none kind）：点添加直接入草稿返回屏 2（不弹 sheet，FR-M01）。
async function addNoParam(page: Page, c: { category?: string; name: string }) {
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  if (c.category) await page.getByRole('button', { name: c.category, exact: true }).tap();
  await page.getByRole('button', { name: `添加${c.name}`, exact: true }).tap();
  await expect(page.getByText('预警条件')).toBeVisible({ timeout: 10_000 });
}

// ── 硬编码 oracle（4 分类条件名 + 无参副标题；与被测 alert-copy meta 表独立，分类错配可被抓）──
const PRICE_NAMES = [
  '股价涨到',
  '股价跌到',
  '日涨幅超',
  '日跌幅超',
  '股价上穿均线',
  '股价跌破均线',
  '创N日新高',
  '创N日新低',
  'N日涨幅超',
  'N日跌幅超',
];
const VALUATION_NAMES = [
  'PE 高于',
  'PE 低于',
  'PB 高于',
  'PB 低于',
  '股息率高于',
  '股息率低于',
  'PE 分位高于',
  'PE 分位低于',
  'PB 分位高于',
  'PB 分位低于',
];
const VOLUME_NAMES = ['换手率超', '量比超'];
const TECHNICAL_NAMES = [
  'MACD 金叉',
  'MACD 死叉',
  'KDJ 金叉',
  'KDJ 死叉',
  'KDJ 超买',
  'KDJ 超卖',
  'RSI 超买',
  'RSI 超卖',
  'BOLL 突破上轨',
  'BOLL 跌破下轨',
];
// 无参语义副标题（mockup A2；NEW_HIGH/NEW_LOW/PERIOD/RSI 无 sub）。
const PRICE_SUBS = ['收盘价上穿所选均线时提醒（盘后判定）', '收盘价跌破所选均线时提醒（盘后判定）'];
const TECHNICAL_SUBS = [
  'DIF 上穿 DEA',
  'DIF 下穿 DEA',
  'K 上穿 D',
  'K 下穿 D',
  'J > 100',
  'J < 10',
  '收盘价上穿布林上轨',
  '收盘价下穿布林下轨',
];

async function expectRows(page: Page, names: string[]) {
  for (const n of names)
    await expect(page.getByRole('button', { name: `添加${n}`, exact: true })).toBeVisible({
      timeout: 10_000,
    });
}

test('023 alert-indicators — 4 分类 rail 逐切全行渲染 + 无参副标题（SC-006 逐条可达）', async ({
  page,
}) => {
  await installMarketMocks(page);
  await installAlertMock(page);
  await bootToPortfolio(page);
  await enterAlertListScreen(page);
  await openNewAlertEditor(page);
  await page.getByRole('button', { name: '添加附加条件' }).tap();

  // 默认分类 = 价格跟踪：10 行 + MA 上穿/跌破副标题。
  await expect(page.getByRole('textbox', { name: '搜条件', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expectRows(page, PRICE_NAMES);
  for (const s of PRICE_SUBS) await expect(page.getByText(s, { exact: true })).toBeVisible();

  // 估值：10 行。
  await page.getByRole('button', { name: '估值', exact: true }).tap();
  await expectRows(page, VALUATION_NAMES);

  // 成交量：2 行。
  await page.getByRole('button', { name: '成交量', exact: true }).tap();
  await expectRows(page, VOLUME_NAMES);

  // 技术指标：10 行 + 8 条无参穿越/状态副标题。
  await page.getByRole('button', { name: '技术指标', exact: true }).tap();
  await expectRows(page, TECHNICAL_NAMES);
  for (const s of TECHNICAL_SUBS) await expect(page.getByText(s, { exact: true })).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/categories.png`, fullPage: true });
});

test('023 alert-indicators — 每 kind 配置成功一条 + 卡片摘要含参回显（建带参全流）', async ({
  page,
}) => {
  await installMarketMocks(page);
  const alert = await installAlertMock(page);
  await bootToPortfolio(page);
  await enterAlertListScreen(page);

  // ── 预警 A（4 条，覆盖 threshold/ma/window/none）──
  await openNewAlertEditor(page);
  await addViaSheet(page, { category: '估值', name: 'PE 低于', threshold: '15' }); // B1 纯阈值
  await addViaSheet(page, { name: '股价上穿均线', chip: 'MA20' }); // B2 MA 周期（无阈值）
  await addViaSheet(page, { name: '创N日新高', chip: '250日' }); // B3 窗口（无阈值）
  await addNoParam(page, { category: '技术指标', name: 'MACD 金叉' }); // 无参直加
  await page.getByRole('button', { name: '完成' }).tap();

  // 回屏 1：卡片摘要含参回显（formatConditionLine 模板）。
  await expect(page.getByText('PE 低于 15.00 倍')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('股价上穿 MA20')).toBeVisible();
  await expect(page.getByText('创250日新高')).toBeVisible();
  await expect(page.getByText('MACD 金叉')).toBeVisible();
  expect(alert.createPayloads()).toHaveLength(1);

  // ── 预警 B（3 条，覆盖 daysPct/pctile/rsi）──
  await openNewAlertEditor(page);
  await addViaSheet(page, { name: 'N日涨幅超', chip: '5日', threshold: '8' }); // B4 天数+阈值
  await addViaSheet(page, { category: '估值', name: 'PE 分位低于', chip: '5年', threshold: '20' }); // B5 分位
  await addViaSheet(page, { category: '技术指标', name: 'RSI 超卖' }); // B6 RSI 预填 30
  await page.getByRole('button', { name: '完成' }).tap();

  await expect(page.getByText('5日涨幅超 8.00%')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('PE 分位低于 20.00%（5年）')).toBeVisible();
  await expect(page.getByText('RSI 超卖(30.00)')).toBeVisible();
  expect(alert.createPayloads()).toHaveLength(2);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/create-flow.png`, fullPage: true });
});

test('023 alert-indicators — 跨分类搜索 / RSI 出域红字拒 / 同键拦 + MA5+MA20 共存', async ({
  page,
}) => {
  await installMarketMocks(page);
  await installAlertMock(page);
  await bootToPortfolio(page);
  await enterAlertListScreen(page);
  await openNewAlertEditor(page);

  // ── 跨分类搜「率」（FR-M04）：命中估值（股息率）+ 成交量（换手率），rail 隐藏 ──
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await page.getByRole('textbox', { name: '搜条件', exact: true }).fill('率');
  await expect(page.getByRole('button', { name: '添加股息率高于', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('button', { name: '添加股息率低于', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加换手率超', exact: true })).toBeVisible();
  // 从搜索结果直接入一条（换手率超 threshold kind，自绘键盘 + 确定），自然返屏 2。
  await page.getByRole('button', { name: '添加换手率超', exact: true }).tap();
  await keypadType(page, '15');
  await keypadConfirm(page);
  await expect(page.getByText('预警条件')).toBeVisible({ timeout: 10_000 });

  // ── RSI 出域红字（FR-M02）：默认预填 30 → 改 150 出域 → 红字 + 确定 disabled；改 25 → 恢复 ──
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await page.getByRole('button', { name: '技术指标', exact: true }).tap();
  await page.getByRole('button', { name: '添加RSI 超卖', exact: true }).tap();
  await keypadBackspace(page, 2);
  await keypadType(page, '150');
  await expect(page.getByText('请输入 0-100 之间的数值')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '确定' })).toBeDisabled();
  await keypadBackspace(page, 3);
  await keypadType(page, '25');
  await expect(page.getByText('请输入 0-100 之间的数值')).toHaveCount(0);
  await keypadConfirm(page);
  await expect(page.getByText('预警条件')).toBeVisible({ timeout: 10_000 });

  // ── 多选异 param 共存（FR-S07，026 多选）：一次勾 MA20 + MA5 →「选好了」→ 两行 ──
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await page.getByRole('button', { name: '添加股价上穿均线', exact: true }).tap();
  await page.getByRole('button', { name: 'MA20', exact: true }).tap();
  await page.getByRole('button', { name: 'MA5', exact: true }).tap();
  await page.getByRole('button', { name: '选好了' }).tap();
  await expect(page.getByText('股价上穿均线', { exact: true })).toHaveCount(2);
  await expect(page.getByText('MA5', { exact: true })).toHaveCount(1);
  await expect(page.getByText('MA20', { exact: true })).toHaveCount(1);
  // 注：草稿已满 4（换手率 + RSI + MA20 + MA5）。重开预勾选幂等性由 026 编辑回显 e2e
  // （alert-condition-ux.spec.ts Test 5）+ reconcileConditions vitest 幂等用例覆盖，此处不再重入。

  // ── 完成 → 卡片两条 MA 摘要并存 ──
  await page.getByRole('button', { name: '完成' }).tap();
  await expect(page.getByText('股价上穿 MA20')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('股价上穿 MA5')).toBeVisible();
  await expect(page.getByText('换手率超 15.00%')).toBeVisible();
  await expect(page.getByText('RSI 超卖(25.00)')).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/search-rsi-dedup.png`, fullPage: true });
});
