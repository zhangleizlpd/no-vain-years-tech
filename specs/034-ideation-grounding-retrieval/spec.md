---
feature_id: 034-ideation-grounding-retrieval
modules: [ideation]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-23
updated_at: 2026-06-23
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: 'mobile 侧新增「选择代码库」真实列表 + 助手消息内来源（sources）展示；均为既有 SSE 澄清屏内的增量 UI。原生交互在 iOS/Android 未冒烟；Playwright Expo Web 作 e2e harness（code-index 走 mock）；不对用户发布 Web 版。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 状态机分支穷举 (per ADR-0040 multi-layer test gate). 本 feature = 跨端（server 接地检索接线 + catalog 端点 + mobile repo 选择器 + 来源展示）, 分支为「选库 → 接地检索 → 降级」三条链路的交互/异常态.
state_branches:
  - '会话未选 repo（idea_session.repo 为空）-> 助手不触发接地检索（codeindex_retrieval 对 LLM 不可用或返“未选仓库”）-> 澄清照常进行（无来源引用）'
  - '会话已选 repo + 助手判定需查代码 -> 调 codeindex_retrieval -> code-index /search 命中 -> 命中 chunk 作 tool_result/sources 帧回流 -> 助手消息引用真实代码/ADR 并展示来源'
  - '会话已选 repo + /search 命中 0 结果 -> 工具返空结果集（非错误）-> 助手据“未找到相关代码”继续澄清 -> 不崩、不误造引用'
  - 'code-index 服务不可达（停服/超时/网络错/鉴权失败）-> 工具优雅降级返空 + 一次性降级提示 -> 会话不阻断、可继续多轮澄清'
  - 'catalog 端点返回可用 repo 列表 -> 用户在「选择代码库」选中某仓 -> 写入 idea_session.repo -> 本会话接地命名空间锁定该仓'
  - 'catalog 返回空（无 ready 状态的 repo）-> 「选择代码库」显示空态/提示 -> 不可选 -> 接地不可用（澄清仍可进行）'
  - 'catalog 端点不可达/出错 -> 「选择代码库」错误态 + 可重试 -> 不崩、不写脏 repo 值'
  - '会话进行中切换到另一 repo -> 后续轮接地命名空间更新为新 repo（既有轮的引用不回改）'
  - '选 repoA 时检索只命中 repoA 命名空间；切 repoB 后只命中 repoB（命名空间严格隔离，不串仓）'
---

# Feature Specification: ideation 接地检索接线（grounding · S3）

> 🎯 **[流程 — 跨端 feature（per [sdd.md](../../docs/conventions/sdd.md)）]**
> **跨端**（server 接地检索接线 + catalog 端点 + mobile 消费）。impl 走**单 PR**：server impl + 真后端 IT（`IDEATION_FAKE_LLM` + code-index 走 mock/stub provider）+ `@nvy/api-client` regen + mobile 消费同 PR（per [Constitution §V](../../.specify/memory/constitution.md)）。验证落**正交两层**：① `[Mobile-E2E]` hermetic UI e2e（Playwright Expo Web，code-index 检索走 mock）+ ② `[Contract-Smoke]` 契约冒烟（node 层打 testcontainers 真 server，验 catalog/接地帧契约对齐）。
>
> 📐 **[范围 SoT]** 本 feature = ideation **接地子 plan 的 S3 接地消费工作（原 B2-4「接索引库」整合至此）**，单一 SoT = [接地 master S3 节](../../docs/private/plans/2026-06/06-21-ideation-grounding-and-cc-handoff.md)。**交付 = 去两个 stub 并接线**：① `codeindex_retrieval` 工具由 stub 返空改为真调 S2 [code-index](../../services/code-index/) 检索并把命中代码作来源回流；② mobile「选择代码库」入口由 stub toast 改为拉真实 catalog + 写 `idea_session.repo` 锁定接地范围。**显式 defer**：网络暴露（WireGuard 62↔77 + `CODE_INDEX_URL` env 9 位置 boot-path）= 部署前置，plan 阶段细化、impl 可先本地直连/mock；语音（B2-2）/ 图片标注（B2-3）= 正交多模态，不在本 feature；S2 服务自身（builder / 索引 / 部署）已 ship（#550/#552），本 feature 仅**消费**其 `POST /search` + `GET /repos`。**不动**：B1 已 ship 的 SSE 澄清闭环骨架（[032](../032-ideation-prd-clarify/spec.md)）、B2-1 已 ship 的输入栏 chrome（[033](../033-ideation-multimodal-input-shell/spec.md)）。

