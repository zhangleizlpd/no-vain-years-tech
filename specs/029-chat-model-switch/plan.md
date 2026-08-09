---
feature_id: 029-chat-model-switch
spec_ref: ./spec.md
status: approved
created_at: '2026-06-14'
updated_at: '2026-06-14'
adr_refs: ['0024', '0032', '0039', '0040', '0043', '0055']
context7_verified: []
---

# Implementation Plan: 029-chat-model-switch（AI 对话模型切换 · DeepSeek 双模式 flash/pro）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `029-chat-model-switch` | **设计源**: [master plan](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §1 D4 / §2.2 / §3 / §4 + [mockup](./design/)（4 frame baseline）

> 手动模式（不用 orchestrator）→ 本 plan 无 `orchestrator_config` 块（对齐 011-028）。
> 标准 SDD：spec ✅ → clarify ✅（2026-06-14 4Q）→ mockup ✅（Claude Design 4 frame）→ **plan（本）** → tasks → implement。
> **⚠ 头号事实**：029 **不引入任何"第一"**——复用 027 已 ship 的 `chat` 叶子 ctx + `LlmProvider` 接口化适配器 + `conversation.model` 列 + Orval typed hook 链路 + 顶栏模型名只读占位；复用 028 已 ship 的会话切换链路（`selectConversation` hydrate）。029 = 在既有 chat ctx 加 **1 个模型元数据 GET 端点 + 1 个会话模型 PATCH 端点** + 让 027 `send-message` **按 `conversation.model` 路由** flash/pro + **mobile 顶栏自绘下拉 popover**（0 新 dep）。**零 schema 改动 / 零 migration**（027 `Conversation.model` 列已建）。

## Summary _(mandatory)_

029 = 把 027 留的顶栏模型名只读占位接成可切换的 DeepSeek 双模式选择器：**① server**：`GET /chat/models`（模型元数据，常量派生不建表，返 flash/pro 可用 + MiniMax 留位不可用）+ `PATCH /chat/conversations/{id}` 扩展接受 `model`（会话级模型记忆，scope accountId→404，复用 028 rename 套路）+ 让 027 `send-message.usecase` **按 `conversation.model` 路由** `LlmProvider.stream(messages, model)`（最小改，flash→快速模式 / pro→思考模式 model id）→ **② mobile**：顶栏自绘 Reanimated/纯 RN popover 下拉（tap 开 / 遮罩 tap 关，复用 `~/ui`+`~/theme` 0 新 token）含 flash/pro 两档 + 当前打勾 + MiniMax disabled 留位 → **③ 扩展 027/028 `use-chat`**：`setModel(model)`（切换先 abort 027 进行中流 per FR-011 → PATCH 持久化 → 下条发送沿用）+ 会话级 model 记忆（顶栏读 `conversation.model` 显示，切历史会话经 028 `selectConversation` 跟随）。

- **server 段**：`apps/server/src/chat/` 扁平模块**增量** —— `list-models.usecase.ts`（常量派生模型清单，无 DB）+ controller `@Get('models')` · `set-conversation-model.usecase.ts`（scope→404 + model 值域校验 + `update({data:{model}})`）+ controller `@Patch('conversations/:id')` 扩展（或独立 `models` 子路由，见 D3）· `send-message.usecase.ts` **最小改**：发送时读 `conversation.model` 传给 `LlmProvider.stream`（D6）。`LlmProvider` 接口不动（已 `stream(messages, model)`，027 立）。
- **mobile 段**：`apps/mobile/src/chat/` 增量 —— `model-switcher.tsx`（顶栏 popover 下拉，翻 mockup 4 frame）+ `use-models.ts`（orval `GET /chat/models` typed hook + 内置默认降级）+ `use-chat.ts` 扩展（`setModel` + abort 协同 + 会话级 model 态）+ `chat-copy.ts` 增模型文案。`chat-home-screen.tsx` 顶栏模型名占位 → 接 `model-switcher` onPress 开下拉。

