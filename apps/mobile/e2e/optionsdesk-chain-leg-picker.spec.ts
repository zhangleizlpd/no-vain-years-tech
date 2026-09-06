import { expect, test, type Locator, type Page, type Route } from './_support/fixtures';
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
import {
  BASIS_BY_PERSPECTIVE,
  emptyPerspectiveCriteria,
  PERSPECTIVE_REQUIRED_400,
  perspectiveOf,
  projectLegs,
  quoted,
  type CanonicalLeg,
  type LegPerspective,
} from './_support/optionsdesk-fixtures';

// 047 T035 — 选约表（US2 / US3 / US4）hermetic UI e2e（Playwright Expo Web，Constitution §V
// 两层验证之一；样板 = `optionsdesk-detail-thermometer.spec.ts`）。
//
// 覆盖（逐条对应 tasks.md T035 的 ①~⑦ + FR-012 的运行时判据）：
//   ① **SC-012** —— 计数条分母 = 逻辑集合长度 · 可滚到最后一行 · 滚动区长度覆盖全部逻辑行 ·
//      全部腿行都在 DOM 里（US2-AS1「无静默截断」）
//   ② **US2-AS6** —— 横滑露出隐藏列 + 首列钉住 + **横滑后纵向滚动仍工作、纵滚后横向位移不变**
//      （= 手势零争用的**唯一**可验证判据：那个坑在 RN 只打 dev warning，
//        typecheck / lint / 单测 / CI 全绿，只有这条 e2e 能照出来）
//      🚨 **049 T005 判据已换代**（滚轮 + `scrollLeft` → 指针分步拖拽 + `boundingBox`），
//        换代理由与失效方式写在该 test 上方；②b 是 049 T004 新增的横向指示条两条
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
// ── ⚠️ Expo Web 下**验不到**的几件事（如实标注，不凑假断言）────────────────────
//   1. **真机手感 / 滚动流畅度 / 惯性衰减与边界回弹** —— spec 已明标手感故意不作验收门
//      （主观计时）。本文件只验「能滚到 / 滚得对」，不验「滚得顺」；`withDecay` 的收敛点
//      落在哪归真机验收单（049 M1/M4）。
//   2. **大规模虚拟化窗口** —— `VirtualizedList` 默认 `windowSize=21`（≈ 21 屏 ≈ 369 行 @48px），
//      e2e 可承受的行数（本文件 60）**够不到**那条线 ⇒ web 上全部行都会被渲染出来。故 ①
//      在 web 下验的是「分母取逻辑集合长度 + 滚动区覆盖全部逻辑行 + 零截断」，
//      **「730 行只渲染视口那一窗」归真机验收**（T037/T039 勿把它当已验）。
//   3. **a11y 的 selected 语义** —— 组件按 RN 正道写了 `accessibilityState={{ selected }}`，
//      但 **react-native-web 0.21 整个不认这个 prop**（dist 内零处理）⇒ web DOM 上没有
//      `aria-selected`。选中态在本文件走「自比较的视觉态 + 功能面」两层断言（见 `textStyleOf`），
//      **读屏器读不读得出「已选中」归真机验收**。
//   4. 🚨 **自激环（049 `SC-001`）** —— ADR-0063 已实证：合成手势（单指、单向、无交错）下
//      缺陷实现**完全测不出问题**，净位移看着是对的而写入 / 方向反转仍在涨。web 侧凑一条
//      断言只会制造假绿 ⇒ 由真机数值探针独占（049 T008 M1），本文件**刻意零覆盖**。
//   5. **sticky 栈高在真机窄屏的实际占比**（049 `SC-006`）—— web 视口比真机可用高度宽松，
//      这里量出来的行数不能当真机结论。
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
 * 🚨 **窄视口是本文件的前提，不是装饰**：12 列共 716px，其中右侧列区 628px。
 * Desktop Chrome 默认 1280px 下**根本没有横向余量** ⇒ 横滑压根发生不了，US2-AS6 会「绿得毫无
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
  /** 064：实时档下区块头改说「快照 X」（库内快照的归属日），时点归档位条。 */
  snapshotPrefix: '快照 ',
  rowTotal: (n: number) => `共 ${n} 行`,
  chainNotReady:
    '期权链数据未就绪 —— 该标的的链正在补，新建的锚会自动触发一次补数，无需操作。补完之后这里要么出表，要么明确告诉你这只标的没有挂牌期权。',
  noListedOptions:
    '该标的没有挂牌期权 —— 交易所没有为它挂出期权合约，所以这里不会有可选的腿。锚的估值与雷达档位照常可用。',
  empty: '该 Tab 暂无适格腿 —— 面板照常可读',
  disclaimer: '触发 ≠ 开仓 —— 人工终决',
  noNewPositionWarning: '不开新仓 —— 该标的落在不动区或 L4。以下腿数据照常全量呈现，仅供查看。',
  sourceBackfillPrefix: '来源 ',
  bucketUnsetHint: '选一次水位档以定位意图',
  fitBadge: 'Δ带内',
  rentDepthUnionNote: (badge: string) =>
    `水位未选 → 收租视角的腿与选了水位时完全相同，差别只在于全表零「${badge}」标。`,
  bucketManual: '人工输入',
  tabs: { all: '全腿视角', build: '建仓视角', rent: '收租视角' },
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

