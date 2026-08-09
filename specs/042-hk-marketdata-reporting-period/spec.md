---
feature_id: 042-hk-marketdata-reporting-period
modules: [marketdata]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-07-15
updated_at: 2026-07-15
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 端数据摄取 —— 港股新增 3 类「报告期」维度（营收构成 / 员工 / 最新股东）同步进 PG，零 mobile/web surface。新增 3 张 market-agnostic 事实表（含 instrument FK），不新增读端点（读侧 015 market-agnostic 天然覆盖；本 feature 只让 PG 事实层多出这 3 类 market=hk 真数据）。无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - '营收构成回填: 单只港股 operation-revenue-constitution 按报告期区间拉 → RevenueSegment 展开 typed 子行 {parentItemName,itemName,revenue,costs,grossProfitMargin}。头行判别（probe verified）= 无 parentItemName + 无 value 才跳；有 parentItemName 的行一律落（value 可 null）；key trim 归一（vendor 带尾随空格）；revenue signed 可负。NK (instrument,date,parentItemName,itemName) probe verified 22 期 0 碰撞、幂等无重复行'
  - '员工回填: employee 按报告期区间拉 → EmployeeSnapshot 展开 typed 子行 {parentItemName,itemName,value,displayType:number/percentage}。displayType 语义判别不可丢且进 NK（probe verified: 同名 number+percentage 两行致 (parent,item) 碰撞、加 displayType 全期 0 碰撞）→ NK (instrument,date,parentItemName,itemName,displayType)；itemName 通用键值对不硬编码维度、key trim 归一（clarify 2026-07-15 定 + probe verified）'
  - '最新股东嵌套 L/S: latest-shareholders 返 numOfSharesInterestedList[]/percentageOfIssuedVotingShares[]（每项 {value,sharesType:L/S}，同 041 ShareholderChange 形态）→ 复用 041 已定 payload Json + content_hash 范式（无损容纳 L/S 及潜在第三类），按 (instrument,date,shareholderName,contentHash) 幂等'
  - '最新股东 = 报告期×股东序列（probe verified SERIES: 00700 返 9 行/5 个不同 date、09988 返 14 行/9 个 date，非覆盖式快照）→ date 进 NK 可回填；sharesType={L,S,P} 三类 payload Json 无损；NK (instrument,date,shareholderName,contentHash) 复用 041 范式'
  - '全部单数 stockCode+range 契约: 3 端点均 param 第一类（stockCode + startDate + endDate）→ adapter 按报告期区间回填历史序列，每端点单独确认不套用（延续 p1 #673 / p2 / 041 教训）'
  - '报告期可回填历史: 3 维度均支持 startDate/endDate 区间 → 可回填近 10 年报告期（季/年频披露，回测样本长度）'
  - '无 metricsList all-or-nothing 坑: 3 端点均不用 metricsList（营收/员工/股东用 stockCode+range）→ p1 #670「含一个 hk 无效 metric 整请求静默 0 行」的坑在本 feature 不存在'
  - '3 维度 marketScope 纳入: 新增 sync_dimension 行 marketScope={hk} → 工作集含 hk 标的，统一消费共享令牌桶'
  - '新表 market-agnostic: 新增 3 张事实表均 instrument_id FK + market 经 instrument 携带，无 hk_* 前缀，将来 A 股同类可无缝并入'
  - '依赖 universe: 3 维度均 soft-依赖 universe（标的须先注册）→ universe 未跑时工作集为空、不误建标的'
  - '回填自限速续跑: 沿用 p1 自限速 ~10/s + jitter + 共享 concurrency=1 串行 → 不触 429；中断后按自然键幂等续跑'
  - 'p1/p2/040/041/A股无回归: 新增 3 维度不改现有 17 维（p1 6 维 + p2 5 维 + 040 2 维 + 041 4 维）与 A 股同步行为，既有 IT/单测全绿'
  - '嵌套 dataList 缺字段容忍: 营收/员工 dataList 某项缺字段（如 revenue/value 缺）→ 存 null 不崩；股东某项缺 L 或 S 值 → payload 无损保留、不丢（沿 015 端口层契约 + 041 范式）'
---

# Feature Specification: 港股报告期数据同步（营收构成 / 员工 / 最新股东）

