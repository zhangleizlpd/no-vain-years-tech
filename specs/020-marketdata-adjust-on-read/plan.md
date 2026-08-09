---
feature_id: 020-marketdata-adjust-on-read
spec_ref: ./spec.md
status: approved
created_at: '2026-06-05'
updated_at: '2026-06-05'
adr_refs: ['0032', '0043', '0050', '0051']
orchestrator_compat: '>=0.1.0'
context7_verified: []
---

# Implementation Plan: 020-marketdata-adjust-on-read（只存 none + 累积因子，读时换算）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `020-marketdata-adjust-on-read` | **设计源**: [设计沉淀文档](../../docs/private/plans/2026-06/06-05-eod-none-plus-factor-design.md) | **前置**: 016（eod 同步语义基线）/ 019（AdjustmentFactor 表 + 比值锚定 + 平淡日 none-only 拉取，本 feature 在其上收敛存储形态）

> ⚠️ **模型改判（2026-06-05 implement 期 T001 STOP 裁决，详 spec Clarifications 第二节 + ADR-0051 修订段）**：理杏仁 fc/bc_rights 实证为**减法精确复权**（乘法恒等不成立 → STOP 触发）→ 改判**自洽比值模型**——因子存储粒度 = per-event 跃变 `f_i`（锚定公式 = 跨除权日相邻两日双口径比值之比），读时累积 `B(t) = ∏ f_i`；SC-A02 改双判据（dividend 公式交叉验证 ε=2e-2 + 自洽恒等门），存量行对拍改口径差异留档。下文 D1-D3/D5/D7 已按此修订；其余结构不变。
>
> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011-019）。
> **纯 server 存储模型升级流程**：spec ✅ → clarify ✅（4Q 2026-06-05：相对误差判据 / factor_forward drop / 配置列收窄 / 窗口期最终一致）→ **plan（本）** → tasks → analyze → implement。**无 mockup / 无 mobile 段 / 无新 HTTP 端点 / 无新依赖**。验证全走 Testcontainers IT（真 PG + mock vendor）+ env-gated 真 vendor 对拍门。
> **架构不重开**：累积 backward 单真相 / 读时换算公式 / 回填后 DELETE 清退 per 设计沉淀文档三决策定稿；本 plan 只做工程落地决策（D1-D9）。**019 的 freshness 画像 / tick gate / SLA 机制零触碰**。

## Summary _(mandatory)_

020 = **eod 复权存储三口径物化 → 单口径 + 因子读时换算**（业内 Tushare/JoinQuant adj_factor 终局形态）。三块交付：① **读时换算**（K线端点 forward/backward 改读 none 行 × 因子内存换算，`forward(t) = none(t) × B(t) / B_latest`，prevClose 跨段边界显式处理，API contract 零变更）；② **写路径收窄**（平淡日只写 none 1 行；除权命中 = none 落库 + 1 次 transient vendor backward 锚定新因子版本，`reAdjustBars` 行重拉退役；backfill 2 次/标的；`factor_forward` 列 drop）；③ **冷启动重建 + 存量清退**（`--factors` 改 transient vendor 锚定不依赖物化行；dev 存量 fwd/bwd 行对拍验证后分批 DELETE，运维 runbook 人工执行）。

**范式** = ADR-0043 扁平贫血（新纯函数平铺 marketdata/）+ 019 既有机制最大复用（比值锚定哲学 / 双触发点幂等 / D2 除权命中检查零改动）。**out of scope**：019 调度机制 / 分钟线 / 新复权口径 / K线缓存层 / 跨 ctx 下沉。

## API Contracts _(mandatory)_

