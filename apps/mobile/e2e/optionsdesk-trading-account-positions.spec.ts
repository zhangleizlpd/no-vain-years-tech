import { expect, test, type Locator, type Page, type Route } from './_support/fixtures';
import type {
  AnchorColdStartRunResponse,
  AnchorSubmissionReviewResponse,
  BrokerBackfillRunResponse,
  BrokerLotResponse,
  BrokerOrderDetailResponse,
  BrokerPositionDetailResponse,
  BrokerPositionGroupResponse,
  BrokerPositionListResponse,
  BrokerPositionOrderItemResponse,
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
//          ③b 折叠后点行进持仓详情、header 返回 ⇒ 仍折叠（T017 落路由后解除 fixme）
//        ④ 港股空头认沽 ⇒「示例汽车 沽」、第二行 `261029 7.25`、数量与市值为负（sb 22 / US1-AS3）
//        ⑤ `expired=true` 行 ⇒「已到期 · 待清算」可见（sb 23 / US1-AS9）
//        ⑥ `brokerCount=1` ⇒ 无连接标签；`=2` 且同合约两行 ⇒ 各显示自己的连接名称（sb 20, 21）
//        ⑦ 行 `marketValue='37560'` ⇒ 主列表显示 `3.76万`（FR-022）
//   T016 ① 下拉重读 ⇒ 列表端点命中 +1、同步时刻更新、无非本片端点请求（sb 14 下拉面 / US1-AS8）
//        ② 切后台再回前台（`visibilitychange`）⇒ 列表端点命中 +1（sb 14 回前台面）
//        ③ 列表已显示、重读 500 ⇒ 行仍可见 + 刷新失败提示；恢复后重读 ⇒ 提示消失（sb 43 / US1-AS10）
//        ④ 聚焦面不在此验（「进雷达再返回」是重新挂载，测不出聚焦）⇒ 由 T017⑩ 进持仓详情再返回验
//   T017 ① 点正股行 ⇒ 持仓详情汇总（全精度）+ 订单列表（sb 34 / US3-AS1）
//        ② 已撤单订单状态标可见（sb 36；状态中文映射归 T018）
//        ③ 详情首次 500 ⇒「加载失败 + 重试」（sb 46）  ④ 首次即 404 ⇒「持仓已不存在」（sb 40）
//        ⑤ 已显示后重读 404 ⇒「持仓已不存在」替换旧数据（sb 40 / FR-020）
//        ⑥ 已显示后重读 500 ⇒ 汇总保留 + 顶部刷新失败提示（sb 43 / FR-023）
//        ⑦ 详情下拉 ⇒ 详情端点命中 +1（sb 14 下钻面）  ⑧ 深链进详情后 header 返回 ⇒ 交易账户页
//        ⑨ 开仓时间时区标签按响应 `market`  ⑩ 详情返回列表（未卸载，只靠聚焦）⇒ 列表端点命中 +1（sb 14 聚焦面）
//   T018 ③ 列表 → 正股行 → 订单（恰 2 次点击）⇒ 订单详情九个字段（sb 37 / US2-AS5 / SC-004）
//        ④ 未成交订单 ⇒ 成交数量 / 均价 / 金额显示「—」（sb 38 / US3-AS4）  ⑤ 组合单 ⇒ 两个腿码（sb 31 / US2-AS6）
//        ⑥ 首次即 404 ⇒「订单不存在」（sb 45）  ⑦ 首次 500 ⇒「加载失败 + 重试」（sb 46）
//        ⑧ 页面无「撤单 / 改单 / 平仓」字样、无按钮（FR-019）  ⑨ 下单时间时区标签按响应 `market`
//        ⑩ 下拉 ⇒ 订单详情端点命中 +1（sb 14 下钻面）  ⑪ 已显示后重读 500 ⇒ 字段保留 + 刷新失败提示（sb 43）
//        ⑫ 已显示后重读 404 ⇒「订单不存在」替换旧数据（sb 45 / FR-020）
//        （①② 为文案映射纯逻辑，在 vitest `trading-account-positions.rules.spec.ts`）
//   T019 ① 点期权行 ⇒ 汇总 → 2 个批次 → 本合约订单（sb 25 / US2-AS1 / US2-AS7）
//        ② 被买回扣减的批次「剩余 1 / 2」（sb 27 / US2-AS2）  ③ 只 2 个批次 ⇒ 无第三行；正股无批次段（sb 28）
//        ④ `restorable=false` ⇒「批次无法还原」、批次行不渲染、订单照常（sb 30 / US2-AS4）
//        ⑤ `orderDbId=null` 的批次无 `›`、点击不跳转（sb 32）
//        ⑥ 列表 → 期权行 → 批次（恰 2 次点击）⇒ 订单详情（sb 33 / SC-004）
//        ⑦ 列表 → 期权行 →「本合约订单」项（恰 2 次点击）⇒ 订单详情（SC-004 第三条路径）
//   T026（维护者 2026-09-15 impl 期裁决）
//        ① 列表已显示且 `stale=true`、重读 500 ⇒ 陈旧条与刷新失败提示同时可见，陈旧条在上（sb 48）
//        ② 「尚未同步」卡下拉、响应变为有数据 ⇒ 出列表；「暂无交易账户」「暂无持仓」卡下拉 ⇒ 列表端点命中 +1（sb 49）
//   T020（深链进冷启动结局页；mock 待审箱 CONSUMED + 冷启动结局 + 补齐状态端点）
//        ① 成功记录 ⇒「券商历史 · 成功」+ 时刻（sb 41 / US4-AS1）  ② 无记录 ⇒「券商历史 · 未触发」（sb 42 / US4-AS2）
//        ③ 补齐状态端点 500 ⇒ 券商历史行不出现、冷启动结局照常（sb 47）
//        ④ 请求的 `tickers` 参数 = 冷启动结局的 ticker 集合
//
// ── 重读触发在 web 上怎么验 ─────────────────────────────────────────────────────
//   · 下拉：RN Web 的 `RefreshControl` 无手势 ⇒ `pullToRefresh` 沿 fiber 直调其 `onRefresh`。
//   · 回前台：react-native-web 的 `AppState` 由 `visibilitychange` 驱动 ⇒ 覆写 `visibilityState` 后派发事件。
//   · 叠屏：详情 push 在交易账户页上时两屏 header 返回都在 DOM ⇒ `visibleHeaderBack` 只取可见的。
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

test('083 T015③b 折叠后进持仓详情再返回 ⇒ 仍折叠（sb 13 / US1-AS7）', async ({ page }) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer(ZQR_CALL_DETAIL));
  await gotoTradingAccount(page);

  await expect(groupHeader(page, 'us:ZQY')).toBeVisible({ timeout: 30_000 });
  await groupHeader(page, 'us:ZQY').tap();
  for (const id of ZQY_ROW_IDS) await expect(positionRow(page, id)).toHaveCount(0);

  // 点单行组的行进入持仓详情 → header 返回交易账户页（列表屏未卸载 ⇒ 折叠状态还在）。
  await positionRow(page, ZQR_CALL.id).tap();
  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });
  await visibleHeaderBack(page).tap();
  await expect(detailRoot(page)).toHaveCount(0, { timeout: 30_000 });

  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible();
  await expect(groupHeader(page, 'us:ZQY')).toBeVisible();
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

