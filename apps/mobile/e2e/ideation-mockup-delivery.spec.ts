import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 037 T013 — ideation mockup 交付 + App 隔离渲染 主干 Expo Web e2e（hermetic，PR §V 第一层 UI
// 交互验证）。覆盖 US1 渲染脊柱 + 空态 + 渲染降级（3 场景）：
//   ① 打开有 mockup 的 session → 拉读列表（一条记录，mockupUrl 同源备案展示域）→ 进设计稿屏 →
//      `<iframe data-testid="mockup-iframe">` 渲染 fixture HTML（多状态屏自包含文档，route.fulfill
//      iframe src 返该 HTML）→ iframe 可见 + 帧内多状态屏文本可读（US1 AC1/AC2，FR-005/SC-004）。
//   ② 空态：读列表返 `{items:[]}` → `ideation-mockup-empty`（「暂无设计稿」），session 不崩（US1 AC3）。
//   ③ 渲染降级：读列表返记录（mockupUrl 同源 → 过 isRenderableMockupUrl 闸 → 进渲染分支），但 iframe
//      src 产物**网络失败**（route.abort）→ iframe onError → `ideation-mockup-render-error` +
//      `ideation-mockup-render-retry`（一次性提示 + 重试，session 不崩，US1 AC4 / FR-009）。
//
// ── seam / route.fulfill 注入范式（干净上下文须知，036 同款 hermetic 边界）──
// 三处 HTTP 边界经 `route.fulfill` 镜像契约：
//   A. 读列表 EP（`GET /ideation/sessions/{id}/mockups`）→ `{items:[SessionMockupResponse]}`。
//      mockupUrl **必须**与 webServer 注入的 `EXPO_PUBLIC_OSS_PUBLIC_BASE_URL=https://oss-e2e.example.com`
//      同源，否则 `isRenderableMockupUrl` 闸不过 → 折叠空态（render-rules origin 锁，FR-005）。
//   B. mockup 产物（iframe src = mockupUrl，落 oss-e2e.example.com）→ fulfill fixture HTML（成功渲染）。
//      ③ 降级**不经产物 HTTP**：浏览器 `<iframe>` 对 `src` 加载失败的 onError 触发条件挑剔——HTTP 4xx
//      仍当「文档已加载」、网络 abort 当 navigation-level 失败被吞（实测 route.abort 后 iframe 仍在、
//      onError 不发）、X-Frame-Options: DENY 拒绝成帧亦不发 React onError、手动 dispatch error 事件虽
//      到达 iframe 元素但到不了 React 19 delegated 监听（实测 probe：原生 listener 触发但 React
//      synthetic onError 不触发）。**唯「经 React fiber 直调 iframe 的 onError prop」可靠**（见
//      `invokeIframeOnError`）→ `MockupRenderer.onError → 屏 setRenderFailed`：验「renderer 报 onError
//      → 屏降级 + 重试」这段**屏 wiring**（iframe 自身产物不可达检测 = web 平台/真机 native WebView
//      关注，web_compat: untested 已声明、留真机手动验）。
//   C. session 详情 GET（`GET /ideation/sessions/{id}`）—— 设计稿屏不直接读详情, 但宽 glob
//      `**/ideation/sessions/**` 会命中读列表 mockups 子路径, 故读列表 handler 须先判 `/mockups`
//      后缀再回正确 body（避免误吞）。
//
// ── 进入路径（deep-link，非从 session 详情点入）──
// `[id].tsx` 当前无「设计稿」入口按钮（入口接线非本 task），故经 deep-link 直进设计稿屏：
// `/ideation/mockups?sessionId=<id>`（route group (app)/(tabs) 在 web URL 透明；屏读 query sessionId）。
// 镜像 036 重载场景 `page.goto('/ideation/sess-1')` 的冷启 deep-link 范式。
//
// ── auth 边界（同 036 ideation-image-annotation.spec + mobile-e2e-hermetic 规则）──
// seed localStorage 仅 refreshToken/accountId/displayName → boot 走 refresh 拿 access token。
// 必 mock /me + refresh-token（否则 AuthGate refresh 失败 → clearSession 跳 /login）。读列表 GET
// 是 authed 业务调用，401 会命中 003 refresh 拦截器 retry-once → 不 mock refresh 即误登出（per memory）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
// 读列表 + session 详情共用前缀；读列表是 `…/sessions/{id}/mockups` 子路径。
const SESSIONS_GLOB = '**/api/v1/ideation/sessions/**';

