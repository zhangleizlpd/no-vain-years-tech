---
feature_id: 039-hk-marketdata-quant-signals
modules: [marketdata]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-07-13
updated_at: 2026-07-13
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 端数据摄取 —— 港股新增 5 个量化高信号维度（做空/南向持股/所属指数/公募基金持股/基金公司持股）同步进 PG，零 mobile/web surface。新增 5 张 market-agnostic 事实表（含 instrument FK），但不新增读端点（读侧 015 market-agnostic 天然覆盖；本 feature 只让 PG 事实层多出这 5 类 market=hk 真数据）。无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - '做空 hk 日频回填: 单只港股 short-selling 按区间拉 → ShortSellingDaily (instrumentId,date) 落 shares/amount，重复运行幂等无重复行'
  - '南向持股 hk 日频回填: 港股通标的 mutual-market 按区间拉 → ConnectHoldingDaily (instrumentId,date) 落 shareholdings，幂等'
  - '南向非成分标的空数据: 非港股通标的 mutual-market 返 0 行 → 不写库、不崩、不阻塞工作集其余标的'
  - '所属指数快照覆盖: indices 无日期快照 → IndexMembership (instrumentId,indexCode) 覆盖式 upsert，反映该股当前所属指数集合'
  - '公募基金持股报告期回填: fund-shareholders 按区间拉 → FundHolding (instrumentId,reportDate,fundCode) 多行 upsert（报告期×基金），字段缺失存 null'
  - '基金公司持股报告期回填: fund-collection-shareholders 按区间拉 → FundCompanyHolding (instrumentId,reportDate,fundCollectionCode) 多行 upsert'
  - 'param 单数 stockCode 请求形态: 这 5 端点以单数 stockCode 请求（数组 stockCodes 被 vendor 拒 400）→ adapter 每端点按其真实 param 契约构造请求'
  - '5 维度 marketScope 纳入: 新增 5 个 sync_dimension 行 marketScope={hk} → 工作集含 hk 标的，统一消费共享令牌桶'
  - '5 张新表 market-agnostic: 新表均 instrument_id FK + market 经 instrument 携带，无 hk_* 前缀，将来 A 股同类可无缝并入'
  - '依赖 universe: 5 维度均 soft-依赖 universe（标的须先注册）→ universe 未跑时工作集为空、不误建标的'
  - 'vendor 字段缺失: 某标的某维度 vendor 返 null/缺字段（如南向 proportionOfOutstandingSharesA）→ 存 null 不崩（沿 015 端口层契约）'
  - '回填自限速续跑: 5 维度回填沿用 p1 自限速 ~10/s + jitter + 共享 concurrency=1 串行 → 不触 429；中断后按自然键幂等续跑'
  - 'p1/A股无回归: 新增 5 维度不改现有 6 维（universe/profile/eod_bar/fundamental/financial/corporate_action）与 A 股同步行为，既有 IT/单测全绿'
---

# Feature Specification: 港股量化高信号数据同步（做空 / 南向 / 所属指数 / 基金持股）

**Feature Branch**: `039-hk-marketdata-quant-signals`
**Created**: 2026-07-13
**Status**: Implemented
**Input**: 隶属 [master p2](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md「p2 量化高信号」)；端点/字段/param 真实性见 [p2 探查报告](../../docs/private/plans/2026-07/07-13-hk-marketdata-p2-probe-report.md)（2026-07-13 prod 77 read-only PoC 实测）。依赖已完成的 [p1（specs/038）](../038-hk-marketdata-core/spec.md)：平台市场缝隙已激活、核心 6 维已落 prod（server v0.15.4）。

## Clarifications

### Session 2026-07-13

- Q: 公募基金持股/基金公司持股（fund_holding/fund_company_holding）回填多长历史？ → A: **近 5 年**（`sync_dimension.history_depth=1825`）。单股 3 年即 ~11680 行（报告期×基金），全量 10yr 成巨表；近 5 年平衡机构持仓因子回测长度与存储可控（不逼近分区阈值）。CLI `--history-depth` 可覆盖。
- Q: 所属指数（index_membership）建模——追踪历史成分变更还是仅当前快照？ → A: **覆盖式当前快照**（每次同步 upsert 覆盖）。vendor `hk/company/indices` 只返当前成分快照、无日期、无法回填历史成分，故只维护当前归属，不追踪历史成分变更。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 日频高信号因子（做空比率 + 南向资金流）可用于回测 (Priority: P1)

