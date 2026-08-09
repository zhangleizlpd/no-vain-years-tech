---
feature_id: 029-chat-model-switch
modules: [chat]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-14
updated_at: 2026-06-14
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: '顶栏模型下拉是 tap 驱动的轻量 overlay/popover menu（非手势容器，比 028 抽屉简单），Web export 路径可渲染但下拉交互在 web 待 e2e 冒烟；模型元数据/切换为静态 JSON 端点驱动，Web 可渲染。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 性能预算 (per ADR-0039 SSOT). 模型切换的关键体验 = 下拉拉起 + 切换落地时延（本地态 + 一次轻写）。
perf_budgets:
  - endpoint: 'GET /chat/models (可选模型元数据列表)'
    p95_ms: 500
    p99_ms: 1000
  - endpoint: '会话级模型记忆写入 (切换持久化 conversation.model)'
    p95_ms: 800
    p99_ms: 1500

# 状态机分支穷举 (per ADR-0040 multi-layer test gate).
state_branches:
  - '点顶栏模型选择器 -> 拉出下拉 -> 列 DeepSeek 快速(flash)/思考(pro)两项 + 当前项打勾'
  - '选「快速(flash)」-> 当前会话模型记为 flash + 顶栏即时反映 + 该会话后续发送用 flash 路由'
  - '选「思考(pro)」-> 当前会话模型记为 pro + 顶栏即时反映 + 该会话后续发送用 pro 路由'
  - '选与当前相同的模型 -> 关下拉,无副作用(不重复写/不打断)'
  - '切换到某历史会话 -> 顶栏恢复该会话上次所选模型(会话级记忆读取)'
  - '新建对话(未发首条) -> 顶栏显示默认模型(flash);此时切模型为内存态,首条消息落库时随会话持久化(无空会话占位)'
  - 'MiniMax(集群)留位项 -> 在下拉中展示但标记不可用,点击不可选(disabled),不报错'
  - '027 流式回复进行中切换模型 -> 先中断进行中的流(等同 028/027 停止生成语义),切换对下一条发送生效,已落库内容不丢'
  - '模型元数据端点不可用 -> 下拉降级用内置默认(flash/pro),不阻塞对话;不白屏'
  - '改他人会话模型(越权) -> 404(accountId 归属校验,字节级一致反枚举,与 027/028/alert/portfolio 同款),不串话'
  - '未认证/token 失效 -> 401(触发 003 refresh 拦截器 retry-once;仍失败则登出),不切换'
---

# Feature Specification: AI 对话模型切换（DeepSeek 双模式 flash / pro）

> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> 跨端 feature（server + mobile）。流程：`spec → /speckit-clarify → mockup（design/，以图6 DeepSeek 模型切换截图为 baseline）→ plan → tasks → impl`。impl 单 PR（server impl + 真后端 IT + api-client regen + mobile 消费同 PR，per Constitution §V）。mobile 落正交两层：① `[Mobile-E2E]` hermetic UI e2e（验下拉拉起/选择/打勾/会话级记忆恢复）+ ② `[Contract-Smoke]` 契约冒烟（打 testcontainers 真 server，验模型元数据 + 模型切换落库契约对齐）。
>
> 📐 **[模块决策 SoT]** 本 feature 是「AI 对话首页」大模块的子 feature 029，4 项锁定决策 + 跨契约见 [master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §1/§2/§3/§4（尤其 **D4 单 provider DeepSeek 两模式 + 选择器全做**、跨契约 §2.2 provider 接口化）。**复用 027 已建的 `chat` 限界上下文 + `LlmProvider` 适配器接口 + `conversation.model` 列**，不新建 bounded context、不新增表（预计零 schema 改动）；仅在 `chat` ctx 内增模型元数据端点 + 按 model 路由 DeepSeek 双模式 + 会话级模型记忆。
>
> ⚠️ **[范围红线]** 029 = **顶栏模型下拉选择器 + DeepSeek 快速/思考双模式切换 + 会话级模型记忆**。**不**含：多 provider 实装（MiniMax 等降二期，仅在选择器留不可用占位 + 适配器接口预留，二期零重构接入）、模型参数调节（temperature / max_tokens 等）、同一会话内 per-message 模型混用（模型记忆是会话级）、模型用量计费/配额展示。**承接** 028（顶栏 hamburger 已接抽屉，模型选择器 027 先只读显示模型名 → 028 不动 → 029 接下拉）。与 028 互不依赖。

## Clarifications

### Session 2026-06-14（/speckit-clarify 定稿）

- Q: 模型记忆的粒度（影响数据模型与存储）？ → A: **会话级**——写 `conversation.model`（027 列已在），不同会话可用不同模式，零 schema 改动；非账号级全局偏好。
- Q: 027 流式回复进行中时切换模型怎么处理？ → A: **先 abort 再切**——切模型先中断进行中的流（等同 027 停止生成 / 028 FR-011），已落库不丢，切换对下一条发送生效。
- Q: 下拉可选模型清单从哪来（一期单 provider）？ → A: **server 元数据端点**——返回可选模型清单（id/名/描述/可用性）驱动选择器，二期接 MiniMax 零客户端改动（跨契约 §2.2）；一期常量派生不建表。
- Q: 新建会话的默认模型？ → A: **flash（快速）**——响应快、成本低，通用助手首选；用户可随时切 pro。

### Session 2026-06-14（specify 阶段 informed defaults，已上方 /speckit-clarify 定稿）

以下为 specify 阶段基于 master plan D4 + 027/028 既有范式的合理默认，已经上方 `/speckit-clarify` 全部确认锁定：

- **默认模型**：新建会话默认 **flash（快速）**——成本低、响应快，符合通用助手首选；用户可随时切 pro。
- **模型记忆粒度**：**会话级**（写 `conversation.model`），非全局/账号级；切换只影响当前会话后续发送，历史消息不重生成。
- **流式进行中切换**：先中断进行中的流（复用 027「停止生成」/ 028 FR-011 语义），切换对下一条发送生效。
- **模型元数据来源**：server 端点返回可选模型列表（一期 DeepSeek flash/pro 两项可用 + MiniMax 留位不可用），端点失败时客户端降级用内置默认。
- **未发首条的新会话**：切模型为内存态，首条消息落库时随会话持久化（与 027 首发建会话一致，无空会话占位）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 切换模型并影响后续回复 (Priority: P1)

用户在对话首页顶栏点中间的模型选择器（027 已显示当前模型名占位），下拉出 DeepSeek 的「快速（flash）」与「思考（pro）」两种模式，当前所用模式打勾。用户选另一种模式，下拉关闭、顶栏即时反映新模型名，该会话接下来发出的消息由所选模式生成回复（flash 快而简、pro 深度推理）。这是 029 的 MVP 核心——只实现这一条，用户已能「按需在快/慢两种思考模式间切换」。

**Why this priority**: 没有「切换并使后续发送生效」，模型切换功能不成立。这是 029 的脊柱，会话级记忆与元数据驱动都挂在它建立的选择器与切换链路上。

**Independent Test**: 用一个登录账号，在某会话顶栏点模型选择器，验证：① 下拉列出 flash/pro 两项且当前项打勾；② 选另一项后顶栏模型名更新；③ 切换后发一条消息，回复由所选模式生成（可经服务端路由断言所用模型）。

**Acceptance Scenarios**:

1. **Given** 用户在某会话中且当前模型为 flash，**When** 点顶栏模型选择器，**Then** 下拉出 flash/pro 两项，flash 项打勾。
2. **Given** 下拉已打开，**When** 选「思考（pro）」，**Then** 下拉关闭、顶栏显示 pro，该会话后续发送用 pro 路由。
3. **Given** 用户已切到 pro，**When** 在该会话发出下一条消息，**Then** 回复由 DeepSeek pro 模式生成（服务端按会话模型路由）。
4. **Given** 027 流式回复正在进行，**When** 用户切换模型，**Then** 先中断进行中的流（已落库内容不丢），切换对下一条发送生效。

---

### User Story 2 - 会话级模型记忆 (Priority: P2)

用户为不同会话选择不同模式（如「投资分析」会话用 pro 深度推理、「随手问」会话用 flash 快答）。切回某历史会话时，顶栏自动恢复该会话上次所选的模型；新建会话用默认模型。模型选择随会话持久化、多端一致。

**Why this priority**: 「记住每个会话的模型」让切换有持续价值而非一次性，但非「切换生效」的最小闭环，列 P2。建立在 US1 的切换链路 + 028 的会话切换之上。

**Independent Test**: 会话 A 选 pro、会话 B 选 flash，经 028 抽屉切换 A↔B，验证顶栏模型名随会话恢复；重进 App / 换端后会话模型仍保留；新建会话顶栏为默认 flash。

**Acceptance Scenarios**:

1. **Given** 会话 A 上次选 pro、会话 B 上次选 flash，**When** 经抽屉从 B 切到 A，**Then** 顶栏恢复显示 pro。
2. **Given** 用户点「新建对话」，**When** 回到空态，**Then** 顶栏显示默认模型 flash。
3. **Given** 某会话已选 pro 并发过消息，**When** 用户重进 App 打开该会话，**Then** 顶栏仍是 pro（持久化）。

---

### User Story 3 - 模型元数据驱动选择器 (Priority: P3)

模型选择器的可选项由服务端模型元数据驱动（模型 id / 展示名 / 描述 / 是否可用），而非客户端硬编码。一期返回 DeepSeek flash/pro 两项可用 + MiniMax 留位（标记不可用），为二期接入多 provider 留「零客户端改动」的扩展位。

**Why this priority**: 元数据驱动是「二期零重构接多 provider」的关键解耦，但一期单 provider 下客户端硬编码两项也能跑，故 P3。建立在 US1 选择器之上。

**Independent Test**: 调模型元数据端点，验证返回 flash/pro 两项可用 + MiniMax 一项不可用；选择器据此渲染（MiniMax 项 disabled）；端点不可用时客户端降级用内置默认仍能切换。

**Acceptance Scenarios**:

1. **Given** 用户打开模型下拉，**When** 选择器加载元数据，**Then** 展示 flash/pro 可选 + MiniMax 不可用留位。
2. **Given** MiniMax 留位项不可用，**When** 用户点它，**Then** 不可选、无副作用、不报错。
3. **Given** 模型元数据端点暂不可用，**When** 用户打开下拉，**Then** 降级展示内置默认（flash/pro），对话不阻塞。

---

### Edge Cases

- **未发首条的新会话切模型**：模型选择为内存态，首条消息落库时随会话一并持久化，不产生空标题/空模型占位会话。
- **切换到与当前相同的模型**：关下拉、无副作用（不重复写库、不打断）。
- **027 流式进行中切模型**：先中断进行中的流（等同停止生成），切换对下一条发送生效，已落库内容不丢。
- **改名/删除他人会话模型（越权）**：请求非本人 conversationId 返回 404（字节级一致反枚举，与 027/028/alert/portfolio 同款），不串话、不泄露。
- **模型元数据端点失败**：客户端降级用内置默认模型项，对话不阻塞、不白屏。
- **MiniMax 留位项被点**：disabled 不可选，无副作用。
- **未登录/token 失效**：走现有 401 → 003 refresh 拦截器 retry-once；仍失败则登出，不切换。
- **会话历史含旧 / 未知 model 值**：顶栏稳健降级显示（未知值回落默认展示名），不崩溃。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 顶栏模型选择器（027 占位只读显示模型名）MUST 接交互：点击 MUST 拉出模型下拉；下拉可关闭（选项/点外侧/再点）。
- **FR-002**: 下拉 MUST 展示 DeepSeek「快速（flash）」与「思考（pro）」两项，并对当前会话所用模型 MUST 打勾标识。
- **FR-003**: 用户选某模型 MUST 将其记为当前会话的模型并持久化（会话级记忆），顶栏 MUST 即时反映。
- **FR-004**: 切换模型后，当前会话**后续**发送的消息 MUST 由所选模式路由到对应 DeepSeek 模型生成回复；已存在的历史消息 MUST NOT 重新生成。
- **FR-005**: 服务端 MUST 提供模型元数据（可选模型的 id / 展示名 / 描述 / 是否可用），驱动选择器渲染；MiniMax 等二期 provider MUST 以不可用留位呈现。
- **FR-006**: provider 适配器 MUST 保持 027 `LlmProvider` 接口化，flash/pro 经统一接口的 model 参数路由；二期新增 provider MUST 仅新增适配器实现，不改调用方（跨契约 §2.2）。
- **FR-007**: 切换到某历史会话时，顶栏 MUST 恢复该会话上次所选模型（会话级记忆读取，复用 028 会话切换）。
- **FR-008**: 新建会话 MUST 使用默认模型（flash）；未发首条消息前 MUST NOT 落库（与 027/028 一致），模型选择于首发时随会话持久化。
- **FR-009**: 模型相关写操作 MUST 走现有认证 + accountId 归属校验；越权他人会话 MUST 拒绝（404 字节级一致）；未认证/失效凭据 MUST 走现有 401 刷新-重试链路（003）。
- **FR-010**: provider 密钥 MUST 留服务端环境，MUST NOT 下发客户端（跨契约 §2.2 / master D1）。
- **FR-011**: 当 027 流式回复进行中时，切换模型 MUST 先中断进行中的流（等同停止生成语义），已落库内容 MUST 不丢；切换对下一条发送生效。
- **FR-012**: 模型元数据端点不可用时，客户端 MUST 降级用内置默认模型项，对话功能 MUST NOT 阻塞。

### Key Entities _(include if feature involves data)_

- **Conversation（会话）**: 复用 027 已建实体。本期读写其 `model` 字段（标识该会话所用 DeepSeek 模式 flash/pro）；切换模型 = 更新 `model`。归属 accountId。预计零 schema 改动（`model` 列 027 已建）。
- **Model（模型元数据）**: 非持久化实体——服务端派生/配置的可选模型清单（id / 展示名 / 描述 / 可用性），一期含 DeepSeek flash/pro（可用）+ MiniMax（留位不可用）。驱动客户端选择器渲染。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户可在 ≤ 2 次点击内完成模型切换（点选择器 → 选模式）。
- **SC-002**: 切换后该会话后续回复由所选模式生成——服务端按会话模型路由，flash/pro 行为可区分、可断言。
- **SC-003**: 会话级模型记忆 100% 持久化——切走再切回 / 重进 App / 换端，会话模型保留不丢。
- **SC-004**: 新建会话默认模型为 flash，顶栏正确呈现。
- **SC-005**: 用户无法切换或读到他人会话的模型（越权写全部被拒，404 字节级一致）。
- **SC-006**: 模型选择器在元数据端点不可用时仍可用（降级默认），对话不被阻塞，无白屏。
- **SC-007**: 切模型在 027 流式进行中触发时，无残留流、无内容丢失、无界面卡死。

## Assumptions

- **决策继承**：4 项锁定决策 + 跨契约来自 [master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §1/§2/§3/§4，已与 user 对焦（2026-06-14）。029 实现其中「模型切换（DeepSeek 双模式）」部分，复用 027 已建 `LlmProvider` 接口 + `conversation.model` 列 + chat ctx。
- **复用 027/028 基建**：`chat` 限界上下文、`conversation`/`message` 两表、`conversation.model` 列、`LlmProvider` 接口化适配器、accountId 归属校验、003 refresh 拦截器、Orval typed hook 链路、028 会话切换链路均已就位（027/028 ship）。029 不新建 bounded context、不新增表，预计零 schema 改动。
- **默认模型**（/speckit-clarify 定稿 2026-06-14）：新建会话默认 flash（快速），用户可切 pro。
- **模型记忆粒度**（/speckit-clarify 定稿 2026-06-14）：会话级（`conversation.model`），非全局/账号级；切换只影响当前会话后续发送，历史消息不重生成。
- **流式中断协同**（继承 028 FR-011）：切模型时若 027 流进行中，先 abort 当前流（复用停止语义），切换对下一条生效，不丢已落库内容。
- **模型元数据**（/speckit-clarify 定稿 2026-06-14）：server 端点返回可选模型清单（一期 flash/pro 可用 + MiniMax 留位不可用），端点失败客户端降级内置默认。一期单 provider 双模式，元数据可由服务端配置/常量派生，无需建表。
- **provider 接口化**（跨契约 §2.2）：DeepSeek flash/pro 经统一 `LlmProvider` 接口 model 参数路由；二期接 MiniMax 仅新增适配器实现，不动调用方；key 走 server env，禁下发客户端。
- **认证/越权**：复用现有 JWT + 003 refresh；会话按 accountId 归属（`req.user.accountId`）；越权他人 conversationId 返回 **404 字节级一致**（反枚举，与 027/028/alert/portfolio 同款），不返回 403。
- **未发首条的新会话**：复用 027 首发落库；模型选择内存态，首发时随会话持久化（无空会话占位）。
- **顶栏交接**：模型选择器 027 先只读显示当前模型名 → 028 不动 → 029 接下拉交互（同一顶栏组件演进，不新建顶栏）。

## Dependencies

- **027（已 ship）**：chat 限界上下文 + `LlmProvider` 接口化适配器（DeepSeek）+ `conversation.model` 列 + SSE 流式发送 + 停止生成（流式中断）+ 顶栏模型名只读占位。
- **028（已 ship）**：会话切换链路（`selectConversation` hydrate）+ `use-chat` 扩展——US2 会话级记忆恢复挂其上。
- 现有认证体系（JWT guard + 003 token refresh 拦截器）。
- Orval api-client 生成链路（server OpenAPI → 类型 + hooks → mobile 消费）。
- 现有 `~/ui` / `~/theme`（下拉/菜单/打勾组件复用，目标 0 新设计 token）。

## Risk

| 风险                                                                | 缓解                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 切换模型与 027 进行中流的并发                                       | FR-011：切模型先 abort 流；state_branches 覆盖；Mobile-E2E + 单测验证无残留                                 |
| DeepSeek flash/pro 路由需改 027 send-message（溢出 027 scope 风险） | plan 阶段确认 029 仅按会话模型路由、最小改动既有发送链路；IT 断言两模式落到不同模型                         |
| 会话级模型记忆持久化与未落库新会话的时序                            | 新会话模型内存态，首发随会话落库；IT/E2E 验未发不落库 + 首发带正确 model                                    |
| 模型元数据端点为单 provider 一期可能过度设计                        | 元数据由服务端配置/常量派生（不建表），换取二期多 provider 零客户端改动（跨契约 §2.2）；plan 定静态 vs 动态 |
| 模型切换越权改他人会话                                              | 全端点 JWT + accountId 归属校验，越权 404 字节级一致（FR-009 / SC-005）                                     |
| 顶栏下拉在 Expo Web export 路径未冒烟                               | web_compat: untested；mockup/plan 阶段确认下拉 web 行为；Mobile-E2E 以 tap 驱动验证（非手势）               |
| 生成式 AI 合规（算法备案 + 内容标识）                               | 继承 027 Risk（master §2.6）：内容标识 UI 027 已留；不阻塞开发，上线 gate 项                                |
