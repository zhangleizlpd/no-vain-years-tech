---
feature_id: 032-ideation-prd-clarify
modules: [ideation]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-21
updated_at: 2026-06-22
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: '澄清对话为 SSE 流式聊天 UI（复用 027-031 chat 流式范式），Web export 理论可渲染但未冒烟；中央 + FAB 创建入口为盖 tab 栏的 root Modal（多端行为待验）；建议式选项 chips 渲染与自由文本输入降级路径需 Web/native 双验。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 性能预算 (per ADR-0039 SSOT). 澄清对话复用 027/030 SSE 流式预算；会话/草稿 CRUD 为轻量账号级操作。
perf_budgets:
  - endpoint: '新建/列出/查看 idea session (会话 CRUD)'
    p95_ms: 300
    p99_ms: 800
  - endpoint: '澄清对话首 token 延迟 (SSE, 复用 027/030 流式基线)'
    p95_ms: 2000
    p99_ms: 5000
  - endpoint: '生成 requirements brief (收敛产出, 单次结构化产出)'
    p95_ms: 8000
    p99_ms: 20000

# 状态机分支穷举 (per ADR-0040 multi-layer test gate).
state_branches:
  - '从 + FAB 创建入口选 prd灵感 -> 新建 idea session（标题 + status=open）-> 落库归属当前 accountId'
  - '会话 open 态输入模糊初衷 -> AI 反问澄清（流式）-> user/assistant turn 逐轮持久化'
  - '澄清问题答案空间可枚举 + AI 有可辩护推荐 -> 附 2-4 建议选项（含推荐项标注 + 逃生项）-> 用户点选其一即作为本轮回答直接发送（quick-reply 即发，契约 §4.5 翻转 2026-06-22）；点逃生项则聚焦自由输入条自填'
  - '澄清问题开放/创意/无可辩护推荐 -> 仅自由文本（不强给选项）'
  - '任意带选项的轮 -> 用户不点选项直接自由文本输入 -> 照常推进（自由文本永远可用、选项非强制）'
  - '用户触发「生成 brief」-> 从对话收敛产出结构化 brief（核心必填段齐）-> 落 requirements draft + status=converged'
  - '收敛时核心必填段未齐 -> AI 继续追问缺失维度（不产出半截 brief）'
  - '小颗粒需求（小改）-> brief 仅核心必填段、可选段自适应跳过（不强凑大 PRD）'
  - '已 converged 会话 -> 用户导出/复制 brief markdown -> status=handed-off'
  - '已 converged/handed-off 会话 -> 用户重开继续 -> status 回流 open -> 可再追加澄清 / 重新生成 brief（状态非单向终态）'
  - '用户重新生成 brief -> 覆盖该会话上一版（1:1 单份，不留多版本历史）-> status 回 converged'
  - '用户删除自己的会话 -> 移除会话 + 其 turn + brief（账号级永久保留无自动清理；越权删他人被拒字节级一致）'
  - '用户中途退出会话 -> 进度（turn + 草稿）保留为 open -> 重进可继续'
  - '用户查看/列出自己的历史 idea session -> 仅见本 accountId 名下会话'
  - '越权读/写他人 idea session / turn / draft -> 拒绝（accountId 归属校验，字节级一致反枚举，与 027-031 同款）'
  - '未认证/token 失效 -> 401（触发 003 refresh 拦截器 retry-once；仍失败则登出）'
  - 'LLM provider 失败（非 abort）-> 不落半截 assistant turn + 可见错误可重试（复用 030 错误处理范式）'
  - '用户停止生成（abort）-> 已生成半成品 turn 保留（复用 027/030 split-tx stopped 语义）'
  - '空/纯空白初衷或回答 -> 拒绝 + 可见校验（不落空 turn）'
  - 'repo 接地段（影响面/约束护栏等需读代码才能填的 brief 段）-> 本期接地 stub 无数据 -> 留空/手填，不阻塞收敛门（per ADR-0059 仅预留接缝）'
---

# Feature Specification: 移动端「需求灵感澄清」助手 — 文字闭环（ideation B1）

> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> 跨端 feature（server + mobile）。流程：`spec → /speckit-clarify → mockup（design/，覆盖①中央 + FAB 创建入口 root Modal ②澄清对话流式聊天 UI + 建议式选项 chips ③brief 预览/导出，以「澄清访谈 + 可点选建议 + 自由文本永驻」为 baseline）→ plan → tasks → impl`。impl 单 PR（server impl + 真后端 IT + api-client regen + mobile 消费同 PR，per Constitution §V）。mobile 落正交两层：① `[Mobile-E2E]` hermetic UI e2e（验创建入口 → 多轮澄清 → 选项点选/自由文本 → 生成 brief → 导出）+ ② `[Contract-Smoke]` 契约冒烟（打 testcontainers 真 server，验会话/对话/收敛契约对齐 + 真落库 + 流式帧）。
>
> 📐 **[架构决策 SoT]** 本 feature = ideation **第 8 限界上下文**首落地（per [ADR-0057](../../docs/adr/0057-ideation-bounded-context.md)），**B1 PR-1 实装注册四处**（prisma schema `ideation` + ESLint boundaries/Nx tags + moat ownership + business-naming）。多轮对话经 **`integrations/llm` 平台层 port** 复用 LLM provider（per [ADR-0058](../../docs/adr/0058-server-integrations-layer.md)：provider 从 `chat/` `git mv` 到 `integrations/llm/`，chat + ideation 绑同一 port），**禁 import chat ctx**；SSE 流式复用 chat 范式（[ADR-0055](../../docs/adr/0055-chat-ctx-sse-streaming-llm-provider.md)：`reply.hijack()` + split-tx）。repo 接地架构 per [ADR-0059](../../docs/adr/0059-ideation-repo-grounding.md)，**本期仅预留代码级接缝**（检索 tool stub）。brief 段落契约 + DS/M3 两相驱动剧本 + 建议式选项两道闸 + 模型策略（结构化轮默认 M3）的 **HOW 细节** = [ideation-brief-contract-and-elicitation](../../docs/private/plans/2026-06/06-21-ideation-brief-contract-and-elicitation.md)（到 `/speckit-plan` 落地）。
>
> ⚠️ **[范围红线]** 032 = **纯文字版需求澄清闭环**（中央 + FAB 创建入口 → prd灵感 会话 → AI 多轮反问澄清〔含合适时的建议式选项〕→ 收敛结构化 brief → 导出交接）+ **代码级预留接地缝**（会话预留「目标 repo」字段 + 检索 vendor port 位，本期 adapter=stub、不接真实索引、brief 接地段留空/手填）。**不**含：① 多模态初衷（截图/图片标注/语音 ASR）= B2；② 真实 repo 接地/向量检索（索引服务 ready 后另落 S3）；③ 创建菜单里 prd灵感 以外的笔记类型（属 PKM，已 parked）；④ SDD 执行/编码（回电脑端 Claude Code）；⑤ agent-platform 自动交接桥（MVP 交接 = 手动导出/粘贴）；⑥ 归档进 PKM。

## Clarifications

### Session 2026-06-21（/speckit-clarify）

- Q: B1 期（接地 stub）会话的「目标 repo 选择器」UI 怎么处理？ → A: **隐藏，纯后台预留**——B1 不展示 repo 选择器，`repo` 字段 nullable 后台预留；S3 接地 ready 时才加 UI（无非功能占位 UI，不误导用户已有接地能力）。
- Q: 已收敛/已交接（converged / handed-off）会话能否重开继续澄清？ → A: **可重开继续，状态可回流**——任何 converged/handed-off 会话都能再追加澄清轮、重新生成 brief，status 可回到 open（对焦是迭代的，非单向终态）。
- Q: brief 生成后能否重新生成？草稿基数（RequirementsDraft 与会话的关系）？ → A: **可重新生成，覆盖式单份（1:1）**——一会话一份 brief，重新生成覆盖上一版（先简单不过度设计；多版本 v1/v2 历史留后续按需扩展）。
- Q: B1 会话/brief 的保留与删除？ → A: **账号级永久保留 + 用户可手动删除**——无自动清理；用户可主动删除自己的会话（含其对话轮与 brief）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 文字澄清 → 收敛 brief → 导出交接 (Priority: P1)

