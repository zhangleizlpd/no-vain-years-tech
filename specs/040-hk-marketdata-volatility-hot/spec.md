---
feature_id: 040-hk-marketdata-volatility-hot
modules: [marketdata]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-07-14
updated_at: 2026-07-14
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 端数据摄取 —— 港股新增 2 类信号维度（波动率日频历史 + 热度精选快照）同步进 PG，零 mobile/web surface。新增 2 张 market-agnostic 事实表（含 instrument FK），但不新增读端点（读侧 015 market-agnostic 天然覆盖；本 feature 只让 PG 事实层多出这 2 类 market=hk 真数据）。无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - '波动率日频回填: 单只港股 volatility 按窗口+区间拉 → VolatilityDaily (instrumentId,date,volatilityDays) 落 value（年化 HV），重复运行幂等无重复行'
  - '波动率多窗口: 配置 N 个 volatilityDays → 每窗口单独请求（vendor 契约 volatilityDays=number 单数，数组 400）→ 同一 (instrumentId,date) 出 N 行（每窗口一行）'
  - '波动率历史深度: volatility 支持 startDate/endDate 区间 → 可回填多年日频序列（回测样本长度）'
  - '热度快照按数据日期累积: hk 标的 hot/{type} 忽略请求日期永返最新（含 last_data_date）→ HotSnapshot (instrumentId,hotType,dataDate) 按数据日期 upsert，数据日期未变幂等覆盖同行、变则落新行（自建前向序列，tr 日频 / capita 年度）'
  - '热度不可回填: hot 端点无历史（快照）→ 从上线日起逐次同步只更新最新值，spec 明记回测价值受限（无历史序列）'
  - '热度精选 type: 只同步量化常用 type 子集，每 type 单独请求（param stockCodes[] 数组）→ 统一 HotSnapshot 表按 hotType 区分行'
  - 'param 契约三分: volatility 单数 stockCode+volatilityDays / hot 数组 stockCodes[] 快照 → adapter 每端点按其真实 param 契约构造，不套用'
  - 'hot payload 异构: 每 type 返回字段结构完全不同（capita/ss/tr/rep 字段各异）→ 统一 payload 结构化存原始字段，不硬编码列，新增 type 零 schema 变更'
  - 'vendor 数据质量容错: hot/rep 含异常 key "undefined" → 解析时忽略；某标的某维度缺字段 → 存 null 不崩（沿 015 端口层契约）'
  - '2 维度 marketScope 纳入: 新增 2 个 sync_dimension 行 marketScope={hk} → 工作集含 hk 标的，统一消费共享令牌桶'
  - '2 张新表 market-agnostic: 新表均 instrument_id FK + market 经 instrument 携带，无 hk_* 前缀，将来 A 股同类可无缝并入'
  - '依赖 universe: 2 维度均 soft-依赖 universe（标的须先注册）→ universe 未跑时工作集为空、不误建标的'
  - '回填自限速续跑: 沿用 p1 自限速 ~10/s + jitter + 共享 concurrency=1 串行 → 不触 429；中断后按自然键幂等续跑'
  - 'p1/p2/A股无回归: 新增 2 维度不改现有 11 维（p1 6 维 + p2 5 维）与 A 股同步行为，既有 IT/单测全绿'
---

# Feature Specification: 港股波动率 + 热度精选信号同步（波动率日频历史 / 热度精选快照）

**Feature Branch**: `040-hk-marketdata-volatility-hot`
**Created**: 2026-07-14
**Status**: Draft
**Input**: 隶属 [master p3](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md「p3 补充 + 参考/文本」)，形态族「日频因子」（4 spec 拆分第 1 个）。端点/param/字段真实性见 [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md)（2026-07-14 prod 77 read-only PoC 实测）。依赖已完成的 [p1（specs/038）](../038-hk-marketdata-core/spec.md) 平台激活 + [p2（specs/039）](../039-hk-marketdata-quant-signals/spec.md) 「加一个 marketdata 维度」6 件套范式。

## Clarifications

### Session 2026-07-14

- Q: 波动率同步哪些 `volatilityDays` 窗口子集？ → A: **30 / 60 / 250**（短/中/年化三档，量化标准；行数 = 3× 波动率日频序列）
- Q: 热度同步哪些 `hot/{type}` 精选 type？ → A: **ss / tr / capita / rep**（卖空聚合 / 换手率 / 股东数 / 相对强度，四类量化常用因子，字段均已 p3 probe 验证）
- Q: 热度快照存储策略（覆盖单行 vs 累积历史）？ → A: **按 vendor 数据日期累积** —— `HotSnapshot` 唯一键 = `(instrumentId, hotType, dataDate)`，dataDate = vendor `last_data_date`；数据日期未变则幂等覆盖同行（无重复值），随各 type 更新频率自建前向序列（tr 日频 / capita 年度）

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 港股波动率日频历史因子可用于回测 (Priority: P1)

