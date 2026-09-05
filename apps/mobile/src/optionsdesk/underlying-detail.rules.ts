// 046 T021 — 标的详情屏（上半）纯函数（FR-001/002/004/005/006/007/008/010/011/012/013/014/
// 020/035/036, plan D2/D9）。屏与子件只做接线，判定全在这里（体例同 045 `radar.rules.ts`）。
// 渲染 / 交互 / a11y 走 T024 Playwright e2e —— 本仓测试分层 vitest=logic / Playwright=UI。
//
// 🚨 **两端点并行合成，各自 asOf、各自独立降级、禁整页失败**（plan D2 / state_branch #15）：
//    optionsdesk 详情端点（锚卡 + 四区间边界 + IV 读数）与 marketdata bars 端点（价格序列）
//    是**两条独立的成败线**。任一侧失败，另一侧照常渲染。⚠️ 这条与业界 BFF 共识相反，是
//    spec § Clarifications Q1 论证过的刻意选择（modular monolith 同进程 + 两个 GET 并行 +
//    HTTP/2 已开 ⇒ 成本 ≈ max(t1,t2)），**别"优化"成后端聚合或整页 loading**。
//
// 🚨 **FR-035 口径单源**：IV 一律「富途标的聚合 IV」，**禁写 IV30d**。本文件与
//    `optionsdesk-copy.ts` 的 `underlyingDetail` 子树都有机械断言守着（spec 末段）。
//
// 🚨 **FR-013**：IVP 优先于 IVR 呈现，且 IVR（`iv_rank`）**只落库不上屏** —— server 侧
//    `select` 根本不取那一列（结构性成立），本文件的 {@link IV_READOUT_FIELD_ORDER} 是防回归。
import type {
  AnchorResponse,
  DailyBarItem,
  LegResponse,
  LegTableResponseState,
  MarketdataControllerBarsPeriod,
  UnderlyingIvReadoutResponse,
  UnderlyingIvReadoutResponseState,
} from '@nvy/api-client';

import { formatAsOfLabel } from '~/format/as-of';
import { formatPositionCap } from './anchor-form.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { formatPriceText } from './price-format.rules';
import { barsPeriodForWindow, type TimeSeriesWindow } from './window-granularity.rules';
import type { BandZone } from './zone-band.rules';

const COPY = OPTIONSDESK_COPY.underlyingDetail;

/**
 * server Decimal string → number；null / 空 / 非数字 → null（不编造值）。
 * T022 的温度计规则也消费它 —— 两处必须对 Decimal 串的解析行为完全一致，故单源在此。
 */
