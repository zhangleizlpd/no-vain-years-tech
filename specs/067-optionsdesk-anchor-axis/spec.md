---
feature_id: 067-optionsdesk-anchor-axis
modules: [optionsdesk]
owners: ['@zhangleizlpd']
status: tasks-ready
created_at: '2026-08-29'
updated_at: '2026-08-29'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# --- v2 fields (mono-orchestrator-ready 0.2.0) ---

web_compat: full

agent_friction_observed: false

state_branches:
  - 'spot < W（axis = spot）∧ 收租视角 → 成色上界与换轴前逐值相同, 候选零变化'
  - 'spot = W → axis 两支取等值, 上界与换轴前相同（边界不分叉, min 无需分支）'
  - 'spot > W（axis = W）∧ 收租视角 → 系统默认上界收紧（结构项与比例项均按 W 锚定取严）, 被收紧挡下的腿计入既有边际计数'
  - 'spot > 1.143V ∧ 收租视角 ∧ 未覆盖 strikeMax → 默认候选可为空, 呈现沿用既有空态与计数, MUST NOT 呈现为错误'
  - 'build 视角 → 零变化（默认恒不设 strikeMax, 成色上界结构上不被消费）'
  - '全腿视角 → 零变化（同上, 默认不设 strikeMax）'
  - '用户已覆盖 strikeMax → 覆盖值原样生效, 换轴不触碰覆盖; 三态判定（default/widened/narrowed）相对新默认值计算'
  - '实时档开态（064 overlay）→ 同一召回判据吃实时 spot, axis = min(实时 spot, W), 与收盘档同口径'
  - '链上不存在 K ≥ axis 的档（axis 高于全部行权价）→ 结构项无定义, 退化为仅比例项（既有 Edge Case 语义, 轴替换后保留）'
---

# Feature Specification: 收租成色上界换轴 — axis = min(spot, W)

**Feature Branch**: `067-optionsdesk-anchor-axis`
**Created**: 2026-08-29
**Status**: Tasks-ready（2026-08-29；clarify 0 问——歧义已在当日设计对焦与 ADR-0068 清零；analyze 3 条发现已闭合）
**里程碑**: [ADR-0068](../../docs/adr/0068-realtime-narrow-recall-two-stage.md) 实施序列的 **P1 片**（纯 server；P2 两段式召回与 P3 清链行军的共同前置）

## 背景

收租视角的成色上界（系统默认的行权价上界）现按纯 spot 锚定：`min( spot 之上最近一档行权价, spot × 1.03 )`。它回答的是「离现价多远算轻微实值」——但本策略的接货意愿不是由现价定义的，是由**愿买价 W**（0.8 × 估值 V）定义的：被指派时的持仓成本应当落在计划买价附近，而非现价附近。当 spot 显著高于 W 时，按 spot 锚定的上界会把「按高于愿买价接货」的腿放进默认候选。

ADR-0068 决策已定：锚定轴换为 **axis = min(spot, W)**，且离线档与实时档同口径（计划/执行同口径——盘前按此轴做的计划，盘中执行时是同一把尺）。本 feature 落这一换轴；实时窄召回重构（P2/P3）复用同一判据。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 收租默认上界贴合愿买价 (Priority: P1)

用户在一只 spot 已高于愿买价 W 的锚上打开收租视角。系统默认给出的候选，其行权价上界按 W 锚定——被指派时的持仓成本落在计划买价附近。用户不再需要手动收紧上界来剔除「按高于愿买价接货」的档。

**Why this priority**: 这是换轴的全部理由——成色的经济语义从「离现价多远」修正为「离计划买价多远」。它同时是 P2/P3 复用的判据基础，先于一切实时改造。

**Independent Test**: 取一只 spot > W 的锚，收租视角默认请求：断言下发的默认 strikeMax 按 W 锚定（结构项「W 之上最近一档」与 W × 1.03 取严），且高于该上界的腿不在候选、计入边际计数。

**Acceptance Scenarios**:

1. **Given** 锚的 spot > W 且链上有行权价落在 (W×1.03, spot×1.03] 区间，**When** 收租视角以系统默认值检索，**Then** 该区间的腿不在候选集内，且被收紧挡下的条数计入既有 strikeMax 边际计数
2. **Given** 锚的 spot < W，**When** 收租视角以系统默认值检索，**Then** 候选集与换轴前逐值相同（axis 退化为 spot）
3. **Given** 锚的 spot = W，**When** 收租视角检索，**Then** 上界与换轴前相同（等值不分叉）
4. **Given** 用户在抽屉里覆盖了 strikeMax，**When** 检索，**Then** 覆盖值原样生效，三态相对新默认值判定

---

### User Story 2 - 太贵的锚如实呈现默认空 (Priority: P2)

用户打开一只 spot 显著高于估值（spot > 1.143V，此时 W×1.03 < 既有权利金门槛的可行域下沿）的锚的收租视角。系统默认候选为空——这是策略在说「按你的愿买价，现在没有值得收租的档」，不是故障。用户可通过覆盖 strikeMax 主动放宽查看。

**Why this priority**: 空态是换轴的诚实后果（dev 实测约三成锚落在此区），必须显式接受并钉住呈现语义，否则会被当回归修掉。

