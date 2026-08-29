---
feature_id: 067-optionsdesk-anchor-axis
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-29'
updated_at: '2026-08-29'
adr_refs: ['0043', '0064', '0068']
context7_verified: []
---

# Implementation Plan: 收租成色上界换轴 — axis = min(spot, W)

## Summary _(mandatory)_

收租视角成色上界的锚定轴从 spot 换为 `axis = min(spot, W)`（ADR-0068 P1 片，纯 server）。技术路径：`RecallContext` 增必填 `w` → `resolveQualityCeiling` 内部取 `min` 作轴（axis 定义单点）→ 三个 context 构造点（Prisma adapter / fake adapter / chain-report usecase）各自经既有单点（`resolveEffectiveAnchorValues` + `computeW`）供 W。实时 overlay 路径经同一召回入口自动同轴，零额外改动。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 纯 server、模块内扁平、判据落 `*.rules.ts` 纯函数、无新表无新端点无跨 ctx 写；TDD 红绿 per task；无违规需 justify。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 无新端点。既有 `optionsdesk-064.overlay.it.spec.ts`（Testcontainers 真 DI）夹具即 spot < W 域（us:PEP V=150 ⇒ W=120 > spot=100 ⇒ axis=spot），其 golden 基线**逐字符不变**就是 US3 零回归的机器证据；新增 W < spot 域 IT 用例走同一容器装配。
- [x] **Mobile / Web**: N/A — 契约值变形不变（FR-008），mobile 零改动。
- [x] **Evidence**: `apps/server/test/integration/optionsdesk-064.overlay.it.spec.ts`（既有 49 用例 + 基线夹具）；新增用例随 tasks 落同文件或邻近 IT。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

N/A — 零新依赖。**Evidence**: N/A

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

N/A — feature is mono-native（optionsdesk 无 meta-repo 前身）。**Evidence**: N/A

### Gate 0.4 — ADR-deferred-mitigation Scan Step

no impacted Open Questions — `rg -n "Open Question|待决|未决" docs/adr/0064*.md docs/adr/0068*.md` 零命中本 feature 相关项。ADR-0068 的 sunset triggers 均非本片触发（本片就是其 P1 实施载体）；ADR-0064 不变量 ③ 由 D1 的单点设计满足。

**Evidence**: ADR-0068 §实施载体（P1 即本 feature）

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / mock 隔离单测。（本片不触 lifecycle 组件，此条防守性保留。）
- **MANDATORY INTEGRATION**: 涉 DI 装配的验证必须 `Test.createTestingModule` 真容器（沿 064 overlay IT 体例）。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 九条每条在测试中有对应 `it()`（分层：纯函数分支落 rules 单测，路径级分支落 IT）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：Flat Module / Anemic + Zero-Class / No Repositories / The Moat（跨 ctx 只读直查须 `// CROSS-CONTEXT-READ:`；本片新增读全为 optionsdesk 自有 `anchor` 表 = intra-ctx，🚫 MUST NOT 挂该注释——挂了是假注释，`check-server-moat` 按注释审计）。

**D1 · axis 单点落在 `resolveQualityCeiling` 内部**（SC-003 的落点）：

- `RecallContext` 增**必填** `w: Prisma.Decimal`。🚨 必填而非可选——可选 + 默认「无 W」= 静默回退旧轴，测试全绿而 prod 错轴，正是 fail-closed 纪律要禁的形态。
- `resolveQualityCeiling(spot, w, legs)`：函数内部 `axis = min(spot, w)`，结构项 `min{K ≥ axis}` 与比例项 `axis × (1 + X)` 全部按 axis。**全仓 `min(spot, w)` 恰好出现这一处**；`0.8` 系数仍只在 `anchor.rules.ts` 的 `W_COEFFICIENT` 一处（FR-002 的 `rg` 判据）。
- `recallCandidates` 内 `chain.qualityCeiling = resolveQualityCeiling(context.spot, context.w, legs)`——其余零改动；`defaultCriteria` / 六维条件 / 三态计数结构照旧（FR-007）。

**D2 · W 的供给：三个 context 构造点各自经既有单点取**（蓄意不让 port 入参带 W——port 纪律「系统默认值不进请求」不动）：

