---
feature_id: 061-marketdata-realtime-spot
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-17'
updated_at: '2026-08-17'
---

# Tasks: 061-marketdata-realtime-spot（行情实时面 + 美股正股盘中价接入期权台雷达）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0054`](../../docs/adr/0054-alert-self-hosted-external-io-adapter.md)（实时行情归属，本片触发其 #1 #2）+ [`ADR-0062`](../../docs/adr/0062-optionsdesk-bounded-context.md)（期权台 ctx，本片触发其 #1）+ [`ADR-0048`](../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md)（跨层方向，本片触发其 #2）+ [`ADR-0047`](../../docs/adr/0047-marketdata-pluggable-data-access.md)（vendor adapter 范式）
**Branch**: `061-marketdata-realtime-spot`
**设计源**: `docs/private/plans/2026-08/08-17-quote-layering-{master,p1-us-realtime-spot}.md`（本机私有，未公开）

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §x）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。
- 层级：`[Shim]`（futu-shim，**另一条部署链**）/ `[Server]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Docs]` / `[Ops]`。

## Path Conventions

| 用途                              | 路径                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| shim 市场状态端点（改）           | `services/futu-shim/src/futu_shim/{app,opend,ratelimit}.py` + `tests/test_{app,opend,ratelimit}.py`                                          |
| 实时报价 port（**新建**）         | `apps/server/src/marketdata/realtime-quote.port.ts`                                                                                          |
| 实时报价 futu adapter（新建）     | `apps/server/src/marketdata/futu-realtime-quote.adapter.ts`                                                                                  |
| 实时报价按市场路由（新建）        | `apps/server/src/marketdata/market-routed-realtime-quote.adapter.ts`                                                                         |
| 市场状态 port + adapter（新建）   | `apps/server/src/marketdata/{market-state.port,futu-market-state.adapter}.ts`                                                                |
| 市场状态限频画像（改）            | `apps/server/src/marketdata/futu-shim.constraint-profile.ts`                                                                                 |
| marketdata 接线 + exports（改）   | `apps/server/src/marketdata/marketdata.module.ts`                                                                                            |
| 盘中价判据纯函数（新建）          | `apps/server/src/optionsdesk/intraday-spot.rules.ts`                                                                                         |
| 投影 tick use case（新建）        | `apps/server/src/optionsdesk/sync-anchor-intraday.ts`                                                                                        |
| tick scheduler（新建）            | `apps/server/src/optionsdesk/sync-anchor-intraday.scheduler.ts`                                                                              |
| 雷达读端（改：排序表达式 + 档位） | `apps/server/src/optionsdesk/get-radar.usecase.ts`                                                                                           |
| DTO / module（改）                | `apps/server/src/optionsdesk/{optionsdesk.dto,optionsdesk.module}.ts`                                                                        |
| DB（改：`anchor` 加两列）         | `apps/server/prisma/schema.prisma` + `apps/server/prisma/migrations/`                                                                        |
| IT                                | `apps/server/test/integration/optionsdesk-061.anchor-intraday.it.spec.ts`                                                                    |
| mobile 雷达行（改）               | `apps/mobile/src/optionsdesk/`                                                                                                               |
| ADR amendment（改 ×3）            | `docs/adr/{0054-alert-self-hosted-external-io-adapter,0062-optionsdesk-bounded-context,0048-marketdata-portfolio-cross-layer-dependency}.md` |

🚨 **文件平铺**（ADR-0043）—— `apps/server/src/{marketdata,optionsdesk}/` 下 **MUST NOT** 建任何子目录。

## 🚨 Impl Guardrails（每条都是盲写会踩、且**踩了不会红**的坑）

1. 🚨 **实时报价 adapter MUST 复用既有的 `FUTU_OPTION_SNAPSHOT_HTTP_CLIENT` 实例，不要 `new VendorHttpClient(...)` 起第二个** —— 它打的是同一个 shim capability（`ratelimit.py` 的 `LIMITS["snapshot"] = (60, 30)` 是**服务端单一桶**），而每个客户端实例各持独立令牌桶。起两个 = 合计 120 次/30 s = 上游允许值的 2 倍。同一个「桶满突发」病灶在 prod 上让链发现每 30 分钟顺延一次（`futu-shim.constraint-profile.ts:56-61`）。**复用 client 实例，但不要复用 `FutuOptionSnapshotAdapter` 这个类**（它对空 `contractCodes` 前置拒绝）。
2. 🚨 **市场状态的白名单归一化 MUST 在 `marketdata` 的 adapter 内做完，port 只回归一后的语义** —— 判白名单的纯函数若落 `marketdata/*.rules.ts`，`optionsdesk` import 它会被 ESLint boundaries 硬拒（`eslint.config.mjs` 的 `from: optionsdesk` `disallow` 明列 `marketdata-rules`）。那是 **ADR-0053 sunset trigger #2 的绊线**，旁边注释原文「别把 lint 红当成噪音顺手加进 allowlist」。撞红了要把归一化**推回 adapter**，不是改 allowlist —— 改了会让本片 Gate 0.4 对 ADR-0053 的「未命中」判定当场失效。
3. 🚨 **`advanceBreachState()` 一行不动** —— 它读 `lastClose` 驱动 `breach_started_on`（日粒度 `@db.Date`）。改用实时价 ⇒ 红标一天内随 spot 反复穿越 W 反复置位/清空，而清空是破坏性的（`last_reviewed_on < breach_started_on` 的比较就此失去意义）。本片之后同一个 use case 里**两个 spot 口径并存是刻意的**，注释必须写死，否则下一个人会「顺手统一」。
   ⚠️ **射程订正（2026-08-17，T011 实装后发现）**：「一行不动」管的是它的**写库判据与 `breach_started_on` 转换**，**不含**它顺带返回的两个纯展示计数（`baseTotal` / `actionableTotal`）—— 那两个数不写库、不进 DTO，唯一去向是空态判定。让它们继续用收盘口径，会让**同一份响应里两个口径回答同一个问题**「有没有锚跌破 W」，正是下一条 Guardrail 4 点名要防的形态。修法见 T019：在**调用方**另算，函数体仍零行改动。
