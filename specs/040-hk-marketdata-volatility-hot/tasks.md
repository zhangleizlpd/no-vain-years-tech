---
feature_id: 040-hk-marketdata-volatility-hot
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: 2026-07-14
---

# Tasks: 040-hk-marketdata-volatility-hot（港股波动率日频 + 热度精选快照）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `040-hk-marketdata-volatility-hot`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 波动率日频历史 / US2 热度精选快照）；Foundational / Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Verify]`（**纯 server 数据摄取，无新读端点 → 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]`**，plan §Constitution V）
- **单 PR**（一 feature = 一分支 = 一 PR）；Phase = 逻辑 task 组（非 PR 拆）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；落库/marketScope/幂等/累积语义 = Testcontainers PG（run via `nx test server <file>`，cwd=apps/server，memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（adapter 请求/解析）= vitest 无 DB；**每 Phase 末单列 `[Server-IT]`**；vendor 契约 = mock 单测 + env-gated 真 vendor IT（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`，默认 skip）
- **14 条 `state_branches`（spec frontmatter）逐条须在 IT 有 `it()`**（覆盖矩阵见文末）
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`（nx cache 对新文件可能假绿）

## Path Conventions

- server：`apps/server/src/marketdata/`（扁平文件平铺，ADR-0043，改动全在 marketdata 单 bounded context 内）
- migration：`apps/server/prisma/migrations/20260714_XXXX_create_hk_volatility_hot_tables/`（**expand-only**，2 `CREATE TABLE` + FK + 2 seed + 2 soft 边，`migration_refs` frontmatter ADR-0035）
- IT：`apps/server/test/integration/marketdata.hk-040.*.it.spec.ts`
- 本地起服/IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`（memory `local_it_smoke_needs_env_unset_oss`）；dev DB `docker compose -f docker-compose.dev.yml up -d --wait`（mbw-poc-postgres:5433 / redis:6380）
- **前置就绪**：p1（038）平台 + p2（039）已上 prod（v0.16.0）；HK 付费包已订阅；波动率 + 热度 2 端点 PoC 已实测（见 [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md)）

---

## Phase 1: 数据层地基（2 张 market-agnostic 事实表 + 1 migration + 2 seed 行 + 2 soft 边）🎯

**Independent Test**: Testcontainers PG `migrate deploy` → 2 表 + 唯一键 + instrument FK cascade 存在；2 `sync_dimension` 行 `market_scope={hk}` + `history_depth`（volatility=3650 / hot_snapshot=NULL）+ freshness 画像；2 条 `universe→dim` soft 边落库。**纯数据层，不动 TS executor ⇒ 立即编译绿**。

- [X] T001 [Server] **2 Prisma model + Instrument 反向关系**：`apps/server/prisma/schema.prisma` 新增 `VolatilityDaily(instrumentId,date,volatilityDays)` + `HotSnapshot(instrumentId,hotType,dataDate)`，各 `@@schema("marketdata")` + `instrumentId BigInt @map("instrument_id")` + `instrument Instrument @relation(...,onDelete:Cascade)` + `@@unique([自然键])`；VolatilityDaily：`volatilityDays Int` + `value Decimal? @db.Decimal(12,8)`（禁 Float，样板 `DailyBar`）；HotSnapshot：`hotType String @map("hot_type")` + `dataDate DateTime @map("data_date") @db.Date` + `payload Json`（异构字段整存，样板 `CorporateAction.payload`，`schema.prisma:438-444`）；**Instrument model 加 2 行反向关系** → verify: `prisma validate` + `prisma generate` + `nx typecheck server` 绿
- [X] T002 [Server] **1 migration（expand-only）**：`apps/server/prisma/migrations/20260714_XXXX_create_hk_volatility_hot_tables/migration.sql`：2 `CREATE TABLE`（BIGSERIAL id + instrument_id + 自然键列 + `CREATE UNIQUE INDEX` + `ADD CONSTRAINT ..._fkey FOREIGN KEY(instrument_id) REFERENCES marketdata.instrument(id) ON DELETE CASCADE`，样板 039 `20260713_XXXX_create_hk_quant_signal_tables`）+ 顶部 `-- migration_refs: specs/040-hk-marketdata-volatility-hot` + **2 `sync_dimension` seed 行**（`INSERT ... ON CONFLICT(dimension_key) DO NOTHING`：`market_scope='{hk}'` / `history_depth`（volatility=3650 / hot_snapshot=NULL）/ `priority` / freshness_profile / sla_hours / calendar_source）+ **2 `universe→dim` soft 边**（`universe→volatility` / `universe→hot_snapshot`）+ `prisma migrate deploy` dev DB → verify: 无 drift、幂等重 deploy
- [X] T003 [Server-IT] **Phase 1 schema IT**（Testcontainers PG）：`migrate deploy` → 2 表 + 唯一约束（volatility `(instrumentId,date,volatilityDays)` / hot `(instrumentId,hotType,dataDate)`）+ FK cascade（删 instrument 连带删）+ 2 seed 行断言（marketScope=['hk'] / history_depth：volatility=3650、hot_snapshot=null）+ 2 soft 边。`test/integration/marketdata.hk-040.schema.it.spec.ts`。**覆盖 state_branch**: `2 张新表 market-agnostic` / `依赖 universe` / `2 维度 marketScope 纳入`（seed 层）

---

## Phase 2: US1 波动率日频（volatility，照抄 eod_bar 区间形态 × 多窗口循环）🏁 MVP

**US1 Independent Test**: Testcontainers PG（test-local mock hk adapter，埋 `rangeCalls` 计数）；① volatility backfill → `volatility_daily` 多年日频行，连跑两次幂等不翻倍；② 配置 3 窗口（30/60/250）→ 同一 `(instrumentId,date)` 出 3 行（每窗口一行）；③ 请求体单数 stockCode + `volatilityDays` number 单数（非数组）；④ `from = asOf−historyDepth`（10yr 回填）。

- [X] T004 [P] [US1] [Server] **volatility adapter 层**：`volatility.port.ts`（`VOLATILITY_PORT` + `getVolatilityRange(q):VolatilityPoint[]` 升序）+ `marketdata.types.ts` 加 `VolatilityRangeQuery`（含 `volatilityDays:number` 单数）+`VolatilityPoint`（value `string|null`）+ `lixinger-volatility.adapter.ts`（`extends LixingerAdapterBase`；`post('/${market}/company/volatility',{stockCode,startDate,endDate?,volatilityDays})` **单数 stockCode + volatilityDays number**，解析 `{date,value}`，不用 metricsList/fsType/Prisma；`VOLATILITY_WINDOWS=[30,60,250]` 常量）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体=单数 stockCode + `volatilityDays` 为 number（非数组）+ 升序解析 + `marketdata.lixinger-vendor.it.spec.ts` 加 skipIf 真 vendor it。**注**：`DIMENSION_KEYS += 'volatility'` 移至 T005（与 `buildExecutors` entry 同 commit，保 exhaustive Record 每 commit typecheck 绿，plan Decision 1 铁律）
- [X] T005 [US1] [Server] **装配 volatility 维度**（`DIMENSION_KEYS += 'volatility'` + `buildExecutors` entry **同 commit** 保 exhaustive Record typecheck 绿）：`dimension-executor.ts` 构造器 `@Inject(VOLATILITY_PORT)`（尾部 null-object 默认）+ `buildExecutors` 加 `factExecutor('volatility',…)` + `syncVolatility`（照 `syncEodBars`：`from = mode==='backfill' ? subtractDays(asOf,depth) : targetDate`；**对 `VOLATILITY_WINDOWS=[30,60,250]`（adapter 常量，照 039 `FUNDAMENTAL_METRICS`）循环、每窗口一 `getVolatilityRange` → `createMany({skipDuplicates})` on (instrumentId,date,volatilityDays)**；backfill **每窗口** `await this.backfillPacer.pace()`（3× 请求数须 3× 节流，plan Decision 4；pacer 契约「每次 vendor 调用前 await」）；delta 多窗口 pending-skip 全窗覆盖才跳）+ `mock-market-data.adapter.ts` `implements VolatilityPort` + cn:600519 fixture + `marketdata.module.ts` provider 工厂（无-Prisma）→ verify: `dimension-executor.spec.ts`（mock port，delta/backfill 两分支 + 每窗口一请求 + 行含 volatilityDays + 部分窗口 pending 语义）
- [X] T006 [US1] [Server-IT] **US1 集成 IT**（Testcontainers PG，test-local mock hk 埋 `rangeCalls`，`buildRegistry` 手工装配，骨架照 `marketdata.hk-039.daily-signals.it.spec.ts`）：volatility hk backfill 多年日频落库 + 连跑幂等 + 3 窗口每窗口成行（同 date 3 行）+ 请求单数 stockCode/volatilityDays number + `from`=asOf−10yr（seed historyDepth 驱动）+ marketScope={hk} 纳 hk 排除 cn。`test/integration/marketdata.hk-040.volatility.it.spec.ts`（5 it 全绿）。**覆盖 state_branch**: `波动率日频回填` / `波动率多窗口` / `波动率历史深度` / `param 契约三分`（volatility 侧，executor）/ `2 维度 marketScope 纳入`

---

## Phase 3: US2 热度精选快照（hot_snapshot，快照 upsert × type 循环 × payload Json — 第 2 种形态）

**US2 Independent Test**: Testcontainers PG（mock hk）；① hot_snapshot 4 type（ss/tr/capita/rep）运行 → `(instrumentId,hotType,dataDate)` 落行，payload 存 vendor 原始异构字段；② 相同 `last_data_date` 再跑 → 覆盖同行不新增；③ `last_data_date` 变 → 落新行（累积前向序列）；④ 请求体 `stockCodes[]` 数组；⑤ `hot/rep` 含异常 key `"undefined"` → 忽略不崩。

- [X] T007 [P] [US2] [Server] **hot_snapshot adapter 层**：`hot-snapshot.port.ts`（`HOT_SNAPSHOT_PORT` + `getHotSnapshot(q):HotSnapshotDto[]` — **快照无 range/from/to**）+ types `HotSnapshotQuery`（`hotType` + `stockCodes[]`）+`HotSnapshotDto`（hotType/dataDate〔=vendor `last_data_date`〕/payload）+ `DIMENSION_KEYS += 'hot_snapshot'` + `lixinger-hot.adapter.ts`（`post('/${market}/company/hot/${hotType}',{stockCodes})` **数组**、无日期；payload=vendor 原始字段整存、**解析忽略 `undefined` key**；`last_data_date`→dataDate）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体=`stockCodes[]` 数组 + payload 原样存 + 忽略 `undefined` key + env-gated 真 vendor it（4 type）
- [X] T008 [US2] [Server] **装配 hot_snapshot 维度**（快照累积，executor 形态异于 volatility）：`dimension-executor.ts` 构造器 `@Inject(HOT_SNAPSHOT_PORT)` + `buildExecutors` 加 entry（仍走 `factExecutor` 继承 marketScope/tier 序）+ `syncHotSnapshot`（**无 mode 分支**：对 `HOT_TYPES=['ss','tr','capita','rep']`（adapter 常量）循环、每 type 拉当前快照 → 按自然键 `(instrumentId,hotType,dataDate)` **upsert**（数据日期未变=覆盖同行、变=落新行）；vendor 抛错 → 计 failed 不 mutate；`backfillPacer.pace()` per-stock）+ mock（`implements HotSnapshotPort` + 4 type fixture）+ module 工厂 → verify: `dimension-executor.spec.ts`（多 type 循环 + 按 dataDate upsert：同 dataDate 覆盖、变则新行 + payload 存异构 + 幂等）
- [X] T009 [US2] [Server-IT] **US2 集成 IT**（Testcontainers PG，mock hk，固定 mock `last_data_date` 驱累积/覆盖两分支）：4 type 落库 + 按 dataDate 累积（同 dataDate 覆盖、变则新行）+ payload 异构存原始字段 + 忽略 `undefined` key + 幂等。`test/integration/marketdata.hk-040.hot-snapshot.it.spec.ts`。**覆盖 state_branch**: `热度快照按数据日期累积` / `热度不可回填` / `热度精选 type` / `hot payload 异构` / `vendor 数据质量容错` / `param 契约三分`（hot 侧）

---

## Phase 4: 回填 pacing + 全绿门 + 无回归

**US Independent Test**: Testcontainers PG（+Redis 若测队列串行）；① `backfill --dimension volatility --markets hk --dry-run` 估算量级吻合（×3 窗口）、按 hk 过滤；② 波动率 backfill 自限速 ~10/s + jitter、sustained ≤ ~600/min、不触 429；③ 中断后按自然键幂等续跑；④ p1（6 维）/ p2（5 维）+ A 股既有 IT/单测零回归。

- [X] T010 [Server] **dry-run 估算纳入 volatility**：`marketdata-backfill.cli.ts` `estimateRequests` 把 volatility 按 per-stock 区间 **× 窗口数（3）** 计入；`--dimension volatility` 由 `DIMENSION_KEYS` 校验天然支持（零改）。⚠️ **hot_snapshot 是快照非历史回填**（history_depth=NULL）→ 不入 backfill 历史估算（其新鲜度靠 delta/tick 每日拉当前快照累积，非回填）→ verify: `marketdata-backfill.cli.spec.ts`（`--markets hk` 估算含 volatility×3 窗口、按 hk 过滤、hot_snapshot 不计历史回填）
- [X] T011 [Server-IT] **pacing + 续跑 + 无回归 IT**（Testcontainers PG+Redis）：volatility backfill 自限速 sustained ≤ 目标 + jitter 打散（多窗口循环均 `pace()`）+ 中断后按自然键幂等续跑 + **p1/p2/A股无回归**（2 新维度不改 11 维 delta/backfill 与 A 股行为，既有 `marketdata.hk-038.*` + `marketdata.hk-039.*` + `marketdata.dimension-*` IT 全绿）。`test/integration/marketdata.hk-040.backfill-pacing.it.spec.ts`。**覆盖 state_branch**: `回填自限速续跑` / `p1/p2/A股无回归` / `2 维度 marketScope 纳入`（全工作集）
- [X] T012 [Verify] **全绿门 + 真数据契约**：`nx affected -t lint typecheck test build --base=origin/main` 全绿（`--skip-nx-cache` 首跑）+ `check-server-moat.ts` 关（2 表 intra-marketdata FK、无新 cross-context owner）+ **端到端 hk 真数据 smoke**：`MARKETDATA_PROVIDER=live` + `LIXINGER_TOKEN` 跑缩减集（`hk:00700` volatility 3 窗口 backfill + hot 4 type 快照）→ 抽样核对理杏仁一致（SC-001/002）+ 2 个 `marketdata.lixinger-vendor.it.spec.ts` env-gated 契约转真调确认 param 契约（volatility 单数+volatilityDays number / hot 数组）+ 字段 schema + 回写 plan §Deferred-probes（波动率精度/量级 / hot payload 字段与 probe 一致 / dataDate 跨 type 语义）。**⚠️ 全量多夜回填 = 后续 ops（master INV-3），非本 PR 范围**

---

## Dependencies & 执行顺序

```
Phase 1 地基（T001 schema → T002 migration → T003 schema IT）
  ↓（migrate deploy 是所有 Phase IT 前置；纯数据层立即编译绿）
