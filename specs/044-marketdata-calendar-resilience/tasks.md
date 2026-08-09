---
feature_id: 044-marketdata-calendar-resilience
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: 2026-07-16
updated_at: 2026-07-16
---

# Tasks: 044-marketdata-calendar-resilience（交易日历数据源韧性改造）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `044-marketdata-calendar-resilience`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 多源降级 / US2 合理性闸 / US3 告警+看守）；地基 / 收口不带
- 层 = `[Server]` / `[Server-IT]` / `[Ops]` / `[Verify]`（**纯 server + ops 脚本，无 UI / 无新读端点 / 无 OpenAPI 变更 → 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]`**，plan §Constitution §V）
- **单 PR**（一 feature = 一分支 = 一 PR）；Phase = 逻辑 task 组（非 PR 拆）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（adapter 请求/解析、链、闸、PDF 文本解析）= vitest 无 DB；落库/心跳/幂等/per-market 独立 = Testcontainers PG（run via `nx test server <file>`，cwd=apps/server，memory `testcontainers_spec_run_via_nx_cwd`）；**每 Phase 末单列 `[Server-IT]`**；vendor 契约 = mock 单测 + env-gated 真 vendor IT（`RUN_MARKETDATA_IT`，默认 skip）
- **22 条 `state_branches`（spec frontmatter）逐条须在测试有 `it()`**（覆盖矩阵见文末）
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`（nx cache 对新文件可能假绿）
- ✅ **数据源已 prod 77 PoC verified（2026-07-16）** → 本 tasks 建立在实证上（腾讯 vs 库 hk 128/128 + cn 126/126 零差异；HKEX PDF vs 库 9/9 含 Half Day；Connect 陷阱 4/4），**不留悬念**（详见 [plan.md](./plan.md) §L2 数据获取 + Decision 2/4）

## Path Conventions

