---
feature_id: 019-marketdata-sync-strategy
modules: [marketdata]
owners: ['@zhangleizlpd']
depends_on: ['016-marketdata-sync', '017-marketdata-scheduler', '018-marketdata-tiering']
status: implemented
created_at: '2026-06-04'
updated_at: '2026-06-05'
migration_refs: ['20260605_0300_add_freshness_and_adjustment_factor']
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 同步策略升级（固定日频 cron → 数据特性驱动的声明式新鲜度）。零 mobile/web surface：不新增读端点、无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - 'continuous-daily tick: 交易日 gate → 组 flow（017 现状语义不变）'
  - 'event-calendar 命中日: 交易日 gate → 日历命中检查命中 → 组 flow'
  - 'event-calendar 平淡日: 日历未命中 → 零 vendor 外呼，仅推进 next_fire_at（等价非交易日短路）'
  - 'slow-drift: 低频 cron（周/月）正常组 flow'
  - '平淡日 eod: 仅拉 none 口径；forward/backward = none × 最新因子本地算，零额外 vendor 请求'
  - '除权日: corporate_action 捕获新 exDate → 写 AdjustmentFactor 新版本 → 受影响标的 forward 序列按 lookback 窗口重算'
  - '日历源探测无端点: financial 落 slow-drift 周扫 latest 比对水位（analyze C1）；运行期日历检查失败: 按未命中 + 告警不阻塞'
  - 'SLA 超期: last_success_at 距今超 sla_hours → 结构化新鲜度告警（不阻塞后续 tick）'
  - '灰度退化态: 全维度 freshness_profile=continuous-daily 时行为与 017 现状完全等价（兼容兜底）'
  - '新维度接入: 注册一个 executor + 一行维度 seed（+ 可选依赖边），零 switch/全序常量改动'
  - 'tier 正交叠加: freshness 决定维度今晚跑不跑，tier 决定维度内谁先吃配额（018 行为零回归）'
---

# Feature Specification: Marketdata 数据特性驱动同步策略（声明式新鲜度 + 复权因子版本化 + 维度配置化）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-06-04)]**
> 本 feature 的方向与机制已由架构设计沉淀定稿不重开：设计全文 = [06-04-marketdata-sync-strategy-design](../../docs/private/plans/2026-06/06-04-marketdata-sync-strategy-design.md)（五正交轴分解 / 三类新鲜度画像 / 复权因子版本化业界依据 / 通用化 seam 边界）。**019 不替代也不修改 017** —— tick 的 claim（条件 UPDATE 抢占）语义不变，freshness 分流插在「won 之后做什么」；018 tier（Which 轴，横向切标的）与本 feature freshness（When 轴，纵向切数据类型）**正交叠加**，互不冲突。范围 = marketdata 内落地 + 通用化 seam（**不做跨 context 重构**——通用框架下沉是 ADR-0032 sunset trigger，本 feature 只保证不堵死）。落地按 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) bounded context 边界 + [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) Flat + Anemic + Moat 范式。
>
> 🎯 **[流程 — 纯 server 同步策略升级，无 mockup]**
> 本 feature **无 UI**，走 sdd.md 后端业务模块标准流程：`spec → /speckit-clarify → plan → tasks → impl`。**零新读端点、零 OpenAPI 契约变更**。验证全走 Testcontainers IT（真 PG+Redis，017/018 既有 IT 蓝本）+ mock vendor adapter + 配额回归实测。

**Feature Branch**: `019-marketdata-sync-strategy`
**Created**: 2026-06-04
**Status**: Clarified（clarify 2026-06-05 5Q：① 日历源 plan 阶段探测双轨；② 平淡日复权本地算补当夜落库；③ fundamental 保持日频；④ context 字段不加 YAGNI；⑤ SLA 告警复用结构化 log）
**Module**: `marketdata`（同步策略内部行为升级；portfolio/其他 context 零代码改动）
**设计源**: [设计沉淀文档](../../docs/private/plans/2026-06/06-04-marketdata-sync-strategy-design.md)（§3 五正交轴 + §4 When 模型 + §5 复权因子 + §11 落地路径）
**前置依赖**: [016-marketdata-sync](../016-marketdata-sync/spec.md)（维度同步语义基线 + 水位/幂等）+ [017-marketdata-scheduler](../017-marketdata-scheduler/spec.md)（tick/claim/flow 实装宿主，**PR-7 清退已完成 #336，单一 tick 形态稳定 = 本 feature 硬前置已满足**）+ [018-marketdata-tiering](../018-marketdata-tiering/spec.md)（tier 序消费，正交复用不动）
**Input**:

- 016/017/018 已搭好同步**基础设施**，但同步**频率**仍是 6 维度一刀切日频 cron——财报一年变 4 次、除权是年度事件，却每天对全市场 5,600 只空扫；复权口径每天拉 3 份（16,800 请求），而前/后复权只是 none 的确定性变换、因子只在除权日变。
- 实测（2026-06-04 prod .62）：理杏仁串行稳态 **4.26 req/s**，当前日增量 ≈ 33,700 请求 ≈ **2.2h**（delta 不省请求数只省响应体积）。
- 目标：用数据本身的更新特性驱动同步频率，日增量压到 **~5,800 请求 ≈ 22min**；同时把同步策略抽象成可配置、可扩展形态（加新维度成本 = 注册 executor + 一行 seed）。

## Context

- **为什么现在做**：017 PR-7 清退已合（#336），单一 tick 形态稳定——多形态并存风险已解除（设计文档 §11 的硬时序前置满足）；018 tier 序消费已 ship，「Which 轴」就位，「When 轴」是策略矩阵的最后一块。理杏仁配额实测完成，预算账可验证。
- **数据特性错配是结构性浪费**：99% 的交易日在问「一个一年变 4 次的东西今天变了吗」（financial/corporate_action 日频空扫）；复权 3 口径中 2 份是可本地推导的冗余（业界共识 = 存因子 + 本地算复权，JoinQuant/Tushare 先例，防回测数据漂移）。
- **声明式新鲜度而非更多 cron**：每维度声明「数据该多新」（freshness_profile 三类画像），系统据此推导触发——而非维度自己写几点跑。业界印证：Dagster declarative automation / dbt source freshness / Airflow Datasets。
- **事件驱动的务实落地**：无 webhook 依赖，用「轻量日历命中检查」在 BullMQ 轮询底座上实现——event-calendar 维度每日只做一次轻量命中检查（本地日历/vendor 日历端点），命中才组 flow，平淡日零 vendor 外呼。
- **配置化不彻底是扩展税**：当前加新维度要改 4 处代码 enum（`DimensionKey` / 全序常量 / `runDimension` switch / worker job name）——执行路由改注册表 + 全序由依赖边拓扑派生后，新维度 = 注册 executor + 一行 seed。
- **通用化 seam 只留不做**：`SyncDimension` 行已是 context 无关的元数据机制（tick/queue/SyncRun 只认维度行）；本 feature 在 marketdata 内验证抽象形态，跨 context 下沉等真有第二个 context 要同步时再评估（ADR-0032 sunset trigger），现在只保证不堵死。
- **策略字段到期兑现**：`metrics_list` / `reAdjustLookbackDays` / `paused_until` / `priority` 等 017 留的 seam 字段，本 feature 填充 `reAdjustLookbackDays` 语义（除权重算窗口）。

## Clarifications

### Session 2026-06-05

- Q: 理杏仁披露日历端点是否存在（financial event-calendar 真日历 vs fallback）？ → A: **plan 阶段探测双轨**——公开文档不可查（SPA+登录态），plan 首个调研 task 用 env-gated 真 IT 探测；有日历端点 → 真日历驱动，无 → 锁 fallback（低频扫 latest 比对 report_period 水位）。spec 行为契约两形态语义一致（FR-S02/S03 不变），探测结果只定 plan 实现路径，不阻塞 clarify。
- Q: 复权平淡日「最新一根」forward/backward：本地算补 vs 延迟一天？ → A: **本地算补**——当日 forward/backward = none × 最新因子，同步当夜立即落库，序列零缺口；平淡日因子不变，与 vendor 直拉值数学等价（SC-S02 对拍门兑付正确性）。
- Q: fundamental 日频 vs 周频？ → A: **保持日频**（continuous-daily 不动）——估值分位语义依赖每日 PE 序列（周频出阶梯失真）；批量后成本 ~200 请求/日（预算账 ~5,800 已含），降频节省可忽略不计。
- Q: context 字段（通用 seam）现在加 vs 后加？ → A: **后加（YAGNI）**——「不堵死」靠机制保证（tick/queue/SyncRun 只认维度行 + executor 注册表已解 switch 耦合），不靠预留列；届时 expand-only 加列成本等价；避免一列永远 'marketdata' 的死配置与 seed/IT 噪音。跨 ctx 下沉维持 ADR-0032 sunset trigger 评估。
- Q: SLA 超期告警渠道？ → A: **复用 017 结构化 log 告警形态**——零新基建，solo dev 运维入口统一（prod 查日志单入口）；告警字段含维度名/last_success_at/SLA 阈值可机械 grep；dashboard 维持 Out-of-Scope。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 复权因子版本化与本地复权（Priority: P1）

