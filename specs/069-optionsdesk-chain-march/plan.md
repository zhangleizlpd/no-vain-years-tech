---
feature_id: 069-optionsdesk-chain-march
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-30'
updated_at: '2026-08-30'
adr_refs: ['0043', '0062', '0064', '0066', '0067', '0068']
context7_verified: []
---

# Implementation Plan: 清链与行军选档 — 凸包净链、φ+形状行军、逐档可解释

## Summary _(mandatory)_

在 068 实时窄召回产物之上，为**收租视角**落地 ADR-0068 P3：特征加工层新增纯几何清链管道（报价护栏全域 / 凸包 / tick-共线合并 / 劣档三类标），精排层扩「排序 + 选档」（φ+形状行军产出每 K 三态判决），mobile 新增每 K 审计弹层（13 类四家族逐档可解释）。建仓视角零改动（clarify Q4 / ADR-0068 勘误）；离线档读路径零改动（清链/行军接线仅实时档，标定用收盘数据离线跑）。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 单 feature 单分支单 PR（跨端原子 merge，§V）；TDD 红绿闭环；扁平/贫血/护城河零违背（本片零跨 ctx 新增、零新表、零写路径）；mockup-first 已走（design/ 五帧 + v2）。无需 Complexity Tracking。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 既有 optionsdesk IT（Testcontainers 真 boot）承载——本片不新增 endpoint，扩展既有选约表响应；`state_branches` 19 条在 usecase IT 穷举（D6）。
- [x] **Mobile / Web**: US1–US3 golden path 走 Playwright Expo Web hermetic e2e + 契约冒烟扩展断言（D6）；真机 dev-client 手动过一遍推荐章 + 弹层。
- [x] **Evidence**: impl 期 IT/e2e commit + spec 标定实测段（体例同 068）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

零新三方依赖（纯函数 + 既有 RN bottom-sheet 范式）。**Evidence**: N/A。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] 本 feature mono-native（069 spec/ADR-0068 均 mono 原生），无迁移面。**Evidence**: N/A — feature is mono-native。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR      | Open Question affected                                       | Classification | Mitigation / next step                                                            |
| -------- | ------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------- |
| ADR-0068 | sunset：fillMode 落地时凸包/行军按 mid 重算；laddering 落地时「单选停点」前提部分消失；φ-exit 落地时入出同旋钮升格 | accepted-as-is | 三条均为 future 触发器，本片按 bid 口径 + 单选停点实现，sunset 表已承载重审时机     |
| ADR-0067 | 缺失语义族（`source_unavailable` 同族）                      | mitigated      | 审计 #13「报价缺失 / fwd 不可算」沿 0067 缺失语义呈现（诚实缺失，非错误），文案走既有体系 |

其余 ADR 无受影响 Open Questions（`rg -l "Open Question" docs/adr/` 逐一扫过）。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 隔离单元测试（本片预期零新 lifecycle 组件，禁令仍全文有效）。
- **MANDATORY INTEGRATION**: usecase 层验证必须 `Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()` 真 DI 容器（Testcontainers PG+Redis）。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 19 条每条在 IT 有对应 `it()` 块，100% 路径覆盖（含建仓零改动边界、bootstrap 宽窗、净链剔空三条非 happy-path）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：Flat Module / Anemic + Zero-Class / No Repositories / The Moat。本片**零新表、零写路径、零跨 ctx 新增、零新 endpoint**——全部改动落 `apps/server/src/optionsdesk/` 既有读路径 + `apps/mobile/src/optionsdesk/` 呈现层 + 契约 regen。

**D1 · 判据文件面——两个新 `*.rules.ts`（纯函数，ADR-0043 §4）**：

- **`leg-fwd-chain.rules.ts`（特征加工层，θ 无关纯几何）**：收租段每 K 到期日梯 → fwd 链构造（边际费率 = 相邻档权利金差 / 时间差，恒等式 `年化₂ = [T₁·年化₁ + (T₂−T₁)·fwd]/T₂` 为性质测试锚）→ 凸包栈扫描（核心机器不变量 = 终态 fwd 单调递减；`while` 级联弹出，深级联输入性质测试锁死）→ tick-共线合并（垂距 `d < tick/(K−bid)` 判共线，段内 fwd 时间加权无损并段；非共线禁合并）→ 劣档三类标（凹陷支配 / 绝对支配附疑似陈旧 / 共线档，只标不删）。**13 类四家族审计枚举 `MarchExclusionCategory` 单点落本文件**（A/D 家族由本层产出，B/C 家族由 D2 march 层 import 复用——枚举恰好一处）。
- **`leg-march.rules.ts`（精排层，θ 相关）**：φ+形状双条件行军（延伸 = fwd ≥ φ ∧ 衰减 ≤ β × 前段；前段衰减 ≤ 0 退化 γ 绝对帽）→ 停（截链尾，禁中段剔除）→ 停点闸（`OI_MIN` 收租口径，不过闸沿凸包回退；起点不设闸）→ 档界终检 → 三态判决（推荐档 / 无合格档 / 整梯无可成交；净链空 ⇒ 整梯无可成交）。θ=自身年化模式（≡ 年化 argmax）同文件第二实现，两模式共用行军骨架、各配三行预言机。
- **tick 分辨率取法（spec Deferred 决策）**：不引 vendor 元数据面——tick 从**该 K 梯自身报价推断**：取梯内全部 bid/ask 报价的最小正 price-increment 公约粒度，fallback 美股期权标准档（premium < $3 ⇒ 0.05 / ≥ $3 ⇒ 0.10，penny 名单不维护——推断优先，标准档只兜底）。判据零自由参数不破：tick 是**观测量**不是旋钮。共线阈值对 tick 高估的敏感方向 = 更保守（少合并），可接受。

