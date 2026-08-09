---
feature_id: 030-chat-web-search
spec_ref: ./spec.md
status: approved # +A1 amend (2026-06-19): D3/D4/D7/F2 推翻为 ChatGPT 式统一联网,delta 待 impl (tasks Phase 7)
created_at: '2026-06-18'
updated_at: '2026-06-19'
adr_refs: ['0024', '0032', '0039', '0040', '0041', '0043', '0055']
context7_verified: []
---

# Implementation Plan: 030-chat-web-search（AI 对话智能搜索 · DeepSeek 联网 ReAct）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `030-chat-web-search` | **架构源**: [plan 文档](../../docs/private/plans/2026-06/06-18-chat-web-search-architecture.md)（架构 C / IQS port / 手动 toggle）

> 手动模式（不用 orchestrator）→ 本 plan 无 `orchestrator_config` 块（对齐 011-029）。
> 标准 SDD：spec ✅ → clarify ✅（2026-06-18 3Q）→ **plan（本）** → tasks → implement。mockup 以 DeepSeek app「智能搜索 + 已阅读 N 个网页 + 编号引用」截图为 baseline（impl 期落 `design/`）。
> **⚠ 头号事实**：030 **复用** 027 chat 叶子 ctx + `LlmProvider`/`deepseek.provider` + SSE 链路 + 029 会话模型路由；**新增** 4 件——① `SearchProvider` port + IQS adapter（chat 自身 infra，类比 `LlmProvider`，ADR-0043 允许的 external vendor I/O port）② `LlmProvider` 接口扩展支持 tool calling（纯文本 → 事件联合，向后兼容）③ `send-message` 联网分支跑 **ReAct loop（max 3 轮）** ④ SSE 工具进度帧 + `Message.metadata` 存引用来源 ⑤ 可组合系统提示层（D8 联网 steering + 日期 context 两层，纯代码 **0 DB**；平台基座/用户自定义层留作未来独立 feature）。**一处加性可空 schema 改动**（`Message.metadata Json?`）+ 1 migration。**server 零新 npm dep**（IQS 走 HTTP API + Node 22 内建 `fetch`）；**mobile 1 新 dep**（`expo-web-browser`，来源 in-app 打开，clarify 定稿）。

> 🔄 **[Amendment A1 — 2026-06-19]** ChatGPT 式统一联网，推翻 **D3 / D4 / D7 / F2** 的「仅 DeepSeek + 手动 toggle 默认关 + MiniMax 灰显」：**移除 toggle → 联网默认常开、模型 `tool_choice='auto'` 自决；DeepSeek flash/pro + MiniMax M3 统一**（M3 经 `thinking:adaptive` + tools 透传 + `<think>` 剥离）。M3 国内站 tool-call PoC（`disabled` 不可靠 / `adaptive` 15/15 可靠+克制）+ 完整决策见 **spec Clarifications Session 2026-06-19**；落地 tasks **Phase 7（T018-T025）**。受影响决策下方标 `⚠️ A1`。**代价**：MiniMax 切 adaptive = 首字延迟↑ + 思考 token↑（反转 029 取舍，user 接受）；027「OFF 字节不变」失效（system 消息默认注入）。架构骨架（ReAct max3 / IQS port / 降级 / 来源持久化 / 不偷换 GLM）不变。

## Summary _(mandatory)_

030 = 给 027/029 的 chat 加「智能搜索」：**① server**：新增 `SearchProvider` port（`search(query,{signal,maxResults}) → SearchResult[]`）+ `IqsSearchProvider`（阿里云 IQS GenericSearch HTTP API）+ `FakeSearchProvider`（IT 替身）；扩展 `LlmProvider.stream` 产出从 `AsyncIterable<string>` 改为 `AsyncIterable<LlmStreamEvent>`（`{kind:'token'}` | `{kind:'tool_call'}`，无 tools 时行为不变）；`deepseek.provider` 透传 `tools` + 按 `index` 累加流式 `tool_calls`（含 DeepSeek「tool_call 当文本吐」双形态解析）；`send-message` 在 `webSearch=true` 时跑 **ReAct loop**（附 `web_search` 工具 → 模型自决检索 → 执行 IQS → SSE 工具帧 → 回灌结果 → 收敛，max 3 轮，失败降级）→ 落 assistant message + `metadata{webSearch,degraded,sources}` → **② mobile**：输入栏「智能搜索」toggle（per-message，默认关）；`sse-parse`/`chat-stream-client`/`chat-reducer` 扩展解析工具/来源/降级帧 → 渲染「已阅读 N 个网页」中间态 + 编号来源列表（`expo-web-browser` in-app 打开）+「本次未联网」降级标识；`ChatMessage` 加 `sources`/`degraded`，从 GET messages 的 `metadata` 冷启动回填。