// webServer 注入的 EXPO_PUBLIC_OSS_PUBLIC_BASE_URL（mockupUrl 必须同源，否则 isRenderableMockupUrl 拒）。
const OSS_BASE = 'https://oss-e2e.example.com';
const MOCKUP_OBJECT_KEY = 'ideation-mockup/acc-e2e-037/1001/v1/index.html';
const MOCKUP_URL = `${OSS_BASE}/${MOCKUP_OBJECT_KEY}`;
const MOCKUP_URL_GLOB = '**oss-e2e.example.com**';

const SEED_ACCOUNT_ID = 'acc-e2e-037';
const SEED_REFRESH_TOKEN = 'refresh-e2e-037';
const SEED_ACCESS_TOKEN = 'access-e2e-037';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139037';

const SESSION_ID = '1001';

/** mockup 产物 fixture：自包含 HTML，多状态屏（空态 / 加载 / 成功）可滚动浏览（US1 AC2）。 */
const MOCKUP_FIXTURE_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>设计稿预览</title></head>
<body style="margin:0;font-family:sans-serif">
  <section style="height:600px;background:#eef" data-screen="empty"><h1>空态屏</h1></section>
  <section style="height:600px;background:#efe" data-screen="loading"><h1>加载屏</h1></section>
  <section style="height:600px;background:#fee" data-screen="success"><h1>成功屏</h1></section>
