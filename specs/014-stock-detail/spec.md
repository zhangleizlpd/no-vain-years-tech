---
feature_id: 014-stock-detail
modules: [portfolio]
owners: ['@zhangleizlpd']
depends_on: ['015-marketdata-access-layer', '016-marketdata-sync']
status: implemented
created_at: '2026-05-29'
updated_at: '2026-06-04'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: untested
web_compat_notes: 'portfolio 第四特性，依赖 01 模块骨架 + 015-marketdata（详情/K线/报价 EP3/EP4/EP2，mobile 直调，已 ship）+ 016-marketdata-sync（夜间灌库让端点返真数据；已 ship）+ 04 自选（加/删自选状态）。走统一 mockup-first（per sdd.md；含 K 线数据可视化，图表库选型与 mockup 互锁）：spec → clarify → mockup → plan → tasks → impl；UI impl 定稿前补真后端冒烟（Playwright Expo Web）。复用 quote.up/down/flat token（04 新增，涨红跌绿）。Web export 路径尚未冒烟（draft，untested）。'
agent_friction_observed: false
perf_budgets:
  # 详情(detail)/K线(bars) 端点已迁 015-marketdata (EP3/EP4)，perf budget 归 015 spec frontmatter (SSOT)；
  # mobile 直调 015。014 server 段仅留 watchlist-status (读 04 自选态判定是否已在自选)。
  - endpoint: 'GET /api/v1/portfolio/instruments/{market}/{code}/watchlist-status (自选态 inWatchlist + 分组归属 memberships)'
    p95_ms: 100
    p99_ms: 200
state_branches:
  # 详情/K线/报价的状态分支 (detail aggregate / detail not-found / bars adjust / bars period aggregation /
  # quote eod-backed) 已迁 015-marketdata (EP3/EP4/EP2)，由 015 spec state_branches + IT 覆盖；mobile 直调 015。
  # 014 server 段仅 watchlist-status。
  - 'watchlist-status inWatchlist: 标的在系统「自选」组(窄义,OQ3 2026-06-03 收窄) → 底栏「删自选」；否则「加自选」'
  - 'watchlist-status memberships: 标的在所有非持仓组(系统「自选」+ 任意自定义组,排除持仓派生)的[{groupId,itemId}] → 喂编辑分组面板勾选态 + 取消勾时精确删'
  - 'unauth / 非 ACTIVE: watchlist-status 端点 → 401（边界，反枚举）'
---

# Feature Specification: Stock Detail（股票详情 — 富途式顶部 Tab + 同花顺式固定底栏）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-05-29)]**
> server 段按 **Flat + Anemic + Moat** 范式（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）；属 `portfolio` bounded context（与 01/02/04 共模块）。**详情 / K线 / 报价 / 估值 / 财务由 mobile client 直调 [015-marketdata](../015-marketdata-access-layer/spec.md) EP2/3/4 端点 client-side merge、不在本特性 server 段拉取**（014 与 015 运行时**零跨 ctx**，仅共享 `market:code` 逻辑键，per 015 plan §决策；设计源仍 [PRD-03](../../docs/prd/portfolio/portfolio-03-data-provider-tech-design.md)）；**014 server 段仅 watchlist-status**（读 04 自选态）；加/删自选复用 04 watchlist。研报 / 预警 / 笔记为**未建外部特性**（本特性只留入口契约，见 § Open Questions + Out of Scope）。
>
> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> UI 业务模块走统一 mockup-first；本特性含 K 线数据可视化，图表库选型与 mockup 互锁（sdd.md mockup 阶段通用注意事项）：`spec → /speckit-clarify → mockup（先行，图表库选型与 mockup 互锁）→ plan（含完整 UI 段）→ tasks → impl`。纪律：① clarify 干净再 mockup；② UI impl 定稿前真后端冒烟（Playwright Expo Web）；③ mockup 复用 theme tokens（涨跌用 03 §7.1 / 04 新增 `quote.up/down/flat`），不重设视觉资产。

**Feature Branch**: `014-stock-detail`（设计阶段在 `investment`，impl 再开分支）
**Created**: 2026-05-29
**Status**: Clarified（clarify 2026-05-29：OQ1 预警/笔记底栏入口=占位 disabled/即将上线；OQ2 分析 Tab=保留+空态占位；OQ3 加/删自选「已在」=任意非持仓组。**clarify 2026-06-03（015/016 baseline 审计）：G1 数据新鲜度=显示 `asOf`+滞后提示；G2 市场=cn 完整 / hk 空态 / us gate；G3 底栏拆「加·删自选(窄,仅自选组)」+「编辑分组(multi-select,无颜色)」，OQ3 收窄**。见 § Clarifications）
**Module**: `portfolio`（server 段仅 watchlist-status 读 04 自选态；详情/K线/报价 mobile 直调 015 EP2/3/4；前端 3 Tab + 报价 header + K 线 + 固定底栏）
**PRD**: [portfolio-05-stock-detail-prd.md](../../docs/prd/portfolio/portfolio-05-stock-detail-prd.md)
**Input**:

