// 032 T016 — brief 预览屏的纯渲染数据准备（无 RN import，per 测试分层 vitest=logic）。
// 契约 §2：brief = 结构化 JSON（段落 = key → 自由文本 string），**渲染分段而非 markdown 源码**。
//   - T1 五段：全渲（problem / user_stories / functional_requirements / success_criteria
//     / non_goals；GWT 验收 + FR 编号在内容字符串里，渲染零拆解）。
//   - T2 接地段：本期 stub 留空 → 灰色虚线**非阻塞占位**（非报错），有内容才正常渲。
//   - T3 可选段：空则整段跳（小颗粒自适应），有内容淡化渲。
//
// briefJson 来自 orval（`{ [key: string]: unknown }`，宽松）；本层把它收敛成有序段视图。

/** 会话状态（穷举，徽标 Record 用）。orval status 是宽松 string；映射时落 'open' 兜底。 */
export type IdeationSessionStatus = 'open' | 'converged' | 'handed-off';

/** 状态徽标元数据（Record 穷举，漏 enum 成员编译红，per mobile-impl-playbook enum→copy）。 */
export interface StatusBadgeMeta {
  /** 徽标中文文案。 */
  label: string;
  /** 语义色 tone（屏据此选 class，0 新 token）。 */
  tone: 'brand' | 'muted';
}

export const STATUS_BADGE_META: Record<IdeationSessionStatus, StatusBadgeMeta> = {
  open: { label: '进行中', tone: 'muted' },
  converged: { label: '已收敛', tone: 'brand' },
  'handed-off': { label: '已交接', tone: 'muted' },
};

/** 把宽松 status string 收敛到枚举（未知 → 'open' 兜底）。 */
export function normalizeStatus(status: string): IdeationSessionStatus {
  if (status === 'converged' || status === 'handed-off') return status;
  return 'open';
}

/** 段落分层 key（与 server brief.schema T1/T2/T3 一致）。 */
export const T1_SEGMENT_KEYS = [
  'problem',
  'user_stories',
  'functional_requirements',
  'success_criteria',
  'non_goals',
] as const;

export const T2_SEGMENT_KEYS = [
  'affected_surface',
  'constraints_guardrails',
  'data_model_sketch',
  'api_contract_sketch',
] as const;

export const T3_SEGMENT_KEYS = [
  'edge_cases',
  'nfr',
  'ui_notes',
  'open_questions',
  'phase_boundary',
] as const;

export type BriefSegmentKey =
  | (typeof T1_SEGMENT_KEYS)[number]
  | (typeof T2_SEGMENT_KEYS)[number]
  | (typeof T3_SEGMENT_KEYS)[number];

/** 段落中文标题（编号 + 名，穷举所有 key）。 */
export const SEGMENT_TITLE: Record<BriefSegmentKey, string> = {
  problem: '问题动机',
  user_stories: '用户故事 + 验收标准',
  functional_requirements: '功能需求',
  success_criteria: '成功标准',
  non_goals: '非目标',
  affected_surface: '影响面',
  constraints_guardrails: '约束护栏',
  data_model_sketch: '数据模型草图',
  api_contract_sketch: 'API 契约草图',
  edge_cases: '边界情况',
  nfr: '非功能需求',
  ui_notes: 'UI 备注',
  open_questions: '开放问题',
  phase_boundary: '阶段边界',
};

/** 渲染层级（决定视觉：T1 实卡 / T2 虚线占位非阻塞 / T3 淡化）。 */
export type SegmentTier = 't1' | 't2' | 't3';

/** 一个待渲染段视图。content 非空 → 正常渲；T2 空 → 占位（非报错）；T3 空 → 不入列表。 */
export interface BriefSegmentView {
  key: BriefSegmentKey;
  title: string;
  tier: SegmentTier;
  /** trim 后内容；空串表示「未填」。 */
  content: string;
  /** T2 空段 → true（渲灰虚线占位，非阻塞）。 */
  isPlaceholder: boolean;
}

/** 从 briefJson 取某 key 的 trim 字符串（非 string / null → 空串）。 */
function readSegment(briefJson: Record<string, unknown>, key: string): string {
  const v = briefJson[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 把 briefJson 收敛成有序段视图列表（渲染层直接 map）。
 * - T1 五段：恒入列（缺/空也渲，理论上收敛门保证齐；防御性留空内容标占位）。
 * - T2 接地段：恒入列（空 → isPlaceholder，渲灰虚线非阻塞占位，per FR-011 / SC-007）。
 * - T3 可选段：仅有内容才入列（空则整段跳，小颗粒自适应）。
 */
export function buildBriefSegments(briefJson: Record<string, unknown>): BriefSegmentView[] {
  const views: BriefSegmentView[] = [];

  for (const key of T1_SEGMENT_KEYS) {
    const content = readSegment(briefJson, key);
    views.push({ key, title: SEGMENT_TITLE[key], tier: 't1', content, isPlaceholder: false });
  }
  for (const key of T2_SEGMENT_KEYS) {
    const content = readSegment(briefJson, key);
    views.push({
      key,
      title: SEGMENT_TITLE[key],
      tier: 't2',
      content,
      isPlaceholder: content.length === 0,
    });
  }
  for (const key of T3_SEGMENT_KEYS) {
    const content = readSegment(briefJson, key);
    if (content.length === 0) continue; // 空 T3 段整段跳。
    views.push({ key, title: SEGMENT_TITLE[key], tier: 't3', content, isPlaceholder: false });
  }

  return views;
}
