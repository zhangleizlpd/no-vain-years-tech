---
feature_id: 011-stock-market-access
modules: [portfolio]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-29'
updated_at: '2026-06-03'
migration_refs:
  [
    20260601_2242_add_portfolio_market_preference,
    20260603_1200_market_preference_vocab_to_market_code,
  ]
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: untested
web_compat_notes: 'portfolio 首特性，模块尚未落地（plan 阶段评估新 bounded context per ADR-0032）；Web export 路径尚未冒烟（draft 阶段，untested）。本批走类 2 流程（mockup 先行，per PRD 01 §9）：spec → clarify → mockup → plan → tasks → impl；UI impl 定稿前补真后端冒烟（Playwright Expo Web）。端点路径为提案，contract 阶段（OpenAPI code-first）定稿。'
agent_friction_observed: false
perf_budgets:
  - endpoint: 'GET /api/v1/portfolio/market-preferences'
    p95_ms: 80
    p99_ms: 150
  - endpoint: 'PUT /api/v1/portfolio/market-preferences/{market}'
    p95_ms: 120
    p99_ms: 250
state_branches:
  - 'first-load (new user): GET 市场偏好 → 核心市场默认 {cn: active, hk: inactive, us: inactive}；GET 不写库（默认为读侧投影，落库时机 plan 定）'
  - 'returning user: GET → 返回上次持久化的核心市场激活态'
  - 'toggle-on core market: PUT {market∈核心, active:true} → 200 + 持久化；后续 GET 返回同态'
  - 'toggle-off core market（激活数 > 1）: PUT {market∈核心, active:false} → 200 + 持久化'
  - 'min-1 invariant: PUT 使核心激活数将归 0（关最后一个激活市场）→ 拒绝（4xx MIN_ONE_MARKET_REQUIRED），状态不变；客户端 toggle 视觉弹回 + 轻提示'
  - 'overseas market 拒绝激活: PUT {market∈海外} → 拒绝（4xx MARKET_NOT_AVAILABLE），不持久化（V1 海外市场恒不可激活）'
  - 'unauth / 非 ACTIVE 账号: GET 或 PUT → 401（边界，反枚举不泄露存在性，与既有 /me 一致路径）'
---

