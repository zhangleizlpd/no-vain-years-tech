---
feature_id: 066-hk-option-cold-start
spec_ref: ./spec.md
status: approved
created_at: '2026-08-22'
updated_at: '2026-08-22'
adr_refs: ['0024', '0032', '0035', '0040', '0043', '0047', '0053', '0062', '0066']
context7_verified: []
---

# Implementation Plan: 港股期权接入与锚冷启动开通港股

## Summary *(mandatory)*

把港股期权采集补齐到与美股同档（链发现 / 日快照 / 标的 IV / 盘中实时价），让港股锚建完即有数据。技术路径是**纯配置与映射的扩展**：行情网关本身市场无关（已实测），server 侧改的是四个适配器的市场映射表、三个新增的港股专属采集维度行、一条以锚集为闸的工作集判据，以及一个被开通港股激活的既有不变量缺口。**零新依赖、零新 endpoint、零新 use case。**

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

**显式 no-op 声明**：本片一个新依赖都不引入。港股走的是**已在生产运行的**同一条链路 —— `services/futu-shim/`（港机上的 Python 薄壳）+ `VendorHttpClient` + 既有的限频 / 熔断 / 约束档。2026-08-22 实测确认网关侧**零改动**即支持港股：市场参数是对着 SDK 自己的枚举白名单校验的（`app.py:198 _require_enum`），代码原样透传。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

逐条对照：

| 原则 | 本片如何满足 |
|---|---|
| I. SDD（NON-NEGOTIABLE） | specify → clarify 已走完，本文是 plan；spec frontmatter `modules: [marketdata, optionsdesk]` 与物理 context 一致 |
| II. Test-First TDD（NON-NEGOTIABLE） | 每个 task 红→绿；spec 的 21 条 `state_branches` 逐条对应 `it()` 块（见下方 Testing Invariants） |
| III. Atomic Task = 30min-2h + 独立 commit | 见 tasks 阶段拆分；本片天然按「适配器 / 维度 seed / 工作集 / 不变量修复 / 实时面 / E2E」切片 |
| IV. Module Boundary（扁平 + 贫血 + 护城河） | 全部改动落在 `marketdata/` 与 `optionsdesk/` 既有扁平文件；**不新建目录、不新建 class**；跨 ctx 只读沿用既有 `// CROSS-CONTEXT-READ:` 路径 |
| V. 类型同步链 Nx-driven | **本片无 controller / DTO 改动 ⇒ 无 OpenAPI 变更 ⇒ 无需 api-client regen**。mobile 侧只删一条文案常量 |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 本片**零新增 endpoint**（改动全在采集侧 + 一处结局值域），因此「每个新 endpoint 至少一次真启动冒烟」这一条按**空集**满足。真正的等价物是 Testcontainers IT 覆盖冷启动的港股分支 —— 已列为 tasks 的强制项，判据是 spec 的 21 条 `state_branches` 逐条有 `it()`。
- [x] **Mobile / Web**: P1（建锚即补数）与 P3（盘中价）的黄金路径在真机 / 模拟器走一遍雷达港股页签；P2（IV 分位）在标的详情屏确认。
- [x] **Evidence**: 最终由 `specs/066-hk-option-cold-start/tasks.md` 的 `[E2E]` task 落证据（真港股锚跑通整链的逐条查库结果）。**本 gate 在 plan 阶段是「已规划」而非「已完成」** —— 别把它读成已经跑过了。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A —— 本片不引入任何新的第三方 package / SDK / tool。**

富途接入早在 2026-07-31 就已落地并写进 ADR-0047 Amendment §4（「富途 OpenD 是 protobuf TCP 网关、官方 Node SDK 已弃 → 经 `services/futu-shim/` 接入，对本层而言**就是又一个 vendor**」）。本片只是让既有 vendor 多认一个市场。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A —— 本 feature 完全是 mono-native。** 它触及的代码（`marketdata/` 的适配器与维度执行器、`optionsdesk/` 的冷启动）全部诞生于 mono，从无 Java/Spring 前身。

