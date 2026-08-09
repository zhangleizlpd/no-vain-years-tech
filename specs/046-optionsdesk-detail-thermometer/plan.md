---
feature_id: 046-optionsdesk-detail-thermometer
spec_ref: ./spec.md
status: drafted
created_at: 2026-08-02
updated_at: 2026-08-03
adr_refs: [ADR-0024, ADR-0032, ADR-0040, ADR-0043, ADR-0047, ADR-0048, ADR-0053, ADR-0062]
context7_verified: []
---

# Implementation Plan: 046-optionsdesk-detail-thermometer（optionsdesk M2a — 标的详情上半 + 波动温度计）

> **PROSE-ONLY**。数据模型 SoT = `apps/server/prisma/schema.prisma`；API 面 SoT = `@nestjs/swagger` 装饰器（code-first）。**不镜像**任一进本文，设计意图写在 Architecture Notes。
> **Spec**: [`spec.md`](./spec.md) ｜ **Mockup baseline**: [`design/handoff.md`](./design/handoff.md)（10 帧）｜ **需求 SoT**: [p1 §5 P2/P7](../../docs/private/plans/2026-07/07-23-sellput-viz-p1-requirements.md) ｜ **数据架构 SoT**: [p3b](../../docs/private/plans/2026-07/07-30-sellput-viz-p3b-data-architecture.md) §2.2 / §4.4 / §4.5 / §4.7 ｜ **前片**: [045](../045-optionsdesk-anchors-radar/plan.md)

## Summary *(mandatory)*

把 M1 雷达点进去之后的那一屏做出来（锚卡 + 个股温度计区块 + 区间时序）并把雷达题头 🌡 的「即将可用」接到真的 P7 温度计页；**同时自建本片消费的两条标的级数据管道**（`underlying_iv_daily` 走富途 shim、`us_index_daily` 走 CBOE 官方历史 CSV）。读端是 optionsdesk 的两个新聚合端点（Q7-B 跨 ctx 只读直查 marketdata 新表）；**价格序列不走 optionsdesk** —— 客户端直接消费 marketdata 既有 bars 端点，optionsdesk 零复权代码。全片 EOD 档 + 显式 `asOf`，零盘中实时路径。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

**零新第三方运行时依赖是硬指标**（SC-007）。三处最可能破防的地方各自定案：

- **图表绘制**不引任何图表库。价格折线与 VIX 表盘弧走 **`react-native-svg`（仓内已装）**；四区间背景带与 IVP 分段条走纯 `View` 组合（045 先例：`zone-band.tsx` 的四区间色带就是纯 `View`）。锚点：`apps/mobile/src/chat/chat-drawer.tsx:18` 已 `import` `react-native-svg`，`apps/mobile/package.json` 有该依赖（`15.12.1`）。
- **CSV 解析**不引 `csv-parse` / `papaparse`。CBOE 两个文件是**定长列的规整 CSV**（`DATE,OPEN,HIGH,LOW,CLOSE` / `DATE,VVIX`，无引号包裹、无嵌入逗号 —— 2026-08-02 在 77 上实拉首尾行核过），`split('\n')` + `split(',')` 足够，且必须自己控制**非法行的处置语义**（跳过并计数，而非静默丢）。引库反而把这段语义藏起来。
- **降采样**不引任何库 —— 见 spec FR-009 的 🚨：聚合走 marketdata bars 端点既有的 `period`，**MUST NOT** 用 LTTB 类视觉近似。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles, OR every violation is justified in the Complexity Tracking table below.

