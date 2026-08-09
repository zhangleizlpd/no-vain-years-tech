---
feature_id: 042-hk-marketdata-reporting-period
spec_ref: ./spec.md
status: drafted
created_at: 2026-07-15
updated_at: 2026-07-15
adr_refs: [ADR-0043, ADR-0035, ADR-0040]
context7_verified: []
---

# Plan: 042-hk-marketdata-reporting-period（港股报告期 3 维度）

> **prose-only**（per [sdd.md](../../docs/conventions/sdd.md) 反模式）。数据模型 SoT = `apps/server/prisma/schema.prisma`，API SoT = 无（本 feature 无新读端点）。**不镜像** schema/OpenAPI，不造 research.md/data-model.md/quickstart.md/contracts/。
> **Spec**: [`spec.md`](./spec.md) | **Master**: [hk-marketdata p3](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md「p3」) | **PoC**: [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md)

## Summary

在 p1（038）平台 + p2（039）/040/041「加一个 marketdata 维度」范式上，**新增 3 个港股报告期维度**：**营收构成**（`RevenueSegment`，分部级 typed 子行，字段最丰、量化价值最高）+ **最新股东**（`ShareholderSnapshot`，嵌套 L/S payload Json，复用 041 范式）+ **员工**（`EmployeeSnapshot`，报告期 typed 子行，含 displayType 语义）。各落一张 market-agnostic 事实表 + instrument FK，服务量化回测。3 端点均 param 契约第一类（单数 `stockCode` + `startDate/endDate` 区间，**可回填历史报告期序列**），executor 一律照抄 `syncEodBars` 的 mode-based 单标的区间形态（同 041 四维）。纯 server 数据摄取，单 bounded context（marketdata），单 PR，无 UI/mockup/契约变更。形态族「报告期」= p3 拆 4 spec 第 3 个（承接 040 日频因子 + 041 事件流）。

## Technical Approach — 复用「加一个 marketdata 维度」既有模式

每个新维度 = 同一套文件触点（照抄 039/040/041，不发明），均 `apps/server/src/marketdata/`（扁平 per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）：

1. `<dim>.port.ts`（新，×3：`revenue-segment` / `shareholder-snapshot` / `employee`）— Symbol token + interface（样板 `shareholder-change.port.ts`；单方法 `getXxxRange({symbol, from, to?})`）
2. `marketdata.types.ts` — 加 3 组 `XxxQuery`+`XxxDto`（金融数值跨边界一律 `string|null`；嵌套/未知结构走 `payload`）；`dimension-executor.ts` 的 `DIMENSION_KEYS` 加 `'revenue_segment'` / `'shareholder_snapshot'` / `'employee'`
3. `lixinger-<dim>.adapter.ts`（新，×3）— `extends LixingerAdapterBase`（基类 `post(path,body)` 注 token + 解析 `{code,message,data}` 信封）；`toLixinger(sym)` 取 `{market,stockCode}` → `/${market}/company/{operation-revenue-constitution|latest-shareholders|employee}`，`startDate/endDate` 区间（样板 `lixinger-shareholder-change.adapter.ts` range 形态）
4. `mock-market-data.adapter.ts` — `implements` 3 Port + cn/hk fixture（hk fixture 用 test-local mock 护 seam；营收/员工 fixture 含「维度头行 + 数据行」混合结构，护解析分支）
5. `dimension-executor.ts` — `buildExecutors` 加 3 entry（走 `factExecutor` 继承 marketScope 过滤 + syncTier 序）+ `syncRevenueSegment` / `syncShareholderSnapshot` / `syncEmployee` 方法（均 mode-based 区间，照抄 `syncBuyback`/`syncShareholderChange`）
6. `marketdata.module.ts` — provider 工厂 `cfg.kind==='mock'?mock:new LixingerXxxAdapter(...)`（3 端点无 fsType → 无-Prisma 工厂分支）
7. `schema.prisma` — 3 新 model `@@schema("marketdata")` + instrument FK cascade + `@@unique(自然键)` + Instrument 反向关系（typed 子行样板 `BuybackEvent` flat 列；payload+hash 样板 `ShareholderChange`）
8. migration（新，expand-only）— 3× `CREATE TABLE`+FK + `sync_dimension` seed 3 行（`marketScope={hk}`，**cronExpr 统一季频** `0 0 22 1 */3 *`）+ 3× `universe→dim` soft 边（`-- migration_refs:` frontmatter per [ADR-0035](../../docs/adr/0035-data-layer-governance.md)）
9. `lixinger-adapters.spec.ts` — 纯函数单测（mock HTTP + mock Prisma）：3 端点区间请求结构 + 解析（营收 header/data 分离 + typed 子行 / 员工 displayType 保留 + typed 子行 / 股东嵌套 L/S payload + content_hash）
10. `test/integration/marketdata.hk-042.<x>.it.spec.ts`（新）— Testcontainers PG + test-local mock hk + `buildRegistry` 手工装配（骨架 `marketdata.hk-041.*.it.spec.ts`）
11. `marketdata.lixinger-vendor.it.spec.ts` — 加 `describe.skipIf(!RUN_MARKETDATA_IT)` 真 vendor 契约 it（3 端点真返 + 营收/员工 dataList 结构 + 最新股东 date 语义确认）

