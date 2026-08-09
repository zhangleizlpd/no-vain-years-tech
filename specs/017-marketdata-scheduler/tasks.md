---
feature_id: 017-marketdata-scheduler
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-04'
---

# Tasks: 017-marketdata-scheduler（PG 调度真相层 + 裸 BullMQ 执行层 — 失败隔离 / misfire / 依赖编排 / 手动+级联触发）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `017-marketdata-scheduler`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 执行基础设施 / US2 真相层 schema+种子边 / US3 executor+worker / US4 SyncTickDriver / US5 依赖编排 / US6 trigger+backfill CLI / US7 灰度+清退）；Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Verify]`（纯 server 调度重构，无新端点 → 无 [Contract]/[Mobile]，FR-S19）
- **Phase = PR 交付单元**（plan §Phase 2 七片渐进迁移；旧管线过渡期不下线；PR-7 不可逆人工合并）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；tick/worker/flow = **Testcontainers PG+Redis**（蓝本 `marketdata.redis-sync-lock.it.spec.ts` + `marketdata.eod-scheduler.it.spec.ts`，进程内 `new Queue/Worker`、afterAll close 全队列对象；run via `nx test server <file>`，cwd=apps/server）；纯函数（computeNext / flow 装配器 / argv 解析）= vitest 无容器；控时 = **注入 now + 直接操纵 nextFireAt 列**；顺延断言走 `getDelayed`（不真等）
- 无 task-meta JSON（manual 模式，per 004-016）
- **架构已定稿不重开**（ADR-0049）：本 tasks 只落 plan D1-D9 工程决策；**D3 装配器 = DAG→单亲树消解**（BullMQ flow 单亲树 context7 实证；维度全序 `universe→profile→fundamental→financial→eod_bar→corporate_action` 使 hard 边链相邻；裸 child = parent 永久 waiting-children，装配器必须给每 child 显式 opts）
- **clarify 三裁决**（2026-06-04，实现承重点）：① nextFireAt NULL=未物化哨兵 + tick 懒初始化（不补跑）；② CLI 永不起 worker（D6 sentinel `MARKETDATA_WORKER_DISABLED`）+ `--timeout` 非 0 退出；③ tick won 后入队前崩溃 = 接受窗口（不加机制，IT 不覆盖）
- **新 dep（唯一）**：`bullmq`（plan 6Q + context7 `/taskforcesh/bullmq` 已验真：fail-parent / ignore-dependency / connections `maxRetriesPerRequest: null` 硬要求）
- **misfire≠backfill 承重点**：`computeNext` 必须 from `now`（非 from 旧 nextFireAt）——否则宕机多天逐 tick 逐天补跑（FR-S04 专项 IT）
- **7 段 PR（均纯 server）**：**PR-1**（T001–T004 基础设施）→ **PR-2**（T005–T007 schema+seed）→ **PR-3**（T008–T011 executor+worker）→ **PR-4**（T012–T016 tick+编排）→ **PR-5**（T017–T019 CLI）→ **PR-6**（T020 灰度 ops）→ **PR-7**（T021–T022 清退 ⚠️ 不可逆）。无端点 → 无 api-client regen

## Path Conventions

