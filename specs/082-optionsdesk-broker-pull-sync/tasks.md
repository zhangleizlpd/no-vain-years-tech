---
feature_id: 082-optionsdesk-broker-pull-sync
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-09-14'
updated_at: '2026-09-14'
---

# Tasks: 082-optionsdesk-broker-pull-sync（期权台券商账户同步底座 · 拉取式）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **Analysis**: [`analysis.md`](./analysis.md)

**一句话**：futu-shim 加只读交易查询面 → server 侧一个同步 use case 承接「新建锚补齐」与「开盘前对账」两条持续行为，写进 optionsdesk 自有的 `broker_*` 表。上线时的一次性回填不是系统能力（T021）。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx; plan Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 即其验收，红→绿在同一 task 内闭环（Constitution §II）；新测试必须**定向变异证明能红**并留档。
- 层级：`[Shim]`（futu-shim Python，**另一条部署链**）/ `[Server]` / `[Server-IT]` / `[Docs]` / `[Gate]` / `[Ops]`。本片无 `[Contract]` / `[Mobile]`（server 零 endpoint 变更）。
- `state_branches n` = spec frontmatter `state_branches` 的**行序号**（1 起）。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**。

## Path Conventions

| 用途 | 路径 |
|---|---|
| shim 交易面（新） | `services/futu-shim/src/futu_shim/trade.py` |
| shim 路由 / 限频 / 配置（改） | `services/futu-shim/src/futu_shim/app.py`（`create_app` `:286`，`threads=4` `:812`）· `ratelimit.py`（`LIMITS` `:26-61`）· `config.py` · `deploy/install.sh`（非密收敛段 `:82-100`） |
| shim 复用的既有模式 | `opend.py`（`session()` `:97-109` · `_drop_ctx` `:277-297` · 限时探测 `:307-330`） |
| shim 测试 | `services/futu-shim/tests/test_trade.py`（新）· `test_app.py`（401 清单 `:273-309` · 部署探针对照 `:255-270`）· `test_ratelimit.py`（`:83`）· `test_readonly_guard.py`（新） |
| 共享时间解析（改） | `apps/server/src/marketdata/futu-option-snapshot.adapter.ts`（`NAIVE_DATETIME_RE` `:86` · `vendorTimeToDate` `:170`；另一消费方 `futu-realtime-quote.adapter.ts:135`） |
| 交易所当地时刻（改） | `apps/server/src/marketdata/session-clock.ts`（私有 `timeInTimeZone` `:97`） |
| 纯函数（新） | `apps/server/src/optionsdesk/broker-{code,scope,opened-at,position-sync,sync-slot}.rules.ts`（+ 同名 `.spec.ts`） |
| port / adapter / 约束档（新） | `apps/server/src/optionsdesk/broker-account.port.ts` · `futu-broker-account.adapter.ts` · `futu-shim-trade.constraint-profile.ts` |
| 正股判定（新，含跨 ctx 读） | `apps/server/src/optionsdesk/resolve-broker-underlying.ts` |
| 同步 use case / 调度器 / 订阅方（新） | `apps/server/src/optionsdesk/sync-broker-account.usecase.ts` · `broker-account.scheduler.ts` · `broker-history-backfill.subscriber.ts` |
| 模块装配（改） | `apps/server/src/optionsdesk/optionsdesk.module.ts`（`providers` `:61`） |
| 配置（改） | `apps/server/src/config/optionsdesk.config.ts` |
| 表 + 归属（改） | `apps/server/prisma/schema.prisma`（optionsdesk 段 `:1827` 起；部分唯一索引写法先例 `:2058`）· `scripts/checks/check-server-moat.ts`（`MODEL_OWNERSHIP` `:194-201`） |
| Server IT（新） | `apps/server/test/integration/optionsdesk-082.{resolve-underlying,broker-sync,broker-positions,backfill-scheduler,reconcile-scheduler,backfill-subscriber}.it.spec.ts`（隔离库 `apps/server/test/_support/isolated-db.ts` `setupIsolatedDb`） |
| 先例 | 调度器 `optionsdesk/sync-anchor-intraday.scheduler.ts`（mock 跳过 `:84-87`）· 订阅方 `marketdata/anchor-cold-start.subscriber.ts` · 跨 ctx 读 `optionsdesk/leg-retrieval.adapter.ts:254` |
| ADR 复审记录（改） | `docs/adr/0062-optionsdesk-bounded-context.md` §复审记录 |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **`acc_id` 永不出港机**：shim 映射层无条件剔除 `acc_id` 键；shim 日志、server 库 / 日志 / fixture 不得出现。fixture 里的账户号一律用明显假值（如末 4 位 `0000`）。
2. **只读铁律**：shim `src/` 出现 `unlock_trade` / `place_order` / `modify_order` / `place_combo_order` / `cancel_all_order` 即红（T003）。
3. **交易调用必须限时 + 限并发**：daemon 线程 `join(timeout)`；semaphore **非阻塞获取**（阻塞等待仍占 waitress 线程，等于没限）。
4. **时间解析只许复用 `vendorTimeToDate`**，🚫 不在 optionsdesk 另写；交易所当地时刻只许走 `exchangeClock`，🚫 不 import `market-session.rules.ts`（lint 禁）、🚫 不裸用 `Intl.DateTimeFormat`（`check-time-semantics` Rule B）。
5. **cron 字面量**：`@Cron('0 * * * * *', { timeZone: 'Asia/Shanghai', waitForCompletion: true })`；对账是否到点**只**按交易所当地 `minutesOfDay` 判 ⇒ 夏令时零特殊代码。🚨 **漏 `waitForCompletion` 会两拍并发**（cron 4.4.0 默认不等上一拍，plan D9）。
6. **防重入第二层在数据库**：对账记录部分唯一索引 `(connection_id, market, trading_date) WHERE kind='reconcile' AND status IN ('running','succeeded')`，插入冲突即本拍跳过 —— 🚫 只靠进程内选项。
7. **券商 HTTP 在事务外**（split-tx），持仓整体替换在**一个**事务内；认领待执行记录用 `updateMany` + affected-count，🚫 `FOR UPDATE` / Serializable。
8. **原子写，禁先查后写**：成交 `createMany({ skipDuplicates })`；订单先 `createMany({ skipDuplicates })` 再带 `vendorUpdatedAt < incoming` 条件 `updateMany`；订阅方 `createMany({ skipDuplicates })`，唯一键 `(connection_id, source_event_id)`；🚫 在 relay 线程执行补齐。
9. **跨 ctx 只读** `optionContract` / `instrument`，`// CROSS-CONTEXT-READ:` 挂在 prisma 调用正上方；🚫 任何跨 ctx 写。
10. **不写** marketdata `sync_run`（E14）。
11. **对账时点是两个常量**（美股 `09:10` / 港股 `09:05` 交易所当地），常量旁注明「POC-6 待复核」；🚫 散落第二处。
12. **注释出处**（`docs/conventions/comment-provenance.md`）：关于富途行为的注释（时间无时区、限频值、选户字段值域、基金户权限形态）一律 `EVIDENCE:` 指向 POC 实测观测值或官方文档页；拿不出出处的**不写**。
13. **新文件首跑带 `--skip-nx-cache`**（`implement-task-closure.md`）。

## Tasks

### Shim：只读交易查询面（US1 · US2 的数据来源）

