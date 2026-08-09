---
feature_id: 016-marketdata-sync
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-03'
---

# Tasks: 016-marketdata-sync（配置化夜间全量 A 股同步管线 + 调度 — 让 015 端点有真数据）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `016-marketdata-sync`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 3 表 schema / US2 交易日历+gate / US3 universe+pinyin+黑名单 / US4 全量统一同步（无 tier，水位顺延）/ US5 异构 EOD 管线 / US6 调度+锁+backfill）；Foundational / Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Verify]`（per sdd.md；**本 feature 纯 server，无新读端点 → 无 [Contract]/[Mobile]/[Mobile-E2E]**，FR-S19）
- **Phase = PR 交付单元**（user 认可 plan §Phase 2 的 4 PR 切分）：按 §B.5 落地序分 PR，task 标 US 映射 spec 验收
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；管线落库 / scheduler / 锁 = **Testcontainers PG(+Redis)**（run via `nx test server <file>`，cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（gate 判定 / 锁 Lua / pinyin 整形）= vitest 无 DB；**每 PR 末单列 `[Server-IT]` 全 boot/集成 task**；vendor 契约 = mock 单测 + **env-gated 真 vendor IT**（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`/东财，默认 skip，沿 015 `describe.skipIf`）
- 无 task-meta JSON（**manual 模式**，per 004-015）
- **marketdata = 015 已立第 5 bounded context**（本 feature 在内续写同步层）：**仍叶子 ctx**（分级砍后零跨 ctx 读，clarify 2026-06-03）；**禁 DI `auth/cockatiel-retry.executor.ts`**（015 C1：叶子不依赖 auth；复用 015 `vendor-http-client.ts` 直 import `cockatiel` 即可）；唯一跨 module 依赖 = `SecurityModule`（`PrismaService` + `REDIS_CLIENT`）
- **重要度分级延后**（clarify 2026-06-03）：T0 四并集源表（持仓/自选/追踪/预警）全未建 → 016 全量统一同步、`syncTier` 留 015 默认 2 不重算、零跨 ctx 读 portfolio。分级 = watchlist/holdings 落地后独立 feature
- **新 dep（D2 ⚠️ impl 前 context7 grounding）**：`pinyin-pro`（纯 TS 零 native，universe 拼音填充）impl 前验当前版本 API（`pinyin(name,{pattern:'first'})` abbr / `{toneType:'none'}` full）+ CN 可用（per ADR-0040 Dependencies 防火墙，禁无锚点 cargo-cult）
- **4 段 PR（均纯 server）**：**PR1**（T001–T005，3 表 schema+seed+moat+config+交易日历 adapter+gate）→ **PR2**（T006–T009，universe live adapter+pinyin+黑名单）→ **PR3**（T010–T014，异构 EOD 管线+限频+隔离+SyncRun 水位+复权重取）→ **PR4**（T015–T019，scheduler+Redis 锁+backfill CLI）。无端点 → 无 api-client regen / 无 Constitution §V 触发

## Path Conventions

- server：`apps/server/src/marketdata/`（015 已建 module，ADR-0043 扁平文件平铺）；schema `apps/server/prisma/schema.prisma`；config `apps/server/src/config/marketdata.config.ts`（015 建，本 feature 增同步配置）；migration `apps/server/prisma/migrations/{YYYYMMDD}_{HHMM}_add_marketdata_sync_tables/`（**expand-only** + `migration_refs` frontmatter，ADR-0035）；IT `apps/server/test/integration/marketdata.*.it.spec.ts`（**run via `nx test server <file>`，cwd=apps/server**）
- 复用：015 `vendor-http-client.ts`（双窗令牌桶 + cockatiel + constraint profile）、`lixinger-adapter.base.ts`（fsType→lixingerCompanyType 缓存已现成）、`eastmoney-search.adapter.ts`+`eastmoney.constraint-profile.ts`+`eastmoney-symbol.rules.ts`（universe adapter 模板）、8 端口接口（消费）；`account/anonymize-frozen-accounts.scheduler.ts`（cron + per-row try/catch + 失败阈值告警**范式照搬非 import**）；`SecurityModule`（PrismaService + `REDIS_CLIENT` ioredis singleton）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（per memory `mono_dev_db_compose_stack`；mbw-poc-postgres:5433 / redis:6380）；本地起服/IT 前 **`env -u OSS_*`** + 显式 dev `DATABASE_URL`/`REDIS_URL`（per memory `local_it_smoke_needs_env_unset_oss`）
- ⚠️ 新 ts/spec 首跑带 **`--skip-nx-cache`**（per memory `nx_cache_false_green_on_new_files`）

---

## Phase 1: PR1 — 3 配置/审计表 + seed + 交易日历 live adapter + 交易日 gate（US1, US2）🎯 MVP 地基

**PR1 Independent Test**: Testcontainers PG；① migrate deploy → SyncDimension/SyncBlacklist/SyncRun 三表 + 唯一键/索引落库；② SyncDimension seed 6 维度行存在（idempotent）；③ 交易日历 adapter mock 返非交易日 → gate skip（SyncRun=skipped，零 vendor 调用）/ 交易日 → 进入后续。**可独立 ship**（schema + gate 绿，管线后续 PR 接）。

- [X] T001 [US1] [Server] `apps/server/prisma/schema.prisma`：增 **3 张配置/审计表**（贫血 row + `@map` snake_case，`@@schema("marketdata")`，承接 015 的 6 表）：`SyncDimension`（`dimensionKey @unique` + `enabled`/`cronExpr`/`vendor`/`marketScope String[]`/`metricsList Json?`/`adjustTypes String[]`/`batchSize`/`historyDepth Int?`/`retryMax`/`priority`/`lastWatermark DateTime?`/`pausedUntil DateTime?`）/ `SyncBlacklist`（`(market,code)` 唯一 + `reason`/`createdAt`）/ `SyncRun`（`syncType`/`startedAt`/`finishedAt?`/`scanned`/`ok`/`skipped`/`failed`/`failedTargets Json?`/`status` + `(syncType,startedAt desc)` 索引）。+ migration `{YYYYMMDD}_{HHMM}_add_marketdata_sync_tables/`（**expand-only**：3 表 + 索引 + raw `INSERT INTO marketdata.sync_dimension ... ON CONFLICT (dimension_key) DO NOTHING` seed 6 维度默认行（universe/profile/eod_bar/fundamental/financial/corporate_action，cronExpr 默认 `0 0 22 * * *`，D3）；`migration_refs` frontmatter，ADR-0035）+ `prisma generate` + dev DB migrate deploy → verify: `nx test server marketdata.schema-016.it.spec`（Testcontainers migrate deploy + 3 表 + seed 6 行断言）
- [X] T002 [P] [Server] **moat 登记 3 新 model owner**：[`scripts/checks/check-server-moat.ts`](../../scripts/checks/check-server-moat.ts) `MODEL_OWNERSHIP` 加 3 行（`syncDimension`/`syncBlacklist`/`syncRun` → `'marketdata'`，**否则 marketdata 同步代码读自己的新表即 `moat-unmapped` 硬拒**）→ verify: `pnpm tsx scripts/checks/check-server-moat.ts` 关 & `nx lint server` 0 violation
- [X] T003 [US2] [Server] **LixingerTradingCalendarAdapter（live，D6）**：`apps/server/src/marketdata/lixinger-trading-calendar.adapter.ts`（实现 `TradingCalendarPort.isTradingDay(market,date)`，经 015 `VendorHttpClient` + Lixinger profile，调 trade-day 端点；与 EOD 同源）+ `marketdata.module.ts` TRADING_CALENDAR 端口工厂 `kind:live` 绑此 adapter（`kind:mock` 仍 015 Mock）→ verify: mock 单测（trade-day 解析 + canonical date）+ **env-gated 真 Lixinger IT**（`RUN_MARKETDATA_IT`+`LIXINGER_TOKEN`，默认 skip）。run via `nx test server <file>`
- [X] T004 [US2] [Server] **交易日 gate + SyncRun helper + config 同步配置**：`apps/server/src/marketdata/trading-day-gate.ts`（纯逻辑：调 `TRADING_CALENDAR_PORT` 判今日交易日 → 非交易日返 skip 信号）+ `sync-run.recorder.ts`（开/收 SyncRun 行：running→success|partial|failed|skipped + scanned/ok/skipped/failed/failedTargets 累计，贫血 prisma row 写 marketdata.sync_run）+ `config/marketdata.config.ts` 增同步段（`syncLockTtlMs` 默认 > 最长 job、`defaultCron` `0 0 22 * * *` D4、`backfillDefaultHistoryDays` 保守默认 D5）→ verify（vitest + Testcontainers）: 非交易日 gate → skip 信号 + SyncRun status=skipped 落行（零 vendor 调用断言）/ 交易日 → proceed（spec state_branch「trading-day gate 交易日/非交易日」）
- [X] T005 [US1] [US2] [Server-IT] **PR1 集成 IT**（Testcontainers PG）：migrate deploy 3 表 + seed 6 维度行 + gate 非交易日 skip（SyncRun=skipped、未触 vendor）/ 交易日 proceed。`apps/server/test/integration/marketdata.sync-schema-gate.it.spec.ts`，run via `nx test server <file>`

---

## Phase 2: PR2 — universe live adapter + pinyin 填充 + 黑名单过滤（US3）

**PR2 Independent Test**: Testcontainers PG；① mock 东财 clist 返若干标的（含北交所 bj）→ upsert Instrument（canonical `market:code`）+ pinyinAbbr/pinyinFull 填充；② 重跑 → upsert 幂等（无重复、name 更新、syncTier/lixingerCompanyType 不被重置）；③ code ∈ SyncBlacklist → 跳过未 insert；④ env-gated 真东财 clist 解析。

- [X] T006 [Server] **新依赖 `pinyin-pro`（D2，⚠️ impl 前 context7 验版本+API+CN 可用）**：`pnpm -C apps/server add pinyin-pro` + lockfile → verify: `pnpm -C apps/server install --frozen-lockfile` 绿 + 一行 smoke（`pinyin('贵州茅台',{pattern:'first',toneType:'none'})` → `gzmt` 形态、`{toneType:'none'}` → 全拼）
- [X] T007 [US3] [Server] **EastmoneyUniverseAdapter（live，clist m:0/1/2）**：`apps/server/src/marketdata/eastmoney-universe.adapter.ts`（实现 `InstrumentUniversePort.enumerate()`，经 015 `VendorHttpClient` + 东财 profile，clist `m:0/1/2` 枚举全 A 股含北交所 → 归一化 canonical via 015 `eastmoney-symbol.rules.ts`，返 `{market,code,name}[]`）+ `marketdata.module.ts` INSTRUMENT_UNIVERSE 端口工厂 `kind:live` 绑此 adapter → verify: mock 单测（clist 解析 + 含北交所 + 归一化 canonical）+ **env-gated 真东财 IT**（默认 skip）。run via `nx test server <file>`
- [X] T008 [US3] [Server] **universe 同步逻辑 + pinyin 填充 + 黑名单过滤**：`apps/server/src/marketdata/sync-universe.usecase.ts`（调 `INSTRUMENT_UNIVERSE_PORT.enumerate()` → 过滤 `SyncBlacklist`（`(market,code)` 命中跳过）→ `pinyin-pro` 算 `pinyinAbbr`/`pinyinFull` → `prisma.instrument.upsert` on `(market,code)`：insert 新标的（pinyin + syncTier 默认 2）/ update 既有（name/status，**不覆盖** syncTier/lixingerCompanyType，per FR-S03）；per-row try/catch 隔离 + SyncRun 计数）→ verify（Testcontainers PG）: upsert 新标的+pinyin 填充 / 重跑幂等（无重复、syncTier 不重置）/ 黑名单跳过 / 坏项跳过不整体失败（spec state_branch「universe sync 新标的/既有/黑名单」）。run via `nx test server <file>`
- [X] T009 [US3] [Server-IT] **PR2 universe IT**（Testcontainers PG）：enumerate→upsert+pinyin+黑名单过滤 + 重跑幂等。`apps/server/test/integration/marketdata.sync-universe.it.spec.ts`，run via `nx test server <file>`

---

## Phase 3: PR3 — 异构 EOD 同步管线（limit + 隔离 + SyncRun 水位 + 复权重取 + 统一同步）（US4, US5）

**PR3 Independent Test**: Testcontainers PG（mock vendor adapters）；① 跑管线 → DailyBar/Fundamental/Financial/CorporateAction 落库；② **连跑两次** → 无重复行（append skipDuplicates + upsert 自然键）；③ 单标某步抛错 → SyncRun.failedTargets，其余正常落库（隔离）；④ 限频突发 → 双窗令牌桶节流；⑤ 配额耗尽注入 → 剩余顺延（lastWatermark 水位），已同步不重复；⑥ profile 富化 → fsType 缓存 lixingerCompanyType + fundamental 路由；⑦ HTTP-out-of-tx；⑧ corp-action → 受影响标的 ex-date 后区间复权重取。

- [X] T010 [US5] [Server] **profile 富化 step**：`apps/server/src/marketdata/sync-profile.usecase.ts`（对缺 `lixingerCompanyType` 的 Instrument 批量经 015 `lixinger-adapter.base.ts` 已有的 `cn/company → fs_type` 解析+回写缓存路径富化；低频/变更才跑，FR-S06）→ verify（Testcontainers PG）: 缺 fsType 标的富化后 `lixingerCompanyType` 落库 + 已有缓存零外呼（spec drift 锚点：`/cn/company` 返字段 `fs_type` 已在 base 用）。run via `nx test server <file>`
- [X] T011 [US5] [Server] **EodSyncPipeline 核心 runner（维度序 + per-row 隔离 + 幂等 + HTTP-out-of-tx + SyncRun 水位）**：`apps/server/src/marketdata/eod-sync-pipeline.ts`（维度序 universe→profile→eod_bar→fundamental→financial→corporate_action，读 `SyncDimension`(enabled/metricsList/adjustTypes/batchSize) 驱动；每标的每维度 try/catch 隔离（照搬 anonymize `for`+warn）→ `SyncRun.failedTargets` push；先 vendor 拉数（HTTP 在 tx 外）→ 整形 → `prisma.$transaction` 仅包写库（FR-S10）；幂等：`dailyBar.createMany({skipDuplicates:true})` + fundamental/financial/corporateAction `upsert` 自然键（FR-S08）；SyncRun scanned/ok/skipped/failed 累计 + status partial/success；**本轮 failed ≥ 阈值 → ERROR log 结构化告警**（照搬 anonymize `FAILURE_ALERT_THRESHOLD`，FR-S17 log-based alerting 出口；Prometheus counter / outbox 通知为 seam））→ verify（Testcontainers PG，mock adapters）: 四类事实落库 + **连跑两次无重复行** + 单标失败隔离（failedTargets）+ **failed ≥ 阈值 → ERROR log 断言** + HTTP-out-of-tx 断言（事务回调内无 HTTP）（spec state_branch「per-instrument 成功/失败隔离」「idempotent 重跑」）。run via `nx test server <file>`
- [X] T012 [US4] [Server] **统一同步消费 + 配额耗尽顺延（水位，无 tier）**：`eod-sync-pipeline.ts` 接 015 `VendorHttpClient` 双窗令牌桶统一序消费（V1 全标的同优先级，**无 tier 序**）+ 配额/窗口耗尽 → 写 `SyncDimension.lastWatermark` 记进度、剩余顺延下窗、已同步标的幂等不重复（FR-S07）→ verify（Testcontainers PG）: 限频突发 → 节流（不打爆）+ 配额耗尽注入 → 剩余顺延（水位推进）+ 已同步标的不重复（spec state_branch「uniform sync」「rate-budget 耗尽」）。run via `nx test server <file>`
- [X] T013 [US5] [Server] **复权重取（corp-action 触发，D7）**：`eod-sync-pipeline.ts` corporate_action step 落库后 → 对受影响标的（按 instrumentId）的 **ex-date 之后区间**经 `EOD_BAR_PORT` 重拉 Lixinger 已复权 candlestick（forward/backward，adjustTypes 配置）→ 幂等 upsert 覆盖旧复权行（本地不重算复权因子，clarify 2026-06-02）→ verify（Testcontainers PG）: 新增 corp-action → 仅受影响标的 ex-date 后区间重取（非全量）+ 重取幂等覆盖（spec state_branch「corporate-action 触发复权」；spec drift 锚点：DailyBar 唯一键 `(instrumentId,tradeDate,adjust)` 015 已建）。run via `nx test server <file>`
- [X] T014 [US4] [US5] [Server-IT] **PR3 管线全集成 IT**（Testcontainers PG，mock adapters）：全管线四类事实落库 + 连跑两次无重复 + 单标失败隔离 + 配额顺延 + HTTP-out-of-tx + profile fsType 路由 + 复权重取。`apps/server/test/integration/marketdata.eod-sync-pipeline.it.spec.ts`，run via `nx test server <file>`

---

## Phase 4: PR4 — 调度 + Redis 分布式锁 + backfill CLI（US6）

**PR4 Independent Test**: Testcontainers PG+Redis；① 多实例并发触发 → 仅一个抢到 Redis 锁执行、其余退出（单例 HA）；② 锁过期致双跑 → 幂等兜底数据不坏（仅多耗配额）；③ 持锁实例「崩溃」（不释放）→ TTL 到期释放、下窗凭 SyncRun 水位续跑；④ backfill dry-run → historyDepth 交易日迭代计划打印 + delta 从 lastWatermark 增量 + 与 cron 同锁互斥；⑤ cronExpr 读 SyncDimension 配置（非硬编码）。

- [X] T015 [US6] [Server] **Redis 分布式锁（hand-roll，D1）**：`apps/server/src/marketdata/redis-sync-lock.ts`（注入 `REDIS_CLIENT`；`acquire(key,ttlMs)` = `SET key <fencingToken> NX PX ttl` + `release(key,token)` = Lua `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end`（check-and-del 防误删他人锁）；随机 fencing token）→ verify（Testcontainers Redis）: acquire 成功/已持时第二次失败 + release 凭 token（错 token 不删）+ TTL 到期自动释放（spec state_branch「distributed-lock 抢锁成功/失败」「lock-expiry 双跑」）。run via `nx test server <file>`
- [X] T016 [US6] [Server] **EodSyncScheduler（@Cron + 锁 + cronExpr 配置化 + 崩溃恢复）**：`apps/server/src/marketdata/eod-sync.scheduler.ts`（`@Cron(defaultCron D4, {timeZone:'Asia/Shanghai'})` handler：起手 `redisSyncLock.acquire` → 抢到才 `eodSyncPipeline.run()`（内部按各维度 `SyncDimension.cronExpr`/`enabled` 决定跑哪些维度，动态 cron `SchedulerRegistry` = seam）→ finally `release`；抢不到直接 return（leader-election-lite）；崩溃恢复靠锁 TTL + SyncRun 水位续跑，FR-S13/S14；`run(now)` 暴露供 IT 直调，照搬 anonymize）+ `marketdata.module.ts` 注册 scheduler provider → verify（Testcontainers PG+Redis）: 多实例（两 scheduler 实例共享 Redis）并发 `run` → 仅一个执行管线、另一个 lock-miss 退出 + 锁过期双跑幂等不坏 + cronExpr 读配置（spec state_branch「distributed-lock」「crash 恢复」）。run via `nx test server <file>`
- [X] T017 [US6] [Server] **backfill CLI（standalone，D5）+ nx target**：`apps/server/src/marketdata/marketdata-backfill.cli.ts`（`NestFactory.createApplicationContext(AppModule)` 起 DI → 解析 argv `--dimension`/`--history-depth`/`--dry-run`/`--markets` → 抢同一 Redis 锁（与 cron 互斥）→ backfill 模式按 `historyDepth` 交易日迭代回填 / delta 模式从 `lastWatermark` 增量；`--dry-run` 仅 `log()` 打印将拉取请求数估算（D5 防配额爆炸，无声截断禁止）；退出码 0/1/2）+ `apps/server/project.json` 加 `marketdata-backfill` target（`node dist .../marketdata-backfill.cli.js`，对齐 `export-openapi` target 形态）→ verify: dry-run 计划打印（请求数估算）+ historyDepth 交易日迭代（mock calendar）+ delta from lastWatermark + 锁互斥（cron 持锁时 CLI 退出码 2）（spec state_branch「backfill 一次性」）。run via `nx test server <file>`
- [X] T018 [US6] [Server-IT] **PR4 调度+锁集成 IT**（Testcontainers PG+Redis）：多实例并发仅一个执行 + 锁过期双跑幂等不坏 + 崩溃后水位续跑 + backfill dry-run + cronExpr 配置化。`apps/server/test/integration/marketdata.scheduler-lock.it.spec.ts`，run via `nx test server <file>`
- [X] T019 [Verify] **全绿门 + catalog + 端到端真数据验证**：`nx affected -t lint typecheck test build --base=origin/main` 全绿（`--skip-nx-cache` 首跑）+ `server-bounded-context-catalog.md` § Operation Catalog 新增同步 operation 行（`sync-universe`/`sync-profile`/`eod-sync-pipeline`/`marketdata-backfill`，context=marketdata，propagation=intra）+ `check-server-moat.ts` 关（3 新 owner）+ **SC-S08 端到端**：本地 `MARKETDATA_PROVIDER=live` + `LIXINGER_TOKEN` 跑缩减集（几只标的 backfill）→ 验 015 读端点（quote/detail/bars）返**真数据**（非 fixtures）

---

## Dependencies & 执行顺序

```
PR1（T001 schema → T002 moat[P] / T003 calendar adapter → T004 gate+recorder+config → T005 IT）
  ↓（gate + SyncRun + config 是管线前置）
