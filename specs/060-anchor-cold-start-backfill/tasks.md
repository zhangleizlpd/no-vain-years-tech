---
feature_id: 060-anchor-cold-start-backfill
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-08-17'
updated_at: '2026-08-17'
---

# Tasks: 060-anchor-cold-start-backfill（锚首建冷启动补数 —— 建锚即补最近一场收盘的链 / 快照 / 日线）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0033`](../../docs/adr/0033-outbox-cross-context-comm.md)（跨 ctx 异步）+ [`ADR-0049`](../../docs/adr/0049-marketdata-scheduler-bullmq-hybrid.md)（采集执行层）+ [`ADR-0062`](../../docs/adr/0062-optionsdesk-bounded-context.md)（期权台 ctx）
**Branch**: `060-anchor-cold-start-backfill`

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。体例沿 059。
- 层级：本片**只有** `[Server]`。零端点 ⇒ 无 `[Contract]`；零前端 ⇒ 无 `[Mobile]` / `[Contract-Smoke]`；零部署面 ⇒ 无 `[Ops]`。

## Path Conventions

| 用途                                          | 路径                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 盘中时段表（**新建**，含 cn/us/hk）           | `apps/server/src/marketdata/market-session.rules.ts`                                                            |
| 盘中时段表原址（**改：删本地副本改 import**） | `apps/server/src/alert/intraday-eval.processor.ts` + `apps/server/src/alert/intraday-eval.processor.it.spec.ts` |
| 三元组决策 + 市场能力登记（**新建**）         | `apps/server/src/marketdata/anchor-cold-start.rules.ts`                                                         |
| 冷启动编排 use case（**新建**）               | `apps/server/src/marketdata/anchor-cold-start.usecase.ts`                                                       |
| outbox 消费方（**新建**）                     | `apps/server/src/marketdata/anchor-cold-start.subscriber.ts`                                                    |
| 队列入队面 + worker 路由（改）                | `apps/server/src/marketdata/marketdata-sync.worker.ts`                                                          |
| 模块接线（改）                                | `apps/server/src/marketdata/marketdata.module.ts`                                                               |
| 事件生产（改：事务内 publish 一行）           | `apps/server/src/optionsdesk/create-anchor.usecase.ts` + `apps/server/src/optionsdesk/optionsdesk.module.ts`    |
| 指针注释（改：一行指向新时段表）              | `apps/server/src/marketdata/trading-day-gate.ts`                                                                |
| 边界注册                                      | `scripts/checks/check-server-moat.ts`（`MODEL_OWNERSHIP`）                                                      |
| DB                                            | `apps/server/prisma/schema.prisma`（`marketdata` schema 已存在，**不动** `schemas` 数组）                       |
| IT                                            | `apps/server/test/integration/marketdata.cold-start-060.{trigger-timing,market-outcome}.it.spec.ts`             |