- 股票详情 = portfolio「个股深度研判综合容器」（Master §3.4），借鉴富途牛牛顶部 Tab + 同花顺固定底栏。
- **两阶段交付**：理杏仁仅 EOD 日频、无任何实时/盘中/分钟/tick/盘口/资金流（03 §4-5）。**阶段一**（本 feature）打通理杏仁 EOD 现有数据并预留实时扩展点；**阶段二**（Out of Scope，待第二 provider）接实时源后透明补盘中字段/分时图/逐笔（015 `QuotePort` EOD→realtime adapter 翻转 `priceKind`，消费者零改动，015 已留 seam）。
- **顶部 3 Tab**（富途 7 → V1 留 3）：图表（K 线，默认落点）/ 分析（研报容器）/ 公司（理杏仁财务·估值·分位）。期权=V2；轮证/评论/资讯=V1 不做。
- **页面框架（富途式）**：固定顶栏[nav（切公司/分析显 condensed 现价）+ 内容 Tab（图表/分析/公司）] / 滚动内容[报价 block 属图表 Tab、**非跨 Tab 常驻**] / 固定底栏[4 项]；报价阶段一仅 EOD 可算字段、盘中字段阶段二补（预留位不重排），涨红跌绿。
- **固定动作底栏**（同花顺式，4 项）：预警 / 笔记 / 加·删自选（仅 toggle 系统「自选」组）/ 编辑分组（multi-select 管理标的↔自定义组，无颜色/无分享；2026-06-03 收窄修订自原「⋯更多工具·调分组·颜色」，见 § Clarifications）。

## Context

- **只读消费容器**：本页几乎不新增持久化实体；**server 段 = watchlist-status 端点**（读 04 自选态）。**详情 / K线 / 报价由 mobile client 直调 015-marketdata** EP3（详情聚合：报价 header + 估值/分位/财务/公司行动 + 身份 + 52 周高低）/ EP4（K线 adjust+period 聚合）/ EP2（批量报价）——015 已 ship（封装 Instrument + DailyBar + 估值/财务/公司行动 + EodBacked 报价）。
- **两阶段数据边界**：阶段一字段集 = EOD 可算（报价 header：最新=收盘/涨跌/涨跌幅/昨收/PE TTM/PB/股息率/总市值/流通市值；图表：日/周/月/季/年 K + 复权 + 成交量副图；公司：估值/分位/财务/身份）。**盘中独有字段在阶段一不展示**（而非占位空壳）——最高/最低/今开/盘中量额/量比/委比/内外盘/盘前盘后 + 分时图 + 逐笔，待阶段二实时源由端口透明恢复。
- **涨跌专用 token**：复用 04 新增 `quote.up`（红）/ `quote.down`（绿）/ `quote.flat`（灰），**不复用** err/ok（语义相反）。本批 mockup 提案 hex；impl 落 `apps/mobile/src/theme/colors.ts`。
- **业务主键**：`market + code`（per Master §4.1）。`market` 取值统一用 015 `Instrument.market` 词表 **`cn` / `hk` / `us`**（**不做映射**；01 `market_preference.market` 同步对齐到该词表，独立 fix 分支落）；外指 015 `Instrument` 注册表。
- **复用既有设施**：`JwtAuthGuard` / status==ACTIVE / RFC 9457 ProblemDetail / `@nestjs/throttler` —— 引用不重立。
- **底栏 ≈ 04 操作**：「加/删自选」「编辑分组」与 04（[PRD04](../../docs/prd/portfolio/portfolio-04-watchlist-prd.md)）的加/删自选 + 分组归属管理是**同一组操作的不同入口**（014 编辑分组复用 04/013 的加入/移出/建组端点，**但不含颜色标记**）；加自选默认落「自选」组（04 FR-M07）。
- **外部未建特性**：研报（独立研报 PRD，Master §3.8）/ 预警（预警 PRD）/ 笔记（笔记 PRD）均未建 → 底栏「预警」「笔记」与分析 Tab 的 V1 形态见 § Open Questions。

## Clarifications

### Session 2026-05-29

- Q: 底栏「预警」「笔记」入口 V1 形态（预警 PRD §3.5 / 笔记 PRD §3.6 均未建）？ → A: **占位 disabled / 「即将上线」**——保留 4 按钮底栏完整设计，点击轻提示；预警（整套 AST 引擎）/ 笔记均为重特性，不做临时 stub（与 04 OQ1 轻量临时入口不同量级）。固化 FR-M09 / US6。
- Q: 分析 Tab（研报容器）V1 形态（独立研报 PRD 未建）？ → A: **保留分析 Tab + 空态占位**「研报功能即将上线」+ 指向独立研报 PRD（Master §3.8）——保 3-Tab 富途结构，对齐已批 PRD05（分析 Tab = 研报容器）。固化 FR-M01 / FR-M09 / US7。
- Q: 加/删自选「已在自选」判定口径？ → A: **标的在任意用户分组（系统「自选」组 + 任意自定义组，排除持仓派生）即视为已在自选**（底栏显「删自选」）；持仓派生（份额>0）独立只读，不参与 toggle。固化 FR-S03 / FR-M07 / state_branches。

### Session 2026-06-03（015/016 ship 后 baseline 审计触发）

