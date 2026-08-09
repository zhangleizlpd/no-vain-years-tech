---
feature_id: 017-marketdata-scheduler
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-04'
updated_at: '2026-06-04'
adr_refs: ['0032', '0043', '0047', '0049']
context7_verified: ['bullmq']
---

# Implementation Plan: 017-marketdata-scheduler（PG 调度真相层 + 裸 BullMQ 执行层 — 失败隔离 / misfire / 依赖编排 / 手动+级联触发）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `017-marketdata-scheduler` | **设计源**: [ADR-0049](../../docs/adr/0049-marketdata-scheduler-bullmq-hybrid.md) + [设计文档 §H](../../docs/private/plans/2026-06/06-04-marketdata-scheduler-redesign.md) | **前置**: [016 同步管线](../016-marketdata-sync/spec.md)（演进其调度形态，维度同步逻辑零改动复用）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011/012/015/016）。
> **纯 server 调度重构流程**：spec ✅ → clarify ✅（3Q 2026-06-04：nextFireAt NULL 懒初始化 / CLI 永不起 worker / won-后崩溃窗口显式接受）→ **plan（本）** → tasks → analyze → implement。**无 mockup / 无 mobile 段 / 无新 HTTP 端点**。验证全走 Testcontainers IT（真 PG+Redis）+ 控时注入。
> **架构不重开**：分层 / 拒绝项 / misfire≠backfill 已 ADR-0049 Accepted；本 plan 只做工程落地决策（D1-D9）。
> **⚠️ plan Phase 0 撞到一个 spec 机制级缝（D3）**：context7 实证 **BullMQ flow 是单亲树**（一个 job 只能有一个 parent）——`sync_dependency` 的「universe 单源 5 下游」DAG 不可直接表达，FR-S09 的 soft 边机制需按 D3 装配规则消解（语义等价，机制微调），请 plan→tasks gate review。

## Summary _(mandatory)_

017 = **016 调度形态重构**（业务同步语义不变）。交付（按 §H4 七片）：① **执行基础设施**——`bullmq` 依赖（D1）+ `docker-compose.tight.yml` Redis `allkeys-lru → noeviction` + `appendfsync everysec`（appendonly 已开，实证 L72-74）+ marketdata 内队列专用连接 provider（`maxRetriesPerRequest: null`，context7 验证 Worker 硬要求）。② **PG 真相层 schema expand**——`SyncDimension` + `nextFireAt`/`misfirePolicy`、`SyncRun` + `bullJobId`、新表 `SyncDependency` + migration seed 6 边（`universe→*` 全 soft / `profile→fundamental` hard，raw SQL `ON CONFLICT DO NOTHING`，016 D3 先例）。③ **executor 抽取 + worker**——`EodSyncPipeline` 4 个 fact 私有方法（`syncEodBars/syncFundamentals/syncFinancials/syncCorporateActions`，L251-513）+ universe/profile use case 升格 per-dimension executor 注册表；裸 `new Worker`（单 queue `marketdata-sync`、concurrency=1、6 named job）手动 provider；per-dim SyncRun（`sync:<dim>` + bullJobId）；`retryMax`→`attempts`；配额顺延 self re-enqueue（D5）。④ **SyncTickDriver**——分钟级 `@Cron` 无状态 tick：NULL 懒初始化（clarify Q1）→ 条件 UPDATE 抢占（playbook affected-count 范式）→ 交易日 gate → FlowProducer 组 flow（D3）；`MARKETDATA_TICK_ENABLED` 默认关。⑤ **trigger CLI**（新）+ backfill CLI 迁入队（入队 + `waitUntilFinished` + `--timeout`；CLI 永不起 worker，D6 sentinel）。⑥ **灰度**（flag 开新旧并存 1-2 周）。⑦ **清退**（删旧 `@Cron` 22:00 / `EodSyncPipeline.run()` / `dimension-due.ts` / `EOD_SYNC_LOCK_KEY` 调度用法 / `'eod-sync'` 聚合行写入——⚠️ 不可逆，人工合并）。