- **Evidence**: `rg -l 'org\.springframework|mbw-[a-z]+/src/main/java' apps/server/src/marketdata apps/server/src/optionsdesk` → 零命中。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

**结论：no impacted Open Questions。** 但有两条 sunset trigger 看上去很近，逐条说明为什么没被触发 —— 「看着近但其实没碰到」比「没扫到」更需要写出来。

| ADR | Open Question / sunset trigger | Classification | 说明 |
|---|---|---|---|
| ADR-0047 | 「marketdata 消费端要求盘中实时 tick（`QUOTE_PORT` 从 EodBacked 换实时 adapter，可能重塑 port 形态）」 | **accepted-as-is（未触发）** | 本片确实开通港股盘中价，但走的是 061 已经拆出来的**独立** `REALTIME_QUOTE_PORT`；`QUOTE_PORT` 仍是 `EodBackedQuoteAdapter`，port 形态一个字节没动。该 trigger 说的是**替换** `QUOTE_PORT`，不是**新增**实时口。 |
| ADR-0047 | 「单 capability 的 vendor fallback chain 长度 > 5」 | **accepted-as-is（未触发）** | 期权链 / 快照 / 标的 IV 三条 capability 各自**只有 1 个** adapter（富途），本片不加备源。 |
| ADR-0047 | 「出现第 2 个同类外部数据访问子系统」 | **accepted-as-is（未触发）** | 无新子系统。 |
| ADR-0043 | 「单个 bounded context use case 数 > 20」 | **accepted-as-is（未触发）** | 实数：`marketdata` 13、`optionsdesk` 15。**本片新增 0 个 use case**（改的是既有 use case 的判据 + 维度 seed + 适配器映射表）。 |

- **Evidence**: `ls apps/server/src/marketdata/*.usecase.ts | grep -v spec | wc -l` → 13；`ls apps/server/src/optionsdesk/*.usecase.ts | grep -v spec | wc -l` → 15；sunset trigger 原文取自两个 ADR 的 frontmatter `sunset_trigger` 块。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序，mock 隔离 = 抹掉 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器。`createTestingModule` 之外的"测试"视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md 的 **21 条** `state_branches`，每条**必须**在 integration test 里有对应 `it()` 块。100% 路径覆盖。

**本片额外三条（都是「不写就永远不会红」的形态）：**

- 🚨 **美股等价性必须是断言，不能是承诺**。A3 把工作集判据换掉了，"美股行为不变"若只写在 plan 里等于没有。必须构造三种行 ——「有锚 + `needSync=true`」「有锚 + `needSync=false`」「无锚 + `needSync=true`」—— 断言新旧判据在美股上产出**同一集合**，并断言第三种行**不**进港股期权维度工作集。
- 🚨 **A4 的验收必须自己造反例**。用 universe 已收录的港股票建锚，`needSync` 本来就是 `true`，seed 分支根本没跑，断言绿了什么都没证明。必须用一个 `Instrument` 表里**不存在**的港股代码，逼 `seedInstrument` 走 create 分支，再断言落 `true`。
- 🚨 **hard 边相邻性要补断言**。`hk_option_contract → hk_option_daily_snapshot` 是 hard 边，而 hard 边要求两端在派生全序里**相邻**（`assertEdgesExpressible`）。排错了不是 seed 红，是**夜间 flow 装配运行期 throw**，而 seed migration 自己跑得绿绿的。照 `dimension-executor.spec.ts` 既有的「047 T003 依赖拓扑守卫」补一条。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> - **Flat Module**: 所有文件平铺在 `apps/server/src/<module>/`。**NEVER** 生成 `domain/` / `application/` / `infrastructure/` / `web/` 子目录。
> - **Anemic Data & Zero-Class**: 数据即裸 Prisma row。**NEVER** 生成 Domain Class 或 Entity Mapper。
> - **No Repositories**: 自有表**永不**建 Repository，直接注入 `PrismaService`；不变量放纯函数 `*.rules.ts`。
> - **The Moat**: **NEVER** 写 `tx.<otherTable>.*`。本片的跨 ctx 只读（读锚表）沿用既有 `// CROSS-CONTEXT-READ:` 路径，不开新口子。

