---
feature_id: 085-optionsdesk-display-currency
spec_ref: ./spec.md
status: drafted
created_at: '2026-09-17'
updated_at: '2026-09-17'
adr_refs: ['0040', '0043', '0047', '0054', '0058', '0062', '0066']
context7_verified: []
---

# Implementation Plan: 交易账户展示币种切换

<!--
This plan is PROSE-ONLY. The data model lives in schema.prisma (SoT); the API
surface lives in @nestjs/swagger decorators → OpenAPI (code-first SoT, per
docs/conventions/api-contract.md). Do NOT mirror either into this file — capture
DESIGN INTENT + decisions in prose under Architecture Notes instead.
-->

## Summary *(mandatory)*

持仓列表页加展示币种切换（三档 USD / HKD / CNY，进入页面即当前市场原币种，本次停留内有效、离开该页复原）。server 侧 optionsdesk 自持汇率源（腾讯 `wh` 主 + 新浪 `fx_s` 备，FallbackChain + 进程内单格缓存），折算在既有分组聚合**之前**逐行做，降级行金额置 `null` ⇒ 复用 083 既有「市值无效排末」实现「降级组沉底」，**零新排序键**。**零 schema 变更、零新依赖、零新 use case、零跨 ctx 面变化**；跨端单 PR。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

**显式 no-op 声明**：GBK 字节取用全局 `fetch` + `AbortSignal.timeout`（先例 `apps/server/src/alert/realtime-fetch.ts:15-19`，024 已在 prod 跑）；GBK 解码用既有 `decodeGbk`（`alert/realtime-quote.rules.ts`，**跨 ctx 不可 import**，本片照写法另落 optionsdesk 侧，见 D3）；FallbackChain 编排照 `alert/realtime-quote-fallback-chain.adapter.ts`；缓存照 `marketdata/futu-market-state.adapter.ts:132-182`；下拉面板用 RN 内置 `Pressable` + 绝对定位 `View`（mockup 已按此画，零新组件库）。均不新增包。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles；两处越出 optionsdesk 目录的改动记在 Complexity Tracking。

| 原则 | 本片如何满足 |
|---|---|
| I. SDD（NON-NEGOTIABLE） | specify → clarify（Session 2026-09-16，8 问全定）→ **Mockup**（`design/handoff.md`，五帧 + 六项探测 GATE PASS）→ 本 plan。汇率源的不确定性已在**立 spec 之前**的 plan 期 PoC 消掉（P1–P6，见「plan 前验证」） |
| II. Test-First TDD | 每 task 红→绿；spec `state_branches` 21 条逐条映射落点（测试映射表）；十条反例臂各自「不写就永远不会红」 |
| III. Atomic Task | tasks 阶段按「FX 解析纯函数 / 双源 adapter + 缓存 / 折算规则 / 读端点接线 + regen / mobile 选择器 / mobile 汇率行与降级标 / 验证与治理」切片 |
| IV. Module Boundary | server 文件平铺 `apps/server/src/optionsdesk/`；FX adapter **住本 ctx**（不进 `integrations/`，见 Gate 0.4）；只读自有 `broker_*` / `anchor` 表；**跨 ctx 面一条未动**（FX 不经 marketdata） |
| V. 类型同步链 | 改 `GET /broker-positions` 的 query + 响应 ⇒ `nx run server:export-openapi` → `nx affected -t generate` → mobile 消费，同 PR；mobile 两层验证 = hermetic e2e + 契约冒烟 |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 改动的读端点由既有 Medium IT 扩臂覆盖（真 PG 隔离库 + 经 HTTP 注入走 `JwtAuthGuard`）；FX port 在 IT 里注入 test double 固定汇率（**不打真 vendor**）；真 vendor 由 `RUN_FX_VENDOR_IT` 门控的 Medium 测校字段（默认 skip，per `testing.md` §4 步 4）；契约冒烟加一条带 `displayCurrency` 的请求。
- [x] **Mobile / Web**: Playwright hermetic 覆盖 US1–US3 金路径（选择器展开 / 切档重算 / 降级行与降级组 / 汇率行出没）；**真机窄屏必核一次** —— 选择器嵌在「同步于 …」行右侧，mockup 实测该行余量 234px，390px 机身上是否溢出只有真机/窄视口能判（`.claude/rules/mobile-impl-playbook.md` § RN 布局陷阱：web e2e 视口宽松 ⇒ 系统性漏测）。
- [x] **Evidence**: planned —— 由 tasks 的 `[Server-IT]` / `[Contract-Smoke]` / `[Mobile-E2E]` / `[Gate]` task 落证据；本 gate 在 plan 阶段是「已规划」而非「已完成」。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**Evidence**: N/A —— **零新第三方包 / SDK / 工具**（见 Dependencies 表）。⚠️ 本片确实新增**两个 vendor 端点**（腾讯 `qt.gtimg.cn` FX / 新浪 `hq.sinajs.cn` FX），但端点不是包；其可维护性、限频、ToS 风险与已实测的行为限制在 D3 / D4 逐条登记，PoC 结论见「plan 前验证」。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] **Evidence**: N/A — mono-native。`rg -l 'org\.springframework|mbw-[a-z]+/src/main/java' apps/server/src/optionsdesk apps/mobile/src/optionsdesk` → 零命中（2026-09-17 plan 起草时执行）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | sunset trigger / Open Question | Classification | 说明 |
|---|---|---|---|
| ADR-0054 | 「marketdata 长出实时行情同步面 → alert 自持 adapter 应收回」（#2，061 已判 `escalated-to-next-feature`） | **accepted-as-is** | 本片**不碰** alert 那条；但它使 optionsdesk 成为**第二个自持外部 IO adapter 的业务 ctx**，形态与 ADR-0054 立的判据同构（vendor 单消费者 ⇒ 留本 ctx）。⚠️ 本片**不**新增 marketdata 侧实时面，故 #2 的收编条件（futu 拿到 A 股权限 / 腾讯新浪包成 marketdata routed adapter）均未发生。**新增绊线**：portfolio 或任何第二个 ctx 需要汇率 ⇒ 回本节 + ADR-0058 重审「升 `integrations/` 还是升 marketdata port」 |
| ADR-0058 | `integrations/` 准入「≥2 个 bounded context 复用」+ sunset「适配器 > ~7 个」 | **accepted-as-is，未命中** | FX 当前**单消费者**（optionsdesk 持仓列表）⇒ 按 Decision §1「单消费者 vendor 适配器留各自 ctx，不迁入」。同形先例：marketdata 自己的 5 个 vendor 客户端也都**不在** `integrations/`。现有 4 个适配器（llm / asr / codeindex / oss），未近 7 |
| ADR-0043 | #1「单个 bounded context use case 数 > 20」（083 已 fired · mitigated，复审线 = **30**） | **accepted-as-is，未越线** | 本片**不新增 use case** —— 折算接在既有 `list-broker-positions.usecase.ts` 上（加一个可选入参）。`ls apps/server/src/optionsdesk/*.usecase.ts \| wc -l` → **24**（2026-09-17），与 083 复审时一致 |
| ADR-0062 | 四条 trigger（实时 spot / 序列读搬进本 ctx / 第二个锚消费方 / 下单与持仓联动） | **accepted-as-is，一条未命中** | 本片零新跨 ctx 面：FX adapter 住 optionsdesk 自己，**不经 marketdata**、不读其表、不注其 port；`OptionsdeskModule.imports` 不变；`apps/server/eslint.config.mjs` 零改动 |
| ADR-0066 | 时间语义（四条轴 + 「秒级陈旧不认 vendor 时间戳」） | **accepted-as-is** | 汇率的取数时刻用**我们自己的采集时刻**（ingestion time），vendor 时间戳只作证据不作判据 —— 这正是 `cross-timezone-date-semantics.md:114` 既有纪律的同一形态，PoC 独立撞到同一件事（见 D5） |

