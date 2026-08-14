---
feature_id: 056-optionsdesk-criteria-drawer-layout
spec_ref: ./spec.md
status: implemented
created_at: '2026-08-14'
updated_at: '2026-08-14'
adr_refs: ['0030', '0062', '0064']
context7_verified: []
---

# Implementation Plan: 检索条件抽屉版式重构

## Summary

把 `optionsdesk` 检索条件抽屉的版面重做成 A′：值控件改下划线 + 光标 + 品牌浅底、各行值区齐右边界、权利金与价差并成一行、活跃度做成带框分组块、复位并入键盘右整列；同时把三视角行集统一到全部 5 行（合并后恒 4 行），建仓的行权价行带硬门槛口径提示。**纯 mobile、零服务端改动、零契约改动**；判据 / 默认值解算 / 三态边际计数一行不碰。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --------------------------------------- | ---- | --------------- |
| None                                    | N/A  | N/A             |

本片零新增 runtime 依赖：光标是一个 2px 宽的 `View`（纯视觉）、下划线是既有 border 工具类、ⓘ 复用 `052` 已 ship 的 `PremiumTip` 形态、键盘复用 `~/ui/numeric-keypad.tsx`。

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles.

逐条：**§ I SDD** —— specify → clarify（6 问 6 答）→ **Mockup**（`design/056-criteria-drawer-info.dc.html`，六项探测全绿）→ plan，UI feature 的 mockup 卡点已过，未跳步。**§ II TDD** —— 每 task 红→绿→typecheck/lint→`[X]`→stage→commit。**§ III** —— task 30min-2h、逐条独立 commit。**§ IV Module Boundary** —— 纯 mobile，无跨 bounded context 通信、无 Prisma 触碰。**§ V 类型同步链** —— **不触发**：无 server 改动 ⇒ 无 `export-openapi`、无 `api-client` regen；单 PR（mobile-only），故 § V 的「跨端两层验证」中的**契约冒烟一层不适用**（没有新契约面），只落 hermetic UI e2e + 真机。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: **N/A** —— 本片零 server 改动（`FR-019` 已实证行集统一不需要服务端跟着改：`applyOverride` 遍历全部六维、无 per-视角白名单；`matchesCriterion` 各支一律 `!== null` 守卫）。无新端点 ⇒ 无 real-boot smoke 对象。
- [x] **Mobile / Web**: 三个视角的抽屉 golden path 各走一遍（Expo Web e2e）+ 真机走 P1 用户故事（US1 输入位可辨识 / US2 版面 / US3 操作区 / US5 行集）。
- [x] **Evidence**: 走 `apps/mobile/e2e/optionsdesk-criteria-sheet.spec.ts`（既有，本片扩）+ 真机验收读数写回 spec（`FR-050` / `SC-001`–`SC-005`）。真机口径沿 `053` T013：几何用滚动差分锁边界、颜色用 `screencap` 原始 RGBA 采样、热区**叠加 `hitSlop`**。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片不引入任何第三方 package / SDK / tool（见 § Dependencies 的 explicit no-op）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native.** 本片触及的四个文件（`leg-criteria-sheet.tsx` / `leg-criteria.rules.ts` / `optionsdesk-copy.ts` / `~/ui/numeric-keypad.tsx`）全部诞生于 mono（`052` / `053` / `026`），与旧 meta-repo 的 Java/Spring 代码零交集。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

**无受影响的 Open Question。** 逐条验证过程：

1. `rg -l 'Open Question' docs/adr/` 列出 20 份带 Open Questions 的 ADR。
2. 本片所依赖的两份 optionsdesk ADR 逐份核：
   - **`ADR-0064`（optionsdesk 检索分层）** —— **没有 Open Questions 段**（`rg -A 12 '## Open Questions' docs/adr/0064-*.md` 零命中）。
   - **`ADR-0062`（optionsdesk bounded context）** —— Open Questions 原文是 **「无（M1 范围内决策已定）」**；其复审记录里挂的两条绊线（`ADR-0048` sunset trigger #2：许愿单实时价 / 盘中实时 spot）与本片**零交集**（本片不碰取数、不碰 spot、不碰判据）。
3. 其余 18 份均属 server / marketdata / ideation / chat / 部署域，本片零触碰。

**Evidence**: 上述两条 `rg` 的输出（本 session 内已跑）。

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | ---------------------- | -------------- | ---------------------- |
| —   | 无                     | —              | —                      |

## Architecture Notes

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

> 三条 lifecycle 铁律（NO LIFECYCLE MOCKING / MANDATORY INTEGRATION / EXHAUSTIVE BRANCHING）针对的是 **NestJS Guard / Interceptor / Filter / Pipe**。**本片零 server 改动 ⇒ 前两条无适用对象**，逐字保留在此仅为不软化模板语言。