test('083 T015⑤ expired=true 行 ⇒「已到期 · 待清算」可见，未到期行无此标（sb 23 / US1-AS9）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await gotoTradingAccount(page);

  await expect(positionRow(page, ZQY_PUT_EXPIRED.id)).toBeVisible({ timeout: 30_000 });
  await expect(rowPart(page, ZQY_PUT_EXPIRED.id, 'expired')).toHaveText('已到期 · 待清算');
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

// ════════════════════════════════════════════════════════════════════════════
// T026 —— 维护者 2026-09-15 impl 期裁决：陈旧与刷新失败并存 + 状态卡下拉重读
// ════════════════════════════════════════════════════════════════════════════

const STALE_TEXT = `数据可能已过时 · 最近成功同步于 ${SYNCED_LABEL.us}`;
const REFETCH_FAILED_TEXT = '刷新失败，显示的是上次加载的数据';

test('083 T026① 列表已显示且 stale=true、下拉重读 500 ⇒ 陈旧条与刷新失败提示同时可见、陈旧条在上（sb 48 / FR-023）', async ({
  page,
}) => {
  const server = newServer({ ...US_GROUPED, stale: true });
  await installPositionsMock(page, server);
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'stale')).toHaveText(STALE_TEXT, { timeout: 30_000 });
  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible();

  server.healthy = false;
  await pullToRefresh(inPositions(page, 'refresh'));

  await expect(inPositions(page, 'refetch-failed')).toHaveText(REFETCH_FAILED_TEXT, {
    timeout: 30_000,
  });
  await expect(inPositions(page, 'stale')).toHaveText(STALE_TEXT);
  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible();
  await expect(inPositions(page, 'synced-at')).toHaveCount(0);
  await expect(inPositions(page, 'error')).toHaveCount(0);

  const staleBox = await inPositions(page, 'stale').boundingBox();
  const failedBox = await inPositions(page, 'refetch-failed').boundingBox();
  expect(staleBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    failedBox?.y ?? Number.NEGATIVE_INFINITY,
  );
});

test('083 T026②a「尚未同步」卡下拉、服务端已完成首次同步 ⇒ 出列表、列表端点命中 +1、无非本片端点请求（sb 49）', async ({
  page,
}) => {
  const log = observeRequests(page);
  const server = newServer(listResponse('us', { syncedAt: null, syncedAtLocal: null, groups: [] }));
  await installPositionsMock(page, server);
  await gotoTradingAccount(page);

  await expect(inPositions(page, 'never-synced')).toBeVisible({ timeout: 30_000 });
  await expect(inPositions(page, 'state-refresh')).toBeVisible();
  const before = log.hits(POSITIONS_RE, 'us');
  const apiMark = log.apiUrls.length;

  // 服务端状态事件：首次同步成功。
  server.byMarket.us = US_GROUPED;
  await pullToRefresh(inPositions(page, 'state-refresh'));

  await expect(positionRow(page, ZQR_CALL.id)).toBeVisible({ timeout: 30_000 });
  await expect(inPositions(page, 'never-synced')).toHaveCount(0);
  expect(log.hits(POSITIONS_RE, 'us')).toBe(before + 1);
  const others = log.apiUrls.slice(apiMark).filter((url) => !POSITIONS_RE.test(url));
  expect(others, `下拉触发了非本片端点:\n${others.join('\n')}`).toEqual([]);
});

const STATE_CARDS_PULL: {
  title: string;
  view: 'no-connection' | 'empty';
  response: BrokerPositionListResponse;
}[] = [
  { title: '暂无交易账户', view: 'no-connection', response: NO_CONNECTION },
  { title: '暂无持仓', view: 'empty', response: listResponse('us', { groups: [] }) },
];

for (const card of STATE_CARDS_PULL) {
  test(`083 T026②b「${card.title}」卡下拉 ⇒ 列表端点命中 +1、卡仍在、无非本片端点请求（sb 49）`, async ({
    page,
  }) => {
    const log = observeRequests(page);
    await installPositionsMock(page, newServer(card.response));
    await gotoTradingAccount(page);

    await expect(inPositions(page, card.view)).toBeVisible({ timeout: 30_000 });
    await expect(inPositions(page, 'state-refresh')).toBeVisible();
    const before = log.hits(POSITIONS_RE, 'us');
    const apiMark = log.apiUrls.length;

    await pullToRefresh(inPositions(page, 'state-refresh'));

    await expect.poll(() => log.hits(POSITIONS_RE, 'us'), { timeout: 30_000 }).toBe(before + 1);
    await expect(inPositions(page, card.view)).toBeVisible();
    const others = log.apiUrls.slice(apiMark).filter((url) => !POSITIONS_RE.test(url));
    expect(others, `下拉触发了非本片端点:\n${others.join('\n')}`).toEqual([]);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// T017 —— 持仓详情屏：路由 + 汇总 + 订单段 + 加载 / 404 / 重读
// ════════════════════════════════════════════════════════════════════════════

/** 只认详情端点 `/broker-positions/:id`（与列表端点 `POSITIONS_RE` 互斥）。 */
const POSITION_DETAIL_RE = /\/api\/v1\/optionsdesk\/broker-positions\/([^/?]+)(\?|$)/;
const DETAIL_SCREEN = 'optionsdesk-trading-account-position-screen';
const DETAIL = 'optionsdesk-trading-account-position';

function order(
  id: string,
  side: string,
  qty: string,
  price: string | null,
  status: string,
  createdAtLocal: string | null,
): BrokerPositionOrderItemResponse {
  return { id, side, qty, price, status, createdAtLocal };
}

/** 「ZQY 示例」正股持仓详情：4 张订单（含 1 张已撤单），下单时间降序（服务端已排好）。 */
const ZQY_STOCK_DETAIL: BrokerPositionDetailResponse = {
  ...ZQY_STOCK,
  openedAtLocal: '2026-07-02 10:05:00',
  orders: [
    order('ord-4', 'BUY', '100', '45.00', 'FILLED_ALL', '2026-09-11 16:52:00'),
    order('ord-3', 'SELL', '50', '49.10', 'CANCELLED_ALL', '2026-08-20 13:30:00'),
    order('ord-2', 'BUY', '50', '47.00', 'FILLED_ALL', '2026-07-15 09:48:00'),
    order('ord-1', 'BUY', '50', '44.90', 'FILLED_ALL', '2026-07-02 10:05:00'),
  ],
  lots: null,
};

/**
 * 「ZQR 示例 Call」期权持仓详情：批次无法还原（批次剩余合计 2 ≠ 持仓 1）。
 * 🚨 `lots` 刻意**非空**：服务端 `restorable=false` 时照常返回批次，空数组会让「不渲染批次」恒真（T019④）。
 */
const ZQR_CALL_DETAIL: BrokerPositionDetailResponse = {
  ...ZQR_CALL,
  openedAtLocal: '2026-08-20 10:15:00',
  orders: [order('ord-9', 'BUY', '1', '2.60', 'FILLED_ALL', '2026-08-20 10:15:00')],
  lots: {
    restorable: false,
    lots: [lot('2026-08-20 10:15:00', 'ord-9', '2', '2', '2.60', '75120', '-100.00')],
  },
};

/**
 * 已到期期权的持仓详情（FR-021 的「持仓详情」半，2026-09-16 amend 才实装）。
 * `expired: true` 由 `ZQY_PUT_EXPIRED` 带入；`lots: null` —— 本用例只验到期标，不牵批次段。
 */
const ZQY_PUT_EXPIRED_DETAIL: BrokerPositionDetailResponse = {
  ...ZQY_PUT_EXPIRED,
  openedAtLocal: '2026-08-05 09:40:00',
  orders: [order('ord-21', 'SELL_SHORT', '1', '1.35', 'FILLED_ALL', '2026-08-05 09:40:00')],
  lots: null,
};

/** 港股正股持仓详情（交易账户页默认市场是美股 ⇒ 时区标签只能来自响应 `market`）。 */
const HK_STOCK_DETAIL: BrokerPositionDetailResponse = {
  ...stockRow('hk'),
  openedAtLocal: '2026-09-01 10:32:00',
  orders: [],
  lots: null,
};

/** 按 id 读的详情端点背后的服务端状态（持仓 / 订单共用）。 */
interface ByIdServer<T> {
  /** false ⇒ 详情端点 500（服务端故障）。 */
  healthy: boolean;
  /** 仍存在的记录；删掉 = 被同步移除 ⇒ 404。 */
  byId: Map<string, T>;
}

type PositionDetailServer = ByIdServer<BrokerPositionDetailResponse>;

function newDetailServer(...details: BrokerPositionDetailResponse[]): PositionDetailServer {
  return { healthy: true, byId: new Map(details.map((d) => [d.id, d])) };
}

async function installPositionDetailMock(page: Page, server: PositionDetailServer): Promise<void> {
  await installByIdMock(page, POSITION_DETAIL_RE, server, 'BROKER_POSITION_NOT_FOUND');
}

/**
 * 详情端点 mock：`(id, server) → 响应` 纯函数；不存在 ⇒ 404 ProblemDetail（错误码在 `detail`）。
 * `re` 的第 1 个捕获组 = 路径里的 id。
 */
async function installByIdMock<T>(
  page: Page,
  re: RegExp,
  server: ByIdServer<T>,
  notFoundCode: string,
): Promise<void> {
  await page.route(re, async (route: Route) => {
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
        body: JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500 }),
      }));
    }
    const id = decodeURIComponent(re.exec(new URL(req.url()).pathname)?.[1] ?? '');
    const detail = server.byId.get(id);
    if (detail === undefined) {
      return void (await route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: notFoundCode,
        }),
      }));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify(detail),
    });
  });
}

