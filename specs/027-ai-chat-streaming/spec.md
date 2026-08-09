---
feature_id: 027-ai-chat-streaming
modules: [chat]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-14
updated_at: 2026-06-14
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: '首页全新 chat 屏 + 逐 token 流式渲染。流式读取依赖 RN/Expo fetch streaming body 支持(plan 前 PoC 验证)；Expo Web export 路径未冒烟。空态/输入条静态部分 web 可渲染，流式增量在 web 待验。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 性能预算 (per ADR-0039 SSOT). 流式对话的关键体验指标 = 首 token 时延(TTFT)。
perf_budgets:
  - endpoint: 'POST /chat/conversations/{conversationId}/messages (SSE stream)'
    p95_ms: 3000
    p99_ms: 6000

# 状态机分支穷举 (per ADR-0040 multi-layer test gate).
state_branches:
  - '空态发首条消息 -> 新建 conversation + 落用户 message + 流式回复 + 流结束落 AI message'
  - '已有对话内追问 -> 携带本会话历史 message 作上下文 -> 流式回复 + 落库(多轮)'
  - '空输入/纯空白 -> 发送键禁用,不发起请求'
  - 'LLM provider 报错/超时 -> 流中断,展示错误态 + 可重试;半成品 AI 回复不落库(不落 failed 占位),用户 message 已落库不丢'
  - '流式中用户点「停止生成」-> 中断上游 + 落已生成的部分 AI message(标记 stopped)'
  - '流式中网络断开/用户切屏离开 -> 客户端停止渲染;服务端流完成则完整落库,未完成则按 error 分支'
  - '未认证/token 失效 -> 401(触发 003 refresh 拦截器 retry-once;仍失败则登出),不进入对话'
  - '请求他人 conversationId -> 404(accountId 归属校验,字节级一致反枚举,与 alert/portfolio 同款),不泄露/不串话'
---

# Feature Specification: AI 对话首页主干 + 单模型流式（AI Chat Home — Streaming MVP）

> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> 跨端 feature（server + mobile）。流程：`spec → /speckit-clarify → RN 流式 PoC → mockup（design/，以 Kimi/Gemini/千问 6 张参考截图为 baseline）→ plan → tasks → impl`。impl 单 PR（server impl + 真后端 IT + api-client regen + mobile 消费同 PR，per Constitution §V）。mobile 落正交两层：① `[Mobile-E2E]` hermetic UI e2e（验交互/流式渲染）+ ② `[Contract-Smoke]` 契约冒烟（打 testcontainers 真 server，验契约对齐 + 真落库）。
>
> 📐 **[模块决策 SoT]** 本 feature 是「AI 对话首页」大模块的子 feature 027，4 项锁定决策 + 跨契约见 [master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md)。新建 server 限界上下文 `chat`（catalog Q4「完全新业务领域」→ plan 阶段走 ADR-0032 sunset trigger 7 问评估）。
>
> ⚠️ **[范围红线]** 027 = **对话主干 + 单模型流式**。**不**含：左抽屉/历史会话列表/搜索（028）、模型切换下拉（029）、语音输入/TTS、带图/多模态、扩展能力按钮、业务上下文注入/RAG/tool-calling、第二 provider。顶部 hamburger 与模型名仅占位/只读展示。

## Clarifications

### Session 2026-06-14

- Q: 流式中断（用户点停止 / provider 失败）时，已生成的半成品 AI 回复怎么处理？ → A: **停止保留、失败不落**——用户主动「停止生成」→ 保留已生成的半成品（标记 stopped）；provider 报错/超时 → 不落库（不落 failed 占位消息），仅展示错误态 + 重试，用户消息已落库不丢。
- Q: 多轮对话发给模型的历史上下文如何界定？ → A: **token 预算滑动窗口**——按 token 预算从最新轮次往回装，超预算丢最早的轮次；不做摘要/压缩。
- Q: 首页空态问候语的个性化程度？ → A: **带昵称**——形如「嗨 {昵称}，今天聊点什么」，昵称读自现有 /me（profile）；/me 未就位时退回通用问候，不显示空昵称。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 在首页发起对话并实时收到流式回复 (Priority: P1)