4. 🚨 **档位判定与 SQL 表达式必须同源** —— 禁在 SQL 里判一次新鲜度、在 TS 里再判一次。两处必漂移，且漂移表现是「排序按实时、显示说收盘」，**没有任何断言会红**。
5. 🚨 **`$queryRaw` 的输出列别名不要取成 `distance_to_w_pct` / `id`** —— PG 的 `ORDER BY` 优先解析输出列别名，`::text` 转换后同名会让排序落到字典序（`'-10' < '-15' < '-5'`），分页直接错乱。`get-radar.usecase.ts:186-189` 记着 045 的 T014 IT 实测撞过（⚠️ 那是**另一个 feature** 的 task 号，别与本文件的 T014 混）。本片不新增别名，照抄现状。
6. 🚨 **mock 档要两层防线** —— 只绑 `refusingCollectionPort` 拒绝壳的话，dev 机上 tick 每 30 秒抛一次、每 90 秒熔断一次，054 想要的那份「你的本地进程正在试图采集」的可见性**反而被噪声淹没**。tick 起手判 provider kind → mock 直接 return、0 次 port 调用；拒绝壳退为兜底。
7. 🚨 **`apps/server/src/alert/` 整目录的 diff 必须为空** —— 新 port 落 `marketdata`，与 `alert/realtime-quote.port.ts` **同名但不是同一个**（`Symbol('X')` 每次产生不同 token，DI 不会串）。不要「顺手统一」两个 port，收编是后续 feature 的事，且被账号权限挡着（futu 无 A 股权限）。
8. 🚨 **跨 ctx 注入点上方必须挂 `// CROSS-CONTEXT-SYNC:`** —— `scripts/checks/check-server-moat.ts` Check 2 扫**构造器注入参数类型**，缺注释 lefthook + CI 双层拒。注释挂**注入参数上方**，不是 import 上方（挂错位置探针不采信）。
9. 🚨 **改完 `schema.prisma` 必须 `prisma generate`，改了又撤回也要** —— `apps/server/src/generated/prisma/` 是 gitignored 构建产物，`git checkout` 撤不掉它。症状是大批「无关」测试同时红且形态是**工作集为空**，看不出与 schema 有关（2026-08-01 实证，排查耗时约 40 分钟）。
10. 🚨 **新鲜度闸 = `3 × T` = 90 秒，倍数已定死，禁写第二份数** —— `T = 30 s` 是**唯一**自由变量。初稿写成「3–4 × T」，那等于留了第二个没人拍的自由变量（analyze 阶段发现）。取 3 的理由：熔断阈值也是连续 3 轮 × 30 s = 90 s ⇒ **「熔断打开」与「数据判陈旧」同刻发生**；取 4 会留 30 秒的「熔断已开但还标实时」窗口。`check-optionsdesk-rule-constants.ts` 对整个 `optionsdesk/` 扫小数字面量，新建 rules 文件写阈值前先确认该值不在禁用集内。
11. 🚨 **api-client regen 是两步，漏第一步完全静默** —— `nx run server:export-openapi` → `nx affected -t generate`。`api-client:generate` 无 `dependsOn`，漏了第一步 orval 会拿上一版 json regen，`git status` 干净、lint/typecheck/test/build 全绿、CI 无一处会红（057 的 T011 实证）。
12. 🚨 **shim 的 `LIMITS` 新条目别按兜底值猜也别做等价换算** —— 该表已因「等价换算」踩过一次 prod 事故（`futu-shim.constraint-profile.ts:82-86`）。`get_global_state` 是对本机 OpenD 网关的调用、未必计入富途配额：**先查官方页；查不到就落兜底最严档，并在注释里写明「用的是兜底值，原因是查不到官方值」**（照 `stock_basicinfo` 的先例体例）。本片用量 1 次/30 秒，任何档位都够。
13. 🚨 **新增 shim 端点走数据路径（`session()` → `_ensure_ready()`），不要复用 `status()` 的被动路径** —— `status()` 蓄意不建 `OpenQuoteContext`（注释「a health probe must be side-effect free」），没有活 context 时对市场状态只能返 `null`，而 tick 需要确定答案；含糊的 `null` 会被上游当成「状态不可得」而 fail-closed 停采。
14. 🚨 **`intraday_at` 必须是 `Timestamptz(6)` 不是 `@db.Date`** —— 分钟级读数用日期列会把「什么时候采的」压平成「哪天采的」，新鲜度闸当场失效。且它是**我们的采集墙钟**，不是 vendor 的 `update_time`（后者是「最后成交时刻」，实测盘中滞后中位 40 s / p95 292 s / max 672 s）。
15. 🚨 **两列不入 `anchor_change` 痕迹表** —— 同 `last_close` 的既有规矩（`sync-anchor-quote.ts:28-30`）。灌进痕迹会把 PIT 回放淹没在每 30 秒一条的行情噪声里。
16. 🚨🚨 **「市场不支持」MUST NOT 计入熔断 failstreak** —— `anchor-import.rules.ts:21` 的 `IMPORTABLE_MARKETS = ['us', 'hk']` ⇒ **hk 锚合法且随时可建**。routed adapter 对未登记市场 fail-closed throw；若把它当源故障计数，**只要库里有一只 hk 锚，failstreak 每 30 秒 +1、90 秒后 circuit open，把 us 一起降级**，而 us 的源一切正常。直接违反 `state_branch` 14「MUST NOT 表现为故障」。⇒ 按 market 分组后**逐组独立 try/catch**，「无路由」落显式降级 + 日志、**不进计数**；只有「已登记市场的源真调不通」才计数。
17. 🚨 **批切分是调用方的事，adapter 只做前置拒绝** —— 锚数上限约 1000、shim 单批 400 ⇒ 最坏 3 批。分工照既有同源成例（`futu-option-snapshot.adapter.ts:223-229` 原文「切分是调用方的事」）：adapter 超限**零外呼**前置拒绝，tick 按 400 切批且逐批独立成败。同一段边界逻辑写两遍必漂移。
18. 🚨 **档位不上屏** —— 它进接口响应，界面**只以 `asOf` 的粒度**表达（实时=时刻 / 收盘=交易日）。给档位另加视觉标记 = 引入新视觉元素 = 触发 Constitution §I 的 mockup 闸，而本片的 mockup 豁免**正是靠这条收窄换来的**。要上屏就必须先补走 mockup 步。

