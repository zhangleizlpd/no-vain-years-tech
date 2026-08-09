---
feature_id: 043-hk-marketdata-classification-text
spec_ref: ./spec.md
status: drafted
created_at: 2026-07-15
updated_at: 2026-07-15
adr_refs: [ADR-0043, ADR-0035, ADR-0040]
context7_verified: []
---

# Plan: 043-hk-marketdata-classification-text（港股分类文本 2 维度：所属行业 / 公告）

> **prose-only**（per [sdd.md](../../docs/conventions/sdd.md) 反模式）。数据模型 SoT = `apps/server/prisma/schema.prisma`，API SoT = 无（本 feature 无新读端点）。**不镜像** schema/OpenAPI，不造 research.md/data-model.md/quickstart.md/contracts/。
> **Spec**: [`spec.md`](./spec.md) | **Master**: [hk-marketdata p3](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md「p3」) | **PoC**: [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md) + **043 上线前 prod 77 重探（2026-07-15，见 §风险）**

## Summary

在 p1（038）平台 + p2（039）/040/041/042「加一个 marketdata 维度」范式上，**新增 2 个港股「分类文本」维度**（p3 拆 4 spec **第 4 个即最后一个**，master p3 收官）：**所属行业**（`IndustryClassification`，覆盖式快照，照抄 039 `index_membership`；使用面最广的截面量化元数据，MVP）+ **公告**（`Announcement`，range 文本流元数据，照抄 041 `syncBuyback`；本 feature 唯一潜在超大表，只存元数据不存 PDF）。各落一张 market-agnostic 事实表 + instrument FK，服务量化回测。**两维形态不同、param 契约二分**（industries 单数 `stockCode` 快照无 date → 覆盖式 `deleteMany+createMany` 无 mode；announcement 单数 `stockCode`+`startDate/endDate` 区间 → mode-based createMany），每端点单独确认（延续 p1 #673 教训）。均不用 `metricsList` → 无 p1 #670 all-or-nothing 坑。纯 server 数据摄取，单 bounded context（marketdata），单 PR，无 UI/mockup/契约变更。

## Technical Approach — 复用「加一个 marketdata 维度」既有模式

每个新维度 = 同一套文件触点（照抄 039/040/041/042，不发明），均 `apps/server/src/marketdata/`（扁平 per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）：

