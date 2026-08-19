# Specification Quality Checklist: 雷达按市场分页签

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-19
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

### 验证过程记录（非模板内容，本片特有）

**第 1 轮自检发现并已修正的 3 处**：

1. **FR-003 原写成「统计口径与列表口径同为当前市场」** —— 只说了 WHAT 却没说清**为什么这条值得单列一条 FR**。已补上后果（横幅与列表互相矛盾且无人察觉），使它对 tasks 阶段有牵引力。
2. **FR-011（红标持续覆盖全部市场）差点被写成机制描述** —— 初稿提到了「状态机推进」这类内部构造。已改写为用户可观测的表述（红标与价格事实一致），机制归 plan。
3. **SC 层曾只有 5 条且全部偏呈现** —— 补了 SC-003（并集/交集）与 SC-005（30 天单市场浏览后另一市场红标零偏差）。前者是本片最核心的正确性判据，后者是 FR-011 唯一可验证的形式；缺了它们，FR-011 与 FR-015 在 tasks 阶段会没有落点（045 实证过 SC 层是系统性盲区：FR 覆盖 37/37 而 SC 仅 6/11）。

### 有意为之、勿在 analyze 阶段当缺口补

- **SC-005（30 天）无法在 CI 内实时验证** —— 它的落点是 plan 层的一条否定断言测试（作用域 MUST NOT 泄漏进红标判定路径），而非一条长跑用例。analyze 时若扫到它「无对应 task」，那是**预期的**，不要补一个 30 天的测试任务。
- **SC-007（切换后首屏同量级）不设具体毫秒数** —— 本片不引入新的数据规模或查询形状，性能预算沿用既有假设，不单列 `perf_budgets`。

### `/speckit-clarify` 已完成（2026-08-19，4 问）

`status` 已翻 `clarified`。四条均已回写 `## Clarifications` 并落到对应 FR：

| #   | 议题                 | 结论                         | 落点                  |
| --- | -------------------- | ---------------------------- | --------------------- |
| 1   | 失联锚的可发现性档位 | 仅服务端告警级日志，不上 UI  | FR-015 收紧           |
| 2   | 跨页签提示强度       | 小圆点，**不带数量**         | FR-016 收紧           |
| 3   | 市场能力说明的位置   | 页签下常驻一行，与有无锚无关 | FR-012 收紧           |
| 4   | 页签标签用词         | 「美股」/「港股」            | FR-001 + 全文术语统一 |

**clarify 期间顺带修正的一处 spec 措辞**：US3 原写「在雷达上**彻底**不可达」，读起来像「从系统里丢了」。实际锚管理页不分市场、仍完整列出它 —— 已改写为「在雷达上不可达，但并未从系统中消失」，并与 FR-015 的表述对齐。这个事实也正是第 1 问选「仅日志」而非「上 UI」的依据。

### 决策依据留痕（非模板内容）

- **第 2 问为何拒绝带数量**：计数本就要算，带上几乎零成本 —— 但市场页签上的数字会被读成「该市场有 N 只锚」而非「N 只可动」。信息量的增加抵不过语义被读反的风险。
- **第 3 问为何排除「只在空态里显示」**：港股页签上线即空，那档看起来够用；可一旦有了锚，说明就消失，而恰恰是有行之后用户才会去读每行的行情时点、才真会把「交易日粒度」误读成「今天还没开盘」。**说明消失的时机正好是它最该在场的时机。**