## Decisions

1. **Phase 1 只动 schema+migration**（不碰 TS executor）→ 立即编译绿。`buildExecutors():Record<DimensionKey,…>`（`dimension-executor.ts:332`）编译器强制 exhaustive：往 `DIMENSION_KEYS`（`:45`）加 key 必须同 commit 补 entry。故地基先纯数据层，后续每 Phase「加 key+加 entry+装配」原子落地（照 039/040/041 Decision 1）。

2. **3 端点均单数 `stockCode` + `startDate/endDate` 区间 ⇒ 照抄 `eod_bar` 单方法** `getXxxRange({symbol, from, to?})`，executor 按 `mode` 算 `from`（delta=近窗 / backfill=asOf−historyDepth）。与 041 四维同形态、同 range 契约。**均不用 `metricsList`** → 无 p1 #670 all-or-nothing 静默 0 行坑（p3 probe §3 已确认）。

3. **🔑 营收构成 / 员工 = 展开 typed 子行**（clarify 2026-07-15 定 spec Q1；**✅ prod 77 probe 2026-07-15 verified**，见 §风险 #1）：vendor `dataList[]` 是「维度头行 + 数据行」混合结构，展开为 typed 列子行：
   - **头行判别规则（probe 精确化）**：**跳过 iff `parentItemName == null` 且所有 value 字段皆 null**（= 纯顶层分组标签，如营收 "按服務類型分"/"按地區分"）。**有 `parentItemName` 的行一律落库**（value 可为 null —— probe 实证 HSBC "按地區分" 下 英國/香港 等 5 行有 parent 但无 revenue，是缺值数据行、非头行）；无 parentItemName 但有 value 的顶层行（如营收 合計 / 员工 "员工总数"）也落库、`parentItemName` 落 sentinel `''`（见 Decision 6）。
   - **key 归一化（probe 发现脏数据）**：`parentItemName`/`itemName` 解析时 **`.trim()`**（vendor 带尾随空格，如 `"按年龄分 "`/`"流失率按性别分 "`）→ 否则量化 `GROUP BY parentItemName` 漏行、跨期同组 key 不一致。
   - `RevenueSegment`：`{date, declarationDate, currency, parentItemName, itemName, revenue, costs, grossProfitMargin}`。NK = `(instrumentId, date, parentItemName, itemName)`（**probe verified 22 期 0 碰撞**，含 "其他" 跨两组不撞）。金额 `Decimal(24,2)`（**signed** —— probe 实证营收可负，HSBC 企業中心 −1e10；max 7.5e11 不溢出）、毛利率 `Decimal(10,6)` signed；per-报告期 metadata `declarationDate`/`currency` 反规范化到每行。
   - `EmployeeSnapshot`：`{date, declarationDate, parentItemName, itemName, value, displayType}`。**NK = `(instrumentId, date, parentItemName, itemName, displayType)`** —— **probe 实证 `(parent,item)` 6/10 期碰撞**（同名 number+percentage 两行，如 `流失率按性别分‖男性 = {58812 number, 15.2 percentage}`），**加 displayType 后 00700+00005 全期 0 碰撞** → displayType 进 NK 完全去重、无需 content_hash。`value` `Decimal(20,4)`（兼容 headcount 与 percentage）；`displayType` VarChar（number/percentage 语义判别，**不可丢**，既是数据也是 NK 列）。
   - 量化可直接 SQL 查分部营收 / 毛利 / 人效，与 041「稳定字段用 typed 列」原则一致。**拒绝** payload Json 整存（量化查分部须应用层解析、无法索引化过滤）。

4. **最新股东 = 扁平行 `(instrumentId, date, shareholderName)` + `payload Json` + `contentHash`，直接复用 041 `ShareholderChange` 范式**：vendor `latest-shareholders` 返嵌套 `numOfSharesInterestedList[]`/`percentageOfIssuedVotingShares[]`（每项 `{value, sharesType:L/S}`，041 T018 实证有第三类 `sharesType:"P"`）→ payload Json 整存整行**无损容纳 L/S 及第三类**，零 schema churn。NK 扩 `contentHash`（vendor 原始行 canonical sha256，Data Vault hashdiff）应对同股东同日多笔（041 T018 已实证此模式真实存在）。**与 041 `ShareholderChange` 是不同语义、独立表** —— 本表 = 报告期股东名册（`shareholder_snapshot`），041 = 权益变动事件（`shareholder_change`）；同范式不同表，master INV-1 已如此归并。

