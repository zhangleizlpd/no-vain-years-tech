---
feature_id: 028-chat-history-drawer
spec_ref: ./spec.md
status: approved
created_at: '2026-06-14'
updated_at: '2026-06-14'
adr_refs: ['0024', '0032', '0040', '0043', '0055']
context7_verified: []
---

# Implementation Plan: 028-chat-history-drawer（AI 对话历史会话 + 左侧抽屉）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `028-chat-history-drawer` | **设计源**: [master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §3/§4 + [mockup](./design/)（7 frame baseline）

> 手动模式（不用 orchestrator）→ 本 plan 无 `orchestrator_config` 块（对齐 011-027）。
> 标准 SDD：spec ✅ → clarify ✅（2026-06-14 3Q）→ mockup ✅（Claude Design 7 frame）→ **plan（本）** → tasks → implement。
> **⚠ 头号事实**：028 **不引入任何"第一"**——复用 027 已 ship 的 `chat` 叶子 bounded context + `conversation`/`message` 两表 + `JwtAuthGuard` scope 模式 + Orval typed hook 链路。028 = 在既有 chat ctx 上**加 3 个 JSON CRUD 端点**（列表+搜索 / 改名 / 删除）+ **mobile 左抽屉 UI**（自绘 Reanimated overlay，0 新 dep）。**零 schema 改动 / 零 migration**（027 schema 已含 `title`/`updatedAt`/`@@index([accountId, updatedAt])`）。

## Summary _(mandatory)_

028 = 把 027 留的 hamburger 占位接成左侧历史抽屉：**① server 增 3 个 JSON 端点**（`GET /chat/conversations` 列表+分页+`?q` 标题搜索 / `PATCH /chat/conversations/{id}` 改名 / `DELETE /chat/conversations/{id}` 删除连带消息）全走既有 accountId scope→404 模式 → **② mobile `~/chat` 增抽屉层**：自绘 Reanimated translateX overlay（hamburger tap 开 / backdrop tap + swipe 关）含 新建对话 / 时间分组列表 / 行操作（改名/删除）/ 标题搜索 / 底部用户区→设置 → **③ 扩展 027 `use-chat`**：`selectConversation`（切换会话 hydrate）/ `newConversation`（清空回空态），切换/删当前会话**先 abort 027 进行中的流**（FR-011）。

- **server 段**：`apps/server/src/chat/` 扁平模块**增量** —— `list-conversations.usecase.ts`（cursor 分页 + 可选 `q` ILIKE 标题搜索，scope accountId）+ `rename-conversation.usecase.ts`（scope→404 + 空标题 400）+ `delete-conversation.usecase.ts`（**单事务** `deleteMany(message)` + `delete(conversation)`，无 FK cascade 故手动连带）+ `conversation.controller.ts` 加 3 路由 + DTO/swagger。**`conversation-list.rules.ts`**（无）——分组是客户端职责（见 D5）。`get-messages`（027 既有）复用作切换 hydrate。
- **mobile 段**：`apps/mobile/src/chat/` 增量 —— `chat-drawer.tsx`（Reanimated overlay 容器 + 7 状态翻 mockup）+ `conversation-list.tsx`（分组列表 + 行操作）+ `group-conversations.ts`（时间分组**纯函数**，vitest）+ `use-conversations.ts`（orval list/rename/delete hook + React Query 失效）+ `use-chat.ts` 扩展（`selectConversation`/`newConversation` + reducer `reset` action）+ `chat-copy.ts` 增抽屉文案。`chat-home-screen.tsx` 接 hamburger onPress 开抽屉 + 齿轮 `router.push('/(app)/settings')`。

**新基础设施**：**无**。零新 server dep、零 mobile dep（Reanimated/gesture-handler 027 已在）、零 schema 改动、零 migration。3 个新 JSON 端点走既有 swagger→openapi→orval 链路。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A —— 抽屉用既有 `react-native-reanimated@~4.1.7` + `react-native-gesture-handler@~2.28.0`（`apps/mobile/package.json` 已在，027/历史 feature 用）；**不引** `@react-navigation/drawer`（会重构 expo-router 文件路由，抽屉仅存在于首页 tab，自绘 overlay 更内聚） |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles（无违反，无需 Complexity justify）。

