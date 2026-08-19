---
feature_id: 064-optionsdesk-intraday-leg-quotes
spec_ref: ./spec.md
status: approved
created_at: '2026-08-19'
updated_at: '2026-08-19'
adr_refs: ['0032', '0040', '0043', '0048', '0053', '0062', '0064', '0066']
context7_verified: []
---

# Implementation Plan: 美股期权腿盘中实时报价

## Summary *(mandatory)*

`optionsdesk` 在 `loadChain` 尾部挂一个**可空的 overlay**，用此刻的报价覆盖库内收盘档的 7 列 + 链级现价，让候选集与呈现同时走实时口径。**零落库、零新表、零采集维度、零新端点、零新 adapter** —— 取数复用 047 就建好的 `OptionSnapshotPort`（它的出参已含 p2 要的全部列**以及标的自身那行**），只在 `marketdata` 加一个**读取口 token** 把它按读意图暴露出去；`priceKind` 与单批上限均复用既有常量。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

🔗 **前置已单独 ship**：shim 信封三道闸的单点化（`futu-shim-envelope.ts`）走 PR #116 独立合入并**已在 main**（`a626728e`） —— 那是 047 与 061 之间的**既有**重复，与本片正交；本片不再产生第三份（见 D1/D2）。

本片**零新依赖**：传输层复用 `apps/server/src/marketdata/vendor-http-client.ts`（061 已在用，Node 22 global `fetch`/undici，自发 `accept-encoding: gzip` 并透明解压 —— 该行为已由 quote-layering master §8 在本机 v22.22.3 与 prod 镜像 v22.23.2 各起一个 HTTP server 对拍实证）；shim 侧 gzip 由 p0（#88 / `31ae5181`）ship，线上复验 285 codes **6.86 s → 0.35 s**。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

逐条：

1. **§I SDD + mockup-first** —— specify → clarify（4 问）→ **Mockup（8 帧 / 2 文件，已 ship 到 `nvy/optionsdesk`，六项探测全 0）** → plan。UI feature 的 mockup 卡点已过，未跳步。
2. **§II TDD** —— 每 task 红→绿→typecheck/lint→`[X]`→commit。本片的 `state_branches` 有 14 条，逐条对应 `it()`（见下 Testing Invariants）。
3. **§III 原子 task** —— 见 `/speckit-tasks`，按 D1–D11 切，每条 30min–2h。
4. **§IV 模块边界** —— 新增物只有一个**读取口 token**（沿用既有 `OptionSnapshotPort` interface），落 `marketdata`（vendor 接入面的既有归属），`optionsdesk` 经 DI 注入。**方向仍单向无环**：`marketdata` 不知道 `optionsdesk` 存在，是消费方主动拉。无 `tx.<otherTable>.*`；无新 repository；判据落 `*.rules.ts` 纯函数；零 class。
5. **§V 类型同步链 + 单 PR** —— 本片是跨端 feature（server + mobile）⇒ **单 PR 原子 merge**，含 server impl + IT + `api-client` regen + mobile 消费 + 两层验证（hermetic UI e2e + 契约冒烟）。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 本片**零新端点**，但改了 `GET underlyings/{symbol}/legs` 与 `.../chain-report` 两个既有端点的返回内容 ⇒ real-boot smoke（Testcontainers PG + Redis）必须覆盖这两条，且**必须同时覆盖 overlay 关 / 开两态**（关态断言与上线前逐字节相同 = FR-016 / SC-005）。
- [x] **Mobile / Web**: US1（P1）golden path 走 Playwright Expo Web；**实时段内的真实跳动、收盘那一刻的切换、与真源的数值一致性**三类 web 验不到，MUST 美股盘中真机验（已写进 spec `web_compat_notes`）。
- [x] **Evidence**: 待 impl 期回填 —— server IT 文件路径 + 真机截图。真 vendor 那条走 `RUN_MARKETDATA_IT=true` 的 env-gated 用例，**手动跑一次并把输出贴进 tasks**（该门恒 skip，「测试全绿」对真契约不构成证据）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A —— 本片零新第三方包 / SDK / 工具**。传输层、限频桶、信封解析全部复用 061 已 ship 的既有面（`vendor-http-client.ts` + `futu-shim.constraint-profile.ts`）。