- **Evidence**: use case 数 = `ls apps/server/src/optionsdesk/*.usecase.ts | wc -l` → 24（2026-09-17）；ADR-0043 复审线原文 `docs/adr/0043-server-flat-module-paradigm.md:6,133`；ADR-0058 准入 `docs/adr/0058-server-integrations-layer.md` Decision §1；ADR-0054 #2 状态 `docs/adr/0054-alert-self-hosted-external-io-adapter.md:90`。**不新起 ADR**：本片未引入新 ctx、未开新跨 ctx 边、未改任何 ADR 的决策面。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。（本片不新增此类组件；鉴权仍靠既有 `JwtAuthGuard`。）
- **MANDATORY INTEGRATION**: 读端点 IT 必须用 `Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()` + `setupIsolatedDb`（`apps/server/test/_support/isolated-db.ts`）装配并经 HTTP 注入调用 controller（带真 JWT），直接 prisma 种 `broker_*` / `anchor` 行；**FX port 是唯一允许的 test double**（它是外部 I/O），🚫 mock `PrismaService`。
- **EXHAUSTIVE BRANCHING**: spec 的 **21 条** `state_branches`（`spec.md:18-39`）每条必须有对应断言落点（下方测试映射表，analyze 期逐条 grep 对账）。🚨 mobile vitest **只测纯逻辑**，禁组件 render 测（`docs/conventions/testing.md` 不变量 4）。

**本片的反例臂（都是「不写就永远不会红」的形态）：**

