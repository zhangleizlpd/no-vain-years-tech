---
feature_id: 013-watchlist
modules: [portfolio]
owners: ['@zhangleizlpd']
depends_on: ['015-marketdata-access-layer', '016-marketdata-sync']
status: implemented
created_at: '2026-05-29'
updated_at: '2026-06-07'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: untested
web_compat_notes: 'portfolio 第三特性，依赖 01 portfolio 模块骨架 + 015-marketdata（行情走 mobile client 调 /quote merge、加自选 mini 搜索走 /search；015 已 ship）+ 016-marketdata-sync（夜间灌库让 /quote 返真数据；已 ship）。Web export 路径尚未冒烟（draft，untested）。走统一 mockup-first（per sdd.md）：spec → clarify → mockup → plan → tasks → impl；UI impl 定稿前补真后端冒烟（Playwright Expo Web）。新增 quote.up/down/flat theme token（涨红跌绿，impl 落 colors.ts）。'
agent_friction_observed: false
perf_budgets:
  - endpoint: 'GET /api/v1/portfolio/watchlist-groups'
    p95_ms: 100
    p99_ms: 200
  - endpoint: 'GET /api/v1/portfolio/watchlist-groups/{groupId}/items'
    p95_ms: 120
    p99_ms: 250
  - endpoint: 'PATCH /api/v1/portfolio/watchlist-groups (reorder/visibility)'
    p95_ms: 150
    p99_ms: 300
state_branches:
  - 'groups (new user): GET → 仅系统组「自选」(默认落点) +「持仓」；均 visible，order 固定；不可删/改名'
  - 'groups (custom): 用户建组 → type=custom，全 CRUD（删/改名/隐藏/拖拽序）'
  - 'group reorder/visibility: PATCH 拖拽序 / 隐藏切换 → 持久化；隐藏组不出现在主列表 Tab'
  - 'items list: GET 某组 items → {market, code, pinned, order, color, noteRef}；标的名称不入本契约(ADR-0048 server 不 join 015)，由 015 /quote 返 name(2026-06-07 修订：原决策 A「/quote 不返 name、行以 market+code 为主名」翻案——name 是 marketdata 自有数据非跨 ctx join，行主名=name 回落 code)；行情值(最新/涨幅/涨跌)由 mobile client 调 015 /quote merge，不落本表'
  - 'holdings group: 派生自持仓事实(份额>0)，只读不可手动移出；holdings/import 未建 → V1 该组为空(结构在)'
  - 'item ops: 删除/固顶/移到最前/移到最后/改分组/颜色 → 持久化；固顶区常驻顶 > 非固顶区(移到最前/最后在区内调位)'
  - 'holdings item delete: 持仓组内标的「删除」灰显禁用(份额>0 事实驱动)；其余操作(固顶/颜色/笔记)可用'
  - 'unauth / 非 ACTIVE: 所有端点 → 401（边界，反枚举）'
---

# Feature Specification: Watchlist（自选列表 — 分组 Tab + 长按菜单 + 分组管理）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-05-29)]**
> server 段按 **Flat + Anemic + Moat** 范式（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）；属 `portfolio` bounded context（与 01/02 共模块）。行情值由 **mobile client 直调 [015-marketdata](../015-marketdata-access-layer/spec.md) `/quote`（EOD-backed）client-side merge、不在本特性 server 段拉取**（013 与 015 运行时**零跨 ctx**，仅共享 `market:code` 逻辑键，per 015 plan §决策；设计源仍 [PRD-03 数据层技术设计](../../docs/prd/portfolio/portfolio-03-data-provider-tech-design.md)）；持仓组派生自导入特性（未建，V1 空）。
>
> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> UI 业务模块走统一 mockup-first：`spec → /speckit-clarify → mockup（先行）→ plan → tasks → impl`。纪律：① clarify 干净再 mockup；② UI impl 定稿前真后端冒烟；③ mockup 复用 theme tokens（涨跌用**新增** quote.up/down/flat token，PRD §7），不重设已有视觉资产。

