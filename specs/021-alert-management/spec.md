---
feature_id: 021-alert-management
modules: [alert]
owners: ['@zhangleizlpd']
depends_on:
  ['013-watchlist', '014-stock-detail', '015-marketdata-access-layer', '017-marketdata-scheduler']
status: implemented
created_at: '2026-06-06'
updated_at: '2026-06-07'
migration_refs: ['20260606_1559_create_alert_context_tables']
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: untested
web_compat_notes: '跨端 feature：server 新 bounded context（alert，Q4 触发 ADR-0032 新 ctx 评估，plan 阶段 ADR 定稿）+ mobile 7 页 UI + 2 处既有页改造（014 详情底栏 bell 接通、013 自选页顶部工具栏）。走统一 mockup-first（per sdd.md）：spec → clarify → mockup → plan → tasks → impl。mockup baseline = 同花顺/富途截图 + user delta（design/ 留痕）。Web export 路径尚未冒烟（draft，untested）。'
agent_friction_observed: false
perf_budgets:
  - endpoint: 'GET /api/v1/alert/instruments/{market}/{code}/alerts (个股预警列表)'
    p95_ms: 100
    p99_ms: 200
  - endpoint: 'GET /api/v1/alert/alerts (全部预警，按标的分组)'
    p95_ms: 150
    p99_ms: 300
  - endpoint: 'POST/PATCH alert CRUD + POST delete-batch'
    p95_ms: 150
    p99_ms: 300
  - endpoint: 'GET /api/v1/alert/messages + unread-count (消息中心列表 + 角标)'
    p95_ms: 100
    p99_ms: 200
state_branches:
  - '创建/编辑校验: 条件数 0 → 拒（至少 1 条）；同类型条件重复 → 拒（同类型限 1 条）；备注 > 22 字 → 拒；价格阈值 ≤ 0 / 涨跌幅阈值出 (0,100] 域 → 拒'
  - 'EOD 评估 PRICE_FALL_TO: 当日最低价 ≤ 阈值 → 条件命中（盘中极值口径）'
  - 'EOD 评估 PRICE_RISE_TO: 当日最高价 ≥ 阈值 → 条件命中（盘中极值口径）'
  - 'EOD 评估 DAILY_GAIN_OVER / DAILY_LOSS_OVER: (收盘-昨收)/昨收 与阈值比较 → 命中（收盘价口径）'
  - 'AND 语义: 预警内全部条件同日命中 → 触发；任一不命中 → 不触发'
  - '提醒频率后置: 仅1次·删除 → 触发后删预警（流水保留）；仅1次·关闭 → 触发后置停用；每日1次 → 保留启用，同一交易日不重复触发'
  - '停用预警 → 不参与评估；重新启用 → 下一评估轮生效'
  - '标的当日无 bar（停牌/未同步）→ 该预警本轮跳过不触发、不报错'
  - '触发 → 写 AlertTrigger 流水（条件实际值快照）→ 消息中心新消息（未读）→ 未读角标计数+1'
  - '消息已读: 进入消息中心提醒 tab → 消息置已读、角标清零'
  - '批量新建: 预警对象选择页选 N 只 → 编辑页完成 → 每只股各建一条独立预警（同一套条件/频率/备注，建后各自独立）'
  - 'unauth / 非 ACTIVE: 全部 alert 端点 → 401（边界，反枚举）'
  - '越权: 操作他人预警/消息 → 404（不泄露存在性）'
---