---

## Phase 1: 纯函数与判据单点（阻塞其余）🎯

- [X] T001 [P] [Server] **`intraday-spot.rules.ts` 盘中价判据单点**（`FR-006`, `FR-007`, `FR-008`, `FR-014`, plan D4）：新建。`INTRADAY_TICK_INTERVAL_SECONDS = 30`（**唯一**自由变量）+ `FRESHNESS_TICK_MULTIPLIER = 3` ⇒ 闸 = 90 秒（Guardrail 10：倍数已定死，不是区间）；`isIntradayFresh(intradayAt, now)` 纯函数；`resolveAnchorSpot({ intradayPrice, intradayAt, lastClose, lastCloseDate }, now)` → `{ price, priceKind, asOf }` 三元组（**读端档位判定的唯一入口**，与 SQL cutoff 同源）。无 I/O 无 DI。→ verify: colocate 单测，**每条配边界**：闸内（→ 实时档）/ 恰在闸上 90 s（→ 实时档，闭区间）/ 闸外 91 s（→ 收盘档且**不用**陈旧实时价）/ `intradayPrice` 有而 `intradayAt` 为 null（→ 收盘档，防半写状态）/ 两者皆 null（→ 收盘档）/ **全为 null**（→ `price: null` 且 `priceKind` 仍显式给出，**MUST NOT 回落成 0**）。再断言**闸恒等于 `3 × T`**（硬编码 90 时该测应红）以及**熔断窗口与闸相等**（`CIRCUIT_THRESHOLD × T === 闸`，两者脱钩时该测应红 —— 这是 Guardrail 10 那条理由的机器化）。跑 `pnpm tsx scripts/checks/check-optionsdesk-rule-constants.ts` 绿

## Phase 2: shim 市场状态端点（**另一条部署链，可与 Phase 3 并行开发**）

- [X] T002 [P] [Shim] **`GET /market-state` 只读端点**（`FR-002`, `FR-003`, plan D7）：`opend.py` 加一个走 `session()` 的方法返回 `get_global_state()` 的**完整** payload（现有 `_probe_global_state` 只取 `qot_logined` / `trd_logined` 就把 `market_us` / `market_hk` 扔了）；`app.py` 加路由（Bearer 鉴权沿用 `_authenticate`，信封带 `as_of`）；`ratelimit.py` 的 `LIMITS` 登记一条（Guardrail 12：先查官方值，查不到落兜底并写明理由）。🚨 **不要改 `status()` / `/healthz`** —— 它的 side-effect-free 契约是部署闸的基础。→ verify: `tests/test_app.py` 加 ①无 token → 401 ②有 token 且 OpenD 可用 → 返回含 `market_us` / `market_hk` ③OpenD 不可用 → 明确错误而非空信封；`tests/test_ratelimit.py` 断言新 capability 落在自己的桶上、**不吃 `snapshot` 的令牌**；`/healthz` 的 `routes` 数组多出 `/market-state`（部署后这就是「跑的是不是那棵树」的硬证据）

## Phase 3: marketdata 实时面（**零消费方，合入即静默待命**）

- [X] T003 [Server] **实时报价 port + futu adapter**（`FR-001`, `FR-020`, plan D2）：新建 `realtime-quote.port.ts`（token + interface，键 = canonical `market:code`，缺标的静默省略、源故障/全空抛）+ `futu-realtime-quote.adapter.ts`（打 shim `/option-snapshot` 只传正股 code；金融数值一律 `string`；**采集墙钟取信封的 `as_of`，不用本机时钟**）。🚨 **Guardrail 1**：构造器收既有的 `FUTU_OPTION_SNAPSHOT_HTTP_CLIENT` 实例，**MUST NOT** 新起 `VendorHttpClient`。🚨 **Guardrail 17**：入参超 400 个 symbol → **前置拒绝、零外呼**（切批归调用方）。🚨 **`FR-020`：只读 `last_price` 一个字段** —— 响应里的 `pre_*` / `after_*` / `overnight_*` 三族**登记但不消费**，adapter 里 MUST NOT 出现对它们的读取（要不要呈现盘后价是独立产品决策，顺手读进来就等于替它做了）。🚨 非 us symbol 直接抛、零外呼（照 `futu-option-snapshot.adapter.ts:243-251` 的 `futuCode` 形态，静默返空会被记成「该标的今天没有报价」）。→ verify: colocate 单测（fake http client）：正常批 / 缺某标的（省略不抛）/ 全空（抛）/ 非 us（抛且零外呼）/ **401 个 symbol（前置拒绝且零外呼）** / `as_of` 不可解析（抛，不拿本机时钟顶替）/ 断言**没有任何一处读取 `pre_` `after_` `overnight_` 前缀字段**。**再加一条构造器断言**：本 adapter 与 `FutuOptionSnapshotAdapter` 在 module 里拿到的是**同一个 client 实例**（Guardrail 1 的机器化回归钉）。⚠️ **实落位置：T005** —— T003 阶段 module 尚未绑本 port，断言够不到；随接线一并落在 `market-routed-realtime-quote.adapter.spec.ts` 的「module 接线」段