**D2 · 接线点——只动实时档收租视角**（FR-017 / FR-019 落点）：

- `get-legs.usecase.ts` 现管道：召回（`recallCandidates`）→ 派生（`computeLegRates` :664/:676）→ 排序（`layeredRanker` :760）→ DTO。本片在**成员判定后、排序旁路**插入：`实时开态（含 bootstrap 宽窗）∧ 收租视角` ⇒ 按 K 分组收租段成员 + 带外横档 → D1 清链 → 行军 → 判决与审计条目挂响应。排序器 `layeredRanker` 与行序**零改动**（FR-018：推荐是行上叠加标注，不是重排）。
- **报价护栏落 `leg-recall.rules.ts`**：`ask ≤ bid ⇒ 剔候选 + 留痕`，前置于 `relativeSpread`（:238/:284，负值放行缺口在源头闭合），**全视角生效**（收租 scope 唯一例外，clarify Q4）；被剔腿以 #1 类目进该 K 审计条目。
- **离线档零改动机器判据**：沿 068——离线路径既有 IT + golden 零 diff；建仓视角零改动判据 = 建仓请求响应新字段恒 null/缺省 + 既有建仓 IT 零 diff。

**D3 · 契约面设计意图**（prose，SoT = swagger 装饰器）：

- 选约表实时响应（收租视角）新增两块：**per-K 判决数组**（strike · 三态枚举 · 推荐档到期日 · 净链小结计数：段内/净链/剔/并/标）与 **per-K 审计条目数组**（到期日或合并段标识 · `MarchExclusionCategory` · **结构化数值证据字段**——fwd/φ/β 基准/OI/`OI_MIN`/bid/ask 等按类目取用，nullable）。文案在 mobile `optionsdesk-copy.ts` 映射，server 不拼展示字符串（ADR-0064 不变量 ②：客户端不反推判定、只格式化契约值）。
- 内联下发不设独立弹层 endpoint：窄召回收租候选是小集合（068 实测窗 ≤180 码、判腿后更少），审计条目量级 = 每 K 段内档数，inline 无膨胀风险；离线响应与建仓视角该两块恒缺省（向后兼容，nullable）。
- ⚠️ nullable string 字段的 `@ApiProperty` **必须显式 `type: 'string'`**（否则 orval 误生 objectmap——012 实撞）；regen 走 `export-openapi` → api-client → mobile 同 PR（api-contract-trigger）。

**D4 · 参数单点与标定**（FR-010 / SC-007）：

- **φ 不新造数值**：取值 = 既有收租年化档界引用——`leg-tier.rules.ts` `TIER_FLOORS_BY_BASIS.annualized`（good=0.15 / acceptable=0.10，:52）；「可配置」= 选用哪个档界（默认 good），档界数值恰好一处不破（ADR-0064 不变量 ③）。
- β / γ / `OI_MIN` 三个新常量落 `leg-march.rules.ts` 顶部（带标定注释），注册 `check-optionsdesk-rule-constants.ts` 守卫表；🚨 取值避开既有档界值撞车（守门脚本认值不认名——050 实撞纪律）。θ 模式开关走 server config（默认 φ=意图档界；实现期按 config-add 流程落全部位置，UI 不暴露，clarify Q3）。
- **标定回放**（scratchpad tsx 不入仓，体例同 067/068）：收盘全量真实链构造 K 梯 → 清链 → 行军，两个证据面：① owner 已留痕真实裁决样本**零反序**（SC-001；样本源 = 2026-08-29 设计对焦的裁决集，标定前向 owner 取原始清单）；② 凸包单调零违例 + 共线合并前后判决不变（SC-002）。四参数锚点回写 spec「标定实测」段。

**D5 · mobile 面**（US1–US3；mockup baseline = design/ 五帧 v2）：