5. **cron 统一季频 = 纯 seed，零 schema 变更**（clarify 2026-07-15 定，spec Q2）：`SyncDimension.cronExpr`（VarChar 64）表达 cadence → 3 维统一季频 cron `0 0 22 1 */3 *`（每季度首月 1 日 22:00 上海时区，贴 HK 半年报/年报 ~2x/年披露）。`freshnessProfile` seed `'slow-drift'`、`slaHours=null`（报告期低频，不做 continuous-daily 新鲜度门，同 041 shareholder/allotment）。`historyDepth=3650`（10 年报告期回填），`adjustTypes={none}`（报告期无复权口径），`batchSize=1`。

6. **营收/员工 NK 列全 NOT NULL + sentinel `''`**（per [migration-rules](../../.claude/rules/migration-rules.md) §4）：top-level / 「合計」/ "员工总数" 等无 parentItemName 的行 → parentItemName 落哨兵空串 `''`（PG 视多 NULL 互异 → NULL 进 NK 不去重，违约束意图）。营收 NK = `(instrumentId, date, parentItemName, itemName)`（4 列）；**员工 NK = `(instrumentId, date, parentItemName, itemName, displayType)`（5 列，Decision 3 probe 定）**，displayType 亦 NOT NULL（probe 实证员工行恒有 displayType；防御性缺失落 `''`）。

7. **只挂 `universe→dim` soft 边**（3×）→ 避 `sync-flow-assembler.ts assertEdgesExpressible` 对 hard 边的拓扑相邻硬校验；零拓扑风险（照 039/041 Decision 7）。回填 per-stock 前 `backfillPacer.pace()` 护共享令牌桶。

## 三维 executor 形态

