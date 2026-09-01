import { expect, test, type Page, type Route } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 028-chat-history-drawer — Expo Web e2e（hermetic mock，PR §V 第一层 UI 交互验证）。
//
// 覆盖 spec state_branches 的 mobile 侧 + US1-US4 验收：
//   开抽屉 → 时间分组列表（前7天/前30天/YYYY年）
//   点会话 → 切换 hydrate 该会话消息 + 关抽屉回对话态（US1，FR-004）
//   新建对话 → 清空回 027 空态 + 关抽屉（US2，FR-005）
//   改名 → 空标题禁用「确定」+ 提交反映列表行（US3，FR-006）
//   删除 → 二次确认 + 列表移除该行（US3，FR-007 / SC-005）
//   删当前会话 → 删后回空态（US3，FR-008）
//   搜索 → 标题模糊命中筛选 + 清空回全量 + 无命中空态（US4，FR-009）
//   齿轮 → 跳设置（FR-010 / D8）
//
// ── 数据驱动设计（干净上下文须知）──
// 抽屉列表走 use-conversations（useInfiniteQuery + orval raw queryFn 打 GET /conversations，
// 支持 ?q 标题搜索）；rename/delete 走 orval mutation hook（PATCH/DELETE），成功后
// invalidateQueries(['conversations']) 重取列表。故本 mock 是 **stateful**：维护一份内存
// 会话表，PATCH 改标题 / DELETE 删行后，下一次 GET list 反映变更（验「列表行即时反映」）。
//
// 切换 hydrate：点行 → use-chat.selectConversation(id) → setLastConversationId(id) →
// useConversationControllerMessages(id) 重取 → GET /conversations/:id/messages → hydrate
// dispatch → 主屏渲 chat-message-list（验 US1 切换恢复消息）。故 messages mock 按 id 返
// 该会话已落库消息（非空 → 主屏进对话态；空 → 主屏回空态，覆盖「删当前回空态」断言锚）。
//
// ── auth 边界（per mobile-e2e-hermetic rule + memory authed_business_401…）──
// seed localStorage 只含 refreshToken/accountId/displayName（store partialize 不持久化
// accessToken）→ boot 走 refresh-token flow。故必 mock refresh-token（否则误登出跳 /login）
// + mock /me（seed-auth e2e 硬强制）。list/rename/delete/messages 走 orval(axios) authed，
// 同受 003 refresh 拦截器保护。
//
// 开关 tap 驱动（hamburger 开 / backdrop tap 关，per RNGH web 手势非确定 memory），不依赖 pan。
// Expo Stack 叠屏后底层屏仍挂 DOM → getByLabel/Text 可能双命中 → 优先 testID / getByRole 收窄。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const CONVERSATIONS_GLOB = '**/api/v1/chat/conversations/**';
const CONVERSATIONS_COLLECTION = '**/api/v1/chat/conversations';
// `?q=...` 落在 collection 路径上（pathname 无尾段），故 collection glob 也要带 query 变体匹配。
const CONVERSATIONS_COLLECTION_QUERY = '**/api/v1/chat/conversations?*';

const SEED_ACCOUNT_ID = 'acc-e2e-028';
const SEED_REFRESH_TOKEN = 'refresh-e2e-028';
const SEED_ACCESS_TOKEN = 'access-e2e-028';
const SEED_DISPLAY_NAME = '小红';
const SEED_PHONE = '+8613900139028';

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

/** 抽屉列表 mock 行（与 ConversationListItemResponse 契约一致）。 */
interface ConvRow {
  id: string;
  title: string;
  model: string;
  updatedAt: string; // ISO-8601（client 时间分组依据）
}

/** 相对当前时刻 N 天前的 ISO（用于落进「前7天/前30天/更早」分组）。 */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** N 年前同月日的 ISO（落进「YYYY 年」更早分组）。 */
function yearsAgoIso(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString();
}

interface HistoryMock {
  /** 当前 GET list 已请求次数（验重取 / invalidate）。 */
  listCount: () => number;
  /** 当前内存会话表快照（断言列表状态）。 */
  rows: () => ConvRow[];
}

