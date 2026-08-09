import type { QuoteItem } from '@nvy/api-client';

// 涨停/跌停客户端纯函数（021 T015 / FR-M01，clarify #2）：015 报价无此字段，由昨收按
// 板块规则计算，展示参考为主——新股首日无限制等边角料允许不准（clarify 已接受）。
// 规则：名称含 ST → ±5%（字面规则，优先于板块段）；代码段 688/689·300/301 → ±20%；
// 北交 920/8x/4x → ±30%（920 = 2025 起京市新段，与 ~/ui/market-badge.rules 同口径）；
// 其余 → ±10%。价格 = round(prevClose×(1±pct), 2) 四舍五入。
// 复杂度 O(1)；纯函数 vitest（per mono 测试分层）。

/** 板块涨跌停幅度 %（ST 优先 → 科创/创业 20 → 北交 30 → 主板 10）。 */
export function limitPct(code: string, name?: string | null): number {
  if (name != null && name.includes('ST')) return 5;
  const seg3 = code.slice(0, 3);
  if (seg3 === '688' || seg3 === '689' || seg3 === '300' || seg3 === '301') return 20;
  if (seg3 === '920' || code.startsWith('8') || code.startsWith('4')) return 30;
  return 10;
}

/** 四舍五入到分（先放大避免 toFixed 对 .x5 的浮点截断）。 */
const round2 = (v: number): number => Math.round(v * 100) / 100;

export interface LimitPrices {
  /** 涨停价（2dp string）；昨收缺失 → null（渲染 '--'）。 */
  up: string | null;
  /** 跌停价（同上）。 */
  down: string | null;
}

/** 涨停/跌停价：`round(prevClose×(1±pct), 2)`；昨收缺失/非正 → 双 null。 */
export function limitPrices(
  prevClose: number | null,
  code: string,
  name?: string | null,
): LimitPrices {
  if (prevClose == null || prevClose <= 0) return { up: null, down: null };
  const pct = limitPct(code, name) / 100;
  return {
    up: round2(prevClose * (1 + pct)).toFixed(2),
    down: round2(prevClose * (1 - pct)).toFixed(2),
  };
}

/**
 * 由 015 报价推导昨收：`price − change`（quote 契约无 prevClose 字段）。
 * 任一字段缺失 / 非数 / 推导非正 → null。保留 4dp 精度（与 bar Decimal(18,4) 同刻度）。
 */
export function prevCloseOf(quote: QuoteItem | undefined): number | null {
  if (!quote || !quote.hasData || quote.price == null || quote.change == null) return null;
  const price = Number.parseFloat(quote.price);
  const change = Number.parseFloat(quote.change);
  if (Number.isNaN(price) || Number.isNaN(change)) return null;
  const prevClose = Math.round((price - change) * 10000) / 10000;
  return prevClose > 0 ? prevClose : null;
}
