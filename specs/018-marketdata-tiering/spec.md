---
feature_id: 018-marketdata-tiering
modules: [marketdata]
owners: ['@zhangleizlpd']
depends_on: ['013-watchlist', '016-marketdata-sync', '017-marketdata-scheduler']
status: implemented
created_at: '2026-06-04'
updated_at: '2026-06-04'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 同步内部行为升级（统一优先级 → 重要度二级 T0/T2）。零 mobile/web surface：不新增读端点、无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - 'tier 重算命中: 标的 ∈ 全账号自选并集（distinct market+code）→ syncTier=0'
  - 'tier 重算未命中: 标的 ∉ 并集 → syncTier=2'
  - 'tier 重算幂等: 并集不变连续重算 → syncTier 零行变更'
  - '自选全空: 并集为空 → 全 universe syncTier=2，同步行为与 016 全量统一等价（不报错不空转）'
  - 'tier 序消费: 各维度同步 T0 标的全部先于 T2 消费令牌桶（同 tier 内保持既有稳定序）'
  - '配额耗尽顺延: T2 被截断顺延、T0 已保底完成；续跑按 pendingEodInstruments 进度锚幂等且仍按 tier 序'
  - 'universe upsert 护值: 既有标的 syncTier 不被周更覆盖（016 已护回归）；新上市标的默认 2 等下次重算'
  - '重算降级: portfolio 表读取异常 → 当夜同步沿用现有 syncTier 照常执行 + 降级告警（重算失败不阻塞同步）'
  - '跨 ctx 治理: marketdata 内 watchlist 直查点缺 // CROSS-CONTEXT-READ: 注释 → check-server-moat CI 拒'
---

# Feature Specification: Marketdata 重要度分级同步（T0/T2 二级 — 自选并集保鲜优先 + tier 序消费 + Q7-B 跨 ctx 直查）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-06-04)]**
> 本 feature 是 016 deferred「重要度分级」的兑现，方向与机制已定稿不重开：跨 ctx 读 = **Q7-B 直查终态选择**（[ADR-0048 § 复审记录 2026-06-04](../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md)——摊销判据 + 升 Q7-A 仅两 trigger；**无 Outbox / 无投影表 / Q7-C 直 DI 禁**）；规划全文 = [06-04-marketdata-tiering-feature-planning](../../docs/private/plans/2026-06/06-04-marketdata-tiering-feature-planning.md)。落地按 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) bounded context 边界 + [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) Flat + Anemic + Moat 范式；**marketdata 自此不再是叶子 context**（新增对 portfolio 的只读边，`CROSS-CONTEXT-READ` 注释探针强制）。实装宿主 = [017](../017-marketdata-scheduler/spec.md) 的 per-dimension executor / tick / flow 体系（PR-1~5 已合）；**不碰 017 PR-7 待清退的旧管线面**。
>
> 🎯 **[流程 — 纯 server 同步行为升级，无 mockup]**
> 本 feature **无 UI**，走 sdd.md 后端业务模块标准流程：`spec → /speckit-clarify → plan → tasks → impl`。**零新读端点、零 OpenAPI 契约变更**。验证全走 Testcontainers IT（真 PG+Redis，017 既有 IT 蓝本）+ mock vendor adapter。

**Feature Branch**: `018-marketdata-tiering`
**Created**: 2026-06-04
**Status**: Clarified（clarify 2026-06-04 3Q：① 重算 = executor 前置步骤（全触发路径一致）；② 生效时点 = 下一次同步运行快照；③ T0 失败重试优先留 seam 不实装）
**Module**: `marketdata`（同步分级行为 + 跨 ctx 只读；portfolio **零代码改动**，仅其 watchlist 表被只读直查）
**设计源**: [规划文档](../../docs/private/plans/2026-06/06-04-marketdata-tiering-feature-planning.md)（§3 决策记录 + §4 实装面）+ [master §4.3](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-master.md)（三级模型原设计）+ [ADR-0048](../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md)（Q7-B 复审结论）
**前置依赖**: [013-watchlist](../013-watchlist/spec.md)（T0 唯一信号源表，已 implemented）+ [016-marketdata-sync](../016-marketdata-sync/spec.md)（deferred 决议出处 + 同步语义基线）+ [017-marketdata-scheduler](../017-marketdata-scheduler/spec.md)（executor/tick/flow 实装宿主，PR-3/4/5 已合）
**Input**:

- 016 clarify 2026-06-03 砍分级的前置「watchlist/holdings 落地」已部分满足（013 已 ship）；vendor 双窗限频（1000/min·36/s）下全 universe 无法同等新鲜，须**保用户可见集最鲜、长尾吃余量**（master §4.3 work-conserving）。
- V1 = **二级 T0/T2**：T0 = 全账号自选并集（watchlist 唯一已建信号源）；T2 = 其余 universe；T1（recency）继续砍留 seam。
- 已拍板不重开（规划文档 §3）：T0 范围仅自选 / Q7-B 直查终态 / impl gate = 017 PR-3+PR-4（已满足）。

## Context

- **为什么现在做**：013 已 ship 用户开始维护自选，但同步仍全量统一优先级——配额耗尽顺延时用户可见集与长尾同等待遇，违背「保鲜可见集」核心目标；`Instrument.syncTier` 列建而未用（016 留的 seam 到期）。
- **粒度坍缩**：portfolio 侧是用户级事实（`WatchlistItem` 唯一键 `(groupId, market, code)`，同一标的可跨 N 用户 M 组）；marketdata 侧分级是标的级——T0 判定 = 全账号去重并集 `distinct (market, code)`，不关心引用次数与来源。
- **Q7-B 直查是终态选择非临时债**（ADR-0048 复审记录）：每夜一读 + 一句话重建 → 投影机器（Outbox/事件/计数器）无摊销对象；升 Q7-A 仅两 trigger（盘中实时分级 / portfolio schema 耦合实际咬人）。**第二信号源（holdings 等）落地不构成升级压力**——B 形态下只是并集 union 里多一条夜查。
- **确定性成员制非打分**（master §4.3）：命中并集即 T0、否则 T2，每次重算全量快照天然自愈（无引用计数漂移/无对账）；打分衰减留更后续升级。
- **tier 序消费的承重点**：017 各维度 executor 现按 `id asc` 单序遍历（`loadActiveInstruments`）——改为 `syncTier asc` 优先后，T0 天然先吃双窗令牌桶；配额耗尽 self re-enqueue 顺延（017 D5）+ `pendingEodInstruments` 进度锚语义不变，续跑仍按 tier 序 → **T0 保底不需要新机制，是排序的自然推论**。
- **重算失败不阻塞同步**：跨 ctx 读引入新故障面（portfolio 表不可用/查询异常）——降级语义 = 沿用现有 syncTier 照常同步 + 告警；分级是优化不是正确性前提。
- **schema 零迁移**：`syncTier Int @default(2)` 列 015 已建（0/1/2 值域已支持）、universe upsert 已护住不覆盖（016）；本 feature 纯行为变更。

## Clarifications

### Session 2026-06-04

- Q: 重算触发时点形态（tick 组 flow 前 / 独立 `sync:tier_recalc` 维度 job / executor 前置步骤）？ → A: **executor 前置步骤**——按 instrument 遍历的维度 executor 起手先幂等重算（具体收敛点归 plan）。理由：重算 = 一条 distinct 查询 + updateMany 毫秒级，独立维度 job（named job + 依赖边 + 装配器全序重排）对其过度设计；tick 层挂载则 CLI/cascade 路径拿不到新 tier。executor 前置让所有触发路径（tick / CLI / cascade / 过渡期旧管线 `run()`）天然带最新 tier，零新结构、幂等多跑无害。

- Q: 新加自选的生效时点（当夜即升 T0 vs 次夜重算生效）？ → A: **下一次同步运行快照生效**——executor 前置重算的自然推论：维度 job 起手取并集快照，同步开跑前加的自选当夜即享 T0，同步后加的下一次同步（通常次夜）生效；零额外机制。严格实时生效需事件触发 + 队列干预，重新引入被 ADR-0048 复审拒绝的事件机器，且对夜间 EOD 数据无收益。

- Q: T0 失败重试优先（`failedTargets` 中 T0 优先重试）V1 实装还是留 seam？ → A: **留 seam 不实装**——系统性故障已有 017 维度级 retry（retryMax→attempts），重试时 tier 序自动让 T0 先补；单标级失败多为 vendor 数据侧问题，立即重试白烧配额；次夜重跑 T0 排序优先天然先补（最多晚一天，与生效时点快照语义一致）。failedTargets 照记审计。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] syncTier 确定性重算（Q7-B 并集直查 → 落库）（Priority: P1）

