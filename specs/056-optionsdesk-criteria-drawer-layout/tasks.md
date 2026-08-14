---
feature_id: 056-optionsdesk-criteria-drawer-layout
spec_ref: ./spec.md
plan_ref: ./plan.md
status: tasks-ready
created_at: '2026-08-14'
updated_at: '2026-08-14'
---

# Tasks: 056-optionsdesk-criteria-drawer-layout（检索条件抽屉版式重构 —— 输入位可辨识 + 右边界对齐 + OR 显式化 + 行集统一）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md)
**Branch**: `056-optionsdesk-criteria-drawer-layout`
**Mockup**: `design/056-criteria-drawer-info.dc.html`（3 候选定 ⓘ 落点，六项探测全绿）+ `design/handoff-info-placement.md`（local-only）；整体版式沿用 `053` 的 A′ 帧

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一 task 内闭环。
- 层级：`[Mobile]` / `[Mobile-E2E]` / `[Verify]` / `[Gate]`。🚫 **本片无 `[Server]` / `[Contract]` / `[Contract-Smoke]`** —— 零服务端改动、零契约面（plan Gate 0.1 已实证）。

## 🚨 `state_branches` 的落层裁定（先读这条）

spec 的 **14 条 `state_branches` 里没有一条落得到服务端 IT** —— 本片零 server 改动，服务端 IT 结构上够不到任何一条。

⇒ 执行口径沿 `052` T015 / `053` 的裁法：**每条至少有一个 `it()`，其主落层是够得到它的那一层**。主落层分区：

| 主落层                       | 条数   | 哪几条                                                                                                             |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| **Mobile e2e**（抽屉）       | 10     | 行集恒定 · 建仓 ⓘ · 全腿价差默认不限 · 全腿手动设价差后计数报出 · 某维默认为空仍出行 · 契约未到手 · 选中双通道 · 空值占位符 · 点框不弹系统键盘 · 点复位 |
| **Mobile e2e**（`alert` 屏） | 1      | `alert` 复用同一键盘 → 右整列仍单键                                                                                |
| **vitest**（logic-only）     | 2      | 点搜的显式提交与半空归零 · OI/Vol 一维计数                                                                         |
| **真机**                     | 1      | 未选中且有值 → 值与标签同深（颜色，web 验不到）                                                                    |
| **合计**                     | **14** | —                                                                                                                  |

另有 3 条在次落层加断言（值可读在 e2e 验 class 存在、点框在真机复验、行集在 vitest 验投影），不影响分区。

🚫 **MUST NOT** 照 plan `§ Testing Invariants` 的字面「每条在 integration test 里有对应 `it()`」去补 14 条不可能的 server IT —— 那三条铁律针对的是 NestJS lifecycle 组件，本片无适用对象（plan 已注明）。

📌 **矩阵值域声明**（per `sdd-authoring.md` 反模式第 4 条 —— 这一问在「逐条 grep」之前）：本轮扫的是 **`state_branches` / Acceptance Scenario / Edge Case / FR / SC 五层**。§ 背景、§ 依赖与前提、§ Clarifications 定案、§ Out of Scope 的去向**已逐条核回 FR/SC，无表外需求** —— 其中 § 背景「行集统一」那节的三项实证已由 `FR-019` 吸收，§ Clarifications 六条定案分别落 `FR-012/013/015/032/034/035`。

## Path Conventions

| 用途                          | 路径                                                     |
| ----------------------------- | -------------------------------------------------------- |
| 抽屉本体（本片主战场）        | `apps/mobile/src/optionsdesk/leg-criteria-sheet.tsx`     |
| 判据 + 维度↔框映射（**净减**） | `apps/mobile/src/optionsdesk/leg-criteria.rules.ts`      |
| 判据单测                      | `apps/mobile/src/optionsdesk/leg-criteria.rules.spec.ts` |
| 文案                          | `apps/mobile/src/optionsdesk/optionsdesk-copy.ts`        |
| 共用键盘（**两个 consumer**） | `apps/mobile/src/ui/numeric-keypad.tsx`                  |
| 抽屉 e2e                      | `apps/mobile/e2e/optionsdesk-criteria-sheet.spec.ts`     |
| `alert` 回归 e2e              | `apps/mobile/e2e/alert-condition-ux.spec.ts`             |

