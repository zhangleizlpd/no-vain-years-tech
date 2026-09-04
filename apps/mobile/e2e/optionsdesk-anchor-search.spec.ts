import { expect, test, type Page, type Route } from './_support/fixtures';
import type { AnchorResponse } from '@nvy/api-client';

import { mockJson } from './_support/api-mock';

// 074 — 雷达锚搜索 hermetic UI e2e（Playwright Expo Web，Constitution §V 两层验证之一）。
//
// 覆盖（逐条对应 tasks.md）：
//   T007-① 点 🔍 开浮层；**未输入时结果区真空白**（无空态文案、无 spinner —— sb-1 的 e2e 半边，
//          「没搜过 ≠ 搜不到」）
//   T007-② 取消 / 遮罩关闭浮层
//   T007-③ 关闭后雷达页签与已选筛选 chips 原状（sb-9）
//   T008-① 「阿里」双市场两行三字段，行内无行情数值；excluded 照常命中零标记（sb-3/6）
//   T008-② 零命中空态主副两行，结果区**无任何按钮**（sb-4 零 CTA）
//   T008-③ 500 → 浮层内错误行 + 重试点通重取（sb-7）
//   T008-④ 点行 → 关浮层 + 落 underlying 路由（sb-8）
//   T008-⑤ 连续输入防抖：只发最后一次；开浮层未输入零请求；清空后旧词结果不闪回（sb-1/2）
//   T008-⑥ hk 页签 + L1 筛选下搜出美股 L3 锚（sb-10 UI 半边）
//
// ── hermetic mock 纪律（同 golden optionsdesk-anchors-radar.spec.ts）──────────
//   handler = `(request, canonical 锚集合) → response` 纯函数：市场作用域 / 筛选 / 空态四分
//   按 server 口径复算，**禁**按测试编排标志分支；场景差异靠传入不同 canonical 集合表达。
//
// ── auth 范式 ────────────────────────────────────────────────────────────────
//   seed localStorage → boot GET /me 必拦；refresh-token 也必拦（003 拦截器误登出）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;

const SEED_ACCOUNT_ID = 'acc-e2e-074';
const SEED_ACCESS_TOKEN = 'access-e2e-074';
const SEED_REFRESH_TOKEN = 'refresh-e2e-074';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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
        displayName: '小明',
        phone: '+8613900139074',
      },
      version: 0,
    }),
  );
