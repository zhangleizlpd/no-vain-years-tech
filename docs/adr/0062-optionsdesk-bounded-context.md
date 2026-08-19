---
adr_id: ADR-0062
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 盘中实时 spot 上线（雷达/详情不再以 `last_close` + asOf 为唯一价源）→ 跨 ctx 读形态从「最终一致 Q7-B 只读直查」升格为强一致同步读，本 ADR §3 跨 ctx 面与 ADR-0048 sunset_trigger #2 一并重审
    ✅ **FIRED 2026-08-18（061）· mitigated** —— §3 追加第 5 条**强一致同步读**边（DI `marketdata` 的 port token）；Consequences 里「雷达价的时效 = 最长延迟一天」那条取舍**已作废并改写**（详见 §复审记录 2026-08-18）
  - **把历史价格序列的读搬进 optionsdesk 端点**（server 端拼序列 ⇒ 须读时复权 ⇒ import `marketdata/*.rules.ts`）→ 触发 ADR-0053 sunset_trigger #2，重审是否升共享 package。⚠️ 「详情要画趋势」这个**需求**已由 046 兑现，但走的是**客户端合成两端点**（optionsdesk 只回锚派生边界、序列由客户端直调 marketdata bars 端点）⇒ 本 trigger 的判据是**读搬到哪一侧**，不是「有没有序列需求」（详见 §复审记录 2026-08-03）
  - 出现第二个消费锚表的 ctx（除 marketdata 采集闸外）→ 锚表从「自有事实 + 一条反向 Q7-B」升级为多消费者读模型，重审是否需投影 / 共享读服务（Q7-A）
  - 期权台从「锚 + 雷达」扩到**下单 / 持仓联动 / 许愿单自动触发**（P3）→ 与 portfolio 的边界（谁持有仓位事实）重审；本 ADR 的「叶子 ctx、零跨 ctx 写」假设届时失效
  - 锚的估值口径从人工录入转为模型批量产出且需自建估值管线 → 重审是否拆 `valuation` 子 ctx（本 ADR 把「模型 import」按外部输入处理，不建管线）
---

# ADR-0062: Optionsdesk 第 10 Bounded Context — 期权台锚管理 + 击球区雷达 + 跨 ctx 双向仅 Q7-B 只读

- Status: Accepted (2026-08-01)
- Deciders: @zhangleizlpd
- Tags: server / bounded-context / optionsdesk / marketdata / cross-context
- Relates: [ADR-0032](0032-backend-bounded-context.md)（bounded context 拆分框架）/ [ADR-0043](0043-server-flat-module-paradigm.md)（扁平贫血范式）/ [ADR-0048](0048-marketdata-portfolio-cross-layer-dependency.md)（Q7-B 直查先例 + 本 ADR 复审对象）/ [ADR-0052](0052-alert-bounded-context.md)（第 6 ctx，叶子 + Q7-B ×2 的同款形态）/ [ADR-0053](0053-cross-context-pure-rules-import.md)（跨 ctx 纯函数 import 细分边 + 本 ADR 复审对象）/ [ADR-0047](0047-marketdata-pluggable-data-access.md)（marketdata 访问层）；实施载体 = [045-optionsdesk-anchors-radar](../../specs/045-optionsdesk-anchors-radar/spec.md)（plan D1-D15）· [046-optionsdesk-detail-thermometer](../../specs/046-optionsdesk-detail-thermometer/spec.md)（跨 ctx 面 +2 条，见 §3 与 §复审记录 2026-08-03）

## Context

045「期权台」M1 = **锚管理**（每只标的一条估值锚：估值 V + 置信度 + 人工位 + 复审节奏）+ **击球区雷达**（按「距 W%」把「今天该看哪几只」收敛成一屏，W = 0.8V）。两个架构问题需要定稿：

1. **归属**：锚与雷达落既有 9 个 ctx 哪一个（最接近的候选 = `portfolio` 用户业务域 / `marketdata` 数据层），还是新立 bounded context？
2. **跨 ctx 面**：雷达要价（spot），采集闸要知道「哪些票有锚」——两个方向都跨 `marketdata` ↔ 期权台边界，各走 catalog Q5/Q6/Q7 的哪一档？

## Decision

### 1. 新立第 10 bounded context `optionsdesk`（catalog Q4 命中）

[catalog](../conventions/server-bounded-context-catalog.md) 7Q 逐条：

