---
adr_id: ADR-0066
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - **接入第四个市场**（非 cn/hk/us）→ 若其交易日跨日历日滚动（CME 式 17:00 CT 换日）或有常态夜盘，本 ADR「event time = 交易所当地日历日 + 常规收盘时刻」这个双元组不再够用，须重审 session 模型
  - **需要严格 PIT 回测**（无 look-ahead bias 的历史重放）→ 「可修订尾窗」不留旧值，届时须升级为完整 vintage 轴（唯一键加一段），本 ADR §5 的取舍作废
  - **同一 `market` 下出现收盘时刻不同的两个交易所**（已知将撞到：NYSE 半日市股票 13:00 ET、期权 13:15 ET）→ 「一个 market 一个收盘时刻」不成立，须引入 ISO 10383 MIC 粒度，本 ADR §3 的 market 键重审
  - **`sessionWatermark` 的消费方开始要求「必须是交易日」**（而非「过没过收盘时刻」）→ 纯时钟层与日历层的分工失效，重审 §2 的两层结构
  - 出现**第二个**「时间语义」落点（新的时区表 / 收盘时刻表 / 日期求值函数散在 `session-clock.ts` 之外）→ 说明机器强制没兜住，重审 §8 的门禁形态
---

# ADR-0066: 时间语义统一语言 —— 四条时间轴 + session 词表 + 逐维度 asOf 口径

- Status: Accepted (2026-08-19)
- Deciders: @zhangleizlpd
- Tags: server / marketdata / time-semantics / data-integrity / ubiquitous-language
- Relates: [ADR-0043](0043-server-flat-module-paradigm.md)（纯函数 rules 落点）/ [ADR-0049](0049-marketdata-scheduler-bullmq-hybrid.md)（tick 与 misfire 语义）/ [ADR-0053](0053-cross-context-pure-rules-import.md)（跨 ctx 纯函数 import）/ [ADR-0062](0062-optionsdesk-bounded-context.md)（读侧陈旧度基准的消费方）；操作面 = [cross-timezone-date-semantics.md](../conventions/cross-timezone-date-semantics.md)

## Context

本仓是**多市场**系统（cn / hk / us）。市场时区、用户所在地时区、宿主时区、各 vendor 的时间戳口径两两可能不同，一个绝对时刻在不同层里要变成**不同的「日期」**。

到 2026-08 为止，「这批数据算哪一天」这一个问题，仓内有**五种写法**：`marketDateFor` / `shanghaiToday` / `lastClosedSessionCutoff`+日历 / `resolvePreviousTradingDay` / `shanghaiDateOnly`。更糟的是它们分布出了一条断层：

- **读侧**（optionsdesk 全家、陈旧度折龄）已统一到「最近一场**已收盘交易日**」——查日历；
- **写侧**（采集落库）统一在「市场当地的**今天**」——纯时钟，不查日历、**不问这一场收了没有**。

两套口径从未对过账。采集侧的正确性**寄存在 `cron_expr` 里，代码从未断言过**（`manual-sync-session-guard.ts` 文件头自己承认过这件事）。

### 触发事件

`#103`（2026-08-19 prod 实证）：北京 00:13 建一只美股锚 = ET 12:13 **盘中**，冷启动去拉一根尚未收盘的日 K，落库得到**半根**（实测 volume 仅正常日 23%–56%）。而 `daily_bar` 的写路径是 `createMany(skipDuplicates)` ⇒ 错行按唯一键占位、**永久驻留**，当晚真收盘那轮被静默挡掉。屏上标着「收盘」的价与官方收盘价最大差 `+1.88%`。

三层监控（`sync_run` 的 `scanned/ok/failed` · 表级数据年龄探针 · 日报 run 成败）在整个过程中**全绿**。

### 三条 prod 取证（决定了本 ADR 的取舍，不是背景色）