| 原则 | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅ → mockup ✅ → plan（本）→ tasks → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | `group-conversations`（时间分组）纯函数 vitest 红绿；list/rename/delete UC 走 Testcontainers PG IT 覆盖 spec `state_branches` 全 12 条（分组 / 空历史 / 切换 hydrate / 新建不落库 / 改名空拒 / 删除连带 / 删当前回空态 / 搜索命中 / 搜索清空 / 流中切换先中断 / 401 / 越权 404） |
| III. Atomic 30min-2h + 独立 commit | ✅ | 单 PR 内分段 task（见 § Phase 2），30min-2h 拆 |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | **复用 027 `chat` 叶子 ctx**（catalog Q1：直改既有 chat ctx 自己的 `conversation` 表 → 放 chat 自身，非新 ctx）；扁平文件平铺、贫血 Raw Prisma row（无 mapper）、无 repository（UC 直注 `PrismaService`）；不碰他 ctx 表（accountId 来自 JWT）；复用 `account/jwt-auth.guard`（平台 auth 基座，027/portfolio/alert 同款） |
| V. 类型同步链 Nx-driven + 单 PR | ✅ | 跨端单 PR：server 3 端点 impl + 真 server IT + `export-openapi` + api-client regen + mobile 消费 + 两层验证全同 PR。3 端点均 JSON，**全走 orval typed hook**（无 SSE，比 027 更标准） |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（PG via Testcontainers）覆盖 3 个新端点 ≥1 次 —— list（分页+搜索）/ rename（含空标题拒 + 越权 404）/ delete（连带消息删 + 越权 404）。`get-messages` 切换路径 027 已有 IT。
- [x] **Mobile**: golden-path `[Mobile-E2E]` hermetic（Playwright Expo Web）—— 开抽屉→看分组→点会话切换 hydrate→新建对话回空态→改名→删除二次确认→搜索筛选。tap 驱动开关（**非纯手势**，per RNGH web 手势不确定 memory）。
- [x] **Evidence**: impl 期落 IT commit + Mobile-E2E spec（tasks T0xx）；mockup baseline [design/](./design/) 已定 7 状态。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 028 不引入任何新 third-party package（抽屉复用既有 Reanimated/gesture-handler，server 零新 dep）。无 6Q 需填。

**Evidence**: N/A — § Dependencies 表已声明 None。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] feature 为 **mono-native**（chat ctx 是 027 greenfield 建立，无 meta-repo Java 迁入）。
- [x] **Evidence**: N/A — chat 全栈 027 新建，028 纯增量。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

`rg "Open Question|未决|deferred" docs/adr/0055*.md docs/adr/0032*.md` —— ADR-0055（chat ctx + SSE + LlmProvider 三首例，027 落）确立了 chat ctx 范式；028 仅在其上加 CRUD 端点，**不触发新 open question、不引入新范式**，故**无新 ADR**。

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0055 | chat ctx 后续 use case 扩展边界 | accepted-as-is | 028 CRUD 端点落在既有 chat ctx，符合 0055 立的范式，无需新 ADR / amend |
| ADR-0032 | bounded context sunset trigger | accepted-as-is | 028 不建新 ctx（catalog Q1：改既有 chat 表 → 放 chat 自身），无评估触发 |

