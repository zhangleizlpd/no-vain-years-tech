---
feature_id: 020-marketdata-adjust-on-read
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-05'
---

# Tasks: 020-marketdata-adjust-on-read（只存 none + 累积因子，读时换算）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `020-marketdata-adjust-on-read`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 读时换算 / US2 写路径收窄 / US3 冷启动重建+存量清退）
- 层 = `[Server]` / `[Server-IT]` / `[Probe]` / `[Verify]`（纯 server，无新端点 → 无 [Contract]/[Mobile]，FR-A08）
- **Phase = PR 交付单元**（plan §Phase 2 三片；各自独立绿、读先写后）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；IT 蓝本 = `adjustment-factor.rules.spec.ts`（纯函数）/ `marketdata.dimension-worker.it.spec.ts`（executor 面）；run via `nx test server <file>`（cwd=apps/server）；本地 IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`
- 无 task-meta JSON（manual 模式，per 004-019）
- **clarify 四裁决**（2026-06-05，实现承重点）：① 对拍判据 = 相对误差 `|derived−vendor|/vendor ≤ ε`（ε T001 实测回填；⚠️ 判据形态已由下行改判重定义）；② factor_forward 直接 drop；③ adjustTypes/reAdjustLookbackDays 列保留语义收窄；④ 锚定延迟窗口期 forward 旧 B_latest 基准照常服务
- **模型改判（2026-06-05 implement 期 T001 STOP 裁决，详 spec Clarifications 第二节 + ADR-0051 修订段）**：vendor 实证减法精确复权 → 改**自洽比值模型**——因子存储 = per-event 跃变 `f_i = [bwd(ex)/bwd(ex−1)] ÷ [none(ex)/none(ex−1)]`（列名 factorBackward 保留标新语义），读时累积 `B(t) = ∏ f_i`；SC-A02 = dividend 公式交叉验证（ε=2e-2，>5e-3 WARN）+ 自洽恒等门；T013 存量行对拍改口径差异留档。T005 起锚定函数名 = `anchorFactorJumps`
- **tasks 阶段两处 plan 细化**（随本文件 commit 同步 amend plan PR 表）：(a) **D6 drop 拆 expand→contract 两段**——`factor_forward` 现为 NOT NULL，单段 drop 与 per-task 绿冲突（T007-T009 窗口期 transient 锚定 upsert 仍需该列可省略）→ T006 先 nullable（expand）、T010 再 drop（contract，全仓零消费者后）；(b) **`--factors` CLI 新语义从 PR-3 移入 PR-2**——`rebuildFactorChains` 是 factorForward 写者 + 旧 `anchorFactors` 消费者，drop 列前必须收口，PR-3 留对拍/清退/runbook 纯收尾
- **T001 STOP 条件**：恒等关系 `forward(t) ≈ backward(t)/B_latest` 实测不成立 → **停，回 user 重议**（B 累积因子模型根基，spec Assumption 破坏）
- **drift 排查修正已落**（2026-06-05，并行线 #346/#347/#348 合入后复核）：① **ADR-0051 supersede ADR-0050**（0050 当日定格三口径全物化与本 feature 正面冲突——决策者改判 + #348 全窗重写实证 + 选 B 三条理由逐条有解，详 ADR-0051 Context）；② **prod 存量假设修正**（#346 实测 4.97M 行/1.1GB，99.7% 派生冗余 + none 仅单日深度）→ 清退 dev+prod 双库、prod 前置 none 历史 backfill；③ **T007 对齐 #348**（lookback 全窗 + `exDateHits` 返回 `Set` → 锚定签名无 exDate 参数）；④ 行号锚点全部复核更新 + #348 新增 IT `marketdata.eod-pipeline-readjust.it.spec.ts` 入 T008 改写清单
- **analyze 修正已落**（M1/M2/M3/L1/L2，2026-06-05）：T014 增 SC-A05 latency spot-check；T008 体量标注允许拆 a/b；T013 runbook 增冷启动回填顺序前置（corp → eod 或事后 `--factors` 补锚）；plan 预算表 `--factors` 改上界表述；backfill backward 拉取按「有除权史才拉」条件化（spec AS-5 随 T008 微调为上界措辞）
- **019 机制零触碰红线**：freshness gate / tick claim / SLA 检查 / D2 除权命中检查（`exDateHits`）任何 task 不得改动语义

## Path Conventions

- server：`apps/server/src/marketdata/`（ADR-0043 扁平平铺）；新文件 ≤2：`adjusted-bars.rules.ts` + 探测脚本（`scripts/diag/`，不入 src）；清退脚本 `ops/`；IT `apps/server/test/integration/marketdata.*.it.spec.ts`
- **spec drift 锚点（impl 前 grep 验真，per plan；行号已对齐 #348 后现状 2026-06-05 复核）**：① `syncEodBars` 三模式分流 `dimension-executor.ts` L315-394 + `syncEodBarDeltaDerived` L447 + `latestFactorsByInstrument` L419 + `exDateHits` L408（返回 `Set<bigint>`，#348）；② `reAdjustBars` L659（签名无 fromExDate、lookback 全窗，#348）+ `RE_ADJUST_TYPES` L46 + `anchorAdjustmentFactors` L696 + corp 扫描触发点 ~L607；③ `anchorFactors` `adjustment-factor.rules.ts` L53-90；④ bars 读 `get-instrument-bars.usecase.ts` L47-54 + period 聚合调用链；⑤ `rebuildFactorChains` `marketdata-backfill.cli.ts` L177-230；⑥ schema `AdjustmentFactor` L335-348 / `DailyBar` L251-271；⑦ 既有 IT 中断言「3 行落库 / reAdjustBars 全窗重写」的用例（grep `'forward'` in spec 文件 + `marketdata.eod-pipeline-readjust.it.spec.ts`（#348 新增）——**改写非误删**，行为契约变更是本 feature 本体）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + migrate deploy（mbw-poc-postgres:5433 / redis:6380）
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`；迁移命名 per `migration-naming-check`；**新 seed 走新 migration 不改旧**（applied migration 改炸 checksum）

