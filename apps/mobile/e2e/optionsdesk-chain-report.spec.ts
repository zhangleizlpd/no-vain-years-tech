import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type {
  AnchorResponse,
  ChainReportCellResponse,
  ChainReportColumnResponse,
  ChainReportResponse,
  ChainReportRowResponse,
  LegTableResponse,
  UnderlyingIvReadoutResponse,
} from '@nvy/api-client';

import {
  BASIS_BY_PERSPECTIVE,
  emptyPerspectiveCriteria,
  PERSPECTIVE_REQUIRED_400,
  perspectiveOf,
  quoted,
  type LegPerspective,
} from './_support/optionsdesk-fixtures';

// 055 T018 — 标的链分析报表 hermetic UI e2e（Playwright Expo Web，Constitution §V 两层验证
// 之一；样板 = `optionsdesk-detail-thermometer.spec.ts`）。
//
// 覆盖（`state_branches` 落层裁定表的「mobile hermetic e2e」那一档）：
//   ② 切格值 → **位置逐格不变、格态重算**（`SC-002`）      ③ 段外列整列淡出（列仍在）
//   ④ 某格值零非空格 → 骨架与行列标签照常                  ⑤ 全腿年化 × 价内行不着色（`SC-013`）
//   ⑥ 未建锚 → 入口不出现 **且深链被拦**                    ⑦ 链无快照 → 未就绪
//   ⑧ 全被门槛挡下 → **网格照画** + 三计数                 ⑭ 格内 1 条腿 → 次优呈「无」
//   ⑮ 十字线拖到空格 → 给出**为什么空**（`SC-004`）        ⑱ IV 分位四态
//   ㉓ 点有值格 → 下钻**预填**                              ㉔ 下钻后业务日不一致 → 两个时点各自可见
//
// ── 🚨 markets OFF 深链拦截**不在本文件**（`SC-009` / `state_branch` 22）──────────
//   `playwright.markets-off.config.ts` 的 `testMatch` 锁死 `markets-feature-gate.spec.ts`
//   一个文件，主套件反向 `testIgnore` 它。报表深链的 OFF 断言已加进那边。
//   **写在本文件里 = 在 ON bundle 下跑，永远验不到 OFF，且不会红。**
//
// ── 🚨 真机才验得到的三条不在这里 ────────────────────────────────────────────
//   横滑到最右端的 clamp 几何（16）· 长按 vs 横滑的手势归属与手感（17）· 色阶五档在真机屏上
//   的可分辨性（`SC-003`）—— 归 T021。本文件对十字线只验**状态面**（面板内容），
//   🚫 不假装验了手势竞争。
//
// ── hermetic mock 纪律（per docs/conventions/mobile-impl-playbook.md §6）────────
//   mock 写**依赖方（server）契约**：持一份 canonical 状态（锚表 + 逐票报表 + 逐票腿册），
//   handler 是 `(请求, canonical 状态) → 响应` 的纯函数。**禁**按测试编排标志分支 ——
//   各 test 传**不同的 canonical 数据**（= 换一份 DB 内容）。
import { mockJson } from './_support/api-mock';

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const OPTIONSDESK_RE = /\/api\/v1\/optionsdesk\//;
const BARS_RE = /\/api\/v1\/marketdata\/instruments\//;

const SEED_ACCOUNT_ID = 'acc-e2e-055';
const SEED_ACCESS_TOKEN = 'access-e2e-055';
const SEED_REFRESH_TOKEN = 'refresh-e2e-055';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139055';

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

const SYMBOL = 'us:ACN';
const SPOT = 298.45;
const REPORT_AS_OF = '2026-08-11';
const REPORT_OI_AS_OF = '2026-08-10';
const MARKET_DATE = '2026-08-12';

/** 屏内文案（`optionsdesk-copy.ts` 逐字；改文案就该在这里红）。 */
const COPY = {
  entryTitle: '链分析 · 机会分布',
  panorama: '全景 ›',
  noAnchor: '该标的尚未建锚',
  chainNotReady: '链数据未就绪',
  noSpot: '标的现价暂不可用',
  readFailed: '链数据读取失败',
  allGated: '这条链上没有过门槛的腿',
  percentileUnavailable: '分位不可算',
  runnerUpSingle: '无（仅 1 条）',
  reasonVoid: '该位置链上无合约',
  reasonBlocked: '有腿，但被门槛挡下',
  outOfBandChip: '段外',
  monthlyChip: '月',
} as const;

// ════════════════════════════════════════════════════════════════════════════
// canonical 数据（= 服务端 DB 内容的镜像）
// ════════════════════════════════════════════════════════════════════════════

const ANCHOR_BASE: Omit<AnchorResponse, 'id' | 'ticker'> = {
  v: '340.00',
  vModel: '340.00',
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
  w: '272.00',
  zoneFloor: '204.00',
  zoneCeiling: '408.00',
  willingSellLongHold: '408.00',
  willingSellRent: '340.00',
  zone: 'buy',
  lastClose: '298.45',
  lastCloseDate: MARKET_DATE,
  quoteFreshnessTier: 'CURRENT',
  spot: '298.45',
  priceKind: 'eod_close',
  spotAsOf: MARKET_DATE,
  distanceToWPct: '9.7',
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
    aggregateIv: '28.4',
    ivPercentile: '58.0',
    asOf: REPORT_AS_OF,
    freshnessTier: 'CURRENT',
    ...over,
  };
}

/** 分位算不出（窗口不足）—— 聚合 IV 有值，分位没有。🚨 禁回落 0。 */
const IV_NO_PERCENTILE: UnderlyingIvReadoutResponse = {
  state: 'percentile_unavailable',
  aggregateIv: '28.4',
  ivPercentile: null,
  asOf: REPORT_AS_OF,
  freshnessTier: 'CURRENT',
};

const IV_MISSING: UnderlyingIvReadoutResponse = {
  state: 'missing',
  aggregateIv: null,
  ivPercentile: null,
  asOf: null,
  freshnessTier: 'UNAVAILABLE',
};