`;

/** 本地日历日 —— 只作 fixture 的 asOf 取值（新鲜度档由 mock 的 `quoteFreshnessTier` 显式给）。 */
const TODAY = (() => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
})();

// ════════════════════════════════════════════════════════════════════════════
// canonical 锚集合（= 服务端 DB 内容的镜像；base 体例同 golden radar spec）
// ════════════════════════════════════════════════════════════════════════════

const ANCHOR_BASE: Omit<AnchorResponse, 'id' | 'ticker'> = {
  name: null,
  v: '100.00',
  vModel: '100.00',
  asof: '2026-07-01',
  method: 'DCF',
  confidence: '8.0',
  confidenceSource: 'manual',
  excluded: false,
  excludeReason: null,
  nextReview: '2026-12-31',
  lastReviewedOn: '2026-07-01',
  overdue: false,
  overdueAgainstAsof: false,
  lLevelEffective: 'L2',
  positionCap: '0.0500',
  w: '80.00',
  zoneFloor: '60.00',
  zoneCeiling: '120.00',
  willingSellLongHold: '120.00',
  willingSellRent: '100.00',
  zone: 'buy',
  lastClose: '88.00',
  lastCloseDate: TODAY,
  quoteFreshnessTier: 'CURRENT',
  spot: '88.00',
  priceKind: 'eod_close',
  spotAsOf: TODAY,
  distanceToWPct: '10.0',
  breachStartedOn: null,
  reviewFlagOn: false,
  vIsManual: false,
  lLevelIsManual: false,
  positionCapIsManual: false,
  vManual: null,
  lLevelManual: null,
  positionCapManual: null,
  derivedLLevel: 'L2',
  derivedPositionCap: '0.0500',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

function makeAnchor(
  over: Partial<AnchorResponse> & Pick<AnchorResponse, 'id' | 'ticker'>,
): AnchorResponse {
  return { ...ANCHOR_BASE, ...over };
}

/** 跌破 W（行情不可用不计入，server `belowW` 口径；闸看 `spotAsOf`）。 */
function isBelowW(a: AnchorResponse): boolean {
  if (a.spotAsOf === null || a.distanceToWPct === null) return false;
  return Number.parseFloat(a.distanceToWPct) < 0;
}

const EMPTY_STATE_MESSAGES = {
  zero_anchors: '还没有锚 —— 先去锚管理建第一个锚',
  zero_anchors_in_market: '这个市场还没有锚 —— 换个市场看看',
  filtered_empty: '当前筛选无结果',
  all_idle: '今日无解，空仓是常态',
} as const;

interface OptionsdeskSearchMock {
  /** 每次 `GET /anchors/search` 的 `q`（按到达序）—— 防抖 / enabled 门的机械观测面。 */
  searchRequests: () => readonly string[];
  /** 搜索链路故障开关（canonical 状态，同 golden spec `setDistance` 体例）：true ⇒ 恒 500。 */
  setSearchDown: (down: boolean) => void;
}

/**
 * 期权台 hermetic mock：
 *  · `GET /radar` 按 server 口径复算（作用域 / 筛选 / 空态四分 / 距 W 升序）。fixture 恒小于
 *    一页 ⇒ 单页返回（分页契约归 golden radar spec，此处不重验）。
 *  · `GET /anchors/search` 按 server 口径复算（074 D3）：域 = 全部锚**含 excluded**、跨市场
 *    不吃页签 / 筛选参数；四路匹配（代码前缀 / 全 ticker 前缀 / 名与拼音子串）；代码精确
 *    命中排第一 → 代码序；LIMIT 20。trgm 相似路不镜像（容错字行为归 server IT）。
 *  · `GET /underlyings/:sym` 恒 404 —— 行点击后详情屏的取数；本 spec 只验「落到 underlying
 *    路由」，详情屏行为归 046/047 spec。给 404 保 hermetic（fallback 会泄漏 :3000）。
 */
async function installOptionsdeskMock(
  page: Page,
  seed: AnchorResponse[],
  pinyin: Record<string, { abbr: string; full: string }> = {},
): Promise<OptionsdeskSearchMock> {
  const anchors = seed.map((a) => ({ ...a }));
  const searchCalls: string[] = [];
  let searchDown = false;

  await page.route(OPTIONSDESK_RE, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));

    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });

    // ── GET /optionsdesk/anchors/search（074；声明序无关 —— 这里按最长路径先判）──
    if (url.pathname.endsWith('/optionsdesk/anchors/search')) {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64);
      searchCalls.push(q);
      if (searchDown) return void (await json(500, { code: 'INTERNAL' }));
      if (q.length === 0) return void (await json(200, { items: [] }));
      const lower = q.toLowerCase();
      const codeOf = (t: string) => t.split(':')[1] ?? '';
      // 域 = 全部锚（**含 excluded**，FR-004）；无 market / L 级参数可吃（FR-005）。
      const hits = anchors.filter((a) => {
        const code = codeOf(a.ticker);
        const name = a.name ?? code;
        const py = pinyin[a.ticker];
        return (
          code.toLowerCase().startsWith(lower) ||
          a.ticker.toLowerCase().startsWith(lower) ||
          name.includes(q) ||
          (py !== undefined &&
            (py.abbr.toLowerCase().includes(lower) || py.full.toLowerCase().includes(lower)))
        );
      });
      const items = [...hits]
        .sort((x, y) => {
          const ex = codeOf(x.ticker).toLowerCase() === lower ? 0 : 1;
          const ey = codeOf(y.ticker).toLowerCase() === lower ? 0 : 1;
          if (ex !== ey) return ex - ey;
          return codeOf(x.ticker).localeCompare(codeOf(y.ticker));
        })
        .slice(0, 20)
        .map((a) => ({
          ticker: a.ticker,
          name: a.name ?? codeOf(a.ticker),
          lLevelEffective: a.lLevelEffective,
        }));
      return void (await json(200, { items }));
    }

    // ── GET /optionsdesk/underlyings/:sym —— 行点击后的详情屏取数，见函数头注释。──
    if (url.pathname.includes('/optionsdesk/underlyings/'))
      return void (await json(404, { code: 'ANCHOR_NOT_FOUND' }));

    if (url.pathname.endsWith('/optionsdesk/radar')) {
      const lLevels = new Set(
        url.searchParams
          .getAll('lLevels')
          .flatMap((v) => v.split(','))
          .filter(Boolean),
      );
      const pendingReview = url.searchParams.get('pendingReview') === 'true';
      const belowW = url.searchParams.get('belowW') === 'true';
      const market = url.searchParams.get('market');

      const allBase = anchors.filter((a) => !a.excluded);
      const base = allBase.filter((a) => market === null || a.ticker.startsWith(`${market}:`));
      const filtered = base.filter(
        (a) =>
          (lLevels.size === 0 || lLevels.has(a.lLevelEffective)) &&
          (!pendingReview || a.overdue) &&
          (!belowW || isBelowW(a)),
      );
      const actionable = filtered.filter(isBelowW);
      const marketCounts = [...new Set(allBase.map((a) => a.ticker.split(':')[0] ?? ''))].map(
        (m) => {
          const rows = allBase.filter((a) => a.ticker.startsWith(`${m}:`));
          return {
            market: m,
            baseTotal: rows.length,
            actionableTotal: rows.filter(isBelowW).length,
          };
        },
      );
      const emptyState =
        allBase.length === 0
          ? 'zero_anchors'
          : base.length === 0
            ? 'zero_anchors_in_market'
            : filtered.length === 0
              ? 'filtered_empty'
              : actionable.length === 0
                ? 'all_idle'
                : null;
      const items = [...filtered].sort((x, y) => {
        const dx =
          x.distanceToWPct === null
            ? Number.POSITIVE_INFINITY
            : Number.parseFloat(x.distanceToWPct);
        const dy =
          y.distanceToWPct === null
            ? Number.POSITIVE_INFINITY
            : Number.parseFloat(y.distanceToWPct);
        return dx - dy;
      });
      return void (await json(200, {
        items,
        nextCursor: null,
        hasMore: false,
        emptyState,
        emptyStateMessage: emptyState === null ? null : EMPTY_STATE_MESSAGES[emptyState],
        marketCounts,
      }));
    }

    await route.fallback();
  });

  return {
    searchRequests: () => searchCalls,
    setSearchDown: (down) => {
      searchDown = down;
    },
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
      phone: '+8613900139074',
      displayName: '小明',
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
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

test.setTimeout(120_000);

/** 进期权台 tab（首发吃 Metro 冷打包 ⇒ 长超时锚在 tab bar）。 */
async function gotoOptionsdesk(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '期权台' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '期权台' }).tap();
  await expect(page.getByTestId('optionsdesk-radar-search-button')).toBeVisible({
    timeout: 30_000,
  });
}

/** 开浮层（题头 🔍 → sheet 可见）。 */
async function openSearchSheet(page: Page): Promise<void> {
  await page.getByTestId('optionsdesk-radar-search-button').tap();
  await expect(page.getByTestId('optionsdesk-anchor-search-sheet')).toBeVisible({
    timeout: 15_000,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// T007 — 题头入口 + 浮层骨架
// ════════════════════════════════════════════════════════════════════════════

test('074 T007-① 点 🔍 开浮层：搜索框就绪；未输入时结果区真空白 —— 无空态文案、无 spinner（sb-1）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', name: 'A.O.史密斯' }),
  ]);
  await gotoOptionsdesk(page);
  await openSearchSheet(page);

  // 搜索框就绪可输入（US1-AS1）。
  await expect(page.getByTestId('optionsdesk-anchor-search-input')).toBeVisible();

  // sb-1 的 e2e 半边：结果区**真空白**。逐个点名不许出现的东西 —— 空态主副两行文案、
  // loading 行、错误行、任何提示行（「没搜过」时它们全都不许在）。
  const sheet = page.getByTestId('optionsdesk-anchor-search-sheet');
  await expect(sheet.getByText('没有匹配的锚')).toHaveCount(0);
  await expect(sheet.getByText('只能搜到已建锚的标的')).toHaveCount(0);
  await expect(sheet.getByText('搜索中…')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-anchor-search-empty')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-anchor-search-loading')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-anchor-search-error')).toHaveCount(0);
  await expect(page.locator('[data-testid^="optionsdesk-anchor-search-row-"]')).toHaveCount(0);
  // 兜底断言：结果区容器整体零文本（上面的点名防「换个字眼溜进来」，这条防「没点到名的」）。
  await expect(page.getByTestId('optionsdesk-anchor-search-results')).toHaveText('');
});

test('074 T007-② 取消与遮罩都关得掉浮层，关态零残留', async ({ page }) => {
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', name: 'A.O.史密斯' }),
  ]);
  await gotoOptionsdesk(page);

  // 取消关。
  await openSearchSheet(page);
  await page.getByTestId('optionsdesk-anchor-search-cancel').tap();
  await expect(page.getByTestId('optionsdesk-anchor-search-sheet')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-anchor-search-backdrop')).toHaveCount(0);

  // 遮罩关（sheet 盖住下半屏 ⇒ 必须点上方露出带，同抽屉遮罩体例）。
  await openSearchSheet(page);
  const backdrop = page.getByTestId('optionsdesk-anchor-search-backdrop');
  const box = await backdrop.boundingBox();
  if (!box) throw new Error('遮罩尺寸不可得');
  await backdrop.tap({ position: { x: box.width / 2, y: 30 } });
  await expect(page.getByTestId('optionsdesk-anchor-search-sheet')).toHaveCount(0);

  // 关掉后底层屏立刻可交互（遮罩零残留拦截 pointer）—— 再开一次证明开关可反复。
  await openSearchSheet(page);
});

test('074 T007-③ 关闭浮层后雷达原状：hk 页签 + L3 筛选组合保持（sb-9）', async ({ page }) => {
  // hk 无 L3 锚而 us 有 ⇒ 「hk 页签 + L3 筛选」唯一地渲出 filtered_empty：
  // 若关浮层把页签重置回 us，us:PEP（L3）行会冒出来；若把筛选清了，hk:00700 行会回来。
  // 这个空态的**存续**同时钉住两个维度 —— 比读 chips 选中态更机械（RNW 不渲 accessibilityState）。
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', name: 'A.O.史密斯', lLevelEffective: 'L2' }),
    makeAnchor({ id: '2', ticker: 'us:PEP', name: '百事', lLevelEffective: 'L3' }),
    makeAnchor({ id: '3', ticker: 'hk:00700', name: '腾讯控股', lLevelEffective: 'L2' }),
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 30_000 });

  // 切 hk 页签 + 选 L3 筛选 → 筛选无结果空态。
  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  await expect(page.getByTestId('optionsdesk-radar-row-hk:00700')).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId('optionsdesk-radar-filter-L3').tap();
  await expect(page.getByTestId('optionsdesk-radar-empty-filtered')).toBeVisible({
    timeout: 20_000,
  });

  // 开浮层再关。
  await openSearchSheet(page);
  await page.getByTestId('optionsdesk-anchor-search-cancel').tap();
  await expect(page.getByTestId('optionsdesk-anchor-search-sheet')).toHaveCount(0);

  // 雷达原状：仍是「hk + L3」的空态；两个「维度被重置」的症状行都不许出现。
  await expect(page.getByTestId('optionsdesk-radar-empty-filtered')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-radar-row-us:PEP')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-row-hk:00700')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// T008 — 结果区五态 + 取数 + 行点击直达
// ════════════════════════════════════════════════════════════════════════════

/** 搜索场景的 canonical 集合：同名跨市场（且 hk 侧 excluded）+ 一只 hk 常规锚。 */
function searchSeed(): AnchorResponse[] {
  return [
    makeAnchor({ id: '1', ticker: 'us:AOS', name: 'A.O.史密斯', lLevelEffective: 'L2' }),
    makeAnchor({ id: '2', ticker: 'us:BABA', name: '阿里巴巴', lLevelEffective: 'L3' }),
    // 交易意愿已关闭：不上雷达列表，但**照常进搜索域**（sb-6 / Clarifications 2026-09-03）。
    makeAnchor({
      id: '3',
      ticker: 'hk:09988',
      name: '阿里巴巴-W',
      lLevelEffective: 'L2',
      excluded: true,
      excludeReason: '暂不交易',
    }),
    makeAnchor({ id: '4', ticker: 'hk:00700', name: '腾讯控股', lLevelEffective: 'L2' }),
  ];
}

const SEARCH_PINYIN: Record<string, { abbr: string; full: string }> = {
  'us:BABA': { abbr: 'albb', full: 'alibaba' },
  'hk:09988': { abbr: 'albb', full: 'alibaba' },
  'hk:00700': { abbr: 'txkg', full: 'tengxunkonggu' },
};

test('074 T008-① 输入「阿里」→ 双市场两行三字段；行内无行情数值；excluded 照常命中零额外标记（sb-3/6）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, searchSeed(), SEARCH_PINYIN);
  await gotoOptionsdesk(page);
  await openSearchSheet(page);

  await page.getByTestId('optionsdesk-anchor-search-input').fill('阿里');
  const babaRow = page.getByTestId('optionsdesk-anchor-search-row-us:BABA');
  await expect(babaRow).toBeVisible({ timeout: 15_000 });
  // 跨市场双命中（无 market 过滤）—— excluded 的 hk 行也在（搜索正是它的主要入口）。
  const hkRow = page.getByTestId('optionsdesk-anchor-search-row-hk:09988');
  await expect(hkRow).toBeVisible();

  // 三字段：名主位 / mono canonical ticker / 生效 L 级徽标（FR-006）。
  await expect(babaRow.getByText('阿里巴巴', { exact: true })).toBeVisible();
  await expect(babaRow.getByText('us:BABA', { exact: true })).toBeVisible();
  await expect(babaRow.getByText('L3', { exact: true })).toBeVisible();

  // 行内**无行情数值**（FR-006 后半）：spot / 距 W 的任何形态都不许在。
  await expect(babaRow.getByText(/88\.00|距 W/)).toHaveCount(0);

  // excluded 行零额外标记（sb-6 UI 半边）：三字段照常，无「排除 / 暂不交易」类字样。
  await expect(hkRow.getByText('阿里巴巴-W', { exact: true })).toBeVisible();
  await expect(hkRow.getByText('L2', { exact: true })).toBeVisible();
  await expect(hkRow.getByText(/排除|暂不交易/)).toHaveCount(0);
});

test('074 T008-② 零命中 → 空态主副两行；结果区无任何按钮（sb-4 零 CTA）', async ({ page }) => {
  await installOptionsdeskMock(page, searchSeed(), SEARCH_PINYIN);
  await gotoOptionsdesk(page);
  await openSearchSheet(page);

  await page.getByTestId('optionsdesk-anchor-search-input').fill('不存在的名字');
  const empty = page.getByTestId('optionsdesk-anchor-search-empty');
  await expect(empty).toBeVisible({ timeout: 15_000 });
  await expect(empty.getByText('没有匹配的锚')).toBeVisible();
  await expect(empty.getByText('只能搜到已建锚的标的')).toBeVisible();

  // 零 CTA：结果区里**一个按钮都不许有**（不提供建锚等旁路，FR-004 / sb-4）。
  const results = page.getByTestId('optionsdesk-anchor-search-results');
  await expect(results.getByRole('button')).toHaveCount(0);
  await expect(results.getByText('去建锚')).toHaveCount(0);
});

test('074 T008-③ 搜索失败 → 浮层内错误行 + 重试点通重取；浮层不关（sb-7）', async ({ page }) => {
  const mock = await installOptionsdeskMock(page, searchSeed(), SEARCH_PINYIN);
  await gotoOptionsdesk(page);
  await openSearchSheet(page);

  mock.setSearchDown(true);
  await page.getByTestId('optionsdesk-anchor-search-input').fill('阿里');
  // react-query retry:1 → 首发 + 1 重试都 500 后才判 error（~1s backoff）。
  const errorRow = page.getByTestId('optionsdesk-anchor-search-error');
  await expect(errorRow).toBeVisible({ timeout: 20_000 });
  await expect(errorRow.getByText('搜索失败')).toBeVisible();
  // 浮层不关、不整屏报错（sb-7）。
  await expect(page.getByTestId('optionsdesk-anchor-search-sheet')).toBeVisible();

  // 链路恢复（canonical 状态翻回）→ 点重试 → 真的重取并渲出命中。
  const failedCalls = mock.searchRequests().length;
  mock.setSearchDown(false);
  await page.getByTestId('optionsdesk-anchor-search-retry').tap();
  await expect(page.getByTestId('optionsdesk-anchor-search-row-us:BABA')).toBeVisible({
    timeout: 15_000,
  });
  expect(mock.searchRequests().length).toBeGreaterThan(failedCalls);
});

test('074 T008-④ 点命中行 → 关浮层 + 直达该标的 underlying 路由（sb-8）', async ({ page }) => {
  await installOptionsdeskMock(page, searchSeed(), SEARCH_PINYIN);
  await gotoOptionsdesk(page);
  await openSearchSheet(page);

  await page.getByTestId('optionsdesk-anchor-search-input').fill('阿里巴巴');
  const babaRow = page.getByTestId('optionsdesk-anchor-search-row-us:BABA');
  await expect(babaRow).toBeVisible({ timeout: 15_000 });
  await babaRow.tap();

  // Modal 关 + 落 underlying 路由（与雷达行同目的地；push 走 encodeURIComponent，web 地址栏
  // 把路径段解码回 `us:BABA` 展示 —— 两种形态都算落对了地方）。
  await expect(page.getByTestId('optionsdesk-anchor-search-sheet')).toHaveCount(0);
  await expect(page).toHaveURL(/\/optionsdesk\/underlying\/us(%3A|:)BABA/, { timeout: 30_000 });
});

test('074 T008-⑤ 防抖：开浮层零请求；连续输入只发最后一次；清空后旧词结果不闪回（sb-1/2）', async ({
  page,
}) => {
  const mock = await installOptionsdeskMock(page, searchSeed(), SEARCH_PINYIN);
  await gotoOptionsdesk(page);
  await openSearchSheet(page);

  // 开浮层、未输入：**零请求**（enabled 门的机械观测面 —— 变异「摘掉 enabled」在此与末断言红）。
  expect(mock.searchRequests()).toHaveLength(0);

  // 逐字连打（间隔 < 250ms 防抖窗）→ 只有最后一次生效。
  await page
    .getByTestId('optionsdesk-anchor-search-input')
    .pressSequentially('阿里巴巴', { delay: 60 });
  await expect(page.getByTestId('optionsdesk-anchor-search-row-us:BABA')).toBeVisible({
    timeout: 15_000,
  });
  expect(mock.searchRequests()).toEqual(['阿里巴巴']);

  // 清空 → 结果区回真空白（旧词结果不许滞留），且不再发请求（空输入不发起，sb-1）。
  await page.getByTestId('optionsdesk-anchor-search-clear').tap();
  await expect(page.locator('[data-testid^="optionsdesk-anchor-search-row-"]')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-anchor-search-results')).toHaveText('');
  expect(mock.searchRequests()).toEqual(['阿里巴巴']);
});

test('074 T008-⑥ hk 页签 + L1 筛选下照常搜出美股 L3 锚（sb-10 UI 半边）', async ({ page }) => {
  await installOptionsdeskMock(page, searchSeed(), SEARCH_PINYIN);
  await gotoOptionsdesk(page);

  // 把雷达镜头收到最窄：hk 页签 + L1 筛选（hk 无 L1 ⇒ 筛选空态）。
  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  await expect(page.getByTestId('optionsdesk-radar-row-hk:00700')).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId('optionsdesk-radar-filter-L1').tap();
  await expect(page.getByTestId('optionsdesk-radar-empty-filtered')).toBeVisible({
    timeout: 20_000,
  });

  // 搜索不吃页签 / 筛选：美股 L3 锚照常命中（sb-10）。
  await openSearchSheet(page);
  await page.getByTestId('optionsdesk-anchor-search-input').fill('阿里巴巴');
  const babaRow = page.getByTestId('optionsdesk-anchor-search-row-us:BABA');
  await expect(babaRow).toBeVisible({ timeout: 15_000 });
  await expect(babaRow.getByText('L3', { exact: true })).toBeVisible();
});
