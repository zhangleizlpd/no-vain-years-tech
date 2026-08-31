// 047 T032 — 腿行的纯函数（FR-003/005/007, plan D-UI-1/D-UI-3）。
// 行组件与表头只做接线与版面；横滑 / 首列钉住走 T035 Playwright e2e。
//
// 🚨 **费率列随行口径切换主数字**（FR-003）：收租行主显年化、建仓行主显周化，折年恒为
//    小字副标。**MUST NOT 对周化族的行主显折年** —— 折年 111% 的周化行与年化 17.6% 的行
//    并排同标「好」，正是 FR-004 要防的跨 DTE 直比；更要命的是**屏幕上的数就不是判档用的
//    那个数**（档位是拿周化 2.13% 判的）。
//
// 🚨 **Δ 是 `absDelta` 的唯一呈现**（053 FR-034）：σ 距列已随列改版退场 —— 它与 Δ 由
//    `|Δ| = Φ(−σ距)` 构造性一一对应，删其一零信息损失。契约仍下发 `sigmaDistance`，
//    但**判据只看 `absDelta`**：它没有就留占位，`sigmaDistance` 单独有值也顶不上。
//
// 🚨 **量纲故意不同，别统一**：三个费率是**小数比例**（`toFixed(6)`），
//    `effectiveCostVsWPct` 是**百分数**（`toFixed(2)`）。
import type { LegMarchStrikeResponse, LegResponse, LegResponseBasis } from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { formatPriceText } from './price-format.rules';

const COPY = OPTIONSDESK_COPY.legPicker;

// ═══════════════════ ① 12 列几何（mockup `053-leg-columns.dc.html` 逐值） ═══════════════════

/**
 * 列键 —— 与 FR-030 的列集逐项对应，**数组顺序就是屏幕上的列序**。
 * 🚨 `strike` 是**首列**，渲在横向滚动**之外** ⇒ 天然钉住，**不依赖 `position: sticky`**
 *    （RN 无 sticky；web 侧 mockup 那套 sticky 与本实现不等价，见 plan D-UI-1 末条）。
 * 📌 `bid/ask → rate → premium` 刻意相邻（FR-030）——「这单值不值得挂、挂不挂得出去」的
 *    完整判据集，此前散在表的两端，用户要横滑两次才凑得齐一次判断。
 */
export const LEG_TABLE_COLUMNS = [
  { key: 'strike', width: 88 },
  // bid/ask 合并一列（FR-031，053 订正后**仍不拆**），单元格内是 **2 行 × 2 列**：价格并排在
  // 上、挂牌量并排在下 ⇒ 并排比对早已实现，拆成两列只会各自更宽。
  // 68 → 88px 是最宽真实内容逼出来的：价格行最宽 `10.90  13.30` = 12 字符 × 11px 等宽
  // （≈6.6px/字）≈ 79px + 内边距。🚫 MUST NOT 回调到 68 —— 那会让深实值腿的两位数价格折行。
  { key: 'bid', width: 88 },
  { key: 'rate', width: 56 },
  // 053 新增两列（FR-032）：两个数都**服务端算**，客户端零计算。
  { key: 'premium', width: 50 },
  { key: 'oi', width: 50 },
  { key: 'spread', width: 48 },
  { key: 'cost', width: 56 },
  // Δ 列 08-04 mockup review 后由 34 → 42px，以容下 |Δ| 真值（表宽 688 → 696）。
  { key: 'delta', width: 42 },
  { key: 'vol', width: 46 },
  { key: 'activity', width: 42 },
  { key: 'mark', width: 84 },
  { key: 'action', width: 66 },
] as const satisfies readonly { key: string; width: number }[];

export type LegColumnKey = (typeof LEG_TABLE_COLUMNS)[number]['key'];

/**
 * 12 列合计（bid 列 68 → 88 后由 696 抬到 716）。
 * 🚨 **053 列改版后仍是 716**：删的 `σ距 46 + 成交额 52` 恰好填平新增的 `权利金 50 + 价差 48`
 *    （FR-033/FR-034）。049 的横滑范式把**内容总宽当作位移钳制的输入** ⇒ 总宽一变，指示条
 *    长度比与 `maxTx` 全跟着变，真机上表现为「右侧滑不到底」**且不会红**。
 */
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

