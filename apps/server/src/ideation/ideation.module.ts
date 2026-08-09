import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module.js';
import { AccountModule } from '../account/account.module.js';
import { CodeIndexModule } from '../integrations/codeindex/code-index.module.js';
import {
  deepseekConfig,
  type DeepseekConfig,
  minimaxConfig,
  type MinimaxConfig,
  asrConfig,
  type AsrConfig,
} from '../config/index.js';
import {
  LLM_PROVIDER,
  type LlmProvider,
  DeepseekProvider,
  MinimaxProvider,
  RoutingLlmProvider,
} from '../integrations/llm/llm.module.js';
import {
  ASR_PROVIDER,
  type AsrProvider,
  DashscopeAsrProvider,
  FakeAsrProvider,
  type FakeAsrConfig,
} from '../integrations/asr/asr.module.js';
import { FakeIdeationLlmProvider, type FakeIdeationRound } from './fake-ideation-llm.provider.js';
import { CreateSessionUseCase } from './create-session.usecase.js';
import { ListSessionsUseCase } from './list-sessions.usecase.js';
import { GetSessionUseCase } from './get-session.usecase.js';
import { DeleteSessionUseCase } from './delete-session.usecase.js';
import { ReopenSessionUseCase } from './reopen-session.usecase.js';
import { SetSessionRepoUseCase } from './set-session-repo.usecase.js';
import { RepoCatalogUseCase } from './repo-catalog.usecase.js';
import { ClarifyTurnUseCase } from './clarify-turn.usecase.js';
import { GenerateBriefUseCase } from './generate-brief.usecase.js';
import { ExportBriefUseCase } from './export-brief.usecase.js';
import { PromptConfigService } from './prompt-config.service.js';
import { TranscribeAsrUseCase } from './asr-transcribe.usecase.js';
import { IssueIdeaAttachmentCredentialUseCase } from './attachment-credential.usecase.js';
import { ClaimedEventOwnershipProvider } from './claimed-event-ownership.js';
import { IssueMockupCredentialUseCase } from './mockup-credential.usecase.js';
import { RecordMockupUseCase } from './mockup-record.usecase.js';
import { ListSessionMockupsUseCase } from './mockup-list.usecase.js';
import { SessionController } from './session.controller.js';
import { ClarifyStreamController } from './clarify-stream.controller.js';
import { BriefController } from './brief.controller.js';
import { AsrTranscribeController } from './asr-transcribe.controller.js';
import { AttachmentCredentialController } from './attachment-credential.controller.js';
import { MockupCredentialController } from './mockup-credential.controller.js';
import { MockupRecordController } from './mockup-record.controller.js';
import { MockupListController } from './mockup-list.controller.js';
import { WorkerAuthGuard } from '../security/worker-auth.guard.js';