---

#### A1 — 港股期权走**独立维度行**，绝不给现有维度的 `market_scope` 加 `hk`

`session-clock.ts:165 exchangeCalendarDateForScope` 在 scope 内各市场**算出来的日历日不同**时直接 throw。北京 06:00 时 `exchangeCalendarDate('us') = D-1` 而 `exchangeCalendarDate('hk') = D` ⇒ `{us,hk}` 当场炸。**该 throw 存在的目的就是禁止这种混用**（函数注释原文：「把『别往 cn/hk 维度里掺 us』那条散文约定变成机器强制」）。

即使绕过 throw，第二个坑仍在：tick payload 无 `markets` 字段 ⇒ **混 scope 维度的工作集恒为全 scope**，港股休市而美股开市的日子会对港股全量发请求。

⇒ 新增三行，`market_scope = {hk}`：

| dimension_key | vendor | cron (Asia/Shanghai) | batch_size | history_depth | 依赖边 |
|---|---|---|---|---|---|
| `hk_option_contract` | futu | `0 0 23 * * *` | 1（链是单 code 接口） | NULL | soft ← `universe` |
| `hk_option_daily_snapshot` | futu | `0 30 23 * * *` | 400 | NULL | **hard** ← `hk_option_contract` |
| `hk_underlying_iv_daily` | futu | `0 0 23 * * *` | 500 | **1095** | soft ← `universe` |

**为什么是 23:00**：22:00 是仓里既有的港股锚点（`eod_bar` + 18 个理杏仁 cn/hk 维度全在这一刻），runbook 记「22:00 起、当晚 ~22:30 就位」。BullMQ worker `concurrency=1`，22:00 那批要占用队列一段时间，23:00 留余量。

📌 **`{cn,hk}` 不会抛**（现役 `eod_bar` 就是这个 scope）—— 判据是「算出来的日期相同」而非「时区字符串相同」，`Asia/Shanghai` 与 `Asia/Hong_Kong` 恒为 UTC+8 且均无 DST。所以「能不能并进某个现有维度」要逐个看它 scope 里有没有 `us`，别一刀切。

#### A2 — 港股日线**不新建维度**，沿用 22:00 的理杏仁 `eod_bar`

> 🚫 **本节的落地手段已随 issue #159 作废（2026-08-23），结论仍然成立。**
>
> 作废的是「靠 `deltaDimensions` 表达补哪些档」这套机制本身：冷启动改直调采集本体后，`COLD_START_CAPABILITY` 的 `deltaDimensions: string[]` 收成了两个布尔（`optionChain` / `optionSnapshot`），**日线整个不在冷启动职责内** —— 建锚那一刻 `CreateAnchorUseCase.seedLastClose` 已同步取过最近收盘（走同一个 `EOD_BAR_PORT`，按市场路由、hk 走理杏仁）。⇒ 下文「`deltaDimensions` 不含日线」与「`dataAlreadyPresent` 的日线复判要显式化」两段**都不再需要做**，`FR-011` 自动满足。
>
> **仍然成立的结论**：港股日线不加富途口径这一条 —— 理由（ADR-0047 §6 基准敏感维度不得静默换源）与机制无关，换成直调后同样适用。
>
> 原文保留在下方作决策留痕，勿据其写实现。

