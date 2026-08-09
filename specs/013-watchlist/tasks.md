---
feature_id: 013-watchlist
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-03'
---

# Tasks: 013-watchlist（自选列表 — 分组 Tab + 长按菜单 + 分组管理）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `013-watchlist`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Foundational / Contract / Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`（per sdd.md）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；UC 读写 DB 的单测走 **Testcontainers PG**（run via `nx test server <file>`，cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（rules）= vitest 无 DB；**每 US 的 Independent Test = `[Server-IT]` 全 boot task**；mobile 纯逻辑（乐观更新/错误分流/涨跌色）= vitest helper-level，UI·render·a11y = Playwright Expo Web e2e（per mono 测试分层 logic=vitest·UI=Playwright）
- 无 task-meta JSON（**manual 模式**，per 004-012）
- **portfolio = 既有第 4 bounded context（01 已 bootstrap）**：本特性**续写**（module 目录 / Prisma `portfolio` schema / ESLint 单向边界 / `BUSINESS_CTX` 均已落，**不重立**）；仅 moat `MODEL_OWNERSHIP` 加 2 新表 owner。**零跨 ctx 业务调用**（intra only，无 R2/R3 → 无 `// CROSS-CONTEXT-*` 注释）；唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（经 `AccountModule` export，account-bound 鉴权 artefact，非 use case 调用，无注释要求）
- 🚨 **ADR-0048 头号不变性**：**013 server 段 NEVER DI marketdata**；行情/搜索由 **mobile client 直调 015 `/quote`·`/search` client-side merge**（013 server 与 015 运行时零跨 ctx）。`[Verify]` 须验 portfolio 零 `prisma.<marketdataTable>.*` + 零 marketdata UC 注入
- **排序/可见性并发 = last-write-wins（D1，user 定）**：order/visible 持久化末次覆盖；**无** 011 式 FOR UPDATE 串行化（013 无跨行强不变性）；改组/固顶 order 重排持 tx 但不锁
- **两段式 PR（user 定）**：**PR1 = Server**（T001–T012，ships 真后端 + **api-client regen committed**）→ **PR2 = Mobile**（T013–T020，消费 PR1 已 merge 的 typed client + 两层验证 per sdd.md §V）。**Constitution §V「同 PR」刻意例外**：regen 在 PR1 committed/merged，mobile PR2 消费已落地 typed client（沿 005/011 先例）；**PR1 描述须 cite 此 §V 例外**

## Path Conventions

