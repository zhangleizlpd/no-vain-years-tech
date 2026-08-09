---
feature_id: 018-marketdata-tiering
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-04'
updated_at: '2026-06-04'
adr_refs: ['0032', '0043', '0048']
orchestrator_compat: '>=0.1.0'
context7_verified: []
---

# Implementation Plan: 018-marketdata-tiering（T0/T2 二级分级 — executor 前置重算 + tier 序消费 + Q7-B 直查）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `018-marketdata-tiering` | **设计源**: [规划文档](../../docs/private/plans/2026-06/06-04-marketdata-tiering-feature-planning.md) + [ADR-0048 复审记录](../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md) | **前置**: 013（信号源表）/ 016（同步语义基线）/ 017（executor/tick/flow 宿主，PR-1~5 已合）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011/012/015/016/017）。
> **纯 server 同步行为升级流程**：spec ✅ → clarify ✅（3Q 2026-06-04：重算 executor 前置 / 快照生效 / T0 重试留 seam）→ **plan（本）** → tasks → analyze → implement。**无 mockup / 无 mobile 段 / 无新 HTTP 端点 / 无 schema 迁移 / 无新依赖**。验证全走 Testcontainers IT（真 PG+Redis + mock vendor）。
> **架构不重开**：Q7-B 直查终态（含拒绝项：Q7-A 投影/计数器/事件机器、第二 producer 升级论）已 ADR-0048 复审记录定稿；本 plan 只做工程落地决策（D1-D6）。

## Summary _(mandatory)_

018 = **016 全量统一同步 → T0/T2 二级分级**（纯行为变更，schema 零迁移）。交付（两片 PR）：① **syncTier 重算**——新文件 `sync-tier-recalc.ts`（`@Injectable` 手控风格，ADR-0043）：一条 Q7-B 直查取全账号自选并集（`prisma.watchlistItem.findMany({distinct})` + `// CROSS-CONTEXT-READ:` 注释，moat 探针 Check 1 现成机制，`watchlistItem: 'portfolio'` ownership 已登记 L79）→ 双 `updateMany` 条件落 `Instrument.syncTier`（命中→0 / 未命中→2，`syncTier: {not: X}` 过滤保证幂等零行变更）；接线点 = `DimensionExecutorRegistry.runDimension()` fact 维度载工作集前（实证 L207，单点覆盖 4 个 fact 维度 × 2 syncRunMode × 全触发路径）；降级 = 内部 try/catch + warn log（沿 `alertIfDegraded` L525 风格），失败沿用现有 tier 照常同步。② **tier 序消费**——`loadActiveInstruments()`（实证 L244-248）`orderBy: {id:'asc'}` → `[{syncTier:'asc'}, {id:'asc'}]` 一行改动，T0 先吃令牌桶 + `maxEodInstruments` 截断天然按 tier 序生效；017 顺延（self re-enqueue + `pendingEodInstruments` 进度锚）零改动。

**范式** = ADR-0043 扁平贫血 + ADR-0048 Q7-B（marketdata 自此非叶子 ctx，唯一跨 ctx 面 = 一条带注释的只读查询）。**out of scope**：T1 / holdings 等第二信号源 / Q7-A 投影 / 盘中实时 / T0 失败优先重试（clarify 留 seam）/ 管理界面。

## API Contracts _(mandatory)_

**无新 HTTP 端点 / 无 OpenAPI 契约变更 / 无 CLI 参数变更**（FR-S07）——纯同步内部行为。无 `packages/api-client` regen、无 mobile 段、无 Constitution §V 类型同步链触发。trigger/backfill CLI 行为不变（重算随 executor 前置自动生效，运维无感知）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（v1.2.1） | 状态 | 备注 |
| --- | --- | --- |
| I. SDD | ✅ | spec ✅ → clarify ✅（3Q）→ plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点 |
| II. Test-First TDD | ✅ | 9 条 state_branches 各有 IT；蓝本 = `marketdata.dimension-worker.it.spec.ts`（真 PG+Redis + mock vendor）；消费序断言用 mock adapter 记录调用序 |
| III. Atomic 30min-2h | ✅ | tasks 按两片 PR 拆；每片独立可验证 |
| IV. Module Boundary | ✅ | **marketdata 转非叶子 ctx**（本 feature 的架构事件）：唯一跨 ctx 面 = `sync-tier-recalc.ts` 内一条只读查询 + `CROSS-CONTEXT-READ` 注释（moat Check 1 机制现成、ownership 已登记，**moat 脚本零改动**）；零 portfolio module import（直查经 `PrismaService`，ESLint boundaries 零新边）；跨 ctx 写仍永禁 |
| V. 类型同步链 | ✅ | 无端点 → 不触发（FR-S07） |

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

**零新依赖、零 polyfill、零防御性 import**——全部能力由既有设施承载（Prisma updateMany / 017 executor 注册表 / moat 探针）。`context7_verified: []` 如实为空。