# Feature Specification: 预警管理 V1（Alert Management — EOD 价格预警 + 应用内消息中心）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-06-06)]**
> server 段按 **Flat + Anemic + Moat** 范式（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）。bounded context 决策树 **Q4 命中**（[catalog](../../docs/conventions/server-bounded-context-catalog.md)）：预警是全新业务领域（auth/account/security/portfolio/marketdata 都不沾）→ **预判新 bounded context `alert`**，plan 阶段按 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) sunset trigger 走评估 + 独立 ADR 定稿（含消息中心归属：V1 消息=仅预警触发，暂归 alert ctx，留 notification ctx seam）。**跨 ctx 面（plan 已定稿）**：仅 alert 评估读 marketdata EOD bar/instrument 数据（参照 018 Q7-B 直查先例，`CROSS-CONTEXT-READ` 探针强制）；**评估调度自治**（plan D1）——alert 自持 cron + `(alertId, tradeDate)` 幂等键，**不挂 [017](../017-marketdata-scheduler/spec.md) 调度链**（底座不反向依赖业务）。business-naming 三处同名落地：`apps/server/src/alert/` + `apps/mobile/src/alert/` + Prisma schema `alert`。
>
> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> UI 业务模块走统一 mockup-first：`spec → /speckit-clarify → mockup → plan（含完整 UI 段）→ tasks → impl`。**mockup baseline 已存在**：同花顺预警 8 屏 + 富途消息通知/自选工具栏 3 屏截图 + user 红字 delta（需求对焦记录已逐屏固化，mockup 阶段以此为底、复用 theme tokens 不重设视觉资产）。跨端 impl per Constitution §V 拆 PR1（server，真后端 IT）/ PR2（mobile，hermetic e2e + contract-smoke）。

**Feature Branch**: `021-alert-management`
**Created**: 2026-06-06
**Status**: Clarified（clarify 2026-06-06 3Q：① 新建预警选标的=「预警对象选择」页（自选 tab 多选批量 + 搜索 tab 即点即用），批量=每只股各建一条独立预警；② 行情条涨停/跌停=板块规则客户端计算；③ 添加条件页分类树仅显示「价格跟踪」。见 § Clarifications）
**Module**: `alert`（新 bounded context 预判，plan 阶段 ADR 定稿；server = 预警 CRUD + EOD 评估引擎 + 触发流水 + 消息中心；mobile = 7 页 + 2 处既有页改造）
**设计源**: [需求对焦记录](../../docs/private/plans/2026-06/06-06-alert-management-v1-scope.md)（8 项决策 + 数据模型 + 页面清单 + backlog 的单一来源）+ [Master PRD §3.5](../../docs/prd/portfolio/portfolio-master-prd.md)（预警引擎定位；§4.4 AST 混合引擎为下期形态）
**前置依赖**: [013-watchlist](../013-watchlist/spec.md)（自选页工具栏改造宿主）+ [014-stock-detail](../014-stock-detail/spec.md)（底栏 bell 占位接通 + 个股页行情条数据）+ [015-marketdata-access-layer](../015-marketdata-access-layer/spec.md)（EOD bar 高/低/收/昨收数据）+ [017-marketdata-scheduler](../017-marketdata-scheduler/spec.md)（EOD 同步完成的评估挂载点）
**Input**:

- 预警管理 = Master PRD §3.5「自动化监控引擎」的 V1 切片。与 user 对焦后大幅收窄（对焦记录 8 项决策）：**EOD 盘后判定**（非 30s 盘中轮询——理杏仁无实时源）、**仅价格跟踪 4 类条件**（技术指标/基本面下期）、**应用内消息中心**（无外部推送）。
- **统一预警模型**（对同花顺的简化）：无组合/独立之分——一个预警 = 1..N 条 AND 条件（同类型限 1 条），独立预警只是 N=1 特例。
- **判定价口径**：涨到/跌到用盘中极值（当日最高/最低价，语义=「今天碰到过」，不漏左侧挂低买点信号）；日涨幅/跌幅用收盘价对昨收。
- **提醒频率三档**：仅 1 次·触发后删除 ｜ 仅 1 次·触发后关闭 ｜ 每日 1 次（默认，每交易日首次满足时提醒）。
- 引擎**不上 AST/短路**（V1 条件少，直接遍历求值，不过度设计）；求值与数据获取解耦留双模 seam，接实时源后升级盘中口径。

## Context