量化研究员需要港股近 10 年的**每日历史波动率**（annualized HV，按不同回看窗口如 30/60/250 天），作为择时、风险平价、波动率因子类策略的输入。波动率是**日频、可回填历史序列**（vendor 支持区间拉取），是本 feature 回测价值最高、建模最简单的切片（每行仅 `date + value`）。

**Why this priority**: 历史波动率是量化择时与风险管理最基础的市场微观结构因子，vendor 支持多年区间回填 → 回测样本长度充足；建模成本低（扁平日频表），回测价值高 → P3 sub-plan 的 MVP 切片。

**Independent Test**: 对港股样本股（如 `hk:00700`）按配置窗口跑 volatility 维度回填后，查 PG `volatility_daily` 出现该标的多年 `market=hk`（经 instrument FK）的日频波动率行（每窗口一行），重复运行幂等无重复。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的, **When** 波动率维度按单一窗口区间回填, **Then** `volatility_daily` 出现该标的多年日频波动率行（`(instrumentId,date,volatilityDays)` 唯一），重复运行幂等
2. **Given** 配置多个 `volatilityDays` 窗口, **When** 波动率维度运行, **Then** 每窗口对同一 `(instrumentId,date)` 各落一行（窗口数 = 行倍数），adapter 每窗口独立请求
3. **Given** vendor 契约要求 `volatilityDays` 为 number 单数, **When** adapter 构造请求, **Then** 每窗口传单一 number（不传数组），避免 400
4. **Given** p1/p2 已上线的 11 维同步, **When** 新增波动率维度上线, **Then** 现有维度与 A 股同步行为零回归

---

### User Story 2 - 港股热度精选信号快照增量累积 (Priority: P2)

量化研究员需要港股的**情绪/微观结构热度信号**（卖空聚合、换手率、股东数结构、相对强度等），用于情绪择时与拥挤度监控。此类信号 vendor 只提供**当前快照**（无历史序列），故本 feature **从上线日起增量累积最新值**、覆盖式更新，明确不承诺历史回填 —— 其回测价值受限于「无历史深度」，主要服务上线后的滚动监控与逐日快照沉淀。

**Why this priority**: 热度信号是拥挤度/情绪类因子的补充，但因 vendor 快照不可回填历史，回测价值弱于波动率 → 排 P2；以「精选高信号 type + 增量累积」低成本纳入，不为全 39-type 建重表。

**Independent Test**: 对港股样本股跑热度精选维度后，查 PG `hot_snapshot` 出现该标的每精选 `hot_type` 一行最新快照（含结构化 payload）；再次运行覆盖同一行不新增；异构字段（不同 type 字段结构不同）完整存于 payload 不丢。

**Acceptance Scenarios**:

1. **Given** 已注册港股标的与精选 `hot_type` 集, **When** 热度维度运行, **Then** `hot_snapshot` 每 `(instrumentId,hotType)` 出现一行最新快照，含 vendor 原始字段 payload + `last_data_date`
2. **Given** 已有某标的某 type 的快照, **When** 热度维度再次运行, **Then** 覆盖式更新该行（不新增行），反映最新值
3. **Given** 某 `hot_type` 返回含异常 key（如 `rep` 的 `"undefined"`）或字段缺失, **When** 解析入库, **Then** 忽略异常 key / 缺字段存 null，不崩、不阻塞其余 type
4. **Given** vendor hot 端点忽略日期只返最新, **When** 请求历史区间, **Then** 系统按快照语义只更新最新值，不误判为历史序列

---

### Edge Cases

