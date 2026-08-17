---
adr_id: ADR-0054
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 第二个消费方需要实时行情（portfolio 盯盘 / 另一 ctx）→ 单消费者前提失效，重审是否把实时行情 port 升格为 marketdata 实时面 or 共享 package（packages/），而非在 alert 内继续自持
    ✅ **FIRED 2026-08-18（061）· mitigated** —— `optionsdesk` 即第二消费方；实时面升格 `marketdata`，**不升 `packages/`**（详见 §复审记录 2026-08-18）
  - marketdata 长出实时行情同步面（intraday tick 落库 / 实时快照表）→ alert→marketdata「仅 EOD 无实时」的方向判据失效，alert 自持 adapter 应收回、改 Q7-B 只读或 DI marketdata 实时 port
    ✅ **FIRED 2026-08-18（061）· 缓解物推迟到后续 feature** —— marketdata 确已长出实时面，但 alert 自持 adapter 的收编故意推迟（futu 账号无 A 股权限）；缓解期内 marketdata 实时面的 cn 槽 fail-closed 留空（详见 §复审记录 2026-08-18）
  - alert 自持的外部 IO adapter 超过 2 个（实时行情之外再加）→ alert ctx 事实上吃进「数据接入」职责，重审是否该抽独立 bounded context（ADR-0032 sunset trigger 评估）
---

# ADR-0054: Alert Context 自持外部 IO Adapter — 实时行情双源热备落 alert ctx 不 import marketdata

- Status: Accepted (2026-06-09)
- Deciders: @zhangleizlpd
- Tags: server / bounded-context / alert / marketdata / external-io / boundaries
- Relates: [ADR-0032](0032-backend-bounded-context.md)（bounded context 框架 + sunset trigger）/ [ADR-0043](0043-server-flat-module-paradigm.md)（扁平贫血 + `*.rules.ts` 纯函数层）/ [ADR-0047](0047-marketdata-pluggable-data-access.md)（vendor adapter + FallbackChain 范式，复用其形不复用其实例）/ [ADR-0052](0052-alert-bounded-context.md)（alert 第 6 ctx，叶子，对 marketdata 仅 Q7-B 只读）/ [ADR-0053](0053-cross-context-pure-rules-import.md)（同一 alert→marketdata 边界的「纯函数 import」细分先例）；实施载体 = [024-alert-realtime](../../specs/024-alert-realtime/spec.md)（plan D2/D8）

## Context

024 盘中实时预警需要**交易时段内的实时行情**（到价类即时判定 + 5min 涨跌幅相邻 tick 差分）。这是 alert ctx 第一次需要**外部 IO adapter**（vendor HTTP 拉取），区别于 023 的「import marketdata 纯函数」（ADR-0053，零运行时耦合，编译期依赖）——实时行情拉取是带 IO 的副作用调用，没有纯函数逃生口。

落点三选（catalog 7Q 复评，plan D2）：

1. **(a) 落 marketdata ctx 出 port，alert DI 注入** — 破坏 alert 叶子 ctx（ADR-0052），且 marketdata 现状是纯 EOD 同步底座、无任何实时面；为单一消费者（alert）反向给底座扩一整个实时数据接入面，方向错（底座不该因唯一上层消费者长出新职责）。
2. **(b) 新建 realtime bounded context** — 单 feature、单消费者，远不满足 ADR-0032 新 ctx 的 sunset trigger（跨 feature 复用 + 独立生命周期），过度工程。
3. **(c) alert ctx 自持实时行情 port + 双源 adapter** — 镜像 021「alert 自持 `alert-eval` BullMQ queue + Redis 连接而不 import marketdata」的既定先例：把外部依赖**物理收敛在消费它的 ctx 内**，复用 ADR-0047 的 `FallbackChain` 编排**范式**（不复用 marketdata 的东财 adapter 实例），保持 alert 仍是叶子、零跨 ctx 业务 import。

## Decision

**取 (c)** — alert ctx 自持实时行情外部 IO adapter，物理落 `apps/server/src/alert/`：

1. `realtime-quote.port.ts` — `REALTIME_QUOTE_PORT` Symbol + `RealtimeQuotePort` 接口（消费者 `evaluate-intraday-alerts.usecase.ts` 仅依赖此 Symbol，不感知双源）
2. `tencent-realtime.adapter.ts`（主）+ `sina-realtime.adapter.ts`（备）+ `realtime-quote-fallback-chain.adapter.ts`（编排：主源 200 且解析非空即短路，否则平移备源，全断抛供熔断）
3. `realtime-quote.rules.ts` — GBK 解码 + 字段对齐 + 涨跌幅口径收敛纯函数（腾讯直给 vs 新浪自算）
4. `realtime-fetch.ts` — 轻量 `fetch` + AbortSignal 超时（**刻意不镜像** marketdata `VendorHttpClient` 的 cockatiel retry+circuitBreaker：重试/熔断单层下沉到 `intraday-eval.processor` 的 Redis failstreak，避免双层熔断叠加，plan D2 轻量决策）

