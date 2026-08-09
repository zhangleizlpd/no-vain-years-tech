---
feature_id: 039-hk-marketdata-quant-signals
spec_ref: ./spec.md
status: planned
created_at: 2026-07-13
---

# Plan: 039-hk-marketdata-quant-signals（港股量化高信号 5 维度）

> **prose-only**（per [sdd.md](../../docs/conventions/sdd.md) 反模式）。数据模型 SoT = `apps/server/prisma/schema.prisma`，API SoT = 无（本 feature 无新读端点）。**不镜像** schema/OpenAPI，不造 research.md/data-model.md/quickstart.md/contracts/。
> **Spec**: [`spec.md`](./spec.md) | **Master**: [hk-marketdata p2](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md) | **PoC**: [p2 探查报告](../../docs/private/plans/2026-07/07-13-hk-marketdata-p2-probe-report.md)

## Summary

在 p1（038）已激活的 marketdata 平台上**新增 5 个港股数据维度**（做空 / 南向持股 / 所属指数 / 公募基金持股 / 基金公司持股），各落一张 market-agnostic 事实表 + instrument FK，服务量化回测。纯 server 数据摄取，单 bounded context（marketdata），单 PR，无 UI/mockup/契约变更。5 端点已 2026-07-13 prod PoC 实测生效。

## Technical Approach — 复用「加一个 marketdata 维度」既有模式

每个新数据维度 = 同一套文件触点（照抄不发明），均 `apps/server/src/marketdata/`（扁平 per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）：

1. `<dim>.port.ts`（新）— Symbol token + interface（样板 `financials.port.ts`）
2. `marketdata.types.ts` — 加 `XxxQuery`+`XxxDto`（金融数值一律 `string|null`，跨边界契约）
3. `lixinger-<dim>.adapter.ts`（新）— `extends LixingerAdapterBase`（基类 `post(path,body)` 注 token + 解析 `{code,message,data}` 信封）；`toLixinger(sym)` 取 `{market,stockCode}` → `/${market}/company/<endpoint>`（日频样板 `lixinger-eod-bar.adapter.ts`）
4. `mock-market-data.adapter.ts` — `implements XxxPort` + cn:600519 fixture（hk fixture 用 test-local mock，护 seam）
5. `dimension-executor.ts` — `DIMENSION_KEYS` 加值 + 构造器 `@Inject(XXX_PORT)` + `buildExecutors` 加 entry（走 `factExecutor` 继承 marketScope 过滤 + syncTier 序）+ `syncXxx` 方法
6. `marketdata.module.ts` — provider 工厂 `cfg.kind==='mock'?mock:new LixingerXxxAdapter(...)`（这 5 端点无 fsType → 无-Prisma 工厂分支）
7. `schema.prisma` — 新 model `@@schema("marketdata")` + instrument FK cascade + `@@unique(自然键)` + Instrument 反向关系（样板 `FundamentalSnapshot`）
8. migration（新，expand-only）— `CREATE TABLE`+FK + `sync_dimension` seed 行 + `universe→dim` soft 边（`-- migration_refs:` frontmatter per [ADR-0035](../../docs/adr/0035-...)）
9. `lixinger-adapters.spec.ts` — 纯函数单测（mock HTTP + mock Prisma）
10. `test/integration/marketdata.hk-039.<x>.it.spec.ts`（新）— Testcontainers PG + test-local mock hk + `buildRegistry` 手工装配（骨架 `marketdata.hk-038.fundamental-financial.it.spec.ts`）
11. `marketdata.lixinger-vendor.it.spec.ts` — 加 `describe.skipIf(!RUN_MARKETDATA_IT)` 真 vendor 契约 it

## Decisions

1. **Phase 1 只动 schema+migration**（不碰 TS executor）→ 立即编译绿。`buildExecutors():Record<DimensionKey,…>` 编译器强制 exhaustive：往 `DIMENSION_KEYS` 加 key 必须同 commit 补 entry。故地基先纯数据层，后续每 Phase「加 key+加 entry+装配」原子落地。
2. **单数 `stockCode`（数组 `stockCodes`→HTTP 400）⇒ 无批量 delta**。与 p1 #673 的 range 端点约定相反。4 个日期序列维度改**照抄 `eod_bar` 单方法** `getXxxRange({symbol,from,to?})`，executor 按 `mode` 算 `from`（delta=近窗 / backfill=asOf−historyDepth）。这 5 端点均**不用 `metricsList`** → 无 p1 #670 all-or-nothing 静默 0 行坑。
3. **只挂 `universe→dim` soft 边** → 避 `sync-flow-assembler.ts assertEdgesExpressible` 对 hard 边的「拓扑相邻」硬校验；零拓扑风险。
4. **fund 近 5 年 = 配置驱动**：seed `sync_dimension.history_depth=1825`，executor 沿用 `subtractDays(asOf, backfillHistoryDays ?? historyDepth)` 零新代码；CLI `--history-depth` 可覆盖。
5. **index_membership 第 3 形态**（异于其他 4 维）：无 `mode` 分支，tx 内 `deleteMany({instrumentId})`+`createMany(set)` 覆盖式（更像 profile 富化，非 append backfill；vendor 无历史成分）。

## 三种 executor 形态

| 维度 | 形态（照抄谁）| 落库自然键 | 关键差异 |
| --- | --- | --- | --- |
| short_selling / connect_holding | `syncEodBars`（mode 分 from）| (instrumentId, date) | 单数 stockCode；connect 空返回→零行不崩（仅 ~600 港股通有数据）|
| fund_holding / fund_company_holding | `backfillFinancials` + `chunked(rows,500)` 每片一 tx | (instrumentId, reportDate, fundCode/fundCollectionCode) | history_depth=1825（近 5 年）；缺字段存 null；大表必分片 |
| index_membership | profile 富化式（无 mode）| (instrumentId, indexCode) | 无 date；覆盖式 upsert；不追踪历史 |