**无新 HTTP 端点 / 无 OpenAPI 契约变更**（FR-A08）——K线端点同路径同参数（`adjust=none|forward|backward`）同响应形态，换算对调用方透明；报价/详情端点（仅消费 none）零触碰。无 `packages/api-client` regen、无 mobile 段、无 Constitution §V 类型同步链触发。CLI（backfill/--factors）参数形态不变，内部语义更新。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（v1.2.1） | 状态 | 备注 |
| --- | --- | --- |
| I. SDD | ✅ | spec ✅ → clarify ✅（4Q）→ plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点 |
| II. Test-First TDD | ✅ | 9 条 state_branches 各有 IT/单测；蓝本 = `adjustment-factor.rules.spec.ts`（纯函数）/ `marketdata.dimension-worker.it.spec.ts`（executor 面）+ bars usecase IT；对拍门 = mock 全样本 + env-gated 真 vendor 相对误差判据 |
| III. Atomic 30min-2h | ✅ | tasks 按 3 片 PR 拆；每片独立可 ship（见 Phase 2 准备） |
| IV. Module Boundary | ✅ | 全部改动在 marketdata ctx 内；零新跨 ctx 边；新文件全平铺 `apps/server/src/marketdata/` |
| V. 类型同步链 | ✅ | 无端点变更 → 不触发（FR-A08） |

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

**零新依赖**——换算为 `Prisma.Decimal` 内存运算（019 推导同款），段查找为排序数组两指针，全部既有设施。`context7_verified: []` 如实为空。

## Architecture Notes _(mandatory)_

### Bounded Context 决策（catalog 7Q）

Q1 marketdata 改自己的表（`AdjustmentFactor` 缩列 / `DailyBar` 写入收窄 / K线 usecase 读路径）→ 全部留 marketdata；Q2-Q4 No；Q5-Q7 无新跨 ctx 调用/读（018 直查点零改动）。新 bounded context 评估不触发。

### 关键设计（D1-D9）

