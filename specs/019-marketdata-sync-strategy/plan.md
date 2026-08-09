---
feature_id: 019-marketdata-sync-strategy
spec_ref: ./spec.md
status: approved
created_at: '2026-06-05'
updated_at: '2026-06-05'
adr_refs: ['0032', '0043', '0049']
orchestrator_compat: '>=0.1.0'
context7_verified: []
---

# Implementation Plan: 019-marketdata-sync-strategy（声明式新鲜度 + 复权因子版本化 + 维度配置化）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `019-marketdata-sync-strategy` | **设计源**: [设计沉淀文档](../../docs/private/plans/2026-06/06-04-marketdata-sync-strategy-design.md) | **前置**: 016（同步语义基线）/ 017（tick/claim/flow 宿主，PR-7 清退已合 #336）/ 018（tier 序消费，正交不动）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011-018）。
> **纯 server 同步策略升级流程**：spec ✅ → clarify ✅（5Q 2026-06-05：日历源探测双轨 / 本地算补 / fundamental 日频 / 无 context 列 / log 告警）→ **plan（本）** → tasks → analyze → implement。**无 mockup / 无 mobile 段 / 无新 HTTP 端点 / 无新依赖**。验证全走 Testcontainers IT（真 PG+Redis + mock vendor）+ env-gated 真 vendor 抽样对拍。
> **架构不重开**：五正交轴 / 三类画像 / 因子版本化 / 注册表配置化 per 设计沉淀文档定稿；本 plan 只做工程落地决策（D1-D9）。**含一处 spec 修正**（D1：因子来源从「corporate_action 公式派生」改「价格比值锚定」——spec Assumption 预留的 escape hatch 触发，见下）。

## Summary _(mandatory)_

019 = **6 维度一刀切日频 cron → 数据特性驱动**，日增量 ~33,600 → **~5,800 请求（2.2h → ~22min @ 4.26 req/s）**。四块交付：① **复权因子版本化**（新表 `AdjustmentFactor`；平淡日 eod 只拉 `none`，forward/backward = none × 段内常数因子本地算当夜落库；除权日沿用既有 `reAdjustBars` vendor 重拉 + 锚定新因子版本）；② **声明式新鲜度**（`SyncDimension` 加 `freshness_profile`/`sla_hours`/`calendar_source` 三列；tick won 之后、组 flow 前插 freshness gate——event-calendar 维度轻量日历命中检查未命中则跳过留审计（corp/fallback-financial = slow-drift 周扫不经 gate，analyze C1））；③ **维度配置化**（`runDimension` switch → Map 注册表；`DIMENSION_EXECUTION_ORDER` 常量 → `SyncDependency` 拓扑派生 + priority tie-break；新增 hard 边 `corporate_action → eod_bar`）；④ **SLA 监控**（每日一次新鲜度检查，超期结构化 ERROR log，交易日历语义防误报）。

**范式** = ADR-0043 扁平贫血（新文件平铺 marketdata/）+ 017 既有机制最大复用（claim 零变更 / SyncRun 审计 / 双窗令牌桶 / reAdjustBars）。**out of scope**：跨 ctx 框架下沉（seam only）/ webhook / 盘中实时 / tier 演进 / dashboard / vendor 多源。

## API Contracts _(mandatory)_

