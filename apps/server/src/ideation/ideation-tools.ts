/**
 * Ideation 工具定义 (032 T006, 契约 doc §3.1 / §4.4) —— 两相驱动剧本喂给 LLM 的
 * function-calling 工具 schema (OpenAI 兼容形状, 与 `integrations/llm` 的 `ToolDef`
 * 对齐, provider 透传)。无状态纯常量 (无 DB / 无 Nest DI)。
 *
 * 三工具 + 两相菜单切换 (契约 doc §3.1):
 * - **相 A 访谈** (auto/required): `[CODEINDEX_RETRIEVAL_TOOL, ASK_CLARIFYING_QUESTION_TOOL]`。
 *     - `codeindex_retrieval` —— 本期 **stub** (schema 在, UC 侧返空 / 不入访谈菜单,
 *       ADR-0059 / FR-011)；S3 接真索引服务时 adapter drop-in、剧本零改。
 *     - `ask_clarifying_question` —— 出 `{question, options[], multi_select, allow_freetext}`
 *       (chips 两闸 + 逃生项归一化在 `suggestion-gate.rules.ts`)。
 * - **相 B 产出** (forced): `[EMIT_REQUIREMENTS_BRIEF_TOOL]`。
 *     - `emit_requirements_brief` —— 参数 = brief.schema **T1 五段 required** (复用
 *       `T1_SEGMENT_KEYS`)；T2/T3 段为 optional (非阻塞 / 自适应)。访谈期不给此工具,
 *       产出期强制 (`tool_choice:'required'` on M3) → 保证拿到结构化 brief。
 *
 * 形状刻意宽松 (`parameters` 任意对象, 与 openai SDK `ChatCompletionTool` 对齐)；
 * 强约束 (T1 五段齐 / 类型) 由 mono 侧 `briefSchema` (zod) 在 emit 后校验, 不依赖
 * vendor 强制 `response_format: json_schema` (DS 不支持, 契约 doc §5)。
 */
import type { ToolDef } from '../integrations/llm/llm-provider.port.js';
import type { CodeChunk } from '../integrations/codeindex/code-index.port.js';
import { T1_SEGMENT_KEYS, T2_SEGMENT_KEYS, T3_SEGMENT_KEYS } from './brief.schema.js';
import { MAX_SSE_SOURCES, type SseSourceRef } from './ideation-sse.rules.js';

/** 工具名常量 (UC 编排 / IT / fake provider 共享, 避免字符串散落)。 */
export const TOOL_CODEINDEX_RETRIEVAL = 'codeindex_retrieval';
export const TOOL_ASK_CLARIFYING_QUESTION = 'ask_clarifying_question';
export const TOOL_EMIT_REQUIREMENTS_BRIEF = 'emit_requirements_brief';

/**
 * 接地工具 (本期 stub, ADR-0059 / FR-011)。schema 定义在但 UC 侧返空 / 不入访谈菜单;
 * S3 接真索引服务时换 adapter, 访谈剧本零改动。按 `idea_session.repo` 锁命名空间检索。
 */
export const CODEINDEX_RETRIEVAL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: TOOL_CODEINDEX_RETRIEVAL,
    description:
      'Retrieve relevant code chunks from the bound repository to ground the clarification ' +
      '(STUB this phase: returns empty, not offered in the interview menu; S3 wires a real index).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language search over the bound repo (code/screens/APIs/tables).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

/**
 * 澄清提问工具 (相 A 访谈步, 契约 doc §4.4)。模型出一个澄清问题 + 可选 chips:
 * `options` 空 = 纯文本 (两闸未过, §4.1); 非空 = chips (含推荐项标注, 归一化在 rules)。
 * `multi_select` 单选(默认)/多选 (§4.5); `allow_freetext` 自由输入永驻 (恒应为 true)。
 */