用户在底部 tab 栏中央的绿色「+」创建入口点开创建菜单，选「prd灵感」新建一个澄清会话并给标题。用户用纯文字写下一段模糊的需求初衷（如「想给行情页加个收藏功能，但不确定范围」）。AI 不直接给方案，而是**主动反问澄清**（范围、边界、目标用户、验收标准、non-goal 等），逐轮把模糊初衷对焦清楚。用户认为对焦清楚后触发「生成 brief」，系统从对话收敛出一份**结构化 requirements brief**（含问题动机 / 用户故事 + 验收标准 / 功能需求 / 成功标准 / 非目标等核心段，外加随 feature 规模自适应的可选段）。用户导出/复制该 brief，回电脑端粘贴进 `/speckit-specify` 接力走 SDD。这是 032 的 MVP 脊柱：把「在路上捕获模糊初衷 → 对焦成可执行需求」搬到移动端。

**Why this priority**: 没有「开会话 → 多轮澄清 → 收敛 brief → 导出」这条链，ideation 功能不成立。这是整个 initiative 的脊柱；建议式选项、会话持久都挂在它建立的「澄清对话 → 结构化产出」链路上。

**Independent Test**: 用一个登录账号从 + FAB 建会话，输入一个真实的模糊初衷；与 AI 多轮澄清（AI 以反问为主导）；触发生成 brief，验证产出结构化 brief 且核心必填段齐；导出 markdown，验证其可直接粘进 `/speckit-specify` 接力建 spec.md（端到端 dogfood）。

**Acceptance Scenarios**:

1. **Given** 用户已登录在首页，**When** 点中央 + FAB → 选 prd灵感 → 输入标题，**Then** 新建一个 status=open 的澄清会话并进入对话。
2. **Given** 会话已开，**When** 用户输入一段模糊初衷，**Then** AI 以澄清反问回应（流式）、不直接跳到给方案，且本轮 user/assistant turn 持久化。
3. **Given** 多轮澄清已让核心维度（范围/边界/用户/验收/非目标）有答，**When** 用户触发「生成 brief」，**Then** 系统产出结构化 brief，核心必填段齐、随规模带可选段。
4. **Given** 已生成 brief，**When** 用户导出/复制，**Then** 得到一份 markdown，可直接粘进 `/speckit-specify` 接力。
5. **Given** 核心维度尚未对焦清楚（缺关键答），**When** 用户触发生成 brief，**Then** AI 继续追问缺失维度，不产出半截 brief。

---

### User Story 2 - 会话持久化、列表与继续 (Priority: P2)

用户的澄清会话是账号级持久的：中途退出 App / 切走，重进能在会话列表看到这条会话并继续对焦；已收敛/已交接的会话也留痕可回看。改写只追加新 turn，不回改既有 turn。

**Why this priority**: 「可保存 + 可列出 + 可继续」是任务态澄清的完整闭环（对焦往往不是一次坐下能完成），但非「澄清即收敛」的最小切片，列 P2。建立在 US1 的会话/对话持久链路之上。

**Independent Test**: 建会话澄清几轮后杀掉重开 App，进会话列表验证该会话在、可继续；继续追加几轮后生成 brief；验证既有 turn 不被改写、状态随阶段流转（open → converged → handed-off）。

**Acceptance Scenarios**:

1. **Given** 一条澄清到一半的 open 会话，**When** 用户退出后重进 App 打开会话列表，**Then** 该会话可见、可继续（进度保留）。
2. **Given** 用户名下有多条会话，**When** 打开会话列表，**Then** 仅见本账号名下会话（不串他人）。
3. **Given** 一条会话已收敛/交接，**When** 用户回看，**Then** 显示其对话历史与已生成 brief，状态正确（converged / handed-off）。

---

### User Story 3 - 建议式选项辅助澄清 (Priority: P3)

为降低移动端打字成本，AI 在**合适的**澄清问题上附带 2-4 个可点选的建议选项（含一个推荐项标注 + 一个「都不是/自己填」逃生项），用户点选即作为本轮回答。**仅当**问题答案空间明确可枚举、且 AI 有可辩护的推荐时才给选项（如「输出流式返回还是一次性全文」这类有明确默认的技术决策）；开放/创意/上下文型问题（如「这功能想达成什么」）只走自由文本。无论是否有选项，自由文本输入永远可用——选项是增强、非强制。

**Why this priority**: 建议式选项是澄清体验的增强项，显著降打字成本，但非「澄清能跑通」的主干（无选项也能纯文字澄清），列 P3。建立在 US1 的对话链路之上。