**范式** = ADR-0043 扁平贫血手控 provider（RedisSyncLock 先例）+ ADR-0049 分层。**out of scope**：盘中实时 / 自动多天 backfill / 多节点分片 / 管理界面 / 监控面板（spec Out-of-Scope 6 项）。

## API Contracts _(mandatory)_

**无新 HTTP 端点 / 无 OpenAPI 契约变更**（FR-S19）——纯调度层重构。无 `packages/api-client` regen、无 mobile 段、无 Constitution §V 类型同步链触发。

命令面 = 2 个 CLI（运维手调，非 HTTP；均「入队 + `waitUntilFinished`」，CLI 永不起 worker per clarify Q2）：

| # | 形态 | 入口 | 参数 | 行为 | trace FR |
| --- | --- | --- | --- | --- | --- |
| CLI1 | **trigger CLI（新）** | `nx run server:marketdata-trigger`（→ `node dist/marketdata/marketdata-trigger.cli.js`） | `--dimension <key>` `[--cascade]` `[--as-of YYYY-MM-DD]` `[--timeout ms]` | 入队该维度 job（cascade = 按 `sync_dependency` 传递性下游组 flow，不含已成功上游）→ `waitUntilFinished` | FR-S15/S15a |
| CLI2 | **backfill CLI（改形态）** | `nx run server:marketdata-backfill`（既有 target，project.json L121） | 既有 `--dimension --history-depth --dry-run --markets --as-of` 不变 + 新 `[--timeout ms]` | `--dry-run` 仅估算打印（不入队，逻辑不变）；非 dry-run 改入队 `{mode:'backfill', ...}` + 等待（**不再抢 Redis 锁**，互斥由 queue 承载） | FR-S15/S15a |

**退出码**（两 CLI 统一）：`0` = job 成功；`1` = job 失败/partial；`2` = 等待超时（含 server worker 不在线，打可操作错误信息）。⚠️ 与 016 backfill 旧 `2=锁未抢到` 语义重映射（锁退出 CLI 路径），release note 须提。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（v1.2.1） | 状态 | 备注 |
| --- | --- | --- |
| I. SDD | ✅ | spec ✅ → clarify ✅（3Q）→ plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点（⚠️ D3/D6/D7 重点 review） |
| II. Test-First TDD | ✅ | 25 条 state_branches 各有 IT；蓝本 = `marketdata.redis-sync-lock.it.spec.ts` + `marketdata.eod-scheduler.it.spec.ts`（真 PG+Redis 容器、进程内 `new Queue/Worker`、afterAll close）；控时 = 注入 now + 直接操纵 nextFireAt 列；`getDelayed` 断言不真等 |
| III. Atomic 30min-2h | ✅ | tasks 按 §H4 七片拆；每片独立 PR（见 § Phase 2） |
| IV. Module Boundary | ✅ | marketdata 仍**叶子 ctx**（零跨 ctx 读写）；队列连接 provider 落 marketdata 内（非 security——marketdata 专用基础设施，手控 provider 贴 RedisSyncLock 先例）；`check-server-moat` 新登记 `syncDependency: 'marketdata'`（1 个新 model） |
| V. 类型同步链 | ✅ | 无端点 → 不触发（FR-S19） |

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| `bullmq`（^5，唯一新依赖；`pnpm -C apps/server add bullmq`） | 执行层 Queue/Worker/FlowProducer/QueueEvents（ADR-0049 Decision 1） | context7 `/taskforcesh/bullmq`（2026-06-04 session：flows fail-parent / ignore-dependency / connections 三页验真）+ docs.bullmq.io |
| 队列专用 `new Redis(url, { maxRetriesPerRequest: null })` | bullmq Worker 阻塞连接硬要求，与共享 `REDIS_CLIENT`（security.module L37 默认配置）冲突 → 独立实例 | context7 connections.md：「If you create a Redis client manually, Bull will throw an exception if this setting is not set to null」；可单实例共享给 Queue/Worker（bullmq 内部为阻塞命令自行 duplicate） |

