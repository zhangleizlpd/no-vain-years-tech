// 052 T012 — 检索条件控件的纯函数（FR-011/012/013/015/029/030, plan D-CRIT-1）。
// 抽屉与入口只做接线与版面；渲染 / 交互 / a11y 走 T013 Playwright e2e。
//
// 🚨 **客户端 MUST NOT 计算任何默认值**（FR-011 / Guardrail 6）—— 行权价上界与权利金下限都
//    依赖 spot（每天变），自算就是同一判据两处各一份，而**两边都算得出数**：漂移只在换日
//    那一刻才看得见。本文件对服务端下发的值只做两件事：**定标裁剪**（`137.7000` → `137.7`）
//    与**量纲换算**（无量纲比例 ↔ 百分数），两者都不产生新的判据值。
//    源码层的零命中判据在 `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #8。
//
// 🚨 **成员判定不在这里、也不在客户端任何地方**（FR-003「全仓只有一个 filter 概念」）——
//    本文件只把用户填的值搬进 query 参数，哪条腿进候选集全由服务端的召回层说了算。
//
// 🚨 **六个维度不是六个控件**：DTE 段与活性各是**一个维度、一对数**（成对下发，只给一端
//    服务端直接 400）；行权价上下界反过来是**两个独立维度**（单边不限是合法值）。
//    把活性拆成两维会让同一条腿同时计进两行边际计数 —— 两行说的是同一批腿，加起来双计。
import type {
  OptionsdeskControllerLegsParams,
  PerspectiveCriteriaResponse,
  RetrievalCriteriaResponse,
  RetrievalOutcomesResponse,
} from '@nvy/api-client';

import type { LegPickerTab } from './leg-picker.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.legPicker.criteria;

/**
 * 六个检索维度的键 —— **取自契约 `outcomes` 的形状本身**，不另造一套。
 * server 加一维而这里漏映射 ⇒ 下面几张穷举 `Record` 立刻编译红。
 */
export type CriterionKey = keyof RetrievalOutcomesResponse;

/** 抽屉里的一行控件。一行 ≠ 一维（见文件头）。 */
export type CriteriaRowKey = 'strike' | 'dte' | 'premium' | 'liveness' | 'spread';

/**
 * 控件值 —— 一律**显示串**，`''` = 不限（与契约「空串 = 覆盖为不限」同形，缺键才是「没动过」）。
 * 🚫 MUST NOT 用 `null` 表达不限：那样「清空了」与「还没填」在类型上分不开，而它们提交时
 *    一个带空串、一个缺键，行为完全不同。
 */
export interface CriteriaForm {
  readonly strikeMin: string;
  readonly strikeMax: string;
  readonly dteMin: string;
  readonly dteMax: string;
  readonly premiumMin: string;
  readonly oiMin: string;
  readonly volMin: string;
  /** **百分数**显示（`35` = 35%）—— 契约走无量纲比例，换算只在本文件的两处。 */
  readonly relativeSpreadMax: string;
}

/** 每行编辑哪几个维度。`Record` 穷举 ⇒ 加一行而不说它管哪几维即编译红。 */
const ROW_CRITERIA: Readonly<Record<CriteriaRowKey, readonly CriterionKey[]>> = {
  strike: ['strikeMin', 'strikeMax'],
  dte: ['dteBand'],
  premium: ['premiumMin'],
  liveness: ['livenessMin'],
  spread: ['relativeSpreadMax'],
};

/** 抽屉内的**行序**（= 上表键序，mockup A2 逐行）。 */
export const CRITERIA_ROWS = Object.keys(ROW_CRITERIA) as readonly CriteriaRowKey[];

/** 每个维度对应表单里的哪几个框（成对维度两个，其余一个）。 */
const CRITERION_FIELDS: Readonly<Record<CriterionKey, readonly (keyof CriteriaForm)[]>> = {
  strikeMax: ['strikeMax'],
  strikeMin: ['strikeMin'],
  dteBand: ['dteMin', 'dteMax'],
  premiumMin: ['premiumMin'],
  livenessMin: ['oiMin', 'volMin'],
  relativeSpreadMax: ['relativeSpreadMax'],
};

/** 六个维度（顺序 = 契约 `outcomes` 的字段序，也是计数行的展示序）。 */
export const CRITERION_KEYS = Object.keys(CRITERION_FIELDS) as readonly CriterionKey[];

/** 全空表单 —— 契约未到手 / 链未就绪（六维全 null）时的形态。 */
const EMPTY_CRITERIA_FORM: CriteriaForm = {
  strikeMin: '',
  strikeMax: '',
  dteMin: '',
  dteMax: '',
  premiumMin: '',
  oiMin: '',
  volMin: '',
  relativeSpreadMax: '',
};