# Feature Specification: Stock Market Access（证券市场准入设置页 — 多市场激活开关）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-05-29)]**
> 本 feature 是 **portfolio 大模块首特性**。server 段按 **Flat + Anemic + Moat** 范式实现（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）；`portfolio` 为**新 bounded context**，落地前须按 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) sunset trigger + [catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 决策问题评估（归 `/speckit-plan`）。spec 只描述业务行为，不含实现技术词。
>
> 🎯 **[流程 OVERRIDE — 走类 2（per PRD 01 §9）]**
> 本特性 intrinsic 属 sdd.md 类 1 标准 UI，但**本批改走类 2**：`spec → /speckit-clarify → mockup（先行）→ plan（含完整 UI 段）→ tasks → impl`。**不走**类 1 的「占位 UI + 后端冒烟后才 mockup」。纪律：① 本 spec clarify 干净再 mockup；② UI impl 定稿前补一次真后端冒烟；③ mockup 复用项目 theme tokens，不重设视觉资产。

**Feature Branch**: `011-stock-market-access`（设计阶段在 `investment` 长期分支，impl 阶段再开 feature 分支）
**Created**: 2026-05-29
**Status**: Clarified（clarify 2026-05-29：存储定**服务端持久化** + 01 顺带立 `portfolio` 模块；3 处 plan/impl 级开放点 informed-default 结算，见 § Clarifications）
**Module**: `portfolio`（新 bounded context — 用户级市场准入偏好 + 系统静态市场字典）
**PRD**: [portfolio-01-stock-market-prd.md](../../docs/prd/portfolio/portfolio-01-stock-market-prd.md)
**Input**:

- 证券市场设置页是 portfolio 的**市场准入开关中枢**：决定哪些证券市场被「激活」。激活态是全局 API 消费与流量分配的准入门（激活 → 下游搜索 / 导入 / 行情轮询 / EOD 同步对该市场端点开放；未激活 → 下游对该市场端点彻底熔断）。
- 9 个市场分两组：**核心**（A 股 / 港股 / 美股，市场码 `cn` / `hk` / `us`，可开关）+ **海外**（日 / 新 / 马 / 加 / 澳 / 韩，市场码 `jp` / `sg` / `my` / `ca` / `au` / `kr`，V1 恒置灰不可激活）。市场码与 015 `Instrument.market` 同词表；各自的 ISO 4217 货币码（CNY/HKD/USD…）独立存于 `isoCurrency` 供 UI 显示（见 §Context 市场字典）。
- 首次默认：A 股 ON，港股 / 美股 OFF。
- **min-1 不变性**：核心市场激活数始终 ≥ 1（不允许关掉最后一个激活市场）。
- 切换即时持久化（无独立"保存"按钮）。每个市场 label 追加 ISO 4217 货币码，作为后续多币种折算（Master §3.3）的市场→币种映射来源。
- **边界**：本页只管「用户市场偏好的开关与持久化」；市场端点真实初始化 / 熔断的网关层实现 + 激活态向下游的传播机制（事件 vs 读偏好表）**跨页，不在本 spec 锁定**——本 spec 只保证激活态可被下游读取。

## Context

- **两个独立 bounded context（勿混）**：本页的「市场」= 全局**市场准入偏好**（portfolio 概念）；与 PRD 02「股票账户（券商账户）」是两个独立 context——市场是市场，券商账户是券商账户。
- **portfolio 为新模块**：mono 现有 server module = `auth` / `account` / `security`（per [business-naming](../../docs/conventions/business-naming.md)）。本特性首次引入 `portfolio`——module 目录 / Prisma `portfolio` schema / ESLint boundaries 单向边界须同时落地（plan/impl）。
- **鉴权复用既有设施**：`JwtAuthGuard` 鉴权 / 账号 status==ACTIVE 兜底 / RFC 9457 ProblemDetail 全局错误映射 / `@nestjs/throttler` 限流（[ADR-0022](../../docs/adr/0022-throttler-nestjs-redis.md)）均已就位；本 spec 引用，不重立。
- **反枚举不变性**：市场偏好端点受 JWT 保护；未认证 / token 过期 / 账号非 ACTIVE → 统一 401（不区分原因，与既有 `/me` 一致路径）。
- **市场字典是系统静态**：9 个市场的 `{ marketCode, 显示名, isoCurrency, group, v1Available }` 为系统常量（非用户数据），是市场→币种映射与分组 / 顺序的真相源。V1 硬编码（变动需发版）。
- **数据规模极小**：用户市场偏好仅核心 3 市场的 bool 态（≤ 3 行 / 用户）；无性能压力，无缓存必要。

## Clarifications

### Session 2026-05-29

- Q: 市场偏好存哪？01 是否顺带 bootstrap portfolio server 模块？ → A: **服务端持久化，本特性立 `portfolio` 模块** —— 偏好绑 account、跨设备一致；01 顺带 bootstrap portfolio NestJS module + Prisma `portfolio` schema + ESLint 单向边界（02 券商 / 04 自选都依赖 portfolio server，迟早要立）。对齐 PRD §5「per user」+ account-profile 服务端先例。固化 FR-S01~S10 + Assumptions 的服务端框架（modules: [portfolio]）。
- 以下 **plan/impl 级开放点经 informed-default 结算**（非阻塞，spec 内已就地标注，clarify 不劳 user 决）：
  - **min-1 客户端反馈策略**（FR-M05）→ **客户端预判拦截为主 + server 兜底**：客户端持有当前激活集，关最后一个激活市场时直接 toggle 弹回 + 轻提示「至少保留一个激活市场」，**不发 PUT**（即时无闪烁，对齐 PRD §3.3「开关不生效、视觉弹回」）；server FR-S04 为最终真相，防多端竞态致 0 激活。SC-M03 断言被阻塞动作不产生"0 激活"中间态。
  - **市场偏好端点粒度**（OQ2）→ **单市场 PUT**（`PUT /api/v1/portfolio/market-preferences/{market}`），契合「即时持久化」单 toggle 语义；OpenAPI code-first contract 阶段定稿。
  - **min-1 并发判定**（OQ3）→ 写事务内基于当前激活集判定（事务内 count 或条件写）；实现策略归 plan，spec 级仅声明不变性（FR-S04）。

### Session 2026-06-03（市场码词表订正，post-015/016）

- **market 词表 `CNY/HKD/USD` → `cn/hk/us`**（`migration_refs` 加 `20260603_1200_market_preference_vocab_to_market_code`）：015/016 落地后，`Instrument.market` canonical 用小写市场码（`cn:600519`）。原 011 `market_preference.market` 用 ISO 4217 货币码（CNY/HKD/USD），与 015 词表不一致 → 013/014 自选/详情消费时被迫加映射。**决议**：全线统一为 `cn/hk/us`（catalog `marketCode` 改小写市场码、`isoCurrency` 字段独立保留供 UI 显示，**不做映射**）；存量 `active_markets` 经数据迁移 `CNY→cn` 等就地转换（pre-内测近空表，安全）。海外 6 市场码同步 `jp/sg/my/ca/au/kr`。UI label 仍 `市场名（isoCurrency）`= `A 股（CNY）` 不变（per FR-M02）。独立 fix 分支落地。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 读取市场偏好（含新用户默认）（Priority: P1）

已登录用户拉取自己的核心市场激活态；新用户（从未设置过）返回系统默认 {A股 ON，港股 OFF，美股 OFF}。

**Why this priority**: 读侧基座——设置页渲染与下游准入判定都依赖它；新用户默认是首次进入的唯一来源。

**Independent Test**: Testcontainers PG；① 新账号（无偏好记录）authed GET → 断言核心 3 市场态 = {cn:active, hk:inactive, us:inactive}；② 预置某账号已持久化 {cn:active, hk:active, us:inactive} → GET → 断言返回同态；③ 响应含海外市场的元信息（分组 / 货币 / v1Available=false），海外恒 inactive。

**Acceptance Scenarios**:

1. **Given** 新账号无偏好记录，**When** authed GET 市场偏好，**Then** 200 + 核心市场 {cn: active, hk: inactive, us: inactive}；GET 不产生写库副作用
2. **Given** 账号已持久化 {港股也激活}，**When** GET，**Then** 200 + 返回持久化态（cn+hk active, us inactive）
3. **Given** access token 过期 / 缺失 / 账号非 ACTIVE，**When** GET，**Then** 401 ProblemDetail（不区分原因，反枚举）

---

### User Story 2 — [Server] 切换核心市场激活态（即时持久化 + min-1 + 海外拒绝）（Priority: P1）

用户切换某核心市场开关，server 校验后持久化。两条不变性强制在 server：min-1（核心激活数恒 ≥ 1）、海外市场恒不可激活。

**Why this priority**: 核心写动作 + 两条安全/业务不变性；客户端弹回是体验，server 强制是真相。

**Independent Test**: Testcontainers PG；预置账号 {cn:active 唯一激活}；① PUT {hk, active:true} → 200 + 持久化，GET 返 {cn+hk active}；② 续上 PUT {cn, active:false} → 200（仍有 hk 激活）；③ 回到仅 {cn:active}，PUT {cn, active:false}（关最后一个）→ 4xx MIN_ONE_MARKET_REQUIRED，GET 仍 {cn:active}；④ PUT {jp, active:true}（海外）→ 4xx MARKET_NOT_AVAILABLE，不持久化。

**Acceptance Scenarios**:

1. **Given** 账号 {cn:active}，**When** PUT {hk, active:true}，**Then** 200 + 持久化；GET 返 {cn+hk active}
2. **Given** 账号 {cn:active, hk:active}，**When** PUT {cn, active:false}，**Then** 200（hk 仍激活，满足 min-1）
3. **Given** 账号 {cn:active}（唯一激活），**When** PUT {cn, active:false}，**Then** 4xx `MIN_ONE_MARKET_REQUIRED`；状态不变（GET 仍 {cn:active}）
4. **Given** 任意态，**When** PUT 任一海外市场 active:true，**Then** 4xx `MARKET_NOT_AVAILABLE`；不持久化
5. **Given** 未认证 / 非 ACTIVE，**When** PUT，**Then** 401（与 GET 一致路径）

---

### User Story 3 — [Mobile] 首次进入设置页看到默认态（Priority: P1）

已登录用户进入「证券市场」设置页：看到 9 个市场分核心 / 海外两组、固定顺序；核心 A 股已激活、港股 / 美股关闭；海外市场置灰不可点、副文案「即将支持」。

**Why this priority**: 主路径，所有用户进入本页必经；默认态正确是首屏不变性。

**Independent Test**: mock GET 市场偏好返默认态 → 渲染设置页 → 断言渲染 9 行（核心 3 + 海外 6）、固定顺序、label 含 ISO 货币码、A 股 toggle ON / 港股 / 美股 OFF、海外 6 行 toggle disabled + 「即将支持」文案。（render/a11y 走 Playwright Expo Web，逻辑分流走 vitest，per mono 测试分层）

**Acceptance Scenarios**:

1. **Given** GET 返默认态，**When** 页面渲染，**Then** 显示 9 个市场，核心组在上 / 海外组在下，顺序固定（§市场清单）
2. **Given** 同上，**When** 检查核心组，**Then** A 股 toggle = ON，港股 / 美股 = OFF
3. **Given** 同上，**When** 检查海外组，**Then** 6 行 toggle 均 disabled（置灰），每行副文案「即将支持」
4. **Given** 同上，**When** 检查任一行 label，**Then** 形如 `市场名（XXX）`（XXX = ISO 4217）

---

### User Story 4 — [Mobile] 切换核心市场 → 即时持久化（Priority: P1）

用户点核心市场 toggle → 立即写后端（无保存按钮）；成功后该态保留（重进设置页仍是新态）。

**Why this priority**: 主交互；即时持久化是本页核心产品决策（§8 已定）。

**Independent Test**: mock PUT 成功 → 点港股 toggle → 断言发起 PUT {hk, active:true} + UI 港股变 ON；mock PUT 失败 → 断言 toggle 回弹原态 + errorToast。

**Acceptance Scenarios**:

1. **Given** 港股 OFF，**When** 用户点港股 toggle，**Then** 发起 PUT {hk, active:true}，成功后港股 UI = ON
2. **Given** 切换成功，**When** 用户离开再重进设置页（重新 GET），**Then** 港股仍 ON（持久化）
3. **Given** PUT 失败（网络 / 5xx），**When** 处理，**Then** toggle 回弹原态 + 展示 errorToast（网络异常 / 请稍后重试）

---

### User Story 5 — [Mobile] min-1 约束：关最后一个激活市场被阻止（Priority: P1）

用户尝试关掉**最后一个**激活的核心市场：开关不生效、视觉弹回原位、轻提示「至少保留一个激活市场」。

**Why this priority**: 关键约束的用户可感知反馈；与 US2 server 强制互锁（客户端先拦 + server 兜底）。

**Independent Test**: mock 当前仅 A 股激活 → 点 A 股 toggle（尝试关）→ 断言 toggle 弹回 ON + 展示轻提示「至少保留一个激活市场」+ **客户端预判拦截不发起 PUT**（per Clarifications informed-default；server FR-S04 兜底防多端竞态）。

**Acceptance Scenarios**:

1. **Given** 仅 A 股激活，**When** 用户点 A 股 toggle（尝试关），**Then** toggle 弹回 ON + 轻提示「至少保留一个激活市场」
2. **Given** A 股 + 港股都激活，**When** 用户关 A 股，**Then** 成功（港股仍激活，不触发 min-1）

---

### User Story 6 — [Mobile] 海外市场置灰零副作用（Priority: P2）

用户点击任一海外市场行：无任何反应（无 toggle 切换、无网络、无 navigation）；该行恒置灰、副文案「即将支持」。

**Why this priority**: 防误用 + 明确「未来支持」信号；非 MVP 阻塞但是占位不变性。

**Independent Test**: 点击各海外行 → 断言无 PUT 请求、无 router 调用、toggle 态不变（disabled）。

**Acceptance Scenarios**:

1. **Given** 海外市场行置灰，**When** 用户点击该行 / 该 toggle，**Then** 无 PUT、无 navigation、态不变
2. **Given** 海外行渲染，**When** 检查副文案，**Then** 固定「即将支持」

---

### Edge Cases

#### Server Edge Cases

- **PUT 未知 market 码**（不在 9 市场字典内）→ 4xx（`MARKET_NOT_FOUND` 或 `VALIDATION_FAILED`，具体码 plan 定）
- **PUT body 缺 active 字段 / 类型错** → `VALIDATION_FAILED` 400
- **并发切换同一市场**（同账号多端）→ 末次写入生效（单行 upsert，无跨行不变性除 min-1）；min-1 校验在写事务内读当前激活集判定，避免「两端同时关不同市场致 0 激活」竞态（判定策略 plan 定：事务内 count 或条件写）
- **幂等**：PUT {hk, active:true} 当港股已 active → 200 + 不变（幂等）
- **海外市场出现在持久化记录里**（历史脏数据 / 不应发生）→ 读侧仍按字典 v1Available=false 呈现 inactive 不可激活

#### Mobile Edge Cases

- **GET 市场偏好失败**（首屏）→ 不死锁；fallback = 展示 loading / retry，不渲染错误的默认态误导用户
- **切换请求 in-flight 时再次点击同一 toggle** → 防抖 / 禁用（避免重复 PUT）；策略 plan 定
- **min-1 客户端预判与 server 裁决不一致**（罕见竞态：另一端已关了某市场）→ 以 server 响应为准，UI 同步真态
- **长市场名 / 小屏** → label `numberOfLines=1` + ellipsize（视觉细节 mockup 定）

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 系统 MUST 对已登录账号返回其核心市场（cn / hk / us）激活态；无持久化记录的新账号 MUST 返回默认 {cn: active, hk: inactive, us: inactive}。响应 MUST 同时含市场字典元信息（每市场的 `group` / `isoCurrency` / `v1Available`），使客户端无需硬编码字典。
- **FR-S02**: GET / PUT MUST 鉴权（`Authorization: Bearer <access>`）；缺失 / 无效 / 过期 / 账号 status != ACTIVE → 统一 **401** ProblemDetail（不区分原因，反枚举）。
- **FR-S03**: 系统 MUST 支持切换单个核心市场激活态并即时持久化（无批量 / 无独立保存语义）；成功 → 200 + 最新态。
- **FR-S04**: **min-1 不变性** — 系统 MUST 拒绝任何使核心市场激活数归 0 的更新（关最后一个激活市场）→ 4xx `MIN_ONE_MARKET_REQUIRED`，状态不变。该校验 MUST 在写事务内基于当前激活集判定（防多端竞态致 0 激活）。
- **FR-S05**: **海外不可激活** — 系统 MUST 拒绝激活任何海外市场（jp/sg/my/ca/au/kr）→ 4xx `MARKET_NOT_AVAILABLE`；仅核心市场（cn/hk/us）的 active 更新被接受。
- **FR-S06**: 系统 MUST 以系统静态字典定义 9 个市场 `{ marketCode, 显示名, isoCurrency(ISO 4217), group: core|overseas, v1Available }`，作为分组 / 顺序 / 市场→币种映射真相源；用户偏好仅记录核心市场激活 bool。
- **FR-S07**: 错误响应 MUST 遵循 RFC 9457 ProblemDetail，由全局异常 filter 映射，与既有 use case 一致。
- **FR-S08**: 系统 MUST 对两端点限流（复用 `@nestjs/throttler` + Redis storage）：读 / 写各一条 named throttler（具体阈值 plan 定，tracker = JWT sub）；超限 → 429 + `Retry-After`。
- **FR-S09**: 激活态 MUST 可被下游消费（全局搜索 / 导入 / 行情轮询 / EOD 同步的市场端点准入）；**传播机制（领域事件广播 vs 下游读偏好表）属网关层，不在本 feature 锁定**——本 feature 仅保证激活态可读。
- **FR-S10**: `portfolio` 为新 module/schema — 落地 MUST 同时满足 [business-naming](../../docs/conventions/business-naming.md)（server module 目录 + Prisma `portfolio` schema + ESLint boundaries 单向边界），且按 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) 评估 bounded context（plan 阶段）。

