---
feature_id: 073-hk-option-two-round-collection
spec_ref: ./spec.md
status: draft
created_at: '2026-09-01'
updated_at: '2026-09-01'
adr_refs: ['0043', '0047', '0049', '0066', '0070']
context7_verified: []
---

# Implementation Plan: 港股期权采集拆两轮 —— 报价轮前移到收盘直后, OI 轮独立排在定稿之后

## Summary _(mandatory)_

把港股期权的**一轮打包采集**拆成两轮，各自排在自己那件事的最优时刻：**主轮 16:20**（链发现 + 全链快照 + 标的 IV，同一拍）抓盘口尚未撤走的报价；**轮2 21:40**（新维度）在 OI 定稿之后回填未平仓量。改动面**全在 `marketdata` 一个 ctx 内**：三行 `sync_dimension` 的触发时刻 + 一个新维度 + 一条新采集路径 + 退役两条港股补救轮 + 告警从两级阶梯收敛成一级。**零新表、零新 endpoint、零跨 ctx 新增、零 mobile 代码**。

两条判据是这次拆分的骨架，都不是设计出来的而是被现有结构夹出来的：① **链发现与快照 MUST 同一拍** —— ADR-0049 §3 的依赖边只约束同一 tick 内共同触发的维度，错开即失效（`20260827_1957` 刚把这个坑填上，本片不许推回去）；② **轮2 MUST 排在 OI 定稿判据为真之后** —— 早于它写入会让已定稿的 OI 被标成前一交易日，采对了标错了。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

零新三方依赖。轮2 复用既有 `OPTION_SNAPSHOT_READ_PORT` 与 `SyncOptionSnapshotUseCase` 的行映射。

## Constitution Check _(mandatory gate)_

- [x] **Passed** —— 单 feature 单分支单 PR（§V；纯 server + 测试面，mobile 零代码、契约零变化）；TDD 红绿闭环，新测试须定向变异证明能红（§II）；扁平 / 贫血 / 护城河零违背（§IV：新增的 use case 与 rules 平铺于 `marketdata/` 根、直注 `PrismaService`、零 class 建模、零跨 ctx import）；mockup-first 免（§I：无 UI 面，`web_compat: na`）。无需 Complexity Tracking。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 既有 marketdata IT（Testcontainers 真 boot）承载。轮2 的两段写（定向 UPDATE / 补漏行）与定稿判据假分支在 IT 穷举；`state_branches` 14 条逐条落测（D8）。
- [x] **Mobile / Web**: 无代码改动、契约零变化 ⇒ **不新增契约冒烟**（本片对外无接口面；spec `web_compat: na`）。
- [x] **Evidence**: impl 期 IT commit + 探针补样本结论回写 spec `## Assumptions`（体例同 071 T001）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

零新三方依赖。vendor 面复用 `OPTION_SNAPSHOT_READ_PORT`（已 market 参数化，`hk_option_daily_snapshot` 现役走的就是它）。**Evidence**: N/A。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] 本 feature mono-native（073 spec / #308 均 mono 原生），无迁移面。**Evidence**: N/A。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question / sunset trigger affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0049 | §3「依赖边只约束同一 tick 内共同触发的维度」 | **binding constraint** | 本片 D1 直接建立在它上面；D2 据它裁决**不为轮2 连依赖边**（跨 tick 的边是空话） |
| ADR-0047 | 逐合约覆盖率（FR-045）/ 两级补救（FR-046） | **partially superseded** | 港股半边的两级补救本片退役、改一级制（D5）；美股半边逐字不动。ADR 消费注记随本 PR 回写 |
| ADR-0066 | OQ「hk 半日市的日历源给不出半日标记」 | accepted-as-is | 本片够不到：归属走 `sessionWatermark`，半日市当天 16:20 仍判当日（spec Edge Case 已列） |
| ADR-0070 | 锚收盘价同源写手（2026-09-01 落地 / #325） | **consumed** | 它把 spec「落库顺序反转」原先最担心的后果消掉了；其首拍 16:10 早于本片主轮 16:20，时序相容（D7） |
| ADR-0043 | 扁平 + 贫血 + 零-class | accepted-as-is | 新增文件按该范式平铺，无违背 |

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

