import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 036 T015 — ideation 图片标注 + 多模态结合 主干 Expo Web e2e（hermetic，PR §V 第一层 UI 交互
// 验证）。覆盖 US1 标注脊柱 + US2 pin 语音 + US3 仅附图 + 取消/降级/流式/重载边界（7 场景）：
//   ① US1：缩略图 → 查看器 → 编辑 → 落 ≥2 pin（RNGH mouse 驱动）→ 写注记 → 发送 → user turn
//      现烧录图缩略 + 助手回复（FR-001/002/003/004/006/007/008，SC-001/002）。
//   ② US2：pin 注记麦克风 → 录音面板 → ✓ → transcript 落该 pin 注记框可编辑（FR-005，SC-004）。
//   ③ US3：仅附图（不进标注画布）+ 文字直发（FR-010）。
//   ④ 取消标注零副作用：返回 → 暂存图保留可重进（FR-012）。
//   ⑤ 降级：OSS 直传 5xx → 上传失败 toast，会话继续不脏写（FR-011，SC-003）。
//   ⑥ 流式态：附件入口 + send 禁用（FR-014）。
//   ⑦ 重载会话 → 历史带图轮缩略仍展示（FR-009 持久化重展示；GET sessions 注 attachments ossKey）。
//
// ── seam / route.fulfill 注入范式（干净上下文须知，035 同款 `__NVY_*` 铁律）──
// Web 无真系统相册/相机、无真原生 captureRef、无真麦克风。三处 hermetic seam（`addInitScript`
// 早于 app JS 注入，**仅 e2e harness 注入、生产 bundle 永不存在**）：
//   A. 图片选取 `globalThis.__NVY_IMAGE_PICKER_E2E__` —— pickFromLibrary/captureFromCamera 经它
//      返确定性 fixture 图（`{granted, uris}`），跳过真权限/系统相册。
//   B. SoM 展平 `globalThis.__NVY_VIEWSHOT_E2E__` —— flattenAnnotatedImage 经它返既定烧录图 uri
//      （web 无真 captureRef）。
//   C. ASR 录音器 `globalThis.__NVY_ASR_RECORDER_E2E__`（复用 035）—— pin 注记语音用。
// HTTP 边界经 `route.fulfill` 镜像契约：凭证签发 EP（PostObject 凭证）/ OSS host 直传（POST 200 /
// 5xx 降级 + GET 缩略 png）/ transcribe / turn SSE / GET sessions（重载注 attachments）。
//
// ── 交互驱动 ──
// 落 pin = canvas mouse click at position（RNGH single-tap 在 web 用 mouse 可确定驱动，per memory；
// 避开手势缩放的确定性断言，缩放回原仍同位留真机）。✓/✗/send = Pressable/IconButton `.tap()`。
//
// ── auth 边界（同 035 ideation-voice.spec + mobile-e2e-hermetic 规则）──
// seed localStorage 仅 refreshToken/accountId/displayName → boot 走 refresh 拿 access token。
// 必 mock /me + refresh-token（否则 AuthGate refresh 失败 → clearSession 跳 /login）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const SESSIONS_GLOB = '**/api/v1/ideation/sessions/**';
const SESSIONS_COLLECTION = '**/api/v1/ideation/sessions';
const CRED_GLOB = '**/api/v1/ideation/sessions/**/attachments/credential';
const TRANSCRIBE_URL = '**/api/v1/ideation/asr/transcribe';

// 烧录图落地的测试 OSS host（与 playwright.config.ts webServer 注入的
// EXPO_PUBLIC_OSS_PUBLIC_BASE_URL 同源 → 重载 hydratedAttachmentUris 出缩略 URL）。
const OSS_HOST = 'https://oss-e2e.example.com';
const OSS_GLOB = '**oss-e2e.example.com**';
const OBJECT_KEY = 'ideation/acc-e2e-036/uuid-e2e/burned';

