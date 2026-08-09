---
feature_id: 017-marketdata-scheduler
modules: [marketdata]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-06-04'
updated_at: '2026-08-09'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
web_compat_notes: '纯 server 调度体系重构（016 同步管线的调度形态演进）。零 mobile/web surface：不新增读端点、无 OpenAPI 契约变更、无 mobile 段、无 Web export 冒烟路径。'
agent_friction_observed: false
state_branches:
  - 'tick due: enabled 维度 nextFireAt <= now → 条件 UPDATE 抢占成功（affected=1, won）→ 推进 nextFireAt + 该维度入队'
  - 'tick 双触发竞态: 两个 tick 并发扫到同一 due 维度 → 条件 UPDATE 仅一方 won，另一方 affected=0（lost）不入队（正确性不依赖 Redis 锁）'
  - 'tick 非 due: 全维度 nextFireAt > now → 空扫零副作用（一条 updateMany，极轻）'
  - 'dimension disabled: enabled=false → tick 不扫该维度，不入队不推进'
  - 'nextFireAt NULL 懒初始化: enabled 且 nextFireAt IS NULL（migration 后/置 NULL 重物化请求）→ tick 按 cronExpr 写入下一次未来时刻，该轮不入队不补跑'
  - '重物化原语: 运维改 cronExpr / re-enable 时置 nextFireAt=NULL → 下轮 tick 重物化；misfirePolicy 不对 NULL 生效（无 surprise 补跑）'
  - '非交易日 tick: 维度 due 但今日非交易日 → 交易日 gate 在组 flow 前短路（零 vendor 调用），nextFireAt 照常推进'
  - 'misfire fire-now: 启动后首个 tick 扫到过期 nextFireAt 且 misfirePolicy=fire-now → 补入队「本该跑的那一次」（delta 拉当天），推进 nextFireAt'
  - 'misfire skip-to-next: misfirePolicy=skip-to-next → 仅推进 nextFireAt 不补跑'
  - 'misfire 多天缺口: 宕机多天 → fire-now 仍只补一次（misfire≠backfill），历史缺口走 backfill CLI 手动补'
  - '共同触发日依赖: universe 与 eod_bar 同一 tick 共同 due → FlowProducer 组 flow，eod_bar 等 universe'
  - 'universe 缺席日: universe 不 due 的日子（如周二）→ universe→eod_bar 边自动失效，eod_bar 当 flow 根照跑（最高风险分支，专项 IT）'
  - 'hard 边上游失败: profile job 失败 → fundamental 不跑（failParentOnFailure，fsType 路由依赖）'
  - 'soft 边上游失败: universe job 失败 → 下游照跑（ignoreDependencyOnFailure）'
  - 'job 失败重试: processor 抛错且 attempts 未耗尽 → BullMQ 按 SyncDimension.retryMax 重试'
  - 'retry 耗尽: attempts 耗尽 → job 终态 failed → QueueEvents failed 监听告警 + SyncRun status=failed'
  - '配额耗尽顺延: 维度 job 内配额/窗口耗尽 → self re-enqueue with delay 续跑（取代「等明晚」），pendingEodInstruments 进度锚幂等续跑'
  - 'Redis job 丢失自愈: job 被驱逐/Redis 宕机丢失 → PG 真相层下轮 tick 发现 due 未跑 → 重新入队（Redis 非调度真相）'
  - 'CLI 手动触发: trigger CLI --dimension X → 入队 + waitUntilFinished（CLI 不起 worker，由 server 进程唯一 worker 消费），与自动 job 同 queue 天然互斥，退出码反映 job 终态'
  - 'CLI server 不在线: queue 无活跃 worker → waitUntilFinished 超 --timeout → 非 0 退出 + 可操作错误信息（不静默挂起）'
  - 'CLI 级联: --cascade → 从修复点为根查传递性下游组 flow，不含已成功上游'
  - '灰度 flag 关（默认）: MARKETDATA_TICK_ENABLED=false → tick 不驱动入队，旧 22:00 管线照旧'
  - '灰度 flag 开: 新 tick 驱动与旧 22:00 管线并存观察 → 幂等 + 过渡期调度锁防双拉（双拉只费配额不坏数据）'
  - '清退后: 旧 @Cron 22:00 / EodSyncPipeline.run() / dimension-due / Redis 调度锁调度用法 / eod-sync 聚合行写入全删 → 仅 tick+queue 形态'
---

# Feature Specification: Marketdata 调度体系重构（PG 调度真相层 + BullMQ 执行层 — 维度失败隔离 / misfire catch-up / 依赖编排 / 手动+级联触发）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-06-04)]**
> 本 feature 是 016 同步管线**调度形态的演进**，根决策已落 [ADR-0049](../../docs/adr/0049-marketdata-scheduler-bullmq-hybrid.md)（Accepted）：**PG 调度真相层 + 裸 BullMQ 执行层**（类 Quartz 混合架构），设计全文 = [06-04-marketdata-scheduler-redesign](../../docs/private/plans/2026-06/06-04-marketdata-scheduler-redesign.md) §H。本 spec 不重开架构决策（Temporal / pg-boss / 自研 / per-instrument job / @nestjs/bullmq wrapper / BullMQ limiter 等拒绝项见 ADR-0049 留痕防回潮），只把已定稿架构转成可验收的行为契约。落地仍按 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) bounded context 边界 + [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) Flat + Anemic + Moat 范式（裸 bullmq 手动 provider 贴手控风格）；marketdata 仍是叶子 context（零跨 ctx 读）。具体类名 / 文件切分 / SQL 细节归 plan。
>
> 🎯 **[流程 — 纯 server 调度重构，无 mockup]**
> 本 feature **无 UI**，走 sdd.md 后端业务模块标准流程：`spec → /speckit-clarify → plan → tasks → impl`（无 mockup 步）。**零新读端点、零 OpenAPI 契约变更**。验证全走 Testcontainers IT（真 PG+Redis 容器，`marketdata.scheduler-lock.it.spec.ts` 蓝本）+ 控时注入。

