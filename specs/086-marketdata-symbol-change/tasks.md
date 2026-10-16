---
feature_id: 086-marketdata-symbol-change
spec_ref: ./spec.md
plan_ref: ./plan.md
status: tasks-ready
created_at: '2026-10-16'
updated_at: '2026-10-16'
---

# Tasks: 086-marketdata-symbol-change（标的代码变更登记）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md)

**一句话**：marketdata 新增代码变更登记与 lineage 纯函数，日线入口按登记读时拼接；optionsdesk 新增迁锚、疑似改名候选和一个 CLI，把「登记 / 迁锚 / 驳回待审提交 / 采集范围 / 验证」五步串成一条命令；ops 脚本负责预览与复述闸。

> 2026-10-16 analyze 后修订：F1 新增 T004（同步补齐标的行）；F3 新增 T013（港股 / A 股旧码采集取证）；F5 把原「编排」与「候选」两个大 task 各拆成两个；F2 / F6 改写对应 task 的做法与 verify。编号已整体重排。

## Format

`- [ ] TNNN [P?] [层级] [USn] **标题**（FR-xxx; plan Dx; state_branches n）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 即其验收，红 → 绿在同一 task 内闭环（Constitution §II）；新测试必须**定向变异证明能红**并留档。
- 层级：`[Server]` / `[Server-IT]` / `[Ops]` / `[Gate]`。本片无 `[Contract]` / `[Mobile]` / `[Shim]`（零 endpoint、零 DTO、零 UI；shim 侧改动已在 PR #495）。
- `state_branches n` = spec frontmatter `state_branches` 的**行序号**（1 起）。FR / SC 逐条枚举，不用范围记法。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 登记表 / 迁移 | `apps/server/prisma/schema.prisma` + 迁移目录 `apps/server/prisma/migrations/`；生成迁移一律 `pnpm db:migrate "<描述>"`（`scripts/prisma-migrate.ts`，ADR-0035 命名）；部分唯一索引写法先例 `migrations/20260916_2022_add_broker_push_gap_reentry_index/migration.sql` |
| lineage 纯函数（新） | `apps/server/src/marketdata/symbol-lineage.rules.ts`（+ `.spec.ts`） |
| marketdata use case（新） | `apps/server/src/marketdata/{register,revoke}-symbol-change.usecase.ts` · `ensure-instrument.usecase.ts` |
| 标的行 seed（复用） | `marketdata/sync-universe.usecase.ts` 的 `seedInstrumentCreateData`；冷启动同源 upsert `anchor-cold-start.usecase.ts:413` |
| 日线拼接点（改） | `apps/server/src/marketdata/get-instrument-bars.usecase.ts`（解析 `:47` · 取 bar `:61` · 取因子 `:83`） |
| IV 核对点（改） | `apps/server/src/marketdata/dimension-executor.ts`（`crossCheckIvPercentile` `:3333-3340`） |
| 实时报价端口（改） | `marketdata/realtime-quote.port.ts:117` · `futu-realtime-quote.adapter.ts:93` · `market-routed-realtime-quote.adapter.ts:41` |
| marketdata 装配（改） | `marketdata/marketdata.module.ts`（providers `:702` · exports `:892` 起） |
| 迁锚 / 编排 / 候选（新） | `apps/server/src/optionsdesk/{migrate-anchor-ticker,remediate-symbol-change,resolve-symbol-candidate}.usecase.ts` · `symbol-candidate.rules.ts`（+ `.spec.ts`）· `symbol-change.cli.ts` |
| optionsdesk 触碰 | `sync-anchor-last-close.ts:293` · `sync-anchor-intraday.ts:360` · `optionsdesk.module.ts` |
| 既有可复用 | `reject-anchor-submissions.usecase.ts:30` · `review-anchor.usecase.ts:69`（`isAnchorOverdue`）· `list-anchors.usecase.ts:110`（逾期判定的 `today` = 上海日）· `anchor-history.ts:35` · `create-anchor.usecase.ts:236,317`（锚创建事件）· `anchor-driven-sync-gate.ts:79` |
| CLI 启动先例 | `apps/server/src/marketdata/marketdata-trigger.cli.ts:329-366` |
| ops（新 / 改） | `ops/bin/symbol-change.sh`（复述闸先例 `ops/bin/anchor-approve.sh:294-334`）· `ops/jobs/app-state-health.sql` |
| 护城河 | `scripts/checks/check-server-moat.ts`（`MODEL_OWNERSHIP` · `WRITE_ALLOWLIST.anchor` `:248-262`） |
| IT（新 / 改） | `apps/server/test/integration/{marketdata-086.bars-splice,optionsdesk-086.remediate,optionsdesk-086.candidate}.it.spec.ts`（隔离库 `test/_support/isolated-db.ts` `setupIsolatedDb`，会跑全部迁移）· `app-state-health.it.spec.ts`（扩） |

## Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **两条时间轴别混**：登记的生效日是**交易所当地日历日**，与 `daily_bar.trade_date` 同轴（ADR-0066）；锚的复核逾期按**上海日**判（`list-anchors.usecase.ts:110`），所以迁锚写 `next_review` 用上海日的昨天。`check-time-semantics.ts` 只拦一部分形态，差一天不会红。
2. **回收防误拼的下界**：查询码的末段起点不早于「它作为旧码被改走的最晚生效日」。漏掉这一条时 PARA 类查询会把改名前那家公司的历史拼进来，不报错，只是数字悄悄变错。
3. **无登记 ⇒ 逐条一致**（FR-007 / SC-003）：拼接改动必须有「无登记 fixture 上新旧结果深等」的反例臂，否则任何漏判都不会显形。
4. **迁锚同 tx 四件事**：conditional UPDATE（affected-count）+ `anchor_change` 痕迹 + 清空旧码价格列 + outbox 事件。旧价格列不清空的话，新码锚会带着旧码最后一个价进雷达排序，直到下一拍才被覆盖。
5. **新码标的行同步补齐，不靠冷启动事件**：冷启动走 outbox 异步，重算采集闸若先于它执行，新码不会被纳入采集，验证一步才报失败（analyze F1）。
6. **编排在 optionsdesk、不在 marketdata**：marketdata 不能 import optionsdesk（eslint `apps/server/eslint.config.mjs:190-203` 拦）。跨 ctx 注入点各带 `// CROSS-CONTEXT-SYNC:`（`check-server-moat.ts` Check 2 拦）。
7. **CLI 在 prod 只用 `docker compose run --rm`**，不 `docker exec` 进 app 容器（共用 640m cgroup，一次 AppModule boot 实测吃宿主约 230MiB，维护者 2026-09-15 #439 处置记录）。
8. **fixture 用合成代码**（`AAA` / `BBB` / `CCC` 一类），不用真实持仓或交易数据；PSKY / SKYD / PARA 是公开行情事件，可作为 IT 场景名，但数值一律合成。
9. **新文件首跑带 `--skip-nx-cache`**（`implement-task-closure.md`）。

