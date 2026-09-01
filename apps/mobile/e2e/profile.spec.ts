import { expect, test } from './_support/fixtures';

import { mockJson } from './_support/api-mock';

// US5 / US7 / US8 / US9 / US11 — Expo Web e2e against pre-seeded auth state.
//
// 001-phone-sms-auth client (login + onboarding form) was deferred to W4+ in
// spec 001 (tasks.md L42), so we cannot run the full cold-boot login flow
// here. Instead we pre-seed window.localStorage under zustand-persist key
// `nvy-auth` so the AuthGate hydrates into 第三态 (isAuthenticated +
// displayName set) and lands on `/(app)/(tabs)/profile`.
//
// UpdateDisplayName client UI does not exist in mono yet (deferred alongside
// 001 client migration); the server PATCH endpoint is covered end-to-end by
// T023 (apps/server/test/integration/accounts.us2-002.it.spec.ts).

const SEED_DISPLAY_NAME = '小明';
const SEED_ACCOUNT_ID = 'acc-e2e-1';
const SEED_REFRESH_TOKEN = 'refresh-e2e-1';
// Phone is cosmetic here (the hero renders displayName, not phone) but the
// AccountProfileResponse contract requires a string, so the GET /me stub carries one.
const SEED_PHONE = '+8613800138000';

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
// 072 T017：「我的」消息栏内嵌的是预警消息中心（EP6 列表 / EP8 置已读）。
const MESSAGES_URL = '**/api/v1/alert/messages';
const MARK_READ_URL = '**/api/v1/alert/messages/mark-read';
// 072 T018：admin 的默认栏是审批栏，进 tab 即拉待审箱（EP: 列出待审估值）。
const SUBMISSIONS_URL = '**/api/v1/optionsdesk/anchor-submissions';

const SCREENSHOT_DIR = 'playwright-report/screenshots';

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
        refreshToken: '${SEED_REFRESH_TOKEN}',
        displayName: '${SEED_DISPLAY_NAME}',
        phone: null,
      },
      version: 0,
    }),
  );
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);

  // Stub the authed-boot network boundary so the suite is hermetic regardless of
  // whether a real backend happens to be listening on :3000 (per
  // docs/private/plans/2026-05/05-29-e2e-backend-boundary-hardening.md P1). The seed has
  // no accessToken (in-memory only on web), so without this stub AuthGate's useMe
  // GET /me would hit a real :3000, 401, fail the fake-refresh, clearSession and
  // bounce to /login — the exact env-dependent flake this plan removes.
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      status: 'ACTIVE',
      createdAt: '2026-05-25T00:00:00.000Z',
      // 072：契约必填位。默认非管理员 —— 管理员那格由下面的 admin 用例自己覆盖 stub。
      isAdmin: false,
    },
    'GET',
  );
  // Defensive: GET /me 200 means refresh normally never fires, but pin it so any
  // boot-time refresh attempt is answered locally instead of leaking to :3000.
  await mockJson(page, REFRESH_URL, 200, {
    accountId: SEED_ACCOUNT_ID,
    accessToken: 'access-e2e-1',
    refreshToken: SEED_REFRESH_TOKEN,
  });

  // 013 T015 把「投资」tab 占位换成自选主列表 → 进 tab 即拉 watchlist；同 /me stub 的理由
  // pin 其 boot 边界,让 tab-shell 套件保持 hermetic（投影 2 系统组 + 空 items,无需真后端）。
  await mockJson(
    page,
    '**/api/v1/portfolio/watchlist-groups',
    200,
    {
      groups: [
        {
          id: 'watchlist',
          name: '自选',
          type: 'system',
          systemKind: 'watchlist',
          visible: true,
          order: 0,
          itemCount: 0,
        },
        {
          id: 'holdings',
          name: '持仓',
          type: 'system',
          systemKind: 'holdings',
          visible: true,
          order: 1,
          itemCount: 0,
        },
      ],
    },
    'GET',
  );
  await mockJson(page, '**/api/v1/portfolio/watchlist-groups/*/items', 200, { items: [] }, 'GET');

  // 032 T012 后「灵感」tab = ideation 会话列表（tab 内嵌 stack 根屏）→ 进 tab 即拉 sessions；同 /me
  // stub 的理由 pin 其 boot 边界（空 items → 渲染空态，无需真后端，套件保持 hermetic）。
  await mockJson(page, '**/api/v1/ideation/sessions', 200, { items: [] }, 'GET');

  // 072 T017 后「我的」默认栏就是消息栏（非 admin）→ 进 tab 即拉 EP6 + 发 EP8；同 /me stub
  // 的理由 pin 其 boot 边界（空列表 → 渲染空态，无需真后端）。需要真数据的用例自己覆盖注册。
  await mockJson(page, MESSAGES_URL, 200, { messages: [], nextCursor: null }, 'GET');
  await mockJson(page, MARK_READ_URL, 200, { unread: 0 }, 'POST');
  // 同上：pin 待审箱边界（空箱 → 渲空态）。待审箱的真行为归
  // optionsdesk-anchor-submissions.spec.ts，本文件只管三栏结构。
  await mockJson(page, SUBMISSIONS_URL, 200, { items: [], total: 0, truncated: false }, 'GET');

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

