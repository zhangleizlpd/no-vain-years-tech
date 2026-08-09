import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type {
  AnchorResponse,
  LegResponse,
  LegTableResponse,
  LegTableResponseLLevel,
  LegTableResponsePositionBucket,
  LegTableResponseRentDepth,
  LegTableResponseZone,
} from '@nvy/api-client';

import { mockJson } from './_support/api-mock';

// 047 T035 — 选约表（US2 / US3 / US4）hermetic UI e2e（Playwright Expo Web，Constitution §V
// 两层验证之一；样板 = `optionsdesk-detail-thermometer.spec.ts`）。
//
// 覆盖（逐条对应 tasks.md T035 的 ①~⑦ + FR-012 的运行时判据）：
//   ① **SC-012** —— 计数条分母 = 逻辑集合长度 · 可滚到最后一行 · 滚动区长度覆盖全部逻辑行 ·
//      全部腿行都在 DOM 里（US2-AS1「无静默截断」）
//   ② **US2-AS6** —— 横滑露出隐藏列 + 首列钉住 + **横滑后纵向滚动仍工作、纵滚后横向位移不变**
//      （= 手势零争用的**唯一**可验证判据：Guardrail 8 那个坑在 RN 只打 dev warning，
//        typecheck / lint / 单测 / CI 全绿，只有这条 e2e 能照出来）
//   ③ **四个状态帧** —— 陈旧 asOf（`STALE`）/ 链数据未就绪 / 零适格腿 / 不动区
//   ④ **US3-AS2** —— 未选水位时三个 Tab **全部可进入读表**（不置灰不隐藏）
//   ⑤ **US3-AS3** —— 水位选择被记住（重进仍在）且**可看出是人工输入**（读契约的来源标）
//   ⑥ **US4** —— 五种财报标同屏 + **同一到期日一致**（含死档行照常打标）+ 建仓腿「—」
//   ⑦ **SC-003** —— 抽任意一屏零处「无法判断这个数是哪天的」（含 **OI 列的独立 `oiAsOf`**，
//      与区块级 `asOf` 故意不同天）
//   ⑧ **FR-012 运行时判据** —— 点行 / 点动作标签**零导航、零状态变化、零请求**
//      （T034 已在源码面扫过「腿行组件树零 Pressable / 零 onPress / 零 role=button」，本条补运行时）
//
// ── 🚨 markets OFF 门控**不在本文件** ─────────────────────────────────────────
//   `playwright.markets-off.config.ts` 的 `testMatch` 锁死 `markets-feature-gate.spec.ts`
//   一个文件。选约区块的 OFF 断言由 T036 加在那边（`nx run mobile:e2e-public`）。
//   写在本文件里 = 在 markets-ON bundle 下跑，**永远验不到 OFF，且不会红**。
//
// ── ⚠️ Expo Web 下**验不到**的两件事（如实标注，不凑假断言）────────────────────
//   1. **真机手感 / 滚动流畅度** —— spec 已明标它故意不作验收门（主观计时）。本文件只验
//      「能滚到 / 滚得对」，不验「滚得顺」。
//   2. **大规模虚拟化窗口** —— `VirtualizedList` 默认 `windowSize=21`（≈ 21 屏 ≈ 369 行 @48px），
//      e2e 可承受的行数（本文件 60）**够不到**那条线 ⇒ web 上全部行都会被渲染出来。故 ①
//      在 web 下验的是「分母取逻辑集合长度 + 滚动区覆盖全部逻辑行 + 零截断」，
//      **「730 行只渲染视口那一窗」归真机验收**（T037/T039 勿把它当已验）。
//   3. **a11y 的 selected 语义** —— 组件按 RN 正道写了 `accessibilityState={{ selected }}`，
//      但 **react-native-web 0.21 整个不认这个 prop**（dist 内零处理）⇒ web DOM 上没有
//      `aria-selected`。选中态在本文件走「自比较的视觉态 + 功能面」两层断言（见 `textStyleOf`），
//      **读屏器读不读得出「已选中」归真机验收**。
//
// ── hermetic mock 纪律（per docs/conventions/mobile-impl-playbook.md §6）────────
//   mock 写**依赖方（server）契约**：持一份 canonical 状态（锚表 + 逐票选约表），handler 是
//   `(request, canonical 状态) → response` 的纯函数。水位写端点**真的改那份状态**（档位 + 来源标
//   + 时刻 + 重算意图），而不是按测试名分叉 —— 所以「重进详情仍记得」验的是持久化语义本身。
//   📌 唯一蓄意的简化：写水位后**不重算每腿的 `tabs` / `activityByTab`**（真 server 会按 Δ 档表
//      重筛）。成员判据是 server 的职责且已由 `leg-tab.rules.spec.ts` + IT 覆盖；本文件的断言面
//      是**呈现**，把那套档表在 e2e 侧再抄一份只会制造第二个漂移源。
//
// ── Expo web e2e 六坑（memory expo_web_e2e_and_router_footguns）────────────────
//   · `page.goBack()` 被嵌套 Stack 重映射 ⇒ 一律深链 `page.goto`，不驱 goBack。
//   · `(group)` 段在 URL 隐藏；tab / Tab 栏用 `role=tab`（config 已开 `hasTouch`）。
//   · 叠屏 DOM 双命中 ⇒ 一律 `getByTestId` 精确定位。
//   · `symbol` 是 canonical `market:code`，路径段里冒号转义（`us%3APEP`）。
//
// ── auth 范式 ────────────────────────────────────────────────────────────────
//   seed localStorage（含 accessToken）→ boot GET /me 必拦；**refresh-token 也必拦**，
//   否则任一 authed 401 触发 003 拦截器 retry-once 失败 → clearSession 误登出。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const BARS_RE = /\/api\/v1\/marketdata\/instruments\//;

const SEED_ACCOUNT_ID = 'acc-e2e-047';
const SEED_ACCESS_TOKEN = 'access-e2e-047';
const SEED_REFRESH_TOKEN = 'refresh-e2e-047';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139047';

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

/**
 * 🚨 **窄视口是本文件的前提，不是装饰**：12 列共 696px，其中右侧滚动区 608px。
 * Desktop Chrome 默认 1280px 下滚动区**根本不溢出** ⇒ 横滑压根发生不了，US2-AS6 会「绿得毫无
 * 意义」。390×844（iPhone 量级）才让隐藏列真的藏起来，也更贴近该屏的真实目标端。
 */
test.use({ viewport: { width: 390, height: 844 } });

// ════════════════════════════════════════════════════════════════════════════
// 日期口径（与 `~/format/as-of` 的 `todayYmd` 同口径）
// ════════════════════════════════════════════════════════════════════════════

