---
feature_id: 016-marketdata-sync
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-03'
updated_at: '2026-06-03'
adr_refs: ['0019', '0032', '0041', '0043', '0047']
context7_verified: []
---

# Implementation Plan: 016-marketdata-sync（配置化夜间全量 A 股同步管线 + 调度 — 让 015 读端点有真数据；重要度分级延后）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `016-marketdata-sync` | **设计源**: [Master §4.3](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-master.md) + [子 plan 2 同步](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-p2-sync.md) + [ADR-0047](../../docs/adr/0047-marketdata-pluggable-data-access.md) | **前置**: [015 访问层](../015-marketdata-access-layer/spec.md)（消费其 8 端口、写其 schema）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011/012/015）。
> **纯 server 同步层流程**：spec ✅ → clarify ✅（2026-06-02 + 2026-06-03）→ **plan（本）** → tasks → analyze → implement。**无 mockup / 无 mobile 段 / 无新读端点**（读端点 015 已落，本 feature 只生产灌库）。验证全走 Testcontainers IT + env-gated 真 vendor IT。
> **⚠️ plan Phase 0 撞 spec 漏洞已裁决**：T0 分级四并集源表（持仓/自选/追踪/预警）全未建（schema 仅 `PortfolioPreference` + `BrokerAccount`，013/014 仍 draft）→ **砍重要度分级**（clarify 2026-06-03）。016 = 全量统一同步，marketdata 仍是**叶子 context**（零跨 ctx 读，与 015 一致）。分级延后至 watchlist/holdings 落地后独立 feature。

## Summary _(mandatory)_

016 = **marketdata 同步层**（015 访问层的消费侧）。交付：① **3 张配置/审计表** Prisma schema 增量（`SyncDimension` / `SyncBlacklist` / `SyncRun`，承接 015 的 6 表 + migration）+ SyncDimension 维度配置 seed。② **2 个 live adapter**：`EastmoneyUniverseAdapter`（东财 clist m:0/1/2 枚举全 A 股，模板 = 015 `eastmoney-search.adapter.ts` + `eastmoney.constraint-profile.ts` + `eastmoney-symbol.rules.ts`）+ `LixingerTradingCalendarAdapter`（trade-day，与 EOD 同源）——015 已落两端口接口 + Mock，本 feature 补 live。③ **pinyin 填充**（universe upsert 时填 `pinyinAbbr`/`pinyinFull`，本地 pg_trgm 搜索备援；新依赖见 D2）。④ **异构夜间同步管线** `EodSyncPipeline`：交易日 gate → universe → profile 富化（复用 015 `lixinger-adapter.base.ts` 已有的 fsType 缓存）→ EOD bar → fundamental → financial → corporate-action → 复权重取标记；幂等（append skipDuplicates + upsert 自然键）+ per-instrument try/catch 隔离（照搬 `anonymize-frozen-accounts.scheduler.ts`）+ 复用 015 双窗令牌桶限频 + HTTP-out-of-tx + SyncRun 水位审计。⑤ **调度** `EodSyncScheduler`（`@Cron`，cronExpr 走 `SyncDimension` 配置）+ **Redis 分布式锁**（`SET NX PX` + Lua check-and-del，集群单例 HA，见 D1）+ 崩溃恢复（锁 TTL + SyncRun 水位续跑）。⑥ **backfill CLI**（`NestFactory.createApplicationContext` standalone，historyDepth/lastWatermark 双模，与 cron 同锁互斥）。

**范式** = ADR-0043 扁平贫血 + 单向 Moat + ADR-0047 可插拔访问层（消费端口拉数、写贫血 row）。**out of scope（→ 后续 feature）**：重要度分级（syncTier 重算 + 跨 ctx 读 portfolio 并集，待 watchlist/holdings 落地）/ 实时报价 / 管理界面 / 港美股事实 / 分区归档实装。

## API Contracts _(mandatory)_

**无新 HTTP 端点 / 无 OpenAPI 契约变更**（FR-S19）——本 feature 只生产灌库，读端点 015 已落。故**无 `packages/api-client` regen、无 mobile 段、无 Constitution §V 类型同步链触发**。

