import { expect, test, type Page, type Route } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// 035 T008 — ideation 语音输入（一次性文件识别）主干 Expo Web e2e（hermetic，PR §V 第一层 UI
// 交互验证）。覆盖 US1 脊柱 + US2 取消/权限 + US3 降级：
//   ① 开会话 → 点 mic 见录音面板（波形 + ✓/✗）→ ✓ → processing → transcript 落框可编辑
//      → 编辑后发送（走既有 turn SSE，FR-001/003/004/010）
//   ② 点 ✗ 取消零副作用（FR-005）：录音面板收起、草稿不变（确定性按钮，非旧 Pan 手势）
//   ③ 权限拒（seam 返 granted=false）→ 去设置 toast（FR-006）
//   ④ transcribe 5xx → 降级 toast「转写失败」，会话不崩可继续（FR-007/009，SC-004）
//   ⑤ 空 transcript（静音）→「未识别到语音」轻提示、不回填（FR-008）
//
// ── 录音 / transcribe fake 注入范式（干净上下文须知）──
// Web 无真麦克风 + 无真原生录音器。两处 hermetic 注入（均**契约镜像**而非测试标志分支，per
// mobile-impl-playbook §6）：
//   A. 录音器 seam `globalThis.__NVY_ASR_RECORDER_E2E__`（UseIdeationVoice 形状）——`addInitScript`
//      早于 app JS 注入；use-ideation-voice 运行时取它（仅 web / 真模块缺失时），令权限 granted +
//      start/stopAndGetUri 返确定性 sentinel URI（不产真音频）。**仅 e2e 注入、生产 bundle 无 __NVY_*。**
//   B. HTTP transcribe 端点 `route.fulfill`——拦 `POST /api/v1/ideation/asr/transcribe`，返
//      `{text:'<fixture>'}`（契约镜像 server 200）/ 503 ProblemDetail（降级）/ `{text:''}`（静音）。
//
// ── 交互驱动（一次性范式，确定性优于旧 push-to-talk）──
// mic = 普通 `Pressable`（`.tap()` 触 onPressMic）；✓/✗ = `IconButton`（`.tap()`）。无长按 / 无 Pan
// → headless web 全确定（旧「下滑取消」Pan 非确定问题随范式翻案一并消除，cancel 改 ✗ 按钮可 e2e 验）。
//
// ── auth 边界（同 032 ideation-clarify.spec + mobile-e2e-hermetic 规则）──
// seed localStorage 仅 refreshToken/accountId/displayName → boot 走 refresh 拿 access token。
// 必 mock /me + refresh-token（否则 AuthGate refresh 失败 → clearSession 跳 /login）。transcribe
// 鉴权（401）由 T004 server IT + T009 contract-smoke 真链覆盖，此处 fulfill 不校验 token。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const SESSIONS_GLOB = '**/api/v1/ideation/sessions/**';
const SESSIONS_COLLECTION = '**/api/v1/ideation/sessions';
const TRANSCRIBE_URL = '**/api/v1/ideation/asr/transcribe';

const SEED_ACCOUNT_ID = 'acc-e2e-035';
const SEED_REFRESH_TOKEN = 'refresh-e2e-035';
const SEED_ACCESS_TOKEN = 'access-e2e-035';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139035';

const SESSION_ID = 'sess-1';
const SESSION_TITLE = '语音输入听写功能';

/** 一次性识别返回的固定 transcript（契约镜像 server `{text}`）。 */
const TRANSCRIBE_TEXT = '你想给行情页加收藏';

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

/**
 * 录音器 seam（hermetic）：令 web 上 use-ideation-voice 经 `__NVY_ASR_RECORDER_E2E__` 拿到确定性
 * 录音器替身。权限由 `granted` 控制；start 触发一帧 metering（驱波形）；stopAndGetUri 返 sentinel URI。
 */
function recorderSeamScript(granted: boolean): string {
  return `
    (() => {
      globalThis.__NVY_ASR_RECORDER_E2E__ = {
        requestPermission: async () => ({ granted: ${granted}, canAskAgain: true }),
        start: async (onMeter) => { try { onMeter && onMeter(-20); } catch (e) { /* noop */ } return true; },
        // 内联 data: URI（asr-upload 切尾段取 base64，无需真文件）→ HTTP transcribe 经 route.fulfill。
        stopAndGetUri: async () => 'data:audio/aac;base64,AAAAAA==',
        cancel: async () => {},
      };
    })();
  `;
}

/** transcribe HTTP 响应模式（契约镜像）。 */
type TranscribeOutcome = { status: 200; text: string } | { status: number };