// Metro web first compile on cold start can take 30-90s; subsequent navigations
// inside the same `expo start` session are fast. Per-test deadline accommodates
// the slow first bundle without flaking on retries.
test.setTimeout(120_000);

async function waitForBootedRoot(page: import('@playwright/test').Page) {
  await page.goto('/');
  // Wait until network goes idle so the JS bundle has finished downloading +
  // executing. Then expect the AuthGate-driven hero displayName text.
  await page.waitForLoadState('networkidle', { timeout: 90_000 });
}

test('US5 — onboarded cold boot lands on (tabs)/profile with hero rendered', async ({ page }) => {
  await waitForBootedRoot(page);
  // AuthGate should replace into /(app)/(tabs)/profile once persist hydrates
  // + nav container mounts. expo-router strips route groups from web URLs,
  // so the visible path is `/profile` rather than `/(app)/(tabs)/profile`.
  await expect(page).toHaveURL(/\/profile$|\(tabs\)\/profile/);

  await expect(page.getByText(SEED_DISPLAY_NAME)).toBeVisible();
  await expect(page.getByText('关注')).toBeVisible();
  await expect(page.getByText('粉丝')).toBeVisible();
  await expect(page.getByText('5', { exact: true })).toBeVisible();
  await expect(page.getByText('12', { exact: true })).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-profile-landing.png`, fullPage: true });
});

// 072 T016 —— 三栏由「笔记 / 图谱 / 知识库」改版为「审批 / 消息 / 知识库」（FR-011 / US6）。
//
// 🚫 **别用 `aria-selected` 断哪一栏激活**：`react-native-web` 整个不认 `accessibilityState`
//    （本仓 optionsdesk-chain-leg-picker.spec.ts 实撞并留档）。这里用「内容区渲的是哪一栏的
//    占位文案」作功能面判据 —— 它同时验了默认栏与内容分发两件事。
test('072 US6 — 非 admin 的「我的」：无审批栏、默认落消息栏、可切知识库', async ({ page }) => {
  // FR-012 的另一半（08-31 决策）：**默认**落在消息栏不算「主动点选」⇒ 不置已读。
  // 落地屏就是「我的」，这里若发了，等于开一次 App 就把 021 的未读红点清光。
  const markRead: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/alert\/messages\/mark-read/.test(req.url())) {
      markRead.push(req.url());
    }
  });

  await waitForBootedRoot(page);
  await expect(page.getByText(SEED_DISPLAY_NAME)).toBeVisible();

  // sb-20：客户端 isAdmin=false ⇒ 审批栏整栏不渲染（服务端另有 AdminOnlyGuard 兜权限）。
  await expect(page.getByRole('tab', { name: '审批' })).toHaveCount(0);
  // 默认栏 = 可见集合首项 = 消息，且渲的是真消息面（T017 接线；此处 stub 是空列表）。
  await expect(page.getByText('提醒', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无提醒消息')).toBeVisible();

  expect(markRead, `默认落在消息栏就发了置已读:\n${markRead.join('\n')}`).toEqual([]);

  const kbTab = page.getByRole('tab', { name: '知识库' });
  await kbTab.tap();
  await expect(page.getByText('知识库内容即将推出')).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us7-slide-tab-kb.png`, fullPage: true });
});