- server：`apps/server/src/marketdata/`（ADR-0043 扁平平铺）；schema `apps/server/prisma/schema.prisma`；config `apps/server/src/config/marketdata.config.ts`（`MarketdataSyncConfigSchema` 段增量）；migration `apps/server/prisma/migrations/`（**expand-only** + `migration_refs` frontmatter，ADR-0035）；IT `apps/server/test/integration/marketdata.*.it.spec.ts`
- compose：**`docker-compose.tight.yml`**（部署版，Redis args L60-74）+ `infrastructure/docker-compose.yml`（stub 同步）
- 复用/模板：手控 provider = `redis-sync-lock.ts` / security `RedisLifecycle`（security.module.ts L33-41）；CLI 三段式 = `marketdata-backfill.cli.ts`（纯逻辑 execute + NestFactory 接线 + argv[1] entry-guard）；cron 计算 = `dimension-due.ts`（cron-parser + Asia/Shanghai）；executor 搬运面 = `eod-sync-pipeline.ts` 私有方法（L251 syncEodBars / L334 syncFundamentals / L384 syncFinancials / L426 syncCorporateActions）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + migrate deploy（mbw-poc-postgres:5433 / redis:6380）；本地 IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`

---

## Phase 1: PR-1 — 执行基础设施（bullmq + Redis 可靠性 + 队列连接 provider）（US1）

**PR-1 Independent Test**: ① compose 断言 noeviction + appendfsync everysec；② Testcontainers Redis：队列连接 provider boot、与共享 `REDIS_CLIENT` 互不干扰、no-op job 入队→处理 roundtrip；③ job 完成后按留存上限清理。**可独立 ship**（纯基建，不动任何业务路径）。

- [X] T001 [US1] [Server] **新依赖 `bullmq`**：`pnpm -C apps/server add bullmq` + lockfile → verify: `pnpm -C apps/server install --frozen-lockfile` 绿 + vitest 一行 smoke（`new Queue('smoke', {connection})` 构造形态，不连真 Redis 即可 import 验型）
- [X] T002 [US1] [Server] **队列专用 Redis 连接 provider（D1）**：`apps/server/src/marketdata/marketdata-queue-connection.ts`（手控 provider `MARKETDATA_QUEUE_REDIS` = `new Redis(cfg.url, { maxRetriesPerRequest: null })`，镜像 security `RedisLifecycle` 的 `OnModuleDestroy` close；**不复用** `REDIS_CLIENT`——bullmq Worker 硬要求该设置为 null 与共享 client 默认配置冲突，context7 验真）+ `marketdata.module.ts` 注册 → verify（Testcontainers Redis）: provider 解析成功 + 与 `REDIS_CLIENT` 双连接并存互不干扰（锁 acquire 照常）。run via `nx test server <file>` `--skip-nx-cache`
- [X] T003 [P] [US1] [Server] **compose Redis 可靠性改造 + quote 缓存 TTL 核验**：`docker-compose.tight.yml` L66 `allkeys-lru → noeviction` + redis command 增 `--appendfsync everysec`（`--appendonly yes` 已在 L72-74）；`infrastructure/docker-compose.yml` redis 段（L66-76 无显式 args）同步补齐同 5 参（maxmemory 256mb/noeviction/appendonly/appendfsync）；**前置核验**：grep `eod-backed-quote` 等 Redis 缓存写入点确认全部带 TTL（noeviction 下无驱逐兜底，FR-S12）→ verify: `docker compose -f docker-compose.tight.yml config` 含 noeviction+everysec 断言（脚本/grep）+ 缓存写入 `set ... EX` 形态 grep 全命中
- [X] T004 [US1] [Server-IT] **PR-1 集成 IT**（Testcontainers Redis）：`apps/server/test/integration/marketdata.queue-infra.it.spec.ts` —— 队列连接 provider + 进程内 `new Queue/Worker` no-op job 入队→处理 roundtrip + `removeOnComplete {count}` 留存清理断言（完成 job 超限被清）+ afterAll close 全对象。run via `nx test server <file>` `--skip-nx-cache`

---

## Phase 2: PR-2 — PG 真相层 schema expand + 种子依赖边（US2）

**PR-2 Independent Test**: Testcontainers PG；① migrate deploy → 新列/新表/唯一键落地且 **016 既有 IT 全绿**（expand-only 回归门）；② seed 断言 `universe→*` 5 边全 soft + `profile→fundamental` hard（FR-S02 第一道拦截）；③ 重复边唯一约束拒绝；④ `nextFireAt` 全 NULL（不回填，clarify Q1）。

- [X] T005 [US2] [Server] **schema expand + seed**：`apps/server/prisma/schema.prisma` —— `SyncDimension` 增 `nextFireAt DateTime? @map("next_fire_at") @db.Timestamptz(6)` + `misfirePolicy String @default("fire-now") @map("misfire_policy") @db.VarChar(16)`；`SyncRun` 增 `bullJobId String? @map("bull_job_id") @db.VarChar(64)`；新 model `SyncDependency`（§H3 草案照落：upstream/downstream/mode + `@@unique([upstream,downstream], map: "uk_sync_dependency_edge")` + `@@map("sync_dependency")` + `@@schema("marketdata")`）。migration **expand-only** + raw SQL seed `INSERT INTO marketdata.sync_dependency ... ON CONFLICT DO NOTHING` **6 边**（`universe→{profile,eod_bar,fundamental,financial,corporate_action}` mode='soft' ×5 + `profile→fundamental` mode='hard'；016 D3 先例）；**不回填 nextFireAt**（NULL=未物化哨兵）+ `migration_refs` frontmatter + `prisma generate` → verify: Testcontainers migrate deploy + 新列/表断言 + seed 6 边 mode 断言 + nextFireAt 全 NULL 断言
- [X] T006 [P] [Server] **moat 登记新 model owner**：`scripts/checks/check-server-moat.ts` `MODEL_OWNERSHIP` 增 `syncDependency: 'marketdata'` → verify: `pnpm tsx scripts/checks/check-server-moat.ts` 关 + `nx lint server` 0 violation
- [X] T007 [US2] [Server-IT] **PR-2 集成 IT + 016 回归门**：`apps/server/test/integration/marketdata.schema-017.it.spec.ts`（migrate deploy + seed 边 mode 穷举断言 + 重复边唯一约束拒绝 + 既有行 nextFireAt NULL）+ 跑 016 既有 marketdata IT 套件全绿（`nx test server` marketdata.* 全套，expand-only 回归证据）。run via `nx test server <file>` `--skip-nx-cache`

---

## Phase 3: PR-3 — per-dimension executor 抽取 + worker processor（不注册 tick）（US3）

**PR-3 Independent Test**: Testcontainers PG+Redis（mock vendor adapter）；① 手动入队单维度 job → 该维度落库 + per-dim SyncRun（`sync:<dim>` + bullJobId）；② 维度 A 抛错 → 维度 B job 不受影响（无连坐）；③ retryMax=2 持续失败 → 重试耗尽 → QueueEvents failed 告警 + SyncRun=failed；④ 配额耗尽 → `getDelayed` 断言 self re-enqueue + 已同步标的幂等不重复；⑤ 旧 `EodSyncPipeline.run()` 行为零变化（016 管线 IT 回归）。

- [X] T008 [US3] [Server] **dimension executor 抽取（行为保持重构）**：新文件 `apps/server/src/marketdata/dimension-executor.ts` —— 把 `eod-sync-pipeline.ts` 4 个 fact 私有方法（L251/334/384/426）+ `SyncUniverseUseCase`/`SyncProfileUseCase` 包装升格为 `Map<DimensionKey, executor>` 注册表（executor 签名含 `{mode, asOf, backfillHistoryDays?, maxEodInstruments?}` + 审计上下文 `{syncRunMode: 'aggregate-merge' | 'per-dim', bullJobId?}`——**aggregate-merge = 旧 run() 路径**（计数并回聚合 SyncRun，行为不变）/ **per-dim = worker 路径**（自管 `sync:<dim>` SyncRun + bullJobId + per-dim `alertIfDegraded`））；`EodSyncPipeline.run()` 改为内部调用同批 executor（聚合 `'eod-sync'` 行写入保留，**016 行为零变化**）；executor 侧 `SyncDimension` 投影扩 `retryMax`/`enabled`/`misfirePolicy`（旧 `SyncDimensionRow` Pick L532 不动）→ verify: **016 管线 IT 全绿回归**（`marketdata.eod-pipeline-core.it.spec` + `eod-pipeline-budget`）+ 新增 executor 单维度直调 Testcontainers IT（per-dim SyncRun 落行）
- [X] T009 [US3] [Server] **worker + 入队 helper + 告警**：新文件 `apps/server/src/marketdata/marketdata-sync.worker.ts` —— 手控 provider：`new Worker('marketdata-sync', processor, {connection, concurrency: 1})`；processor 按 `job.name`（`sync:<dim>`）路由 executor（payload `{dimensionKey, mode, asOf 字符串, backfillHistoryDays?, maxEodInstruments?, triggeredBy}`）；入队 helper `enqueueDimensionJob()`（`attempts = SyncDimension.retryMax` + `backoff {type:'exponential', delay: 60_000}`（D4）+ `removeOnComplete/{count}` `removeOnFail/{count}` 走 config）；`QueueEvents` `failed` 监听 → 结构化 ERROR log（retry 耗尽硬失败，与 executor 内业务降级告警分工两道）；**启停门**：`OnModuleInit` 启动 Worker/QueueEvents、`process.env.MARKETDATA_WORKER_DISABLED` sentinel 置位时 no-op（D6，CLI 在 PR-5 消费）、`OnModuleDestroy` close 全对象；`config/marketdata.config.ts` `MarketdataSyncConfigSchema` 增 `requeueDelayMs`（default 1_800_000）/ `removeOnCompleteCount`（default 200）/ `removeOnFailCount`（default 500）→ verify（Testcontainers PG+Redis）: 入队→processor 路由→落库 + attempts 注入断言（job.opts）+ sentinel 置位 boot 不起 worker。run via `nx test server <file>` `--skip-nx-cache`
- [X] T010 [US3] [Server] **配额顺延 self re-enqueue（D5）**：executor 预算耗尽信号（016 `maxEodInstruments`/令牌桶语义不变）→ processor 以 **standalone delayed job** 重新入队同 named job（不进 flow；delay=`requeueDelayMs`；payload 原样保留 `triggeredBy`；**deferral ≠ failure 不耗 attempts**）；`pendingEodInstruments` 进度锚（L320-331）+ `lastWatermark` 照写（降级审计）→ verify（Testcontainers PG+Redis）: 配额耗尽注入 → `queue.getDelayed()` 断言 re-enqueue 存在 + delay 值 + 已同步标的下次续跑不重复（幂等锚）
- [X] T011 [US3] [Server-IT] **PR-3 集成 IT**：`apps/server/test/integration/marketdata.dimension-worker.it.spec.ts` —— 单维度 job 落库+SyncRun（syncType+bullJobId）/ 双 job 失败不连坐 / retryMax 耗尽 → QueueEvents failed 告警断言 + SyncRun=failed / 顺延 getDelayed / afterAll close。run via `nx test server <file>` `--skip-nx-cache`

---

## Phase 4: PR-4 — SyncTickDriver + flow 装配（依赖编排）+ 灰度 flag（US4, US5）

**PR-4 Independent Test**: Testcontainers PG+Redis 控时（注入 now + 操纵 nextFireAt 列）；① due → 条件 UPDATE won → nextFireAt 推进 + 入队；② 双 tick 并发 → 恰好一次；③ fire-now 补一次（asOf=当天）vs skip-to-next 只推进；④ NULL 懒初始化到未来不补跑；⑤ 非交易日组 flow 前短路 + nextFireAt 照推；⑥ flag=false 零副作用；⑦ **周二 universe 缺席 eod_bar 当根照跑**（最高风险专项）；⑧ hard 边断下游 / soft 边放行；⑨ 端到端三场景（周一全 flow / 周二缺席 / 宕机重启 catch-up）。

- [X] T012 [US5] [Server] **flow 装配器纯函数（D3 ⚠️）**：新文件 `apps/server/src/marketdata/sync-flow-assembler.ts` —— 输入 won 维度集 + `sync_dependency` 边集，输出 FlowProducer 树 spec：维度全序 `universe→profile→fundamental→financial→eod_bar→corporate_action`（hard 边链相邻；与 016 执行序差 = fundamental/financial 提到 eod_bar 前，无边无语义影响）构**嵌套链树**（后继 parent ← 前驱 child）；真实边 → `hard=failParentOnFailure:true / soft=ignoreDependencyOnFailure:true`，**无真实边 child 一律显式 `ignoreDependencyOnFailure:true`**（裸 child = parent 永久 waiting-children，context7 实证）；**不可表达拓扑（环 / 非链相邻 hard）→ throw**（禁静默错装）→ verify（vitest 纯函数穷举）: 周一全集树形逐边 opts 断言 / 周二缺 universe 链从 profile 起 / 单维度退化单 job / 全树无裸 child / 环+非相邻 hard throw（复杂度 O(V+E)，注释标）
- [X] T013 [US4] [Server] **tick 核心（NULL 懒初始化 + 条件 UPDATE 抢占 + computeNext）**：新文件 `apps/server/src/marketdata/sync-tick-driver.ts` 纯逻辑半（`tick(now)` 可直调，照搬 scheduler `run(now)` 范式）—— (a) `findMany({enabled, nextFireAt: null})` → 逐行 `computeNext(cronExpr, now)`（cron-parser + Asia/Shanghai，dimension-due.ts 范式；**from now 非 from 旧值**，misfire≠backfill 承重点）→ `updateMany({where:{id, nextFireAt: null}})` 懒初始化（**不入队**）；(b) `findMany({enabled, nextFireAt:{lte:now}})` → 逐行 `updateMany({where:{id, nextFireAt:<观测值>}, data:{nextFireAt: computeNext}})` affected-count won/lost（playbook 范式，READ COMMITTED）；(c) won 集按 `misfirePolicy` 分流：skip-to-next 不入队 / fire-now 进入组 flow 流程 → verify（Testcontainers PG，控时）: NULL → 懒初始化未来值不入队 / due won → 推进+返回 won 集 / 双 tick 并发（两 `tick(now)` Promise.all）恰好一方 won / 宕机模拟（nextFireAt 置 3 天前 + fire-now）→ won 一次且 computeNext 是未来值非逐天补 / skip-to-next 只推进
- [X] T014 [US4] [Server] **tick 接线（gate + 装配 + 入队 + flag + @Cron）**：`sync-tick-driver.ts` 接线半 —— won(fire-now) 集 → 交易日 gate（`TRADING_CALENDAR_PORT`，组 flow 前短路零 vendor 调用，非交易日 nextFireAt 已推进）→ `sync-flow-assembler` 组树 → `FlowProducer.add`（job opts 经 T009 enqueue helper 语义：attempts/removeOn*；payload `asOf=shanghaiToday(now)` 字符串、`triggeredBy:'tick'`）；`@Cron(CronExpression.EVERY_MINUTE)` handler 起手 `tickEnabled` flag 短路（默认 false；@Cron 静态表达式限制 per eod-sync.scheduler L11 先例）；`config/marketdata.config.ts` 增 `tickEnabled`（`MARKETDATA_TICK_ENABLED` default false）；`marketdata.module.ts` 注册 → verify（Testcontainers PG+Redis）: due+交易日 → flow 入队（队列可见树）/ 非交易日 → 零入队+nextFireAt 已推进 / flag=false → `tick()` 不被驱动（handler 短路）
- [X] T015 [US4] [Server-IT] **PR-4 tick 语义 IT**：`apps/server/test/integration/marketdata.tick-driver.it.spec.ts` —— spec state_branches tick 簇穷举：due 入队 / 非 due 空扫 / disabled 不扫 / NULL 懒初始化 / 重物化原语（置 NULL → 下轮重算）/ 双 tick 恰好一次 / fire-now 补一次（asOf=当天）/ skip-to-next 只推进 / 多天缺口只补一次 / 非交易日短路 / flag=false 零副作用。run via `nx test server <file>` `--skip-nx-cache`
- [X] T016 [US5] [Server-IT] **PR-4 编排端到端 IT（SC-S04/S05）**：`apps/server/test/integration/marketdata.flow-orchestration.it.spec.ts` —— **周一场景**：universe+全维度共同 due → flow 中 eod_bar 等 universe 完成；**周二场景**：universe 不 due → eod_bar 当根照跑（**最高风险专项**）；hard 边：profile 失败 → fundamental 不跑（failParentOnFailure 生效）+ financial/corp 照跑；soft 边：universe 失败 → 下游照跑；**宕机重启场景**：nextFireAt 过期 + 重启首 tick → fire-now catch-up 入队一次；Redis 自愈（SC-S07）：清空队列 → 下一 due 周期 tick 重新入队；**灰度并存双拉**（state_branch「灰度 flag 开」，analyze C1）：旧 `EodSyncPipeline.run(now)` + 新 `sync:eod_bar` job 同日同维度执行 → DailyBar 无重复行、SyncRun 聚合行与 per-dim 行并存不冲突（幂等兜底证据）。run via `nx test server <file>` `--skip-nx-cache`

---

## Phase 5: PR-5 — trigger CLI + backfill CLI 迁入队（US6）

**PR-5 Independent Test**: Testcontainers PG+Redis；① trigger 单维度 → job 完成退出码 0 / processor 失败退出码 1 / 无 worker 超 `--timeout` 退出码 2 + 可操作错误信息；② `--cascade` 从修复点 → flow 含传递性下游、不含上游；③ CLI 入队与自动 job 同 queue 串行互斥；④ backfill 参数语义不变 + dry-run 不入队；⑤ CLI 进程 sentinel 置位不起 worker。

- [X] T017 [US6] [Server] **trigger CLI（新）**：`apps/server/src/marketdata/marketdata-trigger.cli.ts`（镜像 backfill CLI 三段式：`parseTriggerArgs`（`--dimension <key>` 必填 / `--cascade` / `--as-of YYYY-MM-DD` / `--timeout ms`）+ `executeTrigger`（纯逻辑注入 deps）+ `runTrigger` NestFactory 接线 + argv[1] entry-guard；**entry 起手 `process.env.MARKETDATA_WORKER_DISABLED='1'`**（D6，clarify Q2 CLI 永不起 worker）；cascade = `sync_dependency` 内存 BFS 传递性下游闭包（6 行表）→ won 集 {root+闭包} 复用 `sync-flow-assembler` 组 flow（`triggeredBy:'cascade'`）；非 cascade 单 job（`triggeredBy:'cli'`）；`job.waitUntilFinished(queueEvents, timeoutMs)`（timeout 走 config `cliWaitTimeoutMs` default 14_400_000，`--timeout` 覆盖）→ 退出码 0/1/2（2=超时含无 worker，打「server worker 不在线？」可操作信息）；`config` 增 `cliWaitTimeoutMs` + `apps/server/project.json` 增 `marketdata-trigger` target（镜像 L121 backfill target 形态）→ verify: vitest argv 解析 + cascade BFS 闭包纯函数 + Testcontainers 单 job 退出码三态（成功/失败/超时无 worker）
- [X] T018 [US6] [Server] **backfill CLI 迁入队**：`marketdata-backfill.cli.ts` —— `executeBackfill` 保 dry-run 估算段（L66-79 不变，dry-run 不入队）；非 dry-run 段**删抢锁**（L82-96 `lock.acquire/release` 拆除，解开 `EOD_SYNC_LOCK_KEY` import——常量本体 PR-7 才删）改「`enqueueDimensionJob({mode:'backfill', backfillHistoryDays, asOf, triggeredBy:'cli'})` + `waitUntilFinished`」；entry 置 sentinel（D6）；**退出码重映射**：0 成功 / 1 job 失败或 partial / **2 = 等待超时**（旧 2=锁未抢到 → 锁退出 CLI 路径，D7 过渡期与旧管线并发 = 接受幂等兜底；PR body + release note 提）→ verify（Testcontainers PG+Redis）: 参数语义不变断言（既有 `marketdata.backfill-cli.it.spec.ts` 改造适配）+ dry-run 不入队（queue 空）+ 入队形态退出码
- [X] T019 [US6] [Server-IT] **PR-5 CLI 集成 IT**：`apps/server/test/integration/marketdata.trigger-cli.it.spec.ts` —— cascade flow 成员断言（universe 根 → 含全下游 / profile 根 → 仅 fundamental，不含 universe）/ CLI job 与自动入队 job 同 queue 串行（concurrency=1 互斥）/ sentinel 置位进程 queue 有积压但不消费（不起 worker 断言）/ 退出码三态。run via `nx test server <file>` `--skip-nx-cache`

---

## Phase 6: PR-6 — 灰度切换（prod 观察，US7）

**PR-6 Independent Test**: 非 IT——prod 观察期（SC-S08）。flag 翻开是 env 改动 + 重建容器，代码零变更（可逆）。

- [X] T020 [US7] [Verify] **灰度启用 + 观察清单**：部署 runbook 段落（`docs/private/plans/2026-06/` 或部署文档增补）：① prod `.env` 增 `MARKETDATA_TICK_ENABLED=true` + recreate app（服务器原地改，per prod SMS 先例）；② 观察 1-2 周清单：SyncRun per-dim 行（`syncType='sync:<dim>'`）连续正常 / 旧 `'eod-sync'` 聚合行并存无冲突 / Redis `INFO memory` 周检稳定 / QueueEvents failed 告警零误报；③ 双拉确认：幂等 + 过渡期 `EOD_SYNC_LOCK_KEY` 锁仍护旧管线（只费配额不坏数据）；④ 顺序衔接：本 feature 灰度 ≠ universe enable——prod `sync_dimension` 6 维度仍全 disabled，启用顺序（0.4.0 发版 → universe enable）归部署 runbook → verify: 观察期数据贴 PR / 决策记录（满足才进 PR-7）

  > ✅ **观察回填（2026-06-13，prod 实证 host `index` / `nvy-tight-postgres-1`）**：① flag 早已置 `MARKETDATA_TICK_ENABLED=true`（app 容器 healthy）；② `marketdata.sync_run` per-dim 行 `sync:<dim>` 自 `2026-06-03` 起连续 `success`，各 sync_type 计数 `eod_bar`×9 / `fundamental`×7 / `profile`×7 / `universe`×7 / `financial`×2 / `corporate_action`×2，全期 **38 success / 1 failed / 1 skipped**（唯一 failed 在 `2026-06-03 07:19` 首日 bring-up 单次，之后零持续失败）；旧 `'eod-sync'` 聚合 SyncRun **停止新增**（末次 `2026-06-04` = 新旧切换点；历史 6 行保留，PR-7 清退的是写入路径非历史数据）；③ prod `sync_dimension` **6 维全 `enabled=true` 在跑**：日更 `eod_bar/fundamental/profile`（`0 0 22 * * *`）+ 周更 `universe`（= instrument 全量，每周一 `0 0 22 * * 1`，末次 `2026-06-08`、next `2026-06-15`）/ `corporate_action`（周一）/ `financial`（周二 `0 0 22 * * 2`）。⚠️ **与 plan T020 ④「6 维仍全 disabled、universe 留 0.4.0」不符** —— prod 实际部署已全启用，④ 系计划态未对齐现实，**以 prod 为准**。观察期 ~10 天稳态达标，T020 补勾（状态层 drift `git log`/prod > tasks.md）。

---

## Phase 7: PR-7 — 清退旧调度器（⚠️ 不可逆，建议人工合并）（US7）

**PR-7 Independent Test**: ① grep 零残留（旧 `@Cron` 22:00 / `EOD_SYNC_LOCK_KEY` / `'eod-sync'` 聚合写入 / dimension-due）；② 全量 IT 纯 tick+queue 形态全绿（SC-S09）。**前置 = PR-6 观察期通过。**

- [X] T021 [US7] [Server] **清退**：删 `eod-sync.scheduler.ts`（旧 `@Cron` 22:00 + `EOD_SYNC_LOCK_KEY` 常量）/ `redis-sync-lock.ts` + `marketdata.redis-sync-lock.it.spec.ts` + `marketdata.eod-scheduler.it.spec.ts`（锁与旧调度专属 IT）/ `dimension-due.ts` + `dimension-due.spec.ts`（due 过滤被 nextFireAt 取代）/ `EodSyncPipeline.run()` 旧编排入口 + `'eod-sync'` 聚合 SyncRun 写入（executor 注册表成唯一执行面；`marketdata.eod-pipeline-*.it.spec.ts` 改造为经 executor 直调）/ `marketdata.module.ts` + config 收尾（`defaultCron`/`lockTtlMs` 等旧字段评估去留——仅被删除方消费则删）→ verify: `rg 'EOD_SYNC_LOCK_KEY|eod-sync.scheduler|dimension-due|isDimensionDue'` 零命中（migration 历史注释除外，per 全仓清理三段分治）+ `rg "syncType.*'eod-sync'"` 仅 SyncRun 历史行读侧 + `nx test server` 全绿 + **PR 标「建议人工合并」不接 auto-merge**（git-workflow 不可逆例外）
- [X] T022 [Verify] **全绿门 + catalog + 收尾**：`nx affected -t lint typecheck test build --base=origin/main` 全绿（首跑 `--skip-nx-cache`）+ `check-server-moat.ts` 关 + `server-bounded-context-catalog.md` § Operation Catalog 调度 operation 行更新（`sync-tick-driver` / `marketdata-sync.worker` / `marketdata-trigger` 入列，`eod-sync.scheduler` 移除，context=marketdata，propagation=intra）+ spec frontmatter `status: implemented` 翻转 + tasks.md 全 `[X]` 复核

---

## Dependencies & 执行顺序

```
PR-1（T001 dep → T002 连接 provider / T003 compose[P] → T004 IT）
  ↓（队列基建是执行层物理底座）
