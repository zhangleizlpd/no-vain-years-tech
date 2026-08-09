---
feature_id: 030-chat-web-search
modules: [chat]
owners: ['@zhangleizlpd']
status: implemented # A1 amend (2026-06-19): ChatGPT 式去开关 + 默认常开 + MiniMax 纳入,T018-T025 全 ship (gate 全绿 + contract-smoke 14/14)
created_at: 2026-06-18
updated_at: 2026-06-19
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: 'A1（2026-06-19）后无「智能搜索」toggle（联网默认常开、模型自决）；中间态「已阅读 N 个网页」+ 来源列表为 SSE 事件驱动的普通视图，Web export 路径可渲染但流式 tool 事件解析在 web 待 e2e 冒烟。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 性能预算 (per ADR-0039 SSOT). 联网作答的关键体验 = 搜索往返 + 搜索后首 token 落地时延。
perf_budgets:
  - endpoint: '单次 web_search 检索往返 (工具后端 search)'
    p95_ms: 2500
    p99_ms: 5000
  - endpoint: '开启智能搜索后「已阅读 N 个网页」中间态首次呈现'
    p95_ms: 3000
    p99_ms: 6000

# 状态机分支穷举 (per ADR-0040 multi-layer test gate). A1（2026-06-19）：联网默认常开、模型自决、无 OFF/灰显态。
state_branches:
  - '联网常开（无开关）+ 寒暄/常识/写作类（如「你好」「解释递归」）-> 模型自决不检索，直接作答，零搜索成本（等价旧 OFF 的零成本路径；M3 adaptive 实测 9/9 不触发）'
  - '联网常开 + 实时类问题 -> 模型按需检索 -> 出「已阅读 N 个网页」中间态 -> 流式出带编号引用的答案 -> 来源列表可点开（M3 adaptive 实测 6/6 触发）'
  - '模型多轮检索（细化 query）-> N 累加，来源去重，编号全局唯一稳定'
  - '检索后端超时/失败 -> 降级为无联网作答 + 该条消息带可见「本次未联网」标识（degraded 元数据），不丢用户消息、不整条失败'
  - '搜索零结果 -> 模型据空结果作答（说明未检索到），不崩、不整条失败'
  - '搜索轮数达上限（3 轮）兜底 -> 停止继续检索，用已有结果收敛作答'
  - '027 流式作答（含搜索阶段）进行中 -> 停止生成可中断整条检索-作答链路（复用 027/028 停止语义），已落库内容不丢'
  - '冷启动重进含联网作答的历史会话 -> assistant 消息恢复显示当时引用来源'
  - '联网作答的会话切换（028 抽屉）-> 历史 assistant 消息引用随会话恢复，不串话'
  - '越权对他人会话发起联网作答 -> 404（accountId 归属校验，字节级一致反枚举，与 027/028/029 同款）'
  - '未认证/token 失效 -> 401（触发 003 refresh 拦截器 retry-once；仍失败则登出）'
  - 'DeepSeek flash/pro 与 MiniMax M3 三模式下联网均可用 -> 作答模型始终为用户所选模型（不替换为他模型；A1 纳入 M3）'
  - 'MiniMax M3 模型下 -> 经 thinking:adaptive + tool calling 同样支持联网自决（A1 推翻旧「灰显不可用」；provider 须剥离内联 <think>…</think>）'
  - 'system 消息（联网 steering + 当前日期 context）默认注入（无 OFF 态）-> chat 默认带 system prompt，027「OFF 字节不变」不再成立（A1 预期变化，非回归）'
---

# Feature Specification: AI 对话智能搜索（联网 / web search）

> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> 跨端 feature（server + mobile）。流程：`spec → /speckit-clarify → mockup（design/，以 DeepSeek app「智能搜索 + 已阅读 N 个网页 + 编号引用」截图为 baseline）→ plan → tasks → impl`。impl 单 PR（server impl + 真后端 IT + api-client regen + mobile 消费同 PR，per Constitution §V）。mobile 落正交两层：① `[Mobile-E2E]` hermetic UI e2e（验 toggle 开关 / 中间态计数 / 来源列表渲染与点开 / 冷启动引用恢复）+ ② `[Contract-Smoke]` 契约冒烟（打 testcontainers 真 server + fake 搜索后端，验联网作答契约对齐 + 来源真落库）。
>
> 📐 **[架构决策 SoT]** 本 feature 是「AI 对话首页」大模块的子 feature 030。**已锁定的架构决策见 [docs/private/plans/2026-06/06-18-chat-web-search-architecture.md](../../docs/private/plans/2026-06/06-18-chat-web-search-architecture.md)**（架构 C 自建 ReAct tool-call loop / 搜索后端接口化 port + 阿里云 IQS adapter / 手动 toggle 默认关 / DeepSeek 本尊作答不偷换模型）。**复用 027 已建的 `chat` 限界上下文 + `LlmProvider` 适配器接口 + SSE 流式链路 + `conversation`/`message` 两表**；不新建 bounded context；新增：搜索后端适配层、模型工具调用（tool calling）能力、SSE 工具进度帧、assistant 消息引用来源元数据（预计一处加性可空 schema 改动）。
>
> ⚠️ **[范围红线]** 030 = **「智能搜索」开关 + DeepSeek 联网读网页作答 + 「已阅读 N 个网页」中间态 + 编号引用来源（查看/打开/持久化）+ 搜索失败降级**。**不**含：原生联网模型（GLM/Qwen）偷换路由（明确要求 DeepSeek 本尊作答）、对自有文档库的 RAG（向量检索）、inline `[N]` 点击精确跳源（一期先做来源列表 + 计数，inline 跳源降二期）、搜索结果原文长期留存（仅持久化最终引用的来源元数据）、多 provider 搜索后端同时在线（一期单 IQS，port 后可换）、账号级联网偏好（开关是 per-message，不跨会话记忆）、**平台级系统提示词管理 + 用户自定义提示词**（账号级 DB 存储 + 用户可配置设置 UI + 注入沙箱）—— 那是**独立未来 feature**，030 仅落「可组合系统提示层」的接缝（有序纯函数列表 + context 形状）+ **联网 steering 层 + 当前日期 context 层**两层（纯代码、**不动 DB**、不预置空 stub）。**承接** 027（流式发送 + 停止生成 + LlmProvider 接口）/ 029（flash/pro 双模式路由）。
>
> 🔄 **[Amendment A1 — 2026-06-19]** ChatGPT 式统一联网：**移除「智能搜索」开关 → 联网默认常开、模型 `tool_choice='auto'` 自决；DeepSeek（flash/pro）+ MiniMax M3 统一纳入，无"灰显不可用"模型**。推翻原「手动 toggle 默认关 / 仅 DeepSeek / MiniMax 灰显」三项决策；其余架构（ReAct max 3 轮 / IQS port / 降级 degraded / 来源持久化 / 不偷换 GLM）不变。完整决策 + M3 国内站 tool-call PoC 证据见 ↓ Clarifications **Session 2026-06-19**；受影响 FR/SC/Edge/Assumption 已就地标 `⚠️ A1`。

## Clarifications

### Session 2026-06-19（Amendment A1：ChatGPT 式统一联网 — 去开关 + 默认常开 + MiniMax M3 纳入）

> 本 session **推翻** 030 原「手动 toggle 默认关 / 仅 DeepSeek 联网 / MiniMax 灰显」三项决策。受影响条目下方/行内已标 `⚠️ A1`，原文保留为已 ship 记录。

- **决策**：对齐 ChatGPT/豆包式体验——**移除「智能搜索」开关**，联网工具对所有支持工具调用的会话模型**默认常挂**，是否检索由模型 `tool_choice='auto'` **自决**；**DeepSeek flash/pro + MiniMax M3 统一**纳入联网，不再有"灰显不可用"模型、无 per-message 开关、无账号偏好。
- **PoC 证据（2026-06-19 实测 MiniMax M3 国内站 `api.minimaxi.com`）**：
  - M3 国内站**支持** OpenAI 兼容 function calling：非流式 `finish_reason: tool_calls`、流式 `delta.tool_calls` 标准 index 累加形态、回灌结果后 ReAct 闭环正常收敛。
  - **`thinking:disabled`（029 prod 现状）下工具调用不可靠**——两跑一调一摆烂（直接「我无法获取实时信息」不调工具）；**`thinking:adaptive` 可靠且克制**：需联网 query 6/6 触发、闲聊/常识/写作 9/9 不触发（合计 **15/15**）。`thinking` 合法值仅 `adaptive`/`disabled`（无 `enabled`）。
  - 故 MiniMax 纳入联网的代价 = ① `thinking` 由 `disabled` 切 `adaptive` ② provider 透传 `tools` + 解析流式 `tool_calls`（按 index 累加，抄 deepseek.provider）③ 剥离 content 内联 `<think>…</think>`（跨 chunk 缓冲的状态机，实测 `<think>` 标签会被拆在 chunk 边界）。