function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const TODAY = ymd(new Date());

function ymdMinusDays(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const YESTERDAY = ymdMinusDays(TODAY, 1);
const LAST_WEEK = ymdMinusDays(TODAY, 7);

// ════════════════════════════════════════════════════════════════════════════
// 屏内文案（`optionsdesk-copy.ts` 逐字；改文案就该在这里红）
// ════════════════════════════════════════════════════════════════════════════

const COPY = {
  asOfUnavailable: '无数据时点',
  asOfStaleSuffix: ' · 非当日',
  rowTotal: (n: number) => `共 ${n} 行`,
  chainNotReady:
    '期权链数据未就绪 —— 该标的尚未被快照覆盖。采集在每个美股交易日收盘后跑一轮，下一轮覆盖到它就能读。',
  empty: '该 Tab 暂无适格腿 —— 面板照常可读',
  disclaimer: '触发 ≠ 开仓 —— 人工终决',
  noNewPositionWarning: '不开新仓 —— 该标的落在不动区或 L4。以下腿数据照常全量呈现，仅供查看。',
  sourceBackfillPrefix: '来源 ',
  bucketUnsetHint: '选一次水位档以定位意图',
  rentDepthUnionNote: '水位未选 → 展示全部 Δ 档（0.05–0.40Δ）',
  bucketManual: '人工输入',
  tabs: { all: '全腿', build: '建仓腿·周化', rent: '收租腿·年化' },
  intentPending: '意图 待定',
  intentRent: '意图 收租',
  intentNoNewPosition: '意图 不开新仓',
  earningsCovered: '覆盖 ✓',
  earningsBufferShort: (days: number) => `缓冲不足 +${days}d`,
  earningsCrosses: '跨财报 ⚠',
  earningsNoCross: '不跨',
  earningsNoDate: '无日期',
  actionPlaceOco: '挂 OCO',
  actionDead: '死档剔除',
  noValue: '—',
} as const;

/** 「数据截至 X · 收盘」—— 与 `~/format/as-of` 的 `formatAsOfLabel(asOf, 'eod_close')` 逐字同构。 */
function asOfLabel(asOf: string): string {
  return `数据截至 ${asOf} · 收盘`;
}

/** 腿行高（`leg-table-header.ts` 的 `LEG_ROW_HEIGHT`）—— SC-012 的滚动区长度换算基准。 */
const LEG_ROW_HEIGHT = 48;

// ════════════════════════════════════════════════════════════════════════════
// canonical 数据（= 服务端 DB 内容的镜像）
// ════════════════════════════════════════════════════════════════════════════

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
  quoteFreshnessTier: 'CURRENT',
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

/** 收租腿基线（年化口径 · 好档 · greeks 齐 · 财报覆盖）。 */
const LEG_BASE: Omit<LegResponse, 'code'> = {
  strike: '75.00',
  expiryDate: '2026-12-18',
  dteDays: 180,
  bid: '3.40',
  ask: '3.70',
  basis: 'annualized',
  periodRate: '0.047486',
  weeklyRate: '0.001846',
  annualizedRate: '0.096291',
  tier: 'good',
  askRate: null,
  effectiveCost: '71.60',
  effectiveCostVsWPct: '-10.50',
  absDelta: 0.22,
  sigmaDistance: 0.77,
  openInterest: 4210,
  volume: 63,
  turnover: '21420.00',
  activityByTab: { all: null, build: null, rent: null },
  tabs: ['all', 'rent'],
  earningsMark: { mark: 'covered', bufferShortfallDays: null, lastEarningsDate: '2026-10-28' },
  greeksComplete: true,
};

function makeLeg(over: Partial<LegResponse> & Pick<LegResponse, 'code'>): LegResponse {
  return { ...LEG_BASE, ...over };
}

/** 选约表基线 —— 当期快照、水位未选（⇒ 意图 `pending`，默认落位「全腿」）。 */
function makeLegTable(
  symbol: string,
  legs: LegResponse[],
  over: Partial<LegTableResponse> = {},
): LegTableResponse {
  return {
    symbol,
    state: 'available',
    asOf: TODAY,
    asOfFreshnessTier: 'CURRENT',
    quoteAsOf: `${TODAY}T20:15:00.000Z`,
    // 🚨 与 asOf 差一天 —— OI 列 MUST 用它（FR-013 / Guardrail 6 / SC-003）。
    oiAsOf: YESTERDAY,
    source: 'eod',
    spot: '82.40',
    w: '80.00',
    zone: 'buy',
    lLevel: 'L2',
    positionBucket: null,
    positionBucketSource: null,
    positionBucketSetAt: null,
    intent: 'pending',
    rentDepth: null,
    legs,
    ...over,
  };
}

/** SC-012 的大表：N 条同 Tab 腿，行权价逐档下移（code 唯一 ⇒ 行 testID 唯一）。O(n)。 */
function manyLegs(count: number): LegResponse[] {
  return Array.from({ length: count }, (_, i) =>
    makeLeg({
      code: `PEP261218P${String(60_000 + i * 500).padStart(6, '0')}`,
      strike: (60 + i * 0.5).toFixed(2),
      openInterest: 1000 + i,
      volume: 10 + i,
    }),
  );
}

// ── server 判定的镜像（照抄判据，不照抄结论）─────────────────────────────────

/** 水位档序（server `intent-matrix.rules.ts` 的 `POSITION_BUCKETS`，顺序 = 由低到高）。 */
const POSITION_BUCKETS = ['lt_one_third', 'one_to_two_thirds', 'gte_two_thirds'] as const;
const RENT_DEPTHS = ['near_atm', 'moderate', 'deep'] as const;
const DISCOUNT_STEPS_BY_ZONE: Readonly<Record<string, number | null>> = {
  deep_buy: 2,
  buy: 1,
  thin: 0,
  expensive: 0,
  overvalued: null,
};
const L_LEVEL_ORDINALS: Readonly<Record<string, number | null>> = { L1: 1, L2: 2, L3: 3, L4: null };
const BUILD_GRID_L_LEVELS: readonly string[] = ['L1', 'L2'];

/**
 * 意图矩阵 —— 逐字复算 server `classifyIntent`（跨 bounded context 拿不到那个函数）。
 * mock 若自己「拍一个意图」，水位写入后的 Tab 落位与警示注就全验不到了。复杂度 O(1)。
 */
function deriveIntent(
  zone: LegTableResponseZone,
  lLevel: LegTableResponseLLevel,
  bucket: LegTableResponsePositionBucket,
): { intent: LegTableResponse['intent']; rentDepth: LegTableResponseRentDepth } {
  const d = zone === null ? null : (DISCOUNT_STEPS_BY_ZONE[zone] ?? null);
  const l = L_LEVEL_ORDINALS[lLevel] ?? null;
  if (d === null || l === null) return { intent: 'no_new_position', rentDepth: null };
  if (bucket === null) return { intent: 'pending', rentDepth: null };

  const surplus = d - (l - 1);
  const bucketIndex = (POSITION_BUCKETS as readonly string[]).indexOf(bucket);
  if (surplus >= 1 && bucketIndex < surplus && BUILD_GRID_L_LEVELS.includes(lLevel)) {
    return { intent: 'build_position', rentDepth: null };
  }
  const depthIndex = Math.min(Math.max(bucketIndex - surplus, 0), RENT_DEPTHS.length - 1);
  return { intent: 'rent', rentDepth: RENT_DEPTHS[depthIndex] ?? 'near_atm' };
}

interface LegFixture {
  anchors: AnchorResponse[];
  /** 逐票选约表；缺键 = 该票有当期快照 + 一条基线腿。 */
  legs?: Record<string, LegTableResponse>;
}

interface LegMock {
  /** 打到期权台端点的请求（method + path），用于「点行零请求」一类的否定断言。 */
  deskCalls: () => string[];
}

/**
 * 期权台 + marketdata bars 的 hermetic mock —— 两个 route，一份 canonical 状态。
 *
 *  · `GET  /optionsdesk/underlyings/:sym`                —— 锚卡（无锚 404 带机器可读 code）
 *  · `GET  /optionsdesk/underlyings/:sym/legs`           —— 047 选约表（**与上一条是两条成败线**）
 *  · `POST /optionsdesk/anchors/:id/position-bucket`     —— 写水位：**真的改 canonical 状态**
 *  · `GET  /marketdata/instruments/:sym/bars`            —— 空序列（本文件不验 046 的折线区）
 *
 * 🚨 `…/legs` 分支 MUST 排在 `underlyings/(.+)$` 之前 —— 后者的贪婪 `(.+)` 会把 `/legs`
 *    整段吃成 symbol（T031 实撞过，症状是选约区块恒「未就绪」而锚卡正常）。
 */
async function installLegMock(page: Page, fixture: LegFixture): Promise<LegMock> {
  const anchors = fixture.anchors.map((a) => ({ ...a }));
  // canonical 选约表：预先物化，写端点直接改这一份（⇒ 重取自然读到新值）。
  const book = new Map<string, LegTableResponse>();
  for (const anchor of anchors) {
    const given = fixture.legs?.[anchor.ticker];
    book.set(
      anchor.ticker,
      given ? { ...given } : makeLegTable(anchor.ticker, [makeLeg({ code: 'PEP261218P75000' })]),
    );
  }
  const calls: string[] = [];

  await page.route(OPTIONSDESK_RE, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));

    const url = new URL(req.url());
    const path = url.pathname;
    calls.push(`${req.method()} ${path}`);
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
    const notFound = () =>
      json(404, { status: 404, code: 'ANCHOR_NOT_FOUND_FOR_SYMBOL', title: 'anchor not found' });

    // ── POST /optionsdesk/anchors/:id/position-bucket（FR-017 写端点）──────────
    const bucketMatch = /\/optionsdesk\/anchors\/([^/]+)\/position-bucket$/.exec(path);
    if (bucketMatch && req.method() === 'POST') {
      const anchor = anchors.find((a) => a.id === bucketMatch[1]);
      const table = anchor ? book.get(anchor.ticker) : undefined;
      if (!anchor || !table) return void (await notFound());
      const body = req.postDataJSON() as { positionBucket: LegTableResponsePositionBucket };
      // 🚨 档位 / 来源标 / 时刻**严格成对**落地（server 同不变量）——「人工输入」是契约事实，
      //    不是前端记忆。重选同一档也前进 setAt（记的是「人最后一次确认」）。
      table.positionBucket = body.positionBucket;
      table.positionBucketSource = body.positionBucket === null ? null : 'manual';
      table.positionBucketSetAt = new Date().toISOString();
      const verdict = deriveIntent(table.zone, table.lLevel, table.positionBucket);
      table.intent = verdict.intent;
      table.rentDepth = verdict.rentDepth;
      return void (await json(200, {
        anchorId: anchor.id,
        ticker: anchor.ticker,
        positionBucket: table.positionBucket,
        positionBucketSource: table.positionBucketSource,
        positionBucketSetAt: table.positionBucketSetAt,
      }));
    }

    // ── GET /optionsdesk/underlyings/:symbol/legs（MUST 在下面那条之前）────────
    const legsMatch = /\/optionsdesk\/underlyings\/(.+)\/legs$/.exec(path);
    if (legsMatch) {
      const table = book.get(decodeURIComponent(legsMatch[1] ?? ''));
      return void (table ? await json(200, table) : await notFound());
    }

    // ── GET /optionsdesk/underlyings/:symbol ────────────────────────────────
    const match = /\/optionsdesk\/underlyings\/(.+)$/.exec(path);
    if (match) {
      const symbol = decodeURIComponent(match[1] ?? '');
      const anchor = anchors.find((a) => a.ticker === symbol);
      if (!anchor) return void (await notFound());
      return void (await json(200, {
        symbol,
        anchor,
        iv: {
          state: 'missing',
          aggregateIv: null,
          ivPercentile: null,
          asOf: null,
          freshnessTier: 'UNAVAILABLE',
        },
      }));
    }

    await route.fallback();
  });

  // 折线区归 046 覆盖 —— 这里给空序列（区间带照常画，页面不报错，且列表头不至于过高）。
  await page.route(BARS_RE, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        symbol: decodeURIComponent(/\/instruments\/(.+)\/bars$/.exec(url.pathname)?.[1] ?? ''),
        adjust: 'forward',
        period: url.searchParams.get('period') ?? 'day',
        items: [],
        freshnessTier: 'UNAVAILABLE',
      }),
    });
  });

  return { deskCalls: () => calls };
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

