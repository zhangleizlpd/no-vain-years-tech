---
adr_id: ADR-0055
status: Accepted
applies_to: [apps/server, apps/mobile]
sunset_trigger: |
  - 第二个 LLM provider 接入（029 多 provider 路由）→ 重审 `LlmProvider` port 是否需升级为带路由策略的 registry（按 model → provider 映射），及 key 管理是否需从单 env 扩为 per-provider env 集
  - 出现第二个 SSE / 流式端点（chat 之外的 ctx 需要流式）→ `reply.hijack()` 范式从「chat 内约定」升格为跨 ctx 共享，评估抽 server 级流式 helper（headers / abort / split-tx 落库三件套）
  - chat 需要跨 ctx 业务依赖（注入他 ctx UC / 读他 ctx 表做 RAG 上下文等）→ 叶子 ctx 前提失效，回 catalog 7Q 重评跨 ctx 传播面（Q5-Q7）
  - 会话/消息出现第二类写路径竞争（非 append-only，如消息编辑/重生覆盖）→ split-tx「流前/流后独立短写」语义失效，重审并发与事务边界
---

# ADR-0055: Chat 第 7 Bounded Context + SSE 流式端点 reply.hijack 范式 + LlmProvider port

- Status: Accepted (2026-06-14)
- Deciders: @zhangleizlpd
- Tags: server / bounded-context / chat / sse-streaming / llm-provider
- Relates: [ADR-0032](0032-backend-bounded-context.md)（bounded context 拆分框架 + sunset trigger）/ [ADR-0043](0043-server-flat-module-paradigm.md)（扁平贫血 + `*.rules.ts` 纯函数层）/ [ADR-0038](0038-fullstack-error-handling-ux-contract.md)（ProblemDetail 错误契约，lazy-hijack 前置异常走 Filter）/ [ADR-0052](0052-alert-bounded-context.md)（第 6 ctx alert，叶子 ctx + JWT 复用先例）/ [ADR-0047](0047-marketdata-pluggable-data-access.md)（vendor adapter + port 范式，复用其形）；实施载体 = [027-ai-chat-streaming](../../specs/027-ai-chat-streaming/spec.md)（plan D1 / D3 / D7）

## Context

027 把首页占位建成大模型对话主干，一次引入仓内**三个第一**，三者各需定稿且互相牵动：

1. **归属**：会话/消息域落既有 6 ctx（security/account/auth/portfolio/marketdata/alert）哪一个，还是新立 bounded context？
2. **流式传输**：大模型逐 token 回推是仓内第一个 SSE（`text/event-stream`）端点；Nest 原生 `@Sse()`（RxJS Observable 桥）vs Fastify `reply.hijack()`（raw 写）选型，并定 SSE headers / 中断 / 落库时序范式，为后续流式端点立锚。
3. **provider 集成**：仓内第一次接 LLM；调用面如何与具体厂商解耦（027 单 DeepSeek，029 多 provider，二期 MiniMax），LLM key 如何不外泄。

三者均无前置 ADR 覆盖（[plan](../../specs/027-ai-chat-streaming/plan.md) Gate 0.4：`rg "Open Question|deferred" docs/adr/*.md` 无既有 open question 被本 feature 触发），故合并立一条短 ADR 固化三范式，为 028（会话列表/搜索）/ 029（多 provider 路由）/ 二期（RAG/tool）立锚。

## Decision

### 1. 新立第 7 bounded context `chat`（catalog Q4 命中）

[catalog](../conventions/server-bounded-context-catalog.md) 7Q 逐条：Q1 否（`conversation`/`message` 全新概念，不碰 account/alert/portfolio 任何既有表）/ Q2 否（纯 chat 内聚，accountId 仅作归属、从 JWT 取不读 account 表，不编排多 ctx user-facing 流程）/ Q3 否（业务领域非 platform infra）/ **Q4 是**——大模型对话是全新业务领域，6 现 ctx 都不沾；落 account/portfolio 会让其吃进「会话存储 + LLM 接入 + 流式传输」异质职责。Q5-Q7 否（无跨 ctx 写、无同步编排、无跨 ctx 读）。

- 物理面：`apps/server/src/chat/`（ADR-0043 扁平贫血，文件平铺、无 domain/application/infrastructure/web 子目录、无 repository、UC 直注 `PrismaService`）+ Prisma `@@schema("chat")` 2 表（`conversation` / `message`，moat owner=chat）+ `apps/mobile/src/chat/`（business-naming 三处同名）。
- 依赖面：**叶子 ctx**——无 import 任何业务 ctx UC；`JwtAuthGuard` / `AccountIdThrottlerGuard` 从 `account/` import = 平台 auth 基座复用（portfolio/alert 同款先例，ADR-0052 §1），accountId 来自 JWT claim 非业务跨 ctx 调用。无人依赖 chat。ESLint boundaries + moat 探针双层强制。
- 预留扩展（二期）：`conversation.metadata Json?` 空列承接业务上下文注入（RAG/tool），027 不读写。