- 🚨 **降级组沉底要能区分「根本没实现沉底」**：构造「A 组可完整折算、折算后市值**小**」+「B 组含降级行、原币种市值**大**」，断言 A 排在 B 前。若实现把降级组的 `groupMarketValue` 留成原币种裸和，B 会因绝对值大而排前 —— 而两种实现都排得出顺序、都不会红。
- 🚨 **「选定币种 = 原币种时直出」要能区分「乘以 1 再舍入」**：断言输出的 Decimal **字符串逐字相同**（`toFixed` 比较，不是 `.equals()` 数值相等）+ 折算函数调用次数为 0 的 spy 断言。只断言数值相等对「乘 1」的实现同样绿（FR-008）。
- 🚨 **组聚合不许混入降级行**：组内 2 行可折算 + 1 行降级，断言组市值**恰等于**前两行折算值之和、且组标为不完整。把第三行原币种值也加进去会得到一个不同但「看起来合理」的数。
- 🚨 **FX 解析器必须显式挡哨兵**：喂 `v_pv_none_match="1"` 断言**抛**。PoC 实证：既有股票解析器的正则会把 `pv_none_match` 当成一个 symbol 解出来（fields 长度 1，靠 `length <= 32` 静默跳过）⇒ 照抄会得到「零汇率但不报错」。
- 🚨 **「请求 N 对必须回 N 对，少一对即抛」**：请求 3 对、喂只含 2 对的响应，断言抛。PoC 实证部分命中是**静默省略**；本片这条与 `alert/` 的「部分命中不算失败」**刻意相反**（缺一对 ⇒ 那一屏的折算无从进行，静默少一对会让该行悄悄走降级路径）。
- 🚨 **失败不入缓存**：注入一次失败后断言下一发**真打** vendor（调用计数）。把失败缓存住会让一次抖动把降级态钉死整个 TTL（`futu-market-state.adapter.ts:164` 同一理由）。
- 🚨 **single-flight**：并发 4 发断言只打 1 次 vendor。冷缓存下纯 TTL 缓存那一瞬间完全不设防（`futu-market-state.adapter.ts:147-150`）。
- 🚨 **取数时刻不许用 vendor 时间戳**：喂两次响应「vendor 时间戳推进、汇率值不变」，断言上屏的取数时刻**两次不同**（是我们的采集时刻）。这是 PoC 发现①的机器化 —— 否则会拿新时间戳给旧数字背书，而屏幕上一切正常。
- 🚨 **陈旧不触发降级**：喂一个远早于当前的采集时刻，断言**照常显示折算值**并标注时刻（spec Edge Case「不因陈旧而清空或隐藏」）。把陈旧也判成降级会让盘前时段整屏退回原币种。
- 🚨 **币种状态三臂**（前两臂照 083 T015③ / ③b 形态）：① 切档后进持仓详情再返回 ⇒ **仍为所选币种**；② 切档后返回雷达再进入 ⇒ **复原为该市场原币种**；③ 在 hk 切档后切到 us ⇒ **us 为 USD**，再切回 hk ⇒ **仍为所选档**。缺 ① 或 ②，store 实现与屏级 `useState` 实现都会绿；缺 ③，单格状态与每页签一格都会绿（FR-005 / SC-005）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> - **Flat Module**: ALL files live flatly in `apps/server/src/optionsdesk/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories —— 包括「为了分组」而建的 `fx/`（照 083 Gate 0.4 的缓解方式：按 `fx` 名词段**命名**分组，不建目录）。
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows. NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly. Business invariants go in `*.rules.ts`.
> - **The Moat**: NEVER write `tx.<otherTable>.*`。本片只读自有 `broker_*` / `anchor` 表，**跨 ctx 面一条未动**。

### 🚨 Impl Guardrails（仅留本 feature 适用条目）

1. **只读**：本片零写路径、零事务、零 schema 变更（汇率不落库，见 D4）。
2. **金额一律 `Prisma.Decimal`，出边界一律 string**；🚫 Number 中转（PoC P6：283,337 个真实量级样本里 1 个显示值不同 —— 是**纪律**问题，不是「实测证明 Number 会错」，写注释时不得夸大）。
3. 🚨 **数字字面量避开 `0.8` / `0.6` / `1.2` 三个子串** —— `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #1 从 `anchor.rules.ts:29,32,35,45` 派生被禁字面量并扫 `apps/server/src/optionsdesk/` 下**除 `anchor.rules.ts` 外的全部 `.ts`，含 `*.spec.ts`**（`:620-625`，#1 的扫描面刻意不排除 spec）。⇒ **fixture 的 HKD→CNY 汇率不能用真实值 `0.8549`**（含 `0.8`）；用一眼可辨的合成值（如 `0.9500` / `2.5000`）。同理 `1.2` 出现在任何汇率或倍数 fixture 里都会红。
4. **账号隔离在查询条件里**：本片不改 `where`，但新增的 query 参数 **MUST NOT** 成为第二条数据路径 —— `displayCurrency` 只影响呈现，不进任何 `where`。
5. **时间只在服务端换算**：汇率的采集时刻走既有 `exchangeLocalDateTime` 之外的第四条轴（ingestion time，绝对时刻）⇒ 直接出 ISO UTC 由 mobile 按设备本地展示；optionsdesk 侧不裸用 `Intl.DateTimeFormat`（`check-time-semantics` Rule B 会当场红）。
6. **API 同步链两步分别跑**：`nx run server:export-openapi` → `nx affected -t generate`；漏第一步是**静默的**（`api-client:generate` 无 `dependsOn`，会拿上一版 json 重生成、产物逐字节相同、CI 全绿）—— `docs/conventions/api-contract.md:56-67`。
7. **mobile 🚫 `Intl.NumberFormat`**（`format/compact-amount.ts` 文件头硬纪律，Hermes 上 Intl 支持不确定）；币种一律**三字母代码**，不用货币符号（spec Clarifications 已定）。
8. **mobile 不自算汇率或折算** —— 折算全在 server；`check-optionsdesk-rule-constants` 不变量 #8 已在扫客户端自算默认值，本片同一立意。

---

### plan 前验证（PoC 已跑完，判据先写）

汇率**源**与**服务端集成**两层不确定性均已消掉，PoC 判据在跑之前定死、探针跑完即删（工作树干净）。完整原始记录在 `~/.claude/plans/1-put-call-hk-glimmering-squid.md`（plan mode 文件，**不入仓**）。下表是本 plan 要消费的结论，**均为上一轮 session 亲测**（2026-09-16）+ 本轮补测（2026-09-17）：