系统在按 instrument 遍历的维度 executor **起手前置步骤**重算全 universe 的 `Instrument.syncTier`（clarify 2026-06-04：executor 前置形态，所有触发路径 tick/CLI/cascade/过渡期旧管线天然一致；收敛点归 plan）：以一条只读跨 ctx 查询取全账号自选并集（`distinct (market, code)`，带 `// CROSS-CONTEXT-READ:` 注释），命中 → `syncTier=0`，未命中 → `syncTier=2`；确定性成员制、幂等（并集不变则零行变更，同夜多维度重复重算无害）；portfolio 侧零代码改动。重算失败（portfolio 表读取异常）不阻塞当夜同步——沿用现有 syncTier + 降级告警。

**Why this priority**: 分级的事实基础；无重算则 tier 序消费无序可依。

**Independent Test**: Testcontainers PG：seed watchlist 行 + instrument 行 → 跑重算 → 断言命中/未命中标的的 syncTier；连跑两次断言幂等；清空 watchlist 断言全回 T2；注入 portfolio 读失败断言同步不阻塞 + 告警。

**Acceptance Scenarios**:

1. **Given** watchlist 含 `cn:600519`（任意用户任意组），**When** 重算执行，**Then** `cn:600519` 的 syncTier=0，其余 universe=2
2. **Given** 同一标的被多用户多组引用，**When** 重算执行，**Then** 该标的 syncTier=0（并集去重口径，与引用次数无关）
3. **Given** 并集不变，**When** 重算连续执行两次，**Then** 第二次零行变更（幂等）
4. **Given** 自选全部清空，**When** 重算执行，**Then** 全 universe syncTier=2，同步行为与 016 全量统一等价
5. **Given** portfolio 表读取异常，**When** 重算失败，**Then** 当夜同步沿用现有 syncTier 照常执行 + 降级告警

---

### User Story 2 — [Server] tier 序消费 + 配额顺延 T0 保底（Priority: P1）

各维度同步（eod_bar / fundamental / financial / corporate_action 等按 instrument 遍历的维度）按 `syncTier asc` 优先消费双窗令牌桶（同 tier 内保持既有稳定序）；配额/窗口耗尽顺延（017 self re-enqueue + `pendingEodInstruments` 进度锚）语义不变——T0 因排序天然保底，T2 截断顺延，续跑幂等且仍按 tier 序。

**Why this priority**: 「保用户可见集最鲜」的执行落点；与 US1 合并构成 MVP。

**Independent Test**: Testcontainers PG+Redis（mock vendor）：seed T0/T2 混合 universe + 注入预算截断（`maxEodInstruments` < T0+T2 总数且 > T0 数）→ 断言 T0 全部落库、T2 部分截断；顺延续跑断言已同步标的跳过、剩余 T2 继续、tier 序保持。

**Acceptance Scenarios**:

1. **Given** universe 含 T0 与 T2 标的，**When** 任一维度同步执行，**Then** 全部 T0 标的先于任何 T2 标的被消费
2. **Given** 预算只够 T0 + 部分 T2，**When** 配额耗尽，**Then** T0 全部完成、T2 截断顺延（self re-enqueue），SyncRun 记录如实
3. **Given** 顺延续跑触发，**When** 续跑执行，**Then** 进度锚跳过已同步标的、剩余按 tier 序继续、无重复同步
4. **Given** 016/017 既有幂等与失败隔离语义，**When** 本 feature 合入，**Then** 既有行为零回归（IT 全绿）

---

### User Story 3 — [Server] 跨 ctx 治理与回归门（Priority: P2）

marketdata 对 portfolio 的只读直查点带 `// CROSS-CONTEXT-READ:` 注释（`check-server-moat` 探针强制；跨 ctx 写永远禁）；不引入 portfolio module import 边（直查经 PrismaService，ESLint boundaries 零新边）；universe 周更 upsert 不覆盖既有 syncTier（016 已护，回归断言）；T1 不实装留 seam（文档化）。

**Why this priority**: marketdata 失去叶子身份的同时把耦合面钉死在「一条带注释的查询」上——治理是本 feature 对架构的承诺。

**Independent Test**: ① `check-server-moat` 0 violation + 直查点注释 grep 在场；② ESLint boundaries 零新 module 依赖边；③ universe upsert IT：既有标的 syncTier=0 经 upsert 后仍为 0。

**Acceptance Scenarios**:

1. **Given** marketdata 内 watchlist 直查点，**When** moat 探针扫描，**Then** `CROSS-CONTEXT-READ` 注释在场、0 violation；移除注释则 CI 红
2. **Given** universe 周更 upsert 既有标的，**When** 该标的 syncTier=0，**Then** upsert 后仍为 0（不被默认值覆盖）
3. **Given** 全部改动合入，**When** 016/017 既有 marketdata IT 套件执行，**Then** 全绿（行为零回归）