**新依赖 6Q**（Gate 0.2 压缩版）：Q1 维护信号 = taskforcesh 活跃商业维护（Pro 版反哺 OSS）、npm 周下载百万级 ✅；Q2 已装工具可替？——`@nestjs/schedule` 无队列/依赖编排能力，自研被 ADR-0049 拒 ✅；Q3 栈兼容 = 纯 Node + ioredis（已装 ^5.10），零 native binding ✅；Q4 LLM 覆盖 = 训练语料充分 + context7 可查 ✅；Q5 解耦成本 = executor 注册表与队列接线分离，换执行层只动 worker/tick 两文件（~2 周）✅；Q6 风险 = MIT、国内无访问问题（lib 本地跑）、无已知 CVE ✅。

## Architecture Notes _(mandatory)_

### Bounded Context 决策（catalog 7Q）

与 016 相同：Q1 marketdata 自有（写自己的表 + 1 新表）；Q2-Q4 No；Q5-Q7 无跨 ctx 传播——**叶子 ctx 不变**。唯一跨 module 依赖仍 = `SecurityModule` 的 `PrismaService`（platform infra，ADR-0041 例外）。队列连接**不复用** `REDIS_CLIENT`（D1 配置冲突）→ marketdata 内新手控 provider `MARKETDATA_QUEUE_REDIS`（含 `OnModuleDestroy` close，镜像 security `RedisLifecycle` 形态）。

### 关键设计

1. **PG 真相层（schema expand-only + seed）**：spec FR-S01/S02 + §H3 草案照落。seed = migration raw SQL idempotent（016 D3 先例）：6 边 + `misfirePolicy` 默认 `'fire-now'`；**不回填 `nextFireAt`**（clarify Q1：NULL = 未物化哨兵）。`EodSyncPipeline` 内 `SyncDimensionRow` Pick 类型（L532-540）现缺 `retryMax`/`enabled` —— executor/tick 侧用自己的投影，不动旧管线类型。
2. **SyncTickDriver**（新文件 `sync-tick-driver.ts`）：`@Cron(EVERY_MINUTE)` 静态表达式（`eod-sync.scheduler.ts` L11 注释先例：装饰器表达式必须静态）+ 起手 flag 短路（`tickEnabled` 默认 false）。每 tick 三步，全部 playbook「conditional UPDATE affected-count」范式（READ COMMITTED，NEVER FOR UPDATE）：
   - **(a) NULL 懒初始化**：`findMany({enabled:true, nextFireAt:null})` → 逐行 `cron-parser` 算 next-future（`Asia/Shanghai`，复用 dimension-due.ts 已验证范式）→ `updateMany({where:{id, nextFireAt:null}, data:{nextFireAt:next}})`（本轮不入队，FR-S03a）。
   - **(b) 抢占 claim**：`findMany({enabled:true, nextFireAt:{lte:now}})` → 逐行 `updateMany({where:{id, nextFireAt:<观测值>}, data:{nextFireAt: computeNext(cronExpr, now)}})` → `count===1` won / `0` lost。**`computeNext` 必须 from `now` 而非 from 旧 nextFireAt**——否则宕机多天会逐 tick 逐天补跑，违反 misfire≠backfill（FR-S04 的实现承重点，专项 IT）。
   - **(c) won 集处理**：`misfirePolicy==='skip-to-next'` 且观测值已过期超一个周期 → 仅推进不入队？**否**——更简语义：skip-to-next won 行**一律不入队**只推进；fire-now won 行经**交易日 gate**（市场级短路，零 vendor 调用；非交易日 → 不组 flow，nextFireAt 已推进）→ D3 装配入队（`asOf = shanghaiToday(now)`，payload 字符串防 Date 序列化丢失）。正常按时触发与 misfire catch-up 在 fire-now 下是同一条路径（「本该跑的那次 = delta 拉当天」），无需区分过期深度。
