import { expect, test, type Page, type Route } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 032 T017 — ideation 澄清主干 Expo Web e2e（hermetic mock，PR §V 第一层 UI 交互验证）。
//
// 覆盖 US1 端到端脊柱 + US3 chips（FR-001/003/004/005/006/008 的 UI 侧）：
//   ① + FAB → 创建浮层 → 选「prd灵感」→ 输标题 → 建会话 → push /ideation/[id]
//   ② 多轮澄清：第一轮自由文本发送 → 流式 token 渲反问气泡
//   ③ chips 轮：assistant turn 带 suggestion → chips 渲（推荐项 +「（推荐）」+ 末位逃生）
//   ④ chip 点选 → **直接发送（契约 §4.5：quick-reply 即发）**；逃生项转聚焦输入条自填
//   ⑤ AI 软提示 → 点「生成 brief」→ converged → 切 brief 预览面
//   ⑥ brief 结构化分段（T1 五段 + T2 接地段灰虚线占位在）→ 状态徽标「已收敛」
//   ⑦ 「复制 / 导出 markdown」→ Clipboard + 成功 toast
//
// ── SSE mock 范式（干净上下文须知，同 027 chat-streaming.spec）──
// Playwright `route.fulfill` 不支持「逐帧增量」流式响应：一次性把整个 text/event-stream body
// （所有 token 帧 + suggestion 帧 + [DONE]）fulfill。客户端 getReader() 读整 body →
// parseIdeationChunk 切多帧 → 逐 token dispatch + suggestion 收口 → done。**最终渲染态正确**
// 即验到渲染契约；真增量逐帧到达由 server IT（T010 reply.hijack 逐 write）兜底，e2e 不复验。
//
// ── auth 边界（per memory authed_business_401_triggers_refresh_interceptor + store.ts）──
// store.ts 不持久化 accessToken（冷启靠 refresh-token flow 重 derive）。seed localStorage 只含
// refreshToken/accountId/displayName → boot 走 refresh-token 拿 access token。故必 mock
// refresh-token（否则 AuthGate refresh 失败 → clearSession 跳 /login）+ mock /me。会话 CRUD /
// brief 走 orval(axios) authed，SSE 端点裸 fetch 自带 Bearer；本 mock 放行任意 Authorization。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const SESSIONS_GLOB = '**/api/v1/ideation/sessions/**';
const SESSIONS_COLLECTION = '**/api/v1/ideation/sessions';

const SEED_ACCOUNT_ID = 'acc-e2e-032';
const SEED_REFRESH_TOKEN = 'refresh-e2e-032';
const SEED_ACCESS_TOKEN = 'access-e2e-032';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139032';

const SESSION_ID = 'sess-1';
const SESSION_TITLE = '行情页收藏功能';

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

const SSE_HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': 'no-cache',
};

/** token 帧（契约同源：`data: {json}\n\n`，逐字符 drip）。 */
const tokenFrames = (text: string) =>
  [...text].map((c) => `data: ${JSON.stringify({ token: c })}\n\n`).join('');
/** suggestion 帧（过两闸才发，整出一帧收口）。 */
const suggestionFrame = (s: unknown) => `data: ${JSON.stringify({ suggestion: s })}\n\n`;
const DONE_FRAME = 'data: [DONE]\n\n';

/** 一轮 SSE 行为：问题文本 + 可选 chips。 */
type SseTurn = { question: string; suggestion?: unknown };

/** 收敛 brief（T1 五段齐 + T3 open_questions；T2 留空 → 屏渲占位）。 */
const CONVERGED_BRIEF = {
  problem: '用户在行情页频繁查看同几只重点股，缺少固定入口。',
  user_stories:
    'P1 作为活跃用户，我想收藏个股以便进页面快速查看。\nGiven 在详情页 When 点收藏 Then 入列表',
  functional_requirements:
    'FR-001 个股详情页提供收藏 / 取消收藏切换\nFR-002 收藏列表进页面拉一次，展示最近 20 条',
  success_criteria: '上线 4 周内 30% 活跃用户至少收藏 1 只个股。',
  non_goals: '不做板块 / 指数收藏；不做收藏分组 / 排序。',
  open_questions: '收藏上限 20 条之外的处理是否二期细化？',
};

interface IdeationMock {
  /** 设定下一次发 turn 的 SSE 行为。 */
  setSse: (turn: SseTurn) => void;
  createCount: () => number;
  turnCount: () => number;
}