量化研究员需要港股近 10 年的**每日做空**（做空股数/金额，可派生做空比率）与**南向资金持股**（互联互通南向持股数，可派生南向资金净流入），作为择时与情绪类因子。这两类均为**日频、结构最简**（做空 2 字段、南向 1 字段），与现有日频维度（eod_bar）同构，是本 feature 最快可落地、信号密度最高的切片。

**Why this priority**: 日频高信号（做空、南向流）是量化择时最常用的市场微观结构因子，落地成本低、回测价值高 → P2 子 plan 的 MVP 切片。

**Independent Test**: 对港股通样本股（如 `hk:00700`）跑 short-selling / mutual-market 两维度回填后，查 PG `short_selling_daily` 与 `connect_holding_daily` 出现该标的近 10 年 `market=hk`（经 instrument FK）的日频行；非港股通标的的南向维度返 0 行、不写库不崩。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的, **When** 做空维度按区间回填, **Then** `short_selling_daily` 出现该标的多年日频做空行（`(instrumentId,date)` 唯一），重复运行幂等
2. **Given** 港股通（南向可交易）标的, **When** 南向维度按区间回填, **Then** `connect_holding_daily` 出现该标的日频南向持股行
3. **Given** 非港股通标的, **When** 南向维度运行, **Then** vendor 返 0 行 → 不写库、不报错、不阻塞工作集其余标的
4. **Given** p1 已上线的 6 维同步, **When** 新增这两维度上线, **Then** 现有维度与 A 股同步行为零回归

---

### User Story 2 - 机构持仓因子（公募基金持股 + 基金公司持股）可用于回测 (Priority: P2)

量化研究员需要港股按报告期的**公募基金持股**（各基金对该股的持仓/市值/净值占比/市值排名）与**基金公司持股**（各基金公司口径持仓），用于机构持仓变动、抱团/调仓类因子。数据形态为报告期×基金（潜在大表）。

**Why this priority**: 机构持仓是中低频但高价值的因子；数据量大、建模更重，故次于日频高信号。

**Independent Test**: 对样本股跑 fund-shareholders / fund-collection-shareholders 回填后，查 `fund_holding`（多行报告期×基金）与 `fund_company_holding`（报告期×基金公司）出现该标的关联行；抽样与理杏仁网站核对一致；字段缺失（如 `proportionOfOutstandingSharesA`）存 null 不崩。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的, **When** 公募基金持股维度回填, **Then** `fund_holding` 按 `(instrumentId,reportDate,fundCode)` 落多期多基金持仓行
2. **Given** 已注册港股标的, **When** 基金公司持股维度回填, **Then** `fund_company_holding` 按 `(instrumentId,reportDate,fundCollectionCode)` 落行
3. **Given** vendor 某字段缺失, **When** 写库, **Then** 该字段存 `null`、不崩、不阻塞其余标的

---

### User Story 3 - 指数成分归属可用于因子分组 (Priority: P3)

量化研究员需要知道每只港股当前**所属哪些指数**（如恒生指数、港股全指等），用于按指数成分做因子分组、成分筛选与基准对齐。

**Why this priority**: 成分归属是静态/低频的分组维度，价值实在但非高频信号，故 P3。

**Independent Test**: 对样本股跑 indices 维度后，查 `index_membership` 出现该标的当前所属指数集合（`(instrumentId,indexCode)`）；再次运行以覆盖式 upsert 反映最新归属。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的, **When** 所属指数维度运行, **Then** `index_membership` 落该股当前所属的多个指数行（覆盖式 upsert）
2. **Given** 该股指数归属发生变化, **When** 维度再次运行, **Then** membership 以**覆盖式 upsert** 反映最新集合（旧归属消失被删）；仅维护当前快照，不追踪历史成分变更（vendor 无历史成分数据）

---

### User Story 4 - 运维分多夜安全回填、不触发风控、不影响 p1/A股 (Priority: P3)

运维需要把这 5 类数据按各自形态（做空/南向日频 10 年；基金持股/所属指数按报告期/快照）分多夜温和回填，沿用 p1 已验证的自限速 + jitter + 续跑机制，且不干扰既有 A 股与港股核心 6 维同步。

