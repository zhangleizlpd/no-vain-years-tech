// 行情数值的「数据截至」标注（FR-016 语义：对外呈现的每个行情数值都必须带 asOf + 新鲜度档，
// 回落快照禁静默当实时）。
//
// 自 `~/portfolio/stock-detail.helpers.ts` 的 `formatAsOf` **上提**到共享位置 —— 045 雷达
// （T024）是第二个消费方，plan D14a 明确「impl 期直接复用既有体例，不重写」。同一语义两处
// 各写一份必 drift，故这里是唯一落点：portfolio 的 `formatAsOf` 现在委托到本函数。

/**
 * 「数据截至 2026-06-01 · 收盘」。`asOf` 缺失 → 空串（调用方据此不渲染，绝不渲染裸数值）。
 * `priceKind === 'eod_close'` 才带「· 收盘」后缀；其余通路不加，避免把非收盘价说成收盘。
 */
export function formatAsOfLabel(
  asOf: string | null | undefined,
  priceKind?: string | null,
): string {
  if (!asOf) return '';
  return `数据截至 ${asOf}${priceKind === 'eod_close' ? ' · 收盘' : ''}`;
}

/**
 * 设备本地日历日 `YYYY-MM-DD`。
 *
 * 🚨 **MUST NOT 用来判新鲜度**（「asOf 是不是当期」）。那个判据要查交易日历、已上移到 server
 * （`freshnessTier`，FR-020）；用本地日期比对美股**永不相等** —— 美股 08-04 的 EOD 要到北京
 * 08-05 清晨才落库，那时设备已是 08-05 ⇒ 境内用户看到的每个美股读数恒显「已过时」。
 *
 * 仅剩两种合法用途：**时间窗起点/终点求值**（bars 的 `from`/`to`）与**逾期天数展示**。
 */
export function todayYmd(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}
