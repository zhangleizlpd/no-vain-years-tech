import { expect, test, type Page, type Route } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 030-chat-web-search — Expo Web e2e（hermetic mock，PR §V 第一层 UI 交互验证）。
//
// 030 A1（ChatGPT 式恒联网）：去 per-message「智能搜索」toggle —— 是否检索由 server 模型自决
// （前端恒不带 webSearch 字段）。e2e 用 SSE mock 模拟「模型决定搜 / 决定不搜」两条路径，验前端
// 中间态 / 来源 / 降级渲染恒就绪（无开关 UI 前置）。
//
// 覆盖 spec mobile 段（state_branches mobile 侧 + FR-004/005/009/011 UI）：
//   ① 默认发实时问 → 模型决定检索 → 「已阅读 N 个网页」中间态计数跳动（多轮累加，FR-004）
//   ② 过渡到答案流（answer token 开始 → 中间态清除）→ assistant 气泡完整回复（FR-002/003）
//   ③ 答案下「N 个网页来源 ›」可折叠 → 展开编号来源列表（FR-005/006）
//   ④ tap 来源 → expo-web-browser.openBrowserAsync（web 走 window.open，stub 断言被调，FR-005）
//   ⑤ 折叠/展开来源（toggle）
//   ⑥ 发寒暄 → 模型自决不检索（plain SSE）→ 无中间态、无来源（零成本路径，SC-004）
//   ⑦ 降级帧 → assistant 下「本次未联网」标识（FR-009）
//   ⑧ 停止生成中断中间态（streaming 中点 stop → 中间态消失，FR-011）
//   ⑨ 切 MiniMax 模型 → 同样可联网（adaptive tool calling 已纳入，不再灰显，A1）
//
// ── SSE mock 范式（per 027/029 chat spec，干净上下文须知）──
// Playwright route.fulfill 不支持逐帧增量：一次性 fulfill 整 event-stream body（工具帧 +
// token 帧 + sources 帧 + [DONE]）。客户端 getReader() 读整 body → parseSseChunk 切多帧 →
// 逐帧 dispatch。**最终渲染态正确**即验到契约。逐帧增量到达由 server IT + PoC 兜底。
//
// 「停止」需流式窗口：stop 场景 SSE 路由先吐工具帧（中间态出现）再 hang（延迟 fulfill），
// 窗口内点 stop → abort → onAborted → stopped 态（中间态被 reducer 清）。
//
// expo-web-browser web 实现 = window.open(url)；故 stub window.open 记录 URL 数组，tap 来源
// 后 page.evaluate 读回断言「openBrowserAsync 被以正确 url 调用」（mock 调用断言）。
//
// ── auth 边界（per mobile-e2e-hermetic + memory authed_business_401…）──
// seed localStorage 只含 refreshToken/accountId/displayName → boot 走 refresh-token flow。
// 故必 mock refresh-token（否则误登出跳 /login）+ mock /me + mock /chat/models（顶栏切模型）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const MODELS_URL = '**/api/v1/chat/models';
const CONVERSATIONS_GLOB = '**/api/v1/chat/conversations/**';
const CONVERSATIONS_COLLECTION = '**/api/v1/chat/conversations';
const CONVERSATIONS_COLLECTION_QUERY = '**/api/v1/chat/conversations?*';

const SEED_ACCOUNT_ID = 'acc-e2e-030';
const SEED_REFRESH_TOKEN = 'refresh-e2e-030';
const SEED_ACCESS_TOKEN = 'access-e2e-030';
const SEED_DISPLAY_NAME = '阿绿';
const SEED_PHONE = '+8613900139030';

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

// stub window.open（expo-web-browser web 实现底层）→ 记录被打开的 URL 供断言；返回假 window
// 防 RN-Web 后续访问 .focus() 等报错。
const stubWindowOpen = `
  window.__openedUrls = [];
  window.open = function (url) {
    window.__openedUrls.push(String(url));
    return { focus: function () {}, closed: false, close: function () {} };
  };
`;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};
const JSON_HEADERS = { 'access-control-allow-origin': '*' };