function detailRoot(page: Page): Locator {
  return page.getByTestId(DETAIL_SCREEN);
}

function inDetail(page: Page, suffix: string): Locator {
  return detailRoot(page).getByTestId(`${DETAIL}-${suffix}`);
}

/** 深链进持仓详情（首发吃 Metro 冷打包 ⇒ 长超时锚在详情屏根）。 */
async function gotoPositionDetail(page: Page, id: string): Promise<void> {
  await page.goto(`/optionsdesk/trading-account-position/${id}`);
  await expect(detailRoot(page)).toBeVisible({ timeout: 90_000 });
}

/** 叠屏时下层屏的 header 返回也在 DOM ⇒ 只取可见的那一个（🚫 `page.goBack`）。 */
function visibleHeaderBack(page: Page): Locator {
  return page
    .getByRole('button', { name: /back/i })
    .or(page.getByRole('link', { name: /back/i }))
    .filter({ visible: true })
    .first();
}

test('083 T017① 点正股行 ⇒ 持仓详情显示汇总（全精度）与订单列表（sb 34 / US3-AS1）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer(ZQY_STOCK_DETAIL));
  await gotoTradingAccount(page);

  await expect(positionRow(page, ZQY_STOCK.id)).toBeVisible({ timeout: 30_000 });
  await positionRow(page, ZQY_STOCK.id).tap();

  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/optionsdesk\/trading-account-position\/us-zqy-stock$/);
  await expect(inDetail(page, 'name')).toHaveText('ZQY 示例');
  await expect(inDetail(page, 'code-line')).toHaveText('ZQY · 美股');
  await expect(inDetail(page, 'qty')).toHaveText('5000 股');
  await expect(inDetail(page, 'market-value')).toHaveText('241,000.00');
  await expect(inDetail(page, 'price')).toHaveText('48.20');
  await expect(inDetail(page, 'cost')).toHaveText('46.10');
  await expect(inDetail(page, 'pl')).toHaveText('+10,500.00 / +4.56%');
  await expect(inDetail(page, 'orders-title')).toHaveText('订单');
  for (const { id } of ZQY_STOCK_DETAIL.orders) {
    await expect(inDetail(page, `order-${id}`)).toBeVisible();
  }
  await expect(inDetail(page, 'order-ord-3-summary')).toHaveText('卖出 50 股 @ 49.10');
  await expect(inDetail(page, 'order-ord-3-time')).toHaveText('26-08-20 13:30（美东）');
});

// 📌 状态 / 方向为 T018 的中文映射（`orderStatusText` / `tradeSideText`）。
test('083 T017② 已撤单订单照常列出、状态标可见（sb 36 / US3-AS3）', async ({ page }) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer(ZQY_STOCK_DETAIL));
  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);

  await expect(inDetail(page, 'order-ord-3-status')).toHaveText('已撤单', {
    timeout: 30_000,
  });
  await expect(inDetail(page, 'order-ord-4-status')).toHaveText('全部成交');
});

// 📌 FR-021 写的是「主列表行**与持仓详情**标」，但详情屏那一半自 083 起从未实装（2026-09-16 补）。
test('083 FR-021 详情半 已到期期权详情 ⇒ 汇总卡出「已到期 · 待清算」；未到期持仓无此标', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer(ZQY_PUT_EXPIRED_DETAIL, ZQY_STOCK_DETAIL));

  await gotoPositionDetail(page, ZQY_PUT_EXPIRED_DETAIL.id);
  await expect(inDetail(page, 'expired')).toHaveText('已到期 · 待清算', { timeout: 30_000 });
  await expect(inDetail(page, 'expired-note')).toHaveText(
    '合约已到期，结算完成后券商会移除该持仓。',
  );

  // 🚨 反臂: 没有它, 一个无条件渲染的标会让上一条恒真。
  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);
  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });
  await expect(inDetail(page, 'expired')).toHaveCount(0);
});

test('083 T017③ 详情端点首次 500 ⇒「加载失败 + 重试」；恢复后点重试 ⇒ 汇总（sb 46）', async ({
  page,
}) => {
  const server = newDetailServer(ZQY_STOCK_DETAIL);
  server.healthy = false;
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, server);
  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);

  await expect(inDetail(page, 'error')).toBeVisible({ timeout: 30_000 });
  await expect(detailRoot(page).getByText('加载失败', { exact: true })).toBeVisible();
  await expect(inDetail(page, 'summary')).toHaveCount(0);

  server.healthy = true;
  await inDetail(page, 'retry').tap();
  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });
  await expect(inDetail(page, 'error')).toHaveCount(0);
});

test('083 T017④ 首次即 404 ⇒「持仓已不存在」，不是错误态（sb 40）', async ({ page }) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer());
  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);

  await expect(inDetail(page, 'not-found')).toBeVisible({ timeout: 30_000 });
  await expect(detailRoot(page).getByText('持仓已不存在', { exact: true })).toBeVisible();
  await expect(inDetail(page, 'error')).toHaveCount(0);
  await expect(inDetail(page, 'summary')).toHaveCount(0);
});

