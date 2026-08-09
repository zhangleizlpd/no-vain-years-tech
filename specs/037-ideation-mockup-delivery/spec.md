---
feature_id: 037-ideation-mockup-delivery
modules: [ideation]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-27
updated_at: 2026-06-27
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: '渲染 = 把交付的 mockup HTML 放进隔离内嵌视图（native = react-native-webview；Expo Web = sandboxed iframe，本就是 web 原语）。Playwright Expo Web 作 e2e harness：mockup 产物 URL 经 route.fulfill 镜像契约返确定性 fixture HTML，验交互骨架（打开有 mockup 的 session → 拉列表 → 渲染最新版 → 多状态屏可浏览 → 空态/降级态）。native WebView 真机渲染（沙箱隔离 / 备案自定义域内联展示）未冒烟，留真机手动验证；不对用户发布 Web 版。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 状态机分支穷举 (per ADR-0040 multi-layer test gate). 本 feature = 跨端
# (server: worker-token scoped 凭证端点 + IdeaMockup 首建 + 写/读端点; mobile: 隔离内嵌渲染 +
# 多版列举). 分支为「交付 + 渲染 + 多版 + 反枚举 + 降级」诸链路.
state_branches:
  - 'agent 交付：headless 通路为某 session 上传 mockup 产物（最小权限、短时效、scope 锁本 session 前缀的凭证）→ 落 mockup 交付记录关联 session → App 可见'
  - 'App 打开有 mockup 的 session → 拉该 session mockup 列表 → 隔离内嵌视图渲染最新版（单自包含文档，多状态屏可滚动浏览）'
  - 'App 打开无 mockup 的 session → 空态（非错误，不阻断 session 其余功能）'
  - '同一 session 多版交付（迭代）→ App 列出多版（版本/交付时间标识），渲染最新版，历史版可见/可切'
  - '上传凭证签发失败（存储未配置 / 超时 / 请求越权 scope）→ 降级提示，不交付半截记录、可重试'
  - '直传失败（签名 / size 被存储拒 / 网络非 2xx）→ 不落库、不脏写、可重试'
  - '落库后产物实际不可达（谎报 key / 产物被删 / 加载失败）→ App 渲染降级一次性提示，不崩、不阻断 session'
  - '跨账户 / 不存在 session 请求 mockup 列表或上传凭证 → 反枚举字节级一致折叠（与「空 / 不存在」不可区分，沿 ideation 既有 FR-013）'
  - '不可信 mockup HTML 渲染隔离 → 无法读取 / 影响 App 主上下文（凭据 / 会话 / DOM / 脚本越界 / 任意外链跳转）'
---

# Feature Specification: ideation mockup 交付链路 + App 渲染（Phase D §A）

