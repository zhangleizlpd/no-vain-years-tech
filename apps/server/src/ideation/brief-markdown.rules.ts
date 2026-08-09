/**
 * Brief 结构化 JSON → markdown 渲染 —— 无状态纯函数 (per ADR-0043 §2，无 DB / 无 LLM)。
 *
 * 渲染规则 (契约 doc §2.2 / D4)：JSON 为真相源，markdown 为导出视图。
 * - **T1 五段全渲** (核心必填，恒有内容)。
 * - **T2 接地段空 → 渲占位行「_本期留空/手填_」**(非报错，接地 stub 非阻塞；S3 点亮后填真内容)。
 * - **T3 可选段有内容才渲**(空则整段跳过，小颗粒需求自适应)。
 *
 * 入参复用 T003 `brief.schema` 推导类型 (`Brief`)；渲染前假定已过 zod (T1 齐)。
 * 导出态 (export-brief.usecase) 调本函数 → 返 markdown 粘进 `/speckit-specify`。
 */
import { type Brief } from './brief.schema';

/** T2 空段占位行 (契约 doc §2.2)。 */
export const T2_PLACEHOLDER = '_本期留空/手填_';

/** 段落渲染元数据：JSON key → markdown 标题 + 所属层。 */
interface SegmentMeta {
  key: keyof Brief;
  heading: string;
}

/** T1 核心必填段 (全渲，按契约 doc §2 顺序)。 */
const T1_SEGMENTS: SegmentMeta[] = [
  { key: 'problem', heading: '问题 / 动机' },
  { key: 'user_stories', heading: '用户故事 (User Stories)' },
  { key: 'functional_requirements', heading: '功能需求 (Functional Requirements)' },
  { key: 'success_criteria', heading: '成功标准 (Success Criteria)' },
  { key: 'non_goals', heading: '非目标 (Non-Goals)' },
];

/** T2 接地段 (空渲占位行)。 */
const T2_SEGMENTS: SegmentMeta[] = [
  { key: 'affected_surface', heading: '影响面 (Affected Surface)' },
  { key: 'constraints_guardrails', heading: '约束 / 护栏 (Constraints & Guardrails)' },
  { key: 'data_model_sketch', heading: '数据模型草图 (Data Model Sketch)' },
  { key: 'api_contract_sketch', heading: 'API 契约草图 (API Contract Sketch)' },
];

/** T3 可选段 (有内容才渲)。 */
const T3_SEGMENTS: SegmentMeta[] = [
  { key: 'edge_cases', heading: '边界情况 (Edge Cases)' },
  { key: 'nfr', heading: '非功能需求 (NFR)' },
  { key: 'ui_notes', heading: 'UI 备注 (UI Notes)' },
  { key: 'open_questions', heading: '待澄清 (Open Questions)' },
  { key: 'phase_boundary', heading: '阶段边界 (Phase Boundary)' },
];

/** 取段内容：非空 string 返 trim 后内容，否则 null (未填)。 */
function content(brief: Brief, key: keyof Brief): string | null {
  const value = brief[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 渲染 brief JSON → markdown 字符串 (契约 doc §2.2)。
 *
 * 段落分层处理：
 * - T1：恒渲标题 + 内容 (zod 已保证非空)。
 * - T2：渲标题；有内容渲内容，空渲占位行 `_本期留空/手填_` (非报错)。
 * - T3：仅当有内容时渲标题 + 内容；空则整段跳过。
 *
 * 段间空一行；整体往返稳定 (同一 JSON → 同一 markdown)。
 * 复杂度 O(s)，s = 段总数 (常量 14)。
 */
export function renderBriefMarkdown(brief: Brief): string {
  const blocks: string[] = [];

  // T1：全渲。
  for (const seg of T1_SEGMENTS) {
    const body = content(brief, seg.key);
    blocks.push(`## ${seg.heading}\n\n${body ?? ''}`);
  }

  // T2：渲标题，空段渲占位行 (非阻塞)。
  for (const seg of T2_SEGMENTS) {
    const body = content(brief, seg.key);
    blocks.push(`## ${seg.heading}\n\n${body ?? T2_PLACEHOLDER}`);
  }

  // T3：有内容才整段渲，空则跳过。
  for (const seg of T3_SEGMENTS) {
    const body = content(brief, seg.key);
    if (body !== null) {
      blocks.push(`## ${seg.heading}\n\n${body}`);
    }
  }

  // 段间双换行 + 末尾换行 (稳定输出)。
  return blocks.join('\n\n') + '\n';
}
