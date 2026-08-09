---
feature_id: 012-broker-account-binding
spec_ref: ./spec.md
status: done
created_at: '2026-06-02'
updated_at: '2026-06-02'
adr_refs: ['0019', '0024', '0032', '0035', '0038', '0041', '0043']
context7_verified: []
---

# Implementation Plan: 012-broker-account-binding（券商账户绑定 — 持仓归属字典池）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `012-broker-account-binding` | **PRD**: [portfolio-02](../../docs/prd/portfolio/portfolio-02-broker-account-binding-prd.md) | **Mockup baseline**: [`design/handoff-claude-design/BrokerFlow.jsx`](./design/handoff-claude-design/)（页 A/B/C + A→B→C→B→A 实机流；底部 sheet + 左滑 84px err 删除 + A-Z 索引 + 12 券商字典 + maskCust 前4后4）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**。
> **类 2 流程**（per spec § 流程 OVERRIDE）：spec ✅ → clarify ✅ → mockup ✅ → **plan（本）** → tasks → impl。本 plan **含完整 UI 段**（mockup 已定稿）。纪律②：UI impl 定稿前补一次真后端冒烟（Playwright Expo Web）。

## Summary _(mandatory)_

02 = **portfolio 第二特性**：3 server UC + mobile 三页流转。①**ListBrokerAccounts**（authed：默认账户读侧虚拟置顶 + 本账号已绑券商按 createdAt；返 raw clientNo，前端脱敏）②**BindBrokerAccount**（authed：brokerCode∈字典 + clientNo trim 非空 + 禁控制字符校验 + 唯一性 `accountId+brokerCode+clientNo`，dup → 4xx；持久化）③**DeleteBrokerAccount**（authed：删本账号已绑券商；默认账户不可删 4xx；他人/不存在 → 字节级一致 404 反枚举；V1 仅删行，归属回落语义留 import 落地）。④**mobile 三页**（页 A 列表含左滑删除 + 二次确认；页 B 绑定表单；页 C 底部 sheet 券商选择含搜索 + A-Z 索引）+ 5 新 UI 原语 + 客户端脱敏。

**范式** = ADR-0043 扁平贫血 + 单向 Moat。**复用 011 已立基础设施**：portfolio bounded context（module + Prisma `portfolio` schema + ESLint 单向边界 + moat 探针 `BUSINESS_CTX` 已含 portfolio）。**新增** = portfolio 内 `broker_account` **多行**表（≠ 011 `portfolio_preference` 单行 array 模型）+ 静态券商字典常量 + mobile 5 个新组件（`SwipeRow` / `SearchBar` / `BrokerPickerSheet` / `AlphaIndex` / `ConfirmModal`）。**无 outbox 事件**（FR-S06 归属回落真转移留 import 特性，本 feature 不建空 seam）。

**bounded context（per [catalog](../../docs/conventions/server-bounded-context-catalog.md)）**：**portfolio**（011 已立第 4 ctx，本特性**复用不新立**）自持 `broker_account` 表（贫血 row + `portfolio.rules.ts` 纯函数校验）+ 静态券商字典；3 UC 直注 `PrismaService` 读写**自己** ctx 的表（R1，无 repository port）。**零跨 ctx 业务调用**（无 R2/R3）——唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（`AccountModule` 已 export，account-bound 鉴权 artefact，非业务 use case 调用，无注释要求，镜像 011）。`broker_account.accountId` 仅逻辑引用 JWT sub（默认账户种子），**不读写 account 表**（与 `portfolio_preference` 同款无跨 schema FK）。

## API Contracts _(mandatory)_

| #   | Method | Path                                       | Auth   | Request                                     | Response                                                                                | trace FR               |
| --- | ------ | ------------------------------------------ | ------ | ------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------- |
| EP1 | GET    | `/api/v1/portfolio/broker-accounts`        | bearer | —                                           | **200** `BrokerAccountListResponse{accounts[]}`（默认置顶 + 已绑）/ 401 / 429            | FR-S01, FR-S07, FR-S09 |
| EP2 | POST   | `/api/v1/portfolio/broker-accounts`        | bearer | `{ brokerCode: string, clientNo: string }`  | **201** `BrokerAccountItem` / 400 `FORM_VALIDATION` / 409 `BROKER_ACCOUNT_DUPLICATE` / 401 / 429 | FR-S02, FR-S03, FR-S07 |
| EP3 | DELETE | `/api/v1/portfolio/broker-accounts/{id}`   | bearer | path `id`（BigInt as string）               | **204** / 400 `DEFAULT_ACCOUNT_NOT_DELETABLE` / 404（反枚举）/ 401 / 429                 | FR-S04, FR-S05, FR-S06 |

