import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  AnchorResponse,
  DailyBarItem,
  LegTableResponse,
  ThermometerUnderlyingRowResponse,
  UnderlyingIvReadoutResponse,
  UsIndexReadoutResponse,
  VvixVixRatioResponse,
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

// 046 T024 — 标的详情（上半）+ 波动温度计 hermetic UI e2e（Playwright Expo Web，
// Constitution §V 两层验证之一；样板 = `optionsdesk-anchors-radar.spec.ts`）。
//
// 覆盖（逐条对应 tasks.md 的 task 编号）：
//   ① **T028 / US1-AS1** —— 从雷达点该行 → 详情屏三块（锚卡 / 个股温度计区块 / 区间时序）可见
//   ② **T021 常态** —— 三块各带**各自的** asOf（FR-020 / SC-002）+ IVP 徽标档 + 全景入口通 P7
//   ③ **T021 锚卡异常** —— 详情端点 5xx ⇒ 只降级锚卡那一块，序列照常（**禁整页失败**）
//   ④ **T021 温度计降级** —— IV「分位不可算」⇒ 区块仍渲染、无数值、**无提醒徽标**（FR-036）
//   ⑤ **T021 序列降级** —— 序列 5xx / 空 ⇒ 折线区显式降级，**四区间带照常**（边界只依赖锚）
//   ⑥ **T021 无锚态** —— 深链进无锚标的 ⇒ 「尚未建锚」+ 建锚入口（禁空白页 / 禁报错页）
//   ⑦ **T020 + T021 窗口切换** —— 切 10Y ⇒ 请求粒度/起点随档变、**四区间边界不变**、长窗标实际起点
//   ⑧ **T022 温度计四态** —— 常态 / VIX 不可得 / VVIX 不可得 / 基准不一致 + 零锚列表空态
//   ⑨ **T022 / FR-019 文案断言（唯一机械载体）** —— 「不构成开仓理由」**常驻可见且非折叠非
//      tooltip**：初始态可见 · 滚到底仍可见 · 整体失败态仍可见（三处都在 = 「常驻」的判据）
//   ⑩ **T023 / FR-021 · US4-AS1 文案断言（唯一机械载体）** —— 雷达题头 🌡 可点直达 P7，
//      且雷达页内**不再出现「即将可用」字样**
//
// ── 🚨 markets OFF 深链拦截**不在本文件** ────────────────────────────────────
//   `playwright.markets-off.config.ts` 的 `testMatch` 锁死 `markets-feature-gate.spec.ts`
//   一个文件（主套件反向 `testIgnore` 它，两侧对称隔离）。两条新深链的 OFF 断言已由 T023
//   加进那边并跑绿（`nx run mobile:e2e-public`）。**写在本文件里 = 在 ON bundle 下跑，
//   永远验不到 OFF，且不会红。**
//
// ── hermetic mock 纪律（per docs/conventions/mobile-impl-playbook.md §6）────────
//   mock 写**依赖方（server）契约**：持一份 canonical 状态（锚表 + 逐票 IV + 两个指数 +
//   逐票上市首日），handler 是 `(request, canonical 状态) → response` 的纯函数 ——
//   雷达空态三分 / 比值基准判定 / bars 按 `from`·`to`·上市首日裁剪，全按 server 口径复算。
//   **禁**按测试编排标志分支：各 test 传**不同的 canonical 数据**（= 换一份 DB 内容），
//   `outage` 表达的是「上游真的挂了」这一服务端状态，不是「按测试名分叉」。
//
// ── Expo web e2e 六坑（memory expo_web_e2e_and_router_footguns）────────────────
//   · `page.goBack()` 被嵌套 Stack 重映射 ⇒ 本 spec 一律深链 `page.goto` / 屏内入口跳转，
//     不驱 goBack。
//   · `(group)` 段在 URL 隐藏（`/(app)/optionsdesk/underlying/us%3AAOS` → `/optionsdesk/…`）；
//     tab 需 `hasTouch` + `role=tab`（config 已开）。
//   · 叠屏 DOM 双命中 ⇒ 一律 `getByTestId` 精确定位，文案断言收窄到具体节点内。
//   · `symbol` 是 canonical `market:code`，路径段里冒号转义（`us%3AAOS`）—— 深链照此写。
//
// ── auth 范式 ────────────────────────────────────────────────────────────────
//   seed localStorage（含 accessToken）→ boot GET /me 必拦；**refresh-token 也必拦**，
//   否则任一 authed 401 触发 003 拦截器 retry-once 失败 → clearSession 误登出。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const BARS_RE = /\/api\/v1\/marketdata\/instruments\//;

const SEED_ACCOUNT_ID = 'acc-e2e-046';
const SEED_ACCESS_TOKEN = 'access-e2e-046';
const SEED_REFRESH_TOKEN = 'refresh-e2e-046';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139046';

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

// ════════════════════════════════════════════════════════════════════════════
// 日期口径（与 `~/format/as-of` 的 `todayYmd` / rules 的 `windowStartDate` 同口径）
// ════════════════════════════════════════════════════════════════════════════

function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 本地日历日 —— 屏内 `todayYmd()` 的窗口起点基准（新鲜度档改由 mock 显式下发）。 */
const TODAY = ymd(new Date());

/** 窗口起点：today 减 N 年，UTC 求值（与 `underlying-detail.rules.windowStartDate` 逐字同算）。 */
function ymdMinusYears(today: string, years: number): string {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC((y ?? 1970) - years, (m ?? 1) - 1, d ?? 1)).toISOString().slice(0, 10);
}