**Feature Branch**: `013-watchlist`（设计阶段在 `investment`，impl 再开分支）
**Created**: 2026-05-29
**Status**: Clarified（clarify 2026-05-29：OQ1 V1 加自选=04 自带临时添加入口 / OQ2 删自定义组 item 回落「自选」不丢；OQ3 quote hex 留 mockup，见 § Clarifications）
**Module**: `portfolio`（分组 CRUD + 自选项 CRUD + 排序/可见性持久化；依赖 01 模块骨架 + 015 行情/搜索端点，mobile 直调 client-side merge）
**PRD**: [portfolio-04-watchlist-prd.md](../../docs/prd/portfolio/portfolio-04-watchlist-prd.md)
**Input**:

- 自选列表 = portfolio「资产总览与监控标的的**动态分流池**」（Master §3.3），借鉴同花顺。用户用**分组**组织关注标的，分组 Tab 横滑切换，长按标的快捷操作。
- **系统组**（自动生成，只能隐藏 / 拖拽，不可删改）：仅「自选」（默认落点）+「持仓」（份额 > 0 自动驱动）。
- **自定义组**：用户自建，可删 / 重命名 / 隐藏 / 拖拽。市场 / 券商**不自动建组**（跨维筛选属过滤器，V1 延后）。
- 三屏：**主列表（图一）↔ 长按菜单（图二）↔ 分组管理（图三，由 ☰ 进入）**。
- 行情数值（最新 / 涨幅 / 涨跌）**涨红跌绿**，由 mobile client 调 015 `/quote` merge、本页只渲染。

## Context

- **系统组 vs 自定义组**：系统组 `type=system`（`systemKind ∈ {watchlist, holdings}`），随账号自动存在、不可删 / 改名、可隐藏 + 拖拽序；自定义组 `type=custom`，全 CRUD。
- **持仓组派生只读**：「持仓」成员派生自持仓事实（份额 > 0），**非用户手动维护**的 WatchlistItem（实现可为只读视图）；用户不可手动移出。**holdings / import 特性未建 → V1 持仓组为空（结构在，无源数据）**。
- **行情消费、不拉取**：行情快照（最新 / 涨幅 / 涨跌）**不落本表**（Master §4.1 动静分离）。本特性 server 段**不读行情**；真值由 **mobile client 直调 015 `/quote`（EOD-backed）client-side merge**（013 与 015 运行时**零跨 ctx**，per 015 plan §决策）。015 已 ship。
- **涨跌专用 token（新增）**：`quote.up`（红）/ `quote.down`（绿）/ `quote.flat`（灰），**不复用** `err`（红）/ `ok`（绿）——语义相反避免混淆（PRD §7）。impl 落 `apps/mobile/src/theme/colors.ts`；本批 mockup 提案 hex，不改代码。
- **业务主键**：WatchlistItem 业务主键 = `market + code`（per Master §4.1）。`market` 取值统一用 015 `Instrument.market` 词表 **`cn` / `hk` / `us`**（**不做映射**）；01 `market_preference.market` 同步对齐到该词表（marketCode 由 `CNY/HKD/USD` 改 `cn/hk/us`、保留原 ISO 币种字段，独立 fix 分支落）。canonical symbol `cn:600519` 可直接喂 015 `/quote`；WatchlistItem 外指 015 `Instrument` 注册表（逻辑 `market+code` 关联，无跨 schema FK）。
- **复用既有设施**：`JwtAuthGuard` / status==ACTIVE / RFC 9457 ProblemDetail / `@nestjs/throttler` —— 引用不重立。
- **多入口同一操作**：「分组·颜色」「笔记」既是长按菜单项，也是个股详情页底栏（Master §3.4）的操作——长按菜单 ≈ 详情底栏。详情页（014）/ 笔记为**外部特性**（本特性不建，见 Out of Scope）；模糊搜索由 **015 `/search`** 提供（本特性加自选 mini 搜索入口调它）。

## Clarifications

### Session 2026-05-29

