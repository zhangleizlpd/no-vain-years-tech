import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  AnchorResponse,
  CriterionOutcomeResponse,
  LegResponse,
  LegTableResponse,
  PerspectiveCriteriaResponse,
  RetrievalCriteriaResponse,
} from '@nvy/api-client';

import { mockJson } from './_support/api-mock';
import { CRITERIA_UNBOUNDED, setCriteria } from './_support/optionsdesk-criteria';
import {
  BASIS_BY_PERSPECTIVE,
  PERSPECTIVE_REQUIRED_400,
  perspectiveOf,
  quoted,
} from './_support/optionsdesk-fixtures';

// 052 T013 — 检索条件抽屉的 hermetic UI e2e（Playwright Expo Web，Constitution §V 两层验证
// 之一；另一层是 T014 的契约冒烟）。样板 = `optionsdesk-leg-display.spec.ts`。
//
// 覆盖（逐条对应 spec US3 的 6 条 AS + 两条 Edge Case）：
//   ① AS1 —— 进入视图，六个控件已填**服务端下发的**默认值（`FR-011` / `SC-007`）
//   ② AS2 —— 改了值**不点搜**：结果一行不变，且**一个请求都不发**（`FR-012`）
//   ③ AS3 —— 点「搜」后按新值召回，且**仅被收窄**的那一维出计数（`FR-029` / `FR-030`）
//   ④ AS4 —— 点「复位」回默认值，计数与徽标同时消失（`FR-013`）
//   ⑤ AS5 —— 离开视图再进入回到默认值，且**任何 storage 里都找不到**用户值（`FR-014`）
//   ⑥ `FR-015` —— 每视角各自持有：在收租设的条件不跟着切到全腿，切回来仍在
//   ⑦ Edge Case —— 收紧到候选为空：空态**带复位入口**，与「本来就没有」一眼可分
//   ⑧ `FR-007` / `FR-010` —— 每视角控件集不同（建仓无行权价行 · 全腿无价差行）
//
// ── 🚨 mock 纪律：**契约镜像，不是调用序**（per mobile-impl-playbook §6）─────────────
//   handler 是 `(请求参数, canonical 腿册) → 响应` 的**纯函数**：同一组参数问几次答几次一样，
//   与「这是第几次请求」「测试跑到哪一步」无关。⇒ 判据（哪几条腿留下、每维的边际计数）在这里
//   **真的算一遍**，而不是按测试编排预先摆好两份答案。
//   🚫 反面写法（`callCount === 0 ? 默认表 : 收窄表`）在本文件所有断言下**照样全绿** ——
//      而客户端一旦多发一次请求（加个 `invalidateQueries` / refetch）就当场碎，且 typecheck
//      拦不住（形状对、时序错）。032 FU-1 撞过这条。
//
// ── 边际计数的口径与服务端同一条 ────────────────────────────────────────────────
//   「把这一维换回系统默认值、其余维保持用户值，能多看到几条」——本文件直接按定义算
//   （`recall(放宽该维).length − recall(生效值).length`），不是抄一个数。
//
// ── 053 T015：控件从 `TextInput` 改成**只读显示 + 自绘键盘** ────────────────────────
//   六个条件值不再是输入框（`.fill()` / `toHaveValue()` 对它们既点不着也读不出）——
//   改值走 {@link setCriteria}（选中框 → 退格清空 → 逐键录入），空值显示「不限」占位符
//   而不是空串。判据仍是本屏自己的 `sanitizeNumeric`（`~/ui` 的 `applyKey` 另有一套上限，
//   见 `leg-criteria-sheet.tsx` 里的裁定注释）。
//
// ── Expo Web 下**验不到**的（如实标注，不凑假断言）───────────────────────────────
//   · 抽屉是否**真的盖住了底部 Tab 栏**（RN `Modal` 渲 root 层那条）—— web 上 Modal 的层级由
//     DOM 决定，与 native 的 tab content 容器约束不是同一回事 ⇒ 归真机验收。
//   · 键盘（自绘）末行 `0/./⌫` 在真机上到不到得着 —— web 视口够高，塌缩型布局缺陷照样全绿
//     （`numeric-keypad.tsx` 文件头那条固定键高的由来）⇒ 归真机验收。
//   · ⓘ 浮层的热区 44×44 —— 量得到盒子，量不到手指；本文件只验 tap 开 / 再 tap 关。
//
// ── Expo web e2e 三坑（memory expo_web_e2e_and_router_footguns）────────────────
//   · `page.goBack()` 被嵌套 Stack 重映射 ⇒ 一律深链 `page.goto`。
//   · 叠屏 DOM 双命中 ⇒ 一律 `getByTestId` 精确定位。
//   · `symbol` 是 canonical `market:code`，路径段里冒号要转义（`us%3APEP`）。
//
// ── auth 范式 ────────────────────────────────────────────────────────────────
//   seed localStorage（含 accessToken）→ boot GET /me 必拦；**refresh-token 也必拦**。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const BARS_RE = /\/api\/v1\/marketdata\/instruments\//;

const SEED_ACCOUNT_ID = 'acc-e2e-052';
const SEED_ACCESS_TOKEN = 'access-e2e-052';
const SEED_REFRESH_TOKEN = 'refresh-e2e-052';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139052';

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

/** 窄视口（iPhone 量级）—— 抽屉是 bottom-sheet，宽屏下的版面不代表真机。 */
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
  sheetTitle: (perspective: string) => `检索条件 · ${perspective}`,
  tabs: { all: '全腿视角', build: '建仓视角', rent: '收租视角' },
  subDefault: '当前为系统默认值',
  subDirty: (n: number) => `已改 ${n} 项 · 未提交`,
  subApplied: (n: number) => `已改 ${n} 项`,
  countLine: (label: string, n: number) => `${label}之外还有 ${n} 条`,
  countLabelStrikeMax: '行权价上界',
  emptyTitle: '当前检索条件下没有候选',
  emptyResetCta: '复位到系统默认值',
  premiumTip: '门槛判的是 bid',
  /** 🚨 与空态 CTA「复位到系统默认值」是两个按钮 —— 按名数个数时 `exact` 必须开。 */
  reset: '复位',
  submit: '搜',
  percentSuffix: '%',
  /** 056 FR-034：**沿用** `countLabels.livenessMin`（「活跃度下限」）的既有叫法，不造新词。 */
  livenessGroupLabel: '活跃度',
  /** 056 FR-032：规则位只做这一行**只读**说明 —— 不是可切换的 AND/OR，也不是禁用态 segmented。 */
  livenessRule: '满足任一',
  rowTotal: (total: number) => `共 ${total} 行`,
  /**
   * 053 FR-016：区块头报的是**符合条件的总数**（`matchedCount`）。有覆盖生效时并列「全量」
   * （`memberCount` = 无覆盖口径下的候选数）—— 没有它，用户在表上看不到「我筛掉了多少」的基准。
   */
  rowTotalNarrowed: (matched: number, member: number) => `筛后 ${matched} · 全量 ${member}`,
} as const;

