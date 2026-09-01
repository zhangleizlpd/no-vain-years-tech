---
adr_id: ADR-0070
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - **`daily_bar` 与 `anchor.last_close` 出现第一次真实分歧且被用户或探针发现** → 本 ADR 的取舍 2（两个独立来源、不做对账）被证伪，重审是补对账还是回退单一来源
  - **接入第三个市场（cn 或其它）** → 该市场若无实时源，`unsupported-market` 那条路会让它的 `last_close` 永久停在建锚时的种子值；届时必须决定是给它接源、还是为它单独保留一条 EOD 投影
  - **`closeSettleBufferMinutes` 的 `us = 15` 被实测推翻**（真取一轮 ET 16:01/16:05/16:15/16:30 的 `last_price` 对照官方收盘价）→ 按实测改数，并把旁证补进 `market-session.rules.ts`
  - **同日窗被证明太窄** —— 出现「窗内全失败、跨午夜后再没机会补」的真实案例且代价不可接受 → 重审是放宽窗口（需先解决「D+1 盘中价写成 D 收盘价」那个静默错），还是给锚补一条显式的「这一场没采到」状态列
---

# ADR-0070：锚收盘价换同源写手 —— 收盘后直查 vendor，去掉 daily_bar 每小时投影

## Context

锚表的 `last_close` / `last_close_date` 自 045 起是 `marketdata.daily_bar` 的**单向投影**，
由 `sync-anchor-quote.scheduler` 每小时 `:30` 跑一轮。两个问题：

**① 到货时刻。** 港股链路是
`HK 16:00 收盘 → eod_bar 22:00（理杏仁）→ daily_bar → 每小时 :30 投影 → 22:30 锚表`
⇒ **收盘后 6.5 小时，雷达上的锚价还是 T−1 的**（`intraday-spot.rules.ts` 闭市回落 `last_close`）。
而 16:00–22:30 正是境内用户会去看雷达的时段。

**② 跨源不对称。**

| 市场 | 期权数据源 | 锚价数据源（`daily_bar`） | 同源 |
| ---- | ---------- | ------------------------- | ---- |
| us   | futu       | `us_equity_bar` → futu    | ✅   |
| hk   | futu       | `eod_bar` → 理杏仁        | ❌   |

后果不只是洁癖：腿表算 moneyness 用快照行里的 `underlying_spot`（futu），雷达算距 W% 用
`last_close`（理杏仁）。两个数有差异时两处对不齐，**且没有任何地方会报**。

**投影本身没坏** —— 2026-09-01 prod 实测：hk 锚 27/28 的 `last_close_date` 落在最近交易日
（剩 1 条 `hk:06117` 大概率停牌）。坏的是**到货时刻与源**，不是准确性。

## Decision

### 1. 新建 `sync-anchor-last-close.ts`，收盘后按各市场直查与期权同源的 vendor

走 `REALTIME_QUOTE_PORT`（061 建的端口，富途，us + hk）。骨架复用
`sync-anchor-intraday.ts`：按 market 分组、逐组判闸、切批外呼、逐锚独立写。
删除 `sync-anchor-quote.{ts,scheduler.ts}` 及其两个 spec。

**不动 `eod_bar` 22:00，不动 `daily_bar`。** 只换锚表这两列的写手。

### 2. 三闸取交集，缺任一条都会静默写错数

① **目标 session 可判定** —— `TradingCalendarPort.lastClosedSession`，`null` ⇒ 不猜、跳过。
② **收盘后补采窗** —— `session-clock.isWithinPostCloseWindow`：已过该市场的
**收盘时刻 + 定稿缓冲**，∧ `now` 仍落在该场的**交易所当地日历日**内。
③ **工作集非空** —— `last_close_date < 目标 session`。

**闸② 的后半条（同日窗）是本 ADR 最容易被当成洁癖删掉的一条。** 它挡的是：D 那场采失败的锚，
到 D+1 **盘中**重试时 `lastClosedSession` 仍返 D（D+1 尚未收盘）⇒ 拿到 **D+1 的盘中实时价**
写进「D 的收盘价」那一列，而日期列还是对的 ⇒ **没有任何断言会红**。
判据与理由单点在 `session-clock.ts`，单测有定向变异钉住。

### 3. 重试 = 闸③ 本身，不另建机制

工作集判据天然幂等：写成即退出工作集 ⇒ 该场后续每一拍 **0 次外呼**；没写成就还在里面 ⇒
下一拍（10 分钟后）自动重试，直到跨交易所当地午夜出窗。
⇒ 无 failstreak、无退避、无重试计数表，**也不接熔断**（061 那套是为 30 秒一拍的高频路径建的；
本片一天真外呼数次，攒不出统计意义）。数据面的监控已在进程外：`ops/jobs/app-state-health.sql`。

### 4. 定稿缓冲取 `market-session.rules.ts` 的既有单点，并给 `us` 补一个有证据的值

`closeSettleBufferMinutes` 原有 `hk: 10`（HKEX CAS 16:08–16:10 随机收市），`us` 走默认 `1`，
而那张表自己写着「美股收盘竞价的官方价何时进到本供应方的快照里，**没实测过**」。