- [X] T001 [Shim] **`TradeSupervisor`：常驻交易 context + 选户 + 限时限并发 + 剔除账户号**（FR-002, FR-003, FR-004, FR-019; plan D2, D13; state_branches 6, 7; US1/US2）：新建 `trade.py`。`TradeSupervisor(opend_supervisor, timeout_s, max_concurrency=2)`：`session()` 先进 `opend_supervisor.session()`（复用 unit 存活检查与 OpenD 拉起）再懒建 `OpenSecTradeContext(filter_trdmarket=TrdMarket.NONE, host, port)`；SDK 抛错或 `ret != RET_OK` 且错误属连接类 ⇒ 照 `_drop_ctx` 清引用 + daemon 线程 `close()`。`call(fn, **kwargs)`：① semaphore `acquire(blocking=False)`，失败抛 `TradeBusy` ② 在 daemon 线程执行、`join(timeout_s)`，超时丢弃 context 并抛 `TradeTimeout` ③ 返回前把 DataFrame 行转 dict 并**删除 `acc_id` 键**。`selected_account()`：`get_acc_list` 后按 `trd_env == REAL ∧ acc_status == ACTIVE ∧ trdmarket_auth ∩ {HK, US} ≠ ∅` 过滤，命中数 ≠ 1 抛 `AccountSelectionError(matched=n)`；命中结果缓存，context 重建时清缓存。`EVIDENCE:` 注释写明基金户权限只含 `HKFUND` / `USFUND`、`acc_type` 值域只有 `MARGIN` / `CASH`（2026-09-13 POC-1 原始输出观测值）。新 env `FUTU_TRADE_CALL_TIMEOUT_S`（默认 10）进 `config.py` → verify: 在 `services/futu-shim` 下 `python -m pytest -q tests/test_trade.py` 先红 → 绿，臂：① 10 户样本（照 POC-1 形态造：1 个综合户 + 4 模拟 + 5 停用含 2 个 `HKFUND` / `USFUND`）⇒ 选中唯一综合户 ② 0 户命中 ⇒ `AccountSelectionError(matched=0)` ③ 2 户命中 ⇒ `matched=2`，🚨 不取第一个 ④ 返回行不含 `acc_id` 键（FakeCtx 故意在行里放 `acc_id`）⑤ 挂死的 FakeCtx ⇒ `TradeTimeout` 且 context 被丢弃（下次调用重建）⑥ 已有 2 个调用在途时第 3 个立即 `TradeBusy`，🚨 断言它**不等待**（耗时 < 100 ms）⑦ OpenD unit 不活 ⇒ 交易 context 不被创建；定向变异留档：a. 去掉 `acc_id` 剔除 → ④ 红 · b. 选户改为取第一个 → ③ 红 · c. semaphore 改阻塞获取 → ⑥ 红

- [X] T002 [Shim] **四条交易路由 + 限频登记 + 401 / 部署探针清单 + 日志不含账户号**（FR-002, FR-003, FR-009, FR-019; plan D2, D12; state_branches 7; US1/US2）：`create_app(supervisor, gate, trade)` 注入 `TradeSupervisor`；在 `create_app` 内以字面量 `@app.get` 注册：`/trade/accounts`（回 `{trdmarket_auth, matched}`；2026-09-14 amend：去掉 `last4`）、`/trade/positions?market=US|HK`（`position_list_query(trd_env=REAL, acc_id=选中户, refresh_cache=True, position_market=…)`）、`/trade/deals?market&start&end`（`history_deal_list_query(deal_market=…)`；`end` ≥ 交易所当地今天时再合并 `deal_list_query(refresh_cache=True, deal_market=…)`，按 `deal_id` 去重）、`/trade/orders?market&start&end`（同形，`history_order_list_query` / `order_list_query`，按 `order_id` 去重）。参数校验：`market` 走既有 `_require_enum` 风格；`start` / `end` 解析失败或跨度 > 90 天 ⇒ `400`。异常映射：`AccountSelectionError` ⇒ `409 {"error":"account_selection","matched":n}`；`TradeTimeout` ⇒ `503 {"error":"trade_timeout"}`；`TradeBusy` ⇒ `503 {"error":"trade_busy"}`。`ratelimit.py` `LIMITS` 登记 `trade_acc_list` / `trade_position` / `trade_deal_history` / `trade_deal_today` / `trade_order_history` / `trade_order_today`：先查富途官方文档对应页取限频，持仓 / 历史成交 / 历史订单写 `(10, 30)` + `EVIDENCE:` 文档页；当日成交 / 当日订单 / 账户列表文档查不到则按兜底 `(10, 30)` 写 `ASSUMED:`；同步 `test_ratelimit.py:83` 对照表。新路由加入 `test_app.py` 401 参数化清单与部署探针对照；`deploy/install.sh` 非密收敛段加 `FUTU_TRADE_CALL_TIMEOUT_S`；`README.md` 路由表补四行 → verify: `python -m pytest -q` 全绿（含既有）且新增臂先红 → 绿：① 无 token ⇒ 401（四路由）② `market=CN` ⇒ 400 ③ 跨度 91 天 ⇒ 400、90 天 ⇒ 200 ④ `end` 为今天 ⇒ 当日与历史结果合并且重复 `deal_id` / `order_id` 只出现一次 ⑤ `end` 早于今天 ⇒ 不调当日接口 ⑥ 409 / 503 两类映射 ⑦ 限频超出 ⇒ 429 带 `Retry-After` ⑧ `/trade/accounts` 响应行键集合恰为 `{trdmarket_auth, matched}`（2026-09-14 amend）、不含完整账户号 ⑨ 用 `caplog` 捕获 409 / 503 / 429 三条错误路径的日志，断言不含 FakeCtx 里放的账户号；定向变异：a. 去掉当日合并去重 → ④ 红 · b. 在 409 路径日志里打印账户号 → ⑨ 红（留档）

- [X] T003 [P] [Shim] **只读 AST 守卫**（FR-004; plan D2; US1/US2）：新建 `tests/test_readonly_guard.py`：`ast.parse` 遍历 `src/**/*.py`，任一 `Attribute.attr` 或 `Name.id` ∈ `{unlock_trade, place_order, modify_order, place_combo_order, cancel_all_order}` 即断言失败，失败信息列出文件与行号；文件头写明 sabotage 臂结果 → verify: `python -m pytest -q tests/test_readonly_guard.py` 绿；sabotage 臂：临时在 `trade.py` 加一行 `ctx.place_order` → 红 → 还原 → 绿，红 / 绿结果与复跑命令写进文件头（`testing.md` §7.1 第二形态）

### Server 基础：时间、纯函数、表、配置、port