// 单一 stateful ideation mock：建会话 / 取详情(turns+brief) / SSE 发 turn / 生成 brief / 导出。
async function installIdeationMock(page: Page): Promise<IdeationMock> {
  let createdSeq = 0;
  let turnSeq = 0;
  let briefGenerated = false;
  // 累积已落库 turn（GET 详情 hydrate 用，stateful 反映 server append-only 真相）。每轮 POST
  // turns push user+assistant（含该轮 content + suggestion）→ 详情 GET 无条件返回。SSE mock 一次性
  // 全帧 → UI 内存驱动渲染；活跃流期间重取被 reducer streaming 守卫挡回灌。
  const turns: { id: string; role: string; content: string; suggestion: unknown }[] = [];
  let sse: SseTurn = { question: '默认问题' };

  // ── /ideation/sessions/** （详情 GET / SSE turns POST / brief / export / reopen）──
  await page.route(SESSIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;

    // SSE 发 turn（POST .../{id}/turns）：一次性全帧（token + 可选 suggestion + [DONE]）。
    if (path.endsWith('/turns') && method === 'POST') {
      turnSeq += 1;
      const mode = sse;
      // FU-1 镜像真相：回显 POST body 的真实 content（真 server 持久化提交文本）。写死占位会让 turn
      // 终态 invalidate→hydrate 用占位冲掉乐观显示的真实 user turn 文本 → chip 断言 race-flaky（#524 引爆）。
      const userContent =
        (req.postDataJSON() as { content?: string } | null)?.content ?? '（用户输入）';
      turns.push({
        id: `t-user-${turnSeq}`,
        role: 'user',
        content: userContent,
        suggestion: null,
      });
      turns.push({
        id: `t-ai-${turnSeq}`,
        role: 'assistant',
        content: mode.question,
        suggestion: mode.suggestion ?? null,
      });
      const body =
        tokenFrames(mode.question) +
        (mode.suggestion ? suggestionFrame(mode.suggestion) : '') +
        DONE_FRAME;
      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: SSE_HEADERS,
        body,
      }));
    }

    // 生成 brief（POST .../{id}/brief）：converged → 落 brief。
    if (path.endsWith('/brief') && method === 'POST') {
      briefGenerated = true;
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ converged: true, briefJson: CONVERGED_BRIEF, missing: [] }),
      }));
    }

    // 导出 markdown（GET .../{id}/brief/export）：返 markdown + handed-off。
    if (path.endsWith('/brief/export') && method === 'GET') {
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          markdown: '# 行情页收藏功能\n\n## 问题动机\n用户缺少固定入口。',
          status: 'handed-off',
        }),
      }));
    }

    // 列设计稿（GET .../{id}/mockups）：037 viewer 读列表。本 spec 仅验「brief→设计稿」导航打通，
    // 返空列表即可（屏挂载即导航成功，空态非错误）；须先于下方通用详情 GET 命中。
    if (path.endsWith('/mockups') && method === 'GET') {
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ items: [] }),
      }));
    }

    // 取详情（GET .../{id}）：含 turns + brief（brief 生成前 null，生成后带）。
    if (method === 'GET') {
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          id: SESSION_ID,
          title: SESSION_TITLE,
          status: briefGenerated ? 'converged' : 'open',
          repo: null,
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z',
          // 🚨 详情 GET 实时反映 server append-only 真相（同 ideation-sessions.spec 范式）：
          //   每轮 POST turns 已把 user+assistant turn（含该轮 content + suggestion）push 进
          //   turns 数组 → 此处无条件返回。FU-1 澄清轮终态 invalidate 触发的重取，须拿到已落
          //   turns（含 chips 轮的 suggestion），否则 hydrate 会用空 turns 冲掉刚流式出的气泡 /
          //   丢 chips。活跃流期间的重取由 reducer streaming 守卫挡回灌（内存渲染为真相）。
          turns,
          brief: briefGenerated
            ? {
                briefJson: CONVERGED_BRIEF,
                createdAt: '2026-06-22T00:00:00.000Z',
                updatedAt: '2026-06-22T00:00:00.000Z',
              }
            : null,
        }),
      }));
    }

    await route.fallback();
  });

  // 建会话 collection（POST /ideation/sessions，无 :id）。glob 末尾 ** 不匹配无路径段 collection。
  await page.route(SESSIONS_COLLECTION, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (method === 'POST') {
      createdSeq += 1;
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          id: SESSION_ID,
          title: SESSION_TITLE,
          status: 'open',
          repo: null,
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z',
        }),
      }));
    }
    await route.fallback();
  });

  return {
    setSse: (turn) => {
      sse = turn;
    },
    createCount: () => createdSeq,
    turnCount: () => turnSeq,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'])
    .catch(() => {
      /* 部分浏览器不支持 —— 复制断言放宽到 toast（不读剪贴板内容）。 */
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

/** 进首页（tab bar 就位 = auth boot 完成）。FAB 在 tabs 根层常驻。 */
async function gotoHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '首页' }).tap();
}