const IV_READ_FAILED: UnderlyingIvReadoutResponse = {
  state: 'read_failed',
  aggregateIv: null,
  ivPercentile: null,
  asOf: null,
  freshnessTier: 'UNAVAILABLE',
};

// ── 行轴：价内一档 + 价外七档，顶档开口（T001 定案的 8 行） ────────────────────

/** 每行的价外幅度区间（下界闭 / 上界开；`null` = 顶档无上界）。 */
const OTM_BANDS: readonly (readonly [number, number | null])[] = [
  [-0.1, 0],
  [0, 0.1],
  [0.1, 0.2],
  [0.2, 0.3],
  [0.3, 0.4],
  [0.4, 0.5],
  [0.5, 0.6],
  [0.6, null],
];

/** 行权价 = `spot × (1 − 价外幅度)` ⇒ 上界对应 `otmFloor`、下界对应 `otmCeiling`。 */
function makeRows(spot: number | null): ChainReportRowResponse[] {
  return OTM_BANDS.map(([floor, ceiling], index) => ({
    index,
    otmFloor: floor.toFixed(6),
    otmCeiling: ceiling === null ? null : ceiling.toFixed(6),
    strikeFloor: spot === null || ceiling === null ? null : (spot * (1 - ceiling)).toFixed(4),
    strikeCeiling: spot === null ? '0.0000' : (spot * (1 - floor)).toFixed(4),
  }));
}

const ROW_COUNT = OTM_BANDS.length;

// ── 列轴：6 个到期日；建仓段 = 前三列、收租段 = 中间四列，末列两段都不在 ────────

interface ColumnSpec {
  readonly dteDays: number;
  readonly expiryDate: string;
  readonly atmIv: number | null;
  readonly isMonthlyChain: boolean;
  readonly inBuild: boolean;
  readonly inRent: boolean;
}

const COLUMNS: readonly ColumnSpec[] = [
  {
    dteDays: 7,
    expiryDate: '2026-08-21',
    atmIv: 26.1,
    isMonthlyChain: false,
    inBuild: true,
    inRent: false,
  },
  {
    dteDays: 21,
    expiryDate: '2026-09-04',
    atmIv: 27.4,
    isMonthlyChain: false,
    inBuild: true,
    inRent: true,
  },
  {
    dteDays: 45,
    expiryDate: '2026-09-18',
    atmIv: null,
    isMonthlyChain: true,
    inBuild: true,
    inRent: true,
  },
  {
    dteDays: 80,
    expiryDate: '2026-10-30',
    atmIv: 29.8,
    isMonthlyChain: false,
    inBuild: false,
    inRent: true,
  },
  {
    dteDays: 120,
    expiryDate: '2026-12-18',
    atmIv: 30.6,
    isMonthlyChain: true,
    inBuild: false,
    inRent: true,
  },
  {
    dteDays: 200,
    expiryDate: '2027-03-19',
    atmIv: 31.2,
    isMonthlyChain: true,
    inBuild: false,
    inRent: false,
  },
];

const COL_COUNT = COLUMNS.length;

function makeColumns(specs: readonly ColumnSpec[] = COLUMNS): ChainReportColumnResponse[] {
  return specs.map((c) => ({
    expiryDate: c.expiryDate,
    dteDays: c.dteDays,
    isMonthlyChain: c.isMonthlyChain,
    atmIv: c.atmIv,
    // 🚨 全腿年化与活跃度**不受期限段约束** ⇒ 恒 true（server 已做过「格值 → 视角」映射，
    //    客户端只读这一份，不自己映；mock 照抄那个口径）。
    inRecallBand: {
      buildQuality: c.inBuild,
      rentAnnualized: c.inRent,
      allAnnualized: true,
      activity: true,
    },
  }));
}

// ── 格：用一张「码图」描述整张网格（一行一个字符串，一格一个字符） ──────────────

/** `v` 有值 · `g` 有腿但被门槛挡下 · `a` 该位置无合约。 */
type CellChar = 'v' | 'g' | 'a';

function cellOf(char: CellChar, best: string, runnerUp: string | null, legCount: number) {
  if (char === 'v') return { state: 'valued' as const, best, runnerUp, legCount };
  if (char === 'g') return { state: 'gated' as const, best: null, runnerUp: null, legCount };
  return { state: 'absent' as const, best: null, runnerUp: null, legCount: 0 };
}

interface GridSpec {
  /** 每行一串，长度 = 列数。行数 = {@link ROW_COUNT}。 */
  readonly map: readonly string[];
  /** 有值格的读数（同一张网格内取同一个量纲）。 */
  readonly best: string;
  /** 次优；`null` ⇒ 该网格所有有值格都只有一条腿（`state_branch` 14 的靶子）。 */
  readonly runnerUp?: string | null;
  readonly legCount?: number;
}

function gridOf(spec: GridSpec): ChainReportCellResponse[][] {
  return Array.from({ length: ROW_COUNT }, (_, r) =>
    Array.from({ length: COL_COUNT }, (_, c) => {
      const char = (spec.map[r]?.[c] ?? 'a') as CellChar;
      return cellOf(char, spec.best, spec.runnerUp ?? null, spec.legCount ?? 3);
    }),
  );
}

/** 整张全 `x` 的码图（`x` = 该字符对应的态）。 */
function uniformMap(char: CellChar): string[] {
  return Array.from({ length: ROW_COUNT }, () => char.repeat(COL_COUNT));
}

/**
 * 默认四张网格 —— **蓄意各不相同**（四种格值跑在不同召回集上是本片的核心事实）：
 * · 收租：中间几行几列有值；· 建仓：只有很浅的两行；· 全腿：最满（含**价内行**，`SC-013` 的靶子）；
 * · 活跃度：与全腿同骨架但读数是张数。
 */
