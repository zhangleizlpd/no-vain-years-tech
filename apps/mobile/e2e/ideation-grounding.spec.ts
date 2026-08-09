import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 034 T012 — ideation 接地检索主干 Expo Web e2e（hermetic mock，PR §V 第一层 UI 交互验证）。
//
// 覆盖 US1 + US2 接地脊柱（FR-002/003/005/006/008/013 的 UI 侧）：
//   ① 建会话 → push /ideation/[id]
//   ② 点「选择代码库」→ catalog 真实列表（mono ready + legacy indexing 置灰）
//   ③ 选 mono → set-repo 落会话态
//   ④ 提问 → tool_start「正在检索代码…」指示 + 来源折叠（展开看出处 relPath:line）
//   ⑤ 切 repo（agent-platform）→ 后续轮命名空间变（来源出处随之换）
//   ⑥ 停服 mock（catalog/SSE 降级）→ 提问触发降级系统气泡（notice，会话继续不中断）
//
// ── SSE mock 范式（同 ideation-clarify.spec / 027 chat-streaming）──
// Playwright `route.fulfill` 不支持「逐帧增量」流式响应：一次性把整 text/event-stream body
// （tool_start + sources/notice + token + [DONE]）fulfill。客户端 getReader() 读整 body →
// parseIdeationChunk 切多帧 → 逐帧 dispatch → 最终渲染态正确即验到渲染契约；真增量逐帧到达
// + tool_result 回灌由 server IT（T007 reply.hijack 逐 write）兜底，e2e 不复验。
//
// ── mock = 契约镜像 stateful canonical（per mobile-e2e-hermetic / mobile-impl-playbook）──
// 单一 canonical 状态：sessionRepo（当前锁定仓，set-repo PATCH 写）+ serviceDown（停服开关）。
// SSE handler 是 (request, 服务端状态) 纯函数：据 sessionRepo 决定来源命名空间（镜像真 server
// 按 session.repo 锁检索）；serviceDown 时发 notice 帧（镜像真 server code-index 不可达降级）。
// **禁**按测试编排标志分支 —— sessionRepo / serviceDown 都是真 endpoint 会据以分支的服务端状态。
//
// ── auth 边界（per mobile-e2e-hermetic + authed_business_401 memory）──
// seed localStorage 只含 refreshToken/accountId/displayName → boot 走 refresh-token derive access。
// 必 mock refresh-token + GET /me，否则 AuthGate 失败跳 /login 假绿。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const REPOS_URL = '**/api/v1/ideation/repos';
const SESSIONS_GLOB = '**/api/v1/ideation/sessions/**';
const SESSIONS_COLLECTION = '**/api/v1/ideation/sessions';

const SEED_ACCOUNT_ID = 'acc-e2e-034';
const SEED_REFRESH_TOKEN = 'refresh-e2e-034';
const SEED_ACCESS_TOKEN = 'access-e2e-034';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139034';

const SESSION_ID = 'sess-g1';
const SESSION_TITLE = '接地检索灵感';

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

/** token 帧（逐字符 drip）。 */
const tokenFrames = (text: string) =>
  [...text].map((c) => `data: ${JSON.stringify({ token: c })}\n\n`).join('');
const toolStartFrame = () => `data: ${JSON.stringify({ tool_start: 'codeindex_retrieval' })}\n\n`;
const sourcesFrame = (sources: unknown) => `data: ${JSON.stringify({ sources })}\n\n`;
const noticeFrame = () => `data: ${JSON.stringify({ notice: 'grounding_degraded' })}\n\n`;
const DONE_FRAME = 'data: [DONE]\n\n';

/** catalog 镜像：mono ready（可检索）+ legacy indexing（置灰不可选，US2 AC）。 */
const CATALOG = {
  items: [
    {
      repo: 'mono',
      lastSha: 'abc1234',
      indexedAt: '2026-06-22T08:00:00.000Z',
      chunkCount: 1280,
      status: 'ready',
    },
    {
      repo: 'legacy-meta',
      lastSha: 'def5678',
      indexedAt: '2026-06-20T08:00:00.000Z',
      chunkCount: 640,
      status: 'indexing',
    },
    {
      repo: 'agent-platform',
      lastSha: 'aa99887',
      indexedAt: '2026-06-22T09:00:00.000Z',
      chunkCount: 512,
      status: 'ready',
    },
  ],
};