- [X] T004 [P] [Server] **`vendorTimeToDate` 支持毫秒 + `exchangeClock` 导出**（FR-008, FR-010; plan D4; state_branches 31; US1/US2）：`NAIVE_DATETIME_RE` 改为 `/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/`，毫秒组右补零到 3 位后计入 `Date.UTC`；🚫 不改函数签名与时区逻辑。`session-clock.ts` 新增导出 `exchangeClock(market: string, now: Date): { date: string; minutesOfDay: number }`，实现 = `timeInTimeZone(now, exchangeTimeZone(market))`，docblock 写明「对账类调度判到点用，禁在调用点另写时区换算」 → verify: `pnpm nx test server apps/server/src/marketdata/futu-option-snapshot.adapter.spec.ts apps/server/src/marketdata/session-clock.spec.ts --skip-nx-cache` 先红 → 绿，臂：① `'2026-09-18 16:20:00.936'` + `us` ⇒ 毫秒保留 ② 不带毫秒的串结果与改前逐值相同 ③ `'.9'` ⇒ 900 ms ④ `exchangeClock('us', 2026-10-30T13:10:00Z)`（EDT）⇒ `minutesOfDay = 550` ⑤ `exchangeClock('us', 2026-11-02T14:10:00Z)`（EST）⇒ `550` ⑥ `exchangeClock('hk', …)` 跨北京午夜时 `date` 正确；`futu-realtime-quote.adapter.spec.ts` 保持绿；`pnpm tsx scripts/checks/check-time-semantics.ts` exit 0；定向变异：删掉毫秒组 → ① 红（留档）

- [X] T005 [P] [Server] **`broker-code.rules.ts`：券商代码解析**（FR-006, FR-007; plan D5; state_branches 5; US1/US2/US3）：导出 `parseBrokerCode(code: string)` ⇒ `{ kind: 'stock', market, ticker } | { kind: 'option', market, root, expiry, right, strike } | null`：`US.X` ⇒ `us:X`（带点原样，`US.BRK.B` ⇒ `us:BRK.B`）；`HK.00700` ⇒ `hk:00700`；期权码 = 市场前缀 + 词根（字母数字）+ 6 位 `YYMMDD` + `C|P` + 行权价×1000 整数，词根**原样返回**（🚫 去尾部数字）；导出 `parseComboLegs(raw: string)` ⇒ 从 `ComboLeg(code=US.PEP260918P120000, …)` 形态的串中提取全部腿码。复杂度注释 O(len) → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-code.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① `US.PDD260918P70000` ⇒ root `PDD`、strike `70.000`、right `P` ② `HK.TCH260929C420000` ⇒ root `TCH`、strike `420.000` ③ `US.CMCS1260918C40000` ⇒ root `CMCS1`（不去数字）④ `US.BRK.B` ⇒ `us:BRK.B` ⑤ `HK.00700` ⇒ `hk:00700` ⑥ 合成组合码 `US.PEP260918P120/261120P120` ⇒ `null` ⑦ 两腿组合串 ⇒ 两个腿码 ⑧ 空串 / 无前缀 ⇒ `null`；定向变异：词根解析改为去尾部数字 → ③ 红（留档）

- [X] T006 [P] [Server] **`broker-scope.rules.ts`：范围判定单点**（FR-005, FR-006, FR-014; plan D6; state_branches 1, 2, 3, 4; US3）：导出 `inBrokerScope({ scope, anchoredTickers, underlyingTicker, accountId }): boolean` —— `full` ⇒ true；`anchored` ⇒ `underlyingTicker === null`（未解析）恒 true，否则 `anchoredTickers.has(underlyingTicker)`；`accountId` 入参保留、现阶段不参与判定（注释指 master §12-A4） → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-scope.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① anchored + 在锚集 ⇒ true（branch 1）② anchored + 不在 ⇒ false（branch 2）③ full + 不在 ⇒ true（branch 3）④ anchored + 未解析 ⇒ true（branch 4）⑤ 锚集含 `us:BRK.B` 时带点正股命中；定向变异：未解析改为 false → ④ 红（留档）

- [X] T007 [P] [Server] **`broker-opened-at.rules.ts`：持仓起点推算**（FR-016; plan D8; state_branches 13, 14; US1/US2）：导出 `resolveOpenedAt({ deals, positionQty, firstSeenAt })` ⇒ `{ openedAt, source: 'derived' | 'fallback' }`：`deals` 按 `(tradedAt, dealId)` 升序；`BUY` / `BUY_BACK` 记正、`SELL` / `SELL_SHORT` 记负；记录最后一次「累计 0 → 非 0」或「正负翻转」的成交时间；终值 ≠ `positionQty` 或无成交 ⇒ `fallback` 取 `firstSeenAt`。复杂度 O(n log n) 注释 → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-opened-at.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① D1 开 2、D2 加 1、D3 平 1，持仓 2 ⇒ D1（🚨 FIFO 反例）② 清仓后重开 ⇒ 重开那笔 ③ 空头 `SELL_SHORT` 开、`BUY_BACK` 部分平 ⇒ 开仓那笔 ④ 多翻空（一笔卖出量超过持仓）⇒ 翻转那笔 ⑤ 净量 ≠ 持仓（拆股形态：成交净 395、持仓 3950）⇒ `fallback` ⑥ 同秒两笔按 `dealId` 排序后结果确定 ⑦ 无成交 ⇒ `fallback`；定向变异：a. 改为取首笔成交 → ② 红 · b. 忽略正负翻转 → ④ 红（留档）

- [X] T008 [P] [Server] **`broker-position-sync.rules.ts`：持仓集合替换计划**（FR-014, FR-015; plan D8; state_branches 9, 10; US1/US2）：导出 `planPositionSync({ existing, reported })` ⇒ `{ toInsert, toUpdate, toDelete }`，键 `(market, code)`，`reported` 为**已经过范围过滤**的集合（FR-014）；`toUpdate` 保留 `existing.firstSeenAt`；`reported` 为空数组 ⇒ 全部进 `toDelete`。🚨 本函数不接受「拉取失败」入参（失败时调用方不调它，由 T015 钉） → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-position-sync.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 新出现 ⇒ insert ② 两边都有 ⇒ update 且 `firstSeenAt` 不变 ③ 券商不再报告 ⇒ delete（branch 10）④ 空报告 ⇒ 全删（branch 9）⑤ 指派形态（期权消失 + 正股出现）⇒ 1 delete + 1 insert；定向变异：update 覆盖 `firstSeenAt` → ② 红（留档）

- [X] T009 [P] [Server] **`broker-sync-slot.rules.ts`：对账时点判定 + 补齐重试判定**（FR-009, FR-010, FR-011; plan D9; state_branches 17, 18, 20, 21, 22, 23, 26, 27, 28, 29; US1/US2）：导出常量 `RECONCILE_SLOT_MINUTES = { us: 550, hk: 545 }`（注释：交易所当地 09:10 / 09:05，POC-6 待复核，出处 master §4）、`RECONCILE_MAX_ATTEMPTS = 4`（首次 + 3 次重试，spec Clarifications 第 1 条）、`RETRY_SPACING_MS = 15 min`、`BACKFILL_RETRY_CAP_MS = 24 h`。导出 `decideReconcile({ market, clock, dayStatus, todaysRuns: { succeeded, failed, lastFailedAt }, lastSucceededTradingDate, now })` ⇒ `{ action: 'skip', reason } | { action: 'run', windowStart }`：未到点 / `non-trading` / 已成功 / 失败次数 ≥ 4 / 距上次失败 < 15 min ⇒ skip；`unknown` 放行；`windowStart = min(lastSucceededTradingDate, clock.date − 7 自然日)`，从未成功 ⇒ `clock.date − 7`。导出 `decideBackfillAfterInfraFailure({ firstAttemptedAt, now })` ⇒ `{ status: 'pending', nextAttemptAt } | { status: 'failed' }` → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-sync-slot.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 美股 549 分 ⇒ skip、550 分 ⇒ run（branch 20）② `non-trading` ⇒ skip（21）③ `unknown` ⇒ run（22）④ 当日已成功 ⇒ skip（23）⑤ 失败 1 次且距今 14 分 ⇒ skip、15 分 ⇒ run（26）⑥ 失败 4 次 ⇒ skip（27）⑦ 上次成功在 3 天前 ⇒ 窗口 7 天（28）⑧ 上次成功在 12 天前 ⇒ 窗口起点 = 12 天前（29）⑨ 从未成功 ⇒ 7 天 ⑩ 首次尝试距今 23h59m ⇒ pending 且 `nextAttemptAt = now + 15 min`（17）⑪ 24h00m ⇒ failed（18）；定向变异：a. `>= 4` 改 `> 4` → ⑥ 红 · b. 窗口改固定 7 天 → ⑧ 红 · c. 上限比较改 `>` → ⑪ 红（留档）