test('083 T017⑤ 详情已显示后下拉、响应 404 ⇒「持仓已不存在」替换旧数据（sb 40 / FR-020）', async ({
  page,
}) => {
  const server = newDetailServer(ZQY_STOCK_DETAIL);
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, server);
  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);
  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });

  // 服务端状态事件：该持仓在最近一次同步中被移除。
  server.byId.delete(ZQY_STOCK_DETAIL.id);
  await pullToRefresh(inDetail(page, 'refresh'));

  await expect(inDetail(page, 'not-found')).toBeVisible({ timeout: 30_000 });
  await expect(inDetail(page, 'summary')).toHaveCount(0);
  await expect(inDetail(page, 'refetch-failed')).toHaveCount(0);
});

test('083 T017⑥ 详情已显示后下拉、响应 500 ⇒ 汇总仍可见 + 顶部刷新失败提示（sb 43 / FR-023）', async ({
  page,
}) => {
  const server = newDetailServer(ZQY_STOCK_DETAIL);
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, server);
  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);
  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });

  server.healthy = false;
  await pullToRefresh(inDetail(page, 'refresh'));

  await expect(inDetail(page, 'refetch-failed')).toHaveText('刷新失败，显示的是上次加载的数据', {
    timeout: 30_000,
  });
  await expect(inDetail(page, 'summary')).toBeVisible();
  await expect(inDetail(page, 'error')).toHaveCount(0);
  await expect(inDetail(page, 'not-found')).toHaveCount(0);
});

test('083 T017⑦ 详情页下拉 ⇒ 详情端点命中 +1（sb 14 下钻面）', async ({ page }) => {
  const log = observeRequests(page);
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer(ZQY_STOCK_DETAIL));
  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);
  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });
  const before = log.hits(POSITION_DETAIL_RE);

  await pullToRefresh(inDetail(page, 'refresh'));

  await expect.poll(() => log.hits(POSITION_DETAIL_RE), { timeout: 30_000 }).toBe(before + 1);
  await expect(inDetail(page, 'summary')).toBeVisible();
});

test('083 T017⑧ 深链进入详情后 header 返回 ⇒ 落到交易账户页', async ({ page }) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer(ZQY_STOCK_DETAIL));
  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);
  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });

  await visibleHeaderBack(page).tap();

  await expect(page).toHaveURL(/\/optionsdesk\/trading-account\/?$/, { timeout: 30_000 });
  await expect(page.getByTestId(SCREEN)).toBeVisible({ timeout: 30_000 });
  await expect(detailRoot(page)).toHaveCount(0);
});

test('083 T017⑨ 开仓时间的时区标签由响应 market 决定（美股 ⇒ 美东、港股 ⇒ 香港）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer(ZQY_STOCK_DETAIL, HK_STOCK_DETAIL));

  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);
  await expect(inDetail(page, 'opened-at-label')).toHaveText('开仓时间（美东）', {
    timeout: 30_000,
  });
  await expect(inDetail(page, 'opened-at')).toHaveText('26-07-02 10:05');

  // 交易账户页默认市场是美股 ⇒ 港股标签只可能来自详情响应的 `market`。
  await gotoPositionDetail(page, HK_STOCK_DETAIL.id);
  await expect(inDetail(page, 'opened-at-label')).toHaveText('开仓时间（香港）', {
    timeout: 30_000,
  });
  await expect(inDetail(page, 'orders-empty')).toBeVisible();
});

test('083 T017⑩ 从持仓详情返回交易账户页（列表屏未卸载，只靠聚焦）⇒ 列表端点命中 +1（sb 14 聚焦面）', async ({
  page,
}) => {
  const log = observeRequests(page);
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer(ZQY_STOCK_DETAIL));
  await gotoTradingAccount(page);

  await expect(positionRow(page, ZQY_STOCK.id)).toBeVisible({ timeout: 30_000 });
  await positionRow(page, ZQY_STOCK.id).tap();
  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });
  const before = log.hits(POSITIONS_RE, 'us');

  await visibleHeaderBack(page).tap();

  await expect(detailRoot(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(positionRow(page, ZQY_STOCK.id)).toBeVisible();
  await expect.poll(() => log.hits(POSITIONS_RE, 'us'), { timeout: 30_000 }).toBe(before + 1);
});

// ════════════════════════════════════════════════════════════════════════════
// T018 —— 订单详情屏：九个字段 + 组合腿 + 加载 / 404 / 重读
// ════════════════════════════════════════════════════════════════════════════

/** 只认订单详情端点 `/broker-orders/:id`。 */
const ORDER_DETAIL_RE = /\/api\/v1\/optionsdesk\/broker-orders\/([^/?]+)(\?|$)/;
const ORDER_SCREEN = 'optionsdesk-trading-account-order-screen';
const ORDER = 'optionsdesk-trading-account-order';

/** 「ZQY 示例」正股全部成交买单（= `ZQY_STOCK_DETAIL` 订单段里的 `ord-4`）。 */
const ZQY_FILLED_ORDER: BrokerOrderDetailResponse = {
  id: 'ord-4',
  market: 'us',
  side: 'BUY',
  status: 'FILLED_ALL',
  orderType: 'NORMAL',
  code: 'US.ZQY',
  name: 'ZQY 示例',
  option: null,
  comboLegCodes: [],
  qty: '100',
  price: '45.00',
  amount: '4500.00',
  dealtQty: '100',
  dealtAvgPrice: '45.00',
  dealtAmount: '4500.00',
  currency: 'USD',
  createdAtLocal: '2026-09-11 16:52:07',
};

/** 未成交即撤销（= `ord-3`）⇒ 成交三字段 null。 */
const ZQY_CANCELLED_ORDER: BrokerOrderDetailResponse = {
  ...ZQY_FILLED_ORDER,
  id: 'ord-3',
  side: 'SELL',
  status: 'CANCELLED_ALL',
  qty: '50',
  price: '49.10',
  amount: '2455.00',
  dealtQty: null,
  dealtAvgPrice: null,
  dealtAmount: null,
  createdAtLocal: '2026-08-20 13:30:00',
};

/** 组合单：`option` 为 null、两条腿（未知订单类型 ⇒ 原样显示枚举名）。 */
const ZQY_COMBO_ORDER: BrokerOrderDetailResponse = {
  ...ZQY_FILLED_ORDER,
  id: 'ord-combo',
  side: 'SELL',
  orderType: 'MARKET',
  code: 'US.ZQY-COMBO',
  comboLegCodes: ['US.ZQY261016C55000', 'US.ZQY261016C60000'],
  qty: '1',
  price: '0.85',
  amount: '85.00',
  dealtQty: '1',
  dealtAvgPrice: '0.85',
  dealtAmount: '85.00',
};

/** 港股卖空认沽（交易账户页默认美股 ⇒ 香港时区标签只能来自响应 `market`）。 */
const HK_SHORT_PUT_ORDER: BrokerOrderDetailResponse = {
  id: 'ord-h3',
  market: 'hk',
  side: 'SELL_SHORT',
  status: 'FILLED_ALL',
  orderType: 'NORMAL',
  code: 'HK.08801261029P7250',
  name: '示例汽车',
  option: { expiry: '2026-10-29', right: 'P', strike: '7.250' },
  comboLegCodes: [],
  qty: '2',
  price: '0.099',
  amount: '990.00',
  dealtQty: '2',
  dealtAvgPrice: '0.099',
  dealtAmount: '990.00',
  currency: 'HKD',
  createdAtLocal: '2026-09-08 14:05:12',
};

function newOrderServer(
  ...orders: BrokerOrderDetailResponse[]
): ByIdServer<BrokerOrderDetailResponse> {
  return { healthy: true, byId: new Map(orders.map((o) => [o.id, o])) };
}

