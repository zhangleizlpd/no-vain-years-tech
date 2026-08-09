---
feature_id: 040-hk-marketdata-volatility-hot
spec_ref: ./spec.md
status: planned
created_at: 2026-07-14
updated_at: 2026-07-14
adr_refs: [ADR-0043, ADR-0035, ADR-0040]
context7_verified: []
---

# Plan: 040-hk-marketdata-volatility-hot（港股波动率 + 热度精选 2 维度）

> **prose-only**（per [sdd.md](../../docs/conventions/sdd.md) 反模式）。数据模型 SoT = `apps/server/prisma/schema.prisma`，API SoT = 无（本 feature 无新读端点）。**不镜像** schema/OpenAPI，不造 research.md/data-model.md/quickstart.md/contracts/。
> **Spec**: [`spec.md`](./spec.md) | **Master**: [hk-marketdata p3](../../docs/private/plans/2026-07/07-11-hk-marketdata-sync-master.md「p3」) | **PoC**: [p3 探查报告](../../docs/private/plans/2026-07/07-14-hk-marketdata-p3-probe-report.md)

## Summary

在 p1（038）已激活的 marketdata 平台 + p2（039）「加一个 marketdata 维度」范式上，**新增 2 个港股维度**：**波动率**（`VolatilityDaily`，日频历史序列，回填 10yr）+ **热度精选**（`HotSnapshot`，ss/tr/capita/rep 四 type，按 vendor 数据日期累积的快照）。各落一张 market-agnostic 事实表 + instrument FK，服务量化回测。纯 server 数据摄取，单 bounded context（marketdata），单 PR，无 UI/mockup/契约变更。2 端点已 2026-07-14 prod PoC 实测生效。形态族「日频因子」= p3 拆 4 spec 第 1 个。

## Technical Approach — 复用「加一个 marketdata 维度」既有模式

每个新维度 = 同一套文件触点（照抄 039，不发明），均 `apps/server/src/marketdata/`（扁平 per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）：

1. `<dim>.port.ts`（新，×2）— Symbol token + interface（样板 `index-membership.port.ts` / `financials.port.ts`）
2. `marketdata.types.ts` — 加 `VolatilityQuery`+`VolatilityDto` / `HotSnapshotQuery`+`HotSnapshotDto`（金融数值跨边界一律 `string|null`；波动率 value / 热度 payload 各字段）；`DIMENSION_KEYS` 加 `'volatility'`+`'hot_snapshot'`
3. `lixinger-volatility.adapter.ts` / `lixinger-hot.adapter.ts`（新，×2）— `extends LixingerAdapterBase`（基类 `post(path,body)` 注 token + 解析 `{code,message,data}` 信封）；`toLixinger(sym)` 取 `{market,stockCode}` → `/${market}/company/volatility` / `/${market}/company/hot/{type}`
4. `mock-market-data.adapter.ts` — `implements` 两 Port + cn fixture（hk fixture 用 test-local mock 护 seam）
5. `dimension-executor.ts` — `buildExecutors` 加 2 entry（走 `factExecutor` 继承 marketScope 过滤 + syncTier 序）+ `syncVolatility` / `syncHotSnapshot` 方法
6. `marketdata.module.ts` — provider 工厂 `cfg.kind==='mock'?mock:new LixingerXxxAdapter(...)`（无 fsType → 无-Prisma 工厂分支）
7. `schema.prisma` — 新 model `VolatilityDaily` / `HotSnapshot` `@@schema("marketdata")` + instrument FK cascade + `@@unique(自然键)` + Instrument 反向关系（波动率样板 `DailyBar`；热度 payload 样板 **`CorporateAction`（`schema.prisma:438-444` payload Json + 复合唯一键，同构）**）
8. migration（新，expand-only）— 2× `CREATE TABLE`+FK + `sync_dimension` seed 2 行（marketScope=`{hk}`）+ `universe→volatility` / `universe→hot_snapshot` soft 边（`-- migration_refs:` frontmatter per [ADR-0035](../../docs/adr/0035-data-layer-governance.md)）
9. `lixinger-adapters.spec.ts` — 纯函数单测（mock HTTP + mock Prisma）：波动率 volatilityDays 单数请求 + hot type 数组请求 + payload 解析（含忽略 `undefined` key）
10. `test/integration/marketdata.hk-040.<x>.it.spec.ts`（新）— Testcontainers PG + test-local mock hk + `buildRegistry` 手工装配（骨架 `marketdata.hk-039.*.it.spec.ts`）
11. `marketdata.lixinger-vendor.it.spec.ts` — 加 `describe.skipIf(!RUN_MARKETDATA_IT)` 真 vendor 契约 it（波动率 volatilityDays / hot 四 type）