| #                                             | 判定      | 依据                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1** 直改某 ctx 核心表 row state？          | **否**    | 2 表全新（锚主表 + 变更痕迹表），无既有 owner；不碰 `account` / `portfolio` / `marketdata` 任何现有表的 row                                                                                                                                           |
| **Q2** 编排多 ctx 共同完成 user-facing 流程？ | **否**    | 建锚 · 改锚 · 复审 · 雷达查询全在域内闭环；唯一外部输入是行情价（只读投影，非编排对方生命周期）                                                                                                                                                       |
| **Q3** 纯 platform infra？                    | **否**    | 是业务领域（估值锚 + 击球区判定），不是 token / crypto / 事件总线                                                                                                                                                                                     |
| **Q4** 完全新业务领域，现 ctx 都不沾？        | **是** ✅ | 「以估值锚为中心的期权卖方决策台」是全新领域。落 `portfolio` 会让持仓域吃进「估值口径 + 击球区几何 + 复审状态机」三类异质职责，且锚**不是持仓**（无锚的票照样可以持有，有锚的票可以空仓）；落 `marketdata` 方向更错——底座会反向吃进用户的主观估值结论 |
| **Q5** callee 失败须 rollback caller？        | **否**    | 无跨 ctx 写，无同 tx 编排                                                                                                                                                                                                                             |
| **Q6** side-effect notification？             | **否**    | 无跨 ctx 事件发布（M1 不进 Outbox）                                                                                                                                                                                                                   |
| **Q7** 独立跨 ctx 只读？                      | **是 ×4** | 见 §3（3 条 `optionsdesk → marketdata` + 1 条**反向**，全 Q7-B；045 立 2 条、046 加 2 条）。⚠️ **061 起 +1 条**「强一致同步读」（非 Q7-B，见 §3 末）                                                                                                  |

- **物理面**：`apps/server/src/optionsdesk/`（ADR-0043 扁平贫血，文件平铺 + 直注 `PrismaService`，无 repository port / 无 Domain Class）+ Prisma schema `optionsdesk` 2 表（锚主表 + 变更痕迹表，moat owner=`optionsdesk`）+ `apps/mobile/src/optionsdesk/`（business-naming 三处同名）。
- **依赖面**：**叶子 ctx** —— 单向 `optionsdesk → account`（`JwtAuthGuard` / `AccountIdThrottlerGuard` 鉴权 artefact 经 export 复用，非业务调用）+ `optionsdesk → security`（platform infra）+ **唯一放行的业务读边 `optionsdesk → marketdata`**（行情类型复用；数据面走 §3 的 Q7-B 直查）。**无人 import optionsdesk**（marketdata 侧采集闸同样走 Q7-B 直查，不 import 本 ctx —— 底座不依赖业务的方向铁律）。ESLint `boundaries` + `check-server-moat` 探针双层强制。
- **注册面 5 条**（045 T001 一次做齐）：`boundaries/elements` 新元素（声明序在 `marketdata` 之后）/ `from:{type:'optionsdesk'}` disallow 规则 / **既有 11 条 from 规则的 disallow 数组各加 `optionsdesk`**（`boundaries/dependencies` 是 `default: allow`，漏一处 = 静默给对方开一条到我们这里的边）/ `check-server-moat` 的 `BUSINESS_CTX` + `MODEL_OWNERSHIP` / `business-naming.md` 模块行。

> ⚠️ **顺带发现的既有不一致（mention 不改，不属 045 scope）**：`scripts/checks/check-server-moat.ts` 的 `BUSINESS_CTX` 在 045 之前只有 7 项（`auth/account/portfolio/marketdata/alert/chat/ideation`），**缺 `agent-bridge`**，而 boundaries elements 有它 —— 两处清单已不同步，后果 = Check 2 对 `agent-bridge` 的跨 ctx 注入注释静默不强制。045 加 `optionsdesk` 时两处都加，不再制造同款偏差；补 `agent-bridge` 留给触及 agent-bridge 的下一个 feature。

### 2. 锚是自有事实，派生量不落库；生效 L 层是唯一例外

落库边界的判据是「**是否参与 SQL 筛选/排序**」与「**是否带人工状态**」，**不是**变更频次（详见 045 plan D2/D3）：

- **落库**：`ticker`（canonical `market:code`，唯一约束）/ `V` / `asof` / `method` / `confidence` + 来源 / `excluded` + 原因 / `next_review` / **人工位三列** / **生效 L 层** / `last_close` + `last_close_date` / 本轮跌破首次观测日。
- **不落库**（请求时算）：`W`、四区间边界、愿卖锚两档、距 W% —— 口径仍在演进，物化必 drift。
- **生效 L 层落普通列而非 DB 生成列**：它是雷达筛选主维度必须能 `WHERE`，但映射算法后续会演进，生成列改算法要 DDL ⇒ 应用层写入时求值 + 提供批量重算路径。
- **档位常量不建表**：全部落 `anchor.rules.ts` 顶部具名常量即满足「配置化、不硬编码」，建配置表要配 CRUD 面，Senior Engineer Test 不过。

