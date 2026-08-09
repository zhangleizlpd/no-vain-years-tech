/**
 * Ideation brief 契约 schema —— `requirements_draft` 的结构化 JSON 真相源
 * (契约 doc §2 / D4，无状态纯 schema，无 DB / 无 Nest DI)。
 *
 * 段落分三层 (契约 doc §2)：
 * - T1 核心必填 (澄清·硬门)：problem / user_stories / functional_requirements
 *   / success_criteria / non_goals —— 收敛门 (`brief-gate.rules.ts`) 只查这 5 段齐。
 * - T2 接地段 (读仓才能填·非阻塞)：affected_surface / constraints_guardrails
 *   / data_model_sketch / api_contract_sketch —— B1 stub 期留空 / 手填，S3 点亮自动填。
 *   **收敛门绝不含 T2** (D5 / FR-011 / SC-007)。
 * - T3 可选段 (澄清·随规模自适应)：edge_cases / nfr / ui_notes / open_questions
 *   / phase_boundary —— 小改全跳。
 *
 * 字段形状决策：契约 doc §2 只给「段落 = JSON 字段」+ 内容提示 (user_stories 含
 * P1/P2/P3 + GWT AC、functional_requirements 含 FR-NNN)，未写死 string vs 结构化数组。
 * 按 SDD「doc 没写死取最简」(string / string[])：每段建模为 **自由文本 string**
 * (markdown 友好，渲染零拆解；编号/GWT 由内容自带)。T2/T3 全 optional。
 */
import { z } from 'zod';

/** T1 核心必填段落 key (收敛门 SoT —— `brief-gate.rules.ts` import 此清单)。 */
export const T1_SEGMENT_KEYS = [
  'problem',
  'user_stories',
  'functional_requirements',
  'success_criteria',
  'non_goals',
] as const;

export type T1SegmentKey = (typeof T1_SEGMENT_KEYS)[number];

/** T2 接地段 key (读仓才能填·非阻塞，B1 stub 期留空)。 */
export const T2_SEGMENT_KEYS = [
  'affected_surface',
  'constraints_guardrails',
  'data_model_sketch',
  'api_contract_sketch',
] as const;

/** T3 可选段 key (随规模自适应)。 */
export const T3_SEGMENT_KEYS = [
  'edge_cases',
  'nfr',
  'ui_notes',
  'open_questions',
  'phase_boundary',
] as const;

/** 非空段落内容：trim 后至少 1 字符 (空白 string 视为「未填」，由收敛门拦)。 */
const segment = z.string().trim().min(1);

/**
 * Brief 契约 zod schema。
 * - T1 五段 **必填** (`segment` 非空)。
 * - T2 / T3 段 **optional** (省略 / undefined 皆合法)；提供时同样要求非空 string。
 *
 * 注：T1 必填只保证「字段存在且非空 string」；跨字段「五段齐」语义收口在
 * `isConverged` (brief-gate.rules.ts) —— schema 层用 `.partial()` 衍生不出
 * 「门只查 T1」的语义，故收敛判定独立成纯函数。
 */
export const briefSchema = z.object({
  // T1 核心必填
  problem: segment,
  user_stories: segment,
  functional_requirements: segment,
  success_criteria: segment,
  non_goals: segment,
  // T2 接地段 (optional·非阻塞)
  affected_surface: segment.optional(),
  constraints_guardrails: segment.optional(),
  data_model_sketch: segment.optional(),
  api_contract_sketch: segment.optional(),
  // T3 可选段 (optional·自适应)
  edge_cases: segment.optional(),
  nfr: segment.optional(),
  ui_notes: segment.optional(),
  open_questions: segment.optional(),
  phase_boundary: segment.optional(),
});

/** 校验通过的 brief 结构化 JSON (落 `requirements_draft.briefJson`)。 */
export type Brief = z.infer<typeof briefSchema>;