// ════════════════════════════════════════════════════════════════════════════
// canonical 状态（= 服务端 DB + 召回判据的镜像）
// ════════════════════════════════════════════════════════════════════════════

type LegTab = 'all' | 'build' | 'rent';

const CRITERION_KEYS = [
  'strikeMax',
  'strikeMin',
  'dteBand',
  'premiumMin',
  'livenessMin',
  'relativeSpreadMax',
] as const;
type CriterionKey = (typeof CRITERION_KEYS)[number];

/**
 * 三视角的**系统默认值**（形状与量级取自 server `defaultCriteria`）。
 *
 * 🚨 取值蓄意「不圆」（`137.7000` / `0.2384`）—— 客户端若自己算一份默认值，算出来的绝不会
 *    恰好是这两个数 ⇒ AS1 那条断言因此有判别性。圆整的 `0.25` 会让「读下发值」与「自算」
 *    两种实现给出同一屏。
 */
const DEFAULTS: Readonly<Record<LegTab, RetrievalCriteriaResponse>> = {
  all: {
    strikeMax: null,
    strikeMin: null,
    dteBand: null,
    premiumMin: '0.2384',
    livenessMin: { oi: 1, volume: 1 },
    relativeSpreadMax: null,
  },
  build: {
    strikeMax: null,
    strikeMin: null,
    dteBand: { min: 1, max: 49 },
    premiumMin: '0.2384',
    livenessMin: { oi: 1, volume: 1 },
    relativeSpreadMax: '0.3500',
  },
  rent: {
    strikeMax: '137.7000',
    strikeMin: null,
    dteBand: { min: 30, max: 365 },
    premiumMin: '0.2384',
    livenessMin: { oi: 1, volume: 1 },
    relativeSpreadMax: '0.3500',
  },
};

