---
feature_id: 083-optionsdesk-trading-account-positions
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-09-15'
updated_at: '2026-09-15'
---

# Tasks: 083-optionsdesk-trading-account-positions（期权台交易账户页 · 持仓展示与下钻）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **Analysis**: [`analysis.md`](./analysis.md)

**一句话**：optionsdesk 加 4 个只读接口 + 3 个纯函数规则把 082 同步的券商数据读出来；mobile 替换持仓占位、加持仓详情与订单详情两屏、冷启动页加券商历史状态行。跨端单 PR。

> 2026-09-15 analyze 修订：按 `analysis.md` 7 条 HIGH / 9 条 MEDIUM / 5 条 LOW 与维护者 Q1–Q3 决定重排为 25 个 task（原 T005 / T013 / T015 各拆为两个；新增 branch 43–47、FR-022 / FR-023 的落点）。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx; plan Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 即其验收，红→绿在同一 task 内闭环（Constitution §II）；新测试必须**定向变异证明能红**并留档。
- 层级：`[Server]` / `[Server-IT]` / `[Contract]`（OpenAPI 导出 + api-client 重生成）/ `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Docs]` / `[Gate]` / `[Ops]`。
- `state_branches n` = spec frontmatter `state_branches` 的**行序号**（1 起）。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**。

## Path Conventions

| 用途 | 路径 |
|---|---|
| 纯函数（新） | `apps/server/src/optionsdesk/broker-{position-display,lots,freshness}.rules.ts`（+ 同名 `.spec.ts`） |
| use case（新） | `apps/server/src/optionsdesk/{list-broker-positions,get-broker-position,get-broker-order,list-broker-backfill-runs}.usecase.ts` |
| controller / DTO（新） | `apps/server/src/optionsdesk/broker-account.controller.ts` · `broker-account.dto.ts` |
| 模块装配（改） | `apps/server/src/optionsdesk/optionsdesk.module.ts` |
| 交易所当地时间串（改） | `apps/server/src/marketdata/session-clock.ts`（私有 `timeInTimeZone` `:97-112`）+ `session-clock.spec.ts` |
| 复用 | `broker-code.rules.ts:67-88` `parseBrokerCode` · `broker-sync-slot.rules.ts:24` `RECONCILE_SLOT_MINUTES` · `instrument-name.ts:39-62` `resolveInstrumentNames` · `intraday-spot.rules.ts:110-121` `resolveAnchorSpot` · `marketdata/trading-day-gate.ts:139` `daysToExpiry` · `marketdata/trading-calendar.port.ts:33,52-69` `classify` / `previousTradingDay`（null = 不可判定） |
| 读接口先例 | `optionsdesk.controller.ts:165,185-217`（guard / 限频 / swagger）· `get-anchor.usecase.ts:36`（not-found）· 取账号 `alert/alerts.controller.ts:15,139,168`（`AuthenticatedUser` 从 `account/jwt-auth.guard.ts:6` import） |
| Server IT（新） | `apps/server/test/integration/optionsdesk-083.{broker-positions-read,broker-position-detail,broker-order-detail,broker-backfill-runs}.it.spec.ts`（隔离库 `apps/server/test/_support/isolated-db.ts`） |
| OpenAPI / client（regen） | `apps/server/openapi.json` · `packages/api-client/src/generated/` |
| mobile 共享格式（新） | `apps/mobile/src/format/compact-amount.ts`（+ spec） |
| mobile optionsdesk（新） | `apps/mobile/src/optionsdesk/{trading-account-positions.rules.ts,use-trading-account-positions.ts,use-refetch-on-foreground.ts,trading-account-positions.tsx,trading-account-position-screen.tsx,trading-account-order-screen.tsx}` |
| mobile 路由（新 / 改） | `apps/mobile/app/(app)/optionsdesk/trading-account-position/[id].tsx` · `trading-account-order/[id].tsx` · `_layout.tsx`（`:43-46` 体例）· `src/optionsdesk/optionsdesk-routes.ts` + `.spec.ts` · `src/optionsdesk/index.ts` |
| mobile 触碰 | `trading-account-screen.tsx`（持仓占位 `:49-64`）· `anchor-cold-start-screen.tsx`（`RunRow` `:151-178`）· `optionsdesk-copy.ts`（新建 `tradingAccountPositions` 段；081 `tradingAccount` 段 `:1335-1364` 不动） |
| mobile 先例 | 数据 hook `use-underlying-detail.ts` · 下拉 `radar-screen.tsx:281` · 聚焦重取 `portfolio/watchlist-main-screen.tsx:64-67` · `SectionList` `portfolio/trade-history-screen.tsx:149-170` · 涨跌色 `portfolio/use-quote-merge.ts:37-48` · 带参路由 `app/(app)/optionsdesk/underlying/[symbol].tsx:18` |
| e2e / 冒烟（新 / 改） | `apps/mobile/e2e/optionsdesk-trading-account-positions.spec.ts` · `e2e/markets-feature-gate.spec.ts`（`GATED_DEEPLINKS` `:113` 起）· `e2e/contract-smoke/optionsdesk-trading-account.contract.ts` + `run.ts:44-91` |
| 真机验收流程 | `ops/runbook/local-dev.md`（dev client 连 prod 只读验收） |
| ADR（改） | `docs/adr/0043-server-flat-module-paradigm.md` 复审记录 |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **只读**：零写路径、零事务；🚫 任何下单 / 改单 / 撤单 / 平仓入口（FR-019）。
2. **账号隔离在查询条件里**：`broker_*` 查询一律 `where` 带 `accountId: req.user.accountId`；按 id 读一律 `findFirst({ where: { id, accountId } })`，🚫 `findUnique` 后比账号。持仓与订单详情各自的「不存在 / 他人 / 正股未归类或不在锚集」404 响应逐字节相同。
3. **展示过滤 🚫 复用 `inBrokerScope`**：它对未解析行恒 true（同步语义）；展示侧未解析行只计数不展示，且恒按「只锚标的」（plan D3）。
4. **订单列表按 `vendorUpdatedAt ≥ openedAt` 过滤，🚫 按 `vendorCreatedAt`**：开仓订单全部早于开仓时间下单（plan 前验证 V2），按下单时间过滤会滤掉全部开仓单且不报错（plan D9，FR-016）。
5. **市场同步时刻不能只按 `market` 列**：补齐记录 `market` 为空，按 `target`（`'*'` 或 `m:` 前缀）归市场（plan D7，V5）。
6. **陈旧判定时点 = 最近一个已过宽限的对账时点**，🚫「只看今天时点 + 宽限」（前天同步、今天宽限内会漏报，analyze H5）；`previousTradingDay` 返回 null ⇒ 不标陈旧 + warn，🚫 回落日历日（端口契约 MUST NOT 猜，analyze H6 / 维护者 Q1）。
7. **期权乘数从订单推**：`raw.amount ÷（qty × price）` 取整；🚫 从持仓市值反推（V0b 有非整数行）；🚫 读 `option_contract`。
8. **时间只在服务端换算**：交易所当地时间串只经 `exchangeLocalDateTime`；🚫 optionsdesk 裸 `Intl.DateTimeFormat`（Rule B）；🚫 mobile 做时区换算。持仓 / 订单详情响应**必带 `market`**（深链进入时标时区只能靠它，analyze H4）。到期判定只用 `daysToExpiry`，🚫 北京日期。
9. **连接标签 = 连接的人读标签 `connectionLabel`**，🚫 用 `brokerCode`（同券商两个连接会完全相同，维护者 Q2）。
10. **已显示数据时重读失败 🚫 换成错误卡**：保留数据 + 「刷新失败，显示的是上次加载的数据」；404 例外，「持仓已不存在 / 订单不存在」优先于旧数据（FR-020 / FR-023，维护者 Q3）。
11. **新文案放独立段 `tradingAccountPositions`**，🚫 追加进 081 `tradingAccount` 段 —— `trading-account.rules.spec.ts:46-50` 断言该段不含「暂无 / 空仓 / 无数据」，放进去必红（analyze H7）；🚫 为过测试改 081 的断言。
12. **BigInt / Decimal 出边界一律 string**；nullable 标量 `@ApiProperty` 显式 `type`（`check-api-property-nullable.ts`）。
13. **fixture 只用合成值**：`ZQX` / `ZQY` / `ZQR` / 港股 `088xx`；🚫 真实账户 / 持仓 / 成交 / 订单数据。🚨 `apps/server/src/optionsdesk/**`（**含 spec**）数字字面量避开 `0.8` / `0.6` / `1.2` 子串（`check-optionsdesk-rule-constants.ts` #1）。
14. **API 同步链两步分别跑**：`nx run server:export-openapi` → `nx affected -t generate`（漏第一步静默拿陈旧 json）。
15. **mobile hook 依赖只放 `refetch`**，🚫 整个 `useQuery` 结果对象进 `useFocusEffect` / `AppState` 回调依赖（自激请求风暴）；🚫 改 react-query 全局 `focusManager`。
16. **枚举 → 文案用 `Record<Enum, string>` 穷举**（非 `Partial`）；订单类型只映射 `NORMAL → 限价单`，其余原样，🚫 为未验证的类型编文案。
17. **真机截图含真实持仓 ⇒ 只留本机**，🚫 贴 PR body / commit / issue（本仓公开，per `information-boundary.md`）。
18. **新文件首跑带 `--skip-nx-cache`**；注释出处照 `comment-provenance.md`（私有数据观测值只写定性 + 私有证据路径，不写条数）。

