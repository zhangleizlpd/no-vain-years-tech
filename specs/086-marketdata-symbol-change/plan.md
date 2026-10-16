---
feature_id: 086-marketdata-symbol-change
spec_ref: ./spec.md
status: approved
created_at: '2026-10-16'
updated_at: '2026-10-16'
adr_refs: ['0040', '0043', '0053', '0062', '0066']
context7_verified: []
---

# Implementation Plan: 标的代码变更登记（symbol change）

## Summary _(mandatory)_

新增「代码变更登记」（marketdata 自持），日线的读取入口按登记做**读时拼接**，按生效日区间切段，防止被回收的代码误拼；optionsdesk 侧新增「迁锚」与「疑似改名候选」；再用一个 server CLI 把登记、迁锚、驳回待审提交、纠正采集范围、验证五步串成一条命令，ops 包装脚本负责预览和复述闸。技术路径：两张新表、两条迁移；marketdata 新增 3 个 use case 和 1 个纯函数规则文件；optionsdesk 新增 3 个 use case 和 1 个 CLI；改动 1 个端口的返回形态；**零新依赖、零 HTTP endpoint、零 OpenAPI 变更、零 mobile 改动**。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

**显式 no-op 声明**：
- CLI 照抄 `marketdata/marketdata-trigger.cli.ts:329-366` 的启动形态（`NestFactory.createApplicationContext(AppModule)` + `finally app.close()`）。
- 名称相似度用纯函数分词比较，不引入模糊匹配库。
- ops 包装脚本复用 `ops/bin/anchor-approve.sh` 的 `--confirm` 复述闸形态。

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles.

| 原则 | 本片如何满足 |
| --- | --- |
| I. SDD | specify → clarify（Session 2026-10-16，4 问 + plan 期 2 条 amend）已走完；纯后端，无 Mockup 步；spec `modules: [marketdata, optionsdesk]` 与物理 ctx 一致 |
| II. Test-First TDD | 每 task 红 → 绿；24 条 `state_branches` 逐条落 `it()`（见测试映射）；拼接与回收判据配反例臂 |
| III. Atomic Task | 按「登记表 + 规则 / 日线拼接 / IV 核对拼接 / 迁锚 / 端口 + 候选 / CLI 编排 / ops 脚本 + 探针」切片 |
| IV. Module Boundary | marketdata 不 import optionsdesk（`apps/server/eslint.config.mjs:190-203` 拦）⇒ 编排放在 optionsdesk，向下注入 marketdata 的 use case（`CROSS-CONTEXT-SYNC`）；两张新表各自登记 owner（`check-server-moat.ts` `MODEL_OWNERSHIP`）；迁锚 use case 进 `WRITE_ALLOWLIST.anchor`（`:248-262`） |
| V. 类型同步链 | 零 controller / DTO 改动 ⇒ 无 OpenAPI 变更 ⇒ 无 api-client regen；日线端点的**响应形态不变**，只是内容在有登记时变长 |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**：零新增 HTTP endpoint，按空集满足。等价物有三层：① Testcontainers IT 覆盖拼接、迁锚、候选和 CLI 编排的全部落库分支；② 门禁 task 跑 `nx affected` 全量门（含 `server:runtime-smoke`），覆盖 `AppModule` 装配；③ CLI 在 prod 以**预览模式**对 PSKY → SKYD 真跑一次（只读）。
- [x] **Mobile / Web**：N/A —— 无 UI 改动。锚的「复核逾期」复用现有状态（`list-anchors.usecase.ts:141`）。
- [x] **Evidence**：planned —— 由 `[Server-IT]` / `[Ops]` task 落证据；plan 阶段是「已规划」而不是「已完成」。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 不引入新的第三方 package / SDK / tool。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A —— mono-native。**

