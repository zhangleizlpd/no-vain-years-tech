---
feature_id: 051-optionsdesk-leg-display-semantics
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-12'
updated_at: '2026-08-12'
adr_refs: ['0043', '0063', '0030']
context7_verified: []
---

# Implementation Plan: 选约表显示口径跟进（P2）

> 产物 = **仅本文（prose-only）**。data model SoT = `schema.prisma`（本片**零 schema 改动**）、API SoT = swagger 装饰器（本片**零契约改动**）。**不造** `research.md` / `data-model.md` / `quickstart.md` / `contracts/`。
> 📌 本片是 optionsdesk 选约引擎重构四片中的 **P2**。主 plan：`docs/private/plans/2026-08/08-11-optionsdesk-leg-engine-master.md`（本机私有，范畴权威在其 §2.3）。
> 🎨 Mockup baseline：`design/051-leg-display-states.dc.html`（7 帧，local-only）+ `design/handoff.md`。

## Summary

把 P1（`050`）已下发但零消费的六个契约字段接进呈现层：按 `tabOrder` 渲染（禁客户端排序）、档位色改读 `tierByTab`、费率口径改读 `basisByTab`、加推荐标与月度链标、把两个门槛计数与空态解释落到腿列表之后的非常驻区。

📌 **「纯 mobile」是起手假设，不是硬约束**（2026-08-12 owner 补充「视情况而定，不强求纯 mobile」）。若 impl 中发现某条 FR 在现有契约下**不可诚实实现**，允许改 server —— 但那一刻本片即转为**跨端片**，须补齐 §V 的全部代价（单 PR + `export-openapi` + api-client regen + 两层验证）。**已知有一处大概率会撞上，见 D-GATES-2**；其余部分仍按零 server 改动推进。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | 本片零新包。六个字段的类型已由 `@nvy/api-client` 提供（`050` regen 后随 #23 合入 main，实测在库）。标与计数全部由既有 NativeWind token 表达，**0 新 design token**（mockup 阶段浏览器内逐个 `getPropertyValue` 验过 38/38）。零新交互库 —— 计数可点走既有 `Pressable`，切 Tab 走既有 `setTab` |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 逐条核对：
  - **§I SDD**：specify → clarify（08-11 五轮配额用满）→ **Mockup**（08-12，7 帧 + handoff，per v1.4.0「前端 UI feature 在 clarify 与 plan 之间强制插 Mockup 步」）→ plan。未跳步。
  - **§II TDD**：每 task 红→绿→typecheck/lint→`[X]`→stage→commit 六步闭环。⚠️ **本片的 TDD 落点分布不均**：顺序 / 档位 / 口径 / 空态分支四块有厚实的纯函数面（`leg-picker.rules.ts` / `leg-picker-copy.ts`），可 Small 档逐条断言；而**标与计数的呈现**是 tsx 结构，只能靠 Mobile e2e 兜。切分时按此分配验证手段，不要对 tsx 强上单测（per `reference_mono_mobile_test_layering`：mobile 单测 = logic-only，UI 归 Playwright）。
  - **§III 原子 task**：下方切分均为 30min–2h 单 commit 粒度。
  - **§IV Module Boundary**：本片全部落在 `apps/mobile/src/optionsdesk/` 内，零跨 feature 依赖、零 server 改动。
  - **§V 类型同步链 + PR 边界**：起手按**零契约改动**推进 ⇒ 不跑 regen。⚠️ **但这个前提可能在 impl 中被推翻**（D-GATES-2 的 per-view 计数）；一旦改契约，本片转跨端片，**必须在同一 PR 内**跑 `nx run server:export-openapi` + `packages/api-client` regen（per §V v1.3.0 单 PR 原子 merge）。按 §V 字面本片当前非跨端 feature，但 🚨 **仍必须落 `[Contract-Smoke]`** —— `050` 的 plan §V 明写「**P2 消费新字段时才是跨端片**」，把这道验证**显式推给了本片**。理由成立：六个新字段迄今只被 server IT（真 PG，但不过生成客户端）与 mobile 手写 mock 验过，**「生成的客户端 + 真 server」这条缝从未合过**。⚠️ `check-contract-smoke-drift.ts` 是 echo-only 且只在 **server** 改动时触发 ⇒ 本片它不会响，这条义务只能靠本 plan 记住。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: N/A —— 本片零 server 改动。
