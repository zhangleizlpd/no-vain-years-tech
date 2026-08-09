---
feature_id: 029-chat-model-switch
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-14'
---

# Tasks: 029-chat-model-switch（AI 对话模型切换 · DeepSeek 双模式 flash/pro）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `029-chat-model-switch` | **设计源**: [master](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §1 D4/§2.2/§3/§4 + [mockup](./design/)（4 frame）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数/常量派生（`list-models`）= vitest 无 DB；UC 读写 DB + send 路由 = **Testcontainers PG**（`nx test server <file>`，cwd=apps/server）；mobile 纯逻辑（`use-models` 降级 / `setModel` 态）= vitest，UI·render·a11y = Playwright Expo Web e2e
- 无 task-meta JSON（**manual 模式**，per 004-028）
- 🚨 **029 纯增量**（plan D1）：复用 027 已 ship 的 `chat` 叶子 ctx + `LlmProvider`/`deepseek.provider` 接口 + `conversation.model` 列 + `JwtAuthGuard` scope→404 模式 + Orval typed hook 链路 + 顶栏模型名只读占位；复用 028 已 ship 的会话切换链路（`selectConversation` hydrate）。**零 schema 改动 / 零 migration / 零新 dep**（027 `Conversation.model` 列已建；顶栏下拉用既有 RN/`react-native-reanimated`）
- 🚨 **用户身份 = `accountId`**（`req.user.accountId` + `JwtAuthGuard`）；会话级 model 写先 `findFirst({where:{id, accountId}})` scope，他人/不存在 conversationId → **404 字节级一致**（反枚举，复用 027/028 `NotFoundException('CONVERSATION_NOT_FOUND')`）。model 值域非法（非 flash/pro 或不可用）→ **400**（自有资源输入校验，非反枚举路径）
- 🚨 **模型清单 = server 常量派生**（plan D2）：`GET /chat/models` 不建表，返 flash/pro 可用 + MiniMax 留位不可用；客户端内置同款默认作**降级**（端点失败不阻塞，FR-012）
- 🚨 **send-message 最小改 027**（plan D6）：仅改取 model 的**来源**（固定 → 按 `conversation.model`），**不动**流式/落库/标题派生链路；IT 用 **FakeProvider**（027 `fake-llm.provider.ts`）断言收到的 model 随会话变。`LlmProvider` 接口**不改**（已 `stream(messages, model)`）
- **单 PR（per Constitution §V）**：`feat(chat)` —— server 2 端点 + send-message 路由改 + 真 server IT + export-openapi + api-client regen + mobile 顶栏下拉消费 + 两层验证全原子 merge。029 纯增量、无「仓内首例」flag，可接 auto-merge（D3/D5/D6 标注供 reviewer 关注）

## Path Conventions

- server：`apps/server/src/chat/`（**既有扁平 module**，加 UC + controller 路由，无新 module 注册）；**无** schema/migration 改动；IT `apps/server/test/integration/*.it.spec.ts`
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile：`apps/mobile/src/chat/`（**既有 feature dir**，加 `model-switcher.tsx` + `use-models.ts` + 扩展 `use-chat.ts`）+ `chat-home-screen.tsx`（顶栏模型名占位接下拉）；`~/theme`/`~/ui` 零新库（mockup 0 新 token）
- e2e：`apps/mobile/e2e/`（mock models/PATCH model/send 端点 + 003 refresh）；contract-smoke `apps/mobile/e2e/contract-smoke/chat-model-switch.contract.ts`
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**

---

## Phase 1: Server — 模型元数据 + 会话级 model 写 + send 路由（复用 chat ctx，零 schema 改动）

**Goal**：在既有 `chat` ctx 加模型元数据 GET 端点 + 会话级 model PATCH 端点（scope→404 + 值域 400），并让 027 send-message 按 `conversation.model` 路由 flash/pro，spec state_branches server 段全覆盖。

