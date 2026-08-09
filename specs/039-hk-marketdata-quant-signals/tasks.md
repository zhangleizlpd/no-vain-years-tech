---
feature_id: 039-hk-marketdata-quant-signals
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: 2026-07-13
---

# Tasks: 039-hk-marketdata-quant-signals（港股量化高信号：做空 / 南向 / 所属指数 / 基金持股）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `039-hk-marketdata-quant-signals`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 日频高信号 / US2 机构持仓 / US3 指数成分 / US4 回填 pacing+无回归）；Foundational / Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Verify]`（**纯 server 数据摄取，无新读端点 → 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`**，plan §Constitution V）
- **单 PR**（一 feature = 一分支 = 一 PR）；Phase = 逻辑 task 组（非 PR 拆）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；落库/marketScope/幂等/覆盖式 = Testcontainers PG（run via `nx test server <file>`，cwd=apps/server，memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（adapter 请求/解析）= vitest 无 DB；**每 Phase 末单列 `[Server-IT]`**；vendor 契约 = mock 单测 + env-gated 真 vendor IT（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`，默认 skip）
- **13 条 `state_branches`（spec frontmatter）逐条须在 IT 有 `it()`**（覆盖矩阵见文末）
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`（nx cache 对新文件可能假绿）

## Path Conventions