- server：`apps/server/src/portfolio/`（**既有 module 续写**，ADR-0043 扁平文件平铺，无 domain/application/infra 层）；schema `apps/server/prisma/schema.prisma`；migration `apps/server/prisma/migrations/{YYYYMMDD}_{HHMM}_add_portfolio_watchlist/`（expand-only + `migration_refs` frontmatter，ADR-0035）；IT `apps/server/test/integration/*.it.spec.ts`（**run via `nx test server <file>`，cwd=apps/server**）
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js` 非 dump-openapi.mjs，per memory `openapi_export_must_use_canonical_mainjs`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile app-local：`apps/mobile/src/portfolio/`（**既有 feature 目录续写**，per [fe-directory-structure](../../docs/conventions/fe-directory-structure.md)）；复用 `~/core/api`、`~/theme`、`~/ui`
- mobile 入口：屏1 自选主列表 **替换 `apps/mobile/app/(app)/(tabs)/portfolio.tsx`**（现 PHASE 1 placeholder「投资内容即将推出」；点底部「投资」tab 直接进，D6 user 定）；屏3 = `app/(app)/portfolio/watchlist-groups.tsx` push screen；屏2 长按菜单 = overlay（非 route）；`~/ui` 新 `Tabs` / `LongPressMenu` / `DraggableList`（barrel 导出）
- e2e：`apps/mobile/e2e/`（seed-authed `addInitScript` + `_support/api-mock.ts`；**必 mock 015 `/quote` + 003 refresh-token 端点** per memory `authed_business_401_triggers_refresh_interceptor`；`getByRole` 收窄 stacked screen per memory `playwright_expo_stacked_screen_locator_collision`；web-stripped route group URL；**本地跑前杀 :3000 nx serve 父进程** per memory `nx_serve_respawns_3000_poisons_seed_e2e`）；contract-smoke `apps/mobile/e2e/contract-smoke/watchlist.contract.ts`（`nx run mobile:contract-smoke`，打 testcontainers 真 server）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（per memory `mono_dev_db_compose_stack`；mbw-poc-postgres:5433 / redis:6380）；**本地 server IT/smoke 前 `env -u OSS_*`** per memory `local_it_smoke_needs_env_unset_oss`

---

## Phase 1: Foundational（阻塞全部 UC — portfolio 续写 schema + moat + rules）

- [X] T001 [Server] `schema.prisma`：在既有 `portfolio` schema 加 `model Group`（贫血 row + `@map` snake_case，**无 Entity Mapper** per memory `raw_prisma_row_with_map_no_entity_mapper`：`id BigInt @id @default(autoincrement())` / `accountId @map("account_id")` 逻辑引用 JWT sub **无跨 schema FK** / `name @db.VarChar(40)` / `type @db.VarChar(8)`（system\|custom）/ `systemKind @map("system_kind") @db.VarChar(12)` nullable（watchlist\|holdings\|null）/ `visible Boolean @default(true)` / `order Int` / `createdAt`/`updatedAt` Timestamptz(6) / `@@unique([accountId, systemKind], map:"uk_group_account_systemkind")`（每账号每 systemKind ≤1）/ `@@index([accountId, order])` / `@@map("group")` / `@@schema("portfolio")`）+ `model WatchlistItem`（`id` / `groupId @map("group_id")` / `market @db.VarChar(4)`（**cn\|hk\|us** 015 词表 #302 对齐，**不做映射**）/ `code @db.VarChar(16)` 逻辑指向 015 Instrument **无跨 schema FK** / `pinned Boolean @default(false)` / `order Int` / `color @db.VarChar(16)?` / `noteRef @map("note_ref") @db.VarChar(64)?` / `group Group @relation(fields:[groupId], references:[id], onDelete:Cascade)` / `@@unique([groupId, market, code], map:"uk_watchlistitem_group_market_code")`（组内同标的唯一→幂等加）/ `@@index([groupId, pinned, order])` / `@@map("watchlist_item")` / `@@schema("portfolio")`）+ migration `{YYYYMMDD}_{HHMM}_add_portfolio_watchlist/`（**expand-only** CREATE 2 TABLE + FK(同 portfolio schema 内允许) + unique/index，非破坏 → 单 PR 合规，ADR-0035 + `migration_refs` frontmatter）+ `prisma generate` + dev DB `up -d --wait` + `migrate deploy` 验证落表
- [X] T002 [P] [Server] **moat 登记**（SC-S06）：`scripts/checks/check-server-moat.ts` `MODEL_OWNERSHIP` 加 `group: 'portfolio'` + `watchlistItem: 'portfolio'`（**否则 portfolio UC 读自己的表即 `moat-unmapped` 硬拒**）。`BUSINESS_CTX` 已含 `portfolio`（01 登记，不重加）；ESLint portfolio boundaries 已存在（01，不改）。verify `nx lint server` 0 violation & `pnpm tsx scripts/checks/check-server-moat.ts` 关
- [X] T003 [P] [Server] `watchlist.rules.ts`（纯函数不变量，ADR-0043 §4）：`isSystemGroup(g)` / `assertGroupMutable(g)`（系统组改名/删 → throw）/ `assertItemMutable(group)`（持仓组写 → throw）/ `resortWithPinPriority(items, op)`（**固顶区(pinned=true)常驻顶 > 非固顶区**；「移到最前/最后」仅在非固顶区调位 → 移到最前位于固顶项下方，FR-S05）/ `defaultSystemGroups(accountId)`（自选+持仓投影种子）/ `fallbackGroupForDelete(groups)`（删组 item 回落「自选」目标，FR-S02）+ **vitest 纯函数单测**（无 DB；重点 `resortWithPinPriority` 固顶/非固顶区调位 + 删组回落）

## Phase 2: US1 分组 CRUD + 系统组语义（[Server]，PR1）

**Goal**：系统组「自选」「持仓」随账号自动存在、不可删/改名、可隐藏+拖拽序；自定义组全 CRUD；删非空自定义组 item 回落「自选」不丢。
**Independent Test**：Testcontainers PG —— 新账号 GET 恰 2 系统组 / 建自定义组 / 删改系统组拒 4xx / reorder+隐藏持久化 / 删非空回落自选。

- [X] T004 [US1] [Server] **groups query**：`list-watchlist-groups.usecase.ts`（intra query，直注 `PrismaService`）：`prisma.group.findMany({where:{accountId}})` → 0 行投影 2 虚拟系统组（**GET 零写库**，D2）；≥1 行读回 + 各组 `itemCount`（`prisma.watchlistItem.count`）→ 按 `order` 升序 → `group-list.response.ts`（`GroupListResponse{groups: GroupItem[]}`，swagger，`type`/`systemKind` enum）+ Testcontainers PG 单测（新账号投影恰 2 系统组 visible/order 固定 / 老账号读回 + itemCount / 持仓组在）
- [X] T005 [US1] [Server] **groups write**：`create-watchlist-group.usecase.ts`（自定义组，**首写 materialize 2 系统组** `ON CONFLICT(account_id,system_kind) DO NOTHING`，D2；name per-account 去重）/ `update-watchlist-group.usecase.ts`（自定义改名；系统组改名 → `assertGroupMutable` throw `SYSTEM_GROUP_PROTECTED` 422）/ `delete-watchlist-group.usecase.ts`（**持 tx**：自定义组 item 回落「自选」`UPDATE ... SET group_id=<自选.id>`（冲突项=目标已有同 market+code → 丢弃幂等）→ `DELETE group`，**非级联删 item** FR-S02；系统组删 → throw 422）/ `reorder-watchlist-groups.usecase.ts`（批量 order+visible，last-write-wins，EP5）+ DTOs（`create`/`update`/`reorder` request，class-validator）+ 2 exception（`system-group-protected.exception.ts` 422 / `group-not-found.exception.ts` 404，镜像 011 exception）+ Testcontainers PG 单测（建自定义组 type=custom / 改名 / 系统组删改 422 / 删非空回落自选不丢 + 冲突幂等 / reorder+隐藏持久化）
- [X] T006 [US1] [Server] **groups controller + 接线**：`watchlist-groups.controller.ts`（`@Controller('v1/portfolio/watchlist-groups')`，`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`）：EP1 GET / EP2 POST / EP3 PATCH `:groupId` / EP4 DELETE `:groupId` / EP5 PATCH（批量 reorder）+ named throttler（`watchlist-read-account` / `watchlist-write-account`）+ swagger（200/400/401/404/422/429）+ `portfolio.module.ts` 加 controller+providers + `throttler-skip-buckets.ts` 加 `WATCHLIST_BUCKETS`/`WATCHLIST_ALL` + `auth.module.ts` 全局 ThrottlerModule 加 2 named + **所有既有 controller `@SkipThrottle` spread `...WATCHLIST_ALL`**（反污染纪律，同 011/004）+ 单测

## Phase 3: US2 自选项 CRUD + 排序 + 归属（[Server]，PR1）

**Goal**：加入/删除/固顶/移到最前/移到最后/改归属/颜色/笔记；排序优先级 = 固顶区常驻顶 > 非固顶区；持仓组派生只读。
**Independent Test**：Testcontainers PG —— 加 item 默认自选+幂等 / 固顶排序优先级 / 移到最前在固顶下方 / 改组 / 删 / 持仓组写拒。

- [X] T007 [US2] [Server] **items query + add**：`list-watchlist-items.usecase.ts`（读某组 items `ORDER BY pinned DESC, "order" ASC`；**持仓组 = 派生只读视图，holdings/import 未建 → V1 返空** FR-S06）+ `add-watchlist-item.usecase.ts`（默认落「自选」+ materialize 系统组；持仓组 → `assertItemMutable` throw `HOLDINGS_GROUP_READONLY` 422；组内 `(market,code)` 冲突 → catch unique 返现有 item **幂等 200**，EP7/FR-M07）+ `watchlist-item-list.response.ts`（`ItemListResponse{items: WatchlistItemView[]}`，`market` enum `['cn','hk','us']`，**行情值不在契约** ADR-0048）+ `add-watchlist-item.request.ts`（`{market,code}` class-validator + market enum 校验）+ Testcontainers PG 单测（加 item 默认自选 / 幂等重复加 / 持仓组加拒 422 / market 非法 400）
- [X] T008 [US2] [Server] **items mutate**：`update-watchlist-item.usecase.ts`（**持 tx**：固顶/移到最前/最后/改归属组/颜色/笔记；调 `resortWithPinPriority` 算新 order；改组涉源+目标两组；持仓组写 → 422）+ `delete-watchlist-item.usecase.ts`（持仓组派生项 → 422 `HOLDINGS_GROUP_READONLY`，普通项删）+ `update-watchlist-item.request.ts`（`{pinned?,move?,targetGroupId?,color?,noteRef?}`）+ 2 exception（`holdings-group-readonly.exception.ts` 422 / `watchlist-item-not-found.exception.ts` 404）+ Testcontainers PG 单测（固顶常驻顶 / 移到最前在固顶下方 / 改组 item 移到目标组 / 删 / 持仓组改删拒 422）
- [X] T009 [US2] [Server] **items controller**：`watchlist-items.controller.ts`（`@Controller('v1/portfolio/watchlist-items')`，guards）：EP8 PATCH `:itemId` / EP9 DELETE `:itemId` + EP6 GET `/watchlist-groups/:groupId/items` + EP7 POST `/watchlist-groups/:groupId/items`（items list/add 挂 groups path → 放 groups controller 或独立，tasks impl 时定位）+ swagger + throttler + `portfolio.module.ts` 接线 + 单测

## Phase 4: Server 集成验证 + 契约（PR1）

- [X] T010 [Server-IT] **全 boot Testcontainers PG IT**（`apps/server/test/integration/watchlist.*.it.spec.ts`，覆盖 spec frontmatter `state_branches` **每条**）：groups new-user 恰 2 系统组 / custom CRUD / 系统组删改 422 / reorder+visibility 持久化（隐藏组标记）/ items list / **持仓组 V1 空** / item ops 固顶排序优先级 + 移到最前在固顶下方 / 改组 / 删 / **持仓组删除拒 422** / 删非空自定义组 item 回落自选 / 反枚举 401（未认证/非 ACTIVE 字节级一致，剥 traceId）/ 限流 429（读 121 / 写 61 边界）
- [X] T011 [Contract] `nx run server:export-openapi`（canonical `node dist/main.js`，per memory）→ `nx affected -t generate`（Orval regen api-client portfolio watchlist hook）+ `packages/api-client` + mobile typecheck 绿 + **commit regen 产物**（PR1 内，§V 例外）
- [X] T012 [Verify] `pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（本地前 `env -u OSS_*`）+ ~~`server-bounded-context-catalog.md` § Operation Catalog 新增 9 行~~（**N/A**：该 registry 已 sunset，per ADR-0034 sunset_trigger 2026-06-02 触发，靠代码派生不手维护；且 013 intra-only 零跨 ctx → 无 operation 可登记）+ boundaries 0 violation + `check-server-moat.ts` 关 + **ADR-0048 验证：portfolio 零 `prisma.<marketdataTable>.*` + 零 marketdata UC 注入（grep 实证 ✓）**

