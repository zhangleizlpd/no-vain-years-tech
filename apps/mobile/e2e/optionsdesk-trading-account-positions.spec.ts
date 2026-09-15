import { expect, test, type Locator, type Page, type Route } from './_support/fixtures';
import type {
  BrokerPositionGroupResponse,
  BrokerPositionListResponse,
  BrokerPositionRowResponse,
  RadarResponse,
} from '@nvy/api-client';

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
//   T015 ① 3 行组 ⇒ 组头「ZQY 示例(3)」、组市值 / 组盈亏万缩写、组头现价 = 正股行现价（sb 12 / US1-AS1）
//        ② 单行组 ⇒ 无组头直接出行（sb 11 / US1-AS2）
//        ③ 点组头折叠 / 再点展开；折叠后返回雷达再进入 ⇒ 全部展开（sb 13 / US1-AS7）
//          ③b「折叠后进持仓详情再返回 ⇒ 仍折叠」依赖持仓详情路由 ⇒ `test.fixme`，T017 落路由后解除
//        ④ 港股空头认沽 ⇒「示例汽车 沽」、第二行 `261029 7.25`、数量与市值为负（sb 22 / US1-AS3）
//        ⑤ `expired=true` 行 ⇒「已到期 · 待同步」可见（sb 23 / US1-AS9）
//        ⑥ `brokerCount=1` ⇒ 无连接标签；`=2` 且同合约两行 ⇒ 各显示自己的连接名称（sb 20, 21）
//        ⑦ 行 `marketValue='37560'` ⇒ 主列表显示 `3.76万`（FR-022）
//   T016 ① 下拉重读 ⇒ 列表端点命中 +1、同步时刻更新、无非本片端点请求（sb 14 下拉面 / US1-AS8）
//        ② 切后台再回前台（`visibilitychange`）⇒ 列表端点命中 +1（sb 14 回前台面）
//        ③ 列表已显示、重读 500 ⇒ 行仍可见 + 刷新失败提示；恢复后重读 ⇒ 提示消失（sb 43 / US1-AS10）
//        ④ 聚焦面不在此验（「进雷达再返回」是重新挂载，测不出聚焦）⇒ 由 T017⑩ 进持仓详情再返回验
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

// ════════════════════════════════════════════════════════════════════════════
// T015 —— 分组列表：组头 / 折叠 / 行 / 万缩写 / 已到期标 / 连接标签
// ════════════════════════════════════════════════════════════════════════════

/** 美股「ZQY 示例」3 行组：正股 + 已到期认沽 + 认购（组内顺序 = 服务端已排好的顺序）。 */
const ZQY_STOCK: BrokerPositionRowResponse = {
  ...stockRow('us'),
  id: 'us-zqy-stock',
  qty: '5000',
  marketValue: '241000.00',
  currentPrice: '48.20',
  averageCost: '46.10',
  unrealizedPl: '10500.00',
  unrealizedPlRatio: '4.56',
};
const ZQY_PUT_EXPIRED: BrokerPositionRowResponse = {
  ...stockRow('us'),
  id: 'us-zqy-put',
  kind: 'option',
  code: 'US.ZQY260911P45000',
  option: { expiry: '2026-09-11', right: 'P', strike: '45.000' },
  qty: '-1',
  marketValue: '-1.00',
  currentPrice: '0.01',
  averageCost: '1.35',
  unrealizedPl: '134.00',
  unrealizedPlRatio: '99.26',
  expired: true,
};
const ZQY_CALL: BrokerPositionRowResponse = {
  ...stockRow('us'),
  id: 'us-zqy-call',
  kind: 'option',
  code: 'US.ZQY261016C55000',
  option: { expiry: '2026-10-16', right: 'C', strike: '55.000' },
  qty: '-2',
  marketValue: '-170.00',
  currentPrice: '0.85',
  averageCost: '1.20',
  unrealizedPl: '70.00',
  unrealizedPlRatio: '29.17',
};
const ZQY_ROW_IDS = [ZQY_STOCK.id, ZQY_PUT_EXPIRED.id, ZQY_CALL.id] as const;

const ZQY_GROUP: BrokerPositionGroupResponse = {
  underlyingTicker: 'us:ZQY',
  underlyingName: 'ZQY 示例',
  underlyingPrice: '48.20',
  groupMarketValue: '240829.00',
  groupUnrealizedPl: '10704.00',
  rows: [ZQY_STOCK, ZQY_PUT_EXPIRED, ZQY_CALL],
};