- **server 段**：`apps/server/src/chat/` 扁平模块**增量** —— `search-provider.port.ts`（DI token + 接口 + `SearchResult` 类型）/ `iqs-search.provider.ts`（HTTP `fetch` 调 IQS，归一化）/ `fake-search.provider.ts`（scripted + 可注入 error/timeout，尊重 signal）/ `web-search.rules.ts`（纯函数：来源去重+编号、tool-def 常量、SSE 工具帧序列化合并进 `sse.rules.ts`）/ `system-prompt.rules.ts`（纯函数：联网 steering + 日期 context 两层 + `composeSystemPrompt` 组合器，D8）/ `config/iqs.config.ts`（zod discriminated-union `mock|aliyun`，镜像 `sms.config.ts`）。改 `llm-provider.port.ts`（事件联合 + `tools` 选项 + `Msg` 扩 tool 角色）/ `deepseek.provider.ts`（tools 透传 + tool_calls 累加）/ `minimax.provider.ts`（只吐 token 事件）/ `fake-llm.provider.ts`（支持 scripted tool_call 事件）/ `send-message.usecase.ts`（联网分支 ReAct loop）/ `send-message.request.ts`（+`webSearch`）/ `chat-stream.controller.ts`（透传 webSearch + 写工具帧）/ `chat.response.ts`（映射 `metadata`）/ `chat.module.ts`（DI `SEARCH_PROVIDER` + `CHAT_FAKE_SEARCH`）。prisma：`Message.metadata Json?` + migration。
- **mobile 段**：`apps/mobile/src/chat/` 增量 —— `chat-home-screen.tsx`（InputBar 加 toggle）/ `use-chat.ts`（`webSearch` 态 + 传 sendMessage）/ `chat-stream-client.ts`（回调加 `onToolEvent`/`onSources`/`onDegraded`）/ `sse-parse.ts`（解析工具/来源/降级帧）/ `chat-reducer.ts`（「已阅读 N」中间态 + message 挂 sources/degraded）/ 新 `web-search-sources.tsx`（来源列表 + 计数 + in-app 打开）/ `chat-copy.ts`（文案）。`ChatMessage` 类型 + GET messages hydrate sources。