3. **D3 — flow 装配（DAG→单亲树消解，⚠️ gate review 重点）**：context7 实证 BullMQ flow 单亲树，`sync_dependency` 是 DAG（universe 1 源 5 下游 + profile→fundamental）→ 装配规则：
   - **维度全序**（执行序）调整为 `universe → profile → fundamental → financial → eod_bar → corporate_action`——使唯一 hard 边（profile→fundamental）**链相邻**（016 旧序 eod_bar 插在中间会让 hard 失败传播绕不过去；eod_bar 与 fundamental 间无边，重排无语义影响）。
   - **树形** = won 集按全序构**嵌套链**（后继为 parent、前驱为 child）：`corporate_action(root) ← eod_bar ← financial ← fundamental ← profile ← universe`。每条 child-edge 的 opts：真实边存在 → `hard=failParentOnFailure:true / soft=ignoreDependencyOnFailure:true`；**无真实边 → `ignoreDependencyOnFailure:true`（纯执行序，失败不传播）**。⚠️ context7 验真：child 无 opts 时 parent 会**永久卡 `waiting-children`** —— 装配器必须给每个 child 显式二选一 opts（IT 断言全树无裸 child）。
   - **语义核对**（对照 spec FR-S09）：universe 失败 → profile child-opts=ignore → 全下游照跑 ✓（soft）；profile 失败 → fundamental failParent 失败 ✓（hard）→ financial 对 fundamental-child 是 ignore（无真实边）→ financial 照跑 ✓；universe 不 due（周二）→ 不在 won 集 → 链从 profile/eod_bar 起构，下游当根照跑 ✓。
   - **soft 边的「等待」语义**由链嵌套（parent 等 children 终态）+ 单 queue concurrency=1 承载——与 spec「ignoreDependencyOnFailure」机制字面一致，仅挂接位置从「真实边」泛化到「链相邻」。**装配器对无法表达的拓扑（环 / 未来 admin 加边破坏链相邻 hard）必须 throw + 告警，禁静默错装**；任意 DAG 装配 = 管理界面 feature 的 seam。
4. **executor 抽取**（新文件 `dimension-executor.ts`）：4 个 fact 私有方法 + `SyncUniverseUseCase`/`SyncProfileUseCase` 包装升格为 `Map<DimensionKey, executor>`；每 executor 自管 per-dim SyncRun（`syncType='sync:<dim>'`、起手 `start()` 带 `bullJobId`）；业务语义（幂等 / per-instrument try/catch / 双窗限频 / HTTP-out-of-tx / 复权重取 / `alertIfDegraded` per-dim 化）**零改动平移**。`EodSyncPipeline.run()` 过渡期改为内部调用同一批 executor（写旧 `'eod-sync'` 聚合行逻辑保留），行为不变（016 IT 全绿是回归门）。
5. **worker**（新文件 `marketdata-sync.worker.ts`，手控 provider）：`new Worker('marketdata-sync', processor, {connection, concurrency:1})`；processor 按 `job.name`（`sync:<dim>`）路由 executor；`attempts` 在入队时从 `SyncDimension.retryMax` 注入 + `backoff {type:'exponential', delay: 60_000}`（D4）；`removeOnComplete/removeOnFail` 按 config 限留存（D8）。`QueueEvents` `failed` 监听（仅 server）→ 结构化 ERROR log（retry 耗尽硬失败告警，与 executor 内业务降级告警分工）。**启停门**：`OnModuleInit` 启动，CLI sentinel（D6）置位时 no-op；`OnModuleDestroy` close（Queue/Worker/QueueEvents/FlowProducer 全关，IT afterAll 范式）。
6. **配额顺延 self re-enqueue**（D5）：executor 检测预算耗尽（016 `maxEodInstruments`/令牌桶语义不变）→ processor 以**standalone delayed job** 重新入队同 named job（不进 flow——续跑只关己；delay = config `requeueDelayMs`）；`pendingEodInstruments`（L320-331）进度锚不变；deferral 不是失败，不消耗 attempts。`lastWatermark` 照写（降级审计）。
7. **trigger CLI**（新文件 `marketdata-trigger.cli.ts`，镜像 backfill CLI 的「纯逻辑 execute + NestFactory 接线 + argv[1] entry-guard」三段式，L20-21/L138-142 先例）：`--cascade` = 从修复点查 `sync_dependency` 传递性闭包（递归 CTE 或内存 BFS——6 行表内存 BFS 即可）→ won 集 = {root + 闭包}，复用 D3 装配器组 flow；**不含已成功上游**（cascade 只往下游走，天然满足）。`waitUntilFinished(queueEvents, timeoutMs)` 超时 → exit 2。
8. **backfill CLI 迁入队**：`executeBackfill` 保 dry-run 估算逻辑；非 dry-run 段删抢锁（L82-86）改入队等待。**过渡期缝**：CLI 不再持锁、旧 22:00 管线仍持锁 → CLI job 与旧管线可能并发双拉——与灰度并存同一风险面，幂等兜底只费配额（D7 显式接受，IT 不需覆盖此组合）。
9. **misfire/自愈闭环**：Redis job 丢失 → PG `nextFireAt` 已推进，**当期不自愈**（clarify Q3 接受窗口），下一周期照常触发；Redis 整体丢失（flush）后 due 行为由 (b) claim 正常驱动 = SC-S07 的「下轮 tick 重新入队」语义锚定在「下一个 due 周期」而非「下一分钟」。
10. **Cross-cutting（落地必带）**：
    - `check-server-moat.ts` `MODEL_OWNER` + `syncDependency: 'marketdata'`。
    - `marketdata.config.ts` `MarketdataSyncConfigSchema` 增：`tickEnabled`（`MARKETDATA_TICK_ENABLED`，default false）/ `requeueDelayMs`（default 30min）/ `cliWaitTimeoutMs`（default 4h，backfill 长跑）/ `removeOnCompleteCount`（default 200）/ `removeOnFailCount`（default 500）。
    - `docker-compose.tight.yml` L66 `allkeys-lru → noeviction` + 增 `--appendfsync everysec`；`infrastructure/docker-compose.yml` redis 段（无显式 args，L67）同步补齐。**前置核验 task**：quote 缓存键有 TTL（noeviction 下无驱逐兜底）——grep `eod-backed-quote` 缓存写入 + IT 断言 TTL>0。
    - `project.json` 增 `marketdata-trigger` target（镜像 L121 backfill target）。
    - 模块注册：`marketdata.module.ts` providers + `ScheduleModule` 已全局注册（无新接线）。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| # | 决策 | 选定 | 理由 / 备选 |
