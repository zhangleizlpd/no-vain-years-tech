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

## Format

`- [ ] TNNN [P?] [层级] [USn] **标题**（FR-xxx; plan Dx; state_branches n）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 即其验收，红 → 绿在同一 task 内闭环（Constitution §II）；新测试必须**定向变异证明能红**并留档。
- 层级：`[Server]` / `[Server-IT]` / `[Ops]` / `[Gate]`。本片无 `[Contract]` / `[Mobile]` / `[Shim]`（零 endpoint、零 DTO、零 UI；shim 侧改动已在 PR #495）。
- `state_branches n` = spec frontmatter `state_branches` 的**行序号**（1 起）。FR / SC 逐条枚举，不用范围记法。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 登记表 / 迁移 | `apps/server/prisma/schema.prisma`（`Instrument` `:344-415` 为相邻先例）+ `prisma/migrations/<ts>_086_*` |
| lineage 纯函数（新） | `apps/server/src/marketdata/symbol-lineage.rules.ts`（+ `.spec.ts`） |
| 登记 / 撤销 use case（新） | `apps/server/src/marketdata/{register,revoke}-symbol-change.usecase.ts` |
| 日线拼接点（改） | `apps/server/src/marketdata/get-instrument-bars.usecase.ts`（解析 `:47` · 取 bar `:61` · 取因子 `:83`） |
| IV 核对点（改） | `apps/server/src/marketdata/dimension-executor.ts`（`crossCheckIvPercentile` `:3333-3340`） |
| 实时报价端口（改） | `marketdata/realtime-quote.port.ts:117` · `futu-realtime-quote.adapter.ts:93` · `market-routed-realtime-quote.adapter.ts:41` |
| marketdata 装配（改） | `marketdata/marketdata.module.ts`（providers `:702` · exports `:892` 起） |
| 迁锚 / 编排 / 候选（新） | `apps/server/src/optionsdesk/{migrate-anchor-ticker,remediate-symbol-change,resolve-symbol-candidate}.usecase.ts` · `symbol-candidate.rules.ts`（+ `.spec.ts`）· `symbol-change.cli.ts` |
| optionsdesk 触碰 | `sync-anchor-last-close.ts:293` · `sync-anchor-intraday.ts:360` · `optionsdesk.module.ts` |
| 既有可复用 | `reject-anchor-submissions.usecase.ts:30` · `review-anchor.usecase.ts:69`（`isAnchorOverdue`）· `anchor-history.ts:35` · `create-anchor.usecase.ts:236,317`（锚创建事件）· `anchor-driven-sync-gate.ts:79` |
| CLI 启动先例 | `apps/server/src/marketdata/marketdata-trigger.cli.ts:329-366` |
| ops（新 / 改） | `ops/bin/symbol-change.sh`（复述闸先例 `ops/bin/anchor-approve.sh:294-334`）· `ops/jobs/app-state-health.sql` |
| 护城河 | `scripts/checks/check-server-moat.ts`（`MODEL_OWNERSHIP` · `WRITE_ALLOWLIST.anchor` `:248-262`） |
| IT（新 / 改） | `apps/server/test/integration/{marketdata-086.bars-splice,optionsdesk-086.remediate,optionsdesk-086.candidate}.it.spec.ts`（隔离库 `test/_support/isolated-db.ts` `setupIsolatedDb`）· `app-state-health.it.spec.ts`（扩） |

## Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **生效日是交易所当地日历日**，与 `daily_bar.trade_date` 同一条轴（ADR-0066）。不存 UTC 时刻、不做时区换算；「生效日晚于今天」的「今天」取交易所当地日（`check-time-semantics.ts` 只拦一部分形态，差一天不会红）。
2. **回收防误拼的下界**：查询码的末段起点不早于「它作为旧码被改走的最晚生效日」。漏掉这一条时 PARA 类查询会把改名前那家公司的历史拼进来，不报错，只是数字悄悄变错。
3. **无登记 ⇒ 逐条一致**（FR-007 / SC-003）：拼接改动必须有「无登记 fixture 上新旧结果深等」的反例臂，否则任何漏判都不会显形。
4. **迁锚同 tx 四件事**：conditional UPDATE（affected-count）+ `anchor_change` 痕迹 + 清空旧码价格列 + outbox 事件。旧价格列不清空的话，新码锚会带着旧码最后一个价进雷达排序，直到下一拍才被覆盖。
5. **编排在 optionsdesk、不在 marketdata**：marketdata 不能 import optionsdesk（eslint `apps/server/eslint.config.mjs:190-203` 拦）。跨 ctx 注入点各带 `// CROSS-CONTEXT-SYNC:`（`check-server-moat.ts` Check 2 拦）。
6. **CLI 在 prod 只用 `docker compose run --rm`**，不 `docker exec` 进 app 容器（共用 640m cgroup，一次 AppModule boot 实测吃宿主约 230MiB，维护者 2026-09-15 #439 处置记录）。
7. **fixture 用合成代码**（`AAA` / `BBB` / `CCC` 一类），不用真实持仓或交易数据；PSKY / SKYD / PARA 是公开行情事件，可作为 IT 场景名，但数值一律合成。
8. **新文件首跑带 `--skip-nx-cache`**（`implement-task-closure.md`）。