**Evidence**: N/A

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A —— 本 feature 是 mono-native**：`optionsdesk` 是第 10 个 bounded context（ADR-0062），自 045 起就生在 mono 里，从未存在于旧 meta-repo 的 Java/Spring 形态。所触及的 `marketdata` 实时面由 061（2026-08）新建。

- [x] **Evidence**: `rg -l 'mbw-|org\.springframework|org\.mapstruct' apps/server/src/optionsdesk apps/server/src/marketdata` → 零命中（impl 期复跑并回填）

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0062 #1 | 「盘中实时 spot 上线 → 跨 ctx 读形态从最终一致 Q7-B 只读直查升格为强一致同步读」 | **accepted-as-is** | **061 已命中并 amend**（061 plan Gate 0.4 判 `mitigated`，ADR §3 跨 ctx 面已新增强一致同步读边）。p2 是**同一条边的第二个消费者**，形态不变（DI marketdata 的 port token、只读、单向无环）⇒ 不重开重审，只在 impl 期把新 port 名补进该 ADR 的跨 ctx 面清单 |
| ADR-0048 #2 | 「出现必须 server 端强一致同步读 marketdata 的场景 → 跨层方向假设失效」 | **accepted-as-is** | 同上，061 已处置。p2 不引入新形态：仍是**只读同步调用**，**不是**跨 ctx 写 |
| ADR-0066 #3 | 「未来若接入有夜盘 / 跨日滚动交易日的市场，`exchangeCalendarDate` 的『当地日历日』假设会失效」 | **accepted-as-is** | 未命中：本片只覆盖**美股常规交易时段**（`REGULAR_SESSION_STATES = {MORNING, AFTERNOON}` 白名单，061 已落），盘前/盘后/夜盘一律不外呼。美股期权本就只在常规时段交易 ⇒ 假设成立 |

⚠️ **扫过但未命中的三条**（写下来免得下次 analyze 又当缺口）：

- **ADR-0053 #2**（「第二个 ctx import 他 ctx 的 `*.rules.ts` → 重审升共享 package」）—— 未命中：本片跨 ctx 拿的是 **port token + interface**，不是 `marketdata/*.rules.ts` 纯函数。`eslint.config.mjs` 里 `from: optionsdesk` 的 `disallow` 含 `marketdata-rules` 那条禁令**一个字不动**。🚨 若 impl 期撞到这条 lint 红，正确动作是**把逻辑推回 adapter 侧**，**不是**改 allowlist —— 改了会让本判定当场失效。
- **ADR-0032 新 ctx 评估** —— 未命中：新增的 token 落**既有的** `marketdata`，不新建 bounded context。
- **ADR-0066 #1 / #2**（hk 半日市日历源 / `sync_run` 写入行数）—— 未命中：本片零 hk、零落库、零 `sync_run`。

**逐条核实命令**：`rg -n '^## Open Questions' -A 12 docs/adr/00{32,43,48,53,62,64,66}-*.md`

**Evidence**: ADR-0062 跨 ctx 面清单补一行（impl 期，docs-only 改动）

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 —— 本片 **14 条**，一条不许漏。

🚨 **本片额外一条硬门**：`state_branch` 第 2 条（「调用方未显式开启实时 → vendor 请求次数 MUST = 0」）与 SC-005（「结果与上线前逐字节相同」）**必须由一条专门的 IT 断言**，且断言方式是**对 port 的调用计数 = 0**，不是「看起来没变」。这条是 FR-015/FR-016 的唯一机器判据。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
>
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase / port.

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：本片**零写库** ⇒ 无事务面。⚠️ 但这不等于没有并发问题：overlay 是**请求内的一次外呼**，MUST 走 split-tx 心智 —— 任何情况下**禁在 Prisma 事务里等这个 HTTP**（本片根本不该开事务）。→ `../../docs/conventions/server-impl-playbook.md`
- **安全**：本片不碰凭证 / PII / 鉴权分支。既有 `JwtAuthGuard` + `AccountIdThrottlerGuard` 类级守卫**一行不动**。
- **前端（mobile）**：port 走 **Strangler-Fig**（复用 `~/theme` + `~/ui`、Orval 函数式 hook 非 class）；🚨 **`useMutation`/`useQuery` 返回对象的 identity 每 render 变，进 `useCallback` 依赖 = 自激风暴**，只解构要用的方法。→ `../../docs/conventions/mobile-impl-playbook.md`