- **新增代价（已与 user 对焦 2026-06-19 接受）**：MiniMax 切 `adaptive` 反转 029「关思考求首字快/省钱」取舍——首 token 延迟↑、多付思考 token；DeepSeek 不受影响（本就支持 tools、未关思考）。
- **对 027 字节兼容影响**：联网 system 消息（steering + 日期 context）现**默认注入**（无 OFF 态），027「OFF 路径字节不变」不再成立——chat 默认带 system prompt 的预期变化，非回归。
- **交付**：本 amend 仅改 spec；plan/tasks 增量随后——建议 **server 先行**（minimax `adaptive` + tools 透传 + `<think>` 剥离 + send-message 默认走 ReAct loop + 移除 `webSearch` gate）→ **mobile 跟进**（删 `WebSearchPill` + `webSearch` 态 + minimax 灰显逻辑），单 PR per Constitution §V。

### Session 2026-06-18（/speckit-clarify 定稿）

- Q: 一次作答的检索轮数上限（影响 ReAct loop 终止条件、IT 断言、最坏延迟/成本）？ → A: **3 轮**——初检 + 一轮按需细化 + 一轮兜底，覆盖绝大多数实时类问题，延迟/成本可控；达上限用已有结果收敛作答。
- Q: 搜索失败/超时降级无联网作答时，是否给用户显式可见标识？ → A: **是**——该条 assistant 消息 MUST 呈现可见的「本次未联网」提示，并落 `degraded` 元数据随消息持久化（避免图二式静默误导，且 E2E 可断言）。
- Q: 引用来源链接的打开方式（影响 mobile 依赖）？ → A: **in-app 浏览器**——用 `expo-web-browser` 的 `openBrowserAsync` 留在 app 内打开（iOS SFSafariViewController / Android Chrome Custom Tabs），非系统外部浏览器、非内嵌 webview。

### Session 2026-06-18（/speckit-analyze remediation，联网核实业内实践）

- Q: 用户开了智能搜索 = 强制每条都搜，还是模型自决？ → A: **模型自决（`tool_choice='auto'`）**——对齐 DeepSeek/Claude/Gemini/Kimi/Qwen 全行业（仅 Perplexity 强制）；靠**注入「联网 steering」系统提示 + 当前日期 context + 模型质量**把「开了却不搜实时问题」的风险压到业界标准 best-effort，**不**强制首轮搜（否则「你好」也会烧搜索）。
- Q: 系统提示词分层（平台基座/模式/上下文/用户自定义）是否属 030？ → A: **否**——030 仅实装「联网 steering」+「当前日期 context」两层纯函数 + 组合器接缝（**0 DB**）；**平台基座层 + 用户自定义提示词层 = 独立未来 feature**（账号级 DB + 配置端点 + 设置 UI + 注入沙箱，用户可配），030 只留接缝、不预置空 stub。
- Q: MiniMax 模型下智能搜索 toggle？ → A: **前端灰显不可用**——MiniMax 不支持工具调用、不能联网；灰显（非静默降级）让用户明确知道该模型无联网。 **⚠️ A1（2026-06-19）推翻**：实测 M3 国内站支持 tool calling（`thinking:adaptive`），MiniMax 同样默认联网、无灰显（见 Session 2026-06-19）。
- Q: 「已阅读 N 个网页」N 的语义？ → A: **N = 累计检索命中的原始页数**（贴 DeepSeek 语义）；答案下方「来源」列表 = **去重后被引用的来源数**；两者可不等（N ≥ 来源数）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 开启智能搜索得到带实时网页的引用作答 (Priority: P1)

用户在对话首页输入栏点亮「智能搜索」开关（正交于「快速/思考」模型切换），问一个实时类问题（如「上海今天天气如何」）。系统让当前 DeepSeek 模式具备联网搜索能力：模型按需检索实时网页，界面先呈现「已阅读 N 个网页」的中间态（N 随检索推进更新），随后流式输出**由 DeepSeek 本尊**基于检索内容生成、带编号引用的答案。这是 030 的 MVP 核心——只实现这一条，用户已能「就实时事实联网提问并得到可溯源的答案」，解决当前「我无法提供实时信息，请手动开联网」的死路。

> **⚠️ A1（2026-06-19）**：本故事的"点亮开关"前提作废——无开关，联网默认常开、模型自决；下方 Acceptance Scenario 1/4 的"点亮/开启"读作"直接发送"。模型按需检索 → 中间态 → 带引用作答的核心链路不变，且作答模型扩为 DeepSeek flash/pro **或 MiniMax M3**。

**Why this priority**: 没有「开启 → 联网检索 → 带引用作答」，智能搜索功能不成立。这是 030 的脊柱，来源查看/持久化与失败降级都挂在它建立的检索-作答链路上。