**无新 HTTP 端点 / 无 OpenAPI 契约变更**（FR-S13）——纯同步内部行为。无 `packages/api-client` regen、无 mobile 段、无 Constitution §V 类型同步链触发。CLI（trigger/backfill）参数不变；CLI 显式触发**不受** freshness gate 约束（运维显式要跑就跑，gate 只挂 tick 路径，D6）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（v1.2.1） | 状态 | 备注 |
| --- | --- | --- |
| I. SDD | ✅ | spec ✅ → clarify ✅（5Q）→ plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点 |
| II. Test-First TDD | ✅ | 11 条 state_branches 各有 IT；蓝本 = `marketdata.dimension-worker.it.spec.ts` / `marketdata.tick-driver.it.spec.ts`（真 PG+Redis + mock vendor）；对拍门 = 本地算 vs mock vendor 直拉值断言 + env-gated 真 vendor 抽样 |
| III. Atomic 30min-2h | ✅ | tasks 按 6 片 PR 拆；每片独立可 ship（见 Phase 2 准备） |
| IV. Module Boundary | ✅ | 全部改动在 marketdata ctx 内；零新跨 ctx 边（018 的 `CROSS-CONTEXT-READ` 直查点不动）；新文件全平铺 `apps/server/src/marketdata/` |
| V. 类型同步链 | ✅ | 无端点 → 不触发（FR-S13） |

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

**零新依赖、零 polyfill、零防御性 import**——全部能力由既有设施承载（cron-parser 已装 / Prisma / BullMQ flow / 017 tick）。拓扑排序自写 ~30 行纯函数（`sync-flow-assembler.ts` 已有 DFS 环检可复用）。`context7_verified: []` 如实为空（BullMQ flow 语义 017 已 context7 校真，无新面）。

## Architecture Notes _(mandatory)_

### ⚠️ Spec 修正（D1 触发 escape hatch，amend 随本 plan commit）

spec FR-S04 原文「因子由 corporate_action 同步派生写入…可由 corporate_action 原始数据重建」——**实装勘探推翻公式派生路径**：`lixinger-corporate-action.adapter.ts` 只拉 `/cn/company/dividend`（现金分红 + 送转），**配股 `/cn/company/allotment` 与股本变动 `/cn/company/equity-change` 是留 seam 的独立端点未拉**（adapter 注释 L11-12 实证）。公式派生对配股标的因子必错。spec Assumption 已预留：「若实际数据缺口在 clarify/plan 阶段暴露则调整因子获取路径」→ 触发。

**修正后口径（比值锚定）**：因子 = `forward(d) / none(d)`（同标的同日两口径已存 bar 的比值；前复权因子在两除权日之间为**分段常数**，任取段内一日即得）。对 vendor 复权口径**全事件类型鲁棒**（分红/送转/配股/任何我们没追踪的事件——vendor 价格已含）。除权日事实源仍 = corporate_action（exDate 定版本边界）；因子**值**锚自价格比值。重建性：全历史因子链可由已存 none+forward bar 序列重建（每段任取一日），不依赖公式。

### Bounded Context 决策（catalog 7Q）

Q1 marketdata 改自己的表（`SyncDimension` 扩列 / 新表 `AdjustmentFactor` / `DailyBar` 写入）→ 全部留 marketdata；Q2-Q4 No；Q5-Q7 无新跨 ctx 调用/读（018 直查点零改动）。新 bounded context 评估不触发——「通用化下沉」显式 out of scope（spec FR-S14 + clarify Q4 不加 context 列）。

### 关键设计（D1-D9）