- **为什么现在做**：014 详情页底栏「预警」bell 自 2026-05-29 起 disabled 占位「即将上线」；marketdata 数据底座（015-020）已全部 ship，EOD bar（高/低/收/昨收）、调度链挂载点、个股行情条数据全部就绪——预警是 portfolio V1 拼图中最后一块大监控能力。
- **用户价值**：左侧价值投资者挂低买点/止损位监控。每日收盘后系统代为检查「今天碰到过我的价位没有」，免手动盘后逐股复查。EOD 口径对左侧长线风格够用（不抢盘中时效，抢的是「不漏」）。
- **per-account 数据**：预警/触发流水/消息均归属 account（复用 `JwtAuthGuard` / status==ACTIVE / RFC 9457 ProblemDetail，引用不重立）；标的引用业务主键 `market + code`（V1 仅 `cn`）。
- **评估时机**：每交易日当日 bar 落库后评估一轮——实现为 **alert 自治定时评估 + `(alertId, tradeDate)` 幂等判重**（plan D1：主跑在每日同步窗口之后，翌晨 catch-up 兜同步晚到；重复评估天然 no-op，不依赖 017 的「完成信号」）。
- **消息中心是预警的触达面**：V1「App推送」语义 = 应用内消息中心 + 未读角标（零外部推送依赖）。消息内容 = 触发流水的展示投影：股票名(代码) + 命中条件及实际值 + 触发时间。
- **入口拓扑**：自选页工具栏（放大镜 + 预警铃铛→全部预警页 + 消息信封·红点→消息通知页）／详情页底栏 bell→个股预警页／个股预警页右上角→全部预警页。

## Clarifications

### Session 2026-06-06

- Q: 全部预警页「新建预警」的选标的来源与流程？ → A: **「预警对象选择」页**（user 补 2 张截图固化）：「自选」tab = 自选标的 checkbox 多选列表 + 全选 + 底部「去添加」（批量）；「搜索」tab = 搜索框 + 结果行带「添加」按钮（即点即用，单只直进编辑页，匹配文字高亮 + 市场标签）。**批量语义 = 每只股各建一条独立预警**（同一套条件/频率/备注一次应用到 N 只股，建后各自独立编辑/启停）。固化 FR-M04 / FR-M09 / US4 / state_branches。
- Q: 个股预警页行情条「涨停/跌停」两列怎么做（015 报价无此字段）？ → A: **按板块规则从昨收客户端计算**——代码段判板块（主板 ±10% / 创业·科创 ±20% / 北交 ±30%）+ 名称含 ST 判 ±5%，纯函数实现；新股首日无限制等边角料允许不准（展示参考为主）。固化 FR-M01。
- Q: 添加条件页左侧分类树 V1 形态（仅价格跟踪 4 条件可用）？ → A: **仅显示「价格跟踪」一个分类**（不做死 UI 置灰占位）；左树 + 右列表 + 搜索框结构保留，下期新增条件类型时分类随之出现。固化 FR-M03。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 创建与维护预警（个股预警页 + 编辑页 + 添加条件页）(Priority: P1)

用户在股票详情页点底栏「预警」进入个股预警列表页（顶部行情条 + 预警卡片），点「添加预警」进入编辑页：通过「添加附加条件」从条件库（V1 价格跟踪 4 类）选条件并输入参数，设置提醒频率（默认每日 1 次）与备注（≤22 字可空），完成保存。既有预警可编辑（改条件/参数/频率/备注）、单独启停（卡片 toggle）、单条删除（编辑页「删除预警」）。

**Why this priority**: 预警的全部价值从「能配出一条预警」开始；CRUD 是评估引擎与消息中心的数据前提，独立即构成可演示 MVP（配置态闭环）。

**Independent Test**: 不依赖评估引擎——创建含 2 条件的预警 → 列表卡片显示条件摘要多行 + 频率/备注信息行 → 编辑改参数 → toggle 停用 → 删除，全程数据正确持久化。

**Acceptance Scenarios**:

1. **Given** 标的无预警, **When** 添加预警：条件「股价跌到 13.00」+「日跌幅超 7.00%」、频率每日 1 次、无备注, **Then** 列表出现卡片：两行条件摘要 +「每日1次 未备注」信息行 + 启用态 toggle（无「组合预警」标签）
2. **Given** 编辑页已有「股价跌到」条件, **When** 再次尝试添加「股价跌到」类型, **Then** 被拒（同类型限 1 条），提示建多个预警实现不同阈值分别提醒
3. **Given** 编辑页, **When** 删除条件至 0 条并保存, **Then** 拒绝保存（至少 1 条条件）
4. **Given** 备注输入 23 个字, **When** 输入, **Then** 截断/拒绝在 22 字（计数器 n/22）
5. **Given** 启用中的预警, **When** 卡片 toggle 关闭, **Then** 预警置停用、不参与后续评估；再次开启 → 下一评估轮生效

---

### User Story 2 - EOD 评估触发与提醒频率后置动作 (Priority: P1)

每个交易日 EOD 数据同步完成后，系统对全部启用中预警评估一轮：预警内全部条件按口径求值（跌到→当日最低价、涨到→当日最高价、日涨/跌幅→收盘对昨收），全部命中则触发——写触发流水（含各条件实际值快照），并按提醒频率执行后置动作（删除预警/停用预警/保留）。

**Why this priority**: 评估引擎是预警的兑现端——没有它 US1 只是表单。与 US1 同为 P1，二者合计构成最小价值闭环。

**Independent Test**: 服务端独立可测——造 EOD bar 数据（触线/不触线/边界值），跑评估，断言触发流水与后置动作，不需要 UI。

**Acceptance Scenarios**:

1. **Given** 预警「股价跌到 13.00」启用、当日 bar 最低价 12.80 收盘 14.20, **When** EOD 评估, **Then** 触发（盘中极值口径：碰到过 13.00 即算）
2. **Given** 预警「股价跌到 13.00」+「日跌幅超 7.00%」、当日最低 12.80 但跌幅仅 5%, **When** 评估, **Then** 不触发（AND 语义：任一不命中即整体不命中）
3. **Given** 频率=仅 1 次·触发后删除 的预警触发, **When** 评估完成, **Then** 预警被删除、触发流水保留可回看
4. **Given** 频率=每日 1 次 的预警昨日已触发且今日条件仍满足, **When** 今日评估, **Then** 再次触发（每交易日 1 次）；同一交易日内不重复
5. **Given** 标的当日停牌（无当日 bar）, **When** 评估, **Then** 该预警本轮跳过，不触发不报错
6. **Given** 预警处于停用态, **When** 评估, **Then** 不参与求值

---

### User Story 3 - 消息中心触达与未读角标 (Priority: P2)

预警触发后，用户在自选页工具栏看到消息信封红点（未读角标），进入消息通知页「提醒」tab 看到触发消息（股票名(代码) + 命中条件及实际值 + 触发时间，时间倒序）；进入后消息置已读、角标清零。「待办」tab 保留为 disabled 占位。

**Why this priority**: 触达面——没有它用户必须主动翻预警页才知道触发。P2 因为 US1+US2 已可用触发流水验证核心价值。

**Independent Test**: 造触发流水 → 角标计数正确 → 消息列表渲染正确 → 进入后已读清零。

**Acceptance Scenarios**:

1. **Given** 2 条预警今日触发且未读, **When** 打开自选页, **Then** 消息信封显示红点；进入消息通知页「提醒」tab 见 2 条消息（倒序，含条件实际值）
2. **Given** 用户停留在消息通知页, **When** 返回自选页, **Then** 红点消失（已读）
3. **Given** 无任何触发, **When** 进入消息通知页, **Then** 提醒 tab 空态；「待办」tab 可见但 disabled
4. **Given** 消息通知页, **Then** 无右上角搜索/设置图标、无「服务号」tab（对富途参考的 delta）

---

### User Story 4 - 全部预警页跨标的管理 (Priority: P2)

用户从自选页工具栏预警铃铛（或个股预警页右上角「全部预警」）进入全部预警页：按股票分组展示（股票行带行情，点击进该股个股预警页），每条预警可就地 toggle/编辑；市场 Tab V1 仅 A股。底栏 = 选择删除 + 新建预警。