export function toFinite(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// ═══════════════════ ① 两端点合成的降级决策（plan D2 / state_branch #15） ═══════════════════

/** 无锚 404 的机器可读 code（server `get-underlying-detail.usecase.ts` 同名常量）。 */
export const ANCHOR_NOT_FOUND_CODE = 'ANCHOR_NOT_FOUND_FOR_SYMBOL';

/** 单块的三态。**没有「整页」这一档** —— 那正是本片要防的。 */
export type BlockState = 'loading' | 'ready' | 'failed';

/**
 * 页级只有两态：常态 / 无锚。
 * 🚨 **没有 `error` 页也没有整页 `loading`** —— 任一端点故障只降级它自己那一块（FR-011 的
 * 「无锚」是唯一的整页分支，因为那时锚卡与四区间带都无从谈起，且它要的是**引导**不是报错）。
 */
export type DetailPageState = 'ready' | 'no_anchor';

/** 一侧请求的成败（吃 react-query 的结构子集，测试可造小 fixture）。 */
export interface SideStatus {
  isPending: boolean;
  isError: boolean;
  error?: unknown;
}

export interface DetailComposition {
  page: DetailPageState;
  /** 锚卡 + 个股温度计区块（同一端点 ⇒ 同一条成败线）。 */
  anchorCard: BlockState;
  /** 区间时序的折线区（四区间背景带只依赖锚，序列失败时照常画）。 */
  series: BlockState;
}

/**
 * 无锚判别（FR-011）。ProblemDetail 的 `code` 在透传白名单内 ⇒ 优先认它；
 * 退一步认 404 —— 该端点只在「没建锚」这一种情况下 404。
 */
export function isNoAnchorError(error: unknown): boolean {
  const e = error as {
    isAxiosError?: boolean;
    response?: { status?: number; data?: { code?: string } };
  };
  if (!e?.isAxiosError) return false;
  if (e.response?.data?.code === ANCHOR_NOT_FOUND_CODE) return true;
  return e.response?.status === 404;
}

function blockState(side: SideStatus): BlockState {
  if (side.isError) return 'failed';
  return side.isPending ? 'loading' : 'ready';
}

/**
 * 两端点四种成败组合 → 三块各自的呈现态。复杂度 O(1)。
 *
 * 🚨 **不变量：`page` 恒为 `'ready'`，除非详情端点明确说「这只票没建锚」。**
 *    两侧同时 5xx 也不整页失败 —— 两块各自显式降级，用户至少知道哪半边坏了。
 */
export function composeUnderlyingDetail(detail: SideStatus, series: SideStatus): DetailComposition {
  const noAnchor = detail.isError && isNoAnchorError(detail.error);
  return {
    page: noAnchor ? 'no_anchor' : 'ready',
    anchorCard: blockState(detail),
    series: blockState(series),
  };
}

// ═══════════════════ ② asOf 新鲜度分档（FR-020） ═══════════════════

/**
 * 呈现侧三档 —— **值域与 server 契约的 `freshnessTier` 逐字对齐**（`CURRENT / STALE /
 * UNAVAILABLE`）。orval 为每个字段各生成一个同值域的字面量联合，结构上互相可赋值。
 */
export const FRESHNESS_TIERS = ['CURRENT', 'STALE', 'UNAVAILABLE'] as const;

export type FreshnessTier = (typeof FRESHNESS_TIERS)[number];

export interface Freshness {
  tier: FreshnessTier;
  /** 数据自身的业务日；无数据 → null，**不编造日期**。 */
  asOf: string | null;
  text: string;
}

/**
 * 「数据截至 X · 收盘」+ 新鲜度档的**文案化**。复杂度 O(1)。
 *
 * 🚨 **档位由 server 下发，客户端不再自判**（FR-020）。判据是「asOf 是否落后于该市场最近一个
 *    已收盘交易日」，要查交易日历 —— 客户端没有。初版拿 `asOf === 设备本地日期` 判，对美股
 *    **永不可达**（美股 08-04 的 EOD 要到北京 08-05 清晨才落库，那时设备已是 08-05）⇒ 境内
 *    用户看到的每个美股读数恒显「已过时」，FR-020 想区分的信号完全失效。**别改回本地比日期。**
 *
 * 🚨 两侧（锚卡行情 / IV 读数）**各调各的**，不合并成一个页级 asOf —— 它们是两个独立的
 *    新鲜度，合并等于把其中一个的陈旧藏起来（FR-020）。
 */
export function freshnessOf(asOf: string | null | undefined, tier: FreshnessTier): Freshness {
  // asOf 缺失时无论 server 说什么都渲染「不可用」—— 绝不渲染「数据截至 null」。
  if (!asOf || tier === 'UNAVAILABLE') {
    return { tier: 'UNAVAILABLE', asOf: null, text: COPY.freshness.unavailable };
  }
  const label = formatAsOfLabel(asOf, 'eod_close');
  if (tier === 'CURRENT') return { tier, asOf, text: label };
  return { tier: 'STALE', asOf, text: `${label}${COPY.freshness.staleSuffix}` };
}

// ═══════════════════ ③ 锚卡（FR-002 / FR-004 / FR-005） ═══════════════════

/**
 * FR-002 的字段清单，**按呈现顺序**。`Record`/穷举断言的载体 —— 少一个即单测红。
 * ⚠️ **没有 `willingSell`**：本片只实现「未持股」半边（见 {@link WILLING_SELL_ROW_VISIBLE}）。
 */
export const ANCHOR_CARD_FIELD_KEYS = [
  'lLevel',
  'asof',
  'v',
  'w',
  'confidence',
  'method',
  'positionCap',
  'positionLevel',
  'nextReview',
] as const;

export type AnchorCardFieldKey = (typeof ANCHOR_CARD_FIELD_KEYS)[number];

/** 版面槽位：题头 / 键值网格 / 卡底。 */
export type AnchorCardSlot = 'header' | 'grid' | 'footer';

export interface AnchorCardField {
  key: AnchorCardFieldKey;
  slot: AnchorCardSlot;
  label: string;
  value: string;
  /** FR-004 人工态（本片**只读呈现**，不给编辑入口）。 */
  manual: boolean;
  /** FR-005 红标（逾期）/ W 的强调色。 */
  danger: boolean;
}

const FIELD_SLOT: Record<AnchorCardFieldKey, AnchorCardSlot> = {
  lLevel: 'header',
  asof: 'header',
  v: 'grid',
  w: 'grid',
  confidence: 'grid',
  method: 'grid',
  positionCap: 'grid',
  positionLevel: 'grid',
  nextReview: 'footer',
};

const FIELD_LABEL: Record<AnchorCardFieldKey, string> = {
  lLevel: COPY.anchorCard.fieldLLevel,
  asof: COPY.anchorCard.fieldAsof,
  v: COPY.anchorCard.fieldV,
  w: COPY.anchorCard.fieldW,
  confidence: COPY.anchorCard.fieldConfidence,
  method: COPY.anchorCard.fieldMethod,
  positionCap: COPY.anchorCard.fieldPositionCap,
  positionLevel: COPY.anchorCard.fieldPositionLevel,
  nextReview: COPY.anchorCard.fieldNextReview,
};

/**
 * 🚨 plan D9 ②：持仓规模的数据面属 M3/M4，本片**无通路** ⇒ state_branch #19 的「持股」
 * 半边不可达，愿卖锚行**恒不出现**。持仓接入时改这一个常量 + 加一条 field key。
 */
export const WILLING_SELL_ROW_VISIBLE = false;

/**
 * 🚨 plan D9 ①：仓位水位同理无通路 ⇒ 恒「未知 · 待接入」。**禁显 0 / 0% / 空仓** ——
 * 「不知道」与「知道是零」在这块屏上会被读成截然不同的持仓事实。
 */
export const POSITION_LEVEL_PLACEHOLDER = COPY.anchorCard.positionLevelPending;

type AnchorCardInput = Pick<
  AnchorResponse,
  | 'lLevelEffective'
  | 'lLevelIsManual'
  | 'derivedLLevel'
  | 'asof'
  | 'v'
  | 'w'
  | 'confidence'
  | 'method'
  | 'positionCap'
  | 'positionCapIsManual'
  | 'derivedPositionCap'
  | 'nextReview'
  | 'overdue'
>;

/** 锚卡九字段（FR-002 全量，顺序 = {@link ANCHOR_CARD_FIELD_KEYS}）。复杂度 O(1)。 */
export function anchorCardFields(anchor: AnchorCardInput): AnchorCardField[] {
  const value: Record<AnchorCardFieldKey, string> = {
    lLevel: anchor.lLevelEffective,
    asof: `${COPY.anchorCard.asofPrefix}${anchor.asof}`,
    v: formatPriceText(anchor.v),
    w: formatPriceText(anchor.w),
    confidence: `${anchor.confidence}${COPY.anchorCard.confidenceSuffix}`,
    method: anchor.method || COPY.anchorCard.noValue,
    positionCap: formatPositionCap(anchor.positionCap),
    // 恒态 —— 与 anchor 上任何字段无关（这正是 plan D9 要钉死的点）。
    positionLevel: POSITION_LEVEL_PLACEHOLDER,
    nextReview: nextReviewText(anchor),
  };
  const manual: Record<AnchorCardFieldKey, boolean> = {
    lLevel: anchor.lLevelIsManual,
    asof: false,
    v: false,
    w: false,
    confidence: false,
    method: false,
    positionCap: anchor.positionCapIsManual,
    positionLevel: false,
    nextReview: false,
  };
  return ANCHOR_CARD_FIELD_KEYS.map((key) => ({
    key,
    slot: FIELD_SLOT[key],
    label: FIELD_LABEL[key],
    value: value[key],
    manual: manual[key],
    // W 是愿买价锚（红色加粗，同 045 色带的 W 界线）；逾期红标见 FR-005。
    danger: key === 'w' || (key === 'nextReview' && anchor.overdue),
  }));
}

function nextReviewText(anchor: Pick<AnchorCardInput, 'nextReview' | 'overdue'>): string {
  if (!anchor.nextReview) return COPY.anchorCard.noValue;
  return anchor.overdue
    ? `${anchor.nextReview}${COPY.anchorCard.overdueSuffix}`
    : anchor.nextReview;
}

/**
 * FR-004 人工态提示行（同屏带出派生值，措辞表达**临时**语义）。
 * 无人工位 → 空数组（不留空行）。复杂度 O(1)。
 */
export function anchorManualNotices(
  anchor: Pick<
    AnchorCardInput,
    'lLevelIsManual' | 'derivedLLevel' | 'positionCapIsManual' | 'derivedPositionCap'
  >,
): string[] {
  const out: string[] = [];
  if (anchor.lLevelIsManual) {
    out.push(COPY.anchorCard.manualLLevelHint(anchor.derivedLLevel ?? COPY.anchorCard.noValue));
  }
  if (anchor.positionCapIsManual) {
    out.push(COPY.anchorCard.manualPositionCapHint(formatPositionCap(anchor.derivedPositionCap)));
  }
  return out;
}

// ═══════════════════ ④ 个股温度计区块（FR-012/013/014/035/036） ═══════════════════

/**
 * 🚨 **FR-036 阈值档边界固定 25 / 70 / 90**（四档 `<25` 低 / `25–70` 中 / `70–90` 高 /
 * `≥90` 极高）。依据 = mockup 分段条**段宽** 25/45/20/10（两帧共 6 处一致）。
 * ⚠️ 同组画的刻度标签写的是 `0/50/90/100`，**那是错的** —— 2026-08-02 analyze 扫出、
 * user 拍板以段宽为准。照刻度写会让「提醒状态」整体偏移一整档，**且不会红**。
 */
export const IVP_MID_MIN = 25;
export const IVP_HIGH_MIN = 70;
export const IVP_EXTREME_MIN = 90;

/** 刻度标签与段宽**同源** —— 这条数组既是刻度也是段宽的推导基。 */
export const IVP_TIER_BOUNDARIES = [IVP_MID_MIN, IVP_HIGH_MIN, IVP_EXTREME_MIN] as const;

export const IVP_TIERS = ['low', 'mid', 'high', 'extreme'] as const;

export type IvpTier = (typeof IVP_TIERS)[number];

/** 分段条 4 段（宽度由边界派生 ⇒ 改边界时刻度与段宽不可能脱节）。合计 100%。 */
export const IVP_SEGMENTS: readonly { tier: IvpTier; widthPct: number }[] = [
  { tier: 'low', widthPct: IVP_MID_MIN },
  { tier: 'mid', widthPct: IVP_HIGH_MIN - IVP_MID_MIN },
  { tier: 'high', widthPct: IVP_EXTREME_MIN - IVP_HIGH_MIN },
  { tier: 'extreme', widthPct: 100 - IVP_EXTREME_MIN },
];

/** IVP 值（0–100）→ 档。边界值归**上**档（`25`→mid / `70`→high / `90`→extreme）。O(1)。 */
export function ivpTier(ivPercentile: number): IvpTier {
  if (ivPercentile >= IVP_EXTREME_MIN) return 'extreme';
  if (ivPercentile >= IVP_HIGH_MIN) return 'high';
  if (ivPercentile >= IVP_MID_MIN) return 'mid';
  return 'low';
}

export const ALERT_STATUSES = ['not_crossed', 'crossed_high', 'crossed_extreme'] as const;

export type AlertStatus = (typeof ALERT_STATUSES)[number];

const ALERT_TEXT: Record<AlertStatus, string> = {
  not_crossed: COPY.ivBlock.alertNotCrossed,
  crossed_high: COPY.ivBlock.alertCrossedHigh,
  crossed_extreme: COPY.ivBlock.alertCrossedExtreme,
};

/** 提醒状态徽标文案（本片只呈现档位，**无发送链路** —— 随提醒器后置 V9）。 */
export function alertStatusText(status: AlertStatus): string {
  return ALERT_TEXT[status];
}

/**
 * FR-036 提醒状态：由 IVP 档位**纯派生**，不另立第二套阈值。
 * 🚨 **IVP 不可算 / 缺失 ⇒ `null`，徽标 MUST NOT 出现**（无 IVP 即无档位）。O(1)。
 */
export function alertStatusOf(ivPercentile: number | null): AlertStatus | null {
  if (ivPercentile === null) return null;
  const tier = ivpTier(ivPercentile);
  if (tier === 'extreme') return 'crossed_extreme';
  if (tier === 'high') return 'crossed_high';
  return 'not_crossed';
}

/**
 * 🚨 **FR-013 机械防线**：呈现字段里 **IVP 在聚合 IV 之前**，且**没有 `ivRank`** ——
 * vendor 的 IVR 照常落库，但详情页与 P7 列表的呈现面 MUST NOT 出现它。
 * server 的 `select` 已不取那一列（结构性成立），本常量是防回归的第二道。
 */
export const IV_READOUT_FIELD_ORDER = ['ivPercentile', 'aggregateIv'] as const;

export interface IvReadoutView {
  state: UnderlyingIvReadoutResponseState;
  /** IVP 数值（0–100）；非 available 态一律 `null`（**禁回落 0**，FR-014）。 */
  ivPercentile: number | null;
  /** 大数字位；无值时为 `null`（改由 {@link IvReadoutView.degradedText} 占位）。 */
  ivpText: string | null;
  /** 三个降级态**各自成句**（不可算 / 暂无数据 / 读故障，禁合并）；有值 ⇒ `null`。 */
  degradedText: string | null;
  /** FR-035：一律「富途标的聚合 IV」的数值行。缺失 ⇒ 「—」，不裸 0。 */
  aggregateIvText: string;
  /** FR-036 徽标；不可算 ⇒ `null`。 */
  alert: AlertStatus | null;
  /** 该读数**自己的** asOf（与锚卡行情 asOf 互不牵连，FR-020）。 */
  freshness: Freshness;
  /** 分段条是否画位置标记（无 IVP 时段带照常画、只是没有标记）。 */
  showMarker: boolean;
}

const DEGRADED_TEXT: Record<Exclude<UnderlyingIvReadoutResponseState, 'available'>, string> = {
  percentile_unavailable: COPY.ivBlock.percentileUnavailable,
  missing: COPY.ivBlock.missing,
  read_failed: COPY.ivBlock.readFailed,
};

/**
 * IV 读数 → 呈现决策（FR-012/013/014/020/035）。复杂度 O(1)。
 *
 * 🚨 **区块恒渲染**：四态没有一个是「隐藏这一块」—— FR-014 明令不可算时也要显式呈现。
 * 🚨 **`available` 但分位串解析不出** ⇒ 退回「分位不可算」而不是显示 NaN。
 */
export function ivReadoutView(iv: UnderlyingIvReadoutResponse): IvReadoutView {
  const pct = iv.state === 'available' ? toFinite(iv.ivPercentile) : null;
  const aggregate = toFinite(iv.aggregateIv);
  const effectiveState: UnderlyingIvReadoutResponseState =
    iv.state === 'available' && pct === null ? 'percentile_unavailable' : iv.state;
  return {
    state: effectiveState,
    ivPercentile: pct,
    ivpText: pct === null ? null : String(Math.round(pct)),
    degradedText: effectiveState === 'available' ? null : DEGRADED_TEXT[effectiveState],
    aggregateIvText:
      aggregate === null
        ? COPY.ivBlock.noValue
        : `${COPY.ivBlock.aggregateIvPrefix}${aggregate.toFixed(1)}%`,
    alert: alertStatusOf(pct),
    freshness: freshnessOf(iv.asOf, iv.freshnessTier),
    showMarker: pct !== null,
  };
}

// ═══════════════════ ⑤ 区间时序几何（FR-006 ~ FR-010） ═══════════════════

/** 四区间边界（绝对价）—— 全部由 server 随锚下发，mobile **不重算任何档位系数**。 */
export interface ZoneBounds {
  /** 内段下界（深买区 / 买区 分界）。 */
  zoneFloor: number;
  /** W = 愿买价锚（买区 / 薄带 分界，红色加粗）。 */
  w: number;
  /** V = 估值锚（薄带 / 偏贵 分界）。 */
  v: number;
  /** 内段上界（偏贵 / 高估 分界）。 */
  zoneCeiling: number;
}

/** 锚 → 四区间边界。任一值缺失 / 退化（非严格递增）⇒ `null`（不画一条错的带）。O(1)。 */
export function parseZoneBounds(
  anchor: Pick<AnchorResponse, 'zoneFloor' | 'w' | 'v' | 'zoneCeiling'>,
): ZoneBounds | null {
  const zoneFloor = toFinite(anchor.zoneFloor);
  const w = toFinite(anchor.w);
  const v = toFinite(anchor.v);
  const zoneCeiling = toFinite(anchor.zoneCeiling);
  if (zoneFloor === null || w === null || v === null || zoneCeiling === null) return null;
  if (!(zoneFloor < w && w < v && v < zoneCeiling)) return null;
  return { zoneFloor, w, v, zoneCeiling };
}

/**
 * 🚨 **FR-010：四区间边界只依赖锚，与时间窗无关** —— 切窗口时这四个数**恒不变**。
 * 单测拿它做机械断言（换窗口 / 换序列后仍逐值相等）。
 */
export function zoneBoundaryPrices(bounds: ZoneBounds): number[] {
  return [bounds.zoneFloor, bounds.w, bounds.v, bounds.zoneCeiling];
}

/** 纵轴上下各留的余量比例（避免折线贴边）。 */
const AXIS_PAD_RATIO = 0.04;

export interface ChartAxis {
  min: number;
  max: number;
}

/**
 * 纵轴域。**FR-010：容纳窗口内实际价格区间，禁裁掉数据** ⇒ 域 = 价格区间 ∪ 四区间带区间。
 *
 * - 序列为空 ⇒ 只按带区间（state_branch #10：无日线时四区间带仍单独呈现）。
 * - 两者皆无 ⇒ `null`（不编造轴）。
 * - 退化（上下界相等）⇒ 按值本身撑开一点，避免除零。
 *
 * 复杂度 O(n)，n = 序列点数。
 */
export function chartAxis(prices: readonly number[], bounds: ZoneBounds | null): ChartAxis | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const p of prices) {
    if (!Number.isFinite(p)) continue;
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  if (bounds !== null) {
    lo = Math.min(lo, bounds.zoneFloor);
    hi = Math.max(hi, bounds.zoneCeiling);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const span = hi - lo;
  const pad = span > 0 ? span * AXIS_PAD_RATIO : Math.max(Math.abs(hi), 1) * AXIS_PAD_RATIO;
  return { min: lo - pad, max: hi + pad };
}

/** 价格 → 像素 y（自顶向下，`max` 在 y=0）。域退化时落中线。O(1)。 */
export function priceToY(price: number, axis: ChartAxis, height: number): number {
  const span = axis.max - axis.min;
  if (!(span > 0)) return height / 2;
  return ((axis.max - price) / span) * height;
}

/**
 * 价格序列 → SVG `polyline` 的 `points` 串。等距横排（x 轴是序号不是日历日 ——
 * 桶宽由服务端 `period` 保证均匀，客户端不做时间轴插值）。空 / 单点 ⇒ 空串。
 * 复杂度 O(n)。
 */
export function polylinePoints(
  prices: readonly number[],
  axis: ChartAxis,
  width: number,
  height: number,
): string {
  if (prices.length < 2) return '';
  const step = width / (prices.length - 1);
  const out: string[] = [];
  for (let i = 0; i < prices.length; i += 1) {
    const price = prices[i] as number;
    out.push(`${(i * step).toFixed(1)},${priceToY(price, axis, height).toFixed(1)}`);
  }
  return out.join(' ');
}

export interface ZoneRect {
  zone: BandZone;
  top: number;
  height: number;
}

/**
 * 四区间背景带（自上而下 高估 / 偏贵 / 薄带 / 买区 / 深买区）→ 像素矩形，按轴域裁剪。
 * 完全落在轴域外的段**不产出矩形**（而不是产出 0 高的空 View）。复杂度 O(1)（固定 5 段）。
 *
 * 🚨 色带语义复用 045 `zone-band.tsx`（同 5 区间同配色），只是那边是横向、这边是纵向。
 */
export function zoneRects(bounds: ZoneBounds, axis: ChartAxis, height: number): ZoneRect[] {
  const segments: readonly { zone: BandZone; hi: number; lo: number }[] = [
    { zone: 'overvalued', hi: axis.max, lo: bounds.zoneCeiling },
    { zone: 'expensive', hi: bounds.zoneCeiling, lo: bounds.v },
    { zone: 'thin', hi: bounds.v, lo: bounds.w },
    { zone: 'buy', hi: bounds.w, lo: bounds.zoneFloor },
    { zone: 'deep_buy', hi: bounds.zoneFloor, lo: axis.min },
  ];
  const out: ZoneRect[] = [];
  for (const seg of segments) {
    const hi = Math.min(seg.hi, axis.max);
    const lo = Math.max(seg.lo, axis.min);
    if (!(hi > lo)) continue;
    const top = priceToY(hi, axis, height);
    out.push({ zone: seg.zone, top, height: priceToY(lo, axis, height) - top });
  }
  return out;
}

// ── 序列取数与标注 ──────────────────────────────────────────────────────

/** bars 端点的收盘价序列（升序）。非数值行跳过 —— 不拿 0 填坑。复杂度 O(n)。 */
export function seriesCloses(items: readonly Pick<DailyBarItem, 'close'>[]): number[] {
  const out: number[] = [];
  for (const it of items) {
    const n = toFinite(it.close);
    if (n !== null) out.push(n);
  }
  return out;
}

/** 序列自身的 asOf = 末根 bar 的交易日（bars 端点无页级 asOf）。空 ⇒ null。O(1)。 */
export function seriesAsOf(items: readonly Pick<DailyBarItem, 'tradeDate'>[]): string | null {
  return items.length > 0 ? (items[items.length - 1] as { tradeDate: string }).tradeDate : null;
}

const WINDOW_YEARS: Record<TimeSeriesWindow, number> = { '1Y': 1, '3Y': 3, '5Y': 5, '10Y': 10 };

const WINDOW_LABEL: Record<TimeSeriesWindow, string> = {
  '1Y': COPY.series.window1Y,
  '3Y': COPY.series.window3Y,
  '5Y': COPY.series.window5Y,
  '10Y': COPY.series.window10Y,
};

const PERIOD_LABEL: Record<MarketdataControllerBarsPeriod, string> = {
  day: COPY.series.periodDay,
  week: COPY.series.periodWeek,
  month: COPY.series.periodMonth,
  quarter: COPY.series.periodQuarter,
  year: COPY.series.periodYear,
};

const MS_PER_DAY = 86_400_000;

/**
 * 窗口起点 `YYYY-MM-DD` = today 减 N 年（bars 端点的 `from` 参数）。
 * 用 UTC 求值 ⇒ 与本机时区无关、可测。O(1)。
 */
export function windowStartDate(window: TimeSeriesWindow, today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC((y ?? 1970) - WINDOW_YEARS[window], (m ?? 1) - 1, d ?? 1));
  return t.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY;
}