function defaultGrids() {
  return {
    buildQuality: gridOf({
      map: ['aaaaaa', 'vvgaaa', 'vggaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa'],
      best: '-27.000000',
      runnerUp: '-21.000000',
    }),
    rentAnnualized: gridOf({
      map: ['aaaaaa', 'agvvga', 'agvvga', 'aavvga', 'aagvaa', 'aaaaaa', 'aaaaaa', 'aaaaaa'],
      best: '0.184000',
      runnerUp: '0.151000',
    }),
    allAnnualized: gridOf({
      // 🚨 首行（价内档）有值 —— `FR-019c`：它不参与色阶，但**读数与腿数照常**（`SC-013`）。
      map: ['vvvvvv', 'vvvvvv', 'vvvvvg', 'vvvvgg', 'vvggaa', 'vgaaaa', 'gaaaaa', 'aaaaaa'],
      best: '0.092000',
      // 🚨 单腿格 —— `state_branch` 14 的靶子：次优 MUST 呈「无（仅 1 条）」，🚫 不复述最优。
      runnerUp: null,
      legCount: 1,
    }),
    activity: gridOf({
      map: ['vvvvvv', 'vvvvvv', 'vvvvvg', 'vvvvgg', 'vvggaa', 'vgaaaa', 'gaaaaa', 'aaaaaa'],
      best: '4210.000000',
      runnerUp: '880.000000',
    }),
  };
}

const DEFAULT_COUNTS = {
  total: 825,
  removedByPremium: 252,
  skeleton: 573,
  outsideRowFloor: 261,
  withinRows: 312,
  blockedByLiveness: 38,
  valued: 274,
};

interface ReportOver {
  readonly state?: ChainReportResponse['state'];
  readonly spot?: string | null;
  readonly iv?: UnderlyingIvReadoutResponse;
  readonly asOf?: string | null;
  readonly anchorExcluded?: boolean;
  readonly columns?: readonly ColumnSpec[];
  readonly cells?: ChainReportResponse['cells'];
  readonly gateCounts?: ChainReportResponse['gateCounts'];
}

function makeReport(over: ReportOver = {}): ChainReportResponse {
  const spot = over.spot === undefined ? SPOT.toFixed(4) : over.spot;
  return {
    symbol: SYMBOL,
    state: over.state ?? 'available',
    spot,
    marketDate: MARKET_DATE,
    asOf: over.asOf === undefined ? REPORT_AS_OF : over.asOf,
    quoteAsOf: `${REPORT_AS_OF}T20:15:00.000Z`,
    // 064 `FR-009`: 档位。mock 后端默认收盘档, 实时档的呈现分支归 T011 自己的用例。
    priceKind: 'eod_close',
    // 064 T007a: 链级降级标。mock 后端默认 `null` —— 正常收盘档不是降级, 告警态归 T011。
    realtimeDegrade: null,
    oiAsOf: REPORT_OI_AS_OF,
    source: 'eod',
    iv: over.iv ?? makeIv(),
    anchorExcluded: over.anchorExcluded ?? false,
    gateCounts: over.gateCounts ?? DEFAULT_COUNTS,
    rows: makeRows(spot === null ? null : Number.parseFloat(spot)),
    columns: makeColumns(over.columns),
    cells: over.cells ?? defaultGrids(),
  };
}

// ── 选约表（下钻落点；本文件只要它渲染得出来 + 带得出业务日） ──────────────────