## Tasks

### Server 基础：纯函数与时间

- [X] T001 [P] [Server] **`broker-position-display.rules.ts`：展示过滤 + 分组 + 组值 + 全序排序 + 到期判定**（FR-001, FR-003, FR-004, FR-005, FR-006, FR-011, FR-021; plan D3, D4, D5, D6; state_branches 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 21, 23, 24; US1）：导出 `buildPositionGroups({ rows, anchoredTickers, anchorSpots, now })` ⇒ `{ unresolvedCount, groups }`：`underlyingTicker === null` 计入 `unresolvedCount` 不进组；∉ 锚集丢弃；分组键 `underlyingTicker`，多连接各自成行（行原样带 `market` / `connectionLabel`）；`groupMarketValue` / `groupUnrealizedPl` = 非空者带符号求和（Decimal），全空 ⇒ null；组头现价 = 组内排序第一的正股行 `currentPrice`，无正股 ⇒ `anchorSpots.get(ticker) ?? null`；组内：正股段在前、期权段在后，各段 `openedAt` 升序（null 段尾）→ `code` → `connectionLabel` → `id`；跨组：`|groupMarketValue|` 降序、null 排末 → ticker 升序（组值 0 按 0 排）。每行附 `expired`：期权 `daysToExpiry({ expiry, now, exchange: market }) < 0`，正股 false。🚫 import `inBrokerScope`。复杂度注释 O(n log n) → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-position-display.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 未解析行不进组、`unresolvedCount` 计数（branch 9）② 非锚标的行丢弃（8）③ `unresolvedCount` 为 0 / 2 两例（10 的服务端半）④ 只有 1 行的组 `rows.length === 1`（11）⑤ 3 行组组值 = 带符号求和；其中 1 行 `marketValue` null 时只和非空；全 null ⇒ null（12）⑥ 组内有正股 ⇒ 取正股现价（15）⑦ 无正股、锚现价非空 ⇒ 取锚现价（16）⑧ 无正股、锚现价 null ⇒ null（17）⑨ 组内排序：正股先、期权按开仓时间升序、null 末；把输入打乱两次结果逐项相同（18）⑩ 跨组按 `|组值|` 降序、并列按 ticker、null 组排末（19）⑪ 组值恰为 0 的组排在 null 组之前（Edge「组市值为 0」）⑫ 两个连接持有同一合约 ⇒ 两行、数量不合并、各带自己的 `connectionLabel`（21）⑬ 美股期权到期日 = 美东今天、`now` = 北京次日 03:00 ⇒ `expired=false`（24）；到期日 = 美东昨天 ⇒ `true`（23）；定向变异：a. 期权段改为开仓时间降序 → ⑨ 红 · b. 过滤改调 `inBrokerScope` → ① 红 · c. 到期判定改用北京日期 → ⑬ 红（留档）

- [X] T002 [P] [Server] **`broker-lots.rules.ts`：持仓批次 FIFO 还原**（FR-013, FR-014, FR-015; plan D10; state_branches 26, 27, 28, 29, 30, 31, 32; US2）：导出 `restoreLots({ deals, positionQty, currentPrice, positionMarketValue, orders })` ⇒ `{ restorable, lots }`。`deals` 按 `(tradedAt, dealId)` 升序（与 `broker-opened-at.rules.ts` 同排序键）；带符号累计（`BUY` / `BUY_BACK` 正，`SELL` / `SELL_SHORT` 负），累计由 0 变非 0 或正负翻转 ⇒ 清空批次开新周期（翻转那笔先抵平旧仓、余量开新批次）；同向成交按 `orderId` 归批次（null ⇒ 该笔单独成批次、`orderDbId = null`），成本 = 批次成交数量加权均价；反向成交按批次开仓时间从早到晚扣减；输出剩余 ≠ 0 的批次（带 `originalQty` = 批次开仓成交数量合计、`remainingQty`）按开仓时间升序；`restorable` ⇔ Σ剩余（带符号）= `positionQty`。批次 `marketValue = positionMarketValue × 剩余 ÷ positionQty`；`unrealizedPl = （currentPrice − 成本）× 剩余 × 乘数`，乘数 = 开仓订单 `amount ÷（qty × price）` 取整，订单缺失或 `price = 0` ⇒ 乘数与盈亏 null。Decimal 运算；复杂度注释 O(n log n) → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-lots.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 订单 A 分两次成交 ⇒ 1 个批次、数量为两次之和、成本为加权均价（branch 26）② 🚨 A 开 2 张 @ 高价、B 开 1 张 @ 低价、买回 1 张 ⇒ A 剩 1、B 剩 1，A 成本不变（27；FIFO 反例，LIFO 实现此臂红）③ A 被扣为 0 ⇒ 不输出（28）④ Σ剩余 = 持仓 ⇒ `restorable=true`（29）⑤ 空头持仓 −3、批次合计 −2 ⇒ `false`（30）⑥ 组合单一腿的成交 `orderId` 指向组合订单 ⇒ 批次 `orderDbId` = 该订单（31）⑦ 开仓成交 `orderId` 为 null ⇒ 单独批次、`orderDbId=null`（32）⑧ 清仓后重开 ⇒ 只输出重开后的批次（Edge「清仓后重新开仓」）⑨ 一笔卖出量超过多头持仓 ⇒ 旧批次清零、余量成为新空头批次 ⑩ 到期作废 `BUY_BACK @0` 按 FIFO 扣减最早批次（US2-AS3）⑪ 乘数：订单 `amount = qty × price × 500` ⇒ 批次盈亏按 500 计；开仓订单缺失 ⇒ 盈亏 null、市值仍按比例拆分 ⑫ 被扣减 1 张的批次 `originalQty=2`、`remainingQty=1`；定向变异：a. 扣减改为从最晚批次起（LIFO）→ ② 红 · b. 清仓处不重置批次 → ⑧ 红 · c. `restorable` 改比较绝对值 → ⑤ 红（留档）

- [X] T003 [P] [Server] **`broker-freshness.rules.ts`：数据陈旧判定**（FR-009; plan D7; state_branches 6, 7, 44; US1）：导出常量 `STALE_GRACE_MINUTES = 60`（注释：覆盖 082 同日 3 次 × 15 分钟重试，spec Assumptions）与两个纯函数：① `resolveJudgementSlot({ market, nowLocal, todayStatus })` ⇒ `'today' | 'previous-trading-day'`：今天非 `non-trading`（`unknown` 按交易日）∧ `nowLocal.minutesOfDay ≥ slot + 宽限` ⇒ `'today'`，否则 `'previous-trading-day'`；`slot` **import** `RECONCILE_SLOT_MINUTES`（🚫 另写）② `isStale({ market, judgementDate, lastSyncLocal })` ⇒ `{ stale, undeterminable }`：`judgementDate === null`（调用方拿不到上一交易日）⇒ `{ stale: false, undeterminable: true }`；`lastSyncLocal === null` ⇒ `{ stale: false, undeterminable: false }`；否则 `stale` ⇔ `lastSyncLocal` 早于（`judgementDate`, slot） → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-freshness.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 昨天时点已成功同步、今天未过宽限（时点 + 59 分钟）⇒ 取上一交易日时点 ⇒ 不陈旧；今天 + 60 分钟且今天未成功 ⇒ 取今天时点 ⇒ 陈旧（branch 6, 7）② 今天时点后已成功同步 ⇒ 不陈旧（7）③ 今天非交易日 ⇒ `'previous-trading-day'`（Edge「陈旧判定跨非交易日」）④ 🚨 最近成功同步在前天、今天刚过时点 10 分钟（宽限内）⇒ 取上一交易日时点 ⇒ **陈旧**（Edge「昨天对账没有成功」；analyze H5）⑤ 今天交易日、未到时点、昨天已同步 ⇒ 不陈旧 ⑥ `judgementDate = null` ⇒ `{ stale: false, undeterminable: true }`（44）⑦ `lastSyncLocal = null` ⇒ 不陈旧 ⑧ `unknown` 按交易日；另 `rg -n '550|545' apps/server/src/optionsdesk/broker-freshness.rules.ts` 零命中（时点只 import）；定向变异：a. 判定时点改为「今天时点 + 当前已过宽限」→ ④ 红 · b. `judgementDate` 为 null 时改回落前一个日历日 → ⑥ 红 · c. 宽限比较 `≥` 改 `>` → ① 的 + 60 分钟侧红（留档）

