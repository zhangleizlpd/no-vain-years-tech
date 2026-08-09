---
feature_id: 027-ai-chat-streaming
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-14'
updated_at: '2026-06-14'
adr_refs: ['0024', '0032', '0039', '0040', '0043']
context7_verified: ['expo']
---

# Implementation Plan: 027-ai-chat-streaming（AI 对话首页主干 + 单模型流式）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `027-ai-chat-streaming` | **设计源**: [master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) + [PoC findings](./poc-findings.md) + [mockup](./design/)

> 手动模式（不用 orchestrator）→ 本 plan 无 `orchestrator_config` 块（对齐 011-026）。
> 标准 SDD：spec ✅ → clarify ✅（2026-06-14 3Q）→ **RN 流式 PoC ✅**（expo/fetch 真机增量实证）→ mockup ✅ → **plan（本）** → tasks → implement。
> **⚠ 头号架构事实**：027 引入仓内**三个第一**——① 第一个**全新 bounded context `chat`**（ADR-0032 sunset trigger 评估，下方 D1）② 第一个 **SSE 流式端点**（Fastify `reply.hijack()` raw 写，PoC 实证）③ 第一个 **LLM provider 集成**（`LlmProvider` port + DeepSeek adapter，provider-agnostic 二期可接 MiniMax）。chat 是**叶子 ctx**：不 import 任何业务 ctx，accountId 来自 JWT（security 基座）。

## Summary _(mandatory)_

027 = 把首页占位建成大模型对话主干：**① 新建 `chat` bounded context**（`conversation` / `message` 两表，`@@schema("chat")`，贫血 Prisma row + `@map`）→ **② `LlmProvider` port + DeepSeek adapter**（server 持 key，OpenAI 兼容 `openai` SDK，`stream(messages) → AsyncIterable<token>`）→ **③ SSE 流式发消息端点**（`reply.hijack()` + `reply.raw.write('data:…\n\n')`，消费 DeepSeek 流逐 token 回推，流结束落 AI message）→ **④ 多轮上下文 token 预算滑动窗口** + **停止/失败落库语义**（停止保留 stopped、失败不落）→ **⑤ mobile `~/chat` feature**：首页 chat 屏（Gemini 空态 + Kimi 对话骨架，翻 mockup baseline）+ **expo/fetch 流式消费层**（非 orval hook，自写客户端，`signal.aborted` 检测中断）。

- **server 段**：新 `apps/server/src/chat/` 扁平模块 —— `conversation.controller.ts`（建会话 / 取消息）+ `chat-stream.controller.ts`（SSE 发消息）+ `send-message.usecase.ts`（落用户 msg → 组上下文 → 调 provider 流 → 落 AI msg）+ `create-conversation.usecase.ts` + `get-messages.usecase.ts` + `llm-provider.port.ts`（接口）+ `deepseek.provider.ts`（实现）+ `chat-context.rules.ts`（token 预算滑动窗口纯函数）+ `chat-title.rules.ts`（截首条派生标题）+ DTO/swagger。Prisma schema 加 `chat` schema + 2 model。
- **mobile 段**：新 `apps/mobile/src/chat/` —— `chat-stream-client.ts`（expo/fetch SSE 消费，`AbortController`）+ `use-chat.ts`（会话态 / 流式累加 / 停止 / 重试）+ 首页屏组件（空态 / 对话流 / 输入条 / 消息操作条）+ `chat-copy.ts`。`app/(app)/(tabs)/index.tsx` 接入。非流式端点（建会话 / 取消息）走 Orval typed hook；流式端点走自写 expo/fetch 客户端。