🚨 **文件平铺**（ADR-0043）—— `apps/server/src/marketdata/` 与 `src/optionsdesk/` 下 **MUST NOT** 建任何子目录。

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **敏感档 MUST NOT 复用 `SyncOptionSnapshotUseCase.run()`** —— 它写死 `sessionDate = marketDateFor(dim.marketScope, input.now)` + `mode = SNAPSHOT_SOURCE_EOD`（`sync-option-snapshot.usecase.ts:182-188`）。在盘前窗口（北京 18:00 那一档）它会把 `sessionDate` 标成**今天**（尚未收盘的那天）。**唯一**能显式指定的入口是 `collect(instruments, spec, stats)`（`:206`）。这条踩了当天全绿，错行要靠人工数 SQL 才发现。
2. **`oiAsOf` 两条路径不许抹平** —— `sync-option-snapshot.usecase.ts:196-204` 原文：抹平后永远不会红，但两条路径产出的 OI 差一天，而活跃度排名与 UI 的 `asOf` 都读它。
3. **起手复判的判据是「该标的该交易日的数据在不在」，不是「这只锚做过没有」** —— 且 **MUST NOT 反过来读 `anchor_cold_start_run` 当判据**。那张表是审计面不是真相源；按锚判在锚区分用户后会把同一份共享行情拉 N 遍（FR-016a）。
4. **运行记录 PK 是 `anchor_id` 不是 ticker** —— 写成 ticker 今天也全绿（一标的至多一锚），锚一旦区分用户就两行撞一起互相覆盖（FR-026a）。
5. **subscriber 的「抛 / 不抛」方向相反，写成一条会各错一半** —— payload 形状不符（毒丸）→ `logger.error` + **return 不抛**（抛了 relay 每 10s 重投同一条，永久卡死并挡住**所有 ctx** 的后续事件，`enqueue-requirement.subscriber.ts:49-54` 是原文教训）；入队失败（Redis 不可达）→ **抛**（那不是毒丸，下轮重投才对；吞掉会把事件标 published 而冷启动永久丢失）。
6. **新 job 必须进既有 `marketdata-sync` 队列** —— 那条 `concurrency=1` 是限频的唯一支柱。另起队列 = 冷启动与夜间批并发打 vendor，表现为间歇性 429 而不是报错。
7. **`DimensionJobPayload` 一个字段都不加** —— 想给它加 `codes` 收窄工作集会给「工作集选择」开第二个口子，正是 `anchor-driven-sync-gate.ts:50-55` 那条绊线注释（`needSync` 是受保护列、只有两个合法写入点）警告的形态。
8. **seed → 开闸 → 载工作集，顺序不能反** —— gate 只认**已存在**的 Instrument 行；反了会静默拿到空工作集，run 全绿而一行没采。
9. **新表不登记 `MODEL_OWNERSHIP` 会被 `moat-unmapped` 硬拒** —— 且报错指向探针不指向你的表，第一次撞会以为探针坏了。
10. **事件类型字面量两侧各写一份、禁 import** —— `eslint.config.mjs:190-204` 的 `from: marketdata` disallow 含 `optionsdesk`，import 会被 boundaries 拦。靠 IT 钉住二者相等，不靠人眼。
11. **只在 `CreateAnchorUseCase` 里 publish 一次** —— `ImportAnchorFromModelUseCase` 的 create 分支是**委托**它（`import-anchor-from-model.usecase.ts:130`）。在 import use case 里再 publish 一遍会双发，而双发的表现只是多跑一轮零外呼的 job，**不会红**。
12. **`optionsdesk` 是本片唯一被改的业务 ctx，且只加一行 publish** —— `update-anchor` / `review-anchor` / `set-position-bucket` / `delete-anchor` 一个字都不动（FR-003）。
13. **`marketdata` 的 PG schema 已存在** —— 新表只是往里加一张，**不要**动 `schema.prisma:9` 的 `schemas` 数组。
14. **migration 目录名走 wrapper** —— `pnpm db:migrate "add anchor cold start run"`，lefthook 正则 `^[0-9]{8}_[0-9]{4}_[a-z][a-z0-9_]*$` 硬拦手拼的名字。

## Phase 1: 纯函数（阻塞其余）🎯

