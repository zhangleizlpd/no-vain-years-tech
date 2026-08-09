---
feature_id: 044-marketdata-calendar-resilience
spec_ref: ./spec.md
status: drafted
created_at: 2026-07-16
updated_at: 2026-07-16
adr_refs: [ADR-0043, ADR-0035, ADR-0040, ADR-0026]
context7_verified: []
---

# Plan: 044-marketdata-calendar-resilience（交易日历数据源韧性改造）

> **prose-only**（per [sdd.md](../../docs/conventions/sdd.md) 反模式）。数据模型 SoT = `apps/server/prisma/schema.prisma`，API SoT = 无（本 feature 无新读端点）。**不镜像** schema/OpenAPI，不造 research.md/data-model.md/quickstart.md/contracts/。
> **Spec**: [`spec.md`](./spec.md) ｜ **事故根因**: spec §背景（已完成取证，prod + 本地双侧路径分化实测）

## Summary

把交易日历（`trading_day`，**22 维同步的总闸口**）从「单一无授权 vendor 内部接口 + 静默降级」改造为「**双层 fallback 链 + 合理性闸 + 心跳告警**」。改动均在 `apps/server/src/marketdata/`（扁平，ADR-0043）+ `ops/`：

1. **链路**：`CalendarSourceFallbackChain`（L1 腾讯活源 → L2 静态离线日历），照抄既有 `FallbackChainAdapter` 范式，**但加一道现有范式没有的合理性闸**。
2. **可观测**：新增 per-market 填充健康心跳（新表），取代「per-market catch 只 WARN」的静默降级。
3. **告警**：独立于 app 的心跳探针（照 `ops/cert/` 范式）→ 复用 `nvy-run-reported` → `feishu-send.sh`；并修 `report.sh` 的循环信任盲区。

退役东财日历 adapter（FR-007：端点已被定向下线 + `robots.txt` 明确 `Disallow: /`）。

## Technical Approach

### 触点清单

| 文件 | 动作 |
| --- | --- |
| `trading-calendar-source.port.ts` | **新**（由 `index-calendar-source.port.ts` 改名而来，Decision 1） |
| `index-calendar-source.port.ts` | **删**（改名产生的 orphan，我方改动 → 必清） |
| `tencent-calendar.adapter.ts` | **新** — L1 活源 |
| `static-calendar.adapter.ts` + `static-calendar.data.ts` | **新** — L2 离线日历 + 生成物 |
| `calendar-source-fallback-chain.adapter.ts` | **新** — 链 + 合理性闸 |
| `eastmoney-index-calendar.adapter.ts` (+ `.spec.ts`) | **删**（FR-007） |
| `trading-calendar-sync.service.ts` | 改 — 注入链、写心跳、失败不再静默吞 |
| `marketdata.module.ts` | 改 — provider 工厂组链 |
| `schema.prisma` + 1 migration | 新表 `CalendarSyncHealth`（expand-only） |
| `scripts/checks/check-server-moat.ts` | 改 — `MODEL_OWNERSHIP` 声明新表（接线新表铁律） |
| `ops/marketdata-calendar-health/{check.sh,systemd/*}` | **新** — 独立探针 |
| `ops/marketdata-sync-report/report.sh` | 改 — 补日历健康断言（FR-012） |
| `scripts/checks/gen-static-calendar.ts` | **新** — 离线生成 L2 数据（人工年更） |

### Decisions

1. **Port 改名 `IndexCalendarSource` → `TradingCalendarSource`**（`INDEX_CALENDAR_SOURCE` → `TRADING_CALENDAR_SOURCE`）。理由：L2 是**直接日历**、非「指数 K 线推导」，旧名在本 feature 后即为谎报。契约 `fetchTradingDates(market, from, to): Promise<string[]>` **中性、零改**。
   - ⚠️ **命名接近风险**：既有读侧是 `TRADING_CALENDAR_PORT`（`trading-calendar.port.ts`，`DbTradingCalendarAdapter` 读表判 gate）。改名后 `TradingCalendarSource`（**写入源**，拉 vendor）vs `TradingCalendarPort`（**读**，查表）仅一词之差 → 两个 port 文件头**各加一行对照注释**明示读/写分工。
   - **备选已否决**：`CalendarFeed`（jargon，与仓内命名习惯不符）／不改名（名字谎报，且本 feature 正是引入非-index 源的那次改动）。