1. **「写到非交易日」从未发生** —— `daily_bar`（2026-05 起）与 `option_daily_snapshot`（全表）零行落在非交易日。⇒ 不需要为「造日期」设防。
2. **半根 K 只发生过一次** —— cn/hk 在 5 次真正落在盘中/午休的触发下逐日成交量剖面平滑。原因是**理杏仁盘中对「今天」返空数组，而富途返一根「进行中」的 K 线**。⇒ **cn/hk 的安全不是代码给的，是 vendor 给的**；exposure 是 vendor 形状的，换一个 vendor 就复活。
3. **misfire 补触发 77 天零发生** —— `eod_bar` 漏了 3 夜，无一被补跑捡起。⇒ 它是**代码路径风险**而非正在流血的伤口；修的理由是「下一个 vendor / 下一个入口撞上时不会再静默」。

### 这类偏差的共同形状

**它们永不报错。** 基准差一天不会让任何断言变红 —— 只会让落库的 K 线少半天成交量、让 `DTE ≤ 14` 这类带判据的边界腿静默进出带、让「同步停了」被判成「数据是新的」。⇒ 光靠 review 与自觉抓不住，必须落成**词表 + 类型 + 门禁**。

## Decision

### 1. 四条时间轴，正交，不可互推

| 轴                  | 问的问题                       | 业内名                                                                          | 载体                                                    |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **event time**      | 这条数据描述的是**哪一场交易** | event time（Flink/Beam）· `TradeDate`(FIX 75) · `ClearingBusinessDate`(FIX 715) | `session_date` / `trade_date` / `as_of`（`@db.Date`）   |
| **ingestion time**  | 我们**什么时候拿到**它         | ingestion time · received timestamp                                             | `quote_as_of` / `intraday_at`（`timestamptz`）          |
| **processing time** | **跑批的墙钟**                 | processing time                                                                 | `sync_run.started_at` / `sync_dimension.last_watermark` |
| **vintage**         | 这个值是**第几版**             | point-in-time · vantage date · knowledge date                                   | 见 §5                                                   |

🚨 **`sessionWatermark`（event-time 水位）与 `sync_dimension.last_watermark`（processing-time 水位）名字撞了，是两条轴**。业内 watermark 的原义是前者（"Watermark(t) declares that event time has reached t"）；后者是「上一轮跑到几点」。文档与注释里必须区分。

🚨 **一行数据上并存多个时点是正常的，MUST NOT 为「对齐」而合并**。现役样本：`option_daily_snapshot` 的 `session_date`（归属交易日）/ `quote_as_of`（采集时刻）/ `oi_as_of`（**OI 的 vintage** —— OCC 收盘后隔夜清算、次日开盘才发布 ⇒ T 日收盘后采到的 OI 实为 T−1）三列各自独立。把 OI 归到 `session_date` 是拿标签掩盖真实 vintage。

### 2. 纯时钟层与日历层分开，且**纯时钟层不碰日历**

「最近一场已收盘交易日」拆成两步：

1. **纯时钟**（`sessionWatermark`）：交易所当地时间过没过**常规收盘时刻** ⇒ 今天 / 昨天。不查任何表。
2. **日历**（`TradingCalendarPort.lastClosedSession`）：拿上界去 `trading_day` 取 `≤ 上界` 的最大交易日，叠加 062 的覆盖声明三态。

🚨 **为什么必须分开**：`trading_day` 那张表**停摆过**（044）。让它参与「这一场收没收」的判断，等于把「日历坏了」升级成「连补采都做不了」。分层后日历不可用时**回落到纯时钟层**，最坏只是多发一次注定返空的请求。

🚨 **纯时钟层的失败方向只会保守**：真收盘早于登记值（半日市）⇒ 水位回退一天 ⇒ **少采一场，绝不写半根**；反向（说收了其实没收）不存在，因为没有任何市场的实际收盘晚于登记值。这条性质是「先上纯时钟层、日历层可后置」的**全部依据**。

