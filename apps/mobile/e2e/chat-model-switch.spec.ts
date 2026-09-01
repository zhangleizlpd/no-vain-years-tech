import { expect, test, type Page, type Route } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 029-chat-model-switch — Expo Web e2e（hermetic mock，PR §V 第一层 UI 交互验证）。
//
// 覆盖 spec state_branches 的 mobile 侧 + US1-US3 验收：
//   ① 点顶栏模型名 → 下拉列 flash ✓ / pro / MiniMax disabled（FR-001/002/005）
//   ② 选 pro → 顶栏更新「DeepSeek 思考」+ 下拉关 → 发消息走 pro（mock 断言 PATCH + send）
//   ③ 切历史会话顶栏 model 跟随（会话 A=pro / B=flash，FR-007）
//   ④ 新建对话顶栏回 flash（FR-008）
//   ⑤ MiniMax 点击不可选、无副作用（FR-005 / state_branch #7）
//   ⑥ C1（state_branch #4）：选当前已选 model → 下拉关、无重复 PATCH（setModel 内部判等早返）
//   ⑦ 元数据端点失败 → 下拉降级内置默认（flash/pro），仍可切（FR-012 / state_branch #9）
//
// ── 数据驱动设计（干净上下文须知）──
// - 模型清单：use-models 走 orval GET /chat/models（端点失败 → resolveModels 降级内置默认）。
// - 会话级 model 切换：use-chat.setModel —— 当前会话**已落库**（有 conversationId）才触发
//   PATCH /chat/conversations/:id/model；**未落库**（首发前）仅内存态、不 PATCH。故验 PATCH /
//   C1 无重复 PATCH 前，必先发一条消息建会话（拿 conversationId）。
// - send 路由：与 027 同 SSE POST /conversations/:id/messages（model 由 server 按会话路由，
//   客户端不传 model 给 send；故「走 pro」在 UI 侧体现为顶栏 model + 已 PATCH 落 pro，send
//   仍是同一端点。server 按会话路由由 server IT/contract-smoke 兜底，e2e 验 UI 链路）。
// - 切历史会话：conversation list（含 model 字段）→ 点行 → selectConversation(id, model)
//   → 顶栏 model 跟随（FR-007）+ GET messages hydrate。
//
// ── auth 边界（per mobile-e2e-hermetic + memory authed_business_401…）──
// seed localStorage 只含 refreshToken/accountId/displayName → boot 走 refresh-token flow。
// 故必 mock refresh-token（否则误登出跳 /login）+ mock /me。models/PATCH/send/list/messages
// 走 orval(axios) 或裸 fetch(SSE) authed，同受 003 refresh 拦截器保护。
//
// 开关 tap 驱动（顶栏 tap 开 / 遮罩 tap 关 / 选项 tap 关，per RNGH web 手势非确定 memory）。
// Expo Stack 叠屏后底层屏仍挂 DOM → 优先 testID 收窄定位。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const MODELS_URL = '**/api/v1/chat/models';
const CONVERSATIONS_GLOB = '**/api/v1/chat/conversations/**';
const CONVERSATIONS_COLLECTION = '**/api/v1/chat/conversations';
const CONVERSATIONS_COLLECTION_QUERY = '**/api/v1/chat/conversations?*';

const SEED_ACCOUNT_ID = 'acc-e2e-029';
const SEED_REFRESH_TOKEN = 'refresh-e2e-029';
const SEED_ACCESS_TOKEN = 'access-e2e-029';
const SEED_DISPLAY_NAME = '阿白';
const SEED_PHONE = '+8613900139029';

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

const JSON_HEADERS = { 'access-control-allow-origin': '*' };

/** server 常量派生模型清单（与 list-models UC 一致：flash/pro/minimax 均可用）。 */
const MODELS_BODY = {
  models: [
    { id: 'flash', label: '快速', description: '响应迅速，适合日常问答', available: true },
    { id: 'pro', label: '思考', description: '深度推理，适合复杂问题', available: true },
    { id: 'minimax', label: 'MiniMax', description: '海螺 M3，长上下文通用', available: true },
  ],
};