## Tasks

### Foundational：登记表、连续身份规则、标的行补齐

- [X] T001 [Server] **`symbol_change` 表 + 迁移 + 护城河登记**（FR-001, FR-002, FR-003; plan D1, D10）：`schema.prisma` 新增 `SymbolChange` model（schema `marketdata`；字段按 plan D1；`effectiveDate @db.Date`）；`pnpm db:migrate "create symbol change"` 生成迁移，在生成的 `migration.sql` 里手写部分唯一索引 `(market, old_code, effective_date) WHERE revoked_at IS NULL`（写法照 Path Conventions 的先例）；`check-server-moat.ts` 的 `MODEL_OWNERSHIP` 加 `symbolChange: 'marketdata'` → verify: `pnpm tsx scripts/checks/check-server-moat.ts` 绿；迁移由 T005 的 IT（`setupIsolatedDb` 跑全部迁移）实际 apply；定向变异：删掉 ownership 一行 → moat 红（留档）

- [X] T002 [P] [Server] **`symbol-lineage.rules.ts`：`resolveLineage` + `validateRegistration`**（FR-002, FR-005, FR-008; plan D2; state_branches 4, 5, 6, 7, 9, 10, 11）：纯函数，入参为登记数组（已过滤撤销）、市场、代码、交易所当地「今天」。实现 plan D2 的回溯与两条下界；校验拒绝：旧码 = 新码、生效日 > 今天、同 `(market, old, effective)` 重复、成环、与已有段区间重叠；事件类型只接受 `rename`（branch 11）。docblock 写复杂度 O(链长 × n) → verify: `pnpm nx test server src/marketdata/symbol-lineage.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 单次改名 ⇒ 两段且边界 = 生效日 ② 链式 A → B → C ⇒ 三段（branch 6）③ 改回原码 A → B → A（日期递增）⇒ 合法、段归属正确 ④ 回收：A → B @ D 后查 A ⇒ 只有 `[D, ∞)` 一段（branch 4、5）⑤ 新码 D 前有自有数据 ⇒ 新码段起点仍为 D（branch 7）⑥ 无登记 ⇒ 单段无下界 ⑦ 四类拒绝各一条（branch 9、10）⑧ 非 `rename` 类型拒绝（branch 11）⑨ 成环 / 区间重叠拒绝；定向变异：a. 去掉回收下界 → ④ 红 · b. 生效日比较改 `<=` → ① 边界臂红（留档）

- [X] T003 [Server] **登记 / 撤销 use case + marketdata exports**（FR-001, FR-002, FR-003, FR-009; plan D1, D5）：`register-symbol-change.usecase.ts`（读未撤销登记 → `validateRegistration` → 插入；P2002 折叠为「已存在」供编排判跳过）、`revoke-symbol-change.usecase.ts`（conditional UPDATE `revoked_at IS NULL` → 写撤销人 / 理由；已撤销 ⇒ 返回「已撤销」）、`list` 只读方法（含已撤销，FR-009）。`marketdata.module.ts` exports 加这两个 use case + `AnchorDrivenSyncGate` + `GetInstrumentBarsUseCase` → verify: 臂并入 T005 的 IT 文件（登记 → 读 → 撤销 → 重登记同参数成功）；`pnpm nx run server:typecheck` 绿；boot 冒烟留给 T021 的 `runtime-smoke`

- [X] T004 [P] [Server] **`EnsureInstrumentUseCase`：同步补齐标的行**（FR-011; plan D5 第 4 步; state_branches 16）：新建 `marketdata/ensure-instrument.usecase.ts`，`execute(market, code)`：已存在 ⇒ 返回 `existed`；不存在 ⇒ 用 `seedInstrumentCreateData`（`sync-universe.usecase.ts`）`upsert`，返回 `created`。加进 marketdata exports → verify: T005 的 IT 文件加臂：① 不存在 ⇒ 建行且字段与 `seedInstrumentCreateData` 一致 ② 存在 ⇒ 零写入 ③ 并发两次 ⇒ 一行（upsert 天然幂等）；定向变异：改用 `create` → ③ 红（P2002，留档）
- [X] T023 [Server] **冷启动 seedInstrument 并发 P2002 兜底**（FR-011; plan D5 第 4 步）：anchor-cold-start.usecase.ts 的 seedInstrument 与 T004 同形，并发 upsert 后到一路抛 P2002；改为捕获 P2002 后重读 → verify: 并发臂（两路同时 seed 同一码 ⇒ 都成功、一行）先红 → 绿；定向变异：catch 里 rethrow → 红（留档）

### US1（P1）：登记改名后新码名下看到完整历史

- [X] T005 [Server] [US1] **日线读时拼接**（FR-003, FR-004, FR-006, FR-007; plan D3; state_branches 1, 2, 3, 8; SC-003, SC-004）：`get-instrument-bars.usecase.ts:47` 起改为 lineage → 每段解析 instrument（不存在则跳过该段）→ 段区间 ∩ 查询窗 → 分段取 `daily_bar` 并按日期拼接；`:83` 的因子改为取所有段 instrument 的、`exDate` 落在本段区间内的版本，合并后交 `deriveAdjustedBars`。`freshnessTier` / `asOf` 逻辑不动 → verify: 新建 `apps/server/test/integration/marketdata-086.bars-splice.it.spec.ts`（`setupIsolatedDb`），先红 → 绿，臂：① 登记后查新码 ⇒ 旧段 + 新段连续、无重复（branch 1、2）② 无登记 ⇒ 与改动前实现结果**深等**（branch 3；同 fixture 跑两遍对比）③ 撤销后 ⇒ 与 ② 深等（branch 8；SC-004 即时生效）④ 生效日落在周末 ⇒ 前一个交易日属旧段、下一个交易日属新段 ⑤ `adjust=forward` 时跨段因子正确应用 ⑥ T003 / T004 的臂；定向变异：a. 拼接时不切段（整段取旧码）→ ① 出现重复日红 · b. 跳过 lineage 直接走原路径 → ① 红（留档）

- [X] T006 [P] [Server] [US1] **IV 交叉核对读时拼接**（FR-004; plan D4）：`dimension-executor.ts:3340` 的 `underlyingIvHistory.findMany({instrumentId})` 改为按 lineage 分段取、拼接后取最近 252 条（`underlying-iv.rules.ts:50`）。只影响核对日志，上屏值不变（spec Q3 amend）→ verify: 实施时 `rg -n 'crossCheckIvPercentile' apps/server/src apps/server/test` 定位既有用例所在 spec，在该文件加臂：改名后旧段 200 条 + 新段 60 条 ⇒ 不再报 `insufficient_window`；无登记 ⇒ 行为不变；定向变异：只取新段 → 第一臂红（留档）

### US2（P1）：代码回收不被误拼

- [X] T007 [Server-IT] [US2] **回收场景端到端**（FR-005; plan D2, D3; state_branches 4, 5; SC-002）：在 T005 的 IT 文件追加回收 fixture：A → B @ D 已登记，A 在 D 之后另有一家公司的 bar → verify: 臂：① 查 B ⇒ 序列里没有任何一天来自「A 在 D 之后」② 查 A ⇒ 只有 D 之后的 bar；SC-002 判据 = 两个序列的交叉日数为 0；定向变异：去掉 T002 的回收下界 → ② 红（留档）

### US3（P2）：估值锚随改名延续

- [X] T008 [Server] [US3] **核对锚创建事件对重复投递的幂等性（决定复用或改专用事件）**（FR-017; plan D5）：读 `marketdata/anchor-cold-start.subscriber.ts` 与 `optionsdesk/broker-history-backfill.subscriber.ts:44`，判定「同一 ticker 第二次收到 `optionsdesk.anchor-created`」时两者的行为 → verify: 结论写进本行（复用 / 专用事件 + 判据的代码行号）；若需改专用事件，在本 task 内新增事件名与两个订阅者的注册，并在各自 spec 补「迁锚事件」臂；**这是 T009 的前置**；→ 结论：**复用 `optionsdesk.anchor-created`，不改专用事件，零代码改动**。两个订阅者都不把 `anchorId` 当去重键，二次投递（含 apply → revert → 再 apply）无害：① 冷启动 `anchor-cold-start.subscriber.ts:55-72` 只校验后入队，`marketdata-sync.queue.ts:284-291` 入队不带 `jobId`（BullMQ 不按 anchorId 去重，不会静默丢）；job 内 `anchor-cold-start.usecase.ts:173-175` 按「该 ticker 在目标交易日数据是否已具备」起手复判，已具备 ⇒ `already_present` 零外呼；结局行 `:518-523` 按 `anchorId` 覆盖式 upsert，迁锚复用同一 id 只会把旧码结局覆盖成新码结局（FR-026 本就只留最近一次）。② 券商回补 `broker-history-backfill.subscriber.ts:76-86` 去重键是 `(connection_id, source_event_id)`，每次迁锚发的是新事件 ⇒ 会再插一条 `backfill` 待执行记录；执行侧写入全是 `createMany({ skipDuplicates })`（`sync-broker-account.usecase.ts:417,463,537`），重复回补只多一次券商调用、不重复落数。revert 不发事件（旧码数据本已在库）。

- [X] T009 [Server] [US3] **迁锚 use case**（FR-014, FR-017; plan D5; state_branches 17, 19, 20）：新建 `migrate-anchor-ticker.usecase.ts`，同 tx：conditional UPDATE `where {ticker: old}`（count === 0 ⇒ 「旧码无锚」）且新码无锚（有 ⇒ 返回冲突，不写）；`ticker` → 新码、`next_review` → **上海日的昨天**（与 `list-anchors.usecase.ts:110` 的 `today` 同轴）、`last_close` / `last_close_date` / `intraday_*` → null；写 `anchor_change`（`changedFields: ['ticker', 'nextReview']`，before 值保留原 `next_review` 供撤销）；发布 T008 定下的事件。`check-server-moat.ts` `WRITE_ALLOWLIST.anchor` 加本文件；同文件提供 `revert`（新码 → 旧码、恢复原 `next_review`）供 T012 → verify: 新建 `apps/server/test/integration/optionsdesk-086.remediate.it.spec.ts`，先红 → 绿，臂：① 旧码有锚、新码无锚 ⇒ 锚在新码名下、`isAnchorOverdue` 为真、痕迹可查（branch 19）② 新码已有锚 ⇒ 冲突、零写入（branch 17）③ 迁移后调既有 `review-anchor` ⇒ 不再逾期（branch 20）④ outbox 有一条事件且与写同 tx（构造事件写失败 ⇒ 锚未迁）⑤ revert ⇒ 回旧码、`next_review` 恢复 ⑥ 时间轴臂：注入时钟取上海 00:30（美东仍是前一日）⇒ 迁移后立即逾期；定向变异：a. 去掉新码冲突判定 → ② 红 · b. 不清价格列 → 断言新码锚 `last_close` 为 null 的臂红 · c. `next_review` 改用交易所当地日 → ⑥ 红（留档）

### US5（P1）：一条命令完成改名后的全部修正

- [X] T010 [Server] [US5] **修正编排骨架：报告、预览、幂等跳过、失败即停**（FR-012, FR-013; plan D5; state_branches 12, 14, 15; SC-007）：新建 `remediate-symbol-change.usecase.ts`。`execute({…, mode: 'preview' | 'apply'})` 依次跑一个「步骤」数组，每步实现 `inspect()`（只读，判已完成 / 将要做什么）与 `apply()`；返回 `[{step, status: ok|skipped|failed|conflict, detail}]`。preview 只调 `inspect`；apply 中 `inspect` 判已完成 ⇒ `skipped`；任一步失败 ⇒ 停、后续不跑。本 task 用两个桩步骤验证骨架，五个真步骤在 T011 接入 → verify: `optionsdesk-086.remediate.it.spec.ts` 追加，臂：① preview ⇒ 全库行数与 `updated_at` 不变（branch 12）② 桩步骤 2 失败 ⇒ 停在 2，修复后重跑 ⇒ 1 `skipped`、2 起继续（branch 14）③ 连跑两次 ⇒ 第二次全 `skipped`（branch 15、SC-007）；定向变异：a. 去掉「已完成 ⇒ skipped」→ ③ 红 · b. preview 误调 `apply` → ① 红（留档）

- [X] T011 [Server] [US5] **五个真步骤接入编排**（FR-011, FR-014; plan D5; state_branches 13, 16）：在 T010 的骨架上接入：① 登记（T003）② 迁锚（T009）③ 驳回待审提交（读旧码 PENDING → `RejectAnchorSubmissionsUseCase`，理由含新码）④ 采集范围（先 `EnsureInstrumentUseCase` 同步补齐，再 `AnchorDrivenSyncGate.recalcSafely()`；hk / cn 一步按 T013 结论：不写 `needSync` / `sync_blacklist`，只在报告写明采集范围不随锚变化）⑤ 验证（按交易日历算新码 lineage 序列缺口数）。跨 ctx 注入点各带 `// CROSS-CONTEXT-SYNC:` → verify: 同 IT 文件追加：① apply ⇒ 五步 `ok`（branch 13）② 新码不在标的表 ⇒ 第 4 步结束时标的行已存在且 `need_sync` 为真，**不依赖冷启动是否已跑**（用 `test/_support/cold-start-stub.ts` 让冷启动不执行，branch 16）③ 旧码有 PENDING 提交 ⇒ 被驳回且理由含新码 ④ 第 5 步报告含首末日期与缺口数；`check-server-moat.ts` 绿；定向变异：去掉第 4 步的 `EnsureInstrumentUseCase` 调用 → ② 红（留档）；→ 实现：五个步骤类同在 `optionsdesk/remediate-symbol-change.steps.ts`，`optionsdesk.module.ts` 以 `useFactory` 按序装进 `REMEDIATION_STEPS`。第 5 步不判「已完成」（每次 apply 都重验，重跑时前四步 `skipped`、验证 `ok`）；硬失败只有「旧码仍有锚 / 新码标的行不在 / us 且新码有锚但 `need_sync` 非真」，复核逾期与缺口数是报告项（复核过的锚重跑不应判失败）。② 的「冷启动不执行」由装配保证：IT 不起 relay / worker，迁锚事件只落 `outbox_event` 无人消费，故未引入冷启动桩。IT 17/17 绿；变异（第 4 步不调 `EnsureInstrumentUseCase`）⇒ ①② 红、15 绿；`check-server-moat.ts` 绿。

