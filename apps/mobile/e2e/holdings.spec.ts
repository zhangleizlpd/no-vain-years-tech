import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 025-portfolio-holdings — Expo Web e2e（hermetic mock，PR-2 §V 第一层 UI 交互验证）。
//
// US2 持仓屏：工具栏入口（钱包 icon）→ 汇总条（总市值实时合成 + 总累计盈亏快照红绿 +
//   asOf 标注）+ 双 tab（当前持仓/已清仓）切换；三变体 = 默认行（合成市值/现价/浮动盈亏）
//   / 降级行（quotable=false → 行情列 `--` + 「无行情」角标，快照字段正常）/ 空态（headerRight
//   「＋」+ 空态「导入持仓」按钮，App 内导入复用 server EP1 multipart；本机工具仍可用）。
//   导入流（web）：点按 → filechooser setFiles → POST /holdings/import → 结果摘要 modal。
// US3 交易历史：持仓行·已清仓行点入 → 月份吸顶小标 + 买红/卖绿圆 badge 可视区分 +
//   息税等非交易事件中性（label 形态 + XD 原始名保留）+ 摘要条（持有·成本·累计盈亏）
//   + 尾「已经到底了」；空流水态。
//
// Auth seeded via addInitScript（nvy-auth zustand-persist，watchlist.spec 同款）。
// EP2/EP3 + watchlist 最小集走单一 page.route（GET-only，本 feature 无 mutation）。
// mock 003 refresh-token：防 authed 401 触发 refresh 拦截器误登出（per memory
// authed_business_401_triggers_refresh_interceptor）。
// getByRole/exact 收窄 stacked screen 双命中（per memory
// playwright_expo_stacked_screen_locator_collision）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const PORTFOLIO_GLOB = '**/api/v1/portfolio/**';
const QUOTE_GLOB = '**/api/v1/marketdata/quote**';
const ALERT_GLOB = '**/api/v1/alert/**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-07-holdings';

const SEED_ACCOUNT_ID = 'acc-e2e-025';
const SEED_REFRESH_TOKEN = 'refresh-e2e-025';
const SEED_ACCESS_TOKEN = 'access-e2e-025';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139025';

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

// ── EP2 持仓快照（默认行 + 降级行 + 已清仓行）──
// 600036（quotable）：现价 38 × 1000 股 → 市值 38,000.00；浮动盈亏 (38−32)×1000 = +6,000.00
//   (+18.75%)。600999（降级）：行情列全 `--`，快照 cumPnl −1,200 仍入总累计盈亏。
// 汇总：总市值 38,000.00（剔除降级行）/ 总累计盈亏 5,200−1,200 = +4,000.00。
const HOLDINGS_BODY = {
  asOf: '2026-06-05',
  current: [
    {
      id: '1',
      market: 'cn',
      code: '600036',
      name: '招商银行',
      qty: '1000',
      unitCost: '32.000',
      weightPct: '0.45',
      holdDays: 120,
      cumPnl: '5200',
      cumPnlPct: '0.1625',
      quotable: true,
    },
    {
      id: '2',
      market: 'cn',
      code: '600999',
      name: '退市大集',
      qty: '500',
      unitCost: '10.000',
      weightPct: '0.05',
      holdDays: null,
      cumPnl: '-1200',
      cumPnlPct: null,
      quotable: false,
    },
  ],
  closed: [
    {
      id: '9',
      market: 'cn',
      code: '000858',
      name: '五粮液',
      openDate: '2025-01-10',
      closeDate: '2025-06-20',
      buyAvg: '150.00',
      sellAvg: '170.00',
      totalPnl: '3500.5',
      totalPnlPct: '0.1333',
      fee: '56',
      indexPct: '0.05',
      vsIndexPct: '0.0833',
    },
  ],
};

const EMPTY_HOLDINGS_BODY = { asOf: null, current: [], closed: [] };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// EP1 导入摘要 mock（POST /holdings/import）：3 sheet 各入库若干、无跳过。
const IMPORT_SUMMARY = {
  asOf: '2026-06-06',
  holdings: { imported: 2, skipped: [], warnings: [] },
  closed: { imported: 1, skipped: [], warnings: [] },
  trades: { imported: 23, skipped: [], warnings: [] },
};

// ── EP3 流水（server 倒序：tradeDate desc, tradeTime desc nulls last）──
// 跨两月（2026-05 / 2026-04）驱动月份吸顶；buy/sell badge + xd 中性事件（XD 原始名保留）。
const TRADES_600036 = [
  {
    id: 't1',
    market: 'cn',
    code: '600036',
    name: '招商银行',
    category: 'buy',
    tradeDate: '2026-05-12',
    tradeTime: '09:31:02',
    qty: '500',
    price: '31.50',
    amount: '-15750',
    turnover: '15750',
    fee: '4.73',
    note: null,
  },
  {
    id: 't2',
    market: 'cn',
    code: '600036',
    name: '招商银行',
    category: 'sell',
    tradeDate: '2026-04-08',
    tradeTime: '10:15:30',
    qty: '200',
    price: '35.00',
    amount: '7000',
    turnover: '7000',
    fee: '2.10',
    note: null,
  },
  {
    id: 't3',
    market: 'cn',
    code: '600036',
    name: 'XD招商银',
    category: 'xd',
    tradeDate: '2026-04-01',
    tradeTime: null,
    qty: null,
    price: null,
    amount: '320',
    turnover: null,
    fee: null,
    note: null,
  },
];