function ymdMinusDays(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const YESTERDAY = ymdMinusDays(TODAY, 1);

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
  // 🚨 新鲜度档由 **server** 下发 (FR-020, 判据要查交易日历) —— hermetic mock 是契约镜像,
  // 必须照带。客户端不再拿设备本地日期自判, 所以这个值与 `lastCloseDate` 是否等于今天无关。
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

function makeIv(over: Partial<UnderlyingIvReadoutResponse> = {}): UnderlyingIvReadoutResponse {
  return {
    state: 'available',
    aggregateIv: '32.4',
    ivPercentile: '78.0',
    asOf: YESTERDAY,
    freshnessTier: 'STALE', // 停在昨日一场 ⇒ server 判陈旧 (与 asOf 一致的镜像值)
    ...over,
  };
}

/** 从未采到 —— 非 available 态一律 null 值（server 侧同约束，**禁回落 0**，FR-014）。 */
const IV_MISSING: UnderlyingIvReadoutResponse = {
  state: 'missing',
  aggregateIv: null,
  ivPercentile: null,
  asOf: null,
  freshnessTier: 'UNAVAILABLE',
};

function makeIndex(over: Partial<UsIndexReadoutResponse> = {}): UsIndexReadoutResponse {
  return { state: 'available', close: '18.20', asOf: YESTERDAY, freshnessTier: 'CURRENT', ...over };
}

const INDEX_MISSING: UsIndexReadoutResponse = {
  state: 'missing',
  close: null,
  asOf: null,
  freshnessTier: 'UNAVAILABLE',
};

/** server 的空态三分（`get-radar.usecase`：baseTotal → pageItems → actionableTotal）。 */
const EMPTY_STATE_MESSAGES = {
  zero_anchors: '还没有锚 —— 先去锚管理建第一个锚',
  filtered_empty: '当前筛选无结果',
  all_idle: '今日无解，空仓是常态',
} as const;

/** 屏内文案（`optionsdesk-copy.ts` 逐字；改文案就该在这里红）。 */
const COPY = {
  disclaimer: '不构成开仓理由',
  comingSoon: '即将可用',
  anchorCardFailed: '锚卡读取失败',
  noAnchor: '该标的尚未建锚',
  positionLevelPending: '未知 · 待接入',
  percentileUnavailable: '分位不可算',
  seriesEmpty: '该标的暂无日线序列',
  seriesFailed: '行情读取失败',
  window1YLabel: '日 K · 近 1 年',
  gaugeUnavailable: '显示不可用',
  ratioBasisMismatch: '基准不一致 · 不计算',
  ratioMissing: '不可用 · 缺一侧数据',
  listEmpty: 'IVP 列表为空',
  thermometerFailed: '温度计加载失败',
  excluded: '已排除',
} as const;

interface DeskFixture {
  /** 锚表（雷达 / 详情 / 温度计列表**同一份**来源）。 */
  anchors: AnchorResponse[];
  /** 逐票 IV 读数；缺键 = 该票从未采到 ⇒ `missing` 态。 */
  iv?: Record<string, UnderlyingIvReadoutResponse>;
  vix?: UsIndexReadoutResponse;
  vvix?: UsIndexReadoutResponse;
  /** 逐票上市首日（bars 按它裁剪）；缺键 = 10 年历史。晚于 today ⇒ 该票无日线。 */
  listedFrom?: Record<string, string>;
  /**
   * 047 T031 —— 逐票的 canonical 腿册（详情屏下半的 `section.data` 来源）。缺键 = 该票有当日
   * 快照且两条腿（{@link DEFAULT_BOOK}）。选约表的**全量态 / 空态 / 未就绪态**由 047 自己的
   * e2e（T035）逐帧覆盖；本文件只保证 046 三块无回归 + 选约区块确实渲染出来了。
   * 📌 053 起持有的是**跨视角**腿册而非一张表 —— 一次请求只作答一个视角，投影在 handler 里。
   */
  legs?: Record<string, readonly CanonicalLeg[]>;
  /** 上游故障 —— 服务端**状态**（真的 5xx），不是「按测试名分叉」的编排标志。 */
  outage?: { detail?: boolean; thermometer?: boolean; bars?: boolean };
}

/**
 * 047 选约表的默认两条腿 —— 一条收租（年化口径）、一条建仓（周化口径）。
 *
 * 🚨 **053 FR-005 起「这条腿属于哪些视角」不在契约里**（每腿 `tabs` 已删，一次请求只作答一个
 *    视角）—— 但 fixture 仍要持有它：被 mock 的那个服务端正是按请求参数投影出一份来答的。
 *    落点改成 {@link CanonicalLeg}，投影走 {@link projectLegs}。
 * 🚨 每腿 `tierByTab` 同理收窄成一份 `tier`；这两条腿在其所属视角同档，故走 `tierBy` 显式给。
 * 🚨 **`oiAsOf` 与区块级 `asOf` 故意不是同一天**（OI 盘前更新 ⇒ 归属 T−1）。
 */
const DEFAULT_BOOK: readonly CanonicalLeg[] = [
  {
    perspectives: ['all', 'rent'],
    tierBy: { all: 'good', rent: 'good' },
    leg: {
      code: 'AOS261218P75000',
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
    },
  },
  {
    perspectives: ['all', 'build'],
    tierBy: { all: 'acceptable', build: 'acceptable' },
    leg: {
      code: 'AOS260814P80000',
      strike: '80.00',
      expiryDate: '2026-08-14',
      dteDays: 11,
      ...quoted('1.15', '1.30'),
      bidSize: 12,
      askSize: 18,
      basis: 'weekly',
      periodRate: '0.014589',
      weeklyRate: '0.009284',
      annualizedRate: '0.484067',
      tier: 'acceptable',
      askRate: null,
      effectiveCost: '78.85',
      effectiveCostVsWPct: '-1.44',
      absDelta: 0.45,
      sigmaDistance: 0.13,
      openInterest: 880,
      volume: 41,
      turnover: '4715.00',
      activity: null,
      isRecommended: false,
      isMonthlyChain: false,
      // 建仓域**恒无标**（`null` 与 `no_date` 是两个值，UI 上一个「—」一个虚线 chip）。
      earningsMark: null,
      greeksComplete: true,
      // 064 `FR-009`: 档位。mock 后端默认收盘档, 实时档的呈现分支归 T011 自己的用例。
      priceKind: 'eod_close',
    },
  },
];

/**
 * 该票**某一个视角**的选约表 —— 缺省腿册 = 有当日快照 + 两条腿。
 * 🚨 053 FR-005：一次请求只作答一个视角 ⇒ `legs` / `tier` / `basis` / `criteria` / 三个计数
 *    全部按 `perspective` 投影，🚫 MUST NOT 把三份并列下发。
 */
function makeLegTable(
  symbol: string,
  anchor: AnchorResponse,
  perspective: LegPerspective,
  book: readonly CanonicalLeg[],
): LegTableResponse {
  const legs = projectLegs(book, perspective);
  return {
    symbol,
    perspective,
    state: 'available',
    asOf: TODAY,
    // 档位由 **server** 判（T027a）；这里给当期态。「陈旧」那一档的帧归 T035。
    asOfFreshnessTier: 'CURRENT',
    quoteAsOf: `${TODAY}T20:15:00.000Z`,
    // 064 `FR-009`: 档位。mock 后端默认收盘档, 实时档的呈现分支归 T011 自己的用例。
    priceKind: 'eod_close',
    // 064 T007a: 链级降级标。mock 后端默认 `null` —— 正常收盘档不是降级, 告警态归 T011。
    realtimeDegrade: null,
    // 🚨 与 asOf 差一天 —— OI 列 MUST 用它（FR-013 / Guardrail 6）。
    oiAsOf: YESTERDAY,
    source: 'eod',
    spot: '82.40',
    w: anchor.w,
    zone: anchor.zone,
    lLevel: anchor.lLevelEffective,
    positionBucket: null,
    positionBucketSource: null,
    positionBucketSetAt: null,
    // 水位未选 ⇒ 意图 `pending`（**MUST NOT 静默取一档**）。
    intent: 'pending',
    rentDepth: null,
    // 🚨 数组顺序**就是**呈现顺序（053 FR-002）—— 047 那份并行的有序 code 列表 `tabOrder`
    //    已随之退役：同一个顺序下发两份表达必 drift，而两份各自都渲染得出来。
    legs,
    gateCounts: { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 },
    basis: BASIS_BY_PERSPECTIVE[perspective],
    // 052 T011 契约增量；053 起只发**本视角**那一份（消费归 052 T013）。
    criteria: emptyPerspectiveCriteria(),
    // 未覆盖条件 ⇒ 两数相等（区块头走单数形态）；本文件不设截断阈值、候选上限未触及。
    matchedCount: legs.length,
    memberCount: legs.length,
    displayLimit: null,
    candidateCapDropped: 0,
  };
}

/**
 * `…/legs` 一次请求的作答 —— **纯函数**（`(路径 symbol, 请求参数, canonical 状态) → 响应`）。
 * 🚨 053 FR-001：`perspective` 必填，缺参 / 非三值 → 400。🚫 MUST NOT 默认一个视角 —— 那时腿数、
 *    名次、档位全都正常，只是答的不是问的那个视角，而屏幕上什么都不会红。
 */
function answerLegs(
  symbol: string,
  url: URL,
  anchors: readonly AnchorResponse[],
  legBook: Record<string, readonly CanonicalLeg[]>,
): { status: number; body: unknown } {
  const anchor = anchors.find((a) => a.ticker === symbol);
  if (!anchor) {
    return {
      status: 404,
      body: { status: 404, code: 'ANCHOR_NOT_FOUND_FOR_SYMBOL', title: 'anchor not found' },
    };
  }
  const perspective = perspectiveOf(url);
  if (perspective === null) return { status: 400, body: PERSPECTIVE_REQUIRED_400 };
  return {
    status: 200,
    body: makeLegTable(symbol, anchor, perspective, legBook[symbol] ?? DEFAULT_BOOK),
  };
}

interface BarsCall {
  symbol: string;
  period: string;
  from: string;
  to: string;
}

interface DeskMock {
  /** bars 端点收到的请求（验窗口切换真的改了粒度与起点，而不只是 chip 变了色）。 */
  barsCalls: () => BarsCall[];
}

// ── server 口径的派生（照抄判定，不照抄结论）─────────────────────────────────

/** 跌破 W（行情不可用的行**不计入**，与 server `belowW` 判据一致）。 */
function isBelowW(a: AnchorResponse): boolean {
  if (a.lastCloseDate === null || a.distanceToWPct === null) return false;
  return Number.parseFloat(a.distanceToWPct) < 0;
}

/** 雷达排序：距 W% 升序，行情不可用排尾。 */
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
 * VVIX/VIX 比的**基准判定在 server**（FR-016）：两侧不是同一交易日就 MUST NOT 计算。
 * 这里逐字复算该判定 —— mock 若自己「补算」一个值，e2e 就验不到前端的不可用呈现。
 */
function deriveRatio(
  vix: UsIndexReadoutResponse,
  vvix: UsIndexReadoutResponse,
): VvixVixRatioResponse {
  if (vix.state === 'read_failed' || vvix.state === 'read_failed') {
    return { state: 'read_failed', value: null, basisDate: null };
  }
  if (vix.state !== 'available' || vvix.state !== 'available') {
    return { state: 'missing', value: null, basisDate: null };
  }
  if (vix.asOf !== vvix.asOf) {
    return { state: 'basis_mismatch', value: null, basisDate: null };
  }
  const value = Number.parseFloat(vvix.close ?? '0') / Number.parseFloat(vix.close ?? '1');
  return { state: 'available', value: value.toFixed(2), basisDate: vix.asOf };
}

const PERIOD_STEP_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 91,
  year: 365,
};

