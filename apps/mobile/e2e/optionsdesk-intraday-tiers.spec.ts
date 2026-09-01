import { expect, test, type Locator, type Page, type Route } from './_support/fixtures';
import type {
  AnchorResponse,
  LegActivityResponse,
  LegResponse,
  LegResponsePriceKind,
  LegTableResponse,
  LegTableResponsePriceKind,
  LegTableResponseRealtimeDegrade,
} from '@nvy/api-client';

import { mockJson } from './_support/api-mock';
import {
  BASIS_BY_PERSPECTIVE,
  emptyPerspectiveCriteria,
  PERSPECTIVE_REQUIRED_400,
  perspectiveOf,
  quoted,
  type LegPerspective,
} from './_support/optionsdesk-fixtures';

// 064 T011 — 盘中实时档 / 收盘档**呈现口径**的 hermetic UI e2e（Playwright Expo Web，
// Constitution §V 两层验证之一；另一层是 T012 的契约冒烟）。样板 = `optionsdesk-leg-display.spec.ts`。
//
// 覆盖（逐条对应 tasks.md T011）：
//   ① **FR-010** —— 实时档的 asOf 呈**时刻含秒**；收盘档呈**交易日**。两档形态互为否定判据。
//   ② **SC-004** —— 降级时整表回落收盘值且**零 0 值**（逐格扫描，肉眼核对必漏）。
//   ③ **FR-009** —— 部分缺失**逐行**标档：断言两种档位**都在 DOM 里**（全一种即为页级一刀切
//      或缺失被吞，两种错都不会自己红）。
//   ④ **FR-014** —— OI 列的归属日**不随实时档变成今天**。
//   ⑤ **FR-021 / SC-009** —— 刷新后成员变化提示出现且进出条数各自正确（两个数不对称，写反会红）。
//   ⑥ **FR-022** —— 首屏等待态期间**不出现任何腿行**（不先渲一份昨收的表再覆盖）。
//   ⑦ **FR-011（T007a + T008a）** —— 同一个 `eod_close`：降级标 `null` 走中性态、
//      `source_unavailable` 走告警态且原因非空。这两条是本 feature 立项理由的用户可见半边。
//
// ── 🚨 为什么另起一个文件而不是往 051 那份里加 ─────────────────────────────────
//   051 那份的 canonical 状态是「同一批数据在三个视角下的读法差异」，每条断言都要先问一句
//   「这行现在是哪个视角的形态」；本片验的是**同一个视角下、同一批腿在两个时间档下的读法差异**，
//   需要的是「块级说实时而行级说收盘」「同一个 eod_close 分叉成两种脸」这类**跨档位自相矛盾**
//   的数据。混进去会让那边每条既有断言都得再多带一个档位维度。
//
// ── 🚨 mock 纪律：handler 是 `(请求参数, canonical 状态) → 响应` 的纯函数 ───────
//   🚫 **零 `callCount`**（per `.claude/rules/mobile-e2e-hermetic.md`）。⑤ 那条要的「相邻两次
//   取数成员不同」**不是**由调用序表达的：canonical 状态里存着「被 mock 的那个服务端此刻的库存」
//   （{@link CanonicalTable.regime}），test 在两次用户动作**之间**显式调 {@link advanceMarket}
//   把库存换掉 —— 换的是**世界**，不是「第几次被问到」。handler 全程只读当下的库存，同一批
//   参数在同一个世界里恒答同一份。⇒ 客户端哪天多发一次请求（预取 / 失效），这里照样答对，
//   而 `callCount === 0 ? A : B` 会静默错位且**所有断言照样绿**。
//
// ── Expo Web 下**验不到**的（如实标注，不凑假断言）───────────────────────────────
//   · 真实时段内候选集随价格移动的进出 / 收盘那一刻的档位切换 / 与真源的数值一致性
//     —— spec `web_compat_notes` 已写明，全部归 T013 真机实证。
//   · 下拉刷新手势本身 —— RN Web 的 `RefreshControl` **无下拉行为**，故本片一律走档位条右端
//     那个可点入口（两者调的是同一个 refetch，见 `underlying-detail-screen.tsx` 就地注释）。
//   · 契约对齐（生成客户端 ↔ 真 server）—— 本文件的 mock 是**手写的契约镜像**，镜像写错了
//     它自己不会红 ⇒ 归 T012 契约冒烟。两层正交，缺一层就有一条缝没人合。
//
// ── auth 范式 ────────────────────────────────────────────────────────────────
//   seed localStorage（含 accessToken）→ boot GET /me 必拦；**refresh-token 也必拦**，
//   否则任一 authed 401 触发 003 拦截器 retry-once 失败 → clearSession 误登出。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const BARS_RE = /\/api\/v1\/marketdata\/instruments\//;

const SEED_ACCOUNT_ID = 'acc-e2e-064';
const SEED_ACCESS_TOKEN = 'access-e2e-064';
const SEED_REFRESH_TOKEN = 'refresh-e2e-064';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139064';

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

/** 窄视口（iPhone 量级）—— 同 047 / 051：12 列共 716px，宽屏下右侧列压根不藏。 */
test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(180_000);