**新基础设施**：**无**。零新 server dep、零 mobile dep、零 schema 改动、零 migration。新 JSON 端点走既有 swagger→openapi→orval 链路。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A —— 顶栏下拉 popover 用既有 RN + `react-native-reanimated@~4.1.7`（027/028 已在，可选用于淡入；纯 `Modal`/absolute overlay 亦可，impl 择简）；DeepSeek flash/pro 复用 027 `deepseek.provider.ts` + `LlmProvider` 接口，**不引** 新 SDK / 新 provider 包（MiniMax 降二期，仅元数据留位） |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles（无违反，无需 Complexity justify）。

| 原则 | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅ → mockup ✅ → plan（本）→ tasks → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | `list-models`（常量派生）= vitest 无 DB；`set-conversation-model` 读写 DB + `send-message` 路由 = Testcontainers PG IT 覆盖 spec `state_branches` 全 11 条（切 flash/pro / 会话级记忆恢复 / 默认 flash / 越权 404 / 元数据降级 / 流中切先 abort / MiniMax 不可选 等）；mobile 纯逻辑（model 态切换 / 降级）= vitest，下拉 UI = Playwright Expo Web e2e |
| III. Atomic 30min-2h + 独立 commit | ✅ | 单 PR 内分段 task（见 § Phase 2），30min-2h 拆 |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | **复用 027 `chat` 叶子 ctx**（catalog Q1：直改既有 chat ctx 自己的 `conversation.model` row state → 放 chat 自身，非新 ctx）；扁平文件平铺、贫血 Raw Prisma row（无 mapper）、无 repository（UC 直注 `PrismaService`）；不碰他 ctx 表（accountId 来自 JWT）；复用 `account/jwt-auth.guard` + 027 `LlmProvider`/`deepseek.provider`（chat 自身 infra，非跨业务 ctx） |
| V. 类型同步链 Nx-driven + 单 PR | ✅ | 跨端单 PR：server 2 端点 + send-message 路由改 + 真 server IT + `export-openapi` + api-client regen + mobile 消费 + 两层验证全同 PR。2 新端点均 JSON，**全走 orval typed hook**（无 SSE 新增；027 既有 SSE send 不改契约，仅内部路由按 model） |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（PG via Testcontainers）覆盖 2 个新端点 + send-message 路由 ≥1 次 —— `GET /chat/models`（返 flash/pro 可用 + MiniMax 不可用）/ `PATCH conversations/:id` 设 model（含值域校验 + 越权 404）/ `send-message` 按 `conversation.model` 路由（FakeProvider 断言收到的 model 参数随会话变）。
- [x] **Mobile**: golden-path `[Mobile-E2E]` hermetic（Playwright Expo Web）—— 点顶栏模型名→下拉 flash/pro+打勾→选 pro→顶栏更新→（mock）发消息走 pro→切历史会话顶栏跟随→MiniMax 不可选。tap 驱动下拉（**非手势**，per RNGH web 手势不确定 memory）。
- [x] **Evidence**: impl 期落 IT commit + Mobile-E2E spec（tasks T0xx）；mockup baseline [design/](./design/) 已定 4 状态。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 029 不引入任何新 third-party package（DeepSeek provider + `LlmProvider` 接口 027 已立，flash/pro 仅是同一 provider 的 model 参数；下拉用既有 RN/Reanimated）。无 6Q 需填。

**Evidence**: N/A — § Dependencies 表已声明 None。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] feature 为 **mono-native**（chat ctx 是 027 greenfield 建立，无 meta-repo Java 迁入）。
- [x] **Evidence**: N/A — chat 全栈 027 新建，028/029 纯增量。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

