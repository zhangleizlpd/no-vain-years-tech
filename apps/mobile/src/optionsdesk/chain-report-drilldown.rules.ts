// 055 T016 — 报表格 → 选约区块的下钻（`FR-038`, `FR-039`, `FR-039a`, `SC-010`,
// `state_branch` 23/24）。纯函数 → vitest；跳转与接线在屏侧。
//
// 🚨 **「能不能点」与「看起来有没有值」是同一个判据** —— 直接问 `chainReportCellView` 的 `code`，
//    🚫 MUST NOT 在这里再判一次 `state === 'valued'`：两处各判一次，就会出现「格子上明明有数字
//    却点不动」或「一片空白点下去跳走了」，而两种都渲染得出来。
//
// 🚨 **预填表单以「系统默认值」为底，🚫 MUST NOT 以空表单为底**（本片最容易踩且最不会红的一条）
//    —— `CriteriaForm` 里空串的契约含义是**「覆盖为不限」**而不是「不动这一维」。拿空表单当底，
//    权利金 / 活性 / 价差三维会被一起放开，选约表里于是多出报表那一格根本没数进去的腿，
//    **而表照常渲染、条数看着还更「丰富」**（`SC-010` 的条数一致当场破，但界面上没有任何异常）。
//
// 🚨 **`FR-039a` 零新增契约字段** —— 比对用的两个业务日都是**已有**的 `asOf`：报表那一侧随路由
//    参数同行（它就是报表响应里的那个字段），选约那一侧读区块级 `asOf`。🚫 不另立第二套时点语义。
import type {
  ChainReportCellResponse,
  ChainReportColumnResponse,
  ChainReportRowResponse,
  RetrievalCriteriaResponse,
} from '@nvy/api-client';

import { CHAIN_REPORT_TRACK_LEFT } from './chain-report-crosshair.rules';
import {
  CHAIN_REPORT_CELL_HEIGHT,
  CHAIN_REPORT_COLUMN_WIDTH,
  chainReportCellView,
} from './chain-report-grid.rules';
import type { ChainReportMetric } from './chain-report-scale.rules';
import { criteriaFormOf, type CriteriaForm } from './leg-criteria.rules';
import { LEG_PICKER_TABS, type LegPickerTab } from './leg-picker.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.chainReport;

/**
 * 格值 → 落点视角（`FR-039`）。穷举 `Record` ⇒ 加一种格值而不说它落哪个视角即编译红。
 *
 * 🚨 **全腿年化与活跃度都落全腿视角**，两条理由：① 口径同源（全腿年化用的就是全腿那套档界，
 * 活跃度本就不分视角）⇒ 落全腿看到的就是用户刚点的那条腿；② 全腿视角不受期限段与流动性门槛
 * 约束 ⇒ 🚫 不会出现「跳过去发现那条腿不在里面」的**静默落空**（那种落空不报错，只给一个空列表）。
 */
export const CHAIN_REPORT_DRILLDOWN_TAB: Readonly<Record<ChainReportMetric, LegPickerTab>> = {
  buildQuality: 'build',
  rentAnnualized: 'rent',
  allAnnualized: 'all',
  activity: 'all',
};

// ═══════════════════ ① 触点 → 格（越界即不跳） ═══════════════════

/** 命中的格坐标。 */
export interface ChainReportCellHit {
  readonly rowIndex: number;
  readonly columnIndex: number;
}

/**
 * 触点 → 网格体内的格；**落在网格体之外一律 `null`**。`O(1)`。
 * `localY` 已是**相对网格体首行顶缘**的坐标（与十字线同一套换算，由屏侧减掉两级偏移）。
 *
 * 🚨 **越界策略与十字线相反，而且是蓄意的** —— 两者共用同一套几何常量，但：
 *    · 十字线**钳到边界**（手指滑到行标列或右侧空白时，读数停在边界格比闪空好读，且没有后果）；
 *    · 跳转必须**返 `null`** —— 钳过去就是「点在曲线 / 列头 / 行标上，跳进了第一行第一列的格」，
 *      而那一跳**看起来完全正常**（真的落到了一个有腿的条件上），用户无从知道自己点错了。
 * 🚨 **冻结列的判定用屏幕坐标而不是 track 坐标**：横滑后 `localX - TRACK_LEFT - tx` 在行标列上
 *    照样算得出一个正数列序（`tx` 是负值），拿它判「在不在列区里」恒为真。
 */