const MODELS_BODY = {
  models: [
    { id: 'flash', label: '快速', description: '响应迅速，适合日常问答', available: true },
    { id: 'pro', label: '思考', description: '深度推理，适合复杂问题', available: true },
    { id: 'minimax', label: 'MiniMax', description: '海螺 M3，长上下文通用', available: true },
  ],
};

const TOPBAR_MINIMAX = 'MiniMax M3';

// ── SSE 帧构造（与 server sse.rules 契约一致，与 sse-parse 解析端对齐）──
const tokenFrame = (token: string) => `data: ${JSON.stringify({ token })}\n\n`;
const DONE_FRAME = 'data: [DONE]\n\n';
/** 工具开始帧（query）。 */
const toolStartFrame = (query: string) =>
  `data: ${JSON.stringify({ tool: 'web_search', status: 'start', query })}\n\n`;
/** 工具结果帧（count = 本轮原始页数；sources = 摘要 title/url）。 */
const toolResultFrame = (count: number, sources: { title: string; url: string }[]) =>
  `data: ${JSON.stringify({ tool: 'web_search', status: 'result', count, sources })}\n\n`;
/** 完整编号来源帧（去重后 [N]→源映射）。 */
const sourcesFrame = (sources: { index: number; title: string; url: string }[]) =>
  `data: ${JSON.stringify({ sources })}\n\n`;
/** 降级帧（检索失败基于已有知识作答）。 */
const DEGRADED_FRAME = `data: ${JSON.stringify({ degraded: true })}\n\n`;

type SseMode =
  | { kind: 'search' } // 工具帧 ×2 轮 → token → sources → DONE（联网完整链）
  | { kind: 'plain' } // 纯 token → DONE（OFF 无联网）
  | { kind: 'degraded' }; // 工具开始 → 降级帧 → token → DONE（检索失败降级）

interface ChatMock {
  setSse: (mode: SseMode) => void;
  /** 最近一次 POST messages 的 request body（030 A1 验恒不带 webSearch 字段）。 */
  lastSendBody: () => { content?: string } | null;
  sendCount: () => number;
}

const SEARCH_SOURCES_SUMMARY = [
  { title: '上海今日天气 - 中国天气网', url: 'https://weather.example.com/sh' },
  { title: '上海空气质量实时 - 环境局', url: 'https://air.example.com/sh' },
];
const SEARCH_SOURCES_NUMBERED = [
  { index: 1, title: '上海今日天气 - 中国天气网', url: 'https://weather.example.com/sh' },
  { index: 2, title: '上海空气质量实时 - 环境局', url: 'https://air.example.com/sh' },
];