</body>
</html>`;

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
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

// ── HTTP 边界 mock ──

interface MockupListItem {
  id: string;
  objectKey: string;
  mockupUrl: string | null;
  screens: string[];
  createdAt: string;
  versionRank: number;
}

/**
 * 读列表 EP mock（`GET /ideation/sessions/{id}/mockups`）。宽 glob 命中 sessions 子树 → 仅处理
 * `/mockups` 后缀（其余 sessions 子路径 fallback，避免误吞详情 GET）。返 `{items}`。
 */
async function installMockupListMock(page: Page, items: MockupListItem[]): Promise<void> {
  await page.route(SESSIONS_GLOB, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname;
    if (!path.endsWith('/mockups')) return void (await route.fallback());
    return void (await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ items }),
    }));
  });
}

/** mockup 产物（iframe src）mock：fulfill fixture HTML（成功渲染；降级经 renderer onError 信号驱动）。 */
async function installMockupArtifactMock(page: Page): Promise<void> {
  await page.route(MOCKUP_URL_GLOB, async (route: Route) => {
    return void (await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: MOCKUP_FIXTURE_HTML,
    }));
  });
}

/**
 * 确定性驱动 web `MockupRenderer` 的 onError：直接经 React fiber 调 iframe 的 `onError` prop。
 * 浏览器 iframe 加载失败的 onError 触发条件挑剔（HTTP 4xx 当已加载 / 网络 abort 被吞 / 合成 error
 * 事件到不了 React 19 delegated 监听——实测三者皆不触发，唯本法可靠，见文件头 B）。React 把
 * iframe 的 `onError={() => onError?.(uri)}` 挂在 fiber props（`__reactProps$*` key），直调即等价
 * 浏览器报告产物不可达。验「renderer 报 onError → 屏降级」屏 wiring，非验 iframe 自身失败检测。
 */
async function invokeIframeOnError(page: Page): Promise<void> {
  const fired = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="mockup-iframe"]');
    if (!el) return false;
    const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
    if (!propsKey) return false;
    const props = (el as unknown as Record<string, { onError?: (e: unknown) => void }>)[propsKey];
    if (typeof props.onError !== 'function') return false;
    props.onError({ type: 'error' });
    return true;
  });
  if (!fired) throw new Error('invokeIframeOnError: iframe React onError prop not found/invocable');
}

async function seedAuthMocks(page: Page) {
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
  // refresh-token 必 mock：读列表 authed 401 命中 003 refresh 拦截器 retry-once，不 mock → 误登出。
  await mockJson(page, REFRESH_URL, 200, {
    accountId: SEED_ACCOUNT_ID,
    accessToken: SEED_ACCESS_TOKEN,
    refreshToken: SEED_REFRESH_TOKEN,
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
}

/** deep-link 进设计稿屏（route group 在 web URL 透明；query 带 sessionId）。 */
async function gotoMockupScreen(page: Page) {
  await page.goto(`/ideation/mockups?sessionId=${SESSION_ID}`);
  await expect(page.getByTestId('ideation-mockup-screen')).toBeVisible({ timeout: 90_000 });
}

/** 一条交付记录（mockupUrl 同源备案展示域 → 过 isRenderableMockupUrl 闸）。 */
function oneMockupItem(): MockupListItem {
  return {
    id: '5001',
    objectKey: MOCKUP_OBJECT_KEY,
    mockupUrl: MOCKUP_URL,
    screens: ['空态', '加载', '成功'],
    createdAt: '2026-06-27T00:00:00.000Z',
    versionRank: 1,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// T015 多版 fixtures：同 session N 版（不同 createdAt + versionRank + 各自同源 mockupUrl）。
// 各版产物返**可辨** fixture HTML（含 `data-version` 锚），切版后断言 iframe 内容变（US2 AC1/AC2）。
// ════════════════════════════════════════════════════════════════════════════

/** 第 rank 版的同源 mockupUrl（路径含 v{rank}，落 oss-e2e.example.com → 过 isRenderableMockupUrl 闸）。 */
function versionedMockupUrl(rank: number): string {
  return `${OSS_BASE}/ideation-mockup/${SEED_ACCOUNT_ID}/${SESSION_ID}/v${rank}/index.html`;
}

/** 第 rank 版可辨 fixture HTML（`data-version` 锚 → 切版后断言内容变）。 */
function versionedFixtureHtml(rank: number): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>设计稿 v${rank}</title></head>
<body style="margin:0;font-family:sans-serif">
  <section style="height:600px" data-version="${rank}"><h1>第 ${rank} 版设计稿</h1></section>
</body></html>`;
}

/**
 * 同 session N 版交付记录（read-list mock 返此；倒序：versionRank 1 = 最新，createdAt 越新 rank 越小）。
 * server append-only 派生 versionRank，本 fixture 直按契约形状给（read-list 已倒序，rank 1 在前）。
 */
function nMockupItems(n: number): MockupListItem[] {
  // rank 1 = 最新（createdAt 最新）；rank n = 最旧。倒序数组（rank 升序，最新在前）。
  return Array.from({ length: n }, (_, i) => {
    const rank = i + 1;
    // createdAt：rank 1 最新（日期最大），rank n 最旧。
    const day = String(28 - rank).padStart(2, '0');
    return {
      id: `60${rank}`,
      objectKey: `ideation-mockup/${SEED_ACCOUNT_ID}/${SESSION_ID}/v${rank}/index.html`,
      mockupUrl: versionedMockupUrl(rank),
      screens: [`v${rank}-空态`, `v${rank}-成功`],
      createdAt: `2026-06-${day}T00:00:00.000Z`,
      versionRank: rank,
    };
  });
}

/** 多版产物 mock：按 iframe src 的 v{rank} 路径返各自可辨 fixture（切版后内容辨别用）。 */
async function installVersionedArtifactMock(page: Page): Promise<void> {
  await page.route(MOCKUP_URL_GLOB, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const m = /\/v(\d+)\//.exec(path);
    const rank = m ? Number(m[1]) : 1;
    return void (await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: versionedFixtureHtml(rank),
    }));
  });
}

test.setTimeout(120_000);

