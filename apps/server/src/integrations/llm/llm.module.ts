import { Module } from '@nestjs/common';

/**
 * integrations/llm — 平台层 LLM vendor I/O 适配器家 (ADR-0058 首位租户, 058 B1 PR-1)。
 *
 * **非 bounded context**: 无 Prisma schema / 无 moat owner / 无业务域 —— 像 security/ 一样
 * 被业务 ctx **单向 import** 的基础设施层 (chat 现在 / ideation+pkm 后续, 三 ctx 单一 vendor
 * 维护点)。依赖方向: 业务 ctx + security → 可 import integrations; integrations **禁** import
 * 任何业务 ctx (ESLint boundaries `integrations` 元素强制叶子方向)。
 *
 * **本 module 形状 (058 决策)**: **不**提供默认 `LLM_PROVIDER` 绑定 —— 仅 re-export provider
 * 类 + 端口 token + wire-format 类型, 让**各消费 ctx 自己声明 useFactory**。理由: chat 与
 * ideation 的 fake 开关 env 不同 (chat = `CHAT_FAKE_LLM`, ideation 后续 = 自有开关) 且各自
 * 注入自己 ConfigModule 的 deepseek/minimax config; 集中默认绑定反而会把 chat 的 env 语义
 * 渗进平台层。各 ctx import 本 module (拿 provider 类) + 自建 `{ provide: LLM_PROVIDER, useFactory }`。
 *
 * provider 类无需在此 module 的 `providers` 数组声明 (它们是普通 class, 各 ctx useFactory 内
 * `new XxxProvider(cfg)` 直接构造, 非经 DI 解析) —— 本 module 当前为 re-export 锚 + 未来若有
 * 平台级共享 LLM 设施 (如统一限流/可观测包装) 的挂载点。
 */
export { LLM_PROVIDER } from './llm-provider.port.js';
export type {
  LlmProvider,
  LlmStreamEvent,
  LlmStreamOptions,
  ToolDef,
  Msg,
  ToolCall,
} from './llm-provider.port.js';
export { DeepseekProvider } from './deepseek.provider.js';
export { MinimaxProvider } from './minimax.provider.js';
export { RoutingLlmProvider } from './llm-router.provider.js';
export { FakeLlmProvider } from './fake-llm.provider.js';

@Module({})
export class LlmModule {}