`rg "Open Question|未决|deferred" docs/adr/0055*.md docs/adr/0032*.md` —— ADR-0055（chat ctx + SSE + LlmProvider 三首例，027 落）确立了 chat ctx + provider 接口化范式；029 仅在其上加模型路由 + CRUD 端点，**复用 0055 立的 `LlmProvider` 接口扩展点**（多 model / 二期多 provider 正是 0055 预留），**不触发新 open question、不引入新范式**，故**无新 ADR**。

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0055 | chat ctx provider 接口化 / 多 model 扩展边界 | accepted-as-is | 029 flash/pro 经 `LlmProvider` model 参数路由，符合 0055 立的接口化范式（二期多 provider 零调用方改），无需新 ADR / amend |
| ADR-0032 | bounded context sunset trigger | accepted-as-is | 029 不建新 ctx（catalog Q1：改既有 chat `conversation.model` → 放 chat 自身），无评估触发 |

**Evidence**: N/A — 无 ADR amend / 新 ADR。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: `JwtAuthGuard` / `AccountIdThrottlerGuard` / `LlmProvider` DI **绝对禁止** `new XxxGuard()` / `jest.mock`。必须 `Test.createTestingModule({imports:[ChatModule]}).compile()` 装真 DI 容器；provider 走既有 **FakeProvider**（027 立 `fake-llm.provider.ts`）env 注入，断言其收到的 model 参数。
- **MANDATORY INTEGRATION**: 越权（404 字节级一致）/ 401 / 会话级 model 持久化 / send-message 按 model 路由 等必须在真 DI + Testcontainers PG 中触发，不许隔离 mock。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 全 **11 条**每条必有对应 `it()`（含切 flash/pro / 会话级记忆恢复 / 默认 flash / 流中切先 abort / 元数据降级 / MiniMax 不可选 / 越权 404 等非 happy-path）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：扁平模块（`apps/server/src/chat/` 文件平铺，**无** domain/application/infrastructure/web 子目录）；贫血数据 = Raw Prisma row（snake_case 由 schema `@map`，027 已建）；**无 repository**（UC 直注 `PrismaService`）；护城河（chat 不碰他 ctx 表，accountId 来自 JWT；`LlmProvider`/`deepseek.provider` 是 chat 自身 infra）。029 新增 UC 严格沿用 027/028 既有文件的命名/风格。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：会话级 model 写 = 单行 `update where {id, accountId}` affected-count（0 → 404），无多表事务、无状态机竞争。`send-message` 路由按发送时读到的 `conversation.model`（读后即用，无并发改 model 与发送的强一致需求——切 model 已先 abort 进行中流 per FR-011）。
- **安全**：模型元数据 `GET /chat/models` 仅返公开模型清单（无 accountId scope，无敏感数据，但仍走 `JwtAuthGuard` 认证态）；`PATCH conversations/:id` 设 model 先 `findFirst({where:{id, accountId}})`→404 字节级一致（反枚举，复用 027/028 `NotFoundException('CONVERSATION_NOT_FOUND')`）。**model 值域校验**：PATCH 传入的 model 必须 ∈ 可用模型集（flash/pro），非法值 → 400（自有资源输入校验，非反枚举路径）；MiniMax 等不可用 model 也拒（400）。provider key 走 server env，**禁下发客户端**（FR-010，027 既有）。
- **前端（mobile）**：顶栏下拉自绘 popover（复用 `~/theme`+`~/ui`，mockup 0 新 token）；**tap 驱动开关**（顶栏模型名 tap 开 / 遮罩 tap 关）保证 Playwright web 可确定驱动（per RNGH 手势 web 非确定 memory）；模型清单 + 设置走 **orval typed hook**（React Query，函数式非 class）；切 model 后 **会话级态**更新 + 顶栏即时反映；切历史会话经 028 `selectConversation` 读 `conversation.model` 跟随。

### D1：复用 027 `chat` ctx + `LlmProvider` 接口，零 schema 改动（catalog Q1）

> **catalog 决策**：Q1「use case 直改某既有 ctx 核心表 row state?」——**是**（改 `chat.conversation` 自己的 `model` 字段）→ 放该表所属 ctx = **chat 自身**，**非新 ctx**（ADR-0032 sunset trigger 不触发）。chat 仍是叶子（不 DI 任何业务 ctx，accountId 从 JWT；`LlmProvider`/`deepseek.provider` 是 chat 自身 infra）。
> **零 schema 改动实证**：027 `Conversation` 已含 `model String` 列（创建时写默认值）——029 只**改其值**（切换写）+ **读其值**（顶栏显示 / send 路由），不加列。**无 migration**。