> 背景：014 spec **先于**依赖 015-marketdata / 016-marketdata-sync 建立；两者 ship 后做 spec↔实现 drift 审计。**核心契约假设全部成立、已验真**：EP3 详情聚合含 估值/分位（pePctlY3/Y5·pbPctlY3/Y5）/财务/公司行动/身份 + **52 周高低**（`fiftyTwoWeekHigh/Low`，近 252 日 max/min close）；EP4 五周期（日/周/月/季/年）**真服务端聚合**（`aggregateBars`）+ 三复权；EP2 EOD-backed + `asOf`/`priceKind`（`['eod_close','realtime']`，V1 恒 eod_close）；404/null、`market:code` 词表、EOD-only seam 均对得上。以下 2 项为 015/016 实际形态暴露、原 spec 未覆盖的**运营现实**，本轮结算：

- Q: 数据新鲜度——015 报价/详情 EOD-backed（含 `asOf` 数据日期，`priceKind=eod_close`），周末/节假日滞后 1–2 交易日，详情页如何告知时效？ → A: **显示 `asOf` 数据日期 + 滞后提示**——报价区 / condensed 现价显示数据日期小字（如「数据截至 2026-06-01」），`priceKind=eod_close` 标注「收盘」；非当日数据轻提示，避免误判为实时盘中价。固化 FR-M02 / SC-M01 / Mobile Edge。
- Q: 市场覆盖——016 实际 `marketScope` 默认 `['cn']`（A股完整 / 港股薄部分维度 null / 美股**零数据**完全未同步），V1 各市场下钻策略？ → A: **cn 完整可进 / hk 可进+缺维度空态 `--` / us gate**（不可下钻，显「美股即将上线」占位）——对齐 016 `marketScope=['cn']` + 015「美股待富途」，避免 us 满屏 `--` 劣体验。固化 Assumptions / Mobile Edge / Out of Scope。
- Q: 加/删自选 toggle 与自定义组的关系——OQ3（5/29）定「已在自选 = 在任意非持仓组」，但加/删是单组写，详情页如何收口避免「删自选误删自定义组 / 徽标死锁」？ → A: **底栏拆两个分组按钮 + OQ3 收窄**——① **加/删自选**：徽标 + 操作**仅针对系统「自选」组**（窄义，对称 toggle，不碰自定义组，复用 013 加/删）；② **编辑分组**（一级按钮，**取代原「⋯更多工具·调分组·颜色」**）：同花顺式 multi-select 面板，列出所有**非持仓**分组（系统「自选」+ 自定义组，排除持仓派生），该股已在的组打勾，勾/取消 = 加入/移出该组（复用 013 EP7/EP9/EP2/EP1），底部「＋新建分组」+「完成」；**不做颜色 / 不做快速建组带色 / 不做分享**（分享 V1 砍）。OQ3 的「在哪些组」广义信息由编辑分组面板勾选态承载。固化 FR-M06/M07/M08 + US6 + FR-S03 + state_branches；watchlist-status 端点返 `{ inWatchlist(窄,「自选」组), memberships:[{groupId,itemId}] }`。

## User Scenarios & Testing _(mandatory)_

### ~~User Story 1 / 2 — [Server] 详情读 + K线读~~ → 已迁 015-marketdata（不在 014 server scope）

> **回写说明（015 ship 后，per 015 plan §回写）**：原 US1（详情数据读取）+ US2（K线日线读取）的 **[Server] 端点已迁 [015-marketdata](../015-marketdata-access-layer/spec.md)**，**mobile 直调**，014 不再自建：
>
> - **详情读** → 015 **EP3** `GET /api/v1/marketdata/instruments/{symbol}`（聚合报价 header + 估值/分位 + 财务 + 公司行动 + 身份 + 52 周高低；缺失维度 null；未知 symbol → 404；Decimal 序列化为 string）。
> - **K线读** → 015 **EP4** `GET /api/v1/marketdata/instruments/{symbol}/bars`（adjust=none/forward/backward + period=day/week/month/quarter/year 服务端聚合；非法参数 400；空区间空数组）。
> - **报价** → 015 **EP2** `GET /api/v1/marketdata/quote`（EOD-backed，asOf/priceKind）。
>
> 上述行为（详情聚合 / 404 / Decimal-string / adjust 三态 / period 聚合 / 空区间）由 **015 spec state_branches + IT 全覆盖**。014 mobile（US3–US7）直调这些端点渲染、**渲染层 client-side merge** 自选态（运行时与 015 **零跨 ctx**）。014 server 段仅保留 **watchlist-status**（FR-S03 + state_branch）。

---

### User Story 3 — [Mobile] 详情页骨架（富途式固定顶 Tab + 报价属图表 Tab）（Priority: P1）

用户从自选列表 / 搜索下钻进详情页：**固定顶栏**含 nav + 内容 Tab（图表/分析/公司，默认图表，紧贴 nav 下方、在报价上方），**报价 block 属图表 Tab 内容**展示阶段一 EOD 字段（涨红跌绿）；切「公司/分析」Tab 由 nav 内联 condensed 现价。

**Why this priority**: 详情页主框架 + 报价呈现；Tab 切换是富途范式核心。