- server：`apps/server/src/marketdata/`（扁平文件平铺，ADR-0043，改动全在 marketdata 单 bounded context 内）
- migration：`apps/server/prisma/migrations/20260716_XXXX_create_calendar_sync_health/`（**expand-only**，1 `CREATE TABLE`，`migration_refs` frontmatter ADR-0035）
- IT：`apps/server/test/integration/marketdata.calendar-044.*.it.spec.ts`
- ops：`ops/marketdata-calendar-health/`（新）+ `ops/marketdata-sync-report/report.sh`（改）
- 生成脚本：`scripts/checks/gen-static-calendar.ts`（离线，人工年更）
- 本地起服/IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`（memory `local_it_smoke_needs_env_unset_oss`）；dev DB `docker compose -f docker-compose.dev.yml up -d --wait`（mbw-poc-postgres:5433 / redis:6380）

---

## 🚨 Impl Guardrails（PoC 实证，每条都是会被盲写踩掉的坑）

1. **分片 + 每片 `limit = 片内自然日数`**（FR-016）—— 腾讯 `param` 尾参是「取最近 N 条」的**截断器**（老端静默截断：limit=5→5 天 / 10→10 天 / **0→1 天** / **省略→空**），**且有硬上限 2000**（PoC 二分：2000 ✓ / **2001 ✗**；只由 limit 值触发，与区间宽度无关）。规约：

   ```text
   CAP = 2000（vendor 硬上限）   SAFE_CHUNK = 1800（留 200 余量）
   区间切成每片自然日数 ≤ SAFE_CHUNK → 每片 limit = 片内自然日数 → concat + 按日期去重
   ```

   「交易日数 ≤ 自然日数」恒成立 ⇒ 每片 `limit = 片内自然日数` **由构造保证永不截断**。**禁**省略、**禁**传 0、**🚨 禁 `limit = min(windowDays, CAP)`**（把超限报错换成静默截断 = 响亮错误退化成无声错误）。日常 30 天填充 = 1 片、**行为零变**；seed CLI 10yr = 3 片。★ 等价性 PoC 实证：7yr 单次 **1725** 天 vs 2 片拼接 **1725** 天 —— 零丢失/零重复/片间零重叠。
2. **🚨 闸拦不住中度截断** —— `limit=10` → 返 10 天 > 下界 9 → **闸放行** → 写入残缺日历。**截断靠构造消除（第 1 条），闸只兜底 0/1/2 级粗暴毒饵。两者不可互相替代。**
3. **响应 key ≠ 请求参数** —— 请求 `usDJI` → 响应 key 回显 `us.DJI`。**禁按请求参数查 key**，须取 `Object.values(data)[0]`。
4. **🚨🚨 `code:0` 不是成功信号**（FR-015）—— 超限错误响应 = `{"code":0,"msg":"param error","data":[]}`，与正常响应 `{"code":0,"msg":""}` **共用 code 0**。**必须按 shape 判**（`data` 是非数组对象 且 `msg` 为空）→ 否则 **throw**（**不可返空**，否则链降不了级）。注意 `Object.values([])[0]` → `undefined` → 崩溃或静默空。**push2delay 同款陷阱在新源上重现。**
5. **`Half Day` = 交易日** —— HKEX PDF 的除夕/平安夜半日市。误当 Holiday → 每年丢数个交易日（实证 2026-02-16 HK `Half Day` → 库里**有**）。
6. **🚨 禁取 `Northbound/Southbound Trading` 行** —— Connect 关闭 **≠** 市场休市。必须取 `Hong Kong` / `Shanghai & Shenzhen` 行（实证 4/4：7-01 HK Holiday + Connect 双向 Closed，但 SH&SZ 开市）。取错行 → cn 每年凭空丢掉所有港股独有假期。
7. **静态源区间外必须 throw、禁返空** —— 且**「部分重叠」同样 throw**（判据是「完全包含」不是「有交集」；如跨年窗 2026-12-20..2027-01-20）。否则静态层自己就是第二个 push2delay。
8. **降级 ≠ 健康**（FR-014）—— L2 接住时填充虽成功，但**必须记 `servedBy` 并告警**。原设计「降级后不告警」会让降级静默数月、跨年才全盘爆炸 —— **本 feature 就是来消灭静默降级的，别自己留一个**。

---

## Phase 1: 地基（port 改名 + 心跳表）🎯

**Independent Test**: 改名后全仓编译绿、行为零变；Testcontainers PG `migrate deploy` → `calendar_sync_health` 表 + 约束存在；`check-server-moat` 0 违规。**纯重命名 + 纯数据层，不动链路 ⇒ 立即编译绿**。

- [X] T001 [Server] **Port 改名 + 契约扩展（载 `servedBy`）**：`apps/server/src/marketdata/index-calendar-source.port.ts` → `trading-calendar-source.port.ts`（`INDEX_CALENDAR_SOURCE` → `TRADING_CALENDAR_SOURCE`）+ **契约扩展**：`fetchTradingDates(market, from, to): Promise<{ dates: string[]; servedBy: string }>`（**每个 adapter 自报家门**，链原样返回胜出节点的结果 → 降级可观测，FR-014；契约改动与改名同族，**并入本 task 一次过**，免 adapter 被改两轮）+ **全引用点同步（5 impl/消费点 + 2 既有 IT，逐个点名，勿靠「全引用点」四字含糊过去）**：① `mock-market-data.adapter.ts`〔**implements 该 port**（`:86` / `fetchTradingDates` `:132`），返 `servedBy:'mock'`〕② `eastmoney-index-calendar.adapter.ts`〔补 `servedBy:'eastmoney'`，T008 即删，短命但保编译绿〕③ `trading-calendar-sync.service.ts`〔`:72` `const dates = await this.source.fetchTradingDates(...)` → 改取 `.dates`〕④ `marketdata.module.ts` ⑤ port 自身 ⑥ **既有 IT `test/integration/marketdata.trading-calendar-sync.it.spec.ts` 的内联 mock（`:27`）**〔契约改必破，B3〕⑦ **既有 IT `test/integration/marketdata.eastmoney-vendor.it.spec.ts`**〔`:6` import + `:110` 日历源块，T008 处理，见该 task〕+ **两个 port 文件头各加一行读/写对照注释**（`TradingCalendarSource` = 写入源拉 vendor ／ 既有 `TradingCalendarPort` = 读表判 gate，plan Decision 1 命名接近风险）→ verify: `nx typecheck server` + `nx test server marketdata` 全绿、**落库行为零变**（仅 port 形态 + 改名，无业务逻辑改动）
- [X] T002 [Server] **心跳表 `CalendarSyncHealth` + migration**：`schema.prisma` 新增 model（`market String @id @db.VarChar(8)` + `lastSuccessAt DateTime?` + `lastAttemptAt DateTime?` + `lastError String? @db.Text` + **`servedBy String? @map("served_by") @db.VarChar(16)`**〔降级可观测载体，记本次成功由链上哪层服务，如 `'tencent'`/`'static'`，plan Decision 5 + FR-014〕；`@@schema("marketdata")` + `@@map("calendar_sync_health")`；**无 instrument FK** —— 市场级非标的级）+ `apps/server/prisma/migrations/20260716_XXXX_create_calendar_sync_health/migration.sql`（1 `CREATE TABLE`，DDL 由 `prisma migrate diff --from-config-datasource --to-schema` 生成零 drift，样板 043 `20260715_1800_create_hk_classification_text_tables`；顶部 `-- migration_refs: specs/044-marketdata-calendar-resilience`）+ **`scripts/checks/check-server-moat.ts` `MODEL_OWNERSHIP` 声明 `calendarSyncHealth→marketdata`**（接线新表铁律，漏则 lefthook 拦）→ verify: `prisma validate` + `generate` + `migrate deploy` dev DB 无 drift + 幂等重 deploy + `nx typecheck server` 绿
- [X] T003 [Server-IT] **Phase 1 schema IT**（Testcontainers PG）：`migrate deploy` → `calendar_sync_health` 表 + PK(`market`) 存在 + 可插 per-market 行 + `check-server-moat.ts` 0 违规。`test/integration/marketdata.calendar-044.schema.it.spec.ts`

---

## Phase 2: US1 多源降级不中断（P1）🏁 MVP

**US1 Independent Test**: Testcontainers PG + mock 源；① L1 成功 → 用其结果、**不调 L2**；② L1 throw → 自动降级 L2、日历完整落库、gate 正常开启；③ per-market 独立（一市场全链失败不影响其余）；④ 重复填充同区间幂等不翻倍；⑤ 降级后结果与 L1 成功时同构。

- [X] T004 [P] [US1] [Server] **L1 腾讯 adapter（含分片）**：`tencent-calendar.adapter.ts`（`implements TradingCalendarSource`；`GET /appstock/app/kline/kline?param=<symbol>,day,<from>,<to>,<limit>`，symbol cn=`sh000001`/hk=`hkHSI`/us=`usDJI`；复用既有 `VendorHttpClient`；**Guardrail 1**：区间按 `SAFE_CHUNK=1800` 自然日**分片** → 每片 `limit = 片内自然日数` → concat + 按日期去重；**Guardrail 4**：按 **shape** 判成功（`data` 非数组对象 且 `msg` 空）→ 否则 **throw**，**禁**把 `code:0` 当成功、**禁**返空；**Guardrail 3**：取 `Object.values(data)[0]` 而非按请求参数查 key；解析 `day[]` 每项首元素为 `YYYY-MM-DD`）→ verify: 新 `tencent-calendar.adapter.spec.ts` 纯函数验：**30 天窗 → 单片且 limit==30**（行为零变）+ **10yr 窗 → 3 片、每片 limit ≤ 1800 且 == 片内自然日数**（Guardrail 1）+ **分片结果 concat 去重后与单片等价、片间零重叠**（FR-016/SC-008）+ **`{"code":0,"msg":"param error","data":[]}` → throw 而非返空**（Guardrail 4，本 feature 的核心防线）+ **us 响应 key 回显 `us.DJI` 仍能正确解析**（Guardrail 3）+ 三市场 symbol 映射 + 未知市场抛错 + 新 vendor it 加 `describe.skipIf(!RUN_MARKETDATA_IT)` 真调（三市场返交易日 + **宽区间分片真调**，固化回归网防其重蹈东财覆辙时无声）
- [X] T005 [P] [US1] [Server] **静态日历生成脚本 + 数据**：`scripts/checks/gen-static-calendar.ts`（**解析 `pdftotext -layout` 的文本输出**，非解析 PDF 本身 ⇒ **仓内零新依赖**；poppler 仅 dev 机年更时用）+ 产物 `apps/server/src/marketdata/static-calendar.data.ts`（cn + hk，**不含 us**，plan clarify Q3）。**Guardrail 4**：`Half Day` 计为交易日；**Guardrail 5**：只取 `Hong Kong` / `Shanghai & Shenzhen` 行，**禁** Connect 行；只列工作日 → 周末天然排除；列按位置对齐 → verify: `scripts/checks/gen-static-calendar.spec.ts` 纯函数验（**以真实 `pdftotext -layout` 输出片段为 fixture**）：Half Day → 交易日 + Connect 行不被误取（构造「HK Holiday + SH&SZ 开市 + Connect Closed」样本断言 cn 仍有该日）+ 只取工作日 + 跨月块解析。**产物数据须与 plan §三方互证的探针日一致**（2026-02-16 有 / 02-17 无 / 07-01 hk 无但 cn 有）
- [X] T006 [US1] [Server] **L2 静态 adapter**：`static-calendar.adapter.ts`（`implements TradingCalendarSource`；读 `static-calendar.data.ts`；**Guardrail 7**：请求区间**未被静态表覆盖范围完全包含 → throw**，禁返空、**禁返「已覆盖的那部分」**（判据 = **完全包含**，非「有交集」；跨年窗 `2026-12-20..2027-01-20` 必 throw）—— 静态层不得成为第二个毒饵；⚠️ 注释写明 **us 不覆盖 + 其无害性依赖「无 `{us}`-only 维度 + gate 取 OR」这一前提，将来新增 `{us}`-only 维度则此假设失效**，plan 风险 4 绊线）→ verify: `static-calendar.adapter.spec.ts`（命中区间 → 返正确日历 / **完全在覆盖外 → throw** / **🚨 部分重叠（跨年窗）→ throw 而非返部分** / 边界年份 / us 请求行为）
- [X] T007 [US1] [Server] **fallback 链（仅 throw 降级）**：`calendar-source-fallback-chain.adapter.ts`（`implements TradingCalendarSource`；`constructor(private readonly nodes: TradingCalendarSource[])`；逐节点 try/catch，**本 task 只实现「throw → 降级」**，合理性闸留 T010；**原样返回胜出节点的 `{dates, servedBy}`**（降级可观测的传递环，FR-014）；全链失败 → throw；`falling through` WARN 日志；**per-market 独立**——链在单次 `fetchTradingDates(market,...)` 调用内工作，per-market 隔离由调用方 `syncRange` 逐市场调用天然保证）。照抄既有 `fallback-chain.adapter.ts` 的**结构/命名/日志范式**，**不复用其代码**（它只 throw-降级，接不住 T010 要加的「成功但空」）→ verify: `calendar-source-fallback-chain.adapter.spec.ts`（L1 成功 → **不调 L2**（断言 spy 未被调用）/ L1 throw → 降级 L2 / 全链 throw → 抛错 / 单节点链）
- [X] T008 [US1] [Server] **装配 + 退役东财**：`trading-calendar-sync.service.ts` 注入 `TRADING_CALENDAR_SOURCE`（现为链）+ `marketdata.module.ts` provider 工厂组链（`kind==='mock'?mock:new CalendarSourceFallbackChain([tencent, static])`）+ **删 `eastmoney-index-calendar.adapter.ts` + `eastmoney-index-calendar.adapter.spec.ts`**（FR-007：端点已被定向下线 + `robots.txt` 明确 `Disallow: /`；本 task 产生的 orphan → 必清）+ 🚨 **外科式处理 `test/integration/marketdata.eastmoney-vendor.it.spec.ts`（B2，最险的一步）**：该文件 **`:6` import `EastmoneyIndexCalendarAdapter`**、**`:110` 有「东财指数日历源真 vendor IT」describe 块** —— 删 adapter 会让 **import 直接炸 → 整个文件编译失败**；而**同文件 `:24`「东财搜索真 vendor IT」+ `:60`「东财 universe 真 vendor IT」是 out-of-scope、必须保留**（那两个 adapter 不同 host、当前可达、本 feature 只治日历）。⇒ **只删 `:6` import + `:110` 起的日历源 describe 块，保留 search/universe 两块**。**禁止一把删整个文件**（会连坐干掉两块无关的真 vendor 回归网）→ verify: `nx typecheck server` + `nx test server marketdata` 无回归 + **`marketdata.eastmoney-vendor.it.spec.ts` 仍存在且 search/universe 两块完好**（`RUN_MARKETDATA_IT` 开时仍可跑）
- [X] T009 [US1] [Server-IT] **US1 集成 IT**（Testcontainers PG，test-local mock 源，骨架照 `marketdata.hk-043.*.it.spec.ts`）：L1 成功 → 落库 + 不调 L2 + gate 开启；**L1 throw → 降级 L2 → 日历完整落库、结果与 L1 成功时同构**；**per-market 降级独立**（hk 全链失败 + cn 由 L1 成功 → cn 照常落库）。⚠️ **不重复既有覆盖（B3 去重）**：「幂等」与「单市场抛错续跑」**已由既有 `marketdata.trading-calendar-sync.it.spec.ts`（`:93`/`:106`）覆盖**，由 T001（契约）/ T012（断言改写）维护 —— **本 task 只测新行为（降级链），别再造一份**。`test/integration/marketdata.calendar-044.fallback.it.spec.ts`。**覆盖 state_branch**: 主源成功不调后续 / 主源异常降级 / per-market 降级独立 / 降级后同构 / L1 失效+L2 命中

---

## Phase 3: US2 合理性闸（P2）—— 防静默毒性

**US2 Independent Test**: mock 源返回「200 + 空数组」/「交易日数低于下界」→ 链**不接受**、继续降级；全链如此 → **显式 throw** 而非静默写空；短窗（<14 天）豁免闸不误伤。

- [X] T010 [US2] [Server] **链上加合理性闸**：`calendar-source-fallback-chain.adapter.ts` 加闸（窗口内交易日数 < `ceil(工作日数 × MIN_RATIO)` → **判该节点失败 → 降级**，不写库；`MIN_RATIO = 0.4`；**短窗豁免**：窗口自然日数 < 14 → 跳过闸并注释说明「工作日基数太小、`×0.4` 退化到 0/1，闸无判别力」，plan Decision 4）→ verify: `calendar-source-fallback-chain.adapter.spec.ts` 扩充：**空数组 → 降级**（push2delay 毒饵形态）+ **低于下界 → 降级** + 30 天窗 20 个交易日 → 放行（PoC 实测常规值）+ **春节窗 15 个 → 放行**（PoC 实测，不误报）+ 短窗豁免 + 全链皆「成功但不合理」→ **throw**（禁静默返空）
- [X] T011 [US2] [Server-IT] **US2 集成 IT**（Testcontainers PG）：L1 返空数组 → 降级 L2 → 落库正确（**不**写入空日历）；全链皆返不合理 → **填充显式失败**且**心跳不更新**（为 US3 铺垫，此处只断言不更新）；**日历表零污染**（不合理数据一行都不得写进 `trading_day`）。`test/integration/marketdata.calendar-044.sanity-gate.it.spec.ts`。**覆盖 state_branch**: 成功但空 → 降级 / 成功但不合理 → 降级 / 全链失败 → 显式失败禁静默

---

## Phase 4: US3 心跳告警 + 修看守盲区（P3）

**US3 Independent Test**: 填充成功 → 心跳更新；填充失败 → 写 `lastError` 且**不**更新 `lastSuccessAt`；心跳陈旧 → 探针 `exit 1` → 飞书告警；看守遇「零 sync_run + 日历不健康」→ 告警而非放行。

- [X] T012 [US3] [Server] **service 写心跳（含 `servedBy`），失败不再静默吞**：`trading-calendar-sync.service.ts` per-market 成功 → upsert `calendar_sync_health` 更新 `lastSuccessAt` + **`servedBy`（取链返回值，FR-014）** + 清 `lastError`；失败 → 更新 `lastAttemptAt` + 写 `lastError`、**不动 `lastSuccessAt`/`servedBy`**；**仍续跑其余市场**（保 FR-004「一市场坏不拖垮全局」）—— **「续跑是韧性，静默才是病」，两者不矛盾**（plan Decision 6）🚨 **同时认领既有 IT `test/integration/marketdata.trading-calendar-sync.it.spec.ts`（B3）**：其 **`:106`「单市场源抛错 → WARN 续跑其余市场」的断言正是本 task 要推翻的行为** —— 改为断言「续跑其余市场 **且** 该市场写 `lastError`、不更新 `lastSuccessAt`」（**续跑保留、静默废除**）；并在既有 `:66`/`:93` 的 upsert/幂等 it 上补心跳断言。**该文件是本 feature 唯一既有的日历 IT，不认领就会烂在那**（T001 已修其内联 mock 的契约）→ verify: `trading-calendar-sync.service.spec.ts`（mock 链：成功更新心跳 + **servedBy 落库** / **L2 服务时 servedBy='static'** / 失败写 lastError 且不更新 lastSuccessAt / 一市场失败其余照跑 / 失败不再被静默吞）+ **既有 `marketdata.trading-calendar-sync.it.spec.ts` 全绿**（4 个 it，含改写后的 `:106`）
- [X] T013 [US3] [Server-IT] **健康谓词 IT（🚨 bash 的 §II 合规承重点）**（Testcontainers PG）：真链跑 → 心跳落库；失败路径 → `lastError` 落库、`lastSuccessAt`/`servedBy` 保持旧值；**把 T014/T015 要用的 SQL 谓词逐条测真**：① 埋 25h / 27h 心跳 → 断言「健康 / 不健康」（26h 阈值）；② **埋 `servedBy='static'` → 断言「降级」**、`servedBy='tencent'` → 断言「正常」（FR-014）；③ 主源恢复（`servedBy` 变回主源）→ 降级信号解除。⚠️ **这是宪法 §II 的合规承重点**（analyze A2 → 裁决 (d)）：bash 侧被压到零逻辑，**判断全在这些谓词里、全在此被真测**。`test/integration/marketdata.calendar-044.health.it.spec.ts`。**覆盖 state_branch**: 日历不健康 → 阈值内告警 / 日历健康（含长假成功零新增）→ 不告警 / **降级须告警** / **主源恢复解除**
- [X] T014 [US3] [Ops] **独立心跳探针（零逻辑 bash）**：`ops/marketdata-calendar-health/check.sh` —— 🚨 **不承载任何判断**（analyze A2 → 裁决 (d)）：只做「跑**一条 T013 已测真的 SQL 谓词** → 映射退出码 → 打印人读摘要」，**无分支、无阈值、无判断**。谓词双条件任一成立即 `exit 1`：① `min(lastSuccessAt)` over **cn+hk** 陈旧 > 26h（**us 排除**，plan Decision 3/风险 4）；② **`servedBy` 非主源**（降级运行，FR-014）。沿用 `report.sh` 的 `docker exec psql` 只读范式 + `SYNC_REPORT_PG_*` 同款 env 约定 + `systemd/marketdata-calendar-health.{service,timer}`（每 4h；由 `nvy-run-reported` 包裹 → 退出码驱动 `feishu-send.sh`，**零新飞书基建**，照 `ops/cert/check-cert-expiry.sh` 先例）+ `ops/runbook/scheduled-tasks.md` 补该任务段 **+ 记静态日历年更 owner/时点**（analyze A6：官方发布次年日历后、当年 12 月前跑一次生成脚本）→ verify: 本地对 dev DB 跑 check.sh 四态（新鲜+主源 → exit 0 / 陈旧 → exit 1 / **降级 servedBy='static' → exit 1** / 恢复 → exit 0）；**探针不经 app 进程**（app 停掉仍能判）
- [X] T015 [US3] [Ops] **修 `report.sh` 循环信任盲区（零逻辑 bash）**：`ops/marketdata-sync-report/report.sh` 零行分支**在「放行」之前**插入一档——跑 **T013 已测真的同一条健康谓词**（不在 bash 里重写判断，analyze A2 → 裁决 (d)），不健康 → `🔴 告警「日历不健康，无法判定停摆」exit 1`（FR-012：**禁止仅据可能已陈旧的日历表判「昨日非交易日、无同步属预期」**）；**FR-013 两项既有能力不回归**（健康+昨日交易日+零行 → 告警 / 健康+昨日非交易日+零行 → 放行）+ 脚本头注释记录本次事故（本盲区正是潜伏 2 天的真凶）+ `ops/runbook/scheduled-tasks.md` 记**人工验证步骤**（bash 侧无单测，plan §已知测试缺口的诚实兜底）→ verify: 本地对 dev DB 三态各跑一次（不健康 → exit 1 / 健康+交易日+零行 → exit 1 / 健康+非交易日+零行 → exit 0）。**覆盖 state_branch**: 看守三分支

---

## Phase 5: 收口（无回归 + 全绿门）

- [X] T016 [Server-IT] **无回归 IT**（Testcontainers PG）：🚨 **必跑全 `NX_DAEMON=false nx test server --skip-nx-cache`（非代表性子集）**。新表使 schema 表数 **27→28** → `schema-015`/`schema-016`/`schema-017` 等断言**表数/表清单**的全景 IT **必破**（照 039-043 先例，逐个更新期望值，**仅改既有全景 IT 期望值、不动 044 impl**）。
  ✅ **实测结果（全量 344 文件 / 2780 test）**：**恰好 2 红**，均为表清单断言 —— `schema-015:52` + `schema-016:42`，diff 唯一差异 = `+ calendar_sync_health`（已按实测更新期望值 27→28）。**`schema-017` 实测不受影响**（其 `information_schema.tables` 查询按 `table_name = 'sync_dependency'` 过滤单表，非表清单）→ **未改**。**「维度数 22」类断言全绿、零改**（本 feature 不增维，与 039-043 增维场景不同 —— 惯性改就错了）。**上游认领的 2 个日历 IT（`trading-calendar-sync` / `eastmoney-vendor`）实测全绿** → T001/T008/T012 已落实。⚠️ 本 feature **不改** `trading_day` 表结构 / 消费侧读表 / tick claim / gate / backfill CLI ⇒ **维度数仍 22、seed 边不变** → 那批「维度数」类断言**理论零改**（与 039-043 的增维场景不同，**别惯性改**）。
  🚨 **但「只有表数会破」是错的（B4 修正）**：另有 **2 个日历 IT 会因契约/行为改动而破，与表数无关**，且**各有主人、不由本 task 兜底**：① `marketdata.trading-calendar-sync.it.spec.ts` → **T001**（内联 mock 契约）+ **T012**（`:106` 断言改写）；② `marketdata.eastmoney-vendor.it.spec.ts` → **T008**（外科式删日历块、保 search/universe）。本 task 跑全量时**若它们还红，说明上游 task 没做完**，回去补，别在这里打补丁。**覆盖 state_branch**: `app 进程不可用 → 独立探针仍能告警`（探针不依赖 app 的结构性证明）
  → 该论证已落成**可核验断言**：`test/integration/marketdata.calendar-044.probe-independence.it.spec.ts`（**真跑 `bash check.sh` → `docker exec psql` → PG，全程零 app 进程**：不起 Nest / 不起 HTTP / 不 import 任何 marketdata service ⇒ 探针在此绿 = app 挂掉时同样绿）。4 行为断言（新鲜→exit 0 / 27h 陈旧→exit 1 / `servedBy=static` 降级→exit 1 / 心跳表空→exit 1）+ 1 源码断言（check.sh 无 `curl`/`http`/`node` 等 app 耦合、无内联 SQL）。⇒ 顺带把 plan §Testing Invariants 自认的**残余**（「bash 接线仍靠人工验证」）从 runbook 手册步骤收成了自动断言。
- [X] T017 [Verify] **全绿门**：`NX_DAEMON=false nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` 全绿（NX_EXIT=0）+ `check-server-moat.ts` 0 违规（新表 intra-marketdata owner 已声明、无 cross-context）+ env-gated 真 vendor IT 默认 skip 不触真 vendor。
  ✅ **实测（2026-07-16）**：① **NX_EXIT=0** —— `Successfully ran targets lint, typecheck, test, build, runtime-smoke for 4 projects`；server test **336 passed | 9 skipped (345)** 零失败（345 = T016 前的 344 + 新增探针独立性 IT），lint **0 errors**（46 warnings 全为既有）。② `check-server-moat.ts` **exit 0 / 0 违规** —— `calendarSyncHealth: 'marketdata'` 已声明（`:91`），intra-marketdata 无 cross-context 注入。③ **9 skipped 全为 env-gated 真 vendor IT**（tencent 5 / eastmoney 6 / lixinger 25 / crosscheck 2 / realtime-quote 5 个 test，`RUN_MARKETDATA_IT` 未设）→ **零真 vendor 触达**。**⏸️ deferred 上线后 ops（非本 PR）**：① 07-15/07-16 缺口回补（走 backfill CLI + `hk-marketdata-backfill-first-night.md` 铁律：**1.6GB host 禁全量 fundamental 重跑** / 禁并发两个 CLI / `--timeout` ≠ job 失败）；② 040-043 那 11 维首夜全量回填（master INV-3）

---

## Dependencies & 执行顺序

```
Phase 1 地基（T001 port 改名 → T002 心跳表+migration → T003 schema IT）
  ↓（改名是全部后续 task 的前置；心跳表是 US3 前置，但先落地保 migration 早验）
