---
feature_id: 028-chat-history-drawer
modules: [chat]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-14
updated_at: 2026-06-14
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: '左侧抽屉滑出依赖手势/侧滑容器(RN drawer)，Web export 路径未冒烟；历史列表/搜索/改名/删除为静态 JSON 端点驱动，Web 可渲染但抽屉手势交互在 web 待验。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 性能预算 (per ADR-0039 SSOT). 历史抽屉的关键体验指标 = 列表首屏加载时延。
perf_budgets:
  - endpoint: 'GET /chat/conversations (会话列表分页)'
    p95_ms: 800
    p99_ms: 1500
  - endpoint: 'GET /chat/conversations?q=<title> (标题模糊搜索)'
    p95_ms: 1000
    p99_ms: 2000

# 状态机分支穷举 (per ADR-0040 multi-layer test gate).
state_branches:
  - '打开抽屉 -> 拉会话列表 -> 按 updatedAt 时间分组(前7天/前30天/更早按年)渲染'
  - '无任何历史会话 -> 抽屉列表区展示空态(仅「新建对话」可用),不报错'
  - '点历史会话行 -> 切换当前会话 + hydrate 该会话消息 -> 关抽屉回对话态'
  - '点「新建对话」-> 清空当前对话回 027 空态 + 关抽屉(未发首条前不落库新 conversation)'
  - '改名会话 -> 提交新 title -> 列表行即时反映 + 落库;空/纯空白 title 拒绝(保留原标题)'
  - '删除会话 -> 二次确认 -> 连带 message 删除 -> 列表移除该行'
  - '删除的是当前正打开的会话 -> 删除后回 027 空态(当前对话清空)'
  - '搜索框输入关键词 -> 按 conversation.title 模糊子串筛选 -> 命中分组列表;无命中展示空结果态'
  - '搜索清空 -> 回到完整时间分组列表'
  - '抽屉操作时 027 流式正在进行 -> 切换/删除当前会话先中断进行中的流(等同 027「停止生成」语义),不丢已落库内容'
  - '未认证/token 失效 -> 401(触发 003 refresh 拦截器 retry-once;仍失败则登出),抽屉不加载列表'
  - '请求他人 conversationId(改名/删除/取消息) -> 404(accountId 归属校验,字节级一致反枚举,与 027/alert/portfolio 同款),不泄露/不串话'
---

# Feature Specification: AI 对话历史会话 + 左侧抽屉（Chat History & Drawer）

> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> 跨端 feature（server + mobile）。流程：`spec → /speckit-clarify → mockup（design/，以 Kimi 图5 + 千问图4 参考截图为 baseline）→ plan → tasks → impl`。impl 单 PR（server impl + 真后端 IT + api-client regen + mobile 消费同 PR，per Constitution §V）。mobile 落正交两层：① `[Mobile-E2E]` hermetic UI e2e（验抽屉滑出/分组/改名/删除/搜索交互）+ ② `[Contract-Smoke]` 契约冒烟（打 testcontainers 真 server，验列表/改名/删除契约对齐 + 真落库）。
>
> 📐 **[模块决策 SoT]** 本 feature 是「AI 对话首页」大模块的子 feature 028，4 项锁定决策 + 跨契约见 [master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §3/§4。**复用 027 已建的 `chat` 限界上下文 + `conversation`/`message` 两表**，不新建 bounded context、不新增表；仅在 `chat` ctx 内增列表/改名/删除/搜索端点。
>
> ⚠️ **[范围红线]** 028 = **历史会话列表 + 左侧抽屉 + 改名/删除/搜索**。**不**含：模型切换下拉（029，顶栏模型名仍只读）、message 全文搜索（仅标题模糊）、会话归档/置顶、多选批量删除、抽屉里的「智能体/我的空间」模块、扫码/铃铛/升级订阅/发现/消息/Claw。搜索范围本期锁定 **conversation.title 模糊子串匹配**（2026-06-14 user 决策）。

## Clarifications

### Session 2026-06-14（specify 阶段 informed defaults）

- 搜索范围（master 阶段 user 决策）：**仅按 conversation.title 模糊子串匹配（ILIKE）**，不搜 message 全文。
- 以下为 specify 阶段合理默认，记入 Assumptions：时间分组按 `updatedAt`；删除走二次确认；改名走 inline 输入；列表 cursor 分页 + 下滑加载；删除当前会话后回空态；抽屉操作中断 027 进行中的流。

### Session 2026-06-14（/speckit-clarify 定稿）

- Q: 删除会话的数据语义（影响 schema 是否加软删列 + 越权/列表查询）？ → A: **物理删除**——conversation 连带 message 单事务硬删，027 两表不加 `deletedAt`，列表/越权查询不变（本期无回收站需求，软删属过度设计）。
- Q: 抽屉底部齿轮「设置」入口指向哪里（决定 028 是否需新建设置屏）？ → A: **复用现有设置 stack**——齿轮跳 `/(app)/settings`，与「我的」(profile) tab 右上角设置按钮**同一目标**（006-account-settings-shell 已建），028 不新建设置页。
- Q: 027 流式进行中时，抽屉里切换/删除当前会话怎么处理？ → A: **先中断流再切换**——切换/删当前会话先 abort 进行中的流（等同 027「停止生成」语义），已落库内容不丢（FR-011）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 打开抽屉浏览历史会话并切换 (Priority: P1)

用户在对话首页点顶栏左上角的 hamburger 图标（027 已留占位按钮），左侧滑出抽屉，看到自己的历史会话按时间分组排列（前 7 天 / 前 30 天 / 更早按年份）。点击任意一条历史会话，抽屉关闭，主屏切换到该会话并加载出完整的历史消息，用户可在该会话内继续追问。这是历史功能的 MVP 核心——只实现这一条，用户已能「找回过去的对话并继续」。

**Why this priority**: 没有「列出历史 + 切换并恢复消息」，历史会话功能不成立。这是 028 的脊柱，改名/删除/搜索都挂在它建立的列表与切换链路上。

**Independent Test**: 用一个有多条历史会话的账号，打开抽屉验证：① 会话按时间正确分组排序（最近的在前）；② 点击某会话能切换并加载出该会话的历史消息；③ 切换后可继续在该会话追问（接 027 流式）。

**Acceptance Scenarios**:

1. **Given** 用户已登录且有历史会话，**When** 点顶栏 hamburger，**Then** 左侧抽屉滑出，历史会话按 updatedAt 分组（前7天/前30天/更早按年）展示，每行显示会话标题。
2. **Given** 抽屉已打开，**When** 点击某条历史会话，**Then** 抽屉关闭，主屏切换到该会话并按序加载其历史消息，用户可继续追问。
3. **Given** 用户当前在某会话中且 027 流式进行中，**When** 切换到另一会话，**Then** 先中断进行中的流（已落库内容不丢），再切换并加载目标会话。
4. **Given** 用户无任何历史会话，**When** 打开抽屉，**Then** 列表区展示空态、不报错，仅「新建对话」可用。

---

### User Story 2 - 新建对话 (Priority: P1)

用户在抽屉顶部点「新建对话」，主屏清空当前对话、回到 027 的空态（带昵称问候 + 输入条），可以开启一段全新的对话。新会话在用户发出首条消息前不落库（与 027 一致：首条消息触发建会话）。

**Why this priority**: 「开新话题」是对话类 App 的高频基本操作，与浏览历史同等核心，故 P1。它复用 027 的空态与首发落库链路，028 只接「清空回空态」的入口。

**Independent Test**: 在任意对话态点抽屉「新建对话」，验证主屏回到空态；此时未发消息前列表不新增空会话；发出首条消息后新会话出现在历史列表「前7天」分组顶部。

**Acceptance Scenarios**:

1. **Given** 用户在某已有会话中，**When** 点抽屉「新建对话」，**Then** 抽屉关闭、主屏清空回 027 空态，输入条就绪。
2. **Given** 点了「新建对话」但尚未发送任何消息，**When** 再次打开抽屉，**Then** 列表不出现空标题的占位会话（未落库）。
3. **Given** 新建对话后发出首条消息，**When** 该会话建立，**Then** 它出现在历史列表最近分组顶部，标题由首条消息派生（复用 027 标题派生）。

---

### User Story 3 - 改名与删除会话 (Priority: P2)

用户可对历史会话改名（默认标题是首条消息派生，可能不够达意）或删除不再需要的会话。删除需二次确认，连带删除该会话的全部消息。

**Why this priority**: 管理历史是「历史会话」完整体验的一部分，但非「找回并继续」的最小闭环，列 P2。建立在 US1 的列表之上。

**Independent Test**: ① 对某会话改名，验证列表行标题即时更新且重进后仍是新名；② 删除某会话，验证二次确认后该行消失、其消息不可再访问；③ 删除当前正打开的会话，验证主屏回空态。

**Acceptance Scenarios**:

1. **Given** 抽屉中某会话行，**When** 用户改名并提交非空标题，**Then** 列表行即时反映新标题且持久化。
2. **Given** 用户改名时提交空/纯空白标题，**When** 提交，**Then** 拒绝并保留原标题。
3. **Given** 抽屉中某会话行，**When** 用户删除并通过二次确认，**Then** 该会话与其全部消息删除，列表移除该行。
4. **Given** 被删除的是当前正打开的会话，**When** 删除完成，**Then** 主屏清空回 027 空态。

---

### User Story 4 - 按标题搜索会话 (Priority: P2)

用户在抽屉的搜索框输入关键词，历史列表按会话标题模糊筛选，快速定位想找的对话。

**Why this priority**: 会话变多后搜索是找回效率的关键，但在会话量小时时间分组列表已够用，故 P2。建立在 US1 列表之上。

**Independent Test**: 在搜索框输入某历史会话标题的子串，验证仅标题命中的会话被筛出；清空搜索回到完整分组列表；输入无命中关键词展示空结果态。

**Acceptance Scenarios**:

1. **Given** 抽屉已打开且有多条会话，**When** 在搜索框输入标题子串，**Then** 列表仅展示标题包含该子串的会话（大小写不敏感）。
2. **Given** 搜索有结果，**When** 清空搜索框，**Then** 回到完整时间分组列表。
3. **Given** 搜索关键词无任何标题命中，**When** 输入完成，**Then** 展示「无匹配会话」空结果态，不报错。

---

### Edge Cases

- **空历史**：账号无任何会话时，抽屉列表区展示空态，仅「新建对话」可用，不报错。
- **大量会话**：列表分页/下滑加载，不一次性拉全量；滚动流畅。
- **改名/删除他人会话（越权）**：请求非本人 conversationId 返回 404（字节级一致反枚举，与 027/alert/portfolio 同款），不串话、不泄露。
- **删除当前正打开的会话**：删除后主屏清空回 027 空态。
- **抽屉操作时 027 流式进行中**：切换或删除当前会话先中断进行中的流（等同 027 停止生成），已落库内容不丢。
- **改名提交空/纯空白**：拒绝，保留原标题。
- **搜索无命中**：展示空结果态，不报错。
- **时间分组边界**：恰好 7 天/30 天临界的会话归属由 plan 明确（含/不含边界），避免跳组歧义。
- **未登录/token 失效**：走现有 401 → 003 refresh 拦截器 retry-once；仍失败则登出，抽屉不加载列表。
- **新建对话未发送即离开**：不产生空标题占位会话（未落库）。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 顶栏 hamburger 按钮（027 占位）MUST 接行为：点击 MUST 从左侧滑出抽屉；抽屉可关闭（点遮罩/侧滑/再点）。
- **FR-002**: 抽屉 MUST 展示当前用户的历史会话列表，按 `updatedAt`（**最近更新**，语义见 Assumptions）时间分组（前 7 天 / 前 30 天 / 更早按年份），组内按 `updatedAt` 倒序（最近在前）。
- **FR-003**: 列表 MUST 仅展示当前用户归属（accountId）的会话；任何对他人会话的访问/操作 MUST 拒绝（越权返回 404 字节级一致）。
- **FR-004**: 点击某历史会话 MUST 切换当前会话并按序加载其历史消息（复用 027 取消息），随后关闭抽屉回到对话态。
- **FR-005**: 抽屉顶部 MUST 提供「新建对话」入口；点击 MUST 清空当前对话回到 027 空态；新会话在发出首条消息前 MUST NOT 落库（与 027 首发建会话一致）。
- **FR-006**: 用户 MUST 能为会话改名；提交非空标题 MUST 持久化并即时反映于列表；空/纯空白标题 MUST 拒绝并保留原标题。
- **FR-007**: 用户 MUST 能删除会话；删除 MUST 经二次确认；删除 MUST 连带移除该会话的全部消息（**物理删除/硬删，单事务**，027 两表不引软删列）；删除后列表 MUST 移除该行。
- **FR-008**: 删除的若是当前正打开的会话，主屏 MUST 清空回到 027 空态。
- **FR-009**: 抽屉 MUST 提供搜索框，按 `conversation.title` 模糊子串匹配（大小写不敏感）筛选会话；清空搜索 MUST 回到完整分组列表；无命中 MUST 展示空结果态。搜索 MUST NOT 检索 message 正文（本期范围红线）。
- **FR-010**: 抽屉底部 MUST 展示用户头像 + 昵称（读现有 /me）+ 齿轮图标；齿轮 MUST 跳转现有设置 stack `/(app)/settings`（与「我的」profile tab 右上角设置按钮同一目标，006-account-settings-shell 已建），本期不新建设置页。
- **FR-011**: 当 027 流式回复进行中时，切换会话或删除当前会话 MUST 先中断进行中的流（等同 027 停止生成语义），已落库内容 MUST 不丢。
- **FR-012**: 所有 chat 历史端点 MUST 走现有认证；未认证/失效凭据 MUST 走现有 401 刷新-重试链路（003）。
- **FR-013**: 会话列表 MUST 支持分页（避免一次性拉全量），用户下滑可加载更多。
- **FR-014**: 顶栏模型名 MUST 保持只读（模型切换属 029，本期不实装）。

### Key Entities _(include if feature involves data)_

- **Conversation（会话）**: 复用 027 已建实体。本期读取其标题、所用模型标识、更新时间（用于分组排序）；新增「改名」（更新 title）与「删除」（连带 message）两种写操作。归属 accountId。
- **Message（消息）**: 复用 027 已建实体。本期读取（切换会话时按序加载）；随会话删除而连带删除。不新增字段。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户打开抽屉后，历史会话列表在 p95 ≤ 0.8 秒内呈现（体感「立即看到历史」）。
- **SC-002**: 点击历史会话切换后，该会话历史消息完整加载、顺序正确、无丢失。
- **SC-003**: 历史会话时间分组正确（前7天/前30天/更早按年），组内按最近更新倒序。
- **SC-004**: 改名后列表即时反映新标题，刷新/重进后仍是新名（持久化成功率 100%）。
- **SC-005**: 删除会话后，该会话及其消息 100% 不可再访问；误删保护 = 删除前必有二次确认。
- **SC-006**: 标题搜索命中准确——所有标题包含关键词（大小写不敏感）的会话被列出，无包含的不出现。
- **SC-007**: 用户无法看到或操作他人的会话与消息（越权访问/改名/删除全部被拒）。
- **SC-008**: 抽屉操作（切换/删除当前会话）在 027 流式进行中触发时，无残留流、无内容丢失、无界面卡死。

## Assumptions

- **决策继承**：4 项锁定决策 + 跨契约来自 [master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §1/§2/§3/§4，已与 user 对焦（2026-06-14）。028 实现其中「历史会话 + 左抽屉 + 管理」部分，复用 027 已建表与 chat ctx。
- **复用 027 基建**：`chat` 限界上下文、`conversation`/`message` 两表、accountId 归属校验、003 refresh 拦截器、Orval typed hook 链路均已就位（027 ship）。028 不新建 bounded context、不新增表，仅增 list/rename/delete/search 端点（JSON，非 SSE）。
- **搜索范围**（master 阶段 user 决策 2026-06-14）：仅 `conversation.title` ILIKE 模糊子串，不搜 message 全文；PG 原生即可，不引全文索引/trigram。
- **时间分组依据**（analyze 定夺 2026-06-14，决策 a）：按 `updatedAt` 分组与排序。⚠️ `updatedAt` 语义 = **最近更新**，非「最近发消息活跃」——继承 027 行为：conversation 仅在**创建 / 首条消息派生标题 / 改名**时刷新 `updatedAt`，**不随每条后续消息刷新**（`send-message.usecase` 只在 `title===EMPTY_TITLE_FALLBACK` 时更新）。故活跃多轮老会话不会因新消息上浮；改名会使会话上浮（接受，改名=一次更新）。028 **不改 027 send-message**（不溢出 scope）。具体临界（前7天含/不含边界）plan 阶段定。
- **改名交互**：inline 输入提交（弹窗或行内编辑，mockup 阶段定）；空/纯空白拒绝。
- **删除语义**（clarify 定稿）：二次确认 + 连带删除 message；删除当前会话回空态。**物理删除/硬删（单事务）**，027 两表不加 `deletedAt`；软删/归档/回收站本期 out of scope。
- **分页**：cursor 分页 + 下滑加载更多；页大小 plan 定。
- **新建对话**：复用 027 空态与首发落库；未发首条前不落库（无空标题占位会话）。
- **流式中断协同**：抽屉切换/删除当前会话时若 027 流进行中，先 abort 当前流（复用 027 停止语义），不丢已落库内容。
- **认证/越权**：复用现有 JWT + 003 refresh；会话按 accountId 归属（`req.user.accountId`）；越权他人 conversationId 返回 **404 字节级一致**（反枚举，与 027/alert/portfolio 同款），不返回 403。
- **设置入口**（clarify 定稿）：齿轮跳现有设置 stack `/(app)/settings`（006-account-settings-shell 已建，与「我的」profile tab 右上角设置按钮 `router.push('/(app)/settings')` 同一目标）；028 不新建设置页，仅接跳转。

## Dependencies

- **027（已 ship）**：chat 限界上下文 + `conversation`/`message` 两表 + 取消息端点 + 空态/首发落库 + 停止生成（流式中断）。
- 现有认证体系（JWT guard + 003 token refresh 拦截器）。
- 现有 /me（profile）——抽屉底部头像 + 昵称（FR-010）。
- Orval api-client 生成链路（server OpenAPI → 类型 + hooks → mobile 消费）。
- RN 抽屉/侧滑容器方案（plan 阶段选型：react-navigation drawer / 自绘 + Reanimated 手势，复用现有 `~/ui`/`~/theme`，0 新设计 token 目标）。

## Risk

| 风险                                      | 缓解                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| RN 抽屉手势在 Expo Web export 路径未冒烟  | web_compat: untested；mockup/plan 阶段确认抽屉库的 web 行为；Mobile-E2E 以可驱动交互验证（非纯手势）  |
| 删除连带 message 的数据一致性（孤儿消息） | 服务端单事务删除 conversation + 其 message（或 DB 级 ON DELETE 语义，plan 定）；IT 验删后消息不可访问 |
| 抽屉操作与 027 进行中流的并发             | FR-011：切换/删当前会话先 abort 流；state_branches 覆盖；Mobile-E2E + 单测验证无残留                  |
| 会话越权改名/删除                         | 全端点 JWT + accountId 归属校验，越权 404 字节级一致（FR-003 / SC-007）                               |
| 时间分组边界歧义（跳组）                  | plan 明确临界含/不含；纯函数分组逻辑 vitest 覆盖边界                                                  |
| 大量会话列表性能                          | 分页 + 下滑加载（FR-013）；`@@index([accountId, updatedAt])`（027 已建）支撑列表查询                  |
