import { expect, test, type Page, type Route } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 033 T004 — ideation 多模态输入壳 US1 e2e（两区输入栏 + 文本闭环零回退 + autosize）。
//
// 覆盖 spec.md state_branches 1-5 + SC-001/002/006：
//   ① 空/纯空白 + 无附件 → 发送按钮禁用、不发空 turn（既有校验保留）。
//   ② 有文本 + 非流式 → 点**按钮栏内**发送 → 发起澄清轮（既有 SSE 流式不回退）。
//   ③ 流式中 → 发送按钮切为停止 → 点停止 abort（既有 027/030 stopped 语义）。
//   ④ 文本随输入自增长至上限 → 内部滚动（web 视口宽松，断言尽力：验高度 clamp / 不抖、
//      按钮栏不被挤出）；真机精确验在 T012。
//   ⑤ 软键盘弹起两区避让（web 端 KeyboardAvoidingView 难真实测）→ 本 spec 仅验布局不崩，
//      真机验在 T012。
//   + 两区布局可见：上区 textarea（ideation-input）+ 下区按钮栏（ideation-input-toolbar）内
//      含 [+]（ideation-input-plus）/ [mic]（ideation-input-mic）/ [send]（ideation-send-button）。
//
// ── SSE mock 范式（同 ideation-clarify.spec / 027 chat-streaming）──
// Playwright route.fulfill 一次性 fulfill 整 text/event-stream body（token 帧 + [DONE]）。
// 客户端读整 body → 逐 token dispatch → done。最终渲染态正确即验到渲染契约。
//
// ── auth 边界（per memory authed_business_401_triggers_refresh_interceptor + store.ts）──
// seed localStorage 只含 refreshToken/accountId/displayName → boot 走 refresh-token。
// 必 mock refresh-token（否则 AuthGate refresh 失败 → clearSession 跳 /login）+ mock /me。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const SESSIONS_GLOB = '**/api/v1/ideation/sessions/**';
const SESSIONS_COLLECTION = '**/api/v1/ideation/sessions';

const SEED_ACCOUNT_ID = 'acc-e2e-033';
const SEED_REFRESH_TOKEN = 'refresh-e2e-033';
const SEED_ACCESS_TOKEN = 'access-e2e-033';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139033';

const SESSION_ID = 'sess-1';
const SESSION_TITLE = '输入栏两区重构验证';

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
const DONE_FRAME = 'data: [DONE]\n\n';

type SseTurn = { question: string };

interface IdeationMock {
  setSse: (turn: SseTurn) => void;
  createCount: () => number;
  turnCount: () => number;
}

// 单一 stateful ideation mock（同 ideation-clarify.spec 范式，append-only canonical turns）。
async function installIdeationMock(page: Page): Promise<IdeationMock> {
  let createdSeq = 0;
  let turnSeq = 0;
  const turns: { id: string; role: string; content: string; suggestion: unknown }[] = [];
  let sse: SseTurn = { question: '默认问题' };

  await page.route(SESSIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;

    // SSE 发 turn（POST .../{id}/turns）：一次性全帧（token + [DONE]）。
    if (path.endsWith('/turns') && method === 'POST') {
      turnSeq += 1;
      const mode = sse;
      turns.push({
        id: `t-user-${turnSeq}`,
        role: 'user',
        content: '（用户输入）',
        suggestion: null,
      });
      turns.push({
        id: `t-ai-${turnSeq}`,
        role: 'assistant',
        content: mode.question,
        suggestion: null,
      });
      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: SSE_HEADERS,
        body: tokenFrames(mode.question) + DONE_FRAME,
      }));
    }

    // 取详情（GET .../{id}）：含 turns（append-only 真相，无条件返回）。
    if (method === 'GET') {
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
          turns,
          brief: null,
        }),
      }));
    }

    await route.fallback();
  });

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

