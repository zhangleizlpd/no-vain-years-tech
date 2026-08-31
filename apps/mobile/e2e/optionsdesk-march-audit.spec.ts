import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  AnchorResponse,
  LegMarchStrikeResponse,
  LegResponse,
  LegTableResponse,
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

// 069 T009 — 每 K 审计弹层的 hermetic UI e2e（Playwright Expo Web；样板 =
// `optionsdesk-intraday-tiers.spec.ts` 的 mock 骨架）。
//
// 覆盖（逐条对应 tasks.md T009 六断言）：
//   ① 轻点收租行开弹层，逐档行数 = mock 审计条目数
//   ② 推荐态弹层含推荐 chip + 数值证据文本
//   ③ 无合格档呈现诚实空态（非错误组件、中性文案）
//   ④ 整梯无可成交**双成因判别**（OI 文案 vs 报价异常文案，clarify Q2）
//   ⑤ 建仓行轻点不开弹层（march=null ⇒ 无入口，FR-019）
//   ⑥ 表内可见性：收租行推荐章 + 劣档行灰显微标（US3-AS3）
//
// ── mock 纪律 ────────────────────────────────────────────────────────────────
//   march 只随 rent 视角下发（契约语义：实时开态 ∧ 收租视角），build/all 恒 null ——
//   ⑤ 的判据正是「无 march ⇒ 行上结构性无入口」，🚫 不许在 mock 里给 build 也发一份。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const BARS_RE = /\/api\/v1\/marketdata\/instruments\//;

const SEED_ACCOUNT_ID = 'acc-e2e-069';
const SEED_ACCESS_TOKEN = 'access-e2e-069';
const SEED_REFRESH_TOKEN = 'refresh-e2e-069';

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
        displayName: '小明',
        phone: '+8613900139069',
      },
      version: 0,
    }),
  );