## Decisions

1. **Phase 1 只动 schema+migration**（不碰 TS executor）→ 立即编译绿。`buildExecutors():Record<DimensionKey,…>` 编译器强制 exhaustive：往 `DIMENSION_KEYS` 加 key 必须同 commit 补 entry。故地基先纯数据层，后续每 Phase「加 key+加 entry+装配」原子落地（照 039 Decision 1）。
2. **波动率 = 单数 `stockCode` + `volatilityDays`（number 单数）+ 多窗口循环**：param 契约实测（p3 probe）—— `volatilityDays` 必填且是 number 单数（数组 `[250]` → `"must be a number"` 400）。adapter 单窗口方法 `getVolatilityRange({symbol, volatilityDays, from, to?})` 拉 `{date,value}` 日频序列；executor 对配置窗口集 `VOLATILITY_WINDOWS=[30,60,250]`（adapter 常量，照 039 `FUNDAMENTAL_METRICS` 范式）循环、每窗口一请求 → 落 `(instrumentId, date, volatilityDays)` 行。**不用 `metricsList`** → 无 p1 #670 all-or-nothing 坑。
3. **热度 = `stockCodes[]` 数组 + payload Json + 按 data_date 累积 + type 循环**：param 实测 = `stockCodes[]`（数组，与波动率相反！param 契约每端点单独确认）。executor 对 `HOT_TYPES=['ss','tr','capita','rep']`（adapter 常量）循环、每 type 一请求 `/hk/company/hot/{type}` → vendor 返最新快照（1 行/股，含 `last_data_date`）→ 按自然键 `(instrumentId, hotType, dataDate=last_data_date)` upsert，vendor 原始异构字段整存 `payload Json`（照 `CorporateAction.payload` 样板，忽略 `hot/rep` 的 `"undefined"` key）。
4. **热度不经 mode（delta/backfill 无分支）**：vendor 快照忽略请求日期永返最新 → executor 每次拉当前快照、按 `last_data_date` upsert（数据日期未变=幂等覆盖同行、变=落新行）。随各 type 更新频率自建前向序列（tr 日频行 / capita 年度行）—— 从上线日累积，**不回填历史**（vendor 无）。近 index_membership 覆盖式，但键含 dataDate（累积非单行覆盖）。
5. **窗口/type 子集 = adapter 常量驱动**（非 DB 配置）：`VOLATILITY_WINDOWS` / `HOT_TYPES` 常量（clarify 定值），改子集 = 改常量 + 补 probe，零 schema 变更。sync_dimension 只存 marketScope/syncTier/history_depth（波动率 10yr；热度无 history_depth 概念）。

## 两种 executor 形态

| 维度 | 形态（照抄谁）| 落库自然键 | 关键差异 |
| --- | --- | --- | --- |
| **volatility** → `VolatilityDaily` | `syncEodBars` 日频式（mode 分 from）**× 窗口循环** | `(instrumentId, date, volatilityDays)` | 单数 stockCode + volatilityDays(number 单数)；每窗口独立请求；value=年化 HV；可回填 10yr |
| **hot_snapshot** → `HotSnapshot` | 快照 upsert（无 mode）**× type 循环** | `(instrumentId, hotType, dataDate)` | 数组 stockCodes[]；payload Json 异构；dataDate=last_data_date 累积；不可回填历史 |