/** 首列宽 / 右侧列区内容总宽（`leg-row.rules.ts` 的同名常量）—— 指示条长度比的换算基准。 */
const LEG_STICKY_COL_WIDTH = 88;
const LEG_SCROLL_REGION_WIDTH = 628;

// ════════════════════════════════════════════════════════════════════════════
// canonical 数据（= 服务端 DB 内容的镜像）
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

/** 缺省成员视角（= 收租腿基线的归属）。 */
const DEFAULT_PERSPECTIVES: readonly LegPerspective[] = ['all', 'rent'];

/**
 * 造一条 canonical 腿。
 *
 * 🚨 **053 FR-005 起「属于哪些视角」与「各视角判什么档」都不在契约里**（每腿 `tabs` /
 *    `tierByTab` 已删，一次请求只作答一个视角）—— 它们移到 fixture 侧的 {@link CanonicalLeg}，
 *    由 mock 按请求的 `perspective` 投影。入参 `tabs` 随之改名 `perspectives`。
 * 🚨 各视角的档**由 `tier` × `perspectives` 派生**（Guardrail 10：mock 从数据派生，不手写第二
 *    份）—— 写死一份就会与用例里 `tier: 'dead'` 这类覆写当场矛盾：屏幕渲成好档、断言红在
 *    「文案不对」上，而真正错的是 mock 自相矛盾。
 * 📌 派生只保证「同一条腿在其所属视角里判同一档」；**两个视角判不同档**那种数据要显式传
 *    `tierBy`（本文件的用例都不需要，051 T011 的那份 e2e 才需要）。
 */
function makeLeg(
  over: Partial<LegResponse> &
    Pick<LegResponse, 'code'> & {
      perspectives?: readonly LegPerspective[];
      tierBy?: CanonicalLeg['tierBy'];
    },
): CanonicalLeg {
  const { perspectives = DEFAULT_PERSPECTIVES, tierBy, ...legOver } = over;
  const leg: LegResponse = { ...LEG_BASE, ...legOver };
  return {
    leg,
    perspectives,
    tierBy:
      tierBy ??
      (Object.fromEntries(perspectives.map((p) => [p, leg.tier])) satisfies CanonicalLeg['tierBy']),
  };
}

/**
 * 一票的 canonical 选约表状态 —— **链级字段照契约摆，视角级的留在 `book` 里**。
 *
 * 🚨 053 FR-005 把响应按「链级 / 视角级」切了一刀：链级（`state` / `asOf` / `spot` / `w` /
 *    `intent` / 水位三件套…）每次请求照传且三份逐字相等；视角级（成员集合、每腿档位、口径、
 *    条件全景、三个计数）**只发本次那一份**。fixture 于是也照这一刀切：这里存链级 + 腿册，
 *    {@link projectTable} 按请求参数合成一份响应。
 */
interface CanonicalTable extends Omit<
  LegTableResponse,
  | 'perspective'
  | 'legs'
  | 'basis'
  | 'criteria'
  | 'matchedCount'
  | 'memberCount'
  | 'displayLimit'
  | 'candidateCapDropped'
> {
  book: readonly CanonicalLeg[];
}

/** 选约表基线 —— 当期快照、水位未选（⇒ 意图 `pending`，默认落位「全腿」）。 */
function makeLegTable(
  symbol: string,
  book: readonly CanonicalLeg[],
  over: Partial<CanonicalTable> = {},
): CanonicalTable {
  return {
    symbol,
    // 069 契约增量: 每 K 行军判决 —— 仅实时收租有值, mock 基线取缺省 null。
    march: null,
    // 070 契约增量: 行军模式标示 —— 与 march 同生共死, 基线随之 null。
    marchMode: null,
    state: 'available',
    asOf: TODAY,
    asOfFreshnessTier: 'CURRENT',
    quoteAsOf: `${TODAY}T20:15:00.000Z`,
    // 064 `FR-009`: 档位。mock 后端默认收盘档, 实时档的呈现分支归 T011 自己的用例。
    priceKind: 'eod_close',
    // 064 T007a: 链级降级标。mock 后端默认 `null` —— 正常收盘档不是降级, 告警态归 T011。
    realtimeDegrade: null,
    // 🚨 与 asOf 差一天 —— OI 列 MUST 用它（FR-013 / Guardrail 6 / SC-003）。
    oiAsOf: YESTERDAY,
    source: 'eod',
    // #378 契约增量: 候选面标识。
    windowShape: null,
    spot: '82.40',
    w: '80.00',
    zone: 'buy',
    lLevel: 'L2',
    positionBucket: null,
    positionBucketSource: null,
    positionBucketSetAt: null,
    intent: 'pending',
    rentDepth: null,
    // 本文件不验两个门槛计数（归 051 T011 那份）—— 取 0。
    gateCounts: { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 },
    book,
    ...over,
  };
}

/**
 * canonical 状态 + 请求的视角 → **一份**契约响应（053 FR-005）。复杂度 O(n)。
 *
 * 🚨 顺序沿用入册顺序 —— 数组顺序**就是**呈现顺序（FR-002），047 那份并行的有序 code 列表
 *    `tabOrder` 随之退役：同一个顺序下发两份表达必 drift，而两份各自都渲染得出来。
 */
