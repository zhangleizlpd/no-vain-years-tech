---
feature_id: 043-hk-marketdata-classification-text
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: 2026-07-15
---

# Tasks: 043-hk-marketdata-classification-text（港股分类文本 2 维度：所属行业 / 公告）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `043-hk-marketdata-classification-text`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 所属行业 / US2 公告）；Foundational / Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Verify]`（**纯 server 数据摄取，无新读端点 → 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]`**，plan §Constitution V）
- **单 PR**（一 feature = 一分支 = 一 PR）；Phase = 逻辑 task 组（非 PR 拆）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；落库/marketScope/幂等/覆盖式替换/空返回不 wipe = Testcontainers PG（run via `nx test server <file>`，cwd=apps/server，memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（adapter 请求/解析）= vitest 无 DB；**每 Phase 末单列 `[Server-IT]`**；vendor 契约 = mock 单测 + env-gated 真 vendor IT（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`，默认 skip）
- **20 条 `state_branches`（spec frontmatter）逐条须在 IT 有 `it()`**（覆盖矩阵见文末）
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`（nx cache 对新文件可能假绿）
- ✅ **schema/NK 已 probe verified（2026-07-15 prod 77 真 vendor）** → 本 tasks 建立在真实 schema 上（industries 覆盖式无 date + 3 级层级 + source 纳 NK / announcement date +08:00 + linkUrl 唯一 NK + 10yr 单请求无分页 + ≤10yr 硬上限），**不留扩键悬念**（详见 [plan.md](./plan.md) §风险）

## Path Conventions