// stateful 历史会话 mock：list（含 ?q 标题筛选）/ rename（改内存标题）/ delete（删内存行）/
// messages（按 id 返该会话消息，空表示空态）。GET 始终反映最新内存表（验改名回显 / 删除移除）。
async function installHistoryMock(
  page: Page,
  seed: {
    convs: ConvRow[];
    /** 各会话的已落库消息（切换 hydrate 用）；缺省 = 空（切换后主屏回空态）。 */
    messagesById?: Record<string, { id: string; role: string; status: string; content: string }[]>;
  },
): Promise<HistoryMock> {
  let convs = [...seed.convs];
  const messagesById = seed.messagesById ?? {};
  let listSeq = 0;

  const jsonHeaders = { 'access-control-allow-origin': '*' };

  // list 处理（GET collection，支持 ?q 标题模糊子串、大小写不敏感）。
  const handleList = async (route: Route) => {
    listSeq += 1;
    const url = new URL(route.request().url());
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const matched = q ? convs.filter((c) => c.title.toLowerCase().includes(q)) : convs;
    // 单页返回（mock 不分页：nextCursor 缺省 → useInfiniteQuery 停止翻页）。
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: jsonHeaders,
      body: JSON.stringify({ items: matched }),
    });
  };

  // collection（GET list / 无 query 变体）。
  await page.route(CONVERSATIONS_COLLECTION, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (method === 'GET') return void (await handleList(route));
    await route.fallback();
  });
  // collection + ?q（搜索）。
  await page.route(CONVERSATIONS_COLLECTION_QUERY, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (method === 'GET') return void (await handleList(route));
    await route.fallback();
  });

  // /conversations/:id 与 /conversations/:id/messages（rename / delete / hydrate）。
  await page.route(CONVERSATIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;

    // ── GET /conversations/:id/messages（切换 hydrate）──
    if (path.endsWith('/messages') && method === 'GET') {
      const id = path.split('/').slice(-2)[0];
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: jsonHeaders,
        body: JSON.stringify({ messages: messagesById[id] ?? [] }),
      }));
    }

    const id = path.split('/').pop() ?? '';

    // ── PATCH /conversations/:id（改名，内存改标题，回显新 title）──
    if (method === 'PATCH') {
      const body = (req.postDataJSON() ?? {}) as { title?: string };
      const title = (body.title ?? '').trim();
      convs = convs.map((c) => (c.id === id ? { ...c, title } : c));
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: jsonHeaders,
        body: JSON.stringify({ id, title, updatedAt: new Date().toISOString() }),
      }));
    }

    // ── DELETE /conversations/:id（删内存行，204）──
    if (method === 'DELETE') {
      convs = convs.filter((c) => c.id !== id);
      return void (await route.fulfill({ status: 204, headers: jsonHeaders }));
    }

    await route.fallback();
  });

  return { listCount: () => listSeq, rows: () => convs };
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

