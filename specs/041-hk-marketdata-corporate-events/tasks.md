---
feature_id: 041-hk-marketdata-corporate-events
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: 2026-07-15
---

# Tasks: 041-hk-marketdata-corporate-events（港股事件流 4 维度：回购 / 股本变动 / 股东权益变动 / 配股）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `041-hk-marketdata-corporate-events`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 回购 / US2 股本变动 / US3 股东权益变动 / US4 配股）；Foundational / Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Verify]`（**纯 server 数据摄取，无新读端点 → 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]`**，plan §Constitution V）
- **单 PR**（一 feature = 一分支 = 一 PR）；Phase = 逻辑 task 组（非 PR 拆）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；落库/marketScope/幂等/嵌套保真 = Testcontainers PG（run via `nx test server <file>`，cwd=apps/server，memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（adapter 请求/解析）= vitest 无 DB；**每 Phase 末单列 `[Server-IT]`**；vendor 契约 = mock 单测 + env-gated 真 vendor IT（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`，默认 skip）
- **12 条 `state_branches`（spec frontmatter）逐条须在 IT 有 `it()`**（覆盖矩阵见文末）
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`（nx cache 对新文件可能假绿）

## Path Conventions

- server：`apps/server/src/marketdata/`（扁平文件平铺，ADR-0043，改动全在 marketdata 单 bounded context 内）
- migration：`apps/server/prisma/migrations/20260715_XXXX_create_hk_corporate_event_tables/`（**expand-only**，4 `CREATE TABLE` + FK + 4 seed + 4 soft 边，`migration_refs` frontmatter ADR-0035）
- IT：`apps/server/test/integration/marketdata.hk-041.*.it.spec.ts`
- 本地起服/IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`（memory `local_it_smoke_needs_env_unset_oss`）；dev DB `docker compose -f docker-compose.dev.yml up -d --wait`（mbw-poc-postgres:5433 / redis:6380）
- **前置就绪**：p1（038）平台 + p2（039）+ 040 已上 prod；HK 付费包已订阅；4 事件端点 param 契约 + 字段 PoC 已实测（配股零样本除外，见 [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md)）

---

## Phase 1: 数据层地基（4 张 market-agnostic 事实表 + 1 migration + 4 seed 行 + 4 soft 边）🎯

**Independent Test**: Testcontainers PG `migrate deploy` → 4 表 + 唯一键 + instrument FK cascade 存在；4 `sync_dimension` 行 `market_scope={hk}` + `history_depth=3650`（均可回填）+ **cronExpr 分档**（buyback/equity_change 日频、shareholder_change/allotment 周频，FR-012）+ freshness 画像（slow-drift / sla_hours=NULL）；4 条 `universe→dim` soft 边落库。**纯数据层，不动 TS executor ⇒ 立即编译绿**。

- [X] T001 [Server] **4 Prisma model + Instrument 反向关系**：`apps/server/prisma/schema.prisma` 新增（各 `@@schema("marketdata")` + `instrumentId BigInt @map("instrument_id")` + `instrument Instrument @relation(...,onDelete:Cascade)` + `@@unique([自然键])`，样板 `ShortSellingDaily`/`CorporateAction.payload`）：① `BuybackEvent`（NK `(instrumentId,date)`；**扁平 typed 列** num `BigInt?` / highestPrice·lowestPrice·avgPrice `Decimal?(18,4)` / totalPaid `Decimal?(24,2)` / totalSharesForCancellation·totalSharesForTreasury `BigInt?` / ratioPurchasedSinceResolution `Decimal?(10,6)` / methodOfPurchase·currency·boardType `String? @db.VarChar` —— 禁 Float，plan Decision 5）；② `EquityChange`（NK `(instrumentId,date)`；扁平 capitalization·capitalizationH `Decimal?(24,0)` / changeReason `String? @db.VarChar(64)` / declarationDate `DateTime? @db.Date`）；③ `ShareholderChange`（NK `(instrumentId,date,shareholderName)`；`shareholderName String @map("shareholder_name") @db.VarChar` + `payload Json`〔嵌套 L/S 数组整存，plan Decision 4〕）；④ `AllotmentEvent`（NK `(instrumentId,date)`；`payload Json`〔零样本，字段未知，plan Decision 5〕）；**Instrument model 加 4 行反向关系** → verify: `prisma validate` + `prisma generate` + `nx typecheck server` 绿
  - ⟨C1 扩键 2026-07-15，T018 真调实证〕：`BuybackEvent` NK 定案 `(instrumentId,date,vendorEventId)`（+`vendorEventId String @db.VarChar`，vendor `_id` 24 位 hex）；`ShareholderChange` NK 定案 `(instrumentId,date,shareholderName,contentHash)`（+`contentHash String @db.VarChar`，vendor 原始行 canonical sha256 hashdiff）；`EquityChange`/`AllotmentEvent` NK **不动**（探针证 equity 1/日安全 / allotment 零样本）。
- [X] T002 [Server] **1 migration（expand-only）**：`apps/server/prisma/migrations/20260715_XXXX_create_hk_corporate_event_tables/migration.sql`：4 `CREATE TABLE`（BIGSERIAL id + instrument_id + 自然键列 + `CREATE UNIQUE INDEX` + `ADD CONSTRAINT ..._fkey FOREIGN KEY(instrument_id) REFERENCES marketdata.instrument(id) ON DELETE CASCADE`，样板 039 `20260713_XXXX_create_hk_quant_signal_tables`）+ 顶部 `-- migration_refs: specs/041-hk-marketdata-corporate-events` + **4 `sync_dimension` seed 行**（`INSERT ... ON CONFLICT(dimension_key) DO NOTHING`：`market_scope='{hk}'` / `history_depth=3650` / **`cron_expr` 分档**：buyback·equity_change=日频 cron（`'0 22 * * *'`）、shareholder_change·allotment=周频 cron（`'0 22 * * 1'`，FR-012）/ `freshness_profile='slow-drift'` / `sla_hours=NULL` / `vendor='lixinger'` / `adjust_types='{none}'`）+ **4 `universe→dim` soft 边**（`universe→buyback` / `→equity_change` / `→shareholder_change` / `→allotment`）+ `prisma migrate deploy` dev DB → verify: 无 drift、幂等重 deploy
  - ⟨C1 扩键 2026-07-15〕：本 migration 未 merge/未上 prod → 原地编辑（buyback_event 加 `vendor_event_id VARCHAR NOT NULL` + 唯一索引改 3 列 `uk_buyback_event_instrument_date_vendor`；shareholder_change 加 `content_hash VARCHAR NOT NULL` + 唯一索引改 4 列 `uk_shareholder_change_instrument_date_name_hash`）；dev DB 定向重放（drop 4 表 + 删 `_prisma_migrations` 记录 + `migrate deploy`）验无 drift ✓。
- [X] T003 [Server-IT] **Phase 1 schema IT**（Testcontainers PG）：`migrate deploy` → 4 表 + 4 唯一约束（buyback/equity `(instrumentId,date)`、shareholder `(instrumentId,date,shareholderName)`、allotment `(instrumentId,date)`）+ FK cascade（删 instrument 连带删）+ 4 seed 行断言（marketScope=['hk'] / history_depth=3650 / **cronExpr 分档：buyback·equity_change 日频、shareholder·allotment 周频** / slow-drift / sla_hours=null）+ 4 soft 边。`test/integration/marketdata.hk-041.schema.it.spec.ts`。**覆盖 state_branch**: `新表 market-agnostic` / `依赖 universe` / `4 维度 marketScope 纳入`（seed 层）；**覆盖 FR-012**（cronExpr 分档 seed 断言）

---

## Phase 2: US1 回购（buyback，照抄 eod_bar 区间形态 · 丰富 typed 列）🏁 MVP

**US1 Independent Test**: Testcontainers PG（test-local mock hk adapter，埋 `rangeCalls` 计数）；① buyback backfill → `buyback_event` 多年事件行（含 num/avgPrice/totalPaid 等 typed 列），连跑两次幂等不翻倍；② 请求体单数 stockCode + `startDate/endDate` 区间；③ `from = asOf−historyDepth`（10yr 回填）；④ 无回购历史标的 vendor 返 0 行 → 零行不崩不阻塞；⑤ marketScope={hk} 纳 hk 排除 cn。

- [X] T004 [P] [US1] [Server] **buyback adapter 层**：`buyback.port.ts`（`BUYBACK_PORT` + `getBuybackRange({symbol,from,to?}):BuybackDto[]` 升序）+ `marketdata.types.ts` 加 `BuybackRangeQuery`+`BuybackDto`（金融数值跨边界 `string|null`）+ `lixinger-buyback.adapter.ts`（`extends LixingerAdapterBase`；`post('/${market}/company/repurchase',{stockCode,startDate,endDate?})` **单数 stockCode + range**，解析丰富字段 → DTO，不用 metricsList/fsType/Prisma）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体=单数 stockCode + startDate/endDate + 丰富字段解析 + 升序 + 空数组容错 + `marketdata.lixinger-vendor.it.spec.ts` 加 skipIf 真 vendor it。**注**：`DIMENSION_KEYS += 'buyback'` 移至 T005（与 `buildExecutors` entry 同 commit 保 exhaustive Record typecheck 绿，plan Decision 1）
- [X] T005 [US1] [Server] **装配 buyback 维度**（`DIMENSION_KEYS += 'buyback'` + `buildExecutors` entry **同 commit**）：`dimension-executor.ts` 构造器 `@Inject(BUYBACK_PORT)`（尾部 null-object 默认）+ `buildExecutors` 加 `factExecutor('buyback',…)` + `syncBuyback`（照 `syncEodBars`/`syncShortSelling`：`from = mode==='backfill' ? subtractDays(asOf,depth) : targetDate`；`getBuybackRange` → `createMany({skipDuplicates})` on `(instrumentId,date)`；backfill per-stock `await this.backfillPacer.pace()`）+ `mock-market-data.adapter.ts` `implements BuybackPort` + cn:600519 fixture + `marketdata.module.ts` provider 工厂（无-Prisma）→ verify: `dimension-executor.spec.ts`（mock port，delta/backfill 两分支 + 空返回零行 + 幂等）
- [X] T006 [US1] [Server-IT] **US1 集成 IT**（Testcontainers PG，test-local mock hk 埋 `rangeCalls`，`buildRegistry` 手工装配，骨架照 `marketdata.hk-039.daily-signals.it.spec.ts`）：buyback hk backfill 多年事件落库（typed 列齐）+ 连跑幂等 + 请求单数 stockCode+range + `from`=asOf−10yr（seed historyDepth 驱动）+ 空返回零行不崩 + marketScope={hk} 纳 hk 排除 cn + **同日多事件行为已定**（mock 埋同一 `(instrumentId,date)` 两行 → 断言当前 NK `skipDuplicates` 落定行为；真实同日基数待 T018 真调核，见 C1 护栏）。`test/integration/marketdata.hk-041.buyback.it.spec.ts`。**覆盖 state_branch**: `回购事件回填` / `全部单数 stockCode+range 契约`（buyback 侧）/ `事件流可回填历史`（buyback）/ `4 维度 marketScope 纳入`
  - ⟨C1 扩键 2026-07-15〕：⑥ 改为**同 `(instrumentId,date)` 不同 vendorEventId 两笔都落**（汇丰 00005 同日两市场回购 GBP/turquoise + HKD/exchange）+ ⑦ 新增**同 vendorEventId 重同步 skipDuplicates 折叠幂等**（原「同日两行落 1 行」的 C1 护栏断言已废）。

---

## Phase 3: US2 股本变动（equity_change，同 buyback 区间形态 · 扁平列）

**US2 Independent Test**: Testcontainers PG（mock hk）；① equity_change backfill → `equity_change` 事件行（capitalization/capitalizationH/changeReason/declarationDate），连跑幂等；② 请求单数 stockCode+range；③ 空返回零行不崩。

- [X] T007 [P] [US2] [Server] **equity_change adapter 层**：`equity-change.port.ts`（`EQUITY_CHANGE_PORT` + `getEquityChangeRange({symbol,from,to?}):EquityChangeDto[]` 升序）+ types `EquityChangeRangeQuery`+`EquityChangeDto` + `lixinger-equity-change.adapter.ts`（`post('/${market}/company/equity-change',{stockCode,startDate,endDate?})` 单数+range，解析 capitalization/capitalizationH/changeReason/declarationDate）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体 + 字段解析 + 空数组容错 + skipIf 真 vendor it。**注**：`DIMENSION_KEYS += 'equity_change'` 移至 T008
- [X] T008 [US2] [Server] **装配 equity_change 维度**（key + entry 同 commit）：`dimension-executor.ts` `@Inject(EQUITY_CHANGE_PORT)` + `buildExecutors` entry + `syncEquityChange`（照 `syncBuyback`：mode 分 from → `createMany({skipDuplicates})` on `(instrumentId,date)`；backfill `pace()`）+ mock（`implements` + fixture）+ module 工厂 → verify: `dimension-executor.spec.ts`（delta/backfill + 空返回 + 幂等）
- [X] T009 [US2] [Server-IT] **US2 集成 IT**（Testcontainers PG，mock hk）：equity_change hk backfill 落库 + 连跑幂等 + 请求单数 stockCode+range + 空返回零行 + marketScope 过滤。`test/integration/marketdata.hk-041.equity-change.it.spec.ts`。**覆盖 state_branch**: `股本变动回填` / `全部单数 stockCode+range 契约`（equity 侧）/ `事件流可回填历史`（equity）

---

## Phase 4: US3 股东权益变动（shareholder_change，区间形态 · 嵌套 L/S payload Json）

**US3 Independent Test**: Testcontainers PG（mock hk）；① shareholder_change backfill → `shareholder_change` 事件行（含 shareholderName + payload 嵌套 L/S 数组）；② 嵌套 `numOfSharesInterestedList[]`/`percentageOfIssuedVotingShares[]` 每项 `{value,sharesType}` **完整保留不丢**；③ 缺 L 或 S 值 / 缺字段 → 存 null 不崩；④ `(instrumentId,date,shareholderName)` 幂等；⑤ 空返回零行不崩。

- [X] T010 [P] [US3] [Server] **shareholder_change adapter 层**：`shareholder-change.port.ts`（`SHAREHOLDER_CHANGE_PORT` + `getShareholderChangeRange({symbol,from,to?}):ShareholderChangeDto[]` 升序）+ types `ShareholderChangeRangeQuery`+`ShareholderChangeDto`（`shareholderName` + `payload` 嵌套原样）+ `lixinger-shareholder-change.adapter.ts`（`post('/${market}/company/shareholders-equity-change',{stockCode,startDate,endDate?})` 单数+range；**嵌套数组 `numOfSharesInterestedList[]`/`percentageOfIssuedVotingShares[]` 整存 payload，缺项 null 不崩**，plan Decision 4）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体 + 嵌套 L/S 保真解析 + 缺字段 null + 空数组容错 + skipIf 真 vendor it。**注**：`DIMENSION_KEYS += 'shareholder_change'` 移至 T011
- [X] T011 [US3] [Server] **装配 shareholder_change 维度**（key + entry 同 commit）：`dimension-executor.ts` `@Inject(SHAREHOLDER_CHANGE_PORT)` + `buildExecutors` entry + `syncShareholderChange`（照 `syncBuyback`：mode 分 from → `createMany({skipDuplicates})` on `(instrumentId,date,shareholderName)`；backfill `pace()`）+ mock（`implements` + 含 L/S 嵌套 fixture）+ module 工厂 → verify: `dimension-executor.spec.ts`（delta/backfill + 嵌套 payload 落库保真 + 缺项 null + 幂等）
- [X] T012 [US3] [Server-IT] **US3 集成 IT**（Testcontainers PG，mock hk 埋含 L/S 嵌套的 fixture）：shareholder_change hk backfill 落库 + **嵌套 L/S 持股数量与占比完整保留不丢** + 缺 L 或 S 存 null 不崩 + `(instrumentId,date,shareholderName)` 幂等 + 空返回零行 + marketScope 过滤。`test/integration/marketdata.hk-041.shareholder-change.it.spec.ts`。**覆盖 state_branch**: `股东权益变动嵌套` / `全部单数 stockCode+range 契约`（shareholder 侧）/ `事件流可回填历史`（shareholder）
  - ⟨C1 扩键 2026-07-15〕：⑦ 新增**同 `(instrumentId,date,shareholderName)` 不同 contentHash 多笔都落**（JPMorgan 09988 同日 3 笔 involved 不同，含第三类 sharesType=P）+ **完全相同行同 contentHash 折叠幂等**；adapter payload 整存整行含 `numOfSharesInvolvedList`（无损吸收）。

---

## Phase 5: US4 配股（allotment，区间形态 · payload Json · 零样本容错）

**US4 Independent Test**: Testcontainers PG（mock hk）；① allotment 维度对（mock 有配股历史的）标的 backfill → `allotment_event` 落 payload 行、幂等；② **mock 多数标的返 0 行 → 管道正常收敛、零行不崩不阻塞**（港股极罕见）；③ 请求单数 stockCode+range；④ 命中首个非空样本 payload 整存。

- [X] T013 [P] [US4] [Server] **allotment adapter 层**：`allotment.port.ts`（`ALLOTMENT_PORT` + `getAllotmentRange({symbol,from,to?}):AllotmentDto[]` 升序）+ types `AllotmentRangeQuery`+`AllotmentDto`（`payload` 原样，字段未知）+ `lixinger-allotment.adapter.ts`（`post('/${market}/company/allotment',{stockCode,startDate,endDate?})` 单数+range；**payload Json 整存 vendor 行、空数组正常返回**，plan Decision 5 + US4 零样本）→ verify: `lixinger-adapters.spec.ts` 纯函数验请求体 + payload 整存 + **空数组不崩**（零样本核心）+ skipIf 真 vendor it（允许全 0）。**注**：`DIMENSION_KEYS += 'allotment'` 移至 T014
- [X] T014 [US4] [Server] **装配 allotment 维度**（key + entry 同 commit）：`dimension-executor.ts` `@Inject(ALLOTMENT_PORT)` + `buildExecutors` entry + `syncAllotment`（照 `syncBuyback`：mode 分 from → `createMany({skipDuplicates})` on `(instrumentId,date)`；**空返回零行优雅收敛**；backfill `pace()`）+ mock（`implements` + 1 有样本 fixture + 多数空）+ module 工厂 → verify: `dimension-executor.spec.ts`（有样本落库 + **多数空返回零行不崩** + 幂等）
- [X] T015 [US4] [Server-IT] **US4 集成 IT**（Testcontainers PG，mock hk：1 标的有配股 fixture + 余标的空）：命中标的落 payload 行 + **多数标的零行、管道收敛不崩不阻塞** + `(instrumentId,date)` 幂等 + 请求单数 stockCode+range。`test/integration/marketdata.hk-041.allotment.it.spec.ts`。**覆盖 state_branch**: `配股罕见零样本` / `全部单数 stockCode+range 契约`（allotment 侧）

---

## Phase 6: 回填 pacing + 全绿门 + 无回归

**Independent Test**: Testcontainers PG（+Redis 若测队列串行）；① `backfill --dimension buyback --markets hk --dry-run` 4 维度估算量级吻合、按 hk 过滤；② backfill 自限速 ~10/s + jitter、sustained ≤ ~600/min、不触 429；③ 中断后按各维度自然键幂等续跑；④ p1（6 维）/ p2（5 维）/ 040（2 维）+ A 股既有 IT/单测零回归。

- [X] T016 [Server] **dry-run 估算纳入 4 事件维度**：`marketdata-backfill.cli.ts` `estimateRequests` 把 buyback/equity_change/shareholder_change/allotment 按 per-stock 区间计入（4 维均可回填历史，history_depth=3650）；`--dimension <key>` 由 `DIMENSION_KEYS` 校验天然支持（零改）→ verify: `marketdata-backfill.cli.spec.ts`（`--markets hk` 估算含 4 维、按 hk 过滤）
- [X] T017 [Server-IT] **pacing + 续跑 + 无回归 IT**（Testcontainers PG+Redis）：事件维度 backfill 自限速 sustained ≤ 目标 + jitter 打散 + 中断后按各自然键幂等续跑 + **p1/p2/040/A股无回归**（4 新维度不改 13 维 delta/backfill 与 A 股行为，既有 `marketdata.hk-038.*` + `marketdata.hk-039.*` + `marketdata.hk-040.*` + `marketdata.dimension-*` IT 全绿）。`test/integration/marketdata.hk-041.backfill-pacing.it.spec.ts`。**覆盖 state_branch**: `回填自限速续跑` / `p1/p2/040/A股无回归` / `4 维度 marketScope 纳入`（全工作集）
  - ⟨全绿门补记 2026-07-15⟩：全 `server:test` 套发现 **12 个既有全景 IT 需纳入 4 新维度**（维度数 13→17 / 下游闭包 12→16 / seed 边 14→18 / schema 表 18→22 / 派生链序尾部插 buyback/equity_change/shareholder_change/allotment / schema-016 cron 分档 shareholder_change+allotment 周频排除 daily 断言 + hkOnlyDims 纳 4 维），**原 T017 仅跑代表性子集漏检**（`marketdata.hk-041.*` + `dimension-*` 子集，未覆盖 `trigger-cli`/`backfill-cli`/`tick-driver`/`flow-orchestration`/`tier-night-e2e`/`night-e2e-019`/`adjustment-factor`/`schema-015/016/017`/`sync-schema-gate`/`test-dimension-registration` 全景断言），照 039/040 先例已于全绿门修复（仅改既有全景 IT 期望值，未动 041 impl）。
- [X] T018 [Verify] **全绿门 + 真数据契约 + 逐端点 live-probe**：`nx affected -t lint typecheck test build --base=origin/main` 全绿（`--skip-nx-cache` 首跑）+ `check-server-moat.ts` 关（4 表 intra-marketdata FK、无新 cross-context owner；**确认 allotment 独立表未写 corporate_action**，plan Decision 3）+ **🚨 4 端点逐个对 prod 77 容器 read-only live-probe 确认 `code=1`**（FR-011，p1 血泪纪律；探针挂 auto-mode 需 user `!`/授权）+ **端到端 hk 真数据 smoke**（`MARKETDATA_PROVIDER=live` + `LIXINGER_TOKEN`：`hk:00700` buyback/equity_change/shareholder_change backfill + allotment 扫候选池）→ 抽样核对理杏仁一致（SC-001/002）+ env-gated 契约 it 转真调确认 param 契约 + 字段 schema + **🔴 C1 护栏：先核回购/股本变动同日多事件基数** —— 若某标的某日 vendor 返 >1 事件，`(instrumentId,date)` NK 会 `skipDuplicates` 丢行 → **回改 T001/T002 扩键加判别字段（seq / payload hash），本 PR 未 merge 前必调**；实测 =1 则记 verified、NK 定案 + 回写 plan §Deferred-probes（buyback Decimal 精度 / **配股零样本 or 首样本字段** / shareholder sharesType 值域）。**⚠️ 全量多夜回填 = 后续 ops（master INV-3），非本 PR 范围**。✅ **T018 verified 2026-07-15（prod 77 read-only 探针）**：全绿门/moat/Decision3 隔离 ✅；FR-011 4 端点 code=1 ✅（repurchase/equity/shareholder 有数据、allotment code=1 no-data）；🔴 C1 真调证同日多事件（buyback 汇丰 00005 同日双盘 GBP+HKD、shareholder 同股东同日多笔+第三类 sharesType `P`）→ NK 扩键 ship（`6b336c33`，业内 Data Vault/dbt/Kafka 混合方案）✅；SC-001/002 read-only 实证（hk:00700 buyback 623 行/~8yr 字段齐、shareholder 349 行 L/S/P 保真、equity 464 行）✅；单股 live-write smoke 归首夜 supervised ops（plan out-of-scope，user 2026-07-15 定）。
  - ⟨C1 verified 2026-07-15 · T018 真 vendor read-only 探针（prod 77 `nvy-tight-app-1`，真 `LIXINGER_TOKEN`）〕：**同日多事件真实存在** → ① buyback 汇丰 00005 2025-10-17 同日 2 笔（`_id` `...dcd` GBP/turquoise + `...dce` HKD/exchange，两市场回购）→ NK 扩 `vendorEventId`；② shareholder JPMorgan 09988 2025-06-12 同日 3 笔（involved 不同，含第三类 `sharesType:"P"`）+ 汇丰同股东同日 2 笔 → NK 扩 `contentHash`（Data Vault hashdiff）；③ equity_change 全 8 股 maxPerDay=1 → NK 不动；④ allotment 零样本 → NK 不动（documented revisit）；⑤ shareholder 多返 `numOfSharesInvolvedList` + 第三类 `sharesType:"P"` → payload 整存整行无损（验证 Decision 4 对）。**扩键已 impl（C1 fix commit），本行仍 `[ ]`：4 端点 code=1 live-probe + 端到端 hk 真数据 smoke（`MARKETDATA_PROVIDER=live`）待 user 确认后翻 `[X]`。**

---

## Dependencies & 执行顺序

```
Phase 1 地基（T001 schema → T002 migration → T003 schema IT）
  ↓（migrate deploy 是所有 Phase IT 前置；纯数据层立即编译绿）
