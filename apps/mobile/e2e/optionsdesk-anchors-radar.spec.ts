// GOLDEN SAMPLE — mobile hermetic e2e（网络边界全 mock + 稳定 testID + 断言对应 tasks 编号）。索引见 docs/conventions/golden-sample-registry.md，纪律见 .claude/rules/mobile-e2e-hermetic.md。
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

/**
 * 061 实时档夹具的采集时刻。**从设备本地墙钟反推 ISO**（`setHours` 后 `toISOString`）——
 * `formatAsOfLabel` 按本地时区渲 `HH:mm`，直接写死一个 UTC 串会让断言随跑测机器的时区漂移
 * （本机 +08、CI UTC）。这样两边都恒渲 `13:22`。
 */
const REALTIME_AT = (() => {
  const d = new Date();
  d.setHours(13, 22, 0, 0);
  return { iso: d.toISOString(), hm: '13:22' };
})();

/**
 * 061 收盘档夹具的 session 日 —— **固定的过去日期**，让断言逐字可写。
 * 用固定日不影响新鲜度：`quoteFreshnessTier` 由 **server** 判（要查交易日历，FR-020），
 * 客户端不拿本地日历日比对（那对美股恒判陈旧）。
 */
const EOD_DATE = '2026-08-14';

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

/**
 * 跌破 W（行情不可用的行**不计入**，与 server `belowW` 判据一致）。
 *
 * 🚨 **061 起闸看 `spotAsOf`**：server 的 `belowW` 筛选与空态计数都改吃**生效 spot**
 * （`get-radar.usecase.ts` 的 `COALESCE(CASE WHEN intraday_at >= $cutoff …, last_close)`），
 * 故镜像也必须跟着换 —— 否则「有实时价、当日收盘投影还没跑」的锚在 mock 里恒不计入
 * actionable，顶部横幅会说「今日无解」而底下那行赫然是红色负距 W%（正是 T019 订正的那类不一致）。
 */