1. **每条新测试 MUST 先红**，且红的原因 MUST 是本片要修的那件事 —— 定向变异留档（rebase 后重做）。
2. **MUST NOT 为了让测试绿而放宽判据**。轮2 的定稿判据假分支尤其：它的正确行为是**不写**，不是「写个近似值」。
3. **MUST NOT 用 mock 顶替 Testcontainers 验落库语义**。定向 UPDATE 只改三列、其余列逐值不变 —— 这条只有真库能证。
4. 美股零变化（FR-018）MUST 由**既有美股测试全绿**承担，而不是新写一条「美股没变」的断言。

### General Architecture Notes

**D1 · 主轮三维度同拍前移到 16:20（data-only migration）**

一条 migration 同时做两件事，缺一不可：

- `UPDATE sync_dimension SET cron_expr = '0 20 16 * * *'` for `hk_option_contract` / `hk_option_daily_snapshot`（`hk_underlying_iv_daily` 见 D6 的条件）
- **同 migration** `SET next_fire_at = NULL` —— 先例 `20260827_2112_reset_next_fire_at_after_cron_retime`，它的注释里记着 `20260827_1957` 漏掉这一半导致「改动静默滞后一个周期、目的当晚落空」。

执行顺序**不加边、不改 priority**：三者 `priority` 同为 5，同优先级下按字典序，而 `hk_option_contract` < `hk_option_daily_snapshot` < `hk_underlying_iv_daily`（`o` < `u`）天然成序。守卫落在 `dimension-executor.spec.ts` 既有的相邻性断言旁。

**D2 · 轮2 = 新维度 `hk_option_oi_settle`，且刻意不连依赖边**

新增一行 `sync_dimension`：`cron_expr = '0 40 21 * * *'` · `market_scope = {hk}` · `vendor = futu` · `queue_lane = futu` · `priority = 5` · `retry_max = 3` · `history_depth = NULL` · `enabled = true`。

🚫 **MUST NOT 给它连 `hk_option_daily_snapshot → hk_option_oi_settle` 的依赖边**：两者在**不同 tick**（16:20 vs 21:40），而 ADR-0049 §3 的边只在同一 tick 内装配 —— 连了是一条**永远装不上的空话**，正是 `20260827_1957` 花一整条 migration 修掉的形态。轮2 对主轮的依赖靠**数据**表达（主轮没写行 ⇒ 轮2 走补漏分支），不靠调度图。此裁决 MUST 写进 migration 注释。

代码侧两处登记：`dimension-executor.ts` 的 `DIMENSION_KEYS`（`:175-176` 邻位）与 `sync-asof.rules.ts` 的 `AS_OF_BASIS_BY_DIMENSION`（`:63`，取 `'last-completed-session'`，与 `hk_option_daily_snapshot:97` 同档）。⚠️ `dimension-executor.spec.ts:133` 是一条 **`DIMENSION_KEYS` 值层全集断言** —— 加键当场红，那就是本片 TDD 的第一个红。

**D3 · 轮2 的写入 = 两段，且 MUST 共用主轮的行映射**

- **段 a（定向 UPDATE）**：对已存在的 `(contract_id, session_date, source='eod')` 行，只写 `open_interest` / `net_open_interest` / `oi_as_of` 三列。
- **段 b（补漏）**：对不存在的合约，走 `createMany(skipDuplicates)` 补整行（`sync-option-snapshot.usecase.ts:476` 同款）。