- [X] T001 [P] [Server] **per-market 连续竞价时段表**（FR-010, FR-011, FR-022, plan §D6）：新建 `marketdata/market-session.rules.ts`，把 `alert/intraday-eval.processor.ts:39-88` 的 `MARKET_SESSION` / `marketNow` / `isWithinTradingSession` 三个导出**原样搬来**，并补登记 `us`（09:30–16:00 ET）与 `hk`（09:30–12:00 + 13:00–16:00 HKT，午休分两段）。走 `Intl` 不手工偏移；未登记市场 `marketNow` 仍 **throw**。**顺带**在 `trading-day-gate.ts` 的 `MARKET_CLOSE_MINUTES` 注释旁加一行指向本文件（那条注释现写「盘中时段表是另一件事，归各消费方」—— 现在有了唯一落点，不指过去下一个人还会再造第三份）。→ verify: 新建 `market-session.rules.spec.ts` —— cn 原有断言逐条搬过来全绿（回归）；新增 us 开收盘边界各一（含 DST 前后两个时刻，断言同一本地分钟数在夏令/冬令都判对）；hk 两段闭区间（12:00 上午收判 `true` —— 同 cn 的 11:30；**12:30 午休正中**判 `false`；13:00 判 `true`）；一个仍未登记的市场代号（用 `sg`）`marketNow` 抛 `/未登记盘中时段/`

  > 🚨 **impl 期修正（2026-08-17，user 定案）—— 本 task 在原三个导出之外多加一个 `isSessionUnderway(market, minutesOfDay)`**：判据是「**该场进行中**」（自首段开盘至末段收盘，**含**午休），未登记市场**抛**（fail-closed —— 它每返一个 `false` 都意味着「可以写快照」，未知即抛）。`isWithinTradingSession` 的字面语义与未登记返 `false` 的行为**原样不动**（alert 侧零影响）。
  >
  > **起因是个真缺口，不是风格调整**：`isWithinTradingSession` 在午休返 `false`，而 T006 原文拿它当敏感档的闸 ⇒ **午休时放行**；此刻 `lastClosedSessionCutoff`（未过收盘）给出的目标日又是**上一个交易日** ⇒ 走 plan §D4 表第三行 `premarket_backfill`，把午休时刻的盘口贴上「上一场收盘」的标签写进库。正是 FR-011 与 `state_branches` ③ 要防的那条错行：**不报错**、按唯一键占位、当晚正确的行反被挡掉 ⇒ 永久缺口。
  >
  > **今天它是潜伏的**：唯一开通期权采集的市场是 `us`，而 us 无午休 ⇒ 两个谓词在它身上逐点等价。spec 里有一条**逐分钟等价断言**把「为什么潜伏」钉住，接 hk 期权那片时它会第一个红。⇒ 闸的改动落在 T006。
  >
  > 原 verify 写的「hk 午休 12:00 判 `false`」与本 task 自己要求的「cn 断言原样搬」相冲突（cn 的 11:30 上午收在闭区间下判 `true`，hk 的 12:00 同理），故例子改取 12:30 —— 修这个笔误时才牵出上面的缺口。

- [X] T002 [Server] **alert 改 import，删本地副本**（plan §D6）：`alert/intraday-eval.processor.ts` 删掉那三个导出，改从 `../marketdata/market-session.rules.js` re-export 或直接 import；`INTRADAY_MARKET = 'cn'` **留在 alert**（那是 alert 的策略不是时段表的事）。→ verify: `nx test server alert/intraday-eval.processor.it.spec.ts` 绿。🚨 **该文件 `:67-69` 会红且是真实语义变更** —— 它拿 `us` 当「未登记市场」的例子断言 `toThrow(/未登记盘中时段/)` 与 `isWithinTradingSession('us', 600) === false`，而 `us` 现在已登记。**把例子换成仍未登记的 `sg`，不要删断言**（那条断言守的是「禁静默套用别人的时窗」，仍然要守）。另跑 `nx lint server` 确认 boundaries 放行（`from: alert` 的 disallow 未列 `marketdata-rules`，应当零告警 —— 若红说明 `market-session.rules.ts` 的文件名没落进 `src/marketdata/*.rules.ts` 这个 `mode:'full'` 元素）

  > 📌 **实现时对「不要删断言」做了归属上的偏离（impl 期记录）**：那三条纯时窗断言（cn 逐点 / `marketNow` 的 Intl 与跨日 / 「未登记市场抛」）**整体移到** `market-session.rules.spec.ts`（T001 已落，未登记市场的例子用的正是 `sg`），alert 的 IT 里**只留一条** —— 拿 `INTRADAY_MARKET` 断言「美东盘中时刻不在本通路时段内」。**断言一条没少，换的是归属**：① 表搬到哪、表的测试就在哪，否则同一组断言两处各半、改一处漏一处；② alert 那个文件是起 Redis 容器的 `.it.spec.ts`，纯函数断言挂在 Medium 档里本就是 size 分类学的味道。
  >
  > 连带：该 `it()` 的标题「复用本通路做美股必须先登记时段」已失准（us 现已登记），改为「登记了 us 不代表这条通路会跑它」—— 支不支持美股取决于 `INTRADAY_MARKET` 与 tick 拓扑，不取决于时段表。`INTRADAY_MARKET` 的 JSDoc 同步去掉了「给该市场登记时段」这半句。

