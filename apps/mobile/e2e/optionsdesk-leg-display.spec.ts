import { expect, test, type Page, type Route } from '@playwright/test';
import type { AnchorResponse, LegResponse, LegTableResponse } from '@nvy/api-client';

import { mockJson } from './_support/api-mock';
import { emptyCriteriaByTab } from './_support/optionsdesk-fixtures';

// 051 T011 — 选约表**显示口径**的 hermetic UI e2e（Playwright Expo Web，Constitution §V 两层
// 验证之一；另一层是 T012 的契约冒烟）。样板 = `optionsdesk-chain-leg-picker.spec.ts`。
//
// 覆盖（逐条对应 tasks.md T011）：
//   ① **SC-001** —— 三个视角的渲染序与服务端下发的 `tabOrder` **逐行相同**，且来回切不变
//   ② **SC-006** —— 同一条腿在两个意图视角显示**不同档位**；费率列头**即口径本身**（FR-017a）
//   ③ **SC-005** —— 推荐标在其所属的每个视角**同值**（标随标的级意图，不随视角）
//   ④ **SC-003** —— 流动性计数**按视角取数**，点击后落到全腿视角并**改口收回入口**
//   ⑤ **SC-004 + SC-013** —— 两种空态文案互不相同，且**不因另一个视角的排除数而改变**
//
// ── 🚨 为什么另起一个文件而不是往 047 那份里加 ─────────────────────────────────
//   047 那份的 canonical 状态是「一票一表 + 水位写端点」，服务的是 US2/US3/US4 的交互面；
//   本片验的是**同一批数据在三个视角下的读法差异**，需要的是「同一条腿两处不同档」「载体序
//   ≠ 渲染序」这类**刻意自相矛盾的数据**。混进去会让那边每条既有断言都得先问一句
//   「这行现在是哪个视角的形态」。
//
// ── 🚨 mock 纪律：`tabOrder` 与 `gateCounts` **从数据派生**（plan Testing Invariant 2）───
//   1. `tabOrder[t]` = 「`t` 的成员按该视角口径的费率降序」—— 与真端点同一条规则。写死数组会
//      与被 mock 的服务端不变量（`tabOrder[t]` 的元素集合 == `{code | t ∈ leg.tabs}`）当场矛盾，
//      而且**顺序判别性会消失**：派生出来的序恰好等于载体序时，「按 tabOrder 渲染」与
//      「按 legs[] 渲染」两种实现给出同一张屏。本文件的费率是**照着这条判别性配的**（见 BOOK_A）。
//   2. `gateCounts` 由每条腿的 `bandTabs`（「若不被流动性门槛挡下本该进哪些意图视角」）算出 ——
//      拍脑袋填会让 SC-013 的交叉判据失去意义：那条要的正是「标量 ≠ 某个视角自己的数」。
//
// ── Expo Web 下**验不到**的（如实标注，不凑假断言）───────────────────────────────
//   · 常驻区占屏比 / 730 行流畅度（SC-009 / SC-010）—— web 视口比真机宽松，读数不能当结论，
//     归 T013 真机验收。
//   · 契约对齐（生成客户端 ↔ 真 server）—— 本文件的 mock 是**手写的契约镜像**，镜像写错了
//     它自己不会红 ⇒ 归 T012 契约冒烟。两层是正交的，缺一层就有一条缝没人合。
//
// ── auth 范式 ────────────────────────────────────────────────────────────────
//   seed localStorage（含 accessToken）→ boot GET /me 必拦；**refresh-token 也必拦**，
//   否则任一 authed 401 触发 003 拦截器 retry-once 失败 → clearSession 误登出。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const BARS_RE = /\/api\/v1\/marketdata\/instruments\//;

const SEED_ACCOUNT_ID = 'acc-e2e-051';
const SEED_ACCESS_TOKEN = 'access-e2e-051';
const SEED_REFRESH_TOKEN = 'refresh-e2e-051';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139051';

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