/**
 * bars 序列：从 `to` 往回按粒度步进到 `start`，**末根恒为 `to`**（= 序列 asOf）。
 * 收盘价按正弦在 70–110 间摆动 ⇒ 必然穿过四区间带（60/80/100/120），折线与带同图可读。
 * 复杂度 O(n)，n = 桶数。
 */
function generateBars(start: string, to: string, period: string): DailyBarItem[] {
  const step = PERIOD_STEP_DAYS[period] ?? 1;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const out: DailyBarItem[] = [];
  for (let ms = Date.parse(`${to}T00:00:00Z`); ms >= startMs; ms -= step * 86_400_000) {
    const close = 90 + 20 * Math.sin(out.length / 7);
    out.push({
      tradeDate: new Date(ms).toISOString().slice(0, 10),
      open: close.toFixed(2),
      high: (close + 1).toFixed(2),
      low: (close - 1).toFixed(2),
      close: close.toFixed(2),
      changePct: '0.10',
      prevClose: close.toFixed(2),
      volume: '1000',
      amount: '100000',
      turnoverRate: null,
    });
  }
  return out.reverse();
}

/**
 * 期权台 + marketdata bars 的 hermetic mock —— 两个 route，一份 canonical 状态。
 *
 * handler 全是 `(request, fixture) → response` 的纯函数：
 *  · `GET /optionsdesk/radar`             —— 排除 excluded → 应用筛选 → 排序 → 空态三分
 *  · `GET /optionsdesk/underlyings/:sym`  —— 无锚 404（带机器可读 code）/ 上游故障 500
 *  · `GET /optionsdesk/underlyings/:sym/legs` —— 047 选约表（**与上一条是两条成败线**）
 *  · `GET /optionsdesk/thermometer`       —— 指数两读数 + **server 口径**的比值基准判定 + 逐票 IVP
 *  · `GET /marketdata/instruments/:sym/bars` —— 按 `from`·`to`·上市首日裁剪出序列
 */