- [X] T004 [P] [Server] **`session-clock.ts` 导出 `exchangeLocalDateTime`**（FR-017; plan D13; US2/US3）：新增导出 `exchangeLocalDateTime(market: string, instant: Date): string`，返回交易所当地 `YYYY-MM-DD HH:mm:ss`；实现照私有 `timeInTimeZone`（`:97-112`）用 `Intl.DateTimeFormat('en-CA', { timeZone, …, second: '2-digit', hourCycle: 'h23' }).formatToParts`；docblock 写明「optionsdesk 展示用交易所当地时间串的唯一产出点，禁在调用点另写时区换算」 → verify: `pnpm nx test server apps/server/src/marketdata/session-clock.spec.ts --skip-nx-cache` 先红 → 绿，臂：① `us` + `2026-09-08T18:05:12Z`（EDT）⇒ `2026-09-08 14:05:12` ② `us` + `2026-11-03T19:05:12Z`（EST）⇒ `2026-11-03 14:05:12` ③ `hk` + `2026-09-08T06:05:12Z` ⇒ `2026-09-08 14:05:12` ④ 当地午夜整点 ⇒ 小时为 `00` 不是 `24` ⑤ 美东前一天晚上、北京已是次日 ⇒ 日期为美东日期；`pnpm tsx scripts/checks/check-time-semantics.ts` exit 0；定向变异：去掉 `timeZone` 选项 → ① 红（留档）

### Server 读接口（US1 · US2 · US3 · US4）

- [ ] T005 [Server-IT] **`list-broker-positions`（上）：端点骨架 + 列表主体**（FR-001, FR-002, FR-003, FR-005, FR-007, FR-011, FR-012, FR-021; plan D1, D2, D3, D6, D8; state_branches 1, 8, 9, 16, 20, 21, 23; US1）：新建 `broker-account.controller.ts`（`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `optionsdesk-read-account` 限频，照 `optionsdesk.controller.ts:165,185-217`；`@Req() req: { user: AuthenticatedUser }`，类型从 `account/jwt-auth.guard.ts` import）与 `broker-account.dto.ts`；`GET /optionsdesk/broker-positions?market=us|hk`。use case：读账号连接（`hasConnection` / `brokerCount`）→ 锚集 + 锚现价（`resolveAnchorSpot`）→ 该账号该市场持仓 → `resolveInstrumentNames` 批量取名 → `parseBrokerCode` 期权字段 → `raw.unrealized_pl` / `raw.pl_ratio_avg_cost`（`N/A` / 缺失 ⇒ null，`EVIDENCE:` 定性指 plan 前验证 V0a）→ 行带 `market` 与 `connectionLabel`（连接行 `label`）→ `buildPositionGroups`（T001）。DTO 含 `syncedAt` / `syncedAtLocal` / `stale` 字段，本 task 先恒返 `null` / `null` / `false`，由 T006 实现并转红→绿。`optionsdesk.module.ts` 登记 controller + use case → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-083.broker-positions-read.it.spec.ts --skip-nx-cache` 先红 → 绿（`OptionsdeskModule` 真装配，经 HTTP 注入带真 JWT），臂：① 账号无连接 ⇒ `hasConnection=false`、`groups=[]`（branch 1）② 非锚持仓不返回、未解析持仓计入 `unresolvedCount`（8, 9）③ 1 个连接 ⇒ `brokerCount=1`；2 个连接 ⇒ `brokerCount=2`、同合约两行各带自己的 `connectionLabel`（20, 21）④ 已过期期权行 `expired=true`（23）⑤ 🚨 账号 B 请求 ⇒ 看不到账号 A 的任何持仓（SC-006 列表面）⑥ 删掉锚 ⇒ 该正股持仓不再返回（Edge「删除锚」）⑦ 行字段：持仓盈亏取自 `raw.unrealized_pl`、比例取 `raw.pl_ratio_avg_cost`，`raw` 为 `N/A` ⇒ null（US1-AS4）⑧ 行带 `market`；`connectionLabel` = 连接行 `label`，不是 `brokerCode`（Edge「同一券商有两个连接」）⑨ 组内只有期权 ⇒ 组头现价 = 锚现价（16）；`pnpm tsx scripts/checks/check-server-moat.ts` exit 0；`pnpm tsx scripts/checks/check-api-property-nullable.ts` exit 0；定向变异：a. 持仓查询去掉 `accountId` 条件 → ⑤ 红 · b. `connectionLabel` 改取 `brokerCode` → ⑧ 红（留档）

- [ ] T006 [Server-IT] **`list-broker-positions`（下）：同步时刻 + 陈旧 + 空态口径**（FR-008, FR-009, FR-010; plan D7; state_branches 2, 3, 5, 6, 7, 44; US1）：use case 补：同步时刻 = 该账号成功记录中「`reconcile` ∧ `market=m`」或「`backfill` ∧（`target='*'` ∨ `target` 以 `m:` 开头）」的 `finishedAt` 最大值；`resolveJudgementSlot`（T003）→ 为 `'previous-trading-day'` 时才调 `TRADING_CALENDAR_PORT.previousTradingDay`（注入点挂 `// CROSS-CONTEXT-SYNC:`）→ `isStale` → `undeterminable` 时 `logger.warn`（不含账号）；`syncedAtLocal` 经 `exchangeLocalDateTime`（T004） → verify: 同一 IT 文件续臂先红 → 绿（日历 port 注入 test double 固定交易日），臂：① 有连接无成功记录 ⇒ `syncedAt=null`（branch 2）② 有成功对账、锚标的持仓为 0 但有 2 条未归类 ⇒ `groups=[]`、`syncedAt` 非空、`unresolvedCount=2`（3）③ 🚨 先一条成功对账、再一条失败对账 ⇒ `syncedAt` = 成功那条 `finishedAt`，持仓照常返回（5）④ 🚨 只有一条 `target='us:ZQX'` 的成功补齐（`market` 为空）⇒ 美股 `syncedAt` 有值、港股为 null（V5）⑤ 固定 `now`：今天时点 + 60 分钟、今天未成功 ⇒ `stale=true`；+ 59 分钟、昨天已成功 ⇒ `false`（6, 7）⑥ 🚨 最近成功在前天、今天时点 + 10 分钟 ⇒ `stale=true`（Edge「昨天对账没有成功」）⑦ 日历 double 的 `previousTradingDay` 返回 null ⇒ `stale=false` 且捕获到一条 warn 日志（44）⑧ `syncedAtLocal` 为交易所当地时间串；定向变异：a. 同步时刻只按 `market` 列筛 → ④ 红 · b. null 时改回落前一个日历日 → ⑦ 红（留档）

- [ ] T007 [Server-IT] **`get-broker-position`：持仓详情 + 订单列表 + 批次**（FR-001, FR-002, FR-013, FR-014, FR-015, FR-016, FR-017, FR-020; plan D1, D9, D10; state_branches 25, 29, 30, 34, 35, 36, 39, 40; US2/US3）：`GET /optionsdesk/broker-positions/:id`。`findFirst({ id, accountId })`；不存在 / 正股未归类 / 不在锚集 ⇒ 404（照 `get-anchor.usecase.ts:36` 体例，三种情况响应逐字节相同）。汇总 = T005 行字段（含 `market`、`connectionLabel`）+ `openedAtLocal`。订单列表：该连接下 `code = 持仓代码` 或 `comboLegCodes` 含持仓代码；`openedAtSource='derived'` ⇒ `vendorUpdatedAt ≥ openedAt`，`fallback` ⇒ 全部；`vendorCreatedAt` 降序、null 末 → `orderId`；项含 `id` / `side` / `qty` / `price` / `status` / `createdAtLocal`。期权 ⇒ 读该合约成交 + 订单 → `restoreLots`（T002）；正股 ⇒ `lots=null` → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-083.broker-position-detail.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 期权持仓 ⇒ 汇总 + 批次 + 本合约订单（branch 25）② 批次合计 = 持仓 ⇒ `restorable=true`；种入缺一笔开仓成交 ⇒ `false`（29, 30）③ 🚨 开仓订单 `vendorCreatedAt` 早于 `openedAt`、`vendorUpdatedAt` 晚于它 ⇒ **在**列表里（34；V2）④ `openedAtSource='fallback'` ⇒ 早于首次发现的订单也在列表里（35）⑤ 已撤单与失败订单照常返回并带状态（36）⑥ 正股持仓 ⇒ `lots=null`；被指派产生的正股订单（价格 = 行权价）在列表里（Edge「被指派得到的正股持仓」）⑦ 🚨 账号 B 请求账号 A 的持仓 id ⇒ 与请求不存在 id 的状态码与响应体完全相同（39）⑧ 持仓行被删除后请求原 id ⇒ 404（40）⑨ 未归类 / 不在锚集的持仓 id ⇒ 与不存在相同的 404（39）⑩ `comboLegCodes` 含本合约的组合订单在列表里 ⑪ 订单按 `vendorCreatedAt` 降序、null 排末 ⑫ 响应带 `market`；批次项带 `originalQty` / `remainingQty`；定向变异：a. 过滤改按 `vendorCreatedAt` → ③ 红 · b. 改为 `findUnique` 后比账号并返回 403 → ⑦ 红（留档）