| # | 判据 | 结论 |
|---|---|---|
| P1 | 一次请求取全三对 | ✅ `qt.gtimg.cn/q=whUSDCNY,whHKDCNY,whUSDHKD` 单请求返 3 条、各 **22 字段** `~` 分隔、`f3` 可 Decimal 解析、`f5` 匹配 `^\d{14}$` |
| P2 | 限频/熔断不误伤 | ✅ `VendorHttpClient` + `TENCENT_PROFILE` 连打 4 次全通（熔断置位会抛 `BrokenCircuitError`）；两条通路 `f3` 逐字一致 |
| P3 | 反向汇率取倒数 | ✅ 反向三对（`whCNYHKD` / `whHKDUSD` / `whCNYUSD`）**全 MISS**；倒数往返误差 < 1e-9 |
| P4 | 单键缓存语义 | ✅ 第二发不打 vendor / 失败不入缓存 / single-flight 并发 4 发只打 1 次。⚠️ 验的是**仿真形态**，不是某个实现 |
| P5 | 折算下沉到组聚合 | ❌ **判据作废，但结论仍成立** —— 原鉴别理由「折算会改变跨组排序」结构上不可能发生：单屏恒单一市场（`list-broker-positions.usecase.ts` 的 `findMany({ where: { accountId, market } })`）⇒ 同屏同币种 ⇒ 等比例缩放，`sum(rate × vᵢ) ≡ rate × sum(vᵢ)`，数值与顺序都不变（当时是 us 组 + hk 组混合样本造出的假象）。**逐行折算再聚合仍是必须的**，依据换成降级行隔离：先聚合再折算会把降级行的原币种值混进 `signedSum`，乘汇率后得到一个「看起来合理」的错数（FR-006 / D2；测试见上文「组聚合不许混入降级行」条） |
| P6 | 精度不退化 | ⚠️ 通过但鉴别力弱 —— 见 Guardrail 2 |

**三条原记录被实测推翻**（写代码注释时按此，别照旧说法）：

1. **「需 `Referer` + 浏览器 UA」是错的** —— 裸 curl（无 Referer、无 UA）返回完整有效数据（与新浪漏 Referer → 403 **不同**）。`TENCENT_PROFILE` 照带无害且应保留（vendor 可能收紧），但**不能写成「必须」**。
2. **「三源吻合到 0.002%」对 CNY 零鉴别力** —— 那条建立在 `USDHKD` 上，而**联系汇率制正是让它天然吻合的原因**；它只证明「字段解析对了」。CNY 两对实测系统性偏低（见下）。
3. **部分命中 = 静默省略**（原未记）—— `whUSDCNY,whZZZZZZ,whUSDHKD` → 只回 2 条，无效码那条**直接消失**；**全部**无效才返哨兵 `v_pv_none_match="1"`。

**两条新发现改了设计约束**：

- **`f5` 不是该汇率值的生成时刻**：10 轮 / 3.5 分钟采样中 `USDCNY` 的 `f5` 多次推进而 `f3` 纹丝不动 ⇒ `f5` 是 vendor **刷新这条记录**的时刻。⇒ D5。
- **`f3` 与 `f10` 会分叉、`f3` 领先**（约 40s 窗口）⇒ 取 `f3`，🚫 拿 `f3 == f10` 当健康校验（每次更新瞬间都会误报）；`f11` 语义未定，**不消费**。

**CNY 源偏差与维护者裁决**：腾讯 `wh` 的 CNY 两对与两个独立源同向系统性偏低（`USDCNY` 约 0.08%、`HKDCNY` 约 0.05%），腾讯三角自身不闭合约 0.057%（`USDCNY / USDHKD` vs 直给 `HKDCNY`，三对时间戳差可达 2 分钟、各自独立报价）。**维护者 2026-09-16 定：维持腾讯，UI 标「参考汇率」** —— 需求是「统一折算看总量」而非结算，该用途下 0.08% 无实质影响；换 CNY 主源要引入新浪那个字段语义不稳的源并变成两套解析器，风险大于收益。⚠️ **偏差是否稳定在该量级仍未验证**（只做过一次同刻对拍）；将来若用途升级到任何**结算 / 对账**，必须先补多轮对拍。

**本轮（2026-09-17）补测两条，均为本 session 亲测**：

- **新浪备源的字段落点 = `idx3`**（`,` 分隔第 4 段）：`fx_shkdcny` 的 `idx3` 与腾讯 `whHKDCNY` 的 `f3` 吻合到 4 位小数，而 `idx8` 不吻合且会摆动。⇒ plan 原记的「新浪字段语义不稳」指的是 `idx1` / `idx2` / `idx8`（买卖价一族），不是 `idx3`。
- **在岸 CNY 有交易时段，盘前会给一个数小时前的值**：北京时间 09:11 采样时 `whUSDCNY` 的 `f5` 与新浪 `fx_susdcny` 的时间戳**双双停在凌晨**（在岸人民币 09:30 才开盘），而 `HKDCNY` / `USDHKD` 正常推进。⇒ 这正是 spec Edge Case「汇率数据有一定陈旧时仍照常显示并标注取数时刻」要覆盖的**实发**分支，不是理论风险（D6）。

---

#### D0 — 命名（按 `fx` 名词段分组，不建子目录）

server：`fx-rate.port.ts`（ctx 内 port + token）· `fx-rate.rules.ts`（GBK 解码 + 两个源各自的解析纯函数 + 哨兵挡 + N 对校验）· `tencent-fx.adapter.ts`（主）· `sina-fx.adapter.ts`（备）· `fx-rate-fallback-chain.adapter.ts`（编排）· `fx-rate-cache.adapter.ts`（缓存装饰器）· `display-currency.rules.ts`（折算 + 降级判定）。`rg -l fx apps/server/src/optionsdesk/` 即可列出本组。