/** 顶栏模型名映射（与 chat-copy.CHAT_MODEL_NAME 一致）。 */
const TOPBAR_FLASH = 'DeepSeek 快速';
const TOPBAR_PRO = 'DeepSeek 思考';
const TOPBAR_MINIMAX = 'MiniMax M3';

/** 一个 SSE token 帧（与 server sse 契约一致）。 */
const tokenFrame = (token: string) => `data: ${JSON.stringify({ token })}\n\n`;
const DONE_FRAME = 'data: [DONE]\n\n';

interface ConvRow {
  id: string;
  title: string;
  model: string;
  updatedAt: string;
}

interface ChatMock {
  /** 已发起 PATCH set-model 的明细（验落 pro / C1 无重复）。 */
  patchModelCalls: () => { id: string; model: string }[];
  /** 已发起 SSE send 计数。 */
  sendCount: () => number;
  /** 内存会话表当前 model 快照（断言落库）。 */
  convModel: (id: string) => string | undefined;
}

/** N 天前 ISO（落进时间分组）。 */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// 单一 stateful mock：models / 建会话 / SSE send / 取消息(hydrate) / list / PATCH set-model。
async function installModelSwitchMock(
  page: Page,
  seed: {
    convs?: ConvRow[];
    messagesById?: Record<string, { id: string; role: string; status: string; content: string }[]>;
  } = {},
): Promise<ChatMock> {
  let convs = [...(seed.convs ?? [])];
  const messagesById = seed.messagesById ?? {};
  let createdSeq = 0;
  let sendSeq = 0;
  const patchModelCalls: { id: string; model: string }[] = [];

  // 模型元数据（常量派生 flash/pro + MiniMax 留位）。
  await mockJson(page, MODELS_URL, 200, MODELS_BODY, 'GET');

  // list 处理（GET collection，支持 ?q；本 spec 不搜，全量返回）。
  const handleList = async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify({ items: convs }),
    });
  };

  // collection（GET list / POST 建会话）。注：glob 末尾 ** 不匹配无路径段 collection，单注册。
  await page.route(CONVERSATIONS_COLLECTION, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (method === 'GET') return void (await handleList(route));
    if (method === 'POST') {
      createdSeq += 1;
      const id = `conv-new-${createdSeq}`;
      // 新会话默认 flash 落库（FR-008）。
      convs = [
        { id, title: '新对话', model: 'flash', updatedAt: new Date().toISOString() },
        ...convs,
      ];
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id, title: '新对话', model: 'flash' }),
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

  // /conversations/:id（/messages send + hydrate / :id/model set-model）。
  await page.route(CONVERSATIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;

    // ── PATCH /conversations/:id/model（029 set-model；记录 + 改内存 model，回显）──
    if (path.endsWith('/model') && method === 'PATCH') {
      const id = path.split('/').slice(-2)[0];
      const body = (req.postDataJSON() ?? {}) as { model?: string };
      const model = body.model ?? '';
      patchModelCalls.push({ id, model });
      convs = convs.map((c) => (c.id === id ? { ...c, model } : c));
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id, model, updatedAt: new Date().toISOString() }),
      }));
    }

    // ── GET /conversations/:id/messages（切换 hydrate）──
    // 注：新建会话首发后 setLastConversationId 会触发本 GET。若立即返回 []，hydrate effect
    // 会 clobber 进行中/刚完成的内存流（dispatch hydrate 重置态机）。hydrate 设计是**冷启**
    // 复原，本场景是活跃发送。故对**新建会话**（无 seeded 消息）把 GET 延到断言窗口外（同
    // 027 chat-streaming spec 范式）；对**预置历史会话**（有 seeded 消息）立即返回供切换 hydrate。
    if (path.endsWith('/messages') && method === 'GET') {
      const id = path.split('/').slice(-2)[0];
      const seeded = messagesById[id];
      if (!seeded) {
        await new Promise((r) => setTimeout(r, 30_000));
      }
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: seeded ?? [] }),
      }));
    }

    // ── POST /conversations/:id/messages（SSE 流式发消息）──
    if (path.endsWith('/messages') && method === 'POST') {
      sendSeq += 1;
      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
        body: ['你好', '，', '我是', 'AI'].map(tokenFrame).join('') + DONE_FRAME,
      }));
    }

    await route.fallback();
  });

  return {
    patchModelCalls: () => patchModelCalls,
    sendCount: () => sendSeq,
    convModel: (id) => convs.find((c) => c.id === id)?.model,
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

/** 进首页 chat 屏（首 tab = ChatHomeScreen）。 */
async function gotoChat(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '首页' }).tap();
  await expect(page.getByTestId('chat-empty-state')).toBeVisible({ timeout: 15_000 });
}