- [X] T004 [P] [Server] **市场状态 port + futu adapter + 白名单归一化**（`FR-002`, `FR-003`, `FR-020`, plan D7）：新建 `market-state.port.ts`（市场级端口，**不套 `MarketRouted*`** —— 一次调用返回全部市场，照 `EARNINGS_CALENDAR_PORT` 的市场级先例）+ `futu-market-state.adapter.ts`（打 T002 的端点）。🚨 **Guardrail 2**：白名单归一化**在 adapter 内做完**，port 对外只回 `{ market, session: 'regular' | 'other' | 'unknown' }`。`futu-shim.constraint-profile.ts` 加一个 capability 专属画像（自己的桶，照 `option_chain` / `earnings_calendar` 先例；🚨 限额按滚动窗**原样声明，不做等价换算**）。→ verify: colocate 单测：白名单内状态 → `regular`；白名单外**已知**状态（盘前/盘后/夜盘/竞价/闭市）→ `other`；**未知**状态串 → `unknown` **且落日志**（vendor 将来加值时要看得见，**MUST NOT** 静默归到 `other`）；端点不可达 → 抛（供上游 fail-closed）。**反例断言**：喂一个 `'SOMETHING_NEW'` 进去必须得 `unknown` —— 若实现写成黑名单（「不是 CLOSED 就 regular」）该测立刻红

- [X] T005 [Server] **按市场路由 + module 接线 + mock 拒绝壳 + exports**（`FR-010`, `FR-018`, plan D1/D2/D8）：新建 `market-routed-realtime-quote.adapter.ts`（形态照抄 `market-routed-eod-bar.adapter.ts`：**无默认路由 = 刻意 fail-closed**，未登记市场直接 throw 并在消息里列出已登记市场；🚨 **该错误必须是可识别的专属类型**，不能是裸 `Error` —— 上游要靠它区分「配置事实」与「源故障」，见 Guardrail 16）；`marketdata.module.ts` 用 `collectionPort<...>` 绑两个新 port（`us` 接上，`hk` / `cn` 槽**留空**），mock 档绑 `refusingCollectionPort`；两个 token 加进 `exports`。→ verify: colocate 单测断言 `cn` / `hk` 入参**抛专属错误类型而非静默 null、也不是裸 Error**（`state_branch` 14 的实现级保证 + Guardrail 16 的前置条件）；`marketdata-054.mock-no-write.it.spec.ts` 同款断言 mock 档下两个新口一调即抛；`nx test server` + `nx lint server` 全绿；**`git diff --stat apps/server/src/alert/` 为空**（Guardrail 7）

## Phase 4: optionsdesk 落库与投影 tick

- [X] T006 [P] [Server] **`anchor` 加 `intraday_price` / `intraday_at` 两列**（`FR-013`, `FR-015`, `FR-019`, plan D3）：`schema.prisma` expand-only 加两列（均 nullable、无默认、无约束变更 ⇒ **不触发 expand-migrate-contract 三步法**）；migration 命名 `<yyyymmddhhmm>_add_anchor_intraday_columns`。列注释必须写明四件事：① `intraday_at` 是**我们的采集墙钟**不是 vendor 时间戳 ② 两列**不入痕迹表**及其理由 ③ **`FR-015`**：`last_close` 语义不变、仍是当日收盘的权威值与降级唯一落脚点，盘中列是**并列的第二列不是替代** ④ **`FR-019`**：这是「最近一次」不是历史序列，**MUST NOT** 有人后来加一张 `anchor_intraday_history`（历史归 `daily_bar`）。🚨 Guardrail 9（`prisma generate`）+ Guardrail 14（`Timestamptz(6)`）。→ verify: `pnpm --dir apps/server exec prisma generate`（⚠️ **没有** `server:prisma-generate` 这个 nx target，初稿写错；lefthook 的 `prisma-generate-gate` 跑的也是这条）后 `nx test server` 全绿（既有 IT 不因加列而红）；migration 在空库单向可用；既有行两列为 `null`

- [X] T007 [Server] **投影 tick use case**（`FR-004`, `FR-005`, `FR-011`, `FR-017`, plan D1/D6）：新建 `sync-anchor-intraday.ts`。**按锚的 market 分组**求值（本片分组里只有 `us`，但结构 MUST 容纳第二个键）；逐 market 判两闸并**取交集**（市场状态闸 → `CROSS-CONTEXT-READ` 读 `trading_day` 的交易日闸）；🚨 **Guardrail 16**：逐组独立 try/catch，「该 market 无路由」落显式降级 + 日志并**向调用方回报为配置事实**（供 T008 决定不计熔断）；🚨 **Guardrail 17**：按 400 切批、逐批独立成败；一次外呼取整批、**tx 外**；逐锚独立写、**只写自有两列**。🚨 **split-tx**：MUST NOT 在 tx 内等 HTTP。🚨 部分标的缺失 → 保留旧值（既不写 null 也不写 0），部分失败 MUST NOT 整批回滚。🚨 跨 ctx 注入点挂 `// CROSS-CONTEXT-SYNC:`（Guardrail 8）。→ verify: colocate 单测（fake ports）覆盖：非常规时段 → **0 次源调用**；非交易日 → 0 次；状态不可得 → 0 次且标记为**源故障**；**喂一个 hk 锚 → 它被分到自己的组、因无路由而显式降级，且回报的是「配置事实」不是「源故障」，us 组照常成功**（Guardrail 16 的机器化）；**401 只锚 → 恰好切成 2 批**，其中一批失败时另一批仍落库；某标的缺失 → 该锚两列不变。跑 `pnpm tsx scripts/checks/check-server-moat.ts` 绿