### 本片的设计决策（D1–D11）

#### D1 —— 取数**复用 `OptionSnapshotPort`**，只加一个「读取口」token

🔑 **实证事实（plan 期核出，推翻了本节的初稿）**：`OptionSnapshotPort.getSnapshots({ underlyingSymbol, contractCodes })` 的出参 `OptionSnapshotRow` **已经含 p2 要的全部东西**：

| p2 要的 | 该 port 给不给 |
| --- | --- |
| `bid` `ask` `bidSize` `askSize` `delta` `iv` `volume` | ✅ 全有（另有 gamma / vega / theta / rho / last / turnover / `vendorUpdateTime` 等本片不消费的列，白拿） |
| **同刻的标的现价** | ✅ —— `isOption: false` 那一行，port doc 逐字：「**返回行含标的自身那行**」 |
| 信封 `asOf` | ✅ `OptionSnapshotBatch.asOf` |
| 入参键 = `option_contract.code` | ✅ doc 逐字：「正是 `option_contract.code` 落库的口径」 |

⇒ **不新建 port interface、不新建 adapter 类。** 初稿里的 `REALTIME_LEG_QUOTE_PORT` 是在为一个已经存在的能力重造一遍。

📌 **本片刻意不镜像 063 Phase 3.4 的「证据列」规矩**（`d114e199` 给 `anchor` 加了 `intraday_vendor_update_time`，让 vendor 滞后可复算、可监控漂移）。那条规矩是为**落库列**立的 ——「事后无法复算正是当时的痛点」—— 而本片零落库，没有留证据的地方；且 FR-002 的原则本来就是「覆盖没有读者的值只是无收益的成本」。⇒ 腿侧的滞后分布目前只在港股测过一次，将来真要监控它，得先有消费方与一条 FR，**不在本片**。下次 analyze 别把它当缺口。

🚨 **但不能直接注入 `OPTION_SNAPSHOT_PORT`** —— 它经 `collectionPort()` helper 注册，是**采集口**语义：`kind: mock`（dev/test 零 env）下绑的是**拒绝壳，调用即抛**，理由写在 `marketdata.module.ts`：「采集口的产出**必然被持久化**（逐 port 核过 consumer，全是写手），故 mock 下必须拒绝而不是给 fixture —— 否则伪造行情与真行情同形落进真表」。

而 p2 是**读取路径、零落库**（FR-019）。直接复用那个 token 会让「逐 port 核过 consumer，全是写手」变成假话，054 建立的意图分类（采集口 / 读取口 / 搜索口）就此失去依据 —— **这不是会报错的问题，是把一条结构性保证降级成一句过期注释**。

⇒ **加一个读取口 token**，接口沿用 `OptionSnapshotPort`，provider **不走 `collectionPort`**，`useFactory` 返回**同一个 `FutuOptionSnapshotAdapter` 实例**：

```text
OPTION_SNAPSHOT_PORT        采集口 · collectionPort() · mock→拒绝壳    ← 047，一行不动
OPTION_SNAPSHOT_READ_PORT   读取口 · 裸 provider      · mock→显式降级  ← 本片新增
                                     └── 同一个 VendorHttpClient 实例
```

一次拿到六件事：不动 061 已 ship 的 adapter · 零 envelope 抽取 · 零新 adapter 类 · 054 意图分类结构性保住 · dev/test 下选约表恒收盘档（想要的行为，而非抛） · 429/400 的具名错误映射白拿。

