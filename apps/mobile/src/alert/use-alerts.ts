import { useCallback, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  type AlertListResponse,
  type AlertResponse,
  type CreateAlertsRequest,
  getAlertsControllerListAllQueryKey,
  getAlertsControllerListForInstrumentQueryKey,
  type UpdateAlertRequest,
  useAlertsControllerCreateBatch,
  useAlertsControllerDeleteBatch,
  useAlertsControllerListAll,
  useAlertsControllerListForInstrument,
  useAlertsControllerUpdate,
} from '@nvy/api-client';
import type { AxiosResponse } from 'axios';

import { extractProblemDetail } from '~/core/api/errors';
import { ALERT_COPY } from './alert-copy';

// 预警 CRUD hook（021 T016，013 use-watchlist-items 范式）。包 orval EP1/EP2 query +
// EP3/EP4/EP5 mutation：toggle 乐观更新（EP1+EP2 双 cache patch）+ 失败回弹；
// 编辑/批量建/批量删走响应后失效（表单提交无乐观必要）。错误分流 toast（400 校验 /
// 404 反枚举 / 429 限流 / 网络）。纯函数（alertErrorToast / applyToggleOptimistic /
// groupAlertsByInstrument / noteCodePointCount）vitest；hook 编排走 Playwright +
// contract-smoke（per mono 测试分层）。

type ListRes = AxiosResponse<AlertListResponse>;

/** 备注上限（plan D10：Unicode code point 计，与 server rules 同口径）。 */
export const NOTE_MAX_CODE_POINTS = 22;

/** code point 计数（`[...s].length` — surrogate pair 算 1，与 server 同式）。 */
export function noteCodePointCount(s: string): number {
  return [...s].length;
}

/** 操作失败 toast 分流。 */
export function alertErrorToast(error: unknown): string {
  const p = extractProblemDetail(error);
  if (p?.code === 'FORM_VALIDATION') return ALERT_COPY.errorToast.validation;
  if (p?.code === 'ALERT_NOT_FOUND') return ALERT_COPY.errorToast.notFound;
  if (p?.code === 'RATE_LIMIT_EXCEEDED') return ALERT_COPY.errorToast.rateLimit;
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError && e.response?.status === 429) return ALERT_COPY.errorToast.rateLimit;
  return ALERT_COPY.errorToast.network;
}

/** 乐观启停 patch（不可变；EP1/EP2 cache 同形状共用）。 */
export function applyToggleOptimistic(prev: ListRes, alertId: string, enabled: boolean): ListRes {
  return {
    ...prev,
    data: {
      ...prev.data,
      alerts: prev.data.alerts.map((a) => (a.id === alertId ? { ...a, enabled } : a)),
    },
  };
}

export interface InstrumentAlertsGroup {
  market: string;
  code: string;
  alerts: AlertResponse[];
}

/** 屏 5 分组（EP2 平铺 → 按 market:code 聚组，组序 = 首见序）。 */
export function groupAlertsByInstrument(alerts: AlertResponse[]): InstrumentAlertsGroup[] {
  const byKey = new Map<string, InstrumentAlertsGroup>();
  for (const a of alerts) {
    const key = `${a.market}:${a.code}`;
    const group = byKey.get(key);
    if (group) group.alerts.push(a);
    else byKey.set(key, { market: a.market, code: a.code, alerts: [a] });
  }
  return [...byKey.values()];
}

export type AlertsStatus = 'loading' | 'error' | 'ready';

const statusOf = (q: { isPending: boolean; isError: boolean }): AlertsStatus =>
  q.isPending ? 'loading' : q.isError ? 'error' : 'ready';

/** EP1 个股预警列表（屏 1）。 */
export function useInstrumentAlerts(market: string, code: string) {
  const query = useAlertsControllerListForInstrument(market, code);
  return {
    alerts: query.data?.data.alerts ?? [],
    status: statusOf(query),
    refetch: query.refetch,
  };
}

