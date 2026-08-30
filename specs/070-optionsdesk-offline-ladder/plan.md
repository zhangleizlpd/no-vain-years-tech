---
feature_id: 070-optionsdesk-offline-ladder
spec_ref: ./spec.md
status: approved
created_at: '2026-08-30'
updated_at: '2026-08-30'
adr_refs: ['0043', '0062', '0064', '0066', '0067', '0068']
context7_verified: []
---

# Implementation Plan: 离线档收租阶梯 — 意图视角切 fwd 阶梯呈现、计划/执行同口径

## Summary _(mandatory)_

为 us 市场锚的**离线档（收盘档）收租视角**接入 069 已落地的清链 + 行军管道（ADR-0068 P4，序列末片）：server 侧把 march 装配门控从「实时开态 ∧ 收租」放宽为「收租 ∧ us」，报价护栏的「剔」在收盘口径降为「标」（成员不变）；契约唯一新增链级 `marchMode` 被动标示字段；mobile 零新组件（报价异常微标 + 弹层口径行 + 模式文案 + 空态核对）。「窗不进离线」护栏按 clarify 裁决升机器双闸（结构闸 + 行为闸），随 PR 回写 ADR-0068。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 单 feature 单分支单 PR（跨端原子 merge，§V）；TDD 红绿闭环；扁平/贫血/护城河零违背（零新表、零写路径、零新 endpoint、零跨 ctx 新增）；mockup-first 免（clarify 裁决，068 先例——组件零新增，UI 规格由本 plan D4 承载）。无需 Complexity Tracking。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 既有 optionsdesk IT（Testcontainers 真 boot）承载——零新 endpoint，扩展既有选约表响应；`state_branches` 11 条在 usecase IT 穷举（D5）。
- [x] **Mobile / Web**: US1–US3 golden path 走 Playwright Expo Web hermetic e2e + 契约冒烟扩断言（D5）；真机 dev-client 手动过一遍离线收租推荐章 + 弹层口径行。
- [x] **Evidence**: impl 期 IT/e2e commit + SC-001 回放结论回写 spec（体例同 067/068/069）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

零新三方依赖（纯函数复用 + 既有组件）。**Evidence**: N/A。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] 本 feature mono-native（070 spec / ADR-0068 均 mono 原生），无迁移面。**Evidence**: N/A — feature is mono-native。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR      | Open Question affected                                                                 | Classification | Mitigation / next step                                                              |
| -------- | -------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| ADR-0068 | sunset #6「离线档意图视角切换 fwd 阶梯呈现（P4）动工 → 重审窗不进离线护栏是否机器强制」 | mitigated      | 本片即 P4；裁决 = 机器双闸（D3），ADR 消费注记随本 PR 回写                            |
| ADR-0068 | 其余 sunset（hk 实时接线 / fillMode / laddering / φ-exit / 财报复测）                   | accepted-as-is | 均非本片触发；hk 排除裁决与「hk 实时接线」触发器同向（hk 标定后续片一并重审）         |
| ADR-0067 | 缺失语义族（`source_unavailable` 同族）                                                 | mitigated      | 审计 #13 沿 0067 诚实缺失呈现（069 已落），离线档同语义零新分支                       |

其余 ADR 无受影响 Open Questions（`rg -l "Open Question" docs/adr/` 逐一扫过）。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 隔离单元测试（本片预期零新 lifecycle 组件，禁令仍全文有效）。
- **MANDATORY INTEGRATION**: usecase 层验证必须 `Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()` 真 DI 容器（Testcontainers PG+Redis）。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 11 条每条在 IT 有对应 `it()` 块，100% 路径覆盖（含 hk 排除、交叉报价剔→标、无收盘链、θ 模式标示四条非 happy-path）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：Flat Module / Anemic + Zero-Class / No Repositories / The Moat。本片**零新表、零写路径、零跨 ctx 新增、零新 endpoint**——全部改动落 `apps/server/src/optionsdesk/` 既有读路径 + `apps/mobile/src/optionsdesk/` 呈现层 + 契约 regen。

**D1 · 接线点（server，近零新增）**：