系统维护复权因子版本表（标的 × 除权日 → 前/后复权因子）：corporate_action 同步捕获新除权事件时写入新因子版本；平淡日（无除权）eod 同步仅向 vendor 拉取 `none` 口径（5,600 请求），forward/backward 口径由 `none 值 × 最新因子` 本地推导，**不再外呼**；除权日触发受影响标的的 forward 序列按回看窗口（`reAdjustLookbackDays`）重算。效果：日频 eod 请求 **16,800 → 5,600（砍 2/3）**。

**Why this priority**: 单项最大杠杆——日增量从 2.2h 压到 ~22min 的主要来源；且防回测数据漂移（因子版本化是业界明确推荐）。

**Independent Test**: Testcontainers PG + mock vendor：seed 标的与除权事件 → 断言因子版本写入；平淡日同步断言仅 none 口径外呼且 forward/backward 落库值 = none × 因子（与真拉值对拍）；注入新除权事件断言 forward 序列在窗口内重算。

**Acceptance Scenarios**:

1. **Given** corporate_action 同步捕获标的新除权事件（含除权日），**When** 同步执行，**Then** 因子版本表写入该标的新版本（除权日 + 前/后复权因子），同标的同除权日幂等不重复
2. **Given** 平淡日（今日无任何标的除权），**When** eod 同步执行，**Then** vendor 仅收到 none 口径请求（请求数 = 标的数 × 1），forward/backward 落库值 = none × 最新因子
3. **Given** 本地算的 forward/backward 值，**When** 与 vendor 直拉的 forward/backward 对拍，**Then** 数值一致（精度误差在既有 Decimal 精度内）
4. **Given** 某标的除权日到来，**When** 除权链路执行（corp 扫描日 reAdjustBars 或 eod 除权命中路径，双点幂等，plan D3/analyze M1），**Then** 该标的 forward 序列在 `reAdjustLookbackDays` 窗口内重算（vendor 权威口径），其余标的零额外请求
5. **Given** 新上市标的无除权历史（因子表无记录），**When** eod 同步执行，**Then** 因子按 1 处理（none = forward = backward），不报错不跳过

---

### User Story 2 — [Server] 声明式新鲜度三类画像（Priority: P1)

每个同步维度声明新鲜度画像（`continuous-daily` / `event-calendar` / `slow-drift`），tick 抢占（claim）语义不变，画像分流插在「won 之后」：continuous-daily 交易日组 flow（现状）；event-calendar 先做轻量日历命中检查（查本地/vendor 日历今日是否有新报告期/除权），命中才组 flow，平淡日**零 vendor 外呼**只推进 next_fire_at；slow-drift 低频 cron 正常组 flow。financial 转 event-calendar（真披露日历端点形态；探测无端点则落 slow-drift 周扫，analyze C1 统一）；corporate_action 为 **slow-drift**（周扫——扫描本身就是同步，物化除权日历供 eod 除权命中检查消费，**不自我 gate**：以自身扫描物化的日历 gate 自己 = 鸡生蛋饿死，analyze C1）；universe/profile 为 slow-drift，eod_bar/fundamental 为 continuous-daily。

**Why this priority**: 脉冲数据降频的机制本体——financial/corporate_action 从日频全市场空扫降到平淡日 0 请求/高峰日百级；与 US1 合并构成日增量 ~5,800 的完整预算账。

**Independent Test**: Testcontainers PG+Redis + mock vendor：三类画像各设一维度 → event-calendar 平淡日 tick 断言零 vendor 外呼且 next_fire_at 推进；注入日历命中断言组 flow 并执行；continuous-daily/slow-drift 断言行为与 017 现状等价。

**Acceptance Scenarios**:

1. **Given** event-calendar 维度且今日日历无命中，**When** tick 抢占该维度，**Then** 零 vendor 外呼、不组 flow、next_fire_at 正常推进（SyncRun 如实记录跳过原因）
2. **Given** event-calendar 维度且今日日历命中（有新报告期/除权），**When** tick 抢占该维度，**Then** 组 flow 正常执行，仅同步命中相关的数据范围
3. **Given** continuous-daily 维度，**When** 交易日 tick 抢占，**Then** 行为与 017 现状完全一致（交易日 gate → 组 flow）
4. **Given** slow-drift 维度（周频 cron），**When** 非触发日，**Then** tick 不抢占（next_fire_at 未到），零开销
5. **Given** 日历检查运行期失败（vendor 日历端点超时/异常），**When** event-calendar 维度 tick，**Then** 该 tick 按未命中处理 + 告警，下一 tick 重查（不阻塞不报死）；端点**不存在**是探测期决定（落 slow-drift 周扫），非运行期降级
6. **Given** tick 的 claim（条件 UPDATE 抢占）逻辑，**When** 本 feature 合入，**Then** claim 语义零变更（017 IT 回归全绿）

---

### User Story 3 — [Server] 维度接入配置化（executor 注册表 + 全序拓扑派生）（Priority: P2）

维度执行路由从硬编码 switch 改为执行器注册表（按维度 key 路由）；维度全序不再硬编码常量，由依赖边（`SyncDependency`）拓扑排序派生；新增 hard 依赖边 `corporate_action → eod_bar`（除权因子必须先于前复权重算，仅两者同 tick due 时生效）。加新维度的成本收敛为：注册一个 executor + 一行维度 seed（+ 可选依赖边），**不改 switch / 不改全序常量**。

**Why this priority**: 行为保持重构，是 US1/US2 的结构前置（factor 维度逻辑插入依赖序）；同时兑现「可扩展抽象」目标——但不直接产生请求削减，故 P2。

**Independent Test**: ① 016/017/018 既有 IT 全绿（行为保持门）；② 拓扑派生的全序与既有硬编码全序一致（对拍断言）；③ 注册一个测试维度（executor + seed 行）断言其被 tick 正常调度执行，全程零 switch/常量改动。

**Acceptance Scenarios**:

1. **Given** 既有 6 维度，**When** 执行路由改注册表 + 全序改拓扑派生，**Then** 016/017/018 既有 IT 全绿（行为零回归），派生全序与原硬编码全序一致
2. **Given** corporate_action 与 eod_bar 同 tick due（除权命中日），**When** flow 组装，**Then** corporate_action 先于 eod_bar 执行（hard 边生效）
3. **Given** 仅 eod_bar due（corporate_action 平淡日未命中），**When** flow 组装，**Then** eod_bar 正常执行不被阻塞（hard 边仅同 due 时生效）
4. **Given** 一个新维度（注册 executor + 一行 seed + 可选依赖边），**When** 接入，**Then** tick 正常调度执行，无任何 switch/全序常量/worker job name 改动

---

### User Story 4 — [Server] 新鲜度 SLA 监控告警（Priority: P2）

每维度声明新鲜度 SLA（`sla_hours`：数据允许多旧）；系统周期比对每维度 `last_success_at` 与 SLA，超期发出结构化新鲜度告警（复用 017 既有告警通道形态）。这是「声明式新鲜度」的可观测闭环——event-calendar 维度跳过日不算 stale（按日历语义判定），避免误报。

**Why this priority**: 降频后的安全网——脉冲维度从日频降到事件驱动，漏掉一次披露/除权的后果需要监控兜底；无 SLA 监控则降频是盲飞。

**Independent Test**: Testcontainers IT：维度 last_success_at 超 sla_hours → 断言结构化告警发出；event-calendar 平淡日跳过 → 断言不告警；休市长假场景断言不误报。

**Acceptance Scenarios**:

1. **Given** 维度 last_success_at 距今超过 sla_hours，**When** 新鲜度检查执行，**Then** 发出结构化告警（含维度名/最后成功时间/SLA 阈值）
2. **Given** event-calendar 维度平淡日正常跳过（日历无命中），**When** 新鲜度检查执行，**Then** 不告警（跳过 ≠ stale）
3. **Given** 休市长假（连续非交易日），**When** 新鲜度检查执行，**Then** continuous-daily 维度不误报（SLA 按交易日历语义判定）
4. **Given** 告警已发出且维度随后同步成功，**When** 下次检查，**Then** 告警恢复（不持续重复告警）