**Feature Branch**: `042-hk-marketdata-reporting-period`
**Created**: 2026-07-15
**Status**: Draft
**Input**: 隶属 [master p3](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md「p3 补充 + 参考/文本」)，形态族「报告期」（4 spec 拆分第 3 个，承接已落地的 040 日频因子 + 041 事件流）。端点/param/字段真实性见 [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md)（2026-07-14 prod 77 read-only PoC 实测）。依赖已完成的 [p1（specs/038）](../038-hk-marketdata-core/spec.md) 平台激活 + [p2（specs/039）](../039-hk-marketdata-quant-signals/spec.md)「加一个 marketdata 维度」6 件套范式 + [041](../041-hk-marketdata-corporate-events/spec.md) 嵌套 payload Json + content_hash 范式。

## Clarifications

### Session 2026-07-15

- Q: 营收构成 / 员工的嵌套 `dataList[]`（维度头行 + 数据行）如何建模落库（决定 2/3 核心表 schema 与量化可查性）？ → A: **展开 typed 子行** —— 营收展开为 `{parentItemName, itemName, revenue, costs, grossProfitMargin}` typed 列子行；员工展开为 `{parentItemName, itemName, value(Decimal), displayType}` typed 列子行。量化可直接 SQL 查分部营收/毛利/人效，与 041「稳定字段用 typed 列」原则一致；纯维度头行（无数值）不落数据行。自然键含 `(instrument, date, parentItemName, itemName)` 粒度。
- Q: 3 报告期维度上线后的常态增量同步 cron 节奏（回填是一次性区间任务，此问增量）？ → A: **季频 quarterly** —— 3 维统一季频增量，贴合 master INV-4「报告期类低频 cron」+ HK 半年报/年报披露节奏（~2x/年）；回填仍为一次性区间任务，与常态增量正交。
- **Probe verified（2026-07-15，prod 77 真 vendor read-only，00700/00005/09988）**：3 端点 `code=1`；① 员工 NK 必含 `displayType`（同名 number+percentage 两行，6/10 期 (parent,item) 碰撞、加 displayType 全期 0 碰撞）② 营收 NK `(instrument,date,parentItemName,itemName)` 22 期 0 碰撞、头行=无 parent+无 value、有 parent 缺 value 存 null、key 带尾随空格须 trim ③ 最新股东 = SERIES 可回填、sharesType={L,S,P} ④ revenue 可负 max 7.5e11 → Decimal(24,2)。详见 [plan.md](./plan.md) §风险。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 港股营收构成（分部）历史可用于回测 (Priority: P1)

量化研究员需要港股近 10 年的**营收构成（operation revenue constitution）**报告期数据 —— 按业务分部 / 服务类型拆解的分部级营收、成本与毛利率（如腾讯「增值服务 / 网络广告 / 金融科技及企业服务」各分部的 revenue / costs / grossProfitMargin）。分部级营收分解是**基本面因子里信息密度最高**的一类：业务结构（business mix）、分部毛利率趋势、增长驱动分部识别，都依赖这份数据，是 042 报告期族**回测价值最高**的切片。

**Why this priority**: 分部营收/毛利分解是基本面策略（业务结构、盈利质量、增长归因）的强输入，vendor 支持 `startDate/endDate` 报告期区间回填多年历史（probe 单只 8 期），字段丰富（revenue/costs/grossProfitMargin），相对员工/股东信号最强、数据最实 → 042 的 MVP 切片。

**Independent Test**: 对港股样本股（如 `hk:00700`，probe 已验有 8 期营收构成）按区间跑营收构成维度回填后，查 PG 出现该标的多期 `market=hk`（经 instrument FK）的分部级营收行（含 revenue/costs/grossProfitMargin），维度头行与数据行正确区分，重复运行幂等无重复。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的（有营收构成披露）, **When** 营收构成维度按报告期区间回填, **Then** 事实表出现该标的多期分部级营收行（含分部标签 + revenue/costs/grossProfitMargin），按自然键唯一、重复运行幂等
2. **Given** vendor `dataList[]` 是「维度头行（无 revenue，parentItemName 分组）+ 数据行」混合结构, **When** 解析入库, **Then** 数据行正确落库并保留其所属分部维度（parentItemName），纯维度头行不误落为数据行
3. **Given** vendor 营收端点 param 为单数 `stockCode` + `startDate/endDate`, **When** adapter 构造请求, **Then** 按该契约逐标的区间拉取（不套用其他端点 param 形态）
4. **Given** 某标的无营收构成披露, **When** 维度运行, **Then** vendor 返 0 行 → 不写库、不崩、不阻塞工作集其余标的
5. **Given** p1/p2/040/041 已上线的 17 维同步, **When** 新增营收构成维度上线, **Then** 现有维度与 A 股同步行为零回归

---

### User Story 2 - 港股最新股东（所有权结构）历史可用于回测 (Priority: P2)