## Phase 5: US3-US6 自选 mobile UI（[Mobile]，PR2 — 消费 PR1 已 merge typed client）

**Goal**：3 屏（主列表 Tab 横滑 + 长按菜单 + 分组管理）+ 涨红跌绿（client 调 015 /quote merge）+ V1 添加入口。
**Independent Test**：Playwright Expo Web —— 主列表渲染/涨跌色 / Tab 横滑 / 长按 6 项+持仓 disabled / 分组管理建组拖拽 / 添加入口加自选。

- [X] T013 [Mobile] **token + 3 原语**：`apps/mobile/src/theme/colors.ts` 加 `quote.up`（红）/`quote.down`（绿）/`quote.flat`（灰）（mockup `design/handoff-claude-design/` 提案 hex，**0 既有 token 重设** SC-M06，**不复用** err/ok）+ `~/ui` `Tabs.tsx`（横滑分组 Tab，`accessibilityRole='tab'`）/ `LongPressMenu.tsx`（gesture-handler 长按 overlay）/ `DraggableList.tsx`（**自建** gesture-handler@2.28 `Pan` + reanimated@4.1.7 `useAnimatedStyle`，**不引** draggable-flatlist，D7）+ barrel 导出 + typecheck/lint（presentational 无单测）
- [X] T014 [Mobile] **hooks**：`use-watchlist-groups.ts` / `use-watchlist-items.ts`（包 orval query+mutation + 乐观更新 + 响应对账 + 失败回弹 + 错误分流 422 系统组保护/持仓只读 vs 网络错，复用 `~/core/api/errors.ts`）+ `use-quote-merge.ts`（调 **015** marketdata `/quote` orval hook，按当前组 items `market:code` 批量取价 client-side merge，015 无数据/失败 → 占位 `--`，FR-M03/ADR-0048）+ **vitest 逻辑分流单测**（涨跌色逻辑 quote.up/down/flat / 错误分流 / 乐观对账）
- [X] T015 [P] [US3] [Mobile] **屏1 主列表**：`watchlist-row.tsx`（名+代码 + 最新/涨幅/涨跌三列涨红跌绿 + 符号 +/- 辅助 a11y）+ `watchlist-main-screen.tsx`（分组 Tab 横滑 + 虚拟化 FlatList + 末尾 ☰ + 长按弹屏2 + 行情 merge + 隐藏组不显示 + **兜底强制「自选」可见** D4）+ **替换 `app/(app)/(tabs)/portfolio.tsx` placeholder**（投资 tab 落地页，D6）+ typecheck/lint
- [X] T016 [P] [US4] [Mobile] **屏2 长按菜单**：`watchlist-item-menu.tsx`（长按弹 6 项：删除/固顶/移到最前/移到最后/分组·颜色/笔记，**无批量操作**；**持仓组标的「删除」灰显 disabled**，其余可用 FR-M04）overlay + a11y label
- [X] T017 [P] [US5] [Mobile] **屏3 分组管理**：`group-management-screen.tsx`（标题「全部分组」+ 右上「新建分组」；每组行 = 组名 + 标的数 + 👁隐藏切换 + ☰拖拽手柄；系统组仅隐藏+拖拽，自定义组隐藏+删+重命名(⋯)+拖拽；**拖拽序 → 主列表 Tab 顺序** FR-M06）push screen `app/(app)/portfolio/watchlist-groups.tsx` + `_layout` 注册 + typecheck/lint
- [X] T018 [P] [US6] [Mobile] **V1 添加入口**：`add-watchlist-entry.tsx`（手输 market+code 或 mini 搜索 **调 015 `/search`** → POST 加自选默认落「自选」FR-M07）+ `watchlist-copy.ts`（中文文案）+ typecheck/lint

