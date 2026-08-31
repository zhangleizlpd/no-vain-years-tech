// 045 T024 — 击球区雷达纯函数（五态 / 徽标 / 行字段 / 新鲜度 / 筛选 / 分页）。vitest 覆盖。
//
// 🚨 **三空态文案不在前端**：server 随 `emptyState` 下发 `emptyStateMessage`（判定与措辞同源），
//    这里只做「渲染哪一态」的判定，不拼文案。
// 🚨 **SC-004 数值与 asOf 同生共死**：任何行情数值（spot / 距 W% / 色带上的点）在
//    `spotAsOf` 缺失时一律降级为显式「行情不可用」—— 杜绝裸数值。
// 🚨 **061 一行一个口径**：价 / 距 W% / 色带点全部取 server 裁决出的**生效 spot**
//    （`spot` + `priceKind` + `spotAsOf` 三元组），不再各吃各的。只换档位不换价 ⇒
//    「价说昨收、距 W% 说实时」。`lastClose` / `lastCloseDate` 语义未变（仍是当日收盘的
//    权威值，FR-015），但它们不再是行内呈现的取数口径。
// 🚨 **FR-014 徽标只能取自 `RADAR_BADGE_ORDER` 白名单**，衍生徽标（达标腿数 / 直接买主案）无处可生。
import type {
  AnchorResponse,
  OptionsdeskControllerRadarMarket,
  RadarResponseEmptyState,
} from '@nvy/api-client';

import { formatAsOfLabel } from '~/format/as-of';
import type { FreshnessTier } from './underlying-detail.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { formatPriceText } from './price-format.rules';
import { underlyingDisplayName } from './underlying-identity.rules';

const COPY = OPTIONSDESK_COPY.radar;

/** 市场作用域的值域（= 页签集合）。契约侧单点是 server 的 `IMPORTABLE_MARKETS`。 */
export type RadarMarket = OptionsdeskControllerRadarMarket;

/**
 * 市场页签集合（065 FR-001）—— 取**文案表的键**。
 *
 * 🚨 **它与契约的绑定是编译期的、双向的, 不是「本地抄了一份」**: 文案表声明成
 * `satisfies Record<RadarMarket, string>`（见 `optionsdesk-copy.ts`）⇒
 * ① server 新增受支持市场而这里没补文案 → **tsc 红**;
 * ② 这里多写一个契约里没有的市场 → excess property check **tsc 红**。
 * 这条编译期闸是 FR-015「加了受支持市场却忘了加页签」在**客户端**这一侧的唯一保护 ——
 * 服务端那侧的 WARN 判据只能是 `IMPORTABLE_MARKETS`（它看不见客户端有哪几个页签）,
 * 恰恰对这种场景漏报。🚫 **MUST NOT 把文案表的 `satisfies` 摘掉**, 那会同时拆掉两侧。
 *
 * 🚨 **为什么不直接 `Object.values(OptionsdeskControllerRadarMarket)`**（那才是字面意义的
 * 单一来源）: 那是**值**导入, 而 mobile 的 vitest 至今只对 `@nvy/api-client` 做过
 * `import type`（被 erase, 从不加载其运行时代码）。真去解析会撞
 * `Failed to resolve entry for package "@nvy/api-client"` —— 包的 `exports` 把
 * `no-vain-years-mono` condition 指向 `src/index.ts`, 但 vitest 把 workspace 包 externalize
 * 后走 Node 解析, 而 Node 不认自定义 condition, 于是落到并不存在的 `./dist/index.js`
 * （2026-08-22 实测）。为一个常量去改整个 mobile 的测试基建, 收益不抵风险。
 *
 * ⚠️ 顺序 = 文案表的字面量声明序 = `IMPORTABLE_MARKETS` 的序 = `['us', 'hk']`,
 * 与「冷启动落美股」(FR-005) 一致。换序要动 server 的常量, 不在这里改。
 */
export const RADAR_MARKETS = Object.keys(COPY.marketTabs) as readonly RadarMarket[];