// ════════════════════════════════════════════════════════════════════════════
// 时间事实（**运行时算**，🚫 不硬编码日期：写死的那份一周后就与「今天」脱节）
// ════════════════════════════════════════════════════════════════════════════

function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 档位条上的短形（`leg-tier-bar.rules.ts` 的 `formatQuoteSessionDay` 同口径）。 */
const monthDay = (day: string): string => day.slice(5, 10);

const TODAY = ymd(new Date());
const SESSION_DAY = ymd(new Date(Date.now() - 86_400_000));

/**
 * 实时档的采集时刻 —— **本地墙钟 21:47:32 的那一瞬**，序列化成 ISO 送出。
 *
 * 🚨 **必须由本地时刻反推 ISO，🚫 不能写死一个 UTC 串**：`formatQuoteClock` 渲的是**设备本地**
 *    墙钟（境内用户盯美股盘中，看到的必须是自己表上的钟点）⇒ 写死 UTC 串的话期望值会随跑测
 *    机器的时区漂移。反过来构造之后，`REALTIME_CLOCK` 在任何时区都恒等于渲染结果。
 * 🚨 **秒取 32 而不是 00**：时区偏移只有整小时 / 半小时两种，秒位穿过时区转换恒不变 ⇒
 *    「秒被吞掉了」在这里是**可判**的（FR-010 明写含秒）。
 */
const REALTIME_AT = (() => {
  const d = new Date();
  d.setHours(21, 47, 32, 0);
  return d;
})();
const REALTIME_ISO = REALTIME_AT.toISOString();
const REALTIME_CLOCK = '21:47:32';

/** 时刻形态（含秒）/ 交易日短形 —— 两者互为否定判据（粒度即档位，FR-010）。 */
const CLOCK_RE = /^\d{2}:\d{2}:\d{2}$/;
const MONTH_DAY_RE = /^\d{2}-\d{2}$/;

// ════════════════════════════════════════════════════════════════════════════
// 屏内文案（`optionsdesk-copy.ts` 逐字；改文案就该在这里红）
// ════════════════════════════════════════════════════════════════════════════

const COPY = {
  tierLive: '实时',
  tierEod: '收盘档',
  tierBusyFirstLoad: '正在取此刻报价',
  tierEodReason: '非常规交易时段',
  tierDegradeSourceDown: '🚨 盘中取不到实时源，勿据此下单',
  tierDegradeOverCap: '合约过多超出单批上限，可收窄条件重试',
  tierDegradeBasisStale: '标的盘中价未更新，定不出取价范围',
  tierDegradeGateUnknown: '判不出是否交易时段，下拉可重试',
  tierPartialMiss: (n: number) => `${n} 条未取到实时 · 见行内「收」标`,
  eodBadge: '收',
  refreshCta: '刷新',
  oiAsOfSub: (md: string) => `截至 ${md}`,
  membershipEntered: (n: number) => `${n} 条新进`,
  membershipLeft: (n: number) => `${n} 条已不满足`,
} as const;

// ════════════════════════════════════════════════════════════════════════════
// canonical 数据（= 被 mock 的那个服务端此刻的库存）
// ════════════════════════════════════════════════════════════════════════════