- server：`apps/server/src/marketdata/`（扁平文件平铺，ADR-0043，改动全在 marketdata 单 bounded context 内）
- migration：`apps/server/prisma/migrations/20260713_XXXX_create_hk_quant_signal_tables/`（**expand-only**，5 `CREATE TABLE` + FK + seed + soft 边，`migration_refs` frontmatter ADR-0035）
- IT：`apps/server/test/integration/marketdata.hk-039.*.it.spec.ts`
- 本地起服/IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`（memory `local_it_smoke_needs_env_unset_oss`）；dev DB `docker compose -f docker-compose.dev.yml up -d --wait`（mbw-poc-postgres:5433 / redis:6380）
- **前置就绪**：p1（038）平台已上 prod（v0.15.4）；HK 付费包已订阅；5 端点 PoC 已实测（见 p2 探查报告）

---

## Phase 1: 数据层地基（5 张 market-agnostic 事实表 + 1 migration + 5 seed 行 + 5 soft 边）🎯

**Independent Test**: Testcontainers PG `migrate deploy` → 5 表 + 唯一键 + instrument FK cascade 存在；5 `sync_dimension` 行 `market_scope={hk}` + `history_depth`（fund=1825 / daily=3650 / index=NULL）+ freshness 画像；5 条 `universe→dim` soft 边落库。**纯数据层，不动 TS executor ⇒ 立即编译绿**。

- [X] T001 [Server] **5 Prisma model + Instrument 反向关系**：`apps/server/prisma/schema.prisma` 新增 `ShortSellingDaily(instrumentId,date)` / `ConnectHoldingDaily(instrumentId,date)` / `IndexMembership(instrumentId,indexCode)` / `FundHolding(instrumentId,reportDate,fundCode)` / `FundCompanyHolding(instrumentId,reportDate,fundCollectionCode)`，各 `@@schema("marketdata")` + `instrumentId BigInt @map("instrument_id")` + `instrument Instrument @relation(...,onDelete:Cascade)` + `@@unique([自然键])`；**Instrument model 加 5 行反向关系**；金融数值一律 `Decimal?`（禁 Float：份额 `@db.Decimal(20,0)` / 金额 `@db.Decimal(24,2)` / 比率 `@db.Decimal(10,4)`，样板 `FundamentalSnapshot`）→ verify: `prisma validate` + `prisma generate` + `nx typecheck server` 绿
- [X] T002 [Server] **1 migration（expand-only）**：`apps/server/prisma/migrations/20260713_XXXX_create_hk_quant_signal_tables/migration.sql`：5 `CREATE TABLE`（BIGSERIAL id + instrument_id + 自然键列 + `CREATE UNIQUE INDEX` + `ADD CONSTRAINT ..._fkey FOREIGN KEY(instrument_id) REFERENCES marketdata.instrument(id) ON DELETE CASCADE`，单表样板 `20260605_0300_...:16-33`）+ 顶部 `-- migration_refs: specs/039-hk-marketdata-quant-signals` + **5 `sync_dimension` seed 行**（`INSERT ... ON CONFLICT(dimension_key) DO NOTHING`：`market_scope='{hk}'` / `history_depth`（3650/3650/1825/1825/NULL）/ `priority`（4/3/2/1/0）/ freshness_profile / sla_hours / calendar_source，模板 `20260603_0030_...:71-80` + 三画像列 `20260605_0300_...:40-45`）+ **5 `universe→dim` soft 边**（模板 `20260604_1210_...:34-42`）+ `prisma migrate deploy` dev DB → verify: 无 drift、幂等重 deploy
- [X] T003 [Server-IT] **Phase 1 schema IT**（Testcontainers PG）：`migrate deploy` → 5 表 + 唯一约束 + FK cascade（删 instrument 连带删）+ 5 seed 行断言（marketScope=['hk'] / history_depth / priority）+ 5 soft 边。`test/integration/marketdata.hk-039.schema.it.spec.ts`。**覆盖 state_branch**: `5 张新表 market-agnostic` / `依赖 universe` / `5 维度 marketScope 纳入`（seed 层）

---

## Phase 2: US1 日频高信号（short_selling + connect_holding，照抄 eod_bar 区间形态）🏁 MVP

**US1 Independent Test**: Testcontainers PG（test-local mock hk adapter，埋 `rangeCalls` 计数）；① short_selling backfill → `short_selling_daily` 多年日频行，连跑两次幂等不翻倍；② connect_holding → 港股通标的落 shareholdings；③ 非港股通标的 vendor 返 0 行 → 不写库、stats 不计 failed、不阻塞其余标的；④ 请求体单数 stockCode。

- [X] T004 [P] [US1] [Server] **short_selling adapter 层**：`short-selling.port.ts`（`SHORT_SELLING_PORT` + `getShortSellingRange(q):ShortSellingPoint[]` 升序）+ `marketdata.types.ts` 加 `ShortSellingRangeQuery`+`ShortSellingPoint`（shares/amount `string|null`）+ `lixinger-short-selling.adapter.ts`（`extends LixingerAdapterBase`；`post('/${market}/company/short-selling',{stockCode,startDate,endDate?})` **单数**，解析 date/shares/amount，不用 metricsList/fsType/Prisma）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体=单数 stockCode + 升序解析 + `marketdata.lixinger-vendor.it.spec.ts` 加 skipIf 真 vendor it
- [X] T005 [P] [US1] [Server] **connect_holding adapter 层**：`connect-holding.port.ts` + types `ConnectHoldingRangeQuery`+`ConnectHoldingPoint`（shareholdings `string|null`）+ `lixinger-connect-holding.adapter.ts`（`post('/${market}/company/mutual-market',{stockCode,startDate,endDate?})`；vendor 0 行 → 返 `[]`）→ verify: adapter spec 验请求体 + **空返回→`[]` 不崩** + env-gated 真 vendor it
- [X] T006 [US1] [Server] **装配 short_selling 维度**（key+entry 同 commit 保 exhaustive）：`dimension-executor.ts` `DIMENSION_KEYS` += `'short_selling'` + 构造器 `@Inject(SHORT_SELLING_PORT)` + `buildExecutors` 加 `factExecutor('short_selling',…)` + `syncShortSelling`（照 `syncEodBars`：`from = mode==='backfill' ? subtractDays(asOf,depth) : targetDate`；delta 跳已落日 / backfill 全量；per-instrument `getShortSellingRange` → `createMany({skipDuplicates})` on (instrumentId,date)；backfill 前 `await this.backfillPacer.pace()`）+ `mock-market-data.adapter.ts` `implements ShortSellingPort` + cn:600519 fixture + `marketdata.module.ts` provider 工厂（无-Prisma，样板 `:85-92`）→ verify: `dimension-executor.spec.ts`（mock port，delta/backfill 两分支 + 幂等）
- [X] T007 [US1] [Server] **装配 connect_holding 维度**：同 T006 形态（`syncConnectHolding` 落 (instrumentId,date)；**空返回→零 createMany 行、stats.ok 非 failed**）+ mock + module 工厂 → verify: `dimension-executor.spec.ts`（含非港股通标的空返回不写库不崩）
- [X] T008 [US1] [Server-IT] **US1 集成 IT**（Testcontainers PG，test-local mock hk 埋 `rangeCalls`，`buildRegistry` 手工装配，骨架照 `marketdata.hk-038.fundamental-financial.it.spec.ts`）：short_selling/connect_holding hk backfill 落库 + 连跑两次幂等 + 非港股通 0 行容错 + 请求走区间。`test/integration/marketdata.hk-039.daily-signals.it.spec.ts`。**覆盖 state_branch**: `做空 hk 日频回填` / `南向持股 hk 日频回填` / `南向非成分标的空数据` / `param 单数 stockCode`（executor）/ `5 维度 marketScope 纳入`

---

## Phase 3: US2 机构持仓（fund_holding + fund_company_holding，照抄 financials range + 大表裁剪）

**US2 Independent Test**: Testcontainers PG（mock hk）；① fund_holding backfill → `(instrumentId,reportDate,fundCode)` 多期×多基金行，缺字段（`proportionOfOutstandingSharesA` 等）存 null；② fund_company_holding → `(instrumentId,reportDate,fundCollectionCode)` 多行；③ 大表按 `BACKFILL_ROW_CHUNK=500` 分片 tx；④ `from = asOf−5yr`（history_depth=1825）；⑤ 幂等。

- [X] T009 [P] [US2] [Server] **fund_holding adapter 层**：`fund-holding.port.ts` + types `FundHoldingRangeQuery`+`FundHoldingDto`（holdings/marketCap/netValueRatio/marketCapRank/declarationDate/fundCode/name，数值 `string|null`）+ `lixinger-fund-holding.adapter.ts`（`post('/${market}/company/fund-shareholders',{stockCode,startDate,endDate?})` 单数；date→reportDate；**含 `proportionOfOutstandingSharesA`(名带 A，hk 返 null) 存 null 不因命名丢弃**）→ verify: adapter spec 验请求体 + 缺字段→null + env-gated 真 vendor it
- [X] T010 [P] [US2] [Server] **fund_company_holding adapter 层**：`fund-company-holding.port.ts` + types `FundCompanyHoldingRangeQuery`+`FundCompanyHoldingDto`（marketCap/holdings/name/fundCollectionCode）+ `lixinger-fund-company-holding.adapter.ts`（`post('/${market}/company/fund-collection-shareholders',{stockCode,startDate,endDate?})`）→ verify: adapter spec + env-gated 真 vendor it
- [X] T011 [US2] [Server] **装配 fund_holding 维度**（大表）：`DIMENSION_KEYS += 'fund_holding'` + `@Inject(FUND_HOLDING_PORT)` + `buildExecutors` entry + `syncFundHolding`（照 `backfillFinancials` 但：`from` 取 `dim.historyDepth`(=1825) → per-instrument `getFundHoldingRange` → **`chunked(rows,BACKFILL_ROW_CHUNK)` 每片一 `$transaction` createMany(skipDuplicates)** on (instrumentId,reportDate,fundCode)；`backfillPacer.pace()` per-stock；可选 `coveredFundHoldingIds` skip-complete 游标）+ mock + module 工厂 → verify: `dimension-executor.spec.ts`（多期×多基金落库 + 5yr from + 缺字段 null + chunk 分片）
- [X] T012 [US2] [Server] **装配 fund_company_holding 维度**：同 T011（`syncFundCompanyHolding` 落 (instrumentId,reportDate,fundCollectionCode)，history_depth=1825）+ mock + module → verify: `dimension-executor.spec.ts`
- [X] T013 [US2] [Server-IT] **US2 集成 IT**（Testcontainers PG，mock hk）：两维度报告期 backfill 多行 upsert + 字段缺失 null + `from`=asOf−5yr（断言 `rangeCalls[0].from` 距 asOf ≈1825d，非 10yr）+ 幂等连跑不翻倍。`test/integration/marketdata.hk-039.fund-holding.it.spec.ts`。**覆盖 state_branch**: `公募基金持股报告期回填` / `基金公司持股报告期回填` / `vendor 字段缺失` / `param 单数 stockCode`（executor）

---

## Phase 4: US3 指数成分归属（index_membership，覆盖式快照 — 第 3 种形态）

**US3 Independent Test**: Testcontainers PG（mock hk）；① index_membership 运行 → `(instrumentId,indexCode)` 落当前所属多指数行；② 再次运行归属集合变化 → **覆盖式**反映最新（旧归属消失被删）；③ 无日期（非日频 append）。

- [X] T014 [P] [US3] [Server] **index_membership adapter 层**（无 date 快照）：`index-membership.port.ts`（`getIndexMembership(symbol):IndexMembershipDto[]` — **无 range/from/to**）+ types `IndexMembershipDto`（indexCode〔=vendor `stockCode` 字段〕/name/source/areaCode）+ `lixinger-index-membership.adapter.ts`（`post('/${market}/company/indices',{stockCode})` 单数、**无日期**）→ verify: adapter spec 验请求体无日期 + env-gated 真 vendor it
- [X] T015 [US3] [Server] **装配 index_membership 维度**（覆盖式，executor 形态异于其他）：`DIMENSION_KEYS += 'index_membership'` + `@Inject(INDEX_MEMBERSHIP_PORT)` + `buildExecutors` entry（仍走 `factExecutor` 继承 marketScope/tier 序）+ `syncIndexMembership`（**无 mode 分支**：恒取当前全量快照；per-instrument 单 `$transaction` 内 `deleteMany({instrumentId})` + `createMany(newSet)` 覆盖；vendor 抛错 → 捕获计 failed、**不 mutate**；`backfillPacer.pace()` per-stock）+ mock + module 工厂 → verify: `dimension-executor.spec.ts`（初次落 N 行 → 变更集合再跑 → 旧行删、新行在、幂等同集合不翻倍）
- [X] T016 [US3] [Server-IT] **US3 集成 IT**（Testcontainers PG，mock hk）：index_membership 落当前所属集合 + 覆盖式（第二次不同集合 → 反映最新、旧归属消失）+ 幂等。`test/integration/marketdata.hk-039.index-membership.it.spec.ts`。**覆盖 state_branch**: `所属指数快照覆盖`

---

## Phase 5: US4 回填 pacing + 全绿门 + 无回归

**US4 Independent Test**: Testcontainers PG（+Redis 若测队列串行）；① `backfill --dimension short-selling --markets hk --dry-run` 估算量级吻合、按 hk 过滤；② 5 维度 backfill 自限速 ~10/s + jitter、sustained ≤ ~600/min、不触 429；③ 中断后按自然键幂等续跑；④ p1 核心 6 维 + A 股既有 IT/单测零回归。

- [X] T017 [US4] [Server] **dry-run 估算纳入 5 新维度**：`marketdata-backfill.cli.ts` `estimateRequests` 把 5 新维度按 per-stock 区间（active count × 1/维度）计入；`--dimension <新键>` 由 `DIMENSION_KEYS` 校验天然支持（零改）→ verify: `marketdata-backfill.cli.spec.ts`（`--markets hk` 估算含 5 新维度、按 hk 过滤）
- [X] T018 [US4] [Server-IT] **pacing + 续跑 + 无回归 IT**（Testcontainers PG+Redis）：backfill 自限速 sustained ≤ 目标 + jitter 打散（5 维度 backfill 循环均 `pace()`）+ 中断后按自然键幂等续跑 + **p1/A股无回归**（5 新维度不改 6 维 delta/backfill 与 A 股行为，既有 `marketdata.hk-038.*` + `marketdata.dimension-*` IT 全绿）。`test/integration/marketdata.hk-039.backfill-pacing.it.spec.ts`。**覆盖 state_branch**: `回填自限速续跑` / `p1/A股无回归` / `5 维度 marketScope 纳入`（全工作集）
- [X] T019 [Verify] **全绿门 + 真数据契约**：`nx affected -t lint typecheck test build --base=origin/main` 全绿（`--skip-nx-cache` 首跑）+ `check-server-moat.ts` 关（5 表 intra-marketdata FK、无新 cross-context owner）+ **端到端 hk 真数据 smoke**：`MARKETDATA_PROVIDER=live` + `LIXINGER_TOKEN` 跑缩减集（`hk:00700` short_selling/connect_holding + `hk:00823` fund_holding backfill）→ 抽样核对理杏仁网站一致（SC-001/002）+ 5 个 `marketdata.lixinger-vendor.it.spec.ts` env-gated 契约转真调确认单数 param/字段 schema + 回写 plan §Deferred-probes（fund 量级 / index 空返回语义 / Decimal 精度）。**⚠️ 全量多夜回填 = 后续 ops（master INV-3），非本 PR 范围**
  - ✅ **实测**（真 token 打理杏仁）：vendor IT 12 真调 **11 绿**，5 个 039 新维度契约（单数 param + 字段 schema + 非空 + 数字串）全证实；样本股实际全用 `hk:00700`（含 fund_holding，随 coded spec，非 task 文本的 `00823`）。全绿门 + `check-server-moat` 0 违规。抽样值 + Decimal/量级/HSI 探查回写 [plan §Deferred-probes](plan.md#L55)。
  - ⚠️ **唯一非绿（正交 016 遗留，非 039）**：`trading-calendar` 真调 `/{market}/index/candlestick` 返 **403 付费墙**（`ForbiddenError: Exceed maximum access time, please purchase Open API`）；039 backfill 路径不碰 trading-calendar，零影响。详见 plan §Deferred-probes #5。

---

## Dependencies & 执行顺序

```
Phase 1 地基（T001 schema → T002 migration → T003 schema IT）
  ↓（migrate deploy 是所有 Phase IT 前置；纯数据层立即编译绿）
