---
feature_id: 068-optionsdesk-two-stage-recall
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-30'
updated_at: '2026-08-30'
adr_refs: ['0043', '0064', '0067', '0068']
context7_verified: []
---

# Implementation Plan: 实时窄召回两段式重建 — 窗即召回第一段

## Summary _(mandatory)_

实时档读路径从 064「离线档 + 报价覆盖」重建为两段式窄召回（ADR-0068 P2，server + mobile）：第一段以昨日 Δ 面（`optionDailySnapshot.delta`，库内批读零外呼）经 sticky moneyness 包络 + pad 生成 K-梯形窗选码，第二段对窗内码取同批实时报价、走与离线档**同一个** `recallCandidates` 入口判腿。离线档逐字节零改动；064 的 overlay 机器（尾部覆盖 / 窗绊线）退役；矩形宽窗收窄为 bootstrap 唯一存续场景。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 纯 server + mobile 消费同 PR（§V 单 PR）；模块内扁平、判据落 `*.rules.ts` 纯函数、无新表无 repository；TDD 红绿 per task；跨 ctx 只经既有三 port（064 注入点原样），无新跨 ctx 面。无违规需 justify。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 无新端点（既有 legs 读端点值/形演进）。IT 沿 064 体例（Testcontainers 真 DI + fake snapshot read port）：新 IT 文件覆盖两段式主路 / 三级降级 / bootstrap / 全腿回落 / 带标；既有 `optionsdesk-064.overlay.it.spec.ts` 的**离线腿**用例是 FR-011 零回归的机器证据（实时腿用例随范式退役重写，见 D1）。
- [x] **Mobile / Web**: P1 story 的 golden path 走 Playwright Expo Web hermetic e2e（带内/带外标 + 降级横幅 + 全腿口径标注）；契约面加 contract-smoke 一条 happy-path。
- [x] **Evidence**: `apps/server/test/integration/optionsdesk-064.overlay.it.spec.ts`（既有装配体例）+ `apps/mobile/e2e/contract-smoke/064-intraday-leg-quotes.contract.ts`（实时契约冒烟先例）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

N/A — 零新依赖（Δ 面在库、实时批走既有 `OPTION_SNAPSHOT_READ_PORT`）。**Evidence**: N/A

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

N/A — feature is mono-native。**Evidence**: N/A

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0068 | sunset triggers（hk 实时接线 / fillMode / laddering / φ-exit / 财报复测 / P4） | accepted-as-is | 均非本片触发——本片就是其 P2 实施载体；市场参数化仍「留形状」 |
| ADR-0064 | §7 修订清单（召回层两段式 / 精排扩职 / 不变量 ④ 升级） | mitigated | 召回层修订由本片落地；精排扩职与 ④ 升级归 P3；不变量 ②③ 在 D2/D7 逐条核对不破 |

`rg -n "Open Question|待决|未决" docs/adr/0064*.md docs/adr/0067*.md docs/adr/0068*.md` 无本片外的未决项。**Evidence**: ADR-0068 §实施载体。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 本片不触 Guard / Interceptor / Filter / Pipe（防守性保留该禁令）。
- **MANDATORY INTEGRATION**: adapter 的两段式路径验证必须 `Test.createTestingModule` 真 DI（PG Testcontainers + fake `OPTION_SNAPSHOT_READ_PORT`/`MARKET_STATE_PORT`/`TRADING_CALENDAR_PORT`），沿 064 IT 装配体例；🚫 禁 `new PrismaLegRetrievalAdapter(...)` 手拼单测替代 IT。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 13 条每条有对应 `it()`（分层：Δ 面→窗的纯函数分支落 rules 单测；路径级分支落 IT）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：Flat Module / Anemic + Zero-Class / No Repositories / The Moat。本片跨 ctx 面**零新增**——三个 marketdata port（`OPTION_SNAPSHOT_READ_PORT` / `MARKET_STATE_PORT` / `TRADING_CALENDAR_PORT`）注入点与 `CROSS-CONTEXT-SYNC` 注释原样；`instrument`/`optionContract`/`optionDailySnapshot` 只读直查沿既有 `CROSS-CONTEXT-READ` 注释；`anchor.intradayPrice` 读是 intra-ctx 🚫 勿挂假注释。

