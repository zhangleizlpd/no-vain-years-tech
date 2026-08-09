---
feature_id: 024-alert-realtime
modules: [alert]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-08
updated_at: 2026-06-08
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# --- v2 fields (mono-orchestrator-ready 0.2.0, post-A-002 retro) ---

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: '本 feature 服务端为主(盘中 tick 求值);mobile 仅在 023 已有条件选择器上增量加「5 分钟涨跌幅」一类条目,Expo Web export 未单独冒烟该条目'

# AI agent 协作摩擦观察 (per ADR-0024 amend + docs/conventions/ai-friction-catalog.md).
agent_friction_observed: false

# 性能预算 (per ADR-0039 SSOT). tick 求值为后台 job 非 user-facing endpoint,
# 时延门槛以 SC-005 表达,不在此列 endpoint 预算。

# 状态机分支穷举 (per 测试基建 2.0 / ADR-0040 multi-layer test gate).
state_branches:
  - '交易时段内 tick + 实时价命中阈值 -> 盘中触发 + 推送(022)'
  - '交易时段内 tick + 实时价未命中 -> 不触发,记录本 tick 快照'
  - '非交易时段(节假日/午休/收盘后) tick -> 空转直接 return,不拉源不求值'
  - '同一预警同交易日盘中已触发 -> 当日 EOD 评估幂等 skip(不重复触发/推送)'
  - '实时源连续 3 tick(≈15min) 失败 -> 熔断,静默降级 EOD-only,预警延迟不丢'
  - '熔断后实时源恢复 -> 自动回升盘中口径'
  - '首 tick 无上一快照 -> 差分类条件(5 分钟涨跌幅)本 tick 跳过,下一 tick 起正常'
  - '实时价缺失(停牌/源未返该标的) -> 该标的本 tick 不命中(与 021「数据缺失不命中」一致)'

# --- end v2 fields ---
---

# Feature Specification: 实时盘中预警（Alert Realtime）

## Clarifications

### Session 2026-06-08

- Q: tick 周期定多少？「5 分钟涨跌幅」条件与 5–10min 可变周期冲突（tick=10min 测不出 5 分钟窗口）→ A: **tick 周期锁定 5 分钟**。盘中预警需够快，10min 对盯盘偏慢；锁 5min 让「5 分钟涨跌幅」= 相邻 tick 差，语义干净（解法 B）。
- Q: 盘中 tick 实时求值覆盖哪些条件？→ A: **仅到价类（涨到/跌到）+ 5 分钟涨跌幅**盘中实时判定；023 其余条件（估值/均线/MACD/换手率等日线信号）维持 EOD-only（盘中值与收盘后无异）。
- Q: 实时 tick 拉取哪些标的的实时价？→ A: **仅「含至少 1 个盘中可判定条件（到价类 / 5 分钟涨跌幅）的启用预警」的标的**；纯 EOD 条件预警的标的不进 tick 拉取集。
- Q: 实时源连续多少个 tick 失败触发熔断降级 EOD-only？→ A: **连续 3 个 tick（≈15min）**。容忍偶发抖动/单次超时，又不长时间盲跑。
- Q: 「5 分钟涨跌幅超 N%」条件的方向语义？→ A: **单向分两类**——「5 分钟涨超 N%」与「5 分钟跌超 N%」各一类（仿 021 到价 RISE/FALL 拆分），用户意图明确、触发文本带方向。

## User Scenarios & Testing

### User Story 1 — 盘中即时到价预警（Priority: P1）

**Why this priority**: 这是实时预警的核心价值。021/023 的到价条件只在盘后 EOD 判定，盘中价格触及阈值要等收盘后才告知，对盯盘场景几乎无意义。本 story 让到价类条件在交易时段内实时命中并即时推送，是引入外部实时源 + tick 调度的唯一动因。

**Acceptance Scenarios**:

