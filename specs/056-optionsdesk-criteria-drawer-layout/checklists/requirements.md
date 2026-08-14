# Specification Quality Checklist: 检索条件抽屉版式重构

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-14
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [ ] No [NEEDS CLARIFICATION] markers remain — **故意保留 2 处**，见 § Notes
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

### 故意保留的 2 处 `[NEEDS CLARIFICATION]`

owner 在 specify 输入里**明示**这几问留给 `/speckit-clarify`，不在 specify 期替他定。它们落在：

| 位置     | 问题                                                        | 影响面                                           |
| -------- | ----------------------------------------------------------- | ------------------------------------------------ |
| `FR-013` | 「右边界齐」vs「单位贴数字」的取向 + 全腿视角权利金独行排法 | UX（版面取向），不动 scope                       |
| `FR-032` | 「两者都要」（AND）要不要真做                               | **scope** —— 决定本片是纯版式还是版式 + 契约语义 |

第三问（新增文案「活性」与「期限 ≥/≤」拆分怎么叫）未落成 inline marker —— 它不阻断任何 FR 的可测性，已在 § Clarifications 的待澄清清单里逐条列出。

⇒ 本检查项在 `/speckit-clarify` 跑完后应转绿。**MUST NOT 在 clarify 之前进 `/speckit-plan`。**

### 起草期的 3 条实证订正（相对 owner 的输入 brief）

1. **行形态是三种不是两种，且结构上是「五行的任意子集」** —— brief 写「建仓 4 行 6 框 / 收租 5 行 8 框」，漏了全腿 4 行 7 框；且 `criteriaRowsFor` 的第二分支「有值必可见」让任意行都可能出现。已提为 `FR-012` + `SC-011`。
2. **A′ ③ 在全腿视角无定义** —— 全腿没有价差行 ⇒ 权利金没有配对者，「并成一行等分两半」不成立。已挂到 `FR-013` 的 clarify 标记上。
3. **`~/ui` 的键盘有两个 consumer** —— 往右列加「复位」会波及 `alert` 参数输入屏，且 typecheck 不会红。已提为 `FR-023` + `SC-006`。

### 覆盖自查（逐条 grep，非通读）

- FR: 001–005 / 010–015 / 020–024 / 030–033 / 040–045 / 050 —— 各段内编号连续，无跳号
- SC: 001–012 —— 连续
- `state_branches`: 13 条，覆盖三视角行形态 + 防御性子集 + 空契约 + 选中/未选中/空值三态 + 系统键盘不弹 + 两键语义 + 一维计数 + `alert` 零回归
- Edge Cases: 7 条，均带 `(covers FR-xxx)` 回指