**Independent Test**: mock detail（含 stub EOD 行情/估值）→ 渲染详情页 → 断言：固定顶栏含内容 Tab（图表默认选中，在顶非报价下方）、图表 Tab 内报价 block 展示 EOD 字段（最新/涨跌/涨跌幅/昨收/PE TTM/PB/股息率/市值）、涨跌用 quote.up/down/flat、**盘中字段不渲染**、provider 未就位占位 `--`、切公司/分析 nav 显 condensed 现价、固定底栏常驻。（render 走 Playwright Web，涨跌色逻辑走 vitest）

**Acceptance Scenarios**:

1. **Given** 进入详情页，**When** 渲染，**Then** 固定顶栏含 nav + 内容 Tab（图表/分析/公司，默认「图表」，**在顶、报价上方**）+ 固定底栏；点击 Tab 切换滚动内容区
2. **Given** 图表 Tab，**When** 渲染报价 block，**Then** 仅展示 EOD 可算字段（阶段一字段集）；盘中字段不出现；**报价为图表 Tab 内容、非跨 Tab 常驻**
3. **Given** 切到公司/分析 Tab 或图表滚过报价，**When** 渲染，**Then** nav 内联 condensed 现价 + 涨跌（涨红跌绿）
4. **Given** 涨跌数值，**When** 渲染，**Then** 涨 quote.up（红）/ 跌 quote.down（绿）/ 平 quote.flat（灰）+ 符号 +/- 辅助
5. **Given** 行情 provider 未就位 / 字段缺失，**When** 渲染，**Then** 占位 `--`，不阻塞页面

---

### User Story 4 — [Mobile] 图表 Tab — K 线（日/周/月/季/年）+ 复权 + 成交量（Priority: P1）

用户在图表 Tab 看 K 线：切周期（日/周/月/季/年）、切复权（不/前/后），下方成交量副图；涨红跌绿。

**Why this priority**: 数据可视化核心；图表库选型与 mockup 互锁。

**Independent Test**: mock bars（多周期）→ 渲染 K 线 → 断言：周期切换（日/周/月/季/年）、复权切换（不/前/后）、成交量副图、涨跌配色；**无分时图 / 无逐笔成交明细**（阶段一）。（render 走 Playwright Web）

**Acceptance Scenarios**:

1. **Given** 图表 Tab，**When** 渲染，**Then** K 线图 + 周期切换条（日/周/月/季/年）+ 复权切换 + 成交量副图
2. **Given** 切换周期 / 复权，**When** 操作，**Then** 重新拉对应 bars 并渲染
3. **Given** 阶段一，**When** 渲染，**Then** **不出现** 1D/5日 分时图、右侧逐笔成交明细（为阶段二预留位）
4. **Given** K 线涨跌 / 成交量，**When** 渲染，**Then** 涨红跌绿（quote token）

---

### User Story 5 — [Mobile] 公司 Tab — 估值/分位/财务/身份（Priority: P1）

用户在公司 Tab 看理杏仁数据：估值（PE/PB/PS/股息率/市值）+ 估值分位（PE/PB y3/y5）+ 财务衍生（ROE/毛利率/EPS/BPS）+ 静态身份（名称/类型/币种/52周高低）+ 公司行动（分红/拆股，可选只读）。

**Why this priority**: 理杏仁 V1 支撑最好的维度；分位是招牌能力。

**Independent Test**: mock detail（含估值/分位/财务/身份）→ 渲染公司 Tab → 断言各分区数据；缺失字段（如无财报）空态占位。

**Acceptance Scenarios**:

1. **Given** 公司 Tab，**When** 渲染，**Then** 估值分区（PE TTM/静/动、PB、PS、股息率、总/流通市值、总股本）
2. **Given** 估值分位数据，**When** 渲染，**Then** PE/PB 历史百分位（y3/y5）展示（数值/可视化形态 mockup 定）
3. **Given** 财务数据，**When** 渲染，**Then** ROE/毛利率/EPS/BPS
4. **Given** 缺失字段（无财报季数据 / 港美股薄数据），**When** 渲染，**Then** 空态占位（`--`），不报错

---

### User Story 6 — [Mobile] 固定动作底栏（预警/笔记/加·删自选/编辑分组）（Priority: P1）

用户用底部常驻底栏操作：加/删自选（仅 toggle 系统「自选」组）、编辑分组（同花顺式 multi-select 管理标的↔自定义组）、进预警配置、写笔记。

**Why this priority**: 高频操作收口；加/删自选 + 编辑分组是 V1 可闭环的真实操作（复用 04）。

**Independent Test**: mock 自选态 + 分组归属 → 渲染底栏 → 断言：标的不在「自选」组 → 显「加自选」（点击落「自选」组）；在「自选」组 → 显「删自选」（点击仅删「自选」组那条、不碰自定义组）；点「编辑分组」弹 multi-select 面板（列非持仓组、已在组打勾、勾/取消 = 加入/移出、含「＋新建分组」「完成」、无颜色/无分享）；预警/笔记为占位（disabled/「即将上线」，OQ1）。（render 走 Playwright Web，加/删态逻辑走 vitest）

**Acceptance Scenarios**:

1. **Given** 标的不在系统「自选」组（窄义，OQ3 2026-06-03 收窄），**When** 渲染底栏，**Then** 显「加自选」；点击 → 加入「自选」组（013 EP7）
2. **Given** 标的在系统「自选」组，**When** 渲染底栏，**Then** 显「删自选」；点击 → 仅从「自选」组移除（013 EP9，不碰自定义组）
3. **Given** 点「编辑分组」，**When** 展开，**Then** multi-select 面板列出所有非持仓组（系统「自选」+ 自定义组，排除持仓），该股已在组打勾；勾未勾组 → 加入；取消已勾组 → 移出；含「＋新建分组」+「完成」；**无颜色 / 无分享**
4. **Given** 点「预警」/「笔记」，**When** 操作，**Then** disabled / 轻提示「即将上线」（OQ1：占位，外部特性未建）

---

### User Story 7 — [Mobile] 分析 Tab — 研报容器（V1 占位）（Priority: P2）

用户切到分析 Tab：看该标的研报入口 / 列表（完整研报能力属独立 PRD）。

**Why this priority**: 研报 PRD 未建 → V1 分析 Tab 仅占位（OQ2=保留 Tab + 空态）；本特性只留 Tab 壳 + 入口契约。

**Independent Test**: 渲染分析 Tab → 断言空态占位「研报功能即将上线」+ 指向独立研报 PRD（Master §3.8）；不实现研报内核（OQ2：保留 3-Tab 结构）。（render 走 Playwright Web）

**Acceptance Scenarios**:

1. **Given** 分析 Tab，**When** 渲染，**Then** 空态占位「研报功能即将上线」+ 指向独立研报 PRD（完整能力属研报 PRD）
2. **Given** 研报 PRD 未建，**When** V1，**Then** 分析 Tab 仅占位，不实现研报内核（拉取/导入/阅读器/版本化）

---

### Edge Cases

#### Server Edge Cases

- **instrument 不存在**（无 Instrument 行）→ 404 ProblemDetail
- **部分数据缺失**（无 fundamental / 无财报季 / 港美股薄）→ 缺失字段 null，已有字段正常返回（不级联报错）
- **EOD 行情未同步**（quote provider 未就位 / 该标的未入关注池 EOD 同步）→ 最新价兜底最近可得收盘，无则字段 null
- **K 线区间无数据** → 空数组（非错误）
- **周期聚合边界**（周/月/季/年线在区间不足一周期时）→ 聚合规则 plan 定（部分周期是否成线）
- **加/删自选并发**（多端）→ 复用 04 幂等语义

#### Mobile Edge Cases

- **盘中字段（阶段一无源）** → 不渲染（预留位，非空壳 `--`）；区别于「有源但暂缺」的 `--` 占位
- **K 线数据量大**（年 K 多年）→ 抽样 / 虚拟化（流畅，NFR）
- **图表库手势**（缩放 / 平移与页面滚动 / Tab 横滑冲突）→ 手势优先级 plan 定
- **加/删自选状态读取失败** → 默认「加」态（保守，不误显已加）
- **持仓标的下钻**（份额>0）→ 加/删自选语义与 04 持仓组只读对齐（持仓派生项不可手动删自选）
- **预警 / 笔记 底栏入口**（外部未建）→ 占位 disabled / 「即将上线」轻提示（OQ1）；**分析 Tab（研报）** → 空态占位指向独立研报 PRD（OQ2）
- **数据日期滞后**（周末/节假日 / 非交易日进入，clarify 2026-06-03 G1）→ 报价为前一交易日 EOD，显示 `quote.asOf` 数据日期 + `priceKind=eod_close`「收盘」标注，不误导为实时盘中价
- **美股标的下钻**（`us` market，clarify 2026-06-03 G2）→ **gate**：不可进详情或显「美股即将上线」占位（016 V1 `marketScope=['cn']` 未同步 us → 零数据）。**港股**（`hk`）可进，缺维度空态 `--`（薄数据）

## Requirements _(mandatory)_

### Server Functional Requirements

> **回写：详情 / K线 / 报价 server 段已迁 015**（per 015 plan §回写）——FR-S01/S02/S04/S05/S06 由 015-marketdata EP2/3/4 承担、mobile 直调；014 server 段唯一端点 = **FR-S03 watchlist-status**。

