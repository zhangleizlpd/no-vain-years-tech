import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';
import { keypadBackspace, keypadConfirm, keypadType } from './_support/alert-sheet';

// 021-alert-management — Expo Web e2e（hermetic mock，PR-3 §V 第一层 UI 交互验证）。
//
// Test 1（US1/US5，014 详情铃铛入口）：建预警全流（详情 bell→屏1→屏2→屏3→数值 sheet→完成）
//   + 同类型重复拦（已添加→再选覆盖参数不新增行）+ 频率 sheet 三档默认每日1次 + 备注 n/22
//   + 多选删（未勾 disabled→勾→删→空态）+ 行情条涨跌停纯函数接线（昨收×板别幅度）。
// Test 2（US4/US5，013 工具栏铃铛入口）：全部预警分组（组头名+组内卡片）+ 下钻屏 1 + 就地
//   toggle（EP4 PATCH enabled）+ 对象选择：自选 tab 多选/全选/去添加→批量 EP3（2 标的）、
//   搜索 tab 015 /search 直进单只 EP3。
// Test 3（US3/US6）：工具栏三 icon（放大镜=既有添加入口 / 铃→全部预警 / 信封+unread 红点）
//   + 消息中心（提醒 tab 默认 / 待办 disabled / 正文快照渲染）+ 进入即 EP8 mark-read（D6）
//   → 返回角标清零（focus refetch EP7）。
//
// alert 8 端点走单一 stateful page.route（mutation 改内存集 + 失效重拉，镜像 server 契约）；
// 015 detail/quote/search + 013 groups/items + 014 watchlist-status 只读 mock（建预警入口
// 要经真 014 详情屏）。mock 003 refresh-token 防 authed 401 误登出（per memory
// authed_business_401_triggers_refresh_interceptor）。getByRole 收窄 stacked screen（per
// memory playwright_expo_stacked_screen_locator_collision；屏 2 批量灰字与屏 4 底部灰字仅差
// 「（N）」后缀 → exact 区分）。纯逻辑（草稿/校验/格式化/涨跌停/乐观 patch）已 vitest 覆盖，
// 本层只验交互/渲染/路由接通。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const PORTFOLIO_GLOB = '**/api/v1/portfolio/**';
const INSTRUMENTS_GLOB = '**/api/v1/marketdata/instruments/**';
const QUOTE_GLOB = '**/api/v1/marketdata/quote**';
const SEARCH_GLOB = '**/api/v1/marketdata/search**';
const ALERT_GLOB = '**/api/v1/alert/**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-07-alert';

const SEED_ACCOUNT_ID = 'acc-e2e-021';
const SEED_REFRESH_TOKEN = 'refresh-e2e-021';
const SEED_ACCESS_TOKEN = 'access-e2e-021';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139021';

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

// 行情字典（行 merge + 屏 1/2 行情条 + 屏 5 组头）。600519 昨收 1688−12.50=1675.50，
// 主板 ±10% → 涨停 1843.05（验涨跌停纯函数接线）。
const QUOTES: Record<string, { price: string; change: string; changePct: string }> = {
  'cn:600519': { price: '1688.00', change: '12.50', changePct: '0.75' },
  'cn:000001': { price: '11.20', change: '-0.30', changePct: '-2.61' },
  'cn:000858': { price: '128.00', change: '1.00', changePct: '0.79' },
};

// 015 detail 名称（屏 1/2/3 行情条 + 屏 5 组头共用；600519 兼供 014 详情屏渲染）。
const DETAIL_NAMES: Record<string, string> = {
  'cn:600519': '贵州茅台',
  'cn:000001': '平安银行',
  'cn:000858': '五粮液',
};

// 015 /search 候选（搜索 tab；非 cn 由屏内过滤，无需植入）。
const SEARCH_ITEMS = [
  { symbol: 'cn:000858', name: '五粮液', type: 'stock' },
  { symbol: 'cn:600519', name: '贵州茅台', type: 'stock' },
];

const fulfill = (route: Route, status: number, payload: unknown) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(payload),
  });

/** 精简 detail（quote-header 字段 null-safe → '--'；alert 屏只取 name）。 */
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

// 013/014/015 只读面：自选组 600519+000001（屏 4 自选 tab 数据源；watchlist-status 派生）。
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

  // 015 detail + bars（014 详情屏 + alert 行情条/组头名）。
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

  // 015 /quote 批量。
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

  // 015 /search（屏 4 搜索 tab）。
  await page.route(SEARCH_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    await fulfill(route, 200, { items: q ? SEARCH_ITEMS : [] });
  });
}