**Feature Branch**: `017-marketdata-scheduler`
**Created**: 2026-06-04
**Status**: Clarified（clarify 2026-06-04：① `nextFireAt` NULL=未物化哨兵 + tick 懒初始化、置 NULL=唯一重物化原语；② CLI 永不起 worker、唯一 worker 在 server、超时非 0 退出；③ tick won 后入队前崩溃 = 显式接受的毫秒级丢失窗口，不加机制）
**Module**: `marketdata`（015 立 context / 016 落同步管线 — 本 feature 重构其调度层；schema `marketdata` 增量演进 expand-only）
**设计源**: [ADR-0049](../../docs/adr/0049-marketdata-scheduler-bullmq-hybrid.md)（决策 + 拒绝项）+ [设计文档 §H](../../docs/private/plans/2026-06/06-04-marketdata-scheduler-redesign.md)（目标架构 / schema 草案 / PR 切片 / 测试策略 / 风险表）
**前置依赖**: [016-marketdata-sync](../016-marketdata-sync/spec.md)（同步管线 + SyncDimension/SyncRun/SyncBlacklist 三表 + 双窗令牌桶 + Redis 调度锁——本 feature 演进其调度形态，复用其维度同步逻辑）
**Input**:

- 016 ship 的调度形态有四个结构性缺陷（ADR-0049 Context，代码实证见设计文档 §A）：① **失败连坐**——6 维度同一 try 块串行，任一维度顶层异常下游全不跑；② **单一静态时间点**——`@Cron` 22:00 触发整管线，`SyncDimension.cronExpr` 只是管线内「今日 due」过滤器而非独立调度；③ **无 misfire/catch-up**——进程错过 22:00 永不补跑，`retryMax` 字段无消费者；④ **无依赖编排/手动级联**——上游（周级 universe）修复后无法拉起下游（日级 bar），手动面仅 backfill CLI。
- 诉求：类 Quartz 的**基于存储可恢复调度**（单节点即可）+ **任务依赖编排**（软依赖现在、硬依赖留能力）+ **延迟/手动触发** + **修复后级联拉起**。
- 已定稿分层（ADR-0049 Decision）：**PG 调度真相层**（SyncDimension 扩 nextFireAt/misfirePolicy + 新表 sync_dependency）→ **SyncTickDriver**（分钟级无状态 tick + 条件 UPDATE 抢占 + misfire catch-up + 交易日 gate）→ **BullMQ 执行层**（单 queue `marketdata-sync` / concurrency=1 / 6 个 per-dimension named job / FlowProducer 依赖编排）。
- 渐进迁移：7 片 PR（设计文档 §H4），旧 22:00 管线过渡期不下线，灰度 flag `MARKETDATA_TICK_ENABLED` 控切换；唯一不可逆片（清退旧调度器）放最后且建议人工合并。

## Context

- **为什么现在做**：prod `sync_dimension` 6 维度当前全 disabled，universe 启用在等本调度重构 + 0.4.0 发版后衔接——调度可靠性是「敢在 prod 开同步」的前置。失败连坐（#318 只修了 universe 源返空不抛，结构未变）+ 无 misfire 意味着单点故障即整夜数据缺口且永不自愈。
- **Redis 角色铁律（ADR-0049）**：Redis 只是执行队列，**不是调度真相**——job 丢失（驱逐/宕机）由 PG 真相层下轮 tick 发现未跑、重新入队，可自愈。为此 prod compose 改 `maxmemory-policy allkeys-lru → noeviction` + 加 `appendfsync everysec`（AOF 已开）。
- **调度正确性主防线 = PG 条件 UPDATE**：tick 用「条件 UPDATE 抢占推进 nextFireAt」（affected-count won/lost）防双 tick 重复入队，正确性不依赖 Redis 锁；queue concurrency=1 是第二道；Redis 调度锁（`EOD_SYNC_LOCK_KEY`）仅过渡期保留，随旧调度器在最后清退片下线。
- **misfire ≠ backfill（语义切分）**：`fire-now` 只拉起「本该跑的那一次」（delta 模式拉当天）；宕机多天的历史缺口是**数据问题不是调度问题**，走 backfill CLI 手动补。理由：理杏仁真实配额未实测（短窗 ~15 调用即 429 有观察记录），自动多天 backfill 有烧爆配额风险。
- **跨周期依赖语义**：依赖边**只约束同一 tick 内共同触发的维度**——universe（周一）不 due 的日子，`universe→eod_bar` 边自动失效，eod_bar 当 flow 根照跑；共同触发日边生效（bar 等 universe）。种子边：`universe→*` 全 **soft**（误配 hard = universe 缺席日下游全不跑，最高风险项，专项 IT 拦）；`profile→fundamental` **hard**（fsType 路由依赖）。
- **单节点前提仍成立（ADR-0047 F4）**：vendor 限频封顶吞吐 → 多节点分片零收益；queue concurrency=1 + 进程内 `VendorRateLimiter`（**不用** BullMQ limiter——单窗既表达不了理杏仁「36/s 且 1000/min」双窗约束，也表达不了富途 shim 的 30 秒滚动窗）+ **明确拒绝 per-instrument job**（5400 job/天反模式）。前提失效条件见 ADR-0049 sunset triggers。
- **复用既有设施**：SyncUniverse/SyncProfile 等维度 use case **零改动复用**（executor 从 4 个 fact 私有方法升格）；cron 解析复用 cron-parser + Asia/Shanghai 已验证范式（dimension-due.ts）；幂等 + per-instrument try/catch + failedTargets + pendingEodInstruments 进度锚全保留。
- **审计/执行真相分工**：SyncRun（PG）= 业务审计真相，改 per-dimension 粒度（`syncType='sync:<dim>'` + 关联 `bullJobId`），旧 `'eod-sync'` 聚合行过渡期并存；BullMQ job（Redis）= 执行/重试真相。告警两道：processor 内 alertIfDegraded（业务降级）+ QueueEvents failed 监听（retry 耗尽硬失败）。