/**
 * 单笔权利金（卖出一张 put 实际收到多少钱）→ 千分位整数（`1,290` / `160`）。O(1)。
 *
 * 🚫 **MUST NOT 由 `bid` 乘一次合约乘数**（FR-032 / ADR-0064 不变量 ③）—— 合约乘数是市场
 * 规则不是合约属性，服务端已持有那一份，客户端再乘就是同一判据两处各算一份，而两边都乘得出数。
 * 缺 bid ⇒ 服务端给 `null` ⇒ 占位（**禁拿 0 冒充**「白挂一张不收钱」）。
 */
export function formatContractPremium(raw: string | null | undefined): string {
  const value = toFinite(raw);
  if (value === null) return COPY.noValue;
  return Math.round(value).toLocaleString('en-US');
}

/**
 * 相对价差 `(ask − bid) / mid`，**小数比例** → 百分数。O(1)。
 *
 * 精度随量级走（48px 列里 `45.2%` 已占满）：`< 100%` 收 1 位、`≥ 100%` 收整数。
 * 📌 与召回层流动性判据是**同一个**派生值（服务端算），故「这条腿为什么被挡了」在屏上对得上账。
 * 任一侧缺报价 / mid ≤ 0 ⇒ 服务端给 `null` ⇒ 占位。
 */