---

## Phase 1: PR-1 — ε probe + 读时换算（US1，读先切）

- [X] T001 [P] [Probe] **理杏仁复权恒等三事实探测（D7，B 模型根基校真）**：新脚本 `scripts/diag/lixinger-probe-020.ts`（tsx，读本地 `.env` `LIXINGER_TOKEN`，不入 src/ 不进 CI）——抽样 ≥10 个多次除权史标的（含近期除权 + 多年分红股），一次采齐：① **恒等关系校真**：vendor `forward(t) ≈ backward(t) / B_latest` 全样本成立性（B_latest = backward 最新段比值锚定）；② **最大相对误差实测** → ε 数值（预期 1e-3~1e-4 量级）；③ **backward 永不 rebase 抽样验证**（对比历史段 backward 值与早期拉取/换算预期，Assumptions 校真）→ verify: 三结论写入本文件本 task 行下方 + **ε 回填 spec SC-A02 + plan D7 选定列** + 贴 PR-1 描述；探测耗请求 ≤100。**① 不成立 → STOP 回 user（红线，见 Format 段）**
  - **三结论（2026-06-05 实测，12 样本 / 97 请求 / 三脚本 `lixinger-probe-020{,-subtraction,-round2}.ts`）**：
    1. ① **不成立 → STOP 已触发并裁决**：理杏仁 fc/bc_rights = 减法精确复权（段内 `none−forward` ≡ 每股股息，600519 的 23.957 元分毫不差；601088 历史 forward 负价格；乘法恒等 maxε 10⁻¹~10²）→ user 改判**自洽比值模型**（Format 段「模型改判」+ spec Clarifications 第二节）
    2. ② 新判据 ε 实测（per-event `f` vs dividend 公式 `f̂`，139 可比事件）：主体 ≤5e-3（2dp 舍入），max **1.65e-2**（601088 2022-07-11，vendor 再投资 convention gap）→ **ε = 2e-2**，>5e-3 离群 WARN 复核；同日多 dividend 行必须聚合后比（601318 2018-06-07 实证）
    3. ③ backward 永不 rebase ✓（5/5 截断窗口 overlap 零差异；forward 对照组 5/5 出现差异证管道可见反例）；**bc_rights 绝对水位锚查询窗口起点**（非上市日）→ 跨事件比值是唯一不变量，per-event 跃变锚定对此免疫