/** 窄视口（iPhone 量级）—— 与 047 同前提：12 列共 716px，宽屏下右侧列压根不藏。 */
test.use({ viewport: { width: 390, height: 844 } });

function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const TODAY = ymd(new Date());

// ════════════════════════════════════════════════════════════════════════════
// 屏内文案（`optionsdesk-copy.ts` 逐字；改文案就该在这里红）
// ════════════════════════════════════════════════════════════════════════════

const COPY = {
  tabs: { all: '全腿视角', build: '建仓视角', rent: '收租视角' },
  rateBasisWeekly: '周化',
  rateBasisWeeklySub: '折年参照',
  rateBasisAnnualized: '年化',
  fitBadge: '贴合',
  monthlyBadge: '月',
  actionPlaceOco: '挂 OCO',
  actionHold: '暂不挂',
  rowTotal: (total: number) => `共 ${total} 行`,
  gatePremiumFloor: (n: number) => `权利金门槛移出 ${n} 条`,
  gatePremiumFloorNote: ' · 三个视角都看不到',
  gateLiquidity: (n: number) => `流动性门槛排除 ${n} 条`,
  gateLiquidityNoteIntent: ' · 仍在全腿视角',
  gateLiquidityNoteAll: ' · 仅全腿视角可见',
  emptyIntentTitle: { build: '建仓视角暂无候选', rent: '收租视角暂无候选' },
  emptyBlockedByGate: (n: number) =>
    `这只票有 ${n} 条腿在该视角的期限段内合格，但报价太宽，被流动性门槛挡在意图视角之外。`,
  emptyBlockedCta: (n: number) => `去全腿视角看这 ${n} 条`,
  emptyNoneReason: {
    build: '这只票没有一条腿同时满足建仓视角的期限段与有效成本门槛。',
    rent: '这只票没有一条腿落在收租视角的期限段内。',
  },
  emptyNoneTail: '换一只票，或改看另一个视角。',
} as const;

// ════════════════════════════════════════════════════════════════════════════
// canonical 数据（= 服务端 DB 内容的镜像）
// ════════════════════════════════════════════════════════════════════════════

type LegTab = 'all' | 'build' | 'rent';
type IntentTab = 'build' | 'rent';

const TAB_KEYS = ['all', 'build', 'rent'] as const;

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

function makeAnchor(id: string, ticker: string): AnchorResponse {
  return { ...ANCHOR_BASE, id, ticker };
}

const LEG_BASE: Omit<LegResponse, 'code'> = {
  strike: '75.00',
  expiryDate: '2026-12-18',
  dteDays: 180,
  bid: '3.40',
  ask: '3.70',
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
  activityByTab: { all: null, build: null, rent: null },
  tabs: ['all'],
  tierByTab: { all: 'good', build: null, rent: null },
  isRecommended: false,
  isMonthlyChain: false,
  earningsMark: { mark: 'covered', bufferShortfallDays: null, lastEarningsDate: '2026-10-28' },
  greeksComplete: true,
};

/**
 * 一条腿 + 它的**带内归属**。
 *
 * 🚨 `bandTabs` 是本文件唯一的「服务端才知道」的量：它记「这条腿的期限段本该让它进哪些意图
 *    视角」。`tabs` 是被流动性门槛处置**之后**的成员，两者的差就是排除计数 ⇒ 计数不是填的，
 *    是**同一批数据算出来的**。填一个与 `tabs` 无关的数，SC-013 那条就验不到东西了。
 */
interface BandLeg {
  leg: LegResponse;
  bandTabs: readonly IntentTab[];
}

function bandLeg(
  over: Partial<LegResponse> & Pick<LegResponse, 'code'>,
  bandTabs: readonly IntentTab[],
): BandLeg {
  return { leg: { ...LEG_BASE, ...over }, bandTabs };
}

