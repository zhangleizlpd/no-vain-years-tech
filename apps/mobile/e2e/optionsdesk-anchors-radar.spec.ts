import { expect, test, type Page, type Route } from '@playwright/test';
import type { AnchorResponse } from '@nvy/api-client';

import { mockJson } from './_support/api-mock';

// 045 T025 — 期权台 hermetic UI e2e（Playwright Expo Web，Constitution §V 两层验证之一）。
//
// 覆盖（逐条对应 tasks.md T025）：
//   ① 雷达五态渲染 + **SC-006 四降级态互不混淆**（单票缺失 / 锚逾期 / 锚库为空 / 全体不动区）
//   ② 抽屉开合 + **遮罩盖住底部 Tab 栏** + onRequestClose 关（= Android 硬件返回的同一入口）
//   ③ 一级页汉堡（4 个一级 tab 屏）/ 二级页返回箭头 / 全屏子屏无悬空汉堡（**EC-17**）
//   ④ **markets ON 两态之一**：tab 集合 + FAB 位置（**SC-008**；OFF 那半在 markets-feature-gate.spec）
//   ⑤ 锚表单三处人工位的标记与撤销（FR-032 ②③）
//   ⑥ **灵感四项能力零回归（SC-010）**：列表 / 详情 / 图片标注 / 中央 FAB 新建
//
// ── 抽屉结构（user 2026-08-01 裁决方案 C，断言照此）─────────────────────────
//   首页汉堡 `chat-menu-button` → **chat 会话抽屉**（既有 8 个 testID 一字未动，内新增
//   `chat-drawer-ideation-entry`）；期权台 / 投资 / 我的汉堡 → **全局抽屉** `app-drawer`
//   （`-panel` / `-backdrop` 由容器按前缀派生，内含 `app-drawer-ideation-entry` /
//   `-user-name` / `-settings-button`）。两处灵感入口是**同一个** IdeationDrawerEntry。
//
// ── hermetic mock 纪律（per docs/conventions/mobile-impl-playbook.md §6）────────
//   mock 写**依赖方（server）契约**：持一份 canonical 锚集合，handler 是
//   `(request, canonical 状态) → response` 的纯函数（emptyState / 排序 / 筛选 / PATCH 求值
//   全按 server 口径复算）。**禁**按测试编排标志分支。各 test 自带不同 canonical 数据集 =
//   不同的 DB 内容（相当于换一份 fixture），不是「同一份数据按测试名分叉」。
//
// ── Expo web e2e 六坑（memory expo_web_e2e_and_router_footguns）────────────────
//   · `page.goBack()` 会被嵌套 Stack 重映射到栈首屏 ⇒ 一律用 header back（role=link，
//     a11y 名 `<上屏标题>, back`）。
//   · 叠屏 DOM 双命中 ⇒ `getByRole` / `getByTestId` 收窄，必要时 `.first()`。
//   · LongPress 可驱、Pan 不可 ⇒ 抽屉只驱 tap 开 / backdrop tap 关 / Escape 关，**不驱 swipe**。
//   · `(group)` 段在 URL 隐藏（`/(app)/(tabs)/optionsdesk` → `/optionsdesk`）；tab 需 `hasTouch`
//     + `role=tab`（两个 config 都开了 hasTouch）。
//   · 硬刷新丢返回是设计 ⇒ 二级页 headerLeft 走 `makeHeaderBackOrParent` 回落父路由。
//
// ── auth 范式 ────────────────────────────────────────────────────────────────
//   seed localStorage（含 accessToken）→ boot GET /me 必拦；**refresh-token 也必拦**，
//   否则任一 authed 401 触发 003 拦截器 retry-once 失败 → clearSession 误登出
//   （memory authed_business_401_triggers_refresh_interceptor）。
//
// ── ⚠️ Android 硬件返回关抽屉：**本层故意不断言**（不是漏了）──────────────────
//   抽屉的硬件返回接线是 `~/ui/app-drawer.tsx` 的 `Modal onRequestClose={onClose}`，**只在
//   原生**由 Android 返回键触发；web 没有硬件返回键。react-native-web 的 ModalContent 把
//   Escape keyup 接到同一个 `onRequestClose`，看似是现成的等价驱动 —— 但实测**不确定**：
//   Metro dev bundle 下 Escape 能关，`expo export` 出的产物 bundle 下同一段代码关不掉
//   （RNW 的 `isActive` 由 ModalAnimation 的 onShow 回调置位，两种 bundle 下时序不同）。
//   把它写进断言等于给套件埋一个 dev 绿 / runtime-smoke 红的 flake 源。故本 spec 只断言
//   **web 上确定可驱**的关闭路径（遮罩 tap），硬件返回那半由真机验证承担
//   （swipe-left 关同理：RNGH 的 Pan 在 headless web 非确定，per Expo web e2e 六坑）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const IDEATION_SESSIONS_RE = /\/api\/v1\/ideation\/sessions/;
const CHAT_CONVERSATIONS_RE = /\/api\/v1\/chat\/conversations/;