| 原则 | 本片如何满足 |
| --- | --- |
| **§I SDD** | spec → clarify（两轮 + clarify 共 15 问）→ **Mockup**（10 帧，`64cae548`，UI feature 强制步已走）→ **plan（本文）** → tasks → analyze → implement，卡点不跳 |
| **§II TDD** | 派生复用 045 已测纯函数；本片新增纯函数（CSV 解析、IVP 分位自算、双算差判定、窗口→粒度映射）先测后写；两个新维度与两个读端走 **Medium IT（`*.it.spec.ts` + 共享 PG 入口）**，真 vendor 单列 **Large（`*.vendor.spec.ts`，默认 skip）**。**shim 侧 Python 有自己的 pytest 套件**（`services/futu-shim/tests/`，32 单测先例） |
| **§III Atomic** | 每 task 30min-2h + 各自 commit；每 2-3 个强关联 task 一个 clear 检查点批次 |
| **§IV Module Boundary** | 新表与采集**全在 `marketdata`**（市场事实，p3b §4.5）；optionsdesk **只读直查** + `CROSS-CONTEXT-READ` 注释（Q7-B），禁 `@Inject()` marketdata use case（Q7-C）；两 ctx 均**扁平内构 + 贫血 + 无 repository** |
| **§V PR 边界** | 跨端 feature ⇒ server impl + IT + api-client regen + mobile 消费 + 两层验证**全部同 PR 原子 merge** |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（**共享 PG**，`setupIsolatedDb()` / schema 那条走 `setupEmptyDb()`；**禁自起 Testcontainers**，per `docs/conventions/testing.md` §4 步 3）覆盖每个新端点至少一次 —— 详情读端 / 温度计读端各一条；两条 IT 内**塞真行**（us `Instrument` + `Anchor` + 三张新表的种子行）验真落库读通。采集侧另有独立 IT：工作集只覆盖有锚标的、同日重跑幂等、`his_volatility` 分页边界不重不漏、CBOE CSV 非法行跳过并计数。**不依赖任何 vendor**（vendor 侧归 **Large 档**，扩既有 `marketdata.futu-shim.vendor.spec.ts` 并复用其 `RUN_MARKETDATA_IT` 门，默认 skip、CI 够不着 —— 同 `us_equity_bar` 先例）。
- [x] **Mobile / Web**: 每条 P1 user story 走 golden-path —— US1 详情三块 + 四种降级态、US2 温度计四态、US3 采集（无 UI，由 server IT 承担）。**US4 的 markets OFF 态走 `nx run mobile:e2e-public`（公开版 bundle），断言必须写进 `markets-feature-gate.spec.ts`**（045 同款；写别处等于在 ON bundle 下跑，永远验不到 OFF 且不会红）。
- **Evidence**: 待 impl 期回填（本 gate 在 plan 期声明覆盖面，证据随 tasks ship）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A — 本片零新第三方包 / SDK / 工具**（见 § Dependencies 三处防破防定案）。新增的是**两个外部数据源**（富途 `overview`/`his_volatility` 经已有 shim、CBOE 官方历史 CSV），二者都不带新 npm/pip 依赖：shim 侧用已在用的 `futu` SDK，server 侧用内建 `fetch` + 手写解析。**数据源本身的调研已在 p3/p3b 完成**（富途口径采纳声明 p3 §9-1；CBOE 合规与源可用性 p3b §2.2 / E1 / E2 / E24 / E27，加本片 2026-08-02 在 77 上的直连实测）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native.** `optionsdesk` 是 2026-07-31 新定名的 context（ADR-0062），无 meta-repo（Java/Spring）前身；`marketdata` 侧改动全部挂在既有 mono 实现上。本片引用的既有代码锚点已 `ls` / `grep` 实证存在（`anchor.rules.ts` / `dimension-executor.ts` / `anchor-driven-sync-gate.ts` / `marketdata.controller.ts:228` / `services/futu-shim/src/futu_shim/app.py` / `zone-band.tsx`）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| **ADR-0053** | sunset_trigger #2：「第二个 ctx 申请 import 他 ctx 的 `*.rules.ts` → 重审是否升级为共享 package」 | **accepted-as-is（未命中）** | 045 plan 把「详情要画历史序列需读时复权」登记为本 trigger 的绊线，`67a7e34a` 已转 ESLint 硬拦。**本片 spec Q1 选了客户端两端点合成** ⇒ optionsdesk **不 import** `adjusted-bars.rules.ts`，绊线不触发、allowlist 不动。⚠️ **绊线原样保留**：将来若把序列读搬进 optionsdesk 端点，lint 会红，那次改 allowlist 就是 trigger 的触发点。查证记录（含 `packages/` 路线为何在本仓物理不可行）见 spec § Clarifications Q1 |
| **ADR-0048** | sunset_trigger #2：「出现必须 server 端强一致同步读 marketdata 的场景（下单校验需实时价）→ 跨层方向假设失效，重审」 | **accepted-as-is（未命中）** | 本片一律 EOD + 显式 `asOf`（FR-020 呈现面 / FR-033 禁盘中取数路径），读是 Q7-B 最终一致只读直查（FR-032）。命中条件不变：P3 许愿单触发判定需实时价，或盘中实时上线（等 V9） |
| **ADR-0062** | 本 ADR 的「跨 ctx 面清单」记的是 045 当时的读面 | **mitigated（需扩清单）** | optionsdesk 新增读 `marketdata` 的三张新表（IV 日快照 / IV 历史 / 指数日线）。**impl PR 内 amend ADR-0062 的跨 ctx 面清单**，每条标 Q7-B；boundaries 配置**无需改**（optionsdesk → marketdata 的读边 045 已开，本片不碰 `marketdata-rules` 那条禁令） |
| **ADR-0047** | vendor 端点授权面（东财 `robots.txt` 反爬那次立的纪律） | **accepted-as-is** | 本片新增两个 vendor 通路都在授权面内：富途 = 持牌 SDK；CBOE = 官方公开历史文件。⚠️ **CBOE 盘中报价端点在禁令面**（p3b E1/E24），plan 与 impl 均不得引入 —— 见下 D6 |