test.setTimeout(180_000);

// ════════════════════════════════════════════════════════════════════════════
// 交互原语
// ════════════════════════════════════════════════════════════════════════════

/** 标的详情深链（`market:code` 的冒号在路径段里转义）。 */
function detailUrl(symbol: string): string {
  return `/optionsdesk/underlying/${encodeURIComponent(symbol)}`;
}

const SCROLL = 'optionsdesk-detail-scroll';
const HEADER_SCROLLER = 'optionsdesk-detail-leg-header-scroller';

const rowId = (code: string) => `optionsdesk-detail-leg-row-${code}`;
const rowScrollerId = (code: string) => `optionsdesk-detail-leg-scroller-${code}`;
const markId = (code: string) => `optionsdesk-detail-leg-mark-${code}`;
const actionId = (code: string) => `optionsdesk-detail-leg-action-${code}`;

/**
 * 取「自身或最近的可纵向滚动后代」的滚动量。
 * ⚠️ RNW 把 `testID` 落在 ScrollView 的可滚动节点上，但那是实现细节 —— 兜底往下找一层，
 *    免得实现换了以后这条断言变成「恒读 0 的假绿」。复杂度 O(子树节点数)。
 */
function verticalScroll(page: Page): Promise<{ top: number; height: number; client: number }> {
  return page.getByTestId(SCROLL).evaluate((root) => {
    const findScrollable = (node: Element): Element | null => {
      if (node.scrollHeight - node.clientHeight > 1) return node;
      for (const child of Array.from(node.children)) {
        const hit = findScrollable(child);
        if (hit !== null) return hit;
      }
      return null;
    };
    const el = findScrollable(root) ?? root;
    return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
  });
}