- `BrokerAccountItem` = `{ id, brokerCode, brokerName, clientNo, isDefault, createdAt }`（**raw clientNo**，per FR-S07 server 返明文、客户端脱敏，仿 002 phone）。默认账户条目 = `{ id: <accountId>, brokerCode: null, brokerName: '默认账户', clientNo: null, isDefault: true, createdAt: null }`（读侧虚拟派生，OQ3）。
- EP1 `accounts[]`：默认账户恒置顶（index 0）+ 已绑券商按 `createdAt` 升序。仅本账号（`where accountId = jwt.sub`）。
- 错误一律 RFC 9457 ProblemDetail（复用 001 全局 filter，per [ADR-0038](../../docs/adr/0038-error-handling-ux-contract.md)）；新增 code：`BROKER_ACCOUNT_DUPLICATE`（**409 Conflict**，唯一键冲突）/ `DEFAULT_ACCOUNT_NOT_DELETABLE`（**400**，系统账户不可删）。校验失败（brokerCode 不在字典 / clientNo trim 后空 / clientNo 含禁字符）→ 复用既有 `FORM_VALIDATION`（400，message 区分）。401 沿用既有 `JwtAuthGuard`（反枚举不区分原因）。404 = 默认 ProblemDetail（不区分 not-found / others'-account，字节级一致）。
- **HTTP 码定稿（D2）**：dup 用 **409 Conflict**（资源唯一性冲突的语义标准，区别于 011 min-1 用的 422 业务不变性）；默认不可删用 **400**（系统约束拒绝，非 404，per FR-S04 明示「系统账户不可删」需可感知，与「不存在」的 404 反枚举语义分离）。← tasks gate review。
- 路径前缀 `api`（全局）。端点路径为 spec 提案，OpenAPI code-first contract 阶段（swagger 装饰器）定稿。**券商字典不设独立端点**（D5：client-bundled，见 § 券商字典落位）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`）           | 状态 | 备注                                                                                                                                                                                  |
| --------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. SDD（NON-NEGOTIABLE）                            | ✅   | spec ✅ → clarify ✅ → mockup ✅（类 2）→ plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点                                                                               |
| II. Test-First TDD（NON-NEGOTIABLE）               | ✅   | 每 impl task 红→绿→typecheck/lint→`[X]`→commit；dup 唯一约束 / 默认不可删 / 反枚举 404 字节级 / clientNo 禁字符 / 跨账号隔离 均专测（Testcontainers PG）；mobile 逻辑分流 vitest + UI Playwright |
| III. Atomic 30min-2h + 独立 commit                 | ✅   | tasks.md 按此拆；server PR + mobile PR 两段（见 § Phase 2 准备 PR 策略）                                                                                                              |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅   | 复用 011 `portfolio` ctx；单向 `portfolio → {security, account}`；portfolio 内零 `prisma.account.*`（仅 `prisma.brokerAccount.*`）；无 R2/R3；guard 复用经 `AccountModule` export（非业务调用）；`check-server-moat.ts` 加 `brokerAccount:'portfolio'` 后关 |
| V. 类型同步链 Nx-driven                            | ✅   | server swagger → `nx run server:export-openapi` → `nx affected -t generate`（Orval）→ api-client typed → mobile 消费；两段式 PR（PR1 server+regen 先 merge / PR2 mobile 消费）         |

## Architecture Notes _(mandatory)_

### Bounded Context 决策（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 questions）

**复用 011 已立 `portfolio` ctx，不新立**。逐条：

| Q   | 问题                                             | 判定                                                                                                          |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Q1  | 直改 account/credential 核心表 row state？       | **No** — broker_account 是 portfolio 内新表，仅逻辑引用 accountId 作默认账户种子，**不写 account 表**（FR-S12 明示）|
| Q2  | 编排多 context user-facing 流程？                | **No** — 单一领域（持仓归属登记），accountId 取自 JWT sub（经 guard），无跨 ctx 编排                          |
| Q3  | 纯 platform infra？                              | **No** — 业务领域（投资/portfolio）                                                                          |
| Q4  | 完全新业务领域？                                 | **No** — portfolio 已于 011 立为第 4 ctx；券商账户是其内第二组 operation（同投资域），**不触发新 ctx 评估**   |
| Q5-Q7 | 跨 ctx call 传播？                            | **N/A** — portfolio 无跨 ctx 业务调用。guard 复用是 account-bound 鉴权 artefact，非 use case 调用，不触发 R2/R3 |

### Portfolio module 新增 Operation（per catalog，ship 时新增 3 行）

| 操作                       | context       | 类型                | 跨 ctx | 备注                                                                                          |
| -------------------------- | ------------- | ------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `list-broker-accounts`     | **portfolio** | intra query UC      | —      | authed；读 `broker_account` 本账号行（R1）→ 默认账户虚拟置顶 → merge brokerName 返回           |
| `bind-broker-account`      | **portfolio** | intra write UC      | —      | authed；字典校验 + clientNo normalize + insert（唯一约束兜底 dup → 409，无 FOR UPDATE）        |
| `delete-broker-account`    | **portfolio** | intra write UC      | —      | authed；scoped delete by id → affected-count 分流（204/默认 400/404 反枚举）                   |

### Server side（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) 扁平贫血，文件平铺于 `apps/server/src/portfolio/`）

**新增（portfolio 内新文件，与既有 market-preferences 平铺同级）**：

- `broker-accounts.controller.ts`（`@Controller('v1/portfolio/broker-accounts')`，`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`）：`GET`（EP1）+ `POST`（EP2）+ `DELETE :id`（EP3）+ named throttler config（`@Throttle` 自己 3 桶 + `@SkipThrottle` 其余全部桶含 011 market-pref 桶）+ swagger（200/201/204/400/401/404/409/429）
- `list-broker-accounts.usecase.ts`（intra query）：`prisma.brokerAccount.findMany({where:{accountId}, orderBy:{createdAt:'asc'}})` → 调 `portfolio.rules.ts` `buildBrokerAccountList(rows, accountId)` 合成默认账户置顶 + merge brokerName → response
- `bind-broker-account.usecase.ts`（intra 写）：① 字典校验：`brokerCode` 不在 `BROKER_CATALOG` → 400 `FORM_VALIDATION`（未知券商）。② `normalizeClientNo(raw)`（trim + 禁控制/零宽/行分隔符，trim 后空 → 400 `FORM_VALIDATION`）。③ `prisma.brokerAccount.create(...)`；catch Prisma P2002（唯一约束 `accountId+brokerCode+clientNo`）→ 409 `BROKER_ACCOUNT_DUPLICATE`（**无 FOR UPDATE / 无预查重**，唯一索引是并发兜底的串行点，per § 并发策略）→ 201 返回新行
- `delete-broker-account.usecase.ts`（intra 写）：scoped delete 顺序消除 id 碰撞歧义（见 § 删除逻辑）：`prisma.brokerAccount.deleteMany({where:{id, accountId}})` → `count===1` → 204；`count===0 && id===accountId`（默认账户虚拟 id = 自己的 account id）→ 400 `DEFAULT_ACCOUNT_NOT_DELETABLE`；否则 → 404（字节级一致反枚举）
- `broker-catalog.ts`：**server 校验副本**——静态 `BROKER_CATALOG`（12 券商 `{ brokerCode, brokerName }`，mockup 定：东方财富/广发/国泰君安/国信/海通/华泰/平安/申万宏源/银河/招商/中信/中金）+ `isKnownBroker(code)` 谓词 + `brokerName(code)` 查名。**仅 code+name**（pinyinInitials/logo 是 client-only，见 § 券商字典落位）
- `portfolio.rules.ts`（**修改既有** 011 文件，加纯函数）：`normalizeClientNo(raw)`（trim + 禁字符 deny-list，**镜像 002 `account.rules.ts` `normalizeDisplayName` 同款 `[\x00-\x1F\x7F\u200B-\u200F\uFEFF\u2028\u2029]` deny-list 正则**——跨 ctx 不 import account.rules（边界），portfolio 自带同款常量，镜像「bio 复用 displayName deny-list」的同 ctx 模式；clientNo 不强制格式、不限长上限，per FR-S07 宽松）+ `buildBrokerAccountList(rows, accountId)`（合成默认账户置顶条目 + merge brokerName）
- `broker-account-list.response.ts` / `broker-account-item.response.ts`：`BrokerAccountListResponse{ accounts: BrokerAccountItem[] }` + `BrokerAccountItem`（swagger 装饰器；`clientNo` nullable、`brokerCode` nullable——默认账户两者 null）
- `bind-broker-account.request.ts`：`{ brokerCode: string, clientNo: string }`（class-validator `@IsString()` + `@IsNotEmpty()`；深度校验在 UC 内 rules）
- 2 exception：`broker-account-duplicate.exception.ts`（409）/ `default-account-not-deletable.exception.ts`（400），镜像 011 `market-not-available.exception.ts`（HttpException 子类 + RFC 9457 extension）

**修改既有（platform / cross-cutting）**：

- `apps/server/prisma/schema.prisma`：新 `model BrokerAccount`（见 § Prisma schema）。**`datasource db.schemas` 已含 `"portfolio"`（011 立），无需改**。
- 新 migration `<yyyymmddhhmm>_add_portfolio_broker_account`（**expand-only**，create table + unique index，非破坏性 → 单 PR 合规，per [ADR-0035](../../docs/adr/0035-data-layer-governance.md) / migration-rules）
- `apps/server/src/security/throttler-skip-buckets.ts`：加 `BROKER_ACCT_BUCKETS`（`broker-acct-get-account`/`broker-acct-post-account`/`broker-acct-delete-account`，tracker = JWT sub 经 `AccountIdThrottlerGuard`）+ `BROKER_ACCT_ALL`
- `apps/server/src/auth/auth.module.ts`：全局 ThrottlerModule 注册处加 portfolio broker 3 named throttler（镜像既有 `MARKET_PREF_THROTTLERS`）
- **既有所有 controller**（account-profile / device-management / account-deletion / token / sms / **011 market-preferences**）：`@SkipThrottle` 列表 spread `...BROKER_ACCT_ALL`（throttler 反污染纪律：每新增桶，既有路由必跳过）；新 broker-accounts controller 反向 spread 既有桶 + `...MARKET_PREF_ALL`
- `scripts/checks/check-server-moat.ts`：`MODEL_OWNERSHIP` 加 `brokerAccount: 'portfolio'`（**否则探针 `moat-unmapped` 硬拒**）。`BUSINESS_CTX` 已含 `portfolio`（011 立），无需改
- `apps/server/src/portfolio/portfolio.module.ts`：`controllers` 加 `BrokerAccountsController`；`providers` 加 3 个 broker UC。`imports` 不变（SecurityModule + AccountModule 已满足）。app.module 已注册 PortfolioModule，无需改。eslint boundaries 已配 portfolio element（011），无需改。

### Prisma schema（新表）

```prisma
// datasource: schemas = ["account", "portfolio", "public"]（已含 portfolio，011 立）
model BrokerAccount {
  id         BigInt   @id @default(autoincrement())
  accountId  BigInt   @map("account_id")          // 逻辑引用 JWT sub，无跨 schema FK（同 portfolio_preference）
  brokerCode String   @map("broker_code") @db.VarChar(32)  // ∈ BROKER_CATALOG
  clientNo   String   @map("client_no")             // 明文存储（FR-S07，归属标记非凭证），不限长
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@unique([accountId, brokerCode, clientNo], map: "uk_broker_account_acct_broker_client")
  @@index([accountId], map: "ix_broker_account_account")
  @@map("broker_account")
  @@schema("portfolio")
}
```

- 贫血 row + `@map` snake_case（per [feedback raw-prisma-row-with-map](../../)，无 Entity Mapper）。`clientNo` 明文（not-null，trim 后非空保证）。无 `updatedAt`（broker account 不可编辑，只增删）。
- **多行表**（一账号多券商多客户号），≠ 011 `portfolio_preference` 单行 array 模型（ADR-0046；那是固定小集合偏好，本表是不定长列表）。
- 唯一索引 `(accountId, brokerCode, clientNo)` = dup 兜底 + 并发串行点。`@@index(accountId)` 服务 EP1 list 查询路径。

### 删除逻辑（FR-S04 默认不可删 + FR-S05 反枚举 + id 碰撞消歧）

> **核心健壮性决策（D3）**：默认账户读侧虚拟派生（OQ3），其暴露 id = caller 的 account id；`broker_account.id` 是 portfolio schema 独立自增 → 与 account id **共享 BigInt 数值空间，可能数值碰撞**。用 **「先 scoped-delete 后判定」顺序**消除歧义，而非「先判 id 是否 = accountId」（后者会把恰好 id==accountId 的真实 broker 行误判为默认）：

1. `deleteMany({ where: { id, accountId: sub } })` —— scoped 到 caller 名下。
2. `count === 1` → **204**（删成功；即使该行 id 数值上 == sub，它是 caller 真实拥有的 broker 行，先删命中正确）。
3. `count === 0 && id === sub` → **400 `DEFAULT_ACCOUNT_NOT_DELETABLE`**（caller 试删自己的默认账户虚拟 id）。
4. `count === 0 && id !== sub` → **404**（不存在 / 属他人；字节级一致 ProblemDetail，剥 traceId 后 grep 相等，反枚举）。

**V1 归属回落**（FR-S06）：import 特性未建、无 position 数据 → **仅删行**，「回落默认」语义文档化留 import 落地实现真转移（clarify 2026-05-29，不建空 seam，YAGNI）。

### 并发 / 事务策略（FR-S03 唯一性）

> **决策（D1）**：dup 防护 = **DB 唯一索引兜底 + catch P2002**，**无 FOR UPDATE / 无 SERIALIZABLE / 无预查重**。broker_account 行相互独立（≠ 011 min-1 跨行不变性），并发插入同 `(accountId,brokerCode,clientNo)` → 唯一索引串行化，败者抛 Prisma P2002 → 映射 409 `BROKER_ACCOUNT_DUPLICATE`，不重复落库。

- **不需 FOR UPDATE**：唯一性是单行级约束，DB 索引天然串行化并发同键插入，无跨行不变性 → 无需显式锁（区别于 011 min-1）。
- **P2002 检测 under adapter-pg**（per memory `prisma_serializable_p2002_and_p2034` 警示 Prisma 7 + adapter-pg 改错误形态）：011 是 SERIALIZABLE 下 P2034 变 `DriverAdapterError`；本特性是**普通 insert 唯一冲突**，标准为 `PrismaClientKnownRequestError code='P2002'`。**IT 必含并发同键 POST 测试断言恰一成功一 409**，验证 adapter-pg 下 P2002 catch 真生效（不靠假设）。← tasks gate verify。
- **幂等**：DELETE 已删 id → scoped count 0 → 404（与「不存在」一致，反枚举，per spec Edge）。

### clientNo 字符校验（FR-S07 宽松 + 禁控制字符）

- `normalizeClientNo(raw)`：先对 **raw** 查禁字符 deny-list（trim 会吞 BOM，须 trim 前查）→ 命中抛 400 `FORM_VALIDATION`；再 trim → 空 → 400 `FORM_VALIDATION`；返回 trimmed 明文。
- deny-list 正则 = 002 displayName 同款 `[\x00-\x1F\x7F\u200B-\u200F\uFEFF\u2028\u2029]`（控制 + 零宽 + 行分隔符），**portfolio.rules.ts 自带常量**（跨 ctx 不 import `account.rules.ts`，per 边界；小常量复制 < 跨 ctx 耦合，per memory `author_invisible_chars_via_fromcharcode` 写法用 `new RegExp(...)` 转义）。
- **不强制格式、不限长上限**（各券商客户号格式不一，FR-S07 宽松）；仅 trim 后非空 + 禁字符。

### 券商字典落位（D5）

> **决策**：**client-bundled** 字典（`apps/mobile/src/portfolio/broker-catalog.ts`，含 `{ brokerCode, brokerName, pinyinInitials, logoAsset }`）+ **server 校验副本**（`broker-catalog.ts` 仅 `{ brokerCode, brokerName }`）。**不设独立 GET 字典端点**。

| 选项                          | 取舍                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| **A. client-bundled（选）**   | 契合 spec Key Entities「V1 硬编码 + logo 打包，**变动需发版**」+ logo 是 client bundled 资产必随包；页 C 搜索/A-Z/logo 全 client-only；零网络往返。**代价** = client/server 两份 code+name 副本可能 drift |
| B. GET /portfolio/brokers 端点 | 单一真相源消 drift；**代价** = 为极少变更的 12 行静态字典加端点 + 网络往返 + logo 仍需 client 映射 → 过度设计（spec perf_budgets 也只列 3 端点） |

- **drift 缓解**：server 副本仅 `{code, name}`（校验 + EP1 list response brokerName 来源）；client 副本是 superset（+pinyin+logo）。两份 code 集合在 release 时人工对齐；**可选** 加一条 vitest 断言「mobile broker-catalog 的 code 集合 ⊇ server 已知 code」作弱守卫（跨包 import，若 Nx 边界允许）——tasks gate 评估是否值得。
- logo：mockup 用「名首字蓝 chip」(`brand soft #E8EEFD` 底 / `brand-500` 字) 占位；真品牌 logo impl 引入归后续（FR-M07）。