- **FR-S01（迁 015）**: 详情读由 **015 EP3** `GET /api/v1/marketdata/instruments/{symbol}` 提供（聚合报价 EOD header + 估值/分位 + 财务 + 公司行动 + 身份 + 52 周高低）；**mobile 直调**，014 不自建。详情聚合 / 缺失维度 null / Decimal-string 由 015 spec + IT 覆盖。
- **FR-S02（迁 015）**: K线读由 **015 EP4** `GET .../instruments/{symbol}/bars` 提供（period 日/周/月/季/年 服务端聚合 + adjust none/forward/backward + 成交量）；**mobile 直调**，014 不自建。
- **FR-S03**: 系统 MUST 提供该 `market+code` 的自选态 + 分组归属读端点，返回 `{ inWatchlist, memberships:[{groupId,itemId}] }`：**`inWatchlist` = 标的在系统「自选」组（窄义，OQ3 2026-06-03 收窄；喂底栏加/删按钮）**；**`memberships` = 标的在所有非持仓组（系统「自选」+ 任意自定义组，排除持仓派生）的 `{groupId,itemId}`（喂编辑分组面板勾选态 + 取消勾时精确删）**。加/删自选 + 编辑分组的增删全复用 04（013）端点（EP7 加 / EP9 删 / EP2 建组 / EP1 列组）。**这是 014 唯一新 server 端点。**
- **FR-S04（迁 015）**: 公司行动（分红/拆股）由 **015 EP3 详情聚合**内含（CorporateAction）；mobile 直调，014 不自建。
- **FR-S05（迁 015）**: 阶段一字段边界（仅 EOD 可算 / 盘中字段不在 contract、阶段二经 015 `QuotePort` 实时 adapter 透明扩展 `priceKind`）= **015 契约约束**（015 spec FR-S07/S08）；014 mobile 按 015 contract 渲染。
- **FR-S06（迁 015）**: instrument 不存在 → **015 EP3 返 404**；部分数据缺失 → 015 缺失字段 null（不报错）。watchlist-status 对未知 symbol → 返「未在自选」（非 404）。
- **FR-S07**: watchlist-status 端点 MUST 鉴权（`JwtAuthGuard` + status==ACTIVE）；未认证 / 非 ACTIVE → 401 ProblemDetail。
- **FR-S08**: 错误响应 MUST 遵循 RFC 9457 ProblemDetail；watchlist-status 端点 MUST 限流（复用 `@nestjs/throttler`，阈值 plan 定）。
- **FR-S09**: 属 `portfolio` context；**watchlist-status 读 04 自选态（同 context）**；详情 / K线 / 报价 mobile 直调 015（运行时**零跨 ctx**，无 server cross-ctx use case 直 DI）；遵循 [catalog](../../docs/conventions/server-bounded-context-catalog.md) 规则。
- **FR-S10**: 业务主键 = `market + code`（per Master §4.1）；`market` MUST 用 015 `Instrument.market` 词表 `cn`/`hk`/`us`（与 01 `market_preference.market` 对齐到同一词表，**不做映射**）；外指 015 `Instrument`。

### Mobile Functional Requirements

- **FR-M01**: 详情页 MUST **富途式框架**：**固定顶栏**含 nav + 内容 3 Tab（图表 / 分析 / 公司，默认图表，**紧贴 nav 下方、在报价上方**）；期权 / 轮证 / 评论 / 资讯 V1 不出现。底栏固定在底（FR-M06）。
- **FR-M02**: 报价 block MUST 为**图表 Tab 内容**（随图表 Tab 滚动，**非跨 Tab 常驻 header**；切公司/分析 Tab 时由 nav 内联 condensed 现价 + 涨跌替代），**阶段一仅展示 EOD 可算字段**（名称+代码+market、最新=收盘、涨跌额、涨跌幅、昨收、PE TTM、PB、股息率、总市值、流通市值）；盘中字段不渲染、为阶段二预留布局位不重排。**报价 MUST 显示数据新鲜度**（clarify 2026-06-03 G1）：复用 015 `quote.asOf`（数据日期）+ `priceKind`——报价区 / condensed 现价显示数据日期小字（如「数据截至 2026-06-01」），`priceKind=eod_close` 标注「收盘」；非当日（周末/节假日滞后 1–2 交易日）轻提示，避免误判为实时盘中价。
- **FR-M03**: 报价 / K 线涨跌数值 MUST **涨红跌绿**：复用 `quote.up`（红）/ `quote.down`（绿）/ `quote.flat`（灰），**不复用** err/ok；provider 未就位 / 缺字段 → 占位 `--`；色不作唯一信息载体（+/- 符号辅助，a11y）。
- **FR-M04**: 图表 Tab MUST 支持周期切换（日/周/月/季/年）+ 复权切换（不/前/后）+ 成交量副图；**阶段一不含** 分时图 / 逐笔成交明细（为阶段二预留）。
- **FR-M05**: 公司 Tab MUST 展示估值（PE/PB/PS/股息率/市值/总股本）+ 估值分位（PE/PB y3/y5）+ 财务（ROE/毛利率/EPS/BPS）+ 静态身份（名称/类型/币种/52周高低）；缺失字段空态 `--`。
- **FR-M06**: 固定动作底栏 MUST 4 项：预警 / 笔记 / **加·删自选**（仅 toggle 系统「自选」组）/ **编辑分组**（同花顺式 multi-select 面板，管理标的↔自定义组）。**不含分享**（V1 砍）/ **不含颜色标记**（014 入口不做；013 已 ship 的分组颜色不受影响）。
- **FR-M07**: 加/删自选 MUST 按**系统「自选」组**态切换文案：未在「自选」组 → 加（落「自选」组，013 EP7）；已在「自选」组 → 删（删「自选」组那条，013 EP9 用 `memberships` 里「自选」组的 `itemId`）。**判定 = 标的在系统「自选」组（窄义，OQ3 2026-06-03 收窄）**；对称 toggle，**不碰自定义组**（自定义组关系由编辑分组面板管理，FR-M08）。
- **FR-M08**: **编辑分组** MUST 弹同花顺式 multi-select 面板：列出该账号所有**非持仓**分组（系统「自选」+ 全部自定义组，**排除持仓派生**），每组显示组名 + 标的数；**该股已在的组打勾**，点未勾组 → 加入（013 EP7），取消已勾组 → 移出（013 EP9 用 `memberships` 的 `itemId`）；底部「＋新建分组」+「完成」。**「＋新建分组」MUST 弹居中输入弹框**（组名 `TextInput` + 字符计数对齐 server name 上限，**无颜色 / 无快速建组带色**），**复用 013 建组逻辑**（`createGroup` → EP2），建后新组即现于面板可勾选。**不做颜色标记 / 不做分享**（V1）。
- **FR-M09**: 底栏「预警」「笔记」V1 = **占位 disabled / 「即将上线」**（OQ1，预警/笔记 PRD 未建）；分析 Tab = **空态占位** 指向独立研报 PRD（OQ2）。本特性只出入口契约，不实现外部特性内核。
- **FR-M10**: 视觉 MUST 复用 theme tokens（一律浅色，不引深色）；项目无 Tab 栏 / K 线图表 / 固定底栏 / overflow 菜单组件——新组件视觉规格 + 图表库选型留 mockup（图表库与 mockup 互锁）。
- **FR-M11**: a11y — Tab `accessibilityRole='tab'`；底栏按钮 `accessibilityRole='button'` + label；图表关键数值可达（屏读补充）；涨跌色不作唯一载体。

