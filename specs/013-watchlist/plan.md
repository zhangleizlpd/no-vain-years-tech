---
feature_id: 013-watchlist
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-03'
updated_at: '2026-06-03'
adr_refs: ['0019', '0022', '0024', '0032', '0035', '0038', '0041', '0043', '0048']
context7_verified: []
---

# Implementation Plan: 013-watchlist（自选列表 — 分组 Tab + 长按菜单 + 分组管理）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `013-watchlist`（设计在 `investment` 长期分支，本分支 impl）| **PRD**: [portfolio-04](../../docs/prd/portfolio/portfolio-04-watchlist-prd.md) | **Mockup baseline**: [`design/`](./design/)（`brief.md` + `handoff-claude-design/自选列表.html` + 截图）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011/012/015/016）。
> **统一 mockup-first 流程**（per [sdd.md](../../docs/conventions/sdd.md)）：spec ✅ → clarify ✅（2026-05-29）→ mockup ✅ → **plan（本）** → tasks → impl。本 plan **含完整 UI 段**（mockup 基线已在）。纪律②：UI impl 定稿前补真后端冒烟（Playwright Expo Web）。
> **⚠ 承重不变性（[ADR-0048](../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md)）**：013 server 段**不 DI marketdata**；行情/搜索由 **mobile client 直调 015 `/quote`·`/search` client-side merge**，013 server 与 015 运行时**零跨 ctx**。详见 § Architecture Notes「跨层不变性」。

## Summary _(mandatory)_

013 = **portfolio 第 3 特性**（继 01 市场偏好 / 02 券商账户）+ server 分组/自选项 CRUD + mobile 3 屏 UI：① **分组 CRUD**（系统组「自选」「持仓」随账号自动存在、不可删/改名、可隐藏+拖拽序；自定义组全 CRUD；删非空自定义组 item 回落「自选」不丢）② **自选项 CRUD + 排序**（加入/删除/固顶/移到最前/移到最后/改归属/颜色/笔记关联；排序优先级 = 固顶区常驻顶 > 非固顶区；持仓组派生只读）③ **mobile 3 屏**（主列表 Tab 横滑 + 长按菜单 6 项 + 分组管理）+ 行情值由 client 调 015 `/quote` merge 涨红跌绿 + V1 临时添加入口（手输 market+code / mini 搜索调 015 `/search`）。

**范式** = ADR-0043 扁平贫血 + 单向 Moat；属**既有 `portfolio` bounded context**（01 已立第 4 ctx，本特性续写、**不新立 context**）。**新基础设施** = 2 张 portfolio 表（`Group` + `WatchlistItem`）+ mobile 新原语（Tab 栏 / 长列表行 / 长按菜单 / 拖拽排序，项目均无）+ 新 theme token `quote.up/down/flat`（涨红跌绿）。**无 outbox 事件**（per ADR-0048 §4：分级已砍、零消费者 → 不预发；未来分级 feature 再按 Q7-A 补）。

