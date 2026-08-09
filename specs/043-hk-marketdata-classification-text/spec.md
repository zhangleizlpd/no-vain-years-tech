---
feature_id: 043-hk-marketdata-classification-text
modules: [marketdata]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-07-15
updated_at: 2026-07-16
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 端数据摄取 —— 港股新增 2 类「分类/文本」维度（所属行业 / 公告）同步进 PG，零 mobile/web surface。新增 2 张 market-agnostic 事实表（含 instrument FK），不新增读端点（读侧 015 market-agnostic 天然覆盖；本 feature 只让 PG 事实层多出这 2 类 market=hk 真数据）。无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - '所属行业覆盖式快照: industries 端点单数 stockCode + 无 date（返当前全量行业归属集合快照，非历史序列）→ 覆盖式 per-instrument 单 $transaction 内 deleteMany({instrumentId}) + createMany 原子替换反映最新（照抄 039 index_membership syncIndexMembership），无 mode 分支；NK (instrument, source, industryCode) 无 date'
  - '所属行业空返回不 wipe: vendor 返 [] = 真无归属 vs transient blip 未定 → interim 保守语义（同 index_membership）: 空返回跳过 mutate 计 ok、不 deleteMany，避免瞬时空响应误清既有归属'
  - '所属行业代码字段消歧: vendor 返回行的 stockCode 字段实为行业代码（H70，恒生行业分类节点）非个股代码 → 存为 industryCode 列防与 Instrument.code 混淆；一股属多个行业分类（probe 00700 → 3 行）全落、不去重'
  - '公告文本流区间回填: announcement 端点单数 stockCode + startDate + endDate（区间）→ mode 分 from（backfill: from=asOf−historyDepth 10yr；delta: targetDate）→ createMany({skipDuplicates}) on (instrument,date,linkUrl)，backfill per-stock backfillPacer.pace()（照抄 041 syncBuyback range 形态）'
  - '公告超大表只存元数据: announcement 是本 feature 唯一潜在超大表（~2700 股 × 300+/2yr → 10yr ≈ 4-5M 行，HK 数据集最大表）→ 只存元数据（linkUrl / date / linkText / linkType / types）不存 PDF 正文；types[] 用 Postgres String[]（text[]，量化可 array 查询），缺字段存 null / 空数组'
  - '公告 linkUrl 天然唯一 NK: linkUrl 是 HKEX 文档全局唯一 URL → NK (instrument, date, linkUrl) 幂等：同 URL 折叠、不同 URL 保留；无需 content_hash（probe verified 00700 2 年 433/433 unique + (date,linkUrl) 433/433 无碰撞；maxLen 79 → VarChar 留足）'
  - '公告无分页单请求: 10yr 区间单 POST 返全量（probe verified 00700 1152 行/10yr、date-range 2016..2026 全覆盖、无 cap/无分页）→ adapter 照抄 buyback 单请求区间，无需 date-chunking/分页游标'
  - '公告 ≤10yr 硬上限 403: >10yr 区间 → HTTP 403 code=0（probe verified 2014..2026，同 dividend ≤10yr 限）→ history_depth=3650（≈9.99yr）卡限内安全、adapter 不得构造超 10yr 区间（backfill from=asOf−3650 天然满足）'
  - '公告 date 为 +08:00: vendor date 格式 `...T00:00:00+08:00`（probe verified HK-local）→ lixDateOnly slice(0,10) 正确无 off-by-one（异于 042 营收 UTC-Z 需 lixDateOnlyHk），同 buyback/allotment 用 lixDateOnly'
  - 'industries 3 级层级路径: vendor 返 hsi L1/L2/L3 层级 3 行/股（probe verified 00700 → H70 资讯科技业 / H7020 软件服务 / H702015 数码解决方案服务）→ 各 industryCode 唯一进 NK；层级由 industryCode 前缀/长度天然派生，不加 level 列'
  - '公告历史 10yr 可回填: announcement 支持 startDate/endDate 区间 → history_depth=3650（10 年，user 2026-07-15 拍板；与其他可回填维度一致、master INV-5 已按 10yr ~2-5M 行估算单 Postgres 可承载），CLI --history-depth 可覆盖'
  - 'param 契约二分每端点单独确认: industries 单数 stockCode 快照（无 date）/ announcement 单数 stockCode + range，两类不同 → 每端点单独确认不套用（延续 p1 #673 / p2 / 041 / 042 教训）'
  - '无 metricsList all-or-nothing 坑: 2 端点均不用 metricsList（industries 用 stockCode / announcement 用 stockCode+range）→ p1 #670「含一个 hk 无效 metric 整请求静默 0 行」的坑在本 feature 不存在'
  - '2 维度 marketScope 纳入: 新增 sync_dimension 行 marketScope={hk} → 工作集含 hk 标的，统一消费共享令牌桶'
  - '新表 market-agnostic: 新增 2 张表均 instrument_id FK + market 经 instrument 携带，无 hk_* 前缀，将来 A 股同类可无缝并入'
  - '依赖 universe: 2 维度均 soft-依赖 universe（标的须先注册）→ universe 未跑时工作集为空、不误建标的'
  - 'cron 夜频二档: 2 维度统一 22:00 夜窗（0 0 22 * * *，共用 master INV-3 错峰夜窗，异于 042 报告期季频）→ industries freshness=slow-drift（分类罕变，恒覆盖式确认，照 index_membership 夜频）/ announcement freshness=continuous-daily（文本流每日新披露）'
  - '回填自限速续跑: announcement 10yr 全港股回填沿用 p1 自限速 ~10/s + jitter + 共享 concurrency=1 串行 → 不触 429；industries 全域扫恒限速；中断后按各自然键幂等续跑'
  - 'p1/p2/040/041/042/A股无回归: 新增 2 维度不改现有 20 维（p1 6 维 + p2 5 维 + 040 2 维 + 041 4 维 + 042 3 维）与 A 股同步行为，既有 IT/单测全绿'
  - 'vendor 缺字段容忍: announcement 某行缺 linkText/linkType/types → 存 null/空数组不崩；industries 某行缺 name/areaCode → 存 null 不崩、不丢其余（沿 015 端口层契约）'