- [X] T012 [Server] [US5] **撤销编排**（FR-015, FR-017; plan D5; state_branches 18）：同文件新增 `revert` 模式：逆序 —— 迁锚 revert → 撤销登记 → 重算采集闸（T013 结论不引入 `sync_blacklist`，撤销无需删除）；驳回的提交不复原、补齐的标的行不删，报告写明 → verify: 同 IT 文件追加：① apply 后 revert ⇒ 登记已撤销、锚回旧码且复核状态复原、采集闸复原（branch 18）② revert 两次 ⇒ 第二次全 `skipped`；定向变异：漏掉撤销登记一步 → ① 红（留档）；→ 实现：编排入参加 `direction: 'remediate' | 'revert'`（缺省 `remediate`；`mode` 仍管预览 / 写入，撤销同样默认预览），撤销步骤走第二个 DI token `REMEDIATION_REVERT_STEPS`，顺序由 `remediate-symbol-change.steps.ts` 的 `revertStepsOf` 钉死（生产装配与 IT 共用）：`revert-migrate-anchor` → `revoke-registration` → `recalc-sync-gate` → `restore-submissions`（恒 `skipped`，报告「驳回的待审提交不复原」）；采集闸一步的报告写明「补齐的新码标的行不删」，hk / cn 恒 `skipped`。撤销登记的理由取入参 `evidence`。IT 19/19 绿；变异（`revertStepsOf` 去掉撤销登记）⇒ ①② 红、17 绿。