用户打开 App 首页（第一个 tab），看到一个简约大气的空态（居中标识 + 一句问候 + 大留白），底部是输入条（占位文案「尽管问」+ 发送按钮）。用户输入问题点发送，AI 的回复以打字机效果**逐字/逐段实时浮现**，无需等待整段生成完毕。这是整个对话体验的 MVP 核心——只实现这一条，用户已能完成「问一句、看回答」的完整价值。

**Why this priority**: 没有「发起 + 流式收到回复」，整个对话功能不成立。这是脊柱，028/029 都挂在它建立的对话/消息数据与流式链路上。

**Independent Test**: 在干净账号首页输入一条问题点发送，验证：① 回复以增量方式实时显示（非一次性整段出现）；② 回复完整结束后内容稳定；③ 刷新/重进后该轮问答仍在（已落库）。

**Acceptance Scenarios**:

1. **Given** 首页空态、用户已登录，**When** 在输入条输入非空文本并点发送，**Then** 用户消息立即上屏，AI 回复区开始逐 token 实时呈现，直至生成结束。
2. **Given** AI 正在流式回复中，**When** token 持续到达，**Then** 已显示内容稳定累加、不闪烁、不回退，滚动跟随到最新内容。
3. **Given** AI 回复已结束，**When** 用户查看消息，**Then** 回复内容完整、底部展示「内容由 AI 生成」标识，消息已持久化。

---

### User Story 2 - 多轮追问，AI 记得上文 (Priority: P2)

用户在同一会话里继续追问，AI 的回复基于本会话之前的问答上下文（而非孤立单轮）。例如先问「介绍下 A」，再问「那它和 B 比呢」，AI 能理解「它」指代 A。

**Why this priority**: 单轮问答是 demo，多轮上下文才是「对话」。但它建立在 US1 的流式与落库之上，故 P2。

**Independent Test**: 同一会话连发两条相关问题，第二条用指代词，验证 AI 回复体现出对第一轮内容的理解。

**Acceptance Scenarios**:

1. **Given** 会话内已有一轮问答，**When** 用户发出依赖上文的追问，**Then** AI 回复体现对历史消息的理解。
2. **Given** 多轮对话，**When** 持续追问，**Then** 历史消息按顺序作为上下文参与，且每轮用户/AI 消息均按序落库。

---

### User Story 3 - 停止生成与失败重试 (Priority: P2)

AI 流式回复过程中，用户可点「停止生成」立即中断；若 provider 报错/超时，界面给出友好错误态并允许「重试」。

**Why this priority**: 流式场景下中断与失败是高频真实路径，缺了体验明显残缺；但非「问答成立」的最小闭环，列 P2。

**Independent Test**: ① 在长回复流式中点停止，验证立即停下且已生成部分保留；② 构造 provider 失败，验证错误态 + 重试可恢复，用户消息不丢。

**Acceptance Scenarios**:

1. **Given** AI 正在流式回复，**When** 用户点「停止生成」，**Then** 流立即中断，已生成的部分内容保留并标记为已停止。
2. **Given** 发送后 provider 报错或超时，**When** 流无法完成，**Then** 展示可理解的错误态 + 重试入口，用户的原始消息保留不丢。
3. **Given** 错误态下点「重试」，**When** 重新发起，**Then** 重新进入流式回复路径。

---

### Edge Cases