- [X] T010 [Server] **六张 `broker_` 表 + 迁移 + 归属登记**（FR-001, FR-002, FR-010, FR-012, FR-013, FR-014, FR-017; plan D7, D9; state_branches 24; US1/US2/US3）：`schema.prisma` optionsdesk 段新增 `BrokerConnection` / `BrokerPosition` / `BrokerDeal` / `BrokerOrder` / `BrokerContractRef` / `BrokerSyncRun`（全部 `@@schema("optionsdesk")`，`@@map` 用 `snake_case` 表名）。关键约束：五张账号表带 `accountId BigInt @map("account_id")` 不建 FK + 以 `account_id` 打头的索引；连接存券商码、人读标签、所属账号手机号后四位 `phone_last4`（Prisma 字段 `phoneLast4`；上线手填，代码不读 `account` 表）；持仓唯一 `(connection_id, market, code)`；成交唯一 `(connection_id, deal_id)`；订单唯一 `(connection_id, order_id)`，`vendor_updated_at Timestamptz(6)`；合约归属参考主键 `(market, code)` 无 `account_id`；同步记录含 `kind` / `status` / `market`（对账必填、补齐可空）/ `target` / `window_start` / `window_end` / `trading_date` / `attempt` / `first_attempted_at` / `next_attempt_at` / `written` / `filled` / `error` / `started_at` / `finished_at` / `source_event_id`，唯一 `(connection_id, source_event_id)`（可空列，Postgres 唯一约束对 NULL 不冲突），**另加部分唯一索引** `(connection_id, market, trading_date) WHERE kind='reconcile' AND status IN ('running','succeeded')`（照 `schema.prisma:2058` 的 `where: raw(...)` 写法）；数量金额 `Decimal`，原始行 `raw Json`，时间 `Timestamptz(6)`。`pnpm db:migrate "add broker account sync tables"`，生成后**手工剔除** `DROP CONSTRAINT ck_anchor_market`。`check-server-moat.ts` `MODEL_OWNERSHIP` 登记 6 个 accessor → `'optionsdesk'` → verify: `pnpm tsx scripts/checks/check-server-moat.ts` exit 0；迁移目录名过 `migration-naming-check`；`pnpm nx run server:typecheck` 绿；`grep -n 'ck_anchor_market' apps/server/prisma/migrations/<新目录>/migration.sql` 零命中；`grep -n 'WHERE' apps/server/prisma/migrations/<新目录>/migration.sql` 命中部分唯一索引那一条；定向变异：删掉一条 `MODEL_OWNERSHIP` 登记后在任一新文件写一行该表访问 → moat 脚本红（留档后还原）

- [X] T011 [P] [Server] **配置 `BROKER_SYNC_SCOPE`**（FR-005; plan D11; state_branches 1, 2, 3; US3）：走 `/config-add`：`optionsdesk.config.ts` schema 加 `brokerSyncScope: z.enum(['anchored', 'full']).default('anchored')`，读 `process.env.BROKER_SYNC_SCOPE`；`.env.example` / `vitest.config.ts` test.env / `docker-compose.tight.yml` 映射按 skill 落位（非密） → verify: 配置单测（既有则补、没有则新建 `apps/server/src/config/optionsdesk.config.spec.ts`）先红 → 绿：① 缺失 ⇒ `anchored` ② `full` ⇒ `full` ③ 空串 ⇒ boot 抛 ④ `Full` ⇒ 抛；`pnpm tsx scripts/checks/check-env-sync.ts` exit 0

- [X] T012 [Server] **port + futu adapter + 约束档 + 模块装配（含 mock 拒绝壳）**（FR-002, FR-003, FR-006, FR-008, FR-018; plan D3; state_branches 7, 32; US1/US2/US3）：`broker-account.port.ts` 定义 token `BROKER_ACCOUNT_PORT` 与规范化行类型（持仓 / 成交 / 订单 / 账户概要；数量金额为 `Prisma.Decimal`，时间为 `Date`，订单带 `comboLegCodes: string[]`）及 `fetchStockOwners(market, codes)`。`futu-shim-trade.constraint-profile.ts`：10 次 / 30 秒、超时 15 s、重试 1 次。`futu-broker-account.adapter.ts`：自建 `VendorHttpClient(profile)`，URL / token 取 `marketdataConfig` 的 `futuShimUrl` / `futuShimToken`；时间一律 `vendorTimeToDate(v, market)`；成交行币种按市场补（`US` ⇒ `USD`、`HK` ⇒ `HKD`，`EVIDENCE:` POC-1 ②）；组合单腿码经 `parseComboLegs`；shim `409` ⇒ 抛 `BrokerAccountSelectionError`（不可重试）。`fetchStockOwners` 打既有 `/option-snapshot` 取 `stock_owner`。`optionsdesk.module.ts` 按 `marketdataConfig.kind` 绑定：`mock` ⇒ 调用即抛的拒绝壳（照 `marketdata.module.ts:222-237`） → verify: `pnpm nx test server apps/server/src/optionsdesk/futu-broker-account.adapter.spec.ts --skip-nx-cache` 先红 → 绿（HTTP 以 test double 注入），臂：① 成交时间带毫秒 ⇒ `Date` 毫秒保留 ② 成交币种按市场补 ③ 期权 `qty` 原样（张）④ 组合单订单解析出两个腿码 ⑤ `409` ⇒ `BrokerAccountSelectionError` ⑥ 响应行即使含 `acc_id` 也不进入规范化结果 ⑦ mock 绑定调用即抛；`pnpm nx run server:lint` 绿（边界规则：未 import `marketdata/*.rules.ts`）

### US1 · US3：同步 use case（补齐与范围）

- [X] T013 [Server-IT] **`resolve-broker-underlying.ts`：正股判定链 + 缓存**（FR-006, FR-007; plan D5; state_branches 4, 5; US3）：每次同步开始按市场一次性读 `optionContract` 去重 `(market, root, underlyingInstrumentId)` 与 `instrument.code`（`// CROSS-CONTEXT-READ:` 挂在两处 prisma 调用正上方）建内存映射；解析顺序：`broker_contract_ref` 缓存 → 词根映射 → 在挂合约批量 `fetchStockOwners` → 写缓存 → 仍不出 ⇒ `null`（未解析）。组合单：各腿正股一致取之，否则 `null` → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-082.resolve-underlying.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 已过期期权码经词根映射命中 ② 调整合约词根 `CMCS1` 命中 `us:CMCSA`（夹具按 prod 形态铺 `root=CMCS1`）③ 零合约锚的期权码走 `fetchStockOwners` 兜底并写缓存 ④ 第二次同步命中缓存、`fetchStockOwners` 调用数 0 ⑤ 全链都不出 ⇒ `null` ⑥ 组合单两腿正股不一致 ⇒ `null`；`pnpm tsx scripts/checks/check-server-moat.ts` exit 0（`CROSS-CONTEXT-READ` 注释在位）