/** 进首页 → FAB 建会话 → push /ideation/[id]（复用 032 入口序）。 */
async function gotoSession(page: Page, mock: IdeationMock) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '首页' }).tap();

  await page.getByRole('button', { name: '创建' }).tap();
  await page.getByRole('button', { name: 'PRD灵感' }).tap();
  await page.getByLabel('灵感标题').fill(SESSION_TITLE);
  await page.getByRole('button', { name: '新建', exact: true }).tap();

  await expect.poll(() => mock.createCount(), { timeout: 30_000 }).toBe(1);
  await page.waitForURL(/\/ideation\/sess-1/, { timeout: 30_000 });
}

test('033 US1 — 两区输入栏布局可见（textarea 上区 + 按钮栏下区 [+][mic][send]）', async ({
  page,
}) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  // 上区 textarea。
  await expect(page.getByTestId('ideation-input')).toBeVisible({ timeout: 15_000 });
  // 下区按钮栏 + 三按钮在栏内（SC-002：0 额外导航层级即可触达 + / mic）。
  await expect(page.getByTestId('ideation-input-toolbar')).toBeVisible();
  await expect(page.getByTestId('ideation-input-plus')).toBeVisible();
  await expect(page.getByTestId('ideation-input-mic')).toBeVisible();
  await expect(page.getByTestId('ideation-send-button')).toBeVisible();

  // 发送按钮在按钮栏内（FR-002：send 移入栏，与 +/mic 同尺寸）。
  const toolbar = page.getByTestId('ideation-input-toolbar');
  await expect(toolbar.getByTestId('ideation-send-button')).toBeVisible();
  await expect(toolbar.getByTestId('ideation-input-plus')).toBeVisible();
  await expect(toolbar.getByTestId('ideation-input-mic')).toBeVisible();
});

// state_branch 3（流式→停止 abort）：SSE mock 一次性 fulfill 整 body → 流式态在 web 上瞬态，
// 难稳定捕捉 stop 钮（同 032 spec：route.fulfill 不支持逐帧）。停止逻辑（isStreaming→stop 切换 +
// onStop abort）由 T003 保留零改、按钮栏内结构性在；既有 027/030 chat-streaming.spec + 032
// ideation-clarify.spec 覆盖停止语义。本 spec 验文本闭环零回退 + 按钮栏内发送（state_branches 1-2）。
test('033 US1 — 空文本发送禁用 → 文本多轮发送走 SSE 零回退（state_branches 1-2 / SC-001）', async ({
  page,
}) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  // ── ① 空文本 → 发送按钮禁用 ──
  const sendBtn = page.getByTestId('ideation-send-button');
  await expect(sendBtn).toBeVisible({ timeout: 15_000 });
  await expect(sendBtn).toBeDisabled();

  // 纯空白也禁用（trim 后空）。
  await page.getByTestId('ideation-input').fill('   ');
  await expect(sendBtn).toBeDisabled();

  // ── ② 有文本 → 点按钮栏内发送 → SSE 流式反问气泡（零回退） ──
  mock.setSse({ question: '这个收藏是想收藏个股，还是也包括板块 / 指数？' });
  await page.getByTestId('ideation-input').fill('想给行情页加个收藏功能，但不确定范围');
  await expect(sendBtn).toBeEnabled();
  await sendBtn.tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId('ideation-turn-assistant')).toContainText('收藏个股', {
    timeout: 15_000,
  });

  // ── 第二轮再发一条（多轮闭环零回退） ──
  mock.setSse({ question: '需求已经比较清楚了。' });
  await page.getByTestId('ideation-input').fill('先做个股就行');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount()).toBe(2);
});

test('033 US1 — 文本自增长 autosize：多行输入增高、按钮栏不被挤出（state_branch 4 / SC-006）', async ({
  page,
}) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  const input = page.getByTestId('ideation-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  // 初始高度（约 2 行最小）。
  const h0 = (await input.boundingBox())?.height ?? 0;
  expect(h0).toBeGreaterThan(0);

  // 灌入多行长文本（触发 autosize 增高 + 到上限内部滚动）。
  const longText = Array.from(
    { length: 12 },
    (_, i) => `第 ${i + 1} 行很长很长的澄清初衷文字内容`,
  ).join('\n');
  await input.fill(longText);

  // 增高后高度 >= 初始（autosize 生效）且不超过约 5 行上限（clamp 134px，留余量断言 ≤ 160）。
  const h1 = (await input.boundingBox())?.height ?? 0;
  expect(h1).toBeGreaterThanOrEqual(h0);
  expect(h1).toBeLessThanOrEqual(160);

  // 按钮栏在增高后仍可见、未被挤出（布局不抖；真机精确「内部滚动」验在 T012）。
  await expect(page.getByTestId('ideation-input-toolbar')).toBeVisible();
  await expect(page.getByTestId('ideation-send-button')).toBeVisible();
});

