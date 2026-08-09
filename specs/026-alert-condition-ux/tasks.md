---
feature_id: 026-alert-condition-ux
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-12'
---

# Tasks: 026-alert-condition-ux（预警条件配置页交互重构 — 同花顺式自定义键盘 + 多选）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `026-alert-condition-ux` | **Mockup**: [`design/06-12-sheet-family-baseline.html`](./design/06-12-sheet-family-baseline.html)（4 状态族，已验收）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Mobile]` / `[Mobile-E2E]` / `[Verify]`（**纯 mobile，无 Server/Contract/Contract-Smoke——零契约改动**）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；**纯逻辑（keypad 规范化 / reconcile / quota / placeholder builder）= vitest**；**UI·render·a11y·交互 = Playwright Expo Web e2e**（mono 测试分层：~/ui 与组件渲染不写 vitest）
- 无 task-meta JSON（**manual 模式**，per 004-024）
- 🚨 **纯交互重构（零 server / 零契约 / 零 migration / 零 api-client regen / 零新库）**：改动全落 `apps/mobile/src/alert/`；复用 34 类条件词表 / `(type,param,threshold)` 草稿 shape / `thresholdValid` 校验口径
- 🚨 **021/023/024 零回归**：草稿→request（`toConditionEntries`）口径不变；条件卡片摘要 / 消息正文（`formatConditionLine` 等）不动；既有 alert e2e/vitest 断言全保留
- 🚨 **配色铁律**：新控件（选中 chip / 键盘「确定」）一律 brand 蓝（`brand-500`/`brand-soft`）；红/绿仅行情涨跌。**0 新 token**（设计基线已锚既有 hex→class）
- 🚨 **单实例阈值类**（threshold/rsi，单 `(type,0)`）走键盘「确定」；纯周期类（ma/window）走「选好了」；组合类（daysPct/pctile）多选 chip + 键盘「确定」（Clarify 提交分流）

## Path Conventions

- mobile：`apps/mobile/src/alert/`（021/023 既有 feature dir 改造）；routes 不变（`app/(app)/alert/`）；`~/theme`/`~/ui`/`~/portfolio`(quote merge) 0 重设零新库
- e2e：`apps/mobile/e2e/`（mock alert 端点 + 015 EP2 quote + 003 refresh per memory）；本 feature 无 contract-smoke（契约零变化）
- 测试运行：mobile vitest = `pnpm nx test mobile <file>`；e2e = `pnpm nx run mobile:e2e`（或既有 alert e2e target）；**新文件首跑带 `--skip-nx-cache`**（防 cache 假绿）

---

## Phase 1: Foundational — 纯函数底座（vitest，无 UI；阻塞全部 US）

**Goal**：键盘规范化 / 批量 reconcile / 名额把守 / 参考 placeholder 四个纯函数红绿落地，供下游组件薄壳消费。

- [X] T001 [P] [Mobile] **键盘输入规范化纯函数** `apps/mobile/src/alert/keypad.rules.ts`：`applyKey(raw, key): string` + vitest（`keypad.rules.spec.ts`，红→绿全分支）——单小数点（已含「.」忽略；空串点「.」→「0.」）；前导零规范（"0" 后输数字替换整数位）；**整数位 ≤7、小数位 ≤2** 超出忽略（FR-003）；退格 `slice(0,-1)`；边界（空退格、"0."、超长、多点、纯小数）。**验**：vitest 绿
- [X] T002 [P] [Mobile] **批量 reconcile + 名额纯函数** `apps/mobile/src/alert/use-alert-draft.ts`：加 `reconcileConditions(list, type, selectedParams[], threshold): DraftCondition[]`（选中走 `upsertCondition`、未选中同 type 走 `removeCondition`、其余 type 原样保留，组合既有纯函数）+ `multiSelectQuota(conditions, type): {max, remaining}`（max = `MAX_CONDITIONS − 非本 type 条数`，plan D4）+ draft action `reconcile(type, params, threshold)` + vitest（`use-alert-draft.spec.ts` 扩：新增/移除/覆盖阈值/幂等无变化 / 名额按非本-type 算）。**验**：vitest 绿，既有 draft 断言不改
- [X] T003 [P] [Mobile] **参考 placeholder + 多选文案** `apps/mobile/src/alert/alert-copy.ts`：加 `referencePlaceholder(type, quote, copy): string`（到价类行情就位→「最新价 <last>」、未就位→「输入数值」；其余阈值类→既有占位，plan D5）+ 文案常量（`可多选` / `最多再选 {n} 项`）+ vitest（`alert-copy.spec.ts` 扩：就位/未就位/非到价类分支）。**验**：vitest 绿

