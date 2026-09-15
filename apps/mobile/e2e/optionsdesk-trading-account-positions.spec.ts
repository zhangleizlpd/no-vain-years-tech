import { expect, test, type Locator, type Page, type Route } from './_support/fixtures';
import type { BrokerPositionListResponse, BrokerPositionRowResponse } from '@nvy/api-client';

import { mockJson } from './_support/api-mock';

// 083 — 期权台交易账户页 · 持仓分段 hermetic UI e2e（Playwright Expo Web）。
//
// 覆盖（逐条对应 specs/083-optionsdesk-trading-account-positions/tasks.md）：
//   T014 ① 无券商连接 ⇒「暂无交易账户」、无空仓字样（sb 1）
//        ② 从未成功同步 ⇒「尚未同步」（sb 2）
//        ③ 空 `groups` ⇒「暂无持仓」+ 同步时刻 + 未归类提示同时可见（sb 3）
//        ④ 首次请求 500 ⇒「持仓加载失败」+ 重试；服务端恢复后点重试 ⇒ 列表外壳（sb 4）
//        ⑤ `stale=true` ⇒ 陈旧条与列表外壳同时可见（sb 5 / US1-AS6）
//        ⑥ `unresolvedCount` 2 / 0 ⇒ 未归类提示可见 / 不可见（sb 10 / US1-AS5）
//        ⑦ 订单 / 报表分段仍为 081「建设中」占位
//
// ── hermetic 边界 ────────────────────────────────────────────────────────────
//   mock `/me` + refresh（App 级登录态前置）+ 本片列表端点 `GET /optionsdesk/broker-positions`；
//   其余 `/api/**` 走 `_support/fixtures` 默认 abort。
//   列表端点 handler = `(market 参数, canonical 服务端状态) → 响应` 的纯函数：canonical 状态 =
//   每市场一份响应 + `healthy` 开关。「服务端故障 → 恢复」是测试**显式施加的状态事件**
//   （相当于换一份 DB / 进程状态），🚫 按调用次数分支（per `.claude/rules/mobile-e2e-hermetic.md`）。
//
// ── Expo web e2e 坑 ──────────────────────────────────────────────────────────
//   · 深链进入时雷达 tab 屏也在 DOM ⇒ 断言一律收窄到本屏根 `optionsdesk-trading-account-screen`。
//   · 🚫 `page.goBack`（嵌套 Stack 的 popstate 被重映射到栈首屏）。
//
// 📌 fixture 全部合成（`ZQY` / `088xx` / 「示例连接」），🚫 真实账户 / 持仓数据。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
/** 只认列表端点；`(\?|$)` 排除 `/broker-positions/:id` 详情端点（T017 另装）。 */
const POSITIONS_RE = /\/api\/v1\/optionsdesk\/broker-positions(\?|$)/;

const SEED_ACCOUNT_ID = 'acc-e2e-083';
const SEED_ACCESS_TOKEN = 'access-e2e-083';
const SEED_REFRESH_TOKEN = 'refresh-e2e-083';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139083';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
};
const JSON_HEADERS = { 'access-control-allow-origin': '*' };

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
const POSITIONS = 'optionsdesk-trading-account-positions';

type Market = 'us' | 'hk';

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

// ════════════════════════════════════════════════════════════════════════════
// canonical 服务端状态（= 列表端点背后 DB 内容的镜像）
// ════════════════════════════════════════════════════════════════════════════

/** 交易所当地同步时刻串（服务端已换算，mobile 只重排 + 拼时区标签）。 */
const SYNCED_AT_LOCAL: Record<Market, string> = {
  us: '2026-09-14 09:05:12',
  hk: '2026-09-14 09:05:12',
};
/** 同步时刻行 / 陈旧条里的时间片段（`MM-DD HH:mm` + 时区标签）。 */
const SYNCED_LABEL: Record<Market, string> = {
  us: '09-14 09:05（美东）',
  hk: '09-14 09:05（香港）',
};
const SYNCED_AT_UTC: Record<Market, string> = {
  us: '2026-09-14T13:05:12.000Z',
  hk: '2026-09-14T01:05:12.000Z',
};

