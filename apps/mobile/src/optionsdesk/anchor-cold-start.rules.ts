// 072 T021 — 冷启动结局面板的纯判定（FR-009 / US5 / sb-17, sb-18）。
//
// 🚨 只 import type（`@nvy/api-client` 的运行时入口在 mobile vitest 下解析不到）。
import type { AnchorColdStartRunResponse } from '@nvy/api-client';

/**
 * 进度：**缺席不是失败**（sb-18）。
 *
 * 🚨 服务端查不到的 anchorId **不会出现**在结局列表里，而这有语义 —— 十档结局全是终态，
 * 没出结局 = 还在队列里排着或正在跑（worker concurrency=1，分钟级串行）。
 * MUST NOT 把缺席算成失败，也 MUST NOT 期待服务端补一个占位结局。
 */
export interface ColdStartProgress {
  /** 本批锚数（问了几个）。 */
  total: number;
  /** 已出终态的（回了几个）。 */
  settled: number;
  /** 还在排队 / 正在跑的（差额，**不是失败数**）。 */
  pending: number;
}

export function coldStartProgress(
  anchorIds: readonly string[],
  runs: readonly Pick<AnchorColdStartRunResponse, 'anchorId'>[],
): ColdStartProgress {
  const settledIds = new Set(runs.map((r) => r.anchorId));
  // 只数**本批问过的**那些 —— 服务端多回一条（不该发生）不会把 settled 顶过 total。
  const settled = anchorIds.filter((id) => settledIds.has(id)).length;
  return { total: anchorIds.length, settled, pending: anchorIds.length - settled };
}

/**
 * 分组：需人工介入的置顶。
 *
 * 🚨 分档判据**只看服务端下发的 `needsAttention`**（判据单点在 server 的
 * `anchor-cold-start.rules.ts`，与那十个值同处一点）。呈现层 MUST NOT 自己抄一份结局名单 ——
 * 抄了等第 11 个结局落地必漂，而漂的表现是**某个永久缺口在界面上悄悄降级成「已完成」**。
 */
export function groupColdStartRuns<T extends Pick<AnchorColdStartRunResponse, 'needsAttention'>>(
  runs: readonly T[],
): { attention: T[]; done: T[] } {
  return {
    attention: runs.filter((r) => r.needsAttention),
    done: runs.filter((r) => !r.needsAttention),
  };
}

/** 从待审箱的 CONSUMED 行里取出「采纳落成的锚」——冷启动结局按这批 id 查。 */
export function consumedAnchorIds(
  items: readonly { consumedAnchorId: string | null }[],
  limit: number,
): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.consumedAnchorId !== null && !ids.includes(item.consumedAnchorId)) {
      ids.push(item.consumedAnchorId);
      if (ids.length >= limit) break;
    }
  }
  return ids;
}