const ANCHOR_BASE: Omit<AnchorResponse, 'id' | 'ticker'> = {
  // D13 标的名: 本片不涉及行首呈现 ⇒ 取「未注册」(null), 屏上退回代号 = 045 初版的样子。
  name: null,
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

function makeAnchor(id: string, ticker: string): AnchorResponse {
  return { ...ANCHOR_BASE, id, ticker };
}

/**
 * 🚨 **每条腿的每一格都给了非零真值**（含 {@link ACTIVITY}）—— 这是 ② 那条扫描断言成立的前提：
 *    fixture 里一个 `0` / 一个占位符都没有 ⇒ 屏上但凡出现 `0` / `—`，就只可能是**降级路径
 *    自己造出来的**（回落成 0 / 清空既有值）。哪怕留一格合法的 `—`，扫描就得开例外，
 *    而例外一开，真的那个 `—` 也跟着被放过去了。
 */
const ACTIVITY: LegActivityResponse = {
  isRoundStrike: true,
  isTopRanked: false,
  label: 'round_strike',
};

const LEG_BASE: Omit<LegResponse, 'code' | 'strike'> = {
  expiryDate: '2026-12-18',
  dteDays: 180,
  ...quoted('3.40', '3.70'),
  bidSize: 25,
  askSize: 26,
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
  activity: ACTIVITY,
  isRecommended: false,
  isMonthlyChain: false,
  earningsMark: { mark: 'covered', bufferShortfallDays: null, lastEarningsDate: '2026-10-28' },
  greeksComplete: true,
  priceKind: 'eod_close',
  bandStatus: null,
  wideSpreadOpportunity: false,
};

function leg(code: string, strike: string, over: Partial<LegResponse> = {}): LegResponse {
  return { ...LEG_BASE, code, strike, ...over };
}

const L1 = 'TIER261218P75000';
const L2 = 'TIER261218P72500';
const L3 = 'TIER261218P70000';
const L4 = 'TIER261218P67500';
const L5 = 'TIER261218P65000';
/** ⑤ 专用：第二个世界里**新进**的两条。 */
const L6 = 'TIER261218P62500';
const L7 = 'TIER261218P60000';

/** 五条腿的基准册（②③④⑥⑦ 共用；🚫 值一格不改 —— 它同时是 ② 的「回落目标」）。 */
const LEGS: readonly LegResponse[] = [
  leg(L1, '75.00'),
  leg(L2, '72.50'),
  leg(L3, '70.00'),
  leg(L4, '67.50'),
  leg(L5, '65.00'),
];

/**
 * 一票在**某一刻**的报价形态 —— 区块级四件套 + 该批腿。
 *
 * 🚨 `priceKind`（区块级）与每腿的 `priceKind` **不是同一个数**（契约逐字写明）：
 *    部分合约未返回时区块级仍 `realtime` 而那几行是 `eod_close`（③ 正是它的判据）。
 * 🚨 `realtimeDegrade` **不由 `priceKind` 反推**：同一个 `eod_close`，`null` 是常态（美股休市）、
 *    非 `null` 才是「本该给实时却没给成」（⑦ 正是它的判据）。
 */
interface QuoteRegime {
  readonly priceKind: LegTableResponsePriceKind;
  readonly quoteAsOf: string;
  readonly oiAsOf: string;
  readonly realtimeDegrade: LegTableResponseRealtimeDegrade;
  readonly legs: readonly LegResponse[];
}

/**
 * 一票的 canonical 状态。
 *
 * 🚨 `regime` **可变**是刻意的，且它**不是** `callCount` 的马甲：它记的是「被 mock 的那个服务端
 *    此刻的库存」，只能由 test 在两次用户动作之间经 {@link advanceMarket} 显式换掉 ——
 *    换的是**世界**，不是「第几次被问到」。handler 全程只读当下的库存 ⇒ 同一个世界里，
 *    同一批参数恒答同一份，客户端多发几次请求都不会错位。
 */
interface CanonicalTable {
  readonly symbol: string;
  regime: QuoteRegime;
}

function table(symbol: string, regime: QuoteRegime): CanonicalTable {
  return { symbol, regime };
}

/** 换一个世界（⑤ 的「相邻两次取数之间行情动了」）。 */
function advanceMarket(target: CanonicalTable, next: QuoteRegime): void {
  target.regime = next;
}

const eodRegime = (
  legs: readonly LegResponse[],
  realtimeDegrade: LegTableResponseRealtimeDegrade,
): QuoteRegime => ({
  priceKind: 'eod_close',
  // 收盘档的时点**就是**那批快照归属的交易日（粒度即档位）。
  quoteAsOf: SESSION_DAY,
  oiAsOf: SESSION_DAY,
  realtimeDegrade,
  legs,
});

/**
 * 实时档 —— **逐行档位由 `missing` 显式指定**，其余行一律 `realtime`。
 *
 * 🚨 **行级档位必须在这里被显式写一遍，🚫 不许沿用 {@link LEG_BASE} 的默认值**：首版就是让
 *    基准册的 `eod_close` 漏了下来，于是「区块实时 + 全行收盘」被当成实时档喂进三条 test ——
 *    三条**照样全绿**（它们各自只看档位条），而 ③ 那条一跑就红成 `5 !== 2`。⇒ 区块级与行级
 *    是两个数这件事，在 fixture 这一侧同样成立，一处默认就够让整片失真。
 *
 * @param missing 本批**没返回**的合约码（那几行保留收盘值并标 `eod_close`）。
 */
const liveRegime = (
  legs: readonly LegResponse[],
  missing: readonly string[] = [],
): QuoteRegime => ({
  priceKind: 'realtime',
  quoteAsOf: REALTIME_ISO,
  // 🚨 OI 盘中冻结 ⇒ 实时档下它**仍归属上一交易日**（FR-004 / FR-014）。这一格与上一格
  //    刻意不同天，④ 正是拿它们的差判「OI 列有没有跟着区块级翻成今天」。
  oiAsOf: SESSION_DAY,
  // 取到了实时值 ⇒ 链级**不是**降级（部分缺失也不算，那是逐行的事）。
  realtimeDegrade: null,
  legs: legs.map((l) => ({
    ...l,
    priceKind: (missing.includes(l.code) ? 'eod_close' : 'realtime') as LegResponsePriceKind,
  })),
});

/**
 * canonical 状态 + 请求的视角 → **一份**契约响应。复杂度 O(n)。
 *
 * 📌 本片**不验渲染序**（那是 051 T011 的靶心，判据是「服务端下发的数组序」）⇒ 三个视角原样
 *    下发同一册腿，🚫 不在这里复刻一份排序规则（复刻出来的那份既不被断言、又必与 server 漂移）。
 */
function project(canonical: CanonicalTable, perspective: LegPerspective): LegTableResponse {
  const { regime, symbol } = canonical;
  const legs = [...regime.legs];
  return {
    symbol,
    // 069 契约增量: 每 K 行军判决 —— 仅实时收租有值, mock 基线取缺省 null。
    march: null,
    // 070 契约增量: 行军模式标示 —— 与 march 同生共死, 基线随之 null。
    marchMode: null,
    perspective,
    state: 'available',
    // 区块头那一行答的是「库内快照属于哪个业务日」—— 实时档下它照旧是那个交易日
    // （被覆盖的只有七列报价，OI 与未覆盖列仍出自这一批）。
    asOf: SESSION_DAY,
    asOfFreshnessTier: 'CURRENT',
    priceKind: regime.priceKind,
    realtimeDegrade: regime.realtimeDegrade,
    quoteAsOf: regime.quoteAsOf,
    oiAsOf: regime.oiAsOf,
    source: 'eod',
    spot: '82.40',
    w: '80.00',
    zone: 'buy',
    lLevel: 'L2',
    // 意图矩阵在 (买区, L2, 水位 ≥2/3) 下的输出 = 收租 · deep —— 水位已选 ⇒ 无「未选水位」
    // 那两条注明来干扰本文件的断言面（同 051 T011 的选法）。
    positionBucket: 'gte_two_thirds',
    positionBucketSource: 'manual',
    positionBucketSetAt: `${TODAY}T01:00:00.000Z`,
    intent: 'rent',
    rentDepth: 'deep',
    legs,
    gateCounts: { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 },
    basis: BASIS_BY_PERSPECTIVE[perspective],
    criteria: emptyPerspectiveCriteria(),
    matchedCount: legs.length,
    memberCount: legs.length,
    displayLimit: null,
    candidateCapDropped: 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// hermetic mock
// ════════════════════════════════════════════════════════════════════════════

/**
 * 🚨 `…/legs` 分支 MUST 排在 `underlyings/(.+)$` 之前 —— 后者的贪婪 `(.+)` 会把 `/legs`
 *    整段吃成 symbol（047 实撞过，症状是选约区块恒「未就绪」而锚卡正常）。
 *
 * @param legsDelayMs 选约表那一发的**迟到毫秒**（⑥ 的等待窗口）。🚨 它是 `(参数) → (响应, 延迟)`
 *   的一部分，仍是纯函数 —— 迟到与否不看「第几次」，看的是这次 mock 装的是哪一档。
 */
async function installLegMock(
  page: Page,
  book: Record<string, CanonicalTable>,
  legsDelayMs = 0,
): Promise<void> {
  const anchors = Object.keys(book).map((ticker, i) => makeAnchor(`anchor-${i + 1}`, ticker));

  await page.route(OPTIONSDESK_RE, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));

    const url = new URL(req.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
    const notFound = () =>
      json(404, { status: 404, code: 'ANCHOR_NOT_FOUND_FOR_SYMBOL', title: 'anchor not found' });

    const legsMatch = /\/optionsdesk\/underlyings\/(.+)\/legs$/.exec(path);
    if (legsMatch) {
      const target = book[decodeURIComponent(legsMatch[1] ?? '')];
      if (!target) return void (await notFound());
      // 🚨 053 FR-001：`perspective` 必填 —— 缺参 / 非三值 → 400。
      //    🚫 MUST NOT 默认一个视角：腿数、名次、档位全都正常，只是答的不是问的那个视角。
      const perspective = perspectiveOf(url);
      if (perspective === null) return void (await json(400, PERSPECTIVE_REQUIRED_400));
      if (legsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, legsDelayMs));
      return void (await json(200, project(target, perspective)));
    }

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

  // 折线区归 046 覆盖 —— 空序列（区间带照常画，页面不报错）。
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

// ════════════════════════════════════════════════════════════════════════════
// 交互原语
// ════════════════════════════════════════════════════════════════════════════

const SYMBOL_LIVE = 'us:TIERA';
const SYMBOL_EOD = 'us:TIERB';
const SYMBOL_DEGRADED = 'us:TIERC';
const SYMBOL_PARTIAL = 'us:TIERD';
const SYMBOL_MEMBER = 'us:TIERE';
const SYMBOL_SLOW = 'us:TIERF';

const TIER = 'optionsdesk-detail-leg-tier';
const rowId = (code: string) => `optionsdesk-detail-leg-row-${code}`;
const eodBadgeId = (code: string) => `optionsdesk-detail-leg-eod-${code}`;

const rows = (page: Page): Locator => page.locator('[data-testid^="optionsdesk-detail-leg-row-"]');
const eodBadges = (page: Page): Locator =>
  page.locator('[data-testid^="optionsdesk-detail-leg-eod-"]');

/**
 * 打开详情屏并等档位条挂上。
 *
 * 🚨 顺带断言**只有一条** —— 叠屏 / 重复挂载会让后续每条 `getByTestId` 撞 strict-mode 双命中，
 *    而那时的错误消息指向的是断言本身而不是病根（per `reference_expo_web_e2e_and_router_footguns`）。
 */
async function openDetail(page: Page, symbol: string): Promise<void> {
  await page.goto(`/optionsdesk/underlying/${encodeURIComponent(symbol)}`);
  await expect(page.getByTestId(TIER)).toHaveCount(1, { timeout: 90_000 });
}

/** 档位条的四格文本（缺席的那格返回 `null` —— 「没渲染」与「渲了空串」是两件事）。 */
async function tierText(page: Page, part: 'name' | 'stamp' | 'why'): Promise<string | null> {
  const node = page.getByTestId(`${TIER}-${part}`);
  return (await node.count()) === 0 ? null : ((await node.textContent()) ?? '');
}

/**
 * 档位条容器的**值面**视觉（🚫 不硬编码色值：调色板一改就假红，且 class 名不进 web DOM）。
 * 左边框宽度是告警态的结构特征（`border-l-[3px]`），底色是它的另一半。
 */
async function tierTone(page: Page): Promise<{ bg: string; borderLeft: string }> {
  return page.getByTestId(TIER).evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, borderLeft: s.borderLeftWidth };
  });
}