- [X] T013 [Server] [US5] **取证：港股 / A 股旧码留在采集范围会不会拖垮同批采集**（FR-011; plan D5 第 4 步; spec Edge Case「港股 / A 股的旧码采集范围」）：港股 / A 股标的默认全量采集（`sync-universe.usecase.ts:164`），不受锚驱动（`anchor-driven-sync-gate.ts:18`）。逐个查这两个市场每个采集维度的 vendor 调用，对「代码已不存在」的处理：整批失败、单只跳过，还是返回空。证据优先读代码，必要时用 `nvy-guest-channel` 对一个已退市的港股代码做一次只读请求 → verify: 结论写进本行（每个维度：批量 / 单只、对未知代码的行为、代码行号或观测值）。有任一维度会整批失败 ⇒ 在 T011 的第 4 步追加「旧码写入 `sync_blacklist`」，在 T012 的撤销里删除，并给两处各补一条 IT 臂；全部无害 ⇒ 第 4 步只在报告里写明「该市场采集范围不随锚变化」；→ 结论（先只读代码取证，下列「未验证」两处已由 2026-10-16 prod 实测补齐，见末尾 **prod 实测** 与 **判定**）：**前提**：hk / cn 工作集 = `status = active ∧ needSync`（`dimension-executor.ts:381-385`）。锚作用域维度（`hk_option_contract` / `hk_option_daily_snapshot` / `hk_underlying_iv_daily` / `hk_option_oi_settle`，`anchor-scoped-dimensions.rules.ts`）与 `hk_earnings_date`（`sync-earnings-dates.usecase.ts:838` 只取 hk 锚）随锚走，迁锚后旧码自动退出 ⇒ 无害。**单只调用 + 单只 try/catch（未知代码最坏 = 该只 failed，同批其余照跑）**：`eod_bar` `dimension-executor.ts:1252-1283` · `corporate_action` `:2990-3010` · `short_selling` `:1516-1545` · `buyback` `:1593-1627` · `equity_change` `:1674-1704` · `shareholder_change` `:1751-1782` · `allotment` `:1832-1861` · `revenue_segment` `:1909-1942` · `shareholder_snapshot` `:1995-2026` · `employee` `:2081-2113` · `connect_holding` `:2155-2183` · `volatility` `:2234-2268` · `hot_snapshot` `:2316-2350`（`stockCodes` 只放单只）· `fund_holding` `:2389-2419` · `fund_company_holding` `:2443-2474` · `index_membership` `:2502-2531` · `industry_classification` `:2564-2594` · `announcement` `:2645-2678` · `fundamental` / `financial` 的 backfill 分支 `:2825-2854` / `:2948-2971`。**批量（一批 100 只，`migrations/20260605_0450_set_scan_cadence_and_batch_size/migration.sql:15-16`）**：`fundamental` delta `:2754-2785`（`lixinger-fundamental.adapter.ts:113-121` 整组 `stockCodes` 一次 POST）、`financial` delta `:2895-2926`（`lixinger-financials.adapter.ts:95-96`）；catch 在批级 ⇒ vendor 若因未知代码整请求报错，**整批 100 只记 failed**；vendor 若只是不返该码 ⇒ 无害（adapter 按 `stockCode` 回映，`lixinger-fundamental.adapter.ts:122-125`）。两种哪一种未验证（仓内批量相关实测只有「size 200 → HTTP 400」，与未知代码无关）。熔断不受牵连：4xx 与 200 + 应用层错都不计入 `ConsecutiveBreaker`（`vendor-http-client.ts:257`）。`profile` 只取 `lixingerCompanyType` 为空的行（`sync-profile.usecase.ts:53`），旧码已有缓存通常不入批；入批时同为批级 catch（`:67-90`），条件同上。**另一发现**：`sync_blacklist` 只在 universe 写入时挡新建（`sync-universe.usecase.ts:39-46`），工作集查询不读它（`dimension-executor.ts:381-385`）⇒ 给已存在的旧码行写黑名单**不会**把它移出任何维度；能移出的杠杆是旧码行的 `needSync` / `status`。理杏仁 universe 周扫若对旧码回非可交易 `listingStatus`，会自然置 `inactive` 退出（`lixinger-universe.adapter.ts:36-46`），若直接不返该码则该行永停 `active` —— 哪一种同样未验证。**prod 实测（2026-10-16）**：① 只读 SQL：hk / cn 有 21 只「消失码」（已不在理杏仁 universe 列表，但 `status = active`、`need_sync = true`）一直在 `fundamental` / `financial` 工作集里；近 10 天这两个维度每天 scanned 含它们，10 次运行全部 `status = success`、`failed = 0`。② 真请求 POC（临时容器只读调理杏仁 12 次）：hk / cn × `/company/fundamental/non_financial` 与 `/company/fs/non_financial`，批量里加入不存在代码（99998 / 699998）⇒ HTTP 200、`code = 1`、`data` 为数组、正常代码照常返回、未知代码被静默略过；加入消失码 ⇒ 仍返回其数据。⇒ 未知 / 旧码留在批次里**不拖垮同批**（上文「vendor 若只是不返该码 ⇒ 无害」一支成立）。③ `sync_blacklist` 只被 `sync-universe.usecase.ts`（约 `:75`）读，只挡 universe 新建，对已存在行无效；`needSync` 是受保护列（`anchor-driven-sync-gate.ts` 约 `:57-60`），不新增写入方。**判定**：全部无害 ⇒ 第 4 步对 hk / cn **不写 `needSync`、不写 `sync_blacklist`**，只在报告里写明「该市场采集范围不随锚变化；旧码留在批次里不影响同批采集（2026-10-16 prod POC）」；新码标的行照常经 `EnsureInstrumentUseCase` 补齐（FR-011 / branch 16 不分市场）。不追加 IT 臂。