## Phase 6: Mobile 验证（PR2，正交两层 per sdd.md §V）

- [X] T019 [Mobile-E2E] **Playwright Expo Web hermetic UI e2e**（`apps/mobile/e2e/watchlist.spec.ts`）：登录 → 进投资 tab 断言自选主列表（列头名称｜最新｜涨幅｜涨跌 + 行涨跌色）→ Tab 横滑切组（隐藏组不显示）→ 长按某标的弹 6 项菜单（持仓 disabled）→ 固顶 → 进分组管理建组/拖拽 → 添加入口加自选 → 截图归档；**a11y 断言（FR-M09）**：Tab `getByRole('tab')`、长按菜单项 role+label 可达、涨跌色**非唯一信息载体**（断言数值带 +/- 符号辅助，色盲友好）；**mock 015 `/quote`（stub 行情）+ 003 refresh-token 端点**（避免误登出，per memory）；`getByRole` 收窄 stacked screen；**本地跑前杀 :3000 nx serve 父进程**
- [X] T020 [Contract-Smoke] **契约冒烟**（`apps/mobile/e2e/contract-smoke/watchlist.contract.ts`，`nx run mobile:contract-smoke`，生成 `@nvy/api-client` 打 **testcontainers 真 server**）：登录 → 建自定义组 → 加自选（market+code）→ 固顶 → 验**真落库** + 契约对齐（补 hermetic mock 与 server IT 覆盖不到的缝，per sdd.md §V）