- server：`apps/server/src/marketdata/`（扁平文件平铺，ADR-0043，改动全在 marketdata 单 bounded context 内）
- migration：`apps/server/prisma/migrations/20260715_1800_create_hk_classification_text_tables/`（**expand-only**，2 `CREATE TABLE` + FK + 2 seed + 2 soft 边，`migration_refs` frontmatter ADR-0035）
- IT：`apps/server/test/integration/marketdata.hk-043.*.it.spec.ts`
- 本地起服/IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`（memory `local_it_smoke_needs_env_unset_oss`）；dev DB `docker compose -f docker-compose.dev.yml up -d --wait`（mbw-poc-postgres:5433 / redis:6380）
- **前置就绪**：p1（038）平台 + p2（039）+ 040 + 041 + 042 已上 prod；HK 付费包已订阅；2 分类文本端点 param 契约 + 字段 + NK 已 **prod 77 真调 verified**（见 [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md) + 2026-07-15 043 重探，plan §风险 probe verified）

---

## Phase 1: 数据层地基（2 张 market-agnostic 事实表 + 1 migration + 2 seed 行 + 2 soft 边）🎯

**Independent Test**: Testcontainers PG `migrate deploy` → 2 表 + 唯一键（industries 3 列 `(instrumentId,source,industryCode)` / announcement 3 列 `(instrumentId,date,linkUrl)`）+ instrument FK cascade 存在；2 `sync_dimension` 行 `market_scope={hk}` + **cronExpr 统一夜频** `0 0 22 * * *`（FR-011）+ freshness 二档（industries slow-drift / history_depth=NULL；announcement continuous-daily / history_depth=3650）；2 条 `universe→dim` soft 边落库。**纯数据层，不动 TS executor ⇒ 立即编译绿**。

- [X] T001 [Server] **2 Prisma model + Instrument 反向关系**：`apps/server/prisma/schema.prisma` 新增（各 `@@schema("marketdata")` + `instrumentId BigInt @map("instrument_id")` + `instrument Instrument @relation(...,onDelete:Cascade)` + `@@unique([自然键])`）：① `IndustryClassification`（覆盖式快照样板 `IndexMembership`；NK `(instrumentId,source,industryCode)`；`source String @db.VarChar(32)`〔NOT NULL，sentinel `''`〕 + `industryCode String @map("industry_code") @db.VarChar(32)`〔NOT NULL；vendor `stockCode` 字段落此，plan Decision 3〕 + `name String? @db.VarChar(128)` + `areaCode String? @map("area_code") @db.VarChar(8)`；**无 date**）；② `Announcement`（range 事件样板 `BuybackEvent`；NK `(instrumentId,date,linkUrl)`；`date DateTime @db.Date` + `linkUrl String @map("link_url") @db.VarChar(512)`〔NOT NULL；probe maxLen 79 留足〕 + `linkText String? @map("link_text") @db.VarChar(512)` + `linkType String? @map("link_type") @db.VarChar(16)` + `types String[] @db.Text`〔Postgres text[]，缺存空数组，plan Decision 4〕；**无 PDF 正文列**）；**Instrument model 加 2 行反向关系** → verify: `prisma validate` + `prisma generate` + `nx typecheck server` 绿
- [X] T002 [Server] **1 migration（expand-only）**：`apps/server/prisma/migrations/20260715_1800_create_hk_classification_text_tables/migration.sql`：2 `CREATE TABLE`（BIGSERIAL id + instrument_id + 自然键列 + `CREATE UNIQUE INDEX` + `ADD CONSTRAINT ..._fkey FOREIGN KEY(instrument_id) REFERENCES marketdata.instrument(id) ON DELETE CASCADE`，DDL 由 `prisma migrate diff --from-config-datasource --to-schema` 生成零 drift，样板 042 `20260715_1400_create_hk_reporting_period_tables`；**announcement 加 `(instrument_id, date DESC)` 时序索引**护超大表扫描，plan Decision 7）+ 顶部 `-- migration_refs: specs/043-hk-marketdata-classification-text` + **2 `sync_dimension` seed 行**（`INSERT ... ON CONFLICT(dimension_key) DO NOTHING`，列集照 039/042 既有 seed：① `industry_classification` / `market_scope='{hk}'` / **`cron_expr='0 0 22 * * *'`** / **`history_depth=NULL`**〔覆盖式无历史〕/ `freshness_profile='slow-drift'` / `adjust_types='{none}'` / `batch_size=1` / priority 低；② `announcement` / `market_scope='{hk}'` / **`cron_expr='0 0 22 * * *'`** / **`history_depth=3650`**〔10yr〕/ `freshness_profile='continuous-daily'` / `adjust_types='{none}'` / `batch_size=1` / priority 低）+ **2 `universe→dim` soft 边**（`universe→industry_classification` / `→announcement`）+ `prisma migrate deploy` dev DB → verify: 无 drift、幂等重 deploy
- [X] T003 [Server-IT] **Phase 1 schema IT**（Testcontainers PG）：`migrate deploy` → 2 表 + 2 唯一约束（industries `(instrumentId,source,industryCode)` / announcement `(instrumentId,date,linkUrl)`）+ FK cascade（删 instrument 连带删）+ 2 seed 行断言（marketScope=['hk'] / **cronExpr='0 0 22 * * *' 夜频** / industries slow-drift+history_depth=null / announcement continuous-daily+history_depth=3650）+ 2 soft 边 + announcement `(instrument_id,date)` 索引存在。`test/integration/marketdata.hk-043.schema.it.spec.ts`。**覆盖 state_branch**: `新表 market-agnostic` / `依赖 universe` / `2 维度 marketScope 纳入`（seed 层）/ `cron 夜频二档` / `公告历史 10yr 可回填`（seed history_depth）

---

## Phase 2: US1 所属行业（industry_classification，覆盖式快照 · 照抄 index_membership）🏁 MVP

**US1 Independent Test**: Testcontainers PG（test-local mock hk adapter）；① industry_classification 运行 → `industry_classification` 3 级层级多行（含 industryCode/source/name），一股多行业全落；② 覆盖式：重跑后旧归属被当前快照整体替换、无残留；③ vendor 空返回 → 跳过 mutate 不 deleteMany（既有归属保留）；④ 请求体单数 stockCode **无 date/无 startDate**；⑤ vendor `stockCode`→`industryCode` 列映射；⑥ `(instrumentId,source,industryCode)` 幂等；⑦ marketScope={hk} 纳 hk 排除 cn。

- [X] T004 [P] [US1] [Server] **industry_classification adapter 层**：`industry-classification.port.ts`（`INDUSTRY_CLASSIFICATION_PORT` + `getIndustryClassification(symbol):IndustryClassificationDto[]`，样板 `index-membership.port.ts`，**无 range 参数**）+ `marketdata.types.ts` 加 `IndustryClassificationDto`（`{source, industryCode, name, areaCode}`，文本跨边界 `string|null`）+ `lixinger-industry-classification.adapter.ts`（`extends LixingerAdapterBase`；`post('/${market}/company/industries',{stockCode})` **单数 stockCode 无 date**；**解析**：vendor 行 `stockCode` 字段 → `industryCode`（`lixNumToString` 归一，probe 是 H70 等行业代码），`source`/`name`/`areaCode` 透传 `string|null`；**3 级层级 3 行全出、不去重**；不用 metricsList/Prisma；样板 `lixinger-index-membership.adapter.ts`）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体=**单数 stockCode 无 date/无 startDate** + **stockCode→industryCode 映射** + 3 层级行全出（H70/H7020/H702015 不去重）+ source 透传 + 缺 name/areaCode null + 空数组容错 + `marketdata.lixinger-vendor.it.spec.ts` 加 skipIf 真 vendor it（覆盖式无 date）。**注**：`DIMENSION_KEYS += 'industry_classification'` 移至 T005（与 `buildExecutors` entry 同 commit 保 exhaustive Record typecheck 绿，plan Decision 1）
- [X] T005 [US1] [Server] **装配 industry_classification 维度**（`DIMENSION_KEYS += 'industry_classification'` + `buildExecutors` entry **同 commit**）：`dimension-executor.ts` 构造器 `@Inject(INDUSTRY_CLASSIFICATION_PORT)`（尾部 null-object 默认）+ `buildExecutors` 加 `factExecutor('industry_classification',…)` + `syncIndustryClassification`（**照抄 `syncIndexMembership`：无 mode/无 date；per-instrument `getIndustryClassification` → 空返回跳过 mutate 计 ok；非空 → 单 `$transaction` 内 `deleteMany({instrumentId})` + `createMany({data:rows,skipDuplicates:true})` 原子替换**；`pace()` per-stock 恒限速）+ `mock-market-data.adapter.ts` `implements IndustryClassificationPort` + hk fixture（3 级层级多行 + 空返回股）+ `marketdata.module.ts` provider 工厂（无-Prisma）→ verify: `dimension-executor.spec.ts`（mock port，覆盖式替换 + 空返回不 wipe + 多层级行落库 + 幂等）
- [X] T006 [US1] [Server-IT] **US1 集成 IT**（Testcontainers PG，test-local mock hk 埋 3 级层级 + 空返回 fixture，`buildRegistry` 手工装配，骨架照 `marketdata.hk-042.*.it.spec.ts`）：industry_classification hk 运行 3 级层级多行落库（industryCode/source/name 齐）+ **覆盖式重跑旧归属被换无残留**（换 fixture 验替换）+ **空返回跳过不 wipe**（既有归属保留）+ 请求单数 stockCode 无 date + **stockCode→industryCode 映射** + `(instrumentId,source,industryCode)` 幂等 + marketScope={hk} 纳 hk 排除 cn。`test/integration/marketdata.hk-043.industry-classification.it.spec.ts`。**覆盖 state_branch**: `所属行业覆盖式快照` / `所属行业空返回不 wipe` / `所属行业代码字段消歧` / `industries 3 级层级路径` / `2 维度 marketScope 纳入`

---

## Phase 3: US2 公告（announcement，range 文本流 · 照抄 buyback · linkUrl 天然唯一 NK）

**US2 Independent Test**: Testcontainers PG（mock hk）；① announcement backfill → `announcement` 多 date 元数据行（linkUrl/date/linkText/linkType/types[]）；② 请求体单数 stockCode + `startDate/endDate` 区间；③ `from=asOf−historyDepth`（10yr 回填，backfill 不超 10yr）；④ date `+08:00` → lixDateOnly 正确；⑤ types 数组保真、缺 types 空数组 / 缺 linkText/linkType null；⑥ `(instrumentId,date,linkUrl)` 幂等（同 URL 折叠 / 不同 URL 保留）；⑦ 空返回零行不崩；⑧ marketScope={hk}。

- [X] T007 [P] [US2] [Server] **announcement adapter 层**：`announcement.port.ts`（`ANNOUNCEMENT_PORT` + `getAnnouncementRange({symbol,from,to?}):AnnouncementDto[]` 升序）+ types `AnnouncementRangeQuery`+`AnnouncementDto`（`{date, linkUrl, linkText, linkType, types:string[]}`；文本 `string|null`，types 数组缺→`[]`）+ `lixinger-announcement.adapter.ts`（`extends LixingerAdapterBase`；`post('/${market}/company/announcement',{stockCode,startDate,endDate?})` **单数 stockCode + range**；**解析**：`date` 用 `lixDateOnly`〔probe verified `+08:00` HK-local，slice 正确无 off-by-one，plan Decision 4〕；`linkUrl` 透传（NOT NULL）；`linkText`/`linkType` `lixNumToString`→`string|null`；`types` 数组保真〔非数组/缺 → `[]`〕；**单 POST 无分页/无 date-chunking**〔probe 10yr 单请求返全量〕；不用 metricsList/Prisma；样板 `lixinger-buyback.adapter.ts` range 形态）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体=**单数 stockCode + startDate/endDate** + **date +08:00 lixDateOnly 无 off-by-one** + types 数组保真 + 缺 types→[] + 缺 linkText/linkType→null + linkUrl 透传 + 升序 + 空数组容错 + skipIf 真 vendor it（≤10yr）。**注**：`DIMENSION_KEYS += 'announcement'` 移至 T008
- [X] T008 [US2] [Server] **装配 announcement 维度**（key + entry 同 commit）：`dimension-executor.ts` `@Inject(ANNOUNCEMENT_PORT)` + `buildExecutors` entry + `syncAnnouncement`（**照抄 `syncBuyback`：mode 分 from —— delta `from=asOf`（当日）, backfill `from=subtractDays(asOf,depth)`（≤10yr 天然满足 ≤10yr 硬上限）**；`getAnnouncementRange` → per-stock `createMany({skipDuplicates})` on `(instrumentId,date,linkUrl)`；backfill per-stock `await this.backfillPacer.pace()`）+ `mock-market-data.adapter.ts` `implements AnnouncementPort` + hk fixture（多 date + 同 date 多 linkUrl + 缺字段行 + 空 types）+ `marketdata.module.ts` provider 工厂 → verify: `dimension-executor.spec.ts`（mock port，delta/backfill 两分支 + 多 date 落库 + 同 date 多 linkUrl 不折叠 + 缺字段 null/空数组 + 空返回零行 + 幂等）
- [X] T009 [US2] [Server-IT] **US2 集成 IT**（Testcontainers PG，mock hk 埋多 date + 同 date 多 linkUrl + 缺字段 + 空 types fixture）：announcement hk backfill 多 date 元数据行落库（typed 列齐 + types[]）+ 连跑幂等 + 请求单数 stockCode+range + `from`=asOf−10yr（seed historyDepth 驱动，backfill 不超 10yr）+ **date +08:00 lixDateOnly** + **`(instrumentId,date,linkUrl)` 幂等（同 URL 折叠 / 同 date 不同 linkUrl 各成行保留）** + types 数组保真 + 缺 types 空数组 / 缺 linkText/linkType null + 空返回零行不崩 + marketScope={hk} 纳 hk 排除 cn。`test/integration/marketdata.hk-043.announcement.it.spec.ts`。**覆盖 state_branch**: `公告文本流区间回填` / `公告超大表只存元数据` / `公告 linkUrl 天然唯一 NK` / `公告无分页单请求` / `公告 ≤10yr 硬上限 403`（backfill 不超 10yr）/ `公告 date 为 +08:00` / `全部单数 stockCode+range 契约`（announcement 侧）/ `vendor 缺字段容忍`（announcement 侧）

---

## Phase 4: 回填 pacing + 全绿门 + 无回归

**Independent Test**: Testcontainers PG（+Redis 若测队列串行）；① `backfill --dimension announcement --markets hk --dry-run` 估算量级吻合、按 hk 过滤（industries 覆盖式无历史不纳估算）；② backfill 自限速 ~10/s + jitter、sustained ≤ ~600/min、不触 429；③ 中断后按各维度自然键幂等续跑；④ **p1（6 维）/ p2（5 维）/ 040（2 维）/ 041（4 维）/ 042（3 维）共 20 维 + A 股既有 IT/单测零回归**。

- [X] T010 [Server] **dry-run 估算纳入 announcement**：`marketdata-backfill.cli.ts` `estimateRequests` 把 announcement 按 per-stock 区间计入（可回填历史，history_depth=3650）；**industries 覆盖式无历史 → 不纳回填估算**（history_depth=NULL，同 index_membership 处理）；`--dimension <key>` 由 `DIMENSION_KEYS` 校验天然支持（零改）→ verify: `marketdata-backfill.cli.spec.ts`（`--markets hk` 估算含 announcement、排除 industries、按 hk 过滤）
- [X] T011 [Server-IT] **pacing + 续跑 + 无回归 IT**（Testcontainers PG+Redis）：announcement backfill 自限速 sustained ≤ 目标 + jitter 打散 + 中断后按自然键幂等续跑 + **20 维 + A股无回归**。🚨 **必跑全 `nx test server`（非代表性子集）—— 041/042 血泪教训：加 marketdata 维度必破 ~12 个既有全景 IT**（维度数 **20→22** / 下游闭包 +2 / seed 边 +2 / schema 表 +2 / 派生链序尾部插 industry_classification/announcement / **schema-016 cron：2 新维度均夜频 `0 0 22 * * *` → 纳入 daily-cadence 断言集 + hkOnlyDims 纳 2 维**，异于 042 季频排除逻辑），逐个更新既有全景 IT 期望值（`trigger-cli`/`backfill-cli`/`tick-driver`/`flow-orchestration`/`tier-night-e2e`/`night-e2e-019`/`adjustment-factor`/`schema-015/016/017`/`sync-schema-gate`/`test-dimension-registration` 等，**仅改既有全景 IT 期望值、不动 043 impl**，照 039/040/041/042 先例）+ 新建 `test/integration/marketdata.hk-043.backfill-pacing.it.spec.ts`。**覆盖 state_branch**: `回填自限速续跑` / `p1/p2/040/041/042/A股无回归` / `2 维度 marketScope 纳入`（全工作集）
- [X] T012 [Verify] **全绿门 + 真数据契约 + 上线前 live-probe**：`nx affected -t lint typecheck test build --base=origin/main --skip-nx-cache` 全绿（test = server+mobile+@nvy/checks 全绿 / lint+typecheck+build 全绿，NX_EXIT=0）+ `check-server-moat.ts` 关（0 违规：2 表 intra-marketdata FK、无新 cross-context owner）。**⏸️ live-probe（2 端点 read-only 再确认 `code=1`）+ 端到端 hk 真数据 live-write smoke（`MARKETDATA_PROVIDER=live` + `LIXINGER_TOKEN`：`hk:00700` industry_classification/announcement）= deferred 上线首夜 supervised ops，非本 PR 范围**（照 041/042 out-of-scope；FR-010 probe 已 2026-07-15 prod 77 verified `code=1` + schema，首夜 supervised 前再核防 token/配额漂移，探针挂 auto-mode 需 user `!`/授权）+ env-gated 契约 it（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`）默认 skip 不触真 vendor。**⚠️ 全量多夜回填（announcement ~3M 行）+ 单股 live-write smoke = 首夜 supervised ops（master INV-3）**。**覆盖 state_branch**: `无 metricsList all-or-nothing 坑`（真 vendor 确认，deferred 首夜）/ `p1/p2/040/041/042/A股无回归`（全绿门）

