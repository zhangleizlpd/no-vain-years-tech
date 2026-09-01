import { expect, test, type Page, type Route } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 032 T019 — ideation US2 会话列表/持久 Expo Web e2e（hermetic stateful mock，PR §V 第一层）。
//
// 覆盖 US2 端到端（FR-007/008/012 + SC-005 的 UI 侧）：
//   ① 建会话 → 澄清一轮（流式反问渲染）
//   ② header back 回列表 → 该会话可见（标题对 + 状态徽标「进行中」）
//   ③ 点进可继续（进度保留：GET 详情返已落 turns → 反问气泡仍在）
//   ④ 长按行 → ConfirmModal 二次确认 → 删除 → 列表少一条（消失）
//   ⑤ 仅见本账号：mock list 只返本账号会话，注入的「他人」id 不在 list（不串号）
//
// ── 删除驱动（per memory reference_playwright_rngh_longpress_drivable_pan_not）──
// T018 删除有两入口：SwipeRow 左滑（RNGH Pan，headless web 非确定 → e2e 不驱）+ 行 onLongPress
// （mouse 按住可确定驱动）。本 e2e **用长按**（Pressable onLongPress）触发 ConfirmModal。
//
// ── auth / mock 范式（照搬 T017 ideation-clarify.spec）──
// seed localStorage 只含 refreshToken/accountId/displayName → boot 走 refresh-token 拿 access
// token。必 mock refresh-token（否则 AuthGate refresh 失败 → clearSession 跳 /login）+ mock /me。
// 会话 CRUD / list 走 orval(axios) authed，SSE 端点裸 fetch 自带 Bearer；本 mock 放行任意 Auth。
//
// ── Expo Web 坑（同 T017）──
// route groups 隐藏（/(app)/(tabs) → 实际路径无 group 段）/ Stack 双命中用 getByRole 收窄 /
// header back 走 headerLeft 按钮（非 page.goBack，per Expo Router web refresh 范式）。
// FAB + 创建浮层挂 (tabs) chrome（全 tab 常驻）；建会话从首页 tab 的 FAB 发起。ideation 现为
// 「灵感」tab 内嵌 stack（列表 index + 详情 [id]），不再是 tabs 外兄弟 stack（修 Fabric 重挂崩）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const SESSIONS_GLOB = '**/api/v1/ideation/sessions/**';
const SESSIONS_COLLECTION = '**/api/v1/ideation/sessions';

const SEED_ACCOUNT_ID = 'acc-e2e-032';
const SEED_REFRESH_TOKEN = 'refresh-e2e-032';
const SEED_ACCESS_TOKEN = 'access-e2e-032';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139032';

// 新建会话 id（建后进入 + 回列表可见 + 删除目标）。
const NEW_SESSION_ID = 'sess-new-1';
const NEW_SESSION_TITLE = '行情页收藏功能';

// 「他人」会话（属另一账号；server UC-level accountId scope 永不返本账号 list —— mock 据此
// 不把它放进本账号 list，验前端只渲 server 返回的本账号会话，不串号）。
const OTHER_SESSION_ID = 'sess-other-999';
const OTHER_SESSION_TITLE = '他人的私密灵感';

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

/** token 帧（逐字符 drip，同 T017）。 */
const tokenFrames = (text: string) =>
  [...text].map((c) => `data: ${JSON.stringify({ token: c })}\n\n`).join('');
const DONE_FRAME = 'data: [DONE]\n\n';