- Q: V1 怎么加自选标的？（双入口搜索 / 详情当时均未建） → A: **04 自带临时添加入口**（手输 market+code 或 mini 搜索），让 V1 可用 + 可自测 + 冒烟有真实数据路径；后续详情特性落地后并存 / 替换。固化 FR-M07 / US6。（注：模糊搜索现由已 ship 的 015 `/search` 支撑。）
- Q: 删非空自定义分组时组内 item 怎么处理？ → A: **item 回落「自选」组，不丢**（与 02 删券商归属回落默认账户同款「不丢」哲学）。固化 FR-S02 / Edge case。
- **OQ3 quote.up/down/flat 具体 hex** → 留 **04 mockup 决**（涨红跌绿，A 股惯例；不复用 err #EF4444 / ok #10B981 精确值，需区分语义）；非 spec clarify。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 分组 CRUD + 系统组语义（Priority: P1）

已登录用户管理分组：系统组「自选」「持仓」随账号自动存在（不可删 / 改名，可隐藏 + 拖拽序）；自定义组全 CRUD。

**Why this priority**: 分组是自选组织骨架；系统组语义是不变性基座。

**Independent Test**: Testcontainers PG；① 新账号 GET 分组 → 恰 2 系统组（自选 + 持仓，visible，order 固定）；② 建自定义组 → type=custom，可改名 / 删 / 隐藏；③ 尝试删 / 改名系统组 → 拒绝（4xx）；④ PATCH 拖拽序 + 隐藏切换 → 持久化。

**Acceptance Scenarios**:

1. **Given** 新账号，**When** GET 分组，**Then** 恰 2 系统组（「自选」「持仓」，type=system，不可删 / 改名）
2. **Given** 用户建自定义组「核心仓」，**When** GET，**Then** 含该组（type=custom，全 CRUD）
3. **Given** 系统组，**When** 尝试删除 / 重命名，**Then** 4xx（系统组受保护）
4. **Given** 多组，**When** PATCH 拖拽序 / 隐藏切换，**Then** 持久化；隐藏组标记 visible=false
5. **Given** 未认证 / 非 ACTIVE，**When** 任一端点，**Then** 401

---

### User Story 2 — [Server] 自选项 CRUD + 排序 + 归属（Priority: P1）

用户在分组内管理标的：加入 / 删除 / 固顶 / 移到最前 / 移到最后 / 改归属分组 / 颜色 / 笔记关联；排序优先级 = 固顶区常驻顶 > 非固顶区。

**Why this priority**: 自选项是核心数据；排序语义（固顶 vs 移动）是同花顺范式刚需。

**Independent Test**: Testcontainers PG；预置某组若干 item；① 固顶某 item → 排序常驻顶；②「移到最前」一个非固顶 item → 位于固顶项下方；③ 改归属分组 → item 移到目标组；④ 删除 → 移除；⑤ 持仓组 item（派生）→ 删除被拒 / 灰显语义（份额>0 事实驱动）。

**Acceptance Scenarios**:

1. **Given** 组内多 item，**When** 固顶某 item，**Then** 该 item 常驻分组最顶（重排后仍固定）
2. **Given** 有固顶项 + 非固顶项，**When**「移到最前」一个非固顶项，**Then** 它位于固顶项**下方**（非固顶区头部）
3. **Given** item，**When** 改归属分组到组 X，**Then** item 出现在组 X
4. **Given** item，**When** 删除，**Then** 从当前组移除
5. **Given** 持仓组派生 item（份额>0），**When** 尝试手动删除 / 移出，**Then** 拒绝（份额事实驱动，只读）

---

### User Story 3 — [Mobile] 自选主列表 + 分组 Tab 横滑 + 涨红跌绿（Priority: P1）

用户在主列表浏览某组标的（名称 + 代码 + 最新 + 涨幅 + 涨跌，涨红跌绿），分组 Tab 横滑切换，末尾 ☰ 进分组管理。

**Why this priority**: 主视图；分组 Tab + 涨跌色是核心呈现。

**Independent Test**: mock 分组 + 某组 items（含 stub 行情）→ 渲染主列表 → 断言列头（名称｜最新｜涨幅｜涨跌）、每行 名+代码 + 三列数值涨红跌绿（涨 quote.up / 跌 quote.down / 平 quote.flat）、Tab 横滑切换组、末尾 ☰；隐藏组不出现在 Tab。（render 走 Playwright Web，涨跌色逻辑走 vitest）