已在采、已入 `daily_bar`、半日市与日历配套齐全。加富途口径的港股日线会撞 ADR-0047 §6 明禁的情形：**基准敏感维度不得静默切到不同基准的备源**。同一 `(instrument_id, trade_date, adjust='none')` 唯一键上两个源抢写，而 `createMany(skipDuplicates)` 会让先到的永久占位。

⇒ `COLD_START_CAPABILITY.hk.deltaDimensions` **不含任何日线维度**。

⚠️ 连带：`dataAlreadyPresent`（`anchor-cold-start.usecase.ts:487`）现在的日线复判条件是 `deltaDimensions.length === 0 || dailyBar.count > 0`。港股 `deltaDimensions` 非空但**不含日线** ⇒ 该表达式会要求日线在场，而日线不由本维度组保证。**把判据显式化**：按「本市场的 capability 里有没有日线档」判，而不是按「`deltaDimensions` 是否为空」判。否则下一个加市场的人会踩，且踩了不报错。

#### A3 — 港股期权维度以**锚集本身**为闸，把 `needSync` 从这些维度的谓词里拿掉

`needSync` 全量 sweep 的事实（server src，去 spec / generated）：

- **写**只有四处：`sync-universe` create 分支（`market !== 'us'` ⇒ hk 恒 `true`）· `sync-universe` update 分支（**刻意不写**）· `anchor-driven-sync-gate` 双 `updateMany`（**只循环 `ANCHOR_GATED_MARKETS = ['us']`**）· 两个 seed 点（**无条件 `false`**，见 A4）
- **读**全部无条件带 `needSync: true`：`dimension-executor.ts:991`（`loadActiveInstruments`，所有 fact 维度共用，含 `{cn,hk}` 的 `eod_bar`）· `sync-profile.usecase.ts:53` · `marketdata-backfill.cli.ts:240,415`

⇒ **系统不变量：港股的 `needSync` 恒为 true**（`dimension-executor.ts:980` 把它当事实写进注释）。查询层确实读这一列，但对港股恒无收窄作用。

由此：

1. **港股期权维度不能靠 `needSync` 收窄** —— `market_scope={hk}` 单独用，工作集就是整个港股 universe，链发现（单 code 接口 × 每票多窗）会炸成小时级墙钟。
2. 🚫 **MUST NOT 把 `hk` 加进 `ANCHOR_GATED_MARKETS`** —— `anchor-driven-sync-gate.ts:11-18` 粗体写明：关闸路径（`notIn`）放到 cn/hk 会把全部 cn/hk 在市标的一次性移出工作集 ⇒ 直接打死 22:00 那 18 个理杏仁维度（SC-004）。这是成对约束，`sync-universe` 那半边是单一真相源。

✅ **做法**：引入「锚作用域维度」这一类，工作集 = `{ market ∈ scope, status: 'active' } ∩ 锚集`，**`needSync` 不进谓词**。

- 对**美股**逐点等价 —— 闸已让 `needSync ≡ 有锚`，换成直接读锚集是同一集合
- 对**港股**才是真闸
- 顺带免疫 A4 的缺口：锚集里的标的不会因为 `needSync` 被写错而掉出自己的期权维度

「哪些维度是锚作用域的」登记成**一张代码级表**（与 `COLD_START_CAPABILITY` 同范式，**一处登记**），不要散进 executor 的 if 分支。锚集读取复用 `sync-option-contract.usecase.ts:135 seedAnchoredInstruments` 已在用的同一条跨 ctx 只读路径（`// CROSS-CONTEXT-READ:` + `select: { ticker }`）。

#### A4 — 两个 seed 点破坏「港股 `needSync` 恒真」不变量（**开通港股即激活**）

`anchor-cold-start.usecase.ts:465`（`seedInstrument`）与 `sync-option-contract.usecase.ts:272`（`seedAnchoredInstruments`）都**无条件**写 `needSync: false`，理由注在原地：「受保护列，重算的唯一权威是 `anchor-driven-sync-gate.ts`」。