### 限流配置（FR-S11，复用 throttler infra + AccountIdThrottlerGuard）

| 端点                       | per-account | 实现                                                       |
| -------------------------- | ----------- | -------------------------------------------------------- |
| list-broker-accounts (GET) | `60/60s`    | named `broker-acct-get-account`                          |
| bind-broker-account (POST) | `30/60s`    | named `broker-acct-post-account`                         |
| delete-broker-account (DEL)| `30/60s`    | named `broker-acct-delete-account`                       |

三端点 authed → 复用 `AccountIdThrottlerGuard`，**无** public IP 桶。阈值参照 011（get 60 / write 30）。`@SkipThrottle` 其余全部桶（含 011 market-pref 桶）防污染。← 阈值 tasks gate review（D4）。

### Mobile side（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) strangler-fig + [mobile-impl-playbook](../../docs/conventions/mobile-impl-playbook.md)）

**复用 011 已建 feature dir `apps/mobile/src/portfolio/`**，新增 broker 子模块文件：

- `use-broker-accounts.ts`：包 orval 生成 hook（`useGetBrokerAccounts` query + `useBindBrokerAccount` + `useDeleteBrokerAccount` mutation）；列表查询 + 绑定（成功 invalidate 列表 + 回页 A）+ 删除（乐观移除 + 失败回滚）+ 错误分流（409 dup / 400 校验 / 通用网络错，复用 `~/core/api/errors.ts` guard 体例）
- `broker-catalog.ts`：client 字典（12 券商 `{ brokerCode, brokerName, pinyinInitials, logoAsset }`）+ 按 pinyinInitials 分组/排序派生（页 C A-Z 索引 + 搜索数据源）
- `broker-account-list-screen.tsx`（页 A）：默认账户置顶行（◉ 灰 chip + 「系统默认」tag + 副文案「本账号 · 未归类持仓的默认归属」+ 无删除入口）+ 已绑券商行（logo chip + 名 + 「已绑定」tag + 脱敏客户号 + 左滑删除）+ 右上「新建」→ 页 B + 空态 + loading/retry
- `broker-bind-screen.tsx`（页 B）：行 1「选择券商」（点击开页 C sheet；选中后 logo+名内联）+「客户号」文本输入（右对齐 mono）+「绑定」按钮（券商已选 + clientNo 非空 → enabled）+ 重复绑定行内红框错误（409 映射）+ **无货币单位行**（mockup DO-NOT）
- `broker-row.tsx`：列表单行（默认 / 已绑两变体；脱敏客户号；a11y）
- `broker-copy.ts`：中文文案常量（标题「股票账户」/「绑定券商」/「选择券商」/「系统默认」/「已绑定」/「删除」/「至少…」等）