- [ ] T008 [Server-IT] **`get-broker-order`：订单详情**（FR-001, FR-002, FR-017, FR-020; plan D1, D11; state_branches 38, 39, 45; US2/US3）：`GET /optionsdesk/broker-orders/:id`。`findFirst({ id, accountId })`；不存在 / 订单 `underlyingTicker` 为 null / 不在锚集 ⇒ 404（同 T007 体例，三种情况响应相同）。字段：`market` / `side` / `status` / `orderType` / 名称代码（同 T005）/ `comboLegCodes` / `qty` / `price` / `amount`（`raw.amount`）/ `dealtQty`（`raw.dealt_qty`）/ `dealtAvgPrice`（`raw.dealt_avg_price`）/ `dealtAmount` / `currency` / `createdAtLocal`。`dealtAmount = dealtQty × dealtAvgPrice × 乘数`（乘数同 T002 口径，取本订单）；`dealtQty` 为 0 或缺失 ⇒ 三个成交字段 null；`price = 0` 的订单 ⇒ `dealtAmount = 0` → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-083.broker-order-detail.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 全部成交期权订单 ⇒ `dealtAmount` = 成交数量 × 均价 × 乘数（`amount = qty × price × 500` 推出 500）② 未成交即撤销 ⇒ 成交三字段 null（branch 38）③ 价格为 0 的到期作废系统单 ⇒ `dealtAmount = 0` ④ 组合单 ⇒ `comboLegCodes` 两个腿码 ⑤ 🚨 账号 B 请求账号 A 的订单 id ⇒ 与不存在 id 响应完全相同（39）⑥ 响应带 `market`，`createdAtLocal` 为交易所当地时间串 ⑦ 订单正股不在锚集 ⇒ 与不存在 id 相同的 404（39, 45）；定向变异：a. `dealtAmount` 去掉乘数 → ① 红 · b. 去掉锚集判断 → ⑦ 红（留档）

- [ ] T009 [Server-IT] **`list-broker-backfill-runs`：新锚券商历史补齐状态**（FR-002, FR-018; plan D12; state_branches 41, 42; US4）：`GET /optionsdesk/broker-backfill-runs?tickers=`（逗号分隔 ≤ 50，每个匹配 `^(us|hk):`，否则 400）。对每个 ticker 取该账号 `kind='backfill'` ∧ `target=ticker` 的最新一条（`createdAt` 降序）：`status` + `at`（`succeeded` / `failed` → `finishedAt`；`running` → `startedAt`；`pending` → `nextAttemptAt`）+ `atLocal`；无记录的 ticker 不出现 → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-083.broker-backfill-runs.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 四种状态各一只 ticker ⇒ 状态与对应时刻正确（branch 41）② 无记录的 ticker 不在响应里（42）③ 同一 ticker 先失败后成功 ⇒ 返回成功那条 ④ 账号 B 看不到账号 A 的记录 ⑤ 51 个 ticker / 非法形态 ⇒ 400；定向变异：排序改为 `createdAt` 升序 → ③ 红（留档）

- [ ] T010 [Contract] **OpenAPI 导出 + api-client 重生成**（FR-008; plan Constitution §V; US1/US2/US3/US4）：依次跑 `pnpm nx run server:export-openapi` → `pnpm nx affected -t generate`（两步分别跑，🚫 只跑第二步）；核对生成的 4 个 hook 与响应类型可被 mobile import → verify: `git diff --stat apps/server/openapi.json packages/api-client/src/generated/` 含 4 个新端点；`grep -n 'broker-positions\|broker-orders\|broker-backfill-runs' apps/server/openapi.json` 各有命中；`pnpm nx run mobile:typecheck` 绿；nullable 标量字段在生成类型里是 `string | null` 而非 `{ [key: string]: unknown } | null`

- [X] T011 [P] [Docs] **ADR-0043 复审记录：#1 fired · mitigated**（plan Gate 0.4）：`docs/adr/0043-server-flat-module-paradigm.md` 追加复审记录：optionsdesk use case 20 → 24 越过 #1；缓解 = 不建子目录、按 `broker` 名词段分组（现状：锚与许愿单 14 / 雷达·链报告·腿·详情·温度计 5 / 券商镜像 5，列出查询命令 `rg -l broker apps/server/src/optionsdesk/*.usecase.ts`）；否决的三个替代与理由；**下次复审线 = optionsdesk use case 达 30 个**（维护者 2026-09-15 定）；frontmatter `sunset_trigger` #1 行尾补状态注记 → verify: `pnpm tsx scripts/check-adr-frontmatters.ts` 绿；`npx prettier --check docs/adr/0043-server-flat-module-paradigm.md` 绿；`pnpm tsx scripts/checks/check-identifier-boundary.ts` exit 0

### Mobile 持仓列表（US1）

- [ ] T012 [P] [Mobile] **`~/format/compact-amount.ts`：金额「万」缩写**（FR-022; plan D14; US1）：导出 `formatCompactAmount(value: string | null, opts?: { signed?: boolean })` 与 `formatFullAmount(value, opts)`：null / 非法 ⇒ `--`；`|n| < 1e4` ⇒ 千分位 2 位小数；`1e4 ≤ |n| < 1e8` ⇒ `x.xx万`；`≥ 1e8` ⇒ `x.xx亿`；`signed` 时正数带 `+`；文件头注释说明与 `portfolio/stock-detail.helpers.ts:107-115` 的关系（预存在同类函数、跨 feature 不可 import、本片不重构） → verify: 新建 `apps/mobile/src/format/compact-amount.spec.ts` 先红 → 绿（`pnpm nx test mobile`），臂：① `9999.99` ⇒ `9,999.99` ② `10000` ⇒ `1.00万` ③ `-10000` ⇒ `-1.00万` ④ `99999999` ⇒ `10000.00万` ⑤ `100000000` ⇒ `1.00亿` ⑥ `signed` + `600` ⇒ `+600.00` ⑦ null / `'abc'` ⇒ `--` ⑧ `formatFullAmount('37560')` ⇒ `37,560.00`；定向变异：阈值 `>=` 改 `>` → ② 红（留档）

- [ ] T013 [Mobile] **`trading-account-positions.rules.ts` + 独立文案段**（FR-004, FR-007, FR-010, FR-011, FR-012, FR-017, FR-023; plan D14, D17; state_branches 1, 2, 3, 4, 10, 11, 12, 20, 22, 43; US1）：导出 `resolvePositionsView({ hasData, isError, data })` ⇒ `'error' | 'no-connection' | 'never-synced' | 'empty' | 'list'`（优先级：无已加载数据且失败 → 无连接 → 从未同步 → 空 → 列表）与 `refetchFailed({ hasData, isError })`（有数据且最近一次请求失败）；`showGroupHeader(group)`（`rows.length ≥ 2`）；`showConnectionLabel(brokerCount)`（> 1）；`showUnresolvedHint(count)`（> 0，空态同样适用）；`optionDisplayName({ market, underlyingName, right })`（港股 `购 / 沽`、美股 `Call / Put`）；`expiryYymmdd('2026-09-29')` ⇒ `260929`；`trimStrike('12.500')` ⇒ `12.5`、`'300.000'` ⇒ `300`；`localDateTimeParts(str)` ⇒ `{ ymd: '2026/09/08', hms: '14:05:12', mdHm: '09-08 14:05' }`；`marketTzLabel(market)` ⇒ `（美东）` / `（香港）`。`optionsdesk-copy.ts` **新建** `tradingAccountPositions` 段（🚫 追加进 081 的 `tradingAccount` 段）：四种状态、陈旧提示（中性措辞「数据可能已过时 · 最近成功同步于 …」）、刷新失败提示「刷新失败，显示的是上次加载的数据」、未归类提示、已到期标、同步时刻行 → verify: 新建 `trading-account-positions.rules.spec.ts` 先红 → 绿，臂：① 无连接 ⇒ `no-connection`（branch 1）② 有连接 `syncedAt=null` ⇒ `never-synced`（2）③ `groups=[]` ⇒ `empty`，`unresolvedCount=2` 时 `showUnresolvedHint` 为真（3）④ 无已加载数据且请求失败 ⇒ `error`（4）⑤ 🚨 已有数据且重读失败 ⇒ 视图仍为 `list`、`refetchFailed=true`（43）⑥ 未归类 0 / 2 ⇒ 提示不显示 / 显示（10）⑦ 1 行组无组头、3 行组有组头（11, 12）⑧ `brokerCount` 1 / 2 ⇒ 不显示 / 显示连接标签（20）⑨ 港股沽 ⇒ `示例汽车 沽`、美股 Call ⇒ `ZQY 示例 Call`（22）⑩ 到期日 6 位、行权价去尾零 ⑪ 时间串拆分与时区标签 ⑫ `git diff origin/main -- apps/mobile/src/optionsdesk/trading-account.rules.spec.ts` 为空且该 spec 仍绿（analyze H7）；`pnpm nx test mobile` 绿；定向变异：a. 有数据时失败也返回 `error` → ⑤ 红 · b. 把「暂无持仓」放进 `tradingAccount` 段 → 081 的 `trading-account.rules.spec.ts` ⑤ 红（留档后还原）