/** 打开模型下拉（tap 顶栏模型名）。 */
async function openModelDropdown(page: Page) {
  await page.getByTestId('chat-model-switcher-button').tap();
  await expect(page.getByTestId('chat-model-dropdown')).toBeVisible({ timeout: 10_000 });
}

/** 发一条消息（建会话 + SSE 流完成），等末条 AI 回复落定（拿 conversationId 供后续 PATCH）。
 *  多轮时 assistant 气泡多条 → 断言 last（strict mode 防多命中）。 */
async function sendOneMessage(page: Page, text: string) {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send-button').tap();
  await expect(page.getByTestId('chat-message-assistant').last()).toContainText('我是AI', {
    timeout: 15_000,
  });
}

test('029 模型切换 — 下拉列 flash ✓/pro/minimax 均可选 + 选 pro 顶栏更新 + 走 pro（US1/US3）', async ({
  page,
}) => {
  const mock = await installModelSwitchMock(page);
  await gotoChat(page);

  // 顶栏默认 flash（新会话默认，FR-008）。
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_FLASH);

  // ── ① 点顶栏模型名 → 下拉 flash ✓ / pro / minimax 均可选（FR-001/002）──
  await openModelDropdown(page);
  await expect(page.getByTestId('chat-model-option-flash')).toBeVisible();
  await expect(page.getByTestId('chat-model-option-pro')).toBeVisible();
  await expect(page.getByTestId('chat-model-option-minimax')).toBeVisible();
  // 当前 flash 打勾（check icon 在位）。
  await expect(page.getByTestId('chat-model-check-flash')).toBeVisible();
  // minimax 可选（029 收口接入：无「即将上线」pill、不 disabled）。
  await expect(page.getByTestId('chat-model-coming-soon-minimax')).toHaveCount(0);
  await expect(page.getByTestId('chat-model-option-minimax')).toBeEnabled();

  // ── 先发一条建会话（拿 conversationId，使后续切换走 PATCH 持久化）──
  // 关下拉再发（下拉遮罩盖住输入条）。
  await page.getByTestId('chat-model-dropdown-backdrop').tap();
  await expect(page.getByTestId('chat-model-dropdown')).toHaveCount(0, { timeout: 10_000 });
  await sendOneMessage(page, '你好');

  // ── ② 选 pro → 顶栏更新「思考」+ 下拉关 + PATCH 落 pro（FR-003/004）──
  await openModelDropdown(page);
  await page.getByTestId('chat-model-option-pro').tap();
  await expect(page.getByTestId('chat-model-dropdown')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_PRO);

  // PATCH 落 pro（会话级记忆持久化）。
  await expect.poll(() => mock.patchModelCalls().length).toBe(1);
  expect(mock.patchModelCalls()[0]?.model).toBe('pro');

  // ── ③ 切到 pro 后再发一条 → send 端点照常（走该会话 model=pro，server 路由）──
  await sendOneMessage(page, '深度分析一下');
  expect(mock.sendCount()).toBe(2);
});