/** 该视角口径下用来排序的费率字段 —— 与真端点「按本视角口径的费率降序」同一条规则。 */
const RATE_FIELD = { weekly: 'weeklyRate', annualized: 'annualizedRate' } as const;

/**
 * 由一册 {@link BandLeg} 派生出完整的选约表响应。复杂度 `O(n log n)`（三个视角各排一次序）。
 *
 * 🚨 三处派生**都不许改成写死**（plan Testing Invariant 2）：
 *   · `tabOrder[t]` —— 成员集合与顺序都从数据来（写死会与 `leg.tabs` 矛盾且顺序判别性归零）；
 *   · `excludedFromIntentTabsByTab[t]` —— 「在带内却不在 `tabs` 里」的条数；
 *   · `excludedFromIntentTabs` —— **按腿去重**的标量 ⇒ 结构上恒有 `标量 ≤ build + rent`
 *     （一条两带都在的腿在标量里记 1 次、两个分视角数里各记 1 次，正是 050 保留的重叠区语义）。
 */
function makeTable(
  symbol: string,
  book: readonly BandLeg[],
  opts: {
    /** 被权利金门槛整条移出响应的腿 —— **蓄意不进 `legs`**，计数从这一册的长度派生。 */
    removedByPremiumFloor?: readonly LegResponse[];
    over?: Partial<LegTableResponse>;
  } = {},
): LegTableResponse {
  const legs = book.map((b) => b.leg);
  const basisByTab: LegTableResponse['basisByTab'] = {
    all: 'annualized',
    build: 'weekly',
    rent: 'annualized',
  };
  const orderFor = (tab: LegTab): string[] =>
    legs
      .filter((l) => l.tabs.includes(tab))
      .slice()
      .sort(
        (a, b) => Number(b[RATE_FIELD[basisByTab[tab]]]) - Number(a[RATE_FIELD[basisByTab[tab]]]),
      )
      .map((l) => l.code);
  const excludedIn = (tab: IntentTab): number =>
    book.filter((b) => b.bandTabs.includes(tab) && !b.leg.tabs.includes(tab)).length;

  return {
    symbol,
    state: 'available',
    asOf: TODAY,
    asOfFreshnessTier: 'CURRENT',
    quoteAsOf: `${TODAY}T20:15:00.000Z`,
    oiAsOf: TODAY,
    source: 'eod',
    spot: '82.40',
    w: '80.00',
    zone: 'buy',
    lLevel: 'L2',
    // 意图矩阵在 (买区, L2, 水位 ≥2/3) 下的输出 = 收租 · deep（server `classifyIntent`）——
    // 不是随手填的组合：水位已选 ⇒ 无「未选水位」那两条注明来干扰本文件的断言面。
    positionBucket: 'gte_two_thirds',
    positionBucketSource: 'manual',
    positionBucketSetAt: `${TODAY}T01:00:00.000Z`,
    intent: 'rent',
    rentDepth: 'deep',
    legs,
    tabOrder: { all: orderFor('all'), build: orderFor('build'), rent: orderFor('rent') },
    gateCounts: {
      removedByPremiumFloor: (opts.removedByPremiumFloor ?? []).length,
      excludedFromIntentTabs: book.filter((b) => b.bandTabs.some((t) => !b.leg.tabs.includes(t)))
        .length,
      excludedFromIntentTabsByTab: { build: excludedIn('build'), rent: excludedIn('rent') },
    },
    basisByTab,
    // 052 T011 契约增量：三视角恒有一份条件全景（消费归 T012）。
    criteriaByTab: emptyCriteriaByTab(),
    ...opts.over,
  };
}

const C1 = 'PEP261218P75000';
const C2 = 'PEP261218P72500';
const C3 = 'PEP261218P70000';
const C4 = 'PEP261218P67500';
const C5 = 'PEP261218P65000';