- [ ] T014 [Mobile] **数据 hook + 持仓分段状态卡与列表外壳**（FR-008, FR-009, FR-010, FR-011; plan D14; state_branches 1, 2, 3, 4, 5, 10; US1）：新建 `use-trading-account-positions.ts`（包生成 hook，照 `use-underlying-detail.ts`：query key 常量、暴露 `refetch` / `isRefetching` / `isError` / `data`）；`trading-account-screen.tsx` 持仓分段改渲染 `TradingAccountPositions`，按 `resolvePositionsView`（T013）出四种状态卡与列表外壳（同步时刻行或陈旧条 + 未归类提示 + 列头）；订单 / 报表分段保持 081 占位；文件头「MUST NOT import `@nvy/api-client`」注释改为「订单 / 报表分段零数据面」 → verify: 新建 `apps/mobile/e2e/optionsdesk-trading-account-positions.spec.ts`（`test` 从 `_support/fixtures` import；mock `/me` + refresh + 本片端点，数据全合成）先红 → 绿，臂：① 无连接响应 ⇒「暂无交易账户」、无空仓字样（branch 1）② `syncedAt=null` ⇒「尚未同步」（2）③ 空 `groups` ⇒「暂无持仓」且显示同步时刻；`unresolvedCount=2` 时未归类提示同时可见（3）④ 首次请求列表端点 500 ⇒「持仓加载失败」+ 重试，改为 200 后点重试出列表外壳（4）⑤ `stale=true` ⇒ 陈旧条 + 列表同时可见（5；US1-AS6）⑥ `unresolvedCount` 2 / 0 ⇒ 提示可见 / 不可见（10；US1-AS5）⑦ 订单 / 报表分段仍为「建设中」占位；定向变异：状态优先级把 `empty` 放在 `no-connection` 之前 → ① 红（留档）

- [ ] T015 [Mobile] **分组列表：组头 / 折叠 / 行 / 万缩写 / 已到期标 / 连接标签**（FR-003, FR-004, FR-005, FR-006, FR-007, FR-012, FR-021, FR-022; plan D14; state_branches 11, 12, 13, 20, 21, 22, 23; US1）：`trading-account-positions.tsx` 用 `SectionList`（照 `portfolio/trade-history-screen.tsx:149-170`）：每组一个 section，`showGroupHeader` 为真出组头（三角标 + 名称(行数) + 组市值 · 正股现价 · 组持仓盈亏），折叠状态 = 组件内 `useState<Set<string>>`（进详情再返回列表屏未卸载 ⇒ 保留；离开交易账户页 ⇒ 卸载即丢），折叠时 section `data=[]`；行 = 名称代码（期权第二行 到期 6 位 + 行权价）· 市值 / 数量 · 现价 / 成本 · 持仓盈亏金额 / 比例；主列表金额（市值、组市值、盈亏金额、组盈亏）用 `formatCompactAmount`（T012），数量 / 价格 / 比例不缩写；涨跌色 `text-quote-up` / `text-quote-down` / `text-quote-flat`；`expired` 行显示「已到期 · 待同步」标；`showConnectionLabel` 为真显示 `connectionLabel`；className 每元素 ≤ 4 原子、禁 inline 字面量 → verify: T014 的 e2e 续臂先红 → 绿，臂：① 3 行组 ⇒ 组头「ZQY 示例(3)」、组市值与组盈亏为万缩写形态、组头现价为正股行现价（branch 12；US1-AS1）② 单行组 ⇒ 无组头直接出行（11；US1-AS2）③ 点组头 ⇒ 组内行隐藏，再点 ⇒ 显示；折叠后进持仓详情再返回 ⇒ 仍折叠；折叠后返回雷达再进入交易账户页 ⇒ 全部展开（13；US1-AS7）④ 港股空头认沽 ⇒ 名称「示例汽车 沽」、第二行 `261029 7.25`、数量与市值为负（22；US1-AS3）⑤ `expired=true` 行 ⇒「已到期 · 待同步」可见（23；US1-AS9）⑥ `brokerCount=1` ⇒ 无连接标签；`=2` 且同合约两行 ⇒ 两行各显示自己的连接名称（20, 21）⑦ `marketValue='37560'` 在主列表显示 `3.76万`（FR-022）；定向变异：折叠状态改放 `trading-account-store` → ③ 的「返回雷达再进全部展开」红（留档）

- [ ] T016 [Mobile] **重读触发 + 重读失败保留数据**（FR-008, FR-023; plan D14; state_branches 14, 43; US1）：新建 `use-refetch-on-foreground.ts`（`AppState` 由非 `active` 变 `active` 调 `refetch`，依赖只放 `refetch`）；持仓分段接 `useFocusEffect` 聚焦重读 + `RefreshControl` 下拉重读；`refetchFailed`（T013）为真时同步时刻行换成刷新失败提示，下次成功恢复；三者只重读本系统数据，不触发券商同步 → verify: T014 的 e2e 续臂先红 → 绿，臂：① 下拉重读 ⇒ 列表端点命中次数 +1、同步时刻更新为新响应值，且没有请求任何非本片端点（branch 14 下拉面；US1-AS8）② 派发 `visibilitychange`（hidden → visible）⇒ 列表端点命中次数 +1（14 回前台面；若 react-native-web 不映射到 `AppState`，本臂标 `test.fixme` 注明原因、移交 T023 真机核，🚫 删掉）③ 🚨 列表已显示，下一次请求 500 后下拉 ⇒ 列表行仍可见、同步时刻行显示「刷新失败，显示的是上次加载的数据」；再改为 200 下拉 ⇒ 提示消失、数据更新（43；US1-AS10；Edge「下拉重读失败」）④ 聚焦面不在本 task 验：交易账户页从雷达 push 进入，「进雷达再返回」是重新挂载、测不出聚焦触发；改由 T017-⑩（进持仓详情再返回）验证；定向变异：a. `RefreshControl` 去掉 `onRefresh` → ① 红 · b. 重读失败时渲染错误卡 → ③ 红（留档）

### Mobile 下钻（US2 · US3）

- [ ] T017 [Mobile] **持仓详情屏：路由 + 汇总 + 订单段 + 加载 / 404 / 重读**（FR-002, FR-008, FR-016, FR-017, FR-020, FR-023; plan D15; state_branches 14, 34, 36, 40, 43, 46; US3）：新建 `app/(app)/optionsdesk/trading-account-position/[id].tsx`（薄路由，`useLocalSearchParams` 取 id）+ `trading-account-position-screen.tsx`；`_layout.tsx` 加 `Stack.Screen`（`headerLeft: makeHeaderBackOrParent('/(app)/optionsdesk/trading-account')`）；`optionsdesk-routes.ts` 加路由常量 + `optionsdesk-routes.spec.ts` 表；列表行点击 → 本路由。屏：汇总卡（名称代码、数量、市值、现价、平均成本、持仓盈亏、开仓时间 + 按响应 `market` 的时区标签，全精度 `formatFullAmount`）→「订单」/「本合约订单」段（下单时间、方向 数量 @ 价格、状态标）；无已显示数据时失败 ⇒「加载失败 + 重试」；404 ⇒「持仓已不存在」卡且**优先于**已显示数据；已有数据时重读失败 ⇒ 保留 + 顶部刷新失败提示；聚焦 / 回前台 / 下拉重读同 T016 形态 → verify: `optionsdesk-routes.spec.ts` 新臂先红 → 绿；T014 的 e2e 续臂先红 → 绿，臂：① 点正股行 ⇒ 持仓详情显示汇总与订单列表（branch 34；US3-AS1）② 已撤单订单状态标可见（36；US3-AS3）③ 详情端点首次 500 ⇒「加载失败 + 重试」（46）④ 首次即 404 ⇒「持仓已不存在」（40）⑤ 🚨 详情已显示后下拉、响应 404 ⇒「持仓已不存在」替换旧数据（40；FR-020）⑥ 🚨 详情已显示后下拉、响应 500 ⇒ 汇总仍可见 + 顶部「刷新失败」提示（43）⑦ 下拉 ⇒ 详情端点命中次数 +1（14 下钻面）⑧ 深链直接进入详情后 header 返回 ⇒ 落到交易账户页（返回写法照 081 T003 臂 ②，禁 `page.goBack`）⑨ 开仓时间后的时区标签由响应 `market` 决定（美股 ⇒「（美东）」）⑩ 从持仓详情返回交易账户页（列表屏未卸载，只靠聚焦触发）⇒ 列表端点命中次数 +1（14 聚焦面）；定向变异：a. 404 时保留旧数据 → ⑤ 红 · b. 重读失败时渲染错误卡 → ⑥ 红（留档）