- [X] T003 [P] [Server] **三元组决策 + 市场能力登记**（FR-006, FR-008, FR-014, FR-023, FR-024, plan §D4）：新建 `marketdata/anchor-cold-start.rules.ts`。① `resolveSnapshotSpec(...)` 纯函数（入参形状由实现定，**硬约束只有两条：零 I/O**「日历查询由调用方做完喂进来」、且**必须显式收 market**，禁带默认值的可选入参 —— 同 `trading-day-gate.ts:173` `OPTION_EXCHANGE_SCOPE` 上方那条禁令），按 plan §D4 那张四行表返 `{ sessionDate, source, oiAsOf }` 或「放弃」；② `COLD_START_CAPABILITY: Record<string, {...}>` 市场能力登记表（`us` 登记链 + 日线 + 快照三档，`hk` 空表项）；③ 结局值域常量（八种，FR-027）。**零 I/O** —— 日历查询由调用方做完喂进来。→ verify: `anchor-cold-start.rules.spec.ts` —— plan §D4 逐条对表的四行各一个 `it()`（周六 10:00 / 周一 10:00 / 周一 18:00 / 周二 10:00 北京）；**外加与 `option-snapshot-remediation` 的等值回归**：喂北京 08:00 与 18:00 两个时刻，断言算出的三元组与既有 ①/② 级（`option-snapshot-remediation.ts:113` / `:159`）逐字相同 —— 那两个时点是这条规则的锚，谁改坏了立刻红

## Phase 2: 数据面

- [X] T004 [Server] **`anchor_cold_start_run` 表 + migration + 边界登记**（FR-026, FR-026a, FR-027, FR-028, plan §D7）：`schema.prisma` 的 `marketdata` schema 加 `model AnchorColdStartRun`：**PK = `anchorId BigInt`**（逻辑引用不建 FK，体例同 `AnchorChange`），`ticker` / `lastRunAt` / `outcome`（贫血 `VarChar`，不建 PG enum）/ `reason`（`Text?`）/ `targetSession`（`Date?`）。**索引只建 PK**（日均个位数、查询形状就是按 anchorId 点查）。migration 走 `pnpm db:migrate "add anchor cold start run"`。`scripts/checks/check-server-moat.ts` 的 `MODEL_OWNERSHIP` 加 `anchorColdStartRun: 'marketdata'`。→ verify: `pnpm --dir apps/server exec prisma generate` 过；`pnpm tsx scripts/checks/check-server-moat.ts` 绿（**先故意不登记跑一次，确认 `moat-unmapped` 会红**，再补上 —— 不然这道闸是否真生效无从得知）；migration 目录名过 lefthook 正则

## Phase 3: 编排

- [ ] T005 [Server] **冷启动编排骨架**（FR-006, FR-007, FR-009, FR-016, FR-016a, FR-020, FR-021, FR-022, FR-023, FR-025, plan §D3 §D5 §D9）：新建 `marketdata/anchor-cold-start.usecase.ts`。按 plan §D3 的 8 步走到第 5 步为止（**先不接采集**）：解析 market → 查能力登记表 → 定位目标交易日（走 `TRADING_CALENDAR_PORT` **查日历**，禁时区推导）→ Instrument 缺行则 seed → `AnchorDrivenSyncGate.recalcSafely()` → **起手复判**（查 `optionDailySnapshot` / `dailyBar` 本身，🚨 **不读 `anchorColdStartRun`**）→ 落运行记录。→ verify: `anchor-cold-start.usecase.spec.ts`（纯单测，stub 日历与 Prisma）覆盖：ticker 不可解析 / 市场未登记时段 / 市场未开通采集 / 日历缺行 四条早退分支各自的结局值；且**每条早退都断言 vendor port 零调用**

