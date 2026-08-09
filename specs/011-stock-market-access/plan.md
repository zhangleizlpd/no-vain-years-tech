---
feature_id: 011-stock-market-access
spec_ref: ./spec.md
status: done
created_at: '2026-05-29'
updated_at: '2026-06-01'
adr_refs: ['0019', '0022', '0024', '0032', '0035', '0038', '0041', '0043']
context7_verified: []
---

# Implementation Plan: 011-stock-market-access（证券市场准入设置页 — 多市场激活开关）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `011-stock-market-access`（设计在 `investment` 长期分支，impl 阶段开 feature 分支）| **PRD**: [portfolio-01](../../docs/prd/portfolio/portfolio-01-stock-market-prd.md) | **Mockup baseline**: [`design/`](./design/)（commit `3ece552`，toggle ON 配色定稿 = `brand-500` 蓝）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**。
> **类 2 流程**（per spec § 流程 OVERRIDE）：spec ✅ → clarify ✅ → mockup ✅ → **plan（本）** → tasks → impl。本 plan **含完整 UI 段**（mockup 已定稿）。纪律②：UI impl 定稿前补一次真后端冒烟（Playwright Expo Web）。

## Summary _(mandatory)_

01 = **portfolio 大模块首特性** + 2 server UC + 1 mobile 设置页：①**GetMarketPreferences**（authed：返回核心 3 市场激活态，新用户读侧投影默认 `{CNY:active, HKD/USD:inactive}`，GET 零写库副作用；响应附 9 市场静态字典元信息）②**UpdateMarketPreference**（authed：单市场 PUT 即时持久化 + 两条不变性 server 强制——min-1 核心激活数恒 ≥ 1 / 海外市场恒不可激活）。③**mobile 设置页**（`src/portfolio/` 新 feature dir + `~/ui` 新 `Switch` 组件 + Expo route + GET/PUT orval hook 消费 + 乐观更新 + min-1 客户端预判拦截 + 失败回弹）。

**范式** = ADR-0043 扁平贫血 + 单向 Moat。**新基础设施** = `portfolio` 第 4 bounded context（module 目录 + Prisma `portfolio` schema + ESLint 单向边界）+ 静态市场字典常量 + mobile `Switch` 原语。**无 outbox 事件**（FR-S09：激活态向下游传播属网关层，本 feature 仅保证激活态可读 → out of scope）。