async function installChatMock(page: Page): Promise<ChatMock> {
  let sendSeq = 0;
  let sse: SseMode = { kind: 'search' };
  let lastBody: { content?: string } | null = null;

  await mockJson(page, MODELS_URL, 200, MODELS_BODY, 'GET');

  const handleList = async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify({ items: [] }),
    });
  };

  // 建会话 collection（POST）+ list（GET）。
  let createdSeq = 0;
  await page.route(CONVERSATIONS_COLLECTION, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (method === 'GET') return void (await handleList(route));
    if (method === 'POST') {
      createdSeq += 1;
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: `conv-${createdSeq}`, title: '新对话', model: 'flash' }),
      }));
    }
    await route.fallback();
  });
  await page.route(CONVERSATIONS_COLLECTION_QUERY, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (method === 'GET') return void (await handleList(route));
    await route.fallback();
  });

  await page.route(CONVERSATIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname;

    // PATCH set-model（切 MiniMax 场景）。
    if (path.endsWith('/model') && method === 'PATCH') {
      const id = path.split('/').slice(-2)[0];
      const body = (req.postDataJSON() ?? {}) as { model?: string };
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id, model: body.model ?? '', updatedAt: new Date().toISOString() }),
      }));
    }

    // GET messages（活跃发送中的 hydrate → 延后避免 clobber 内存流，同 027/029 范式）。
    if (path.endsWith('/messages') && method === 'GET') {
      await new Promise((r) => setTimeout(r, 30_000));
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: [] }),
      }));
    }

    // POST messages（SSE 流式发消息）。
    if (path.endsWith('/messages') && method === 'POST') {
      sendSeq += 1;
      lastBody = (req.postDataJSON() ?? {}) as { content?: string };
      const mode = sse;

      const sseHeaders = { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' };

      if (mode.kind === 'plain') {
        return void (await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: sseHeaders,
          body: ['上海', '今天', '晴'].map(tokenFrame).join('') + DONE_FRAME,
        }));
      }

      if (mode.kind === 'degraded') {
        // 工具开始 → 降级帧（检索失败）→ token 答案 → DONE。
        return void (await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: sseHeaders,
          body:
            toolStartFrame('上海天气') +
            DEGRADED_FRAME +
            ['根据', '已有', '知识'].map(tokenFrame).join('') +
            DONE_FRAME,
        }));
      }

      // search：工具帧 2 轮（count 累加 3 + 2 = 5）→ token → sources → DONE。
      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: sseHeaders,
        body:
          toolStartFrame('上海天气') +
          toolResultFrame(3, SEARCH_SOURCES_SUMMARY) +
          toolResultFrame(2, SEARCH_SOURCES_SUMMARY) +
          ['上海', '今天', '晴'].map(tokenFrame).join('') +
          sourcesFrame(SEARCH_SOURCES_NUMBERED) +
          DONE_FRAME,
      }));
    }

    await route.fallback();
  });

  return {
    setSse: (mode) => {
      sse = mode;
    },
    lastSendBody: () => lastBody,
    sendCount: () => sendSeq,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
  await page.addInitScript(stubWindowOpen);

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

async function gotoChat(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '首页' }).tap();
  await expect(page.getByTestId('chat-empty-state')).toBeVisible({ timeout: 15_000 });
}

test('030 智能搜索 — 默认发实时问 → 模型检索 → 来源列表 → tap 打开 → 折叠（A1 恒联网 FR-004/005）', async ({
  page,
}) => {
  const mock = await installChatMock(page);
  await gotoChat(page);

  // ── ① 默认发实时问（无 toggle 前置，A1 恒联网）→ 模型决定检索（search SSE）──
  mock.setSse({ kind: 'search' });
  await page.getByTestId('chat-input').fill('上海今天天气');
  await page.getByTestId('chat-send-button').tap();

  // 030 A1：前端恒不带 webSearch 字段（联网由 server 模型自决）。
  await expect.poll(() => mock.lastSendBody()).not.toBeNull();
  expect(mock.lastSendBody()).not.toHaveProperty('webSearch');

  // ── ② 过渡到答案流 → assistant 完整回复（中间态已被 token 清，FR-002/003）──
  await expect(page.getByTestId('chat-message-assistant')).toContainText('上海今天晴', {
    timeout: 15_000,
  });

  // ── ③ 答案下来源区「2 个网页来源 ›」可折叠头（FR-005/006，N=去重后来源数）──
  const sourcesToggle = page.getByTestId('chat-sources-toggle');
  await expect(sourcesToggle).toBeVisible();
  await expect(sourcesToggle).toContainText('2 个网页来源');
  // 默认折叠 → 列表不在。
  await expect(page.getByTestId('chat-sources-list')).toHaveCount(0);

  // ── 展开 → 编号来源行出现（[1]/[2]）──
  await sourcesToggle.tap();
  await expect(page.getByTestId('chat-sources-list')).toBeVisible();
  await expect(page.getByTestId('chat-source-1')).toContainText('中国天气网');
  await expect(page.getByTestId('chat-source-2')).toContainText('环境局');

  // ── ④ tap 来源 → expo-web-browser.openBrowserAsync（window.open stub 断言被调正确 url）──
  await page.getByTestId('chat-source-1').tap();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls))
    .toEqual(['https://weather.example.com/sh']);

  // ── ⑤ 折叠（再 tap header）→ 列表收起 ──
  await sourcesToggle.tap();
  await expect(page.getByTestId('chat-sources-list')).toHaveCount(0);
});