**Evidence**: `rg 'sunset_trigger' docs/adr/*.md` 逐条过；ADR-0062 amend 随 impl PR，编号无新增。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: narrowTestModule([<TheModule>]) }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。⚠️ **`narrowTestModule`（`test/_support/narrow-boot.ts`）是 2026-08-03 测试重构后的强制形态** —— 67 个 boot-`AppModule` IT 已全部收窄（`bbfa7420`，全量 wall 76→69s）；**别再整个 `AppModule` boot**。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支（**本片 32 条**），**必须**在 `tasks.md` 覆盖矩阵指定的那一层有对应 `it()` 块 —— server 行为分支落 **integration test**，纯呈现/交互分支落 **mobile logic spec 或 Playwright e2e**（UI 分支落不进 server IT，强求即造假覆盖）。100% 路径覆盖 — 不允许漏 cold-boot / 路由根 `/` 等非 happy-path 状态（PR #79 实证 4 层 cascade 始于一个未列状态分支）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
>
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase (use the Two-step Inspect+Commit saga only when caller validation must sit between read and write).

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：单行状态转换用 conditional UPDATE **affected-count**（`updateMany where {id,<前置>}` → count===1 won / 0 lost，READ COMMITTED）；**NEVER** 单行 `FOR UPDATE` / Serializable（偏索引 SSI 假冲突）。并发 insert 确需 Serializable 时 catch **P2002 + P2034 双形态**。outbox 事件 `publish(tx,…)` 与状态写**同 tx**。scheduler 逐行独立 tx。外部 I/O **split-tx**（禁 tx 内持锁等 HTTP）。→ `../../docs/conventions/server-impl-playbook.md`
- **前端（mobile）**：port 走 **Strangler-Fig**（复用 `~/theme` + `~/ui`、Orval 函数式 hook 非 class）；本片**无表单**（只读呈现），RHF 4 铁律不适用。→ `../../docs/conventions/mobile-impl-playbook.md`

---

### D1 · 两个新维度的工作集判据**不同** —— FR-026 对 `us_index_daily` 过度泛化了

spec **FR-026** 写「两个新维度的工作集 MUST 取自锚白名单（继承 `need_sync`）」。**这条对 `underlying_iv_daily` 成立，对 `us_index_daily` 不成立**，理由是它的论证前提（「否则工作集从 12 只炸到约 19,465 只」）只在**标的级**维度上存在：

| 维度 | 工作集性质 | 判据 |
| --- | --- | --- |
| `underlying_iv_daily` | **标的级** —— 逐票问 vendor | 走 `loadActiveInstruments`（已含 `need_sync = true`），**无锚不采**，加第 13 只锚零代码自动纳入（FR-031） |
| `us_index_daily` | **指数级** —— 固定 2 个代码（VIX / VVIX），与锚表无关 | **不查 `Instrument`、不走锚闸**。工作集 = 常量集合。零锚时它照常跑（mockup 帧⑩ 已按此画：「指数表盘不依赖锚」） |

⇒ impl 时 `us_index_daily` **不能**复用 `factExecutor` 那条「先 `loadActiveInstruments` 再逐票」的路径，否则零锚时它会静默不跑、且给它挂锚闸在语义上是错的。它更接近既有的 **meta 维度**形态。

✅ **spec 已按本表收窄（2026-08-02，user 拍板「指数表盘不依赖锚」）**：FR-026 收为标的级、新增 **FR-027** 明写指数维度不挂锚闸，`state_branches` 的采集工作集条拆成两条（标的级 / 指数级），依赖表对应行同步。本条不再是待办。

### D2 · 客户端两端点合成 —— optionsdesk 零复权代码