/** 美股「ZQR 示例 Call」单行组（市值 37560 ⇒ `3.76万`）。 */
const ZQR_CALL: BrokerPositionRowResponse = {
  ...stockRow('us'),
  id: 'us-zqr-call',
  kind: 'option',
  code: 'US.ZQR261120C30000',
  name: 'ZQR 示例',
  option: { expiry: '2026-11-20', right: 'C', strike: '30.000' },
  qty: '1',
  marketValue: '37560',
  currentPrice: '2.10',
  averageCost: '2.60',
  unrealizedPl: '-50.00',
  unrealizedPlRatio: '-19.23',
};
const ZQR_GROUP: BrokerPositionGroupResponse = {
  underlyingTicker: 'us:ZQR',
  underlyingName: 'ZQR 示例',
  underlyingPrice: '30.50',
  groupMarketValue: '37560',
  groupUnrealizedPl: '-50.00',
  rows: [ZQR_CALL],
};

const US_GROUPED = listResponse('us', { groups: [ZQY_GROUP, ZQR_GROUP] });

/** 港股「示例汽车 沽」空头认沽单行组。 */
const HK_SHORT_PUT_ROW: BrokerPositionRowResponse = {
  ...stockRow('hk'),
  id: 'hk-08801-put',
  kind: 'option',
  code: 'HK.08801261029P7250',
  option: { expiry: '2026-10-29', right: 'P', strike: '7.250' },
  qty: '-3',
  marketValue: '-1740.00',
  currentPrice: '0.116',
  averageCost: '0.096',
  unrealizedPl: '-300.00',
  unrealizedPlRatio: '-20.83',
};
const HK_SHORT_PUT = listResponse('hk', {
  groups: [
    {
      underlyingTicker: 'hk:08801',
      underlyingName: '示例汽车',
      underlyingPrice: '7.920',
      groupMarketValue: '-1740.00',
      groupUnrealizedPl: '-300.00',
      rows: [HK_SHORT_PUT_ROW],
    },
  ],
});

/** 两个券商连接同时持有同一合约 ⇒ 两行，各带自己的连接名称。 */
const TWO_CONNECTIONS = listResponse('us', {
  brokerCount: 2,
  groups: [
    {
      ...ZQR_GROUP,
      groupMarketValue: '75120',
      groupUnrealizedPl: '-100.00',
      rows: [
        { ...ZQR_CALL, id: 'us-zqr-call-a', connectionLabel: '示例连接 A' },
        { ...ZQR_CALL, id: 'us-zqr-call-b', connectionLabel: '示例连接 B' },
      ],
    },
  ],
});

function groupHeader(page: Page, ticker: string): Locator {
  return inPositions(page, `group-${ticker}`);
}

function groupPart(page: Page, ticker: string, part: string): Locator {
  return inPositions(page, `group-${ticker}-${part}`);
}

function positionRow(page: Page, id: string): Locator {
  return inPositions(page, `row-${id}`);
}

function rowPart(page: Page, id: string, part: string): Locator {
  return inPositions(page, `row-${id}-${part}`);
}

const RADAR_TRADING_ACCOUNT_BUTTON = 'optionsdesk-radar-trading-account-button';

/**
 * 雷达首屏最小 mock（照 081 `optionsdesk-trading-account.spec.ts` 同名函数）：canonical 锚集合为空
 * ⇒ 恒判 `zero_anchors`。只为「返回雷达再进入」臂提供雷达首屏，非本片被测对象。
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
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  });
}

/** 进期权台 tab 雷达（首发吃 Metro 冷打包 ⇒ 长超时锚在 tab bar）。 */
async function gotoRadar(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '期权台' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '期权台' }).tap();
  await expect(page.getByTestId(RADAR_TRADING_ACCOUNT_BUTTON)).toBeVisible({ timeout: 30_000 });
}

/** navigator header 返回箭头（a11y 名 `<上屏标题>, back`，角色在 link / button 间变 ⇒ 取并）。 */
function headerBackLocator(page: Page): Locator {
  return page
    .getByRole('button', { name: /back/i })
    .or(page.getByRole('link', { name: /back/i }))
    .first();
}