---

# Feature Specification: 港股分类文本数据同步（所属行业 / 公告）

**Feature Branch**: `043-hk-marketdata-classification-text`
**Created**: 2026-07-15
**Status**: Implemented
**Input**: 隶属 [master p3](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md「p3 补充 + 参考/文本」)，形态族「分类文本」（4 spec 拆分**第 4 个（最后一个）**，承接已落地的 040 日频因子 + 041 事件流 + 042 报告期）。端点/param/字段真实性见 [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md)（2026-07-14 prod 77 read-only PoC 实测）。依赖已完成的 [p1（specs/038）](../038-hk-marketdata-core/spec.md) 平台激活 + [p2（specs/039）](../039-hk-marketdata-quant-signals/spec.md)「加一个 marketdata 维度」6 件套范式（尤其 `index_membership` **覆盖式快照**范式）+ [041](../041-hk-marketdata-corporate-events/spec.md) range 事件流 createMany 范式。

## Clarifications

### Session 2026-07-15

- Q: 公告（announcement）全港股回填历史深度定多少（本 feature 唯一潜在超大表 ~2700 股 × 300+/2yr → 10yr ≈ 4-5M 行，是整个 HK 数据集最大的表；只存元数据不存 PDF）？ → A: **10 年（3650d）** —— 照其他所有可回填维度 + master INV-5 已按 10yr（~2-5M 行）估算并确认单 Postgres 可承载；一致性最好、量化事件研究窗口最全。CLI `--history-depth` 仍可临时覆盖。
- Q: 所属行业（industries）覆盖式快照 vs 带 date 的历史序列？ → A: **覆盖式快照**（同 p2 `index_membership`）—— vendor industries 端点**无 date 字段**（返当前分类快照，非历史序列），恒取全量当前归属集合、per-instrument 单 $transaction 内 deleteMany+createMany 原子替换反映最新；NK `(instrument, source, industryCode)` 不含 date。此形态由 vendor 无 date 决定，非选择。
- Q: 2 维度常态增量 cron 节奏（异于 042 报告期季频）？ → A: **统一 22:00 夜频**（`0 0 22 * * *`，共用 master INV-3 错峰夜窗，同所有 HK 维度含 index_membership）—— industries `slow-drift`（分类罕变，恒覆盖式确认，照 index_membership 夜频）；announcement `continuous-daily`（文本流每日新披露）。回填仍为一次性区间任务（仅 announcement 有回填；industries 覆盖式无历史），与常态增量正交。
- **Probe verified（2026-07-15，prod 77 `nvy-tight-app-1` 真 vendor read-only，样本 `hk:00700`/`00005`/`00981`/`08526`；2026-07-14 p3 探查报告基础上 043 上线前重探）**：2 端点 `code=1`。① **industries**：覆盖式快照**无 date**，返 hsi **3 级层级路径** 3 行/股（00700 → `H70` 资讯科技业 / `H7020` 软件服务 / `H702015` 数码解决方案服务；`stockCode` 字段=行业代码，`source` 全 `hsi`，`areaCode`=`hk`）。② **announcement**：字段 `{linkUrl, date, linkText, linkType, types[]}`；date 为 `+08:00`（HK-local，`lixDateOnly` 正确无 off-by-one）；`types` 为**数组**（值域 srp/ndd_r/mr/fs/fs_esg/dividend...）；`linkType`='PDF'；**linkUrl 全局唯一**（00700 2 年 433/433 unique，maxLen 79）、`(date,linkUrl)` NK 433/433 无碰撞；**10yr 区间单请求返全量 1152 行、无 cap/无分页**；**>10yr 区间 → HTTP 403 code=0（≤10yr 硬上限，同 dividend）** → `history_depth=3650`（≈9.99yr）卡限内安全、adapter 单 POST 无需 date-chunking。**FR-010 上线首夜 supervised 前再核一次 `code=1`（防 token/配额漂移）= deferred**（照 041/042 out-of-scope）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 港股所属行业分类可用于回测 (Priority: P1)