**新增 `~/ui` 原语（5 个，项目均无，本特性引入；presentational 无单测，per mono 测试分层）**：

- `SwipeRow.tsx`：左滑露出 84px err 红底白字「删除」块（`react-native-gesture-handler` Swipeable 或等价；色用 `~/theme` err token，0 hex）。手势与列表滚动冲突走手势库默认。
- `ConfirmModal.tsx`：二次确认 modal（取消 / 删除；err 强调删除）。
- `BrokerPickerSheet.tsx`（页 C）：底部 sheet（上滑 translateY + scrim + drag handle + 圆角，mockup 定**非全屏**）+ 标题「选择券商」+ 返回 + 内嵌 SearchBar + AlphaIndex + 券商列表（logo+名）+ 搜索无结果空态。**无「开户」按钮、无能力标签**（mockup DO-NOT）。选中回调传 brokerCode 回页 B。
- `SearchBar.tsx`：搜索输入（按券商名 / pinyinInitials 简拼过滤）。
- `AlphaIndex.tsx`：右侧 A-Z 字母条（点击跳转 + sticky group header；按 pinyinInitials 首字母分组）。
- `index.ts` barrel 加 5 导出。

**新增客户端脱敏 helper**：

- `apps/mobile/src/format/broker.ts`（与 `format/phone.ts` `maskPhone` 同目录同范式）：`maskClientNo(clientNo: string | null): string`——mockup maskCust 口径：`> 8 字符 → 前 4 + '****' + 后 4`（如 `3119****2466`）；≤ 8 字符策略 mockup 定（impl 对齐 baseline）。+ `broker.spec.ts` 逻辑单测（vitest）。