test('072 US6 — admin 的「我的」：三栏全出、默认落审批栏', async ({ page }) => {
  // 覆盖 beforeEach 的 /me stub（Playwright 后注册的 handler 先匹配）。冷启动种子里
  // isAdmin 不持久化 ⇒ 首帧按非 admin 渲染，/me 落地后当帧翻成三栏 —— 渲染期派生的实况。
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      status: 'ACTIVE',
      createdAt: '2026-05-25T00:00:00.000Z',
      isAdmin: true,
    },
    'GET',
  );

  await waitForBootedRoot(page);
  await expect(page.getByText(SEED_DISPLAY_NAME)).toBeVisible();

  await expect(page.getByRole('tab', { name: '审批' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '消息' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '知识库' })).toBeVisible();
  // 默认栏 = 审批（admin 是唯一有活要干的人）。断的是**面板容器**而不是文案：
  // 待审箱的行/徽标/驳回归 optionsdesk-anchor-submissions.spec.ts，这里只认「哪一栏在渲」。
  await expect(page.getByTestId('optionsdesk-submission-panel')).toBeVisible();

  await page.getByRole('tab', { name: '消息' }).tap();
  await expect(page.getByText('暂无提醒消息')).toBeVisible();
});

// 072 T017 / FR-012 —— 置已读的触发判据。
//
// 判据是「用户**主动点选**了消息栏」，既不是路由 focus，也不是「它恰好是激活栏」：
// 前者会让停在审批栏的人被静默清零，后者会让开一次 App 落在「我的」就清光（落地屏正是它）。
// admin 默认落审批栏，正好是「停在别的栏」的现场。
//
// 观察面选**请求**而不是未读角标：角标要等 EP7 refetch 才翻，中间隔着缓存与时序；
// 「EP8 到底发没发」才是这条 FR 的直接证据。采集端全开（记下每一发），过滤放断言端。
test('072 FR-012 — 置已读只跟随消息栏激活：停在审批栏不清零，切过去才清', async ({ page }) => {
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      status: 'ACTIVE',
      createdAt: '2026-05-25T00:00:00.000Z',
      isAdmin: true,
    },
    'GET',
  );
  // 4 条 —— 比内嵌栏的 limit(3) 多一条，好验截断真的生效。
  const messages = [1, 2, 3, 4].map((n) => ({
    id: `m-${n}`,
    market: 'cn',
    code: '600519',
    instrumentName: '贵州茅台',
    tradeDate: '2026-06-04',
    conditions: [{ type: 'PRICE_RISE_TO', threshold: '1700.00', actual: '1712.00' }],
    note: null,
    triggeredAt: `2026-06-0${n}T15:05:00+08:00`,
    unread: true,
  }));
  await mockJson(page, MESSAGES_URL, 200, { messages, nextCursor: null }, 'GET');

  const markRead: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/alert\/messages\/mark-read/.test(req.url())) {
      markRead.push(req.url());
    }
  });

  await waitForBootedRoot(page);
  await expect(page.getByTestId('optionsdesk-submission-panel')).toBeVisible();

  // 停在审批栏 ⇒ 一发置已读都没有。
  // ⚠️ 只断置已读，**不断**「列表一次都没拉」：冷启动种子不持久化 isAdmin，首帧按非 admin
  // 渲染时消息栏会短暂挂载并拉一次 EP6（sb-20 明确接受「审批栏要等 /me 落地才出现」）。
  // 那是一次无副作用的读；把它一起断掉等于断一条本设计没做出的保证。
  expect(markRead, `停在审批栏却发了置已读:\n${markRead.join('\n')}`).toEqual([]);

  await page.getByRole('tab', { name: '消息' }).tap();
  await expect(
    page
      .getByText('贵州茅台(600519) 触发预警：股价涨到 1700.00 元（今日最高 1712.00 元）。')
      .first(),
  ).toBeVisible();
  // limit=3（mockup 帧 ②）：第 4 条被截掉，其余走「查看全部」进全屏消息中心。
  await expect(page.getByText('预警触发')).toHaveCount(3);
  await expect.poll(() => markRead.length).toBeGreaterThan(0);
});