2. **L1 = 腾讯 `web.ifzq.gtimg.cn`，单 endpoint 统一罩三市场**（★ prod 77 PoC 实证，2026-07-16）：
   - `GET /appstock/app/kline/kline?param=<symbol>,day,<from>,<to>,<limit>`；symbol：cn=`sh000001`（上证综指）/ hk=`hkHSI`（恒指）/ us=`usDJI`（道指）。
   - ★ **实测澄清**：`kline/kline` 对 **cn/hk/us 全通**（曾疑 cn 须走 `fqkline/get`，复验为抖动误判）。`fqkline/get`（前复权）对日历用途多余 —— 只需「有没有 bar」，**不取复权价**。
   - 🚨 **响应 key ≠ 请求参数**（★ prod 实证）：请求 `usDJI` → 响应 key 回显 **`us.DJI`**。→ adapter **禁止按请求参数查 key**，须取 `data` 的唯一 value（`Object.values(data)[0]`）。踩这个会静默返空 = 再造一个毒饵。
   - 🚨🚨 **`limit` 尾参是「取最近 N 条」的截断器，且从老端静默截断**（★ PoC 实证，**推翻本 plan 初稿的隐含假设**）。同一 30 天窗（2026-06-16..07-16，hk）实测：

     | limit | 返回 | 首日 |
     | --- | --- | --- |
     | 5 | **5 天** | 2026-07-09（老端被截）|
     | 10 | **10 天** | 2026-07-02（老端被截）|
     | 30 | 20 天 | 2026-06-16（完整）|
     | 100 | 20 天 | 2026-06-16（完整）|
     | **0** | **1 天** | ——「0 = 不限」的直觉**是错的** |
     | **省略** | **0 天（空）** | —— 直接返空 |

   - 🚨🚨🚨 **`limit` 有硬上限 = 2000**（★ PoC 二分实证：`2000` ✓ / `2001` ✗ —— 干净的十进制整数，佐证是 vendor **有意的服务端自保**，非缺陷）。超限响应：

     ```json
     { "code": 0, "msg": "param error", "data": [] }
     ```

     **成功码 0 + 错误消息 + 空数组**，与正常响应 `{"code":0,"msg":""}` **共用 code 0** → **「`code===0` 即成功」这个最自然的判据是错的**（FR-015）。**push2delay 同款陷阱在新源上重现。**
     - 上限**只由 `limit` 值触发，与区间宽度无关**（实证：7yr 区间 + limit=1827 → ✓ 1724 天；**2yr 区间 + limit=2558 → ✗ param error**）。

   - **⇒ 分片规约（初稿「铁律 `limit = windowDays`」已被 PoC 证伪、作废；FR-016）**：

     ```text
     CAP = 2000                 // vendor 硬上限（PoC 实证）
     SAFE_CHUNK = 1800          // 留 200 余量
     分片：区间切成每片自然日数 ≤ SAFE_CHUNK
     每片：limit = 该片自然日数   // 仍由构造防截断（交易日数 ≤ 自然日数）
     合并：concat + 按日期去重
     ```

     - **日常 30 天填充**：1 片、`limit=30` → **行为零变**。
     - **seed CLI 宽区间**（`marketdata-trading-day-seed.cli.ts:59` 把用户 `from/to` 直传 `syncRange`）：10yr → 3 片（1800+1800+53）→ 从「静默空」变「正确全量」。
     - ★ **分片等价性已 PoC 实证**：7yr 单次（limit=1827 → **1725 天**）vs **2 片拼接（→ 1725 天）** → **仅单次有 ∅ ／ 仅分片有 ∅ ／ 片间重叠 0**。
     - 🚨 **明确否决 `limit = min(windowDays, CAP)`**：会把「超限报错」换成「静默截断」——**响亮错误退化成无声错误**，正是本 feature 要消灭的那类。**分片是唯一正解**，且与本仓既有 OOM 根治同族（chunk-oriented 批处理，`BACKFILL_ROW_CHUNK=500` 先例）。
   - 🚨 **合理性闸拦不住中度截断**（Decision 4 的已知边界）：`limit=10` → 返 10 天 > 下界 9 → **闸放行**，然后写入一个残缺日历。故截断**必须靠构造消除**（分片 + 每片 `limit = 片内自然日数`），**不能指望闸兜底**。闸只挡得住 0/1/2 级的粗暴毒饵。
   - 形态与旧东财源**同构**（指数有 bar = 开市），`day[]` 每项首元素即 `YYYY-MM-DD`。复用既有 `VendorHttpClient`。

   **★ 换源正当性 = 交叉校验（PoC 最有价值的一项，非「能连上」而是「数据对不对」）**：拿腾讯比对我们库里**旧东财源产出、已在 prod 服役数月**的 `trading_day`，区间 2026-01-01..07-14：

   | 市场 | 腾讯 | 我们库（旧源）| 仅腾讯有 | 仅我们有 |
   | --- | --- | --- | --- | --- |
   | hk | 128 天 | 128 天 | **∅** | **∅** |
   | cn | 126 天 | 126 天 | **∅** | **∅** |

   → 跨 6.5 个月、128/126 个交易日**双向零差异**。这是「腾讯可作为等价替换」的**实证依据**，而非推测。