**这条理由只对被闸管的市场成立。** 港股没有闸，`sync-universe` 的 update 分支又刻意不写该列 ⇒ 被这两处首建的港股行会**永远停在 `false`**，同时被三个消费方静默排除：22:00 的 `eod_bar`（⇒ **那只标的永远没有日线**，而 `daily_bar` 是雷达跌破判据的输入）、`sync-profile`、backfill CLI。

**可达性**：两处都是 `findUnique` 命中即返回、**仅在 Instrument 行原本缺失时才 create**。港股 universe 由理杏仁 + 东财覆盖（周更），主流港股票行早已存在 ⇒ 只有**次新股 / universe 尚未收录**的港股锚会撞上。低频，但失败永久且静默。

今天完全够不到（`isColdStartEnabled('hk')` 在第 1c 步就返回，走不到第 3 步的 seed；`SyncOptionContractUseCase` 的 marketScope 也还是 `{us}`）。**开通的那一刻两条路径同时活。**

⇒ 两个 seed 点走**同一个 helper**，默认值与 `sync-universe.usecase.ts:107` 对齐（`needSync: market !== 'us'`），并把分工写进注释：**create 路径定默认值，闸只负责被闸市场的重算**。

> A3 与 A4 **互补而非二选一**：A3 让港股期权维度不再依赖这一列，A4 让 `eod_bar` / `profile` / backfill 这三个**仍然依赖**它的消费方不被破坏。只做 A3，港股次新股锚照样没有日线。

#### A5 — 结局值域 8 → 9：`no_option_chain`（**零 migration**）

港股绝大多数标的**没有挂牌期权**（实测：腾讯 8 / 小米 8 / 海底捞 7 / 药明康德 8 个到期日，而颐海国际 0、网龙 0）—— 与美股正好相反。折进 `backfill_incomplete`（ERROR 级、需人工介入）会让每一只无期权的港股锚都产出一条无从处理的告警。

- **判据取自库**：该标的 `option_contract` 计数为 0 ⇒ 无挂牌期权。与既有「判据看库不看 stats」同源；取采集统计量会把「有合约但整批被落库前拒掉」混进来（那种情形统计量同样为空）。
- **零 migration**：`anchor_cold_start_run.outcome` 实查是 `VARCHAR(32)` 且**无 CHECK 约束**，新值 15 字符。纯 TS 值域改动。
- 对美股是**纯增量**，既有八档行为逐点不变。

#### A6 — `oiAsOf` 按市场分叉（**形状待 U2，08-25 出结论**）

北京 23:00 于交易日 D 会命中 `resolveSnapshotSpec` 的 `today === target` 行 ⇒ `source='eod'`、`oiAsOf = D-1`。该规则来自美股清算所的隔日翻新。港股是否同构**正在实测**（`broker-hk:~/nvy-u2/`，四时点跨交易日采样，周六基线已采）。

- 已定稿 ⇒ 给 `resolveSnapshotSpec` 增一个**按市场的 `oiRefreshedAtEod` 事实位**，由调用方从登记表喂进来（**纯函数仍零 I/O**）
- 未定稿 ⇒ 现规则逐字适用，本条取消

🚫 **MUST NOT 把 `eod` / `premarket_backfill` 两条 `oiAsOf` 路径抹平**（规则层注释明禁）：抹平后永远不会红，但两条路径产出的 OI 差一天，而活跃度排名与 UI 的 `asOf` 都读它。

🚨 **闸**：结论落地前，`hk_option_daily_snapshot` **MUST NOT** 置 `enabled = true`（spec FR-016）。这只卡这一个维度，不卡本片其余任何 task。

#### A7 — 实时报价是**两处连改**（原第 3 点已作废）