价格序列由 **mobile 直接调 marketdata 既有** `GET /api/v1/marketdata/instruments/{symbol}/bars?adjust=forward&period=…`（`marketdata.controller.ts:228`，已 ship）；optionsdesk 详情端点只返**锚派生 + 四区间边界 + 该票 IV 读数**。

- **optionsdesk MUST NOT** 实现或 import 任何复权换算 —— ADR-0053 绊线保持不触发（Gate 0.4）。
- 两侧**各带各的 `asOf`**，前端**分别**渲染新鲜度，且**两侧独立降级**（任一失败不整页失败，state_branch 已列，mockup 帧⑤ 已画）。
- 这条与业界 BFF 共识相反，**论证已写进 spec § Clarifications Q1**（前提差异三条 + HTTP/2 已开的实证锚 `ops/nginx/conf.d/mono.conf:32`）。impl / review 期若有人提「应该后端聚合」，先读那段再讨论。

### D3 · 窗口→粒度映射放**客户端**，聚合放 **marketdata**

`1Y=day / 3Y=week / 5Y=week / 10Y=month`（FR-009）是**呈现决策**，落 mobile 的一个纯函数（`window-granularity.rules.ts` 之类），输出直接喂 bars 端点的 `period` 参数。**server 侧零改动** —— 聚合能力 bars 端点已有。

- 该纯函数是**单测目标**（四档映射 + 未知档位的 fail-closed）。
- ⚠️ **禁在 optionsdesk 端点里重做一遍 period 聚合** —— 跨 ctx 调 marketdata 的 use case 是 Q7-C 明禁，自己重写一遍则是算法双写。

### D4 · IVP 双算对表落**采集侧告警面**，UI 恒显直读值

FR-034/035 的组合语义：

- **显示口径单源** = 富途 `overview` 直读值（`iv_percentile`）。界面标注一律「**富途标的聚合 IV**」，**禁写 IV30d**（p3 §9-1 采纳声明；本 spec clarify 期扫出并订正过一次 drift，别改回去）。
- **采集时**顺带由 `his_volatility` 序列自算一次分位，与直读值比对；差异分三档（≤2pp 静默 / 2–5pp WARN 进复核名单 / >5pp 硬门告警，阈值取 p3b §6.3 实测基线）。**结果只进告警面，不进 API 响应、不进 UI。**
- 自算是**纯函数**（排序 + 分位取值，O(n log n)），单测覆盖：窗口足 / 窗口不足（返回"不可算"而非 0）/ 边界值。
- **存在理由写进代码注释**：富途的聚合规则未文档化，它若悄悄改规则，这条核对是唯一能发现的信号。

### D5 · 三张新表的存储形态（设计意图，schema 是 SoT）

全部落 **`marketdata` schema**（市场事实，p3b §4.5），沿用既有纪律 **Decimal 禁 Float / 唯一键即幂等语义 / 时序表 `(标的, 日期)` 形态**：

- **标的级 IV 日快照** —— 键 `(instrument_id, date)`。存 vendor 直读的 iv / iv_rank / iv_percentile / 各档 hv。**这是 UI 读的那张表**。
- **标的级 IV 历史序列** —— 键 `(instrument_id, date)`。存 `his_volatility` 回填的 iv / hv / 标的价，供 IVP 自算与双算对表。与上表分开的理由：**采集节奏不同**（前者日更增量、后者首次拉满 3 年后只做尾部增量），且前者是 vendor 结论、后者是原始序列，混一张表会让「直读 vs 自算」的来源边界糊掉 —— 而那正好是 D4 要监控的东西。
- **指数日线** —— 键 `(index_code, date)`。VIX 有 OHLC 四列，**VVIX 只有 CLOSE** ⇒ 其余列 **nullable，禁填 0**（FR-025）。

### D6 · CBOE 采集：只走官方历史 CSV，从 **77 直连**

- **宿主 = 77 直连**，2026-08-02 实测：两个 CSV 均 HTTP 200（471 KB / 9,242 行 与 108 KB / 5,074 行，3.1s / 1.8s），末行都是上一交易日，行数比 p3b E2（07-29 拉）各多 2 行 = 恰好两个交易日 ⇒ 源是活的。**港机与 shim 不参与，shim 职责不扩张。**
- 🚨 **合规红线**：CBOE **盘中报价端点** `delayed_quotes/quotes/_VIX.json` / `_VVIX.json` **严禁进自动管道**（p3b E1/E24：站点级 Terms 明文禁复制/存储进电子检索系统，官方免费的只有历史文件）。**impl 期任何"顺手加个实时值"的念头都要停在这里。**
- **取数形态 = 全量文件 upsert**（文件才几百 KB，且是覆盖式历史文件，没有增量端点）。⇒ 幂等天然成立；`delta_lookback_days` 那套**不适用**（它是给区间型 vendor 接口设计的）。
- **解析纪律**：非法行 / 日期解析失败 **跳过并计数**，计数进 `SyncRun` 统计；**禁静默丢**。首行表头必须校验（表头变了就是 vendor 改格式，应当报错而不是把表头当数据）。