function makeLegTable(
  symbol: string,
  anchor: AnchorResponse,
  perspective: LegPerspective,
  asOf: string,
): LegTableResponse {
  const legs = [
    {
      code: 'ACN260918P25000',
      strike: '250.00',
      expiryDate: '2026-09-18',
      dteDays: 45,
      ...quoted('3.40', '3.70'),
      bidSize: 25,
      askSize: 26,
      basis: BASIS_BY_PERSPECTIVE[perspective],
      periodRate: '0.013600',
      weeklyRate: '0.002100',
      annualizedRate: '0.110000',
      tier: 'good' as const,
      askRate: null,
      effectiveCost: '246.60',
      effectiveCostVsWPct: '-9.34',
      absDelta: 0.22,
      sigmaDistance: 0.77,
      openInterest: 4210,
      volume: 63,
      turnover: '21420.00',
      activity: null,
      isRecommended: false,
      isMonthlyChain: true,
      earningsMark: null,
      greeksComplete: true,
      // 064 `FR-009`: 档位。mock 后端默认收盘档, 实时档的呈现分支归 T011 自己的用例。
      // `as const` 与同数组里的 `tier` 同理 —— 这个数组没有上下文类型, 不钉住会宽成 string。
      priceKind: 'eod_close' as const,
      bandStatus: null,
      wideSpreadOpportunity: false,
    },
  ];
  return {
    symbol,
    // 069 契约增量: 每 K 行军判决 —— 仅实时收租有值, mock 基线取缺省 null。
    march: null,
    // 070 契约增量: 行军模式标示 —— 与 march 同生共死, 基线随之 null。
    marchMode: null,
    perspective,
    state: 'available',
    asOf,
    asOfFreshnessTier: 'CURRENT',
    quoteAsOf: `${asOf}T20:15:00.000Z`,
    // 064 `FR-009`: 档位。mock 后端默认收盘档, 实时档的呈现分支归 T011 自己的用例。
    priceKind: 'eod_close',
    // 064 T007a: 链级降级标。mock 后端默认 `null` —— 正常收盘档不是降级, 告警态归 T011。
    realtimeDegrade: null,
    oiAsOf: asOf,
    source: 'eod',
    spot: SPOT.toFixed(2),
    w: anchor.w,
    zone: anchor.zone,
    lLevel: anchor.lLevelEffective,
    positionBucket: null,
    positionBucketSource: null,
    positionBucketSetAt: null,
    intent: 'pending',
    rentDepth: null,
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

interface ReportFixture {
  anchors: AnchorResponse[];
  /** 逐票报表；缺键 = 该票 404（未建锚）。`'outage'` = 端点 5xx。 */
  reports?: Record<string, ChainReportResponse | 'outage'>;
  /** 逐票 IV（详情端点用）。 */
  iv?: Record<string, UnderlyingIvReadoutResponse>;
  /** 选约表的业务日 —— 与报表侧不同即触发 `FR-039a`。 */
  legAsOf?: string;
}

async function installChainReportMock(page: Page, fixture: ReportFixture): Promise<void> {
  const anchors = fixture.anchors.map((a) => ({ ...a }));
  const reports = fixture.reports ?? {};
  const ivBook = fixture.iv ?? {};
  const legAsOf = fixture.legAsOf ?? REPORT_AS_OF;

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

    if (path.endsWith('/optionsdesk/radar')) {
      // 🚨 065：本片只把雷达当「进链报表的入口」用，但 mock 仍须是**契约镜像** ——
      //    作用域切分 + 全市场计数（`.claude/rules/mobile-e2e-hermetic.md`）。fixture 全是
      //    `us:*` ⇒ 漏改不会红，正是这类 mock 悄悄失真的原因。
      const market = url.searchParams.get('market');
      const allBase = anchors.filter((a) => !a.excluded);
      const items = allBase.filter((a) => market === null || a.ticker.startsWith(`${market}:`));
      const marketCounts = [...new Set(allBase.map((a) => a.ticker.split(':')[0] ?? ''))].map(
        (m) => {
          const rows = allBase.filter((a) => a.ticker.startsWith(`${m}:`));
          return { market: m, baseTotal: rows.length, actionableTotal: 0 };
        },
      );
      return void (await json(200, {
        items,
        nextCursor: null,
        hasMore: false,
        emptyState: null,
        emptyStateMessage: null,
        marketCounts,
      }));
    }

    // 🚨 两条更长的路径 MUST 排在 `underlyings/(.+)$` 之前 —— 后者会把整段吃成 symbol。
    const reportMatch = /\/optionsdesk\/underlyings\/(.+)\/chain-report$/.exec(path);
    if (reportMatch) {
      const symbol = decodeURIComponent(reportMatch[1] ?? '');
      const report = reports[symbol];
      // 未建锚 = **预期分支**，server 用带机器可读 code 的 404 表达（与详情端点同一语义）。
      if (report === undefined) return void (await notFound());
      if (report === 'outage') {
        return void (await json(500, { status: 500, title: 'chain report upstream down' }));
      }
      return void (await json(200, { ...report, symbol }));
    }

    const legsMatch = /\/optionsdesk\/underlyings\/(.+)\/legs$/.exec(path);
    if (legsMatch) {
      const symbol = decodeURIComponent(legsMatch[1] ?? '');
      const anchor = anchors.find((a) => a.ticker === symbol);
      if (!anchor) return void (await notFound());
      const perspective = perspectiveOf(url);
      if (perspective === null) return void (await json(400, PERSPECTIVE_REQUIRED_400));
      return void (await json(200, makeLegTable(symbol, anchor, perspective, legAsOf)));
    }

    const detailMatch = /\/optionsdesk\/underlyings\/(.+)$/.exec(path);
    if (detailMatch) {
      const symbol = decodeURIComponent(detailMatch[1] ?? '');
      const anchor = anchors.find((a) => a.ticker === symbol);
      if (!anchor) return void (await notFound());
      return void (await json(200, { symbol, anchor, iv: ivBook[symbol] ?? makeIv() }));
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
      body: JSON.stringify({ symbol: SYMBOL, adjust: 'forward', period: 'day', items: [] }),
    });
  });

  // 🚨 `'GET'` MUST NOT 省：省了行为上照样拦得住（`mockJson` 的 method 可选, 不传则任何方法
  //    都 fulfill）, 但 `check-e2e-seed-auth-mock` 只认「显式 GET stub」或裸 `page.route`
  //    两种形状 ⇒ 省了 CI 的 gate-checks 红, 而**本地 `nx affected` 那套门看不到它**
  //    （该守门是 CI 侧 scripts/checks 步骤, 不在 lint/typecheck/test/build/runtime-smoke 内）。
  //    显式 GET 本身也更严: 非 GET 的 /me 会走 fallback 而不是被这条 stub 顺带吞掉。
  await mockJson(
    page,
    ME_URL,
    200,
    {
      id: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      gender: null,
      avatarUrl: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    'GET',
  );
  await mockJson(page, REFRESH_URL, 200, {
    accessToken: SEED_ACCESS_TOKEN,
    refreshToken: SEED_REFRESH_TOKEN,
    accountId: SEED_ACCOUNT_ID,
  });
  await page.addInitScript(seedAuthStore);
}

// ════════════════════════════════════════════════════════════════════════════
// 导航 / 交互小工具
// ════════════════════════════════════════════════════════════════════════════

function reportUrl(symbol: string): string {
  return `/optionsdesk/chain-report/${encodeURIComponent(symbol)}`;
}

function detailUrl(symbol: string): string {
  return `/optionsdesk/underlying/${encodeURIComponent(symbol)}`;
}

/** 等报表主体到位（网格画出来了）。 */
async function waitForGrid(page: Page): Promise<void> {
  await expect(page.getByTestId('chain-report-grid')).toBeVisible({ timeout: 90_000 });
}

async function boxOf(target: Locator) {
  const box = await target.boundingBox();
  if (box === null) throw new Error('取不到 boundingBox');
  return box;
}

/**
 * 轻点一个格 —— 走**指针事件流**（RNGH 的 `Gesture.Tap` 只吃这一条通路）。
 * 🚨 按住时长 MUST 远小于 `CHAIN_REPORT_CROSSHAIR_LONG_PRESS_MS`（300ms），否则赢的是十字线。
 */
async function tapCell(page: Page, cell: Locator): Promise<void> {
  const box = await boxOf(cell);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
}

/**
 * 长按并停在某个格上 —— 驱动十字线（`Gesture.Pan().activateAfterLongPress(300)`）。
 * 调用方负责在断言完之后 `page.mouse.up()`（松手退出，`FR-025`）。
 * 🚨 必须 `down` → 等过长按阈值 → **多次** `move`：一次到位的 move 可能被当成瞬移。
 */
async function pressAndHoldCell(page: Page, cell: Locator): Promise<void> {
  const box = await boxOf(cell);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(420);
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(cx + i * 0.5, cy);
    await page.waitForTimeout(24);
  }
}