| 构造点 | W 来源 |
| --- | --- |
| `PrismaLegRetrievalAdapter.retrieveCandidates` | 新增 anchor 点查（intra-ctx，select 只取 `resolveEffectiveAnchorValues` 所需列）→ `computeW(effective.v)`。+1 次索引点查，亚毫秒级，不动 p95 预算 |
| `fake-leg-retrieval.adapter` | 夹具直供 `w`（测试面显式给数） |
| `GetChainReportUseCase`（进程内召回） | 已持有 `detail.anchor.effective.v` → `computeW`，零新查询 |

- 🚨 **W 派生零第二份**：三处全走 `resolveEffectiveAnchorValues`（v_manual 优先语义单点）+ `computeW`（0.8 单点）。🚫 任何一处手写 `vManual ?? v` 或 `× 0.8` 即违 FR-002。

**D3 · 实时同轴零改动**（FR-006 的结构保证）：overlay 完成后 `chain.spot` 已是实时值，`retrieveCandidates` 用它构造 context ⇒ `axis = min(实时 spot, W)` 自动成立。无第二处轴、无 realtime 分支。

**D4 · 爆炸半径与 mock 工厂扫**：`RecallContext` 是 public export ⇒ 按仓纪律全仓 grep 构造点（含各 `*.spec.ts` 的 context 字面量）逐一补 `w`。build/全腿零变化是**结构性的**（`defaultCriteria` 两者 `strikeMax: null`，qualityCeiling 不被消费）——测试锚点按 FR-003 落「同一批腿、W 任意取值，build/全腿候选逐值相同」。

**D5 · SC-001 对比验证两层落法**：

1. **IT/单测层**：三分支（spot </=/> W）+ 结构项退化（axis 高于全部档）+ 覆盖不触碰 + 三态相对新默认——rules 单测为主，路径级各一条 IT。
2. **dev 全量对比留档**（照 052 T016/T017 标定体例）：tsx 脚本对全部锚算旧轴/新轴的 `qualityCeiling` 与 rent 默认候选数，产出分布对照表落 spec「标定实测」段；预期与 ADR-0068 证据面吻合（spot > 1.143V 的锚默认候选为 0）。脚本进 scratchpad 不入仓（一次性取证，非常驻工具）。

### 🚨 Impl Guardrails

- **并发/事务**：本片零写路径、零事务改动——不触。
- **安全**：不触鉴权/PII 面。
- **时间语义**：不触「今天/DTE/陈旧」判据（换的是价格轴不是时间轴）；`check-time-semantics` 照跑。


### 决策备选与既有事实核录（原拟 research.md，按 preset PROSE-ONLY 并入本节）

**D1 备选否决**：① 调用前算好 axis 传入（签名不变）——否：`min` 散在各构造点，单点性靠纪律不靠结构；② `w` 可选缺省回退 spot——否：静默旧轴，测试全绿 prod 错轴（fail-closed 反面）。

**D2 备选否决**：① port query 带 W——否：违 port「系统默认值不进请求」既有禁令；② adapter 与 use case 各读各算——否：W 派生出现第二份（违 FR-002）。

**既有事实核录**（本 session 代码实证，tasks 期直接引用）：

- `defaultCriteria`：build 与 all 的 `strikeMax` 恒 `null` ⇒ qualityCeiling 仅被 rent 消费（FR-003 结构性依据，`leg-recall.rules.ts:482-506`）
- 064 overlay IT 夹具 us:PEP：V=150 ⇒ W=120 > spot=100 ⇒ axis=spot ⇒ 既有 49 用例与 golden 基线预期逐字符不变（US3 回归网现成）
- chain-report 进程内召回构造 `RecallContext = {spot}` 于 `get-chain-report.usecase.ts:225`，同函数域已有 `detail.anchor.effective.v`
- `resolveEffectiveAnchorValues` 单点在 `anchor-cascade.ts:193`；`W_COEFFICIENT` / `computeW` 单点在 `anchor.rules.ts`

**SC-003 机器判据命令**（quickstart 并入）：`rg -n "W_COEFFICIENT|0\.8" apps/server/src/optionsdesk/ --glob '!*.spec.ts'` 仅 `anchor.rules.ts` 命中；axis 的 `min` 仅 `resolveQualityCeiling` 一处。

## Complexity Tracking

无违规，无需 justify。