async function installOrderDetailMock(
  page: Page,
  server: ByIdServer<BrokerOrderDetailResponse>,
): Promise<void> {
  await installByIdMock(page, ORDER_DETAIL_RE, server, 'BROKER_ORDER_NOT_FOUND');
}

function orderRoot(page: Page): Locator {
  return page.getByTestId(ORDER_SCREEN);
}

function inOrder(page: Page, suffix: string): Locator {
  return orderRoot(page).getByTestId(`${ORDER}-${suffix}`);
}

/** 深链进订单详情（首发吃 Metro 冷打包 ⇒ 长超时锚在订单详情屏根）。 */
async function gotoOrderDetail(page: Page, id: string): Promise<void> {
  await page.goto(`/optionsdesk/trading-account-order/${id}`);
  await expect(orderRoot(page)).toBeVisible({ timeout: 90_000 });
}

/**
 * 从当前页起依次点击（每步先等可见，步间不做任何导航）；返回点击次数 = SC-004「≤ 2 次点击」的计数面。
 * locator 是惰性的 ⇒ 可以在导航前一次列出整条路径。
 */
async function tapThrough(steps: Locator[]): Promise<number> {
  for (const step of steps) {
    await expect(step).toBeVisible({ timeout: 30_000 });
    await step.tap();
  }
  return steps.length;
}

const ORDER_FIELD_LABELS = [
  '交易方向',
  '订单状态',
  '名称代码',
  '订单数量 / 价格',
  '订单金额',
  '成交数量 / 均价',
  '成交金额',
  '下单时间',
  '订单类型',
];

test('083 T018③ 列表 → 正股行 → 订单（恰 2 次点击）⇒ 订单详情九个字段（sb 37 / US2-AS5 / SC-004）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED));
  await installPositionDetailMock(page, newDetailServer(ZQY_STOCK_DETAIL));
  await installOrderDetailMock(page, newOrderServer(ZQY_FILLED_ORDER));
  await gotoTradingAccount(page);

  const taps = await tapThrough([positionRow(page, ZQY_STOCK.id), inDetail(page, 'order-ord-4')]);

  expect(taps).toBe(2);
  await expect(inOrder(page, 'fields')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/optionsdesk\/trading-account-order\/ord-4$/);
  for (const label of ORDER_FIELD_LABELS) {
    await expect(orderRoot(page).getByText(label, { exact: true })).toBeVisible();
  }
  await expect(inOrder(page, 'side')).toHaveText('买入');
  await expect(inOrder(page, 'status')).toHaveText('全部成交');
  await expect(inOrder(page, 'name')).toHaveText('ZQY 示例');
  await expect(inOrder(page, 'name-sub')).toHaveText('ZQY');
  await expect(inOrder(page, 'qty-price')).toHaveText('100 股 / 45.00');
  await expect(inOrder(page, 'amount')).toHaveText('4,500.00 USD');
  await expect(inOrder(page, 'dealt-qty-price')).toHaveText('100 股 / 45.00');
  await expect(inOrder(page, 'dealt-amount')).toHaveText('4,500.00');
  await expect(inOrder(page, 'created-at')).toHaveText('2026/09/11');
  await expect(inOrder(page, 'created-at-sub')).toHaveText('16:52:07（美东）');
  await expect(inOrder(page, 'order-type')).toHaveText('限价单');
  await expect(inOrder(page, 'legs')).toHaveCount(0);
});

test('083 T018④ 未成交即撤销的订单 ⇒ 成交数量 / 均价 / 金额显示「—」（sb 38 / US3-AS4）', async ({
  page,
}) => {
  await installOrderDetailMock(page, newOrderServer(ZQY_CANCELLED_ORDER));
  await gotoOrderDetail(page, ZQY_CANCELLED_ORDER.id);

  await expect(inOrder(page, 'dealt-qty-price')).toHaveText('— / —', { timeout: 30_000 });
  await expect(inOrder(page, 'dealt-amount')).toHaveText('—');
  // 对照：订单本身的数量 / 价格照常显示（排除「整张卡都是 —」的恒真）。
  await expect(inOrder(page, 'qty-price')).toHaveText('50 股 / 49.10');
  await expect(inOrder(page, 'status')).toHaveText('已撤单');
  await expect(inOrder(page, 'side')).toHaveText('卖出');
});

test('083 T018⑤ 组合单 ⇒ 两个腿码可见、数量单位为张、未知订单类型原样显示（sb 31 / US2-AS6）', async ({
  page,
}) => {
  await installOrderDetailMock(page, newOrderServer(ZQY_COMBO_ORDER));
  await gotoOrderDetail(page, ZQY_COMBO_ORDER.id);

  await expect(inOrder(page, 'legs')).toBeVisible({ timeout: 30_000 });
  await expect(inOrder(page, 'leg-0')).toHaveText('ZQY261016C55000');
  await expect(inOrder(page, 'leg-1')).toHaveText('ZQY261016C60000');
  await expect(inOrder(page, 'qty-price')).toHaveText('1 张 / 0.85');
  await expect(inOrder(page, 'order-type')).toHaveText('MARKET');
});

test('083 T018⑥ 首次即 404 ⇒「订单不存在」，不是错误态（sb 45）', async ({ page }) => {
  await installOrderDetailMock(page, newOrderServer());
  await gotoOrderDetail(page, ZQY_FILLED_ORDER.id);

  await expect(inOrder(page, 'not-found')).toBeVisible({ timeout: 30_000 });
  await expect(orderRoot(page).getByText('订单不存在', { exact: true })).toBeVisible();
  await expect(inOrder(page, 'error')).toHaveCount(0);
  await expect(inOrder(page, 'fields')).toHaveCount(0);
});

test('083 T018⑦ 首次 500 ⇒「加载失败 + 重试」；恢复后点重试 ⇒ 字段（sb 46）', async ({ page }) => {
  const server = newOrderServer(ZQY_FILLED_ORDER);
  server.healthy = false;
  await installOrderDetailMock(page, server);
  await gotoOrderDetail(page, ZQY_FILLED_ORDER.id);

  await expect(inOrder(page, 'error')).toBeVisible({ timeout: 30_000 });
  await expect(orderRoot(page).getByText('加载失败', { exact: true })).toBeVisible();
  await expect(inOrder(page, 'fields')).toHaveCount(0);

  server.healthy = true;
  await inOrder(page, 'retry').tap();
  await expect(inOrder(page, 'fields')).toBeVisible({ timeout: 30_000 });
  await expect(inOrder(page, 'error')).toHaveCount(0);
});