🚨 **MUST NOT 在轮2 另抄一份 vendor 行 → DB 行的映射** —— 与 `ensure-latest-eod-bar.usecase.ts` 头部那条「MUST NOT 在这里另抄一份映射, 那正是两份必漂的形状」同一条纪律。段 b 复用 `SyncOptionSnapshotUseCase` 已有的行构造。

🚨 **MUST 调 `oiRefreshedAtEod`（`market-session.rules.ts:200`）**，返 `false` 即**跳过 OI 写入**并计 `skipped` + 结构化留痕。🚫 MUST NOT 让轮2「靠自己的 cron 时刻推定已定稿」—— `option-snapshot-remediation.ts` 的 #187 注释记着他们正是从那个形态重构走的（「正确性靠 cron 时刻成立, 不是靠判据」）。

🚫 **MUST NOT 为轮2 新开 `source` 取值**（`market-session.rules.ts:160` 明文：OI 归属与 `source` 正交）。段 b 落 `SNAPSHOT_SOURCE_EOD`，从而幂等键天然挡住对段 a 已处理行的重写。

**D4 · 港股两级补救退役（只退港股半边）**

删 `option-snapshot-remediation.ts` 的两个 `@Cron` 方法：`:225`（hk ① 级 23:40）与 `:231`（hk ② 级 08:30）。

🚫 **MUST NOT 删 `retrySameDay` / `backfillPremarket` 本身，也 MUST NOT 删 `:213` / `:219` 两条美股 cron** —— 美股仍在用，且美股 ② 级买的是 OI 正确性（该类头部注释明写「hk ② 级存在的理由与 us **不同**, 别照抄论证」）。退役的是**港股的两个触发点**，不是机制。

**D5 · 告警一级制**

轮2 跑完后跑一次 `OptionSnapshotCoverageCheck`（`:152` 的 `optionCoverageThreshold` 不动、`:205` 的计数口径不动），不达标 → **直接 ERROR**。删掉「① 级只 WARN 挂着等 ②」那条阶梯在港股路径上的表达（`:326` 注释所描述的分支）。

📌 **本片不解决「ERROR 没有接收端」**（#209 仍开着）。改动让语义更诚实，但没人被叫醒这件事在另一条线上 —— 实现时 MUST 在代码注释里写明这一点，否则下一个人会以为「报了 ERROR 就有人管」。

**D6 · `hk_underlying_iv_daily` 前移是条件项（FR-017）**

它走 futu `get_option_underlying_overview`（与期权同源），自足、不依赖 `daily_bar`。但 `underlying-iv.rules.ts:320` 自陈该字段**盘中分钟级更新** ⇒ 前移的前提是「16:2x 那个读数已定型」。

探针已于 2026-09-01 起跑（网格 `15:30 … 22:47`，28 个港股锚），当晚出结果：

- **定型** ⇒ 并入 D1 的同一条 migration，三维度一起走 16:20。
- **未定型** ⇒ 该行 `cron_expr` 保持 `'0 0 23 * * *'`，并把结论写进 spec `## Assumptions`；此时港股在 23:00 只剩它一个维度。

⚠️ 前移会让 FR-034 双算对表的 WARN 基线平移（阈值是照 23:00 读数标定的）—— 不是错，是基线变了，MUST 在 impl 期观察一轮再决定要不要重标。

**D7 · 与 ADR-0070（#325）的时序相容性**

锚收盘价写手每 10 分钟一拍，补采窗 = 已过收盘定稿缓冲 ∧ 未跨交易所当地午夜 ⇒ 港股**首拍 16:10**，早于本片主轮。稳态下「写成即出工作集」，16:20 那拍零外呼、不与主轮抢限频桶。仅当 16:10 那拍失败时才会在 16:20 同分钟各发一次（前者是一次批量报价调用，量级可忽略）。

✅ 已核：#325 只把 `CLOSE_SETTLE_BUFFER_MINUTES` 的 `us` 补到 15（`market-session.rules.ts:393`），**`hk` 仍为 10**（`:383`）⇒ 本片 `[16:10, 16:30]` 的窗口不受影响。