- [X] T002 [US1] [Server] **`deriveAdjustedBars` 纯函数**（模型改判后跃变语义）：新文件 `apps/server/src/marketdata/adjusted-bars.rules.ts` —— `deriveAdjustedBars(noneBars, factorVersions, adjust): T[]`（版本 = per-event 跃变 `FactorJumpVersion`；bars tradeDate 升序 × 版本 exDate 升序两指针 + running product，O(n+m log m)；`B(t)` = ∏ f_i (exDate_i ≤ t) 缺省 1；forward 再除 `B_latest`（全版本乘积，缺省 1 → forward=backward=none）；价格字段乘因子 `.toFixed(4)` 保持 Decimal(18,4) 刻度；**prevClose**：t 恰为某版本 exDate → 用前段乘积（prevSeg），否则同段；volume/amount/turnoverRate 直拷；跃变 ≤0 防御按 1 隔离；复杂度注释 Big O）→ verify（TDD，新 spec `adjusted-bars.rules.spec.ts` 纯函数单测全分支）: 跨段乘对 / 首段隐含 1 / 零版本标的三口径相等 / forward=backward÷B_latest 恒等 / exDate 当日 prevClose 用前段因子且与前一根换算 close 一致 / 多版本跳段 / 直拷字段零变化 / 4dp 刻度 / 空输入与非法跃变防御
- [X] T003 [US1] [Server] **bars usecase 读时换算接入**：`apps/server/src/marketdata/get-instrument-bars.usecase.ts` —— `adjust='none'` **early-return 原查询零改动**（SC-A04）；`forward|backward` → 查 `adjust='none'` 行 + `adjustmentFactor.findMany({where:{instrumentId}})` 全版本 → `deriveAdjustedBars` → 进既有 period 聚合（先日线换算后聚合，聚合语义不变）。**schema 不动、写路径不动**（物化行成死数据，读已不消费）→ verify（TDD，扩展 bars usecase IT）: seed none 行 + 多版本因子 → forward/backward 响应值 = 公式换算（含跨段窗口 + exDate 边界根）/ 零因子标的与 none 一致 / **none 请求响应与现状逐字节等价断言** / 周月聚合复权口径正确 / 016/019 marketdata IT 全量回归绿
- [X] T004 [Verify] **PR-1 门**：`nx run server:typecheck` + `nx lint server` + marketdata IT 全量绿（首跑 `--skip-nx-cache`）+ T001 三结论与 ε 在 PR 描述 → commit-push-pr + auto-merge

---

## Phase 2: PR-2 — 写路径收窄 + 因子单真相 schema（US2 + US3 冷启动）