**Independent Test**: 触发一个可枚举 + 有推荐的澄清问题，验证出现 2-4 选项含推荐标注 + 逃生项，点选后作为本轮回答推进；触发一个开放型问题，验证只出自由文本无选项；在带选项的轮直接自由文本输入，验证照常推进。

**Acceptance Scenarios**:

1. **Given** AI 提出一个答案空间可枚举且有可辩护推荐的澄清问题，**When** 该轮渲染，**Then** 问题下出现 2-4 个可点选建议（推荐项标注 + 末位「都不是/自己填」逃生项）。
2. **Given** AI 提出一个开放/创意/无可辩护推荐的问题，**When** 该轮渲染，**Then** 不出现选项，仅自由文本输入。
3. **Given** 一轮带建议选项，**When** 用户不点选项而直接自由文本输入，**Then** 照常作为本轮回答推进（自由文本永远可用）。
4. **Given** 一轮带建议选项，**When** 用户点「都不是/自己填」，**Then** 落到自由文本输入。

---

### Edge Cases

- **极小需求（小改）**：brief 仅核心必填段、可选段自适应跳过，不强凑大 PRD。
- **空/纯空白输入**：初衷或回答为空白 → 拒绝 + 可见校验，不落空 turn。
- **选项都不满意**：用户点「都不是/自己填」或直接打字 → 落自由文本（逃生口永驻）。
- **中途退出**：进度（turn + 草稿）保留为 open，重进可继续。
- **收敛门未达**：核心必填段缺 → AI 继续追问，不产出半截 brief。
- **provider 失败 / 停止生成**：失败（非 abort）不落半截 assistant turn + 可重试；用户主动停止（abort）保留半成品 turn（复用 027/030 split-tx 语义）。
- **越权他人会话**：非本人 accountId 读/写 idea session/turn/draft 被拒（字节级一致反枚举）。
- **未登录/token 失效**：读/写走现有 401 → 003 refresh retry-once；仍失败则登出。
- **接地段本期无数据**：brief 的「影响面/约束护栏」等需读代码才能填的段在本期接地 stub 下留空/手填，不阻塞收敛（per ADR-0059 仅预留接缝）。
- **创建菜单仅一活入口**：本期 + FAB 面板只挂 prd灵感；其余笔记类型属 PKM（parked），不可见/不可达。
- **会话重开（状态回流）**：converged/handed-off 会话可重开回 open 继续澄清 / 重新生成 brief（非单向终态）。
- **brief 重新生成（1:1 覆盖）**：重新生成覆盖该会话上一版 brief；本期不留多版本历史（v1/v2 后续按需扩展）。
- **删除会话**：用户可删除自己的会话（连带 turn + brief）；越权删他人被拒（字节级一致）；会话/brief 无自动清理（账号级永久保留至用户删除）。
- **repo 选择器不暴露**：本期不展示 repo 选择器 UI；`repo` 字段后台 nullable 预留，S3 接地 ready 才加 UI。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 系统 MUST 在底部 tab 栏中央提供一个「+」创建入口，点击弹出创建面板（盖 tab 栏，作 root 层浮层）；本期面板 MUST 只含「prd灵感」一个活入口（其余笔记类型属 PKM、本期不可见/不可达），用户经其 MUST 能新建一个澄清会话（含标题）。
- **FR-002**: 用户 MUST 能在澄清会话中用纯文字输入模糊需求初衷并开始多轮对话；每轮 user/assistant turn MUST 持久化。
- **FR-003**: AI MUST 以「需求澄清反问」为主导（询问范围/边界/目标用户/验收标准/非目标等），流式回复；MUST NOT 在未对焦时直接跳到给实现方案。
- **FR-004**: AI MUST 仅在「答案空间可枚举 **且** 有可辩护推荐」的澄清问题上附带 2-4 个可点选建议选项（含推荐项标注 + 末位「都不是/自己填」逃生项）；其余问题 MUST 只走自由文本。自由文本输入 MUST 始终可用（带选项的轮亦可直接自由文本作答）。
- **FR-005**: 用户 MUST 能在对焦清楚后触发「生成 brief」；系统 MUST 从对话收敛产出**结构化 requirements brief**，含**核心必填段**（问题动机 / 用户故事 + 验收标准 / 功能需求 / 成功标准 / 非目标）+ **随 feature 规模自适应的可选段**；核心必填段未齐时 MUST NOT 产出半截 brief（继续追问）。用户 MUST 能重新生成 brief；重新生成 MUST 覆盖该会话上一版（**1:1 单份**；多版本 v1/v2 历史留后续按需扩展，本期不建）。
- **FR-006**: 生成的 brief MUST 可导出为 markdown，供用户复制粘贴进电脑端 SDD 流程（交接物 = 自然语言 brief，**非** spec.md / requirements.md）。
- **FR-007**: 澄清会话 MUST 有生命周期状态 open → converged → handed-off，并随阶段流转；MUST 支持从 converged/handed-off **重开回 open**（追加澄清 / 重新生成 brief），状态**可回流**（非单向终态）。
- **FR-008**: 用户 MUST 能查看/列出/继续自己的历史澄清会话；中途退出的会话进度 MUST 保留为 open 可继续；修改 MUST 只追加新 turn、MUST NOT 回改既有 turn。
- **FR-009**: 所有 ideation 操作 MUST 需登录；idea session / turn / draft MUST 按 accountId 归属隔离；越权读/写他人数据 MUST 被拒（字节级一致反枚举）；未认证/失效凭据 MUST 走现有 401 → 003 刷新-重试链路。
- **FR-010**: 澄清对话的 LLM 流式失败（非用户主动停止）MUST NOT 落半截 assistant turn 且 MUST 呈现可重试错误；用户主动停止（abort）MUST 保留已生成半成品 turn（复用 027/030 流式终态语义）。
- **FR-011**: 会话数据模型 MUST 预留「目标 repo」字段（`repo` nullable）且检索能力 MUST 经一个独立接口位承载（接地缝），使本期**不接真实索引**（adapter=stub / feature-flag off，per ADR-0059）即可运行；本期 MUST NOT 实现真实 repo 检索、MUST NOT 拉取真实 repo 列表、MUST NOT 展示 repo 选择器 UI（`repo` 字段纯后台预留，S3 接地 ready 时才加 UI）；brief 的接地段（影响面/约束护栏等需读代码才能填的段）本期留空/手填，且其缺失 MUST NOT 阻塞收敛门。
- **FR-012**: 用户 MUST 能删除自己的 idea session（连带其对话轮与 brief）；会话/brief MUST 账号级永久保留、MUST NOT 自动清理；越权删他人 MUST 被拒（accountId 归属校验，字节级一致）。

