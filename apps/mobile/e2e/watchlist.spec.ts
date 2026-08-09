import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 013-watchlist — Expo Web e2e（hermetic mock，PR2 §V 第一层 UI 交互验证）。
//
// US3 主列表：列头（名称｜最新｜涨幅｜涨跌）+ 行行情 client merge（015 /quote）涨红跌绿 +
//   +/- 符号辅助（FR-M09 色非唯一载体）。
// US3 分组 Tab：横滑切组（getByRole('tab')）+ 隐藏组不上 Tab。
// US4 长按菜单：长按行 → 6 项菜单（删除/固顶/移到最前/移到最后/分组·颜色/笔记）；持仓组标的
//   「删除」disabled（FR-M04）；固顶 → 行挂「顶」badge。
// US5 分组管理：☰ → 全部分组屏 → 新建分组（拖拽序为 Pan 手势，headless web 非确定 → 见下注）。
// US6 添加入口：＋ → 搜索（mock 015 /search）→ 选中 → 加入自选 → 新条入列。
//
// Auth seeded via addInitScript（nvy-auth zustand-persist，同 stock-market-access.spec）。
// portfolio CRUD + 015 quote/search 走单一 stateful page.route（mutation 返全量集，镜像 server
// 「写后返当前集」契约，hook reconcile 覆盖 cache）。
// mock 003 refresh-token：防 authed 401 触发 refresh 拦截器误登出（per memory
// authed_business_401_triggers_refresh_interceptor）。
// getByRole 收窄 stacked screen（per memory playwright_expo_stacked_screen_locator_collision）。
//
// ⚠️ 拖拽排序（DraggableList Pan）与 broker SwipeRow 同属 reanimated/Pan 手势，在 headless
// Playwright web 下 pointer 序列非确定（per broker-account-binding.spec 决策）→ e2e 不驱真拖拽；
// reorder 折算纯函数已由 group-management.helpers.spec.ts 覆盖。长按为定时器型手势（无位移）→
// 用 mouse 按住 > minDuration 驱动，确定性足够。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const PORTFOLIO_GLOB = '**/api/v1/portfolio/**';
const QUOTE_GLOB = '**/api/v1/marketdata/quote**';
const SEARCH_GLOB = '**/api/v1/marketdata/search**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-03-watchlist';

const SEED_ACCOUNT_ID = 'acc-e2e-013';
const SEED_REFRESH_TOKEN = 'refresh-e2e-013';
const SEED_ACCESS_TOKEN = 'access-e2e-013';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139013';

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

// EOD 行情字典（symbol → quote）。一升(红)一跌(绿)一平，验涨跌色 + +/- 符号（FR-M09）。
const QUOTES: Record<string, { price: string; change: string; changePct: string }> = {
  'cn:600519': { price: '1688.00', change: '12.50', changePct: '0.75' }, // up → 红 / +
  'cn:000001': { price: '11.20', change: '-0.30', changePct: '-2.61' }, // down → 绿 / -
  'us:AAPL': { price: '195.00', change: '0.00', changePct: '0.00' }, // flat
  'cn:600036': { price: '38.00', change: '1.20', changePct: '3.20' }, // holdings 行
};

// /quote 返 name（行主名数据源）；000858 无报价但 instrument 已注册 → 仍有 name。
const QUOTE_NAMES: Record<string, string> = {
  'cn:600519': '贵州茅台',
  'cn:000001': '平安银行',
  'us:AAPL': '苹果公司',
  'cn:600036': '招商银行',
  'cn:000858': '五粮液',
};

// 搜索词典（q 非空 → 候选）。000858 不在 watchlist → 加入后可断言新条入列。
const SEARCH_ITEMS = [
  { symbol: 'cn:000858', name: '五粮液', type: 'stock' },
  { symbol: 'cn:600519', name: '贵州茅台', type: 'stock' },
];

interface WatchlistMock {
  putCount: () => number;
}

