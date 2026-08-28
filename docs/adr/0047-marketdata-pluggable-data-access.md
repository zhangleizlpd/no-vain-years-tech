---
adr_id: ADR-0047
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - marketdata 消费端要求盘中实时 tick（QUOTE_PORT 从 EodBacked 换实时 adapter，可能重塑 port 形态 / 引入流式订阅，届时重审）
  - 单 capability 的 vendor fallback chain 长度 > 5（多源编排复杂度超过本 ADR 的轻量 FallbackChainAdapter，需引入路由/健康度加权策略）
  - 出现第 2 个同类「外部数据访问」子系统（如行业资讯 / 另类数据），本 ADR 的 port-first + 约束档模式应抽为 mono-wide 通用 infra 复审
---

# ADR-0047: Marketdata 可插拔市场数据访问层 — schema+port 先行 / 多 vendor adapter / per-adapter 约束档 / fallback-chain

- Status: Accepted (2026-06-03；原 Proposed 2026-06-02)
- Deciders: @zhangleizlpd
- Tags: server / architecture / external-data / port-adapter / market-data
- Supersedes: 无（扩展 [ADR-0043](0043-server-flat-module-paradigm.md) §4 port triage；follows [ADR-0032](0032-backend-bounded-context.md)）

> **⚠️ Amendment 2026-06-03 — UNIVERSE vendor-role 翻转 + per-dimension fallback policy**
>
> 0.3.0 上线实跑 + 2026-06-03 探测/调研后修订三处（证据：探针 runbook `ops/bin/probe-vendors.sh`；业内调研见新增 §6）：
>
> 1. **事实更正**：东财 push2 `clist` 被服务端**端点级反爬全量 RST**（生产 .62 / 另一阿里云 IP / 本机住宅 IP / 真 headless Chrome 四视角均 connection-reset；同 host 的 `kamt` 与 `searchapi` `suggest` 仍 200 → 是端点反爬，非 IP 封锁）；同时实测理杏仁 `/api/cn/company` 不传 `stockCodes` **单次返全 A 股 5622（含北交所，无分页）**，**证伪原 Context「理杏仁无 universe 枚举」前提**。
> 2. **UNIVERSE vendor-role 翻转**：从「东财 only」→「**理杏仁 primary + 东财 fallback**」（见 §2 表 + §4）。可靠付费源做主、逆向无 SLA 源做备。
> 3. **新增 §6 per-dimension fallback policy**：fallback-chain 不无差别套全 port——离散/口径无关维度走 fallback；口径敏感维度（EOD 复权价 / 估值）走 fail-or-flag、不静默切异口径备源；并强制「越过主源必打点、不静默降级」。
>
> 本次修订同时将 Status 由 Proposed 推进至 **Accepted**（2026-06-03）。

<!-- 分隔两个 Amendment 引用块（markdownlint MD028：blockquote 之间不得只隔空行） -->

> **⚠️ Amendment 2026-07-31 — UNIVERSE / TRADING_CALENDAR 的 us 路径换源富途 shim**
>
> sellput-viz Phase 1 #4/#5 落地（证据：p3b E5/E30/E31/E35 + 本机经 B↔C 隧道实测）：
>
> 1. **UNIVERSE 链改为 `[理杏仁 → 富途 → 东财]`**（§2 表 / §4 / §5 的「理杏仁 → 东财」两节点表述按此读）。cn/hk 仍理杏仁主源、东财备源不变；**us 由富途 `get_stock_basicinfo` 承担**（1 次请求取 19,202 条全集 = STOCK ∪ ETF）。
> 2. **东财 us 路径退役**：它一直在**静默少收** —— `push2` 服务端硬封顶 100 条/响应而代码按 500 推进游标 ⇒ us 只收 2,800/13,683 且按 code 降序截断（`AAPL` 都取不到），循环却正常结束、不触任何护栏。⚠️ **别加回来当 us 备源**：本链降级判据是「抛错**或返空**才平移」，一个「非空但残缺」的节点会在富途故障时静默接住。
> 3. **TRADING_CALENDAR 的 us 主源改富途**（腾讯降 L2），链按市场路由；cn/hk 维持 `[腾讯 → 静态年历]`。
> 4. **新 vendor 接入形态**：富途 OpenD 是 protobuf TCP 网关、官方 Node SDK 已弃 → 经 `services/futu-shim/`（港机上的 HTTP 薄壳）接入，对本层而言**就是又一个 vendor**，照常走 `VendorHttpClient` 的 profile / 限频 / 熔断，不开后门。

