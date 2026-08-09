---
feature_id: 028-chat-history-drawer
spec_ref: ./spec.md
plan_ref: ./plan.md
status: implemented
created_at: '2026-06-14'
---

# Tasks: 028-chat-history-drawer（AI 对话历史会话 + 左侧抽屉）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `028-chat-history-drawer` | **设计源**: [master](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) §3/§4 + [mockup](./design/)（7 frame）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（`group-conversations`）= vitest 无 DB；UC 读写 DB = **Testcontainers PG**（`nx test server <file>`，cwd=apps/server）；mobile 纯逻辑（reducer reset / 分组）= vitest，UI·render·a11y = Playwright Expo Web e2e
- 无 task-meta JSON（**manual 模式**，per 004-027）
- 🚨 **028 纯增量**（plan D1）：复用 027 已 ship 的 `chat` 叶子 ctx + `conversation`/`message` 两表 + `JwtAuthGuard` scope→404 模式 + Orval typed hook 链路。**零 schema 改动 / 零 migration / 零新 dep**（027 `Conversation` 已含 `title`/`updatedAt`/`@@index([accountId, updatedAt])`；抽屉用既有 `react-native-reanimated`+`react-native-gesture-handler`）
- 🚨 **用户身份 = `accountId`**（`req.user.accountId` + `JwtAuthGuard`）；3 端点全先 `findFirst({where:{id, accountId}})` scope，他人/不存在 conversationId → **404 字节级一致**（反枚举，复用 027 `get-messages.usecase` 同款 `NotFoundException('CONVERSATION_NOT_FOUND')`）。改名空标题 → **400**（自有资源输入校验，非反枚举路径）
- 🚨 **删除连带（plan D3）**：027 两表**无 FK relation**（无 `ON DELETE CASCADE`）→ 删除**必须**应用层**单事务** `prisma.$transaction([message.deleteMany({where:{conversationId}}), conversation.delete({where:{id}})])`，否则留孤儿 message
- 🚨 **3 端点全 JSON 走 orval**（无 SSE，比 027 标准）：list/rename/delete 走 orval typed hook；`get-messages`（027 既有）复用作切换 hydrate，不改
- **单 PR（per Constitution §V）**：`feat(chat)` —— server 3 端点 impl + 真 server IT + export-openapi + api-client regen + mobile 抽屉消费 + 两层验证全原子 merge。028 纯增量、无「仓内首例」flag，可接 auto-merge（D3/D6/D7 标注供 reviewer 关注）

## Path Conventions

- server：`apps/server/src/chat/`（**既有扁平 module**，加 UC + controller 路由，无新 module 注册）；**无** schema/migration 改动；IT `apps/server/test/integration/*.it.spec.ts`
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile：`apps/mobile/src/chat/`（**既有 feature dir**，加抽屉组件 + hook）+ `apps/mobile/src/chat/chat-home-screen.tsx`（接 hamburger/齿轮）；`~/theme`/`~/ui` 零新库（mockup 0 新 token）
- e2e：`apps/mobile/e2e/`（mock list/rename/delete 端点 + 003 refresh）；contract-smoke `apps/mobile/e2e/contract-smoke/chat-history.contract.ts`
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**

---

## Phase 1: Server — 历史会话 CRUD 端点（复用 chat ctx，零 schema 改动）

**Goal**：在既有 `chat` ctx 加 list（分页+搜索）/ rename / delete 三 JSON 端点，全走 accountId scope→404，删除单事务连带删 message，spec state_branches 全 12 条覆盖。