**D1 · 读路径二分——offline 原样，realtime 整段重写**（FR-001/011 的落点）：

- `loadChainWithWindow` 保留为**离线唯一路径**：摘除尾部 overlay 插点后对离线入参逐字节等价（FR-011 机器判据 = 既有离线 IT + golden 零 diff）。
- 实时路径新建独立方法（`loadRealtimeNarrowChain`）：闸（`resolveRealtimeGate` 原样）→ #286 市场 guard（原样，闸后）→ 视角判定（非单意图视角 ⇒ 回落收盘档，D6）→ 三级基准（D3）→ Δ 面批读 + K-梯形窗（D2）→ `window_over_cap` 保险丝（`OPTION_SNAPSHOT_MAX_CONTRACT_CODES = 399` 原样，窗实测 ≤180 后它是纯保险）→ 一次批取 → 组链（D4）→ `recallCandidates`（入口零改动）。
- **退役清单**（随范式废弃，非顺手清理）：`overlayRealtimeQuotes` / `applyRealtimeBatch` / `loadRealtimeBaselineChain`（其冷启动职责被 bootstrap 宽窗吸收，D2）/ `windowTripwire` + `reportWindowDrift`（绊线职责移交标定回放，D8）/ `withinWindow` 的实时消费。064 实时腿 IT 用例随范式重写；**离线腿用例与 golden 一字不动**。
- 降级回落形态统一：guard / 基准三级失败 / over_cap / 外呼失败 ⇒ 零外呼（或零再外呼）走离线路径产物 + 既有 `realtimeDegrade` 标——**值域零扩张**（第三级复用 `window_basis_stale`，其语义本就是「定窗基准拿不到 ⇒ 回落」；Q2 裁决的「实时不可用」呈现由 mobile 既有四条降级文案承载）。

**D2 · Δ 面与窗判据单点**（FR-002/004；ADR-0064 不变量 ③）：

- **新建 `leg-delta-surface.rules.ts`**：纯函数单点——入参（昨日面行 `{strike, expiryDate, delta}[]`、昨日 `underlyingSpot`、今日 spot、意图 Δ 带、pad、意图 DTE 段、今日各到期日 DTE、收租 axis 帽），出参 `{ windowKs: Decimal[], expiries: Date[], bandPrediction: Map }`。机制：逐到期日在昨日面上找 Δ 落带的 K 区间 → 折算 moneyness 区间（÷ 昨日 spot）→ 取段内包络 + pad → 乘今日 spot 得 K 界 →「任一到期日落带即进窗」∩ 收租帽；进窗 K 附段内全部到期日。
- **Δ 面部分缺失**（spec Edge 1）：缺失点不参与包络（按有读数的 (K,expiry) 求包络）；某到期日整列缺 Δ ⇒ 该到期日不贡献包络但仍随进窗 K 附带；**整面无一个 Δ 读数 ⇒ 判 bootstrap**（与新锚同路）。
- `leg-window.rules.ts` 重定位：`legWindowFor` 矩形包络降格为 **bootstrap 宽窗**（改名 `bootstrapWindowFor`，0.7/1.05 两常量语义改注为 bootstrap 专用）；文件头「窗 MUST NOT 当 filter」教义改写为「实时档窗即召回第一段；教义存续范围 = bootstrap 首日」（ADR-0068 §决策 2 窗教义修订）。`WINDOW_SUPPORTED_MARKETS` 与 guard 原样。
- **收租 W 帽与 067 axis 单点冲突的解**：把 `axis = Prisma.Decimal.min(spot, w)` 从 `resolveQualityCeiling` 函数体抽为导出单点 `resolveCeilingAxis(spot, w)`（仍在 `leg-recall.rules.ts`），`resolveQualityCeiling` 与窗帽两处消费之。全仓 `Decimal.min(spot, w)` **仍恰好一处**——067 spec SC-003 的 `rg` 判据语义不破（067 spec 不回改，本片 SC-004 承接同判据）。
- 意图 Δ 带界（建仓/收租各一对）+ pad + bootstrap 两比例 → 常量注册进 `check-optionsdesk-rule-constants.ts` 守卫表（D8）；带界/ pad 初值按 D8 标定回放定，plan 不拍数。