- [ ] T006 [Server] **分档执行接线**（FR-010, FR-011, FR-012, FR-012a, FR-014, FR-018, plan §D8）：补齐 §D3 的第 6-7 步。非敏感档：`MarketdataSyncQueue.enqueueFlow` 组树入队 `sync:option_contract` + `sync:us_equity_bar`（普通 delta，**不传 `asOf`**），flow 保证链 → 快照次序。敏感档：**`isSessionUnderway` 判「该场进行中」（含午休）** ⇒ 结局 `intraday_skipped` 直接返回（🚨 **MUST NOT 用 `isWithinTradingSession`** —— 它在午休返 `false` ⇒ 放行写快照，理由见 T001 的 impl 期修正注）；否则 ⇒ 用 T003 的 `resolveSnapshotSpec` 算 spec，调 `SyncOptionSnapshotUseCase.collect(instruments, spec, stats)`。配额耗尽的两个具名错误（`OptionChainBudgetExhaustedError` / `OptionSnapshotBudgetExhaustedError`）**原样上抛给 job 层顺延**，不在此 catch 成失败。→ verify: 同文件 spec 加：盘中分支断言 `collect` 零调用且结局 `intraday_skipped`；**午休分支（取一个有午休的市场代号）同样断言 `collect` 零调用** —— 那是两个谓词唯一分道的一格；非盘中分支断言 `collect` 收到的 `spec` 与 T003 纯函数算出的**同一对象**（防有人在这里又算一遍）；配额耗尽分支断言错误被原样抛出、**未**写入 `outcome='retry_exhausted'`

## Phase 4: 事件链

- [ ] T007 [Server] **新 named job：入队面 + worker 路由**（FR-005, FR-017, FR-019a, FR-019b, plan §D3 §D10）：`marketdata-sync.worker.ts` 加 `ANCHOR_COLD_START_JOB = 'sync:anchor-cold-start'` 与其 payload 类型 `{ ticker: string; anchorId: string }`（**独立类型，`DimensionJobPayload` 一个字段不加**），`MarketdataSyncQueue` 加一个 `enqueueColdStart()`，worker 的 `job.name` 路由加一条分支指向 `AnchorColdStartUseCase`。`attempts` + 指数退避沿用 `jobOpts` 既有语义。`marketdata.module.ts` 注册新 use case。→ verify: `nx test server marketdata/marketdata-sync.worker.spec.ts`（若无则新建）断言：`sync:anchor-cold-start` 被路由到冷启动而**不**进 `DimensionExecutorRegistry`；既有 `sync:<dim>` 路由行为逐条不变（回归）；入队用的 queue 名等于 `MARKETDATA_SYNC_QUEUE`（防有人另起队列，Guardrail 6）

- [ ] T008 [Server] **outbox 消费方**（FR-004, FR-005, plan §D2）：新建 `marketdata/anchor-cold-start.subscriber.ts`，`implements OutboxSubscriber, OnModuleInit`，`eventType = 'optionsdesk.anchor-created'`（**字面量，禁 import optionsdesk**），`onModuleInit` 自注册进 `OutboxSubscriberRegistry`，`handle()` 只做「校验 payload → `enqueueColdStart()` → 返回」。🚨 抛 / 不抛按 Guardrail 5。`marketdata.module.ts` 注册。→ verify: `anchor-cold-start.subscriber.spec.ts` —— payload 缺字段 / 类型不符 ⇒ **不抛**且入队零调用且 `logger.error` 被调用；入队 reject ⇒ **抛**（用 `rejects.toThrow` 钉住方向，这是全片最容易写反的一处）