共性：均经 `factExecutor` 继承 `loadActiveInstruments`（marketScope∩markets 过滤 + syncTier 序，零改）；均不注 Prisma（无 fsType）；回填路径 per-stock 前 `backfillPacer.pace()`（低频维度近 no-op，护共享令牌桶不被多维度夜跑叠加打爆）。

## Testing Invariants（per [ADR-0040](../../docs/adr/0040-...) + tasks.md 覆盖矩阵）

spec frontmatter **13 条 `state_branches` 逐条须在 IT 有 `it()`**。分层：① 纯函数单测（vitest 无 DB）验 adapter 请求结构/解析；② Testcontainers PG IT 验 executor 落库/幂等/marketScope 过滤/覆盖式语义；③ env-gated 真 vendor IT（`RUN_MARKETDATA_IT`，默认 skip）校 vendor 契约。IT run via `nx test server <file> --skip-nx-cache`（cwd=apps/server）。覆盖矩阵见 [`tasks.md`](./tasks.md)。

## 风险 / Deferred-probes（impl 期真调确认，非阻塞）

1. **fund_holding 量级**：近 5 年 ~19500 行/股 × 被公募持有股 → T019 真调核对是否逼近分区阈值（SC-005 观测点；超预算收窄近 3 年）。**T019 实测（hk:00700, 2024-01~2025-06 = 18mo）**：`fund-shareholders` **7154 行/股**（≈ 报告期数 × 持有基金数，5 年外推 ~2e4 量级，与 ~19500 估同数量级）→ 确证 fund_holding 为最高基数维度、SC-005 分区阈值观测点成立；`fund-collection-shareholders` 次高 **1791 行/18mo**。vendor 偶返同 `(stockCode, fundCollectionCode, reportDate)` 重复行 → 自然键 upsert 幂等已覆盖（T018）。
2. **index_membership 空返回语义**：vendor 返空 = 真无归属 vs transient blip → adapter 抛错（计 failed 不 mutate）vs 空集清库，T019 真调定。**T019 未解（保留开放）**：样本 hk:00700 归属 **14 指数**（非空：HSI / HSCEI / HSTECH / 1000015 港股全指 …），未触发空返回分支 → 需一只真无归属港股才能判「真空 vs blip」。附带证实 vendor `stockCode` 字段 = 指数代码（映射 `indexCode` 正确）。
3. **Decimal 精度**：份额 `Decimal(20,0)` / 金额 `Decimal(24,2)` / 比率 `Decimal(10,4)` → T019 真调核港元大额不溢出（Phase 1 未 merge 前可调）。**T019 实测确证充裕，不调**：holdings 最大 ~2.2e7（8 位 ≪ 20 整数位）、marketCap ~1.0e10（11 位 ≪ 24 整数域）、shares/amount ~9e8~1.3e9（≪ 域）、netValueRatio `0.2979`（恰 4 位小数 = `(10,4)`）→ 三类精度均无溢出。
4. **seed enabled 中途态**：单 PR 原子 merge，未注册 key 期间 `runDimension` 优雅返 SyncRun failed 不崩 worker；求稳可 seed `enabled=false` 后 Phase 5 flip（非必需）。
5. **⚠️ 指数 candlestick 端点付费墙（016 遗留，与 039 正交，非本 PR）**：T019 真调发现 `/{market}/index/candlestick` 对本地免费额度 token 返 **HTTP 403 `ForbiddenError: "Exceed maximum access time, please purchase Open API"`**（同 token 个股/公司类 `/{market}/company/*` 端点全 200，仅指数类付费）。`trading-calendar.adapter` 的 `isTradingDay` 靠该端点派生交易日 → **live 模式 `sync-tick-driver`（D3 周期同步）+ `freshness-sla.check` 会 403**；**039 backfill 路径不碰 trading-calendar（grep 证实），零影响**。附带解 `trading-calendar.adapter` 的 `DEFERRED-PROBE(P-HSI)`：恒指真实 code **确为 `'HSI'`**（`/hk/company/indices` 证实），常量无需改 —— 缺口纯在指数 candlestick 的**付费权限**，非代码/代码值。→ 独立 016 / prod-sync 待办：确认 dev/prod 定时同步跑 mock 抑或 live + 付费 token，非本 PR 范围。

## Out of Scope（本 feature 不做）

- 全量多夜回填（= 后续 ops，master INV-3 保守多夜 + 首夜 supervised，同 038 T020 委托）。
- `mutual-market` 第二端点（`market-data/mutual-market` 南向行情）—— 行情已由 eod_bar 覆盖，南向只取持股口径。
- 退市股（沿 p1 active-only，生存者偏差为已知取舍）。
- p3 剩余 ~11 维（波动率/热度/股本变动/配股/回购/营收/员工/股东/行业/公告）。

## Constitution 对照

- **§V 纯 server 单 PR**：无 mobile/web surface（`web_compat: na`），无新读端点（015 market-agnostic 天然覆盖）→ 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]` task。
- **§III atomic commit**：每 task 各自 commit（6 步闭环 per `.claude/rules/implement-task-closure.md`）。
- **bounded context**：全改动在 marketdata 单 context 内，5 表 intra-marketdata FK、无 cross-context owner（`check-server-moat.ts` T019 确认）。