**新基础设施**：server **零新 npm dep**（IQS HTTP 走内建 `fetch`；若 HTTP 受限则回退 SDK `@alicloud/iqs20241111` + 已装 `@alicloud/openapi-core`，见 D2）；mobile **1 新 dep** `expo-web-browser`（Expo 托管）；**1 加性可空 schema 改动**（`Message.metadata`）+ 新 env `IQS_*`（触部署）。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| `expo-web-browser`（mobile，新增） | FR-005 来源链接 in-app 打开（`openBrowserAsync`，iOS SFSafariViewController / Android Chrome Custom Tabs）；clarify 定稿 in-app 非系统浏览器 | [Expo WebBrowser docs](https://docs.expo.dev/versions/latest/sdk/webbrowser/) —— Expo SDK 托管模块，`expo install` 装，低风险 |
| IQS 接入：**HTTP API 优先（零 npm dep）** | `IqsSearchProvider` 用 Node 22 内建 `fetch` 调 `https://cloud-iqs.aliyuncs.com/search/genericSearch`（`X-API-Key` header）；**回退** SDK `@alicloud/iqs20241111`（复用已装 `@alicloud/openapi-core` AK/SK 签名） | [IQS HTTP API](https://help.aliyun.com/document_detail/2871439.html) / [IQS GenericSearch](https://help.aliyun.com/document_detail/2857020.html)；⚠️ impl T1 先验真连通（env-gated），HTTP 不通再走 SDK，**不预装 SDK 包**（避免 cargo-cult） |
| None（server runtime npm） | 联网 loop 复用已装 `openai ^6.42.0`（tool calling，DeepSeek OpenAI 兼容）；IQS 走 `fetch` | `apps/server/package.json` 实测 `openai ^6.42.0` / `@alicloud/openapi-core ^1.0.7` 已在 |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles（无违反，无需 Complexity justify）。

| 原则 | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅ → plan（本）→ tasks → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | `web-search.rules`（去重/编号/tool-def）= vitest 纯函数无 DB；ReAct loop + 降级 = Testcontainers PG IT（FakeLlmProvider scripted tool_call 事件 + FakeSearchProvider scripted/注入 error，覆盖 spec `state_branches` 全 15 条）；IQS 真连通 = env-gated `RUN_IQS_IT`（默认 skip，不进 CI fast suite，per perf-IT 范式）；mobile 纯逻辑（reducer 工具/来源/降级态）= vitest，UI = Playwright Expo Web e2e |
| III. Atomic 30min-2h + 独立 commit | ✅ | 单 PR 内分段 task（见 § Phase 2），30min-2h 拆；clear 检查点批次 ≤5 |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | **复用 027 chat 叶子 ctx**（catalog Q1：联网 loop 直改 chat 自己的 `message` 表 + 读会话；`SearchProvider`/`LlmProvider` 是 chat **自身 infra**，类比 sms/push gateway，非跨业务 ctx import → ADR-0043 允许的 external vendor I/O port）；扁平文件平铺、贫血 Raw Prisma row（`metadata Json` 无 mapper class）、无 repository（UC 直注 `PrismaService`）；不碰他 ctx 表（accountId 来自 JWT） |
| V. 类型同步链 Nx-driven + 单 PR | ✅ | 跨端单 PR：server（port+adapter+loop+migration）+ 真 server IT + `export-openapi` + api-client regen + mobile 消费 + 两层验证全原子 merge。契约变更：`SendMessageRequest.webSearch` + GET messages 响应 `metadata`（走 orval typed hook）；SSE send 端点仍手写（`chat-stream-client.ts` 非 orval，新增工具帧不入 openapi，与 027 同） |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（PG via Testcontainers + Fake providers）覆盖联网 send-message ≥1 次 —— FakeLlmProvider scripted「先 tool_call(web_search) → FakeSearchProvider 返结果 → 再 text」，断言：SSE 发 tool_start/tool_result 帧 + 流式 token + 落 assistant message `metadata.sources`（去重编号）；降级路径（FakeSearchProvider 注入 timeout/error）断言 `metadata.degraded=true` + 用户消息不丢；max-3-轮兜底；`webSearch=false` 维持 027 无联网行为。
- [x] **Mobile**: golden-path `[Mobile-E2E]` hermetic（Playwright Expo Web，mock SSE）—— 开 toggle→发实时问→「已阅读 N 个网页」中间态→答案+来源列表→tap 来源（mock `openBrowserAsync`）→降级态显示「本次未联网」。tap 驱动（**非手势**，per RNGH web 手势不确定 memory）。
- [x] **Evidence**: impl 期落 IT commit + Mobile-E2E spec（tasks T0xx）；IQS 真连通另走 env-gated `RUN_IQS_IT`（不阻塞 CI）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

引入 **2 个新第三方**：`expo-web-browser`（mobile）+ 阿里云 IQS（external search service，HTTP 优先）。

| # | Question | `expo-web-browser` | 阿里云 IQS |
|---|---|---|---|
| Q1 | 长期维护信号 | Expo 官方 SDK 模块，随 Expo SDK 版本维护，活跃 | 阿里云一方服务，企业级 SLA；2026 在维护（GenericSearch / IQS MCP server 官方仓） |
| Q2 | 已装工具能否等价覆盖 | `expo-linking`（已装）可开**系统**浏览器，但跳出 app；in-app 体验需 `expo-web-browser`（clarify 定 in-app） | 无——需外部 web 检索源；候选 Bocha/Tavily 同属新接入，IQS 同区低延迟最优 |
| Q3 | 与现栈兼容（Expo/NestJS/pnpm/Nx） | ✅ Expo 托管模块，`expo install` 锁版本 | ✅ HTTP API 走 Node 22 内建 `fetch`，**零 npm**；回退 SDK 复用已装 `@alicloud/openapi-core`（SMS 同源） |
| Q4 | LLM 训练覆盖（Claude 懂其 API surface） | ✅ 常见 Expo API（`openBrowserAsync`） | ⚠️ 部分——IQS 请求/响应 shape 已 Phase-0 grounding（GenericSearch + `returnMarkdownText` + `pageItems[]`），impl 以 grounding 为准不臆造 |
| Q5 | 解耦成本（换掉要多久） | 低——仅 1 处来源打开调用，换 `Linking` <1h | 低——藏在 `SearchProvider` port 后，换 Bocha/Tavily 仅加 adapter，不动 loop（<1d） |
| Q6 | 风险面（license / CN / 供应链 / CVE） | MIT，Expo 一方，低 | 阿里云一方，CN 可用、同区；⚠️ **价格/配额需 AE 报价**（spec 已 flag）；`X-API-Key` 仅 server env，不下发 |

**Evidence**: Phase-0 grounding（IQS HTTP `genericSearch` + `X-API-Key` / `pageItems[].{title,link,snippet,publishTime,markdownText}` / openai v6 流式 tool_calls 按 index 累加，见 § D2/D4 注记）。⚠️ **impl T1 硬前置**：env-gated 真 IQS 冒烟验 HTTP 端点 + key 可用；不通则切 SDK 路径（仍零代码改 loop）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] feature 为 **mono-native**（chat ctx 是 027 greenfield，无 meta-repo Java 迁入）。
- [x] **Evidence**: N/A — chat 全栈 027 新建，028/029/030 纯增量；`rg "mbw-|org.springframework" specs/030-chat-web-search/` 空。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

`rg "Open Question|未决|deferred" docs/adr/0055*.md docs/adr/0043*.md docs/adr/0032*.md` —— 030 在 0055 立的 chat ctx + `LlmProvider` 接口化 + SSE 范式上扩展：① `LlmProvider` 加 tool-calling 事件 = 0055 接口化扩展点的自然演进；② `SearchProvider` 是又一个 external vendor I/O port（ADR-0043 §「sms/push gateway 同款」明确允许，非新范式）；③ ReAct loop 是 chat ctx 内编排（非跨 ctx）。**不触发新 bounded context（ADR-0032 sunset 不响）、不引入新架构范式 → 无新 ADR**。

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0055 | chat ctx provider 接口化 / 流式扩展边界 | accepted-as-is | tool-calling 事件 + SSE 工具帧是 0055 接口化范式的扩展，无需新 ADR / amend |
| ADR-0043 | external vendor I/O port 边界 | accepted-as-is | `SearchProvider` = sms/push 同款外部 I/O port（非自有表 repository），符合 0043 §3 例外 |
| ADR-0032 | bounded context sunset trigger | accepted-as-is | 030 不建新 ctx（改 chat 自有 `message`/读会话 + chat 自身 infra），无评估触发 |

**Evidence**: N/A — 无 ADR amend / 新 ADR。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: `JwtAuthGuard` / `LlmProvider` / `SearchProvider` DI **绝对禁止** `new XxxProvider()` / `jest.mock`。必须 `Test.createTestingModule({imports:[ChatModule]}).compile()` 装真 DI 容器；LLM 走既有 **FakeLlmProvider**（027 立，本期扩 scripted tool_call 事件）+ 新 **FakeSearchProvider** env 注入（`CHAT_FAKE_LLM=1` / `CHAT_FAKE_SEARCH=1`），断言其收到的参数 + 编排行为。
- **MANDATORY INTEGRATION**: 联网 ReAct loop（tool_call→search→回灌→收敛）/ 降级（search 失败→`degraded`）/ max-3-轮兜底 / 来源去重编号 / 越权 404 / `webSearch=false` 无联网，全部在真 DI + Testcontainers PG 中触发，不许隔离 mock。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 全 **15 条**每条必有对应 `it()`（含 OFF 无联网+无 system 消息 / webSearch ON 注入 steering+日期 / 模型自决不检索 / 多轮去重 / 超时降级带标识 / 零结果不标 degraded / 上限兜底 / 流中停止中断整链 / 冷启动引用恢复 / 越权 404 / flash&pro 均可用 / MiniMax 灰显 等非 happy-path）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：扁平模块（`apps/server/src/chat/` 文件平铺，**无** domain/application/infrastructure/web 子目录）；贫血数据 = Raw Prisma row（`Message.metadata` 是 `Json?` 列，**贫血读写、无 Entity class / 无 mapper**，TS 侧用 narrow 类型断言 + 纯函数构造）；**无 repository**（UC 直注 `PrismaService`）；护城河（chat 不碰他 ctx 表，accountId 来自 JWT；`LlmProvider`/`SearchProvider`/`deepseek.provider`/`iqs-search.provider` 是 chat 自身 infra port/adapter）。030 新增文件严格沿用 027/028/029 既有文件的命名/风格。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：联网作答**外部 I/O split-tx**——`send-message` 落 user message（短写）→ **tx 外**跑 ReAct loop（多次 `LlmProvider.stream` + `SearchProvider.search` HTTP，**禁 tx 内持锁等 HTTP**）→ 终态短写 assistant message + metadata。loop 内无 DB 写（中间结果在内存累加）。abort（停止生成）透传 `signal` 至 `LlmProvider` 与 `SearchProvider`（IQS `fetch` 传 `signal`），止付 token + 取消在途检索。→ `../../docs/conventions/server-impl-playbook.md`
- **安全**：`webSearch` 端点复用 027 send `JwtAuthGuard` + scope `findFirst({where:{id,accountId}})`→404 字节级一致（反枚举）；IQS `X-API-Key`/AK-SK 仅 server env（`iqs.config.ts` boot `.parse()` 兜底），**禁下发客户端**；来源 URL 渲染前 mobile 侧仅接受 `http(s)` scheme（`openBrowserAsync` 前校验，防 `javascript:`/`file:` 注入）。
- **前端（mobile）**：toggle / 来源列表复用 `~/theme`+`~/ui`（0 新 token）；**tap 驱动 toggle**（Playwright web 确定命中）；SSE 工具帧消费走既有 `chat-stream-client.ts` expo/fetch 手写流（非 orval）；`ChatMessage.sources` 从 SSE（live）与 GET messages `metadata`（hydrate）双路同构；来源 in-app 打开 `expo-web-browser.openBrowserAsync`。→ `../../docs/conventions/mobile-impl-playbook.md`

### D1：`SearchProvider` port + IQS adapter + Fake（chat 自身 infra，类比 `LlmProvider`）

- `search-provider.port.ts`：DI token `SEARCH_PROVIDER` + `interface SearchProvider { search(query: string, opts: {signal: AbortSignal; maxResults?: number}): Promise<SearchResult[]> }`；`SearchResult = {title; url; snippet; publishedAt?: number; content?: string}`。**类比 027 `LlmProvider`**（ADR-0043 external vendor I/O port，非自有表 repository）。
- `iqs-search.provider.ts`：归一化 IQS `pageItems[]` → `SearchResult[]`（`link→url` / `publishTime→publishedAt` / `markdownText??mainText→content`）；取 `maxResults`（默认 **5**，控 context 预算；IQS 默认返 10/page）；per-search 硬超时 **8s**（perf p95≤2500ms 余量；超时 throw → loop 降级）。
- `fake-search.provider.ts`：scripted results + 可注入 error/timeout/空结果，尊重 `signal`（同 `fake-llm.provider.ts` 套路）。
- `config/iqs.config.ts`：zod **discriminated-union** `kind: 'mock' | 'aliyun'`（镜像 `sms.config.ts`），`aliyun` 分支含 `apiKey`（HTTP `X-API-Key`，主路）或 AK/SK（SDK 回退路）；boot `.parse()` 兜底。`chat.module.ts` DI：`CHAT_FAKE_SEARCH=1` → FakeSearchProvider，否则 IqsSearchProvider。

### D2：IQS 接入 = HTTP API 优先（零 npm dep），SDK 回退

- **主路（推荐）**：Node 22 内建 `fetch` POST `https://cloud-iqs.aliyuncs.com/search/genericSearch`，header `X-API-Key: <env>`，body `{query, returnMarkdownText:true, timeRange:'NoLimit'}`。**零新 npm dep**。
- **回退**：若 HTTP 端点受限/弃用，切 SDK `@alicloud/iqs20241111`（endpoint `iqs.cn-zhangjiakou.aliyuncs.com` + AK/SK，复用已装 `@alicloud/openapi-core`）。**两路同归一化到 `SearchResult`，不动 port/loop。**
- ⚠️ **impl T1 硬前置**：env-gated `RUN_IQS_IT` 真连通先验主路；不通再切回退；**不预装 SDK 包**直到确认需要（cargo-cult 防火墙）。Phase-0 grounding 已确认两路 shape，但 HTTP 端点成熟度有不确定（research flag）——故先验后用。
- ⚠️ **价格/配额/ICP**：spec 已 flag，需阿里云 AE 报价；不阻塞 dev（FakeSearchProvider 跑全部 hermetic 测试）。

### D3：`LlmProvider` 接口扩展 tool calling（向后兼容）

- `llm-provider.port.ts`：`stream` 产出 `AsyncIterable<string>` → `AsyncIterable<LlmStreamEvent>`，`type LlmStreamEvent = {kind:'token'; text:string} | {kind:'tool_call'; calls: ToolCall[]}`；`LlmStreamOptions` 加可选 `tools?: ToolDef[]`；`Msg` 扩展支持 `role:'tool'`（带 `toolCallId`）+ `role:'system'`（D8 系统提示）+ assistant 携带 `toolCalls`。
- **向后兼容**：调用方未传 `tools` → provider 永不吐 `tool_call` 事件，行为同 027（纯 token 流）。**027/029 非联网 send-message 路径只消费 `kind:'token'`，零行为变化。**
- `deepseek.provider.ts`：透传 `tools` + `tool_choice:'auto'`（FR-002 模型自决）；流式按 **`delta.tool_calls[index]` 累加**（`id`/`function.name` 取一次、`function.arguments` 分片**拼接**），`finish_reason==='tool_calls'` 收口该轮 → 吐 `{kind:'tool_call'}`；否则 `delta.content` 吐 `{kind:'token'}`。**双形态解析**：DeepSeek 偶发把 tool_call 当文本吐（research flag），加 content 内 tool-call 模式兜底解析（impl 固化正则 + IT 覆盖两形态）。
- `minimax.provider.ts`：不支持 tools，永远只吐 `{kind:'token'}`（联网只路由 DeepSeek；minimax 会话 toggle 开也降级为无联网 + `degraded`，或 UI 层禁用 toggle —— impl 择简，倾向 server 侧 minimax 忽略 tools 走无联网，前端在 minimax 下灰显 toggle）。 **⚠️ A1（2026-06-19）整条推翻**（tasks T018）：M3 国内站实测支持 tool calling，minimax.provider MUST `thinking:{type:'adaptive'}`（`disabled` 工具调用不可靠）+ 透传 `tools`/`tool_choice:'auto'` + 按 index 累加 `delta.tool_calls` + 流式剥离内联 `<think>…</think>`（跨 chunk 缓冲状态机）；与 DeepSeek 同走 loop。
- `fake-llm.provider.ts`：扩 scripted 能力——可编排「第 1 轮吐 tool_call(web_search,query) → 第 2 轮吐 text」，供 IT 驱动 loop。

### D4：`send-message` ReAct loop（联网分支，max 3 轮）

> **⚠️ A1（2026-06-19，tasks T019）**：移除 `webSearch` gate——**所有支持 tools 的会话模型（DeepSeek + MiniMax M3）默认走 ReAct loop**（附 `web_search` tool + `tool_choice:'auto'` + 默认 prepend system 消息）；模型不调 tool 则首轮 text 收敛=等价旧单轮。`webSearch` DTO 字段移除；metadata `webSearch` 冗余→改记 `searched`/由 `sources.length>0` 派生。下方 `webSearch=true/false` 分支读作「模型自决搜/不搜」。

- `send-message.request.ts` 加 `webSearch?: boolean`（默认 false，`@IsOptional @IsBoolean`）；controller 透传 `SendMessageParams.webSearch`。 _(⚠️ A1：字段移除)_
- **非联网**（`webSearch=false`）：走 027 既有单轮 stream（零改）。 _(⚠️ A1：无此分支；等价路径=模型自决不调 tool，loop 首轮即收敛)_
- **联网**（`webSearch=true`）：
  1. 组 context（含刚落 user msg）→ **prepend 一条 `system` 消息**（`composeSystemPrompt({webSearch:true, now:new Date(), locale:'zh-CN'})`，D8；置于 token 预算窗口之外、history 之前）+ 附 `web_search` 工具定义（`web-search.rules.ts` 常量）+ `tool_choice:'auto'`。
  2. `for (round=1..3)`：`LlmProvider.stream(messages, {signal, model, tools})`：
     - 吐 `{kind:'token'}` → `onToken`（controller 写 token 帧）+ 累加 `acc`（最终答案）。
     - 吐 `{kind:'tool_call', calls}` → controller 写 `tool_start` 帧（query）→ `SearchProvider.search(query)` → 写 `tool_result` 帧（count + sources 摘要）→ 累加去重来源（`web-search.rules` 编号）→ 把 assistant(toolCalls) + 每个 tool(result) 追加进 messages → `continue`（下一轮）。
     - 该轮只吐 token 无 tool_call（`finish_reason==='stop'`）→ **收敛**，break。
  3. round>3 仍要检索 → **兜底**：不再附 tools，最后一次 stream 用已有结果收敛作答（FR-010）。
  4. **降级**（FR-009）：任一 `SearchProvider.search` throw（超时/error）→ 标 `degraded=true`，停止后续检索，让模型用已有/无结果继续作答（不附 tools 再 stream 一次或就地收敛）；**user msg 已落不丢**；controller 写 `degraded` 帧。零结果**不**标 degraded（正常结果）。
  5. 终态：落 assistant message `content=acc, status, metadata={webSearch:true, degraded, sources:[{index,title,url,publishedAt}]}`；abort → status=stopped（半成品 + 已有 sources 保留）。
- **编排归属**：loop 在 `send-message.usecase` 内（chat ctx 编排，含外部 I/O，非纯函数）；纯逻辑（来源去重+编号、tool-def、SSE 工具帧序列化）下沉 `web-search.rules.ts` / `sse.rules.ts`（vitest 纯函数测）。**split-tx**：loop 全程 tx 外。

### D5：SSE 协议扩展（`sse.rules.ts`，向后兼容）

- 新增帧序列化纯函数：`toSseToolStartFrame({query})` = `data:{"tool":"web_search","status":"start","query":"..."}\n\n`；`toSseToolResultFrame({count,sources})` = `...,"status":"result","count":N,"sources":[{title,url}]...`；`toSseDegradedFrame()` = `data:{"degraded":true}\n\n`；收尾前 `toSseSourcesFrame(sources)` = 完整编号来源（供客户端 [N]→源映射）再 `SSE_DONE`。
- token/DONE/error 帧**不变**（027 契约稳定）；mobile `sse-parse.ts` 按 payload 字段分派（`token`/`tool`/`degraded`/`sources`/`error`/`[DONE]`）。

### D6：`Message.metadata` schema（唯一 schema 改动，加性可空）

- prisma `Message` 加 `metadata Json? @map("metadata")`（Conversation 已有同款范式）。**migration 加性可空，安全**（旧消息 null = 无联网/无来源，正常渲染）。
- 存 `{webSearch:boolean, degraded:boolean, sources:[{index,title,url,publishedAt}]}`；来源**去重**（同 URL 合一）+ 编号全局唯一（`web-search.rules`）。
- `chat.response.ts`：GET messages 响应映射 `metadata`（贫血——直接透 JSON narrow 类型，无 mapper class）；`@ApiProperty` 显式声明 nullable 结构（注意 nullable 字段 `type` 显式，per orval objectmap 坑 memory）。

### D7：mobile 消费（toggle + 中间态 + 来源 + 降级 + in-app 打开）

- `chat-home-screen.tsx` InputBar 加「智能搜索」toggle（pill，对齐 DeepSeek）；`use-chat.ts` `webSearch: boolean`（默认 false，per-message，发送后**不**自动关——对齐 DeepSeek 留态；切会话/新建回默认关）；传 `sendMessage(content, {webSearch})`。**MiniMax 模型下 toggle 灰显不可用**（`model==='minimax'`→disabled + 视觉灰显，点击无效，FR-001；联网只 DeepSeek）。 **⚠️ A1（2026-06-19，tasks T022）整条推翻**：删 toggle pill + `webSearch` 态 + minimax 灰显逻辑；联网默认常开、模型自决，MiniMax 同样可联网。中间态/来源/降级渲染保留。
- `chat-stream-client.ts` 回调加 `onToolEvent(e)`/`onSources(s)`/`onDegraded()`；`sse-parse.ts` 解析新帧；`chat-reducer.ts` 加 `searchProgress`（「已阅读 N 个网页」中间态，answer 开始时过渡）+ message 挂 `sources`/`degraded`。
- 新 `web-search-sources.tsx`：assistant 气泡上方「已阅读 N 个网页 ›」可折叠 + 答案下方编号来源列表（tap → `expo-web-browser.openBrowserAsync(url)`，http(s) 校验）；降级 message 显「本次未联网，基于已有知识作答」标识。
- `ChatMessage` 类型加 `sources?: Source[]` + `degraded?: boolean`；GET messages hydrate 时从 `metadata` 回填（冷启动 SC-003）。
- **inline `[N]` 跳源降二期**（spec 范围红线）：一期答案文本里 LLM 产出的 `[N]` 是普通文本，点击精确跳源不做；来源列表整体可点开。

### D8：可组合系统提示层（composable system prompt，business mitigation for F1）

> **业界确认（2026-06-18 联网核实）**：开了联网开关 = 给模型工具能力、**模型自决**（`tool_choice='auto'`），DeepSeek/Claude/Gemini/Kimi/Qwen 全行业如此（仅 Perplexity 强制 always-RAG）。对「开了却不搜实时问题」的标准 mitigation **不是** forced search（那会搜「你好」烧额度），而是 **steering 系统提示 + 当前日期 grounding + 模型质量**。源：OpenAI prompt-guidance / Anthropic context-engineering / OWASP LLM injection / Gemini dynamic-retrieval。

- `apps/server/src/chat/system-prompt.rules.ts`（**纯函数，ADR-0043 `*.rules.ts`**，chat **首次引入 system prompt**）：
  - `SystemPromptContext = { webSearch: boolean; now: Date; locale?: string }`（无 `userCustom` 字段——未来 feature 再加，YAGNI）。
  - 两个真实层（pure `(ctx) => string | null`，独立可测）：① `webSearchSteering(ctx)`（webSearch 时返「联网已开，实时/最新/时效类问题（天气/新闻/行情/今日/最近）优先 web_search 检索再答 + 标来源；寒暄/稳定常识可不搜」）② `dateContext(ctx)`（webSearch 时返「当前时间 = `{formatLocalDate(now, locale)}`，用于理解今天/本周/最近」——grounding 关键，`now` 注入→纯函数可测）。
  - `composeSystemPrompt(ctx): string | null`：按**固定优先级有序列表** `[webSearchSteering, dateContext]` map→filter(非 null)→`join('\n\n')`；空则返 null。
- **接缝即扩展点**（无 speculative dead code）：未来「平台基座层」prepend 到列表首（最高优先级）、「用户自定义提示词层」append 到列表尾（最低优先级 + 标注「不得覆盖以上」+ 注入沙箱），各为**独立未来 feature**（账号级 DB + 配置端点 + 设置 UI）。**030 不落空 stub**——加层 = 加纯函数 + 插列表对应位 + context 加字段，零重构。优先级序（平台→模式→上下文→用户）写注释备查。
- **集成**：仅 `send-message` 联网分支调 `composeSystemPrompt` 并 prepend `{role:'system', content}`（D3 `Msg` 加 `'system'`；置于 token 窗口外、history 前）；**非联网路径不调、不注入 → 027 字节零回归**。
- **安全/护城河**：030 两层均平台代码（无用户输入入 prompt），无注入面；未来用户自定义层落地时按 instruction-hierarchy（平台>模式>上下文>用户）+ 沙箱，届时新 feature 自带 threat model。

### Cross-cutting

- **零回归**：`webSearch=false` 完全走 027 路径（IT 显式断言）；非联网不注入 system 消息（D8）；`LlmProvider` 接口扩展向后兼容（无 tools = 纯 token）；新 SSE 帧前缀不冲突旧解析；新端点字段加性。
- **边界**：所有改动落既有 `ChatModule`，无新 module；ESLint boundaries 不变（chat 仍叶子，不 import 业务 ctx；`SearchProvider` 是 chat 自身 infra）。
- **perf SoT** = spec frontmatter `perf_budgets`（单次 search p95≤2500ms / 中间态首现 p95≤3000ms）；IQS per-search 硬超时 8s 为降级阈值（> 预算上限留余量）。
- **AI 合规**：联网来源标识本就是引用 UI 一部分；继承 027 内容标识 gate，不阻塞 dev。

## Open Decisions Resolved（⚠️ plan→tasks gate review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** | 搜索接入抽象 | `SearchProvider` port + IQS adapter + Fake（chat 自身 infra，类比 LlmProvider；ADR-0043 external I/O port） | ✅ 默认接受 |
| **D2** | IQS 接入方式 | **HTTP API + `X-API-Key`（零 npm dep）主路**，SDK `@alicloud/iqs20241111` 回退；impl T1 env-gated 真连通先验 | ⚠️ review（HTTP 端点成熟度不确定 + 价格待 AE） |
| **D3** | LlmProvider tool 扩展 | `stream` 产出事件联合 + `tools` 选项，向后兼容（无 tools=纯 token）；deepseek 累加 tool_calls + 双形态解析 | ⚠️ review（改 027 既有接口 + 029 minimax/router） |
| **D4** | send-message loop | 联网分支 ReAct loop（max 3 轮 + 降级 + split-tx）；非联网走 027 单轮零改 | ⚠️ review（改 027 核心发送链路） |
| **D5** | SSE 协议 | 加 tool_start/tool_result/degraded/sources 帧，token/DONE/error 不变 | ✅ 默认接受 |
| **D6** | schema | `Message.metadata Json?` 加性可空 + 1 migration；存 webSearch/degraded/sources | ⚠️ review（唯一 schema 改动） |
| **D7** | mobile 消费 | toggle（per-message 默认关）+ 中间态 + 来源列表 + 降级标识 + `expo-web-browser` in-app；inline [N] 跳源降二期 | ✅ clarify 定稿（in-app + 降级标识） |
| **D8** | 可组合系统提示层 | `system-prompt.rules.ts` 两层纯函数（联网 steering + 日期 context）+ 组合器接缝（**0 DB、不预置空 stub**）；平台基座/用户自定义层=独立未来 feature | ✅ analyze remediation（scope 边界经 user 确认） |
| **F1** | 联网触发 | `tool_choice='auto'`（业界确认，**不强制搜**）+ D8 steering 提示压「开了不搜」风险；SC-001 = best-effort | ✅ 联网核实定稿 |
| **F2** | MiniMax 联网 | ~~前端 toggle 灰显不可用（不支持工具调用）~~ → **⚠️ A1（2026-06-19）推翻**：M3 国内站实测支持 tool calling（`thinking:adaptive`，15/15），与 DeepSeek 统一默认联网、无灰显（tasks T018/T022/T023） | 🔄 A1 amend |
| **D3'/D4'/D7'** | A1 统一联网 | 去 toggle + 默认常开 + 模型自决 + MiniMax M3 经 adaptive 纳入；DTO 去 `webSearch`；027 字节兼容失效（system 默认注入） | 🔄 A1 amend（spec Session 2026-06-19；tasks Phase 7） |
| **F3** | 中间态 N 语义 | N=累计原始页数（贴 DeepSeek）；来源列表=去重引用数；可不等 | ✅ analyze remediation |
| **调参** | top-K / 超时 / tool_choice | search top-K=**5** / per-search 硬超时 **8s** / max **3** 轮 / `tool_choice='auto'` | ✅ plan 定 |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：(1) `SearchProvider`/IQS 是 chat 自身 external I/O port（ADR-0043 §3 sms/push 同款），非跨 ctx、非自有表 repository。(2) `LlmProvider` 接口扩展为事件联合是支持 tool calling 的最小破坏改动，向后兼容保 027/029 零回归。(3) IQS 走 HTTP `fetch` 而非预装 SDK = cargo-cult 防火墙（先验后用）。(4) `Message.metadata Json?` 单列承载来源，避免新建 `source` 表（一期来源不需独立查询/索引，贫血 JSON 足够；若二期需按来源检索再演进）。

## Performance Budget

| 面 | 目标 |
|---|---|
| 单次 `web_search` 检索往返（IQS） | spec `perf_budgets`：p95≤2500ms / p99≤5000ms；硬超时 8s → 降级 |
| 「已阅读 N 个网页」中间态首现 | spec `perf_budgets`：p95≤3000ms / p99≤6000ms |
| 非联网 send-message | 不新增预算（027 既有 SSE 流式预算不变） |

_SoT = spec frontmatter `perf_budgets`。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略（单 PR，per Constitution §V）

跨端 feature **单 PR**（`feat(chat)`）：server（port+adapter+LlmProvider 扩展+loop+migration）+ 真 server IT + `export-openapi` + api-client regen + mobile 消费 + 两层验证全原子 merge。**触部署**（新 env `IQS_*`）→ 改 `docker-compose.tight.yml` + `deploy.yml`（先读 `ops/runbook/prod-deploy-rollback.md`），PR body 勾「部署存活前置确认」3-checkbox。`Message.metadata` migration 入 PR。**建议 PR 描述 flag**：D2（IQS 接入待真连通验证）+ D3/D4（改 027 核心链路）+ schema migration 供 reviewer 关注；改 027 发送链路 + migration 属较高风险，**倾向人工合并复核**（不接 auto-merge，待 user 定）。

### 建议 tasks.md 层级（每 task 30min-2h，预估 ~12-15 task）

- **Server 基建 ~3**：`[Server]` `SearchProvider` port + `web-search.rules`（去重/编号/tool-def 纯函数 + vitest）→ `[Server]` `iqs.config.ts`（zod union）+ `IqsSearchProvider`（HTTP fetch 归一化）+ `FakeSearchProvider` + DI 接线 → `[Server-IT]` env-gated `RUN_IQS_IT` 真连通冒烟（验 D2 主路；不通切回退）。
- **Server LlmProvider 扩展 ~2**：`[Server]` `llm-provider.port` 事件联合 + `Msg` 扩 tool 角色 + `deepseek.provider` tool_calls 累加/双形态 + `minimax`/`router`/`fake-llm` 适配（+ 各 spec 改）→ `[Server-IT]` provider 层 tool 事件闭环（FakeLlmProvider scripted）。
- **Server loop + schema ~3**：`[Server]` prisma `Message.metadata` + migration → `[Server]` `send-message` 联网分支 ReAct loop（max3 + 降级 + split-tx）+ `send-message.request` webSearch + controller 工具帧 + `sse.rules` 新帧 → `[Server-IT]` Testcontainers 覆盖 `state_branches` 全 15 条（联网去重编号 / 降级带标识 / 零结果不 degraded / 上限兜底 / OFF 无联网 / 停止中断 / 越权 404）。
- **契约同步 ~1**：`[Contract]` swagger（`webSearch` + GET messages `metadata` nullable 显式 type）→ `export-openapi` → api-client regen → `[Verify]` mobile typecheck 绿。
- **Mobile ~4-5**：`[Mobile]` `sse-parse` + `chat-stream-client` 回调 + `chat-reducer` 工具/来源/降级态（vitest）→ `[Mobile]` `use-chat` webSearch 态 + `ChatMessage` sources/degraded + GET messages hydrate → `[Mobile]` InputBar toggle + `web-search-sources.tsx`（中间态计数 + 来源列表 + `expo-web-browser` in-app + 降级标识）→ `[Mobile-E2E]` hermetic（toggle→中间态→来源 tap→降级态）→ `[Contract-Smoke]`（真 server + Fake providers：登录→建会话→`webSearch=true` 发→验 SSE 工具帧 + sources 落库 + GET messages 回填）。

> 依赖：无外部前置（chat ctx + provider 接口 + SSE 027 已 ship；会话切换 028；模型路由 029 已 ship）。新 dep：mobile `expo-web-browser`（`expo install`）；server 零新 npm（IQS HTTP fetch）。新 env：`IQS_*`（部署门）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-18 | **ID-namespace**: US1-3 / FR-001..013 / SC-001..008 / state_branches ×15 | **ADR**: 0055（chat ctx + provider 接口化，027 立）/ 0043（扁平贫血 + external I/O port）/ 0032（catalog Q1 复用既有 ctx）/ 0040（多层测试门）/ 0039（perf SSOT）/ 0041（config 范式）/ 0024（spec 布局）—— **无新 ADR**（030 在 0055/0043 范式内扩展）