mobile：`display-currency.rules.ts`（档位值域 + 按市场求默认 + 降级/不完整标判定）· `currency-selector.tsx`。testID 沿 083 前缀 `optionsdesk-trading-account-`。

#### D1 — API 形状（设计意图；字段 SoT = swagger 装饰器）

`GET /api/v1/optionsdesk/broker-positions` **加一个可选 query** `displayCurrency ∈ USD | HKD | CNY`；**缺省 = 该 market 的原币种**（⇒ 老客户端行为逐字节不变，SC-006 的机械保障）。响应顶层加参考汇率信息（币对 / 汇率值 / **我们的采集时刻** / 是否可用）；行加「是否已折算 + 呈现币种」；组加「聚合是否完整」。**不新增端点、不新增 use case。**

- **不为币种另开端点**：同一份持仓在不同币种下只是呈现不同，两个端点会让分组与排序逻辑出现第二个入口。
- mobile 侧每档一个 react-query key（`use-trading-account-positions.ts:16` 的 key 常量加币种维度）⇒ 切档即取数，切回已取过的档命中缓存（SC-004 的 1 秒内靠这个，不靠额外优化）。

#### D2 — 折算落点与顺序（`display-currency.rules.ts`）

在 `list-broker-positions.usecase.ts:250` 拿到 rows 之后、调 `buildPositionGroups` **之前**逐行折算（spec `state_branches`「先逐行折算再聚合」）。**折算在 server 的三条依据**（原「混合市场排序错位」论证已作废 —— 单屏恒单一市场，见 P5）：

1. **组聚合值口径唯一性** —— `groupMarketValue` 由 server 用 `Prisma.Decimal` 算（`broker-position-display.rules.ts:116-117` 的 `signedSum`）。改由 mobile 折算，要么两处各折一次（两份逻辑必漂），要么组值与行值各自舍入而对不上。
2. **Decimal 精度** —— `apps/mobile/src/format/compact-amount.ts` 文件头明写「Decimal string → Number 只用于展示，不回写」；把折算挪到 mobile 等于让这步乘法走 Number。
3. **vendor I/O 归属**在 server（取数、限频、缓存都在那边）。

**降级行的机械处理是本片最关键的一处复用**：降级行（所需汇率不可用 / 该行 `currency` 为 `null`）把 `marketValue` 与 `unrealizedPl` **置 `null`** 再喂给 `buildPositionGroups` ⇒ 既有 `signedSum`「非空带符号求和，全空 ⇒ null」与 `compareGroups`「`|groupMarketValue|` 降序 → **null 排末**」（`:190-205`）**自动**实现 FR-006「不混入求和」与 FR-012「降级组沉底」，**零新排序键、零改既有比较器**。组内相对顺序天然保持（组内排序键与金额无关）。

- ⚠️ 含降级行但**也有**可折算行的组，其 `groupMarketValue` 非 null（部分和）⇒ 不会被 null 分支沉底。**这一条必须显式实现**：组只要含降级行就把两个聚合值都置 `null`（FR-006 要求「组市值与组持仓盈亏两个聚合值均标注不完整」）⇒ 沉底与「不完整」标记由同一个判定驱动，不会出现「标了不完整却没沉底」。
- 选定币种 = 该行原币种 ⇒ **直出原值、不进折算路径**（FR-008），避免乘 1 的舍入差。
- 复杂度：逐行折算 O(n)，分组与排序仍 O(n log n)。

#### D3 — FX 源与解析（`fx-rate.rules.ts` 纯函数）

- 端点：主 `https://qt.gtimg.cn/q=wh<FROM><TO>`（GBK，`~` 分隔 22 字段，取 `f3`）；备 `https://hq.sinajs.cn/list=fx_s<from><to>`（小写，GBK，`,` 分隔，取 `idx3`，**必带 `Referer: https://finance.sina.com.cn`** —— 漏了 403，`alert/sina-realtime.adapter.ts:7` 已记同一事实）。
- 🚨 **解析器不能复用 `alert/realtime-quote.rules.ts`**：股票是 88 字段、FX 是 22 字段，字段下标完全不同；且 alert 那个住在另一个 ctx，跨 ctx import 纯函数被 eslint `boundaries` 拦（ADR-0053）。**照写法另落一份**，两份并存是已知状态。
- 三个币对固定：`USDCNY` / `HKDCNY` / `USDHKD`。反向（`CNY→USD` 等）**取倒数**（P3：反向币对全 MISS）。🚫 **链式交叉**（如 `USD→HKD` 用 `USDCNY ÷ HKDCNY` 算）—— 腾讯三角不闭合约 0.057% 且三对时间戳可差 2 分钟，交叉出的数字任何源都没直接给过。
- 解析契约：**请求 N 对必须回 N 对，少一对即抛**（与 alert 的「部分命中不算失败」刻意相反）；哨兵 `v_pv_none_match="1"` 显式挡（不得当成一个 symbol）；`f3` / `idx3` 不可 Decimal 解析即抛。
- 失败语义照 `alert/realtime-quote-fallback-chain.adapter.ts:39-42`：节点抛 → 记 warn 平移下一节点；**全败抛**（区别于搜索链的返空），由 use case catch 成降级态。

**腾讯 `wh` 字段位对照**（`fN` = 按 `~` 切开后的第 N 段，**0 起数**；这是本仓叫法，vendor 不给字段名，故「语义未定」是常态而非遗漏）。样本 `whUSDCNY`，2026-09-17 09:48:11 实拉：

