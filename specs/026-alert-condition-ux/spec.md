---
feature_id: 026-alert-condition-ux
modules: [alert]
owners: ['@zhangleizlpd']
depends_on: ['021-alert-management', '023-alert-eod-indicators']
status: implemented
created_at: '2026-06-12'
updated_at: '2026-06-12'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
agent_friction_observed: false
web_compat: untested
web_compat_notes: '纯 mobile UI/交互重构：仅改 021/023 既有「添加条件」屏 + 参数输入 sheet 的交互层（自定义数字键盘 / 多选 chip / sheet 内行情条 + 参考提示），不动 server / 契约 / DB。条件词表与领域模型零变化。021/023 同源页面 web export 已可用，本 feature 仅替换交互控件，路径未冒烟（draft, untested）。'
state_branches:
  - '数字键盘输入: 单个小数点（已含「.」时再点「.」无效）；前导零规范（"0" 后输数字替换整数位、"0." 保留）；超最大长度时新数字被忽略；空串或非法值（出 thresholdValid 值域）→「确定」禁用、不可提交'
  - '多选带参条件: 总条件数上限 4——剩余槽位 = 4 − 当前草稿已有条件数；勾选数达剩余槽位上限后，未勾的 chip 禁选并提示「最多再选 N 项」；「选好了」批量 upsert 已勾的 (type,param)'
  - '编辑回显: 重开同类带参条件 sheet 时，草稿内已存在的同类 param 预勾选；取消勾选并「选好了」→ 移除该 (type,param)；新勾 → 新增'
  - '到价类参考提示: 行情就位 → placeholder 显示参考值（如「最新价 1291.91」）；行情未就位（"--"）→ 退回通用占位「输入数值」，不显示 "--" 误导值'
  - 'sheet 内 X 关闭 / 点遮罩 / 系统返回 → 不写草稿、回到条件库屏（与现状「选好了」之外的退出口一致）'
---

# Feature Specification: 预警条件配置页交互重构（Alert Condition Picker UX Redesign — 同花顺式自定义键盘 + 多选）

> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> 本 feature **纯 mobile UI/交互**，无 server 段。改造对象 = 021/023 已 ship 的「添加条件」屏（`add-condition-screen.tsx`）+ 参数输入 sheet（`value-input-sheet.tsx`）。流程：`spec → /speckit-clarify → mockup（design/，以同花顺「添加预警」截图为底）→ plan → tasks → impl`。impl 单 PR（mobile-only，落 `[Mobile-E2E]` hermetic UI e2e；无 server IT、无 `[Contract-Smoke]`——契约零变化）。
>
> ⚠️ **[范围红线]** 复用现有 34 类条件词表 / 领域模型 / server / OpenAPI 契约。**不**增删条件类型、**不**改 server 校验/求值、**不**动 DB、**不**引入同花顺特有条件（单笔涨幅超 / 总市值突破等）或新分类（最近添加 / 异动盯盘 / 技术形态 / 交易策略）。RSI 仍为数值阈值（不改成同花顺金叉/死叉多选预设）。021/023/024 既有 e2e 与 server 零回归。

## Clarifications

### Session 2026-06-12

- Q: 同时带「多选周期 + 数值阈值」的条件（N 日涨跌幅超 / 估值分位），用哪个提交按钮？ → A: 按是否带阈值分流——带阈值变体（daysPct / pctile）用键盘集成的「确定」提交（多选 chip + 单阈值，点确定一次生成全部）；纯周期变体（ma / window，无阈值）用底部「选好了」提交。
- Q: 多选 sheet 一个 chip 都没勾时，提交按钮怎么处理？ → A: 禁用提交键（「选好了」/「确定」置灰不可点，防空提交）；退出走 X / 遮罩 / 系统返回。
- Q: 自定义数字键盘的输入长度上限？ → A: 整数位 ≤ 7 + 小数位 ≤ 2；超出部分的新输入被忽略。
- Q: 新控件（选中 chip / 键盘「确定」）配色跟同花顺红，还是 app 既有 brand 蓝？ → A: 用 app 既有 brand 蓝（`brand-500` / `brand-soft`），只搬交互不搬红色；红仅保留给行情涨跌色。0 新 token。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 自定义数字键盘设置数值阈值 (Priority: P1)