- [ ] T018 [Mobile] **订单详情屏 + 枚举文案映射**（FR-008, FR-017, FR-019, FR-020, FR-023; plan D11, D15, D17; state_branches 14, 31, 37, 38, 43, 45, 46; US2/US3）：新建 `app/(app)/optionsdesk/trading-account-order/[id].tsx` + `trading-account-order-screen.tsx`；`_layout.tsx` / `optionsdesk-routes.ts` 同 T017 登记；`tradingAccountPositions` 文案段追加 `orderStatusLabel: Record<17 值, string>`、`tradeSideLabel: Record<5 值, string>`（`SELL_SHORT → 卖空`、`FILLED_ALL → 全部成交` 与维护者 App 截图一致）、`orderTypeLabel`（只含 `NORMAL → 限价单`，查不到返回原枚举名）、订单不存在。屏：交易方向 / 订单状态 / 名称代码 / 订单数量·价格 / 订单金额 / 成交数量·均价 / 成交金额（全精度 `formatFullAmount`）/ 下单时间（`YYYY/MM/DD` + `HH:mm:ss（时区）`，时区按响应 `market`）/ 订单类型；组合单另列各腿；成交字段 null ⇒ `—`；404 ⇒「订单不存在」且优先于已显示数据；无已显示数据时失败 ⇒「加载失败 + 重试」；已有数据时重读失败 ⇒ 保留 + 顶部提示；聚焦 / 回前台 / 下拉重读同 T016 形态；🚫 任何操作按钮 → verify: 文案映射 spec 先红 → 绿：① 状态 17 值、方向 5 值全部有非空文案 ② `orderTypeLabel('NORMAL')` ⇒ `限价单`、`('MARKET')` ⇒ `MARKET`；T014 的 e2e 续臂先红 → 绿：③ 从正股持仓详情点订单 ⇒ 订单详情九个字段可见，且从持仓列表起恰 2 次点击（正股行 → 订单）到达（branch 37；US2-AS5；SC-004）④ 未成交订单 ⇒ 成交数量 / 均价 / 金额显示 `—`（38；US3-AS4）⑤ 组合单 ⇒ 两个腿码可见（31；US2-AS6）⑥ 404 ⇒「订单不存在」（45）⑦ 首次 500 ⇒「加载失败 + 重试」（46）⑧ 页面不存在任何「撤单 / 改单 / 平仓」字样（FR-019）⑨ 美股订单下单时间带「（美东）」⑩ 下拉 ⇒ 订单详情端点命中次数 +1（14 下钻面）⑪ 🚨 订单详情已显示后下拉、响应 500 ⇒ 字段仍可见 + 顶部「刷新失败」提示（43）⑫ 🚨 订单详情已显示后下拉、响应 404 ⇒「订单不存在」替换旧数据（45；FR-020）；定向变异：a. 成交字段 null 时显示 `0` → ④ 红 · b. 重读 404 时保留旧数据 → ⑫ 红（留档）

- [ ] T019 [Mobile] **持仓详情批次段 + 本合约订单进入订单详情**（FR-013, FR-014, FR-015; plan D15; state_branches 25, 27, 28, 30, 32, 33; US2）：在 T017 的屏上为期权持仓加「持仓批次」段：批次行显示开仓时间（交易所当地 + 时区）、「剩余 / 原始」数量、成本、市值、盈亏；`lots.restorable=false` ⇒「批次无法还原」提示卡且不渲染批次、订单段照常；`orderDbId=null` 的批次不可点、无 `>`；点批次 / 点「本合约订单」项 ⇒ 订单详情路由 → verify: T014 的 e2e 续臂先红 → 绿，臂：① 点期权合约行 ⇒ 持仓详情显示汇总 + 2 个批次 + 本合约订单（branch 25；US2-AS1 / US2-AS7）② 被买回扣减的批次显示「剩余 1 / 2」（27；US2-AS2）③ 响应只含剩余 ≠ 0 的批次时不出现第三行（28）④ `restorable=false` ⇒「批次无法还原」可见、批次行不可见、订单列表仍可见（30；US2-AS4）⑤ `orderDbId=null` 的批次点击无跳转（32）⑥ 点批次 ⇒ 进入订单详情路由，且从持仓列表起恰 2 次点击（期权行 → 批次）（33；SC-004）⑦ 点「本合约订单」中的一张 ⇒ 进入订单详情路由，从持仓列表起恰 2 次点击（SC-004 第三条路径）；定向变异：`restorable=false` 时仍渲染批次 → ④ 红（留档）

### Mobile 冷启动页（US4）

- [ ] T020 [Mobile] **冷启动结局页券商历史状态行**（FR-018; plan D16; state_branches 41, 42, 47; US4）：`anchor-cold-start-screen.tsx` 拿到冷启动结局后以其 ticker 列表调生成的 `list-broker-backfill-runs` hook；`RunRow` 下加一行「券商历史 · 状态标 · 时刻」，按 ticker 合并；无记录 ⇒「未触发」；该请求失败 ⇒ 只隐藏这一行、原结局照常；文案进 `tradingAccountPositions` 段（状态 `Record` 穷举） → verify: T014 的 e2e 续臂（深链进冷启动结局页，mock 既有冷启动端点 + 本片端点）先红 → 绿，臂：① 成功记录 ⇒「券商历史 · 成功」+ 时刻（branch 41；US4-AS1）② 无记录 ⇒「券商历史 · 未触发」（42；US4-AS2）③ 本片端点 500 ⇒ 券商历史行不出现、冷启动结局照常（47）④ 请求的 `tickers` 参数 = 冷启动结局的 ticker 集合；定向变异：按 `anchorId` 而非 ticker 合并 → ① 红（留档）

### E2E · 冒烟 · 治理

- [ ] T021 [P] [Mobile-E2E] **markets-OFF 深链门控**（FR-001; plan D15）：`e2e/markets-feature-gate.spec.ts` 的 `GATED_DEEPLINKS` 加 `/optionsdesk/trading-account-position/1` 与 `/optionsdesk/trading-account-order/1`（期望重定向 `/profile`，note 注明 083 挂在 optionsdesk 栈下、门控靠继承）；同步文件头注释里的深链条数 / 栈内路由条数 → verify: `pnpm nx run mobile:e2e-public` 全绿；变异留档：临时把 `GATED_DEEPLINKS` 过滤到这两条并去掉 `_layout.tsx` 的 `MarketsRouteGuard` 包裹 ⇒ 两条红，恢复后绿（081 T007 实测：不过滤会首败在更早的条目，看不到新条目的红）

- [ ] T022 [Contract-Smoke] **契约冒烟：交易账户读接口**（FR-001, FR-002; plan Gate 0.1; state_branches 1, 39; US1）：新建 `e2e/contract-smoke/optionsdesk-trading-account.contract.ts`（结构照 `optionsdesk.contract.ts` GOLDEN SAMPLE 头注释），用生成的 `@nvy/api-client` 打 testcontainers 真 server：① 无连接账号请求列表 ⇒ `hasConnection=false`、`groups=[]` ② 请求不存在的持仓 id 与订单 id ⇒ 404 且错误体形态与既有 not-found 一致 ③ `list-broker-backfill-runs` 请求一个 ticker ⇒ 空数组；若冒烟装置已有 DB 种数入口，追加一条种入持仓后的列表读取（没有则在文件头注明「装置无种数入口，有持仓路径由 server IT 覆盖」）；在 `run.ts` 登记 → verify: `pnpm nx run mobile:contract-smoke` 本条绿；变异留档：临时把生成 client 的列表路径改错一个字符 ⇒ 本条红（证明真的打到 server）

- [ ] T023 [Gate] **真机窄屏核（Mate50 dev-client）**（FR-004, FR-008, FR-022, SC-005; plan Gate 0.1; state_branches 13, 14）：按 `ops/runbook/local-dev.md`「dev client 连 prod 做验收」流程（只读）打开交易账户页：① 主列表数字列（含万缩写后的最长值）不溢出、不挤压名称列 ② 组头折叠 / 展开可点、进详情返回保留、离开交易账户页再进恢复展开 ③ 下拉重读生效 ④ App 切后台再回前台 ⇒ 列表重读（若 T016 臂 ② 标了 `fixme`，此处为该分支的正式证据）⑤ 进入持仓分段到列表可见 ≤ 2 秒（SC-005，计 3 次取最大）⑥ 期权行 → 持仓详情 → 批次 → 订单详情全链路可点 → verify: 六项结论（通过 / 不通过 + 一句观测）写进 PR body；🚨 **截图含真实持仓，只存本机 `specs/083-optionsdesk-trading-account-positions/design/`（gitignored），🚫 贴 PR body / commit / issue**；任一项不通过停下回 plan，不在 impl 内改方案