3. **L2 = 静态离线日历（cn + hk，不含 us）** — ⚠️ **数据获取方式未决，见 §Open Decision-1**：
   - 落 `static-calendar.data.ts` **入仓**；**年更**（人工一次，与官方年度发布同频）。**不做运行时 PDF 解析**（clarify Q1 否决）。
   - ★ **PoC 澄清了 L2 的真实需求**（初稿没想清）：填充**只问 `[今天-30, 今天]`——永远是过去，从不问未来**。但静态表必须**覆盖到今天** ⇒ L2 **必须源自「年初即发布全年」的官方年历**；**不能**从我方历史快照生成（一生成即开始腐烂，到年中就答不了近 30 天窗）。这排除了「用我们自己的 `trading_day` 历史 seed 静态表」这条看似省事的路。
   - 🚨 **覆盖区间外必须抛错，禁止返空**（spec state_branch）：静态表有已知起止年份；被问及区间外（年更未跟上次年 / 早于起始年）→ **throw**，让链降级/显式失败。**否则静态层自己就成了第二个 push2delay**——同一个坑，换个地方踩。
   - 🚨 **「部分重叠」同样必须抛错**（analyze A5 补）：请求区间与覆盖范围**非完全包含**即 throw（如跨年窗 `2026-12-20..2027-01-20`，静态表只有 2026）。**禁止只返已覆盖的那部分** —— 返部分 = 缺失日被当成非交易日 = 静默毒饵。判据是「完全包含」，不是「有交集」。
   - **年更 owner**（analyze A6 补）：记入 `ops/runbook/scheduled-tasks.md`（owner + 时点：官方发布次年日历后、当年 12 月前跑一次生成脚本）。漏更的失败模式是**响亮的**（跨年 → 区间外 → throw → 全链失败 → 告警），可接受。
   - **不含 us**（clarify Q3）：prod 实证无 `{us}`-only 维度、gate 取 OR ⇒ us 日历不阻塞任何同步。us 仅 L1；L1 对 us 失效 → us 陈旧但无害。