/** 比例 ↔ 百分数的量纲因子。**不是策略参数** —— 它是 `%` 这个符号的定义。 */
const PERCENT_SCALE = 100;
/** 契约小数字段的定标（`decimal4`）—— 换算回比例时按它对齐，避免多余有效位。 */
const RATIO_SCALE = 4;

// ═══════════════════ ① 服务端默认值 → 控件值（零处自算） ═══════════════════

/** 定标串 → 最简显示串（`137.7000` → `137.7`）。纯字符串裁剪，不过浮点。O(n)。 */
function trimScale(raw: string): string {
  if (!raw.includes('.')) return raw;
  return raw.replace(/0+$/, '').replace(/\.$/, '');
}

/** 无量纲比例 → 百分数显示串。非数字 → 空（不渲 `NaN`）。O(1)。 */
function ratioToPercent(raw: string): string {
  const ratio = Number.parseFloat(raw);
  if (!Number.isFinite(ratio)) return '';
  return trimScale((ratio * PERCENT_SCALE).toFixed(RATIO_SCALE));
}

/** 百分数输入 → 契约要的无量纲比例串。非数字 → `null`（调用方据此不下发该维）。O(1)。 */
function percentToRatio(text: string): string | null {
  const pct = Number.parseFloat(text);
  if (!Number.isFinite(pct)) return null;
  return (pct / PERCENT_SCALE).toFixed(RATIO_SCALE);
}

function decimalText(value: string | null): string {
  return value === null ? '' : trimScale(value);
}

/**
 * 系统默认值 → 控件初值（FR-011）。复杂度 O(1)。
 *
 * 🚨 **`null` = 不限 ⇒ 空框**，🚫 MUST NOT 拿 `0` / `∞` / 任何替代数字顶上：`0` 是一个**值**
 *    （下限设为 0 与不设下限在契约里是两件事），而屏幕上它们看起来一模一样。
 * 📌 链未就绪时六维全 `null` ⇒ 六个框全空 ——「解不出」MUST NOT 看起来像「解出来正好是这些」。
 */
export function criteriaFormOf(defaults: RetrievalCriteriaResponse | null): CriteriaForm {
  if (defaults === null) return EMPTY_CRITERIA_FORM;
  const { dteBand, livenessMin } = defaults;
  return {
    strikeMin: decimalText(defaults.strikeMin),
    strikeMax: decimalText(defaults.strikeMax),
    dteMin: dteBand === null ? '' : String(dteBand.min),
    dteMax: dteBand === null ? '' : String(dteBand.max),
    premiumMin: decimalText(defaults.premiumMin),
    oiMin: livenessMin === null ? '' : String(livenessMin.oi),
    volMin: livenessMin === null ? '' : String(livenessMin.volume),
    relativeSpreadMax:
      defaults.relativeSpreadMax === null ? '' : ratioToPercent(defaults.relativeSpreadMax),
  };
}

// ═════════ ② 每视角的控件集 —— 056 起**没有这一层**（行集统一到全部 5 行） ═════════
//
// 🚨 **别默默加回一张 per-视角行集表。** `052` 的 `ROWS_BY_TAB` / `HAS_DEFAULT` /
//    `criteriaRowsFor` 已随 `056` `FR-012` 整体删除：三视角一律显示全部 5 行，**哪几行怎么排
//    是表达层的事**（`leg-criteria-sheet.tsx` 自己的版面常量），本文件只留「维度 → 框」。
// 📌 **删干净而不是留个恒返全集的函数**：`criteriaRowsFor` 的第二分支（「有值必可见」）在固定
//    行集下**结构上不可达**（`||` 左支恒真），而一个「两个入参都不看、恒返全集」的函数比删掉更坏。
// 📌 **行为惰性已实证**（`FR-019`）：被藏的两行（全腿价差 / 建仓行权价）默认值**都是 `null`**，
//    服务端 `matchesCriterion` 各支一律 `!== null` 守卫，且 `applyOverride` 无 per-视角白名单
//    ⇒ 默认候选集逐视角零变化，服务端零改动。
// ⚠️ 将来若某个视角要重新收起某一行，先回看 spec `FR-012`：加回 per-视角行集表会同时复活
//    「任意子集」的版式复杂度与 A′ ③（权利金与价差并成一行）在全腿的无定义缺口。

// ═══════════════════ ③ 用户动过哪几维 ═══════════════════

/**
 * 两个控件值等价吗。`''`（不限）只与 `''` 等价；其余按**数值**比 ——
 * `0.24` 与 `0.2400` 是同一个值，定标差异不该算成「用户改过」。O(1)。
 */