### Key Entities _(include if feature involves data)_

- **IdeaSession（澄清会话）**: 任务态短生命周期实体。承载 accountId 归属、title、status（open → converged → handed-off，**可从 converged/handed-off 重开回 open**）、**预留「目标 repo」字段**（`repo` nullable，接地缝，本期不暴露 UI）。按 accountId 隔离；用户可删除（连带 turn + brief）。
- **IdeaTurn（对话轮）**: 一次澄清对话轮。承载所属会话、role（user / assistant）、content；assistant 轮可携带本轮的建议选项数据（问题 + 选项 + 推荐标注 + 是否多选）。逐轮持久、只追加不回改。
- **RequirementsDraft（收敛产出 / brief）**: 从对话收敛的结构化需求 brief。**规范态 = 结构化形态（强约束、可校验核心必填段齐）**，**导出态 = 渲染 markdown**（交接视图）。**一会话一份（1:1）**：重新生成覆盖上一版；多版本（v1/v2）历史留后续按需扩展，本期不建。
- **CreationMenuEntry（创建入口项）**: + FAB 创建面板中的一个入口。本期仅「prd灵感」一项为活入口（路由到 ideation 新建会话）；PKM 笔记类型为未来填充的槽位（本期不存在/不可达）。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户能用本功能把一个真实的模糊初衷，在一次移动端会话内对焦成一份核心必填段齐的结构化 brief（无需打开任何代码文件即可完成纯澄清部分）。
- **SC-002**: 产出的 brief 粘进 `/speckit-specify` 能直接接力建出 spec.md——端到端 dogfood 闭环成立（用本功能为「下一个真实 feature」对焦出 brief 并成功接力）。
- **SC-003**: AI 在澄清对话中 100% 以反问澄清为主导（未对焦时不直接给实现方案）——可观测、可断言。
- **SC-004**: 建议式选项只在「可枚举 + 有可辩护推荐」时出现；开放型问题不出选项；自由文本输入在任何轮都可用——三条均可观测。
- **SC-005**: 澄清会话 100% 账号级持久 + 隔离——中途退出重进可继续、仅见本账号会话、越权读/写他人会话全部被拒（字节级一致）。
- **SC-006**: 核心必填段未齐时系统不产出半截 brief（继续追问）——收敛门有效、可断言。
- **SC-007**: 接地 stub 期，brief 接地段留空不阻塞收敛、会话与导出全链路可跑通——证明「代码级预留接地缝」对 B1 standalone 无依赖外部索引服务。