## Architecture Notes _(mandatory)_

### Bounded Context 决策（catalog 7Q）

Q1 marketdata 改自己的表（`Instrument.syncTier`）；Q2-Q4 No；Q5-Q6 无同步/异步跨 ctx 调用；**Q7 命中**——独立只读跨 ctx 读（夜间 job 为算自己的 syncTier 读 portfolio 表）→ **Q7-B 直查**（ADR-0048 复审记录终态选择，非临时债；Q7-A 两 trigger 前不重开；Q7-C 直 DI 禁）。落地形态 = `PrismaService` 直查 + 注释，**不**经 SecurityModule 包读服务（单消费方多包一层无收益，catalog B 形态允许）。

### 关键设计

1. **`sync-tier-recalc.ts`（新文件，唯一新结构）**：`@Injectable() SyncTierRecalc`，单方法 `recalcSafely(): Promise<void>`——
   - 查询：`// CROSS-CONTEXT-READ: 只读 portfolio watchlist_item 全账号 distinct(market,code) 并集，算 marketdata 自有 syncTier（ADR-0048 Q7-B 终态 2026-06-04）` + `findMany({where: {market: MARKET}, distinct: ['code'], select: {code: true}})`（V1 universe 仅 cn，MARKET 常量实证 dimension-executor.ts L33）；
   - 落库：`$transaction([updateMany({where: {market, code: {in: codes}, syncTier: {not: 0}}, data: {syncTier: 0}}), updateMany({where: {market, code: {notIn: codes}, syncTier: {not: 2}}, data: {syncTier: 2}})])`——`syncTier: {not: X}` 过滤 = 幂等零行变更（FR-S01）；`codes` 空数组时第一条天然 no-op、第二条全量回 T2（state_branch「自选全空」）；
   - 降级：方法内 try/catch 全包——失败 `logger.warn`（业务降级口径，与 `alertIfDegraded` 同道，不新增告警通道 FR-S06）后返回，caller 无感知继续同步。
2. **接线点（D1 落地）**：`DimensionExecutorRegistry.runDimension()` 的 fact 维度分支起手（`loadDimension` 前）调 `await this.tierRecalc.recalcSafely()`——单点覆盖 eod_bar/fundamental/financial/corporate_action × aggregate-merge/per-dim × tick/CLI/cascade/旧管线全路径；universe/profile 分支不调（universe 是源、profile 是一次性富化非新鲜度同步，见 D2）。注册表构造器注入 `SyncTierRecalc`（同 ctx 注入，无注释要求）。
3. **tier 序消费**：`loadActiveInstruments()` L248 `orderBy: {id: 'asc'}` → `[{syncTier: 'asc'}, {id: 'asc'}]`（同 tier 内保持 id 稳定序，FR-S03）；`select` 无需加列（排序不需投影）。5400 行无需新索引（全表内存排序毫秒级）。`maxEodInstruments` 截断与 `pendingEodInstruments` 进度锚消费的就是这个序 → SC-S03 截断保底零额外代码。
4. **profile 维度不纳入 tier 序（D2 决策）**：spec FR-S03 范围 = 「按 instrument 遍历的维度」——profile 遍历的是「缺 `lixingerCompanyType` 的标的子集」（一次性富化语义，新标的入库后补一次），非夜间新鲜度同步；强行 tier 序收益≈0 且要动 use case 内部查询（违背 017 FR-S18 use case 零改动精神）。tasks 里以 plan 注记形式留痕，不改 spec（语义澄清非缩水）。
5. **回归面**：016/017 全量 marketdata IT 是回归门（重算前置不改变维度同步结果集语义——全量 universe 仍全部同步，只是顺序变化）；唯一可能受影响的既有断言 = 依赖 `id asc` 消费序的 IT（tasks 起手 grep `orderBy.*id` 相关断言，有则改为 tier 序口径）。
6. **Cross-cutting（落地必带）**：`check-server-moat` 零改动（机制+ownership 全现成，跑通即验）；ESLint boundaries 零新边（无 portfolio import）；`marketdata.module.ts` providers 注册 `SyncTierRecalc`。

## Open Decisions Resolved

