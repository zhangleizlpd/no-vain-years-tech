import { Module } from '@nestjs/common';
import { codeIndexConfig, type CodeIndexConfig } from '../../config/index.js';
import { CODE_INDEX, type CodeIndexProvider } from './code-index.port.js';
import { HttpCodeIndexProvider } from './http-code-index.provider.js';
import { FakeCodeIndexProvider } from './fake-code-index.provider.js';

/**
 * integrations/codeindex — 平台层 code-index vendor I/O 适配器 (ADR-0058 第二位租户，
 * 紧随 llm；034 grounding S3)。
 *
 * **非 bounded context**: 无 Prisma schema / 无 moat owner / 无业务域 —— 像 security/ 与
 * integrations/llm 一样被业务 ctx **单向 import** 的基础设施层 (ideation 现在；pkm 后续)。
 * 依赖方向: 业务 ctx → 可 import integrations；integrations **禁** import 任何业务 ctx
 * (ESLint boundaries `integrations` 元素强制叶子方向，eslint.config.mjs 已配)。
 *
 * **本 module 形状 (与 llm.module 的差异)**: llm 因 chat/ideation 各有自己的 fake 开关 env
 * (CHAT_FAKE_LLM vs IDEATION_FAKE_LLM) 不绑默认，让各 ctx 自声明 useFactory。codeindex 只有
 * **单一** fake/http toggle (`CODE_INDEX_PROVIDER`，归 codeIndexConfig 出生地)，故本 module
 * **集中**提供 `CODE_INDEX` 绑定 + export —— ideation 只需 `imports: [CodeIndexModule]` 即可
 * 注入 `CODE_INDEX` 端口，无需重复 env 选 provider 逻辑。
 *
 * provider 选择 (同 llm-router 按 model 委托范式，此处按 config.kind 选实现):
 * - `CODE_INDEX_PROVIDER=http` → HttpCodeIndexProvider (Node 内置 fetch 打 services/code-index)。
 * - 默认 (`fake` / 未设)        → FakeCodeIndexProvider (确定性命中替身，IT/契约冒烟无需真 URL)。
 *
 * IT 仍可经 DI `.overrideProvider(CODE_INDEX)` 注定制 FakeCodeIndexProvider 驱动 state_branches
 * (per plan「NO LIFECYCLE MOCKING」)。
 *
 * ⚠️ 本 module 依赖 SecurityModule export 的 ConfigModule (含 codeIndexConfig) —— consumer
 * (ideation) 已 import SecurityModule，本 module 经 inject codeIndexConfig.KEY 解析。
 */

export { CODE_INDEX } from './code-index.port.js';
export type { CodeIndexProvider, CodeChunk, RepoCatalogEntry } from './code-index.port.js';
export { HttpCodeIndexProvider } from './http-code-index.provider.js';
export { FakeCodeIndexProvider } from './fake-code-index.provider.js';

@Module({
  providers: [
    {
      provide: CODE_INDEX,
      useFactory: (cfg: CodeIndexConfig): CodeIndexProvider =>
        cfg.kind === 'http' ? new HttpCodeIndexProvider(cfg) : new FakeCodeIndexProvider(),
      inject: [codeIndexConfig.KEY],
    },
  ],
  exports: [CODE_INDEX],
})
export class CodeIndexModule {}