PR2（T006 dep → T007 universe adapter → T008 universe sync+pinyin+黑名单 → T009 IT）
  ↓（universe 是 EOD 管线的标的来源）
PR3（T010 profile → T011 pipeline runner → T012 统一限频顺延 / T013 复权重取 → T014 IT）
  ↓（管线是调度的执行体）
PR4（T015 锁 → T016 scheduler / T017 backfill CLI → T018 IT → T019 全绿门+端到端）
```

- **PR 串行**（每 PR 依赖前 PR 的产出：gate→universe→pipeline→scheduler）；PR 内 `[P]` 标记项可并行（如 T002 moat 与 T003 adapter 不同文件）。
- **MVP scope** = PR1 + PR2 + PR3（schema + universe + EOD 管线落库即「让 015 端点有真数据」可手动触发验证）；PR4 调度让其**自动**夜跑。

## 落地序对齐 §B.5

| §B.5 步 | 对应 PR / Task |
| --- | --- |
| 1. 交易日历同步 + gate | PR1（T003/T004/T005） |
| 2. universe + profile 富化 + 黑名单 | PR2（T007/T008）+ PR3（T010 profile） |
| 3. ~~syncTier 重算~~ | **砍**（分级延后，clarify 2026-06-03） |
| 4. EOD/fundamental/financial/corp-action 管线（限频+隔离+SyncRun+复权重算标记）| PR3（T011/T012/T013/T014） |
| 5. @Cron 调度 + Redis 分布式锁 + backfill | PR4（T015/T016/T017/T018） |