**Acceptance Scenarios**:

1. **Given** 某组有 items，**When** 渲染，**Then** 列头「名称 ｜ 最新 ｜ 涨幅 ｜ 涨跌」+ 每行 股票名+代码 + 三列数值；涨用 quote.up（红）/ 跌用 quote.down（绿）/ 平用 quote.flat（灰）
2. **Given** 多个可见组，**When** 横滑 Tab，**Then** 切换到对应组列表；隐藏组不在 Tab 出现
3. **Given** Tab 末尾 ☰，**When** 点击，**Then** 进入分组管理（屏 3）
4. **Given** 行情数值，**When** 渲染，**Then** 由 mobile client 调 015 `/quote` merge（本页 server 段不拉取）；015 未就位 / 无数据时显示占位（如 `--`）

---

### User Story 4 — [Mobile] 长按标的快捷菜单（Priority: P1）

长按某标的弹菜单 6 项：删除 / 固顶 / 移到最前 / 移到最后 / 分组·颜色 / 笔记（无批量操作）；持仓组标的「删除」灰显禁用。

**Why this priority**: 主交互；长按菜单 ≈ 详情底栏（多入口同一操作）。

**Independent Test**: 长按某行 → 弹 6 项菜单 → 各项触发对应操作（删除 / 固顶 / 移动 / 改分组颜色 / 笔记）；持仓组标的菜单「删除」灰显禁用，其余可用。

**Acceptance Scenarios**:

1. **Given** 普通组标的，**When** 长按，**Then** 弹菜单：删除 / 固顶 / 移到最前 / 移到最后 / 分组·颜色 / 笔记（**无批量操作**）
2. **Given** 持仓组标的，**When** 长按，**Then**「删除」灰显禁用，其余（固顶 / 颜色 / 笔记）可用
3. **Given** 点「固顶」，**When** 执行，**Then** 标的常驻分组顶部
4. **Given** 点「分组·颜色」/「笔记」，**When** 执行，**Then** 进入对应操作（颜色标记 / 笔记入口——笔记为外部特性，V1 入口形态见 § Open Questions）

---

### User Story 5 — [Mobile] 全部分组管理（屏 3）（Priority: P1）

用户由 ☰ 进入「全部分组」：新建分组、隐藏系统组、拖拽排序、删除 / 重命名自定义组。

**Why this priority**: 分组组织入口；拖拽序决定主列表 Tab 顺序。

**Independent Test**: 进分组管理 → 每组行 = 组名 + 标的数量 + 👁(隐藏切换) + ☰(拖拽手柄)；系统组只能隐藏 + 拖拽（无删 / 改名）；自定义组隐藏 + 删 + 重命名 + 拖拽；拖拽序 → 主列表 Tab 顺序同步；隐藏组不在 Tab。

**Acceptance Scenarios**:

1. **Given** 分组管理屏，**When** 渲染，**Then** 每组行 = 组名 + 标的数 + 👁 + ☰；标题「全部分组」+ 右上「新建分组」
2. **Given** 系统组行，**When** 操作，**Then** 仅隐藏 + 拖拽（无删除 / 重命名入口）
3. **Given** 自定义组行，**When** ⋯ 菜单，**Then** 隐藏 / 删除 / 重命名可用
4. **Given** 拖拽重排,**When** 完成，**Then** 主列表 Tab 顺序同步；隐藏组不在 Tab 出现

---

### User Story 6 — [Mobile] 添加自选标的（V1 入口）（Priority: P2）

用户把标的加入分组（默认落「自选」组）。

**Why this priority**: 自选项来源；但**双入口（全局搜索 / 详情页调分组）均为未建外部特性** → V1 添加入口形态见 § Open Questions OQ1。

**Independent Test**: 据 OQ1 结算口径测（V1 临时添加入口 vs 依赖外部特性 + seed/mock 演示）。

**Acceptance Scenarios**:

1. **Given** 添加某标的，**When** 未指定分组，**Then** 默认落「自选」组（per PRD §6）
2. **Given** OQ1 结算的 V1 入口，**When** 添加，**Then** 标的进入目标组（具体入口形态待 clarify）

---

### Edge Cases

#### Server Edge Cases

- **删除非空自定义组** → 组内 item **回落「自选」组**（不丢数据，clarify 2026-05-29 定，非级联删）
- **隐藏所有组**（含系统组）→ 主列表 Tab 空？至少保留「自选」可见 vs 允许全隐藏 → 倾向：系统组可隐藏但主列表至少兜底「自选」（plan 定）
- **同 item 重复加入同组** → 幂等（market+code 在组内唯一）
- **固顶 / 移动 / 排序并发**（多端）→ 末次写入；order 持久化策略 plan 定
- **持仓组写操作**（手动加 / 删 item 到持仓组）→ 拒绝（派生只读）

#### Mobile Edge Cases

- **空组**（无 item）→ 空态文案
- **持仓组 V1 空**（holdings 未建）→ 空态 + 说明（「持仓数据待导入功能」）
- **大量标的** → 列表虚拟化（流畅滚动，NFR）
- **行情 provider 未就位 / 拉取失败** → 数值占位 `--`，不阻塞列表
- **长按与滚动 / 横滑手势冲突** → 手势库优先级（plan 定）
- **拖拽排序与 Tab 横滑冲突**（分组管理屏拖拽 vs 主列表横滑）→ 分屏隔离（不同屏，无冲突）

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 系统 MUST 对已登录账号返回其分组列表；系统组「自选」（systemKind=watchlist，默认落点）+「持仓」（systemKind=holdings）随账号自动存在，**不可删 / 改名**，可隐藏 + 拖拽序。
- **FR-S02**: 自定义组 MUST 支持全 CRUD（新建 / 删除 / 重命名 / 隐藏 / 拖拽序，type=custom）。**删非空自定义组（clarify 2026-05-29）**：组内 item MUST 回落「自选」组（不丢数据），非级联删除。
- **FR-S03**: 系统 MUST 持久化分组顺序（拖拽序）+ 可见性（隐藏切换）；顺序 / 可见性是主列表 Tab 呈现的真相源。
- **FR-S04**: 系统 MUST 支持自选项 CRUD：加入分组（默认「自选」）/ 删除 / 改归属分组 / 颜色标记 / 笔记关联（noteRef）。
- **FR-S05**: 排序 — 系统 MUST 支持 固顶 / 移到最前 / 移到最后；**排序优先级 = 固顶区常驻分组顶 > 非固顶区**（移到最前 / 最后只在非固顶区内调位）。
- **FR-S06**: 持仓组派生只读 — 持仓组成员 MUST 派生自持仓事实（份额 > 0），用户**不可手动加 / 删 / 移出**；写操作 → 拒绝。**holdings / import 未建时 V1 持仓组为空**（结构在）。
- **FR-S07**: 行情消费 — 自选项行情值（最新 / 涨幅 / 涨跌）**不落本表**；本特性 server 段**不读行情**，由 **mobile client 调 015 `/quote`（EOD-backed）client-side merge**（013 与 015 运行时零跨 ctx，per 015 plan §决策）。
- **FR-S08**: 业务主键 = `market + code`（per Master §4.1）；`market` MUST 用 015 `Instrument.market` 词表 `cn`/`hk`/`us`（与 01 `market_preference.market` 对齐到同一词表，**不做映射**）；同组内 `market+code` 唯一。
- **FR-S09**: GET/POST/PATCH/DELETE MUST 鉴权；未认证 / 非 ACTIVE → 401 ProblemDetail。
- **FR-S10**: 错误响应 MUST 遵循 RFC 9457 ProblemDetail。
- **FR-S11**: 系统 MUST 对端点限流（复用 `@nestjs/throttler`，阈值 plan 定）。
- **FR-S12**: 属 `portfolio` context；行情 / 搜索经 **mobile client 直调 015 端点 client-side merge**，013 server 与 015 **运行时零跨 ctx**（仅共享 `market:code` 逻辑键，per 015 plan §决策）——无 server 端 cross-ctx use case 直 DI；portfolio module 边界单向（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 规则）。