**bounded context（per [catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 决策问题，见 § Architecture Notes）**：**portfolio** 自持 `market_preference` 表（贫血 row + `portfolio.rules.ts` 纯函数不变量）+ 静态 `MarketCatalog` 常量；2 UC 直注 `PrismaService` 读写自己 ctx 的表（R1，无 repository port）。**零跨 ctx 业务调用**（无 R2/R3）——唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（`AccountModule` 已 `exports` 供跨 module 复用，account-bound 鉴权 artefact，非业务 use case 调用，无 R2/R3 注释要求）。market_preference 仅逻辑引用 `accountId`（JWT sub），**不读写 account 表**（与 `refresh_token` 同款无跨 schema FK）。

## API Contracts _(mandatory)_

| #   | Method | Path                                              | Auth   | Request                                                   | Response                                                                                     | trace FR             |
| --- | ------ | ------------------------------------------------- | ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------- |
| EP1 | GET    | `/api/v1/portfolio/market-preferences`            | bearer | —                                                        | **200** `MarketPreferencesResponse{markets[]}` / 401 / 429                                   | FR-S01, FR-S02, FR-S06, FR-S08 |
| EP2 | PUT    | `/api/v1/portfolio/market-preferences/{market}`   | bearer | path `market`（市场码）+ body `{active: boolean}`        | **200** `MarketPreferencesResponse`（全量最新态）/ 400 / 401 / 422 / 429                     | FR-S03, FR-S04, FR-S05, FR-S08 |

- `MarketItem` = `{ marketCode, displayName, isoCurrency, group: 'core'｜'overseas', v1Available: boolean, active: boolean }`（9 行：核心 3 + 海外 6；海外恒 `active:false`+`v1Available:false`，使客户端无需硬编码字典，FR-S01/FR-M06）。`markets[]` 固定顺序（§市场字典 order）。
- EP2 返回**全量** 9 市场最新态（非单行），客户端直接以响应对账乐观更新（FR-M03）。
- 错误一律 RFC 9457 ProblemDetail（复用 001 全局 filter，per [ADR-0038](../../docs/adr/0038-error-handling-ux-contract.md)）；新增 code：`MIN_ONE_MARKET_REQUIRED`（4xx，关最后一个激活市场）/ `MARKET_NOT_AVAILABLE`（4xx，激活海外市场）/ `MARKET_NOT_FOUND`（404，未知市场码）。校验失败（body 缺 `active` / 类型错）→ 复用既有 `FORM_VALIDATION`（400）。401 沿用既有 `JwtAuthGuard` 鉴权失败映射（反枚举不区分原因）。
- **4xx 码定稿（D2）**：min-1 / 海外拒绝用 **422 Unprocessable Entity**（语义=请求格式合法但违反业务不变性），区别于 400（FORM_VALIDATION 格式错）。`MARKET_NOT_FOUND` = 404。← tasks gate review。
- 路径前缀 `api`（全局）。端点路径为 spec 提案，OpenAPI code-first contract 阶段（swagger 装饰器）定稿。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`）           | 状态 | 备注                                                                                                                                                                                  |
| --------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. SDD（NON-NEGOTIABLE）                            | ✅   | spec ✅ → clarify ✅ → mockup ✅（类 2）→ plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点                                                                               |
| II. Test-First TDD（NON-NEGOTIABLE）               | ✅   | 每 impl task 红→绿→typecheck/lint→`[X]`→commit；min-1 并发恰一拒绝 / 海外拒绝 / 新用户投影 / GET 零写库 / 反枚举 401 均专测（Testcontainers PG）；mobile 逻辑分流 vitest + UI Playwright |
| III. Atomic 30min-2h + 独立 commit                 | ✅   | tasks.md 按此拆；建议 server PR + mobile PR 两段（见 § Phase 2 准备 PR 策略）                                                                                                          |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅   | 新 `portfolio` 第 4 ctx；单向 `portfolio → {security, account}`；portfolio 内零 `prisma.account.*`/`prisma.refreshToken.*`（仅 `prisma.marketPreference.*`）；无 R2/R3（无跨 ctx 业务调用）；guard 复用经 `AccountModule` export（非业务调用，无注释）；`check-server-moat.ts` 关 |
| V. 类型同步链 Nx-driven                            | ✅   | server swagger → `nx run server:export-openapi` → `nx affected -t generate`（Orval）→ api-client typed → mobile 消费                                                                  |

## Architecture Notes _(mandatory)_

### Bounded Context 决策（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 questions，逐条）

| Q   | 问题                                             | 判定                                                                                                          |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Q1  | 直改 account/credential 核心表 row state？       | **No** — market_preference 是新表，仅逻辑引用 accountId，**不写 account 表**（spec Key Entities 明示）         |
| Q2  | 编排多 context user-facing 流程？                | **No** — 单一领域（市场偏好），accountId 取自 JWT sub（经 guard），无跨 ctx 编排                              |
| Q3  | 纯 platform infra？                              | **No** — 业务领域（投资/portfolio）                                                                          |
| Q4  | 完全新业务领域，3 现 ctx 都不沾？               | **YES → STOP，新 bounded context** `portfolio`（第 4 个，与 security/account/auth 平级）                     |
| Q5-Q7 | 跨 ctx call 传播？                            | **N/A** — portfolio 无跨 ctx 业务调用。guard 复用是 account-bound 鉴权 artefact（`AccountModule` export），非 use case 调用，不触发 R2/R3 |

**ADR-0032 sunset trigger 评估**：portfolio 是首个非 auth/account/security 业务领域（投资管理），spec User Scenarios 6 个 + 后续 PRD 02/04（券商账户 / 自选）都依赖 portfolio server → 立第 4 个 top-level bounded context 是正确粒度（非 over-split：投资域独立于身份/账户域）。后续 portfolio 内若 > 30 模块或 > 50K LOC 再评估 sub-context 拆分（ADR-0032 frontmatter sunset_trigger）。

### Portfolio module 落位（per catalog，ship 时新增 Operation 行）

| 操作                       | context       | 类型              | 跨 ctx | 备注                                                                                          |
| -------------------------- | ------------- | ----------------- | ------ | -------------------------------------------------------------------------------------------- |
| `get-market-preferences`   | **portfolio** | intra query UC    | —      | authed；读 `market_preference` 行（R1 自己的表）→ 无记录则投影默认 → merge 静态字典 9 行返回 |
| `update-market-preference` | **portfolio** | intra write UC（持 tx） | —      | authed；tx 内 materialize-on-first-write + min-1（FOR UPDATE 串行化）+ 海外拒绝；写自己的表 R1 |

### Server side（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) 扁平贫血，文件平铺于 `apps/server/src/portfolio/`）

**新增（portfolio 新 module）**：

- `portfolio.module.ts`：`imports: [SecurityModule, AccountModule]`（前者给 PrismaService + 全局 ProblemDetailFilter + JwtModule；后者 export `JwtAuthGuard` + `AccountIdThrottlerGuard`）；`controllers: [MarketPreferencesController]`；`providers: [GetMarketPreferencesUseCase, UpdateMarketPreferenceUseCase]`
- `market-preferences.controller.ts`（`@Controller('v1/portfolio/market-preferences')`，`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`）：`GET`（EP1）+ `PUT :market`（EP2）+ named throttler config（`@Throttle` 自己 + `@SkipThrottle` 其余全部桶）+ swagger（200/400/401/422/404/429）
- `get-market-preferences.usecase.ts`（intra query）：`prisma.marketPreference.findMany({where:{accountId}})` → 0 行 → 投影默认 `{CNY:active, HKD/USD:inactive}`；≥1 行 → 读 3 核心行 → 调 `portfolio.rules.ts` `projectMarkets(rows)` merge 静态 `MARKET_CATALOG` 9 行（含 group/iso/v1Available）→ response
- `update-market-preference.usecase.ts`（intra 写，**持 tx**）：① 字典校验：未知码 → 404 `MARKET_NOT_FOUND`；海外码 → 422 `MARKET_NOT_AVAILABLE`（FR-S05）。② `$transaction`(READ COMMITTED)：`SELECT ... WHERE accountId AND market IN (CNY,HKD,USD) FOR UPDATE`（串行化同账号并发 toggle，per § 并发策略）→ 无行则 INSERT 3 核心默认行（materialize-on-first-write）→ 计算 toggle 后激活集 → 归 0 → 422 `MIN_ONE_MARKET_REQUIRED`（FR-S04）→ 否则 `update` 目标行 active → 返回全量 9 市场态（EP2 复用 get 投影逻辑）
- `market-catalog.ts`：静态常量 `MARKET_CATALOG`（9 市场 `{ marketCode, displayName, isoCurrency, group, v1Available, order }`，FR-S06 真相源）+ `CORE_MARKETS`/`OVERSEAS_MARKETS` 派生集 + `isCoreMarket(code)` / `isKnownMarket(code)` 谓词
- `portfolio.rules.ts`（纯函数不变量，per ADR-0043 §4）：`projectMarkets(rows)` / `countActiveCore(rows)` / `wouldViolateMinOne(rows, market, active)`
- `market-preferences.response.ts`：`MarketPreferencesResponse{ markets: MarketItem[] }` + `MarketItem`（swagger 装饰器）
- `update-market-preference.request.ts`：`{ active: boolean }`（class-validator `@IsBoolean()`）
- 3 exception：`min-one-market-required.exception.ts`（422）/ `market-not-available.exception.ts`（422）/ `market-not-found.exception.ts`（404），镜像 `auth-attempt-locked.exception.ts`（HttpException 子类 + RFC 9457 extension）

**修改既有（platform / cross-cutting）**：

- `apps/server/prisma/schema.prisma`：`datasource db.schemas` 加 `"portfolio"`；新 `model MarketPreference`（见 § Prisma schema）
- 新 migration `<yyyymmddhhmm>_add_portfolio_market_preference`（**expand-only**，create schema + table + unique index，非破坏性 → 单 PR 合规，per [ADR-0035](../../docs/adr/0035-data-layer-governance.md) / migration-rules）
- `apps/server/src/security/throttler-skip-buckets.ts`：加 `MARKET_PREF_BUCKETS`（`mkt-pref-get-account`/`mkt-pref-put-account`，read/write 各一，FR-S08；tracker = JWT sub 经 `AccountIdThrottlerGuard`）+ `MARKET_PREF_ALL`
- `apps/server/src/auth/auth.module.ts`：**全局 ThrottlerModule 注册处**（`forRootAsync`，所有 feature 的 named throttler 集中于此）→ 加 portfolio 2 named throttler
- **所有既有 controller**（account-profile / device-management / account-deletion / token / sms）：`@SkipThrottle` 列表 spread `...MARKET_PREF_ALL`（throttler 反污染纪律：每新增桶，既有路由必跳过，per skip-buckets 文件注；004 5→17 桶同款成本）
- `apps/server/src/app/app.module.ts`：`imports` 加 `PortfolioModule`（当前仅 import AuthModule 传递，portfolio 是新 top-level 需显式注册）
- `apps/server/eslint.config.mjs`：`boundaries/elements` 加 `{ type: 'portfolio', pattern: 'src/portfolio/**' }`；`boundaries/dependencies` rules 加 `security` / `account` / `auth` disallow `portfolio`（base/中层/编排层都不依赖 portfolio，保 portfolio 为叶子）+ portfolio disallow `auth`（portfolio 仅依赖 security + account，不依赖编排层）
- `scripts/checks/check-server-moat.ts`：`MODEL_OWNERSHIP` 加 `marketPreference: 'portfolio'`（**否则探针 `moat-unmapped` 硬拒——portfolio UC 读自己的表都会因 owner 未声明报错**，per 探针 defense-in-depth 设计）+ `BUSINESS_CTX` 加 `'portfolio'`（per 文件约定「新 bounded context 同步加入」；011 无跨 ctx 构造器注入故 Check 2 对 portfolio 暂无违规，但约定要求 + 后续 PRD 02 跨 ctx 注入需此登记）

### Prisma schema（新表）

```prisma
// datasource: schemas = ["account", "portfolio", "public"]
model MarketPreference {
  id        BigInt   @id @default(autoincrement())
  accountId BigInt   @map("account_id")          // 逻辑引用 JWT sub，无跨 schema FK（同 refresh_token）
  market    String   @db.VarChar(8)              // 核心市场码 CNY/HKD/USD（海外不入库）
  active    Boolean
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@unique([accountId, market], map: "uk_market_preference_account_market")
  @@map("market_preference")
  @@schema("portfolio")
}
```

- 贫血 row + `@map` snake_case（per [feedback raw-prisma-row-with-map](../../)，无 Entity Mapper）。null 不出现（active not-null，新用户=无行非 null 行）。
- 数据规模 ≤ 3 行/用户（仅核心激活态），无额外索引需求（unique 即查询路径）。

### 并发 / 事务策略（FR-S04 min-1 跨行不变性）

> **核心决策（D1）**：min-1 是**跨行不变性**（核心激活数 count across ≤3 行），≠ 单行条件更新。采用 **READ COMMITTED tx + `SELECT ... FOR UPDATE` 锁定账号核心行集**串行化同账号并发 toggle，**不用 SERIALIZABLE**（避免 SSI 序列化失败 retry 机制 + memory `prisma_serializable_p2002_and_p2034` 警示 Prisma 7 P2034 现为 `DriverAdapterError(code=undefined)` 检测漏洞）。

1. **为何不能 READ COMMITTED + 单条件 UPDATE**：两端并发关不同市场（CNY off / HKD off），各自单语句快照都见对方仍 active → EXISTS 子查询均 true → 均成功 → 0 激活。READ COMMITTED 跨不同行不阻塞 → 竞态不可防。
2. **FOR UPDATE 串行化**：tx 起手 `SELECT ... WHERE accountId AND market IN (CNY,HKD,USD) FOR UPDATE` 锁定该账号 ≤3 核心行 → 同账号第二个 toggle tx 阻塞至第一个 commit → 顺序执行，每个都见最新 committed 激活集 → min-1 判定正确。行集极小（≤3）、per-account scope → 锁竞争可忽略。
3. **materialize-on-first-write**：新用户无行时 GET 走投影（FR-S01 零写库）；首次 PUT 在 tx 内 INSERT 3 核心默认行（CNY:active, HKD/USD:inactive）再 apply toggle → 此后 3 行恒在，min-1 = count active among 3 行（投影只剩"从未写过"账号路径）。
4. **幂等**：PUT 目标已是目标态 → tx 内 update 0 变更 → 200 全量态（FR Edge：幂等）。
5. **历史脏数据防御**：海外码即使误入库，读侧按 `MARKET_CATALOG` v1Available=false 强制呈现 inactive（FR Edge）。

### 限流配置（FR-S08，复用 throttler infra + AccountIdThrottlerGuard）

| 端点                       | per-account | 实现                                                       |
| -------------------------- | ----------- | -------------------------------------------------------- |
| get-market-preferences     | `60/60s`    | named `mkt-pref-get-account`（AccountIdThrottlerGuard）  |
| update-market-preference   | `30/60s`    | named `mkt-pref-put-account`                             |

两端点 authed（有 accountId）→ 复用 `AccountIdThrottlerGuard`，**无需** public IP 桶。阈值参照 002 /me（60/10）调高写侧（toggle 交互可能连点）。`@SkipThrottle` 其余全部桶防污染。← 阈值 tasks gate review（D3）。

### Mobile side（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) strangler-fig + [mobile-impl-playbook](../../docs/conventions/mobile-impl-playbook.md)）

**新增 feature dir `apps/mobile/src/portfolio/`**（per [business-naming](../../docs/conventions/business-naming.md) frontend feature 目录）：

- `use-market-preferences.ts`：包 orval 生成 hook（`usePortfolioControllerGetMarketPreferences` query + `usePortfolioControllerUpdateMarketPreference` mutation）；乐观更新 + 响应对账 + 失败回弹 + min-1 客户端预判（持当前激活集，关最后一个激活核心市场 → 直接拦截弹回 + 轻提示，**不发 PUT**，per spec Clarifications informed-default）；错误分流（422 min-1 / 通用网络错，复用 `~/core/api/errors.ts` guard 体例）
- `market-row.tsx`：单市场行（label `市场名（ISO）` + 右 `Switch`；海外行 disabled 置灰 + 「即将支持」副文案；a11y `accessibilityRole='switch'` + `accessibilityState.checked/disabled`）
- `stock-market-screen.tsx`：屏组件（分组标题核心/海外 + 9 行 + loading/retry 态 + min-1 轻提示 toast/inline）
- `market-copy.ts`：中文文案常量（标题「证券市场」/「核心」/「海外」/「即将支持」/「至少保留一个激活市场」）

**新增 `~/ui` 原语**：

- `Switch.tsx`：基于 RN 原生 `Switch` 包装，ON 色 = `brand-500`（mockup 定稿蓝，`trackColor`/`thumbColor` 用 `~/theme` tokens，**0 新增 token / 0 hex 字面量**，SC-M06）；`disabled` 态置灰；presentational 无单测（per mono 测试分层，typecheck/lint 即可）
- `index.ts` barrel 加 `Switch` 导出

**新增 Expo route + settings 入口**（per [reference expo-router-app-route-scan](../../)）：

- `app/(app)/settings/stock-market.tsx`：薄 route，import `StockMarketScreen` from `~/portfolio`。**注意：`app/(app)/settings/` route group 已存在**（`index.tsx` 设置菜单 + `_layout.tsx` Stack + `account-security/` 子树）——本页是该 stack 新增 screen，**非"首次创建"**（修正原误判）。
- `app/(app)/settings/_layout.tsx`：新增 `<Stack.Screen name="stock-market" options={{ title: '证券市场', headerLeft: makeHeaderBackOrParent('/(app)/settings') }}/>`（沿用既有 header 体例，避免默认无返回 header）。
- `app/(app)/settings/index.tsx`：新增一个**独立 `<Card>`**（与现有"账号/通用/通知""隐私/关于""登出"各 Card 平级，per 用户 D5 截图——富途牛牛第二区块样式），内含 `<Row label="证券市场" onPress={→ /(app)/settings/stock-market} />` + `<Row label="券商账户" disabled />`（PRD 02 占位，镜像现有 通用/通知 disabled 行）。
- 入口文案（投资设置 Card 标题 / Row label）进 `~/settings` copy 或 `market-copy.ts`（mockup/copy 定）。Playwright 冒烟经真实入口（tap 证券市场 Row）或 `goto /settings/stock-market`（web 剥 route group 段），并断言该 Card + 两 Row 渲染。

### Cross-cutting

- **同步链**（Constitution V，per [api-contract-trigger](../../)）：server controller/DTO/swagger → `nx run server:export-openapi` → `nx affected -t generate`（orval regen api-client portfolio 端点 hook）→ mobile 消费 typed hook。
- **catalog 更新**：ship 时 `server-bounded-context-catalog.md` § Operation Catalog 新增 2 行（get/update market-preferences，context=portfolio，propagation=intra）。
- **跨 ctx 注释**：portfolio **无** R2/R3 业务调用 → 无 `// CROSS-CONTEXT-SYNC/ASYNC` 注释。guard 经 `AccountModule` export 复用（account-bound 鉴权 artefact，非业务 use case）→ 镜像 auth 复用 guard 的现状，无注释；`check-server-moat.ts` 探针验 portfolio 内零 `prisma.<otherTable>.*`（**前提：先在探针 `MODEL_OWNERSHIP` 登记 `marketPreference: 'portfolio'` + `BUSINESS_CTX` 加 `portfolio`，见 § 修改既有；不登记则 portfolio 读自己的表即 `moat-unmapped` 红**）。
- **反枚举不变性**：GET/PUT 未认证/非 ACTIVE → 统一 401（JwtAuthGuard，与 /me 一致路径），grep 字节级一致（剥 traceId）。
- **视觉 0 硬编码**（SC-M06）：mobile 实现文件 grep 无 theme token 外 hex/rgb 字面量。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| #      | 决策                       | 结论                                                                                                                                                                                          | gate? |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **D1** | min-1 并发原语             | **READ COMMITTED + `SELECT FOR UPDATE` 锁账号核心行集**（≤3 行串行化同账号 toggle）。拒 SERIALIZABLE（SSI 假冲突 + Prisma 7 P2034 检测漏洞）。配 materialize-on-first-write（首 PUT 落 3 默认行） | ⚠️    |
| **D2** | min-1 / 海外拒绝 HTTP 码   | **422 Unprocessable Entity**（业务不变性违反，区别于 400 格式错）；`MARKET_NOT_FOUND`=404。新增 3 业务 code                                                                                  | ⚠️    |
| **D3** | 限流阈值                   | get `60/60s` · put `30/60s`（per-account，复用 AccountIdThrottlerGuard，无 IP 桶）                                                                                                          | ⚠️    |
| **D4** | 读侧默认存储时机           | **GET 零写库**（投影默认）；首次 **PUT** materialize 3 核心行（对齐 spec FR-S01「GET 不产生写库副作用」）                                                                                    | —     |
| **D5** | settings 入口 IA（用户已定）| **settings/index.tsx 新增独立投资设置 Card**（与账号/通知、隐私/关于、登出各 Card 平级，per 用户截图）：内放 `证券市场` Row（→ stock-market 页，live）+ `券商账户` Row（disabled 占位，PRD 02 落地再接）。修正原"settings 壳未建/入口出 scope"误判（壳已存在含 6+ 真实页）。本 feature 交付 route + 屏 + 该入口 Card。 | ✅    |
| **D6** | min-1 客户端反馈           | **客户端预判拦截 + server 兜底**（spec clarify informed-default 已定）：持当前激活集，关最后一个 → 弹回 + 提示不发 PUT；server FR-S04 最终真相防多端竞态                                       | —     |
| **D7** | EP2 响应粒度               | 返回**全量** 9 市场态（非单行），客户端直接对账乐观更新                                                                                                                                      | —     |
| **Perf** | 2 端点 P95/P99           | EP1 GET `80/150` · EP2 PUT `120/250`（spec frontmatter SoT；≤3 行 + 内存字典 merge，无瓶颈）                                                                                                | —     |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| —         | —          | —                                    |

**Note**：(1) **新 portfolio bounded context** 是 Q4 判定的正确粒度（首个投资域，后续 PRD 02/04 依赖），非 over-split。(2) **materialize-on-first-write** 比"纯投影 + 跨投影 min-1 计算"简单（min-1 始终对 3 实体行 count，逻辑直白）。(3) **FOR UPDATE 串行化**比 SERIALIZABLE retry 机制简单且规避 Prisma 7 P2034 检测漏洞，行集 ≤3 锁成本可忽略。(4) **throttler 桶 spread skip 既有 controller** 是既有全局 ThrottlerModule 设计的固有成本（非本 feature 引入），沿 004/005 同款。整体复杂度低于 005（无 ip2region 资产 / 无 outbox 事件 / 无 scheduler）。

## Performance Budget

| Endpoint                                            | P95 (ms) | P99 (ms) |
| -------------------------------------------------- | -------: | -------: |
| `GET /api/v1/portfolio/market-preferences`          |       80 |      150 |
| `PUT /api/v1/portfolio/market-preferences/{market}` |      120 |      250 |

_perf 预算 SoT = spec.md frontmatter `perf_budgets`。≤3 行查询 + 内存字典 merge（μs 级），无瓶颈。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review）

**两段式 PR**（推荐，契合类 2「UI impl 定稿前补真后端冒烟」+ Constitution V 同步链）：

- **PR1（server，feat(portfolio)）**：portfolio module bootstrap（schema + migration + boundaries + 2 UC + controller + 字典 + rules + throttler）+ IT + contract regen（api-client portfolio hook，mobile 暂不消费，同 005 先 regen 供后续）。ships 真后端。
- **PR2（mobile，feat(portfolio)）**：`src/portfolio/` feature + `~/ui` Switch + Expo route + 屏 + vitest 逻辑分流 + Playwright 真后端冒烟（against PR1 已 ship server）。

> **user 定（2026-06-01）= 两段式**。Constitution §V 字面「server impl + api-client regen + mobile 消费 **同 PR**」之**刻意例外**：§V 防的是类型同步链 drift——本拆分 api-client regen 在 **PR1 已 committed/merged**，PR2 消费**已落地**的 typed client → drift 风险已消解（沿 005 先例 regen-ships-with-server）。**PR1 描述须 cite 此 §V 例外**。

### 建议 tasks.md 层级（每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）

**Server（PR1）**：

- `[Server]` schema + migration：`MarketPreference` model + datasource schemas 加 portfolio + expand-only migration（create schema/table/unique）+ `prisma generate` gate + seed 不需要（无静态种子，字典是代码常量）
- `[Server]` boundaries + moat 登记：eslint.config.mjs 加 portfolio element + dependency rules（portfolio→{security,account}；security/account/**auth** 禁→portfolio，保叶子）+ `check-server-moat.ts` `MODEL_OWNERSHIP` 加 `marketPreference:'portfolio'` + `BUSINESS_CTX` 加 `portfolio` + verify `nx lint server` 0 violation & `pnpm tsx scripts/checks/check-server-moat.ts` 关
- `[Server]` 字典 + rules：`market-catalog.ts`（9 市场常量 + 谓词）+ `portfolio.rules.ts`（projectMarkets/countActiveCore/wouldViolateMinOne）+ 纯函数单测（vitest，无 DB）
- `[Server]` get UC：`get-market-preferences.usecase.ts` + response DTO + 单测（Testcontainers PG：新用户投影默认 / 老用户持久化态 / 海外元信息 v1Available=false / GET 零写库副作用）
- `[Server]` update UC：`update-market-preference.usecase.ts`（持 tx + FOR UPDATE + materialize + min-1 + 海外拒绝）+ 3 exception + request DTO + 单测（Testcontainers PG：toggle on/off / min-1 拒绝单激活 / 多激活可关 / 海外 422 / 未知码 404 / 幂等 / materialize 首写）
- `[Server]` controller + module：`market-preferences.controller.ts`（GET+PUT，JwtAuthGuard+AccountIdThrottlerGuard，swagger 200/400/401/422/404/429）+ named throttler 2 桶 + `portfolio.module.ts` + app.module 注册 + throttler-skip-buckets 加组 + 既有 controller spread skip + 单测
- `[Server-IT]`（Testcontainers PG 全 boot）：
  - US1 GET：新账号投影默认 / 预置态读回 / 海外元信息 / 401 反枚举
  - US2 PUT：港股开 → 200 持久化 / 关 CNY(多激活)成功 / 关最后一个 → 422 MIN_ONE_MARKET_REQUIRED 态不变 / 海外 → 422 MARKET_NOT_AVAILABLE 不持久化 / 未知码 404 / 幂等
  - US2 并发：N 端并发关不同核心市场 → FOR UPDATE 串行化 → 恰保留 ≥1 激活（无 0 激活中间态，SC-M03 server 侧锚）
  - 限流：2 桶边界（get 61/put 31）→ 429
- `[Contract]`：`nx run server:export-openapi` → `nx affected -t generate`（orval regen portfolio hook）+ api-client/mobile typecheck 绿
- `[Verify]`：`nx affected -t lint typecheck test build --base=origin/main` 全绿 + catalog 2 Operation 行 + boundaries 0 违规 + `check-server-moat.ts` 关

**Mobile（PR2）**：

- `[Mobile]` Switch 原语：`~/ui/Switch.tsx`（RN 原生 Switch 包装，brand-500 ON 色，disabled 态，0 hex）+ barrel 导出 + typecheck/lint（无单测，presentational）
- `[Mobile]` hook：`src/portfolio/use-market-preferences.ts`（orval query+mutation 包装 + 乐观更新 + 对账 + 失败回弹 + min-1 客户端预判 + 错误分流）+ vitest 逻辑分流单测（helper-level：min-1 预判拦截不发 PUT / 失败回弹 / 422 vs 网络错分流）
- `[Mobile]` 屏 + 行 + route + settings 入口：`market-row.tsx` + `stock-market-screen.tsx` + `market-copy.ts` + `app/(app)/settings/stock-market.tsx` route + `settings/_layout.tsx` 注册 Screen + `settings/index.tsx` 新增投资设置 Card（证券市场 live + 券商账户 disabled 占位）+ typecheck/lint
- `[Mobile-E2E]`（Playwright Expo Web，真后端冒烟 per 纪律②）：登录 → 进设置断言投资设置 Card（证券市场 Row + 券商账户 disabled）→ tap 证券市场进入页 → 断言 9 行/2 组/顺序/ISO label/默认 toggle 态（US3）→ 切港股 ON → 重进确认持久化（US4）→ 关最后一个激活 → 弹回 + 提示（US5）→ 海外行点击零副作用（US6）→ 截图归档 `runtime-debug/2026-05-XX-stock-market-access/`

预估 task 数：PR1 ~9-11（server）+ PR2 ~4-5（mobile）= **~13-16**。**复杂度低于 005**（无二进制资产 / 无 outbox / 无 scheduler）；主要新点 = 第 4 bounded context bootstrap + min-1 跨行不变性并发 + mobile Switch 原语。

---

**Plan Version**: 1.0.0 | **Created**: 2026-05-29 | **ID-namespace**: US1-6 / FR-S01..S10 / FR-M01..M09 / SC-S01..S06 / SC-M01..M06