1. **D1 读时换算落点 = usecase 内存换算 + 新纯函数**：新文件 `apps/server/src/marketdata/adjusted-bars.rules.ts` —— `deriveAdjustedBars(noneBars, factorVersions, adjust)` 纯函数（输入版本 = per-event 跃变 `f_i`；bars 升序 × 版本 exDate 升序两指针 + running product，O(n + m log m)；价格字段乘因子 `.toFixed(4)` 保持 Decimal(18,4) 刻度与 019 推导一致；volume/amount/turnoverRate 直拷；跃变 ≤0 防御按 1 隔离）。`get-instrument-bars.usecase.ts`：`adjust=none` **early-return 原查询零改动**（SC-A04 逐字节等价）；forward/backward → 查 none 行 + 该标的全部因子版本（`adjustmentFactor.findMany` 行数 = 除权次数，极小）→ 纯函数换算 → 进既有 period 聚合（先日线换算后聚合，聚合语义不变）。
2. **D2 段查找与 prevClose 跨段边界**：`B(t)` = `∏ f_i (exDate_i ≤ t)`，无版本 → 1（首个已存事件前隐含 1，FR-A02）；`B_latest` = **全版本跃变乘积**（含 `exDate > 查询窗口` 的已锚版本——forward 基准是「标的当前状态」非「窗口内状态」）。**prevClose**：t 非 exDate → 同段 B；t 恰为某版本 exDate → 用**前一段** B（= 前一交易日所在段，AS-3）；实现为两指针推进时保留 prevSeg 乘积，与窗口内前一根换算 close 一致性由 IT 断言。
3. **D3 transient 锚定 `anchorNewFactorVersion` 替代 `reAdjustBars`**（2026-06-05 对齐 #348 修订 + 模型改判）：vendor backward 拉取 **lookback 全窗** `[target − reAdjustLookbackDays, target]`（#348 已将 reAdjustBars 改全窗——同 1 次 vendor 请求，覆盖窗内全部事件 → 历史缺锚事件顺带幂等补锚，analyze L4 自动消解）**不落 DailyBar**（transient）+ DB none 行同窗口 + 标的全 exDate 列表 → `anchorFactorJumps` per-event 跃变锚定（`f_i = [bwd(ex)/bwd(ex−1)] ÷ [none(ex)/none(ex−1)]`，ex−1 = 序列内前一交易日；跨事件比值对 vendor backward 窗口水位平移免疫）→ upsert（uk instrument × exDate 幂等，乱序补锚零级联）。**签名无需 exDate 参数**（#348 后 `exDateHits` 返回 `Set<bigint>`）：`anchorNewFactorVersion(inst, targetDate, lookback)`。双触发点保持（corp 扫描 / eod 除权命中同改）；未来 exDate 段无 bar 天然 no-op（019 D2 机制零改动）；拉取失败 → WARN 告警 + none 落库不受影响，下次触发幂等补锚（FR-A05/clarify ④）。
4. **D4 写路径收窄**（`dimension-executor.ts`）：`syncEodBarDeltaDerived`（L458-495）→ `syncEodBarNone`（只 fetch none 落 1 行，推导段整删）；`latestFactorsByInstrument`（L430-450）退役；除权命中路径 3 口径直拉（L361-376）→ none 1 次 + `anchorNewFactorVersion`；`RE_ADJUST_TYPES`（L37）/ `reAdjustBars`（L668-699）/ `anchorAdjustmentFactors`（L707-748）退役删除。`pendingEodInstruments` none 锚定口径注释简化（「corp 链先写复权行」的场景消失）。
5. **D5 backfill / 冷启动统一 2-call 形态**：backfill 模式 = none 全历史落库（1 次）+ backward 全历史 transient 锚全部事件（1 次）；`rebuildFactorChains`（`marketdata-backfill.cli.ts` L177-230，现读 DB 三口径零外呼）→ 改 transient vendor backward + DB none 行（1 次/有除权史标的；零除权史跳过——无事件可锚）；两者共享 `anchorFactorJumps` 锚定 helper。`--factors` 从零外呼变 ≤5,600 次一次性（有除权史标的数上界，analyze L1），配额可忽略。
6. **D6 schema 时序（雷区；tasks 阶段细化为 expand→contract 两段）**：`factor_forward` drop **必须与写路径收窄同 PR**（PR-2）且**不能单段**——该列 NOT NULL，写路径改造的中间 task（transient 锚定先落地、CLI 后收口）窗口期 upsert 仍受列约束 → **expand 段先改 nullable**（旧写者兼容、新锚定省略该列），**contract 段最后 drop**（全仓零消费者后，prisma generate + typecheck 即硬证）。contract migration 顺手：`adjustTypes` seed UPDATE `['none']` + schema 注释标 deprecated；`reAdjustLookbackDays` 注释收窄为「transient 锚定拉取窗口上限」（clarify ③，列都保留）。**推论：`--factors` CLI 是 factorForward 写者 + 旧 `anchorFactors` 消费者 → 新语义必须随 PR-2 收口（自 PR-3 移入）**。
7. **D7 ε probe（已执行 2026-06-05，结论定格）**：`scripts/diag/lixinger-probe-020.ts` + `-subtraction.ts` + `-round2.ts`（tsx，读本地 `LIXINGER_TOKEN`，不入 src 不进 CI；合计 97 请求）——① 恒等**不成立**（vendor = 减法精确复权，STOP 触发 → user 改判自洽比值模型，见 plan 顶部修订 note）；② 新判据 ε 实测（per-event `f` vs dividend 公式 `f̂`，139 可比事件）：主体 ≤5e-3，max 1.65e-2（vendor 再投资 convention gap）→ **ε = 2e-2**，>5e-3 离群 WARN 复核；③ backward 永不 rebase ✓（5/5 截断窗口零差异；绝对水位锚查询窗口起点 → 跨事件比值是唯一不变量）。三结论已回填 spec SC-A02/Assumptions + tasks.md T001 行下方。
8. **D8 存量清退（运维 runbook，PR-3 载体；2026-06-05 范围修正 per #346 实测）**：**dev + prod 双库**——prod daily_bar 已有 4.97M 行 / 1.1GB（forward/backward 99.7%）+ none 仅单日深度。顺序硬约束 = **prod 先 backfill 补齐 none 历史**（读时换算唯一基底；020 形态 none 1 次/标的 + backward transient 锚因子）→ 新版 `--factors` 回填 → 离线对拍脚本（读时换算 vs 存量物化行抽样，SC-A02 同判据）→ 分批 `DELETE FROM marketdata.daily_bar WHERE adjust <> 'none'`（dev + prod ~4.95M 行；SQL 脚本入 `ops/`，**人工执行**不进 migration，FR-A09）→ `VACUUM ANALYZE marketdata.daily_bar`（delete 死行回收，§14.2 待办顺带）。同 PR 更新 [06-05 灰度 runbook](../../docs/private/plans/2026-06/06-05-sync-strategy-graying-runbook.md) 对应步骤为新语义。
9. **D9 零回归保障**：none 分支 early-return 原查询不动（SC-A04）；EP2 报价 / EP3 详情零触碰；016/019 marketdata IT 全量回归；既有 IT 中断言「3 行落库 / reAdjustBars 行覆盖」的用例随写路径收窄改写（行为契约变更是本 feature 本体，非误删——tasks 阶段逐文件列出）。