test('029 模型切换 — 选当前已选 model → 下拉关、无重复 PATCH（C1 / state_branch #4）', async ({
  page,
}) => {
  const mock = await installModelSwitchMock(page);
  await gotoChat(page);

  // 先发一条建会话 + 切到 pro（落一次 PATCH）。
  await sendOneMessage(page, '你好');
  await openModelDropdown(page);
  await page.getByTestId('chat-model-option-pro').tap();
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_PRO);
  await expect.poll(() => mock.patchModelCalls().length).toBe(1);

  // ── C1：再开下拉，选当前已选 pro → 下拉关、顶栏不变、无第二次 PATCH（setModel 判等早返）──
  await openModelDropdown(page);
  // 当前 pro 打勾在位。
  await expect(page.getByTestId('chat-model-check-pro')).toBeVisible();
  await page.getByTestId('chat-model-option-pro').tap();
  await expect(page.getByTestId('chat-model-dropdown')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_PRO);

  // 关键断言：PATCH 仍只 1 次（无重复写，state_branch #4）。给一窗口确认无迟到 PATCH。
  await page.waitForTimeout(500);
  expect(mock.patchModelCalls().length).toBe(1);
});

test('029 模型切换 — 选 minimax → 顶栏更新「MiniMax M3」+ PATCH 落 minimax（029 收口）', async ({
  page,
}) => {
  const mock = await installModelSwitchMock(page);
  await gotoChat(page);
  // 先发一条建会话（拿 conversationId，使切换走 PATCH 持久化）。
  await sendOneMessage(page, '你好');

  // ── 选 minimax → 顶栏更新「MiniMax M3」+ 下拉关 + PATCH 落 minimax（FR-003/004）──
  await openModelDropdown(page);
  await page.getByTestId('chat-model-option-minimax').tap();
  await expect(page.getByTestId('chat-model-dropdown')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_MINIMAX);

  await expect.poll(() => mock.patchModelCalls().length).toBe(1);
  expect(mock.patchModelCalls()[0]?.model).toBe('minimax');
});