| --- | --- | --- | --- |
| D1 | bullmq 连接形态 | 单 `new Redis(url, {maxRetriesPerRequest: null})` 实例共享给 Queue/Worker/QueueEvents/FlowProducer（手控 provider + lifecycle close） | context7：Worker 硬要求该设置为 null（否则 throw）；bullmq 对阻塞命令内部 duplicate → 单实例够。备选 per-组件独立连接 = 无收益多连接 |
| D2 | tick 抢占 SQL 形态 | `findMany` 候选 → 逐行 `updateMany where {id, nextFireAt:<观测值>}`（affected-count won/lost） | playbook 钦定范式（READ COMMITTED）；观测值相等条件防「双 tick 同 claim」；逐行独立（单维度 claim 失败不影响其余）。`computeNext` from now（misfire≠backfill 承重点） |
| D3 | ⚠️ **DAG→单亲树装配** | 维度全序重排（profile/fundamental 链相邻）+ won 集嵌套链树 + 真实边落 opts / 无边 child 一律显式 `ignoreDependencyOnFailure` + 不可表达拓扑 throw | BullMQ flow 单亲树（context7 实证）→ universe 多下游 soft 边不可直表；嵌套链在当前 seed 拓扑下语义等价（逐边核对见 Architecture §3）；任意 DAG 装配留 admin seam。备选「processor 内自查上游状态」= 重新发明编排，违 ADR-0049 |
| D4 | retry backoff | `attempts = SyncDimension.retryMax`（入队时注入）+ `backoff {exponential, 60s}` | retryMax 终获消费者（FR-S08）；指数退避防 vendor 瞬时故障下密集重打；60s 起步在「夜间窗口」尺度合理。备选固定间隔——无明显优势 |
| D5 | ⚠️ 配额顺延 re-enqueue delay | standalone delayed job（不进 flow）+ `requeueDelayMs` default **30min** | 双窗令牌桶分钟级恢复但**日配额**耗尽需长等；30min 折中（一夜最多 ~16 次续跑尝试，空转成本 = 一次 pending 查询）；config 可调。deferral ≠ failure（不耗 attempts） |
| D6 | ⚠️ CLI 禁 worker 机制 | CLI entry 在 `createApplicationContext` 前置 `process.env.MARKETDATA_WORKER_DISABLED='1'`；worker provider `OnModuleInit` 检 sentinel no-op | clarify Q2「CLI 永不起 worker」的落地——AppModule 被 CLI 复用（backfill L117 先例），不 fork module 树（最小侵入）。备选独立 CliModule 不含 worker = module 树分叉维护贵 |
| D7 | ⚠️ 过渡期 CLI 与旧管线并发 | 接受（幂等兜底，只费配额）——CLI 迁入队后不再抢 `EOD_SYNC_LOCK_KEY`，与旧 22:00 管线无互斥 | 与灰度并存（PR-6）同一风险面同一兜底；为过渡期保留 CLI 抢锁 = 把要清退的锁语义又织进新 CLI（PR-7 还得拆）。窗口 = PR-5 合入到 PR-7 清退之间 |
| D8 | job 留存 | `removeOnComplete {count:200}` / `removeOnFail {count:500}`（config 可调） | 6-12 job/天 → 200 完成 ≈ 3 周窗口；fail 留多些供排障；noeviction 下 Redis 内存有界（FR-S12） |
| D9 | processor 端交易日 gate | **不重复 gate**——gate 只在 tick 层（组 flow 前）；CLI 触发视为运维显式意图（`--as-of` 指向已结算交易日，backfill L63-65 先例注释） | spec FR-S05 gate 归 tick 层；processor 再 gate 会挡掉运维补数据场景。非交易日手动 trigger delta = 拉空/旧数据，幂等无害 |