**Evidence**: N/A — 无 ADR amend / 新 ADR。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: `JwtAuthGuard` / `AccountIdThrottlerGuard` 等 **绝对禁止** `new XxxGuard()` / `jest.mock`。必须 `Test.createTestingModule({imports:[ChatModule]}).compile()` 装真 DI 容器。
- **MANDATORY INTEGRATION**: 越权（404 字节级一致）/ 401 / 删除连带 / 改名空拒等必须在真 DI + Testcontainers PG 中触发，不许隔离 mock。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 全 **12 条**每条必有对应 `it()`（含空历史 / 删当前会话回空态 / 流中切换先中断 / 越权 404 等非 happy-path）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：扁平模块（`apps/server/src/chat/` 文件平铺，**无** domain/application/infrastructure/web 子目录）；贫血数据 = Raw Prisma row（snake_case 由 schema `@map`，027 已建）；**无 repository**（UC 直注 `PrismaService`）；护城河（chat 不碰他 ctx 表，accountId 来自 JWT）。028 新增 UC 严格沿用 027 既有文件的命名/风格。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：**删除连带**用单 tx `prisma.$transaction([deleteMany(message where conversationId), delete(conversation where {id, accountId})])`——027 两表**无声明 FK relation**（accountId/conversationId 是逻辑引用 JWT sub，无跨 schema FK），故 DB 无 `ON DELETE CASCADE`，**必须**应用层单事务手动连带删，否则留孤儿 message（Risk 表第 2 条）。改名 = 单行 `update where {id, accountId}` affected-count（0 → 404）。无状态机竞争（CRUD append/update，非状态转换）。
- **安全**：会话按 `accountId` 归属，UC 层 scope ——所有 3 端点先 `findFirst({where:{id, accountId}})` 校验归属，他人/不存在一律 **404 字节级一致**（反枚举，复用 027 `get-messages.usecase` 同款 `NotFoundException('CONVERSATION_NOT_FOUND')`，与 alert/portfolio 同款）。改名空标题 = 400 BadRequest（自有资源输入校验，非反枚举路径）。搜索 `q` 走 Prisma `contains` + `mode:'insensitive'`（参数化，无 SQL 注入面）。
- **前端（mobile）**：抽屉自绘 Reanimated overlay（复用 `~/theme`+`~/ui`，mockup 0 新 token）；**开关 tap 驱动**（hamburger / backdrop / 关闭按钮）保证 Playwright web 可确定驱动，swipe-to-close 为增强非唯一路径（per RNGH pan web 非确定 memory）；列表/改名/删除走 **orval typed hook**（React Query，函数式非 class）；改名输入非 RHF（单 input + 确定，无复杂表单态，对齐 027 输入条体例）；删除/改名后 **invalidate** conversations query 刷新列表。

### D1：复用 027 `chat` ctx，零 schema 改动（catalog Q1）

> **catalog 决策**：Q1「use case 直改某既有 ctx 核心表 row state?」——**是**（改 `chat.conversation` 自己的 `title` / 删 `conversation`+`message`）→ 放该表所属 ctx = **chat 自身**，**非新 ctx**（ADR-0032 sunset trigger 不触发）。chat 仍是叶子（不 DI 任何业务 ctx，accountId 从 JWT）。
> **零 schema 改动实证**：027 `Conversation` 已含 `title String` / `updatedAt`（`@updatedAt`）/ `@@index([accountId, updatedAt], map:"ix_conversation_account_updated")`——**正是** 028 列表「按 accountId + updatedAt 倒序」的覆盖索引；改名只更 `title`、删除不加列。`Message` 已含 `@@index([conversationId, id])` 供切换 hydrate。**无 migration**。

### D2：3 个新 JSON 端点契约（DESIGN INTENT，swagger SoT）

- **`GET /chat/conversations`**（列表 + 搜索 + 分页）：query `?limit`（默认 20-30）`&cursor`（上一页末 `{updatedAt,id}` 编码）`&q`（可选标题关键词）。返回 `{items: [{id, title, model, updatedAt}], nextCursor?}`。**不**返消息预览（mockup 行仅标题）。`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`，scope accountId。
- **`PATCH /chat/conversations/{id}`**（改名）：body `{title}`。scope→404；空/纯空白 title → 400。返回更新后 `{id, title, updatedAt}`。
- **`DELETE /chat/conversations/{id}`**（删除）：scope→404；单事务连带删 message。返回 204 / `{deleted:true}`。
- 三端点全 JSON → swagger 装饰器（nullable 字段显式 `type:'string'` per memory）→ `export-openapi` → orval typed hook。`get-messages`（027）复用作切换 hydrate，不改。

### D3：删除连带 = 应用层单事务（无 FK cascade）

- `delete-conversation.usecase`：先 `findFirst({where:{id, accountId}})`（404 gate）→ `prisma.$transaction([prisma.message.deleteMany({where:{conversationId:id}}), prisma.conversation.delete({where:{id}})])`。**顺序**：先删 message 再删 conversation（无 FK 约束故顺序不强制，但语义清晰）。IT 验：删后 `get-messages` 该 id → 404 且 message 表无残留行。

### D4：列表分页 + 标题搜索（同端点）

- **分页**：cursor 基于 `(updatedAt desc, id desc)` 复合游标（稳定排序，避免同 updatedAt 跳行）；命中 `ix_conversation_account_updated` 覆盖索引。下滑加载更多——⚠️ **orval `react-query` client 默认只 emit useQuery/useMutation，不 emit useInfinite hook**（F3 实证），故用 raw queryFn **手动 cursor 累加**（不改 orval config）。
- **`updatedAt` 语义**（analyze 决策 a，2026-06-14）：= **最近更新**（创建/首条标题/改名刷新），**不随每条消息刷新**（继承 027 `send-message`，028 不改）。排序/分组据此；改名上浮接受。spec FR-002 + Assumptions 已对齐。
- **搜索**：`q` 非空时 WHERE 追加 `title contains q (insensitive)`；搜索与列表同端点同分页（搜索结果也可分页）。客户端搜索态下列表平铺（mockup frame 5「N 个结果」），非搜索态走时间分组。

