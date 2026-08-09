---
feature_id: 041-hk-marketdata-corporate-events
modules: [marketdata]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-07-15
updated_at: 2026-07-15
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 端数据摄取 —— 港股新增 4 类「事件流」维度（回购 / 股本变动 / 配股 / 股东权益变动）同步进 PG，零 mobile/web surface。新增 market-agnostic 事实表（含 instrument FK；配股或复用现有 CorporateAction，plan 决），不新增读端点（读侧 015 market-agnostic 天然覆盖；本 feature 只让 PG 事实层多出这 4 类 market=hk 真数据）。无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - '回购事件回填: 单只港股 repurchase 按 startDate/endDate 区间拉 → BuybackEvent 落丰富字段（num/highestPrice/lowestPrice/totalPaid/avgPrice/methodOfPurchase/ratioPurchasedSinceResolution/currency/boardType…），按自然键幂等无重复行'
  - '股本变动回填: equity-change 按区间拉 → EquityChange 落 capitalization/capitalizationH/changeReason/declarationDate，按 (instrument,date) 幂等'
  - '股东权益变动嵌套: shareholders-equity-change 返嵌套数组 numOfSharesInterestedList[]/percentageOfIssuedVotingShares[]（每项 {value,sharesType:L/S}）→ 建模保留多/空（L/S）持仓维度，按 (instrument,date,shareholderName) 幂等'
  - '配股罕见零样本: allotment 端点 code=1 生效但港股极罕见（probe 扫 12 标的全 0 行）→ 有配股历史的标的才落行，无样本标的空数据不写库不崩（沿 p2「南向非成分标的空数据」范式）；字段 schema 留 impl 首个真实非空样本二次确认'
  - '全部单数 stockCode+range 契约: 4 端点均 param 第一类（stockCode + startDate + endDate）→ adapter 按区间回填历史事件序列，每端点单独确认不套用（延续 p1 #673 / p2 教训）'
  - '事件流可回填历史: 4 维度均支持 startDate/endDate 区间 → 可回填近 10 年事件历史（回测样本长度），区别于 040 热度快照不可回填'
  - '无 metricsList all-or-nothing 坑: 4 端点均不用 metricsList → p1 #670「含一个 hk 无效 metric 整请求静默 0 行」的坑在本 feature 不存在'
  - '4 维度 marketScope 纳入: 新增 sync_dimension 行 marketScope={hk} → 工作集含 hk 标的，统一消费共享令牌桶'
  - '新表 market-agnostic: 新增事实表均 instrument_id FK + market 经 instrument 携带，无 hk_* 前缀，将来 A 股同类可无缝并入（配股复用 CorporateAction 亦同）'
  - '依赖 universe: 4 维度均 soft-依赖 universe（标的须先注册）→ universe 未跑时工作集为空、不误建标的'
  - '回填自限速续跑: 沿用 p1 自限速 ~10/s + jitter + 共享 concurrency=1 串行 → 不触 429；中断后按自然键幂等续跑'
  - 'p1/p2/040/A股无回归: 新增 4 维度不改现有 13 维（p1 6 维 + p2 5 维 + 040 2 维）与 A 股同步行为，既有 IT/单测全绿'
---

# Feature Specification: 港股事件流数据同步（回购 / 股本变动 / 配股 / 股东权益变动）

**Feature Branch**: `041-hk-marketdata-corporate-events`
**Created**: 2026-07-15
**Status**: Draft
**Input**: 隶属 [master p3](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md「p3 补充 + 参考/文本」)，形态族「事件流」（4 spec 拆分第 2 个，承接已落地的 040 日频因子）。端点/param/字段真实性见 [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md)（2026-07-14 prod 77 read-only PoC 实测）。依赖已完成的 [p1（specs/038）](../038-hk-marketdata-core/spec.md) 平台激活 + [p2（specs/039）](../039-hk-marketdata-quant-signals/spec.md)「加一个 marketdata 维度」6 件套范式。

## Clarifications

### Session 2026-07-15

- Q: 配股（allotment）维度纳入策略（港股配股极罕见，probe 扫 12 标的全 0 行、无样本）？ → A: **纳入·尽力覆盖** —— 建全套管道并上线，对全港股回填，预期多数标的 0 行，命中真实配股历史即自动落库；建模（复用 `CorporateAction`(type=allotment) vs 新表）留 plan 决
- Q: 4 事件维度上线后的**常态增量**同步 cron 节奏（回填是一次性的，此问增量）？ → A: **分档** —— 回购 / 股本变动 = **日频**增量；股东权益变动 / 配股 = **周频**（高频事件及时入库、低频披露省调用，贴合 master INV-4「持股/报告期类低频 cron」精神）

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 港股回购事件历史可用于回测 (Priority: P1)