/** 屏上所有格的 testID（`chain-report-cell-<行>-<列>-<码>`）。 */
async function cellIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="chain-report-cell-"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-testid') ?? ''));
}

/** 只取「第几行第几列」那一半 —— 位置集合（`SC-002` 的「位置逐格不变」）。 */
function positionsOf(ids: readonly string[]): string[] {
  return ids.map((id) => id.split('-').slice(0, 5).join('-')).sort();
}

/** 只取码 —— 格态集合（`SC-002` 的「格态随之重算」）。 */
function codesOf(ids: readonly string[]): string[] {
  return ids.map((id) => id.split('-').slice(5).join('-'));
}

// ════════════════════════════════════════════════════════════════════════════
// ① 入口与可达性（state_branch 6 / FR-035–FR-037a / US4-AS1）
// ════════════════════════════════════════════════════════════════════════════

test('055 T015 — 详情屏入口行：在 046 三块之后、选约区块之前，措辞不与温度计「全景」重复（FR-035/036/037）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
  });
  await page.goto(detailUrl(SYMBOL));

  const entry = page.getByTestId('optionsdesk-detail-chain-report-entry');
  await expect(entry).toBeVisible({ timeout: 90_000 });
  await expect(entry).toContainText(COPY.entryTitle);
  // 🚨 FR-037：同屏两个入口的措辞互异 —— 撞名会让两个入口文案相同、目的地不同。
  await expect(entry).not.toContainText('全景');
  await expect(page.getByTestId('optionsdesk-detail-iv-panorama')).toContainText(COPY.panorama);

  // 🚨 FR-035 位置：在区间时序（046 第三块）**之下**、选约区块头**之上**。
  const series = await boxOf(page.getByTestId('optionsdesk-detail-series'));
  const entryBox = await boxOf(entry);
  const legHeader = await boxOf(page.getByTestId('optionsdesk-detail-leg-header'));
  expect(entryBox.y).toBeGreaterThan(series.y);
  expect(entryBox.y).toBeLessThan(legHeader.y);

  // 🚨 FR-036 不进吸顶区：往下滚之后**入口滚走了、而选约区块头还钉在上面**。
  //    （只断言「入口在 header 之上」区分不出这两者 —— 吸顶的东西一开始也在上面。）
  await page.mouse.move(200, 500);
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(400);
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible();
  const afterScroll = await entry.boundingBox();
  expect(afterScroll === null || afterScroll.y < entryBox.y).toBe(true);

  await entry.tap();
  await expect(page).toHaveURL(/\/optionsdesk\/chain-report\//, { timeout: 30_000 });
  await waitForGrid(page);
});

test('055 T015 — 未建锚：入口整行不出现，且深链直达被拦成建锚引导（FR-037a / state_branch 6）', async ({
  page,
}) => {
  await installChainReportMock(page, { anchors: [] });

  await page.goto(detailUrl(SYMBOL));
  await expect(page.getByTestId('optionsdesk-detail-no-anchor')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('optionsdesk-detail-chain-report-entry')).toHaveCount(0);

  // 🚨 深链直达 —— MUST NOT 渲染一张缺一角的报表。
  await page.goto(reportUrl(SYMBOL));
  await expect(page.getByTestId('chain-report-no-anchor')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('chain-report-no-anchor')).toContainText(COPY.noAnchor);
  await expect(page.getByTestId('chain-report-grid')).toHaveCount(0);
  await expect(page.getByTestId('chain-report-metrics')).toHaveCount(0);
  // 🚨 未建锚是预期分支不是故障 ⇒ 不叠一句「读取失败」、不给重试。
  await expect(page.getByTestId('chain-report-retry')).toHaveCount(0);
  await expect(page.getByTestId('chain-report-create-anchor')).toBeVisible();
});

// ════════════════════════════════════════════════════════════════════════════
// ② 常态 + 切换格值（state_branch 2 / SC-002）
// ════════════════════════════════════════════════════════════════════════════

test('055 T012 — 切四种格值：屏上**位置逐格不变**而格态集合改变；页脚三计数各带分母（SC-002 / FR-034）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);

  const rentIds = await cellIds(page);
  expect(rentIds.length).toBe(ROW_COUNT * COL_COUNT);
  const rentPositions = positionsOf(rentIds);

  const snapshots: Record<string, string[]> = { rentAnnualized: codesOf(rentIds) };
  for (const metric of ['buildQuality', 'allAnnualized', 'activity']) {
    await page.getByTestId(`chain-report-metric-${metric}`).tap();
    await page.waitForTimeout(200);
    const ids = await cellIds(page);
    // 🚨 位置逐格不变（同一份骨架）—— 这是本片唯一不能出错的东西。
    expect(positionsOf(ids)).toEqual(rentPositions);
    snapshots[metric] = codesOf(ids);
  }

  // 🚨 而格态**必须**变过 —— 位置不变被读成「格态不变」正是 `FR-010` 明令区分的那件事。
  expect(snapshots.buildQuality).not.toEqual(snapshots.rentAnnualized);
  expect(snapshots.allAnnualized).not.toEqual(snapshots.rentAnnualized);

  // 页脚三条各带各的分母，🚫 不合并成一个总数。
  await expect(page.getByTestId('chain-report-gate-premium')).toContainText('全量');
  await expect(page.getByTestId('chain-report-gate-row_floor')).toContainText('骨架');
  await expect(page.getByTestId('chain-report-gate-liveness')).toContainText('行内');
  await expect(page.getByTestId('chain-report-gate-hint')).toBeVisible();
});

// ════════════════════════════════════════════════════════════════════════════
// ③ 段外列淡出（state_branch 3 / FR-009a）
// ════════════════════════════════════════════════════════════════════════════