- [x] **Mobile / Web**: hermetic UI e2e 落 `apps/mobile/e2e/optionsdesk-leg-display.spec.ts`（Playwright Web），覆盖三个视角的口径差异、计数可点、两种空态。
- [x] **Contract**: 扩既有 `apps/mobile/e2e/contract-smoke/optionsdesk-chain-leg-picker.contract.ts` —— 六个新字段的**形状与取值一致性**（见 §V）。
- [x] **Evidence**: 占屏与流畅度（`SC-009` / `SC-010`）**MUST 真机验**，网页端读数仅参考（`049` 实测 web 185 vs 真机 161dp，差 13%）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片零新第三方包（见 Dependencies 表）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native**。改的 `apps/mobile/src/optionsdesk/*` 全部由 045–049（2026-08）在 mono 内新建，无 meta-repo 迁移史。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question / sunset trigger | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| **ADR-0063** | 横滑范式方案 E（零滚动容器 / 单手势 / 单共享位移） | `accepted-as-is` | 本片**零几何改动**（表宽 716 与 12 列集逐项不变，`SC-011`）。两个新标塞进既有钉住列 ⇒ 内容宽与指示条长度比不变，**不触发横滑回归**。🚫 MUST NOT 为放标而改列宽 |
| **ADR-0043** | 扁平 + 贫血范式（server 侧） | `accepted-as-is` | 本片零 server 改动。mobile 侧沿 `*.rules.ts` 纯函数 + tsx 只做呈现的既有分层 |
| **ADR-0030** | `~/theme` `~/ui` 内联，多 consumer 时 sunset 回 `packages/` | `accepted-as-is` | 本片零新 token、零新 `~/ui` 组件（标与计数都是 feature 内局部结构）⇒ 不推进也不延后该 sunset |

**Evidence**: 逐条读三个 ADR 的 frontmatter；ADR-0053（复权）与本片无交集（本片不碰任何价格换算）。

## Architecture Notes

### 🚨 Testing Invariants（AI 绝对禁令 — 严禁违背）

1. **mobile 单测 = logic-only**。禁 vitest 渲染组件（`reference_mono_mobile_test_layering`）。tsx 的验证一律 Playwright。
2. **hermetic mock 是契约镜像，不是调用序**。`tabOrder` MUST 与每腿 `tabs` **同源派生**（写死数组会与不变量当场矛盾）；`gateCounts` MUST 与 mock 数据集里被挡下的条数**算得出来**，不许拍脑袋填。
3. **文案断言天然自指**（`expect(text).toBe(COPY.x)`，改成什么都绿）⇒ `SC-008` 的文案复核 **MUST 人工逐条过**，不许写一个「文案测试」冒充。
4. **改共享 hook / util → 跑全 `runtime-smoke`**，不是单 spec（blast radius = 整套 e2e）。

### General Architecture Notes

- 呈现层分层沿既有：`*.rules.ts` 纯函数（可 Small 档单测）→ `*.tsx` 只做结构与 className → 屏级 `use-leg-table.ts` 组装。
- `underlying-detail-screen.tsx` 的 `SectionList` 骨架**不动**：`renderSectionHeader` = 常驻区 · `section.data` = 腿行 · `renderSectionFooter`（`LegBlockNotice`）= 计数 + 空态 · `ListFooterComponent` = 页脚。
- 049 的签名照抄不再造：`LegRow` / `LegTableHeader` / `LegColumnPane` / `clampLegColumnTx` / `LegColumnScrollbar`。

---