## Clarifications

### Session 2026-06-04

- Q: `nextFireAt` 生命周期——migration 后 NULL / 改 cronExpr 后 stale / re-enable 后过期，三个时点怎么处理？ → A: **NULL = 未物化哨兵 + tick 懒初始化**。tick 额外扫 `nextFireAt IS NULL` 的 enabled 维度，按 cronExpr 算**下一次未来时刻**写入（本轮不入队、不补跑）；「置 NULL = 请求重物化」是唯一运维原语——改 cronExpr / 重新 enable 的运维动作同时置 `nextFireAt = NULL`；misfirePolicy 只对「已物化且过期」的 nextFireAt 生效（防 re-enable 误补跑）；想立即跑走 trigger CLI 显式入口。migration 不回填 nextFireAt（新列全 NULL，首个 tick 懒初始化收敛）。
- Q: CLI 入队后由谁消费——CLI 自起 worker（standalone 语义保留）还是依赖 server 进程的 worker？ → A: **CLI 永不起 worker**。全局唯一 worker 在 server 进程，互斥不变量（queue concurrency=1）靠拓扑保证而非纪律；CLI 只入队 + `waitUntilFinished` + `--timeout`（缺省值归 plan）——server 不在线时超时**非 0 退出 + 可操作错误信息**，不静默挂起。016 backfill CLI 的「standalone 自跑管线」语义随迁入队形态废弃（backfill 前提变为 server 在线）。
- Q: tick「赢了条件 UPDATE 但入队前崩溃/Redis 拒写」的丢失窗口（nextFireAt 已推进 → misfire 发现不了）怎么处理？ → A: **接受窗口 + 显式文档化，不加机制**。窗口毫秒级 × 每天 6 次触发，期望丢失率可忽略；最坏丢一个周期，SyncRun 缺行可审计发现，补救 = trigger CLI / backfill CLI。拒绝入队回执回滚（窗口缩小非归零，多一段补偿代码）与 PG outbox 中转（对 6 job/天 过度设计）；不反转「先入队后 UPDATE」顺序（会破坏双 tick 防重主防线）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 执行基础设施落地（bullmq 依赖 + Redis 可靠性改造 + 队列连接 provider）（Priority: P1）

系统引入执行队列基础设施：`bullmq` 依赖；prod compose Redis 改 `noeviction` + `appendfsync everysec`（job 不被静默驱逐、宕机丢失窗口 ≤1s）；队列专用独立 Redis 连接 provider（`maxRetriesPerRequest: null` 与共享 client 配置冲突，不能复用）。job 留存用 `removeOnComplete/removeOnFail` 限量，防 noeviction 下内存只增不减。

**Why this priority**: 一切执行层能力的物理底座；Redis policy 不先改，「Redis 非调度真相但 job 尽量不丢」的可靠性前提不成立。

**Independent Test**: ① compose 配置断言（noeviction + appendfsync everysec）；② Testcontainers Redis：队列连接 provider boot 成功、与既有共享 client（锁/缓存用）互不干扰；③ 入队 job 完成后按 removeOnComplete 留存上限被清理。

**Acceptance Scenarios**:

1. **Given** prod compose 配置，**When** 审查 Redis 服务段，**Then** `maxmemory-policy=noeviction` + `appendfsync everysec`（AOF 开）
2. **Given** server boot，**When** 队列连接 provider 初始化，**Then** 独立连接建立，既有 Redis 共享 client 行为不变
3. **Given** job 完成/失败累积，**When** 超过留存上限，**Then** 旧 job 记录被自动清理（Redis 内存有界）

---

### User Story 2 — [Server] PG 调度真相层 schema 落地（expand-only + 种子依赖边）（Priority: P1）

系统扩展调度真相层：`SyncDimension` 加 `nextFireAt`（下次触发时刻物化缓存，`cronExpr` 仍是真相）+ `misfirePolicy`（`fire-now`/`skip-to-next`，默认 fire-now）；`SyncRun` 加 nullable `bullJobId`（PG 审计 ↔ Redis job 关联）；新表 `sync_dependency`（upstream/downstream/mode `hard|soft`，唯一边约束）。种子边：`universe→profile / universe→eod_bar / universe→fundamental / universe→financial / universe→corporate_action` 全 **soft**；`profile→fundamental` **hard**。全部 expand-only（可逆，不动既有列/行为）。

**Why this priority**: 调度真相层是整个架构的「JobStore」；tick / 编排 / misfire 全部读写这层。无 schema 一切免谈。

**Independent Test**: Testcontainers PG：① migrate deploy 后断言新列/新表/唯一键存在且既有 016 行为不变（expand-only）；② seed 后断言 `universe→*` 5 条边全 soft、`profile→fundamental` hard（最高风险项第一道拦截）；③ 唯一边约束拒绝重复 (upstream, downstream)。

**Acceptance Scenarios**:

1. **Given** 016 schema 已在，**When** 跑本 feature migration，**Then** `nextFireAt`/`misfirePolicy`/`bullJobId` 列 + `sync_dependency` 表落地，旧列旧行为零变化
2. **Given** seed 执行后，**When** 查 `sync_dependency`，**Then** `universe→*` 全 soft、`profile→fundamental` hard
3. **Given** 重复插入同一 (upstream, downstream) 边，**When** 写入，**Then** 唯一约束拒绝

---

### User Story 3 — [Server] per-dimension 执行单元（executor + worker processor + 失败隔离 + retry + 配额顺延）（Priority: P1）