test('032 ideation — FAB 建会话 → 多轮澄清（chips 点选 + 自由文本）→ 生成 brief → 导出复制 → 设计稿入口（hermetic）', async ({
  page,
}) => {
  const mock = await installIdeationMock(page);
  await gotoHome(page);

  // ── ① + FAB → 创建浮层 → 选 prd灵感 → 输标题 → 建会话 ──
  await page.getByRole('button', { name: '创建' }).tap();
  await page.getByRole('button', { name: 'PRD灵感' }).tap();
  await page.getByLabel('灵感标题').fill(SESSION_TITLE);

  // 第一轮 SSE：纯文本反问（第一问永不给 chips，契约 §4）。
  mock.setSse({ question: '这个收藏是想收藏个股，还是也包括板块 / 指数？' });
  await page.getByRole('button', { name: '新建', exact: true }).tap();

  // 建会话成功 → push /ideation/[id]。
  await expect.poll(() => mock.createCount(), { timeout: 30_000 }).toBe(1);
  await page.waitForURL(/\/ideation\/sess-1/, { timeout: 30_000 });

  // ── ② 第一轮自由文本发送 → 流式 token 渲反问气泡 ──
  await page.getByTestId('ideation-input').fill('想给行情页加个收藏功能，但不确定范围');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId('ideation-turn-assistant')).toContainText('收藏个股', {
    timeout: 15_000,
  });

  // ── ③ chips 轮：第二轮带 suggestion → chips 渲（推荐 + 末位逃生）──
  mock.setSse({
    question: '收藏的内容是实时流式刷新，还是进页面时拉一次？',
    suggestion: {
      question: '收藏的内容是实时流式刷新，还是进页面时拉一次？',
      options: [
        { label: '进页面拉一次', recommended: true },
        { label: '实时流式刷新' },
        { label: '都不是 / 自己说', escapeHatch: true },
      ],
      multi_select: false,
      allow_freetext: true,
    },
  });
  await page.getByTestId('ideation-input').fill('先做个股就行');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount()).toBe(2);
  await expect(page.getByTestId('ideation-chip-row')).toBeVisible({ timeout: 15_000 });
  // 推荐项内嵌「（推荐）」。
  await expect(page.getByTestId('ideation-chip').first()).toContainText('（推荐）');

  // ── ④ chip 点选 → 直接发送（契约 §4.5 翻转 2026-06-22：quick-reply 即发，不回填+二次点）──
  // 先设好该轮 SSE（点 chip 即触发发送 → 立刻用当前 SSE 应答）；点推荐 chip「进页面拉一次」
  // → 作为本轮回答**立即发送**（剥离「（推荐）」），turnCount +1。chip 的 accessibilityLabel =
  // 语义 label（不含「（推荐）」UI 装饰）→ getByRole name 匹配它。
  mock.setSse({ question: '需求已经比较清楚了，你可以随时点「生成 brief」收敛。' });
  await page.getByRole('button', { name: '进页面拉一次', exact: true }).tap();
  await expect.poll(() => mock.turnCount()).toBe(3); // chip 点击即发送（关键契约：翻转后直发）。
  // 该轮 user turn = chip 语义 label（直发，无回填编辑步）。
  await expect(page.getByTestId('ideation-turn-user').last()).toContainText('进页面拉一次');

  // ── ⑤ AI 软提示 → 「生成 brief」按钮在 → 点 → converged → 切 brief 面 ──
  const genBtn = page.getByTestId('ideation-generate-brief-button');
  await expect(genBtn).toBeVisible({ timeout: 15_000 });
  await genBtn.tap();

  // ── ⑥ brief 结构化分段面 + 状态徽标 + T2 占位在 ──
  await expect(page.getByTestId('ideation-brief-screen')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ideation-brief-title')).toHaveText(SESSION_TITLE);
  await expect(page.getByTestId('ideation-brief-status-badge')).toContainText('已收敛');
  // T1 五段结构化卡（≥5）。
  await expect(page.getByTestId('ideation-brief-segment').first()).toBeVisible();
  // T2 接地段灰虚线非阻塞占位在（FR-011 / SC-007）。
  await expect(page.getByTestId('ideation-brief-grounding-placeholder').first()).toBeVisible();

  // ── ⑦ 复制 / 导出 markdown → 成功 toast ──
  await page.getByTestId('ideation-brief-export-button').tap();
  await expect(page.getByTestId('ideation-brief-toast')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ideation-brief-toast')).toContainText('已复制 markdown');

  // ── ⑧ brief ActionBar「设计稿」入口 → push 设计稿区（037 T011 viewer，本次补的导航 gap）──
  await page.getByTestId('ideation-brief-view-mockups-button').tap();
  await expect(page.getByTestId('ideation-mockup-screen')).toBeVisible({ timeout: 30_000 });
});