## D-ORDER · 按 `tabOrder` 渲染，禁客户端排序（`FR-001`–`FR-004`）

现役 `filterLegsByTab(legs, tab) = legs.filter(l => l.tabs.includes(tab))` —— 它**保留 `legs[]` 的顺序**，而那是 legacy 载体顺序（档位 → 到期日 → 行权价 → code），P1 之后不承载任何视角的排序语义。

**新范式**：以 `tabOrder[tab]` 的 code 序为准取腿。

- 建一次 `Map<code, LegResponse>`（`O(n)`），再按 `tabOrder[tab]` 映射（`O(m)`）⇒ 总 `O(n+m)`，与现役 `filter` 的 `O(n)` 同量级。
- 🚨 **新函数签名里 MUST NOT 出现任何比较器 / 排序键入参** —— 这是「排序不在客户端」的**结构保证**而非事后约定（同 `050` D-RECALL-1 对 `absDelta` 的处置）。想在客户端排就必须先改签名，那一步 review 看得见。
- **边界**（spec Edge Case）：`tabOrder` 里有 code 但 `legs[]` 里定位不到 → **跳过该 code**，MUST NOT 崩、MUST NOT 塞占位行。反之 `legs[]` 有而 `tabOrder` 无 → 该视角本就不含它，正常。
- 🚫 `filterLegsByTab` **整条退役**（连同其 `leg.tabs.includes` 判据）—— 保留它等于留一条「按成员关系过滤但不管顺序」的旁路，下次有人图省事就会用回去。

**机械判据（`SC-002`）**：`rg '\.sort\(' apps/mobile/src/optionsdesk/ -g '!*.spec.*'` **零命中**。
📌 该判据**当前已成立**（实测：4 处命中全在 spec 文件且都是 `Object.keys(...).sort()`）⇒ 它是一条**可回归的基线**，不是新造的空指标。🚨 验收时 MUST **先证明它会红**：故意在呈现层加一次 `legs.sort(...)`，扫描必须报出该行；改回后归零。

## D-TIER · 档位色改读 `tierByTab`（`FR-015` / `FR-016`）

档位色的落点是 `leg-picker-copy.ts` 的**四个函数**，实测读 `leg.tier` 的点恰好也是这四处：

| 函数 | 现役 | 改后 |
| --- | --- | --- |
| `legBidTone(leg)` | `leg.tier === null ? 未判档 : TIER_TONE[leg.tier]` | 吃 `tier: LegTier \| null`，由调用方传 `leg.tierByTab[tab]` |
| `legRowToneClass(leg)` | `leg.tier === 'dead' ? 沉底 : 常规` | 同上 |
| `legActionText(leg)` | `ACTION_BY_TIER[leg.tier]` | 同上 |
| `legRateSub(leg)`（`tier === 'thin'` 分支） | 同上 | 同上 |

**签名取「传档位」而非「传 leg + tab」**：四个函数本就只关心档位这一个量，多吃一个 `tab` 只会让它们知道得比需要的多。⇒ 由 `LegRow` 取一次 `leg.tierByTab[tab]` 传下去，四处共用同一个值（**同源，不会 drift**）。

🚫 **`leg.tier`（legacy 标量）在呈现层 MUST 零读取**。机械判据：`rg 'leg\.tier\b' apps/mobile/src/optionsdesk/ -g '!*.spec.*'` 零命中。契约里保留该字段是「只加不删」的要求，不是让客户端继续用。

## D-BASIS · 费率口径取自服务端 + 列头即口径（`FR-017` / `FR-017a` / `FR-018`）

- 删 `RATE_SUB_BY_TAB` 硬编码常量（Tab → 口径映射的第二份实现）。
- 新函数 `rateHeaderFor(basisByTab, tab)` 返回 `{ main, sub }`：`weekly` → `{ main: '周化', sub: '折年参照' }`；`annualized` → `{ main: '年化', sub: null }`。
  🚨 **列头就是口径本身，不套「费率」这层通用标题**（`FR-017a`）—— 收益不是省字宽，是让「口径取自服务端」在视觉上自明。次要收益：mockup 实测原两行结构在 56px 列宽下**撑破**，改后 12 列表头逐列量过无一撑破。