- [X] T008 [Server] **tick scheduler + 熔断 + mock gate + 收盘补一拍**（`FR-005`, `FR-012`, plan D6/D8/D9）：新建 `sync-anchor-intraday.scheduler.ts`，`@Cron('*/30 * * * * *', { timeZone: 'Asia/Shanghai' })`（形态同本 ctx 既有 `sync-anchor-quote.scheduler.ts:72`，**不引 BullMQ**）。熔断照抄 `alert/intraday-eval.processor.ts:147-166`（连续 3 次 → open + warn 降级；每 tick 半开探测、成功自动回升），Redis 键用**独立命名空间** `optionsdesk:intraday:*`。🚨 **Guardrail 16**：只有 T007 回报的**源故障**计入 failstreak，「市场无路由」这类配置事实**不计**。🚨 **Guardrail 6**：起手判 provider kind，mock 档 return `skipped-mock`、0 次 port 调用。**收盘补一拍**：判据 = 「上一拍在白名单内 ∧ 本拍不在」，上一拍状态存 Redis 同命名空间。返回可断言的 outcome 联合类型（照 `IntradayTickOutcome`）。`optionsdesk.module.ts` 注册 provider + `imports` 加 `MarketdataModule`（本片新增的**唯一** module 边）。→ verify: colocate 单测：三段闸各自的 outcome；失败 1/2/3 次的 failstreak 与 circuit 状态迁移；open 后首次成功自动回升；mock 档 0 次调用；**只有 hk 锚无路由（us 全成功）时连跑 10 拍，circuit 必须仍是 closed**（Guardrail 16 的回归钉）；**状态从 `regular` 翻到 `other` 的那一拍确实补采了一次**，再下一拍不采（`state_branch` 6）。`nx lint server` 绿（boundaries 放行 `optionsdesk → marketdata`）

- [X] T009 [Server] **IT ①：时段闸与采集路径**（`state_branches` 1–8，plan Testing Invariants）：新建 `optionsdesk-061.anchor-intraday.it.spec.ts`。走**真 DI 容器**（`Test.createTestingModule({ imports: [OptionsdeskModule] })`），真 PG + Redis，vendor 侧用 fake port 注入。覆盖：常规时段 + 交易日 → 落两列；白名单外已知状态 → 不采且不清空；未知状态 → 按闭市 + 留痕；状态不可得 → fail-closed；状态开市但非交易日 → 不采；常规刚结束 → 补一拍；响应缺某标的 → 保留旧值；部分失败 → 不整批回滚。🚨 **每个 `it()` 的名字引用该分支的判据原文关键短语**（如 `'白名单外的已知状态'`），**MUST NOT** 用「第 N 条」这类序号锚定 —— spec 里重排分支时序号会静默失配且无任何检查会红。→ verify: **9** 个 `it()` 全绿（8 条判据 + 1 条**交叉回归钉**：「状态不可得的那一拍 MUST NOT 覆写存的上一拍时段」—— 横跨分支 4 ∧ 6，没有自己的序号，否则一次源抖动会吞掉唯一的收盘边沿且不报错）；**MUST NOT** `new SyncAnchorIntradayScheduler()` 手搓实例（Testing Invariants 第一条）；🚨 真容器里 `MARKETDATA_PROVIDER` 缺省 = `mock` ⇒ **必须 `.overrideProvider(marketdataConfig.KEY)` 成 live**，否则整组恒返 `skipped-mock`、**全绿且毫无意义**（impl 期实测：不加 override 这 9 条全红）；跑 `pnpm nx test server <file>`

- [X] T010 [Server] **IT ②：熔断、降级与读端裁决**（`state_branches` 9–15，plan Testing Invariants）：在 T009 的同一文件内补第二组。覆盖：连续 3 轮失败 → 熔断且**不清空**既有实时价；熔断后首次成功 → 自动回升；实时价新鲜 → 用实时价 + 标实时档；实时价陈旧 → 回落收盘 + 标收盘档；两价皆无 → 距 W% 显式空、不为 0、`NULLS LAST` 位置正确；市场不支持 → 恒收盘档且**不表现为故障**（circuit 保持 closed）；收盘后两价「都是今天的」→ 闸单点裁决、连查两次结果一致不抖。`it()` 命名同 T009 规矩（判据短语，非序号）。→ verify: 7 个 `it()` 全绿；与 T009 合计 **16** 个 `it()` —— 其中 15 个对齐 `state_branches` 前 15 条（后 2 条归 T012），第 16 个是 T009 那条无序号的交叉回归钉

## Phase 5: 雷达读端

- [X] T011 [Server] **排序表达式 + 档位透出**（`FR-008`, `FR-009`, `FR-014`, `FR-015`, plan D4/D5/D10）：`get-radar.usecase.ts` 的 `$queryRaw` 把裸 `last_close` 换成 `COALESCE(CASE WHEN intraday_at >= $cutoff THEN intraday_price END, last_close)`，`$cutoff` **参数绑定**、值由 T001 的常量派生（`now - 90 s`）。读端档位走 T001 的 `resolveAnchorSpot`（Guardrail 4：与 SQL 同源）。`PriceKind` 在实时档翻 `'realtime'`（`marketdata.types.ts:29` 枚举已有值，**不新增**）。DTO 加档位与 `asOf`（**档位只进接口，不为它加任何 UI 元素** —— Guardrail 18）。🚨 **Guardrail 3**：`advanceBreachState()` 一行不动，并在其上方补一段注释写死「本 use case 内两个 spot 口径并存是刻意的」。🚨 **Guardrail 5**：不新增输出列别名。→ verify: 扩 `get-radar.usecase.spec.ts`：新鲜实时 → 按实时价排序且档位 `realtime`；陈旧实时 → **回落收盘价**且档位 `eod_close`；无任何价 → 距 W% 为 `null`、**不是 0**；**红标断言**：同一批数据下把 `intraday_price` 改到 W 下方而 `last_close` 在 W 上方 → `breach_started_on` **必须不变**（Guardrail 3 的机器化回归钉）