- [X] T001 [US1] [US3] [Server] **模型元数据 UC（常量派生）+ controller 路由**：`apps/server/src/chat/list-models.usecase.ts`（`execute() → {models:[{id,label,description,available}]}`，常量派生：`flash`「快速」available / `pro`「思考」available / `minimax`「MiniMax」「即将上线」available:false；**不建表、无 DB**）+ `conversation.controller.ts` 加 `@Get('models')`（`@UseGuards(JwtAuthGuard)`，认证态无 accountId scope——清单非用户私有）。**验**：vitest 纯逻辑（返 3 项 / flash·pro available 且 minimax 不可用 / id·label·description 字段齐）。⚠️ model id 命名（flash/pro）与 mobile + `deepseek.provider` 映射保持一致（D6）
- [X] T002 [US1] [US2] [Server] **会话级 model 写 UC + controller 路由**：`apps/server/src/chat/set-conversation-model.usecase.ts`（先 `findFirst({where:{id, accountId}})`→404；model ∉ 可用集（flash/pro）→`BadRequestException`（含 minimax 等不可用值）；else `update({where:{id}, data:{model}})` 返 `{id,model,updatedAt}`）+ `conversation.controller.ts` 加 `@Patch('conversations/:id')` model 路径（body DTO `set-conversation-model.request.ts`；plan D3：与 028 rename 同路由按字段分派 **或** 独立子路由，impl 择简，**口径锁定** scope→404 + 值域 400）。**验**：Testcontainers 单测（设 flash/pro 回显 + `@updatedAt` 刷新 / 非法 model→400 / minimax 不可用→400 / 他人 id→404 字节级一致 / 不存在→404 / 未认证→401）。⚠️ 不破坏 028 rename 既有 `PATCH conversations/:id`（title）行为——回归验 rename 仍绿
- [X] T003 [US1] [Server] **send-message 按 `conversation.model` 路由（最小改 027）**：`apps/server/src/chat/send-message.usecase.ts` 改取 model 来源——已落库会话读 `conversation.model`、新会话首发用入参/默认 flash 写入 `conversation.model`（D7）→ 传 `LlmProvider.stream(messages, model)`；`deepseek.provider.ts` 核对/补 model→DeepSeek model id 映射（flash→快速模式 id / pro→思考模式 id，**核对现有配置 + DeepSeek 最新 model 名，不臆造**）。**验**：Testcontainers 单测（会话 model=pro→FakeProvider 收 pro / model=flash→收 flash / 新会话默认 flash 落库 + FakeProvider 收 flash）。🚨 **仅改 model 来源，不动流式/落库/标题派生**（plan D6 scope 控制）；回归验 027 既有 send IT 仍绿
- [X] T004 [US1] [US2] [US3] [Server-IT] **state_branches 全覆盖 IT**：`apps/server/test/integration/chat-model-switch.it.spec.ts`（全 boot + Testcontainers PG + FakeProvider env 注入）覆盖 spec **11 条**中 server 可验的分支（models 清单 flash/pro 可用 + minimax 不可用 / 设 flash·pro 持久化 + 会话级记忆（建 2 会话各设不同 model，分别读回正确）/ 默认 flash（新会话首发落 flash）/ send 按会话 model 路由（FakeProvider 断言）/ 设 model 越权 404 字节级一致 / 非法 model 400 / 未认证 401）。流中切先 abort / 元数据降级 / 下拉 UI = mobile 侧分支（T007/T009）

## Phase 2: 契约同步（Nx-driven）

- [X] T005 [Contract] [Verify] **swagger + openapi + api-client regen**：`conversation.controller` 2 新路由加 `@nestjs/swagger` 装饰器（models response DTO + 分项 model schema + set-model body DTO + response；nullable/optional string 字段显式 `type:'string'` per memory）→ `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen：list-models / set-conversation-model typed hook）→ mobile typecheck 绿。⚠️ 不破坏 028 既有 conversation 端点契约（list/rename/delete）

## Phase 3: Mobile — 顶栏模型下拉 + 会话级 model 记忆（翻 mockup 4 frame）

**Goal**：顶栏模型名占位接下拉 popover，flash/pro 切换 + 当前打勾 + MiniMax 留位，切换写会话级 model + 流中先 abort，切历史会话顶栏跟随。

- [X] T006 [US1] [US3] [Mobile] **模型清单 hook**：`apps/mobile/src/chat/use-models.ts`（接 orval `GET /chat/models` typed hook；**内置默认降级**——端点失败用 `[{id:'flash',...},{id:'pro',...}]` 常量，FR-012；可用项过滤供下拉渲染，minimax 标 disabled）+ vitest 纯逻辑（正常返清单 / 端点失败降级内置默认 / available 过滤）
- [X] T007 [US1] [US2] [Mobile] **use-chat 扩展（setModel + 流中断协同 + 会话级 model 态）**：`apps/mobile/src/chat/use-chat.ts` 增 `setModel(model)`（流进行中先 `handleRef.current?.abort()`（FR-011）→ 设会话级 model 态 → 当前会话已落库则触发 `PATCH conversations/:id` 持久化（D3①）/ 未落库仅内存态（D3②）→ 顶栏即时反映）+ 会话级 model **读**（顶栏显示当前会话 model；切历史会话经 028 `selectConversation` hydrate 一并读 model 设顶栏 FR-007；`newConversation()` 回默认 flash FR-008）+ vitest（setModel 流中先 abort / 已落库切触发 PATCH / 未落库仅内存 / select 后顶栏 model 跟随 / new 回 flash）。🚨 复用 028 既有 `selectConversation`/`newConversation`/`handleRef`——**读现状照接，别臆造**；不动 027 流式发送链路
- [X] T008 [US1] [US2] [US3] [Mobile] **顶栏模型下拉 popover（翻 mockup 4 frame）**：`apps/mobile/src/chat/model-switcher.tsx`（顶栏模型名 tap 开 popover：absolute overlay + 极浅遮罩 tap 关 + 卡片下拉；`use-models` 渲染 flash/pro 行（当前 brand 对勾 ✓ + brand-soft 底）+ MiniMax disabled 留位「即将上线」pill tap 无副作用；选项 tap → `setModel` + 关闭）+ `chat-copy.ts` 增模型文案（选择模型/快速/思考/即将上线/副标题）+ 复用 `~/theme`+`~/ui`（0 新 token）+ `chat-home-screen.tsx` 顶栏模型名占位接 `onPress` 开下拉 + 显示当前会话 model 名。所有可交互元素带 `testID`/a11y label（顶栏模型按钮 / 各 model 行 / 打勾态，tap 驱动 per RNGH web 手势非确定）
- [X] T009 [US1] [US2] [US3] [Mobile-E2E] **hermetic UI e2e**：`apps/mobile/e2e/chat-model-switch.spec.ts`（Playwright Expo Web，mock models/PATCH model/send 端点 + mock get-messages + 003 refresh）验：点顶栏模型名 → 下拉 flash ✓/pro/MiniMax disabled → 选 pro → 顶栏更新「思考」+ 下拉关 → 发消息走 pro（mock 断言请求/回显）→ 切历史会话顶栏 model 跟随（会话 A=pro / B=flash）→ 新建对话顶栏回 flash → MiniMax 点击不可选 → **选当前已选 model → 下拉关、无重复 PATCH 请求（无副作用，state_branch #4）** → 元数据端点失败降级仍可切。注：playwright `testMatch=*.spec.ts`；下拉 tap 驱动（非手势）
- [X] T010 [US1] [US2] [Contract-Smoke] **契约冒烟**：`apps/mobile/e2e/contract-smoke/chat-model-switch.contract.ts`（node 层，生成的 `@nvy/api-client` 打 testcontainers 真 server，FakeProvider env 注入）：登录 → `GET /chat/models` 验清单（flash/pro available + minimax 不可用、字段 id/label/description/available）→ 建会话（027 建会话 + 发首条）→ `PATCH conversations/:id` 设 pro 验回显 + 落库 → 发消息验 FakeProvider 收 pro → 建第 2 会话设 flash → 验两会话各自 model 跟随（会话级记忆）→ 非法 model→400 / 越权→404 → 契约对齐（URL/method/序列化/错误码）；落共享套件 `nx run mobile:contract-smoke`

## Phase 4: 契约冒烟 + 收尾

- [X] T011 [Verify] **PR gate**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + moat/boundaries 0 violation（chat 仍叶子，2 端点 + send 路由无跨 ctx）+ `[Contract-Smoke]` 绿 + spec `status: draft→implemented` + plan `status: drafted→approved` + tasks.md `[X]` 全同步 + PR body 三 checkbox 部署 gate

---

## Dependencies & 执行顺序

```text
T001(models UC) ─┐
T002(set-model UC)├─► T004(state_branches IT) ─► T005(swagger+openapi+regen)
T003(send 路由)  ┘
T005 ─► T006(use-models hook) ─┐
T005 ─► T007(use-chat setModel)├─► T008(顶栏下拉) ─► T009(Mobile-E2E)
                               ┘
