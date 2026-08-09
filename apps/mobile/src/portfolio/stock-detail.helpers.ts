import type { InstrumentQuoteHeader, WatchlistMembership } from '@nvy/api-client';

import { formatAsOfLabel } from '~/format/as-of';
import type { QuoteDirection } from './use-quote-merge';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 股票详情纯逻辑（014 US3/US6）。symbol 解析 + 市场下钻 gate（D9 us）+ memberships→编辑分组
// 勾选态派生 + 报价 header（InstrumentQuoteHeader）格式化（涨跌方向/价格/涨跌/asOf 新鲜度）。
// 纯函数 → vitest（per mono 测试分层 logic=vitest，UI=Playwright）。
// 仅 `import type`（编译期擦除）→ spec 无须 mock @nvy/api-client。

// 可下钻市场（cn 全维度 / hk 薄数据可进）；us gated（016 marketScope=['cn'] 未同步 us → 零数据，D9）。
const DRILLABLE_MARKETS: ReadonlySet<string> = new Set(['cn', 'hk']);

/** 解析 canonical `market:code`（如 `cn:600519`）→ {market, code}；非法（缺冒号/空段）→ null。 */
export function parseSymbol(raw: string): { market: string; code: string } | null {
  const i = raw.indexOf(':');
  if (i <= 0 || i >= raw.length - 1) return null;
  const market = raw.slice(0, i).trim();
  const code = raw.slice(i + 1).trim();
  if (!market || !code) return null;
  return { market, code };
}

/** 市场是否可下钻详情（D9 us gate）。cn/hk → true；us / 未知 → false（占位「美股即将上线」）。 */
export function canDrillDown(market: string): boolean {
  return DRILLABLE_MARKETS.has(market);
}

/**
 * memberships → `groupId → itemId` 映射（编辑分组面板勾选态：命中=勾；取消勾时拿 itemId 精确删
 * 013 EP9）。同 groupId 重复取首条（防御，server 唯一键 @@unique([groupId,market,code]) 已保证不重）。
 */
export function membershipMap(memberships: WatchlistMembership[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of memberships) {
    if (!map.has(m.groupId)) map.set(m.groupId, m.itemId);
  }
  return map;
}

// ── 报价 header 格式化（InstrumentQuoteHeader，015 EP3.quote；nav condensed + quote-header 共用）──
// 涨红跌绿（quote.up/down/flat token）；缺数据 → '--'。值为 server Decimal string，展示按 2dp
// 格式化（镜像 013 use-quote-merge，纯展示舍入；涨跌额/幅由 server 算，mobile 不重算 per Assumptions）。

type QH = InstrumentQuoteHeader | null | undefined;

/** 涨跌方向：无数据 / changePct null/NaN → 'none'（中性灰）；否则按符号 up/down/flat。 */
export function detailQuoteDirection(q: QH): QuoteDirection {
  if (!q || !q.hasData || q.changePct == null) return 'none';
  const n = Number.parseFloat(q.changePct);
  if (Number.isNaN(n)) return 'none';
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}

/** 最新价（无符号 2dp）；无数据 → '--'。 */
export function formatDetailPrice(q: QH): string {
  if (!q || !q.hasData || q.price == null) return '--';
  const n = Number.parseFloat(q.price);
  return Number.isNaN(n) ? '--' : n.toFixed(2);
}