### D5：时间分组 = 客户端纯函数（`group-conversations.ts`）

- `groupConversations(items, now): {label, items}[]` —— 按 `updatedAt` 分桶：`前 7 天`（`now - 7d ≤ updatedAt`）/ `前 30 天`（`now - 30d ≤ updatedAt < now - 7d`）/ 更早按年 `YYYY 年`（倒序）。**边界**：临界用 `≥`（含边界归较近组），避免跳组歧义（spec Edge）。纯函数 vitest 红绿（空 / 仅近 7 天 / 跨多组 / 跨年 / 边界恰 7d/30d）。**分组是客户端职责**（server 返 flat sorted list，前端分桶）——分组规则属展示逻辑，且 028 后续若调分组粒度不必动 server。

### D6：mobile 左抽屉 = 自绘 Reanimated overlay（0 新 dep）

- `chat-drawer.tsx`：absolute overlay（`position:absolute, inset:0`），含 backdrop（`rgba(0,0,0,0.4)`，tap 关）+ 面板（宽 82%，`translateX` Reanimated `withTiming` 滑入/滑出）。open state 提升到 `chat-home-screen` 或 context。**开**：hamburger `onPress`；**关**：backdrop tap / 面板内关闭手势（gesture-handler `Pan` swipe-left 为增强）。
- 面板内容翻 mockup 7 frame：顶段（搜索框 + 新建对话）/ 中段（`conversation-list` 分组 or 搜索平铺 / 空历史态 / 搜索无命中态）/ 底段（头像 + 昵称 `useMe()` + 齿轮 `router.push('/(app)/settings')`）。行操作（⋯ → 重命名/删除菜单 / 改名行内编辑 / 删除居中确认弹窗）。
- **可测性**：所有可交互元素带 `testID` / a11y label，开关与行操作 tap 驱动（Playwright web 确定命中）。

### D7：扩展 027 `use-chat`（切换 / 新建 + 流中断协同）

- `use-chat.ts` 增 `selectConversation(id)`：若 027 流进行中先 `handleRef.current?.abort()`（FR-011，等同停止生成）→ 设 `conversationIdRef = id` + `setLastConversationId(id)` → refetch messages → `dispatch({type:'hydrate', messages})` → 关抽屉。
- `newConversation()`：若流进行中先 abort → `conversationIdRef = null` + `setLastConversationId(null)` → `dispatch({type:'reset'})` 回空态。**reducer 增 `reset` action**（清空 messages 回 idle；027 reducer 已有 `hydrate`，加 `reset` 是小增量）。
- `use-conversations.ts`：list（infinite）/ rename / delete 的 orval hook 封装 + mutation 成功后 `queryClient.invalidateQueries(['conversations'])`；删当前会话额外触发 `newConversation()`（FR-008 回空态）。

### D8：设置入口（复用既有 settings stack）

- 抽屉底部齿轮 `onPress = () => router.push('/(app)/settings')` —— 与「我的」profile tab 右上角设置按钮**同一目标**（`apps/mobile/app/(app)/(tabs)/profile.tsx` `pushSettings`，006-account-settings-shell 已建）。028 **不新建设置页**。

### Cross-cutting

- **零回归**：仅在首页 chat 屏加抽屉层 + 扩展 use-chat，不动 027 流式发送/落库链路、不动其余 tab。新端点不被任何既有 ctx import（chat 仍叶子）。
- **边界**：3 端点落既有 `ChatModule`，无新 module 注册；ESLint boundaries 不变（chat 不 import 业务 ctx）。
- **perf SoT** = spec frontmatter `perf_budgets`（列表 p95≤800ms / 搜索 p95≤1000ms）——命中既有覆盖索引，标准 CRUD 余量充足。