/** 同上，横向。`max` = 可滚动余量（0 ⇒ 该容器根本没溢出，横滑无从谈起）。 */
function horizontalScroll(locator: Locator): Promise<{ left: number; max: number }> {
  return locator.evaluate((root) => {
    const findScrollable = (node: Element): Element | null => {
      if (node.scrollWidth - node.clientWidth > 1) return node;
      for (const child of Array.from(node.children)) {
        const hit = findScrollable(child);
        if (hit !== null) return hit;
      }
      return null;
    };
    const el = findScrollable(root) ?? root;
    return { left: el.scrollLeft, max: el.scrollWidth - el.clientWidth };
  });
}

/**
 * 在目标元素中心发一次滚轮 —— **真手势**（浏览器自行决定由哪个容器消化，正是手势争用要验的）。
 * 元素不在视口内取不到 box ⇒ 显式抛错，不静默跳过。
 */
async function wheelOver(page: Page, target: Locator, dx: number, dy: number): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('目标不可见，取不到 boundingBox');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(dx, dy);
  await page.waitForTimeout(120);
}

/** 在列表区（视口中下部）连发滚轮直到条件成立。返回是否成立，由调用方断言。 */
async function wheelUntil(page: Page, ready: () => Promise<boolean>, steps = 30): Promise<boolean> {
  const vp = page.viewportSize();
  if (vp === null) throw new Error('viewport 尺寸不可得');
  for (let i = 0; i < steps; i++) {
    if (await ready()) return true;
    await page.mouse.move(vp.width / 2, vp.height * 0.7);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(120);
  }
  return ready();
}

/** 等选约区块出现（首发吃 Metro 冷打包 ⇒ 长超时锚在区块头）。 */
async function openDetail(page: Page, symbol: string): Promise<void> {
  await page.goto(detailUrl(symbol));
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible({ timeout: 90_000 });
}

/**
 * 🚨 **「谁被选中」在 web 上 MUST NOT 用 `aria-selected` 断言**（本文件实撞，别改回去）。
 *
 * Tab 与水位 chip 都按 RN 正道写了 `accessibilityState={{ selected }}`，而
 * **react-native-web 0.21 整个不认 `accessibilityState`** —— 其 `dist/` 里零处理，只留下已废弃的
 * `accessibilitySelected` 单属性 ⇒ web DOM 上**永远没有** `aria-selected`，拿它断言必红；
 * 更糟的是反向断言（`[aria-selected]` 计数为 0）会**恒真**，等于没断言。
 *
 * 故选中态走两层，都不依赖那条属性：
 *   ① **视觉态**（本函数）：选中项的字色 / 字重与未选项**不同**（自比较，不硬编码色值 ⇒
 *      调色板改了也不会假红）；
 *   ② **功能面**（各 test 内）：切 Tab 真的换了 `section.data`（计数条 + 行集合），
 *      这才是「进得去读得到表」的实质。
 * 📌 native 侧的 a11y selected 语义（TalkBack / VoiceOver 读出「已选中」）**web 验不到**，
 *    归真机验收。
 */
async function textStyleOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    const text = el.querySelector('div') ?? el;
    const s = getComputedStyle(text);
    return `${s.color}|${s.fontWeight}`;
  });
}

const TAB_KEYS = ['all', 'build', 'rent'] as const;

/** 选中的那个 Tab 与另外两个**视觉可分**（不置灰 ≠ 看不出选中）。 */
async function expectTabSelected(page: Page, selected: (typeof TAB_KEYS)[number]): Promise<void> {
  const styles = await Promise.all(
    TAB_KEYS.map((t) => textStyleOf(page.getByTestId(`optionsdesk-detail-leg-tab-${t}`))),
  );
  const target = styles[TAB_KEYS.indexOf(selected)];
  for (const [i, key] of TAB_KEYS.entries()) {
    if (key === selected) continue;
    expect(styles[i], `Tab ${key} 与选中的 ${selected} 呈现一致 —— 选中态看不出来`).not.toBe(
      target,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ① SC-012 —— 分母 = 逻辑集合长度 · 可滚到最后一行 · 滚动区覆盖全部逻辑行
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — SC-012：计数条分母 = 逻辑总行数、可滚到最后一行、滚动区长度覆盖全部逻辑行，零静默截断（US2-AS1）', async ({
  page,
}) => {
  const ROWS = 60;
  const legs = manyLegs(ROWS);
  const lastCode = legs[ROWS - 1]?.code ?? '';
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: { 'us:PEP': makeLegTable('us:PEP', legs) },
  });
  await openDetail(page, 'us:PEP');

  // 分母恒取**逻辑集合**长度（`section.data.length`），MUST NOT 取渲染窗口大小。
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(ROWS));

  // 可滚到最后一行 —— 「能滚到」是 SC-012 的另一半（分母对但滚不到 = 静默截断）。
  const lastRow = page.getByTestId(rowId(lastCode));
  expect(
    await wheelUntil(page, async () => (await lastRow.count()) > 0),
    `滚了 30 屏仍未出现最后一行 ${lastCode}`,
  ).toBe(true);
  await expect(lastRow).toBeVisible();

  // 零静默截断：全部逻辑行都在 DOM 里（US2-AS1 的机器判据）。
  await expect(page.locator('[data-testid^="optionsdesk-detail-leg-row-"]')).toHaveCount(ROWS);

  // 滚动区长度覆盖全部逻辑行 —— 「滚动条长度 = 逻辑总行数」的可读形态。
  const scroll = await verticalScroll(page);
  expect(
    scroll.height,
    `滚动区 ${scroll.height}px 短于 ${ROWS} 行 × ${LEG_ROW_HEIGHT}px`,
  ).toBeGreaterThanOrEqual(ROWS * LEG_ROW_HEIGHT);
  expect(scroll.height).toBeGreaterThan(scroll.client);

  // 滚到底以后分母不变（它读的是逻辑集合，不是「已渲染多少」）。
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(ROWS));
  // FR-011 页脚在列表**内**（随表滚动，非屏幕常驻）—— 滚到底该看得到它。
  await expect(page.getByTestId('optionsdesk-detail-leg-disclaimer')).toHaveText(COPY.disclaimer);
});