| 维度 | 表 | 形态（照抄谁）| 落库自然键 | 关键差异 |
| --- | --- | --- | --- | --- |
| **revenue_segment** | `RevenueSegment`（新，flat typed 子行）| `syncBuyback`（mode 分 from）| `(instrumentId, date, parentItemName, itemName)` | 单数 stockCode+range；头行判别（无 parent+无 value 才跳）；有 parent 缺 value 存 null；trim 归一 key；revenue signed 可负；**probe verified 22期 0 碰撞** |
| **shareholder_snapshot** | `ShareholderSnapshot`（新，flat+payload+hash）| 同上 | `(instrumentId, date, shareholderName, contentHash)` | 嵌套 L/S/**P** 三类存 payload Json；缺型存 null 不崩；contentHash sha256 hashdiff（复用 041 范式；probe 本 2 股 (name,date) 无碰撞但保留更稳）；**SERIES 可回填** |
| **employee** | `EmployeeSnapshot`（新，flat typed 子行）| 同上 | `(instrumentId, date, parentItemName, itemName, displayType)` | dataList 展开 typed 子行；**displayType 进 NK**（probe 实证同名 number+percentage 两行，加 displayType 全期 0 碰撞）；trim 归一 key；itemName 通用键值对不硬编码维度 |

共性：均经 `factExecutor` 继承 `loadActiveInstruments`（marketScope∩markets 过滤 + syncTier 序，零改）；均不注 Prisma（无 fsType）；均 soft-依赖 `universe`；空返回（无披露标的）→ 零行不崩不阻塞（沿 039 connect_holding 空返回范式）。

## Testing Invariants（per [ADR-0040](../../docs/adr/0040-multi-layer-test-gate.md) + tasks.md 覆盖矩阵）

spec frontmatter **13 条 `state_branches` 逐条须在 IT 有 `it()`**。分层：① 纯函数单测（vitest 无 DB）验 3 adapter 区间请求结构 + 解析：营收（纯头行跳过 / 有 parent 缺 value 存 null / key trim / signed 负 revenue）、员工（**同名 number+percentage 两行经 displayType 去重不丢** / key trim）、股东（嵌套 L/S/P payload 保真 + content_hash）；② Testcontainers PG IT 验 executor 落库/幂等/marketScope 过滤/空返回零行 + **员工同名 number+percentage 两行幂等共存（displayType 进 NK 不 skipDuplicates）** + 营收缺值行存 null + 股东嵌套保真;③ env-gated 真 vendor IT（`RUN_MARKETDATA_IT`，默认 skip）校 3 端点 vendor 契约（probe 已 verified，IT 固化回归网）。IT run via `nx test server <file> --skip-nx-cache`（cwd=apps/server）。覆盖矩阵见 [`tasks.md`](./tasks.md)。

## 风险 / Deferred-probes

> **✅ 前置 probe 已 verified（2026-07-15 · prod 77 `nvy-tight-app-1` 真 vendor read-only 探针，00700/00005/09988）**：3 端点 `code=1`；schema 级发现（员工 NK 需 displayType / 营收头行规则 / 最新股东 SERIES）已 fold 入 Decision 3/6 + executor 表，tasks 建立在 verified schema 上。下 #1–#5 记探针结论，#6–#7 仍需 impl/上线期核。

1. **营收 dataList 结构** ✅ **verified**：头行 = 无 parentItemName + 无 value（"按服務類型分"/"按地區分"）→ 跳过；有 parentItemName 的行一律落（value 可 null，HSBC "按地區分" 下 5 行缺 revenue = 数据行存 null）；多分组共存（"按服務類型分"+"按地區分"）itemName "其他" 跨组不撞。NK `(instrumentId,date,parentItemName,itemName)` **22 期 0 碰撞**（Decision 3）。
2. **员工 NK** ✅ **verified + 扩键定案**：`(parent,item)` **6/10 期碰撞**（同名 number+percentage 两行，`流失率按性别分‖男性 = {58812 number, 15.2 percentage}`）→ **NK 加 displayType**（`(instrumentId,date,parentItemName,itemName,displayType)`，00700 10期+00005 9期全 0 碰撞，无需 content_hash）。**脏数据**：parentItemName 带尾随空格 → adapter `.trim()` 归一（Decision 3）。
3. **最新股东 date 语义** ✅ **verified = SERIES**：00700 返 9 行/5 个不同 date、09988 返 14 行/9 个 date（非覆盖式快照）→ **报告期×股东序列，date 进 NK 可回填**（NK `(instrumentId,date,shareholderName,contentHash)`）。
4. **最新股东 sharesType 第三类 + contentHash** ✅ **verified**：sharesType = `{L,S,P}`（P 第三类确认，同 041）→ payload Json 无损。`(name,date)` 本 2 股无碰撞，但 **保留 contentHash**（041 T018 实证某些股同名同日多笔存在；低成本换鲁棒，重同步同内容折叠幂等）。
5. **Decimal 精度** ✅ **verified**：营收 revenue max `7.5e11`（00700）且**可负**（HSBC 企業中心 `−1.03e10`）→ `Decimal(24,2)` signed；毛利率 `0.602` → `Decimal(10,6)` signed；员工 value max `87412`（headcount）+ `15.2`（%）→ `Decimal(20,4)`。均不溢出。
6. **🕐 日期 HK-aware 归一（M1）** ✅ **verified**：报告期 `date` 格式**不一致** —— 营收为 UTC `...T16:00:00.000Z`（= 次日 00:00+08 HK），员工/最新股东为 `...+08:00`。现有共享 helper `lixDateOnly(v)=String(v).slice(0,10)` 对 `+08:00` 正确、对 UTC-Z **off-by-one 少 1 天** → 营收会与员工/股东**跨维度 join 错位 1 天**。3 维度均改用 HK-aware 归一（+8h then date-only，加 `lixDateOnlyHk` helper）保对齐。（旁注：现有维度是否有同款 UTC-Z 潜在 off-by-one 是独立问题，非 042 scope —— 041 事件日期真调时用 `lixDateOnly` 已 T018 校真，未越出本 feature 排查。）
7. **🚨 上线前再逐端点 live-probe code=1**（FR-010）：本 probe 已确认 `code=1`；上线首夜 supervised 前再核一次（p1 血泪纪律，防 token/配额状态漂移）。
8. **seed enabled 中途态**：单 PR 原子 merge，未注册 key 期间 `runDimension` 优雅返 SyncRun failed 不崩 worker（照 039/040/041 平台机制）。

## Out of Scope（本 feature 不做）

- 营收/员工 total（合計）/ 分组小计的语义聚合计算（只存 vendor 原始数据行，不做派生聚合）。
- 全量多夜回填（= 后续 ops，master INV-3 保守多夜 + 首夜 supervised，同 038/039/040/041 委托）。
- 退市股（沿 p1 active-only，生存者偏差为已知取舍）。
- p3 剩余 2 维（所属行业/公告 → 043 分类文本）。
- us 市场（本 plan 仅 hk）。

## Constitution 对照

- **§V 纯 server 单 PR**：无 mobile/web surface（`web_compat: na`），无新读端点（015 market-agnostic 天然覆盖）→ 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]` task。
- **§III atomic commit**：每 task 各自 commit（6 步闭环 per `.claude/rules/implement-task-closure.md`）。
- **bounded context**：全改动在 marketdata 单 context 内，3 表 intra-marketdata FK（instrument FK）、无 cross-context owner（`check-server-moat.ts` 确认，同 039/040/041）。
- **TDD 红绿**：marketdata 改动 = 真后端 Testcontainers IT + env-gated 真 vendor IT，每 task 先测后实现。
