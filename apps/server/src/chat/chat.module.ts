import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module.js';
import { AccountModule } from '../account/account.module.js';
import {
  deepseekConfig,
  type DeepseekConfig,
  minimaxConfig,
  type MinimaxConfig,
  iqsConfig,
  type IqsConfig,
} from '../config/index.js';
import { CreateConversationUseCase } from './create-conversation.usecase.js';
import { ListModelsUseCase } from './list-models.usecase.js';
import { GetMessagesUseCase } from './get-messages.usecase.js';
import { ListConversationsUseCase } from './list-conversations.usecase.js';
import { RenameConversationUseCase } from './rename-conversation.usecase.js';
import { SetConversationModelUseCase } from './set-conversation-model.usecase.js';
import { DeleteConversationUseCase } from './delete-conversation.usecase.js';
import { SendMessageUseCase } from './send-message.usecase.js';
import { GetChatPreferenceUseCase } from './get-chat-preference.usecase.js';
import { UpsertChatPreferenceUseCase } from './upsert-chat-preference.usecase.js';
import {
  LLM_PROVIDER,
  type LlmProvider,
  DeepseekProvider,
  MinimaxProvider,
  RoutingLlmProvider,
  FakeLlmProvider,
} from '../integrations/llm/llm.module.js';
import { SEARCH_PROVIDER, type SearchProvider } from './search-provider.port.js';
import { IqsSearchProvider } from './iqs-search.provider.js';
import { FakeSearchProvider } from './fake-search.provider.js';
import { ConversationController } from './conversation.controller.js';
import { ChatStreamController } from './chat-stream.controller.js';
import { ChatPreferenceController } from './chat-preference.controller.js';

/**
 * chat bounded context (027, 第 7 个 — ADR-0032 7 问 Q4 全新业务领域)。AI 对话首页
 * 主干 + 单模型流式。**叶子 ctx**: 不 import 任何业务 ctx; accountId 来自 JWT
 * (account/ 平台 auth 基座), 会话/消息按 accountId 归属。范式 = ADR-0043 扁平 + 贫血
 * Prisma row + 直注 PrismaService (无 repository)。
 *
 * 依赖 SecurityModule (PrismaService + 全局 ProblemDetailFilter + JwtModule +
 * 全局 ThrottlerModule + ConfigModule 含 deepseekConfig) + AccountModule (JwtAuthGuard
 * + AccountIdThrottlerGuard, account-bound 鉴权 artefact 经 export 复用 — 非业务 use-case
 * 调用, 无 R2/R3 跨 ctx 注释; portfolio/alert 同款先例)。
 *
 * T006: 建会话 + 取消息 UC + ConversationController (REST CRUD)。
 * T007 (本): send-message UC + ChatStreamController (SSE 流式) + LLM_PROVIDER 绑定
 *   (DeepseekProvider useFactory + inject deepseekConfig.KEY; deepseekConfig 已加入
 *   SecurityModule ConfigModule.forRoot load 数组, vitest.config test.env 给占位
 *   DEEPSEEK_API_KEY 让既有 boot IT 不回归)。IT 经 DI override LLM_PROVIDER 注
 *   FakeLlmProvider (不 jest.mock, per plan「NO LIFECYCLE MOCKING」)。
 *
 * T014 (本): 真 boot 的契约冒烟 (contract-smoke) 走 node dist/main.js 全启动, 无法
 *   像 IT 那样 .overrideProvider 注 Fake, 故加 env 开关 `CHAT_FAKE_LLM=1` → useFactory
 *   绑 FakeLlmProvider (确定性 scripted token, 不打真 DeepSeek / 不依赖外网)。默认
 *   (未设 / !== '1') 仍绑 DeepseekProvider, 生产路径不变。
 */

/** 契约冒烟真 boot 用的确定性 token 序列 (含中文多字节, 验 SSE 编码端到端)。 */
const FAKE_LLM_TOKENS = ['你好', '，', '这', '是', '一', '段', '测', '试', '回', '复', '。'];

/**
 * 契约冒烟真 boot 用的 content-driven 联网触发关键字 (CHAT_FAKE_LLM=1, T016)。
 * 消息内嵌此 ascii 关键字 + webSearch=true (附 web_search 工具) → FakeLlmProvider 吐 tool_call
 * 驱动一轮检索, 检索结果回灌后吐 FAKE_LLM_TOKENS 收敛。无此关键字 / 无 tools → 维持 027/029
 * 既有 tokens 行为 (零回归)。命名贴 029 model-switch 的 `Mvpro`/`Mvflash` 内嵌 token 范式。
 */
const FAKE_LLM_WEB_SEARCH_KEYWORD = 'WebSrch';