- [X] T005 [US2] [Server] **`anchorFactorJumps` 纯函数（additive，旧 `anchorFactors` 暂留至 T009；模型改判后 per-event 跃变锚定）**：`apps/server/src/marketdata/adjustment-factor.rules.ts` —— 新函数 `anchorFactorJumps(noneBars, backwardBars, exDates): FactorJumpVersion[]`（per exDate：取 ex 与序列内前一交易日 ex−1，`f = [bwd(ex)/bwd(ex−1)] ÷ [none(ex)/none(ex−1)]`；两日任一缺双口径在场 / none=0 / bwd=0 防御跳过不 throw；同日多事件 exDates 去重单版本；跨事件比值对 backward 窗口水位平移免疫——019 防御语义逐条延续）→ verify（TDD，扩展 `adjustment-factor.rules.spec.ts`）: 单除权日跃变锚对 / 多事件各自独立锚定（乱序输入不串）/ ex−1 取序列前一交易日（停牌跳空）/ 缺行与零值防御跳过 / 同日多事件单版本 / 未来 exDate（无 ex 日 bar）跳过
- [X] T006 [US2] [Server] **schema expand migration（factor_forward 改 nullable）**：`apps/server/prisma/migrations/<ts>_relax_factor_forward_nullable/migration.sql` + `schema.prisma`（`factorForward Decimal?`）——expand 段：旧写者（reAdjustBars 链/CLI）照写兼容，T007 起新锚定可省略该列 → verify: migrate deploy + prisma generate + `nx test server` 回归绿
- [X] T007 [US2] [Server] （impl 注：`RE_ADJUST_TYPES` 删除自 T008 提前至此——reAdjustBars 退役即成 orphan，per orphan 清理纪律；受影响 IT 改写一并落本 task：`eod-pipeline-readjust` 全文 + `adjustment-factor` ①-④/T010②⑥ + `night-e2e-019` mock 两日序列与因子断言）**`anchorNewFactorVersion` transient 锚定替代 `reAdjustBars`**（对齐 #348 全窗语义）：`dimension-executor.ts` —— 新私有方法 `anchorNewFactorVersion(inst, targetDate, lookback)`（**无 exDate 参数**——#348 后 `exDateHits` 返回 `Set<bigint>`）：vendor backward 拉取 **lookback 全窗** `[target − lookback, target]` **不落 DailyBar** + 读 DB none 行同窗口 + 标的全 exDate 列表 → `anchorFactorJumps` → upsert（只写 factorBackward 列 = 跃变 f_i；uk 幂等；窗内历史缺锚事件顺带补锚，乱序零级联）；**双触发点改接**（corp 扫描 ~L607 / eod 除权命中路径）；拉取失败 → WARN 告警 + 不阻塞（clarify ④）；未来 exDate 段无 bar 天然 no-op（019 D2 到期命中再锚，机制零碰）；`reAdjustBars`（L659）+ `anchorAdjustmentFactors`（L696）删除（orphan 清理）→ verify（TDD，扩展 `marketdata.adjustment-factor.it.spec.ts`）: 新除权 → 恰 1 次 backward transient 调用（mock 计数）+ 因子版本 upsert + **零 DailyBar 复权行写入** / 双触发点幂等（同标的同 exDate 重复锚定同值）/ 失败注入 → WARN + none 链不受影响 + 重触发补锚 / 未来 exDate no-op
- [X] T008 [US2] [Server] （impl 注：未拆 a/b 单 commit 落地——T007 已先行消化大半 IT 改写；本 task 余量 = executor 三模式收窄 + 7 个 IT 计数/调用序断言 ×3→×1）**eod 写路径收窄（delta/命中/backfill 三模式）**：`dimension-executor.ts` `syncEodBars` —— **delta 平淡日**：`syncEodBarDeltaDerived` → `syncEodBarNone`（只 fetch none 落 1 行，推导段整删）+ `latestFactorsByInstrument` 退役删除；**除权命中**：none 1 次落库 + `anchorNewFactorVersion`（T007）；**backfill**：none 全历史落库（1 次）+ **有除权史标的**才 backward 全历史 transient 锚全段（1 次，与 `--factors` 共享 helper 形态；零除权史跳过——无段可锚，analyze L2）+ 随本 task 同 commit 微调 spec AS-5/SC-A03 为上界措辞（019 T010 先例）；`RE_ADJUST_TYPES`（L46）删除；`pendingEodInstruments` 注释简化；**既有 IT「3 行落库 / 全窗重写」断言改写**（锚点 ⑦，改写非误删——**含 #348 新增 `marketdata.eod-pipeline-readjust.it.spec.ts` 随 reAdjustBars 退役整体改写为 transient 锚定断言**）→ verify（TDD）: 平淡日 n 标的恰 n 次 getBars + DailyBar 仅 none 行断言 / 命中标的恰 2 次调用（SC-A03）/ backfill 有除权史 2 次、零除权史 1 次 + 全段因子在场 / 016/019 回归绿；**体量标注（analyze M2）**：implement 时允许拆 T008a（delta 收窄 + latestFactors 退役）/ T008b（命中 + backfill + 既有 IT 改写）两 commit
- [X] T009 [US3] [Server] **`--factors` 冷启动新语义（CLI）**：`marketdata-backfill.cli.ts` `rebuildFactorChains` —— 改为 per 有除权史标的：vendor backward 全历史 transient 拉取（1 次）+ DB none 行 → `anchorFactorJumps` 全部事件锚定 upsert（不再读存量物化复权行）；**旧 `anchorFactors` 此时 orphan → 删除**（含 import 清理；其 spec 用例已由 T005 跃变语义改造覆盖确认）→ verify（TDD，扩展 CLI spec + IT）: 库内仅 none 行 + 除权事件 seed → 回填全部事件跃变断言 / 零除权史标的零因子行 / 二次跑幂等零变更（US3 AS-1/AS-2）
- [X] T010 [US2] [Server] **schema contract migration（drop factor_forward + 配置收窄 seed）**：新 migration —— ① `ALTER TABLE adjustment_factor DROP COLUMN factor_forward` + `schema.prisma` 删字段（此时全仓零消费者——prisma generate + typecheck 即硬证）；② `sync_dimension` seed UPDATE：eod_bar `adjust_types = '{none}'`（幂等）；③ schema 注释：adjustTypes 标 deprecated（恒 none）+ reAdjustLookbackDays 语义收窄为「transient 锚定拉取窗口上限」（clarify ③）+ AdjustmentFactor.factorBackward 标新语义（per-event 跃变 f_i，非累积值——模型改判）→ verify: migrate deploy + prisma generate + `nx test server` 全量回归 + grep 全仓零 `factorForward` 残留
- [X] T011 [Verify] **PR-2 门**：016/019 marketdata IT 全量回归 + typecheck/lint + SC-A03 请求数断言在场 + migration-naming-check → commit-push-pr + auto-merge；**PR 描述 flag**：DailyBar 写路径 + 因子表 schema 双变更属高敏感面，附 T007/T008 mock 计数证据