## Clarifications

### Session 2026-06-23

- Q: 接地命中的「来源（sources）」在助手回答里怎么展示？ → A: **折叠列表**——回答下挂一个默认折叠的「来源（N）」条目，点开看文件 + 位置；单轮展示设上限（默认 ≤ 5 条），不淹没澄清正文。
- Q: code-index 不可达时的「降级提示」用什么形态？ → A: **会话内一次性系统气泡**（如「本次未接地——索引服务暂不可用」），留痕、可被 e2e 稳定断言、不打断输入。
- Q: 会话「未选仓」时接地检索工具对 LLM 怎么处理？ → A: **不暴露工具（条件注册）**——未选仓时根本不把 `codeindex_retrieval` 交给 LLM；用户选仓后才注入该工具。
- Q: 助手触发检索时要不要给「正在检索代码…」的可见指示？ → A: **复用既有 `tool_start` 帧**——流式期间显示短暂「正在检索代码…」指示，与 chat 030 工具调用范式一致。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 基于真实代码现状澄清需求（Priority: P1）

用户在移动端打开一次「需求灵感澄清」会话，**先选定本次要对焦的目标代码库**，然后用自然语言描述一个模糊的功能初衷（如「我想在首页加一个 X 功能」）。澄清助手在追问时**主动检索目标仓库的真实代码与设计决策**，引用实际存在的文件 / 模块 / ADR，并指出新需求与既有上下文的关系（冲突、可复用、需扩展），而不是凭空假设。每条引用了代码的回答都**展示来源**（命中的文件 + 大致位置），让用户能判断助手是否真的「看过」仓库。

**Why this priority**: 这是整个接地子 plan 的北极星价值——让澄清「对仓库有上下文感知」。没有它，ideation 退回到 027-031 已证不足的 repo-blind 模式（~75-80% 需求决策需现场查代码才能定）。是 dogfood 闭环（对焦 brief → 交接 SDD）成立的前提。

**Independent Test**: 预置一个已索引的 repo（mono），开会话选中它，问一个需要查代码才能答好的需求；验证助手回答中触发了检索、引用了仓库中**真实存在**的代码/ADR、展示了来源条目，且引用内容可在仓库中核对到。

**Acceptance Scenarios**:

1. **Given** 会话已选定目标 repo（如 mono）, **When** 用户问「在首页 chat 入口加一个 X 功能」, **Then** 助手在澄清回答中引用仓库内真实相关代码/ADR、指出与既有上下文的关系，并在该回答下展示来源（文件 + 位置）。
2. **Given** 助手正在流式作答, **When** 接地检索命中结果, **Then** 来源以流式帧增量呈现（与现有澄清流式体验一致），不打断正文输出。
3. **Given** 用户就同一需求追问多轮, **When** 每轮触发检索, **Then** 各轮来源各自归属对应回答，不混淆、不重复堆叠历史来源。

---

### User Story 2 - 选择 / 切换接地代码库（Priority: P1）

用户在会话起手（或会话进行中）通过输入区「选择代码库」入口，看到一份**当前可接地的真实仓库列表**（含每个仓库的可读状态信息，如最近索引时间 / 是否就绪），选中其中一个后，本次会话的接地范围即锁定到该仓库；之后的检索只命中该仓库。用户可在会话中切换到另一个仓库，后续追问改用新仓库接地。

**Why this priority**: 接地必须有明确的「针对哪个仓库」边界——否则检索命名空间无从锁定，多仓场景会串仓。是 US1 检索能正确 scoping 的前置；与 US1 同属 MVP（二者合起来才构成「选对仓 + 查对代码」的最小闭环）。

**Independent Test**: 开会话点「选择代码库」，验证列表来自真实 catalog（非 stub toast）、含可读状态；选中一仓后会话记录下该选择并持久化；重开同会话仍记得所选仓。

**Acceptance Scenarios**:

1. **Given** 至少一个仓库已就绪可接地, **When** 用户点「选择代码库」, **Then** 弹出真实仓库列表（每项含名称 + 可读状态信息），而非「即将开放」提示。
2. **Given** 用户选中某仓库, **When** 选择生效, **Then** 本会话接地范围锁定该仓、并持久化（重进会话仍保留所选）。
3. **Given** 会话已选 repoA 且产生过接地回答, **When** 用户切换到 repoB, **Then** 后续追问的检索只命中 repoB；已产生的 repoA 引用不被回改。
4. **Given** 当前无任何就绪仓库, **When** 用户点「选择代码库」, **Then** 显示空态/提示而非崩溃；澄清仍可在无接地下进行。

---

### User Story 3 - 接地服务不可用时优雅降级（Priority: P2）

接地索引服务是**实验性、可被手动停**的非 always-on 设施。当它不可达（停服 / 超时 / 网络错 / 鉴权失败）时，用户的澄清会话**不应被打断**：助手照常追问与收敛，只是这一轮不带真实代码引用，并给用户一个**可感知的降级提示**（而非静默假装查过、也不报错卡死）。

**Why this priority**: 韧性需求，决定接地能否安全地「按需开关」。不是首轮价值（P1 是接地本身），但缺了它一旦索引服务下线整个 ideation 会话不可用，违反 ADR-0060「服务可手动停 + chat 降级」既定原则。

**Independent Test**: 令 code-index 不可达（停服或 mock 返错），开会话选仓后提问；验证会话继续、助手给出降级提示、不出现伪造引用、不崩、可继续多轮。

**Acceptance Scenarios**:

1. **Given** 会话已选仓但 code-index 不可达, **When** 助手本该触发检索, **Then** 检索优雅返空、助手继续澄清并以会话内一次性系统气泡展示降级提示，不报错中断。
2. **Given** 检索命中 0 结果（服务正常但无相关代码）, **When** 助手作答, **Then** 助手明确「未在该仓找到相关代码」并据此继续，不编造引用。

---

### Edge Cases

- **未选仓直接提问**：会话 `repo` 为空 → 不触发接地（不报错、不阻断），助手在无来源下澄清；可引导用户去「选择代码库」获得接地。
- **catalog 与检索状态不一致**：catalog 显示某仓就绪、但检索时该仓恰好不可查 → 按 US3 降级处理，不让用户卡在「选了却查不到」。
- **流式中途服务掉线**：检索调用发起后服务中断 → 当轮按降级收尾，不污染已输出正文。
- **超长 / 空查询**：助手生成的检索查询为空或异常 → 视作 0 命中，不调用或调用即返空。
- **来源过多**：单轮命中大量 chunk → 默认折叠 + 展示上限（默认 ≤ 5 条，per Clarifications），避免淹没澄清正文；具体上限数值留 plan 微调。
- **切仓时机**：用户在助手流式作答中途切仓 → 当轮沿用原仓、下一轮起用新仓（不中途换 scoping）。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 系统 MUST 在澄清会话中，当助手判定需要了解目标仓库代码现状时，对**已选定的目标仓库**发起真实代码检索（替换现有 stub 返空行为）。
- **FR-002**: 系统 MUST 将检索命中的代码片段作为**来源**回流到对应的助手回答，并以流式方式增量呈现，与既有澄清流式体验一致；来源以**默认折叠的列表**（「来源（N）」可展开）呈现，单轮展示设上限（默认 ≤ 5 条）。
- **FR-003**: 系统 MUST 把检索范围严格限定在会话当前选定的目标仓库；不同仓库之间命名空间隔离，不得串仓返回他仓内容。
- **FR-004**: 用户 MUST 能在「选择代码库」入口看到当前**可接地的真实仓库列表**（来自索引服务的 catalog），每项含仓库名与可读状态信息（如最近索引时间 / 就绪状态）。
- **FR-005**: 用户 MUST 能从列表中选定一个目标仓库；系统 MUST 将该选择**持久化到该会话**，重进会话保留所选仓。
- **FR-006**: 用户 MUST 能在会话进行中切换目标仓库；切换后**后续轮**的检索使用新仓库，已产生的引用不回改。
- **FR-007**: 当目标仓库未选定时，系统 MUST 不触发接地检索且不报错；澄清流程照常进行（无来源引用）。实现上 MUST 采**条件注册**——未选仓时不把检索工具暴露给助手（LLM），用户选仓后才注入。
- **FR-008**: 当索引服务不可达（停服 / 超时 / 网络错 / 鉴权失败）时，系统 MUST 优雅降级——检索返空、会话不中断、并以**会话内一次性系统气泡**给出可感知降级提示，绝不静默伪造引用、绝不卡死。
- **FR-009**: 当检索命中 0 结果时，系统 MUST 将其与「服务不可达」区分处理，助手据「未找到相关代码」继续澄清。
- **FR-010**: 当无任何就绪仓库或 catalog 不可达时，系统 MUST 给出空态/错误态（可重试），不崩溃、不写入脏的仓库选择值。
- **FR-011**: 系统 MUST 复用既有 ideation 澄清的对话/流式与工具调用范式，不得为本 feature 重建并行的对话通道；接地能力以助手可调用的检索工具形态接入。
- **FR-012**: 来源展示 MUST 让用户可识别引用出处（至少：仓库内文件标识 + 大致位置），以便判断引用真实性。
- **FR-013**: 当助手触发接地检索时，系统 MUST 复用既有工具调用流式指示（`tool_start` 帧）向用户展示短暂「正在检索代码…」可见态。