`;

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(180_000);

function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
const TODAY = ymd(new Date());
const SESSION_DAY = ymd(new Date(Date.now() - 86_400_000));

// ════════════════════════════════════════════════════════════════════════════
// 屏内文案（`optionsdesk-copy.ts` march 段逐字；改文案就该在这里红）
// ════════════════════════════════════════════════════════════════════════════

const COPY = {
  recommendBadge: '荐',
  staleMark: '陈',
  verdictRecommended: '推荐档',
  verdictNoQualified: '无合格档',
  emptyNoQualified: '这一梯的前向费率未达到再投资线，暂无值得锁的期限',
  emptyUntradable: '这一梯当前没有可成交的档位，成因见逐档说明',
  phiReadout: '再投资线 φ 15.0%',
  evidenceFwdBelowPhi: '远期费率 6.0% < φ 15.0%',
  evidenceOiGate: '持仓 8 < 下限 50，全梯无过闸',
  evidenceCrossed: '报价交叉 买 3 ≥ 卖 2.9',
} as const;

// ════════════════════════════════════════════════════════════════════════════
// canonical 数据
// ════════════════════════════════════════════════════════════════════════════

const SYMBOL = 'us:MAR';

const ANCHOR: AnchorResponse = {
  id: 'anchor-1',
  ticker: SYMBOL,
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
  activity: { isRoundStrike: true, isTopRanked: false, label: 'round_strike' },
  isRecommended: false,
  isMonthlyChain: false,
  earningsMark: { mark: 'covered', bufferShortfallDays: null, lastEarningsDate: '2026-10-28' },
  greeksComplete: true,
  priceKind: 'realtime',
  bandStatus: 'in',
  wideSpreadOpportunity: false,
};

function leg(code: string, strike: string, over: Partial<LegResponse> = {}): LegResponse {
  return { ...LEG_BASE, code, strike, ...over };
}

const L1 = 'MAR261218P75000';
const L2 = 'MAR261218P72500';
const L3 = 'MAR261218P70000';
const L4 = 'MAR261218P67500';
const L5 = 'MAR261218P65000';

const LEGS: readonly LegResponse[] = [
  leg(L1, '75.00'),
  leg(L2, '72.50'),
  leg(L3, '70.00'),
  leg(L4, '67.50'),
  leg(L5, '65.00'),
];

const emptyEvidence = {
  bid: null,
  ask: null,
  fwd: null,
  fwdOut: null,
  premium: null,
  premiumShorter: null,
  chordDistanceTicks: null,
  phi: null,
  decay: null,
  decayCap: null,
  annualized: null,
  tierFloor: null,
  recommendedDteDays: null,
  oi: null,
  oiMin: null,
  absDelta: null,
  bandFloor: null,
} as const;

/** 五个 K 的行军判决（= server 的 march 契约镜像；仅 rent 视角下发）。 */
const MARCH: readonly LegMarchStrikeResponse[] = [
  {
    strike: '75.00',
    verdict: 'recommended',
    recommendedDteDays: 180,
    summary: { ladderCount: 3, netChainCount: 3, removedCount: 0, mergedCount: 0, markedCount: 0 },
    audits: [
      {
        dteDays: 45,
        mergedIntoDteDays: null,
        category: 'qualified_not_stop',
        evidence: { ...emptyEvidence, recommendedDteDays: 180 },
      },
      {
        dteDays: 90,
        mergedIntoDteDays: null,
        category: 'fwd_below_phi',
        evidence: { ...emptyEvidence, fwd: '0.060000', phi: '0.150000' },
      },
    ],
  },
  {
    strike: '72.50',
    verdict: 'no_qualified',
    recommendedDteDays: null,
    summary: { ladderCount: 1, netChainCount: 1, removedCount: 0, mergedCount: 0, markedCount: 0 },
    audits: [
      {
        dteDays: 180,
        mergedIntoDteDays: null,
        category: 'fwd_below_phi',
        evidence: { ...emptyEvidence, fwd: '0.100000', phi: '0.150000' },
      },
    ],
  },
  {
    strike: '70.00',
    verdict: 'untradable',
    recommendedDteDays: null,
    summary: { ladderCount: 1, netChainCount: 1, removedCount: 0, mergedCount: 0, markedCount: 0 },
    audits: [
      {
        dteDays: 180,
        mergedIntoDteDays: null,
        category: 'ladder_oi_all_below_min',
        evidence: { ...emptyEvidence, oi: 8, oiMin: 50 },
      },
    ],
  },
  {
    strike: '67.50',
    verdict: 'untradable',
    recommendedDteDays: null,
    summary: { ladderCount: 2, netChainCount: 0, removedCount: 2, mergedCount: 0, markedCount: 0 },
    audits: [
      {
        dteDays: 60,
        mergedIntoDteDays: null,
        category: 'crossed_quote',
        evidence: { ...emptyEvidence, bid: '3.0000', ask: '2.9000' },
      },
      {
        dteDays: 120,
        mergedIntoDteDays: null,
        category: 'crossed_quote',
        evidence: { ...emptyEvidence, bid: '5.0000', ask: '4.9000' },
      },
    ],
  },
  {
    strike: '65.00',
    verdict: 'no_qualified',
    recommendedDteDays: null,
    summary: { ladderCount: 1, netChainCount: 1, removedCount: 0, mergedCount: 0, markedCount: 1 },
    audits: [
      {
        dteDays: 180,
        mergedIntoDteDays: null,
        category: 'absolute_dominated',
        evidence: { ...emptyEvidence, premium: '1.1900', premiumShorter: '1.3500' },
      },
    ],
  },
];

/** 一份契约响应 —— march 只随 rent 下发（⑤ 的判据）。 */
function project(perspective: LegPerspective): LegTableResponse {
  return {
    symbol: SYMBOL,
    march: perspective === 'rent' ? [...MARCH] : null,
    // 070 契约增量: 模式标示与 march 同生共死 —— 有判决即有模式 (默认 phi 态, 呈现零噪音)。
    marchMode: perspective === 'rent' ? 'phi' : null,
    perspective,
    state: 'available',
    asOf: SESSION_DAY,
    asOfFreshnessTier: 'CURRENT',
    priceKind: 'realtime',
    realtimeDegrade: null,
    quoteAsOf: new Date().toISOString(),
    oiAsOf: SESSION_DAY,
    source: 'eod',
    spot: '82.40',
    w: '80.00',
    zone: 'buy',
    lLevel: 'L2',
    positionBucket: 'gte_two_thirds',
    positionBucketSource: 'manual',
    positionBucketSetAt: `${TODAY}T01:00:00.000Z`,
    intent: 'rent',
    rentDepth: 'deep',
    legs: [...LEGS],
    gateCounts: { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 },
    basis: BASIS_BY_PERSPECTIVE[perspective],
    criteria: emptyPerspectiveCriteria(),
    matchedCount: LEGS.length,
    memberCount: LEGS.length,
    displayLimit: null,
    candidateCapDropped: 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// hermetic mock
// ════════════════════════════════════════════════════════════════════════════

async function installMock(page: Page): Promise<void> {
  await page.route(OPTIONSDESK_RE, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });

    if (/\/optionsdesk\/underlyings\/(.+)\/legs$/.test(url.pathname)) {
      const perspective = perspectiveOf(url);
      if (perspective === null) return void (await json(400, PERSPECTIVE_REQUIRED_400));
      return void (await json(200, project(perspective)));
    }
    if (/\/optionsdesk\/underlyings\/(.+)$/.test(url.pathname)) {
      return void (await json(200, {
        symbol: SYMBOL,
        anchor: ANCHOR,
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

  await page.route(BARS_RE, async (route: Route) => {
    if (route.request().method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        symbol: SYMBOL,
        adjust: 'forward',
        period: 'day',
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
      phone: '+8613900139069',
      displayName: '小明',
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
  await installMock(page);
});

// ════════════════════════════════════════════════════════════════════════════
// 交互原语
// ════════════════════════════════════════════════════════════════════════════

async function openRentTable(page: Page): Promise<void> {
  await page.goto(`/optionsdesk/underlying/${encodeURIComponent(SYMBOL)}`);
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('optionsdesk-detail-leg-tab-rent').tap();
  await expect(page.getByTestId(`optionsdesk-detail-leg-row-${L1}`)).toBeVisible();
}

const sheet = (page: Page) => page.getByTestId('optionsdesk-march-audit-sheet');

async function openAudit(page: Page, code: string): Promise<void> {
  await page.getByTestId(`optionsdesk-detail-leg-row-${code}`).tap();
  await expect(sheet(page)).toBeVisible();
}

async function closeAudit(page: Page): Promise<void> {
  await page.getByTestId('optionsdesk-march-audit-backdrop').tap();
  await expect(sheet(page)).toHaveCount(0);
}

// ════════════════════════════════════════════════════════════════════════════
// 六断言
// ════════════════════════════════════════════════════════════════════════════

test('069 T009 ①② — 轻点收租行开弹层：逐档行数 = mock 审计条目数；推荐 chip + 数值证据 + φ 读数', async ({
  page,
}) => {
  await openRentTable(page);
  await openAudit(page, L1);

  // ① 行数 = '75.00' 的两条审计
  await expect(page.locator('[data-testid^="optionsdesk-march-audit-row-"]')).toHaveCount(2);
  // ② 推荐态: chip + 推荐档读数 + 数值证据文本 + φ 只读读数
  await expect(page.getByTestId('optionsdesk-march-audit-verdict')).toHaveText(
    COPY.verdictRecommended,
  );
  await expect(page.getByTestId('optionsdesk-march-audit-recommended')).toHaveText('180d');
  await expect(page.getByTestId('optionsdesk-march-audit-row-90')).toContainText(
    COPY.evidenceFwdBelowPhi,
  );
  await expect(page.getByTestId('optionsdesk-march-audit-phi')).toHaveText(COPY.phiReadout);
});

test('069 T009 ③ — 无合格档呈现诚实空态（中性文案，非错误组件），逐档停止原因照渲', async ({
  page,
}) => {
  await openRentTable(page);
  await openAudit(page, L2);

  await expect(page.getByTestId('optionsdesk-march-audit-verdict')).toHaveText(
    COPY.verdictNoQualified,
  );
  await expect(page.getByTestId('optionsdesk-march-audit-empty')).toHaveText(COPY.emptyNoQualified);
  // 逐档给出停止原因（US3-AS2: 首档 fwd 与 φ 的数值对比）
  await expect(page.getByTestId('optionsdesk-march-audit-row-180')).toContainText('远期费率');
});

test('069 T009 ④ — 整梯无可成交双成因判别：OI 文案 vs 报价异常文案（clarify Q2）', async ({
  page,
}) => {
  await openRentTable(page);

  // 成因 A: OI 不过闸
  await openAudit(page, L3);
  await expect(page.getByTestId('optionsdesk-march-audit-empty')).toHaveText(COPY.emptyUntradable);
  await expect(page.getByTestId('optionsdesk-march-audit-row-180')).toContainText(
    COPY.evidenceOiGate,
  );
  await closeAudit(page);

  // 成因 B: 全梯报价剔空 —— 同一判决、逐档文案可分
  await openAudit(page, L4);
  await expect(page.getByTestId('optionsdesk-march-audit-empty')).toHaveText(COPY.emptyUntradable);
  await expect(page.getByTestId('optionsdesk-march-audit-row-60')).toContainText(
    COPY.evidenceCrossed,
  );
  await expect(sheet(page)).not.toContainText('持仓');
});

test('069 T009 ⑤ — 建仓行轻点不开弹层（march=null ⇒ 结构性无入口，FR-019）', async ({ page }) => {
  await page.goto(`/optionsdesk/underlying/${encodeURIComponent(SYMBOL)}`);
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('optionsdesk-detail-leg-tab-build').tap();
  await expect(page.getByTestId(`optionsdesk-detail-leg-row-${L1}`)).toBeVisible();

  await page.getByTestId(`optionsdesk-detail-leg-row-${L1}`).tap();
  await expect(sheet(page)).toHaveCount(0);
});

test('069 T009 ⑥ — 表内可见性：收租行推荐章可见；劣档行灰显微标可见且行不消失（US3-AS3）', async ({
  page,
}) => {
  await openRentTable(page);

  await expect(page.getByTestId(`optionsdesk-detail-leg-march-${L1}`)).toHaveText(
    COPY.recommendBadge,
  );
  await expect(page.getByTestId(`optionsdesk-detail-leg-inferior-${L5}`)).toHaveText(
    COPY.staleMark,
  );
  // 只标不删: 劣档行照常在表内
  await expect(page.getByTestId(`optionsdesk-detail-leg-row-${L5}`)).toBeVisible();
  // 无劣标的行不长标
  await expect(page.getByTestId(`optionsdesk-detail-leg-inferior-${L2}`)).toHaveCount(0);
});
