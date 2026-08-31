import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getAnchorSubmissionControllerGetOneQueryKey,
  getAnchorSubmissionControllerListQueryKey,
  getOptionsdeskControllerListQueryKey,
  getOptionsdeskControllerRadarQueryKey,
  useAnchorSubmissionControllerApprove,
  useAnchorSubmissionControllerGetOne,
  useAnchorSubmissionControllerList,
  useAnchorSubmissionControllerReject,
  type AnchorSubmissionDetailResponse,
  type AnchorSubmissionReviewResponse,
  type ApproveAnchorSubmissionRequest,
  type ApproveAnchorSubmissionResponse,
  type RejectAnchorSubmissionsResponse,
} from '@nvy/api-client';

// 072 T018 — 待审箱读侧 + 批量驳回（FR-001 / FR-007）。
//
// 不分页：server 全量返回 + 硬上限 + `truncated`（分页会让「采纳第 3 行」使第 2 页在审阅者
// 脚下平移）。故市场筛选一律在前端切，不打网络。

export type SubmissionsStatus = 'loading' | 'error' | 'ready';

export interface AnchorSubmissionsView {
  items: AnchorSubmissionReviewResponse[];
  total: number;
  /** 触到单次上限被截断 —— 呈现层 MUST 显式告诉用户（「屏上就这些」≠「只有这些」）。 */
  truncated: boolean;
  status: SubmissionsStatus;
  refetch: () => void;
}

/**
 * 072 T020 — 处置一条待审后**该失效哪些缓存**的单一处（SC-004 / US4）。
 *
 * 采纳与驳回共用它，理由不是「代码复用」而是**判据只此一处**：一条待审被处置后，屏上会
 * 陈旧的不止待审箱自己 —— 采纳会落锚，锚列表与击球区雷达都在读那张表。少失效一处的表现
 * 是「要重启 App 才看得到」，而那正是 SC-004 要根除的东西；散在两个 mutation 里迟早分叉。
 *
 * 🚨 传的是**前缀键**（不带 params）—— react-query 按前缀匹配，故所有筛选变体一并失效。
 * 只失效「当前那组 params」的话，切一下 chip 就能看到旧数据。
 *
 * ⚠️ 驳回不写锚，按说只需失效待审箱；这里仍然一起失效，代价是一次多余的读、收益是
 * 「处置后该刷什么」不因动作不同而分叉。真要按动作细分，得先有一个能证伪它的测试。
 */
export function useInvalidateAnchorQueries() {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getAnchorSubmissionControllerListQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getOptionsdeskControllerListQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getOptionsdeskControllerRadarQueryKey() }),
    ]);
  }, [queryClient]);
}

/** 待审箱列表（缺省 status=PENDING，即待审箱本身）。 */
export function useAnchorSubmissions(): AnchorSubmissionsView {
  const query = useAnchorSubmissionControllerList();
  return {
    items: query.data?.data.items ?? [],
    total: query.data?.data.total ?? 0,
    truncated: query.data?.data.truncated ?? false,
    status: (query.isPending ? 'loading' : query.isError ? 'error' : 'ready') as SubmissionsStatus,
    refetch: () => void query.refetch(),
  };
}

/**
 * 批量驳回。返回**整个** `{ rejected, skipped }` 交给调用方呈现 ——
 * 🚨 MUST NOT 在这里折成一句 ok（FR-007）：`skipped` 里的行是在别的设备上、或被
 * `anchor-approve.sh` 处置掉的，人必须知道有行在自己脚下动过。
 *
 * 只解构 `mutateAsync`（引用稳定）：整个 mutation 结果对象每次 render 新 identity，
 * 进依赖数组会自激重入（见 alert/use-alert-messages.ts 那条真机实证）。
 */
export function useRejectAnchorSubmissions() {
  const invalidate = useInvalidateAnchorQueries();
  const { mutateAsync } = useAnchorSubmissionControllerReject();

  return useCallback(
    async (
      ids: readonly string[],
      reviewNote?: string,
    ): Promise<RejectAnchorSubmissionsResponse> => {
      const res = await mutateAsync({
        data: { ids: [...ids], ...(reviewNote ? { reviewNote } : {}) },
      });
      // 驳回改的是列表可见字段（status）⇒ 必失效，否则列表陈旧到重启
      // （staleTime + tab 常驻不重挂 + refetchOnWindowFocus:false，无触发器重取）。
      await invalidate();
      return res.data;
    },
    [mutateAsync, invalidate],
  );
}

/** 待审详情（比列表多 `fallbackPreview` 与 `willBeNoop` —— 采纳前预览，FR-002）。 */
export function useAnchorSubmissionDetail(id: string): {
  detail: AnchorSubmissionDetailResponse | null;
  status: SubmissionsStatus;
  refetch: () => void;
} {
  const query = useAnchorSubmissionControllerGetOne(id);
  return {
    detail: query.data?.data ?? null,
    status: (query.isPending ? 'loading' : query.isError ? 'error' : 'ready') as SubmissionsStatus,
    refetch: () => void query.refetch(),
  };
}

/**
 * 采纳（FR-003：经 `ImportAnchorFromModelUseCase` 落锚，客户端只是发起方）。
 *
 * 🚨 **不吞 409**：口径日闸（ASOF_SUSPECT）与「已被处置过」都靠 throw 传给调用方，
 * 由屏上的三出口对话框接手。在这里 catch 掉等于把 fail-closed 闸变成静默放行。
 */
export function useApproveAnchorSubmission(id: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAnchorQueries();
  const { mutateAsync } = useAnchorSubmissionControllerApprove();

  return useCallback(
    async (data: ApproveAnchorSubmissionRequest): Promise<ApproveAnchorSubmissionResponse> => {
      const res = await mutateAsync({ id, data });
      // 采纳落锚 ⇒ 待审箱 + 锚列表 + 雷达一起失效（判据在 useInvalidateAnchorQueries）；
      // 本条详情另失效，否则退回来还看得见刚被处置掉的那份预览。
      await invalidate();
      await queryClient.invalidateQueries({
        queryKey: getAnchorSubmissionControllerGetOneQueryKey(id),
      });
      return res.data;
    },
    [id, mutateAsync, invalidate, queryClient],
  );
}