## Open Decisions Resolved（⚠️ plan→tasks gate review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** | ctx 落点 / schema | **复用 027 chat ctx，零新 ctx / 零 schema 改动 / 零 migration**（catalog Q1：改既有表 → 放 chat 自身） | ✅ 默认接受 |
| **D2** | 端点契约 | 3 个 JSON 端点（list+search+分页 / rename / delete）全 orval hook，scope→404 | ✅ 默认接受 |
| **D3** | 删除连带 | 应用层**单事务** deleteMany(message)+delete(conversation)（无 FK cascade，手动连带防孤儿） | ⚠️ review（数据一致性） |
| **D4** | 分页 + 搜索 | cursor `(updatedAt,id)` desc 同端点 `?q` ILIKE insensitive | ✅ 默认接受 |
| **D5** | 时间分组 | **客户端纯函数** `groupConversations`（前7天/前30天/年，边界 `≥` 含较近组） | ✅ 默认接受 |
| **D6** | mobile 抽屉 | 自绘 Reanimated overlay（**0 新 dep**），tap 开关 + backdrop，swipe 增强 | ⚠️ review（不引 drawer 库的选型） |
| **D7** | use-chat 扩展 | 加 `selectConversation`/`newConversation` + reducer `reset`；切换/删当前会话先 abort 流（FR-011） | ⚠️ review（跨 027 流式协同） |
| **D8** | 设置入口 | 复用 `router.push('/(app)/settings')`（clarify 定稿） | ✅ 默认接受 |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：(1) 复用 chat ctx 改自有表是 ADR-0032 catalog Q1 正路，非新 ctx。(2) 删除手动单事务连带是「无 FK relation 贫血 schema」的必然（027 体例无跨 schema FK），非过度设计。(3) 自绘抽屉避免引 `@react-navigation/drawer` 重构 expo-router 路由——抽屉仅存于首页 tab，overlay 更内聚（cargo-cult 防火墙）。

## Performance Budget

| 面 | 目标 |
|---|---|
| `GET /chat/conversations`（列表/搜索） | spec `perf_budgets`：列表 p95≤800ms / 搜索 p95≤1000ms（命中 `ix_conversation_account_updated`，标准 CRUD） |
| rename / delete | 标准单行写，无特殊预算 |

_SoT = spec frontmatter `perf_budgets`。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略（单 PR，per Constitution §V）

跨端 feature **单 PR**（`feat(chat)`）：server 3 端点 impl + 真 server IT + `export-openapi` + api-client regen + mobile 抽屉消费 + 两层验证全原子 merge。无「仓内首例」flag（028 纯增量），无需特殊人工 review gate（D3/D6/D7 标注供 reviewer 关注即可），可接 auto-merge。

### 建议 tasks.md 层级（每 task 30min-2h，预估 ~11-13 task）

- **Server ~4-5**：`[Server]` `list-conversations` UC（cursor 分页 + `q` ILIKE，scope）+ controller 路由 + swagger → `[Server]` `rename-conversation` UC（scope→404 + 空拒 400）+ 路由 → `[Server]` `delete-conversation` UC（单事务连带删）+ 路由 → `[Server-IT]` Testcontainers 覆盖 state_branches（list 分页/搜索/空、rename 空拒/越权 404、delete 连带/越权 404、切换 hydrate）。
- **契约同步 ~1**：`[Contract]` swagger 装饰器（3 端点 DTO）→ `export-openapi` → api-client regen → `[Verify]` mobile typecheck 绿。
- **Mobile ~5-6**：`[Mobile]` `group-conversations` 时间分组纯函数（vitest 红绿）→ `[Mobile]` `use-conversations` orval hook（list infinite / rename / delete + invalidate）→ `[Mobile]` `use-chat` 扩展（selectConversation/newConversation + reducer reset，vitest）→ `[Mobile]` `chat-drawer` + `conversation-list` 组件（翻 mockup 7 状态）+ hamburger/齿轮接线 → `[Mobile-E2E]` hermetic（开抽屉→分组→切换→新建→改名→删除确认→搜索）→ `[Contract-Smoke]`（真 server：登录→建 2 会话→list 验分组数据→rename→delete 验连带）。

> 依赖：无外部前置（chat ctx + 两表 027 已 ship）。无新 dep 安装。

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-14 | **ID-namespace**: US1-4 / FR-001..014 / SC-001..008 / state_branches ×12 | **ADR**: 0055（chat ctx 范式，027 立）/ 0032（catalog Q1 复用既有 ctx）/ 0043（扁平贫血纯函数）/ 0040（多层测试门）/ 0024（spec 布局）—— **无新 ADR**（028 纯增量）
