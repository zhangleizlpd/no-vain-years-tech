import type { HoldingItem, QuoteItem, TradeItem } from '@nvy/api-client';

import type { QuoteDirection } from './use-quote-merge';

// 持仓纯逻辑（025 US2/US3）。行情实时合成（浮动盈亏/市值 = 015 quote client-merge 值 ×
// 快照 qty/unitCost，ADR-0048）+ 汇总聚合（降级行剔除规则）+ 流水月份分组 + 千分位格式化。
// 纯函数 → vitest（per mono 测试分层 logic=vitest，UI=Playwright）。
// 仅 `import type`（编译期擦除）→ spec 无须 mock @nvy/api-client。
// 数值精度：Decimal string → Number 仅用于**展示**合成（万级金额 float64 充裕），不回写。

/** Decimal string / number → 有限数；null/undefined/不可解析 → null。 */
function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** 行情可合成 gate：降级行（quotable=false）/ 无 quote / 无数据 / 价格缺失 → null。 */
function quotePrice(quote: QuoteItem | undefined, h: HoldingItem): number | null {
  if (!h.quotable || !quote?.hasData || quote.price == null) return null;
  return toNumber(quote.price);
}

/** 持有市值 = 现价 × 数量；不可合成 → null（行情列显 `--`）。 */
export function marketValue(quote: QuoteItem | undefined, h: HoldingItem): number | null {
  const price = quotePrice(quote, h);
  const qty = toNumber(h.qty);
  if (price == null || qty == null) return null;
  return price * qty;
}

/** 浮动盈亏 = (现价 − 摊薄成本) × 数量；不可合成 → null。 */
export function floatPnl(quote: QuoteItem | undefined, h: HoldingItem): number | null {
  const price = quotePrice(quote, h);
  const unitCost = toNumber(h.unitCost);
  const qty = toNumber(h.qty);
  if (price == null || unitCost == null || qty == null) return null;
  return (price - unitCost) * qty;
}

/** 浮动盈亏率 = (现价 − 摊薄成本) / 摊薄成本（小数）；成本 0 / 不可合成 → null。 */
export function floatPnlPct(quote: QuoteItem | undefined, h: HoldingItem): number | null {
  const price = quotePrice(quote, h);
  const unitCost = toNumber(h.unitCost);
  if (price == null || unitCost == null || unitCost === 0) return null;
  return (price - unitCost) / unitCost;
}

export interface HoldingsSummary {
  /** 总市值（行情实时合成，仅可合成行；零可合成行 → null 显 `--`）。 */
  totalMarketValue: number | null;
  /** 总累计盈亏（快照字段，降级行**不**剔除——cumPnl 来自导入文件；全 null → null）。 */
  totalCumPnl: number | null;
}

/** 汇总条聚合：总市值剔除降级/无行情行，总累计盈亏按快照含降级行。 */
export function summarizeHoldings(
  holdings: HoldingItem[],
  quoteFor: (ref: { market: string; code: string }) => QuoteItem | undefined,
): HoldingsSummary {
  let mv: number | null = null;
  let pnl: number | null = null;
  for (const h of holdings) {
    const rowMv = marketValue(quoteFor(h), h);
    if (rowMv != null) mv = (mv ?? 0) + rowMv;
    const rowPnl = toNumber(h.cumPnl);
    if (rowPnl != null) pnl = (pnl ?? 0) + rowPnl;
  }
  return { totalMarketValue: mv, totalCumPnl: pnl };
}

export interface TradeMonthGroup {
  /** 月份吸顶小标 `YYYY-MM`。 */
  month: string;
  items: TradeItem[];
}

/** 流水按月分组（输入已按 server 时序倒序，组内/组间保序）。 */
export function groupTradesByMonth(items: TradeItem[]): TradeMonthGroup[] {
  const groups: TradeMonthGroup[] = [];
  for (const item of items) {
    const month = item.tradeDate.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.items.push(item);
    else groups.push({ month, items: [item] });
  }
  return groups;
}

/** 整数段插千分位逗号（输入为 toFixed 产物的整数段，可带 `-`）。 */
function addThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金额千分位格式化（固定 dp 小数位）；null/不可解析 → '--'。 */
export function formatAmount(value: string | number | null | undefined, dp = 2): string {
  const n = toNumber(value);
  if (n == null) return '--';
  const [int = '', frac] = n.toFixed(dp).split('.');
  return frac ? `${addThousands(int)}.${frac}` : addThousands(int);
}

/** 带符号金额（正值前缀 `+`，a11y 色盲友好的非色彩信息载体）；null → '--'。 */
export function formatSignedAmount(value: string | number | null | undefined, dp = 2): string {
  const n = toNumber(value);
  if (n == null) return '--';
  return `${n > 0 ? '+' : ''}${formatAmount(n, dp)}`;
}

/** 数量千分位（≤4 位小数，去尾零）；null/不可解析 → '--'。 */
export function formatQty(value: string | null | undefined): string {
  const n = toNumber(value);
  if (n == null) return '--';
  const [int = '', frac] = n
    .toFixed(4)
    .replace(/\.?0+$/, '')
    .split('.');
  return frac ? `${addThousands(int)}.${frac}` : addThousands(int);
}

/** 小数比率 → 百分比展示（×100，2dp）；signed 时正值前缀 `+`；null → '--'。 */
export function formatRatioPct(value: string | number | null | undefined, signed = false): string {
  const n = toNumber(value);
  if (n == null) return '--';
  const pct = n * 100;
  return `${signed && pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/** 盈亏方向（符号 → 涨跌色系，接 quoteColorClass）；null/NaN → 'none'（中性灰）。 */
export function pnlDirection(value: string | number | null | undefined): QuoteDirection {
  const n = toNumber(value);
  if (n == null) return 'none';
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}
