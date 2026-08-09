---
feature_id: 041-hk-marketdata-corporate-events
spec_ref: ./spec.md
status: implemented
created_at: 2026-07-15
updated_at: 2026-07-15
adr_refs: [ADR-0043, ADR-0035, ADR-0040]
context7_verified: []
---

# Plan: 041-hk-marketdata-corporate-events（港股事件流 4 维度）

> **prose-only**（per [sdd.md](../../docs/conventions/sdd.md) 反模式）。数据模型 SoT = `apps/server/prisma/schema.prisma`，API SoT = 无（本 feature 无新读端点）。**不镜像** schema/OpenAPI，不造 research.md/data-model.md/quickstart.md/contracts/。
> **Spec**: [`spec.md`](./spec.md) | **Master**: [hk-marketdata p3](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md「p3」) | **PoC**: [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md)

## Summary

在 p1（038）平台 + p2（039）/040「加一个 marketdata 维度」范式上，**新增 4 个港股事件流维度**：**回购**（`BuybackEvent`，事件流，字段最丰）+ **股本变动**（`EquityChange`，事件）+ **股东权益变动**（`ShareholderChange`，嵌套 L/S 事件）+ **配股**（`AllotmentEvent`，港股极罕见、尽力覆盖）。各落一张 market-agnostic 事实表 + instrument FK，服务量化回测。4 端点均 param 契约第一类（单数 `stockCode` + `startDate/endDate` 区间，**可回填历史**），executor 一律照抄 `syncEodBars` 的 mode-based 单标的区间形态（同 039 `short_selling`）。纯 server 数据摄取，单 bounded context（marketdata），单 PR，无 UI/mockup/契约变更。形态族「事件流」= p3 拆 4 spec 第 2 个（承接 040 日频因子）。

## Technical Approach — 复用「加一个 marketdata 维度」既有模式

每个新维度 = 同一套文件触点（照抄 039/040，不发明），均 `apps/server/src/marketdata/`（扁平 per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）：

1. `<dim>.port.ts`（新，×4：`buyback` / `equity-change` / `shareholder-change` / `allotment`）— Symbol token + interface（样板 `short-selling.port.ts`；单方法 `getXxxRange({symbol, from, to?})`）
2. `marketdata.types.ts` — 加 4 组 `XxxQuery`+`XxxDto`（金融数值跨边界一律 `string|null`；嵌套/未知结构走 `payload`）；`DIMENSION_KEYS` 加 `'buyback'` / `'equity_change'` / `'shareholder_change'` / `'allotment'`
3. `lixinger-<dim>.adapter.ts`（新，×4）— `extends LixingerAdapterBase`（基类 `post(path,body)` 注 token + 解析 `{code,message,data}` 信封）；`toLixinger(sym)` 取 `{market,stockCode}` → `/${market}/company/{repurchase|equity-change|shareholders-equity-change|allotment}`，`startDate/endDate` 区间（样板 `lixinger-eod-bar.adapter.ts` range 形态）
4. `mock-market-data.adapter.ts` — `implements` 4 Port + cn/hk fixture（hk fixture 用 test-local mock 护 seam）
5. `dimension-executor.ts` — `buildExecutors` 加 4 entry（走 `factExecutor` 继承 marketScope 过滤 + syncTier 序）+ `syncBuyback` / `syncEquityChange` / `syncShareholderChange` / `syncAllotment` 方法（均 mode-based 区间，照抄 `syncEodBars`/`syncShortSelling`）
6. `marketdata.module.ts` — provider 工厂 `cfg.kind==='mock'?mock:new LixingerXxxAdapter(...)`（4 端点无 fsType → 无-Prisma 工厂分支）
7. `schema.prisma` — 4 新 model `@@schema("marketdata")` + instrument FK cascade + `@@unique(自然键)` + Instrument 反向关系（flat 事实样板 `ShortSellingDaily`；payload 样板 `CorporateAction.payload`）
8. migration（新，expand-only）— 4× `CREATE TABLE`+FK + `sync_dimension` seed 4 行（`marketScope={hk}`，**cronExpr 分档**：buyback/equity_change 日频、shareholder_change/allotment 周频）+ 4× `universe→dim` soft 边（`-- migration_refs:` frontmatter per [ADR-0035](../../docs/adr/0035-data-layer-governance.md)）
9. `lixinger-adapters.spec.ts` — 纯函数单测（mock HTTP + mock Prisma）：4 端点区间请求结构 + 解析（buyback 丰富字段 / equity-change 扁平 / shareholder 嵌套 L/S / allotment payload）
10. `test/integration/marketdata.hk-041.<x>.it.spec.ts`（新）— Testcontainers PG + test-local mock hk + `buildRegistry` 手工装配（骨架 `marketdata.hk-040.*.it.spec.ts`）
11. `marketdata.lixinger-vendor.it.spec.ts` — 加 `describe.skipIf(!RUN_MARKETDATA_IT)` 真 vendor 契约 it（4 端点真返 + 配股零样本容错）

