---
feature_id: 038-hk-marketdata-core
spec_ref: ./spec.md
status: drafted
created_at: 2026-07-11
updated_at: 2026-07-11
adr_refs: ['0047', '0032', '0043', '0040', '0019']
context7_verified: []
---

# Implementation Plan: 港股核心数据同步 + 平台市场缝隙激活

## Summary *(mandatory)*

把现有 6 个 marketdata 同步维度（universe/profile/eod_bar/fundamental/financial/corporate_action）从 A 股硬编码扩展到港股（`market='hk'`）—— 通过激活既有但休眠的「市场缝隙」（adapter 路径按 market 段插值 + `marketScope` 过滤取代 `MARKET='cn'` 常量 + backfill `--markets` 透传 + fundamental/fs 新增 per-stock 区间抓取），并对全部在市港股按流动性 `syncTier` 分层做保守多夜 10 年历史回填。**零新表、零新端点、零新依赖** —— 纯 server 侧数据摄取（形态同 016-marketdata-sync）。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A（复用现有 Lixinger adapter 栈 / BullMQ / DualWindowRateLimiter / Prisma，无新包、无 polyfill） | N/A |

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

评估逐条：
- **I. SDD**：走完整 specify→clarify→plan→…；**无 UI**（server 数据摄取）→ 无 mockup 步（Constitution §I 后端 use case 豁免）。✓
- **II. TDD**：每 task 红→绿→typecheck→`[X]`→commit；状态机分支经 testcontainers IT 先红。✓
- **III. Atomic task**：seam 改造与逐维度扩 HK 各为 30min-2h 可独立 commit 单元。✓
- **IV. Module Boundary（扁平+贫血+护城河+零-class）**：全部改动落 `apps/server/src/marketdata/` **单一 bounded context 内**，无跨 context import、无碰他 ctx 表；复用既有贫血 Prisma row + `*.rules.ts` 纯函数，无新 repository、无 Domain Class。✓
- **V. 类型同步链**：**无新端点 / 无 OpenAPI 变更 / 无 mobile**（读端点 015 已落且 market-agnostic 天然覆盖 hk）→ 纯 server 单 PR，无 api-client regen。✓

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 无新端点；同步管线改动经 **Testcontainers real-boot IT**（PG + Redis）覆盖 spec.md 全部 19 条 `state_branches`（形态复用 `apps/server/test/integration/marketdata.schema-016.it.spec.ts`），含市场路由 cn 无回归 / hk 路由 / marketScope 过滤 / fsType-reit / 区间回填 / 自限速 / 幂等等。unit+module 不充分。
- [x] **Mobile / Web**: N/A —— 纯 server 数据摄取，零 mobile/web surface（spec `web_compat: na`）。
- [x] **Evidence**: 待 impl 落 IT 文件（`marketdata.hk-038.it.spec.ts` 新增 + 现有 016 IT 无回归）；smoke 命令 `env -u OSS_* nx test server marketdata.hk-038.it.spec.ts`（本地 IT 需 unset OSS_* 防 ZodError，per reference_local_it_smoke）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

N/A —— **不引入任何新第三方包 / SDK / 工具**。复用既有理杏仁 adapter 栈（`LixingerAdapterBase` + `LIXINGER_HTTP_CLIENT` + `DualWindowRateLimiter`）。港股只是同一 vendor 的另一市场路径（`/hk/...`）。

**Evidence**: N/A — no new package.

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

N/A —— feature 为 **mono-native**（marketdata 模块由 specs 015-020 在 mono 内建成，无 meta-repo Java 迁入）。

- [x] **Evidence**: `grep -rn "mbw-\|springframework\|mapstruct\|src/main/java" apps/server/src/marketdata/` → 空（无 stale Java/Maven 制品）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0047 | 「理杏仁批量多 code 上限 / 日配额 / EOD 数据就绪时刻 — 付费 dashboard + 真实请求确认」 | **mitigated（部分）** | p0 已实测确认：**有效期内无日/总配额**、限速 1000/min·36/s（见 [p0 报告](../../docs/private/plans/2026-07/07-11-hk-marketdata-p0-probe-report.md)）。残留（HK 批量 code 上限 / EOD 就绪时刻）→ impl 首个真实调用确认，非阻塞（现有 budget/deferral + 自限速兜底）。 |

ADR-0046 的「港股」字样为 portfolio min-1 市场不变性的举例，**与本 feature 无关**（false positive）。其余 `rg` 无影响 Open Questions。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 本 feature **无 Guard/Interceptor/Filter/Pipe**（是数据同步 executor + adapter + rules 纯函数）→ 该禁令对本 feature 无直接适用面，但仍禁止用 mock 抹掉 vendor/DB 真实行为来「测过」同步逻辑。
- **MANDATORY INTEGRATION**: 同步管线与持久化 MUST 经 `Test.createTestingModule` + **Testcontainers**（PG+Redis）真跑（形态同 `marketdata.schema-016.it.spec.ts`）；vendor 边界用 Mock adapter（`MARKETDATA_PROVIDER=mock`）注入确定性响应，但**落库/幂等/路由/marketScope 过滤经真 PG**。
- **EXHAUSTIVE BRANCHING**: spec.md 19 条 `state_branches` **每条**必须在 IT 有对应 `it()`。尤其不可漏：`市场路由 cn 无回归`、`未知市场前缀抛错`、`marketScope 过滤`、`fsType-reit 路由`、`区间回填多行`、`自限速无 429`、`共享限流器串行`、`幂等重跑`、`vendor 字段缺失存 null`。

