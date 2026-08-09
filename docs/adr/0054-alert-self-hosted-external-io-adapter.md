---
adr_id: ADR-0054
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 第二个消费方需要实时行情（portfolio 盯盘 / 另一 ctx）→ 单消费者前提失效，重审是否把实时行情 port 升格为 marketdata 实时面 or 共享 package（packages/），而非在 alert 内继续自持
  - marketdata 长出实时行情同步面（intraday tick 落库 / 实时快照表）→ alert→marketdata「仅 EOD 无实时」的方向判据失效，alert 自持 adapter 应收回、改 Q7-B 只读或 DI marketdata 实时 port
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

- **单消费者**：该外部源只有这一个 ctx 消费（≥2 消费方 → 升格共享 package / 底座 ctx，见 sunset_trigger 第 1 条）
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