/**
 * 「序列比所选窗口短」的容差（日）。窗口起点落在周末 / 长假时首根 bar 天然晚几天，
 * 那不是「短于窗口」；只有明显晚于起点（新票 / 新上市 / 采集缺口）才值得标出来。
 */
export const SERIES_START_TOLERANCE_DAYS = 14;

/**
 * 折线区脚注：「日 K · 近 1 年」/「月 K · 近 10 年」/「日 K · 实际自 2026-04-17 起」。
 *
 * 🚨 **FR-008 边界**：序列短于窗口时 MUST 标明实际起点 —— **禁拉伸补空、禁静默截断**。
 * 复杂度 O(1)。
 */
export function seriesRangeLabel(
  window: TimeSeriesWindow,
  firstTradeDate: string | null,
  today: string,
): string {
  const period = PERIOD_LABEL[barsPeriodForWindow(window)];
  if (firstTradeDate === null) return `${period} · ${WINDOW_LABEL[window]}`;
  const expected = windowStartDate(window, today);
  const short = daysBetween(expected, firstTradeDate) > SERIES_START_TOLERANCE_DAYS;
  return short
    ? `${period} · ${COPY.series.actualStart(firstTradeDate)}`
    : `${period} · ${WINDOW_LABEL[window]}`;
}

