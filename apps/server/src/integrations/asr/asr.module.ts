import { Module } from '@nestjs/common';

/**
 * integrations/asr — 平台层 ASR (语音转写) vendor I/O 适配器 (ADR-0058 第三位租户,
 * 紧随 llm/codeindex;035 语音输入 B2-2)。
 *
 * **非 bounded context**: 无 Prisma schema / 无 moat owner / 无业务域 —— 像 security/ 与
 * integrations/llm 一样被业务 ctx **单向 import** 的基础设施层 (ideation 现在)。依赖方向:
 * 业务 ctx → 可 import integrations;integrations **禁** import 任何业务 ctx (ESLint
 * boundaries `integrations` 元素强制叶子方向,apps/server/eslint.config.mjs 已配 src/integrations/**)。
 *
 * **本 module 形状 (与 llm.module 同,与 codeindex.module 异)**: ASR 像 llm 一样**不绑默认**
 * `ASR_PROVIDER` —— 仅 re-export provider 类 + 端口 token + DTO 类型,让**消费 ctx (ideation)
 * 自己声明 useFactory** (按 asrConfig.kind 选 dashscope/fake)。理由同 llm:把 provider 选择
 * 留在消费方,平台层不渗 env 语义;且 IT 经 `.overrideProvider(ASR_PROVIDER)` 注 FakeAsrProvider
 * 驱动 state_branches (per plan「NO LIFECYCLE MOCKING」)。
 *
 * provider 类无需在此 module 的 `providers` 数组声明 (普通 class,消费方 useFactory 内
 * `new XxxProvider(cfg)` 直接构造,非经 DI 解析) —— 本 module 当前为 re-export 锚 + 未来若有
 * 平台级共享 ASR 设施 (如统一限流/观测包装) 的挂载点。
 */

export { ASR_PROVIDER } from './asr-provider.port.js';
export type { AsrProvider, AsrTranscribeOneShotOptions } from './asr-provider.port.js';
export { DashscopeAsrProvider } from './dashscope-asr.provider.js';
export { FakeAsrProvider, type FakeAsrConfig } from './fake-asr.provider.js';

@Module({})
export class AsrModule {}