async function installTranscribeMock(page: Page, resolve: () => TranscribeOutcome): Promise<void> {
  await page.route(TRANSCRIBE_URL, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      return void (await route.fulfill({ status: 204, headers: CORS }));
    }
    const r = resolve();
    // `'text' in r` 而非 `r.status === 200`：第二个联合成员 status: number 也含 200，
    // 判 status 不构成判别式、窄化不掉（TS2339）；有 text 即成功臂，语义等价。
    if ('text' in r) {
      return void (await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ text: r.text }),
      }));
    }
    // 转写失败 → ProblemDetail（ADR-0038），client 抛 → 降级 toast（FR-009）。
    return void (await route.fulfill({
      status: r.status,
      contentType: 'application/problem+json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        type: 'about:blank',
        title: 'ASR transcribe failed',
        status: r.status,
        detail: 'transcribe failed',
        code: 'ASR_TRANSCRIBE_FAILED',
      }),
    }));
  });
}

interface IdeationMock {
  turnCount: () => number;
  createCount: () => number;
}

/** stateful ideation REST/SSE mock（同 032 ideation-clarify：建会话 / 详情 / SSE turn）。 */
async function installIdeationMock(page: Page): Promise<IdeationMock> {
  let createdSeq = 0;
  let turnSeq = 0;
  const turns: { id: string; role: string; content: string; suggestion: unknown }[] = [];

  await page.route(SESSIONS_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname;

    if (path.endsWith('/turns') && method === 'POST') {
      turnSeq += 1;
      const question = '收到，已记下你的回答。还有别的要补充吗？';
      turns.push({
        id: `t-user-${turnSeq}`,
        role: 'user',
        content: '（用户输入）',
        suggestion: null,
      });
      turns.push({ id: `t-ai-${turnSeq}`, role: 'assistant', content: question, suggestion: null });
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
          createdAt: '2026-06-23T00:00:00.000Z',
          updatedAt: '2026-06-23T00:00:00.000Z',
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
          createdAt: '2026-06-23T00:00:00.000Z',
          updatedAt: '2026-06-23T00:00:00.000Z',
        }),
      }));
    }
    await route.fallback();
  });

  return { turnCount: () => turnSeq, createCount: () => createdSeq };
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

/** 点 mic 起录（普通 Pressable onPress；非长按）。 */
async function tapMic(page: Page) {
  const mic = page.getByTestId('ideation-input-mic');
  await expect(mic).toBeVisible({ timeout: 15_000 });
  await mic.tap();
}

// ════════════════════════════════════════════════════════════════════════════
// ① US1 脊柱：点 mic → 录音面板（波形 ✓/✗）→ ✓ → transcript 落框可编辑 → 编辑后发送
// ════════════════════════════════════════════════════════════════════════════
test('035 US1 — 点 mic 录音面板 → ✓ 一次性识别 → transcript 落框可编辑 → 编辑后发送（SC-001/002/003）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  await page.addInitScript(recorderSeamScript(true)); // 权限 granted 录音器替身。
  await installTranscribeMock(page, () => ({ status: 200, text: TRANSCRIBE_TEXT }));
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  const input = page.getByTestId('ideation-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  // ── 点 mic → 录音面板出（波形 + ✓ + ✗）；输入框全程可编辑（FR-001，一次性范式无 partial）──
  await tapMic(page);
  await expect(page.getByTestId('ideation-recording-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ideation-waveform')).toBeVisible();
  await expect(page.getByTestId('ideation-voice-confirm')).toBeVisible();
  await expect(page.getByTestId('ideation-voice-cancel')).toBeVisible();
  await expect(input).toBeEditable();

  // ── ✓ → processing → transcript 经 insert-at-cursor 落框（草稿空 → 整段即值，FR-003/010）──
  await page.getByTestId('ideation-voice-confirm').tap();
  await expect(input).toHaveValue(TRANSCRIBE_TEXT, { timeout: 10_000 });
  // 面板收起（filled）+ 输入框仍可编辑。
  await expect(page.getByTestId('ideation-recording-panel')).toHaveCount(0, { timeout: 10_000 });
  await expect(input).toBeEditable();

  // ── 编辑 transcript（验非锁态）→ 发送走既有 turn SSE（FR-004，SC-001）──
  await input.fill(`${TRANSCRIBE_TEXT}功能`);
  const sendBtn = page.getByTestId('ideation-send-button');
  await expect(sendBtn).toBeEnabled();
  await sendBtn.tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId('ideation-turn-assistant')).toBeVisible({ timeout: 15_000 });
  await expect(input).toHaveValue('');
});

