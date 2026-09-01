import { expect, test, type Page, type Route } from './_support/fixtures';
import type {
  AnchorResponse,
  CriterionOutcomeResponse,
  LegResponse,
  LegTableResponse,
  LegTableResponseIntent,
  LegTableResponseRentDepth,
  PerspectiveCriteriaResponse,
  RetrievalCriteriaResponse,
  SetPositionBucketRequestPositionBucket,
} from '@nvy/api-client';

import { mockJson } from './_support/api-mock';
import { CRITERIA_UNBOUNDED, setCriteria } from './_support/optionsdesk-criteria';
import {
  BASIS_BY_PERSPECTIVE,
  PERSPECTIVE_REQUIRED_400,
  perspectiveOf,
  projectLegs,
  quoted,
  type CanonicalLeg,
  type LegPerspective,
} from './_support/optionsdesk-fixtures';

// 053 T010 — **查询下沉后的取数行为**的 hermetic UI e2e（Playwright Expo Web，Constitution §V
// 两层验证之一；另一层是 T011 的契约冒烟）。样板 = `optionsdesk-leg-display.spec.ts`。
//
// 覆盖（逐条对应 tasks.md T010 的 `state_branch` 清单）：
//   ① 19 / 21 —— 错峰时序（当前视角未落地时另两个**一个请求都不发**）+ 预取命中零加载态（SC-008）
//   ② 22 / 18 —— 预取未完成切过去降级为**正常加载态**；迟到的那一发 MUST NOT 覆盖已切走的视角
//   ③ 16 / 17 / 20 —— 单视角失败隔离 · 切过去显**自己的**错误态而非空态 · Tab 行零角标（SC-009）
//   ④ 13 / 14 —— 跨业务日**自动重取全部一次**，仍不一致给显式提示且**不再重取**（SC-010）
//   ⑤ 15 —— 停在**建仓**视角改水位 ⇒ 三视角**全部**失效重取（SC-013，最容易漏的那条路径）
//   ⑥ 5 的客户端一半 —— 截断计数的**出现与消失**（US1-AS1 / AS4 / SC-005）
//   ⑦ 23 —— 某视角的条件覆盖，切走再切回**仍是它自己那份**
//
// ── 🚨 mock 是**契约镜像不是调用序**（052 T013 立的纪律，本片沿用）──────────────────
//   handler 是 `(perspective + 六维参数, canonical 状态) → 一份响应` 的**纯函数**：同一组参数
//   问几次答几次一样，与「这是第几次请求」「测试跑到哪一步」无关。
//   🚫 反面写法（`callCount === 2 ? 失败 : 成功`）在本文件所有断言下**照样全绿** —— 而客户端
//      一旦多发 / 少发一次请求（错峰闸改了、失效 key 改了）就当场碎，且 typecheck 拦不住。
//   ⇒ 本文件里看起来需要「调用序」的四条，全部**表达成了请求参数的函数**：
//     · 单视角失败（16/17/20）→ handler 依 `perspective` 决定失败，与次数无关；
//     · 跨业务日（13/14）→ handler 依 `perspective` 返回不同 `asOf`，**恒**不一致 ⇒
//       「最多重取一次」反而被暴露成请求条数（无限重取 = 条数爆炸），比编排更强；
//     · 迟到响应（18）/ 错峰（19）→ 依 `perspective` 决定**延迟时长**，答案本身不变；
//     · 切视角保留条件（23）→ 条件就是 query 参数 ⇒ 不同条件天然是不同请求。
//   📌 唯一**真**可变的服务端状态是水位（`Chain.bucket`）—— 那是写端点改的 canonical 状态，
//      与 047 那份同范式，不是测试编排标志。
//
// ── 🚨 为什么另起一个文件而不是往 051 / 052 那两份里加 ──────────────────────────────
//   那两份验的是「一份响应怎么读」（显示口径 / 抽屉），断言面全在**单次请求已经到手之后**；
//   本片验的是**三次请求之间**的事：谁先发、谁失败了别人还在不在、迟到的那一发写不写得进来。
//   需要的 fixture 也不同 —— 这里的判别性载体是**延迟、失败面与业务日**，混进去会让那边每条
//   既有断言都要先问一句「这一拍三份 query 各自处在什么状态」。
//
// ── Expo Web 下**验不到**的（如实标注，不凑假断言）───────────────────────────────
//   · 视角切换与预热的**手感**（多少毫秒算「不等待」）—— web 视口与 Metro 静态包的时序不代表
//     真机，读数不能当结论 ⇒ 归 T013 真机验收。本文件只验**结构面**：有没有发请求、有没有加载态。
//   · 契约对齐（生成客户端 ↔ 真 server）—— 本文件的 mock 是**手写的契约镜像**，镜像写错了它
//     自己不会红 ⇒ 归 T011 契约冒烟。两层正交，缺一层就有一条缝没人合。
//   · Tab 行「纯图形」角标（无文本、无 testID 的那种）—— 本文件靠文本全等 + testID 扫描抓角标，
//     两者都抓不到一个纯 SVG 圆点 ⇒ 那一档同归真机验收。
//
// ── Expo web e2e 三坑（memory expo_web_e2e_and_router_footguns）────────────────
//   · `page.goBack()` 被嵌套 Stack 重映射 ⇒ 一律深链 `page.goto`。
//   · 叠屏 DOM 双命中 ⇒ 一律 `getByTestId` 精确定位。
//   · `symbol` 是 canonical `market:code`，路径段里冒号要转义（`us%3APEP`）。
//
// ── auth 范式 ────────────────────────────────────────────────────────────────
//   seed localStorage（含 accessToken）→ boot GET /me 必拦；**refresh-token 也必拦**，
//   否则任一 authed 401 触发 003 拦截器 retry-once 失败 → clearSession 误登出。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const BARS_RE = /\/api\/v1\/marketdata\/instruments\//;

const SEED_ACCOUNT_ID = 'acc-e2e-053';
const SEED_ACCESS_TOKEN = 'access-e2e-053';
const SEED_REFRESH_TOKEN = 'refresh-e2e-053';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139053';

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

