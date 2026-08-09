---
feature_id: 042-hk-marketdata-reporting-period
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: 2026-07-15
---

# Tasks: 042-hk-marketdata-reporting-period（港股报告期 3 维度：营收构成 / 最新股东 / 员工）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `042-hk-marketdata-reporting-period`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 营收构成 / US2 最新股东 / US3 员工）；Foundational / Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Verify]`（**纯 server 数据摄取，无新读端点 → 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]`**，plan §Constitution V）
- **单 PR**（一 feature = 一分支 = 一 PR）；Phase = 逻辑 task 组（非 PR 拆）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；落库/marketScope/幂等/嵌套保真/头行判别 = Testcontainers PG（run via `nx test server <file>`，cwd=apps/server，memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（adapter 请求/解析）= vitest 无 DB；**每 Phase 末单列 `[Server-IT]`**；vendor 契约 = mock 单测 + env-gated 真 vendor IT（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`，默认 skip）
- **13 条 `state_branches`（spec frontmatter）逐条须在 IT 有 `it()`**（覆盖矩阵见文末）
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`（nx cache 对新文件可能假绿）
- ✅ **schema/NK 已 probe verified（2026-07-15 prod 77 真 vendor）** → 本 tasks 建立在真实 schema 上（员工 NK 含 displayType / 营收头行规则 / 最新股东 SERIES），**不留 C1 扩键悬念**（详见 [plan.md](./plan.md) §风险）

## Path Conventions