async function installDeskMock(page: Page, fixture: DeskFixture): Promise<DeskMock> {
  const anchors = fixture.anchors.map((a) => ({ ...a }));
  const ivBook = fixture.iv ?? {};
  const vix = fixture.vix ?? makeIndex();
  const vvix = fixture.vvix ?? makeIndex({ close: '92.60' });
  const listedFrom = fixture.listedFrom ?? {};
  const legBook = fixture.legs ?? {};
  const outage = fixture.outage ?? {};
  const calls: BarsCall[] = [];

  const ivFor = (ticker: string): UnderlyingIvReadoutResponse => ivBook[ticker] ?? IV_MISSING;

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

    // ── GET /optionsdesk/radar（045 契约，本片只消费不改）────────────────────
    if (path.endsWith('/optionsdesk/radar')) {
      const lLevels = new Set(
        url.searchParams
          .getAll('lLevels')
          .flatMap((v) => v.split(','))
          .filter(Boolean),
      );
      const pendingReview = url.searchParams.get('pendingReview') === 'true';
      const belowW = url.searchParams.get('belowW') === 'true';
      // 🚨 065：`market` 是**作用域**（与 excluded 同级、进计数），不是筛选项。mock 不跟着改
      //    会**全绿而不再是契约镜像**（`.claude/rules/mobile-e2e-hermetic.md`）——
      //    本文件的 fixture 全是 `us:*`，作用域切分对它们恒等价，正因如此漏改也不会红。
      const market = url.searchParams.get('market');

      const allBase = anchors.filter((a) => !a.excluded);
      const base = allBase.filter((a) => market === null || a.ticker.startsWith(`${market}:`));
      const filtered = base.filter(
        (a) =>
          (lLevels.size === 0 || lLevels.has(a.lLevelEffective)) &&
          (!pendingReview || a.overdue) &&
          (!belowW || isBelowW(a)),
      );
      // 全市场计数 —— **不受本次作用域限制**（FR-016 小圆点的数据源）。
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
      const emptyState =
        allBase.length === 0
          ? 'zero_anchors'
          : base.length === 0
            ? 'zero_anchors_in_market'
            : filtered.length === 0
              ? 'filtered_empty'
              : filtered.filter(isBelowW).length === 0
                ? 'all_idle'
                : null;

      return void (await json(200, {
        items: radarSort(filtered),
        nextCursor: null,
        hasMore: false,
        emptyState,
        emptyStateMessage: emptyState === null ? null : EMPTY_STATE_MESSAGES[emptyState],
        marketCounts,
      }));
    }

    // ── GET /optionsdesk/thermometer ────────────────────────────────────────
    if (path.endsWith('/optionsdesk/thermometer')) {
      if (outage.thermometer) {
        return void (await json(500, { status: 500, title: 'thermometer upstream down' }));
      }
      const rows: ThermometerUnderlyingRowResponse[] = [...anchors]
        .sort((x, y) => x.ticker.localeCompare(y.ticker))
        .map((a) => ({
          ticker: a.ticker,
          excluded: a.excluded,
          excludeReason: a.excludeReason,
          iv: ivFor(a.ticker),
        }));
      return void (await json(200, {
        vix,
        vvix,
        vvixVixRatio: deriveRatio(vix, vvix),
        underlyings: rows,
        total: rows.length,
      }));
    }

    // ── GET /optionsdesk/underlyings/:symbol/legs（047 选约表）───────────────
    //    🚨 MUST 排在下面那条之前 —— `underlyings/(.+)$` 会把 `…/legs` 整段吃成 symbol。
    const legsMatch = /\/optionsdesk\/underlyings\/(.+)\/legs$/.exec(path);
    if (legsMatch) {
      const answer = answerLegs(decodeURIComponent(legsMatch[1] ?? ''), url, anchors, legBook);
      return void (await json(answer.status, answer.body));
    }

    // ── GET /optionsdesk/underlyings/:symbol ────────────────────────────────
    const match = /\/optionsdesk\/underlyings\/(.+)$/.exec(path);
    if (match) {
      if (outage.detail) {
        return void (await json(500, { status: 500, title: 'detail upstream down' }));
      }
      const symbol = decodeURIComponent(match[1] ?? '');
      const anchor = anchors.find((a) => a.ticker === symbol);
      // FR-011：无锚是**预期分支**，server 用带机器可读 code 的 404 表达。
      if (!anchor) {
        return void (await json(404, {
          status: 404,
          code: 'ANCHOR_NOT_FOUND_FOR_SYMBOL',
          title: 'anchor not found',
        }));
      }
      return void (await json(200, { symbol, anchor, iv: ivFor(symbol) }));
    }

    await route.fallback();
  });

  await page.route(BARS_RE, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return void (await route.fulfill({ status: 204, headers: CORS }));

    const url = new URL(req.url());
    const symbol = decodeURIComponent(/\/instruments\/(.+)\/bars$/.exec(url.pathname)?.[1] ?? '');
    const period = url.searchParams.get('period') ?? 'day';
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? TODAY;
    calls.push({ symbol, period, from, to });

    if (outage.bars) {
      return void (await route.fulfill({
        status: 500,
        contentType: 'application/json',
        headers: JSON_HEADERS,
        body: JSON.stringify({ status: 500, title: 'bars upstream down' }),
      }));
    }

    const listed = listedFrom[symbol] ?? ymdMinusYears(TODAY, 10);
    const start = from > listed ? from : listed;
    const items = start > to ? [] : generateBars(start, to, period);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        symbol,
        adjust: 'forward',
        period,
        items,
        freshnessTier: items.length === 0 ? 'UNAVAILABLE' : 'CURRENT',
      }),
    });
  });

  return { barsCalls: () => calls };
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