function projectTable(canonical: CanonicalTable, perspective: LegPerspective): LegTableResponse {
  const { book, ...chain } = canonical;
  const legs = projectLegs(book, perspective);
  return {
    ...chain,
    perspective,
    legs,
    basis: BASIS_BY_PERSPECTIVE[perspective],
    // 六维条件不是本文件的断言面（归 052 T013）—— 恒发默认值那一份。
    criteria: emptyPerspectiveCriteria(),
    // 未覆盖条件 ⇒ 两数相等（区块头走单数形态）；本文件不设截断阈值、候选上限未触及。
    matchedCount: legs.length,
    memberCount: legs.length,
    displayLimit: null,
    candidateCapDropped: 0,
  };
}

/** SC-012 的大表：N 条同视角腿，行权价逐档下移（code 唯一 ⇒ 行 testID 唯一）。O(n)。 */
function manyLegs(count: number): CanonicalLeg[] {
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
  /** 逐票的 canonical 选约表状态；缺键 = 该票有当期快照 + 一条基线腿。 */
  legs?: Record<string, CanonicalTable>;
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
  const tables = new Map<string, CanonicalTable>();
  for (const anchor of anchors) {
    const given = fixture.legs?.[anchor.ticker];
    tables.set(
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
      const table = anchor ? tables.get(anchor.ticker) : undefined;
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
      const table = tables.get(decodeURIComponent(legsMatch[1] ?? ''));
      if (!table) return void (await notFound());
      // 🚨 053 FR-001：`perspective` 必填 —— 缺参 / 非三值 → 400。
      //    🚫 MUST NOT 默认一个视角：那时腿数、名次、档位全都正常，只是答的不是问的那个视角。
      const perspective = perspectiveOf(url);
      if (perspective === null) return void (await json(400, PERSPECTIVE_REQUIRED_400));
      return void (await json(200, projectTable(table, perspective)));
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

const SCROLLBAR = 'optionsdesk-detail-leg-scrollbar';
const SCROLLBAR_THUMB = 'optionsdesk-detail-leg-scrollbar-thumb';

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

/**
 * 横向拖拽 —— 049 起横滑由 `Gesture.Pan` 驱动，**只吃指针事件流**：
 *   · `page.mouse.wheel(dx, 0)` **不驱动** RNGH 的 Pan（滚轮走的是另一条通路）；
 *   · 一次到位的 `mouse.move` 可能被当成瞬移，跨不过 `.activeOffsetX([-12,12])` 的方向仲裁。
 * ⇒ 必须 `down` → **多次** `move` → `up`。`dx < 0` = 手指往左划 = 列区左移（露出右侧列）。
 * 起手点取目标右侧 20% 处，往左划时指针仍留在元素内。复杂度 O(steps)。
 */
async function dragHorizontally(
  page: Page,
  target: Locator,
  dx: number,
  steps = 12,
): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('拖拽目标不可见，取不到 boundingBox');
  const y = box.y + box.height / 2;
  const startX = box.x + box.width * 0.8;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/** 元素盒。取不到就抛 —— 静默返回 0 / null 会把断言变成假绿。 */
async function boxOf(
  target: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('取不到 boundingBox');
  return box;
}

/** 元素左缘 x。取不到就抛 —— 静默返回 0 会把断言变成假绿。 */
async function boxX(target: Locator): Promise<number> {
  return (await boxOf(target)).x;
}

/**
 * 等 `withDecay` 惯性收敛：连续两次读到同一个 x（±0.5px）才算停。
 * 🚨 松手后位移还在跑，不等就读 ⇒ 后续「Δx 不变」这类断言会读到还在动的中间值。
 */
async function settledX(page: Page, target: Locator): Promise<number> {
  let prev = await boxX(target);
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(120);
    const now = await boxX(target);
    if (Math.abs(now - prev) <= 0.5) return now;
    prev = now;
  }
  throw new Error('位移 3s 内未收敛（松手后仍在持续写入？）');
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

/**
 * 049 T006 —— 选中态的**第二重编码**：格底色（稿 A 的 `surface-sunken`）。
 *
 * 🚨 双重编码（字色/字重 + 底色）是 plan D-TAB-1 的刻意决定，不是冗余：web 上唯一能断的
 *    只有样式自比较，两条独立通道意味着任一被误删都会红。🚫 MUST NOT 因为「看起来重复」
 *    把这条断言删掉 —— 删了之后底色回退成透明，e2e 一声不吭。
 */
async function tabSurfaceOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

const TAB_KEYS = ['all', 'build', 'rent'] as const;

/** 选中的那个 Tab 与另外两个**视觉可分**（不置灰 ≠ 看不出选中）。 */
async function expectTabSelected(page: Page, selected: (typeof TAB_KEYS)[number]): Promise<void> {
  const tabAt = (t: (typeof TAB_KEYS)[number]) =>
    page.getByTestId(`optionsdesk-detail-leg-tab-${t}`);
  const styles = await Promise.all(TAB_KEYS.map((t) => textStyleOf(tabAt(t))));
  const surfaces = await Promise.all(TAB_KEYS.map((t) => tabSurfaceOf(tabAt(t))));
  const target = styles[TAB_KEYS.indexOf(selected)];
  const targetSurface = surfaces[TAB_KEYS.indexOf(selected)];
  for (const [i, key] of TAB_KEYS.entries()) {
    if (key === selected) continue;
    expect(styles[i], `Tab ${key} 与选中的 ${selected} 呈现一致 —— 选中态看不出来`).not.toBe(
      target,
    );
    expect(
      surfaces[i],
      `Tab ${key} 与选中的 ${selected} 底色一致 —— 稿 A 的第二重编码（选中格 sunken 底）没了`,
    ).not.toBe(targetSurface);
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
  const lastCode = legs[ROWS - 1]?.leg.code ?? '';
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
//
// ── 🚨 049 T005 判据换代（FR-001/003, SC-002/003, plan D-TEST-2）──────────────
//   047 版靠 `horizontalScroll()` 读 `scrollLeft` / `scrollWidth`，并用
//   `page.mouse.wheel(400, 0)` 驱动。E 范式（单 `Gesture.Pan` → 单共享位移 → `translateX`）
//   下**两者双双失效，且失效方式不同**：
//     · 没有 DOM 滚动容器了 ⇒ `scrollWidth − clientWidth` 恒 0，那条「前提自检」直接判「没
//       溢出」，测试红在前提上（不是红在被测行为上）；
//     · 滚轮不驱动 RNGH 的 `Gesture.Pan` ⇒ 就算换个读法，也没有位移可读。
//   ⇒ 换成**指针分步拖拽 + `boundingBox()` 位移差**。这套判据不依赖滚动容器、也不依赖
//   `translateX` 这个特定手段 —— 它问的是「屏幕上那一列有没有挪到该在的位置」，
//   所以换范式不脆。
// ════════════════════════════════════════════════════════════════════════════

test('049 T005 — US2-AS6（判据换代）：指针拖拽露出隐藏列、表头与行同列同步、首列钉住、纵滚不带跑横向位移（手势零争用）', async ({
  page,
}) => {
  const legs = manyLegs(24);
  const code = legs[0]?.leg.code ?? '';
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: { 'us:PEP': makeLegTable('us:PEP', legs) },
  });
  await openDetail(page, 'us:PEP');

  const row = page.getByTestId(rowId(code));
  // 表头与数据行各自的**位移载体**（宽 628 的内容层）：它们的屏幕左缘之差就是两者的位移差。
  const rowPane = page.getByTestId(rowScrollerId(code));
  const headerPane = page.getByTestId(HEADER_SCROLLER);
  // 🚨 051 FR-019a 起首列的探针换成**首列槽位本身** —— 原来锚的口径徽标已整条撤除，
  //    而且它当年就是个条件渲染（只在全腿 Tab 出），拿它测「钉住」本就多一个前提。
  const stickyBadge = page.getByTestId(`optionsdesk-detail-leg-sticky-${code}`);
  const actionCell = page.getByTestId(actionId(code));

  // 把首行滚进视口（拖拽必须落在真实元素上）。
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();

  const rowBox = await row.boundingBox();
  const actionBefore = await actionCell.boundingBox();
  if (rowBox === null || actionBefore === null) throw new Error('行 / 动作列尺寸不可得');

  // 🚨 **前提自检**（Guardrail 8）：拖拽前「动作」列确在视区外。视口一宽这条就不成立，
  //    而下面「左移 / 露出来」的断言会**恒真** —— 这是这类断言最常见的假绿。
  expect(actionBefore.x, '「动作」列初始就露着（视口太宽）：横滑判据会恒真').toBeGreaterThan(
    rowBox.x + rowBox.width,
  );

  const paneBefore = await boxX(rowPane);
  const headerBefore = await boxX(headerPane);
  const stickyBefore = await boxX(stickyBadge);
  const verticalBefore = await verticalScroll(page);
  expect(Math.abs(headerBefore - paneBefore), '零位移时表头与数据行就没对齐').toBeLessThanOrEqual(
    1,
  );

  // ── 横滑：指针**分步**拖拽（一步到位跨不过 `activeOffsetX(12)` 的方向仲裁）──────
  await dragHorizontally(page, row, -300);
  const paneAfter = await settledX(page, rowPane);

  // ① 列区真的左移了 —— 位移只从屏幕坐标读，不读任何滚动量。
  expect(paneAfter, '拖了但列区没动（指针没驱动 Pan / 位移没落到列区）').toBeLessThan(
    paneBefore - 1,
  );

  // ② 表头与数据行同列左缘 ≤1px（两者共读同一个 `tx`；SC-002 的 web 侧判据）。
  const headerAfter = await boxX(headerPane);
  expect(Math.abs(headerAfter - paneAfter), '表头与数据行横向位移不同步').toBeLessThanOrEqual(1);

  // ③ 隐藏列露出来了，且确实是那一列（文案对得上）。
  const actionAfter = await actionCell.boundingBox();
  if (actionAfter === null) throw new Error('动作列尺寸不可得');
  expect(actionAfter.x, '横滑后「动作」列仍在视区外').toBeLessThan(rowBox.x + rowBox.width);
  await expect(actionCell).toHaveText(COPY.actionPlaceOco);

  // ④ 首列钉住 —— 它渲在位移区之外，一像素都不该动（FR-002）。
  expect(
    Math.abs((await boxX(stickyBadge)) - stickyBefore),
    '首列跟着横滑跑了（没钉住）',
  ).toBeLessThanOrEqual(1);

  // ── 🚨 手势零争用：在**同一个点**（刚拖过的那一行）发纵向滚轮 ────────────
  //    Guardrail 10 那个坑（`SectionList` 塞回同向 `ScrollView`）在 RN 只打 dev warning，
  //    typecheck / lint / 单测 / CI 全绿 —— 只有这条断言能照出来。
  await wheelOver(page, row, 0, 600);
  await expect
    .poll(async () => (await verticalScroll(page)).top, { timeout: 5_000 })
    .toBeGreaterThan(verticalBefore.top);

  // ⑤ 方向正交：纵滚不该把横向位移带跑（SC-003 的 web 侧判据）。
  expect(
    Math.abs((await boxX(rowPane)) - paneAfter),
    '纵向滚动把横向位移带跑了（两个方向在抢同一个响应者）',
  ).toBeLessThanOrEqual(1);
});

// ════════════════════════════════════════════════════════════════════════════
// ②b 049 T004 —— 横向指示条（FR-005 / FR-006 / spec Edge Case ①）
// ════════════════════════════════════════════════════════════════════════════

test('049 T004 — 横向指示条：轨道左端对齐首列右缘、thumb 长度比 = 可视宽/内容宽、随同一个 tx 右移、拖到底贴右缘（FR-005/FR-006）', async ({
  page,
}) => {
  const legs = manyLegs(8);
  const code = legs[0]?.leg.code ?? '';
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: { 'us:PEP': makeLegTable('us:PEP', legs) },
  });
  await openDetail(page, 'us:PEP');

  const bar = page.getByTestId(SCROLLBAR);
  const thumb = page.getByTestId(SCROLLBAR_THUMB);
  const row = page.getByTestId(rowId(code));
  // 拖拽要落在真实元素上 ⇒ 先把行滚进视口（指示条在 sticky 表头栈里，滚了也仍在）。
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  await expect(bar, '有可滑动余量却看不到指示条（FR-005 要求常显）').toBeVisible();
  await expect(thumb).toBeVisible();

  const rowBox = await row.boundingBox();
  const trackBox = await bar.boundingBox();
  const thumb0 = await thumb.boundingBox();
  if (rowBox === null || trackBox === null || thumb0 === null) throw new Error('指示条尺寸不可得');

  // ① 轨道左端与首列右缘对齐 ⇒ 轨道宽 = 横滑可视宽 ⇒ 长度比即列宽比，无需二次换算。
  expect(
    Math.abs(trackBox.x - (rowBox.x + LEG_STICKY_COL_WIDTH)),
    '轨道左端没对齐首列右缘 —— 长度比会跟着错',
  ).toBeLessThanOrEqual(1);

  // ② 前提自检：真的有溢出（轨道窄于内容），否则下面全套断言毫无意义。
  expect(trackBox.width, '轨道宽 ≥ 内容宽：视口太宽，指示条验不到').toBeLessThan(
    LEG_SCROLL_REGION_WIDTH,
  );

  // ③ 长度比 = 可视宽 / 内容宽（thumb 宽 = 轨道宽² / 内容宽）。
  expect(
    Math.abs(thumb0.width - (trackBox.width * trackBox.width) / LEG_SCROLL_REGION_WIDTH),
    `thumb 宽 ${thumb0.width} 与列宽比不符（轨道 ${trackBox.width} / 内容 ${LEG_SCROLL_REGION_WIDTH}）`,
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(thumb0.x - trackBox.x), '初始位移为 0，thumb 应贴轨道左端').toBeLessThanOrEqual(
    1,
  );

  // ④ 拖一段 ⇒ thumb 往右走（位置由驱动表格的同一个 tx 派生，FR-006）。
  await dragHorizontally(page, row, -120);
  const thumbAfter = await settledX(page, thumb);
  expect(thumbAfter, '拖了列，thumb 没跟着右移').toBeGreaterThan(thumb0.x + 1);

  // ⑤ 拖到底 ⇒ thumb 右缘贴轨道右缘（多次拖到位移不再变化为止）。
  let last = thumbAfter;
  for (let i = 0; i < 8; i++) {
    await dragHorizontally(page, row, -280);
    const now = await settledX(page, thumb);
    if (Math.abs(now - last) <= 0.5) break;
    last = now;
  }
  const thumbEnd = await thumb.boundingBox();
  if (thumbEnd === null) throw new Error('thumb 尺寸不可得');
  expect(
    Math.abs(thumbEnd.x + thumbEnd.width - (trackBox.x + trackBox.width)),
    '滑到最右后 thumb 没贴右缘',
  ).toBeLessThanOrEqual(1);
});

test('049 T004 — 无横向溢出（宽视口）⇒ 指示条整条不渲染 **且** 拖拽不产生位移（spec Edge Case ①，两件事都要验）', async ({
  page,
}) => {
  // 🚨 宽到 12 列全部装得下 ⇒ 合法域退化成一个点。**只验「不渲染」会漏掉「没有余量却仍能拖动」**。
  await page.setViewportSize({ width: 1024, height: 844 });
  const legs = manyLegs(8);
  const code = legs[0]?.leg.code ?? '';
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: { 'us:PEP': makeLegTable('us:PEP', legs) },
  });
  await openDetail(page, 'us:PEP');

  const row = page.getByTestId(rowId(code));
  const actionCell = page.getByTestId(actionId(code));
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();

  // 前提自检：末列已完整露出 ⇒ 确无可滑动余量（这条不成立时下面两条都会假绿）。
  const rowBox = await row.boundingBox();
  const actionBox = await actionCell.boundingBox();
  if (rowBox === null || actionBox === null) throw new Error('行 / 动作列尺寸不可得');
  expect(
    actionBox.x + actionBox.width,
    '末列仍在视区外：视口不够宽，无溢出前提不成立',
  ).toBeLessThan(rowBox.x + rowBox.width + 1);

  // ① 整条不渲染。📌 这一条单独看会「元素不存在也通过」—— 它与上一条（有溢出时**必须**看得见）
  //    成对才有意义，别只留这一条。
  await expect(page.getByTestId(SCROLLBAR), '无可滑动余量时指示条仍在（FR-005）').toBeHidden();
  await expect(page.getByTestId(SCROLLBAR_THUMB)).toBeHidden();

  // ② 拖拽不产生位移 —— clamp 后合法域是一个点，怎么拖都回到 0。
  const before = actionBox.x;
  await dragHorizontally(page, row, -300);
  const after = await settledX(page, actionCell);
  expect(Math.abs(after - before), '没有横向余量却拖出了位移（clamp 越界）').toBeLessThanOrEqual(1);
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

  // ① 区块级时点：**收盘档 + 当期这一格已与 064 档位条去重**（2026-08-19）—— 两处原本都在说
  //    「TODAY 的收盘」，同屏说两遍。SC-003 要的「每处读数带可见时点」在这一格由档位条承担，
  //    所以断言换成「区块头那行不渲染 + 档位条确实给出同一个交易日」。
  //    🚨 别把这条改回「区块头有文字」—— 那正是被去掉的那份重复。陈旧 / 无时点 / 实时三态
  //    区块头照渲，各自的断言在下面两个用例里。
  await expect(
    page.getByTestId('optionsdesk-detail-leg-asof'),
    '收盘档 + 当期仍渲区块头 asOf —— 与档位条同屏说了两遍同一个日期',
  ).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-tier-stamp')).toHaveText(TODAY.slice(5));

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
      // 对照组：同一份腿、当期档。🚨 走**实时档**（`快照 X`）—— 收盘档 + 当期那一格的区块头
      // 已与档位条去重、不渲染（断言在 SC-003 用例），拿它当比色基线会取到一个不存在的元素。
      'us:AOS': makeLegTable('us:AOS', legs, { priceKind: 'realtime' }),
      // 🚨 档位由 **server** 下发（客户端拿设备本地日期自判对美股恒为真 ⇒ 等于没有告警）。
      'us:PEP': makeLegTable('us:PEP', legs, { asOf: LAST_WEEK, asOfFreshnessTier: 'STALE' }),
    },
  });

  // ── 对照组：当期档，无后缀（实时档下区块头说的是**库内快照的归属日**）────────────
  await openDetail(page, 'us:AOS');
  const currentAsOf = page.getByTestId('optionsdesk-detail-leg-asof');
  await expect(currentAsOf).toHaveText(`${COPY.snapshotPrefix}${TODAY}`);
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
    anchors: [
      makeAnchor({ id: '1', ticker: 'us:AOS' }),
      makeAnchor({ id: '2', ticker: 'us:PEP' }),
      makeAnchor({ id: '3', ticker: 'hk:00291' }),
    ],
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
      // 有当期快照，但这只票一条适格腿都没有 —— `available` + 空集合，**不是一个 state**。
      'us:PEP': makeLegTable('us:PEP', []),
      // #361: 交易所根本没给这只挂期权 —— 与上面「还没轮到」**方向相反**，一个该等一个该走。
      // 🚨 取真实样本 hk:00291（华润啤酒）：HKEX《The List of Stock Option Classes Available
      //    for Trading》(2026-09-01, 154 classes) 里按代码与中英名双角度均无它。
      'hk:00291': makeLegTable('hk:00291', [], {
        state: 'no_listed_options',
        asOf: null,
        asOfFreshnessTier: 'UNAVAILABLE',
        quoteAsOf: null,
        oiAsOf: null,
        source: null,
      }),
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
  // 🚨 #361 反例：**这一帧的档位条必须还在** —— 「还没采到」是过程态，「未就绪 / 下拉可重试」
  //    对它成立，下拉真可能把链取来。下面那帧才是该关的那一格。
  await expect(page.getByTestId('optionsdesk-detail-leg-tier')).toBeVisible();

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

  // ── #361 没有挂牌期权：第三句文案，与「未就绪」两两不同 ────────────────
  await openDetail(page, 'hk:00291');
  await expect(page.getByTestId('optionsdesk-detail-leg-no_listed_options')).toHaveText(
    COPY.noListedOptions,
  );
  // 🚨 **另外两支一个都不许同时在** —— 合并回去的表现正是这里多出一个。
  await expect(page.getByTestId('optionsdesk-detail-leg-chain_not_ready')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-empty')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-read_failed')).toHaveCount(0);
  // 🚨 终态**不给重试** —— 它是事实不是故障。
  await expect(page.getByTestId('optionsdesk-detail-leg-retry')).toHaveCount(0);
  // 面板照常可读（同「未就绪」帧的纪律：换成因不换形态）。
  await expect(page.getByTestId('optionsdesk-detail-leg-tabs')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-table-header')).toBeVisible();
  // 🚨 #361 收尾：档位条**整条不出现**。没有挂牌期权就没有「这一批」报价，它无题可答；
  //    留着的话它落兜底支渲成「未就绪 · 下拉可重试」，而下拉永远取不来 —— 与 #362 拔掉的
  //    那句假承诺同病，且就压在上面那句正确文案的正上方，两句话当场打架。
  await expect(page.getByTestId('optionsdesk-detail-leg-tier')).toHaveCount(0);
  // 🚫 连带的刷新按钮也不该在（终态不给无效动作）。
  await expect(page.getByTestId('optionsdesk-detail-leg-tier-refresh')).toHaveCount(0);
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

test('047 T035 — US3-AS2：未选水位时三个视角 **全部可进入读表**（不置灰不隐藏），并就地注明未选与「成员集合不变」', async ({
  page,
}) => {
  const rentCode = 'PEP261218P75000';
  const buildCode = 'PEP260814P80000';
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    legs: {
      'us:PEP': makeLegTable('us:PEP', [
        makeLeg({ code: rentCode, perspectives: ['all', 'rent'] }),
        makeLeg({
          code: buildCode,
          strike: '80.00',
          expiryDate: '2026-08-14',
          basis: 'weekly',
          tier: 'acceptable',
          perspectives: ['all', 'build'],
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

  // 全腿：两条都在。
  await expect(page.getByTestId(rowId(rentCode))).toBeVisible();
  await expect(page.getByTestId(rowId(buildCode))).toBeVisible();
  // 🚨 051 FR-019a —— 腿族口径徽标**已不存在**（原 047 断言它标「年」/「周」）。撤除的理由与
  //    空间无关：它的取值其实是 Tab 成员关系、却顶着口径形状的标签，而全腿视角档位恒年化。
  for (const code of [rentCode, buildCode]) {
    await expect(page.getByTestId(`optionsdesk-detail-leg-basis-${code}`)).toHaveCount(0);
  }

  // 三个 Tab 一个都不置灰（不置灰 ≠ 有内容，两件事各断各的）。
  for (const tab of TAB_KEYS) {
    await expect(
      page.getByTestId(`optionsdesk-detail-leg-tab-${tab}`),
      `${COPY.tabs[tab]} Tab 被禁用了`,
    ).toBeEnabled();
  }

  // 建仓视角：可进入且读得到表。
  await page.getByTestId('optionsdesk-detail-leg-tab-build').tap();
  await expectTabSelected(page, 'build');
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(1));
  await expect(page.getByTestId(rowId(buildCode))).toBeVisible();
  await expect(page.getByTestId(rowId(rentCode))).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-bucket_unset')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-rent_depth_union')).toHaveCount(0);

  // 收租视角：可进入 + **额外**注明「成员集合不变、只是零推荐标」（051 FR-020 订正了这条措辞）。
  await page.getByTestId('optionsdesk-detail-leg-tab-rent').tap();
  await expectTabSelected(page, 'rent');
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(1));
  await expect(page.getByTestId(rowId(rentCode))).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-rent_depth_union')).toHaveText(
    COPY.rentDepthUnionNote(COPY.fitBadge),
  );

  // 回到全腿：两条又都在（切 Tab 只换 `section.data`，不重建列表）。
  await page.getByTestId('optionsdesk-detail-leg-tab-all').tap();
  await expect(page.getByTestId('optionsdesk-detail-leg-count')).toHaveText(COPY.rowTotal(2));
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦b 049 T007 —— sticky 栈高预算（最坏档：未选水位 ⇒ 同屏两条就地注明）
// ════════════════════════════════════════════════════════════════════════════

/**
 * plan D-TAB-4 的净高预算：计数 26 + 意图水位 44 + Tab 40 + 列头 30 + 指示条 2 = **142**；
 * 最坏档（未选水位 ⇒ 同屏两条就地注明，+40）= **182**。
 * RN 侧字体度量与 padding 解析与 mockup 有 ±2px/元素的出入（`design/handoff.md` 注 6），
 * 6 个元素 ⇒ 留 12px 余量。**余量是给度量差的，不是给「再加一行」的** —— 任一行做厚 ~13px 就红。
 */
const STACK_BUDGET_WORST = 182 + 12;

/**
 * 连滚到 sticky 栈钉住：栈顶 y 连续两轮不再上移即为已钉（**不依赖具体 pin 位置**，
 * 免得写死一个 y 阈值，屏 chrome 一改就假红）。返回钉住后的栈顶 y。复杂度 O(steps)。
 */
async function scrollUntilStackPinned(page: Page, stackTop: Locator): Promise<number> {
  const vp = page.viewportSize();
  if (vp === null) throw new Error('viewport 尺寸不可得');
  let prev = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 30; i++) {
    const y = (await boxOf(stackTop)).y;
    if (y >= prev - 0.5) return y;
    prev = y;
    await page.mouse.move(vp.width / 2, vp.height * 0.7);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(120);
  }
  throw new Error('滚了 30 屏 sticky 栈仍未钉住');
}

/**
 * 049 T007 —— 栈高回归（`FR-011` / `SC-006`，plan D-TAB-4）。
 *
 * 🚨 **这条量的是 sticky 栈净高本身，不是「看得见几行」** —— 后者在本文件的 390×844 视口下
 *    **没有鉴别力，实测数字如下**：栈顶钉在 y=64（其上是屏 chrome），栈净高 185px、栈底 249px
 *    ⇒ 栈底至视口底剩 **595px = 12.4 行**（@48px）。要让「数据区 < 3 行」成立，栈净高需
 *    **> 636px**（= 844 − 64 − 144），是预算的 **3.4 倍** —— 任何合理实现都到不了 ⇒ 写成
 *    「≥3 行」就是一条恒真断言（tasks.md T007 的 🚫 明令不许凑）。
 *    ✅ 实证（2026-08-11 本条落地时跑的对照）：把 Tab 行 `py-sm` 改厚成 `py-lg`（+32px）⇒
 *       ④ 当场红（217 > 194），而同一轮里「可见行数」仍有 **11.7 行**、「≥3 行」照样绿 ——
 *       这就是那条断言零鉴别力的直接证据，不是推理。
 *    📌 **「数据区 ≥3 行」的判决挪 T008 M8（真机验收）** —— 真机可用高度比 web 视口紧
 *       （状态栏 / 手势条 / 系统字号放大都吃高），那里才有鉴别力。web 侧量出来的行数不能
 *       当真机结论（文件头「验不到」清单第 5 条）。
 *
 * 🚨 **051 T008 起「最坏档」这个概念本身没了** —— 两条就地注明移出 sticky 栈、落到腿列表之后
 *    的非常驻区（FR-010a）⇒ 栈高不再随注明条数变，本条量的恒是常态档，预算 `STACK_BUDGET_WORST`
 *    从此带余量。① 因此改判：同一份数据（未选水位 × rent），断言两条注明**在栈外**。
 *    📌 预算数字不在本片下调 —— 该由 T013 真机实测定（web 视口的读数不能当真机结论）。
 *
 * 断言四项（前两项是**前提自检**，缺了后两项就会在错误的坐标系上恒真）：
 *   ① 两条就地注明渲出来了、且**落在 sticky 栈之外**（051 FR-010a）。
 *   ② 真的滚进腿区：栈顶较未滚时上移 > 100px（否则量的是「没滚动时的布局」）。
 *   ③ sticky 生效：滚到底部行之后 12 列表头仍可见，且仍在栈内（`FR-011` 的前提）。
 *   ④ 栈净高（计数条顶 → 指示条底）≤ 预算。
 */
test('049 T007 — 栈高最坏档（未选水位 · 同屏两条就地注明）：纵滚到腿区后表头仍钉在顶，sticky 栈实测净高不超预算', async ({
  page,
}) => {
  const legs = manyLegs(24);
  await installLegMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:PEP' })],
    // 水位未选（`makeLegTable` 基线即 `positionBucket: null`）⇒ 就地注明才会渲出来。
    legs: { 'us:PEP': makeLegTable('us:PEP', legs) },
  });
  await openDetail(page, 'us:PEP');
  // 第二条注明（成员集合不变、只是零推荐标）只在收租视角出现 —— 最坏档 = 未选水位 × rent。
  await page.getByTestId('optionsdesk-detail-leg-tab-rent').tap();

  // ① 前提自检：两条注明确实渲出来了（未选水位 × rent 才有第二条）。
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-bucket_unset')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-notice-rent_depth_union')).toBeVisible();

  const stackTop = page.getByTestId('optionsdesk-detail-leg-header');
  const yBefore = (await boxOf(stackTop)).y;
  const yPinned = await scrollUntilStackPinned(page, stackTop);

  // ② 前提自检：确实滚进了腿区（046 三块已滚出去），不是在原始布局上量。
  expect(
    yBefore - yPinned,
    '栈顶几乎没上移 —— 压根没滚进腿区，后面的数都是原始布局的',
  ).toBeGreaterThan(100);

  // ③ sticky 生效：滚到腿区之后 12 列表头仍可见，且仍在栈内（栈顶下方、视口内）。
  const header = page.getByTestId('optionsdesk-detail-leg-table-header');
  await expect(header).toBeVisible();
  const headerBox = await boxOf(header);
  expect(headerBox.y, '12 列表头跟着列表滚走了 —— sticky 栈没钉住').toBeGreaterThanOrEqual(yPinned);

  // ④ 栈净高 = 计数条顶 → 指示条底（= plan D-TAB-4 逐项相加的那一段，不含屏 chrome）。
  const barBox = await boxOf(page.getByTestId('optionsdesk-detail-leg-scrollbar'));
  const stackHeight = barBox.y + barBox.height - yPinned;

  // 🚨 051 FR-010a：两条注明落在**栈底之下**（跟着内容滚，不占常驻区）。
  //    没有这一条，「注明移出去了」就只是提交信息里的一句话 —— 栈高预算带余量后不会有人发现它搬回来。
  for (const key of ['bucket_unset', 'rent_depth_union']) {
    const noticeBox = await boxOf(page.getByTestId(`optionsdesk-detail-leg-notice-${key}`));
    expect(
      noticeBox.y,
      `就地注明 ${key} 还在 sticky 栈内 —— FR-010a 要求它随内容滚`,
    ).toBeGreaterThan(barBox.y + barBox.height);
  }
  const vp = page.viewportSize();
  if (vp === null) throw new Error('viewport 尺寸不可得');
  expect(
    stackHeight,
    `sticky 栈实测净高 ${stackHeight.toFixed(1)}px 超出最坏档预算 ${STACK_BUDGET_WORST}px` +
      `（视口 ${vp.width}×${vp.height}，栈底至视口底剩 ${(vp.height - barBox.y - barBox.height).toFixed(1)}px）`,
  ).toBeLessThanOrEqual(STACK_BUDGET_WORST);
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
          perspectives: ['all', 'build'],
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
  const code = legs[0]?.leg.code ?? '';
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