test('055 T011 — 段外列整列淡出且列仍在：主信号是列头「段外」chip，与格级「被门槛挡下」不同码', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);

  // 收租格值下：首列（DTE 7）与末列（DTE 200）都在收租段之外。
  await expect(page.getByTestId('chain-report-out-of-band-chip').first()).toBeVisible();
  await expect(page.getByTestId('chain-report-out-of-band-chip')).toHaveCount(2);
  await expect(page.getByText(COPY.outOfBandChip).first()).toBeVisible();

  const ids = await cellIds(page);
  // 🚨 淡出**不是裁剪** —— 段外列仍参与列数。
  expect(ids.length).toBe(ROW_COUNT * COL_COUNT);
  const outOfBand = ids.filter((id) => id.endsWith('-out_of_band'));
  expect(outOfBand.length).toBe(ROW_COUNT * 2);
  // 🚨 两级编码不同码：段外（列级）与被挡下（格级）说的是两件事。
  expect(ids.some((id) => id.endsWith('-blocked'))).toBe(true);

  // 切到全腿 —— 那个视角不受期限段约束 ⇒ 一列都不淡出，而列数不变。
  await page.getByTestId('chain-report-metric-allAnnualized').tap();
  await page.waitForTimeout(200);
  await expect(page.getByTestId('chain-report-out-of-band-chip')).toHaveCount(0);
  expect((await cellIds(page)).length).toBe(ROW_COUNT * COL_COUNT);
});

/**
 * 🚧 **补测（#45）**：055 T021 真机验收时列头四元素只验到三个 —— `月` chip 在**任何环境下都
 * 产不出来**，因为 server 侧判据 `isMonthlyChain` 恒 `false`（交易日历结构上不含未来交易日）。
 * 判据换源到 vendor 到期周期之后这一跳才验得了，本条把那个缺口补上。
 *
 * ⚠️ **本条能守什么、守不住什么**（别把它当真机验收的替代）：
 * - ✅ 守得住「条件接错 / chip 恒 true / 恒 false / 随格值乱变」这几类**逻辑**错法。
 * - 🚫 守不住**原生布局塌陷** —— 同容器的 `段外` chip 在 T021 真机上就整片高度塌成 0 而
 *   `chain-report-out-of-band-chip` 的 web 断言照常绿（成因见 `chain-report-grid.tsx` 列头那段
 *   `flex-row` 的注释：CSS 下 auto 高的 flex 容器按 max-content 参与父高计算，Yoga 直接得 0）。
 *   ⇒ 真机复看仍是必须的，这条不构成它的证据。
 */
test('055 T021 补 — 列头「月」chip：只在月度链列出现，且**与格值切换正交**（#45）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);

  // 固定列集里 6 列有 3 列 `isMonthlyChain`（09-18 / 12-18 / 2027-03-19）。
  await expect(page.getByTestId('chain-report-monthly-chip').first()).toBeVisible();
  await expect(page.getByTestId('chain-report-monthly-chip')).toHaveCount(3);
  await expect(page.getByText(COPY.monthlyChip).first()).toBeVisible();

  // 🚨 **与同容器的兄弟 chip 正交**：段外随格值变（收租 2 个 → 全腿 0 个），月度标恒 3 个。
  //    月度是到期日的属性、段外是「这一列归不归当前视角」—— 两级不同码（Guardrail 7）。
  //    只断月度数目不够: 若两个 chip 一起消失, 那是容器塌了而不是判据错, 故两条一起断。
  await expect(page.getByTestId('chain-report-out-of-band-chip')).toHaveCount(2);
  await page.getByTestId('chain-report-metric-allAnnualized').tap();
  await page.waitForTimeout(200);
  await expect(page.getByTestId('chain-report-out-of-band-chip')).toHaveCount(0);
  await expect(page.getByTestId('chain-report-monthly-chip')).toHaveCount(3);
});

test('055 T021 补 — 一列都不是月度链 ⇒ 一个「月」chip 都不出（防恒 true，#45）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: {
      [SYMBOL]: makeReport({ columns: COLUMNS.map((c) => ({ ...c, isMonthlyChain: false })) }),
    },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);

  await expect(page.getByTestId('chain-report-monthly-chip')).toHaveCount(0);
  // 🚨 判别性: 列头本身照常渲染（否则「0 个」可能只是整块没画出来）。
  await expect(page.getByTestId('chain-report-out-of-band-chip')).toHaveCount(2);
});

// ════════════════════════════════════════════════════════════════════════════
// ④ 某格值零非空格（state_branch 4）＋ ⑤ 价内行不着色（state_branch 5 / SC-013）
// ════════════════════════════════════════════════════════════════════════════

test('055 T017 — 某格值下零非空格：骨架与行列标签照常渲染，不是空白页也不是错误页（state_branch 4）', async ({
  page,
}) => {
  const cells = defaultGrids();
  // 建仓那一张整张为空（链级仍有值 ⇒ 页态是常态）。
  cells.buildQuality = gridOf({ map: uniformMap('a'), best: '0' });
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport({ cells }) },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);

  await page.getByTestId('chain-report-metric-buildQuality').tap();
  await page.waitForTimeout(200);

  await expect(page.getByTestId('chain-report-grid')).toBeVisible();
  expect((await cellIds(page)).length).toBe(ROW_COUNT * COL_COUNT);
  // 行标签照常（顶档那条开口读法）+ 列头照常。
  await expect(page.getByText('>60%').first()).toBeVisible();
  await expect(page.getByTestId('chain-report-footer')).toBeVisible();
  // 🚫 没有降级屏 —— 零非空格是**正确行为**不是故障。
  await expect(page.getByTestId('chain-report-degraded-chain_not_ready')).toHaveCount(0);
  await expect(page.getByTestId('chain-report-degraded-read_failed')).toHaveCount(0);
});