test('US8 — TopNav ⚙️ press triggers router.push for /(app)/settings', async ({ page }) => {
  await waitForBootedRoot(page);
  await expect(page.getByText(SEED_DISPLAY_NAME)).toBeVisible();

  // /(app)/settings is owned by spec B and does not exist in mono yet.
  // Pressing the gear should push the path; assert URL change rather than
  // expecting a destination render. Expo Router will show its Unmatched
  // route screen for missing targets — acceptable for this placeholder
  // boundary check.
  const gearButton = page.getByRole('button', { name: '设置' });
  await gearButton.tap();

  await page.waitForURL(/settings/);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us8-settings-push.png`, fullPage: true });
});

// 045 T021 起 TopNav 的 ≡ 从 002 占位转为**真入口**（点开全局抽屉，FR-023），故本用例收窄到
// 仍是占位的 🔍。抽屉开合 / 遮罩盖 Tab 栏 / 灵感入口的断言归 045 T025（hermetic 抽屉 e2e）。
test('US9 — TopNav 🔍 press is noop (no URL change)', async ({ page }) => {
  await waitForBootedRoot(page);
  await expect(page.getByText(SEED_DISPLAY_NAME)).toBeVisible();

  const urlBefore = page.url();
  await page.getByRole('button', { name: '搜索' }).tap();
  expect(page.url()).toBe(urlBefore);
});

test('US11 — bottom tab bar switches across 4 tabs', async ({ page }) => {
  await waitForBootedRoot(page);
  await expect(page.getByText(SEED_DISPLAY_NAME)).toBeVisible();

  // Expo Router Tabs uses @react-navigation bottom-tabs underneath; tabs
  // expose ARIA role="tab" in the web build. The 我的 tab is the landing —
  // exercise the tabs; the tab bar stays present throughout.
  // 045 T019：tab 集合 = 首页 / 期权台ᵍ / 投资ᵍ / 我的（灵感退位给期权台，路由留在
  // (tabs)/ 下走 href:null，入口改由全局抽屉承载）。
  await page.getByRole('tab', { name: '首页' }).tap();
  // 027 T012：首页占位已退役 → AI 对话屏；断言空态容器证屏已挂载（testID 稳，不依赖 /me 问候时序）。
  await expect(page.getByTestId('chat-empty-state')).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us11-tab-home.png`, fullPage: true });

  await page.getByRole('tab', { name: '投资' }).tap();
  // 013 T015：投资 tab 落地页 = 自选主列表（占位已退役）；断言列头「名称」证屏已挂载。
  await expect(page.getByText('名称', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: '我的' }).tap();
  // 027 T012：首页 chat 空态问候「嗨 {昵称}…」也含昵称子串 → 用 exact 只命中 profile hero 名节点（避免栈下层首页 DOM 仍挂的 getByText 双命中，per memory）。
  await expect(page.getByText(SEED_DISPLAY_NAME, { exact: true })).toBeVisible();

  // 045 FR-021：期权台 tab 在 markets-ON 下可见（本 suite 是 ON 构建；OFF 态「不渲染」
  // 由 markets-feature-gate.spec 断言）。落地屏内容属 T020/T022，此处只验按钮在位。
  await expect(page.getByRole('tab', { name: '期权台' })).toBeVisible();

  // FR-026：中央 + FAB 居「空槽」正中 —— 空槽恒在**可见** tab 集合中点，故两态都应压在视口水平
  // 中线上。fabLeftPct 按可见集合动态算（(tabs)/_layout.tsx）：ON 5 槽→50%，OFF 3 槽→50%；
  // 045 前 OFF 是 62.5%，两态同为 50% 是本次 tab 集合变更（左右各少一个 gated tab）的连带结果，
  // 不是「公式可以拍成常量」的理由（plan D10 已纠正 mockup 帧 ⑪ 的误导）。
  const fab = page.getByRole('button', { name: '创建' });
  await expect(fab).toBeVisible();
  const fabBox = await fab.boundingBox();
  const viewport = page.viewportSize();
  if (!fabBox || !viewport) throw new Error('FAB / viewport 尺寸不可得');
  expect(Math.abs(fabBox.x + fabBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
  // 灵感不再是 tab（FR-021），但路由零回归可达（FR-025）——直达 URL 仍落 ideation 列表根屏。
  // 032 T012：ideation 列表 = tab 内嵌 stack 根屏；断言空态标题证列表屏已挂载（空 sessions stub）。
  await page.goto('/ideation');
  await expect(page.getByText('还没有需求灵感会话')).toBeVisible({ timeout: 30_000 });
});