### 3. 跨 ctx 面 = 4 条 Q7-B 只读直查（3 条 `optionsdesk → marketdata` + 1 条**反向**）（ADR-0048 / ADR-0052 同款摊销判据）

| #   | 方向                         | 读什么                                                                                                                                                                                     | 立于    | 分类              |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------- |
| 1   | `optionsdesk` → `marketdata` | `Instrument(market_code)` → `DailyBar`（`adjust:'none'` 最新 `tradeDate` 的 close + 日期）单点回填自有 `last_close` / `last_close_date` 列（**单向投影**，读端 MUST NOT 反写 `daily_bar`） | 045     | **Q7-B** 只读直查 |
| 2   | `marketdata` → `optionsdesk` | 采集闸重算按「该 ticker 有没有锚」刷 `Instrument.needSync`（写的是 **marketdata 自有列**；跨 ctx 的只有那一次锚表 `findMany`）                                                             | 045     | **Q7-B** 只读直查 |
| 3   | `optionsdesk` → `marketdata` | `Instrument(market_code)` → `underlying_iv_daily` **最近一期**（`iv` / `iv_percentile` / `date`）—— 详情读端单点 `findFirst`，温度计读端 `groupBy` 取每票最新日 + 按 (标的, 日) 批量取行   | **046** | **Q7-B** 只读直查 |
| 4   | `optionsdesk` → `marketdata` | `us_index_daily` 按 `index_code` 取 VIX / VVIX **各自最近一期**（只 `select` `close` + `date`）—— **不经 `Instrument`**（指数级非标的级，库里根本没有对应的 `Instrument` 行）              | **046** | **Q7-B** 只读直查 |

- 四处 `prisma.<表>.find*` 上方**必须** `// CROSS-CONTEXT-READ:` 注释（`check-server-moat` 探针强制，且探针只认「构造器注入参数上方 / prisma 调用上方」两处，挂 import 上方不被采信）；**跨 ctx 写永远禁**。
- **`select` 即契约的机械面**（046 新增两条各带一条封闭纪律，读时刻意不取的列下游就不可能误用）：
  - 第 3 条 **蓄意不 `select` `iv_rank`** —— IVR 只落库不上屏（046 FR-013）。不查出来 ⇒ 任何投影都不可能把它漏上屏。
  - 第 4 条 **蓄意只 `select` `close` + `date`** —— VVIX 的 `open`/`high`/`low` 在库里恒 NULL（CBOE 那个文件只有 `DATE,VVIX` 两列），不查出来 ⇒ 不可能被下游当 0 用。
- 🚨 **046 的第三张新表 `underlying_iv_history` 不在本面内**（登记「蓄意不读」，防下次审计当缺口补）：它只供 **marketdata 采集侧**的 IVP 自算与双算对表（046 plan D4 / FR-034），显示口径恒为 vendor 直读值 ⇒ optionsdesk **从不读它**。三张表的 `MODEL_OWNERSHIP` 均声明 owner = `marketdata`，将来 optionsdesk 若要读它，那就是**新增第 5 条 Q7-B**，回本节登记。
- **禁 `@Inject()` 对方的 use case**（catalog Q7-C 明令）；两个方向都不新增契约、不新增端点。
- **为什么不上 Q7-A 投影机器**（同 ADR-0048 复审记录的摊销判据）：方向 1 读频率 = 每日一次同步步骤，读时计算 = 按 ticker 批量取最新 bar，漂移兜底 = 重跑同一条查询；方向 2 = 每轮 cron 前置一次全表 `findMany` 锚 ticker 集合。**无摊销对象** —— 事件机器在为不存在的读压力做优化。
  - **046 的第 3 / 4 条同判定**，尽管它们是**请求期**读（不是 cron）：两者都是**唯一键上的最近一期**，与锚数无关的固定往返数（温度计端 = 1 次锚全量 + 2 次指数点查 + 3 次批量跨 ctx 查，**禁逐票 await**）；数据日更一次而读随用户开屏 ⇒ 投影表的新鲜度不会比直查更好，只会多一层要维护的落后副本。真正的升级信号写在 sunset_trigger（盘中实时上线 ⇒ 强一致同步读），不是 QPS。
- **方向 2 的降级纪律（照抄 `sync-tier-recalc.ts:38-41` 先例）**：整方法 try/catch 全包，读锚表失败只 `logger.warn` + 返 `null`、**不上抛** —— 上抛会污染 marketdata 的 `SyncRun` 状态。且**禁**把 optionsdesk 注册进 marketdata 的 `SyncDimension` / executor 钩子（底座不依赖业务）。
- **`excluded` 不参与采集闸判定**：闸的判据严格是「有没有锚」。语义分工 = **锚 = 采集意愿，`excluded` = 交易意愿**；要彻底停采只能删锚。决定性理由 = 期权 EOD 无跨日补救，误停采造成永久数据断层。