- [X] T012 [P] [Server] **分页 tripwire**（`FR-016`, plan D4）：不改分页语义（`radar-cursor.ts` diff 为空）；加一条断言：锚数达到 **`RADAR_PAGE_SIZE_DEFAULT` 的 80%**（= 16）时该断言红，提示回 spec FR-016 重评。用**默认页大小**而非 `RADAR_PAGE_SIZE_MAX`，因为 mobile 实际传的就是默认值（`apps/mobile/src/optionsdesk/use-radar.ts:34` 的 `PAGE_SIZE = 20`）。放 colocate 单测（不是运行期告警 —— 运行期告警没人看，红的测试才拦得住）。⚠️ 当前 13 只锚 = 65%，**离触发只差 3 只**，别写成「遥远的将来」。→ verify: 单测在锚数 16 时红、15 时绿；`radar-cursor.ts` **diff 为空**

- [X] T019 [Server] **空态计数改 spot 口径**（`FR-008`, plan D5 射程订正；**impl 期新增**，T011 落地后由只读复核发现）：`get-radar.usecase.ts` 的 `actionableTotal` 判 `belowW` 用的是裸 `row.lastClose`，而同一份响应里的筛选 / 排序 / 距 W% 已由 T011 改用 spot 表达式 ⇒ 盘中一旦出现「新鲜实时价跌破 W、收盘价未跌破」的锚，`all_idle` 横幅会说「一个都没有」而底下的行赫然是红色负距 W%。⚠️ 这**不是**「列表为空才显示所以撞不上」—— `all_idle` 是压在**非空列表**头上的 `ListHeaderComponent`（列表为空时先被判成 `filtered_empty`），横幅与行必然同屏。🚨 **`advanceBreachState()` 函数体仍零行改动**（Guardrail 3 射程订正见上）：在 `execute()` 的首页分支另发一条 `COUNT(*) FILTER (WHERE <spot> < <w>)` 覆盖 `actionableTotal`。🚨 **`spot` / `w` 两个 `Prisma.sql` 片段必须提成单点 helper** —— 否则筛选 / 排序 / 计数三处各写一遍，等于修掉一个缝又开一个同形态的新缝（Guardrail 4 同理）。→ verify: 扩 `get-radar.usecase.spec.ts` —— `intraday_price` 跌破 W 而 `last_close` 未跌破 → `emptyState` **MUST NOT** 为 `all_idle`；反向（收盘跌破、盘中回到 W 上方）→ 仍为 `all_idle`；`git diff` 对 `advanceBreachState()` 函数体为空；既有 IT `optionsdesk-045.radar.it.spec.ts` 的 `all_idle` 用例仍绿

## Phase 6: 契约与 mobile

- [X] T013 [Contract] **OpenAPI 导出 + api-client regen**（`FR-009`, Constitution §V）：🚨 **两步，漏第一步完全静默**（Guardrail 11）：`pnpm nx run server:export-openapi` → `pnpm nx affected -t generate`。→ verify: `apps/server/openapi.json` 的雷达响应含新字段；`packages/api-client/` regen 后 `git status` 有 diff（**没 diff 说明漏了第一步**）；`pnpm nx run-many -t typecheck` 全绿

- [X] T014 [Mobile] **雷达行 `asOf` 粒度**（`FR-009`, `FR-014`, US1-AS3, plan D10）：实时档 `asOf` 呈**时刻**、收盘档呈**交易日**；降级时距 W% 呈空**不呈 0**。🚨 **Guardrail 18：不新增任何视觉元素** —— 不加档位徽标 / 圆点 / 配色，本片的 mockup 豁免正是靠这条换来的。复用 `~/theme` + `~/ui` 既有原子，不新增屏、不改版式。→ verify: vitest 逻辑测（格式化函数：时刻 / 日期 / 空值三态）；**再加一条护栏测或 review 检查：雷达行的渲染树节点数与改动前一致**（新增元素会让它变）

- [X] T015 [Mobile-E2E] **Playwright 结构面冒烟**（`SC-003`, `SC-007`, US2）：雷达在实时档 / 收盘档 / 降级三态下的结构断言（`asOf` 粒度正确、距 W% 空而非 0、排序成立）。⚠️ 档位**不上屏**，故 web 侧无档位标记可断言（spec `web_compat_notes` 已同步）。→ verify: `pnpm nx run mobile:e2e` 绿；三类**验不到**的项（真实时段跳动 / 收盘当刻切换 / 真断源熔断链路）归 T018 真机

- [ ] T016 [P] [Contract-Smoke] **契约冒烟**（Constitution §V 第二层）：用生成的 `@nvy/api-client` 打 testcontainers 真 server，走一条雷达 happy path，验档位字段的序列化 / 反序列化对齐。落 `apps/mobile/e2e/contract-smoke/`。→ verify: `RUN_REAL_BACKEND_SMOKE=true pnpm nx run mobile:contract-smoke` 绿。🚨 **前提三件**：docker 可用（testcontainers 起 PG + Redis）／`:3000` 空闲（web build bake 了这个 API base，harness 探到占用即 fail fast）／env gate 打开 —— **不带 gate 跑会 exit 0 且一条断言都不执行**，那个「绿」不构成任何证据。⏸ **2026-08-18 本机未跑**：docker 引擎无响应（socket 可连但 `/_ping` 10 秒超时，`orb status` 却报 Running），需重启引擎后补跑再翻 `[X]`；已落地的是 spec 文件 + `run.ts` 注册 + `mobile:typecheck`/`lint` 绿（后者非空断言 —— 它证的是那三个字段与 `AnchorResponsePriceKind` 真在生成客户端类型上）

## Phase 7: ADR amendment 与端到端实证

