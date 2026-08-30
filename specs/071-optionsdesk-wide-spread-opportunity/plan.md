---
feature_id: 071-optionsdesk-wide-spread-opportunity
spec_ref: ./spec.md
status: approved
created_at: '2026-08-31'
updated_at: '2026-08-31'
adr_refs: ['0043', '0062', '0064', '0068']
context7_verified: []
---

# Implementation Plan: 宽价差机会标 — 收租点差闸的机会逃生舱

## Summary _(mandatory)_

给相对价差维度加**第二条通过路径**：收租视角下 `rel > 上界` 但 `bid 年化 ≥ 收租 good 档界` 的腿放行进候选并带标（打标不删）。判据单点落 `leg-recall.rules.ts`，档界为 `leg-tier.rules.ts` 档表的引用（零新数值）；标随候选集上浮到契约面，mobile 复用既有 sticky badge 载体加一枚微标。离线 / 实时两档共用同一支，fwd 阶梯零特判。零新表、零写路径、零新 endpoint、零新审计类目。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 单 feature 单分支单 PR（跨端原子 merge）；TDD 红绿闭环；扁平 / 贫血 / 护城河零违背（零新表、零写路径、零新 endpoint、零跨 ctx 新增）；mockup-first 免（spec clarify 裁决，068 / 070 先例——呈现增量为既有 badge 载体上的一枚微标）。无需 Complexity Tracking。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 既有 optionsdesk IT（Testcontainers 真 boot）承载；spec `state_branches` 9 条在 usecase IT 穷举（D5）。
- [x] **Mobile / Web**: 收租视角带标行走 Playwright Expo Web hermetic e2e + 契约冒烟扩断言。
- [x] **Evidence**: impl 期 IT/e2e commit + SC-003 回放结论回写 spec（体例同 068 / 069 / 070）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

零新三方依赖（纯函数 + 既有组件）。**Evidence**: N/A。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] 本 feature mono-native。**Evidence**: N/A。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR      | Open Question affected                                     | Classification | Mitigation / next step                                                             |
| -------- | ---------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| ADR-0068 | 「候选与否决」表缺一行（issue #298 掉队项）                 | mitigated      | 本片落地 ⇒ 进 §决策 3 而非否决表；ADR 随本 PR amend（D6）                            |
| ADR-0068 | sunset「fillMode（砸 bid / 挂中间价）落地」                 | accepted-as-is | 本片恒 bid 口径（机会支问的正是「砸 bid 也达档吗」）；fillMode 落地时随 §决策 4/5 一并重审 |
| ADR-0064 | 不变量 ③（每特征恰好一处）                                 | mitigated      | 档界改由 `leg-tier.rules.ts` 单点导出，`resolveMarchPhi` 与机会闸同源（D2）          |

