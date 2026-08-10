# Specification Quality Checklist: 选约表横滑范式换代 + 行权价区间筛选 + 意图 Tab 重设计

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-10
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

### 三条判定的说明（自审留痕，别下次又当缺口补）

1. **「No implementation details」判 pass 但有边界**：spec 引用了 ADR-0063 的**决策结论**（自激环成因、单一位移来源、四条必须接受的代价），这是**约束来源**不是实现方案 —— 缺了它，`FR-001` 的「MUST NOT 存在写回路径」就成了没有理由的禁令。具体怎么落（组件划分、手势参数、测量方式）全部留给 plan，spec 内零组件名、零 API、零代码结构。同一取舍在 047 spec 有先例。
2. **`FR-018` 是本片唯一的跨 feature 改判**，已在正文写明豁免的成立条件（四条配套缺一不可）。它不是「放宽全量呈现原则」，而是把「系统静默丢弃」与「用户显式收窄」拆成两件事。
3. **US1 的验收不可能靠自动化闭合**：`SC-001` / `SC-002` 明确要求真机 + 数值探针。这是 ADR-0063 写进「验证方式的教训」的结论（合成手势测不出、静态截图会骗人），不是验证手段偷懒。plan 阶段必须把这条落成显式的真机验收清单。

### clarify 阶段的处置结果（2026-08-10，四问四答）

| 开放项                | 结论                                       | 落到                               |
| --------------------- | ------------------------------------------ | ---------------------------------- |
| 指示条呈现时机        | 有可滑动余量就常显，不做停手淡出           | `FR-005` + `state_branches`        |
| 软键盘处置 + 收起方式 | 不做整屏避让；获焦期间筛选行右端给「完成」 | 新增 `FR-023` + `SC-011` + US2-AS9 |
| 输入精度              | 两位小数（**非**我建议的三位）             | `FR-012` + Assumptions             |
| 清除入口落点          | 筛选行右端，与「完成」共用槽位、互斥出现   | `FR-015`                           |

仍然 defer（不是缺口）：三 Tab 形态的最终选定 —— `FR-019` 明确交给 mockup 阶段出 2–3 稿后选。