## Tasks

### Foundational：登记表与连续身份规则

- [ ] T001 [Server] **`symbol_change` 表 + 迁移 + 护城河登记**（FR-001, FR-002, FR-003; plan D1, D10）：`schema.prisma` 新增 `SymbolChange` model（schema `marketdata`；字段按 plan D1；`effectiveDate @db.Date`；部分唯一索引 `(market, old_code, effective_date) WHERE revoked_at IS NULL` 用迁移 SQL 手写，先例见同文件其它部分唯一索引）；`check-server-moat.ts` 的 `MODEL_OWNERSHIP` 加 `symbolChange: 'marketdata'` → verify: `pnpm nx run server:prisma-migrate` 类命令在隔离库上 apply 成功（命令以 `docs/conventions/local-verification.md` 为准）；`pnpm tsx scripts/checks/check-server-moat.ts` 绿；定向变异：删掉 ownership 一行 → moat 红（留档）

- [ ] T002 [P] [Server] **`symbol-lineage.rules.ts`：`resolveLineage` + `validateRegistration`**（FR-002, FR-005, FR-008; plan D2; state_branches 4, 5, 6, 7, 9, 10, 11）：纯函数，入参为登记数组（已过滤撤销）、市场、代码、交易所当地「今天」。实现 plan D2 的回溯与两条下界；校验拒绝：旧码 = 新码、生效日 > 今天、同 `(market, old, effective)` 重复、成环、与已有段区间重叠；事件类型只接受 `rename`（branch 11：分拆 / 退市没有可登记的类型）。docblock 写复杂度 O(链长 × n) → verify: `pnpm nx test server src/marketdata/symbol-lineage.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 单次改名 ⇒ 两段且边界 = 生效日 ② 链式 A → B → C ⇒ 三段（branch 6）③ 改回原码 A → B → A（日期递增）⇒ 合法、段归属正确 ④ 回收：A → B @ D 后查 A ⇒ 只有 `[D, ∞)` 一段（branch 4、5）⑤ 新码 D 前有自有数据 ⇒ 新码段起点仍为 D（branch 7）⑥ 无登记 ⇒ 单段无下界 ⑦ 四类拒绝各一条（branch 9、10）⑧ 非 `rename` 类型拒绝（branch 11）⑨ 成环 / 区间重叠拒绝；定向变异：a. 去掉回收下界 → ④ 红 · b. 生效日比较改 `<=` → ① 边界臂红（留档）

- [ ] T003 [Server] **登记 / 撤销 use case + marketdata exports**（FR-001, FR-002, FR-003, FR-009; plan D1, D5）：`register-symbol-change.usecase.ts`（读未撤销登记 → `validateRegistration` → 插入；P2002 折叠为「已存在」供 CLI 判跳过）、`revoke-symbol-change.usecase.ts`（conditional UPDATE `revoked_at IS NULL` → 写撤销人 / 理由；已撤销 ⇒ 返回「已撤销」）、`list` 只读方法（含已撤销，FR-009）。`marketdata.module.ts` exports 加两个 use case + `AnchorDrivenSyncGate` + `GetInstrumentBarsUseCase` → verify: 臂并入 T004 的 IT 文件（登记 → 读 → 撤销 → 重登记同参数成功）；`pnpm nx run server:typecheck` 绿；boot 冒烟留给 T017 的 `runtime-smoke`

### US1（P1）：登记改名后新码名下看到完整历史

- [ ] T004 [Server] [US1] **日线读时拼接**（FR-003, FR-004, FR-006, FR-007; plan D3; state_branches 1, 2, 3, 8; SC-003, SC-004）：`get-instrument-bars.usecase.ts:47` 起改为 lineage → 每段解析 instrument（不存在则跳过该段）→ 段区间 ∩ 查询窗 → 分段取 `daily_bar` 并按日期拼接；`:83` 的因子改为取所有段 instrument 的、`exDate` 落在本段区间内的版本，合并后交 `deriveAdjustedBars`。`freshnessTier` / `asOf` 逻辑不动 → verify: 新建 `apps/server/test/integration/marketdata-086.bars-splice.it.spec.ts`（`setupIsolatedDb`），先红 → 绿，臂：① 登记后查新码 ⇒ 旧段 + 新段连续、无重复（branch 1、2）② 无登记 ⇒ 与改动前实现结果**深等**（branch 3；同 fixture 跑两遍对比）③ 撤销后 ⇒ 与 ② 深等（branch 8；SC-004 即时生效）④ 生效日落在周末 ⇒ 前一个交易日属旧段、下一个交易日属新段 ⑤ `adjust=forward` 时跨段因子正确应用 ⑥ T003 的登记 / 撤销 / 重登记臂；定向变异：a. 拼接时不切段（整段取旧码）→ ① 出现重复日红 · b. 跳过 lineage 直接走原路径 → ① 红（留档）

- [ ] T005 [P] [Server] [US1] **IV 交叉核对读时拼接**（FR-004; plan D4）：`dimension-executor.ts:3340` 的 `underlyingIvHistory.findMany({instrumentId})` 改为按 lineage 分段取、拼接后取最近 252 条（`underlying-iv.rules.ts:50`）。只影响核对日志，上屏值不变（spec Q3 amend）→ verify: 实施时 `rg -n 'crossCheckIvPercentile' apps/server/src apps/server/test` 定位既有用例所在 spec，在该文件加臂：改名后旧段 200 条 + 新段 60 条 ⇒ 不再报 `insufficient_window`；无登记 ⇒ 行为不变；定向变异：只取新段 → 第一臂红（留档）

### US2（P1）：代码回收不被误拼

- [ ] T006 [Server-IT] [US2] **回收场景端到端**（FR-005; plan D2, D3; state_branches 4, 5; SC-002）：在 T004 的 IT 文件追加回收 fixture：A → B @ D 已登记，A 在 D 之后另有一家公司的 bar → verify: 臂：① 查 B ⇒ 序列里没有任何一天来自「A 在 D 之后」② 查 A ⇒ 只有 D 之后的 bar；SC-002 判据 = 两个序列的交叉日数为 0；定向变异：去掉 T002 的回收下界 → ② 红（留档）

### US3（P2）：估值锚随改名延续

- [ ] T007 [Server] [US3] **核对锚创建事件对重复投递的幂等性（决定复用或改专用事件）**（FR-017; plan D5）：读 `marketdata/anchor-cold-start.subscriber.ts` 与 `optionsdesk/broker-history-backfill.subscriber.ts:44`，判定「同一 ticker 第二次收到 `optionsdesk.anchor-created`」时两者的行为 → verify: 结论写进本行（复用 / 专用事件 + 判据的代码行号）；若需改专用事件，在本 task 内新增事件名与两个订阅者的注册，并在各自 spec 补「迁锚事件」臂；**这是 T008 的前置**

- [ ] T008 [Server] [US3] **迁锚 use case**（FR-014, FR-017; plan D5; state_branches 17, 19, 20）：新建 `migrate-anchor-ticker.usecase.ts`，同 tx：conditional UPDATE `where {ticker: old}`（count === 0 ⇒ 「旧码无锚」）且新码无锚（有 ⇒ 返回冲突，不写）；`ticker` → 新码、`next_review` → 交易所当地「昨天」、`last_close` / `last_close_date` / `intraday_*` → null；写 `anchor_change`（`changedFields: ['ticker', 'nextReview']`，before 值保留原 `next_review` 供撤销）；发布 T007 定下的事件。`check-server-moat.ts` `WRITE_ALLOWLIST.anchor` 加本文件；同文件提供 `revert`（新码 → 旧码、恢复原 `next_review`）供 T010 → verify: 新建 `apps/server/test/integration/optionsdesk-086.remediate.it.spec.ts`，先红 → 绿，臂：① 旧码有锚、新码无锚 ⇒ 锚在新码名下、`isAnchorOverdue` 为真、痕迹两行可查（branch 19）② 新码已有锚 ⇒ 冲突、零写入（branch 17）③ 迁移后调既有 `review-anchor` ⇒ 不再逾期（branch 20）④ outbox 有一条事件且与写同 tx（构造事件写失败 ⇒ 锚未迁）⑤ revert ⇒ 回旧码、`next_review` 恢复；定向变异：a. 去掉新码冲突判定 → ② 红 · b. 不清价格列 → 断言新码锚 `last_close` 为 null 的臂红（留档）

### US5（P1）：一条命令完成改名后的全部修正

- [ ] T009 [Server] [US5] **修正编排 use case：五步 + 预览 + 幂等**（FR-011, FR-012, FR-013, FR-014; plan D5; state_branches 12, 13, 14, 15, 16; SC-007）：新建 `remediate-symbol-change.usecase.ts`，注入（各带 `// CROSS-CONTEXT-SYNC:`）marketdata 的登记 use case、`AnchorDrivenSyncGate`、`GetInstrumentBarsUseCase`，与本 ctx 的迁锚、`RejectAnchorSubmissionsUseCase`。`execute({…, mode: 'preview' | 'apply'})` 返回逐步报告 `[{step, status: ok|skipped|failed|conflict, detail}]`；每步先读状态判已完成 ⇒ `skipped`；失败即停。第 5 步按交易日历算新码 lineage 序列的缺口数写进报告；hk / cn 的采集闸一步报「该市场采集范围不随锚变化」 → verify: T008 的 IT 文件追加，臂：① preview ⇒ 全库行数与 `updated_at` 不变（branch 12）② apply ⇒ 五步 `ok`（branch 13）③ 第 3 步注入失败 ⇒ 停在第 3 步，修复后重跑 ⇒ 1、2 步 `skipped`、3 起继续（branch 14）④ 同参数连跑两次 ⇒ 第二次全 `skipped`、状态无变化（branch 15、SC-007）⑤ 新码不在标的表 ⇒ 第 2 步发出的事件让冷启动补齐（用 `test/_support/cold-start-stub.ts` 断言收到新码，branch 16）⑥ 旧码有 PENDING 提交 ⇒ 被驳回且理由含新码；定向变异：a. 去掉「已完成 ⇒ skipped」判定 → ④ 红 · b. preview 分支误调写方法 → ① 红（留档）