用户在为某只股票添加「股价涨到 / 跌到 / 日涨幅超 / PE 高于」等需要填数值的预警条件时，点「添加」弹出参数 sheet，**直接在 sheet 内用一个自带的数字键盘**录入阈值——不再弹出系统键盘。键盘含 1-9、0、小数点、退格，以及一个集成在键盘右侧整列的大「确定」键。录入值非法（空 / 超值域）时「确定」不可点。

**Why this priority**: 这是同花顺截图里最主导的交互，也是用户明确表示「这种交互我感觉比较好」的核心。数值阈值类是预警里最高频的条件，键盘体验直接决定整页观感。可独立交付：仅替换数值输入控件即有完整价值。

**Independent Test**: 进入「股价涨到」sheet，用屏内键盘点出一个合法价格 → 「确定」可点并提交回草稿；点出非法值（如空 / 0 元 / 出值域百分比）→「确定」灰且不可提交。全程不弹系统键盘。

**Acceptance Scenarios**:

1. **Given** 在「股价涨到」sheet（阈值类），**When** 依次点屏内键盘「1」「2」「9」「.」「5」，**Then** 输入框显示「129.5」，「确定」可点。
2. **Given** 输入框已是「129.5」，**When** 再点一次「.」，**Then** 输入不变（单小数点约束），输入框仍「129.5」。
3. **Given** 输入框为空，**When** 未输入任何数字，**Then** 「确定」处于禁用态，无法提交。
4. **Given** 在「日涨幅超」sheet（百分比类，值域 (0,100]），**When** 输入「150」，**Then** 「确定」禁用（出值域）。
5. **Given** 已输入合法值并点「确定」，**Then** 该条件以 (type, 阈值) 写入草稿并返回条件库屏。

---

### User Story 2 - 多选带参条件批量生成 (Priority: P2)

用户为「股价上穿/跌破均线、创 N 日新高/新低、N 日涨跌幅超、PE/PB 分位」这类带周期参数的条件添加预警时，参数 sheet 以**多选 chip**呈现可选周期/年限——可一次勾多个（如同时勾 MA5、MA20），底部「选好了」一次性批量生成多个条件，省去逐个添加。受总条件上限 4 约束。

**Why this priority**: 同花顺「创新高」的可多选交互是用户点名喜欢的第二个交互点。把单选改多选显著降低多周期预警的操作步数。依赖 US1 之后做更顺（同属参数 sheet），故 P2。

**Independent Test**: 进入「创 N 日新高」sheet，勾选「60 日」「120 日」两个 chip → 「选好了」→ 草稿新增两条 (NEW_HIGH,60)、(NEW_HIGH,120)；当草稿已有 3 条时再进，仅剩 1 个槽位，勾满 1 个后其余 chip 禁选并提示。

**Acceptance Scenarios**:

1. **Given** 草稿空、进入「创 N 日新高」sheet，**When** 勾选「60 日」与「120 日」并点「选好了」，**Then** 草稿出现两条条件（创 60 日新高、创 120 日新高）。
2. **Given** 选中的 chip，**Then** 显示选中态——同花顺式右下角勾标 + 浅底高亮，配色用 app 既有 brand 蓝（`brand-soft` 底 + `brand-500` 勾，**不引入红**）。
3. **Given** 草稿已有 3 条条件、进入带参 sheet（剩 1 槽位），**When** 已勾 1 个 chip，**Then** 其余未勾 chip 变为禁选并提示「最多再选 1 项」。
4. **Given** 草稿已含「创 60 日新高」，重开该 sheet，**Then** 「60 日」chip 预勾选；取消勾选并「选好了」→ 草稿移除「创 60 日新高」。
5. **Given** 「PE 分位高于」这类带参 + 带阈值的条件，**When** 勾选年限多选后仍需录入分位阈值，**Then** 阈值用 US1 的数字键盘录入，多个年限共用同一阈值批量生成。

---

### User Story 3 - sheet 内行情条与参考提示 (Priority: P3)

参数 sheet 打开时，顶部展示该标的的即时行情（最新价/涨跌额/涨跌幅/涨停/跌停）并提供右上角 X 关闭；到价类输入框的占位提示用现有行情数据给出参考（如「最新价 1291.91」），让用户填阈值时有锚点。