- **空/纯空白输入**：发送键禁用，不发起请求。
- **极长回复**：流式增量不卡顿、滚动跟随；落库不截断。
- **流式中切屏/离开首页再回来**：回到对话仍可看到该轮已完成内容（落库的部分）；进行中流的续读策略由 plan 定（最简：离开即停渲染，服务端完成则完整落库）。
- **连点发送 / 上一轮未结束又发**：并发语义由 plan 定（最简：流进行中禁用发送，直到结束或停止）。
- **未登录 / token 失效**：走现有 401 → refresh 拦截器（003）retry-once；仍失败则登出，不进入对话。
- **越权**：请求非本人 conversationId 返回 404（字节级一致反枚举，与 alert/portfolio 同款），不串话、不泄露他人会话。
- **provider 返回空内容 / 立即结束**：展示空回复的合理兜底（如提示「未生成内容，请重试」）。
- **空态问候昵称未就位**（/me 未加载/失败）：退回通用问候，不显示空昵称或占位符。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 首页第一个 tab MUST 呈现 AI 对话界面；无任何消息时 MUST 展示简约大气空态（居中标识 + 一句问候 + 大留白 + 底部输入条）。问候语 MUST 带用户昵称（形如「嗨 {昵称}，今天聊点什么」，昵称读自现有 /me）；昵称未就位时 MUST 退回通用问候，不显示空昵称。
- **FR-002**: 输入条 MUST 提供占位文案「尽管问」与发送按钮；输入为空或纯空白时发送按钮 MUST 禁用。
- **FR-003**: 用户发送消息后，该用户消息 MUST 立即上屏；AI 回复 MUST 以增量流式方式实时呈现（逐 token / 分段），而非整段一次性出现。
- **FR-004**: 同一会话内的后续消息 MUST 携带本会话历史消息作为上下文参与 AI 生成（多轮）；上下文 MUST 按 token 预算的滑动窗口界定——从最新轮次往回装，超预算丢弃最早轮次（不做摘要/压缩）。
- **FR-005**: 会话（conversation）与消息（message）MUST 持久化，且 MUST 按用户归属——用户只能读写自己的会话；越权访问 MUST 拒绝。
- **FR-006**: 用户消息 MUST 在发送时即落库；AI 回复 MUST 在流正常结束时以完整内容落库。
- **FR-007**: 系统 MUST 通过服务端代理真实 LLM provider 生成回复；provider 凭据 MUST 仅存于服务端，绝不下发客户端。
- **FR-008**: AI 流式回复进行中，用户 MUST 能「停止生成」并立即中断；已生成的部分内容 MUST 保留并可识别为已停止。
- **FR-009**: provider 报错/超时导致流无法完成时，系统 MUST 展示可理解的错误态并提供「重试」；用户的原始消息 MUST 不丢；失败的半成品 AI 回复 MUST NOT 落库（不留 failed 占位消息）。
- **FR-010**: 所有 AI 生成内容区域 MUST 展示「内容由 AI 生成」标识。
- **FR-011**: 顶部栏 MUST 展示当前模型名（只读，本期不可切换）；hamburger 抽屉按钮 MUST 存在但本期为占位（点击行为留给 028）。
- **FR-012**: 所有 chat 端点 MUST 走现有认证；未认证/失效凭据 MUST 走现有 401 刷新-重试链路。
- **FR-013**: 系统 MUST 为新会话生成一个可展示的标题（供 028 历史列表使用）；本期默认由首条用户消息派生（如截断），不引入额外 AI 生成标题。

### Key Entities _(include if feature involves data)_

- **Conversation（会话）**: 一次对话的容器。归属某用户；含可展示标题、所用模型标识、创建/更新时间。预留扩展位（上下文/元数据）承接二期业务注入，本期不读写。
- **Message（消息）**: 会话内的一条消息。属于某 conversation；含角色（用户 / AI）、文本内容、创建时间、状态（正常 / 已停止 / 失败——用于 FR-008/009）。按会话内顺序排列。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户发送消息后，**首段回复内容**在 p95 ≤ 3 秒内开始出现（首 token 时延），体感「几乎立即开始回答」。
- **SC-002**: 95% 的对话轮次，AI 回复完整生成并成功落库（刷新/重进后内容仍在、无丢失、无截断）。
- **SC-003**: 流式呈现过程中内容只增不退、无明显闪烁，滚动自动跟随最新内容。
- **SC-004**: 多轮追问场景下，AI 回复体现对上文的理解（指代/承接类追问的正确率达可接受水平，由验收用例判定）。
- **SC-005**: 用户点「停止生成」后，回复在 1 秒内停止增长，已生成部分保留。
- **SC-006**: provider 失败时，100% 出现可理解错误态且可重试，无静默卡死、无用户消息丢失。
- **SC-007**: 用户无法看到或访问他人的会话与消息（越权访问全部被拒）。