// ════════════════════════════════════════════════════════════════════════════
// 033 T008 — US2 选图 / 拍照 / 移除 / 带图发送 e2e。
//
// ── expo-image-picker web-mock 范式（per profile-image-upload.spec 既有范式）──
// Expo Web 的 `expo-image-picker`（node_modules/.../ExponentImagePicker.web.js）实现：
//   · 权限 API（request{MediaLibrary,Camera}PermissionsAsync）**硬编码 granted**（web 不需权限）；
//   · launchImageLibraryAsync / launchCameraAsync 创建隐藏 `<input type=file>` 并 dispatch click
//     → Playwright 的 `filechooser` 事件可捕获；多选 = input 带 `multiple`，setFiles([f1,f2])
//     即返回 2 个 asset；asset.uri = URL.createObjectURL(file)（blob: uri，expo-image 直渲缩略图）。
// 故 web e2e 走 **filechooser 注入**驱动选图/拍照正路（无需 JS module mock）；camera 路径同样
// 落 `<input capture>` filechooser。权限**被拒**路径在 web 不可达（granted 硬编码）→ 见 T009 裁定，
// 被拒逻辑由 use-ideation-attachments.spec.ts（vitest）覆盖。
//
// 1x1 透明 PNG buffer（注入 filechooser；asset.uri = blob:）。
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BUFFER = Buffer.from(PNG_BASE64, 'base64');
const pngFile = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG_BUFFER });

/** 点 `+` 开 sheet（先收键盘 → Modal slide-in），等 4 入口可见。 */
async function openPlusSheet(page: Page) {
  await page.getByTestId('ideation-input-plus').tap();
  await expect(page.getByTestId('ideation-plus-sheet')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ideation-sheet-camera')).toBeVisible();
  await expect(page.getByTestId('ideation-sheet-image')).toBeVisible();
  await expect(page.getByTestId('ideation-sheet-file')).toBeVisible();
  await expect(page.getByTestId('ideation-sheet-repo')).toBeVisible();
}

test('033 US2 — `+` 开 sheet 4 入口 → 图片多选 2 张带回 → ×移除其一（state_branches 6,7,10 / SC-003）', async ({
  page,
}) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);
  await expect(page.getByTestId('ideation-input')).toBeVisible({ timeout: 15_000 });

  // ── 点 + → sheet 见 4 入口（FR-005）──
  await openPlusSheet(page);

  // ── 点 图片 → 系统相册 picker（web filechooser）多选 2 张 → 2 缩略图带回 ──
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('ideation-sheet-image').tap(),
  ]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([pngFile('a.png'), pngFile('b.png')]);

  // 缩略图排出现，2 张缩略图（gate attachments.length>0）。
  await expect(page.getByTestId('ideation-thumb-row')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible();
  await expect(page.getByTestId('ideation-thumb-1')).toBeVisible();
  await expect(page.getByTestId('ideation-thumb-2')).toHaveCount(0);

  // ── 点第 0 张的 × 移除 → 剩 1 张（state_branch 10：不影响其它）──
  await page.getByTestId('ideation-thumb-remove-0').tap();
  // 移除后重排：原第 1 张落到 index 0，index 1 不再存在。
  await expect(page.getByTestId('ideation-thumb-1')).toHaveCount(0);
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible();
});