// ═══════════════ ⑥ 选约区块的 section 组装（047 T031；FR-001/005, plan D-UI-1） ═══════════════

/**
 * 🚨 **全页只留一个纵向滚动容器** —— 详情屏原来的 `ScrollView` 已整体换成 `SectionList`：
 *    046 三块进 `ListHeaderComponent`，腿行进 `section.data`。把虚拟化列表塞回**同向**的
 *    `ScrollView` 里会同时坏两件事 ——① 内层拿到无界高度、虚拟化静默失效（730 行全渲染，
 *    正是 FR-005 要避免的）② 两个滚动响应者争同一纵向手势。RN 只在 dev console 打**一条
 *    warning**：typecheck 绿、CI 绿、web e2e 也可能绿（视口高、行少）。**别塞回去。**
 *
 * 🚨 **恒一个 section** —— 三个 Tab 共用同一个列表实例，切 Tab 只换 `data`
 *    （MUST NOT 每 Tab 各挂一个 `SectionList`，plan D-UI-1）。
 */
export const LEG_SECTION_KEY = 'legs';

export interface LegSection {
  key: typeof LEG_SECTION_KEY;
  /** 逻辑集合本体 —— **零 `slice` 零 top-N**（FR-005 / plan D-UI-2 ②）。 */
  data: readonly LegResponse[];
}