- **Evidence**：触及的 `apps/server/src/{marketdata,optionsdesk}/`、`ops/` 均诞生于 mono。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | sunset trigger / 判据 | Classification | 说明 |
| --- | --- | --- | --- |
| ADR-0043 | optionsdesk 复审线 = use case 达 30 个（§复审记录 2026-09-15） | accepted-as-is | 当前 25 个，本片 +3（迁锚 / 修正编排 / 候选处置）= 28，未达线 |
| ADR-0043 | 其它 ctx「use case 数 > 20」 | accepted-as-is（逼近） | marketdata 当前 17 个，+3（登记 / 撤销 / 确保标的行）= 20，等于线、未越线（判据是「> 20」）。下一片 marketdata 再加 use case 就会触发复审，记在这里 |
| ADR-0062 | #2「历史价格序列的读搬进 optionsdesk」 | accepted-as-is（未触发） | 拼接落在 marketdata 的 bars use case，optionsdesk 不读序列 |
| ADR-0062 | #3「出现第二个消费锚表的 ctx」 | accepted-as-is（未触发） | 候选表归 optionsdesk；marketdata 仍只有采集闸那一条反向读 |
| ADR-0053 | #2「第二个 ctx import 他 ctx 的 `*.rules.ts`」 | accepted-as-is（未触发） | optionsdesk 不 import `symbol-lineage.rules.ts`，只经 use case 调用 |
| ADR-0066 | 时间语义四条轴 | mitigated | 生效日 = **交易所当地日历日**，与 `daily_bar.trade_date` 同一条轴（D1） |

- **Evidence**：`ls apps/server/src/{optionsdesk,marketdata}/*.usecase.ts | grep -vc spec` → 25 / 17（2026-10-16 执行）；复审线原文取自 `docs/adr/0043-*.md:6,133`；ADR-0062 trigger 原文取自其 frontmatter `:5-11`。

## Architecture Notes _(mandatory)_