| # | 决策 | 选定 | 理由 / 备选 |
| --- | --- | --- | --- |
| D1 | 重算收敛点 | `runDimension()` fact 分支起手单点（非每 executor 方法内、非 worker processor 层） | 单点覆盖 4 维度×全路径×两 syncRunMode；worker 层挂载会漏旧管线 `run()` 过渡期路径。clarify Q1 已定 executor 前置，本条只定收敛粒度 |
| D2 | profile 是否 tier 序 | 不纳入 | 富化语义非新鲜度；动 use case 内部查询违 017 零改动精神；收益≈0 |
| D3 | 重算 SQL 形态 | distinct 查询 + 双条件 updateMany（`syncTier {not}` 过滤）+ `$transaction` 包裹 | 幂等零行变更可断言（FR-S01）；快照一致性（两条 updateMany 间无半成品态暴露给本维度后续读）。备选单 raw SQL `CASE WHEN` = 省一条语句但可读性差，规模下无收益 |
| D4 | 降级边界 | `recalcSafely` 内部全包 try/catch + warn log，caller 无感知 | FR-S06「重算失败不阻塞同步」的最小实现；抛错上抛会被 executor 顶层 catch 误记 SyncRun=failed（重算失败≠维度失败）。备选 caller 侧 catch = 4 个调用点重复 |
| D5 | 并集口径的 market 维度 | V1 锁 `MARKET='cn'` 常量（与 017 executor 一致） | watchlist 表有 cn 外 market 行时不影响 cn universe 分级；多市场 = universe 多市场化时一并扩 |
| D6 | 消费序 IT 断言方式 | mock vendor adapter 记录 per-instrument 调用序，断言 T0 符号集整体先于 T2 | 「断言消费顺序而非仅最终状态」（SC-S02）；备选查 DailyBar 落库时间戳 = 同毫秒不可分辨 |

## Complexity Tracking

| 复杂点 | 必要性 | 控制手段 |
| --- | --- | --- |
| marketdata 失去叶子身份 | 分级的本质需求（读用户信号） | 耦合面钉死在一条带注释查询；moat 探针机械强制；升 Q7-A trigger 已 ADR 留痕 |
| 重算与消费的同夜时序 | executor 前置 = 每维度快照 | 幂等 + 维度间微漂仅影响序不影响正确性（spec edge case 已接受） |

无 Constitution 违反需 justify。本 feature 总代码量预估 ~150 行 + IT——复杂度天花板低是 Q7-B 决策的直接收益。

## Performance Budget

无 HTTP 端点 → 无 request-latency budget。同步层开销目标（observability 参考，非硬门禁）：

- **重算单次**：1 distinct 查询（watchlist 数百行）+ 2 updateMany（universe ~5400 行）< 50ms；每夜 ≤4 次（fact 维度数）≈ 零负载。
- **排序开销**：5400 行内存排序，无新索引需求。
- **令牌桶消耗**：零变化（重算不打 vendor，纯本地 PG）。

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略（两片，各自独立绿）

| PR | 范围 | 验证门 |
| --- | --- | --- |
| **PR-1** | `sync-tier-recalc.ts`（查询+落库+降级）+ module 注册 + `runDimension` 接线 + 重算 IT（命中/未命中/多引用去重/幂等零变更/清空回 T2/读失败降级照跑+告警）| 重算 IT 簇全绿 + `check-server-moat` 0 violation + 注释 grep 在场（SC-S01/S04） |
| **PR-2** | `loadActiveInstruments` orderBy 改 tier 序 + 消费序 IT（mock vendor 调用序断言）+ 截断保底/顺延续跑 IT + universe upsert 护值与黑名单优先回归断言 + 端到端一夜模拟 | SC-S02/S03/S05/S06 全绿 + 016/017 既有 marketdata IT 全量回归门 |

### tasks 拆分锚点

- 每 task 30min-2h、TDD 红绿、绑定 state_branches IT；新 spec 文件首跑 `--skip-nx-cache`；IT 经 `nx test server <file>`（cwd=apps/server）。
- **spec drift 锚点**（impl 前 grep 验，per memory `sdd_spec_drift_anchors`）：① `loadActiveInstruments` 在 `dimension-executor.ts` L244-248（017 已从 pipeline 迁出，**不在** `eod-sync-pipeline.ts`）；② `runDimension` fact 分支 L198-207（universe/profile 早退在 L199-204）；③ `MARKET='cn'` 常量 L33；④ `alertIfDegraded` L525（降级 log 风格参照）；⑤ moat `MODEL_OWNERSHIP.watchlistItem='portfolio'` L79 + Check 1 `contiguousCommentAbove` L266-273（注释必须紧贴语句上方连续注释块）；⑥ 既有 IT 是否有依赖 `id asc` 消费序的断言（PR-2 起手 grep）。
- IT 蓝本 = `marketdata.dimension-worker.it.spec.ts`（PG+Redis+mock vendor+afterAll close）；重算簇可独立 PG-only spec 文件（`marketdata.tier-recalc.it.spec.ts`）。
- 模板：手控 `@Injectable` 单一职责类 = `RedisSyncLock` / `SyncTierRecalc` 同型。

### Out of Scope 再确认（→ 后续 feature / seam）

T1 recency（访问历史表）/ holdings·追踪·预警信号源（union 平移）/ Q7-A 投影（两 trigger）/ 盘中实时分级 / T0 失败优先重试（clarify 留 seam）/ 管理界面。