🚨 **`useFactory` MUST 返回同一个实例，MUST NOT 新 `new` 一个** —— shim 侧限频是 per-capability 单桶，而客户端**每个 `VendorHttpClient` 实例各持一个令牌桶**；多起一个 = 上游允许值的 2 倍，撞 429。这条不是理论风险，`futu-shim.constraint-profile.ts` 记着同一病灶在 prod 上让链发现每 30 分钟顺延一次、12 只锚永远只采到前 2 只。

#### D2 —— 信封解析：**本片零新增**（已由 PR #116 独立收口）

初稿要求把 `/option-snapshot` 的信封解析抽成共享单点。**该做的事仍然成立，但它不属于本片** ——

1. 它是 047 与 061 之间的**既有**重复（实测闸① 8 份 / 闸② 7 份 / 闸③ 2 份），与 p2 无关；
2. D1 之后 p2 **不再产生第三份**（它经 port 拿数据，压根不碰信封）。

⇒ 已作为独立 refactor 走 **PR #116** ship 并**已合入 main**（`a626728e`，2026-08-19；5 个 adapter 收成 1 个单点，零行为变化，server 全量 457/4944 绿）。本片**一行不动** vendor 接入面。

📌 留一条给 impl 期的绊线：若届时发现自己在写第二处 `res?.rows` / `as_of` 解析，**说明走错了路** —— 正确路径是经 `OPTION_SNAPSHOT_READ_PORT` 拿已解析好的 `OptionSnapshotBatch`。
#### D3 —— 熔断**不在 p2 侧新建**，它经「定窗基准陈旧」自然传导

061 的熔断住在 tick（`sync-anchor-intraday.ts`），口径单点 `classifyTickSource`，阈值 `INTRADAY_CIRCUIT_THRESHOLD = 3`。它保护的是**每 30 秒一拍的 scheduler**，不是按需触发的读路径。

🔑 **传导链**（本片不写一行熔断代码即成立）：

```text
tick 熔断打开 → 停写 anchor.intraday_price / intraday_at
             → 90 秒后 isIntradayFresh() 判假
             → p2 的定窗基准不可用
             → 按 spec Edge「定窗基准本身不可用」整体回落收盘档并标降级
```

⇒ **p2 零熔断代码，且与 tick 共享同一个判据**。p2 自己只需一个请求级超时（FR-011 的「源不可达 / 超时」那半）。

✅ **spec 措辞已据此收窄**（2026-08-19 analyze 落地）：`state_branch` 4 / FR-011 / US1-AS4 三处的「熔断」全部改为「超时」，并在 FR-011 下加了一条 📌 说明上游熔断落在「定窗基准不可用」那条路径、以及**为什么不能与前四类合并**。⇒ impl 期读 spec 不会再看到「熔断」二字而误建 breaker。

📌 **顺带：本片对半日市结构性免疫**（063 Phase 2b `c342babb` 落地后核过）。上游把 session 收盘时刻做成了逐 session 的数据（NYSE `2026-11-27` / `2026-12-24` 13:00 ET、HKEX `2026-12-24` 12:00 HKT），`sessionWatermark` / `isSessionComplete` 因此改了签名 —— **本片一个都不用**；直接依赖的 `exchangeCalendarDate` / `daysToExpiry` / `TradingCalendarPort.classify` 三个符号签名一字未变。根因是 061 的 D7 拍了「时段判定读 vendor 自报的市场状态」而非硬编码时段表：半日市当天 13:00 ET 一到，vendor 自己就翻非 REGULAR，本片停止外呼，**不需要知道半日市这回事**。⇒ 将来给本片「加半日市支持」是**不需要的工作**，别做。

#### D4 —— 窗的派生落 `optionsdesk/leg-window.rules.ts`，签名 `legWindowFor(market, spot)`

由 `leg-recall.rules.ts` 的常量**派生**，禁手写第二份数（`scripts/checks/check-optionsdesk-rule-constants.ts` 的 050 不变量 #2 会按子串扫被禁字面量）。