量化研究员需要港股近 10 年的**回购事件流**（每次回购的股数、成交均价、最高/最低价、累计已回购比例、回购方式等），作为股东回报类、信号/事件驱动类策略的输入。回购是本 feature **数据最丰富、回测价值最高**的切片：vendor 支持 `startDate/endDate` 区间回填多年历史（probe 单只 254 行/2 年），事件字段完整，是量化里「管理层用真金白银表态」的强信号。

**Why this priority**: 回购事件是股东回报 / 事件驱动因子里信息密度最高的一类，vendor 支持多年区间回填 → 回测样本长度充足、字段丰富；相对其余 3 个事件维度信号最强、数据最实 → 041 的 MVP 切片。

**Independent Test**: 对港股样本股（如 `hk:00700`，probe 已验有回购历史）按区间跑回购维度回填后，查 PG 出现该标的多年 `market=hk`（经 instrument FK）的回购事件行（含丰富字段），重复运行幂等无重复。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的（有回购历史）, **When** 回购维度按区间回填, **Then** 事实表出现该标的多年回购事件行（含 num/avgPrice/totalPaid/methodOfPurchase 等字段），按自然键唯一、重复运行幂等
2. **Given** vendor 回购端点 param 为单数 `stockCode` + `startDate/endDate`, **When** adapter 构造请求, **Then** 按该契约逐标的区间拉取（不套用其他端点 param 形态）
3. **Given** 某标的无回购历史, **When** 回购维度运行, **Then** vendor 返 0 行 → 不写库、不崩、不阻塞工作集其余标的
4. **Given** p1/p2/040 已上线的 13 维同步, **When** 新增回购维度上线, **Then** 现有维度与 A 股同步行为零回归

---

### User Story 2 - 港股股本变动事件历史可用于回测 (Priority: P2)

量化研究员需要港股的**股本变动事件**（issued capital / capitalization 的历次变化及变动原因），用于每股口径归一化、稀释追踪、股本结构类因子。股本变动是事件形态（probe 单只 172 行），vendor 支持区间回填历史。

**Why this priority**: 股本总量是每股指标（EPS/每股口径）与稀释分析的分母基准，历史股本变动序列服务口径校正与股本结构因子；数据结构简单（扁平事件行）、可回填 → 排 P2。

**Independent Test**: 对港股样本股跑股本变动维度回填后，查 PG 出现该标的多年股本变动事件行（capitalization / capitalizationH / changeReason），按 `(instrument, date)` 幂等。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的, **When** 股本变动维度按区间回填, **Then** 事实表出现该标的股本变动事件行（含 capitalization / capitalizationH / changeReason / declarationDate），`(instrument, date)` 唯一、重复运行幂等
2. **Given** 某标的无股本变动历史, **When** 维度运行, **Then** vendor 返 0 行 → 不写库、不崩、不阻塞
3. **Given** p1/p2/040 已上线维度, **When** 新增股本变动维度上线, **Then** 现有维度与 A 股同步行为零回归

---

### User Story 3 - 港股股东权益变动事件历史可用于回测 (Priority: P3)

量化研究员需要港股的**大股东权益变动事件**（主要股东的持股数量与占已发行有投票权股份比例的历次变化，含多头 L / 空头 S 维度），用于所有权集中度、大股东增减持、机构行为类信号。此维度 vendor 返回**嵌套数组结构**（`numOfSharesInterestedList[]` / `percentageOfIssuedVotingShares[]`，每项含 `sharesType: L/S`），建模需保留多/空维度（JSON 列或子表，plan 决）。

**Why this priority**: 大股东增减持是所有权/情绪类信号，量化价值真实但字段结构最复杂（嵌套 L/S 数组）、建模成本最高 → 排 P3；vendor 支持区间回填历史（probe 单只 69 行）。

**Independent Test**: 对港股样本股（如 `hk:00700`，probe 已验有 Naspers 等大股东记录）跑股东权益变动维度后，查 PG 出现该标的股东权益变动事件行，嵌套的 L/S 持股数量与占比完整保留、不丢，按 `(instrument, date, shareholderName)` 幂等。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的（有大股东变动记录）, **When** 股东权益变动维度按区间回填, **Then** 事实表出现该标的事件行，含股东名 + 多/空（L/S）持股数量与占已发行有投票权股份比例，`(instrument, date, shareholderName)` 唯一、重复运行幂等
2. **Given** vendor 返回嵌套数组（每项 `{value, sharesType}`）, **When** 解析入库, **Then** L/S 两个维度的数值均完整保留、不丢；某项缺字段 → 存 null 不崩
3. **Given** 某标的无大股东变动记录, **When** 维度运行, **Then** vendor 返 0 行 → 不写库、不崩、不阻塞

---

### User Story 4 - 港股配股事件历史（罕见，尽力覆盖） (Priority: P4)