// ════════════════════════════════════════════════════════════════════════════
// ② US2-AS6 —— 横滑露列 + 首列钉住 + 纵向滚动仍工作（手势零争用）
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — US2-AS6：横滑露出隐藏列且首列钉住，表头与行同步；**纵向滚动仍在详情页内正常工作**（手势零争用）', async ({
  page,
}) => {
  const legs = manyLegs(24);
  const code = legs[0]?.code ?? '';
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: { 'us:PEP': makeLegTable('us:PEP', legs) },
  });
  await openDetail(page, 'us:PEP');

  const row = page.getByTestId(rowId(code));
  const rowScroller = page.getByTestId(rowScrollerId(code));
  const headerScroller = page.getByTestId(HEADER_SCROLLER);
  const stickyBadge = page.getByTestId(`optionsdesk-detail-leg-basis-${code}`);
  const actionCell = page.getByTestId(actionId(code));

  // 把首行滚进视口（滚轮必须落在真实元素上）。
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();

  // 前提自检：窄视口下右侧列区**真的溢出**了 —— 不溢出的话下面全套断言毫无意义。
  const before = await horizontalScroll(rowScroller);
  expect(before.max, '右侧列区未溢出：视口太宽，横滑验不到').toBeGreaterThan(0);
  expect(before.left).toBe(0);

  // 「动作」列初始在可视区之外（= 确有隐藏列）。
  const scrollerBox = await rowScroller.boundingBox();
  const hiddenBox = await actionCell.boundingBox();
  if (scrollerBox === null || hiddenBox === null) throw new Error('列区 / 动作列尺寸不可得');
  expect(hiddenBox.x, '「动作」列初始就露着，隐藏列前提不成立').toBeGreaterThan(
    scrollerBox.x + scrollerBox.width,
  );

  const stickyBefore = await stickyBadge.boundingBox();
  const verticalBefore = await verticalScroll(page);

  // ── 横滑（真滚轮，deltaX）──────────────────────────────────────────────
  await wheelOver(page, rowScroller, 400, 0);
  await expect
    .poll(async () => (await horizontalScroll(rowScroller)).left, { timeout: 5_000 })
    .toBeGreaterThan(0);

  const afterX = await horizontalScroll(rowScroller);
  const headerX = await horizontalScroll(headerScroller);
  // 表头与数据行共享同一个 offset ⇒ 位移必须同步（差半像素内）。
  expect(Math.abs(headerX.left - afterX.left), '表头与数据行横向位移不同步').toBeLessThanOrEqual(1);

  // 隐藏列露出来了。
  const revealed = await actionCell.boundingBox();
  if (revealed === null) throw new Error('动作列尺寸不可得');
  expect(revealed.x, '横滑后「动作」列仍在可视区之外').toBeLessThan(
    scrollerBox.x + scrollerBox.width,
  );
  await expect(actionCell).toHaveText(COPY.actionPlaceOco);

  // 首列钉住 —— 它渲在横滑之外，横向位移**一像素都不该动**。
  const stickyAfter = await stickyBadge.boundingBox();
  if (stickyBefore === null || stickyAfter === null) throw new Error('首列尺寸不可得');
  expect(
    Math.abs(stickyAfter.x - stickyBefore.x),
    '首列跟着横滑跑了（没钉住）',
  ).toBeLessThanOrEqual(1);

  // ── 🚨 手势零争用：在**同一个点**（行的横滑容器上）发纵向滚轮 ────────────
  //    Guardrail 8 那个坑（SectionList 塞回同向 ScrollView）在 RN 只打 dev warning，
  //    typecheck / lint / 单测 / CI 全绿 —— 只有这条断言能照出来。
  await wheelOver(page, rowScroller, 0, 600);
  await expect
    .poll(async () => (await verticalScroll(page)).top, { timeout: 5_000 })
    .toBeGreaterThan(verticalBefore.top);

  // 方向正交：纵滚不该把横向位移带跑。
  const afterVertical = await horizontalScroll(rowScroller);
  expect(
    Math.abs(afterVertical.left - afterX.left),
    '纵向滚动把横向位移带跑了（两个方向在抢同一个响应者）',
  ).toBeLessThanOrEqual(1);
});