### 2. SSE 流式端点 = Fastify `reply.hijack()` raw 写（非 Nest `@Sse()`）

仓内第一个流式端点 `POST /chat/conversations/{conversationId}/messages`。取 **Fastify 原生 `reply.hijack()` + `reply.raw.write()`**，否决 Nest `@Sse()`（RxJS Observable 桥）——后者强制把 AsyncIterable token 流桥成 Observable、与 provider 的 `for await` 模型阻抗失配，且 hijack 对 raw socket 的中断/落库时序控制更直接。范式四件套：

1. **lazy-hijack**：先做归属校验（他人 conversationId → 404 字节级一致反枚举，与 alert/portfolio 同款）+ 落 user message，**再** `reply.hijack()`。hijack 前抛的异常仍走 `ProblemDetailFilter`（ADR-0038 错误契约）出标准 JSON；hijack 后 Nest 不再接管该响应，错误改写进 SSE 帧（`data:{error}\n\n`）。
2. **SSE headers**（`reply.raw.writeHead(200, …)`）：`Content-Type: text/event-stream` / `Cache-Control: no-cache, no-transform` / `X-Accel-Buffering: no`（prod nginx 须 `proxy_buffering off`，部署 note）；**不挂** `@fastify/compress`（未装，日后加须排除该路由）。
3. **中断**：`reply.raw.on('close')` → `AbortController.abort()` 取消上游 provider（止付 token）；客户端主动断连视作**停止**。
4. **split-tx 落库语义**（禁 tx 内持锁等 HTTP 外部 I/O）：user message 即时独立写（流前，FR-006）；AI message 仅在流**正常结束**（status=`completed`）或**停止**（status=`stopped`，落已生成半成品）时单次 create（流后短写）；provider 报错/超时 → **AI message 不落**（无 `failed` 值），user message 已落不丢，客户端展示错误态 + 重试（FR-009）。流式期间不开 tx，消息 append-only 无单行状态机竞争。

### 3. `LlmProvider` port + DeepSeek adapter + server-proxy key 策略

provider-agnostic port，复用 ADR-0047 vendor adapter「port 先行 / 实现可换」范式形：

1. `llm-provider.port.ts`：`interface LlmProvider { stream(messages, opts): AsyncIterable<string> }`（吐 token 字符串，`AbortSignal` 经 opts 透传）。消费方 `send-message.usecase` 仅依赖此接口。
2. `deepseek.provider.ts`：`new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY })` + `chat.completions.create({ model, messages, stream: true }, { signal })` → `for await` 出 `choices[0].delta.content`。DeepSeek OpenAI 兼容，仅换 `baseURL`（Gate 0.2 6Q + PoC 实证）。
3. **server-proxy key**：LLM key 仅 server env（`DEEPSEEK_API_KEY`）、**永不下发客户端**（FR-007）；mobile 经 server SSE 端点中转，不直连 provider。
4. **确定性测试钩子**：`CHAT_FAKE_LLM` env 开关注入 fake stream provider 替身，供 contract-smoke / IT 确定性 token 流（真 DeepSeek 走 env-gated IT 避免 CI 依赖外部）。
5. 二期 MiniMax / 029 多 provider 路由 = 新增 port 实现，**不动** `send-message.usecase` 调用方。

## Consequences

- 027 单 PR（`feat(chat)`）实装本 ADR 全部注册面：`chat` schema + 2 表 + 1 migration（`datasource db` 的 `schemas` 列表加 `"chat"`）+ ESLint boundaries / Nx tag 注册 module + moat `MODEL_OWNERSHIP` 声明 owner=chat（否则 moat 探针 `moat-unmapped` 硬拒）+ SSE controller + `LlmProvider` port/adapter + mobile `~/chat` feature。
- SSE 端点产 `text/event-stream` 非 JSON → **不走 orval typed hook**；mobile 自写 expo/fetch 流式客户端消费（建会话/取消息两个非流式端点仍走 orval hook）。
- 三范式成为下游锚点：028 会话列表/搜索（复用 chat ctx + `@@index([accountId, updatedAt])`）/ 029 多 provider 路由（扩 `LlmProvider` 实现集）/ 二期 RAG/tool（用 `conversation.metadata` 列）。

## Trade-offs