## Decisions

1. **Phase 1 只动 schema+migration**（不碰 TS executor）→ 立即编译绿。`buildExecutors():Record<DimensionKey,…>` 编译器强制 exhaustive：往 `DIMENSION_KEYS` 加 key 必须同 commit 补 entry。故地基先纯数据层，后续每 Phase「加 key+加 entry+装配」原子落地（照 039/040 Decision 1）。

2. **4 端点均单数 `stockCode` + `startDate/endDate` 区间 ⇒ 照抄 `eod_bar` 单方法** `getXxxRange({symbol, from, to?})`，executor 按 `mode` 算 `from`（delta=近窗 / backfill=asOf−historyDepth）。与 039 五维同形态、与 040 波动率同 range 契约。**均不用 `metricsList`** → 无 p1 #670 all-or-nothing 静默 0 行坑（p3 probe §3 已确认）。

3. **🔴 配股 = 新建独立表 `AllotmentEvent`，NOT 复用 `CorporateAction`（偏离 master 默认，有据）**：master 表原定「8 配股 → `CorporateAction(type=allotment)`」，但代码审计发现 **`corporate_action` 表被 4-5 个 019/020 复权/除权消费者无 type 过滤读取** —— `dimension-executor.ts:510`（除权命中 count 门）、`:544`（`exDate ∈ 水位窗口` 触发 backward 重取）、`marketdata-backfill.cli.ts:198`（复权 exRows）、`get-instrument-detail.usecase.ts:64`（详情页读端）。写入 `type='allotment'` 行会**静默污染复权触发流**（allotment 日期误触发 backward bar 重取 / 详情页混入配股行），= 对 019/020 既有行为的 untested 回归，越出 041「零回归」scope。**独立表零耦合、与本 feature 其余 3 表一致、CREATE TABLE 成本 trivial** → 隔离胜出。（master 表待回写此偏离；`CorporateAction` 端口注释「分红/拆股/配股」的历史意图记录，不回改。）

4. **股东权益变动 = 扁平行 `(instrumentId, date, shareholderName)` + `payload Json` 存嵌套 L/S 数组**：vendor 返 `numOfSharesInterestedList[]`/`percentageOfIssuedVotingShares[]`（每项 `{value, sharesType}`）。用 payload Json 存原始嵌套（照 `CorporateAction.payload`/`HotSnapshot.payload` 范式）→ **无损容纳 L/S 及潜在第三类**（HK SDI 除 long/short 外可有 lending-pool），零 schema churn。**拒绝**扁平 `long/short` 四列方案：假定 L/S 二元、丢第三类、且不合 payload 先例。（研究库 JSON 查询可接受；若后续量化需索引化 long-pct，走 expand-migration 提列。）**（🔄 C1 扩键 2026-07-15：T018 实证同名同日多笔真实存在 → NK 补 `contentHash` = `(instrumentId,date,shareholderName,contentHash)`；且实证第三类 `sharesType:"P"` + `numOfSharesInvolvedList` → payload 改为整存整行无损，验证本 Decision 对，见 §风险 #1/#4。）**

5. **回购/股本变动 = 扁平 typed 列（非 payload）**：字段稳定且量化需可查 → `BuybackEvent`（num/highestPrice/lowestPrice/totalPaid/avgPrice/methodOfPurchase/totalSharesForCancellation/ratioPurchasedSinceResolution/currency/boardType…，金额/价格 `Decimal`；**🔄 C1 扩键 2026-07-15：+`vendorEventId`〔vendor `_id`〕进 NK = `(instrumentId,date,vendorEventId)`，T018 实证同日多笔两市场回购，见 §风险 #1**）、`EquityChange`（capitalization/capitalizationH/changeReason/declarationDate）落 typed 列。**配股 `AllotmentEvent` = payload Json**（零样本，字段未知，无法先定 typed 列；首个真实非空样本后可 expand 提列）。