**新增 Expo route + settings 入口**（per [reference expo-router-app-route-scan](../../)）：

- `app/(app)/settings/broker-accounts.tsx`（页 A 列表）+ `broker-accounts/bind.tsx`（页 B）—— 薄 route，import screen from `~/portfolio`。页 C 是 sheet（非独立 route，组件内 modal 态）。
- `app/(app)/settings/_layout.tsx`：注册 2 个 `<Stack.Screen>`（broker-accounts / broker-accounts/bind，title + `headerLeft: makeHeaderBackOrParent(...)`，沿用既有 header 体例）。
- `app/(app)/settings/index.tsx`：**011 已加的「投资设置」Card 内 `券商账户` Row 当前是 `disabled` 占位**（011 plan D5 明示）→ 本特性**改为 live**（`onPress → /(app)/settings/broker-accounts`，移除 disabled）。← 入口 IA 复用 011，非新建 Card。

### Cross-cutting

- **同步链**（Constitution V，per [api-contract-trigger](../../)）：server controller/DTO/swagger → `nx run server:export-openapi` → `nx affected -t generate`（orval regen api-client broker 端点 hook）→ mobile 消费 typed hook。
- **catalog 更新**：ship 时 `server-bounded-context-catalog.md` § Operation Catalog 新增 3 行（list/bind/delete broker-accounts，context=portfolio，propagation=intra，source PR=本 PR1）。
- **跨 ctx 注释**：portfolio **无** R2/R3 业务调用 → 无 `// CROSS-CONTEXT-*` 注释。guard 经 `AccountModule` export 复用（account-bound 鉴权 artefact）→ 镜像 011；`check-server-moat.ts` 探针验 portfolio 内零 `prisma.<otherTable>.*`（**前提：先登记 `brokerAccount:'portfolio'`，否则 portfolio 读自己的表即 `moat-unmapped` 红**）。
- **反枚举不变性**：GET/POST/DELETE 未认证/非 ACTIVE → 统一 401（JwtAuthGuard）；DELETE not-found / others'-account → 字节级一致 404，grep 剥 traceId 后相等。
- **视觉 0 硬编码**（SC-M06）：mobile 实现文件 grep 无 theme token 外 hex/rgb 字面量。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| #      | 决策                       | 结论                                                                                                                                                                          | gate? |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **D1** | dup 并发原语               | **唯一索引 + catch P2002 → 409**，无 FOR UPDATE/SERIALIZABLE/预查重（行相互独立，单行约束）。IT 必含并发同键测试验 adapter-pg 下 P2002 真生效                                  | ⚠️    |
| **D2** | dup / 默认不可删 HTTP 码   | dup = **409 Conflict**（唯一性冲突标准语义，区别于 011 的 422 业务不变性）；默认不可删 = **400 `DEFAULT_ACCOUNT_NOT_DELETABLE`**（系统约束，与 404 反枚举语义分离）            | ⚠️    |
| **D3** | 删除 id 碰撞消歧           | **先 scoped-delete 后判定**顺序（deleteMany scoped → count 分流 204/默认400/404），消除「默认虚拟 id = accountId」与「broker 行 id」BigInt 数值碰撞歧义                       | —     |
| **D4** | 限流阈值                   | get `60/60s` · post `30/60s` · delete `30/60s`（per-account，复用 AccountIdThrottlerGuard，无 IP 桶）                                                                       | ⚠️    |
| **D5** | 券商字典落位               | **client-bundled**（含 pinyin+logo）+ server 校验副本（code+name）；不设独立端点（契合「变动需发版」+ logo 必打包 + 避免为 12 行静态字典加端点过度设计）                       | ⚠️    |
| **D6** | clientNo 校验严格度        | **宽松 + 禁控制/零宽/行分隔符**（trim 后非空，不强制格式不限长；复用 002 displayName deny-list 正则，portfolio.rules.ts 自带副本不跨 ctx import）                              | —     |
| **D7** | 归属回落 V1 范围           | **仅删行 + 语义文档化**（import 未建，无 position 数据，YAGNI 不建空 seam，clarify 2026-05-29 固化 FR-S06）                                                                    | —     |
| **D8** | clientNo 脱敏              | **server 返 raw + 客户端脱敏**（仿 002 phone `maskPhone`；`format/broker.ts maskClientNo` 前4后4，clarify 固化 FR-S07）                                                       | —     |
| **D9** | settings 入口 IA           | **复用 011 已加「投资设置」Card 的 `券商账户` Row**（011 plan D5 占位）→ 本特性翻 live；非新建 Card                                                                            | —     |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| —         | —          | —                                    |

