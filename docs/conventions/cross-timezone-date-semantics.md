# 跨时区日期语义（四条时间轴）

> 本仓是**多市场**系统（cn / hk / us）：市场时区、用户所在地时区、宿主时区、vendor 各自的时间戳口径**两两可能不同**，且不保证任意两者相等。
> 一个绝对时刻在不同轴上要变成**不同的「日期」**，把任意两轴混用都会塌，只是塌的形态不同。
> 本文是「哪一轴该用谁的日期、该调哪个函数」的单一来源。**写任何涉及日期的代码前先对号入座，不要重新发明。**
>
> 决策与业内依据见 **[ADR-0066](../adr/0066-time-semantics-ubiquitous-language.md)**；本文是它的**操作面**。

## 0. 三十秒速查

| 你要问的                                          | 调这个（`marketdata/session-clock.ts`）                                |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| 交易所当地今天几号                                | `exchangeCalendarDate(market, now)`                                    |
| 一个 `marketScope` 的共同今天                     | `exchangeCalendarDateForScope(scope, now)`（跨时区**抛**）             |
| 最近一场**已收盘**的是哪天（不查日历）            | `sessionWatermark(market, now)`                                        |
| 同上，多市场取最严                                | `sessionWatermarkForScope(scope, now)`（跨时区**不抛**，取 min）       |
| 现在能不能往这一天写收盘口径的行                  | `isSessionComplete(market, session, now)`                              |
| 最近一个已收盘**交易日**（查日历 + 062 覆盖声明） | `TradingCalendarPort.lastClosedSession(market, now)`                   |
| 今天**是不是**交易日（三态）                      | `TradingCalendarPort.classify(market, date)`                           |
| 用户复审 / 待办的「今天」                         | `userToday(now)`                                                       |
| 某维度这一轮该采哪一天                            | `resolveAsOfForDimension(dim, now)`（`marketdata/sync-asof.rules.ts`） |
| 此刻**能不能成交**（预警用）                      | `isWithinTradingSession`（`marketdata/market-session.rules.ts`）       |
| 这一场**进行中吗**（含午休；补数闸用）            | `isSessionUnderway`（同上）—— 与上一行只差午休那一段，别混             |

🚫 **禁止「宿主日当业务日」** —— 一个 `shanghaiToday()` 式的函数会同时承担调度、业务日期、人工节奏三种语义，而这三者在多市场系统里本就不相等。要哪一种就调上表里对应的那一个。

## 1. 四条时间轴（正交，不可互推）

| 轴                  | 管什么                         | 口径                                 | canonical 实装                                                      | 缺了它的失败形态                                                             |
| ------------------- | ------------------------------ | ------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **event time**      | 这条数据描述的是**哪一场交易** | **交易所**时区 + 该市场**收盘时刻**  | `session-clock.ts`                                                  | 日期错位一天；**每周固定丢掉周五**；落一根**半根 K**（#103）；幂等键随之失效 |
| **ingestion time**  | 我们**什么时候拿到**它         | 绝对时刻（`timestamptz`）            | `quote_as_of` / `intraday_at`                                       | 分不清「数据旧」与「采集停了」                                               |
| **processing time** | **什么时候跑**                 | **全局统一一个显式时区**，与市场无关 | cron 一律 `Asia/Shanghai`；`computeNext`                            | cron 时点漂 / DST 下触发时刻乱跳                                             |
| **vintage**         | 这个值是**第几版**             | 原值不被覆盖，订正走可修订尾窗       | 见 [ADR-0066](../adr/0066-time-semantics-ubiquitous-language.md) §6 | vendor 订正进不来，错值永久驻留且不自愈                                      |

⚠️ **四轴正交**：调度选对了时点**不代表** event time 算对了（run 绿而数据日期错）；event time 对了**不代表** vendor 的时间戳串切对了。

🚨 **`sessionWatermark` 与 `sync_dimension.last_watermark` 名字撞了，是两条轴**：前者是 **event-time 水位**（「哪一场已经收了」，业内 watermark 的原义），后者是 **processing-time 水位**（「上一轮跑到几点」，除权命中检查的窗口起点）。

🚨 **一行数据上并存多个时点是正常的，MUST NOT 为「对齐」而合并**。样本：`option_daily_snapshot` 的 `session_date`（归属交易日）/ `quote_as_of`（采集时刻）/ `oi_as_of`（OI 的 vintage —— OCC 隔夜清算、次日开盘才发布 ⇒ T 日收盘后采到的 OI 实为 **T−1**）。