interface MockAlert {
  id: string;
  market: string;
  code: string;
  conditions: { type: string; threshold: string }[];
  frequency: string;
  note: string | null;
  enabled: boolean;
  createdAt: string;
}
interface MockMessage {
  id: string;
  market: string;
  code: string;
  instrumentName: string;
  tradeDate: string;
  conditions: { type: string; threshold: string; actual: string }[];
  note: string | null;
  triggeredAt: string;
  unread: boolean;
}

interface AlertMock {
  createPayloads: () => Record<string, unknown>[];
  patches: () => { id: string; body: Record<string, unknown> }[];
  deletePayloads: () => Record<string, unknown>[];
  markReadCount: () => number;
}

// alert 8 端点单一 stateful mock：alerts/messages 在内存，mutation 改集合（EP3 入参
// threshold number → 存 Decimal string，镜像 server 契约），unread 走标志位水位线。
async function installAlertMock(
  page: Page,
  seed: { alerts?: MockAlert[]; messages?: MockMessage[] } = {},
): Promise<AlertMock> {
  const alerts: MockAlert[] = seed.alerts ?? [];
  const messages: MockMessage[] = seed.messages ?? [];
  let seq = 0;
  const createPayloads: Record<string, unknown>[] = [];
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const deletePayloads: Record<string, unknown>[] = [];
  let markReads = 0;

  await page.route(ALERT_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname.replace('/api/v1/alert/', '');
    const seg = path.split('/');
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;

    // ── EP1 instruments/:market/:code/alerts ──
    if (seg[0] === 'instruments' && seg[3] === 'alerts' && method === 'GET') {
      return void (await fulfill(route, 200, {
        alerts: alerts.filter((a) => a.market === seg[1] && a.code === seg[2]),
      }));
    }

    // ── EP2 GET / EP3 POST alerts ──
    if (path === 'alerts') {
      if (method === 'GET') return void (await fulfill(route, 200, { alerts }));
      if (method === 'POST') {
        createPayloads.push(body);
        const conditions = (body['conditions'] as { type: string; threshold: number }[]).map(
          (c) => ({ type: c.type, threshold: String(c.threshold) }),
        );
        const created = (body['instruments'] as { market: string; code: string }[]).map((i) => ({
          id: `a-new-${++seq}`,
          market: i.market,
          code: i.code,
          conditions,
          frequency: String(body['frequency'] ?? 'DAILY'),
          note: (body['note'] as string | null) ?? null,
          enabled: true,
          createdAt: '2026-06-06T10:00:00.000Z',
        }));
        alerts.push(...created);
        return void (await fulfill(route, 200, { alerts: created }));
      }
    }

    // ── EP5 alerts/delete-batch ──
    if (path === 'alerts/delete-batch' && method === 'POST') {
      deletePayloads.push(body);
      const ids = new Set((body['ids'] as string[]) ?? []);
      let deleted = 0;
      for (let i = alerts.length - 1; i >= 0; i--) {
        if (ids.has(alerts[i]!.id)) {
          alerts.splice(i, 1);
          deleted += 1;
        }
      }
      return void (await fulfill(route, 200, { deleted }));
    }

    // ── EP4 alerts/:id PATCH（conditions 全量替换 + frequency/note/enabled）──
    if (seg[0] === 'alerts' && seg[1] && method === 'PATCH') {
      const target = alerts.find((a) => a.id === seg[1]);
      if (!target) return void (await fulfill(route, 404, { code: 'ALERT_NOT_FOUND' }));
      patches.push({ id: target.id, body });
      if (Array.isArray(body['conditions'])) {
        target.conditions = (body['conditions'] as { type: string; threshold: number }[]).map(
          (c) => ({ type: c.type, threshold: String(c.threshold) }),
        );
      }
      if (typeof body['frequency'] === 'string') target.frequency = body['frequency'];
      if ('note' in body) target.note = (body['note'] as string | null) ?? null;
      if (typeof body['enabled'] === 'boolean') target.enabled = body['enabled'];
      return void (await fulfill(route, 200, target));
    }

    // ── EP6/EP7/EP8 messages ──
    if (path === 'messages' && method === 'GET') {
      return void (await fulfill(route, 200, { messages, nextCursor: null }));
    }
    if (path === 'messages/unread-count' && method === 'GET') {
      return void (await fulfill(route, 200, { unread: messages.filter((m) => m.unread).length }));
    }
    if (path === 'messages/mark-read' && method === 'POST') {
      markReads += 1;
      for (const m of messages) m.unread = false;
      return void (await fulfill(route, 200, { unread: 0 }));
    }

    await route.fallback();
  });

  return {
    createPayloads: () => createPayloads,
    patches: () => patches,
    deletePayloads: () => deletePayloads,
    markReadCount: () => markReads,
  };
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

