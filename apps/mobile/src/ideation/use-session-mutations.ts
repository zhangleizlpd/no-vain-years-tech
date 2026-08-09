// GOLDEN SAMPLE — 数据层 mutation + 缓存失效（mobile）。索引见 docs/conventions/golden-sample-registry.md，
// discipline 详版见 docs/conventions/mobile-impl-playbook.md § 8。
//
// 会话 mutation 共置数据层 —— 把「失效会话列表」焊进 mutation 的 onSuccess，调用方拿到的就是
// 自带失效的 hook，从源头杜绝「各屏各自记得失效」的漏。
//
// 这个文件存在的根因（务必读）：列表屏（灵感 tab）首访后**常驻挂载**（bottom-tabs 不 unmount），
// 叠加全局 `staleTime 30s` + `refetchOnWindowFocus:false`（query-client.ts）→ 列表一旦缓存就**没有
// 任何触发器**会自动重取。于是凡改 list-visible 字段（title / status / updatedAt）的 mutation 若不
// 显式失效列表，列表会陈旧到 App 重启。create 曾因失效逻辑散在 form 屏漏写 → 列表永久陈旧（实证：
// 新建多模态 PRD 后列表空）；converge 同盲区（状态徽标停在「进行中」）。
//
// 范式同构 chat/use-conversations.ts（数据 hook 自持 list + mutation + 共置 invalidate）；差别是这里
// 用 orval mutation 的 `onSuccess` 选项把失效**焊死在 hook 内**，比"调用方 await 后手动调"更难漏。
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getSessionControllerListQueryKey,
  useBriefControllerGenerate,
  useSessionControllerCreate,
} from '@nvy/api-client';

/**
 * 失效会话列表 query。凡改 list-visible 字段（title / status / updatedAt）的 mutation/事件必调，
 * 否则列表常驻挂载不自动重取 → 陈旧到重启。导出为共享原语：本文件 create / generateBrief wrapper
 * 内部复用 + SSE turn（非 mutation、无法走 onSuccess 选项）在 use-ideation-session startStream
 * done/aborted 终态手动调用（与 chat onDone → invalidateConversations 同范式）。
 */
export function useInvalidateSessionList() {
  const queryClient = useQueryClient();
  return useCallback(
    () => void queryClient.invalidateQueries({ queryKey: getSessionControllerListQueryKey() }),
    [queryClient],
  );
}

/** 建会话（成功即失效列表 → 新会话即时入列）。**替代直接用 `useSessionControllerCreate`**。 */
export function useCreateSession() {
  const invalidateList = useInvalidateSessionList();
  return useSessionControllerCreate({ mutation: { onSuccess: invalidateList } });
}

/**
 * 生成 brief / 收敛（成功即失效列表 → 状态徽标「进行中」→「已收敛」即时回显）。
 * **替代直接用 `useBriefControllerGenerate`**。详情 query 的失效仍由调用方（use-ideation-session）
 * 负责（detail-specific，与 list 失效正交）。
 */
export function useGenerateBrief() {
  const invalidateList = useInvalidateSessionList();
  return useBriefControllerGenerate({ mutation: { onSuccess: invalidateList } });
}