const ANCHOR: AnchorResponse = {
  id: 'anchor-052',
  ticker: 'us:PEP',
  v: '160.00',
  vModel: '160.00',
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
  w: '128.00',
  zoneFloor: '96.00',
  zoneCeiling: '192.00',
  willingSellLongHold: '192.00',
  willingSellRent: '160.00',
  zone: 'buy',
  lastClose: '132.40',
  lastCloseDate: TODAY,
  quoteFreshnessTier: 'CURRENT',
  distanceToWPct: '3.4',
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

/**
 * 🚨 053 FR-005 起**每腿只有一份** `tier` / `activity`（收窄前是 `tierByTab` / `activityByTab`）——
 *    一次请求只作答一个视角。本文件的腿在三视角同档，故 `tier` 直接摆在基线上；
 *    报价四件套走 {@link quoted}（单笔权利金与相对价差是 bid/ask 的派生，手填第二份必漂移）。
 */
const LEG_BASE: Omit<
  LegResponse,
  'code' | 'strike' | 'dteDays' | 'bid' | 'ask' | 'contractPremium' | 'relativeSpread'
> = {
  expiryDate: '2026-12-18',
  bidSize: 25,
  askSize: 26,
  basis: 'annualized',
  periodRate: '0.047486',
  weeklyRate: '0.001846',
  annualizedRate: '0.096291',
  tier: 'good',
  askRate: null,
  effectiveCost: '128.00',
  effectiveCostVsWPct: '-3.30',
  absDelta: 0.22,
  sigmaDistance: 0.77,
  openInterest: 400,
  volume: 5,
  turnover: '21420.00',
  activity: null,
  isRecommended: false,
  isMonthlyChain: false,
  earningsMark: { mark: 'covered', bufferShortfallDays: null, lastEarningsDate: '2026-10-28' },
  greeksComplete: true,
};

/**
 * 腿册 —— 行权价刻意跨过收租的成色上界（`137.70`），故**默认值下 K140 就进不来**。
 *
 * | code | strike | dte | bid / ask | 默认下进哪些视角 |
 * | ---- | ------ | --- | --------- | ---------------- |
 * | K120 | 120 | 40  | 1.20 / 1.30 | all · build · rent |
 * | K128 | 128 | 90  | 1.50 / 1.65 | all · rent |
 * | K132 | 132 | 120 | 1.80 / 2.00 | all · rent |
 * | K137 | 137 | 200 | 2.10 / 2.40 | all · rent |
 * | K140 | 140 | 300 | 2.50 / 2.90 | all（收租被成色上界挡下） |
 *
 * ⇒ 收租默认 4 行；把行权价上界收到 `128` ⇒ 剩 2 行、**边际计数 = 2**（换回默认值能多看 2 条）。
 * ⇒ 收到 `110` ⇒ 0 行（空态第三支）。
 */
const LEGS: readonly LegResponse[] = [
  { ...LEG_BASE, code: 'PEP261218P120', strike: '120.00', dteDays: 40, ...quoted('1.20', '1.30') },
  { ...LEG_BASE, code: 'PEP261218P128', strike: '128.00', dteDays: 90, ...quoted('1.50', '1.65') },
  { ...LEG_BASE, code: 'PEP261218P132', strike: '132.00', dteDays: 120, ...quoted('1.80', '2.00') },
  { ...LEG_BASE, code: 'PEP261218P137', strike: '137.00', dteDays: 200, ...quoted('2.10', '2.40') },
  { ...LEG_BASE, code: 'PEP261218P140', strike: '140.00', dteDays: 300, ...quoted('2.50', '2.90') },
];

const SYMBOL = 'us:PEP';

// ════════════════════════════════════════════════════════════════════════════
// 迷你召回 —— 与服务端**同一条**判据（六维逐个，`null` = 不限）
// ════════════════════════════════════════════════════════════════════════════

function passes(leg: LegResponse, c: RetrievalCriteriaResponse): boolean {
  const strike = Number(leg.strike);
  const bid = Number(leg.bid);
  const spread = (Number(leg.ask) - bid) / bid;
  if (c.strikeMax !== null && strike > Number(c.strikeMax)) return false;
  if (c.strikeMin !== null && strike < Number(c.strikeMin)) return false;
  if (c.dteBand !== null && (leg.dteDays < c.dteBand.min || leg.dteDays > c.dteBand.max)) {
    return false;
  }
  if (c.premiumMin !== null && bid < Number(c.premiumMin)) return false;
  // 活性是**一个维度、两个值**，两支是「或」：存量与流量任一成立即算活着。
  if (
    c.livenessMin !== null &&
    (leg.openInterest ?? 0) < c.livenessMin.oi &&
    (leg.volume ?? 0) < c.livenessMin.volume
  ) {
    return false;
  }
  if (c.relativeSpreadMax !== null && spread > Number(c.relativeSpreadMax)) return false;
  return true;
}

const recall = (c: RetrievalCriteriaResponse): LegResponse[] => LEGS.filter((l) => passes(l, c));

/**
 * 一个视角的条件全景。`overrides` 非空 = 该视角被用户覆盖过。
 *
 * 🚨 **三态与计数按定义现算**（边际口径：把这一维换回系统默认值、其余维保持用户值，能多看
 *    几条）—— 不是摆好的常量。摆常量的话，客户端把「放宽」也渲成计数时本文件照样绿。
 */
function perspectiveCriteria(
  tab: LegTab,
  overrides: Partial<RetrievalCriteriaResponse>,
): PerspectiveCriteriaResponse {
  const defaults = DEFAULTS[tab];
  const effective: RetrievalCriteriaResponse = { ...defaults, ...overrides };
  const keptCount = recall(effective).length;
  const outcomes = {} as Record<CriterionKey, CriterionOutcomeResponse>;
  for (const key of CRITERION_KEYS) {
    if (!(key in overrides)) {
      outcomes[key] = { state: 'default', excludedCount: 0 };
      continue;
    }
    const gain = recall({ ...effective, [key]: defaults[key] }).length - keptCount;
    outcomes[key] =
      gain > 0
        ? { state: 'narrowed', excludedCount: gain }
        : { state: 'widened', excludedCount: 0 };
  }
  return { defaults, effective, outcomes };
}

/** 查询串 → 该视角的覆盖值。**缺键 = 未覆盖，空串 = 覆盖为不限**（与契约逐字同构）。 */
function parseOverrides(params: URLSearchParams): Partial<RetrievalCriteriaResponse> {
  const over: Partial<RetrievalCriteriaResponse> = {};
  const decimal = (raw: string) => (raw === '' ? null : Number(raw).toFixed(4));
  for (const key of ['strikeMax', 'strikeMin', 'premiumMin', 'relativeSpreadMax'] as const) {
    const raw = params.get(key);
    if (raw !== null) over[key] = decimal(raw);
  }
  const dteMin = params.get('dteMin');
  const dteMax = params.get('dteMax');
  if (dteMin !== null && dteMax !== null) {
    over.dteBand =
      dteMin === '' || dteMax === '' ? null : { min: Number(dteMin), max: Number(dteMax) };
  }
  const oiMin = params.get('oiMin');
  const volMin = params.get('volMin');
  if (oiMin !== null && volMin !== null) {
    over.livenessMin =
      oiMin === '' || volMin === '' ? null : { oi: Number(oiMin), volume: Number(volMin) };
  }
  return over;
}

/**
 * 请求参数 → **该视角那一份**选约表。**纯函数** —— 同一组参数问几次答几次一样（契约镜像纪律）。
 *
 * 🚨 **053 FR-005 起一次请求只作答一个视角**：覆盖落在 `perspective` 那一个上，而另两个视角
 *    压根不在这份响应里 —— 它们各自是另一次请求（052 那三份并列的 `criteriaByTab` 随之退役）。
 *    ⇒ 「覆盖不串味到另一个视角」这条不再靠本响应里的另两格作证，而是靠另一次请求各带各的参数。
 */
function makeTable(params: URLSearchParams, perspective: LegTab): LegTableResponse {
  const criteria = perspectiveCriteria(perspective, parseOverrides(params));
  const legs = recall(criteria.effective);

  return {
    symbol: SYMBOL,
    // 053 FR-005：原样回显请求参数 —— 迟到的那一发靠它认领。
    perspective,
    state: 'available',
    asOf: TODAY,
    asOfFreshnessTier: 'CURRENT',
    quoteAsOf: `${TODAY}T20:15:00.000Z`,
    oiAsOf: TODAY,
    source: 'eod',
    spot: '132.40',
    w: '128.00',
    zone: 'buy',
    lLevel: 'L2',
    // (买区, L2, 水位 ≥2/3) ⇒ 意图 = 收租 ⇒ 落地视角是**收租**（047 FR-016），
    // 且水位已选 ⇒ 没有「未选水位」那两条注明来干扰断言面。
    positionBucket: 'gte_two_thirds',
    positionBucketSource: 'manual',
    positionBucketSetAt: `${TODAY}T01:00:00.000Z`,
    intent: 'rent',
    rentDepth: 'deep',
    legs,
    // 051 的两个门槛计数不是本片的断言面 —— 取 0（两数皆 0 ⇒ 计数区降权，收窄计数行照常在）。
    gateCounts: { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 },
    basis: BASIS_BY_PERSPECTIVE[perspective],
    criteria,
    // 🚨 两个数**都从判据现算**（053 FR-009）：`matchedCount` 用生效值、`memberCount` 用系统
    //    默认值跑同一条召回 —— 摆常量的话「筛后 N · 全量 M」那句话在收窄时也照样渲染得出来。
    matchedCount: legs.length,
    memberCount: recall(DEFAULTS[perspective]).length,
    // 本文件不验截断（归 T010）：不设阈值 ⇒ 零截断；候选上限亦未触及。
    displayLimit: null,
    candidateCapDropped: 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// hermetic mock
// ════════════════════════════════════════════════════════════════════════════

/** 本轮发到 `…/legs` 的查询串（含空串 = 无参数）—— 供「不点搜就不发请求」那条断言读。 */
type LegRequestLog = string[];

async function installMock(page: Page): Promise<LegRequestLog> {
  const log: LegRequestLog = [];

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

    // 🚨 `…/legs` 分支 MUST 排在 `underlyings/(.+)$` 之前 —— 后者的贪婪 `(.+)` 会把 `/legs`
    //    整段吃成 symbol（047 实撞过，症状是选约区块恒「未就绪」而锚卡正常）。
    if (/\/optionsdesk\/underlyings\/(.+)\/legs$/.test(url.pathname)) {
      log.push(url.search);
      // 🚨 053 FR-001：`perspective` 必填，缺参 / 非三值 → 400。
      //    🚫 MUST NOT 在这里默认一个视角 —— 那时腿数、名次、档位全都正常，只是答的不是问的
      //       那个视角，而屏幕上什么都不会红。
      const perspective = perspectiveOf(url);
      if (perspective === null) return void (await json(400, PERSPECTIVE_REQUIRED_400));
      return void (await json(200, makeTable(url.searchParams, perspective)));
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
        symbol: SYMBOL,
        adjust: 'forward',
        period: url.searchParams.get('period') ?? 'day',
        items: [],
        freshnessTier: 'UNAVAILABLE',
      }),
    });
  });

  return log;
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

const ENTRY = 'optionsdesk-detail-criteria-entry';
const BADGE = 'optionsdesk-detail-criteria-badge';
const SHEET = 'optionsdesk-detail-criteria-sheet';
const SUB = 'optionsdesk-detail-criteria-sub';
const SUBMIT = 'optionsdesk-detail-criteria-submit';
const RESET = 'optionsdesk-detail-criteria-reset';
const BACKDROP = 'optionsdesk-detail-criteria-backdrop';
const INFO = 'optionsdesk-detail-criteria-info';
const TIP = 'optionsdesk-detail-criteria-tip';
const EMPTY_RESET = 'optionsdesk-detail-leg-empty-reset';
const CARET = 'optionsdesk-detail-criteria-caret';
const RULE = 'optionsdesk-detail-criteria-liveness-rule';
/** 键盘右整列的操作区（`~/ui/numeric-keypad.tsx` 逐字）—— 「复位」自 056 T006 起住在这里面。 */
const KEYPAD_ACTIONS = 'numeric-keypad-actions';
const ROW_LABEL = 'optionsdesk-detail-criteria-row-label';
const STRIKE_INFO = 'optionsdesk-detail-criteria-strike-info';
const STRIKE_TIP = 'optionsdesk-detail-criteria-strike-tip';
const DIRTY_DOT = 'optionsdesk-detail-criteria-dirty-dot';
const input = (field: string) => `optionsdesk-detail-criteria-input-${field}`;
const block = (key: string) => `optionsdesk-detail-criteria-block-${key}`;
const countLine = (key: CriterionKey) => `optionsdesk-detail-leg-criteria-${key}`;