**Checkpoint**：4 纯函数全绿 → 组件层只做渲染编排。

---

## Phase 2: US1 自定义数字键盘录入数值阈值（P1 · MVP）

**Goal**：阈值类条件（股价涨到/跌到/日涨跌幅/PE 等）在 sheet 内用自绘键盘录入、不弹系统键盘，非法值「确定」禁用。
**Independent Test**：开「股价涨到」sheet → 键盘点出合法价 → 「确定」可点并入草稿；点非法值 → 「确定」灰；全程 0 系统键盘。

- [X] T004 [P] [US1] [Mobile] **NumericKeypad 组件** `apps/mobile/src/alert/numeric-keypad.tsx`：4×4 网格（1-9 / `.` / 0 / `⌫` 占 3 列；竖排「确定」占右整列），全 `Pressable`（无新库、可 Playwright 点击驱动）；props `value`/`onKey`/`onConfirm`/`confirmDisabled`/`confirmLabel`；每键 `accessibilityLabel`（数字/「小数点」/「退格」/「确定」）+ `accessibilityState`；视觉锚设计基线 `.keypad`/`.key`/`.ok`（token：`surface`/`surface-sunken`/`brand-500`/`rounded-md`/`font-mono`，0 字面量）。渲染/交互验证留给 T010 e2e
- [X] T005 [US1] [Mobile] **value-input-sheet 数值路径重写** `apps/mobile/src/alert/value-input-sheet.tsx`：`TextInput`(系统 decimal-pad) → 只读显示 `Text`（`accessibilityLabel`=条件名+值），值由 T004 `NumericKeypad` + T001 `applyKey` 驱动；**移除 `KeyboardAvoidingView`**（无系统键盘）；「确定」`disabled = !thresholdValid(type, raw)`（FR-004）；threshold/rsi 单值变体通（RSI 出域沿用既有 `rsiError` 红边/红字态）。**验**：typecheck/lint 绿 + 既有 sheet 单值用例不破（交互 T010 e2e）
- [X] T006 [US1] [Mobile] **add-condition-screen 接线** `apps/mobile/src/alert/add-condition-screen.tsx`：传标的 `market/code` 给 sheet（供 T009 行情头 + placeholder）；`onConfirm` 由单 `upsert` 改调 `draft.reconcile`（值变体提交单 `(type,0)`）；无参条件直接入草稿行为不变（FR-018）。**验**：typecheck/lint 绿

**Checkpoint**：US1 = MVP，阈值类全流程同花顺式键盘可用。

---

## Phase 3: US2 多选带参条件批量生成（P2）

**Goal**：均线/新高低/N日涨跌幅/估值分位 chip 从单选改多选，「选好了」/「确定」批量生成，受上限 4 把守，编辑回显预勾选。
**Independent Test**：「创 N 日新高」勾 60+120 日→「选好了」→草稿增 2 条；草稿已 3 条时仅剩 1 名额，勾满后余 chip 禁选 + helper。

- [X] T007 [US2] [Mobile] **多选 chip + 名额 + reconcile** `value-input-sheet.tsx`：chip 单选→多选 `selected: Set<number>`（seed = 草稿同 type 已存 param，预勾选 FR-009）；选中态 `brand-soft`底+`brand-500`边+右下角勾标（小组件，蓝，0 token）；名额禁选用 T002 `multiSelectQuota`（`selected.size ≥ max` 时未勾 `disabled` 40% + helper「最多再选 N 项」FR-008）；提交分流——纯周期（ma/window）底部「选好了」→ `reconcile(type, [...selected], '')`；一个不勾「选好了」`disabled`（FR-007a）。**验**：typecheck/lint 绿（交互 T010）
- [X] T008 [US2] [Mobile] **组合变体（daysPct/pctile）** `value-input-sheet.tsx`：多选周期/年限 chip + 单阈值（键盘录入）+ 键盘「确定」提交（多 param 共用同阈值，`reconcile(type, [...selected], threshold)`，FR-011）；「确定」`disabled = selected.size<1 ∨ !thresholdValid`；**重开预勾选**草稿同 type 已存 param + **回显已存阈值**（FR-009 对组合同样适用——seed `selected` 与 threshold 显示框）。**验**：typecheck/lint 绿（交互 T010）