## Assumptions

- **新建 ideation 限界上下文**：032 = ideation 第 8 ctx 首落地（叶子 ctx，per ADR-0057）；注册四处（prisma schema `ideation` + ESLint boundaries/Nx tags + moat ownership + business-naming）在 B1 PR-1 实装。不塞进 chat ctx。
- **LLM 复用经 `integrations/llm` 平台层**（per ADR-0058）：provider 从 `chat/` `git mv` 到 `integrations/llm/`，chat + ideation 绑同一 `LLM_PROVIDER` port；ideation 禁 import chat ctx（ESLint 边界硬拒）；SSE 流式范式复用 chat（ADR-0055）但自写自己的 stream controller（范式复用 ≠ 代码 import）。此搬迁触碰 chat ctx，是 B1 的前置改造，ADR-0055 届时补 amend。
- **brief 契约 + 驱动剧本 SoT**（与 user 对焦 2026-06-21，落 [契约 doc](../../docs/private/plans/2026-06/06-21-ideation-brief-contract-and-elicitation.md)）：brief 三层段落（T1 核心必填 / T2 接地段非阻塞 / T3 可选）+ JSON-为真相源·markdown-为导出视图 + DS/M3 两相驱动（访谈 auto / 产出 forced）+ 建议式选项两道闸（可枚举 + 可辩护推荐）+ 结构化轮默认 MiniMax M3（DeepSeek V4 恒思考模式不支持强制 tool_choice，作降级 best-effort）。以上为 HOW，到 `/speckit-plan` 落地，spec 不复述机制。
- **收敛触发 = 用户按钮**（与 user 对焦 2026-06-21）：Phase A 访谈 → Phase B 产出 的切换由用户点「生成 brief」触发；AI 可软提示「需求够清楚了」，但不靠模型吐 sentinel 做硬解析。
- **创建入口 = app-shell chrome**（与 user 对焦 2026-06-21，落 [master plan B1](../../docs/private/plans/2026-06/06-21-prd-ideation-to-sdd-master.md)）：中央 + FAB + 创建面板落 `apps/mobile/app/(app)/(tabs)/_layout.tsx`（盖 tab 栏须 root RN Modal），路由到 `apps/mobile/src/ideation/`，非 ideation ctx 自有；优先图二锚定浮层样式，bottom-sheet 作某端难实现时的降级 fallback；完整 grid 属 PKM（parked），本期只挂 prd灵感。
- **接地仅预留接缝**（per ADR-0059，与 user 对焦「代码级预留接地缝」2026-06-21）：会话预留「目标 repo」字段 + 检索 vendor port 位，adapter=stub；本期 repo-blind，brief 接地段留空/手填；索引服务 ready 后另落 S3 点亮真实检索（非本 feature）。**本期 repo 选择器 UI 确定隐藏**（clarify 2026-06-21）——`repo` 字段 nullable 纯后台预留，S3 接地 ready 才加 UI。
- **会话/brief 生命周期**（clarify 2026-06-21）：账号级**永久保留、无自动清理、用户可手动删除**；converged/handed-off **可重开回流** open；brief **1:1 覆盖式单份**（重新生成覆盖上一版，多版本 v1/v2 留后续按需扩展）。
- **复用 027-031 chat 基建**：`LlmProvider`/SSE 流式链路、split-tx 终态语义（completed/stopped/error）、029 会话模型路由、accountId 归属校验 + 字节级一致反枚举、003 refresh 拦截器、Orval typed hook 链路、现有 `~/ui`/`~/theme` 组件（目标 0 新设计 token）、RHF + zodResolver 表单范式（标题输入等）均已就位、经 port 复用。
- **任务态数据模型**：ideation 4 表中本期落 `idea_session` / `idea_turn` / `requirements_draft` 3 表 + repo 预留字段；`idea_attachment`（多模态附件）属 B2，本期不落（具体表/schema/迁移走 bounded-context 决策于 plan 阶段定）。
- **错误处理范式**：LLM 流式失败 / abort / 降级复用 030 既有处理（不落半截、可重试、stopped 半成品保留）。