function sameValue(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left === '' || right === '') return left === right;
  const x = Number.parseFloat(left);
  const y = Number.parseFloat(right);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return left === right;
  return x === y;
}

/**
 * 用户覆盖了哪几个维度（与系统默认值逐维比）。复杂度 O(1)（六维定长）。
 *
 * 🚨 **判据是「值不同」而不是「用户碰过输入框」**：碰过又改回去不算覆盖，否则「已改 N 项」
 *    会数出一个用户自己都不认的数。三态（未覆盖 / 放宽 / 收窄）的判定在服务端，客户端这份
 *    只用来决定**下发哪几个键**与抽屉副标题。
 */
export function changedCriteria(
  form: CriteriaForm,
  defaults: RetrievalCriteriaResponse | null,
): readonly CriterionKey[] {
  const base = criteriaFormOf(defaults);
  return CRITERION_KEYS.filter((key) =>
    CRITERION_FIELDS[key].some((field) => !sameValue(form[field], base[field])),
  );
}

/** 表单的八个框（顺序无语义，只用于逐框比较）。 */
const CRITERIA_FIELDS = Object.keys(EMPTY_CRITERIA_FORM) as readonly (keyof CriteriaForm)[];

/**
 * 两份表单等价吗 —— 抽屉副标题「未提交」的判据（草稿 ≠ 已提交）。复杂度 O(1)。
 * 逐框走 {@link sameValue}：定标差异不算改，与 {@link changedCriteria} 同一把尺子。
 */
export function sameCriteriaForm(a: CriteriaForm, b: CriteriaForm): boolean {
  return CRITERIA_FIELDS.every((field) => sameValue(a[field], b[field]));
}

/**
 * 成对维度的**半空归零**：DTE 段与活性任一端为空 ⇒ 整维回「不限」。复杂度 O(1)。
 *
 * 🚨 契约如此（`toRetrievalOverride` 里一端为空即整维 `null`），而**活性在语义上必须如此**：
 *    两支是「或」，任一支放到不限，整个维度就恒成立。
 * 🚨 归零 MUST **改回表单本身**（而不是只在提交时悄悄改）—— 否则框里留着一个 `365`
 *    而生效的是「不限」，那个不一致在界面上无从解释。
 * 📌 行权价**不**归零：上下界是两个独立维度，单边不限是合法值。
 */
export function normalizeCriteriaForm(form: CriteriaForm): CriteriaForm {
  const dteVoid = form.dteMin.trim() === '' || form.dteMax.trim() === '';
  const livenessVoid = form.oiMin.trim() === '' || form.volMin.trim() === '';
  return {
    ...form,
    dteMin: dteVoid ? '' : form.dteMin,
    dteMax: dteVoid ? '' : form.dteMax,
    oiMin: livenessVoid ? '' : form.oiMin,
    volMin: livenessVoid ? '' : form.volMin,
  };
}

// ═══════════════════ ④ 表单 → query 参数 ═══════════════════

/** 单个数值框 → 查询串。`''` = 覆盖为不限（原样下发）；非数字 → `null`（不下发该维）。O(1)。 */
function valueParam(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  return Number.isFinite(Number.parseFloat(trimmed)) ? trimmed : null;
}

/** 成对维度的两个框 → 两个查询串。任一端不合法 ⇒ 整维不下发（半对不是合法维度值）。O(1)。 */
function pairParams(a: string, b: string): readonly [string, string] | null {
  const left = valueParam(a);
  const right = valueParam(b);
  if (left === null || right === null) return null;
  // 半空归零已由 `normalizeCriteriaForm` 保证；这里再守一次，防调用方漏调。
  return left === '' || right === '' ? ['', ''] : [left, right];
}

/**
 * 表单 → 请求参数（FR-012）。未改任何一维 ⇒ `undefined`（= 首屏 / 「复位」）。复杂度 O(1)。
 *
 * 🚨 **只带改过的那几维**：缺键 = 未覆盖、空串 = 覆盖为不限（契约逐键判 `!== undefined`）。
 * 🚫 **系统默认值 MUST NOT 回传** —— 让客户端回传默认值就等于让它先算一份（FR-011）。
 * 🚨 **`perspective` 随参数同行**：覆盖只作用当前视角（T010 裁定）；给了条件不给视角 → 400。
 */
export function criteriaQueryParams(
  tab: LegPickerTab,
  form: CriteriaForm,
  defaults: RetrievalCriteriaResponse | null,
): OptionsdeskControllerLegsParams | undefined {
  const changed = changedCriteria(form, defaults);
  if (changed.length === 0) return undefined;
  const params: OptionsdeskControllerLegsParams = { perspective: tab };
  let sent = 0;
  for (const key of changed) {
    sent += applyCriterionParam(params, key, form) ? 1 : 0;
  }
  return sent === 0 ? undefined : params;
}