test('030 智能搜索 — 工具帧 2 轮 → 答案 + 来源（联网完整链，FR-004 / SC-002）', async ({
  page,
}) => {
  // 工具帧 2 轮（count 3 + 2 = 5 原始页数累加）+ token 答案 + 编号来源一次性到达。中间态计数
  // 的逐帧「跳动」由 route.fulfill 一次性 body 限制不可观测（同 027 增量说明）——其逐帧真值由
  // chat-reducer.spec.ts（tool_result 累加 N）+ T016 contract-smoke 锚定；本 e2e 验联网链最终态。
  let sendSeq = 0;
  await mockJson(page, MODELS_URL, 200, MODELS_BODY, 'GET');
  await page.route(CONVERSATIONS_COLLECTION, async (route: Route) => {
    const m = route.request().method();
    if (m === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (m === 'GET')
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ items: [] }),
      }));
    if (m === 'POST')
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'conv-1', title: '新对话', model: 'flash' }),
      }));
    await route.fallback();
  });
  await page.route(CONVERSATIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const m = req.method();
    if (m === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/messages') && m === 'GET') {
      await new Promise((r) => setTimeout(r, 30_000));
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: [] }),
      }));
    }
    if (path.endsWith('/messages') && m === 'POST') {
      sendSeq += 1;
      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
        body:
          toolStartFrame('上海天气') +
          toolResultFrame(3, SEARCH_SOURCES_SUMMARY) +
          toolResultFrame(2, SEARCH_SOURCES_SUMMARY) +
          ['上海', '今天', '晴'].map(tokenFrame).join('') +
          sourcesFrame(SEARCH_SOURCES_NUMBERED) +
          DONE_FRAME,
      }));
    }
    await route.fallback();
  });

  await gotoChat(page);
  await page.getByTestId('chat-input').fill('上海天气');
  await page.getByTestId('chat-send-button').tap();

  // 工具帧 2 轮（3+2）+ token + sources 一次性到达 → 最终态：来源「2 个网页来源」+ 答案。
  // 一次性 body 下中间态计数瞬时清除不可逐帧观测（per route.fulfill 限制，同 027 增量说明）；
  // 中间态累加 N=5 的逐帧真值由 chat-reducer.spec.ts（tool_result 累加）+ T016 contract-smoke 锚定。
  await expect(page.getByTestId('chat-message-assistant')).toContainText('上海今天晴', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-sources-toggle')).toContainText('2 个网页来源');
  expect(sendSeq).toBe(1);
});

test('030 智能搜索 — 发寒暄 → 模型自决不检索 → 无中间态无来源（零成本路径，SC-004）', async ({
  page,
}) => {
  const mock = await installChatMock(page);
  await gotoChat(page);

  // A1 恒联网下「模型自决不搜」= plain SSE（无工具帧/来源）；前端无开关，行为由 server 模型决定。
  mock.setSse({ kind: 'plain' });
  await page.getByTestId('chat-input').fill('你好呀');
  await page.getByTestId('chat-send-button').tap();

  await expect(page.getByTestId('chat-message-assistant')).toContainText('上海今天晴', {
    timeout: 15_000,
  });
  // 030 A1：前端恒不带 webSearch 字段（联网由 server 模型自决，非 per-message 开关）。
  expect(mock.lastSendBody()).not.toHaveProperty('webSearch');
  // 模型未检索 → 无来源区、无中间态。
  await expect(page.getByTestId('chat-sources-toggle')).toHaveCount(0);
  await expect(page.getByTestId('chat-search-progress')).toHaveCount(0);
});