**Note**：(1) **复用 011 portfolio ctx**，无新 bounded context bootstrap（比 011 轻）。(2) **唯一索引 + P2002** 比 011 的 FOR UPDATE 简单（单行约束无跨行不变性）。(3) **mobile 是本特性重头**：5 个净新 UI 原语（SwipeRow/ConfirmModal/BrokerPickerSheet/SearchBar/AlphaIndex）+ 三页流转 + A-Z 索引 + 底部 sheet，复杂度高于 011 单设置页（011 仅 1 个 Switch 原语）。整体 server 轻、mobile 重。

## Performance Budget

| Endpoint                                            | P95 (ms) | P99 (ms) |
| --------------------------------------------------- | -------: | -------: |
| `GET /api/v1/portfolio/broker-accounts`             |      100 |      200 |
| `POST /api/v1/portfolio/broker-accounts`            |      120 |      250 |
| `DELETE /api/v1/portfolio/broker-accounts/{id}`     |      120 |      250 |

_perf 预算 SoT = spec.md frontmatter `perf_budgets`。单账号券商行数量级 ≤ 数十，list 走 `ix_broker_account_account` 索引，无瓶颈。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review）

**两段式 PR**（per Constitution §V v1.2.0 跨端 feature 默认 + 011 先例）：

- **PR1（server，feat(portfolio)）**：broker_account schema + migration + moat 登记 + 3 UC + controller + 字典副本 + rules（normalizeClientNo + buildBrokerAccountList）+ throttler 3 桶 + 既有 controller spread skip + IT + contract regen（api-client broker hook，mobile 暂不消费，同 005/011 先 regen 供后续）。ships 真后端。**PR1 描述须 cite §V 例外**。
- **PR2（mobile，feat(portfolio)）**：`src/portfolio/` broker 子模块 + `~/ui` 5 原语 + Expo 2 route + 3 页 + client 字典 + maskClientNo + vitest 逻辑分流 + Playwright 真后端冒烟（against PR1 已 merge server）。