4. **🔑 合理性闸放在链上（本 feature 的核心）**：
   - **位置 = 链，不是各 adapter**：单点实现、对所有节点一致生效；且「这个节点的答案可不可信」本就是链的判断职责。
   - **判据**：窗口内交易日数 < `ceil(工作日数 × MIN_RATIO)` → **判该节点失败 → 降级**（不写库）。`MIN_RATIO = 0.4`（30 天窗 → 工作日 ~21.4 → 下界 ~9）。
   - **阈值取值论证（★ PoC 实测校准，非估算）**：

     | 场景（30 天窗，limit=30）| 实测交易日数 | vs 下界 9 |
     | --- | --- | --- |
     | 常规窗 2026-06-16..07-16（hk）| **20** | 宽裕通过 |
     | **春节窗** 2026-02-01..03-02（cn，春节 2/17）| **15** | 通过，margin 6 |
     | 春节窗 同区间（hk）| **18** | 通过 |
     | 毒饵形态（push2delay 类）| 0 | **必拦** |

     初稿估「春节最坏 ~13」，实测 **15**（略乐观于估算）→ 下界 9 **margin 6，不误报**。保守优先——**宁可漏判一个「轻微少报」的坏源，不可误判长假为故障**（误报训练出「狼来了」，比漏报更毁告警可信度）。
   - 🚨 **闸的已知边界（PoC 揭示）**：闸**挡不住中度截断**（`limit=10` → 10 天 > 下界 9 → 放行）。故 Decision 2 的 `limit = windowDays` **由构造消除截断**是第一道防线，闸只是**粗暴毒饵的兜底**。**两者不可互相替代**——这是本 feature 最容易被误解成「有闸就够了」的地方。
   - 🚨 **短窗豁免**：窗口 < 14 天时**跳过闸**（工作日基数太小，`×0.4` 退化到 0/1，闸无判别力）。日常 populate 恒 30 天窗 → 恒受闸保护；seed CLI 的窄区间不受闸干扰。**这是已知且有意的局限，写进注释**。
   - 现有 `FallbackChainAdapter` **只在 throw 时降级**，接不住「200 + 空数组」→ 本链**不复用其代码**，仅照抄其结构/命名/日志范式（`falling through` WARN）。

5. **心跳 = 新表 `CalendarSyncHealth`（per-market 行）**（clarify Q2 + analyze A4）：
   - `(market PK, lastSuccessAt, lastAttemptAt, lastError?, servedBy?)`；`@@schema("marketdata")`，**无 instrument FK**（市场级，非标的级）。
   - 🚨 **`servedBy` = 降级可观测性的载体**（analyze A4，FR-014）：记「本次成功由链上哪一层服务」（如 `'tencent'` / `'static'`）。**非主源服务 → 探针告警**；主源恢复 → 值变回主源 → 信号自动解除。
     - **为什么必须有**：原设计「L1 死 → L2 接住 → 心跳照常新 → 不告警」会让**降级静默运行数月**，直到跨年静态表耗尽才全盘爆炸 —— **本 feature 立意就是消灭静默降级，却自己留了一个**。**降级 ≠ 健康**：系统虽在工作，但已失去冗余、且 L2 能力有限（仅当年 + 仅 cn/hk），属需人工介入态。
   - **判 liveness 而非 freshness**：填充成功即更新 `lastSuccessAt` —— 长假期间填充照样「成功但零新增」→ 心跳新 → 不告警（SC-005 天然满足）；app 挂掉 → 心跳自然陈旧 → 照样告警（FR-010）。
   - **为什么不复用 `sync_run`**：其语义是「维度同步跑批审计」，日历填充**不是维度**（不在 `DIMENSION_KEYS` 里）；塞非维度行会污染 `report.sh` 的逐维度解析 + 全景 IT 的维度计数断言。**新表更 surgical**。
   - 探针**直读 PG**（沿用 `report.sh` 既有 `docker exec psql` 范式）→ 不经 app 进程（FR-010）。