// 单一 stateful portfolio mock：groups + items 全在内存，mutation 返全量集（镜像 server 契约）。
async function installWatchlistMock(page: Page): Promise<WatchlistMock> {
  const groups: MockGroup[] = [
    {
      id: 'g-watch',
      name: '自选',
      type: 'system',
      systemKind: 'watchlist',
      visible: true,
      order: 0,
    },
    {
      id: 'g-hold',
      name: '我的持仓',
      type: 'system',
      systemKind: 'holdings',
      visible: true,
      order: 1,
    },
    { id: 'g-tech', name: '科技', type: 'custom', systemKind: null, visible: true, order: 2 },
    { id: 'g-hidden', name: '隐藏组', type: 'custom', systemKind: null, visible: false, order: 3 },
  ];
  const items: MockItem[] = [
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
    // 持仓组 V1 服务端实空；此处植 1 条仅为驱动「持仓删除 disabled」UI 断言（hermetic 测渲染逻辑）。
    {
      id: 'i-h',
      groupId: 'g-hold',
      market: 'cn',
      code: '600036',
      pinned: false,
      order: 0,
      color: null,
      noteRef: null,
    },
    {
      id: 'i-3',
      groupId: 'g-tech',
      market: 'us',
      code: 'AAPL',
      pinned: false,
      order: 0,
      color: null,
      noteRef: null,
    },
  ];
  let seq = 0;
  let writeCount = 0;

  const itemsOf = (gid: string) =>
    items
      .filter((it) => it.groupId === gid)
      .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.order - b.order));

  const groupListBody = () => ({
    groups: groups
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((g) => ({ ...g, itemCount: itemsOf(g.id).length })),
  });
  const itemListBody = (gid: string) => ({ items: itemsOf(gid) });

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
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const path = new URL(req.url()).pathname.replace('/api/v1/portfolio/', '');
    const seg = path.split('/'); // watchlist-groups[/<id>[/items]] | watchlist-items/<id>
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    if (method !== 'GET') writeCount += 1;

    // ── watchlist-groups collection ──
    if (path === 'watchlist-groups') {
      if (method === 'GET') return void (await fulfill(route, 200, groupListBody()));
      if (method === 'POST') {
        const id = `g-new-${++seq}`;
        groups.push({
          id,
          name: String(body['name'] ?? ''),
          type: 'custom',
          systemKind: null,
          visible: true,
          order: Math.max(...groups.map((g) => g.order)) + 1,
        });
        return void (await fulfill(route, 200, groupListBody()));
      }
      if (method === 'PATCH') {
        // reorder（拖拽序 + 隐藏切换）：批量 order + visible。
        const ordered = (body['ordered'] ?? []) as {
          groupId: string;
          order: number;
          visible: boolean;
        }[];
        for (const o of ordered) {
          const g = groups.find((x) => x.id === o.groupId);
          if (g) {
            g.order = o.order;
            g.visible = o.visible;
          }
        }
        return void (await fulfill(route, 200, groupListBody()));
      }
    }

    // ── watchlist-groups/:id(/items) ──
    if (seg[0] === 'watchlist-groups' && seg[1]) {
      const gid = seg[1];
      if (seg[2] === 'items') {
        if (method === 'GET') return void (await fulfill(route, 200, itemListBody(gid)));
        if (method === 'POST') {
          const market = String(body['market']);
          const code = String(body['code']);
          const existing = items.find(
            (it) => it.groupId === gid && it.market === market && it.code === code,
          );
          if (!existing) {
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
      }
      if (method === 'PATCH') {
        const g = groups.find((x) => x.id === gid);
        if (g) g.name = String(body['name'] ?? g.name);
        return void (await fulfill(route, 200, groupListBody()));
      }
      if (method === 'DELETE') {
        const idx = groups.findIndex((x) => x.id === gid);
        if (idx >= 0) groups.splice(idx, 1);
        for (let i = items.length - 1; i >= 0; i--)
          if (items[i]!.groupId === gid) items.splice(i, 1);
        return void (await fulfill(route, 200, groupListBody()));
      }
    }

    // ── watchlist-items/:id ──
    if (seg[0] === 'watchlist-items' && seg[1]) {
      const item = items.find((it) => it.id === seg[1]);
      const gid = item?.groupId ?? '';
      if (item && method === 'PATCH') {
        if (typeof body['pinned'] === 'boolean') item.pinned = body['pinned'] as boolean;
        if ('color' in body) item.color = body['color'] ? String(body['color']) : null;
        if ('noteRef' in body) item.noteRef = body['noteRef'] ? String(body['noteRef']) : null;
        if (body['move'] === 'front')
          item.order = Math.min(...itemsOf(gid).map((i) => i.order)) - 1;
        if (body['move'] === 'back') item.order = Math.max(...itemsOf(gid).map((i) => i.order)) + 1;
        if (body['targetGroupId']) item.groupId = String(body['targetGroupId']);
        return void (await fulfill(route, 200, itemListBody(gid)));
      }
      if (item && method === 'DELETE') {
        items.splice(items.indexOf(item), 1);
        return void (await fulfill(route, 200, itemListBody(gid)));
      }
    }

    await route.fallback();
  });

  // 015 /quote：按入参 symbols 顺序回报价（无数据 → hasData:false 占位）。
  await page.route(QUOTE_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const symbols = (new URL(route.request().url()).searchParams.get('symbols') ?? '')
      .split(',')
      .filter(Boolean);
    const list = symbols.map((symbol) => {
      const q = QUOTES[symbol];
      return q
        ? {
            symbol,
            name: QUOTE_NAMES[symbol] ?? null,
            price: q.price,
            change: q.change,
            changePct: q.changePct,
            asOf: '2026-06-02',
            priceKind: 'eod_close',
            hasData: true,
          }
        : {
            symbol,
            name: QUOTE_NAMES[symbol] ?? null,
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

  // 015 /search：q 非空 → 候选。
  await page.route(SEARCH_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    await fulfill(route, 200, { items: q ? SEARCH_ITEMS : [] });
  });

  return { putCount: () => writeCount };
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

// 长按手势：mouse 按住 > minDuration(420ms) 驱动 RNGH LongPress（定时器型，无位移 → 确定）。
async function longPress(page: Page, target: Locator, holdMs = 700) {
  const box = await target.boundingBox();
  if (!box) throw new Error('long-press target has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

async function bootToPortfolio(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '投资' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '投资' }).tap();
  await expect(page.getByText('名称', { exact: true })).toBeVisible({ timeout: 15_000 });
}

test('013 watchlist — 主列表/涨跌色/Tab 切组/长按菜单/固顶/分组管理/添加入口（hermetic）', async ({
  page,
}) => {
  await installWatchlistMock(page);
  await bootToPortfolio(page);

  // ── US3 列头 + 行情 merge + +/- 符号（FR-M02/M03/M09 色非唯一载体）──
  for (const col of ['名称', '最新', '涨幅', '涨跌']) {
    await expect(page.getByText(col, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: '600519' })).toBeVisible();
  await expect(page.getByText('+0.75%')).toBeVisible(); // 涨 → 带 + 号
  await expect(page.getByText('-2.61%')).toBeVisible(); // 跌 → 带 - 号

  // ── US3 分组 Tab（role=tab）+ 隐藏组不上 Tab ──
  await expect(page.getByRole('tab', { name: '自选' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '我的持仓' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '科技' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '隐藏组' })).toHaveCount(0);

  // 切「科技」组 → 列表换 AAPL。
  await page.getByRole('tab', { name: '科技' }).tap();
  await expect(page.getByRole('button', { name: 'AAPL' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('tab', { name: '自选' }).tap();
  await expect(page.getByRole('button', { name: '600519' })).toBeVisible();

  // ── US4 长按行 → 6 项菜单（role+label 可达）──
  await longPress(page, page.getByRole('button', { name: '600519' }));
  for (const action of ['删除', '固顶', '移到最前', '移到最后', '分组·颜色', '笔记']) {
    await expect(page.getByRole('button', { name: action })).toBeVisible({ timeout: 10_000 });
  }
  await expect(page.getByRole('button', { name: '删除' })).toBeEnabled(); // 自选项删除可用

  // 固顶 → 菜单关 + 行挂「顶」badge。
  await page.getByRole('button', { name: '固顶' }).tap();
  await expect(page.getByText('顶', { exact: true })).toBeVisible({ timeout: 10_000 });

  // ── US4 持仓组标的「删除」disabled（FR-M04）──
  await page.getByRole('tab', { name: '我的持仓' }).tap();
  await expect(page.getByRole('button', { name: '600036' })).toBeVisible({ timeout: 10_000 });
  await longPress(page, page.getByRole('button', { name: '600036' }));
  await expect(page.getByRole('button', { name: '删除' })).toBeDisabled({ timeout: 10_000 });
  // 关菜单（点 scrim）回主列表。
  await page.getByLabel('关闭').tap();

  // ── US5 分组管理：☰ → 全部分组 → 新建分组 ──
  await page.getByRole('tab', { name: '自选' }).tap();
  await page.getByRole('button', { name: '管理分组' }).tap();
  await expect(page).toHaveURL(/\/portfolio\/watchlist-groups$/, { timeout: 10_000 });
  // 建组前自定义组（科技 + 隐藏组）各有 ⋯（更多操作）→ 2 个；系统组无。
  await expect(page.getByRole('button', { name: '更多操作' })).toHaveCount(2);
  await page.getByRole('button', { name: '新建分组' }).tap();
  await page.getByRole('textbox', { name: '新建分组' }).fill('我的策略');
  await page.getByRole('button', { name: '完成' }).tap();
  // 新组行文本与底层主屏 Tab pill 同名（stacked screen DOM 共存, per memory
  // playwright_expo_stacked_screen_locator_collision）→ 不 getByText；改断言管理屏独有的
  // ⋯ 数 +1（主屏 Tab 无此控件）证新自定义组行已渲染。
  await expect(page.getByRole('button', { name: '更多操作' })).toHaveCount(3, { timeout: 10_000 });

  // ── US6 添加入口：＋ → 搜索（mock 015）→ 选中 → 加入自选 → 新条入列 ──
  await page.goBack();
  await expect(page.getByText('名称', { exact: true })).toBeVisible({ timeout: 10_000 });
  // 新组传播为主列表 Tab（FR-M06 拖拽/建组序 → Tab 顺序）；管理屏已 pop，无同名碰撞。
  await expect(page.getByRole('tab', { name: '我的策略' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '添加自选' }).tap();
  await page.getByRole('textbox', { name: '添加自选' }).fill('五粮液');
  await expect(page.getByText('五粮液', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '五粮液' }).tap();
  await page.getByRole('button', { name: '加入自选' }).tap();
  await expect(page.getByRole('button', { name: '000858' })).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: `${SCREENSHOT_DIR}/watchlist-full-flow.png`, fullPage: true });
});
