import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 027-ai-chat-streaming — Expo Web e2e（hermetic mock，PR §V 第一层 UI 交互验证）。
//
// 覆盖 FR-001/002/003/008/009/010 + spec state_branches 的 UI 侧：
//   ① 空态带昵称（/me displayName → greeting「嗨 {昵称}…」，FR-001）
//   ② 输入发送：空内容发送禁用（FR-002）→ 输入后可发
//   ③ AI 渲染：mock SSE 帧（token×N + [DONE]）→ assistant 气泡出现完整回复 + 「内容由 AI 生成」
//      标识在位（FR-003 / FR-010）
//   ④ 多轮追问：第二轮 send → 第二组 user/assistant 气泡（US2）
//   ⑤ 停止：流式期间点 stop → 半成品保留 + 「已停止」标识（FR-008）
//   ⑥ 失败 + 重试：SSE error 帧 → 错误态 + 重试 → 回 streaming → 成功（FR-009）
//   ⑦ 复制：点 copy → 「已复制」反馈（expo-clipboard，web 走 navigator.clipboard）
//
// ── SSE mock 范式（干净上下文须知）──
// Playwright `route.fulfill` 不支持「逐帧增量」流式响应：一次性把整个 text/event-stream
// body（所有 token 帧 + [DONE]）fulfill。客户端 getReader() 读到整 body → parseSseChunk
// 切多帧 → 逐 token dispatch → done。**最终渲染态正确**即验到 FR-003 的渲染契约；真增量
// 逐帧到达由 server IT（reply.hijack 逐 write）+ PoC（Android 增量实测）兜底，e2e 不复验。
//
// 「停止」需要一个流式窗口：mock 对 stop 场景的 SSE 路由**延迟 fulfill**（hang，4s），
// UI 停在 streaming → 点 stop → AbortController.abort() → fetch 抛 abort → onAborted →
// stopped 态（abort 早于 fulfill，半成品占位为空串但标 stopped，「已停止」标识在位即验 FR-008）。
//
// ── auth 边界（per memory authed_business_401_triggers_refresh_interceptor + store.ts）──
// store.ts partialize **不持久化 accessToken**（冷启靠 refresh-token flow 重derive）。seed
// localStorage 只含 refreshToken/accountId/displayName → boot 时走 refresh-token 拿 access
// token。故必 mock refresh-token（否则 AuthGate refresh 失败 → clearSession 跳 /login）+
// mock /me（seed-auth e2e 硬强制，per mobile-e2e-hermetic）。建会话/取消息走 orval(axios)
// authed → 同样受 refresh 拦截器保护。SSE 端点裸 fetch 自带 Bearer（accessToken 由 refresh
// flow 落 store），本 mock 放行任意 Authorization。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const CONVERSATIONS_GLOB = '**/api/v1/chat/conversations/**';
const CONVERSATIONS_COLLECTION = '**/api/v1/chat/conversations';

const SEED_ACCOUNT_ID = 'acc-e2e-027';
const SEED_REFRESH_TOKEN = 'refresh-e2e-027';
const SEED_ACCESS_TOKEN = 'access-e2e-027';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139027';

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

/** 一个 token 帧（与 server sse.rules 契约一致：`data: {json}\n\n`）。 */
const tokenFrame = (token: string) => `data: ${JSON.stringify({ token })}\n\n`;
/** 终止哨兵（裸字面，server SSE_DONE 同源）。 */
const DONE_FRAME = 'data: [DONE]\n\n';
/** 失败帧（provider 失败，AI msg 不落；client onError → 错误态）。 */
const errorFrame = (message: string) => `data: ${JSON.stringify({ error: message })}\n\n`;

/** SSE 路由行为：tokens 全帧一次性给（normal）/ hang（停止窗口）/ error 帧（失败）。 */
type SseMode =
  | { kind: 'tokens'; tokens: string[] }
  | { kind: 'hang'; tokens: string[] } // 先吐部分 token（半成品）再挂起不 fulfill
  | { kind: 'error'; message: string };

interface ChatMock {
  /** 设定下一次 POST messages 的 SSE 行为（每发一条前设）。 */
  setSse: (mode: SseMode) => void;
  /** 已建会话计数（验「空态首发先建会话再发」两步）。 */
  createCount: () => number;
  /** 已发起的 SSE POST 计数（验多轮 / 重试各发一次）。 */
  sendCount: () => number;
}