系统把 016 管线内的维度步骤升格为 **per-dimension 执行单元**：单 queue `marketdata-sync`（concurrency=1）上 6 个 named job（`sync:universe` / `sync:profile` / `sync:eod_bar` / `sync:fundamental` / `sync:financial` / `sync:corporate_action`）；job payload `{dimensionKey, mode, asOf(YYYY-MM-DD 字符串), backfillHistoryDays?, maxEodInstruments?, triggeredBy: tick|cli|cascade}`；每个 job 自管 per-dimension `SyncRun`（`syncType='sync:<dim>'` + `bullJobId`）；`SyncDimension.retryMax` → BullMQ `attempts`（字段终获消费者）；配额/窗口耗尽 → **self re-enqueue with delay** 续跑（取代「等明晚」），`pendingEodInstruments` 进度锚保证幂等续跑。SyncUniverse/SyncProfile 等维度 use case 零改动复用；旧 `run()` 过渡期保留。本片**不注册 tick**，仅手动可触发（渐进迁移）。

**Why this priority**: 这是「失败连坐 → 维度隔离」的核心修复——016 四缺陷之首。executor 是 tick / CLI / cascade 三种触发的共同执行面。

**Independent Test**: Testcontainers PG+Redis（mock vendor adapter）：① 手动入队单维度 job → 断言该维度落库 + per-dim SyncRun（syncType + bullJobId）；② 注入某维度 processor 抛错 → 断言其余维度 job 不受影响（无连坐）；③ retryMax=2 注入持续失败 → 断言重试 2 次后 failed + 告警钩子触发；④ 配额耗尽注入 → 断言 self re-enqueue（`getDelayed` 断言，不真等）+ 已同步标的幂等不重复。

**Acceptance Scenarios**:

1. **Given** 某维度 job 入队，**When** worker 处理，**Then** 该维度同步落库 + SyncRun(`sync:<dim>`) 记 scanned/ok/failed + bullJobId 关联
2. **Given** 维度 A job 抛顶层异常，**When** 维度 B job 在队列中，**Then** B 照常执行（失败隔离，无连坐）
3. **Given** `retryMax=N` 且 processor 持续失败，**When** 重试 N 次耗尽，**Then** job 终态 failed，QueueEvents failed 告警触发，SyncRun status=failed
4. **Given** 维度 job 内配额/窗口耗尽，**When** 处理中断，**Then** self re-enqueue with delay，进度锚（pendingEodInstruments）让续跑不重复已同步标的
5. **Given** 旧 22:00 管线，**When** 本片合入，**Then** 旧 `run()` 行为零变化（过渡期并存）

---

### User Story 4 — [Server] SyncTickDriver 调度驱动（分钟级 tick + 条件 UPDATE 抢占 + misfire catch-up + 交易日 gate + flag 灰度）（Priority: P1）

系统提供分钟级无状态 tick：扫 enabled 且 `nextFireAt <= now` 的维度，**条件 UPDATE 抢占推进 nextFireAt**（affected-count won/lost——won 才入队，防双 tick 重复入队，正确性不依赖 Redis 锁）；启动后首个 tick 扫到过期 `nextFireAt` = 天然 misfire catch-up（`fire-now` 补入队本该跑的那一次 / `skip-to-next` 仅推进不补）；交易日 gate 在此层（组 flow 前短路，零 vendor 调用）；`nextFireAt` 由 `cronExpr` 推导（Asia/Shanghai，复用已验证 cron 解析范式）。整个 tick 驱动由 env flag `MARKETDATA_TICK_ENABLED` 控制，**默认关**。

**Why this priority**: 这是「单一静态时间点 → 基于存储可恢复调度」+「无 misfire → catch-up」两缺陷的核心修复；也是 Redis job 丢失自愈的发现机制。

**Independent Test**: Testcontainers PG+Redis，控时（注入 now + 直接操纵 nextFireAt 列）：① due 维度 → tick 后 nextFireAt 推进 + job 入队；② 两个并发 tick 同扫一维度 → 仅一方 won 入队一次；③ 过期 nextFireAt + fire-now → 补入队一次（asOf=本该跑的那天）；④ 同场景 skip-to-next → 只推进不入队；⑤ 非交易日 due → 不组 flow 零 vendor 调用，nextFireAt 照常推进；⑥ flag=false → tick 零副作用。

**Acceptance Scenarios**:

1. **Given** enabled 维度 `nextFireAt <= now`，**When** tick 执行，**Then** 条件 UPDATE won → nextFireAt 按 cronExpr 推进 + 该维度 job 入队
2. **Given** 两个 tick 并发扫同一 due 维度，**When** 条件 UPDATE 竞争，**Then** 仅 affected=1 的一方入队（恰好一次）
3. **Given** 进程宕机错过触发时刻且 misfirePolicy=fire-now，**When** 重启后首个 tick，**Then** 补入队「本该跑的那一次」（delta 拉当天）；多天缺口不自动补（misfire≠backfill）
4. **Given** misfirePolicy=skip-to-next，**When** 过期 nextFireAt 被扫到，**Then** 仅推进 nextFireAt 不入队
5. **Given** 维度 due 但今日非交易日，**When** tick 执行，**Then** 组 flow 前短路（零 vendor 调用），nextFireAt 照常推进
6. **Given** `MARKETDATA_TICK_ENABLED=false`（默认），**When** tick 时刻到，**Then** 不驱动任何入队（旧 22:00 管线照旧）
7. **Given** enabled 维度 `nextFireAt IS NULL`（migration 后首启 / 运维置 NULL 重物化），**When** tick 执行，**Then** 懒初始化到 cronExpr 下一次未来时刻，该轮不入队不补跑（misfirePolicy 不对 NULL 生效）

---

### User Story 5 — [Server] 依赖编排（FlowProducer 组 flow + hard/soft 边 + 同 tick 语义）（Priority: P1）

系统在 tick 入队时按 `sync_dependency` **现场组 flow**：依赖边只约束**同一 tick 内共同触发的维度**——universe 不 due 的日子 `universe→eod_bar` 边自动失效、eod_bar 当 flow 根照跑；共同触发日边生效（bar 等 universe）。hard 边 = 上游失败下游不跑（failParentOnFailure）；soft 边 = 上游失败下游照跑（ignoreDependencyOnFailure）。

**Why this priority**: 这是「无依赖编排」缺陷的核心修复；「universe 缺席日下游照跑」是全 feature 最高风险行为（误配 = 每周 6 天数据不同步），必须专项验收。