- [ ] T009 [Server] **事件生产：建锚事务内 publish**（FR-001, FR-002, FR-003, FR-004, plan §D1）：`optionsdesk/create-anchor.usecase.ts` 注入 `OUTBOX_PUBLISHER`，在既有 `$transaction` 内（写完锚行与 `anchor_change` 之后）`publish(tx, 'optionsdesk.anchor-created', { anchorId, ticker }, 'optionsdesk')`，上方标 `// CROSS-CONTEXT-ASYNC:`。`optionsdesk.module.ts` 确认可注入。**`import-anchor-from-model.usecase.ts` 一行不改**（Guardrail 11）。→ verify: `create-anchor.usecase.spec.ts` 加：建锚成功 ⇒ `publish` 被调用一次且四个实参逐个断言（尤其 `producerContext === 'optionsdesk'`）；建锚 409 冲突 ⇒ `publish` 零调用。`update-anchor.usecase.spec.ts` 全绿不改（FR-003 的回归）

## Phase 5: 端到端验证

- [ ] T010 [Server] **IT 上半：触发 / 时点归属 / 幂等**（FR-013, FR-015, FR-015a, SC-002, SC-003, `state_branches` ①②③⑥⑦⑧⑨⑩⑲㉓，plan Gate 0.1）：新建 `apps/server/test/integration/marketdata.cold-start-060.trigger-timing.it.spec.ts`（Testcontainers 真 PG，`Test.createTestingModule({ imports: [MarketdataModule] })` 装真 DI 容器，vendor port 用 stub 计调用次数）。注入固定 `now` 覆盖休市 / 盘中两档与 §D4 的三种时点归属。⚠️ **午休档蓄意不在这一层**：唯一开通期权采集的市场是 `us` 而 us 无午休，`hk` 在 `COLD_START_CAPABILITY` 里是空表项（走到就 `market_not_enabled` 提前返回，够不到快照分支）⇒ **午休分支端到端今天不可达**，在这里写它只会得到一个恒真 IT。它由 T001（谓词层）+ T006（use case 层）覆盖，接 hk 期权采集那片时再上提到本层。→ verify: `nx test server test/integration/marketdata.cold-start-060.trigger-timing.it.spec.ts --skip-nx-cache`（新文件首跑必加）。🚨 **两条硬断言**：① 盘中分支 `optionDailySnapshot.count()` **零变化**；② **「数据已在、`anchor_cold_start_run` 为空」⇒ vendor port 零调用**（直接插目标交易日的快照 / 日线行，不写任何运行记录，再触发）—— 谁把复判写成读运行记录，这条立刻红。🚨 **反恒真**：每条 `it()` 落地后**逐条注掉对应实现确认它真的变红**，再恢复 —— 恒真断言会让覆盖矩阵显示 24/24 而实际零保护（体例同 059 T007）

- [ ] T011 [Server] **IT 下半：市场参数化 / 失败重试 / 结局可区分**（SC-005, SC-007, SC-009, SC-010, `state_branches` ④⑤⑪⑫⑬⑭⑮⑯⑰⑱⑳㉑㉒㉔）：新建 `apps/server/test/integration/marketdata.cold-start-060.market-outcome.it.spec.ts`。覆盖：既有锚更新不触发、建锚回滚不留 outbox 行、日历缺行、Instrument 缺行 seed、hk 锚显式 no-op、未登记市场、ticker 不可解析、配额耗尽顺延、整体失败不回滚锚、八种结局各有唯一取值。→ verify: 同上命令。🚨 **一条硬断言**：**删锚后以同一 ticker 重建 ⇒ `anchorColdStartRun` 两行**（新 `anchorId` ⇒ 新行）—— 谁把 PK 写成 ticker，只会有一行，立刻红。🚨 **反恒真同 T010**：逐条注掉实现确认变红再恢复。⚠️ **不要写「两只锚指向同一标的」的用例**：`anchor.ticker` 是 `@unique`，今天在库里插不进去

