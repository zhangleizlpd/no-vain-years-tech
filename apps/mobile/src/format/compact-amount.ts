// 金额「万」缩写（083 FR-022，plan D14「数字」段）+ 详情页全精度金额。
//
// 📌 **与 `~/portfolio/stock-detail.helpers.ts` 的 `formatLargeAmount` 的关系**：那是预存在的
//    同类函数（万亿 / 亿 / 万三档、`< 1万` 不带千分位、无 `signed`），口径与本文件不同；
//    optionsdesk 不能跨 feature import portfolio，本片也不重构它 ⇒ 两份并存是已知状态，
//    不要顺手「统一」（改 portfolio 的显示口径不在 083 范围内）。
// 📌 千分位写法照 `~/portfolio/holdings.helpers.ts` 的 `addThousands`（同理不可跨 feature
//    import，只抄写法）。🚫 `toLocaleString` / `Intl.NumberFormat`：Hermes 上 Intl 支持不确定，
//    083 已因此把时区换算放到服务端，这里同一纪律。
// 📌 数值精度：Decimal string → Number 只用于**展示**，不回写（金额量级 float64 充裕）。

const NO_VALUE = '--';
const WAN = 1e4;
const YI = 1e8;

export interface AmountFormatOptions {
  /** 正数带 `+`（盈亏类字段）；舍入后为零时不带任何符号。 */
  signed?: boolean;
}

/** Decimal string → 有限数；null / 空串 / 不可解析（如 `N/A`）→ null。 */
function parseAmount(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** 非负数 → 千分位 2 位小数。复杂度 O(d)，d = 整数位数。 */
function groupThousands(abs: number): string {
  const [int = '0', frac = '00'] = abs.toFixed(2).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/**
 * 给已格式化的绝对值数字段补符号与单位。
 * 🚨 舍入后为零（如 `-0.001` → `0.00`）⇒ 不带符号，避免显示 `-0.00` / `+0.00`。
 */
function withSign(n: number, digits: string, unit: string, signed: boolean): string {
  const isZero = Number(digits.replace(/,/g, '')) === 0;
  const sign = isZero ? '' : n < 0 ? '-' : signed ? '+' : '';
  return `${sign}${digits}${unit}`;
}

/**
 * 主列表金额（市值 / 组市值 / 持仓盈亏金额 / 组持仓盈亏）：
 * `|n| < 1万` ⇒ 千分位 2 位小数；`1万 ≤ |n| < 1亿` ⇒ `x.xx万`；`≥ 1亿` ⇒ `x.xx亿`；保号。
 *
 * 🚨 **按原值判档**：`99999999` 在「万」档 ⇒ `10000.00万`，不因舍入进位升到「亿」档。
 * 🚫 数量 / 价格 / 比例不走本函数（FR-022）。复杂度 O(d)。
 */
export function formatCompactAmount(value: string | null, opts: AmountFormatOptions = {}): string {
  const n = parseAmount(value);
  if (n === null) return NO_VALUE;
  const abs = Math.abs(n);
  const signed = opts.signed === true;
  if (abs >= YI) return withSign(n, (abs / YI).toFixed(2), '亿', signed);
  if (abs >= WAN) return withSign(n, (abs / WAN).toFixed(2), '万', signed);
  return withSign(n, groupThousands(abs), '', signed);
}

/** 详情页金额：全精度千分位 2 位小数（不缩写）；null / 非法 ⇒ `--`。复杂度 O(d)。 */
export function formatFullAmount(value: string | null, opts: AmountFormatOptions = {}): string {
  const n = parseAmount(value);
  if (n === null) return NO_VALUE;
  return withSign(n, groupThousands(Math.abs(n)), '', opts.signed === true);
}