---

### User Story 5 — [Server] 灰度切换与回归保障（Priority: P3）

freshness 驱动按维度灰度启用：全维度 `freshness_profile=continuous-daily` 即 017 现状的完全等价退化态（兼容兜底）；逐维度切 event-calendar/slow-drift 观察；数据零重复（幂等 upsert 兜底）。冷启动（首次全量回填）与稳态（日增量）用不同预算配置（CLI 参数既有机制），互不干扰。

**Why this priority**: 上线安全网——017 灰度先例的延续；不产生新能力但保证渐进可回退。

**Independent Test**: IT：全 continuous-daily 配置下整夜模拟与 017 现状行为对拍等价；单维度切 profile 后其余维度行为不变；回切 profile 后行为恢复。

**Acceptance Scenarios**:

1. **Given** 全维度 freshness_profile=continuous-daily，**When** 整夜同步模拟，**Then** 行为与 017 现状完全等价（请求序列/审计行对拍）
2. **Given** 仅 financial 切 event-calendar，**When** 整夜同步，**Then** 其余维度行为不变，financial 按日历命中语义执行
3. **Given** 任一维度 profile 回切 continuous-daily，**When** 下一 tick，**Then** 该维度行为恢复日频扫描（可回退）

---

### Edge Cases

- **除权日恰逢非交易日** → 因子版本照写（exDate 是事实日期），forward 重算在下一交易日同步时生效
- **同一标的同日多个除权事件**（送股+分红） → 因子表唯一键（标的 × 除权日）合并为单版本因子，幂等 upsert
- **backfill（`--as-of` 历史回填）与因子交互** → backfill 模式保持 vendor 直拉 3 口径（低频走权威，plan D3 精神）——历史复权值即 vendor 权威历史口径，**天然无漂移**；本地因子链只服务平淡日 delta 推导与对拍审计（T010 实现选择，2026-06-05）
- **日历命中检查自身失败**（vendor 日历端点超时） → 该 tick 按未命中处理 + 告警，下一 tick 重查；不阻塞其他维度
- **event-calendar 漏报补偿**（日历漏了一次披露） → SLA 告警兜底 + 既有 CLI `--dimension financial --as-of` 手动补（016 既有机制，不新做）
- **因子表与价格数据不一致** → 因子值锚自已存 none/forward bar 比值（plan D1），全链可由 bar 序列幂等重建；corporate_action 只提供除权日边界
- **拓扑排序遇环**（依赖边误配成环） → 启动时检测拒绝（fail-fast），不静默吞
- **新维度 seed 行存在但 executor 未注册** → tick 抢占后结构化报错入 SyncRun，不崩 worker、不阻塞其他维度
- **tier × freshness 叠加** → freshness 决定维度今晚跑不跑/跑哪些标的范围，tier 决定范围内消费序——event-calendar 命中日的受影响标的集合内仍按 tier 序（018 行为不变）
- **`paused_until` 与 freshness 叠加** → paused 优先级最高（维度暂停期内无论画像不执行，017 既有语义）

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 每同步维度 MUST 声明新鲜度画像，值域 = `continuous-daily` | `event-calendar` | `slow-drift`；画像 MUST 为维度元数据（数据库行配置），改画像 MUST NOT 需要改代码。
- **FR-S02**: tick 抢占（claim 条件 UPDATE）语义 MUST 零变更——画像分流 MUST 插在抢占成功之后：`continuous-daily` = 交易日 gate → 组 flow（现状）；`event-calendar` = 交易日 gate → 日历命中检查 → 命中才组 flow，未命中零 vendor 外呼仅推进 next_fire_at；`slow-drift` = 低频 cron 正常组 flow。event-calendar 的日历源形态（真日历端点 vs fallback 扫描比对）由 plan 阶段 env-gated 探测决定（clarify 2026-06-05），两形态下本 FR 语义一致。
- **FR-S03**: event-calendar 维度平淡日 MUST 零 vendor 数据外呼（日历命中检查本身的轻量查询除外）；跳过 MUST 留审计痕（SyncRun 记录跳过原因）。
- **FR-S04**: 系统 MUST 维护复权因子版本表：标的 × 除权日 → 前/后复权因子；因子**值** MUST 锚自已存价格比值（`forward(d)/none(d)`，段内常数——plan D1 修正：dividend 公式派生有配股端点缺口，比值对全事件类型鲁棒）；除权日**边界** = corporate_action 事实源；MUST 幂等（同标的同除权日 upsert）；MUST 可由已存 none/forward bar 序列重建。
- **FR-S05**: 平淡日（无除权命中）eod 同步 MUST 仅向 vendor 拉取 none 口径；forward/backward MUST 本地推导（none × 最新因子）且 MUST 同步当夜落库（最新一根零延迟、序列零缺口，clarify 2026-06-05）；本地推导值 MUST 与 vendor 直拉值对拍一致（IT 验证）。
- **FR-S06**: 除权日 MUST 触发受影响标的的 forward 序列重算，窗口 = `reAdjustLookbackDays`（017 既有字段，本 feature 填充语义）；重算 MUST 只影响除权标的，其余标的零额外请求。
- **FR-S07**: 维度执行路由 MUST 为注册表形态（按维度 key 路由到 executor）；维度全序 MUST 由依赖边拓扑排序派生（去除硬编码全序常量）；加新维度 MUST 收敛为「注册 executor + 一行维度 seed（+ 可选依赖边）」，MUST NOT 需要改 switch/全序常量/worker job name。拓扑排序遇环 MUST fail-fast 拒绝启动。
- **FR-S08**: MUST 新增 hard 依赖边 `corporate_action → eod_bar`（因子先于前复权重算）；该边 MUST 仅在两者同 tick due 时生效（corporate_action 平淡日未命中不阻塞 eod_bar）。
- **FR-S09**: 每维度 MUST 可声明 `sla_hours`（新鲜度 SLA）；系统 MUST 周期比对 last_success_at 与 SLA，超期发结构化告警；告警渠道 MUST 复用 017 既有结构化 log 告警形态（clarify 2026-06-05，零新基建，告警字段含维度名/最后成功时间/SLA 阈值）；event-calendar 跳过日与休市日 MUST NOT 误报（按日历语义判定 stale）；恢复后 MUST NOT 持续重复告警。
- **FR-S10**: 018 tier 序消费 MUST 零回归——freshness（维度跑不跑/范围）与 tier（范围内消费序）正交叠加；`paused_until` 优先级 MUST 高于画像。
- **FR-S11**: 全维度 `continuous-daily` 配置 MUST 与 017 现状行为完全等价（灰度退化态兜底）；画像逐维度可切可回退；数据零重复（幂等 upsert 兜底，016 语义）。
- **FR-S12**: 既有补偿机制 MUST 不变：CLI `--dimension --as-of` 手动回填照常可用；backfill 的复权口径 MUST 无回测漂移（实现 = vendor 直拉 3 口径权威历史值，非最新因子套算——T010 性质表述，2026-06-05）。
- **FR-S13**: 本 feature MUST NOT 新增读端点 / 改 OpenAPI 契约 / 触发 `packages/api-client` regen；mobile 无感知；portfolio 及其他 context 零代码改动。
- **FR-S14**: 通用化 seam MUST 只留不做：维度元数据机制保持 context 无关形态（tick/queue/SyncRun 只认维度行），跨 context 下沉 MUST NOT 在本 feature 实施（ADR-0032 sunset trigger 评估）；MUST NOT 加 context 列（clarify 2026-06-05 YAGNI——届时 expand-only 加列成本等价，不堵死靠机制不靠预留列）。

