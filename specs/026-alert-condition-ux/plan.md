---
feature_id: 026-alert-condition-ux
spec_ref: ./spec.md
status: approved
created_at: '2026-06-12'
updated_at: '2026-06-12'
adr_refs: ['0024', '0030', '0043']
context7_verified: []
---

# Implementation Plan: 026-alert-condition-ux（预警条件配置页交互重构 — 同花顺式自定义键盘 + 多选）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `026-alert-condition-ux` | **设计基线**: [`design/06-12-sheet-family-baseline.html`](./design/06-12-sheet-family-baseline.html)（Claude Design 定稿，4 状态族）

> 手动模式（不用 orchestrator）→ 本 plan 无 `orchestrator_config` / `api_contracts` JSON 块（对齐 011-024）。
> 标准 SDD：spec ✅ → clarify ✅（2026-06-12 4Q + 配色决策）→ mockup ✅（design/ 定稿）→ **plan（本）** → tasks → implement。
> **⚠ 头号事实**：本 feature **纯 mobile UI/交互**，无 server 段、零契约/DB 改动。改造对象 = 021/023 已 ship 的 `apps/mobile/src/alert/value-input-sheet.tsx`（参数 sheet，主体）+ `add-condition-screen.tsx`（条件库屏，仅改 sheet 编排接线）。条件词表（34 类）/ 领域模型 / `thresholdValid` 校验口径 / `(type,param,threshold)` 草稿 shape 全部复用不动。

## Summary _(mandatory)_

把参数输入 sheet 从「系统键盘 + 单选 chip + 选好了」重构为同花顺式交互、配色用 app 既有 brand 蓝：**① 自定义 in-sheet 数字键盘**（替换系统 decimal-pad，集成竖排「确定」键，输入规范化纯函数）→ **② 带参 chip 单选改多选**（角标勾 + 批量生成 + 总条件上限 4 把守 + 编辑回显预勾选）→ **③ sheet 顶嵌行情条 + X 关闭**（复用 `InstrumentQuoteStrip`）→ **④ 到价类输入框参考 placeholder**（用现有行情字段）。提交控件按是否带阈值分流：纯周期变体（ma/window）用「选好了」、带阈值变体（threshold/rsi/daysPct/pctile）用键盘「确定」。

- **改动文件**：`value-input-sheet.tsx`（主体重写）；**新增** `numeric-keypad.tsx`（presentational）+ `keypad.rules.ts`（输入规范化纯函数）+ `keypad.rules.spec.ts`；`add-condition-screen.tsx`（sheet 编排：批量 reconcile 回调 + 传标的）；`use-alert-draft.ts`（加批量 reconcile 纯函数 + action）；`alert-copy.ts`（文案：可多选 / 最多再选 N 项 / 参考 placeholder builder）。
- **零新基础设施**：无新库（键盘 = RN `Pressable`）/ 零契约改动 / 无 api-client regen / 无 server / 无 migration。

## API Contracts _(mandatory)_

**零契约改动**。CRUD 端点路径/方法/DTO/词表全部沿用 021/023/024，本 feature 不触 server、不重 gen `@nvy/api-client`。草稿提交仍走既有 `toConditionEntries` → 既有 POST/PATCH alert。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则 | 状态 | 备注 |
| --- | --- | --- |
| I. SDD（NON-NEGOTIABLE） | ✅ | spec → clarify → mockup → plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | 纯函数 vitest 红绿（键盘规范化 / reconcile / 可选名额 / 参考 placeholder builder）；UI/交互走 `[Mobile-E2E]` Playwright（mono 测试分层：vitest=logic、Playwright=render，**~/ui 与组件渲染不写 vitest**） |
| III. Atomic 30min-2h + 独立 commit | ✅ | 单 mobile PR，task 按 30min-2h 拆、逐个 commit |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | 改动全落 `apps/mobile/src/alert/`；复用 `~/ui`/`~/theme`/`~/portfolio`(quote merge)；键盘**暂留 feature-local**（单 consumer，per ADR-0030「单 consumer 内联」；出现第 2 consumer 再上提 `~/ui`） |
| V. 类型同步链 Nx-driven | ✅ | **N/A**——零契约改动、无 api-client regen |

## Dependencies & Defensive Additions（Cargo-cult 防火墙）

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A（数字键盘 = RN core `Pressable` + 既有 token，无新库；不引入手势库——键盘是点击非拖拽） | N/A |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: N/A — 本 feature 无 server 段、零端点。
- [x] **Mobile**: P1（自定义键盘录入到价阈值）+ P2（多选批量）golden-path 由 `[Mobile-E2E]` hermetic Playwright（Expo Web）覆盖；本地 simulator 走查在 impl PR 留迹。
- [x] **Evidence**: 设计基线 `design/06-12-sheet-family-baseline.html` 已含 4 状态交互；e2e 落 PR。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

N/A — 无新第三方包（键盘自绘）。**Evidence**: 防火墙表 = None。

### Gate 0.3 — Legacy → Mono Delta Sweep