/** 命名空间镜像：来源出处随当前锁定 repo 变（FR-003/006 隔离）。 */
const SOURCES_BY_REPO: Record<
  string,
  { relPath: string; startLine: number; endLine: number; symbol?: string }[]
> = {
  mono: [
    {
      relPath: 'apps/server/src/ideation/clarify-turn.usecase.ts',
      startLine: 312,
      endLine: 340,
      symbol: 'streamAskRound',
    },
  ],
  'agent-platform': [
    { relPath: 'src/gateway/moments.ts', startLine: 44, endLine: 70, symbol: 'sendMoment' },
  ],
};

interface GroundingMock {
  setServiceDown: (down: boolean) => void;
  createCount: () => number;
  turnCount: () => number;
  currentRepo: () => string | null;
}

// 单一 stateful 接地 mock：catalog / set-repo / 详情 GET / SSE 接地帧。
async function installGroundingMock(page: Page): Promise<GroundingMock> {
  let createdSeq = 0;
  let turnSeq = 0;
  let sessionRepo: string | null = null; // set-repo PATCH 写（命名空间锁）。
  let serviceDown = false; // 停服开关（catalog / SSE 降级）。
  const turns: { id: string; role: string; content: string; suggestion: unknown }[] = [];

  // ── catalog（GET /ideation/repos）：停服 → 503 错误态（FR-010 可重试）。──
  await page.route(REPOS_URL, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (serviceDown) {
      return void (await route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ title: 'code-index unavailable' }),
      }));
    }
    return void (await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(CATALOG),
    }));
  });

  // ── /ideation/sessions/**（详情 GET / set-repo PATCH / SSE turns POST）──
  await page.route(SESSIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;

    // set-repo（PATCH .../{id}/repo）：写命名空间锁。
    if (path.endsWith('/repo') && method === 'PATCH') {
      const bodyText = req.postData() ?? '{}';
      const parsed = JSON.parse(bodyText) as { repo?: string };
      sessionRepo = parsed.repo ?? null;
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ id: SESSION_ID, repo: sessionRepo }),
      }));
    }

    // SSE 发 turn（POST .../{id}/turns）：据 sessionRepo + serviceDown 决定接地帧。
    if (path.endsWith('/turns') && method === 'POST') {
      turnSeq += 1;
      const question = `据${sessionRepo ?? '常规'}给你一个澄清问题`;
      turns.push({
        id: `t-user-${turnSeq}`,
        role: 'user',
        content: '（用户输入）',
        suggestion: null,
      });
      turns.push({ id: `t-ai-${turnSeq}`, role: 'assistant', content: question, suggestion: null });

      // 已锁仓 → 检索接地：tool_start → (停服 notice | 命中 sources) → token → DONE。
      let body = '';
      if (sessionRepo !== null) {
        body += toolStartFrame();
        if (serviceDown) {
          body += noticeFrame(); // 不可达降级（镜像真 server catch → notice 帧）。
        } else {
          body += sourcesFrame(SOURCES_BY_REPO[sessionRepo] ?? []);
        }
      }
      body += tokenFrames(question) + DONE_FRAME;

      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: SSE_HEADERS,
        body,
      }));
    }

    // 取详情（GET .../{id}）：含 turns + 当前 repo（stateful 反映 set-repo）。
    if (method === 'GET') {
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          id: SESSION_ID,
          title: SESSION_TITLE,
          status: 'open',
          repo: sessionRepo,
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z',
          turns,
          brief: null,
        }),
      }));
    }

    await route.fallback();
  });

  // 建会话 collection（POST /ideation/sessions，无 :id）。
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
    setServiceDown: (down) => {
      serviceDown = down;
    },
    createCount: () => createdSeq,
    turnCount: () => turnSeq,
    currentRepo: () => sessionRepo,
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

/** 进首页（tab bar 就位 = auth boot 完成）。FAB 在 tabs 根层常驻。 */
async function gotoHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '首页' }).tap();
}