### General Architecture Notes

> ⚠️ **ADR-0043 扁平+贫血+护城河**：改动全在 `apps/server/src/marketdata/` 平铺；数据 = 现有贫血 Prisma row；不新建 repository / Domain Class；不碰他 context 表。

**核心：激活既有休眠缝隙，不新造机制**（4 处 seam，已 grep 确认 `marketScope` 当前读取处为 0 = 纯休眠列）：

1. **`marketScope` 取代 `MARKET` 常量**（seam#2，最关键）：`dimension-executor.ts:293` 现 `where:{market: MARKET, status:'active'}`（`MARKET='cn'` 从 `marketdata.types.ts:13` import + `:43` re-export）。改为 `where:{market:{in: dim.marketScope}, status:'active'}`（`dim` = 当前维度的 `SyncDimension` 行，`marketScope String[]` 列已存在、seed=`{cn}`）。清理 `MARKET` 常量的 orphan 引用（`dimension-executor.ts:9,43` + backfill CLI `estimateRequests` 的 `market:'cn'` 硬编码 `marketdata-backfill.cli.ts:255`）。**数据迁移**：一条 migration `UPDATE marketdata.sync_dimension SET market_scope = ARRAY['cn','hk'] WHERE dimension_key IN (6 维)`（形态同既有 cron seed migration，纯 data 非 DDL）。

2. **adapter 路径按 market 段插值**（seam#1）：各 Lixinger adapter 现 `const {stockCode}=toLixinger(sym)` 丢 `market`、hardcode `/cn/company/...`。改为 `const {market,stockCode}=toLixinger(sym)` + 路径 `` `/${market}/company/...` ``。锚点：`lixinger-eod-bar.adapter.ts:57,65`、`lixinger-fundamental.adapter.ts`、`lixinger-financials.adapter.ts`、`lixinger-corporate-action.adapter.ts`、`lixinger-universe.adapter.ts`、`lixinger-adapter.base.ts:89(resolveFsTypes)`。**删除** fundamental/financials adapter 里 `.filter(e=>e.lix.market==='cn')` 的静默丢弃（那正是 A 股硬编码的另一处）。`lixinger-symbol.rules.ts`（`LixingerMarket='cn'|'hk'` + `SUPPORTED_MARKETS={cn,hk}`）**已就绪，不改**。

3. **fundamental/fs per-stock 区间抓取模式**（seam#4，gap#4 已 p0 验证支持）：现 adapter 仅 `date:'latest'`（单日快照，前向累积）。新增区间模式 `{stockCode, startDate, endDate, metricsList}`（p0 确认 HK+A 股均支持），供 backfill 拉历史日频序列。**形态照抄 `lixinger-eod-bar.adapter.ts` 的 `getBars(from,to)`**（已是 per-stock 区间范式）。端口层加区间方法或复用现有 query DTO 扩 `from/to`。

4. **backfill `--markets` 真透传**（seam#3）：`executeBackfill` 的 `payload()` 现不含 markets、`estimateRequests` hardcode `market:'cn'`。把 `args.markets` 织入 job payload → executor 工作集过滤 + 估算按 markets 累加（`marketdata-backfill.cli.ts`）。

**港股特有处理**：
- **fsType 加 `reit`**：HK fsType 值域 = `bank/insurance/non/other/reit/security`（比 A 股多房托，p0 确认）。`profile` 维度富化 `Instrument.lixingerCompanyType`，`resolveFsTypes`/fundamental/fs 路由需接受 `reit` 值路由到 `/hk/company/{fundamental,fs}/reit`。
- **HSI 交易日历**（Clarification Q2）：`lixinger-trading-calendar.adapter.ts` 现从 A 股指数（`000001` 上证综指）派生交易日。扩展为 `market='hk'` 时从**恒生指数（HSI）via `hk/index/candlestick`** 派生（`trading-day-gate.ts` 已 market-参数化，`TradingDay` 表 `(market,date)` 主键已支持）。HSI 的理杏仁 index code 于 impl 首次调用确认。
- **syncTier 分层**（Clarification Q1）：全部在市港股都回填，但 HSI/港股通成分标的经 `sync-tier-recalc.ts` 机制提级 tier-0 优先落库、长尾 tier-2 后置。成分来源（HSI constituents via `hk/index/constituents` 或初期 curated 种子）于 impl 定；**不缩减范围**。