Phase 2 US1 波动率〔MVP〕（T004[P] adapter → T005 装配 → T006 IT）
  ↓
Phase 3 US2 热度（T007[P] adapter → T008 装配 → T009 IT）
  ↓
Phase 4（T010 估算 → T011 pacing/无回归 IT → T012 全绿门）
```

- **硬前置**：Phase 1（migration）→ 全部 Phase IT；每维度 adapter（`[P]`）→ 其装配 task。
- **可并行 `[P]`**：T004（volatility adapter）∥ T007（hot adapter）= 不同文件、互不依赖（跨 Phase 但纯 adapter 层可并行编写）。
- **必串行**：装配 task（T005 / T008）均改 `dimension-executor.ts`/`marketdata.module.ts` **同文件** ⇒ 顺序化（exhaustive Record 每次 +1 entry 才编译绿；key 在各自 adapter task T004/T007 加）。
- **关键路径** = T001→T002→(T004→T005)→(T007→T008)→T011→T012。
- **MVP** = Phase 1 + Phase 2（波动率日频历史落库即「波动率因子可回测」）。

## state_branch 覆盖矩阵（14 条 → IT task）

| state_branch | IT task |
| --- | --- |
| 波动率日频回填 | T006 |
| 波动率多窗口 | T006 |
| 波动率历史深度 | T006 |
| 热度快照按数据日期累积 | T009 |
| 热度不可回填 | T009 |
| 热度精选 type | T009（+ T008 executor type 循环） |
| param 契约三分 | T004/T007（adapter 单测）+ T006/T009（executor）+ T012（真 vendor） |
| hot payload 异构 | T009（+ T007 adapter 层） |
| vendor 数据质量容错 | T009（+ T007 adapter 忽略 undefined key） |
| 2 维度 marketScope 纳入 | T003（seed）/ T006 / T011（全工作集） |
| 2 张新表 market-agnostic | T003 |
| 依赖 universe | T003（soft 边） |
| 回填自限速续跑 | T010（估算）/ T011（限速+续跑） |
| p1/p2/A股无回归 | T011 / T012 |

## 单 PR（Constitution §V）

默认单 PR（2 维度 6 件套 ×2）。若 impl 中发现 PR 过大需增量隔离：Phase 1（schema 地基，编译绿）可单独先 ship 验稳，Phase 2-4（各维度装配）第二个 PR —— task 边界已按 Phase 对齐。
