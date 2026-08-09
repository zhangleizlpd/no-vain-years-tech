import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 014-stock-detail — Expo Web e2e（hermetic mock，PR2 §V 第一层 UI 交互验证）。
//
// US3 报价 header：图表 Tab 首屏渲染 EOD 字段 + 涨跌色 + asOf「数据截至 X · 收盘」(D10) + 缺字段 '--'。
// US4 图表 K线：纯 SVG 蜡烛（断言 <svg>/<rect>）+ 周期(日/周/月/季/年)·复权(不/前/后)切换 → 重拉(断言
//   bars 请求带新 period/adjust)。
// US5 公司 Tab：理杏仁 5 卡（PE/PB/ROE/身份/公司行动）+ 分位。
// US6 固定底栏：加·删自选窄义 toggle（仅系统「自选」组，star 文案随 inWatchlist）；笔记 disabled
//   tap → 「即将上线」轻提示（预警已 021 接通 → alert.spec.ts 覆盖）；编辑分组 sheet（勾未勾组→加入、
//   取消已勾→移出，选中 ✓ 角标）+ 新建分组弹框（无色板）。
// US7 分析 Tab：研报容器 V1 占位空态。
// D9 us gate：直达 us 标的路由 → 占位「美股即将上线」(单独 test)。
//
// 下钻入口：013 自选行 onTap → push 详情（不改 013 契约）。底层主屏 stacked DOM 共存 → 断言用详情独有
// 文案 + role 收窄（per memory playwright_expo_stacked_screen_locator_collision）。
// mock 015 EP3 detail / EP4 bars / 014 watchlist-status / 013 groups·items / 003 refresh（防 authed 401
// 触发 refresh 拦截器误登出，per memory authed_business_401_triggers_refresh_interceptor）。
// 加删/勾选态等纯逻辑由 stock-detail.helpers.spec 覆盖；本层只验交互/渲染/契约对齐。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const PORTFOLIO_GLOB = '**/api/v1/portfolio/**';
const INSTRUMENTS_GLOB = '**/api/v1/marketdata/instruments/**';
const QUOTE_GLOB = '**/api/v1/marketdata/quote**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-03-stock-detail';

const SEED_ACCOUNT_ID = 'acc-e2e-014';
const SEED_REFRESH_TOKEN = 'refresh-e2e-014';
const SEED_ACCESS_TOKEN = 'access-e2e-014';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139014';

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

interface MockGroup {
  id: string;
  name: string;
  type: 'system' | 'custom';
  systemKind: 'watchlist' | 'holdings' | null;
  visible: boolean;
  order: number;
}
interface MockItem {
  id: string;
  groupId: string;
  market: string;
  code: string;
  pinned: boolean;
  order: number;
  color: string | null;
  noteRef: string | null;
}

// 行情字典（主列表行 client merge 用）；详情 EP3 自带 quote，不走此路。
const QUOTES: Record<string, { price: string; change: string; changePct: string }> = {
  'cn:600519': { price: '1688.00', change: '12.50', changePct: '0.75' },
  'us:AAPL': { price: '195.00', change: '0.00', changePct: '0.00' },
};

// /quote 返 name（013 行主名数据源）。
const QUOTE_NAMES: Record<string, string> = {
  'cn:600519': '贵州茅台',
  'us:AAPL': '苹果公司',
};