test('083 T018⑧ 订单详情无「撤单 / 改单 / 平仓」字样、无任何按钮（FR-019）', async ({ page }) => {
  await installOrderDetailMock(page, newOrderServer(ZQY_FILLED_ORDER));
  await gotoOrderDetail(page, ZQY_FILLED_ORDER.id);

  // 对照：屏内文本可被查到（排除「根节点下什么都没有」的恒真）。
  await expect(orderRoot(page).getByText('全部成交', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(orderRoot(page).getByText(/撤单|改单|平仓/)).toHaveCount(0);
  await expect(orderRoot(page).getByRole('button')).toHaveCount(0);
});

test('083 T018⑨ 下单时间的时区标签由响应 market 决定（美股 ⇒ 美东、港股 ⇒ 香港）', async ({
  page,
}) => {
  await installOrderDetailMock(page, newOrderServer(ZQY_FILLED_ORDER, HK_SHORT_PUT_ORDER));

  await gotoOrderDetail(page, ZQY_FILLED_ORDER.id);
  await expect(inOrder(page, 'created-at-sub')).toHaveText('16:52:07（美东）', { timeout: 30_000 });

  await gotoOrderDetail(page, HK_SHORT_PUT_ORDER.id);
  await expect(inOrder(page, 'created-at-sub')).toHaveText('14:05:12（香港）', { timeout: 30_000 });
  await expect(inOrder(page, 'created-at')).toHaveText('2026/09/08');
  await expect(inOrder(page, 'side')).toHaveText('卖空');
  await expect(inOrder(page, 'name')).toHaveText('示例汽车 沽');
  await expect(inOrder(page, 'name-sub')).toHaveText('261029 7.25');
  await expect(inOrder(page, 'amount')).toHaveText('990.00 HKD');
});

test('083 T018⑩ 订单详情下拉 ⇒ 订单详情端点命中 +1（sb 14 下钻面）', async ({ page }) => {
  const log = observeRequests(page);
  await installOrderDetailMock(page, newOrderServer(ZQY_FILLED_ORDER));
  await gotoOrderDetail(page, ZQY_FILLED_ORDER.id);
  await expect(inOrder(page, 'fields')).toBeVisible({ timeout: 30_000 });
  const before = log.hits(ORDER_DETAIL_RE);

  await pullToRefresh(inOrder(page, 'refresh'));

  await expect.poll(() => log.hits(ORDER_DETAIL_RE), { timeout: 30_000 }).toBe(before + 1);
  await expect(inOrder(page, 'fields')).toBeVisible();
});

test('083 T018⑪ 订单详情已显示后下拉、响应 500 ⇒ 字段仍可见 + 顶部刷新失败提示（sb 43 / FR-023）', async ({
  page,
}) => {
  const server = newOrderServer(ZQY_FILLED_ORDER);
  await installOrderDetailMock(page, server);
  await gotoOrderDetail(page, ZQY_FILLED_ORDER.id);
  await expect(inOrder(page, 'fields')).toBeVisible({ timeout: 30_000 });

  server.healthy = false;
  await pullToRefresh(inOrder(page, 'refresh'));

  await expect(inOrder(page, 'refetch-failed')).toHaveText('刷新失败，显示的是上次加载的数据', {
    timeout: 30_000,
  });
  await expect(inOrder(page, 'fields')).toBeVisible();
  await expect(inOrder(page, 'error')).toHaveCount(0);
  await expect(inOrder(page, 'not-found')).toHaveCount(0);
});

test('083 T018⑫ 订单详情已显示后下拉、响应 404 ⇒「订单不存在」替换旧数据（sb 45 / FR-020）', async ({
  page,
}) => {
  const server = newOrderServer(ZQY_FILLED_ORDER);
  await installOrderDetailMock(page, server);
  await gotoOrderDetail(page, ZQY_FILLED_ORDER.id);
  await expect(inOrder(page, 'fields')).toBeVisible({ timeout: 30_000 });

  // 服务端状态事件：订单的正股被移出锚集（服务端对此与「不存在」同一 404）。
  server.byId.delete(ZQY_FILLED_ORDER.id);
  await pullToRefresh(inOrder(page, 'refresh'));

  await expect(inOrder(page, 'not-found')).toBeVisible({ timeout: 30_000 });
  await expect(inOrder(page, 'fields')).toHaveCount(0);
  await expect(inOrder(page, 'refetch-failed')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// T019 —— 持仓详情批次段 + 批次 / 本合约订单进入订单详情
// ════════════════════════════════════════════════════════════════════════════

function lot(
  openedAtLocal: string,
  orderDbId: string | null,
  originalQty: string,
  remainingQty: string,
  cost: string,
  marketValue: string | null,
  unrealizedPl: string | null,
): BrokerLotResponse {
  return { openedAtLocal, orderDbId, originalQty, remainingQty, cost, marketValue, unrealizedPl };
}

/**
 * 「示例汽车 沽」空头认沽详情（持仓 -3 张）：2 个批次按开仓时间正序 —— 最早批次被买回 1 张后剩 1 / 2，
 * 第二批次 2 / 2（合计 -3 = 持仓 ⇒ 可还原）；4 张本合约订单（含 1 张已撤单），下单时间降序。
 */
const HK_SHORT_PUT_DETAIL: BrokerPositionDetailResponse = {
  ...HK_SHORT_PUT_ROW,
  openedAtLocal: '2026-09-01 10:32:00',
  orders: [
    order('ord-h4', 'BUY_BACK', '1', '0.070', 'FILLED_ALL', '2026-09-10 11:20:00'),
    order('ord-h3', 'SELL_SHORT', '2', '0.099', 'FILLED_ALL', '2026-09-08 14:05:12'),
    order('ord-h2', 'SELL_SHORT', '1', '0.105', 'CANCELLED_ALL', '2026-09-04 09:41:03'),
    order('ord-h1', 'SELL_SHORT', '2', '0.090', 'FILLED_ALL', '2026-09-01 10:32:00'),
  ],
  lots: {
    restorable: true,
    lots: [
      lot('2026-09-01 10:32:00', 'ord-h1', '-2', '-1', '0.090', '-580.00', '-130.00'),
      lot('2026-09-08 14:05:12', 'ord-h3', '-2', '-2', '0.099', '-1160.00', '-170.00'),
    ],
  },
};

/** 同一持仓，但最早批次的开仓成交缺订单号 ⇒ `orderDbId=null`（不可进订单详情）。 */
const HK_SHORT_PUT_DETAIL_NO_ORDER_ID: BrokerPositionDetailResponse = {
  ...HK_SHORT_PUT_DETAIL,
  lots: {
    restorable: true,
    lots: [
      lot('2026-09-01 10:32:00', null, '-2', '-1', '0.090', '-580.00', '-130.00'),
      lot('2026-09-08 14:05:12', 'ord-h3', '-2', '-2', '0.099', '-1160.00', '-170.00'),
    ],
  },
};

/** 本合约订单里的买回单（= `HK_SHORT_PUT_DETAIL` 订单段的 `ord-h4`）。 */
const HK_BUY_BACK_ORDER: BrokerOrderDetailResponse = {
  ...HK_SHORT_PUT_ORDER,
  id: 'ord-h4',
  side: 'BUY_BACK',
  qty: '1',
  price: '0.070',
  amount: '350.00',
  dealtQty: '1',
  dealtAvgPrice: '0.070',
  dealtAmount: '350.00',
  createdAtLocal: '2026-09-10 11:20:00',
};

const HK_TAB = 'optionsdesk-trading-account-market-tab-hk';

test('083 T019① 点期权合约行 ⇒ 汇总 → 2 个批次（开仓时间正序）→ 本合约订单（sb 25 / US2-AS1 / US2-AS7）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED, HK_SHORT_PUT));
  await installPositionDetailMock(page, newDetailServer(HK_SHORT_PUT_DETAIL));
  await gotoTradingAccount(page);
  await page.getByTestId(HK_TAB).tap();
  await expect(positionRow(page, HK_SHORT_PUT_ROW.id)).toBeVisible({ timeout: 30_000 });
  await positionRow(page, HK_SHORT_PUT_ROW.id).tap();

  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });
  await expect(inDetail(page, 'name')).toHaveText('示例汽车 沽');
  await expect(inDetail(page, 'lots-title')).toHaveText('持仓批次');
  await expect(inDetail(page, 'lots-count')).toHaveText('2 个 · 先开先平');
  await expect(inDetail(page, 'lot-0-time')).toHaveText('26-09-01 10:32（香港）');
  await expect(inDetail(page, 'lot-1-time')).toHaveText('26-09-08 14:05（香港）');
  await expect(inDetail(page, 'lot-0-market-value')).toHaveText('-580.00');
  await expect(inDetail(page, 'lot-0-pl')).toHaveText('-130.00');
  await expect(inDetail(page, 'orders-title')).toHaveText('本合约订单');
  for (const { id } of HK_SHORT_PUT_DETAIL.orders) {
    await expect(inDetail(page, `order-${id}`)).toBeVisible();
  }

  // 段序：汇总 → 批次 → 订单（FR-013）。
  const top = async (suffix: string) =>
    (await inDetail(page, suffix).boundingBox())?.y ?? Number.NaN;
  expect(await top('lots')).toBeGreaterThan(await top('summary'));
  expect(await top('orders-title')).toBeGreaterThan(await top('lots'));
});

test('083 T019②③ 被买回扣减的批次「剩余 1 / 2」、只 2 个批次无第三行；正股无批次段（sb 27, 28 / US2-AS2）', async ({
  page,
}) => {
  await installPositionDetailMock(page, newDetailServer(HK_SHORT_PUT_DETAIL, ZQY_STOCK_DETAIL));
  await gotoPositionDetail(page, HK_SHORT_PUT_DETAIL.id);

  await expect(inDetail(page, 'lot-0-qty')).toHaveText('剩余 1 / 2 张 · 成本 0.090', {
    timeout: 30_000,
  });
  await expect(inDetail(page, 'lot-1-qty')).toHaveText('剩余 2 / 2 张 · 成本 0.099');
  await expect(inDetail(page, 'lot-2')).toHaveCount(0);

  await gotoPositionDetail(page, ZQY_STOCK_DETAIL.id);
  await expect(inDetail(page, 'summary')).toBeVisible({ timeout: 30_000 });
  await expect(inDetail(page, 'lots')).toHaveCount(0);
  await expect(inDetail(page, 'lots-unrestorable')).toHaveCount(0);
});

test('083 T019④ restorable=false ⇒「批次无法还原」、批次行不渲染、本合约订单照常（sb 30 / US2-AS4）', async ({
  page,
}) => {
  await installPositionDetailMock(page, newDetailServer(ZQR_CALL_DETAIL));
  await gotoPositionDetail(page, ZQR_CALL_DETAIL.id);

  await expect(inDetail(page, 'lots-unrestorable')).toBeVisible({ timeout: 30_000 });
  await expect(detailRoot(page).getByText('批次无法还原', { exact: true })).toBeVisible();
  await expect(inDetail(page, 'lot-0')).toHaveCount(0);
  await expect(inDetail(page, 'orders-title')).toHaveText('本合约订单');
  await expect(inDetail(page, 'order-ord-9')).toBeVisible();
});

test('083 T019⑤ orderDbId=null 的批次无 ›、点击不跳转；有订单号的批次可进（sb 32）', async ({
  page,
}) => {
  await installPositionDetailMock(page, newDetailServer(HK_SHORT_PUT_DETAIL_NO_ORDER_ID));
  await installOrderDetailMock(page, newOrderServer(HK_SHORT_PUT_ORDER));
  await gotoPositionDetail(page, HK_SHORT_PUT_DETAIL_NO_ORDER_ID.id);

  await expect(inDetail(page, 'lot-0')).toBeVisible({ timeout: 30_000 });
  await expect(inDetail(page, 'lot-0-chevron')).toHaveCount(0);
  await expect(inDetail(page, 'lot-0')).not.toHaveAttribute('role', 'button');
  await expect(inDetail(page, 'lot-1-chevron')).toBeVisible();

  await inDetail(page, 'lot-0').tap();
  await expect(page).toHaveURL(/\/optionsdesk\/trading-account-position\/hk-08801-put$/);
  await expect(orderRoot(page)).toHaveCount(0);

  // 对照：同屏有订单号的批次点击确实会跳（排除「整段都不可点」的恒真）。
  await inDetail(page, 'lot-1').tap();
  await expect(inOrder(page, 'fields')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/optionsdesk\/trading-account-order\/ord-h3$/);
});

test('083 T019⑥ 列表 → 期权行 → 批次（恰 2 次点击）⇒ 订单详情（sb 33 / SC-004）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED, HK_SHORT_PUT));
  await installPositionDetailMock(page, newDetailServer(HK_SHORT_PUT_DETAIL));
  await installOrderDetailMock(page, newOrderServer(HK_SHORT_PUT_ORDER));
  await gotoTradingAccount(page);
  // 选港股页签是列表本身的状态（不是下钻点击）；计数从港股持仓列表起。
  await page.getByTestId(HK_TAB).tap();

  const taps = await tapThrough([positionRow(page, HK_SHORT_PUT_ROW.id), inDetail(page, 'lot-1')]);

  expect(taps).toBe(2);
  await expect(inOrder(page, 'fields')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/optionsdesk\/trading-account-order\/ord-h3$/);
  await expect(inOrder(page, 'side')).toHaveText('卖空');
});

test('083 T019⑦ 列表 → 期权行 →「本合约订单」项（恰 2 次点击）⇒ 订单详情（SC-004 第三条路径）', async ({
  page,
}) => {
  await installPositionsMock(page, newServer(US_GROUPED, HK_SHORT_PUT));
  await installPositionDetailMock(page, newDetailServer(HK_SHORT_PUT_DETAIL));
  await installOrderDetailMock(page, newOrderServer(HK_BUY_BACK_ORDER));
  await gotoTradingAccount(page);
  await page.getByTestId(HK_TAB).tap();

  const taps = await tapThrough([
    positionRow(page, HK_SHORT_PUT_ROW.id),
    inDetail(page, 'order-ord-h4'),
  ]);

  expect(taps).toBe(2);
  await expect(inOrder(page, 'fields')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/optionsdesk\/trading-account-order\/ord-h4$/);
  await expect(inOrder(page, 'side')).toHaveText('买回');
});

// ════════════════════════════════════════════════════════════════════════════
// T020 —— 冷启动结局页券商历史状态行（深链进冷启动结局页）
// ════════════════════════════════════════════════════════════════════════════

const COLD_START_DEEP_LINK = '/optionsdesk/anchor-cold-start';
const SUBMISSIONS_RE = /\/api\/v1\/optionsdesk\/anchor-submissions(\?|$)/;
const COLD_START_RE = /\/api\/v1\/marketdata\/anchor-cold-start(\?|$)/;
const BACKFILL_RUNS_RE = /\/api\/v1\/optionsdesk\/broker-backfill-runs(\?|$)/;

/** 冷启动结局（canonical）。🚨 `anchorId` 与 ticker 刻意不同形 ⇒ 按 anchorId 合并必然一条都对不上。 */
const COLD_START_RUNS: AnchorColdStartRunResponse[] = [
  {
    anchorId: '9001',
    ticker: 'us:ZQX',
    outcome: 'backfilled',
    reason: null,
    targetSession: '2026-09-14',
    lastRunAt: '2026-09-15T01:00:00.000Z',
    needsAttention: false,
  },
  {
    anchorId: '9002',
    ticker: 'us:ZQY',
    outcome: 'no_option_chain',
    reason: null,
    targetSession: '2026-09-14',
    lastRunAt: '2026-09-15T01:01:00.000Z',
    needsAttention: false,
  },
  {
    anchorId: '9003',
    ticker: 'hk:08801',
    outcome: 'backfilled',
    reason: null,
    targetSession: '2026-09-15',
    lastRunAt: '2026-09-15T01:02:00.000Z',
    needsAttention: false,
  },
];

/** 待审箱 CONSUMED 行：每只新锚一条，`consumedAnchorId` 指向对应锚（冷启动页由它得出「本批新锚」）。 */
function consumedSubmission(
  run: AnchorColdStartRunResponse,
  index: number,
): AnchorSubmissionReviewResponse {
  return {
    id: String(100 + index),
    submitter: 'e2e-083',
    ticker: run.ticker,
    instrumentName: null,
    market: run.ticker.startsWith('hk:') ? 'hk' : 'us',
    v: '1.0000',
    asof: '2026-09-12',
    method: 'dcf',
    confidence: '6.00',
    note: null,
    reviewNote: null,
    status: 'CONSUMED',
    consumedAnchorId: run.anchorId,
    disposition: 'create',
    asofFlag: 'OK',
    asofSuggested: null,
    asofNeedsAck: false,
    createdAt: '2026-09-14T02:00:00.000Z',
    updatedAt: '2026-09-14T02:00:00.000Z',
  };
}

/** 补齐记录（canonical）：ZQX 成功、08801 执行中、ZQY 无记录。 */
const BACKFILL_RUNS: BrokerBackfillRunResponse[] = [
  {
    ticker: 'us:ZQX',
    status: 'succeeded',
    at: '2026-09-14T20:05:12.000Z',
    atLocal: '2026-09-14 16:05:12',
  },
  {
    ticker: 'hk:08801',
    status: 'running',
    at: '2026-09-15T01:00:00.000Z',
    atLocal: '2026-09-15 09:00:00',
  },
];

interface BackfillRunsServer {
  /** false ⇒ 补齐状态端点 500。 */
  healthy: boolean;
  runs: BrokerBackfillRunResponse[];
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/**
 * 冷启动页三个端点的 mock，均为 `(请求参数, canonical 状态) → 响应` 纯函数：
 * 待审箱按 `status` 过滤；冷启动结局按 `anchorIds` 过滤；补齐状态按 `tickers` 请求顺序、无记录不出现（同 server）。
 */
async function installColdStartMocks(page: Page, backfill: BackfillRunsServer): Promise<void> {
  const submissions = COLD_START_RUNS.map(consumedSubmission);
  const preflightOrGet = async (
    route: Route,
    onGet: (params: URLSearchParams) => Promise<void>,
  ) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void (await route.fulfill({ status: 204, headers: CORS }));
    }
    if (req.method() !== 'GET') return void (await route.fallback());
    await onGet(new URL(req.url()).searchParams);
  };

  await page.route(SUBMISSIONS_RE, (route) =>
    preflightOrGet(route, async (params) => {
      const status = params.get('status');
      const items = submissions.filter((s) => status === null || s.status === status);
      await fulfillJson(route, 200, { items, total: items.length, truncated: false });
    }),
  );
  await page.route(COLD_START_RE, (route) =>
    preflightOrGet(route, async (params) => {
      const ids = (params.get('anchorIds') ?? '').split(',');
      await fulfillJson(route, 200, {
        items: COLD_START_RUNS.filter((run) => ids.includes(run.anchorId)),
      });
    }),
  );
  await page.route(BACKFILL_RUNS_RE, (route) =>
    preflightOrGet(route, async (params) => {
      if (!backfill.healthy) {
        return void (await fulfillJson(route, 500, {
          status: 500,
          title: 'Internal Server Error',
        }));
      }
      const byTicker = new Map(backfill.runs.map((run) => [run.ticker, run]));
      const tickers = (params.get('tickers') ?? '').split(',');
      await fulfillJson(
        route,
        200,
        tickers.flatMap((ticker) => byTicker.get(ticker) ?? []),
      );
    }),
  );
}