test('055 T009 — 全腿年化 × 价内行：不着色但**读数与腿数照常**，行标带 †（FR-019c / SC-013）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);

  await page.getByTestId('chain-report-metric-allAnnualized').tap();
  await page.waitForTimeout(200);

  // 首行（价内档）整行走「口径不适用」码 —— 与「无合约」不同码，且格内**有数字**。
  const ids = await cellIds(page);
  const firstRow = ids.filter((id) => id.startsWith('chain-report-cell-0-'));
  expect(firstRow.length).toBe(COL_COUNT);
  expect(firstRow.every((id) => id.endsWith('-inapplicable'))).toBe(true);
  await expect(page.getByTestId('chain-report-cell-0-0-inapplicable')).toContainText('9.2%');

  // 行标带 † —— 与「不着色」**同一个判据**（两处各判一次必错开）。
  await expect(page.getByText('价内0-10 †')).toBeVisible();

  // 切回收租：同一行不再带 †（口径不适用是**格值的函数**）。
  await page.getByTestId('chain-report-metric-rentAnnualized').tap();
  await page.waitForTimeout(200);
  await expect(page.getByText('价内0-10 †')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ 降级态（state_branch 7 / 8 / 20 + 加载 / 读失败）
// ════════════════════════════════════════════════════════════════════════════

test('055 T017 — 链未就绪 与 全被门槛挡下**可分辨**：后者网格照画 + 三计数（state_branch 7/8）', async ({
  page,
}) => {
  const allGatedCounts = { ...DEFAULT_COUNTS, outsideRowFloor: 261 + 274, valued: 0 };
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL }), makeAnchor({ id: '2', ticker: 'us:PEP' })],
    reports: {
      [SYMBOL]: makeReport({ state: 'chain_not_ready' }),
      'us:PEP': makeReport({
        gateCounts: allGatedCounts,
        cells: {
          buildQuality: gridOf({ map: uniformMap('g'), best: '0' }),
          rentAnnualized: gridOf({ map: uniformMap('g'), best: '0' }),
          allAnnualized: gridOf({ map: uniformMap('g'), best: '0' }),
          activity: gridOf({ map: uniformMap('g'), best: '0' }),
        },
      }),
    },
  });

  // ① 链未就绪 —— 一句说明，**不画网格**、不给重试（它是事实不是故障）。
  await page.goto(reportUrl(SYMBOL));
  const notReady = page.getByTestId('chain-report-degraded-chain_not_ready');
  await expect(notReady).toBeVisible({ timeout: 90_000 });
  await expect(notReady).toContainText(COPY.chainNotReady);
  await expect(page.getByTestId('chain-report-grid')).toHaveCount(0);
  await expect(page.getByTestId('chain-report-retry')).toHaveCount(0);

  // ② 全被门槛挡下 —— **网格照画** + 说明句 + 页脚三计数（否则「全是斜线」看起来像坏了）。
  await page.goto(reportUrl('us:PEP'));
  await waitForGrid(page);
  await expect(page.getByTestId('chain-report-all-gated')).toContainText(COPY.allGated);
  await expect(page.getByTestId('chain-report-footer')).toBeVisible();
  await expect(page.getByTestId('chain-report-gate-premium')).toBeVisible();
  const ids = await cellIds(page);
  expect(ids.length).toBe(ROW_COUNT * COL_COUNT);
  expect(ids.every((id) => id.endsWith('-blocked') || id.endsWith('-out_of_band'))).toBe(true);
  // 🚨 两者不是同一屏：未就绪那句在这里不出现。
  await expect(page.getByTestId('chain-report-degraded-chain_not_ready')).toHaveCount(0);
});

test('055 T017 — 现价缺失 ⇒ 行轴无从定义（不画网格）；读失败 ⇒ 可重试，且**页头照常**（state_branch 20）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL }), makeAnchor({ id: '2', ticker: 'us:PEP' })],
    reports: {
      [SYMBOL]: makeReport({ spot: null }),
      'us:PEP': makeReport({ state: 'read_failed' }),
    },
  });

  await page.goto(reportUrl(SYMBOL));
  const noSpot = page.getByTestId('chain-report-degraded-no_spot');
  await expect(noSpot).toBeVisible({ timeout: 90_000 });
  await expect(noSpot).toContainText(COPY.noSpot);
  await expect(page.getByTestId('chain-report-grid')).toHaveCount(0);
  await expect(page.getByTestId('chain-report-retry')).toHaveCount(0);

  await page.goto(reportUrl('us:PEP'));
  const failed = page.getByTestId('chain-report-degraded-read_failed');
  await expect(failed).toBeVisible({ timeout: 90_000 });
  await expect(failed).toContainText(COPY.readFailed);
  await expect(page.getByTestId('chain-report-retry')).toBeVisible();
  // 🚨 页头 IV 分位按自己的四态独立降级 —— 网格挂了它明明读得到。
  await expect(page.getByTestId('chain-report-header')).toBeVisible();
  await expect(page.getByTestId('chain-report-ivp-bar')).toBeVisible();
  await expect(page.getByTestId('chain-report-grid')).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ IV 分位四态（state_branch 18）
// ════════════════════════════════════════════════════════════════════════════

test('055 T010 — 页头 IV 分位四态都渲染这一块，🚫 无分位时绝不落回 0（state_branch 18 / US3-AS5）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: ['1', '2', '3', '4'].map((id, i) =>
      makeAnchor({ id, ticker: [SYMBOL, 'us:PEP', 'us:AOS', 'us:MMM'][i] ?? SYMBOL }),
    ),
    reports: {
      [SYMBOL]: makeReport({ iv: makeIv() }),
      'us:PEP': makeReport({ iv: IV_NO_PERCENTILE }),
      'us:AOS': makeReport({ iv: IV_MISSING }),
      'us:MMM': makeReport({ iv: IV_READ_FAILED }),
    },
  });

  // ① 有分位 —— 数值出现在页头，分段条带标记。
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);
  await expect(page.getByTestId('chain-report-header')).toContainText('58');
  await expect(page.getByTestId('chain-report-ivp-bar')).toBeVisible();

  // ②③④ 其余三态：这一块**照常渲染**，且屏上没有一个 `0 / 100` 的分位读数。
  for (const symbol of ['us:PEP', 'us:AOS', 'us:MMM']) {
    await page.goto(reportUrl(symbol));
    await waitForGrid(page);
    const header = page.getByTestId('chain-report-header');
    await expect(header).toBeVisible();
    await expect(page.getByTestId('chain-report-ivp-bar')).toBeVisible();
    await expect(header).not.toContainText('0 / 100');
  }
  // 「分位不可算」那一态说出它自己的原因（🚫 不与「暂无数据」合并）。
  await page.goto(reportUrl('us:PEP'));
  await waitForGrid(page);
  await expect(page.getByTestId('chain-report-header')).toContainText(COPY.percentileUnavailable);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑧ 十字线读数（state_branch 14/15 · SC-004）—— 只验**状态面**，手势归属归 T021