interface SessionRecord {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

interface SessionsMock {
  createCount: () => number;
  turnCount: () => number;
  deleteCount: () => number;
  /** 当前本账号 list 的 id 集合（断言用）。 */
  listIds: () => string[];
  /** 详情 GET 命中次数（验热重进 invalidate 触发了重取）。 */
  detailGetCount: () => number;
}

/**
 * Stateful ideation 会话 mock：list（本账号会话数组）+ 建会话（push 进 list）+ 取详情
 * （含已落 turns，验进度保留）+ SSE 发 turn + 删除（从 list 移除）。
 *
 * 关键：list **只含本账号**会话 —— OTHER_SESSION_ID 永不入 list（模拟 server accountId scope）。
 */
async function installSessionsMock(page: Page): Promise<SessionsMock> {
  let createdSeq = 0;
  let turnSeq = 0;
  let deletedSeq = 0;
  let detailGetSeq = 0;
  // 本账号会话 list（updatedAt desc；server 已排序，mock 维持新建置顶）。初始空 → 验空态后建。
  const sessions: SessionRecord[] = [];
  // 已落库 turn（GET 详情 hydrate，验「点进可继续」进度保留）。
  const turns: { id: string; role: string; content: string; suggestion: unknown }[] = [];
  const ASSISTANT_QUESTION = '这个收藏是想收藏个股，还是也包括板块 / 指数？';

  // ── /ideation/sessions/{id}**（详情 GET / SSE turns POST / DELETE）──
  await page.route(SESSIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;

    // SSE 发 turn（POST .../{id}/turns）：落 user + assistant turn，一次性全帧。
    if (path.endsWith('/turns') && method === 'POST') {
      turnSeq += 1;
      // FU-1 镜像真相：回显 POST body 的真实 content（同 ideation-clarify）；防将来加 user-turn 断言 flaky。
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
        content: ASSISTANT_QUESTION,
        suggestion: null,
      });
      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: SSE_HEADERS,
        body: tokenFrames(ASSISTANT_QUESTION) + DONE_FRAME,
      }));
    }

    // 删除会话（DELETE .../{id}）：从本账号 list 移除 → 204。
    if (method === 'DELETE') {
      const id = path.split('/').pop() ?? '';
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx >= 0) sessions.splice(idx, 1);
      deletedSeq += 1;
      return void (await route.fulfill({ status: 204, headers: { ...CORS } }));
    }

    // 取详情（GET .../{id}）：含已落 turns（验进度保留）；brief 本流程未生成 → null。
    // 🚨 turns 由 `turns` 数组实时反映（server append-only）：建会话首取 GET = 空 turns（前端
    //   缓存空快照）；发过澄清轮后 GET = 带 turns。热重进若命中 30s 内陈旧空快照（无 invalidate）
    //   则不重取 → 屏空；fix 后澄清轮终态 invalidate → 重取拿到带 turns 详情。detailGetSeq 计数
    //   让热重进 case 可断言「重进确实又 GET 了一次（缓存被失效）」。
    if (method === 'GET') {
      detailGetSeq += 1;
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          id: NEW_SESSION_ID,
          title: NEW_SESSION_TITLE,
          status: 'open',
          repo: null,
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:01:00.000Z',
          turns,
          brief: null,
        }),
      }));
    }

    await route.fallback();
  });

  // ── /ideation/sessions（collection：GET list / POST create）──
  await page.route(SESSIONS_COLLECTION, async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    // list 本账号会话（GET）：只返 sessions 数组（OTHER_SESSION_ID 永不在内）。
    if (method === 'GET') {
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ items: sessions }),
      }));
    }

    // 建会话（POST）：push 进本账号 list（置顶）→ 返新会话。
    if (method === 'POST') {
      createdSeq += 1;
      sessions.unshift({
        id: NEW_SESSION_ID,
        title: NEW_SESSION_TITLE,
        status: 'open',
        updatedAt: '2026-06-22T00:01:00.000Z',
      });
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          id: NEW_SESSION_ID,
          title: NEW_SESSION_TITLE,
          status: 'open',
          repo: null,
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:01:00.000Z',
        }),
      }));
    }

    await route.fallback();
  });

  return {
    createCount: () => createdSeq,
    turnCount: () => turnSeq,
    deleteCount: () => deletedSeq,
    listIds: () => sessions.map((s) => s.id),
    detailGetCount: () => detailGetSeq,
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

/** 进首页（tab bar 就位 = auth boot 完成）。 */
async function gotoHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '首页' }).tap();
}

/**
 * in-app header back（makeHeaderBackOrParent → router.back()/replace 兜底）。
 * 🚨 非 page.goBack()：浏览器 popstate 在嵌套 Expo Stack 上会被重映射到栈首屏（实测，per
 * reference_playwright_expo_goback_remaps_to_stack_first_screen + holdings.spec 范式）。
 * @react-navigation/elements 体例：back 按钮 a11y 名 = `<栈中上一屏标题>, back`（实测取决于
 * 进入路径：从首页直 push /ideation/[id] → 上屏 = (tabs)；从列表 push → 上屏 = 需求灵感）。
 */