/**
 * 册 A —— 三视角读法差异的判别性数据。**载体序刻意不等于任何一个视角的渲染序**。
 *
 * | code | tabs | bandTabs | 年化 | 周化 | 档位（all / build / rent） |
 * | ---- | ---- | -------- | ---- | ---- | -------------------------- |
 * | C3 | all,build      | build      | .060 | .0250 | acceptable / acceptable / — |
 * | C1 | all,build,rent | build,rent | .090 | .0012 | good / **thin** / **good** |
 * | C5 | all            | rent       | .040 | .0008 | dead / — / — |
 * | C2 | all,rent       | rent       | .080 | .0016 | good / — / good |
 * | C4 | all            | build,rent | .050 | .0010 | thin / — / — |
 *
 * ⇒ 全腿序（年化降）= C1 C2 C3 C4 C5 ≠ 载体序；建仓序（周化降）= **C3 C1**，与全腿里那两条的
 *   相对位置**恰好相反** —— 拿载体序或拿全腿序去渲染建仓视角，两种错法都会红。
 * ⇒ 排除计数：建仓 1（C4）· 收租 2（C4 C5）· 标量 2（按腿去重）⇒ `2 ≤ 1 + 2` 成立。
 *   **建仓视角报 1 还是报 2，正是「按视角取数」与「用全表标量」两种实现的分水岭。**
 */
const BOOK_A: readonly BandLeg[] = [
  bandLeg(
    {
      code: C3,
      strike: '70.00',
      tabs: ['all', 'build'],
      tier: 'acceptable',
      tierByTab: { all: 'acceptable', build: 'acceptable', rent: null },
      annualizedRate: '0.060000',
      weeklyRate: '0.025000',
    },
    ['build'],
  ),
  // 🚨 SC-006 的那条腿：同一条腿在建仓视角判**薄**、在收租视角判**好**（口径不同，定义如此）。
  bandLeg(
    {
      code: C1,
      strike: '75.00',
      tabs: ['all', 'build', 'rent'],
      tier: 'good',
      tierByTab: { all: 'good', build: 'thin', rent: 'good' },
      annualizedRate: '0.090000',
      weeklyRate: '0.001200',
      isRecommended: true,
      isMonthlyChain: true,
    },
    ['build', 'rent'],
  ),
  bandLeg(
    {
      code: C5,
      strike: '65.00',
      tabs: ['all'],
      tier: 'dead',
      tierByTab: { all: 'dead', build: null, rent: null },
      annualizedRate: '0.040000',
      weeklyRate: '0.000800',
    },
    ['rent'],
  ),
  bandLeg(
    {
      code: C2,
      strike: '72.50',
      tabs: ['all', 'rent'],
      tier: 'good',
      tierByTab: { all: 'good', build: null, rent: 'good' },
      annualizedRate: '0.080000',
      weeklyRate: '0.001600',
    },
    ['rent'],
  ),
  bandLeg(
    {
      code: C4,
      strike: '67.50',
      tabs: ['all'],
      tier: 'thin',
      tierByTab: { all: 'thin', build: null, rent: null },
      annualizedRate: '0.050000',
      weeklyRate: '0.001000',
    },
    ['build', 'rent'],
  ),
];

/** 被权利金门槛整条移出响应的那条 —— 三个视角都看不到它，故它**不在** `BOOK_A` 里。 */
const PREMIUM_REMOVED: readonly LegResponse[] = [{ ...LEG_BASE, code: 'PEP261218P60000' }];

/**
 * 册 B —— **SC-013 的正面构造**：建仓排除数 0、收租排除数 3、全表标量 3。
 *
 * 三条腿都只在全腿视角（各自的收租带内却被流动性门槛挡下）⇒ 两个意图视角**都空**，但空的
 * 理由完全不同：收租是「有 3 条够格却被挡了」，建仓是「本来就一条都没有」。
 * 🚨 用全表标量实现空态的客户端会给建仓视角一个「有 3 条被挡了，去看看」的入口 —— 数字真实、
 *    句子通顺、指向的是收租视角的腿，**不会红**。这条 test 是它唯一的机械防线。
 */