/**
 * 原因文案在当前视口下**渲成了几行**。
 *
 * 🚨 判据是**渲染高度**而不是字数：字宽随字体 / 字号 / 视口而变，数汉字只是估计，
 *    而「撑到第二行」是个像素事实。比的是元素自身高度与它自己的行高（🚫 不硬编码 px）。
 */
async function tierWhyLines(page: Page): Promise<number> {
  return page.getByTestId(`${TIER}-why`).evaluate((el) => {
    const s = getComputedStyle(el);
    const lineHeight = Number.parseFloat(s.lineHeight);
    const unit = Number.isFinite(lineHeight) ? lineHeight : Number.parseFloat(s.fontSize) * 1.2;
    return Math.max(1, Math.round(el.getBoundingClientRect().height / unit));
  });
}

/** 等这一批落定（腿行到齐）—— 档位条在等待态也渲染，拿它当落定信号等于不等。 */
async function expectRows(page: Page, n: number): Promise<void> {
  await expect(rows(page)).toHaveCount(n, { timeout: 90_000 });
}

/** 12 列表头整条文本（列序是版面实现细节，断言走「含 / 不含」而不是按第 N 个孩子取）。 */
async function headerText(page: Page): Promise<string> {
  return (await page.getByTestId('optionsdesk-detail-leg-header-scroller').textContent()) ?? '';
}