### Key Entities

> 本特性**不新增持久化实体**——只读消费 015（详情/K线/报价事实，mobile 直调）+ 04（自选态）既有实体：

- **Instrument（015）**：`{ market, code, name, type, currency, ... }`——静态身份注册表，业务主键 `market+code`。
- **DailyBar（015）**：`{ instrumentId, tradeDate, adjust, open, high, low, close, prevClose, volume, amount, turnoverRate }`——K 线日线事实（唯一键含 adjust，三复权各一行）。
- **FundamentalSnapshot（015）**：`{ instrumentId, date, peTtm/peStatic/peDynamic, pb, ps, dividendYield, marketCap, circMarketCap, pePctlY3/Y5, pbPctlY3/Y5 }`——日频估值 + 分位。
- **FinancialMetric（015）**：`{ instrumentId, reportPeriod, roe, grossMargin, eps, bps }`——财报衍生。
- **CorporateAction（015）**：`{ instrumentId, exDate, type, payload }`——分红/拆股（含于 EP3 详情聚合）。
- **WatchlistItem（04）**：读 `market+code` 在用户分组的归属，判定加/删自选态（014 server 段消费）。
- **行情快照（注入，非实体）**：最新/涨跌——mobile client 调 015 `/quote`（EP2，V1=EOD 收盘）client-side merge。

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01（迁 015）**: 详情聚合（报价 EOD + 估值 + 分位 + 财务 + 公司行动 + 身份 + 52 周高低）+ 缺失字段 null + 未知 symbol 404 由 **015 EP3 + IT** 覆盖；014 不自建详情端点。
- **SC-S02（迁 015）**: K线 period 聚合 + 复权 + 成交量 + 空区间空数组由 **015 EP4 + IT** 覆盖；014 不自建。
- **SC-S03**: 加/删自选态读取正确（判定口径 OQ3）；与 04 watchlist 一致（集成测试）——**014 server 唯一端点**。
- **SC-S04（迁 015）**: 阶段一 contract **不含盘中字段**（015 契约断言字段集 = EOD 可算集）；阶段二扩展不破坏 015 contract。
- **SC-S05**: watchlist-status 鉴权 401 + 限流 429（集成测试）。
- **SC-S06**: portfolio module 边界 0 violation；watchlist-status 读 04（同 context）+ 与 015 运行时零跨 ctx（详情/K线/报价 client-side merge，无 server cross-ctx use case 直 DI）。

### Mobile Measurable Outcomes

- **SC-M01**: 详情页渲染 3 Tab（图表默认）+ 报价 header EOD 字段；涨红跌绿用 quote.up/down/flat（不复用 err/ok）；盘中字段不渲染；缺字段 `--`；**报价显示 `asOf` 数据日期 + `priceKind=eod_close`「收盘」标注**（clarify G1）（vitest 涨跌色 + Playwright Web render）。
- **SC-M02**: 图表 Tab 周期切换（日/周/月/季/年）+ 复权切换 + 成交量副图；**无分时/逐笔**（Playwright Web）。
- **SC-M03**: 公司 Tab 估值/分位/财务/身份分区渲染；缺失字段空态（Playwright Web）。
- **SC-M04**: 底栏 4 项（预警/笔记 disabled + 加·删自选 + 编辑分组）；加/删自选随**系统「自选」组**态切换文案；点编辑分组弹 multi-select 面板（列非持仓组、已在组打勾、勾/取消加入/移出、新建分组居中弹框无颜色）（vitest 态逻辑 + Playwright Web）。
- **SC-M05**: 真后端冒烟（Playwright Web，纪律②）：登录 → 进某标的详情（stub/EOD 行情+估值）→ 切 3 Tab → 图表切周期/复权 → 底栏加自选 → 截图归档。
- **SC-M06**: 视觉 0 硬编码——实现文件不含 theme token 外 hex/rgb（含 quote token；mockup-driven，grep）；涨跌不仅靠色（符号辅助，a11y）。