## Dependencies

- **027-031（已 ship）**：chat 限界上下文的 `LlmProvider` port + SSE 流式链路 + split-tx 终态 + 会话模型路由 + 系统提示组装范式 + accountId 归属/反枚举 + 003 refresh + Orval typed hook 链路。032 经 `integrations/llm` port 复用（不 import chat）。
- **ADR-0057 / ADR-0058 / ADR-0059**：ideation 限界上下文 / `integrations/` 平台层 / repo 接地架构——本 feature 的架构决策基线。
- **现有 mobile app-shell**：底部 tab 导航（`(tabs)/_layout.tsx`，现 4 tab）+ `~/ui`/`~/theme` + 现有 Modal/overlay 范式。
- **现有认证体系**（JWT guard + 003 token refresh）。
- **Orval api-client 生成链路**（server OpenAPI → 类型 + hooks → mobile 消费）。

## Risk

| 风险                                                                          | 缓解                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新建 ideation ctx + LLM provider 从 chat/ 搬到 integrations/（触碰 chat ctx） | B1 PR-1 注册四处一次到位 + provider `git mv` 同 PR；chat 行为不变、IT 全回归；ADR-0055 补 amend 记录物理位置变更                                                              |
| DeepSeek V4 不支持强制 tool_choice → 结构化产出（选项 / brief emit）不保证    | 模型策略：结构化轮默认 M3（`required` 稳定）；DS 作降级 best-effort + 正则兜底 + 吐不出降级纯文本；选项是增强、自由文本永驻——降级路径不阻断主干（详见契约 doc §5，plan 落地） |
| 盖 tab 栏的 + FAB 创建面板多端（iOS/Android/Web）行为不一致                   | 统一走 root RN Modal（盖 tab 栏唯一正确层）；优先图二浮层、bottom-sheet 降级；mockup 阶段定多端落法；Mobile-E2E + 真机/窄视口验（容器尺寸类改动 web e2e 易漏）                |
| 接地段非阻塞设计被误做成收敛硬门 → B1 standalone / 无 repo 会话无法收敛       | FR-011 + SC-007 显式声明 T2 接地段非阻塞、收敛门只查核心必填段；IT 覆盖「接地 stub 期照样收敛 + 导出」                                                                        |
| brief 收敛产出依赖模型结构化能力，质量/稳定性波动                             | 收敛产出走 function-calling 参数 schema（两家都支持）+ 服务端校验核心必填段齐 + 未齐继续追问；dogfood 收口质量（契约 doc §3/§7，plan 落地）                                   |
| 澄清对话长会话 token 预算膨胀                                                 | 复用 027 context 预算窗口范式；接地命中/历史按预算窗口组装；plan 定具体预算（已挂 perf_budgets）                                                                              |
| 任务态会话生命周期 + 多模态/归档未来缝接口被本期堵死                          | FR-011 接地缝 + 单向「→ PKM 归档」seam 接口不堵死（per master plan 跨契约约束）；本期不实现，接口预留                                                                         |
| ideation 限界上下文边界被 LLM/检索外呼误判为跨 ctx 依赖                       | LLM/检索皆 vendor I/O via port（ADR-0043 §4 / ADR-0057 §2），不计入 ctx 依赖；moat 探针 + ESLint boundaries 双层强制叶子方向                                                  |

## Next

已过 `/speckit-clarify`（2026-06-21，4 问：repo 选择器隐藏 / 会话可重开回流 / brief 1:1 覆盖 / 永久保留+手动删除）。剩余低影响 / plan 层项（brief 可选段最小集 / 创建面板图二浮层 vs 降级的多端门槛）留 `/speckit-plan` 或 mockup 阶段定。下一步 `/speckit-plan`（HOW：注册四处 + provider git mv + 两相驱动剧本 + 选项两道闸 + M3 默认 + 接地 stub，引契约 doc）。