### D7 · shim 两个新端点：`/overview` + `/his-vol`

- 沿用 `services/futu-shim/` 既有形态（Flask + waitress，Bearer 鉴权，绑隧道虚 IP，按需拉起 OpenD + 空闲自停）。
- **限频按官方值**：`overview` 60 次/30s（≤500 codes 批量）、`his_volatility` 60 次/30s（**单次跨度 ≤364 天**）。⚠️ **别再犯 `/kline` 那次的错** —— 当初把它挂最严兜底限额且逐页计数，直接导致 08-01 回填事故（E38）。新端点的限频要**按端点各自的官方值配**，不是套一个全局最严值。
- **回填分页**：`his_volatility` 首次拉满约 3 年 ⇒ 按 ≤364 天窗口分页，**分页边界不得重复计入或漏日**（FR-024）。这是纯函数（窗口切分），单测覆盖边界。
- 🚨 **部署硬序**（`futu-opend-hk.md` + p3b E37 的教训）：**新维度上线前必须先确认 shim 端点已到位**。`us_equity_bar` 首跑 7/7 全 404，真因是 shim 被从不含 `/kline` 的分支部署覆盖 —— 部署产物与源码之间没有版本闸就必然出现「以为上线了、其实没有」。⇒ impl 期 shim 先部署 + `/healthz` 之外**实打端点**确认，再开维度。

### D8 · optionsdesk 两个读端（Q7-B 只读直查）

- 🚨 **两个读端都住 `apps/server/src/optionsdesk/` ⇒ 受 `check-optionsdesk-rule-constants.ts` 硬管**（#839，PR 门无条件全扫）：档位系数 `0.8` / `0.6` / `1.2` **只许出现在 `anchor.rules.ts`**，读端一律 `import` 常量。它们是**可调策略参数不是数学常数**，抄一处字面量 = 调参时静默漏改。这是 FR-003 的机器版。
- **详情读端**：入参 symbol → 读自己的 `Anchor`（派生复用 045 的 `anchor.rules.ts`，**禁重造**）+ **`CROSS-CONTEXT-READ`** 直查 marketdata 的 IV 日快照。返回锚卡字段 + 四区间边界 + IV 读数 + 各自 `asOf`。
- **温度计读端**：读全部 `Anchor` + 直查 IV 日快照（逐票）+ 直查指数日线（最新一期 VIX/VVIX）。**比值在 server 算但带基准判定** —— 两侧 `asOf` 不同日则**不计算**并返回显式标记（FR-016），**禁前端自己拿两个数相除**（那样每个消费方都要重新实现一次基准纪律）。
- `excluded` 的锚**照常出现在温度计列表**并带标记（045 语义：锚 = 采集意愿、`excluded` = 交易意愿）。
- 跨 ctx 读**只读、无写**；降级纪律照抄 `anchor-driven-sync-gate.ts` 的形态（读失败只 warn 不上抛）。

### D9 · mobile 侧：两个新屏 + 一处 045 改动