**Independent Test**: 用一个登录账号，在某会话开启智能搜索，问当日天气类问题，验证：① 出现「已阅读 N 个网页」中间态且 N > 0；② 答案内容反映实时信息（与关闭智能搜索时的「无法提供实时信息」形成对比）；③ 答案带编号引用；④ 服务端可断言作答模型为用户所选 DeepSeek 模式（flash/pro）。

**Acceptance Scenarios**:

1. **Given** 用户在某会话且智能搜索默认关闭，**When** 点亮输入栏「智能搜索」开关并发实时类问题，**Then** 界面呈现「已阅读 N 个网页」中间态，随后流式出带编号引用的实时答案。
2. **Given** 智能搜索开启且模型正在检索，**When** 检索逐步完成，**Then** 「已阅读 N 个网页」计数随检索推进更新，最终过渡到答案流。
3. **Given** 智能搜索开启，**When** 答案生成完成，**Then** 答案由当前所选 DeepSeek 模式（flash/pro）本身生成（服务端按会话模型路由，不替换为其他模型）。
4. **Given** 智能搜索开启且问寒暄类（如「你好」），**When** 发送，**Then** 模型自决不检索、直接作答，不产生「已阅读 N 个网页」、不消耗搜索。

---

### User Story 2 - 引用来源可查看与持久化 (Priority: P2)

联网作答完成后，答案下方呈现编号「来源」列表（标题 + 链接），用户可点开任一来源查看原网页。该次作答的引用来源随这条 assistant 消息持久化；用户冷启动重进 App、或经会话抽屉切回这个历史会话时，该条消息仍显示当时的引用来源。

**Why this priority**: 「来源可溯源 + 持久化」让联网答案可信且历史可复查，但非「联网作答」的最小闭环，列 P2。建立在 US1 的检索-作答链路 + 028 的会话切换/冷启动 hydrate 之上。

**Independent Test**: 开启智能搜索完成一次联网作答，验证答案下方来源列表可点开对应网页；杀掉重开 App 进同一会话 / 经抽屉切走再切回，验证该 assistant 消息引用来源仍在。

**Acceptance Scenarios**:

1. **Given** 一次联网作答完成，**When** 查看该 assistant 消息，**Then** 下方呈现编号来源列表（标题 + 可打开链接）。
2. **Given** 模型在一次作答内检索多轮，**When** 来源列表生成，**Then** 重复 URL 去重、编号全局唯一稳定（同一来源不重复列、不串号）。
3. **Given** 某会话有一条联网作答消息，**When** 用户冷启动重进 App 打开该会话，**Then** 该消息仍显示当时引用来源（持久化恢复）。
4. **Given** 会话 A 有联网作答、会话 B 无，**When** 经 028 抽屉在 A↔B 间切换，**Then** A 的引用来源随会话恢复、不串到 B。

---

### User Story 3 - 搜索失败与无结果的稳健降级 (Priority: P3)

当搜索后端超时、报错或返回零结果时，系统不让整条消息失败、不丢用户已发消息：模型降级为无联网作答（并适当说明「未能联网检索/未检索到」），用户仍得到一个回复。搜索轮数有上限兜底，达上限即用已有结果收敛作答，防止无限检索拖死请求。

**Why this priority**: 联网链路引入外部依赖（搜索后端），其失败必须优雅降级以保住对话可用性，但属健壮性而非「联网作答」主干，列 P3。建立在 US1 链路之上。

**Independent Test**: 注入搜索后端失败/超时/零结果（fake 后端可注入），验证用户消息不丢、不整条失败、仍得到降级回复；注入模型连续多轮检索，验证达上限兜底后收敛作答。

**Acceptance Scenarios**:

1. **Given** 智能搜索开启，**When** 搜索后端超时或报错，**Then** 系统降级为无联网作答（含说明），用户消息不丢、不整条失败。
2. **Given** 智能搜索开启，**When** 搜索返回零结果，**Then** 模型据此作答（说明未检索到相关网页），不崩溃。
3. **Given** 模型连续发起检索，**When** 达到搜索轮数上限，**Then** 停止继续检索、用已有结果收敛作答。
4. **Given** 联网作答（含搜索阶段）流式进行中，**When** 用户点「停止生成」，**Then** 整条检索-作答链路中断（复用 027/028 停止语义），已落库内容不丢。

---

### Edge Cases