🚫 **零 diff 的两处**：`apps/mobile/src/theme/`（`SC-008`）· `apps/server/`（本片纯 mobile）。

🚨 **e2e 跑哪条路径**（2026-08-14 impl 期实证订正，T001 撞到；同日**根因已定位并修掉**，见下）：下文 `→ verify` 里写的 `nx run mobile:e2e`（Metro dev server）当时在本机整屏白 —— `[page-error] Cannot read properties of undefined (reading 'default')`，`git stash` 后**干净树上同样红** ⇒ 与本片无关的既有故障。**该故障已在独立 PR #42（`fix/metro-pretty-format-esm-interop`）修复**：`pretty-format@30` 的 ESM 包装被 Metro 用 Babel interop 编译致 `default` 错位，打崩 Metro 自带的 HMRClient；只影响 dev bundle，故 `build` / `runtime-smoke` 一路绿。**本片仍走 `runtime-smoke`**，理由与那条故障无关：它是 CI 实跑的那条（`pr-validation.yml` / `nightly-sweep.yml`），也是 `local-verification.md` §2 唯一列出的那条，且静态 bundle 比 dev server 更快更稳（干净树上 191 passed / 38.8s）。<br>📌 迭代时拆成两步（改一次源码只需重跑 export 一次）：<br>① `EXPO_PUBLIC_FEATURE_MARKETS=true EXPO_PUBLIC_OSS_PUBLIC_BASE_URL=https://oss-e2e.example.com pnpm exec expo export -p web --clear --output-dir dist-runtime-smoke`<br>② `pnpm exec playwright test -c playwright.runtime-smoke.config.ts <spec> --reporter=list`（cwd 均为 `apps/mobile`）

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红）

1. **把值改回 `TextInput`** 去拿原生光标 —— `053` T013 两条 FAIL 同源于此，回退即复发；而 **web e2e 永远不会红**（web 没有输入法）。光标只能是 2px 的 `View`。
2. **把键盘右列改成「恒两键」** —— `alert` 屏会多出一个它没有语义的按钮，**typecheck 全绿、`alert` 现有 e2e 也全绿**（它只断言「确定」的可点 / 禁用态）。扩展必须是**可选入参**，且必须补否定断言（T001）。
3. **靠改 `ROW_CRITERIA` 的键序**实现版面序 —— 那会连带改掉计数行的语义面（`CRITERION_KEYS` 是计数展示序）。版面序 MUST 是表达层独立常量。
4. **给「搜」套一层无确定高度的 `flex-1` 容器** —— 键盘父容器塌缩、末行 `0`/`.`/`⌫` 被挤出屏不可点，**web 视口够高照样全绿**。右列内部的 `flex-1` 是安全的（父高由左侧 4×`h-16` 网格经 stretch 决定），但套一层新容器就不是了。
5. **把 ⓘ 放值区右侧或值区内部** —— mockup 已实测：前者让该行值区右缘短 32px（破 `FR-010`），后者挤掉两个框各 15px。**MUST 进行标签内**（`FR-016a`）。
6. **拿 `uiautomator` 的 view bounds 判 ⓘ 热区** —— `hitSlop` 不进 bounds，`053` T013 在这里把达标的误判成 FAIL。
7. **顺手修「不限」占位符的 2.85 对比度** —— 预先存在、且会波及 `052` 全部占位符，spec `§ Out of Scope` 已登记「不改只登记」。
8. **顺手把 Tab 标签改叫「接货」** —— 那是 shipped 文案改动，与版式正交（`FR-034` 已登记）。
9. **分了组就把 OI/Vol 拆成两维** —— 同一条腿会同时计进两行边际计数（`052` T010 有断言守）。
10. **新增任何 design token / 配色** —— `theme/` 必须零行 diff。

## Phase 1 · 独立基座（可并行）