### Out-of-Scope Functional Boundaries

- ❌ 跨 context 同步框架下沉（portfolio 等第二 context 接入）——只留 seam，sunset trigger 评估
- ❌ webhook / 外部编排器（Airflow/Dagster）——日历命中检查在 BullMQ 轮询底座落地
- ❌ 盘中实时同步 / 实时行情——夜间窗口语义不变
- ❌ T1 tier / tier 模型变更——018 形态不动
- ❌ 新鲜度可视化 dashboard（clarify 2026-06-05 定：复用 017 结构化 log 告警通道）
- ❌ vendor 更换 / 多 vendor 路由——理杏仁单 vendor 不变

## Key Entities

- **SyncDimension（017 既有，本 feature 扩展）**：新增新鲜度画像（三值）、SLA 阈值（允许多旧）、日历来源标识（event-calendar 维度的日历源）；**不加 context 列**（clarify 2026-06-05 YAGNI）；`cron_expr` 保留但语义变为「该画像下的扫描节奏」；扩展 MUST 为 expand-only（加列不破坏既有行）。
- **AdjustmentFactor（新表）**：标的 × 除权日 → 前/后复权因子的版本记录；唯一键（标的, 除权日）；因子值锚自价格比值（plan D1）、除权日边界源自 corporate_action、可由已存 bar 序列重建；eod 平淡日本地复权与历史回填的计算依据。
- **SyncDependency（017 既有，本 feature 扩展）**：新增 hard 边 corporate_action → eod_bar；全序由边拓扑派生（替代硬编码常量）。
- **Instrument.syncTier（018 既有，正交复用）**：本 feature 零改动——freshness 与 tier 是调度矩阵的两个正交轴。

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: **配额账回归**：稳态日增量（平淡交易日）vendor 请求数实测 ≤ 6,000（目标 ~5,800：eod 5,600 + fundamental 批量 ~200 + 脉冲 0），对比改造前 33,600+；按 4.26 req/s 折算 ≤ 25min（目标 ~22min）。
- **SC-S02**: **复权对拍门**：本地算 forward/backward 与 vendor 直拉值全样本对拍一致（IT 抽样 + 至少一次真 vendor env-gated 对拍）。
- **SC-S03**: **脉冲零外呼门**：event-calendar 维度平淡日 IT 断言零 vendor 数据外呼；命中日按命中范围执行；漏报由 SLA 告警兜底（注入漏报场景断言告警）。
- **SC-S04**: **除权链路门**：「corporate_action 捕获除权 → 因子版本写入 → eod forward 窗口重算」端到端 IT 全绿；非除权标的零额外请求。
- **SC-S05**: **配置化门**：注册一个测试维度（executor + seed 行）即被正常调度执行，diff 中零 switch/全序常量改动；拓扑派生全序与既有全序对拍一致。
- **SC-S06**: **SLA 告警门**：超期告警 / 跳过不误报 / 休市不误报 / 恢复不重复，四态 IT 全绿。
- **SC-S07**: **回归门**：016/017/018 既有 marketdata IT 套件全绿；claim 语义零变更断言；tier 序消费零回归断言。
- **SC-S08**: **退化态等价门**：全 continuous-daily 配置整夜模拟与 017 现状行为对拍等价（请求序列 + 审计行）。