**Why this priority**: 多标的预警的总览面；单标的路径（US1）已可用，本页是规模化管理增强。

**Independent Test**: 造 3 只股票各 1-3 条预警 → 分组渲染/行情行/就地 toggle/下钻跳转正确。

**Acceptance Scenarios**:

1. **Given** 3 只 A股共 5 条预警, **When** 进入全部预警页, **Then** 按股票分 3 组，组头显示股票名+现价/涨跌，组内预警卡片可 toggle/编辑
2. **Given** 全部预警页, **When** 点「新建预警」, **Then** 进入「预警对象选择」页：自选 tab 多选 N 只点「去添加」→ 编辑预警页 → 完成后每只股各建一条独立预警；或搜索 tab 结果行点「添加」→ 单只直进编辑页
3. **Given** 全部预警页, **Then** 无「智能预警」master toggle（对同花顺的 delta）；市场 Tab 仅 A股

---

### User Story 5 - 批量选择删除 (Priority: P3)

个股预警页/全部预警页点「选择删除」进入多选模式：卡片变 checkbox、底部全选 + 删除、右上角完成退出。

**Why this priority**: 清理效率增强；单条删除（US1 编辑页）已覆盖基本需求。

**Independent Test**: 多选 2/3 条删除 → 仅选中项被删；全选 → 全删；完成 → 退出多选态。

**Acceptance Scenarios**:

1. **Given** 个股 3 条预警进入选择删除模式, **When** 勾 2 条点删除, **Then** 2 条删除、1 条保留、退出多选态
2. **Given** 多选模式, **When** 点全选再点删除, **Then** 该页预警全删
3. **Given** 多选模式未勾任何项, **Then** 删除按钮 disabled

---

### User Story 6 - 入口接通与自选页工具栏改造 (Priority: P3)

014 详情页底栏「预警」bell 由 disabled 占位接通为入口（→ 个股预警页）；自选页顶部工具栏改造：放大镜（搜索，替换原「+」）+ 预警闪电铃铛（→ 全部预警页）+ 消息中心信封带未读红点（→ 消息通知页），去掉 AI 位。

**Why this priority**: 导航胶水——页面本体（US1-US4）可经直接路由验证，入口接通是最后的串联。

**Independent Test**: 详情页 bell 可点且跳转正确；自选页工具栏 3 图标渲染与跳转正确；红点随未读数出现/消失。

**Acceptance Scenarios**:

1. **Given** 股票详情页, **When** 点底栏「预警」, **Then** 进入该标的个股预警页（不再是「即将上线」提示）
2. **Given** 自选页, **Then** 工具栏从左到右：放大镜、预警铃铛、消息信封（无 AI 入口）；有未读触发消息时信封带红点

---

### Edge Cases

- 标的当日无 bar（停牌/新股未同步/数据缺失）→ 评估跳过该预警，不触发不报错（state_branch）
- 非交易日（周末/节假日）→ 无 EOD 同步完成信号 → 无评估轮，自然静默
- EOD 同步部分失败（个别标的缺当日 bar）→ 缺数据的预警跳过，有数据的正常评估（不因个别失败阻塞整轮）
- 「日跌幅超」遇昨收缺失（如新上市首日）→ 该条件无法求值 → 视为不命中（AND 下整体不触发）
- 用户在评估进行中编辑/删除预警 → 以评估启动时快照或行级一致性兜底，不产生半触发态（plan 定具体策略）
- 触发后「仅1次·删除」的预警，其触发消息仍完整可读（消息引用流水快照而非活预警）
- 同一标的多条预警同日同时触发 → 各自独立出消息（不合并）
- 价格阈值输入 0/负数/超长小数 → 表单校验拒绝；涨跌幅阈值域 (0,100]
- 越权访问他人预警/消息 → 404 反枚举（state_branch）
- 退市/移出自选的标的预警 → 不自动删除；无新 bar 则自然永不触发（V1 不做清理，备注于 Assumptions）

## Requirements _(mandatory)_

### Functional Requirements

#### Server

