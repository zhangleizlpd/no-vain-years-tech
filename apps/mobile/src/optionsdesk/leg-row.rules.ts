// 047 T032 — 腿行的纯函数（FR-003/005/007, plan D-UI-1/D-UI-3）。
// 行组件与表头只做接线与版面；横滑 / 首列钉住走 T035 Playwright e2e。
//
// 🚨 **费率列随行口径切换主数字**（FR-003）：收租行主显年化、建仓行主显周化，折年恒为
//    小字副标。**MUST NOT 对周化族的行主显折年** —— 折年 111% 的周化行与年化 17.6% 的行
//    并排同标「好」，正是 FR-004 要防的跨 DTE 直比；更要命的是**屏幕上的数就不是判档用的
//    那个数**（档位是拿周化 2.13% 判的）。
//
// 🚨 **Δ 与 σ 距是同一个 `absDelta` 的两种呈现**（Guardrail 10 / plan D-UI-3）：
//    `|Δ| = Φ(−σ距)` ⇒ 两列 MUST 同时有值或同时留占位，**不允许一列有一列无**。
//    server 已保证二者同源；本文件再钉一道 —— 判据一律看 `absDelta`，不看 `sigmaDistance`。
//
// 🚨 **量纲故意不同，别统一**：三个费率是**小数比例**（`toFixed(6)`），
//    `effectiveCostVsWPct` 是**百分数**（`toFixed(2)`）。
import type { LegResponse, LegResponseBasis } from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { formatPriceText } from './price-format.rules';

const COPY = OPTIONSDESK_COPY.legPicker;

// ═══════════════════ ① 12 列几何（mockup `047-leg-picker.dc.html` 逐值） ═══════════════════

/**
 * 列键 —— 与 FR-003 的列集逐项对应。
 * 🚨 `strike` 是**首列**，渲在横向滚动**之外** ⇒ 天然钉住，**不依赖 `position: sticky`**
 *    （RN 无 sticky；web 侧 mockup 那套 sticky 与本实现不等价，见 plan D-UI-1 末条）。
 */
export const LEG_TABLE_COLUMNS = [
  { key: 'strike', width: 88 },
  // bid/ask 合并一列（FR-003），单元格内是 **2 行 × 2 列**：价格并排在上、挂牌量并排在下。
  // 68 → 88px 是最宽真实内容逼出来的：价格行最宽 `10.90  13.30` = 12 字符 × 11px 等宽
  // （≈6.6px/字）≈ 79px + 内边距。🚫 MUST NOT 回调到 68 —— 那会让深实值腿的两位数价格折行。
  { key: 'bid', width: 88 },
  { key: 'rate', width: 56 },
  { key: 'cost', width: 56 },
  // Δ 列 08-04 mockup review 后由 34 → 42px，以容下 |Δ| 真值（表宽 688 → 696）。
  { key: 'delta', width: 42 },
  { key: 'sigma', width: 46 },
  { key: 'oi', width: 50 },
  { key: 'vol', width: 46 },
  { key: 'turnover', width: 52 },
  { key: 'activity', width: 42 },
  { key: 'mark', width: 84 },
  { key: 'action', width: 66 },
] as const satisfies readonly { key: string; width: number }[];

export type LegColumnKey = (typeof LEG_TABLE_COLUMNS)[number]['key'];

/** 12 列合计（bid 列 68 → 88 后由 696 抬到 716）。 */
export const LEG_TABLE_WIDTH = 716;

/** 首列宽（钉住的那一列）。 */
export const LEG_STICKY_COL_WIDTH = 88;

/** 右侧横滑区宽 —— 表头与每个数据行**共用同一个常量**，否则两者错位不会有任何东西报错。 */
export const LEG_SCROLL_REGION_WIDTH = LEG_TABLE_WIDTH - LEG_STICKY_COL_WIDTH;

/** 右侧 11 列（进横滑容器的那些）。 */
export const LEG_SCROLL_COLUMNS = LEG_TABLE_COLUMNS.slice(1);

// ═══════════════════ ② 数值格式化（缺值一律占位，绝不渲 NaN / 不拿 0 冒充） ═══════════════════