// 单一 stateful chat mock：建会话(POST collection) / 取消息(GET) / SSE 发消息(POST messages)。
async function installChatMock(page: Page): Promise<ChatMock> {
  let createdSeq = 0;
  let sendSeq = 0;
  let sse: SseMode = { kind: 'tokens', tokens: ['你好', '，', '我是', 'AI'] };

  // 拦 chat/conversations/** （建会话 collection 与 :id/messages 同前缀，按 path 细分）。
  await page.route(CONVERSATIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;
    const isMessages = path.endsWith('/messages');

    // ── GET /conversations/:id/messages（冷启 hydrate reload，SC-002）──
    // use-chat 在建会话后 setLastConversationId → messagesQuery enabled → 这条 GET 触发。
    // 但 hydrate 设计是**冷启**复原已落库消息，本测试场景是**活跃发送中**，hydrate 若此刻
    // 返回会 clobber 进行中的内存流（dispatch hydrate 重置态机）。为隔离「活跃流由内存驱动、
    // hydrate 只服务冷启」这一设计意图 —— 把 GET 延到断言窗口之外（活跃流早已渲完）。冷启
    // reload 的 hydrate 行为由 T014 contract-smoke（真 server）+ T011 reducer 单测覆盖，本
    // UI e2e 不复验。
    if (isMessages && method === 'GET') {
      await new Promise((r) => setTimeout(r, 30_000));
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ messages: [] }),
      }));
    }

    // ── POST /conversations/:id/messages（SSE 流式发消息）──
    if (isMessages && method === 'POST') {
      sendSeq += 1;
      const mode = sse;

      if (mode.kind === 'error') {
        return void (await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
          body: errorFrame(mode.message),
        }));
      }

      if (mode.kind === 'hang') {
        // 「停止」需要一个流式窗口：route 延迟 fulfill（4s），UI 停在 streaming（user 气泡 +
        // 空 assistant 占位 + stop 按钮已渲）。测试在窗口内点 stop → AbortController.abort()
        // → fetch 抛 abort → client onAborted → stopped 态。abort 后 Playwright 取消此挂起
        // route，下面 fulfill 抛错被 catch 吞（预期路径）。route.fulfill body 一次性，无法
        // 「逐帧增量」，故半成品内容（assistant content）在 abort 早于 fulfill 时为空串 —— UI
        // 仍按 stopped 定型半成品占位（reducer finalizeAssistant），「已停止」标识在位即验到 FR-008。
        await new Promise((r) => setTimeout(r, 4000));
        try {
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
            body: mode.tokens.map(tokenFrame).join('') + DONE_FRAME,
          });
        } catch {
          /* aborted —— 预期路径（stop） */
        }
        return;
      }

      // normal：一次性给全帧（token×N + [DONE]）。客户端切多帧 → 逐 token 累加 → done。
      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
        body: mode.tokens.map(tokenFrame).join('') + DONE_FRAME,
      }));
    }

    await route.fallback();
  });

  // 建会话 collection（POST /conversations，无 :id）。注：上面 glob 末尾 ** 不匹配无路径段的
  // collection，故单独注册精确 glob。
  await page.route(CONVERSATIONS_COLLECTION, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (method === 'POST') {
      createdSeq += 1;
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ id: `conv-${createdSeq}`, title: '新对话', model: 'deepseek-chat' }),
      }));
    }
    await route.fallback();
  });

  return {
    setSse: (mode) => {
      sse = mode;
    },
    createCount: () => createdSeq,
    sendCount: () => sendSeq,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
  // web clipboard 权限（复制场景；navigator.clipboard.writeText 需 grant）。
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'])
    .catch(() => {
      /* 部分浏览器不支持该 permission —— 复制断言放宽（见对应 test 注释）。 */
    });

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

/** 进首页 chat 屏（首 tab = ChatHomeScreen）。expo-router web 可能恢复上次 tab，故显式切首页。 */
async function gotoChat(page: Page) {
  await page.goto('/');
  // 等 tab bar 就位（auth boot 完成）后显式切「首页」tab —— goto '/' 在 web 不保证落首 tab。
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '首页' }).tap();
  // 空态问候是首屏锚（带昵称）。
  await expect(page.getByTestId('chat-empty-state')).toBeVisible({ timeout: 15_000 });
}