---

## Dependencies & 执行顺序

```
Phase 1 地基（T001 schema → T002 migration → T003 schema IT）
  ↓（migrate deploy 是所有 Phase IT 前置；纯数据层立即编译绿）
Phase 2 US1 所属行业〔MVP〕（T004[P] adapter → T005 装配 → T006 IT）
  ↓
Phase 3 US2 公告（T007[P] adapter → T008 装配 → T009 IT）
  ↓
Phase 4（T010 估算 → T011 pacing/无回归 IT → T012 全绿门+真调）
```

- **硬前置**：Phase 1（migration）→ 全部 Phase IT；每维度 adapter（`[P]`）→ 其装配 task。
- **可并行 `[P]`**：T004 ∥ T007（2 个 adapter 不同文件、互不依赖，纯 adapter 层可并行编写）。
- **必串行**：装配 task（T005 / T008）均改 `dimension-executor.ts`/`marketdata.module.ts` **同文件** ⇒ 顺序化（exhaustive Record 每次 +1 entry 才编译绿；key 在各自 adapter task T004/T007 加）。
- **关键路径** = T001→T002→(T004→T005)→(T007→T008)→T011→T012。
- **MVP** = Phase 1 + Phase 2（所属行业 3 级层级落库即「行业中性化/分组因子可用」，分类文本族使用面最广的切片）。