### Testing Invariants（三条硬约束；第一条由 lefthook `no-bad-mocks` 机器守）

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，不写 `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。
- **MANDATORY INTEGRATION**: 用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装微型 DI 容器，让被测组件在真实 lifecycle 中触发。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，在 integration test 文件中都有对应 `it()` 块。

### General Architecture Notes

> **ADR-0043 — Flat + Anemic + Moat.** 文件平铺 `apps/server/src/<module>/`；贫血 Prisma row；不建 Repository；业务不变量放 `*.rules.ts` 纯函数；跨 ctx 经目标模块的 use case / port。

### Impl Guardrails（仅留本 feature 适用条目）

- **并发 / 事务**：迁锚是单行状态转换，用 conditional UPDATE + affected-count（`updateMany where {ticker: old}` → count===1 won）。outbox 事件与迁锚写**同 tx**。
- **CLI 跑法**：prod 上 CLI 走 `docker compose run --rm`，起独立容器，不 `docker exec` 进 app 容器（共用 640m cgroup，一次 AppModule boot 实测吃宿主约 230MiB，见维护者 2026-09-15 #439 处置记录）。

#### D1 — 登记表（marketdata 自持）

- 新表 `marketdata.symbol_change`：市场、旧码、新码、生效日、事件类型（v1 仅 `rename`）、来源（`manual` / `candidate`）、证据（文本，存公告 URL 或观测记录）、登记人、登记时刻、撤销时刻 / 撤销人 / 撤销理由。
- 唯一性：部分唯一索引 `(market, old_code, effective_date) WHERE revoked_at IS NULL`。撤销后允许重新登记同一组参数，对应 FR-002 与 FR-003。
- 生效日用 `@db.Date`，语义是**交易所当地日历日**，与 `daily_bar.trade_date` 同一条轴（ADR-0066）。不存 UTC 时刻，也不做时区换算。
- 跟 `instrument` 不建外键：登记的是代码，不是行；新码在登记时可以还不存在（D5 第 4 步会补齐）。
- `MODEL_OWNERSHIP` 登记 `symbolChange: marketdata`。

#### D2 — 连续身份规则（纯函数 `marketdata/symbol-lineage.rules.ts`）

- `resolveLineage(registrations, market, code)` → 按日期升序的段列表 `[{code, from, toExclusive}]`。
  - 末段 = 查询码本身：起点是「它作为**新码**的最近生效日」（没有则不设下界），并且不早于「它作为**旧码**被改走的最晚生效日」。后一条是**回收防误拼**：PARA 改名后被回收，查 PARA 只取改名日之后（spec 分支 4、5）。
  - 往前回溯：每找到一条 `new_code = 当前段码` 的登记，就前接一段 `{old_code, from: 前一段起点, toExclusive: 生效日}`，直到没有更早的登记。链式 A → B → C 自然成立（分支 6）。
  - 新码在生效日之前的自有数据，因为段起点 = 生效日，自然被排除（分支 7）。
- `validateRegistration(existing, candidate, today)`：拒绝旧码 = 新码、生效日晚于今天（交易所当地日）、重复、成环、与已有段区间重叠（分支 9、10、FR-008）。跨市场在入参类型上就排除了：两个码共用一个 market 字段。
- 复杂度：登记总数 n 很小（年个位数），回溯 O(链长 × n)，不建索引结构。

#### D3 — 日线拼接（唯一拼接点 `get-instrument-bars.usecase.ts`）

- 核对过的事实：K 线由 mobile 直调 marketdata 的 bars 端点（`apps/mobile/src/optionsdesk/use-underlying-detail.ts:84`），服务端只有 `get-instrument-bars.usecase.ts:47-61` 这一处按 `(market, code)` 解析标的再查 `daily_bar`。
- 改法：在 `:47` 解析出 lineage → 对每段解析 instrument id（段码在标的表里不存在就跳过该段）→ 每段按 `[from, toExclusive)` 与查询窗求交，再查 `daily_bar` → 按日期拼接。
- 复权：`adjustmentFactor` 改为对**所有段的 instrument** 取 `exDate` 落在本段区间内的版本，合并后交给 `deriveAdjustedBars`。改名不改股本，所以合并因子事件序列成立（spec Assumptions）。
- 无登记时，lineage 只有一段且不设下界，走原路径逐条一致（分支 3、SC-003），由反例臂钉住：无登记 fixture 上新旧实现结果深等。
- `freshnessTier` 与 `asOf` 不变，仍取末根 bar。
- **不改的读点**（v1 范围外，逐条写明是故意的）：`get-instrument-detail.usecase.ts:47-51`、`eod-backed-quote.adapter.ts:41`（都取最近一根，属于新码自身）、`alert/evaluate-alerts.usecase.ts:217`（alert 面向 A 股）、`anchor-factors.ts:199`。

#### D4 — IV 核对拼接

- 核对过的事实：上屏的 IV 分位是 vendor 值（`dimension-executor.ts:515`；详情页 `get-underlying-detail.usecase.ts:180` 只取最近一行）。自算 IVP 只在 `crossCheckIvPercentile`（`:3333-3340`）里做交叉核对、只写日志。
- 改法：`:3340` 的 `underlyingIvHistory.findMany({instrumentId})` 改为按 D2 的 lineage 取各段历史再拼接，窗口仍是 252（`underlying-iv.rules.ts:50`）。
- 价值说明（已写进 spec Q3 amend）：只让改名后的交叉核对不再因样本不足而失效，**屏幕上的数字不变**。

#### D5 — 修正命令：CLI 编排（optionsdesk）

- 位置：`optionsdesk/symbol-change.cli.ts` + `optionsdesk/remediate-symbol-change.usecase.ts`。编排必须放在 optionsdesk：marketdata 不能 import optionsdesk，反方向已有先例（`create-anchor.usecase.ts:245` 注入 `EnsureLatestEodBarUseCase`）。
- 注入（各带 `// CROSS-CONTEXT-SYNC:`）：marketdata 的 `RegisterSymbolChangeUseCase` / `RevokeSymbolChangeUseCase`（D1 / D2 新增）、`EnsureInstrumentUseCase`（D5 第 4 步新增）、`AnchorDrivenSyncGate`、`GetInstrumentBarsUseCase`（验证用）。后两者今天只在 providers（`marketdata.module.ts:702`）、不在 `exports`（`:892` 起），本片加进 exports；漏了的话，optionsdesk 注入时 boot 才会炸（同文件 `:879` 注释）。
- 五步，每步先读状态判「已完成 ⇒ 跳过」，满足幂等可续跑（FR-013、分支 14、15）：
  1. **登记**：已有同参数未撤销登记 ⇒ 跳过。
  2. **迁锚**：新 use case `migrate-anchor-ticker.usecase.ts`（进 `WRITE_ALLOWLIST.anchor`）。旧码无锚 ⇒ 跳过；新码已有锚 ⇒ 报冲突并**停在这一步**（分支 17）。迁移在同一个 tx 内做四件事：
     - conditional UPDATE：`ticker` 改新码，`last_close` / `intraday_*` 清空（那是旧码的价，旧码已经取不到价），`next_review` 设为**上海日的昨天**以进入复核逾期（FR-017，复用 `isAnchorOverdue`，`review-anchor.usecase.ts:69`）。取上海日是为了与逾期判定同轴：锚列表的 `today` 是 `shanghaiDateOnly(new Date())`（`list-anchors.usecase.ts:110`，`:83` 注释写明 `today` 跟用户所在地走），取交易所当地日只是碰巧对、不是同轴；
     - 写 `anchor_change`，`changedFields: ['ticker', 'nextReview']`（`ticker` 本就是追踪字段，`anchor-history.ts:35` 的 `ANCHOR_TRACKED_FIELD_KINDS.ticker`）；
     - 发布 `optionsdesk.anchor-created` 事件（`create-anchor.usecase.ts:236,317` 同名同形），让 marketdata 冷启动为新码**补历史数据**。标的行不靠它补：冷启动经 outbox 异步执行，第 4 步立即重算采集闸时标的行可能还不存在（analyze F1）。
     - 这个事件有两个订阅者：冷启动 `anchor-cold-start.subscriber.ts:15`、券商历史回补 `broker-history-backfill.subscriber.ts:44`。**首个 task 先核对两者对「同一 ticker 二次投递」幂等**，不幂等就改发专用事件，不复用。
  3. **驳回待审提交**：读 `anchor_submission` 里旧码的 PENDING 行 → 交给既有 `RejectAnchorSubmissionsUseCase`（`reject-anchor-submissions.usecase.ts:30`），驳回理由写「代码已改为 <新码>」。
  4. **采集范围**，按顺序三件事：
     - **先同步补齐新码标的行**（分支 16）：调 marketdata 新增的 `EnsureInstrumentUseCase`（`ensure-instrument.usecase.ts`），复用 `seedInstrumentCreateData`（`sync-universe.usecase.ts`，冷启动 `anchor-cold-start.usecase.ts:413` 的 upsert 用的是同一份 seed）。已存在 ⇒ 跳过。今天唯一会建标的行的地方是冷启动那处 upsert，`ensure-latest-eod-bar.usecase.ts` 不建行，所以要新增这个 use case。
     - 再调 `AnchorDrivenSyncGate.recalcSafely()` 立即重算（不等下一轮 fact 维度）。us 由锚驱动，旧码自动关闸、新码开闸。
     - hk / cn 不受锚驱动（`anchor-driven-sync-gate.ts:18`；`sync-universe.usecase.ts:164` 默认全量采集），旧码会留在采集范围里。已定结论：**无害**（2026-10-16 prod POC，见 tasks T013）—— 理杏仁批量接口对未知 / 旧码静默略过、同批照常返回。本步对 hk / cn 不写 `needSync`、不写 `sync_blacklist`（后者只挡 universe 新建，对已存在行本就无效），只在报告里写明「该市场采集范围不随锚变化」。
  5. **验证**（只读）：旧码不再出现在锚表；新码锚存在并处于复核逾期；新码标的行存在、`need_sync`（仅 us）为真；对新码调 `GetInstrumentBarsUseCase`，报告首末日期和**缺口数**（按交易日历比对）。收盘价要等下一个取价周期，报告写「待下一拍」，不阻塞命令。