- **新立 chat ctx vs 塞 account/portfolio** — 多一个 ctx 注册面（schema/boundaries/moat/module），换全新领域职责隔离 + 028/029/二期独立演进空间；catalog Q4 命中是 ADR-0032 正路，非过度工程。
- **`reply.hijack()` vs Nest `@Sse()`** — 放弃 Nest 装饰器的声明式便利、手管 raw socket headers/中断/落库时序，换与 provider AsyncIterable 模型直接对齐 + 对 split-tx 落库时序的精确控制；范式四件套钉死防散落。
- **port 抽象 vs 直调 `openai` SDK** — 多一层 `LlmProvider` 接口，换 provider 可换（二期 MiniMax / 029 路由零调用方改动）+ `CHAT_FAKE_LLM` 确定性测试口；027 单 provider 下成本 <0.5 天（封单文件）。
- **split-tx 失败不落 AI message** — 错误态下会话缺一条 assistant row（仅留 user 提问 + 客户端瞬态错误态），换流式期间零 tx 持锁等 HTTP；接受理由：消息 append-only、重试即重发，半成品落库（停止态）已覆盖「保留已生成」诉求。

## Open Questions

- 无（027 范围内三范式决策已定；多 provider 路由策略 = 029、RAG/tool 上下文注入 = 二期、AI 生成标题 = 二期，均为 backlog 见 spec Assumptions / plan D4-D7）。

## 复审记录

### 2026-06-22 — LLM provider 物理位置 `chat/` → `integrations/llm/`（[ADR-0058](0058-server-integrations-layer.md) 平台层），决策正文不变

[ADR-0057](0057-ideation-bounded-context.md) 引入第二个 LLM 消费 ctx（ideation），使本 ADR §3 的 `LlmProvider` port 从「chat 内私有」升为「被 ≥2 bounded context 复用的外部 vendor 适配器」。原物理位置 `apps/server/src/chat/` 不再合适——其他 ctx import 会违反 ESLint 单向边界（跨 ctx 业务 import 硬拒）。[ADR-0058](0058-server-integrations-layer.md) §2 据此把 provider `git mv` 到目的受限的平台层 `apps/server/src/integrations/llm/`，chat + ideation 经 DI 绑同一 `LLM_PROVIDER` port。

**搬迁清单**（032 ideation B1 PR-1 落地，`git mv` 保 git 史）：

- `llm-provider.port.ts`（含上移的 `Msg` / `ToolCall` 类型——原散落 chat，搬迁时上提进 port 作 provider 契约的一部分；`chat-context.rules` 改 re-export 这两个类型保 chat 侧引用不破）
- `deepseek.provider.ts` / `minimax.provider.ts` / `fake-llm.provider.ts`（三 adapter）
- `llm-router.ts`（model → provider 路由）+ `llm-stream.rules.ts`（流式纯函数层）
- 各对应 `*.spec.ts`

**`integrations/llm/llm.module.ts`** 仅 re-export 类 + `LLM_PROVIDER` token，**不提供默认绑定**——各消费 ctx 自声明 `useFactory`（chat / ideation 各自 wire）。ESLint boundaries 走 `eslint-plugin-boundaries` `type: 'integrations'`（业务 ctx + security 单向可依赖，integrations 禁 import 任何业务 ctx）。

**本 ADR §1-§3 决策正文一律不动**（chat 仍是第 7 bounded context；SSE `reply.hijack()` 四件套不变；`LlmProvider` port 契约不变，仅物理位置从 chat/ 迁到 integrations/llm/）。chat 的 `send-message.usecase` 等仅改 import 路径（同 ctx import → import integrations port），**chat 行为零变更，IT 全回归绿（127 IT）**。`iqs-search.provider`（web search）目前单消费者（chat）→ 暂留 `chat/`（per ADR-0058 §2 注，准入规则只迁 ≥2 消费者者）。status 保持 Accepted。

## References

- [027 spec](../../specs/027-ai-chat-streaming/spec.md) / [plan](../../specs/027-ai-chat-streaming/plan.md)（D1 chat ctx 7 问 / D3 SSE 端点 / D7 LlmProvider）/ [poc-findings](../../specs/027-ai-chat-streaming/poc-findings.md)（expo/fetch + DeepSeek 流式实证）
- [server-bounded-context-catalog](../conventions/server-bounded-context-catalog.md)（7Q 决策树）
- 叶子 ctx + JWT 平台基座复用先例：[ADR-0052](0052-alert-bounded-context.md) § 1
- vendor adapter port 范式形：[ADR-0047](0047-marketdata-pluggable-data-access.md)
- DeepSeek OpenAI 兼容接入文档（`baseURL` 切换）
