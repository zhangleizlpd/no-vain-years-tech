---
feature_id: 015-marketdata-access-layer
modules: [marketdata]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-06-02'
updated_at: '2026-07-16'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 数据访问层，本 feature 零 mobile/web surface。读侧端点（搜索/报价/详情/K线）作为 server + OpenAPI 契约落地，由后续 013-watchlist / 014-stock-detail feature 消费（mobile 段在那两个 feature）。故无 Web export 冒烟路径。'
agent_friction_observed: false
perf_budgets:
  - endpoint: 'GET /api/v1/marketdata/search'
    p95_ms: 300
    p99_ms: 600
  - endpoint: 'GET /api/v1/marketdata/quote'
    p95_ms: 120
    p99_ms: 250
  - endpoint: 'GET /api/v1/marketdata/instruments/{symbol}'
    p95_ms: 150
    p99_ms: 300
  - endpoint: 'GET /api/v1/marketdata/instruments/{symbol}/bars'
    p95_ms: 200
    p99_ms: 400
state_branches:
  - 'search primary-hit: 东财 searchapi 返候选 → 归一化为 canonical `market:code` + name/type；覆盖 A/HK/US'
  - 'search fallback: 东财 503/超时/配额耗尽 → FallbackChain 平移本地 pg_trgm（名/拼音/代码）→ 返本地候选（需 Instrument 已 seed）'
  - 'search both-empty: 主源空 + 本地无命中 → 返空列表（非 error，非 5xx）'
  - 'quote eod-backed: 标的有最近 DailyBar → 返 {name, price=close, asOf=tradeDate, priceKind=eod_close, change vs prevClose}；Decimal 序列化为 string（2026-06-07 加 name：Instrument 注册即有、与 hasData 正交，013/021 列表行主名数据源）'
  - 'quote no-data: 标的无任何 DailyBar → 显式 no-data 标注（不崩、不返 0、不伪造实时）'
  - 'detail aggregate: 已知 symbol → 聚合 PG 事实层（最近 DailyBar + Fundamental + Financial + CorporateAction）；所有 Decimal 字段序列化为 string'
  - 'detail not-found: 未知 symbol（不在 Instrument 注册表）→ 404 ProblemDetail'
  - 'bars adjust param: adjust=none|forward|backward 各返对应复权行；缺省 adjust 有确定默认；非法 adjust → 400 VALIDATION_FAILED'
  - 'bars period aggregation: period=day 直返日线；week/month/quarter/year 由日线服务端聚合（OHLC 首开/最高/最低/末收 + 量和）；区间无数据 → 空 bars（200 非 error）'
  - 'detail field coverage: 聚合报价 header（最新/涨跌/涨跌幅/昨收）+ 估值+分位 + 财务 + 公司行动 + 身份 + 52 周高低（近 252 日 max/min close）；缺失维度字段 null 不报错'
  - 'vendor constraint enforce: adapter 经共享 VendorHttpClient → 注入必需 header（Lixinger Content-Type/Accept-Encoding gzip）+ 过双窗限频（分+秒任一超即排队不打爆）+ 429/瞬时故障按 profile 退避重试'
  - 'mock default (zero env): 无 LIXINGER_TOKEN → config 解析为 Mock adapter 全家，boot 成功，返确定性 fixtures（dev/test 默认）'
  - 'config fail-fast: kind=live 但 LIXINGER_TOKEN 缺失 → boot 失败（zod discriminated-union，不静默降级）'
  - 'symbol normalization round-trip: canonical `market:code` ↔ vendor symbol（Lixinger stockCode / 东财 secid `1.600519`）双向无损'
---