共性：均经 `factExecutor` 继承 `loadActiveInstruments`（marketScope∩markets 过滤 + syncTier 序，零改）；均不注 Prisma（无 fsType）；回填/同步 per-stock 前 `backfillPacer.pace()`（护共享令牌桶不被多维度夜跑叠加打爆）。差异：波动率是 append 日频序列（幂等 upsert 自然键）；热度是快照累积（按 dataDate upsert，同 dataDate 覆盖）。

## Testing Invariants（per [ADR-0040](../../docs/adr/0040-multi-layer-test-gate.md) + tasks.md 覆盖矩阵）

spec frontmatter **14 条 `state_branches` 逐条须在 IT 有 `it()`**。分层：① 纯函数单测（vitest 无 DB）验 adapter 请求结构（波动率 volatilityDays 单数 number / hot stockCodes[] 数组）+ 解析（payload 异构 / 忽略 undefined key）；② Testcontainers PG IT 验 executor 落库/幂等/marketScope 过滤/波动率多窗口成行/热度按 dataDate 累积（同 dataDate 覆盖、变则新行）；③ env-gated 真 vendor IT（`RUN_MARKETDATA_IT`，默认 skip）校 vendor 契约（波动率 3 窗口 + hot 4 type 真返）。IT run via `nx test server <file> --skip-nx-cache`（cwd=apps/server）。覆盖矩阵见 [`tasks.md`](./tasks.md)。

## 风险 / Deferred-probes（impl 期真调确认，非阻塞）

1. **波动率 value 精度**：probe 样本 `0.3377492957220201`（16 位小数）→ 建 `Decimal(12,8)`（年化 HV 范围 0~数、8 位小数足量化用）；T-impl 真调核港股极端波动率（如仙股）不溢出（Phase 1 未 merge 前可调），照 039 T019 Decimal 范式。
2. **热度 payload 字段稳定性**：各 type 字段结构不同（capita/ss/tr/rep 已 probe），payload Json 天然容纳漂移；`hot/rep` 含异常 key `"undefined"` → 解析层忽略（单测覆盖）。impl 首个真调二次确认 4 type 字段与 probe 一致。
3. **热度 dataDate 语义跨 type 差异**：`last_data_date` 各 type 不同（tr=近日 / capita=年末 / ss=近日 / rep=近日）→ 按 dataDate 累积后 tr 得日频序列、capita 得年度序列（符合预期）。impl IT 用固定 mock dataDate 验累积/覆盖两分支。
4. **波动率窗口成本**：3 窗口 × ~250 行/年/股 × 全港股 × 10yr ≈ 6.9M × 3 ≈ 21M 行 → 最高基数维度；回填 per-stock × 3 窗口 = 3× 请求数，`backfillPacer` 护限流。T-impl 回填样本股核实际量级（SC-005 观测点）。
5. **seed enabled 中途态**：单 PR 原子 merge，未注册 key 期间 `runDimension` 优雅返 SyncRun failed 不崩 worker（照 039 Decision 平台机制）。
6. **配股/其他 p3 维度**：不在本 feature（归 041 事件流 / 042 报告期 / 043 分类文本，per master 切分）。

### T012 真数据 smoke — 结果

**PR 合入时（2026-07-14，impl 环境）**：`LIXINGER_TOKEN` 未设置 → 端到端真数据 smoke + env-gated 真 vendor IT 保持 skip，3 项 probe deferred（绝不伪造实测）。核心交付（`nx affected -t lint typecheck test build --base=origin/main` 全绿 + `check-server-moat` 关 + 读端 015 market-agnostic 覆盖）已达成、真数据 smoke 非阻塞。