量化研究员需要港股每只标的的**所属行业分类（industries）** —— 即该股在恒生行业分类（source=hsi）体系下归属的行业节点（如腾讯归属「资讯科技业」等 3 个分类）。行业归属是量化里**使用面最广**的一类元数据：行业中性化（industry-neutral 因子）、板块轮动、同业配对、行业暴露约束，几乎所有截面策略都依赖它。这是 043「分类文本」族**回测价值最高**的切片，且量级极小（快照，非日频/文本流）→ 排 P1 MVP。

**Why this priority**: 行业归属是几乎所有截面量化策略的底层元数据（中性化 / 分组 / 暴露约束），使用面最广；数据量极小（覆盖式快照，一股数行），实现风险最低（照抄已上线的 `index_membership` 覆盖式范式）→ 043 的 MVP 切片。

**Independent Test**: 对港股样本股（如 `hk:00700`，probe 已验归属 3 个行业分类）跑所属行业维度后，查 PG 出现该标的多行 `market=hk`（经 instrument FK）的行业分类行（含 industryCode + source + name），一股多行业全落；重复运行覆盖式反映最新、旧归属被替换、无残留半量。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的（有行业归属）, **When** 所属行业维度运行, **Then** 事实表出现该标的多行行业分类行（含行业代码 industryCode + source + 行业名 name），一股属多行业全落，按自然键 `(instrument, source, industryCode)` 唯一
2. **Given** vendor 返回的行 `stockCode` 字段实为**行业代码**（H70）非个股代码, **When** 解析入库, **Then** 该字段落 `industryCode` 列（不与 Instrument.code 混淆），source/name/areaCode 一并保留
3. **Given** 某标的行业归属发生变化（新增/移除分类）, **When** 维度再次运行, **Then** 覆盖式原子替换 —— 旧归属集合被当前快照整体替换，无残留旧行、无半量（单 $transaction 内 deleteMany+createMany）
4. **Given** vendor 对某标的返 0 行（空响应，真无归属 vs 瞬时 blip 不可辨）, **When** 维度运行, **Then** 跳过 mutate（不 deleteMany）计 ok —— 保守不因疑似瞬时空响应误清既有归属（interim 语义同 index_membership）
5. **Given** p1/p2/040/041/042 已上线的 20 维同步, **When** 新增所属行业维度上线, **Then** 现有维度与 A 股同步行为零回归