<!-- 分隔两个 Amendment 引用块（markdownlint MD028：blockquote 之间不得只隔空行） -->

> **⚠️ Amendment 2026-08-09 — 限频档从「双窗令牌桶」扩为「双窗 / 滚动窗二选一」**
>
> §3 原文写死「过**双窗令牌桶**（分窗 + 秒窗同时约束）」，那是按理杏仁（官方就是 36/s 且 1000/min 双窗）定的形状。富途 shim 的闸是**另一种形状** —— `services/futu-shim/src/futu_shim/ratelimit.py` 的 `LIMITS` 是 per-capability 的**滚动窗**（`option_chain` 10 次/30 秒、其余多为 60 次/30 秒），两者不可互相换算：
>
> 1. **换算即缺陷（prod 实证）**：把「10 次/30 秒」写成均值等价的 `{perSec:1, perMin:20}`，稳态确实是 10/30 s，但令牌桶**初始装满**，空闲后首轮会在 30 秒内放出约 30 发。2026-08-09 prod 后果 = 富途链发现每 30 分钟顺延一次、12 只锚永远只采到前 2 只（`skipDuplicates` 让重跑零新增行、纯烧预算）。同日直打 shim 的 PoC 复核：第 11 发即 429、`Retry-After: 29`、第 33 秒恢复。
> 2. **`rateLimit` 升为判别式联合**：`{ perSec, perMin }`（双窗令牌桶，允许冷启动突发）｜`{ maxCalls, windowMs }`（滚动窗，零突发容忍）。理杏仁 / 腾讯 / 东财 / CBOE 四个画像**一个字符不改**、行为逐字节不变；富途三个 capability 画像改为与 shim 的 `LIMITS` 逐字同构。
> 3. **429 改为采信 vendor 的 `Retry-After`**（RFC 9110 定义；RFC 6585 §4 的 429 原文是 **MAY** 带 ⇒ 兜底不能删），取 `max(profile.transientWaitMs, Retry-After)` —— profile 的值从「兜底」升为**下界**，理杏仁「429 = 分钟级封禁 ⇒ ≥60 s」那份保守不被 vendor 报的更短值抹掉。
> 4. **实现改名**：`DualWindowRateLimiter` → `VendorRateLimiter`（一个类现在管两种形状，旧名会说谎）。本文件 §3 的代码草图与「过双窗令牌桶」一句按本条读。

<!-- 分隔两个 Amendment 引用块（markdownlint MD028：blockquote 之间不得只隔空行） -->