- **智能搜索关闭（默认）**：发送维持现有无联网行为，完全不触发检索、不出中间态、不产生来源——零额外成本。 **⚠️ A1**：无"关闭"态，等价路径 = 模型自决不检索。
- **开关是 per-message**：智能搜索为当条消息的发送属性（对齐 DeepSeek），不跨会话记忆为账号偏好；切会话/重进不自动开启。 **⚠️ A1**：开关已移除，联网默认常开、模型自决，本条作废。
- **模型自决不检索**：智能搜索开启 ≠ 强制每条都搜；由模型按问题是否需要实时信息自决（ReAct），寒暄类不烧搜索。
- **搜索后端超时/失败**：降级无联网作答 + 该条消息带可见「本次未联网」标识（`degraded` 元数据），用户消息已落不丢（继承 027 FR-006）。
- **搜索零结果**：模型据空结果作答（属正常结果、不标 `degraded`），不整条失败。
- **多轮检索来源去重**：同一 URL 跨多次检索只列一次、编号唯一稳定。
- **搜索轮数上限**：上限 3 轮，达上限兜底收敛作答，防失控/防成本爆炸。
- **流式进行中停止**：停止生成中断整条检索-作答链路；已落库内容不丢（复用 027 停止 / 028 FR-011）。
- **越权他人会话联网作答**：非本人 conversationId 返回 404（字节级一致反枚举，与 027/028/029 同款）。
- **未登录/token 失效**：走现有 401 → 003 refresh 拦截器 retry-once；仍失败则登出。
- **历史/无来源消息**：无引用来源的 assistant 消息（关搜索时的回复 / 旧消息）正常渲染，不显示来源区、不崩。
- **作答模型一致性**：flash/pro 任一模式下智能搜索均可用，作答始终是用户所选 DeepSeek 模式，不被替换为他模型。
- **MiniMax 下 toggle**：当前会话模型为 MiniMax（不支持工具调用）时，智能搜索 toggle 灰显不可用，点击无效、不发起联网，不静默降级。 **⚠️ A1（2026-06-19）整条推翻**：实测 M3 国内站支持 tool calling（`thinking:adaptive`），MiniMax 与 DeepSeek 一样默认联网、模型自决；无灰显态。provider 须把 `thinking` 由 `disabled` 切 `adaptive` 并剥离内联 `<think>…</think>`。
- **日期 grounding**：联网作答注入当前日期 context，模型据此正确理解「今天/本周/最近」（否则可能以训练截止日为「今天」抓错实时信息）。
- **中间态 N vs 来源数**：「已阅读 N 个网页」N=累计原始页数；答案下来源列表=去重引用数；二者可不等（N ≥ 来源数），UI 各自展示不强制相等。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 输入栏 MUST 提供「智能搜索」开关，正交于 029 的 flash/pro 模型切换，默认**关闭**；开关状态作用于**当条消息发送**（per-message），MUST NOT 跨会话记忆为账号偏好。当前会话模型为**不支持工具调用/联网的 provider（如 MiniMax）**时，toggle MUST **灰显不可用**（非静默降级，让用户明确该模型无联网）。 **⚠️ A1（2026-06-19）整条推翻**：**移除开关**；联网工具对所有支持工具调用的会话模型（DeepSeek flash/pro + MiniMax M3）**默认常挂**，无 per-message 开关、无账号偏好、无"灰显不可用"模型；是否检索由模型自决（FR-002）。MiniMax 经 `thinking:adaptive` 纳入（见 Session 2026-06-19）。
- **FR-002**: 智能搜索开启时，当条发送 MUST 让当前 DeepSeek 模式具备联网搜索能力，模型 MUST 能按需检索实时网页并据检索内容作答；MUST 由模型自决是否检索（`tool_choice='auto'`，无需检索的问题不强制检索）。系统在联网发送时 MUST 注入一条**系统提示消息**（「联网 steering」+「当前日期 context」两层）导向模型对实时/时效类问题主动检索并正确理解相对时间（今天/本周/最近）——业界标准 mitigation，非强制检索。 **⚠️ A1（2026-06-19）**：去"开启"前提——联网工具对**所有支持模型（DeepSeek flash/pro + MiniMax M3）默认常挂**，system 提示**默认注入**（无 OFF 态）；`tool_choice='auto'` 模型自决与 steering/日期 context 不变。
- **FR-003**: 联网作答 MUST 由当前所选 DeepSeek 模式（flash/pro）本身生成（复用 029 会话模型路由）；MUST NOT 在联网时替换为其他模型作答。 **⚠️ A1（2026-06-19）**：作答模型扩为**用户所选模型（DeepSeek flash/pro 或 MiniMax M3）本尊**；"不替换为他模型/不偷换 GLM" 的核心约束不变。
- **FR-004**: 检索进行中，客户端 MUST 呈现中间态进度（如「已阅读 N 个网页」），N MUST 随检索推进更新（**N = 累计检索命中的原始页数**，贴 DeepSeek 语义；与最终去重引用的来源列表条数可不等，N ≥ 来源数），并在答案开始时过渡到答案流。
- **FR-005**: 最终答案 MUST 标注引用来源；用户 MUST 能查看来源（标题 / 链接）并打开对应网页——链接 MUST 以 **in-app 浏览器**（`expo-web-browser` `openBrowserAsync`）打开，留在 app 内。
- **FR-006**: 同一次作答内多次检索命中的来源 MUST 去重（同 URL 不重复），编号 MUST 全局唯一且稳定。
- **FR-007**: 一次联网作答的引用来源 MUST 随该 assistant 消息持久化；冷启动重进 / 会话切换恢复历史会话时 MUST 能恢复显示当时来源。
- **FR-008**: 智能搜索关闭时，发送 MUST 维持现有无联网行为（不检索、不出中间态、不产生来源）。 **⚠️ A1（2026-06-19）**：无"关闭"态；等价的零成本路径 = 模型**自决不检索**（寒暄/常识/写作，M3 adaptive 实测 9/9 不触发），此时不检索、不出中间态、不产生来源。
- **FR-009**: 搜索后端超时 / 报错时，系统 MUST 降级为无联网作答，且该条 assistant 消息 MUST 呈现**可见的「本次未联网」标识**并落 `degraded` 元数据（随消息持久化）；MUST NOT 导致整条消息失败或丢失用户已发消息（继承 027 FR-006 用户消息落了不丢）。（搜索零结果属正常检索结果、非失败，模型据空结果作答、不标 `degraded`。）
- **FR-010**: 一次作答的检索轮数 MUST 有上限兜底（**上限 3 轮**：初检 + 一轮细化 + 一轮兜底）；达上限时 MUST 用已有结果收敛作答，MUST NOT 无限检索。
- **FR-011**: 联网作答（含搜索阶段）流式进行中，停止生成 MUST 能中断整条检索-作答链路（复用 027 停止 / 028 FR-011 语义），已落库内容 MUST 不丢。
- **FR-012**: 搜索后端 MUST 经接口化适配层接入（provider 可替换，不改调用方编排）；搜索后端密钥 MUST 留服务端环境，MUST NOT 下发客户端（与 027/029 provider key 同款）。
- **FR-013**: 智能搜索相关读写 MUST 走现有认证 + accountId 归属校验；越权他人会话 MUST 拒绝（404 字节级一致）；未认证 / 失效凭据 MUST 走现有 401 刷新-重试链路（003）。