## state_branch 覆盖矩阵（20 条 → IT task）

| state_branch | IT task |
| --- | --- |
| 所属行业覆盖式快照 | T005（executor）/ T006 |
| 所属行业空返回不 wipe | T005 / T006 |
| 所属行业代码字段消歧 | T004（adapter 映射）/ T006 |
| industries 3 级层级路径 | T004（adapter）/ T006 |
| 公告文本流区间回填 | T008 / T009 |
| 公告历史 10yr 可回填 | T003（seed history_depth=3650）/ T009 / T010（估算）|
| 公告超大表只存元数据 | T001（schema 无 PDF 列）/ T009 |
| 公告 linkUrl 天然唯一 NK | T001（唯一约束）/ T009（同/异 URL 折叠保留）|
| 公告无分页单请求 | T007（adapter 单 POST）/ T009 |
| 公告 ≤10yr 硬上限 403 | T007（adapter skipIf 真 vendor）/ T008（backfill from=asOf−3650 不超）/ T009 |
| 公告 date 为 +08:00 | T007（adapter lixDateOnly）/ T009 |
| param 契约二分每端点单独确认 | T004（industries 无 date）/ T007（announcement range）+ T012（真 vendor）|
| 无 metricsList all-or-nothing 坑 | T004/T007（adapter 无 metricsList）+ T012 |
| 2 维度 marketScope 纳入 | T003（seed）/ T006/T009 / T011（全工作集）|
| 新表 market-agnostic | T003 |
| 依赖 universe | T003（soft 边）|
| cron 夜频二档 | T003（seed cron/freshness/history）|
| 回填自限速续跑 | T010（估算）/ T011（限速+续跑）|
| p1/p2/040/041/042/A股无回归 | T011 / T012 |
| vendor 缺字段容忍 | T006（industries 缺 name/areaCode）/ T009（announcement 缺 types/linkText/linkType）|

## 单 PR（Constitution §V）

默认单 PR（2 维度 6 件套 ×2）。若 impl 中发现 PR 过大需增量隔离：Phase 1（schema 地基，编译绿）可单独先 ship 验稳，Phase 2-4（各维度装配）第二个 PR —— task 边界已按 Phase 对齐。2 维度形态互异（industries 覆盖式无 mode / announcement range mode-based），但均照抄已上线 executor（index_membership / buyback），装配风险低。
