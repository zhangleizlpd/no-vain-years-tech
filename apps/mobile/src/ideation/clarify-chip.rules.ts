// 032 T015 — chip 点选纯逻辑（无 RN import，per 测试分层 vitest=logic）。
// 契约 §4.5（2026-06-22 翻转）：chip 点选 = quick-reply **直接发送**该值成一轮；逃生项不发、
// 转聚焦输入条自填（由屏侧据 escapeHatch 分流，本函数只算「要发什么」）。
import type { SuggestionOption } from './ideation-sse-parse';

/**
 * chip 点选 → 发送值（内容项即发此值；逃生项屏侧短路不调用本函数，此处仍返空作兜底）。
 * - 逃生项（「都不是 / 自己说」）：返回空串（屏侧不发、改聚焦输入）。
 * - 有 `fill`（「采纳整段推荐」类 chip，label 短、fill 装完整正文）：用 fill 原文。
 * - 推荐项：剥离内嵌「（推荐）」/「(推荐)」UI 装饰标记（推荐文案不该进回答）。
 * - 普通项：原样回 label。
 */
export function chipFillValue(opt: SuggestionOption): string {
  if (opt.escapeHatch) return '';
  if (opt.fill !== undefined && opt.fill.length > 0) return opt.fill;
  return stripRecommended(opt.label);
}

/** 剥「（推荐）」/「(推荐)」（全/半角）UI 装饰。 */
function stripRecommended(label: string): string {
  return label.replace(/（推荐）|\(推荐\)/g, '').trim();
}

/**
 * chip 显示 / 无障碍用的**干净 label**：剥掉 label 内的「（推荐）」装饰。「（推荐）」由渲染层
 * 据 `recommended` 单独追加单次——防御存量数据（旧落库 label 曾内嵌「（推荐）」）与前端叠成
 * 「（推荐）（推荐）」（2026-06-22）。
 */
export function chipDisplayLabel(opt: SuggestionOption): string {
  return stripRecommended(opt.label);
}
