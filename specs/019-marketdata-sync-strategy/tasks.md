---
feature_id: 019-marketdata-sync-strategy
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-05'
---

# Tasks: 019-marketdata-sync-strategy（声明式新鲜度 + 复权因子版本化 + 维度配置化）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `019-marketdata-sync-strategy`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 因子版本化 / US2 声明式新鲜度 / US3 维度配置化 / US4 SLA 监控 / US5 灰度切换）
- 层 = `[Server]` / `[Server-IT]` / `[Probe]` / `[Verify]`（纯 server，无新端点 → 无 [Contract]/[Mobile]，FR-S13）
- **Phase = PR 交付单元**（plan §Phase 2 六片；各自独立绿、渐进可回退）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；IT 蓝本 = `marketdata.dimension-worker.it.spec.ts`（executor 面）/ `marketdata.tick-driver.it.spec.ts`（tick 面）；run via `nx test server <file>`（cwd=apps/server）；本地 IT 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`
- 无 task-meta JSON（manual 模式，per 004-018）
- **clarify 五裁决**（2026-06-05，实现承重点）：① financial 日历源探测双轨（T001 定）；② 平淡日复权本地算补当夜落库；③ fundamental 保持日频；④ 不加 context 列；⑤ SLA 告警复用结构化 log
- **plan D1 spec 修正已落**：因子 = 价格比值锚定（`forward(d)/none(d)` 段内常数），**禁** dividend 公式派生（配股端点缺口）
- **D8 时序雷区**：hard 边 `corporate_action → eod_bar` **必须在 PR-3（T011）加**——PR-2 拓扑派生落地前加 = 倒流边 assembler throw 整夜瘫痪
- **analyze 修正已落**（C1/H1/M1/M2/M3，2026-06-05）：corp = **slow-drift 周扫不自我 gate**（自身物化日历 gate 自己 = 鸡生蛋饿死）；event-calendar live 行依 T001 探测结论（可能仅 financial 或暂无，机制照建测试维度验证）；T011 priority = financial 7（不动）/ corp 6 / eod 5
- **backfill 复权口径（tasks 阶段实现选择，随 T010 同 commit 微调 spec edge case 措辞）**：backfill 模式**保持 vendor 直拉 3 口径**（低频走权威，plan D3 精神）——「防回测漂移」由 vendor 历史正确口径直接满足；本地因子链只服务平淡日 delta 推导 + 对拍审计。冷启动因子锚定依赖 forward bar 在库 → 比值锚定无鸡生蛋问题的前提即 backfill 直拉
- **claim 零改动红线**（FR-S02）：`sync-tick-driver.ts` `claim()` L126-183 任何 task 不得触碰

## Path Conventions

- server：`apps/server/src/marketdata/`（ADR-0043 扁平平铺）；新文件 ≤4：`adjustment-factor.rules.ts` / `calendar-hit-check.ts` / `freshness-sla.check.ts` + 探测脚本（`scripts/diag/`，不入 src）；IT `apps/server/test/integration/marketdata.*.it.spec.ts`
- **spec drift 锚点（impl 前 grep 验真，per plan）**：① `runDimension` switch `dimension-executor.ts` L205-227 / `loadActiveInstruments` L242-248（tier 序**勿动**）；② `DIMENSION_EXECUTION_ORDER` `sync-flow-assembler.ts` L13-20 + hard 边相邻校验 L113-126；③ tick 链 `sync-tick-driver.ts` tick() L86-123（claim 零改动）；④ `reAdjustBars` L494-521 + `RE_ADJUST_TYPES` L37 + `upsertCorporateActions` 返 minNewExDate L460-487；⑤ seed 行 migration `20260603_0030` L71-79（新 seed 走新 migration **不改旧**，applied migration 改炸 checksum）；⑥ dividend adapter 仅 `status:implemented` 行过滤 L45；⑦ 灰度 flag 形态 `marketdata.config.ts`（tickEnabled 先例）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + migrate deploy（mbw-poc-postgres:5433 / redis:6380）
- ⚠️ 新 ts/spec 首跑带 `--skip-nx-cache`；迁移命名 per `migration-naming-check`

---

## Phase 1: PR-1 — env-gated 探测 + schema expand（foundational，无行为变化）

- [X] T001 [P] [Probe] **理杏仁三事实探测（D5 双轨判定输入）**：新脚本 `scripts/diag/lixinger-probe-019.ts`（tsx，读本地 `.env` `LIXINGER_TOKEN`，不入 src/ 不进 CI）——一次采齐：① **披露日历/公告类端点存在性**（试 `/cn/company/announcement` 等候选；404/无端点 → financial 锁 latest-scan fallback，有 → lixinger-disclosure 真日历）；② **fundamental/financial 批量上限实测**（stockCodes 数组逐步加大至 4xx/截断，记安全上限）；③ **「分红实施公告先于除权日」假设校真**（拉若干近期除权标的 dividend，验 `status:implemented` 行的 exDate 是否在公告后若干日才生效——D2 未来 exDate 可见性前提）→ verify: 三结论写入本文件本 task 行下方 + 贴 PR-1 描述；探测耗请求 ≤50（远低配额）。**结论同时回填 plan D5 选定列**
  - **探测三结论（2026-06-05 实测，23 请求）**：
    1. **① 无可用市场级披露日历端点 → financial 锁 slow-drift fallback**。`/cn/company/announcement` 存在但**仅单股 `stockCode`**（`stockCodes` 批量 → 400），返回混类型公告 PDF 列表（`types:['other','srp',…]`）非披露日历——逐股日扫 = 5,600 请求/日，违背 T013「轻量 1 次调用」判据，不可作 calendar_source；其余候选（`/announcements`/`/disclosure`/`/report-date`/`/financial-report-date`）全 404。→ T002 financial = `slow-drift` + calendar_source NULL；T015 financial 周二周扫；event-calendar 机制照建，IT 用测试维度验证。
    2. **② 批量安全上限 = 100**：fundamental `non_financial` size 100 → 200 OK（rows=99，单股缺数据非截断）；size 200 → HTTP 400。fs 端点 size 100 → 200 OK（rows=100）。→ T015 `batch_size` 1 → 100（fundamental 5,600 → 56 请求/日；financial 周扫 56 请求/次）。
    3. **③ D2 未来 exDate 可见性成立**：601318 `status:implemented` 行 exDate=2026-06-10（今日 2026-06-05 已可见，提前 ≥5 日），含 `registerDate`/`paymentDate`；预案行（`board_director_plan`/`shareholders_meeting_plan`）无 exDate 字段 → adapter L45 过滤正确。「分红实施公告先于除权日」假设校真通过。
- [X] T002 [Server] **schema expand migration（单迁移：3 列 + 新表 + 画像 seed 回填）**：`apps/server/prisma/migrations/<ts>_add_freshness_and_adjustment_factor/migration.sql` + `schema.prisma` —— ① `sync_dimension` 加 `freshness_profile VARCHAR(24) NOT NULL DEFAULT 'continuous-daily'` / `sla_hours INT NULL` / `calendar_source VARCHAR(32) NULL`；② 新表 `adjustment_factor`（`instrument_id BIGINT` / `ex_date DATE` / `factor_forward DECIMAL(18,8)` / `factor_backward DECIMAL(18,8)` / `created_at` / `uk(instrument_id, ex_date)`，Prisma model `AdjustmentFactor` @@schema("marketdata")）；③ seed UPDATE 回填（幂等）：universe/profile/**corporate_action** → `slow-drift`（corp 周扫即同步不自我 gate，analyze C1）、financial 按 T001 结论（有披露日历端点 → `event-calendar` + `calendar_source='lixinger-disclosure'`；无 → `slow-drift`、calendar_source NULL）、eod_bar/fundamental → `continuous-daily`（clarify ③ 日频保持）；`sla_hours` 初值：eod/fundamental 30、financial/corp 192（8 天 > 周扫节奏）、universe 192、profile NULL（不检查）。**不加依赖边（D8 雷区）、不改 cron（PR-4 才切扫描节奏）**——新列零消费者，行为零变化 → verify: migrate deploy + prisma generate + `nx test server`（016/017/018 marketdata IT 全量回归绿，首跑 `--skip-nx-cache`）
- [X] T003 [Verify] **PR-1 门**：`nx run server:typecheck` + `nx lint server` + marketdata IT 全量绿 + `migration-naming-check`（lefthook 自动）+ T001 三结论在 PR 描述 → commit-push-pr + auto-merge

---

## Phase 2: PR-2 — executor 注册表 + 全序拓扑派生（US3，行为保持重构）

- [X] T004 [US3] [Server] **runDimension switch → Map 注册表**：`apps/server/src/marketdata/dimension-executor.ts` —— L205-227 switch 退役，构造器组 `Map<DimensionKey, (input, dim?) => Promise<...>>`（universe/profile 包装 use case、4 fact 维度绑既有私有方法；tier 前置重算 L199 与 fact 维度载入逻辑位置不变）；`marketdata-trigger.cli.ts` / `marketdata-backfill.cli.ts` 维度键校验源改注册表 keys（grep 既有 enum 校验点）→ verify（行为保持，TDD：先加注册表路由单测红）: 既有 `marketdata.dimension-worker.it.spec.ts` 全量绿零改动 + 6 维度逐一路由断言 + 未注册 key 结构化报错（spec edge case「seed 行存在但 executor 未注册」→ 不崩 worker）
- [X] T005 [US3] [Server] **全序拓扑派生（常量退役 + priority 复现现行序）**：`apps/server/src/marketdata/sync-flow-assembler.ts` —— `DIMENSION_EXECUTION_ORDER` 常量退役 → `deriveExecutionOrder(edges, priorityByKey)`（Kahn 拓扑 + tie-break `priority` desc 再 key 字典序；环 → 复用 `assertAcyclic` fail-fast）；`assembleSyncFlow` 签名扩展接收派生序（tick driver 调用点已 load dimension 行可带 priority）；新 seed migration 调 priority 复现现行序：universe 10 / profile 9 / **fundamental 8 / financial 7 / eod_bar 6 / corporate_action 5**（现 seed eod=8>fund=7 与 017 常量序矛盾，调齐）→ verify（TDD）: **派生序 ≡ 旧常量序对拍断言**（`['universe','profile','fundamental','financial','eod_bar','corporate_action']`）+ 既有 hard 边（profile→fundamental）相邻校验照常 + 环注入 fail-fast 断言 + tick IT 回归绿
- [X] T006 [US3] [Server-IT] **SC-S05 测试维度注册演练**：IT 内注册临时测试 executor + 插临时 `sync_dimension` 行（IT 事务内，不进 seed）→ tick claim → 组 flow → worker 路由执行全链断言；演练结论（「加新维度 = 注册 + 一行 seed，零 switch/常量改动」）写 PR 描述 → verify: 新 IT 绿 + 临时行清理断言
- [X] T007 [Verify] **PR-2 门**：016/017/018 marketdata IT 全量回归（重构行为保持的硬门）+ typecheck/lint + 派生序对拍在场 → commit-push-pr + auto-merge

---

## Phase 3: PR-3 — 复权因子版本化（US1，eod 16,800→5,600）

- [X] T008 [US1] [Server] **因子比值锚定（rules 纯函数 + reAdjustBars 后写入）**：新文件 `apps/server/src/marketdata/adjustment-factor.rules.ts` —— 纯函数 `anchorFactors(noneBars, forwardBars, backwardBars, exDates): FactorVersion[]`（每段取段内最新交易日 `forward(d)/none(d)`、`backward(d)/none(d)`，`none=0`/缺行防御跳过；Decimal 运算用 Prisma.Decimal）；`dimension-executor.ts` `reAdjustBars` 成功后调锚定 + `adjustmentFactor.upsert`（uk 幂等，FR-S04）→ verify（TDD，新 spec `marketdata.adjustment-factor.it.spec.ts`，PG-only）: 新除权 → 因子版本写入（值 = mock vendor bars 比值）/ 同标的同除权日幂等 / 同日多事件单版本（spec edge case）/ none=0 防御
- [X] T009 [US1] [Server] **冷启动因子链回填**：`marketdata-backfill.cli.ts` 加 `--factors` 模式 —— 全 universe 扫已存 `corporateAction.exDate` 列表 + 已存 none/forward/backward bars，按段重建全因子链（`anchorFactors` 复用，零 vendor 外呼）；幂等可重跑（FR-S04 可重建性的执行载体）→ verify: IT seed 多段历史 bars + exDates → 回填 → 因子链全断言 + 二次跑零变更；CLI spec 扩展（`marketdata-backfill.cli.spec.ts`）
- [X] T010 [US1] [Server] **平淡日 eod 只拉 none + 本地推导当夜落库（核心杠杆）**：`dimension-executor.ts` `syncEodBars` 改造 —— 起手 **D2 除权命中检查**（本地查 `corporateAction.exDate ∈ (上次 eod 成功水位, asOf]` 的 instrumentId 集合，零外呼）；**delta 模式**：未命中标的只 fetch `none` + 本地算 forward/backward 行（`none × 最新因子`，查 `AdjustmentFactor` 最新版本组 Map 一次载入；无因子标的按 1，spec edge case 新上市）三口径同 tx 落库（clarify ② 当夜落库零缺口）；命中标的走既有全口径 fetch + `reAdjustBars` + T008 锚定；**backfill 模式：保持 vendor 直拉 3 口径不动**（header 口径选择）+ 随本 task 同 commit 微调 spec edge case「backfill 与因子交互」措辞为性质表述（vendor 历史口径天然无漂移）→ verify（TDD）: mock vendor 请求计数断言（平淡日 n 标的恰 n 次 getBars、零 forward/backward 外呼，SC-S01 机制半）+ **对拍门**（本地算三口径 = mock vendor 直拉值逐 Decimal 断言，SC-S02）+ 除权命中日仅命中标的走重拉 + 进度锚/截断/tier 序回归绿（FR-S10）；**体量标注（analyze M3）**：implement 时允许拆 T010a（命中检查 + none-only 拉取）/ T010b（本地推导 + 对拍 + backfill 口径）两 commit
- [X] T011 [US1] [Server] **hard 边 corp→eod + 派生序变更（D8 此时加）**：新 seed migration —— 插 `sync_dependency (corporate_action, eod_bar, 'hard')` + priority 调整 `corporate_action 6 / eod_bar 5`（financial 7 不动——**analyze H1**：原 corp 7/fin 6 会派生 `[…,corp,financial,eod]` 使 hard 边非相邻 throw；正确派生序 → `[universe, profile, fundamental, financial, corporate_action, eod_bar]`，**两条 hard 边均链相邻**）→ verify（TDD）: 派生序断言 + 全 won 链装配两 hard 边相邻可表达 + **corp 未 won 时 eod 照跑不阻塞**（hard 边仅同 won 生效，FR-S08）+ 除权日链序 IT（corp 先于 eod 执行 → 因子先写后用，SC-S04 端到端）
- [X] T012 [Verify] **PR-3 门**：SC-S02 对拍（mock 全样本 + **env-gated 真 vendor 抽样** `RUN_VENDOR_IT=1` gate，默认 skip per memory 先例）+ SC-S04 除权链路 + eod 请求数断言 + 016/017/018 全量回归 → commit-push-pr + auto-merge；**PR 描述 flag**：DailyBar 写路径变更属高敏感面，附对拍证据

---

## Phase 4: PR-4 — event-calendar 驱动（US2，脉冲降频）

- [X] T013 [P] [US2] [Server] **CalendarHitCheck（纯函数 + source 路由）**：新文件 `apps/server/src/marketdata/calendar-hit-check.ts` —— 按 `calendar_source` 路由（**analyze C1**：slow-drift 维度不经此检查，corp 周扫不自我 gate）：`'lixinger-disclosure'` = vendor 披露日历端点 adapter 轻量 1 次调用（T001 探测无端点则本 source 暂无 live 行——机制照建，IT 用测试维度验证）；未知 source / NULL → 按未命中 + WARN（防御，spec edge case「executor 未注册」同精神）→ verify（TDD，纯函数单测 + PG IT）: source 命中/未命中断言（测试维度）+ 日历检查自身失败（端点超时注入）→ 按未命中 + 告警不阻塞（spec edge case）
- [X] T014 [US2] [Server] **tick freshness gate（D6 落点）**：`apps/server/src/marketdata/sync-tick-driver.ts` `tick()` —— 交易日 gate 之后、组 flow 之前插分流：fireNow 中 `freshness_profile='event-calendar'` 维度逐个跑 `CalendarHitCheck`，未命中 → 剔除出组 flow 集 + `SyncRun` 写 `status='skipped'` 行（含跳过原因，复用 `SyncRunRecorder`，FR-S03 审计痕）；continuous-daily/slow-drift 直通；**claim() 零改动（红线）**→ verify（TDD，扩展 `marketdata.tick-driver.it.spec.ts`）: event-calendar 平淡日 tick → 零 vendor 外呼 + skipped 审计行 + next_fire_at 已推进（claim 既有）；命中日 → 组 flow 正常执行仅命中范围；混合 won 集（命中+未命中+continuous）→ 链装配只含应跑维度；claim 行为回归断言（FR-S02）；**paused_until 优先级断言**（paused 维度无论画像不执行，FR-S10/analyze M2）；event-calendar live 行依 T001 结论可能暂无 → IT 用测试维度行验证机制（不依赖 live seed）
- [X] T015 [US2] [Server] **扫描节奏 + 批量调大 seed migration**：新 seed migration —— ① corporate_action `cron_expr` 改周频扫描（周一 `0 0 22 * * 1`，slow-drift 扫描即同步，analyze C1）；financial 按 T001 结论：disclosure 形态 → 保持日频 cron（日历检查命中才真同步）/ fallback 形态 → 周二周扫 `0 0 22 * * 2`（错峰）；② fundamental/financial `batch_size` 1 → T001 实测安全上限（预算账 fundamental 5,600→~200 的载体）→ verify: IT 断言 fundamental 批量分块请求数 = ceil(n/batch)（mock vendor 计数）+ **未来 exDate 物化在场断言**（corp 扫描 upsert 后 `exDate > asOf` 行可查——D2 前提，adapter `status:implemented` 行已含未来 exDate per T001 ③ 校真）
- [X] T016 [Verify] **PR-4 门**：SC-S03 脉冲零外呼门（平淡日 financial/corp 零 vendor 数据外呼 IT）+ 命中日组 flow + skipped 审计 + 016/017/018 全量回归 → commit-push-pr + auto-merge

---

## Phase 5: PR-5 — 新鲜度 SLA 监控（US4）

- [X] T017 [US4] [Server] **每日 SLA 检查 + 结构化告警（D9）**：新文件 `apps/server/src/marketdata/freshness-sla.check.ts` —— `@Injectable` + `@Cron('0 30 8 * * *', tz Asia/Shanghai)`（盘后窗口尾）：扫 `sla_hours NOT NULL` 维度，stale 基准 = `SyncRun` 该维度最近 `success|partial|skipped` 行 finishedAt（skipped 视同按日历正常，FR-S09）按**交易日历折算**逾期（休市不计龄，复用 `TRADING_CALENDAR_PORT`）；超期 → 结构化 ERROR log（维度名/最后成功时间/SLA 阈值，`alertIfDegraded` 同形态，clarify ⑤）；每日一次天然不重复告警；`marketdata.module.ts` 注册 → verify（TDD，新 spec `marketdata.freshness-sla.it.spec.ts`）: SC-S06 四态——超期告警字段齐 / event-calendar skipped 不误报 / 休市长假不误报 / 恢复后不再告警
- [X] T018 [Verify] **PR-5 门**：SC-S06 四态 IT 绿 + 全量回归 + typecheck/lint → commit-push-pr + auto-merge

---

## Phase 6: PR-6 — 灰度切换 + 配额账实测（US5）

- [X] T019 [US5] [Server-IT] **退化态等价 + 整夜端到端**：① **SC-S08 退化态门**——IT 全维度临时翻回 `continuous-daily` → 整夜模拟（tick→flow→执行）请求序列 + SyncRun 审计行与 017 现状对拍等价（FR-S11 可回退证据）；② **画像混合态整夜端到端**——三类画像混合 + 除权命中 + 预算截断 + 顺延续跑全链一夜模拟（018 T007 蓝本扩展）：脉冲跳过审计在场、eod 只拉 none、因子链正确、tier 序保持 → verify: 两 IT 绿（run via `nx test server <file>` `--skip-nx-cache`）
- [X] T020 [US5] [Server] **灰度 runbook + prod 翻转步骤**：`docs/private/plans/2026-06/<MM-DD>-sync-strategy-graying-runbook.md`（017 `06-04-scheduler-tick-graying-runbook.md` 蓝本）—— 画像逐维度翻转 SQL（先 financial → corp → 观察各一周）/ 回退 SQL（翻回 continuous-daily 一条 UPDATE）/ 观察指标（SyncRun skipped 行、夜间请求计数、SLA 告警零误报）/ **SC-S01 实测口径**：prod 稳态平淡日 vendor 请求数 ≤6,000 的取数方法（SyncRun scanned 合计 + log 计数）→ verify: runbook 过 markdownlint + 步骤含回退路径
- [X] T021 [Verify] **终局门**：`pnpm exec nx affected -t lint typecheck test build --base=origin/main` 全绿（首跑 `--skip-nx-cache`）+ 016/017/018/019 marketdata IT 全量 + spec frontmatter `status: implemented` 翻转 + plan frontmatter `status: approved` + tasks.md 全 `[X]` 复核 + CLAUDE.md 指针确认 → PR-6 走 commit-push-pr + auto-merge；**prod 画像实际翻转（灰度执行）是 merge 后运维动作，按 T020 runbook 人工执行，不在本 feature 代码面**

---

## Dependencies & 执行顺序

```text
PR-1: T001 [P] ∥ T002 → T003（T002 的 calendar_source 回填值依赖 T001 结论 → T001 先跑或同 task 内先后）
PR-2: T004 → T005 → T006 → T007（T005 改 assembler 依赖 T004 注册表形态；T006 演练依赖两者）
PR-3: T008 → T009 → T010 → T011 → T012（锚定是回填/推导前提；hard 边最后加，D8）
PR-4: T013 [P] ∥ T015 → T014 → T016（gate 依赖 CalendarHitCheck；seed 与纯函数无依赖可并行）
PR-5: T017 → T018
PR-6: T019 → T020 → T021
跨片: 严格按 PR 序合入（PR-2 拓扑派生是 PR-3 hard 边的前提；PR-3 因子是 PR-4 脉冲降频预算账的另一半）
```

- **MVP** = PR-1 + PR-2 + PR-3（US1 兑现：eod 16,800→5,600，单项 -2/3 即日增量 1.1h→~22min 主体）；PR-4 把脉冲维度归零补足预算账
- 并行机会：T001∥T002、T013∥T015；其余串行（`dimension-executor.ts` / `sync-flow-assembler.ts` / `sync-tick-driver.ts` 是 conflict 磁铁，per memory 串行处理）
- **Clear 检查点批次**（Constitution §III）：T001-T003 / T004-T007 / T008-T010 / T011-T012 / T013-T016 / T017-T018 / T19-T021——每批次后停顿提醒 /clear

## 对齐 plan §Phase 2 落地序

| PR | tasks | spec 验收 |
| --- | --- | --- |
| PR-1 | T001–T003 | 探测三事实（D5 输入）+ schema 回归门 |
| PR-2 | T004–T007 | SC-S05（配置化门）+ 行为保持回归 |
| PR-3 | T008–T012 | SC-S02（对拍门）+ SC-S04（除权链路门）+ eod 请求数 |
| PR-4 | T013–T016 | SC-S03（脉冲零外呼门） |
| PR-5 | T017–T018 | SC-S06（SLA 四态门） |
| PR-6 | T019–T021 | SC-S01（配额账实测口径）+ SC-S07（回归门）+ SC-S08（退化态等价门） |