const SEED_ACCOUNT_ID = 'acc-e2e-045';
const SEED_ACCESS_TOKEN = 'access-e2e-045';
const SEED_REFRESH_TOKEN = 'refresh-e2e-045';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139045';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};
const JSON_HEADERS = { 'access-control-allow-origin': '*' };

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
        accessToken: '${SEED_ACCESS_TOKEN}',
        refreshToken: '${SEED_REFRESH_TOKEN}',
        displayName: '${SEED_DISPLAY_NAME}',
        phone: '${SEED_PHONE}',
      },
      version: 0,
    }),
  );
`;

/** 本地日历日 —— 只作 fixture 的 asOf 取值（新鲜度档由 mock 的 `quoteFreshnessTier` 显式给）。 */
const TODAY = (() => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
})();

// ════════════════════════════════════════════════════════════════════════════
// canonical 锚集合（= 服务端 DB 内容的镜像）
// ════════════════════════════════════════════════════════════════════════════

/** 各 L 档派生单票上限（server anchor.rules 口径；L4 无 SoT ⇒ null）。 */
const DERIVED_CAP: Record<string, string | null> = {
  L1: '0.2500',
  L2: '0.0500',
  L3: '0.0200',
  L4: null,
};

const ANCHOR_BASE: Omit<AnchorResponse, 'id' | 'ticker'> = {
  v: '100.00',
  vModel: '100.00',
  asof: '2026-07-01',
  method: 'DCF',
  confidence: '8.0',
  confidenceSource: 'manual',
  excluded: false,
  excludeReason: null,
  nextReview: '2026-12-31',
  lastReviewedOn: '2026-07-01',
  overdue: false,
  overdueAgainstAsof: false,
  lLevelEffective: 'L2',
  positionCap: '0.0500',
  w: '80.00',
  zoneFloor: '60.00',
  zoneCeiling: '120.00',
  willingSellLongHold: '120.00',
  willingSellRent: '100.00',
  zone: 'buy',
  lastClose: '88.00',
  lastCloseDate: TODAY,
  // 🚨 新鲜度档由 **server** 下发 (FR-020) —— hermetic mock 是契约镜像, 必须照带。
  quoteFreshnessTier: 'CURRENT',
  // 061 生效 spot 三元组：本片 fixture 默认收盘档 ⇒ 与 lastClose / lastCloseDate 同值同粒度。
  spot: '88.00',
  priceKind: 'eod_close',
  spotAsOf: TODAY,
  distanceToWPct: '10.0',
  breachStartedOn: null,
  reviewFlagOn: false,
  vIsManual: false,
  lLevelIsManual: false,
  positionCapIsManual: false,
  vManual: null,
  lLevelManual: null,
  positionCapManual: null,
  derivedLLevel: 'L2',
  derivedPositionCap: '0.0500',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

function makeAnchor(
  over: Partial<AnchorResponse> & Pick<AnchorResponse, 'id' | 'ticker'>,
): AnchorResponse {
  return { ...ANCHOR_BASE, ...over };
}

/** 跌破 W（行情不可用的行**不计入**，与 server `belowW` 判据一致）。 */
function isBelowW(a: AnchorResponse): boolean {
  if (a.lastCloseDate === null || a.distanceToWPct === null) return false;
  return Number.parseFloat(a.distanceToWPct) < 0;
}

/** 雷达排序：距 W% 升序，行情不可用排尾（server 口径）。 */
function radarSort(items: AnchorResponse[]): AnchorResponse[] {
  return [...items].sort((x, y) => {
    const dx =
      x.distanceToWPct === null ? Number.POSITIVE_INFINITY : Number.parseFloat(x.distanceToWPct);
    const dy =
      y.distanceToWPct === null ? Number.POSITIVE_INFINITY : Number.parseFloat(y.distanceToWPct);
    return dx - dy;
  });
}

/** server 的空态三分（get-radar.usecase：baseTotal → pageItems → actionableTotal）。 */
const EMPTY_STATE_MESSAGES = {
  zero_anchors: '还没有锚 —— 先去锚管理建第一个锚',
  filtered_empty: '当前筛选无结果',
  all_idle: '今日无解，空仓是常态',
} as const;

interface OptionsdeskMock {
  /** PATCH 命中次数（验「写动作真发出去了」，与 UI 断言正交）。 */
  patchCount: () => number;
  /** 最近一次 PATCH 的 body（验撤销发的是 `null` 而非空串 / 缺字段）。 */
  lastPatchBody: () => Record<string, unknown> | null;
}

/**
 * 期权台 hermetic mock —— 一个 route + 一份 canonical 锚集合。
 *
 * handler 全是 `(request, anchors) → response` 的纯函数：
 *  · `GET /radar`   —— 排除 excluded（FR-005）→ 应用筛选 → 排序 → 按 server 口径判空态
 *  · `GET /anchors` —— excluded **照常在列**（Guardrail 12：与雷达相反）
 *  · `GET /anchors/:id` / `PATCH /anchors/:id` —— 人工位置值 / 撤销按 server 求值口径回写
 *
 * 🚨 没有任何「按测试名 / 客户端信号」的分支：不同场景靠传入不同的 canonical 集合表达。
 */
async function installOptionsdeskMock(
  page: Page,
  seed: AnchorResponse[],
): Promise<OptionsdeskMock> {
  const anchors = seed.map((a) => ({ ...a }));
  let patchSeq = 0;
  let lastBody: Record<string, unknown> | null = null;

  await page.route(OPTIONSDESK_RE, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    const url = new URL(req.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });

    // ── GET /optionsdesk/radar ────────────────────────────────────────────
    if (path.endsWith('/optionsdesk/radar')) {
      // `lLevels` 走重复键（客户端 paramsSerializer indexes:null），server 端还接 CSV。
      const lLevels = new Set(
        url.searchParams
          .getAll('lLevels')
          .flatMap((v) => v.split(','))
          .filter(Boolean),
      );
      const pendingReview = url.searchParams.get('pendingReview') === 'true';
      const belowW = url.searchParams.get('belowW') === 'true';

      const base = anchors.filter((a) => !a.excluded); // FR-005：雷达默认排除 excluded
      const filtered = base.filter(
        (a) =>
          (lLevels.size === 0 || lLevels.has(a.lLevelEffective)) &&
          (!pendingReview || a.overdue) &&
          (!belowW || isBelowW(a)),
      );
      const actionable = filtered.filter(isBelowW);

      const emptyState =
        base.length === 0
          ? 'zero_anchors'
          : filtered.length === 0
            ? 'filtered_empty'
            : actionable.length === 0
              ? 'all_idle'
              : null;

      return void (await json(200, {
        items: radarSort(filtered),
        nextCursor: null,
        hasMore: false,
        emptyState,
        emptyStateMessage: emptyState === null ? null : EMPTY_STATE_MESSAGES[emptyState],
      }));
    }

    // ── GET /optionsdesk/anchors（excluded 照常在列，Guardrail 12）───────────
    if (path.endsWith('/optionsdesk/anchors')) {
      if (method === 'GET') {
        const items = [...anchors].sort((x, y) => x.ticker.localeCompare(y.ticker));
        return void (await json(200, { items, total: items.length }));
      }
      return void (await route.fallback());
    }

    // ── /optionsdesk/anchors/:id ─────────────────────────────────────────
    const match = /\/optionsdesk\/anchors\/([^/]+)$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1] ?? '');
      const idx = anchors.findIndex((a) => a.id === id);
      if (idx < 0) return void (await json(404, { code: 'ANCHOR_NOT_FOUND' }));

      if (method === 'GET') return void (await json(200, anchors[idx]));

      if (method === 'PATCH') {
        patchSeq += 1;
        lastBody = (req.postDataJSON() as Record<string, unknown> | null) ?? {};
        anchors[idx] = applyAnchorPatch(anchors[idx] as AnchorResponse, lastBody);
        return void (await json(200, anchors[idx]));
      }
    }

    await route.fallback();
  });

  return { patchCount: () => patchSeq, lastPatchBody: () => lastBody };
}

/**
 * PATCH 求值（server 口径，FR-032 / FR-035 / EC-6）：
 *  · 人工位 = `null` → 撤销 ⇒ 生效值立即回落到派生值；
 *  · 人工位 = 值 → 生效值切到人工值（**值等于派生值时仍是人工态**，Guardrail 10 —— 判据是
 *    「人工列非 null」而非值比较）；
 *  · 置 L 层人工值**连带冲掉**单票上限人工值（EC-6），并按新生效 L 层重算派生上限。
 */
function applyAnchorPatch(anchor: AnchorResponse, patch: Record<string, unknown>): AnchorResponse {
  const next: AnchorResponse = { ...anchor };

  if ('vManual' in patch) {
    const value = patch['vManual'] as string | null;
    next.vManual = value;
    next.vIsManual = value !== null;
    next.v = value ?? next.vModel;
  }

  if ('lLevelManual' in patch) {
    const value = patch['lLevelManual'] as AnchorResponse['lLevelManual'];
    next.lLevelManual = value;
    next.lLevelIsManual = value !== null;
    next.lLevelEffective = value ?? next.derivedLLevel;
    if (value !== null) {
      next.positionCapManual = null;
      next.positionCapIsManual = false;
    }
    next.derivedPositionCap = DERIVED_CAP[next.lLevelEffective] ?? null;
  }

  if ('positionCapManual' in patch) {
    const value = patch['positionCapManual'] as string | null;
    next.positionCapManual = value;
    next.positionCapIsManual = value !== null;
  }

  next.positionCap = next.positionCapIsManual ? next.positionCapManual : next.derivedPositionCap;
  return next;
}

/** 灵感 mock（SC-010 零回归所需的最小契约面：list + detail）。 */
async function installIdeationMock(page: Page): Promise<void> {
  const session = {
    id: 'sess-045-1',
    title: '期权台雷达优化',
    status: 'open',
    updatedAt: '2026-08-01T00:01:00.000Z',
  };
  const turns = [
    { id: 't-user-1', role: 'user', content: '雷达行想加一列', suggestion: null },
    { id: 't-ai-1', role: 'assistant', content: '想加的是哪一维？', suggestion: null },
  ];

  await page.route(IDEATION_SESSIONS_RE, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;
    const body = path.endsWith('/sessions')
      ? { items: [session] }
      : {
          ...session,
          repo: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          turns,
          brief: null,
        };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  });
}

/**
 * 投资 tab 落地屏（自选）的最小契约面 —— 只为让该屏正常渲染出题头汉堡。
 * 不 mock 的话自选查询打真后端失败 ⇒ 整屏被「自选加载失败」错误态替换、题头根本不渲染
 * （汉堡断言会误判成「045 没给投资页加汉堡」，实为数据层没起来）。
 */
async function installPortfolioMock(page: Page): Promise<void> {
  const groups = [
    {
      id: 'g-watch',
      name: '自选',
      type: 'system',
      systemKind: 'watchlist',
      visible: true,
      order: 0,
      itemCount: 0,
    },
  ];
  await page.route(/\/api\/v1\/portfolio\//, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const path = new URL(req.url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify(path.endsWith('/items') ? { items: [] } : { groups }),
    });
  });
}

/** chat 会话列表（首页 boot + chat 抽屉需要）。 */
async function installChatMock(page: Page): Promise<void> {
  await page.route(CHAT_CONVERSATIONS_RE, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify({ items: [] }),
    });
  });
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
  // 防 authed 401 触发 003 refresh 拦截器误登出。
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

/** 进期权台 tab（首发吃 Metro 冷打包 ⇒ 长超时锚在 tab bar）。 */
async function gotoOptionsdesk(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '期权台' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '期权台' }).tap();
  await expect(page.getByTestId('optionsdesk-anchors-button')).toBeVisible({ timeout: 30_000 });
}

/**
 * navigator header 的返回箭头。a11y 名恒为 `<上屏标题>, back`，但**角色随 header 实现变**
 * （expo-router 有的栈渲成 `link`、native-stack 的 HeaderBackButton 渲成 `button`）⇒ 两者取并。
 */
function headerBackLocator(page: Page) {
  return page
    .getByRole('button', { name: /back/i })
    .or(page.getByRole('link', { name: /back/i }))
    .first();
}

/** in-app header back（非 page.goBack —— 嵌套 Stack 的 popstate 被重映射到栈首屏）。 */
async function headerBack(page: Page): Promise<void> {
  await headerBackLocator(page).tap();
}

/**
 * tap 遮罩关抽屉。**必须点右侧露出带**：面板占屏宽 82% 且盖在遮罩之上，点左半区会被
 * Playwright 的 actionability 判为「元素被面板拦截 pointer」。
 */
async function closeDrawerByBackdrop(page: Page, testIDPrefix: string): Promise<void> {
  const backdrop = page.getByTestId(`${testIDPrefix}-backdrop`);
  const box = await backdrop.boundingBox();
  if (!box) throw new Error(`${testIDPrefix}-backdrop 尺寸不可得`);
  await backdrop.tap({ position: { x: box.width - 10, y: 40 } });
  await expect(page.getByTestId(testIDPrefix)).toHaveCount(0);
}

/** 进首页 tab（`page.goto('/')` 的落地屏不保证是首页 ⇒ 显式切，同 032/036 spec 体例）。 */
async function gotoHomeTab(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: '首页' }).tap();
  await expect(page.getByTestId('chat-menu-button')).toBeVisible({ timeout: 30_000 });
}

// ════════════════════════════════════════════════════════════════════════════
// ① 雷达五态 + SC-006 四降级态互不混淆
// ════════════════════════════════════════════════════════════════════════════

test('045 雷达 — 常态同屏承载「单票行情缺失」与「锚逾期」两降级态，且不与两个空态混淆（SC-006）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [
    makeAnchor({
      id: '1',
      ticker: 'us:AOS',
      distanceToWPct: '-4.5',
      lastClose: '76.40',
      zone: 'deep_buy',
    }),
    makeAnchor({
      id: '2',
      ticker: 'us:PEP',
      overdue: true,
      nextReview: '2026-01-01',
      distanceToWPct: '6.0',
    }),
    // 单票行情缺失：行仍在列表、数值与 asOf 同生共死（SC-004 / FR-017）。
    makeAnchor({
      id: '3',
      ticker: 'us:TAP',
      lastClose: null,
      lastCloseDate: null,
      // 061：两价皆无 ⇒ 生效 spot 三元组一起空（行内一切数值的闸看 spotAsOf）。
      spot: null,
      spotAsOf: null,
      zone: null,
      distanceToWPct: null,
    }),
  ]);
  await gotoOptionsdesk(page);

  await expect(page.getByTestId('optionsdesk-radar-list')).toBeVisible({ timeout: 30_000 });

  // 三行全在（缺行情的行**不隐藏**）。
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-radar-row-us:PEP')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-radar-row-us:TAP')).toBeVisible();

  // 降级态 1 —— 单票行情缺失：行内显式「行情不可用」+ 色带**没有** spot 点（禁 0 值 / 禁伪造）。
  const tapRow = page.getByTestId('optionsdesk-radar-row-us:TAP');
  await expect(tapRow.getByText('行情不可用').first()).toBeVisible();
  await expect(page.getByTestId('optionsdesk-radar-band-us:TAP-spot')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-band-us:TAP-spot-clamped')).toHaveCount(0);
  // 锚是自产数据 ⇒ 色带与 W 红圈照常在（降级的只是行情那一半）。
  await expect(page.getByTestId('optionsdesk-radar-band-us:TAP-w-ring')).toBeVisible();
  // 有行情的行才有 spot 点 —— 两者对照，证明「缺失」是行级而非整屏。
  await expect(page.getByTestId('optionsdesk-radar-band-us:AOS-spot')).toBeVisible();

  // 降级态 2 —— 锚逾期：只有 PEP 行带「锚逾期」徽标，且**不**波及其他行。
  await expect(page.getByTestId('optionsdesk-radar-row-us:PEP').getByText('锚逾期')).toBeVisible();
  await expect(tapRow.getByText('锚逾期')).toHaveCount(0);

  // 降级态 3 / 4 —— 两个整屏态在常态下**必须缺席**（互不混淆的机械判据）。
  await expect(page.getByTestId('optionsdesk-radar-empty-zero')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-banner-idle')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-empty-filtered')).toHaveCount(0);

  // 新鲜度条：数值必带 asOf 档位（FR-016）。本组数据最新 asOf = 当日。
  await expect(page.getByTestId('optionsdesk-radar-freshness-CURRENT')).toBeVisible();
});

test('045 雷达 — 全体不动区：行照常渲染 + 顶部提示，不退化成空白页（SC-006）', async ({ page }) => {
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', distanceToWPct: '12.0' }),
    makeAnchor({ id: '2', ticker: 'us:PEP', distanceToWPct: '30.0' }),
  ]);
  await gotoOptionsdesk(page);

  const banner = page.getByTestId('optionsdesk-radar-banner-idle');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText(EMPTY_STATE_MESSAGES.all_idle);
  // 「不动区」≠「没数据」：行必须还在。
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-radar-row-us:PEP')).toBeVisible();
  // 与另外两个降级态互斥。
  await expect(page.getByTestId('optionsdesk-radar-empty-zero')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-empty-filtered')).toHaveCount(0);
});

test('045 雷达 — 锚库为空：专属空态文案 + 「去建锚」入口，不与「不动区 / 筛选无结果」复用（SC-006）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, []);
  await gotoOptionsdesk(page);

  const zero = page.getByTestId('optionsdesk-radar-empty-zero');
  await expect(zero).toBeVisible({ timeout: 30_000 });
  await expect(zero).toContainText(EMPTY_STATE_MESSAGES.zero_anchors);
  await expect(page.getByTestId('optionsdesk-radar-create-anchor')).toBeVisible();
  // 三空态文案互不复用 ⇒ 另两条不得同屏出现。
  await expect(page.getByTestId('optionsdesk-radar-banner-idle')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-empty-filtered')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-list')).toHaveCount(0);
});

test('045 雷达 — 筛选无结果：专属空态 + 清除筛选可恢复（第五态）', async ({ page }) => {
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', lLevelEffective: 'L3', distanceToWPct: '-2.0' }),
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 30_000 });

  // 某档无锚**不是**校验错误（FR-008）：L1 chip 恒在，可点，结果是空态而非报错。
  await page.getByTestId('optionsdesk-radar-filter-L1').tap();
  const filtered = page.getByTestId('optionsdesk-radar-empty-filtered');
  await expect(filtered).toBeVisible({ timeout: 20_000 });
  await expect(filtered).toContainText(EMPTY_STATE_MESSAGES.filtered_empty);
  await expect(page.getByTestId('optionsdesk-radar-empty-zero')).toHaveCount(0);

  await page.getByTestId('optionsdesk-radar-clear-filter').tap();
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 20_000 });
});

test('045 雷达 — 行情整体不可得：新鲜度条转「行情不可用」，行仍在（不静默当实时）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [
    makeAnchor({
      id: '1',
      ticker: 'us:AOS',
      lastClose: null,
      lastCloseDate: null,
      // 061：两价皆无 ⇒ 生效 spot 三元组一起空（行内一切数值的闸看 spotAsOf）。
      spot: null,
      spotAsOf: null,
      zone: null,
      distanceToWPct: null,
    }),
    makeAnchor({
      id: '2',
      ticker: 'us:PEP',
      lastClose: null,
      lastCloseDate: null,
      // 061：两价皆无 ⇒ 生效 spot 三元组一起空（行内一切数值的闸看 spotAsOf）。
      spot: null,
      spotAsOf: null,
      zone: null,
      distanceToWPct: null,
    }),
  ]);
  await gotoOptionsdesk(page);

  await expect(page.getByTestId('optionsdesk-radar-freshness-UNAVAILABLE')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-radar-freshness-CURRENT')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-freshness-STALE')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ② 抽屉开合 + 遮罩盖住底部 Tab 栏 + onRequestClose（Android 硬件返回同一入口）
// ════════════════════════════════════════════════════════════════════════════

test('045 抽屉 — 期权台汉堡开全局抽屉：遮罩盖住底部 Tab 栏，tap 遮罩关且关态零残留', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [makeAnchor({ id: '1', ticker: 'us:AOS' })]);
  await installIdeationMock(page);
  await gotoOptionsdesk(page);

  // 开抽屉**前**量一次 Tab 栏几何（开后 Modal 在其上层，先量避免被遮挡态干扰）。
  const tabBox = await page.getByRole('tab', { name: '我的' }).boundingBox();
  const viewport = page.viewportSize();
  if (!tabBox || !viewport) throw new Error('Tab 栏 / viewport 尺寸不可得');

  await page.getByTestId('optionsdesk-menu-button').tap();
  await expect(page.getByTestId('app-drawer')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('app-drawer-panel')).toBeVisible();
  // 抽屉内容三件套（品牌头 / 菜单区仅「灵感」/ 用户脚）。
  await expect(page.getByTestId('app-drawer-ideation-entry')).toBeVisible();
  await expect(page.getByTestId('app-drawer-user-name')).toBeVisible();
  await expect(page.getByTestId('app-drawer-settings-button')).toBeVisible();

  // 遮罩必须**盖过 Tab 栏底边**（抽屉渲在 tab content 容器内时够不到同级 Tab 栏 —— 走 root
  // 层 Modal 才盖得住；这条断言就是那次结构改动的回归探针）。
  const backdrop = page.getByTestId('app-drawer-backdrop');
  await expect(backdrop).toBeVisible();
  const backdropBox = await backdrop.boundingBox();
  if (!backdropBox) throw new Error('遮罩尺寸不可得');
  expect(backdropBox.y).toBeLessThanOrEqual(tabBox.y);
  expect(backdropBox.y + backdropBox.height).toBeGreaterThanOrEqual(tabBox.y + tabBox.height - 1);
  expect(backdropBox.width).toBeGreaterThanOrEqual(viewport.width - 1);

  // tap 遮罩关 —— 关态**整个 unmount**（不留半开面板 / 不留不可点的遮罩，EC-16 同一条底线）。
  await backdrop.tap({ position: { x: backdropBox.width - 10, y: 40 } });
  await expect(page.getByTestId('app-drawer')).toHaveCount(0);
  await expect(page.getByTestId('app-drawer-panel')).toHaveCount(0);
  await expect(page.getByTestId('app-drawer-backdrop')).toHaveCount(0);

  // 关掉后底层屏立刻可交互（遮罩没有残留拦截 pointer）—— 再开一次证明开关可反复。
  await page.getByTestId('optionsdesk-menu-button').tap();
  await expect(page.getByTestId('app-drawer')).toBeVisible();
});

// ════════════════════════════════════════════════════════════════════════════
// ③ 一级页汉堡 / 二级页返回箭头 / 全屏子屏无悬空汉堡（EC-17）
// ════════════════════════════════════════════════════════════════════════════

test('045 导航 — 四个一级 tab 页各自的汉堡都开得出抽屉（首页 = chat 抽屉，其余 = 全局抽屉，方案 C）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [makeAnchor({ id: '1', ticker: 'us:AOS' })]);
  await installIdeationMock(page);
  await installChatMock(page);
  await installPortfolioMock(page);
  await gotoHomeTab(page);

  // 首页：汉堡开 **chat 会话抽屉**（既有契约不动），灵感入口以同一组件落在里面。
  await page.getByTestId('chat-menu-button').tap();
  await expect(page.getByTestId('chat-drawer')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-drawer-ideation-entry')).toBeVisible();
  await expect(page.getByTestId('app-drawer')).toHaveCount(0); // 首页不开全局抽屉
  await closeDrawerByBackdrop(page, 'chat-drawer');

  // 期权台 / 投资 / 我的：汉堡开**全局抽屉**。
  for (const [tab, menuTestId] of [
    ['期权台', 'optionsdesk-menu-button'],
    ['投资', 'portfolio-menu-button'],
    ['我的', 'profile-menu-button'],
  ] as const) {
    await page.getByRole('tab', { name: tab }).tap();
    await expect(page.getByTestId(menuTestId)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(menuTestId).tap();
    await expect(page.getByTestId('app-drawer'), `${tab} 汉堡未开出全局抽屉`).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('app-drawer-ideation-entry')).toBeVisible();
    await closeDrawerByBackdrop(page, 'app-drawer');
  }
});

test('045 导航 — 二级页（锚管理）渲返回箭头且**不**渲汉堡；返回后一级页汉堡回来（FR-024）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [makeAnchor({ id: '1', ticker: 'us:AOS' })]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-menu-button')).toBeVisible();

  await page.getByTestId('optionsdesk-anchors-button').tap();
  await expect(page.getByTestId('optionsdesk-anchor-list')).toBeVisible({ timeout: 30_000 });
  // 二级页：navigator header 的返回箭头在，屏内汉堡**一个都不许有**。
  await expect(headerBackLocator(page)).toBeVisible();
  await expect(page.getByTestId('optionsdesk-menu-button')).toHaveCount(0);

  await headerBack(page);
  await expect(page.getByTestId('optionsdesk-menu-button')).toBeVisible({ timeout: 20_000 });
});

test('045 导航 — 灵感全屏子屏无悬空汉堡、无双返回、底部 Tab 栏隐藏（EC-17）', async ({ page }) => {
  await installIdeationMock(page);

  // 图片标注画布（全屏子屏之一）。uri 走内联 data:，不触网。
  const uri = encodeURIComponent(
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiBmaWxsPSIjY2NjIi8+PC9zdmc+',
  );
  await page.goto(`/ideation/image-annotate?uri=${uri}&index=0&sessionId=sess-045-1`);
  await expect(page.getByTestId('ideation-image-annotate')).toBeVisible({ timeout: 90_000 });

  // EC-17 —— 悬空汉堡的机械判据：全屏子屏上四个汉堡 testID 一个都不许出现。
  for (const id of [
    'chat-menu-button',
    'optionsdesk-menu-button',
    'portfolio-menu-button',
    'profile-menu-button',
  ]) {
    await expect(page.getByTestId(id), `${id} 悬空在全屏子屏`).toHaveCount(0);
  }
  // 全屏子屏隐藏底部 Tab 栏与中央 FAB（tabs layout 的 IDEATION_FULLSCREEN_ROUTES）。
  await expect(page.getByRole('tab', { name: '期权台' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '创建' })).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ④ markets ON 两态之一：tab 集合 + FAB 位置（SC-008）
// ════════════════════════════════════════════════════════════════════════════

test('045 底部栏 — markets ON：4 个 tab（首页/期权台/投资/我的）+ 灵感退位，FAB 仍居空槽正中（SC-008）', async ({
  page,
}) => {
  await installChatMock(page);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible({ timeout: 90_000 });

  // ON 态 tab 集合（FR-021：灵感退位给期权台，入口改由抽屉承载）。
  await expect(page.getByRole('tab', { name: '期权台' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '投资' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '灵感' })).toHaveCount(0);

  // FR-026 / SC-008：FAB 居**可见** tab 集合的空槽正中（ON 5 槽 → 50%）。公式按可见集合动态
  // 算，ON/OFF 两态都是 50% 是 tab 集合变更的连带结果，不是「可以拍成常量」的理由（plan D10）。
  const fab = page.getByRole('button', { name: '创建' });
  await expect(fab).toBeVisible();
  const fabBox = await fab.boundingBox();
  const viewport = page.viewportSize();
  if (!fabBox || !viewport) throw new Error('FAB / viewport 尺寸不可得');
  expect(Math.abs(fabBox.x + fabBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 锚表单三处人工位：标记 + 撤销（FR-032 ②③）
// ════════════════════════════════════════════════════════════════════════════

test('045 锚表单 — 三处人工位：置值即标「人工调整 · 将回落」+ 同屏派生值，撤销立即回落（FR-032）', async ({
  page,
}) => {
  const mock = await installOptionsdeskMock(page, [
    makeAnchor({
      id: '1',
      ticker: 'us:AOS',
      // L 层与单票上限**预置为人工态**（验「已是人工态」的呈现 + 撤销）；V 未置（验「置值」路径）。
      lLevelEffective: 'L1',
      lLevelIsManual: true,
      lLevelManual: 'L1',
      derivedLLevel: 'L2',
      positionCap: '0.1000',
      positionCapIsManual: true,
      positionCapManual: '0.1000',
      derivedPositionCap: '0.2500',
    }),
  ]);
  await gotoOptionsdesk(page);
  await page.getByTestId('optionsdesk-anchors-button').tap();
  await expect(page.getByTestId('optionsdesk-anchor-list')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('optionsdesk-anchor-row-us:AOS').tap();
  await expect(page.getByTestId('optionsdesk-anchor-form')).toBeVisible({ timeout: 30_000 });

  // 三处人工位都在（V / L 层 / 单票上限）。
  await expect(page.getByTestId('optionsdesk-manual-v')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-manual-lLevel')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-manual-positionCap')).toBeVisible();

  // 已处于人工态的两处：标记 + 「将回落为 <派生值>」提示 + 撤销入口同屏。
  await expect(page.getByTestId('optionsdesk-manual-badge-lLevel')).toContainText('将回落');
  await expect(page.getByTestId('optionsdesk-manual-hint-lLevel')).toContainText('L2');
  await expect(page.getByTestId('optionsdesk-manual-undo-lLevel')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-manual-badge-positionCap')).toBeVisible();
  // 未处于人工态的 V：只有「人工调整」入口，没有标记（系统不代为设置，FR-032 ①）。
  await expect(page.getByTestId('optionsdesk-manual-set-v')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-manual-badge-v')).toHaveCount(0);

  // ── 置值：V 人工调整 → 显式动作写入 → 同屏切人工态。
  await page.getByTestId('optionsdesk-manual-set-v').tap();
  await expect(page.getByTestId('optionsdesk-manual-editor-v')).toBeVisible();
  await page.getByTestId('optionsdesk-manual-input-v').fill('188.88');
  await page.getByTestId('optionsdesk-manual-confirm-v').tap();
  await expect(page.getByTestId('optionsdesk-manual-badge-v')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('optionsdesk-manual-hint-v')).toContainText('100.00'); // 回落目标 = 模型值
  expect(mock.lastPatchBody()).toMatchObject({ vManual: '188.88' });

  // ── 撤销：PATCH 必须发 `null`（不是空串 / 不是省略字段），且同屏立即回落。
  await page.getByTestId('optionsdesk-manual-undo-v').tap();
  await expect(page.getByTestId('optionsdesk-manual-set-v')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('optionsdesk-manual-badge-v')).toHaveCount(0);
  expect(mock.lastPatchBody()).toHaveProperty('vManual', null);

  // ── 撤销 L 层：回落到映射档（L2），标记随之消失。
  await page.getByTestId('optionsdesk-manual-undo-lLevel').tap();
  await expect(page.getByTestId('optionsdesk-manual-set-lLevel')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('optionsdesk-manual-badge-lLevel')).toHaveCount(0);
  expect(mock.lastPatchBody()).toHaveProperty('lLevelManual', null);
  expect(mock.patchCount()).toBe(3);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ 灵感四项能力零回归（SC-010）
// ════════════════════════════════════════════════════════════════════════════

test('045 灵感零回归 — 抽屉入口 → 列表 → 详情 → 中央 FAB 新建浮层全部照旧（SC-010）', async ({
  page,
}) => {
  await installIdeationMock(page);
  await installChatMock(page);
  await gotoHomeTab(page);

  // ① 入口：灵感不再占 tab 槽，改由抽屉菜单进 —— 从首页 chat 抽屉走一次（方案 C 的那一份）。
  await page.getByTestId('chat-menu-button').tap();
  await expect(page.getByTestId('chat-drawer')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('chat-drawer-ideation-entry').tap();

  // ② 列表：路由零回归（仍在 (tabs) 内嵌 stack，URL 仍是 /ideation）。
  await page.waitForURL(/\/ideation$/, { timeout: 30_000 });
  await expect(page.getByTestId('ideation-session-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ideation-session-row').first()).toBeVisible();

  // ③ 详情：列表 → 同 navigator push（已落 turns hydrate 回来）。
  await page.getByTestId('ideation-session-row').first().tap();
  await page.waitForURL(/\/ideation\/sess-045-1/, { timeout: 30_000 });
  await expect(page.getByTestId('ideation-turn-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ideation-turn-assistant').first()).toBeVisible();

  // ④ 中央 FAB 新建：回列表屏（详情是全屏子屏、FAB 按设计隐藏），FAB 在且开得出创建浮层。
  await headerBack(page);
  await expect(page.getByTestId('ideation-session-list')).toBeVisible({ timeout: 30_000 });
  const fab = page.getByRole('button', { name: '创建' });
  await expect(fab).toBeVisible();
  await fab.tap();
  await expect(page.getByRole('button', { name: 'PRD灵感' })).toBeVisible({ timeout: 15_000 });
});