- [ ] T017 [P] [Docs] **三份 ADR amendment**（plan Gate 0.4）：`ADR-0054` #1 标 fired（实时面升格 marketdata，**不升 `packages/`** 及其理由）+ **#2 标 fired 但缓解物推迟**（futu 无 A 股权限，缓解期内 cn 槽 fail-closed 留空）；`ADR-0062` #1 标 fired（§3 跨 ctx 面加一条强一致同步读边，Consequences 的「最长延迟一天」取舍作废改写）；`ADR-0048` #2 标 fired（引入的是只读同步调用不是跨 ctx 写，方向仍单向无环）。三份各追加一节 `## 复审记录`。🚨 **两个过渡态必须写进去**，否则半年后看像设计漂移：① 两套 failstreak 并存 ② 进程内 `@Cron` 多实例会重复触发（与既有 scheduler 同一前提）。→ verify: `pnpm tsx scripts/check-adr-frontmatters.ts` 全绿；`rg -n 'ADR-0053' docs/adr/0062-*.md` 确认那条**未命中**的判定与 `eslint.config.mjs` 的 allowlist **都没被动过**

- [ ] T018 [Ops] **端到端实证**（`SC-001` ~ `SC-007`，**唯一载体**）：美股盘中真机（Mate50 dev-client）逐条实测并把数字填回本 task —— ① 距 W% 分钟级跳动，端到端 P95 按 `intraday_at` 与页面读数时刻实测（`SC-001`）② 收盘后 2 分钟内的价 == 当日官方收盘价，且此时 `sync-anchor-quote` 的每小时投影尚未跑过（`SC-002`）③ 人为断源 → 三轮后全部回落收盘档、**0 个锚显示 0**（`SC-003`、`SC-007`）④ 恢复源 → 自动回升，无人工介入 ⑤ 一个交易时段内的实际调用量占配额比（`SC-005`）⑥ 连续 3 个美股交易日无人工干预，失败轮次从留痕逐条可查（`SC-006`）。→ verify: 逐条记录实测值（数字 / 截图路径 / `failstreak` 留痕）填回本 task；`SC-004`（alert 零变化）由 T005 的 diff 断言 + 024 既有 IT 全绿承担，不在本 task 重复

## Dependencies

```
T001 ─┬────────────────────────────────────→ T011 ─→ T012
      │                                        ↑
T002 ─┴─→ T004 ─┐                              │
                ├─→ T005 ─→ T007 ─→ T008 ─→ T009 ─→ T010
T003 ───────────┘              ↑
                               │
T006 ──────────────────────────┘

T011 ─┬─→ T013 ─┬─→ T014 ─→ T015
      │         └─→ T016
      └─→ T019

T017 [P] 全程可并行

—— 两条部署链都完成后 ——

T018
```

- **T001 / T002 / T003 / T006 可并行**（不同文件、无相互依赖）。T004 依赖 T002（要打那个端点，但可先按契约写、端点后到）。
- **T005 依赖 T003 + T004**（路由要有东西可路由）。
- **T007 依赖 T005（port 可注入）+ T006（列存在）**。
- **T008 依赖 T007**；**T009 依赖 T008**（在真容器里跑完整 tick）；**T010 依赖 T009**（同一个 IT 文件的第二组）。
- **T011 依赖 T001**（判据单点）+ **T006**（列存在），与 T007/T008 无依赖 ⇒ 读端可先于写端落地（读到的全是 `null` ⇒ 恒收盘档，正是 `state_branch` 13）。
- **T013 依赖 T011**（DTO 定型才能导 OpenAPI）。
- **T019 依赖 T011**（impl 期新增；与 T013 无先后，不改 DTO ⇒ 不触发重新导 OpenAPI）。
- **T018 必须等 shim 与 mono 两条部署链都完成**。

## 判据覆盖矩阵（`state_branches` 17 条 → task）

| #   | 分支                                     | task                                                          |
| --- | ---------------------------------------- | ------------------------------------------------------------- |
| 1   | 常规状态 + 交易日 → 采集并写两列         | T007 · T009                                                   |
| 2   | 白名单外**已知**状态 → 不采且不清空      | T004 · T007 · T009                                            |
| 3   | 白名单外**未知**状态 → 按闭市 + 留痕     | **T004（反例断言，唯一防线）** · T009                         |
| 4   | 状态不可得 → fail-closed + 计失败        | T004 · T007 · T008 · T009                                     |
| 5   | 状态开市但非交易日 → 不采（两闸交集）    | T007 · T009                                                   |
| 6   | 常规状态刚结束 → 补一拍收当日收盘价      | **T008（唯一载体）** · T009 · T018（②）                       |
| 7   | 响应缺某标的 → 保留旧值不写 null/0       | T003 · T007 · T009                                            |
| 8   | 部分成功部分失败 → 不整批回滚            | T007 · T009                                                   |
| 9   | 连续 3 轮失败 → 熔断 + 不清空既有实时价  | T008 · T010 · T018（③）                                       |
| 10  | 熔断后首次成功 → 自动回升                | T008 · T010 · T018（④）                                       |
| 11  | 实时价新鲜 → 用实时价 + 标实时档         | T001 · T011 · T010                                            |
| 12  | 实时价陈旧 → 回落收盘 + 标收盘档         | T001 · T011 · T010                                            |
| 13  | 两价皆无 → 距 W% 显式空、不为 0、不误排  | T001 · T011 · T010                                            |
| 14  | 市场不支持 → 恒收盘档非故障              | T005 · T007 · **T008（circuit 保持 closed 的回归钉）** · T010 |
| 15  | 收盘后两价「都是今天的」→ 闸单点裁决不抖 | T001 · T011 · T010 · T018（②）                                |
| 16  | 锚数低于默认页大小 → 分页路径不可达      | T012                                                          |
| 17  | 锚数达默认页大小 80% → tripwire 可见     | **T012（唯一载体）**                                          |