**第三条 EXHAUSTIVE BRANCHING 本片适用且已改口径**：`state_branches` 的 14 条**主落层是够得到它的那一层**，不是 server integration test（本片根本没有 server 改动，服务端 IT 结构上够不到任何一条）。逐条落层见下方 § 验证分层。

### 版面结构落在表达层，`leg-criteria.rules.ts` 只留维度↔框映射

🚨 **本片最重要的一条落法裁定。** 抽屉的「哪几行 / 什么顺序 / 哪两个并成一行」**全部落 `leg-criteria-sheet.tsx`**，判据文件只保留「维度 → 框」的映射。

- **删** `ROWS_BY_TAB` + `HAS_DEFAULT` + `criteriaRowsFor`。行集统一后 `criteriaRowsFor` 的第二分支（「有值必可见」）在结构上**不可达**（固定行集已含全部 5 行，`||` 短路后永不求值），而一个「恒返回全集、两个入参都不看」的函数比删掉更坏。这正是 `FR-012` 登记的那个 orphan，按仓内纪律「我的改动产生的 orphan 必须清理」处置。
- **保留且零行 diff**：`ROW_CRITERIA` / `CRITERIA_ROWS`（维度分组与序）· `CRITERION_FIELDS` / `CRITERION_KEYS` · `changedCriteria` / `normalizeCriteriaForm` / `sameCriteriaForm` / `criteriaFormOf` —— 即 `FR-040` 圈定的判定与换算面。
- 📌 **本片因此用不满 `FR-040` 的松绑**：该文件是**净减**，判定与换算一行未动。
- 📌 **表达层已有先例**：`leg-criteria-sheet.tsx` 里的 `ROW_FIELDS` 注释逐字写着「与 `leg-criteria.rules.ts` 里那份不是同一张表……这张是**版面顺序**」。本片是把这条既有分工用到底，不是新造分层。
- ⚠️ **渲染序 ≠ 维度键序**：`CRITERIA_ROWS` 的键序是 strike / dte / premium / liveness / spread，而 A′ 的版面是 `行权价` / `期限天` / `权利金+价差` / `活跃度块` —— 价差被提到权利金旁边、活跃度块落到最后。⇒ 版面序是表达层的独立常量，**MUST NOT** 靠改 `ROW_CRITERIA` 的键序来实现（那会连带改掉计数行的语义面）。
- ⚠️ **一个行为副作用要登记**：键盘初始落点取「第一行的第一个框」。建仓此前第一行是 `期限天` ⇒ 落 `dteMin`；行集统一后第一行是 `行权价` ⇒ 落 `strikeMin`。**这是行集统一的直接推论，不是 bug**，但 e2e 若断言过初始落点需同步改。
- **绊线**：将来若某个视角要重新收起某一行，回看 `spec` `FR-012` 与本节 —— **别默默加回一张 per-tab 行集表**，那会同时复活「任意子集」的版式复杂度与 A′ ③ 的无定义缺口。

### `~/ui/NumericKeypad` 的扩展必须是加法，且现有 e2e 兜不住

- 扩展形态：新增三个**可选**入参 `secondaryLabel?` / `onSecondary?` / `secondaryTestID?`。**省略即今日行为**（右整列仍是单一确定键）⇒ `alert/value-input-sheet.tsx` 调用点一字不改（`FR-023`）。
- 🚨 **`SC-006` 按现状是空的，必须补一条否定断言。** 已核过 `apps/mobile/e2e/alert-condition-ux.spec.ts`：它只用 `keypadType` / `keypadBackspace` / `keypadConfirm` 并断言「确定」的可点 / 禁用态 —— **右列若多出一个它没有语义的键，这些断言照样全绿**。⇒ 本片 MUST 在 alert 侧补「键盘右整列**没有**次级键」的否定断言，否则 `FR-023` 无验证手段。
- 右列内部布局：复位**固定高**、搜 `flex-1`。📌 **为什么这里 `flex-1` 不踩那个坑**：右列的父高度由**左侧 4×`h-16` 数字网格**经 `alignItems: stretch` 决定，**是确定高度**；被禁的是「无确定高度父容器里裸 `flex-1`」。两者不矛盾，但 ⚠️ **仍 MUST 真机验键盘末行 `0` / `.` / `⌫` 可点**（`FR-014`）——web 视口够高，这条永远不会在 e2e 里红。
- 复位在上、搜在下（`FR-021`），视觉双通道：搜 = brand 实心 / 复位 = 次级描边（`FR-022`）。

### 值控件：形态换，范式不换