- [ ] T010 [Server] [US5] **撤销编排**（FR-015, FR-017; plan D5; state_branches 18）：同文件新增 `revert` 模式：逆序 —— 迁锚 revert → 撤销登记 → 重算采集闸；驳回的提交不复原，报告写明 → verify: 同 IT 文件追加：① apply 后 revert ⇒ 登记已撤销、锚回旧码且复核状态复原、采集闸复原（branch 18）② revert 两次 ⇒ 第二次全 `skipped`；定向变异：漏掉撤销登记一步 → ① 红（留档）

- [ ] T011 [Server] [US5] **CLI `symbol-change.cli.ts`**（FR-009, FR-011, FR-012; plan D5, D6）：照 `marketdata-trigger.cli.ts:329-366` 的形态（worker / scheduler 哨兵 env、`createApplicationContext(AppModule)`、`finally app.close()`、`process.argv[1]?.includes(...)` 入口守卫）。子命令：`apply` / `revert`（默认 preview，`--confirm` 才 apply）、`list`（全部登记含已撤销，FR-009）、`candidates` / `dismiss`（T015 接）。参数解析抽成纯函数 `parseSymbolChangeArgs` → verify: `optionsdesk/symbol-change.cli.spec.ts`（Small，只测参数解析与「无 `--confirm` ⇒ mode=preview」）先红 → 绿；`pnpm nx run server:build` 后 `node dist/.../symbol-change.cli.js --help` 本地可跑