export function formatRelativeSpread(raw: string | null | undefined): string {
  const ratio = toFinite(raw);
  if (ratio === null) return COPY.noValue;
  const pct = ratio * 100;
  return `${pct.toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%`;
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
 * greeks 缺失行的统一处置（FR-007）：**不判档不着色、费率与 Δ 两列留占位**，
 * 但**行照常在表内**（MUST NOT 隐藏 / 折叠 / 沉底 —— 沉底是死档的处置，两者不同）。
 */
function isGapRow(leg: Pick<LegResponse, 'greeksComplete'>): boolean {
  return !leg.greeksComplete;
}

/**
 * 068 带外横档判定（FR-009 呈现侧）。复杂度 O(1)。
 *
 * 🚨 **判据只从契约 `bandStatus` 来**（ADR-0064 不变量 ②「客户端 MUST NOT 反推」）——
 * 🚫 不拿 `absDelta` 对带界重算一遍：带界是服务端标定参数，客户端算第二份必漂移。
 * 🚨 只有 `'out'` 打标：带内是默认呈现（执行目标），逐行加「带内」标只是噪点；`null`
 * （离线档 / 实时 Δ 缺失）无带语义，不冒充带外。打标不删行 —— 横档的存在就是它的功能（比价）。
 */
export function legRowBandOut(bandStatus: LegResponse['bandStatus']): boolean {
  return bandStatus === 'out';
}

/**
 * 071 宽价差机会标判定（FR-010 呈现侧）。复杂度 O(1)。
 *
 * 🚨 **判据只从契约布尔来**（ADR-0064 不变量 ②）—— 🚫 MUST NOT 拿 `relativeSpread` 与
 * 年化档界在客户端重算一遍：档界是服务端的策略参数（`leg-tier.rules.ts` 单点），客户端算
 * 第二份必漂移，而**两边都算得出布尔、都不会红**。
 * 🚨 **只标不改行**：不降灰、不折叠、不沉底 —— 它是机会标；「价差有多宽」由同一行的价差列
 * 如实呈现，本标只回答「它凭什么还在这张意图表里」。
 * 📌 与 {@link legRowBandOut} 各自独立、可同现：带外说 Δ 落不落带，本标说这条腿怎么进来的。
 */
export function legRowWideSpread(
  wideSpreadOpportunity: LegResponse['wideSpreadOpportunity'],
): boolean {
  return wideSpreadOpportunity;
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
 * 🚨 Δ 列显 **|Δ| 真值**（列头副标「带判据」以抑制跨期限横比 —— 可比坐标是 σ 距不是 Δ，
 * 而 σ 距列已随 053 列改版退场）。判据只有 `absDelta` 一个：它没有就留占位。复杂度 O(1)。
 */
export function deltaCell(leg: Pick<LegResponse, 'absDelta' | 'greeksComplete'>): string {
  if (isGapRow(leg) || leg.absDelta === null) return COPY.noValue;
  return leg.absDelta.toFixed(2);
}

// ═══════════════════ ④ 069 行军行内标注（FR-016 / FR-019） ═══════════════════

/**
 * 劣档灰显微标（凹 #2 / 陈 #3 / 并 #4，069 FR-004 只标不删；叉 #1 070 FR-004 补齐清链家族）。
 */
export type LegInferiorMarkKind = 'concave' | 'stale' | 'merged' | 'crossed';

/**
 * 该行所属 K 的行军块。O(K)。
 *
 * 🚨 **同 K 判定 = 字符串相等**：`LegResponse.strike` 与 `LegMarchStrikeResponse.strike`
 * 服务端同为 `toFixed(4)` 序列化 ⇒ 逐字符同值，🚫 MUST NOT 在客户端 parse 成数字再比
 * （浮点化是第二份口径）。`march = null`（建仓 / 全腿 / 离线）⇒ 恒 `null`。
 */
export function marchStrikeOf(
  leg: Pick<LegResponse, 'strike'>,
  march: readonly LegMarchStrikeResponse[] | null,
): LegMarchStrikeResponse | null {
  if (march === null) return null;
  return march.find((strikeView) => strikeView.strike === leg.strike) ?? null;
}

/**
 * 069 推荐章判定（FR-016）：该行是否是其 K 的行军推荐档。O(K)。
 *
 * 🚨 **判据只从契约 `march` 来**（ADR-0064 不变量 ②「客户端 MUST NOT 反推」）——
 * 🚫 不拿行上的费率对 φ 重演行军：判据是服务端标定参数 + 净链形状，客户端第二份必漂移。
 * `march = null` ⇒ 恒 `false`（FR-019 建仓行恒无章的结构保证）。
 */
export function legRowMarchRecommended(
  leg: Pick<LegResponse, 'strike' | 'dteDays'>,
  march: readonly LegMarchStrikeResponse[] | null,
): boolean {
  const strikeView = marchStrikeOf(leg, march);
  return (
    strikeView !== null &&
    strikeView.verdict === 'recommended' &&
    strikeView.recommendedDteDays === leg.dteDays
  );
}

/**
 * 劣档微标（069 FR-004/FR-016 三类 + 070 FR-004 第四类）：从该 K 审计条目的**清链家族**
 * 类目映射 —— 家族全集恰四类，本函数现与 `MARCH_FAMILY_OF_CATEGORY` 的 `chain_clean` 半边
 * 一一对齐。O(K + 档)。其余类目（行军 / 可成交 / 边界家族）不上行内微标 —— 它们的去处是审计
 * 弹层，行内只标「这档的报价几何有问题」那几类。无条目 ⇒ `null`。
 *
 * 🚨 **#1 交叉报价分支天然是离线专属**（070 FR-006）：实时口径下交叉腿在召回层就被剔出候选，
 * 压根不成行 ⇒ 判定函数**无需知道档位**，🚫 MUST NOT 为它加 `priceKind` 入参反推档位
 * （usecase 侧同一条纪律：处置按口径分派、判据不反推）。
 */
export function legRowInferiorMark(
  leg: Pick<LegResponse, 'strike' | 'dteDays'>,
  march: readonly LegMarchStrikeResponse[] | null,
): LegInferiorMarkKind | null {
  const strikeView = marchStrikeOf(leg, march);
  const entry = strikeView?.audits.find((audit) => audit.dteDays === leg.dteDays);
  switch (entry?.category) {
    case 'concave_dominated':
      return 'concave';
    case 'absolute_dominated':
      return 'stale';
    case 'collinear_merged':
      return 'merged';
    case 'crossed_quote':
      return 'crossed';
    default:
      return null;
  }
}