- **未知取值兜底**（`FR-018`）：映射用 `Record<LegBasis, …>` 穷举（enum 加成员即编译红，per `mobile-impl-playbook` 的 enum→copy 纪律），**再加一层运行时 `?? 缺省`** —— 因为 server 可能先于客户端上线新取值，那时类型层已经骗不了运行时。

## D-MARK · 两个标进钉住列，撤口径徽标（`FR-011a` / `FR-013` / `FR-014` / `FR-014a` / `FR-014b` / `FR-019a`）

钉住列（88px，可用 72px）改成：

```text
line 1: [行权价 13px mono]  [贴合 8px 描边标]      ← 实测 64px
line 2: [到期日 9px muted]  [月 8px 描边标]        ← 实测 60.4px
```

- **推荐标措辞取「贴合」不取「推荐」**（`FR-011a`）：判定不看 Tab 成员 ⇒ 存在「带标却进不了任何意图视角」的腿（`050` 实测约占期限段合格腿五分之一），措辞是**唯一**的消歧手段。🚫 MUST NOT 用 success/绿系（会读成「建议买入」）。
- **两个标同载体、以视觉权重区分**（`FR-014b`）：推荐标 tag 色描边、月度链标中性描边。🚫 MUST NOT 让其中一个退化成纯几何符号 —— mockup 阶段实证：空心方块连「这是什么」都要查图例（spec 作者本人评审时发问）。
- **撤 `showsBasisBadge` / `BASIS_BADGE` / `BASIS_BADGE_BORDER` 三个符号**（`FR-019a`）。撤的理由与空间无关：该 legacy 标量在 server 侧的判据已是 `tabs.includes('build') ? 'weekly' : 'annualized'`，表达的是 **Tab 成员关系**却顶着口径形状的标签，而全腿视角档位恒年化。⇒ 我的改动产生的 orphan MUST 清理（`BASIS_BADGE` 等随之全删）。
- **greeks 缺失行**（`FR-013`）：恒无推荐标，但**照常在表内、照常在其所属视角内**；🚨 **费率照算**（server 的 `rateOf` 只吃 `premium`），null 的是**档位**不是费率 —— mockup 首版把这画错过，实现别照着错的画。

## D-GATES · 两个计数与空态（`FR-006`–`FR-010a`）

- 三样东西**同落 `renderSectionFooter`（`LegBlockNotice`）**：就地说明 + 两个计数 + 空态解释。
- 🚨 **既有就地说明从 `LegPickerTabs` 移出** —— 它现在在常驻区内。移出后常驻区高度**只降不升**（`SC-009` 取「严格不高于」而非「不劣于」，因为下降是必然的）。
- **两个计数的交互不对称**（`FR-007a`）：权利金计数**纯文字无入口**（那些腿不在响应里，给入口是空承诺）；流动性计数**可点 → `setTab('all')`**。🚫 MUST NOT 为对称把两者做成一样。
- **措辞不对称**（`FR-007`）：一个表达「三个视角都看不到」，一个表达「仍在全腿视角」。🚫 MUST NOT 用同一个暗示「滤掉」的词。
- **均为 0 时降权**（`FR-008`）：靠**去掉主色 + 缩字号**，🚫 MUST NOT 靠压低对比度 —— 计数是真数据（只是为 0），不是占位符。mockup 阶段踩过：用 `text-subtle` 掉到 2.85:1，那是「看不清」不是「不抢眼」。
- **空态按计数分支**（`FR-009`）：排除数 > 0 → 指向门槛 + 带入口；两数皆 0 → 指向「该期限段确实没有」+ 无入口。这是**同一个设计的两面**，MUST NOT 拆成两个 task 各做各的。
- **为 P3 那对计数留位**（`FR-010`）：P3 的「符合条件 N / 显示前 200」与本片这对**语义完全不同**，同区追加即可，位置本片一次定好。