`310~美元人民币~USDCNY~6.7119~0~20260917094811~6.7065~6.7100~6.7121~6.7087~6.7119~6.7121~0.0054~0.08~…`

| 位 | 该样本值 | 语义 | 凭据 |
|---|---|---|---|
| `f3` | `6.7119` | **即期汇率** —— 唯一消费的价格位 | 已核实：`USDHKD` 与 frankfurter / er-api 三源对拍吻合 0.002% |
| `f5` | `20260917094811` | `YYYYMMDDHHmmss`，**vendor 刷新该条记录的时刻**，不是该汇率值的生成时刻 | 已核实：3.5 分钟 10 轮采样中 `f5` 多次推进而 `f3` 纹丝不动 ⇒ D5 |
| `f10` | `6.7119` | 另一价格位，稳态恒等于 `f3`，更新瞬间滞后约 40s | 已核实：`USDHKD` round 7–8 出现 `f3=7.8434` / `f10=7.8448` |
| `f11` | `6.7121` | **语义未定 ⇒ 不消费** | 与 `f10` 的差在 `0.0002`–`0.0029` 间变动、又曾恰等于 `f6`/`f7`，对不上任何稳定解释 |

其余位**均为推断、未验证**（单条样本 + 算术自洽，无 vendor 文档、未做多轮采样），impl 期一律不消费，列出只为读原始响应时不迷路：`f0` 类型码 · `f1` 中文名 · `f2` 代码 · `f4` 恒 `0` · `f6` 昨收（依据 `f12 = f3 − f6` 且 `f13 ≈ f12 / f6`）· `f7` 今开 · `f8` 最高 · `f9` 最低 · `f12` 涨跌额 · `f13` 涨跌幅 % · `f14`–`f18` 多周期涨跌幅 · `f19` / `f20` 区间高低 · `f21` 日期。

#### D4 — 缓存（进程内单格 + single-flight；汇率不落库）

照 `marketdata/futu-market-state.adapter.ts:132-182`：

- **一格存三对**（P1 一次请求取全三对 ⇒ 天然单键语义）；不引入 Map / LRU / 淘汰策略。
- **single-flight**：冷缓存下 N 个并发请求会同时 miss，纯 TTL 缓存在那一瞬间完全不设防（`:147-150`）。
- **失败不入缓存**（`:164`）：一次抖动会把降级态钉死整个 TTL，而降级是用户可见的。
- **不加 jitter**（`:129-130`）：jitter 防的是「多键同秒集体过期」，单键上加它只是照抄形状。
- **TTL 取 60s 量级**（有据：3.5 分钟采样内 CNY 两对零变化、`USDHKD` 变 1 次 ⇒ 分钟级）。⚠️ **外汇 24h 交易，没有「下一个刷新窗」可锚** ⇒ 用固定秒数，不照抄 `get-quotes.usecase.ts:22` 的「TTL 锚到下次 EOD」。
- **进程内而非 Redis**：单实例部署（`docker-compose.tight.yml` 的 `app` 无 `replicas` / 无 `deploy:`）下两者正确性等价，差别只在「跨重启存活」vs「零往返 + 零序列化」；60s TTL 下跨重启存活无价值，而 Decimal 经 Redis 要序列化。⚠️ **绊线**：server 变多实例 ⇒ 每实例各自一格（多打 vendor，但正确性不变）；真要收敛再迁 Redis（体例 `get-quotes.usecase.ts`，不照抄 `futu-market-state` —— 那是进程内的）。
- **汇率不落库**：零新表、零 migration。它是纯呈现口径、无历史需求（历史归 `daily_bar` 那条线，与本片无关）。

#### D5 — 取数时刻的口径（PoC 发现①的机器化）

上屏的时刻一律是**我们自己的采集时刻**（`capturedAt`，绝对时刻 / ingestion time，ADR-0066 第二条轴）。🚫 **用 vendor 的 `f5` / 新浪时间戳作为该汇率的时效** —— 实测 `f5` 可一路推进而 `f3` 纹丝不动，照直写就是**拿新时间戳给旧数字背书**。这与 `cross-timezone-date-semantics.md:114`「秒级陈旧 🚫 不认 vendor 时间戳」是同一条纪律。

vendor 时间戳**可以**留在日志 / 响应里作证据（`EVIDENCE:` 体例），但判据与上屏文案只认 `capturedAt`。措辞照 mockup：**「参考汇率」**+ 时刻，不写「实时」/「可用于结算」（FR-007 已约束）。

#### D6 — 降级判据（陈旧 ≠ 不可用）

**降级**（该行金额退回原币种并标注，不显示任何折算数字）只在两种情况触发：① 全源失败或该币对解析不出；② 该行 `currency` 为 `null`（券商未回报）。

🚫 **把「陈旧」也判成降级** —— 在岸 CNY 盘前会给数小时前的值（本轮实测），把它判成不可用会让盘前整屏退回原币种。陈旧照常显示 + 标注取数时刻（spec Edge Case）。**本片不设陈旧阈值**：没有阈值就没有「阈值定错导致整屏降级」这一类失效面，而 FR-007 要求的时刻已上屏、用户自己能判。

#### D7 — mobile 状态落点（⚠️ 推翻 plan mode 文件 §250-251）

**屏组件 `trading-account-screen.tsx` 的 `useState`**，向下传 prop；🚫 放 `trading-account-store.ts`。