test('033 US2 — 摄像头拍照带回本地缩略图（state_branch 8）', async ({ page }) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);
  await expect(page.getByTestId('ideation-input')).toBeVisible({ timeout: 15_000 });

  await openPlusSheet(page);

  // 点 摄像头 → web `launchCameraAsync` 落 `<input capture>` filechooser → 注入 1 张。
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('ideation-sheet-camera').tap(),
  ]);
  await chooser.setFiles([pngFile('shot.png')]);

  await expect(page.getByTestId('ideation-thumb-row')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible();
  await expect(page.getByTestId('ideation-thumb-1')).toHaveCount(0);
});

// 🚨 036 T009/T014 行为翻案：033 的「图片发送即将开放」占位（imageSendComingSoon）已删 —— 有附件
// 点发送现走**真上传 + 带图轮**（US3 仅附图直发）。本 spec 不装 OSS 凭证/host mock（带图真上传
// happy-path 在 036 ideation-image-annotation.spec 全覆盖），故此处验**降级**：无 OSS 后端 → 上传
// 失败优雅降级（toast「图片上传失败」+ 附件留存 + 不脏写对话，FR-011/SC-003），不再断言占位文案。
test('033 US2 — 有附件点发送（036 接真上传）：无 OSS 后端 → 上传失败降级 + 附件留存 + 不脏写（FR-011/SC-003）', async ({
  page,
}) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);
  await expect(page.getByTestId('ideation-input')).toBeVisible({ timeout: 15_000 });

  // 选 1 张图带回。
  await openPlusSheet(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('ideation-sheet-image').tap(),
  ]);
  await chooser.setFiles([pngFile('a.png')]);
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible({ timeout: 10_000 });

  // 有文本 + 附件 → 点发送：触发真上传（凭证 EP 未 mock → 网络/上传失败 → 降级）。
  await page.getByTestId('ideation-input').fill('这是带图发送的文本');
  const sendBtn = page.getByTestId('ideation-send-button');
  await expect(sendBtn).toBeEnabled();
  await sendBtn.tap();

  // ① 上传失败降级 toast 出现（不泄 vendor，FR-011；无 OSS 后端 → 网络/上传失败路径，文案随路径
  //    变（网络异常 / 上传失败），此处只验降级发生且不是旧占位「即将开放」）。
  await expect(page.getByTestId('ideation-toast')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ideation-toast')).not.toContainText('即将开放');
  // ② 附件留存不清（发后缩略图仍在，可重试，SC-003 不丢内容）。
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible();
  // ③ 不脏写对话（上传失败 → turn 不发）。
  expect(mock.turnCount()).toBe(0);
});

// ════════════════════════════════════════════════════════════════════════════
// 033 T010 — US4 stub 入口 e2e（添加文件 / 选择代码库 / 麦克风 → comingSoon toast，
// 不请求权限 / 不导航 / 不录音；state_branch 12 / SC-005）。
// stub 入口点击不触发任何 picker → filechooser 监听器全程不应 fire；URL 不变。

test('033 US4 — sheet 内 添加文件 stub → 「即将开放」toast，不触发 picker/导航（state_branch 12 / SC-005）', async ({
  page,
}) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);
  await expect(page.getByTestId('ideation-input')).toBeVisible({ timeout: 15_000 });

  // 监视：stub 点击全程不应拉起 filechooser（无 picker/权限/能力触发）。
  let fileChooserFired = false;
  page.on('filechooser', () => (fileChooserFired = true));
  const urlBefore = page.url();

  await openPlusSheet(page);
  await page.getByTestId('ideation-sheet-file').tap();

  await expect(page.getByTestId('ideation-toast')).toContainText('即将开放', { timeout: 5_000 });
  // 不是「图片发送即将开放」/「权限」文案 —— 是纯 comingSoon。
  await expect(page.getByTestId('ideation-toast')).toHaveText('即将开放');
  expect(fileChooserFired).toBe(false);
  expect(page.url()).toBe(urlBefore);
});

// 注：「选择代码库」stub→toast 子测试已于 034 接地接线后退役（stub 去除，入口改开 RepoPicker）。
// picker 打开/列表/选择行为见 034 T012 `ideation-grounding.spec.ts`，本处不再保留重复断言。