## 🚨 D-GATES-2 · `excludedFromIntentTabs` 是**全表标量**，`FR-009` 在现有契约下不可诚实实现

**实测**（`get-legs.usecase.ts:650`）：

```ts
const excludedFromIntentTabs = legs.filter((leg) =>
  isExcludedFromIntentTabsByLiquidity(recallContext, {...})).length;
```

而该纯函数的判据是 `!passesLiquidityGate && intentTabsByTerm(...).length > 0` —— **build 或 rent 任一期限段合格**即计入。⇒ 它是**全表一个数，不分视角**。

**后果**：建仓视角为空、`excludedFromIntentTabs = 20`，而那 20 条可能**全是被排除出收租的**。此时按 `FR-009` / `US2-AS5` 说「有 20 条被门槛挡了，去全腿看」对建仓视角**是错的** —— 而它**不会红**：数字真实、文案通顺、只是指向了别的视角的腿。mockup 帧③ 画的正是这句话，同样带着这个缺陷。

### 三条出路

| | 做法 | 代价 | server 改动 |
| --- | --- | --- | --- |
| **A** | 客户端**措辞退让**到全表口径（「全表有 N 条腿因报价过宽未进任何意图视角」），不声称与当前视角相关 | `US2-AS5`「我该去看看被挡的是什么」的指向变弱：用户切到全腿也不知道该找哪些 | 零 |
| **B** | server 把该计数**拆到每视角**（`excludedFromIntentTabs: { build, rent }` 或并列新增字段），契约**只加不删** | 本片转跨端片，补齐 §V 全部代价 | 有（小：`intentTabsByTerm` 已算出各视角成员，拆计数是同一次遍历内的事） |
| **C** | 客户端自算 | 🚫 **否决** —— 客户端拿不到期限段判据（在 server 的 `leg-recall.rules.ts` 里），且 `FR-003` 明令 MUST NOT 在客户端重算成员判据。走这条等于造第二份判据实现 | 零 |

### 处置

**impl 到 T007（空态两分支）时现场定**，判据是：**A 的措辞在真实数据上读起来是否仍然有用**。
- 若「全表有 N 条」足以驱动正确行动（用户切到全腿本来就会看到它们）⇒ 取 A，本片维持纯 mobile。
- 若读起来含糊到无法行动 ⇒ 取 B，**同一 PR 内**改 server + regen + 补两层验证，并回写 spec 的 `FR-008` / `FR-009`。

🚨 **不许在没做这个判断的情况下按 A 实现** —— 那会把一个已知的错指向静默留在产品里。T007 的 verify 必须包含「这句文案在 `excludedFromIntentTabs` 与当前视角无关时是否仍成立」的显式核对。

## D-COPY · 047 时代文案逐条复核（`FR-019` / `FR-020`）

范围已在 spec 阶段扫清为**两处**，无第三处：

1. `rentDepthUnionNote`（`optionsdesk-copy.ts`）—— 现文案「水位未选 → 展示全部 Δ 档（0.05–0.40Δ）」描述的是 047 的召回行为。`050` 之后 `recallTabs` 的 context 只有 `{ spot }`，Δ 与水位**结构性地不在收租召回入参里** ⇒ 选不选水位，收租视角成员集合**一条不变**。📌 `050` 已在该常量的 JSDoc 里登记并显式推迟到本片，这一步是**兑现已登记的待办**。
2. 「腿族」措辞（`legBasisBadge` 那组）—— 随 `FR-019a` 整条撤除，不是改措辞。

🚨 复核 **MUST 人工逐条过**，测试对这一层结构性无效（Testing Invariant 3）。

## D-TEST · 验证三层分工

### D-TEST-1 · vitest Small（`*.spec.ts`，纯 rules）