---

### User Story 2 - 港股公告元数据流可用于事件研究回测 (Priority: P2)

量化研究员需要港股的**公告（announcement）**元数据流 —— 各标的历次 HKEX 披露文档的时点（date）、标题（linkText）、类型（linkType / types）与文档链接（linkUrl），用于事件研究（event study）：公告时点 + 类型作为事件信号（如回购公告、业绩预告、股权披露的市场反应窗口）。本维度是**文本流形态**、本 feature **唯一潜在超大表**（只存元数据、不存 PDF 正文）。

**Why this priority**: 公告事件流的量化价值真实（事件研究 / 异常收益窗口 / 披露类型信号），但相对行业分类使用面窄、且是唯一潜在超大表（回填成本 + 存储量最大）→ 排 P2；vendor 支持 `startDate/endDate` 区间回填多年历史（probe 单只 300+ 行/2 年），只存元数据（linkUrl/date/linkText/linkType/types）控表体积。

**Independent Test**: 对港股样本股（如 `hk:00700`，probe 已验 300+ 行/2 年）按区间跑公告维度回填后，查 PG 出现该标的多年 `market=hk` 的公告元数据行（含 linkUrl + date + linkText + linkType + types[]），按 `(instrument, date, linkUrl)` 幂等（linkUrl 天然唯一），重复运行无重复行。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的（有公告披露）, **When** 公告维度按区间回填, **Then** 事实表出现该标的多年公告元数据行（含 linkUrl + date + linkText + linkType + types[]），按自然键 `(instrument, date, linkUrl)` 唯一、重复运行幂等
2. **Given** vendor 返回 `types[]` 是数组（如 `["ndd_r"]`）, **When** 入库, **Then** types 完整保留为可查询数组（Postgres text[]）；缺 types/linkText/linkType → 存 null/空数组不崩、不丢其余字段
3. **Given** 公告端点 param 为单数 `stockCode` + `startDate/endDate`, **When** adapter 构造请求, **Then** 按该契约逐标的区间拉取（不套用 industries 的单数快照形态）
4. **Given** 某标的无公告披露, **When** 维度运行, **Then** vendor 返 0 行 → 不写库、不崩、不阻塞工作集其余标的
5. **Given** 只存元数据不存 PDF, **When** 入库, **Then** 表仅含 linkUrl（文档链接）等元数据，不下载/不落 PDF 正文（控 4-5M 行超大表体积）

---

### Edge Cases