### Key Entities _(include if feature involves data)_

- **Conversation（会话）/ Message（消息）**: 复用 027 已建实体。本期在 assistant **Message** 上新增引用来源元数据（标识该条回复使用了智能搜索 + 其引用来源清单），供历史重渲恢复；预计一处加性可空 schema 改动。
- **Source（引用来源）**: 挂在 assistant message 上的来源条目——编号 / 标题 / 链接 / （可选）发布时间。非独立持久化表，随消息元数据存。
- **SearchResult（检索结果）**: 瞬态实体——搜索后端返回、喂给模型的网页片段（标题/链接/摘要/正文）。MUST NOT 长期留存原文；仅最终被引用的来源元数据落库。
- **Model（模型元数据）**: 复用 029。智能搜索作为正交于模型选择的能力，不新增模型项；作答模型仍为 flash/pro。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 开启智能搜索问实时类问题（如当日天气）时，答案 MUST 反映实时信息且带可点开来源——与关闭时模型回「无法提供实时信息」形成可对比的明确差异。
- **SC-002**: 检索过程中用户 MUST 看到「已阅读 N 个网页」中间态（N > 0 且随检索更新）。
- **SC-003**: 引用来源 100% 持久化——冷启动重进 / 切走再切回，历史联网作答消息仍显示当时来源、不丢、不串话。
- **SC-004**: 智能搜索默认关闭且关闭时维持现有行为——零联网、零额外成本、无中间态。 **⚠️ A1（2026-06-19）改判**：无开关；衡量改为「模型自决不检索时零联网成本」——寒暄/常识/写作类不触发检索、不出中间态、不产生来源（M3 adaptive 实测 9/9 不触发可断言）。
- **SC-005**: 搜索后端失败 / 超时 / 零结果时，用户消息不丢、不整条失败，仍得到降级回复。
- **SC-006**: 作答模型始终为用户所选 DeepSeek 模式（flash/pro）——服务端可断言，联网不改变作答模型。
- **SC-007**: 越权读 / 写他人会话的联网作答全部被拒（404 字节级一致）；未认证走现有 401 链路。
- **SC-008**: 一次作答的检索轮数不超过设定上限——无失控检索、无请求挂死。

## Assumptions