alert 对 marketdata 仍**只** Q7-B Prisma 只读直查（`trading_day` 交易日 gate），无 import 依赖；alert 仍叶子，无人依赖 alert。

### 放行判据（同类「ctx 自持外部 IO adapter」新边必须逐条过）

- **单消费者**：该外部源只有这一个 ctx 消费（≥2 消费方 → 升格共享 package / 底座 ctx，见 `sunset_trigger` 第 1 条）
  > 🔁 **2026-08-18（061）：这一条已失效** —— `optionsdesk` 是第二消费方，实时面已升格 `marketdata`。本 ADR 的落点 (c) 自此是**收编待办**而非现行范式，见 §复审记录 2026-08-18。**新的「ctx 自持外部 IO adapter」申请仍须过这四条**，本行的失效只针对实时行情这一个源。
- **底座无该面**：现有数据底座 ctx（marketdata）不提供该数据形态，强行让底座长出 = 反向扩底座（方向错）
- **复用既有 infra 范式**：adapter/编排走 ADR-0047 既定范式（FallbackChain），不发明新结构——「自持」限定为 adapter 实例落点，不是范式分叉
- **叶子 ctx 不破**：自持后该 ctx 仍无跨 ctx 业务 import（镜像 021 自持 queue 先例）

### 防滥用

「ctx 自持外部 IO adapter」是**窄逃生口**，不是「任意 ctx 想拉外部源就地起 adapter」的通行证。判据任一不满足 → 回 (a)/(b) 重评。alert 自持 adapter 计数封顶（sunset_trigger 第 3 条：>2 个即重审抽独立 ctx）。

## Consequences

- ✅ alert 叶子 ctx 不破，零 alert→marketdata 运行时耦合；实时面收敛在唯一消费它的 ctx
- ✅ 复用 ADR-0047 FallbackChain 范式 + ADR-0053 同款 alert→marketdata 边界判据语言，决策一致性留链
- ✅ 单层熔断（Redis failstreak）语义清晰，无 vendor client 内置熔断 × processor 熔断 的双层叠加排障难题
- ⚠️ 实时源 vendor 契约（腾讯 `~` 分隔 idx / 新浪 Referer + `,` 分隔）成为 alert 的外部破坏面 — 由 env-gated 真实源 IT（`RUN_PERF_IT`，默认 skip）校真字段/批量/延迟/双源切换，schema drift 即红
- ⚠️ 「ctx 自持外部 IO」若无判据约束会侵蚀 bounded context 边界 — 故本 ADR 把判据 + 计数封顶钉死（防先例即放行）

## 复审记录

> [061](../../specs/061-marketdata-realtime-spot/spec.md) plan Gate 0.4（ADR-deferred-mitigation Scan）逐条判定；trigger 原文已回本 ADR frontmatter 核对。相关决策：061 plan D1（一跳 DI）/ D2（新建 port 不搬迁）/ D6（tick 载体）/ D9（熔断与失败计数）。

### 2026-08-18 — `sunset_trigger` #1（第二个消费方需要实时行情）：`fired`，已缓解

**判定：命中。** `optionsdesk` 的盘中投影 tick 需要实时行情 ⇒ §放行判据第一条「**单消费者**」的前提失效。

**缓解 = 实时面升格 `marketdata`，`alert` 自持的那套本次不动。** 新面物理落 `apps/server/src/marketdata/`：`realtime-quote.port.ts`（`REALTIME_QUOTE_PORT` + `RealtimeQuotePort`）/ `futu-realtime-quote.adapter.ts` / `market-routed-realtime-quote.adapter.ts`（按 market 路由）+ `market-state.port.ts` / `futu-market-state.adapter.ts`（vendor 市场时段）。`MarketdataModule` 因此**首次有 `exports`**（`REALTIME_QUOTE_PORT` + `MARKET_STATE_PORT`）。

**为什么升 `marketdata` 而不升 `packages/`**（trigger 原文给的是二选一，把没选的那半写死）：这个面带 **IO + vendor 凭据**（shim token、per-capability 限频桶、熔断），属 **server 侧数据接入**职责；而 `packages/` 在本仓的定位是**无 IO 的共享类型层**（跨 mobile + server 复用的纯声明，per mono `CLAUDE.md` 工作区结构）。把一个持有凭据、发 HTTP、带令牌桶的适配层塞进 `packages/`，等于让 mobile 的构建图里出现 server 的 vendor 凭据面 —— 方向错，且 `packages/` 没有 DI 容器托管它的生命周期。