## 2. 六条铁律

1. **存绝对时刻，日期是派生量**。DB 存 UTC instant（Prisma `DateTime`），**不存**「某地的日期字符串」当事实。需要按日期查询/幂等时，另立一个**显式的业务日期列**并写明它是谁的日期 —— 而不是让读侧各自转换。
2. **交易日 ≠ 时区转换后的日历日**。交易日是**业务日历**概念，必须查 `TradingCalendarPort`。时区转换在有夜盘/跨日 session 的市场上直接错；在无夜盘的美股上「恰好相等」，但周末会算出一个**不存在的交易日**。**「恰好相等」不是「可以推导」。**
3. **「已收盘」≠「今天」**。日历日不含「这一场收没收」。收盘口径的数据（日线 / EOD 快照 / IV）必须走 `sessionWatermark` 那一族 —— 拿日历日去采，盘中触发就落半根（#103）。
4. **写「今天」前先问「谁的今天」** —— 见 §3 归属表。三个合法答案之外没有第四个。
5. **vendor 时间戳逐端点确认 offset**，不许按同一 vendor 的另一个端点类推。⚠️ **也别假设 vendor 对「今天」的供给策略相同**：2026-08-19 prod 取证 —— 富途 `request_history_kline` 盘中会返一根**进行中**的日 K，理杏仁返**空数组**。#103 那个错只在 us 显形，就是这条差异造成的。⇒ **接新 vendor 时把「盘中问今天返什么」当作必验项**，别指望代码层兜住。
6. **派生量的日期基准必须在 spec / doc 里显式声明**。基准不写死，实现者必然各自发挥，且这类偏差**不会报错** —— 它只是让数字悄悄差一天。

### 2.1 纯时钟层与日历层分开

「最近一场已收盘交易日」是**两步**：

1. **纯时钟**（`sessionWatermark`）—— 过没过常规收盘时刻。**不查任何表。**
2. **日历**（`lastClosedSession`）—— 拿上界去 `trading_day` 取 `≤ 上界` 的最大交易日 + 062 覆盖声明三态。

🚨 **纯时钟层刻意不碰日历**：`trading_day` 停摆过（044），让它参与「这一场收没收」等于把「日历坏了」升级成「连补采都做不了」。日历不可用时**回落纯时钟层**。

**半日市**（NYSE 感恩节次日 / 平安夜 13:00 ET、期权 13:15；HKEX 平安夜 12:00 HKT）：交易日历若给出该 session 的实际收盘时刻，**以日历为准**；给不出（或该源本就不下发）时回落常规收盘常量。

⚠️ 回落的偏差方向**恒安全**：真收了而常量说没收 ⇒ 水位回退一天 ⇒ **少采一场，绝不写半根**；反向（说收了其实没收）不存在，因为没有任何市场的实际收盘晚于常规收盘。**这条不变量是「可以先只有纯时钟层」的全部依据**，改常量表时别把它破坏掉。

## 3. 「今天」的归属：按用途查表

| 用途                                         | 跟谁的「今天」               | 判据                                                                       |
| -------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| 采集业务日期 / session 归属 / 幂等键         | **交易所**                   | 数据描述的是哪一场交易                                                     |
| 前瞻派生量（剩余期限、到期距离、折年化分母） | **交易所**                   | 回答「还要扛多少天风险」，是市场时间不是本地时间                           |
| 人工节奏（复核到期、待办逾期、提醒排期）     | **用户所在地**               | 你什么时候坐下来做这件事，与市场无关                                       |
| 审计 / 日志 / 重放 / 排序                    | **UTC 绝对时刻**（不取日期） | 只需全序，不需要「日期」这个概念                                           |
| ❌ **任何业务判断**                          | ~~UTC 日期~~                 | **UTC 日期不是任何人的今天** —— 它既不是上海也不是纽约，是凭空的第三个口径 |

🚨 **端点不吃日期时，归属只能跟「哪一场收了」走，MUST NOT 跟日历日走**。很多行情端点（富途 `get_option_snapshot` / `overview` 等）**没有日期参数**，永远只回答「现在」⇒ 一批数据归哪个 session，完全由**采集时刻相对该市场 session 的位置**决定：