1. **D1 因子来源 = 价格比值锚定**（见上方 Spec 修正）。`AdjustmentFactor` 行写入时机：corporate_action 维度发现新 exDate → 既有 `reAdjustBars` vendor 重拉完成后，对 `[exDate, targetDate]` 内每个新段锚定 `factorForward = forward(d)/none(d)`（d = 段内最新交易日，none ≠ 0 防御）+ `factorBackward` 同理。首次冷启动回填：一条 backfill 脚本按历史 bar 序列重建全因子链（每标的扫 exDate 列表 + 段内取样）。
2. **D2 除权命中检查 = 本地表查询（零外呼）**：eod_bar 执行平淡日判定 = `corporateAction.exDate ∈ (上次成功 eod 水位, asOf]` 的标的集合；空 → 全标的只拉 none；非空 → 命中标的走既有 reAdjustBars 重拉 + 锚定因子，其余标的只拉 none。未来除权可见性靠 corp 维度低频扫描提前入库（A 股分红实施公告先于除权日 ~1 周，dividend 端点 `status:implemented` 行届时已含未来 exDate）。漏报兜底三层：SLA 告警 + env-gated 对拍抽样 + 下次 corp 扫描后 reAdjustBars 窗口自愈（既有机制）。
3. **D3 除权日重算 = 沿用 vendor 重拉（不本地重算历史）**：`reAdjustBars`（dimension-executor.ts L494-521，deleteMany+createMany 原子替换）已实装且口径权威；除权日重拉只发生在命中标的（日均个位~百级 × 2 口径 × 窗口），请求开销可忽略。本地因子链只服务三件事：**平淡日最新一根推导**（FR-S05）/ **backfill 历史复权计算**（FR-S12 历史时点因子链）/ **对拍审计**（SC-S02）。风险最低——本地算只覆盖「因子确定不变」的平淡日增量。
4. **D4 corporate_action 画像 = slow-drift（周扫即同步；analyze C1 修正）**：`cron_expr` 改周频扫描节奏——扫描日全 universe dividend 扫（5,600 请求，物化未来 exDate 入库），**不挂 tick gate**（⚠️ 原 event-calendar + `'corp-action-derived'` 方案 = 以自身扫描物化的日历 gate 自己：静默期 gate 永不过 → 永不扫 → 数据永久饿死，且 SLA 以 skipped 为正常基准告警不响）；`calendar_source` 留 NULL。「事件性」体现在 **eod 的 D2 除权命中检查**（本地查询零外呼）消费 corp 物化的日历。corp 从日频 5,600 → 周频 5,600（摊 ~800/日）。
5. **D5 financial 画像 = 探测双轨**（clarify Q1 + analyze C1 收紧）：implement 首 task = env-gated 真 IT 探测理杏仁披露日历/公告类端点（候选 `/cn/company/announcement` 等；token 本地 `.env` 已有）。**有** → event-calendar + `calendar_source='lixinger-disclosure'`（日频 cron + 轻量日历端点检查，命中才组真同步——真·脉冲归零）；**无** → **落 slow-drift 周扫**（扫描日批量拉 latest，upsert 幂等天然只写新报告期；不留「到达扫描日即命中」的 degenerate gate——与 slow-drift 行为重复的标签是噪音）。event-calendar 机制（CalendarHitCheck + tick gate）照建照测（测试维度 IT），live 行依探测结论挂载。
6. **D6 freshness gate 落点 = tick 层（won 后、交易日 gate 后、组 flow 前）**：`sync-tick-driver.ts tick()` L88-96 链上加一段——对 fireNow 中 event-calendar 维度逐个跑日历命中检查（**本地 DB 查询**），未命中 → 从组 flow 集剔除 + 写 `SyncRun` status='skipped' 行（含跳过原因，FR-S03 审计痕）+ nextFireAt 已在 claim 推进（零额外动作）。**claim 逻辑零改动**（FR-S02）；CLI/cascade 路径不经 tick → 天然不受 gate 约束（运维显式触发永远跑）；continuous-daily / slow-drift 维度 gate 直通（行为 = 017 现状）。退化态等价（FR-S11）：全 continuous-daily 时 gate 全直通，请求序列与 017 现状逐字节一致。
7. **D7 executor 注册表 + 全序拓扑派生**：`DimensionKey` union type 保留（payload 校验 + TS 安全）；`runDimension` switch（dimension-executor.ts L205-227）→ `Map<DimensionKey, DimensionExecutorFn>` 构造器注册；`DIMENSION_EXECUTION_ORDER` 常量（sync-flow-assembler.ts L13-20）→ 由 `SyncDependency` 边 Kahn 拓扑排序派生，**tie-break = `SyncDimension.priority` desc（再按 key 字典序）**——派生序的确定性是 hard-边相邻校验（assembler L113-126 既有）的前提。**行为保持约束**：PR-2 重构时 seed priority 值调整为复现现行全序（universe 10 > profile 9 > fundamental 8 > financial 7 > eod_bar 6 > corporate_action 5），派生序 ≡ 现行常量序（IT 对拍断言）。环检 fail-fast 已有（assembler `assertAcyclic`）。worker named job `sync:<dim>` 已是 key 派生（`dimensionJobName()`），非 enum 触点。加新维度 = union type 加一值（编译器强制 exhaustive）+ 注册 executor + 一行 seed——SC-S05 用测试维度验证 diff 零 switch/常量改动。
8. **D8 新增 hard 边 `corporate_action → eod_bar`（PR-3 随因子逻辑加，不在 PR-1/2）**：⚠️ **时序雷区**——现行常量序 eod_bar 在 corporate_action **前**，PR-2 拓扑派生落地前加此边 = 倒流边 → assembler throw 整夜瘫痪。PR-3 加边 + priority 调整（corp 升至 eod 前），派生序变为 `[universe, profile, fundamental, financial, corporate_action, eod_bar]`——两条 hard 边（profile→fundamental / corp→eod）均链相邻，可表达性 IT 断言。语义：除权日因子先写、eod 重算后行（FR-S08）；corp 平淡日未命中被 gate 剔除时 eod 照跑不阻塞（hard 边仅同 won 时生效，assembler 既有语义）。
9. **D9 SLA 检查 = 每日一次独立 `@Cron`（盘后窗口尾，如 08:30 Asia/Shanghai）**：扫全维度 `lastSuccessAt`（注意：现 SyncRun 有 per-dim 成功记录、SyncDimension 有 lastWatermark——stale 判定基准用 **SyncRun 最近 success/partial 行**的 finishedAt，eod 专用 lastWatermark 不通用）vs `sla_hours`，超期 → 结构化 ERROR log（`alertIfDegraded` 同形态，FR-S09 字段齐）。**交易日历语义**：休市日不计龄（按交易日历折算逾期）；event-calendar 维度 skipped 行视同「按日历正常」不算 stale。每日一次天然满足「恢复后不持续重复告警」。灰度 flag：`sla_check_enabled` 不必要——sla_hours NULL = 该维度不检查（列级开关足够）。