/**
 * ideation bounded context (032, 第 8 个 — ADR-0057 需求灵感澄清)。两相剧本驱动 PRD
 * brief 闭环。**叶子 ctx**: 不 import 任何业务 ctx (尤其 chat); accountId 来自 JWT
 * (account/ 平台 auth 基座), 会话/轮次/brief 按 accountId 归属。范式 = ADR-0043 扁平
 * + 贫血 Prisma row + 直注 PrismaService (无 repository)。
 *
 * 依赖 SecurityModule (PrismaService + 全局 ProblemDetailFilter + JwtModule + 全局
 * ThrottlerModule + ConfigModule 含 deepseek/minimax config) + AccountModule
 * (JwtAuthGuard + AccountIdThrottlerGuard, account-bound 鉴权 artefact 经 export 复用 —
 * 非业务 use-case 调用, 无跨 ctx 注释; chat/portfolio/alert 同款先例)。
 *
 * **LLM 复用经 port, 不 import chat** (ADR-0057 §2 / ADR-0058): `integrations/llm` 是
 * vendor I/O port (非 bounded context), 不计 ctx 依赖。ideation 自建 `LLM_PROVIDER`
 * useFactory (整 module 装配, 供 T008/T009 SSE 澄清/产出 UC 注入):
 * - 生产路径 = RoutingLlmProvider (按逻辑 model 委托 DeepSeek/MiniMax M3; 结构化轮
 *   默认 M3 per 契约 doc §5)。
 * - `IDEATION_FAKE_LLM=1` (ideation **自有**开关, 非 chat 的 CHAT_FAKE_LLM) → 绑确定性
 *   FakeIdeationLlmProvider, bake 默认两相剧本 `IDEATION_FAKE_SCRIPT` (T020 契约冒烟真 boot
 *   读到 token + chips + brief; 照 chat `FAKE_LLM_TOKENS` 范式)。IT 仍经 DI
 *   `.overrideProvider(LLM_PROVIDER)` 注定制 scripted fake 驱动 state_branches。
 *
 * T007 (本): 会话 CRUD + 生命周期 UC + SessionController。CRUD 不直接调 LLM, 但 module
 * 必须能装配 LLM_PROVIDER 供 T008/T009。
 *
 * T020 (本): 契约冒烟真 boot (node dist/main.js 全启动) 无法像 IT 那样 `.overrideProvider`
 * 注 scripted fake, 故 `IDEATION_FAKE_LLM=1` 工厂 **bake 一份默认确定性两相剧本**
 * (`IDEATION_FAKE_SCRIPT`) —— 照 chat `CHAT_FAKE_LLM` 的 `FAKE_LLM_TOKENS` 范式: 访谈轮出
 * 一个带 chips + 推荐项的澄清问题 (过两闸: 第二问 turnIndex=1 → 给 chips), 产出轮出 T1 五段
 * 齐的 brief。冒烟据此读到 token + suggestion 帧 + 落 brief。IT 仍经 DI override 注定制
 * scripted 驱动 state_branches, 不走此默认 (per plan「NO LIFECYCLE MOCKING」)。
 *
 * **轮序 (loopByToolMenu 菜单驱动, 2026-08-03 起)**: 契约冒烟一次 boot **顺序跑全部套件**、
 * 共享本 provider 单例 —— 剧本按「stream 调用次数」硬对位会被前序套件耗尽。旧注释写的
 * 「冒烟流程内调用序固定 = [ask, emit] 一一对位」只对单套件成立, 被 40 天连红实证证伪
 * (2026-06-23 034 合入当晚起: 032 三轮耗尽 → 034 澄清轮拿到越界空轮 → 0 token 帧,
 * e2e-real-backend 每晚红 + 每晚一张 issue)。故 bake 配置开 `loopByToolMenu`: 每次调用
 * 按当轮工具菜单环扫选轮 (访谈菜单 → ask 轮 / 产出菜单 → emit 轮), 与套件数量、调用
 * 次序解耦。IT 不走此默认 (DI override 注定制 cursor 剧本, 语义不变)。
 */

/**
 * 契约冒烟真 boot 用的默认确定性两相剧本 (IDEATION_FAKE_LLM=1, T020)。三轮按
 * `loopByToolMenu` 菜单环扫**循环复用**(不再按调用次数一一对位, 见上「轮序」段):
 * - ask 轮·纯文本: 访谈菜单选中时 drip question 文本 (第一问 turnIndex=0 反锚定,
 *   即便轮里带 options 也被闸拦, chips 帧只在 turnIndex≥1 出现)。
 * - ask 轮·带 2 内容选项 (含 recommended): turnIndex≥1 过两闸 (enumerable +
 *   defensibleRec) → 收口 **suggestion 帧** (chips)。
 * - emit 轮: 产出菜单选中 → `emit_requirements_brief` 出 T1 五段齐 brief → 收敛门过 → 落库。
 * 命名贴 chat.module 的 `FAKE_LLM_TOKENS` 内嵌确定性范式; IT 不走此常量 (DI override 注定制)。
 */
const IDEATION_FAKE_SCRIPT: FakeIdeationRound[] = [
  {
    // 第一问 (turnIndex=0): 反锚定永不给 chips → 纯文本问题 (无 options)。
    ask: { question: '你想解决的核心问题是什么?', allow_freetext: true },
  },
  {
    // 第二问 (turnIndex=1): enumerable + defensibleRec → 过两闸 → 收口 suggestion 帧。
    ask: {
      question: '复用现有自选股清单还是独立收藏?',
      options: [{ label: '复用自选股清单', recommended: true }, { label: '独立收藏' }],
      multi_select: false,
      allow_freetext: true,
    },
  },
  {
    emit: {
      problem: '行情页缺少快捷收藏入口, 用户需反复搜索关注标的。',
      user_stories:
        'P1: 作为用户, 我想在行情页一键收藏标的, 以便快速回看。\nGiven 行情页 When 点收藏 Then 标的入收藏列表。',
      functional_requirements: 'FR-001 行情页提供收藏按钮。\nFR-002 收藏复用现有自选股清单。',
      success_criteria: 'SC-001 收藏操作 P95 < 200ms。\nSC-002 收藏后重进仍在。',
      non_goals: '不做收藏分组 / 不做跨设备同步 (本期)。',
    },
  },
];
/**
 * 契约冒烟真 boot 用的默认确定性 ASR 听写文本 (ASR_PROVIDER=fake, 035 一次性文件识别)。
 *
 * 真 boot (node dist/main.js) 无法像 IT 那样 `.overrideProvider(ASR_PROVIDER)` 注 scripted
 * FakeAsrProvider, 故 `kind==='fake'` 工厂 **bake 一份默认 transcript** —— 照本文件
 * `IDEATION_FAKE_SCRIPT` (LLM) 与 chat `FAKE_LLM_TOKENS` 同范式。HTTP 契约冒烟据此读到非空
 * `{text}`, 验 transcribe 端点契约对齐。IT 仍经 DI override 注定制 FakeAsrConfig 驱动
 * state_branches (空 text / fail), 不走此默认 (per plan「NO LIFECYCLE MOCKING」)。
 */