test('083 T015① 3 行组 ⇒ 组头「ZQY 示例(3)」、组市值 / 组盈亏万缩写、组头现价 = 正股行现价（sb 12 / US1-AS1）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await gotoTradingAccount(page);

  await expect(groupHeader(page, 'us:ZQY')).toBeVisible({ timeout: 30_000 });
  await expect(groupPart(page, 'us:ZQY', 'title')).toHaveText('ZQY 示例(3)');
  await expect(groupPart(page, 'us:ZQY', 'market-value')).toHaveText('24.08万');
  await expect(groupPart(page, 'us:ZQY', 'pl')).toHaveText('+1.07万');
  await expect(groupPart(page, 'us:ZQY', 'price')).toHaveText('48.20');
});

test('083 T015② 单行组 ⇒ 无组头，直接出行（sb 11 / US1-AS2）', async ({ page }) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await gotoTradingAccount(page);

  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible({ timeout: 30_000 });
  await expect(rowPart(page, ZQR_CALL.id, 'name')).toHaveText('ZQR 示例 Call');
  await expect(rowPart(page, ZQR_CALL.id, 'sub')).toHaveText('261120 30');
  await expect(groupHeader(page, 'us:ZQR')).toHaveCount(0);
  // 对照：同一响应里的 3 行组有组头（排除「组头整体没渲染」的恒真）。
  await expect(groupHeader(page, 'us:ZQY')).toBeVisible();
});

test('083 T015③ 点组头折叠 / 再点展开；折叠后返回雷达再进入 ⇒ 全部展开（sb 13 / US1-AS7）', async ({
  page,
}) => {
  await installRadarMock(page);
  await installPositionsMock(page, newServer(US_GROUPED));
  await gotoRadar(page);
  await page.getByTestId(RADAR_TRADING_ACCOUNT_BUTTON).tap();
  await expect(page.getByTestId(SCREEN)).toBeVisible({ timeout: 30_000 });

  const header = groupHeader(page, 'us:ZQY');
  await expect(header).toBeVisible({ timeout: 30_000 });
  for (const id of ZQY_ROW_IDS) await expect(positionRow(page, id)).toBeVisible();

  // 点组头 ⇒ 只留组头，组内行隐藏；其他组不受影响。
  await header.tap();
  for (const id of ZQY_ROW_IDS) await expect(positionRow(page, id)).toHaveCount(0);
  await expect(header).toBeVisible();
  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible();

  // 再点 ⇒ 展开。
  await header.tap();
  for (const id of ZQY_ROW_IDS) await expect(positionRow(page, id)).toBeVisible();

  // 折叠后离开交易账户页（header 返回雷达，本屏卸载）→ 再进入 ⇒ 全部展开（FR-004）。
  await header.tap();
  await expect(positionRow(page, ZQY_STOCK.id)).toHaveCount(0);
  await headerBackLocator(page).tap();
  await expect(page).toHaveURL(/\/optionsdesk\/?$/, { timeout: 30_000 });
  await expect(page.getByTestId(SCREEN)).toHaveCount(0);

  await page.getByTestId(RADAR_TRADING_ACCOUNT_BUTTON).tap();
  await expect(page.getByTestId(SCREEN)).toBeVisible({ timeout: 30_000 });
  await expect(groupHeader(page, 'us:ZQY')).toBeVisible({ timeout: 30_000 });
  for (const id of ZQY_ROW_IDS) await expect(positionRow(page, id)).toBeVisible();
});

// 🚨 依赖持仓详情路由（T017 才建）：T017 落路由后解除 fixme 并补全「进详情 → header 返回」两步，
//    🚫 删掉本臂或为此提前建路由。
test.fixme('083 T015③b 折叠后进持仓详情再返回 ⇒ 仍折叠（sb 13 / US1-AS7；T017 落路由后解除）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await gotoTradingAccount(page);

  await groupHeader(page, 'us:ZQY').tap();
  await expect(positionRow(page, ZQY_STOCK.id)).toHaveCount(0);
  // T017：点单行组的行进入持仓详情 → header 返回交易账户页（列表屏未卸载）。
  for (const id of ZQY_ROW_IDS) await expect(positionRow(page, id)).toHaveCount(0);
});