/** 标的详情深链（`market:code` 的冒号在路径段里转义，与 `optionsdeskUnderlyingRoute` 同）。 */
function detailUrl(symbol: string): string {
  return `/optionsdesk/underlying/${encodeURIComponent(symbol)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// ① T028 / US1-AS1 —— 从雷达点该行进详情
// ════════════════════════════════════════════════════════════════════════════

test('046 T028 — 从雷达点该行 → 进标的详情，三块（锚卡 / 温度计区块 / 区间时序）自上而下都在（US1-AS1）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [
      makeAnchor({ id: '1', ticker: 'us:AOS', distanceToWPct: '-4.5' }),
      // 第二只票的 W 与 AOS 不同 —— 「点 A 行进了 B 详情」会被下面的 W 断言抓住。
      makeAnchor({
        id: '2',
        ticker: 'us:PEP',
        distanceToWPct: '-1.2',
        v: '68.75',
        w: '55.00',
        zoneFloor: '41.25',
        zoneCeiling: '82.50',
      }),
    ],
    iv: { 'us:AOS': makeIv(), 'us:PEP': makeIv({ ivPercentile: '40.0' }) },
  });
  await gotoOptionsdesk(page);

  await expect(page.getByTestId('optionsdesk-radar-row-us:AOS')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('optionsdesk-radar-row-us:AOS').tap();

  // 进的是**标的详情深链**。⚠️ 冒号在路径段里的回显形态（`:` / `%3A` / `%253A`）随 router 与
  // 浏览器归一化而变，**不作断言面** —— 「进的是哪只票」由下面的数据断言承担（更强）。
  await expect(page).toHaveURL(/\/optionsdesk\/underlying\/[^/?]*AOS/, { timeout: 30_000 });

  // FR-001 固定三块 —— 缺任何一块都不算「点进去有东西」。
  await expect(page.getByTestId('optionsdesk-detail-anchor-card')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('optionsdesk-detail-iv-available')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-series')).toBeVisible();
  // 点的是哪一行就进哪只票：AOS 的 W=80.00（PEP 是 55.00）。这条同时证明 `market:code` 的
  // 冒号在「路由转义 → 读参解码 → 端点取数」全链上逐字还原了 —— 错一环就 404 成无锚页。
  await expect(page.getByTestId('optionsdesk-detail-anchor-card-w')).toHaveText('80.00');
  await expect(page.getByTestId('optionsdesk-detail-no-anchor')).toHaveCount(0);
  // 「即将可用」轻提示是 045 的占位形态 —— 转真后不该再有任何残留。
  await expect(page.getByTestId('optionsdesk-radar-notice')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ② T021 详情常态 —— 三块各带各自 asOf（FR-020 / SC-002）+ 全景入口
// ════════════════════════════════════════════════════════════════════════════

test('046 T021 — 详情常态：三块各带**各自的** asOf（FR-020 / SC-002），IVP 先于聚合 IV 且带档位徽标；全景 › 直达 P7（FR-012）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })],
    iv: { 'us:AOS': makeIv() }, // asOf = 昨日 ⇒ 与锚卡行情（当日）**不同档**
  });
  await page.goto(detailUrl('us:AOS'));

  const card = page.getByTestId('optionsdesk-detail-anchor-card');
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('optionsdesk-detail-anchor-card-w')).toHaveText('80.00');
  await expect(page.getByTestId('optionsdesk-detail-anchor-card-l-level')).toHaveText('L2');
  // plan D9 ①：仓位水位恒「未知 · 待接入」——**禁显 0 / 0% / 空仓**。
  await expect(page.getByTestId('optionsdesk-detail-anchor-card-field-positionLevel')).toHaveText(
    COPY.positionLevelPending,
  );
  // plan D9 ②：未持股 ⇒ 愿卖锚行**压根不出现**（不是渲染时藏起来）。
  await expect(page.getByText('愿卖')).toHaveCount(0);

  // 个股温度计区块：IVP 大数 + FR-036 档位徽标（78 ⇒ 已越高档）+ 聚合 IV 在其后。
  await expect(page.getByTestId('optionsdesk-detail-iv-ivp')).toHaveText('78');
  await expect(page.getByTestId('optionsdesk-detail-iv-alert-crossed_high')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-iv-aggregate')).toContainText('聚合 IV');
  // FR-035：呈现面**禁出现** IV30d 一类口径措辞。
  await expect(page.getByText(/IV\s*30\s*d/i)).toHaveCount(0);

  // FR-020 / SC-002 —— 三处读数各标各的时点，且**互不牵连**：
  //   锚卡行情 = 当日 · IV 读数 = 非当日 · 序列 = 当日。合并成一个页级 asOf 就验不出这条。
  await expect(page.getByTestId('optionsdesk-detail-anchor-card-quote-asof-CURRENT')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-iv-asof-STALE')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-series-asof-CURRENT')).toBeVisible();

  // 区间时序：四区间背景带五段齐 + 默认窗口 1Y 的粒度脚注。
  for (const zone of ['overvalued', 'expensive', 'thin', 'buy', 'deep_buy']) {
    await expect(page.getByTestId(`optionsdesk-detail-series-zone-${zone}`)).toBeVisible();
  }
  await expect(page.getByTestId('optionsdesk-detail-series-range')).toHaveText(COPY.window1YLabel);

  // FR-012：全景 › → P7（详情侧的第二个 P7 入口，与雷达题头 🌡 并列）。
  await page.getByTestId('optionsdesk-detail-iv-panorama').tap();
  await page.waitForURL(/\/optionsdesk\/thermometer$/, { timeout: 30_000 });
  await expect(page.getByTestId('optionsdesk-thermometer-disclaimer')).toBeVisible({
    timeout: 30_000,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ③④⑤ T021 三种降级：锚卡异常 / IV 分位不可算 / 序列失败·为空（禁整页失败）
// ════════════════════════════════════════════════════════════════════════════

test('046 T021 — 锚卡异常：详情端点 5xx 只降级锚卡那一块，序列照常渲染（state_branch #15，禁整页失败）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })],
    iv: { 'us:AOS': makeIv() },
    outage: { detail: true },
  });
  await page.goto(detailUrl('us:AOS'));

  await expect(page.getByText(COPY.anchorCardFailed)).toBeVisible({ timeout: 90_000 });
  // 另一侧（序列）照常 —— 页面既不是错误页也不是空白页。
  await expect(page.getByTestId('optionsdesk-detail-series-canvas')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-series-failed')).toHaveCount(0);
  // 047 T031：下半的选约区块是**另一条成败线** —— 详情端点挂了它照常渲染
  //（区块头 + FR-011 常驻页脚都在）。046 期这里断的是「M2b 即将可用」分界块，已随换装退役。
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-table-header')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-row-AOS260814P80000')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-leg-disclaimer')).toBeVisible();
  // 「锚卡读不出来」≠「这票没建锚」——两个态 MUST NOT 互相冒充（FR-011）。
  await expect(page.getByTestId('optionsdesk-detail-no-anchor')).toHaveCount(0);
});

test('046 T021 — IVP 窗口不足：区块仍渲染 + 显式「分位不可算」+ 无数值 + **无档位徽标**（state_branch #2 / FR-036）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })],
    iv: {
      'us:AOS': makeIv({
        state: 'percentile_unavailable',
        ivPercentile: null,
        aggregateIv: '29.7',
      }),
    },
  });
  await page.goto(detailUrl('us:AOS'));

  const block = page.getByTestId('optionsdesk-detail-iv-percentile_unavailable');
  await expect(block).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('optionsdesk-detail-iv-degraded')).toHaveText(
    COPY.percentileUnavailable,
  );
  // **禁回落 0 / 禁隐藏区块**：数值位不出现，但聚合 IV 与区块本身照常。
  await expect(page.getByTestId('optionsdesk-detail-iv-ivp')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-detail-iv-aggregate')).toContainText('聚合 IV');
  // FR-036：无 IVP 即无档位 ⇒ 三档徽标一个都不许出现。
  for (const alert of ['not_crossed', 'crossed_high', 'crossed_extreme']) {
    await expect(page.getByTestId(`optionsdesk-detail-iv-alert-${alert}`)).toHaveCount(0);
  }
  // 块级降级 —— 锚卡照常（同屏两块的成败线互不牵连）。
  await expect(page.getByTestId('optionsdesk-detail-anchor-card')).toBeVisible();
});

test('046 T021 — 序列降级：5xx ⇒ 显式失败 + 重试入口；空序列 ⇒ 空态。两者**四区间带都照常**（state_branch #10/#15）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })],
    iv: { 'us:AOS': makeIv() },
    outage: { bars: true },
  });
  await page.goto(detailUrl('us:AOS'));

  await expect(page.getByTestId('optionsdesk-detail-series-failed')).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId('optionsdesk-detail-series-failed')).toHaveText(COPY.seriesFailed);
  await expect(page.getByTestId('optionsdesk-detail-series-retry')).toBeVisible();
  // 锚是自产数据 ⇒ 带与锚卡都不受行情故障连坐。
  await expect(page.getByTestId('optionsdesk-detail-series-zone-buy')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-anchor-card')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-iv-available')).toBeVisible();
});

test('046 T021 — 有锚但无任何日线：折线区空态，四区间带仍单独呈现（Edge Case / state_branch #10）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '2', ticker: 'us:NEWCO' })],
    iv: { 'us:NEWCO': makeIv() },
    // 上市首日晚于今天 ⇒ 任何窗口都取不到 bar（新开锚、首个 cron 未跑完的等价态）。
    listedFrom: { 'us:NEWCO': ymdMinusYears(TODAY, -1) },
  });
  await page.goto(detailUrl('us:NEWCO'));

  await expect(page.getByTestId('optionsdesk-detail-series-empty')).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId('optionsdesk-detail-series-empty')).toContainText(COPY.seriesEmpty);
  await expect(page.getByTestId('optionsdesk-detail-series-zone-buy')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-series-zone-thin')).toBeVisible();
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ T021 无锚态（FR-011 / Edge Case「深链进无锚标的」）
// ════════════════════════════════════════════════════════════════════════════

test('046 T021 — 深链进无锚标的：显式「尚未建锚」+ 建锚入口，不是空白页也不是报错页（FR-011）', async ({
  page,
}) => {
  await installDeskMock(page, { anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })] });
  await page.goto(detailUrl('us:ZZZZ'));

  await expect(page.getByTestId('optionsdesk-detail-no-anchor')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('optionsdesk-detail-no-anchor')).toHaveText(COPY.noAnchor);
  await expect(page.getByTestId('optionsdesk-detail-create-anchor')).toBeVisible();
  // 无锚是**整页分支**（锚卡与四区间带都无从谈起）⇒ 三块的容器不该同屏。
  await expect(page.getByTestId('optionsdesk-detail-scroll')).toHaveCount(0);
  await expect(page.getByText(COPY.anchorCardFailed)).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ T020 + T021 窗口切换（含长窗实际起点标注 + FR-010 边界不变）
// ════════════════════════════════════════════════════════════════════════════

test('046 T020/T021 — 切 10Y：请求粒度转月 K·起点回退 10 年，序列短于窗口时标**实际起点**，四区间边界不变（FR-008/FR-010）', async ({
  page,
}) => {
  const mock = await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })],
    iv: { 'us:AOS': makeIv() },
    // 只有 2 年历史：1Y 窗口取得满、10Y 窗口取不满 ⇒ 后者必须标实际起点。
    listedFrom: { 'us:AOS': ymdMinusYears(TODAY, 2) },
  });
  await page.goto(detailUrl('us:AOS'));

  await expect(page.getByTestId('optionsdesk-detail-series-range')).toHaveText(COPY.window1YLabel, {
    timeout: 90_000,
  });
  // 四区间边界（只依赖锚）—— 切窗口前先记下 W 界线。
  await expect(page.getByText('W 80.00', { exact: true })).toBeVisible();

  await page.getByTestId('optionsdesk-detail-series-window-10Y').tap();

  // FR-008：序列短于所选窗口 ⇒ 标明实际起点，**禁拉伸补空 / 禁静默截断**；粒度同时转月 K。
  const range = page.getByTestId('optionsdesk-detail-series-range');
  await expect(range).toHaveText(/^月 K · 实际自 \d{4}-\d{2}-\d{2} 起$/, { timeout: 30_000 });
  // 标出来的是**序列真实首日**，不是把请求的窗口起点回显一遍（后者等于什么都没说）。
  const actualStart = /(\d{4}-\d{2}-\d{2})/.exec((await range.textContent()) ?? '')?.[1] ?? '';
  expect(actualStart > ymdMinusYears(TODAY, 10)).toBe(true);
  expect(actualStart >= ymdMinusYears(TODAY, 2)).toBe(true);

  // FR-009 / T020：粒度与起点由**固定映射**求值，请求真的换了（不是只有 chip 变色）。
  const last = mock.barsCalls().at(-1);
  expect(last?.period).toBe('month');
  expect(last?.from).toBe(ymdMinusYears(TODAY, 10));
  expect(last?.to).toBe(TODAY);
  // FR-010 / state_branch #14：切窗口**不改**四区间边界。
  await expect(page.getByText('W 80.00', { exact: true })).toBeVisible();
  await expect(page.getByTestId('optionsdesk-detail-series-zone-buy')).toBeVisible();
});

// ════════════════════════════════════════════════════════════════════════════
// ⑧ T022 温度计四态 + 零锚
// ════════════════════════════════════════════════════════════════════════════

test('046 T022 — 温度计常态：表盘出档位 + VVIX 与比值各带时点；「分位不可算」行保留、excluded 行照常带标记', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [
      makeAnchor({ id: '1', ticker: 'us:AOS' }),
      makeAnchor({ id: '2', ticker: 'us:PEP' }),
      makeAnchor({ id: '3', ticker: 'us:TAP', excluded: true, excludeReason: '并购整合期' }),
    ],
    iv: {
      'us:AOS': makeIv(),
      'us:PEP': makeIv({ state: 'percentile_unavailable', ivPercentile: null }),
      'us:TAP': makeIv({ ivPercentile: '30.0' }),
    },
    vix: makeIndex({ close: '18.20' }), // <20 ⇒ 平静档
    vvix: makeIndex({ close: '92.60' }),
  });
  await page.goto('/optionsdesk/thermometer');

  await expect(page.getByTestId('optionsdesk-thermometer-gauge-calm')).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId('optionsdesk-thermometer-vvix-value')).toHaveText('92.60');
  await expect(page.getByTestId('optionsdesk-thermometer-ratio-available')).toBeVisible();

  // IVP 列表三行：有值 / 分位不可算（**保留在列**）/ excluded（**照常列出并标记**）。
  await expect(page.getByTestId('optionsdesk-thermometer-row-AOS-ivp')).toHaveText('78');
  await expect(
    page.getByTestId('optionsdesk-thermometer-row-AOS-alert-crossed_high'),
  ).toBeVisible();
  await expect(page.getByTestId('optionsdesk-thermometer-row-PEP-degraded')).toHaveText(
    COPY.percentileUnavailable,
  );
  await expect(page.getByTestId('optionsdesk-thermometer-row-PEP-ivp')).toHaveCount(0);
  for (const alert of ['not_crossed', 'crossed_high', 'crossed_extreme']) {
    await expect(page.getByTestId(`optionsdesk-thermometer-row-PEP-alert-${alert}`)).toHaveCount(0);
  }
  await expect(page.getByTestId('optionsdesk-thermometer-row-TAP-excluded')).toHaveText(
    COPY.excluded,
  );
  await expect(page.getByTestId('optionsdesk-thermometer-row-TAP-exclude-reason')).toContainText(
    '并购整合期',
  );
  // FR-015 📌：regime 读数**不呈现**（mockup 帧⑦ 画过，2026-08-03 拍板移除）。
  await expect(page.getByText(/regime/i)).toHaveCount(0);
});

test('046 T022 — VIX 不可得：表盘「显示不可用」且**指针与数值都不出现**（禁停 0），比值转不可用，列表照常（FR-017）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })],
    iv: { 'us:AOS': makeIv() },
    vix: INDEX_MISSING,
    vvix: makeIndex({ close: '92.60' }),
  });
  await page.goto('/optionsdesk/thermometer');

  await expect(page.getByTestId('optionsdesk-thermometer-gauge-unavailable')).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId('optionsdesk-thermometer-gauge-degraded')).toContainText(
    COPY.gaugeUnavailable,
  );
  // 「指针停在 0」会被读成「极度平静」= 错误信息而非缺失信息 ⇒ 数值位必须缺席。
  await expect(page.getByTestId('optionsdesk-thermometer-gauge-value')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-thermometer-ratio-missing')).toBeVisible();
  // 🚨 MUST NOT 拿单侧推算：VVIX 有值不代表比值能算。
  await expect(page.getByTestId('optionsdesk-thermometer-ratio-missing-degraded')).toHaveText(
    COPY.ratioMissing,
  );
  // 表盘与列表是两条独立的线 —— 指数不可得时列表照列。
  await expect(page.getByTestId('optionsdesk-thermometer-row-AOS-ivp')).toBeVisible();
});

test('046 T022 — VVIX 不可得：VVIX 与比值各自显式不可用，表盘照常出档位（state_branch #6）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })],
    iv: { 'us:AOS': makeIv() },
    vix: makeIndex({ close: '24.10' }), // 20–30 ⇒ 抬升档
    vvix: INDEX_MISSING,
  });
  await page.goto('/optionsdesk/thermometer');

  await expect(page.getByTestId('optionsdesk-thermometer-gauge-elevated')).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId('optionsdesk-thermometer-vvix-degraded')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-thermometer-vvix-value')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-thermometer-ratio-missing')).toBeVisible();
});

test('046 T022 — 两侧 asOf 不同交易日：比值 MUST NOT 计算，显式「基准不一致」（FR-016 / state_branch #8）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })],
    iv: { 'us:AOS': makeIv() },
    vix: makeIndex({ close: '18.20', asOf: YESTERDAY }),
    vvix: makeIndex({ close: '92.60', asOf: ymdMinusDays(TODAY, 4) }),
  });
  await page.goto('/optionsdesk/thermometer');

  const ratio = page.getByTestId('optionsdesk-thermometer-ratio-basis_mismatch');
  await expect(ratio).toBeVisible({ timeout: 90_000 });
  await expect(
    page.getByTestId('optionsdesk-thermometer-ratio-basis_mismatch-degraded'),
  ).toHaveText(COPY.ratioBasisMismatch);
  await expect(page.getByTestId('optionsdesk-thermometer-ratio-basis_mismatch-value')).toHaveCount(
    0,
  );
  // 两个读数本身照常出值（不可用的只是「比」这一件事）。
  await expect(page.getByTestId('optionsdesk-thermometer-gauge-calm')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-thermometer-vvix-value')).toHaveText('92.60');
});

test('046 T022 — 零锚：IVP 列表空态 + 去锚管理入口，**指数表盘照常渲染**（state_branch #22 / FR-027 传到 UI）', async ({
  page,
}) => {
  await installDeskMock(page, { anchors: [] });
  await page.goto('/optionsdesk/thermometer');

  await expect(page.getByTestId('optionsdesk-thermometer-list-empty')).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId('optionsdesk-thermometer-list-empty')).toContainText(
    COPY.listEmpty,
  );
  await expect(page.getByTestId('optionsdesk-thermometer-go-anchors')).toBeVisible();
  // 指数维度不挂锚闸 ⇒ 零锚时表盘仍有数（这条是采集侧 FR-027 在 UI 上的终点）。
  await expect(page.getByTestId('optionsdesk-thermometer-gauge-calm')).toBeVisible();
});

// ════════════════════════════════════════════════════════════════════════════
// ⑨ FR-019 免责常驻（e2e 是「常驻」唯一能验的层）
// ════════════════════════════════════════════════════════════════════════════

test('046 T022 — FR-019：「不构成开仓理由」常驻可见且**非折叠非 tooltip** —— 初始态 / 滚到底 / 整体失败态三处都在', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [
      makeAnchor({ id: '1', ticker: 'us:AOS' }),
      makeAnchor({ id: '2', ticker: 'us:PEP' }),
      makeAnchor({ id: '3', ticker: 'us:TAP' }),
      makeAnchor({ id: '4', ticker: 'us:CPB' }),
      makeAnchor({ id: '5', ticker: 'us:KHC' }),
    ],
    iv: {
      'us:AOS': makeIv(),
      'us:PEP': makeIv({ ivPercentile: '95.0' }),
      'us:TAP': makeIv({ ivPercentile: '12.0' }),
      'us:CPB': makeIv({ ivPercentile: '55.0' }),
      'us:KHC': makeIv({ ivPercentile: '71.0' }),
    },
  });
  // 窄视口 —— 让内容真的溢出一屏，否则「滚到底仍在」是**空断言**（滚不动也会绿）。
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto('/optionsdesk/thermometer');

  const disclaimer = page.getByTestId('optionsdesk-thermometer-disclaimer');
  const gaugeCard = page.getByTestId('optionsdesk-thermometer-gauge-card');
  // ① 初始态：无需任何点击 / 展开 / hover 就可见（= 非折叠、非 tooltip）。
  await expect(disclaimer).toBeVisible({ timeout: 90_000 });
  await expect(disclaimer).toContainText(COPY.disclaimer);
  await expect(gaugeCard).toBeInViewport();

  // ② 滚到底：它渲在 ScrollView **之外** ⇒ 任何滚动位置都在（这是「常驻」的机械判据）。
  const lastRow = page.getByTestId('optionsdesk-thermometer-row-KHC-ivp');
  await lastRow.scrollIntoViewIfNeeded();
  await expect(lastRow).toBeInViewport();
  // 内容**真的**滚走了（表盘卡出了视口）⇒ 下面这条不是滚不动导致的假绿。
  await expect(gaugeCard).not.toBeInViewport();
  await expect(disclaimer).toBeInViewport();
  await expect(disclaimer).toContainText(COPY.disclaimer);
});

test('046 T022 — FR-019：温度计整体失败时免责**仍在**（降级态盖不掉它）', async ({ page }) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS' })],
    outage: { thermometer: true },
  });
  await page.goto('/optionsdesk/thermometer');

  await expect(page.getByText(COPY.thermometerFailed)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('optionsdesk-thermometer-retry')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-thermometer-disclaimer')).toContainText(
    COPY.disclaimer,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ⑩ T023 / FR-021 · US4-AS1 —— 雷达题头 🌡 转真
// ════════════════════════════════════════════════════════════════════════════

test('046 T023 — 雷达题头 🌡 可点直达 P7，且雷达页内**不再出现「即将可用」字样**（FR-021 / US4-AS1）', async ({
  page,
}) => {
  await installDeskMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: 'us:AOS', distanceToWPct: '-4.5' })],
    iv: { 'us:AOS': makeIv() },
  });
  await gotoOptionsdesk(page);
  await expect(page.getByTestId('optionsdesk-radar-list')).toBeVisible({ timeout: 30_000 });

  // 占位字样零命中 —— 045 的两处占位（🌡 灰置 / 行点击轻提示）都已转真。
  await expect(page.getByText(COPY.comingSoon)).toHaveCount(0);

  await page.getByTestId('optionsdesk-thermometer-button').tap();
  await page.waitForURL(/\/optionsdesk\/thermometer$/, { timeout: 30_000 });
  await expect(page.getByTestId('optionsdesk-thermometer-disclaimer')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('optionsdesk-thermometer-gauge-calm')).toBeVisible();
});