- [X] T014 [Server] [US5] **CLI `symbol-change.cli.ts`**（FR-009, FR-011, FR-012; plan D5, D6）：照 `marketdata-trigger.cli.ts:329-366` 的形态（worker / scheduler 哨兵 env、`createApplicationContext(AppModule)`、`finally app.close()`、`process.argv[1]?.includes(...)` 入口守卫）。子命令：`apply` / `revert`（默认 preview，`--confirm` 才 apply）、`list`（全部登记含已撤销，FR-009）、`candidates` / `dismiss`（T019 接）。参数解析抽成纯函数 `parseSymbolChangeArgs` → verify: `optionsdesk/symbol-change.cli.spec.ts`（Small，只测参数解析与「无 `--confirm` ⇒ mode=preview」）先红 → 绿；`pnpm nx run server:build` 后 `node dist/.../symbol-change.cli.js --help` 本地可跑

- [X] T015 [Ops] [US5] **ops 包装脚本 `ops/bin/symbol-change.sh`**（FR-012, FR-016; plan D6）：从 `~/.nvy/fleet.env` 取 app 主机；ssh → `sops exec-env … docker compose … run --rm -T --no-deps --entrypoint node app dist/optionsdesk/symbol-change.cli.js "$@"`；不带 `--confirm` 时只打印复述表并提示「确认后加 `--confirm` 重跑」。脚本内零判断逻辑，判断全在 CLI → verify: `bash -n` 通过；`pnpm tsx scripts/checks/check-identifier-boundary.ts` 与 `check-repo-layout.ts` 绿；prod 只读预览留给 T022