1. `<dim>.port.ts`（新，×2：`industry-classification` / `announcement`）— Symbol token + interface。industries 单方法 `getIndustryClassification(symbol)`（快照，无 range，样板 `index-membership.port.ts`）；announcement 单方法 `getAnnouncementRange({symbol, from, to?})`（区间，样板 `buyback.port.ts`）
2. `marketdata.types.ts` — 加 2 组 DTO：`IndustryClassificationDto`（`{source, industryCode, name, areaCode}`，文本字段 `string|null`）+ `AnnouncementRangeQuery`+`AnnouncementDto`（`{date, linkUrl, linkText, linkType, types}`，`types: string[]`）；`dimension-executor.ts` 的 `DIMENSION_KEYS` 加 `'industry_classification'` / `'announcement'`
3. `lixinger-<dim>.adapter.ts`（新，×2）— `extends LixingerAdapterBase`；`toLixinger(sym)` 取 `{market,stockCode}`。industries → `post('/${market}/company/industries',{stockCode})`（**单数、无 date**，样板 `lixinger-index-membership.adapter.ts`）；announcement → `post('/${market}/company/announcement',{stockCode,startDate,endDate?})`（**单数+range**，样板 `lixinger-buyback.adapter.ts`）
4. `mock-market-data.adapter.ts` — `implements` 2 Port + cn/hk fixture（hk fixture 用 test-local mock 护 seam；industries fixture 含 3 级层级多行 + 空返回；announcement fixture 含多 date + 缺字段行 + 空 types）
5. `dimension-executor.ts` — `buildExecutors` 加 2 entry（走 `factExecutor` 继承 marketScope 过滤 + syncTier 序）+ `syncIndustryClassification`（照抄 `syncIndexMembership`：**无 mode，per-instrument 单 $transaction deleteMany+createMany 覆盖式**）+ `syncAnnouncement`（照抄 `syncBuyback`：**mode 分 from，per-stock createMany skipDuplicates**）
6. `marketdata.module.ts` — provider 工厂 `cfg.kind==='mock'?mock:new LixingerXxxAdapter(...)`（2 端点无 fsType → 无-Prisma 工厂分支）
7. `schema.prisma` — 2 新 model `@@schema("marketdata")` + instrument FK cascade + `@@unique(自然键)` + Instrument 反向关系（覆盖式快照样板 `IndexMembership`；range 事件样板 `BuybackEvent`）
8. migration（新，expand-only）— 2× `CREATE TABLE`+FK + `sync_dimension` seed 2 行（`marketScope={hk}`，**cronExpr 统一夜频** `0 0 22 * * *`，freshness 二档）+ 2× `universe→dim` soft 边（`-- migration_refs:` frontmatter per [ADR-0035](../../docs/adr/0035-data-layer-governance.md)）
9. `lixinger-adapters.spec.ts` — 纯函数单测（mock HTTP + mock Prisma）：2 端点请求结构 + 解析（industries 快照无 date + stockCode→industryCode 映射 + 3 层级行全出 + 缺字段 null；announcement range 请求 + date +08:00 lixDateOnly + types 数组保真 + 缺 types 空数组 + 升序）
10. `test/integration/marketdata.hk-043.<x>.it.spec.ts`（新）— Testcontainers PG + test-local mock hk + `buildRegistry` 手工装配（骨架 `marketdata.hk-042.*.it.spec.ts`）
11. `marketdata.lixinger-vendor.it.spec.ts` — 加 `describe.skipIf(!RUN_MARKETDATA_IT)` 真 vendor 契约 it（2 端点真返 + industries 覆盖式无 date + announcement ≤10yr）

## Decisions

1. **Phase 1 只动 schema+migration**（不碰 TS executor）→ 立即编译绿。`buildExecutors():Record<DimensionKey,…>`（`dimension-executor.ts`）编译器强制 exhaustive：往 `DIMENSION_KEYS`（`:51`）加 key 必须同 commit 补 entry。故地基先纯数据层，后续每维度「加 key+加 entry+装配」原子落地（照 039/040/041/042 Decision 1）。

2. **param 契约二分 ⇒ 照抄二既有形态，每端点单独确认**（probe verified 2026-07-15，§风险）：
   - **industries = 单数 `stockCode` 快照（无 date）→ 照抄 `syncIndexMembership`**（覆盖式 `deleteMany+createMany`，**无 mode 分支**）。
   - **announcement = 单数 `stockCode` + `startDate/endDate` 区间 → 照抄 `syncBuyback`**（mode 分 from，`createMany({skipDuplicates})`）。
   - 均不用 `metricsList` → 无 p1 #670 all-or-nothing 静默 0 行坑（probe 2 端点 `code=1`）。

3. **🔑 所属行业 = 覆盖式快照，照抄 `syncIndexMembership`**（probe verified）：vendor `industries` 端点**无 date**、返当前全量归属集合（00700 → 3 行 hsi L1/L2/L3 层级 `H70`/`H7020`/`H702015`）→ per-instrument 单 `$transaction` 内 `deleteMany({instrumentId})` + `createMany(current set)` 原子替换反映最新。
   - **空返回跳过 mutate 不 deleteMany**（interim 保守语义，同 index_membership plan Deferred-probe #2）：vendor 返 [] = 真无归属 vs 瞬时 blip 不可辨 → 不 wipe 既有归属，计 ok。
   - **字段消歧**：vendor 行的 `stockCode` 字段实为**行业代码**（H70）非个股 → 落 `industryCode` 列（与 `IndexMembership.indexCode` 平行命名），`name`/`areaCode` 一并保留（nullable，缺存 null）。
   - **NK = `(instrumentId, source, industryCode)`**（比 `IndexMembership` 的 `(instrumentId, indexCode)` 多 `source`）：industries 有 `source` 字段（probe 今全 `hsi`，但行业分类天然有多体系 GICS/申万/hsi 之别）→ 纳 NK 未来多分类体系无缝、今不歧义；`source`/`industryCode` NOT NULL（probe 恒有值，防御缺失落 sentinel `''`，per [migration-rules](../../.claude/rules/migration-rules.md) §4）。一股 3 行 industryCode 各异不撞。
   - **3 级层级不加 level 列**：L1/L2/L3 由 `industryCode` 前缀/长度天然派生（H70=2 位→L1 / H7020=4 位→L2 / H702015=6 位→L3），量化按 code 前缀分组即可 → 不加冗余 `level` 派生列（Out of Scope）。