## Complexity Tracking

| 复杂点 | 必要性 | 控制手段 |
| --- | --- | --- |
| 双层真相（PG 调度 + Redis 执行） | ADR-0049 核心决策（可恢复调度 + 成熟执行层） | 角色铁律单向：Redis 丢失由 PG 下周期自愈；audit=SyncRun(PG)、retry=job(Redis)，不混 |
| DAG→树装配器（D3） | BullMQ 单亲树 vs 依赖 DAG 的客观缝 | 只支持「链相邻 hard + 嵌套 ignore」形态 + 不可表达 throw；~60 行纯函数 + 穷举 IT；任意 DAG 留 seam |
| tick 三步状态机（NULL/claim/组 flow） | misfire + 懒初始化 + 防双 tick 三需求交汇 | 全 playbook conditional-UPDATE 范式（无锁无事务嵌套）；控时 IT 穷举 state_branches |
| 过渡期双调度并存 | 渐进迁移（旧管线不下线直到 PR-7） | flag 默认关 + 幂等 + 过渡期保留旧锁；灰度 1-2 周 prod 观察后才清退 |

无 Constitution 违反需 justify。

## Performance Budget

无 HTTP 端点 → 无 request-latency budget。调度层开销目标（observability 参考，非硬门禁）：

- **tick 空扫**（无 due 维度）：1 `findMany`（6 行表）< 5ms；每天 1440 次 ≈ 零负载。
- **tick 触发日**：+6 次逐行 conditional UPDATE + 1 次 FlowProducer.add < 100ms。
- **Redis 内存**：job 留存（D8）+ 6-12 job/天 → queue 占用 < 1MB；256mb 实例无压力（监控项：灰度期 `INFO memory` 周检）。
- **22:00 精度**：±1min（tick 周期），spec Assumptions 已接受。

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略（七片渐进迁移，对齐 §H4；每片独立可逆直到 PR-7）