1. **Given** 用户对某标的设了「涨到 X 元」预警且当前为交易时段，**When** 该标的盘中实时价首次 ≥ X，**Then** 预警在下一个 tick 周期内触发并经推送通道（022）即时送达，消息正文标注为「盘中价」口径。
2. **Given** 同一预警在盘中已触发一次，**When** 当日盘后 EOD 评估再次运行，**Then** 该预警当日不重复触发、不重复推送（盘中与 EOD 共用 `(alertId, tradeDate)` 当日至多一次的判重语义）。
3. **Given** 当前为非交易时段（午休 / 收盘后 / 节假日），**When** tick 调度触发，**Then** 系统不拉取实时源、不做求值，直接空转返回。

### User Story 2 — 5 分钟涨跌幅条件（Priority: P2）

**Why this priority**: 异动盯盘类的最小可行新条件，依赖盘中相邻快照差分，是「实时源 + 上一 tick 快照保留」能力解锁的第一个新条件类型。排在 P1 到价口径打通之后。

**Acceptance Scenarios**:

1. **Given** 用户对某标的设了「5 分钟涨超 N%」（或「跌超 N%」）预警，**When** 相邻两个 tick 快照之间该标的涨幅（或跌幅）首次 ≥ N%，**Then** 预警触发并即时推送，正文带实际涨跌幅、方向与时间窗口。
2. **Given** 系统刚启动 / 重启后的首个 tick（无上一快照可差分），**When** tick 求值运行，**Then** 该差分类条件本 tick 跳过、不误触发，从第二个 tick 起正常判定。

### User Story 3 — 实时源不可用时的降级兜底（Priority: P3）

**Why this priority**: 外部爬接口源不可用是高概率事件（参数变更 / 限流）。本 story 保证实时源熔断时预警不丢失、只延迟到盘后 EOD 兜底，并在源恢复后自动回到盘中口径。是可靠性约束，排在功能 story 之后但必须随首版交付。

**Acceptance Scenarios**:

1. **Given** 实时源连续 3 个 tick（≈15min）请求失败，**When** 达到熔断阈值，**Then** 系统静默降级为 EOD-only 评估、记录降级事件，盘中不再尝试实时求值。
2. **Given** 系统处于熔断降级态，**When** 实时源恢复可用，**Then** 系统自动回升盘中口径，无需人工干预。

### Edge Cases

- 标的盘中停牌 / 实时源未返回该标的 → 该标的本 tick 不命中，等同 021「数据缺失不命中」（covers FR-001, FR-005）
- 盘中实时价已触发后，同日 EOD 收盘价回落到阈值以下 → 仍按「当日已触发」判重，不因 EOD 价回落而撤销或重发（covers FR-004）
- 单个标的在一个 tick 周期内被多个不同预警条件命中 → 各预警独立触发（covers FR-001）
- 实时源返回的标的集合与请求集合不一致（源静默省略无效 / 停牌标的）→ 按返回集合对齐，请求中缺失的标的视为本 tick 无数据（covers FR-005）

## Requirements

### Functional Requirements