- [ ] T012 [Ops] [US5] **ops 包装脚本 `ops/bin/symbol-change.sh`**（FR-012, FR-016; plan D6）：从 `~/.nvy/fleet.env` 取 app 主机；ssh → `sops exec-env … docker compose … run --rm -T --no-deps --entrypoint node app dist/optionsdesk/symbol-change.cli.js "$@"`；不带 `--confirm` 时只打印复述表并提示「确认后加 `--confirm` 重跑」。脚本内零判断逻辑，判断全在 CLI → verify: `bash -n` 通过；`pnpm tsx scripts/checks/check-identifier-boundary.ts` 与 `check-repo-layout.ts` 绿；prod 只读预览留给 T018

### US4（P3）：改名被及时发现

- [ ] T013 [Server] [US4] **实时报价端口带出 `unknownSymbols`**（FR-010, FR-018; plan D7）：前置 = PR #495 已合并并 rebase。`realtime-quote.port.ts:117` 返回 `{quotes, unknownSymbols}`；futu adapter 把 #495 的 warn 升级为返回值（warn 保留）；market-routed adapter 按市场合并；两个消费方（`sync-anchor-last-close.ts:293`、`sync-anchor-intraday.ts:360`）改读 `.quotes` → verify: `futu-realtime-quote.adapter.spec.ts`、`market-routed-realtime-quote.adapter.spec.ts` 先红 → 绿（未知代码出现在 `unknownSymbols`、其余报价照常）；两个消费方既有 spec 全绿（FR-010：一只坏码不再拖垮整批，回归不退）；定向变异：routed adapter 丢掉 `unknownSymbols` 合并 → 红（留档）