| PR | 范围 | 验证门 |
| --- | --- | --- |
| **PR-1** | `bullmq` 依赖 + compose Redis policy/fsync（tight + infrastructure stub 双文件）+ `MARKETDATA_QUEUE_REDIS` 连接 provider + quote 缓存 TTL 核验 | provider boot IT（与共享 client 互不干扰）+ compose 配置断言 + TTL 断言 |
| **PR-2** | schema expand（nextFireAt/misfirePolicy/bullJobId/SyncDependency）+ seed 6 边 + moat 登记 | migrate deploy IT + seed 断言（universe→* 全 soft / profile→fundamental hard）+ 016 既有 IT 全绿（expand-only 回归门） |
| **PR-3** | `dimension-executor.ts` 抽取 + `marketdata-sync.worker.ts`（不注册 tick）+ per-dim SyncRun + retry/告警 + 配额顺延 re-enqueue（D5） | 手动入队单维度 IT（落库 + SyncRun + bullJobId）/ 失败不连坐 / retry 耗尽告警 / `getDelayed` 顺延断言 / 旧 `run()` 行为回归 |
| **PR-4** | `sync-tick-driver.ts`（NULL 懒初始化 + claim + gate + misfire 双策略）+ D3 装配器 + flag 默认关 | 控时 IT：due 入队 / 双 tick 恰好一次 / fire-now vs skip-to-next / NULL 不补跑 / 非交易日短路 / flag=false 零副作用 / **周二 universe 缺席 eod_bar 当根照跑**（最高风险专项）/ 装配器树形+裸 child 断言 |
| **PR-5** | `marketdata-trigger.cli.ts`（--cascade + --timeout）+ backfill CLI 迁入队 + `marketdata-trigger` nx target | CLI 退出码 IT（0/1/2 三态）/ cascade 闭包断言 / dry-run 不入队 / sentinel 禁 worker 断言 |
| **PR-6** | 灰度：prod `MARKETDATA_TICK_ENABLED=true`，新旧并存观察 1-2 周 | prod SyncRun per-dim 行连续正常 + Redis 内存稳定（SC-S08，非 IT）；衔接 0.4.0 发版 + universe enable 顺序归部署 runbook |
| **PR-7** | ⚠️ 清退：删旧 `@Cron` 22:00 / `EodSyncPipeline.run()` / `dimension-due.ts` / `EOD_SYNC_LOCK_KEY` + `RedisSyncLock` 调度用法 / `'eod-sync'` 聚合行写入。**不可逆，PR 标「建议人工合并」** | grep 零残留断言 + 全量 IT 纯 tick+queue 形态全绿（SC-S09） |

### tasks 拆分锚点

- 每 task 30min-2h、TDD 红绿、绑定 state_branches IT；新 spec 文件首跑 `--skip-nx-cache`；IT 经 `nx test server <file>`（cwd=apps/server）。
- IT 蓝本**真名** = `marketdata.redis-sync-lock.it.spec.ts` + `marketdata.eod-scheduler.it.spec.ts`（设计文档 §H5 写的 `scheduler-lock` 是误称，已实证纠正）。
- **spec drift 锚点**（impl 前 grep 验，per memory `sdd_spec_drift_anchors`）：① `EOD_SYNC_LOCK_KEY` 定义在 `eod-sync.scheduler.ts` L9 且被 backfill CLI import（L7）——PR-5 改 CLI 时解开 import、PR-7 才删常量；② `EodSyncPipeline` 私有方法签名（L251/334/384/426）= executor 抽取的搬运面；③ `SyncDimensionRow` Pick 类型（L532）缺 `retryMax`/`enabled`——executor 投影自己扩；④ bullmq flows 子节点裸 opts = parent 永久 waiting-children（context7 验真，装配器 IT 必断言）；⑤ `@Cron` 静态表达式限制（L11-14 注释先例）——tick 用 `EVERY_MINUTE` 常量 + flag 短路而非动态注册；⑥ compose 真名 `docker-compose.tight.yml`（非 `infrastructure/docker-compose.yml`，后者是 stub 同步改）。
- 模板：手控 provider = `RedisSyncLock` / security `RedisLifecycle`（L33-41）；CLI 三段式 = `marketdata-backfill.cli.ts`；控时 cron 计算 = `dimension-due.ts`（cron-parser + Asia/Shanghai）。

### Out of Scope 再确认（→ 后续 feature / seam）

盘中实时 tick 摄取（ADR-0049 sunset trigger）/ 自动多天 backfill（配额实测后复审）/ 任意 DAG 装配 + 管理界面 / 多节点分片 / 监控面板。