function stockRow(market: Market): BrokerPositionRowResponse {
  const code = market === 'us' ? 'US.ZQY' : 'HK.08801';
  return {
    id: `${market}-1`,
    market,
    brokerCode: 'futu',
    connectionLabel: '示例连接',
    kind: 'stock',
    code,
    name: market === 'us' ? 'ZQY 示例' : '示例汽车',
    option: null,
    qty: '100',
    marketValue: '1250.00',
    currentPrice: '12.50',
    averageCost: '12.00',
    unrealizedPl: '50.00',
    unrealizedPlRatio: '4.17',
    currency: market === 'us' ? 'USD' : 'HKD',
    openedAt: '2026-09-01T14:00:00.000Z',
    openedAtSource: 'derived',
    expired: false,
  };
}

/** 有连接、已同步、一组一行的列表响应；按需覆写。 */
function listResponse(
  market: Market,
  overrides: Partial<BrokerPositionListResponse> = {},
): BrokerPositionListResponse {
  const row = stockRow(market);
  return {
    hasConnection: true,
    brokerCount: 1,
    syncedAt: SYNCED_AT_UTC[market],
    syncedAtLocal: SYNCED_AT_LOCAL[market],
    stale: false,
    unresolvedCount: 0,
    groups: [
      {
        underlyingTicker: market === 'us' ? 'us:ZQY' : 'hk:08801',
        underlyingName: row.name,
        underlyingPrice: row.currentPrice,
        groupMarketValue: row.marketValue,
        groupUnrealizedPl: row.unrealizedPl,
        rows: [row],
      },
    ],
    ...overrides,
  };
}

const NO_CONNECTION: BrokerPositionListResponse = {
  hasConnection: false,
  brokerCount: 0,
  syncedAt: null,
  syncedAtLocal: null,
  stale: false,
  unresolvedCount: 0,
  groups: [],
};

interface PositionsServer {
  /** false ⇒ 列表端点 500（服务端故障）；测试显式翻转以模拟恢复。 */
  healthy: boolean;
  byMarket: Record<Market, BrokerPositionListResponse>;
}

function newServer(
  us: BrokerPositionListResponse,
  hk: BrokerPositionListResponse = NO_CONNECTION,
): PositionsServer {
  return { healthy: true, byMarket: { us, hk } };
}

/** 列表端点 mock：`(market, server) → 响应` 纯函数（非法 market ⇒ 400，同 server 校验口径）。 */
async function installPositionsMock(page: Page, server: PositionsServer): Promise<void> {
  await page.route(POSITIONS_RE, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void (await route.fulfill({ status: 204, headers: CORS }));
    }
    if (req.method() !== 'GET') return void (await route.fallback());
    if (!server.healthy) {
      return void (await route.fulfill({
        status: 500,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ status: 500, title: 'Internal Server Error' }),
      }));
    }
    const market = new URL(req.url()).searchParams.get('market');
    if (market !== 'us' && market !== 'hk') {
      return void (await route.fulfill({
        status: 400,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ status: 400, title: 'Bad Request' }),
      }));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify(server.byMarket[market]),
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 进页 / 定位 helper
// ════════════════════════════════════════════════════════════════════════════

/** 深链进交易账户页（首发吃 Metro 冷打包 ⇒ 长超时锚在本屏根节点）。默认分段 = 持仓。 */
async function gotoTradingAccount(page: Page): Promise<void> {
  await page.goto(DEEP_LINK);
  await expect(page.getByTestId(SCREEN)).toBeVisible({ timeout: 90_000 });
}

/** 持仓分段根节点（收窄到本屏根，防雷达 tab 屏 DOM 双命中）。 */
function positionsRoot(page: Page): Locator {
  return page.getByTestId(SCREEN).getByTestId(POSITIONS);
}

function inPositions(page: Page, suffix: string): Locator {
  return positionsRoot(page).getByTestId(`${POSITIONS}-${suffix}`);
}

// ════════════════════════════════════════════════════════════════════════════
// T014 —— 数据 hook + 持仓分段状态卡与列表外壳
// ════════════════════════════════════════════════════════════════════════════

test('083 T014① 无券商连接 ⇒「暂无交易账户」、无空仓字样（sb 1）', async ({ page }) => {
  await installPositionsMock(page, newServer(NO_CONNECTION));
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'no-connection')).toBeVisible({ timeout: 30_000 });
  await expect(positionsRoot(page).getByText('暂无交易账户', { exact: true })).toBeVisible();
  await expect(positionsRoot(page).getByText(/空仓|暂无持仓/)).toHaveCount(0);
});