量化研究员需要港股的**最新股东（latest shareholders）**报告期数据 —— 各主要股东的持股数量与占已发行有投票权股份比例（含多头 L / 空头 S 维度），用于所有权集中度、大股东结构、机构持股类信号。此维度 vendor 返回**嵌套数组结构**（`numOfSharesInterestedList[]` / `percentageOfIssuedVotingShares[]`，每项含 `sharesType: L/S`），与 041 股东权益变动同形态 → 复用 041 已定的 payload Json + content_hash 建模范式。

**Why this priority**: 所有权集中度与大股东结构是所有权/治理类信号，量化价值真实；嵌套 L/S 结构建模成本高但 041 已解决（payload Json + content_hash 范式可直接复用）→ 排 P2；vendor 支持区间回填历史（probe 单只 9 行）。

**Independent Test**: 对港股样本股（如 `hk:00700`，probe 已验有马化腾等股东记录）跑最新股东维度后，查 PG 出现该标的股东行，嵌套的 L/S 持股数量与占比完整保留、不丢，按 `(instrument, date, shareholderName, contentHash)` 幂等（含 content_hash 应对同股东同日多笔）。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的（有股东披露）, **When** 最新股东维度按区间回填, **Then** 事实表出现该标的股东行，含股东名 + 多/空（L/S）持股数量与占已发行有投票权股份比例，按自然键唯一、重复运行幂等
2. **Given** vendor 返回嵌套数组（每项 `{value, sharesType}`）, **When** 解析入库, **Then** L/S 两个维度的数值均完整保留（payload Json 无损）；某项缺 L 或 S → 不崩、不丢其余
3. **Given** 同股东同日可能出现多笔实质不同记录, **When** 入库, **Then** content_hash 纳入自然键 → 内容全同才折叠、任何实质差异都保留（沿 041 T018 实证范式）
4. **Given** 某标的无股东披露, **When** 维度运行, **Then** vendor 返 0 行 → 不写库、不崩、不阻塞

---

### User Story 3 - 港股员工（人力结构）历史可用于回测 (Priority: P3)

量化研究员需要港股的**员工（employee）**报告期数据 —— 员工总数及按年龄 / 性别 / 地区等维度的构成、流失率等（vendor `dataList[]` 每项 `{itemName, parentItemName, value, displayType:number/percentage}`），用于人效、规模扩张、人力结构类因子。员工维度是报告期披露频率（probe 单只 2 期），数据结构含 number / percentage 混合语义。

**Why this priority**: 员工规模/流失率是人效与扩张类软信号，量化价值相对较低、披露期数少（probe 仅 2 期）；数据结构含 displayType（number/percentage）语义需保留 → 排 P3；vendor 支持区间回填历史。

**Independent Test**: 对港股样本股（如 `hk:00700`）跑员工维度后，查 PG 出现该标的多期员工数据行（员工总数 / 分维度构成 / 流失率），displayType（number/percentage）语义完整保留，按报告期自然键幂等。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的（有员工披露）, **When** 员工维度按报告期区间回填, **Then** 事实表出现该标的多期员工数据行（含 itemName / parentItemName / value / displayType），按自然键唯一、重复运行幂等
2. **Given** value 语义分 number / percentage（displayType）, **When** 入库, **Then** displayType 完整保留 → 消费方能区分「员工总数 58350（number）」与「总流失率 14.3（percentage）」
3. **Given** itemName 值域随公司不同（按年龄/性别/地区分）, **When** 建模, **Then** 按 `{parentItemName, itemName}` 通用键值对存、不硬编码维度枚举
4. **Given** 某标的无员工披露, **When** 维度运行, **Then** vendor 返 0 行 → 不写库、不崩、不阻塞

---

### Edge Cases