### US4（P3）：改名被及时发现

- [X] T016 [Server] [US4] **实时报价端口带出 `unknownSymbols`**（FR-010, FR-018; plan D7）：前置 = PR #495 已合并并 rebase。`realtime-quote.port.ts:117` 返回 `{quotes, unknownSymbols}`；futu adapter 把 #495 的 warn 升级为返回值（warn 保留）；market-routed adapter 按市场合并；两个消费方（`sync-anchor-last-close.ts:293`、`sync-anchor-intraday.ts:360`）改读 `.quotes` → verify: `futu-realtime-quote.adapter.spec.ts`、`market-routed-realtime-quote.adapter.spec.ts` 先红 → 绿（未知代码出现在 `unknownSymbols`、其余报价照常）；两个消费方既有 spec 全绿（FR-010：一只坏码不再拖垮整批，回归不退）；定向变异：routed adapter 丢掉 `unknownSymbols` 合并 → 红（留档）

- [X] T017 [P] [Server] [US4] **候选表 + 新码建议纯函数**（FR-018; plan D8; state_branches 21, 22）：`schema.prisma` 新增 `SymbolChangeCandidate`（schema `optionsdesk`，字段按 plan D8）；`pnpm db:migrate "create symbol change candidate"`，手写 `(ticker) WHERE status = 'PENDING'` 部分唯一索引；`MODEL_OWNERSHIP` 加 `symbolChangeCandidate: 'optionsdesk'`；`symbol-candidate.rules.ts` 的 `suggestNewCodes(oldName, sameMarketInstruments)`：名称分词（去掉 Inc / Corp / Holdings 等后缀词）求交集打分，取前 3，0 分不收 → verify: `symbol-candidate.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 「Paramount Skydance」对 [「Skydance」, 「Paramount Global」, 「Banzai International」] ⇒ 前两名含 Skydance（branch 21）② 无任何交集 ⇒ 空数组（branch 22）③ 后缀词不计分；moat 检查绿

- [X] T018 [Server] [US4] **产生候选**（FR-018; plan D8; state_branches 21, 22, 24）：`sync-anchor-last-close.ts` 拿到 `unknownSymbols` 后 upsert 候选（`// CROSS-CONTEXT-READ:` 读同市场 `instrument` 的 name / code 供 T017；已有 PENDING ⇒ 只刷新最近观测；已有 DISMISSED ⇒ 不再生成；无建议 ⇒ 候选标「代码失效」）→ verify: 新建 `optionsdesk-086.candidate.it.spec.ts`，先红 → 绿，臂：① 未知代码 + 有建议 ⇒ PENDING 候选带建议（branch 21）② 无建议 ⇒ 候选标「代码失效」（branch 22 的生成半）③ 预置 DISMISSED 后同一 ticker 再报未知 ⇒ 不新增候选（branch 24）④ 同一 ticker 连续两拍 ⇒ 仍只一条 PENDING；定向变异：去掉 DISMISSED 抑制 → ③ 红（留档）