**Why this priority**: 交付方式而非数据内容；沿用 p1 现成 pacing 基建，故 P3。

**Independent Test**: `backfill --markets hk --dimension short-selling --dry-run` 等命令打印的请求数估算与量级吻合；小批真回填期间监控令牌桶排队与 `SyncRun`，sustained rate 在自限速内、无 429、p1/A股同步不受影响。

**Acceptance Scenarios**:

1. **Given** 5 维度以 `--markets hk` 触发回填, **When** 估算与执行, **Then** 请求量估算与工作集均按 hk 统计/过滤
2. **Given** 回填期自限速开启, **When** 持续拉取, **Then** 有效 sustained rate ≤ 自限速目标（~600/min）、不触发 429
3. **Given** 新维度回填 job 与 p1/A股同步 job 同队列, **When** 都排队, **Then** 因共享单一限流预算 + `concurrency=1` 天然串行
4. **Given** 回填被限额/中断, **When** 下一夜续跑, **Then** 已同步行按自然键幂等跳过、从断点续

### Edge Cases

- **param 契约与 p1 相反**：这 5 端点以**单数 `stockCode`** 请求（数组 `stockCodes` 被 vendor 拒 `HTTP 400`），与 p1 fundamental/fs range 端点的「必须数组」约定相反 → 每端点按其真实 param 契约构造，不可跨端点套用。
- **南向覆盖稀疏**：仅约 600 港股通标的有南向持股数据，其余在市股返 0 行 → 属正常空数据，非错误。
- **fund-holding 潜在大表**：单股 3 年即约 11680 行（报告期×基金），全量远超 master INV-5 估算 → 需明确历史深度与裁剪策略（见 FR-005 clarification）。
- **indices 无历史**：vendor 返回当前成分快照（无日期）→ 覆盖式建模，非日频 append。
- **字段命名残留**：基金持股两端点均含 `proportionOfOutstandingSharesA`（名带 `A`，hk 返 null，疑理杏仁 A 股字段复用）→ 存 null，不因命名歧义丢弃。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 系统 MUST 新增 5 个同步维度并将其工作集扩展到 `hk`：做空（short-selling）、南向持股（mutual-market）、所属指数（indices）、公募基金持股（fund-shareholders）、基金公司持股（fund-collection-shareholders）；各维度经其 `marketScope` 配置驱动，沿用现有 marketScope 过滤机制。
- **FR-002**: 系统 MUST 能对港股按 per-stock 时间区间回填**做空**与**南向持股**的近 10 年日频序列（做空：做空股数/金额；南向：南向持股数），持久化为独立日频事实表。
- **FR-003**: 系统 MUST 能同步港股**所属指数**成分归属（该股当前所属的指数集合），以覆盖式方式维护当前归属。
- **FR-004**: 系统 MUST 能按报告期回填港股**公募基金持股**（各基金持仓/市值/净值占比/市值排名等）与**基金公司持股**（各基金公司口径持仓）。
- **FR-005**: 公募基金持股/基金公司持股的历史回填深度 MUST 受控为**近 5 年**（`sync_dimension.history_depth=1825`），避免大表无界增长（单股 3 年即 ~11680 行、5 年 ~19500 行）；CLI `--history-depth` 可运维覆盖。
- **FR-006**: 5 个新维度的持久化 MUST 使用 market-agnostic 事实表 + `instrument_id` 外键（`market` 经 instrument 携带），表名 MUST NOT 带市场前缀（`hk_*`），以便将来 A 股同类数据无缝并入（master INV-1）。
- **FR-007**: 各端点的请求 MUST 按其真实 param 契约构造（这 5 端点为单数标的参数），系统 MUST 对无数据/空返回（如非港股通标的的南向、稀疏报告期）容错——不写库、不报错、不阻塞工作集其余标的。
- **FR-008**: 5 维度同步 MUST 沿用「vendor 字段缺失存 `null`、单标的失败隔离」的既有容错契约。
- **FR-009**: 5 维度回填 MUST 沿用 p1 已验证的保守多夜 pacing：在共享限速（900/min、36/s）之下叠加自限速（~10/s、~600/min）+ 抖动，与 p1/A股同步共享单一限流预算并因单并发队列天然串行；MUST 幂等且中断后可从进度/自然键续跑。
- **FR-010**: 回填运维命令 MUST 支持按维度 + `--markets hk` 触发，请求量估算与工作集均按市场范围作用（复用 p1 的 `--markets` 透传与 dry-run 估算）。
- **FR-011**: 新增 5 维度 MUST NOT 改变现有 6 维（p1）与 A 股同步的既有行为（零回归）。

