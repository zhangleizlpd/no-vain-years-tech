import { expect, test, type Page, type Route } from './_support/fixtures';
import type {
  AnchorResponse,
  LegMarchStrikeResponse,
  LegResponse,
  LegTableResponse,
  LegTableResponseMarchMode,
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

// 070 T006 — 离线档收租阶梯的 hermetic UI e2e（Playwright Expo Web；骨架 =
// `optionsdesk-march-audit.spec.ts` 的 069 mock，差别只在**链级档位换成收盘档**）。
//
// 覆盖（逐条对应 tasks.md T006 五断言）：
//   ① 离线点亮 golden path：收租行推荐章 + 劣档微标可见，轻点开弹层
//   ② 弹层题头口径行「基于 {交易日} 收盘」可见（FR-003）
//   ③ marchMode=θ ⇒ 模式标示出现；默认 φ ⇒ 零新元素且 φ 读数原样（FR-009）
//   ④ 审计含 #1 条目 ⇒ 该行「叉」微标可见且行不消失（FR-004 只标不删）
//   ⑤ 意图空态 ⇒ 051 文案原样呈现，非错误组件（FR-010）
//
// ── mock 纪律 ────────────────────────────────────────────────────────────────
//   🚨 handler 是 (请求参数 × 本 test 的配置) → 响应的**纯函数**，🚫 零 callCount 分支。
//      模式 / 空态是**每个 test 自己装的一份 mock**（`installMock(page, config)`），不是同一份
//      mock 按调用次序变脸。
//   🚨 契约镜像：march 只随 `perspective=rent` 下发（us 锚 ∧ 收租，档位已退出门控，070 FR-001），
//      `marchMode` 与 march 同生共死；建仓 / 全腿恒 null。零候选时 server 仍给 `march: []`
//      （`marchBlock` 对空 pool 装配出空数组），🚫 不许在 mock 里写成 null 冒充「离线没点亮」。
//   🚨 链级 `priceKind: 'eod_close'` ∧ `quoteAsOf` = 交易日 `YYYY-MM-DD`（064「粒度即档位」）——
//      逐腿 `priceKind` 同为收盘 ⇒ 行级「收」标恒不出（整表收盘时逐行打标只是噪点）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const BARS_RE = /\/api\/v1\/marketdata\/instruments\//;

const SEED_ACCOUNT_ID = 'acc-e2e-070';
const SEED_ACCESS_TOKEN = 'access-e2e-070';
const SEED_REFRESH_TOKEN = 'refresh-e2e-070';

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
        phone: '+8613900139070',
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
/** 离线档的基准交易日 —— 口径行与档位条读的都是它。 */
const SESSION_DAY = ymd(new Date(Date.now() - 86_400_000));

// ════════════════════════════════════════════════════════════════════════════
// 屏内文案（`optionsdesk-copy.ts` 逐字；改文案就该在这里红）
// ════════════════════════════════════════════════════════════════════════════

const COPY = {
  recommendBadge: '荐',
  staleMark: '陈',
  crossedMark: '叉',
  verdictRecommended: '推荐档',
  basisEodClose: `基于 ${SESSION_DAY} 收盘`,
  phiReadout: '再投资线 φ 15.0%',
  modeTheta: '选档判据 · 自身年化最大',
  evidenceCrossed: '报价交叉 买 3 ≥ 卖 2.9',
  // 051 意图空态「规则内无腿」那一支（FR-010 核对结论 = 零改动，此处逐字守）
  emptyRentTitle: '收租视角暂无候选',
  emptyRentText: '这只票没有一条腿落在收租视角的期限段内。换一只票，或改看另一个视角。',
} as const;

// ════════════════════════════════════════════════════════════════════════════
// canonical 数据
// ════════════════════════════════════════════════════════════════════════════

const SYMBOL = 'us:OFF';

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
  lastCloseDate: SESSION_DAY,
  quoteFreshnessTier: 'CURRENT',
  spot: '88.00',
  priceKind: 'eod_close',
  spotAsOf: SESSION_DAY,
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
  // 🚨 离线档：逐腿与链级同为收盘 ⇒ 行级「收」标恒不出（064 FR-009）。
  priceKind: 'eod_close',
  bandStatus: 'in',
  wideSpreadOpportunity: false,
};

function leg(code: string, strike: string, over: Partial<LegResponse> = {}): LegResponse {
  return { ...LEG_BASE, code, strike, ...over };
}