- [X] T019 [Server] [US4] **候选处置 + CLI 子命令**（FR-019; plan D8; state_branches 22, 23, 24）：新建 `resolve-symbol-candidate.usecase.ts`（`dismiss(id, note)` → DISMISSED）；确认不在此处写，由编排在 apply 写入时同 tx 把候选翻 CONFIRMED 并记登记 id（T011 的编排加一个可选 `candidateId` 入参）；T014 的 CLI 接上 `candidates` / `dismiss` / `apply --from-candidate <id>`（无新码建议且未显式传 `--new` ⇒ 拒绝）→ verify: 同 IT 文件追加：① `apply --from-candidate` ⇒ 进入 preview，`--confirm` 后候选 CONFIRMED 且记登记 id（branch 23）② 「代码失效」候选不带 `--new` ⇒ 拒绝（branch 22 的确认半）③ dismiss ⇒ DISMISSED 且带备注（branch 24 的处置半）；定向变异：去掉「无建议 ⇒ 拒绝」→ ② 红（留档）

- [X] T020 [P] [Ops] [US4] **候选告警：`app-state-health` 新判据**（FR-018; plan D9）：前置 = PR #495 已合并。`app-state-health.sql` 加判据：存在 PENDING 候选 ⇒ exit 1，summary 追加 `symbol_candidates=<n>⚠疑似改名:<tickers>`；`.sh` 不动（零逻辑胶水）→ verify: `app-state-health.it.spec.ts` 加臂：有 PENDING ⇒ exit 1 且 summary 含 ticker；只有 DISMISSED / CONFIRMED ⇒ 不判红；先红 → 绿；装机前在 prod 只读跑一次，确认当前判绿（同 #495 的做法）

### Gate · Ops

- [X] T021 [Gate] **覆盖收口 + 全量门 + PR**（SC-002, SC-003, SC-004, SC-007）：逐条核对下方五张覆盖预检表（**实时 grep，不抄表内数字**）→ 本地跑 `docs/conventions/local-verification.md` 的「PR 门」行（`nx affected … --skip-nx-cache`）与 §2.1 的 `scripts/checks/*` 全扫 → `gh-bot pr create`（body 按 `pr-creation-protocol.md`）→ verify: PR 门 `EXIT=0` 落盘留档；CI 全绿。本 PR 含两条新表迁移（纯新增、可逆），**不是**高风险例外，照常接 auto-merge；→ 覆盖收口（实时 grep）：`state_branches` 24 / FR 19 / SC 7 / Edge Case 10 / AS 15 条与五张表一致，除 T022（上线后验收，故意 pending）外落点 task 全 `[X]`；branch 6 / 10 / 11 原只在 Small spec，已在 `marketdata-086.bars-splice.it.spec.ts` 补 IT 臂（链式 CHA → CHB → CHC、旧码 = 新码 / 分拆 / 退市拒绝；变异：`resolveLineage` 只回溯一段 + 去掉事件类型校验 ⇒ 两臂红、16 绿），branch 7 已由 T005 ① 覆盖（标题补注）；T023 补进 FR-011。部署时序：`docker-entrypoint.sh:11` 先 `prisma migrate deploy` 再起服务，`deploy.yml` 健康等待未过即 `exit 1`（`:279-293`），`ops/jobs/install.sh` 在其后（`:380`），timer 只跑装机副本 ⇒ 新 SQL 不会早于新表。本地 PR 门 EXIT=0（2026-10-16，日志路径见 scratchpad，不入仓）；CI 与 PR 由主 agent 收口

- [ ] T022 [Ops] **上线验收：PSKY → SKYD 真跑**（SC-001, SC-005, SC-006; plan D6）：前置 = 发版上线。① `ops/bin/symbol-change.sh apply us PSKY SKYD 2026-10-06 --evidence <SEC 8-K URL>` 不带 `--confirm`，核对复述表（预期迁锚一步为 `skipped`，因为 PSKY 锚已于 2026-10-15 人工删除，以真跑报告为准）② 加 `--confirm` 重跑 ③ 报告第 5 步：SKYD 序列首日 = 2019-12-05、缺口 0（SC-001）④ 维护者计时：从执行到「全部完成」≤ 10 分钟，人工动作只有执行 + 确认（SC-005、SC-006）⑤ 原参数再跑一次 ⇒ 全 `skipped`（SC-007 的 prod 复核）→ verify: 报告原文与计时回填本行

## 依赖与并行

```text
T001 → T002 ─┐
       T003 ─┼→ T005 → T007
       T004 ─┘   T006 (P, 只依赖 T002)
T008 → T009 ─┐
T010 ────────┼→ T011 → T012
T013 ────────┘   T011 → T014 → T015
PR #495 合并 → T016 → T018 → T019 (还依赖 T011、T014)
               T017 (P, 只依赖 T001 的迁移形态) → T018
PR #495 合并 → T020 (P)
全部 → T021 → T022
```