function isBelowW(a: AnchorResponse): boolean {
  if (a.spotAsOf === null || a.distanceToWPct === null) return false;
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

/**
 * server 的空态**四分**（get-radar.usecase：globalBaseTotal → baseTotal → pageItems →
 * actionableTotal）。065 起第 2 位是「本市场零锚」—— 它与第 1 位的有效动作**相反**
 * （换个市场 vs 去建锚），文案 MUST NOT 复用。
 */
/** mock 的一页条数 —— 刻意小于真 server 的 20，好用少量 fixture 就翻得动页（065 T15-b）。 */
const RADAR_MOCK_PAGE = 3;

const EMPTY_STATE_MESSAGES = {
  zero_anchors: '还没有锚 —— 先去锚管理建第一个锚',
  zero_anchors_in_market: '这个市场还没有锚 —— 换个市场看看',
  filtered_empty: '当前筛选无结果',
  all_idle: '今日无解，空仓是常态',
} as const;

interface OptionsdeskMock {
  /**
   * 翻页途中改动行情（065 T15-b）——「排序键在两次取页之间变了」是 keyset 分页真正要扛住的
   * 场景，而 fixture 恒定的话那条断言永远无法失败。
   */
  setDistance: (id: string, distanceToWPct: string) => void;
  /**
   * 每次 `GET /radar` 的作用域与游标（065 T15-b）。
   *
   * 🚨 **分页断言走请求序列而不是「第一屏有几行」**：react-native-web 的 FlatList 在内容不
   * 满一屏时会立即反复触发 `onEndReached`，短列表**一次性翻到底** ⇒ 任何「第 1 页恰好 N 行」
   * 的断言都取决于视口高度，是环境相关的假信号。请求序列反映的是分页**契约本身**。
   */
  radarRequests: () => readonly { market: string | null; cursor: string | null }[];
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
  const radarCalls: { market: string | null; cursor: string | null }[] = [];

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
      // 🚨 065：`market` 是**作用域**（与 excluded 同级、进计数），不是筛选项。mock 必须真的
      //    按它切分，否则 e2e 全绿而 mock 已不再是契约镜像（`.claude/rules/mobile-e2e-hermetic`）。
      const market = url.searchParams.get('market');
      radarCalls.push({ market, cursor: url.searchParams.get('cursor') });

      const allBase = anchors.filter((a) => !a.excluded); // FR-005：雷达默认排除 excluded
      const base = allBase.filter((a) => market === null || a.ticker.startsWith(`${market}:`));
      const filtered = base.filter(
        (a) =>
          (lLevels.size === 0 || lLevels.has(a.lLevelEffective)) &&
          (!pendingReview || a.overdue) &&
          (!belowW || isBelowW(a)),
      );
      const actionable = filtered.filter(isBelowW);

      // 全市场计数 —— **不受本次作用域限制**（FR-016 小圆点要的正是别的市场那几格）。
      const marketCounts = [...new Set(allBase.map((a) => a.ticker.split(':')[0] ?? ''))].map(
        (m) => {
          const rows = allBase.filter((a) => a.ticker.startsWith(`${m}:`));
          return {
            market: m,
            baseTotal: rows.length,
            actionableTotal: rows.filter(isBelowW).length,
          };
        },
      );

      // 四分，判定序不可换：整库空优先于本市场空（此时「去建锚」才是对的动作）。
      const emptyState =
        allBase.length === 0
          ? 'zero_anchors'
          : base.length === 0
            ? 'zero_anchors_in_market'
            : filtered.length === 0
              ? 'filtered_empty'
              : actionable.length === 0
                ? 'all_idle'
                : null;

      // ── keyset 分页（065 T15-b）─────────────────────────────────────────
      // 🚨 **真 keyset 而不是 offset**：本组要验「翻页途中排序键变化 → 不漏行、不重复行」，
      //    而 offset 恰恰会漏会重 —— 用 offset 的 mock 会让那条断言变成永远无法失败的装饰。
      //    游标格式与 server 的 `encodeRadarCursor` 同形：base64(JSON [distanceToWPct, id])。
      const sorted = radarSort(filtered);
      const cursorParam = url.searchParams.get('cursor');
      const decoded = cursorParam
        ? (JSON.parse(Buffer.from(cursorParam, 'base64').toString('utf8')) as [
            string | null,
            string,
          ])
        : null;
      const distOf = (v: string | null): number =>
        v === null ? Number.POSITIVE_INFINITY : Number.parseFloat(v);
      const afterCursor = (a: AnchorResponse): boolean => {
        if (decoded === null) return true;
        const [cd, cid] = decoded;
        const ad = distOf(a.distanceToWPct);
        const cdn = distOf(cd);
        return ad > cdn || (ad === cdn && a.id > cid);
      };
      const remaining = sorted.filter(afterCursor);
      const pageItems = remaining.slice(0, RADAR_MOCK_PAGE);
      const hasMore = remaining.length > RADAR_MOCK_PAGE;
      const lastRow = pageItems.at(-1);
      const nextCursor =
        hasMore && lastRow !== undefined
          ? Buffer.from(JSON.stringify([lastRow.distanceToWPct, lastRow.id]), 'utf8').toString(
              'base64',
            )
          : null;

      return void (await json(200, {
        items: pageItems,
        nextCursor,
        hasMore,
        emptyState,
        emptyStateMessage: emptyState === null ? null : EMPTY_STATE_MESSAGES[emptyState],
        marketCounts,
      }));
    }

    // ── GET /optionsdesk/anchors（excluded 照常在列，Guardrail 12）───────────
    if (path.endsWith('/optionsdesk/anchors')) {
      if (method === 'GET') {
        const items = [...anchors].sort((x, y) => x.ticker.localeCompare(y.ticker));
        return void (await json(200, { items, total: items.length }));
      }
      // 065 T14③ 的正向那半条要一路建成锚 ⇒ mock 需要真的写侧（此前只有 GET / PATCH）。
      if (method === 'POST') {
        const body = (req.postDataJSON() as { ticker?: string } | null) ?? {};
        const created = makeAnchor({
          id: String(anchors.length + 1),
          ticker: body.ticker ?? 'us:NEW',
          distanceToWPct: '9.9',
        });
        anchors.push(created);
        return void (await json(201, created));
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

  return {
    radarRequests: () => radarCalls,
    setDistance: (id, distanceToWPct) => {
      const target = anchors.find((a) => a.id === id);
      if (target !== undefined) target.distanceToWPct = distanceToWPct;
    },
    patchCount: () => patchSeq,
    lastPatchBody: () => lastBody,
  };
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

/** `GET /marketdata/search` —— 只在需要走建锚选择器的用例里装（065 T14③）。 */
async function installSearchMock(
  page: Page,
  items: readonly { symbol: string; name: string }[],
): Promise<void> {
  await page.route('**/api/v1/marketdata/search**', async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify({ items: q ? items : [] }),
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 066 T13 — 港股无常驻说明（原 065 T14① 的反面）
// 065 T14 — 跨页签小圆点 / 选择器双向
// ════════════════════════════════════════════════════════════════════════════

// 🚨 **两条 test 缺一不可**：那条说明当初是**常驻**的（空态时也在），所以反过来也必须
//    **有锚 / 零锚**两态各验一遍 —— 只验有锚那态，会漏掉「空态下它又冒出来」。
// 🚨 **每态都断两个页签（双向）** —— 只断港股一侧的话，「说明整个渲染路径坏掉、两个页签
//    都没有」照样全绿。且每条 `toHaveCount(0)` 旁边都配一条**该市场真渲出来了**的正向锚
//    点（有锚 → 行可见 / 零锚 → 市场空态可见），否则页面压根没加载时零计数也成立。

test('066 T13 港股无常驻说明 — 有锚态：切过去行在、说明不在；美股侧同样不在（FR-020, US3-AS4）', async ({
  page,
}) => {
  const notice = page.getByTestId('optionsdesk-radar-market-notice');
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', distanceToWPct: '-4.5' }),
    makeAnchor({ id: '2', ticker: 'hk:00700', distanceToWPct: '8.0' }),
  ]);
  await gotoOptionsdesk(page);

  // 美股页签：不渲说明（对照侧，从来就没有）。
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveCount(0);

  // 切港股：**列表有行**，而说明**不在** —— 066 T10 把港股接进实时报价后它不再为真。
  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  await expect(page.getByTestId('optionsdesk-radar-row-hk:00700')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toHaveCount(0); // 作用域真生效
  await expect(notice).toHaveCount(0);
});

test('066 T13 港股无常驻说明 — 零锚态：市场空态在、说明仍不在（说明的消失不依赖有没有行）', async ({
  page,
}) => {
  const notice = page.getByTestId('optionsdesk-radar-market-notice');
  // 库里只有美股锚 ⇒ 港股页签落「本市场零锚」空态（第 4 态，见 065 T15(c)）。
  await installOptionsdeskMock(page, [makeAnchor({ id: '1', ticker: 'us:AOS' })]);
  await gotoOptionsdesk(page);

  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveCount(0);

  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  await expect(page.getByTestId('optionsdesk-radar-empty-market')).toBeVisible({ timeout: 20_000 });
  await expect(notice).toHaveCount(0);
});

test('065 T14② 跨页签小圆点 — 非当前页签有可动锚才出现，且**不含任何数字**（FR-016）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', distanceToWPct: '8.0' }), // 美股：不可动
    makeAnchor({ id: '2', ticker: 'hk:00700', distanceToWPct: '-3.0' }), // 港股：可动
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 30_000 });

  // 当前在美股：港股有可动 ⇒ 港股页签有点；当前页签自己**不渲**点（内容就在眼前）。
  await expect(page.getByTestId('optionsdesk-radar-market-dot-hk')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-radar-market-dot-us')).toHaveCount(0);
  // 🚫 不带数量 —— 页签上的数字会被读成「该市场有 N 只锚」而不是「N 只可动」。
  await expect(page.getByTestId('optionsdesk-radar-market-dot-hk')).toHaveText('');

  // 切到港股后：它成了当前页签 ⇒ 点消失；而美股无可动 ⇒ 美股也不该有点（反向那半条）。
  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  await expect(page.getByTestId('optionsdesk-radar-row-hk:00700')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('optionsdesk-radar-market-dot-hk')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-market-dot-us')).toHaveCount(0);
});

test('065 T14③ 选择器双向 — A 股可见但不可选 + 给出原因；us 仍可选并一路建成锚（US3-AS1/AS2）', async ({
  page,
}) => {
  // 🚨 **正向那半条不可省**：白名单收紧最常见的回归是 over-blocking，一旦误伤会让建锚整条
  //    路径不可用，而只测「A 股被挡住」照样全绿。
  // seed 一只无关的锚：锚列表空态不渲 `optionsdesk-anchor-list`（走空态视图），
  // 而本用例要从列表进建锚入口。
  await installOptionsdeskMock(page, [makeAnchor({ id: '1', ticker: 'us:PEP' })]);
  await installSearchMock(page, [
    { symbol: 'cn:600519', name: '贵州茅台' },
    { symbol: 'us:AOS', name: 'A.O. Smith' },
  ]);
  await gotoOptionsdesk(page);
  await page.getByTestId('optionsdesk-anchors-button').tap();
  await expect(page.getByTestId('optionsdesk-anchor-list')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('optionsdesk-anchor-create').tap();
  await expect(page.getByTestId('optionsdesk-anchor-form')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('optionsdesk-ticker-search-input').fill('60');

  // ── 反向：A 股**可见**（🚫 MUST NOT 静默过滤 —— 搜「茅台」返回空白会让人以为搜索坏了）
  //    且不可选、且原因就地同屏。
  const cnRow = page.getByTestId('optionsdesk-ticker-result-cn:600519');
  await expect(cnRow).toBeVisible({ timeout: 20_000 });
  // 🚨 用 `toBeDisabled()` 断，**不要**写成「tap 一下再看没反应」—— Playwright 对 disabled
  //    元素的 tap 会一直重试到用例超时（实测 120s），那是假红、不是真信号。
  await expect(cnRow).toBeDisabled();
  await expect(page.getByTestId('optionsdesk-ticker-unsupported-cn:600519')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-ticker-picked')).toHaveCount(0);

  // ── 正向：us 项仍可选，且能**一路建成锚** —— over-blocking 的真实症状正是这条路径断掉，
  //    而只断「A 股被挡住」的话它会照样全绿。
  await page.getByTestId('optionsdesk-ticker-result-us:AOS').tap();
  await expect(page.getByTestId('optionsdesk-ticker-picked')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('optionsdesk-field-v').fill('100');
  await page.getByTestId('optionsdesk-field-confidence').fill('8');
  await page.getByTestId('optionsdesk-field-method').fill('dcf');
  await page.getByTestId('optionsdesk-field-asof').fill('2026-06-30');
  await page.getByTestId('optionsdesk-anchor-save').tap();
  await expect(page.getByTestId('optionsdesk-anchor-row-us:AOS')).toBeVisible({ timeout: 20_000 });
});

// ════════════════════════════════════════════════════════════════════════════
// 065 T15 — 切换与默认 / 分页连续性 / 空态入口双向 / 行级粒度
// ════════════════════════════════════════════════════════════════════════════

/** 滚到列表尾触发 `onEndReached`（react-native-web 的 FlatList 是 ScrollView）。 */
async function loadMoreRadar(page: Page): Promise<void> {
  await page.getByTestId('optionsdesk-radar-more').scrollIntoViewIfNeeded();
}

/** 当前页上可见的雷达行 ticker（按 DOM 序 = 列表序）。 */
async function visibleRadarTickers(page: Page): Promise<string[]> {
  const ids = await page.locator('[data-testid^="optionsdesk-radar-row-"]').all();
  return Promise.all(
    ids.map(async (el) =>
      (await el.getAttribute('data-testid'))!.replace('optionsdesk-radar-row-', ''),
    ),
  );
}

test('065 T15(a) 切换与默认 — 冷启动落美股；点港股换的是**行**；二级页往返仍在港股', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', distanceToWPct: '-4.5' }),
    makeAnchor({ id: '2', ticker: 'hk:00700', distanceToWPct: '-2.0' }),
  ]);
  await gotoOptionsdesk(page);

  // US1-AS6 冷启动落美股：只看到美股那行。
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('optionsdesk-radar-row-hk:00700')).toHaveCount(0);

  // US1-AS1 点港股 —— 🚫 **不要**断言 `aria-selected`：`react-native-web` 不渲染它。
  //    判据是「**行**确实变了」，那是作用域真生效的唯一硬证据。
  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  await expect(page.getByTestId('optionsdesk-radar-row-hk:00700')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toHaveCount(0);

  // US1-AS5 二级页往返后仍在港股（会话内记忆）。
  await page.getByTestId('optionsdesk-anchors-button').tap();
  await expect(page.getByTestId('optionsdesk-anchor-list')).toBeVisible({ timeout: 30_000 });
  await headerBack(page);
  await expect(page.getByTestId('optionsdesk-radar-row-hk:00700')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toHaveCount(0);
});

test('065 T15(b) 分页连续性 — 续页带游标且仍属本市场 / 不漏不重 / 切页签回第一屏', async ({
  page,
}) => {
  // 🚨 **本组是 plan D6 撤销「market 编进游标」的代价对冲**：撤销的唯一依据是「第 2 页悄悄
  //    没应用作用域由 D1 挡住」，那就必须有真的翻页断言来证明 D1 确实挡住了 ——
  //    否则等于拆了栏杆又不验地板。
  // 🚨 判据取**请求序列**而非「第一屏有几行」：web 的 FlatList 在内容不满一屏时会立即反复
  //    触发 `onEndReached`，短列表一次性翻到底 ⇒ 行数断言取决于视口高度，是环境相关的假信号。
  const mock = await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', distanceToWPct: '-9.0' }),
    makeAnchor({ id: '2', ticker: 'us:PEP', distanceToWPct: '-7.0' }),
    makeAnchor({ id: '3', ticker: 'us:TAP', distanceToWPct: '-5.0' }),
    makeAnchor({ id: '4', ticker: 'us:CPB', distanceToWPct: '-3.0' }),
    makeAnchor({ id: '5', ticker: 'us:VICI', distanceToWPct: '-1.0' }),
    makeAnchor({ id: '6', ticker: 'hk:00700', distanceToWPct: '-8.0' }),
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-row-us:VICI')).toBeVisible({ timeout: 30_000 });

  // ① 翻完页后：5 只美股一只不少、无重复；港股那只**即使距 W% 更靠前也不在**（作用域先于排序）。
  const firstPass = await visibleRadarTickers(page);
  expect(new Set(firstPass).size).toBe(firstPass.length);
  expect([...firstPass].sort()).toEqual(['us:AOS', 'us:CPB', 'us:PEP', 'us:TAP', 'us:VICI']);

  // ② 请求序列：首请求无游标；至少有一次**带游标的续页**，且每一次都带 `market=us`。
  //    「续页没带作用域」正是 D1 要挡的那个洞 —— 它会让第 2 页混进港股行。
  const usCalls = mock.radarRequests();
  expect(usCalls[0]?.cursor).toBeNull();
  expect(usCalls.some((c) => c.cursor !== null)).toBe(true);
  expect(usCalls.every((c) => c.market === 'us')).toBe(true);

  // ③ 排序键变动后重新分页仍不漏不重（keyset 而非 offset；offset 会在键变动时漏行）。
  mock.setDistance('1', '99.0'); // 把原本排头的 us:AOS 推到最后
  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  await expect(page.getByTestId('optionsdesk-radar-row-hk:00700')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('optionsdesk-radar-market-tab-us').tap();
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 20_000 });
  const secondPass = await visibleRadarTickers(page);
  expect(new Set(secondPass).size).toBe(secondPass.length);
  expect([...secondPass].sort()).toEqual(['us:AOS', 'us:CPB', 'us:PEP', 'us:TAP', 'us:VICI']);

  // ④ 切页签后的第一次请求**不带游标** = 回第一屏（market 进 query key ⇒ pageParam 自然重置）。
  const hkFirst = mock.radarRequests().find((c) => c.market === 'hk');
  expect(hkFirst?.cursor).toBeNull();
});

test('065 T15(c) 空态入口双向 — 本市场零锚零入口；整库零锚建锚 CTA 必须在（SC-004）', async ({
  page,
}) => {
  // 🚨 **两个方向都要断**：SC-004「行动入口 100% 可执行」既禁止出现无从执行的入口，也要求
  //    该出现的入口确实在 —— 只断前者的话「什么入口都不给」会照样绿。
  await installOptionsdeskMock(page, [makeAnchor({ id: '1', ticker: 'us:AOS' })]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 30_000 });

  // 港股零锚而库中另有美股锚 → 第 4 态：市场文案在，**两个按钮计数均为 0**。
  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  const marketEmpty = page.getByTestId('optionsdesk-radar-empty-market');
  await expect(marketEmpty).toBeVisible({ timeout: 20_000 });
  await expect(marketEmpty).toContainText(EMPTY_STATE_MESSAGES.zero_anchors_in_market);
  // 这两条抓的正是 T13 的 fall-through：文案对了，却配一个什么都不做的「清除筛选」。
  await expect(page.getByTestId('optionsdesk-radar-create-anchor')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-clear-filter')).toHaveCount(0);
  // 与「整库还没有锚」的文案 MUST NOT 复用。
  await expect(marketEmpty).not.toContainText(EMPTY_STATE_MESSAGES.zero_anchors);
});

test('065 T15(c) 反向 — 整库零锚：仍落 zero_anchors 且建锚 CTA 出现（优先级不可换）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, []);
  await gotoOptionsdesk(page);

  const zero = page.getByTestId('optionsdesk-radar-empty-zero');
  await expect(zero).toBeVisible({ timeout: 30_000 });
  await expect(zero).toContainText(EMPTY_STATE_MESSAGES.zero_anchors);
  await expect(page.getByTestId('optionsdesk-radar-create-anchor')).toBeVisible();

  // 切到港股：整库仍是空的 ⇒ **仍落第 1 态**（此时「去建锚」才是对的动作）。
  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  await expect(page.getByTestId('optionsdesk-radar-empty-zero')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('optionsdesk-radar-empty-market')).toHaveCount(0);
});

test('065 T15(d) 行级粒度与筛选 — 港股行内时点是交易日；筛选跨页签保留', async ({ page }) => {
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', lLevelEffective: 'L2', distanceToWPct: '-4.0' }),
    makeAnchor({
      id: '2',
      ticker: 'hk:00700',
      lLevelEffective: 'L1',
      distanceToWPct: '-2.0',
      // 港股恒收盘档：`spotAsOf` 是交易日粒度（无时刻），priceKind 是收盘。
      spotAsOf: '2026-08-21',
      priceKind: 'eod_close',
    }),
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 30_000 });

  // 先在美股页签选一个筛选（L1 —— 美股这只是 L2 ⇒ 本页签筛完为空）。
  await page.getByTestId('optionsdesk-radar-filter-L1').tap();
  await expect(page.getByTestId('optionsdesk-radar-empty-filtered')).toBeVisible({
    timeout: 20_000,
  });

  // 切到港股：筛选**跨页签保留**（它是镜头，不是每页签独立的状态）⇒ L1 的港股那只仍在。
  await page.getByTestId('optionsdesk-radar-market-tab-hk').tap();
  const hkRow = page.getByTestId('optionsdesk-radar-row-hk:00700');
  await expect(hkRow).toBeVisible({ timeout: 20_000 });
  // 行内行情时点是**交易日**而非时刻（T11 只覆盖了顶部新鲜度聚合，覆盖不到行内）。
  await expect(hkRow).not.toContainText(/\d{2}:\d{2}/);
});