**bounded context（per [catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 决策问题，见 § Architecture Notes）**：**portfolio** 自持 `Group` / `WatchlistItem` 两表（贫血 row + `watchlist.rules.ts` 纯函数不变量）；分组/自选项 UC 直注 `PrismaService` 读写自己 ctx 的表（R1，无 repository port）。**零跨 ctx 业务调用**（无 R2/R3）——行情/搜索经 **mobile client-side merge**（per ADR-0048，server 段不碰 marketdata）；唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（`AccountModule` 已 export，account-bound 鉴权 artefact，非业务调用，无注释要求）。`WatchlistItem` 仅逻辑引用 `accountId`（经 group.accountId）+ 逻辑指向 015 `Instrument`（`market+code`），**无跨 schema FK**。

## API Contracts _(mandatory)_

| #   | Method | Path                                                       | Auth   | Request                                                                 | Response                                          | trace FR                       |
| --- | ------ | ---------------------------------------------------------- | ------ | ---------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------ |
| EP1 | GET    | `/api/v1/portfolio/watchlist-groups`                       | bearer | —                                                                      | **200** `GroupListResponse{groups[]}` / 401 / 429 | FR-S01, FR-S03                 |
| EP2 | POST   | `/api/v1/portfolio/watchlist-groups`                       | bearer | `{name}`                                                              | **200** `GroupListResponse`（全量）/ 401/422/429  | FR-S02                         |
| EP3 | PATCH  | `/api/v1/portfolio/watchlist-groups/{groupId}`             | bearer | `{name?}`（仅自定义组改名）                                            | **200** `GroupListResponse` / 401/404/422/429     | FR-S02                         |
| EP4 | DELETE | `/api/v1/portfolio/watchlist-groups/{groupId}`             | bearer | —（自定义组；item 回落「自选」）                                       | **200** `GroupListResponse` / 401/404/422/429     | FR-S02                         |
| EP5 | PATCH  | `/api/v1/portfolio/watchlist-groups`                       | bearer | `{ordered:[{groupId,order,visible}]}`（批量拖拽序 + 隐藏切换）         | **200** `GroupListResponse` / 401/422/429         | FR-S01, FR-S03                 |
| EP6 | GET    | `/api/v1/portfolio/watchlist-groups/{groupId}/items`       | bearer | —                                                                      | **200** `ItemListResponse{items[]}` / 401/404/429 | FR-S04, FR-S07                 |
| EP7 | POST   | `/api/v1/portfolio/watchlist-groups/{groupId}/items`       | bearer | `{market, code}`（默认落「自选」；持仓组拒）                           | **200** `ItemListResponse` / 401/404/422/429      | FR-S04, FR-S06, FR-S08, FR-M07 |
| EP8 | PATCH  | `/api/v1/portfolio/watchlist-items/{itemId}`               | bearer | `{pinned?, move?:'front'\|'back', targetGroupId?, color?, noteRef?}`   | **200** `ItemListResponse` / 401/404/422/429      | FR-S04, FR-S05                 |
| EP9 | DELETE | `/api/v1/portfolio/watchlist-items/{itemId}`               | bearer | —（持仓组派生项拒）                                                    | **200** `ItemListResponse` / 401/404/422/429      | FR-S04, FR-S06                 |

- `GroupItem` = `{ id, name, type:'system'｜'custom', systemKind:'watchlist'｜'holdings'｜null, visible:bool, order:int, itemCount:int }`。`groups[]` 按 `order` 升序；系统组「自选」「持仓」恒在（投影/materialize，见 § 并发）。
- `WatchlistItemView` = `{ id, groupId, market:'cn'｜'hk'｜'us', code, pinned:bool, order:int, color:string｜null, noteRef:string｜null }`。**行情值（最新/涨幅/涨跌）不在本契约**——mobile client 调 015 `/quote?symbols=cn:600519` client-side merge（per ADR-0048 / FR-S07）。
- EP2/EP3/EP4/EP5 返回**全量** groups 最新态；EP7/EP8/EP9 返回该组（或受影响组）**全量** items 最新态——客户端直接对账乐观更新。
- 错误一律 RFC 9457 ProblemDetail（复用 001 全局 filter，per [ADR-0038](../../docs/adr/0038-error-handling-ux-contract.md)）；新增 code：`SYSTEM_GROUP_PROTECTED`（422，删/改名系统组）/ `HOLDINGS_GROUP_READONLY`（422，写持仓派生组）/ `GROUP_NOT_FOUND`（404）/ `WATCHLIST_ITEM_NOT_FOUND`（404）。body 校验失败 → 复用 `FORM_VALIDATION`（400）。401 沿用 `JwtAuthGuard`（反枚举不区分原因）。**重复加同 item 到同组 → 幂等 200**（不报错，per Edge case `market+code` 组内唯一）。
- 路径前缀 `api`（全局）。端点路径为 spec 提案，OpenAPI code-first（swagger 装饰器）阶段定稿。**3 端点 perf SoT** = spec frontmatter `perf_budgets`（EP1 GET groups / EP6 GET items / EP5 PATCH reorder）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`）           | 状态 | 备注                                                                                                                                          |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| I. SDD（NON-NEGOTIABLE）                            | ✅   | spec ✅ → clarify ✅ → mockup ✅ → plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点                                              |
| II. Test-First TDD（NON-NEGOTIABLE）               | ✅   | 每 impl task 红→绿→typecheck/lint→`[X]`→commit；系统组保护 / 持仓只读 / 删组回落 / 固顶排序优先级 / 反枚举 401 均专测（Testcontainers PG）；mobile 逻辑分流 vitest + UI Playwright |
| III. Atomic 30min-2h + 独立 commit                 | ✅   | tasks.md 按此拆；server PR + mobile PR 两段（见 § Phase 2 准备 PR 策略）                                                                      |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅   | 既有 `portfolio` ctx 续写；portfolio 内零 `prisma.<otherTable>.*`（仅 `prisma.group.*` / `prisma.watchlistItem.*`）；**零跨 ctx 业务调用**（行情/搜索 client-side merge，per ADR-0048）；guard 复用经 `AccountModule` export；`check-server-moat.ts` 关 |
| V. 类型同步链 Nx-driven                            | ✅   | server swagger → `nx run server:export-openapi` → `nx affected -t generate`（Orval）→ api-client typed → mobile 消费                          |

## Architecture Notes _(mandatory)_

### 🚨 跨层不变性（ADR-0048 — ENFORCED，本特性头号约束）

> **013 server 段 NEVER DI marketdata**。行情（最新/涨幅/涨跌）与加自选搜索由 **mobile client 直调 015 读端点 client-side merge**：
>
> - 行情：mobile 调 `GET /api/v1/marketdata/quote?symbols=cn:600519,...`（EOD-backed，asOf/priceKind）→ client 按 `market:code` join 进 `WatchlistItemView` 渲染（涨红跌绿）。015 未就位/无数据 → 占位 `--`（FR-M03）。
> - 搜索：V1 临时添加入口的 mini 搜索调 `GET /api/v1/marketdata/search`（FR-M07）。
> - **013 server 与 015 运行时零跨 ctx**（仅共享 `market:code` 逻辑键，无 server cross-ctx use case 直 DI，无跨 schema FK）。这是「未来分级 marketdata→portfolio 单向无环」的结构性前提（ADR-0048 §3）。
> - `WatchlistItem.market` 词表 = `cn`/`hk`/`us`（015 `Instrument.market` 同词表，#302 已对齐 market_preference；**不做映射**），canonical `cn:600519` 可直喂 015。

### Bounded Context 决策（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 questions，逐条）

| Q     | 问题                                       | 判定                                                                                                                             |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Q1    | 直改 account/credential 核心表 row state？ | **No** — `Group`/`WatchlistItem` 是 portfolio 新表，仅逻辑引用 accountId                                                         |
| Q2    | 编排多 context user-facing 流程？          | **No** — 单一领域（自选组织），accountId 取自 JWT sub（guard）                                                                  |
| Q3    | 纯 platform infra？                        | **No** — 业务领域（portfolio）                                                                                                  |
| Q4    | 完全新业务领域？                           | **No** — `portfolio` 已于 01 立（第 4 ctx）；本特性**续写既有 ctx**，不新立                                                     |
| Q5-Q7 | 跨 ctx call 传播？                         | **N/A** — portfolio 无跨 ctx 业务调用。行情/搜索经 mobile client-side merge（ADR-0048，非 server cross-ctx）；guard 复用经 `AccountModule` export，非 use case 调用，不触发 R2/R3 |

### Portfolio module 落位（per catalog，ship 时新增 Operation 行）

| 操作                          | context       | 类型                  | 跨 ctx | 备注                                                          |
| ----------------------------- | ------------- | --------------------- | ------ | ------------------------------------------------------------ |
| `list-watchlist-groups`       | **portfolio** | intra query UC        | —      | authed；读自己的 `group` 表 → 投影/materialize 2 系统组      |
| `create-watchlist-group`      | **portfolio** | intra write UC        | —      | authed；建自定义组（name 去重 per account）                 |
| `update-watchlist-group`      | **portfolio** | intra write UC        | —      | authed；自定义组改名；系统组改名拒（SYSTEM_GROUP_PROTECTED） |
| `delete-watchlist-group`      | **portfolio** | intra write UC（持 tx）| —      | authed；自定义组删 + item 回落「自选」（非级联删）；系统组拒 |
| `reorder-watchlist-groups`    | **portfolio** | intra write UC        | —      | authed；批量 order + visible（拖拽序/隐藏，last-write-wins） |
| `list-watchlist-items`        | **portfolio** | intra query UC        | —      | authed；读某组 items（持仓组 = 派生只读视图，V1 空）        |
| `add-watchlist-item`          | **portfolio** | intra write UC        | —      | authed；加 item（默认「自选」；持仓组拒）；组内 market+code 幂等 |
| `update-watchlist-item`       | **portfolio** | intra write UC（持 tx）| —      | authed；固顶/移动/改组/颜色/笔记；排序优先级 rules           |
| `delete-watchlist-item`       | **portfolio** | intra write UC        | —      | authed；删 item；持仓组派生项拒（HOLDINGS_GROUP_READONLY）  |

### Server side（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) 扁平贫血，文件平铺于 `apps/server/src/portfolio/`）

**新增（portfolio 既有 module 续写）**：

- `watchlist-groups.controller.ts`（`@Controller('v1/portfolio/watchlist-groups')`，`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`）：EP1-EP7（groups CRUD + reorder + items list/add）+ named throttler + swagger。
- `watchlist-items.controller.ts`（`@Controller('v1/portfolio/watchlist-items')`）：EP8-EP9（item 改/删）。
- 9 个 UC 文件（见 § module 落位表，各 `*.usecase.ts`，直注 `PrismaService`）。改组/固顶/删组持 tx（跨行 order 重排 + 回落）。
- `watchlist.rules.ts`（纯函数不变量，per ADR-0043 §4）：`isSystemGroup(g)` / `assertGroupMutable(g)`（系统组改名/删拒）/ `assertItemMutable(group)`（持仓组写拒）/ `resortWithPinPriority(items, op)`（固顶区常驻顶 > 非固顶区，「移到最前/最后」仅在非固顶区调位）/ `defaultSystemGroups(accountId)`（自选+持仓投影种子）/ `fallbackGroupForDelete(groups)`（删组 item 回落「自选」目标）。
- DTO：`create-watchlist-group.request.ts` / `update-watchlist-group.request.ts` / `reorder-watchlist-groups.request.ts` / `add-watchlist-item.request.ts` / `update-watchlist-item.request.ts`（class-validator）；`group-list.response.ts`（`GroupListResponse{groups: GroupItem[]}`）/ `watchlist-item-list.response.ts`（`ItemListResponse{items: WatchlistItemView[]}`，swagger 装饰器，`market` enum `['cn','hk','us']`）。
- 4 exception：`system-group-protected.exception.ts`（422）/ `holdings-group-readonly.exception.ts`（422）/ `group-not-found.exception.ts`（404）/ `watchlist-item-not-found.exception.ts`（404），镜像 011 exception 体例（HttpException 子类 + RFC 9457 extension）。

**修改既有（platform / cross-cutting）**：

- `apps/server/prisma/schema.prisma`：`portfolio` schema 加 `model Group` + `model WatchlistItem`（见 § Prisma schema）。
- 新 migration `<yyyymmddhhmm>_add_portfolio_watchlist`（**expand-only**：create 2 tables + FK(group↔item，**同 schema 内** portfolio FK 允许) + unique indexes，非破坏性 → 单 PR 合规，per [ADR-0035](../../docs/adr/0035-data-layer-governance.md)）。
- `apps/server/src/security/throttler-skip-buckets.ts`：加 `WATCHLIST_BUCKETS`（read/write 桶，tracker = JWT sub）+ `WATCHLIST_ALL`；`auth.module.ts` 全局 ThrottlerModule 加对应 named throttler；**所有既有 controller** `@SkipThrottle` spread `...WATCHLIST_ALL`（反污染纪律，同 011/004）。
- `apps/server/src/portfolio/portfolio.module.ts`：`controllers` 加 2 个；`providers` 加 9 UC。（PortfolioModule + app.module 注册已于 01 落，本特性不重立。）
- `scripts/checks/check-server-moat.ts`：`MODEL_OWNERSHIP` 加 `group: 'portfolio'` + `watchlistItem: 'portfolio'`（**否则探针 `moat-unmapped` 硬拒**）。`BUSINESS_CTX` 已含 `portfolio`（01 登记），不重加。
- ESLint boundaries：portfolio element 已存在（01），无需改。

### Prisma schema（2 新表，portfolio schema）

```prisma
model Group {
  id         BigInt          @id @default(autoincrement())
  accountId  BigInt          @map("account_id")               // 逻辑引用 JWT sub，无跨 schema FK
  name       String          @db.VarChar(40)
  type       String          @db.VarChar(8)                   // 'system' | 'custom'
  systemKind String?         @map("system_kind") @db.VarChar(12) // 'watchlist' | 'holdings' | null
  visible    Boolean         @default(true)
  order      Int                                              // 拖拽序（账号内）
  createdAt  DateTime        @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime        @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  items      WatchlistItem[]

  @@unique([accountId, systemKind], map: "uk_group_account_systemkind")  // 每账号每 systemKind ≤1（自选/持仓各唯一；custom 的 systemKind=null 不约束）
  @@index([accountId, order], map: "ix_group_account_order")
  @@map("group")
  @@schema("portfolio")
}

model WatchlistItem {
  id        BigInt   @id @default(autoincrement())
  groupId   BigInt   @map("group_id")
  market    String   @db.VarChar(4)                           // 'cn' | 'hk' | 'us'（015 词表，#302 对齐）
  code      String   @db.VarChar(16)                          // 逻辑指向 015 Instrument(market,code)，无跨 schema FK
  pinned    Boolean  @default(false)
  order     Int                                               // 非固顶区序（pinned 项单独区）
  color     String?  @db.VarChar(16)
  noteRef   String?  @map("note_ref") @db.VarChar(64)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  group     Group    @relation(fields: [groupId], references: [id], onDelete: Cascade)

  @@unique([groupId, market, code], map: "uk_watchlistitem_group_market_code") // 组内同标的唯一（幂等加）
  @@index([groupId, pinned, order], map: "ix_watchlistitem_group_pin_order")
  @@map("watchlist_item")
  @@schema("portfolio")
}
```

- 贫血 row + `@map` snake_case（per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)，无 Entity Mapper）。`market` 用 015 词表 `cn/hk/us`（**不做映射**，per FR-S08 + #302）。
- `Group.systemKind` 唯一约束保证每账号「自选」「持仓」各 ≤1（materialize 幂等）。`onDelete: Cascade` 仅 DB 级兜底；业务删自定义组走 UC 内**回落「自选」非级联**（FR-S02），删账号时才靠 cascade。
- 排序物理：pinned 项与非固顶项**同表**，`pinned` 布尔 + `order` 整数，读侧 `ORDER BY pinned DESC, "order" ASC`（rules `resortWithPinPriority` 保证写侧 order 一致）。

### 并发 / 事务策略

> **核心决策（D1）**：013 的写操作**无 011 式 min-1 跨行强不变性**——排序/可见性是 **last-write-wins**（spec Edge「固顶/移动/排序并发 → 末次写入」），不需 `SELECT FOR UPDATE` 串行化。

1. **系统组 materialize**：新账号 GET（EP1）走**投影**返「自选」「持仓」2 虚拟系统组（**零写库**，对齐 011 GET 纯读）；**首次写**（建自定义组 / 加 item / reorder / pin）在 tx 内 `INSERT ... ON CONFLICT(account_id,system_kind) DO NOTHING` 落 2 系统组真实行（materialize-on-first-write），使 item 永远挂真实 groupId。EP7 加 item 到「自选」时若系统组未 materialize → 同 tx 先 materialize 再 attach。
2. **删非空自定义组（FR-S02）**：UC 持 tx → `UPDATE watchlist_item SET group_id=<自选.id> WHERE group_id=<删除组.id AND 非冲突>` 回落（冲突项 = 目标组已有同 market+code → 丢弃重复，幂等）→ `DELETE group`。**非级联删 item**（不丢数据）。
3. **改组/固顶/移动 order 重排（EP8）**：持 tx 读目标组 items → `resortWithPinPriority` 纯函数算新 order → 批量 update。并发=last-write-wins（order 持久化，末次覆盖）。固顶区（pinned=true）常驻顶；「移到最前/最后」仅在非固顶区（pinned=false）内调位 → 移到最前的项位于固顶项下方（FR-S05）。
4. **持仓组派生只读（FR-S06）**：持仓组 `systemKind='holdings'`，所有写 UC（add/update/delete item、改组到持仓）先 `assertItemMutable` → 持仓组拒（HOLDINGS_GROUP_READONLY）。**holdings/import 未建 → V1 持仓组 items 恒空**（结构在，list 返空）。
5. **至少「自选」可见（spec Edge）**：reorder/visibility（EP5）允许隐藏系统组，但**主列表 Tab 至少兜底「自选」可见**——server 不强制（允许全隐藏持久化），mobile 主列表渲染时若可见组为空则强制显示「自选」（plan 决策 D4，client 兜底，避免空 Tab 死锁）。
6. **幂等**：重复加同 item 到同组 → unique `(groupId,market,code)` → UC catch 冲突返现有 item（200，不报错）。

### 限流配置（复用 throttler infra + AccountIdThrottlerGuard）

| 端点组                       | per-account | 实现                                                |
| ---------------------------- | ----------- | -------------------------------------------------- |
| watchlist 读（EP1/EP6）      | `120/60s`   | named `watchlist-read-account`                     |
| watchlist 写（EP2-5/7/8/9）  | `60/60s`    | named `watchlist-write-account`                    |

全 authed → 复用 `AccountIdThrottlerGuard`，无 IP 桶。读阈值较高（Tab 横滑/进组频繁拉 items）。`@SkipThrottle` 其余全部桶防污染。← 阈值 tasks gate review（D5）。

### Mobile side（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) strangler-fig + [mobile-impl-playbook](../../docs/conventions/mobile-impl-playbook.md)）

**`apps/mobile/src/portfolio/`（feature dir 已于 01 建，续写）**：

- `use-watchlist-groups.ts` / `use-watchlist-items.ts`：包 orval 生成 hook（groups/items query + 各 mutation）；乐观更新 + 响应对账 + 失败回弹；错误分流（422 系统组保护 / 持仓只读 / 通用网络错，复用 `~/core/api/errors.ts` guard 体例）。
- `use-quote-merge.ts`：调 015 `usePortfolioController... ` ❌ —— **调 015 marketdata `/quote` orval hook**（`useMarketdataControllerGetQuotes`），按当前组 items 的 `market:code` 批量取价 → client-side merge 进行情列（per ADR-0048）；015 无数据/失败 → 占位 `--`。**authed 业务 401 触发 003 refresh 拦截器**（per memory，e2e 须 mock refresh 端点）。
- `watchlist-row.tsx`：单标的行（名+代码 + 最新/涨幅/涨跌三列，涨 `quote.up`/跌 `quote.down`/平 `quote.flat`；符号 +/- 辅助 a11y）。
- `watchlist-main-screen.tsx`（屏1）：分组 Tab 横滑（`accessibilityRole='tab'`）+ 列表（虚拟化 FlatList）+ 末尾 ☰ + 长按弹屏2。
- `watchlist-item-menu.tsx`（屏2）：长按菜单 6 项（删除/固顶/移到最前/移到最后/分组·颜色/笔记）；持仓组「删除」灰显 disabled。
- `group-management-screen.tsx`（屏3）：组行（组名 + 标的数 + 👁 隐藏切换 + ☰ 拖拽手柄）；系统组仅隐藏+拖拽，自定义组全 CRUD；拖拽序 → Tab 顺序。
- `add-watchlist-entry.tsx`（FR-M07 V1 临时入口）：手输 market+code 或 mini 搜索（调 015 `/search`）→ POST 加自选默认落「自选」。
- `watchlist-copy.ts`：中文文案常量。

**新增 `~/ui` 原语**（项目均无，per PRD §7.3）：

- `Tabs.tsx`（横向可滑动分组 Tab，`~/theme` token，`accessibilityRole='tab'`）。
- `LongPressMenu.tsx`（长按弹出菜单，基于 `react-native-gesture-handler` 既有；菜单项 a11y label）。
- `DraggableList.tsx`（拖拽排序，**基于既有 `react-native-gesture-handler@2.28` + `react-native-reanimated@4.1.7` 自建**，不引 `react-native-draggable-flatlist`——见 § Dependencies）。
- 各 presentational 无单测（per mono 测试分层，typecheck/lint 即可）。

**新增 theme token**（`apps/mobile/src/theme/colors.ts`）：

- `quote.up`（红）/ `quote.down`（绿）/ `quote.flat`（灰）——涨红跌绿 A 股惯例，**不复用** `err`/`ok`（语义相反，PRD §7 / OQ3）。具体 hex 取 mockup 提案（`design/handoff-claude-design/`）。**0 既有 token 重设**（SC-M06）。

**Expo route**（per [reference expo-router-app-route-scan](../../)）：

- 屏1 自选主列表 = **投资 tab 落地页**（`app/(app)/(tabs)/portfolio.tsx`，**替换现有 PHASE 1 placeholder**「投资内容即将推出」；点底部「投资」tab 直接进自选主列表，D6 user 定 2026-06-03）；屏3 分组管理 = 从屏1 push 的 screen（`app/(app)/portfolio/watchlist-groups.tsx`，具体路径 tasks 定）；屏2 长按菜单 = overlay（非独立 route）。

### Dependencies & Defensive Additions（Cargo-cult 防火墙 + Vendor 评估）

| 引入的依赖 / Defensive Import | 目的       | Fact-check 锚点 / 决策                                                                                                                                                              |
| ----------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **None**（拖拽排序）          | 组管理拖拽 | **不引** `react-native-draggable-flatlist`——其与 `react-native-reanimated@4.x`（4 是 major 重写）兼容性未验，且项目已有 `gesture-handler@2.28` + `reanimated@4.1.7` 足以自建简单纵向拖拽。← Vendor 6Q：Q2「已装工具能否等价覆盖」= **能**（reanimated `useAnimatedStyle` + gesture-handler `Pan`）。若自建成本超 1 day → tasks gate 重评（D7） |

### Cross-cutting

- **同步链**（Constitution V，per [api-contract-trigger](../../)）：server controller/DTO/swagger → `nx run server:export-openapi` → `nx affected -t generate`（orval regen api-client watchlist 端点 hook）→ mobile 消费 typed hook。**注意**：mobile 行情消费的是 **015 已 ship 的 marketdata `/quote`·`/search` hook**（api-client 已含），非本特性新 server 端点。
- **catalog 更新**：ship 时 `server-bounded-context-catalog.md` § Operation Catalog 新增 9 行（context=portfolio，propagation=intra）。
- **跨 ctx 注释**：portfolio **无** R2/R3 业务调用 → 无 `// CROSS-CONTEXT-SYNC/ASYNC` 注释（行情/搜索 client-side merge 不产生 server 跨 ctx）。`check-server-moat.ts` 验 portfolio 内零 `prisma.<otherTable>.*`（前提：先在探针登记 `group`/`watchlistItem` owner）。
- **反枚举不变性**：所有端点未认证/非 ACTIVE → 统一 401（JwtAuthGuard，与 /me 一致），grep 字节级一致（剥 traceId）。
- **视觉 0 硬编码**（SC-M06）：mobile 实现文件 grep 无 theme token 外 hex/rgb（含新 quote token）。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| #      | 决策                   | 结论                                                                                                                                     | gate? |
| ------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **D1** | 排序/可见性并发原语    | **last-write-wins**（order/visible 持久化末次覆盖）；**无** 011 式 min-1 FOR UPDATE 串行化（013 无跨行强不变性）。改组/固顶 order 重排持 tx 但不锁 | ✅ user 定 |
| **D2** | 系统组存储时机         | **GET 零写库**（投影 2 虚拟系统组）；**首次写** materialize-on-first-write（tx 内 `ON CONFLICT DO NOTHING` 落自选+持仓真实行）           | —     |
| **D3** | 删非空自定义组         | **item 回落「自选」非级联删**（FR-S02，clarify 2026-05-29）；冲突项（目标组已有同标的）丢弃幂等                                          | —     |
| **D4** | 全隐藏组兜底           | server 允许隐藏系统组（含自选）持久化；**mobile 主列表兜底强制「自选」可见**（避免空 Tab 死锁，client 侧）                               | ✅ 默认接受 |
| **D5** | 限流阈值               | 读 `120/60s` · 写 `60/60s`（per-account，复用 AccountIdThrottlerGuard）                                                                 | ✅ 默认接受 |
| **D6** | 自选主列表 IA 落位     | **投资 tab 落地页**（`(tabs)/portfolio.tsx`，替换 PHASE 1 placeholder；点底部「投资」直接进自选主列表）。屏3 push screen / 屏2 overlay | ✅ user 定 |
| **D7** | 拖拽排序实现           | **自建（gesture-handler + reanimated 既有），不引 draggable-flatlist**（reanimated 4 兼容风险）；自建超 1 day 则 tasks gate 重评        | ✅ user 定 |
| **D8** | item 改操作响应粒度    | EP7/8/9 返回**受影响组全量 items**（改组涉及源+目标两组 → 返两组或全量，tasks 定）；客户端对账乐观更新                                   | ✅ 默认接受 |
| **D9** | 虚拟系统组 id 形态     | 新账号零写库 GET 投影的虚拟系统组 `id` = **systemKind 字符串**（`'watchlist'`/`'holdings'`）；真实组（custom + 已 materialize 系统组）`id`=数字串。EP6/EP7 收到 keyword 形 id → materialize 对应系统组再操作；数字形 → 查真实行。保 D2 零写 GET，client 视 id 为不透明 token，首写后下次 GET 返真数字 id 自动对账 | ✅ user 定（T004 impl gate） |
| **Perf** | 3 端点 P95/P99       | EP1 GET groups `100/200` · EP6 GET items `120/250` · EP5 PATCH reorder `150/300`（spec frontmatter SoT）                                | —     |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| —         | —          | —                                    |

**Note**：(1) **续写既有 portfolio ctx**（非新 context），复杂度集中在 2 实体 + 排序语义 + 3 屏 UI 新原语。(2) **无 outbox / 无 scheduler / 无跨 ctx 业务调用**（行情走 client-side merge，per ADR-0048）→ server 侧比 016 简单。(3) **排序 last-write-wins** 比 011 的 FOR UPDATE min-1 串行化简单（无跨行强不变性）。(4) 主要新点 = mobile 3 新原语（Tab / 长按 / 拖拽）+ client-side 行情 merge。

## Performance Budget

| Endpoint                                                  | P95 (ms) | P99 (ms) |
| -------------------------------------------------------- | -------: | -------: |
| `GET /api/v1/portfolio/watchlist-groups`                  |      100 |      200 |
| `GET /api/v1/portfolio/watchlist-groups/{groupId}/items`  |      120 |      250 |
| `PATCH /api/v1/portfolio/watchlist-groups`（reorder）     |      150 |      300 |

_perf 预算 SoT = spec.md frontmatter `perf_budgets`。每账号 groups ≤ ~20、items/组 ≤ ~数百（虚拟化），索引覆盖查询路径，无瓶颈。行情值不经 server（client merge 015），不计入本预算。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review）

**两段式 PR**（推荐，契合 mockup-first 纪律② + Constitution V 同步链 + Constitution §V cross-end 拆分）：

- **PR1（server，feat(portfolio)）**：watchlist schema（2 表 + migration + moat 登记）+ 9 UC + 2 controller + rules + throttler + IT + contract regen（api-client watchlist hook）。ships 真后端。
- **PR2（mobile，feat(portfolio)）**：`src/portfolio/` 3 屏 + `~/ui` 3 原语 + quote token + client-side 015 行情 merge + V1 添加入口 + vitest 逻辑分流 + 两层验证（`[Mobile-E2E]` Playwright hermetic + `[Contract-Smoke]` 真后端冒烟，per sdd.md §V）。

> **PR1 描述须 cite Constitution §V 例外**（api-client regen 在 PR1 已 merged，PR2 消费已落地 typed client → drift 已消解，沿 005/011 先例）。

### 建议 tasks.md 层级（每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）

**Server（PR1）**：

- `[Server]` schema + migration：`Group` + `WatchlistItem` model + expand-only migration（2 表 + unique/index）+ `prisma generate` gate + moat 登记（`group`/`watchlistItem` owner=portfolio）+ `nx lint server` 0 violation。
- `[Server]` rules：`watchlist.rules.ts`（isSystemGroup / assertGroupMutable / assertItemMutable / resortWithPinPriority / defaultSystemGroups / fallbackGroupForDelete）+ 纯函数单测（vitest，无 DB；重点 resortWithPinPriority 固顶区/非固顶区调位）。
- `[Server]` groups UC + DTO + 4 exception：list（投影/materialize）/ create / update（系统组拒）/ delete（回落非级联）/ reorder（批量 order+visible）+ Testcontainers PG 单测。
- `[Server]` items UC：list（持仓组派生空）/ add（默认自选 + materialize + 幂等）/ update（固顶/移动/改组/颜色/笔记 + 排序优先级）/ delete（持仓只读拒）+ Testcontainers PG 单测。
- `[Server]` 2 controller + module + throttler：swagger（200/400/401/404/422/429）+ 2 named throttler + skip-buckets 加组 + 既有 controller spread skip。
- `[Server-IT]`（Testcontainers PG 全 boot，覆盖 spec `state_branches` 每条）：新账号恰 2 系统组 / 自定义组 CRUD / 系统组删改拒 422 / reorder+隐藏持久化 / 加 item 默认自选 + 幂等 / 固顶排序优先级 / 移到最前在固顶下方 / 改组 / 删 item / 持仓组写拒 / 删非空自定义组 item 回落自选 / 反枚举 401 / 限流 429。
- `[Contract]`：`nx run server:export-openapi` → `nx affected -t generate`（orval regen portfolio watchlist hook）+ api-client/mobile typecheck 绿。
- `[Verify]`：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿 + catalog 9 Operation 行 + boundaries 0 违规 + `check-server-moat.ts` 关（**含 portfolio 零 marketdata 跨 ctx 验证，per ADR-0048**）。

**Mobile（PR2）**：

- `[Mobile]` token + 3 原语：`colors.ts` 加 quote.up/down/flat（mockup hex，0 既有重设）+ `~/ui` `Tabs` / `LongPressMenu` / `DraggableList`（自建 gesture+reanimated）+ barrel 导出 + typecheck/lint。
- `[Mobile]` hooks：`use-watchlist-groups` / `use-watchlist-items`（orval + 乐观更新 + 对账 + 失败回弹 + 错误分流）+ `use-quote-merge`（调 015 `/quote` client-side merge，占位 `--`）+ vitest 逻辑分流单测（涨跌色逻辑 / 错误分流 / 乐观对账）。
- `[Mobile]` 3 屏 + 添加入口 + route：`watchlist-main-screen`（屏1 Tab+列表+行情 merge）+ `watchlist-item-menu`（屏2 6 项 + 持仓删除灰显）+ `group-management-screen`（屏3 CRUD+拖拽）+ `add-watchlist-entry`（手输/mini 搜索 015）+ Expo route（屏1 替换 `(tabs)/portfolio.tsx` placeholder + 屏3 push screen，D6）+ typecheck/lint。
- `[Mobile-E2E]`（Playwright Expo Web，hermetic UI）：渲染主列表（列头+行+涨跌色）/ Tab 横滑切组 / 隐藏组不显示 / 长按菜单 6 项 + 持仓删除 disabled / 进分组管理建组+拖拽 / 添加入口加自选；**mock 015 `/quote` + 003 refresh 端点**（避免误登出，per memory）。
- `[Contract-Smoke]`（per sdd.md §V，node 层打 testcontainers 真 server）：登录 → 建自定义组 → 加自选（market+code）→ 固顶 → 验真落库 + 契约对齐。

预估 task 数：PR1 ~8-10（server）+ PR2 ~5-6（mobile）= **~13-16**。主要新点 = portfolio 续写 2 实体 + 排序优先级 rules + mobile 3 新原语 + client-side 015 行情 merge（ADR-0048）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-03 | **ID-namespace**: US1-6 / FR-S01..S12 / FR-M01..M09 / SC-S01..S06 / SC-M01..M06 | **ADR**: 0048（跨层不变性）/ 0043（扁平贫血）/ 0032（bounded context）