- 撤销（FR-015、分支 18）：逆序执行 —— 迁锚回旧码并恢复原 `next_review`（从 `anchor_change` 的 before 值取）→ 撤销登记 → 重算采集闸（第 4 步不写 `sync_blacklist`，无需删除；2026-10-16 prod POC，见 tasks T013）。补齐的新码标的行不删：标的行是全市场清单的一部分，universe 同步本来也会建它。驳回的待审提交**不复原**（驳回零副作用，`anchor-submission.controller.ts` 注释原文），在报告里写明。
- 报告：每步一行，`ok` / `skipped(原因)` / `failed(原因)` / `conflict(原因)`；失败即停，退出码非零。
- 预览模式（默认，FR-012、分支 12）：五步都只做「读状态 + 推算将要做什么」，零写入；由 IT 断言预览前后全表行数与 `updated_at` 不变。

#### D6 — ops 包装脚本（`ops/bin/symbol-change.sh`）

- 子命令：`apply <market> <old> <new> <effective> --evidence <text>`、`revoke …`、`candidates`、`dismiss <id> --note <text>`。
- 不带 `--confirm` 时只跑预览并打印复述表，带 `--confirm` 才写（同 `anchor-approve.sh:294-334`）。
- 执行面：ssh 到 app 主机 → `sops exec-env … docker compose … run --rm -T --no-deps --entrypoint node app dist/optionsdesk/symbol-change.cli.js …`（与部署 B2 闸同形，`ops/runbook/prod-deploy-rollback.md:12`）。**CLI 在容器内直连 DB，不走 HTTP、不需要 JWT** ⇒ FR-016 满足，也不用再碰签名密钥。
- 主机与凭据路径从 `~/.nvy/fleet.env` 取，不写进脚本（`check-identifier-boundary.ts` 拦）。