唯一对外「命令面」= **backfill CLI**（运维手调，非 HTTP）：

| # | 形态 | 入口 | 参数 | 行为 | trace FR |
| --- | --- | --- | --- | --- | --- |
| CLI1 | NestJS standalone | `nx run server:marketdata-backfill`（→ `node dist .../marketdata-backfill.cli.js`）| `--dimension`(universe\|eod_bar\|...) `--history-depth`(天/年) `--dry-run` `--markets`(cn,...) | `createApplicationContext` 起 DI → 抢同一 Redis 锁 → 按 historyDepth 交易日迭代回填 / dry-run 仅打印计划 | FR-S15 |

- backfill 与夜间 cron **共享 `EodSyncPipeline` + 同一 Redis 锁**（互斥，FR-S15）；零 HTTP attack surface（clarify 2026-06-03）。
- CLI 退出码：成功 0 / 部分失败 1（SyncRun=partial）/ 锁未抢到 2（已有实例在跑）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md` v1.2.1） | 状态 | 备注 |
| --- | --- | --- |
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅×2 → plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点 |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | 每 impl task 红→绿→typecheck/lint→`[X]`→commit；17 条 state_branches 各有 IT；vendor 契约走 mock 单测 + env-gated 真 IT（沿 015 `RUN_MARKETDATA_IT` / `RUN_PERF_IT` 范式）；scheduler/lock 走 Testcontainers PG+Redis 集成测（多实例并发 + 锁过期双跑 + 崩溃续跑），禁纯 mock |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks.md 按 §B.5 落地序拆；多 server PR（见 § Phase 2 PR 策略） |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | **marketdata 仍叶子 ctx**（分级砍后零跨 ctx 读，与 015 一致）；单向 `marketdata → {security}`（仅 PrismaService + `REDIS_CLIENT`；弹性重试直 import `cockatiel` 库，禁 DI auth executor，015 C1）；marketdata 内零 `prisma.<otherTable>.*`；`check-server-moat.ts` 已登记 6 model owner（015）+ 本 feature 新增 3 model（syncDimension/syncBlacklist/syncRun）须登记 owner=marketdata（见 § Cross-cutting） |
| V. 类型同步链 Nx-driven | ✅ | **无端点 → 不触发**（无 swagger 变更 / 无 orval regen / 无 mobile 段）；FR-S19 明确 |

## Architecture Notes _(mandatory)_

### Bounded Context 决策（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 questions）

| Q | 问题 | 判定 |
| --- | --- | --- |
| Q1 | 直改 account/credential/portfolio/marketdata 核心表 row state？ | **marketdata 自有**——写自己的 9 张表（6 事实 + 3 配置/审计）；不写他 ctx 表 |
| Q2 | 编排多 ctx user-facing 流程？ | No（纯后台同步，无 user-facing 编排） |
| Q3 | 纯 platform infra？ | No（业务数据同步） |
| Q4 | 完全新业务领域？ | No（marketdata 015 已立，本 feature 在内续写） |
| Q5–Q7 | 跨 ctx 传播？ | **无**——分级砍后 016 不读 portfolio 表（叶子 ctx）。唯一跨 module 依赖 = `SecurityModule` export 的 `PrismaService` / `REDIS_CLIENT`（platform infra，ADR-0041 例外，无 R2/R3 注释要求）。**禁 DI `auth/cockatiel-retry.executor.ts`**（015 C1 已立：marketdata 叶子不依赖 auth；弹性重试直 `import from 'cockatiel'` 库，015 `vendor-http-client.ts` 已这么做，016 复用该 client 即可） |

**结论**：marketdata 保持**叶子 bounded context**，零跨 ctx 业务读写，依赖面仅 `security`（boundaries 已许 security+account，016 实际只用 security）。`check-server-moat` 只需补登记 3 个新 model owner。

### 关键设计（同步管线 + 调度 + 锁）

1. **管线编排** `EodSyncPipeline.run(now, mode)`（mode = delta | backfill）：
   - **交易日 gate**：`TradingCalendarPort.isTradingDay(market, today)` → false 直接 skip（SyncRun status=skipped，零 vendor 调用，FR-S02）。
   - **维度序**（FR-S06）：universe → profile（富化 fsType，低频）→ eod_bar → fundamental → financial → corporate_action → 复权重取。每维度读 `SyncDimension`（enabled / metricsList / adjustTypes / batchSize / historyDepth / lastWatermark）驱动。
   - **per-instrument 隔离**（FR-S09）：每标的每维度 try/catch，单标错 → `SyncRun.failedTargets` push，不阻塞 sibling（照搬 anonymize scheduler `for` 循环 + warn log）。
   - **幂等**（FR-S08）：`prisma.dailyBar.createMany({ skipDuplicates: true })`（唯一键 instrumentId+tradeDate+adjust）；fundamental/financial/corporateAction `upsert` on 自然键。
   - **HTTP-out-of-tx**（FR-S10）：先 vendor 拉数（HTTP，在 tx 外）→ 内存整形 → `prisma.$transaction` 仅包写库。绝不在 `$transaction` 回调内发 HTTP。
   - **限频**（FR-S07）：复用 015 `VendorHttpClient` 双窗令牌桶（adapter 内置 constraint profile）；V1 全标的统一序消费（无 tier）；配额耗尽 → `lastWatermark` 记进度，剩余顺延下窗。
   - **复权重取**（FR-S11，clarify 2026-06-02）：corporate_action 落库后，对受影响标的的 ex-date 之后区间，经 `EOD_BAR_PORT` **重拉** Lixinger 已复权 candlestick（forward/backward）→ 幂等 upsert 覆盖旧行。本地不重算复权因子。
2. **调度** `EodSyncScheduler`（`@Cron`，`ScheduleModule.forRoot()` 已在 `app/app.module.ts` 注册）：
   - cron 时刻**配置化**（FR-S12）——读 `SyncDimension.cronExpr`。注：`@Cron` 装饰器表达式是静态的；V1 用一个固定 `@Cron`（默认时刻，见 D4）触发 → 内部按各维度 `cronExpr`/`enabled` 决定是否跑该维度（动态 cron 注册 `SchedulerRegistry` 为升级 seam）。
   - **Redis 分布式锁**（FR-S13，见 D1）：handler 起手 `acquireLock(key, ttl)` → 抢到才 `pipeline.run()`，抢不到直接 return（leader-election-lite / 单例 HA）。finally `releaseLock`（Lua check-and-del，凭 fencing token 防误删他人锁）。
   - **崩溃恢复**（FR-S14）：锁 `PX` TTL > 最长 job 时长（+ 可选 watchdog 续租，D1）→ 持锁实例崩溃则 TTL 到期自动释放；下窗凭 `SyncRun` 水位 + `failedTargets` 续跑。正确性靠幂等不靠锁。
3. **backfill CLI**（FR-S15，见 API Contracts CLI1）：`createApplicationContext` 复用 DI，共享 `EodSyncPipeline` + 同锁。

### Cross-cutting（落地必带）

- `scripts/checks/check-server-moat.ts` `MODEL_OWNER`：新增 `syncDimension: 'marketdata'` / `syncBlacklist: 'marketdata'` / `syncRun: 'marketdata'`（否则 marketdata UC 读自己的新表 = moat-unmapped 硬拒）。
- `apps/server/src/config/marketdata.config.ts`（015 建）：增同步配置（lock TTL / 默认 cronExpr / backfill 默认 historyDepth / 限频边界复用 015 profile）。
- ESLint boundaries：marketdata 已注册（015）；新增同步类同 module 内，无新边界。
- Prisma `marketdata` schema 增 3 model + migration（含 SyncDimension seed，见 D3）。
- `nx run server:marketdata-backfill` target（project.json，CLI1）。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| # | 决策 | 选定 | 理由 / 备选 |
| --- | --- | --- | --- |
| D1 | Redis 分布式锁实现 | ⚠️ **hand-roll ioredis `SET NX PX` + Lua check-and-del release + 随机 fencing token**（V1 不做 watchdog 续租，靠 TTL 足够长 + 幂等兜底） | ADR-0043 不过度设计；`ioredis` 已装、`REDIS_CLIENT` 已 export；正确性靠幂等不靠锁，故无需 redlock 多节点算法（单 Redis 实例足够）。备选 redlock 库 = 多 Redis 节点才需要，本场景单实例 Redis，over-engineering。watchdog 续租 = 升级 seam（job 时长逼近 TTL 时加） |
| D2 | pinyin 库（新依赖） | ⚠️ **`pinyin-pro`**（纯 TS、零 native binding、社区主流、支持首字母 abbr + 全拼 full） | universe upsert 填 `pinyinAbbr`/`pinyinFull`（FR-S03）。`pinyin-pro` 无 node-gyp 编译（CI/Docker 友好），API `pinyin(name, {pattern:'first',toneType:'none'})` 取首字母、`{toneType:'none'}` 取全拼。**新依赖须 `pnpm -C apps/server add pinyin-pro`**（tasks 首 task）。备选 `pinyin`（node 老牌但带 native）— 排除 |
| D3 | SyncDimension 配置 seed | **migration 内 idempotent upsert 6 维度行**（universe/profile/eod_bar/fundamental/financial/corporate_action 默认配置） | 配置驱动需要初始行；放 migration（`prisma migrate` 的 raw SQL `INSERT ... ON CONFLICT DO NOTHING`）保证部署即有默认配置。备选运行时 bootstrap upsert（OnModuleInit）— 也可，但 migration seed 更显式、可审计 |
| D4 | 默认 cron 时刻 | **`0 0 22 * * *` Asia/Shanghai（22:00）** 作 `@Cron` 静态默认 + SyncDimension.cronExpr 配置覆盖维度级 | F7 理杏仁 EOD 就绪时间未公开、保守 22:00；经验测后调配置不改代码（FR-S12）。装饰器静态表达式限制见 Architecture §2 |
| D5 | backfill V1 默认深度 | ⚠️ **默认 `--history-depth` 保守（如 1yr）+ 深度回填（10yr）须显式传参 + dry-run 先估配额** | 全 A 股 5400 × 10yr × 多维度 = 巨量 vendor 配额（F4 限频 1000/min 封顶 → 10yr 全量需多日跑）。默认浅回填避免一条命令打爆配额/账单；深回填运维显式 opt-in。`log()` 打印将拉取的请求数估算（无声截断禁止） |
| D6 | 交易日历 vendor | **Lixinger trade-day**（与 EOD 同源，015 port 注释建议） | 同源减少 vendor 面 + 限频共享同一 profile；东财 calendar 备选（FallbackChain seam）。V1 单源 Lixinger |
| D7 | 复权重取触发粒度 | **仅受影响标的 + ex-date 之后区间**（非全量重拉） | 避免一只票多年历史全重拉（配额爆炸，Edge Case）；corp-action 落库后按 instrumentId + min(exDate) 增量重取 |

## Complexity Tracking

| 复杂点 | 必要性 | 控制手段 |
| --- | --- | --- |
| 异构 6 维度管线 | 核心交付（让端点有真数据） | 配置驱动统一 runner（维度只填 SyncDimension 行 + adapter），非 6 套独立代码；复用 015 端口 |
| 分布式锁 | ECS 集群已上线（多实例）安全前提 | hand-roll 最小实现（~50 行）+ 幂等兜底；不引 redlock（D1） |
| 限频跨夜顺延 | vendor 硬约束（F4） | 复用 015 双窗令牌桶 + lastWatermark 水位；V1 无 tier 简化为单序 |
| 复权重取 | 数据正确性（corp-action 后旧复权失效） | 重拉 vendor 已复权（不本地重算，D7 增量区间）|
| **分级（已砍）** | — | clarify 2026-06-03 移除 → 大幅降复杂度（无跨 ctx 读 / 无 syncTier 重算 / 无成员制） |

无 Constitution 违反需 justify。

## Performance Budget

本 feature **无 HTTP 端点**，故无 request-latency budget（spec frontmatter 无 `perf_budgets`）。同步窗口 SLO（observability 目标，非硬门禁）：

- **交易日 gate** 短路 < 1s（非交易日零 vendor 调用）。
- **单维度单标** vendor 往返受 015 双窗令牌桶限频（≤1000/min·36/s）——吞吐受 vendor 封顶，非本地 CPU/IO。
- **全量 delta（增量夜跑）** 目标单窗口内完成 T-市场全 universe 的当日 EOD（~5400 标的，批量 batchSize 摊）；超窗 → lastWatermark 顺延（非失败）。
- **SyncRun 审计**每次执行落一行（scanned/ok/skipped/failed/failedTargets/status）——log-based alerting 入口（failed ≥ 阈值 → ERROR log，照搬 anonymize FAILURE_ALERT_THRESHOLD）。

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略（多 server PR，对齐 §B.5 落地序 + Atomic 原则）

| PR | 范围 | 验证门 |
| --- | --- | --- |
| **PR1** | 3 表 migration + SyncDimension seed（D3）+ `check-server-moat` 登记 3 owner + marketdata.config 同步配置 + 交易日历 live adapter（D6）+ **交易日 gate** | Testcontainers migrate deploy；gate IT（交易日进/非交易日 skip）；moat 0 violation |
| **PR2** | universe live adapter（东财 clist）+ **pinyin 填充**（D2 新依赖）+ 黑名单过滤 | universe upsert 幂等 IT + pinyin 列填充断言 + 黑名单跳过 + env-gated 真东财 IT（skip） |
| **PR3** | `EodSyncPipeline`（profile 富化 + eod/fundamental/financial/corp-action + 复权重取 D7）+ 双窗限频 + per-row 隔离 + SyncRun 水位 + 幂等 | 四类事实落库 IT + 连跑两次无重复 + 单标失败隔离 + 配额耗尽顺延 + HTTP-out-of-tx |
| **PR4** | `EodSyncScheduler`（@Cron + Redis 锁 D1）+ 崩溃恢复 + **backfill CLI**（CLI1 + nx target）| 多实例并发仅一个执行 IT + 锁过期双跑幂等不坏 + 水位续跑 + backfill dry-run + cronExpr 配置化 |

### tasks 拆分锚点

- 每 task 30min–2h、单独 commit、绑定 state_branches 的 IT；TDD 红绿。
- 首 task（PR2）= `pnpm -C apps/server add pinyin-pro`（新依赖，D2）。
- vendor live adapter（universe/calendar）模板 = 015 `eastmoney-search.adapter.ts` + `eastmoney.constraint-profile.ts` + `eastmoney-symbol.rules.ts` / `lixinger-adapter.base.ts`。
- scheduler 模板 = `account/anonymize-frozen-accounts.scheduler.ts`（cron + per-row try/catch + 失败阈值告警）。
- Redis 锁模板 = 无现成；hand-roll（D1），单测 + Testcontainers Redis 集成测。
- **spec drift 锚点**（impl 前 grep 验，per memory `sdd_spec_drift_anchors`）：① Lixinger `/cn/company` 返字段名 `fs_type`（lixinger-adapter.base 已用）；② 东财 clist 端点 `m:0/1/2` 真实响应结构（env-gated 真 IT 验）；③ `DailyBar` 唯一键 `(instrumentId, tradeDate, adjust)`（015 已建，复权重取依赖）；④ `createMany skipDuplicates` 在 adapter-pg + Serializable 下的语义（memory `prisma_serializable_p2002_and_p2034` — 若用高隔离级须 retry）。

### Out of Scope 再确认（→ 后续 feature）

重要度分级（syncTier 重算 + 跨 ctx 读 portfolio 并集，待 watchlist/holdings）/ 实时报价同步 / SyncDimension 管理界面 / 港美股事实 / 分区+Parquet 冷存实装。