// ════════════════════════════════════════════════════════════════════════════
// ② US2 取消：点 mic → 录音面板 → ✗ 取消零副作用（面板收起、草稿不变）
// ════════════════════════════════════════════════════════════════════════════
test('035 US2 — ✗ 取消零副作用：录音面板收起、草稿不变、可继续（FR-005）', async ({ page }) => {
  await seedAuthMocks(page);
  await page.addInitScript(recorderSeamScript(true));
  await installTranscribeMock(page, () => ({ status: 200, text: TRANSCRIBE_TEXT }));
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  const input = page.getByTestId('ideation-input');
  await expect(input).toBeVisible({ timeout: 15_000 });
  // 录音前先手敲草稿 → 取消后必须原样保留（零副作用）。
  await input.fill('键盘草稿');

  await tapMic(page);
  await expect(page.getByTestId('ideation-recording-panel')).toBeVisible({ timeout: 10_000 });

  // ✗ 取消 → 面板收起、草稿不变（不触 transcribe、不回填）。
  await page.getByTestId('ideation-voice-cancel').tap();
  await expect(page.getByTestId('ideation-recording-panel')).toHaveCount(0, { timeout: 10_000 });
  await expect(input).toHaveValue('键盘草稿');

  // 取消后可正常发送（会话不受影响）。
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
});

// ════════════════════════════════════════════════════════════════════════════
// ③ US2 权限：seam 返 granted=false → 点 mic 触权限拒 → 去设置 toast（FR-006）
// ════════════════════════════════════════════════════════════════════════════
test('035 US2 — 麦克风权限拒 → 去设置 toast，不崩、可改键盘（FR-006）', async ({ page }) => {
  await seedAuthMocks(page);
  await page.addInitScript(recorderSeamScript(false)); // 权限拒。
  await installTranscribeMock(page, () => ({ status: 200, text: TRANSCRIBE_TEXT }));
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  const input = page.getByTestId('ideation-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  await tapMic(page);
  // 权限拒 → 去设置 toast（FR-006，不 throw、会话继续）。
  await expect(page.getByText('需要麦克风权限·去设置')).toBeVisible({ timeout: 10_000 });
  // 录音面板不出（未起录）+ 输入框可编辑可继续。
  await expect(page.getByTestId('ideation-recording-panel')).toHaveCount(0);
  await expect(input).toBeEditable();
  await input.fill('键盘照常用');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
});

// ════════════════════════════════════════════════════════════════════════════
// ④ US3 降级：transcribe 5xx → 降级 toast「转写失败」，会话不崩可继续（FR-007/009，SC-004）
// ════════════════════════════════════════════════════════════════════════════
test('035 US3 — transcribe 5xx → 降级 toast「转写失败」，会话不崩可继续（FR-007/SC-004）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  await page.addInitScript(recorderSeamScript(true));
  await installTranscribeMock(page, () => ({ status: 503 }));
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  const input = page.getByTestId('ideation-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  await tapMic(page);
  await expect(page.getByTestId('ideation-recording-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('ideation-voice-confirm').tap();

  // 转写失败 → 降级 toast（IdeationToast pill 按可见文本定位）。
  await expect(page.getByText('转写失败，请重试或改用键盘')).toBeVisible({ timeout: 10_000 });

  // 会话不崩（SC-004）：面板收起、输入框可编辑、不回填、可改键盘继续。
  await expect(page.getByTestId('ideation-recording-panel')).toHaveCount(0, { timeout: 10_000 });
  await expect(input).toBeEditable();
  await expect(input).toHaveValue('');
  await input.fill('改用键盘输入也行');
  await page.getByTestId('ideation-send-button').tap();
  await expect.poll(() => mock.turnCount(), { timeout: 30_000 }).toBe(1);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ US3 静音：transcribe 返空 transcript → 「未识别到语音」轻提示、不回填（FR-008）
// ════════════════════════════════════════════════════════════════════════════
test('035 US3 — 空 transcript（静音）→「未识别到语音」轻提示、不回填（FR-008）', async ({
  page,
}) => {
  await seedAuthMocks(page);
  await page.addInitScript(recorderSeamScript(true));
  await installTranscribeMock(page, () => ({ status: 200, text: '' }));
  const mock = await installIdeationMock(page);
  await gotoSession(page, mock);

  const input = page.getByTestId('ideation-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  await tapMic(page);
  await expect(page.getByTestId('ideation-recording-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('ideation-voice-confirm').tap();

  await expect(page.getByText('未识别到语音')).toBeVisible({ timeout: 10_000 });
  // 不回填（草稿保持空）+ 面板收起 + 可继续。
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('ideation-recording-panel')).toHaveCount(0, { timeout: 10_000 });
});
