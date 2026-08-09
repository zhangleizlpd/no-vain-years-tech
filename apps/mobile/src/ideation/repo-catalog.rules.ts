// 034 T009 — 选择代码库纯逻辑（catalog 行视图：状态映射穷举 + meta 行装配）。
// 无 IO / 无 render（per 测试分层 vitest=logic）。列表 render / 选中交互 → RepoPickerSheet（UI）。
//
// 状态映射用 `Record<RepoCatalogEntryResponseStatus, RepoStatusMeta>` **穷举**——吃生成的
// status 联合（ready | indexing），漏成员编译红（per mobile-impl-playbook enum→copy Record）。
// ⚠️ 只 `import type`（erased）：`@nvy/api-client` 运行时 entry 在 vitest 不可解析（dist 仅 .d.ts），
// 故 Record 键用字面量 'ready'/'indexing'，穷举性由 type 约束保证（漏键编译红，typecheck 拦）。
import type { RepoCatalogEntryResponse, RepoCatalogEntryResponseStatus } from '@nvy/api-client';

import { IDEATION_COPY } from './ideation-copy';
import { relativeUpdatedAt } from './session-list.rules';

/** catalog 单项（orval 生成 DTO 透传；本模块只读不重塑）。 */
export type RepoCatalogEntry = RepoCatalogEntryResponse;

/** 仓库状态展示元数据（Record 穷举；点色 / 文案 / 是否可选）。 */
export interface RepoStatusMeta {
  /** 状态点 className（复用既有 token，0 新增配色）。 */
  dotClass: string;
  /** 状态文案 + a11y。 */
  label: string;
  /** 可否选中（indexing 置灰不可选，FR-005）。 */
  selectable: boolean;
}

/**
 * 状态 → 展示元数据，**穷举** ready/indexing（`Record` 非 `Partial<Record>`，漏 enum 成员
 * 编译红）。点色复用既有 token：ready=ok（绿）/ indexing=warn（橙）。
 */
export const REPO_STATUS_META: Record<RepoCatalogEntryResponseStatus, RepoStatusMeta> = {
  ready: {
    dotClass: 'bg-ok',
    label: IDEATION_COPY.repoStatusReady,
    selectable: true,
  },
  indexing: {
    dotClass: 'bg-warn',
    label: IDEATION_COPY.repoStatusIndexing,
    selectable: false,
  },
};

/**
 * 装配 repo 行 meta 文案：ready → 「<相对索引时间> · <chunk 数> 块」；indexing → 「索引中」。
 * 相对时间复用 session-list.rules.relativeUpdatedAt（畸形 ISO 回退「刚刚」，不崩）。
 *
 * @param entry catalog 单项。
 * @param now   当前时刻（相对时间基准；测试可注入定值）。
 */
export function buildRepoMetaLine(entry: RepoCatalogEntry, now: string | Date): string {
  if (entry.status === 'indexing') {
    return IDEATION_COPY.repoStatusIndexing;
  }
  return `${relativeUpdatedAt(entry.indexedAt, now)} · ${entry.chunkCount} 块`;
}