### Mobile Functional Requirements

- **FR-M01**: 主列表 MUST 顶部分组 Tab 横滑：顺序 = 用户拖拽序，隐藏组不显示，末尾 ☰ → 分组管理。**去掉** Tab 下方左侧两图标（编辑 + 排序 / 筛选，入口暂不做）。
- **FR-M02**: 主列表 MUST 列头「名称 ｜ 最新 ｜ 涨幅 ｜ 涨跌」；每行 = 股票名 + 代码（**去掉**板块标签 融 / 创 / 科创）+ 三列数值。
- **FR-M03**: 最新 / 涨幅 / 涨跌数值 MUST **涨红跌绿**：新增 `quote.up`（红）/ `quote.down`（绿）/ `quote.flat`（灰）token，**不复用** err / ok（PRD §7）；行情 provider 未就位 → 占位 `--`。
- **FR-M04**: 长按标的 MUST 弹菜单 6 项：删除 / 固顶 / 移到最前 / 移到最后 / 分组·颜色 / 笔记（**无批量操作**）；持仓组标的「删除」灰显禁用，其余可用。
- **FR-M05**: 分组管理屏（屏 3）MUST：标题「全部分组」+ 右上「新建分组」；每组行 = 组名 + 标的数 + 👁（隐藏切换）+ ☰（拖拽手柄）；系统组仅隐藏 + 拖拽，自定义组隐藏 + 删 + 重命名（⋯）+ 拖拽。
- **FR-M06**: 拖拽序结果 MUST 决定主列表 Tab 顺序；隐藏组不在 Tab 出现。
- **FR-M07**: 添加自选 MUST 默认落「自选」组。**V1 入口（clarify 2026-05-29）**：04 自带临时添加入口（手输 market+code 或 mini 搜索，搜索经 015 `/search`），让 V1 可用 + 可冒烟；后续详情「调分组」入口落地后并存 / 替换（视觉形态 mockup 定）。
- **FR-M08**: 视觉 MUST 复用 theme tokens（一律浅色，不引深色）；项目无 Tab 栏 / 长列表 / 长按菜单 / 拖拽排序组件——新组件视觉规格留 mockup；颜色标记调色板（PRD §8）mockup 定。
- **FR-M09**: a11y — Tab `accessibilityRole='tab'`；长按菜单项 / 分组管理行 `accessibilityRole` + label；拖拽手柄 / 隐藏切换可达；涨跌色不作唯一信息载体（数值符号 +/- 辅助，色盲友好）。

### Key Entities

- **Group（分组）**：`{ id, accountId, name, type: system|custom, systemKind: watchlist|holdings|null, visible: bool, order: int }`——系统组随账号自动存在不可删 / 改名；自定义组全 CRUD。
- **WatchlistItem（自选标的）**：`{ id, groupId, market, code, pinned: bool, order: int, color, noteRef }`——业务主键 `market+code`；行情快照**不落本表**（mobile client 调 015 /quote merge）。
- **持仓组成员（派生，非持久 WatchlistItem）**：份额 > 0 的标的投影（只读视图）；holdings / import 特性提供，V1 空。
- **行情快照（注入，非本特性实体）**：最新 / 涨幅 / 涨跌——mobile client 调 015 `/quote`（V1 = EOD 收盘）client-side merge。

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: 新账号返回恰 2 系统组（自选 + 持仓）；系统组不可删 / 改名（4xx）；自定义组全 CRUD（集成测试覆盖）。
- **SC-S02**: 分组顺序 / 可见性持久化（拖拽序 + 隐藏切换，重进保持；集成测试）。
- **SC-S03**: 自选项 CRUD + 排序语义（固顶常驻顶 > 非固顶区；移到最前在固顶下方）正确（集成测试覆盖排序优先级）。
- **SC-S04**: 持仓组派生只读——手动写持仓组被拒（集成测试）；V1 持仓组空（holdings 未建）。
- **SC-S05**: 鉴权 401 + 限流 429（集成测试）。
- **SC-S06**: portfolio module 边界 0 violation；与 015 运行时零跨 ctx（行情 / 搜索 client-side merge，无 server cross-ctx use case 直 DI）。