- [ ] T012 [Server] **Verify Backend Physics — 真 app 启动冒烟**（ADR-0040 多层测试门）：跑 `scripts/ci/server-boot-smoke.ts`（Testcontainers PG + Redis 起真 Nest、发真 HTTP 探针）。本片新增一个自注册 subscriber + 一条 worker 路由 + 一个 use case，**DI 接错的表现是 boot 失败而不是任何单测红**。→ verify: 脚本退出码 0。🚨 **不许跳过、不许拆**（模板原文）；红了说明模块接线塌了，回滚 impl 而不是改断言

## Dependencies

```
T001 ──┬─→ T002（alert 改 import 必须等新文件存在）
       └─→ T006（敏感档的闸要 isSessionUnderway）
T003 ──────→ T006（分档要 resolveSnapshotSpec）
T004 ──────→ T005（编排要落运行记录）
T005 ──────→ T006 ──→ T007 ──→ T008 ──→ T009
T007..T009 ─→ T010 / T011（端到端要整条链在）
T010 + T011 → T012（boot smoke 收尾）
```

- **可并行起手**：T001 / T003 / T004（三个文件互不相干）。
- **T002 可随时插**（只要 T001 已落），但**不要拖到最后** —— 它会红一个既有测试文件，越晚发现越像是别的 task 弄坏的。

## 判据覆盖矩阵（`state_branches` 24 条 → task）

| #   | 分支（缩写）                                    | 覆盖 task          |
| --- | ----------------------------------------------- | ------------------ |
| ①   | 首建 + 休市 → 补三样、快照归属日正确            | T010               |
| ②   | 首建 + 连续竞价 → 补链+日线、不写快照           | T006 / T010        |
| ③   | 首建 + 午休段 → 同盘中                          | T001 / T006 ※      |
| ④   | 既有锚更新 → 不触发                             | T009 / T011        |
| ⑤   | 建锚事务回滚 → 不发起                           | T009 / T011        |
| ⑥   | 同一次建锚重复投递 → 第二次零外呼零新增         | T010               |
| ⑦   | 执行时常规轮已采齐 → 零外呼                     | T010               |
| ⑧   | `today === target` → 收盘采集口径               | T003 / T010        |
| ⑨   | `today > target` 且是交易日 → 盘前兜底口径      | T003 / T010        |
| ⑩   | `today > target` 且非交易日 → 仍取收盘口径      | T003 / T010        |
| ⑪   | 日历缺行 → 放弃 + 人工介入，不猜日期不落行      | T005 / T011        |
| ⑫   | 标的无 Instrument 行 → 先 seed                  | T005 / T011        |
| ⑬   | 市场未登记时段 → 显式跳过留记录                 | T001 / T005 / T011 |
| ⑭   | 市场未开通期权采集 → 显式无操作                 | T005 / T011        |
| ⑮   | ticker 不可解析 → 显式跳过                      | T005 / T011        |
| ⑯   | 配额耗尽 → 顺延不记失败不破坏已落               | T006 / T011        |
| ⑰   | 整体失败 → 建锚保持成功、不阻塞其他锚           | T011               |
| ⑱   | 与常规轮重叠 → 串行不并发                       | T007 / T011        |
| ⑲   | 连续建多只 → 各自触发；排队期间后一只复判零外呼 | T010               |
| ⑳   | 瞬时故障 → 有限次退避重试，耗尽升级             | T007 / T011        |
| ㉑  | 配额耗尽不消耗重试次数                          | T006 / T011        |
| ㉒  | 八种结局各有唯一取值、零折叠                    | T004 / T011        |
| ㉓  | 数据已在、运行记录为空 → 零外呼                 | T010               |
| ㉔  | 删锚后重建 → 运行记录两行                       | T004 / T011        |

**24/24 覆盖，零缺口。**