**D3 · 三级基准链**（FR-006；spec branches 4/5/6）：

- `resolveWindowBasis`（`resolveWindow` 升级版）：① `anchor.intradayPrice` 且 `isIntradayFresh(intradayAt, now)`（90s 单点，061 语义原样）⇒ 直接用；② 陈旧/缺失 ⇒ **补发一次** `getSnapshots({underlyingSymbol, contractCodes: []})` 只取标的行（shim 若拒空批，实现期以「标的行必随批返回」的最小合法形态处理——评估点，禁为此新增 vendor 面）；③ 补发失败 ⇒ `window_basis_stale` 零再外呼回落收盘档（Q2 裁决形态）。
- 🚫 不新造 TTL 缓存（第二个会漂移的 spot 真相源）；🚫 不拿昨收定窗（昨日 `underlyingSpot` 只用于 moneyness 折算，不当今日基准——两个用途注释里写死区分）。
- 补发成功的实时 spot **同时是** recall context 的 spot 与 067 axis 的输入（同刻同值，无第二处 spot 真相源）。

**D4 · 实时链组装口径**（spec branch 1；ADR 决策 1「DB 只出骨架 + OI」）：

- 腿行来源：报价七值 + Δ + iv 取实时批行；**OI 取库内最近一期快照**（`oiAsOf` = 该期，沿 066 实时基线口径「整批 OI 同源」）；DTE 按今日（`daysToExpiry` market 参数化，#263 语义）；`priceKind` 逐行 realtime；批内标的行给 spot 与 `quoteAsOf`。
- 每请求单视角 ⇒ 链级单 `quoteAsOf` 天然成立（spec branch 9 的「两视角两时刻」由读端每视角独立请求承载，port/DTO 形不变）。
- 实时批部分缺行（`partial_miss`）语义原样：问 N 回 M，缺失腿不进候选、行级 `priceKind` 承载。

**D5 · 带内标与带外横档**（FR-009；spec branch 13）：

- `LegChainRow` 增 `bandStatus: 'in' | 'out' | null`（离线恒 null）；第二段判腿**之后**按同批实时 Δ ∈ 意图带打标——标是呈现语义，🚫 不参与 `recallCandidates` 成员判定（判据单点零改动，FR-005）。
- DTO 下发同名字段；`optionsdesk.dto.ts` 两处 `realtimeDegrade` 同源描述块改一处必改两处（盘点确认 :1810/:2470）。

**D6 · 视角绑定与全腿回落**（FR-008/014；Q1 裁决）：

- 实时窄路径要求 query 为**单意图视角**；`all`（或防御性的多视角集合）⇒ 直接走离线路径产物，`priceKind: 'eod_close'` 既有机制标口径（mobile 已按 `priceKind` 切列头口径，零新字段）；不定带、零外呼。
- use case 层不改请求模型（读端已按视角发请求）；adapter 内按 `query.perspectives` 判定，防御分支 fail-closed 到收盘档。

**D7 · mobile 面**（FR-012；无 Mockup，Q3 裁决）：

- `leg-row.tsx`/`leg-row.rules.ts`：带内标渲染（带外横档 = 灰阶弱化 + 「带外」角标，具体视觉沿既有「收」角标体例）；`leg-tier-bar.rules.ts`/`optionsdesk-copy.ts`：降级文案映射复核（值域未扩张 ⇒ 预期零新文案，验证既有 `window_basis_stale` 文案与 Q2 裁决语义吻合）；全腿视角实时开态的口径标注走既有 `priceKind` 文案链。
- 测试分层：判据纯函数 vitest（`*.rules.ts`）；渲染/交互 Playwright Expo Web hermetic e2e；契约对齐 contract-smoke 一条（实时开态窄候选 + bandStatus 断言）。ADR-0064 不变量 ②「客户端 MUST NOT 反推」沿用——band 判定只从契约来。

**D8 · 标定与机器守卫**（SC-001/002；spec branch 覆盖预检的证据面）：