- [ ] T024 [Gate] **覆盖收口 + 全量门 + 私有数据扫描 + PR**（SC-002, SC-003, SC-004, SC-006, SC-007, SC-009, SC-010）：逐条核对下方五张覆盖预检表（实时 grep，不抄表内数字）；spec `status → implementing`、`updated_at` bump → verify: `git fetch origin && pnpm nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` 按终态串判定通过（`local-verification.md` §2）；`scripts/checks/*.ts` 治理脚本全扫 0（含 `check-server-moat` / `check-test-size` / `check-time-semantics` / `check-identifier-boundary` / `check-api-property-nullable` / `check-optionsdesk-rule-constants` / `check-spec-frontmatters`）+ `check-commit-msg-parseable.ts --range origin/main..HEAD`；私有数据扫描：`git diff origin/main...HEAD` 与 PR 正文对仓外私有清单（`ops/bin/gen-private-values.sh` 产出）逐值子串比对，命中 0；`gh-bot pr create` 按 `docs/conventions/pr-creation-protocol.md`（`--repo` 显式、body 按模板、3 个 hard-gate checkbox 真跑绿才勾）；无不可逆变更 ⇒ 按 `git-workflow.md` 默认接 auto-merge

- [ ] T025 [Ops] **上线后验收：对照富途 App**（SC-001, SC-003, SC-005, SC-008; plan SC 落点）：前置 = PR 合并、server 发版上线。① SC-001：数量与成本任意时段逐行比对（App 成本口径切平均成本）；现价 / 市值 / 持仓盈亏在「该市场当日对账成功后至开盘前」窗口比对，**顺带核「开盘前现价 = 上一交易日收盘价」**（不成立 ⇒ 修 spec Assumptions 与 SC-001 窗口，不改代码）② SC-003：真实账户中 `restorable=true` 的期权持仓，批次剩余合计与持仓数量一致 ③ SC-008：抽核订单详情（至少 1 张已撤单、1 张被指派产生的系统订单、1 张组合单；账户里没有的类型注明「无样本」）逐字段与 App「交易详情」一致 ④ SC-005 prod 面复核一次 → verify: 四项结论写本行（定性 + 一句观测，🚫 真实代码 / 数量 / 金额）；观测明细记维护者私有 p3 子 plan；spec `status → implemented`、tasks `status → completed`

## 依赖与并行

```text
T001 [P]  T002 [P]  T003 [P]  T004 [P]  T011 [P]  T012 [P]
T001 + T003 + T004 → T005 → T006
T005 + T002 → T007
T005 → T008
T005 → T009
T006 + T007 + T008 + T009 → T010
T010 → T013 → T014 → T015 → T016 → T017 → T018 → T019
T012 → T015
T010 + T013 + T014 → T020
T017 + T018 → T021 [P]
T010 → T022 [P]
T016 + T019 + T018 + T020 → T023
全部 → T024 → T025
```

- **T005 先于 T006–T009**：controller / DTO 文件与模块装配在 T005 建立；T006 在同一 use case 与 IT 文件上续写。
- **T010 是 mobile 的闸**：mobile 规则与屏依赖生成的响应类型。
- **T014 → T020 同一个 e2e 文件逐步续臂**，导航链（列表 → 持仓详情 → 订单详情 → 批次）依次建立；订单详情路由（T018）先于批次段（T019），批次与本合约订单的跳转臂才有落点。

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

> 🚨 **本表编号 = `spec.md` frontmatter `state_branches` 的行序，MUST 逐行同序**。

| # | branch（摘要） | 落点 |
|---|---|---|
| 1 | 无券商连接 ⇒ 暂无交易账户 | T005-① + T013-① + T014-① + T022-① |
| 2 | 从未成功同步 ⇒ 尚未同步 | T006-① + T013-② + T014-② |
| 3 | 已同步但无可展示锚标的持仓 ⇒ 暂无持仓（未归类仍提示） | T006-② + T013-③ + T014-③ |
| 4 | 无已显示数据时加载失败 ⇒ 失败 + 重试 | T013-④ + T014-④ |
| 5 | 最近一次同步失败 ⇒ 保留上次数据 | T006-③ + T014-⑤ |
| 6 | 早于最近一个已过宽限的时点 ⇒ 陈旧 | T003-①④ + T006-⑤⑥ |
| 7 | 不早于该时点 ⇒ 不陈旧 | T003-①②⑤ + T006-⑤ |
| 8 | 正股不在锚集 ⇒ 不展示 | T001-② + T005-② |
| 9 | 判定不出正股 ⇒ 计入未归类 | T001-① + T005-② |
| 10 | 未归类 > 0 提示 / = 0 不提示 | T001-③ + T013-⑥ + T014-⑥ |
| 11 | 1 行 ⇒ 平铺 | T001-④ + T013-⑦ + T015-② |
| 12 | ≥ 2 行 ⇒ 组头 | T001-⑤ + T013-⑦ + T015-① |
| 13 | 进页全展开 / 折叠 / 详情返回保留 / 离开再进恢复 | T015-③ + T023-② |
| 14 | 进页 / 回前台 / 下拉 ⇒ 重读 | T016-①② + T017-⑦⑩ + T018-⑩ + T023-③④ |
| 15 | 有正股行 ⇒ 正股现价 | T001-⑥ |
| 16 | 无正股 ∧ 有最新价 ⇒ 最新价 | T001-⑦ + T005-⑨ |
| 17 | 无正股 ∧ 无最新价 ⇒ 留空 | T001-⑧ |
| 18 | 组内排序 | T001-⑨ |
| 19 | 跨组排序 | T001-⑩⑪ |
| 20 | 1 个连接 ⇒ 无连接标签 | T005-③ + T013-⑧ + T015-⑥ |
| 21 | 多个连接 ⇒ 分行带连接名称 | T001-⑫ + T005-③ + T015-⑥ |
| 22 | 期权名称 Call/Put · 购/沽 | T013-⑨ + T015-④ |
| 23 | 到期日早于交易所今天 ⇒ 已到期标 | T001-⑬ + T005-④ + T015-⑤ |
| 24 | 到期日 = 或晚于今天 ⇒ 不标 | T001-⑬ |
| 25 | 点期权行 ⇒ 汇总 + 批次 + 本合约订单 | T007-① + T019-① |
| 26 | 同一订单多次成交合为一批次 | T002-① |
| 27 | 减仓按 FIFO 扣减 | T002-②⑩ + T019-② |
| 28 | 扣减为 0 不展示 | T002-③ + T019-③ |
| 29 | 批次合计 = 持仓 ⇒ 显示批次 | T002-④ + T007-② |
| 30 | 批次合计 ≠ 持仓 ⇒ 无法还原 | T002-⑤ + T007-② + T019-④ |
| 31 | 组合单腿批次指向同一订单 | T002-⑥ + T018-⑤ |
| 32 | 开仓成交缺订单号 ⇒ 单独批次不可点 | T002-⑦ + T019-⑤ |
| 33 | 点批次 ⇒ 订单详情 | T019-⑥ |
| 34 | 点正股行 ⇒ 订单列表 | T007-③ + T017-① |
| 35 | 推算 ⇒ 按最后更新时间过滤；回落 ⇒ 全部 | T007-③④ |
| 36 | 已撤单 / 失败照常列出 | T007-⑤ + T017-② |
| 37 | 点订单 ⇒ 订单详情 | T019-⑦ + T018-③ |
| 38 | 无成交 ⇒ 成交字段「—」 | T008-② + T018-④ |
| 39 | 他人 / 未归类 / 非锚 ⇒ 同不存在 | T007-⑦⑨ + T008-⑤⑦ + T022-② |
| 40 | 持仓被移除 ⇒ 持仓已不存在（优先于旧数据） | T007-⑧ + T017-④⑤ |
| 41 | 有补齐记录 ⇒ 状态 + 时刻 | T009-①③ + T020-① |
| 42 | 无补齐记录 ⇒ 未触发 | T009-② + T020-② |
| 43 | 已显示数据时重读失败 ⇒ 保留 + 刷新失败提示 | T013-⑤ + T016-③ + T017-⑥ + T018-⑪ |
| 44 | 日历无法判定上一交易日 ⇒ 不标陈旧 + 告警 | T003-⑥ + T006-⑦ |
| 45 | 订单不存在 ⇒ 订单不存在 | T008-⑦ + T018-⑥⑫ |
| 46 | 详情页无已显示数据时加载失败 ⇒ 失败 + 重试 | T017-③ + T018-⑦ |
| 47 | 冷启动券商历史请求失败 ⇒ 只隐藏该行 | T020-③ |

## Functional Requirements 覆盖预检