### D2：模型元数据端点 `GET /chat/models`（常量派生，不建表）

- 返回 `{models: [{id, label, description, available}]}` —— 一期硬编码常量派生：`{id:'flash', label:'快速', description:'响应迅速，适合日常问答', available:true}` / `{id:'pro', label:'思考', description:'深度推理，适合复杂问题', available:true}` / `{id:'minimax', label:'MiniMax', description:'敬请期待，即将上线', available:false}`。`@UseGuards(JwtAuthGuard)`（认证态，无 accountId scope——清单非用户私有数据）。
- **为何端点而非客户端常量**（clarify 定稿）：二期接 MiniMax / 多 provider 仅改服务端常量/配置，客户端零改动（跨契约 §2.2 解耦）；客户端内置同款默认作**降级**（FR-012，端点不可用时不阻塞）。一期单 provider 双模式，清单由 server 常量派生，**不建表**（避免过度设计——若二期 model 需 DB 配置再演进）。

### D3：会话级 model 写 `PATCH /chat/conversations/{id}`（扩展，复用 028 scope→404）

- **路由选型**：扩展 028 既有 `PATCH /chat/conversations/{id}`（会话部分更新）接受可选 `model` 字段——RESTful partial update，避免新增 `:id/model` 子资源端点。但 028 `rename-conversation.usecase` 专做 title（空标题 400）。**决策**：新增**独立** `set-conversation-model.usecase.ts`（与 rename 同 controller `PATCH conversations/:id`，按 body 字段分派：含 `title` 走 rename、含 `model` 走 set-model；或拆 DTO 联合）——保持 UC 单一职责（028 体例：一 UC 一意图）。impl 时择简：若 controller 分派过绕，回退为独立子路由 `PATCH conversations/:id`（model 专用 DTO）。**口径锁定**：scope→404 字节级一致 + model ∈ {flash,pro} 值域校验（非法/不可用 → 400）+ `update({where:{id}, data:{model}}）` 返 `{id, model, updatedAt}`。
- **会话级记忆持久化时序**：① **已落库会话**切 model → 立即 PATCH 持久化（SC-003：切走再切回 / 重进 App 保留）；② **未发首条的新会话**（未落库，FR-008）→ model 内存态，首条消息 `send-message` 落库建会话时随 `conversation.model` 持久化（无空会话占位）。
- ⚠️ **改名 vs 设 model 共用 `updatedAt` 上浮**：设 model 会刷新 `@updatedAt`（与 028 改名同），导致会话在 028 历史列表上浮——**接受**（切 model 是一次会话更新，语义合理；与 028 `updatedAt`=最近更新一致）。

### D4：mobile 顶栏下拉 = 自绘 popover（0 新 dep）

- `model-switcher.tsx`：顶栏中部模型名（占位 027 已在）→ tap 开 popover（absolute overlay + 极浅遮罩 tap 关 + 卡片下拉，翻 mockup frame 1）。**开**：模型名 `onPress`；**关**：遮罩 tap / 选项 tap。popover 内 `use-models` 拉清单渲染 flash/pro（当前打勾 brand 对勾 + brand-soft 底）+ MiniMax disabled 留位「即将上线」pill（tap 无副作用）。
- **可测性**：所有可交互元素带 `testID` / a11y label（顶栏模型按钮 / 各 model 行 / 当前打勾态），开关 tap 驱动（Playwright web 确定命中）。
- 顶栏组件演进：模型名占位 027 立 → 028 不动 → 029 接 `onPress` + 下拉（同一顶栏，不新建）。

### D5：扩展 027/028 `use-chat`（setModel + 流中断协同 + 会话级态）