const BOOK_B: readonly BandLeg[] = [C1, C2, C3].map((code, i) =>
  bandLeg(
    {
      code,
      tabs: ['all'],
      tier: 'thin',
      tierByTab: { all: 'thin', build: null, rent: null },
      annualizedRate: `0.0${5 - i}0000`,
    },
    ['rent'],
  ),
);

// ════════════════════════════════════════════════════════════════════════════
// hermetic mock（一份 canonical 状态，handler 是纯函数）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 🚨 `…/legs` 分支 MUST 排在 `underlyings/(.+)$` 之前 —— 后者的贪婪 `(.+)` 会把 `/legs`
 *    整段吃成 symbol（047 实撞过，症状是选约区块恒「未就绪」而锚卡正常）。
 */
async function installLegMock(page: Page, book: Record<string, LegTableResponse>): Promise<void> {
  const anchors = Object.keys(book).map((ticker, i) => makeAnchor(`anchor-${i + 1}`, ticker));

  await page.route(OPTIONSDESK_RE, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;
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
      const table = book[decodeURIComponent(legsMatch[1] ?? '')];
      return void (table ? await json(200, table) : await notFound());
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

test.setTimeout(180_000);

// ════════════════════════════════════════════════════════════════════════════
// 交互原语
// ════════════════════════════════════════════════════════════════════════════

const SYMBOL_A = 'us:PEP';
const SYMBOL_B = 'us:KO';

async function openDetail(page: Page, symbol: string): Promise<void> {
  await page.goto(`/optionsdesk/underlying/${encodeURIComponent(symbol)}`);
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible({ timeout: 90_000 });
}

async function selectTab(page: Page, tab: LegTab): Promise<void> {
  await page.getByTestId(`optionsdesk-detail-leg-tab-${tab}`).tap();
}

/**
 * 屏上**实际渲染出来的行序**（DOM 顺序 = 列表渲染顺序）。
 * 🚨 用 `data-testid` 前缀扫而不是逐个 code 查在不在 —— 「在不在」验不到顺序，而顺序正是 SC-001。
 */
function renderedCodes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const prefix = 'optionsdesk-detail-leg-row-';
    return Array.from(document.querySelectorAll(`[data-testid^="${prefix}"]`)).map((el) =>
      (el.getAttribute('data-testid') ?? '').slice(prefix.length),
    );
  });
}

/**
 * 表头整条文本 —— 费率列头**就是**该视角的口径本身（FR-017a），故断言走「含 / 不含」而不是
 * 按列序取第 N 个孩子：列序是版面实现细节，拿它当锚点会让「表头结构一改就假红」。
 * 📌 「年化」不是「折年参照」的子串 ⇒ 两个口径互为否定判据，判别性成立。
 */
async function headerText(page: Page): Promise<string> {
  return (await page.getByTestId('optionsdesk-detail-leg-header-scroller').textContent()) ?? '';
}

/** bid 格的档位着色（自比较，不硬编码色值 ⇒ 调色板改了也不会假红）。 */
function bidTone(page: Page, code: string): Promise<string> {
  return page
    .getByTestId(bidId(code))
    .evaluate((el) => `${getComputedStyle(el).backgroundColor}|${getComputedStyle(el).color}`);
}

/**
 * 切到某视角并**等版面落定**再往下断言。
 *
 * 🚨 两条都不能省：
 *   ① **落地视角不是「全腿」** —— 意图矩阵判出 `rent` 时默认停收租视角（047 FR-016），
 *      开屏后直接断言全腿的行集合会读到 2 行而不是 5 行（本文件首跑实撞）。
 *   ② 计数条**在加载态也渲染**（`total` 为 0）⇒ 它只能给「非空视角」当落定信号；
 *      空视角的等待锚点在各自 test 内取空态文案（见 SC-004 / SC-013 那条）。
 */