4. **🔑 公告 = range 文本流，照抄 `syncBuyback`**（probe verified）：vendor `announcement` 端点单数 `stockCode`+range → `getAnnouncementRange({symbol,from,to?})`，executor 按 `mode` 算 `from`（delta=当日 / backfill=asOf−historyDepth）→ `createMany({skipDuplicates})`，backfill per-stock `backfillPacer.pace()`。
   - **NK = `(instrumentId, date, linkUrl)`** —— `linkUrl` 是 HKEX 文档全局唯一 URL（probe 00700 2 年 433/433 unique、`(date,linkUrl)` 433/433 无碰撞）→ **无需 `vendorEventId`/`contentHash`**（异于 buyback 的 `_id`、041 shareholder 的 hash）；`linkUrl` NOT NULL、`date` NOT NULL。
   - **单请求无分页**（probe 10yr 区间单 POST 返全量 1152 行、date-range 2016..2026 全覆盖、无 cap）→ adapter 单 POST 照抄 buyback、**零分页/date-chunking 逻辑**。
   - **≤10yr 硬上限**（probe >10yr 区间 → HTTP 403 code=0，同 dividend）→ `history_depth=3650`（≈9.99yr）卡限内安全，backfill `from=asOf−3650` 天然满足、adapter 不构造超 10yr 区间。
   - **只存元数据不存 PDF**：表列 `{date, linkUrl, linkText, linkType, types}`（无 PDF 正文列）；`date` 为 `+08:00`（probe verified HK-local）→ `lixDateOnly` slice(0,10) 正确无 off-by-one（**异于 042 营收 UTC-Z 需 `lixDateOnlyHk`**），同 buyback/allotment。
   - **`types[]` 用 Postgres `String[]`（text[]）**：vendor `types` 是数组（probe 值域 srp/ndd_r/mr/fs/dividend...）→ 原生 text[] 数组，量化 array-overlap（`types && ARRAY['dividend']`）可查 + 可 GIN 索引；优于 Json（array-contains 笨）与子表（over-eng，types 是小数组）。缺/空 types 存空数组 `{}`，`linkText`/`linkType` 缺存 null。

5. **cron 夜频二档 = 纯 seed，零 schema 变更**（clarify 2026-07-15 定，spec Q3）：2 维统一夜频 cron `0 0 22 * * *`（共用 master INV-3 错峰夜窗，同 index_membership/short_selling，**异于 042 报告期季频**）。`freshnessProfile` 二档：industries `'slow-drift'`（分类罕变、恒覆盖式确认）/ announcement `'continuous-daily'`（文本流每日新披露）。industries `historyDepth=NULL`（覆盖式无历史，不纳回填估算）/ announcement `historyDepth=3650`（10 年可回填）。`adjustTypes={none}`（分类/文本无复权），`batchSize=1`，priority 低于核心 6 维。

6. **只挂 `universe→dim` soft 边**（2×）→ 避 `sync-flow-assembler.ts assertEdgesExpressible` 对 hard 边的拓扑相邻硬校验；零拓扑风险（照 039/041/042 Decision 7）。回填 per-stock 前 `backfillPacer.pace()` 护共享令牌桶。