async function gotoColdStart(page: Page): Promise<void> {
  await page.goto(COLD_START_DEEP_LINK);
  await expect(page.getByTestId('optionsdesk-cold-start-list')).toBeVisible({ timeout: 90_000 });
}

/** 券商历史行，限定在该 ticker 的结局行内（按 ticker 合并：行挂错位置也算红）。 */
function backfillLine(page: Page, ticker: string): Locator {
  return page
    .getByTestId(`optionsdesk-cold-start-row-${ticker}`)
    .getByTestId(`optionsdesk-cold-start-broker-backfill-${ticker}`);
}

test('083 T020① 有成功记录 ⇒「券商历史 · 成功」+ 时刻；执行中同样带状态与时刻（sb 41 / US4-AS1）', async ({
  page,
}) => {
  await installColdStartMocks(page, { healthy: true, runs: BACKFILL_RUNS });
  await gotoColdStart(page);

  await expect(backfillLine(page, 'us:ZQX')).toHaveText('券商历史 · 成功 · 09-14 16:05（美东）', {
    timeout: 30_000,
  });
  await expect(backfillLine(page, 'hk:08801')).toHaveText(
    '券商历史 · 执行中 · 09-15 09:00（香港）',
  );
});

test('083 T020② 无补齐记录 ⇒「券商历史 · 未触发」（sb 42 / US4-AS2）', async ({ page }) => {
  await installColdStartMocks(page, { healthy: true, runs: BACKFILL_RUNS });
  await gotoColdStart(page);

  await expect(backfillLine(page, 'us:ZQY')).toHaveText('券商历史 · 未触发', { timeout: 30_000 });
  await expect(page.getByTestId('optionsdesk-cold-start-outcome-us:ZQY')).toHaveText(
    'no_option_chain',
  );
});