- **FR-001**: 系统 MUST 在交易时段内以固定 5 分钟周期（tick）拉取实时行情快照，求值范围**仅限到价类（涨到/跌到）与 5 分钟涨跌幅条件**；以盘中口径判定（实时价命中阈值即触发），命中后经 022 推送通道即时送达。023 的其余条件（估值/均线/MACD/换手率等日线信号）维持 EOD-only，不进盘中求值。
- **FR-001a**: 实时 tick 的拉取标的集合 MUST 仅含「有至少一个盘中可判定条件（到价类 / 5 分钟涨跌幅）的启用预警」的标的；仅含纯 EOD 条件的预警标的不纳入实时拉取集。
- **FR-002**: 系统 MUST 仅在 A 股交易时段（交易日 09:30–11:30 / 13:00–15:00，Asia/Shanghai）执行实时拉取与求值；非交易时段 tick 空转，不访问外部源。
- **FR-003**: 系统 MUST 支持「5 分钟涨超 N%」与「5 分钟跌超 N%」两类条件（单向，仿 021 到价 RISE/FALL 拆分），基于相邻 tick 快照差分判定（tick 周期锁定 5 分钟，相邻 tick 差即 5 分钟窗口）；首 tick（无上一快照）对该两类条件跳过求值，不误触发。
- **FR-004**: 系统 MUST 保证同一预警同一交易日至多触发一次：盘中已触发的预警，当日盘后 EOD 评估对其幂等 skip（盘中与 EOD 共用 `(alertId, tradeDate)` 判重键）。
- **FR-005**: 当实时源未返回某标的的实时价（停牌 / 源省略 / 缺字段）时，系统 MUST 视该标的本 tick 无数据、不命中，不得回退到陈旧价或裸价误触发。
- **FR-006**: 当实时源连续 3 个 tick（≈15min）失败时，系统 MUST 熔断并降级为 EOD-only 评估，预警延迟到盘后兜底而非丢失；源恢复后 MUST 自动回升盘中口径。降级与回升 MUST 留下可观测记录。
- **FR-007**: 盘中触发的预警通知 MUST 携带触发时的实际值（实时价 / 实际涨跌幅）与触发时间，并标注「盘中价」口径，以区别于 EOD 收盘价口径。
- **FR-008**: 用户 MUST 能在移动端预警条件配置入口（023 已有的条件选择器）中添加「5 分钟涨超 N%」/「5 分钟跌超 N%」条件，与既有 EOD 条件并存。

## Success Criteria

- **SC-001**: 用户对某标的设「涨到 X」并在盘中价首次触及 X 后，在一个 tick 周期内（≤ 5 分钟）收到推送，无需等待盘后。
- **SC-002**: 同一预警在「盘中触发 → 当日 EOD 评估」序列下，端到端只产生 1 次触发与 1 次推送（判重幂等，0 重复）。
- **SC-003**: 非交易时段（节假日 / 午休 / 收盘后）的 tick 不产生任何外部实时源请求（可由源调用计数验证为 0）。
- **SC-004**: 实时源完全不可用时，当日预警仍能由 EOD-only 兜底产出（触发数不因实时源宕机而归零），且降级/恢复事件可在日志中检出。
- **SC-005**: 单 tick 端到端处理（拉取 + 求值 + 触发派发）在百级标的、数条条件规模下耗时远小于 tick 周期（目标余量 ≥ 1 个数量级，即百级标的单 tick ≤ 30s）。
- **SC-006**: 「5 分钟涨跌幅」条件在相邻 tick 差分达到阈值时触发，首 tick 不误触发（重启后第一周期 0 误报）。

## Assumptions

- **依赖 022 推送送达已 ship**：盘中触发的即时价值依赖即时送达；022（alert-push-delivery，status=implemented）的推送链路（outbox → 推送任务）是本 feature 的前置依赖。
- **依赖 021/023 条件框架与求值引擎**：复用 021 的纯函数评估引擎 seam（`alert-evaluation.rules.ts`）与 023 的带参条件模型 / 条件选择器；本 feature 在其上扩盘中口径与新条件，不重写引擎。
- **外部实时行情源为爬公开接口**：数据源选型（主源 / fallback / 降级链路）已在 [p2 子 plan §1](../../docs/private/plans/2026-06/06-07-alert-indicator-p2-realtime.md) 经 PoC 复验定稿（属 HOW，详见 plan.md）；本 spec 仅依赖「存在一个可在交易时段拉取百级标的实时价的源，且可能不稳定需降级」这一抽象能力。
- **求值集合为有启用预警的标的**：单人应用量级几十~几百只，远小于全市场；容量论证见 p2 §2，结论为单进程「快照 → 遍历求值 → 触发」即可，不需要流式计算。
- **盘中/EOD 判重键沿用现有语义**：`(alertId, tradeDate)` 唯一键现语义（同交易日至多 1 条触发）恰好覆盖盘中先触发 → EOD 幂等 skip，预期无需 schema 改动（plan 阶段验证此判断）。
- **不在本期范围**：单笔异动 / 逐笔数据 / 盘中分钟线技术指标 / L1 盘口（per master Out of Scope 与 p2 §3 重评触发条件）。