### Mobile Measurable Outcomes

- **SC-M01**: 主列表渲染列头 + 行（名+代码 + 三列数值）；涨红跌绿用 quote.up/down/flat（不复用 err/ok）；provider 未就位占位 `--`（vitest 涨跌色逻辑 + Playwright Web render）。
- **SC-M02**: 分组 Tab 横滑切换 + 隐藏组不显示 + ☰ 进分组管理（Playwright Web）。
- **SC-M03**: 长按菜单 6 项 + 持仓组删除灰显禁用（断言菜单项 + disabled 态）。
- **SC-M04**: 分组管理：系统组仅隐藏 + 拖拽 / 自定义组全 CRUD；拖拽序 → Tab 顺序同步（Playwright Web）。
- **SC-M05**: 验证落**正交两层**（per [sdd.md §V](../../docs/conventions/sdd.md)，旧「真后端冒烟」合并措辞已拆）：① **hermetic UI e2e**（Playwright Web）登录 → 自选主列表（mock 015 行情）→ 横滑 Tab → 长按某标的固顶 → 进分组管理建组 / 拖拽 → 截图归档；② **契约冒烟**（Contract-Smoke，node 层打 testcontainers 真 server）建组 + 加自选验真落库 + 契约对齐。
- **SC-M06**: 视觉 0 硬编码——实现文件不含 theme token 外 hex / rgb（含新 quote token；mockup-driven，grep）；涨跌不仅靠色（符号辅助，a11y）。

## Assumptions

- **依赖 01 + 015 + 016**：portfolio 模块骨架（01）+ 015 行情 `/quote` + 搜索 `/search`（mobile 直调 client-side merge，已 ship）+ 016 夜间灌库（让 `/quote` 返真数据而非仅 stub，已 ship）；分组 / 自选项 CRUD 本身不依赖 015/016（仅行情 / 搜索显示依赖）。
- **持仓组 V1 空**：holdings / import 特性未建 → 持仓组结构在、无源数据（V1 空态）。
- **行情 V1 = EOD 收盘**（per 015，无实时）；涨跌按昨收算。
- **分组 / 自选项 per-account 服务端持久化**（与 01/02 同范式）。
- **新增 quote.up/down/flat token**：impl 落 `apps/mobile/src/theme/colors.ts`（涨红跌绿，A 股惯例）；本批 mockup 提案 hex。
- **笔记 / 详情 / 过滤器 / FX / 追踪池策略池**均为外部 / 后续特性（Out of Scope）；模糊搜索由 015 `/search` 提供。

## Open Questions（已于 `/speckit-clarify` 2026-05-29 结算，见 § Clarifications）

- **OQ1 — V1 添加自选入口** → ✅ **04 自带临时添加入口**（手输 market+code / mini 搜索，搜索经 015 `/search`），后续详情入口并存（FR-M07）。
- **OQ2 — 删非空自定义组 item 处理** → ✅ **回落「自选」组，不丢**（FR-S02 / Edge case）。
- **OQ3 — quote.up/down/flat 具体 hex** → ✅ 留 **04 mockup 决**（涨红跌绿，A 股惯例；不复用 err/ok 精确值）。

## Out of Scope（本 feature 不做）

- **实时行情拉取 / 降级**（Master §4.4/4.5）——本页 client 调 015 `/quote` 只读消费；015/016 定数据层与同步。
- **持仓数据来源**（导入特性）——持仓组依赖它，未建则空。
- **跨市场 / 跨账户过滤器**（图一去掉的两图标对应能力）——V1 延后。
- **外汇折算 RMB**（Master §3.3）——依赖 FX 牌价，延后。
- **追踪池 / 策略池**（Master §3.3 / §3.7）——V2。
- **个股详情 / K 线 / 笔记编辑**（长按外的下钻 + 笔记本体）——属详情 / 笔记 PRD；本特性仅留长按菜单入口（笔记入口形态见 OQ1 关联讨论）。
- **颜色标记调色板设计**（PRD §8）——mockup 决。