本 ADR 给 `us` 补 **15**，依据同为交易所公开规格：**Nasdaq NOCP 在收盘后 15 分钟才由
network processor 正式下发**为官方 Consolidated Last Sale Price；NYSE 侧 16:00 单笔撮合带
sale condition 8「Closing Prints」即时上带。⇒ 16:15 那一步改的是「官方性」不是价，故 15 分钟
是带余量的。

⚠️ **残留缺口显式记下**：这测的是「交易所何时下发」，不是「富途快照何时反映」。`hk` 那条另有
fixture 旁证（标的行 `update_time` = 16:07:49），**`us` 没有**。

🚨 **这条改动的影响面超出本 feature**：`closeSettleBufferMinutes` 另有一个生产消费方
`snapshot-session-attribution.rules.ts`（期权快照归属写闸）。us 从 1 → 15 意味着 **ET 16:00–16:15
之间触发的建锚冷启动从「照写」变成 `skip: session_underway`**（终态不重试）。这与 `hk` 已经在
承担的取舍同构 —— 缓冲存在的理由正是「收盘价此刻可能还没定稿」，而 us 的 1 是继承来的占位值。

## Consequences

### 显式接受的取舍（**不是遗漏，别当 bug 查**）

1. **丢掉 `last_close` 的「权威修订值」语义。** 原 schema 注释：它是「当日收盘的权威值（**含
   拆股/分红调整与错单撤销后的修订值**）」。收盘后几分钟打 vendor 拿到的是那一刻的原始收盘价，
   拿不到盘后发布的修订值，也没有 `writeDailyBarRows` 的「尾窗可订正」。
2. **`daily_bar` 与 `anchor.last_close` 从此是两个独立来源，可能对不上，且不做对账。**
   判据：close price 大概率不会错，错了用户能第一时间发现。已同步落进 `schema.prisma` 的列注释
   —— 下一个人看到雷达价与 `daily_bar` 差几分钱时，第一眼就该看到这句话。
3. **丢掉「每小时自愈」的无限期性。** 原投影零外部 IO + 幂等 + 挂一轮下一轮追上，可以一直追。
   现在补采只在同日窗内重试，跨午夜即放弃那一场 —— 换来的是不会把下一场的盘中价写成上一场的
   收盘价（见 Decision 2）。

### 白拿的

**0 值哨兵**：富途用带内 `0` 表达停牌/无成交，归一已在 `futu-realtime-quote.adapter.ts` 的
`tradedPriceOrNull` 按 ADR-0067 做掉 ⇒ 那种行根本不会到达本写手，走「缺报价保留旧值」那条路。
**成本为零，且 MUST NOT 在写手里再判一次**（第二份判据，且永不执行）。

### 时效收益

| 市场 | 收盘 → 进锚表（前）         | 收盘 → 进锚表（后）                                   |
| ---- | --------------------------- | ----------------------------------------------------- |
| hk   | 6.5 小时（22:30 HKT）       | **10–20 分钟**（16:10 起）                            |
| us   | 约 2 小时（ET 17:30/18:30） | 15–25 分钟（16:15 起）—— 落在北京凌晨，**对用户无感** |

⇒ 本 ADR 的真实收益**几乎全在 hk**。us 一并切换是为了消除「两个市场两条写路径」这个会漂的
形态，不是为了它自己的时效。

## Alternatives considered

- **B：收盘后跑一拍 061 写 `intraday_price/at`，`last_close` 与投影都不动。** 改动更小、保住
  权威修订语义，但不消除跨源不对称 —— 雷达的距 W% 仍以理杏仁的数为操作数。
- **C：把 `eod_bar` 提前到港股收盘后。** 依赖「理杏仁 16:30 有没有当日港股收盘价」这个未知
  （`daily_bar` 无写入时间戳列，查不到历史证据，只能起探针），且会动整条港股日线链，影响面
  远大于锚价。
- **D：us 保持 `daily_bar` 投影，只切 hk。** us 确实没有本 ADR 要修的两个病根（已同源、且
  `us_equity_bar` 采在 ET 17:00/18:00 远在竞价之后）。否决理由是它要求两个写手各带一张市场
  白名单，而**一旦漂成重叠，每小时 `:30` 那轮会把新写手刚写的富途收盘价盖回理杏仁的，且盖写
  不报错**。用一张共享路由表可以堵住，但那是为一个没有收益的现状差异付结构性利息。

## References

- Issue #323（病根、prod 现状基线、被否备选 B/C）
- [ADR-0062](0062-optionsdesk-bounded-context.md) —— optionsdesk ↔ marketdata 的端口边
- [ADR-0066](0066-time-semantics-ubiquitous-language.md) —— event time / ingestion time 两条轴：
  `last_close_date` 写目标 session（event），**不是** vendor 的 `capturedAt`（ingestion）
- [ADR-0067](0067-vendor-absence-semantics.md) —— 带内 0 哨兵在 adapter 边界归一
- Nasdaq《The Nasdaq Opening and Closing Crosses》FAQ；NYSE Closing Auction 公开说明