PR-2（T005 schema+seed → T006 moat[P] → T007 IT+016 回归门）
  ↓（真相层 schema 是 tick/编排的读写对象）
PR-3（T008 executor 抽取 → T009 worker+入队 helper → T010 顺延 → T011 IT）
  ↓（executor/worker 是 tick 与 CLI 的共同执行面；本片不注册 tick）
PR-4（T012 装配器[P 可先行] → T013 tick 核心 → T014 接线+flag → T015 tick IT → T016 编排端到端 IT）
  ↓（自动调度立起，flag 默认关）
PR-5（T017 trigger CLI → T018 backfill 迁入队 → T019 IT）
  ↓（手动面齐 → 可灰度）
PR-6（T020 灰度观察 1-2 周，非代码）
  ↓（观察期通过是清退前置）
PR-7（T021 清退 ⚠️ 人工合并 → T022 全绿门收尾）
```

- **PR 串行**（每片依赖前片产出）；片内 `[P]` 项可并行（T003 compose / T006 moat / T012 装配器纯函数均不同文件）。
- **MVP scope** = PR-1..PR-4（自动调度全能力立起、flag 关安全并存）；PR-5 给运维面；PR-6/7 是切换与收尾。
- **Clear 检查点批次**（Constitution §III）：建议 PR 边界即批次边界（每 PR 3-5 task）；PR-3 的 T008 抽取后可单独停一次（最大单 task）。

## 对齐 §H4 落地序

| §H4 片 | 对应 Phase / Task |
| --- | --- |
| 1. bullmq + Redis policy + 连接 provider | PR-1（T001-T004） |
| 2. schema expand + seed | PR-2（T005-T007） |
| 3. executor 抽取 + worker（不注册 tick） | PR-3（T008-T011） |
| 4. SyncTickDriver + FlowProducer + flag 默认关 | PR-4（T012-T016） |
| 5. trigger CLI + backfill 迁入队 | PR-5（T017-T019） |
| 6. 灰度并存观察 | PR-6（T020） |
| 7. 清退（不可逆，人工合并） | PR-7（T021-T022） |
