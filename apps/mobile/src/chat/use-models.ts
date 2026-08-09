// 029 T006 — 模型清单 hook（顶栏下拉数据源）。
//
// 职责：接 orval `GET /chat/models` typed hook（服务端常量派生 flash/pro/minimax 均可用），
// 驱动顶栏下拉渲染。
//
// 设计取舍（干净上下文须知）：
// - **端点失败 / loading / 空清单 → 降级内置默认**（DEFAULT_MODELS：flash/pro 均可用，
//   FR-012）：模型元数据是「锦上添花」，端点不可用绝不阻塞对话，故任何非正常态都回落
//   内置默认，下拉始终有 flash/pro 可切。
// - **available 标记透传**给下拉：可用项可选，留位项（若有，`available:false`）→ 下拉
//   渲染 disabled（点击无副作用），由 popover 据此置灰。本 hook 不做过滤删除（保留
//   留位项展示「即将上线」），只透传 available 供 UI 置灰。
// - **纯逻辑**（resolveModels / DEFAULT_MODELS）抽出 vitest 覆盖；hook 编排（useQuery /
//   render）走 Playwright + contract-smoke（per 测试分层 vitest=logic·Playwright=UI）。
import { useMemo } from 'react';
import {
  type ModelListResponse,
  type ModelMetaResponse,
  useConversationControllerListAvailableModels,
} from '@nvy/api-client';

/**
 * 内置默认模型清单（端点不可用降级源，FR-012）。
 *
 * 与服务端常量派生（plan D2）保持同款 flash/pro/minimax，均 available —— 端点失败时仍保证
 * 用户能在三模型间切换（minimax 029 收口接入，已 GA 故入降级清单）。
 */
export const DEFAULT_MODELS: readonly ModelMetaResponse[] = [
  { id: 'flash', label: '快速', description: '响应快、成本低，通用助手首选', available: true },
  { id: 'pro', label: '思考', description: '深度推理，复杂问题更稳', available: true },
  { id: 'minimax', label: 'MiniMax', description: '海螺 M3，长上下文通用', available: true },
] as const;

/**
 * 把端点响应解析为下拉渲染清单：正常清单直出，异常态（无数据 / 空清单）降级内置默认。
 *
 * @param data    端点响应（undefined = 尚未返回 / 失败）。
 * @param isLoading 查询进行中（首屏尚无数据）。
 * @param isError  查询失败（端点不可用，FR-012）。
 * @returns 供下拉渲染的模型清单（available 透传供 UI 置灰）。复杂度 O(1)（仅引用选择）。
 */
export function resolveModels(
  data: ModelListResponse | undefined,
  isLoading: boolean,
  isError: boolean,
): readonly ModelMetaResponse[] {
  // 失败 / loading / 无数据 / 空清单 → 一律降级内置默认（不阻塞、不白屏、不给空下拉）。
  if (isError || isLoading || !data || data.models.length === 0) {
    return DEFAULT_MODELS;
  }
  return data.models;
}

export interface UseModelsResult {
  /** 下拉渲染清单（available 透传：可用项可选 / 留位项 disabled）。 */
  models: readonly ModelMetaResponse[];
  isLoading: boolean;
  isError: boolean;
}

/** 模型清单 hook：拉端点元数据 + 异常降级内置默认（FR-012）。 */
export function useModels(): UseModelsResult {
  const query = useConversationControllerListAvailableModels();
  const models = useMemo(
    () => resolveModels(query.data?.data, query.isLoading, query.isError),
    [query.data, query.isLoading, query.isError],
  );
  return { models, isLoading: query.isLoading, isError: query.isError };
}