// ════════════════════════════════════════════════════════════════════════════
// 065 T12 — 雷达缓存失效链（**先于本 feature 存在的缺陷**）
// ════════════════════════════════════════════════════════════════════════════

test('065 T12 雷达失效链 — 改锚后返回雷达，行上的 L 层徽标随之更新（既存缺陷回归钉）', async ({
  page,
}) => {
  // 病根：`use-anchor-mutations` 失效的是 orval 生成的 key（`['/api/v1/optionsdesk/radar']`），
  // 而 `useRadar` 的 key 由 `radarQueryKey()` 铸造（前缀 `['optionsdesk','radar']`）——
  // 两者**无共同前缀**，而 react-query 的 invalidate 走前缀匹配 ⇒ 任何锚的增删改**从未失效过
  // 雷达**。叠加全局 `staleTime 30s` + 底部 Tab 常驻不 unmount（不触发 refetchOnMount）+
  // `refetchOnWindowFocus: false`，雷达一旦缓存就没有任何触发器重取，陈旧到 App 重启。
  //
  // 🚨 为什么断 L 层徽标而不是「新行出现」：mock 不支持 POST /anchors，而**改 L 层**同样穿过
  // 整条链（PATCH → onSuccess → invalidate → 雷达重取 → 行内徽标变），且 `applyAnchorPatch`
  // 会真的改 `lLevelEffective` ⇒ 差异在雷达行上直接可见。证明力相同，路径便宜得多。
  await installOptionsdeskMock(page, [
    makeAnchor({ id: '1', ticker: 'us:AOS', lLevelEffective: 'L2', derivedLLevel: 'L2' }),
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toContainText('L2');

  // 雷达 → 锚管理 → 表单：把 L 层人工位置成 L1（选项 tap 即 PATCH，无二次确认）。
  await page.getByTestId('optionsdesk-anchors-button').tap();
  await expect(page.getByTestId('optionsdesk-anchor-list')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('optionsdesk-anchor-row-us:AOS').tap();
  await expect(page.getByTestId('optionsdesk-anchor-form')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('optionsdesk-manual-set-lLevel').tap();
  await page.getByTestId('optionsdesk-manual-option-lLevel-L1').tap();
  await expect(page.getByTestId('optionsdesk-manual-badge-lLevel')).toBeVisible({
    timeout: 20_000,
  });

  // 返回雷达（两级：表单 → 锚列表 → 雷达）。走 header back —— `goBack` 在 Expo Web 会被
  // 重映射到 Stack 首屏。
  await headerBack(page);
  await expect(page.getByTestId('optionsdesk-anchor-list')).toBeVisible({ timeout: 20_000 });
  await headerBack(page);
  await expect(page.getByTestId('optionsdesk-menu-button')).toBeVisible({ timeout: 20_000 });

  // 失效链断裂时这里仍是 L2（雷达吃的是 30s 前的缓存）。
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toContainText('L1', {
    timeout: 20_000,
  });
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

// ════════════════════════════════════════════════════════════════════════════
// ⑦ 061 生效 spot 三态：实时档 / 收盘档 / 降级（T015，SC-003 / SC-007 / US2）
//
// 本层能验的**只有结构面**（spec `web_compat_notes` 已同步）：
//   · `asOf` 粒度即档位 —— 实时呈**时刻且无任何后缀**、收盘呈**交易日 + 「· 收盘」**；
//   · 行内的价 / 距 W% / 色带黑点吃**生效 spot**（不是 `lastClose`）；
//   · 距 W% 缺数呈「—」**而非 0**（0 是「正好在带上」的真值，拿它表达没数据 = 强信号误读）；
//   · 排序在两态下**各自**成立（同一批锚，实时档与收盘档的次序刻意造成相反）。
//
// 🚨 **档位不上屏（Guardrail 18 / FR-009）⇒ 本层没有档位标记可断言** —— 别去找不存在的徽标，
//    也别为了「有东西可断」给 UI 加标记。取而代之的机械判据是**两档的不对称**：收盘档带
//    「· 收盘」后缀、实时档**一个后缀都没有**，加上「行内任何文本不含 realtime / eod_close /
//    实时 字样」。
//
// ⚠️ 三类**验不到**的归 T018 真机，故意不在这里造夹具冒充：
//    ① 真实时段内的跳动（固定夹具看不到「距 W% 每 30 秒真的在动」）
//    ② 收盘当刻的切换时机（依赖真实市场状态翻转）
//    ③ 断源熔断到恢复的**真实链路**（夹具能摆出熔断后的样子，但与真源的行为一致性验不到 ——
//       下面那条降级测断的是「回落后屏幕上不许出现 0 / 空白」，不是熔断本身）。
// ════════════════════════════════════════════════════════════════════════════

/** 行在屏上的纵坐标（= 视觉次序）。用几何而非 DOM 次序，列表反向布局也骗不过它。 */
async function rowTop(page: Page, ticker: string): Promise<number> {
  const box = await page.getByTestId(`optionsdesk-radar-row-${ticker}`).boundingBox();
  if (!box) throw new Error(`${ticker} 行不可见`);
  return box.y;
}

test('061 雷达 — 实时档：asOf 呈时刻且不带任何后缀，行内三处数值吃生效 spot，排序按实时价成立', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [
    // 实时价 70 远低于昨收 95 ⇒ 按生效 spot 是跌破 W 的那只，按 lastClose 却是最贵的一只。
    makeAnchor({
      id: '1',
      ticker: 'us:AOS',
      lastClose: '95.00',
      lastCloseDate: TODAY,
      spot: '70.00',
      priceKind: 'realtime',
      spotAsOf: REALTIME_AT.iso,
      distanceToWPct: '-12.5',
      zone: 'deep_buy',
    }),
    makeAnchor({
      id: '2',
      ticker: 'us:PEP',
      lastClose: '76.00',
      lastCloseDate: TODAY,
      spot: '88.00',
      priceKind: 'realtime',
      spotAsOf: REALTIME_AT.iso,
      distanceToWPct: '10.0',
    }),
    // 盘中新建的锚：**已有实时价、当日收盘投影尚未跑过** ⇒ 可呈现闸必须看 `spotAsOf`。
    // 若闸还看 `lastCloseDate`，这一行会被判成「行情不可用」而它明明有价可看。
    makeAnchor({
      id: '3',
      ticker: 'us:TAP',
      lastClose: null,
      lastCloseDate: null,
      spot: '84.00',
      priceKind: 'realtime',
      spotAsOf: REALTIME_AT.iso,
      distanceToWPct: '5.0',
    }),
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-list')).toBeVisible({ timeout: 30_000 });

  // ① asOf 粒度即档位：呈**时刻**，且**一个后缀都没有**（加「· 实时」就是新视觉元素，Guardrail 18）。
  const bar = page.getByTestId('optionsdesk-radar-freshness-CURRENT');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(`数据截至 ${REALTIME_AT.hm}`);
  await expect(bar).not.toContainText('收盘');
  await expect(bar).not.toContainText('非当日');
  await expect(bar).not.toContainText('实时');

  // ② 行内价 = 生效 spot，**不是** lastClose（两者刻意取不同数，渲错哪个都当场看得出来）。
  const aos = page.getByTestId('optionsdesk-radar-row-us:AOS');
  await expect(aos).toContainText('S 70.00');
  await expect(aos).not.toContainText('95.00');
  const pep = page.getByTestId('optionsdesk-radar-row-us:PEP');
  await expect(pep).toContainText('S 88.00');
  await expect(pep).not.toContainText('76.00');

  // ③ 距 W% 与价同源（负号是 U+2212，与 mockup 一致）。
  await expect(aos).toContainText('距 W −12.5%');
  await expect(pep).toContainText('距 W +10.0%');

  // ④ 可呈现闸看 `spotAsOf`：无收盘投影的行照常出价、出距 W%，且**不挂**「行情不可用」。
  const tap = page.getByTestId('optionsdesk-radar-row-us:TAP');
  await expect(tap).toContainText('S 84.00');
  await expect(tap).toContainText('距 W +5.0%');
  await expect(tap.getByText('行情不可用')).toHaveCount(0);
  // 色带黑点同吃生效 spot ⇒ 有 spot 就有点（点停在昨收 / 缺席都是回归）。
  await expect(page.getByTestId('optionsdesk-radar-band-us:TAP-spot')).toBeVisible();

  // ⑤ 排序按实时价成立：AOS(−12.5) → TAP(+5.0) → PEP(+10.0)。
  //    按 lastClose 算会是 PEP(−5.0) → AOS(+18.75) → TAP(不可用排尾) —— 次序完全不同，
  //    故这条同时钉住「客户端不自己按昨收重排」。
  const [yAos, yTap, yPep] = [
    await rowTop(page, 'us:AOS'),
    await rowTop(page, 'us:TAP'),
    await rowTop(page, 'us:PEP'),
  ];
  expect(yAos).toBeLessThan(yTap);
  expect(yTap).toBeLessThan(yPep);

  // ⑥ Guardrail 18 的机械判据：档位只进接口，行内任何文本都不含它的名字。
  const list = page.getByTestId('optionsdesk-radar-list');
  await expect(list).not.toContainText('realtime');
  await expect(list).not.toContainText('eod_close');
  await expect(list).not.toContainText('实时');
});

test('061 雷达 — 收盘档：asOf 呈交易日 + 「· 收盘」后缀，同一批锚按收盘价重排（与实时档相反）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [
    // 与上一条同一批锚，只是全体落收盘档 ⇒ 生效 spot = lastClose，次序随之翻转。
    makeAnchor({
      id: '1',
      ticker: 'us:AOS',
      lastClose: '95.00',
      lastCloseDate: EOD_DATE,
      spot: '95.00',
      priceKind: 'eod_close',
      spotAsOf: EOD_DATE,
      distanceToWPct: '18.75',
    }),
    makeAnchor({
      id: '2',
      ticker: 'us:PEP',
      lastClose: '76.00',
      lastCloseDate: EOD_DATE,
      spot: '76.00',
      priceKind: 'eod_close',
      spotAsOf: EOD_DATE,
      distanceToWPct: '-5.0',
      zone: 'deep_buy',
    }),
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-list')).toBeVisible({ timeout: 30_000 });

  // ① 粒度回到**交易日**，且带「· 收盘」—— 与实时档那条的「无后缀」构成本片唯一的档位判据。
  const bar = page.getByTestId('optionsdesk-radar-freshness-CURRENT');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(`数据截至 ${EOD_DATE} · 收盘`);
  await expect(bar).not.toContainText(REALTIME_AT.hm);

  // ② 行内价 = 收盘价（此档下 lastClose 与生效 spot 同值，故只验数）。
  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toContainText('S 95.00');
  await expect(page.getByTestId('optionsdesk-radar-row-us:PEP')).toContainText('S 76.00');
  await expect(page.getByTestId('optionsdesk-radar-row-us:PEP')).toContainText('距 W −5.0%');

  // ③ 排序在本档同样成立，且**与实时档相反**（PEP 在前）。
  const [yPep, yAos] = [await rowTop(page, 'us:PEP'), await rowTop(page, 'us:AOS')];
  expect(yPep).toBeLessThan(yAos);

  // ④ 档位仍不上屏。
  const list = page.getByTestId('optionsdesk-radar-list');
  await expect(list).not.toContainText('eod_close');
  await expect(list).not.toContainText('实时');
});

test('061 雷达 — 降级回落收盘档：距 W% 仍是收盘价算出的数，0 个锚显示 0 或空白（SC-003 / SC-007）', async ({
  page,
}) => {
  // 熔断（或非交易时段 / 市场不支持实时）之后 server 给的样子：全体 eod_close，**实时价没被清空**
  // 但一律不再生效。屏幕上要求：每行都有价、都有距 W%，没有一行退化成「—」或「行情不可用」。
  await installOptionsdeskMock(page, [
    makeAnchor({
      id: '1',
      ticker: 'us:AOS',
      lastClose: '77.60',
      lastCloseDate: EOD_DATE,
      spot: '77.60',
      priceKind: 'eod_close',
      spotAsOf: EOD_DATE,
      distanceToWPct: '-3.0',
      zone: 'deep_buy',
    }),
    // 距 W% 恰好 0 —— **0 是一个有意义的距离值**（正好在带上）。它必须照常显示，
    // 才反衬出「缺数 ⇒ —」不是拿 0 兜的（FR-014）。
    makeAnchor({
      id: '2',
      ticker: 'us:PEP',
      lastClose: '80.00',
      lastCloseDate: EOD_DATE,
      spot: '80.00',
      priceKind: 'eod_close',
      spotAsOf: EOD_DATE,
      distanceToWPct: '0.0',
    }),
    makeAnchor({
      id: '3',
      ticker: 'us:TAP',
      lastClose: '86.00',
      lastCloseDate: EOD_DATE,
      spot: '86.00',
      priceKind: 'eod_close',
      spotAsOf: EOD_DATE,
      distanceToWPct: '7.5',
    }),
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-list')).toBeVisible({ timeout: 30_000 });

  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toContainText('距 W −3.0%');
  await expect(page.getByTestId('optionsdesk-radar-row-us:PEP')).toContainText('距 W 0.0%');
  await expect(page.getByTestId('optionsdesk-radar-row-us:TAP')).toContainText('距 W +7.5%');

  // 「无一刻显示 0 或空白」的机械判据：列表里既没有缺数占位「—」，也没有任何一行标行情不可用。
  const list = page.getByTestId('optionsdesk-radar-list');
  await expect(list).not.toContainText('距 W —');
  await expect(list).not.toContainText('行情不可用');
  // 三行的色带黑点都在（点也是「数值」，缺一个就是有行退化了）。
  for (const ticker of ['us:AOS', 'us:PEP', 'us:TAP']) {
    await expect(page.getByTestId(`optionsdesk-radar-band-${ticker}-spot`)).toBeVisible();
  }
  // 顶部条回到交易日粒度，且不是「行情不可用」那一档（降级 ≠ 没数据）。
  await expect(page.getByTestId('optionsdesk-radar-freshness-CURRENT')).toContainText(
    `数据截至 ${EOD_DATE} · 收盘`,
  );
  await expect(page.getByTestId('optionsdesk-radar-freshness-UNAVAILABLE')).toHaveCount(0);
});

test('061 雷达 — 两价皆无的锚：距 W% 呈「—」而非 0，且不被空值排到榜首（FR-014）', async ({
  page,
}) => {
  await installOptionsdeskMock(page, [
    makeAnchor({
      id: '1',
      ticker: 'us:AOS',
      lastClose: '95.00',
      lastCloseDate: TODAY,
      spot: '70.00',
      priceKind: 'realtime',
      spotAsOf: REALTIME_AT.iso,
      distanceToWPct: '-12.5',
      zone: 'deep_buy',
    }),
    makeAnchor({
      id: '2',
      ticker: 'us:PEP',
      lastClose: '76.00',
      lastCloseDate: EOD_DATE,
      spot: '76.00',
      priceKind: 'eod_close',
      spotAsOf: EOD_DATE,
      distanceToWPct: '-5.0',
    }),
    // 刚建成、还没经历过任何采集：两价皆无 ⇒ 三元组一起空。
    makeAnchor({
      id: '3',
      ticker: 'us:TAP',
      lastClose: null,
      lastCloseDate: null,
      spot: null,
      priceKind: 'eod_close',
      spotAsOf: null,
      zone: null,
      distanceToWPct: null,
    }),
  ]);
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-list')).toBeVisible({ timeout: 30_000 });

  // ① 缺数呈「—」，**禁 0**：0 会被读成「正好在带上」这个强信号。
  const tap = page.getByTestId('optionsdesk-radar-row-us:TAP');
  await expect(tap).toContainText('距 W —');
  await expect(tap).not.toContainText('0.0%');
  await expect(tap.getByText('行情不可用').first()).toBeVisible();
  await expect(page.getByTestId('optionsdesk-radar-band-us:TAP-spot')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-radar-band-us:TAP-spot-clamped')).toHaveCount(0);

  // ② 空值不占榜首（也不冒充「最该看的一只」）——真正跌破 W 的两行在它上面。
  const [yAos, yPep, yTap] = [
    await rowTop(page, 'us:AOS'),
    await rowTop(page, 'us:PEP'),
    await rowTop(page, 'us:TAP'),
  ];
  expect(yAos).toBeLessThan(yPep);
  expect(yPep).toBeLessThan(yTap);

  // ③ 混档同屏时顶部条跟**最新的那个时间事实**走（这里是实时档那行）⇒ 呈时刻、无后缀。
  const bar = page.getByTestId('optionsdesk-radar-freshness-CURRENT');
  await expect(bar).toContainText(`数据截至 ${REALTIME_AT.hm}`);
  await expect(bar).not.toContainText('收盘');
});