test('083 T015④ 港股空头认沽 ⇒「示例汽车 沽」、第二行 261029 7.25、数量与市值为负（sb 22 / US1-AS3）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED, HK_SHORT_PUT));
  await gotoTradingAccount(page);
  await page.getByTestId('optionsdesk-trading-account-market-tab-hk').tap();

  const id = HK_SHORT_PUT_ROW.id;
  await expect(positionRow(page, id)).toBeVisible({ timeout: 30_000 });
  await expect(rowPart(page, id, 'name')).toHaveText('示例汽车 沽');
  await expect(rowPart(page, id, 'sub')).toHaveText('261029 7.25');
  await expect(rowPart(page, id, 'qty')).toHaveText('-3');
  await expect(rowPart(page, id, 'market-value')).toHaveText('-1,740.00');
});

test('083 T015⑤ expired=true 行 ⇒「已到期 · 待同步」可见，未到期行无此标（sb 23 / US1-AS9）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await gotoTradingAccount(page);

  await expect(positionRow(page, ZQY_PUT_EXPIRED.id)).toBeVisible({ timeout: 30_000 });
  await expect(rowPart(page, ZQY_PUT_EXPIRED.id, 'expired')).toHaveText('已到期 · 待同步');
  await expect(rowPart(page, ZQY_CALL.id, 'expired')).toHaveCount(0);
});

test('083 T015⑥a brokerCount=1 ⇒ 行上无连接标签（sb 20）', async ({ page }) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await gotoTradingAccount(page);

  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible({ timeout: 30_000 });
  await expect(rowPart(page, ZQR_CALL.id, 'connection')).toHaveCount(0);
  await expect(positionsRoot(page).getByText('示例连接')).toHaveCount(0);
});

test('083 T015⑥b brokerCount=2 且同合约两行 ⇒ 两行各显示自己的连接名称（sb 20, 21）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(TWO_CONNECTIONS));
  await gotoTradingAccount(page);

  await expect(positionRow(page, 'us-zqr-call-a')).toBeVisible({ timeout: 30_000 });
  await expect(positionRow(page, 'us-zqr-call-b')).toBeVisible();
  await expect(rowPart(page, 'us-zqr-call-a', 'connection')).toHaveText('示例连接 A');
  await expect(rowPart(page, 'us-zqr-call-b', 'connection')).toHaveText('示例连接 B');
});

test('083 T015⑦ 行 marketValue=37560 ⇒ 主列表显示 3.76万（FR-022）', async ({ page }) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await gotoTradingAccount(page);

  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible({ timeout: 30_000 });
  await expect(rowPart(page, ZQR_CALL.id, 'market-value')).toHaveText('3.76万');
});

// ════════════════════════════════════════════════════════════════════════════
// T016 —— 重读触发（下拉 / 回前台）+ 重读失败保留数据
// ════════════════════════════════════════════════════════════════════════════

/** 下一次成功同步后的服务端状态（同步时刻前移一天）。 */
const RESYNCED_AT_LOCAL = '2026-09-15 09:05:12';
const RESYNCED_LABEL = '09-15 09:05（美东）';

interface RequestLog {
  /** 某端点（按正则 + market）的 GET 命中次数。 */
  hits: (re: RegExp, market?: Market) => number;
  /** 全部 `/api/` 请求的 URL（按发出顺序），用于「没有请求任何非本片端点」。 */
  apiUrls: string[];
}

/** 旁路观测请求（只计数，不参与 mock 应答 —— 应答仍是 `(参数, 服务端状态) → 响应` 纯函数）。 */
function observeRequests(page: Page): RequestLog {
  const gets: string[] = [];
  const apiUrls: string[] = [];
  page.on('request', (req) => {
    if (!req.url().includes('/api/')) return;
    apiUrls.push(req.url());
    if (req.method() === 'GET') gets.push(req.url());
  });
  return {
    apiUrls,
    hits: (re, market) =>
      gets.filter(
        (url) =>
          re.test(url) &&
          (market === undefined || new URL(url).searchParams.get('market') === market),
      ).length,
  };
}

interface FiberLike {
  memoizedProps?: { onRefresh?: unknown } | null;
  return?: FiberLike | null;
}

/**
 * 下拉重读。🚨 RN Web 的 `RefreshControl` 渲染成普通 View、丢弃 `onRefresh`，**没有下拉手势**
 * ⇒ 从它的 DOM 节点沿 React fiber 向上找到 `RefreshControl` 元素、直调其 `onRefresh`（= 真机下拉松手）。
 * 没接 `onRefresh` ⇒ 找不到 ⇒ 抛错（定向变异「去掉 onRefresh」的红就落在这里）。
 * 找 fiber 限 4 层：`div` → View → RefreshControl，防越级命中无关祖先。
 */