**合入后真调验证（2026-07-14，server `.env` 真 token）**：`RUN_MARKETDATA_IT=true` 跑 `marketdata.lixinger-vendor.it.spec.ts` → **16/16 真 vendor IT 绿**；另用 `hk:00700` 真调抓样本（2015→2024 全区间 × 3 窗口 + hot 4 type）核实下 3 项 probe，全部符合预期 ✅：

| probe 项 | 期望（p3 探查报告 / impl 假设） | 真调结果（`hk:00700`, 2026-07-14） | 状态 |
| --- | --- | --- | --- |
| 波动率精度/量级（#1/#4） | value 年化 HV，`Decimal(12,8)` 不溢出；3 窗口 × ~250 行/年/股 量级（SC-001/005） | 30/60/250d 各 2460 行 / 10yr；值域 30d`[0.151, 0.887]` / 60d`[0.163, 0.731]` / 250d`[0.206, 0.536]`，**整数位 ≤ 1**（vendor 返最多 17 位小数 → 存 `Decimal(12,8)` 截 8 位，量化足量）。上限 9999.99999999 → **巨大余量，无溢出**（即便仙股 1000%+ HV = 10.x 仅 2 整数位） | ✅ verified |
| hot payload 字段与 probe 一致（#2） | 4 type（ss/tr/capita/rep）字段结构与 p3 probe 一致，payload Json 存原始异构字段；`hot/rep` 含 `"undefined"` key 被忽略 | 真返字段：`ss`[ass_m/ass_s/ass_s_cap_r/assa/ass_s_cap_rc_w1..w24] · `tr`[tr_d1..tr_d240/spc/ta] · `capita`[stn/stn_mc_pc/stn_toi_pc/stn_np_pc/stn_ncffoa_pc] · `rep`[rs_m1..y3/rs_cap_r_*/rsap_*/rs_last…]；4 type 完全异构、均无 `undefined` key（已忽略） | ✅ verified |
| dataDate 跨 type 语义（#3） | `last_data_date` 各 type 语义（tr 日频 / capita 年度 / ss/rep 近日）→ 按 dataDate 累积序列符合预期 | 真 `last_data_date`：**tr=2026-07-14（当日 / 日频）· capita=2025-12-31（年末 / 年度）· ss=2026-07-03 · rep=2026-07-09（近日）** → 按 dataDate 累积得各自 cadence 前向序列，符合预期 | ✅ verified |

> ⚠️ 全量多夜回填（波动率 21M 行级）= 后续 ops（master INV-3 保守多夜 + 首夜 supervised），**非本 PR 范围**。

## Out of Scope（本 feature 不做）

- 热度全 39-type（只精选 ss/tr/capita/rep；余 type 回测价值存疑，不建重表）。
- 热度历史回填（vendor 快照无历史，只从上线日按 dataDate 前向累积）。
- 全量多夜回填（= 后续 ops，master INV-3 保守多夜 + 首夜 supervised，同 038/039 委托）。
- 退市股（沿 p1 active-only，生存者偏差为已知取舍）。
- p3 剩余 9 维（股本变动/配股/回购/股东权益变动/营收构成/员工/最新股东/所属行业/公告 → 041-043）。
- us 市场（本 plan 仅 hk；us 富化管线为 master 后续里程碑）。

## Constitution 对照

- **§V 纯 server 单 PR**：无 mobile/web surface（`web_compat: na`），无新读端点（015 market-agnostic 天然覆盖）→ 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]` task。
- **§III atomic commit**：每 task 各自 commit（6 步闭环 per `.claude/rules/implement-task-closure.md`）。
- **bounded context**：全改动在 marketdata 单 context 内，2 表 intra-marketdata FK（instrument FK）、无 cross-context owner（`check-server-moat.ts` 确认，同 039）。
- **TDD 红绿**：marketdata 改动 = 真后端 Testcontainers IT + env-gated 真 vendor IT，每 task 先测后实现。