**回填 pacing（INV-3，防风控）**：
- 底层限速**不动**（`lixinger.constraint-profile.ts` `perSec:36/perMin:900` = 官方 1000/min 的 90%，双窗慢桶稳态 ~15/s）。
- 回填期**叠加自限速** ~10/s（~600/min，≈共享桶 2/3，对官方累计 ~40% buffer）+ 调用间随机 jitter。实现落点：backfill 路径的 per-call sleep/jitter（或 backfill-mode 专用 limiter 参数）—— impl 选最小侵入方案，不改共享 profile。
- 港股回填 job 与 A 股夜间同步 job 共享单 `LIXINGER_HTTP_CLIENT` + queue `concurrency=1` → **天然串行**，不并发打爆共享桶。
- 分夜收敛：eod_bar 靠 `pendingEodInstruments`（已同步跳过）天然续跑；区间维度（fundamental/fs 历史）加轻量 backfill cursor 或靠自然键 upsert 幂等续跑。

**存储（INV-1，业界 Securities Master 范式）**：
- **零 DDL**：复用现有 7 张 market-agnostic 表（`Instrument`/`DailyBar`/`FundamentalSnapshot`/`FinancialMetric`/`CorporateAction`/`AdjustmentFactor`/`TradingDay`），HK 行经 `market='hk'` / `instrument_id` FK 区分。**禁** `hk_*` 前缀并行表。
- HK `Instrument`：`market='hk'`、`currency='HKD'`（`sync-universe.usecase.ts` 现 hardcode `currency:'CNY'` → 改按 market 取 CNY/HKD）。

**契约 / 端点**：无。读端点（015）market-agnostic 天然覆盖 hk，无 OpenAPI 变更、无 api-client regen、无 mobile。故本 feature **无 `contracts/` 制品**。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：沿用现有 split-tx（HTTP fetch 在 tx 外，PG 写在 `$transaction` 内，per `dimension-executor.ts`）；`DailyBar` bulk `createMany({skipDuplicates})`，其余 upsert 自然键；scheduler claim 用 conditional UPDATE affected-count（现状，不改）。→ `../../docs/conventions/server-impl-playbook.md`
- **安全**：`LIXINGER_TOKEN` 经 SOPS 注入（现状）；本 feature 不新增凭证/PII 面。
- **前端**：N/A（无 mobile）。

**Deferred impl-probes（无独立 research.md —— per sdd.md「plan 阶段仅 plan.md」；本节即 SoT，非阻塞，首次真实 hk 调用兜底）**：**P1** HK `listingStatus` 值域 → active/inactive 映射；**P2** HK fundamental 是否下发估值分位指标（pePctlY3/Y5…，SC-006 依赖）；**P3** HK 批量 code 上限 / EOD 就绪时刻（ADR-0047 Open Q1 残留）；**P4** fundamental/fs 文档示例 URL 显 `cn/`（疑模板复用）→ 确认真实 `hk/` 路径生效。全部 null-tolerant（沿 015「字段缺失不报错」），impl 首个真实 hk 调用确认后**回填本节 + 必要时修 spec SC**。

> **Disposition（prod 真调核销，2026-07-12）**：部署前经 prod 77 容器（真 `LIXINGER_TOKEN`）逐 probe 实测，**4 个 deferred-probe 全部核销**：
>
> - **HSI index code ✅**：`/hk/index` 列出旗舰 `HSI 恒生指数`，`/hk/index/candlestick` stockCode=`HSI`（大写）+`type:'normal'` 返 bars —— impl 常量 `'HSI'` **本就正确**，零改。
> - **P1 listingStatus ✅**：hk `/hk/company` 值域 = `{normally_listed: 2781, delisted: 8}`（比 cn 简单，无 ST/*ST）；allowlist 正确映射 `normally_listed`→active、`delisted`→inactive（生存者偏差如设计）。零改。
> - **P2 分位字段 ✅**：hk **下发全部 4 个分位** `pe_ttm.y3/y5.cvpos`、`pb.y3/y5.cvpos`（逐 metric code=1）—— SC-006 可满足，无需下调。
> - **P4 hk 路径 ✅**：`/hk/company/fundamental/{fsType}` 用**原始 `fsTableType`**（`non_financial`/`reit`）生效（p0 catalog 的短名 `non` 反而无效）—— impl 用原值路由**本就正确**。
>
> **但真调另揪出 2 个 metric-validity bug**（mock 测覆盖不到，all-or-nothing）：`fundamental` 的 `cmc`（流通市值）+ `fs` 的 `q.bs.tetoshopc_ps.t`（BPS）为 cn 有效但 hk 无效，含之则理杏仁拒整请求（code=0）→ hk fundamental/financial 会静默 0 行。**修 = market-aware metric 裁剪（hk 剔除，cn 不动）**，见 PR `fix/hk-marketdata-metric-validity`（`circMarketCap`/`bps` hk 置 null）。
>
> 另记：`cn/index/candlestick` 对 `000001`/`000300` 均 code=0（cn 索引列表却正常）——**pre-existing、cn-only、与本 feature 无关**，留独立排查。

## Complexity Tracking

> Constitution Check 无违规，本表留空。