1. `futu-realtime-quote.adapter.ts` 加 `hk: 'HK'`
2. `marketdata.module.ts:404` `MarketRoutedRealtimeQuoteAdapter` 补 hk 槽位
3. 🚫 ~~`market-session.rules.ts` 把港股还原成两段~~ —— **已作废（2026-08-23）**。

   原推理有一处错：它假定「本片新接的港股盘中采价」是分段敏感读者。**不是。** 盘中采价的闸走的是 `MARKET_STATE_PORT` —— **供应方的市场时段状态**，归一成三态后只有「常规连续交易时段」准采（`REGULAR_SESSION_STATES = { MORNING, AFTERNOON }`），午休（vendor 报 `REST`）落「白名单外的已知状态」⇒ **天然不采**，与本地时段表无关。

   三个消费方逐个核过，没有一个需要拆段：

   | 消费方 | 用什么判 | 要不要拆段 |
   | --- | --- | --- |
   | 补数闸（冷启动写不写快照） | `isSessionUnderway`（本地表） | ❌ 单段正确 —— 语义要的**就是**「含午休」 |
   | 盘中采价（本片新接） | **供应方市场时段状态** | ❌ 不读那张表 |
   | 盘中告警（市场参数写死 `cn`） | `isWithinTradingSession`（本地表） | ⚠️ **将来接 hk 时才要**，不属于本片 |

   ⇒ 本片对 `market-session.rules.ts` **零改动**。港股单段 `[09:30, 16:00]` + 半日市 `[09:30, 12:00]` 与 HKEX 官方口径逐项吻合（2026-08-23 已核实：股票期权与正股同开同收、无 AHT；股票期权属 Non-Holiday Trading Exchange Contracts ⇒ 期权日历 = 正股日历）。⚠️ 该结论**只对个股期权成立** —— 将来做指数期权（恒指 / 国指）时三条全部翻转，那时必须把 hk 拆成两份登记。
4. mobile：`radar.rules.ts` 的 `MARKETS_WITHOUT_INTRADAY` 去掉 `'hk'`、`optionsdesk-copy.ts` 的 `marketNoIntraday` 下线，`apps/mobile/e2e/optionsdesk-anchors-radar.spec.ts:1011-1040` 那条双向断言同步改。

#### A8 — `'N/A'` 规范化（**已证实的缺陷，不是假设**）

网关侧 `mappers.clean_value` 只处理空值 / 非有限数，**字符串原样透传**（`mappers.py:50-51`）。而 `futu-option-chain.adapter.ts:98 strOrNull` 是「非空字符串即返回」⇒ 字面量 `"N/A"` 会被当成一个有效结算方式写进 `settlementMode`。**美股返 AM/PM 永远撞不到，港股每一行都会。**

📌 反过来，`futu-underlying-iv.adapter.ts:62 numToString` **已经正确**（`Number('N/A')` 为 NaN ⇒ 落 `null`，注释写明「不回落成 0，因为分位上 0 = 一年最低」）⇒ 标的概览那条**无需改动**。两处形态相近但一处有缺陷一处没有，**别顺手一起改**。

#### A9 — IV 回填必须跨 ≥2 窗，且分位样本只含真实观测

单个 364 天窗港股只返 **244** 个交易日、美股 250 —— **两者都不足 `IVP_MIN_WINDOW_TRADING_DAYS = 252`**。⇒ `hk_underlying_iv_daily.history_depth = 1095`，走既有 `splitBackfillWindows()`。只拉一年会让分位恒为 `insufficient_window` **且不报错**。

历史起点实测 **2023-06-27**（美股 2023-06-26），总深约 3.15 年 / ~773 行。

⚠️ **无期权标的的污染路径**（只在港股够得到）：它们的标的概览整行为空值观测，若这类空行累积到 252 就被判「样本充足」，会让一个毫无意义的分位看起来可算。样本判据必须只数**真实有值**的观测（spec FR-019a）。

#### A10 — 限频与串行