### 3. 词表（canonical 命名，单点落 `apps/server/src/marketdata/session-clock.ts`）

| 函数                                       | 语义                                           | 🚫 禁用形态                     |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------- |
| `exchangeCalendarDate(market, now)`        | 交易所当地的**日历日**                         | 禁当采集业务日用（#103 的病灶） |
| `exchangeCalendarDateForScope(scope, now)` | scope 的**共同**日历日；跨时区**抛**           | —                               |
| `sessionWatermark(market, now)`            | **event-time 水位**：已收盘 session 的日期上界 | 禁当「是不是交易日」用          |
| `sessionWatermarkForScope(scope, now)`     | scope 内**最早**的水位（最严）；跨时区**不抛** | —                               |
| `isSessionComplete(market, session, now)`  | 「此刻能不能以收盘口径往这一天落库」           | 同上，只答「过没过收盘时刻」    |
| `userToday(now)`                           | **用户所在地**的今天                           | 🚫 禁当业务日期用               |

📌 **两个 scope 版的极性刻意相反**：日历日口径要求「有单一今天」才成立，故跨时区**抛**；水位问的是「哪一场收了」，多市场取 min **恒有意义**，故不抛。

🚫 **`shanghaiToday` 已删除**：调度时区归 cron，业务日期归上表，人工节奏归 `userToday` —— 那个名字同时承担三种语义，是五种写法里最坏的一个。

### 4. 「今天」的归属只有三个合法答案

| 用途                                         | 跟谁的今天                                                 |
| -------------------------------------------- | ---------------------------------------------------------- |
| 采集业务日期 / session 归属 / 幂等键         | **交易所**                                                 |
| 前瞻派生量（剩余期限、到期距离、折年化分母） | **交易所**                                                 |
| 人工节奏（复审到期、待办逾期、提醒排期）     | **用户所在地**                                             |
| 审计 / 日志 / 重放 / 排序                    | **UTC 绝对时刻**（不取日期）                               |
| ❌ 任何业务判断                              | ~~UTC 日期~~ —— 它既不是上海也不是纽约，是凭空的第三个口径 |

**采集 `asOf` 的口径逐维度显式声明**，值域 `calendar-day` | `last-completed-session`。

🚨 **声明落在代码（`Record<DimensionKey, AsOfBasis>`）而不是 `sync_dimension` 的一列**，两条理由：

1. **新增维度不声明口径 = 编译不过**。DB 列做不到这一点，只能靠运行时门禁，而新维度上线那一刻正是门禁最可能被绕过的时刻。
2. 「asOf 跟谁走」是**正确性判据不是运维旋钮** —— 它不该能在不改代码的情况下被改掉。

⚠️ **入口宽松、采集本体严格**：`universe` / `profile` 的 `market_scope` **合法地**是 `{cn,hk,us}`，这类覆盖式 meta 维度**本就没有**单一的「交易所今天」⇒ 求值入口对跨时区 scope 回落宿主日；而混 scope 的**采集**维度在采集本体那一侧照样抛。谁承担后果谁把关。

### 5. session 的**时刻**是数据，不是常量

业内（`exchange_calendars` 等）逐 session 存 `open` / `close` / `break_start` / `break_end`（UTC）。本仓当前把它拆成两处**常量**（`REGULAR_CLOSE_MINUTES` + `MARKET_SESSION` 的 segments），因此**半日市不可表达**（NYSE 感恩节次日 / 平安夜 13:00 ET，期权 13:15；HKEX 平安夜 12:00 HKT）。

**决策**：session 时刻归**交易日历表**（数据），代码常量降级为**兜底默认**。落地分期，且判定必须是**三态**（`whole` / `half` / **`unknown`**）——富途日历源已下发 `trade_date_type`，而腾讯（cn/hk 主源，指数反推法）与静态层给不出该值，二值化会让列语义随 `servedBy` 漂。三态语义直接复用 062 的日历三态。