export const ASK_CLARIFYING_QUESTION_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: TOOL_ASK_CLARIFYING_QUESTION,
    description:
      'Ask the user ONE clarifying question to converge requirements. Provide options[] ONLY when ' +
      'the answer space is enumerable (≤4 stable options) AND you have a defensible recommendation; ' +
      'otherwise leave options empty for a free-text question. Never offer options on the first question.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The clarifying question text.' },
        options: {
          type: 'array',
          description: 'Suggestion chips (empty = free-text only). Mark the recommended one.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              recommended: { type: 'boolean' },
              fill: {
                type: 'string',
                description:
                  'Text inserted into the input box when the user taps this chip (defaults to ' +
                  'label if omitted). Use for "adopt whole recommendation" chips: keep label short ' +
                  '(e.g. "采纳（可再改）") and put the full submittable answer in fill.',
              },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
        multi_select: { type: 'boolean', description: 'true = multi-select chips.' },
        allow_freetext: {
          type: 'boolean',
          description: 'Free-text input always live (should be true).',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
};

/** brief 段落 JSON 字段 → 工具参数 property (每段自由文本 string, 复用 brief.schema key 清单)。 */
function segmentProperty(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

/**
 * brief 产出工具 (相 B 产出, 契约 doc §3.1 / §4.4)。参数 = brief.schema 全 3 层段落:
 * **T1 五段 `required`** (收敛硬门, 复用 `T1_SEGMENT_KEYS`); T2 接地段 + T3 可选段
 * 为 optional (非阻塞 / 自适应)。强约束最终由 mono `briefSchema` (zod) 校验。
 */
export const EMIT_REQUIREMENTS_BRIEF_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: TOOL_EMIT_REQUIREMENTS_BRIEF,
    description:
      'Emit the converged requirements brief as structured JSON. T1 (problem, user_stories, ' +
      'functional_requirements, success_criteria, non_goals) are REQUIRED (the convergence gate ' +
      'checks only these 5). T2 grounding + T3 optional segments fill when available.',
    parameters: {
      type: 'object',
      properties: {
        // T1 核心必填 (收敛硬门)
        problem: segmentProperty('Motivation / problem statement.'),
        user_stories: segmentProperty('P1/P2/P3 stories with Given-When-Then acceptance criteria.'),
        functional_requirements: segmentProperty('FR-NNN functional requirements.'),
        success_criteria: segmentProperty('Measurable success criteria.'),
        non_goals: segmentProperty('Explicit out-of-scope / non-goals.'),
        // T2 接地段 (optional·非阻塞)
        affected_surface: segmentProperty('Modules/screens/APIs/tables affected (grounding).'),
        constraints_guardrails: segmentProperty(
          'Unbreakable constraints / guardrails (grounding).',
        ),
        data_model_sketch: segmentProperty('Data model sketch (grounding).'),
        api_contract_sketch: segmentProperty('API contract sketch (grounding).'),
        // T3 可选段 (optional·自适应)
        edge_cases: segmentProperty('Edge cases.'),
        nfr: segmentProperty('Non-functional requirements (latency/offline/a11y).'),
        ui_notes: segmentProperty('UI notes.'),
        open_questions: segmentProperty('[NEEDS CLARIFICATION] open questions.'),
        phase_boundary: segmentProperty('Phase boundary / scope slicing.'),
      },
      required: [...T1_SEGMENT_KEYS],
      additionalProperties: false,
    },
  },
};

/**
 * 相 A 访谈菜单 —— **条件注册** (034 FR-007, plan §Architecture Notes #3)。
 * 按 `session.repo` 派生喂给 LLM 的工具集:
 * - repo **非空** (已选代码库) → `[CODEINDEX_RETRIEVAL_TOOL, ASK_...]` (检索工具在菜单, 模型可发起接地)。
 * - repo **空/null/纯空白** (未选仓) → `[ASK_...]` (**不把 codeindex_retrieval 给 LLM** ——
 *   未选仓时模型根本拿不到检索工具, 不会尝试不可用工具)。
 * 纯函数, 无 DB / side effect。复杂度 O(1)。
 */
export function interviewToolsFor(repo: string | null): ToolDef[] {
  const hasRepo = repo != null && repo.trim().length > 0;
  return hasRepo
    ? [CODEINDEX_RETRIEVAL_TOOL, ASK_CLARIFYING_QUESTION_TOOL]
    : [ASK_CLARIFYING_QUESTION_TOOL];
}

/**
 * 来源映射 (034 FR-002): 接地命中 `CodeChunk[]` → SSE `sources` 帧 DTO `SseSourceRef[]`。
 * 只取**出处坐标** `{relPath, startLine, endLine, symbol?}` (丢弃 kind/score/text);
 * `symbol` 为 null → 省略该键 (与 `toSseSourcesFrame` 一致, 形状复用 `SseSourceRef`,
 * 不重复定义)。**截断 ≤5** (`MAX_SSE_SOURCES`, 与 sources 帧上限一致)。纯函数, O(min(n,5))。
 */
export function toSourceRefs(hits: readonly CodeChunk[]): SseSourceRef[] {
  return hits.slice(0, MAX_SSE_SOURCES).map((h) => {
    const ref: SseSourceRef = {
      relPath: h.relPath,
      startLine: h.startLine,
      endLine: h.endLine,
    };
    if (h.symbol != null) ref.symbol = h.symbol;
    return ref;
  });
}

/** 相 B 产出菜单 (仅 emit, forced)。 */
export const PRODUCE_PHASE_TOOLS: ToolDef[] = [EMIT_REQUIREMENTS_BRIEF_TOOL];

/** 全工具 schema 导出 (供 IT / 文档断言)。 */
export const IDEATION_TOOLS: ToolDef[] = [
  CODEINDEX_RETRIEVAL_TOOL,
  ASK_CLARIFYING_QUESTION_TOOL,
  EMIT_REQUIREMENTS_BRIEF_TOOL,
];

// 防止未使用告警 (T2/T3 key 清单当前仅用于文档化段落, 段落 property 已逐一列出)。
void T2_SEGMENT_KEYS;
void T3_SEGMENT_KEYS;