- [X] T001 [P] [Mobile] **`~/ui` 键盘的加法式次级键**（`FR-023`, `FR-020`–`FR-022`, `FR-042`）：`apps/mobile/src/ui/numeric-keypad.tsx` 新增三个**可选**入参（次级键文案 / 回调 / testID），省略即今日行为；右整列布局改为「次级键固定高在上 + 确定键 `flex-1` 在下」。🚫 **左侧 4×3 数字网格与固定键高一格不动**（`FR-042`）。→ verify: 先在 `apps/mobile/e2e/alert-condition-ux.spec.ts` 补一条否定断言「`alert` 参数屏键盘右整列**不存在**次级键」，把次级键写成恒显以证明它**会红**，再改成可选入参转绿；`nx run mobile:e2e` 该 spec 全绿（`SC-006`）。

- [X] T002 [P] [Mobile] **行集统一 + 判据文件净减**（`FR-012`, `FR-019`, `FR-040`, `FR-044`）：`leg-criteria.rules.ts` 删 `ROWS_BY_TAB` / `HAS_DEFAULT` / `criteriaRowsFor`；抽屉改为直接渲 `CRITERIA_ROWS` 全集。同 commit 删 `leg-criteria.rules.spec.ts` 里针对 `criteriaRowsFor` 的用例（**测试删除必须在 commit message 点名**，不夹带）。→ verify: 新增 vitest 断言「未触碰任何一格时 `normalizeCriteriaForm(criteriaFormOf(defaults))` 逐字段等于默认值投影」，用一次**故意的预填**证明它会红（`SC-013`）；`git diff` 该文件为**净减**且判定与换算面零行改动（`SC-007`）。<br>📌 **`FR-044`（提交语义零改动）的落点在这条**：`052` 已 ship 的 `normalizeCriteriaForm` / `sameCriteriaForm` / `changedCriteria` 单测**一条不改、必须保持全绿** —— 这是「显式提交 + 成对维度半空归零」的回归防线（`sb` 第 11 条的主落层）。🚫 删用例仅限 `criteriaRowsFor` 那几条，**碰到其余任何一条即越界**。

- [X] T003 [P] [Mobile] **文案新增**（`FR-034`, `FR-016`, `FR-030`）：`optionsdesk-copy.ts` 加活跃度分组标签（**「活跃度」，沿用 `countLabels.livenessMin` 的既有叫法**）· 「满足任一」规则说明 · 行权价硬门槛口径提示正文与其 a11y label。🚫 `countLabels` 零改动。→ verify: `rg '活性' apps/mobile/src/` 在**用户可见文案**中零命中（`SC-016`）；`rg` 确认「活跃度」与 `countLabels.livenessMin` 逐字一致。

## Phase 2 · 抽屉版面（同一文件，逐条串行）

> 🚨 T004–T007 全部改 `leg-criteria-sheet.tsx`，**互相不并行**。

- [X] T004 [Mobile] **值控件形态换、范式不换**（`FR-001`–`FR-005`, `FR-043`）：`CriteriaInput` 由圆角边框盒改为下划线 + 值左对齐 + 品牌浅底；选中态**双通道**（下划线转 brand **且** 底色转 brand-soft）+ 2px 光标 `View`。值仍是只读 `Text`。→ verify: e2e 断言选中框同时具备两个通道、且**全屏无 `textbox` 角色**（系统键盘无唤起路径，`sb` 第 9 条）；空值仍呈「不限」且非 `0`。

- [X] T005 [Mobile] **版面重排：齐右边界 + 合并行 + 分组块**（`FR-010`, `FR-011`, `FR-013`, `FR-030`–`FR-033`, `FR-035`）：版面序落表达层独立常量 —— `行权价` / `期限天` / `权利金+价差`（等分两半）/ `活跃度`分组块；单值行一律齐右边界、单位跟值区右端；区间行保持「标签 + [框] – [框]」不拆 `≥`/`≤`；分组块含品牌浅底标签 + 一行**只读**「满足任一」规则说明，规则位宽度按 segmented 预留。🚫 **MUST NOT 实装可切换的 AND/OR，也 MUST NOT 画一个禁用态的 segmented**（`FR-032`：禁用态是「暂时不能改」，这里是「压根没有这个旋钮」）。→ verify: e2e 断言四行结构与顺序、分组块内两框仍只出**一个**「已改」蓝点（`SC-012`）；🚫 MUST NOT 通过改 `ROW_CRITERIA` 键序实现（Guardrail 3）。