- [X] T014 [Server-IT] **`sync-broker-account.usecase.ts`（上）：拉成交与订单 → 过滤 → 原子幂等写**（FR-001, FR-005, FR-007, FR-009, FR-012, FR-013; plan D1, D7; state_branches 1, 2, 3, 4, 5, 11, 12, 16; US1/US3）：入口 `execute({ connectionId, markets, target, window, mode })`。窗口：按 90 天分段、**相邻段各重叠 1 天**（富途历史窗口参数的时区未验证，重叠 + 去重使结果与之无关）。每段拉成交与订单（事务外）→ 正股判定（T013）→ `inBrokerScope`（T006；`target` 为单只标的时再过滤）→ 短事务写：成交 `createMany({ skipDuplicates })` 取返回的插入数；订单**两步原子写**：先 `createMany({ skipDuplicates })`，再对全部入参执行 `updateMany where { connectionId, orderId, vendorUpdatedAt: { lt: incoming } }`，🚫 先查后写。所有写入带 `accountId`（取自连接行） → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-082.broker-sync.it.spec.ts --skip-nx-cache` 先红 → 绿（`OptionsdeskModule` 真装配，只替换 `BROKER_ACCOUNT_PORT`），臂：① anchored：锚标的成交写入、非锚不写（branch 1, 2）② 被标为不参与交易的锚照常写入 ③ full：全部写入（3）④ 未解析行照常写入并可按未解析计数（4）⑤ 组合单订单按腿归属（5）⑥ 同一补齐连跑两次，成交 / 订单行数与内容逐条相同（11）⑦ 同一订单先喂 `updated_time …:08.950` 再喂 `…:08.898`（同秒）⇒ 库内为 `.950` 版本（12）⑧ `target='*'` 覆盖范围内全部标的（16）⑨ 窗口 200 天 ⇒ port 收到的每段 ≤ 90 天且相邻段重叠 1 天、重叠处重复成交只落一行 ⑩ 每张表每行 `account_id` = 连接的账号 ⑪ 两个 use case 并发写同一批订单（其中一方携带更新版本）⇒ 无异常、库内为最新版本；定向变异：a. 订单守卫改 `lte` → ⑦ 反向喂入时红 · b. 去掉段重叠 → ⑨ 红 · c. 订单写改回先查后写 → ⑪ 抛 `P2002` 红（留档）

- [X] T015 [Server-IT] **`sync-broker-account.usecase.ts`（下）：持仓刷新 + 开仓时间 + 失败语义 + 同步记录**（FR-009, FR-011, FR-014, FR-015, FR-016, FR-017; plan D1, D8, D12; state_branches 8, 9, 10, 13, 14, 15, 16, 30; US1/US2）：成交订单写完后刷新目标市场持仓（`target='*'` ⇒ 美股、港股都刷新）：拉持仓（事务外）→ 过滤 → `planPositionSync`（T008）→ 对每个保留持仓用库内该合约成交跑 `resolveOpenedAt`（T007）→ **一个事务**内插 / 改 / 删并写 `syncedAt`。任一拉取失败 ⇒ 不进写入、不调 `planPositionSync`，同步记录 `failed` + `error`，返回失败类型（基础设施 / 数据）。对账模式记补回条数 = 成交插入数 + 订单新增数，> 0 ⇒ `logger.warn`（不含账户号）。执行前后维护同步记录 `running` → `succeeded` / `failed` → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-082.broker-positions.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 🚨 先铺好持仓与成交，再让 port 拉取抛基础设施错误 ⇒ 持仓、成交逐条不变且记录 `failed`（branch 8）② 券商成功返回空持仓 ⇒ 该市场持仓清空（9）③ 期权被指派：期权持仓消失、正股持仓出现（10）④ 已存在持仓刷新后 `firstSeenAt` 不变、`syncedAt` 更新 ⑤ 成交净量 = 持仓 ⇒ `derived`（13）⑥ 拆股形态 ⇒ `fallback` 且取 `firstSeenAt`（14）⑦ 单只标的补齐成功后该市场持仓立即进库（15 的持仓半）⑧ 对账：删 1 条近期成交后执行 ⇒ `filled = 1` 且有 warn 日志，紧接着再执行 ⇒ `filled = 0`（30，in-test 对照臂）⑨ 同步记录字段齐全（类型 / 市场 / 状态 / 起止时间 / 条数 / 失败原因）⑩ `target='*'` 补齐成功后美股、港股两个市场的持仓都被刷新（16 的持仓半）⑪ spy 捕获本用例全部 `logger` 输出，断言不含 fixture 连接的完整账户号；定向变异：a. 拉取失败时仍调用持仓替换 → ① 红 · b. `target='*'` 只刷新第一个市场 → ⑩ 红（留档）

### US2 · US1：调度器与订阅方

- [X] T016 [Server-IT] **`broker-account.scheduler.ts`（上）：心跳骨架 + 补齐认领与结局**（FR-009, FR-010, FR-017, FR-018; plan D9; state_branches 7, 15, 17, 18, 19, 24, 32; US1）：`@Cron('0 * * * * *', { name: 'broker-account-heartbeat', timeZone: 'Asia/Shanghai', waitForCompletion: true })` 调 `run(now = new Date())`，全路径 try/catch 不上抛。`run`：`marketdataConfig.kind === 'mock'` ⇒ `skipped-mock`；遍历连接，每个连接独立 try/catch：① `running` 且 `startedAt` 早于 15 分钟前 ⇒ 补齐记录置回 `pending`、对账记录置 `failed`（`error = '执行中断'`）② 认领 `pending ∧ nextAttemptAt ≤ now` 的补齐记录（`updateMany where {id, status:'pending'}`，count===1 才执行）→ 调 use case → 成功 `succeeded`；基础设施失败按 `decideBackfillAfterInfraFailure`（首次失败写 `firstAttemptedAt`）；数据错误（含 `BrokerAccountSelectionError`）立即 `failed` ③ 调用对账编排（T017，本 task 先留空实现）。模块注册为 provider → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-082.backfill-scheduler.it.spec.ts --skip-nx-cache` 先红 → 绿（`now` 用固定时刻），臂：① mock ⇒ port 调用数 0（32）② 两个 `run` 并发认领同一条 `pending` ⇒ use case 只执行一次 ③ `running` 超 15 分钟：补齐记录回收后被执行；对账记录变 `failed` ④ 基础设施失败、首次尝试 23h59m 前 ⇒ `pending` 且下次时刻 +15 分（17）⑤ 24h00m ⇒ `failed`（18）⑥ `BrokerAccountSelectionError` ⇒ 立即 `failed`、不再被认领（7, 19）⑦ 连接 A 的 port 抛错不影响连接 B 执行 ⑧ 订阅方产生的 `pending` 记录在下一拍被执行并刷新持仓（15 的调度半）⑨ 经 `SchedulerRegistry.getCronJob('broker-account-heartbeat')` 断言 `waitForCompletion === true`（24 的第一层）；定向变异：a. 认领去掉 `status:'pending'` 条件 → ② 红 · b. 去掉 `waitForCompletion` → ⑨ 红（留档）