6. **`trading-calendar-sync.service.ts` 失败不再静默吞**（FR-008）：
   - 现状 per-market `catch` → 只 WARN + `inserted:0` 续跑 —— **这是潜伏 2 天的直接成因**。
   - 改为：per-market 仍**续跑其余市场**（保留「一市场坏不拖垮全局」= FR-004），但失败必**写 `lastError` + 不更新 `lastSuccessAt`** → 心跳陈旧 → 探针告警。**「续跑」与「可观测」不矛盾**：续跑是韧性，静默才是病。

7. **告警探针 = 新 `ops/marketdata-calendar-health/`**（照 `ops/cert/check-cert-expiry.sh` 先例）：
   - 🚨 **零逻辑 bash**（analyze A2 → user 裁决 (d)，满足宪法 §II NON-NEGOTIABLE）：`check.sh` **不承载任何判断**，只做「跑一条**已在 T013 测真**的 SQL 谓词 → 映射退出码 → 打印人读摘要」。**判断逻辑全在 SQL 谓词里，谓词在 server IT 被真测**（埋 25h/27h 心跳 + 降级/主源 `servedBy` 断言）。
     - 否决 (a) 个案豁免（§II NON-NEGOTIABLE，个案 = 稀释）／(b) 引 bats（为一处 glue 加依赖）／(c) 修宪（不为单 feature 动宪法）。
   - 谓词双条件（**任一成立即 `exit 1`**）：① `min(lastSuccessAt)` over cn+hk 陈旧 > **26h**（us 排除，见 Decision 3）；② **`servedBy` 非主源**（降级运行，FR-014）。
   - 阈值论证：填充日跑 21:00 → 上次成功 = D 日 21:00；D+1 21:00 那次失败时心跳龄 = 24h → 26h 闸在 D+1 23:00 触发 = **首次失败后 ~2h 告警**，满足 SC-003（24h 内）且不误报。
   - systemd timer 每 4h；由 `nvy-run-reported` 包裹 → 退出码驱动 `feishu-send.sh` 推送（**零新飞书基建**，复用全仓唯一出口）。

8. **`report.sh` 补日历健康断言**（FR-012，修循环信任）：
   - 零行分支新增一档，**插在「放行」之前**：
     ```
     recent_pop == 0        → 保守告警（既有）
     日历不健康（心跳陈旧） → 🔴 告警「日历不健康，无法判定停摆」   ← 新增
     y_trading > 0          → 🔴 疑似停摆（既有）
     → ⏭️ 放行（既有）
     ```
   - 病根是**它拿那张可能已坏的表当判据**；新增档位让它先问「这张表还可信吗」。FR-013 两项既有能力（健康+交易日→告警 / 健康+非交易日→放行）**不回归**。

## 二源形态对照

| 层 | 源 | 覆盖 | 失败形态 | 闸如何接住 |
| --- | --- | --- | --- | --- |
| **L1** | 腾讯 ifzq（活源，K线推导）| cn / hk / us | 连接失败 → throw；响应 key 误取 → 空 | throw 降级；空 → **合理性闸**降级 |
| **L2** | 静态离线（直接日历）| cn / hk | 区间外 → **throw**（禁返空）| throw → 全链失败 → 显式失败 + 告警 |

共性：均 `implements TradingCalendarSource`，契约同构 → 链与消费侧（`trading_day` 写入、gate 读表）**无感知差异**（spec state_branch「降级后结果同构」）。

## Testing Invariants（per ADR-0040 + spec 17 条 state_branches）

分层：