// ════════════════════════════════════════════════════════════════════════════
// ③ SC-003 —— 每处读数带可见时点（含 OI 列的独立 oiAsOf）
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — SC-003：区块 asOf + **OI 列独立归属日**（与区块 asOf 不同天）+ 非 eod 来源标，零处「不知道这是哪天的数」', async ({
  page,
}) => {
  const code = 'PEP261218P75000';
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: {
      'us:PEP': makeLegTable('us:PEP', [makeLeg({ code })], {
        asOf: TODAY,
        oiAsOf: YESTERDAY,
        // 非 eod ⇒ 「一直靠盘前兜底续命」这件事要看得见（契约给的事实）。
        source: 'premarket_backfill',
      }),
    },
  });
  await openDetail(page, 'us:PEP');

  // ① 区块级 asOf：完整日期 + 收盘口径，且**不是**「无数据时点」。
  const asOf = page.getByTestId('optionsdesk-detail-leg-asof');
  await expect(asOf).toHaveText(asOfLabel(TODAY));
  await expect(asOf).not.toHaveText(COPY.asOfUnavailable);

  // ② OI 列的**独立**归属日挂在列头上（挂区块头会把 T−1 说成当日）。
  const oiSub = `截至 ${YESTERDAY.slice(5)}`;
  expect(oiSub, 'fixture 没把 oiAsOf 与 asOf 拉开，这条断言会退化').not.toBe(
    `截至 ${TODAY.slice(5)}`,
  );
  await expect(page.getByTestId(HEADER_SCROLLER).getByText(oiSub)).toBeVisible();

  // ③ 来源标（非 eod 才出）。
  await expect(page.getByTestId('optionsdesk-detail-leg-source')).toHaveText(
    `${COPY.sourceBackfillPrefix}premarket_backfill`,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ④ 状态帧 1/4 —— 陈旧 asOf（STALE）：醒目标注 + **全表照常渲染**
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — 陈旧帧：`STALE` ⇒ asOf 带「· 非当日」且转醒目态，**腿数据照常全量**（陈旧 ≠ 减配）', async ({
  page,
}) => {
  const legs = manyLegs(6);
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' }), makeAnchor({ id: '2', ticker: 'us:PEP' })],
    legs: {
      // 对照组：同一份腿、当期档。
      'us:AOS': makeLegTable('us:AOS', legs),
      // 🚨 档位由 **server** 下发（客户端拿设备本地日期自判对美股恒为真 ⇒ 等于没有告警）。
      'us:PEP': makeLegTable('us:PEP', legs, { asOf: LAST_WEEK, asOfFreshnessTier: 'STALE' }),
    },
  });

  // ── 对照组：当期档，无后缀 ────────────────────────────────────────────
  await openDetail(page, 'us:AOS');
  const currentAsOf = page.getByTestId('optionsdesk-detail-leg-asof');
  await expect(currentAsOf).toHaveText(asOfLabel(TODAY));
  const currentStyle = await currentAsOf.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, weight: s.fontWeight };
  });

  // ── 陈旧档 ────────────────────────────────────────────────────────────
  await openDetail(page, 'us:PEP');
  const staleAsOf = page.getByTestId('optionsdesk-detail-leg-asof');
  await expect(staleAsOf).toHaveText(`${asOfLabel(LAST_WEEK)}${COPY.asOfStaleSuffix}`);

  // 醒目态：加重字重 + 与常态**不同色**（配色值不硬编码，比的是两档确实分得开）。
  const staleStyle = await staleAsOf.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, weight: s.fontWeight };
  });
  expect(Number(staleStyle.weight), '陈旧档没加重字重').toBeGreaterThanOrEqual(600);
  expect(Number(staleStyle.weight)).toBeGreaterThan(Number(currentStyle.weight));
  expect(staleStyle.color, '陈旧档与常态同色 —— 两档分不开').not.toBe(currentStyle.color);

  // 🚨 陈旧 ≠ 减配：表格照常渲全量腿，计数条分母不变，降级态一个都不该出。
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(6));
  await expect(page.getByTestId('optionsdesk-detail-leg-table-header')).toBeVisible();
  await expect(page.locator('[data-testid^="optionsdesk-detail-leg-row-"]')).toHaveCount(6);
  await expect(page.getByTestId('optionsdesk-detail-leg-empty')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-chain_not_ready')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-read_failed')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 状态帧 2+3/4 —— 链数据未就绪 / 零适格腿（两者 MUST NOT 合并；面板都不隐藏）
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — 未就绪 vs 零适格腿：两帧文案不同、都不是空白页/错误页，且面板照常可读（US3-AS4 / FR-021）', async ({
  page,
}) => {
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' }), makeAnchor({ id: '2', ticker: 'us:PEP' })],
    legs: {
      // 采集还没轮到 —— 是**事实**，不是故障。
      'us:AOS': makeLegTable('us:AOS', [], {
        state: 'chain_not_ready',
        asOf: null,
        asOfFreshnessTier: 'UNAVAILABLE',
        quoteAsOf: null,
        oiAsOf: null,
        source: null,
      }),
      // 有当期快照，但这只票一条适格腿都没有 —— `available` + 空集合，**不是第五态**。
      'us:PEP': makeLegTable('us:PEP', []),
    },
  });

  // ── 未就绪：说明「何时会有」，且**不是**红标错误体系 ─────────────────
  await openDetail(page, 'us:AOS');
  await expect(page.getByTestId('optionsdesk-detail-leg-chain_not_ready')).toHaveText(
    COPY.chainNotReady,
  );
  await expect(page.getByTestId('optionsdesk-detail-leg-empty')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-read_failed')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-retry')).toHaveCount(0);
  // 无快照 ⇒ 显式「无数据时点」，**绝不渲染「数据截至 null」**。
  await expect(page.getByTestId('optionsdesk-detail-leg-asof')).toHaveText(COPY.asOfUnavailable);
  // 面板照常在：Tab 栏 / 表头 / 页脚一个都不少。
  await expect(page.getByTestId('optionsdesk-detail-leg-tabs')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-table-header')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(0));

  // ── 零适格腿：另一句文案，三个 Tab 全部可进入（US3-AS4）────────────────
  await openDetail(page, 'us:PEP');
  await expect(page.getByTestId('optionsdesk-detail-leg-empty')).toHaveText(COPY.empty);
  await expect(page.getByTestId('optionsdesk-detail-leg-chain_not_ready')).toHaveCount(0);
  for (const tab of TAB_KEYS) {
    const trigger = page.getByTestId(`optionsdesk-detail-leg-tab-${tab}`);
    await expect(trigger, `${COPY.tabs[tab]} Tab 被禁用了`).toBeEnabled();
    await trigger.tap();
    await expectTabSelected(page, tab);
    // 空 Tab 是**空态不是禁用态**：面板不隐藏、不折叠、不置灰。
    await expect(page.getByTestId('optionsdesk-detail-leg-empty')).toBeVisible();
    await expect(page.getByTestId('optionsdesk-detail-leg-table-header')).toBeVisible();
    await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(0));
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ 状态帧 4/4 —— 不动区：警示注置顶 + 腿数据照常全量
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — 不动区帧（FR-021）：警示注**置顶**于区块头之上，腿数据照常全量、表不折叠不置灰', async ({
  page,
}) => {
  const legs = manyLegs(6);
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP', zone: 'overvalued' })],
    legs: {
      'us:PEP': makeLegTable('us:PEP', legs, {
        zone: 'overvalued',
        intent: 'no_new_position',
        // 不动区**不以水位为条件**（server 判定序第 1 条是「⟺」）—— 选了档也照样不开新仓。
        positionBucket: 'one_to_two_thirds',
        positionBucketSource: 'manual',
        positionBucketSetAt: `${TODAY}T02:15:00.000Z`,
      }),
    },
  });
  await openDetail(page, 'us:PEP');

  const warning = page.getByTestId('optionsdesk-detail-leg-no-new-position');
  await expect(warning).toHaveText(COPY.noNewPositionWarning);
  await expect(page.getByTestId('optionsdesk-detail-leg-intent')).toHaveText(
    COPY.intentNoNewPosition,
  );

  // **置顶** = 排在区块头 / 意图条 / Tab 栏之上（不是塞在表格底下的一句小字）。
  const warnBox = await warning.boundingBox();
  const headerBox = await page.getByTestId('optionsdesk-detail-leg-header').boundingBox();
  const tabsBox = await page.getByTestId('optionsdesk-detail-leg-tabs').boundingBox();
  if (warnBox === null || headerBox === null || tabsBox === null)
    throw new Error('警示注 / 区块头 / Tab 栏尺寸不可得');
  expect(warnBox.y, '警示注没有置顶（跑到区块头下面去了）').toBeLessThan(headerBox.y);
  expect(warnBox.y).toBeLessThan(tabsBox.y);

  // 🚫 MUST NOT 借机隐藏 / 折叠 / 置灰表格 —— 「不开新仓」是结论不是屏蔽理由。
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(6));
  await expect(page.locator('[data-testid^="optionsdesk-detail-leg-row-"]')).toHaveCount(6);
  await expect(page.getByTestId('optionsdesk-detail-leg-table-header')).toBeVisible();
  // 落位「全腿」（不动区没有一个「该去的意图 Tab」）——「全腿」的 6 行就是它的功能面证据。
  await expectTabSelected(page, 'all');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ US3-AS2 —— 未选水位：三 Tab 全部可进入读表 + 两条就地注明
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — US3-AS2：未选水位时三个 Tab **全部可进入读表**（不置灰不隐藏），并就地注明未选与 Δ 档并集', async ({
  page,
}) => {
  const rentCode = 'PEP261218P75000';
  const buildCode = 'PEP260814P80000';
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: {
      'us:PEP': makeLegTable('us:PEP', [
        makeLeg({ code: rentCode, tabs: ['all', 'rent'] }),
        makeLeg({
          code: buildCode,
          strike: '80.00',
          expiryDate: '2026-08-14',
          basis: 'weekly',
          tier: 'acceptable',
          tabs: ['all', 'build'],
          earningsMark: null,
        }),
      ]),
    },
  });
  await openDetail(page, 'us:PEP');

  // 水位未选 ⇒ 意图「待定」（**MUST NOT 静默取一档**）+ 显式提示。
  await expect(page.getByTestId('optionsdesk-detail-leg-intent')).toHaveText(COPY.intentPending);
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-bucket_unset')).toHaveText(
    COPY.bucketUnsetHint,
  );
  await expect(page.getByTestId('optionsdesk-detail-position-bucket-manual')).toHaveCount(0);

  // 全腿：两条都在，且每行标腿族口径徽标（FR-019 混排）。
  await expect(page.getByTestId(rowId(rentCode))).toBeVisible();
  await expect(page.getByTestId(rowId(buildCode))).toBeVisible();
  await expect(page.getByTestId(`optionsdesk-detail-leg-basis-${rentCode}`)).toHaveText('年');
  await expect(page.getByTestId(`optionsdesk-detail-leg-basis-${buildCode}`)).toHaveText('周');

  // 三个 Tab 一个都不置灰（不置灰 ≠ 有内容，两件事各断各的）。
  for (const tab of TAB_KEYS) {
    await expect(
      page.getByTestId(`optionsdesk-detail-leg-tab-${tab}`),
      `${COPY.tabs[tab]} Tab 被禁用了`,
    ).toBeEnabled();
  }

  // 建仓腿 Tab：可进入且读得到表。
  await page.getByTestId('optionsdesk-detail-leg-tab-build').tap();
  await expectTabSelected(page, 'build');
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(1));
  await expect(page.getByTestId(rowId(buildCode))).toBeVisible();
  await expect(page.getByTestId(rowId(rentCode))).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-bucket_unset')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-rent_depth_union')).toHaveCount(0);

  // 收租腿 Tab：可进入 + **额外**注明 Δ 档取并集（未选水位不静默取一档）。
  await page.getByTestId('optionsdesk-detail-leg-tab-rent').tap();
  await expectTabSelected(page, 'rent');
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(1));
  await expect(page.getByTestId(rowId(rentCode))).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-rent_depth_union')).toHaveText(
    COPY.rentDepthUnionNote,
  );

  // 回到全腿：两条又都在（切 Tab 只换 `section.data`，不重建列表）。
  await page.getByTestId('optionsdesk-detail-leg-tab-all').tap();
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(2));
});