### 预算账（SC-A03 锚；速率口径 = prod 实测 8-12 req/s（§14.1），时间折算较本机 4.26 约减半）

| 场景 | 019 现状 | 020 切换后 |
| --- | --- | --- |
| 平淡日 eod | 5,600（none only） | 5,600（不变；SC-S01 ≤6,000 口径维持） |
| 除权命中/标的 | 5 次（3 口径直拉 + reAdjust 2 口径） | **2 次**（none + transient backward） |
| 全量回填 eod | 16,800（3 口径） | **11,200**（none 落库 + backward 锚定） |
| `--factors` 冷启动 | 0 次（读存量物化行） | ≤5,600 次一次性（= 有除权史标的数上界，≈22min @ 4.26 req/s，配额可忽略；analyze L1） |
| DailyBar 写入 | 3 行/标的/日 | **1 行/标的/日（-66%）** |

## Open Decisions Resolved

| # | 决策 | 选定 | 理由 / 备选 |
| --- | --- | --- | --- |
| D1 | 读时换算落点 | usecase 内存换算 + 纯函数（非 SQL join/视图） | 行数 ≤ 数千 × 纯乘法，DB 层方案复杂度不抵收益；纯函数可单测 |
| D2 | B_latest 取值域 | 标的全部已锚版本的最新（不限查询窗口） | forward 基准 = 标的当前状态；限窗口 = 同一标的不同窗口 forward 不可比 |
| D3 | 除权日锚定来源 | transient vendor backward 比值（不落行） | 019 D1 比值哲学延续；公式派生配股缺口未解（allotment 端点仍未拉） |
| D6 | factor_forward drop 时点 | PR-2（与写路径收窄同 PR） | PR-1 提前 drop 炸旧写路径；时序雷区显式记录 |
| D7 | ε 数值来源 | probe 实测回填（非拍脑袋） | clarify ① 判据形态已定，数值是事实探测；恒等不成立 = STOP 信号 |
| D8 | DELETE 载体 | ops/ SQL 脚本 + 人工执行 | FR-A09 不进 migration；不可逆操作人工卡点（PR 标「建议人工合并」不必要——DELETE 本身不在 PR 内，PR 只含脚本） |

## Complexity Tracking

| 复杂点 | 必要性 | 控制手段 |
| --- | --- | --- |
| 读时换算正确性（跨段/边界/基准） | 切换的正确性核心 | 纯函数全分支单测 + IT + 双重对拍（vendor 直拉 / dev 存量物化行）+ ε probe 前置校真恒等关系 |
| 写读切换的过渡期一致性 | PR-1（读切）与 PR-2（写收窄）之间写路径仍写 3 行 | 无害死数据写入（读已不消费）；PR-2 落地即停；dev 因子链未回填段读到 factor=1（dev-only，PR-3 回填修复，prod 无此窗口） |
| 存量 DELETE 不可逆 | 存储回收终局动作 | 顺序硬约束（回填→对拍→删）+ WHERE 仅 `adjust <> 'none'` + 人工执行 |

无 Constitution 违反需 justify。预估净变化 ~ -100 行（新增换算纯函数 ~120 + transient 锚定 ~80；删除推导/重拉/双因子锚定 ~300）+ IT 改写。

## Performance Budget

无新 HTTP 端点 → 无新 request-latency budget。读路径（SC-A05 锚）：

- **K线复权请求**：+1 次 `adjustmentFactor.findMany`（行数 = 除权次数，索引查 < 5ms）+ O(n) 内存乘法（n ≤ 数千，Decimal 运算 < 10ms）——P95 无可感知回归。
- **none 请求**：early-return 零额外开销（逐字节等价门）。
- **除权日同步**：每命中标的 2 次 vendor 调用（vs 现状 5），同步窗口耗时下降。

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略（3 片，各自独立绿，读先写后）