`leg-picker.rules.spec.ts` / `leg-picker-copy.spec.ts` / `leg-row.rules.spec.ts`：顺序映射（含 `tabOrder` 有而 `legs[]` 无的跳过分支）· `tierByTab` 取值与 null 缺省 · `rateHeaderFor` 穷举 + 未知取值兜底 · 空态分支判据 · 计数为 0 的降权判据。

### D-TEST-2 · Mobile hermetic e2e（Playwright Web）

新建 `apps/mobile/e2e/optionsdesk-leg-display.spec.ts`：三视角口径差异（同一条腿两处档位不同）· 顺序与 mock 的 `tabOrder` 逐行相同 · 流动性计数点击后落到全腿视角 · 两种空态文案互不相同 · 推荐标处处同值。
⚠️ mock 按 Testing Invariant 2 写（`tabOrder` 与 `tabs` 同源派生、`gateCounts` 由数据算出）。

### D-TEST-3 · Contract smoke（`050` 推给本片的义务）

扩 `apps/mobile/e2e/contract-smoke/optionsdesk-chain-leg-picker.contract.ts`：六个新字段在**生成客户端 + 真 server**下的形状与一致性（`tabOrder[t]` 的元素集合 == `{code | t ∈ leg.tabs}` · `tierByTab` 非成员恒 null · `basisByTab` 取值域）。

### D-TEST-4 · 真机验收（`SC-009` / `SC-010`）

常驻区高度**不高于**开工前基线（本片预期**下降**）· 730 行量级切视角与滚动不劣于开工前。🚨 网页端读数仅参考。

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红）

1. **`filterLegsByTab` 退役而非并存** —— 留着它就留了一条绕过 `tabOrder` 的旁路，而走那条路**渲染结果完全正常**，只是顺序错。
2. **四个档位函数改签名后调用点全改** —— 漏一处会让那一列还在读 legacy 标量，切视角时它不变色，而**别的列变了**，看起来像数据错乱不像漏改。
3. **`leg.tier` 与 `leg.basis` 保留在契约里但呈现层零读取** —— 两条 `rg` 零命中判据都要跑。
4. **就地说明移出常驻区是 `SC-009` 的前提** —— 只加不移会让常驻区**上升**，直接违反。
5. **greeks 缺失行费率照算** —— 别把「不判档」实现成「不显示费率」。
6. **计数降权靠去色不靠压对比度** —— 真数据不能做成看不清。
7. **空态与计数是同一个设计** —— 拆开做必然对不齐（一个说「被挡了 20 条」另一个说「没有符合条件的腿」）。
8. **表宽与列集零改动**（`SC-011`）—— 为放标改列宽会触发 049 的横滑几何回归。
9. **hermetic mock 的 `tabOrder` 同源派生** —— 写死数组会与被 mock 的服务端不变量当场矛盾。

## Task 分解

### Phase 1 · 顺序与成员（`US1`，阻塞 e2e）

- **T001 [Mobile]** `leg-picker.rules.ts`：新增按 `tabOrder` 取序的纯函数、退役 `filterLegsByTab` → verify: Small 单测红→绿（含「`tabOrder` 有而 `legs[]` 无 → 跳过」分支）；`rg '\.sort\('` 零命中且**先证明它会红**
- **T002 [Mobile]** `use-leg-table.ts` / `underlying-detail.rules.ts` 接线：sections 改由有序列表构建 → verify: typecheck 绿；既有 optionsdesk e2e 不红

### Phase 2 · 档位与口径（`US4`）

- **T003 [Mobile]** `leg-picker-copy.ts` 四个函数改吃档位值；`LegRow` 取一次 `tierByTab[tab]` 传下去 → verify: 单测覆盖四档 + null；`rg 'leg\.tier\b'` 零命中
- **T004 [Mobile]** `rateHeaderFor` 取代 `RATE_SUB_BY_TAB`；列头改为「口径即标题」 → verify: 单测含未知取值兜底；`LegTableHeader` 快照类断言不适用 ⇒ 靠 e2e