### 6. 值的订正走「可修订尾窗」，原值语义不被覆盖

业内 PIT 的答案**不是「改成 upsert」**（会丢原值、引入 look-ahead bias），而是给一条 vintage 轴。本仓取**折中**：最近 N 行走 upsert、更老的 insert-only —— 仓内 `us_index_daily.writeUsIndexRows`（046 T013）已是这个形态。

⚠️ **代价显式记账**：订正的是「值」不是「版本」，旧值不留档 ⇒ **做不了严格 PIT 回测**。真需要时再上完整 vintage 列（破坏性变更，走 expand-migrate-contract）——见 sunset_trigger 第 2 条。

### 7. day count 两套并存且不可混

| 用途              | 口径                                                                | 落点                                   |
| ----------------- | ------------------------------------------------------------------- | -------------------------------------- |
| 剩余期限 / 折年化 | **ACT/365F** —— 整数日历日含周末节假日，到期日 = 0，🚫 禁绝对时刻差 | `daysToExpiry` + `DAYS_PER_YEAR = 365` |
| IV 分位窗         | **BUS/252** —— 好交易日计数                                         | `underlying-iv.rules.ts`               |

ISDA 2021 Definitions §4.6.1 明文两者不可混：同一个假日在 252 制里是 `0/252`、在 365 制里仍是 `1/365`。

🚨 **允许并要求一处口径错配，🚫 不要「修」它**：同屏价格来自**上一场 session**，而 DTE 从**当前**交易所日期起算。决策是前瞻的（「我今天挂这张单还要扛多少天」），改成按快照日起算会**系统性多算一天**。代价是同屏必须有显式 `asOf`。

### 8. 机器强制

散文约定救不了「不报错」的偏差。本 ADR 的强制面：

- **类型**：`Record<DimensionKey, AsOfBasis>` 的穷尽性（新维度不声明即编译失败）；`daysToExpiry` 的签名拒绝带时间的绝对时刻。
- **门禁**：`scripts/checks/check-time-semantics.ts` —— 拦「在 `session-clock.ts` 之外新长出时区表 / 收盘时刻表」与「绕过词表裸做日期转换」。
- **既有**：`check-trading-day-read.ts`（062，跨 ctx 读日历必须用三态判据 + 覆盖终点禁派生）与本门禁**正交**，不合并。

## Consequences

- **PR #107（Phase 1）实装** §1 的轴命名、§2 的两层、§3 的词表、§4 的逐维度口径；四个入口（tick / 冷启动 / 两条 CLI）共用同一个 `asOf` 求值单点，#103 的根因随之关闭。
- **准点行为逐点不变**：06:00 / 22:00 常规轮上两种口径同值，差异只在盘中触发 / 手敲 CLI / misfire 补触发这些**非准点时刻**显形。
- **两条 CLI 的 `asOf` 从单一全局值改为逐维度**：一条 `--cascade` 命令里各维 `marketScope` 不同，一个值在结构上就不可能都对。`--as-of` 显式传入仍压倒一切。
- `shanghaiToday` / `marketDateFor` / `lastClosedSessionCutoff` / `isSessionClosed` 转为 `@deprecated` 转发壳，下个 release 删除。
- **§5 / §6 分期落地**：本 ADR 记录决策，实装分别在后续 Phase。在那之前半日市与 vendor 订正是**已知且已记账**的缺口，不是遗漏。
- 操作面（「写代码时查哪一张表」）由 [cross-timezone-date-semantics.md](../conventions/cross-timezone-date-semantics.md) 承载，随本 ADR 改写。

## Trade-offs