7. **超大表容量**（announcement）：probe 00700 = 1152 行/10yr（重披露股）→ 全港股 ~2700 × ~1000 行/10yr ≈ **~3M 行**（master INV-5 估 2-5M 的下沿）；索引 `(instrumentId, date DESC)` 保时序扫描；range 分区为「观察项」（INV-5，逼近 ~100M 才按 `date` range 分区，本 feature 不做）。

## 二维 executor 形态

| 维度 | 表 | 形态（照抄谁）| 落库自然键 | 关键差异（probe verified）|
| --- | --- | --- | --- | --- |
| **industry_classification** | `IndustryClassification`（新，flat，覆盖式）| `syncIndexMembership`（**无 mode / 无 date**，per-instrument 单 $tx `deleteMany+createMany` 原子替换）| `(instrumentId, source, industryCode)` | 单数 stockCode 快照无 date；空返回跳过不 wipe；vendor `stockCode`→`industryCode` 列；3 级层级 3 行/股全落；`source` 纳 NK（今 hsi 单值）；`history_depth=NULL` |
| **announcement** | `Announcement`（新，flat，range 文本流）| `syncBuyback`（mode 分 from，per-stock `createMany` 幂等）| `(instrumentId, date, linkUrl)` | 单数 stockCode+range；linkUrl 天然唯一无需 hash；`types[]` text[]；只存元数据不存 PDF；10yr 单请求无分页；≤10yr 硬上限（>10yr 403）；date `+08:00`→`lixDateOnly`；`continuous-daily` 超大表 |

共性：均经 `factExecutor` 继承 `loadActiveInstruments`（marketScope∩markets 过滤 + syncTier 序，零改）；均不注 Prisma（无 fsType）；均 soft-依赖 `universe`；空返回（无归属/无公告标的）→ 不崩不阻塞（industries 跳过 mutate 计 ok / announcement 零行 createMany no-op，沿 039 connect_holding 空返回范式）。

## Testing Invariants（per [ADR-0040](../../docs/adr/0040-multi-layer-test-gate.md) + tasks.md 覆盖矩阵）

spec frontmatter **20 条 `state_branches` 逐条须在 IT 有 `it()`**。分层：① 纯函数单测（vitest 无 DB）验 2 adapter 请求结构 + 解析：industries（快照请求**无 date/无 startDate** + `stockCode`→`industryCode` 映射 + 3 层级行全出不去重 + `source` 透传 + 缺 name/areaCode null）、announcement（range 请求单数 `stockCode`+`startDate`+`endDate` + **date `+08:00` lixDateOnly 无 off-by-one** + `types` 数组保真 + 缺 types 空数组 / 缺 linkText/linkType null + 升序）；② Testcontainers PG IT 验 executor：industries 覆盖式落库（3 行）+ **原子替换重跑旧归属被换无残留** + **空返回不 wipe** + marketScope 过滤 + `(instrument,source,industryCode)` 幂等；announcement range 落库 + `(instrument,date,linkUrl)` 幂等（同 URL 折叠/不同 URL 保留）+ 缺字段 null/空数组 + 空返回零行不崩 + marketScope + backfill `from=asOf−3650`；③ env-gated 真 vendor IT（`RUN_MARKETDATA_IT`，默认 skip）校 2 端点 vendor 契约（probe 已 verified，IT 固化回归网）。IT run via `nx test server <file> --skip-nx-cache`（cwd=apps/server）。覆盖矩阵见 [`tasks.md`](./tasks.md)。

## 风险 / Deferred-probes

> **✅ 前置 probe 已 verified（2026-07-15 · prod 77 `nvy-tight-app-1` 真 vendor read-only 探针，00700/00005/00981/08526）**：2 端点 `code=1`；schema 级发现（industries 3 级层级 + 无 date / announcement date +08:00 + linkUrl 唯一 + 10yr 单请求无分页 + >10yr 403）已 fold 入 Decision 3/4 + executor 表，tasks 建立在 verified schema 上。下 #1–#5 记探针结论，#6–#7 仍需上线期核。