- [ ] T017 [Server-IT] **`broker-account.scheduler.ts`（下）：开盘前对账编排 + 数据层防重入**（FR-010, FR-011, FR-017; plan D4, D9; state_branches 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31; US2）：补上 T016 留空的对账编排：对每个市场 `exchangeClock` + `TradingCalendarPort.classify(market, exchangeCalendarDate(market, now))` + 当日记录与上次成功交易日 → `decideReconcile`（T009）→ `run` 时插一条 `running` 对账记录，**撞部分唯一索引（`P2002`）⇒ 本拍跳过**，否则以窗口调 use case 并回写结局 → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-082.reconcile-scheduler.it.spec.ts --skip-nx-cache` 先红 → 绿（日历 port 以 test double 注入，`now` 用固定时刻），臂：① 美股 09:10 ET 交易日未成功 ⇒ 执行对账（20）② 非交易日 ⇒ 不执行（21）③ `unknown` ⇒ 执行（22）④ 当日已成功 ⇒ 不重复（23）⑤ 🚨 两个 `run()` 同时进入 09:10 ET（直调，绕过 cron）⇒ 对账记录恰 1 条、另一方跳过且不抛（24 的第二层）⑥ 09:40 ET 首次运行（模拟停机后重启）⇒ 执行（25）⑦ 对账失败后 14 分钟不执行、15 分钟执行，第 4 次失败后当日不再执行（26, 27）⑧ 上次成功 12 天前 ⇒ use case 收到的窗口起点 = 12 天前；3 天前 ⇒ 7 天（28, 29）⑨ `now = 2026-10-30T13:10:00Z` 与 `2026-11-02T14:10:00Z` 均触发美股对账（31）⑩ 港股 09:05 HKT 触发港股对账、不触发美股；定向变异：a. 去掉部分唯一索引的冲突处理 → ⑤ 插出两条红 · b. 时点改用北京时间分钟数 → ⑨ 其中一侧红（留档）

- [ ] T018 [Server-IT] **`broker-history-backfill.subscriber.ts`：新建锚 → 待执行补齐记录**（FR-009, FR-018; plan D10; state_branches 15, 32; US1）：`implements OutboxSubscriber, OnModuleInit`，`onModuleInit` 调 `registry.register(this)`；`eventType = 'optionsdesk.anchor-created'`（本地字面量，注释指 `create-anchor.usecase.ts:236`）。`handle(delivery)`：mock ⇒ return；`ticker` 缺失或非字符串 ⇒ `logger.error` + return；无连接 ⇒ return；否则对每个连接 `createMany({ data: [...], skipDuplicates: true })` 插 `kind=backfill, status=pending, target=ticker, sourceEventId, nextAttemptAt=now`；DB 错误不捕获（交 relay 重投）。模块注册 provider → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-082.backfill-subscriber.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 一个连接 ⇒ 1 条 `pending`（15）② 同一 `sourceEventId` 投递两次 ⇒ 仍 1 条 ③ 两个连接 ⇒ 各 1 条（🚨 唯一键只按事件 ID 时第二条会被静默挡掉）④ 载荷缺 `ticker` ⇒ 不抛、0 条 ⑤ 无连接 ⇒ 不抛、0 条 ⑥ mock ⇒ 0 条（32）⑦ registry 中 `optionsdesk.anchor-created` 同时挂着冷启动订阅方与本订阅方 ⑧ 经真实 `CreateAnchorUseCase` 建锚 → relay 投递 → 产生 1 条记录（端到端）；定向变异：唯一键改为只含 `source_event_id` → ③ 红（留档）

### Docs · Gate · Ops

- [ ] T019 [P] [Docs] **ADR-0062 复审记录 + ADR-0043 阈值登记**（plan Gate 0.4, D14）：`docs/adr/0062-optionsdesk-bounded-context.md` §复审记录追加 `### 2026-09-XX — sunset_trigger #4（持仓联动）：fired · mitigated`：结论 = optionsdesk 持有「期权台范围内的券商镜像」（`broker_` 前缀、port 隔离 vendor），不扩 portfolio `BrokerAccount`；拆出条件 = 范围开关打开且出现期权台以外的读取方，或接入第二家券商；同节登记 ADR-0043 #1 现状（optionsdesk use case 数 20，下一片 p3 加读接口将越线，须在其 plan Gate 0.4 复审）；frontmatter `sunset_trigger` #4 行尾补 `✅ FIRED 2026-09-XX（082）· mitigated`。🚫 不写账户号、主机标识 → verify: `pnpm tsx scripts/check-adr-frontmatters.ts` 绿；`npx prettier --check docs/adr/0062-optionsdesk-bounded-context.md` 绿；`pnpm tsx scripts/checks/check-identifier-boundary.ts` exit 0

- [ ] T020 [Gate] **覆盖收口 + 全量门 + 启动冒烟 + 账户号真值扫描 + PR**（SC-001, SC-002, SC-003, SC-004, SC-005, SC-006, SC-007, SC-008, SC-009, SC-010）：逐条核对下方五张覆盖预检表（实时 grep，不抄表内数字）。**账户号真值扫描（SC-010 的仓内面）**：本机一次性脚本从 `docs/private/evidence/broker-account-poc/` 的原始输出读出全部账户号集合（POC 实测为 8 位与 18 位，🚫 按位数正则搜），对 `git ls-files` 与 `git ls-files --others --exclude-standard` 列出的每个文件逐值做子串搜索，**只打印命中计数**；真值不写入任何文件、命令行参数或日志。两臂对照：先把一个真值写进 scratchpad 目录的临时文件并对该目录跑同一脚本 ⇒ 计数 1，再对仓库跑 ⇒ 计数 0。spec `status → implementing`、`updated_at` bump → verify: `git fetch origin && pnpm nx affected -t lint typecheck test build --base=origin/main --skip-nx-cache` exit 0；在 `services/futu-shim` 下 `python -m pytest -q` 全绿；`pnpm tsx scripts/ci/server-boot-smoke.ts` exit 0（`MARKETDATA_PROVIDER=mock` 与 live 各一次，覆盖 `AppModule` 装配）；治理脚本全 0：`check-server-moat` / `check-test-size` / `check-time-semantics` / `check-identifier-boundary` / `check-repo-layout` / `check-env-sync`；账户号扫描两臂结果为 1 / 0；`gh-bot pr create` 按 `docs/conventions/pr-creation-protocol.md`。🚨 **PR body 标「建议人工合并」、不接 auto-merge**：含新表迁移（不可逆 DB 变更）且 shim 合入 main 即自动部署到交易主机