/** 打开抽屉（hamburger tap 开），等面板就位。 */
async function openDrawer(page: Page) {
  await page.getByTestId('chat-menu-button').tap();
  await expect(page.getByTestId('chat-drawer-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('conversation-list')).toBeVisible({ timeout: 10_000 });
}

// 三条历史会话，分别落进「前7天」「前30天」「更早 YYYY 年」三组，验时间分组（SC-003）。
const RECENT_TITLE = '贵州茅台分析';
const MID_TITLE = '上海周末天气';
const OLD_TITLE = '去年的旅行计划';

function seedConvs(): ConvRow[] {
  return [
    { id: 'conv-recent', title: RECENT_TITLE, model: 'deepseek-chat', updatedAt: daysAgoIso(1) },
    { id: 'conv-mid', title: MID_TITLE, model: 'deepseek-chat', updatedAt: daysAgoIso(15) },
    { id: 'conv-old', title: OLD_TITLE, model: 'deepseek-chat', updatedAt: yearsAgoIso(2) },
  ];
}

test('028 历史抽屉 — 开抽屉 + 时间分组 + 切换 hydrate + 关抽屉（US1）', async ({ page }) => {
  const mock = await installHistoryMock(page, {
    convs: seedConvs(),
    messagesById: {
      'conv-recent': [
        { id: 'm1', role: 'user', status: 'completed', content: '帮我分析贵州茅台' },
        { id: 'm2', role: 'assistant', status: 'completed', content: '贵州茅台是白酒龙头。' },
      ],
    },
  });
  await gotoChat(page);

  // ── 开抽屉 → 时间分组列表 ──
  await openDrawer(page);
  // 三组 header（前7天 / 前30天 / YYYY 年）+ 三行会话。
  await expect(page.getByTestId('conversation-group-header')).toHaveCount(3);
  await expect(page.getByTestId('conversation-row')).toHaveCount(3);
  // 最近组在前（贵州茅台），更早组靠后（去年旅行）。
  await expect(page.getByTestId('conversation-row').first()).toContainText(RECENT_TITLE);

  // ── 点会话切换 hydrate + 关抽屉 ──
  await page.getByTestId('conversation-row').first().tap();
  // 抽屉关闭（panel unmount）。
  await expect(page.getByTestId('chat-drawer-panel')).toHaveCount(0, { timeout: 10_000 });
  // 主屏进对话态：hydrate 出该会话已落库消息（US1 切换恢复消息，FR-004）。
  await expect(page.getByTestId('chat-message-user')).toContainText('帮我分析贵州茅台', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-message-assistant')).toContainText('贵州茅台是白酒龙头', {
    timeout: 15_000,
  });

  // list 至少取过一次（开抽屉时）。
  expect(mock.listCount()).toBeGreaterThanOrEqual(1);
});

test('028 历史抽屉 — 新建对话回空态 + 关抽屉（US2）', async ({ page }) => {
  await installHistoryMock(page, {
    convs: seedConvs(),
    messagesById: {
      'conv-recent': [
        { id: 'm1', role: 'user', status: 'completed', content: '老消息' },
        { id: 'm2', role: 'assistant', status: 'completed', content: '老回复' },
      ],
    },
  });
  await gotoChat(page);
  await openDrawer(page);

  // 先切到一个有消息的会话 → 主屏进对话态。
  await page.getByTestId('conversation-row').first().tap();
  await expect(page.getByTestId('chat-message-user')).toContainText('老消息', { timeout: 15_000 });

  // 再开抽屉点「新建对话」→ 清空回空态 + 关抽屉（US2，FR-005）。
  await openDrawer(page);
  await page.getByTestId('chat-drawer-new-conversation').tap();
  await expect(page.getByTestId('chat-drawer-panel')).toHaveCount(0, { timeout: 10_000 });
  // 回 027 空态（带昵称问候），消息列表清空（未发首条前不落库新会话）。
  await expect(page.getByTestId('chat-empty-state')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-message-user')).toHaveCount(0);
});

test('028 历史抽屉 — 改名（空禁用确定 + 提交反映列表）（US3，FR-006）', async ({ page }) => {
  const mock = await installHistoryMock(page, { convs: seedConvs() });
  await gotoChat(page);
  await openDrawer(page);

  // 打开最近会话行的 ⋯ 菜单 → 重命名。
  await page.getByTestId('conversation-row-menu-button').first().tap();
  await expect(page.getByTestId('conversation-row-menu')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('conversation-menu-rename').tap();

  // 进行内编辑：清空输入 → 「确定」禁用（FR-006 空标题禁用）。
  const input = page.getByTestId('conversation-rename-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill('   '); // 纯空白 → trim 后空 → 禁用
  const confirm = page.getByTestId('conversation-rename-confirm');
  await expect(confirm).toBeDisabled();

  // 填入新标题 → 确定可用 → 提交 → 列表行即时反映新标题（invalidate 重取）。
  const NEW_TITLE = '茅台深度复盘';
  await input.fill(NEW_TITLE);
  await expect(confirm).toBeEnabled();
  await confirm.tap();

  // 改名行收起 + 列表出现新标题行（GET 重取反映内存改名）。
  await expect(page.getByTestId('conversation-rename-row')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('conversation-row').filter({ hasText: NEW_TITLE })).toBeVisible({
    timeout: 15_000,
  });
  // 内存表确已改名（mock 端验落库语义）。
  await expect.poll(() => mock.rows().find((c) => c.id === 'conv-recent')?.title).toBe(NEW_TITLE);
});

test('028 历史抽屉 — 删除二次确认 + 列表移除（US3，FR-007 / SC-005）', async ({ page }) => {
  const mock = await installHistoryMock(page, { convs: seedConvs() });
  await gotoChat(page);
  await openDrawer(page);

  await expect(page.getByTestId('conversation-row')).toHaveCount(3);

  // ⋯ → 删除 → 居中二次确认（复用 ConfirmModal：标题「删除对话」，确认 a11y「删除」）。
  await page.getByTestId('conversation-row-menu-button').first().tap();
  await page.getByTestId('conversation-menu-delete').tap();
  // 二次确认弹窗（标题文案定位，SC-005）。
  await expect(page.getByText('删除对话')).toBeVisible({ timeout: 10_000 });
  // 点确认「删除」（ConfirmModal 确认按钮 accessibilityLabel = 「删除」，role=button 收窄）。
  await page.getByRole('button', { name: '删除', exact: true }).tap();

  // 列表移除该行（DELETE 204 → invalidate 重取，剩 2 条）。
  await expect(page.getByTestId('conversation-row')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId('conversation-row').filter({ hasText: RECENT_TITLE })).toHaveCount(
    0,
  );
  await expect.poll(() => mock.rows().length).toBe(2);
});

test('028 历史抽屉 — 删当前正打开会话 → 删后回空态（US3，FR-008）', async ({ page }) => {
  await installHistoryMock(page, {
    convs: seedConvs(),
    messagesById: {
      'conv-recent': [
        { id: 'm1', role: 'user', status: 'completed', content: '当前会话消息' },
        { id: 'm2', role: 'assistant', status: 'completed', content: '当前会话回复' },
      ],
    },
  });
  await gotoChat(page);
  await openDrawer(page);

  // 切到 conv-recent（变当前会话）→ 主屏进对话态。
  await page.getByTestId('conversation-row').first().tap();
  await expect(page.getByTestId('chat-message-user')).toContainText('当前会话消息', {
    timeout: 15_000,
  });

  // 再开抽屉删该当前会话。
  await openDrawer(page);
  await page.getByTestId('conversation-row-menu-button').first().tap();
  await page.getByTestId('conversation-menu-delete').tap();
  await page.getByRole('button', { name: '删除', exact: true }).tap();

  // 列表移除该行。
  await expect(page.getByTestId('conversation-row')).toHaveCount(2, { timeout: 15_000 });
  // 关抽屉 → 主屏应回空态（删的是当前会话，FR-008）。backdrop 在面板之下，仅面板右侧未覆盖
  // 区域可点（面板 82% 宽）→ tap 命中右侧空白处（中心点会被底部用户区拦截）。
  const backdrop = page.getByTestId('chat-drawer-backdrop');
  const box = await backdrop.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2);
  }
  await expect(page.getByTestId('chat-drawer-panel')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('chat-empty-state')).toBeVisible({ timeout: 15_000 });
});

test('028 历史抽屉 — 搜索命中 + 清空回全量 + 无命中空态（US4，FR-009）', async ({ page }) => {
  await installHistoryMock(page, { convs: seedConvs() });
  await gotoChat(page);
  await openDrawer(page);

  await expect(page.getByTestId('conversation-row')).toHaveCount(3);

  const search = page.getByTestId('chat-drawer-search-input');

  // ── 命中：搜「茅台」→ 仅 1 条命中 + 平铺「N 个结果」+ 关键词高亮 ──
  await search.fill('茅台');
  await expect(page.getByTestId('conversation-search-count')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('conversation-row')).toHaveCount(1);
  await expect(page.getByTestId('conversation-row')).toContainText(RECENT_TITLE);
  await expect(page.getByTestId('conversation-search-highlight').first()).toBeVisible();
  // 搜索态平铺，无分组 header。
  await expect(page.getByTestId('conversation-group-header')).toHaveCount(0);

  // ── 清空 → 回完整时间分组列表（3 行 + 3 组）──
  await page.getByTestId('chat-drawer-search-clear').tap();
  await expect(page.getByTestId('conversation-row')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId('conversation-group-header')).toHaveCount(3);

  // ── 无命中：搜不存在词 → 空结果态（不报错）──
  await search.fill('不存在的关键词xyz');
  await expect(page.getByTestId('conversation-search-no-match')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('conversation-row')).toHaveCount(0);
});

test('028 历史抽屉 — 底部齿轮跳设置（FR-010 / D8）', async ({ page }) => {
  await installHistoryMock(page, { convs: seedConvs() });
  await gotoChat(page);
  await openDrawer(page);

  // 底部用户区：昵称（useMe）+ 齿轮 → /(app)/settings。
  await expect(page.getByTestId('chat-drawer-user-name')).toContainText(SEED_DISPLAY_NAME);
  await page.getByTestId('chat-drawer-settings-button').tap();

  // 跳设置屏：账号与安全等设置卡片可见（settings/index 的「退出登录」是稳定锚）。
  await expect(page.getByText('退出登录')).toBeVisible({ timeout: 15_000 });
});