**Independent Test**: 取一只 spot > 1.143V 的锚，收租默认请求：断言候选为空、响应为既有「有链无候选」形态（非错误态）、边际计数如实说明被挡原因。

**Acceptance Scenarios**:

1. **Given** spot > 1.143V 的锚，**When** 收租视角默认检索，**Then** 候选集为空，响应结构与既有「条件下无候选」一致，MUST NOT 是错误态
2. **Given** 同一只锚，**When** 用户覆盖 strikeMax 放宽到 spot 附近，**Then** 候选按覆盖值出现（放宽能力不受换轴影响）

---

### User Story 3 - 其余视角与路径零回归 (Priority: P3)

build 与全腿视角、以及实时档 overlay 路径，在换轴后行为与响应与此前一致（build/全腿默认不设行权价上界，结构上不消费成色上界；实时路径与收盘路径共用同一判据单点）。

**Why this priority**: 换轴的爆炸半径必须钉死为「收租默认上界」一处；其余任何变化都是回归。

**Independent Test**: 换轴前后各跑一次 build / 全腿视角与实时开态请求，逐值对比响应。

**Acceptance Scenarios**:

1. **Given** 任意锚，**When** build 或全腿视角检索（默认值），**Then** 响应与换轴前逐值相同
2. **Given** 实时档开态（064 overlay 路径），**When** 检索，**Then** 召回吃实时 spot 时 axis = min(实时 spot, W)，与收盘档同一判据单点，无第二处轴定义

---

### Edge Cases

- axis 高于链上全部行权价（结构项无定义）→ 退化为仅比例项 axis × 1.03（既有 Edge Case 的轴替换版；MUST NOT 因无结构项而放行全部）
- v_manual 被修改 → 下一次检索起 W 与默认上界随之变化（无缓存滞留）
- W 恒可派生：锚表 V 非空且写侧拒绝 V ≤ 0（EC-3），本 feature 无「W 缺失」分支
- 用户覆盖恰等于新默认值 → 三态判 default（既有边界语义，相对新默认）

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 收租视角成色上界的锚定轴 MUST 为 `axis = min(spot, W)`；结构项「axis 之上最近一档行权价」与比例项「axis × 既有比例」的形状与取严逻辑 MUST 保持不变，仅换轴。
- **FR-002**: W MUST 复用既有愿买价定义（0.8 × 有效 V，v_manual 优先），经既有单点派生；🚫 MUST NOT 在第二处出现 0.8 系数或第二份 W 计算。
- **FR-003**: build 与全腿视角 MUST 零变化——两者默认不设行权价上界，成色上界结构上不被它们消费；此性质 MUST 由测试锚点钉住（而非依赖 intent 授权区论证）。
- **FR-004**: 用户对 strikeMax 的覆盖能力 MUST 零改动；覆盖生效值不经 axis 处理；三态（default/widened/narrowed）相对**新**默认值判定。
- **FR-005**: 换轴导致的默认候选收窄乃至为空 MUST 呈现为既有「条件下无候选」形态并保留既有边际计数语义；🚫 MUST NOT 新增错误态或告警。
- **FR-006**: 收盘档与实时档（064 overlay）MUST 共用同一判据单点——轴的定义恰好一处，实时路径吃实时 spot 时自动同轴。
- **FR-007**: 换轴 MUST NOT 触碰召回层其余判据（权利金地板 / 活性 / 相对价差 / DTE 段 / 候选上限）与下游各层（打标 / 排序 / 截断 / 呈现）。
- **FR-008**: 契约上下发的收租默认 strikeMax 值 MUST 反映新轴（客户端抽屉控件显示新默认）；响应结构零变化（值变、形不变，非破坏性变更）。

### Key Entities

- **axis（成色锚定轴）**: `min(spot, W)`。spot = 当次检索所用标的现价（收盘档为库内快照 spot，实时档为同批同刻 spot）；W = 愿买价。
- **成色上界（qualityCeiling）**: 收租默认 strikeMax 的来源，= min(结构项, 比例项)，两项均按 axis 锚定。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: dev 全量对比（换轴前后各跑一次全部锚的收租默认请求）：spot < W 的锚候选集逐值不变；spot > W 的锚默认上界 ≤ W × 1.03；分布与 ADR-0068 证据面吻合（spot > 1.143V 的锚默认候选为空）。
- **SC-002**: build 与全腿视角在同一对比中响应逐值不变（零回归的机器判据）。
- **SC-003**: 全仓恰好一处 axis 定义与一处 W 派生（`rg` 可数：0.8 系数仍仅existing单点一处；min(spot, W) 仅判据单点一处）。
- **SC-004**: 收租空态锚（spot > 1.143V）的响应为既有空态结构，错误率零新增。

## Assumptions

- 「1.143V」是推导常数（0.8 × 1.03 × spot 边界的反解）用于测试选样与预期管理，不是实装参数——实装只有 min 与既有比例。
- 离线档呈现零改动：空态文案与「规则内无腿」四态的显式化归 P2/P3（实时重构），本 feature 沿用既有空态。
- 雷达 / 详情页 / 温度计等其余读端不消费成色上界，零涉及。
- 换轴对 052 六维条件的 schema 与抽屉 UI 零改动（只有 rent 默认值的数值变化）。