/**
 * 该市场是否受支持（既是「有页签」也是「能建锚」）。
 *
 * 🚨 建锚选择器（`ticker-search-picker.tsx`）与市场页签**取同一处** —— 判据分成两份的后果
 * 见 {@link RADAR_MARKETS} 的注释（FR-015 双双漏报）。它住 `radar.rules.ts` 只是因为集合
 * 定义在这里，语义上不是雷达专有。
 */
export function isSupportedMarket(market: string): boolean {
  return (RADAR_MARKETS as readonly string[]).includes(market);
}

/**
 * 无盘中实时价的市场 —— **marketdata 行情能力表的镜像**。
 *
 * 📌 **066 FR-020 起为空表**：港股接进实时报价（066 T10）后，两个受支持市场都有盘中价 ⇒
 * 065 FR-012 那条常驻说明连同它的文案一并下线（留着就是骗人）。
 * 🚨 **常量本身刻意保留**：它是下一个无盘中市场的落点，删掉会让那时的能力判据无处可挂
 * （届时说明行怎么呈现要重新走一遍 mockup 步，本表只管「是不是」）。
 *
 * ⚠️ 与 `IMPORTABLE_MARKETS` 是**两件事**：那个管「能不能建锚」，这个管「有没有盘中价」。
 * 新增受支持市场时须一并核对本表 —— 漏了不报错、不崩，所以放在这里显式点名。
 * 🚨 **本地常量而不是从行数据推断**: 它是**市场级**能力，而空态时一行都没有、推断不出任何
 * 东西。这也是它 MUST NOT 写成「所有行的 priceKind 都是 eod_close 就算」的原因。
 */
export const MARKETS_WITHOUT_INTRADAY: readonly RadarMarket[] = [];

/** 该市场是否无盘中实时价。判据是白名单式「在表里才算」—— 表为空 ⇒ 恒 `false`。 */
export function marketLacksIntraday(market: string): boolean {
  return (MARKETS_WITHOUT_INTRADAY as readonly string[]).includes(market);
}

/** 雷达行用得上的锚字段（按结构子集吃，测试可造小 fixture）。 */
export type RadarRowAnchor = Pick<
  AnchorResponse,
  | 'id'
  | 'ticker'
  | 'name'
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
  | 'spot'
  | 'priceKind'
  | 'spotAsOf'
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
  | 'zero_anchors_in_market'
  | 'filtered_empty'
  | 'quotes_degraded'
  | 'all_idle';

/**
 * server 空态 → 视图态的**全映射**（065 T13）。
 *
 * 🚨 **必须是 `Record` 而不是 `Partial<Record>`、更不能是 if 链**：server 加第 4 个枚举值时
 * `Record` 当场 tsc 红，而 if 链**照样编译**并静默 fall through —— 065 之前那条链会把
 * `zero_anchors_in_market` 落进下面的 `items.length === 0` 分支、判成 `filtered_empty`，
 * 于是渲染出**正确的文案配一个什么都不做的「清除筛选」按钮**（当时根本没选筛选）。
 * 这是 `mobile-impl-playbook` 已有的规则（enum→copy 映射用 `Record`），只是这处没用上。
 */
const SERVER_EMPTY_STATE_TO_VIEW: Readonly<
  Record<NonNullable<RadarResponseEmptyState>, RadarViewState>
> = {
  zero_anchors: 'zero_anchors',
  zero_anchors_in_market: 'zero_anchors_in_market',
  filtered_empty: 'filtered_empty',
  all_idle: 'all_idle',
};

/**
 * 判定序：server 的「一行都没有」类 → **行情整体不可得** → 全体不动区 → 常态。
 *
 * 🚨 行情降级**压过** `all_idle`：没有 spot 时 server 自然算出「无一只跌破 W」⇒ all_idle，
 *    但那会把「没数据」说成「今日无解，空仓是常态」—— 语义完全不同，不能混。
 * 🚨 `all_idle` 是 server 四态里**唯一「有行」的那个** ⇒ 只有它要让位给前端派生的降级判定；
 *    其余（含将来新增的）一律直接透传。新枚举值默认走透传是对的 —— 空态的新成员几乎必然
 *    属于「一行都没有」那一类。
 */