#### 🔁 2026-08-18（061）追加 · 第 5 条 = **强一致同步读**（非 Q7-B ⇒ 本节标题的「4 条 / 全 Q7-B」自此不再完整）

| #   | 方向                         | 读什么                                                                                                                                                                                | 立于    | 分类                                        |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------- |
| 5   | `optionsdesk` → `marketdata` | 盘中投影 tick 经 **DI port token** 同步取实时报价（`REALTIME_QUOTE_PORT`，键 = canonical `market:code`）+ 市场时段（`MARKET_STATE_PORT`，回归一后的 `regular` / `other` / `unknown`） | **061** | **强一致同步读**（非只读直查，**非 Q7-B**） |

- **读的不是对方的表，是对方 `exports` 的 port**（`MarketdataModule` 因此**首次有 `exports`**）⇒ 探针注释用 `// CROSS-CONTEXT-SYNC:`（不是前 4 条的 `// CROSS-CONTEXT-READ:`），且必须挂**构造器注入参数上方**（`check-server-moat` Check 2 扫的是注入参数类型，挂 import 上方不被采信）。
- **Q7-C 禁令未破**：注入的是 **port token + interface**（ADR-0047 的 vendor 访问抽象），不是 use case —— 它没有业务生命周期、不写任何表、不产生痕迹。catalog Q7-C 禁的是 `@Inject()` 对方的 **use case**。
- **仍然零跨 ctx 写**：port 方法不写 `marketdata` 任何表；tick 拿到价之后写的是 **optionsdesk 自有列**（锚表 `intraday_price` / `intraday_at`，expand-only 两列）⇒ §Trade-offs「双向 Q7-B」那行的前提不变。
- **不新建实时投影表、不走两跳**（`marketdata` 落表 → `optionsdesk` 读表）：实时面**无历史需求**（历史归 `daily_bar`），落表只为被读一次；两跳把延迟叠成 `poll1 + poll2`，而 061 的验收基线是 `T + 30 s`。
- **`apps/server/eslint.config.mjs` 零改动**：`optionsdesk → marketdata` 这条边 045 就已放行（§1 依赖面「唯一放行的业务读边」），本片只是**首次在运行时用它**（此前只用于行情类型复用）。⇒ 本片新增的 module 边**唯一一条**：`OptionsdeskModule.imports` 加 `MarketdataModule`。🚨 **不要顺手把 `marketdata` 的其他 port 也 export / import 进来**，只开这一个口子。
- **路由 adapter 无默认路由 = 刻意 fail-closed**，未登记市场抛专属类型 `RealtimeQuoteMarketUnsupportedError`（带 `market` / `registeredMarkets`）。这个专属类型的存在意义是把「**配置事实**」与「**源故障**」分开 —— 只有后者计熔断。🚨 具体到本 ctx 这是**今天就会发生**的事：`anchor-import.rules.ts` 的 `IMPORTABLE_MARKETS = ['us', 'hk']` ⇒ **hk 锚合法且随时可建**，而 061 只登记了 us 路由；若把这个 throw 当源故障计数，**一只 hk 锚就能在 90 秒内（每 30 秒 +1，连续 3 次 open）把 us 那半边一起降级**，而 us 的源一切正常。⇒ tick 按 market 分组后**逐组独立 try/catch**，「该市场无路由」落显式降级 + 一条日志，不进熔断计数。
- **前 4 条 Q7-B 只读直查一条未动**；`MODEL_OWNERSHIP` 无新增跨 ctx 表。

#### 🔁 2026-08-19（064）追加 · 第 6 条 = **同一条强一致同步读边的第二个消费者**（形态不变 ⇒ 只补清单，不重开重审）

| #   | 方向                         | 读什么                                                                                                                                                                                                              | 立于    | 分类                                       |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------ |
| 6   | `optionsdesk` → `marketdata` | 选约表 / 链分析报表在美股盘中经 **DI port token** 同步取整窗期权合约（含标的自身那一行）的**此刻报价** —— `OPTION_SNAPSHOT_READ_PORT`（住 `apps/server/src/marketdata/option-snapshot.port.ts`，与第 5 条同一条边） | **064** | **强一致同步读**（同第 5 条，**非 Q7-B**） |