/** 把一个维度写进参数对象。返回是否真的写了（非法输入不写）。O(1)。 */
function applyCriterionParam(
  params: OptionsdeskControllerLegsParams,
  key: CriterionKey,
  form: CriteriaForm,
): boolean {
  switch (key) {
    case 'strikeMax':
    case 'strikeMin':
    case 'premiumMin': {
      const value = valueParam(form[key]);
      if (value === null) return false;
      params[key] = value;
      return true;
    }
    case 'dteBand': {
      const pair = pairParams(form.dteMin, form.dteMax);
      if (pair === null) return false;
      [params.dteMin, params.dteMax] = pair;
      return true;
    }
    case 'livenessMin': {
      const pair = pairParams(form.oiMin, form.volMin);
      if (pair === null) return false;
      [params.oiMin, params.volMin] = pair;
      return true;
    }
    case 'relativeSpreadMax': {
      const text = form.relativeSpreadMax.trim();
      if (text === '') {
        params.relativeSpreadMax = '';
        return true;
      }
      const ratio = percentToRatio(text);
      if (ratio === null) return false;
      params.relativeSpreadMax = ratio;
      return true;
    }
  }
}

// ═══════════════════ ⑤ 三态 → 计数行 / 徽标 ═══════════════════

/**
 * 三态里哪一态出计数（FR-029）。**穷举 `Record`** —— server 加一态而这里漏映射即编译红。
 *
 * 🚫 **放宽不出计数**：它不产生排除，显示出来是噪音。
 * 🚫 **未覆盖也不出**：系统默认值本身就摆在控件里，第二次告知同样是噪音。
 * 📌 运行时兜底：server 可能先于客户端上线新的一态 ⇒ 取不到就当「不出计数」，
 *    宁可少说一句，也不把一个读不懂的态渲成一行数字。
 */
const SHOWS_COUNT: Readonly<Record<string, boolean | undefined>> = {
  default: false,
  widened: false,
  narrowed: true,
};

/** 覆盖过的三态（徽标数用）—— 放宽也算覆盖：徽标数的是「动过几维」。 */
const IS_OVERRIDE: Readonly<Record<string, boolean | undefined>> = {
  default: false,
  widened: true,
  narrowed: true,
};

/** 计数行的维度名（穷举 `Record`，文案单源在 `optionsdesk-copy.ts`）。 */
const COUNT_LABEL: Readonly<Record<CriterionKey, string>> = {
  strikeMax: COPY.countLabels.strikeMax,
  strikeMin: COPY.countLabels.strikeMin,
  dteBand: COPY.countLabels.dteBand,
  premiumMin: COPY.countLabels.premiumMin,
  livenessMin: COPY.countLabels.livenessMin,
  relativeSpreadMax: COPY.countLabels.relativeSpreadMax,
};

/** 计数区的一行。`key` 同时是 testID 后缀（T013 e2e 的锚）。 */
export interface CriteriaCountLine {
  key: CriterionKey;
  text: string;
}

/**
 * 仅**收窄**维度的计数行（FR-029 / FR-030）。复杂度 O(1)（六维定长）。
 *
 * 🚨 措辞是「**当前条件之外**还有 N 条」——数的是**边际口径**（把这一维换回系统默认值、
 *    其余维保持用户值时多出来的候选数），🚫 MUST NOT 读成「被系统滤掉 N 条」。
 * 📌 收窄却一条都没排除 ⇒ 不出行：「之外还有 0 条」是句自相矛盾的话（契约上不该出现，
 *    这里守一道是因为它出现时**照样渲得出来**）。
 */
export function criteriaCountLines(
  criteria: PerspectiveCriteriaResponse | null,
): CriteriaCountLine[] {
  if (criteria === null) return [];
  return CRITERION_KEYS.filter((key) => {
    const outcome = criteria.outcomes[key];
    return SHOWS_COUNT[outcome.state] === true && outcome.excludedCount > 0;
  }).map((key) => ({
    key,
    text: COPY.countLine(COUNT_LABEL[key], criteria.outcomes[key].excludedCount),
  }));
}

/**
 * 入口徽标数 = **已覆盖维度数**（不是排除条数）。复杂度 O(1)。
 *
 * 🚨 取自服务端下发的三态而非客户端记忆：它是「服务端认为你覆盖了几维」的回执 ——
 *    客户端另记一份就是同一事实两处各一份，而两边都数得出数。
 */
export function criteriaOverrideCount(criteria: PerspectiveCriteriaResponse | null): number {
  if (criteria === null) return 0;
  return CRITERION_KEYS.filter((key) => IS_OVERRIDE[criteria.outcomes[key].state] === true).length;
}