- **FR-S01**: 系统 MUST 提供预警 CRUD：创建/编辑（条件集、频率、备注）/删除/启停，归属当前登录 account，标的为 `market + code`（V1 仅 cn）
- **FR-S02**: 预警 MUST 含 1..N 条条件（AND 语义）；同类型条件 MUST 限 1 条；条件类型 V1 限定 4 类：股价涨到（PRICE_RISE_TO）/ 股价跌到（PRICE_FALL_TO）/ 日涨幅超（DAILY_GAIN_OVER）/ 日跌幅超（DAILY_LOSS_OVER）；服务端 MUST 校验：条件 ≥1、价格阈值 >0、涨跌幅阈值 ∈ (0,100]、备注 ≤22 字
- **FR-S03**: 提醒频率 MUST 支持三档：仅 1 次·触发后删除 / 仅 1 次·触发后关闭 / 每日 1 次（默认）；触发后系统 MUST 按档执行后置动作（删除预警/置停用/保留）
- **FR-S04**: 系统 MUST 在每交易日 EOD 数据同步完成后评估一轮全部启用中预警；求值口径：PRICE_FALL_TO 用当日最低价 ≤ 阈值、PRICE_RISE_TO 用当日最高价 ≥ 阈值、DAILY_GAIN_OVER / DAILY_LOSS_OVER 用收盘对昨收涨跌幅与阈值比较；标的缺当日 bar 则跳过
- **FR-S05**: 触发 MUST 写 AlertTrigger 流水：预警快照（条件集、频率、备注）+ 各条件实际值 + 触发时间；流水 MUST 独立于预警生命周期（预警删除后流水保留）；「每日1次」档 MUST 以流水判重保证同一交易日至多触发 1 次
- **FR-S06**: 系统 MUST 提供消息中心读端点：触发消息列表（时间倒序，内容=股票名(代码)+命中条件及实际值+触发时间）+ 未读计数 + 置已读；未读状态 MUST 服务端持久（多设备一致）
- **FR-S07**: 个股预警列表 / 全部预警（按标的分组）读端点 MUST 提供；全部预警 MUST 可与行情数据组合渲染（行情走 015 既有端点 client-side merge，不在 alert 端点内联）
- **FR-S08**: 全部 alert 端点 MUST 仅对登录且 ACTIVE 账号开放（401 边界）；跨账号访问 MUST 404 反枚举

#### Mobile

- **FR-M01**: 个股预警列表页 MUST 含：顶部行情条（名/代码/最新价/涨跌额/涨跌幅/涨停/跌停，行情复用 015 报价；涨停/跌停由昨收按板块规则客户端纯函数计算：代码段判板块 ±10%/±20%/±30% + 名称含 ST 判 ±5%，边角料允许不准）、预警卡片（条件摘要多行 + 编辑笔 + toggle + 频率/备注信息行，无「组合预警」标签）、右上角「全部预警」、底栏「选择删除 + 添加预警」（单按钮，无组合/独立之分）
- **FR-M02**: 编辑/新建预警页 MUST 含：条件区（「同时满足 N 项条件后预警」动态计数；每行=名称+参数+删除）、「添加附加条件」、推送方式只读行（固定「App推送」）、提醒频率三档 sheet（默认每日 1 次）、备注输入（n/22 计数）、「删除预警」（编辑态）、右上角完成
- **FR-M03**: 添加条件页 MUST 含：搜索框 + 左侧分类树 + 右侧条件列表「添加」；分类树 V1 仅显示「价格跟踪」一个分类（4 条件，不做置灰占位），参数输入为简单数值 sheet（精细弹出设计=下期）
- **FR-M04**: 全部预警页 MUST 按股票分组（组头=股票名+行情，点击下钻个股预警页）、组内卡片就地 toggle/编辑、市场 Tab 仅 A股、底栏「选择删除 + 新建预警」、无智能预警 toggle；新建预警 MUST 经「预警对象选择」页（FR-M09）再进编辑页
- **FR-M05**: 选择删除模式 MUST 支持：单选/全选 checkbox、底部删除（未选时 disabled）、右上角完成退出；个股预警页与全部预警页行为一致
- **FR-M06**: 消息通知页 MUST 含：「提醒」tab（默认，触发消息倒序）+「待办」tab（disabled 占位）；无「服务号」tab、无右上角搜索/设置；进入提醒 tab MUST 置已读
- **FR-M07**: 自选页顶部工具栏 MUST 改造为：放大镜（搜索，替换原「+」）+ 预警闪电铃铛（→ 全部预警页）+ 消息信封（→ 消息通知页，未读时红点）；去掉 AI 位
- **FR-M08**: 014 详情页底栏「预警」bell MUST 由 disabled 占位接通为个股预警页入口
- **FR-M09**: 「预警对象选择」页 MUST 含两 tab：「自选」= 自选标的 checkbox 多选列表 + 全选 + 底部「去添加」（批量进编辑页，完成时每只股各建一条独立预警）；「搜索」= 搜索框（复用既有标的搜索能力）+ 结果行「添加」按钮（单只直进编辑页，匹配文字高亮 + 市场标签）；标题带市场后缀（V1 固定 A股）