量化研究员需要港股的**配股（rights issue / allotment）事件**以完整覆盖公司行动类事件流。然而港股配股**极罕见**：probe 端点 `code=1` 生效，但扫 12 只标的（含中小盘/仙股）**全 0 行**、无非空样本。故本维度以「尽力覆盖」纳入 —— 建管道、上线并对全港股回填，**预期多数标的返 0 行**；一旦某标的有真实配股历史即落行。字段 schema 以 impl 首个真实非空样本二次确认为准。

**Why this priority**: 配股是公司行动事件流的完整性补充，但港股几无发生 → 回测价值最低、数据最稀疏 → 排 P4（最低）；以最小成本纳入管道，不为零样本维度做重投入。

**Independent Test**: 配股维度对全港股（或候选池）回填后，管道正常收敛无崩（多数标的 0 行属正常）；若命中有配股历史的标的，则该标的落配股事件行、幂等；若全港股均无样本，管道空跑收敛、记录为已知限制。

**Acceptance Scenarios**:

1. **Given** 配股端点生效但港股极罕见, **When** 配股维度对全港股回填, **Then** 管道正常收敛、多数标的返 0 行不写库不崩，命中有配股历史的标的则落配股事件行
2. **Given** 某标的存在真实配股历史, **When** 配股维度运行, **Then** 该标的落配股事件行、按自然键幂等；字段以首个真实非空样本为准
3. **Given** 配股全港股扫描均无样本, **When** 维度运行, **Then** 系统不崩、不误建空行，配股作为「已知限制」记录（zero-sample 可接受）

---

### Edge Cases

- **无数据标的**：某标的某事件维度 vendor 返 0 行（无回购/无股本变动/无大股东变动/无配股） → 不写库、不崩、不阻塞工作集其余标的（沿 p2「南向非成分标的空数据」范式）。
- **配股全维度零样本**：配股维度对全港股扫描可能全 0 行 → 管道空跑正常收敛，不视为失败（已知限制）。
- **嵌套结构缺字段**：股东权益变动某项缺 L 或 S 值 / 某字段缺失 → 存 null，不崩、不丢其余维度（沿 015 端口层契约）。
- **同日多事件**：某标的同一日期出现多条同类事件（如多笔回购披露） → 自然键须能区分（impl 按 vendor 真实粒度确认自然键，避免误覆盖）。
- **回填中断续跑**：回填期进程中断 → 按各维度自然键幂等续跑，不产生重复或半行。
- **配股复用 CorporateAction 的类型隔离**：若配股建模复用现有 `CorporateAction`（type=allotment），MUST 不与现有 A 股/港股分红等其他 type 行相互污染（type 维度隔离）。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 系统 MUST 同步港股（`market=hk`）**回购事件流**至 PG，支持按 `startDate/endDate` 区间回填多年历史，保留 vendor 回购事件的丰富字段（股数 / 成交均价 / 最高最低价 / 累计已回购比例 / 回购方式 / 币种 / 板块等）。
- **FR-002**: 系统 MUST 同步港股**股本变动事件流**至 PG（capitalization / capitalizationH / changeReason / declarationDate），支持区间回填历史。
- **FR-003**: 系统 MUST 同步港股**股东权益变动事件流**至 PG，保留嵌套的**多/空（L/S）**持股数量与占已发行有投票权股份比例（vendor 嵌套数组 `numOfSharesInterestedList[]` / `percentageOfIssuedVotingShares[]`）→ L/S 维度不丢。
- **FR-004**: 系统 MUST 建立港股**配股事件**同步管道，对全港股回填；port 层 MUST 容忍多数标的返 0 行（港股配股极罕见），命中有配股历史的标的则落行；字段 schema 以 impl 首个真实非空样本二次确认为准（zero-sample 为已知限制）。
- **FR-005**: 4 事件维度 MUST 各按其**自然键幂等**（回购/股本变动/配股 = 事件级唯一键；股东权益变动含股东名维度）→ 重复同步无重复行、无半行。
- **FR-006**: 系统 MUST 对 4 端点各按其**真实 param 契约**构造请求（均为单数 `stockCode` + `startDate/endDate` 区间，param 第一类）；每端点单独确认，不套用其他端点形态。
- **FR-007**: 系统 MUST 容忍 vendor 数据质量问题（字段缺失 / 嵌套项缺 L 或 S）→ 缺字段存 null，不崩、不阻塞其余标的与维度（沿 015 端口层契约）。
- **FR-008**: 4 事件维度 MUST 复用现有平台机制（`marketScope={hk}` 纳入工作集、共享令牌桶自限速回填、soft-依赖 `universe`），新表落 market-agnostic（`instrument_id` FK，无 `hk_*` 前缀）；配股若复用现有 `CorporateAction` 亦须 market-agnostic 且 type 维度隔离。
- **FR-009**: 新增 4 维度 MUST 不回归 p1（6 维）/ p2（5 维）/ 040（2 维）共 13 维及 A 股同步行为（既有 Testcontainers IT / 单测全绿）。
- **FR-010**: 4 维度 MUST 支持回填历史深度（默认约定 10 年回测样本长度，`sync_dimension.history_depth`，CLI `--history-depth` 可覆盖）与 `--dry-run` 回填估算。
- **FR-011**: 系统 MUST 在上线前对 4 端点逐个对 prod 容器 read-only live-probe 确认 `code=1`（p1 血泪纪律：mock 绿不代表真调有效）。
- **FR-012**: 4 维度常态增量同步 cron 节奏 MUST 分档：回购 / 股本变动 = **日频**；股东权益变动 / 配股 = **周频**（`sync_dimension` 频率配置；回填仍为一次性区间任务，与常态增量正交）。

