import { expect, test, type Page } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// markets-OFF 合规回归（方向 B，docs/private/plans/2026-06/06-14-markets-feature-gate-mechanism.md）。
//
// ⚠️ 本 spec 只在 markets-OFF bundle 下成立 —— 必经 playwright.markets-off.config.ts
//    （webServer.env 钉 EXPO_PUBLIC_FEATURE_MARKETS=false + 独立端口 4174）。主 e2e 套件
//    （markets-ON）的 testIgnore 已排除它；别在 markets-ON 下跑，会全红。
//    跑法：`nx run mobile:e2e-public`。
//
// 断言三层（对应 06-14 plan §验证 markets OFF 清单 + markets-gate.tsx MARKETS_SURFACES）：
//   1. 入口隐藏：投资 + 期权台 Tab 不在 tab bar / 设置页无投资 Card（证券市场 + 券商账户）。
//   2. deep-link 守卫：MARKETS_SURFACES 全部 11 受控面里的 8 个可路由面，直达 URL 全被
//      MarketsRouteGuard 弹回安全屏（投资/行情/预警/期权台 → /profile；设置子页 → /settings）。
//      面数 8 但深链 11 条 —— optionsdesk 二级页栈是**一个** route-stack 面，栈内四条路由
//      （锚管理 / 温度计 / 标的详情 / 链分析报表）各戳一次，验的是「栈内新增路由自动继承那道
//      守卫」。新增栈内路由时**必须**在这里追一条：那是它继承关系唯一的机械载体。
//   3. 合规核心（最硬）：整个 walkthrough 内**零** marketdata-family 网络请求 —— 公开版
//      绝不向后端拉任何交易所行情/持仓/预警数据（方向 B 的法务底线：避「行情来源授权书」墙）。
//   4. （047 T036 / FR-015）选约区块随期权台一并不可达：判据是**详情屏根本没挂载**，
//      不是「屏挂了但块自己藏起来」—— 后者意味着组件内多了第二道判断，与路由级 guard 必然
//      drift。附带验期权台整族零请求（期权链快照是又一条不该在公开版出现的行情通路）。
//
// hermetic：seed-authed（同 stock-market-access.spec），GET /me + refresh 必拦（per
// mobile-e2e-hermetic rule）。markets-family 端点**故意不 mock** —— 若有泄漏，它会作为一次
// 真实请求落进 collector（采集端全开，过滤放断言端），而非被静默 fulfill 掩盖。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';

const SEED_ACCOUNT_ID = 'acc-e2e-markets-off';
const SEED_ACCESS_TOKEN = 'access-e2e-markets-off';
const SEED_REFRESH_TOKEN = 'refresh-e2e-markets-off';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139099';

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

// markets-family API 前缀（派生自 server controller base paths：marketdata / portfolio.* /
// alert.*，见 apps/server/src/{marketdata,portfolio,alert}/*.controller.ts）。公开版对这三族
// 的任何请求都是合规红线 —— marketdata 是交易所行情本体，portfolio/alert 是其消费面。
const MARKETS_API_RE = /\/api\/v1\/(marketdata|portfolio|alert)(\/|$|\?)/;

/**
 * 期权台整族（047 T036 / FR-015）。**整族而不只是选约表那一条** —— 采集端全开、过滤放断言端：
 * 若门控漏了，泄漏的可能是锚列表 / 雷达 / 温度计里的任意一条，只盯 `…/legs` 会漏掉它们。
 */
const OPTIONSDESK_API_RE = /\/api\/v1\/optionsdesk(\/|$|\?)/;