test('021 alert — 建预警全流/同类型覆盖/频率默认/多选删（hermetic，014 详情铃铛入口）', async ({
  page,
}) => {
  await installMarketMocks(page);
  const alert = await installAlertMock(page);
  await bootToPortfolio(page);

  // ── 入口：013 自选行 → 014 详情 → 底栏「预警」直进屏 1（T021 接通）──
  await page.getByRole('button', { name: '600519' }).tap();
  // 详情就位锚改底栏「预警」role：自选行主名已显 name（/quote 返 name）→ 底层行与详情屏
  // 同文「贵州茅台」（stacked DOM per memory playwright_expo_stacked_screen_locator_collision），
  // role 查询天然排除 aria-hidden 底层屏。
  await expect(page.getByRole('button', { name: '预警' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '预警' }).tap();
  await expect(page.getByText('暂无预警，点击下方「添加预警」')).toBeVisible({ timeout: 15_000 });

  // ── 屏 1 行情条 5 字段 + 涨跌停接线（昨收 1675.50 × 主板 ±10% → 1843.05）──
  await expect(page.getByText('最新价', { exact: true })).toBeVisible();
  await expect(page.getByText('1843.05')).toBeVisible();
  // 空列表 → 选择删除 disabled。
  await expect(page.getByRole('button', { name: '选择删除' })).toBeDisabled();

  // ── 屏 2 新建：0 条件不可提交 + 频率默认每日1次（FR-M02）──
  await page.getByRole('button', { name: '添加预警' }).tap();
  await expect(page.getByRole('button', { name: '完成' })).toBeDisabled({ timeout: 10_000 });
  await expect(page.getByText('每日1次', { exact: true })).toBeVisible();

  // ── 屏 3 添加条件 → 数值 sheet → 回屏 2 入列 ──
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await expect(page.getByText('价格跟踪')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '添加股价跌到' }).tap();
  await keypadType(page, '13');
  await keypadConfirm(page);
  await expect(page.getByText('13元')).toBeVisible({ timeout: 10_000 });

  // ── 同类型重复拦（FR-M03）：再进屏 3 →「已添加」→ sheet 预填现值（自绘键盘只读显示回显 13）→ 覆盖不新增 ──
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await expect(page.getByText('已添加')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '添加股价跌到' }).tap();
  await expect(page.getByLabel('股价跌到 13', { exact: true })).toBeVisible({ timeout: 10_000 });
  await keypadBackspace(page, 2);
  await keypadType(page, '12.5');
  await keypadConfirm(page);
  await expect(page.getByText('12.5元')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel('股价跌到参数')).toHaveCount(1);

  // ── 第二条件（AND）：日跌幅超 7 ──
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await page.getByRole('button', { name: '添加日跌幅超' }).tap();
  await keypadType(page, '7');
  await keypadConfirm(page);
  await expect(page.getByText('7%', { exact: true })).toBeVisible({ timeout: 10_000 });

  // ── 频率 sheet：三档可见 + 默认每日1次选中 → 换「仅1次·关闭」──
  await page.getByRole('button', { name: '提醒频率' }).tap();
  await expect(page.getByRole('radio', { name: '每日1次' })).toBeVisible({ timeout: 10_000 });
  // RNW 不把 accessibilityState.selected 映射成 aria-selected → 用选中行独有 ✓ icon（SVG）断言默认档。
  await expect(page.getByRole('radio', { name: '每日1次' }).locator('svg')).toHaveCount(1);
  await expect(page.getByRole('radio', { name: '仅提醒1次（提醒后删除预警）' })).toBeVisible();
  await expect(
    page.getByRole('radio', { name: '仅提醒1次（提醒后删除预警）' }).locator('svg'),
  ).toHaveCount(0);
  await page.getByRole('radio', { name: '仅提醒1次（提醒后关闭预警）' }).tap();
  // sheet 完成与 header 完成同名 → RNW Modal=role dialog 作用域收窄。
  await page.getByRole('dialog').getByRole('button', { name: '完成' }).tap();
  // 收窄到频率行（sheet 关闭动画期间 radio 同文案仍短暂在 DOM）。
  await expect(page.getByRole('button', { name: '提醒频率' })).toContainText(
    '仅提醒1次（提醒后关闭预警）',
    { timeout: 10_000 },
  );

  // ── 备注 n/22（D10 同口径计数）──
  await page.getByRole('textbox', { name: '备注' }).fill('到价提醒');
  await expect(page.getByText('4/22')).toBeVisible();

  // ── 完成提交（EP3）→ 回屏 1：卡片条件多行 + 频率短称 + 备注 ──
  // 等 sheet 关闭动画出 DOM（dialog 残留会让同名「完成」双命中）。
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('button', { name: '完成' }).tap();
  await expect(page.getByText('股价跌到 12.50 元')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('日跌幅超 7.00%')).toBeVisible();
  await expect(page.getByText('仅1次·关闭')).toBeVisible();
  await expect(page.getByText('到价提醒')).toBeVisible();
  expect(alert.createPayloads()).toHaveLength(1);

  // ── 屏 1b 多选删（FR-M05）：未勾 disabled → 勾选 → 删除直删 → 空态 ──
  await page.getByRole('button', { name: '选择删除' }).tap();
  await expect(page.getByRole('button', { name: '删除' })).toBeDisabled({ timeout: 10_000 });
  await page.getByRole('checkbox', { name: '选择预警' }).tap();
  await expect(page.getByRole('button', { name: '删除' })).toBeEnabled();
  await page.getByRole('button', { name: '删除' }).tap();
  await expect(page.getByText('暂无预警，点击下方「添加预警」')).toBeVisible({ timeout: 10_000 });
  expect(alert.deletePayloads()).toHaveLength(1);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/alert-create-flow.png`, fullPage: true });
});

test('021 alert — 全部预警分组/下钻/就地 toggle/对象选择批量+搜索直进（hermetic，工具栏铃铛入口）', async ({
  page,
}) => {
  await installMarketMocks(page);
  const alert = await installAlertMock(page, {
    alerts: [
      {
        id: 'a-1',
        market: 'cn',
        code: '600519',
        conditions: [{ type: 'PRICE_RISE_TO', threshold: '1800.00' }],
        frequency: 'DAILY',
        note: null,
        enabled: true,
        createdAt: '2026-06-05T10:00:00.000Z',
      },
      {
        id: 'a-2',
        market: 'cn',
        code: '000001',
        conditions: [{ type: 'DAILY_LOSS_OVER', threshold: '5.00' }],
        frequency: 'ONCE_DELETE',
        note: '关注回撤',
        enabled: true,
        createdAt: '2026-06-05T10:00:00.000Z',
      },
    ],
  });
  await bootToPortfolio(page);

  // ── 入口：013 工具栏铃铛 → 屏 5（T021 接通）──
  await page.getByRole('button', { name: '全部预警' }).tap();
  await expect(page.getByRole('tab', { name: 'A股' })).toBeVisible({ timeout: 15_000 });

  // ── 分组（FR-M04）：组头名（014 detail）+ 组内卡片（条件/频率短称/备注||未备注）──
  await expect(page.getByRole('button', { name: '贵州茅台' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '平安银行' })).toBeVisible();
  await expect(page.getByText('股价涨到 1800.00 元')).toBeVisible();
  await expect(page.getByText('日跌幅超 5.00%')).toBeVisible();
  await expect(page.getByText('未备注')).toBeVisible();
  await expect(page.getByText('关注回撤')).toBeVisible();

  // ── 就地 toggle（EP4 PATCH enabled，乐观更新）──
  const firstToggle = page.getByRole('switch', { name: '启停预警' }).first();
  await expect(firstToggle).toBeChecked();
  await firstToggle.tap();
  await expect
    .poll(() => alert.patches().some((p) => p.id === 'a-1' && p.body['enabled'] === false))
    .toBe(true);
  await expect(firstToggle).not.toBeChecked();

  // ── 组头 chevron 下钻屏 1（独有底栏「添加预警」+ 行情条）→ 返回 ──
  await page.getByRole('button', { name: '贵州茅台' }).tap();
  await expect(page.getByRole('button', { name: '添加预警' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('最新价', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: '新建预警' })).toBeVisible({ timeout: 10_000 });

  // ── 屏 4 对象选择（FR-M09）：自选 tab 多选 + 全选 + 去添加（未勾 disabled）──
  await page.getByRole('button', { name: '新建预警' }).tap();
  await expect(page.getByRole('tab', { name: '搜索' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('将为选中的每只股票分别创建预警', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '选择标的 600519' })).toBeVisible();
  await expect(page.getByRole('button', { name: '去添加' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '全选' }).tap();
  await page.getByRole('button', { name: '去添加' }).tap();

  // ── 屏 2 批量态：灰字带 N（与屏 4 底部灰字差「（2）」后缀 → exact 区分）→ EP3 批量 ──
  await expect(page.getByText('将为选中的每只股票分别创建预警（2）')).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await page.getByRole('button', { name: '添加股价跌到' }).tap();
  await keypadType(page, '9');
  await keypadConfirm(page);
  await page.getByRole('button', { name: '完成' }).tap();
  await expect.poll(() => alert.createPayloads().length).toBe(1);
  const batch = alert.createPayloads()[0]!['instruments'] as { code: string }[];
  expect(batch.map((i) => i.code).sort()).toEqual(['000001', '600519']);

  // ── 搜索 tab（D11 同源 /search）：结果行「添加」单只直进屏 2 → EP3 单标的 ──
  await page.getByRole('tab', { name: '搜索' }).tap();
  await page.getByRole('textbox', { name: '搜索股票' }).fill('五粮');
  await expect(page.getByRole('button', { name: '添加 五粮液' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '添加 五粮液' }).tap();
  await expect(page.getByText('最新价', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '添加附加条件' }).tap();
  await page.getByRole('button', { name: '添加日涨幅超' }).tap();
  await keypadType(page, '5');
  await keypadConfirm(page);
  await page.getByRole('button', { name: '完成' }).tap();
  await expect.poll(() => alert.createPayloads().length).toBe(2);
  const single = alert.createPayloads()[1]!['instruments'] as { code: string }[];
  expect(single.map((i) => i.code)).toEqual(['000858']);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/alert-all-alerts-flow.png`, fullPage: true });
});

