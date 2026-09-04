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

/**
 * 期权台 hermetic mock —— `GET /radar` 按 server 口径复算（作用域 / 筛选 / 空态四分 /
 * 距 W 升序）。fixture 恒小于一页 ⇒ 单页返回（分页契约归 golden radar spec，此处不重验）。
 */
async function installOptionsdeskMock(page: Page, seed: AnchorResponse[]): Promise<void> {
  const anchors = seed.map((a) => ({ ...a }));

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