- [ ] T014 [P] [Server] [US4] **候选表 + 新码建议纯函数**（FR-018; plan D8; state_branches 21, 22）：`schema.prisma` 新增 `SymbolChangeCandidate`（schema `optionsdesk`，字段按 plan D8；`(ticker) WHERE status = 'PENDING'` 部分唯一）+ 迁移；`MODEL_OWNERSHIP` 加 `symbolChangeCandidate: 'optionsdesk'`；`symbol-candidate.rules.ts` 的 `suggestNewCodes(oldName, sameMarketInstruments)`：名称分词（去掉 Inc / Corp / Holdings 等后缀词）求交集打分，取前 3，0 分不收 → verify: `symbol-candidate.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 「Paramount Skydance」对 [「Skydance」, 「Paramount Global」, 「Banzai International」] ⇒ 前两名含 Skydance（branch 21）② 无任何交集 ⇒ 空数组（branch 22）③ 后缀词不计分；moat 检查绿

- [ ] T015 [Server] [US4] **产生候选 + 确认 / 否决**（FR-018, FR-019; plan D8; state_branches 21, 22, 23, 24）：`sync-anchor-last-close.ts` 拿到 `unknownSymbols` 后 upsert 候选（`// CROSS-CONTEXT-READ:` 读同市场 `instrument` 的 name / code 供 T014；已有 PENDING ⇒ 只刷新最近观测；已有 DISMISSED ⇒ 不再生成）；新建 `resolve-symbol-candidate.usecase.ts`（`dismiss(id, note)`；`confirm` 不在此处写，而是由 T009 在 apply 写入时同 tx 把候选翻 CONFIRMED 并记登记 id）；T011 的 CLI 接上 `candidates` / `dismiss` / `apply --from-candidate <id>`（无新码建议且未显式传 `--new` ⇒ 拒绝）→ verify: 新建 `optionsdesk-086.candidate.it.spec.ts`，先红 → 绿，臂：① 未知代码 + 有建议 ⇒ PENDING 候选带建议（branch 21）② 无建议 ⇒ 候选标「代码失效」，`apply --from-candidate` 不带 `--new` ⇒ 拒绝（branch 22）③ 确认 ⇒ 进入 preview，apply 后候选 CONFIRMED（branch 23）④ dismiss 后同一 ticker 再报未知 ⇒ 不新增候选（branch 24）⑤ 同一 ticker 连续两拍 ⇒ 仍只一条 PENDING；定向变异：去掉 DISMISSED 抑制 → ④ 红（留档）