// ════════════════════════════════════════════════════════════════════════════

test('055 T014 — 长按落在单腿格：读数面板给到期日 / 区间 / 腿数 / 最优，次优显式呈「无」（state_branch 14 / SC-004）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);
  // 全腿网格的有值格都是**单腿**（`runnerUp: null` + `legCount: 1`）。
  await page.getByTestId('chain-report-metric-allAnnualized').tap();
  await page.waitForTimeout(200);

  await pressAndHoldCell(page, page.getByTestId('chain-report-cell-2-1-band'));
  const readout = page.getByTestId('chain-report-readout');
  await expect(readout).toBeVisible({ timeout: 10_000 });
  // 🚨 FR-028：次优 MUST 显式呈「无」，🚫 不复述最优值充数。
  await expect(readout).toContainText(COPY.runnerUpSingle);
  // SC-004：格明细与**本列 IV** 在同一次操作里一起给出。
  await expect(readout).toContainText('09-04');
  await expect(readout).toContainText('27.4');
  // 竖线画在列区之内（`FR-026` 的一半）。
  await expect(page.getByTestId('chain-report-crosshair-v')).toBeVisible();

  await page.mouse.up();
  // 松手退出（`FR-025`）—— 🚫 不留一条画在屏上的孤线。
  await expect(page.getByTestId('chain-report-readout')).toHaveCount(0);
  await expect(page.getByTestId('chain-report-crosshair-v')).toHaveCount(0);
});

test('055 T014 — 长按落在空格：给出**为什么空**，🚫 不停留在上一格的读数（state_branch 15 / FR-029）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);
  await page.getByTestId('chain-report-metric-allAnnualized').tap();
  await page.waitForTimeout(200);

  // 「有腿但被门槛挡下」与「该位置链上无合约」是两条完全不同的处置路径 —— 各自成句。
  await pressAndHoldCell(page, page.getByTestId('chain-report-cell-6-0-blocked'));
  await expect(page.getByTestId('chain-report-readout-reason')).toContainText(COPY.reasonBlocked, {
    timeout: 10_000,
  });
  await page.mouse.up();

  await pressAndHoldCell(page, page.getByTestId('chain-report-cell-7-0-void'));
  await expect(page.getByTestId('chain-report-readout-reason')).toContainText(COPY.reasonVoid, {
    timeout: 10_000,
  });
  await page.mouse.up();
});

// ════════════════════════════════════════════════════════════════════════════
// ⑨ 下钻（state_branch 23/24 · US4-AS2/AS3 · FR-038/039/039a）
// ════════════════════════════════════════════════════════════════════════════

test('055 T016 — 点有值格 → 落选约区块且条件已预填；点空格不跳转（state_branch 23 / US4-AS2/AS3）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);

  // ① 点空格 —— **不跳转**（URL 一字不变）。
  //    ⚠️ 取的是**段内**那一列的空格（首列在收租段之外 ⇒ 那里的码是 `out_of_band` 不是 `void`）。
  const before = page.url();
  await tapCell(page, page.getByTestId('chain-report-cell-7-1-void'));
  await page.waitForTimeout(400);
  expect(page.url()).toBe(before);

  // ② 点有值格 —— 落详情屏，且期限 / 行权价 / 视角随参数同行。
  //    收租格值 ⇒ 落**收租视角**；第 2 列 = DTE 45；第 2 行 = 价外 10-20%。
  await tapCell(page, page.getByTestId('chain-report-cell-2-2-band'));
  await expect(page).toHaveURL(/\/optionsdesk\/underlying\//, { timeout: 30_000 });
  await expect(page).toHaveURL(/perspective=rent/);
  await expect(page).toHaveURL(/dteMin=45/);
  await expect(page).toHaveURL(/dteMax=45/);
  await expect(page).toHaveURL(/strikeMin=/);

  // 落地后选约区块渲染出来了，且 Tab 停在收租。
  await expect(page.getByTestId('optionsdesk-detail-leg-header')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('optionsdesk-detail-leg-tab-rent')).toBeVisible();
  // 业务日两侧相同 ⇒ 不该出那句提示（`SC-010` 前半）。
  await expect(page.getByTestId('optionsdesk-detail-leg-drilldown-asof')).toHaveCount(0);
});

test('055 T016 — 全腿 / 活跃度格值下钻一律落**全腿视角**（FR-039）', async ({ page }) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);

  await page.getByTestId('chain-report-metric-activity').tap();
  await page.waitForTimeout(200);
  await tapCell(page, page.getByTestId('chain-report-cell-2-2-band'));
  await expect(page).toHaveURL(/perspective=all/, { timeout: 30_000 });
});

test('055 T016 — 下钻后两侧业务日不一致：两个时点各自可见（state_branch 24 / FR-039a / SC-010）', async ({
  page,
}) => {
  await installChainReportMock(page, {
    anchors: [makeAnchor({ id: '1', ticker: SYMBOL })],
    reports: { [SYMBOL]: makeReport() },
    // 报表读的是 08-11 那批、选约表已经翻到 08-12 —— 条数不符是**数据真的变了**。
    legAsOf: '2026-08-12',
  });
  await page.goto(reportUrl(SYMBOL));
  await waitForGrid(page);

  await tapCell(page, page.getByTestId('chain-report-cell-2-2-band'));
  const notice = page.getByTestId('optionsdesk-detail-leg-drilldown-asof');
  await expect(notice).toBeVisible({ timeout: 90_000 });
  // 🚨 FR-039a：**两个**时点都要说出来（只说一个等于没说）。
  await expect(notice).toContainText(REPORT_AS_OF);
  await expect(notice).toContainText('2026-08-12');
});