**Checkpoint**：US2 = 全部带参条件多选批量，上限不破。

---

## Phase 4: US3 sheet 行情条 + 参考提示（P3）

**Goal**：sheet 顶嵌行情条 + X 关闭；到价类输入框空态显示行情参考 placeholder。
**Independent Test**：开「股价涨到」sheet → 顶部行情条 5 字段 + 右上角 X 关闭不写草稿；空态 placeholder「最新价 1291.91」；行情未就位退「输入数值」。

- [X] T009 [US3] [Mobile] **sheet 行情头 + X + 参考 placeholder** `value-input-sheet.tsx`：顶部嵌 `InstrumentQuoteStrip`（接 T006 传入的 `market/code`，sheet 转 connected 内部走 `~/portfolio` quote merge）；右上角 X = `onClose`（与遮罩/系统返回同路径，不写草稿 FR-013）；只读显示框空态 placeholder 用 T003 `referencePlaceholder`（行情就位→「最新价 X」、未就位→「输入数值」，FR-014/015）。**验**：typecheck/lint 绿（交互 T010）

---

## Phase 5: Polish & 零回归

- [X] T010 [Mobile-E2E] **Playwright hermetic 交互流** `apps/mobile/e2e/`（mock alert 端点 + 015 quote + 003 refresh）：① 值类——开 sheet→键盘点合法价→「确定」入草稿 / 非法值「确定」灰 / 0 系统键盘；② 多选——勾多周期→「选好了」批量入草稿 / 满额禁选+helper / 空选「选好了」禁用；③ 组合类（N日涨幅超）——多选+键盘阈值+「确定」；④ X/遮罩关闭不写草稿；⑤ 编辑回显预勾选 + 取消勾选「选好了」移除。**验**：e2e 绿（首跑 `--skip-nx-cache`）
- [X] T011 [Verify] **零回归 + gate**：021/023/024 既有 alert e2e + vitest 复跑全绿（FR-019/SC-005）；**显式 assert 负向约束**——条件词表（34 类）/ 4 分类 rail / `(type,param,threshold)` 草稿 shape / `toConditionEntries` 口径未变（FR-016/017，可 grep + 既有断言佐证）；`pnpm nx affected -t lint typecheck test build e2e --base=origin/main`（首跑 `--skip-nx-cache`）；本地 Expo simulator 走查（键盘/多选/行情头）留迹 PR 描述；spec frontmatter `status: draft → implemented`、plan `status: drafted → approved`

**Checkpoint**：单 mobile PR 全绿，可 `feat(alert)` 合入。

---

## Dependencies

```text
Phase 1 (T001/T002/T003 并行) ──┐
                                ├─► T004 (NumericKeypad, 可与 P1 并行起手)
T001 ──► T005 ──► T006 ──► T009          (US1 sheet 壳 + 接线 → US3 行情头)
T004 ──► T005
T002 ──► T007 ──► T008                    (US2 多选 → 组合变体)
T005 ──► T007
T003 ──► T009
(T006/T007/T008/T009 全完) ──► T010 (e2e) ──► T011 (verify)
```

- **Foundational 阻塞**：T001/T002/T003 必须先于消费它们的组件 task。
- **US1 (T004-T006) = MVP**，可独立交付（值类键盘）；US2/US3 在其上增量。
- **同文件串行**：T005/T007/T008/T009 均改 `value-input-sheet.tsx` → 必须串行（不可并行），按 US1→US2→US3 顺序叠加。

## Parallel 示例

```text
# 起手并行（不同文件，无依赖）：
T001 (keypad.rules.ts) ∥ T002 (use-alert-draft.ts) ∥ T003 (alert-copy.ts) ∥ T004 (numeric-keypad.tsx)
# 之后 value-input-sheet.tsx 系列串行：T005 → T007 → T008 → T009
```

## Implementation Strategy

- **MVP = US1（T001+T004+T005+T006）**：阈值类同花顺式键盘可用即可演示核心价值（用户点名的主交互）。
- **增量**：US2（多选批量）→ US3（行情头+参考提示）→ e2e + 零回归。
- 每 task 走 6 步闭环（红→绿→typecheck/lint→`[X]`→`git add` 含 tasks.md→commit），逐个 atomic commit；每 2-3 个强关联 task 一个 /clear 检查点（硬上限 5）。