test('030 智能搜索 — 检索失败降级 → 「本次未联网」标识 + 照常作答（FR-009）', async ({ page }) => {
  const mock = await installChatMock(page);
  await gotoChat(page);

  mock.setSse({ kind: 'degraded' });
  await page.getByTestId('chat-input').fill('实时新闻');
  await page.getByTestId('chat-send-button').tap();

  // 降级标识在位（FR-009）+ 答案照常（不丢消息）。
  await expect(page.getByTestId('chat-degraded-notice')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-degraded-notice')).toContainText('本次未联网');
  await expect(page.getByTestId('chat-message-assistant')).toContainText('根据已有知识');
  // 降级不带编号来源。
  await expect(page.getByTestId('chat-sources-toggle')).toHaveCount(0);
});

test('030 智能搜索 — 停止生成中断中间态（streaming 中 stop → 中间态消失，FR-011）', async ({
  page,
}) => {
  // hang 路由造 streaming 窗口（同 027 停止范式）：POST messages 延迟 4s fulfill。窗口内态机
  // 已进 streaming（user msg + 空 assistant 占位 + stop 按钮渲出），点 stop → abort → stopped。
  await mockJson(page, MODELS_URL, 200, MODELS_BODY, 'GET');
  await page.route(CONVERSATIONS_COLLECTION, async (route: Route) => {
    const m = route.request().method();
    if (m === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (m === 'GET')
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ items: [] }),
      }));
    if (m === 'POST')
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'conv-1', title: '新对话', model: 'flash' }),
      }));
    await route.fallback();
  });
  await page.route(CONVERSATIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const m = req.method();
    if (m === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/messages') && m === 'GET') {
      await new Promise((r) => setTimeout(r, 30_000));
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: [] }),
      }));
    }
    if (path.endsWith('/messages') && m === 'POST') {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
          body:
            toolStartFrame('上海天气') + toolResultFrame(3, SEARCH_SOURCES_SUMMARY) + DONE_FRAME,
        });
      } catch {
        /* aborted —— stop 触发 abort 后 Playwright 取消挂起 route，fulfill 抛错（预期） */
      }
      return;
    }
    await route.fallback();
  });

  await gotoChat(page);
  await page.getByTestId('chat-input').fill('上海天气');
  await page.getByTestId('chat-send-button').tap();

  // 进 streaming（发送位变 stop 按钮）。route hang → 客户端无帧但态机已进 streaming。
  const stopBtn = page.getByTestId('chat-stop-button');
  await expect(stopBtn).toBeVisible({ timeout: 15_000 });

  // 点停止 → abort → stopped 态（中间态被 reducer 清，FR-011）。
  await stopBtn.tap();
  await expect(page.getByTestId('chat-stopped-label')).toBeVisible({ timeout: 15_000 });
  // 中间态不在（停止中断整链）。
  await expect(page.getByTestId('chat-search-progress')).toHaveCount(0);
});

test('030 智能搜索 — 切 MiniMax 模型 → 同样可联网（adaptive 纳入，不再灰显，A1）', async ({
  page,
}) => {
  const mock = await installChatMock(page);
  await gotoChat(page);

  // 切 MiniMax（顶栏下拉，未落库会话也可切——仅内存态）。
  await page.getByTestId('chat-model-switcher-button').tap();
  await expect(page.getByTestId('chat-model-dropdown')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('chat-model-option-minimax').tap();
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_MINIMAX);

  // A1：MiniMax M3 adaptive tool calling 已纳入 → 同样可联网（去灰显/禁用 toggle，且无 toggle UI）。
  // 发实时问 → 模型检索（search SSE）→ 来源出现，证联网未因模型被 gate。
  mock.setSse({ kind: 'search' });
  await page.getByTestId('chat-input').fill('上海今天天气');
  await page.getByTestId('chat-send-button').tap();

  await expect(page.getByTestId('chat-message-assistant')).toContainText('上海今天晴', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-sources-toggle')).toContainText('2 个网页来源');
});