- **无数据标的**：某标的某报告期维度 vendor 返 0 行（无营收构成/无员工/无股东披露） → 不写库、不崩、不阻塞工作集其余标的（沿 p2「南向非成分标的空数据」范式）。
- **维度头行 vs 数据行**（probe verified）：营收 `dataList[]` 混合「纯头行（无 parentItemName + 无 value，如"按服務類型分"）+ 数据行」→ **仅跳过纯头行**；有 parentItemName 的行一律落库（value 可 null —— probe 实证 HSBC "按地區分" 下 英國/香港 等行有 parent 但无 revenue，是缺值数据行不是头行）；无 parentItemName 但有 value 的顶层行（营收合計 / 员工"员工总数"）落库、parentItemName 落 sentinel `''`。
- **key 尾随空格**（probe verified）：vendor parentItemName/itemName 带尾随空格（如"按年龄分 "/"流失率按性别分 "）→ 解析 `.trim()` 归一，否则量化 GROUP BY 漏行、跨期同组 key 不一致。
- **嵌套结构缺字段**：营收/员工某项缺数值（revenue/value 缺）→ 存 null；最新股东某项缺 L 或 S 值 → payload Json 无损保留、不崩、不丢其余维度（沿 015 端口层契约 + 041 范式）。
- **同报告期多笔**（probe verified）：营收 NK 四列 22 期 0 碰撞；员工靠 displayType 去重（全期 0 碰撞）；最新股东含 content_hash（本 2 股 (name,date) 无碰撞，但保留应对 041 已证的同名同日多笔）。
- **displayType 混合语义 + 进 NK**（probe verified）：员工同一 (parentItemName,itemName) 可并存 number 行与 percentage 行（如「流失率按性别分·男性」= {58812 number, 15.2 percentage}）→ displayType 必须保留且**进自然键**，否则两行 skipDuplicates 丢真行。
- **最新股东 SERIES**（probe verified）：`latest-shareholders` 实为报告期×股东序列（00700 返 9 行/5 date、09988 返 14 行/9 date，非覆盖式快照）→ date 进 NK、可回填历史。
- **回填中断续跑**：回填期进程中断 → 按各维度自然键幂等续跑，不产生重复或半行。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 系统 MUST 同步港股（`market=hk`）**营收构成报告期数据**至 PG，支持按 `startDate/endDate` 报告期区间回填多年历史，保留分部级 revenue / costs / grossProfitMargin，并正确区分 vendor `dataList[]` 的「维度头行（分组标签）+ 数据行」结构（数据行落库、保留其所属分部 parentItemName）。
- **FR-002**: 系统 MUST 同步港股**最新股东报告期数据**至 PG，保留嵌套的**多/空（L/S）**持股数量与占已发行有投票权股份比例（vendor 嵌套数组 `numOfSharesInterestedList[]` / `percentageOfIssuedVotingShares[]`）→ L/S 维度不丢；复用 041 已定的 payload Json + content_hash 无损范式。
- **FR-003**: 系统 MUST 同步港股**员工报告期数据**至 PG，保留 dataList 各项的 `itemName / parentItemName / value / displayType`，其中 displayType（number/percentage）语义 MUST 完整保留；itemName 按 `{parentItemName, itemName}` 通用键值对建模，不硬编码维度枚举。
- **FR-004**: 3 报告期维度 MUST 各按其**自然键幂等**（营收 = `(instrument, date, parentItemName, itemName)`；员工 = `(instrument, date, parentItemName, itemName, displayType)`〔displayType 进 NK，probe 实证同名 number/percentage 两行〕；最新股东 = `(instrument, date, shareholderName, content_hash)`）→ 重复同步无重复行、无半行。parentItemName/displayType NK 列 NOT NULL、无值落 sentinel `''`。
- **FR-005**: 系统 MUST 对 3 端点各按其**真实 param 契约**构造请求（均为单数 `stockCode` + `startDate/endDate` 区间，param 第一类）；每端点单独确认，不套用其他端点形态。
- **FR-006**: 系统 MUST 容忍 vendor 数据质量问题（dataList 某项缺字段 / 嵌套项缺 L 或 S）→ 缺字段存 null、payload 无损保留，不崩、不阻塞其余标的与维度（沿 015 端口层契约）。
- **FR-007**: 3 报告期维度 MUST 复用现有平台机制（`marketScope={hk}` 纳入工作集、共享令牌桶自限速回填、soft-依赖 `universe`），新表落 market-agnostic（`instrument_id` FK，无 `hk_*` 前缀，将来 A 股同类可无缝并入）。
- **FR-008**: 新增 3 维度 MUST 不回归 p1（6 维）/ p2（5 维）/ 040（2 维）/ 041（4 维）共 17 维及 A 股同步行为（既有 Testcontainers IT / 单测全绿）。
- **FR-009**: 3 维度 MUST 支持回填历史深度（默认约定 10 年回测样本长度，`sync_dimension.history_depth`，CLI `--history-depth` 可覆盖）与 `--dry-run` 回填估算。
- **FR-010**: 系统 MUST 在上线前对 3 端点逐个对 prod 容器 read-only live-probe 确认 `code=1`（p1 血泪纪律：mock 绿不代表真调有效）；并借该 probe 确认最新股东语义（覆盖式快照 vs 报告期序列）与营收/员工 dataList 真实结构。
- **FR-011**: 3 维度常态增量同步 cron 节奏 MUST 为**低频报告期档**（季频，per master INV-4「持股/报告期类低频 cron」；回填仍为一次性区间任务，与常态增量正交）。