### 预算账（SC-S01 锚，@ 4.26 req/s 实测）

| 日型 | 请求构成 | 合计 | 折时 |
| --- | --- | --- | --- |
| 平淡交易日（稳态） | eod none 5,600 + fundamental ~200（batch 调大后）+ financial 0 + corp 0（本地查）+ universe/profile 0 | **~5,800** | **~23min** |
| corp 扫描日（周一） | 上行 + dividend 全扫 5,600 | ~11,400 | ~45min |
| financial 扫描日（fallback 形态，周） | 上行 + latest 批量 ~200 | ~6,000 | ~24min |
| 除权命中日 | 上行 + 命中标的 × 2 口径 × 窗口区间（百级） | ~6,000-7,000 | ~25min |
| 现状对照 | eod 16,800 + fundamental 5,600 + financial 5,600 + corp 5,600 | ~33,600 | ~2.2h |

**fundamental/financial batchSize 调大**是预算账成员（seed batch_size=1 → 实测理杏仁批量上限后调大，fundamental 5,600 → ~200 请求）——env-gated IT 实测上限（与 D5 探测同 task 顺手做），不拍脑袋。

## Open Decisions Resolved

| # | 决策 | 选定 | 理由 / 备选 |
| --- | --- | --- | --- |
| D1 | 因子来源 | 价格比值锚定（forward/none 段内常数） | dividend 公式派生有配股缺口（allotment 端点未拉）；比值对全事件鲁棒。**触发 spec FR-S04 amend** |
| D2 | 除权命中检查 | 本地 corporateAction 表查 exDate 窗口 | 零外呼；未来 exDate 由 corp 周扫提前物化；三层兜底（SLA/对拍/重拉自愈） |
| D3 | 除权日重算 | 沿用 reAdjustBars vendor 重拉 + 锚因子 | 已实装口径权威、命中集小开销可忽略；本地重算历史 = 高风险低收益。备选全本地重算：省百级请求，赌因子精度，拒 |
| D4 | corp 画像 | slow-drift 周扫即同步，不自我 gate（analyze C1 修正） | 自身物化日历 gate 自己 = 鸡生蛋饿死；事件性由 eod D2 消费日历体现 |
| D5 | financial 日历源 | **fallback 落 slow-drift 周扫**（T001 实测 2026-06-05：无市场级披露日历端点——`/cn/company/announcement` 仅单股查询非日历，余候选 404；批量上限实测 100） | degenerate gate 不留（analyze C1 收紧）；机制照建测试维度验证 |
| D6 | freshness gate 落点 | tick 层 won 后组 flow 前（非 executor 内） | 调度决策归调度层；CLI/cascade 显式触发天然豁免；claim 零改动。备选 executor 起手 gate：CLI 也被 gate（运维反直觉），拒 |
| D7 | 注册表形态 | union type 保留 + Map 注册 + 拓扑派生全序（priority tie-break） | 类型安全与配置化兼得；派生序确定性是 hard 边校验前提 |
| D8 | hard 边加入时机 | PR-3（拓扑派生落地后） | PR-2 前加 = 倒流边 assembler throw。时序雷区显式记录 |
| D9 | SLA 检查载体 | 每日一次独立 @Cron + SyncRun 最近成功行为基准 | lastWatermark 仅 eod 维护不通用；每日一次满足不重复告警 |