- server：`apps/server/src/marketdata/`（扁平文件平铺，ADR-0043，改动全在 marketdata 单 bounded context 内）
- migration：`apps/server/prisma/migrations/20260715_XXXX_create_hk_reporting_period_tables/`（**expand-only**，3 `CREATE TABLE` + FK + 3 seed + 3 soft 边，`migration_refs` frontmatter ADR-0035）
- IT：`apps/server/test/integration/marketdata.hk-042.*.it.spec.ts`
- 本地起服/IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`（memory `local_it_smoke_needs_env_unset_oss`）；dev DB `docker compose -f docker-compose.dev.yml up -d --wait`（mbw-poc-postgres:5433 / redis:6380）
- **前置就绪**：p1（038）平台 + p2（039）+ 040 + 041 已上 prod；HK 付费包已订阅；3 报告期端点 param 契约 + 字段 + NK 已 **prod 77 真调 verified**（见 [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md) + plan §风险 probe verified）

---

## Phase 1: 数据层地基（3 张 market-agnostic 事实表 + 1 migration + 3 seed 行 + 3 soft 边）🎯

**Independent Test**: Testcontainers PG `migrate deploy` → 3 表 + 唯一键（营收 4 列 / 最新股东 4 列含 contentHash / 员工 5 列含 displayType）+ instrument FK cascade 存在；3 `sync_dimension` 行 `market_scope={hk}` + `history_depth=3650`（可回填）+ **cronExpr 统一季频** `0 0 22 1 */3 *`（FR-011）+ freshness 画像（slow-drift / sla_hours=NULL）；3 条 `universe→dim` soft 边落库。**纯数据层，不动 TS executor ⇒ 立即编译绿**。

- [X] T001 [Server] **3 Prisma model + Instrument 反向关系**：`apps/server/prisma/schema.prisma` 新增（各 `@@schema("marketdata")` + `instrumentId BigInt @map("instrument_id")` + `instrument Instrument @relation(...,onDelete:Cascade)` + `@@unique([自然键])`，样板 typed 子行 `BuybackEvent` flat / payload+hash `ShareholderChange`）：① `RevenueSegment`（NK `(instrumentId,date,parentItemName,itemName)`；**扁平 typed 列** date `DateTime @db.Date` / declarationDate `DateTime? @db.Date` / currency `String? @db.VarChar` / parentItemName·itemName `String @db.VarChar`〔NOT NULL，头行 sentinel `''`〕/ revenue·costs `Decimal?(24,2)`〔**signed 可负**〕/ grossProfitMargin `Decimal?(10,6)` —— 禁 Float，plan Decision 3）；② `ShareholderSnapshot`（NK `(instrumentId,date,shareholderName,contentHash)`；`shareholderName String @map("shareholder_name") @db.VarChar` + `contentHash String @map("content_hash") @db.VarChar` + `payload Json`〔嵌套 L/S/P 整存，复用 041 `ShareholderChange` 范式，plan Decision 4〕）；③ `EmployeeSnapshot`（NK `(instrumentId,date,parentItemName,itemName,displayType)`；扁平 date/declarationDate `@db.Date` / parentItemName·itemName·displayType `String @db.VarChar`〔NOT NULL，sentinel `''`〕/ value `Decimal?(20,4)` —— **displayType 进 NK，probe 实证同名 number+percentage 两行**，plan Decision 3/6）；**Instrument model 加 3 行反向关系** → verify: `prisma validate` + `prisma generate` + `nx typecheck server` 绿
- [X] T002 [Server] **1 migration（expand-only）**：`apps/server/prisma/migrations/20260715_XXXX_create_hk_reporting_period_tables/migration.sql`：3 `CREATE TABLE`（BIGSERIAL id + instrument_id + 自然键列 + `CREATE UNIQUE INDEX` + `ADD CONSTRAINT ..._fkey FOREIGN KEY(instrument_id) REFERENCES marketdata.instrument(id) ON DELETE CASCADE`，DDL 由 `prisma migrate diff --from-config-datasource --to-schema` 生成零 drift，样板 041 `20260715_1000_create_hk_corporate_event_tables`）+ 顶部 `-- migration_refs: specs/042-hk-marketdata-reporting-period` + **3 `sync_dimension` seed 行**（`INSERT ... ON CONFLICT(dimension_key) DO NOTHING`：`dimension_key` ∈ `{revenue_segment, shareholder_snapshot, employee}` / `market_scope='{hk}'` / `history_depth=3650` / **`cron_expr='0 0 22 1 */3 *'`**〔统一季频，FR-011〕/ `freshness_profile='slow-drift'` / `sla_hours=NULL` / `vendor='lixinger'` / `adjust_types='{none}'` / `batch_size=1` / priority 低于核心 6 维）+ **3 `universe→dim` soft 边**（`universe→revenue_segment` / `→shareholder_snapshot` / `→employee`）+ `prisma migrate deploy` dev DB → verify: 无 drift、幂等重 deploy
- [X] T003 [Server-IT] **Phase 1 schema IT**（Testcontainers PG）：`migrate deploy` → 3 表 + 3 唯一约束（营收 `(instrumentId,date,parentItemName,itemName)` / 最新股东 `(instrumentId,date,shareholderName,contentHash)` / 员工 `(instrumentId,date,parentItemName,itemName,displayType)`）+ FK cascade（删 instrument 连带删）+ 3 seed 行断言（marketScope=['hk'] / history_depth=3650 / **cronExpr='0 0 22 1 */3 *' 季频** / slow-drift / sla_hours=null）+ 3 soft 边。`test/integration/marketdata.hk-042.schema.it.spec.ts`。**覆盖 state_branch**: `新表 market-agnostic` / `依赖 universe` / `3 维度 marketScope 纳入`（seed 层）

---

## Phase 2: US1 营收构成（revenue_segment，照抄区间形态 · dataList 头行判别 · typed 子行）🏁 MVP

**US1 Independent Test**: Testcontainers PG（test-local mock hk adapter，埋 `rangeCalls` 计数）；① revenue_segment backfill → `revenue_segment` 多期分部行（含 revenue/costs/grossProfitMargin typed 列），连跑两次幂等不翻倍；② 请求体单数 stockCode + `startDate/endDate` 区间；③ `from = asOf−historyDepth`（10yr 回填）；④ **纯头行（无 parent+无 value）不落**、有 parent 缺 value 落 null 行；⑤ key trim 归一；⑥ 无营收披露标的 vendor 返 0 行 → 零行不崩不阻塞；⑦ marketScope={hk} 纳 hk 排除 cn。

- [X] T004 [P] [US1] [Server] **revenue_segment adapter 层**：`revenue-segment.port.ts`（`REVENUE_SEGMENT_PORT` + `getRevenueSegmentRange({symbol,from,to?}):RevenueSegmentDto[]` 升序）+ `marketdata.types.ts` 加 `RevenueSegmentRangeQuery`+`RevenueSegmentDto`（金融数值跨边界 `string|null`）+ `lixinger-revenue-segment.adapter.ts`（`extends LixingerAdapterBase`；`post('/${market}/company/operation-revenue-constitution',{stockCode,startDate,endDate?})` **单数 stockCode + range**；**解析 dataList → 展开 typed 子行**：per report `{date,declarationDate,currency}` 反规范化到每行 × 展开 dataList〔**跳过纯头行**：`parentItemName==null && revenue==null && costs==null && grossProfitMargin==null`；**有 parentItemName 的行一律出**（value 可 null）；顶层有 value 行 parentItemName 落 `''`；**parentItemName/itemName `.trim()` 归一**〕；**🕐 日期 HK-aware 归一（M1，probe verified）**：营收报告期 `date` 为 UTC `...T16:00:00.000Z`（=次日 00:00+08 HK）→ 裸 `lixDateOnly` 的 `slice(0,10)` 会 **off-by-one 少 1 天** → 须先转 +08 HK-local 再取 date-only（加 `lixDateOnlyHk` helper 或等价 `+8h then slice`），与 employee/shareholder 的 `+08:00` 日期对齐、防跨维度 join 错位；不用 metricsList/fsType/Prisma）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体=单数 stockCode + startDate/endDate + **头行判别（纯头行跳/缺值行落 null/顶层行 sentinel）+ trim + signed 负 revenue 解析 + 多分组共存归组 + UTC-Z 日期 HK-local 无 off-by-one** + 升序 + 空数组容错 + `marketdata.lixinger-vendor.it.spec.ts` 加 skipIf 真 vendor it。**注**：`DIMENSION_KEYS += 'revenue_segment'` 移至 T005（与 `buildExecutors` entry 同 commit 保 exhaustive Record typecheck 绿，plan Decision 1）
- [X] T005 [US1] [Server] **装配 revenue_segment 维度**（`DIMENSION_KEYS += 'revenue_segment'` + `buildExecutors` entry **同 commit**）：`dimension-executor.ts` 构造器 `@Inject(REVENUE_SEGMENT_PORT)`（尾部 null-object 默认）+ `buildExecutors` 加 `factExecutor('revenue_segment',…)` + `syncRevenueSegment`（照 `syncBuyback`：`from = mode==='backfill' ? subtractDays(asOf,depth) : targetDate`；`getRevenueSegmentRange` → `createMany({skipDuplicates})` on `(instrumentId,date,parentItemName,itemName)`；backfill per-stock `await this.backfillPacer.pace()`）+ `mock-market-data.adapter.ts` `implements RevenueSegmentPort` + cn:600519 fixture（含头行+数据行混合）+ `marketdata.module.ts` provider 工厂（无-Prisma）→ verify: `dimension-executor.spec.ts`（mock port，delta/backfill 两分支 + 头行不落 + 缺值行 null + 空返回零行 + 幂等）
- [X] T006 [US1] [Server-IT] **US1 集成 IT**（Testcontainers PG，test-local mock hk 埋 `rangeCalls` + 头行/数据行/缺值行混合 fixture，`buildRegistry` 手工装配，骨架照 `marketdata.hk-041.*.it.spec.ts`）：revenue_segment hk backfill 多期分部行落库（typed 列齐）+ 连跑幂等 + 请求单数 stockCode+range + `from`=asOf−10yr（seed historyDepth 驱动）+ **纯头行不落 + 有 parent 缺 value 落 null 行 + trim 归一 + signed 负 revenue** + 空返回零行不崩 + marketScope={hk} 纳 hk 排除 cn。`test/integration/marketdata.hk-042.revenue-segment.it.spec.ts`。**覆盖 state_branch**: `营收构成回填` / `全部单数 stockCode+range 契约`（revenue 侧）/ `报告期可回填历史`（revenue）/ `3 维度 marketScope 纳入` / `嵌套 dataList 缺字段容忍`（revenue 缺值行）

---

## Phase 3: US2 最新股东（shareholder_snapshot，区间形态 · 嵌套 L/S/P payload Json + contentHash，复用 041）

**US2 Independent Test**: Testcontainers PG（mock hk）；① shareholder_snapshot backfill → `shareholder_snapshot` 报告期股东行（含 shareholderName + payload 嵌套 L/S/P 数组）；② 嵌套 `numOfSharesInterestedList[]`/`percentageOfIssuedVotingShares[]` 每项 `{value,sharesType}` **完整保留不丢**（含第三类 P）；③ 缺 L/S/P 值 → 存 null 不崩；④ **SERIES：多 date 行落库可回填**；⑤ `(instrumentId,date,shareholderName,contentHash)` 幂等（同内容折叠、实质差异保留）；⑥ 空返回零行不崩。

- [X] T007 [P] [US2] [Server] **shareholder_snapshot adapter 层**：`shareholder-snapshot.port.ts`（`SHAREHOLDER_SNAPSHOT_PORT` + `getShareholderSnapshotRange({symbol,from,to?}):ShareholderSnapshotDto[]` 升序）+ types `ShareholderSnapshotRangeQuery`+`ShareholderSnapshotDto`（`shareholderName` + `payload` 嵌套原样 + `contentHash`）+ `lixinger-shareholder-snapshot.adapter.ts`（`post('/${market}/company/latest-shareholders',{stockCode,startDate,endDate?})` 单数+range；**嵌套数组整存 payload、缺项 null 不崩、contentHash = vendor 原始行 canonical sha256** —— **照抄 `lixinger-shareholder-change.adapter.ts` payload+contentHash 计算**，plan Decision 4；date 为 `+08:00`〔slice 已 HK-correct〕但用同一 `lixDateOnlyHk` 归一保跨维度对齐一致，M1）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体 + 嵌套 L/S/P 保真解析 + 缺字段 null + contentHash 稳定（同内容同 hash / 差异不同 hash）+ 空数组容错 + skipIf 真 vendor it。**注**：`DIMENSION_KEYS += 'shareholder_snapshot'` 移至 T008
- [X] T008 [US2] [Server] **装配 shareholder_snapshot 维度**（key + entry 同 commit）：`dimension-executor.ts` `@Inject(SHAREHOLDER_SNAPSHOT_PORT)` + `buildExecutors` entry + `syncShareholderSnapshot`（照 `syncShareholderChange`：mode 分 from → `createMany({skipDuplicates})` on `(instrumentId,date,shareholderName,contentHash)`；backfill `pace()`）+ mock（`implements` + 含 L/S/P 嵌套 + 多 date fixture）+ module 工厂 → verify: `dimension-executor.spec.ts`（delta/backfill + 嵌套 payload 落库保真 + 缺项 null + 幂等）
- [X] T009 [US2] [Server-IT] **US2 集成 IT**（Testcontainers PG，mock hk 埋含 L/S/P 嵌套 + 多 date 的 fixture）：shareholder_snapshot hk backfill 落库 + **嵌套 L/S/P 持股数量与占比完整保留不丢** + 缺型存 null 不崩 + **SERIES 多 date 行可回填** + `(instrumentId,date,shareholderName,contentHash)` 幂等（同内容折叠）+ 空返回零行 + marketScope 过滤。`test/integration/marketdata.hk-042.shareholder-snapshot.it.spec.ts`。**覆盖 state_branch**: `最新股东嵌套 L/S`（payload）/ `最新股东 = 报告期×股东序列`（SERIES 多 date）/ `全部单数 stockCode+range 契约`（shareholder 侧）/ `嵌套 dataList 缺字段容忍`（缺 L/S/P）

---

## Phase 4: US3 员工（employee，区间形态 · dataList typed 子行 · displayType 进 NK）

**US3 Independent Test**: Testcontainers PG（mock hk）；① employee backfill → `employee_snapshot` 多期员工行（itemName/parentItemName/value/displayType）；② **同名 number+percentage 两行经 displayType 进 NK 幂等共存不丢**（probe 实证「流失率按性别分·男性」= {number, percentage}）；③ key trim 归一；④ value 缺存 null；⑤ `(instrumentId,date,parentItemName,itemName,displayType)` 幂等；⑥ 空返回零行不崩。

- [X] T010 [P] [US3] [Server] **employee adapter 层**：`employee.port.ts`（`EMPLOYEE_PORT` + `getEmployeeRange({symbol,from,to?}):EmployeeDto[]` 升序）+ types `EmployeeRangeQuery`+`EmployeeDto`（`value` `string|null` + `displayType` + parentItemName/itemName）+ `lixinger-employee.adapter.ts`（`post('/${market}/company/employee',{stockCode,startDate,endDate?})` 单数+range；**解析 dataList → 展开 typed 子行** `{date,declarationDate,parentItemName,itemName,value,displayType}`〔顶层无 parentItemName 行落 `''`；**parentItemName/itemName `.trim()` 归一**；displayType 原样保留；date 为 `+08:00`〔slice 已 HK-correct〕但用同一 `lixDateOnlyHk` 归一保跨维度对齐一致，M1〕，plan Decision 3）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体 + **同名 number+percentage 两行都出（不去重）+ displayType 保留 + trim** + value 缺 null + 空数组容错 + skipIf 真 vendor it。**注**：`DIMENSION_KEYS += 'employee'` 移至 T011
- [X] T011 [US3] [Server] **装配 employee 维度**（key + entry 同 commit）：`dimension-executor.ts` `@Inject(EMPLOYEE_PORT)` + `buildExecutors` entry + `syncEmployee`（照 `syncBuyback`：mode 分 from → `createMany({skipDuplicates})` on `(instrumentId,date,parentItemName,itemName,displayType)`；backfill `pace()`）+ mock（`implements` + 含同名 number/percentage 两行 fixture）+ module 工厂 → verify: `dimension-executor.spec.ts`（delta/backfill + 同名 number+percentage 两行共存 + 空返回零行 + 幂等）
- [X] T012 [US3] [Server-IT] **US3 集成 IT**（Testcontainers PG，mock hk 埋含同名 number/percentage 两行 fixture）：employee hk backfill 多期落库 + **同名 number+percentage 两行经 displayType 进 NK 幂等共存不丢** + displayType 语义保真 + key trim + value 缺 null + `(instrumentId,date,parentItemName,itemName,displayType)` 幂等 + 空返回零行 + marketScope 过滤。`test/integration/marketdata.hk-042.employee.it.spec.ts`。**覆盖 state_branch**: `员工回填` / `全部单数 stockCode+range 契约`（employee 侧）/ `报告期可回填历史`（employee）/ `嵌套 dataList 缺字段容忍`（employee value 缺）

---

## Phase 5: 回填 pacing + 全绿门 + 无回归

**Independent Test**: Testcontainers PG（+Redis 若测队列串行）；① `backfill --dimension revenue_segment --markets hk --dry-run` 3 维度估算量级吻合、按 hk 过滤；② backfill 自限速 ~10/s + jitter、sustained ≤ ~600/min、不触 429；③ 中断后按各维度自然键幂等续跑；④ **p1（6 维）/ p2（5 维）/ 040（2 维）/ 041（4 维）共 17 维 + A 股既有 IT/单测零回归**。

- [X] T013 [Server] **dry-run 估算纳入 3 报告期维度**：`marketdata-backfill.cli.ts` `estimateRequests` 把 revenue_segment/shareholder_snapshot/employee 按 per-stock 区间计入（3 维均可回填历史，history_depth=3650）；`--dimension <key>` 由 `DIMENSION_KEYS` 校验天然支持（零改）→ verify: `marketdata-backfill.cli.spec.ts`（`--markets hk` 估算含 3 维、按 hk 过滤）
- [X] T014 [Server-IT] **pacing + 续跑 + 无回归 IT**（Testcontainers PG+Redis）：报告期维度 backfill 自限速 sustained ≤ 目标 + jitter 打散 + 中断后按各自然键幂等续跑 + **17 维 + A股无回归**。🚨 **必跑全 `nx test server`（非代表性子集）—— 041 T017 血泪教训（handoff 2026-07-15）：加 marketdata 维度必破 ~12 个既有全景 IT**（维度数 **17→20** / 下游闭包 +3 / seed 边 +3 / schema 表 +3 / 派生链序尾部插 revenue_segment/shareholder_snapshot/employee / **schema-016 cron：3 新维度季频 → 排除 daily+weekly 断言、hkOnlyDims 纳 3 维**），逐个更新既有全景 IT 期望值（`trigger-cli`/`backfill-cli`/`tick-driver`/`flow-orchestration`/`tier-night-e2e`/`night-e2e-019`/`adjustment-factor`/`schema-015/016/017`/`sync-schema-gate`/`test-dimension-registration` 等，**仅改既有全景 IT 期望值、不动 042 impl**，照 039/040/041 先例）+ 新建 `test/integration/marketdata.hk-042.backfill-pacing.it.spec.ts`。**覆盖 state_branch**: `回填自限速续跑` / `p1/p2/040/041/A股无回归` / `3 维度 marketScope 纳入`（全工作集）
- [X] T015 [Verify] **全绿门 + 真数据契约 + 上线前 live-probe**：**✅ 本 PR 完成自动全绿门**（2026-07-15）：`nx affected -t lint typecheck test build --base=origin/main --skip-nx-cache` 全绿（test = server+mobile+@nvy/checks 3 projects 全绿 / lint+typecheck+build 4 projects 全绿，NX_EXIT=0）+ `check-server-moat.ts` 关（0 违规：3 表 intra-marketdata FK、无新 cross-context owner）。**⏸️ live-probe（3 端点 read-only 再确认 `code=1`）+ 端到端 hk 真数据 live-write smoke（`MARKETDATA_PROVIDER=live` + `LIXINGER_TOKEN`：`hk:00700` revenue_segment/shareholder_snapshot/employee backfill）= deferred 上线首夜 supervised ops，非本 PR 范围**（照 041 out-of-scope；FR-010 probe 已 2026-07-15 prod 77 verified `code=1` + schema，首夜 supervised 前再核防 token/配额漂移，探针挂 auto-mode 需 user `!`/授权）+ env-gated 契约 it（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`）默认 skip 不触真 vendor。**⚠️ 全量多夜回填 + 单股 live-write smoke = 首夜 supervised ops（master INV-3）**。**覆盖 state_branch**: `无 metricsList all-or-nothing 坑`（真 vendor 确认，deferred 首夜）/ `p1/p2/040/041/A股无回归`（全绿门 ✅）