const ASR_FAKE_SCRIPT: FakeAsrConfig = {
  text: '你想给行情页加收藏',
};

@Module({
  imports: [SecurityModule, AccountModule, CodeIndexModule],
  controllers: [
    SessionController,
    ClarifyStreamController,
    BriefController,
    AsrTranscribeController,
    AttachmentCredentialController,
    MockupCredentialController,
    MockupRecordController,
    MockupListController,
  ],
  providers: [
    CreateSessionUseCase,
    ListSessionsUseCase,
    GetSessionUseCase,
    DeleteSessionUseCase,
    ReopenSessionUseCase,
    SetSessionRepoUseCase,
    RepoCatalogUseCase,
    ClarifyTurnUseCase,
    GenerateBriefUseCase,
    ExportBriefUseCase,
    TranscribeAsrUseCase,
    IssueIdeaAttachmentCredentialUseCase,
    // 037: worker-token mockup 凭证 (scope 据 claimed event 跨 ctx 只读派生) + 共享 worker guard。
    // WorkerAuthGuard 无状态平台 infra (security/, ADR-0041), 各 module 各自 provide 给自己的
    // worker-token 端点 (无单一挂载点; agent-bridge 同款自 provide)。
    ClaimedEventOwnershipProvider,
    IssueMockupCredentialUseCase,
    RecordMockupUseCase,
    ListSessionMockupsUseCase,
    WorkerAuthGuard,
    PromptConfigService,
    {
      // 大模型流式出口 vendor I/O (ADR-0058 port 复用; 结构化轮默认 M3, 契约 doc §5)。
      // IDEATION_FAKE_LLM=1 → 确定性 FakeIdeationLlmProvider, bake 默认两相剧本
      // IDEATION_FAKE_SCRIPT (T020 契约冒烟真 boot); IT 经 DI override 注定制 scripted
      // 两相剧本驱动 state_branches, per plan「NO LIFECYCLE MOCKING」。
      provide: LLM_PROVIDER,
      useFactory: (dsCfg: DeepseekConfig, mmCfg: MinimaxConfig): LlmProvider =>
        process.env.IDEATION_FAKE_LLM === '1'
          ? // loopByToolMenu: 单例剧本按菜单环扫循环复用, 不被前序冒烟套件耗尽 (见 IDEATION_FAKE_SCRIPT 注)。
            new FakeIdeationLlmProvider({ script: IDEATION_FAKE_SCRIPT, loopByToolMenu: true })
          : new RoutingLlmProvider(new DeepseekProvider(dsCfg), new MinimaxProvider(mmCfg)),
      inject: [deepseekConfig.KEY, minimaxConfig.KEY],
    },
    {
      // ASR vendor I/O 出口 (ADR-0058 port 复用, 035 语音输入一次性文件识别注入)。按 asrConfig.kind
      // 选 dashscope (生产, Node 全局 fetch 打 DashScope compatible-mode chat-completions) /
      // fake (dev/test 默认)。IT 经 DI `.overrideProvider(ASR_PROVIDER)` 注定制 FakeAsrProvider
      // 驱动 state_branches (per plan「NO LIFECYCLE MOCKING」); 工厂选择留消费方 (同 LLM_PROVIDER 范式)。
      provide: ASR_PROVIDER,
      useFactory: (cfg: AsrConfig): AsrProvider =>
        cfg.kind === 'dashscope'
          ? new DashscopeAsrProvider(cfg)
          : // fake 默认 bake transcript (契约冒烟真 boot 读到非空 {text});
            // IT 经 DI override 注定制 FakeAsrConfig 驱动 state_branches, 不走此默认。
            new FakeAsrProvider(ASR_FAKE_SCRIPT),
      inject: [asrConfig.KEY],
    },
  ],
})
export class IdeationModule {}