> **⚠️ Amendment 2026-08-24 — per-adapter 约束档新增一节「缺失语义」，见 [ADR-0067](0067-vendor-absence-semantics.md)**
>
> 本 ADR 的 per-adapter 约束档此前只管**传输层**约束（限频档 / 熔断 / 重试语义 / 不得静默换源），**不管 vendor 如何表达「没有这个值」**。同一形状的缺陷因此在本仓出现了三次（`'N/A'` 字符串哨兵 → [#130](https://github.com/zhangleizlpd/no-vain-years-tech/issues/130) 实时档 `bid=0` → [#172](https://github.com/zhangleizlpd/no-vain-years-tech/issues/172) 日线快照 `bid/ask=0`）。
>
> 自本次起，**新增或改动任何 vendor adapter MUST 在约束档里回答 ADR-0067 §D5 的三问**（vendor 用什么形态表达缺失 / 哪些列无伴生字段不可判定 / 这个假设是文档写明的还是从数据反推的）。判据与分层表在 ADR-0067，不在本文件复述。

## Context

portfolio 大模块的多数特性（04 自选 / 05 详情 / 预警 / 策略实验室）依赖一个统一的股票数据层。该层要同时对接**异构外部数据源**，且各源的能力子集与访问约束差异巨大：

- **理杏仁（Lixinger，已付费）**：可靠的 EOD 事实源（candlestick / fundamental + cvpos 分位 / fs / 公司行动 / 交易日历），但**无模糊搜索、无实时 tick**（~~无 universe 枚举~~ — ⚠️ 已被本文件顶部 Amendment 2026-06-03 证伪：`/api/cn/company` 不传 `stockCodes` 即枚举全 A 股）；约束硬：双窗限频 1000 req/min 且 36 req/s（任一超即 429）、强制 `Content-Type: application/json` + `Accept-Encoding: gzip`、服务端分钟级自检要求瞬时故障等待后重试、fundamental 按公司类型分端点。
- **东方财富（逆向端点，免费）**：补理杏仁的模糊搜索缺口——`searchapi` 模糊搜索（名/拼音/代码，覆盖 A/HK/US）；`clist` 曾用于枚举全 A 股 universe（含北交所），但 ⚠️ 2026-06-03 起被端点级反爬封死（见 Amendment）→ universe 降级为**备源**；无 SLA、端点可能改版。

即「单一 provider 覆盖全部能力」不成立：能力是 capability-scoped 的，每个能力各自绑定能实现它的 vendor，且 vendor 各带不同的传输层约束。沿用 [ADR-0043](0043-server-flat-module-paradigm.md) §4「外部 3rd-party 厂商 → 薄 port + adapter」的方向，但需把它从「单 port 单厂商」升级为「capability 多 port + 多 vendor 组合 + 约束档 + 故障平移」。本 ADR 固化该访问层范式（驱动 spec：portfolio marketdata master plan）。

## Decision

落新 bounded context `apps/server/src/marketdata/`（per [ADR-0032](0032-backend-bounded-context.md) Q4 全新业务领域），其数据访问层遵循下列范式：

### 1. schema + capability-scoped port interface 先行

消费者（同步管线 / 读侧 controller）只依赖 `Symbol` token + interface，vendor 绑定在 `MarketDataModule` DI 工厂里切换（照搬 `auth` 的 `SMS_GATEWAY` 范式）。能力拆 8 个独立 port：

```text
INSTRUMENT_SEARCH_PORT / INSTRUMENT_UNIVERSE_PORT / TRADING_CALENDAR_PORT /
EOD_BAR_PORT / FUNDAMENTAL_PORT / FINANCIALS_PORT / CORPORATE_ACTION_PORT / QUOTE_PORT
```

canonical symbol = `${market}:${code}`（如 `CN:600519`）。

### 2. 每 port 背后可插拔多 vendor adapter，config-driven 绑定

`marketdata.config.ts` 用 zod discriminated-union（`kind: mock | live`，boot fail-fast），镜像 `config/sms.config.ts`。V1 绑定：

| Port                                                  | V1 adapter（vendor）                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| SEARCH                                                | `EastmoneySearchAdapter`（主）+ `LocalInstrumentSearchAdapter`（pg_trgm，备）                                |
| UNIVERSE                                              | `LixingerUniverseAdapter`（主）+ `EastmoneyUniverseAdapter`（备）— per Amendment 2026-06-03（原为东财 only） |
| TRADING_CALENDAR                                      | `LixingerTradingCalendarAdapter`（指数 candlestick 派生）— 修正原表「东财 adapter」笔误，码实为理杏仁        |
| EOD_BAR / FUNDAMENTAL / FINANCIALS / CORPORATE_ACTION | `Lixinger*Adapter`                                                                                           |
| QUOTE                                                 | `EodBackedQuoteAdapter`（消费 EOD_BAR_PORT，非独立 vendor）                                                  |
| **读取口 / 闸口**（`QUOTE` / `TRADING_CALENDAR`）     | `MockMarketDataAdapter`（dev/test 默认，零 env）                                                             |
| **采集口**（其余 28 个 vendor port）                  | `refusingCollectionPort()` 拒绝壳 — 一调即抛 `MockCollectionRefusedError`（dev/test 默认，零 env）           |

> **⚠️ Amendment 2026-08-13 — `kind=mock` 不再是「全部 → Mock」（上表末两行）**
>
> 原表末行是「全部 | `MockMarketDataAdapter`（dev/test 默认，零 env）」。它把**读**与**采集**混作一谈，而采集口的产出**必然被持久化** —— 于是 dev 下伪造行情与真行情同形落进真表，行数对得上、日志全绿，事后无从分辨（2026-08-12 实撞）。
>
> 现按「口的意图」分三类：读取口 / 闸口继续绑 Mock（它们不写库，dev 只读能力零回归）；采集口绑拒绝壳；`INSTRUMENT_SEARCH_PORT` 本就直查真 `Instrument` 表、不伪造数据，照旧。
>
> 兑现方式是 `marketdata.module.ts` 的 `collectionPort(token, { inject, live })` helper：**mock 分支收进 helper 内部，per-port 根本没有「mock 分支」这一行可写** ⇒ 新增采集口照抄邻居即自动继承约束。⚠️ 这条**不是**类型系统守着的：Nest 的 `provide` 是裸 `Symbol`，`FactoryProvider<T>` 的 `T` 从 `useFactory` 返回值反向推断，token 与 `T` 之间零关联；加之 TS 是结构化类型，收窄 `MockMarketDataAdapter` 的 `implements` 同样不产生任何约束（两条均 2026-08-13 探针实测）。**别照「让错的事变红」的思路去加守卫，那条路走不通。**
>
> 代价：dev 下每天会多出「采集被拒」日志 —— 这是刻意的可见信号（「你的本地进程正在试图采集」），不是故障。dev 失去的「写手真写库」验证面由 `option-snapshot-remediation.it.spec.ts` 顶替。
>
> 来源：`specs/054-marketdata-mock-write-provenance/`（spec / plan D-1~D-8 / tasks）。

### 3. 每 adapter 携 Vendor Constraint Profile，共享 `VendorHttpClient` 统一执行

```ts
type VendorConstraintProfile = {
  requiredHeaders: Record<string, string>; // Lixinger: Content-Type json + Accept-Encoding gzip
  rateLimit: { perMin: number; perSec: number }; // Lixinger: { perMin: 1000, perSec: 36 } 双窗
  retry: { maxAttempts: number; backoff: 'exponential' };
  transientWait: number; // Lixinger: ≥60s 对齐其分钟级自检
};
```

`VendorHttpClient` 注入必需 header、过**双窗令牌桶**（分窗 + 秒窗同时约束）、经 `CockatielRetryExecutor`（[复用 auth/cockatiel-retry.executor.ts]）退避重试 + 熔断 + 429/瞬时故障等待。新增 vendor 只填 profile，不重写传输层。

### 4. 多源组合经 `FallbackChainAdapter<T>`

包裹 `[primary, ...secondaries]`，主源 503 / 超时 / 配额耗尽 → 退避 → 熔断 → 平移下一顺位。V1 两条多节点链：**搜索**（东财 → 本地 pg_trgm）+ **universe**（理杏仁 → 东财，per Amendment 2026-06-03）；其余 port chain 长度 1，缝已留。⚠️ 链是否启用对各 port 不一刀切 — 见 §6 per-dimension policy。

### 5. 符号归一化封在 adapter 内

每 adapter 自带 `*-symbol.rules.ts` 纯函数做 canonical `market:code` ↔ vendor symbol 双向映射（理杏仁 stockCode / 东财 secid `1.600519`），port 对外永远 vendor-neutral。

### 6. Per-dimension fallback 策略（不是所有维度都该 fallback）— Amendment 2026-06-03

2026-06-03 业内调研（[AWS Builders' Library「Avoiding fallback in distributed systems」](https://aws.amazon.com/builders-library/avoiding-fallback-in-distributed-systems/) + golden-source / 复权口径文献）修正 §4 的一条隐含假设：**fallback-chain 不应无差别套到所有 port**。开源行情聚合库（OpenBB / ccxt / nautilus / akshare）一律「显式选源」、无运行时自动切异源；真正能自动切的交易所 A/B feed arbitration 前提是**同口径同源冗余**——异源 fallback 是自建逻辑，须按维度分策略：

| 类别                | 维度                                                                   | 策略                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **离散 / 口径无关** | UNIVERSE、SEARCH、CORPORATE_ACTION（事件本身）、FINANCIALS（财报原值） | **真 fallback**：主源 fail / 熔断 open → 平移备源；多源命中去重 + 标来源                                                                                              |
| **口径敏感 / 连续** | EOD_BAR（前/后复权价）、FUNDAMENTAL（PE/PB 等依赖口径的估值）          | **fail-or-flag，不静默切异口径备源**：不同 vendor 复权口径 / 字段定义逐 bar 难对齐，切点会埋静默价格跳变 / 估值断层；主源失败 → 标缺失 + 告警，宁可缺一格也不拼接异源 |

配套两条硬约束（AWS：fallback 最大的真实风险是**静默降级**，不是切换本身）：

1. **不静默降级**：`FallbackChainAdapter` 每次越过主源（fail / 熔断 open）→ 结构化 `warn` + 计数（log-based alerting 出口，对齐 `eod-sync-pipeline` 的 `FAILURE_ALERT_THRESHOLD`），避免「在备源上跑数周无人察觉主源已烂」。整链耗尽 → **fail loudly**（返空由调用方记 `SyncRun failed`），不返静默错 / 陈旧数据——金融数据「错得自信」比「缺失」更糟。
2. **可靠源做主、逆向无 SLA 源做备**：付费 / 有限频承诺的理杏仁做 primary；逆向、口径未必一致、无配额承诺的东财做 fallback（其反爬 / 限流脆弱性高于主源，熔断状态独立计）。

退避 / 熔断 / 429 等待已由 §3 `VendorHttpClient`（`CockatielRetryExecutor`）在**每 vendor 传输层**承担；§6 是其之上的**编排层维度政策**，非重复。

## Consequences

- 换 / 加数据源对消费者**零改动**——新 vendor = 新 adapter + config 绑定 + constraint profile + symbol rules，4 个局部文件。
- 同步管线（marketdata 子 plan 2）与读侧 API（子 plan 1 §A.3）都建立在本访问层之上；同步只调 port 拉数、写 schema。
- 测试统一用 `MockMarketDataAdapter`（零 env），env-gated 真 vendor IT 默认 skip（沿用 `RUN_PERF_IT` 范式）。
- `marketdata` 注册进 `check-server-moat.ts` + ESLint boundaries + Prisma multiSchema（第 5 个 bounded context）。
- PRD-03 §7 的非正式 provider 描述被本 ADR 取代（实现阶段回灌）。
- 实装 PR：marketdata master plan 的子 plan 1（访问层）先行，子 plan 2（同步）随后。

## Trade-offs

- **8 个 port 而非 1 个 MarketDataProvider** — 接口面变宽，代价是显式；收益是异构 vendor 组合（理杏仁基本面 + 东财搜索 + 未来实时源）零耦合切换，远超「单巨接口」的便利。
- **东财逆向端点入生产** — 无 SLA / 可能改版，代价是搜索的可靠性风险；以 `FallbackChainAdapter`（本地 pg_trgm 备 + 可加腾讯 smartbox）+ 保守限频缓解。可靠事实层仍由付费理杏仁承担，风险隔离。⚠️ Amendment 2026-06-03：universe 原也依赖东财、其 `clist` 已被反爬封死 → universe 已改理杏仁主源（§2/§6），东财 universe 风险随之化解、降为备源。
- **QUOTE_PORT V1 为 EodBacked（非真实时）** — 价为 EOD 收盘，盘中字段降级；代价是「最新价」口径偏离直觉，以 `QuoteSnapshot.asOf/priceKind` 显式标注。实时源就位后换 adapter，消费者零改动。
- **共享 `VendorHttpClient` 抽象** — 比每 adapter 各写 axios 多一层；但「多数外部源都有约束」使该层承重（限频 / header / 重试 / 瞬时等待统一执行），避免每 adapter 重复且漂移。

## Open Questions

- 理杏仁批量多 code 上限 / 日配额 / EOD 数据就绪时刻 — 付费 dashboard + 真实请求确认（不阻塞本范式）。
- 东财 `searchapi` / `clist` ToS 与限频策略 — 逆向端点，生产须限频自控。
- 未来实时 `QUOTE_PORT` vendor 选型（新浪/腾讯/AllTick/券商 OpenAPI）— 接入时再定，落同一 FallbackChain。

## References

- [ADR-0032](0032-backend-bounded-context.md) — Backend Bounded Context Split（新 context 流程）
- [ADR-0043](0043-server-flat-module-paradigm.md) §4 — port triage（本 ADR 的扩展基底）
- [ADR-0033](0033-outbox-cross-context-comm.md) — 跨 context 通信（portfolio→marketdata 读走 R2）
- PRD: `docs/prd/portfolio/portfolio-03-data-provider-tech-design.md`（§7 被本 ADR 取代）
- Master plan: `docs/private/plans/2026-06/06-02-portfolio-marketdata-master.md`（含子 plan 1 访问层 / 子 plan 2 同步）
- 复用：`apps/server/src/auth/sms-gateway.port.ts` + `config/sms.config.ts` + `auth/cockatiel-retry.executor.ts`
- Amendment 2026-06-03 实证：探针 runbook `ops/bin/probe-vendors.sh`（`eastmoney` clist 被封 / `lixinger-enum` 全市场枚举 5622 实测）；业内调研出处见 §6（AWS Builders' Library、OpenBB/ccxt 显式选源、CME A/B feed arbitration、OpenFIGI ID 归一化、复权口径不连续）。