---

## Dependencies & 执行顺序

```
Phase 1 地基（T001 schema → T002 migration → T003 schema IT）
  ↓（migrate deploy 是所有 Phase IT 前置；纯数据层立即编译绿）
Phase 2 US1 营收构成〔MVP〕（T004[P] adapter → T005 装配 → T006 IT）
  ↓
Phase 3 US2 最新股东（T007[P] adapter → T008 装配 → T009 IT）
  ↓
Phase 4 US3 员工（T010[P] adapter → T011 装配 → T012 IT）
  ↓
Phase 5（T013 估算 → T014 pacing/无回归 IT → T015 全绿门+真调）
```

- **硬前置**：Phase 1（migration）→ 全部 Phase IT；每维度 adapter（`[P]`）→ 其装配 task。
- **可并行 `[P]`**：T004 ∥ T007 ∥ T010（3 个 adapter 不同文件、互不依赖，纯 adapter 层可并行编写）。
- **必串行**：装配 task（T005 / T008 / T011）均改 `dimension-executor.ts`/`marketdata.module.ts` **同文件** ⇒ 顺序化（exhaustive Record 每次 +1 entry 才编译绿；key 在各自 adapter task T004/T007/T010 加）。
- **关键路径** = T001→T002→(T004→T005)→(T007→T008)→(T010→T011)→T014→T015。
- **MVP** = Phase 1 + Phase 2（营收构成分部行落库即「分部营收/毛利因子可回测」，报告期族回测价值最高的切片）。