- [ ] T016 [P] [Ops] [US4] **候选告警：`app-state-health` 新判据**（FR-018; plan D9）：前置 = PR #495 已合并。`app-state-health.sql` 加判据：存在 PENDING 候选 ⇒ exit 1，summary 追加 `symbol_candidates=<n>⚠疑似改名:<tickers>`；`.sh` 不动（零逻辑胶水）→ verify: `app-state-health.it.spec.ts` 加臂：有 PENDING ⇒ exit 1 且 summary 含 ticker；只有 DISMISSED / CONFIRMED ⇒ 不判红；先红 → 绿；装机前在 prod 只读跑一次，确认当前判绿（同 #495 的做法）

### Gate · Ops

- [ ] T017 [Gate] **覆盖收口 + 全量门 + PR**（SC-002, SC-003, SC-004, SC-007）：逐条核对下方五张覆盖预检表（**实时 grep，不抄表内数字**）→ 本地跑 `docs/conventions/local-verification.md` 的「PR 门」行（`nx affected … --skip-nx-cache`）与 §2.1 的 `scripts/checks/*` 全扫 → `gh-bot pr create`（body 按 `pr-creation-protocol.md`）→ verify: PR 门 `EXIT=0` 落盘留档；CI 全绿。本 PR 含两条新表迁移（纯新增、可逆），**不是**高风险例外，照常接 auto-merge

- [ ] T018 [Ops] **上线验收：PSKY → SKYD 真跑**（SC-001, SC-005, SC-006; plan D6）：前置 = 发版上线。① `ops/bin/symbol-change.sh apply us PSKY SKYD 2026-10-06 --evidence <SEC 8-K URL>` 不带 `--confirm`，核对复述表（预期：迁锚一步 `skipped`，因为 PSKY 锚已于 2026-10-15 人工删除）② 加 `--confirm` 重跑 ③ 报告第 5 步：SKYD 序列首日 = 2019-12-05、缺口 0（SC-001）④ 维护者计时：从执行到「全部完成」≤ 10 分钟，人工动作只有执行 + 确认（SC-005、SC-006）⑤ 原参数再跑一次 ⇒ 全 `skipped`（SC-007 的 prod 复核）→ verify: 报告原文与计时回填本行

## 依赖与并行

```text
T001 → T002 ─┐
       T003 ─┴→ T004 → T006
                T005 (P, 只依赖 T002)
T007 → T008 → T009 → T010
               T011 (依赖 T009) → T012
PR #495 合并 → T013 → T015
               T014 (P, 只依赖 T001 的迁移形态) → T015
PR #495 合并 → T016 (P)
全部 → T017 → T018
```

- 可并行：T002 与 T003 的前半；T005 与 T006；T014 与 T013；T016 与 US4 其余 task。
- US5 依赖 US3（迁锚）与 Foundational（登记）。US4 依赖 PR #495，#495 未合并时 US4 整段阻塞，不影响 US1、US2、US3、US5 先交付。

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