## Assumptions

- **依赖 01 + 015 + 04**：portfolio 模块骨架（01）+ 015-marketdata（详情/K线/报价 EP2/3/4 + Instrument + capability-port + Lixinger/东财 adapter，**已 ship**）+ 016-marketdata-sync（夜间灌库提供真数据，**已 ship**）+ 04 自选（加/删自选态）。
- **阶段一 = 本 feature scope**；阶段二（实时源补盘中字段/分时/逐笔）= Out of Scope（待第二 provider，015 报价 EOD→realtime `priceKind` seam）。
- **行情 V1 = EOD 收盘**（03 无实时）；涨跌按昨收（前一 EOD 收盘）算。
- **K 线阶段一 = 日线及聚合**（无分时/逐笔）；复权 + period 聚合经 015 EP4（adjust + period）。
- **复用 quote.up/down/flat token**（04 新增，涨红跌绿）；不重设。
- **研报 / 预警 / 笔记 / 实时行情** 均为外部 / 后续特性（Out of Scope；本特性只留入口契约）。
- **市场覆盖**（clarify 2026-06-03 G2，对齐 016 实际 `marketScope=['cn']`）：**`cn` 完整同步**（估值/分位/财务/K线全维度）；**`hk` 薄数据**（部分维度 null → 空态 `--`，**可下钻**）；**`us` 零数据**（016 V1 完全未同步 → **gate 不可下钻**，显「美股即将上线」，见 Out of Scope）。港股特有字段（ADR/盘后/人民币柜台/期货/低水）V1 不做。
- **数据新鲜度 = EOD**（per 015 `priceKind=eod_close`，clarify 2026-06-03 G1）：报价/估值滞后至最近交易日 EOD；周末/节假日触发 → 返前一交易日数据，`quote.asOf` 标日期，mobile 显示之（FR-M02）。理杏仁 EOD 就绪时刻未公开（016 调度经验测后调），故偶发当日数据延迟属正常。
- **数值精度**：015 价格/比率/市值字段为 Decimal **序列化为 string**；mobile 直接显示、**不 `parseFloat`**（避免浮点损精度）；涨跌额/幅由 015 后端算（`quote.change`/`changePct`），mobile 不重算。
- **015 端点限流**：detail / bars 各 `60 req/60s`；详情页单次进入调用有限（detail + bars），不触限；切周期/复权频繁切换需 debounce（超限 429 ProblemDetail）。

## Open Questions（已于 `/speckit-clarify` 2026-05-29 结算，见 § Clarifications）

- **OQ1 — 底栏「预警」「笔记」入口 V1 形态** → ✅ **占位 disabled / 「即将上线」**（保留 4 按钮底栏，点击轻提示；预警/笔记是重特性不做临时 stub）。固化 FR-M09 / US6。
- **OQ2 — 分析 Tab（研报）V1 形态** → ✅ **保留分析 Tab + 空态占位**「研报功能即将上线」指向独立研报 PRD（保 3-Tab 结构，对齐 PRD05）。固化 FR-M01 / FR-M09 / US7。
- **OQ3 — 加/删自选「已在自选」判定口径** → ✅（5/29）任意用户分组即算已在。**⚠ 2026-06-03 收窄修订**（见 § Clarifications Session 2026-06-03）：底栏加/删自选改**窄义（仅系统「自选」组）**，对称 toggle 不碰自定义组；「在哪些组」广义信息移交**编辑分组面板**勾选态（FR-M08）。FR-S03 / FR-M07 / state_branches 以收窄版为准。

## Out of Scope（本 feature 不做）

- **阶段二实时行情**（盘中报价字段 / 分时图 / 逐笔成交明细）——待第二 provider（015 报价 EOD→realtime seam）；本特性预留前端布局位。
- **期权 / 轮证 Tab**——期权 V2，轮证 V1 不做。
- **评论 / 资讯 Tab**——社交不做；资讯理杏仁无源。
- **研报完整能力**（PDF 拉取/导入/阅读器/双指缩放/翻页/版本化）——独立研报 PRD（Master §3.8）；本特性仅留分析 Tab 入口契约。
- **预警 / 笔记 本体逻辑**——各自 PRD；本特性仅留底栏入口契约。
- **015-marketdata 数据访问层本体**（Instrument 注册表 / capability-port / Lixinger·东财 adapter，**已 ship**）+ **016 EOD 同步灌库**——本特性只消费 015 端点（EP2/3/4）。
- **加/删自选 / 分组管理本体**——04 watchlist；本特性只调其端点 + 读自选态。
- **港美股深度字段 + 美股 V1**——A 股为主；**港股薄数据空态**（可下钻）；**美股 V1 gate 不可下钻**（016 `marketScope` 未含 us → 零数据，待扩同步 / 富途源后开，clarify 2026-06-03 G2）。