/** 窄视口（iPhone 量级）—— 与 047/051 同前提：12 列共 716px，宽屏下右侧列压根不藏。 */
test.use({ viewport: { width: 390, height: 844 } });

function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const TODAY = ymd(new Date());
/** 跨交易日切换点的另一侧 —— `FR-020` 的构造手段（`SC-010`：MUST 可构造，不靠等真实切换点）。 */
const YESTERDAY = ymd(new Date(Date.now() - 24 * 60 * 60 * 1000));

// ════════════════════════════════════════════════════════════════════════════
// 屏内文案（`optionsdesk-copy.ts` 逐字；改文案就该在这里红）
// ════════════════════════════════════════════════════════════════════════════

const COPY = {
  tabs: { all: '全腿视角', build: '建仓视角', rent: '收租视角' },
  fitBadge: 'Δ带内',
  rowTotal: (total: number) => `共 ${total} 行`,
  rowTotalNarrowed: (matched: number, member: number) => `筛后 ${matched} · 全量 ${member}`,
  /** 截断计数第 3 条（`FR-016`）+ 指向抽屉的收窄指引（`FR-017`，两句是一整条）。 */
  truncated: (shown: number, hidden: number) =>
    `已显示前 ${shown} 条 · 其余 ${hidden} 条未显示 · 收窄「检索条件」可让其余的腿进来`,
  criteriaCountLine: (n: number) => `行权价上界之外还有 ${n} 条`,
  readFailed: '选约表读取失败',
  retry: '重试',
  asOfMismatch: '三个视角的数据时点不一致',
  asOfMismatchCta: '重新取三个视角',
} as const;

// ════════════════════════════════════════════════════════════════════════════
// canonical 数据（= 服务端 DB + 召回判据的镜像）
// ════════════════════════════════════════════════════════════════════════════

const SYMBOL = 'us:PEP';
const ANCHOR_ID = 'anchor-053';