test('029 模型切换 — 切历史会话顶栏 model 跟随（A=pro / B=flash，FR-007）', async ({ page }) => {
  // 两历史会话：A=pro / B=flash，各带消息（切换 hydrate 进对话态）。
  const convs: ConvRow[] = [
    { id: 'conv-a', title: '投资分析', model: 'pro', updatedAt: daysAgoIso(1) },
    { id: 'conv-b', title: '随手问', model: 'flash', updatedAt: daysAgoIso(2) },
  ];
  await installModelSwitchMock(page, {
    convs,
    messagesById: {
      'conv-a': [{ id: 'a1', role: 'user', status: 'completed', content: 'A 会话消息' }],
      'conv-b': [{ id: 'b1', role: 'user', status: 'completed', content: 'B 会话消息' }],
    },
  });
  await gotoChat(page);

  // 开抽屉 → 点会话 A（pro）→ 顶栏跟随 pro。
  await page.getByTestId('chat-menu-button').tap();
  await expect(page.getByTestId('chat-drawer-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('conversation-row').filter({ hasText: '投资分析' }).tap();
  await expect(page.getByTestId('chat-drawer-panel')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('chat-message-user')).toContainText('A 会话消息', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_PRO);

  // 再切会话 B（flash）→ 顶栏跟随 flash（会话级记忆，FR-007）。
  await page.getByTestId('chat-menu-button').tap();
  await expect(page.getByTestId('chat-drawer-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('conversation-row').filter({ hasText: '随手问' }).tap();
  await expect(page.getByTestId('chat-drawer-panel')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('chat-message-user')).toContainText('B 会话消息', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_FLASH);
});

test('029 模型切换 — 新建对话顶栏回 flash（FR-008）', async ({ page }) => {
  const convs: ConvRow[] = [
    { id: 'conv-a', title: '投资分析', model: 'pro', updatedAt: daysAgoIso(1) },
  ];
  await installModelSwitchMock(page, {
    convs,
    messagesById: {
      'conv-a': [{ id: 'a1', role: 'user', status: 'completed', content: 'A 会话消息' }],
    },
  });
  await gotoChat(page);

  // 切到 pro 会话 A → 顶栏 pro。
  await page.getByTestId('chat-menu-button').tap();
  await page.getByTestId('conversation-row').filter({ hasText: '投资分析' }).tap();
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_PRO, { timeout: 15_000 });

  // 新建对话（抽屉「新建对话」）→ 回空态 + 顶栏回 flash（FR-008）。
  await page.getByTestId('chat-menu-button').tap();
  await page.getByTestId('chat-drawer-new-conversation').tap();
  await expect(page.getByTestId('chat-empty-state')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_FLASH);
});

test('029 模型切换 — 元数据端点失败降级内置默认仍可切（FR-012 / state_branch #9）', async ({
  page,
}) => {
  // 元数据端点 500 → use-models resolveModels 降级内置默认（flash/pro/minimax 均可用）。
  await page.route(MODELS_URL, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    await route.fulfill({ status: 500, headers: JSON_HEADERS, body: '{}' });
  });
  const mock = await installModelSwitchMockSansModels(page);
  await gotoChat(page);
  await sendOneMessage(page, '你好');

  // 下拉仍出（降级内置默认 flash/pro/minimax）→ 选 pro 仍可切（不阻塞，FR-012）。
  await openModelDropdown(page);
  await expect(page.getByTestId('chat-model-option-flash')).toBeVisible();
  await expect(page.getByTestId('chat-model-option-pro')).toBeVisible();
  // 降级清单含 minimax（029 收口起入内置默认，已 GA）。
  await expect(page.getByTestId('chat-model-option-minimax')).toBeVisible();

  await page.getByTestId('chat-model-option-pro').tap();
  await expect(page.getByTestId('chat-model-name')).toHaveText(TOPBAR_PRO);
  await expect.poll(() => mock.patchModelCalls().length).toBe(1);
});

// 元数据端点已被 test 自身 500-mock（降级场景），不再注册 models 路由的变体。
async function installModelSwitchMockSansModels(page: Page): Promise<ChatMock> {
  let convs: ConvRow[] = [];
  let createdSeq = 0;
  let sendSeq = 0;
  const patchModelCalls: { id: string; model: string }[] = [];

  await page.route(CONVERSATIONS_COLLECTION, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (method === 'POST') {
      createdSeq += 1;
      const id = `conv-new-${createdSeq}`;
      convs = [{ id, title: '新对话', model: 'flash', updatedAt: new Date().toISOString() }];
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id, title: '新对话', model: 'flash' }),
      }));
    }
    if (method === 'GET') {
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ items: convs }),
      }));
    }
    await route.fallback();
  });

  await page.route(CONVERSATIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname;

    if (path.endsWith('/model') && method === 'PATCH') {
      const id = path.split('/').slice(-2)[0];
      const body = (req.postDataJSON() ?? {}) as { model?: string };
      patchModelCalls.push({ id, model: body.model ?? '' });
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id, model: body.model ?? '', updatedAt: new Date().toISOString() }),
      }));
    }
    if (path.endsWith('/messages') && method === 'GET') {
      // 降级 spec 仅新建会话（无 seeded 消息）→ 延后 GET 避免 hydrate clobber 活跃流（同上）。
      await new Promise((r) => setTimeout(r, 30_000));
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: [] }),
      }));
    }
    if (path.endsWith('/messages') && method === 'POST') {
      sendSeq += 1;
      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
        body: ['你好', '，', '我是', 'AI'].map(tokenFrame).join('') + DONE_FRAME,
      }));
    }
    await route.fallback();
  });

  return {
    patchModelCalls: () => patchModelCalls,
    sendCount: () => sendSeq,
    convModel: (id) => convs.find((c) => c.id === id)?.model,
  };
}