// 015 EP3 详情（贵州茅台）：valuation.pb 故意 null → 报价网格「市净率PB」渲 '--'（缺字段空态）。
const DETAIL = {
  symbol: 'cn:600519',
  name: '贵州茅台',
  type: 'stock',
  market: 'cn',
  code: '600519',
  currency: 'CNY',
  status: 'listed',
  listDate: '2001-08-27',
  delistDate: null,
  // 报价数字刻意区别于主列表 QUOTES['cn:600519']（1688.00/+0.75%），规避底层自选行 stacked DOM
  // 文本碰撞（per memory playwright_expo_stacked_screen_locator_collision）。
  quote: {
    price: '1700.00',
    change: '20.00',
    changePct: '1.20', // up → 红 + '+'
    prevClose: '1680.00',
    asOf: '2026-06-02',
    priceKind: 'eod_close',
    hasData: true,
    fiftyTwoWeekHigh: '1800.00',
    fiftyTwoWeekLow: '1400.00',
  },
  valuation: {
    date: '2026-06-02',
    peTtm: '25.50',
    peStatic: '24.00',
    peDynamic: '23.00',
    pb: null, // → 缺字段 '--'
    ps: '12.00',
    dividendYield: '1.80',
    marketCap: '2135000000000.00',
    circMarketCap: '2135000000000.00',
    pePctlY3: '0.42',
    pePctlY5: '0.55',
    pbPctlY3: '0.30',
    pbPctlY5: '0.65',
  },
  financials: {
    reportPeriod: '2026Q1',
    roe: '0.31',
    grossMargin: '0.918',
    eps: '15.50',
    bps: '180.00',
  },
  corporateActions: [],
};

// 每周期 bars 数（切周期 → 不同序列，验重拉重渲）。
const BAR_COUNTS: Record<string, number> = { day: 24, week: 16, month: 12, quarter: 8, year: 6 };

function makeBars(n: number) {
  const items = [];
  let close = 1600;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = open + (i % 2 === 0 ? 8 : -5);
    const high = Math.max(open, close) + 4;
    const low = Math.min(open, close) - 4;
    const day = String(i + 1).padStart(2, '0');
    items.push({
      tradeDate: `2026-05-${day}`,
      open: open.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: close.toFixed(2),
      prevClose: open.toFixed(2),
      volume: String(1_000_000 + i * 1000),
      amount: null,
      turnoverRate: null,
    });
  }
  return items;
}

interface DetailMock {
  barsRequests: () => { period: string; adjust: string }[];
}