- **形态与第 5 条逐条相同 ⇒ 本次只补这一行，不重开重审**（064 plan Gate 0.4 判 `accepted-as-is`）：注入的是 **port token + interface**（Q7-C 禁令未破）· 只读（`getSnapshots` 零落库、零新表、零新采集维度，064 `FR-019`）· 单向无环（`marketdata` 对本 ctx 仍零感知，只是 `exports` 多一个 token）· 注入点挂 `// CROSS-CONTEXT-SYNC:`（`check-server-moat` Check 2 强制）· **无新 module 边**（`OptionsdeskModule.imports` 里的 `MarketdataModule` 是 061 已开的那一条）。`apps/server/eslint.config.mjs` 零改动。
- 🚨 **读取口 ≠ 采集口，这不是命名洁癖**：`OPTION_SNAPSHOT_PORT`（采集口）经 `collectionPort()` 注册、`kind=mock` 下绑 054 的拒绝壳；本条走**裸 provider** 注册的 `OPTION_SNAPSHOT_READ_PORT`，`kind=mock` 下绑一个**显式降级实现**（调用即抛具名的「本环境无实时源」）。复用采集口会让 054 的「采集口产出必然被持久化」意图分类当场变成假话。
- 🚨 **两个 token 在 `kind=live` 下必须解析到同一个 `FutuOptionSnapshotAdapter` 实例**（`useFactory` 返回采集口那一个，🚫 MUST NOT 新 `new`）—— shim 侧限频是 per-capability 单桶，客户端每多一个实例就多一个令牌桶 = 上游允许值的 2 倍撞 429。
- 本条**不新增 marketdata 侧的表读**：061 已登记的 `MARKET_STATE_PORT` 与 062 起就在用的 `TRADING_CALENDAR_PORT` 在 064 只是多了一个本 ctx 内的消费点，跨 ctx 面条数不因此增加。

## Consequences

- 045 T001 落本 ADR 的全部注册面（boundaries + moat `BUSINESS_CTX` + business-naming + module 空壳），T003 落 schema / migration / `MODEL_OWNERSHIP`；新表接线未在 `MODEL_OWNERSHIP` 声明 owner 会被 `moat-unmapped` 硬拒。
- ~~雷达价的时效 = **最长延迟一天**（`last_close_date` 即对外 asOf），不是实时价 —— 这是 M1 的显式取舍，UI MUST 显示 asOf 否则该取舍不可验证。~~
  🔁 **该取舍 2026-08-18 由 061 作废并改写**（`sunset_trigger` #1 fired）。**现行**：雷达价 = **交易时段内优先盘中实时价，超新鲜度闸则回落 `last_close`**。三条钉死：① 新鲜度闸 = **3 × tick 间隔**（`3 × 30 s = 90 s`），倍数取 3 是为了让「熔断打开」与「数据被判陈旧」**同刻发生** —— 取 4 会留出 30 秒窗口让熔断已开而雷达仍按实时档排序，正是本次最想消灭的静默骗人形态；② SQL 排序表达式与回给客户端的档位（`priceKind`）**必须同源**，禁在 SQL 判一次、TS 再判一次（两处必漂移，且漂移表现为「排序按实时、显示说收盘」）；③ `asOf` 仍是该取舍**唯一**的可验证面，只是粒度在实时档从**日期**变**时刻**，**档位本身不上屏**（给档位另加视觉标记 = 新视觉元素 = 触发 mockup 闸）。
  ⚠️ **复核锚状态机不在改写射程内**：`advanceBreachState()` 的 `breach_started_on` 恒用 `last_close` 驱动 —— 它是 `@db.Date` 的**日粒度**事实，用分钟级价驱动会让红标在同一天内随 spot 反复穿越 W 而反复置位 / 清空，而清空是**破坏性**的。⇒ 本 ctx 自 061 起**两个 spot 口径并存**：排序用「新鲜实时否则收盘」，状态机恒用收盘。这是刻意的，不是漂移。
- `Instrument.needSync` 从「universe 同步私有列」变成**双写入点**列（universe create 分支 + 本 ctx 采集闸重算）。该列与 `syncTier` / `lixingerCompanyType` 同属 schema 注释点名的受保护列，重算路径**只碰这一列**。
- 建锚不即时开采：建锚 → 下一轮 cron 前置步骤重算 → 纳入工作集（即时生效需跨 ctx 写，已禁）。
- **046 起本 ctx 的跨 ctx 读进入「请求期」**（045 时只在日更同步步骤内）：两个新读端每次开屏都直查 marketdata 的表 ⇒ 跨 ctx 读**必须整段 try/catch 降级**（读失败只 `logger.warn` + 显式降级态、**不上抛**），否则 marketdata 侧一个小故障会把本 ctx 自有事实（锚卡 / 锚列表）也打成 500。降级态一律 **显式枚举 + null 值，禁回落成 0**（046 FR-014 / FR-017）——「指针停在 0」是错误信息，不是缺失信息。

## Trade-offs

