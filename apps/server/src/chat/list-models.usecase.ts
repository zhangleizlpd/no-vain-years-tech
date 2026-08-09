import { Injectable } from '@nestjs/common';

/**
 * 模型元数据 UC (029 T001, plan D2 / FR-005) — chat 叶子 ctx, 常量派生, **无 DB / 无 repository**。
 *
 * 多 provider: DeepSeek 双模式 (flash/pro) + MiniMax M3 (minimax, 029 收口接入)。清单由
 * server 常量派生 (不建表, 避免过度设计) 驱动客户端选择器渲染; 接新 provider 仅改本常量
 * (客户端零改动, 跨契约 §2.2 解耦)。客户端内置同款默认作降级 (端点失败不阻塞, FR-012)。
 *
 * model id (`flash` / `pro` / `minimax`) 是**逻辑模型名**, 与 mobile 选择器 + chat
 * 会话 `conversation.model` 列 + send-message 路由 (T003) 三处严格一致; provider 边界
 * (RoutingLlmProvider) 再把逻辑名路由到真实 vendor: flash/pro → DeepSeek v4 双模式,
 * minimax → MiniMax-M3。`available:false` 项 (若有) 仅留位呈现, 不可选 (前端 disabled),
 * 也是会话 model 写值域校验的拒绝集 (非 available 项 → 400)。
 *
 * 复杂度: O(1) 返回不可变常量副本 (无 I/O)。
 */

/** 可选模型元数据 (非持久化实体; 驱动客户端选择器渲染)。 */
export interface ModelMeta {
  /** 逻辑模型 id (flash | pro | minimax); 与 conversation.model + mobile 选择器一致。 */
  id: string;
  /** 选择器展示名。 */
  label: string;
  /** 选择器副标题/描述。 */
  description: string;
  /** 是否可用 (true = 可选; false = 留位 disabled, 不可选无副作用)。 */
  available: boolean;
}

export interface ListModelsResult {
  models: ModelMeta[];
}

/**
 * 模型清单 (常量派生, plan D2)。flash/pro (DeepSeek 双模式) + minimax (MiniMax M3) 均可用。
 * ⚠️ id 命名锁定 — 与 mobile 选择器 + RoutingLlmProvider 路由一致。
 */
export const CHAT_MODELS: readonly ModelMeta[] = [
  { id: 'flash', label: '快速', description: '响应迅速，适合日常问答', available: true },
  { id: 'pro', label: '思考', description: '深度推理，适合复杂问题', available: true },
  { id: 'minimax', label: 'MiniMax', description: '海螺 M3，长上下文通用', available: true },
];

/** 可用 (会话 model 写允许) 的逻辑模型 id 集 — 派生自 CHAT_MODELS available 项 (T002 值域校验单源)。 */
export const AVAILABLE_MODEL_IDS: readonly string[] = CHAT_MODELS.filter((m) => m.available).map(
  (m) => m.id,
);

/**
 * 新建会话默认逻辑 model (029 D7, clarify 定稿): flash (快速) — 响应快/成本低,
 * 通用助手首选。亦作 send-message 路由的 legacy/未知值兜底 (单源)。
 */
export const DEFAULT_CHAT_MODEL = 'flash';

@Injectable()
export class ListModelsUseCase {
  /** 返回常量清单的浅拷贝 (防调用方意外 mutate 共享常量)。 */
  execute(): ListModelsResult {
    return { models: CHAT_MODELS.map((m) => ({ ...m })) };
  }
}