async function openDetail(page: Page): Promise<void> {
  await page.goto(`/optionsdesk/underlying/${encodeURIComponent(SYMBOL)}`);
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible({ timeout: 90_000 });
}

async function openSheet(page: Page): Promise<void> {
  await page.getByTestId(ENTRY).tap();
  await expect(page.getByTestId(SHEET)).toBeVisible();
}

async function selectTab(page: Page, tab: LegTab): Promise<void> {
  await page.getByTestId(`optionsdesk-detail-leg-tab-${tab}`).tap();
}

/** 屏上**实际渲染出来的**腿行（DOM 顺序 = 渲染顺序）。 */
function renderedCodes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const prefix = 'optionsdesk-detail-leg-row-';
    return Array.from(document.querySelectorAll(`[data-testid^="${prefix}"]`)).map((el) =>
      (el.getAttribute('data-testid') ?? '').slice(prefix.length),
    );
  });
}

/**
 * 区块头计数。
 *
 * 🚨 **053 起它报的是 `matchedCount` 而不是渲染出来的行数**（FR-016）—— 两者在截断之后不再
 *    相等，「已显示前 D 条」由非常驻区的截断计数承担（同一个数一屏两处，`SC-005` 明禁）。
 *    本文件不设截断阈值 ⇒ 两数恒相等，但期望值 MUST 从 `matchedCount` 那一侧取。
 * 📌 `member` 省略 = 未覆盖（`memberCount === matchedCount`）⇒ 单数形态；给了就是双数形态。
 */
async function expectRowCount(page: Page, matched: number, member?: number): Promise<void> {
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(
    member === undefined || member === matched
      ? COPY.rowTotal(matched)
      : COPY.rowTotalNarrowed(matched, member),
  );
}

/**
 * 一条请求串里除 `perspective` 之外的参数名。
 *
 * 🚨 **053 起 `perspective` 恒在每一条请求里**（FR-001 必填）⇒ 「有没有下发条件」不能再用
 *    「查询串是不是空的」来判。断言改看这一层：它对错峰 / 预取带来的**请求条数**免疫
 *    （那是 T010 的断言面），只钉住本文件真正要守的「条件维度有没有被下发」。
 */
function criteriaKeysIn(query: string): string[] {
  return [...new URLSearchParams(query).keys()].filter((key) => key !== 'perspective').sort();
}

/** 带了条件维度的请求（= 用户点过「搜」的那些）。 */
function criteriaRequests(log: LegRequestLog): string[] {
  return log.filter((query) => criteriaKeysIn(query).length > 0);
}

/** 期望值一律**从 fixture 派生**，不在 test 里手抄（手抄那份与 mock 漂移时两边都不会红）。 */
const RENT_DEFAULT_CODES = recall(DEFAULTS.rent).map((l) => l.code);
const RENT_NARROWED = { ...DEFAULTS.rent, strikeMax: '128.0000' };
const RENT_NARROWED_CODES = recall(RENT_NARROWED).map((l) => l.code);
const STRIKE_MARGINAL = RENT_DEFAULT_CODES.length - RENT_NARROWED_CODES.length;
const ALL_DEFAULT_CODES = recall(DEFAULTS.all).map((l) => l.code);

// ════════════════════════════════════════════════════════════════════════════
// ① AS1 —— 控件已填服务端下发的默认值
// ════════════════════════════════════════════════════════════════════════════