- `use-chat.ts` 增 `setModel(model)`：若 027 流进行中先 `handleRef.current?.abort()`（FR-011，等同停止生成）→ 设会话级 model 态（`currentModelRef` / state）→ 若当前会话已落库则触发 `PATCH conversations/:id` 持久化（D3①）；若未落库则仅内存态（D3②）→ 顶栏即时反映。
- 会话级 model **读**：顶栏显示当前会话 `conversation.model`；切历史会话经 028 `selectConversation(id)` hydrate 时一并读 model 设顶栏（FR-007）；`newConversation()`（028 立）回空态时 model 回默认 flash（FR-008）。
- `use-models.ts`：`GET /chat/models` 的 orval hook 封装 + 内置默认降级（端点失败用 `[flash, pro]` 常量，FR-012）。

### D6：`send-message` 按 `conversation.model` 路由（最小改 027）

- 027 `send-message.usecase` 当前以固定/默认 model 调 `LlmProvider.stream(messages, model)`。029 **最小改**：发送时读该会话 `conversation.model`（已落库会话）或入参 model（新会话首发，随建会话写入 `conversation.model`）→ 传给 `LlmProvider.stream(messages, model)`。`LlmProvider` 接口**不改**（027 已 `stream(messages, model)`）。`deepseek.provider` 内 model→DeepSeek model id 映射（flash→快速模式 id / pro→思考模式 id，**impl 时核对 027 `deepseek.provider.ts` 现有 model id 配置 + DeepSeek 最新 model 名**，如 `deepseek-chat`/`deepseek-reasoner`，写 Research 注记不臆造）。
- ⚠️ **溢出 027 scope 风险控制**：029 仅改 `send-message` 取 model 的**来源**（固定 → 按会话），不改流式/落库/标题派生链路；IT 断言 FakeProvider 收到的 model 随会话 model 变。

### D7：默认模型 flash（clarify 定稿）

- 新建会话默认 `model='flash'`（创建时写入 `conversation.model`，复用 027 首发建会话路径；027 现有默认值 impl 时核对，若非 flash 则在 029 send-message 新会话路径设 flash 默认）。顶栏新会话空态显示「DeepSeek 快速」。

### Cross-cutting

- **零回归**：仅在顶栏加下拉层 + 扩展 use-chat + send-message 取 model 来源改；不动 027 SSE 流式传输/落库/标题派生本身、不动 028 抽屉/列表、不动其余 tab。新端点不被任何既有业务 ctx import（chat 仍叶子）。
- **边界**：2 端点 + send-message 改落既有 `ChatModule`，无新 module 注册；ESLint boundaries 不变（chat 不 import 业务 ctx）。
- **perf SoT** = spec frontmatter `perf_budgets`（模型元数据 p95≤500ms / 模型记忆写 p95≤800ms）——常量派生 + 单行写，余量充足。
- **AI 合规**：内容标识 UI 027 已留（master §2.6）；029 不改，继承 027 上线 gate。

## Open Decisions Resolved（⚠️ plan→tasks gate review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** | ctx 落点 / schema | **复用 027 chat ctx + LlmProvider 接口，零新 ctx / 零 schema 改动 / 零 migration**（catalog Q1：改既有 `conversation.model`） | ✅ 默认接受 |
| **D2** | 模型清单来源 | **server `GET /chat/models` 常量派生不建表**（clarify 定稿；二期多 provider 零客户端改 + 客户端内置降级） | ✅ clarify 定稿 |
| **D3** | 会话级 model 写 | `PATCH conversations/:id` 设 model（独立 set-model UC，scope→404 + 值域 400）；已落库即时持久化 / 未落库内存态首发落库 | ⚠️ review（与 028 rename 共路由分派 + updatedAt 上浮） |
| **D4** | mobile 下拉 | 自绘 popover（**0 新 dep**），tap 开关 + 遮罩 | ✅ 默认接受 |
| **D5** | use-chat 扩展 | `setModel` + 流中先 abort（FR-011）+ 会话级 model 态；切历史会话经 028 selectConversation 跟随 | ⚠️ review（跨 027 流式 + 028 切换协同） |
| **D6** | send-message 路由 | 按 `conversation.model` 路由 `LlmProvider.stream`（最小改 027，接口不动） | ⚠️ review（改 027 既有发送链路取 model 来源） |
| **D7** | 默认模型 | flash（clarify 定稿） | ✅ clarify 定稿 |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：(1) 复用 chat ctx 改自有 `conversation.model` 是 ADR-0032 catalog Q1 正路，非新 ctx。(2) 模型元数据端点（非客户端常量）是「二期多 provider 零客户端改动」解耦的必要，非过度设计（一期不建表，常量派生）。(3) 自绘顶栏 popover 避免引下拉库——下拉仅存于首页顶栏，overlay 更内聚（cargo-cult 防火墙）。