Phase 2 US1 回购〔MVP〕（T004[P] adapter → T005 装配 → T006 IT）
  ↓
Phase 3 US2 股本变动（T007[P] adapter → T008 装配 → T009 IT）
  ↓
Phase 4 US3 股东权益变动（T010[P] adapter → T011 装配 → T012 IT）
  ↓
Phase 5 US4 配股（T013[P] adapter → T014 装配 → T015 IT）
  ↓
Phase 6（T016 估算 → T017 pacing/无回归 IT → T018 全绿门+真调）
```

- **硬前置**：Phase 1（migration）→ 全部 Phase IT；每维度 adapter（`[P]`）→ 其装配 task。
- **可并行 `[P]`**：T004 ∥ T007 ∥ T010 ∥ T013（4 个 adapter 不同文件、互不依赖，纯 adapter 层可并行编写）。
- **必串行**：装配 task（T005 / T008 / T011 / T014）均改 `dimension-executor.ts`/`marketdata.module.ts` **同文件** ⇒ 顺序化（exhaustive Record 每次 +1 entry 才编译绿；key 在各自 adapter task T004/T007/T010/T013 加）。
- **关键路径** = T001→T002→(T004→T005)→(T007→T008)→(T010→T011)→(T013→T014)→T017→T018。
- **MVP** = Phase 1 + Phase 2（回购事件落库即「回购因子可回测」，回测价值最高的切片）。

## state_branch 覆盖矩阵（12 条 → IT task）

| state_branch | IT task |
| --- | --- |
| 回购事件回填 | T006 |
| 股本变动回填 | T009 |
| 股东权益变动嵌套 | T012 |
| 配股罕见零样本 | T015 |
| 全部单数 stockCode+range 契约 | T004/T007/T010/T013（adapter 单测）+ T006/T009/T012/T015（executor）+ T018（真 vendor）|
| 事件流可回填历史 | T006/T009/T012/T015 + T016（估算）|
| 无 metricsList all-or-nothing 坑 | T004/T007/T010/T013（adapter 无 metricsList）+ T018 |
| 4 维度 marketScope 纳入 | T003（seed）/ T006/T009/T012/T015 / T017（全工作集）|
| 新表 market-agnostic | T003 |
| 依赖 universe | T003（soft 边）|
| 回填自限速续跑 | T016（估算）/ T017（限速+续跑）|
| p1/p2/040/A股无回归 | T017 / T018 |

（FR-012 cronExpr 分档 → T002 seed + T003 断言；非 state_branch 单列。）

## 单 PR（Constitution §V）

默认单 PR（4 维度 6 件套 ×4）。若 impl 中发现 PR 过大需增量隔离：Phase 1（schema 地基，编译绿）可单独先 ship 验稳，Phase 2-6（各维度装配）第二个 PR —— task 边界已按 Phase 对齐。4 维度同 executor 形态（mode-based 区间，照抄 `syncEodBars`），装配高度同构，唯 US3 嵌套 payload 保真 + US4 零样本容错为差异点。