- **march 门控放宽**：`get-legs.usecase.ts` :640-651 现门控 `perspective === 'rent' && chain.priceKind === 'realtime'` → 改为 `perspective === 'rent' && market === 'us'`（`parsed.market` 同函数已在作用域）。效果矩阵：us 实时收租 = 069 原样；us 收盘收租 = 本片点亮（离线口径）；hk 收租恒 null（FR-001 排除）；全腿/建仓恒 null（原样）。处置口径按 `chain.priceKind` 分派，不由门控分派。
- **「实时请求整体回落收盘档」随离线口径一并点亮**（`realtimeDegrade` 置位、`priceKind='eod_close'`）：回落态呈现本就是收盘档语义，「计划/执行同口径」对它同样成立；FR-012 的「实时档」按 `priceKind==='realtime'` 语义解释（usecase :613-617 既有注释同口径——禁由入参反推档位）。⚠️ plan 级决策，review 时可否决——否决则门控加一条 `realtimeDegrade === null`，一行事。
- **剔→标（FR-006 落点在召回层单点）**：`isCrossedQuote` 判据单点不动（`leg-recall.rules.ts:260`）；**处置**按口径参数化——`priceKind==='realtime'` 维持剔出 pool（069 FR-001 原语义，窄召回本就该剔）；收盘口径下交叉腿**保留在 pool**（照常派生成行）且**仍进** `removedByCrossedQuote` 供 #1 审计与净链除名。`deriveLegs` 零成员判据纪律不破（052 起判据单点在召回层，处置也随判据落同层）。
- 🚨 **既有事实**：护栏现状是三视角**一律剔**（`leg-recall.rules.ts:724-729`），离线路径今天就潜伏成员剔除——069 离线 golden 零 diff 系该期收盘数据**零交叉样本**（069 spec SC-004 留档）侥幸成立。本片把这个潜伏面显式收口，不是引入新行为分叉。

**D2 · 契约面设计意图**（prose，SoT = swagger 装饰器）：

- **唯一新增字段**：链级 `marchMode`（nullable enum：φ=档界模式 / θ=年化 argmax 模式；`march === null` 时恒 null）——FR-009 被动标示的契约载体，值来自 `optionsdesk.config.ts` 的 `marchMode`（069 config-add 已落，本片零新 config）。挂**链级**不挂逐 K：模式是一次请求一个，逐 K 冗余且给「同响应两模式」留不可能态。⚠️ nullable 字段 `@ApiProperty` 显式类型声明（012 纪律）。
- march / audits 块字段**零改动**（069 D3 结构化数值证据面原样复用；#1 条目对离线交叉腿照常产出）。DTO :440-441「只在实时开态 ∧ 收租」描述块随门控放宽同步改写——同源描述两处纪律沿 068 D5。
- regen 链：`export-openapi` → api-client → mobile 同 PR（api-contract-trigger）。

**D3 · 机器双闸（FR-007，clarify 裁决落点）**：

- **结构闸**：`check-optionsdesk-rule-constants.ts` 新增不变量分支——`leg-fwd-chain.rules.ts` / `leg-march.rules.ts` 禁 import `leg-window`（import 行扫描；**现状 rg 零命中**，闸的作用是钉死方向不是修复现状）。既有 #9 分支（窗判据单点住 `leg-window` / `leg-delta-surface`）原样，两分支合成「窗与 fwd 管道互不渗透」的完整表达。守卫表**零新常量**——本片新增的是不变量分支不是参数。
- **行为闸（IT 臂 ×3）**：① 离线 us 收租种交叉报价腿 → 断言行保留 + 审计 #1 + 净链除名（剔→标）；② 离线响应 `march.audits` 零 #12（带外横档）+ 行级带内外标恒缺省；③ 离线请求零 vendor 外呼（沿 068 SC-006 计数臂体例）。
- 文字护栏保留 + **ADR-0068 回写**：sunset trigger #6 标注消费（裁决 = 机器双闸，落点 = check 脚本 + IT 臂）；「后果·中性」的「两档并存两种呈现范式直到 P4」句加收口注记。docs 改动与 impl 同 PR。

**D4 · mobile 面（US1–US3；零新组件）**：

- **点亮机制零成本**：`leg-row.tsx` :71/:105-107 推荐章/劣档微标全部契约驱动（`march = null` ⇒ 恒无呈现），server 填字段即点亮，行渲染零门控改动；弹层入口 `onOpenAudit` 同源。
- `leg-row.rules.ts` 新增**「报价异常」微标**分支：该行到期日命中 audits #1 ⇒ 出标（离线专属分支天然成立——实时口径下交叉腿根本不在行集合，判定函数无需知道档位）。
- `march-audit-sheet.tsx` 题头两处：① **口径行**——`blockPriceKind === 'eod_close'` 时「基于 {quoteAsOf} 收盘」（FR-003 弹层承载；表格级口径已由 `leg-tier-bar` 的 `legQuoteTier` 承载，零改动）；② φ/闸只读读数行 **mode-aware**——`marchMode` 为 θ 模式时换模式标示文案（FR-009；默认 φ 态零新元素 = 零噪音，实时/离线共用组件 = 同一标示）。
- **价差类提示（FR-004）**：题头口径行全局承载昨收语义，13 类逐条目**不加**尾缀（一次说清，拒绝逐条文案膨胀）；#3「疑似陈旧报价」提示沿 069 原样。
- **空态核对（FR-010）**：051 三支空态（意图两分支 `optionsdesk-copy.ts:289` + 条件收紧第三支 :684）逐支对照「规则内无腿」语义——预期文案零改动或微调，核对结论落 tasks 验收（🚫 靠通读，逐支 grep 对照）。
- copy 集中 `optionsdesk-copy.ts`；文案禁感叹号、空态禁错误红（沿 069）。