const L1 = 'OFF261218P75000';
const L2 = 'OFF261218P72500';
const L3 = 'OFF261218P70000';

const LEGS: readonly LegResponse[] = [
  leg(L1, '75.00'),
  // 🚨 交叉报价腿**照常在行集合里**（070 FR-006 剔→标）—— 收盘口径下召回层保留它，
  //    行上以「叉」微标示意、净链除名由 #1 审计承担。
  leg(L2, '72.50', quoted('3.00', '2.90')),
  leg(L3, '70.00'),
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

/** 三个 K 的离线行军判决（= server march 契约镜像；审计 DTE 与各自行的 DTE 对齐才上行内微标）。 */
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
    // 交叉报价腿：#1 留痕 + 净链除名，行仍在表内（FR-006 成员不变）。
    strike: '72.50',
    verdict: 'untradable',
    recommendedDteDays: null,
    summary: { ladderCount: 1, netChainCount: 0, removedCount: 1, mergedCount: 0, markedCount: 1 },
    audits: [
      {
        dteDays: 180,
        mergedIntoDteDays: null,
        category: 'crossed_quote',
        evidence: { ...emptyEvidence, bid: '3.0000', ask: '2.9000' },
      },
    ],
  },
  {
    strike: '70.00',
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

/** 本次 test 要的那一份世界（🚫 不是调用序开关：一个 test 装一份，全程恒定）。 */
interface MockConfig {
  /** server 配置项的镜像；`march` 非 null 时恒有值（同生共死）。 */
  readonly marchMode: Exclude<LegTableResponseMarchMode, null>;
  /** true = 收租视角门槛后零候选（FR-010 空态面）。 */
  readonly emptyRent: boolean;
}

const DEFAULT_CONFIG: MockConfig = { marchMode: 'phi', emptyRent: false };

function project(perspective: LegPerspective, config: MockConfig): LegTableResponse {
  const isRent = perspective === 'rent';
  const legs = isRent && config.emptyRent ? [] : [...LEGS];
  return {
    symbol: SYMBOL,
    // us 锚 ∧ 收租 ⇒ 离线也点亮；零候选时是**空数组**不是 null（`marchBlock` 结构）。
    march: isRent ? (config.emptyRent ? [] : [...MARCH]) : null,
    marchMode: isRent ? config.marchMode : null,
    perspective,
    state: 'available',
    asOf: SESSION_DAY,
    asOfFreshnessTier: 'CURRENT',
    // ── 离线档三件套（链级） ──────────────────────────────────────────
    priceKind: 'eod_close',
    realtimeDegrade: null,
    quoteAsOf: SESSION_DAY,
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
    legs,
    // 🚨 空态走「本来就没有」那一支（excluded = 0）—— 070 剔→标不改这个数：交叉腿的
    //    相对价差为负、恒 ≤ 上界 ⇒ 它压根不会被点差闸计进来（`passesRelativeSpreadMax` 头注）。
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

async function installMock(page: Page, config: MockConfig = DEFAULT_CONFIG): Promise<void> {
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
      return void (await json(200, project(perspective, config)));
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
      phone: '+8613900139070',
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
});

// ════════════════════════════════════════════════════════════════════════════
// 交互原语
// ════════════════════════════════════════════════════════════════════════════

async function openRentTable(page: Page): Promise<void> {
  await page.goto(`/optionsdesk/underlying/${encodeURIComponent(SYMBOL)}`);
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('optionsdesk-detail-leg-tab-rent').tap();
}

const sheet = (page: Page) => page.getByTestId('optionsdesk-march-audit-sheet');

async function openAudit(page: Page, code: string): Promise<void> {
  await page.getByTestId(`optionsdesk-detail-leg-row-${code}`).tap();
  await expect(sheet(page)).toBeVisible();
}

// ════════════════════════════════════════════════════════════════════════════
// 五断言
// ════════════════════════════════════════════════════════════════════════════

test('070 T006 ① — 离线档收租点亮：推荐章 + 劣档微标可见，轻点开弹层（golden path）', async ({
  page,
}) => {
  await installMock(page);
  await openRentTable(page);
  await expect(page.getByTestId(`optionsdesk-detail-leg-row-${L1}`)).toBeVisible();

  // 收盘档下推荐章照亮 —— 这正是本片要修的「晚上看不到推荐」。
  await expect(page.getByTestId(`optionsdesk-detail-leg-march-${L1}`)).toHaveText(
    COPY.recommendBadge,
  );
  await expect(page.getByTestId(`optionsdesk-detail-leg-inferior-${L3}`)).toHaveText(
    COPY.staleMark,
  );
  // 无审计条目的行不长标（微标不是行级装饰）
  await expect(page.getByTestId(`optionsdesk-detail-leg-inferior-${L1}`)).toHaveCount(0);

  await openAudit(page, L1);
  await expect(page.getByTestId('optionsdesk-march-audit-verdict')).toHaveText(
    COPY.verdictRecommended,
  );
  await expect(page.getByTestId('optionsdesk-march-audit-recommended')).toHaveText('180d');
});

test('070 T006 ② — 弹层题头口径行「基于 {交易日} 收盘」可见（FR-003）', async ({ page }) => {
  await installMock(page);
  await openRentTable(page);
  await openAudit(page, L1);

  await expect(page.getByTestId('optionsdesk-march-audit-basis')).toHaveText(COPY.basisEodClose);
  // 🚨 口径行只写交易日：一个冒号都不许有（时分秒渗进来就是「昨收伪装成刚才」）。
  await expect(page.getByTestId('optionsdesk-march-audit-basis')).not.toContainText(':');
  // 口径在题头一次说清 ⇒ 逐档行**不加**昨收尾缀（FR-004）
  await expect(page.getByTestId('optionsdesk-march-audit-row-90')).not.toContainText('收盘');
});

test('070 T006 ③ — θ 模式呈被动标示；默认 φ 模式零新元素、φ 读数原样（FR-009）', async ({
  page,
}) => {
  await installMock(page, { marchMode: 'theta', emptyRent: false });
  await openRentTable(page);
  await openAudit(page, L1);

  await expect(page.getByTestId('optionsdesk-march-audit-mode')).toHaveText(COPY.modeTheta);
  // θ 下判据是年化 argmax ⇒ 再投资线读数收起（两行并存 = 静默混用两模式语义）
  await expect(page.getByTestId('optionsdesk-march-audit-phi')).toHaveCount(0);
  // 🚫 模式是 server 配置的被动标示 —— 弹层内 MUST NOT 出现任何切换入口
  await expect(sheet(page)).not.toContainText('切换');
});

test('070 T006 ③ 反面 — 默认 φ 配置：弹层零模式标示，φ 读数照渲（零噪音）', async ({ page }) => {
  await installMock(page);
  await openRentTable(page);
  await openAudit(page, L1);

  await expect(page.getByTestId('optionsdesk-march-audit-mode')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-march-audit-phi')).toHaveText(COPY.phiReadout);
});

test('070 T006 ④ — 审计含 #1 ⇒ 该行「叉」微标可见且行照常在表内（FR-004 只标不删）', async ({
  page,
}) => {
  await installMock(page);
  await openRentTable(page);
  await expect(page.getByTestId(`optionsdesk-detail-leg-row-${L2}`)).toBeVisible();

  await expect(page.getByTestId(`optionsdesk-detail-leg-inferior-${L2}`)).toHaveText(
    COPY.crossedMark,
  );
  // 弹层里同一条 #1 带数值证据 —— 行上一个字、弹层里一整句，两处同源
  await openAudit(page, L2);
  await expect(page.getByTestId('optionsdesk-march-audit-row-180')).toContainText(
    COPY.evidenceCrossed,
  );
});

test('070 T006 ⑤ — 离线档门槛后零候选：051 空态文案原样呈现，非错误组件（FR-010）', async ({
  page,
}) => {
  await installMock(page, { marchMode: 'phi', emptyRent: true });
  await openRentTable(page);

  const empty = page.getByTestId('optionsdesk-detail-leg-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText(COPY.emptyRentTitle);
  await expect(empty).toContainText(COPY.emptyRentText);
  // 「本来就没有」那一支不给入口（没有可去看的腿），也不是「你切没的」那一支
  await expect(page.getByTestId('optionsdesk-detail-leg-empty-cta')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-empty-reset')).toHaveCount(0);
  // 🚨 诚实空态不是错误：零错误语气词、无弹层可开
  await expect(empty).not.toContainText(/失败|错误|重试/);
  await expect(sheet(page)).toHaveCount(0);
  // 🚨 FR-010「口径标注昨收」的承载 = 档位条（它在区块头里，**不随空态消失**）——
  //    空态块本身不复述档位（同一句话第二处 = 两处必 drift）。
  await expect(page.getByTestId('optionsdesk-detail-leg-tier-stamp')).toHaveText(
    SESSION_DAY.slice(5),
  );
});