**Independent Test**: Testcontainers PG+Redis 控时：① universe+eod_bar 共同 due → flow 中 eod_bar 等 universe 完成后执行；② **universe 不 due（如周二）→ eod_bar 当根照跑，不等不挂**（最高风险专项）；③ hard 边 `profile→fundamental`：profile 失败 → fundamental 不跑；④ soft 边 `universe→eod_bar`：universe 失败 → eod_bar 照跑。

**Acceptance Scenarios**:

1. **Given** universe 与 eod_bar 同一 tick 共同 due（如周一），**When** 组 flow 执行，**Then** eod_bar 在 universe 完成后执行
2. **Given** universe 不 due 的交易日（如周二），**When** tick 入队 eod_bar，**Then** eod_bar 作为 flow 根直接执行（边自动失效）
3. **Given** profile 失败（hard 边上游），**When** flow 推进，**Then** fundamental 不执行
4. **Given** universe 失败（soft 边上游），**When** flow 推进，**Then** 下游维度照常执行

---

### User Story 6 — [Server] 手动触发面（trigger CLI + --cascade 级联 + backfill CLI 迁入队）（Priority: P2）

系统新建 trigger CLI（与 backfill 职责分开）：`--dimension X [--cascade] [--as-of YYYY-MM-DD] [--timeout]`——入队对应维度 job 并 `waitUntilFinished`（退出码反映 job 终态，保运维脚本语义）；`--cascade` 从修复点为根查 `sync_dependency` 传递性下游组 flow（不含已成功上游）——上游修复后一键拉起全部下游。既有 backfill CLI 改「入队 + waitUntilFinished」形态，与自动 job 同 queue **天然互斥**（取代 Redis 锁互斥语义）。**CLI 永不起 worker**（clarify 2026-06-04）：全局唯一 worker 在 server 进程，互斥不变量靠拓扑保证；server 不在线 → CLI 超时非 0 退出 + 可操作错误信息。

**Why this priority**: 「手动级联拉起」是四缺陷之一的修复，但自动调度（US3-5）先立才有可触发对象；运维面可后置一片。

**Independent Test**: Testcontainers PG+Redis：① trigger 单维度 → job 入队执行完成、CLI 退出码 0；processor 失败 → 非 0 退出码；② --cascade 从 universe → 断言 flow 含全部传递性下游、不含已成功上游；③ CLI 触发与自动 job 并存 → 同 queue 串行（concurrency=1 互斥）；④ backfill 入队形态退出码语义保持。

**Acceptance Scenarios**:

1. **Given** 运维执行 trigger CLI `--dimension eod_bar`，**When** job 执行完成/失败，**Then** 退出码 0/非 0 对应 job 终态
2. **Given** universe 修复后执行 `--cascade`，**When** 组 flow，**Then** 从 universe 为根含传递性下游（profile/eod_bar/...），不含已成功上游
3. **Given** CLI 触发撞上自动 tick job，**When** 同 queue 消费，**Then** 串行执行不并发（天然互斥，无需调度锁）
4. **Given** backfill CLI 迁入队后，**When** 运维按既有方式调用，**Then** 参数与退出码 0/1 语义不变、退出码 2 重映射为等待超时（旧「锁未抢到」作废；执行前提变为 server 在线）
5. **Given** server worker 不在线，**When** CLI 入队等待超 `--timeout`，**Then** 非 0 退出 + 可操作错误信息（不静默挂起；CLI 不自起 worker 兜底）

---

### User Story 7 — [Server] 灰度切换与旧调度器清退（flag 开 → 并存观察 → 清退不可逆片）（Priority: P2）

系统分两步完成迁移收尾：**灰度片**——`MARKETDATA_TICK_ENABLED=true` 后新 tick 驱动与旧 22:00 管线并存观察 1-2 周（幂等 + 过渡期保留的 Redis 调度锁防双拉；双拉只费配额不坏数据）；**清退片**（⚠️ 不可逆，建议人工合并）——删旧 `@Cron` 22:00 / `EodSyncPipeline.run()` / dimension-due 过滤 / Redis 调度锁调度用法（`EOD_SYNC_LOCK_KEY`）/ `eod-sync` 聚合 SyncRun 行写入。

**Why this priority**: 收尾片；依赖前 6 个 story 全绿 + prod 观察期数据，无法提前。

**Independent Test**: 灰度片 = prod 观察（SyncRun per-dim 行连续 1-2 周正常 + Redis 内存稳定，非 IT）；清退片 = ① grep 断言旧调度残留为零（`@Cron.*22` / `EOD_SYNC_LOCK_KEY` 调度用法 / `'eod-sync'` 聚合写入）；② 既有全量 IT 在仅 tick+queue 形态下全绿。

**Acceptance Scenarios**:

1. **Given** flag 开且旧管线未删，**When** 双方同夜触发同维度，**Then** 幂等 + 过渡锁保证数据不坏（至多浪费配额）
2. **Given** prod 灰度 1-2 周 SyncRun per-dim 行正常 + Redis 内存稳定，**When** 合入清退片，**Then** 旧调度路径物理删除，仅 tick+queue 形态
3. **Given** 清退片合入后，**When** 全量 IT + grep 扫描，**Then** 零旧调度残留、全绿

---

### Edge Cases