/**
 * 一行渲染出来的**全部读数**（首列 + 11 列），按空白切成 token。
 *
 * 🚨 断言面刻意是「整行文本」而不是逐个 testID：OI 与成交量两列**没有** testID（它们本就不该
 *    为测试而新增），而 `SC-004` 恰恰最在乎它们没被回落成 0。整行扫描把没有锚点的那几格
 *    一并纳入。
 */
async function rowTokens(page: Page, code: string): Promise<string[]> {
  const text = await page.getByTestId(rowId(code)).innerText();
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * `SC-004` 的机器判据：**被置为 0 / 空 / 占位符的项数 = 0**。
 *
 * 覆盖 `0` / `0.00` / `×0` / `0%` / `+0.0%` 全部零形态，外加统一占位符 `—`。
 * 🚨 fixture 里一个零值都没有（见 {@link ACTIVITY} 头注）⇒ 命中即是降级路径自己造出来的。
 */
const ZERO_TOKEN_RE = /^[×+-]?0(\.0+)?%?$/;
const PLACEHOLDER = '—';

function expectNoZeroValues(tokens: readonly string[], where: string): void {
  const offenders = tokens.filter((t) => ZERO_TOKEN_RE.test(t) || t === PLACEHOLDER);
  expect(offenders, `${where} 出现了被置 0 / 清空的读数: ${offenders.join(' , ')}`).toEqual([]);
}

// ════════════════════════════════════════════════════════════════════════════
// ① FR-010 —— 两档的 asOf 粒度即档位
// ════════════════════════════════════════════════════════════════════════════

test('064 T011 — FR-010：实时档的 asOf 呈**时刻含秒**、收盘档呈**交易日**，两种形态互不相容', async ({
  page,
}) => {
  await installLegMock(page, {
    [SYMBOL_LIVE]: table(SYMBOL_LIVE, liveRegime(LEGS)),
    [SYMBOL_EOD]: table(SYMBOL_EOD, eodRegime(LEGS, null)),
  });

  // ── 实时档：`HH:mm:ss`，秒**没有被吞掉** ────────────────────────────────────
  await openDetail(page, SYMBOL_LIVE);
  await expectRows(page, LEGS.length);
  expect(await tierText(page, 'name')).toBe(COPY.tierLive);
  const liveStamp = await tierText(page, 'stamp');
  expect(liveStamp, '实时档没渲时点').not.toBeNull();
  expect(liveStamp, `实时档时点不是 HH:mm:ss 形态: ${String(liveStamp)}`).toMatch(CLOCK_RE);
  // 🚨 秒位穿过任何时区转换恒不变 ⇒ 这一条就是「粒度被降成分钟」的机械防线。
  expect(liveStamp).toBe(REALTIME_CLOCK);
  // 🚨 前提自检：这是一批**全实时**的腿 —— 零行级「收」标、档位条零「未取到实时」。
  //    首版 fixture 正是在这里漏了行级档位（全行仍是 `eod_close`），而本条 test 当时照样全绿。
  await expect(
    eodBadges(page),
    '全实时批却出现了行级「收」标 —— fixture 的行级档位没设对',
  ).toHaveCount(0);
  expect(await tierText(page, 'why')).toBe(null);

  // ── 收盘档：`MM-DD`，且**绝不是**一个时刻（把交易日渲成 08:00:00 正是「昨收伪装成此刻」）──
  await openDetail(page, SYMBOL_EOD);
  await expectRows(page, LEGS.length);
  expect(await tierText(page, 'name')).toBe(COPY.tierEod);
  const eodStamp = await tierText(page, 'stamp');
  expect(eodStamp, `收盘档时点不是 MM-DD 形态: ${String(eodStamp)}`).toMatch(MONTH_DAY_RE);
  expect(eodStamp).toBe(monthDay(SESSION_DAY));
  expect(eodStamp, '收盘档渲成了时刻').not.toMatch(CLOCK_RE);
  expect(liveStamp, '两档的时点长得一样 —— 粒度没跟着档位走').not.toBe(eodStamp);
});

// ════════════════════════════════════════════════════════════════════════════
// ② SC-004 —— 降级整表回落收盘值，零 0 值
// ════════════════════════════════════════════════════════════════════════════

test('064 T011 — SC-004：降级时整表回落**库内收盘值**，逐格扫描**零 0 值 / 零占位符**，且与正常收盘档逐字相同', async ({
  page,
}) => {
  await installLegMock(page, {
    [SYMBOL_DEGRADED]: table(SYMBOL_DEGRADED, eodRegime(LEGS, 'source_unavailable')),
    [SYMBOL_EOD]: table(SYMBOL_EOD, eodRegime(LEGS, null)),
  });

  await openDetail(page, SYMBOL_DEGRADED);
  await expectRows(page, LEGS.length);

  // ① 逐行扫描：一个 0 / 一个占位符都不许有（肉眼逐字段核对必漏，故机器化）。
  const degraded: Record<string, string[]> = {};
  for (const l of LEGS) {
    degraded[l.code] = await rowTokens(page, l.code);
    expectNoZeroValues(degraded[l.code] ?? [], `降级档 ${l.code}`);
  }
  // ② 前提自检：扫描确实扫到了东西（一行零 token 时 ① 会平凡通过）。
  expect(degraded[L1]?.length ?? 0).toBeGreaterThan(8);
  // ③ bid 真的还是库内那个值 —— 「没有 0」还不够，值得是**对的**那个。
  expect(degraded[L1]?.join(' ')).toContain('3.40');

  // ④ 整表回落 = 与**正常收盘档**那张表逐行逐字相同（降级只改档位条那一句话，不改任何读数）。
  await openDetail(page, SYMBOL_EOD);
  await expectRows(page, LEGS.length);
  for (const l of LEGS) {
    expect(await rowTokens(page, l.code), `${l.code} 在降级档与正常收盘档下读数不同`).toEqual(
      degraded[l.code],
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ③ FR-009 —— 部分缺失逐行标档（两种档位都必须在 DOM 里）
// ════════════════════════════════════════════════════════════════════════════

test('064 T011 — FR-009：部分合约未取到实时时**逐行**标档 —— 两种档位都在 DOM 里，且档位条报出条数', async ({
  page,
}) => {
  // 区块级 `realtime`（本批取到了）+ 其中两行 `eod_close`（这两个合约没返回）。
  await installLegMock(page, {
    [SYMBOL_PARTIAL]: table(SYMBOL_PARTIAL, liveRegime(LEGS, [L2, L4])),
    // 对照：整表收盘档 —— T008 蓄意收窄成**不**逐行打标（那时每行都是收盘档，标只是噪点）。
    [SYMBOL_EOD]: table(SYMBOL_EOD, eodRegime(LEGS, null)),
  });

  await openDetail(page, SYMBOL_PARTIAL);
  await expectRows(page, LEGS.length);

  // ① 区块级仍是实时（🚫 部分缺失 MUST NOT 把整块拉成降级态）。
  expect(await tierText(page, 'name')).toBe(COPY.tierLive);

  // ② 🚨 两种档位**都**在 DOM 里 —— 全一种即为页级一刀切（全标）或缺失被吞（全不标），
  //    两种错各自都渲染得出一张完整的表，只有这一条分得开。
  await expect(eodBadges(page)).toHaveCount(2);
  const marked = await eodBadges(page).count();
  expect(marked, '一枚标都没有 —— 逐行降级被吞了').toBeGreaterThan(0);
  expect(marked, '每行都带标 —— 页级一刀切').toBeLessThan(await rows(page).count());
  for (const code of [L2, L4])
    await expect(page.getByTestId(eodBadgeId(code)), `${code} 该标「收」却没标`).toHaveText(
      COPY.eodBadge,
    );
  for (const code of [L1, L3, L5])
    await expect(page.getByTestId(eodBadgeId(code)), `${code} 是实时行却标了「收」`).toHaveCount(0);

  // ③ 档位条报出**去处**（说出条数，人才知道要去行内找那枚「收」标）。
  expect(await tierText(page, 'why')).toBe(COPY.tierPartialMiss(2));

  // ④ 反面：整表收盘档下**一枚行级标都不出**（T008 的蓄意收窄）。
  await openDetail(page, SYMBOL_EOD);
  await expectRows(page, LEGS.length);
  await expect(eodBadges(page), '整表收盘档逐行打了标 —— 那是噪点，且会吃掉档位色').toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ④ FR-014 —— OI 列的归属日不随实时档变今天
// ════════════════════════════════════════════════════════════════════════════

test('064 T011 — FR-014：实时档下 OI 列的归属日仍是**上一交易日**，🚫 不跟着区块级翻成今天', async ({
  page,
}) => {
  await installLegMock(page, { [SYMBOL_LIVE]: table(SYMBOL_LIVE, liveRegime(LEGS)) });
  await openDetail(page, SYMBOL_LIVE);
  await expectRows(page, LEGS.length);

  // 前提自检：区块级时点确实已经是**今天此刻**（否则本条无判别性）。
  expect(await tierText(page, 'name')).toBe(COPY.tierLive);
  expect(await tierText(page, 'stamp')).toBe(REALTIME_CLOCK);
  expect(monthDay(SESSION_DAY), 'OI 归属日与今天同一天 —— fixture 失去判别性').not.toBe(
    monthDay(TODAY),
  );

  const header = await headerText(page);
  expect(header, 'OI 列副标没挂上归属日').toContain(COPY.oiAsOfSub(monthDay(SESSION_DAY)));
  // 🚨 读错那一个时，OI 那一列的**数字一个都不会变** ⇒ 屏幕上不会有任何东西红，只有这条会。
  expect(header, 'OI 列跟着区块级翻成了今天').not.toContain(COPY.oiAsOfSub(monthDay(TODAY)));
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ FR-021 / SC-009 —— 刷新后成员变化提示，进出条数各自正确
// ════════════════════════════════════════════════════════════════════════════

test('064 T011 — FR-021 / SC-009：刷新后报出**本轮**成员进出，两个数各自正确（且首屏不报）', async ({
  page,
}) => {
  // 第一个世界：L1..L5。第二个世界：去掉 L1（1 条已不满足）、加上 L6/L7（2 条新进）。
  // 🚨 **两个数刻意不对称** —— 相等的话「进 / 出写反了」这类错在屏上完全一样。
  const target = table(SYMBOL_MEMBER, liveRegime(LEGS));
  const after = [...LEGS.filter((l) => l.code !== L1), leg(L6, '62.50'), leg(L7, '60.00')];
  await installLegMock(page, { [SYMBOL_MEMBER]: target });

  await openDetail(page, SYMBOL_MEMBER);
  await expectRows(page, LEGS.length);

  // ① 首屏（没有上一轮）⇒ **不报**成员变化（一进页面就被告知「5 条进」是句废话）。
  await expect(page.getByTestId('optionsdesk-detail-leg-membership')).toHaveCount(0);

  // ② 换一个世界，再走**用户能触到的那个刷新入口**。
  //    🚨 RN Web 的 `RefreshControl` 无下拉行为 ⇒ web 侧只能走档位条右端这个可点入口
  //       （两者调的是同一个 refetch）。用 role 在档位条内收窄，避开非常驻区那些同名入口。
  advanceMarket(target, liveRegime(after));
  await page.getByTestId(TIER).getByRole('button', { name: COPY.refreshCta }).tap();
  await expectRows(page, after.length);

  // ③ 两个数各自正确（写反会红在这两条上）。
  const notice = page.getByTestId('optionsdesk-detail-leg-membership');
  await expect(notice).toHaveCount(1);
  await expect(page.getByTestId('optionsdesk-detail-leg-membership-entered')).toHaveText(
    COPY.membershipEntered(2),
  );
  await expect(page.getByTestId('optionsdesk-detail-leg-membership-left')).toHaveText(
    COPY.membershipLeft(1),
  );

  // ④ 可关闭（它是一次**瞬时告知**，不是常驻状态）。
  await page.getByTestId('optionsdesk-detail-leg-membership-dismiss').tap();
  await expect(notice).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ FR-022 —— 首屏等待态期间不出现任何腿行
// ════════════════════════════════════════════════════════════════════════════

test('064 T011 — FR-022：首屏等待期间**一条腿行都不出现**（🚫 不先渲一份昨收的表再覆盖重排）', async ({
  page,
}) => {
  await installLegMock(page, { [SYMBOL_SLOW]: table(SYMBOL_SLOW, liveRegime(LEGS)) }, 5_000);
  await openDetail(page, SYMBOL_SLOW);

  const name = page.getByTestId(`${TIER}-name`);
  // ① 等待态就位。
  await expect(name).toHaveText(COPY.tierBusyFirstLoad, { timeout: 30_000 });
  // ② 此刻表里**空无一行**。
  await expect(rows(page)).toHaveCount(0);
  // ③ 且**不给任何时点** —— 屏上还没有任何一批数，写上去就是凭空的（等待态与「未就绪」
  //    在这一格上刻意同形：两者都没有可报的时刻）。
  expect(await tierText(page, 'stamp'), '等待态凭空渲了一个时点').toBe(null);
  // ④ 🚨 再确认一次仍在等待窗口内 —— 否则 ②③ 可能是「已经过去了」而不是「当时就是这样」。
  await expect(name).toHaveText(COPY.tierBusyFirstLoad);

  // ⑤ 这一批最终到齐 —— 否则 ②③ 只是「页面根本没加载」的平凡通过。
  await expectRows(page, LEGS.length);
  await expect(name).toHaveText(COPY.tierLive);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ FR-011（T007a + T008a）—— 同一个 eod_close 分叉成中性 / 告警两态
// ════════════════════════════════════════════════════════════════════════════

test('064 T011 — FR-011：正常休市的收盘档走**中性态**，源不可达的收盘档走**告警态**且原因具体（同一个 priceKind，两张脸）', async ({
  page,
}) => {
  // 三票一次装齐 —— 🚫 MUST NOT 中途再 `installLegMock` 追加：`page.route` 是叠加注册、
  // 后注册者先匹配，两层 handler 叠在一起时「这一发被谁答的」就不再一目了然。
  await installLegMock(page, {
    [SYMBOL_EOD]: table(SYMBOL_EOD, eodRegime(LEGS, null)),
    [SYMBOL_DEGRADED]: table(SYMBOL_DEGRADED, eodRegime(LEGS, 'source_unavailable')),
    [SYMBOL_LIVE]: table(SYMBOL_LIVE, liveRegime(LEGS)),
  });

  // ── 正常休市（境内白天的常态，天天如此）⇒ 中性 ────────────────────────────
  await openDetail(page, SYMBOL_EOD);
  await expectRows(page, LEGS.length);
  expect(await tierText(page, 'name')).toBe(COPY.tierEod);
  const neutralWhy = await tierText(page, 'why');
  expect(neutralWhy, '收盘档没给原因').toBe(COPY.tierEodReason);
  const neutral = await tierTone(page);
  // 🚨 **零告警视觉** —— 给所有 `eod_close` 刷告警底 = 造一个永远为真的告警，
  //    而永远为真的告警等于没有告警（本 feature 立项理由的另一半）。
  expect(neutral.borderLeft, `中性态挂了告警左边框: ${neutral.borderLeft}`).toBe('0px');

  // ── 美股盘中、源却挂了 ⇒ 告警 ─────────────────────────────────────────────
  await openDetail(page, SYMBOL_DEGRADED);
  await expectRows(page, LEGS.length);
  // 📌 名字仍是「收盘档」—— 屏上确实就是收盘盘口；「本该是实时」那半句由视觉 + 原因承担。
  expect(await tierText(page, 'name')).toBe(COPY.tierEod);
  const degradedWhy = await tierText(page, 'why');
  expect(degradedWhy, '降级没给原因').toBe(COPY.tierDegradeSourceDown);
  expect(degradedWhy, '🚫 降级与正常休市说了同一句话 —— 那正是 064 要消灭的那张脸').not.toBe(
    neutralWhy,
  );

  const degraded = await tierTone(page);
  // 值面自比较（🚫 不硬编码色值：调色板一改就假红）——「不同」本身就是判据。
  expect(Number.parseFloat(degraded.borderLeft), '降级态没挂 3px 左边框').toBeGreaterThanOrEqual(3);
  expect(degraded.bg, '两态底色相同 —— 降级没有被分叉出来').not.toBe(neutral.bg);

  // 🚨 反向闭合：实时档**不受**本字段影响（它恒 `null`，走的是自己那一档）。
  await openDetail(page, SYMBOL_LIVE);
  await expectRows(page, LEGS.length);
  const live = await tierTone(page);
  expect(await tierText(page, 'name')).toBe(COPY.tierLive);
  expect(live.borderLeft, '实时档挂了告警左边框').toBe('0px');
  expect(live.bg, '实时档与收盘档同底色 —— 档位没有被分开').not.toBe(neutral.bg);
});

test('064 收尾 — 档位条的原因文案在最窄视口下**恒为单行**（长度是硬约束，撑到第二行会把整条顶高）', async ({
  page,
}) => {
  // 五种原因各占一票 —— 🚫 别只测最长那句：文案是逐条改的，只钉一条等于其余四条没有守卫。
  const CASES = [
    ['us:TIERG', null, COPY.tierEodReason],
    ['us:TIERH', 'window_over_cap', COPY.tierDegradeOverCap],
    ['us:TIERI', 'window_basis_stale', COPY.tierDegradeBasisStale],
    ['us:TIERJ', 'source_unavailable', COPY.tierDegradeSourceDown],
    ['us:TIERK', 'gate_unknown', COPY.tierDegradeGateUnknown],
  ] as const;

  await installLegMock(
    page,
    Object.fromEntries(
      CASES.map(([symbol, degrade]) => [symbol, table(symbol, eodRegime(LEGS, degrade))]),
    ),
  );

  for (const [symbol, , expected] of CASES) {
    await openDetail(page, symbol);
    await expectRows(page, LEGS.length);
    // ① 先钉住文案本身 —— 改了文案就该在这里红（同本文件 COPY 镜像的约定）。
    expect(await tierText(page, 'why'), `${symbol} 的原因文案对不上`).toBe(expected);
    // ② 再钉版面：单行。🚨 这一条与 ① 缺一不可 —— 只钉文案，加长它不会红；
    //    只钉行数，文案换成一个字也不会红。
    const lines = await tierWhyLines(page);
    expect(lines, `「${expected}」在 ${390} px 视口下折成了 ${lines} 行`).toBe(1);
  }
});
