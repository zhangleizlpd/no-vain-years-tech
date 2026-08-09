---
adr_id: ADR-0058
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - integrations/ 内适配器 > ~7 或混入非「外部 vendor I/O」类成员 → 准入规则失守,重审是否再分层 / 拆 per-capability module
  - 某 vendor 适配器退回单一消费 ctx(另一消费方移除)→ 评估迁回该 ctx(单消费者不进 integrations)
  - 出现「被 ≥2 ctx 复用但非 vendor I/O」的共享 business 能力 → **不进** integrations,走新 bounded context 评估(ADR-0041 sunset #2)
  - integrations 适配器需跨 server/mobile 复用 → 评估抽 packages/
---

# ADR-0058: Server `integrations/` 层 — 跨 ctx 共享的外部 vendor I/O 适配器家(LLM 首位)

- Status: Accepted (2026-06-21)
- Deciders: @zhangleizlpd
- Tags: server / architecture / directory-policy / integrations
- Relates: [ADR-0041](0041-server-common-directory-policy.md)（`src/common/` 不引入 / platform infra 进 security/ —— 本 ADR refine 其 vendor I/O 子类归属）/ [ADR-0043](0043-server-flat-module-paradigm.md)（§4 vendor port + adapter）/ [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md)（`LlmProvider` port 起源,首位迁出者）/ [ADR-0057](0057-ideation-bounded-context.md)（引出本决策的第二 LLM 消费 ctx）

## Context

[ADR-0057](0057-ideation-bounded-context.md) §2 引出一道悬而未决的归属题:LLM provider(`LlmProvider` port + DeepSeek/MiniMax/router/fake adapter)现物理在 `apps/server/src/chat/`,但已被 **≥2 个 bounded context 复用**(chat + ideation;pkm 后续第 3)。两个现成落点都不对:

- 放 `chat/` → 其他 ctx import 违反 ESLint 单向边界(跨 ctx 业务 import 硬拒)。
- 放 `security/` → 语义错配:[ADR-0041](0041-server-common-directory-policy.md) 把 `security/` 定为「平台**基座**」(DB/cache/error/JWT),vendor I/O 适配器塞进去会让「security」这个名字更失真(ADR-0041 Trade-offs 已自承该命名别扭、Open Q 把改名 defer)。

[ADR-0041](0041-server-common-directory-policy.md) 当年定「**不引入** `src/common/`,平台 infra 进 `security/`」是为防**泛化杂物间**;但它未预见「**跨 ctx 共享的外部 vendor 适配器**」这一独立类别。本 ADR 为这一类碶出一个**目的受限**的层,而非 ADR-0041 否决的泛化 common。

## Decision

### 1. 新建 `apps/server/src/integrations/` —— 平台层,非 business bounded context

- **性质**:它是像 `security/` 一样**被业务 ctx 单向 import** 的基础设施层,**不是**第 9 个 bounded context —— 无 Prisma schema、无 moat owner、无业务域。
- **准入规则(防杂物间,硬约束)**:`integrations/` **只收**「被 **≥2 个 bounded context 复用**的 3rd-party **vendor I/O 适配器**」(port + adapter,per [ADR-0043](0043-server-flat-module-paradigm.md) §4)。三条排除:
  - **单消费者** vendor 适配器(如 Aliyun SMS 仅 auth 用)→ 留各自 ctx,**不**迁入。
  - **平台基座**(PrismaService / Redis / error filter / validation / JWT)→ 留 `security/`,**不**动(ADR-0041 不变)。
  - **共享的 business 能力**(非 vendor I/O 的领域逻辑)→ **不进** integrations,走新 bounded context 评估(ADR-0041 sunset #2)。
- **依赖方向**:业务 ctx + security → 可 import `integrations`;`integrations` → **禁** import 任何业务 ctx(叶子方向,与 security/ 同向);可 import `security/` 平台基座(若 vendor 适配器需 Redis 等)。ESLint boundaries + Nx tags 强制。
- **内构**:按 capability 分子目录(`integrations/llm/`、未来 `integrations/oss/` / `integrations/asr/`),每个 capability 一个 NestJS module export 其 port;子目录内文件扁平(per ADR-0043 §1)。

### 2. 首位租户 = LLM provider(从 `chat/` 迁出)

`llm-provider.port.ts` + `deepseek/minimax/llm-router/fake-llm.provider.ts`(及对应 spec)从 `apps/server/src/chat/` 迁到 `apps/server/src/integrations/llm/`;`chat` + `ideation` 经 DI 绑同一 `LLM_PROVIDER` port。

- 搬迁在 **ideation B1 PR-1** 落地(随 ideation context 注册一起做);[ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md) 届时补 amend 记录 provider 物理位置变更。
- 注意:`iqs-search.provider`(web search)目前单消费者(chat)→ **暂留 chat/**;出现第二消费 ctx 时再按本准入规则迁 `integrations/search/`。

### 3. 与 ADR-0041 的关系:refine,不 supersede

ADR-0041 核心「不引入泛化 `src/common/` 杂物间」**仍立**。`integrations/` 是**目的受限**层(准入规则只放 vendor I/O + ≥2 消费者),非泛化 common。ADR-0041 分类表「platform infra → `security/`」中的 **vendor I/O 子类**改走 `integrations/`;DB/cache/filter/JWT 等真平台基座仍归 `security/`。ADR-0041 加复审记录交叉引用本 ADR,状态保持 Accepted。

## Consequences

- B1 PR-1 注册面新增:`integrations/llm/` module + ESLint boundaries element(`type: integrations`,业务 ctx + security 可依赖,integrations 不可依赖业务 ctx)+ Nx tags;LLM provider 文件 `git mv` chat → integrations/llm。
- chat 的 `send-message.usecase` 等改注入路径(从同 ctx import 变 import integrations port);chat 行为不变,ADR-0055 补 amend。
- ideation(及未来 pkm)直接绑同一 port,零重复 adapter。
- moat 探针不涉及 integrations(无 Prisma 表 ownership)。

## Trade-offs

| 短板                                           | 接受理由                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 多一个顶层目录,与 security/ 都属"基础设施"     | 准入规则把二者切清(security=平台基座 / integrations=外部 vendor I/O);命名各自达意,避免 ADR-0041 怕的"两个泛化杂物间" |
| 首次引入要搬迁 chat 的 provider(触碰 chat ctx) | ≥2 消费者已使抽取摊销成立;一次性搬迁,之后三 ctx 单一 vendor 维护点                                                   |
| refine 而非 supersede ADR-0041,治理链稍绕      | 比"全盘 rename security/→platform"(ADR-0041 已权衡否决,大 import 重写)成本低得多;只碶出新类别不动旧决策              |

## Open Questions

- `integrations` ESLint boundary 的确切 element type 命名 + Nx tag 串 → B1 PR-1 实装时定（与现有 `security` element 同级平台层）。
- 未来 OSS 直传适配器(ADR-0045)是否迁入 `integrations/oss/`:现单消费(profile 图)→ 暂不迁;PKM/ideation 附件成为第二消费者时按准入规则迁。

## References

- [ADR-0041](0041-server-common-directory-policy.md)（被本 ADR refine 的 vendor I/O 归属规则）
- [ADR-0043](0043-server-flat-module-paradigm.md) §4（vendor port + adapter 范式）
- [ADR-0057](0057-ideation-bounded-context.md) §2（引出本决策）
- [PRD灵感 → SDD master](../private/plans/2026-06/06-21-prd-ideation-to-sdd-master.md)（B1 PR-1 落地搬迁）