// ════════════════════════════════════════════════════════════════════════════
// ① US1 渲染脊柱：有 mockup 的 session → 读列表 → iframe 渲染最新 fixture → 多状态屏可浏览
// ════════════════════════════════════════════════════════════════════════════
test('037 US1 — 打开有 mockup 的 session → iframe 渲染最新设计稿 + 多状态屏可滚动浏览（AC1/AC2）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  await installMockupListMock(page, [oneMockupItem()]);
  await installMockupArtifactMock(page);

  await gotoMockupScreen(page);

  // 渲染分支：renderer + 内层 iframe（data-testid="mockup-iframe"，web 变体）。
  await expect(page.getByTestId('ideation-mockup-renderer')).toBeVisible({ timeout: 30_000 });
  const iframeEl = page.locator('[data-testid="mockup-iframe"]');
  await expect(iframeEl).toBeVisible({ timeout: 30_000 });
  // iframe src = 同源备案展示域 mockupUrl。
  await expect(iframeEl).toHaveAttribute('src', MOCKUP_URL);

  // 帧内 fixture 多状态屏文本可读（route.fulfill 的自包含 HTML 渲染进 iframe document）。
  const frame = page.frameLocator('[data-testid="mockup-iframe"]');
  await expect(frame.locator('[data-screen="empty"]')).toContainText('空态屏', { timeout: 30_000 });
  await expect(frame.locator('[data-screen="loading"]')).toContainText('加载屏');
  await expect(frame.locator('[data-screen="success"]')).toContainText('成功屏');

  // 空态 / 降级 / 错误态均不出现（纯渲染成功路径）。
  await expect(page.getByTestId('ideation-mockup-empty')).toHaveCount(0);
  await expect(page.getByTestId('ideation-mockup-render-error')).toHaveCount(0);
  await expect(page.getByTestId('ideation-mockup-list-error')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ② 空态：读列表返 {items:[]} → 「暂无设计稿」引导，session 不崩（US1 AC3）
// ════════════════════════════════════════════════════════════════════════════
test('037 空态 — 该 session 无 mockup → 暂无设计稿引导，不崩（US1 AC3）', async ({ page }) => {
  await seedAuthMocks(page);
  await installMockupListMock(page, []); // 空列表（非错误）。
  await installMockupArtifactMock(page); // 不会被请求（无 mockupUrl 渲染）。

  await gotoMockupScreen(page);

  // 空态文案（非错误态、非渲染态）。
  await expect(page.getByTestId('ideation-mockup-empty')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('暂无设计稿')).toBeVisible();
  // 不进渲染分支（无 iframe）+ 不报错。
  await expect(page.locator('[data-testid="mockup-iframe"]')).toHaveCount(0);
  await expect(page.getByTestId('ideation-mockup-list-error')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ③ 渲染降级：读列表有记录 → iframe 产物网络失败 → 一次性提示 + 重试，session 不崩（US1 AC4）
// ════════════════════════════════════════════════════════════════════════════
test('037 渲染降级 — 记录存在但产物不可达 → 设计稿加载失败 + 重试，不崩（US1 AC4/FR-009）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  await installMockupListMock(page, [oneMockupItem()]); // 读列表成功（记录存在）。
  await installMockupArtifactMock(page); // 产物 fulfill；降级经 renderer onError 信号确定性驱动（见下）。

  await gotoMockupScreen(page);

  // 先进渲染分支（记录存在 + mockupUrl 同源 → 过 isRenderableMockupUrl 闸 → iframe 挂载）。
  await expect(page.locator('[data-testid="mockup-iframe"]')).toBeVisible({ timeout: 30_000 });

  // 确定性驱动 renderer onError：直接经 React fiber 调 iframe 的 `onError` prop（见文件头 B —— 浏览器
  // iframe 加载失败的 onError 触发条件挑剔、合成 error 事件到不了 React 19 delegated 监听；实测唯
  // 「直调 fiber onError prop」可靠）。验的是「renderer 报 onError → 屏 setRenderFailed → 降级 + 重试」
  // 这段**屏 wiring**；iframe 自身的产物不可达检测是 web 平台/真机 native WebView 关注，留真机手动验。
  await invokeIframeOnError(page);

  // 渲染降级横幅（onError 触发；与读列表 isError 正交——记录存在 ≠ 渲染成功）。
  await expect(page.getByTestId('ideation-mockup-render-error')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('设计稿加载失败')).toBeVisible();
  // 一次性重试钮可点（session 不崩，屏仍在）。
  const retry = page.getByTestId('ideation-mockup-render-retry');
  await expect(retry).toBeVisible();
  await expect(page.getByTestId('ideation-mockup-screen')).toBeVisible();
  // 点重试 → 横幅收起、重回渲染分支（renderer 重挂 → iframe 再现，「重试」交互可达，session 不崩）。
  await retry.tap();
  await expect(page.locator('[data-testid="mockup-iframe"]')).toBeVisible({ timeout: 15_000 });
});

// ════════════════════════════════════════════════════════════════════════════
// ④ T015 US2 多版：同 session N 版 → 列 N chips + 默认渲最新（rank 1）+ 选历史版 → iframe 切到该版
// ════════════════════════════════════════════════════════════════════════════
test('037 US2 — 同 session 多版 → 列 N 版 + 默认渲最新 + 选历史版切到该版 fixture（AC1/AC2）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  const N = 3;
  await installMockupListMock(page, nMockupItems(N)); // rank 1 最新在前（倒序）。
  await installVersionedArtifactMock(page); // 各版产物返可辨 fixture（data-version 锚）。

  await gotoMockupScreen(page);

  // 版本条列出 N 枚 chip（倒序，latest=rank1 在前）。
  await expect(page.getByTestId('ideation-mockup-version-strip')).toBeVisible({ timeout: 30_000 });
  for (let rank = 1; rank <= N; rank++) {
    await expect(page.getByTestId(`ideation-mockup-version-chip-${rank}`)).toBeVisible();
  }

  // 默认渲最新版（rank 1）：iframe src = v1 mockupUrl + 帧内 data-version=1 可读。
  // ⚠️「选中态」断言走 iframe src（活跃版的真相源）而非 chip aria-selected —— RNW 不把
  //   accessibilityState.selected 映射成 aria-selected（实证 alert.spec 同坑）；活跃版 = 渲哪版才是
  //   load-bearing 行为（默认 latest / 切版换版），chip 高亮是 cosmetic。
  const iframeEl = page.locator('[data-testid="mockup-iframe"]');
  await expect(iframeEl).toBeVisible({ timeout: 30_000 });
  await expect(iframeEl).toHaveAttribute('src', versionedMockupUrl(1));
  const frameV1 = page.frameLocator('[data-testid="mockup-iframe"]');
  await expect(frameV1.locator('[data-version="1"]')).toContainText('第 1 版设计稿', {
    timeout: 30_000,
  });

  // 屏标签行渲**最新版**的逐屏标签（选中版 screens[]，FR-010 + Clarification Q2）。
  await expect(page.getByTestId('ideation-mockup-screen-labels')).toBeVisible();
  await expect(page.getByTestId('ideation-mockup-screen-label-0')).toContainText('v1-空态');

  // 选历史版（rank 3）→ iframe 切到该版 fixture（src 变 + 帧内 data-version=3）。
  await page.getByTestId('ideation-mockup-version-chip-3').tap();
  await expect(iframeEl).toHaveAttribute('src', versionedMockupUrl(3), { timeout: 30_000 });
  const frameV3 = page.frameLocator('[data-testid="mockup-iframe"]');
  await expect(frameV3.locator('[data-version="3"]')).toContainText('第 3 版设计稿', {
    timeout: 30_000,
  });

  // 屏标签行随选中版更新（v3 标签）—— 验切版连带换屏标签行（选中版 screens[]）。
  await expect(page.getByTestId('ideation-mockup-screen-label-0')).toContainText('v3-空态');
});