async function pullToRefresh(refreshControl: Locator): Promise<void> {
  await refreshControl.evaluate((el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let fiber: FiberLike | null | undefined = key
      ? (el as unknown as Record<string, FiberLike>)[key]
      : undefined;
    for (let depth = 0; fiber && depth < 4; depth += 1, fiber = fiber.return) {
      const onRefresh = fiber.memoizedProps?.onRefresh;
      if (typeof onRefresh === 'function') {
        (onRefresh as () => void)();
        return;
      }
    }
    throw new Error('RefreshControl 上没有 onRefresh');
  });
}

/**
 * App 切后台再回前台：react-native-web 的 `AppState` 由 `visibilitychange` + `document.visibilityState`
 * 驱动（`hidden` ⇒ background，`visible` ⇒ active）⇒ 覆写 `visibilityState` 后派发两次事件。
 */
async function backgroundThenForeground(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const state of ['hidden', 'visible'] as const) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
}

test('083 T016① 下拉重读 ⇒ 列表端点命中 +1、同步时刻更新，且没有请求任何非本片端点（sb 14 / US1-AS8）', async ({
  page,
}) => {
  const log = observeRequests(page);
  const server = newServer(US_GROUPED);
  await installPositionsMock(page, server);
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'synced-at')).toHaveText(`同步于 ${SYNCED_LABEL.us}`, {
    timeout: 30_000,
  });
  const before = log.hits(POSITIONS_RE, 'us');
  const apiMark = log.apiUrls.length;

  // 服务端状态事件：又同步成功了一次。
  server.byMarket.us = { ...US_GROUPED, syncedAtLocal: RESYNCED_AT_LOCAL };
  await pullToRefresh(inPositions(page, 'refresh'));

  await expect(inPositions(page, 'synced-at')).toHaveText(`同步于 ${RESYNCED_LABEL}`, {
    timeout: 30_000,
  });
  expect(log.hits(POSITIONS_RE, 'us')).toBe(before + 1);
  const others = log.apiUrls.slice(apiMark).filter((url) => !POSITIONS_RE.test(url));
  expect(others, `下拉触发了非本片端点:\n${others.join('\n')}`).toEqual([]);
});

test('083 T016② App 切后台再回前台 ⇒ 列表端点命中 +1（sb 14 回前台面）', async ({ page }) => {
  const log = observeRequests(page);
  const server = newServer(US_GROUPED);
  await installPositionsMock(page, server);
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'synced-at')).toHaveText(`同步于 ${SYNCED_LABEL.us}`, {
    timeout: 30_000,
  });
  const before = log.hits(POSITIONS_RE, 'us');

  server.byMarket.us = { ...US_GROUPED, syncedAtLocal: RESYNCED_AT_LOCAL };
  await backgroundThenForeground(page);

  await expect(inPositions(page, 'synced-at')).toHaveText(`同步于 ${RESYNCED_LABEL}`, {
    timeout: 30_000,
  });
  expect(log.hits(POSITIONS_RE, 'us')).toBe(before + 1);
});

test('083 T016③ 列表已显示、下拉重读 500 ⇒ 行仍可见 + 刷新失败提示；恢复后下拉 ⇒ 提示消失、数据更新（sb 43 / US1-AS10）', async ({
  page,
}) => {
  const server = newServer(US_GROUPED);
  await installPositionsMock(page, server);
  await gotoTradingAccount(page);

  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible({ timeout: 30_000 });

  server.healthy = false;
  await pullToRefresh(inPositions(page, 'refresh'));

  await expect(inPositions(page, 'refetch-failed')).toHaveText('刷新失败，显示的是上次加载的数据', {
    timeout: 30_000,
  });
  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible();
  await expect(groupHeader(page, 'us:ZQY')).toBeVisible();
  await expect(inPositions(page, 'synced-at')).toHaveCount(0);
  await expect(inPositions(page, 'error')).toHaveCount(0);

  server.healthy = true;
  server.byMarket.us = { ...US_GROUPED, syncedAtLocal: RESYNCED_AT_LOCAL };
  await pullToRefresh(inPositions(page, 'refresh'));

  await expect(inPositions(page, 'synced-at')).toHaveText(`同步于 ${RESYNCED_LABEL}`, {
    timeout: 30_000,
  });
  await expect(inPositions(page, 'refetch-failed')).toHaveCount(0);
  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible();
});