Phase 2 US1 日频〔MVP〕（T004[P] ∥ T005[P] adapter → T006 装配 short → T007 装配 connect → T008 IT）
  ↓
Phase 3 US2 基金（T009[P] ∥ T010[P] adapter → T011 装配 fund → T012 装配 fund_company → T013 IT）
  ↓
Phase 4 US3 指数（T014[P] adapter → T015 装配 → T016 IT）
  ↓
Phase 5（T017 估算 → T018 pacing/无回归 IT → T019 全绿门）
```

- **硬前置**：Phase 1（migration）→ 全部 Phase IT；每维度 adapter（`[P]`）→ 其装配 task。
- **可并行 `[P]`**：同 Phase 内不同 adapter 文件（T004∥T005、T009∥T010）。
- **必串行**：所有装配 task 改 `dimension-executor.ts`/`marketdata.module.ts` **同文件** ⇒ 顺序化（exhaustive Record 每次 +1 key+1 entry 才编译绿）。
- **关键路径** = T001→T002→(T004→T006)→(T009→T011)→(T014→T015)→T018→T019。
- **MVP** = Phase 1 + Phase 2（日频高信号落库即「做空/南向可回测」）。

## state_branch 覆盖矩阵（13 条 → IT task）

| state_branch | IT task |
| --- | --- |
| 做空 hk 日频回填 | T008 |
| 南向持股 hk 日频回填 | T008 |
| 南向非成分标的空数据 | T008（+ T005 adapter 层） |
| 所属指数快照覆盖 | T016 |
| 公募基金持股报告期回填 | T013 |
| 基金公司持股报告期回填 | T013 |
| param 单数 stockCode 请求形态 | T004/T005/T009/T010/T014（adapter 单测）+ T008/T013/T016（executor）+ T019（真 vendor） |
| 5 维度 marketScope 纳入 | T003（seed）/ T008 / T018（全工作集） |
| 5 张新表 market-agnostic | T003 |
| 依赖 universe | T003（soft 边） |
| vendor 字段缺失存 null | T013（+ T009 adapter 层） |
| 回填自限速续跑 | T017（估算）/ T018（限速+续跑） |
| p1/A股无回归 | T018 / T019 |

## 单 PR（Constitution §V）

默认单 PR（5 维度 6 件套 ×5）。若 impl 中发现 PR 过大需增量隔离：Phase 1（schema 地基，编译绿）可单独先 ship 验稳，Phase 2-5（各维度装配）第二个 PR —— task 边界已按 Phase 对齐。