**17/17 全覆盖，零遗漏。**

## 自审：spec 有哪几层 / 扫了哪几层（per `sdd-authoring.md` 规则 ④）

spec 共 **5 层**判据：`state_branches`(17) · FR(20) · SC(7) · Acceptance Scenario(10) · Edge Case(8)。**五层全扫**，无差集。

### FR 覆盖（20 条）

| FR     | task                                      | FR     | task                         |
| ------ | ----------------------------------------- | ------ | ---------------------------- |
| FR-001 | T003 · T007                               | FR-011 | T007 · T009                  |
| FR-002 | T002 · T004                               | FR-012 | T008 · T010                  |
| FR-003 | T002 · T004 · T007                        | FR-013 | T006 · T007 · T009           |
| FR-004 | T007 · T009                               | FR-014 | T001 · T011 · T014           |
| FR-005 | T008 · T009                               | FR-015 | T006（列注释）· T011         |
| FR-006 | T001 · T003（采集墙钟取信封 `as_of`）     | FR-016 | **T012**                     |
| FR-007 | T001（倍数定死 + 与熔断窗口相等的双断言） | FR-017 | T007 · T009                  |
| FR-008 | T001 · T011 · **T019（空态计数同口径）**  | FR-018 | **T005（diff 断言）** · T018 |
| FR-009 | T011 · T013 · T014                        | FR-019 | T006（无新表即保证）· T007   |
| FR-010 | T005 · T007                               | FR-020 | T003 · T004                  |

**20/20**。

### SC 覆盖（7 条）

| SC     | task                                                  | 备注                                                         |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| SC-001 | **T018**                                              | 端到端 P95 ≤ 60 s —— 唯一验证手段是美股盘中真跑，IT 替代不了 |
| SC-002 | **T018（②）**                                         | 收盘后 2 分钟内 == 当日收盘价，且投影尚未跑过                |
| SC-003 | T010 · T011 · T015 · **T018（③）**                    | 降级 100% 收盘档、0 个锚显示 0                               |
| SC-004 | **T005（`apps/server/src/alert/` diff 为空）** · T018 | alert 行为差异 0 项 —— 靠 diff 断言 + 024 既有 IT，不靠人眼  |
| SC-005 | **T018（⑤）**                                         | 调用量占配额 ≤ 5% —— 需真实一个时段的计数                    |
| SC-006 | **T018（⑥）**                                         | 连续 3 个交易日无人工干预 + 失败轮次可查                     |
| SC-007 | T010 · T015 · T018（③）                               | 熔断全过程无一刻显示 0 或空白                                |

**7/7**。⚠️ 特别记：`SC-001` / `SC-002` / `SC-005` / `SC-006` **四条的唯一载体都是 T018**（真跑），这正是 `sdd-authoring.md` 点名的「只有口号、没有 IT 载体」系统性盲区 ⇒ **T018 不得被当作可选收尾砍掉**。

### Acceptance Scenario 覆盖（10 条）

- **US1（3 条）** → T011（AS1 实时档 + AS2 重排）· T014（AS3 `asOf` 呈时刻）· T018（三条的真实证）
- **US2（5 条）** → T008/T009/T010（AS1 熔断 · AS2 非时段 0 调用 · AS4 自动回升）· T005（AS3 市场不支持并列可比）· T001/T011（AS5 距 W% 空非 0）
- **US3（2 条）** → T008（AS1 收盘补一拍）· T018（AS2 与后续投影无可感知跳变）

**10/10**。

### Edge Case 覆盖（8 条）

未知市场状态 → **T004（反例断言）** ｜ 状态取不到 → T004 · T007 ｜ 状态说开市但节假日 → T007 ｜ 部分标的缺失 → T003 · T007 ｜ 新锚排在哪 → T001 · T011 ｜ 收盘后两价打架 → T001 · T011 ｜ 翻页期漏/重 → T012 ｜ 港股锚混排不判故障 → T005 · T007 · T008

**8/8**。

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

以下五项**故意不做**，不是遗漏，下次 analyze 不要当缺口补 task：

1. **港股 / A 股实时** —— spec 明确 out of scope；路由槽留空 fail-closed 就是它的全部实现。
2. **alert 的 cn 实时源收编** —— ADR-0054 #2 已 fired，但被账号权限挡着（futu 无 A 股权限），归后续 feature。本片对它的唯一动作是 T005 的「diff 为空」断言。
3. **盘前 / 盘后 / 夜盘三族价格** —— spec FR-020 明写只取常规时段 `last_price`；三族登记但不消费。要不要呈现盘后价是独立产品决策。
4. **实时行情落库存历史** —— spec FR-019 明禁；历史归 `daily_bar`。盘中链历史是另一件事，已在设计源里登记为独立 backlog。
5. 🆕 **档位的视觉呈现** —— spec FR-009 已收窄为「只进接口、界面只以 `asOf` 粒度表达」（2026-08-17 analyze 阶段由 user 拍板）。这不是省事，是**本片 mockup 豁免的前提**：档位一上屏就有视觉形态要定，Constitution §I 的 mockup 闸随即适用。将来要上屏 → **先补 mockup 步**。

## 单 PR 与上线顺序

shim 侧（T002）与 mono 侧（其余）**同一个 PR**，但走两条部署链：

1. PR 合入 → shim 部署链跑（`services/futu-shim/**`）
2. mono app 部署链后跑

⇒ 存在一段窗口：mono 已上线但 shim 的 `/market-state` 尚未就绪 ⇒ **tick 会 fail-closed 停采并计失败计数**。这是**已知且自愈的**（`state_branch` 4 正是这条路径），表现为窗口内雷达恒收盘档 —— 与上线前行为一致，**无用户可感知回归**。

🚨 **但 T018 的端到端实证必须等两条链都完成**，且要挑一个**美股交易日**的盘中时段跑（北京 21:30 之后）。