**D8 · FR-022 抓价时刻可观测 + 越界告警**

`quote_as_of` 已是「本批采集时刻」（`sync-option-snapshot.usecase.ts` 头部三时点表）。轮次结束后取本轮 `max(quote_as_of)` 折算交易所当地分钟，越过**台阶上界常量**即告警。

该常量是**样本期结论**（不是物理常数）⇒ MUST 与 `MARKET_OI_SETTLE_LOCAL_MINUTE` 同款处理：单点定义、注释写明样本期与重标条件。告警面 MUST 与采集成败分开 —— 「采集成功而抓价时刻越界」是本条要抓的唯一形态。

**D9 · FR-016 的注释更正落在新 migration，不改旧 migration**

`20260827_1957` 的注释里「港股**零补救**」这一前提在 08-28（#265）就已失效。但 **🚫 MUST NOT 去改那条 migration** —— 已应用的 migration 改注释会炸 Prisma checksum（成例见 `market-session.rules.ts:166` 对 `20260825_1910` 的同款处理：「刻意不动; 从那句话 grep 过来的人落在这里」）。

⇒ 更正写在**本片新增的 migration 注释**里，形式为「沿革留痕：`20260827_1957` 的『港股零补救』前提已于 08-28 失效；结论（不改回 hard）仍成立，理由改为……」。`sync_dependency` 的 `mode` 一个字不动。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

1. **段 a 的 UPDATE MUST 限定 `source = 'eod'`** —— 不限定会连 `premarket_backfill` 行一起改（美股那侧仍在产这种行）。
2. **段 a 与段 b MUST 在同一轮内、对不相交的合约集**执行 —— 先查已存在集合，再据此分流；不许「先全量 createMany 再全量 UPDATE」（后者对已有行是 no-op、对新行是双写，看起来也对，但把两段的语义搅在一起，日后改一段必踩另一段）。
3. **轮2 MUST NOT 重跑链发现** —— 工作集取自 `option_contract` 表（主轮当天已填）。重跑一遍是 453 秒的纯浪费，且会在 21:40 制造一个新的限频尖峰。
4. **`enabled` 新维度上线即 `true`** —— 但 migration MUST 可回滚（反向 UPDATE 置 `false` + 恢复三行旧 `cron_expr` + 再置 `next_fire_at = NULL`）。
5. **禁在本片调任何管道判据** —— 召回 / 精排 / 行军的参数面本片只读。发现要调参 ⇒ 停下报 user。

### 决策备选与既有事实核录

**备选否决**：① 给轮2 连依赖边 —— 否（跨 tick 的边装不上，是空话，D2）；② 轮2 新开 `source='oi_settle'` —— 否（`market-session.rules.ts:160` 明文禁止，且会让唯一键不再碰撞从而平行写整条链，正是 #306 修掉的 555× 放大形态）；③ 主轮改成 16:12 争取更多余量 —— 否（close-write 闸 16:10 解除，只剩 2 分钟，CAS 随机收市延后即踩闸）；④ 链发现与快照拆开不同拍 —— 否（依赖边失效，推翻 `20260827_1957`）；⑤ 顺手把 `MARKET_OI_SETTLE_LOCAL_MINUTE.hk` 收紧到 20:00 —— 否（收益为零 + 三处耦合 + n=1，已挂 #324）；⑥ 把港股那条 soft 边改回 hard —— 否（漏采不可回补，migration 有明文绊线）；⑦ 保留 hk ① 级 23:40 作第三次尝试 —— 否（clarify 期裁决，接受重试深度 2）；⑧ 改 `20260827_1957` 的过期注释 —— 否（炸 Prisma checksum，改走新 migration 留痕，D9）。

**既有事实核录**（2026-09-01 plan 期逐项 grep / prod SQL 核，🚫 未照抄任何二手行号）：