#### D7 — 端口返回形态：带出「未知代码」

- `marketdata/realtime-quote.port.ts:117` 的 `fetchQuotes` 返回值由 `Map` 改为 `{ quotes: Map, unknownSymbols: string[] }`。
- 波及面（2026-10-16 `rg -n 'fetchQuotes\(' apps/server/src` 实数）：实现 2 个（`futu-realtime-quote.adapter.ts:93`、`market-routed-realtime-quote.adapter.ts:41`）；消费 2 个（`sync-anchor-last-close.ts:293`、`sync-anchor-intraday.ts:360`）。alert 有自己的端口（`alert/realtime-quote.port.ts:17`），不受影响。
- 前置依赖：PR #495（shim 返回 `unknown_codes`，adapter 读出并 warn）。本片在其上把 warn 升级为返回值；#495 未合并则本片阻塞在这一步。

#### D8 — 疑似改名候选（optionsdesk 自持）

- 新表 `optionsdesk.symbol_change_candidate`：ticker、信号类型（v1 仅 `vendor_unknown`）、新码建议（json，最多 3 个）、首次 / 最近观测时刻、状态（`PENDING` / `CONFIRMED` / `DISMISSED`）、处置时刻与备注、确认后关联的登记 id（逻辑引用，不建外键）。`MODEL_OWNERSHIP` 登记 `symbolChangeCandidate: optionsdesk`。
- 产生点：`sync-anchor-last-close.ts` 每拍拿到 `unknownSymbols` 后 upsert 候选。已有 PENDING ⇒ 只刷新最近观测时刻；已有 DISMISSED ⇒ 不再生成（分支 24）。这里只放 last-close 一处：它每 10 分钟一拍，盘中采集每 30 秒一拍，放盘中只会多写。
- 新码建议：纯函数 `optionsdesk/symbol-candidate.rules.ts`，对同市场 `instrument` 做名称分词交集打分（`// CROSS-CONTEXT-READ:` 只读 name / code）。取不到任何建议 ⇒ 标「代码失效」，CLI 拒绝以无新码的候选执行 apply（分支 22）。
- 确认（分支 23）：`symbol-change.sh apply --from-candidate <id> --new <code> --effective <date>` = 以候选参数走 D5 预览；`--confirm` 写入时同 tx 把候选翻 CONFIRMED 并记登记 id。
- 否决：`dismiss` → `DISMISSED`，带备注。

#### D9 — 通知

- server 侧没有飞书出口（`apps/server/src` 零 feishu 引用），告警一律走 `ops/jobs/*` 探针 + `ops/lib/nvy-run-reported.sh`。
- `ops/jobs/app-state-health.sql` 新增判据：存在 PENDING 候选 ⇒ exit 1，summary 加 `symbol_candidates=<n>⚠疑似改名:<tickers>`。沿用该探针每 4 小时一次的节奏，不新建调度。
- 与 PR #495 改的是同一个文件（判据 ①'），本片在 #495 合并之后再 rebase。

#### D10 — 治理随 PR

- `check-server-moat.ts`：`MODEL_OWNERSHIP` 加两张表；`WRITE_ALLOWLIST.anchor` 加 `migrate-anchor-ticker.usecase.ts`。新增的跨 ctx 注入点各带注释（Check 2 硬扫）。
- 两条迁移：两张新表 + 部分唯一索引。都是纯新增，可逆（drop）。