/** 采集端全开：记录所有命中该族的请求（含 method+url），断言端再判空。 */
function trackMarketsRequests(page: Page, family: RegExp = MARKETS_API_RE): string[] {
  const leaked: string[] = [];
  page.on('request', (req) => {
    if (family.test(req.url())) leaked.push(`${req.method()} ${req.url()}`);
  });
  return leaked;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
  // AuthGate boot 必发 GET /me（seed session 无新鲜 profile）—— 不拦 → 真后端 401 → 误登出。
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
  // 防 authed 401 触发 003 refresh 拦截器误登出（per memory authed_business_401_*）。
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

// 受控可路由面 → 弹回目标（web-stripped；expo-router 剥 (group)/ 段）。
// 与 markets-gate.tsx MARKETS_SURFACES 的 8 个 route/route-stack/tab-screen 面对应
// （optionsdesk 栈一个面 × 三条栈内路由，见文件头第 2 层说明）。
const GATED_DEEPLINKS: { path: string; redirectsTo: RegExp; note: string }[] = [
  { path: '/portfolio', redirectsTo: /\/profile$/, note: '投资 Tab 落地屏（tab-screen）' },
  { path: '/portfolio/600519', redirectsTo: /\/profile$/, note: 'portfolio 栈深链（route-stack）' },
  { path: '/alert', redirectsTo: /\/profile$/, note: '预警栈（route-stack）' },
  // 045 T020：期权台两个可路由面（tab 落地屏 + 二级页栈），与投资同档门控（FR-022 / SC-008）。
  { path: '/optionsdesk', redirectsTo: /\/profile$/, note: '期权台 Tab 落地屏（tab-screen）' },
  {
    path: '/optionsdesk/anchors',
    redirectsTo: /\/profile$/,
    note: 'optionsdesk 二级页栈（route-stack）',
  },
  // 046 T023：两个新屏（FR-022）。它们挂在同一个 optionsdesk 栈下 ⇒ 门控靠继承
  // `_layout` 那道 MarketsRouteGuard，**没有第二套 server 端门**。这两条深链是该继承关系
  // 唯一的机械载体 —— 写在别的 e2e 文件里 = 在 ON bundle 下跑，永远验不到 OFF 且不会红。
  {
    path: '/optionsdesk/thermometer',
    redirectsTo: /\/profile$/,
    note: '波动温度计 P7（栈内新增路由，046 T023）',
  },
  {
    path: '/optionsdesk/underlying/us%3AAAPL',
    redirectsTo: /\/profile$/,
    note: '标的详情深链（栈内新增路由，046 T023）',
  },
  // 055 T018 / SC-009：链分析报表同样只靠继承那道 MarketsRouteGuard（屏内**不另写**判定）。
  // 它是报表可达性在 OFF bundle 下唯一的机械载体 —— 写进 055 自己的 e2e = 在 ON 下跑，
  // 永远验不到 OFF 且不会红。
  {
    path: '/optionsdesk/chain-report/us%3AAAPL',
    redirectsTo: /\/profile$/,
    note: '链分析报表深链（栈内新增路由，055 T010）',
  },
  { path: '/settings/stock-market', redirectsTo: /\/settings$/, note: '证券市场（route）' },
  { path: '/settings/broker-accounts', redirectsTo: /\/settings$/, note: '券商账户（route）' },
  { path: '/settings/broker-accounts/bind', redirectsTo: /\/settings$/, note: '券商绑定（route）' },
];

// ─── 1. 入口隐藏：投资 Tab + 设置投资 Card 不可见 ─────────────────────────────

test('markets-OFF — 投资 Tab 隐藏 + 设置无投资 Card，且零 markets 请求', async ({ page }) => {
  const leaked = trackMarketsRequests(page);

  await page.goto('/');
  // 首发吃 Metro 冷打包：等 tab bar 起来（'我的' 是非门控锚点）。
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });

  // 非门控 tab 在位（正向控制，证明 tab bar 真渲染了，而非整体没起来）。045 T019 后公开版
  // 只剩「首页 / 我的」两个 tab（灵感退位给期权台、期权台与投资同为门控）。
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible();
  // 门控：投资 + 期权台 Tab 按钮均被 href:null 摘除 → 不在可访问性树。
  // 🚨 期权台这条是 045 的合规门（FR-021 / SC-008）：它的 href:null 与「灵感为隐藏 tab 栏而用
  // 的函数形式 options」曾相撞（函数形式下 href 被静默丢弃 → tab 在公开版漏出），tab 栏隐藏
  // 已上移到顶层 screenOptions 解开，本断言是那次解冲突的回归探针。
  await expect(page.getByRole('tab', { name: '投资' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '期权台' })).toHaveCount(0);
  // 灵感：045 起不占 tab 槽（href:null），但路由零回归（FR-025）—— 非门控，不属本 spec 断言面。
  await expect(page.getByRole('tab', { name: '灵感' })).toHaveCount(0);

  // FR-026：中央 + FAB 居「空槽」正中 —— 空槽恒在**可见** tab 集合中点，故两态都应压在视口水平
  // 中线上。fabLeftPct 按可见集合动态算（(tabs)/_layout.tsx）：ON 5 槽→50%，OFF 3 槽→50%；
  // 045 前 OFF 是 62.5%，两态同为 50% 是本次 tab 集合变更（左右各少一个 gated tab）的连带结果，
  // 不是「公式可以拍成常量」的理由（plan D10 已纠正 mockup 帧 ⑪ 的误导）。
  const fab = page.getByRole('button', { name: '创建' });
  await expect(fab).toBeVisible();
  const fabBox = await fab.boundingBox();
  const viewport = page.viewportSize();
  if (!fabBox || !viewport) throw new Error('FAB / viewport 尺寸不可得');
  expect(Math.abs(fabBox.x + fabBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);

  // 进设置页（直达），投资 Card 整块不渲染。
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: '账号与安全', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: '证券市场', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '券商账户', exact: true })).toHaveCount(0);

  expect(leaked, `markets-family 请求泄漏:\n${leaked.join('\n')}`).toEqual([]);
});