- **架构决策继承**：架构 C（自建 ReAct tool-call loop，DeepSeek 本尊作答）/ 搜索后端接口化 port + 阿里云 IQS 首个 adapter（备选 Bocha/Tavily，port 后可换）/ 手动 toggle 默认关 / 不走 GLM-Qwen 原生联网偷换——均来自 [plan 文档](../../docs/private/plans/2026-06/06-18-chat-web-search-architecture.md)，已与 user 对焦（2026-06-18）。 **⚠️ A1（2026-06-19）**：「手动 toggle 默认关」推翻为「无开关、默认常开、模型自决」，作答模型扩为 DeepSeek + MiniMax M3；**plan 文档 + plan.md/tasks.md 同步待 amend**。
- **复用 027/028/029 基建**：`chat` 限界上下文、`conversation`/`message` 两表、`LlmProvider` 接口化适配器、SSE 流式发送、停止生成（流式中断）、029 会话模型路由（flash/pro）、accountId 归属校验、003 refresh 拦截器、Orval typed hook 链路、028 会话切换/冷启动 hydrate 均已就位。030 不新建 bounded context。
- **开关粒度**：per-message（对齐 DeepSeek 智能搜索），非账号级 / 会话级记忆；与 029 的会话级模型记忆正交。 **⚠️ A1（2026-06-19）作废**：开关已移除，联网默认常开、模型自决；无 per-message/账号/会话粒度概念。
- **模型自决检索**：智能搜索开启 = 给模型联网工具能力，由模型按问题需要自决是否检索及检索几次（ReAct）；非「强制每条必搜」——既贴合 DeepSeek 体验也控成本。
- **作答模型不替换**：联网时作答仍是用户所选 DeepSeek 模式（flash/pro 均支持工具调用）；不为联网偷换到 GLM/Qwen 等原生联网模型（品牌一致性要求）。
- **来源持久化范围**：仅持久化最终被引用的来源元数据（编号/标题/链接/发布时间）随 assistant 消息存；检索网页原文为瞬态、不长期留存。
- **降级语义**：搜索后端不可用 / 零结果时降级无联网作答（继承 027「用户消息落了不丢」）；不让外部依赖故障击穿对话可用性。
- **失控防护**：检索轮数上限 **3 轮** 兜底 + 默认关（opt-in）控成本。 **⚠️ A1（2026-06-19）**：去掉「默认关 opt-in」这道成本闸；改由**模型自决克制**控成本（DeepSeek + M3 adaptive 实测寒暄/常识/写作 9/9 不触发）+ 3 轮上限兜底。
- **来源展示**（specify 默认，未单独 clarify）：展示该次作答**去重后的全部**引用来源（3 轮检索去重后通常 <10 条），列表可滚动/折叠；每次检索喂模型的 top-K 结果数为 **plan 阶段调参**（影响 context 预算），非 spec 决策。
- **降级标识**（/speckit-clarify 定稿 2026-06-18）：搜索后端超时/报错→降级无联网作答 + 该条消息可见「本次未联网」提示 + `degraded` 元数据；搜索零结果不算失败、不标 `degraded`。
- **来源打开**（/speckit-clarify 定稿 2026-06-18）：in-app 浏览器（`expo-web-browser` `openBrowserAsync`），留在 app 内。
- **搜索后端选型**：首个 adapter = 阿里云 IQS（同区低延迟 + 免费额度 + 返回 markdown 全文 + 中文实时覆盖好）；价格 / 配额需阿里云客户经理确认，port 抽象保证可秒切 Bocha/Tavily。
- **认证/越权**：复用现有 JWT + 003 refresh；会话按 accountId 归属；越权他人 conversationId 返回 **404 字节级一致**（反枚举，与 027/028/029 同款）。
- **引用 UI 一期范围**：一期做「已阅读 N 个网页」计数 + 来源列表（可点开）；inline `[N]` 标记点击精确跳源降二期（富文本渲染器自定义 [N]→link 复杂度高）。