- DTE 段 = `[min(BUILD_RECALL_DTE.min, RENT_RECALL_DTE.min), max(…max)]`，当前解出 `[1, 365]`。
- 类型 = `PUT`；标准性 = `is_standard`（047 FR-008）。
- **strike 上下界 `[0.7, 1.05]` 是包络，不是等价**。🚨 它**不能**从 `PREMIUM_FLOOR` 精确反解 —— 那是 `max(spot × 0.0018, 0.20)` 的**动态**门槛（`leg-recall.rules.ts:244`）。⇒ 这两个数在代码里必须带注释显式声明为「带余量的包络」，并由 **FR-007 的绊线守卫**兜住：若某腿被窗排除、却能通过召回判据 → 告警。

🚨 **单批上限用 `OPTION_SNAPSHOT_MAX_CONTRACT_CODES = 399`**（`option-snapshot.port.ts:47`）。

初稿写的 `REALTIME_QUOTE_MAX_SYMBOLS = 400` 是**错的常量** —— 那是正股口的。期权口是 `OPTION_SNAPSHOT_MAX_CODES(400) - 1`，**减掉的那 1 就是标的自身那行的槽位**。这个差值不是凑数：用 400 去切批会让每批多带一个 code，撞 shim 的 400 上限而整批被拒。ACN 的 285 仍远在其下。🚫 MUST NOT 在 `optionsdesk` 再写一个 399 或 400。

**`market` 入参本片只传 `'us'`** —— 预埋是为了 p4 把阈值改成 per-market 表时**只加数据不改结构**（同 061 §4.5 的 tick 分组预埋，一个道理）。零额外成本。

#### D5 —— 两个标的现价，职责分离，**禁合并**

| | 定窗基准 | 判据与呈现的现价 |
| --- | --- | --- |
| 来源 | `anchor.intraday_price`（optionsdesk 自有列，本 ctx 直读，无跨 ctx） | `OptionSnapshotBatch.rows` 里 `isOption: false` 的那一行 |
| 时效 | 可滞后一个 tick（≤30 s），由 `isIntradayFresh()` 判可用性 | 与腿报价**同刻**（同一次调用、同一个 `asOf`） |
| 为什么 | 窗只是个包络，容得下一拍滞后；且**必须先有它才能构造 `contractCodes`** | 判据吃的数与呈现的数必须同刻，否则「按此刻筛」这句话不成立 |

📌 **「把标的并进同一批」不是本片要实现的事** —— `getSnapshots` 内部已承担（入参只给 `underlyingSymbol` + `contractCodes`，adapter 自己翻成 vendor code 并入同一批）。⇒ SC-003 的「一次页面加载 = 1 次外呼」是**结构自带**的，不靠调用方自律。


#### D6 —— overlay 插在 `loadChain` **尾部**，且是**可空依赖**

`PrismaLegRetrievalAdapter` 收一个可空的 `OPTION_SNAPSHOT_READ_PORT`（D1）；为 null（或 query 标志为 false）时行为与今天**逐字节相同**。

**为什么是 `loadChain` 而不是包一层 adapter**：它是 `retrieveCandidates` 与 `retrieveChain` 的**共同根**（055 T005 抽它出来的理由原文：「让『候选集与整条链读的是同一批行』成为结构保证」）。插这里 ⇒ 两个 port 方法自动一致（FR-017），且 `recallCandidates` 的调用点**仍然只有一个** —— 该文件头上那条纪律写着「在这里补一条 `filter` 就等于给召回开了第二个判据点，而它**不会红**」。

**开关**：`LegRetrievalQuery` / `LegChainQuery` 各加一个显式布尔，**默认 false**（FR-015 fail-closed）。🚫 MUST NOT 从鉴权状态 / 请求来源隐式推断。今天只有 authed controller 传 true；**将来新增任何读路径，它默认就是不外呼的**。

#### D7 —— `priceKind` **复用既有类型，零新增**

`marketdata/marketdata.types.ts:29` 已有 `PriceKind = 'eod_close' | 'realtime'` + `PRICE_KINDS` 运行时值域，且 `optionsdesk.dto.ts:24` **已经在 import 它**（锚卡的 `priceKind` 字段在 `:630`）。