export function chainReportCellHitAt(
  localX: number,
  localY: number,
  tx: number,
  columnCount: number,
  rowCount: number,
): ChainReportCellHit | null {
  // 冻结列这一刀**只能**在这里切：它下面那个减法会把行标列上的触点算成一个正数列序。
  // 纵向不需要对称的一刀 —— 网格体上方的触点 `localY` 为负，落进下面的 `rowIndex < 0`。
  if (localX < CHAIN_REPORT_TRACK_LEFT) return null;
  const columnIndex = Math.floor(
    (localX - CHAIN_REPORT_TRACK_LEFT - tx) / CHAIN_REPORT_COLUMN_WIDTH,
  );
  const rowIndex = Math.floor(localY / CHAIN_REPORT_CELL_HEIGHT);
  if (columnIndex < 0 || columnIndex >= columnCount) return null;
  if (rowIndex < 0 || rowIndex >= rowCount) return null;
  return { rowIndex, columnIndex };
}

// ═══════════════════ ② 有值格 → 下钻参数 ═══════════════════

/** 下钻随路由同行的参数。全字符串 —— 它们要经过 URL（含 web 深链）。 */
export interface ChainReportDrilldownParams {
  readonly perspective: LegPickerTab;
  readonly dteMin: string;
  readonly dteMax: string;
  /** `''` = 该行没有这一端的界（顶档开口）；落到表单时**留默认**，见 {@link chainReportPrefillForm}。 */
  readonly strikeMin: string;
  readonly strikeMax: string;
  /** 报表侧业务日（`FR-039a` 的比对输入）。 */
  readonly reportAsOf: string;
}

export interface ChainReportDrilldownInput {
  readonly metric: ChainReportMetric;
  readonly row: Pick<ChainReportRowResponse, 'otmFloor' | 'strikeFloor' | 'strikeCeiling'>;
  readonly column: Pick<ChainReportColumnResponse, 'dteDays'>;
  readonly cell: Pick<ChainReportCellResponse, 'state' | 'best' | 'legCount'>;
  readonly isOutOfBand: boolean;
  readonly reportAsOf: string;
}

/**
 * 有值的格 → 下钻参数；其余一律 `null`（`FR-038`「点空格 MUST NOT 跳转」）。`O(1)`。
 *
 * 📌 期限区间**收成该到期日一天**（`dteMin === dteMax === dteDays`）—— 列就是一个到期日，
 * 给一个区间等于把邻列也放进来。
 * 📌 行权价区间取该价外档对应的区间。⚠️ 行的下界在报表里是**开区间**、而检索条件是闭区间 ⇒
 * 恰好落在下界上的腿会同时出现在相邻两行的下钻结果里。方向是**多一条**不是少一条（缺失比多出
 * 更难发现），且真实行权价极少正好等于 `spot × (1 + 档界)` 这个浮点数，故不为它另加契约字段。
 */
export function chainReportDrilldownParams(
  input: ChainReportDrilldownInput,
): ChainReportDrilldownParams | null {
  const view = chainReportCellView(input.metric, input.row, input.cell, input.isOutOfBand);
  // 🚨 与「格子上看起来有没有值」同一个判据：着了色的与「口径不适用但有读数」的都能点。
  if (view.code !== 'band' && view.code !== 'inapplicable') return null;
  return {
    perspective: CHAIN_REPORT_DRILLDOWN_TAB[input.metric],
    dteMin: String(input.column.dteDays),
    dteMax: String(input.column.dteDays),
    strikeMin: input.row.strikeFloor ?? '',
    strikeMax: input.row.strikeCeiling,
    reportAsOf: input.reportAsOf,
  };
}

// ═══════════════════ ③ 路由参数 → 预填 ═══════════════════