## Assumptions

- **硬前置已满足**：017 PR-7 清退已合（#336，单一 tick 形态）；018 已全量 ship；理杏仁配额实测完成（4.26 req/s 稳态，2026-06-04）——设计文档 §11 时序前置全部成立。
- **架构方向已定稿不重开**：五正交轴分解 / 三类画像 / 因子版本化 / 注册表配置化，per 设计沉淀文档（2026-06-04）；待跑区 5 问已全部闭合（`## Clarifications` Session 2026-06-05）。
- **复权因子获取路径已按 plan D1 修正**：原假设「从 corporate_action 公式派生」在 plan 勘探中暴露配股缺口（dividend 端点不含 allotment/equity-change），escape hatch 触发——改为价格比值锚定（`forward(d)/none(d)` 段内常数），corporate_action 仅提供除权日边界。
- **规模假设**：universe ~5,600、除权事件年度百级/标的、财报年 4 次/标的——因子表年增万级行，无性能预算压力。
- **测试范式沿用**：Testcontainers 真 PG+Redis + mock vendor adapter（017/018 IT 蓝本）；配额账用请求计数断言 + env-gated 真 vendor 抽样对拍。
- **冷启动预算与稳态分离**：首次全量（~33,700 请求）走既有配额顺延机制摊多夜（CLI 预算参数），本 feature 优化的是稳态日增量。

## Out of Scope（本 feature 不做）

- **跨 context 同步框架下沉**——seam only，真有第二个 context 要同步时走 ADR-0032 sunset trigger 评估。
- **webhook / 外部编排器引入**——轮询底座上的日历命中检查已满足。
- **盘中实时同步**——夜间窗口约束不变（读写隔离：同步避开盘中读流量）。
- **tier 模型演进**（T1 / 打分衰减）——018 seam 不动。
- **vendor 多源 / 更换**。