1. **纯函数单测**（vitest 无 DB）：L1 adapter 请求 URL 结构 + 解析（**`us.DJI` key 回显不按请求参数查**、`day[]` 首元素取日期、空数组容错）；L2 adapter（命中区间 → 返日历；**区间外 → throw** 而非返空）；**链**（主源成功不调后续 / throw 降级 / **空→降级** / **低于下界→降级** / 全链失败→throw / **短窗豁免闸** / per-market 独立）。
2. **Testcontainers PG IT**：填充落库 + 幂等（同 `(market,date)` 不翻倍）+ **心跳成功更新 / 失败写 lastError 且不更新 lastSuccessAt** + per-market 一市场失败不影响其余 + 降级后结果与主源同构 + gate 读表正常开启。
3. **env-gated 真 vendor IT**（`RUN_MARKETDATA_IT`，默认 skip）：腾讯真调返三市场交易日（固化回归网，防其重蹈东财覆辙时无声）。
4. **无回归**：`trading_day` 表结构 / 消费侧读表 / tick claim / gate / backfill CLI **均不改** → 相关全景 IT 期望值理论零改；但新表使 schema 表数 **27→28** → `schema-015/016/017` 等断言表数/表清单的全景 IT **必破**（照 039-043 先例，逐个更新期望值，**仅改既有 IT 期望、不动 044 impl**）。**必跑全 `nx test server`**。

### bash 侧的 §II 合规路径（analyze A2 → user 裁决 **(d) 零逻辑 bash**）

`report.sh` / `check.sh` 是 **bash**，仓内**无 bash 测试框架**（现有 `.test.mjs` 仅覆盖 node 脚本 `scripts/sdd-run/`）→ 无法 RED-first，直接撞宪法 §II（**NON-NEGOTIABLE**：「测试必须先写，看到 RED 才写实现」）。

**裁决 (d)：把 bash 压到零逻辑** —— 判断全部下沉为 **SQL 谓词**，谓词在 T013 的 Testcontainers IT 里**真测**（埋 25h/27h 心跳 + 主源/降级 `servedBy`）；bash 只剩「跑谓词 + 映射退出码 + 打印摘要」，**无分支、无阈值、无判断**。⇒ **逻辑 100% 被测**，实质满足 §II，且不修宪、不引依赖。

已否决：(a) 个案豁免（§II 是 NON-NEGOTIABLE，个案 = 稀释原则）／(b) 引 bats（为一处 glue 加新依赖，Senior Engineer Test 不过）／(c) 判定逻辑迁 node（prod host 不保证有 node，现 `report.sh` 靠 `docker exec psql`）。

> ⚠️ **残余**：bash 的「接线是否正确」（env、psql 调用、退出码传递）仍靠人工验证 + runbook 记步骤。**这是真残余，不粉饰** —— 但它已从「未测的判断逻辑」缩到「未测的三行胶水」。

## L2 数据获取（Open Decision-1 → ✅ **已决 (a)，PoC 验证通过**，user 2026-07-16 拍板）

**方式**：本地 `brew install poppler`（**dev 机一次性工具，不进仓、不增运行时/构建面**）→ `pdftotext -layout` 抽 HKEX 年历 → 人工/半自动产出 JSON 入仓 → **年更**。**仓内零新依赖**。

**PoC 实证（2026-07-16）**：poppler 26.07.0 已装；HKEX 2026 Stock Connect 年历 PDF（`http=200`，103 KB）经 `pdftotext -layout` 抽出**结构完全可解析**的文本。

### 🚨 解析规约（PoC 实证，impl 必守 —— 每条都是盲写解析器会踩的坑）

PDF 结构 = 每月一块：日号行 + 星期行 + `Hong Kong` / `Shanghai & Shenzhen` / `Northbound Trading` / `Southbound Trading` 四行。

1. **只列工作日**（Mon–Fri）→ 周末天然排除，解析器**无需**自己算周末。
2. **空白 = 开市；`Holiday` = 休市**。
3. 🚨 **`Half Day` = 交易日，不是休市**（除夕/圣诞前夕半日市）。**实证**：PDF 标 2026-02-16 HK `Half Day` → 库里**有**该日 ✅。误当 Holiday 处理会丢掉每年数个交易日。
4. 🚨🚨 **必须取 `Hong Kong` / `Shanghai & Shenzhen` 行，绝不可取 `Northbound/Southbound Trading` 行** —— Connect 关闭 **≠** 该市场休市。**实证 4/4**：2026-07-01（港股回归日）HK `Holiday` + Connect 双向 `Closed`，但 `Shanghai & Shenzhen` **空白**且库里 cn **有**该日 ✅；2026-05-25 / 04-03 同理。取错行 → **cn 每年凭空丢掉所有「港股独有假期」**。
5. 列按**位置**对齐（`-layout` 保留列位），非按空格数切分。