async function gotoTab(page: Page, tab: LegTab, expectedRows: number): Promise<void> {
  await selectTab(page, tab);
  await expectRowCount(page, expectedRows);
}

async function expectRowCount(page: Page, total: number): Promise<void> {
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(total));
}

const rowId = (code: string) => `optionsdesk-detail-leg-row-${code}`;
const actionId = (code: string) => `optionsdesk-detail-leg-action-${code}`;
const bidId = (code: string) => `optionsdesk-detail-leg-bid-${code}`;
const fitId = (code: string) => `optionsdesk-detail-leg-fit-${code}`;

const tableA = makeTable(SYMBOL_A, BOOK_A, { removedByPremiumFloor: PREMIUM_REMOVED });
const tableB = makeTable(SYMBOL_B, BOOK_B);

/** 从派生结果里读期望值 —— **不在 test 里手抄一份**（手抄的那份与 mock 漂移时两边都不会红）。 */
const ORDER_A = tableA.tabOrder;
const GATES_A = tableA.gateCounts;
const GATES_B = tableB.gateCounts;

// ════════════════════════════════════════════════════════════════════════════
// ① SC-001 —— 渲染序 = 服务端下发的 `tabOrder`，逐行相同且切换后不变
// ════════════════════════════════════════════════════════════════════════════

test('051 T011 — SC-001：三个视角的渲染序与 `tabOrder` **逐行相同**（且都不等于 `legs[]` 载体序），来回切不变', async ({
  page,
}) => {
  await installLegMock(page, { [SYMBOL_A]: tableA });
  await openDetail(page, SYMBOL_A);

  // ① 前提自检：派生出来的序**确实**与载体序不同 —— 否则本条 test 绿得毫无判别性
  //    （「按 tabOrder 渲染」与「按 legs[] 渲染」会给出同一张屏）。
  const carrier = tableA.legs.map((l) => l.code);
  expect(ORDER_A.all, '全腿序恰好等于载体序 —— 这份 fixture 已失去判别性，重配费率').not.toEqual(
    carrier,
  );
  expect(ORDER_A.build.length).toBeGreaterThan(1);

  await gotoTab(page, 'all', ORDER_A.all.length);
  expect(await renderedCodes(page)).toEqual(ORDER_A.all);

  await gotoTab(page, 'build', ORDER_A.build.length);
  // 🚨 建仓序与全腿序里那两条的相对位置相反 ⇒ 拿全腿序渲染建仓视角会红在这一行。
  expect(await renderedCodes(page)).toEqual(ORDER_A.build);

  await gotoTab(page, 'rent', ORDER_A.rent.length);
  expect(await renderedCodes(page)).toEqual(ORDER_A.rent);

  // ② 来回切：顺序恒定（切视角只换 `section.data`，不重排也不重算成员）。
  await gotoTab(page, 'all', ORDER_A.all.length);
  expect(await renderedCodes(page)).toEqual(ORDER_A.all);
  await gotoTab(page, 'build', ORDER_A.build.length);
  expect(await renderedCodes(page)).toEqual(ORDER_A.build);
});

// ════════════════════════════════════════════════════════════════════════════
// ② SC-006 —— 同一条腿两视角不同档 + 费率列头即口径
// ════════════════════════════════════════════════════════════════════════════