export function radarViewState(page: Pick<RadarPageLike, 'items' | 'emptyState'>): RadarViewState {
  const mapped = page.emptyState === null ? null : SERVER_EMPTY_STATE_TO_VIEW[page.emptyState];
  if (mapped !== null && mapped !== 'all_idle') return mapped;
  // 防御：基础集合非空却一行不返，只可能是筛选滤空（server 首页会给 emptyState，这里兜底）。
  if (page.items.length === 0) return 'filtered_empty';
  if (page.items.every((a) => a.spotAsOf === null)) return 'quotes_degraded';
  return mapped ?? 'normal';
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
  'lLevelEffective' | 'zone' | 'overdue' | 'reviewFlagOn' | 'spotAsOf'
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
  if (anchor.spotAsOf === null) {
    badges.push({ kind: 'quote_unavailable', text: COPY.quoteUnavailable });
  }
  return badges;
}

// ─────────────────────────── 行字段（SC-002：每行恰好 5） ───────────────────────────

/**
 * 每行**恰好 5 个字段**（plan D13，user 2026-08-01 定）：
 * 标的标识（标的名 + ticker 同属「这是哪只票」）/ 距 W% / 四区间色带 / spot / 徽标。
 */
export const RADAR_ROW_FIELD_KEYS = ['identity', 'distanceToW', 'band', 'spot', 'badges'] as const;

export interface RadarRowFields {
  /**
   * 「这是哪只票」这一个信息维度的两半（plan D13）：`primary` = 标的名，`ticker` = canonical
   * `market:code`。两半同属一个字段，**不计作两个**（SC-002 每行 ≤5 字段）。
   */
  identity: { primary: string; ticker: string };
  distanceToW: string;
  /** 传给 `<ZoneBand>` 的几何入参（`lastClose` 已按 SC-004 与 asOf 同生共死处理）。 */
  band: Pick<RadarRowAnchor, 'w' | 'v' | 'zoneFloor' | 'zoneCeiling' | 'lastClose'>;
  spot: string;
  badges: RadarBadge[];
}

/**
 * 行情数值是否可呈现：值与 asOf 必须同时在（SC-004 杜绝裸数值）。
 *
 * 🚨 闸看 **`spotAsOf`** 而非 `lastCloseDate` —— 生效 spot 才是行内一切数值的来源。
 * 二者并非同生同灭：盘中新建的锚可能已有实时价、但当日收盘投影尚未跑过 ⇒ 用收盘的
 * asOf 当闸会把一个有价可看的行判成「行情不可用」。
 */
function hasQuote(a: Pick<RadarRowAnchor, 'spotAsOf'>): boolean {
  return a.spotAsOf !== null;
}

/**
 * spot 串 = **生效 spot**（实时 / 收盘由 server 裁决，本层不重判）。
 * 🚨 **不带「· 距 W xx%」**（标题行已有一份，plan D13 明令删的真冗余）。
 */
export function formatSpot(a: Pick<RadarRowAnchor, 'spot' | 'spotAsOf'>): string {
  if (!hasQuote(a) || a.spot === null) return COPY.quoteUnavailable;
  return `${COPY.spotPrefix}${formatPriceText(a.spot)}`;
}

/** 距 W%（server 由生效 spot 算好的百分数串）。负号用 −（U+2212）与 mockup 一致。 */
export function formatDistanceToW(a: Pick<RadarRowAnchor, 'distanceToWPct' | 'spotAsOf'>): string {
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
  a: Pick<RadarRowAnchor, 'distanceToWPct' | 'spotAsOf'>,
): 'below' | 'above' | 'none' {
  if (!hasQuote(a) || a.distanceToWPct === null) return 'none';
  const n = Number.parseFloat(a.distanceToWPct);
  if (!Number.isFinite(n)) return 'none';
  return n < 0 ? 'below' : 'above';
}