- [X] T006 [Mobile] **复位移入键盘右整列**（`FR-020`–`FR-022`, `FR-024`）：字段区那一行独占的「复位」删掉，改用 T001 的次级键入参；顺序**复位在上、搜在下**，视觉双通道（搜 = brand 实心 / 复位 = 次级描边）。→ verify: e2e 断言全屏「搜」与「复位」**各恰一个**（`SC-009`）、且字段区不再有独占一行的复位；依赖 T001。

- [X] T007 [Mobile] **ⓘ 进行标签**（`FR-016`, `FR-016a`）：`RowLabel` 加可选 tip slot，行标签 `w-20` 定宽不变；建仓的行权价行挂硬门槛口径提示，形态与热区沿用既有 `PremiumTip`（`hitSlop={16}` + `h-6 w-6`）。→ verify: e2e 断言该 ⓘ 存在且 tap 开/再 tap 关；断言行权价行值区右缘与其余行**逐像素一致**（`FR-010` 的结构保证，mockup 已实测 Δ=0）。

## Phase 3 · 验证与收口

- [X] T008 [Mobile-E2E] **抽屉 e2e 补齐主落层的 10 条分支**（`FR-017`, `SC-011`, `SC-014`, `sb` 1–7 / 9–11）：`apps/mobile/e2e/optionsdesk-criteria-sheet.spec.ts` 扩 —— 三视角行集**恒 4 行且各行位置不跳** · 全腿价差行默认「不限」且 `051` 那个排除数入口默认态仍指向含目标腿的表 · 全腿**手动**设价差后边际计数报出「价差上界之外还有 N 条」 · 某维默认为空仍出行 · 契约未到手全「不限」。<br>➕ **新露出的行，其值必须真的到得了请求**（US5-AS1 后半，analyze A2 补）：建仓视角设一个行权价上界并提交 → hermetic mock 断言请求**带上了该上界**、且结果按它收窄。<br>📌 存在理由：行集统一让这一行**首次在建仓可编辑**；虽然该链路与收租共用（收租本就有这一行）⇒ 风险低于表面，但「行渲染出来了、值却没接到请求上」是一种**屏上完全看不出**的失败。对称的另一半（全腿设价差 → 计数报出）已在上一条。→ verify: `nx run mobile:e2e` 该 spec 全绿；hermetic mock **写依赖方契约**、不按测试编排分支（mobile playbook 铁律）。

- [X] T009 [Verify] **真机验收**（`FR-014`, `FR-015`, `FR-050`, `SC-001`–`SC-005`, `SC-015`）：Mate50 dev-client 走三视角各一屏 —— ① 行数一致、零折行零截字、单位未被挤走 ② sheet 高度**不劣于改版前同视角** + 未触 `max-h-[92%]` + 键盘末行三键**实测可点** ③ 任一格上系统键盘 100% 不弹 ④ 值与标签同深可读 ⑤ ⓘ 热区（**叠加 `hitSlop` 判，🚫 别用 view bounds**）⑥ **分组块规则位的实装宽度**（`SC-010`, `FR-031`；analyze A1 补）。<br>🚨 **⑥ 的判据必须两个量都在实装上取**：量「规则位槽宽」与「两个规则选项文案在同字号下的排版宽度」，比的是这两者。🚫 **MUST NOT 拿 mockup 那对数（130 / 124）当判据** —— 那是 mockup 里那个槽位的宽度，不是实装组件的；`FR-031` 承诺的「将来升级只换槽内内容、块高与字段区行数不变」若在实装上不成立，**不会红、也没人会发现**，直到升级那一片。<br>📌 这是**一次性读数、不是常驻守卫** —— 常驻守卫要求把 segmented 真建出来，而 `FR-032` 已裁定本片不做。该局限如实登记在验收单里。→ verify: 逐项读数**写回 spec**（含未达标项与误判登记）；口径沿 `053` T013：几何用滚动差分锁边界、颜色用 `screencap` 原始 RGBA 采样。

- [ ] T010 [Gate] **supersede 登记与 PR body**（`FR-018`, `SC-017`）：在 PR body 显式登记本片对 `052` `FR-007`（建仓无行权价行）与 `FR-010`（全腿无价差行）的 supersede，并复述「行集统一是行为惰性的、默认候选集逐视角零变化」这一正当性前提。→ verify: PR body 含该段 + 仓库模板的部署存活前置确认 3-checkbox（CI 硬扫）；三份产物 frontmatter `status` 翻 `implemented`。