- 网关的限频闸是**按 capability 全局计**的，不分市场（vendor 侧的桶本来就是账号级的，分两个桶只会让两条路各以为自己有 10 发）。
- `option_chain` **10 次/30s 是官方真值不是兜底**（`app.py` 已有粗体警示，别顺手改宽）。
- **港股与美股链发现结构上不可能并发** —— 所有维度 job 与冷启动 job 共享 `marketdata-sync` 单队列且 worker `concurrency: 1`。这条对 cron 触发与**冷启动触发**同样成立，比「错峰 cron」强得多（冷启动是全系统唯一的非 cron 触发者，建锚时刻由人决定，错峰保证不了）。
  📌 **issue #159 后这条不仅成立，还更强了**：冷启动不再把链组成 flow 入队，而是**在自己这个 job 内部直调采集本体** ⇒ 链发现连「另一个 job」都不是，更不可能与 cron 的链维度并发。⚠️ 但「冷启动已不再入队」这句话说的是**它不再往队列投 child**，它自己仍是队列上的 `sync:anchor-cold-start` job —— 串行保证的前提正是这一点，别据此把它挪出队列。
- **容量实测**：21 只美股锚的一轮 `option_contract` ≈ **8 分钟**（2026-08-22 生产实测），全程把 10/30s 的桶占满。港股是**另一轮串行叠加**，估算墙钟按「两轮相加」而非「取最大」。腾讯一只票 30 天窗就有 132 个合约、8 个到期日 ⇒ 贪心分窗约 5–8 发；港股**不比美股省**（US.PEP 是 16 个到期日，只多一倍，不是数量级差别）。

#### A11 — 合约 ↔ 标的的关联键

🚨 港股合约标识的词根是**交易所助记符**（腾讯期权是 `HK.TCH260929C460000` 里的 `TCH`），**不是**标的数字代码 `00700` ⇒ **从合约标识反推不出标的**。关联**只能**走供应方给的 `stock_owner` 字段（快照行也带）。美股是 `US.PEP260918P130000` 这种可反推形态 —— **别把美股的假设带过来**。

#### A12 — 采集端全开纪律（沿用既有）

`sync-option-contract` 对链**永远只传** `code/start/end/option_type`，**不传** `option_cond_type` / `data_filter`。采集端一旦筛就丢证据且**不可回补**（vendor 不提供历史交易日的链快照）。过滤是读取面的事。港股照此，不开例外。

#### A13 — vendor 时间戳按**行所属市场**解析，映射与 `session-clock` 同源

`futu-option-snapshot.adapter.ts` 的 `VENDOR_UPDATE_TIME_ZONE` 固定按美东解释 vendor 的 `update_time`。港股实测给的是**港股当地时刻** ⇒ 该列在港股上整体偏 12 小时。

⇒ 引入一张 `market → tz` 映射，按行的市场解析。🚨 **它必须与 `session-clock.ts` 的 `EXCHANGE_TIME_ZONE` 同源，MUST NOT 复制第二份** —— 两份市场时区表一旦漂开，表现是「某个市场的时间戳悄悄差几小时」，不报错。

📌 **为什么不是紧急修**：该列是纯证据零判据（`option-snapshot.port.ts` 明禁用它顶替采集时刻，新鲜度看信封的 `as_of`），偏了不影响任何判据。**但它卡在 A7 前面** —— `futu-realtime-quote.adapter.ts` 复用同一个 `vendorTimeToDate`，而实时报价那条路上 `intraday_at` 是真判据（90 秒新鲜度闸读它）。

🚫 **MUST NOT 顺手把 `exchangeCalendarDate` 对未登记市场的静默回落也改成抛** —— 那处的回落是既有语义（meta 维度空 scope 依赖它），改极性会波及全部维度的 asOf。未登记市场的风险已由 `marketdata.dimension-scope-invariant.it.spec.ts` 从**数据侧**兜住。

## Complexity Tracking

> Constitution Check 无违规，本表为空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| （无） | — | — |