## Complexity Tracking

| 复杂点 | 必要性 | 控制手段 |
| --- | --- | --- |
| 因子表与 bar 数据一致性 | 平淡日本地算的正确性根基 | 因子只在 reAdjustBars 成功后锚定（vendor 权威值就位才写）；对拍 IT + env-gated 真 vendor 抽样；可全量重建 |
| 平淡日漏报除权（公告晚于扫描窗） | event-calendar 的固有风险 | 三层兜底：SLA 告警 / 对拍抽样 / corp 下次扫描后 reAdjustBars 窗口自愈（最终一致） |
| 拓扑派生改变执行序 | 配置化 + corp→eod hard 边的前提 | PR-2 行为保持（派生序 ≡ 常量序 IT 对拍）；PR-3 序变更显式验证两 hard 边相邻 |
| 灰度期画像混合态 | 渐进上线 | 全 continuous-daily = 017 等价退化态（FR-S11 IT 对拍）；逐维度切可回退 |

无 Constitution 违反需 justify。预估新增 ~600 行 + IT（factor 锚定/推导 ~200、gate+日历检查 ~150、注册表/拓扑重构 ~100、SLA ~80、CLI 探测脚本 ~70）。

## Performance Budget

无 HTTP 端点 → 无 request-latency budget。同步层（observability 参考）：

- **freshness gate**：每 tick 对 event-calendar won 维度 1-2 条本地查询（corporateAction exDate 窗口 / financialMetric max reportPeriod）< 20ms。
- **因子推导**：平淡日 per-instrument 1 次因子 Map 查 + 2 行本地乘法，O(n) n=5,600，< 1s 纯计算。
- **SLA 检查**：每日 1 次 6 行表扫 + SyncRun 索引查（`ix_sync_run_type_started` 现成），< 50ms。
- **令牌桶消耗**：见预算账表（核心交付：稳态 -83%）。

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略（6 片，各自独立绿，渐进可回退）