**D5 · 验证与回放（SC 落点）**：

- **SC-001**：复用 `docs/private/evidence/069-replay-calibration.ts`（local-only，改造为离线管道入口直调），069 同数据面（2026-08-28 收盘全量，319 梯）逐值对比判决/推荐档/审计类别三面；scratchpad 跑不入仓，结论回写 spec（体例同 067/068/069）。
- **SC-002 golden 四臂**：全腿离线 / 建仓离线 / hk 收租离线三臂逐字符零 diff（`stable()` 剔新增键 `marchMode`，064/069 体例）；us 收租离线**既有字段逐值不变 + 行集合恒等**（新增块单独断言，成员不变的 golden 化）。
- SC-003 = D3 双闸；SC-004 = 审计完整性 IT（每非推荐档恰一条、类别 ∈ 13、含数值）；SC-005 = e2e（三态 + 口径行 + 模式标示 + 空态）；SC-006 = 结构性论证（纯内存旁路、响应内联、零新 I/O）——蓄意不设自动 perf 门，tasks 预检表登记（069 体例）。
- **测试分层**：呈现判定 vitest（mobile `*.rules.ts` logic-only，禁组件 render 测）；交互 Playwright Expo Web hermetic e2e；契约对齐 contract-smoke 扩断言（离线 rent `march` 真落 + `marchMode`）；usecase IT（Testcontainers）`state_branches` 11 条穷举 + D3 行为闸三臂。**每个新测试证明「能红」**（定向变异留档；rebase 后重做）。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：本片零写路径（读侧门控与装配），无 tx 面；离线路径零外呼（行为闸 ③ 钉死）。
- **安全**：不触鉴权/PII 面。
- **前端（mobile）**：无表单；零新组件零新 token；文案纪律沿 069（禁感叹号、空态中性灰）。
- **时间语义**：口径行日期 = 契约 `quoteAsOf`（收盘档序列化即交易日，064 语义）+ `lastClosedSession` 陈旧度基准（062 口径）沿用；零新「今天」判定；`check-time-semantics.ts` 照跑。

### 决策备选与既有事实核录

**备选否决**：① 离线另做阶梯屏/新组件——否：FR-002 同契约同组件，fork = 第二套阶梯语义；② 交叉腿离线也剔（与实时对齐省一个分支）——否：违 FR-006 成员不变与宽视野价值主张，且 069 零 diff 本就是零样本侥幸；③ 结构闸用 eslint-boundaries——否：window 与 fwd 管道同在 optionsdesk 模块内，boundaries 管模块间文件级；仓内先例（#9 形状/子串扫）同脚本扩分支成本最低；④ `marchMode` 挂 march 块逐 K——否：模式链级唯一，逐 K 冗余；⑤ 回落收盘档维持 march null——备选保留（D1 review 裁），默认随离线点亮。

**既有事实核录**（2026-08-30 plan 期逐项 grep 核）：

- march 门控与装配：`get-legs.usecase.ts:640-651`（`assembleMarchByStrike(pool, retrieval.removedByCrossedQuote, criteria, resolveMarchParams(marchPhiTier, marchMode))`）；`parsed.market` 同函数在作用域
- 护栏现状：`isCrossedQuote` 定义 `leg-recall.rules.ts:260`、消费 :724-729——**三视角一律剔**（离线潜伏成员剔除，069 spec SC-004 留档零交叉样本）
- 依赖不变量现状：`leg-fwd-chain` / `leg-march` / `leg-recall` 零 import `leg-window`（rg 零命中）——结构闸钉死
- mobile 门控：`leg-row.tsx:71/:105-107` march prop 契约驱动；`march-audit-sheet.tsx` 069 已建；`blockPriceKind` prop 已下发到行
- 口径基建：`leg-tier-bar.tsx:37-43` `legQuoteTier` 消费 `priceKind/quoteAsOf/realtimeDegrade`——收盘口径档位表格级已呈现
- 空态：`optionsdesk-copy.ts:289`（051 意图两分支）+ :684（条件收紧第三支）——离线收租空态三支已有
- config：`apps/server/src/config/optionsdesk.config.ts` `marchPhiTier` / `marchMode`（069 config-add 已落，本片零新 config）
- 守卫脚本：`scripts/checks/check-optionsdesk-rule-constants.ts`（919 行，不变量 #9 = 窗判据单点）——070 结构闸挂同脚本
- 回放脚本：`docs/private/evidence/069-replay-calibration.ts`（local-only）——SC-001 复用

## Complexity Tracking

无违规，无需 justify。