其余 ADR 无受影响 Open Questions。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock()` 隔离单元测试（本片零新 lifecycle 组件，禁令仍全文有效）。
- **MANDATORY INTEGRATION**: usecase 层验证必须 `Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()` 真 DI 容器（Testcontainers PG+Redis）。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 9 条每条在 IT 有对应 `it()` 块。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：Flat Module / Anemic + Zero-Class / No Repositories / The Moat。本片**零新表、零写路径、零跨 ctx 新增、零新 endpoint**——改动落 `apps/server/src/optionsdesk/` 判据与读路径 + 契约 regen + `apps/mobile/src/optionsdesk/` 呈现层。

**D1 · 判据落点：维度的第二支，不是第七维**

相对价差维度的成员判据由 `rel ≤ 上界` 改为 `rel ≤ 上界 ∨ 机会支`。落点是 `leg-recall.rules.ts` 的 `failsCriterion` 的 `relativeSpreadMax` 分支——**全仓唯一的成员判定处**（052 FR-003）。

🚨 **为什么不是第七个检索维度**：`RETRIEVAL_CRITERION_KEYS` 是「有控件、系统给默认值、用户可覆盖」的穷举清单，加键就是加抽屉控件 + 三态 + 边际计数。机会支**没有控件也不该有**——它是系统对「什么算机会」的固定判断。形态上它与 `passesLivenessMin` 的「OI ≥ x **或** 当日成交 ≥ y」同构：一个维度、两条支撑、OR 合成。

🚨 **`failedCriteria` / `failsCriterion` 加 `tab` 入参**（FR-003 收租限定）。签名变更是**蓄意的**：机会支只作用收租，靠调用方守约等于把「哪个视角能捡漏」变成运行时才知道的事。两个非测试调用点：`evaluateTab`（tab 在手）、`crossedRemovalsWithinCriteria`（收租审计作用域，传 `'rent'`；交叉腿负点差恒过主支 ⇒ 机会支对它结构上不触发）。

**D2 · 档界单点：`leg-tier.rules.ts` 新导出 `tierFloor(basis, tier)`**

机会支要读「收租年化 good 档界」。今天这条查表逻辑住在 `leg-march.rules.ts` 的 `resolveMarchPhi`——召回层 import 精排层是层反转。⇒ 把查表下沉到档表所在文件 `leg-tier.rules.ts`：

```ts
export function tierFloor(basis: LegBasis, tier: LegTierWithFloor): Prisma.Decimal
```

`resolveMarchPhi(tier)` 改为 `tierFloor('annualized', tier)` 的一行委派（行为逐值不变，含未知档抛错）。这是本片新增的第二个消费点逼出来的**去重**，不是顺手重构。

🚨 **机会闸取固定 `good` 档，🚫 MUST NOT 复用 φ 的可配置旋钮**（`optionsdeskConfig.marchPhiTier`）：召回成员集若随 server 配置变，「今天候选为什么少了 30 条」的答案会变成「有人改了环境变量」，而候选表照样渲染得出来。φ 是再投资率旋钮，机会闸是质量下限，两者语义不同、恰好同源于一张档表。

**D3 · 机会支谓词**

```ts
export function isWideSpreadOpportunity(leg: RecallLegInput): boolean
```

`bid === null` ⇒ false（🚫 MUST NOT 拿 0 顶 bid）；`computeLegRates` 返 `null`（`K − bid ≤ 0` / `DTE ≤ 0`）⇒ false；否则 `annualizedRate ≥ WIDE_SPREAD_OPPORTUNITY_FLOOR`。费率恒经 `leg-derive.rules.ts` 的 `computeLegRates` 单点（ADR-0064 不变量 ③），🚫 本文件 MUST NOT 手写 `P/(K−P)`。

📌 **谓词只判「机会成不成立」，不判「点差过不过」**——两支各自纯粹，OR 在维度判定处合成。这样机会标的判据（FR-006：主支不过 ∧ 机会支成立）与成员判据（主支 ∨ 机会支）读的是同两个布尔，不会各算一份。

**D4 · 标的产出与上浮**

`RecallCandidate<T>` 加 `wideSpreadOpportunity: boolean`，由 `evaluateLeg` 的同一趟求值产出（🚨 与候选归属、051 流动性数、052 边际计数**同源**——各算一份的话 drift 时四边都算得出数、都不会红）。

判据 = **本次请求的任一视角下**「主支不过 ∧ 机会支成立」。⚠️ 注意 FR-006 的边界：用户把点差上界覆盖成「不限」时主支恒过 ⇒ 若判据写成「实际被主支挡下」，标会随控件闪烁。⇒ 判据取**系统默认值下的主支**（`pass.defaults[tab].relativeSpreadMax`）不过 ∧ 机会支成立；成员判定仍按 `effective` 走。两处读同一个 `passesRelativeSpreadMax`，不新增第三个谓词。

上浮链：`RecallOutcome.candidates[].wideSpreadOpportunity` → `LegCandidate`（`get-legs.usecase.ts` 的 `deriveLegs` 逐腿透传，🚫 零重算）→ `LegRowView` → `LegResponse.wideSpreadOpportunity`（DTO）→ openapi → api-client regen → mobile。

**D5 · fwd 阶梯：零改动**

带标腿是普通候选 ⇒ 经 `pool` 进 `assembleMarchByStrike` 走既有路径。🚫 **MUST NOT 为它新增审计类目**——13 类枚举是前后端严格一致的契约面（069 FR-015），而「它是怎么进候选的」不是「它为什么被排除」，家族不对。

**D6 · 契约与守门**

- DTO：`LegResponse` 加 `wideSpreadOpportunity: boolean`（非空布尔；`@ApiProperty` 显式 `type: 'boolean'`）。
- `scripts/checks/check-optionsdesk-rule-constants.ts`：`MEMBERSHIP_PREDICATE_RE` 词表加 `isWideSpreadOpportunity`（SC-001 的机器半）。`RECALL_THRESHOLD_COUNT` **不变**（本片零新小数字面量——档界是引用）。
- openapi.json 经 `node dist/main.js` 正路 regen（🚫 不走 `dump.mjs`），`packages/api-client` 重新 gen。

**D7 · UI 规格（mobile，免 mockup）**

- 复用 `LEG_STICKY_BADGE_BASE` 载体，`LegStickyBadge` 加 `'wide'`，描边取 `border-tag-teal`——避开 quote 红绿（不是涨跌）、避开 `tag-purple`（贴合标）、避开 brand（推荐章的权重不能被稀释）。文案 `wideSpreadBadge: '宽'`。
- 判据纯函数 `legRowWideSpread(wideSpreadOpportunity)` 落 `leg-row.rules.ts`——🚨 客户端 MUST NOT 由 `relativeSpread` 与档界自推（ADR-0064 不变量 ②；那就是同一判据两处各一份）。
- 该行的 `价差` 列本就在（`formatRelativeSpread(leg.relativeSpread)`）⇒ FR-010 的「买卖价可读」已由既有列满足，本片不新开列。
- 🚫 **不劝阻式呈现**：不降灰、不折叠、不沉底、不上 warning 色——它是机会标（FR-010）。

**D8 · 已 pin 行为的迁移**

`get-legs.usecase.spec.ts` 的 `G-WIDE` fixture（`bid 3.00 / ask 9.00 ⇒ 出意图 Tab`）：该腿 `strike 126`、DTE 短，年化远低于 15% ⇒ **既有断言逐字保留**（它落在「宽但不达档」那一格，正是 FR 要求维持的语义）。另加一条达档的宽价差 fixture 驱动新路径。

## 复杂度

- 机会支 `O(1)`/腿（一次 `computeLegRates`），召回层整体仍 `O(n)`。
- 候选集增量实测 +9.2%（852 → 930），fwd 阶梯规模同比例，无量级变化。