**升格后的消费形态 = 强一致同步读**：`optionsdesk` **DI 注入 port token**，不是「marketdata 落表 → optionsdesk 读表」的两跳（实时面无历史需求，历史归 `daily_bar`）。本片新增的 module 边**只有一条** `optionsdesk → marketdata`。跨 ctx 侧的判定详见 [ADR-0062](0062-optionsdesk-bounded-context.md) §复审记录 2026-08-18 与 [ADR-0048](0048-marketdata-portfolio-cross-layer-dependency.md) §复审记录 2026-08-18。

**`apps/server/src/alert/` 整目录 diff 为空**（`git diff --stat` 贯穿全 feature 核过）：升格建的是**新的通用面**，不是把 alert 那个 port 搬过去 —— alert 的 `fetchQuotes(symbols)` 键是 **vendor 符号**（腾讯 / 新浪 cn 专用形态），新 port 的键是 canonical `market:code`，vendor 符号转换下沉各 routed adapter 内部。两者**同名**（`REALTIME_QUOTE_PORT` / `RealtimeQuotePort`）是刻意的：那是终态名字，收编后 alert 那个文件删掉，全仓只剩一个。同名不会静默出错 —— `Symbol()` 每次调用产生**不同**的 token 对象，DI 不会串；单文件同时 import 两个是**编译期**标识符冲突。

### 2026-08-18 — `sunset_trigger` #2（marketdata 长出实时行情同步面）：`fired`，**缓解物推迟到后续 feature**

**判定：命中。** 061 确实让 marketdata 长出了实时面（上一节）⇒ 本 ADR Context 里「marketdata 现状是纯 EOD 同步底座、无任何实时面」的事实前提**已失效**。trigger 原文要求的动作 = 「alert 自持 adapter 应收回、改 Q7-B 只读或 DI marketdata 实时 port」。

**但收编本片不做，是故意的。** 决定性事实：**futu 账号无 A 股实时权限**（实测：美股 LV3 / 港股 LV2 / A 股无），而 marketdata 新实时面当前唯一的 adapter 走 futu。alert 的盘中预警是 **cn 市场**的 ⇒ 本片若强行收编，只有两种结局：

1. 迁完发现 futu 覆盖不到 cn，alert 盘中预警**当场断**；
2. 迁的是腾讯 / 新浪本体，于是 marketdata 实时面里同时住着两套语义不同的源（键是 vendor 符号 vs canonical `market:code`），**契约当场分叉**，而契约归一恰恰是收编的目的。

两种都比推迟差 ⇒ 分类 `escalated-to-next-feature`。

**缓解期内的显式状态：marketdata 实时面的 cn 槽 fail-closed 留空。** `market-routed-realtime-quote.adapter.ts` **无默认路由**，未登记市场直接抛专属类型 `RealtimeQuoteMarketUnsupportedError`（带 `market` / `registeredMarkets`）。这不是「忘了配」——专属类型的存在意义就是让上游把「**配置事实**」与「**源故障**」分开，只有后者计熔断。

**收编的落地条件（绊线，任一发生即回本节）**：① futu 拿到 A 股实时权限；或 ② 把腾讯 / 新浪包成 marketdata 侧的第二个 routed adapter 并把键统一到 canonical `market:code`。届时删 `apps/server/src/alert/realtime-quote.port.ts` 及其两个 adapter + `realtime-fetch.ts`，alert 改 DI `REALTIME_QUOTE_PORT`，本 ADR 整份进入 Superseded 评估。

**`sunset_trigger` #3（alert 自持 adapter > 2 个）：未命中。** 本片 alert 目录零改动，自持计数不变。

### 2026-08-18 — 过渡态登记 ①：两套 failstreak 并存

> 这不是缺陷，是上面「收编推迟」**直接派生**的中间状态。不写下来，半年后看会当成设计漂移去「顺手统一」。过渡态 ②（进程内 `@Cron` 多实例重复触发）canonical 在 [ADR-0062](0062-optionsdesk-bounded-context.md) §复审记录 2026-08-18。

缓解期内**两条实时链各持一套 Redis failstreak + circuit 键**：

| 链                            | 命名空间                 | 源              | 消费方            |
| ----------------------------- | ------------------------ | --------------- | ----------------- |
| alert 盘中预警（既有）        | `alert:intraday:*`       | 腾讯 / 新浪     | `alert` ctx       |
| marketdata 实时面（061 新增） | `optionsdesk:intraday:*` | futu（经 shim） | `optionsdesk` ctx |

两个命名空间**无交集**（`sync-anchor-intraday.scheduler.ts` 的 `INTRADAY_KEY_PREFIX` 单点定义 + 单测断言）。计数与阈值形态同源（连续 3 次失败 → open；成功即 close 回升，open 态不另设跳闸，每 tick 仍探一次源），但**实例各自独立**。

🚨 **在收编发生前，禁止为了「看起来整齐」把两边并成同一批键** —— 两条链的源不同、市场不同、失败原因不相干，并键会让一边的 vendor 故障把另一边一起降级。归一的正确时机是收编那一次（那时它们本来就变成同一条链）。