### 测试映射（`state_branches` 24 条 → 落点；analyze 期逐条 grep 对账）

| 层 | 文件 | 覆盖的 `state_branches` 序号 |
| --- | --- | --- |
| Server Small | `marketdata/symbol-lineage.rules.spec.ts` | 4, 5, 6, 7, 9, 10, 11 |
| Server Small | `optionsdesk/symbol-candidate.rules.spec.ts` | 21, 22 |
| Server Medium | `test/integration/marketdata-086.bars-splice.it.spec.ts` | 1, 2, 3, 8（含无登记深等反例臂） |
| Server Medium | `test/integration/optionsdesk-086.remediate.it.spec.ts` | 12, 13, 14, 15, 16, 17, 18, 19, 20 |
| Server Medium | `test/integration/optionsdesk-086.candidate.it.spec.ts` | 21, 22, 23, 24 |
| Server Medium | `test/integration/app-state-health.it.spec.ts`（扩） | 21 的通知半 |

**SC 落点**：
- SC-001 = prod 验收：PSKY → SKYD 真跑后看 K 线首根是否为 2019-12-05、缺口数是否为 0，由 CLI 第 5 步报告直接给出。
- SC-002 = lineage 规则回收臂 + bars IT 回收 fixture。
- SC-003 = bars IT 无登记深等臂。
- SC-004 = 读时拼接无缓存，登记 / 撤销即时生效，由 IT 断言；「1 个采集周期」是上界，实际是零延迟。
- SC-005、SC-006 = prod 验收，维护者计时。
- SC-007 = remediate IT 重复执行臂（分支 15）。

### 新增 / 触碰文件清单（tasks 拆分的物料面）

- **marketdata 新增**：`symbol-lineage.rules.ts`（+ spec）、`register-symbol-change.usecase.ts`、`revoke-symbol-change.usecase.ts`、`ensure-instrument.usecase.ts`
- **marketdata 触碰**：`get-instrument-bars.usecase.ts`（D3）、`dimension-executor.ts`（D4，单点）、`realtime-quote.port.ts` + `futu-realtime-quote.adapter.ts` + `market-routed-realtime-quote.adapter.ts`（D7）、`marketdata.module.ts`（export）
- **optionsdesk 新增**：`migrate-anchor-ticker.usecase.ts`、`remediate-symbol-change.usecase.ts`、`resolve-symbol-candidate.usecase.ts`、`symbol-candidate.rules.ts`（+ spec）、`symbol-change.cli.ts`
- **optionsdesk 触碰**：`sync-anchor-last-close.ts`（D7 消费 + D8 产生候选）、`sync-anchor-intraday.ts`（D7 消费）、`optionsdesk.module.ts`
- **schema**：`prisma/schema.prisma` + 2 条迁移
- **ops**：`ops/bin/symbol-change.sh`、`ops/jobs/app-state-health.sql`（D9）
- **治理**：`scripts/checks/check-server-moat.ts`
- **IT**：上表 4 个文件

## Complexity Tracking

无原则违背。值得 review 留意的取舍：

| 改动 | 为什么需要 | 更简单的替代为何不行 |
| --- | --- | --- |
| 读时拼接，而不是把旧码数据迁到新码 instrument 下 | 撤销零副作用（FR-006）；误登记不造成不可逆损失 | 写时迁移要改 29 张外键表里的 instrument_id，误登记后无法干净回滚 |
| 编排放在 optionsdesk 的 CLI，而不是 marketdata | 五步里有三步写 optionsdesk 的表，而 marketdata 不能 import optionsdesk（eslint 拦） | 拆成两个命令就违背了「一条命令」（US5） |
| CLI 在容器内直连 DB，不走 HTTP | 不需要任何 token（FR-016），也不用每次去碰签名密钥 | 走 HTTP 就得给运维脚本发长期凭据，或者沿用 PSKY 那次的现签 JWT，后者曾被 auto-mode 按凭据探查拦下 |
| 端口返回形态变化（D7） | 候选需要「未知代码」这个信号，而它只在取价时出现 | 另起一个探测 job 再打一次 vendor，要多耗限频额度，信号也更晚到 |
