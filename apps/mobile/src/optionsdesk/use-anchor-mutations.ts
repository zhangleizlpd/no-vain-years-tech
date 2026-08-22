// 045 T022 — 锚写动作共置数据层：把「失效雷达 + 锚列表两个 query key」焊进 mutation 的
// `onSuccess`，调用方拿到的就是自带失效的 hook（范式同 ideation/use-session-mutations.ts）。
//
// 🚨 为什么必须两个 key 一起失效（mobile-impl-playbook § 8）：全局 `staleTime 30s` +
// bottom-tabs 常驻挂载（不 unmount ⇒ 不触发 refetchOnMount）+ `refetchOnWindowFocus:false`
// 三者叠加 ⇒ 列表一旦缓存就**没有任何触发器**自动重取。锚的每个写动作都同时改动这两处的
// list-visible 字段：建锚 / 删锚改行数；改 V / confidence / excluded / next_review 改雷达排序键、
// 区间徽标与逾期红标。漏一个 ⇒ 那一屏陈旧到 App 重启。
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getOptionsdeskControllerGetOneQueryKey,
  getOptionsdeskControllerListQueryKey,
  useOptionsdeskControllerCreate,
  useOptionsdeskControllerRemove,
  useOptionsdeskControllerReview,
  useOptionsdeskControllerUpdate,
} from '@nvy/api-client';

import { RADAR_QUERY_KEY } from './radar.rules';

/**
 * 失效锚列表 + 雷达（+ 可选的单条详情）。两个 list 工厂不带参调用 ⇒ 返回的是**前缀** key，
 * 带筛选参数的变体（`?pendingReview=` / `?excluded=` / 游标页）一并标脏。
 *
 * 🚨 `anchorId` 那一条不是锦上添花：锚表单屏的数据源是 `useOptionsdeskControllerGetOne`，
 * 它的 key 是 `/anchors/{id}` —— **不在**上面两个前缀下。漏掉它 ⇒ 三处人工位置值 / 撤销后
 * 表单屏读的还是旧快照，FR-032 ③ 与 FR-035 ②③ 要求的「回落同屏立即可见」直接不成立
 * （045 T025 hermetic e2e 实证：置人工值后标记不出现）。
 */
export function useInvalidateAnchorQueries() {
  const queryClient = useQueryClient();
  return useCallback(
    (anchorId?: string) => {
      void queryClient.invalidateQueries({ queryKey: getOptionsdeskControllerListQueryKey() });
      // 🚨 **雷达的 key 不能取 orval 工厂** —— 雷达那屏不用 orval hook（orval 不 emit
      //    useInfinite，`use-radar.ts` 自拼游标），它的 key 由 `radarQueryKey()` 铸造、前缀是
      //    `RADAR_QUERY_KEY`。orval 给的是 `['/api/v1/optionsdesk/radar']`，与之**无任何共同
      //    前缀**，而 react-query 的 invalidate 走前缀匹配 ⇒ 065 之前**任何锚的增删改都从未
      //    失效过雷达**（锚管理列表是好的，那屏确实用 orval hook；只有雷达是孤儿）。
      void queryClient.invalidateQueries({ queryKey: [...RADAR_QUERY_KEY] });
      if (anchorId !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: getOptionsdeskControllerGetOneQueryKey(anchorId),
        });
      }
    },
    [queryClient],
  );
}

/**
 * 建锚（成功即失效两处）。**替代直接用 `useOptionsdeskControllerCreate`**。
 * 只失效两个 list —— 建锚时还没有 id，没有「那一条详情」可刷。
 */
export function useCreateAnchor() {
  const invalidate = useInvalidateAnchorQueries();
  return useOptionsdeskControllerCreate({ mutation: { onSuccess: () => invalidate() } });
}

/** 改锚 —— 含三处人工位的设置 / 撤销（PATCH 传 `null` = 撤销）。连带失效被改那条的详情。 */
export function useUpdateAnchor() {
  const invalidate = useInvalidateAnchorQueries();
  return useOptionsdeskControllerUpdate({
    mutation: { onSuccess: (_data, variables) => invalidate(variables.id) },
  });
}

/**
 * 删锚（痕迹不随主行级联清除，FR-031；采集工作集下一轮移出）。
 * 只失效两个 list —— 详情行已不存在，刷它只会拿到 404。
 */
export function useDeleteAnchor() {
  const invalidate = useInvalidateAnchorQueries();
  return useOptionsdeskControllerRemove({ mutation: { onSuccess: () => invalidate() } });
}

/** 复审（推进 next_review、解除逾期红标与复核锚红标 —— 无第二个确认动作，FR-013）。 */
export function useReviewAnchor() {
  const invalidate = useInvalidateAnchorQueries();
  return useOptionsdeskControllerReview({
    mutation: { onSuccess: (_data, variables) => invalidate(variables.id) },
  });
}