test('083 T014② 有连接但从未成功同步 ⇒「尚未同步」（sb 2）', async ({ page }) => {
  await installPositionsMock(
    page,
    newServer(listResponse('us', { syncedAt: null, syncedAtLocal: null, groups: [] })),
  );
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'never-synced')).toBeVisible({ timeout: 30_000 });
  await expect(positionsRoot(page).getByText('尚未同步', { exact: true })).toBeVisible();
  await expect(inPositions(page, 'synced-at')).toHaveCount(0);
});

test('083 T014③ 已同步但无锚标的持仓 ⇒「暂无持仓」+ 同步时刻 + 未归类 2 条（sb 3）', async ({
  page,
}) => {
  await installPositionsMock(
    page,
    newServer(listResponse('us', { groups: [], unresolvedCount: 2 })),
  );
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'empty')).toBeVisible({ timeout: 30_000 });
  await expect(positionsRoot(page).getByText('暂无持仓', { exact: true })).toBeVisible();
  await expect(inPositions(page, 'synced-at')).toHaveText(`同步于 ${SYNCED_LABEL.us}`);
  await expect(inPositions(page, 'unresolved')).toHaveText('未归类 2 条');
});

test('083 T014④ 首次请求 500 ⇒「持仓加载失败」+ 重试；服务端恢复后点重试 ⇒ 列表外壳（sb 4）', async ({
  page,
}) => {
  const server = newServer(listResponse('us'));
  server.healthy = false;
  await installPositionsMock(page, server);
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'error')).toBeVisible({ timeout: 30_000 });
  await expect(positionsRoot(page).getByText('持仓加载失败', { exact: true })).toBeVisible();
  await expect(inPositions(page, 'list')).toHaveCount(0);

  server.healthy = true;
  await inPositions(page, 'retry').tap();

  await expect(inPositions(page, 'list')).toBeVisible({ timeout: 30_000 });
  await expect(inPositions(page, 'column-header')).toBeVisible();
  await expect(inPositions(page, 'synced-at')).toHaveText(`同步于 ${SYNCED_LABEL.us}`);
  await expect(inPositions(page, 'error')).toHaveCount(0);
});

test('083 T014⑤ stale=true ⇒ 陈旧条与列表外壳同时可见、同步时刻行被替换（sb 5 / US1-AS6）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(listResponse('us', { stale: true })));
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'list')).toBeVisible({ timeout: 30_000 });
  await expect(inPositions(page, 'stale')).toHaveText(
    `数据可能已过时 · 最近成功同步于 ${SYNCED_LABEL.us}`,
  );
  await expect(inPositions(page, 'column-header')).toBeVisible();
  await expect(inPositions(page, 'synced-at')).toHaveCount(0);
});

test('083 T014⑥ 美股 unresolvedCount=2 ⇒ 提示可见；切港股 unresolvedCount=0 ⇒ 不可见（sb 10 / US1-AS5）', async ({
  page,
}) => {
  await installPositionsMock(
    page,
    newServer(listResponse('us', { unresolvedCount: 2 }), listResponse('hk')),
  );
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'list')).toBeVisible({ timeout: 30_000 });
  await expect(inPositions(page, 'unresolved')).toHaveText('未归类 2 条');

  await page.getByTestId('optionsdesk-trading-account-market-tab-hk').tap();
  // 先锚港股响应已到（时区标签随市场变），再断言提示消失 —— 否则「加载中」也会让提示暂时不在。
  await expect(inPositions(page, 'synced-at')).toHaveText(`同步于 ${SYNCED_LABEL.hk}`, {
    timeout: 30_000,
  });
  await expect(inPositions(page, 'list')).toBeVisible();
  await expect(inPositions(page, 'unresolved')).toHaveCount(0);
});

test('083 T014⑦ 订单 / 报表分段仍为 081「建设中」占位，不渲染持仓分段', async ({ page }) => {
  await installPositionsMock(page, newServer(NO_CONNECTION));
  await gotoTradingAccount(page);
  const screen = page.getByTestId(SCREEN);

  await page.getByTestId('optionsdesk-trading-account-segment-orders').tap();
  await expect(screen.getByText('订单 · 建设中', { exact: true })).toBeVisible();
  await expect(positionsRoot(page)).toHaveCount(0);

  await page.getByTestId('optionsdesk-trading-account-segment-reports').tap();
  await expect(screen.getByText('报表 · 建设中', { exact: true })).toBeVisible();
  await expect(positionsRoot(page)).toHaveCount(0);
});