Phase 2 US1 多源降级〔MVP〕（T004[P] L1 ∥ T005[P] 静态数据 → T006 L2 adapter → T007 链 → T008 装配+退役东财 → T009 IT）
  ↓
Phase 3 US2 合理性闸（T010 闸 → T011 IT）
  ↓
Phase 4 US3 告警（T012 心跳 → T013 IT → T014 探针 → T015 看守）
  ↓
Phase 5 收口（T016 无回归 → T017 全绿门）
```

- **硬前置**：T001（改名）→ 全部；T002（心跳表）→ T012/T013/T014/T015；T007（链）→ T010（闸加在链上，同文件）。
- **可并行 `[P]`**：T004 ∥ T005（L1 adapter 与静态数据生成，不同文件、互不依赖）。
- **必串行**：T007 → T010（**同文件** `calendar-source-fallback-chain.adapter.ts`）；T012 → T013。
- **关键路径** = T001→T002→(T004∥T005)→T006→T007→T008→T009→T010→T012→T016→T017。
- **MVP** = Phase 1 + Phase 2（日历有活源 + 能降级，同步不再单点死）。⚠️ **但 MVP 单独上线不安全** —— 无 T010 闸时，L1 若返「成功但空」会静默写空日历。**US2 应与 US1 同 PR 上线**（本 feature 本就单 PR，此处仅提示别拆）。

## state_branch 覆盖矩阵（22 条 → task）

| state_branch | task |
| --- | --- |
| 主源成功 → 不调后续节点 | T007（spy 断言）/ T009 |
| 主源抛异常 → 降级 | T007 / T009 |
| 主源「成功但空」→ 判失败降级 | **T010** / T011 |
| 主源「成功但不合理」→ 判失败降级 | **T010** / T011 |
| **源「成功码 + 错误消息 + 空数据」→ 判失败降级**（禁把 code 当成功）| **T004**（Guardrail 4）/ T011 |
| 全链失败 → 显式失败禁静默 | T010 / T011 |
| per-market 独立降级 | T007 / T009（降级场景）/ **T012**（既有 IT `:106` 断言改写：续跑保留 + 写 lastError）|
| 降级后结果同构 | T009 |
| 幂等（同 (market,date) 不翻倍）| **既有 IT `marketdata.trading-calendar-sync.it.spec.ts:93`**（T001 修契约 / T012 补心跳断言）—— B3 去重：T009 不重造 |
| **L1 失效 + L2 命中 → 填充成功但记 servedBy 并告警**（不再「不告警」）| T009 / **T012**（落库）/ **T013**（谓词）/ T014 |
| **主源恢复 → 降级信号解除** | **T013** / T014 |
| **静态源完全在覆盖外 → 判失败禁返空** | **T006** |
| **静态源部分重叠（跨年窗）→ 判失败禁返部分** | **T006** |
| 静态源不覆盖 us → us 陈旧但不阻塞 | T006（注释+行为）/ T016 |
| **宽区间分片合并 == 等价单次（零丢失/零重复）** | **T004**（Guardrail 1 / SC-008）|
| 日历不健康 → 阈值内告警 | T013（26h 谓词测真）/ T014 |
| 日历健康（含长假成功零新增）→ 不告警 | T013 / T014 |
| app 不可用 → 独立探针仍能告警 | T014（探针不经 app）/ T016 |
| 看守：零行 + 日历不健康 → **告警** | **T015** |
| 看守：零行 + 健康 + 昨日非交易日 → 放行 | T015（FR-013 不回归）|
| 看守：零行 + 健康 + 昨日交易日 → 告警 | T015（FR-013 不回归）|
| 日常 30 天窗 → 单片、行为零变 | T004 |

## 单 PR（Constitution §V）

默认单 PR（server 链路 + 心跳 + ops 探针/看守）。纯 server + ops 脚本，无 mobile / 无 api-client regen / 无 OpenAPI 变更。⚠️ **US1 与 US2 不可拆 PR**（见 Dependencies 的 MVP 提示：无闸的链会静默写空）。