- [ ] T021 [Ops] **上线：shim 部署自检 + 建连接 + 一次性回填 + 首轮核对**（SC-001, SC-006, SC-008, SC-009, SC-010; plan D13, D15）：前置 = PR 合并、shim 自动部署完成、server 发版上线。步骤：① 港机 `/healthz.version` = 合并 SHA 且 `routes` 含四条交易路由；对 `/trade/accounts` 真打一次，判据只看 `matched = 1` ② 起草两条 SQL 放 `docs/private/runbook/`（🚫 不入仓）：建连接行（账号 = 期权台管理员，`phone_last4` 由维护者从 prod `account` 表查该账号手机号后四位手填）+ 插 `backfill` 记录（`status=pending`、`target='*'`、`window_start=2024-09-01`）；写操作由维护者本人执行 ③ 等下一拍，查记录 `succeeded` ④ SC-001：逐只锚标的比对库内成交 / 订单条数与富途 App ⑤ SC-006：抽查 `derived` 持仓的开仓时间与 App 成交记录一致，`fallback` 持仓逐条可解释 ⑥ SC-008：抽查锚标的相关期权码的正股判定，未解析行逐条可解释 ⑦ SC-009，口径同 POC-7 判据：**休市时段**按 POC-7 采样脚本采 1 小时，`/trading-days` 延迟中位与基线 30.5 ms 相比变化 < 10%；**港股盘中与批处理时段**只判 shim / OpenD journal 零新增 error（逐条归因），🚫 拿盘中延迟比休市基线 ⑧ SC-010 的 prod 面：本机读出账户号集合，经 stdin 传给远端 `grep -F -c -f -`，分别比对 server 日志与 `broker_*` 表的文本导出，只回计数，判据 = 0 → verify: ①–⑧ 观测值回填本行与 spec「SC 收口」表；任一不达标即停，不进入 T022

- [ ] T022 [Ops] **上线后观察：新建锚补齐时效 + 连续 5 个交易日对账**（SC-002, SC-004, SC-007; state_branches 15, 20）：① 上线后第一只新建锚：记录建锚时刻到补齐记录 `succeeded` 且持仓可见的耗时，≤ 5 分钟（SC-002）② 连续 5 个交易日：每个市场每个交易日恰有 1 条成功对账记录（SC-004）③ 期间若出现券商连接不可用，核对既有持仓 / 成交未被改动（SC-007）→ verify: 三项观测值回填本行；🚨 **开 task 时同步建 issue** 写明触发条件与兜底复查点（上线后第 10 个交易日仍未满足 ① 则主动建一只测试锚验）

- [ ] T023 [Server] **按 POC-6 结果修正对账时点常量（条件触发）**（FR-010; plan D9; state_branches 20）：触发条件 = POC-6 美股（2026-09-19 / 09-21 快照）或港股（2026-09-29 / 09-30 快照）的结论为「开盘前那一拍尚未反映到期 / 指派」。只改 `RECONCILE_SLOT_MINUTES` 对应值与旁注出处，🚫 其余逻辑不动；结论为「已反映」则本 task 只在 p0-poc 表回填结论并勾选，不改代码 → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-sync-slot.rules.spec.ts` 臂① 随新常量更新后绿；独立小 PR

## 依赖与并行

```text
T001 → T002                      T003 [P]
T004 [P]  T005 [P]  T006 [P]  T007 [P]  T008 [P]  T009 [P]
T010 → T011 [P]
T004 + T005 + T010 → T012 → T013 → T014 → T015 → T016 → T017
                               T010 → T018（端到端臂 ⑧ 依赖 T016 已在）