// ════════════════════════════════════════════════════════════════════════════
// ⑧ US3-AS3 —— 水位选择被记住 + 可看出是人工输入
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — US3-AS3：选水位 ⇒ 落「人工输入」角标 + 意图随矩阵改判并落位对应 Tab，**重进详情仍记得**', async ({
  page,
}) => {
  const rentCode = 'PEP261218P75000';
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: { 'us:PEP': makeLegTable('us:PEP', [makeLeg({ code: rentCode })]) },
  });
  await openDetail(page, 'us:PEP');

  await expect(page.getByTestId('optionsdesk-detail-leg-intent')).toHaveText(COPY.intentPending);
  await expect(page.getByTestId('optionsdesk-detail-position-bucket-manual')).toHaveCount(0);

  await page.getByTestId('optionsdesk-detail-position-bucket-lt_one_third').tap();

  // 「人工输入」由**契约的来源标**表达（不是前端记得刚才点过）。
  await expect(page.getByTestId('optionsdesk-detail-position-bucket-manual')).toHaveText(
    COPY.bucketManual,
  );
  await expect(page.getByTestId('optionsdesk-detail-position-bucket-error')).toHaveCount(0);

  // 意图随矩阵改判（买区 + L2 + <1/3 ⇒ 收租）—— 写成功必失效选约表，否则这里读到旧表。
  await expect(page.getByTestId('optionsdesk-detail-leg-intent')).toHaveText(COPY.intentRent);
  // US3-AS1：Tab 让位给矩阵输出的那个（人没手点过 Tab）—— 选完水位屏幕上确实动了。
  await expectTabSelected(page, 'rent');
  // 未选时的两条提示随之消失。
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-bucket_unset')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-rent_depth_union')).toHaveCount(0);

  // 🚨 「被记住」= 服务端落地，重新进这一屏仍在（不是组件里的一个 useState）。
  await openDetail(page, 'us:PEP');
  await expect(page.getByTestId('optionsdesk-detail-position-bucket-manual')).toHaveText(
    COPY.bucketManual,
  );
  await expect(page.getByTestId('optionsdesk-detail-leg-intent')).toHaveText(COPY.intentRent);
  // 选中的那个 chip 与另外两个视觉可分（同上：`aria-selected` 在 RNW 0.21 下不存在）。
  const pickedChip = await textStyleOf(
    page.getByTestId('optionsdesk-detail-position-bucket-lt_one_third'),
  );
  for (const bucket of ['one_to_two_thirds', 'gte_two_thirds']) {
    expect(
      await textStyleOf(page.getByTestId(`optionsdesk-detail-position-bucket-${bucket}`)),
      '重进后水位 chip 未回到选中态（与未选档呈现一致）',
    ).not.toBe(pickedChip);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ⑨ US4 —— 五种财报标同屏 + 同一到期日一致 + 死档行照常打标
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — US4：五种财报标同屏可辨（「无日期」虚线 chip vs「不跨」纯文字），**同一到期日一致**，死档行照常打标、建仓腿「—」', async ({
  page,
}) => {
  const E1 = '2026-12-18';
  const covered = 'PEP261218P75000';
  const coveredTwin = 'PEP261218P70000';
  const deadSameExpiry = 'PEP261218P50000';
  const bufferShort = 'PEP261120P75000';
  const crosses = 'PEP261016P75000';
  const noCross = 'PEP260918P75000';
  const noDate = 'PEP260821P75000';
  const buildLeg = 'PEP260814P80000';

  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: {
      'us:PEP': makeLegTable('us:PEP', [
        makeLeg({ code: covered, expiryDate: E1 }),
        // 同一到期日 ⇒ 财报关系相同（标是按到期日算的，不是按行算的）。
        makeLeg({ code: coveredTwin, strike: '70.00', expiryDate: E1 }),
        makeLeg({
          code: bufferShort,
          expiryDate: '2026-11-20',
          earningsMark: {
            mark: 'buffer_short',
            bufferShortfallDays: 3,
            lastEarningsDate: '2026-10-28',
          },
        }),
        makeLeg({
          code: crosses,
          expiryDate: '2026-10-16',
          earningsMark: {
            mark: 'crosses_earnings',
            bufferShortfallDays: null,
            lastEarningsDate: '2026-10-28',
          },
        }),
        makeLeg({
          code: noCross,
          expiryDate: '2026-09-18',
          earningsMark: {
            mark: 'no_cross',
            bufferShortfallDays: null,
            lastEarningsDate: '2026-10-28',
          },
        }),
        makeLeg({
          code: noDate,
          expiryDate: '2026-08-21',
          earningsMark: { mark: 'no_date', bufferShortfallDays: null, lastEarningsDate: null },
        }),
        // 建仓腿：`null` 与 `no_date` 是两个值 —— 一个占位符、一个虚线 chip。
        makeLeg({
          code: buildLeg,
          strike: '80.00',
          expiryDate: '2026-08-14',
          basis: 'weekly',
          tier: 'acceptable',
          tabs: ['all', 'build'],
          earningsMark: null,
        }),
        // 🚨 死档**照常打标**（判据是 mark 不是档位）；server 已把它排到末尾。
        makeLeg({ code: deadSameExpiry, strike: '50.00', expiryDate: E1, tier: 'dead' }),
      ]),
    },
  });
  await openDetail(page, 'us:PEP');

  // 五形态同屏。
  await expect(page.getByTestId(markId(covered))).toHaveText(COPY.earningsCovered);
  await expect(page.getByTestId(markId(bufferShort))).toHaveText(COPY.earningsBufferShort(3));
  await expect(page.getByTestId(markId(crosses))).toHaveText(COPY.earningsCrosses);
  await expect(page.getByTestId(markId(noCross))).toHaveText(COPY.earningsNoCross);
  await expect(page.getByTestId(markId(noDate))).toHaveText(COPY.earningsNoDate);
  await expect(page.getByTestId(markId(buildLeg))).toHaveText(COPY.noValue);

  // 同一到期日 ⇒ 同一个标（含死档行）。
  await expect(page.getByTestId(markId(coveredTwin))).toHaveText(COPY.earningsCovered);
  await expect(page.getByTestId(markId(deadSameExpiry))).toHaveText(COPY.earningsCovered);
  // 死档仍有动作四态里的「死档剔除」—— 打标与判档是两码事。
  await expect(page.getByTestId(actionId(deadSameExpiry))).toHaveText(COPY.actionDead);

  // 🚨 「无日期」(不知道) 与「不跨」(已确认) MUST 在形态上分得开：虚线 chip vs 无 chip 纯文字。
  const chipShape = (code: string) =>
    page.getByTestId(markId(code)).evaluate((el) => {
      const chip = el.firstElementChild ?? el;
      const s = getComputedStyle(chip);
      return { style: s.borderTopStyle, width: s.borderTopWidth };
    });
  const gapChip = await chipShape(noDate);
  const plainChip = await chipShape(noCross);
  expect(gapChip.style, '「无日期」不是虚线 chip（数据缺口体系）').toBe('dashed');
  expect(Number.parseFloat(gapChip.width)).toBeGreaterThan(0);
  expect(
    Number.parseFloat(plainChip.width),
    '「不跨」渲成了 chip —— 与「无日期」在形态上混了',
  ).toBe(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑩ FR-012 —— 点行 / 点动作标签零导航、零状态变化、零请求（运行时判据）
// ════════════════════════════════════════════════════════════════════════════

test('047 T035 — FR-012 运行时：腿行与动作标签**点不动** —— 零导航、零选中态、零新请求（本片无「选腿 → 许愿单」入口）', async ({
  page,
}) => {
  const legs = manyLegs(6);
  const code = legs[0]?.code ?? '';
  const mock = await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: { 'us:PEP': makeLegTable('us:PEP', legs) },
  });
  await openDetail(page, 'us:PEP');

  const row = page.getByTestId(rowId(code));
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();

  // 行内零可点原语（T034 的源码扫描在运行时的对应面）。
  // 📌 `accessibilityRole` 在 web 上落成 `role` ⇒ 这两条是**真**断言；
  //    ⚠️ 别再加一条 `[aria-selected]` 计数为 0 —— RNW 0.21 压根不产出该属性，那条恒真。
  await expect(row.getByRole('button')).toHaveCount(0);
  await expect(row.getByRole('link')).toHaveCount(0);
  // 动作列是**建议标签**不是按钮。
  await expect(page.getByTestId(actionId(code)).getByRole('button')).toHaveCount(0);

  const urlBefore = page.url();
  const countBefore = await page.getByTestId('optionsdesk-detail-leg-count').textContent();
  const callsBefore = mock.deskCalls().length;
  // 「选中态」在这一片最可能的形态就是换底色 —— 点前点后逐字比。
  const toneBefore = await row.evaluate((el) => getComputedStyle(el).backgroundColor);

  await row.tap();
  await page.getByTestId(actionId(code)).tap();
  await page.getByTestId(`optionsdesk-detail-leg-bid-${code}`).tap();
  await page.waitForTimeout(500);

  expect(page.url(), '点腿行发生了导航').toBe(urlBefore);
  await expect(row).toBeVisible();
  expect(
    await row.evaluate((el) => getComputedStyle(el).backgroundColor),
    '点腿行后行底色变了 —— 长出了选中态',
  ).toBe(toneBefore);
  await expect(row.getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(countBefore ?? '');
  // 零新请求 —— 采集端全开（记的是所有期权台请求），过滤放断言端。
  expect(mock.deskCalls().slice(callsBefore), '点腿行触发了新请求').toEqual([]);
});