- 可并行：T002 / T003 / T004；T006 与 T007；T010 与 T008–T009；T013 可最早开（只读取证）；T017 与 T016；T020 与 US4 其余 task。
- US5 依赖 US3（迁锚）与 Foundational（登记、标的行补齐）。US4 依赖 PR #495，#495 未合并时 US4 整段阻塞，不影响 US1、US2、US3、US5 先交付。

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

| # | 分支（摘要） | Task |
| --- | --- | --- |
| 1 | 登记后旧码历史在新码名下可读 | T005 |
| 2 | 新码序列分段拼接不重不缺 | T005 |
| 3 | 无登记与上线前一致 | T005 |
| 4 | 回收数据不进新码序列 | T002, T007 |
| 5 | 查被回收旧码只取回收后 | T002, T007 |
| 6 | 链式回溯 | T002, T021（IT 补臂） |
| 7 | 新码生效日前数据不计入 | T002, T005 |
| 8 | 撤销后回到登记前读法 | T005 |
| 9 | 重复登记拒绝 | T002 |
| 10 | 非法登记拒绝 | T002, T003, T021（IT 补臂） |
| 11 | 分拆 / 退市不可登记 | T002, T021（IT 补臂） |
| 12 | 修正命令默认预览零写入 | T010 |
| 13 | 确认后五步完成 | T011 |
| 14 | 中途失败续跑 | T010 |
| 15 | 重复执行全跳过 | T010 |
| 16 | 新码不在标的表先补齐 | T004, T011 |
| 17 | 新码已有锚报冲突 | T009 |
| 18 | 撤销命令 | T012 |
| 19 | 锚迁移 + 复核逾期 | T009 |
| 20 | 复核后清除逾期 | T009 |
| 21 | 未知代码 + 有建议 ⇒ 候选并通知 | T017, T018, T020 |
| 22 | 无建议 ⇒ 仅「代码失效」 | T017, T018, T019 |
| 23 | 确认候选 ⇒ 进预览 | T019 |
| 24 | 否决后不重复生成 | T018, T019 |

## Functional Requirements 覆盖预检

| FR | Task |
| --- | --- |
| FR-001 | T001, T003 |
| FR-002 | T001, T002, T003 |
| FR-003 | T001, T003, T005 |
| FR-004 | T005, T006 |
| FR-005 | T002, T007 |
| FR-006 | T005 |
| FR-007 | T005 |
| FR-008 | T002 |
| FR-009 | T003, T014 |
| FR-010 | T016 |
| FR-011 | T004, T011, T013, T014, T023 |
| FR-012 | T010, T014, T015 |
| FR-013 | T010 |
| FR-014 | T009, T011 |
| FR-015 | T012 |
| FR-016 | T015 |
| FR-017 | T008, T009, T012 |
| FR-018 | T016, T017, T018, T020 |
| FR-019 | T019 |

## Success Criteria 覆盖预检（SC 是系统性盲区，单列一张）

| SC | 落点 | 性质 |
| --- | --- | --- |
| SC-001 | T022 | prod 验收（CLI 报告直接给出首日与缺口数） |
| SC-002 | T007 | IT 判据（交叉日数 = 0） |
| SC-003 | T005 | IT 深等反例臂 |
| SC-004 | T005 | IT（读时拼接无缓存，登记 / 撤销即时生效；「1 个采集周期」是上界） |
| SC-005 | T022 | prod 验收，维护者计时 |
| SC-006 | T022 | prod 验收，维护者计时 |
| SC-007 | T010, T022 | IT 重复执行臂 + prod 复核 |

## Edge Case 覆盖预检

| Edge Case | 落点 |
| --- | --- |
| 链式改名 | T002 ② |
| 改回原码 | T002 ③ |
| 生效日不是交易日 | T005 ④ |
| 新码生效日前已有数据 | T002 ⑤ |
| 分拆 / 退市 / 被吞并方 | T002 ⑧ |
| 跨市场 | T002（入参只有一个 market 字段，类型上排除） |
| 期权合约 | **故意不覆盖**：spec 明写 v1 只保证标的层面，合约层留给后续 |
| 登记错误可撤销 | T005 ③、T012 |
| 旧码锚仍在 | T009（迁走）、T016（取价层不再拖垮整批） |
| 港股 / A 股的旧码采集范围 | T013（取证并按结论补步骤） |

## Acceptance Scenario 覆盖预检（标准矩阵**够不到**这一层）

| AS | 落点 |
| --- | --- |
| US1-AS1 / AS2 / AS3 | T005 ① / ② / ③ |
| US2-AS1 / AS2 | T007 ① / ② |
| US3-AS1 / AS2 / AS3 | T009 ① / ③ / ② |
| US4-AS1 / AS2 / AS3 | T018 ① · T019 ① ③ · T018 ② + T019 ② |
| US5-AS1 / AS2 / AS3 / AS4 | T010 ① · T011 ① · T010 ② · T012 ① |

## Implementation Strategy

- **MVP = Foundational + US1 + US2**（T001–T007）：改名后的历史能接上且不误拼，单靠 `RegisterSymbolChangeUseCase` 就能交付价值。
- **第二增量 = US3 + US5**（T008–T015）：一条命令完成修正，对应维护者的核心诉求。T013 是只读取证，可以最早开。
- **第三增量 = US4**（T016–T020）：自动发现，阻塞在 PR #495 合并。
- 单 feature 单 PR（T021），按增量逐 task commit；PR 合并后做 T022 上线验收。