---

## Dependencies & PR 序

```text
PR1 (Server)：T001 → T002/T003(P) → T004-T006(US1) → T007-T009(US2) → T010(IT) → T011(Contract) → T012(Verify)
                                                                                          │ merge
PR2 (Mobile)：T013 → T014 → T015/T016/T017/T018(P, US3-6) → T019(E2E) → T020(Contract-Smoke)
```

- **T001 阻塞全部**（schema 是 UC 前提）。T002/T003 可与 T001 后并行（不同文件）。
- **US1（T004-6）→ US2（T007-9）**：items UC 依赖 group materialize 逻辑（T005）。
- **PR1 → PR2 硬序**：PR2 消费 PR1 已 merge 的 typed client（T011 regen）；PR2 不可先于 PR1 merge。
- **T015-T018（US3-6）可并行**（不同屏文件）；均依赖 T013（原语）+ T014（hooks）。

## Implementation Strategy

- **MVP = PR1 US1+US2**（server 分组/自选项 CRUD 真后端，可经 contract-smoke 自测）→ 增量交付 PR2 UI。
- **每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` 回填**（per Constitution III + `.claude/rules/implement-task-closure.md`）。
- 预估 **20 tasks**（PR1 12 server + PR2 8 mobile）。主要新点 = portfolio 续写 2 实体 + 排序优先级 rules + mobile 3 新原语（Tabs/LongPressMenu/DraggableList 自建）+ client-side 015 行情 merge（ADR-0048）。

---

**Tasks Version**: 1.0.0 | **Created**: 2026-06-03 | **ID-namespace**: T001-T020 / US1-6 | **PR**: PR1 server(T001-12) + PR2 mobile(T013-20)