依据是 083 自己的 e2e **双臂实证**（不是推断）：`apps/mobile/e2e/optionsdesk-trading-account-positions.spec.ts:652` T015③b 折叠后**进持仓详情再返回 ⇒ 仍折叠**（`:661` 注「列表屏未卸载」）；同文件 `:616` T015③ 折叠后**返回雷达再进入 ⇒ 全部展开**（`:639` 注「本屏卸载」）；`:1346` T017⑩ 复证「从详情返回，列表屏未卸载」。⇒ **屏级 `useState` 的生命周期恰好等于 FR-005 要的语义**（详情返回保持 / 离开该页复原），而放进程内 store 会让「离开交易账户页再进入」仍保留上次币种 —— **直接违反 FR-005 与 SC-005**。

⚠️ **必须放屏组件、不能放列表组件** `TradingAccountPositions`：切分段 positions↔orders 会卸载后者（`trading-account-screen.tsx:46-52` 是条件渲染），放那里会让切个分段就重置，违反 FR-005「本次停留期间保持」。

状态形状是**每个市场页签一格**（`Record<'us' | 'hk', DisplayCurrency>`，初值各自为该市场原币种），切页签只读另一格、不写任何格 ⇒ FR-005 的「两个页签各记各的」由形状本身保证，**不需要「是否切过」标志**（原 `touched` 设计随 spec Session 2026-09-17 一并去掉：那个标志既要维护又会判错 —— 用户手动选中「与当前市场相同的那一档」时它无法从币种值反推）。

#### D8 — mobile 选择器与汇率行（mockup 五帧为准）

- 位置：**并入「同步于 …」行右侧**（`trading-account-positions.tsx:241` 的 `PositionsMeta`，`margin-left: auto` 形态）。mockup 实测该行文本实占 156px / 余量 234px；「参考汇率」行余量仅 83px、列头行高 31px 均放不下。省掉一整条控件行（57px），列表可用高度 542 → 599px。
- 形态：收起态显示当前币种 + `▾`（复用 083 的 `CARET` 几何符号，`:73`）；展开为右对齐浮层，三档带勾。mockup 新增 4 个类（`.cursel` / `.curmenu` / `.curopt` / `.tick`），取值全部来自既有 `--nvy-*` token，**0 新 token、0 新色**。
- 不改列表既有列宽与字号（`COL` 常量 `:64-69`；SC-007 逐项比对）。降级行的币种标用行级 `.chip`（`:448-454` 既有形态）；**组级「合计不完整」挂 `.c-mv` 与 `.c-pl` 合计值下方、用 `.num2` 而非 `.chip`** —— 后者带 `align-self: flex-start`，塞进 `align-items: flex-end` 的列会左右参差。**两列都要标**（FR-006 的「聚合值」是两个，只标一列会让人以为另一列完整）。
- 汇率行：仅在展示币种 ≠ 当前市场原币种时出现（FR-007 / FR-011）；加载中显示加载态，不先渲染未折算数字再跳变（mockup 帧 ④）。

#### D9 — 文案

`optionsdesk-copy.ts` 的 **083 既有 `tradingAccountPositions` 段内新增** key（币种档位标签、参考汇率行、加载中、降级行标、组不完整标、选择器 a11y 名）。不并入 081 的 `tradingAccount` 段（`trading-account.rules.spec.ts:46-50` 断言该段全部字符串不含「暂无 / 空仓 / 无数据」，并进去会当场红）。币种一律三字母代码（`市值（USD）` 体例，`:1472-1474` 已有 `marketValueLabel`）；不用货币符号。

### 测试映射（`state_branches` 21 条 → 落点；analyze 期逐条 grep 对账）

| 层 | 文件 | 覆盖的 `state_branches`（`spec.md:18-38` 行号） |
|---|---|---|
| Server Small | `fx-rate.rules.spec.ts` | 25, 26（解析/哨兵/N 对校验的前置） |
| Server Small | `display-currency.rules.spec.ts` | 23, 24, 25, 26, 27, 28, 29, 30 |
| Server Small | `fx-rate-cache.adapter.spec.ts` | 35（加载态的前置：缓存未命中 / single-flight / 失败不入缓存） |
| Server Medium | `apps/server/test/integration/optionsdesk-085.display-currency.it.spec.ts` | 18, 19, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 36, 37 |
| Server Medium（env-gated `RUN_FX_VENDOR_IT`，默认 skip） | 同上文件内 `describe.skipIf` 块 | 真 vendor 字段校真（22 字段 / `f3` / 新浪 `idx3` / 反向 MISS） |
| Mobile vitest | `display-currency.rules.spec.ts` · 文案穷举 spec | 18, 19, 20, 21, 22, 31, 32, 33, 34, 37 |
| Mobile E2E | `e2e/optionsdesk-trading-account-positions.spec.ts` 扩臂 | 18, 19, 20, 21, 22, 31, 32, 33, 34, 35, 36, 37, 38 |
| Contract Smoke | `e2e/contract-smoke/optionsdesk-trading-account.contract.ts` 加一条 | 18（带 `displayCurrency` 的请求打真 server） |