T019 [P]
全部 → T020 → T021 → T022
T023（POC-6 结果出来后，独立小 PR）
```

- **T002 → server 侧**无代码依赖（server 以 port 替身测试），但 **T021 必须等 shim 已部署**。
- **T012 → T013**：兜底调用走 port 的 `fetchStockOwners`。
- **T014 → T015**：持仓刷新依赖成交已写入（开仓时间从库内成交算）。
- **T015 → T016 → T017**：调度器调用完整 use case；对账编排挂在心跳骨架上。
- **T018 臂 ⑧** 需要调度器已在，其余臂只依赖 T010。

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

> 🚨 **本表编号 = `spec.md` frontmatter `state_branches` 的行序，MUST 逐行同序**。

| # | branch（摘要） | 落点 |
|---|---|---|
| 1 | 只锚标的 ∧ 属锚 ⇒ 写入 | T006-① + T014-① |
| 2 | 只锚标的 ∧ 不属锚 ⇒ 不写 | T006-② + T014-① |
| 3 | 全量 ⇒ 全部写入 | T006-③ + T014-③ |
| 4 | 判定不出正股 ⇒ 写入并标未解析 | T006-④ + T013-⑤ + T014-④ |
| 5 | 组合单按腿归属 | T005-⑥⑦ + T013-⑥ + T014-⑤ |
| 6 | 选户恰 1 个 | T001-① |
| 7 | 选户 0 个或多于 1 个 ⇒ 失败 | T001-②③ + T002-⑥ + T012-⑤ + T016-⑥ |
| 8 | 拉取失败 ⇒ 既有数据不动 | T015-① |
| 9 | 成功 ∧ 无持仓 ⇒ 清空 | T008-④ + T015-② |
| 10 | 持仓不再出现 ⇒ 移除；指派正股出现 | T008-③⑤ + T015-③ |
| 11 | 重复执行逐条一致 | T014-⑥ |
| 12 | 较旧订单状态晚到 ⇒ 不覆盖 | T014-⑦⑪ |
| 13 | 净量 = 持仓 ⇒ 推算 | T007-①②③④ + T015-⑤ |
| 14 | 净量 ≠ 持仓 ⇒ 回落 | T007-⑤⑦ + T015-⑥ |
| 15 | 新建锚 ⇒ 补齐 + 刷新持仓，建锚不受影响 | T018-①⑧ + T016-⑧ + T015-⑦ |
| 16 | 补齐范围 = 全部标的 | T014-⑧ + T015-⑩ |
| 17 | 基础设施故障 ∧ 未满 24 小时 ⇒ 15 分钟后重试 | T009-⑩ + T016-④ |
| 18 | 基础设施故障 ∧ 满 24 小时 ⇒ 失败 | T009-⑪ + T016-⑤ |
| 19 | 数据无法处理 ⇒ 失败不重试 | T016-⑥ |
| 20 | 到点 ∧ 交易日 ∧ 未成功 ⇒ 对账 | T009-① + T017-①⑩ + T022-② |
| 21 | 非交易日 ⇒ 跳过 | T009-② + T017-② |
| 22 | 日历无法判定 ⇒ 照跑 | T009-③ + T017-③ |
| 23 | 已成功 ⇒ 不重复 | T009-④ + T017-④ |
| 24 | 上一拍仍在执行 ∨ 已有进行中对账 ⇒ 不发起第二条 | T016-⑨ + T017-⑤ |
| 25 | 停机后同一交易日重启 ⇒ 补跑 | T017-⑥ |
| 26 | 对账失败 ∧ 重试未满 3 次 ⇒ 15 分钟后重试 | T009-⑤ + T017-⑦ |
| 27 | 已重试 3 次 ⇒ 放弃到下一交易日 | T009-⑥ + T017-⑦ |
| 28 | 距上次成功 ≤ 7 天 ⇒ 窗口 7 天 | T009-⑦ + T017-⑧ |
| 29 | 距上次成功 > 7 天 ⇒ 窗口延长 | T009-⑧ + T017-⑧ |
| 30 | 补回 > 0 ⇒ 告警留痕 | T015-⑧ |
| 31 | 夏令时前后美股 09:10 | T004-④⑤ + T017-⑨ |
| 32 | 开发环境 ⇒ 静默跳过 | T012-⑦ + T016-① + T018-⑥ |

## Functional Requirements 覆盖预检

| FR | 落点 |
|---|---|
| FR-001 每行直接记归属账号 | T010 + T014-⑩ |
| FR-002 只存所属账号手机号后四位，完整账户号不落服务端 | T001-④ + T002-⑧⑨ + T012-⑥ + T015-⑪ + T020（仓内真值扫描）+ T021-⑧ |
| FR-003 选户规则 | T001-①②③ + T002-⑥ + T012-⑤ |
| FR-004 只读、出现交易调用即红 | T003 |
| FR-005 范围开关与同一口径 | T006 + T011 + T014-①②③ |
| FR-006 正股判定链与未解析 | T005 + T013 + T014-④ |
| FR-007 组合单按腿 | T005-⑦ + T013-⑥ + T014-⑤ |
| FR-008 时间按交易所时区 | T004-①②③ + T012-① |
| FR-009 补齐覆盖、范围、刷新持仓、新建锚触发、重试上限 | T009-⑩⑪ + T014-⑧⑨ + T015-⑦⑩ + T016-④⑤⑥ + T018 |
| FR-010 开盘前对账调度与防重入 | T004-④⑤ + T009-①–⑥ + T010（部分唯一索引）+ T016-⑨ + T017-①–⑦⑨⑩ + T023 |
| FR-011 对账区间与补回留痕 | T009-⑦⑧⑨ + T015-⑧ + T017-⑧ |
| FR-012 唯一号幂等 | T010 + T014-⑥ |
| FR-013 订单新旧守卫 | T010 + T014-⑦⑪ |
| FR-014 过滤后的持仓集合替换、保留首次发现时间 | T006 + T008 + T015-②③④ |
| FR-015 失败不改数据、最近成功同步时刻、空仓判定 | T015-①②④ |
| FR-016 开仓时间推算与来源 | T007 + T015-⑤⑥ |
| FR-017 同步记录与不主动通知 | T010 + T015-⑨ + T016 + T017 |
| FR-018 开发环境跳过 | T012-⑦ + T016-① + T018-⑥ |
| FR-019 不降低行情服务 | T001-⑤⑥ + T002-⑥ + T021-⑦ |

## Success Criteria 覆盖预检（🚨 SC 是系统性盲区，单列一张）

| SC | 落点 | 形态 |
|---|---|---|
| SC-001 回填后条数与 App 一致 | T021-④ | 上线后人工比对 |
| SC-002 新建锚 ≤ 5 分钟补齐且持仓可见 | T018-⑧ + T016-⑧（自动：下一拍即执行）+ T022-① | 自动断言 + 上线后实测 |
| SC-003 重复执行差异为 0 | T014-⑥ | 自动断言 |
| SC-004 连续 5 个交易日每日恰 1 条成功对账 | T017-④⑤ + T016-⑨（机制）+ T022-② | 自动断言 + 上线后观察 |
| SC-005 删 1 补 1、再跑补 0 | T015-⑧ | 自动断言（in-test 对照臂） |
| SC-006 推算开仓时间与 App 一致、无无来源 | T007 + T015-⑤⑥ + T021-⑤ | 自动断言 + 上线后抽查 |
| SC-007 连接不可用时数据零改动 | T015-① + T022-③ | 自动断言 + 上线后观察 |
| SC-008 正股判定零错归 | T013 + T021-⑥ | 自动断言 + 上线后抽查 |
| SC-009 行情延迟中位变化 < 10% | T001-⑤⑥（保护机制）+ T021-⑦ | 机制断言 + 上线后同口径采样 |
| SC-010 完整账户号零出现 | T001-④ + T002-⑨ + T012-⑥ + T015-⑪ + T020 + T021-⑧ | 自动断言 + 仓内真值扫描（两臂）+ prod 真值比对 |

## Edge Case 覆盖预检

| EC（spec Edge Cases 行序） | 落点 |
|---|---|
| 多账户（模拟 / 停用 / 基金户） | T001-①②③ |
| 组合单合成代码 | T005-⑥⑦ + T014-⑤ |
| 调整合约不能截尾还原 | T005-③ + T013-② |
| 带点号美股代码 | T005-④ + T006-⑤ |
| 时间不带时区（夜盘 / 周六凌晨） | T004-① + T012-① |
| 美国夏令时切换日 | T004-④⑤ + T017-⑨ |
| 交易日历无法判定 | T009-③ + T017-③ |
| 较旧订单状态晚到 / 终态保存 | T014-⑦⑪ |
| 单次历史查询跨度上限 | T002-③ + T014-⑨ |
| 连续多日失败或长时间停机后补缺 | T009-⑧ + T017-⑧ |
| 锚被删除 | **轻验**：T006-②（不再属锚 ⇒ 不写）+ T015-③（持仓随刷新移除）；「已同步成交保留」由不存在删除成交的代码路径保证（T014 / T015 均无成交删除语句） |
| 开发环境无券商连接 | T012-⑦ + T016-① + T018-⑥ |
| 券商接口限频 | T002-⑦ + T015-①（失败不清空） |

## Acceptance Scenario 覆盖预检（🚨 标准矩阵**够不到**这一层）

| AS | 落点 |
|---|---|
| US1-AS1 新建锚自动补齐、持仓进库 | T018-⑧ + T016-⑧ + T015-⑦ |
| US1-AS2 重复补齐逐条一致 | T014-⑥ |
| US1-AS3 清仓重开取重开那笔 | T007-② |
| US1-AS4 净量不符取首次发现时间 | T007-⑤ + T015-⑥ |
| US1-AS5 连接不可用：建锚成功、24 小时内恢复自动完成、超时失败 | T018-⑧（建锚不受影响）+ T016-④⑤ |
| US1-AS6 同步记录可查状态与条数 | T015-⑨ |
| US2-AS1 开盘前对账补缺并刷新 | T017-① + T015-⑧ |
| US2-AS2 补回 > 0 记录并告警 | T015-⑧ |
| US2-AS3 已成功不重复 | T017-④ |
| US2-AS4 停机后同日补跑 | T017-⑥ |
| US2-AS5 被指派：期权移除、正股出现 | T008-⑤ + T015-③ |
| US2-AS6 连接不可用不清空、可识别上次成功时刻 | T015-①④ |
| US3-AS1 只锚标的只写锚标的 | T014-① |
| US3-AS2 全量写全部 | T014-③ |
| US3-AS3 判定不出照常写入并可统计 | T014-④ |

蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：

- **SC-001 / SC-006 / SC-008 的真数面**：依赖真实账户与富途 App，只能上线后人工比对（T021），自动化只覆盖机制。
- **SC-009**：延迟对比依赖港机真实负载，自动化只能验保护机制（超时、并发上限），真数面在 T021-⑦。
- **POC-6 对账时点**：参数正确性依赖真实到期日快照，T023 条件触发。

## Implementation Strategy

MVP = **T001 → T002 + T004 → T018**：到这里新建锚补齐与开盘前对账两条持续行为在测试环境完整成立。T019 并行，T020 门，T021 上线与一次性动作，T022 上线后观察，T023 等 POC-6 结果。

Clear 检查点批次：`T001-T003` / `T004-T006` / `T007-T009` / `T010-T012` / `T013-T014` / `T015` / `T016-T017` / `T018-T019` / `T020` / `T021-T023`（每批次后停顿提醒 `/clear`，per Constitution §III）。
