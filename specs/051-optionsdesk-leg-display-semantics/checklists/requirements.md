# Specification Quality Checklist: 选约表显示口径跟进

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-11
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

## 覆盖交叉核对（逐条 grep，非通读）

> per `sdd-authoring.md` 反模式：自审靠通读是系统性盲区，SC 层尤甚。以下为实时扫描结果。

| 层                  | 条数                                             | → FR / US 覆盖                                     | 零覆盖登记 |
| ------------------- | ------------------------------------------------ | -------------------------------------------------- | ---------- |
| `state_branches`    | 18                                               | 全部落 FR-001–FR-022                               | 无         |
| Acceptance Scenario | 20（US1 ×4 · US2 ×5 · US3 ×5 · US4 ×4 · US5 ×2） | 全部落 FR                                          | 无         |
| Edge Case           | 6                                                | 5 条落 FR；1 条（月度日非交易日前移）**故意零 FR** | ✅ 见下    |
| FR                  | 23                                               | 全部落 SC 或 US                                    | 无         |
| SC                  | 10                                               | 全部可机械或 UI 断言                               | 无         |

**故意零覆盖登记**（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）：

- **Edge Case「月度到期日恰好是非交易日被前移」** —— 该情形对客户端**不构成分支**：客户端只消费服务端下发的标，前移与否已在服务端解析完毕。写进 Edge Case 是为了**记录它不该有客户端分支**，正是禁止客户端按「是不是周五」推断的理由（FR-014）。⇒ 不派生 FR、不派生测试。

## 三条本片特有的验收纪律（写进 checklist 免得 plan 阶段漏掉）

1. **SC-002 / FR-002 的「零命中」判据必须先证明它会红** —— 故意在呈现层加一次排序，扫描器必须报出该行；改回后归零。否则「零命中」可能只是扫描面写错了。
2. **SC-008 的文案复核 MUST 人工逐条过** —— 文案断言是自指的（`expect(text).toBe(COPY.x)`），改成什么都绿，测试对这一层**结构性无效**。
3. **SC-009 的占屏判据 MUST 真机测** —— 049 实测网页端 185 vs 真机 161dp，差 13%；用网页端那组数会误判余量，而余量是后续片的。

## Notes

- 全部检查项通过，无 [NEEDS CLARIFICATION] 遗留。
- 本片范畴来自主 plan §2.3（已按 `049` / `050` 实际交付重划），非凭 P2 行原表述——原表述只写了四项，实际七块。
- 下一步建议：`/speckit-clarify`。虽无 [NEEDS CLARIFICATION] 标记，但**计数与就地说明的落位**（不进 sticky 区的前提下放哪）是一个有多种合理解法、且会影响后续片的决策点，值得走一轮 clarify 定下来再 plan。