---

## Phase 3: PR-3 — 对拍终验 + 存量清退（US3 收尾）

- [X] T012 [US3] [Server-IT] （impl 注：gate 实装名 = `RUN_MARKETDATA_IT`——019 T012 任务文写 RUN_VENDOR_IT 但实装即此名，per memory 以实装名为准；f_i 构造性取自 production `anchorFactorJumps` × 真 vendor 数据（写库同源），库内存量行对拍归 T013 留档；2026-06-05 真跑绿：可比事件 >20，WARN 名单 5 条全为 601088 再投资 convention gap，max 1.65e-2 ≤ ε）**SC-A02 对拍门（env-gated 真 vendor，模型改判后双判据）**：新 IT（`RUN_VENDOR_IT=1` gate 默认 skip，per 019 T012 先例）—— 抽样标的（含多次除权史）：① **独立源交叉验证**：库内全部跃变 `f_i` vs dividend 端点公式 `f̂_i = prevClose×(1+送转股比)/(prevClose−每股股息)`（同日多行聚合后比），全样本断言 `|f−f̂|/f̂ ≤ 2e-2` + 输出 >5e-3 WARN 名单；② **自洽恒等**：读时换算 `forward = backward ÷ B_latest` 抽样断言（构造性兜底）→ verify: env-gated 跑通 + 默认 skip 不拖慢 CI suite
- [X] T013 [P] [US3] [Server] （impl 注：①落 `ops/adjust-caliber-diff-report.ts`（tsx，复用 server PrismaService + deriveAdjustedBars，dev dry-run 跑通）；③runbook 更新 = §1.4 `--factors` 新语义 + §3 三口径观察项改单口径 + 新增 §6 清退序列；docs/private/plans/** 在 markdownlint exclude 内）**口径差异留档 + DELETE 清退脚本 + runbook 更新**：① 口径差异留档脚本（`ops/` 或 CLI 子命令，模型改判后**非通过门**）：存量物化 fwd/bwd 行（减法口径）vs 读时换算（比值口径）抽样比对，输出差异分布报告**留档**（预期不一致——口径变更证据链，删前最后审计）；② 分批 DELETE 脚本 `ops/cleanup-materialized-adjust-bars.sql`（`WHERE adjust <> 'none'` 分批 + 行数预检/后检，**人工执行**不进 migration，FR-A09）；③ [06-05 灰度 runbook](../../docs/private/plans/2026-06/06-05-sync-strategy-graying-runbook.md) 对应步骤更新为新语义 + **prod 实测范围修正**（#346：prod 已有 4.97M 行/1.1GB 物化存量 + none 仅单日深度）——prod 序 = **先 backfill 补齐 none 历史**（读时换算唯一基底）→ `--factors` → 对拍 → 分批 DELETE（~4.95M 行）→ `VACUUM ANALYZE marketdata.daily_bar` + **冷启动回填顺序前置条件**（analyze M3）：corp 先于 eod 回填（或 eod 回填后补跑 `--factors`）——exDates 不在库则 backfill 锚定零版本、复权读退化 factor=1 → verify: 脚本 dry-run 形态 + runbook markdownlint 过 + 步骤含前置条件（none 历史前置 + 回填顺序 + 回填→对拍→删 顺序硬约束）
- [X] T014 [US3] [Verify] （impl 注 2026-06-05 走查记录：dev `.env` 是 `MARKETDATA_PROVIDER=mock` → 走查用**进程级 env 覆盖 live** 起 server（`.env` 未动）；序 = corp 回填（27 exDates 落库）→ eod 深回填 3650d（none 6,524 行单口径 + 因子 25 行随锚，未来 exDate 正确跳过）→ `--factors` 二次跑 digest 分毫不差（幂等 ✓）→ T013 留档（dev 仅 2 行 mock 时代物化行：forward 巧合相等 / backward ε=2.01e-1）→ **user 授权后**分批 DELETE 2→0 收敛 + VACUUM → 三口径手验（最新段 forward=none 恒等 + backward=none×1.2015 + 2017-07-07 exDate 跨段股息缺口被 forward 平滑）→ latency none ~19ms vs forward ~40ms 同量级）**dev 实操清退（runbook 走查）**：dev 库顺序执行 —— 新 `--factors` 回填 → T012 双判据门通过 + T013 口径差异报告留档 → **人工执行分批 DELETE**（stop signal 3：不可逆 op，user 亲自跑或明示授权）→ K线端点三口径手验（`GET /api/v1/marketdata/instruments/{symbol}/bars?adjust=forward|backward|none`，抽多次除权史标的）+ **SC-A05 latency spot-check**（analyze M1：同标的 forward 全历史请求计时 vs none 口径对照，量级一致即过——无需 perf 基建）→ verify: `adjust <> 'none'` 行数 = 0（SC-A01 终态）+ 三口径响应正常 + latency 对照量级一致 + 对拍报告留档 PR 描述
- [X] T015 [Verify] （impl 注：affected 链含 runtime-smoke 全绿 exit 0——首跑曾因 `| tail` 管道无法证真，重跑未管道化拿到 `Successfully ran targets lint, typecheck, test, build, runtime-smoke`；CLAUDE.md 指针留 020 plan 至下个 feature 接管）**终局门**：`pnpm exec nx affected -t lint typecheck test build --base=origin/main` 全绿（首跑 `--skip-nx-cache`）+ 016/019/020 marketdata IT 全量 + spec frontmatter `status: implemented` 翻转 + plan frontmatter `status: approved` + tasks.md 全 `[X]` 复核 + CLAUDE.md 指针确认 → PR-3 走 commit-push-pr + auto-merge

---

## Dependencies & 执行顺序

```text
PR-1: T001 [P] ∥ T002 → T003 → T004（T003 依赖 T002 纯函数；T001 独立可先跑——ε 只回填文档不阻塞 T002/T003 实现，但 STOP 条件必须在 T003 合入前裁决）
PR-2: T005 → T006 → T007 → T008 → T009 → T010 → T011（expand 先于新锚定写入；drop 必须最后——全仓零 factorForward 消费者后）
PR-3: T012 ∥ T013 → T014 → T015（T014 依赖 T009 的 --factors + T013 的脚本；DELETE 人工卡点）
跨片: 严格按 PR 序合入（读时换算先行是写收窄的承接前提；清退是终局动作）
```

- **MVP** = PR-1 + PR-2（读写闭环：存储 3 行 → 1 行 + 除权日 5 → 2 次请求全部兑现）；PR-3 是对拍终验 + 存储回收收尾
- 并行机会：T001∥T002、T012∥T013；其余串行（`dimension-executor.ts` / `adjustment-factor.rules.ts` 是 conflict 磁铁，per memory 串行处理）
- **Clear 检查点批次**（Constitution §III）：T001-T004 / T005-T008 / T009-T011 / T012-T015——每批次后停顿提醒 /clear

## 对齐 plan §Phase 2 落地序

| PR | tasks | spec 验收 |
| --- | --- | --- |
| PR-1 | T001–T004 | ε probe 三事实（D7 输入）+ US1 全 AS + SC-A04 none 逐字节等价 |
| PR-2 | T005–T011 | US2 全 AS + US3 AS-1/AS-2（冷启动）+ SC-A03 请求预算门 + SC-A01 写入收敛 |
| PR-3 | T012–T015 | SC-A02 对拍门（ε 判据终验）+ US3 AS-3/AS-4（清退）+ SC-A01 终态 + SC-A05 |