- 维度注册：`dimension-executor.ts:175-176` `'hk_option_daily_snapshot'` / `'hk_underlying_iv_daily'`；`:180` `DimensionKey = (typeof DIMENSION_KEYS)[number]`；`:1046` / `:1051` 两个 `factExecutor` 接线点
- asOf 口径：`sync-asof.rules.ts:63` `AS_OF_BASIS_BY_DIMENSION`；`:96` hk_option_contract `'calendar-day'`；`:97` / `:98` 另两行 `'last-completed-session'`
- 快照写入：`sync-option-snapshot.usecase.ts:72` `SNAPSHOT_ROW_CHUNK = 500`；`:75` `SNAPSHOT_SOURCE_EOD = 'eod'`；`:78` `..._PREMARKET_BACKFILL`；`:476` `createMany({ data: chunk, skipDuplicates: true })`
- OI 定稿：`market-session.rules.ts:176` `MARKET_OI_SETTLE_LOCAL_MINUTE`（`hk = 21*60+30`）；`:200` `oiRefreshedAtEod`；`:160` 「🚫 MUST NOT 拿它去改 `source`」
- 收盘缓冲：`market-session.rules.ts:381` `CLOSE_SETTLE_BUFFER_MINUTES`；`:383` `hk: 10`；`:393` `us: 15`（#325 新增）；`:397` `closeSettleBufferMinutes`；`:477` `isCloseWriteBlocked`
- 补救四 cron：`option-snapshot-remediation.ts:213`（us ① 08:00）/ `:219`（us ② 18:00）/ `:225`（**hk ① 23:40，退役**）/ `:231`（**hk ② 08:30，退役**）；`:326` 「🚫 这里**不**升 ERROR: 还有 ② 级兜底」
- 覆盖率：`option-snapshot-coverage.check.ts:152` `optionCoverageThreshold`；`:205` `if (collected.has(row.contractId)) acc.covered++`（**数的是行存在，不看报价**）；`:222` `degraded` 判定
- 标的 IV：`underlying-iv.port.ts:17` `UNDERLYING_IV_PORT`；`futu-shim/app.py:512` `ctx.get_option_underlying_overview(codes)`（批上限 500）；`underlying-iv.rules.ts:320` 「该字段**盘中分钟级更新**」
- 守卫断言：`dimension-executor.spec.ts:133-138` `DIMENSION_KEYS` **值层全集**断言（加键必红）
- prod `sync_dimension` 现状（2026-09-01 SQL 核）：三行港股期权维度 `cron_expr` 均 `'0 0 23 * * *'`、`queue_lane = futu`、`retry_max = 3`；`hk_underlying_iv_daily.history_depth = 1095`，另两行为 `NULL`
- prod 依赖边现状：`universe → hk_option_contract`（soft）· `hk_option_contract → hk_option_daily_snapshot`（**soft**，`20260827_1957` 从 hard 降下来的）· `hk_underlying_iv_daily` 只有 `universe` 一条上游边
- 主轮实测耗时（prod `sync_run`，2026-08-31 / 28 个锚）：链发现 **453 s**（23:00:00→23:07:33）· 快照 **38 s** · 标的 IV **28 s** ⇒ 合计 **519 s**；同期 `scanned=28 / ok=22 / skipped=6`（6 个无期权链）、`written=18289`
- 补救轮实测（prod，近 14 天）：港股期权采集 **零次硬失败**（`failed=0` 贯穿）；hk ① 级仅触发 1 次且 `written=0`；hk ② 级仅触发 1 次 `written=1110`（那次是 #306 修复前的放大形态）
- 锚集现状（prod）：hk **28** / us **109**，hk 锚 `last_close_date` 27 条 @2026-08-31、1 条 @2026-08-28
- migration 不可改的成例：`market-session.rules.ts:166` 对 `20260825_1910` 的处理（「改它的注释会炸 Prisma checksum ⇒ 刻意不动」）

## Complexity Tracking

无违规，无需 justify。