| 短板                                                                                      | 接受理由                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 双向 Q7-B（两个 ctx 互相直查对方表）比单向更容易滑向隐式耦合                              | 四条都是**只读**（单点或唯一键上的批量最近一期）、都有探针强制注释、且都不 import 对方代码；换 Q7-A 要为零摊销对象建投影 + 消费基建                      |
| `last_close` 投影是冗余数据，与 `daily_bar` 可能短暂不一致                                | 距 W% 要成为 SQL **可排序**表达式，两个操作数必须同表；跨表 join 排序等于把护城河边界拖进查询计划。单向写入 + `last_close_date` 显式 asOf 使不一致可观测 |
| 生效 L 层落普通列 = 算法变更时须批量重算（有一次性运维动作）                              | 换「筛选可下推 SQL」；DB 生成列会把算法演进变成 DDL 变更，代价更高                                                                                       |
| 新 ctx 使 boundaries 规则从 11 条 from 涨到 12 条，每加一个 ctx 都要 O(n) 手工补 disallow | `default: allow` 的既有取舍（改 `default: disallow` 是平台级改造，超出本片）；用 grep 逐条核 + tasks Guardrail 固化                                      |
| 期权台与 portfolio 概念相邻（都关于「我的票」），未来可能要合                             | 现在合 = 持仓域吃进异质职责；真要合的信号写进 sunset_trigger（P3 下单 / 持仓联动）                                                                       |

## Open Questions

- 无（M1 范围内决策已定；盘中实时 spot / P3 许愿单自动触发 / 历史序列可视化均为下期 backlog，见 045 spec Assumptions 与本文 sunset_trigger）。

## 复审记录

> 045 plan Gate 0.4（ADR-deferred-mitigation Scan）逐条判定；两条 trigger 原文已回原 ADR 核对。

### 2026-08-01 — ADR-0048 sunset_trigger #2（server 端强一致同步读 marketdata）：`accepted-as-is`，未命中

[ADR-0048](0048-marketdata-portfolio-cross-layer-dependency.md) 的 trigger #2 原文 = 「出现 portfolio 必须**server 端强一致同步读 marketdata** 的场景（如下单校验需实时价、不能容忍 client-side merge 的最终一致）→ 跨层方向假设失效，重审是否引入 server 端只读跨 ctx 路径」。

**判定：未命中。** 045 的 spot 一律走 `last_close` + 显式 asOf（最长延迟一天），盘中实时价已明确推迟；本 ctx 对 marketdata 的读是**最终一致的 Q7-B 只读直查**，不是「必须强一致同步」的场景。方向假设（数据层为底座、业务层单向依赖）保持成立。

**命中条件（绊线，撞到即回本节 + ADR-0048 重审）**：① P3「许愿单」的触发判定需要实时价（不能容忍隔夜价漏判）；② 盘中实时 spot 上线，雷达/详情改以实时价为准。

### 2026-08-01 — ADR-0053 sunset_trigger #2（第二个 ctx import 他 ctx 的 `*.rules.ts`）：`accepted-as-is`，未命中

[ADR-0053](0053-cross-context-pure-rules-import.md) 的 trigger #2 原文 = 「第二个 ctx 申请 import 他 ctx 的 `*.rules.ts` → 重审是否升级为共享 package（`packages/`）而非继续点对点放行」。

**判定：未命中。** 045 **不 import** `marketdata/*.rules.ts`。雷达 spot = **最新未复权收盘价单点**（与既有 `eod-backed-quote.adapter.ts` 读 `adjust:'none'` 同口径），只取一个点、不取序列 ⇒ 用不到 `deriveAdjustedBars` 的前复权换算。`alert → marketdata-rules` 仍是唯一一条点对点放行边。

**该判定是机器强制的，不是文档断言**：`optionsdesk` 的 from 规则把 `marketdata-rules` **显式列进 `disallow`**。这一条不能省 —— `boundaries/dependencies` 是 `default: allow`，**不列即静默放行**；而 `scripts/checks/check-server-moat.ts` 探针**覆盖不到纯函数 import**（它管的是跨 ctx Prisma 只读直查与跨 ctx DI 注入，`import { fn } from '../marketdata/x.rules'` 两者都不是）。⇒ ESLint 这道禁令是本 trigger **唯一**的机器绊线。

**命中条件（绊线）**：将来雷达 / 锚详情要画**历史价格序列**（趋势图 / 跌破轨迹回看），届时必须读时复权 ⇒ 本 ctx 成为第二个 `*.rules.ts` 消费者。**触发形态 = `nx lint server` 变红**（`boundaries/element-types` 拒 `optionsdesk → marketdata-rules`）；那次「改 allowlist」的动作本身就是回 ADR-0053 重审「升 `packages/` 共享包 vs 继续点对点」的入口，无法绕过。

> 🔁 **2026-08-03 更新**：上面这条命中条件的**前半句已经发生**（046 详情页就是要画历史价格序列），但**后半句没有** —— 见下一节。判据自此收紧为「序列读落在哪一侧」。