| 选项                                                | 不选的理由                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **让采集 `asOf` 直接走日历**（`lastClosedSession`） | 会把采集的正确性绑死在一张**停摆过**的表上（044）。分两层后日历坏掉最坏是多发一次空请求                                     |
| **把 asOf 口径落 `sync_dimension` 一列**            | 新增维度漏声明只能靠运行时门禁发现；代码侧 `Record` 穷尽性在编译期就拦住。且口径不该是运维旋钮                              |
| **`daily_bar` 直接改逐行 upsert**                   | 丢原值、引入 look-ahead bias，与 PIT 口径相悖；且 vendor 订正与「我们写错了」两件事会被混成一件                             |
| **现在就引入 ISO 10383 MIC**                        | 收益只在半日市的股票/期权收盘差（13:00 vs 13:15）；§5 的 per-session 时刻已能表达大部分，不值得先做全仓 `market` 列改造     |
| **入口对跨时区 scope 一律抛**（更「严格」）         | 实测会让 `--cascade universe` 在一天里大半时间整条死掉 —— `universe` 的 `{cn,hk,us}` 是合法配置。严格该落在承担后果的那一侧 |

**本方案的已知短板**：

1. **半日市当前不可表达**（§5 未落地）—— 偏差方向安全（少采一场），但半日市当天建锚会误判 `intraday_skipped`。
2. **vendor 时间戳被丢弃** —— 业内标准是 exchange timestamp 与 received timestamp 两个都存；我们只存自采墙钟，导致 vendor 滞后漂移**事后无法复算**。
3. **`sessionWatermark` 可能返回一个非交易日**（周六 ET 18:00 → 周六）。这是刻意的：它是纯时钟层，交易日归日历层。

## Open Questions

- hk 半日市的日历源：主源腾讯是「指数当日有 bar ⟺ 开市」的**反推法**，结构上给不出半日标记。是接富途 HK 日历，还是先只支持已知半日市静态表？
- `sync_run` 的「实际写入行数」统计：加在 recorder 层还是各 executor 自报？前者口径统一但拿不到 `createMany` 的真实 affected count。
- 未来若接入有夜盘 / 跨日滚动交易日的市场（CME 式），`exchangeCalendarDate` 的「当地日历日」假设会失效 —— 届时 event time 需要一个真正的 session 标识而非日期。

## References

- [Apache Flink — Timely Stream Processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/)（event / processing / ingestion time + watermark 的定义源）
- [exchange_calendars](https://pypi.org/project/exchange_calendars/)（session / trading minute / 逐 session open·close·break 的业内模型）
- [XTDB — Bitemporality](https://v1-docs.xtdb.com/concepts/bitemporality/)（valid time / transaction time）
- [S&P Global — Point-In-Time vs. Lagged Fundamentals](https://www.spglobal.com/content/dam/spglobal/mi/en/documents/general/sp-capitaliq-quantamental-point-in-time-vs-lagged-fundamentals.pdf) · [LSEG — Point in Time Fundamentals](https://www.lseg.com/en/data-analytics/financial-data/company-data/fundamentals-data/point-in-time-fundamentals)（原值永不覆盖）· [Scientific Financial Systems](https://scifinsys.com/point-in-time-data-sets/)（vantage date）
- [OCC — Open Interest](https://www.theocc.com/market-data/market-data-reports/volume-and-open-interest/open-interest)（隔夜清算、次日开盘发布 ⇒ `oi_as_of` 的依据）
- [Clarus — Implementing BUS/252](https://www.clarusft.com/implementing-bus252-daycount-convention/) · [FpML day count fraction scheme](https://www.fpml.org/coding-scheme/day-count-fraction-2-3.xml)
- [FIX Dictionary — ClearingBusinessDate (Tag 715)](https://www.onixs.biz/fix-dictionary/4.4/tagnum_715.html) · [ISO 20022 — MIC (ISO 10383)](https://www.iso20022.org/market-identifier-codes)
- [NYSE Group — 2025/2026/2027 Holiday and Early Closings Calendar](https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx)（半日市判据）
- [Data Intellect — Measuring Stale Data in Trading Systems](https://dataintellect.com/blog/stale-data-measuring-what-isnt-there/)（两个时间戳都存）