- **双 tick 竞态**（重启重叠/调度抖动致两 tick 并发）→ 条件 UPDATE affected-count 仲裁，恰好一次入队；正确性不依赖 Redis 锁
- **`universe→*` 边误配 hard**（最高风险）→ universe 缺席日（每周 6 天）下游全不跑 → seed 全 soft + 专项 IT + seed 断言双重拦截
- **Redis 内存满（noeviction 拒写）**→ removeOnComplete/removeOnFail 限 job 留存 + 确认 quote 缓存键有 TTL + 监控内存；256mb 对 6 job/天充足
- **Redis job 丢失**（宕机窗口/手动 flush）→ PG 真相层下轮 tick 发现 due 未跑重新入队，自愈不丢调度
- **tick won 后入队前崩溃**（UPDATE 与 enqueue 非原子，nextFireAt 已推进 → misfire 发现不了）→ **接受的毫秒级丢失窗口**（clarify 2026-06-04）：最坏丢一个周期，SyncRun 缺行审计可见，补救 = trigger CLI / backfill；不加 outbox/回滚机制，不反转顺序（保双 tick 防重主防线）
- **nextFireAt 时区/cron 计算错** → 复用 cron-parser + Asia/Shanghai 已验证范式（dimension-due.ts）+ 控时 IT 覆盖
- **nextFireAt NULL（migration 后首启 / 改 cronExpr / re-enable）** → NULL = 未物化哨兵，tick 懒初始化到未来下一次（不补跑）；「置 NULL = 重物化」单一运维原语，立即跑走 trigger CLI（clarify 2026-06-04）
- **宕机多天后重启**（misfire 多天缺口）→ fire-now 只补一次（delta 当天），历史缺口走 backfill CLI（防自动 backfill 烧爆理杏仁未实测配额）
- **维度 job 还在跑时下一周期 due**（超长 job 跨周期）→ tick 照常入队，concurrency=1 串行排队 + 幂等保证不坏数据
- **asOf 跨 JSON 序列化**（Date 对象进 Redis payload 丢类型）→ payload 中 asOf 固定 YYYY-MM-DD 字符串
- **CLI 触发撞自动 job** → 同 queue concurrency=1 天然互斥，无需额外锁；互斥不变量靠「CLI 永不起 worker、唯一 worker 在 server」拓扑保证（clarify 2026-06-04）
- **CLI 在 server down 时调用** → `waitUntilFinished` 超 `--timeout` 非 0 退出 + 可操作错误信息，不静默挂起、不自起 worker 绕过队列
- **cascade 根的已成功上游**（修复 profile 后 cascade 不应重跑已成功的 universe）→ cascade 只含修复点的传递性**下游**
- **过渡期双拉**（灰度期新旧并跑）→ 幂等兜底 + 过渡期保留 EOD_SYNC_LOCK_KEY；清退片才删锁
- **QueueEvents 告警与业务降级重复告警** → 两道告警分工：processor 内 alertIfDegraded=业务降级；QueueEvents failed=retry 耗尽硬失败

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 系统 MUST 落 PG 调度真相层（expand-only）：`SyncDimension` 加 `nextFireAt`（物化下次触发时刻；`cronExpr` 仍是唯一调度真相）+ `misfirePolicy`（`fire-now`/`skip-to-next`，默认 `fire-now`）；`SyncRun` 加 nullable `bullJobId`；新表 `sync_dependency`（upstream/downstream/mode `hard|soft`，唯一边约束）。既有 016 行为 MUST 零变化。
- **FR-S02**: 种子依赖边 MUST 为：`universe→{profile,eod_bar,fundamental,financial,corporate_action}` 全 **soft**、`profile→fundamental` **hard**；`universe→*` 边 MUST NOT 为 hard（misconfiguration = universe 缺席日下游全不跑，专项 IT + seed 断言双重拦截）。
- **FR-S03**: 系统 MUST 提供分钟级无状态调度 tick：扫 enabled 且 `nextFireAt <= now` 的维度，以**条件 UPDATE 抢占推进 nextFireAt**（affected-count won/lost）决定入队权——并发 tick 下同一触发时刻 MUST 恰好一次入队；调度正确性 MUST NOT 依赖 Redis 锁。
- **FR-S03a**: `nextFireAt IS NULL` MUST 作「未物化」哨兵：tick MUST 对 enabled 且 NULL 的维度按 cronExpr 懒初始化到**下一次未来时刻**（该轮 MUST NOT 入队/补跑）；「置 NULL = 请求重物化」MUST 是唯一重算原语（改 cronExpr / 重新 enable 的运维动作同时置 NULL）；migration MUST NOT 回填 nextFireAt（clarify 2026-06-04）。
- **FR-S04**: misfire 语义 MUST 为 **misfire≠backfill**：启动后首个 tick 扫到过期 `nextFireAt` 即 catch-up——`fire-now` MUST 只补入队「本该跑的那一次」（delta 模式拉当天）；`skip-to-next` MUST 仅推进不补；多天历史缺口 MUST NOT 自动补跑（走 backfill CLI，防烧爆理杏仁未实测配额）。misfirePolicy MUST 只对「已物化且过期」的 nextFireAt 生效——NULL 走 FR-S03a 懒初始化，MUST NOT 触发补跑（防 re-enable 误补，clarify 2026-06-04）。
- **FR-S05**: 交易日 gate MUST 在 tick 层（组 flow 前短路，零 vendor 调用）；非交易日 due 的维度 `nextFireAt` MUST 照常推进。
- **FR-S06**: 执行层 MUST 为单 queue `marketdata-sync`、concurrency=1、6 个 per-dimension named job（`sync:universe|profile|eod_bar|fundamental|financial|corporate_action`）；job payload MUST 含 `{dimensionKey, mode, asOf(YYYY-MM-DD 字符串), backfillHistoryDays?, maxEodInstruments?, triggeredBy: tick|cli|cascade}`（asOf MUST 为字符串防 JSON 序列化丢 Date）。MUST NOT 采用 per-instrument job（ADR-0049 拒绝项：5400 job/天反模式）。
- **FR-S07**: 维度失败 MUST 彼此隔离——任一维度 job 顶层异常 MUST NOT 阻塞无依赖关系的其余维度（016 失败连坐的修复）；既有 per-instrument try/catch + failedTargets 单标隔离 MUST 保留。
- **FR-S08**: `SyncDimension.retryMax` MUST 映射为 job 重试上限（BullMQ `attempts`）；retry 耗尽 MUST 触发硬失败告警（QueueEvents failed 监听），与 processor 内业务降级告警（alertIfDegraded）分工两道。
- **FR-S09**: 依赖编排 MUST 按 `sync_dependency` 在入队时现场组 flow（FlowProducer）：hard 边 = 上游失败下游不跑（failParentOnFailure）；soft 边 = 上游失败下游照跑（ignoreDependencyOnFailure）；依赖边 MUST 只约束**同一 tick 内共同触发**的维度——上游不 due 时边自动失效，下游当 flow 根照跑。
- **FR-S10**: SyncRun MUST 改 per-dimension 粒度（`syncType='sync:<dim>'` + `bullJobId` 关联）；旧 `'eod-sync'` 聚合行过渡期 MUST 并存不冲突，随清退片停写。审计真相 = SyncRun（PG），执行/重试真相 = BullMQ job（Redis）。
- **FR-S11**: 配额/窗口耗尽 MUST self re-enqueue with delay 续跑（取代「等明晚」）；`pendingEodInstruments` 进度锚 MUST 保证续跑幂等不重复；`lastWatermark` 降级为审计字段。
- **FR-S12**: Redis MUST 仅作执行队列（**非调度真相**）：job 丢失（驱逐/宕机）MUST 由 PG 真相层下轮 tick 发现并重新入队（自愈）。prod compose MUST 改 `maxmemory-policy noeviction` + `appendfsync everysec`；MUST 配 `removeOnComplete/removeOnFail` 限 job 留存 + 确认 quote 缓存键有 TTL（noeviction 下内存有界）。
- **FR-S13**: 执行层接入 MUST 为裸 `bullmq` + 手动 provider（MUST NOT 用 `@nestjs/bullmq` 装饰器 wrapper，per ADR-0049 拒绝项 / ADR-0043 手控风格）；队列连接 MUST 用独立 Redis 连接 provider（`maxRetriesPerRequest: null` 与共享 client 配置冲突）。
- **FR-S14**: 限频 MUST 保留传输层 `VendorRateLimiter`（进程内限频器；理杏仁走双窗令牌桶 36/s + 1000/min，富途 shim 走滚动窗，per [ADR-0047](../../docs/adr/0047-marketdata-pluggable-data-access.md) Amendment 2026-08-09）；MUST NOT 用 BullMQ rate limiter（单窗这两类约束都表达不了）。
- **FR-S15**: 系统 MUST 新建 trigger CLI（与 backfill 职责分开）：`--dimension X [--cascade] [--as-of]`——入队 + `waitUntilFinished`，退出码 MUST 反映 job 终态；`--cascade` MUST 从修复点为根查传递性下游组 flow、MUST NOT 含已成功上游。既有 backfill CLI MUST 迁「入队 + waitUntilFinished」形态且参数与退出码 **0/1** 语义不变；退出码 **2 重映射为等待超时**（旧「2=锁未抢到」随锁退出 CLI 路径作废，analyze I1 2026-06-04，release note 须提）；CLI 与自动 job MUST 经同 queue concurrency=1 天然互斥。
- **FR-S15a**: CLI MUST NOT 自起 worker——queue 全局唯一 worker MUST 在 server 进程（互斥不变量靠拓扑保证，clarify 2026-06-04）；CLI MUST 支持 `--timeout`（缺省值归 plan），server worker 不在线/超时 MUST 非 0 退出 + 可操作错误信息（不静默挂起）。backfill 的执行前提随之变为 server 在线（standalone 自跑管线语义废弃）。
- **FR-S16**: 新调度驱动 MUST 由 env flag `MARKETDATA_TICK_ENABLED` 控制且**默认关**；旧 22:00 管线过渡期 MUST 不下线；灰度并存期数据正确性 MUST 由幂等 + 过渡期保留的 Redis 调度锁（`EOD_SYNC_LOCK_KEY`）兜底（双拉只费配额不坏数据）。
- **FR-S17**: 清退片（最后一片，⚠️ 不可逆）MUST 删除：旧 `@Cron` 22:00 调度器 / `EodSyncPipeline.run()` / dimension-due 管线内过滤 / Redis 调度锁调度用法 / `'eod-sync'` 聚合行写入；该 PR MUST 标注「建议人工合并」（git-workflow 不可逆例外）。
- **FR-S18**: 既有维度同步 use case（SyncUniverse/SyncProfile 等）MUST 零改动复用——executor 从管线 fact 私有方法升格，业务语义（幂等 / 黑名单 / 双窗限频 / HTTP-out-of-tx）MUST 不变。
- **FR-S19**: 本 feature MUST NOT 新增读端点 / 改 OpenAPI 契约——纯调度层重构；无 `packages/api-client` regen、无 mobile 段。marketdata MUST 保持叶子 context（零跨 ctx 读，`check-server-moat` 0 violation）。