**新基础设施**：新 `chat` bounded context + `chat` PG schema（2 表，1 migration）+ 新 server dep `openai`（DeepSeek OpenAI 兼容）+ DeepSeek key（`DEEPSEEK_API_KEY` 已在 `.env`）；**零** mobile 新 dep（`expo/fetch` 随 expo 自带，PoC 实证）。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| `openai`（server，新增） | DeepSeek OpenAI 兼容流式（`new OpenAI({baseURL:'https://api.deepseek.com'})` + `chat.completions.create({stream:true})` → AsyncIterable） | DeepSeek 官方接入文档明示「OpenAI SDK + baseURL」；PoC-B 已用裸 fetch 打通同协议（[poc-findings](./poc-findings.md)）。6Q 见 Gate 0.2 |
| `expo/fetch`（mobile，**非新增**，随 expo SDK 54 自带） | 流式 response body 增量读取（`response.body.getReader()` + `TextDecoder`） | PoC 真机实证可用、无 Android 缓冲（[poc-findings](./poc-findings.md) §验证矩阵）；SDK 52+ 引入 |
| `react-native-sse`（**不引入**） | — | PoC 兜底未触发（expo/fetch 增量 OK），显式不加 |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles（无违反，无需 Complexity justify）。

| 原则 | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅ → PoC ✅ → mockup ✅ → plan（本）→ tasks → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | `chat-context.rules`（token 窗口）/ `chat-title.rules`（截断）纯函数 vitest 红绿；`send-message` / provider 走 UC + IT；IT 覆盖 spec `state_branches` 全 8 条（空态首发 / 多轮 / 空输入 / 失败不落 / 停止保留 / 断连 / 401 / 越权 403） |
| III. Atomic 30min-2h + 独立 commit | ✅ | 单 PR 内分段 task（见 § Phase 2），30min-2h 拆 |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | **新 `chat` 叶子 ctx**（D1）；扁平文件平铺、贫血 Prisma row + `@map`、无 repository（UC 直注 `PrismaService`）；不碰他 ctx 表（accountId 来自 JWT，不读 account 表）；复用 `account/jwt-auth.guard`（平台 auth 基座，与 portfolio/alert 同款 import） |
| V. 类型同步链 Nx-driven + 单 PR | ✅ | 跨端单 PR：server impl + 真 server IT + `export-openapi` + api-client regen + mobile 消费 + 两层验证全同 PR。**注**：SSE 流式端点产 `text/event-stream` 非 JSON，**不走 orval hook**，mobile 自写 expo/fetch 客户端消费；建会话 / 取消息端点走 orval typed hook |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（PG + Redis via Testcontainers）覆盖每个新端点 ≥1 次 —— 建会话 / 取消息 / SSE 发消息（provider 用可注入的 fake stream 替身做确定性 IT，真 DeepSeek 走 env-gated IT 避免 CI 依赖外部）。
- [x] **Mobile**: golden-path 走真机/Web —— PoC 已在 **Mate50 dev-client** 实证流式发送→增量渲染→停止全链路（[poc-findings](./poc-findings.md)）；impl 期 `[Mobile-E2E]` hermetic 复验交互。
- [x] **Evidence**: [poc-findings.md](./poc-findings.md)（TTFT 假流 118ms / DeepSeek 518ms，AbortController 停止冻结）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card（新增 `openai` SDK）

| # | Question | Answer |
|---|---|---|
| Q1 | 长期维护信号？ | OpenAI 官方 SDK，周级发布、巨量下载、活跃 |
| Q2 | 已装工具能等价覆盖？ | Node 22 全局 `fetch` 可（PoC-B 已证），但手解 SSE 帧易错；`openai` 提供 typed AsyncIterable + 错误模型，对 provider-agnostic port 更干净。**取 SDK**，裸 fetch 作降级备选 |
| Q3 | 与现栈兼容？ | 纯 server Node SDK，NestJS 11 / Prisma / pnpm 无冲突；DeepSeek 仅换 `baseURL` |
| Q4 | LLM 训练覆盖 API？ | 是，`openai` SDK API 面 Claude 熟知 |
| Q5 | 解耦成本？ | 低 —— 封在 `deepseek.provider.ts` 单文件实现 `LlmProvider` port；换裸 fetch 或换 provider 不动调用方（<0.5 天） |
| Q6 | 风险面（license / CN / CVE）？ | MIT；DeepSeek 端点国内可达（PoC 实证）；key 仅 server env 不下发 |