// 单一 stateful portfolio mock（groups + items + 014 watchlist-status 派生）+ 015 detail/bars。
async function installDetailMock(page: Page): Promise<DetailMock> {
  const groups: MockGroup[] = [
    {
      id: 'g-watch',
      name: '自选',
      type: 'system',
      systemKind: 'watchlist',
      visible: true,
      order: 0,
    },
    { id: 'g-hold', name: '持仓', type: 'system', systemKind: 'holdings', visible: true, order: 1 },
    { id: 'g-tech', name: '科技', type: 'custom', systemKind: null, visible: true, order: 2 },
  ];
  const items: MockItem[] = [
    // 600519 初始在系统「自选」组 → inWatchlist=true（底栏「已自选」）。
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
  let seq = 0;
  const barsReq: { period: string; adjust: string }[] = [];

  const itemsOf = (gid: string) =>
    items.filter((it) => it.groupId === gid).sort((a, b) => a.order - b.order);
  const groupById = (gid: string) => groups.find((g) => g.id === gid);

  const groupListBody = () => ({
    groups: groups
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((g) => ({ ...g, itemCount: itemsOf(g.id).length })),
  });
  const itemListBody = (gid: string) => ({ items: itemsOf(gid) });

  // 014 watchlist-status：从 items 派生（窄义 inWatchlist + 所有非持仓组 memberships）。
  const statusBody = (market: string, code: string) => {
    const rows = items.filter(
      (it) =>
        it.market === market &&
        it.code === code &&
        groupById(it.groupId)?.systemKind !== 'holdings',
    );
    return {
      inWatchlist: rows.some((it) => groupById(it.groupId)?.systemKind === 'watchlist'),
      memberships: rows.map((it) => ({ groupId: it.groupId, itemId: it.id })),
    };
  };

  const fulfill = (route: Route, status: number, payload: unknown) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(payload),
    });

  await page.route(PORTFOLIO_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname.replace('/api/v1/portfolio/', '');
    const seg = path.split('/');
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;

    // ── 014 instruments/:market/:code/watchlist-status ──
    if (seg[0] === 'instruments' && seg[3] === 'watchlist-status') {
      return void (await fulfill(route, 200, statusBody(seg[1]!, seg[2]!)));
    }

    // ── watchlist-groups collection ──
    if (path === 'watchlist-groups') {
      if (method === 'GET') return void (await fulfill(route, 200, groupListBody()));
      if (method === 'POST') {
        groups.push({
          id: `g-new-${++seq}`,
          name: String(body['name'] ?? ''),
          type: 'custom',
          systemKind: null,
          visible: true,
          order: Math.max(...groups.map((g) => g.order)) + 1,
        });
        return void (await fulfill(route, 200, groupListBody()));
      }
    }

    // ── watchlist-groups/:id/items（加自选 POST）──
    if (seg[0] === 'watchlist-groups' && seg[1] && seg[2] === 'items' && method === 'POST') {
      const gid = seg[1];
      const market = String(body['market']);
      const code = String(body['code']);
      if (!items.find((it) => it.groupId === gid && it.market === market && it.code === code)) {
        items.push({
          id: `i-new-${++seq}`,
          groupId: gid,
          market,
          code,
          pinned: false,
          order: itemsOf(gid).length,
          color: null,
          noteRef: null,
        });
      }
      return void (await fulfill(route, 200, itemListBody(gid)));
    }
    if (seg[0] === 'watchlist-groups' && seg[1] && seg[2] === 'items' && method === 'GET') {
      return void (await fulfill(route, 200, itemListBody(seg[1])));
    }

    // ── watchlist-items/:id（删自选 DELETE）──
    if (seg[0] === 'watchlist-items' && seg[1] && method === 'DELETE') {
      const item = items.find((it) => it.id === seg[1]);
      const gid = item?.groupId ?? '';
      if (item) items.splice(items.indexOf(item), 1);
      return void (await fulfill(route, 200, itemListBody(gid)));
    }

    await route.fallback();
  });

  // 015 EP3 detail（/instruments/:symbol）+ EP4 bars（/instruments/:symbol/bars）。
  await page.route(INSTRUMENTS_GLOB, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const url = new URL(req.url());
    if (url.pathname.endsWith('/bars')) {
      const period = url.searchParams.get('period') ?? 'day';
      const adjust = url.searchParams.get('adjust') ?? 'none';
      barsReq.push({ period, adjust });
      return void (await fulfill(route, 200, {
        symbol: 'cn:600519',
        adjust,
        period,
        items: makeBars(BAR_COUNTS[period] ?? 12),
      }));
    }
    await fulfill(route, 200, DETAIL);
  });

  // 主列表行情（底层主屏 client merge）。
  await page.route(QUOTE_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const symbols = (new URL(route.request().url()).searchParams.get('symbols') ?? '')
      .split(',')
      .filter(Boolean);
    const list = symbols.map((symbol) => {
      const q = QUOTES[symbol];
      const name = QUOTE_NAMES[symbol] ?? null;
      return q
        ? { symbol, name, ...q, asOf: '2026-06-02', priceKind: 'eod_close', hasData: true }
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

  return { barsRequests: () => barsReq };
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

async function drillToDetail(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '投资' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '投资' }).tap();
  await expect(page.getByText('名称', { exact: true })).toBeVisible({ timeout: 15_000 });
  // 013 自选行 onTap → push 详情。
  await page.getByRole('button', { name: '600519' }).tap();
  // 详情就位锚改 role=tab「图表」：自选行主名已显 name（/quote 返 name）→ 底层行与详情屏
  // 同文「贵州茅台」（stacked DOM per memory playwright_expo_stacked_screen_locator_collision），
  // role 查询天然排除 aria-hidden 底层屏。
  await expect(page.getByRole('tab', { name: '图表' })).toBeVisible({ timeout: 15_000 });
}

test('014 stock-detail — 报价/K线切换/3-Tab/底栏自选窄义/编辑分组/新建分组（hermetic）', async ({
  page,
}) => {
  const mock = await installDetailMock(page);
  await drillToDetail(page);

  // ── US3 报价 header（图表 Tab 首屏）：现价/涨跌(+)/asOf(D10)/缺字段 '--' ──
  await expect(page.getByText('1700.00')).toBeVisible();
  await expect(page.getByText('+1.20%')).toBeVisible(); // 涨 → 带 + 号（色非唯一载体）
  await expect(page.getByText('数据截至 2026-06-02 · 收盘')).toBeVisible(); // D10
  await expect(page.getByText('--').first()).toBeVisible(); // 市净率PB null → 缺字段空态

  // ── US4 图表 K线：纯 SVG 蜡烛渲染 + 周期/复权切换重拉 ──
  // 蜡烛实体 + 量柱均为 <rect>（24 bar → ~48）；远超底栏 group 图标的 4 个 rect → 证 K线已渲。
  await expect.poll(() => page.locator('svg rect').count()).toBeGreaterThan(10);
  expect(mock.barsRequests().some((r) => r.period === 'day')).toBe(true); // 默认日K

  await page.getByRole('button', { name: '周K' }).tap();
  await expect.poll(() => mock.barsRequests().some((r) => r.period === 'week')).toBe(true); // 切周期重拉
  await page.getByRole('button', { name: '前复权' }).tap();
  await expect.poll(() => mock.barsRequests().some((r) => r.adjust === 'forward')).toBe(true); // 切复权重拉

  // ── US5 公司 Tab：理杏仁 5 卡（PE/身份）──
  await page.getByRole('tab', { name: '公司' }).tap();
  await expect(page.getByText('PE (TTM)')).toBeVisible({ timeout: 10_000 }); // 估值卡（详情独有 copy）
  await expect(page.getByText('52周高/低')).toBeVisible(); // 静态身份卡
  // 非图表 Tab → nav condensed 显 asOf（D10）。
  await expect(page.getByText('数据截至 2026-06-02 · 收盘')).toBeVisible();

  // ── US7 分析 Tab：研报容器 V1 占位 ──
  await page.getByRole('tab', { name: '分析' }).tap();
  await expect(page.getByText('研报功能即将上线')).toBeVisible({ timeout: 10_000 });

  // ── US6 底栏：加·删自选窄义 toggle（仅系统「自选」组）──
  await expect(page.getByRole('button', { name: '已自选' })).toBeVisible(); // 600519 在自选组
  await page.getByRole('button', { name: '已自选' }).tap();
  await expect(page.getByRole('button', { name: '自选' })).toBeVisible({ timeout: 10_000 }); // 删 → 「自选」
  await page.getByRole('button', { name: '自选' }).tap();
  await expect(page.getByRole('button', { name: '已自选' })).toBeVisible({ timeout: 10_000 }); // 再加 → 「已自选」

  // ── US6 笔记 disabled → 「即将上线」轻提示（预警已 021 T021 接通 → alert.spec.ts 覆盖）──
  await page.getByRole('button', { name: '笔记' }).tap();
  await expect(page.getByText('笔记功能即将上线')).toBeVisible({ timeout: 10_000 });
  await page.getByText('笔记功能即将上线').tap(); // 关提示

  // ── US6 编辑分组 sheet：勾未勾组→加入、取消已勾→移出（选中 ✓ 角标）──
  await page.getByRole('button', { name: '编辑分组' }).tap();
  await expect(page.getByRole('button', { name: '科技' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('✓')).toHaveCount(1); // 仅自选组命中（600519 在 g-watch）
  await page.getByRole('button', { name: '科技' }).tap(); // 勾未勾 → 加入
  await expect(page.getByText('✓')).toHaveCount(2, { timeout: 10_000 });
  await page.getByRole('button', { name: '科技' }).tap(); // 取消已勾 → 移出
  await expect(page.getByText('✓')).toHaveCount(1, { timeout: 10_000 });

  // ── US6 新建分组弹框（无色板）→ 建后新组现于 sheet 可勾 ──
  await page.getByRole('button', { name: '新建分组' }).tap();
  await page.getByRole('textbox', { name: '新建分组' }).fill('测试组');
  await page.getByRole('button', { name: '确定' }).tap();
  await expect(page.getByRole('button', { name: '测试组' })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: '完成' }).tap(); // 关 sheet

  await page.screenshot({ path: `${SCREENSHOT_DIR}/stock-detail-full-flow.png`, fullPage: true });
});

test('014 stock-detail — us 标的 gate 占位（D9，直达路由）', async ({ page }) => {
  await page.goto('/portfolio/us:AAPL');
  await expect(page.getByText('美股即将上线')).toBeVisible({ timeout: 90_000 });
});