### 2026-08-03 — 046 跨 ctx 面 +2 条；ADR-0053 sunset_trigger #2 复判：仍 `accepted-as-is`，未命中

046「标的详情上半 + 波动温度计」给本 ctx 加了**两个请求期读端**，跨 ctx 面从 2 条涨到 4 条（§3 表第 3 / 4 行，均 **Q7-B** 只读直查；`boundaries` 配置**未动** —— `optionsdesk → marketdata` 的读边 045 已开，本次不碰 `marketdata-rules` 那条 `disallow`）。第三张新表 `underlying_iv_history` **蓄意不读**，理由见 §3 末条。

**ADR-0053 trigger #2 判定：未命中，但触发条件的措辞已收紧。** 046 spec Q1 拍板**客户端合成两个端点** —— optionsdesk 端点只回锚派生的四区间边界与单点 IV 读数，**价格序列由客户端直调 marketdata 的 bars 端点**（前复权 + 时间桶聚合都归那边）。⇒ 本 ctx 依然**不 import** `adjusted-bars.rules.ts`，`alert → marketdata-rules` 仍是唯一一条点对点放行边。

**绊线原样保留、一个字没动**：`67a7e34a` 把 `adjusted-bars.rules` 写进 `optionsdesk` 的 ESLint `disallow`，本次 amend **不碰 allowlist**。⚠️ 这里有一处容易被后人误读的地方，写死在此：**「详情要画趋势」这个需求已经兑现了，绊线却没响** —— 因为绊线量的从来不是「有没有序列需求」，而是**序列读落在哪一侧**。将来若有人把序列读搬进 optionsdesk 端点（server 端拼序列 ⇒ 必须读时复权），`nx lint server` 会红；**那次「改 allowlist」的动作本身**才是 ADR-0053 sunset_trigger #2 的触发点，也是回那份 ADR 重审「升 `packages/` 共享包 vs 继续点对点」的唯一入口。别把 lint 红当成噪音顺手加进 allowlist —— 它就是设计给那一刻的。

**绊线是本次实测过的，不是文档断言**（046 T026 verify 第三条，反例探针）：在 `apps/server/src/optionsdesk/` 下临时放一个 `import { deriveAdjustedBars } from '../marketdata/adjusted-bars.rules'`，`nx lint server` 从 **0 errors** 变 **1 error**，报错原文 =

```text
Dependencies to elements of type "marketdata-rules" are not allowed in
elements of type "optionsdesk".  boundaries/dependencies
```

⚠️ 规则 id 是 **`boundaries/dependencies`**（上一节 2026-08-01 的记录写作 `boundaries/element-types`，措辞不准 —— 历史记录不回改，以本条实测为准，将来 grep 报错文案时认这个）。删掉探针文件后回到 0 errors。

**ADR-0048 trigger #2 同轮复判：未命中。** 046 一律 EOD + 显式 `asOf`（每个读数带自己的业务日，FR-020），且 FR-033 明禁盘中实时取数路径；读仍是最终一致的 Q7-B。命中条件不变（P3 许愿单触发判定需实时价 / 盘中实时 spot 上线）。

### 2026-08-18 — 061 盘中实时 spot 上线；本 ADR `sunset_trigger` #1：`fired`，已缓解

trigger 原文 = 「盘中实时 spot 上线（雷达/详情不再以 `last_close` + asOf 为唯一价源）→ 跨 ctx 读形态从『最终一致 Q7-B 只读直查』升格为强一致同步读，本 ADR §3 跨 ctx 面与 ADR-0048 `sunset_trigger` #2 一并重审」。

**判定：命中，且升格方向是本 ADR 自己预先规定的**（不是绕过）。[061](../../specs/061-marketdata-realtime-spot/spec.md) 让雷达 / 详情的 spot 在交易时段内改以**盘中实时价**为准 ⇒ 2026-08-01 那节登记的两条绊线里的第 ②「盘中实时 spot 上线」**已发生**。

**缓解 = §3 追加第 5 条跨 ctx 面（强一致同步读，非 Q7-B）**，机械面与判据见 §3 末新增块。要点三条：① 注入的是 **port token + interface**，不是 use case ⇒ Q7-C 禁令未破；② 本片新增的 module 边**唯一一条** `optionsdesk → marketdata`，注入点挂 `// CROSS-CONTEXT-SYNC:`；③ **不新建实时投影表、不走两跳**。