/** 腿集合 → `SectionList` 的 `sections`（恒长度 1）。复杂度 O(1)（不拷贝行）。 */
export function buildLegSections(legs: readonly LegResponse[]): LegSection[] {
  return [{ key: LEG_SECTION_KEY, data: legs }];
}

/**
 * 计数条分母 / 滚动条长度的口径 —— 恒取**逻辑集合**长度，**MUST NOT 取渲染窗口大小**
 * （SC-012 的可读判据，plan D-UI-2 ③）。复杂度 O(#section) = O(1)。
 */
export function legRowTotal(sections: readonly LegSection[]): number {
  let total = 0;
  for (const section of sections) total += section.data.length;
  return total;
}

/**
 * 选约区块的五态。**没有「整页」这一档**（与 ① 同纪律）：本区块自己降级，046 三块照常渲染。
 * 三种「没有表可看」**两两蓄意分开**（#361 起）：
 * - `chain_not_ready` —— 会有的，只是还没采到（**该等**）；
 * - `no_listed_options` —— 该标的在交易所根本没有挂牌期权（终态，**该走**）；
 * - `read_failed` —— 跨 ctx 读故障（可重试）。
 * 🚨 前两者对用户是**相反**的两件事，合并之后呈现层只能挑一支写文案、于是对另一支撒谎
 *    （#362 修的正是那句假承诺）。值域与 server 契约的 `LegTableResponse.state` 逐字对齐，
 *    只多一个客户端侧的 `loading`。
 */
export type LegBlockState = 'loading' | LegTableResponseState;

/**
 * 请求成败 × 契约状态 → 区块呈现态。复杂度 O(1)。
 *
 * 🚨 **零适格腿不是一个 state** —— 那是 `available` + 空 `data`（空 Tab MUST 可进入、
 *    面板不隐藏不置灰，FR-021）。判空走 {@link legRowTotal}，别再造一个态。
 */
export function legBlockState(
  side: SideStatus,
  state: LegTableResponseState | null | undefined,
): LegBlockState {
  if (side.isError) return 'read_failed';
  if (side.isPending) return 'loading';
  // 非 pending 非 error ⇒ 必有响应；真拿不到状态字按读故障渲染，**不假装 available**。
  return state ?? 'read_failed';
}