N/A — mono-native feature，无 meta-repo 迁移面。**Evidence**: 改动文件均为 023 已落的 mono TS 模块。

### Gate 0.4 — ADR-deferred-mitigation Scan

无受影响 Open Question。`rg` 确认：键盘组件落点遵 ADR-0030（单 consumer 内联 `apps/mobile/src/`，不预先抽 `packages/`）；mobile 不受 ADR-0043（server 范式）约束。无新 ADR。

## Architecture Notes _(mandatory)_

> 🚨 **前端铁律（mobile-impl-playbook）**：NativeWind 视觉值走 token class、禁字面量；单元素 className ≤4 原子、复用≥2 抽 `~/ui`；交互组件必带 `accessibilityLabel`；测试分层 vitest=logic / Playwright=UI。**0 新 token**（设计基线已锚既有 hex → class）。

### D1：自定义数字键盘 = feature-local presentational `NumericKeypad` + 纯函数规范化

- **组件** `apps/mobile/src/alert/numeric-keypad.tsx`：4×4 网格（1-9 / `.` / 0 / `⌫` 占 3 列；「确定」竖排占右整列），全 `Pressable`（无新库、Playwright 可点击驱动）。props：`value`(显示串) / `onKey(key)` / `onConfirm` / `confirmDisabled` / `confirmLabel`(默认「确定」)。每键 `accessibilityLabel`（数字/「小数点」/「退格」/「确定」）。视觉锚设计基线 `.keypad`/`.key`/`.ok`（token：`surface`/`surface-sunken` 键、`brand-500` 确定、`rounded-md`、`font-mono`）。
- **纯函数** `keypad.rules.ts`：`applyKey(raw: string, key: string): string`——单小数点（已含「.」忽略；空串点「.」→「0.」）；前导零规范（"0" 后输数字替换整数位）；**整数位 ≤7、小数位 ≤2**，超出忽略（FR-003）。退格 = `slice(0,-1)`。**vitest 全分支红绿**（含边界：空退格、"0."、超长、多点）。
- **校验复用**：「确定」`disabled` = `!thresholdValid(type, raw)`（既有 `use-alert-draft` 纯函数，零口径漂移，FR-004）。RSI 出域沿用既有 `rsiError` 红边/红字态（mockup 未画，按 023 现状保留）。

### D2：参数 sheet 重构 = 显示框（非系统输入）+ 键盘 + 多选 chip + 行情头

`value-input-sheet.tsx` 变更（presentational，编排仍在调用屏）：

1. **顶部行情头**：嵌 `InstrumentQuoteStrip`（接收 `market`/`code`）——sheet 由 presentational 变 **connected**（内部用 `~/portfolio` quote merge 取行情，既有口径）。右上角 X = `onClose`（与点遮罩/系统返回同路径，不写草稿，FR-013）。
2. **去系统键盘**：原 `TextInput`(decimal-pad autoFocus) → 只读显示 `Text`（`accessibilityLabel`=条件名 + 值），值由 `NumericKeypad` 驱动。**移除 `KeyboardAvoidingView`**（不再有系统键盘需要避让）。
3. **chip 单选→多选**：内部 `selected: Set<number>`（seed = 草稿内该 type 已存在的 param，FR-009 预勾选）。选中态 = `brand-soft` 底 + `brand-500` 边 + 右下角勾标（小组件，token 蓝）。
4. **提交控件分流**（Clarify）：`kind ∈ {ma, window}`（纯周期无阈值）→ 底部 `Button`「选好了」；`kind ∈ {threshold, rsi, daysPct, pctile}`（带阈值）→ 键盘集成「确定」。`threshold`/`rsi` 是单值无 chip（沿用单 (type,0)）；`daysPct`/`pctile` 是多选 chip + 单阈值（组合，键盘确定提交，多 param 共用同阈值，FR-011）。

### D3：批量 reconcile = 纯函数 `reconcileConditions` + draft action（FR-007/009）

- **纯函数** `use-alert-draft.ts` 加 `reconcileConditions(list, type, selectedParams: number[], threshold): DraftCondition[]`——对该 type：选中的 param 走 `upsertCondition`（带阈值类附 threshold，纯周期类 threshold=''）、未选中的同 type param `removeCondition`；**其余 type 条目原样保留**。组合既有 `upsertCondition`/`removeCondition`，**vitest 红绿**（新增/移除/覆盖阈值/无变化幂等）。
- **draft action** `reconcile(type, params, threshold)` set 包装；`add-condition-screen` 的 sheet `onConfirm` 由「单 upsert」改「调 reconcile」。
- **无参/单实例阈值类**（threshold/rsi，单 (type,0)）仍走既有单 `upsert`（reconcile 退化为单元素亦可，但保留单 upsert 更直观）。

### D4：上限名额把守（FR-008）= 按「非本 type 条数」算可选额