**SC 落点**：SC-001 / SC-003 = display-currency rules 固定数据集 + IT 降级臂 · SC-002 = rules「折算前后组顺序相同」断言（同屏同币种 ⇒ 等比例缩放）· SC-004 = e2e 切档后断言无二次跳变（react-query 每档独立 key）· SC-005 = e2e 三臂（D7）· **SC-006 = 逐字段比对**：同一夹具下不带 `displayCurrency` 与带「该市场原币种」两次响应**逐字节相同**（这是「上线前后一致」唯一可机器化的形态）· SC-007 = 列宽/字号常量未变 + e2e 样式断言。

### 新增 / 触碰文件清单（tasks 拆分的物料面）

- **server 新增**：`optionsdesk/fx-rate.port.ts` · `fx-rate.rules.ts` · `tencent-fx.adapter.ts` · `sina-fx.adapter.ts` · `fx-rate-fallback-chain.adapter.ts` · `fx-rate-cache.adapter.ts` · `display-currency.rules.ts`（+ 对应 `.spec.ts`）· `apps/server/test/integration/optionsdesk-085.display-currency.it.spec.ts`
- **server 触碰**：`optionsdesk/list-broker-positions.usecase.ts`（可选入参 + 折算 + 响应带汇率信息）· `broker-account.controller.ts`（query）· `broker-account.dto.ts`（DTO + 装饰器，**nullable 标量必显式 `type`**）· `optionsdesk.module.ts`（FX port 装配，按 `marketdataConfig.kind` 绑定：`mock` 档绑**调用即抛**的拒绝壳，照 `refusing-collection.adapter.ts` 立意 —— 本地 dev 不得真打腾讯）· `config/marketdata.config.ts`（两个带 `.default()` 的 baseUrl）· `scripts/checks/check-env-sync.ts`（`ALLOWLIST` 登记两个可选 key）· `apps/server/openapi.json` + `packages/api-client/src/generated/`（regen）
- **mobile 新增**：`src/optionsdesk/display-currency.rules.ts`（+ spec）· `currency-selector.tsx`
- **mobile 触碰**：`trading-account-screen.tsx`（D7 状态）· `trading-account-positions.tsx`（选择器 + 汇率行 + 降级标）· `use-trading-account-positions.ts`（query key 加币种）· `trading-account-positions.rules.ts`（标记判定）· `optionsdesk-copy.ts`（D9）· `e2e/optionsdesk-trading-account-positions.spec.ts` · `e2e/contract-smoke/optionsdesk-trading-account.contract.ts`

### 未能验证的事项（如实留档，不卡 plan）

- **新浪 `idx3` 的更新频率**：本轮 60 秒 / 6 轮（10s 间隔）采样中 `idx3` 逐字不变，而同窗口腾讯 `whUSDHKD` 的 `f3` 动了一次、新浪自己的时间戳也在推进 ⇒ **无法区分「`idx3` 是稳定的即期价」与「`idx3` 是个不更新的死字段」**。它只影响**备源**（腾讯全败时才用），且 D5 已把上屏时刻锁在我们自己的采集时刻、不会拿 vendor 时间戳背书。**消法**：impl 期 `RUN_FX_VENDOR_IT` 块内做一次长窗（≥ 30 分钟、跨在岸 CNY 开盘）采样，断言 `idx3` 会跟着动；若证实是死字段，则把新浪降为「仅在腾讯失败时提供一个明确标注更旧的值」或整条去掉备源（FR-006 的降级路径本就覆盖「取不到」）。
- **腾讯 CNY 报价偏差是否稳定**在 0.08% 量级（只做过一次同刻对拍）。不影响本片用途（看总量），但若将来用于结算 / 对账须先补多轮对拍。
- **`f11` 语义**（PoC 期 spread 从 `0.0029` 缩到 `0.0002`、又曾恰等于 `f6`/`f7`）⇒ **不消费它**。

## Complexity Tracking

无原则违背。越出 optionsdesk 目录的改动与一处已知重复，记录在此便于 review 定位：

| 改动 | 为什么需要 | 更简单的替代为何不行 |
|---|---|---|
| `config/marketdata.config.ts` 加两个 FX baseUrl | 两个端点与已有 `tencentCalendarBaseUrl`（`web.ifzq.gtimg.cn`）**不同子域**，照 `eastmoneyClistBaseUrl`（`:20-21`「同 vendor 不同 host → 独立 baseUrl，共享 profile/限频」）先例；复用 `MARKETDATA_PROVIDER` 的 `kind` 门控使 mock 档能绑拒绝壳 | 新建 `optionsdesk.config.ts` = 为两个带默认值的 URL 多一个 config 注册单元与一套测试 boot 占位；硬编码 URL = env-gated 真 vendor IT 与将来迁移都没有覆盖点 |
| FX 解析纯函数在 optionsdesk 另落一份（与 `alert/realtime-quote.rules.ts` 并存） | 股票 88 字段 vs FX 22 字段，字段下标完全不同；跨 ctx import 他 ctx 的 `*.rules.ts` 被 eslint `boundaries` 拦（ADR-0053，`optionsdesk` 的 `disallow` 含 `marketdata-rules`，同理不放行 alert） | 把两者上提共享包 = 触发 ADR-0053 的「升 `packages/`」重审，为一个 22 字段解析器做平台级改造，Senior Engineer Test 不过 |
| FX adapter 留 optionsdesk、不进 `integrations/` | ADR-0058 准入要求 ≥2 ctx 复用，FX 当前单消费者；marketdata 自己的 5 个 vendor 客户端同样不在 `integrations/` | 现在就迁 = 为单消费者建跨 ctx 共享面，且要新开一条 `optionsdesk → integrations` 依赖边 |
