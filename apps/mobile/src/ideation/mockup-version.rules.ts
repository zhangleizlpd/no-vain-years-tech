// 037 T014 [US2] — 多版切换条纯逻辑（无 RN import，per 测试分层 vitest=logic）。
//
// server append-only 多版（createdAt desc 派生 versionRank，最新 = 1）。本层把读列表 items 收敛成
// **倒序**（latest 在前）chip 视图模型 + 默认选中（latest）+ 交付日期格式化 + 版本标签，供 MockupVersionStrip
// 渲染层零再加工。选中态切换只换 renderer uri + 屏标签行（fetch-on-open，不重拉，FR-006 + Clarification Q1/Q2）。
//
// 排序口径与 use-session-mockups.selectLatestMockup 同源：versionRank 1 = latest。server 已倒序，本层
// 防御性按 versionRank 升序兜底（latest=1 在前），near-sorted 下近 O(n)。

import type { SessionMockupResponse } from './use-session-mockups';

/** 一枚版本 chip 视图模型（渲染层直接 map，无再加工）。 */
export interface VersionChipView {
  /** mockup 记录 id（选中态唯一键 + 切 renderer 用）。 */
  id: string;
  /** 版本序（server 派生，latest = 1）。 */
  versionRank: number;
  /** 是否最新版（默认选中、带「最新」标识）。 */
  isLatest: boolean;
  /** chip 主标签（最新 → 「最新」；历史 → 「v{N}」）。 */
  label: string;
  /** 交付日期标识（chip 副标签，本地 YYYY-MM-DD）。 */
  deliveredAt: string;
}

/**
 * 把读列表 items 收敛成**倒序** chip 视图（latest 在前）。
 *
 * 复杂度 O(n log n)：一次稳定 sort（versionRank 升序，latest=1 在首）+ 单遍 map，n = 版本数。
 * server 已 createdAt 倒序（versionRank 升序），本 sort 仅防御偶发乱序（near-sorted 近 O(n)）。
 */
export function prepareVersionStrip(items: readonly SessionMockupResponse[]): VersionChipView[] {
  return [...items]
    .sort((a, b) => a.versionRank - b.versionRank)
    .map((m) => ({
      id: m.id,
      versionRank: m.versionRank,
      isLatest: m.versionRank === 1,
      label: versionRankLabel(m.versionRank),
      deliveredAt: formatDeliveredAt(m.createdAt),
    }));
}

/**
 * 版本标签：latest（rank 1）→ 「最新」；历史版 → 「v{N}」（N = versionRank）。纯函数。
 * 非正整数 rank 兜底「v?」（防御脏数据；正常 server 派生恒 ≥ 1 整数）。
 */
export function versionRankLabel(rank: number): string {
  if (rank === 1) return '最新';
  if (!Number.isInteger(rank) || rank < 1) return 'v?';
  return `v${rank}`;
}

/**
 * 交付日期格式化（chip 副标签）：ISO-8601 → 本地 `YYYY-MM-DD`。非法串兜底空串（渲染层省略副标签）。
 * 仅日期粒度（chip 空间有限，时分见详情非本期）；与 session-list.relativeUpdatedAt 的绝对日期分支同口径。
 */
export function formatDeliveredAt(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 默认选中版 id = 最新版（versionRank 1）。空列表 → null。
 * 复用 versionRank 1 派生（与 selectLatestMockup 同源）；无 rank 1 命中退回首元素（server 已倒序兜底）。
 */
export function selectDefaultVersionId(items: readonly SessionMockupResponse[]): string | null {
  if (items.length === 0) return null;
  const latest = items.find((m) => m.versionRank === 1) ?? items[0];
  return latest?.id ?? null;
}

/**
 * 据选中 id 取该版记录（切 renderer uri + 屏标签行用）。未命中（id 失效 / 列表变更）→ 退回最新版
 * （防选中态悬空成空白屏）；空列表 → null。
 */
export function selectMockupById(
  items: readonly SessionMockupResponse[],
  id: string | null,
): SessionMockupResponse | null {
  if (items.length === 0) return null;
  if (id !== null) {
    const hit = items.find((m) => m.id === id);
    if (hit) return hit;
  }
  return items.find((m) => m.versionRank === 1) ?? items[0] ?? null;
}