- 打开多选 sheet（type T）时：`otherCount` = 草稿内 `type !== T` 的条数（这些 reconcile 不动）；**最大可选** = `MAX_CONDITIONS(4) − otherCount`；剩余可选 = 最大可选 − `selected.size`。
- `selected.size ≥ 最大可选` 时，未勾 chip `disabled`（40% opacity）；helper 文案「最多再选 **N** 项」（N=剩余可选，N=0 时已勾满）。**纯函数** `multiSelectQuota(conditions, type): {max, ...}` + vitest。
- **为何按 otherCount 而非 `conditions.length`**：本 type 已存在的 param 是「可再次取消」的预勾项，不应永久占额堵死自己——只有别 type 的条目才是固定占用。

### D5：到价类参考 placeholder（FR-014）= 纯函数 builder

- `alert-copy.ts` 加 `referencePlaceholder(type, quote, copy): string`——到价类（`PRICE_RISE_TO`/`PRICE_FALL_TO`）行情就位 → 「最新价 <last>」（可后续细化涨/跌停，本期最新价足够，spec 举例口径）；行情未就位（`undefined`/`'--'`）→ 退「输入数值」通用占位（不显 "--"）。其余阈值类（百分比/倍/分位）→ 「0.00」/既有占位。**vitest 红绿**（就位/未就位/非到价类分支）。
- sheet 内组装：connected sheet 已有 quote → 喂 builder 出 placeholder 串给只读显示框空态。

### D6：测试分层 + 零回归

- **vitest（logic）**：`keypad.rules`（applyKey 全分支）/ `reconcileConditions` / `multiSelectQuota` / `referencePlaceholder`。
- **`[Mobile-E2E]`（Playwright Expo Web）**：① 到价类——开 sheet→键盘点出合法价→「确定」入草稿；非法值「确定」灰。② 多选——勾多周期→「选好了」批量入草稿；满额禁选 + helper；空选禁用。③ 组合类（N日涨幅超）——多选 + 键盘阈值 + 确定。④ X/遮罩关闭不写草稿。⑤ 编辑回显预勾选 + 取消移除。
- **零回归**：021/023/024 既有 server 行为与 e2e 不改；草稿 → request（`toConditionEntries`）口径不变；条件卡片摘要/消息正文（`formatConditionLine` 等）不动。

### Cross-cutting

- **设计 drift 容忍**：mockup 校验是占位 `parseFloat>0`，实现接 `thresholdValid`；长度限制/RSI 红态 mockup 未画，按 spec FR-003/现状补——代码为真相源。
- **a11y**：键盘键、chip、X、确定/选好了 全 `accessibilityLabel` + `accessibilityState`（selected/disabled），供 Playwright 定位 + 无障碍。

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| — | — | — |

**Note**：(1) 唯一新组件 = feature-local `NumericKeypad`（单 consumer，不预先上提 ~/ui——避免过度设计）。(2) 多选/reconcile/名额/键盘规范化全部抽纯函数走 vitest，组件层薄。(3) 零库 / 零契约 / 零 migration / 零 server。

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略

**单 mobile PR**（`feat(alert)`）：纯前端，无 server 段 → 无 PR1/PR2 拆分、无 `[Contract-Smoke]`（契约零变化）。落 vitest（纯函数）+ `[Mobile-E2E]` hermetic（5 条交互流）。021/023/024 零回归声明 + 既有 e2e 复跑。

### 建议 tasks.md 层级（每 task 30min-2h，预估 ~7-9 task）

- `[Mobile]` T01 `keypad.rules.ts` applyKey 规范化纯函数 + vitest（红绿，全边界）
- `[Mobile]` T02 `NumericKeypad` presentational 组件（grid + 竖排确定 + a11y）
- `[Mobile]` T03 `use-alert-draft` `reconcileConditions` + `multiSelectQuota` 纯函数 + vitest
- `[Mobile]` T04 `alert-copy` `referencePlaceholder` builder + 多选文案（可多选/最多再选 N 项）+ vitest
- `[Mobile]` T05 `value-input-sheet` 重写：行情头 + X + 只读显示 + 接 NumericKeypad（阈值/RSI 单值变体先通）
- `[Mobile]` T06 `value-input-sheet` 多选 chip（角标勾 + 预勾选 + 名额禁选）+ 提交分流（选好了/确定）+ 组合变体（daysPct/pctile）
- `[Mobile]` T07 `add-condition-screen` 接线：传标的给 sheet + onConfirm 改 batch reconcile
- `[Mobile-E2E]` T08 Playwright 5 条交互流 + 编辑回显 + 关闭不写草稿
- `[Mobile]` T09 021/023/024 既有 e2e/vitest 复跑零回归 + 本地 simulator 走查留迹

> 依赖：021/023 已 ship ✅；024 词表（5min 涨跌超）已在 `alert-condition-meta` → 多选/键盘对其自动适用（threshold kind，键盘确定）。无外部前置。

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-12 | **ID-namespace**: US1-3 / FR-001..019 + FR-007a / SC-001..006 | **ADR**: 0024（spec 布局）/ 0030（包分解——键盘单 consumer 内联）/ 0043（仅声明 mobile 不受 server 范式约束）