- `leg-row.tsx` / `leg-row.rules.ts`：收租视角行内推荐章 + 三类劣档灰显微标（凹/陈/并），判定纯函数消费契约字段；建仓/全腿行零改动（既有 050 带内标体系不动，FR-019）。
- 新建 `march-audit-sheet.tsx`（+ `march-audit.rules.ts` 呈现判定纯函数）：bottom sheet 骨架沿 `leg-criteria-sheet.tsx` 范式；题头判决 chip 三态 + 净链小结 + 家族色条逐档行 + φ/闸只读读数行；两类诚实空态文案（中性灰非错误）。13 类文案 + 判决文案 + 空态文案集中 `optionsdesk-copy.ts`。
- **弹层入口 = 轻点收租视角腿行**（mockup 决策沿用；实现期确认腿行现无 onPress 冲突——若与既有手势/导航冲突，回退行尾 affordance，属呈现自由度不动 spec）。a11y：行加 accessibilityHint、弹层可关闭焦点管理沿既有 sheet 范式。
- 测试分层：呈现判定 vitest（`*.rules.ts` logic-only，禁组件 render 测）；交互（开弹层/三态/空态/推荐章可见性）Playwright Expo Web hermetic e2e；契约对齐 = contract-smoke 既有 optionsdesk 条目扩断言（判决 + 至少一条带数值审计条目真落）。

**D6 · 测试与机器守卫总表**：

- 纯函数性质测试（vitest）：凸包深级联收敛（`while` 误写 `if` 必红的构造输入）· 共线合并次序无关 + 无损（合并前后行军判决不变）· 行军两模式各三行预言机（φ=档界模式 / θ=年化 argmax 恒等式模式）· 护栏交叉报价 + `relativeSpread` 负值回归。**每个新测试证明「能红」**（定向变异留档）。
- usecase IT（Testcontainers）：`state_branches` 19 条逐条 `it()`；离线 golden 零 diff + 建仓零 diff 两条回归闸。
- `check-optionsdesk-rule-constants.ts`：β/γ/`OI_MIN` 入守卫表；`check-time-semantics` 照跑（fwd 分母 = 日历天差，DTE 语义沿 #263，零新时间轴）。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：本片零写路径（全读侧纯函数加工），无 tx 面；实时外呼纪律沿 068 D1 原样。
- **安全**：不触鉴权/PII 面。
- **前端（mobile）**：无表单；bottom sheet 沿既有范式复用 `~/theme` + `~/ui`，0 新 token（mockup handoff 已锁视觉）；文案禁感叹号、空态禁错误红。
- **时间语义**：fwd/衰减全部日历天口径（`daysToExpiry` 语义不动）；`check-time-semantics.ts` 强制；禁新造「今天」判定。

### 决策备选与既有事实核录

**备选否决**：① 先按 θ 过滤年化再跑凸包——ADR-0068 候选表已否（θ 掺特征层 + 伪装混合）；② 审计条目 server 拼展示字符串——否：文案变更须动契约 + 双语言/口径演进僵化，结构化数值字段 + client 映射沿既有 copy 体系；③ 独立审计弹层 endpoint——否：候选集小、inline 零膨胀，多一个 endpoint = 多一份鉴权/降级/契约面；④ tick 走 vendor 元数据面——否：新 vendor 面成本 + 0067 缺失语义连锁，报价自推断 + 标准档兜底已零自由参数；⑤ 行军判决改写 `layeredRanker` 排序——否：FR-018 排序零改动，推荐是标注不是重排（050「禁 DTE 先验」纪律对排序器继续成立）。

**既有事实核录**（2026-08-30 plan 期逐项 grep 核）：

- 管道插点：`get-legs.usecase.ts` `computeLegRates` :664/:676、`layeredRanker` :760；`optionsdesk.dto.ts` 2799 行、`realtimeDegrade` 同源描述块两处纪律沿 068 D5
- 护栏落点：`relativeSpread` 定义 `leg-recall.rules.ts:238`、消费 :284；流动性闸只作用建仓/收租、权利金门槛三 Tab 一律（表见该文件头注释）
- φ 源：`leg-tier.rules.ts` `TIER_FLOORS_BY_BASIS`（:52，annualized good=0.15/acceptable=0.10，量纲小数比例）；`LEG_BASES = ['weekly','annualized']`
- 召回段：`BUILD_RECALL_DTE=[1,49]` / `RENT_RECALL_DTE=[30,365]`（`leg-recall.rules.ts:43/:51`）——行军作用面 = 收租段 K 梯（30–365d），带外横档 = 068 `bandStatus:'out'` 行
- 建仓推荐标单点：`leg-mark.rules.ts:35` `BUILD_RECOMMEND_ABS_DELTA_BAND`（本片零触碰）
- mobile 渲染链：`underlying-detail-screen` → `LegPickerTabs` → `LegTierBar` → `LegTableHeader` → `LegRow`；sheet 范式 = `leg-criteria-sheet.tsx`；文案集中 `optionsdesk-copy.ts`

## Complexity Tracking

无违规，无需 justify。