/** 涨跌额（带 +/- 符号，a11y 色盲友好）；无数据 → '--'。 */
export function formatDetailChange(q: QH): string {
  if (!q || !q.hasData || q.change == null) return '--';
  const n = Number.parseFloat(q.change);
  if (Number.isNaN(n)) return '--';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

/** 涨跌幅 %（带 +/- 符号）；无数据 → '--'。 */
export function formatDetailChangePct(q: QH): string {
  if (!q || !q.hasData || q.changePct == null) return '--';
  const n = Number.parseFloat(q.changePct);
  if (Number.isNaN(n)) return '--';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/**
 * 数据新鲜度文案（D10）：「数据截至 2026-06-01 · 收盘」；无 asOf/无数据 → ''（不渲染）。
 * 串本身的拼法已上提到 `~/format/as-of`（045 雷达是第二个消费方，同一语义不留第二份）。
 */
export function formatAsOf(q: QH): string {
  if (!q || !q.hasData) return '';
  return formatAsOfLabel(q.asOf, q.priceKind);
}

// ── 估值字段格式化（InstrumentValuation + quote.prevClose；报价 header EOD 网格用）──
// 入参均为 server Decimal string | null（估值缺失整块 null → 调用方传 null，逐字段渲染 '--'）。

/** 通用比率（昨收 / PE / PB / PS 等）→ digits dp 无符号；null/NaN → '--'。 */
export function formatRatio(raw: string | null | undefined, digits = 2): string {
  if (raw == null) return '--';
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? '--' : n.toFixed(digits);
}

/** 百分数字段（股息率，server 已是百分值如 '1.80' → '1.80%'）；null/NaN → '--'。 */
export function formatPercentValue(raw: string | null | undefined): string {
  if (raw == null) return '--';
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? '--' : `${n.toFixed(2)}%`;
}

/** 大额金额（市值，元 → 万亿/亿/万，2dp）；null/NaN → '--'。负数同口径（保号）。 */
export function formatLargeAmount(raw: string | null | undefined): string {
  if (raw == null) return '--';
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toFixed(2);
}

/** 比率字段（ROE/毛利率，server 是小数如 '0.31' → '31.00%'，×100）；null/NaN → '--'。 */
export function formatFractionPct(raw: string | null | undefined, digits = 2): string {
  if (raw == null) return '--';
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? '--' : `${(n * 100).toFixed(digits)}%`;
}

/** 历史分位 [0,1] → 百分位 number(0-100)；null/NaN/越界 → null（空态）。 */
export function parsePercentile(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n < 0 || n > 1) return null;
  return n * 100;
}

/** 分位档位（<30 偏低 / 30-70 适中 / >70 偏高，FR-M05 分位刻度）。 */
export function percentileZone(pct: number): '偏低' | '适中' | '偏高' {
  if (pct < 30) return '偏低';
  if (pct > 70) return '偏高';
  return '适中';
}

// ── 底栏加·删自选（窄义，仅系统「自选」组，T012 US6 / D1）─────────────────────
// 加/删全复用 013：未自选 → 加入「自选」组(EP7 addItem)；已自选 → 用 memberships 里自选组的
// itemId 精确删(EP9 deleteItem)。star 文案 / 调用映射纯派生 → vitest（per mono 测试分层）。

/** 底栏星 toggle 文案（D1 对称翻）：已自选 / 自选。 */
export function watchlistToggleLabel(inWatchlist: boolean): string {
  return inWatchlist ? STOCK_DETAIL_COPY.bottomBar.inWatch : STOCK_DETAIL_COPY.bottomBar.addWatch;
}

/** 底栏星 toggle 调用映射（discriminated → 调用方按 kind 走 013 addItem / deleteItem）。 */
export type WatchlistToggleAction =
  | { kind: 'add'; groupId: string }
  | { kind: 'remove'; itemId: string };

/**
 * 解析底栏加·删自选动作（窄义对称翻，D1）：
 *  - 未自选 → `add`（落系统「自选」组 id，013 EP7）
 *  - 已自选 → `remove`（拿 memberships 里自选组 itemId，013 EP9）
 *  - 缺「自选」组 id（groups 未就绪）/ 已自选却查无 itemId（status 与 groups 暂不一致）→ null（不动作，防御）。
 */
export function resolveWatchlistToggle(
  inWatchlist: boolean,
  watchlistGroupId: string | null | undefined,
  membershipByGroup: Map<string, string>,
): WatchlistToggleAction | null {
  if (!watchlistGroupId) return null;
  if (!inWatchlist) return { kind: 'add', groupId: watchlistGroupId };
  const itemId = membershipByGroup.get(watchlistGroupId);
  return itemId ? { kind: 'remove', itemId } : null;
}

/**
 * 编辑分组面板单格 toggle 调用映射（T013 US6 / FR-M08，任意非持仓组）：
 *  - 未命中（membershipByGroup 无该组）→ `add`（加入该组，013 EP7）
 *  - 已命中 → `remove`（拿该组 itemId 移出，013 EP9）。
 * 与 `resolveWatchlistToggle`（窄义仅系统「自选」组 + null 兜底）区分：此处 groupId 恒来自组列，必有动作。
 */
export function resolveGroupToggle(
  groupId: string,
  membershipByGroup: Map<string, string>,
): WatchlistToggleAction {
  const itemId = membershipByGroup.get(groupId);
  return itemId ? { kind: 'remove', itemId } : { kind: 'add', groupId };
}