### Phase 3 · 标与徽标退役（`US3`）

- **T005 [Mobile]** 钉住列加两个标 + 撤三个 basis-badge 符号（orphan 一并清） → verify: `rg 'BASIS_BADGE\|showsBasisBadge'` 零命中；typecheck 绿

### Phase 4 · 计数与空态（`US2`）

- **T006 [Mobile]** 就地说明移出常驻区 + 计数区落 `LegBlockNotice` + 流动性计数可点 → verify: e2e 点击后落全腿视角
- **T007 [Mobile]** 空态两分支 + 计数为 0 降权 → verify: 单测判据 + e2e 两种空态文案互不相同；🚨 **先做 D-GATES-2 的 A/B 判断并把结论写进 commit message**（取 B 则本 task 连带 server 改动 + regen，本片转跨端片）

### Phase 5 · 文案复核与验证（`US5`）

- **T008 [Mobile]** `rentDepthUnionNote` 订正 + 全量文案人工复核留痕 → verify: 人工逐条过，结论写进 commit message
- **T009 [Mobile-E2E]** `optionsdesk-leg-display.spec.ts` 新建 → verify: `nx run mobile:e2e` 绿
- **T010 [Contract-Smoke]** 扩 `optionsdesk-chain-leg-picker.contract.ts` 覆盖六个新字段 → verify: 生成客户端打真 server 通过
- **T011 [Docs]** 真机验收 + 回填主 plan P2 行 → verify: 常驻区高度实测不高于基线；主 plan §2.3 打勾

## Out of Scope（本片明确不做）

| 事项 | 去向 |
| --- | --- |
| 每视角独立请求 / 行权价筛选上 server / 截断 top-200 / 预热 / 费率下沉 SQL | **P3**（`052`，跨端） |
| 三次请求的一致性处置 | **P3**（主 plan 未决 #1，仍未定） |
| 第二对计数（符合条件 N / 显示前 200） | **P3**（本片只留位） |
| 排名特征集呈现 | **永不做** —— 不进契约，客户端拿不到 |
| 计数下钻明细屏 / 切过去后高亮定位 | **不做**（clarify Q3 定案只做「切到全腿视角」这一步） |
| 「腿数变多 / 变少」的解释文案 | **不做**（clarify Q5 定案归 release note） |
| 新增列 / 改列宽 / 改表宽 | **不做**（`SC-011`） |
| 召回 / 打标 / 精排**判据本身** · 锚派生 · 意图矩阵 | **不动**（D-GATES-2 若取 B，动的是**计数的粒度**，不是任何判据） |
| 跨标的聚合视图（`048`） | 冻结，四片落完连同其 spec 一并重写 |

## Complexity Tracking

| 复杂度来源 | 为什么不可避免 | 代价上限 |
| --- | --- | --- |
| 四个档位函数同时改签名 | 档位跟视角走是 `FR-015` 的定义，legacy 标量已不承载语义。分批改会出现「一半列变色一半不变」的中间态，比一次改完更难判对错 | 4 个函数 + 其调用点，全在 `leg-picker-copy.ts` 与 `leg-row.tsx` 两个文件内 |
| 就地说明从常驻区搬到非常驻区 | `SC-009` 的硬约束（余量归 P3）。不搬就只能不加新说明，而 `FR-012` 要求加 | 一次搬迁，`LegPickerTabs` 的 `notices` prop 随之退役 |
| Contract-smoke 在零 server 改动的片里出现 | `050` 显式推给本片；「生成客户端 + 真 server」这条缝从未合过 | 扩既有 contract spec，不新建 |
| 本片可能中途转跨端（D-GATES-2） | `FR-009` 在现有契约下不可诚实实现，而该 FR 是 `US2` 的核心（P1 用「腿会消失」换候选集干净，计数是唯一对价） | 取 B 时：server 侧一次遍历内拆计数 + DTO 加字段 + regen + 两层验证。判断点前置到 T007，不拖到收尾 |