| # | 分支（摘要） | Task |
| --- | --- | --- |
| 1 | 登记后旧码历史在新码名下可读 | T004 |
| 2 | 新码序列分段拼接不重不缺 | T004 |
| 3 | 无登记与上线前一致 | T004 |
| 4 | 回收数据不进新码序列 | T002, T006 |
| 5 | 查被回收旧码只取回收后 | T002, T006 |
| 6 | 链式回溯 | T002 |
| 7 | 新码生效日前数据不计入 | T002 |
| 8 | 撤销后回到登记前读法 | T004 |
| 9 | 重复登记拒绝 | T002 |
| 10 | 非法登记拒绝 | T002 |
| 11 | 分拆 / 退市不可登记 | T002 |
| 12 | 修正命令默认预览零写入 | T009 |
| 13 | 确认后五步完成 | T009 |
| 14 | 中途失败续跑 | T009 |
| 15 | 重复执行全跳过 | T009 |
| 16 | 新码不在标的表先补齐 | T009 |
| 17 | 新码已有锚报冲突 | T008 |
| 18 | 撤销命令 | T010 |
| 19 | 锚迁移 + 复核逾期 | T008 |
| 20 | 复核后清除逾期 | T008 |
| 21 | 未知代码 + 有建议 ⇒ 候选并通知 | T014, T015, T016 |
| 22 | 无建议 ⇒ 仅「代码失效」 | T014, T015 |
| 23 | 确认候选 ⇒ 进预览 | T015 |
| 24 | 否决后不重复生成 | T015 |

## Functional Requirements 覆盖预检

| FR | Task |
| --- | --- |
| FR-001 | T001, T003 |
| FR-002 | T001, T002, T003 |
| FR-003 | T001, T003, T004 |
| FR-004 | T004, T005 |
| FR-005 | T002, T006 |
| FR-006 | T004 |
| FR-007 | T004 |
| FR-008 | T002 |
| FR-009 | T003, T011 |
| FR-010 | T013 |
| FR-011 | T009, T011 |
| FR-012 | T009, T011, T012 |
| FR-013 | T009 |
| FR-014 | T008, T009 |
| FR-015 | T010 |
| FR-016 | T012 |
| FR-017 | T007, T008, T010 |
| FR-018 | T013, T014, T015, T016 |
| FR-019 | T015 |

## Success Criteria 覆盖预检（SC 是系统性盲区，单列一张）

| SC | 落点 | 性质 |
| --- | --- | --- |
| SC-001 | T018 | prod 验收（CLI 报告直接给出首日与缺口数） |
| SC-002 | T006 | IT 判据（交叉日数 = 0） |
| SC-003 | T004 | IT 深等反例臂 |
| SC-004 | T004 | IT（读时拼接无缓存，登记 / 撤销即时生效；「1 个采集周期」是上界） |
| SC-005 | T018 | prod 验收，维护者计时 |
| SC-006 | T018 | prod 验收，维护者计时 |
| SC-007 | T009, T018 | IT 重复执行臂 + prod 复核 |

## Edge Case 覆盖预检

| Edge Case | 落点 |
| --- | --- |
| 链式改名 | T002 ② |
| 改回原码 | T002 ③ |
| 生效日不是交易日 | T004 ④ |
| 新码生效日前已有数据 | T002 ⑤ |
| 分拆 / 退市 / 被吞并方 | T002 ⑧ |
| 跨市场 | T002（入参只有一个 market 字段，类型上排除） |
| 期权合约 | **故意不覆盖**：spec 明写 v1 只保证标的层面，合约层留给后续 |
| 登记错误可撤销 | T004 ③、T010 |
| 旧码锚仍在 | T008（迁走）、T013（取价层不再拖垮整批） |

## Acceptance Scenario 覆盖预检（标准矩阵**够不到**这一层）

| AS | 落点 |
| --- | --- |
| US1-AS1 / AS2 / AS3 | T004 ① / ② / ③ |
| US2-AS1 / AS2 | T006 ① / ② |
| US3-AS1 / AS2 / AS3 | T008 ① / ③ / ② |
| US4-AS1 / AS2 / AS3 | T015 ① / ③④ / ② |
| US5-AS1 / AS2 / AS3 / AS4 | T009 ① / ② / ③ · T010 ① |

## Implementation Strategy

- **MVP = Foundational + US1 + US2**（T001–T006）：改名后的历史能接上且不误拼，单靠 `RegisterSymbolChangeUseCase` 就能交付价值。
- **第二增量 = US3 + US5**（T007–T012）：一条命令完成修正，对应维护者的核心诉求。
- **第三增量 = US4**（T013–T016）：自动发现，阻塞在 PR #495 合并。
- 单 feature 单 PR（T017），按增量逐 task commit；PR 合并后做 T018 上线验收。