6. **cron 分档 = 纯 seed，零 schema 变更**：`SyncDimension.cronExpr`（VarChar 64）已表达 per-dim cadence → buyback/equity_change seed 日频 cron、shareholder_change/allotment seed 周频 cron（FR-012）。`freshnessProfile` 事件类 seed `'slow-drift'`、`slaHours=null`（不做 continuous-daily 新鲜度门，同 039 低频维度）。

7. **只挂 `universe→dim` soft 边**（4×）→ 避 `sync-flow-assembler.ts assertEdgesExpressible` 对 hard 边的拓扑相邻硬校验；零拓扑风险（照 039 Decision 3）。回填 per-stock 前 `backfillPacer.pace()` 护共享令牌桶。

## 四维 executor 形态

| 维度 | 表 | 形态（照抄谁）| 落库自然键 | 关键差异 |
| --- | --- | --- | --- | --- |
| **buyback** | `BuybackEvent`（新，flat）| `syncEodBars`（mode 分 from）| `(instrumentId, date, vendorEventId)` | 单数 stockCode+range；丰富 typed 列；**C1 扩键**：T018 实证同日多笔（汇丰两市场回购）→ 加 vendor `_id` |
| **equity_change** | `EquityChange`（新，flat）| 同上 | `(instrumentId, date)` | **C1 verified**：全 8 股 1/日安全 → NK 不动 |
| **shareholder_change** | `ShareholderChange`（新，flat+payload）| 同上 | `(instrumentId, date, shareholderName, contentHash)` | 嵌套 L/S+involved 存 payload Json；缺 L 或 S 存 null 不崩；**C1 扩键**：T018 实证同名同日多笔 → 加 vendor 行 sha256 hashdiff |
| **allotment** | `AllotmentEvent`（新，payload）| 同上 | `(instrumentId, date)` | 港股极罕见常返 0 行不崩；payload Json（字段留首样本）；周频 |

共性：均经 `factExecutor` 继承 `loadActiveInstruments`（marketScope∩markets 过滤 + syncTier 序，零改）；均不注 Prisma（无 fsType）；均 soft-依赖 `universe`；空返回（无事件/配股零样本）→ 零行不崩不阻塞（沿 039 connect_holding 空返回范式）。

## Testing Invariants（per [ADR-0040](../../docs/adr/0040-multi-layer-test-gate.md) + tasks.md 覆盖矩阵）

spec frontmatter **12 条 `state_branches` 逐条须在 IT 有 `it()`**。分层：① 纯函数单测（vitest 无 DB）验 4 adapter 区间请求结构 + 解析（buyback 丰富字段 / equity 扁平 / shareholder 嵌套 L/S 保真 / allotment payload + 零行）；② Testcontainers PG IT 验 executor 落库/幂等/marketScope 过滤/空返回零行/shareholder 嵌套保真/配股零样本收敛；③ env-gated 真 vendor IT（`RUN_MARKETDATA_IT`，默认 skip）校 4 端点 vendor 契约（配股扫候选池、允许全 0）。IT run via `nx test server <file> --skip-nx-cache`（cwd=apps/server）。覆盖矩阵见 [`tasks.md`](./tasks.md)。

## 风险 / Deferred-probes（impl 期真调确认，非阻塞）

> **✅ C1 已 verified（2026-07-15 · T018 真 vendor read-only 探针 prod 77 `nvy-tight-app-1`）**：同日多事件**真实存在** → 自然键扩键定案（下 #1）。业内实践三源一致（Data Vault hashdiff / dbt surrogate key / Kafka 幂等键）+ user 定案混合方案。已随本 C1 fix commit 落地（schema + migration 原地改 + adapter/executor/IT）。