- [X] T001 [US1] [Server] **会话列表 UC（分页 + 搜索）+ controller 路由**：`apps/server/src/chat/list-conversations.usecase.ts`（`execute(accountId, {limit, cursor?, q?})` → `prisma.conversation.findMany({where:{accountId, ...(q ? {title:{contains:q, mode:'insensitive'}} : {})}, orderBy:[{updatedAt:'desc'},{id:'desc'}], take:limit+1, ...cursor 解码 (updatedAt,id) 复合游标}` → 切 `nextCursor`；返 `{items:[{id,title,model,updatedAt}], nextCursor?}`，BigInt id 序列化 string）+ `conversation.controller.ts` 加 `@Get('conversations')`（`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`，query DTO `list-conversations.request.ts`）。**验**：Testcontainers 单测（建 N 会话→默认页倒序 / cursor 翻页不重不漏 / `q` 命中 insensitive 子串 / `q` 无命中→[] / 空账号→[] / 仅返本人 accountId）。命中既有 `ix_conversation_account_updated`。⚠️ `updatedAt` = **最近更新**语义（analyze 决策 a，不随每条消息刷新）——**028 只读排序，不改 027 send-message**
- [X] T002 [US3] [Server] **改名 UC + controller 路由**：`apps/server/src/chat/rename-conversation.usecase.ts`（先 `findFirst({where:{id, accountId}})`→404；空/纯空白 title→`BadRequestException`；else `update({where:{id}, data:{title}})` 返 `{id,title,updatedAt}`）+ `conversation.controller.ts` 加 `@Patch('conversations/:id')`（body DTO `rename-conversation.request.ts`）。**验**：Testcontainers 单测（改名回显 / 空 title→400 / 纯空白→400 / 他人 id→404 字节级一致 / 不存在→404 / 未认证→401）
- [X] T003 [US3] [Server] **删除 UC（单事务连带）+ controller 路由**：`apps/server/src/chat/delete-conversation.usecase.ts`（先 `findFirst({where:{id, accountId}})`→404；else `prisma.$transaction([message.deleteMany({where:{conversationId:id}}), conversation.delete({where:{id}})])`）+ `conversation.controller.ts` 加 `@Delete('conversations/:id')`（返 204 或 `{deleted:true}`）。**验**：Testcontainers 单测（删后 conversation 不存在 + **message 表无残留行（防孤儿，plan D3）** / 他人 id→404 / 不存在→404 / 删完 `get-messages` 该 id→404）
- [X] T004 [US1] [US3] [Server-IT] **state_branches 全覆盖 IT**：`apps/server/test/integration/chat-history.it.spec.ts`（全 boot + Testcontainers PG）覆盖 spec **12 条**中 server 可验的分支（列表按 updatedAt 分组数据 / 空历史→[] / 切换取消息 hydrate（复用 get-messages）/ 改名空拒 / 改名越权 404 / 删除连带（message 清空）/ 删除越权 404 / 搜索命中仅标题 / 搜索清空回全量 / 未认证 401 / 越权 404 字节级一致）。新建不落库 / 删当前回空态 / 流中切换中断 = mobile 侧分支（T009/T010）

## Phase 2: 契约同步（Nx-driven）