function toFinite(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 费率**小数比例** → 百分数串。精度随口径走（窄列可读且不虚增有效位）：
 * 周化族恒 2 位（`1.90%` 保留末尾 0）；年化族 `< 20%` 收 1 位、`≥ 20%` 收整数（`111%`）。
 * 非数字 / 缺值 → `null`（调用方据此渲占位）。复杂度 O(1)。
 */
export function formatRatePct(
  raw: string | null | undefined,
  basis: LegResponseBasis,
): string | null {
  const ratio = toFinite(raw);
  if (ratio === null) return null;
  const pct = ratio * 100;
  if (basis === 'weekly') return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(Math.abs(pct) >= 20 ? 0 : 1)}%`;
}

/** 已是**百分数**的字段 → 带显式正负号的 1 位小数串（「贵过 W」与「便宜过 W」须一眼可分）。 */
function formatSignedPct(raw: string | null | undefined): string | null {
  const pct = toFinite(raw);
  if (pct === null) return null;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/** OI / Vol —— 千分位。`null` → 占位（「不知道」与「知道是零」是两件事）。O(1)。 */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return COPY.noValue;
  return value.toLocaleString('en-US');
}

/**
 * 买 / 卖盘挂牌量 → `×25`（bid/ask 列下行）。`null` → 占位。O(1)。
 *
 * 🚫 **不加千分位**（与 `formatCount` 刻意不同）：这一行字号 8px、与价格并排挤在 88px 内，
 * `×1,234` 的逗号在那个尺寸下只会糊成噪点。量级本身够读，精确到个位不是它的用途。
 * 🚫 **MUST NOT 参与判档** —— 档位恒由 `bid` 价定（FR-018），量只作同屏参照，故也不上档位色。
 */
export function formatQuoteSize(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return COPY.noValue;
  return `×${value}`;
}

/** 成交额 → `$39.8K` / `$110K` / `$2.4M`。📌 成交额高 ≠ 真流动。O(1)。 */
export function formatTurnover(raw: string | null | undefined): string {
  const value = toFinite(raw);
  if (value === null) return COPY.noValue;
  if (Math.abs(value) >= 1_000_000) {
    const m = value / 1_000_000;
    return `$${m.toFixed(Math.abs(m) >= 100 ? 0 : 1)}M`;
  }
  const k = value / 1000;
  return `$${k.toFixed(Math.abs(k) >= 100 ? 0 : 1)}K`;
}

/** 尾零收干净（`133.00` → `133`；`117.50` → `117.5`）。 */
function trimZeros(raw: string): string {
  return raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
}

// ═══════════════════ ③ 逐列的呈现决策 ═══════════════════

/** 双行单元格（主数字 + 小字副标）。副标缺席 ⇒ `null`（不留空行）。 */
export interface StackedCell {
  primary: string;
  secondary: string | null;
}

/**
 * greeks 缺失行的统一处置（FR-007）：**不判档不着色、费率 / Δ / σ 三列留占位**，
 * 但**行照常在表内**（MUST NOT 隐藏 / 折叠 / 沉底 —— 沉底是死档的处置，两者不同）。
 */
function isGapRow(leg: Pick<LegResponse, 'greeksComplete'>): boolean {
  return !leg.greeksComplete;
}

/** 行权价（本片只含认沽 ⇒ 恒 `P`）。O(1)。 */
export function strikeLabel(leg: Pick<LegResponse, 'strike'>): string {
  return `${trimZeros(leg.strike)} P`;
}

/**
 * 到期日 + DTE。同年只显 `MM-DD·Nd`；**跨年补两位年份**（`27-01-15·529d`）——
 * 88px 首列放不下完整日期，而长天期腿不标年份会被读成今年。复杂度 O(1)。
 */
export function expiryLabel(
  leg: Pick<LegResponse, 'expiryDate' | 'dteDays'>,
  today: string,
): string {
  const [year, month, day] = leg.expiryDate.split('-');
  const sameYear = year === today.slice(0, 4);
  const date = sameYear ? `${month}-${day}` : `${(year ?? '').slice(2)}-${month}-${day}`;
  return `${date}·${leg.dteDays}d`;
}

/**
 * 🚨 费率列 —— 主数字**随行口径**切换（FR-003）。复杂度 O(1)。
 *
 * - 年化族（收租腿）：主显年化，无副标。
 * - 周化族（建仓腿）：主显**周化**，折年降为小字副标 `年 111%`（列头副标标「折年·参照」，
 *   页脚再说明「不跨 DTE 追年化最大化」）—— **MUST NOT 把折年提到主数字位**。
 * - greeks 缺失 / 该口径无值：占位，且**不拿另一个口径的数顶上**。
 */
export function rateCell(
  leg: Pick<LegResponse, 'basis' | 'weeklyRate' | 'annualizedRate' | 'greeksComplete'>,
): StackedCell {
  if (isGapRow(leg)) return { primary: COPY.noValue, secondary: null };
  if (leg.basis === 'annualized') {
    return {
      primary: formatRatePct(leg.annualizedRate, 'annualized') ?? COPY.noValue,
      secondary: null,
    };
  }
  const weekly = formatRatePct(leg.weeklyRate, 'weekly');
  const annualized = formatRatePct(leg.annualizedRate, 'annualized');
  return {
    primary: weekly ?? COPY.noValue,
    secondary: annualized === null ? null : COPY.rateAnnualizedRef(annualized),
  };
}

/** 有效成本 K−P + 相对 W 的百分数。无 bid ⇒ 成本为 null ⇒ 占位（**禁拿 K−0 冒充**）。O(1)。 */
export function costCell(
  leg: Pick<LegResponse, 'effectiveCost' | 'effectiveCostVsWPct'>,
): StackedCell {
  const cost = toFinite(leg.effectiveCost);
  if (cost === null) return { primary: COPY.noValue, secondary: null };
  return {
    primary: formatPriceText(leg.effectiveCost as string),
    secondary: formatSignedPct(leg.effectiveCostVsWPct),
  };
}

/**
 * 🚨 Δ 列显 **|Δ| 真值**（列头副标「带判据」以抑制跨期限横比 —— 可比坐标是 σ 距不是 Δ）。
 * 判据一律看 `absDelta`：它没有，两列就都没有。复杂度 O(1)。
 */
export function deltaCell(leg: Pick<LegResponse, 'absDelta' | 'greeksComplete'>): string {
  if (isGapRow(leg) || leg.absDelta === null) return COPY.noValue;
  return leg.absDelta.toFixed(2);
}

/**
 * 🚨 σ 距列 —— 与 {@link deltaCell} **同有同无**：判据同样是 `absDelta`，
 * 即便契约意外只给了 `sigmaDistance` 也照「不全」处置（一列有一列无是本片明禁的形态）。
 * `≥ 1` 收 1 位、`< 1` 收 2 位。复杂度 O(1)。
 */
export function sigmaCell(
  leg: Pick<LegResponse, 'absDelta' | 'sigmaDistance' | 'greeksComplete'>,
): string {
  if (isGapRow(leg) || leg.absDelta === null || leg.sigmaDistance === null) return COPY.noValue;
  const sigma = leg.sigmaDistance;
  return `${sigma.toFixed(Math.abs(sigma) >= 1 ? 1 : 2)}σ`;
}