- 标定回放脚本（scratchpad tsx，照 067 T004 体例不入仓）：取库内相邻两期，用 T-1 日 Δ 面对全量 us 锚生成窗，对照 T 日收盘全量召回的真候选——漏腿数（SC-002 = 0 为 pad 标定判据）+ 窗码数分布（SC-001 max ≤ 180）落 spec「标定实测」段。
- `check-optionsdesk-rule-constants.ts` 同步：不变量 #2/#3（窗边界禁手写）改指向新窗规则文件；#5（port 零存储概念——`bandStatus` 是业务呈现语义非存储概念，确认不误伤）；#7（成员判定单点）不动；新常量（Δ 带界 × 2 / pad / bootstrap 比例）入守卫表。
- 067 SC-003 判据承接：`rg "Decimal\.min" apps/server/src/` 仍一处（`resolveCeilingAxis`）；`0.8` 仍仅 `anchor.rules.ts`。

### 🚨 Impl Guardrails

- **并发/事务**：本片零写路径（`anchor.intradayPrice` 只读）；实时外呼禁在任何 tx 内（split-tx 心智，既有 loadChain 头注释沿用）。
- **安全**：不触鉴权/PII 面。
- **时间语义**：DTE 基准 = 交易所今天（`daysToExpiry` + `exchangeCalendarDate`，#263/#274 语义不动——#274 的 hardcode `'us'` 缺陷**不顺手修**，跟踪不变）；`oiAsOf`/`sessionDate`/`quoteAsOf` 三轴语义沿 port 注释；`check-time-semantics` 照跑。
- **契约**：值/形演进走 `export-openapi` → api-client regen → mobile 同 PR 消费（api-contract-trigger）；`bandStatus` 为 nullable 枚举新增，响应形状向后兼容。

### 决策备选与既有事实核录

**D1 备选否决**：① 在 overlay 机器上继续修补（把窗换成梯形）——否：覆盖范式与窄召回定位根本冲突（ADR 候选表第一行），且混合口径缺口原样保留；② 实时路径也复用 `loadChainWithWindow` 加分支——否：两范式共函数体 = 每个分支点双倍判断，离线「逐字节零改动」无法机器证明。

**D2 备选否决**：① 窗判据放 adapter 内——否：第二个判据点，违 ADR-0064 不变量 ③；② BS 反推 K 区间——ADR 候选表已否（σ 不动点）；③ 帽处手写 `Decimal.min`——否：破 067 单点，`rg` 判据当场红。

**D3 备选否决**：TTL spot 缓存 / 昨收定窗——ADR 候选表已否（第二真相源 / 陈旧轴）。

**既有事实核录**（Explore 盘点 2026-08-30，锚点已逐项核）：

- `RealtimeDegradeKind` 五值单点在 `leg-retrieval.port.ts:193`；`window_basis_stale` 语义 =「定窗基准缺失/陈旧零外呼回落」——第三级复用零值域扩张
- `resolveWindow` 现状**无补发**（基准陈旧一律回落）；基准 = `anchor.intradayPrice/intradayAt`（intra-ctx 点查），30s tick 由 `sync-anchor-intraday.scheduler` 写入，`INTRADAY_FRESHNESS_SECONDS = 90` 单点在 `intraday-spot.rules.ts:38`
- `OPTION_SNAPSHOT_READ_PORT.getSnapshots({underlyingSymbol, contractCodes})` 上限 399 码整批拒绝不截断；返回行含实时 `delta`；标的行并进同批
- 昨日 Δ 面 = `optionDailySnapshot.delta`（Decimal(16,8) nullable）+ `underlyingSpot`，按 `(contractId, sessionDate=最近一期)` 库内批读零外呼
- port 窗零泄漏是机器判据（`check-optionsdesk-rule-constants` #5）；`window-granularity.rules.ts` 与 K 窗**无关**（046 时序图撞名，勿动）
- mobile 渲染链：`underlying-detail-screen` → `LegPickerTabs` → `LegTierBar` → `LegTableHeader` → `LegRow`；降级文案四条在 `optionsdesk-copy.ts:381-395`

## Complexity Tracking

无违规，无需 justify。