// 注：「按钮栏 麦克风 stub→toast」子测试已于 035 语音输入接线后退役（mic stub 去除，改 push-to-talk
// 长按起录 + 下滑取消，不再触发 comingSoon toast）。语音录音/partial/final/取消/降级行为见
// 035 T009 `ideation-voice.spec.ts`（fake-asr 注入），本处不再保留对已退役 stub 的断言。

// ════════════════════════════════════════════════════════════════════════════
// 033 T011 — Polish：state_branches 覆盖审计 + 面板关闭不丢态 + 移除项 absence + a11y。
//
// ── state_branches 13 条覆盖审计（逐条对应 it / 既有覆盖）──
//   1  空/纯空白无附件 → 发送禁用            ✓ US1「空文本发送禁用…」
//   2  有文本非流式 → 发送走 SSE             ✓ US1「…文本多轮发送走 SSE 零回退」
//   3  流式中 → 发送切停止 → abort           ▲ 本 spec 补「流式窗口 → 停止键可见可点」（delayed mock
//        制造可断言窗口）；停止 abort 语义零改，既有 027/030 chat-streaming + 032 ideation-clarify
//        已覆盖 abort 落地（split-tx stopped）。本条裁定 = 既有覆盖 + 本 spec 结构性补窗口断言。
//   4  文本 autosize 增高至上限内部滚动      ✓ US1「文本自增长 autosize…」
//   5  软键盘弹起两区避让                    ▲ web KeyboardAvoidingView 难真实测 → 真机 T012；
//        本 spec 验布局不崩（toolbar/输入区始终可见）。
//   6  点 + → 打开附件面板（4 入口）         ✓ US2「+ 开 sheet 4 入口…」
//   7  图片多选带回缩略图                    ✓ US2「…图片多选 2 张带回」
//   8  摄像头拍照带回                        ✓ US2「摄像头拍照带回…」
//   9  权限被拒 → 去设置引导不崩            ✗ web 不可达（expo-image-picker web 硬编码 granted）→
//        T009 标 blocked；被拒逻辑由 use-ideation-attachments.spec.ts（vitest）覆盖、真机手验 T012。
//   10 缩略图 × 移除不影响其它              ✓ US2「…×移除其一」
//   11 带图发送 → 文本照发 + 即将开放提示    ✓ US2「有附件点发送…」
//   12 stub 入口 → 即将开放 toast           ✓ US4「添加文件」stub；「选择代码库」stub 已于
//        034 接地接线后退役（入口改开 RepoPicker，picker 行为见 034 T012 ideation-grounding.spec）；
//        「麦克风」stub 已于 035 语音输入接线后退役（改 push-to-talk，行为见 035 T009 ideation-voice.spec）
//   13 面板关闭不丢文本与缩略图              ✓ 本 it（下）
//
test('033 T011 — 面板遮罩关闭不丢已输入文本与缩略图（state_branch 13）', async ({ page }) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);
  const input = page.getByTestId('ideation-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  // 先输入文本 + 带回 1 张缩略图。
  await input.fill('面板开合不应丢这段文本');
  await openPlusSheet(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('ideation-sheet-image').tap(),
  ]);
  await chooser.setFiles([pngFile('a.png')]);
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible({ timeout: 10_000 });

  // 再开面板 → 点遮罩（scrim，a11y「关闭创建菜单」）关闭 → sheet 消失。
  await openPlusSheet(page);
  await page.getByLabel('关闭创建菜单').tap();
  await expect(page.getByTestId('ideation-plus-sheet')).toBeHidden({ timeout: 10_000 });

  // 文本与缩略图均保留（FR-012：关闭不丢态）。
  await expect(input).toHaveValue('面板开合不应丢这段文本');
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible();
});