## Performance Budget

| 面 | 目标 |
|---|---|
| `GET /chat/models`（模型元数据） | spec `perf_budgets`：p95≤500ms（常量派生，无 DB） |
| `PATCH conversations/:id`（会话级 model 写） | spec `perf_budgets`：p95≤800ms（单行 update） |
| `send-message` 路由 | 不新增预算（027 既有 SSE 流式预算不变，仅内部按 model 选 DeepSeek 模式） |

_SoT = spec frontmatter `perf_budgets`。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略（单 PR，per Constitution §V）

跨端 feature **单 PR**（`feat(chat)`）：server 2 端点 + send-message 路由改 + 真 server IT + `export-openapi` + api-client regen + mobile 顶栏下拉消费 + 两层验证全原子 merge。无「仓内首例」flag（029 纯增量），无需特殊人工 review gate（D3/D5/D6 标注供 reviewer 关注即可），可接 auto-merge。

### 建议 tasks.md 层级（每 task 30min-2h，预估 ~9-11 task）

- **Server ~4**：`[Server]` `list-models` UC（常量派生）+ controller `@Get('models')` + swagger → `[Server]` `set-conversation-model` UC（scope→404 + model 值域 400）+ `PATCH conversations/:id` 路由/分派 → `[Server]` `send-message` 按 `conversation.model` 路由 + `deepseek.provider` model id 映射核对（最小改 027）→ `[Server-IT]` Testcontainers 覆盖 state_branches（models 清单 / 设 model 越权 404 / 值域 400 / send 按会话 model 路由 FakeProvider 断言 / 默认 flash）。
- **契约同步 ~1**：`[Contract]` swagger 装饰器（2 端点 DTO，nullable 显式 `type:'string'`）→ `export-openapi` → api-client regen → `[Verify]` mobile typecheck 绿。
- **Mobile ~4-5**：`[Mobile]` `use-models` orval hook（清单 + 内置默认降级，vitest）→ `[Mobile]` `use-chat` 扩展（`setModel` + abort 协同 + 会话级 model 态 + 切历史会话跟随，vitest）→ `[Mobile]` `model-switcher` 顶栏下拉 popover（翻 mockup 4 frame）+ 顶栏接线 → `[Mobile-E2E]` hermetic（点模型名→下拉→选 pro→顶栏更新→发消息走 pro→切会话跟随→MiniMax 不可选）→ `[Contract-Smoke]`（真 server：登录→建会话→`GET models`→`PATCH` 设 pro→发消息验 FakeProvider 收 pro→切会话验 model 跟随）。

> 依赖：无外部前置（chat ctx + provider 接口 + `conversation.model` 列 027 已 ship；会话切换 028 已 ship）。无新 dep 安装。

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-14 | **ID-namespace**: US1-3 / FR-001..012 / SC-001..007 / state_branches ×11 | **ADR**: 0055（chat ctx + provider 接口化范式，027 立）/ 0032（catalog Q1 复用既有 ctx）/ 0043（扁平贫血纯函数）/ 0040（多层测试门）/ 0039（perf SSOT）/ 0024（spec 布局）—— **无新 ADR**（029 纯增量）