⇒ 腿级档位与链级档位**直接用它**。🚫 **禁新造第二套枚举** —— 两套枚举会让「实时」这个词在同一个响应里有两个来源。

链级时间沿用既有 `LegChainMeta.quoteAsOf`：实时档下它是本批的 `capturedAt`，收盘档下是库内值。⚠️ **DTO 侧已有一条现成纪律**（`optionsdesk.dto.ts:87`：「日历日 vs 时刻，混成一种会让『数据截至 X · 收盘』的 asOf 呈现出错」）—— 本片的两档正是那条纪律的第二个实例，照它走。

#### D8 —— OI 三列的保留是**结构性的**，不靠代码纪律

`openInterest` / `netOpenInterest` / `oiAsOf` **根本不出现在 `RealtimeLegQuote` 的返回类型里** ⇒ overlay 结构上不可能覆盖它们。

🚫 **MUST NOT** 为了「对称」把 OI 加进 port 的返回类型再在 overlay 里跳过它 —— 那把一条编译期保证降级成一条注释。依据：OI 盘中冻结（实测 + 富途官方文档「美股期权 OI 在盘前时段更新」），盘中取回的与库内是同一个数。

#### D9 —— 成员变化的 diff 在**客户端**

服务端无状态、不持有「客户端上一轮看到了哪些腿」⇒ 差集只能在 mobile 侧算（持有上一次的 `code` 集合）。

服务端的责任只有一条：保证**同一次响应内**成员与报价来自同一批（FR-017 / FR-022）。🚫 MUST NOT 为此在服务端引入会话态。

#### D10 —— mobile 呈现三件套（mockup 已定，`design/` 有 8 帧 baseline）

- **区块级档位条**：实时档呈**时刻含秒** + 品牌蓝；收盘档呈**交易日** + 中性灰；降级 / 未就绪走 `--nvy-warning-soft` 底 + 3px `--nvy-warning` 左边框 + `--nvy-text` 正文。
- **行级档位标**：收盘行的 bid/ask 数字降 `--nvy-text-muted`，冻结列行权价旁挂一枚「收」角标（复用 053 的 `贴合`/`月` badge 视觉，**不新建组件、不新开一列**）。
- **成员变化条**：中性 `--nvy-surface-sunken`。🚨 **MUST NOT 用 `--nvy-info`** —— 本 DS 里 `--nvy-info` **就是** `--nvy-primary`（`info-soft` = `primary-soft`），用它会和实时档撞脸。
- **等待与刷新**：首屏阻塞到齐再渲染（**不先出收盘档**）；刷新期间**保留当前表**、不遮罩不置灰。
- 🚨 **`--nvy-quote-up` / `--nvy-quote-down` 本片一处不用** —— 档位不是涨跌方向，误用会让「实时」被读成「涨」。
- 表格骨架（视角 Tab / 冻结列 / 11 列横滑 / 条件抽屉）由 053 + 056 定稿，**本片一行不改**。

#### D11 —— FR-023 的留痕面

本片**特有**的三类失败各落一条结构化 warn，带可聚合的类别字段：`partial_miss`（部分合约未返回，带缺失条数）/ `window_over_cap`（候选范围超单批上限）/ `window_basis_stale`（定窗基准陈旧或缺失）。

🚨 **通道级健康不由本片回答** —— 复用 061 的观测面。理由是判据本身：本片**按需触发**，「没人看就没数据」的指标当哨兵会误导；061 的 tick 每 30 秒主动探一次，它才是这条通道的哨兵。

### 分批：本片**不实装**（US3 = P3）

现有 13 只美股锚窗内数最大 **285**，全部 ≤ 400 ⇒ 今天零触发。本片只落**约束与守卫**：窗超上限时按 `window_over_cap` 留痕并**整体回落收盘档**（fail-closed），🚫 **MUST NOT** 悄悄截断到前 400 条 —— 那会让候选集少一截而外表完全正常。真要分批是将来的事，届时区块级时间取**最早**那批（保守）。

## Complexity Tracking

> 无 Constitution 违规，本表为空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| （无） | N/A | N/A |