const ANCHOR: AnchorResponse = {
  id: ANCHOR_ID,
  ticker: SYMBOL,
  // D13 标的名: 本片不涉及行首呈现 ⇒ 取「未注册」(null), 屏上退回代号 = 045 初版的样子。
  name: null,
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
  spot: '132.40',
  priceKind: 'eod_close',
  spotAsOf: TODAY,
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

const LEG_BASE: Omit<
  LegResponse,
  | 'code'
  | 'strike'
  | 'dteDays'
  | 'bid'
  | 'ask'
  | 'contractPremium'
  | 'relativeSpread'
  | 'annualizedRate'
  | 'weeklyRate'
> = {
  expiryDate: '2026-12-18',
  bidSize: 25,
  askSize: 26,
  basis: 'annualized',
  periodRate: '0.047486',
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
  // 064 `FR-009`: 档位。mock 后端默认收盘档, 实时档的呈现分支归 T011 自己的用例。
  priceKind: 'eod_close',
  bandStatus: null,
  wideSpreadOpportunity: false,
};

function makeLeg(over: {
  strike: number;
  dteDays: number;
  bid: string;
  ask: string;
  annualizedRate: string;
  weeklyRate: string;
  perspectives: readonly LegPerspective[];
}): CanonicalLeg {
  const { perspectives, strike, ...rest } = over;
  return {
    leg: {
      ...LEG_BASE,
      ...rest,
      code: `PEP261218P${String(strike * 1000).padStart(6, '0')}`,
      strike: strike.toFixed(2),
      ...quoted(over.bid, over.ask),
    },
    perspectives,
  };
}

/**
 * 跨视角腿册。**载体序刻意不等于任何一个视角的渲染序**（费率照着这条判别性配）——
 * 写死一份与数据无关的序，「按下发序渲染」与「按载体序渲染」会给出同一张屏。
 *
 * | 行权价 | 视角        | 年化  | 周化   |
 * | ------ | ----------- | ----- | ------ |
 * | 128    | all · rent  | .0800 | .0026  |
 * | 120    | all · build | .0600 | .0040  |
 * | 132    | all · rent  | .0900 | .0030  |
 * | 122    | all · rent  | .0650 | .0020  |
 * | 118    | all · build | .0550 | .0035  |
 * | 126    | all · rent  | .0750 | .0024  |
 * | 130    | all · rent  | .0850 | .0028  |
 * | 124    | all · rent  | .0700 | .0022  |
 *
 * ⇒ 全腿序（年化降）= 132 130 128 126 124 122 120 118；收租序取其前六；建仓序（**周化**降）
 *   = 120 118 —— 建仓那两条在全腿序里排在最后，拿全腿序渲染建仓视角会当场红。
 */
const BOOK: readonly CanonicalLeg[] = [
  makeLeg({
    strike: 128,
    dteDays: 60,
    bid: '1.90',
    ask: '2.10',
    annualizedRate: '0.080000',
    weeklyRate: '0.002600',
    perspectives: ['all', 'rent'],
  }),
  makeLeg({
    strike: 120,
    dteDays: 30,
    bid: '1.50',
    ask: '1.65',
    annualizedRate: '0.060000',
    weeklyRate: '0.004000',
    perspectives: ['all', 'build'],
  }),
  makeLeg({
    strike: 132,
    dteDays: 60,
    bid: '2.10',
    ask: '2.30',
    annualizedRate: '0.090000',
    weeklyRate: '0.003000',
    perspectives: ['all', 'rent'],
  }),
  makeLeg({
    strike: 122,
    dteDays: 60,
    bid: '1.60',
    ask: '1.80',
    annualizedRate: '0.065000',
    weeklyRate: '0.002000',
    perspectives: ['all', 'rent'],
  }),
  makeLeg({
    strike: 118,
    dteDays: 30,
    bid: '1.40',
    ask: '1.55',
    annualizedRate: '0.055000',
    weeklyRate: '0.003500',
    perspectives: ['all', 'build'],
  }),
  makeLeg({
    strike: 126,
    dteDays: 60,
    bid: '1.80',
    ask: '2.00',
    annualizedRate: '0.075000',
    weeklyRate: '0.002400',
    perspectives: ['all', 'rent'],
  }),
  makeLeg({
    strike: 130,
    dteDays: 60,
    bid: '2.00',
    ask: '2.20',
    annualizedRate: '0.085000',
    weeklyRate: '0.002800',
    perspectives: ['all', 'rent'],
  }),
  makeLeg({
    strike: 124,
    dteDays: 60,
    bid: '1.70',
    ask: '1.90',
    annualizedRate: '0.070000',
    weeklyRate: '0.002200',
    perspectives: ['all', 'rent'],
  }),
];

const CODE = (strike: number) => `PEP261218P${String(strike * 1000).padStart(6, '0')}`;
/** 载体序（= 腿册的数组序）—— 判别性自检拿它当反例。 */
const CARRIER_CODES = BOOK.map((entry) => entry.leg.code);

/**
 * 带推荐标的两条腿 —— 一条只在收租 + 全腿（132），一条只在建仓 + 全腿（120）。
 *
 * 🚨 **推荐标是标的级、不随视角变**（跨片不变量 #3）⇒ 判据取**深度档**（水位 → 意图 → 推荐标）。
 *    水位一改，三个视角的标同时变 —— 这正是 `SC-013` 的可验证形态：只失效一个视角的实现会让
 *    另外两个继续用旧口径打标，**数字与标都在、只是口径不对，且不会红**。
 */
const MARKED_CODES: ReadonlySet<string> = new Set([CODE(132), CODE(120)]);

function marked(code: string, depth: LegTableResponseRentDepth): boolean {
  return depth === 'deep' && MARKED_CODES.has(code);
}

/**
 * (买区, L2) 那一行的意图矩阵输出 —— server `classifyIntent` 在**该行**的取值。
 *
 * 推导：`d(买区) = 1`、`l(L2) = 2` ⇒ `surplus = d − (l − 1) = 0` ⇒ 建仓格的
 * `bucketIndex < surplus` 恒不成立 ⇒ 三档水位一律落 `rent`，深度档 = 水位档序本身。
 * 🚫 **不复算整个矩阵** —— 本文件只用到这一行，抄一份完整实现就是第二份必漂移的判据。
 * 📌 本行「换水位不换意图、只换深度档」正是 `SC-013` 要的那条路径：用户**停在建仓视角**
 *    （手点值在同一意图内说了算）改水位，Tab 不会被弹走，于是三视角失效与否**看得见**。
 */
const RENT_DEPTH_BY_BUCKET: Readonly<
  Record<SetPositionBucketRequestPositionBucket, LegTableResponseRentDepth>
> = {
  lt_one_third: 'near_atm',
  one_to_two_thirds: 'moderate',
  gte_two_thirds: 'deep',
};

// ════════════════════════════════════════════════════════════════════════════
// 迷你召回 —— 与服务端**同一条**判据（六维逐个，`null` = 不限）
// ════════════════════════════════════════════════════════════════════════════

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
 * 六维**系统默认值**：三视角一律「全不限」。
 *
 * 🚨 刻意不把期限段写进默认值 —— 腿的视角归属已由腿册的 `perspectives` 承担（它是召回层
 *    band 判定的镜像）。同一件事在 fixture 里写两处，两处必自相矛盾，而矛盾时**两边都答得出
 *    一张表**。本文件的判别性载体是**用户覆盖**那一维（行权价上界），不是默认值本身。
 */
const DEFAULT_CRITERIA: RetrievalCriteriaResponse = {
  strikeMax: null,
  strikeMin: null,
  dteBand: null,
  premiumMin: null,
  livenessMin: null,
  relativeSpreadMax: null,
};

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

/** 该视角在该组条件下的成员集（**未排序、未截断**）。复杂度 O(n)。 */
function recall(perspective: LegPerspective, c: RetrievalCriteriaResponse): LegResponse[] {
  return projectLegs(BOOK, perspective).filter((leg) => passes(leg, c));
}

/** 该视角口径下用来排序的费率字段 —— 与真端点「按本视角口径的费率降序」同一条规则。 */
const RATE_FIELD = { weekly: 'weeklyRate', annualized: 'annualizedRate' } as const;

/**
 * 精排后的成员集（**截断之前**）。复杂度 `O(n log n)`。
 * 每腿的 `basis` / `isRecommended` 在这里按**本次视角与当前深度档**落定 —— 契约收窄之后
 * 它们都是标量，不再有「取哪一格」这一步。
 */
function ranked(
  perspective: LegPerspective,
  c: RetrievalCriteriaResponse,
  depth: LegTableResponseRentDepth,
): LegResponse[] {
  const basis = BASIS_BY_PERSPECTIVE[perspective];
  return recall(perspective, c)
    .map((leg) => ({ ...leg, basis, isRecommended: marked(leg.code, depth) }))
    .sort((a, b) => Number(b[RATE_FIELD[basis]]) - Number(a[RATE_FIELD[basis]]));
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
 * 一个视角的条件全景。**三态与边际计数按定义现算**（把这一维换回系统默认值、其余维保持
 * 用户值，能多看几条）—— 摆常量的话客户端把「放宽」也渲成计数时本文件照样绿。复杂度 O(6n)。
 */
function perspectiveCriteria(
  perspective: LegPerspective,
  overrides: Partial<RetrievalCriteriaResponse>,
): PerspectiveCriteriaResponse {
  const effective: RetrievalCriteriaResponse = { ...DEFAULT_CRITERIA, ...overrides };
  const kept = recall(perspective, effective).length;
  const outcomes = {} as Record<CriterionKey, CriterionOutcomeResponse>;
  for (const key of CRITERION_KEYS) {
    if (!(key in overrides)) {
      outcomes[key] = { state: 'default', excludedCount: 0 };
      continue;
    }
    const gain = recall(perspective, { ...effective, [key]: DEFAULT_CRITERIA[key] }).length - kept;
    outcomes[key] =
      gain > 0
        ? { state: 'narrowed', excludedCount: gain }
        : { state: 'widened', excludedCount: 0 };
  }
  return { defaults: DEFAULT_CRITERIA, effective, outcomes };
}

// ════════════════════════════════════════════════════════════════════════════
// canonical 链状态 + 投影（一次请求答一个视角）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 某个视角的**答法**——延迟 / 失败 / 业务日。
 *
 * 🚨 三者都由 `perspective` 这个**请求参数**决定，🚫 与「这是第几次请求」无关：换句话说，
 *    同一个视角问一百次，一百次都是同样的延迟、同样的成败、同样的业务日。这正是
 *    「mock 是契约镜像不是调用序」在本文件的落法 —— 而它比编排更强：`asOf` 恒不一致
 *    让「最多重取一次」这条变成**可数的请求条数**（无限重取 = 条数爆炸）。
 */
interface PerspectiveWiring {
  readonly delayMs?: number;
  readonly fail?: boolean;
  readonly asOf?: string;
}

interface Chain {
  readonly displayLimit: number | null;
  readonly wiring: Readonly<Partial<Record<LegPerspective, PerspectiveWiring>>>;
  /** **可变** —— 水位写端点真的改它（与 047 同范式），不是测试编排标志。 */
  bucket: SetPositionBucketRequestPositionBucket | null;
}

function makeChain(over: Partial<Chain> = {}): Chain {
  return {
    displayLimit: null,
    wiring: {},
    bucket: 'gte_two_thirds',
    ...over,
  };
}

/**
 * canonical 状态 + 请求参数 → **一份**契约响应（服务端知道三视角全貌，按请求投影出一份）。
 *
 * 🚨 两处派生都不许改成写死：`legs[]`（成员集合 + 顺序 + 截断都从数据来）与三个计数
 *    （`matchedCount` 用生效条件、`memberCount` 用系统默认值跑同一条召回）。
 * 🚨 **截断作用在已排好序的尾巴上**（`FR-004`）—— `slice` MUST 在 `sort` 之后。
 * 🚫 **实际显示条数与「其余 N−D」不下发**（Guardrail 11）：前者恒等于 `legs.length`、
 *    后者由 `matchedCount − legs.length` 现算，下发第二份必 drift。
 */
function projectTable(
  chain: Chain,
  perspective: LegPerspective,
  params: URLSearchParams,
): LegTableResponse {
  const overrides = parseOverrides(params);
  const effective: RetrievalCriteriaResponse = { ...DEFAULT_CRITERIA, ...overrides };
  const depth = chain.bucket === null ? null : RENT_DEPTH_BY_BUCKET[chain.bucket];
  const intent: LegTableResponseIntent = chain.bucket === null ? 'pending' : 'rent';
  const matched = ranked(perspective, effective, depth);
  const asOf = chain.wiring[perspective]?.asOf ?? TODAY;

  return {
    symbol: SYMBOL,
    // 069 契约增量: 每 K 行军判决 —— 仅实时收租有值, mock 基线取缺省 null。
    march: null,
    // 070 契约增量: 行军模式标示 —— 与 march 同生共死, 基线随之 null。
    marchMode: null,
    // 053 FR-005：原样回显 —— 迟到的那一发靠它认领。
    perspective,
    state: 'available',
    asOf,
    asOfFreshnessTier: asOf === TODAY ? 'CURRENT' : 'STALE',
    quoteAsOf: `${TODAY}T20:15:00.000Z`,
    // 064 `FR-009`: 档位。mock 后端默认收盘档, 实时档的呈现分支归 T011 自己的用例。
    priceKind: 'eod_close',
    // 064 T007a: 链级降级标。mock 后端默认 `null` —— 正常收盘档不是降级, 告警态归 T011。
    realtimeDegrade: null,
    oiAsOf: TODAY,
    source: 'eod',
    spot: '132.40',
    w: '128.00',
    zone: 'buy',
    lLevel: 'L2',
    positionBucket: chain.bucket,
    positionBucketSource: chain.bucket === null ? null : 'manual',
    positionBucketSetAt: chain.bucket === null ? null : `${TODAY}T01:00:00.000Z`,
    intent,
    rentDepth: depth,
    // 🚨 数组顺序**就是**呈现顺序（FR-002），且这份已经是**截断之后**的那一段。
    legs: chain.displayLimit === null ? matched : matched.slice(0, chain.displayLimit),
    // 两个门槛计数不是本文件的断言面（归 051 T011）—— 取 0。
    gateCounts: { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 },
    basis: BASIS_BY_PERSPECTIVE[perspective],
    criteria: perspectiveCriteria(perspective, overrides),
    matchedCount: matched.length,
    memberCount: recall(perspective, DEFAULT_CRITERIA).length,
    displayLimit: chain.displayLimit,
    candidateCapDropped: 0,
  };
}

/** 期望值一律**从同一份 canonical 状态派生**，不在 test 里手抄（手抄那份漂了两边都不红）。 */
function view(chain: Chain, perspective: LegPerspective, query = ''): LegTableResponse {
  return projectTable(chain, perspective, new URLSearchParams(query));
}

const codesOf = (table: LegTableResponse): string[] => table.legs.map((leg) => leg.code);

// ════════════════════════════════════════════════════════════════════════════
// hermetic mock
// ════════════════════════════════════════════════════════════════════════════

interface DeskMock {
  /**
   * 请求 / 响应的**有序**事件流水（`req:all` / `res:all` / `err:build` / `bucket:<档>`）。
   * 🚨 错峰（`state_branch` 19）的可验证形态是**顺序**不是条数：并发取三份的实现会把三条
   *    `req:` 挤在第一条 `res:` 之前，而「等一会儿数一下」对它是看不见的。
   */
  readonly events: string[];
  /** 打到 `…/legs` 的查询串（含 `perspective`）。 */
  readonly legQueries: string[];
}

async function installMock(page: Page, chain: Chain): Promise<DeskMock> {
  const events: string[] = [];
  const legQueries: string[] = [];

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

    // ── POST /optionsdesk/anchors/:id/position-bucket（047 FR-017 写端点）──────
    // 🚨 它**真的改 canonical 状态** —— 水位 → 意图 → 深度档 → 推荐标，三个视角同时变。
    const bucketMatch = /\/optionsdesk\/anchors\/([^/]+)\/position-bucket$/.exec(path);
    if (bucketMatch && req.method() === 'POST') {
      if (bucketMatch[1] !== ANCHOR_ID) return void (await notFound());
      const body = req.postDataJSON() as {
        positionBucket: SetPositionBucketRequestPositionBucket;
      };
      chain.bucket = body.positionBucket;
      events.push(`bucket:${body.positionBucket}`);
      return void (await json(200, {
        anchorId: ANCHOR_ID,
        ticker: SYMBOL,
        positionBucket: chain.bucket,
        positionBucketSource: 'manual',
        positionBucketSetAt: new Date().toISOString(),
      }));
    }

    // ── GET …/legs（🚨 MUST 排在 `underlyings/(.+)$` 之前：后者的贪婪 `(.+)` 会把
    //    `/legs` 整段吃成 symbol，047 实撞过，症状是选约区块恒「未就绪」而锚卡正常）──
    const legsMatch = /\/optionsdesk\/underlyings\/(.+)\/legs$/.exec(path);
    if (legsMatch) {
      if (decodeURIComponent(legsMatch[1] ?? '') !== SYMBOL) return void (await notFound());
      // 🚨 053 FR-001：`perspective` 必填 —— 缺参 / 非三值 → 400。
      //    🚫 MUST NOT 默认一个视角：腿数、名次、档位全都正常，只是答的不是问的那个视角。
      const perspective = perspectiveOf(url);
      if (perspective === null) {
        events.push('req:invalid');
        return void (await json(400, PERSPECTIVE_REQUIRED_400));
      }
      legQueries.push(url.search);
      events.push(`req:${perspective}`);
      const wiring = chain.wiring[perspective];
      // 延迟由**视角**决定（不是由第几次请求决定）—— 错峰与迟到响应靠它可观测。
      const delayMs = wiring?.delayMs;
      if (delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (wiring?.fail === true) {
        events.push(`err:${perspective}`);
        return void (await json(500, {
          status: 500,
          code: 'INTERNAL_SERVER_ERROR',
          title: 'leg table read failed',
        }));
      }
      events.push(`res:${perspective}`);
      return void (await json(200, projectTable(chain, perspective, url.searchParams)));
    }

    // ── GET /optionsdesk/underlyings/:symbol ────────────────────────────────
    if (/\/optionsdesk\/underlyings\/(.+)$/.test(path)) {
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

  return { events, legQueries };
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

const LOADING = 'optionsdesk-detail-leg-loading';
const READ_FAILED = 'optionsdesk-detail-leg-read_failed';
const RETRY = 'optionsdesk-detail-leg-retry';
const EMPTY = 'optionsdesk-detail-leg-empty';
const TRUNCATED = 'optionsdesk-detail-leg-truncated';
const MISMATCH = 'optionsdesk-detail-leg-asof-mismatch';
const MISMATCH_CTA = 'optionsdesk-detail-leg-asof-mismatch-refresh';
const TABS = 'optionsdesk-detail-leg-tabs';
const ENTRY = 'optionsdesk-detail-criteria-entry';
const SHEET = 'optionsdesk-detail-criteria-sheet';
const SUBMIT = 'optionsdesk-detail-criteria-submit';
const BADGE = 'optionsdesk-detail-criteria-badge';
const fitId = (code: string) => `optionsdesk-detail-leg-fit-${code}`;
const criteriaInput = (field: string) => `optionsdesk-detail-criteria-input-${field}`;
const criteriaCountLine = (key: CriterionKey) => `optionsdesk-detail-leg-criteria-${key}`;

async function openDetail(page: Page): Promise<void> {
  await page.goto(`/optionsdesk/underlying/${encodeURIComponent(SYMBOL)}`);
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible({ timeout: 90_000 });
}

async function selectTab(page: Page, perspective: LegPerspective): Promise<void> {
  await page.getByTestId(`optionsdesk-detail-leg-tab-${perspective}`).tap();
}

async function openSheet(page: Page): Promise<void> {
  await page.getByTestId(ENTRY).tap();
  await expect(page.getByTestId(SHEET)).toBeVisible();
}

/**
 * 屏上**实际渲染出来的行序**（DOM 顺序 = 列表渲染顺序）。
 * 🚨 一次性读，**不自动重试** —— 「这一拍屏幕上是什么」正是本文件几条断言要的东西
 *    （迟到响应有没有写进来、换条件那一拍表有没有闪空），自动重试会把它们全变成恒真。
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
 * 区块头计数。
 * 🚨 报的是**响应的 `matchedCount`**（`FR-016`）—— 截断之后它与渲染出来的行数不再相等，
 *    「已显示前 D 条」由非常驻区的截断计数承担（同一个数一屏两处，`SC-005` 明禁）。
 */
async function expectRowCount(page: Page, table: LegTableResponse): Promise<void> {
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(
    table.memberCount === table.matchedCount
      ? COPY.rowTotal(table.matchedCount)
      : COPY.rowTotalNarrowed(table.matchedCount, table.memberCount),
  );
}

/** 某视角发出去过几条请求 —— 失效 / 重取 / 错峰的可数判据。 */
function requestCount(mock: DeskMock, perspective: LegPerspective): number {
  return mock.legQueries.filter((q) => new URLSearchParams(q).get('perspective') === perspective)
    .length;
}

function requestCounts(mock: DeskMock): Record<LegPerspective, number> {
  return {
    all: requestCount(mock, 'all'),
    build: requestCount(mock, 'build'),
    rent: requestCount(mock, 'rent'),
  };
}

const settledCount = (mock: DeskMock): number =>
  mock.events.filter((e) => e.startsWith('res:') || e.startsWith('err:')).length;

// ════════════════════════════════════════════════════════════════════════════
// ① state_branch 19 / 21 —— 错峰时序 + 预取命中（SC-008）
// ════════════════════════════════════════════════════════════════════════════

test('053 T010 — sb19 / sb21：当前视角未落地时另两个**一个请求都不发**（错峰）；预取已完成的视角切过去**零新请求、零可见加载态**（SC-008）', async ({
  page,
}) => {
  // 前提自检：派生出来的序**确实**与载体序不同 —— 否则「按下发序渲染」与「按载体序渲染」
  // 会给出同一张屏，本文件所有顺序断言随之失去判别性。
  const chain = makeChain({
    wiring: { all: { delayMs: 250 }, build: { delayMs: 250 }, rent: { delayMs: 250 } },
  });
  expect(codesOf(view(chain, 'all'))).not.toEqual(CARRIER_CODES);

  const mock = await installMock(page, chain);
  await openDetail(page);
  await expectRowCount(page, view(chain, 'rent'));
  await expect.poll(() => settledCount(mock), { timeout: 60_000 }).toBe(3);

  // 🚨 **错峰的可验证形态是顺序**：并发取三份的实现会把三条 `req:` 挤在第一条 `res:` 之前
  //    （每视角 250ms 延迟就是给它留的窗口）。落位视角要等 `intent` 才解析得出 ⇒ 首发恒是
  //    「视角未知时的落位」全腿，它落地后才轮到收租，收租落地后才轮到建仓。
  expect(mock.events).toEqual([
    'req:all',
    'res:all',
    'req:rent',
    'res:rent',
    'req:build',
    'res:build',
  ]);

  // ── sb21 / SC-008：预取已完成的视角，切过去 MUST NOT 出现可见加载态 ──────────
  const before = mock.legQueries.length;
  await selectTab(page, 'build');
  // 一次性读（🚫 不用会自动重试的断言）—— 加载态是**那一拍**的事实，重试会把它变成恒真。
  expect(await page.getByTestId(LOADING).count()).toBe(0);
  await expect.poll(() => renderedCodes(page)).toEqual(codesOf(view(chain, 'build')));
  // 🚨 结构判据（比「看不见 spinner」更硬）：**一条请求都没多发** —— 没有请求就没有加载态可谈。
  expect(mock.legQueries.length).toBe(before);
  expect(await page.getByTestId(LOADING).count()).toBe(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ② state_branch 22 / 18 —— 预取未完成切过去 = 正常加载态；迟到响应不覆盖
// ════════════════════════════════════════════════════════════════════════════

test('053 T010 — sb22 / sb18：预取**未完成**的视角切过去降级为正常加载态（🚫 不是空态）；那一发迟到落地后 MUST NOT 覆盖已切走的视角', async ({
  page,
}) => {
  const chain = makeChain({ wiring: { build: { delayMs: 4000 } } });
  const mock = await installMock(page, chain);
  const rentView = view(chain, 'rent');

  await openDetail(page);
  await expectRowCount(page, rentView);
  // 收租落地那一拍才轮到建仓（错峰）⇒ 此刻建仓那一发正在飞。
  await expect.poll(() => mock.events.includes('req:build'), { timeout: 60_000 }).toBe(true);

  await selectTab(page, 'build');
  // sb22：降级为**正常加载态**，🚫 MUST NOT 呈现成空态（「还没读到」与「确实没有腿」两件事）。
  await expect(page.getByTestId(LOADING)).toBeVisible();
  expect(await page.getByTestId(EMPTY).count()).toBe(0);

  // sb18：切回收租 —— 建仓那一发**迟到**落地后，屏幕上 MUST 仍是收租那一份。
  await selectTab(page, 'rent');
  expect(await renderedCodes(page)).toEqual(codesOf(rentView));
  await expect.poll(() => mock.events.includes('res:build'), { timeout: 60_000 }).toBe(true);
  // 给迟到那一发充分的机会把自己写进屏幕（它写不进去，正是本条要证的）。
  await page.waitForTimeout(500);
  expect(await renderedCodes(page)).toEqual(codesOf(rentView));
  await expectRowCount(page, rentView);
});

// ════════════════════════════════════════════════════════════════════════════
// ③ state_branch 16 / 17 / 20 —— 单视角失败隔离（SC-009）
// ════════════════════════════════════════════════════════════════════════════

test('053 T010 — sb16 / sb17 / sb20：后台预取失败 ⇒ 当前视角**零感知**且 Tab 行无错误/加载角标；切过去显**它自己的**错误态与重试入口（🚫 不是空态），其余视角的数据零变化（SC-009）', async ({
  page,
}) => {
  const chain = makeChain({ wiring: { build: { fail: true } } });
  const mock = await installMock(page, chain);
  const rentView = view(chain, 'rent');

  await openDetail(page);
  await expectRowCount(page, rentView);
  await expect.poll(() => mock.events.includes('err:build'), { timeout: 60_000 }).toBe(true);
  // 该 query 退 1 次（`retryUnlessNoAnchor`）⇒ 等它连重试一起落定，再断言「前台零感知」。
  await page.waitForTimeout(2000);

  // ── sb20：当前视角零感知 ────────────────────────────────────────────────
  expect(await renderedCodes(page)).toEqual(codesOf(rentView));
  await expectRowCount(page, rentView);
  expect(await page.getByTestId(READ_FAILED).count()).toBe(0);
  expect(await page.getByTestId(EMPTY).count()).toBe(0);

  // 🚨 Tab 行 MUST NOT 出现错误 / 加载角标（`FR-027`）—— 文本全等抓「多了个数字/字」，
  //    testID 扫描抓「多了个带标记的节点」。⚠️ 纯图形、无文本无 testID 的角标两者都抓不到，
  //    那一档如实归真机验收（见文件头「验不到的」）。
  const tabsRow = page.getByTestId(TABS);
  expect(((await tabsRow.textContent()) ?? '').replace(/\s+/g, '')).toBe(
    `${COPY.tabs.all}${COPY.tabs.build}${COPY.tabs.rent}`,
  );
  expect(
    await tabsRow
      .locator(
        '[data-testid*="error"], [data-testid*="fail"], [data-testid*="loading"], [data-testid*="retry"], [data-testid*="badge"]',
      )
      .count(),
  ).toBe(0);

  // ── sb17：切过去看到**该视角自己的**错误态与重试入口，🚫 MUST NOT 呈现成空态 ──
  await selectTab(page, 'build');
  await expect(page.getByTestId(READ_FAILED)).toContainText(COPY.readFailed);
  await expect(page.getByTestId(RETRY)).toHaveText(COPY.retry);
  expect(await page.getByTestId(EMPTY).count()).toBe(0);

  // ── FR-022：重试**只重这一份** ────────────────────────────────────────────
  const before = requestCounts(mock);
  await page.getByTestId(RETRY).tap();
  await expect
    .poll(() => requestCount(mock, 'build'), { timeout: 60_000 })
    .toBeGreaterThan(before.build);
  expect(requestCount(mock, 'all')).toBe(before.all);
  expect(requestCount(mock, 'rent')).toBe(before.rent);

  // ── sb16：切回去，其余视角**已取得的数据 MUST NOT 被清空或降级** ──────────
  await selectTab(page, 'rent');
  expect(await renderedCodes(page)).toEqual(codesOf(rentView));
  await expectRowCount(page, rentView);
  expect(await page.getByTestId(READ_FAILED).count()).toBe(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ④ state_branch 13 / 14 —— 跨业务日：自动重取一次 + 仍不一致给提示（SC-010）
// ════════════════════════════════════════════════════════════════════════════

test('053 T010 — sb13 / sb14：三视角跨业务日 ⇒ **自动重取全部恰好一次**；仍不一致给显式提示 + 手动刷新入口，且 MUST NOT 无限重取（SC-010）', async ({
  page,
}) => {
  // 🚨 handler **恒**答不一致（建仓那一份永远报昨天）—— 比「第二次才对齐」的编排更强：
  //    无限重取在这里会表现为请求条数爆炸，而不是悄悄地多来一轮。
  const chain = makeChain({ wiring: { build: { asOf: YESTERDAY } } });
  const mock = await installMock(page, chain);
  const rentView = view(chain, 'rent');

  await openDetail(page);
  await expectRowCount(page, rentView);

  await expect(page.getByTestId(MISMATCH)).toContainText(COPY.asOfMismatch, { timeout: 60_000 });
  await expect(page.getByTestId(MISMATCH_CTA)).toContainText(COPY.asOfMismatchCta);

  // 每视角**恰好两发**：首发 + 自动重取那一发。闩已置 ⇒ 第三轮不该有。
  expect(requestCounts(mock)).toEqual({ all: 2, build: 2, rent: 2 });
  await page.waitForTimeout(2000);
  expect(requestCounts(mock)).toEqual({ all: 2, build: 2, rent: 2 });

  // 🚫 提示在，但表**不清空**：MUST NOT 把「口径可能对不齐」渲成读故障或空态。
  expect(await renderedCodes(page)).toEqual(codesOf(rentView));
  expect(await page.getByTestId(READ_FAILED).count()).toBe(0);

  // 处置权交回用户 —— 手动入口再取三份，仍不一致 ⇒ 提示留着（这才是「不无限重取」的出口）。
  await page.getByTestId(MISMATCH_CTA).tap();
  await expect
    .poll(() => requestCounts(mock), { timeout: 60_000 })
    .toEqual({
      all: 3,
      build: 3,
      rent: 3,
    });
  await expect(page.getByTestId(MISMATCH)).toBeVisible();
  await page.waitForTimeout(2000);
  expect(requestCounts(mock)).toEqual({ all: 3, build: 3, rent: 3 });
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ state_branch 15 —— 停在建仓视角改水位 ⇒ 三视角全部失效重取（SC-013）
// ════════════════════════════════════════════════════════════════════════════

test('053 T010 — sb15 / SC-013：用户**停在建仓视角**改水位 ⇒ 三个视角**全部**失效重取，三份的推荐标口径同时到位（🚫 只重取收租视角不会红）', async ({
  page,
}) => {
  // 起手在 `moderate` 档（水位 1/3~2/3）⇒ 全表零推荐标；改到 `gte_two_thirds` ⇒ `deep` 档，
  // 两条标的级腿的 Δ 同时落在意图带内。意图两侧都是 `rent` ⇒ 手点的建仓视角**不会被弹走**（FR-016 只在
  // 意图真变时让位），于是「三视角有没有一起失效」在同一屏上就看得见。
  const chain = makeChain({ bucket: 'one_to_two_thirds' });
  const mock = await installMock(page, chain);

  await openDetail(page);
  await expectRowCount(page, view(chain, 'rent'));
  await expect.poll(() => settledCount(mock), { timeout: 60_000 }).toBe(3);

  await selectTab(page, 'build');
  const buildBefore = view(chain, 'build');
  await expect.poll(() => renderedCodes(page)).toEqual(codesOf(buildBefore));
  // 前提自检：此刻**一个推荐标都没有** —— 否则「标到位了」验不到东西。
  expect(buildBefore.legs.some((leg) => leg.isRecommended)).toBe(false);
  expect(await page.getByTestId(fitId(CODE(120))).count()).toBe(0);

  const before = requestCounts(mock);
  await page.getByTestId('optionsdesk-detail-position-bucket-gte_two_thirds').tap();

  // 🚨 **三份全部重取**（Guardrail 2）：失效若走带 `perspective` 的那把 key，这里只会 +1，
  //    而屏幕上什么都不会红 —— 水位 chip 亮了、意图变了，另外两个视角还在用旧口径打标。
  await expect
    .poll(() => requestCounts(mock), { timeout: 60_000 })
    .toEqual({
      all: before.all + 1,
      build: before.build + 1,
      rent: before.rent + 1,
    });

  // 内容面（比数请求更硬）：推荐标是**标的级**的 ⇒ 三个视角同时到位，且用户仍停在建仓视角。
  await expect(page.getByTestId(fitId(CODE(120)))).toHaveText(COPY.fitBadge);
  await expect.poll(() => renderedCodes(page)).toEqual(codesOf(view(chain, 'build')));

  await selectTab(page, 'rent');
  await expect(page.getByTestId(fitId(CODE(132)))).toHaveText(COPY.fitBadge);

  await selectTab(page, 'all');
  await expect(page.getByTestId(fitId(CODE(132)))).toHaveText(COPY.fitBadge);
  await expect(page.getByTestId(fitId(CODE(120)))).toHaveText(COPY.fitBadge);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ state_branch 5（客户端一半）—— 截断计数的出现与消失（US1-AS1 / AS4 / SC-005）
// ════════════════════════════════════════════════════════════════════════════

test('053 T010 — sb5：截断计数**出现**（且与区块头不报同一个数，SC-005）；收窄条件使结果降到阈值以下 ⇒ 计数**消失**，MUST NOT 停在旧值', async ({
  page,
}) => {
  // 阈值注入小值（3）—— 与服务端 IT 同一条手段（`SC-006`）：意图视角的真实规模够不到阈值，
  // 靠注入才走得遍截断分支。收租默认 6 条 ⇒ 截 3 留 3；收到 `strikeMax ≤ 126` ⇒ 3 条，
  // **恰等于阈值不截**（严格大于才截）⇒ 计数整条消失。
  const chain = makeChain({ displayLimit: 3, wiring: { rent: { delayMs: 800 } } });
  const mock = await installMock(page, chain);
  const wide = view(chain, 'rent');
  const narrow = view(chain, 'rent', 'perspective=rent&strikeMax=126');

  // 前提自检：两侧确实一个截、一个不截，且 `memberCount` 两侧同为无覆盖口径的那个数。
  expect(wide.matchedCount).toBeGreaterThan(wide.legs.length);
  expect(narrow.matchedCount).toBe(narrow.legs.length);
  expect(narrow.memberCount).toBe(wide.matchedCount);

  await openDetail(page);
  await expectRowCount(page, wide);
  expect(await renderedCodes(page)).toEqual(codesOf(wide));

  // 🚨 截断计数：只带新信息 —— 已显示多少 + 还剩多少 + 收窄指引。
  const truncated = page.getByTestId(TRUNCATED);
  await expect(truncated).toHaveText(
    COPY.truncated(wide.legs.length, wide.matchedCount - wide.legs.length),
  );
  // 🚨 SC-005：计数区 MUST NOT 复述区块头那个数（同屏两处相同数值会被读成两个不同的量）。
  expect((await truncated.textContent()) ?? '').not.toContain(String(wide.matchedCount));
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(
    COPY.rowTotal(wide.matchedCount),
  );

  // ── 收窄到阈值以下 ────────────────────────────────────────────────────────
  await openSheet(page);
  await setCriteria(page, 'strikeMax', '126');
  await page.getByTestId(SUBMIT).tap();

  // 🔬 **换 key 那一拍表 MUST NOT 闪空**（`FR-026` / Guardrail 3 的可观测形态）——
  //    一次性读，落在收租那 800ms 的窗口内：`placeholderData: keepPreviousData` 一摘，
  //    这一拍 `data` 变 undefined ⇒ 区块塌成骨架、行数归零，本行当场红。
  expect(await page.getByTestId(LOADING).count()).toBe(0);
  expect(await renderedCodes(page)).toEqual(codesOf(wide));

  await expectRowCount(page, narrow);
  expect(await renderedCodes(page)).toEqual(codesOf(narrow));
  // 🚨 计数**消失**（`FR-018` 未触发截断整条不渲染），MUST NOT 停在旧值。
  expect(await page.getByTestId(TRUNCATED).count()).toBe(0);
  // 收窄那一维照常出边际计数（052 已 ship 的那条，本片不回退）。
  await expect(page.getByTestId(criteriaCountLine('strikeMax'))).toContainText(
    COPY.criteriaCountLine(narrow.memberCount - narrow.matchedCount),
  );

  // 请求里只带改过的那一维 + 视角（🚫 系统默认值 MUST NOT 回传）。
  expect(mock.legQueries).toContain('?perspective=rent&strikeMax=126');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ state_branch 23 —— 某视角的条件覆盖，切走再切回仍是它自己那份
// ════════════════════════════════════════════════════════════════════════════

test('053 T010 — sb23：在收租设的条件**不跟着**切到全腿（全腿仍是它自己那份未覆盖），切回收租时覆盖还在', async ({
  page,
}) => {
  const chain = makeChain({ displayLimit: 3 });
  const mock = await installMock(page, chain);
  const wide = view(chain, 'rent');
  const narrow = view(chain, 'rent', 'perspective=rent&strikeMax=126');
  const allView = view(chain, 'all');

  await openDetail(page);
  await expectRowCount(page, wide);

  await openSheet(page);
  await setCriteria(page, 'strikeMax', '126');
  await page.getByTestId(SUBMIT).tap();
  await expectRowCount(page, narrow);
  await expect(page.getByTestId(BADGE)).toHaveText('1');

  // 切到全腿：它有**自己那一份**状态（未覆盖）⇒ 计数走单数形态、徽标与计数行都不在。
  await selectTab(page, 'all');
  await expectRowCount(page, allView);
  expect(await renderedCodes(page)).toEqual(codesOf(allView));
  expect(await page.getByTestId(BADGE).count()).toBe(0);
  expect(await page.getByTestId(criteriaCountLine('strikeMax')).count()).toBe(0);
  // 🚫 收租的 `126` MUST NOT 出现在全腿的控件里。
  await openSheet(page);
  await expect(page.getByTestId(criteriaInput('strikeMax'))).toHaveText(CRITERIA_UNBOUNDED);
  await page.getByTestId('optionsdesk-detail-criteria-backdrop').tap();

  // 切回收租：覆盖还在（既没被切走时清空，也没被全腿那次请求冲掉）。
  await selectTab(page, 'rent');
  await expectRowCount(page, narrow);
  expect(await renderedCodes(page)).toEqual(codesOf(narrow));
  await expect(page.getByTestId(BADGE)).toHaveText('1');

  // 🚨 三份 key 各带各的条件 ⇒ 全腿那一份**从未**带过 `strikeMax`（带过就是串味了）。
  expect(
    mock.legQueries.filter(
      (q) =>
        new URLSearchParams(q).get('perspective') === 'all' &&
        new URLSearchParams(q).get('strikeMax') !== null,
    ),
  ).toEqual([]);
});
