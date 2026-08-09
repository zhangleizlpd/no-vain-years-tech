/**
 * 澄清问题 chips 两道闸 + 归一化 —— 无状态纯函数 (per ADR-0043 §2，无 DB / 无 LLM)。
 *
 * 决策源 = 契约 doc §4 (D7 / FR-004 / US3)：
 * - §4.1 两道闸：① 答案空间可枚举 (≤4 稳定选项) ② AI 有可辩护推荐；**两闸同过且非第一问**
 *   才给 chips，否则纯自由文本。第一问永不给 chips (§4.6 反锚定头号手段)。
 * - §4.5 数量/逃生：chips 2-4 个 (≤3 内容 + 1「都不是/自己填」逃生)；末位永远逃生项；自由输入永驻。
 * - §4.2/§4.6 推荐项：排首位 + **不预选**；「（推荐）」由前端渲染装饰（落库 label 干净，剥内嵌「（推荐）」防与前端叠加）。
 *
 * 这些函数只决定「给不给 / 给哪些」，渲染 (可点 chips vs 纯文本) 在前端；
 * 优雅降级 (§4.3) 由调用方按 `shouldOfferChips` 结果决定走 chips 还是纯文本。
 */

/** chips 内容项数量上限 (含逃生项)，超出选择瘫痪 (契约 doc §4.5)。 */
export const MAX_CHIPS = 4;
/** chips 总项数下限 (1 内容 + 1 逃生才有意义)；不足则不值得做 chips。 */
export const MIN_CHIPS = 2;
/** 末位逃生项文案 (契约 doc §4.5「都不是/自己填」)。 */
export const ESCAPE_HATCH_LABEL = '都不是/自己填';
/** 推荐项内嵌标注 (契约 doc §4.2，create-next-app / AskUserQuestion 同款)。 */
export const RECOMMENDED_SUFFIX = '（推荐）';

/** 两道闸输入：当前轮序 + 模型自决的两闸判定 (契约 doc §4.1)。 */
export interface ChipsGateInput {
  /** 0-based 轮序；0 = 第一问 (反锚定，永不给 chips)。 */
  turnIndex: number;
  /** 闸一：答案空间可枚举 (≤4 稳定选项)。 */
  enumerable: boolean;
  /** 闸二：AI 有可辩护推荐 (行业惯例 / 最佳实践)。 */
  defensibleRec: boolean;
}

/**
 * 两道闸判定：仅当**两闸同过且非第一问**才给 chips (契约 doc §4.1 / §4.6)。
 *
 * - 第一问 (turnIndex === 0) → 永远 false (反锚定，让用户先插自己旗)。
 * - 闸一挂 (开放问题，答案空间无界) → false。
 * - 闸二挂 (无可辩护默认) → false (给 chips = 制造假等价，逼用户瞎二选一)。
 *
 * 复杂度 O(1)。
 */
export function shouldOfferChips(input: ChipsGateInput): boolean {
  if (input.turnIndex <= 0) return false; // 第一问 (及防御性负数) 永不给
  return input.enumerable && input.defensibleRec;
}

/** 模型 emit 的单个原始选项 (归一化前)。 */
export interface RawSuggestionOption {
  label: string;
  /** 是否为推荐项 (闸二命中的那项)；归一化后排首 + 加标注。 */
  recommended?: boolean;
  /**
   * 点选该 chip 填入输入框的正文 (契约 doc §4.5)。缺省 → 用 label。用于「采纳整段推荐」类
   * chip: label 短 (如「采纳(可再改)」), fill 装完整可提交正文 (如整段成功标准), 二者解耦。
   */
  fill?: string;
}

/** 模型 emit 的原始 suggestion (归一化前)。 */
export interface RawSuggestion {
  question: string;
  options?: RawSuggestionOption[];
  /** 单选 (默认) vs 多选 (契约 doc §4.5)。 */
  multi_select?: boolean;
  /** 自由输入框是否开放；逃生口永驻，归一化恒为 true (契约 doc §4.5)。 */
  allow_freetext?: boolean;
}

/** 归一化后的选项 (落 idea_turn.suggestion)。 */
export interface NormalizedOption {
  label: string;
  recommended: boolean;
  /** 末位逃生项标记 (前端可特殊渲染)。 */
  escapeHatch: boolean;
  /** 点选填入草稿的正文 (缺省 → 用 label, 见 RawSuggestionOption.fill)；仅与 label 不同时落。 */
  fill?: string;
}

/** 归一化后的 suggestion (落库形态)。 */
export interface NormalizedSuggestion {
  question: string;
  options: NormalizedOption[];
  multi_select: boolean;
  /** 恒 true —— 自由输入永驻 (契约 doc §4.5 禁用=弃用率飙)。 */
  allow_freetext: true;
}

/**
 * 归一化模型原始 suggestion → 落库形态 (契约 doc §4.2 / §4.5 / §4.6)：
 * ① 推荐项排首位 + 标签内嵌「（推荐）」(去重已有标注，幂等)；
 * ② 内容项钳到 MAX_CHIPS-1 (留 1 位给逃生项 → 总数 ≤ MAX_CHIPS)；
 * ③ 末位永远补「都不是/自己填」逃生项；
 * ④ **不预选** (无 selected 字段 / 全 recommended 仅作呈现，不等于预选)；
 * ⑤ allow_freetext 恒 true (自由输入永驻)。
 *
 * 注：仅含 1 个内容项时仍渲 (1 内容 + 1 逃生 = MIN_CHIPS=2，合法)。
 * 调用方应先用 `shouldOfferChips` 决定是否走 chips；本函数假定已决定要给。
 *
 * 复杂度 O(n)，n = 原始选项数 (一次排序 + 一次 map)。
 */
export function normalizeSuggestion(raw: RawSuggestion): NormalizedSuggestion {
  const rawOptions = raw.options ?? [];

  // ① 稳定排序：推荐项提前 (Array.prototype.sort 在 V8 稳定，同级保序)。
  const sorted = [...rawOptions].sort(
    (a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)),
  );

  // ② 钳内容项数：留 1 位给末位逃生项。
  const contentBudget = MAX_CHIPS - 1;
  const clamped = sorted.slice(0, contentBudget);

  const contentOptions: NormalizedOption[] = clamped.map((opt) => {
    const recommended = Boolean(opt.recommended);
    // label 落库**保持干净**：剥掉模型可能内嵌的「（推荐）」——「（推荐）」是纯前端渲染装饰
    // (Chip 据 recommended 追加单次)，落库 label 含它会与前端叠成「（推荐）（推荐）」(2026-06-22 修)。
    const cleanLabel = stripRecommendedSuffix(opt.label);
    return {
      label: cleanLabel,
      recommended,
      escapeHatch: false,
      // fill 仅在与 (干净) label 不同 (模型显式给了正文) 时透传落库；缺省由前端回落 label。
      ...(opt.fill !== undefined && opt.fill !== cleanLabel ? { fill: opt.fill } : {}),
    };
  });

  // ③ 末位补逃生项 (不标推荐、不预选)。
  const escapeOption: NormalizedOption = {
    label: ESCAPE_HATCH_LABEL,
    recommended: false,
    escapeHatch: true,
  };

  return {
    question: raw.question,
    options: [...contentOptions, escapeOption],
    multi_select: Boolean(raw.multi_select),
    allow_freetext: true,
  };
}

/** 剥掉 label 内嵌的「（推荐）」/「(推荐)」(全/半角)。「（推荐）」由前端渲染装饰，落库 label 保持干净。 */
function stripRecommendedSuffix(label: string): string {
  return label.replace(/（推荐）|\(推荐\)/g, '').trim();
}