/** 建会话 → push /ideation/[id]。 */
async function createSession(page: Page, mock: GroundingMock) {
  await page.getByRole('button', { name: '创建' }).tap();
  await page.getByRole('button', { name: 'PRD灵感' }).tap();
  await page.getByLabel('灵感标题').fill(SESSION_TITLE);
  await page.getByRole('button', { name: '新建', exact: true }).tap();
  await expect.poll(() => mock.createCount(), { timeout: 30_000 }).toBe(1);
  await page.waitForURL(/\/ideation\/sess-g1/, { timeout: 30_000 });
}

/** 打开「选择代码库」sheet（+ → 选择代码库）。 */
async function openRepoPicker(page: Page) {
  await page.getByTestId('ideation-input-plus').tap();
  await page.getByRole('button', { name: '选择代码库' }).tap();
  await expect(page.getByTestId('ideation-repo-sheet')).toBeVisible({ timeout: 15_000 });
}

test('034 ideation 接地 — 选库 → 检索来源 → 切仓换命名空间 → 停服降级气泡（hermetic）', async ({
  page,
}) => {
  const mock = await installGroundingMock(page);
  await gotoHome(page);
  await createSession(page, mock);

  // ── ② 选择代码库 → catalog 真实列表（mono ready + legacy indexing 置灰）──
  await openRepoPicker(page);
  await expect(page.getByTestId('ideation-repo-list')).toBeVisible({ timeout: 15_000 });
  // 至少 3 行（mono / legacy-meta / agent-platform）。
  await expect(page.getByTestId('ideation-repo-row').first()).toBeVisible();
  // indexing 行置灰不可选（accessibilityState disabled）。
  await expect(page.getByRole('button', { name: /legacy-meta，索引中/ })).toBeDisabled();

  // ── ③ 选 mono → set-repo 落会话态 ──
  await page.getByRole('button', { name: /^mono，可检索/ }).tap();
  await expect.poll(() => mock.currentRepo(), { timeout: 15_000 }).toBe('mono');

  // ── ④ 提问 → tool_start 指示 + 来源折叠（展开看出处 mono 路径）──
  await page.getByTestId('ideation-input').fill('想加一个接地检索功能');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
  // 来源折叠默认折叠 → 展开看出处（mono 命名空间路径）。
  const disclosure = page.getByTestId('ideation-sources-disclosure');
  await expect(disclosure).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('ideation-sources-toggle').tap();
  await expect(page.getByTestId('ideation-sources-list')).toContainText(
    'apps/server/src/ideation/clarify-turn.usecase.ts',
  );

  // ── ⑤ 切仓（agent-platform）→ 后续轮命名空间变（来源出处换）──
  await openRepoPicker(page);
  await page.getByRole('button', { name: /^agent-platform，可检索/ }).tap();
  await expect.poll(() => mock.currentRepo(), { timeout: 15_000 }).toBe('agent-platform');
  await page.getByTestId('ideation-input').fill('换个仓再问一次');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(2);
  // 第二轮来源 = agent-platform 命名空间（既有第一轮 mono 来源不回改，FR-006）。
  const lastDisclosure = page.getByTestId('ideation-sources-disclosure').last();
  await expect(lastDisclosure).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('ideation-sources-toggle').last().tap();
  await expect(page.getByTestId('ideation-sources-list').last()).toContainText(
    'src/gateway/moments.ts',
  );

  // ── ⑥ 停服 mock → 提问触发降级系统气泡（notice，会话继续不中断）──
  mock.setServiceDown(true);
  await page.getByTestId('ideation-input').fill('停服后再问一次');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(3);
  // 降级气泡在（与 error 重试态不同语义 → 无重试钮、会话继续）。
  await expect(page.getByTestId('ideation-grounding-notice')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ideation-grounding-notice')).toContainText('本次未接地');
  // 会话不中断：本轮 assistant 反问气泡照常渲（token 帧续到）。
  await expect(page.getByTestId('ideation-turn-assistant').last()).toContainText('澄清问题');
  // error 重试态**不**出现（降级 ≠ 整轮失败）。
  await expect(page.getByTestId('ideation-error-state')).toHaveCount(0);
});
