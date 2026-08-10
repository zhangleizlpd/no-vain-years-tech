// 045 T024 — 击球区雷达纯函数（五态 / 徽标 / 行字段 / 新鲜度 / 筛选 / 分页）。vitest 覆盖。
//
// 🚨 **三空态文案不在前端**：server 随 `emptyState` 下发 `emptyStateMessage`（判定与措辞同源），
//    这里只做「渲染哪一态」的判定，不拼文案。
// 🚨 **SC-004 数值与 asOf 同生共死**：任何行情数值（spot / 距 W% / 色带上的点）在
//    `lastCloseDate` 缺失时一律降级为显式「行情不可用」—— 杜绝裸数值。
// 🚨 **FR-014 徽标只能取自 `RADAR_BADGE_ORDER` 白名单**，衍生徽标（达标腿数 / 直接买主案）无处可生。
import type { AnchorResponse, RadarResponseEmptyState } from '@nvy/api-client';

import { formatAsOfLabel } from '~/format/as-of';
import type { FreshnessTier } from './underlying-detail.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { formatPriceText } from './price-format.rules';

const COPY = OPTIONSDESK_COPY.radar;

/** 雷达行用得上的锚字段（按结构子集吃，测试可造小 fixture）。 */
export type RadarRowAnchor = Pick<
  AnchorResponse,
  | 'id'
  | 'ticker'
  | 'lLevelEffective'
  | 'zone'
  | 'overdue'
  | 'reviewFlagOn'
  | 'w'
  | 'v'
  | 'zoneFloor'
  | 'zoneCeiling'
  | 'lastClose'
  | 'lastCloseDate'
  | 'quoteFreshnessTier'
  | 'distanceToWPct'
>;

/** 一页雷达（= `RadarResponse` 的结构子集）。 */
export interface RadarPageLike {
  items: readonly RadarRowAnchor[];
  nextCursor: string | null;
  hasMore: boolean;
  emptyState: RadarResponseEmptyState;
}

// ─────────────────────────── 五态 ───────────────────────────

/**
 * 常态 / 零锚 / 筛选无结果 / 行情整体不可得 / 全体不动区。
 * 前三个 + 全体不动区由 server 判（`emptyState`）；**行情降级是前端从行上派生的第四态**
 * （FR-015 的「行情整体不可得」，server 的三分里没有它）。
 */
export type RadarViewState =
  | 'normal'
  | 'zero_anchors'
  | 'filtered_empty'
  | 'quotes_degraded'
  | 'all_idle';

/**
 * 判定序：零锚 → 筛选无结果 → **行情整体不可得** → 全体不动区 → 常态。
 *
 * 🚨 行情降级**压过** `all_idle`：没有 spot 时 server 自然算出「无一只跌破 W」⇒ all_idle，
 *    但那会把「没数据」说成「今日无解，空仓是常态」—— 语义完全不同，不能混。
 */
export function radarViewState(page: Pick<RadarPageLike, 'items' | 'emptyState'>): RadarViewState {
  if (page.emptyState === 'zero_anchors') return 'zero_anchors';
  if (page.emptyState === 'filtered_empty') return 'filtered_empty';
  // 防御：基础集合非空却一行不返，只可能是筛选滤空（server 首页会给 emptyState，这里兜底）。
  if (page.items.length === 0) return 'filtered_empty';
  if (page.items.every((a) => a.lastCloseDate === null)) return 'quotes_degraded';
  if (page.emptyState === 'all_idle') return 'all_idle';
  return 'normal';
}

// ─────────────────────────── 徽标（FR-014） ───────────────────────────

/** 渲染顺序纪律：L 层 → 区间 / 锚逾期 → 复核锚 / 提醒类。**白名单，禁衍生徽标**。 */
export const RADAR_BADGE_ORDER = [
  'l_level',
  'zone',
  'overdue',
  'review_flag',
  'quote_unavailable',
] as const;

export type RadarBadgeKind = (typeof RADAR_BADGE_ORDER)[number];

export interface RadarBadge {
  kind: RadarBadgeKind;
  text: string;
}

type BadgeInput = Pick<
  RadarRowAnchor,
  'lLevelEffective' | 'zone' | 'overdue' | 'reviewFlagOn' | 'lastCloseDate'
>;