test('052 T013 — US3-AS1：进入视图打开抽屉，六个控件已填**服务端下发的**默认值（SC-007 客户端零处自算）', async ({
  page,
}) => {
  // 前提自检：默认值下收租确实少一条（K140 被成色上界挡下）——
  // 否则「按 effective 召回」与「不筛」给出同一屏，后面几条 test 全失去判别性。
  expect(RENT_DEFAULT_CODES.length).toBe(LEGS.length - 1);

  const log = await installMock(page);
  await openDetail(page);
  await expectRowCount(page, RENT_DEFAULT_CODES.length);

  // 首屏**不带任何条件参数** —— 系统默认值 MUST NOT 由客户端回传（回传就等于它先算了一份）。
  // 📌 053 起「不带条件」≠「查询串为空」：`perspective` 恒在（FR-001 必填）。
  expect(criteriaRequests(log)).toEqual([]);
  // 落地视角那一发确实打出去了（否则上面那条对着一个空 log 也成立）。
  expect(log).toContain('?perspective=rent');

  await openSheet(page);
  await expect(page.getByTestId(SHEET)).toContainText(COPY.sheetTitle(COPY.tabs.rent));
  await expect(page.getByTestId(SUB)).toHaveText(COPY.subDefault);

  // 🚨 判别性来自「不圆」的取值：客户端自己算一份默认值，算不出 `137.7` / `0.2384`。
  await expect(page.getByTestId(input('strikeMax'))).toHaveText('137.7');
  // 📌 权利金默认值有**四位小数** —— 它同时是「本屏不能改用 `~/ui` 的 `applyKey`」的判据
  //    （那份把小数位截到 2 位，这个值会打不回来）。
  await expect(page.getByTestId(input('premiumMin'))).toHaveText('0.2384');
  await expect(page.getByTestId(input('dteMin'))).toHaveText('30');
  await expect(page.getByTestId(input('dteMax'))).toHaveText('365');
  await expect(page.getByTestId(input('oiMin'))).toHaveText('1');
  await expect(page.getByTestId(input('volMin'))).toHaveText('1');
  // 相对价差是**无量纲比例**，控件按百分数显示（同屏其余四项是金额或张数）。
  await expect(page.getByTestId(input('relativeSpreadMax'))).toHaveText('35');
  // 「不限」= 占位符，🚫 不是 0 也不是 ∞（053 T015 起是只读显示，故读到的是占位符本身）。
  await expect(page.getByTestId(input('strikeMin'))).toHaveText(CRITERIA_UNBOUNDED);

  // 未覆盖 ⇒ 入口无徽标、计数区无收窄行。
  await expect(page.getByTestId(BADGE)).toHaveCount(0);
  await expect(page.getByTestId(countLine('strikeMax'))).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ② AS2 —— 改了值不点搜：结果一行不变，且一个请求都不发
// ════════════════════════════════════════════════════════════════════════════

test('052 T013 — US3-AS2：改了值**不点搜**⇒ 结果逐行不变、零请求（FR-012 明禁输入停顿自动生效）', async ({
  page,
}) => {
  const log = await installMock(page);
  await openDetail(page);
  await openSheet(page);

  await setCriteria(page, 'strikeMax', '128');
  await expect(page.getByTestId(SUB)).toHaveText(COPY.subDirty(1));

  // 关掉抽屉（未提交）—— 结果面 MUST 一行不变。
  await page.getByTestId(BACKDROP).tap();
  await expect(page.getByTestId(SHEET)).toHaveCount(0);

  expect(await renderedCodes(page)).toEqual(RENT_DEFAULT_CODES);
  await expect(page.getByTestId(countLine('strikeMax'))).toHaveCount(0);
  // 🚨 最硬的那条：**一条带条件的请求都没发**。防抖式实现会在这里多出一条带 `strikeMax` 的
  //    查询串。📌 053 起判据从「log 恒等于 ['']」改成「零条带条件的请求」—— 错峰预取会往 log 里
  //    加 `?perspective=build` 之类的条目，那是 T010 的断言面，本条不该被它牵动。
  expect(criteriaRequests(log)).toEqual([]);

  // 未提交的草稿在关掉后丢弃 —— 没点「搜」就等于没提交（重开回默认值）。
  await openSheet(page);
  await expect(page.getByTestId(input('strikeMax'))).toHaveText('137.7');
});

// ════════════════════════════════════════════════════════════════════════════
// ③ AS3 —— 点「搜」按新值召回 + 仅收窄维度出计数
// ════════════════════════════════════════════════════════════════════════════

test('052 T013 — US3-AS3：点「搜」后按新值召回，**仅被收窄的那一维**出计数（FR-029 / FR-030）', async ({
  page,
}) => {
  // 前提自检：这一刀确实切掉了腿，否则「出不出计数」验不到东西。
  expect(STRIKE_MARGINAL).toBeGreaterThan(0);

  const log = await installMock(page);
  await openDetail(page);
  await openSheet(page);

  await setCriteria(page, 'strikeMax', '128');
  await page.getByTestId(SUBMIT).tap();

  // 提交即收起（结果在抽屉底下，盖着看不见）。
  await expect(page.getByTestId(SHEET)).toHaveCount(0);
  await expectRowCount(page, RENT_NARROWED_CODES.length, RENT_DEFAULT_CODES.length);
  expect(await renderedCodes(page)).toEqual(RENT_NARROWED_CODES);

  // 🚨 措辞是「当前条件之外还有 N 条」，🚫 不是「被系统滤掉」。
  const line = page.getByTestId(countLine('strikeMax'));
  await expect(line).toHaveText(
    new RegExp(COPY.countLine(COPY.countLabelStrikeMax, STRIKE_MARGINAL)),
  );
  // 🚫 没动过的五维**一条计数都不出**（默认值本身就摆在控件里，第二次告知是噪音）。
  for (const key of CRITERION_KEYS) {
    if (key !== 'strikeMax') await expect(page.getByTestId(countLine(key))).toHaveCount(0);
  }
  // 入口徽标数的是**已覆盖维度数**（1），不是被排除的条数。
  await expect(page.getByTestId(BADGE)).toHaveText('1');

  // 请求里只带改过的那一维 + 视角，MUST NOT 回传其余五维的默认值。
  // 📌 053 起用「带条件的那些请求」定位而不是 `log[1]` —— 错峰预取会往 log 里插入其余视角的
  //    无条件请求，而它们的条数与次序归 T010 断。
  const withCriteria = criteriaRequests(log);
  expect(withCriteria).toHaveLength(1);
  const sent = new URLSearchParams(withCriteria[0] ?? '');
  expect(sent.get('perspective')).toBe('rent');
  expect(sent.get('strikeMax')).toBe('128');
  expect([...sent.keys()].sort()).toEqual(['perspective', 'strikeMax']);

  // 重开抽屉：已提交的值回填（不是又跳回默认值），副标题转「已改 1 项」且不带「未提交」。
  await openSheet(page);
  await expect(page.getByTestId(input('strikeMax'))).toHaveText('128');
  await expect(page.getByTestId(SUB)).toHaveText(COPY.subApplied(1));
});

// ════════════════════════════════════════════════════════════════════════════
// ④ AS4 —— 「复位」回默认值，计数与徽标同时消失
// ════════════════════════════════════════════════════════════════════════════

test('052 T013 — US3-AS4：点「复位」⇒ 回系统默认值并重召回，计数行与徽标同时消失（FR-013）', async ({
  page,
}) => {
  const log = await installMock(page);
  await openDetail(page);
  await openSheet(page);
  await setCriteria(page, 'strikeMax', '128');
  await page.getByTestId(SUBMIT).tap();
  await expectRowCount(page, RENT_NARROWED_CODES.length, RENT_DEFAULT_CODES.length);

  await openSheet(page);
  await page.getByTestId(RESET).tap();

  await expect(page.getByTestId(SHEET)).toHaveCount(0);
  await expectRowCount(page, RENT_DEFAULT_CODES.length);
  expect(await renderedCodes(page)).toEqual(RENT_DEFAULT_CODES);
  await expect(page.getByTestId(countLine('strikeMax'))).toHaveCount(0);
  await expect(page.getByTestId(BADGE)).toHaveCount(0);

  // 🚨 「复位」= 退回**无参数**那把 query key，MUST NOT 带一份默认值回去（那等于客户端先算了
  //    一份）。⇒ 全程带参数的请求**有且只有**用户那一维的那一条。
  // 📌 复位后**不再发请求**是正确行为、也是这条断言的形状依据：无参数那把 key 开屏就取过，
  //    仍在 `staleTime` 内 ⇒ 直接命中缓存。「没发请求」本身就说明它退回的是同一把 key。
  expect(criteriaRequests(log)).toEqual(['?perspective=rent&strikeMax=128']);

  await openSheet(page);
  await expect(page.getByTestId(input('strikeMax'))).toHaveText('137.7');
  await expect(page.getByTestId(SUB)).toHaveText(COPY.subDefault);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ AS5 —— 离开再进回默认值，且 storage 里找不到用户值
// ════════════════════════════════════════════════════════════════════════════

test('052 T013 — US3-AS5：离开视图再进入回到默认值，且**任何 storage 里都没有**用户值（FR-014 不持久化）', async ({
  page,
}) => {
  const log = await installMock(page);
  await openDetail(page);
  await openSheet(page);
  await setCriteria(page, 'strikeMax', '128');
  await page.getByTestId(SUBMIT).tap();
  await expectRowCount(page, RENT_NARROWED_CODES.length, RENT_DEFAULT_CODES.length);

  // 🚨 **结构判据先行**：重进那条是深链（= 整页重载，per e2e 三坑「不驱 goBack」），它自己
  //    对「有没有落 storage」是**平凡绿** —— 重载什么都会清。故先直接扫 storage：用户值
  //    落进去了的话，这一条当场红，而重进那条照样绿。
  const persisted = await page.evaluate(() => {
    const dump = (s: Storage) =>
      Array.from({ length: s.length }, (_, i) => s.key(i) ?? '')
        .map((k) => `${k}=${s.getItem(k) ?? ''}`)
        .join('\n');
    return `${dump(window.localStorage)}\n${dump(window.sessionStorage)}`;
  });
  expect(persisted).not.toContain('128');
  expect(persisted).not.toContain('strikeMax');

  // 行为面：重新进入 ⇒ 默认值那张表，且重进之后发出去的请求**一条都不带条件**。
  const beforeReenter = log.length;
  await openDetail(page);
  await expectRowCount(page, RENT_DEFAULT_CODES.length);
  await expect(page.getByTestId(countLine('strikeMax'))).toHaveCount(0);
  expect(criteriaRequests(log.slice(beforeReenter))).toEqual([]);

  await openSheet(page);
  await expect(page.getByTestId(input('strikeMax'))).toHaveText('137.7');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ FR-015 —— 每视角各自持有条件状态
// ════════════════════════════════════════════════════════════════════════════

test('052 T013 — FR-015：在收租设的条件**不跟着**切到全腿，切回收租时仍在（各自留存）', async ({
  page,
}) => {
  const log = await installMock(page);
  await openDetail(page);
  await openSheet(page);
  await setCriteria(page, 'strikeMax', '128');
  await page.getByTestId(SUBMIT).tap();
  await expectRowCount(page, RENT_NARROWED_CODES.length, RENT_DEFAULT_CODES.length);

  // 切到全腿：它有自己的一份状态（未覆盖）⇒ 行数是全腿默认值那份，计数与徽标都不在。
  await selectTab(page, 'all');
  await expectRowCount(page, ALL_DEFAULT_CODES.length);
  await expect(page.getByTestId(countLine('strikeMax'))).toHaveCount(0);
  await expect(page.getByTestId(BADGE)).toHaveCount(0);
  // 🚫 收租的 `128` MUST NOT 出现在全腿的控件里。
  await openSheet(page);
  await expect(page.getByTestId(input('strikeMax'))).toHaveText(CRITERIA_UNBOUNDED);
  await page.getByTestId(BACKDROP).tap();

  // 切回收租：条件还在（既没被切走时清空，也没被全腿那次请求冲掉）。
  await selectTab(page, 'rent');
  await expectRowCount(page, RENT_NARROWED_CODES.length, RENT_DEFAULT_CODES.length);
  await expect(page.getByTestId(BADGE)).toHaveText('1');
  await expect(page.getByTestId(countLine('strikeMax'))).toBeVisible();

  // 🚨 视角在切换期间 MUST 稳住 —— 换 query key 那一拍若丢了 `intent`，解析出的视角会退回
  //    全腿再弹回来，表现就是这里的行数在两个值之间来回跳（T012 的 `keepPreviousData`）。
  expect(await renderedCodes(page)).toEqual(RENT_NARROWED_CODES);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ Edge Case —— 收紧到候选为空：空态带复位入口
// ════════════════════════════════════════════════════════════════════════════

test('052 T013 — Edge Case：收紧到候选为空 ⇒ 空态**带复位入口**，点它回到默认值那张表', async ({
  page,
}) => {
  // 前提自检：这一刀确实切到 0 条（否则走的是别的空态分支）。
  expect(recall({ ...DEFAULTS.rent, strikeMax: '110.0000' })).toHaveLength(0);

  await installMock(page);
  await openDetail(page);
  await openSheet(page);
  await setCriteria(page, 'strikeMax', '110');
  await page.getByTestId(SUBMIT).tap();

  await expectRowCount(page, 0, RENT_DEFAULT_CODES.length);
  // 🚨 与「这只票本来就没有」一眼可分：标题指向**条件**，入口是**复位**而不是换视角。
  await expect(page.getByTestId('optionsdesk-detail-leg-empty')).toContainText(COPY.emptyTitle);
  await expect(page.getByTestId(EMPTY_RESET)).toContainText(COPY.emptyResetCta);
  await expect(page.getByTestId('optionsdesk-detail-leg-empty-cta')).toHaveCount(0);

  await page.getByTestId(EMPTY_RESET).tap();
  await expectRowCount(page, RENT_DEFAULT_CODES.length);
  await expect(page.getByTestId(BADGE)).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑧ 056 FR-012 —— 三视角**同一份行集**（supersede 052 FR-007 / FR-010）
// ════════════════════════════════════════════════════════════════════════════

/** 抽屉里的八个框 —— 056 起**三视角逐个都在**（`SC-011` 的可验证形态）。 */
const ALL_FIELDS = [
  'strikeMin',
  'strikeMax',
  'dteMin',
  'dteMax',
  'premiumMin',
  'oiMin',
  'volMin',
  'relativeSpreadMax',
] as const;

test('056 T002 — FR-012：三视角行集**一致**，八个框逐视角都在；默认为空的维度呈「不限」而不是整行消失', async ({
  page,
}) => {
  await installMock(page);
  await openDetail(page);

  // 🚨 本条 **supersede** 052 的 FR-007（建仓无行权价行）与 FR-010（全腿无价差行）。
  //    正当性是**行为惰性**：那两行的默认值本来就是 `null`（服务端各维守卫一律 `!== null`
  //    ⇒ 判据不生效）—— 露出旋钮不改变任一视角的默认候选集，只是让用户能表达它。
  //    ⇒ 判据落在「框在不在 + 默认呈什么」，🚫 MUST NOT 退回按 tab 数框。
  for (const tab of ['all', 'build', 'rent'] as const) {
    await selectTab(page, tab);
    await openSheet(page);
    await expect(page.getByTestId(SHEET)).toContainText(COPY.sheetTitle(COPY.tabs[tab]));
    for (const field of ALL_FIELDS) {
      await expect(page.getByTestId(input(field))).toHaveCount(1);
    }
    await page.getByTestId(BACKDROP).tap();
    await expect(page.getByTestId(SHEET)).toHaveCount(0);
  }

  // 建仓：新露出的行权价两个框呈「不限」——🚫 MUST NOT 预填一个值（那会静默改掉候选集）。
  await selectTab(page, 'build');
  await openSheet(page);
  await expect(page.getByTestId(input('strikeMin'))).toHaveText(CRITERIA_UNBOUNDED);
  await expect(page.getByTestId(input('strikeMax'))).toHaveText(CRITERIA_UNBOUNDED);
  // 本视角原有的两维照常回填服务端下发值（新露出的行没把它们挤掉）。
  await expect(page.getByTestId(input('relativeSpreadMax'))).toHaveText('35');
  await expect(page.getByTestId(input('dteMin'))).toHaveText('1');
  await page.getByTestId(BACKDROP).tap();

  // 全腿：新露出的价差框默认「不限」（FR-017 —— 051 那个「点排除数切过来看被排除的腿」
  // 的入口在**默认态**下因此不受影响）；行权价与期限段也照常是空框。
  await selectTab(page, 'all');
  await openSheet(page);
  await expect(page.getByTestId(input('relativeSpreadMax'))).toHaveText(CRITERIA_UNBOUNDED);
  await expect(page.getByTestId(input('strikeMax'))).toHaveText(CRITERIA_UNBOUNDED);
  await expect(page.getByTestId(input('dteMin'))).toHaveText(CRITERIA_UNBOUNDED);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑨ 值控件形态 —— 读成「可编辑的输入位」，但底下仍是只读 + 自绘键盘
// ════════════════════════════════════════════════════════════════════════════

/**
 * 一个框的形态读数。**取 computed style 而非 class 串** —— NativeWind 编译后 class 名不稳定，
 * 而形态判据（是不是下划线、两个通道有没有一起变）本来就该问渲染结果。
 */
async function inputShape(
  page: Page,
  field: string,
): Promise<{
  borderBottomWidth: string;
  borderTopWidth: string;
  borderBottomColor: string;
  backgroundColor: string;
  textAlign: string;
}> {
  return page.getByTestId(input(field)).evaluate((el) => {
    const box = getComputedStyle(el);
    // 值是 Pressable 里那个 Text —— 对齐读它，别读容器（容器的 textAlign 不代表值的排布）。
    const valueEl = el.querySelector('div,span') ?? el;
    return {
      borderBottomWidth: box.borderBottomWidth,
      borderTopWidth: box.borderTopWidth,
      borderBottomColor: box.borderBottomColor,
      backgroundColor: box.backgroundColor,
      textAlign: getComputedStyle(valueEl).textAlign,
    };
  });
}

test('056 T004 — FR-001/FR-003：值框是下划线式输入位、值左对齐；选中态**双通道**（下划线 + 底色同时变）带 2px 光标；FR-002 全屏仍无 textbox', async ({
  page,
}) => {
  await installMock(page);
  await openDetail(page);
  // 视角显式钉死：本条断言「空值呈不限」，而 `strikeMin` 只在这几个视角下才是 null
  // （`rent` 的 `strikeMax` 有值，正好当同行对照项）。靠默认 tab 会让判据随默认值漂。
  await selectTab(page, 'rent');
  await openSheet(page);

  // 🚨 选中/未选中 **互相对照**，不硬编码色值 —— `react-native-web` 不渲染 `accessibilityState`
  //    (无 `aria-selected` 可断)，而写死 `rgb(...)` 会随 token 调整碎掉。
  //    对照对象取同一行的两个框，排除「行与行本来就长得不一样」这个混淆项。
  await page.getByTestId(input('strikeMin')).tap();
  const on = await inputShape(page, 'strikeMin');
  const off = await inputShape(page, 'strikeMax');

  // ① 形态：下划线，不是四边盒。两个态都要成立（选中不改变「它是个下划线」这件事）。
  for (const shape of [on, off]) {
    expect(shape.borderBottomWidth).toBe('2px');
    expect(shape.borderTopWidth).toBe('0px');
    // ② 值左对齐（原先是 text-center，读起来像标签不像输入位）。
    expect(shape.textAlign).toBe('left');
  }

  // ③ 双通道：下划线颜色**与**底色都必须变。任一相同即退化成单通道（FR-003 明禁只靠颜色）。
  expect(on.borderBottomColor).not.toBe(off.borderBottomColor);
  expect(on.backgroundColor).not.toBe(off.backgroundColor);

  // ④ 2px 光标只在选中的那个框里，且全屏恰一个（它是「落点在哪」的唯一视觉指认）。
  await expect(page.getByTestId(CARET)).toHaveCount(1);
  await expect(page.getByTestId(input('strikeMin')).getByTestId(CARET)).toHaveCount(1);
  await page.getByTestId(input('dteMin')).tap();
  await expect(page.getByTestId(input('strikeMin')).getByTestId(CARET)).toHaveCount(0);
  await expect(page.getByTestId(input('dteMin')).getByTestId(CARET)).toHaveCount(1);

  // ⑤ 🚨 FR-002 回归防线：全屏无 textbox ⇒ 系统键盘没有唤起路径。
  //    这条**有判别力、不是恒真** —— 真把值改回 `TextInput`，`react-native-web` 会渲染成
  //    `<input>`（隐式 textbox 角色），这里立刻红。它守的正是 053 T015 那次范式改造。
  await expect(page.getByRole('textbox')).toHaveCount(0);

  // ⑥ 空值仍是「不限」，🚫 不是 `0`（两者在契约里是两件事，屏幕上却只差一个字）。
  await expect(page.getByTestId(input('strikeMin'))).toHaveText(CRITERIA_UNBOUNDED);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑩ 版面 —— 四块、权利金与价差并行、活跃度是带框分组块
// ════════════════════════════════════════════════════════════════════════════

/** 屏上**实际渲染出来的**版面块（DOM 顺序 = 版面顺序）。 */
function renderedBlocks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const prefix = 'optionsdesk-detail-criteria-block-';
    return Array.from(document.querySelectorAll(`[data-testid^="${prefix}"]`)).map((el) =>
      (el.getAttribute('data-testid') ?? '').slice(prefix.length),
    );
  });
}

test('056 T005 — FR-010/FR-011/FR-030：版面是**四块**且序固定，权利金与价差并成一行，活跃度是带框分组块；块内两框仍只算**一维**（SC-012）', async ({
  page,
}) => {
  await installMock(page);
  await openDetail(page);
  await selectTab(page, 'rent');
  await openSheet(page);

  // ① 四块 + 顺序。🚨 版面序来自**表达层独立常量**，MUST NOT 由 `ROW_CRITERIA` 的键序代劳
  //    —— 后者是计数语义序，改它会连带改掉计数行的展示面（Guardrail 3）。
  expect(await renderedBlocks(page)).toEqual(['strike', 'dte', 'premiumSpread', 'liveness']);

  // ② 权利金与价差**同块**（FR-011 合并行、等分两半），不再各占一行。
  const merged = page.getByTestId(block('premiumSpread'));
  await expect(merged.getByTestId(input('premiumMin'))).toHaveCount(1);
  await expect(merged.getByTestId(input('relativeSpreadMax'))).toHaveCount(1);
  // 单位跟在值区右端（FR-013）；六维里只有价差带单位 ⇒ 它必在这一块内。
  await expect(merged).toContainText(COPY.percentSuffix);

  // ③ 活跃度分组块（FR-030）：分组标签 + 只读规则说明 + 两个框都在块内。
  const liveness = page.getByTestId(block('liveness'));
  await expect(liveness).toContainText(COPY.livenessGroupLabel);
  await expect(liveness).toContainText(COPY.livenessRule);
  await expect(liveness.getByTestId(input('oiMin'))).toHaveCount(1);
  await expect(liveness.getByTestId(input('volMin'))).toHaveCount(1);

  // ④ 🚨 规则位**只读**（FR-032）——「满足任一」既不可切换，也 MUST NOT 是一个点不动的
  //    禁用态 segmented（画出来等于承诺一个不存在的能力）。判据 = 槽内无任何可点元素。
  await expect(page.getByTestId(RULE).getByRole('button')).toHaveCount(0);

  // ⑤ FR-031：槽宽预留到容得下未来的规则选择器（所需 124）⇒ 将来升级只换槽内内容，
  //    块高与字段区版式不变。📌 真机读数在 T009 ⑥；这里守的是「槽没塌」这个结构面。
  const ruleWidth = await page.getByTestId(RULE).evaluate((el) => el.getBoundingClientRect().width);
  expect(ruleWidth).toBeGreaterThanOrEqual(124);

  // ⑥ FR-030 的否定半边：分组块接手表达后，夹在两框之间的「或」字 MUST 退场
  //    —— 邻近性暗示不够，这正是 GitLab DS / NN-g 的共识。
  await expect(liveness).not.toContainText('或');

  // ⑦ SC-012 / FR-033：块内改任一框，「已改」都只算**一维**；两框都改仍是一维。
  //    🚨 守的是「分了组就把两框拆成两维」—— 拆开会让同一条腿同时计进两行边际计数。
  await setCriteria(page, 'oiMin', '5');
  await expect(page.getByTestId(SUB)).toHaveText(COPY.subDirty(1));
  await expect(page.getByTestId(DIRTY_DOT)).toHaveCount(1);
  await setCriteria(page, 'volMin', '7');
  await expect(page.getByTestId(SUB)).toHaveText(COPY.subDirty(1));
  await expect(page.getByTestId(DIRTY_DOT)).toHaveCount(1);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑪ 操作区 —— 「复位」并入键盘右整列，同屏不出现两个同名按钮
// ════════════════════════════════════════════════════════════════════════════

test('056 T006 — FR-020/FR-024：「复位」并入键盘右整列、不再独占字段区一行；全屏「搜」与「复位」**各恰一个**（SC-009）', async ({
  page,
}) => {
  await installMock(page);
  await openDetail(page);
  await openSheet(page);

  // ① SC-009 / FR-024：同名按钮各恰一个。🚨 判据取 **a11y 名**而不是 testID —— 重复的
  //    按钮多半是「又画了一个」，那个新画的不会恰好带同一个 testID，按 testID 数会漏掉。
  //    `exact` 必须开：空态那个 CTA 叫「复位到系统默认值」，模糊匹配会把它算进来。
  await expect(page.getByLabel(COPY.reset, { exact: true })).toHaveCount(1);
  await expect(page.getByLabel(COPY.submit, { exact: true })).toHaveCount(1);

  // ② FR-020：那一个「复位」必须**在键盘的操作列内**，不是字段区里独占一行的那个。
  //    只数个数不够 —— 把字段区那行留着、改成不渲染键盘上的次级键，个数一样是 1。
  await expect(page.getByTestId(KEYPAD_ACTIONS).getByTestId(RESET)).toHaveCount(1);

  // ③ FR-021：右整列**复位在上、搜在下**（主操作贴近拇指，破坏性操作让开右下角）。
  const resetTop = await page.getByTestId(RESET).evaluate((el) => el.getBoundingClientRect().top);
  const submitTop = await page.getByTestId(SUBMIT).evaluate((el) => el.getBoundingClientRect().top);
  expect(resetTop).toBeLessThan(submitTop);

  // ④ 挪了位置，接线没断：键盘上这个「复位」点下去仍然触发 `onReset`（抽屉随之关闭）。
  //    📌 复位的**完整行为面**（回默认值 / 重召回 / 计数行与徽标同时消失 / 不带默认值回请求）
  //    由 US3-AS4 覆盖，这里只钉「按钮换了家还连着」，🚫 不重复造一遍那条。
  await setCriteria(page, 'strikeMax', '128');
  await expect(page.getByTestId(SUB)).toHaveText(COPY.subDirty(1));
  await page.getByTestId(RESET).tap();
  await expect(page.getByTestId(SHEET)).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑫ 行权价的硬门槛口径 ⓘ —— 只在建仓，且必须落在**行标签内**
// ════════════════════════════════════════════════════════════════════════════

test('056 T007 — FR-016/FR-016a：建仓的行权价行带硬门槛口径 ⓘ、tap 开再 tap 关；ⓘ 落在**定宽行标签内** ⇒ 该行值区右缘与其余行逐像素一致', async ({
  page,
}) => {
  await installMock(page);
  await openDetail(page);

  // ① 只在建仓（FR-016）—— 硬门槛 `K − bid < spot` 是建仓侧的判据，其余视角挂它是噪音。
  await selectTab(page, 'rent');
  await openSheet(page);
  await expect(page.getByTestId(STRIKE_INFO)).toHaveCount(0);
  await page.getByTestId(BACKDROP).tap();

  await selectTab(page, 'build');
  await openSheet(page);
  await expect(page.getByTestId(STRIKE_INFO)).toHaveCount(1);

  // ② 🚨 FR-016a：ⓘ 在**行标签内**。这不是观感偏好 —— 落值区右侧会让该行值区右缘短 32px
  //    （直接破 FR-010），落值区内部则把两个框各挤掉 15px。
  await expect(
    page.getByTestId(block('strike')).getByTestId(ROW_LABEL).getByTestId(STRIKE_INFO),
  ).toHaveCount(1);

  // ③ FR-010 的**结构保证**：行标签定宽 `flex: none` ⇒ 值区起点与宽度一个像素都不被碰
  //    ⇒ 带 ⓘ 那行的值区右缘与不带 ⓘ 的行**逐像素一致**（不是「量出来正好齐」）。
  const right = (field: string) =>
    page.getByTestId(input(field)).evaluate((el) => el.getBoundingClientRect().right);
  expect(await right('strikeMax')).toBeCloseTo(await right('dteMax'), 1);

  // ④ tap 开 / 再 tap 关（移动端没有 hover），形态沿用既有那个 ⓘ。
  await expect(page.getByTestId(STRIKE_TIP)).toHaveCount(0);
  await page.getByTestId(STRIKE_INFO).tap();
  await expect(page.getByTestId(STRIKE_TIP)).toBeVisible();
  await page.getByTestId(STRIKE_INFO).tap();
  await expect(page.getByTestId(STRIKE_TIP)).toHaveCount(0);

  // ⑤ 两个 ⓘ 各开各的：开权利金那个不会把行权价那个一起点亮（单一 boolean 会在这里红）。
  await page.getByTestId(INFO).tap();
  await expect(page.getByTestId(TIP)).toBeVisible();
  await expect(page.getByTestId(STRIKE_TIP)).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑬ ⓘ —— tap 触发的 popup tip（移动端没有 hover）
// ════════════════════════════════════════════════════════════════════════════

test('052 T013 — ⓘ 是 **tap 触发**的 popup tip：默认收起、tap 开、再 tap 关', async ({ page }) => {
  await installMock(page);
  await openDetail(page);
  await openSheet(page);

  await expect(page.getByTestId(TIP)).toHaveCount(0);
  await page.getByTestId(INFO).tap();
  await expect(page.getByTestId(TIP)).toContainText(COPY.premiumTip);
  await page.getByTestId(INFO).tap();
  await expect(page.getByTestId(TIP)).toHaveCount(0);
});