### Key Entities

- **Alert（预警）**: 归属 account；标的 `market + code`；条件集 1..N（AND，同类型限 1）；提醒频率三档；备注 ≤22 字可空；启用/停用态
- **AlertCondition（预警条件）**: 类型（V1 四类价格条件）+ 阈值参数；从属于 Alert
- **AlertTrigger（触发流水）**: 触发时间 + 预警快照（条件集/频率/备注）+ 各条件实际值；独立于 Alert 生命周期；兼任消息中心数据源与「每日1次」判重依据
- **消息已读状态**: per-account 未读集合/计数，服务端持久，驱动信封角标

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户从股票详情页出发，30 秒内可完成一条含 2 条件预警的创建（无文档辅助、首次使用）
- **SC-002**: 每交易日评估主跑触发后 5 分钟内，全部启用预警完成评估且触发消息在消息中心可见（同步晚到场景由翌晨 catch-up 轮兜底，同样 5 分钟内）
- **SC-003**: 求值正确性 100%：四类条件 × 触发/不触发/边界值（等于阈值）× 三档频率后置动作，全部由自动化测试覆盖且通过
- **SC-004**: 「每日1次」档预警在同一交易日内至多产生 1 条触发消息；「仅1次」两档触发后不再产生新消息
- **SC-005**: 未读角标与消息中心实际未读数 100% 一致（含多设备场景：服务端单一真相）
- **SC-006**: 既有功能零回归：014 详情页底栏其余 3 项、013 自选页列表行为不受工具栏改造影响（既有 e2e 全绿）

## Assumptions

- **EOD-only 口径已与 user 对焦确认**（对焦记录决策 #1）：触发提醒发生在收盘数据同步后，非盘中实时；对左侧长线风格够用。盘中轮询、AST/短路引擎、技术指标/基本面条件、外部推送（系统 push/PushPlus/飞书）均为下期 backlog（对焦记录 § 下期 backlog），不在本 spec scope
- 市场范围 V1 仅 `cn`（A股），与 016 `marketScope=['cn']` 现状对齐；港/美股 Tab 不出现或置灰
- 预警数量 V1 不设业务上限（自用规模）；服务端仅做常识性防护（如分页）
- 退市/长期停牌标的的预警不自动清理：无新 bar 自然不触发，用户手动删除
- 触发消息 V1 不设保留期清理（数据量小）；消息删除能力不做（已读即可）
- 「待办」tab 为 disabled 占位，无任何功能（user 截图标注「保留 disabled」）
- 评估调度自治（plan D1）：定时评估 + tradeDate 幂等键，不依赖 017「同步完成」信号；非交易日/停牌 = 最新 bar 的 tradeDate 已评估过 → 天然 no-op，无需独立交易日历判断
- 行情展示（个股页行情条/全部预警组头）复用 015 报价端点 client-side merge（与 014 同范式），alert 端点不内联行情