### 建议 tasks.md 层级（每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）

**Server（PR1）**：

- `[Server]` schema + migration：`BrokerAccount` model（multi-row）+ expand-only migration（create table + unique + index）+ `prisma generate` gate
- `[Server]` moat 登记：`check-server-moat.ts` `MODEL_OWNERSHIP` 加 `brokerAccount:'portfolio'` + verify `pnpm tsx scripts/checks/check-server-moat.ts` 关 & `nx lint server` 0 violation（boundaries 已配 portfolio，无需改）
- `[Server]` 字典 + rules：`broker-catalog.ts`（12 券商 code+name + 谓词）+ `portfolio.rules.ts` 加 `normalizeClientNo`（禁字符 deny-list）+ `buildBrokerAccountList` + 纯函数单测（vitest，无 DB：禁字符拒 / trim 空拒 / 默认账户置顶合成 / brokerName merge）
- `[Server]` list UC：`list-broker-accounts.usecase.ts` + response DTO + 单测（Testcontainers PG：新账号仅默认 / 预置 2 已绑 + 他人 1 → 默认置顶 + 本账号 2、他人不可见 / raw clientNo 返回）
- `[Server]` bind UC：`bind-broker-account.usecase.ts`（字典校验 + normalizeClientNo + create + P2002→409）+ duplicate exception + request DTO + 单测（Testcontainers PG：有效 201 / dup 409 / 未知券商 400 / 空 clientNo 400 / 禁字符 400 / 同券商多客户号允许）
- `[Server]` delete UC：`delete-broker-account.usecase.ts`（scoped deleteMany + count 分流）+ default-not-deletable exception + 单测（Testcontainers PG：删本账号 204 / 删默认(id=accountId) 400 / 不存在 404 / 他人 id 404 字节级一致 / 幂等已删 404）
- `[Server]` controller + module：`broker-accounts.controller.ts`（GET+POST+DELETE，guard，swagger 200/201/204/400/401/404/409/429）+ named throttler 3 桶（auth.module）+ portfolio.module 加 controller+UC + throttler-skip-buckets 加组 + 既有 controller（含 011 market-pref）spread skip + 单测
- `[Server-IT]`（Testcontainers PG 全 boot）：
  - EP1 GET：新账号仅默认 / 预置态读回默认置顶 + 已绑序 / 跨账号隔离 / 401 反枚举
  - EP2 POST：有效 201 持久化 / dup 409 不重复落库 / **并发同键 → 恰一 201 一 409**（验 adapter-pg P2002，D1 gate）/ 未知券商 400 / 空+禁字符 clientNo 400 / 同券商多客户号 201
  - EP3 DELETE：删本账号 204 + GET 不再含 / 删默认 400 DEFAULT_ACCOUNT_NOT_DELETABLE 列表不变 / 不存在 + 他人 id → 404 字节级一致（ProblemDetail 深等剥 traceId）
  - 限流：3 桶边界（get 61/post 31/delete 31）→ 429