test('083 T020③ 补齐状态端点 500 ⇒ 券商历史行不出现、冷启动结局照常（sb 47）', async ({ page }) => {
  const log = observeRequests(page);
  await installColdStartMocks(page, { healthy: false, runs: BACKFILL_RUNS });
  await gotoColdStart(page);

  // 全局 query `retry: 1`（`src/core/api/query-client.ts`）⇒ 第 2 次 500 之后该请求进入失败态。
  await expect
    .poll(() => log.hits(BACKFILL_RUNS_RE), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  for (const run of COLD_START_RUNS) {
    await expect(page.getByTestId(`optionsdesk-cold-start-outcome-${run.ticker}`)).toHaveText(
      run.outcome,
    );
  }
  await expect(page.getByTestId('optionsdesk-cold-start-list').getByText(/券商历史/)).toHaveCount(
    0,
  );
  await expect(page.getByTestId('optionsdesk-cold-start-retry')).toHaveCount(0);
});

test('083 T020④ 补齐状态请求的 tickers 参数 = 冷启动结局的 ticker 集合', async ({ page }) => {
  const log = observeRequests(page);
  await installColdStartMocks(page, { healthy: true, runs: BACKFILL_RUNS });
  await gotoColdStart(page);

  await expect(backfillLine(page, 'us:ZQX')).toBeVisible({ timeout: 30_000 });
  const urls = log.apiUrls.filter((url) => BACKFILL_RUNS_RE.test(url));
  expect(urls.length).toBeGreaterThan(0);
  const expected = COLD_START_RUNS.map((run) => run.ticker).sort();
  for (const url of urls) {
    const tickers = (new URL(url).searchParams.get('tickers') ?? '').split(',').sort();
    expect(tickers).toEqual(expected);
  }
});