### Key Entities _(include if feature involves data)_

- **BuybackEvent（回购事件）**：港股回购事件行。key = instrument（携带 market）+ 事件日期（+ 必要时 vendor 事件粒度）；含股数 / 成交均价 / 最高最低价 / 已付总额 / 累计已回购比例 / 回购方式 / 币种 / 板块等丰富字段。market-agnostic + instrument FK，事件序列可回填。
- **EquityChange（股本变动事件）**：港股股本（issued capital）变动事件行。key = instrument + 事件日期；含 capitalization / capitalizationH / changeReason / declarationDate。market-agnostic + instrument FK。
- **ShareholderChange（股东权益变动事件）**：港股大股东权益变动事件行。key = instrument + 事件日期 + 股东名；含嵌套的多/空（L/S）持股数量与占已发行有投票权股份比例。market-agnostic + instrument FK；嵌套 L/S 维度建模（JSON 列或子表，plan 决）。
- **配股事件（Allotment）**：港股配股事件行。建模复用现有 `CorporateAction`（type=allotment）或新表（**plan Decision 3 已定：新建独立表 `AllotmentEvent`，不复用 `CorporateAction` —— 避污染 019/020 复权触发流**）；market-agnostic + instrument FK。港股极罕见 → 多数标的无行（已知限制）；字段以首个真实非空样本为准。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 港股样本股（如 `hk:00700`）回购维度回填后，PG 出现该标的多年（≥5 年）回购事件行，字段完整（含成交均价 / 股数 / 回购方式等）。
- **SC-002**: 港股样本股股本变动 / 股东权益变动维度回填后，PG 分别出现对应事件行；股东权益变动的多/空（L/S）持股数量与占比完整保留、不丢。
- **SC-003**: 任一事件维度重复运行结果幂等 —— 按各维度自然键无重复行、无半行。
- **SC-004**: 配股维度对全港股回填后管道正常收敛（多数标的 0 行属正常，不崩、不误建空行）；命中真实配股历史的标的则落行。
- **SC-005**: p1（6 维）/ p2（5 维）/ 040（2 维）及 A 股同步零回归（既有 Testcontainers IT + 单测全绿）。
- **SC-006**: 回填期不触发 vendor 限流封禁（沿用自限速 ~10/s + jitter，无 429 累积）。

## Assumptions

- 复用 p1（038）已激活的 marketdata 平台 + p2（039）「加一个 marketdata 维度」6 件套范式（port / adapter / mock / dimension-executor / schema+migration / IT）。
- 4 维度默认历史深度 **10 年**（照 p1/p2 回测样本长度约定，`sync_dimension.history_depth`），CLI `--history-depth` 可覆盖。
- 4 维度均 param 契约第一类（单数 `stockCode` + `startDate/endDate` 区间），可回填历史事件序列；不用 metricsList → 无 all-or-nothing 静默 0 行坑。
- 新增事实表均 market-agnostic（`instrument_id` FK + market 经 instrument 携带，per master INV-1 Securities Master 范式），将来 A 股同类事件可无缝并入；**配股建模（复用 `CorporateAction` type=allotment vs 新表）与股东权益变动嵌套建模（JSON 列 vs 子表）为 plan 阶段决策**，本 spec 不锁死。
- 4 维度 soft-依赖 `universe`（标的须先注册），`sync_dependency` 加 `universe→dim` 边；常态增量 cron 节奏分档（回购/股本变动=日频、股东权益变动/配股=周频，per Clarifications 2026-07-15）。
- 配股「零样本」为已知限制（港股配股极罕见），以 stub 管道 + 尽力覆盖纳入，不为其做重投入。
- 纯 server 数据摄取，单 bounded context `marketdata`，单 PR，无 mobile/web surface、无 UI/mockup、无 OpenAPI 契约变更。