- **可组合系统提示层**（/analyze remediation 2026-06-18）：030 实装「联网 steering」+「当前日期 context」**两层纯函数** + `composeSystemPrompt` 有序组合器（仅 `webSearch=true` 路径注入**一条 system 消息**，非联网路径不注入→ 027 零回归）；**平台基座层 + 用户自定义提示词层 = 未来独立 feature**（账号级 DB + 配置端点 + 设置 UI + 注入沙箱，用户可配，最低优先级标注「不得覆盖以上」）——030 只留接缝（有序纯函数列表 + context 形状），**不预置空 stub、不动 DB**；这是 chat **首次引入 system prompt**。
- **联网检索触发**（业界确认 2026-06-18；A1 2026-06-19 延伸）：`tool_choice='auto'`（对齐 DeepSeek/Claude/Gemini/Kimi/Qwen，仅 Perplexity 强制）；靠 steering 提示 + 日期 grounding + 模型质量压「该搜却不搜实时问题」风险，**非强制首轮搜**（否则寒暄也烧搜索）。SC-001 由此组合支撑，为业界标准 best-effort（非硬保证）。**A1**：移除开关后此机制对**所有模型默认生效**（DeepSeek + M3 adaptive 均实测 tool_choice='auto' 可靠+克制 15/15）。
- **MiniMax 联网**：MiniMax 不支持工具调用，智能搜索 toggle 在其下灰显不可用（FR-001），不静默降级；联网只路由 DeepSeek（flash/pro）。 **⚠️ A1（2026-06-19）整条推翻**：M3 国内站实测支持 tool calling（`thinking:adaptive`，15/15 可靠+克制），联网路由 DeepSeek flash/pro **+ MiniMax M3**；无灰显态。
- **中间态计数语义**：N=累计检索命中原始页数；来源列表=去重引用数。

## Dependencies

- **027（已 ship）**：chat 限界上下文 + `LlmProvider` 接口化适配器（DeepSeek）+ SSE 流式发送 + 停止生成（流式中断）+ `conversation`/`message` 两表 + 用户消息即时落库。
- **028（已 ship）**：会话切换 / 冷启动 hydrate 链路——US2 来源持久化恢复挂其上。
- **029（已 ship）**：flash/pro 双模式会话模型路由——联网作答复用其按会话模型路由。
- 外部搜索后端服务（阿里云 IQS；港 port 抽象，备选 Bocha/Tavily）。
- 现有认证体系（JWT guard + 003 token refresh 拦截器）。
- Orval api-client 生成链路（server OpenAPI → 类型 + hooks → mobile 消费）。
- 现有 `~/ui` / `~/theme`（toggle / 列表 / 链接组件复用，目标 0 新设计 token）。
- `expo-web-browser`（in-app 浏览器打开来源链接；若未装走 `expo install`，Expo 托管、低风险）。

## Risk

| 风险                                                                       | 缓解                                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工具调用（tool calling）需扩展 027 `LlmProvider` 接口（纯文本 → 工具事件） | plan 阶段定义最小化破坏的事件联合接口；minimax 等不支持工具的 provider 永不吐工具事件；IT 断言 fake provider 工具流闭环                          |
| 自建 ReAct loop 失控（无限检索 / 成本爆炸）                                | FR-010 检索轮数上限兜底 + 模型自决克制（A1：M3 adaptive 实测 9/9 不滥搜，替代旧「默认关 opt-in」）；state_branches 覆盖；IT 注入连续检索验证收敛 |
| 搜索后端外部依赖故障击穿对话可用性                                         | FR-009 降级无联网作答 + 用户消息不丢；fake 后端注入超时/失败/零结果 IT 全覆盖                                                                    |
| DeepSeek 流式偶发把 tool_call 当文本吐（已知 bug）                         | adapter 双形态解析（结构化 tool_calls + 文本兜底）；plan 阶段固化解析策略；IT 覆盖两种形态                                                       |
| 阿里云 IQS 价格 / 配额未公开                                               | 先用免费额度联调；上量前确认成本；port 抽象保证可秒切 Bocha/Tavily（不改 loop）                                                                  |
| 联网作答触新 env（搜索后端密钥）影响部署存活                               | 改部署前读 `ops/runbook/prod-deploy-rollback.md`；compose 映射 + deploy.yml 同步；PR body 勾部署存活 3-checkbox（CI 扫）                         |
| 来源去重 / 编号映射在多轮检索下串号                                        | FR-006 全局唯一稳定编号；IT 注入多轮重叠 URL 验证去重与编号一致                                                                                  |
| SSE 工具进度帧在 Expo Web export 路径未冒烟                                | web_compat: untested；plan/mockup 阶段确认 web 流式 tool 事件解析；Mobile-E2E 以 tap + hermetic SSE 验证                                         |
| 生成式 AI 合规（算法备案 + 联网内容来源标识）                              | 继承 027 Risk；来源标识本就是引用 UI 的一部分；不阻塞开发，上线 gate 项                                                                          |

## Next

`/speckit-clarify` 已收敛 3 个高影响点（检索轮数上限 3 轮 / 失败降级显式标识 / 来源 in-app 打开）。可进 `/speckit-plan`。剩余调参（喂模型 top-K / 中间态文案 / 搜索超时阈值具体值）留 plan 阶段处理。