1. **industries 覆盖式 + 3 级层级** ✅ **verified**：无 date（覆盖式快照非历史序列）；返 hsi L1/L2/L3 层级 3 行/股（00700 → H70/H7020/H702015，00005 → H50/H5010/H501010，00981 → H70/H7030/H703010）；`stockCode`=行业代码、`source` 全 `hsi`、`areaCode`=`hk`。NK `(instrumentId, source, industryCode)`（3 行各异不撞，Decision 3）。
2. **announcement 字段 + date 格式 + linkUrl 唯一** ✅ **verified**：字段 `{linkUrl, date, linkText, linkType, types[]}`；`date`=`...T00:00:00+08:00`（HK-local，`lixDateOnly` 正确无 off-by-one）；`types` 为数组（srp/ndd_r/mr/fs/fs_esg/dividend...）；`linkType`='PDF'；**linkUrl 全局唯一**（00700 2 年 433/433 unique，maxLen 79 → VarChar(512) 留足）、`(date,linkUrl)` NK 433/433 无碰撞（Decision 4）。
3. **announcement 10yr 单请求无分页** ✅ **verified**：10yr 区间（2016-07-16..2026-07-15）单 POST 返全量 **1152 行**、date-range 2016-07-29..2026-07-09 全覆盖、无 cap/无 suspicious-round-count → adapter 单 POST 照抄 buyback、**零分页/date-chunking**。
4. **announcement ≤10yr 硬上限** ✅ **verified**：>10yr 区间（2014-01-01..2026-07-15）→ **HTTP 403 code=0**（同 dividend ≤10yr 限）→ `history_depth=3650`（≈9.99yr）卡限内、backfill `from=asOf−3650` 天然满足，adapter 不得构造超 10yr 区间。
5. **industries 空返回真实性**：interim 保守跳过 mutate 不 wipe（同 index_membership）；probe 08526（仙股）announcement 返 79 行非空、industries 未逐一扫空标的 → 上线首夜核「空归属 vs 瞬时 blip」（现取保守不误清）。
6. **🚨 上线首夜再逐端点 live-probe code=1**（FR-010）：本 probe 已确认 `code=1`；全量回填首夜 supervised 前再核一次（p1 血泪纪律，防 token/配额状态漂移）。
7. **seed enabled 中途态**：单 PR 原子 merge，未注册 key 期间 `runDimension` 优雅返 SyncRun failed 不崩 worker（照 039/040/041/042 平台机制）。

## Out of Scope（本 feature 不做）

- 公告 **PDF 正文**下载 / 解析（只存元数据 linkUrl/date/linkText/linkType/types；正文抓取是独立大工程）。
- 行业分类**历史序列**（vendor 无 date，覆盖式快照无历史）+ 行业**层级 level 列 / 父子关系物化**（由 `industryCode` 前缀天然派生，量化按 code 前缀分组）。
- 全量多夜回填（= 后续 ops，master INV-3 保守多夜 + 首夜 supervised，同 038-042 委托）。
- 退市股（沿 p1 active-only，生存者偏差为已知取舍）。
- us 市场（本 plan 仅 hk）。
- announcement 按 `types` 子集过滤同步（v1 全 types 落库，元数据便宜；过滤是消费侧 SQL 关注点，text[] 已可查）。

## Constitution 对照

- **§V 纯 server 单 PR**：无 mobile/web surface（`web_compat: na`），无新读端点（015 market-agnostic 天然覆盖）→ 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]` task。
- **§III atomic commit**：每 task 各自 commit（6 步闭环 per `.claude/rules/implement-task-closure.md`）。
- **bounded context**：全改动在 marketdata 单 context 内，2 表 intra-marketdata FK（instrument FK）、无 cross-context owner（`check-server-moat.ts` 确认，同 039-042）。
- **TDD 红绿**：marketdata 改动 = 真后端 Testcontainers IT + env-gated 真 vendor IT，每 task 先测后实现。

> **043 落地 = master p3「补充 + 参考/文本」4 spec（040 日频因子 / 041 事件流 / 042 报告期 / 043 分类文本）全部收官**，HK 全 23 类数据同步范围闭合（除 master 已列 Out of Scope 项）。