> 🎯 **[流程 — 跨端 feature（per [sdd.md](../../docs/conventions/sdd.md)）]**
> **跨端**（server：headless 通路上传 mockup 的 worker-token scoped 凭证端点 + 首建 mockup 交付记录 + 写/读端点；mobile：在隔离内嵌视图渲染交付的 mockup + 按 session 列举多版）。impl 走**单 PR**：server impl + 真后端 IT（fake-llm / 无外部依赖，存储签名/直传经 mock）+ `@nvy/api-client` **regen**（新增 mockup 凭证 / 写记录 / 读列表端点）+ mobile 消费同 PR（per [Constitution §V](../../.specify/memory/constitution.md)）。验证落**正交两层**：① `[Mobile-E2E]` hermetic UI e2e（Playwright Expo Web，mockup 产物经 `route.fulfill` 镜像契约返 fixture HTML，验「打开 session → 列表 → 渲染 → 多状态屏 → 空态 / 降级」交互骨架）+ ② `[Contract-Smoke]` 契约冒烟（node 层打 testcontainers 真 server，类型化 client 验上传凭证签发 scope + 写记录 prefix 归属校验 + 读列表反枚举对齐 + 真落库）。
>
> 📐 **[范围 SoT]** 本 feature = Phase D **§A（mockup 交付 + App 渲染）的 mono 两端**，权威基线 = [Phase D 设计 §A 交付架构 + §E 4 开放问题终判](../../docs/private/plans/2026-06/06-27-ideation-mockup-phase-d-delivery-seam.md)。**交付 = 把子plan3 已通的「headless 只产本地 preview」接成「云端交付 + App 渲染」**：agent 为某 ideation session author 出的 mockup → 持久化交付（上传 + 落库关联 session）→ 用户在 App 打开该 session 即在隔离内嵌视图渲染浏览（含多状态屏），完成「灵感 → 看到设计稿」的批评循环闭环。
> **架构（spec 作约束、不重新选型，详见 [设计 doc §A/§E](../../docs/private/plans/2026-06/06-27-ideation-mockup-phase-d-delivery-seam.md)）**：① 上传方 = headless 通路（agent-platform 仓 channel，**仓外**），以 **worker 自证身份 + server 据所认领任务派生最小权限 scoped 凭证**直传对象存储（字节不经 server，对齐 [ADR-0045](../../docs/adr/0045-object-storage-image-upload.md) PostObject + 业界 credential-vending 范式）；② 落库 = 首建 **mockup 交付记录**（ideation 领域记录，贫血 Prisma row per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)），App 走读端点列举；③ 产物 = **单自包含文档**（多状态屏内联合并），App **沙箱隔离内嵌视图 + 受限内容策略**渲染，经**备案自定义展示域**内联展示。
> **复用**：OSS PostObject 平台签名器（`integrations/oss/` `buildPostObjectCredential`，036 抽取）/ 通用事件队列认领 + worker 鉴权（[agent-bridge 子plan3](../../docs/private/plans/2026-06/06-26-app-to-mac-openclaw-event-channel-master.md)）/ ideation 反枚举范式（[036](../036-ideation-image-annotation/spec.md) FR-013）/ ideaSession 关联（[032](../032-ideation-prd-clarify/spec.md)）。
> **显式不做**：session→spec「毕业接缝」/ DS catalog 同步（Phase D §C，独立 track、未拍）；agent 侧 channel 的内联 + 上传**实现**（在 sibling 仓 agent-platform，独立 PR）；mockup 的 author **生成**逻辑本身（已由 `/mockup-gen-from-brief` 命令承担）；备案自定义展示域的 infra 绑定（交付前置依赖，见 Assumptions）。

## Clarifications

### Session 2026-06-27

- Q: 同一 session 多版 mockup 的保留与切换模型？ → A: **保留全部历史版本（append-only，新交付不覆盖旧）**；App 列出多版、默认渲最新、可切换历史版单独渲染（US2 成立）。
- Q: mockup 交付记录带哪些展示元数据供 App 列举 / 渲染？ → A: **逐屏标签清单（per-screen labels，无文档内锚点）** + 产物定位 + 版本 / 交付时间；App 据此展示「含哪些状态屏」并整体渲染单自包含文档。
- Q: session 打开时已交付 mockup 的「新鲜度」？ → A: **打开即拉最新（fetch-on-open），无 session 内实时刷新**；交付发生在用户未查看时下次打开 / 重新进入可见。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 灵感 session 的 mockup 交付到 App 并能 review (Priority: P1)

用户在某个 ideation 灵感 session 里通过澄清助手通路（App→Mac，子plan3 已通）让系统生成了一版 mockup 设计稿。生成完成后，这版 mockup 自动交付到云端并与该 session 关联。用户在 App 打开这个 session，就能看到这版 mockup 在一个内嵌视图里渲染出来——含 mockup 的多个状态屏（空 / 加载 / 错误 / 成功等），可滚动浏览。用户据此对这版设计做「灵感批评」（哪里对、哪里要调），为下一步迭代或毕业成正式 feature 做准备。当前 headless 只产本地 preview、App 里看不到——本 story 补上这一段，是整个 feature 的最小可用闭环。

**Why this priority**: 这是 §A 的核心价值——把「agent 生成的 mockup」从「本地不可见」变成「App 内可 review」。没有它整个交付链路不成立；有它（即使没有多版迭代），用户已能在 App 里看到并评判一版灵感设计稿。

**Independent Test**: 在「mockup 产物 URL 经 `route.fulfill` 镜像契约返确定性 fixture HTML + 读列表端点经 mock 返一条该 session 的 mockup 记录」的 hermetic 环境下，打开该 session → 验拉到该 session 的 mockup → 在隔离内嵌视图渲染出 fixture → 多状态屏可浏览。server 侧经 contract-smoke 验上传凭证 scope 锁本 session 前缀 + 写记录后读端点真返该记录。

**Acceptance Scenarios**:

1. **Given** 一个已交付 mockup 的 ideation session，**When** 用户在 App 打开该 session 的 mockup 区域，**Then** 该 mockup 在隔离内嵌视图中渲染出来，可浏览其内含的全部状态屏。
2. **Given** headless 通路完成一次 mockup author，**When** 通路以 scope 锁本 session 前缀的最小权限凭证上传产物并回报，**Then** 系统落一条与该 session 关联的 mockup 交付记录，且该 session owner 随后能读到它。
3. **Given** 一个尚无任何 mockup 的 ideation session，**When** 用户打开该 session 的 mockup 区域，**Then** 显示空态（如「暂无设计稿」），不报错、不阻断 session 其余功能。
4. **Given** 渲染所用的 mockup 产物实际不可达（被删 / 加载失败），**When** App 尝试渲染，**Then** 给出一次性降级提示，不崩、不阻断 session。

---

### User Story 2 - 同一 session 多版 mockup 迭代浏览 (Priority: P2)

用户对同一个灵感反复让系统生成 mockup（迭代设计稿）。每一版都独立交付并关联到同一 session。用户在 App 能看到该 session 的多版 mockup（按交付时间 / 版本标识），默认渲染最新版，历史版可见、可切换查看，从而对比迭代前后的设计变化。

**Why this priority**: 迭代是灵感批评循环的自然延伸，但非最小闭环——US1 单版已交付价值。多版让「批评 → 再生成 → 再看」成环，提升而非决定可用性。

**Independent Test**: 在「读列表端点 mock 返同一 session 的 N 条 mockup 记录（不同交付时间）」环境下，打开该 session → 验 App 列出 N 版 + 默认渲染最新 + 可切到历史版渲染。

**Acceptance Scenarios**:

1. **Given** 同一 session 已交付多版 mockup，**When** 用户打开该 session 的 mockup 区域，**Then** App 列出全部版本（含版本 / 交付时间标识），默认渲染最新版。
2. **Given** App 正展示某 session 的多版 mockup 列表，**When** 用户选择一个历史版本，**Then** 该历史版在隔离内嵌视图渲染出来。

---

### Edge Cases

- **上传凭证签发失败**（存储未配置 / 超时）→ 通路得到结构化失败，不产出半截 mockup 记录、可重试；不向用户误示「已交付」。
- **凭证请求越权 scope**（通路试图为非本任务 session / 他账户前缀要凭证）→ 拒绝；凭证 scope 永远由 server 据所认领任务派生、上传方不能自报。
- **直传失败**（签名 / size 被存储拒 / 网络非 2xx）→ 不落 mockup 记录、不脏写既有记录、可重试。
- **落库后产物不可达**（谎报 key / 产物被删）→ App 渲染降级一次性提示；「记录存在」与「渲染成功」二者解耦。
- **跨账户 / 不存在 session** 请求 mockup 列表或上传凭证 → 反枚举字节级一致折叠（与「存在但空」不可区分，沿 [036](../036-ideation-image-annotation/spec.md) FR-013）。
- **同 session 并发多次交付** → 各自独立 mockup 记录，互不覆盖。
- **mockup 含多状态屏** → App 渲染需能浏览单文档内的全部屏（滚动 / 分段）。
- **不可信 HTML 越界尝试**（内嵌脚本访问主上下文凭据 / 任意外链跳转 / 表单外发）→ 渲染隔离阻断。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 系统 MUST 把 headless 通路为某 ideation session 生成的 mockup 持久化交付，并与该 session 关联——一条 mockup 交付记录代表一次交付。
- **FR-002**: 系统 MUST 让上传方以**最小权限、短时效、scope 锁定到「本 session 产物前缀」**的凭证完成产物上传；上传 scope MUST 由 server 据上传方所认领的任务派生，**上传方不得自报** account / session（防越权与混淆代理）。
- **FR-003**: 产物字节 MUST 不经 server 中转（上传方直传对象存储；server 只签发 scoped 凭证 + 落库定位，沿 ADR-0045）。
- **FR-004**: 用户 MUST 能在 App 打开一个 ideation session 后，看到该 session 已交付的 mockup，并在**隔离内嵌视图**渲染浏览其内含的多状态屏。
- **FR-005**: mockup HTML 是不可信内容（LLM 生成）→ App 渲染 MUST 隔离：渲染内容**不能读取 / 影响 App 主上下文**（凭据 / 会话 / 应用 DOM），不能执行越界脚本 / 任意外链跳转 / 外发表单。
- **FR-006**: 同一 session MUST 支持多版 mockup（迭代，**append-only 保留全部历史版本，新交付不覆盖旧**）；App MUST 能列出该 session 的全部 mockup（含版本 / 交付时间标识），默认渲染最新版、历史版可见且**可切换单独渲染**。
- **FR-007**: mockup 产物的访问与列举 MUST 按 account + session 隔离；跨账户 / 不存在 session 的列表或凭证请求 MUST 反枚举字节级一致折叠（与「存在但空」不可区分）。
- **FR-008**: 交付失败（凭证签发 / 直传 / 落库任一失败）MUST 优雅降级——不产出半截记录、不向用户误示已交付、可重试。
- **FR-009**: App 渲染失败（产物不可达 / 加载失败）MUST 优雅降级——一次性提示，不崩、不阻断 session 其余功能；「记录存在」与「渲染成功」解耦。
- **FR-010**: mockup 交付记录 MUST 携带 App 列举与渲染所需的最小元数据（产物定位、**逐屏标签清单（per-screen labels，无文档内锚点）**、版本 / 交付时间）。
- **FR-011**: App MUST 在打开 session 时拉取该 session 当前已交付的 mockup（fetch-on-open）；**不要求 session 打开期间实时刷新**——交付若发生在用户未查看时，下次打开 / 重新进入可见。