## state_branch 覆盖矩阵（13 条 → IT task）

| state_branch | IT task |
| --- | --- |
| 营收构成回填 | T006 |
| 员工回填 | T012 |
| 最新股东嵌套 L/S | T009 |
| 最新股东 = 报告期×股东序列（SERIES） | T009 |
| 全部单数 stockCode+range 契约 | T004/T007/T010（adapter 单测）+ T006/T009/T012（executor）+ T015（真 vendor）|
| 报告期可回填历史 | T006/T009/T012 + T013（估算）|
| 无 metricsList all-or-nothing 坑 | T004/T007/T010（adapter 无 metricsList）+ T015 |
| 3 维度 marketScope 纳入 | T003（seed）/ T006/T009/T012 / T014（全工作集）|
| 新表 market-agnostic | T003 |
| 依赖 universe | T003（soft 边）|
| 回填自限速续跑 | T013（估算）/ T014（限速+续跑）|
| p1/p2/040/041/A股无回归 | T014 / T015 |
| 嵌套 dataList 缺字段容忍 | T006（营收缺值行）/ T009（股东缺 L/S/P）/ T012（员工 value 缺）|

## 单 PR（Constitution §V）

默认单 PR（3 维度 6 件套 ×3）。若 impl 中发现 PR 过大需增量隔离：Phase 1（schema 地基，编译绿）可单独先 ship 验稳，Phase 2-5（各维度装配）第二个 PR —— task 边界已按 Phase 对齐。3 维度中营收/员工同 typed-子行 dataList 解析形态（唯 valueKeys + NK 列差异），最新股东复用 041 payload+contentHash，装配高度同构。