test('033 T011 — 流式窗口：发送 → 停止键可见可点 → abort（state_branch 3）', async ({ page }) => {
  const mock = await installIdeationMock(page);

  // 在 SSE /turns 上叠一条**更高优先级**延迟 route：hold 住响应造可断言流式窗口
  // （SSE 一次性 fulfill 否则瞬态，per 027/032 note）。Playwright route LIFO：本 route 先命中。
  // 初始 no-op（不用 null 联合：赋值发生在 route 闭包内，外层流分析看不见，
  // 行尾调用处会被窄化成 null → TS2349）。
  let releaseTurn: () => void = () => undefined;
  await page.route('**/api/v1/ideation/sessions/**/turns', async (route) => {
    if (route.request().method() !== 'POST') return void (await route.fallback());
    // 挂起：制造一个 client status='streaming' 的可观测窗口。
    await new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    // 释放后回最小一帧 + DONE，让闭环干净收尾。
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: SSE_HEADERS,
      body: 'data: {"token":"好"}\n\n' + 'data: [DONE]\n\n',
    });
  });

  await gotoSession(page, mock);
  const input = page.getByTestId('ideation-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  await input.fill('触发一轮流式');
  await page.getByTestId('ideation-send-button').tap();

  // 流式中：发送键切为停止键（isStreaming → stop，T003 零改逻辑）。
  const stopBtn = page.getByTestId('ideation-stop-button');
  await expect(stopBtn).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ideation-send-button')).toHaveCount(0);

  // 点停止 → abort（onStop）→ 回非流式态（停止键消失、发送键回归）。
  await stopBtn.tap();
  await expect(page.getByTestId('ideation-send-button')).toBeVisible({ timeout: 10_000 });
  await expect(stopBtn).toHaveCount(0);

  // 释放挂起的 route，避免 worker 卡住（abort 后响应已不被消费）。
  releaseTurn();
});

test('033 T011 — 移除项 absence：连接器 / 聊天气泡 / 旧菜单项均不渲染（FR-013）', async ({
  page,
}) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);
  await expect(page.getByTestId('ideation-input')).toBeVisible({ timeout: 15_000 });

  // 输入栏态：旧项不出现。
  for (const label of ['连接我的电脑', '添加技能', '创建网站', '制作幻灯片', '创作图像']) {
    await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  }
  // 连接器 / 聊天气泡入口 testID 不存在（旧 composer 残留入口）。
  await expect(page.getByTestId('ideation-input-connector')).toHaveCount(0);
  await expect(page.getByTestId('ideation-input-chat-bubble')).toHaveCount(0);

  // 打开 sheet：仅 4 个既定入口，旧项同样不在 sheet 内。
  await openPlusSheet(page);
  for (const label of ['连接我的电脑', '添加技能', '创建网站', '制作幻灯片', '创作图像']) {
    await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  }
});

test('033 T011 — 全交互 accessibilityLabel：输入栏 + sheet 入口 + 缩略图移除', async ({ page }) => {
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);
  await expect(page.getByTestId('ideation-input')).toBeVisible({ timeout: 15_000 });

  // ── 输入栏交互件 a11y label（scope 到 ideation 按钮栏：chat composer 同屏挂载、
  //    其 chat-send-button 同样 aria-label「发送」，page 级 getByLabel 会撞 strict-mode）──
  const toolbar = page.getByTestId('ideation-input-toolbar');
  await expect(toolbar.getByLabel('添加附件')).toBeVisible();
  // 035 mic 接一次性点录后 a11y label = IDEATION_COPY.voiceMicLabel「点击说话」（push-to-talk
  // 范式已随 06-24 Replan 翻案为点录一次性识别，label 由「按住说话」改「点击说话」）。
  await expect(toolbar.getByLabel('点击说话')).toBeVisible();
  await expect(toolbar.getByLabel('发送')).toBeVisible();

  // ── sheet 入口 + scrim a11y label（scrim「关闭创建菜单」与 create-overlay 同 label，
  //    用 sheet 自身 testID 定位 4 入口；scrim 验「至少一个可见」避撞）──
  await openPlusSheet(page);
  await expect(page.getByLabel('关闭创建菜单').first()).toBeVisible();
  const sheet = page.getByTestId('ideation-plus-sheet');
  for (const label of ['摄像头', '图片', '添加文件', '选择代码库']) {
    await expect(sheet.getByLabel(label)).toBeVisible();
  }

  // ── 缩略图移除按钮 a11y label（带回 1 张后）──
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('ideation-sheet-image').tap(),
  ]);
  await chooser.setFiles([pngFile('a.png')]);
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel('移除附件')).toBeVisible();
});