### Key Entities _(include if feature involves data)_

- **Mockup 交付记录**：代表一次为某 ideation session 交付的 mockup。关键属性——所属 session、所属 account、产物定位（对象 key）、**逐屏标签清单**（per-screen labels，无文档内锚点；供 App 展示「含哪些状态屏」）、交付时间 / 版本序。关系：从属于一个 **IdeaSession**（[032](../032-ideation-prd-clarify/spec.md)）；一个 session **append-only 多条**（多版迭代，新版不覆盖旧版）。account 归属用于隔离与反枚举。
- **IdeaSession**（既有，[032](../032-ideation-prd-clarify/spec.md)）：mockup 交付记录挂其下；session owner = 唯一可见者。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户打开一个已交付 mockup 的 session 后，能在 3 秒内看到 mockup 渲染出来（产物可达前提下）。
- **SC-002**: agent 生成并交付成功的 mockup，100% 能被该 session owner 在 App 看到（交付 → 可见无丢失）。
- **SC-003**: 非 owner 用户无法看到 / 列举他人 session 的 mockup——跨账户访问与「不存在」响应不可区分（反枚举可验证）。
- **SC-004**: 渲染的不可信 mockup HTML 无法读取或影响 App 主上下文（无凭据泄漏、无越界脚本执行、无任意跳转）——可由安全验证确认。
- **SC-005**: 同一 session 经 N 次生成交付后，App 能完整列出 N 版 mockup（无遗漏、无串档）。
- **SC-006**: 交付或渲染失败时，用户 100% 得到明确一次性提示，且 session 其余功能不受影响（不崩 / 不阻断 / 可重试）。

## Assumptions

- mockup 的 **author 生成**已由 `/mockup-gen-from-brief` 命令 + 子plan3 通路承担（[033](../033-ideation-multimodal-input-shell/spec.md)–[036](../036-ideation-image-annotation/spec.md) ideation 链路）；本 feature 只接「生成完 → 交付 → 渲染」，不涉及生成逻辑。
- **上传执行方** = headless 通路（agent-platform 仓 channel）——其内联 + 直传 + 回报的**实现**改动在 sibling 仓独立 PR，不在本 feature mono scope；本 feature 提供它消费的 server 端点契约。
- **内嵌隔离渲染**依赖一个允许内联展示的**可信展示域**（备案自定义展示域；对象存储默认端点强制下载、不可内联）——其 infra 配置（存储自定义域绑定 + 备案覆盖）是交付前置依赖，本 feature 假定其在渲染上线前可用。
- mockup 产物为**单一自包含文档**（多状态屏内联合并、CSS 内联），App 一次渲染浏览（per 设计 doc §E Q4/Q5）。
- **单租户语义**：session owner = 唯一可见者，无共享 / 协作 mockup 场景；mockup 随 session 生命周期持久（无独立自动过期）。
- 沿用 ideation 既有范式：反枚举（[036](../036-ideation-image-annotation/spec.md) FR-013）、对象存储直传（[ADR-0045](../../docs/adr/0045-object-storage-image-upload.md)）、贫血 Prisma row（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）、bounded context 边界（[ADR-0032](../../docs/adr/0032-backend-bounded-context.md)，mockup 记录归 ideation ctx）。