### ★ 三方独立源互证（本 feature 的证据底座）

| 比对 | 结果 |
| --- | --- |
| **L1 腾讯 vs 库**（旧东财源产出，prod 服役数月）| hk **128/128**、cn **126/126**，双向零差异（2026-01-01..07-14） |
| **L2 HKEX PDF vs 库** | **9/9** 探针日全中，含 `Half Day` 边界 |
| **Connect 陷阱验证** | **4/4**（cn 开市而 Connect 关闭的日子，库里均有） |

→ L1 与 L2 **彼此独立**（活源 K 线 vs 官方年历文档），且**各自独立地**与已服役数月的 in-prod 日历一致。这是「双层链」不是纸面设计的依据。

## 风险

1. **腾讯与东财同类**：同为**无文档、无 SLA 的网页内部接口**，可能重蹈今日覆辙。→ 这正是 L2 静态层 + 合理性闸 + 心跳告警存在的理由：**换源治不了根，链路 + 闸 + 告警才治**。腾讯挂 → L2 接住 cn/hk（唯二有维度的市场）→ 告警照响。
2. **合规**：腾讯 `web.ifzq.gtimg.cn` **无 robots 策略**（实测返 `{"code":11,...}` 而非 robots 文件），未找到其公开条款 → 授权面**弱于**「有明确 Disallow」的东财，但**不构成明确禁止**。L2 静态源来自官方公开日历，授权面干净。**长期正解是官方/授权源**（记为观察项，非本 feature）。
3. **静态表年更漂移**：人工年更漏跑 → 次年区间外 → Decision 3 的 throw 使其**显式失败**而非静默 —— 风险被转成告警，可接受。
4. **`us` 日历将长期由 L1 独撑**：L1 挂即 us 陈旧。已论证无害（无 `{us}`-only 维度 + gate OR）。⚠️ **若将来新增 `{us}`-only 维度，此假设失效** → 写进 static adapter 注释作为绊线。

## Out of Scope（继承 spec，另加）

- 07-15 / 07-16 缺口回补（本 feature 上线后独立 ops，走 backfill CLI + `hk-marketdata-backfill-first-night.md` 铁律）。
- 040-043 那 11 维首夜全量回填（master INV-3）。
- `eastmoney-search` / `eastmoney-universe` adapter —— 同为东财内部接口且同受 `robots.txt` 约束，但**不同 host / 不同端点、当前可达**，且本 feature 只治日历这一个总闸口。**mention 不动**（surgical；记为独立观察项）。
- 静态日历自动年更 / 引入付费日历源 / 其他 vendor 的降级能力。

## Constitution 对照（v1.4.0）

- **§I SDD**：spec → clarify（3 问已收敛）→ **plan（本文）** → tasks → analyze → implement，卡点不跳。
- **§II TDD**：每 task 先测后实现；链的合理性闸 = 纯函数可测，心跳 = Testcontainers IT。⚠️ bash 侧缺口已诚实标注（见上）。
- **§III Atomic**：每 task 30min-2h + 各自 commit。
- **§IV Module Boundary**：全改动在 `marketdata` 单 context 内（扁平，ADR-0043）；新表 `calendar_sync_health` **无跨 context owner**、无 instrument FK → `check-server-moat.ts` 声明 owner 即可，无 `CROSS-CONTEXT-*` 注释需求。
- **§V PR 边界**：一 feature = 一分支 = 一 PR。**纯 server + ops 脚本**，无 mobile / 无 api-client regen / 无 OpenAPI 变更 → 无 `[Contract]`/`[Mobile]`/`[Mobile-E2E]`/`[Contract-Smoke]` task。