| 采集时刻                 | 端点此刻返的是                        | 能不能落 | 归属                 |
| ------------------------ | ------------------------------------- | -------- | -------------------- |
| 该场**进行中**           | **盘中态**，不是任何 session 的收盘价 | 🚫 拒绝  | —                    |
| 该场已收盘（当日盘后）   | 该场的收盘态                          | ✅       | 该场                 |
| 已跨进下一个交易日的盘前 | **上一个已收盘 session** 的收盘态     | ✅       | 上一个已收盘 session |

**日历日 00:00 就翻页，与「这一场收没收盘」毫无关系。** 只要队列积压 / 重试把执行时刻推过午夜，用日历日当归属就整批标错一天 —— 而落库多是 `skipDuplicates` 幂等键，标错**不可逆、不报错，还会静默挡掉次日的真实采集**。2026-08-25 prod 实撞 2200 行（[#181](https://github.com/zhangleizlpd/no-vain-years-tech/issues/181)）。

📌 **也别指望「把 cron 挪到安全时刻」** —— 那是拿「上游链跑得完」当假设，而链长会随数据量增长。正确性必须与执行时刻**解耦**：队列再堵只应导致「晚」，MUST NOT 导致「错」。

🚨 **最容易混过 review 的形态**：一个 `toUtcDateOnly(d)` 式的工具函数**身兼两职** —— 用它**归一化已有的 DB Date 列**是对的（`@db.Date` 读出来本就是 UTC 午夜）；用它从 `new Date()` **求「今天」**是错的（那是 UTC 今天）。同名同签名、一半正确一半错误 ⇒ 通读式 review 抓不住。**两种用途必须拆成两个名字不同的函数。**

### 3.1 采集维度的 `asOf` 口径**逐维度声明**

值域两个，落 `sync-asof.rules.ts` 的 `Record<DimensionKey, AsOfBasis>`：

| 值                       | 含义                                   | 谁用                                                               |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------ |
| `calendar-day`           | 交易所当地日历日                       | 覆盖式快照 / 行日期来自 vendor payload 的维度                      |
| `last-completed-session` | 最近一场已收盘 session（多市场取最严） | 价格 / 快照族（一个未收盘的 session 混进来会产生**不可逆**的坏行） |

🚨 **新增维度不声明口径 = 编译不过**（`Record` 的穷尽性）。这比 DB 一列更硬，且「asOf 跟谁走」是**正确性判据不是运维旋钮**。

🚨 **但「声明了」不等于「实现兑现了」** —— 穷尽性只保证那张表有一行，**保证不了采集本体真的按它取值**。#181 的实际形状就是这个：`option_daily_snapshot` 早已声明 `last-completed-session`，而采集本体里写的是 `exchangeCalendarDateForScope(dim.marketScope, input.now)`，同一个文件的注释还老老实实写着「本格当前不改变它的行为」。**声明与实现分叉了三个月，没有任何东西会红。** ⇒ 改采集本体的归属推导时，MUST 回到这张表核对一次；新增维度时，声明与实现 MUST 同一个 commit 落地。

## 4. 剩余期限 / 折年化口径

| 项         | 口径                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单位       | **整数日历日**，含周末与节假日（业内名 **ACT/365F** 那一族的分子）                                                                                                                              |
| 到期日当天 | **= 0**                                                                                                                                                                                         |
| 年化分母   | 日历日 → 除 **365**（`DAYS_PER_YEAR`）；交易日 → 除 **252**（`BUS/252`，IV 分位窗用）。**两套不能混** —— ISDA 2021 Definitions §4.6.1；同一个假日在 252 制里是 `0/252`、在 365 制里仍是 `1/365` |
| 起点       | 交易所的「今天」（§3 第 2 行）                                                                                                                                                                  |
| ❌ 禁用    | **绝对时刻差**。会得到小数，让 `≤ N 天` 这类**带判据在一天内边界抖动**；且到期「日」本身不是时刻，要用绝对差就得凭空约定一个到期时刻                                                            |

⚠️ **允许一处口径错配，但必须显式**：以收盘快照供数时，价格来自上一场 session，而剩余期限从**当前**交易所日期起算 —— 两者不同基准。这是**有意为之**（决策是前瞻的），不是 bug；但必须在 spec 写明，否则实现者会「修」成快照日基准，从而系统性多算一天。同屏必须有显式 `asOf`，让人看得见价格的时点。

## 5. 「陈旧」判据

判「数据陈不陈旧」时，比较对象是**最近一个已收盘的交易日**（`lastClosedSession`），不是任何一方的「今天」。

拿本地日期比市场 session 日期，会在**用户时区领先于市场**时把「最新可得的数据」恒判为陈旧（市场当天尚未收盘，本地日历已翻页）—— 该档位随之失去信息量，永远为真的告警等于没有告警。

**两套粒度并存，别混**：

|                    | 基准                   | 阈值                                             | 只认谁的时钟                                                                                                                                       |
| ------------------ | ---------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **日级**（收盘档） | 最近一场已收盘交易日   | `asOf >= lastClosedSession` → CURRENT / STALE    | 交易日历                                                                                                                                           |
| **秒级**（实时档） | 我们**自己的采集时刻** | `INTRADAY_FRESHNESS_SECONDS`（派生量，单点声明） | 🚫 **不认 vendor 时间戳** —— 那是「最后成交时刻」（061 实测滞后中位 40s / p95 292s / 最大 672s），按它判会在正常交易时段内把活跃标的稳定误判成陈旧 |

## 6. 新增代码自检（7 问）

1. 这个日期属于四条轴里的哪一条？
2. 这个「今天」跟谁走 —— 交易所 / 用户所在地 / UTC 绝对时刻？§3 查得到吗？
3. 我是在**推导**交易日，还是在**查**交易日历？
4. 我问的是「今天几号」还是「**哪一场收了**」？收盘口径的数据用错会落半根。
5. vendor 这个端点的 offset 我**确认过**，还是从别的端点类推的？它盘中对「今天」返什么，我**验过**吗？
6. 如果基准差一天，**会有任何东西报错吗**？（答案通常是「不会」⇒ 必须写测试钉住基准）
7. **这段代码晚跑 3 小时会怎样？跨过午夜呢？** 归属推导若吃「执行时刻的日历日」，答案就是「整批标错一天且不可逆」。判据必须与执行时刻解耦 —— 队列积压、重试、手动补跑都会把它推离 cron 写的那个时刻（[#181](https://github.com/zhangleizlpd/no-vain-years-tech/issues/181)）。

## 7. 业界依据

- 三时间语义（event / processing / ingestion）与 watermark：[Apache Flink — Timely Stream Processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/)
- session / trading minute / 逐 session open·close·break：[exchange_calendars](https://pypi.org/project/exchange_calendars/)
- 双时间轴（valid time / transaction time）：[XTDB — Bitemporality](https://v1-docs.xtdb.com/concepts/bitemporality/)
- point-in-time / vantage date，**原值永不覆盖**：[S&P Global](https://www.spglobal.com/content/dam/spglobal/mi/en/documents/general/sp-capitaliq-quantamental-point-in-time-vs-lagged-fundamentals.pdf) · [LSEG](https://www.lseg.com/en/data-analytics/financial-data/company-data/fundamentals-data/point-in-time-fundamentals)
- 期权 OI 隔夜清算、次日开盘发布（`oi_as_of` 的依据）：[OCC — Open Interest](https://www.theocc.com/market-data/market-data-reports/volume-and-open-interest/open-interest)
- day count `ACT/365F` vs `BUS/252` 不可混：[Clarus](https://www.clarusft.com/implementing-bus252-daycount-convention/) · [FpML coding scheme](https://www.fpml.org/coding-scheme/day-count-fraction-2-3.xml)
- 交易日 ≠ 日历日（17:00 CT 滚动、周日晚记作周一）：[CME Group Trading Hours](https://www.cmegroup.com/trading-hours.html)
- 业务日期按 exchange time zone 打戳：[FIX `ClearingBusinessDate`](https://www.onixs.biz/fix-dictionary/4.4/tagnum_715.html) · [ISO 10383 MIC](https://www.iso20022.org/market-identifier-codes)
- 存 UTC、边缘转换、禁依赖 server / DB 本地时区：[Why UTC for your entire Trading Platform](https://www.timestored.com/data/utc-finance-infra) · [Kimball · Multiple Time Zones](https://www.kimballgroup.com/data-warehouse-business-intelligence-resources/kimball-techniques/dimensional-modeling-techniques/multiple-time-zones/)
- staleness 存两个时间戳、阈值随 session 分档：[Data Intellect](https://dataintellect.com/blog/stale-data-measuring-what-isnt-there/)
- 「按当前时刻取最近一条历史」的正式名字是 **as-of join**：[kdb+ `aj`](https://code.kx.com/q/ref/aj/) · [pandas `merge_asof`](https://pandas.pydata.org/docs/reference/api/pandas.merge_asof.html)