// 015 /quote 词典（持仓屏只请求 quotable 行 cn:600036）。
const QUOTES: Record<string, { name: string; price: string; change: string; changePct: string }> = {
  'cn:600036': { name: '招商银行', price: '38.00', change: '1.20', changePct: '3.26' },
};

// EP2/EP3 + watchlist 最小集 + quote + alert unread 全 GET mock（本 feature 无 mutation）。
async function installHoldingsMock(page: Page, holdingsBody: unknown) {
  const fulfill = (route: Route, payload: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(payload),
    });

  await page.route(PORTFOLIO_GLOB, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1/portfolio/', '');

    // EP1 导入（POST multipart）→ 摘要。
    if (path === 'holdings/import') return void (await fulfill(route, IMPORT_SUMMARY));
    // EP2 持仓 + 已清仓快照。
    if (path === 'holdings') return void (await fulfill(route, holdingsBody));
    // EP3 等值 (market, code) 流水；非 600036（已清仓 000858 等）→ 空流水态。
    if (path === 'trades') {
      const code = url.searchParams.get('code');
      return void (await fulfill(route, { items: code === '600036' ? TRADES_600036 : [] }));
    }
    // 自选主屏最小集（入口宿主屏，013 范围不在本 spec 断言面）。
    if (path === 'watchlist-groups') {
      return void (await fulfill(route, {
        groups: [
          {
            id: 'g-watch',
            name: '自选',
            type: 'system',
            systemKind: 'watchlist',
            visible: true,
            order: 0,
            itemCount: 0,
          },
        ],
      }));
    }
    if (path.endsWith('/items')) return void (await fulfill(route, { items: [] }));

    await route.fallback();
  });

  await page.route(QUOTE_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const symbols = (new URL(route.request().url()).searchParams.get('symbols') ?? '')
      .split(',')
      .filter(Boolean);
    const items = symbols.map((symbol) => {
      const q = QUOTES[symbol];
      return q
        ? { symbol, ...q, asOf: '2026-06-05', priceKind: 'eod_close', hasData: true }
        : {
            symbol,
            name: null,
            price: null,
            change: null,
            changePct: null,
            asOf: null,
            priceKind: 'eod_close',
            hasData: false,
          };
    });
    await fulfill(route, { items });
  });

  // 021 unread 角标（自选主屏 useFocusEffect 拉取）→ 0 不亮。
  await page.route(ALERT_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    await fulfill(route, { unread: 0 });
  });
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

// 投资 tab → 自选主屏工具栏「持仓」入口（T014 钱包 icon）→ 持仓屏。
async function bootToHoldings(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '投资' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '投资' }).tap();
  await expect(page.getByRole('button', { name: '持仓' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '持仓' }).tap();
  await expect(page.getByRole('tab', { name: '当前持仓' })).toBeVisible({ timeout: 15_000 });
}