| FR | 落点 |
|---|---|
| FR-001 只展示锚标的、读时判定、详情同样限锚集 | T001-② + T005-②⑥ + T007-⑨ + T008-⑦ + T021 |
| FR-002 账号隔离、他人同不存在 | T005-⑤ + T007-⑦ + T008-⑤ + T009-④ + T022-② |
| FR-003 行形态、不跨连接合并 | T001-⑫ + T005-③ |
| FR-004 分组、组头、折叠保留口径 | T001-④⑤ + T013-⑦ + T015-①②③ |
| FR-005 组头正股现价取值 | T001-⑥⑦⑧ + T005-⑨ |
| FR-006 全序排序 | T001-⑨⑩⑪ |
| FR-007 行字段、平均成本口径、不显示今日盈亏 | T005-⑦ + T013-⑨⑩ + T015-④ |
| FR-008 本系统数据、同步时刻、重读不触发同步 | T006-⑧ + T010 + T016-①② + T017-⑦⑩ + T018-⑩ + T023-③④ |
| FR-009 陈旧判定（已过宽限时点、日历不可判定不猜） | T003 + T006-⑤⑥⑦ + T014-⑤ |
| FR-010 四种非列表状态、失败保留数据 | T006-①②③ + T013-①②③④ + T014-①②③④⑤ |
| FR-011 未归类只计数提示 | T001-①③ + T005-② + T014-⑥ |
| FR-012 连接标签可见性与内容 | T005-③⑧ + T013-⑧ + T015-⑥ |
| FR-013 期权持仓详情内容（剩余 / 原始数量） | T002-⑪⑫ + T007-①⑫ + T019-①② |
| FR-014 批次还原规则 | T002-①②③⑥⑦⑧⑨⑩ + T019-②③⑤ |
| FR-015 批次无法还原回落 | T002-④⑤ + T007-② + T019-④ |
| FR-016 订单列表口径、正股不做批次 | T007-③④⑤⑥⑩⑪ + T017-①② |
| FR-017 订单详情字段、交易所当地时间、「—」 | T004 + T008 + T013-⑪ + T017-⑨ + T018 |
| FR-018 冷启动页券商历史状态 | T009 + T020 |
| FR-019 无任何交易操作入口 | T018-⑧ |
| FR-020 持仓已不存在 / 订单不存在 / 详情加载失败 | T007-⑧⑨ + T008-⑤⑦ + T017-③④⑤ + T018-⑥⑦⑫ |
| FR-021 已到期标、按交易所日期 | T001-⑬ + T005-④ + T015-⑤ |
| FR-022 主列表金额万缩写 | T012 + T015-⑦ + T023-① |
| FR-023 重读失败保留数据 | T013-⑤ + T016-③ + T017-⑥ + T018-⑪ |

## Success Criteria 覆盖预检（🚨 SC 是系统性盲区，单列一张）

| SC | 落点 | 形态 |
|---|---|---|
| SC-001 与富途 App 逐行一致（分时段、分字段） | T025-① | 上线后人工比对 |
| SC-002 分组 / 组头 / 排序与规则期望一致 | T001（固定数据集臂 ④⑤⑥⑦⑧⑨⑩⑪）+ T015-①② | 自动断言 |
| SC-003 批次合计一致 + 构造样本扣减一致 | T002 + T025-② | 自动断言 + 上线后核对 |
| SC-004 到任一订单详情 ≤ 2 次点击 | T019-⑥⑦ + T018-③ | e2e 路径断言（三条路径各恰 2 次点击） |
| SC-005 列表可见 ≤ 2 秒 | T023-⑤ + T025-④ | 真机计时 |
| SC-006 他人看到 / 打开 0 条 | T005-⑤ + T007-⑦ + T008-⑤ + T009-④ | 自动断言 |
| SC-007 同步失败不清空、陈旧提示 100%、重读失败不替换 | T003 + T006-③⑤⑥ + T014-⑤ + T016-③ + T017-⑥ + T018-⑪ | 自动断言 |
| SC-008 订单详情逐字段一致 | T025-③ | 上线后人工比对 |
| SC-009 冷启动页状态与记录一致 | T009 + T020 | 自动断言 |
| SC-010 入库文件与 PR 私有数据 0 | T024（私有清单扫描 + `check-identifier-boundary`）+ Guardrail 13 / 17 | 自动扫描 |

## Edge Case 覆盖预检

| EC（spec Edge Cases 行序） | 落点 |
|---|---|
| 到期日与行权价格式 | T013-⑩ + T015-④ |
| 时间按北京而非交易所当地会差一天 | T001-⑬ + T004-⑤ |
| 批次盈亏之和与券商合约级盈亏可能不同 | **蓄意零覆盖**：规则差异是预期行为、不作错误提示，无可断言的「对」值；批次盈亏本身由 T002-⑪ 覆盖 |
| 被指派得到的正股持仓含系统订单 | T007-⑥ |
| 期权到期后到对账移除之前仍在（跨周末） | T001-⑬ + T005-④ + T015-⑤ |
| 清仓后重新开仓只计新周期 | T002-⑧ |
| 删除锚 ⇒ 立即从列表消失 | T005-⑥ |
| 同组内美股港股混排不会发生 | **蓄意零覆盖**：列表接口按市场查询，结构上不可达 |
| 组市值为 0 | T001-⑪ |
| 陈旧判定跨非交易日 | T003-③ |
| 其他账号登录 ⇒ 暂无交易账户 | T005-① + T014-① |
| 昨天对账没有成功、今天仍在宽限内 ⇒ 陈旧 | T003-④ + T006-⑥ |
| 同一券商有两个连接 ⇒ 靠连接名称区分 | T005-③⑧ + T015-⑥ |
| 已显示列表时下拉重读失败 ⇒ 保留并提示 | T016-③ |

## Acceptance Scenario 覆盖预检（🚨 标准矩阵**够不到**这一层）

| AS | 落点 |
|---|---|
| US1-AS1 3 行组头组值与排序 | T001-⑤⑥⑨ + T015-① |
| US1-AS2 单行平铺参与跨组排序 | T001-④⑩ + T015-② |
| US1-AS3 港股空头认沽名称与负数 | T013-⑨ + T015-④ |
| US1-AS4 平均成本口径 | T005-⑦ |
| US1-AS5 非锚与未归类不在列表、提示条数 | T005-② + T014-⑥ |
| US1-AS6 同步失败保留数据、满足条件时提示陈旧 | T006-③⑤ + T014-⑤ |
| US1-AS7 折叠展开与返回恢复 | T015-③ |
| US1-AS8 下拉 / 回前台重读且不触发同步 | T016-①② + T023-③④ |
| US1-AS9 周六已到期标且计入组值 | T001-⑤⑬ + T015-⑤ |
| US1-AS10 下拉重读失败保留列表并提示 | T013-⑤ + T016-③ |
| US2-AS1 两张开仓订单两个批次、分次成交合并 | T002-① + T019-① |
| US2-AS2 买回从最早批次扣减、扣为 0 不显示 | T002-②③ + T019-②③ |
| US2-AS3 指派 / 到期作废同样 FIFO | T002-⑩ |
| US2-AS4 批次无法还原 | T002-⑤ + T007-② + T019-④ |
| US2-AS5 点批次看订单详情字段 | T019-⑥ + T018-③ |
| US2-AS6 组合单腿进入同一订单详情 | T002-⑥ + T018-⑤ |
| US2-AS7 本合约订单含平仓与系统单 | T007-①⑤⑥ + T019-①⑦ |
| US3-AS1 推算 ⇒ 按最后更新时间过滤、倒序 | T007-③⑪ + T017-① |
| US3-AS2 回落 ⇒ 全部订单 | T007-④ |
| US3-AS3 已撤单 / 失败照常列出 | T007-⑤ + T017-② |
| US3-AS4 未成交撤单显示「—」 | T008-② + T018-④ |
| US4-AS1 券商历史成功 + 时刻 | T009-① + T020-① |
| US4-AS2 无记录显示未触发 | T009-② + T020-② |

蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：

- **SC-001 / SC-008 与 SC-003 真实账户面**：依赖真实账户与富途 App，只能上线后人工比对（T025），自动化只覆盖机制。
- **SC-005**：耗时依赖真机与网络，只能真机计时（T023 / T025）。
- **Edge「批次盈亏之和与券商不同」与「同组美港混排」**：见 Edge Case 表内说明。

## Implementation Strategy

MVP = **T001–T009 → T010 → T012 → T013 → T014 → T015 → T016**（T010 重生成要求 4 个端点齐备，故 T007–T009 在 MVP 路径上）：到这里 US1（按正股分组看锚标的持仓，含陈旧与重读失败处理）端到端成立，可独立演示。US2 / US3 下钻 = T002 → T007 → T008 → T017 → T018 → T019；US4 = T009 → T020。T011 / T021 / T022 可并行。T023 真机、T024 门、T025 上线后验收。

Clear 检查点批次：`T001-T004` / `T005-T006` / `T007-T009` / `T010-T012` / `T013-T014` / `T015-T016` / `T017-T019` / `T018-T020` / `T021-T022` / `T023-T024` / `T025`（每批次后停顿提醒 `/clear`，per Constitution §III）。