# Feature Specification: Marketdata 数据访问层（可插拔股票数据访问层 — schema + 8 capability 端口 + 多 vendor adapter + 读侧 API）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-06-02)]**
> 本 feature 引入 **第 5 个 bounded context `marketdata`**（前 4 = `auth` / `account` / `security` / `portfolio`）。落地前须按 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) sunset trigger + [catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 决策问题评估（catalog Q4 = 完全新业务领域 → 新 context，归 `/speckit-plan` 正式裁决）；server 段按 **Flat + Anemic + Moat** 范式（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）。可插拔访问层范式已抽 **[ADR-0047](../../docs/adr/0047-marketdata-pluggable-data-access.md)**（Proposed）。spec 只描述能力与行为，不锁实现技术细节（具体 schema 列 / adapter 类名 / DI 工厂归 plan）。
>
> 🎯 **[流程 — 纯 server 数据层，无 mockup]**
> 本 feature **无 UI**，走 sdd.md 后端业务模块标准流程：`spec → /speckit-clarify → plan → tasks → impl`（无 mockup 步）。读侧端点作为 server + OpenAPI code-first 契约落地，**mobile 消费在后续 013/014 feature**。验证全走 Testcontainers IT + env-gated 真 vendor IT。

**Feature Branch**: `015-marketdata-access-layer`
**Created**: 2026-06-02
**Status**: Implemented（16/16 tasks ship，读端点 EP1-4 在产；clarify 2026-06-02：① schema 仅 6 事实/注册表入 015、3 配置/审计表推迟同步 feature；② 读端点 JwtAuthGuard + ACTIVE 兜底，与 portfolio 一致）
**Module**: `marketdata`（新 bounded context — 统一可插拔股票数据访问层；schema `marketdata`）
**设计源**: [Marketdata Master Plan](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-master.md) + [子 plan 1 访问层](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-p1-access-layer.md) + [ADR-0047](../../docs/adr/0047-marketdata-pluggable-data-access.md) + [PRD-03](../../docs/prd/portfolio/portfolio-03-data-provider-tech-design.md)
**Input**:

- portfolio 多数能力（自选 013 / 详情 014 / 预警 / 策略实验室）依赖统一股票数据层。本 feature = **数据访问层第一阶段（方案A ①）**：先定 schema + capability 端口，背后挂多 vendor adapter，每 adapter 带配置与约束档；读侧 API 验证三场景（搜索 / 报价 / 详情）。
- **8 capability-scoped 端口**：模糊搜索 / universe 枚举 / 交易日历 / EOD 日线（含复权）/ 估值+分位 / 财报衍生 / 公司行动 / 最新报价。
- **多 vendor 可插拔**：理杏仁（已付费可靠源）走 EOD/估值/财报/公司行动；东财（免费）走搜索+universe+日历；本地 pg_trgm 备援搜索；Mock 为 dev/test 默认。config-driven 绑定（discriminated-union）；多源经 FallbackChain。
- **显式 out-of-scope（归下一 feature「marketdata 同步」）**：夜间全量 A 股同步管线 / 配置化元数据驱动 / 重要度分级 / 调度。本 feature 只提供「能取数」的能力与「能读」的 API，**不负责定时把全市场灌进库**。

## Context

- **新 bounded context（勿混 portfolio）**：`marketdata` 是独立股票数据领域（universe / EOD / 估值 / 财报 / 公司行动 / 报价）；`portfolio` 是用户业务领域（市场偏好 / 券商账户 / 自选 / 持仓）。portfolio → marketdata 走只读跨 ctx（DI 注入 read use case，无跨 schema FK，逻辑 `market+code` 关联），per [bounded-context-catalog](../../docs/conventions/server-bounded-context-catalog.md) R2/Q7。
- **可靠性分层（承重调研事实，已落 master §0）**：① 理杏仁 EOD-only、**无模糊搜索、无 universe 枚举**、纯 code-keyed、**双窗限频 1000/min 且 36/s**、强制 header、fundamental 按公司类型分端点；② 东财 searchapi（A/HK/US 模糊搜）+ clist 枚举全 A 股，免费但无 SLA；③ Tushare stock_basic 实际收费。→ 搜索+universe 必靠东财，可靠事实靠理杏仁。
- **能力先于来源（ADR-0047）**：消费者只依赖端口 `Symbol + interface`，不感知背后是哪个 vendor / 是否 fallback；新增 / 切换 vendor 不改消费者。
- **约束是一等公民**：多数外部源都有约束（header / 限频 / 重试语义），故每 adapter 声明 **Vendor Constraint Profile**，由共享传输层统一执行——新 vendor 只填 profile，不重写传输。
- **报价 V1 = EOD 口径**：无实时源，`QUOTE` 端口由 EOD 收盘价支撑（前收算涨跌），响应**显式标注新鲜度**（asOf + priceKind），实时源 later 接入翻转、零消费者改动。
- **金融精度**：价格 / 比率全 `Decimal`（禁 Float）；跨端口 / API 边界序列化为 **string**（避 JSON double 精度损失）。
- **鉴权复用既有**：读侧端点受 `JwtAuthGuard` 保护（账号 ACTIVE 兜底 / RFC 9457 ProblemDetail / `@nestjs/throttler` 限流均已就位，本 spec 引用不重立）——全 app 受 AuthGate，无匿名浏览。
- **数据由「同步」feature 填充**：本 feature 落 schema + 读路径，但 PG 事实层（Instrument 注册表 / DailyBar / Fundamental / …）的**生产灌库属下一 feature**。本 feature 的 IT 用 seed fixtures 验读路径；搜索主路径走东财 live（不依赖库），本地 pg_trgm 备援与 PG 事实读在 seed 数据上验证。

## Clarifications

### Session 2026-06-02

- Q: 9 个 Prisma model 的建表（DDL）落在哪个 feature 的 migration？ → A: **仅事实/注册表（6 表：Instrument / DailyBar / FundamentalSnapshot / FinancialMetric / CorporateAction / TradingDay）入 015**；配置/审计 3 表（SyncDimension / SyncBlacklist / SyncRun）的 DDL **推迟到同步 feature**。理由：「只建你用的表」——015 访问层真正读写的是这 6 张，3 张同步配置/审计表无消费者，连表结构一起留给同步 feature，015 migration 边界干净、不携空表。
- Q: marketdata 读侧端点（搜索/报价/详情/K线）的 auth 模型？ → A: **与 portfolio 一致** —— `JwtAuthGuard` + 账号 status==ACTIVE 兜底 + RFC 9457 ProblemDetail + `@nestjs/throttler`（tracker = JWT sub）。全 app AuthGate 一致，零 auth 变体，防御最稳。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 可插拔多 vendor 数据访问骨架（端口抽象 + config 绑定 + Mock 默认）（Priority: P1）

系统按 capability 定义 8 个端口（`Symbol + interface`）；每端口经 config-driven DI 工厂绑定一个 adapter（discriminated-union `kind: mock|live`）；零 env（dev/test）默认全 Mock，boot 成功并返确定性 fixtures；`kind: live` 但缺必填凭证（如理杏仁 token）→ boot fail-fast。这是其余所有能力的承重底座。

**Why this priority**: ADR-0047 的核心价值——「能力先于来源」。端口抽象 + 可插拔绑定一旦立住，搜索/报价/详情/同步全部挂上去；Mock 默认让全套 IT 无需真 vendor 凭证即可跑。

**Independent Test**: Testcontainers PG+Redis；① 零 env boot → 断言 8 端口全解析为 Mock adapter、健康启动、对各端口调用返确定性 fixtures；② 配 `kind: live` 但不给理杏仁 token → 断言 boot 失败（zod 校验错，非静默降级）；③ 注入一个伪 adapter 替换某端口 → 断言消费者代码零改动仍工作（验抽象不漏 vendor 细节）。

**Acceptance Scenarios**:

1. **Given** 无任何 vendor env，**When** 应用 boot，**Then** 8 端口全绑 Mock adapter，启动成功，各端口返确定性 fixture 数据
2. **Given** config `kind: live` 缺必填凭证，**When** boot，**Then** 失败并报明确校验错（fail-fast，不退默认）
3. **Given** 某端口背后 adapter 被替换，**When** 消费者调用该端口，**Then** 行为按新 adapter，消费者代码无需改动（端口只暴露 `Symbol + interface`）

---

### User Story 2 — [Server] 模糊搜索股票（东财主 + 本地 pg_trgm 备，FallbackChain）（Priority: P1）

搜索端口接受查询串（名 / 拼音 / 代码），主走东财 searchapi（覆盖 A/HK/US），返候选归一化为 canonical `market:code` + 名称 + 类型；主源 503/超时/配额耗尽 → FallbackChain 平移本地 pg_trgm（名/拼音/代码）；两源皆空 → 返空列表（非错误）。服务「搜索页」场景。

**Why this priority**: 搜索是 portfolio 入口能力（自选/详情都从搜到一只股票开始）；东财补理杏仁的搜索缺口；本地 pg_trgm 是离线/降级兜底。

**Independent Test**: Testcontainers PG（seed 若干 Instrument + 拼音）；① mock 东财 adapter 返候选 → 断言归一化 canonical 形态；② mock 东财抛 503 → 断言 FallbackChain 平移本地 pg_trgm、返本地命中；③ 主源空 + 本地无命中 → 断言空列表 200（非 5xx）；④ env-gated 真东财 IT（默认 skip）验真实 MultiMatch 响应解析。

**Acceptance Scenarios**:

1. **Given** 东财可用，**When** 搜索 "茅台" / "maotai" / "600519"，**Then** 返候选含 canonical `cn:600519` + 名称 + 类型，覆盖 A/HK/US
2. **Given** 东财 503/超时，**When** 搜索，**Then** FallbackChain 平移本地 pg_trgm，返本地命中（需 Instrument 已 seed）
3. **Given** 主源空且本地无命中，**When** 搜索冷僻串，**Then** 返空列表（200，非 error）

---

### User Story 3 — [Server] 读取标的事实详情 + K线（PG 事实层聚合 + adjust）（Priority: P1）

详情端口按 symbol 聚合 PG 事实层（最近 EOD + 估值/分位 + 财报衍生 + 公司行动）；K线端口按 `adjust`（none/forward/backward）返对应复权日线序列。未知 symbol → 404。所有 Decimal 序列化为 string。服务「详情页」场景。

**Why this priority**: 详情是 portfolio 第二入口能力（014 详情页直接消费）；adjust 复权是 K 线正确性的硬约束；Decimal-string 是金融精度的跨边界保证。

**Independent Test**: Testcontainers PG（seed Instrument + 多 adjust 的 DailyBar + Fundamental/Financial/CorpAction）；① GET 详情 → 断言聚合四类事实、Decimal 全为 string；② GET bars?adjust=forward → 断言仅前复权行、时序正确；③ GET 未知 symbol → 404 ProblemDetail；④ 非法 adjust → 400 VALIDATION_FAILED。

**Acceptance Scenarios**:

1. **Given** 已 seed 标的事实，**When** GET `/marketdata/instruments/{symbol}`，**Then** 200 + 聚合（最近 DailyBar + Fundamental + Financial + CorporateAction），Decimal 字段均为 string
2. **Given** 标的有三复权 DailyBar，**When** GET `.../bars?adjust=backward`，**Then** 仅返后复权序列，按交易日有序
3. **Given** symbol 不在 Instrument 注册表，**When** GET 详情，**Then** 404 ProblemDetail
4. **Given** `adjust` 传非法值，**When** GET bars，**Then** 400 `VALIDATION_FAILED`

---

### User Story 4 — [Server] 读取最新报价（EOD-backed，asOf + priceKind 显式标注新鲜度）（Priority: P1）

报价端口按 symbols 批量返最新价：V1 由最近 EOD 收盘价支撑，前收算涨跌，响应**显式标注** `asOf`（数据日期）+ `priceKind`（`eod_close`）；无任何 EOD 数据的标的返显式 no-data（不崩、不伪造）。服务「自选列表」场景。读路径优先 Redis 热快照（TTL 至下次 EOD）→ PG。

**Why this priority**: 自选列表（013）逐行显示报价与涨跌；asOf/priceKind 是「新鲜度可见、降级显式」不变性的核心——实时源接入只翻 priceKind，消费者零改。

**Independent Test**: Testcontainers PG+Redis（seed DailyBar 含 prevClose）；① GET quote?symbols= → 断言 price=最近 close、change 基于 prevClose、asOf=tradeDate、priceKind=eod_close、Decimal 为 string；② 某 symbol 无 DailyBar → 断言该项显式 no-data（不影响其余项）；③ 二次请求命中 Redis 热快照（断言不重打 PG/adapter）。

**Acceptance Scenarios**:

1. **Given** 标的有最近 EOD（含前收），**When** GET `/marketdata/quote?symbols=cn:600519`，**Then** 返 {price, change, asOf=tradeDate, priceKind=`eod_close`}，Decimal 为 string
2. **Given** 批量含一个无 EOD 数据的 symbol，**When** GET quote，**Then** 该项显式 no-data，其余项正常返回
3. **Given** 同 symbol 短时间内二次请求，**When** GET quote，**Then** 命中 Redis 热快照（不重复打底层）

---

### User Story 5 — [Server] Vendor 约束统一执行（必需 header + 双窗限频 + 退避重试 + 瞬时等待）（Priority: P2）

每 adapter 声明 Vendor Constraint Profile（`requiredHeaders` / `rateLimit{perMin, perSec}` / `retry{maxAttempts, backoff}` / `transientWait`），共享 `VendorHttpClient` 统一执行——注入必需 header、过双窗限频器（分+秒任一超即排队、不打爆 vendor）、429/瞬时故障按 profile 退避重试。新增 vendor 只填 profile，不重写传输层。

**Why this priority**: 「多数外部源都有约束」是 ADR-0047 立论点；理杏仁双窗限频是真实硬约束（任一超即 429 封）。统一执行是可靠性与合规底座，但消费侧不直接可见，故 P2。

**Independent Test**: 单测 + Testcontainers；① 双窗限频器：构造超 perSec 的突发 → 断言被节流到窗口内（不直接 429-to-caller）；超 perMin 同理；② 必需 header：断言理杏仁 profile 注入 `Content-Type: application/json` + `Accept-Encoding: gzip`；③ 429/瞬时故障 → 断言按 profile 指数退避重试 N 次、瞬时等待 ≥ 阈值；④ env-gated 真理杏仁 IT 验真实限频不触 429。

**Acceptance Scenarios**:

1. **Given** adapter 带 profile `{perSec, perMin}`，**When** 突发请求超窗，**Then** 由共享传输层节流到窗口内（排队），不向调用方直接抛 429
2. **Given** 理杏仁 profile，**When** 发请求，**Then** 必需 header 被注入（Content-Type + Accept-Encoding gzip）
3. **Given** vendor 返 429 / 瞬时故障，**When** 传输层处理，**Then** 按 profile 退避重试 + 瞬时等待，超 maxAttempts 才上抛
4. **Given** 新增一个 vendor，**When** 只声明其 Constraint Profile，**Then** 无需改传输层即获得 header/限频/重试

---

### User Story 6 — [Server] universe 枚举 + 交易日历 + 公司类型路由 能力面（供同步消费）（Priority: P2）

系统提供 universe 枚举端口（东财 clist 枚举全 A 股 code/name/market）、交易日历端口（判断交易日 / backfill 迭代）、以及理杏仁 fundamental 的**公司类型内部路由**（fsType 由 adapter 内部调 `cn/company` 解析并缓存，端口对外仍 `getFundamentals(symbols)`，类型路由不外泄）。本 story 落「能力面」，其**定时调用与全量灌库属下一 feature**。

**Why this priority**: universe/calendar 是同步 feature 的直接输入，须在访问层先备好端口+adapter；但本 feature 不调度它们，故 P2（能力存在性 + 契约正确，非端到端灌库）。

**Independent Test**: Testcontainers + 单测；① mock 东财 clist → 断言枚举返 {market, code, name} 列表、含北交所、归一化 canonical；② mock 交易日历 → 断言判定某日是否交易日；③ fsType 路由：mock `cn/company` 返某公司类型 → 断言 `getFundamentals` 内部路由到对应端点、缓存 companyType、对外签名不含 fsType；④ env-gated 真东财/理杏仁 IT（默认 skip）。

**Acceptance Scenarios**:

1. **Given** 东财 clist，**When** 枚举 universe，**Then** 返全 A 股 {market, code, name}（含北交所），归一化 canonical
2. **Given** 交易日历端口，**When** 查某日，**Then** 正确判定是否交易日
3. **Given** 某标的公司类型未知，**When** 调 `getFundamentals(symbols)`，**Then** adapter 内部解析 fsType + 路由对应端点 + 缓存，端口对外签名不暴露 fsType

---

### Edge Cases

- **搜索主源部分降级**（东财返 200 但结构异常 / 字段缺失）→ 容错解析，跳过坏项不整体失败；必要时平移本地兜底
- **报价批量含未知 symbol**（不在 Instrument 注册表）→ 该项显式 no-data，不污染其余项，不 5xx
- **DailyBar 同 (instrumentId, tradeDate) 但不同 adjust** → 三复权各一行，唯一键含 adjust，读侧按请求 adjust 精确取（修正 PRD 原 `(instrumentId, date)` 唯一键）
- **理杏仁瞬时故障**（其服务端分钟级自检窗口）→ 按 profile `transientWait` 等待后重试，不立即判失败
- **符号归一化未知市场前缀**（非 cn/hk/us）→ 明确拒绝 / 不静默错配 vendor symbol
- **FallbackChain 全节点失败**（东财挂 + 本地空）→ 搜索返空列表（业务非异常）；事实读端点底层全失败 → ProblemDetail（区分「无数据」与「源故障」）
- **Decimal 跨边界**：任何价格/比率字段在 API 边界必为 string；消费方不得收到 JSON number（防精度损失）
- **Redis 热快照与 PG 不一致**（快照过期窗口）→ 以 TTL 至下次 EOD 控制；过期回源 PG 重算

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 系统 MUST 按 capability 定义 8 个端口（搜索 / universe 枚举 / 交易日历 / EOD 日线 / 估值+分位 / 财报衍生 / 公司行动 / 最新报价），每端口为 `Symbol + interface`，消费者仅依赖端口、不感知 vendor。
- **FR-S02**: 每端口 MUST 经 config-driven DI 工厂绑定 adapter（discriminated-union `kind: mock|live`）；配置校验 MUST boot-time fail-fast（`live` 缺必填凭证 → 启动失败，禁静默降级）。
- **FR-S03**: dev/test MUST 零 env 默认全 Mock adapter，boot 成功并返确定性 fixtures（让全套 IT 无需真 vendor 凭证）。
- **FR-S04**: 搜索端口 MUST 主走东财（覆盖 A/HK/US），主源 503/超时/配额耗尽 MUST 经 FallbackChain 平移本地 pg_trgm（名/拼音/代码）；两源皆空 MUST 返空列表（非 error / 非 5xx）；候选 MUST 归一化为 canonical `market:code` + 名称 + 类型。
- **FR-S05**: 详情端口 MUST 按 symbol 聚合 PG 事实层（最近 EOD + 估值/分位 + 财报衍生 + 公司行动）；未知 symbol → 404 ProblemDetail。
- **FR-S06**: K线端口 MUST 支持 `adjust`（none/forward/backward）参数返对应复权日线；缺省有确定默认；非法 adjust → 400 `VALIDATION_FAILED`。MUST 支持 `period`（day/week/month/quarter/year）——`day` 直返 EOD 日线，更粗周期由日线**服务端聚合**（OHLC 区间首开/最高/最低/末收 + 量求和），服务 014 详情图表的多周期 K 线。
- **FR-S07**: 报价端口 MUST 由最近 EOD 收盘价支撑（前收算涨跌），响应 MUST 显式标注 `asOf`（数据日期）+ `priceKind`（V1=`eod_close`）；无 EOD 数据的标的 MUST 返显式 no-data（不崩 / 不伪造）；读路径 MUST 优先 Redis 热快照（TTL 至下次 EOD）→ PG。
- **FR-S08**: 所有金融数值（价格 / 比率 / 市值等）MUST 以 `Decimal` 存储（禁 Float），并在端口 / API 边界 MUST 序列化为 **string**。
- **FR-S09**: 每 adapter MUST 声明 Vendor Constraint Profile（`requiredHeaders` / `rateLimit{perMin, perSec}` / `retry{maxAttempts, backoff}` / `transientWait`）；共享传输层 MUST 统一执行：注入必需 header、**双窗限频**（分+秒任一超即节流排队，不向调用方直接抛 429）、429/瞬时故障按 profile 退避重试 + 瞬时等待。新增 vendor MUST 只需填 profile，不改传输层。
- **FR-S10**: 符号归一化 MUST 封在 adapter 内（纯函数 canonical `market:code` ↔ vendor symbol，双向无损）；未知市场前缀 MUST 明确拒绝，不静默错配。
- **FR-S11**: 理杏仁 fundamental 的公司类型路由（fsType）MUST 在 adapter **内部**解析（调 `cn/company`）并缓存，端口对外签名（`getFundamentals(symbols)`）MUST 不暴露 fsType。
- **FR-S12**: `marketdata` MUST 作为新 bounded context 落地——module 目录 + Prisma `marketdata` schema + ESLint boundaries 单向边界 + `check-server-moat` 注册（per [business-naming](../../docs/conventions/business-naming.md) 强制层 + [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) 评估，归 plan）；跨 ctx 读（portfolio→marketdata）走只读 use case，无跨 schema FK。
- **FR-S13**: 读侧端点 MUST 鉴权（`JwtAuthGuard` + 账号 ACTIVE 兜底 + RFC 9457 ProblemDetail + `@nestjs/throttler` 限流），与既有 use case 一致路径（全 app AuthGate，无匿名访问）。
- **FR-S14**: 可观测性 MUST 复用 `trace_id`（nestjs-cls，015 读路径适用，复用既有 infra）。**幂等 upsert + 事务边界在 HTTP 之外**属**写/落库语义**——015 读端点只读不写，该约束作为 **adapter/schema 契约层声明**，实际 upsert 落库归同步 feature（016），本 feature 无写 task（per Out of Scope + clarify schema 落表范围）。

### Out-of-Scope Functional Boundaries（归下一 feature「marketdata 同步」）

- ❌ 夜间全量 A 股 EOD 同步管线（消费本 feature 端口拉数、写本 feature schema）
- ❌ 配置化元数据驱动同步（SyncDimension / SyncBlacklist 表的调度语义）
- ❌ 数据重要度分级（T0/T1/T2 + work-conserving 预算分配）
- ❌ 调度器（`@nestjs/schedule` + Redis 分布式锁 + SyncRun 水位审计）
- ❌ 规模 / 归档策略（分区 / Parquet 冷存 seam）

> **schema 落地范围说明（clarify 2026-06-02 定）**：本 feature migration **仅建 6 张事实/注册表**（Instrument / DailyBar / FundamentalSnapshot / FinancialMetric / CorporateAction / TradingDay）——访问层真正读写的表。**3 张同步配置/审计表（SyncDimension / SyncBlacklist / SyncRun）的 DDL 连同其写入/消费语义一并推迟到同步 feature**（无消费者，不在 015 携空表）。Prisma `marketdata` schema 在两 feature 间增量演进。

## Key Entities

- **Instrument（universe 注册表）**：`{ market, code, name, type(stock|etf|index), currency, pinyinAbbr, pinyinFull, lixingerCompanyType, listDate, delistDate, status }`——全量 A 股 universe；唯一性 = `(market, code)`；逻辑 id 跨 ctx 无 FK。`pinyin*` 供本地搜索备援，`lixingerCompanyType` 缓存 fsType 路由。
- **DailyBar（EOD 事实）**：`{ instrumentId, tradeDate, adjust(none|forward|backward), open/high/low/close, prevClose, volume, amount, turnoverRate }`——三复权各一行；**唯一键 = `(instrumentId, tradeDate, adjust)`**（修正 PRD 原 `(instrumentId, date)`）；价格全 Decimal。
- **FundamentalSnapshot（日频估值+分位）**：`{ instrumentId, date, peTtm/peStatic/peDynamic, pb, ps, dividendYield, marketCap, circMarketCap, pe/pbPctl(Y3/Y5) }`；唯一 `(instrumentId, date)`；全 Decimal。
- **FinancialMetric（财报衍生）**：`{ instrumentId, reportPeriod('YYYYQn'), roe, grossMargin, eps, bps }`；唯一 `(instrumentId, reportPeriod)`。
- **CorporateAction（公司行动）**：`{ instrumentId, exDate, type(dividend|split|allotment), payload(Json) }`；唯一 `(instrumentId, exDate, type)`。
- **TradingDay（交易日历）**：`{ market, date }`；唯一 `(market, date)`。
- **QuoteSnapshot（读侧投影，非持久表）**：`{ symbol, price, change, asOf, priceKind(eod_close|realtime) }`——显式新鲜度标注；V1 由 DailyBar 投影。
- **VendorConstraintProfile（adapter 声明，非持久表）**：`{ requiredHeaders, rateLimit{perMin, perSec}, retry{maxAttempts, backoff}, transientWait }`——一等公民约束档，共享传输层执行。
- _（SyncDimension / SyncBlacklist / SyncRun 三配置/审计 model **不在本 feature 建表**——其 DDL + 写入/消费语义整体推迟到同步 feature，clarify 2026-06-02 定，见 Out of Scope）_

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: 8 端口抽象 + config-driven 绑定落地，零 env boot 全 Mock 成功、`live` 缺凭证 boot fail-fast（IT 覆盖两路径）。
- **SC-S02**: 搜索三分支（东财主命中 / 503 平移本地 / 双空返空列表）IT 全覆盖；候选归一化 canonical（断言形态）。
- **SC-S03**: 详情聚合四类事实 + adjust 复权正确 + 未知 symbol 404 + 非法 adjust 400（IT 覆盖）；所有 Decimal API 边界为 string（序列化断言）。
- **SC-S04**: 报价 EOD-backed + asOf/priceKind 标注 + no-data 隔离 + Redis 热快照命中（IT 覆盖三分支）。
- **SC-S05**: Vendor 约束统一执行——双窗限频节流（不 429-to-caller）+ 必需 header 注入 + 429/瞬时退避重试（单测 + env-gated 真 vendor IT 覆盖）。
- **SC-S06**: 符号归一化双向无损（property/round-trip 测）；fsType 内部路由不外泄（签名断言）。
- **SC-S07**: `marketdata` bounded context 落地后 ESLint boundaries 单向边界 0 violation、Prisma `marketdata` schema CI 通过、`check-server-moat` 跨 ctx 注释齐全（强制层）。
- **SC-S08**: 真 vendor IT（`LIXINGER_TOKEN` / 东财）env-gated 默认 skip（沿用 `RUN_PERF_IT` 范式），本地/nightly 显式启用可验真实契约解析。

## Assumptions

- **数据由「同步」feature 生产灌库**：本 feature 落 schema + 读路径；PG 事实层的全量填充属下一 feature。IT 用 seed fixtures 验读；搜索主路径走东财 live 不依赖库，本地 pg_trgm 备援/PG 事实读在 seed 上验证。
- **读侧端点 JWT-authed**（clarify 2026-06-02 确认）：与既有 portfolio 端点一致——`JwtAuthGuard` + 账号 ACTIVE 兜底 + throttler（tracker=JWT sub），全 app AuthGate 无匿名浏览；端点路径 `/api/v1/marketdata/*` 为提案，OpenAPI code-first contract 阶段定稿。
- **V1 市场 = A 股**：港股次阶（marketScope 加 'HK'，Lixinger 港股 fundamental 深度待验）；美股待富途。本 feature schema/端口 market-agnostic，但 V1 验证集中 A 股。
- **报价 V1 = EOD 口径**：无实时源；`priceKind=eod_close`；实时源接入翻转 priceKind、零消费者改动（seam 预留）。
- **schema 增量落地**（clarify 2026-06-02 确认）：本 feature migration 仅建 6 张事实/注册表；3 张同步配置/审计表（SyncDimension/SyncBlacklist/SyncRun）的 DDL 推迟到同步 feature，Prisma `marketdata` schema 跨两 feature 增量演进。
- **vendor 约束细节经验测**：理杏仁 EOD 就绪时间 / 批量 code 上限 / fsType 字段名 / adjust 语义、东财端点稳定性等（master §7 风险）在 impl 的 env-gated 真 IT 阶段确认，错则同步漏标/400。
- **鉴权 / 错误格式 / 限流 / Cockatiel 重试 / Redis client 复用既有设施**（不重立）。

## Out of Scope（本 feature 不做）

- **夜间全量 A 股同步管线 + 配置化驱动 + 重要度分级 + 调度 + 规模/归档**——归下一 feature「marketdata 同步」（方案A ②）。
- **mobile 消费**——读侧端点的 mobile UI（搜索页 / 自选列表 / 详情页）归 013-watchlist / 014-stock-detail。
- **实时报价源**——V1 仅 EOD-backed；实时接入 later。
- **港股 / 美股事实数据**——V1 验证集中 A 股；港股次阶、美股待富途。
- **点位时阶 universe / 退市史**——东财当前快照够 V1；回测幸存者偏差留策略实验室阶段（BaoStock sidecar 或买 Tushare 积分）。
- **管理界面**——同步元数据的 CRUD 管理 UI 属更后续。