T005 ─► T010(Contract-Smoke 真 server)
全部 ─► T011(PR gate)
```

- **MVP（US1 最小闭环）**：T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 —— 点顶栏切 flash/pro + 后续发送按所选模式路由，单这条链已交付「按需切快/慢思考模式」核心价值。
- **US2（会话级记忆）**：T002（持久化）+ T004（IT 验记忆）+ T007（切会话跟随）+ T008（顶栏读 model）+ T009/T010（验证）。
- **US3（元数据驱动）**：T001（models 端点）+ T006（hook + 降级）+ T008（下拉据元数据渲染 + MiniMax 留位）。
- **并行**：T001/T002 互不依赖可并行（同 controller 文件加路由需注意 merge，建议串行落路由）；T003 依赖 027 既有 send-message；T006/T007 在 T005 后可并行（不同文件）。

## 验证矩阵映射（spec → task）

| spec | 覆盖 task |
|---|---|
| FR-001 顶栏接下拉 | T008 |
| FR-002 flash/pro 两项 + 当前打勾 | T001 / T006 / T008 |
| FR-003 选模型持久化 + 顶栏反映 | T002 / T007 / T008 |
| FR-004 后续发送按所选路由 | T003 / T004 / T009 |
| FR-005 模型元数据驱动 + MiniMax 留位 | T001 / T006 / T008 |
| FR-006 provider 接口化 model 路由 | T003 / T004 |
| FR-007 切历史会话恢复 model | T007 / T008 / T009 |
| FR-008 新会话默认 flash | T003 / T007 / T009 |
| FR-009 越权 404 + 认证 | T002 / T004 |
| FR-010 key 留 server | T003（027 既有，029 不下发） |
| FR-011 流中切先 abort | T007 / T009 |
| FR-012 元数据降级 | T006 / T009 |
| SC-001 切换 ≤2 tap | T008 |
| SC-002 后续回复所选模式 | T003 / T004 / T010 |
| SC-003 会话级记忆持久化 | T002 / T004 / T010 |
| SC-004 新会话默认 flash | T003 / T009 |
| SC-005 越权全拒 | T002 / T004 |
| SC-006 元数据降级不阻塞 | T006 / T009 |
| SC-007 流中操作无残留 | T007 / T009 |
| state_branches ×11 | T004（server 段）/ T009（mobile 段）|