---

### Edge Cases

- **自选并集为空**（新部署/用户清空）→ 全 universe T2，同步行为退化为 016 全量统一，不报错不特判
- **同一标的多用户多组引用** → distinct 并集口径，引用次数无关；删除一个引用不影响其余引用的 T0 资格（每次重算全量快照，无引用计数）
- **自选标的不在 universe 内**（用户自选了已退市/黑名单标的）→ 重算只更新存在的 Instrument 行；黑名单标的无论 tier 完全不同步（黑名单优先级高于 tier）
- **portfolio 表读取异常**（schema 变更/连接故障）→ 重算降级：沿用现有 syncTier + 告警，同步照跑（分级是优化非正确性前提）
- **重算与同步并发** → executor 前置形态（clarify 2026-06-04）下每维度起手取并集快照，同夜各维度间 tier 可能微漂（用户在维度间隙加自选）——最多影响后续维度消费序，不影响正确性（幂等兜底）
- **新上市标的**（universe 周更新增）→ 默认 syncTier=2，下次重算如在自选则升 T0
- **新加自选的生效时点** → 下一次同步运行快照生效（clarify 2026-06-04）：同步开跑前加 = 当夜 T0，同步后加 = 下一次同步生效；不做实时升级
- **universe upsert 覆盖风险** → 016 已护（update 路径不带 syncTier），回归断言拦
- **`maxEodInstruments` 截断与 tier 交互** → 截断按 tier 序生效（先 T0 后 T2），不再是 id 序前 N 个
- **单标的同步失败**（per-instrument try/catch → `failedTargets`）→ V1 无 tier 区分的即时重试（clarify 2026-06-04 留 seam）：T0 失败靠 017 维度级 retry + 次夜 tier 序优先自然补

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 系统 MUST 提供 syncTier 确定性重算：全账号自选并集（`distinct (market, code)` 口径）命中 → `Instrument.syncTier=0`，未命中 → `2`；MUST 幂等（并集不变零行变更）；MUST 为成员制快照（每次重算全量重建，无引用计数/无增量状态）。触发形态 MUST 为**维度 executor 前置步骤**（clarify 2026-06-04）——按 instrument 遍历的维度起手幂等重算，所有触发路径（tick/CLI/cascade/过渡期旧管线）MUST 拿到同一重算语义；MUST NOT 新增独立维度 job / `sync_dependency` 边 / tick 层挂载。
- **FR-S02**: 跨 ctx 读 MUST 为 Q7-B 直查：marketdata 侧经 PrismaService 只读查询 portfolio watchlist 表 + 查询点上方 `// CROSS-CONTEXT-READ:` 注释（`check-server-moat` 强制）；MUST NOT 引入 Outbox 事件/投影表/portfolio use case 直 DI（Q7-C 禁）；MUST NOT 跨 ctx 写；portfolio 模块 MUST 零代码改动。
- **FR-S03**: 共用全量工作集的 **fact 维度**（eod_bar / fundamental / financial / corporate_action）同步 MUST 按 `syncTier asc` 优先消费（同 tier 内保持既有稳定序）；T0 全部先于 T2。profile 富化遍历（缺 companyType 子集，一次性语义）不在内（per plan D2，analyze C1 2026-06-04 收紧措辞）。
- **FR-S04**: 配额/窗口耗尽顺延语义 MUST 不变（017 self re-enqueue + `pendingEodInstruments` 进度锚）；续跑 MUST 仍按 tier 序且幂等不重复——T0 保底由排序推论达成，MUST NOT 引入额外保底机制。
- **FR-S05**: universe 同步 upsert MUST 不覆盖既有标的 syncTier（016 既有行为，回归断言）；新标的默认 2。
- **FR-S06**: 重算失败 MUST NOT 阻塞同步——降级沿用现有 syncTier 照常执行 + 降级告警（并入 017 既有两道告警分工，不新增告警通道）。
- **FR-S07**: 本 feature MUST NOT 新增读端点 / 改 OpenAPI 契约 / 触发 `packages/api-client` regen；mobile 无感知。
- **FR-S08**: T1（recency）MUST NOT 实装——留 seam 文档化（访问历史记录表落地后升三级，`syncTier=1` 值域已支持）；schema MUST 零迁移。
- **FR-S09**: 黑名单（`SyncBlacklist`）优先级 MUST 高于 tier——黑名单内标的无论 tier 完全不同步（016 语义不变）。
- **FR-S10**: 本 feature MUST NOT 触碰 017 PR-7 待清退面（旧 `EodSyncPipeline.run()` / 旧 22:00 调度路径的删除）——tier 序消费落在 executor 层使新旧两形态同时受益，清退后零返工。