- `[Contract]`：`nx run server:export-openapi` → `nx affected -t generate`（orval regen broker hook）+ api-client/mobile typecheck 绿
- `[Verify]`：`nx affected -t lint typecheck test build --base=origin/main` 全绿 + catalog 3 Operation 行 + boundaries 0 违规 + `check-server-moat.ts` 关

**Mobile（PR2）**：

- `[Mobile]` UI 原语（拆 2-3 task，per Constitution III clear 批次）：`SwipeRow` + `ConfirmModal`（删除交互对）；`SearchBar` + `AlphaIndex`（搜索/索引对）；`BrokerPickerSheet`（底部 sheet 组合前两对）+ barrel 导出 + typecheck/lint（0 hex，presentational 无单测）
- `[Mobile]` 字典 + 脱敏：`src/portfolio/broker-catalog.ts`（12 券商 + pinyin 分组派生）+ `format/broker.ts maskClientNo` + `broker.spec.ts`（vitest：前4后4 / 短号 / null）
- `[Mobile]` hook：`use-broker-accounts.ts`（query+3 mutation 包装 + 乐观删除回滚 + 绑定成功 invalidate + 错误分流 409/400/网络）+ vitest 逻辑分流单测（helper-level：删除回滚 / 409 dup vs 400 校验 vs 网络错分流）
- `[Mobile]` 页 A 列表：`broker-account-list-screen.tsx` + `broker-row.tsx` + `broker-copy.ts` + route `app/(app)/settings/broker-accounts.tsx` + `_layout.tsx` 注册 + `settings/index.tsx` 券商账户 Row 翻 live + typecheck/lint
- `[Mobile]` 页 B+C 绑定流：`broker-bind-screen.tsx`（选券商内联 + clientNo 输入 + 绑定校验 disabled↔enabled + 409 行内错误）+ 页 C BrokerPickerSheet 接线（搜索 + A-Z + 选中回填）+ route `bind.tsx` + typecheck/lint
- `[Mobile-E2E]`（Playwright Expo Web，真后端冒烟 per 纪律②）：登录 → 设置进券商账户列表（仅默认账户，无删除入口）→ 新建进页 B → 点选择券商开 sheet（搜索 + A-Z）→ 选中回填 → 填客户号 → 绑定 → 回列表含新条（脱敏客户号）（SC-M02）→ 左滑删除 + 二次确认 → 移除（SC-M04）→ dup 绑定行内错误（US5.5）→ 截图归档 `runtime-debug/2026-06-XX-broker-account-binding/`

预估 task 数：PR1 ~9-10（server）+ PR2 ~6-7（mobile）= **~15-17**。**server 轻于 011**（复用 ctx，无 FOR UPDATE，无 schema datasource 改）；**mobile 重于 011**（5 新原语 + 三页 + A-Z 索引 + 底部 sheet，vs 011 单 Switch）。主要新点 = broker_account 多行表 + dup P2002 + 删除 id 消歧 + mobile 复杂列表/弹层交互。

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-02 | **ID-namespace**: US1-6 / FR-S01..S12 / FR-M01..M09 / SC-S01..S07 / SC-M01..M06