1. **同日多事件自然键**（buyback/shareholder）✅ **verified + 扩键定案**：
   - **buyback**：汇丰 00005 2025-10-17 同日 2 笔（`_id` `...dcd` GBP/turquoise + `...dce` HKD/exchange，两市场回购）→ `(instrumentId,date)` 会 `skipDuplicates` 丢 1 行 → **NK 扩 `vendorEventId`**（vendor `_id`，源头稳定唯一 24 位 hex，全非空；同 `_id` 重同步折叠幂等，Kafka 幂等键范式）。
   - **shareholder**：JPMorgan 09988 2025-06-12 同日 **3 笔**（involved 不同、interested 相同，含第三类 `sharesType:"P"`）+ 汇丰同股东同日 2 笔 → `(instrumentId,date,shareholderName)` 会丢真行 → **NK 扩 `contentHash`**（对 vendor 原始事件行 canonical 序列化后 sha256，Data Vault hashdiff；内容全同才折叠、任何实质差异都保留；vendor 真重复行→同 hash 正确折叠）。
   - **equity_change**：全 8 股 maxPerDay=1 → `(instrumentId,date)` 已安全，**NK 不动**。
2. **Decimal 精度**（buyback）：probe `totalPaid=574035480`（~5.7e8）/ `avgPrice=419.004` / `ratioPurchasedSinceResolution=0.02445` → 金额 `Decimal(24,2)`、价格 `Decimal(18,4)`、比率 `Decimal(10,6)`（照 039 T019 Decimal 范式）；impl 真调核大盘股大额回购不溢出。
3. **🔴 配股 `allotment` 零样本**（US4/FR-004）：p3 probe 扫 12 标的全 0 行、字段 schema 未知 → 建表用 payload Json（不预设 typed 列）。T018 探针仍零样本 → **NK `(instrumentId,date)` 不动**，记为已知限制（SC-004 收敛即通过，documented revisit：首个真实非空样本后再定扩键与提列）。
4. **shareholder `sharesType` 值域** ✅ **verified**：T018 真调实证除 `L`/`S` 外**确有第三类 `sharesType:"P"`**（09988 JPMorgan 行）+ 多返 `numOfSharesInvolvedList` 字段（p3 报告未列）→ **验证 Decision 4 对**：payload Json 整存整行**无损吸收**（含 involved 列 + 第三类 P），零 schema churn。contentHash 覆盖全描述性 payload（含 involved）→ 同名同日 involved 不同的多笔都保留。
5. **🚨 上线前逐端点 live-probe code=1**（FR-011）：4 端点上线前对 prod 77 容器（`nvy-tight-app-1`，真 `LIXINGER_TOKEN` read-only）逐个真调确认 `code=1`（p1 血泪纪律：mock 绿 ≠ 真调有效；探针挂 auto-mode 需 user `!`/授权）。
6. **seed enabled 中途态**：单 PR 原子 merge，未注册 key 期间 `runDimension` 优雅返 SyncRun failed 不崩 worker（照 039/040 平台机制）。

## Out of Scope（本 feature 不做）

- 配股参与复权因子重算（rights issue 概念上是除权事件，但 041 只做事件流摄取；复权触发流集成越出 scope，`AllotmentEvent` 独立表天然不触碰 019/020 复权流）。
- 全量多夜回填（= 后续 ops，master INV-3 保守多夜 + 首夜 supervised，同 038/039/040 委托）。
- 退市股（沿 p1 active-only，生存者偏差为已知取舍）。
- p3 剩余 5 维（营收构成/员工/最新股东 → 042 报告期；所属行业/公告 → 043 分类文本）。
- us 市场（本 plan 仅 hk）。

## Constitution 对照

- **§V 纯 server 单 PR**：无 mobile/web surface（`web_compat: na`），无新读端点（015 market-agnostic 天然覆盖）→ 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]` task。
- **§III atomic commit**：每 task 各自 commit（6 步闭环 per `.claude/rules/implement-task-closure.md`）。
- **bounded context**：全改动在 marketdata 单 context 内，4 表 intra-marketdata FK（instrument FK）、无 cross-context owner（`check-server-moat.ts` 确认，同 039/040）；配股独立表刻意不写 corporate_action（Decision 3 避跨维度耦合）。
- **TDD 红绿**：marketdata 改动 = 真后端 Testcontainers IT + env-gated 真 vendor IT，每 task 先测后实现。