### Out-of-Scope Functional Boundaries

- ❌ T1 recency 分级（访问历史表未建，留 seam）
- ❌ holdings / 追踪 / 预警信号源（落地后 union 多一条夜查即可，B 形态平移）
- ❌ Q7-A 投影 + Outbox（ADR-0048 复审记录两 trigger 前不重开）
- ❌ 盘中实时分级刷新（master §B.4 seam；触发即 Q7-A 复审点）
- ❌ 打分衰减式 tier（确定性成员制已满足 V1）
- ❌ T0 失败优先重试（failedTargets 二次重试循环）——维度级 retry + 次夜 tier 序自然补已覆盖（clarify 2026-06-04 留 seam）
- ❌ 管理界面 / tier 可视化

## Key Entities

- **Instrument.syncTier（既有列，本 feature 首个消费者）**：0 = T0（自选并集命中）/ 2 = T2（其余 universe）/ 1 = T1 预留值域。重算写入、维度消费排序读取、universe upsert 护值。
- **WatchlistItem（portfolio 表，只读被查）**：T0 唯一信号源；`(groupId, market, code)` 用户级事实 → `distinct (market, code)` 标的级并集的多对一坍缩；本 feature 不改其 schema 与写路径。
- **SyncRun（017 per-dimension 审计，复用）**：executor 前置形态（clarify 2026-06-04）下重算无独立审计行——并入所在维度的 SyncRun 行；重算降级走告警 log（FR-S06），不入审计新字段。

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: 重算 IT 覆盖：命中→0 / 未命中→2 / 多用户多组去重 / 连跑两次幂等零变更 / 清空全回 T2 / portfolio 读失败降级照跑+告警。
- **SC-S02**: 消费序 IT：mock vendor 下任一 **fact 维度**同步，T0 标的落库时序全部先于 T2（断言消费顺序而非仅最终状态；universe/profile 不消费全量工作集，analyze A1）。
- **SC-S03**: 截断保底 IT：预算注入（够 T0 + 部分 T2）→ T0 全部完成、T2 截断顺延；续跑进度锚跳过已同步、tier 序保持、零重复。
- **SC-S04**: 治理门：`check-server-moat` 0 violation + 直查点 `CROSS-CONTEXT-READ` 注释 grep 在场 + ESLint boundaries 零新 module 边。
- **SC-S05**: 回归门：016/017 既有 marketdata IT 全绿；universe upsert 护值断言；黑名单优先级断言。
- **SC-S06**: 端到端控时 IT：「重算 → tick 入队 → tier 序消费 → 配额截断 → 顺延续跑」全链路一夜模拟，T0 全保鲜、审计行如实。

## Assumptions

- **架构决策已定稿不重开**：Q7-B 终态（含拒绝项：Q7-A 投影/计数器形态、第二 producer 升级论）per ADR-0048 复审记录 2026-06-04；复审条件 = 其两 trigger。
- **017 执行层形态稳定**：executor 注册表 / tick / flow（PR-3/4/5 已合）是实装宿主；017 PR-6 灰度 / PR-7 清退与本 feature 并行不冲突（FR-S10 钉死不碰清退面）。
- **规模假设**：watchlist 行数百级、并集几十级、universe ~5400——一条 distinct 查询毫秒级，重算每夜一次无性能预算压力（无 HTTP 端点，无 request-latency budget）。
- **黑名单/幂等/双窗限频语义**全沿 016/017，不重述不改动。
- **测试范式沿用**：Testcontainers 真 PG+Redis + mock vendor adapter；017 IT 蓝本（`marketdata.dimension-worker.it.spec.ts` / `marketdata.tick-driver.it.spec.ts`）。

## Out of Scope（本 feature 不做）

- **T1 recency / 三级模型完整态**——访问历史表落地后独立升级。
- **holdings/追踪/预警并集源**——各自 feature 落地后 union 平移扩展。
- **Q7-A 投影机制**——两 trigger（盘中实时 / schema 耦合咬人）前不重开。
- **盘中实时分级刷新**——master §B.4 seam。
- **管理界面 / 监控面板**。