### Out-of-Scope Functional Boundaries

- ❌ 盘中实时 tick 摄取（master §B.4 seam；其实装时复审单 queue / concurrency=1 / 手动 provider 三决策，per ADR-0049 sunset trigger）
- ❌ 自动多天 backfill（misfire≠backfill 语义切分；理杏仁配额实测后可复审放宽为有界自动补，per ADR-0049 sunset trigger）
- ❌ 多节点分片 / 限频器外置（单节点 + 进程内令牌桶前提仍成立，per ADR-0047 F4）
- ❌ 管理界面（SyncDimension / sync_dependency CRUD UI 属更后续 feature）
- ❌ 监控面板 / 指标体系（V1 告警 = log 两道：业务降级 + retry 耗尽；面板后续）
- ❌ 重要度分级（016 已延后，与本 feature 无关）

## Key Entities

- **SyncDimension（扩展——调度真相层核心）**：016 既有配置行 + `nextFireAt`（下次触发时刻物化缓存，tick 扫描与抢占对象）+ `misfirePolicy`（`fire-now`|`skip-to-next`）。`cronExpr` 仍是调度真相，`nextFireAt` 仅物化；`retryMax` 终获消费者（→ job attempts）。
- **SyncDependency（新表——依赖编排真相）**：`{ upstream, downstream, mode(hard|soft) }`，唯一边 (upstream, downstream)。语义：只约束同一 tick 共同触发的维度。种子：`universe→*` 全 soft、`profile→fundamental` hard。
- **SyncRun（扩展——per-dimension 审计粒度）**：016 既有审计行 + `bullJobId`（PG 审计 ↔ Redis job 关联）；`syncType` 取值新增 `sync:<dim>` 形态，旧 `'eod-sync'` 聚合行过渡期并存。
- **BullMQ job（Redis——执行/重试真相，非持久调度真相）**：6 个 named job + payload（dimensionKey/mode/asOf 字符串/triggeredBy）；丢失可由 PG 层下轮 tick 自愈重建。

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: schema migration expand-only 落地（新列/新表/唯一键），016 既有 IT 全绿不动；seed 断言 `universe→*` 5 边全 soft + `profile→fundamental` hard。
- **SC-S02**: per-dimension 执行 IT 覆盖：单维度 job 落库 + per-dim SyncRun（syncType+bullJobId）/ 维度失败不连坐 / retryMax→attempts 重试 + 耗尽告警 / 配额顺延 self re-enqueue（`getDelayed` 断言不真等）。
- **SC-S03**: tick 调度 IT（控时：注入 now + 直接操纵 nextFireAt 列）覆盖：due 入队 + nextFireAt 推进 / **双 tick 并发恰好一次入队**（条件 UPDATE won/lost）/ fire-now 补一次 vs skip-to-next 只推进 / 非交易日组 flow 前短路 / flag=false 零副作用。
- **SC-S04**: 依赖编排 IT 覆盖：共同触发日 hard/soft 边语义（hard 断下游 / soft 放行）+ **周二 universe 不 due 时 eod_bar 当根照跑**（最高风险项专项）。
- **SC-S05**: 端到端控时 IT 模拟三场景：「周一 universe+全维度 flow」「周二 universe 缺席」「宕机重启 misfire catch-up」。
- **SC-S06**: CLI IT 覆盖：trigger 退出码语义（job 成功=0 / 失败=非 0 / 无 worker 超时=非 0+可操作信息）/ --cascade 传递性下游不含已成功上游 / 与自动 job 同 queue 互斥（CLI 不起 worker）/ backfill 迁入队后语义不变。
- **SC-S07**: Redis 自愈验证：人为清空队列后，**下一 due 周期**的 tick 重新入队该维度（PG 真相层自愈；已 claim 的当期触发不回溯，per clarify「won 后窗口接受」）；job 留存有界（removeOnComplete/removeOnFail 生效）。
- **SC-S08**: 灰度验收（prod）：`MARKETDATA_TICK_ENABLED=true` 后 SyncRun per-dimension 行连续 1-2 周正常 + Redis 内存稳定，期间旧管线并存零数据损坏。
- **SC-S09**: 清退验收：grep 零旧调度残留（旧 @Cron / EOD_SYNC_LOCK_KEY 调度用法 / 'eod-sync' 聚合写入）+ 全量 IT 在纯 tick+queue 形态下全绿。