- **无数据标的**：某标的行业归属 / 公告 vendor 返 0 行 → industries 跳过 mutate（不 wipe）计 ok；announcement 不写库 → 均不崩、不阻塞工作集其余标的（沿 p2「南向非成分标的空数据」范式）。
- **industries 空返回歧义**（probe 保守语义）：vendor 返 [] 无法辨「真无归属」vs「瞬时 blip」→ interim **跳过 mutate 不 deleteMany**（同 index_membership），避免误清既有归属；从未有归属的股 deleteMany([])+createMany([]) 本就零行，二者等价，差别仅「曾有归属→突返空」时保留旧行。
- **行业代码字段消歧**（probe verified）：vendor 行的 `stockCode` 字段是**行业代码**（H70）非个股 → 落 `industryCode` 列；一股属多行业（00700 → 3 行）全落、不去重。
- **公告 linkUrl 唯一性**：linkUrl 是 HKEX 文档全局唯一 URL → NK `(instrument, date, linkUrl)` 天然去重，无需 content_hash；同标的同日多份公告靠不同 linkUrl 各自成行。
- **公告缺字段**：某公告行缺 linkText/linkType → 存 null；缺/空 types → 存空数组 `{}`；均不崩、不丢 linkUrl/date（沿 015 端口层契约）。
- **公告超大表**：10yr 全港股 ~4-5M 行 → 只存元数据（不存 PDF），回填保守多夜自限速，master INV-5 已确认单 Postgres 可承载。
- **回填中断续跑**：announcement 回填期进程中断 → 按 `(instrument, date, linkUrl)` 幂等续跑，不产生重复或半行；industries 覆盖式每股 $transaction 原子，中断不留半量。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 系统 MUST 同步港股（`market=hk`）**所属行业分类**至 PG，保留每只标的在 hsi 体系下归属的全部行业分类（industryCode + source + name + areaCode），一股多行业全落；形态为**覆盖式快照**（无历史 date），恒反映当前最新归属集合。
- **FR-002**: 系统 MUST 同步港股**公告元数据流**至 PG，支持按 `startDate/endDate` 区间回填多年历史（默认 10 年），保留每条公告的 linkUrl / date / linkText / linkType / types[]（**只存元数据，不存 PDF 正文**）。
- **FR-003**: 所属行业维度 MUST 以**覆盖式原子替换**落库 —— per-instrument 单事务内先删本股旧归属、再灌当前快照集合（无 mode 分支）；vendor 空返回时 MUST **跳过 mutate（不删既有归属）** 计 ok（interim 保守语义，防瞬时空响应误清，同 `index_membership`）。
- **FR-004**: 2 维度 MUST 各按其**自然键幂等**（所属行业 = `(instrument, source, industryCode)`〔无 date〕；公告 = `(instrument, date, linkUrl)`〔linkUrl 天然唯一，无需 content_hash〕）→ 重复同步无重复行、无半行。NK 字符串列 NOT NULL、无值落 sentinel `''`。
- **FR-005**: 系统 MUST 对 2 端点各按其**真实 param 契约**构造请求（所属行业 = 单数 `stockCode` 快照〔无 date〕；公告 = 单数 `stockCode` + `startDate/endDate` 区间）；每端点单独确认，不套用对方形态。
- **FR-006**: 系统 MUST 容忍 vendor 数据质量问题（公告缺 linkText/linkType/types、行业缺 name/areaCode）→ 缺字段存 null / 空数组，不崩、不阻塞其余标的与维度（沿 015 端口层契约）。
- **FR-007**: 2 维度 MUST 复用现有平台机制（`marketScope={hk}` 纳入工作集、共享令牌桶自限速回填、soft-依赖 `universe`），新表落 market-agnostic（`instrument_id` FK，无 `hk_*` 前缀，将来 A 股同类可无缝并入）。
- **FR-008**: 新增 2 维度 MUST 不回归 p1（6 维）/ p2（5 维）/ 040（2 维）/ 041（4 维）/ 042（3 维）共 20 维及 A 股同步行为（既有 Testcontainers IT / 单测全绿）。
- **FR-009**: 公告维度 MUST 支持回填历史深度（默认 10 年回测样本长度，`sync_dimension.history_depth=3650`，CLI `--history-depth` 可覆盖）与 `--dry-run` 回填估算；所属行业维度**覆盖式无历史**（`history_depth=NULL`，不纳入回填估算）。
- **FR-010**: 系统 MUST 在上线前对 2 端点逐个对 prod 容器 read-only live-probe 确认 `code=1`（p1 血泪纪律：mock 绿不代表真调有效）；并借该 probe 确认所属行业覆盖式快照语义 + 行业代码字段、公告 types[] 值域 + 超大表分页/量级（deferred 首夜 supervised ops）。
- **FR-011**: 2 维度常态增量 cron 节奏 MUST 为**统一 22:00 夜频**（`0 0 22 * * *`，共用 master INV-3 错峰夜窗）；freshness 画像分二档：所属行业 `slow-drift`（分类罕变、恒覆盖式确认）、公告 `continuous-daily`（文本流每日新披露）。

### Key Entities _(include if feature involves data)_