### Key Entities _(include if feature involves data)_

- **RevenueSegment（营收构成）**：港股分部级营收报告期行（typed 子行）。key = instrument（携带 market）+ 报告期日期 + `parentItemName` + `itemName`；含 revenue / costs / grossProfitMargin（Decimal，缺存 null）。market-agnostic + instrument FK，报告期序列可回填；vendor dataList 纯维度头行（无数值）不落数据行。
- **ShareholderSnapshot（最新股东）**：港股股东报告期行。key = instrument + 报告期日期 + 股东名 + content_hash；含嵌套的多/空（L/S）持股数量与占已发行有投票权股份比例（payload Json 无损）。market-agnostic + instrument FK；复用 041 ShareholderChange 的 payload Json + content_hash 范式（与 041 事件流的 ShareholderChange 是**不同语义、独立表** —— 本表为报告期股东名册，041 为权益变动事件）。
- **EmployeeSnapshot（员工）**：港股员工报告期行（typed 子行）。key = instrument + 报告期日期 + `parentItemName` + `itemName` + `displayType`（displayType 进 NK —— probe 实证同名行 number/percentage 并存，如「流失率按性别分·男性」= {58812 number, 15.2 percentage}）；含 value（Decimal(20,4)，缺存 null）+ displayType（number/percentage，语义判别不可丢，既是数据也是 NK 列）。market-agnostic + instrument FK；itemName 按通用键值对存、不硬编码维度枚举；parentItemName/itemName trim 归一。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 港股样本股（如 `hk:00700`）营收构成维度回填后，PG 出现该标的多期（≥5 期）分部级营收行，字段完整（含 revenue / costs / grossProfitMargin），维度头行与数据行正确区分。
- **SC-002**: 港股样本股最新股东维度回填后，PG 出现该标的股东行；嵌套的多/空（L/S）持股数量与占比完整保留、不丢；同股东同日多笔按 content_hash 正确区分不误折叠。
- **SC-003**: 港股样本股员工维度回填后，PG 出现该标的多期员工数据行；displayType（number/percentage）语义完整保留。
- **SC-004**: 任一报告期维度重复运行结果幂等 —— 按各维度自然键无重复行、无半行。
- **SC-005**: p1（6 维）/ p2（5 维）/ 040（2 维）/ 041（4 维）共 17 维及 A 股同步零回归（既有 Testcontainers IT + 单测全绿）。
- **SC-006**: 回填期不触发 vendor 限流封禁（沿用自限速 ~10/s + jitter，无 429 累积）。

## Assumptions

- 复用 p1（038）已激活的 marketdata 平台 + p2（039）「加一个 marketdata 维度」6 件套范式（port / adapter / mock / dimension-executor / schema+migration / IT）+ 041 嵌套 payload Json + content_hash 范式。
- 3 维度默认历史深度 **10 年**（照 p1/p2/041 回测样本长度约定，`sync_dimension.history_depth`），CLI `--history-depth` 可覆盖。
- 3 维度均 param 契约第一类（单数 `stockCode` + `startDate/endDate` 区间），可回填历史报告期序列；不用 metricsList → 无 all-or-nothing 静默 0 行坑。
- 新增 3 张事实表均 market-agnostic（`instrument_id` FK + market 经 instrument 携带，per master INV-1 Securities Master 范式），将来 A 股同类可无缝并入；金融数值一律 Decimal（禁 Float，沿 041 精度约定），vendor 缺字段存 null。
- **营收/员工 dataList 嵌套建模 = 展开 typed 子行**（clarify 2026-07-15 定 + probe verified：营收 NK `(instrument,date,parentItemName,itemName)` / 员工 NK `(instrument,date,parentItemName,itemName,displayType)`，量化可 SQL 直查）；**最新股东嵌套 L/S/P 沿用 041 已定 payload Json + content_hash 范式**（同形态，已解决）。
- **最新股东语义 = 报告期×股东序列（probe verified SERIES，可回填）**，date 进 NK（00700/09988 均返多 date 行，非覆盖式快照）。
- 3 维度 soft-依赖 `universe`（标的须先注册），`sync_dependency` 加 `universe→dim` 边；常态增量 cron 节奏为**季频报告期档**（clarify 2026-07-15 定，per master INV-4）。
- 纯 server 数据摄取，单 bounded context `marketdata`，单 PR，无 mobile/web surface、无 UI/mockup、无 OpenAPI 契约变更。