※ **③ 蓄意停在谓词层 + use case 层，不上 IT**（impl 期修正，2026-08-17）：唯一开通期权采集的市场 `us` **无午休**，而带午休的 `hk` 在 `COLD_START_CAPABILITY` 里是空表项、走到就提前返回 ⇒ 午休分支**端到端不可达**，在 T010 写它只会得到一个恒真 IT（正是 059 T007 立的反恒真纪律要防的）。同一条修正还给 T001 加了 `isSessionUnderway` 谓词、把 T006 的闸从 `isWithinTradingSession` 换掉 —— 详见 T001 下方的修正注。

## 自审：spec 有哪几层 / 扫了哪几层（per `sdd-authoring.md` 规则 ④）

spec 共 **7 层**可能藏需求的地方，逐层交代：

| 层                                          | 条数                       | 扫了吗   | 说明                                                                                                 |
| ------------------------------------------- | -------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| frontmatter `state_branches`                | 24                         | ✅       | 上方矩阵逐条映射                                                                                     |
| `## User Scenarios` 的 Acceptance Scenarios | 9（US1×3 / US2×4 / US3×2） | ✅       | 全部落在 T010 / T011；⚠️ 这一层是**已实证的系统性盲区**（046 实证两轮 analyze 全漏），故单独列出来数 |
| `### Edge Cases`                            | 12                         | ✅       | 与 `state_branches` 一一同源，无额外条目                                                             |
| Functional Requirements                     | 35                         | ✅       | 每条 FR 至少被一个 task 的括号引用；下方零覆盖登记列出**故意**不产 task 的                           |
| Success Criteria                            | 10                         | 部分     | 见下方零覆盖登记                                                                                     |
| `### Out of Scope`                          | 4                          | 故意不扫 | 排除项，不产 task 是定义使然                                                                         |
| `## Assumptions`                            | 8                          | 故意不扫 | 前提陈述，不产 task                                                                                  |

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

| 项                                   | 为什么不产独立 task                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SC-001**（30 分钟内补齐）          | 非硬性能预算（spec Assumptions 已声明），无 CI 门可挂；由 prod 实证时人工核，不造一个必然 flaky 的计时断言                                              |
| **SC-004**（并发调用数不超过常规轮） | **结构性保证**：复用同一条 `concurrency=1` 队列（T007 的 verify 已钉住「queue 名相等」）。造一个并发计数断言等于测 BullMQ 自己                          |
| **SC-006**（经既有完整性核对零告警） | 需要真实一天的快照分布，Testcontainers 里构造出来的合约集不具代表性 ⇒ 归 prod 实证                                                                      |
| **SC-008**（常规采集轮零变化）       | **结构性保证**：本片不改任何既有维度路径（Guardrail 7 钉住 `DimensionJobPayload` 不动）；回归由既有 `marketdata.dimension-executor.it.spec.ts` 全绿承担 |
| **FR-019c**（MUST NOT 实现合流）     | 「不做某事」无法用测试正向证明。由 CR 与 plan §D5 的否决记录承担                                                                                        |
| Out of Scope 四项                    | 定义上就是不做                                                                                                                                          |

## 单 PR 与上线顺序

**单分支单 PR**（Constitution §V）。零端点 ⇒ 无 api-client regen、无 mobile 面、无部署链改动。

上线后**第一个交易日**要人工核两件事（写进 PR body）：

1. 建一只**一次性新锚**（🚨 **不要拿既有锚跑** —— 导入会把 `confidence_source` 翻成 `model`，App 侧没有回头路，只能直连 DB 改列；这是 059 T011 的实证教训），核 `outbox_event` 该行 published → `anchor_cold_start_run` 出现该锚一行且 `outcome` 合理 → 该标的 `option_contract` 行数 0→N → `option_daily_snapshot` 的三列符合 plan §D4 表。
2. ⚠️ **判据横跨两个调度器**：`anchor.last_close` 由 `SyncAnchorQuoteScheduler`（每小时 `:30`，无 CLI 无端点）投影，采集侧补完不代表锚上立刻有价 —— **别把「投影还没跑」当成冷启动失败**（059 T011 已踩）。