export interface ChainReportPrefill {
  readonly tab: LegPickerTab;
  readonly dteMin: string;
  readonly dteMax: string;
  /** `''` = 该端无界 ⇒ 落表单时留默认（🚫 不覆盖成「不限」）。 */
  readonly strikeMin: string;
  readonly strikeMax: string;
  readonly reportAsOf: string | null;
}

/** expo-router 的形参可能是数组（同名参数重复）—— 取第一个，🚫 不炸也不拼接。`O(1)`。 */
function firstParam(raw: string | string[] | undefined): string | null {
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

function asTab(raw: string | null): LegPickerTab | null {
  return LEG_PICKER_TABS.includes(raw as LegPickerTab) ? (raw as LegPickerTab) : null;
}

/**
 * 路由参数 → 预填；不是下钻（或参数残缺）⇒ `null`。`O(1)`。
 *
 * 🚨 **视角认不出来就整个作废，🚫 MUST NOT 兜一个默认视角** —— 兜了就是「点建仓的格、落到收租
 * 的表」，用户看到的每一行都对，只是答的不是他点的那个问题。
 * 🚨 **DTE 半对作废** —— 成对维度，只给一端在契约里直接 400；在这里就地拦掉，别把半个区间
 * 送进表单（送进去会被 `normalizeCriteriaForm` 归零成「不限」，等于整条链都放进来）。
 */
export function chainReportPrefillOf(
  raw: Readonly<Record<string, string | string[] | undefined>>,
): ChainReportPrefill | null {
  const tab = asTab(firstParam(raw.perspective));
  if (tab === null) return null;
  const dteMin = firstParam(raw.dteMin);
  const dteMax = firstParam(raw.dteMax);
  if (dteMin === null || dteMax === null || dteMin === '' || dteMax === '') return null;
  // 🚨 空串的报表时点 = **没有时点**（报表侧 `asOf` 本就可空）—— 留着空串会让下面那句提示
  //    拿一个空日期去比，屏幕上出现「报表读的是  的数据」，而它照样印得出来。
  const reportAsOf = firstParam(raw.reportAsOf);
  return {
    tab,
    dteMin,
    dteMax,
    strikeMin: firstParam(raw.strikeMin) ?? '',
    strikeMax: firstParam(raw.strikeMax) ?? '',
    reportAsOf: reportAsOf === '' ? null : reportAsOf,
  };
}

/**
 * 预填 → 提交给选约表的表单。**底是系统默认值**（见文件头那条 🚨）。`O(1)`。
 *
 * 🚨 **空串的界一律留默认**：行没有这一端的界（顶档开口）说的是「这一行不设界」，
 * 🚫 不等于「这个视角放弃它自己的界」—— 覆盖成「不限」会放进报表那一格之外的腿。
 */
export function chainReportPrefillForm(
  defaults: RetrievalCriteriaResponse | null,
  prefill: ChainReportPrefill,
): CriteriaForm {
  const base = criteriaFormOf(defaults);
  return {
    ...base,
    dteMin: prefill.dteMin,
    dteMax: prefill.dteMax,
    strikeMin: prefill.strikeMin === '' ? base.strikeMin : prefill.strikeMin,
    strikeMax: prefill.strikeMax === '' ? base.strikeMax : prefill.strikeMax,
  };
}

// ═══════════════════ ④ 两侧业务日不一致（FR-039a / SC-010） ═══════════════════

/**
 * 报表侧与选约侧的业务日不一致 ⇒ 一句同时含**两个时点**的提示；一致或任一侧缺 ⇒ `null`。`O(1)`。
 *
 * 🚨 那时条数不符是**数据真的变了**、不是缺陷 —— 但不说出来它就变成了缺陷（`FR-039a`）。
 * 🚫 缺时点 MUST NOT 当成不一致：「不知道」与「不同」是两件事，而两者都印得出一句提示。
 */
export function chainReportDrilldownAsOfNotice(
  reportAsOf: string | null,
  legAsOf: string | null,
): string | null {
  if (reportAsOf === null || legAsOf === null) return null;
  return reportAsOf === legAsOf ? null : COPY.drilldownAsOfMismatch(reportAsOf, legAsOf);
}