test('025 holdings — 入口/汇总条/默认行/降级行/双 tab/交易历史/空流水（hermetic）', async ({
  page,
}) => {
  await installHoldingsMock(page, HOLDINGS_BODY);
  await bootToHoldings(page);

  // ── US2 汇总条：总市值合成（38,000.00 = 行市值同值 → count 2）+ 总累计盈亏快照
  //    （5,200−1,200 = +4,000.00 含降级行）+ asOf 标注（MM-DD）──
  await expect(page.getByText('总市值', { exact: true })).toBeVisible();
  await expect(page.getByText('38,000.00', { exact: true })).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByText('+4,000.00', { exact: true })).toBeVisible();
  await expect(page.getByText('快照截至 06-05')).toBeVisible();

  // ── US2 默认行：浮动盈亏合成 (38−32)×1000 = +6,000.00 / +18.75%；现价 38.00 ──
  await expect(page.getByRole('button', { name: '招商银行 600036' })).toBeVisible();
  await expect(page.getByText('+6,000.00', { exact: true })).toBeVisible();
  await expect(page.getByText('+18.75%', { exact: true })).toBeVisible();
  await expect(page.getByText('仓位 45.00%')).toBeVisible();
  await expect(page.getByText('持仓 120 天')).toBeVisible();

  // ── US2 降级行：行情列 `--` + 「无行情」角标；快照字段（仓位/天数 `--`/累计盈亏）正常 ──
  await expect(page.getByRole('button', { name: '退市大集 600999' })).toBeVisible();
  await expect(page.getByText('无行情', { exact: true })).toBeVisible();
  await expect(page.getByText('持仓 -- 天')).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/holdings-current.png`, fullPage: true });

  // ── US2 切「已清仓」tab：日期区间 + 总盈亏红绿 + 战绩次级条 ──
  await page.getByRole('tab', { name: '已清仓' }).tap();
  await expect(page.getByRole('button', { name: '五粮液 000858' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText('2025-01-10 → 2025-06-20')).toBeVisible();
  await expect(page.getByText('+3,500.50', { exact: true })).toBeVisible();
  await expect(page.getByText('+13.33%', { exact: true })).toBeVisible();
  await expect(page.getByText('买入均价 150.00')).toBeVisible();
  await expect(page.getByText('卖出均价 170.00')).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/holdings-closed.png`, fullPage: true });

  // ── US3 已清仓行点入 → 空流水态（000858 无流水）──
  await page.getByRole('button', { name: '五粮液 000858' }).tap();
  await expect(page.getByText('该标的暂无交易记录')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('已经到底了')).toHaveCount(0);

  // ── US3 返回 → 当前持仓行点入 → 交易历史全量 ──
  // in-app header back（makeHeaderBackOrParent → router.back() 弹导航栈）而非 page.goBack()：
  // 浏览器历史 popstate 在嵌套 Stack 上会被 expo-router 重映射到 watchlist-groups（实测）。
  // back 按钮 a11y 名 = `<上屏标题>, back`（@react-navigation/elements 体例）。
  await page.getByRole('button', { name: '持仓, back' }).tap();
  await page.getByRole('tab', { name: '当前持仓' }).tap();
  await page.getByRole('button', { name: '招商银行 600036' }).tap();
  // nav 标题 = 名称+代码（文本节点，底层行是 aria-label 不撞）。
  await expect(page.getByText('招商银行 600036', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  // 摘要条（持有·成本·累计盈亏，与持仓屏同 key 缓存）。
  await expect(page.getByText('持有')).toBeVisible();
  // 月份吸顶小标（倒序两组）。
  await expect(page.getByText('2026-05', { exact: true })).toBeVisible();
  await expect(page.getByText('2026-04', { exact: true })).toBeVisible();
  // 买红/卖绿圆 badge（单字 exact 收窄，不撞「买入均价」）。
  await expect(page.getByText('买', { exact: true })).toBeVisible();
  await expect(page.getByText('卖', { exact: true })).toBeVisible();
  // 买行：时间 + 价×量 + 成交额 + 费用。
  await expect(page.getByText('2026-05-12 09:31:02')).toBeVisible();
  await expect(page.getByText('31.50 × 500 股')).toBeVisible();
  await expect(page.getByText('15,750.00', { exact: true })).toBeVisible();
  await expect(page.getByText('费用 4.73')).toBeVisible();
  // 息税中性事件：badge「息」+ 事件名 + XD 原始名保留 + signed 金额。
  await expect(page.getByText('息', { exact: true })).toBeVisible();
  await expect(page.getByText('除权除息', { exact: true })).toBeVisible();
  await expect(page.getByText('XD招商银 · 2026-04-01')).toBeVisible();
  await expect(page.getByText('+320.00', { exact: true })).toBeVisible();
  // 尾「已经到底了」。
  await expect(page.getByText('已经到底了')).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/trade-history.png`, fullPage: true });
});

test('025 holdings — 空态 App 内导入入口 + web 上传流（filechooser → 摘要 modal，hermetic）', async ({
  page,
}) => {
  await installHoldingsMock(page, EMPTY_HOLDINGS_BODY);
  await bootToHoldings(page);

  // 空态文案 + 汇总条不渲染（asOf null）+ App 内导入入口（headerRight「＋」+ 空态按钮）。
  await expect(page.getByText('暂无持仓数据')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('点右上角「＋」导入，或用本机同步工具')).toBeVisible();
  await expect(page.getByText('总市值', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导入持仓' })).toHaveCount(2); // headerRight ＋ + 空态按钮

  // ── 上传流：点空态「导入持仓」→ DOM input filechooser → setFiles → POST /holdings/import ──
  // 文件名带 YYYYMMDD（asOfFromFilename 提取，server mock 忽略）；web File = Blob 走 FormData。
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入持仓' }).last().tap();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: '股票账户_20260606.xlsx',
    mimeType: XLSX_MIME,
    buffer: Buffer.from('fake-xlsx-bytes'),
  });

  // 结果摘要 modal（已导入各 sheet 行数）+ 「完成」关闭。
  await expect(page.getByText('导入完成', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('已导入 2 持仓 · 1 已清仓 · 23 交易')).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/holdings-import-result.png`, fullPage: true });
  await page.getByRole('button', { name: '完成' }).tap();
  await expect(page.getByText('导入完成', { exact: true })).toHaveCount(0);

  // 已清仓空态。
  await page.getByRole('tab', { name: '已清仓' }).tap();
  await expect(page.getByText('暂无已清仓记录')).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: `${SCREENSHOT_DIR}/holdings-empty.png`, fullPage: true });
});