**Evidence**: [poc-findings.md](./poc-findings.md)（同协议裸 fetch 实测通）+ DeepSeek 官方 OpenAI 兼容文档。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] feature 为 **mono-native**（全新 chat ctx，无 meta-repo Java 迁入）。
- [x] **Evidence**: N/A — chat 是 greenfield（Explore 实证全仓 0 chat/LLM 代码，[master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §0 F5）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

`rg "Open Question|未决|deferred" docs/adr/*.md` —— 无既有 ADR 的 open question 被本 feature 触发（SSE 流式 / LLM provider / chat ctx 均仓内首次，无前置 ADR 覆盖）。

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0032 | bounded context sunset trigger 何时建新 ctx | mitigated | D1 走 7 问评估，结论建 `chat` ctx；随 server PR 落一条短 ADR 记录「chat ctx + SSE 流式端点 + LlmProvider port」三个仓内首例 |

**Evidence**: 新 ADR 候选（D7），随本 feature server impl PR 落。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants（AI 绝对禁令 — 严禁违背）

- **NO LIFECYCLE MOCKING**：`JwtAuthGuard` / `AccountIdThrottlerGuard` / SSE 端点的 Filter 等 **绝对禁止** `new XxxGuard()` / `jest.mock`。必须 `Test.createTestingModule({imports:[ChatModule]}).compile()` 装真 DI 容器。
- **MANDATORY INTEGRATION**：越权（403）/ 401 / 落库语义等必须在真 DI + Testcontainers PG 中触发，不许隔离 mock。
- **EXHAUSTIVE BRANCHING**：spec `state_branches` 全 8 条每条必有对应 `it()`（含失败不落 / 停止保留 / 断连 / 越权 403 等非 happy-path）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：扁平模块（`apps/server/src/chat/` 文件平铺，**无** domain/application/infrastructure/web 子目录）；贫血数据 = Raw Prisma row（snake_case 由 schema `@map`）；**无 repository**（UC 直注 `PrismaService`）；业务不变量进 `*.rules.ts` 纯函数；护城河（chat 不碰他 ctx 表）。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：用户 msg 即时落（独立写）；AI msg 仅流正常结束/停止时落（单次 create）。无单行状态机竞争（消息 append-only）；外部 I/O（DeepSeek）**split-tx**——禁 tx 内持锁等 HTTP（流式期间不开 tx，落库是流前/流后的独立短写）。
- **安全**：会话/消息按 `accountId` 归属，UC 层 scope（他人 conversationId → 404 字节级一致，反枚举，与 alert/portfolio 同款）；key 仅 server env（FR-007）。
- **前端（mobile）**：复用 `~/theme`+`~/ui`（mockup 0 新 token）；流式消费走自写 expo/fetch 客户端（**非 orval**，SSE 非 JSON）；**中断检测用 `controller.signal.aborted` 不匹配 error message**（PoC gotcha：expo/fetch abort 抛 "Fetch request has been canceled"）；输入条非 RHF（单 textarea + 发送，无复杂表单态）。

### D1：新建 `chat` bounded context（ADR-0032 7 问评估）

> **catalog 7 问**：Q1 直改某既有 ctx 核心表？**否**（conversation/message 是全新概念，不碰 account/alert/portfolio 表）。Q2 编排多 ctx user-facing 流程？**否**（纯 chat 内聚，accountId 仅作归属，从 JWT 取不读 account 表）。Q3 纯 platform infra？**否**（是业务领域）。Q4 完全新业务领域？**是** → **建新 bounded context `chat`**（ADR-0032 sunset trigger 满足：全新领域 + 独立生命周期 + 后续 028/029 都挂它）。Q5-Q7 跨 ctx 传播？**无**（chat 是叶子，不 DI 任何业务 ctx UC，不跨 ctx 读写）。
> **物理落点**：`apps/server/src/chat/`（扁平）+ Prisma `@@schema("chat")` + ESLint boundaries / Nx tag 注册新 module（business-naming 三处一致：module 目录 / schema / 前端 `~/chat`）。`JwtAuthGuard` 从 `account/` import = 平台 auth 基座复用（portfolio/alert 既有先例，非业务跨 ctx 依赖）。
> **预留扩展**（D2 决策继承，二期）：conversation 加 `metadata Json?` 空列承接业务上下文注入（RAG/tool），027 不读写。

### D2：数据模型（schema.prisma SoT，本节仅 DESIGN INTENT）

- **`conversation`**（`@@schema("chat")` / `@@map("conversation")`）：`id BigInt @id @default(autoincrement())`、`accountId BigInt @map("account_id")`（归属，无 FK relation 同 RefreshToken/WechatBinding 先例）、`title String`（截首条派生，D5）、`model String`（如 `deepseek-chat`，单模型 027 固定默认）、`metadata Json?`（二期扩展位，027 不读）、`createdAt`/`updatedAt`。索引 `@@index([accountId, updatedAt])`（028 历史列表按更新倒序，027 先建好）。
- **`message`**（`@@map("message")`）：`id BigInt @id @default(autoincrement())`、`conversationId BigInt @map("conversation_id")`（归属，无 FK relation）、`role String`（`user` / `assistant`）、`content String @db.Text`、`status String`（`completed` / `stopped`；user msg 恒 `completed`；失败 AI msg **不落**故无 `failed` 值，Clarify）、`createdAt`。索引 `@@index([conversationId, id])`（按序取消息）。
- **贫血**：无 Domain Class / Mapper；UC 直接读写 Raw row；BigInt id 经 JSON 序列化为 string（orval 既有处理，accountId 同款）。
- **migration**：1 个新 migration（建 `chat` schema + 2 表 + 索引）；`datasource db` 的 `schemas` 列表加 `"chat"`。

### D3：SSE 流式发消息端点（Fastify `reply.hijack()`，PoC 定稿）

- **端点**：`POST /chat/conversations/{conversationId}/messages`，body `{content}`，`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`。controller 用 `@Res() reply: FastifyReply` + `reply.hijack()` + `reply.raw.writeHead(200, {SSE headers})`，**不返回 JSON**（swagger 标 `produces: text/event-stream`，response 描述为 token 流 + `[DONE]`）。
- **SSE headers**（PoC 定稿）：`Content-Type: text/event-stream`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`（prod nginx 须 `proxy_buffering off`，部署 note）；**不挂** `@fastify/compress`（未装，若日后加须排除该路由）。
- **流程**（`send-message.usecase`）：① scope 校验 conversation 归属 accountId（他人 → 404）② 落 user message（即时，FR-006）③ 取本会话历史 → `chat-context.rules` token 预算滑动窗口组 `messages[]`（D4）④ 调 `LlmProvider.stream(messages)` → `for await` 逐 token `reply.raw.write('data:'+JSON+'\n\n')` ⑤ 流正常结束 → 落 AI message（status=completed）+ 写 `data:[DONE]` + `reply.raw.end()`。
- **停止/失败**（Clarify + state_branches）：`reply.raw.on('close')` → abort 上游 DeepSeek（`AbortController`，止付 token）；客户端主动 abort（断连）视作**停止** → 落已生成半成品 AI message（status=stopped）；provider 报错/超时 → **不落 AI message**、`reply.raw.write('data:'+{error}+'\n\n')` 让客户端展示错误态 + 重试（用户 msg 已落不丢，FR-009）。
- **首发自动建会话**：空态首条消息无 conversationId → 客户端先 `POST /chat/conversations`（D6）拿 id 再发；或端点支持 conversationId 省略时 UC 内建会话（**取前者**：建会话/发消息分离，端点职责单一，客户端两步——建会话极快无流式）。

### D4：多轮上下文 = token 预算滑动窗口（`chat-context.rules` 纯函数）

- `buildContext(history: Msg[], budget): Msg[]` —— 从最新轮往回累加，估算 token（**字符启发式**：中文 ~1.5 char/token 粗估，phase 1 不引精确 tokenizer；budget 取保守值如 输入上限 留足输出余量），超 budget 丢最早轮次（Clarify）。纯函数，vitest 红绿（边界：空历史 / 单轮 / 超长截断保留最新）。
- **不做**摘要/压缩（Clarify）；budget 具体数值 = 配置常量（可 env 覆盖）。

### D5：会话标题 = 截首条用户消息（`chat-title.rules` 纯函数）

- `deriveTitle(firstUserContent): string` —— 截前 N 字（如 20）+ 去换行/trim；空兜底「新对话」。会话创建/首条消息时 set 到 `conversation.title`（028 历史列表用）。AI 生成标题留二期（Clarify）。

### D6：会话 CRUD（027 最小集，含 reload）

- `POST /chat/conversations` → 建空会话（model 默认），返回 `{id, title?, model}`。
- `GET /chat/conversations/{id}/messages` → 取本会话消息（按序，scope accountId，他人 → 404）。**027 需要**：满足 SC-002「重进后内容仍在」——客户端本地存 last conversationId，冷启 GET 重载当前会话。**028 增量**：会话**列表**（时间分组/分页）+ 搜索 + 改名 + 删除（027 不做 list）。
- 这两个非流式端点走 orval typed hook（React Query）。

### D7：LlmProvider port + DeepSeek adapter（provider-agnostic）+ 新 ADR 候选

- `llm-provider.port.ts`：`interface LlmProvider { stream(messages, opts): AsyncIterable<string> }`（吐 token 字符串）；token `AbortSignal` 透传。
- `deepseek.provider.ts`：`new OpenAI({baseURL:'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY})`，`chat.completions.create({model, messages, stream:true}, {signal})` → `for await` 出 `choices[0].delta.content`。二期 MiniMax 仅加新实现，不动 `send-message.usecase`。
- **新 ADR 候选**（随 server PR）：记录仓内三首例（chat bounded context / SSE 流式端点 Fastify reply.hijack 范式 / LlmProvider port + server-proxy LLM key 策略）——为 028/029/二期立范式锚点。

### Mobile side（`apps/mobile/src/chat/` + 首页接入，翻 mockup baseline）

- `chat-stream-client.ts`：自写 expo/fetch SSE 消费（`fetch` from `expo/fetch`，`getReader()`+`TextDecoder`+切 `\n\n` 解帧），返回 async 迭代/回调；`AbortController` 停止；**中断判定用 `signal.aborted`**（PoC gotcha）。
- `use-chat.ts`：会话态机（idle/streaming/done/error/stopped）+ 流式 token 累加 + 停止 + 重试 + 调建会话/取消息 orval hook。
- 屏组件（翻 [mockup 5 状态](./design/)）：空态（Gemini 简约 + 带昵称问候，昵称读现有 `useMe()`，未就位退通用——FR-001）/ 对话流（Kimi 气泡 + AI 头像 + 打字机 + 内容由 AI 生成）/ 输入条（尽管问 + 发送，空禁用）/ 消息操作条（复制；赞踩可后置）/ 错误态+重试 / 停止态。顶栏 hamburger 占位 + 模型名只读 + 新会话。
- `app/(app)/(tabs)/index.tsx` 接入（替换占位）。
- **测试两层**：`[Mobile-E2E]` hermetic（mock SSE 端点验空态→发送→增量→停止→错误交互）+ `[Contract-Smoke]`（打 testcontainers 真 server：登录→建会话→发消息（真 DeepSeek 或 fake provider env-gate）→取消息验落库→契约对齐）。

### Cross-cutting

- **零回归**：首页占位替换，不动其余 tab；新 chat ctx 不被任何既有 ctx import。
- **边界**：ESLint boundaries + Nx tag 注册 `chat` module；chat 不 import 业务 ctx；`JwtAuthGuard` 复用（auth 基座）。
- **perf SoT** = spec frontmatter `perf_budgets`（TTFT p95≤3s，PoC 实测 DeepSeek 518ms 宽裕）。

## Open Decisions Resolved（⚠️ plan→tasks gate review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** | chat ctx 落点 | **新建 `chat` 叶子 bounded context**（ADR-0032 7 问：Q4 全新领域）；扁平 + 贫血 + 不跨 ctx | ⚠️ review（仓内首个全新 ctx） |
| **D2** | 数据模型 | `conversation`+`message` 两表，贫血 + `@map` + `@@schema("chat")`，1 migration；conversation 留 `metadata Json?` 二期位 | ⚠️ review（schema 改动） |
| **D3** | 流式端点 | `POST /chat/conversations/{id}/messages` SSE，`reply.hijack()` raw 写（PoC 定稿） | ⚠️ review（仓内首个 SSE 端点） |
| **D4** | 上下文裁剪 | token 预算滑动窗口（字符启发式估 token），纯函数 | ✅ 默认接受 |
| **D5** | 会话标题 | 截首条用户消息纯函数 | ✅ 默认接受 |
| **D6** | 会话 CRUD 范围 | 027 = 建会话 + 取消息（reload）；list/搜索/改名/删 → 028 | ✅ 默认接受 |
| **D7** | provider 集成 + ADR | `LlmProvider` port + DeepSeek（`openai` SDK）；随 PR 落新 ADR 记三首例 | ⚠️ review（新 dep + 新范式 ADR） |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：(1) 新 `chat` ctx 是 ADR-0032 正路（全新领域），非违规。(2) SSE `reply.hijack()` 是 Fastify 原生流式正路（非 Nest `@Sse()` 的 RxJS 桥），PoC 实证。(3) 单 provider 单模型，无多 provider 路由复杂度（029）。(4) 流式端点不走 orval 是 SSE 非 JSON 的必然，自写客户端已 PoC 验证。

## Performance Budget

| 面 | 目标 |
|---|---|
| SSE 发消息端点 TTFT | spec `perf_budgets`：p95 ≤ 3000ms / p99 ≤ 6000ms（PoC 实测 DeepSeek 端到端 518ms，余量 ≥5×） |
| 建会话 / 取消息（非流式） | 标准 CRUD，无特殊预算 |

_SoT = spec frontmatter `perf_budgets`。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略（单 PR，per Constitution §V）

跨端 feature **单 PR**（`feat(chat)`）：server impl + 真 server IT + `export-openapi` + api-client regen + mobile 消费 + 两层验证全原子 merge。PR body flag「仓内首个 SSE 端点 + 首个 LLM 集成 + 首个新 ctx」+ 建议人工 review（D1/D3/D7 gate 项）。

### 建议 tasks.md 层级（每 task 30min-2h，预估 ~14-16 task）

- **Server 基座 ~6-7**：`[Server]` Prisma `chat` schema + 2 model + migration → `[Server]` `chat-context.rules` token 窗口纯函数（vitest 红绿）→ `[Server]` `chat-title.rules`（红绿）→ `[Server]` `LlmProvider` port + `deepseek.provider`（fake provider 替身供 IT）→ `[Server]` create-conversation + get-messages UC + controller（scope/404）→ `[Server]` send-message UC + SSE controller（reply.hijack + 落库 + 停止/失败语义）→ `[Server-IT]` Testcontainers 覆盖 state_branches 全 8 条（fake provider 确定性 + env-gated 真 DeepSeek）。
- **契约同步 ~2**：`[Contract]` swagger 装饰器（建会话/取消息 JSON + SSE 端点 produces 标注）→ `export-openapi` → api-client regen → `[Verify]`。
- **Mobile ~5-6**：`[Mobile]` `chat-stream-client`（expo/fetch SSE，signal.aborted）→ `[Mobile]` `use-chat` 态机 + orval hook 接建会话/取消息 → `[Mobile]` 首页屏（翻 mockup 5 状态）+ index.tsx 接入 → `[Mobile]` `chat-copy` + 空态昵称（useMe）→ `[Mobile-E2E]` hermetic（空态→发送→增量→停止→错误）→ `[Contract-Smoke]`（真 server：登录→建会话→发→取消息验落库）。
- **收尾 ~1**：新 ADR（chat ctx + SSE + LlmProvider 三首例，D7）。

> 依赖：无外部前置（DeepSeek key 已在 `.env`，PoC 已通）。`openai` SDK 随 server task 装。

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-14 | **ID-namespace**: US1-3 / FR-001..013 / SC-001..007 / state_branches ×8 | **ADR**: 0032（新 chat ctx 评估）/ 0043（扁平贫血纯函数）/ 0039（perf SoT）/ 0040（多层测试门）/ 0024（spec 布局）/ 新 ADR 候选（chat ctx + SSE 流式 + LlmProvider，随 PR 落）