// ─── 2. deep-link 守卫：全部受控面直达被弹回 ─────────────────────────────────

test('markets-OFF — 11 条 markets 深链全部 MarketsRouteGuard 弹回安全屏', async ({ page }) => {
  const leaked = trackMarketsRequests(page);

  for (const { path, redirectsTo, note } of GATED_DEEPLINKS) {
    await page.goto(path);
    // <Redirect> 守卫把 URL 换到安全屏；停留在原 gated 路径即合规失败。
    await expect(page, `深链 ${path}（${note}）未被弹回`).toHaveURL(redirectsTo, {
      timeout: 90_000,
    });
  }

  expect(leaked, `markets-family 请求泄漏:\n${leaked.join('\n')}`).toEqual([]);
});

// ─── 3. 合规核心：marketdata 本体零请求（headline 断言，独立留痕） ─────────────

test('markets-OFF — 全 walkthrough 零 /v1/marketdata 请求（合规底线）', async ({ page }) => {
  const leaked = trackMarketsRequests(page);

  // 走一遍公开版用户可达路径 + 把所有 gated 深链再戳一遍（攻击者视角）。
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
  for (const { path } of GATED_DEEPLINKS) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }

  const marketdata = leaked.filter((r) => /\/api\/v1\/marketdata(\/|$|\?)/.test(r));
  expect(marketdata, `交易所行情请求泄漏（合规红线）:\n${marketdata.join('\n')}`).toEqual([]);
  // 顺带兜住整个 markets family（portfolio/alert 的消费面也不该发）。
  expect(leaked, `markets-family 请求泄漏:\n${leaked.join('\n')}`).toEqual([]);
});

// ─── 4. 047 选约区块：随期权台 tab 一并不可达（FR-015） ───────────────────────

test('markets-OFF — 047 选约区块随期权台一并不可达：标的详情深链弹回、屏根本没挂载、期权台整族零请求（FR-015）', async ({
  page,
}) => {
  const marketsLeaked = trackMarketsRequests(page);
  const deskLeaked = trackMarketsRequests(page, OPTIONSDESK_API_RE);

  // 与 GATED_DEEPLINKS 里那条**同一个面** —— 选约区块是它的下半屏，没有自己的路由。
  await page.goto('/optionsdesk/underlying/us%3AAAPL');
  await expect(page).toHaveURL(/\/profile$/, { timeout: 90_000 });

  // 🚨 判据是**整屏没挂载**（连 046 的锚卡容器都不在），而不是「屏在、选约块自己藏起来」——
  //    门控只有 `_layout` 那一道 MarketsRouteGuard（与 045/046 同构）。若哪天有人在组件里补
  //    第二道判断，本断言仍绿而两处判断已开始 drift ⇒ 故这里连**滚动容器**一起断言，
  //    它是整屏挂载与否的最外层证据。
  for (const testId of [
    'optionsdesk-detail-scroll',
    'optionsdesk-detail-leg-header',
    'optionsdesk-detail-leg-tabs',
    'optionsdesk-detail-leg-table-header',
    'optionsdesk-detail-leg-intent-bar',
    'optionsdesk-detail-leg-footer',
  ]) {
    await expect(page.getByTestId(testId), `${testId} 在公开版仍可达`).toHaveCount(0);
  }

  // 选约表端点单独点名（期权链快照 = 又一条交易所数据通路），再兜整族。
  const legs = deskLeaked.filter((r) => /\/legs(\?|$)/.test(r));
  expect(legs, `选约表请求泄漏（合规红线）:\n${legs.join('\n')}`).toEqual([]);
  expect(deskLeaked, `期权台请求泄漏:\n${deskLeaked.join('\n')}`).toEqual([]);
  expect(marketsLeaked, `markets-family 请求泄漏:\n${marketsLeaked.join('\n')}`).toEqual([]);
});