export function radarRowFields(anchor: RadarRowAnchor): RadarRowFields {
  return {
    identity: { primary: underlyingDisplayName(anchor), ticker: anchor.ticker },
    distanceToW: formatDistanceToW(anchor),
    band: {
      w: anchor.w,
      v: anchor.v,
      zoneFloor: anchor.zoneFloor,
      zoneCeiling: anchor.zoneCeiling,
      // 没有 asOf 就没有点 —— 几何位置同样是「数值」（SC-004）。
      // ⚠️ `ZoneBandAnchor` 的字段名仍叫 `lastClose`（045 命名，色带把它当「点画在哪个价上」），
      //    但 061 起喂进去的是**生效 spot** —— 点与距 W% / 区间徽标必须同源，否则同一行里
      //    黑点停在昨收、徽标却按实时价判区间，两者会当场打架。
      lastClose: hasQuote(anchor) ? anchor.spot : null,
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
 * 顶部新鲜度条 —— **061 起它就是档位的唯一呈现出口**（FR-009：档位不上屏，只以 asOf 的
 * 粒度表达；实时档呈时刻、收盘档呈交易日，粒度差异全部落在 `formatAsOfLabel` 里）。
 *
 * asOf 取**数据自身**最新的 `spotAsOf`（生效 spot 的时间事实），档位取**该行自己的**
 * `priceKind`；`quoteFreshnessTier` 判据在 server（要查交易日历），客户端拿本地日历日比会
 * 对美股恒判陈旧。复杂度 O(n)，n = 本页行数。
 *
 * 🚨 **实时档恒 CURRENT**：`priceKind === 'realtime'` 意味着 server 已判定这个价在新鲜度闸
 * （90 秒）内 —— 对一个至多 90 秒前的价挂「已过时」是自相矛盾。`quoteFreshnessTier` 说的是
 * **收盘价**落没落在最近一个已收盘交易日（FR-020），与实时价的新鲜与否是两个问题。
 */
export function radarFreshness(
  items: readonly Pick<RadarRowAnchor, 'spotAsOf' | 'priceKind' | 'quoteFreshnessTier'>[],
): RadarFreshness {
  let latest: { asOf: string; priceKind: string; tier: FreshnessTier } | null = null;
  for (const it of items) {
    // 字典序 = 时间序：`YYYY-MM-DD` 是完整 ISO 串的前缀，两种粒度可直接比。
    if (it.spotAsOf !== null && (latest === null || it.spotAsOf > latest.asOf)) {
      latest = { asOf: it.spotAsOf, priceKind: it.priceKind, tier: it.quoteFreshnessTier };
    }
  }
  if (latest === null) return { tier: 'UNAVAILABLE', asOf: null, text: COPY.freshUnavailable };
  const label = formatAsOfLabel(latest.asOf, latest.priceKind);
  if (latest.priceKind === 'realtime' || latest.tier === 'CURRENT') {
    return { tier: 'CURRENT', asOf: latest.asOf, text: label };
  }
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

/** 雷达列表 query key 的稳定前缀 —— 锚 mutation（建 / 删 / 改 list-visible 字段）须失效它。 */
export const RADAR_QUERY_KEY = ['optionsdesk', 'radar'] as const;

/**
 * 雷达 query key 工厂（065 T11）—— **列表侧与 mutation 失效侧共用这一处**。
 *
 * 🚨 **两处各拼各的正是 T12 要修的那个既存缺陷**: `useRadar` 手拼 key、而
 * `use-anchor-mutations` 失效的是 orval 生成的 key，两者**无共同前缀** ⇒ 任何锚的增删改
 * **从未失效过雷达**（锚管理列表的失效是好的，那屏用 orval hook；只有雷达是孤儿）。
 * 工厂化之后，「两边必须同一个 key」从纪律变成结构。
 *
 * 🚨 **market 进 key 是刻意的**（plan D8 / D9）: 切页签即换 query ⇒ `pageParam` 自然重置回
 * 首页。这正是 D6 判定「跨市场游标在 app 里不可达」、从而敢撤销「market 编进游标」的依据 ——
 * 把 market 从 key 里拿掉，那个判定当场失效。
 *
 * 🚨 **筛选也进 key 而 market 与它并列**: 二者都换 query。但语义不同 —— 筛选 state 本身
 * **跨页签保留**（它是镜头，不是每页签独立的状态，plan D9），只是「筛选 × 市场」这个组合
 * 各自缓存各自的页。
 */
export function radarQueryKey(market: string, filters: RadarFilterParams): readonly unknown[] {
  return [...RADAR_QUERY_KEY, market, filters];
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