**Why this priority**: 体验增益项，让用户设值时不必返回上一屏看行情。不阻塞 US1/US2 的核心交互，故 P3。不引入任何新数据来源（只用已有 5 字段行情）。

**Independent Test**: 打开「股价涨到」sheet → 顶部行情条显示该股 5 字段、右上角 X 可关闭 sheet 不写草稿；输入框未输入时 placeholder 显示「最新价 <现价>」；行情未就位时 placeholder 退回「输入数值」。

**Acceptance Scenarios**:

1. **Given** 行情已就位，打开阈值 sheet，**Then** 顶部行情条显示最新价/涨跌额/涨跌幅/涨停/跌停（与条件库屏顶口径一致）。
2. **Given** sheet 打开，**When** 点右上角 X（或点遮罩 / 系统返回），**Then** sheet 关闭、不写草稿、回到条件库屏。
3. **Given** 到价类（股价涨到/跌到）输入框为空且行情就位，**Then** placeholder 显示参考值（如「最新价 1291.91」）。
4. **Given** 行情未就位（显示 "--"），**Then** 到价类 placeholder 退回通用「输入数值」，不显示误导性 "--"。
5. **Given** 百分比/倍数类条件，**Then** placeholder 沿用「0.00」占位（不强加行情参考）。

---

### Edge Cases

- 数字键盘连续点「0」：保持单个前导零，输入合法数值时整数位 "0" 被替换（"0"→点"5"→"5"；"0."→点"5"→"0.5"）。
- 退格清空到空串：「确定」立即变禁用。
- 多选 sheet 一个都不勾：提交键禁用（FR-007a），不可空提交；退出走 X / 遮罩 / 系统返回。
- 多选时已勾数 = 剩余槽位、用户取消某勾再勾另一个：禁选态随实时剩余槽位刷新。
- 带参 + 带阈值条件（PE/PB 分位）阈值出值域：「选好了」禁用（与 US1 校验同口径）。
- 无参条件（MACD/KDJ/BOLL 金叉死叉等）：行为不变，点「添加」直接入草稿、不弹 sheet。
- 单实例阈值类（如股价涨到，按 (type,0) 判重）重开覆盖：sheet 回显现值，重新「确定」覆盖。

## Requirements _(mandatory)_

### Functional Requirements

#### 数字键盘（US1）

- **FR-001**: 参数 sheet 中所有数值阈值的录入 MUST 通过 sheet 内自带的数字键盘完成，MUST NOT 触发系统软键盘。
- **FR-002**: 数字键盘 MUST 提供 0-9、小数点、退格键，及一个集成的「确定」提交键。
- **FR-003**: 键盘录入 MUST 约束为合法十进制数串：至多一个小数点；规范前导零；**整数位 ≤ 7 且小数位 ≤ 2**，超出后的新输入被忽略。
- **FR-004**: 「确定」键 MUST 在当前值非法（空 / 出对应 thresholdFamily 值域）时禁用，合法时可点；校验口径 MUST 与现有 `thresholdValid` 完全一致（客户端零口径漂移）。
- **FR-005**: 点「确定」MUST 以 (type, param, threshold) 写入草稿（沿用 021/023 upsert 键语义）并返回条件库屏。

#### 多选带参条件（US2）

- **FR-006**: 带参条件（均线周期 / 新高新低窗口 / N 日涨跌幅 / 估值分位）的周期/年限选择 MUST 从单选改为多选。
- **FR-007**: 多选 sheet MUST 提供批量提交，把所有已勾 (type, param) 一次性写入草稿。**提交控件按是否带阈值分流**：纯周期变体（ma / window，无阈值）用底部「选好了」；带阈值变体（daysPct / pctile）用键盘集成的「确定」（多选 chip + 单阈值，一次生成全部）。
- **FR-007a**: 一个 chip 都未勾选时，提交键（「选好了」/「确定」）MUST 禁用（防空提交）；退出 sheet 仅经 X / 遮罩 / 系统返回。
- **FR-008**: 多选 MUST 受总条件上限 4 约束——可勾数 = 4 − 草稿当前条件数；达上限后未勾 chip MUST 禁选并给出剩余可选数提示。
- **FR-009**: 重开带参条件 sheet 时，草稿内已存在的同类 param MUST 预勾选；提交时按勾选差异增/删对应 (type, param)。
- **FR-010**: 选中态 MUST 呈现同花顺式视觉（右下角勾标 + 浅底高亮）；**配色用 app 既有 brand 蓝**（`brand-soft` 底 + `brand-500` 勾标 + `brand-500` 边），键盘「确定」键同用 `brand-500`。MUST NOT 引入红色（红仅保留给行情涨跌色）——0 新 token、design-token 直搬。
- **FR-011**: 带参 + 带阈值条件（估值分位）MUST 支持「多选年限 + 单一阈值」组合：阈值经数字键盘录入，多个年限共用该阈值批量生成。