/** 复杂度 O(1)（固定 ≤ 5 个徽标）。 */
export function radarBadges(anchor: BadgeInput): RadarBadge[] {
  const badges: RadarBadge[] = [{ kind: 'l_level', text: anchor.lLevelEffective }];
  // 区间徽标依赖 spot，行情不可用时**缺位**（不伪造区间）。
  if (anchor.zone !== null) {
    badges.push({ kind: 'zone', text: COPY.zoneLabels[anchor.zone] });
  }
  if (anchor.overdue) badges.push({ kind: 'overdue', text: COPY.badgeOverdue });
  if (anchor.reviewFlagOn) badges.push({ kind: 'review_flag', text: COPY.badgeReviewFlag });
  // FR-017：行情缺失 = 行内显式标记（行仍在列表、禁 0 值）。
  if (anchor.lastCloseDate === null) {
    badges.push({ kind: 'quote_unavailable', text: COPY.quoteUnavailable });
  }
  return badges;
}

// ─────────────────────────── 行字段（SC-002：每行恰好 5） ───────────────────────────

/**
 * 每行**恰好 5 个字段**（plan D13，user 2026-08-01 定）：
 * 标的标识（ticker + code 同属「这是哪只票」）/ 距 W% / 四区间色带 / spot / 徽标。
 */
export const RADAR_ROW_FIELD_KEYS = ['identity', 'distanceToW', 'band', 'spot', 'badges'] as const;

export interface RadarRowFields {
  identity: { code: string; ticker: string };
  distanceToW: string;
  /** 传给 `<ZoneBand>` 的几何入参（`lastClose` 已按 SC-004 与 asOf 同生共死处理）。 */
  band: Pick<RadarRowAnchor, 'w' | 'v' | 'zoneFloor' | 'zoneCeiling' | 'lastClose'>;
  spot: string;
  badges: RadarBadge[];
}

/** 行情数值是否可呈现：值与 asOf 必须同时在（SC-004 杜绝裸数值）。 */
function hasQuote(a: Pick<RadarRowAnchor, 'lastCloseDate'>): boolean {
  return a.lastCloseDate !== null;
}

/** canonical `market:code` → 展示用 code（解析失败退回原串，不丢信息）。 */
function tickerCode(ticker: string): string {
  return ticker.split(':')[1] ?? ticker;
}

/** spot 串。🚨 **不带「· 距 W xx%」**（标题行已有一份，plan D13 明令删的真冗余）。 */
export function formatSpot(a: Pick<RadarRowAnchor, 'lastClose' | 'lastCloseDate'>): string {
  if (!hasQuote(a) || a.lastClose === null) return COPY.quoteUnavailable;
  return `${COPY.spotPrefix}${formatPriceText(a.lastClose)}`;
}