### Mobile Functional Requirements

- **FR-M01**: 设置页 MUST 展示全部 9 个市场，分核心 / 海外两组，固定顺序（§市场清单），每组内顺序固定。
- **FR-M02**: 每行 label MUST 为 `市场名（ISO 4217 货币码）`（如 `A 股（CNY）`）；右侧 toggle 开关（label 左 / 开关右布局）。
- **FR-M03**: 核心市场 toggle MUST 可切换且**即时持久化**（点击 → PUT → 乐观更新 + 与响应对账）；无独立保存按钮。
- **FR-M04**: 海外市场 toggle MUST 恒为 disabled 置灰态，点击零副作用（无 PUT / 无 navigation）；每行副文案固定「即将支持」。
- **FR-M05**: **min-1 客户端反馈** — 尝试关掉最后一个激活核心市场时，toggle MUST 视觉弹回 + 轻提示「至少保留一个激活市场」。**已定（Clarifications informed-default）= 客户端预判拦截为主**：持当前激活集，关最后一个直接弹回 + 提示、**不发 PUT**；server `MIN_ONE_MARKET_REQUIRED`（FR-S04）为最终真相兜底，防多端竞态致 0 激活。
- **FR-M06**: 首屏默认态 MUST 来自 server（FR-S01 默认），不在客户端硬编码激活默认。
- **FR-M07**: 切换失败（网络 / 4xx / 5xx）MUST 回弹 toggle 至原态 + 展示 errorToast；min-1（4xx）与通用错误的提示文案区分。
- **FR-M08**: 视觉 MUST 复用项目 theme tokens（`apps/mobile/src/theme/`），不照搬参考图配色；项目尚无 Switch/Toggle 组件，**新组件视觉规格留类 2 mockup 决策**，spec/plan 不锁死精确像素 / 配色。
- **FR-M09**: a11y — toggle `accessibilityRole='switch'` + `accessibilityState.checked`；海外行 `accessibilityState.disabled=true`；分组标题可达。