- **IndustryClassification（所属行业）**：港股行业分类归属行（覆盖式快照，**无 date**）。key = instrument（携带 market）+ `source` + `industryCode`；含 name（行业名）+ areaCode。market-agnostic + instrument FK；一股多行业（多行）；覆盖式反映当前最新归属（旧归属被整体替换）。vendor 行的 `stockCode` 字段实为**行业代码**（H70）→ 落 `industryCode` 列防混淆。复用 039 `IndexMembership` 覆盖式范式（与 IndexMembership 是**不同语义、独立表** —— 本表为行业分类归属，IndexMembership 为指数成分归属）。
- **Announcement（公告）**：港股公告元数据行（文本流，**只存元数据不存 PDF**）。key = instrument + 报告 date + `linkUrl`（linkUrl 天然唯一）；含 linkText（标题）+ linkType（如 PDF）+ types[]（Postgres text[] 数组，缺存空数组）。market-agnostic + instrument FK；支持 10 年区间回填；本 feature 唯一潜在超大表（10yr ~4-5M 行）。缺字段存 null，不下载/不落 PDF 正文。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 港股样本股（如 `hk:00700`）所属行业维度运行后，PG 出现该标的多行（≥3 行）行业分类行，字段完整（含 industryCode / source / name），一股多行业全落。
- **SC-002**: 港股样本股公告维度回填后，PG 出现该标的多年（跨多个 date）公告元数据行，字段完整（含 linkUrl / date / linkText / linkType / types[]），只存元数据无 PDF 正文。
- **SC-003**: 所属行业维度覆盖式生效 —— 标的归属变化后重跑，旧归属被当前快照整体替换、无残留旧行；vendor 空返回时既有归属不被误清。
- **SC-004**: 任一维度重复运行结果幂等 —— 按各维度自然键（行业 `(instrument,source,industryCode)` / 公告 `(instrument,date,linkUrl)`）无重复行、无半行。
- **SC-005**: p1（6 维）/ p2（5 维）/ 040（2 维）/ 041（4 维）/ 042（3 维）共 20 维及 A 股同步零回归（既有 Testcontainers IT + 单测全绿）。
- **SC-006**: 公告 10 年全港股回填期不触发 vendor 限流封禁（沿用自限速 ~10/s + jitter，无 429 累积）。

## Assumptions

- 复用 p1（038）已激活的 marketdata 平台 + p2（039）「加一个 marketdata 维度」6 件套范式（port / adapter / mock / dimension-executor / schema+migration / IT），尤其 039 `index_membership` **覆盖式快照**范式（US1 直接照抄）+ 041 `syncBuyback` **range 事件流** createMany 范式（US2 直接照抄）。
- 公告默认历史深度 **10 年**（照 p1/p2/041/042 回测样本长度约定，`sync_dimension.history_depth=3650`，user 2026-07-15 拍板），CLI `--history-depth` 可覆盖；所属行业覆盖式无历史（`history_depth=NULL`）。
- 2 维度 param 契约二分（所属行业单数 `stockCode` 快照〔无 date〕 / 公告单数 `stockCode` + `startDate/endDate` 区间），每端点单独确认；均不用 metricsList → 无 all-or-nothing 静默 0 行坑。
- 新增 2 张事实表均 market-agnostic（`instrument_id` FK + market 经 instrument 携带，per master INV-1 Securities Master 范式），将来 A 股同类可无缝并入；文本/分类字段 vendor 缺存 null / 空数组；公告 types[] 用 Postgres `String[]`（text[]，量化 array 可查）。
- 所属行业 vendor 行的 `stockCode` 字段实为**行业代码**（H70）→ 存 `industryCode` 列防与个股 code 混淆；一股属多行业全落。
- 公告 NK `(instrument, date, linkUrl)` —— linkUrl 是 HKEX 文档全局唯一 URL，天然去重，无需 content_hash。
- 2 维度 soft-依赖 `universe`（标的须先注册），`sync_dependency` 加 `universe→dim` 边；常态增量 cron 统一 22:00 夜频（`0 0 22 * * *`，共用 master INV-3 错峰夜窗），freshness 二档（行业 slow-drift / 公告 continuous-daily）。
- 纯 server 数据摄取，单 bounded context `marketdata`，单 PR，无 mobile/web surface、无 OpenAPI 契约变更。