| PR | 范围 | 验证门 |
| --- | --- | --- |
| **PR-1** | ε probe（D7，起手先跑）+ `adjusted-bars.rules.ts` 纯函数 + bars usecase 读时换算（D1/D2）。**schema 不动、写路径不动**（仍写 3 行成死数据，读已切换不消费） | 纯函数全分支单测 + bars usecase IT（跨段/prevClose 边界/零因子/B_latest 语义）+ SC-A04 none 逐字节等价断言 + 016/019 回归 |
| **PR-2** | 写路径收窄（D4：delta 只写 none / 除权命中 transient 锚定 / backfill 2-call）+ `anchorFactorJumps` 纯函数改造 + **`--factors` 新语义（D5，自 PR-3 移入——factorForward 写者随 drop 收口）** + schema expand→contract 两段 migration（nullable → drop factor_forward + adjustTypes seed 收窄 + 注释，D6）+ 既有 IT 断言改写 | 平淡日 1 行断言 + 除权命中 transient 调用计数 + 因子 upsert + 零复权行写入 IT + 锚定失败告警分支 + 冷启动幂等 IT + SC-A03 请求数断言 |
| **PR-3** | 口径差异留档脚本 + DELETE 清退脚本（ops/）+ 灰度 runbook 更新（D8）+ env-gated 真 vendor 对拍 IT（SC-A02 双判据终验：dividend 公式交叉验证 + 自洽恒等）+ dev 实操清退 | 对拍门（ε = 2e-2 + WARN 名单）+ dev 实操 runbook 走查（含人工 DELETE）+ SC-A01 终态 |

### tasks 拆分锚点

- 每 task 30min-2h、TDD 红绿、绑定 state_branches IT（9 条全覆盖）；新 spec 文件首跑 `--skip-nx-cache`；IT 经 `nx test server <file>`（cwd=apps/server）；本地 IT 前 `env -u OSS_*`。
- **spec drift 锚点**（impl 前 grep 验；行号已对齐 #348 后现状，2026-06-05 复核）：① `syncEodBars` 三模式分流 `dimension-executor.ts` L315-394 + `syncEodBarDeltaDerived` L447 + `latestFactorsByInstrument` L419 + `exDateHits` L408（**#348 后返回 `Set<bigint>`**）；② `reAdjustBars` L659（**#348 后签名无 fromExDate、窗口 = lookback 全窗**）+ `RE_ADJUST_TYPES` L46 + `anchorAdjustmentFactors` L696 + corp 扫描触发点 ~L607；③ `anchorFactors` `adjustment-factor.rules.ts` L53-90（签名改造起点）；④ bars 读 `get-instrument-bars.usecase.ts` L47-54 + period 聚合调用链；⑤ `rebuildFactorChains` `marketdata-backfill.cli.ts` L177-230；⑥ schema `AdjustmentFactor` L335-348 / `DailyBar` L251-271 / `SyncDimension.adjustTypes`+`reAdjustLookbackDays`；⑦ 既有 IT 中断言 3 行落库 / reAdjustBars 覆盖行为的用例（grep `forward` in `*.it.spec.ts` / `*.spec.ts`，改写非误删）—— **含 #348 新增 `marketdata.eod-pipeline-readjust.it.spec.ts`（断言全窗重写行为，PR-2 随 reAdjustBars 退役改写）**。
- **probe task（PR-1 首 task）**：`scripts/diag/lixinger-probe-020.ts`，三事实一次采齐（恒等校真 / ε 实测 / backward 稳定性），结论回填 spec SC-A02 + 本文件 D7 + 贴 PR-1 描述；探测耗请求 ≤100。**恒等不成立 → STOP 回 user**。
- IT 蓝本：`adjustment-factor.rules.spec.ts`（纯函数）/ `marketdata.dimension-worker.it.spec.ts`（executor 面）；读路径可独立 `marketdata.adjusted-bars.it.spec.ts`。
- 迁移命名 per `migration-naming-check`；seed UPDATE 幂等。

### Out of Scope 再确认（→ 后续 feature / seam）

019 调度机制（freshness/tick gate/SLA）零触碰 / 分钟线·实时 / 新复权口径 / K线缓存层（SC-A05 失守再议）/ allotment·equity-change 端点接入（独立 seam，比值锚定不依赖）/ DailyBar.adjust 列 drop(uk 重建，未来独立 chore)。