- **两个新屏**：标的详情（上半）、波动温度计。路由挂在 045 已建的 `optionsdesk-routes.ts` 下，随期权台 tab 一并受 markets 门控（**纯客户端门控**，与 045 同构：tab `href:null` + 路由级 guard；server 端不新增第二套）。⚠️ **OFF 态的真验只能落 `apps/mobile/e2e/markets-feature-gate.spec.ts`** —— `EXPO_PUBLIC_FEATURE_MARKETS` 是 Metro 打包期内联常量，换 bundle 才算真验；主 e2e config 反向 `testIgnore` 了该文件，两侧对称隔离。
- **一处 045 改动**：雷达题头 🌡 从灰置「即将可用」改为可点直达 P7（FR-021）。这是本片对 045 既有代码的**唯一**改动面。
- **图形**：区间时序 = `react-native-svg` 画折线 + 纯 `View` 画四区间背景带（复用 045 `zone-band.tsx` 的色带语义）；VIX 表盘 = `react-native-svg` 画三段弧 + 指针；IVP 分段条 = 纯 `View`，**四档边界 25 / 70 / 90**（FR-036，段宽 25/45/20/10），刻度标签对齐到同一组边界。
- 🚨 **P7 不呈现 `regime` 字段**（2026-08-03 analyze 复验拍板，spec FR-015 📌）—— vault §8 未给 N/X 的机械判据，且把它定性为「温度计的极致读数 + 人判 + 无 gate」。⚠️ **mockup 帧⑦ 画了 `regime N`，别照抄回来**（`design/` 是历史留痕，drift 不算 bug）；server DTO 里也不出该字段。
- **两个「本片无数据源」的字段，呈现态在此定死**（防 impl 期现编）：① 锚卡「当前仓位水位档」的输入（持仓规模）属 M3/M4 ⇒ 本片**恒呈现「未知 · 待接入」，禁显 0**；② 「持股时加显愿卖锚」同理 —— 持仓数据接入前该行**恒不出现**（即 state_branch #19 的「持股」半边本片不可达，只实现「未持股」半边）。③ 「提醒状态」徽标由 FR-036 档位**纯派生**，本片无发送链路（随提醒器后置 V9）。
- **mockup 的两处坑已在 baseline 里踩过、RN 侧别重蹈**（handoff 有记）：① 进度条类组件若给外层加 `overflow:hidden`，比槽高的位置标记会被整个裁掉 ② 表盘大数字与轴心/指针的位置要错开，否则轴心圆看着像小数点。

### D10 · 验证分层

> 每层照抄 [`golden-sample-registry.md`](../../docs/conventions/golden-sample-registry.md) §测试样板 的对应样板（#839 新增，size × 形态 逐格给了路径）；size 判据与七条不变量由 `.claude/rules/test-taxonomy-trigger.md` 在改测试文件时自动加载，本表不复述。

| 层 | 覆盖 |
| --- | --- |
| 纯函数单测 | CSV 解析（含非法行 / 表头变更）· IVP 自算分位（含窗口不足）· 双算差三档判定 · `his_volatility` 分页窗口切分 · 窗口→粒度映射 · 表盘角度/弧几何 |
| server IT（Medium，`*.it.spec.ts` + **共享 PG**） | 两个读端各一条真落库读通 · 采集工作集只覆盖有锚标的 · 同日重跑幂等 · `us_index_daily` 零锚照常跑（D1）· vendor 不可达时记失败且不破坏历史 · 业务日期 A′ 按 us 时区 |
| server 真 vendor（Large，`*.vendor.spec.ts`） | 富途 `overview` / `his_volatility` 真端点连通 + 12 只锚单轮墙钟（SC-005）。**扩既有 `marketdata.futu-shim.vendor.spec.ts`**（同一 shim，复用其 `RUN_MARKETDATA_IT` + `FUTU_SHIM_URL/TOKEN` 门，不新造 flag）。无 workflow 设置该 env ⇒ **恒 skip、不构成绿灯证据**，且跑一次会拉起 OpenD 收走行情权约 10 分钟 |
| shim pytest | 两个新端点的参数校验 / 限频 / 分页到尽（沿 `services/futu-shim/tests/` 32 单测形态） |
| `[Mobile-E2E]` hermetic（Medium） | 详情四种降级态 · 温度计四态 · 窗口切换 · **两条文案断言**（「不构成开仓理由」常驻非折叠 FR-019 / 雷达题头 🌡 无「即将可用」FR-021 —— e2e 是这两条唯一的机械载体）→ `optionsdesk-detail-thermometer.spec.ts`。**markets OFF 拦截另落 `markets-feature-gate.spec.ts`**（`playwright.markets-off.config.ts` 的 `testMatch` 锁死该单文件），跑 `nx run mobile:e2e-public` |
| `[Contract-Smoke]` | 生成的 `@nvy/api-client` 打 testcontainers 真 server，验两个读端契约对齐 + 真落库 |

## Complexity Tracking

> 无 Constitution 违规，本表为空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| （无） | — | — |

<!-- BEGIN auto-generated: performance-budget (from spec.md frontmatter; do not edit) -->

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) |
| --- | ---: | ---: |
| `GET /api/v1/optionsdesk/underlyings/{symbol}` | 40 | 80 |
| `GET /api/v1/optionsdesk/thermometer` | 50 | 100 |

_Edit `perf_budgets:` in spec.md frontmatter to change. Regenerate this block with `pnpm tsx scripts/checks/plan-compiler.ts <spec-dir>`._

<!-- END auto-generated: performance-budget -->