/** EP2 全账号预警（屏 5，分组归 client）。 */
export function useAllAlerts() {
  const query = useAlertsControllerListAll();
  const alerts = query.data?.data.alerts ?? [];
  return {
    alerts,
    groups: groupAlertsByInstrument(alerts),
    status: statusOf(query),
    /** 列表 fetch 进行中（编辑屏 seed gate：等 refetch 落定再 seed，避免陈旧基线）。 */
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}

/** 标的引用（失效/乐观 patch 的 cache 定位键）。 */
type InstrumentRef = Pick<AlertResponse, 'market' | 'code'>;

/**
 * 写操作集（EP3/EP4/EP5）。EP1 per-instrument 与 EP2 all 双 cache：
 * toggle 双 patch + 失败回弹；其余成功后失效（all + 受影响标的）。
 */
export function useAlertMutations() {
  const queryClient = useQueryClient();
  const createMutation = useAlertsControllerCreateBatch();
  const updateMutation = useAlertsControllerUpdate();
  const deleteMutation = useAlertsControllerDeleteBatch();
  const [errorToast, setErrorToast] = useState<string | null>(null);

  const invalidate = useCallback(
    (refs: InstrumentRef[]) => {
      void queryClient.invalidateQueries({ queryKey: getAlertsControllerListAllQueryKey() });
      for (const ref of refs) {
        void queryClient.invalidateQueries({
          queryKey: getAlertsControllerListForInstrumentQueryKey(ref.market, ref.code),
        });
      }
    },
    [queryClient],
  );

  /** EP3 批量建（D5 原子：任一校验失败整体 400）。 */
  const createAlerts = useCallback(
    async (data: CreateAlertsRequest) => {
      setErrorToast(null);
      try {
        const res = await createMutation.mutateAsync({ data });
        invalidate(data.instruments);
        return res.data;
      } catch (e) {
        setErrorToast(alertErrorToast(e));
        throw e;
      }
    },
    [createMutation, invalidate],
  );

  /** EP4 编辑（conditions 全量替换 + frequency/note/enabled；表单提交无乐观）。 */
  const updateAlert = useCallback(
    async (alert: InstrumentRef & { id: string }, data: UpdateAlertRequest) => {
      setErrorToast(null);
      try {
        const res = await updateMutation.mutateAsync({ id: alert.id, data });
        invalidate([alert]);
        return res.data;
      } catch (e) {
        setErrorToast(alertErrorToast(e));
        throw e;
      }
    },
    [updateMutation, invalidate],
  );

  /** EP4 启停（卡片 toggle）：EP1+EP2 双 cache 乐观 patch，失败回弹。 */
  const toggleAlert = useCallback(
    async (alert: InstrumentRef & { id: string }, enabled: boolean) => {
      setErrorToast(null);
      const keys: QueryKey[] = [
        getAlertsControllerListAllQueryKey(),
        getAlertsControllerListForInstrumentQueryKey(alert.market, alert.code),
      ];
      const snapshots = keys.map((k) => [k, queryClient.getQueryData<ListRes>(k)] as const);
      for (const [k, prev] of snapshots) {
        if (prev) queryClient.setQueryData(k, applyToggleOptimistic(prev, alert.id, enabled));
      }
      try {
        await updateMutation.mutateAsync({ id: alert.id, data: { enabled } });
        invalidate([alert]);
      } catch (e) {
        for (const [k, prev] of snapshots) {
          if (prev) queryClient.setQueryData(k, prev);
        }
        setErrorToast(alertErrorToast(e));
        throw e;
      }
    },
    [updateMutation, queryClient, invalidate],
  );

  /** EP5 批量删（仅删本账号命中项；refs = 受影响标的，供 cache 失效）。 */
  const deleteAlerts = useCallback(
    async (ids: string[], refs: InstrumentRef[]) => {
      setErrorToast(null);
      try {
        const res = await deleteMutation.mutateAsync({ data: { ids } });
        invalidate(refs);
        return res.data;
      } catch (e) {
        setErrorToast(alertErrorToast(e));
        throw e;
      }
    },
    [deleteMutation, invalidate],
  );

  const clearErrorToast = useCallback(() => setErrorToast(null), []);

  return { createAlerts, updateAlert, toggleAlert, deleteAlerts, errorToast, clearErrorToast };
}