## Dependencies

```text
T001 ─┐
T002 ─┼─(并行)─► T004 ─► T005 ─► T006 ─► T007 ─► T008 ─► T009 ─► T010
T003 ─┘                  └── 同一文件, 严格串行 ──┘
```

- **T006 依赖 T001**（次级键入参必须先存在）。
- **T004–T007 同改 `leg-criteria-sheet.tsx`**，无 `[P]`。
- **T003 应早于 T005 / T007**（两者要用新文案）。
- T008 依赖 T004–T007 全部落地；T009 依赖 T008（web 层先把结构面锁住，真机只验 web 验不到的四类）。

## Clear 检查点批次

per Constitution § III + `implement-task-closure.md`（每 2-3 个强关联 task，硬上限 5）：

| 批次 | task           | 停顿点                                     |
| ---- | -------------- | ------------------------------------------ |
| ①    | T001–T003      | 三个独立基座全绿后建议 `/clear`            |
| ②    | T004–T005      | 抽屉主体版面成形后建议 `/clear`            |
| ③    | T006–T007      | 操作区与 ⓘ 落位后建议 `/clear`             |
| ④    | T008–T010      | 收口                                       |

🚨 **批次 ≠ commit 合并** —— 每 task 仍各自 atomic commit。

## 故意的零覆盖（写明，免得 `/speckit-analyze` 当缺口补 task）

| 条目                        | 为什么没有自动化覆盖                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `FR-018` / `SC-017`         | 流程与文档判据（supersede 登记），由 T010 人工兑现，不产出代码行         |
| `FR-050`                    | 真机验收**本身**就是验证手段，不存在「验证这条验证」的自动化对象         |
| `FR-041` / `FR-045`         | 「零改动」类约束，判据是 `git diff` 为空（T002 / T009 的 verify 里带扫） |
| Edge Case「契约未到手 ⇒ 八格全呈『不限』」 | **该分支在当前实装下不可达**（T008 实测）：抽屉入口闸在 `criteria !== null` 上（`underlying-detail-screen.tsx` 的 `openCriteria` useMemo）⇒ 契约未到手时入口整个不渲染，用户没有任何路径能打开那一屏。`criteriaFormOf(null)` 的全空分支在组件里存在但走不到。<br>⇒ T008 改断言**可达的那个真相**（入口不出现）。🚫 MUST NOT 为凑覆盖绕过闸门打开抽屉 —— 那测的是产品里不存在的路径，是一条会冒充覆盖的恒真断言。<br>📌 **「该不该让它可达」是产品判断，超出本片边界，未处理只登记。** |

> ⚠️ **本表 2026-08-14 删去过一行**：`SC-010`（规则位宽度预留）原以「mockup 期已实测 130 ≥ 124，实装期不重复量」列为故意零覆盖 —— **该理由不成立**（analyze A1）：130px 是 mockup 里那个槽位，不是实装组件的。已改为 T009 ⑥ 的实装读数。**留此注记是为了让下一个人知道这行是被推翻的，不是被漏掉的。**
>
> ⚠️ **同一条理由 2026-08-14 又推翻了第二个数**（T005/T007 impl 期）：`FR-011` 原记「最紧处值区内宽 76px，余 24px」同样是 **mockup 槽位**读数。实装后在 390×844 窄视口（该 e2e 文件头 `test.use`，≈ 真机宽度）实测 **71px，余 19px** —— 容量判据（≥ 52px 装 6 位小数）仍满足，短的是余量。spec `FR-011` 已订正，并把**下界 ≥ 52** 常驻进 T005 那条 e2e。<br>📌 **顺带订正一条 impl 期的错判**：T005 commit 里写过「web e2e 视口宽、这条量不出、留给 T009」—— 那是错的，本文件跑的就是 390px 窄视口。⇒ **凡是「web 量不到」的断言，先去看 `test.use` 的视口再下结论。**<br>📌 `FR-011` 里那两个位置读数（权利金齐中缝 / 价差齐外缘的 px 值）同为 mockup 来源、**未经实装复测**，勿当实装判据引用。