#### sheet 行情条与参考提示（US3）

- **FR-012**: 参数 sheet 顶部 MUST 展示该标的行情条（最新价/涨跌额/涨跌幅/涨停/跌停），口径与条件库屏顶一致（复用同源行情来源，不新增数据）。
- **FR-013**: sheet MUST 提供右上角 X 关闭；X / 遮罩点击 / 系统返回 MUST 关闭 sheet 且不写草稿。
- **FR-014**: 到价类输入框 placeholder MUST 在行情就位时显示现有行情参考值；行情未就位时退回通用占位，MUST NOT 显示 "--" 等误导值。
- **FR-015**: 百分比/倍数类 placeholder 沿用既有占位（不强加行情参考）。

#### 不变项 / 零回归（约束）

- **FR-016**: 条件词表（34 类）、领域模型、server 校验/求值、OpenAPI 契约、DB MUST 零变化。
- **FR-017**: 左侧分类 rail MUST 仍为 4 类（价格跟踪/估值/成交量/技术指标），MUST NOT 引入同花顺新分类。
- **FR-018**: 搜条件框、无参条件直接入草稿（不弹 sheet）、RSI 数值阈值语义 MUST 保持不变。
- **FR-019**: 021/023/024 既有 server 行为与 e2e MUST 零回归。

### Key Entities _(include if feature involves data)_

- **条件草稿项（Condition Draft Item）**：(type, param, threshold) 三元组，沿用 021/023 既有结构；本 feature 不改其形状，仅改写入它的交互方式（键盘 / 多选批量）。
- **条件元数据（Condition Meta）**：现有 `alert-condition-meta`（kind / paramWhitelist / thresholdFamily / unit 等），驱动 sheet 渲染哪种变体；本 feature 复用、不扩字段（除非 clarify 决定加纯前端展示元数据）。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 设置一个数值阈值类预警的点击步数 ≤ 设置数值所需的按键数 + 1（「确定」），全程 0 次系统键盘弹出。
- **SC-002**: 添加 N 个同类带参条件（如创 60/120 日新高）从原先 N 次「进 sheet→选→确认」降为 1 次（一次多选 + 一次「选好了」）。
- **SC-003**: 非法阈值无法提交——出值域 / 空值时「确定」100% 处于禁用态（无脏数据进入草稿）。
- **SC-004**: 总条件上限 4 在多选下 100% 不被突破（超额 chip 禁选）。
- **SC-005**: 021/023/024 既有自动化测试与 server 行为 100% 通过（零回归）。
- **SC-006**: 用户在 sheet 内即可看到该标的行情，设值时无需返回上一屏查行情。

## Assumptions

- 复用现有 34 类条件词表与 (type, param, threshold) 领域模型，本 feature 为纯交互层替换，无 server / 契约 / DB 改动。
- 行情数据沿用现有客户端 5 字段来源（015 quote merge），无「N 日最高/最低价」等新数据；参考提示只用已有字段。
- 总条件上限 4 沿用 021 server 同口径；多选只是更高效地命中同一上限，不放宽。
- 自定义键盘为纯按钮组件，满足 mono 测试分层：逻辑（输入规范化 / 校验）走 vitest，交互/渲染走 Playwright（按钮可点击驱动）。
- RSI 维持数值阈值变体，不采用同花顺的预设状态多选——领域模型已将其拆为 RSI_OVERBOUGHT/OVERSOLD。
- mockup 以用户提供的同花顺「添加预警」截图为视觉基线；代码为真相源，mockup drift 不算 bug。