## Assumptions

- **架构已定稿不重开**：分层（PG 真相层 + 裸 BullMQ 执行层）、拒绝项（Temporal / pg-boss / 自研 Quartz-lite / graphile-worker / per-instrument job / @nestjs/bullmq / BullMQ limiter / SaaS）、misfire≠backfill 切分均为 ADR-0049 Accepted 决策；本 spec 只验收行为。复审条件 = ADR-0049 sunset triggers（盘中实时 / DBOS 成熟 / 多节点需求 / 配额实测）。
- **单节点前提**（ADR-0047 F4）：vendor 限频封顶 → concurrency=1 + 进程内令牌桶；多实例场景由过渡期调度锁与幂等兜底（清退后单节点部署事实 + 条件 UPDATE 仍防多 tick）。
- **理杏仁配额未实测**：misfire 保守切分（fire-now 只补一次）是防烧配额的刻意约束；实测后可按 sunset trigger 放宽。
- **tick 频率 1 分钟**：每天 1440 次一条 updateMany 空扫极轻；22:00 精度 ±1min 可接受。
- **「won 后入队前崩溃」窗口显式接受**（clarify 2026-06-04）：毫秒级窗口 × 6 触发/天，期望丢失可忽略；调度可靠性目标是「无结构性丢失 + 可审计 + 可补救」而非两层架构下的绝对原子（绝对原子 = outbox 级复杂度，对本规模过度设计）。
- **Redis 256mb 充足**：6 job/天 + removeOnComplete/Fail 限留存；noeviction 风险由 quote 缓存 TTL 确认 + 内存监控缓解。
- **prod 现状**：`sync_dimension` 6 维度全 disabled、universe 启用在等本重构 + 0.4.0 发版——灰度片（SC-S08）与 prod universe enable 顺序衔接，归部署 runbook 不归本 spec。
- **测试范式沿用**：Testcontainers 真 PG+Redis（`marketdata.scheduler-lock.it.spec.ts` 蓝本），进程内 new Queue/Worker，afterAll close；控时 = 注入 now + 直接操纵 nextFireAt 列。
- **PR 切片按设计文档 §H4**（7 片渐进迁移）：切片是交付结构归 tasks/plan；spec 的 user story 与之对齐但以能力验收为准。

## Out of Scope（本 feature 不做）

- **盘中实时 tick 摄取**——master §B.4 seam；届时按 ADR-0049 sunset trigger 复审三决策。
- **自动多天 backfill**——misfire≠backfill；历史缺口走既有 backfill CLI 手动补。
- **多节点分片 / 限频器外置**——单节点前提仍成立（ADR-0047 F4）。
- **管理界面**——SyncDimension / sync_dependency CRUD UI 属更后续。
- **监控面板 / 指标体系**——V1 两道 log 告警（业务降级 + retry 耗尽硬失败）。
- **重要度分级**——016 已延后至 watchlist/holdings 落地，与本 feature 正交。