### Key Entities _(include if feature involves data)_

- **ShortSellingDaily（做空日频）**: `(instrumentId, date)` 唯一；字段 做空股数（shares）、做空金额（amount）。日频，port 到 `daily_bar` 同构的日频形态。
- **ConnectHoldingDaily（南向持股日频）**: `(instrumentId, date)` 唯一；字段 南向持股数（shareholdings）。仅港股通标的有行。
- **IndexMembership（所属指数归属）**: `(instrumentId, indexCode)` 唯一；字段 指数名（name）、来源（source）。当前成分快照，覆盖式 upsert（仅当前快照，不追踪历史成分）。
- **FundHolding（公募基金持股）**: `(instrumentId, reportDate, fundCode)` 唯一；字段 持仓（holdings）、持仓市值（marketCap）、净值占比（netValueRatio）、市值排名（marketCapRank）、公告日（declarationDate）、基金名（name）。潜在大表。
- **FundCompanyHolding（基金公司持股）**: `(instrumentId, reportDate, fundCollectionCode)` 唯一；字段 持仓市值（marketCap）、持仓（holdings）、基金公司名（name）。
- **SyncDimension（同步维度配置）**: 已含 `marketScope String[]` / `cronExpr` / `batchSize` / `historyDepth` 等；本 feature = 新增 5 个维度行（`marketScope={hk}` + 各自 cron/depth）+ `sync_dependency`（各 soft-依赖 universe）。
- **Instrument（标的）**: 复用；5 张新表均以 `instrument_id` FK 关联（`market='hk'` 经此携带）。

## Success Criteria _(mandatory)_

- **SC-001**: 量化研究员能从统一表取到样本港股的日频做空（做空股数/金额）与南向持股序列，覆盖近 10 年（视标的与港股通纳入时长），样本与理杏仁网站核对一致率 100%。
- **SC-002**: 5 个维度均能产出 `market='hk'`（经 instrument FK）的持久化事实行；港股通标的南向覆盖、做空标的做空覆盖分别 ≥ 95%（无数据标的按空记录，不静默丢失）。
- **SC-003**: 新增 5 维度上线后，p1 核心 6 维与 A 股既有同步/读取行为零回归（既有集成/单测全绿）。
- **SC-004**: 5 类数据的历史回填期间无 429、无账号风控触发；有效持续调用速率不超过自限速目标。
- **SC-005**: 机构持仓（公募/基金公司）与指数成分归属可按标的检索，支撑机构持仓变动与成分分组类因子实验；fund-holding 表在既定历史深度下存储量级可控（不逼近需分区阈值）。

## Assumptions

- 依赖 p1（specs/038）已交付的平台缝隙（marketScope 过滤、adapter 市场路径插值、`--markets` 透传、自限速 pacer、universe/instrument 注册）—— 本 feature 只新增维度，不改平台机制。
- 5 端点均为 `hk/company/*`，2026-07-13 prod PoC 实测 `/hk/` 路径 code=1 生效、param 为单数 stockCode、字段 schema 见 p2 探查报告。
- 这 5 端点**不使用 `metricsList`**（返回固定字段结构）→ 不存在 p1 #670 的 all-or-nothing 静默 0 行风险。
- 做空/南向为日频、支持 per-stock 区间回填（形态同 eod_bar）；基金持股为报告期形态；所属指数为无日期快照。
- 沿用「仅在市股（active-only）」范围与 syncTier 分层排序（复用 p1/038 决策）；退市股不纳入。
- 南向持股仅约 600 港股通标的有数据属正常（非全量 2700 股）。
- 存储与限流基建（PG、令牌桶、BullMQ 单并发队列、共享 `LIXINGER_HTTP_CLIENT`）沿用现状，本 feature 不新增同步基础设施（仅新增 5 张事实表 + migration）。
- mutual-market 的第二端点（`market-data/mutual-market` 南向行情）不在本 feature 范围（行情已由 eod_bar 覆盖；南向仅取持股口径）。