**方向铁律不破**：`marketdata` 对本 ctx **零感知** —— 没有任何 marketdata 代码 import `optionsdesk`，`MarketdataModule` 只是 `exports` 两个 token（export 不产生对消费方的依赖），锚驱动的一切仍由消费方主动拉。§1「叶子 ctx、无人 import optionsdesk」的表述保持成立。同轮的跨层方向复判见 [ADR-0048](0048-marketdata-portfolio-cross-layer-dependency.md) §复审记录 2026-08-18；实时面为何升格 `marketdata` 而非 `packages/` 见 [ADR-0054](0054-alert-self-hosted-external-io-adapter.md) §复审记录 2026-08-18。

🚨 **§Consequences 里「雷达价的时效 = 最长延迟一天」那条取舍已作废并改写，不是只标 fired 了事** —— 那句话自本日起是**错的**，留着它比没标 trigger 更坏（后人会照着一句错的正文做判断）。改写后的现行口径含新鲜度闸倍数（定死 3）、SQL 与 TS 档位同源、以及**复核锚状态机恒用 `last_close`** 的例外。

**ADR-0053 `sunset_trigger` #2 同轮复判：仍 `accepted-as-is`，未命中；绊线一个字没动。** 本片跨 ctx 拿的是 **port token + interface**，不是 `marketdata/*.rules.ts` 纯函数 ⇒ `apps/server/eslint.config.mjs` 里 `optionsdesk` 的 `disallow` 含 `marketdata-rules` 那条**未被触碰**（`git diff --stat main...HEAD -- apps/server/eslint.config.mjs` 空输出）。⚠️ 这条在本片**真有咬合面**，不是形式主义：vendor 市场状态的**白名单归一化**天然想写成一个纯函数，它若落 `marketdata/*.rules.ts` 再被本 ctx import，`nx lint server` 当场红。061 的处理是**把归一化推回 adapter 内**（port 对外只回归一后的 `regular` / `other` / `unknown`），**不是**改 allowlist —— 上一节写的「别把 lint 红当成噪音顺手加进 allowlist」在本片实际生效过一次。

### 2026-08-18 — 过渡态登记 ②：进程内 `@Cron` 多实例会重复触发

> 与本 ADR 相邻、但**不是 061 新引入**的既有前提；登记在此以免半年后被读成设计漏洞。过渡态 ①（两套 failstreak 并存）canonical 在 [ADR-0054](0054-alert-self-hosted-external-io-adapter.md) §复审记录 2026-08-18。

061 的盘中 tick 走进程内 `@Cron('*/30 * * * * *')`（`apps/server/src/optionsdesk/sync-anchor-intraday.scheduler.ts`），**不引 BullMQ** —— 本 ctx 一套 queue / worker / connection 都没有，为一个 30 秒 tick 从零搭 BullMQ 拓扑过不了 Senior Engineer Test；熔断计数用 Redis 即可，不需要 queue。

⚠️ **已知代价**：进程内 `@Cron` 在**多实例部署**下会重复触发。这与本 ctx 既有的 `sync-anchor-quote.scheduler.ts`（045 起就是 `@Cron`）**同一前提，不是 061 新引入的**。现状单实例部署；且本 tick **幂等**（覆盖写锚表同一批列，最后写赢），重复触发的代价只是多一次 vendor 调用（配额余量 60×）。

⇒ **真正的绊线是部署形态**：哪天 server 变多实例 / 蓝绿并存，这里要么加分布式锁、要么迁 BullMQ repeatable，且**两条 scheduler 一起迁**（只迁一条会留下更难读的半截状态）。在那之前不预造。

## References

- [061 spec](../../specs/061-marketdata-realtime-spot/spec.md) / [plan](../../specs/061-marketdata-realtime-spot/plan.md)（Gate 0.4 判本次 amend 为 `mitigated`；D1 = 一跳 DI port token、D4 = 排序表达式与新鲜度闸、D5 = 状态机恒用 `last_close`、D6 = tick 载体）
- [045 spec](../../specs/045-optionsdesk-anchors-radar/spec.md) / [plan](../../specs/045-optionsdesk-anchors-radar/plan.md)（D1-D15 决策 + Gate 0.4）
- [046 spec](../../specs/046-optionsdesk-detail-thermometer/spec.md) / [plan](../../specs/046-optionsdesk-detail-thermometer/plan.md)（Gate 0.4 判本次 amend 为 `mitigated`；D2 = 禁碰复权、D8 = 两个读端形态）
- [server-bounded-context-catalog](../conventions/server-bounded-context-catalog.md)（7Q 决策树 + 3 传播规则）
- Q7-B 直查先例：018 tiering 直查 holdings（[ADR-0048](0048-marketdata-portfolio-cross-layer-dependency.md) § 复审记录）/ 021 alert 评估直查 `daily_bar`（[ADR-0052](0052-alert-bounded-context.md) §3）
- 降级纪律先例：`apps/server/src/marketdata/sync-tier-recalc.ts`（跨 ctx 读失败只 warn 不上抛）