| PR | 范围 | 验证门 |
| --- | --- | --- |
| **PR-1** | schema expand：`SyncDimension` 加 `freshness_profile`/`sla_hours`/`calendar_source` 三列（default 回填三类画像值）+ `AdjustmentFactor` 表迁移。**无行为变化**（新列零消费者；不加依赖边 D8） | migrate + 016/017/018 IT 全绿（纯加列回归门） |
| **PR-2** | executor 注册表（switch→Map）+ 全序拓扑派生（常量退役、priority seed 调值复现现行序）+ CLI 维度键校验改注册表源 | 派生序 ≡ 常量序对拍 IT + 016/017/018 全量回归 + SC-S05 测试维度注册演练 |
| **PR-3** | 因子版本化：reAdjustBars 后锚定因子 + 冷启动因子链回填脚本 + 平淡日 eod 只拉 none/本地推导当夜落库 + backfill 历史因子链口径 + hard 边 corp→eod（D8 此时加）+ 序变更可表达性 IT | SC-S02 对拍门（mock 全样本 + env-gated 真 vendor 抽样）+ SC-S04 除权链路门 + eod 请求数断言 5,600 |
| **PR-4** | event-calendar 驱动：tick freshness gate（D6）+ corp 周扫/本地命中检查（D2/D4）+ financial 探测双轨落地（D5，探测 task 先行）+ fundamental/financial batchSize 实测调大 + financial/corp cron 改扫描节奏 seed | SC-S03 脉冲零外呼门 + 命中日组 flow IT + skipped 审计行断言 |
| **PR-5** | SLA 监控：每日 @Cron 检查 + 结构化告警 + 交易日历语义防误报（D9） | SC-S06 四态门（超期/跳过不误报/休市不误报/恢复不重复） |
| **PR-6** | 灰度切换：prod 画像逐维度翻转（seed/SQL 运维操作 runbook）+ 配额账实测（SC-S01）+ 观察期 | SC-S01 稳态 ≤6,000 实测 + SC-S08 退化态等价门 + 整夜端到端 IT |

### tasks 拆分锚点

- 每 task 30min-2h、TDD 红绿、绑定 state_branches IT（11 条全覆盖）；新 spec 文件首跑 `--skip-nx-cache`；IT 经 `nx test server <file>`（cwd=apps/server）；本地 IT 前 `env -u OSS_*`。
- **spec drift 锚点**（impl 前 grep 验）：① `runDimension` switch `dimension-executor.ts` L205-227 / `loadActiveInstruments` L242-248（tier 序勿动）；② `DIMENSION_EXECUTION_ORDER` `sync-flow-assembler.ts` L13-20 + hard 边相邻校验 L113-126；③ tick 链 `sync-tick-driver.ts` L86-123（claim L126-183 **零改动**）；④ `reAdjustBars` L494-521 + `RE_ADJUST_TYPES` L37 + `upsertCorporateActions` 返 minNewExDate L460-487；⑤ seed 行 `20260603_0030_add_marketdata_sync_tables/migration.sql` L71-79（新 seed 走新 migration 不改旧）；⑥ dividend adapter 过滤 `status:implemented` 行 L45（未来 exDate 可见性前提，探测 task 顺带校真「实施公告先于除权日」假设）；⑦ `marketdata.config.ts` 灰度 flag 形态（tickEnabled 先例）。
- **env-gated 探测 task（PR-4 首 task，但建议 implement 起手先跑**——D5 双轨哪条 + batchSize 上限 + 「公告先于除权日」三个事实一次采齐，输出贴 PR 描述）：`LIXINGER_TOKEN` 本地 `.env` 已有；探测脚本平铺 `scripts/` 或临时 tsx，不入 src。
- IT 蓝本：`marketdata.dimension-worker.it.spec.ts`（executor 面）/ `marketdata.tick-driver.it.spec.ts`（tick 面）；因子簇可独立 `marketdata.adjustment-factor.it.spec.ts`。
- 迁移命名 per `migration-naming-check`（lefthook）；migration 含 seed UPDATE 时 ON CONFLICT 幂等。

### Out of Scope 再确认（→ 后续 feature / seam）

跨 ctx 框架下沉（ADR-0032 sunset trigger）/ context 列（clarify Q4）/ webhook·外部编排器 / 盘中实时 / T1 tier / dashboard（clarify Q5）/ vendor 多源 / allotment·equity-change 端点接入（独立 seam，比值锚定不依赖）。