/**
 * 契约冒烟真 boot 用的 content-driven 系统提示回显关键字 (CHAT_FAKE_LLM=1, 031 T011)。
 * 消息内嵌此 ascii 关键字 → FakeLlmProvider 把本次组装的 `role:'system'` 段原文吐成正文 (落库
 * AI 消息 = 系统提示原文) → 契约冒烟 node 层经 GET messages 即可断言平台基座层 + 用户自定义层
 * 文本真组装进 system (env 注入路无法 .overrideProvider spy 捕获入参, 故用回显验真)。无此关键字
 * → 维持既有 tokens / WebSrch 行为 (零回归)。命名贴 WebSrch 的内嵌 ascii token 范式。
 */
const FAKE_LLM_SYSTEM_ECHO_KEYWORD = 'SysEcho';

/**
 * 契约冒烟真 boot 用的确定性检索结果 (CHAT_FAKE_SEARCH=1, T016)。两条不同 URL,
 * 验来源去重编号 + metadata 落库回填。IT (T010) 不走此常量,经 DI override 注入定制 scripted。
 */
const FAKE_SEARCH_RESULTS = [
  [
    { title: '示例来源一', url: 'https://example.com/a', snippet: '摘要 A', content: '正文 A' },
    { title: '示例来源二', url: 'https://example.com/b', snippet: '摘要 B', content: '正文 B' },
  ],
];

/**
 * 契约冒烟真 boot 用的检索降级触发标记 (CHAT_FAKE_SEARCH=1, T016)。query (= content-driven 模式
 * 透传的 user 文本) 含此标记 → FakeSearchProvider throw → 驱动 FR-009 降级路径 (degraded 帧 +
 * metadata.degraded 落库)。无此标记 → 走 FAKE_SEARCH_RESULTS (向后兼容)。
 */
const FAKE_SEARCH_FAIL_MARKER = 'FAIL';
@Module({
  imports: [SecurityModule, AccountModule],
  controllers: [ConversationController, ChatStreamController, ChatPreferenceController],
  providers: [
    CreateConversationUseCase,
    ListModelsUseCase,
    GetMessagesUseCase,
    ListConversationsUseCase,
    RenameConversationUseCase,
    SetConversationModelUseCase,
    DeleteConversationUseCase,
    SendMessageUseCase,
    GetChatPreferenceUseCase,
    UpsertChatPreferenceUseCase,
    {
      // 大模型流式出口 vendor I/O (plan D7) — 多 provider 路由 (029 收口)。
      // RoutingLlmProvider 按逻辑 model 委托: minimax → MiniMax M3, flash/pro → DeepSeek;
      // send-message UC 仍只注入单个 LLM_PROVIDER、调用不变 (port 承诺「仅加新实现」)。
      // CHAT_FAKE_LLM=1 (仅契约冒烟真 boot 用, T014) → 绑确定性 FakeLlmProvider。
      provide: LLM_PROVIDER,
      useFactory: (dsCfg: DeepseekConfig, mmCfg: MinimaxConfig): LlmProvider =>
        process.env.CHAT_FAKE_LLM === '1'
          ? new FakeLlmProvider({
              tokens: FAKE_LLM_TOKENS,
              webSearchKeyword: FAKE_LLM_WEB_SEARCH_KEYWORD,
              systemEchoKeyword: FAKE_LLM_SYSTEM_ECHO_KEYWORD,
            })
          : new RoutingLlmProvider(new DeepseekProvider(dsCfg), new MinimaxProvider(mmCfg)),
      inject: [deepseekConfig.KEY, minimaxConfig.KEY],
    },
    {
      // 联网检索后端 vendor I/O (plan D1) — chat 自身 infra, 类比 LLM_PROVIDER。
      // IQS HTTP adapter 生产默认;mock 配置 (IQS_PROVIDER 未设) 下 search 被调即报错,
      // 提示启用 aliyun 或走 Fake。CHAT_FAKE_SEARCH=1 (契约冒烟真 boot, T016) →
      // 绑确定性 FakeSearchProvider;IT 经 DI override SEARCH_PROVIDER 注定制 scripted。
      provide: SEARCH_PROVIDER,
      useFactory: (iqsCfg: IqsConfig): SearchProvider =>
        process.env.CHAT_FAKE_SEARCH === '1'
          ? new FakeSearchProvider({
              results: FAKE_SEARCH_RESULTS,
              failOnQueryMarker: FAKE_SEARCH_FAIL_MARKER,
            })
          : new IqsSearchProvider(iqsCfg),
      inject: [iqsConfig.KEY],
    },
  ],
})
export class ChatModule {}