### Key Entities

- **MarketPreference（用户级，per account）**：`{ accountId, market（核心市场码 cn/hk/us）, active: bool }`——仅记录核心市场激活态；唯一性 = `accountId + market`。新用户无记录 → 读侧投影默认。**不向 `account` 模块写入**（只读引用 accountId 作归属）。
- **MarketCatalog（系统静态，非持久用户实体）**：`{ marketCode, displayName, isoCurrency(ISO 4217), group: core|overseas, v1Available: bool, order }`——9 市场常量；分组 / 顺序 / 市场→币种映射真相源。V1 硬编码。

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: 新用户 GET 返回正确默认态（{cn:active, hk/us:inactive}）、老用户返回持久化态（集成测试覆盖两路径 + 海外元信息 v1Available=false）。
- **SC-S02**: min-1 不变性 server 强制——关最后一个激活市场被拒（4xx `MIN_ONE_MARKET_REQUIRED`），状态不变（集成测试覆盖单激活 + 多激活两 case）。
- **SC-S03**: 海外市场激活被拒（4xx `MARKET_NOT_AVAILABLE`，不持久化）；仅核心 3 市场 active 更新被接受（集成测试覆盖）。
- **SC-S04**: 鉴权边界——未认证 / 非 ACTIVE 账号 GET/PUT 必返 401（集成测试覆盖）。
- **SC-S05**: 限流两端点规则生效（超限 429 + `Retry-After`，集成测试覆盖桶边界）。
- **SC-S06**: `portfolio` module 落地后 ESLint boundaries 单向边界 0 violation；Prisma `portfolio` schema 在 CI 通过（per business-naming 强制层）。