const SEED_ACCOUNT_ID = 'acc-e2e-036';
const SEED_REFRESH_TOKEN = 'refresh-e2e-036';
const SEED_ACCESS_TOKEN = 'access-e2e-036';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139036';

const SESSION_ID = 'sess-1';
const SESSION_TITLE = '图片标注对焦需求';

/** pin 注记语音返回的固定 transcript（契约镜像 server `{text}`）。 */
const TRANSCRIBE_TEXT = '天空颜色改蓝一点';

// 1x1 透明 PNG（picker fixture + viewshot fixture + OSS 缩略 GET 响应体）。data: URI 让 web
// expo-image-manipulator 压缩可解析（真图 vs sentinel 字串，避免 canvas decode 崩）。
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_1x1}`;
const PNG_BUFFER = Buffer.from(PNG_1x1, 'base64');

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
const SSE_HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' };

const tokenFrames = (text: string) =>
  [...text].map((c) => `data: ${JSON.stringify({ token: c })}\n\n`).join('');
const DONE_FRAME = 'data: [DONE]\n\n';

// ── seam 注入脚本（addInitScript，早于 app JS） ──

/** 图片选取 seam：pick/camera 返确定性 fixture 图（uris=[data:URI]）；granted 控权限。 */
function imagePickerSeamScript(granted: boolean, uris: string[] = [PNG_DATA_URI]): string {
  return `
    (() => {
      globalThis.__NVY_IMAGE_PICKER_E2E__ = async () => ({ granted: ${granted}, uris: ${JSON.stringify(uris)} });
    })();
  `;
}

/** SoM 展平 seam：flattenAnnotatedImage 经它返既定烧录图 uri（web 无真 captureRef）。 */
function viewShotSeamScript(uri: string = PNG_DATA_URI): string {
  return `
    (() => {
      globalThis.__NVY_VIEWSHOT_E2E__ = async () => ${JSON.stringify(uri)};
    })();
  `;
}

/** 035 录音器 seam（复用）：granted 控权限；start 喂一帧 metering 驱波形；stop 返 sentinel data:。 */
function recorderSeamScript(granted: boolean): string {
  return `
    (() => {
      globalThis.__NVY_ASR_RECORDER_E2E__ = {
        requestPermission: async () => ({ granted: ${granted}, canAskAgain: true }),
        start: async (onMeter) => { try { onMeter && onMeter(-20); } catch (e) { /* noop */ } return true; },
        stopAndGetUri: async () => 'data:audio/aac;base64,AAAAAA==',
        cancel: async () => {},
      };
    })();
  `;
}

// ── HTTP 边界 mock ──

/** 凭证签发 EP（PostObject 凭证镜像 server 200）。 */
function credentialBody() {
  return {
    host: OSS_HOST,
    objectKey: OBJECT_KEY,
    expiresAt: '2026-06-26T00:15:00.000Z',
    fields: {
      key: OBJECT_KEY,
      policy: 'BASE64POLICY',
      'x-oss-signature-version': 'OSS4-HMAC-SHA256',
      'x-oss-credential': 'AK/20260626/cn-shanghai/oss/aliyun_v4_request',
      'x-oss-date': '20260626T000000Z',
      'x-oss-signature': 'deadbeef',
      success_action_status: '200',
    },
  };
}

interface OssOutcome {
  /** OSS host POST 直传响应状态（200 成功 / 5xx 降级）。 */
  postStatus: number;
}

/** 凭证 EP + OSS host（POST 直传 + GET 缩略）。postStatus=5xx → 直传失败降级（⑤）。 */
async function installOssMocks(page: Page, outcome: OssOutcome): Promise<void> {
  await page.route(CRED_GLOB, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    return void (await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(credentialBody()),
    }));
  });

  await page.route(OSS_GLOB, async (route: Route) => {
    const m = route.request().method();
    if (m === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    if (m === 'POST') {
      return void (await route.fulfill({
        status: outcome.postStatus,
        headers: { 'access-control-allow-origin': '*' },
        body: '',
      }));
    }
    // GET 缩略（ossThumbUrl 派生 URL）→ png。
    return void (await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: PNG_BUFFER,
    }));
  });
}

/** transcribe HTTP 响应（契约镜像 server `{text}`）。 */
async function installTranscribeMock(page: Page, text: string): Promise<void> {
  await page.route(TRANSCRIBE_URL, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    return void (await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ text }),
    }));
  });
}

interface IdeationMock {
  turnCount: () => number;
  createCount: () => number;
  /** 最近一次 turn POST 的 body（断言带图字段 attachmentKeys / annotationText）。 */
  lastTurnBody: () => Record<string, unknown> | null;
}

interface IdeationMockOptions {
  /**
   * ⑦ 重载：GET sessions 预置带图历史轮（user turn 带 attachments ossKey + assistant 回复）。
   * 非空 → GET 直接返回这些 turns（hydrate 出缩略 + 历史对话）。
   */
  seededTurns?: { role: string; content: string; attachments?: { ossKey: string }[] }[];
  /** 流式态测试（⑥）：turn POST 永不结束（hang）→ 会话停留 streaming 验附件/send 禁用。 */
  hangTurn?: boolean;
}

/** stateful ideation REST/SSE mock（同 035：建会话 / 详情 / SSE turn）。 */
async function installIdeationMock(
  page: Page,
  opts: IdeationMockOptions = {},
): Promise<IdeationMock> {
  let createdSeq = 0;
  let turnSeq = 0;
  let lastBody: Record<string, unknown> | null = null;
  const turns: {
    id: string;
    role: string;
    content: string;
    suggestion: unknown;
    attachments?: { ossKey: string }[];
  }[] = (opts.seededTurns ?? []).map((t, i) => ({
    id: `t-seed-${i}`,
    role: t.role,
    content: t.content,
    suggestion: null,
    attachments: t.attachments ?? [],
  }));

  await page.route(SESSIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname;

    // 凭证 EP（/attachments/credential）也命中本宽 glob —— playwright 后注册者优先，本 mock 可能
    // 比 CRED_GLOB 后注册 → 显式 fallback 让 installOssMocks 的 CRED handler 接（避免误吞凭证签发）。
    if (path.endsWith('/attachments/credential')) return void (await route.fallback());

    if (path.endsWith('/turns') && method === 'POST') {
      lastBody = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
      turnSeq += 1;
      const question = '收到，我看到你标注的位置了。还想补充别的吗？';
      turns.push({
        id: `t-user-${turnSeq}`,
        role: 'user',
        content: String(lastBody.annotationText ?? lastBody.content ?? '（用户输入）'),
        suggestion: null,
        attachments: [{ ossKey: OBJECT_KEY }],
      });
      turns.push({ id: `t-ai-${turnSeq}`, role: 'assistant', content: question, suggestion: null });
      if (opts.hangTurn) return; // 流式态：不响应 → 会话停留 streaming（⑥）。
      return void (await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: SSE_HEADERS,
        body: tokenFrames(question) + DONE_FRAME,
      }));
    }

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
          createdAt: '2026-06-26T00:00:00.000Z',
          updatedAt: '2026-06-26T00:00:00.000Z',
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
          createdAt: '2026-06-26T00:00:00.000Z',
          updatedAt: '2026-06-26T00:00:00.000Z',
        }),
      }));
    }
    await route.fallback();
  });

  return {
    turnCount: () => turnSeq,
    createCount: () => createdSeq,
    lastTurnBody: () => lastBody,
  };
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

test.setTimeout(120_000);

/** 进首页 → FAB 建会话 → push /ideation/[id]（复用 032/035 入口序）。 */
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

/** `+` 附件入口 → 图片 → seam fixture 图带回缩略条（暂存）。 */
async function pickStagedImage(page: Page) {
  await page.getByTestId('ideation-input-plus').tap();
  await expect(page.getByTestId('ideation-plus-sheet')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('ideation-sheet-image').tap();
  await expect(page.getByTestId('ideation-thumb-row')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible();
}

/** 进标注画布（缩略 → 查看器 → 编辑/标注）。 */
async function enterAnnotateCanvas(page: Page) {
  await page.getByTestId('ideation-thumb-open-0').tap();
  await expect(page.getByTestId('ideation-image-viewer')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('ideation-image-edit-entry').tap();
  await expect(page.getByTestId('ideation-image-annotate')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ideation-annotate-canvas')).toBeVisible();
}

/** 在画布点位置落 pin（RNGH single-tap 经 mouse click at position 确定驱动）。 */
async function dropPin(page: Page, x: number, y: number) {
  await page.getByTestId('ideation-annotate-canvas').click({ position: { x, y } });
}

/**
 * in-app header back（非 page.goBack —— 嵌套 Expo Stack popstate 被重映射到栈首屏，per memory
 * playwright_expo_goback_remaps_to_stack_first_screen + ideation-sessions.spec 范式）。
 * Expo Router web 把 headerLeft 渲为 `link`（role=link），a11y 名 = `<上屏标题>, back`。
 */
async function headerBack(page: Page) {
  await page.getByRole('link', { name: /back/i }).first().tap();
}

// ════════════════════════════════════════════════════════════════════════════
// ① US1 脊柱：缩略 → 查看器 → 编辑 → 落 2 pin → 写注记 → 发送 → user turn 烧录图缩略 + 助手回复
// ════════════════════════════════════════════════════════════════════════════
test('036 US1 — 缩略 → 查看器 → 标注落 2 pin → 注记 → 发送 → user turn 图缩略 + 助手回复（SC-001/002）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  await page.addInitScript(imagePickerSeamScript(true));
  await page.addInitScript(viewShotSeamScript());
  await installOssMocks(page, { postStatus: 200 });
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  await pickStagedImage(page);
  await enterAnnotateCanvas(page);

  // 落 2 个 pin（RNGH mouse 驱动）→ 编号 1/2 出现。
  await dropPin(page, 120, 200);
  await expect(page.getByTestId('ideation-annotation-pin-1')).toBeVisible({ timeout: 10_000 });
  await dropPin(page, 220, 320);
  await expect(page.getByTestId('ideation-annotation-pin-2')).toBeVisible({ timeout: 10_000 });

  // 注记行各写一段（编号 1/2 一一对应，FR-004/006）。
  await page.getByTestId('ideation-annotation-input-1').fill('天空改蓝');
  await page.getByTestId('ideation-annotation-input-2').fill('塔变红');

  // 发送（启用后点）→ 烧录(seam)+上传(cred+OSS POST)+合成文字 → 交接 → router.back 回对话屏。
  const sendBtn = page.getByTestId('ideation-annotation-send-button');
  await expect(sendBtn).toBeEnabled({ timeout: 10_000 });
  await sendBtn.tap();

  // 回对话屏 → user turn 现烧录图缩略 + 助手回复（SC-001 闭环）。
  await page.waitForURL(/\/ideation\/sess-1/, { timeout: 15_000 });
  await expect(page.getByTestId('ideation-turn-images')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ideation-turn-assistant')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);

  // 带图轮契约：body 带 attachmentKeys（烧录图 ossKey）+ annotationText（同编号合成文字，1:1）。
  const body = mock.lastTurnBody();
  expect(body?.attachmentKeys).toEqual([OBJECT_KEY]);
  expect(String(body?.annotationText)).toContain('1：天空改蓝');
  expect(String(body?.annotationText)).toContain('2：塔变红');
});

// ════════════════════════════════════════════════════════════════════════════
// ② US2：pin 注记麦克风 → 录音面板 → ✓ → transcript 落该 pin 注记框可编辑
// ════════════════════════════════════════════════════════════════════════════
test('036 US2 — pin 注记麦克风 → 录音面板 → ✓ → transcript 落注记框可编辑（FR-005/SC-004）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  await page.addInitScript(imagePickerSeamScript(true));
  await page.addInitScript(viewShotSeamScript());
  await page.addInitScript(recorderSeamScript(true)); // 录音权限 granted。
  await installOssMocks(page, { postStatus: 200 });
  await installTranscribeMock(page, TRANSCRIBE_TEXT);
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  await pickStagedImage(page);
  await enterAnnotateCanvas(page);

  // 落 1 pin → 注记行麦克风（点行 mic = 选中该 pin + 起录）。
  await dropPin(page, 150, 240);
  await expect(page.getByTestId('ideation-annotation-pin-1')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('ideation-annotation-mic-1').tap();

  // 录音面板（波形 + ✓/✗）→ ✓ → transcript 经 insert-at-cursor 落该 pin 注记框（草稿空 → 整段）。
  await expect(page.getByTestId('ideation-annotation-recording-panel')).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId('ideation-annotation-voice-confirm').tap();
  await expect(page.getByTestId('ideation-annotation-input-1')).toHaveValue(TRANSCRIBE_TEXT, {
    timeout: 10_000,
  });
  // 面板收起 + 注记框可编辑（追加验非锁态）。
  await expect(page.getByTestId('ideation-annotation-recording-panel')).toHaveCount(0, {
    timeout: 10_000,
  });
  await page.getByTestId('ideation-annotation-input-1').fill(`${TRANSCRIBE_TEXT}更亮`);
  await expect(page.getByTestId('ideation-annotation-input-1')).toHaveValue(
    `${TRANSCRIBE_TEXT}更亮`,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ③ US3：仅附图（不进标注画布）+ 文字直发 → user turn 带图 + 助手回复
// ════════════════════════════════════════════════════════════════════════════
test('036 US3 — 仅附图 + 文字直发（原图 + 文字多模态，FR-010）', async ({ page }) => {
  await seedAuthMocks(page);
  await page.addInitScript(imagePickerSeamScript(true));
  await installOssMocks(page, { postStatus: 200 });
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  await pickStagedImage(page);

  // 输入框写文字（不进标注画布）→ 发送 → 原图上传 + 带图轮提交。
  const input = page.getByTestId('ideation-input');
  await input.fill('这张图整体风格怎么改？');
  const sendBtn = page.getByTestId('ideation-send-button');
  await expect(sendBtn).toBeEnabled();
  await sendBtn.tap();

  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId('ideation-turn-images')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ideation-turn-assistant')).toBeVisible({ timeout: 15_000 });
  // 仅附图：body 带 attachmentKeys（原图）+ content 文本，无 annotationText（无 pin）。
  const body = mock.lastTurnBody();
  expect(body?.attachmentKeys).toEqual([OBJECT_KEY]);
  expect(body?.annotationText).toBeUndefined();
  expect(String(body?.content)).toContain('整体风格');
  // 发送后暂存图清空（缩略条收起）。
  await expect(page.getByTestId('ideation-thumb-row')).toHaveCount(0, { timeout: 10_000 });
});

// ════════════════════════════════════════════════════════════════════════════
// ④ 取消标注零副作用：进标注画布 → 返回 → 暂存图保留可重进（FR-012）
// ════════════════════════════════════════════════════════════════════════════
test('036 取消标注零副作用 — 返回查看器 → 暂存图保留，不发送（FR-012）', async ({ page }) => {
  await seedAuthMocks(page);
  await page.addInitScript(imagePickerSeamScript(true));
  await page.addInitScript(viewShotSeamScript());
  await installOssMocks(page, { postStatus: 200 });
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  await pickStagedImage(page);
  await enterAnnotateCanvas(page);
  await dropPin(page, 150, 240);
  await expect(page.getByTestId('ideation-annotation-pin-1')).toBeVisible({ timeout: 10_000 });

  // 返回（header back，非 page.goBack —— 嵌套 Stack popstate 被重映射到栈首屏，per memory）。
  // annotate → viewer（上屏标题「查看图片」）→ chat（上屏标题「图片标注对焦需求」会话名）。
  // a11y back 名 = `<上屏标题>, back`；用宽松正则容进入路径差异。
  await headerBack(page); // → 查看器。
  await expect(page.getByTestId('ideation-image-viewer')).toBeVisible({ timeout: 15_000 });
  await headerBack(page); // → 对话屏（暂存图仍在缩略条）。
  await expect(page.getByTestId('ideation-thumb-0')).toBeVisible({ timeout: 15_000 });
  // 未发送任何轮（零副作用）。
  expect(mock.turnCount()).toBe(0);
  await expect(page.getByTestId('ideation-turn-images')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 降级：标注发送 OSS 直传 5xx → 上传失败 toast，会话继续不脏写（FR-011/SC-003）
// ════════════════════════════════════════════════════════════════════════════
test('036 降级 — 标注发送 OSS 直传 5xx → 上传失败 toast，留标注屏不脏写（FR-011/SC-003）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  await page.addInitScript(imagePickerSeamScript(true));
  await page.addInitScript(viewShotSeamScript());
  await installOssMocks(page, { postStatus: 503 }); // OSS 直传非 2xx → 降级。
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  await pickStagedImage(page);
  await enterAnnotateCanvas(page);
  await dropPin(page, 150, 240);
  await expect(page.getByTestId('ideation-annotation-pin-1')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('ideation-annotation-input-1').fill('天空改蓝');

  const sendBtn = page.getByTestId('ideation-annotation-send-button');
  await expect(sendBtn).toBeEnabled({ timeout: 10_000 });
  await sendBtn.tap();

  // 上传失败 toast（不泄 vendor）+ 留在标注屏（pin/注记保留可重试，不脏写）。
  await expect(page.getByText('图片上传失败，请重试')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ideation-image-annotate')).toBeVisible();
  await expect(page.getByTestId('ideation-annotation-input-1')).toHaveValue('天空改蓝');
  // 无 turn 提交（不脏写对话）。
  expect(mock.turnCount()).toBe(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ 流式态：附件入口 + send 禁用（FR-014，与 send→stop 互斥）
// ════════════════════════════════════════════════════════════════════════════
test('036 流式态 — 附件入口 + send 禁用，变停止（FR-014）', async ({ page }) => {
  await seedAuthMocks(page);
  await page.addInitScript(imagePickerSeamScript(true));
  await installOssMocks(page, { postStatus: 200 });
  const mock = await installIdeationMock(page, { hangTurn: true }); // turn 不结束 → 停留 streaming。
  await gotoSession(page, mock);

  // 纯文本发一轮触发 streaming（turn POST hang → 不收 done）。
  const input = page.getByTestId('ideation-input');
  await input.fill('先聊聊背景');
  await page.getByTestId('ideation-send-button').tap();

  // 进 streaming：send 变停止钮，附件入口（+）禁用（FR-014）。
  await expect(page.getByTestId('ideation-stop-button')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ideation-input-plus')).toBeDisabled();
  await expect(page.getByTestId('ideation-send-button')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ 重载会话 → 历史带图轮缩略仍展示（FR-009 持久化重展示）
// ════════════════════════════════════════════════════════════════════════════
test('036 重载 — GET sessions 注 attachments → 历史带图轮缩略仍展示（FR-009）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  await installOssMocks(page, { postStatus: 200 });
  // 预置带图历史轮（user turn 带 attachments ossKey + assistant 回复）→ 冷启 hydrate 出缩略。
  await installIdeationMock(page, {
    seededTurns: [
      { role: 'user', content: '1：天空改蓝', attachments: [{ ossKey: OBJECT_KEY }] },
      { role: 'assistant', content: '收到，已记录天空配色。' },
    ],
  });

  // 直接 deep-link 进会话详情（冷启 reload，非建会话路径）→ hydrate 历史 turns。
  await page.goto('/ideation/sess-1');
  // 历史带图轮缩略渲染（hydratedAttachmentUris(ossKey, OSS_PUBLIC_BASE_URL) → ossThumbUrl 派生）。
  await expect(page.getByTestId('ideation-turn-images')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('ideation-turn-assistant')).toBeVisible({ timeout: 15_000 });
});