### Key Entities _(include if feature involves data)_

- **会话目标仓库（idea_session.repo）**: 一次澄清会话锁定的接地目标仓库标识；为空表示未接地；可在会话中被切换。字段已存在于现有数据模型，本 feature 赋予其真实写入与读取语义（此前为占位）。
- **可接地仓库目录项（catalog entry）**: 索引服务暴露的、当前可被接地的仓库条目，含仓库名 + 可读状态（最近索引 commit / 时间、规模、就绪 / 索引中）。供「选择代码库」列表呈现。
- **接地来源（grounding source）**: 一次检索命中的代码证据条目，含出处（仓库 / 文件 / 位置）与片段内容，归属到触发它的助手回答。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 对一个已索引仓库，针对「需查代码才能答好」的需求提问时，助手回答**引用到仓库中真实存在的代码/ADR**（人工核对可在仓库定位到）的比例 ≥ 90%（不出现凭空捏造的文件/路径）。
- **SC-002**: 选定 repoA 后的检索结果 100% 属于 repoA；切换到 repoB 后 100% 属于 repoB（命名空间隔离，零串仓）。
- **SC-003**: 当索引服务不可达时，澄清会话仍可完成「提问 → 多轮追问 → 收敛 brief」全流程，会话中断率为 0；用户能感知到「本次未接地」。
- **SC-004**: 用户可在会话内 1 步打开「选择代码库」并看到真实可接地仓库列表（非占位提示），选定后接地范围立即对后续提问生效。
- **SC-005**: 端到端 dogfood：用本 feature 为「下一个真实 feature」对焦出引用了真实仓库现状的 brief，可直接粘进 `/speckit-specify` 接力建 spec.md。

## Assumptions

- **S2 服务可消费**：索引服务的检索（按仓库命名空间查）与仓库目录（列可接地仓库 + 状态）能力已上线且契约可用（per #550/#552）；本 feature 仅消费，不改其内部。
- **接地范围 = 每会话单仓**：一次会话同一时刻锁定一个目标仓库（可切换），不支持单轮跨多仓联合检索（与接地 master「每会话单 repo」一致）。
- **来源呈现形态**：已定为**默认折叠的列表**（「来源（N）」可展开看文件 + 位置，单轮上限默认 ≤ 5 条，per Clarifications）；仅展示上限的精确数值与折叠交互细节留 plan/mockup 微调，出处可识别（FR-012）为硬约束。
- **检索触发由助手判定**：是否检索、用什么查询，由澄清助手在对话中自行决定（工具调用范式），不由用户手动触发检索动作。
- **网络暴露为部署前置**：跨机访问索引服务的加密隧道与服务端连接配置属部署事项，在 plan 阶段细化；本 feature 的业务实现与验证可在本地直连 / mock 索引服务下完成（不被部署阻塞）。
- **未选仓默认不接地**：缺省不替用户挑仓；接地是用户显式选仓后才启用的能力。
- **复用现有平台能力**：对话流式、工具调用、LLM 接入沿用既有 ideation / 平台层范式（不 import chat ctx；LLM 经平台 LLM 端口）。