### Mobile Measurable Outcomes

- **SC-M01**: 设置页渲染 9 市场 / 2 组 / 固定顺序 / label 含 ISO 货币码 / 默认 toggle 态正确（vitest 逻辑分流 + Playwright Web render）。
- **SC-M02**: 切换核心市场即时持久化 + 重进保留（Playwright Web 真后端冒烟，per 流程纪律②）。
- **SC-M03**: min-1 客户端反馈——关最后一个激活市场触发弹回 + 轻提示（断言无错误的"0 激活"中间态）。
- **SC-M04**: 海外市场行零副作用（点击无 PUT / 无 navigation；grep / 行为断言）。
- **SC-M05**: 真后端冒烟（Playwright Expo Web，per 流程纪律②）：登录 → 进设置页 → 切换港股 ON → 重进确认持久化 → 截图归档（`runtime-debug/2026-05-XX-stock-market-access/`）。
- **SC-M06**: 视觉 0 硬编码——实现文件不含 theme token 外的 hex / rgb 字面量（mockup-driven 视觉，grep 静态分析）。

## Assumptions

- **portfolio 为新 bounded context / module**：本特性首次引入 `portfolio`；module 目录 + Prisma `portfolio` schema + ESLint 边界 + ADR-0032 评估均在 plan/impl 落地（spec 仅声明 `modules: [portfolio]`）。
- **市场偏好 per-user 服务端持久化**：偏好绑定 account，跨设备一致；不走纯客户端本地存储（PRD §5「per user」）。
- **激活态下游传播是网关层职责**：搜索 / 导入 / 行情轮询的市场端点准入 + 熔断机制跨页实现，本 feature 仅保证激活态可读（Out of Scope）。
- **海外市场 V2+**：6 个海外市场 V1 恒不可激活，真实数据接入留后续。
- **鉴权 / 错误格式 / 限流设施复用既有**（JwtAuthGuard / ProblemDetail / throttler）。
- **端点路径为提案**：`GET/PUT /api/v1/portfolio/market-preferences*` 为提案形态；OpenAPI code-first contract 阶段定稿（per [api-contract](../../docs/conventions/api-contract.md)）。

## Out of Scope（本 feature 不做）

- **海外市场真实数据接入**（V2+）。
- **市场端点初始化 / 熔断的网关层实现**（本页只管开关偏好）。
- **激活态向下游的传播机制**（领域事件广播 vs 下游读偏好表）——属网关 / 下游消费方架构，SDD / ADR 后续决。
- **外币 → RMB 折算汇率源**（属 Master §3.3 自选列表 / FX）。
- **A 股「含北交所」在导入 / 搜索层的范围体现**（属导入 / 搜索 PRD）。
- **券商账户**（PRD 02，独立 bounded context）。