test('021 alert — 工具栏三 icon/消息中心未读→清零/待办 disabled（hermetic）', async ({ page }) => {
  await installMarketMocks(page);
  const alert = await installAlertMock(page, {
    messages: [
      {
        id: 'm-2',
        market: 'cn',
        code: '603305',
        instrumentName: '旭升集团',
        tradeDate: '2026-06-05',
        conditions: [
          { type: 'PRICE_FALL_TO', threshold: '13.00', actual: '12.80' },
          { type: 'DAILY_LOSS_OVER', threshold: '7.00', actual: '-7.43' },
        ],
        note: null,
        triggeredAt: '2026-06-05T15:05:00+08:00',
        unread: true,
      },
      {
        id: 'm-1',
        market: 'cn',
        code: '600519',
        instrumentName: '贵州茅台',
        tradeDate: '2026-06-04',
        conditions: [{ type: 'PRICE_RISE_TO', threshold: '1700.00', actual: '1712.00' }],
        note: '到价提醒',
        triggeredAt: '2026-06-04T15:05:00+08:00',
        unread: false,
      },
    ],
  });
  await bootToPortfolio(page);

  // ── 工具栏三 icon（T021）：信封未读红点（EP7>0）+ 放大镜=既有添加入口 ──
  await expect(page.getByTestId('alert-unread-badge')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '添加自选' }).tap();
  await expect(page.getByRole('textbox', { name: '添加自选' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '关闭' }).tap();

  // ── 信封 → 屏 6：提醒 tab 默认 + 待办 disabled + 正文快照渲染（FR-M06）──
  await page.getByRole('button', { name: '消息通知' }).tap();
  await expect(page.getByRole('tab', { name: '提醒' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('tab', { name: '待办' })).toBeDisabled();
  await expect(page.getByText('预警触发')).toHaveCount(2);
  await expect(
    page.getByText(
      '旭升集团(603305) 触发预警：股价跌到 13.00 元（今日最低 12.80 元）；日跌幅超 7.00%（今日 -7.43%）。',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('贵州茅台(600519) 触发预警：股价涨到 1700.00 元（今日最高 1712.00 元）。'),
  ).toBeVisible();
  // 进入即置已读（plan D6 屏级水位线）。
  await expect.poll(() => alert.markReadCount()).toBeGreaterThan(0);

  // ── 返回 → 角标清零（FR-M07：focus refetch EP7=0）──
  await page.goBack();
  await expect(page.getByText('名称', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('alert-unread-badge')).toHaveCount(0);

  // ── 铃铛 → 屏 5（本测试无预警 → 空态文案）──
  await page.getByRole('button', { name: '全部预警' }).tap();
  await expect(page.getByText('暂无预警，点击下方「新建预警」')).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: `${SCREENSHOT_DIR}/alert-message-center.png`, fullPage: true });
});