/** 距 W%（server 已算好的百分数串）。负号用 −（U+2212）与 mockup 一致。 */
export function formatDistanceToW(
  a: Pick<RadarRowAnchor, 'distanceToWPct' | 'lastCloseDate'>,
): string {
  if (!hasQuote(a) || a.distanceToWPct === null) {
    return `${COPY.distancePrefix}${COPY.noValue}`;
  }
  const n = Number.parseFloat(a.distanceToWPct);
  if (!Number.isFinite(n)) return `${COPY.distancePrefix}${COPY.noValue}`;
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${COPY.distancePrefix}${sign}${Math.abs(n).toFixed(1)}%`;
}

/** 距 W 的色调（涨跌语义外的中性三分：跌破 W = 危险色，无行情 = 灰）。 */
export function distanceToWTone(
  a: Pick<RadarRowAnchor, 'distanceToWPct' | 'lastCloseDate'>,
): 'below' | 'above' | 'none' {
  if (!hasQuote(a) || a.distanceToWPct === null) return 'none';
  const n = Number.parseFloat(a.distanceToWPct);
  if (!Number.isFinite(n)) return 'none';
  return n < 0 ? 'below' : 'above';
}

export function radarRowFields(anchor: RadarRowAnchor): RadarRowFields {
  return {
    identity: { code: tickerCode(anchor.ticker), ticker: anchor.ticker },
    distanceToW: formatDistanceToW(anchor),
    band: {
      w: anchor.w,
      v: anchor.v,
      zoneFloor: anchor.zoneFloor,
      zoneCeiling: anchor.zoneCeiling,
      // 没有 asOf 就没有点 —— 几何位置同样是「数值」（SC-004）。
      lastClose: hasQuote(anchor) ? anchor.lastClose : null,
    },
    spot: formatSpot(anchor),
    badges: radarBadges(anchor),
  };
}

// ─────────────────────────── 新鲜度（FR-016） ───────────────────────────

export type RadarFreshnessTier = FreshnessTier;

export interface RadarFreshness {
  tier: RadarFreshnessTier;
  /** 数据自身的 session 日期（各行取最新）；全无行情 → null，**不编造日期**。 */
  asOf: string | null;
  text: string;
}

/**
 * 顶部新鲜度条。asOf 取**数据自身**最新的 `last_close_date`（FR-036：它才是 asOf），
 * 档位取**该行自己的** `quoteFreshnessTier` —— 判据在 server（要查交易日历），客户端拿本地
 * 日历日比会对美股恒判陈旧。复杂度 O(n)，n = 本页行数。
 */
export function radarFreshness(
  items: readonly Pick<RadarRowAnchor, 'lastCloseDate' | 'quoteFreshnessTier'>[],
): RadarFreshness {
  let latest: { asOf: string; tier: FreshnessTier } | null = null;
  for (const it of items) {
    // `YYYY-MM-DD` 字典序 = 时间序。
    if (it.lastCloseDate !== null && (latest === null || it.lastCloseDate > latest.asOf)) {
      latest = { asOf: it.lastCloseDate, tier: it.quoteFreshnessTier };
    }
  }
  if (latest === null) return { tier: 'UNAVAILABLE', asOf: null, text: COPY.freshUnavailable };
  const label = formatAsOfLabel(latest.asOf, 'eod_close');
  if (latest.tier === 'CURRENT') return { tier: 'CURRENT', asOf: latest.asOf, text: label };
  return { tier: 'STALE', asOf: latest.asOf, text: `${label}${COPY.freshStaleSuffix}` };
}

// ─────────────────────────── 筛选（FR-034，多选） ───────────────────────────

/**
 * chips 恒定 6 项。🚨 **FR-008：某档（一期是 L1）无锚不是校验错误**，
 * MUST NOT 因无数据而隐藏该筛选项 —— 所以这是常量清单，不由数据派生。
 */
export const RADAR_FILTER_KEYS = ['L1', 'L2', 'L3', 'L4', 'pendingReview', 'belowW'] as const;

export type RadarFilterKey = (typeof RADAR_FILTER_KEYS)[number];

const L_LEVEL_KEYS: readonly RadarFilterKey[] = ['L1', 'L2', 'L3', 'L4'];

/** 多选 toggle（锚管理那处才是单选）。返回值按 `RADAR_FILTER_KEYS` 稳定序。 */
export function toggleRadarFilter(
  selected: readonly RadarFilterKey[],
  key: RadarFilterKey,
): RadarFilterKey[] {
  const next = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
  return RADAR_FILTER_KEYS.filter((k) => next.includes(k));
}

export interface RadarFilterParams {
  lLevels?: string[];
  pendingReview?: boolean;
  belowW?: boolean;
}

/** 选中集 → 查询参数。未选的维度**整个省略**（不发空数组 / 不发 false）。 */
export function radarFilterParams(selected: readonly RadarFilterKey[]): RadarFilterParams {
  const lLevels = L_LEVEL_KEYS.filter((k) => selected.includes(k));
  return {
    ...(lLevels.length > 0 ? { lLevels: [...lLevels] } : {}),
    ...(selected.includes('pendingReview') ? { pendingReview: true } : {}),
    ...(selected.includes('belowW') ? { belowW: true } : {}),
  };
}

// ─────────────────────────── 游标分页（SC-002） ───────────────────────────

/**
 * 多页拍平（页序拼接 + 按 id 去重保留首见）。复杂度 O(n)。
 * 去重兜底翻页期间的数据刷新令同 id 跨页重现（keyset 复合游标仍可能边界重叠）。
 */
export function mergeRadarPages<T extends { id: string }>(
  pages: readonly { items: readonly T[] }[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const p of pages) {
    for (const it of p.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      merged.push(it);
    }
  }
  return merged;
}

/** 有 nextCursor → 继续翻；null → undefined（`useInfiniteQuery` 停止翻页）。 */
export function getRadarNextCursor(page: Pick<RadarPageLike, 'nextCursor'>): string | undefined {
  return page.nextCursor ?? undefined;
}