- `CriteriaInput` 由「圆角边框盒 + 居中值」改为「下划线 + 值左对齐 + 品牌浅底」；选中态**双通道**（下划线转 brand **且** 底色转 brand-soft）。
- 光标 = 一个 2px 宽的 `View`，**纯视觉**。🚫 **MUST NOT 改回 `TextInput`**（`FR-002`）—— 值仍是只读 `Text` + 自绘键盘落点。回退会同时复发 `053` T013 的两条 FAIL，而 **web e2e 不会红**（web 没有输入法）。
- 值走 `text-ink`（与行标签同深）、占位符走 `ink-subtle`（`FR-005`）。⚠️ 占位符 2.85 对比度是 § Out of Scope 已登记的既有缺陷，**本片不动**。

### ⓘ 落点与文案

- ⓘ 进 `RowLabel`（`FR-016a`，mockup 实测定案）：`RowLabel` 加一个可选 tip slot。行标签 `w-20` 定宽不变 ⇒ 值区起点与宽度零变化，`FR-010` 由结构保证。
- 热区沿用 `hitSlop={16}` + `h-6 w-6`（≈52.8dp）。🚫 **复核热区 MUST NOT 用 view bounds** —— `hitSlop` 不进 bounds，`053` T013 在这里误报过一次。
- `optionsdesk-copy.ts` 新增：活跃度分组标签、「满足任一」规则说明、行权价硬门槛口径提示（含其 a11y label）。🚫 **MUST NOT 改 `countLabels`**（`FR-034`：本片是**沿用**「活跃度」这个既有叫法，不是改名）。

### 验证分层（`state_branches` 14 条的落层）

本仓测试分层：**vitest = logic-only，UI 走 Playwright Web**（🚫 禁 vitest 组件 render 测）。

| 层                                                | 覆盖哪些分支                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **vitest**（`leg-criteria.rules.spec.ts`）        | 「未编辑 ⇒ 提交的表单等于默认值投影」（`SC-013` 的可测形态）· 一维计数（`SC-012`）。⚠️ `criteriaRowsFor` 的既有用例**随函数一并删**  |
| **Playwright**（`optionsdesk-criteria-sheet.spec.ts` 扩） | 三视角行集恒 5 行且位置不跳 · 「不限」占位符 · 选中态双通道 · 点框不弹系统键盘（web 无输入法，只能验「无 `textbox` 角色」）· 复位/搜各恰一个 · 分组块与规则文案 |
| **Playwright**（`alert-condition-ux.spec.ts` 扩） | 🚨 alert 屏键盘右列**无次级键**的否定断言（`SC-006`，见上）                                                                          |
| **真机**（Mate50）                                | 四类 web 结构性验不到的：行不折行不截字 / sheet 高度与键盘末行可点 / 系统键盘真不弹 / 值可读（`FR-050`）                             |

📌 **`SC-013`「已证明它会红」的可操作形态**：在 vitest 里断言「未触碰任何一格时，`normalizeCriteriaForm(criteriaFormOf(defaults))` 逐字段等于默认值投影」，再用一次**故意的预填**改动证明该断言会红。🚫 别把它写成「候选集不变」的 e2e —— 本片根本不改请求参数，那样的断言恒绿、抓不到东西。

📌 **预期的零覆盖，写明是故意的**（免得 `/speckit-analyze` 当缺口补 task）：`FR-018`（supersede 登记）、`FR-050`（真机验收本身）、`SC-017` 属**流程与文档判据**，不产出代码行、无自动化覆盖对象。

### 改动面清单（四个文件，无新建源文件）

| 文件                                       | 改什么                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `apps/mobile/src/optionsdesk/leg-criteria-sheet.tsx` | 版面结构（行序 / 合并行 / 分组块）· 值控件形态 · ⓘ 落点 · 复位移入键盘        |
| `apps/mobile/src/optionsdesk/leg-criteria.rules.ts`  | **净减**：删 `ROWS_BY_TAB` / `HAS_DEFAULT` / `criteriaRowsFor`               |
| `apps/mobile/src/optionsdesk/optionsdesk-copy.ts`    | 新增分组标签 / 规则说明 / 硬门槛口径提示；`countLabels` 零改动                |
| `apps/mobile/src/ui/numeric-keypad.tsx`             | 加法式次级键（三个可选入参）；省略即今日行为                                 |

🚫 **`apps/mobile/src/theme/` 零行 diff**（`FR-041` / `SC-008`）。🚫 **`apps/server/` 零行 diff**。

## Complexity Tracking

> 无 Constitution 违规需要豁免。

下面这条不是违规，是**跨片约束的显式松绑**，登记在此以免被读成偷改：

| 松绑                                              | 为什么需要                                                                                              | 更简单的替代为何不成立                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `052` `FR-007` / `FR-010`（per-视角行集）被 supersede | `spec` `FR-018` 已裁定并登记；它同时消掉「任意子集」的版式复杂度与 A′ ③ 在全腿的无定义缺口，并补上建仓无法表达价位偏好这个功能缺口 | 保留 per-视角行集 ⇒ A′ ③ 在全腿仍无定义、版式要对任意子集成立；而「只给全腿加价差行」只解一半，建仓的功能缺口留着 |