## Assumptions

- **决策继承**：4 项锁定决策（服务端代理 DeepSeek + 流式 / 通用助手预留业务接口 / 会话落 PG 多端同步 / 单 provider 双模式选择器全做）来自 [master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §1，已与 user 对焦（2026-06-14）。027 实现其中「服务端代理 + 流式 + 落库 + 单模型」部分。
- **Provider**：一期 = DeepSeek（user 已有账号 + key），默认模式单一；模型名只读展示。第二 provider（MiniMax 等）与双模式切换不在 027。
- **多轮上下文裁剪**（澄清 2026-06-14）：按 token 预算的滑动窗口——从最新轮次往回装、超预算丢弃最早轮次；token 预算具体数值 plan 阶段定；本期不做摘要/压缩。
- **中断落库**（澄清 2026-06-14）：用户「停止生成」→ 保留半成品 AI 回复（标记 stopped）；provider 失败 → 不落半成品、不留 failed 占位，仅错误态 + 重试。
- **空态问候**（澄清 2026-06-14）：带昵称，昵称读自现有 /me；/me 未就位退回通用问候。
- **会话标题**：默认截取首条用户消息作标题；AI 生成标题留二期。
- **并发/续读**：最简语义——流进行中禁用再次发送；离开首页即停止前端渲染，服务端流完成则完整落库（进行中流的「断点续读」不在 027）。
- **限流/配额**：027 不引入 per-user 速率限制/配额（provider 侧超时与错误兜底已覆盖滥用的基本失败路径）；如需配额留后续。
- **合规**：UI 保留「内容由 AI 生成」标识；生成式 AI **算法备案 + 内容标识** 为上线 gate（非开发阻塞，见 Risk）。
- **认证/越权**：复用现有 JWT 认证与 003 refresh 拦截器；会话按用户归属（本仓主体身份 = `accountId`，`req.user.accountId`，本 spec 中「userId」即指 accountId）。越权访问他人 conversationId 返回 **404 字节级一致**（反枚举，与 alert/portfolio 同款），不返回 403。
- **流式传输技术风险**：RN/Expo `fetch` 对流式 response body 支持不全——移动端流式读取方案（`expo/fetch` 流式 / `react-native-sse` / 整段返回兜底）**必须在 plan 前 PoC 验证**，验通才落 tasks（master 跨契约 1）。

## Dependencies

- 现有认证体系（JWT guard + 003 token refresh 拦截器）。
- 现有 /me（profile）——空态问候读用户昵称（FR-001）。
- DeepSeek 开放平台账号 + API key（服务端 env）。
- Orval api-client 生成链路（server OpenAPI → 类型 + hooks → mobile 消费）。

## Risk

| 风险                                      | 缓解                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| RN/Expo `fetch` 不支持流式 response body  | plan 前 PoC：`expo/fetch` 流式 vs `react-native-sse`(GET+query) vs 整段返回兜底；验通才落 tasks |
| 生成式 AI 算法备案 / 内容标识（中国大陆） | 上线 gate，非开发阻塞；UI 保留「内容由 AI 生成」                                                |
| DeepSeek 限流 / 超时 / 计费               | 适配器隔离 + 重试 + 超时降级（FR-009 错误态兜底）                                               |
| 流式中断落库不完整                        | 用户 message 即时落；AI message 仅在流正常结束落（FR-006）；停止/失败按 state_branches 分支处理 |
| 会话越权                                  | 全端点 JWT + userId 归属校验（FR-005 / SC-007）                                                 |