async function headerBack(page: Page, name: string) {
  await page.getByRole('button', { name }).tap();
}

test('032 ideation US2 — 建会话澄清 → 回列表可见 → 点进继续 → 长按删除消失 → 仅本账号（hermetic）', async ({
  page,
}) => {
  const mock = await installSessionsMock(page);
  await gotoHome(page);

  // ── ① 建会话（首页 + FAB → prd灵感 → 标题 → 新建）→ push /ideation/[id] ──
  // FAB + 创建浮层挂 (tabs) chrome（全 tab 常驻）；此处从首页 tab 的 FAB 发起建会话。
  await page.getByRole('button', { name: '创建' }).tap();
  await page.getByRole('button', { name: 'PRD灵感' }).tap();
  await page.getByLabel('灵感标题').fill(NEW_SESSION_TITLE);
  await page.getByRole('button', { name: '新建', exact: true }).tap();
  await expect.poll(() => mock.createCount(), { timeout: 30_000 }).toBe(1);
  await page.waitForURL(/\/ideation\/sess-new-1/, { timeout: 30_000 });

  // 澄清一轮（自由文本发送 → 流式反问气泡渲染）。
  await page.getByTestId('ideation-input').fill('想给行情页加个收藏功能');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId('ideation-turn-assistant')).toContainText('收藏个股', {
    timeout: 15_000,
  });

  // ── ② header back 回列表（ideation tab 内嵌 stack：详情从首页 FAB 直 push 进入，back 落列表根屏）──
  // 详情屏 tab 栏隐藏，故经 header back（非点 tab）离开；back 落 ideation 列表（内嵌 stack 根）。
  // 045 T019 后 ideation 不再有自己的 tab 按钮（href:null），故以「tab 栏恢复」为离开全屏的信号
  // ——用非门控的「首页」tab 当锚点（原先锚在「灵感」tab 按钮上）。
  await headerBack(page, 'Go back');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 30_000 });

  // 列表：该会话可见（标题 + 状态徽标「进行中」）。
  await expect(page.getByTestId('ideation-session-list')).toBeVisible({ timeout: 30_000 });
  const row = page.getByTestId('ideation-session-row').filter({ hasText: NEW_SESSION_TITLE });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ideation-session-status-badge').first()).toContainText('进行中');

  // ── ⑤ 仅本账号：注入的「他人」会话不在 list（不串号，SC-005）──
  expect(mock.listIds()).toEqual([NEW_SESSION_ID]);
  expect(mock.listIds()).not.toContain(OTHER_SESSION_ID);
  await expect(page.getByText(OTHER_SESSION_TITLE)).toHaveCount(0);

  // ── ③ 点进可继续（进度保留：中途退出重进 → GET 详情返已落 turns → 反问气泡仍在，FR-008）──
  await row.tap();
  await page.waitForURL(/\/ideation\/sess-new-1/, { timeout: 30_000 });
  // 🚨 冷启重进（page.reload）：清 React Query 内存缓存（全局 staleTime 30s，会话内重进会命中
  //   首次 push 时拉到的空 turns 陈旧缓存），强制 GET 详情重取已落 turns —— 这才是「退出重进可
  //   继续」的真持久验证（addInitScript 在 reload 后重跑 → seed auth 仍在）。
  await page.reload();
  await page.waitForURL(/\/ideation\/sess-new-1/, { timeout: 30_000 });
  await expect(page.getByTestId('ideation-turn-assistant')).toContainText('收藏个股', {
    timeout: 30_000,
  });

  // 回列表准备删除。冷启 reload 后栈仅 [id] 且详情屏 tab 栏隐藏（点不到 tab）：经 header back，
  //   canGoBack=false → makeHeaderBackOrParent router.replace 回父路由（ideation 列表）。
  await headerBack(page, 'Go back');
  await expect(page.getByTestId('ideation-session-list')).toBeVisible({ timeout: 30_000 });

  // ── ④ 长按行 → ConfirmModal 二次确认 → 删除 → 列表少一条（消失）──
  const rowAgain = page.getByTestId('ideation-session-row').filter({ hasText: NEW_SESSION_TITLE });
  // 长按驱动（mouse 按住可确定，per RNGH longpress memory）。
  const box = await rowAgain.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700); // > onLongPress 默认阈值 (500ms)。
  await page.mouse.up();

  // 二次确认弹窗出 → 点删除。
  await expect(page.getByRole('button', { name: '删除', exact: true }).last()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: '删除', exact: true }).last().tap();

  await expect.poll(() => mock.deleteCount(), { timeout: 30_000 }).toBe(1);
  // 删除后 list 空 → 空态回来（该会话消失）。
  await expect(page.getByTestId('ideation-list-empty')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(NEW_SESSION_TITLE)).toHaveCount(0);
  expect(mock.listIds()).toEqual([]);
});