test('027 chat — 空态带昵称 + 发送禁用 + AI 流式渲染 + 多轮 + AI 标识 + 复制（hermetic）', async ({
  page,
}) => {
  const mock = await installChatMock(page);
  await gotoChat(page);

  // ── ① 空态带昵称（FR-001）──
  await expect(page.getByTestId('chat-greeting')).toHaveText(
    `嗨 ${SEED_DISPLAY_NAME}，今天聊点什么`,
  );

  // ── ② 发送禁用（FR-002）：空输入 → send 禁用 ──
  const sendBtn = page.getByTestId('chat-send-button');
  await expect(sendBtn).toBeDisabled();

  // ── ③ 输入 → 可发 → AI 流式渲染（FR-003）──
  mock.setSse({ kind: 'tokens', tokens: ['上海', '今天', '晴'] });
  await page.getByTestId('chat-input').fill('上海天气怎么样');
  await expect(sendBtn).toBeEnabled();
  await sendBtn.tap();

  // 空态首发 = 先建会话再发（D3 两步）。
  await expect.poll(() => mock.createCount()).toBe(1);
  await expect.poll(() => mock.sendCount()).toBe(1);

  // user 气泡 + assistant 气泡（token 累加 → 完整回复）。
  await expect(page.getByTestId('chat-message-user')).toContainText('上海天气怎么样');
  await expect(page.getByTestId('chat-message-assistant')).toContainText('上海今天晴', {
    timeout: 15_000,
  });

  // ── 「内容由 AI 生成」标识在位（FR-010）──
  await expect(page.getByTestId('chat-ai-generated-notice')).toBeVisible();

  // ── ④ 多轮追问（US2）：第二轮 send → 第二组气泡 ──
  mock.setSse({ kind: 'tokens', tokens: ['明天', '多云'] });
  await page.getByTestId('chat-input').fill('那明天呢');
  await page.getByTestId('chat-send-button').tap();

  // 第二轮复用已有会话（不再建）→ createCount 仍 1，sendCount 升到 2。
  await expect.poll(() => mock.sendCount()).toBe(2);
  await expect.poll(() => mock.createCount()).toBe(1);
  await expect(page.getByTestId('chat-message-user')).toHaveCount(2);
  await expect(page.getByTestId('chat-message-assistant').last()).toContainText('明天多云', {
    timeout: 15_000,
  });

  // ── ⑦ 复制：点末条 assistant 的 copy → 「已复制」反馈 ──
  await page.getByTestId('chat-copy-button').last().tap();
  await expect(page.getByTestId('chat-copied-feedback').last()).toBeVisible({ timeout: 10_000 });
});

test('027 chat — 停止生成 → 半成品保留 + 「已停止」标识（FR-008）', async ({ page }) => {
  const mock = await installChatMock(page);
  await gotoChat(page);

  // hang 模式：SSE 路由延迟 fulfill（4s 窗口），先吐 token 但客户端在 fulfill 前看不到内容；
  // 关键验「streaming 中点 stop → abort → stopped 态」。半成品内容由 fulfill 时的 token 决定，
  // 但 stop 在 fulfill 前触发 → assistant 占位为空字符串 + 标 stopped（reducer finalizeAssistant）。
  mock.setSse({ kind: 'hang', tokens: ['生成中...'] });
  await page.getByTestId('chat-input').fill('讲个长故事');
  await page.getByTestId('chat-send-button').tap();

  // 进 streaming：发送位变停止按钮（FR-008）。
  const stopBtn = page.getByTestId('chat-stop-button');
  await expect(stopBtn).toBeVisible({ timeout: 15_000 });
  // user 气泡已落（即时落库语义的 UI 侧：reducer 同步 append user msg）。
  await expect(page.getByTestId('chat-message-user')).toContainText('讲个长故事');

  // 点停止 → abort → onAborted → stopped 态。
  await stopBtn.tap();

  // 「已停止」标识在位（FR-008 半成品保留 + 标识）。
  await expect(page.getByTestId('chat-stopped-label')).toBeVisible({ timeout: 15_000 });
  // 停止后输入条回发送态（非流式）。
  await expect(page.getByTestId('chat-send-button')).toBeVisible();
  // assistant 半成品气泡仍在（未被移除，与 error 分支区别）。
  await expect(page.getByTestId('chat-message-assistant')).toBeVisible();
});

test('027 chat — provider 失败 → 错误态 + 重试 → 成功（FR-009）', async ({ page }) => {
  const mock = await installChatMock(page);
  await gotoChat(page);

  // ── 失败：SSE error 帧 → 错误态（半成品 assistant 占位被移除，user msg 保留）──
  mock.setSse({ kind: 'error', message: '网络开小差了，请重试' });
  await page.getByTestId('chat-input').fill('问点会失败的');
  await page.getByTestId('chat-send-button').tap();

  await expect(page.getByTestId('chat-error-state')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-retry-button')).toBeVisible();
  // user msg 保留（重发不丢，FR-009）。
  await expect(page.getByTestId('chat-message-user')).toContainText('问点会失败的');
  // 失败不落半成品 assistant 气泡（reducer 移除空占位）。
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(0);

  // ── 重试：复用 lastUserContent 重发 → 回 streaming → 成功 ──
  mock.setSse({ kind: 'tokens', tokens: ['这次', '成功了'] });
  await page.getByTestId('chat-retry-button').tap();

  // 重试不新增 user msg（仍 1 条），assistant 成功渲出完整回复。
  await expect(page.getByTestId('chat-message-assistant')).toContainText('这次成功了', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-message-user')).toHaveCount(1);
  await expect(page.getByTestId('chat-error-state')).toHaveCount(0);
});