test('051 T011 — SC-006：同一条腿在建仓 / 收租视角显示**不同档位**，且费率列头就是该视角的口径本身（FR-017a）', async ({
  page,
}) => {
  await installLegMock(page, { [SYMBOL_A]: tableA });
  await openDetail(page, SYMBOL_A);

  // 全腿视角：年化口径，C1 判好档 ⇒ 动作「挂 OCO」。
  await gotoTab(page, 'all', ORDER_A.all.length);
  const allHeader = await headerText(page);
  expect(allHeader).toContain(COPY.rateBasisAnnualized);
  expect(allHeader).not.toContain(COPY.rateBasisWeekly);
  await expect(page.getByTestId(actionId(C1))).toHaveText(COPY.actionPlaceOco);
  const bidToneAll = await bidTone(page, C1);

  // 建仓视角：**周化**口径（列头连副标一起换），同一条 C1 判薄档 ⇒ 动作「暂不挂」。
  await gotoTab(page, 'build', ORDER_A.build.length);
  await expect(page.getByTestId(actionId(C1))).toHaveText(COPY.actionHold);
  const buildHeader = await headerText(page);
  expect(buildHeader).toContain(COPY.rateBasisWeekly);
  expect(buildHeader).toContain(COPY.rateBasisWeeklySub);
  expect(buildHeader, '建仓视角的列头还挂着年化 —— 口径没跟视角走').not.toContain(
    COPY.rateBasisAnnualized,
  );
  const bidToneBuild = await bidTone(page, C1);

  // 收租视角：年化口径，C1 又回到好档 —— 三处读数各自与服务端下发值相等，无一处回落到 legacy 标量。
  await gotoTab(page, 'rent', ORDER_A.rent.length);
  await expect(page.getByTestId(actionId(C1))).toHaveText(COPY.actionPlaceOco);
  expect(await headerText(page)).toContain(COPY.rateBasisAnnualized);

  // 🚨 着色也必须跟着变：只改动作文案而 bid 格颜色不变，等于「切视角时它不变色而别的列变了」。
  expect(bidToneBuild, '同一条腿在两个视角的 bid 格着色一致 —— 档位没跟视角走').not.toBe(
    bidToneAll,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ③ SC-005 —— 推荐标处处同值
// ════════════════════════════════════════════════════════════════════════════

test('051 T011 — SC-005：推荐标在其所属的**每个**视角同值（标随标的级意图，不随视角），月度链标同理', async ({
  page,
}) => {
  await installLegMock(page, { [SYMBOL_A]: tableA });
  await openDetail(page, SYMBOL_A);

  // C1 三个视角都在（`tabs` 含三者）且带标；C2 只在全腿 / 收租，恒不带标。
  for (const tab of TAB_KEYS) {
    await gotoTab(page, tab, ORDER_A[tab].length);
    await expect(page.getByTestId(rowId(C1)), `${COPY.tabs[tab]} 里 C1 不见了`).toBeVisible();
    await expect(
      page.getByTestId(fitId(C1)),
      `${COPY.tabs[tab]} 里推荐标不见了 —— 标随视角变了`,
    ).toHaveText(COPY.fitBadge);
    await expect(page.getByTestId(`optionsdesk-detail-leg-monthly-${C1}`)).toHaveText(
      COPY.monthlyBadge,
    );
    await expect(page.getByTestId(fitId(C2)), `${COPY.tabs[tab]} 里 C2 冒出了推荐标`).toHaveCount(
      0,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ④ SC-003 —— 流动性计数按视角取数，点击后落全腿视角并改口
// ════════════════════════════════════════════════════════════════════════════

test('051 T011 — SC-003：流动性计数**按视角取数**（不是全表标量），点击后落到全腿视角并改口收回入口', async ({
  page,
}) => {
  await installLegMock(page, { [SYMBOL_A]: tableA });
  await openDetail(page, SYMBOL_A);

  // ① 前提自检：分视角数与标量**确实不同** —— 相等的话本条只是在验一个巧合。
  expect(
    GATES_A.excludedFromIntentTabsByTab.build,
    '建仓排除数与全表标量相同 —— fixture 失去判别性',
  ).not.toBe(GATES_A.excludedFromIntentTabs);

  const gate = page.getByTestId('optionsdesk-detail-leg-gate-liquidity');
  const premium = page.getByTestId('optionsdesk-detail-leg-gate-premium_floor');

  // ② 建仓视角：报的是**这个视角自己的**数，且带入口（那些腿在全腿视角看得到）。
  await gotoTab(page, 'build', ORDER_A.build.length);
  await expect(gate).toHaveText(
    `${COPY.gateLiquidity(GATES_A.excludedFromIntentTabsByTab.build)}${COPY.gateLiquidityNoteIntent} ›`,
  );

  // ③ 权利金那条**恒无入口**（其腿整条移出响应，给入口只能是空承诺，FR-007a）。
  await expect(premium).toHaveText(
    `${COPY.gatePremiumFloor(GATES_A.removedByPremiumFloor)}${COPY.gatePremiumFloorNote}`,
  );
  await expect(
    page.locator('[data-testid="optionsdesk-detail-leg-gate-premium_floor"][role="button"]'),
    '权利金计数带了入口 —— 那些腿不在响应里，入口只能是空承诺',
  ).toHaveCount(0);

  // ④ 点计数 → 落到全腿视角：数改口为全表标量、措辞改口、入口收回（在这里它是死链）。
  await gate.tap();
  await expectRowCount(page, ORDER_A.all.length);
  expect(await renderedCodes(page)).toEqual(ORDER_A.all);
  await expect(gate).toHaveText(
    `${COPY.gateLiquidity(GATES_A.excludedFromIntentTabs)}${COPY.gateLiquidityNoteAll}`,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ SC-004 + SC-013 —— 两种空态互不相同，且不受另一个视角的排除数影响
// ════════════════════════════════════════════════════════════════════════════

test('051 T011 — SC-004 / SC-013：两种空态文案互不相同；建仓空态**不因收租的排除数**而改口（正面构造）', async ({
  page,
}) => {
  await installLegMock(page, { [SYMBOL_B]: tableB });
  await openDetail(page, SYMBOL_B);

  // ① 前提自检：这正是 SC-013 要的那份数据 —— 建仓 0、收租 > 0、标量 > 0。
  expect(GATES_B.excludedFromIntentTabsByTab.build).toBe(0);
  expect(GATES_B.excludedFromIntentTabsByTab.rent).toBeGreaterThan(0);
  expect(GATES_B.excludedFromIntentTabs).toBeGreaterThan(0);

  const empty = page.getByTestId('optionsdesk-detail-leg-empty');
  const cta = page.getByTestId('optionsdesk-detail-leg-empty-cta');

  // ② 收租视角：有够格却被挡下的腿 ⇒ 指向门槛 + 给入口。
  // 🚨 落定信号取**空态标题**而非计数条 —— 后者在加载态也渲染且恒「共 0 行」，拿它等空视角
  //    等于不等（本文件首跑在另一条 test 上实撞过加载态误读）。
  await selectTab(page, 'rent');
  await expect(empty).toContainText(COPY.emptyIntentTitle.rent);
  const rentText = await empty.textContent();
  expect(rentText).toContain(COPY.emptyBlockedByGate(GATES_B.excludedFromIntentTabsByTab.rent));
  await expect(cta).toHaveText(
    `${COPY.emptyBlockedCta(GATES_B.excludedFromIntentTabsByTab.rent)} ›`,
  );

  // ③ 🚨 建仓视角：它**自己的**排除数为 0 ⇒ 指向「确实没有」且**无入口** ——
  //    用全表标量的实现会在这里给出「有 3 条被挡了，去看看」，数字真实、句子通顺、指错视角。
  await selectTab(page, 'build');
  await expect(empty).toContainText(COPY.emptyIntentTitle.build);
  const buildText = await empty.textContent();
  expect(buildText).toContain(COPY.emptyNoneReason.build);
  expect(buildText).toContain(COPY.emptyNoneTail);
  expect(buildText, '建仓空态提到了收租视角的排除数').not.toContain(
    COPY.emptyBlockedCta(GATES_B.excludedFromIntentTabsByTab.rent),
  );
  await expect(cta, '建仓空态给了入口 —— 没有可去看的腿，这是空承诺').toHaveCount(0);

  // ④ SC-004：两种情形的文案**互不相同**（用户据此该做的事完全不同）。
  expect(buildText).not.toBe(rentText);
});