// ── FU-1 回归：澄清轮终态 invalidate 会话详情 query（修热重进 30s 内陈旧空 turns）──
//
// 这条专治 ③ 的盲区：原 ③ 用 page.reload() 冷启重进 —— reload 清掉 React Query 内存缓存，
// 即便没有 invalidate 也会重取详情拿到 turns（故 reload case 无法暴露 bug）。本 case 走**热重进**
// （header back 回首页 → 灵感 tab → 列表 → 点回同会话，全程不 reload，RQ 内存缓存存活），缺这条
// invalidate 时：建会话首取 GET 缓存了空 turns 快照（全局 staleTime 30s fresh），澄清轮 SSE 只
// dispatch 本地 reducer 不碰 RQ → 30s 内热重进命中陈旧空快照不重取 → 反问气泡消失（红）。
// 有 invalidate 后：澄清轮 onDone invalidate 详情 query → 热重进触发重取拿到带 turns 详情（绿）。
test('032 FU-1 — 澄清轮后热重进（不 reload）反问气泡仍在：终态 invalidate 详情 query', async ({
  page,
}) => {
  const mock = await installSessionsMock(page);
  await gotoHome(page);

  // 建会话 + 发一轮澄清（SSE 落 turn）。建会话 push /ideation/[id] 时已触发首次详情 GET（空快照）。
  await page.getByRole('button', { name: '创建' }).tap();
  await page.getByRole('button', { name: 'PRD灵感' }).tap();
  await page.getByLabel('灵感标题').fill(NEW_SESSION_TITLE);
  await page.getByRole('button', { name: '新建', exact: true }).tap();
  await page.waitForURL(/\/ideation\/sess-new-1/, { timeout: 30_000 });

  // 记下「发澄清轮前」详情 GET 次数（= 建会话首取空快照那次）。澄清轮终态 invalidate 会触发
  //   一次重取 → 此后计数必 +1；缺 invalidate 时澄清轮只 dispatch 本地 reducer，不再 GET（计数不动）。
  const getsBeforeTurn = mock.detailGetCount();

  await page.getByTestId('ideation-input').fill('想给行情页加个收藏功能');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId('ideation-turn-assistant')).toContainText('收藏个股', {
    timeout: 15_000,
  });

  // 🚨 核心红/绿断言：澄清轮终态后必有一次额外详情 GET（onDone invalidate → RQ 重取，此时屏仍挂载）。
  //   缺这条 invalidate 时 SSE 终态只碰本地 reducer 不碰 RQ → 不触发 GET → 计数停在 getsBeforeTurn（红）。
  //   这把 RQ 缓存刷成「带 turns 的新快照」，是下面热重进能拿到 turns 的根因。
  await expect
    .poll(() => mock.detailGetCount(), { timeout: 30_000 })
    .toBeGreaterThan(getsBeforeTurn);

  // ── 热重进（关键：全程不 page.reload，RQ 内存缓存存活）：header back（router.replace，非 reload）
  //    从详情回列表（ideation tab 内嵌 stack 根屏）──
  // 045 T019：ideation 无 tab 按钮，锚点改用非门控的「首页」tab（tab 栏恢复 = 已离开全屏详情屏）。
  await headerBack(page, 'Go back');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ideation-session-list')).toBeVisible({ timeout: 30_000 });

  const row = page.getByTestId('ideation-session-row').filter({ hasText: NEW_SESSION_TITLE });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.tap();
  await page.waitForURL(/\/ideation\/sess-new-1/, { timeout: 30_000 });

  // 热重进读到上一步 invalidate 刷新的带 turns 缓存 → 反问气泡仍在（缺 invalidate 时此处缓存为空快照 → 气泡消失）。
  await expect(page.getByTestId('ideation-turn-assistant')).toContainText('收藏个股', {
    timeout: 30_000,
  });
});