- [X] T005 [Contract] [Verify] **swagger + openapi + api-client regen**：`conversation.controller` 3 新路由加 `@nestjs/swagger` 装饰器（list query DTO + 分页 response + rename body DTO + delete response；nullable string 字段显式 `type:'string'` per memory）→ `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen：list/rename/delete typed hook）→ mobile typecheck 绿

## Phase 3: Mobile — 左抽屉 + 历史列表（翻 mockup 7 frame）

**Goal**：hamburger 接抽屉，时间分组列表 + 切换 hydrate + 新建对话 + 改名/删除/搜索，底部设置入口，与 027 流式中断协同。

- [X] T006 [US1] [Mobile] **时间分组纯函数**：`apps/mobile/src/chat/group-conversations.ts`（`groupConversations(items, now) → {label, items}[]`：按 `updatedAt` 分桶 前7天(`now-7d ≤ updatedAt`)/前30天(`now-30d ≤ updatedAt < now-7d`)/更早按年 `YYYY 年` 倒序；边界 `≥` 含较近组，plan D5）+ vitest 红绿（空 / 仅近7天 / 跨多组 / 跨年 / 边界恰 7d·30d / 组内倒序）
- [X] T007 [US1] [US3] [Mobile] **会话列表 hook**：`apps/mobile/src/chat/use-conversations.ts`（接 orval list / rename / delete hook；**⚠️ orval 默认不 emit useInfinite（F3）→ 用 raw queryFn 手动 cursor 累加**，不改 orval config；mutation 成功 `queryClient.invalidateQueries(['conversations'])`；搜索 `q` 防抖传参）+ vitest 纯逻辑（cursor 累加拼接 / invalidate 触发 / 搜索态切换）
- [X] T008 [US2] [US1] [Mobile] **use-chat 扩展（切换 / 新建 + 流中断协同）**：`apps/mobile/src/chat/use-chat.ts` 增 `selectConversation(id)`（流进行中先 `handleRef.current?.abort()`（FR-011）→ 设 conversationIdRef+setLastConversationId → refetch messages → `dispatch({type:'hydrate'})`）+ `newConversation()`（先 abort → conversationIdRef=null+setLastConversationId(null) → `dispatch({type:'reset'})`）+ `chat-reducer.ts` 增 `reset` action（清 messages 回 idle）+ vitest（reset 清空回 idle / select 后 hydrate / streaming 态 select 先 abort / new 回空态）
- [X] T009 [US1] [US3] [US4] [Mobile] **左抽屉组件（翻 mockup 7 frame）**：`apps/mobile/src/chat/chat-drawer.tsx`（Reanimated `translateX` overlay + backdrop（tap 关）+ 面板 82%，hamburger tap 开 / backdrop tap + swipe-left 关）+ `conversation-list.tsx`（`groupConversations` 分组渲染 / 搜索态平铺「N 个结果」+ 关键词高亮 / 空历史态 / 搜索无命中态 / 行 ⋯ → 重命名·删除菜单 / 改名行内编辑（空禁用确定）/ 删除居中二次确认弹窗）+ 底部用户区（头像 + 昵称 `useMe()` + 齿轮 `router.push('/(app)/settings')`）+ `chat-copy.ts` 增抽屉文案 + 复用 `~/theme`+`~/ui`（0 新 token）+ `chat-home-screen.tsx` 接 hamburger `onPress` 开抽屉。所有可交互元素带 `testID`/a11y label（tap 驱动，per RNGH web 手势非确定）
- [X] T010 [US1] [US2] [US3] [US4] [Mobile-E2E] **hermetic UI e2e**：`apps/mobile/e2e/chat-history.spec.ts`（Playwright Expo Web，mock list/rename/delete 端点 + mock get-messages + 003 refresh）验：开抽屉 → 时间分组列表 → 点会话切换 hydrate + 关抽屉 → 新建对话回空态 → 改名（空禁用确定 + 提交反映）→ 删除二次确认 + 列表移除 → 删当前会话回空态 → 搜索筛选命中 + 清空回全量 + 无命中空态 → 齿轮跳设置。注：playwright `testMatch=*.spec.ts`；开关 tap 驱动（非纯 pan 手势）

## Phase 4: 契约冒烟 + 收尾

- [X] T011 [US1] [US3] [Contract-Smoke] **契约冒烟**：`apps/mobile/e2e/contract-smoke/chat-history.contract.ts`（node 层，生成的 `@nvy/api-client` 打 testcontainers 真 server，FakeProvider env 注入）：登录 → 建 2 会话（复用 027 建会话 + 发消息落库）→ `GET /chat/conversations` 验列表（2 条、字段 id/title/model/updatedAt、倒序）→ `q` 搜索验标题命中 → `PATCH` 改名验回显 → `DELETE` 验连带（删后 list 少 1 + `get-messages` 404）→ 契约对齐（URL/method/序列化/错误码）；落共享套件 `nx run mobile:contract-smoke`
- [X] T012 [Verify] **PR gate**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + moat/boundaries 0 violation（chat 仍叶子，3 端点无跨 ctx）+ `[Contract-Smoke]` 绿 + spec `status: implementing→implemented` + plan `status: drafted→approved` + tasks.md `[X]` 全同步 + PR body 三 checkbox 部署 gate

---

## Dependencies & 执行顺序

```text
T001(list UC) ─┐
T002(rename UC)├─► T004(state_branches IT) ─► T005(swagger+openapi+regen)
T003(delete UC)┘
T005 ─► T007(use-conversations hook) ─┐
T006(分组纯函数,无依赖,可并行起手)────├─► T009(抽屉组件) ─► T010(Mobile-E2E)
T008(use-chat 扩展,依赖 027 既有)─────┘
T005 ─► T011(Contract-Smoke 真 server)
全部 ─► T012(PR gate)
```

- **MVP（US1 最小闭环）**：T001 → T004 → T005 → T006 → T007 → T009 —— 开抽屉看历史分组 + 切换会话恢复消息，单这条链已交付「找回过去对话并继续」核心价值。
- **US2（新建对话）**：T008（newConversation + reducer reset）+ T009（抽屉「新建对话」入口）。
- **US3（改名/删除）**：T002 + T003（server）+ T007（mutation hook）+ T009（行操作 UI）+ T004/T010（验证）。
- **US4（标题搜索）**：T001（`q` 参数）+ T007（搜索态）+ T009（搜索框 + 命中/无命中）。
- **并行**：T001/T002/T003 三 UC 互不依赖可并行（同 controller 文件加路由需注意 merge，建议串行落路由或分文件）；mobile T006（分组纯函数）与 server 段可并行起手。

## 验证矩阵映射（spec → task）

| spec | 覆盖 task |
|---|---|
| FR-001 hamburger 接抽屉 | T009 |
| FR-002 时间分组列表 | T001 / T006 / T009 |
| FR-003 仅本人归属 | T001 / T004 |
| FR-004 切换 hydrate | T008 / T009 / T010 |
| FR-005 新建对话不落库 | T008 / T009 |
| FR-006 改名空拒 | T002 / T009 / T010 |
| FR-007 删除连带物理删 | T003 / T004 / T011 |
| FR-008 删当前回空态 | T008 / T010 |
| FR-009 标题搜索 | T001 / T007 / T009 |
| FR-010 底部头像昵称齿轮 | T009 |
| FR-011 流中切换先中断 | T008 / T010 |
| FR-012 认证 401 | T004 |
| FR-013 分页 | T001 / T007 |
| FR-014 模型名只读 | （027 既有，028 不动） |
| SC-001 列表 p95≤800ms | T001（命中索引） |
| SC-002 切换消息完整 | T008 / T010 / T011 |
| SC-003 分组正确 | T006 |
| SC-004 改名持久化 | T002 / T011 |
| SC-005 删除二次确认 | T009 / T010 |
| SC-006 搜索命中准确 | T001 / T010 |
| SC-007 越权全拒 | T002 / T003 / T004 |
| SC-008 流中操作无残留 | T008 / T010 |
| state_branches ×12 | T004（server 段）/ T010（mobile 段）|