- **无数据标的**：某标的某窗口/type vendor 返 0 行（如新上市不足回看窗口、非做空标的的 ss） → 不写库、不崩、不阻塞工作集其余标的（沿 p2「南向非成分标的空数据」范式）。
- **窗口不足**：波动率回看窗口（如 250 天）长于标的上市时长 → 该标的早期日期无波动率行，属正常。
- **payload 结构漂移**：vendor 某 type 新增/改字段 → payload 结构化存原始 → 零 schema 变更自动容纳。
- **回填中断续跑**：回填期进程中断 → 按自然键（波动率 `(instrumentId,date,volatilityDays)` / 热度 `(instrumentId,hotType)`）幂等续跑，不产生重复或半行。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 系统 MUST 同步港股（`market=hk`）**波动率日频历史**至 PG，支持按区间回填多年历史序列（回测样本长度）。
- **FR-002**: 波动率每 `(instrument, date, volatilityDays)` 唯一，重复同步幂等（无重复行）。
- **FR-003**: 系统 MUST 对每个配置的波动率回看窗口（`volatilityDays`）**独立请求**（vendor 契约：`volatilityDays` 为 number 单数，数组会被拒 400）。
- **FR-004**: 系统 MUST 同步港股**热度精选信号快照**至 PG，每精选 `hot_type` 对每标的按 vendor 数据日期累积（唯一键 `(instrument, hot_type, data_date)`，`data_date` = vendor `last_data_date`）；数据日期未变则幂等覆盖同行、变则落新行（随更新频率自建前向序列）。
- **FR-005**: 热度快照 MUST 按「从上线日起增量累积」语义运行 —— vendor 无历史（快照），系统不承诺、不尝试回填历史序列；spec 明记该维度回测价值受限。
- **FR-006**: 热度信号 MUST 以**结构化 payload** 存 vendor 原始字段（每 type 字段结构不同）→ type 间字段差异不丢数据、新增 type 零 schema 变更。
- **FR-007**: 系统 MUST 容忍 vendor 数据质量问题（如 `hot/rep` 含异常 key `"undefined"`、字段缺失）→ 忽略异常 key / 缺字段存 null，不崩不阻塞。
- **FR-008**: 波动率与热度 2 维度 MUST 复用现有平台机制（`marketScope={hk}` 纳入工作集、共享令牌桶自限速回填、soft-依赖 universe），落 market-agnostic 表（`instrument_id` FK，无 `hk_*` 前缀）。
- **FR-009**: 新增 2 维度 MUST 不回归 p1（6 维）/ p2（5 维）及 A 股同步行为（既有 IT/单测全绿）。
- **FR-010**: 系统 MUST 同步波动率窗口子集 = **30 / 60 / 250 天**（短/中/年化三档；每窗口独立请求、独立成行）。
- **FR-011**: 系统 MUST 同步热度 type 子集 = **`ss` / `tr` / `capita` / `rep`**（卖空聚合 / 换手率 / 股东数 / 相对强度）。

### Key Entities _(include if feature involves data)_

- **VolatilityDaily**：港股日频历史波动率事实行。key = instrument（携带 market）+ 交易日 + 回看窗口天数；value = 该窗口年化历史波动率。market-agnostic + instrument FK，日频序列可回填。
- **HotSnapshot**：港股热度信号快照行。key = instrument + hot type + 数据日期（vendor `last_data_date`）；含结构化 payload（vendor 原始异构字段）。按数据日期累积——数据日期未变则幂等覆盖同行、变则落新行，随各 type 更新频率自建前向序列（tr 日频 / capita 年度）。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 港股样本股（如 `hk:00700`）波动率回填后，PG `volatility_daily` 出现该标的多年（≥5 年）日频波动率行，每配置窗口一行序列。
- **SC-002**: 热度精选维度运行后，每港股标的每精选 `hot_type` 恰好一行最新快照，payload 含 vendor 原始字段。
- **SC-003**: 任一维度重复运行结果幂等 —— 波动率无重复行、热度覆盖不增行。
- **SC-004**: p1（6 维）/ p2（5 维）及 A 股同步零回归（既有 Testcontainers IT + 单测全绿）。
- **SC-005**: 波动率回填期不触发 vendor 限流封禁（沿用自限速 ~10/s + jitter，无 429 累积）。

## Assumptions

- 复用 p1（038）已激活的 marketdata 平台 + p2（039）「加一个 marketdata 维度」6 件套范式（port / adapter / mock / dimension-executor / schema+migration / IT）。
- 波动率历史深度默认 **10 年**（照 p1/p2 回测样本长度约定，`sync_dimension.history_depth`），CLI `--history-depth` 可覆盖。
- 热度**无历史深度概念**（快照）—— 每次同步只更新最新值。
- 2 张新表均 market-agnostic（`instrument_id` FK + market 经 instrument 携带，per master INV-1 Securities Master 范式），将来 A 股同类信号可无缝并入。
- 2 维度 soft-依赖 `universe`（标的须先注册），`sync_dependency` 加 `universe→dim` 边。
- 纯 server 数据摄取，单 bounded context `marketdata`，单 PR，无 mobile/web surface、无 UI/mockup、无 OpenAPI 契约变更。
